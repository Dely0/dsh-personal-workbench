# T1 交接：打通任务进度与验收闭环（D01–D04 / S1–S4）

任务 `b6bfecc5-e6b8-4483-9a00-13d43008c947`（父任务 `36c8e8ef-…`）。2026-09-30。

**本文件是 T1 的实现交接与证据记录，不是"本轮全部 AX 已通过"的声明。**
B 层（浏览器）验收归 T6；本文件中标"未验证"的项不得当作已过。

基线：`main @ 69a310f`（与 `origin/main`、`git ls-remote` 三者一致，`0 ahead / 0 behind`），
`SCHEMA_VERSION` 由 18 前进到 **19**（编号未被别的分支占用）。

---

## 1. 迁移编号与数据模型

**迁移 19 = `task-progress-and-plan-effort`（`src/db/schema.ts`）—— 本轮唯一的前向迁移。**

| 动作 | 内容 |
|---|---|
| DDL | `ALTER TABLE tasks ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0 CHECK(progress_percent BETWEEN 0 AND 99)` |
| 字典 | 插入 `ai_session_scope/persona`（`INSERT OR IGNORE`，S11 角色绑定复用 `ai_session_registry`，**不再另开迁移**） |
| 数据兼容 | 遍历 `daily_plans.items_json`：合法旧项补 `minutes` 快照（迁移当时该任务合法 `estimated_minutes` → meta `default_estimate_minutes` → 30）与 `effortDone=false`；**已有合法值不覆盖、原字段与原顺序逐字保留、未知 taskId 保留**；坏 JSON / 非数组 / 坏项**原串一个字节不动**，只向 `console.warn` 输出带 `planDate` 的诊断 |

- 诊断**不落库**：它是"每次读取都要重新判定"的事实（数据可能被手工修好），存快照会变成假的告警。
- 旧任务（含 done）进展**一律 0**，不从状态/子任务反推（ADR 0004：进度是显式值）。
- 迁移幂等：二次 `migrate()` 无数据变动（version 已到 19，`up` 不再执行）。
- 迁移**不使用** `daily_plans` 新列 —— 回填是数据兼容，不新增计划表结构（需求 §2.1）。

## 2. 接口 / 共享 DTO / 模块

