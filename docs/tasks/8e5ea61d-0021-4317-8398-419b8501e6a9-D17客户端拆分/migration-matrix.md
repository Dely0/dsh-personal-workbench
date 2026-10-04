# D17 迁移矩阵（职责 → 新 owner → 判据 → 提交）

> 每完成一个批次就回填本表。**"判据/变异"列必须写清扫描范围** —— 设计文档 §8.2 要求
> 负向唯一性**递归覆盖相关客户端源码**，只在旧入口里查"没有第二份"会被搬家后的假绿骗过去。

## 共享底座（P1 建立，后续批次复用）

| 项 | 内容 |
|---|---|
| 全客户端扫描底座 | `test/_clientSources.mjs`：`read` / `stripComments` / `readClientSources()` / `countInClient(pattern)` / `assertClientCount(assert, pattern, n, msg)` |
| 口径 | 递归 `src/client/**/*.{ts,tsx}`，**剥注释**后计数；失败信息带上"命中分布（文件×次数）" |
| 为什么 | 拆分后实现按域搬走，只扫 `index.tsx` 的正向断言会假红、负向断言会空洞通过 |

## 批次总览

| 批次 | 域 | owner | 入口 before→after | WorkbenchApp before→after | 状态 |
|---|---|---|---|---|---|
| P0 | 设计+基线 | — | — | — | ✅ 完成（`baseline.md`） |
| **P1** | **知识域** | `hooks/useKnowledge.ts` + `views/KnowledgeListView.tsx` + `views/KnowledgeDetailPane.tsx` | **5725 → 5451（-274）** | **4197 → 3975（-222）** | ✅ **完成** |
| P2 | 点子域 | `hooks/useIdeas.ts` + `views/IdeasListView.tsx` + `views/IdeasDetailPane.tsx` | **5451 → 5138（-313）** | **3975 → 3660（-315）** | ✅ **完成** |
| P3 | 任务域（4 个子批） | **P3-1 ✅** `hooks/useTaskListModel.ts` + `views/TaskListView.tsx`；**P3-2 ✅** `hooks/useTaskDetailModel.ts` + `views/TaskDetailPane.tsx` + `app/contracts.ts`；**P3-3 ✅** `hooks/useTaskForms.ts` + `views/TaskFormModal.tsx`；**P3-4 ✅** `hooks/useTaskData.ts` | **5138 → 4571（P3-1 -104、P3-2 -280、P3-3 -79、P3-4 -104）** | **3660 → 3101（P3-1 -92、P3-2 -283、P3-3 -81、P3-4 -103）** | ✅ **P3 全部完成（P3-1/P3-2/P3-3/P3-4）** |
| P4 | 日期域 | `hooks/useDayWorkspace.ts` + `views/TodayPane.tsx` + `views/CalendarView.tsx`（实际落地名，非设计稿的 `TodayView`） | **4571 → 4188（-383）** | **3101 → 2715（-386）** | ✅ **完成** |
| P5 | 设置/提醒/草稿 | **P5-1 ✅** `hooks/useWorkbenchFeedback.ts` + `hooks/useWorkbenchSettings.ts` + `src/client/settingsFallback.ts`；**P5-2 ✅** `hooks/useWorkbenchReminders.ts`；**P5-3 ✅** `hooks/useWorkbenchDrafts.ts` + `hooks/useWorkbenchPolling.ts`（设计稿的 `useReminders.ts` / `useDrafts.ts` / `useWorkbenchPolling` 三个名字按本仓库落点实际落地） | **4188 → 3724（P5-1 -217、P5-2 -145、P5-3 -202）** | **2715 → 2267（P5-1 -241、P5-2 -146、P5-3 -204）** | ✅ **P5 全部完成（P5-1/P5-2/P5-3）**；P5-3 顺带解锁 ADR-0008 硬门一条：`WorkbenchApp` 体内零定时器 |
| P6 | AI/录入/目录（4 个子批） | **P6-1 ✅** `hooks/useWorkbenchNavigation.ts` + `hooks/useWorkbenchBusy.ts`；**P6-2 ✅** `hooks/useWorkbenchQuickIntake.ts` + 纯模块 `src/client/intakeHelpers.ts`；**P6-3 ✅** `hooks/useWorkbenchAISessions.ts`（914 行）；**P6-4 ✅** `hooks/useWorkbenchDirectoryPicker.ts`（81 行） | **3724 → 2814（P6-1 +9、P6-2 -220、P6-3 -683、P6-4 -16）** | **2267 → 1389（P6-1 +7、P6-2 -184、P6-3 -684、P6-4 -17）** | ✅ **P6 全部完成（P6-1/P6-2/P6-3/P6-4）**；P6-4 收尾把 `WorkbenchApp` 体内直接 `useState(` **清零** |
| **P6-1** | 导航 + 忙碌标志 | `hooks/useWorkbenchNavigation.ts`（43 行，`view`/`setView`）+ `hooks/useWorkbenchBusy.ts`（39 行，`busy`/`setBusy`，**跨域界面瞬态**） | **3724 → 3733（+9，本轮唯一净增）** | **2267 → 2274（+7）** | ✅ **完成**；**无独立出口自检/反向变异脚本**（无 `d17-p6a-*`），覆盖由 p3b §7（57 项）+ 后续三批 §2 的 6 条 owner 断言承担 |
| **P6-2** | 快速录入域 | `hooks/useWorkbenchQuickIntake.ts`（364 行）+ 纯模块 `src/client/intakeHelpers.ts`（66 行，与 AI 会话域共用） | **3733 → 3513（-220）** | **2274 → 2090（-184，L171–2260）** | ✅ **完成**（p6b 153 项、mutate 13/13；quick-workspace 探针 13/15 → **16/16** 并销账删除 `KNOWN_PROBE_DEBT` 一条） |
| **P6-3** | AI 会话域 | `hooks/useWorkbenchAISessions.ts`（914 行：12 项 state + `promptResolveRef` + 9 个动作 + 新增 `resetClarifyPicker()`） | **3513 → 2830（-683）** | **2090 → 1406（-684，L172–1577）** | ✅ **完成**（p6c 198 项、mutate 13/13） |
| **P6-4** | 目录选择域（**P6 收官**） | `hooks/useWorkbenchDirectoryPicker.ts`（81 行，零入参：5 项 state + `openFor`/`loadDirPickerDir`/两个 setter） | **2830 → 2814（-16）** | **1406 → 1389（-17，L173–1561）** | ✅ **完成**（p6d 94 项、mutate 13/13）；**ADR-0008 结构硬门「体内直接 `useState` = 0」达成**；距 ≤900 护栏还差 **489** 行 |
| P7 | 入口组合与总回归（3 个子批） | **P7-1 ✅** 最后 6 处请求归域进 `hooks/useTaskData.ts` / `hooks/useWorkbenchSettings.ts`；**P7-2 ✅** 四段 JSX 进 `app/WorkbenchHeader.tsx`(44) / `app/WorkbenchOverlays.tsx`(195) / `app/WorkbenchBody.tsx`(224) / `app/WorkbenchDialogs.tsx`(358) + 装配束 `app/assembly.ts`(91)；**P7-3 ✅** 死 import / 死解构清理（**`WorkbenchApp` 仍在 `src/client/index.tsx`，未移入 `app/WorkbenchApp.tsx`**） | **2814 → 1972（P7-1 -64、P7-2 -648、P7-3 -130）** | **1389 → 631（P7-1 -64、P7-2 -652、P7-3 -42）** | ✅ **完成（P7-1/P7-2/P7-3）**；ADR-0008 结构硬门全部达成（体内 0 state / 0 业务请求 / 0 定时器、单个顶层块 ≤80 行）；行数护栏按 ADR 校准为 **≤650**（实测 631）；设计 §2.1 的 ≤600 是努力目标，**未达成（631，差 31）** |

## P1 明细（知识域）

| 职责 | 新 owner | 旧实现处理 | 扫描范围 | 变异锚点 |
|---|---|---|---|---|
| 11 项知识状态 | `hooks/useKnowledge.ts` | 入口声明区 412–428 删除（-17 行） | 入口必须 0 命中（`d17-p1-exit-check.py`） | — |
| `readKnowledgeFilters` / `writeKnowledgeFilters` / `KNOWLEDGE_FILTER_STORAGE_KEY` | `hooks/useKnowledge.ts` | 入口顶层两函数 + 常量删除 | 存储键字面量**全客户端恰好 1 处** | — |
| `loadKnowledge` + 拉取 effect | `useKnowledge#reload` | 入口 593–600 删除（-8 行） | `test/listViewWiring.test.mjs` 指向 hook | — |
| 文件选择五件套（`summarizeLocalDoc`/`loadFilePickerDir`/`openFilePicker`/`pickLocalFile`/`pickAndSummarizeLocalFile`） | `useKnowledge#summarize/loadDir/openPicker/pickFile/pickAndSummarize` | 入口 1567–1620 删除（-54 行） | 入口 0 命中 | — |
| `openKnowledgeFile` | `useKnowledge#openKnowledgeFile` | 入口 1665–1678 删除（-19 行，含残留 `catch/finally` 与孤立 `}`） | 入口 0 命中 | — |
| 派生 `knowledgeDicts` / `knowledgePage` / `updateKnowledgeFilters` + 两条 effect | hook 内 | 入口 1962–2004 删除（-43 行） | `test/listViewWiring.test.mjs`：`buildListPage<ContentItem>` 与 `items: entries.map(toContentItem)` | **M-P1-1**：`items: entries` → 该判据红 |
| 分类对账 effect | hook 内 | 随派生一起搬 | `setFilters` **全客户端恰好 2 处** + `if (fixed !== null) setFilters(fixed)` | **M-P1-2**：effect 里追加 `setFilters({...(fixed ?? filters), page: 0})` → "状态只有一个入口"判据红 |
| 左侧视图（工具栏/列表/分页/空态） | `views/KnowledgeListView.tsx` | 入口 43 行 → 1 行 | `KnowledgeToolbar` **全客户端恰好 1 处装配** | — |
| 右侧详情（草稿表单→详情卡→空态） | `views/KnowledgeDetailPane.tsx` | 入口三元表达式删除 | 入口恰好 1 处装配 | — |
| 文件模式 `LocalDocModal` | 随 `KnowledgeListView` | 入口那份删除 | `test/workspacePickerWiring.test.mjs`：`<LocalDocModal>` **全客户端恰好 2 处**（知识视图 file + 入口 dir） | — |

### P1 需要同步迁移的既有判据（本批已改）

| 文件 | 改了什么 |
|---|---|
| `test/listViewWiring.test.mjs` | 8 条断言从 `index.tsx` 改指 `hooks/useKnowledge.ts` / `views/KnowledgeListView.tsx`；"恰好 2 处 setFilters"升级为**全客户端**；新增 `KnowledgeToolbar` 全客户端恰好 1 处 |
| `test/workspacePickerWiring.test.mjs` | "入口两处 `LocalDocModal`"改为**全客户端**两处 + 分别断言两个 owner 文件各一处 |

## P2 明细（点子域）

| 职责 | 新 owner | 旧实现处理 | 扫描范围 | 变异锚点 |
|---|---|---|---|---|
| 12 项点子状态（`ideas`/`ideaClusters`/`ideaTab`/`ideaQuery`/`ideaKind`/`selectedIdeaIds`/`selectedIdea`/`selectedCluster`/`ideaForm`/`ideaEditId`/`folderForm`/`ideaRefreshKey`） | `hooks/useIdeas.ts` | 入口声明区 14 行 → 1 行注释 | 入口 0 命中 22 个实现名（`d17-p2-exit-check.py`） | — |
| `loadIdeas` + 拉取 effect（门控 `view === 'ideas'`） | `useIdeas#load` + 内部 `useEffect` | 入口删除（-14 行） | 入口 0 命中 | — |
| 派生 `ideaCardItems` | `useIdeas#cardItems` | 入口删除（-5 行） | `test/listViewWiring.test.mjs`：hook 里 `const cardItems = useMemo<IdeaCardItem[]>` + `clusterIds: clusters.filter(`；**新增负向**：入口不得再出现 `<IdeaCardGrid` | **M-P2-2**（见下） |
| 派生 `unfiledIdeas` | `useIdeas#unfiledIdeas` | 入口删除 | 入口 0 命中 | — |
| 7 个动作（`refreshIdeas`/`saveFolder`/`deleteFolder`/`fileIdeaInto`/`unfileIdeaFrom`/`mergeFolderInto`/`ideaCardItems` 相关） | `useIdeas#actions.*` | 入口删除（-86 行） | hook 里 15 个动作各**唯一实现** | — |
| 左侧视图（页签/搜索/AI 按钮/文件夹网格/卡片网格/两种空态） | `views/IdeasListView.tsx`（109 行） | 入口 96 行 → 1 行装配 | 入口恰好 1 处 `<IdeasListView>`；视图不发 HTTP、不自建 state/effect | — |
| 右侧详情（表单/点子王卡片/点子卡片/空态） | `views/IdeasDetailPane.tsx`（105 行） | 入口 77 行 → 1 行装配 | 入口恰好 1 处 `<IdeasDetailPane>` | — |
| 文件夹新建/改名弹窗 | 随 `IdeasListView` 的 `model.folderForm` + 入口装配 | 入口删除（-32 行） | 入口 0 命中 `folderForm` | — |
| 提示词里的点子全集（`idea_association` / `idea_brainstorm`） | `useIdeas#allIdeas`（只读快照） | 入口两处 `ideas.filter(...)` 改读 `ideasAll` | 入口 `const ideasAll = ideas.allIdeas` 在位 | — |

### P2 与拆分前的逐条语义对照（**这一批的真风险点**）

搬 JSX 本身没有风险，风险在**两个调用点用了同一个名字但语义不同**。本批用
`git show HEAD:src/client/index.tsx` 逐段对照（HEAD = 5725 行；对照工具 `scripts/lib/d17-head-ideas.py`），抓到并修回两处偏差：

| 偏差 | 拆分前（HEAD） | P2 第一版（错） | 现在 |
|---|---|---|---|
| 页签切换的清选择范围 | `:3433-3435` **不对称**：全部/未归类 → 只清点子王；文件夹 → 只清点子 | 三个按钮都清**两份** | 收进 `useIdeas#changeTab` 单一所有者：`next === 'clusters' ? 清点子 : 清点子王`；视图只调 `model.setTab(x)` |
| 两个"点开点子" | `:3499-3503` 卡片网格：`find` + **找不到就早退（连 selectedCluster 都不清）**；`:3645` 成员行：**直接用手上的对象**（成员可能不在筛选出的 `ideas` 里） | 合并成一个 `openIdea(id)`：先清点子王再 `find ?? prev`（**两边都不忠实**） | 拆成 `openIdeaById(id)`（卡片网格）与 `openIdea(idea)`（成员行） |

其余逐条核对**语义一致**（不改）：`saveFolder`/`deleteFolder`/`fileIdeaInto`/`unfileIdeaFrom`/`mergeFolderInto` 的请求形状与 notice 文案、
`deleteFolder` 的 `selectedCluster?.id === id` 判定（函数式写法同义）、`cardItems`/`unfiledIdeas` 派生、`loadIdeas` 门控与依赖数组、
表单 `onSubmit` 的 `title.trim() === ''` 早退与 tags 切分（`.slice(0, 20)`）、删除点子的 `window.confirm('删除这个点子？')`、
`startEdit` 的初始草稿、文件夹弹窗整块（`min(460px, 94vw)` / Enter 提交 / 文案）。

> 顺带修掉的**真 bug（非本次搬迁引入，本次才暴露）**：`index.tsx` 里一行孤立的 `/**` 没有配对的 `*/`，
> 把后面约 40 行真实代码整段注释掉（`todayStart`/`todayEnd`/`todayPlan` 等），typecheck 报 29 条 `TS2304`。
> 排查工具 `scripts/lib/d17-comment-scan.py`，修复脚本 `scripts/lib/d17-fix-stray-comment.py`。
> **教训：出现成片的 `Cannot find name` 先查注释配平 —— 报错指向被吞掉的变量名，不是注释本身。**

