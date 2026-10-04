# 实现计划：计划项必须是可执行叶子（父任务排入今日 = 展开子树）

- **依据**：[ADR0010](../adr/0010-plan-items-are-executable-leaves.md)（口径已由用户拍板：方案 A；"父任务自己今天也要投入"不开口子）
- **状态**：待用户审批（本文档本身不动代码）
- **范围**：`shared` 纯逻辑 → 服务端写入口 → 客户端接线与界面 → AI/提示词口径 → 文档与实测
- **不改**：容量口径（仍 = 计划项 minutes 之和）、不入库迁移、不清洗历史脏数据、不碰 DSH 运行环境

## 0. 先说清两处口径（比 ADR0010 的文字更精确，实现时按这里写）

> **用词**：本文只用一个说法 —— **非叶子任务** = 下面还有**未完成**子任务的任务（通常就是被当成项目/分组用的父任务），也就是 ADR0010 里"不是可执行叶子"的那一类。**不要**再用第二个名字（曾经草稿里的"容器"就是自造同义词，已删）：同一件事两个名字正是本仓库口径漂移的起点。

1. **「计划」来源 = 叶子且自己是计划项 ∪ 非叶子任务且它子树内**全部**叶子都是该日计划项。**
   ADR0010 把「未排期」写成"自己不在计划、且子树里也没有计划成员"，那句与"部分叶子已排的父任务留在未排期、按钮 = 补齐剩余叶子"是矛盾的。按上面这条定义，「未排期」保持既有补集公式（`open − plan − overdue`）一个字不改，同时两句话都成立：
   - 只排了一部分叶子的非叶子任务 → 不在「计划」（没全排）→ 落回「未排期」，一键补齐；
   - 全部叶子已排的非叶子任务 → 进「计划」作分组行。
   划分性质（三页签并集 = 全部 open、未排期是补集、逾期可与计划重叠）**全部不变**。
2. **候选要区分两个量**：`selfPlanned`（自己真是计划项，带 `plannedMinutes`/`plannedOrder`）与 `dayPlaced`（该日已安排，含"非叶子任务全排"）。
   账本、提示词、行标签用 `dayPlaced`；minutes 只允许取 `selfPlanned` 的值 —— 否则非叶子任务会凭"子项之和"进入"已排分钟"从而被算两遍。
   这两个量的判定必须在**共享层实现一次**，`planCandidates` / `dayPanelTreeSources` / `dayPanelTabMembers` / 容量账本未排入区全部消费它（否则又是"同一语义两处实现"）。

## 落地顺序原则

- **阶段独立提交、独立验收**；每个任务先让判据变红、再让实现变绿（政策 = 会失败的测试）。
- 阶段 1 是纯函数，无 I/O，最先做、最容易被单测钉住；越靠后的阶段依赖越少。
- 每个检查点跑一次 `node --test`（相关文件）+ `pnpm test` 前先 `pnpm build`（本机 Windows 可直接跑；历史上有"必须在 WSL 内构建"的记录，若失败按该记录换 WSL）。

---

## 阶段 1：共享纯逻辑（`src/shared/dailyPlanPolicy.ts`）

### Task 1：叶子判定与子树展开（纯函数）
目标：给"什么是可执行叶子""排入父任务要展开成哪几条"一个唯一实现。
判据（单测先红后绿，`test/dailyPlanPolicy.test.mjs`）：
- 无未完成子任务 → 叶子；有一个 `todo/doing/blocked` 子任务 → 不是叶子；子任务全是 `done/cancelled/归档` → 仍是叶子；
- 展开按**树序**（先父后子；同级 `createdAt` 升序、再 id 词典序 —— 与 `planCandidates` 现有稳定排序同口径），跳过终结态与归档子任务，含多层（中间节点自己也带子任务），未知 id → 空数组，环 → 不死循环；
- 叶子展开 = 它自己。
文件：`src/shared/dailyPlanPolicy.ts`、`test/dailyPlanPolicy.test.mjs`。依赖：无。规模：S。