| 位置 | 内容 |
|---|---|
| `src/shared/taskProgress.ts` **（新）** | `MIN/MAX_PROGRESS_PERCENT`(0/99)、`COMPLETION_TRIGGER_PERCENT`(100)、`checkProgressInput()`、`clampProgressForDisplay()`、`isOpenTask()`、`childFacts()`/`childFactsLabel()`、**`projectProgress()`（服务端与客户端共用的唯一展示判定）** |
| `src/shared/dailyPlanPolicy.ts` **（新）** | `checkPlanMinutes()`(1–1440)、`resolveDefaultPlanMinutes()`；候选池/容量（D08/D09）由 T2 在本模块继续追加，**不得另建第二个模块** |
| `src/shared/contracts.ts` | `PublicTask.progressPercent: number`；`PendingCompletionView` / `PendingCompletionsResponse` |
| `src/db/repo/progress.ts` **（新）** | **`setTaskProgress()`（0–99 的唯一写入口，同值不写事件/不刷 `updatedAt`）**、**`submitCompletionDraft()`（新旧两个工具共用的唯一验收提交实现）**、`listPendingCompletions()`、`getTaskPendingCompletion()` |
| `src/db/repo/tasks.ts` / `task-primitives.ts` / `repo.ts` | 行类型、`parseTask`、`createTask`(默认 0)、`updateTask`（含 `progress_percent`，不传即保持原值） |
| `src/tools.ts` | 新增 `workbench_update_progress(task_id, progress, note?, summary?, feedback?)`；`workbench_request_completion` 改为调用 `submitCompletionDraft`（**行为不变**，summary 仍可选） |
| `src/api/routes/tasks.ts` | `PATCH /tasks/:id` 新增 `progressPercent`（0–99，**100 拒绝**，非法时多字段**原子不生效**）；`GET /tasks/pending-completions`（一次性待验收投影）；`GET /tasks/:id` 增加可选 `pendingCompletion` |
| `src/client/taskProgressView.ts` **（新）** | `pendingCompletionMap()`（`available=false → null`，与空 Map 是两件事）、`taskProgressView()`（折成界面要画的东西） |
| `src/client/components/TaskProgress.tsx` **（新）** | 独立进度组件：`TaskProgress` / `ProgressBar` / `TaskProgressBadge`；五档 0/25/50/75/**100=完成任务** + 整数输入 0–99（越界当场拒绝，不夹取） |
| `src/client/components/TaskList.tsx` | `TaskTreeRows`/`TaskRow` 增 `pending`/`childrenOf`，行内渲染 `TaskProgress compact` |
| `src/client/index.tsx` | 待验收投影一次查询 + `childrenIndex`、`saveProgress`、`completeTaskFromProgress`、详情页进度卡、执行提示词新增"主动报进度" |
| `src/index.ts` | 注册 `updateProgressTool`；系统提示新增进度/100 语义（并写明不诱导咨询/拆解/排序会话） |

**两个值空间（ADR 0003）**：`0–99` 可直接写；`100` **不是可存储进度**，而是"提交完成验收申请"，
与 `workbench_request_completion` 走同一实现；「已完成」只由 `tasks.status_code = done` 表达。

## 3. 实际命令与结果（2026-09-30）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过（`tsc --noEmit`，无输出） |
| `pnpm build` | 通过（`lib/client.js` 468.02 kB，gzip 135.64 kB） |
| `node --test test/progress.test.mjs test/progressDb.test.mjs test/progressTools.test.mjs test/progressRoutes.test.mjs test/progressWiring.test.mjs test/db.test.mjs test/tools.test.mjs test/routes.test.mjs` | **tests 101 / pass 101 / fail 0** |
| `pnpm test`（全套） | **tests 648 / pass 648 / fail 0**（基线 594 → 新增 54 条，0 回归） |

基线（改动前，同一工作树）：`pnpm typecheck` 通过；`pnpm test` **594 pass / 0 fail**。

### 3.1 定向变异与恢复（每个关键禁令拆掉必须变红）

| 变异（在 `lib/` 产物上原地注入，跑完立即恢复） | 结果 | 恢复 |
|---|---|---|
| 拆掉 `workbench_update_task` 的 AI done/cancelled 硬拦 | `progressTools` **fail 1**（AX-G01 那条） | 复跑 pass 9 / fail 0 |
| `checkProgressInput` 去掉 `> 99` 拒绝 | `progress.test` **fail 2** | 复跑 pass 13 / fail 0 |
| 路由去掉 `if (!checked.ok)` 校验（让多字段 PATCH 部分生效） | `progressRoutes` **fail 2** | 复跑 pass 8 / fail 0 |

`lib/` 已重新 `pnpm build` 覆盖，`.mutbak` 无残留（`Get-ChildItem -Recurse -Filter *.mutbak` 为空）。

## 4. AX 覆盖情况（T1 归属部分）

| AX | 覆盖位置 | 状态 |
|---|---|---|
| AX-P01 18→19 迁移、旧任务 0、原字段不变、二次无变化、CHECK 拒 100 | `test/progressDb.test.mjs`（4 条） | ✅ 实测通过 |
| AX-P02 0/25/75/99 通过；-1/101/小数/字符串/null/布尔/NaN/Infinity 拒绝；同值不写事件/updatedAt | `progress.test.mjs`、`progressTools.test.mjs`、`progressDb.test.mjs` | ✅ 实测通过 |
| AX-P03 100 只建/更新 completion 草稿，progress 仍 75、status 仍 doing，重复提交无第二份 | `progressTools.test.mjs` | ✅ 实测通过 |
| AX-P04 100 缺 summary / consult / 归档 / done / cancelled 拒绝，无草稿、无部分写入 | `progressTools.test.mjs` | ✅ 实测通过 |
| AX-P05 多字段 PATCH 含非法进度全部不生效；PATCH 100 拒绝；100 走完成任务路径 | `progressRoutes.test.mjs`（3 条） | ✅ 实测通过（HTTP 侧）；界面点击属 B 层 → T6 |
| AX-P06 暂存/驳回不回退、通过后 done 且原进度保留、级联不改祖先/后代 | `progressDb.test.mjs`、`progressRoutes.test.mjs` | ✅ 实测通过（仓储/HTTP 侧） |
| AX-P07 列表/详情显示进度、done/cancelled 隐藏、pending/deferred/rejected 徽标、刷新一致 | `progress.test.mjs`（判定）、`progressWiring.test.mjs`（接线）、`progressRoutes.test.mjs`（投影数据） | ⚠️ **判定与数据链路通过；浏览器真实渲染与点击未验证（T6 的 `suites/progress.mjs`）** |
| AX-P08 直接子任务 done/cancelled 分别展示、不派生进度、执行提示词主动报进度 | `progress.test.mjs`、`progressWiring.test.mjs` | ⚠️ 纯函数与提示词逐条断言通过；浏览器整体验收归 T6 |
| AX-D02 旧 JSON 回填、保留排序/备注、未知 taskId 保留、坏 JSON 保留原串 + 诊断 | `progressDb.test.mjs`（2 条） | ✅ 实测通过（容量"不可计算"的**界面**部分归 T2/T6） |
| AX-G01 AI 不能直接 done/cancelled、100 只走 completion | `progressTools.test.mjs` + 上面的定向变异 | ✅ 实测通过 |

## 5. 明确**未验证** / 未做（不得当已过）

1. **浏览器 B 层全部未做**：本会话没装盘、没重启、没开浏览器。行内进度条的**视觉布局**
   （紧凑条宽度、与标题的挤压）只在 CSS 上做了兜底（`flex:none` + `max-width:46%`），**没有人眼确认过**。
2. `GET /tasks/pending-completions` 与 `pendingCompletion` 字段是**新端点**：真机上要等插件升级+重启才存在；
   旧服务端下界面会走 `available=false → null` 分支（不显示徽标），这条分支有单测，但没有真机对照。
3. T1 范围内**不做**：计划项 `minutes/effortDone` 的工具/路由/UI **接线**（D05–D07，T2）；
   候选池与容量（D08/D09，T2）；角色库（T3/T4）。迁移 19 只负责把这两组字段**预留并回填**。
4. **不装盘、不重启 19387、不动正式 DB**：迁移只在 `:memory:` 库与临时目录副本上验证过。
5. 未改公开版本号、未 `git commit`、未公开发布。

## 6. 给 T2–T6 的输入

- **迁移号已用掉 19**，且 `progress_percent` / 计划 `minutes`+`effortDone` 回填都已在本迁移内完成 ——
  **后续子任务不得再开迁移**；需要改计划表结构时先与父任务确认（本迁移刻意不新增计划表列）。
- 计划项新形状的**契约**已在 `src/shared/dailyPlanPolicy.ts` 冻结（`checkPlanMinutes` / `resolveDefaultPlanMinutes`），
  T2 直接用它，不要再写第二份分钟校验。
- `submitCompletionDraft()` 是验收草稿的唯一提交实现：任何"提交验收"的新入口（含 T2 的投入结束提进度）
  都必须复用它，不要 `tools` 调 `tools`、也不要新建第二套。
- 客户端展示判定只有 `projectProgress()` 一处；T2 的 PlanPanel 与 T4 的角色选择器若需要"要不要画进度"，
  复用 `taskProgressView()`，不要在组件里内联 `statusCode === 'done'`。
- `isOpenTask()` 放在 `shared/taskProgress.ts`：T2 的候选池**不要再写第三份** open 判定，请从这里 import。
- 客户端 `Task` 类型新增 `progressPercent?: number`（可选，旧服务端不下发 → 按 0 读）。

## 7. 改动文件清单（`git status --short` 实测）

修改：`src/api/routes/tasks.ts`、`src/client/components/TaskList.tsx`、`src/client/index.tsx`、
`src/client/styles.ts`、`src/client/viewTypes.ts`、`src/db/repo.ts`、`src/db/repo/task-primitives.ts`、
`src/db/repo/tasks.ts`、`src/db/schema.ts`、`src/index.ts`、`src/shared/contracts.ts`、`src/tools.ts`、
`tsconfig.build.json`。

新增：`src/client/components/TaskProgress.tsx`、`src/client/taskProgressView.ts`、`src/db/repo/progress.ts`、
`src/shared/dailyPlanPolicy.ts`、`src/shared/taskProgress.ts`、`test/progress.test.mjs`、
`test/progressDb.test.mjs`、`test/progressRoutes.test.mjs`、`test/progressTools.test.mjs`、
`test/progressWiring.test.mjs`。

未提交（按共同执行契约：用户未要求提交代码）：`docs/tasks/` 下规格与本文档；
`docs/release-checklist.md` 的用户改动原样保留、未被本项触碰。