### P2 需要同步迁移的既有判据（本批已改）

| 文件 | 改了什么 |
|---|---|
| `test/listViewWiring.test.mjs` | "点子卡片网格给了属于哪些文件夹"从只读 `index.tsx` 改指 `hooks/useIdeas.ts` + `views/IdeasListView.tsx`，并**新增负向断言**"入口不得再直接装配卡片网格"；**新增 1 条**"页签只清另一个 + 两种点开各有的语义"（全客户端 0 处 `clearSelection`） |

> **P2 不需要任何变异探针重锚**：实测跑齐引用 `src/client/index.tsx` 的四个探针 ——
> `probe-listview-mutations` **17/17 全红**、`probe-capacity-mutations` **20/20 全红**；
> `probe-quick-workspace-mutations`（M6/M14 变异点没匹配上）与 `probe-model-picker-notify-mutations`（B7/B8/B10）
> 的失效欠账是**既有**的、已在 `release-preflight.mjs` 的 `KNOWN_PROBE_DEBT` 登记，属 P6 职责。
> ⚠️ 踩坑：探针运行期间源码会被临时变异 —— **不要一边跑探针一边跑测试**（本批撞到一次假红：`styles.ts` 的 z-index 被临时改小）。


## P3-1 明细（任务列表域）

owner：`src/client/hooks/useTaskListModel.ts`（新建）+ `src/client/views/TaskListView.tsx`（新建）。
入口 `const taskList = useTaskListModel({ tasks, dictOf })` 落在原 state 声明处（原 L1843），**保持 hook 调用次序**。

| 职责 | 拆分前位置（入口） | 新 owner | 说明 |
|---|---|---|---|
| 7 个 state：`archivedTasks` `archivedMode` `taskFilter`→`filter` `taskSortKey`→`sortKey` `taskSortDir`→`sortDir` `openFilter` `expanded` | L1844–1850 | `useTaskListModel` | `filter` 初值改用共享 `EMPTY_TASK_FILTER`（原来内联一份字面量） |
| 展开集合落盘 effect | L1853–1855 | `useTaskListModel` | 存储键提为模块常量 `TREE_EXPANDED_STORAGE_KEY`（原来是入口内联字面量） |
| `toggleExpanded` | L1856 | `useTaskListModel.actions.toggleExpanded` | 新增 `clearExpanded`（供跨域 `collapseAll` 用） |
| `toggleTodayExpanded` / `toggleCalendarExpanded` | L1857–1858 | **不搬**（日期域） | P3-1 只把 `expanded` 的清理点交回装配层 |
| `collapseAll` | L1859 | **入口**（跨域装配） | 改成 `taskList.actions.clearExpanded()` + 两个日期域 setter |
| `priorityWeights` | L1861 | `useTaskListModel`（`useMemo(..., [dictOf])`） | |
| `taskSorter` | L1863 | `useTaskListModel` | `createTaskSorter(sortKey, sortDir, priorityWeights)` |
| `visibleTaskTree` | L1864–1867 | `useTaskListModel.visibleTree` | 归档分支也从这里走（`archivedMode ? archivedTasks : tasks`） |
| `taskTypeDicts` / `taskTypeTabs` | L1872 / L1873–1877 | `useTaskListModel.typeDicts` / `typeTabs` | 由 `buildTabs(dictOf('type'), counts, { includeOther: false })` 算 |
| 左栏列表 JSX（搜索/筛选/排序/类型页签/归档/树/空态） | L3066–3136（96 行） | `TaskListView`（108 行，纯展示） | 一行接线：`<TaskListView model={taskList} dictOf={dictOf} dicts={dicts} selectedId={selected?.task.id} pending={pendingMap} childrenOf={childrenOf} onOpen={openTask} />` |
| 归档集合的跨域读取 | 容量 memo 的 `tasks: [...tasks, ...archivedTasks]` | 入口读只读快照 `taskList.archivedTasks` | 可写 state 仍只有 hook 一份 |
| 任务详情「恢复任务」 | `setArchivedMode(false)` | 入口调 `taskList.actions.setArchivedMode(false)` | 详情本体归 P3-2 |

### P3-1 与拆分前的语义对照（**唯一一处必须留意的行为面**）
- 归档切换副作用**不许**写进 setState 更新函数：原文是 `const next = !archivedMode; setArchivedMode(next); if (next) { void api(...) }`，
  语义逐字保留（写进 `setArchivedMode((prev) => …)` 会在 React 重调更新函数时重复发请求）。已加会失败的判据。
- `visibleTaskTree` 的归档分支：拆分前用 `archivedMode ? archivedTasks : tasks` 作为树根，P3-1 逐字保留（不是"新语义"）。

### P3-1 需要同步迁移的既有判据（本批已改）
| 文件 | 改动 | 性质 |
|---|---|---|
| `test/listViewWiring.test.mjs` | 新增 owner 常量 `taskListHookSource` / `taskListViewSource`；3 条断言改指新 owner（Tab 组件共用、类型升为 Tab、条数由 `countTasksByType` 给）；**新增 2 条**：①归档副作用不许进 setState 更新函数 ②视图是纯展示 + 唯一口径常量不许复制（空筛选字面量全客户端只剩 `taskFilterSort.ts` 一份、存储键 1 处） | 迁移 + 收紧（不是放宽） |
| `test/capacityWiring.test.mjs` | 用例「容量 memo 喂的是全量任务列表」断言改 `tasks: [...tasks, ...taskList.archivedTasks]` | 迁移 |
| `scripts/repro/probe-capacity-mutations.mjs` | **I1 变异锚点重锚**：`[tasks, archivedTasks, …]` → `[tasks, taskList.archivedTasks, …]` | 必做（stale 会被 `judgeProbes` 无条件硬红） |

### P3-1 探针实测
`probe-capacity-mutations` 重锚后 **20/20 全红、退出 0**；`probe-listview-mutations` 的 `INDEX` 是死常量、不锚本批搬走的代码。

## P3-2 明细（任务详情面板）

owner：`src/client/hooks/useTaskDetailModel.ts`（新建）+ `src/client/views/TaskDetailPane.tsx`（新建，430 行）
+ `src/client/app/contracts.ts`（新建，跨域类型契约）。入口 `const detail = useTaskDetailModel()` 落在原 6 个 state 声明处（原 L227–232）。

| 职责 | 拆分前位置（入口） | 新 owner | 说明 |
|---|---|---|---|
| 6 个 state：`detailTab` `sessionPickerOpen` `sessionPickerRole` `sessionPickerQuery` `sessionPickerBusy` `eventsExpanded` | L227–232 | `useTaskDetailModel` | 全用 `Dispatch<SetStateAction<T>>` 透出（面板里 `setEventsExpanded((v) => !v)` 用更新函数形式，收窄会改行为） |
| 任务详情 JSX（L3042 `: (` … L3374 `)}`，329 行 body） | L3043–3372 | `views/TaskDetailPane.tsx` | 逐字搬迁、统一左移 14 空格；props **逐个解构成同名局部 const**，所以 JSX 零改名 |
| `selected === null` 空态（入口 L3040–3041） | L3040–3041 | `TaskDetailPane` 自己判 | 三路分派仍留入口；空态文案入口无副本 |
| `openTask` / `openTaskById` 里的 `setDetailTab('desc')` + `setEventsExpanded(false)` | L812-813 / L819-820 | `useTaskDetailModel.actions.resetDetailView()` | **同一语义原先两份实现**，本批收成一个动作 |
| 面板「取消」与 `linkExistingSession` 成功后的 `setSessionPickerOpen(false)` + `setSessionPickerQuery('')` | L3254 / L918-919 | `actions.closeSessionPicker()` | 同上，收成一个动作 |
| 面板「展开选择器」的 `setSessionPickerQuery('')` + `setSessionPickerOpen(true)` | L3222 | `actions.openSessionPicker()` | 同上 |
| 恢复任务触发的 `void api(.../restore, {method:'POST'})` | 详情 JSX 内联 | **入口** `const restoreTask`（注入 `onRestoreTask`） | 设计 §3：`views/` 不许发 HTTP |
| 新建子任务的 `void api('/api/workbench/tasks', {...})` | 详情 JSX 内联 | **入口** `const createSubtask`（注入 `onCreateSubtask`） | 组件只交 `FormData` 与父任务；payload 字段与顺序逐字搬 |
| `aiSessionUsable(runtime, sid)`（入口外的模块级函数） | 详情 JSX 内联 2 处 | 注入 `isSessionUsable` | 复用入口 L2719 既有注入写法，**不把模块级函数搬进 hook** |
| 视图联合类型 / 编辑草稿匿名类型 | L215 / L226 | `app/contracts.ts` 的 `WorkbenchView` / `TaskEditDraft` | 入口改用契约类型，消除两份匿名类型 |

### P3-2 与拆分前的语义对照
搬 JSX 用的是**逐字搬迁**（只做 6 处等价写法替换，见上表右列），所以没有行为面重写。唯一需要说明的是那 6 处替换：
它们都是**"同一语义的两连调用/内联请求"收成一处**（§0），而不是新语义；每处都写了会失败的判据（`taskDetailWiring.test.mjs` 第 4 条 + P3-2 出口自检第 6 组）。
`selected === null` 的空态**随组件搬走**是唯一一处"入口行减少但语义不变"的判定移动（入口不再判 `selected === null`）。

### P3-2 需要同步迁移的既有判据（本批已改）
| 文件 | 改动 | 性质 |
|---|---|---|
| `test/progressWiring.test.mjs` | 「TaskProgress 独立组件存在」改指 `views/TaskDetailPane.tsx`，**新增负向**：入口不得再出现 `<TaskProgress` | 迁移 + 收紧 |
| `test/capacityWiring.test.mjs` | AX-C07 的「编辑框初值」改指 `views/TaskDetailPane.tsx`，**新增负向**：该文件不得再出现 `estimatedMinutes: selected.task.estimatedMinutes`；其余三条（保存 payload / 就地校验 / 乐观更新）仍在入口 | 迁移 + 收紧 |
| **`test/taskDetailWiring.test.mjs`（新增 5 条）** | ①6 项 state 全客户端只在 hook 创建（`countInClient` 命中分布断言）②视图纯展示（无 `api|fetch`/state/effect/派生、不 import 入口，且两处请求本体在装配层）③入口只留三路分派、空态文案无副本 ④三个动作只有一份实现、入口无裸 `setDetailTab` ⑤契约类型不内联 | 新建判据 |
| `scripts/repro/probe-capacity-mutations.mjs` | **I3 变异锚点重锚**到 `views/TaskDetailPane.tsx`（新增常量 `TASK_DETAIL_PANE`） | 必做（stale 会被 `judgeProbes` 无条件硬红） |

### P3-2 探针实测
`probe-capacity-mutations` 重锚后 **20/20 全红、退出 0**（I1/I3 均在重锚点变红）；其余三个引用入口的探针均不锚本批搬走的代码
（`probe-listview-mutations` 的 `INDEX` 是死常量；model-picker / quick-workspace 的失效项是既有欠账，属 P6）。

## P3-3 明细（任务表单弹窗）

owner：`src/client/hooks/useTaskForms.ts`（新建，101 行）+ `src/client/views/TaskFormModal.tsx`（新建，215 行）。
入口 `const forms = useTaskForms()` 落在原 4 处 state 声明处（原 L227 / L228 / L229 / L421）。

| 职责 | 拆分前位置（入口） | 新 owner | 说明 |
|---|---|---|---|
| 4 个 state：`showForm` / `subtaskParent` / `editDraft` / `formWorkspace` | L227 / L228 / L229 / L421 | `useTaskForms` | 返回名与 state 同名；内部 useCallback 名加 `Action` 后缀再映射回来 |
| 表单清空 effect `if (showForm) setFormWorkspace('')` | L2321-2322 | `useTaskForms` 内部 | 与 4 项 state 同文件，否则"打开表单就清工作区"这条语义跨文件散开 |
| 新建任务弹窗 JSX（48 行） | L3302–3349 | `views/TaskFormModal.tsx#TaskCreateModal` | 逐字搬迁；**非受控**（提交读 FormData）；`open` prop + `if (!open) return null` 等价原 `{showForm && …}` |
| 编辑任务弹窗 JSX（70 行） | L3351–3420 | `views/TaskFormModal.tsx#TaskEditModal` | 逐字搬迁；**受控**，12 处内联 null-safe 展开换成 `onPatchDraft({…})` |
| 12 处 `setEditDraft((prev) => prev === null ? prev : { ...prev, X })` | 编辑弹窗内联 | `useTaskForms#patchDraft(patch: Partial<TaskEditDraft>)` | 收成一处，语义与逐字展开相同 |
| 两个请求本体：`createTask`(L1809) / `saveEditDraft`(L1755) | 入口 | **仍留入口**，注入 `onSubmit` / `onSave` | 设计 §3+§5：`views/` 不许发 HTTP；payload 字段与顺序逐字不动（`capacityWiring` AX-C07/I2/I4/I5 锚的就是这三段） |
| `TaskDetailPane` 的 3 个 setter prop | 入口 L3071 一带 | 换成**意图** prop | `editing={editDraft !== null}` / `onOpenEdit` / `onAddSubtask` / `onCancelSubtask`（视图不再持有 setter） |
| 工具栏与空态「新建」的开关语义 | L2645 / L2986 | `useTaskForms#toggleCreate` | **必须与 `closeCreate` 分开**（模式 3：同名不同语义不许合并） |
| 换任务时关掉编辑框与子任务表单 | 入口 L781 effect 的两连 setState | `useTaskForms#dismissOnTaskChange` | ⚠️ effect 依赖必须写这个稳定引用；写 `forms.actions` 会每帧触发，编辑框刚开就被关 |

### P3-3 与拆分前的语义对照
同样只有"同一语义多处写成一处"（§0）这一种替换，没有行为面重写：
`patchDraft` 收 12 处、`toggleCreate`/`closeCreate` 收 3 个调用点、`dismissOnTaskChange` 收 1 条 effect 的两连 setState、
`setSubtaskParent` 收详情面板两个按钮 + `createSubtask` 成功后的清空（3 处）。
唯一"移动的判定"是 `open={forms.showForm}` —— 原先入口的 `{showForm && (…)}` 短路守卫改成组件内 `if (!open) return null`（等价）。
`views/TaskFormModal.tsx` 里两个组件**故意不合并**：新建是"非受控 + FormData → 一次 POST"，编辑是"受控草稿 + 12 个小改动 + 保存按钮"，不是同一种交互。

### P3-3 需要同步迁移的既有判据（本批已改）
| 文件 | 改动 | 性质 |
|---|---|---|
| `test/taskDetailWiring.test.mjs` | `:105` 编辑草稿类型断言改指 `hooks/useTaskForms.ts`（新增 `formsHookSource` 常量）；其余 4 条不受影响 | 迁移 |
| `test/workspacePickerWiring.test.mjs` | test #1 的 `<WorkspacePicker` 计数 3 改用 `assertClientCount` 做全客户端断言，并追加"视图里恰好 2 处"；test #5 三条分别改指 `views/TaskFormModal.tsx`（`name="workspacePath"`）与 `hooks/useTaskForms.ts`（`formWorkspace` state + 表单清空 effect）。`openDirPicker('quick'/'form'/'edit')` 三处与 `applyWorkspaceDir` **仍在入口**，未改 | 迁移 |
| `scripts/lib/d17-p3b-exit-check.py` | `:128` 的编辑草稿类型断言改指 `hooks/useTaskForms.ts` | 迁移 |
| **`scripts/lib/d17-p3c-exit-check.py`（新增，7 节 67 项）** | ①入口不再自持 4 项 state、不裸用 5 个 setter、`const forms` 与解构各 1 处、effect 依赖是 `dismissOnTaskChange` ②四项 state 全客户端**只有 hook 创建**（`countInClient` 命中分布断言）③两个弹窗各 1 处装配 + 守卫在位 + 入口无表单字段副本 ④视图纯度（不发 HTTP、无 state/effect/派生、不 import 入口、不出现 `openDirPicker`）⑤两组件不合并 + `onPatchDraft({` 恰好 12 + `toggleCreate`/`closeCreate` 的函数体形状 ⑥模式 5 请求本体全在入口 ⑦结构指纹 | 新建判据 |
| **`scripts/lib/d17-mutate-p3c.py`（新增）** | 7 条变异（视图重新内联 api / 视图自建 state / `closeCreate` 写成开关 / 入口收回 `formWorkspace` state / effect 依赖写成 `forms.actions` / 表单字段改名 / 草稿类型退化）**7/7 全红、退出 0**，且还原后 sha256 一致、基线全绿 | 新建变异 |