### Task 2：写入校验第 4 条改为"新增项必须是非叶子"
目标：`checkPlanTaskSet` 不再用"同链互斥"表达意图，而是直接判叶子；历史脏数据豁免不变。
判据：
- 新增**非叶子** → 拒，中文原因含"不是可执行的叶子""下面还有 N 个未完成任务""请改排它的子任务"；
- 两条**兄弟叶子** → 允许；
- "两项都在既有计划里"仍豁免（不因本次无关写入被拒）；
- 新增叶子而其**祖先已是既有计划项** → 拒，原因含"先移除父项"（这是唯一保留的链冲突形态）。
文件：`src/shared/dailyPlanPolicy.ts`、`test/dailyPlanPolicy.test.mjs`、`test/db.test.mjs`（原 163/185/191 的"同一父子链"断言改写）、`test/dailyEffort.test.mjs`（192 行 `/同一父子链/`）。依赖：Task 1。规模：S。

### Task 3：`dayPlaced` 判定进共享层，候选池与页签来源改吃它
目标：把「某天是否已安排」的判定收成一处，并让 `PlanCandidate` 带上 `selfPlanned` / `dayPlaced`。
判据：
- `planCandidates`：非叶子任务在**全部**叶子已排时 `dayPlaced=true` 且 `plannedMinutes/plannedOrder` 为 undefined；只排部分时 `dayPlaced=false`；
- `dayPanelTabMembers`：部分叶子已排的非叶子任务仍在「未排期」；全部叶子已排后进「计划」；`test/dayPanelTabs.test.mjs` 的三条划分性质断言保持绿（并集 = 全部 open / 未排期是补集 / 逾期可重叠）；
- **源码扫描**：全仓只有一处"某天已安排"的判定（`test/dayPanelWiring.test.mjs` 或 `test/capacityWiring.test.mjs` 追加一条，防第二处实现复活）。
文件：`src/shared/dailyPlanPolicy.ts`、`src/client/capacity.ts`（只接线）、`test/dailyPlanPolicy.test.mjs`、`test/dayPanelTabs.test.mjs`、`test/capacity.test.mjs`、`test/fixtures/capacityFixture.mjs`（S6/S7 那条注释与用例）。依赖：Task 1。规模：M。

## 检查点 1（阶段 1 收口）
- [ ] `node --test test/dailyPlanPolicy.test.mjs test/dayPanelTabs.test.mjs test/capacity.test.mjs test/capacityWiring.test.mjs` 全绿
- [ ] 反向变异：把叶子判定改回"只要有子任务就算叶子" → 至少 2 条变红
- [ ] 用户过目本阶段口径（尤其 §0 的两条）

---

## 阶段 2：服务端写入口

### Task 4：`addDailyPlanItem` 改为"展开到叶子后原子追加"
目标：一键排入在父任务上 = 补齐它下面所有未排叶子，一次事务写完。
判据（`test/db.test.mjs`）：
- 父任务排入后，计划里出现**全部未完成叶子**、按树序、各带自己的 `estimatedMinutes`（缺则设置默认）；
- 已在计划里的叶子 **minutes/effortDone 一概不动**；重复调用 → `added:false`；
- **子任务先排、父任务后来点** → 只补缺口，不报错（原报错场景归零）；
- 未知任务 404 语义、关闭/归档新增拒绝、坏计划不可解析拒绝 —— 全部保持；
- 返回体新增 `addedTaskIds`（本次真正落库的那些）。
文件：`src/db/repo/plans.ts`、`test/db.test.mjs`。依赖：Task 1-3。规模：M。

### Task 5：路由回执与 PUT 语义
目标：HTTP 层如实回显展开了什么；PUT 全量保存继续不展开、非叶子整份拒绝。
判据（`test/routes.test.mjs`）：
- `POST /plans/:date/items` 回 `{ok, plan, added, addedTaskIds}`；父任务触发时 `addedTaskIds` = 叶子集合；
- `PUT /plans/:date` 带非叶子**新增项** → 400，原因可读；既有非叶子项原样保留不报错；
- 404/400 区分不变（"任务不存在"仍 404）。
文件：`src/api/routes/plans.ts`、`test/routes.test.mjs`。依赖：Task 4。规模：S。

## 检查点 2
- [ ] `pnpm test` 全绿（含更新后的 `db`/`routes` 套件）
- [ ] 手工探针：对一份真计划 POST 一个父任务，逐条比对"展开出的叶子 == 未完成叶子"

---

## 阶段 3：客户端接线与界面

