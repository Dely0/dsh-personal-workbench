# BUG：验收后出现同名重复任务（2026-09-13）

> 任务：`db5b2f6b-cb34-4fae-b8c0-4cdb7d51a351` 第 1 部分
> 状态：**已定位、已复现、已修复、已加回归测试**

## 1. 现象（用户原话）

> 我使用快速录入录入了一个任务，然后使用 AI 执行执行这个任务并发起验收，然后"待处理"中突然出现了
> 同名的任务申请，是验收导致这个任务被重新提交了？

## 2. 先纠正一个直觉：**验收流程不建任务**

| 可能的嫌疑 | 结论 | 证据 |
|---|---|---|
| `workbench_request_completion` 建了任务 | ❌ 不会 | `src/tools.ts:763` 的 `requestCompletionTool` 只 `createDraft/updateDraft(db, { kindCode: 'completion', … })` |
| 确认 completion 草稿时建了任务 | ❌ 不会 | `src/api/routes/drafts.ts:167-182` 的 completion 分支只调 `completeTaskCascade` + 写记忆 + 标草稿 confirmed |

`createTask` 的全部调用点（`grep -n "createTask(" src -r`）只有 6 处，能凭空多出一条**顶层同名任务**的只有一处：

**`src/db/repo/drafts.ts` 的 `confirmTaskDraft()` —— 即一次 `kindCode === 'task'` 草稿的确认。**

## 3. 真实库里的证据

库：`C:\Users\Administrator\.dsh\workbench\workbench.db`（2026-09-13 实测）

| | 任务 A | 任务 B |
|---|---|---|
| id | `5b414364-e929-403a-ac68-ae1a2ba70775` | `9803fdfc-c988-4672-8e58-2a7eb26c8b6b` |
| statusCode | done | todo |
| createdAt | 06:11:36Z | 06:13:35Z |
| 由哪条草稿建出 | `a7176c16`（06:10:42 建，06:11:36 确认） | `aa8a2ba8`（06:12:05 建，06:13:35 确认） |
| 草稿来自哪个会话 | `session-6e9b609e`（**澄清/快速录入**） | `session-5cf75152`（**执行会话**，同时是 A 的 `execute` 关联会话） |
| 草稿 payload 差异 | `aiPolicyCode=consult` | `aiPolicyCode=none`，描述多一段「## 说明」 |

**关键推断**：两条草稿的 payload **不同**，所以**不是"同一条草稿被确认了两次"**，
而是**两条独立草稿各自被确认了一次**。B 的创建者就是 A 的执行会话
（`aa8a2ba8` 的 `defer_count=1` 且 `deferred_at=NULL` → 它曾被「暂存」又被「唤回」，随后被确认）。

时间线（含用户在界面上的动作）：

```
06:10:42  快速录入 → 草稿 a7176c16（pending）
06:11:36  用户确认 → 任务 A（todo）           ← confirmTaskDraft #1
06:12:00  A 的执行会话 session-5cf75152 关联
06:12:05  执行会话又提交了一份同内容 task 草稿 aa8a2ba8   ← 工具侧没有任何"同名任务已存在"的提醒
06:12:07  执行会话提交 completion 草稿 5ddcdb2f
06:12:35  用户「暂存」验收草稿（completion_deferred #1）
06:13:13  用户再次「暂存」（completion_deferred #2）
06:13:35  任务 B 建立（todo）                 ← confirmTaskDraft #2 = 事故点
06:13:47  用户「验收通过」→ 任务 A 变 done
```

06:13:35 与 06:13:47 只差 12 秒 —— 用户以为自己点的是同一份「验收申请」。

## 4. 根因（两个独立缺陷）

### 缺陷 1：`withDraftConfirm()` 不校验草稿状态，确认不幂等

`src/db/repo/shared.ts` 的 `withDraftConfirm()` 原实现是：

```ts
const draft = getDraft(db, draftId)
if (draft === undefined || draft.kindCode !== kindCode) return options.emptyValue
db.exec('BEGIN')
const result = build(draft)            // ← 不看 statusCode，直接重建
setDraftStatus(db, draftId, 'confirmed', at)
```