### P3-3 探针实测
**本批不需要重锚**，已逐条实测：`probe-capacity-mutations` **20/20 全红、退出 0**（I2/I4/I5 锚的 `saveEditDraft` 本体仍在入口；
I3 锚的 `TASK_DETAIL_PANE` = `views/TaskDetailPane.tsx` 本批未改）；`probe-listview-mutations` 17/17、
知识域两探针 19/19 与 46/46 均全红。
`probe-quick-workspace-mutations`（13/15）与 `probe-model-picker-notify-mutations`（7/10）的失效项
**在 HEAD 版就已匹配不上锚点**（用 `git show HEAD:src/client/index.tsx` 对照确认：M6 锚 `setQuickWorkspace\(e\.target\.value\)`、
M14 锚 `{quickWorkspaceSource === 'last-manual' && quickWorkspace.trim() !== '' && !quickWorkspaceTouched && (` 在 HEAD 里都不存在）
⇒ 属既有 KNOWN_PROBE_DEBT，归 P6，**不是 P3-3 引入的**。

### P3-3 度量与验证
入口 `src/client/index.tsx` **4754 → 4675（-79）**；`WorkbenchApp` 第 219–3422 行、**3285 → 3204（-81）**（区间外 +2 = 两条新 import，正好对上）。
新文件 `views/TaskFormModal.tsx` 215 行、`hooks/useTaskForms.ts` 101 行；`views/TaskDetailPane.tsx` 430 → 436（props 换成语义化 4 项）。
五个出口自检 ✔ 计数：P1 32 / P2 49 / P3a 47 / P3b 56 / **P3c 67**，全部退出 0。
`pnpm test` = **992 / 991 / 1**（唯一失败仍是既有 `db migrations, dictionaries and task tree` 的 Windows `rmSync` EPERM），与 P3-2 后同数 ⇒ **零回归**。

## P3-4 明细（任务数据域）

owner：`src/client/hooks/useTaskData.ts`（新建，**273 行**）。
入口 `const data = useTaskData({ onError: setError, onNotice: setNotice })` 落在 `error`/`notice` **之后**
（L363-364 之后）—— 注入回调要引用它们，而 `const` 没有提升，所以本域 hook **不能**像 P3-1/P3-2/P3-3 那样
摆在原 state 声明处（原 L221-228）。实测 L229–L360 之间没有任何代码引用本域符号，故无 TDZ 风险。

| 职责 | 拆分前位置（入口） | 新 owner | 说明 |
|---|---|---|---|
| 5 个 state：`bootstrap` / `tasks` / `pendingCompletions` / `selected` / `taskKnowledge` | L221 / L222 / L227 / L228 / L430 | `useTaskData` | 设计 §4.1 第 100 行；返回名与 state 同名，入口仍解构出局部名，故既有判据/探针锚的原文**一字未动** |
| `selectedRef`（选中 ID 的"最新值镜像"） | L482 | `useTaskData` | 设计 §4.1 第 119 行：**只镜像 ID**，不是第二份详情数据 |
| 只读派生 `dicts` / `dictOf` / `pendingMap` / `childrenIndex` / `childrenOf` | L484 / L485 / L493 / L500-509 / L510 | `useTaskData` | 设计 §4.1 第 124 行；`pendingMap` 的"`null` ≠ 空 Map"与 `childrenIndex` 的"只算直接子任务（ADR 0004）、一次遍历不是 O(n²)"两条注释原文一并搬入 |
| `refresh`（整块） | L512–535 | `useTaskData#refresh` | 设计 §4.1 第 149 行：**不能拆成多个独立重复请求** —— 一次 `Promise.all` 拉 bootstrap + 列表 + 待验收，再按最新选中 ID 补详情/事件/复盘/关联知识 |
| `loadTaskKnowledge` | L798–801 | `useTaskData#loadTaskKnowledge` | 入口**不再解构**它（搬迁区间外 0 处引用） |
| `loadTaskDetail` + 那段 2026-10-01 BUG 约定注释 | L802–825 | `useTaskData#loadTaskDetail` | 设计 §4.1 第 147 行：**只加载、不导航**；末尾 `setError(...)` 改成注入的 `onError(...)` |
| `patchTask` / `completePlanTask` | L837–843 | `useTaskData` 同名动作 | 逐字搬迁 |
| `saveProgress`（含"刻意不用 useCallback"注释） | L844–863 | `useTaskData#saveProgress` | 刷新详情走 `loadTaskDetail`，**不许**走 `openTaskById`（设计 §4.2 第 166/167 行反例） |
| `completeTaskFromProgress` / `deferPlanTask` | L864–891 | `useTaskData` 同名动作 | 两处 `setNotice(...)` 改成注入的 `onNotice(...)` |
| `openTask` / `openTaskById` | L773–782 | **仍留入口**（装配层） | 设计 §4.1 第 148 行定案：`openTaskById` 首句是 `setView('list')`（导航域），由装配层组合 TaskData 与 Navigation；入口这两条函数体**文本一字未动**（`loadTaskDetail` 现在是解构来的同名函数） |
| `setTasks` 写入口（归档后移除 / 编辑乐观更新） | L1636 / L1700 | `useTaskData#setTasks` | 刻意保留 `Dispatch<SetStateAction<Task[]>>` **原形**：两处都用更新函数形式，收窄成快照形会丢并发更新（设计 §5） |
| `setSelected(null); selectedRef.current = null` 两连写（归档成功 + not found 自愈） | L1639 / L1647 | `useTaskData#clearSelectedTask` | 原先两处各写一遍；漏清 ref 会让下次 `refresh` 去拉一条已不存在的详情 |
| `selectedRef.current` 三处读（提醒 ack / 加提醒 / 关联会话） | L795 一带 | `useTaskData#currentTaskId()` | 异步回调里读"最新值镜像"的唯一口径 |
| `restoreTask` / `createSubtask` | 入口 | **仍留入口** | 两者都跨两个以上域（任务域 + 列表域/表单域 + 反馈域），按设计 §4.1 第 148 行"跨域组合归装配层"；入口里那条"P3-4 时会搬进 `useTaskData`"的**过期前向承诺注释已删除并改成决定留在这里的理由** |

### P3-4 与拆分前的语义对照
仍然只有"同一语义多处写成一处"（§0）这一种替换，没有行为面重写：
`clearSelectedTask` 收 2 处两连写、`currentTaskId()` 收 3 处 `selectedRef.current` 读、`setTasks` 原语保留 2 处写。
唯一"移动的判定"是反馈通道：`loadTaskDetail` 的 `setError(...)` 与两处 `setNotice(...)` 改成入口注入的
`onError` / `onNotice`（设计 §5「跨域靠装配层注入类型化回调」—— 与 P1/P2 的 `useKnowledge`/`useIdeas` 走同一条路）。
`refresh` 是本批**最大的一整块**（26 处引用横跨知识域/点子域/任务域/日期域/设置域），但它仍然只是一个函数、
一个 `useCallback` —— 拆开会正好落进设计 §4.2 第 166 行的反例。
⚠️ 本域 hook 与 P3-1/P3-2/P3-3 的 hook 不同：它**必须**放在反馈域 state 之后（注入回调 + `const` 无提升），
这是本批唯一一处"落点不由原声明位置决定"的地方。

### P3-4 需要同步迁移的既有判据（本批已改）
| 文件 | 改动 | 性质 |
|---|---|---|
| `test/progressWiring.test.mjs` | 头部新增 `taskDataHook` 常量；`sources` 数组加入它；`:148/:149`（`tasks/pending-completions`、`pendingCompletionMap(`）与 `:156/:157`（`progressPercent: percent`、`completeTaskFromProgress`）与 `:167/:168`（`window.confirm(question)`、`级联完成`）改指 hook；`:152` 反向断言补一条对 hook 的 `doesNotMatch`；`:180-193` 红线测试**整体重写**（新增局部 `sliceFrom(code, start, end)`，切片前先 `assert.notEqual(from, -1)`，四段切片分别钉 `loadTaskDetail` 无 `setView(` / `saveProgress` 与 `completeTaskFromProgress` 走 `loadTaskDetail` 且不调 `openTaskById(` / 入口 `openTaskById` 有 `setView('list')`） | 迁移 + 补强 |
| **`scripts/lib/d17-p3d-exit-check.py`（新增，7 节 102 项）** | ①入口不再自建本域任何东西（5 项 state、`selectedRef`、5 个派生、8 个动作、5 个 setter 名、`pendingCompletionMap` 全部 0 命中）+ `const data = useTaskData({ onError: setError, onNotice: setNotice })` 恰好 1 处 + 解构行原文 + 9 个动作名 ②创建者唯一性（`git ls-files -co --exclude-standard src/client` 枚举；有歧义的 `selected`/`dicts`/`dictOf`/`refresh` 用**完整声明原文**匹配，避免与别的域同名假红）③设计 §4.1 红线四条 ④`refresh` 整块且未拆（体内恰好 2 处 `Promise.all(`、5 个端点字面量、`pending-completions` 只 1 处）⑤跨域注入（hook 内裸 `setError`/`setNotice`/`setView`/`resetDetailView`/`setDetailTab` 各 0；`onNotice(` 恰好 2 处）⑥装配层原语（`setTasks` 保留 `Dispatch<SetStateAction<Task[]>>`；入口 2 处 `clearSelectedTask()`；入口 3 处 `currentTaskId()`；入口 strip 注释后 `selectedRef` 0 处）⑦结构指纹（视图 props 装配、`useTaskListModel({ tasks, dictOf })` 与 `tasks: [...tasks, ...taskList.archivedTasks]` 与 `{ ...task, estimatedMinutes, allDay: editDraft.allDay }` 三条**既有判据/探针锚**仍在入口、`restoreTask`/`createSubtask` 仍在入口、hook 内含 BUG 注释与 ADR 0004 原文） | 新建判据 |
| **`scripts/lib/d17-mutate-p3d.py`（新增）** | 8 条变异（`loadTaskDetail` 带导航 / `refresh` 少拉待验收端点 / 入口收回 `selected` state / hook 退化回裸 `setError` / `setTasks` 收窄 / 入口 `openTaskById` 去掉 `setView('list')` / `clearSelectedTask` 漏清 ref / 完成任务后改走 `openTaskById`）**8/8 全红、退出 0**，且还原后 sha256 一致、基线全绿 | 新建变异 |

### P3-4 探针实测
**本批不需要重锚**，已逐条实测：`probe-capacity-mutations` **20/20 全红、退出 0** ——
子代理曾预警 I1（容量 memo 依赖数组里的 `tasks`）与 I5（`setTasks((prev) => prev.map(...))`）会因搬 state 而
"找不到片段"，但本批**刻意保留了入口的局部名 `tasks` 与那两段更新函数原文**（只在 hook 里换 owner），
所以两条锚点仍精确命中；I3 锚 `views/TaskDetailPane.tsx`、I2/I4 锚入口 `saveEditDraft` 本体，本批都未改。
`probe-listview-mutations` 17/17、知识域两探针 19/19 与 46/46 均全红。
`probe-quick-workspace-mutations`（13/15）与 `probe-model-picker-notify-mutations`（7/10）的失效项
**在 HEAD 版就已匹配不上锚点** ⇒ 属既有 KNOWN_PROBE_DEBT，归 P6，**不是 P3-4 引入的**。

### P3-4 度量与验证
入口 `src/client/index.tsx` **4675 → 4571（-104）**；`WorkbenchApp` 第 **218–3318** 行、**3204 → 3101（-103）**
（区间外 1470 行，-2：新增 `useTaskData` import 一行、删掉 `pendingCompletionMap` import 一行）。
新文件 `hooks/useTaskData.ts` **273 行**。到 ≤600 行还差 **2501** 行（P4–P7 的目标）。
六个出口自检 ✔ 计数：P1 32 / P2 49 / P3a 47 / P3b 56 / P3c 67 / **P3d 102**，全部退出 0；`pnpm typecheck` 退出 0。
`pnpm test` = **992 / 991 / 1**（唯一失败仍是既有 `db migrations, dictionaries and task tree` 的 Windows `rmSync` EPERM），与 P3-3 后同数 ⇒ **零回归**。
⚠️ 踩坑记录：**不要**把 `probe-*.mjs`（会改写源码再还原）与 `pnpm test`（内含 `pnpm build`）**并发**跑 ——
本轮第一次全量测试因此多出 1 条假红（`V04-B/AX-V07：三方构建标识同源`：构建标识在"算哈希"与"打包"之间被探针改了源文件），
串行重跑即恢复 992/991/1。凡是会改源文件的验证脚本，必须与构建串行。

## P4 明细（日期域）

| 职责 | 新 owner | 旧实现处理 | 扫描范围 | 变异锚点 |
|---|---|---|---|---|
| 17 项日期状态（`capacityEdit` / `capacityExpanded` / `reportSubTab` / `currentReport` / `reportSession` / `pickedPlan` / `pickedPlanSession` / `planRefreshKey` / `reportRefreshKey` / `todayPlanSession` / `todayExpanded` / `calendarExpanded` / `picked` / `addingPlanTaskId` / `cursor` / `calMode` / `dayTab`） | `hooks/useDayWorkspace.ts` | 入口 4 处声明块删除，各换一行指针注释 | 入口 17 条完整声明原文 0 命中；全客户端 `src/client/**` 各自**恰好** 1 处（`client_sources()` 含未追踪文件） | **M-P4-1**：入口收回 `dayTab` 自己 `useState` → p4 第 1/2 节红 |
| `pickedAnchor` + 4 个候选/容量 memo（`planCandidateInfo` / `todayPromptInfo` / `todayPlanCandidateRows` / `pickedPromptInfo` / `pickedPlanCandidateRows` / `capacity`） | hook 内 | 入口整段删除 | `capacity` 依赖数组 `[tasks, archivedTasks, todayPlan, dailyCapacityMinutes, defaultEstimateMinutes, dailyCapacityIncludeOverdue, capacityTodayKey(now)]` 原文在 hook；入口**不调** `computeTodayCapacity(` | **M-P4-2**：依赖塞回 `now` 对象 → 探针 I1 + `capacityWiring` AX-C06 双红；**M-P4-11**：入口重调 `todayPlanCandidates` → `capacityWiring` AX-G02 反向判据红 |
| 跨域读点 `planPromptFor`（`startAISession` 里的 `planCandidateInfo.promptFor(planAnchor)`） | hook 导出 `planPromptFor: planCandidateInfo.promptFor` | 入口调用点只换名字 | p4 第 7 节 `planPromptFor(planAnchor)` 在位 | — |
| 4 个 effect（报告加载 / 今日计划会话 / 选中日计划 / `dayTab` 复位） | hook 内 | 整体搬迁 | 依赖数组原文 `}, [view, dayTab, reportSubTab, reportAnchor, reportIsFuture, reportRefreshKey])` / `}, [todayAnchor, todayPlan])` / `}, [view, dayTab, pickedAnchor, planRefreshKey])` / `}, [dayPanel.extraTabsAvailable])`；`}, [todayAnchor, bootstrap])` **不在** | **M-P4-3**：今日计划会话依赖退回 `bootstrap` → p4 第 3 节红 |
| 17 个动作（`addTaskToPlan` / `patchPlanItem` / `savePlan` / `clearPlan` / `deleteReport` / 两个 toggle / `collapseExpanded` / `moveWeek` / `moveMonth` / 5 个 setter / `bumpPlanRefresh` / `bumpReportRefresh` 等） | hook 内 | 入口整段删除 | 16 个 action 名经解构用到 + 入口无第二份 `^(const\|function) <action>` 定义 | **M-P4-7**：hook 退化裸 `setError` → p4 第 5 节红；**M-P4-10**：入口重定义 `addTaskToPlan` → `dayPanelWiring` 反向判据红 |
| 两段内联 `api(...)`（`onClearPlan` / 报告 `onDelete`） | hook 动作 `clearPlan(date)` / `deleteReport(report)` | 入口装配层改成注入回调 | p4 第 7 节两条注入动作原文 | **M-P4-8**：退回内联 api → p4 第 7 节红 |
| `collapseAll`（**跨域组合**：列表域 + 日期域） | **留装配层**，日期域只出 `collapseExpanded()` | `taskList.actions.clearExpanded(); day.actions.collapseExpanded()` 收成一行 | p4 第 7 节 | **M-P4-4**：丢掉列表域那一半 → p4 第 7 节红 |
| 今日视图（统计卡 / `wb-cap` 容量条 / `wb-cap-legend` / `CapacityRulePanel` / `DayPanel` / 今日空态） | `views/TodayPane.tsx`（153 行） | 入口 JSX 逐字搬迁（原 L2802–2898） | `views/*` 无 `useState[<(]` / `fetch(` / `api[<(]`；入口 `wb-stats wb-stats-sticky` 已不在 | **M-P4-5**：`TodayPane` 自己发包 → p4 第 6 节红 |
| 日历视图（`wb-cal-nav` / 周 `wb-week` / 月 `wb-month` / `DayPanel`） | `views/CalendarView.tsx`（106 行） | 入口 JSX 逐字搬迁（原 L2899–2953）；「今天」按钮改成注入的 `onToday` | 同上；入口 `wb-cal-nav` 已不在 | **M-P4-6**：`CalendarView` 自持 state → p4 第 6 节红 |
| `saveIncludeOverdue` / `saveDailyCapacity`（写 `settings`） | **留入口**（设置域，P5/P6 才搬） | 不改 | `saveDailyCapacity` 只读 `day.capacityEdit`；hook 里**没有** `/api/workbench/settings` | **M-P4-9**：读回本地 `capacityEdit` → p4 第 7 节红 |
| `clearTodayPlan`（**搬迁前即死代码**：入口 0 处引用） | `hooks/useDayWorkspace.ts`（靠 `void clearTodayPlan` 消 lint） | 只换 owner，**不改行为、不删** | — | — |

