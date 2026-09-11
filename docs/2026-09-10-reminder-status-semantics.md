# 提醒状态语义修复：窗口、终态与重新武装（v1.13.2）

- 日期：2026-09-10
- 来源任务：修复提醒状态语义（逾期提醒永久滞留 + 「知道了」不可逆 + 策略关闭仍提示）
- 状态：已实现并真机验证通过

## 0. 问题回顾

| # | 现象（用户可见） | 根因 |
|---|---|---|
| 1 | 早已过期的提醒**永久**挂在「待处理」计数里 | `listDueReminders()` 只过滤 `fired_at IS NULL`，没有下界窗口；调度器判 `too-old` 时只记事件、不落终态 |
| 2 | 点「知道了」= 永久消耗该提醒，只能重新加一条 | `fired_at` 一个字段同时承担「已送达」「已入队」「用户已确认」三种语义 |
| 3 | 关闭提醒策略后页内提醒**照样弹** | `/reminders/due` 不查策略开关 |
| 4 | 桌面通知每次刷新页面都重发一次 | 去重集合只在内存（`notifiedRef`） |

## 1. 字段拆分（schema 15）

```sql
ALTER TABLE task_reminders ADD COLUMN skipped_at TEXT;        -- 已跳过（太旧）：终态
ALTER TABLE task_reminders ADD COLUMN acknowledged_at TEXT;   -- 用户已确认：终态，可重置
-- fired_at 语义收窄为「已送达 / 已入队」，不再被"用户确认"复用
```

`listDueReminders()` 的待处理条件变为：`fired_at IS NULL AND skipped_at IS NULL AND acknowledged_at IS NULL`，
即三个终态标记任一存在都不再进「待处理」。

## 2. 窗口语义

- **查询侧**：`/reminders/due` 用已有的 `listDueRemindersInWindow(db, policy.catchupWindowHours)`
  （窗口默认 24h，取自策略），窗口外的历史提醒不再无限期返回。
- **写入侧**：`skipStaleReminders(db, windowHours)` 把窗口外的落成 `skipped_at` 终态（事务 + 幂等），
  这样计数不会越积越多，「重新武装」也有据可依。
- 调度器的两处 `too-old` 分支（`scan()` 常规路径与 `catchup()` 补发路径）都会调用 `markSkipped()`。
  **注意**：仍然不写 `fired_at`——那个字段表示"已送达"，写它会污染节流预算
  （`countFiredRemindersSince` 按 `fired_at` 统计小时/日上限）。

## 3. 用户可见行为

| 场景 | 行为 |
|---|---|
| 提醒到期 | 页内横幅 + 桌面通知（去重集合持久化，刷新不再重复弹） |
| 点「知道了」 | 写 `acknowledged_at`，从待处理消失；任务详情里显示「已确认 <时间>」 |
| 提醒太旧（超出窗口） | 自动落 `skipped_at`，详情里显示「已跳过（超出补发窗口）」 |
| 误点或想再来一次 | 详情里每条终态提醒都有**「重新武装」**按钮 → 清空三个标记 → 回到未处理 |
| 关闭提醒策略 | `/reminders/due` 直接返回空，页内不再弹 |

新增端点：

| 方法 | 路径 | 行为 |
|---|---|---|
| POST | `/api/workbench/reminders/:id/ack` | 写 `acknowledged_at` |
| POST | `/api/workbench/reminders/:id/reset` | 清空 `fired_at` / `skipped_at` / `acknowledged_at` |

前端：`ackReminder()` 优先调 `ack`，老版本宿主没有该端点时优雅退回 `fire`。

## 4. 过程中发现的第二处根因（值得单独记）

`src/api/routes.ts` 里写死了：

```ts
...makeReminderRoutes(db, { …, listDue: () => listDueReminders(db), fire: (id) => fireReminder(db, id) })
```

于是 `index.ts` 通过 `deps` 注入的「策略开关 + 补发窗口」版本被**静默覆盖**：代码看起来完全正确，
运行时却走旧逻辑。改为 `deps.listDue ?? (() => listDueReminders(db))` 并加了一条接线回归测试
（给 `makeRoutes` 注入假的 `listDue`，断言 `/reminders/due` 返回的正是注入内容）。

**教训**：把"注入的依赖"与"本地兜底"混在同一个字面量里，很容易让注入失效而不报错。
兜底必须显式写成 `deps.x ?? localFallback`。

## 5. 验证

| 项 | 结果 |
|---|---|
| `pnpm check` | 通过 |
| `pnpm test` | 91/91（新增 5 条语义测试 + 1 条接线回归测试） |
| 真机 13/13 | 窗口外不返回且落 `skipped_at`、`fired_at` 未污染、reset 清空三标记、ack 写入、策略关闭返回空、策略恢复往返 |
| 探针清理 | 4 个探针任务已归档、5 条探针提醒已删；用户原有 3 条提醒与策略未受影响 |

## 6. 后续（未做）

- 任务详情里的提醒列表尚未支持「删除提醒」（当前只有重新武装）。
- 桌面通知去重集合用 localStorage 键 `dsh-workbench:desktop-notified`，换浏览器/清缓存会重新通知一次（可接受）。