`POST /api/workbench/drafts/:id/confirm` 也没有前置状态检查。
后果（已实测复现，见第 5 节）：**同一条 task 草稿被确认两次 → 两条同名任务，两次都返回 200。**

### 缺陷 2：两条独立草稿之间没有任何判据

`confirmSubtaskPlanDraft()` 早就有 `findSiblingByTitle()` 幂等（`drafts.ts` 注释写明是为了防
"重复确认整棵树建两遍"），但 `confirmTaskDraft()` **从来没有**这道门 —— 于是同一个坑在
task 草稿这条路径上原样复发。

### 缺陷 3（界面侧，事故的"扳机"）：弹框会被静默换人

`src/client/index.tsx` 的 5 秒轮询直接 `setPendingDraft(res.draft)`，而
`GET /api/workbench/drafts` 返回的是 `getLatestActiveDraft()`（**最新的未暂存草稿**）。
用户把最新那份（验收申请）暂存之后，服务端立刻递补下一份 —— 而递补上来的可能是
**另一种类型**的草稿（实测：`completion` → `task`），弹框长得一模一样。

受控实验（`node scripts/repro/repro-banner.mjs`）：

```
[06:12:07] 弹框显示 → completion / fc81765c /「x」
[06:12:35 起] 弹框显示 → task / 63f6d690 /「仅测试，不思考，直接提交任务」   ← 静默换人
[06:13:20 起] 弹框显示 → completion / fc81765c   ← 唤回后又换回来
```

用户接着点主按钮时，确认的已经不是他以为的那一份了。

## 5. 复现（可复跑）

在**真实路由层**（`makeRoutes` + 内存库，与 `test/routes.test.mjs` 同一装配）执行：

```powershell
node scripts/repro/repro-routes.mjs     # 修前：两次 200，两次 createTask，"同名 2 条"
node scripts/repro/repro-banner.mjs     # 弹框被静默换人的完整时序
node scripts/repro/verify-fix.mjs       # 修后：5 个场景逐条核对
```

修前 `repro-routes.mjs` 的关键输出：

```
=== 对照实验：同一条草稿被 POST confirm 两次 ===
    第一次: 200 485a486e-…
    第二次: 200 14f0afad-…          ← 又建了一条
    库里「双确认实验」条数: 2
```

## 6. 修法（用户 2026-09-13 决策：A 档 —— 幂等 + 只告警不合并）

| 层 | 改动 | 位置 |
|---|---|---|
| 1 | **确认幂等**：`withDraftConfirm` 把本次产出回写 `payload.confirmResult`；同一条草稿再次确认时**回放**第一次的产出，绝不重建。状态不是 `pending` 且没有产出可回放时**直接返回 `emptyValue`**（不执行 `build`） | `src/db/repo/shared.ts` |
| 2 | **回放读当前状态**：`confirmTaskDraft` 的 `replay` 按 id 重新读任务，返回的是库里那条的**最新**状态，不是创建那一刻的快照 | `src/db/repo/drafts.ts` |
| 3 | **同名告警**：新建任务后若同父同名还有一条（不是本次这条），回传 `duplicateOf`（含 `sameDescription` / `sameWorkspace`），**不阻止创建** | `src/db/repo/drafts.ts` |
| 4 | **显式去重入口**：`POST /confirm` 带 `{ intent: 'dedupe' }` 时复用已有同名任务、不新建（供界面「就用已有那条」使用） | `src/api/routes/drafts.ts` |
| 5 | **工具侧提醒**：`workbench_submit_task` 发现同名任务已存在时在回执里提醒；若当前会话正是那条任务的关联会话，直接写明"这几乎肯定是重复录入" | `src/tools.ts` |
| 6 | **界面侧**：`duplicateOf` → 弹「库里已经有一条同名任务」选择框（保留两条 / 就用已有那条并归档本次多建的）；`replayed` → 明确提示"本次没有重复建单" | `src/client/index.tsx`、`components/DraftBanner.tsx` |
| 7 | **弹框换人可见**：递补上来的草稿类型与上一份不同时，弹框顶部挂醒目提示 | `src/client/index.tsx`、`components/DraftBanner.tsx` |
| 8 | **错误码诚实**：Task 草稿确认返回 `undefined` 时区分"草稿不存在"（404）与"草稿已终结"（400） | `src/api/routes/drafts.ts` |