### P4 需要同步迁移的既有判据（本批已改，5 条）

| 文件 | 改了什么 |
|---|---|
| `scripts/lib/d17-p3a-exit-check.py` | `bare()` 改为**先 `strip_comments`** + 正则收紧为 `(?<![\w.])name\b(?!\s*:)`（不算对象字面量的键、不算注释）；`strip_comments` 定义上移到 `bare()` 之前；§2 的 `"...taskList.archivedTasks]" in INDEX` 改成 `… in INDEX or "archivedTasks: taskList.archivedTasks," in INDEX` |
| `scripts/lib/d17-p3d-exit-check.py` | §7 的 `"tasks: [...tasks, ...taskList.archivedTasks]" in INDEX_BARE` 拆成两条（入口透传行 + hook 的 memo 本体）；项数 **102 → 103** |
| `test/dayPanelWiring.test.mjs` | 新增 `const DAY = read('src/client/hooks/useDayWorkspace.ts')`；`:66/:68` 改扫 `DAY`；`:76` 改成 `count(DAY, /addTaskToPlan/g) >= 2` + 新增反向 `assert.equal(/const addTaskToPlan = /.test(INDEX), false)`；`:79-80` 保留入口正向 ≥3 |
| `test/capacityWiring.test.mjs` | 新增 `const daySource = read('src/client/hooks/useDayWorkspace.ts')`；AX-G02 改成「入口不许调 `todayPlanCandidates(`」+「hook 必须调」；截断提示改扫 `daySource`；AX-C06 的 `const code = stripComments(daySource)` 且两处 `indexOf` 切片**补 `assert.ok(start > 0)` 守卫**；新增正向 `assert.match(indexSource, /archivedTasks: taskList\.archivedTasks,/)` |
| `scripts/repro/probe-capacity-mutations.mjs` | 新增常量 `const DAY_WORKSPACE = 'src/client/hooks/useDayWorkspace.ts'`（与 `SHARED`/`INDEX`/`PANEL`/`TASK_DETAIL_PANE` 并列）；**I1 的 `file` 改指它**、`from`/`to` 随搬改文本 |

> **改造方式的要害（子代理测绘指出的机制）**：只对 `index.tsx` 做**负向**断言时，搬家后天然为真（**空洞通过**）——
> 真正守住实现的是**跟着 owner 走的正向断言**。所以本批的改法是"负向留入口 + 正向改指 hook"，
> 并给所有 `indexOf` 切片补上"锚点存在"守卫。

### P4 探针实测
**本批有一处必须重锚，已重锚并实测**：`probe-capacity-mutations.mjs` 的 **I1** 随容量 memo 一起换文件归属
（`index.tsx` → `hooks/useDayWorkspace.ts`，新增常量 `DAY_WORKSPACE`），`from`/`to` 换成 hook 现文；
重锚后 **20/20 全红、退出 0**（S1–S12 + I1–I5 + P1/P2/P3 逐条变红）。
依据：设计 §7 P4 行明令「入口 I 系列按新 DayWorkspace 锚定；共享算法变异保持；不减少覆盖」。
I2/I4/I5 锚入口 `saveEditDraft` 本体、I3 锚 `views/TaskDetailPane.tsx` —— **本批都未动**，逐条实测仍精确命中。
`probe-listview-mutations` 17/17、知识域两探针 19/19 与 46/46 均全红。
`probe-quick-workspace-mutations`（13/15）与 `probe-model-picker-notify-mutations`（7/10）的失效项
**在 HEAD 版就已匹配不上锚点** ⇒ 属既有 KNOWN_PROBE_DEBT，归 P6，**不是 P4 引入的**。

### P4 度量与验证
入口 `src/client/index.tsx` **4571 → 4188（-383）**；`WorkbenchApp` 第 **221–2935** 行、**3101 → 2715（-386）**
（区间外 **1473** 行，+3：新增 `useDayWorkspace` / `TodayPane` / `CalendarView` 三条 import）。
新文件 `hooks/useDayWorkspace.ts` **533 行** / `views/TodayPane.tsx` **153 行** / `views/CalendarView.tsx` **106 行**。
累计：入口 5725 → 4188（-1537）；`WorkbenchApp` 4197 → 2715（-1482），到 ≤600 行还差 **2115** 行（P5–P7 的目标）。
七个出口自检 ✔ 计数：P1 32 / P2 49 / P3a 47 / P3b 56 / P3c 67 / P3d **103** / **P4 161**，全部退出 0；`npx tsc --noEmit` 退出 0。
`pnpm test` = **992 / 991 / 1**（唯一失败仍是既有 `db migrations, dictionaries and task tree` 的 Windows `rmSync` EPERM），与 P3-2/P3-3/P3-4 后同数 ⇒ **零回归**；
9 个定向文件 `node --test` = **97 / 97 / 0**。
⚠️ 串行纪律仍然适用（探针会改写源码、`pnpm test` 内含 `pnpm build`）；本轮两者串行跑，无假红。

### P4 遗留的两条明确决策（不是欠账）
① 入口 10 个**死 import**（`DayPanel` / `DayTab` / `capacityAriaLabel` / `useDayPanelModel` / `resolveDayPanelTab` /
`buildPlanPrompt` / `todayPlanCandidates` / `computeTodayCapacity` / `capacityTodayKey` / `TaskReportView`）**有意不清理**：
`noUnusedLocals` 未开、仓库无 lint，且 `PlanPanel` 早有同类死 import，清理会扩大 diff 与判据面；留给 P7 统一清。
② `useDayWorkspace.ts` 里的 `clearTodayPlan` 是**搬迁前就存在的死代码**（入口 0 处引用，靠 `void clearTodayPlan` 消 lint），
与 `clearPlan(date)` 语义重叠；本批**只换 owner、不改行为**，留给 P7 评估删除。

## P5-1 明细（反馈域 + 设置域）

| 职责 | 新 owner | 旧实现处理 | 扫描范围 | 变异锚点 |
|---|---|---|---|---|
| `error` / `notice` 2 项状态 + `useToasts()` 的 `toasts`/`pushToast`/`dismissToast` | `hooks/useWorkbenchFeedback.ts`（64 行） | 入口 L366-367 两条声明与 L418 `useToasts()` 各换一行指针注释 | 入口剥注释后 `error`/`notice` 裸名 0、`useToasts` 裸名 0；全客户端 `useToasts()` 解构只在反馈 hook | **M-P5a-6**：入口重新自己起 `useToasts()` → p5a §1 红 |
| 两条提示桥接 effect（`notice → pushToast(…,'success')` / `error → pushToast(…,'error')`，各自 `setX(null)`） | 同 hook（逐字照抄，含依赖数组） | 入口整段删除 | 两条 effect 原文在 hook；入口不含 | **M-P5a-5**：不再清回 `null` → p5a §5 红 |
| `settings` 1 项状态 + `showSettings`/`settingsSaving`/`recallLog`/`recallSessionOff`/`dictKind`/`dictForm`/`dictEditCode`/`dictError` 8 项 | `hooks/useWorkbenchSettings.ts`（252 行） | 入口 L400 起两段声明块删除，各换一行指针注释 | 入口 9 条完整声明原文 0 命中；全客户端各自**恰好** 1 处 | **M-P5a-1**：入口收回 `showSettings` 自己 `useState` → p5a §1/§2 红 |
| `SETTINGS_FALLBACK` + `withSettingsFallback`（既有纯逻辑，被设置域与仍留入口的 `rememberQuickWorkspace`/`forgetQuickWorkspace` 共用） | **新纯模块** `src/client/settingsFallback.ts`（36 行，0 React / 0 DOM / 0 请求） | 入口整段删除，换一条 import + 一行指针注释 | 全客户端只在该文件定义；入口有 import、无定义 | **M-P5a-3**：入口复活一份 `SETTINGS_FALLBACK` → p5a §1/§2 红 |
| 设置装载 effect（`GET /api/workbench/settings` → `setSettings(withSettingsFallback(res.settings))`，`[showSettings, loadRecallLog]`） | hook 内 | 入口整段删除 | 装载 effect 原文在 hook；入口不发 `/api/workbench/settings` 的 GET | **M-P5a-4**：入口重新内联装载 effect → p5a §3 红 |
| 6 个设置域动作（`saveSettings` / `saveDictionaryEntry` / `toggleDictionaryEntry` / `deleteDictionaryEntry` / `loadRecallLog` / `recallSessionRestore`）+ 6 条路由（`/settings`、`/dictionaries` 三条、`/knowledge-recall/{log,session}`） | hook 内 | 入口整段删除 | 6 条动作定义原文在全客户端各恰好 1 处（设置 hook）；入口 12 个解构名无第二份定义 | **M-P5a-7**：入口复制一份 `recallSessionRestore` → p5a §1 红（**首次为盲点，见下**）；**M-P5a-10**：`limit=30`→`31` → p5a §3 + `test/knowledgeRecallRoutes.test.mjs` 双红 |
| 召回日志 effect（`loadRecallLog` + `recallLog` 状态装配） | hook 内 | 入口整段删除 | 召回日志 effect 原文在 hook | 同 M-P5a-10 |
| `dictOf` 入参挂钩（设置 hook 要**任务数据域**的字典派生） | **跨域注入**：入口把 `dictOf` 当入参传进 hook | 不改 | p5a §4 入参类型三条 + hook 不 import 入口/视图 | **M-P5a-2**：hook 丢掉注入别名退回裸 `setError` → p5a §4 红 |
| `saveIncludeOverdue` / `saveDailyCapacity`（写 `settings`） | **留入口**（P4 决策，P6 才搬） | 不改 | 入口仍各 1 处定义原文；设置 hook **不含** `/api/workbench/settings` 的 POST | **M-P5a-9** 打在 hook 的 `saveSettings` 上（见下） |
| `rememberQuickWorkspace` / `forgetQuickWorkspace` 里的 `setSettings(withSettingsFallback(res.settings))` | **留入口**（P6） | 不改 | p5a §6：该原文在入口出现 **2** 次 | — |
| `ToastHost` 渲染、`SettingsModal` 全部 props、两层提示横幅门控 | **留装配层** | 不改 | p5a §6：`<ToastHost items={toasts} onDismiss={dismissToast} />` 与 18 条 JSX props 原文 | — |

### P5-1 需要同步迁移的既有判据（本批已改，2 条 + 1 探针）

| 文件 | 改了什么 |
|---|---|
| `test/knowledgeRecallRoutes.test.mjs` | `:254-257` 由"入口出现召回日志端点"改成**入口负向**（不许自己发 `/api/workbench/knowledge-recall/`）+ 新增两条正向断言指向 `src/client/hooks/useWorkbenchSettings.ts`；"面板接的是真日志"（`recallLog={recallLog}`）保留 |
| `test/quickWorkspaceDefault.test.mjs` | `:168` 的 `functionBody(stripped, 'saveSettings')` 改法：先断言**入口不再定义** `saveSettings`（唯一 owner 在设置 hook），再 `readSource('../src/client/hooks/useWorkbenchSettings.ts')` 取函数体；其后 3 条断言原文不动即继续有效 |
| `scripts/repro/probe-quick-workspace-mutations.mjs` | 新增常量 `SETTINGS_HOOK = src/client/hooks/useWorkbenchSettings.ts`；**M12/M13 的 `file:` 改指它**（锚点随 `saveSettings` 离开入口） |

> `test/draftBannerSessionJump.test.mjs`（登记表里标 P5 的另一条）**无需改动**即通过 ——
> 因为 P5-1 沿用 P4 的「只换来源、不改调用点文本」：入口从 hook 解构出同名 setter，
> `onSettled={() => setPendingDraft(null)}` 文本未动。**M-P5a-11** 反过来证明这条判据确实还在守着它。

### P5-1 实测到的一条判据脆弱性（新教训，P1–P4 需按此口径复核）

`§1` 的"入口不再有 X 的第二份定义"最初写成 `re.search(r"^(const|function)\s+X\b", src, re.M)` ——
`WorkbenchApp` 体内的定义**缩进 2 格**，`^const` 永远匹配不到，这条断言**永远为真（空洞通过）**。
修口径前 141 项同样"全过"；**M-P5a-7 第一次跑没被抓住**才暴露它。改成 `^[ \t]*(const|function)\s+X\b` 后立刻变红。

→ **可复用规则**：凡"某名字不该再出现第二份定义"的文本判据，正则必须允许行首空白，
且**必须用一条真造得出第二份定义的变异来反证它**。P1–P4 的 exit-check 里同类断言（`^(const|function)` 且目标在组件体内）按这个口径复核。

### P5-1 探针实测

**本批有一处必须重锚，已重锚并实测**：`probe-quick-workspace-mutations.mjs` 的 **M12/M13** 锚在 `saveSettings` 体内，
随设置域离开入口 ⇒ 新增常量 `SETTINGS_HOOK` 改指 `hooks/useWorkbenchSettings.ts`，两条仍逐条变红，
总数仍是 **13/15**（未发现的 M6/M14 与搬迁前同数，属 P6 KNOWN_PROBE_DEBT，**不是本批引入的**）。

其余五个探针与本批无关且**逐条复跑无变化**：`probe-capacity-mutations` 20/20、`probe-listview-mutations` 17/17、
`probe-knowledge-draft-overwrite-mutations` 19/19、`probe-knowledge-recall-mutations` 46/46
（`probe-capacity` 的 `INDEX` 锚点都在 `saveEditDraft`，属 P3-3 留在入口的代码；后三个都不读 `src/client/index.tsx`，
`probe-knowledge-recall` 的 `INDEX` 是服务端 `src/index.ts`）。
`probe-model-picker-notify-mutations`（7/10）的失效项 B7/B8/B10 全锚在入口模型选择器接线（`quickModelSelection` →
`modelSelection` 改名漂移），属 **P6**，本批不动。

