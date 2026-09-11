# 验收「暂存」+ 驳回反馈闭环 + 草稿通知接入微信（v1.12.0）

- 日期：2026-09-09
- 来源：用户反馈「每次验收前都需要自己跑回归测试，验收弹窗还关不掉」+「驳回后 AI 完全不知道被驳回」
- 状态：已实现并本机实测通过

## 0. 问题

三件事其实是同一个断点链条：

1. **验收弹窗关不掉**：客户端每 5 秒轮询 `GET /api/workbench/drafts` → 后端返回最新 pending 草稿 → 弹窗自动开。点 X 只清本地 state，下一轮轮询又拉回来。用户想"先验证再决定"时没有任何出路（Modal 是阻塞式：portal + 遮罩 + 锁滚动 + 焦点陷阱）。
2. **驳回无痕**：`POST /drafts/:id/abandon` 只把 `status_code` 改成 `abandoned`——不写 `task_events`、不写任务共享记忆、无原因字段。执行会话（AI）完全不知道被驳回，再次提交还是同一份内容，甚至会对用户说"草稿还在等你确认"。
3. **移动端触达缺失**：工作台弹框只在页面里可见；任务到期提醒已经能推微信（v1.10/v1.11），但"AI 提交了验收申请"这类**需要用户动作**的通知推不出去。

## 1. 数据模型（migration v13 / v14）

```sql
-- v13：暂存标记 + 通知去重
ALTER TABLE task_drafts ADD COLUMN deferred_at TEXT;              -- 非空 = 已暂存
ALTER TABLE task_drafts ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_drafts ADD COLUMN notified_at TEXT;              -- 非空 = 已进过通知队列

-- v14：草稿通知待发队列（静默/汇总/节流导致的延后投递）
CREATE TABLE draft_notify_queue (
  id, draft_id UNIQUE, kind_code, title, body, priority_code,
  attempts, next_attempt_at, last_error, created_at
) STRICT;
```

**关键决策：暂存不新增状态码。** 草稿仍是 `pending`，确认/驳回两条老路径一字不改；只加一个标记，让"自动弹窗"那条查询跳过它：

```ts
getLatestPendingDraft(db)  // 不变（保留给需要"所有 pending"的调用方）
getLatestActiveDraft(db)   // 新增：... AND deferred_at IS NULL ← 弹窗数据源
listDeferredDrafts(db)     // 新增：已暂存清单 ← 「待处理」弹窗
```

如果改成 `draft_status='deferred'`，8 种草稿的确认/查询分支、`getPendingDraftForTask`、日报/知识/点子的各自 pending 查询都要跟着改，回归面大得多。

## 2. 接口

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/workbench/drafts` | 返回 `{ draft, deferredDrafts }`：`draft` 只含未暂存的，暂存清单单独返回 |
| POST | `/api/workbench/drafts/:id/defer` | 仅 `completion`/`review` 且 `pending` 可暂存；写 `deferred_at`、`defer_count+1`、任务事件、共享记忆 |
| POST | `/api/workbench/drafts/:id/resume` | 清 `deferred_at`，草稿重新进入弹窗队列 |
| POST | `/api/workbench/drafts/:id/abandon` | 校验状态；`completion` 草稿的驳回写事件 + 共享记忆（可带 `reason`） |

`recordDraftFeedback()` 统一写两处痕迹：

```
task_events:  event_code=completion_rejected | completion_deferred, actor=user,
              note="draft:<id> | <用户填的原因>"
task_memories: 【验收驳回】用户于 <时间> 驳回了 AI 提交的完成验收申请（草稿 <id>）。用户反馈：<原因>
```

## 3. AI 反馈闭环

`workbench_request_completion` 增加可选 `feedback` 参数，返回文案携带历史：

```
完成验收申请已提交（草稿 id=...），等待用户在个人工作台验收。
注意：该任务已有一份**暂存中**的验收申请（暂存于 <时间>），用户正在验证；本次提交已更新该草稿内容，请勿重复催促。
本次是第 3 次验收提交（此前被驳回 1 次、暂存 1 次）。最近一次：draft:<id> | 回归测试未通过
请勿声称任务已经完成；若用户驳回并给出反馈，请按反馈修改后再提交。
```

`feedback` 也会写进草稿 payload，验收弹窗里显示"上次反馈处理：…"，用户一眼看到 AI 针对反馈做了什么。

## 4. 草稿通知 → 微信

复用 v1.10/v1.11 已落地的整条管道（`WechatChannelAdapter` + 队列 + host 调度器 + `decideReminder` 策略），只新增"通知源"：

- **触发**：调度器每 30s 扫描 `status_code='pending' AND deferred_at IS NULL AND notified_at IS NULL AND kind_code IN (已开启类型)`。
- **优先级**：`completion`/`review` → `p1`（即时）；其余 → `p2`（进每日汇总）。
- **不穿透静默**：草稿通知最高 p1，静默时段入队、次日汇总发，不做 P0 穿透。
- **只推一次**：`notified_at` 是幂等键；AI 更新同一草稿不重复推送。
- **节流共用预算**：小时/日上限把到期提醒与草稿通知合并计数（`countFiredRemindersSince + countDraftNotifiesSince`），避免两类各自刷满限额。
- **降级**：未装/未配置 dsh-im 时**不标记 `notified_at`**，通道恢复后自然补推；前端行为完全不变。
- **类型开关**：`policy.draftNotifyKinds`，默认 `['completion','review']`；设置页「微信提醒」区块新增勾选组。

## 5. 前端

- `DraftBanner`：验收类草稿底栏变为「验收通过 / ⏸ 暂存（先验证） / 驳回 / 回到执行会话」。
- 「待处理」弹窗：待确认段 + **已暂存段**（显示暂存时间、第几次、`继续验收` 按钮）。
- 头部徽标计数 = 待确认 + 已暂存 + 到期提醒（暂存项不会失联）。
- 暂存后弹窗立即消失且**不再自动弹**——这正是用户抱怨的"关不掉的弹窗"的根治。

## 6. 验证

| 项 | 结果 |
|---|---|
| `pnpm check` | 通过 |
| `pnpm test` | 83/83 通过（新增 `test/draftNotify.test.mjs` 16 项 + 路由 2 项 + 工具反馈断言） |
| 暂存语义 | 单测：仍 pending、计数累加、仅验收类可暂存、弹窗查询跳过、唤回恢复 |
| 通知语义 | 单测：优先级映射、类型开关、只推一次、通道未就绪不标记、静默入队、小时上限转队列、合并摘要、失败退避 |
| 路由行为 | 单测：defer/resume/abandon 全链路 + 事件与记忆留痕 + 非验收类 400 |

## 7. 已知取舍 / 后续

- **通知正文刻意精简**（v1.12.1 调整）：`任务标题 + 摘要首行（≤60 字）+ 一句操作提示`，实测微信里一条过长会把整段完成总结推过去，可读性差。
- **不做定时唤醒**（用户决定）：暂存后不会自动重新弹出，靠徽标 + 手动唤回。若以后要，可复用调度器给 `deferred_at` 加超时提醒。
- 暂存仅限验收类草稿；报告/知识/点子类暂存未开放（语义上它们不需要"先验证"）。
- 通知正文未带可点击深链（dsh-im 文本消息无结构化按钮），只带任务标题与摘要。