**为什么不做"同名就自动合并"**：同一个标题建两条任务是正当需求（每周例会）。
静默合并会吃掉用户的真实需求，而"重复提交同一份草稿"这一半根因已由第 1 层彻底堵死。

## 7. 回归测试

| 文件 | 锁住什么 |
|---|---|
| `test/duplicateTask.test.mjs`（新增 9 例） | 同草稿两次确认只建一条；回放跟当前状态；老草稿（无 `confirmResult`）不重建；确认记录在但任务被删 → 抛可读错误而非重建；已放弃草稿不能确认；两条独立草稿默认都建但第二条带 `duplicateOf`；`dedupe` 不新建；`subtask_plan` 幂等不被改坏；回写不动用户原始字段 |
| `test/routes.test.mjs`（新增 3 例） | HTTP 层：`POST /confirm` 两次只建一条且第二次 `replayed=true`；同名第二条带 `duplicateOf`、`dedupe` 不新建；验收草稿两次确认只完成一次、任务数不变 |
| `test/tools.test.mjs`（新增 1 例） | `workbench_submit_task` 的同名提醒三态（无同名 / 有同名但会话无关 / 当前会话就是它的关联会话） |

`pnpm test`：**159 pass / 0 fail**（改动前基线 146）。

## 8. 遗留数据

`9803fdfc-c988-4672-8e58-2a7eb26c8b6b`（多出来的那条 todo 任务）**按用户决定保留**，
由用户修好后在界面上自行处理（可归档，`POST /api/workbench/tasks/:id/archive`，可恢复）。
原任务 A `5b414364` 已 done，保留。

## 9. 重启后的端到端验收（2026-09-13，宿主 1.14.51）

`node .pwtest/verify-duplicate-task.mjs "<带 token 的 URL>"` → **11/11 通过**：

| 判据 | 结果 |
|---|---|
| ① `/api/workbench/health` 版本 = 源码版本 | ✅ 1.14.51 |
| ③ 造出事故形态（两条同内容草稿、第一条已确认） | ✅ |
| ② 侧栏「工作台」点开面板（真实鼠标） | ✅ `data-open=1`，宽 1144 |
| ④ 确认第二条 → 弹出「库里已经有一条同名任务」选择框 | ✅ 截图 `shots/duplicate-task/03-duplicate-prompt.png` |
| ⑤⑥ 真实鼠标点「就用已有那条」→ 该标题未归档任务只剩 1 条、多建的那条进归档 | ✅ |
| ⑦ 同一条草稿再确认 → `replayed=true`，任务数不变 | ✅ |
| ⑧ 无未捕获异常 / 无 `slot entry crashed` | ✅ |
| ⑨ 收尾：临时数据清空（与用户手测"BUG 没有复现"一致） | ✅ |

### 踩到的坑（写给下一个改客户端的人）

1. **弹框是 `createPortal` 到 `document.body` 的**（`components/Modal.tsx`），
   不在 `.wb-app-scope` 里面 —— 用面板容器去找弹框按钮永远找不到，
   会把"找错地方"误读成"弹框消失"（第一版复现脚本就栽在这里，还**假通过**过一次）。
2. **侧栏「工作台」入口是开关**：上一轮结束时面板若还开着，下一轮再点就是"关"。
   跑多轮脚本必须每轮先确保初始态、再校验 `data-open`，否则后面的轮次全在错误的初始态里跑。
3. **截图里的"白"不等于没渲染**：面板本身就是白底。用 PNG 直方图判断"有没有内容"时，
   要看**非白像素的色数**与**局部裁剪**（把标题栏 60px 单独裁出来能看到绿按钮
   `rgb(36,124,98)`）。连拍 4 张统计完全一致 → 说明捕帧稳定，不是"捕到过期帧"。