### P5-1 度量与验证

入口 `src/client/index.tsx` **4188 → 4071（-117）**；`WorkbenchApp` 第 **202–2818** 行、**2715 → 2617（-98）**
（区间外 **1454** 行，-19：搬走 `SETTINGS_FALLBACK`/`withSettingsFallback` 约 25 行，换回 3 条 import + 8 处指针注释）。
新文件 `settingsFallback.ts` **36 行** / `hooks/useWorkbenchFeedback.ts` **64 行** / `hooks/useWorkbenchSettings.ts` **252 行**。
累计：入口 5725 → 4071（**-1654**）；`WorkbenchApp` 4197 → 2617（**-1580**），到 ≤600 行还差 **2017** 行（P5-2–P7 的目标）。
八个出口自检 ✔ 计数：P1 32 / P2 49 / P3a 47 / P3b 56 / P3c 67 / P3d 103 / P4 161 / **P5a 141**，全部退出 0；`npx tsc --noEmit` 退出 0。
反向变异 `scripts/lib/d17-mutate-p5a.py` = **11/11 全被捕获**、还原后 sha256 逐字节一致、还原后基线 exit=[0,0,0,0]。
`pnpm test` = **992 / 991 / 1**（唯一失败仍是既有 db EPERM），与 P3-2/P3-3/P3-4/P4 后同数 ⇒ **零回归**；
5 个定向文件 `node --test` = **55 / 55 / 0**。
⚠️ 本批两次首跑各出现一次 `test/personaLibrary.test.mjs:585`（`[TypeError: fetch failed] [cause]: Error: bad port`），
串行重跑即消失 —— 端口抖动，**不是 P5-1 回归**，但说明这套测试对并发敏感。
⚠️ 串行纪律仍然适用（探针与 `d17-mutate-p5a.py` 都会改写源码、`pnpm test` 内含 `pnpm build`）；本轮全部串行。

### P5-1 的落点约束（为什么反馈域必须最先、设置域必须在 `notifyPerm` 之后）

反馈域是 4 个已搬 hook（`useTaskData` / `useKnowledge` / `useIdeas` …）与设置域**共同的注入源**，
而 `const` 不提升 ⇒ `const feedback = useWorkbenchFeedback()` 必须落在原 `error`/`notice` 声明处（入口 L350），
早于 `const data = useTaskData({ onError: setError, onNotice: setNotice })`（L354）。
设置域 hook 又要同时拿任务数据域的 `dictOf` 与反馈域的三个写口，落点被推到 `notifyPerm` 之后的 **L400**。
这是"装配层仍是唯一能同时看见这些域的地方"的直接结果，不是随便挑的行号。

## P5-2 明细（提醒域）

| 职责 | 新 owner | 旧实现处理 | 扫描范围 | 变异锚点 |
|---|---|---|---|---|
| `reminders` / `reminderModalOpen` / `notifyPerm` / `reminderPolicy` / `reminderChannel` / `reminderOptions` / `reminderBusy` 7 项状态 | `hooks/useWorkbenchReminders.ts`（321 行） | 入口 L346 / L368 / L394-397 / L410-413 各换一行指针注释 | 入口 7 条完整声明原文 0 命中；全客户端各自**恰好** 1 处 | **M-P5b-1**：入口把 `reminderModalOpen` 收回去自己 `useState` → p5b §1/§2 红 |
| `notificationCtor`（普通常量） | 同 hook | 入口 L394 删除换指针注释；**入口仍在两个内联回调里就地 `readNotificationCtor(globalThis)`**（刻意留装配层） | p5b §6：入口剥注释后 `readNotificationCtor(globalThis)` == 2 | — |
| `notifiedRef` + `persistNotified`（跨会话去重；存储键 `dsh-workbench:desktop-notified` 不变，>500 保留后 250） | 同 hook | 入口 L583-597 整段删除 | 入口 `defs_of('notifiedRef') == 0`；全客户端原声明恰好 1 处 | **M-P5b-3**：入口复活一份 `notifiedRef` → p5b §1 红 |
| 设置面板装载 effect（`GET /reminders/policy` + `GET /reminders/channel`，`[showSettings]`） | 同 hook | 入口 L563-574 整段删除 | effect 体原文在 hook；入口不含 | **M-P5b-4**：入口重新内联 → p5b §1 红 |
| 自动弹窗 effect（`reminders.length > 0 → setReminderModalOpen(true)`，`[reminders.length]`） | 同 hook | 入口 L601-604 删除 | effect 原文在 hook | — |
| `ackReminder` / `resetReminderState` / `addTaskReminder` 三个动作 | 同 hook | 入口 L721-752 整段删除 | 三条定义原文在全客户端各恰好 1 处；入口 `defs_of == 0` | **M-P5b-12**：入口复制一份 `ackReminder` → **p5b 红 / p5a 绿**（判据移交的证据）；**M-P5b-8**：`ackReminder` 去掉 `currentTaskId()` 闸门 → p5b §4 红 |
| 四条微信提醒动作（`loadReminderChannel` / `saveReminderTarget` / `saveReminderPolicy` / `sendReminderTest`）+ 7 条路由 | 同 hook | 入口 L1440-1501 整段删除 | 四条定义原文各恰好 1 处；hook 内 `api[<(]` ≥9 | **M-P5b-6**：hook 越界发 `/api/workbench/drafts` → p5b §3 红 |
| `tickDue(isAlive)`（**只搬 `tick` 里提醒那一半**） | 同 hook | 入口 L659-685 换成三行注释 + `await tickDue(() => alive)` | p5b §5：hook 内 0 定时器；`!isAlive()` 守卫早于 `setReminders` / 发通知 / 写去重集合；`if (notifiedAny) persistNotified()` 在位；入口轮询含 `tickDue(`、不含内联 `api<{ reminders:`、`setInterval(` 仍 2 处 | **M-P5b-5** 去守卫 / **M-P5b-7** hook 起定时器 / **M-P5b-9** 入口改回内联 / **M-P5b-11** 去 `persistNotified()` → p5b §5 红 |
| 5 秒 `tick` + 15 秒 `refresh` 那条**混合域轮询 effect**（入口 L606-636） | **留入口**（归 P5-3 `useWorkbenchPolling`，设计 §7 第 184 行） | 只改 `tick` 的提醒半段，**依赖数组 `}, [refresh, settings.desktopNotify])` 文本不动** | p5b §5：入口 poll 里 `setInterval(` == 2 | 同 M-P5b-9 |
| `currentTaskId` / `refresh` / `showSettings` / `settings.desktopNotify` 四个跨域读口 | **跨域注入**：入口当入参传进 hook | 不改 | p5b §4 别名行原文 + 7 条入参类型 | **M-P5b-2**：hook 丢掉别名退回裸 `setError` → p5b §4 红；**M-P5b-10**：入口 `desktopNotify: true` → p5b §1 红 |
| 提醒弹窗、`SettingsModal` 提醒 props、`TaskDetailPane` 两个 props、`pendingCount` | **留装配层** | 不改 | p5b §6：15 条 JSX props 原文 + `onClick={() => void ackReminder(...)}` == 2 + `pendingCount` 原文 | — |

### P5-2 需要同步迁移的既有判据（本批已改，2 条出口自检；`test/*.mjs` 与探针**零改动**）

| 文件 | 改了什么 |
|---|---|
| `scripts/lib/d17-p5a-exit-check.py` §6 | 从"刻意留在装配层"列表里**删掉** `loadReminderChannel` / `saveReminderPolicy` / `ackReminder` / `resetReminderState` 四条 —— 它们随 P5-2 搬走，旧判据成了假红。注释写明判据改由 p5b 守；p5a **141 → 137** 项 |
| `scripts/lib/d17-p3d-exit-check.py:198` | `len(re.findall(r"currentTaskId\(\)", INDEX_BARE)) == 3` → `== 1`（另两处在 `ackReminder` / `addTaskReminder` 体内，已随实现搬走）；p3d 复绿 **103** 项 |
| **`test/*.mjs`（全部）** | **一条都没改** —— 所有 `test/*.mjs` 里没有任何一条按源码文本锚在提醒域的客户端符号上（`reminder.test.mjs` / `draftNotify.test.mjs` 命中的都是服务端 `lib/reminder/config.js`；`reminderWiring.test.mjs` 读 `src/index.ts`） |
| **`scripts/repro/probe-*.mjs`（全部 6 个）** | **一条都没改** —— 只有 `probe-capacity-mutations.mjs` 与 `probe-listview-mutations.mjs` 读入口，锚点都在任务详情/列表域 |

> **可复用判断**：一批是否"零判据重锚"，取决于**搬迁后入口的文本是否变化**。P5 全程沿用 P4 的
> 「只换来源、不改调用点文本」：入口从 `remindersApi` / `remindersApi.actions` 解构出同名值，
> 于是 7 项 state 的解构、15 条 JSX props、2 处 `onClick` 一个字都不用动。
> 本批唯一被打回的是**上一批自己写下的**跨批出口自检（p5a §6 / p3d §198）——
> 印证 P4 那条登记：**跨批出口自检之间会互相假红，每批收尾必须把全部出口自检跑一遍**。

### P5-2 探针实测（**无需重锚**，六条逐条复跑）

`probe-capacity-mutations` **20/20**、`probe-listview-mutations` **17/17**、
`probe-knowledge-draft-overwrite-mutations` **19/19**、`probe-knowledge-recall-mutations` **46/46** ——
四条基线全绿、逐条变红，与本批前同数。
`probe-quick-workspace-mutations` **13/15**（M12/M13 是 P5-1 重锚过的，本批后仍逐条变红；未发现的 M6/M14
与搬迁前同数，属 **P6 KNOWN_PROBE_DEBT**）、`probe-model-picker-notify-mutations` **7/10**
（未发现的 B7/B8/B10 同为 **P6 KNOWN_PROBE_DEBT**）。

### P5-2 度量与验证

入口 `src/client/index.tsx` **4071 → 3926（-145）**；`WorkbenchApp` 第 **203–2673** 行、**2617 → 2471（-146）**
（区间外 **1455** 行，+1：搬走约 160 行实现，换回 1 条 import + 10 处指针注释 + 1 个 hook 调用点与两段解构）。
新文件 `hooks/useWorkbenchReminders.ts` **321 行**。
累计：入口 5725 → 3926（**-1799**）；`WorkbenchApp` 4197 → 2471（**-1726**），到 ≤600 行还差 **1871** 行（P5-3–P7 的目标）。
出口自检 ✔ 计数：P1 32 / P2 49 / P3a 47 / P3b 56 / P3c 67 / P3d 103 / P4 161 / **P5a 137** / **P5b 156**，全部退出 0；
`npx tsc --noEmit` 退出 0。反向变异 `scripts/lib/d17-mutate-p5b.py` = **12/12 全被捕获**、
还原后 sha256 逐字节一致、还原后基线 exit=[0,0]。`pnpm test` = **992 / 991 / 1**（唯一失败仍是既有 db EPERM），
与 P5-1 同数 ⇒ **零回归**。
⚠️ 本轮首跑曾多报一条 `test/devVerify.test.mjs:204`（`ENOENT ... lib/build-info.json`）：该用例自带
"先跑 `pnpm build`"的前提，`lib/` 是 gitignored 构建产物；重新 `pnpm build` 后复跑即恢复 992/991/1，**不是 P5-2 回归**。
⚠️ 串行纪律仍然适用（`d17-mutate-p5b.py` 会改写源码、`pnpm test` 内含 `pnpm build`）；本轮全部串行。

### P5-2 的落点约束（为什么提醒域必须在 `prefs` 之后、轮询必须留装配层）

`useWorkbenchReminders` 要同时拿任务数据域的 `currentTaskId` / `refresh`（`ackReminder` 的闸门、
`addTaskReminder` 的取 id）与设置域的 `showSettings` / `settings.desktopNotify`（策略装载 effect 的开关、
通知半段的重建条件），所以调用点被推到 `const prefs = useWorkbenchSettings(…)`（入口 L395）之后的 **L407**。
而 5 秒/15 秒那条 effect 的 `tick` 里**同时**有草稿域与提醒域两半 —— 草稿域归 P5-3，所以本批**不能**把它
整片搬进任一个 hook（否则要么提前搬走草稿域，要么在两个 hook 里各起一个定时器）。
本批的可复用手法：**只搬"半个 effect"，用回调把存活守卫透传出去**（`tickDue(isAlive)`），
让入口那条 `catch` 与 `!alive` 的语义逐字保持。

## P5-3 明细（草稿域 + 轮询装配）

| 职责 | 新 owner | 旧实现处理 | 扫描范围 | 变异锚点 |
|---|---|---|---|---|
| `pendingDraft` / `deferredDrafts` / `draftProblems` / `draftSwitchedFrom` / `allPendingDrafts` / `pendingOpen` / `duplicatePrompt` 7 项状态 | `hooks/useWorkbenchDrafts.ts`（348 行） | 入口 L300–L346 连续 47 行整段删除换指针注释；L372 单行换指针注释；L379-387（含内联类型）整段删除，类型提成具名 `DraftDuplicatePrompt` | 入口 7 条完整声明原文 0 命中（`duplicatePrompt` 按入口原来的内联写法断）；全客户端各自**恰好** 1 处 | **M-P5c-1**：入口把 `pendingOpen` 收回去自己 `useState` → §1/§2 红 |
| `dismissedDraftIdsRef` / `deferredWhenDismissedRef` / `bannerDraftRef` 3 个 ref | 同 hook | 入口 L321 / L328 / L339 各换指针注释 | 入口三条声明 0 命中；全客户端各恰好 1 处 | **M-P5c-3**：入口复活一份 `dismissedDraftIdsRef` → §1（3 项）红 |
| `dismissDraft` / `resumePendingDraft` / `resumeDeferredDraft` / `handleDraftConfirmed` / `reuseExistingTask` 5 个动作 + 3 条草稿路由 | 同 hook | 入口 L1882-1989 整段删除 | 五条定义原文在全客户端各恰好 1 处；入口 `defs_of == 0`；hook 内 `api[<(]` ≥4 | **M-P5c-6**：hook 越界发 `/api/workbench/reminders/*` → §3 红 |
| `tickDrafts(isAlive)`（轮询的**草稿半段**） | 同 hook（`useCallback(…, [])`，**身份恒定**） | 入口 L576-626 那半段随整片 effect 搬走 | §3：入口不再直接请求草稿端点、不再内联拉草稿；`if (isAlive()) {` 守卫早于 `setPendingDraft` 与写 `bannerDraftRef` | **M-P5c-5** 去守卫 → §3（3 项）红；**M-P5c-7** hook 起定时器 → §3 红 |
| 5 秒 `tick` + 15 秒 `refresh` 那条**混合域轮询 effect**（入口 L574–636） | **新建 `hooks/useWorkbenchPolling.ts`（61 行）** | 整片换成一个调用点 `useWorkbenchPolling({ tickDrafts, tickReminders: remindersApi.actions.tickDue, refresh, desktopNotify: settings.desktopNotify })` | §5：装配器持有 `alive`、两半段**串行且顺序不变**（草稿 → 提醒）、恰好 2 个定时器且两条周期原文、共用同一个 `try`/`catch`、清理原文、依赖数组 `[refresh, desktopNotify, tickDrafts, tickReminders]`、不认识任何端点、0 state | **M-P5c-8** 对调顺序 / **M-P5c-9** 改频率 / **M-P5c-10** 删 15 秒定时器 → §5 红；**M-P5c-12** 入口改回内联拉提醒 → **p5c 红 / p5b 绿**（判据移交的证据） |
| `tickDue` 的身份（P5-2 建的动作） | 同 P5-2（`hooks/useWorkbenchReminders.ts`），本批**包一层 `useCallback(…, [desktopNotify])`** | 签名与体内行为一个字没改 | p5b 的两条锚点原文跟改成 `const tickDue = useCallback(async (isAlive: () => boolean)…` | — |
| `currentTaskId` / `refresh` / `setError` / `setNotice` 四个跨域注入 | **跨域注入**：入口当入参传进 hook | 不改 | §4 别名行原文 + 3 条入参类型 + 14 个别域名裸名 0 | **M-P5c-2**：hook 丢掉别名退回裸 `setError` → §4 红 |
| `pendingDraft` → `PENDING_ATTR` 的宿主 DOM 投影 effect | **留装配层**（设计 §4.1 末行） | 不改 | §6：写/清 `PENDING_ATTR` 共 3 处 | **M-P5c-11**：改成空操作 → §6 红 |
| `DraftBanner` 整块 + 13 处调用点（含 `onSettled` / `onDismissed` / `onClose` / `reuseExistingTask` 主按钮 / 待处理弹窗） | **留装配层** | 不改 | §6：13 条原文 + `DraftBanner` 跨域 `onDone` 原文 | — |