### Task 6：回执回显
目标：一键排入的回执说清服务端展开了什么。
判据：`useDayWorkspace.addTaskToPlan` 用 `addedTaskIds` 拼出「已排入今日计划：N 个子任务（合计 X 分钟）」；`added:false` 仍说"已经在计划里"；单子任务时文案与现状一致（不出现"1 个子任务"这种别扭话）。
文件：`src/client/hooks/useDayWorkspace.ts`、`src/client/views/TodayPane.tsx`（若含未排入区文案）、`test/dayPanelWiring.test.mjs`。依赖：Task 5。规模：S。

### Task 7：计划页签的分组行与计数
目标：父任务在「计划」页签以**分组行**出现（灰化），写「已排 N / 共 M 个子任务 · 合计 X 分钟」，不计入计划条数。
判据（渲染测试，`test/dayPanelTabs.test.mjs`）：
- 分组行有 `wb-row-context` + 合计文案；页签计数 = 真计划项条数（不含分组行）；
- 分组行**不渲染**「排入今日」按钮；叶子行照旧；
- 合计与计数由**派生**得出（`dayPanelModel.ts` 新增 `groupSummaryOf(taskId)`，从该日计划 + 任务树算），组件不自己 filter。
  说明：非叶子任务行是 `filterTaskTree` 保留祖先链的既有产物，不需要新渲染路径；只需把文案传下去。
文件：`src/client/dayPanelModel.ts`（`contextIds` + `groupSummaryOf`）、`src/client/components/DayPanel.tsx`、`src/client/components/TaskList.tsx`、`test/dayPanelTabs.test.mjs`。依赖：Task 3。规模：M。

### Task 8：未排期页签里的非叶子任务行仍可一键补齐
目标：部分叶子已排的非叶子任务按 §0 仍是「未排期」的**成员**（不是上下文行），行上的按钮 = 补齐剩余叶子；全部叶子已排后它按成员判定离开该页签、改到「计划」作分组行。
判据（渲染测试）：非叶子任务行渲染 `wb-schedule` 且文案仍为「排入今日」；点它的回调与叶子行走**同一个** `addTaskToPlan`（源码扫描：不许出现第二个写入口，沿用 `test/dayPanelWiring.test.mjs` 既有断言风格）。
文件：`src/client/components/DayPanel.tsx`、`test/dayPanelTabs.test.mjs`。依赖：Task 3、Task 6。规模：S。

### Task 9：历史边界给可读原因，不留裸 400
目标：给"已在今日计划里的任务"新增第一个子任务时，界面说得清怎么办。
判据：错误文案含"先移除父项"；界面把它当普通错误条展示（不新增弹框）。
文件：`src/client/hooks/useDayWorkspace.ts`（或任务编辑路径的调用点）、`test/dayPanelWiring.test.mjs`。依赖：Task 2。规模：XS。

## 检查点 3
- [ ] `pnpm test` 全绿
- [ ] 隔离实例实测（3080 + 独立 profile/DB，走 `scripts/dev-verify.mjs`）：父任务排入 → 叶子全进；子任务先排 → 父任务点一次补齐；容量合计 = 叶子之和

---

## 阶段 4：AI 侧口径同步

### Task 10：提示词与工具描述改成"只排可执行叶子"
目标：AI 不再被教"父子二选一"，而是"父任务下还有未完成子任务 → 它不是计划项，请排它的叶子"。
判据：
- `src/tools.ts` 与 `src/index.ts` 的 `workbench_propose_daily_plan` 描述、`src/client/hooks/useWorkbenchAISessions.ts` 的计划提示词、`src/client/dailyPlanPrompt.ts` 的正文措辞统一；
- 源码扫描：不再出现"同一父子链不要同时入列"；出现"可执行叶子"与"会被整份拒绝"的说明；
- AI 提交含非叶子的草稿 → 整份拒绝且原因可读（沿用既有草稿拒绝路径，`test/tools.test.mjs` 或 `test/routes.test.mjs` 断言）。
文件：`src/tools.ts`、`src/index.ts`、`src/client/hooks/useWorkbenchAISessions.ts`、`src/client/dailyPlanPrompt.ts`、`test/tools.test.mjs`。依赖：Task 2、Task 5。规模：M。

