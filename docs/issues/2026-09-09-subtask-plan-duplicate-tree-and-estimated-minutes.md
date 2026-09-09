# BUG（续）：`estimated_minutes` 在 `subtask_plan` 路径仍丢失 + 升级会话重复建树

| 项 | 内容 |
|---|---|
| **报告日期** | 2026-09-09 |
| **代码基线** | `00c98c4`（`main`，v1.10.1 之后） |
| **严重级别** | P1（数据丢失 + 任务树污染） |
| **关联** | 前序报告 [`2026-09-08-idea-task-draft-loses-estimated-minutes.md`](./2026-09-08-idea-task-draft-loses-estimated-minutes.md)（当时只修了 `idea_tasks` 一条路径） |
| **发现方式** | DSH 升级到 0.1.2-rc.1 后核对工作台任务树，发现重复子树 + 估时全空 |

---

## 1. 两个独立缺陷（同一次排查发现）

### 缺陷 A：`confirmSubtaskPlanDraft` 丢 `estimated_minutes`

前序报告修好了 `confirmIdeaTaskDraft`（`item.estimatedMinutes`），但 **`confirmSubtaskPlanDraft` 的 `createTask` 根本没传 `estimatedMinutes`**——所以 AI 拆解（`workbench_propose_subtasks`）产生的任务估时 100% 丢失。

```ts
// src/db/repo.ts:773（修复前）—— 连字段都没有
const task = createTask(db, {
  title, description, typeCode, priorityCode, dueAt, parentId, extra: item.extra ?? {},
}, actor, at)
```

`confirmIdeaTaskDraft` 则有另一处半修（`:1937`）：只读 camelCase，而**提案工具写入的是 snake_case** `estimated_minutes`，所以点子落地路径同样丢值。

**实测证据**（本机 `~/.dsh/workbench/workbench.db`，修复前）：47 个任务 `estimated_minutes` 非 NULL 数量 = **0**；而 5 份草稿 payload 里 **88/88** 个节点都带 `estimated_minutes`。

### 缺陷 B：同一 parent 可被重复拆解，无去重

`confirmSubtaskPlanDraft` 对每个节点无条件 `createTask`，**没有"同父同名已存在则跳过/更新"的语义**。因此在升级会话中又提交了一份 `subtask_plan` 草稿（同 parent、同 5 个标题），确认后整棵树第二次落地：

```
draft 3523d23f (subtask_plan, confirmed, 2026-09-08T17:33) → 3 节点
draft 70fbb22f (subtask_plan, confirmed, 2026-09-09T12:43) → 23 节点   ← 重复
```

### 缺陷 C（放大器）：归档不级联，子任务变"孤儿"

`archiveTask`（`repo.ts:391` 附近）只置当前节点 `archived=1`，**不级联子节点**；而 `GET /api/workbench/tasks` 只过滤 `archived=1` 的节点本身，仍返回其子节点。

结果：归档重复父任务后，**17 个子任务仍活跃且父不在返回集** → 前端建树时找不到父节点，只能平铺 → 用户看到"一堆重复的子任务"。

---

## 2. 修复（已提交）

`src/db/repo.ts` 两处，统一按 `dueAt` 已有的双形态写法：

```ts
const estimate = item.estimatedMinutes ?? item.estimated_minutes
// confirmSubtaskPlanDraft
estimatedMinutes: typeof estimate === 'number' ? estimate : undefined,
// confirmIdeaTaskDraft
estimatedMinutes: typeof estimate === 'number' ? estimate : null,
```

**端到端验证**（DB 副本，走真实 `createDraft` → `confirmSubtaskPlanDraft`）：

```
草稿 id: bfcb44a4 | kind: subtask_plan
  创建 [a2dbc0ff] FIXVERIFY-父节点  estimatedMinutes=45
  创建 [90219588] FIXVERIFY-子节点  estimatedMinutes=15
✅ PASS
```

**数据回填**：按草稿树（title + 父子关系）匹配活跃任务，回填 24 条 → 全库有估时 24/24（活跃任务全有值）。

---

## 3. 建议后续加固（未做，供决策）

| # | 建议 | 理由 |
|---|---|---|
| 1 | `confirmSubtaskPlanDraft` 增加幂等：同 parent 下同名节点已存在则跳过（或返回既有节点） | 防止重复拆解再次污染任务树 |
| 2 | `archiveTask` 增加 `cascade` 语义（归档父节点时一并归档未完成子节点） | 消除"孤儿活跃子任务"这一放大器 |
| 3 | `GET /api/workbench/tasks` 对"父不在返回集"的节点做兜底（要么带出父，要么不返回） | 前端不应拿到无法建树的节点 |
| 4 | 三条确认路径共用一个 `toTaskInput(item)` 归一化函数 | 消除 camelCase/snake_case 各写一遍的温床 |
| 5 | 补自动化测试：`subtask_plan` 与 `idea_tasks` 各断言 `estimated_minutes` 落库 | 本次两处都是"没测到"导致的漏修 |

---

## 4. 复现与验证脚本（本机留存）

| 脚本 | 用途 |
|---|---|
| `inspect-dup-tasks.mjs` | 扫描同父同名重复组、按批次统计 |
| `inspect-dup-detail.mjs` | 输出活跃树/归档树/孤儿清单、草稿与事件 |
| `backfill-estimates.mjs` | 按草稿回填 `estimated_minutes`（支持 `--apply`，自动备份） |
| `verify-estimate-fix.mjs` | 在 DB 副本上端到端验证修复 |

位于 `D:\DSHWorkspace\Phase 0：实测 dsh-im 可用性与版本\`。