### P5-3 需要同步迁移的既有判据（本批已改，1 个出口自检的 7 处；`test/*.mjs` 与探针**零改动**）

| 文件 | 改了什么 |
|---|---|
| `scripts/lib/d17-p5b-exit-check.py` §5（五条断言） | 整片断言"入口轮询里 `await tickDue(() => alive)` 在 / 内联拉提醒不在 / 恰好 2 个 `setInterval` / 依赖数组文本不变"。本批把那条 effect 整片搬进装配器 ⇒ **五条整体移交** `d17-p5c-exit-check.py` §5，p5b 原地留注释说明去向 |
| `scripts/lib/d17-p5b-exit-check.py:152` | `REMINDER_ACTIONS["tickDue"]` 的定义原文 → 改成 `const tickDue = useCallback(async (isAlive: () => boolean): Promise<void> => {`（本批为了身份稳定而包 `useCallback`），并加注释说明签名与行为未改 |
| `scripts/lib/d17-p5b-exit-check.py:295` | `body_of(REMINDERS_BARE, "const tickDue = async (isAlive: () => boolean)", …)` 起点标记 → 跟改成 `const tickDue = useCallback(async (isAlive: () => boolean)` |
| **`test/*.mjs`（全部）** | **一条都没改** —— 入口从 `draftsApi` / `draftsApi.actions` 解构出同名值，`onSettled={() => setPendingDraft(null)}`（`test/draftBannerSessionJump.test.mjs:115` 有正则断言）等全部调用点文本一字未动 |
| **`scripts/repro/probe-*.mjs`（全部 6 个）** | **一条都没改** —— 没有任何一条锚在草稿域（`repro-banner.mjs:31` 只在注释里提到 `pendingDraft`） |

> **可复用判断（第三次印证）**：一批是否"零判据重锚"，取决于**搬迁后入口的文本是否变化**。
> 本批唯一被打回的仍是**上一批自己写下的**跨批出口自检（p5b 五条 + 两条锚点原文），
> 而且这次多出一个新情形：**为了让代码能安全进入新装配器的依赖数组，主动改了一个已搬走动作的声明文本**
> （`tickDue` 包 `useCallback`）——这时"判据跟着 owner 走"不能只看 owner 变没变，
> 还要看**owner 没变、但它的声明文本变了**：断言原文必须同批跟改，否则下一批开工就红。
> 新增的一条纪律：**本地 hook 的动作若要被装配层放进 effect 依赖数组，必须自证身份稳定**（`useCallback`），
> 并把"稳定"这件事写进依赖数组，让它可被静态检查看见。

### P5-3 探针实测（**无需重锚**，六条逐条复跑）

`probe-capacity-mutations` **20/20**、`probe-listview-mutations` **17/17**、
`probe-knowledge-draft-overwrite-mutations` **19/19**、`probe-knowledge-recall-mutations` **46/46** ——
四条基线全绿、逐条变红，与本批前同数。
`probe-quick-workspace-mutations` **13/15**（未发现的 M6/M14 属 **P6 KNOWN_PROBE_DEBT**，与本批前同数）、
`probe-model-picker-notify-mutations` **7/10**（未发现的 B7/B8/B10 同为 **P6 KNOWN_PROBE_DEBT**）。

### P5-3 度量与验证

入口 `src/client/index.tsx` **3926 → 3724（-202）**；`WorkbenchApp` 第 **205–2471** 行、**2471 → 2267（-204）**
（区间外 **1457** 行，+2：两条新 import）。
新文件 `hooks/useWorkbenchDrafts.ts` **348 行**、`hooks/useWorkbenchPolling.ts` **61 行**。
累计：入口 5725 → 3724（**-2001**）；`WorkbenchApp` 4197 → 2267（**-1930**）。
按 ADR-0008 的新口径：护栏 ≤900 还差 **1367** 行；**本批解锁硬门的一条 —— `WorkbenchApp` 体内
`setInterval`/`setTimeout` 均为 0**（入口整份文件只剩插件 setup 作用域的 `titlebarTimer`）。
出口自检 ✔ 计数：P1 32 / P2 49 / P3a 47 / P3b 56 / P3c 67 / P3d 103 / P4 161 / P5a 137 / P5b 152 / **P5c 151**，
全部退出 0；`pnpm typecheck` 退出 0；`pnpm build` 退出 0（buildId `wb-3dae8edbe5fc55f1`、inputs 173、
`lib/client.js` 542.99 kB / gzip 154.68 kB）。反向变异 `scripts/lib/d17-mutate-p5c.py` = **12/12 全被捕获**、
还原后 sha256 逐字节一致、还原后基线 exit=[0,0]。`pnpm test` = **992 / 991 / 1**（唯一失败仍是既有 db EPERM），
与 P5-2 同数 ⇒ **零回归**。
⚠️ 串行纪律仍然适用（`d17-mutate-p5c.py` 会改写源码、`pnpm test` 内含 `pnpm build`）；本轮全部串行。

### P5-3 的落点约束（为什么草稿域必须在 `prefs` / `remindersApi` 之前、装配器必须在最后）

`useWorkbenchDrafts` 要注入任务数据域的 `refresh`（`reuseExistingTask` 收口后刷新 bootstrap）与
反馈域的 `setError` / `setNotice`，所以它的调用点紧跟 `} = data.actions`（入口 L330）之后的 **L333**；
`const prefs = useWorkbenchSettings(…)` 在 L350、`remindersApi` 在 L362，
装配器调用点再往后到 L534（要同时拿 `draftsApi.actions.tickDrafts`、`remindersApi.actions.tickDue`
与 `settings.desktopNotify`）。
本批的可复用手法：**把"半个 effect"拼回去** —— P5-2 已经用 `tickDue(isAlive)` 把提醒半段透传出去，
本批只要再交出对称的 `tickDrafts(isAlive)`，装配器就能用一个 `try` 把两半段按原顺序串起来，
定时器数量、周期、清理与依赖重建时机都不需要重新发明（设计 §5.3 的"无业务状态的 effect 装配器"）。

## P6-1 明细（导航 + 忙碌标志）

| 职责 | 新 owner | 旧实现处理 | 扫描范围 | 变异锚点 |
|---|---|---|---|---|
| `view`（1 项 state，P0 行号 277） | `hooks/useWorkbenchNavigation.ts`（43 行，`view` / `setView`） | 入口那 1 行 `useState<WorkbenchView>('today')` 换成一个 hook 调用 + 解构 + 指针注释 | 入口 0 命中该声明原文；`test/taskDetailWiring.test.mjs` 正向改指 hook + 入口负向；`d17-p3b-exit-check.py` §7 | `d17-mutate-p3b.py` 的 **M-P3B-4** 靶点跟到新 hook |
| `busy`（1 项 state，P0 行号 511） | `hooks/useWorkbenchBusy.ts`（39 行，`busy` / `setBusy`） | 入口声明删除换指针注释 | 全客户端恰好 1 处声明；`d17-p6b/p6c/p6d-exit-check.py` §2 各一条「P6-1 的忙碌标志仍是唯一所有者」 | **无直接变异**（见"覆盖缺口"） |
| 为什么 `busy` 单独成 hook、不并进 `useAISessions` | — | — | 它被**知识域借用**（`useKnowledge` 收 `busy` / `setBusy`），是跨域界面瞬态、不属任何业务域；并进 AI 会话域会造成"知识域依赖 AI 会话域"的反向耦合 | — |

### P6-1 需要同步迁移的既有判据（本批已改，3 处）

| 文件 | 改了什么 |
|---|---|
| `test/taskDetailWiring.test.mjs` | 入口含 `useState<WorkbenchView>('today')` 的正向断言 → 改指 `hooks/useWorkbenchNavigation.ts`，入口补**负向** |
| `scripts/lib/d17-p3b-exit-check.py` §7 | 同一句原文的断言改指新 hook ⇒ **56 → 57 项** |
| `scripts/lib/d17-mutate-p3b.py` | `M-P3B-4`（把视图联合类型改回内联）的变异靶点随 owner 搬到 `useWorkbenchNavigation.ts`，脚本头部注明 |

### P6-1 出口自检与反向变异

**本批没有新建出口自检脚本**（无 `d17-p6a-exit-check.py`；`d17-cut-p6a.py` 只是搬迁脚本）。
覆盖方式：`d17-p3b-exit-check.py` §7（57 项、退出 0）+ 后续三批 §2 的 6 条「P6-1 的导航域 / 忙碌标志仍是唯一所有者」。
反向变异：`d17-mutate-p3b.py` **6/6 全红、退出 0**；`d17-mutate-p6b.py` **13/13**（它的头部声明覆盖 P6-1 的导航/忙碌域，但注入点只在入口/快速录入 hook/共用纯模块三处）。

### P6-1 度量与验证

入口 **3724 → 3733（+9，本轮唯一净增）**；`WorkbenchApp` **2267 → 2274（+7）**；体内直接 `useState(` **27 → 25**。
累计：入口 5725 → 3733（-1992）；`WorkbenchApp` 4197 → 2274（-1923）；距 ≤900 护栏还差 1374。
新增 `hooks/useWorkbenchNavigation.ts` 43 行、`hooks/useWorkbenchBusy.ts` 39 行。
⚠️ **本批没有独立出口自检、也没有独立反向变异脚本** ⇒ 覆盖缺口在 P6 收尾时**未被补齐**。

## P6-2 明细（快速录入域）

| 职责 | 新 owner | 旧实现处理 | 扫描范围 | 变异锚点 |
|---|---|---|---|---|
| 8 项 state（`showQuick` / `quickText` / `quickWorkspace` / `quickWorkspaceTouched` / `quickWorkspaceSource` / `quickFollowFolder` / `quickAttachments` / `quickAttachmentNotice`）+ 2 个 ref + 两个内部写入点 + 7 个动作 + 1 条卸载 effect | `hooks/useWorkbenchQuickIntake.ts`（364 行） | 入口从 `showQuick` 声明到 `appendQuickAttachments` 整段（含原注释）删除换指针注释；调用点紧跟 `} = prefs.actions` 之后 | §1 入口 0 命中 + `defs_of` 无第二份定义；§2 `owners_of` 恰为本 hook；§3 无 `fetch`、**0 定时器**、不读 `selected` | **M-P6b-1/2/3**（收回 state / 复活镜像 ref / 内联写附件）、**M-P6b-9/10/11/12**（丢别名 / 越界发路由 / 自起定时器 / 直接读 `selected`） |
| `newTaskId` / `fileToBase64` / `quickImageToPromptPart` | **纯模块 `src/client/intakeHelpers.ts`（66 行）** | 从入口尾部搬出（录入域与 P6-3 的 AI 会话域**共用**；hook 不能 import 入口，会成环） | §2 三件套只在本模块；`M-P6b-13` 守纯度（不许 import React） | **M-P6b-13** |
| `openQuickEntry`（跨域组合） | **留装配层** | 拆成 ① 录入域 `openIntake()` ② AI 会话域的角色/技能复位 + `loadSkills()`（P6-3 的 `resetClarifyPicker`），按原顺序拼回 | §5 两半段顺序 | — |
| 提交闸门 `shouldRememberQuickWorkspace(quickWorkspaceTouched, chosen)` | **留装配层** | 不动 | `M-P6b-8` 的 `.mjs` 判据（`quickWorkspaceDefault.test.mjs` / `quickIntakeDefaultWiring.test.mjs`） | **M-P6b-8** |
| `detectWslHost`（入口尾部模块级纯函数） | **留入口**，以**注入**形式交给 hook | 不改 | §4 实参文本与拆分前逐字一致 | **M-P6b-7**（改名即红） |
| `applyDecision`（原 `applyQuickWorkspaceDecision` 投影） | 同 hook | 入口整段删除；它仍是「打开弹窗」「不再记住这个目录」两处共用的唯一投影 | §2 唯一实现 | — |

### P6-2 需要同步迁移的既有判据（本批已改，5 处）

| 文件 | 改了什么 |
|---|---|
| `test/quickIntakeDefaultWiring.test.mjs`（:32 附近） | **逐字切片** `openQuickEntry` / `applyQuickWorkspaceDecision` 两个函数体 → 切片改从 `hooks/useWorkbenchQuickIntake.ts` 取（`openQuickEntry` 仍留装配层，补了跨域组合语境） |
| `test/quickWorkspaceDefault.test.mjs`（135/156/219/311） | 快速录入与工作区默认值接线的正向断言改指 hook；提交闸门仍留入口 ⇒ 入口侧断言保留 |
| `scripts/repro/probe-quick-workspace-mutations.mjs` | `M6` 从失效的内联 `setQuickWorkspace(e.target.value)` 改锚**用户交互唯一写点** `setQuickWorkspace(path)`；`M14` 从失效的内联三元改锚 `showForget={...}`；**新增 M16** 盯 hook 里判定调用点的 `recent` |
| `scripts/release-preflight.mjs` | `KNOWN_PROBE_DEBT` 里 quick-workspace 一条**销账删除**（只剩 model-picker），并写明重锚经过 |
| `scripts/lib/d17-p5a-exit-check.py` §6 | P5-1 亲手列的"入口保留两个 quick-intake 设置写入点"两条 → **整体移交** `d17-p6b-exit-check.py`，p5a **141 → 135** |

### P6-2 出口自检与反向变异

`scripts/lib/d17-p6b-exit-check.py`：**8 节 153 项、退出 0**（§1 入口不再自建 / §2 唯一所有者（并替 P6-1 守）/ §3 HTTP 归属与纯度 /
§4 跨域注入 / §5 上游接管与调用顺序 / §6 刻意留在装配层的还在 / §7 结构指纹 / §8 ADR-0008 结构硬门与度量）。
`scripts/lib/d17-mutate-p6b.py`：**13/13 全被捕获、退出 0**，还原后 **sha256 逐字节一致**。
探针：`probe-quick-workspace-mutations` **13/15 → 16/16**（M6/M14 重锚 + 新增 M16）；其余五条本批未改。

### P6-2 度量与验证

入口 **3733 → 3513（-220）**；`WorkbenchApp` **2274 → 2090（-184，L171–2260）**；体内 `useState(` **25 → 17**、
`api(` **27 → 13**、`useEffect(` **4 → 3**。累计：入口 5725 → 3513（-2212）；`WorkbenchApp` 4197 → 2090（-2107）；距 ≤900 护栏还差 1190。
新文件：`hooks/useWorkbenchQuickIntake.ts` 364 行、纯模块 `intakeHelpers.ts` 66 行。

## P6-3 明细（AI 会话域）