## 检查点 4
- [ ] `pnpm test` 全绿
- [ ] 手工：让 AI 排一次今天，提案里若出现父任务，确认被拒且原因可读

---

## 阶段 5：文档与验收

### Task 11：口径文档同步
- `docs/tasks/36c8e8ef-1104-4e68-b55f-a2a6cc533ab9-工作台插件优化/requirements.md` 的"共同链校验"条目加一行"已被 ADR0010 修订"（历史文档不改写正文，只标取代关系）；
- `docs/adr/0001-today-is-the-day-panel.md` 的日期面板树来源口径补一条"计划来源含'非叶子任务全部叶子已排'"；
- `docs/adr/0010-*.md` 按 §0 收紧「未排期」那句措辞，并把本计划的阶段与判据回填。
文件：三个文档。依赖：全部。规模：S。

### Task 12：实测验收（用户在场）
- 用户在**自己的实例**上复测四个场景：父任务排入 / 子任务先排后父任务补齐 / 全部已排的父任务显示分组行 / 给已排任务加子任务的可读报错；
- 走 `docs/adr/0006-dev-verify-chain.md` 的验收链取证；涉及装盘/重启必须先拿到用户明确指令（`dsh-safe-plugin-ops` 门禁 + `scripts/check-installed-version.mjs`）。

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 顺手改了容量口径（例如让非叶子任务按子项之和进"已排"） | 同一份工作算两遍 | 容量断言（`test/capacity.test.mjs` / `capacityWiring.test.mjs`）保持绿；`selfPlanned` 与 `dayPlaced` 严格分开，minutes 只取 `selfPlanned` |
| "某天已安排"的判定在候选池/页签/账本各写一遍 | 本项目第一 bug 类别复发 | Task 3 的单一实现扫描断言 |
| 展开让一次 POST 写入多行，破坏"原子追加/并发不丢件" | 并发追加丢件 | 全部追加仍在同一次 `BEGIN IMMEDIATE` 事务内，末尾 order 一次算完；沿用既有并发断言 |
| 历史脏数据（父任务已是计划项）与新增子任务互斥 | 用户仍撞一次报错 | Task 2/Task 9：可读原因 + "先移除父项"；不自动清数据 |
| 客户端与 AI 两条入口口径漂移 | 一边能排一边报错 | 统一改到"叶子"口径 + 扫描断言（Task 10） |
| 30 条候选截断语义被改动 | AI 拿到不完整清单 | `selectPromptCandidates` 的截断与"另有 N 条"提示**不动**；只加叶子判定 |
| 构建环境（历史记录：须 WSL 内构建） | 改完进不了库/假绿 | 每阶段 `pnpm build`；失败则按该记录换 WSL 跑，不跳构建 |

## 开放问题（需要你一句话）

1. **§0 的两条口径收紧**：非叶子任务"全部叶子已排"才算已安排（而不是"排了任意一条"）—— 认可吗？这决定"部分已排的父任务"留在「未排期」（可一键补齐），而不是跳进「计划」。
2. **容量面板的「未排入」区**要不要一起显示非叶子任务行？**实现时定案：不显示** —— 改成"候选池只收可执行叶子"（`planCandidates` 跳过非叶子任务）。理由：候选池是"可以排进今天的东西"，而排父任务的含义是展开到它的叶子；让父任务进候选会同时坏三处（AI 提案会被整份拒绝、下拉里出现排不了的项、容量里出现一行按父任务自己估时算的假数字，或与它的叶子合计重复计数）。补齐入口不丢：日期面板「未排期」页签里的父任务行照旧可一键补齐（那条路径吃 `dayPanelTabMembers`，不看候选池）。这条同时收紧了 ADR0010：候选 = 可执行叶子。
3. **要不要顺手把阶段 3 的实测放到你自己的实例上做**（而不是 3080 隔离实例）？前者省事但要装盘+重启，会中断你当前会话。

## 不做什么（范围边界）

- 不做数据迁移、不批量清洗历史计划里的父任务项（ADR0002「不替换已有项」）。
- 不把"进度/状态"和排期耦合（进度仍是显式值，ADR0004）。
- 不新增未来日期排期入口（仍只服务今天，ADR0001 口径补充）。
- 不改 `effortDone` 的按日语义（ADR0007）。
