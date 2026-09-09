# 设计 3/3：启动补发（catch-up）与幂等语义

> 上游设计：`2026-09-08-wechat-task-reminder.md`（§5.4）
> 本文档补齐原设计未定义的**回溯窗口**与**与前端轮询的互斥规则**
> 定稿日期：2026-09-09

---

## 1. 幂等键与状态流转

**幂等键 = `task_reminders.id`**（一条提醒 = 一行）。

```
未触发（fired_at IS NULL）
  │  扫描器判定"该发"（含入队）
  ▼
已处理（fired_at NOT NULL）
```

**写 `fired_at` 的时机**：**已交付**或**已入队**之后立刻写。理由：

- 写早了（发送前写）：发送失败会丢提醒；
- 写晚了（只成功才写）：`delivery-failed` 时该提醒每 30 秒被重新扫描 → 反复尝试发送 → 加剧风控；
- 因此引入队列后，**入队即视为"已处理"**，投递责任转移给队列。

**失败不丢**：入队行保留 `last_error`，队列释放时重试；队列行是唯一的"未交付"真相。

---

## 2. 与前端 5 秒轮询的互斥

现状（改造前）：

```
前端每 5s → GET /api/workbench/reminders/due → 横幅 + 桌面通知
fireReminder 只在用户点「知道了」时写 fired_at
```

**问题**：`listDueReminders` 只判 `now >= due - offset`，**没有下界**；一条逾期未 dismiss 的提醒会每 5 秒重复弹一次。

**定稿规则**：

| 场景 | 前端 | host 调度器 |
|---|---|---|
| `policy.enabled = false` | 照旧（唯一通道） | 完全不动作 |
| `policy.enabled = true`，提醒未处理 | **不弹**（由 host 负责） | 即时推 / 入队，随后写 `fired_at` |
| 提醒已处理（`fired_at` 非空） | 不弹 | 不再处理 |

**实现方式**：`/api/workbench/reminders/due` 增加一个显式查询参数语义——当策略开启时，host 已处理的提醒不再返回给前端（`fired_at IS NULL` 过滤在 SQL 里已有，天然满足）；策略关闭时保持今天的行为。

> 注意：`listDueReminders` 现有 SQL 已带 `r.fired_at IS NULL`，所以只要 host 负责写 `fired_at`，互斥自动成立。**不需要额外标记位。**

---

## 3. 启动补发（catch-up）

### 3.1 触发时机

插件 `apply()` 完成后立即执行一次（不等待第一个 30s tick），且**只执行一次**（进程内 `catchupDone` 标志）。

### 3.2 扫描条件（定稿）

```
fired_at IS NULL
AND enabled = 1
AND 任务未归档、状态非 done/cancelled
AND (due_at - offset) <= now                      -- 已到期
AND (due_at - offset) >= now - catchupWindowHours -- 回溯窗口（默认 24h）
```

**回溯窗口是本设计新增的硬约束**（原设计只写"必须有上限"）：

| 值 | 行为 |
|---|---|
| 24h 内到期 | 补发 |
| 超过 24h | **不补发**，只写一条 `task_events`（`reminder_skipped`）说明原因 |

理由：DSH 关机一周后重启，一次性推 20 条历史提醒既刷屏又必然撞限流；逾期提醒的时效性已消失，记事件比推送更有用。

### 3.3 补发形态（合并，不逐条）

- 窗口内条数 ≤ `catchupMaxItems`（默认 10）：合并成**一条**消息，标题「工作台 · 错过的工作台提醒」；
- 超过上限：取最接近现在的 N 条 + 一行「…等 M 条」；
- 补发消息同样过静默判定：静默期内且非 P0 → 转为汇总队列，不立即发。

### 3.4 幂等

补发与实时扫描**共用同一套幂等键**（`reminderId`）：补发入队/发送后同样写 `fired_at`，因此不会与随后的实时扫描重复。

---

## 4. 结果回写与失败可见

| 结果 | 回写 |
|---|---|
| 交付成功 | `fired_at = now`；`task_events` 记 `reminder_fired`（含 channel、botId 脱敏） |
| 入队（预算/熔断/静默） | `fired_at = now`；队列行保留；`task_events` 记 `reminder_queued` |
| 未安装/未配置 | **不写 `fired_at`**（前端继续负责）；`task_events` 记一次 `reminder_channel_unavailable`（同一 reminder 只记一次，防刷） |
| 超过回溯窗口 | `task_events` 记 `reminder_skipped` |

**页面可见**：`GET /api/workbench/reminders/status` 返回通道状态（安装/配置/熔断/队列长度）+ 最近失败原因，前端在任务列表顶部显示一行横幅。

**日志脱敏**：事件与日志只写 `botId` 前 8 位 + `referenceId`，**不写消息正文、不写 targetId**。

---

## 5. 数据库变更

```sql
-- 队列（见设计 1 §6）
CREATE TABLE IF NOT EXISTS reminder_queue (...);

-- 无需给 task_reminders 加列：fired_at 复用，队列是唯一新增状态
```

迁移走现有 `schema.ts` 的 `CREATE TABLE IF NOT EXISTS` 机制，幂等可重跑。

---

## 6. 验收标准

1. 进程重启后，24h 内到期未处理的提醒**合并成一条**补发；
2. 超过 24h 的不补发，但能在任务事件里看到 `reminder_skipped`；
3. 同一条 reminder 在"补发 + 实时扫描"两条路径下**只推一次**；
4. 前端在策略开启时不再重复弹已处理的提醒（不会出现"微信收到 + 页面又弹"）；
5. 卸载 dsh-im 后：不写 `fired_at`，前端横幅行为与今天一致。