| 职责 | 新 owner | 旧实现处理 | 扫描范围 | 变异锚点 |
|---|---|---|---|---|
| 12 项 state + `promptResolveRef` + 9 个动作（`loadSkills` / `askUserPrompt` / `confirmPrompt` / `cancelPrompt` / `toggleSkill` / `AI_PROMPT_LABELS` / `openSessionInPanel` / `startAISession`（468 行）/ `reuseAiSessionId`） | `hooks/useWorkbenchAISessions.ts`（**914 行**） | 入口多段整段删除换指针注释（≥3 处） | §1 入口 0 命中 + 无第二份定义；§2 `owners_of` 恰为本 hook（并替 P6-1/P6-2 守）；§3 会话/技能/模型路由在本域、无 `fetch`、0 定时器 | **M-P6c-1/2/3/4** 等 13 条（同一状态两个 owner / 成组动作拆回两处 / 跨域注入被掐断 / 域边界与纯度） |
| **新增** `resetClarifyPicker()` | 同 hook | 新提取的动作：角色复位 `INHERIT_PERSONA` + 技能复位 + 重拉技能目录；供入口 `openQuickEntry` 组装（P6-2 的交接口） | §1 只在 hook 定义；§5 与 `openQuickEntry` 的先后 | — |
| `promptPersona` vs `quickPersona`；`promptModelSelection` vs `quickModelSelection` | 同 hook | **两份状态一个字没改、不许合并**，也**不新增实时同步 effect** | §1 各声明原文恰好 1 处 | — |
| `openQuickEntry` 的两半段组合 / AI 会话 JSX 与调用点 | **留装配层** | 只换来源、不改调用点文本 | §6 | — |

### P6-3 需要同步迁移的既有判据（本批已改，6 处）

| 文件 | 改了什么 |
|---|---|
| `test/personaWiring.test.mjs` | 新增 `aiHookSource` 常量，**5 条断言改扫** `hooks/useWorkbenchAISessions.ts`，入口**补负向** |
| `test/progressWiring.test.mjs` | 新增 `clientAiHook`，三处提示词切片改从 hook 切，并补 `assert.ok(consult.length > 100)` **防负向断言空洞通过** |
| `test/modelPickerDegrade.test.mjs` | 模型选择器的提交路径改扫 hook；**三条负向对入口与 hook 都扫** |
| `test/quickIntakeClient.test.mjs` | clarify 分支改扫 hook |
| `scripts/lib/d17-p5c-exit-check.py` §6 与 §8 | 计划复用判定（`hasPendingPlanDraft`）随 `reuseAiSessionId` 搬进 hook ⇒ **151 → 152 项** |
| `scripts/lib/d17-p4-exit-check.py` | 随 `startAISession` 搬走的那句按"判据跟着 owner 走"改指 hook（脚本内注明） |

### P6-3 出口自检与反向变异

`scripts/lib/d17-p6c-exit-check.py`：**8 节 198 项、退出 0**（§8 的 `direct_state` 在 P6-4 收尾由 5 改成 0，项数 **203 → 198**）。
`scripts/lib/d17-mutate-p6c.py`：**13/13 全被捕获、退出 0**，还原后 **sha256 逐字节一致**。

> ⚠️ **本批抓到的教训（已写进纪律）**：`M-P6c-5`（入口把判活回调写死成 `isAlive: () => true`）**第一次跑没被抓住** ——
> 判据只做 `"    isAlive: () => instanceAlive," in INDEX_BARE`，而这段原文在入口**出现过两次**（知识域那次 P1 就有）。
> 改成"**两行带上下文原文 + 一条负向**"后立刻变红。
> ⇒ **凡"某段原文在入口出现一次以上"的注入点，断言必须带上下文或计数。**

### P6-3 度量与验证

入口 **3513 → 2830（-683）**；`WorkbenchApp` **2090 → 1406（-684，L172–1577）**；体内 `useState(` **17 → 5**、`api(` **13 → 6**。
累计：入口 5725 → 2830（-2895）；`WorkbenchApp` 4197 → 1406（-2791）；距 ≤900 护栏还差 506。
新增 `hooks/useWorkbenchAISessions.ts` 914 行（**`startAISession` 一个函数就 468 行**，它现在在 hook 里，不触主组件"顶层块 ≤80 行"硬门）。

## P6-4 明细（目录选择域）

| 职责 | 新 owner | 旧实现处理 | 扫描范围 | 变异锚点 |
|---|---|---|---|---|
| 5 项 state（`dirPickerTarget` / `dirPickerPath` / `dirPickerListing` / `dirPickerLoading` / `dirPickerError`）+ `loadDirPickerDir` | `hooks/useWorkbenchDirectoryPicker.ts`（**81 行，零入参**） | 入口声明与列目录请求整段删除换指针注释 | §1 入口 0 命中；§2 `owners_of` 恰为本 hook（并替 P6-1/P6-2/P6-3 守）；§3 本域路由在 hook、无 `fetch`、0 定时器 | 13 条（同构机制） |
| `openDirPicker(target)` | **留装配层** | 不动。**起始目录来自快速录入 / 表单 / 编辑草稿三个域的当前值** —— 是三域读的汇总，谁也不是它的 owner | §4 | — |
| `applyWorkspaceDir(dirPath)` | **留装配层** | 不动。**唯一分派点**：按 `dirPickerTarget` 写回那三个域 | §4 | — |
| 两个死 import（`localDirRequestUrl` / `LocalDirListing`） | **P7 清** | 本批产生，按 P4 的决定不清理 | §7 死 import 名单**必须恰好是这两处**（多了说明还有别的搬家没登记） | — |

### P6-4 需要同步迁移的既有判据（本批已改，1 处）

| 文件 | 改了什么 |
|---|---|
| `scripts/lib/d17-p6c-exit-check.py` §8 | `direct_state == 5` 因本批搬走最后 5 项 `dirPicker*` 变成**假红**（用的是 P6-3 收尾的瞬时值）→ 改成 `== 0` 并注明"那 5 项归 `d17-p6d-exit-check.py` 守"，p6c **203 → 198 项** |

本批**未改任何 `test/*.mjs`、未改任何 `scripts/repro/probe-*.mjs`**。

### P6-4 出口自检与反向变异

`scripts/lib/d17-p6d-exit-check.py`：**8 节 94 项、退出 0**（§8 含 `direct_state == 0`、体内零 `setInterval`/`setTimeout`/裸 `fetch`、
整份入口只剩 1 个 `setInterval`（`titlebarTimer`）且零 `setTimeout`）。
`scripts/lib/d17-mutate-p6d.py`：**13/13 全被捕获、退出 0**，还原后 **sha256 逐字节一致**。
**13 个出口自检全部复跑、全部退出 0**：P1 32 / P2 49 / P3a 47 / P3b 57 / P3c 67 / P3d 103 / P4 161 /
P5a 135 / P5b 152 / P5c 152 / P6b 153 / P6c 198 / P6d 94。
**六个探针（P6-4 收尾统一复跑）**：capacity **20/20**、listview **17/17**、knowledge-draft-overwrite **19/19**、
knowledge-recall **46/46**、quick-workspace **16/16**、model-picker **7/10**（**3 条未捕获 B7/B8/B10**，锚点失效、无真盲点）。
⇒ **P6 收尾后唯一剩下的探针欠账只有 model-picker 的 B7/B8/B10**（`KNOWN_PROBE_DEBT` 现在只剩它一条）。

### P6-4 度量与验证

入口 **2830 → 2814（-16）**；`WorkbenchApp` **1406 → 1389（-17，L173–1561）**；体内直接 `useState(` **5 → 0**、
`api(` 仍 6（P7 欠账）、`useEffect(` 仍 3。
累计：入口 5725 → 2814（**-2911**）；`WorkbenchApp` 4197 → 1389（**-2808**）；距 ≤900 护栏还差 **489**、距 ≤600 努力目标还差 **789**。
**ADR-0008 结构硬门的一条达成**：`WorkbenchApp` 体内直接 `useState(` = 0（D17 起点 114、P6 开工 27）。
全量：`npx tsc --noEmit` 退出 0；`pnpm build` 退出 0（buildId **`wb-171198408fbddb4d`**、inputs **179**、`lib/client.js` **545.95 kB**）；
`pnpm test` **993 / 992 通过 / 1 失败**（P6 开工 992/991/1 ⇒ **0 回归**；唯一失败＝既有 `test/db.test.mjs` 的 Windows `rmSync` EPERM）。
⚠️ 串行纪律仍然适用（mutate 脚本会改写源码、`pnpm test` 内含 build）；本轮全部串行执行。

## P7-1 明细（入口最后 6 处请求归域）

owner：`src/client/hooks/useTaskData.ts`（P3-4 时 273 行 → 现 **407 行**）+ `src/client/hooks/useWorkbenchSettings.ts`（P5-1 时 252 行 → 现 **311 行**）。

| 请求 | 新 owner | 跨域那一步（留装配层） | 说明 |
|---|---|---|---|
| `linkSessionRequest` | `useTaskData` | 调用点 `linkExistingSession`（还要写草稿/列表域） | 只交**请求原语** |
| `archiveSelectedTask` | `useTaskData` | — | 失败分支的"not found 自愈"（清选中 + 清 ref）仍在 hook |
| `restoreTask` | `useTaskData` | `onTaskRestored: () => taskList.actions.setArchivedMode(false)` | 次序：提示 → 退出归档态 → 刷新 |
| `createTask` | `useTaskData` | `onTaskCreated: () => forms.actions.closeCreate()` | 成功后收起新建弹窗 |
| `createSubtask` | `useTaskData` | `onSubtaskParentCleared: () => forms.actions.setSubtaskParent(null)` | 成功后收起子任务表单 |
| `saveIncludeOverdue` | `useWorkbenchSettings` | — | 失败**回滚** `settings`，不静默失败 |
| `saveDailyCapacity(rawEdit: string)` | `useWorkbenchSettings` | 装配层零入参包壳 `saveDailyCapacity()`：读日期域 `capacityEdit` 原文再递给本域动作 | 输入校验（`<30` → 390、上限 1440）随请求进域 |

规则（两个 hook 的文件头都写了）：**请求形状与它的输入校验归域；把结果接到哪些域的状态归装配层**。

### P7-1 出口自检与反向变异

`scripts/lib/d17-p7a-exit-check.py`：**8 节 72 项、退出 0**。`scripts/lib/d17-mutate-p7a.py`：**6/6 全红、退出 0**。

### P7-1 度量与验证

入口 `src/client/index.tsx` **2814 → 2750（-64）**；`WorkbenchApp` **1389 → 1325（-64）**。
体内 `api(` **6 → 0** —— **ADR-0008「体内 0 业务请求」达成**；`useState(` 仍 0、`useEffect(` 仍 3。

## P7-2 明细（四段 JSX + 装配束）

| 职责 | 新 owner | 扫描范围 | 变异锚点 |
|---|---|---|---|
| 顶栏 JSX | `app/WorkbenchHeader.tsx`（44 行） | 入口恰好 1 处 `<WorkbenchHeader {...assembly} />`；四段组件**不持有 state / 不发请求 / 不 import 域 hook** | 13 个出口自检约 40 处改锚；4 个变异靶点改指新 owner |
| 提示层 JSX | `app/WorkbenchOverlays.tsx`（195 行，用 `<>…</>` 包住） | 同上 | 同上 |
| 主体 JSX | `app/WorkbenchBody.tsx`（224 行） | 同上 | 同上 |
| 弹窗层 JSX | `app/WorkbenchDialogs.tsx`（358 行，用 `<>…</>` 包住） | 同上 | 同上 |
| 装配束 `WorkbenchAssembly` | `app/assembly.ts`（91 行） | 16 个域 hook 结果（类型一律 `ReturnType<typeof useXxx>`）+ `runtime` / `closePanel` / `loadModelModalityTable` / `aiSessionUsable` + **17 个装配层本地值** | — |
| 渲染顺序 | 入口 L715–719 | `WorkbenchHeader` → `WorkbenchOverlays` → `WorkbenchBody` → `WorkbenchDialogs` → `ToastHost`（= 搬迁前 DOM 顺序） | — |
| 搬迁方式 | 一次性生成器 `scripts/lib/d17-cut-p7b.py` | guard 钉死 **17 个边界行** → 读 JSX 之外的绑定 → 生成每段 `const { … } = props.xxx`；**逐字搬出、内层缩进一字未改** | — |

17 个装配层本地值：`collapseAll` / `dayPanelProps` / `now` / `pendingCount` / `linkedSessionIds` / `sessionCandidates` /
`sessionListSnapshot` / `reparentCandidates` / `workspaceChoices` / `openTask` / `openTaskById` / `linkExistingSession` /
`saveDailyCapacity` / `saveEditDraft` / `openQuickEntry` / `openDirPicker` / `applyWorkspaceDir`。

> ⚠️ **与设计稿的偏差（如实登记）**：设计 §3 / §7 拟把主组件移入 `src/client/app/WorkbenchApp.tsx`，
> **实际未移** —— `WorkbenchApp` 仍在 `src/client/index.tsx`（第 92–722 行）；本批搬进 `app/` 的只有
> 「`WorkbenchApp` 返回的四段 JSX」与装配束 `assembly.ts`。

### P7-2 出口自检与反向变异

`scripts/lib/d17-p7b-exit-check.py`：**8 节 220 项、退出 0**（**行数护栏 ≤650 就写在这个脚本里**）。
`scripts/lib/d17-mutate-p7b.py`：**13/13 全红、退出 0**。

### P7-2 需要同步迁移的既有判据（本批已改）

| 范围 | 改了什么 |
|---|---|
| 13 个出口自检（约 **40 处**） | 正向断言改锚 `src/client/app/*.tsx`，入口侧补**负向**断言 |
| 9 个 `test/*.mjs`（共 **12 处**断言） | 同上 |
| 4 个变异靶点 | 改指新 owner |

重锚原则：**正向断言指向真实 owner + 入口侧补负向断言**；所有权没有被放宽 —— 唯一所有者仍由 `owners_of(...) == [owner]` 单独守。

### P7-2 度量与验证

入口 **2750 → 2102（-648）**；`WorkbenchApp` **1325 → 673（-652）**。
P7-2 之前唯一一条「单个顶层块 >80 行」的违例（**676 行的 `return (` 块**）随本批消失。

## P7-3 明细（死代码清理与排版）

| 职责 | 处理 | 扫描范围 |
|---|---|---|
| 入口 **12 个死 import** | 全部清零（P4 起登记的 10 个 + P6-4 新增的 `localDirRequestUrl` / `LocalDirListing`） | 入口 0 项未使用 |
| 130+ 个死解构名 | `scripts/lib/d17-clean-unused.py`（每轮改完立刻跑全项目 `tsc --noEmit`，只要有任何输出就整体还原并 exit 1） | 首跑 `tsc --noEmit --noUnusedLocals` **184 处** → 收尾 **0** |
| 3 处单行死声明 | 手工删 `openTree` / `openTasks` / 模块级 `let activeHost` | — |
| 9 处排版 | `scripts/lib/d17-tidy-p7b.py` | — |
| 既有欠账（**刻意保留**） | `hooks/useDayWorkspace.ts#clearTodayPlan`（搬迁前就存在，与 `clearPlan(date)` 语义重叠） | 只换 owner 不改行为，**不删** |

### P7-3 出口自检与反向变异

9 个出口自检共 **19 条补丁**、8 个变异脚本改锚；`test/personaWiring.test.mjs` 的 `PersonaPicker` 来源断言
改成**两个装配层文件各查一次**。

### P7-3 度量与验证

入口 **2102 → 1972（-130）**；`WorkbenchApp` **673 → 631（-42）**。

### P7 结构硬门与总验证（实测）

| 判据 | 实测 |
|---|---|
| 体内直接 `useState(` / `api(` / `fetch(` | **0 / 0 / 0** |
| 体内 `setInterval(` / `setTimeout(` | **0 / 0** |
| 体内 `useEffect(` | **3**（L283 启动 `refresh` 装配 / L314 `dismissOnTaskChange` / L316 `PENDING_ATTR` DOM 投影） |
| 单个顶层块 | **41 个**，超过 80 行的 **0 个**（最大 66 行 `saveEditDraft`） |
| 行数护栏 | ADR 原值 **≤900**（实测 631 达标）→ 按 ADR「P6 收尾后按实测校准一次」**校准为 ≤650**（写进 `d17-p7b-exit-check.py`）；设计 §2.1 的 ≤600 是努力目标，实测 631 **未达成（差 31）** |
| 出口自检 | **15 个全部退出 0**：P5a 138 / P5b 152 / P5c 152 / P6b 155 / P6c 198 / P6d 96 / P7a 72 / P7b 220；P1–P4 只打印「结果：全部通过」 |
| 反向变异 | **15 个脚本全部真跑 N/N**、还原后逐字节一致（P7a 6/6、P7b 13/13） |
| 探针 | 六个全部 **0 存活**：capacity 20/20、listview 17/17、knowledge-draft-overwrite 19/19、knowledge-recall 46/46、quick-workspace 16/16、model-picker 10/10 |
| preflight | `node scripts/release-preflight.mjs --phase pre` 退出 **0**；`scripts/release-preflight.mjs:60` 的 `KNOWN_PROBE_DEBT` 名单**已清空** |
| 全量 | `npx tsc --noEmit` **0**；`pnpm build` **0**（`lib/client.js` **549.00 kB** / gzip **162.69 kB**）；`pnpm test` **993 / 992 通过 / 1 失败**（唯一失败＝既有 Windows `rmSync` EPERM：`Error: EPERM, Permission denied: \\?\<TEMP>\dsh-personal-workbench-db-*`） |

> **model-picker 的 B7/B8/B10 是探针失效、不是真盲点**：锚点还停在 `src/client/index.tsx`，而提交路径已随 P6-3
> 搬进 `hooks/useWorkbenchAISessions.ts`，门禁成因的调用点在 `src/client/components/ModelPicker.tsx`，变量名从
> `quickModelSelection` 漂到 `modelSelection`；修好后 probe **10/10**，`KNOWN_PROBE_DEBT` 清空。

### P7 未做（如实登记，不得当成已完成）

- **没有开浏览器**跑那 10 套浏览器判据；**没有 `git commit`**（P1–P7 全在工作树）；**没有装盘**；3080 / 19387 端口未动；正式库未迁移；版本号仍 **1.16.2**。
- 环境事实：入口 **1972 行**、`WorkbenchApp` **631 行（第 92–722 行）**、`git show HEAD:src/client/index.tsx` 仍是 **5725 行**（D17 之前的版本）、`git status` 约 100+ 条改动。

## 后续批次预计会假红（登记表）

| 文件 | 触发它的批次 | 现在断言的位置 |
|---|---|---|
| `test/panelStateSource.test.mjs`（27/33/57/67） | P3 或 P7（面板状态相关助手若迁出入口） | 入口里的 `hostSelectedFromMirror` 比较与 `shouldShowPanel(` |
| `test/panelCss.test.mjs`（122/148） | P7（若 `syncSidebarWidth` 相关助手迁出） | 入口的侧栏量宽与 CSS 令牌 |
| `test/clientInvariants.test.mjs`（205） | 全局（按 `rel(path) === 'client/index.tsx'` 找入口） | 扫整个 client 目录后定位入口 |
| `test/capacityWiring.test.mjs`（26/50/65/81） | **P4（日期/容量域，已完成）** | 已改指：入口不许内联候选 filter / `slice(0, 30)` / `todayPromptInfo` 顺序，正向断言指向 `hooks/useDayWorkspace.ts`（新增 `daySource`，两处 `indexOf` 切片补 `assert.ok(start > 0)` 守卫） |
| `test/dayPanelWiring.test.mjs`（23/73） | **P4（已完成）** | 已改指：入口的 `addTaskToPlan` 写入口保留一条反向判据，正向 ≥2 条改扫 `hooks/useDayWorkspace.ts`（新增 `DAY` 常量） |
| `test/quickIntakeDefaultWiring.test.mjs`（32） | **P6-2（已完成）** | **已发生并已重锚**：`applyQuickWorkspaceDecision` 的**逐字切片**改从 `hooks/useWorkbenchQuickIntake.ts` 取（`openQuickEntry` 仍留装配层，补了跨域组合语境） |
| `test/quickWorkspaceDefault.test.mjs`（135/156/219/311）、`test/quickIntakeClient.test.mjs`（363/378） | **P6-2 / P6-3（已完成）** | **已发生并已重锚**：快速录入与工作区默认值接线改指 `hooks/useWorkbenchQuickIntake.ts`（提交闸门仍留入口 ⇒ 入口侧断言保留）；`quickIntakeClient` 的 clarify 分支改指 `hooks/useWorkbenchAISessions.ts` |
| `test/progressWiring.test.mjs`（24/174） | **P3-2 与 P3-4（均已完成）** | 进度卡在详情面板里 → P3-2 改指 `views/TaskDetailPane.tsx`；进度链路与两个任务动作 → P3-4 改指 `hooks/useTaskData.ts`；**P6-3 又新增 `clientAiHook`，三处提示词切片改从 hook 切并补 `assert.ok(consult.length > 100)`** |
| `test/personaWiring.test.mjs`（25）、`test/modelPickerDegrade.test.mjs`（314） | **P6-3（已完成）** | **已发生并已重锚**：`personaWiring` 新增 `aiHookSource`（5 条改扫 hook、入口**补负向**）；`modelPickerDegrade` 提交路径改扫 hook、**三条负向对入口与 hook 都扫** |
| `test/draftBannerSessionJump.test.mjs`（114）、`test/knowledgeRecallRoutes.test.mjs`（254） | **P5-1（已完成）** | 已实测：`knowledgeRecallRoutes` 按登记假红 → 已改指 `src/client/hooks/useWorkbenchSettings.ts` 并补入口负向判据；`draftBannerSessionJump` **无需改动**即通过（"只换来源不改调用点文本"） |
| `test/pluginEntry.test.mjs`（342）、`test/devVerify.test.mjs`（233）、`test/intakeWorkspace.test.mjs`（6） | 无需改（读的是文件存在性/清单，不是知识域符号） | — |

> P3-1 实测结论：上表里凡标 "P3" 的**只有** `progressWiring` 一条与本批无关（进度卡在详情面板，属 P3-2）；
> `clientInvariants` / `panelStateSource` / `panelCss` 在 P3-1 后**没有假红**（全量单测仅剩既有 db EPERM）。
>
> P3-2 实测结论：`progressWiring`（详情装配 `TaskProgress`）与 `capacityWiring` AX-C07（编辑框初值）
> **确实按登记假红**，已改指真实 owner；`personaWiring` / `modelPickerDegrade` 在 P3-2 后**没有假红**。
>
> P3-3 实测结论：上表里标 "P3" 的两条（`panelStateSource` / `panelCss`）与标 P6 的两条
> （`quickIntakeDefaultWiring` 的逐字切片、`quickWorkspaceDefault` / `quickIntakeClient`）在 P3-3 后**都没有假红** ——
> 本批只搬了表单弹窗，没有碰到快速录入与面板状态助手；`clientInvariants` 仍正常定位入口
> （入口文件没被改名/搬迁）。全量单测仍只剩既有 db EPERM，与登记预期一致。
>
> P3-4 实测结论：上表里标 "P3" 的两条（`panelStateSource` / `panelCss`）与标 P6 的三条
> （`quickIntakeDefaultWiring` 的逐字切片、`quickWorkspaceDefault`、`quickIntakeClient`）在 P3-4 后**都没有假红** ——
> 本批只搬任务数据域（state/派生/动作与两个任务动作），没有碰快速录入、工作区默认值与面板状态助手；
> `clientInvariants` 仍正常定位入口。**唯一按登记假红的就是 `progressWiring`**，已改指 `hooks/useTaskData.ts`
> 并补强了"入口 `openTaskById` 必须有 `setView('list')`"这条反向判据。全量单测仍只剩既有 db EPERM。
> P3-1/P3-2/P3-4 各自实测的三条登记项（`panelStateSource` / `panelCss` / `clientInvariants`）**到 P3 收尾为止都还没红** ——
> 说明它们真正对应的批次是 P7（入口组合层）而不是 P3，P4 之后要重新评估这张表的"触发它的批次"列。
>
> **P4 实测结论**：上表**按登记假红的正是标 P4 的两条**（`capacityWiring`、`dayPanelWiring`），已改指
> `hooks/useDayWorkspace.ts` 并补反向判据；**另有三条不在本表登记但确实被 P4 打回**：
> `scripts/lib/d17-p3a-exit-check.py`（`bare()` 撞上入口的 `archivedTasks: taskList.archivedTasks,` 透传键）、
> `scripts/lib/d17-p3d-exit-check.py` §7（`tasks: [...tasks, ...taskList.archivedTasks]` 已进 hook）、
> 以及 `probe-capacity-mutations.mjs` 的 I1（文件归属变了）。三条都已同批重锚。
> 标 P3/P7 的 `panelStateSource` / `panelCss` / `clientInvariants` 在 P4 后**仍没有假红**；标 P5 的
> `draftBannerSessionJump` / `knowledgeRecallRoutes` 与标 P6 的五条也**都没有假红**。全量单测仍只剩既有 db EPERM。
> ⇒ 修订这张表的"触发它的批次"列：`panelStateSource` / `panelCss` / `clientInvariants` **归 P7**（入口组合层），
> 不再是"P3 或 P7"。**新登记**：`d17-p3a-exit-check.py` / `d17-p3d-exit-check.py` 这类**出口自检之间也会互相假红**
> （跨批 `bare()` 口径与结构指纹），P5 起每次搬块后必须**把七个出口自检全跑一遍**，不能只跑本批那一个。
>
> **P5-1 实测结论**：上表标 P5 的两条里，`knowledgeRecallRoutes` **按登记假红**（入口不再发召回端点），
> 已改指 `hooks/useWorkbenchSettings.ts` 并补入口负向判据；`draftBannerSessionJump` **没有假红**。
> **另有一条不在本表登记但确实被 P5-1 打回**：`test/quickWorkspaceDefault.test.mjs:168`
> （`functionBody(stripped, 'saveSettings')`，`saveSettings` 随设置域离开入口），已改成"入口负向 + 正向改指设置 hook"。
> 八个出口自检**全部复跑**（不只看 p5a）：P1/P2/P3a/P3b/P3c/P3d/P4 均**没有假红** —— 这印证了 P4 那条新登记
> （跨批 `bare()` 互相假红）在本批**没有发生**，p4 §"两个 settings 写入留在装配层"两条因为是**负向**断言而天然为真。
> 标 P6 的 `quickIntakeDefaultWiring` / `quickWorkspaceDefault`（其余断言）/ `quickIntakeClient` /
> `personaWiring` / `modelPickerDegrade` 与标 P7 的三条在 P5-1 后**都没有假红**。全量单测仍只剩既有 db EPERM。
> **P5-1 新增登记**：`test/quickWorkspaceDefault.test.mjs` 的 `saveSettings` 那一条 —— P6 若再搬
> `rememberQuickWorkspace`/`forgetQuickWorkspace` 的 `setSettings(...)` 写点，这条的"入口负向"半边会需要再复核。
>
> **P5-2 实测结论**：上表标 P5 的两条里，`draftBannerSessionJump` **没有假红**（提醒弹窗与 `SettingsModal`
> props 全部留在装配层，文本一字未动）；`knowledgeRecallRoutes` 也没有（P5-1 已改指）。
> **另有两处不在本表登记但确实被 P5-2 打回**，且**两处都是"上一批自己写下的"跨批出口自检**：
> `scripts/lib/d17-p5a-exit-check.py` §6「刻意留在装配层」里 P5-1 亲手列的 `loadReminderChannel` /
> `saveReminderPolicy` / `ackReminder` / `resetReminderState` 四条（P5-2 把它们搬走 ⇒ 假红，已删除并注明判据改由 p5b 守，p5a 141 → 137），
> 以及 `scripts/lib/d17-p3d-exit-check.py:198` 的 `currentTaskId()` 计数 3（另两处在 `ackReminder` / `addTaskReminder` 体内 ⇒ 假红，已改成 1）。
> **这正好是 P4 那条新登记的第二次命中**：跨批出口自检会互相假红；P5-2 依纪律把**八个出口自检全部复跑**，
> 除上述两处外 P1/P2/P3a/P3b/P3c/P4 均**没有假红**（p4 那两条"两个 settings 写入留在装配层"是负向断言，天然为真）。
> `test/*.mjs` **一条都没改**（提醒域没有任何客户端文本断言），六个探针**一条都没改**（只有 capacity/listview 两个读入口，锚点都在别域）。
> **P5-2 新增登记**：`d17-p5b-exit-check.py` §6 现有 15 条 JSX props 与 `readNotificationCtor(globalThis) == 2` 的断言 ——
> P5-3 若把提醒弹窗 / `SettingsModal` / `TaskDetailPane` 的 props 提纯成视图组件（设计 §5 列为可提纯），
> 这批 props 文本会离开入口，p5b §6 必须跟着 owner 走改成"视图组件里存在 + 入口不再内联"。
>
> **P6 实测结论（P6-1～P6-4 全部完成）**：上表标 P6 的条目**全部按登记假红、并已同批重锚** ——
> `quickIntakeDefaultWiring`（逐字切片改从 `hooks/useWorkbenchQuickIntake.ts` 取）、
> `quickWorkspaceDefault` / `quickIntakeClient`（快速录入与 clarify 接线改指 `hooks/useWorkbenchQuickIntake.ts` / `hooks/useWorkbenchAISessions.ts`）、
> `personaWiring`（新增 `aiHookSource`，5 条改扫 hook + 入口负向）、`modelPickerDegrade`（提交路径改扫 hook，三条负向对出口与 hook 都扫）。
> **另有多处不在本表登记但确实被 P6 打回、已同批重锚**：`test/taskDetailWiring.test.mjs`（P6-1）、
> `test/progressWiring.test.mjs`（P6-3，并补 `assert.ok(consult.length > 100)` 防"切片取空 ⇒ 负向断言恒真"）、
> `scripts/repro/probe-quick-workspace-mutations.mjs`（P6-2：M6/M14 重锚 + 新增 M16 ⇒ **16/16**）、
> `scripts/lib/d17-p3b-exit-check.py` §7（56→57）、`d17-p5a-exit-check.py` §6（141→135）、
> `d17-p5c-exit-check.py` §6/§8（151→152）、`d17-p4-exit-check.py`、`d17-p6c-exit-check.py` §8（203→198）。
> **探针欠账只剩 model-picker 的 B7/B8/B10** —— `scripts/release-preflight.mjs` 的 `KNOWN_PROBE_DEBT` 现在只剩它一条
> （quick-workspace 一条已随 P6-2 的 16/16 销账删除）。
>
> **P7 实测结论（P7-1～P7-3 全部完成）**：上表里 P4 修订后标"归 P7"的三条
> （`test/panelStateSource.test.mjs` 27/33/57/67、`test/panelCss.test.mjs` 122/148、`test/clientInvariants.test.mjs` 205）
> **本批不需要重锚** —— 它们的锚点都在入口的**模块作用域**（`hostSelectedFromMirror()` 入口 L1560、
> `syncSidebarWidth` 入口 L1815、`clientInvariants` 按相对路径 `client/index.tsx` 定位入口），
> 而 P7-2 只动 `WorkbenchApp` 体内的 JSX、入口文件没有改名或搬迁；终态 `pnpm test` **993 / 992 通过 / 1 失败**（唯一失败＝既有 db EPERM）。
> **P7 的实际重锚面是新 owner `src/client/app/*.tsx`**：13 个出口自检约 40 处 + 9 个 `test/*.mjs` 共 12 处断言 + 4 个变异靶点（P7-2）；
> 9 个出口自检 19 条补丁 + 8 个变异脚本改锚 + `test/personaWiring.test.mjs` 的 `PersonaPicker` 来源断言改成两个装配层文件各查一次（P7-3）。
> **P7 新增登记**：设计 §3/§7 拟把 `WorkbenchApp` 移入 `app/WorkbenchApp.tsx`，**实际未移**（主组件仍在入口 L92–722，
> 搬走的是四段 JSX 与装配束 `app/assembly.ts`）；`hooks/useDayWorkspace.ts#clearTodayPlan` 死代码评估后**保留**
> （搬迁前即存在，**不是 D17 引入的欠账**）。
