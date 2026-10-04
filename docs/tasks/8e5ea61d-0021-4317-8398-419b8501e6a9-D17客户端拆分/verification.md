# D17 验证证据（逐批次累积）

> 证据原则：**每条结论后面必须是真实命令与真实输出**。没跑过的层写在"未验证"里，不写"应该没问题"。
> 命令里的行数口径 = 去掉 CRLF 后的物理行数（`scripts/lib/d17-measure2.py`）。

## P0 施工起点（`f99bf77`）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | — |
| `pnpm build` | 0 | — |
| `pnpm test` | 1 | **984 条 / 983 通过 / 1 失败 / 0 跳过**；唯一失败 = `test/db.test.mjs` 的 `db migrations, dictionaries and task tree`（Windows 清理期 EPERM，既有） |

行数基线：入口 **5725**、`WorkbenchApp` **4197**（276–4472）、主组件直接 `useState` **114**。

## P1 知识域

### 改动规模

| 项目 | before | after | Δ |
|---|---|---|---|
| `src/client/index.tsx` | 5725 行 / 353277 字节 | **5451 行 / 341671 字节** | **-274** |
| `WorkbenchApp` 本体 | 4197 行（276–4472） | **3975 行**（224–4198） | **-222** |
| 新增 `src/client/hooks/useKnowledge.ts` | — | 384 行 | — |
| 新增 `src/client/views/KnowledgeListView.tsx` | — | 90 行 | — |
| 新增 `src/client/views/KnowledgeDetailPane.tsx` | — | 97 行 | — |

### 命令证据

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | **0** | 无输出 |
| `pnpm build` | **0** | `lib\client.js 532.70 kB │ gzip: 157.67 kB`；buildId **`wb-3e0060bd905eb893`**；inputs **153** |
| `pnpm test` | 1 | **984 条 / 983 通过 / 1 失败**；失败仍是既有 `test/db.test.mjs` EPERM —— **通过数与施工起点持平（983 ≥ 983），0 回归** |
| `node --test test/listViewWiring.test.mjs test/workspacePickerWiring.test.mjs` | 0 | **30 条 / 30 通过**（判据搬家后全绿） |
| `python scripts/lib/d17-p1-exit-check.py` | **0** | 31 项机械核对全过（见下） |

### 出口自检（`d17-p1-exit-check.py`，31 项）

1. 入口 `index.tsx` 中 **21 个知识域实现名全部 0 命中**：`knowledgeEntries` / `knowledgeFilters` /
   `selectedKnowledge` / `knowledgeDraft` / `knowledgeEditId` / `knowledgeRefreshKey` / `localDocPath` /
   `filePickerOpen` / `filePickerListing` / `filePickerLoading` / `filePickerError` / `summarizeLocalDoc` /
   `loadKnowledge` / `knowledgeDicts` / `knowledgePage` / `readKnowledgeFilters` / `writeKnowledgeFilters` /
   `KNOWLEDGE_FILTER_STORAGE_KEY` / `KnowledgeToolbar` / `KnowledgePager` / `KnowledgeList `。
2. 入口恰好一处 `<KnowledgeListView>` + 一处 `<KnowledgeDetailPane>`；`useKnowledge` 在顶层无条件调用；
   `startAISessionRef.current = startAISession` 在位。
3. 三个新文件都不自建第二份知识状态；`readKnowledgeFilters` / `writeKnowledgeFilters` 各恰好一处定义；
   存储键字面量 `dsh.personal-workbench.knowledgeList` **全客户端只出现 1 次**。

### 反向验证（规范 §8.5：基线绿 → 注入相同缺陷必红 → 还原再绿）

脚本 `scripts/lib/d17-mutate-p1.py`；被改文件 `src/client/hooks/useKnowledge.ts`。

| 变异 | 注入的缺陷 | 结果 |
|---|---|---|
| 基线 | — | sha256 `806ee5a5cf0718b26db157f5c63bb8938653bd1f2545464caadcc64ca2b4948d` |
| **M-P1-1** | `items: entries.map(toContentItem)` → `items: entries`（列表不再经 `listPresentation` 统一适配） | 退出码 **1**，红灯 = `接线：知识库列表由 listPresentation 判定，组件不再自己过滤/排序` |
| **M-P1-2** | 分类对账 effect 里追加 `setFilters({ ...(fixed ?? filters), page: 0 })` | 退出码 **1**，红灯 = `接线：知识库状态只有一个入口，落盘在 effect 里而不是 setState 更新函数里` |
| 还原 | 从备份整份拷回 | sha256 **与基线逐字符相同**，`.mutbak` 残留 0 |

（定向运行文件 = `test/listViewWiring.test.mjs`，故 "tests=25" 是**该文件的用例数**，不是全量。）

### 未验证 / 覆盖缺口（不得当作通过）

1. **浏览器 B 层没有知识域专属场景**：`scripts/verify/suites.json` 现役 10 套里没有 `knowledge` 场景。
   因此 P1 的行为级覆盖**只有**源码接线判据 + 结构自检；知识 CRUD / 筛选 / 关联任务 / 文档入口的
   真实点击与重读**未验证**。设计文档 §9 的 B02 场景仍未补。
2. **整条 `dev-verify` 链未重跑**（本批只跑了定向单测）。跑全链需要隔离 DB 与重启 3080，属独立操作。
3. `scripts/release-preflight.mjs --phase pre` **未跑**；已知它当前**不会退出 0**（`KNOWN_PROBE_DEBT` 里
   `model` B7/B8/B10 与 `quick-workspace` M6/M14 的失效锚点，`judgeProbes` 对 stale/unreliable 无条件硬红）。
   设计文档 §10.3 已把这两块列为**独立测试基建提交**，且明确"未解决时交付报告写'代码判据完成、整体门禁未完成'"。
4. P1 没有触及任何变异探针的作用域（现役探针里没有针对知识域的），所以**本批不需要探针重锚**；
   后续批次动到 capacity / day-panel / quick-workspace / model-picker 相关接线时**必须同批重锚**。

### P1 出口判据逐条对照（设计文档 §2.1）

| 判据 | P1 状态 |
|---|---|
| 1. `WorkbenchApp` ≤600 行 | ❌ 未达成（3975），属 P2–P7 的总出口；P1 只要求"变小且不引入半成品" |
| 2. 入口总行数下降且记录 before→after | ✅ 5725 → 5451（-274），已记 |
| 3. 五视图 + 任务详情各自成组件 | 🟡 知识视图**已完成**（左右各一个组件）；today/calendar/list/ideas + 任务详情未开工 |
| 4. 状态唯一所有者 | ✅ 知识域 11 项 + 派生/ref/effect 全部单一 owner，旧实现已删 |
| 5. 行为/DOM/CSS/存储键保持 | ✅ 存储键原样；`KnowledgeListView` 内 `LocalDocModal` 仍是 **file 模式 + portal 到 body**；`KnowledgeToolbar/List/Pager` 的 props 与 data 属性未改；**无行为修复混入** |
| 6. 每个提交可运行、不提交双实现 | ✅ 入口里知识域 0 残留（自检第 1 组）；`typecheck`/`build`/全量单测均绿（除既有 EPERM） |

## P2 点子域

### 改动规模

| 项 | before | after | Δ |
|---|---|---|---|
| `src/client/index.tsx` 总行数 | 5451（P1 后） | **5138** | **-313** |
| `WorkbenchApp` 本体（第 226–3885 行） | 3975 | **3660** | **-315** |
| `src/client/hooks/useIdeas.ts` | — | 新增 267 行 | — |
| `src/client/views/IdeasListView.tsx` | — | 新增 109 行 | — |
| `src/client/views/IdeasDetailPane.tsx` | — | 新增 105 行 | — |

（入口字节数 341671 → 322k 量级；`WorkbenchApp` 之外还留 1478 行（宿主适配 / 其余域 / 弹窗装配），是 P3–P7 的对象。）

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **退出码 0** |
| `pnpm build` | **退出码 0**，`lib/client.js` 520.51 kB（gzip 未单独记录），buildId **`wb-d2f91b530eea9331`**，inputs 156 |
| `pnpm test` | **985 tests / 984 pass / 1 fail**（起点 984/983/1 → **+1 条用例、0 回归**）；唯一失败 = 既有 `db migrations, dictionaries and task tree`（Windows 清理期 `rmSync` EPERM） |
| `node --test test/listViewWiring.test.mjs` | **26/26 通过**（含本批新增 1 条 + 改写 1 条） |
| `python scripts/lib/d17-p2-exit-check.py` | **退出码 0**，5 组共 45 项全过 |
| `python scripts/lib/d17-p1-exit-check.py` | **退出码 0**（P1 判据未被 P2 打回） |
| `python scripts/lib/d17-mutate-p2.py` | **3/3 条变异被断言发现**，还原后 sha256 逐字节一致 |

### 出口自检（`d17-p2-exit-check.py`，5 组 45 项）

1. 入口对 **22 个**点子域实现名（12 状态 + `loadIdeas` + `ideaCardItems` + `unfiledIdeas` + `refreshIdeas`/`saveFolder`/`deleteFolder`/`fileIdeaInto`/`unfileIdeaFrom`/`mergeFolderInto` + `IdeaCardGrid`/`IdeaCardItem`）**全部 0 命中**；
2. 入口恰好 1 处 `<IdeasListView>` + 1 处 `<IdeasDetailPane>`，`const ideas = useIdeas({` 顶层无条件调用，`const ideasAll = ideas.allIdeas`，`ideas.actions.refresh()` 在位；
3. 两个视图**不发 HTTP**（无 `api(` / `fetch(`）、**不自建** `useState`/`useEffect`；
4. hook 里 15 个动作各**唯一实现**；
5. **新增**：客户端源码里 `clearSelection` 0 处 —— "清两份"这个语义拆分前不存在，不许在拆分中被引入。

### 反向验证（规范 §8.5：基线绿 → 注入相同缺陷必红 → 还原再绿）

脚本 `scripts/lib/d17-mutate-p2.py`，被改文件基线 sha256：
`src/client/hooks/useIdeas.ts` = `d2635863418501db6a463afc80891e6f9a0cd8ff2359aba0a0415843969c83a2`、
`src/client/views/IdeasListView.tsx` = `86bba728e6235e1d66b722e5b76aaf27f40dfd22be86fdb8c664cd7ba8dffdf0`。

| 变异 | 结果 | 红灯判据 |
|---|---|---|
| **M-P2-1** 页签切换改回"两份都清" | 退出码 1 | `接线：点子页签只清"另一个"选择…` |
| **M-P2-2** 两个"点开点子"合并回一个动作 | 退出码 1 | 同上 |
| **M-P2-3** 视图自己再清一次选择（重新引入 `clearSelection`） | 退出码 1 | 同上 |

还原后两个文件的 sha256 与基线**逐字节相同**、无 `.mutbak` 残留。
这三条不是随便挑的 —— 它们是 P2 **第一版真的写错的两处语义**（见 `migration-matrix.md` §P2 语义对照），
所以本脚本保证"再写错一次立刻红"。

### 变异探针（本批**不需要重锚**，但必须实测确认没打坏）

| 探针 | 结果 | 结论 |
|---|---|---|
| `scripts/repro/probe-listview-mutations.mjs` | **17/17 全红**，退出码 0 | P2 动过 `listViewWiring.test.mjs` 的锚点，未打坏 |
| `scripts/repro/probe-capacity-mutations.mjs` | **20/20 全红**，退出码 0 | 与 P2 无交集，确认无副作用 |
| `scripts/repro/probe-quick-workspace-mutations.mjs` | 2/15 未捕获（**M6/M14 变异点没匹配上**） | 既有失效欠账，`KNOWN_PROBE_DEBT` 已登记，属 P6 |
| `scripts/repro/probe-model-picker-notify-mutations.mjs` | 3/10 未捕获（**B7/B8/B10 变异点没匹配上**） | 同上 |

> ⚠️ **踩坑（本批踩到一次假红）**：探针运行期间会**临时变异源码再还原**。我在探针还没跑完时并行跑了
> `node --test test/listViewWiring.test.mjs`，于是读到了被临时改小的 `.wb-idea-foldmenu` z-index，
> 得到 `菜单 z-index(40) 必须高于面板宿主(55)` 的**假红**。规矩：**不要一边跑探针一边跑测试。**
> 另一处假红（探针 M14/B7/B8/B10 的"变异点没匹配上"）在探针汇总里是**显式报错**而不是静默通过，符合设计 §8.3。

### 未验证 / 覆盖缺口（不得当作通过）

1. **浏览器 B 层仍然没有点子域的专属场景**：`scripts/verify/suites.json` 现役 10 套里没有 `ideas` 场景。
   所以 P2 的行为级覆盖**只有**源码接线判据 + 与 HEAD 的逐条文本对照；设计文档 §9 的 **B03（点子全链）未补**。
   本批修回的两处语义偏差**正是靠文本对照发现的** —— 这说明"没有浏览器场景"是真缺口，不宜再往后拖。
2. **整条 `dev-verify` 链未重跑**（本批只跑定向单测 + 四个探针）。
3. `scripts/release-preflight.mjs --phase pre` **未跑**；理由与 P1 相同（`KNOWN_PROBE_DEBT` 的 model/quick 失效锚点，
   `judgeProbes` 对 stale/unreliable 无条件硬红；设计文档 §10.3 把它列为独立测试基建提交）。
4. 与 HEAD 的对照是**文本级**逐条核对（同一段代码在两边逐字比对），不是运行期等价性证明；
   `startCreate` 的三个 setter 调用顺序与 HEAD 不同（`setEditId`→`setSelectedIdea`→`setDraft` vs
   HEAD 的 `setIdeaEditId`→`setIdeaForm`→`setSelectedIdea`）——同一事件内 React 批处理，判定为**无可观察差异**，
   如实记录而不是声称"逐字相同"。

### P2 出口判据逐条对照（设计文档 §2.1）

| 判据 | P2 状态 |
|---|---|
| 1. `WorkbenchApp` ≤600 行 | ❌ 未达成（3660），属 P3–P7 的总出口 |
| 2. 入口总行数下降且记录 before→after | ✅ 5451 → 5138（-313），P1+P2 累计 5725 → 5138（-587） |
| 3. 五视图 + 任务详情各自成组件 | 🟡 知识 ✅ / 点子 ✅；today/calendar/list + 任务详情未开工 |
| 4. 状态唯一所有者 | ✅ 点子域 12 项 + 派生 + 动作全部单一 owner，旧实现 0 残留 |
| 5. 行为/DOM/CSS/存储键保持 | ✅ 无 CSS/文案/存储键改动；两处**语义偏差已修回拆分前行为**（不是"顺手改行为"，是"改回原行为"）；发现的 `/**` 未闭合注释按真 bug 修（修的是注释配平，不改业务） |
| 6. 每个提交可运行、不提交双实现 | ✅ 入口里点子域 0 残留（自检第 1 组）；typecheck/build/全量单测均绿（除既有 EPERM） |

## P3-1 任务列表域

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 5138 行 | **5034 行** | **-104** |
| `WorkbenchApp` 本体 | 3660 行（L226–3885） | **3568 行（L214–3781）** | **-92** |
| 主组件之外的入口代码 | 1478 行 | 1466 行 | -12 |
| 新增 `src/client/hooks/useTaskListModel.ts` | — | 新文件 | 七个 state + effect + 5 派生 + 10 动作 |
| 新增 `src/client/views/TaskListView.tsx` | — | 108 行（入口原 96 行 JSX） | 纯展示，无 state/HTTP |

累计：入口 5725 → 5034（**-691**）；`WorkbenchApp` 4197 → 3568（**-629**）。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **退出 0**（首轮 5 条报错：`readonly Task[]` 不能传 `buildTaskTree`、入口残留 `archivedTasks`/`setArchivedMode`；入参改可变数组 + hook 暴露只读快照后清零） |
| `pnpm build` | **退出 0**，`lib\client.js 534.10 kB │ gzip: 157.89 kB` |
| `pnpm test` | **985 tests / 984 pass / 1 fail**（唯一失败＝既有 `db migrations, dictionaries and task tree` 的 Windows 清理期 `rmSync` EPERM；P2 收尾同口径，**0 回归**） |
| `node --test test/listViewWiring.test.mjs` | **28/28 通过** |

### 出口自检（`scripts/lib/d17-p3a-exit-check.py`，47 项、退出 0）

| 组 | 内容 |
|---|---|
| 1 | 入口 20 个列表域名字**裸名 0 命中**（`(?<![\w.])name\b`，排除 `taskList.` 前缀） |
| 2 | `const taskList = useTaskListModel({ tasks, dictOf })`、`<TaskListView` 一处、`taskList.actions.clearExpanded()`、`taskList.actions.setArchivedMode(false)`、`...taskList.archivedTasks]` 各在位 |
| 3 | 视图不发 `api|fetch`、无 `useState`/`useEffect`/`useMemo` |
| 4 | hook 里 8 个 `= useCallback` 动作与 7 个 `const [x, ` state 各唯一 |
| 5 | 剥注释后全客户端扫描：`TREE_EXPANDED_STORAGE_KEY` 恰好 1 处、空筛选字面量只在 `src/client/taskFilterSort.ts` |

### 反向验证（`scripts/lib/d17-mutate-p3a.py`，4/4 全红、退出 0）

基线 sha256：`hooks/useTaskListModel.ts` = `0a2209935d1255a88ccd6a02e6508fb6e357d324f3fca732c6bfa50adaa4b3ab`、
`views/TaskListView.tsx` = `db2a286a8b6dbdd266bcbbb852fc4372f83f197c728e2554a6cdb6204cfb8b48`（还原后逐字节一致）。

| 变异 | 被哪条判据抓住 |
|---|---|
| M-P3A-1 清空筛选改回内联字面量 | 「唯一口径的键与常量不许复制」（两文件都检查） |
| M-P3A-2 api 调用塞进 `setArchivedMode((prev) => …)` | 「归档切换的副作用不许写进 setState 更新函数」 |
| M-P3A-3 视图自己 `useState` | 「列表视图是纯展示」 |
| M-P3A-4 视图自己发 `api(...)` | 「列表视图是纯展示」 |

### 变异探针（**本批有一处必须重锚**）

- `scripts/repro/probe-capacity-mutations.mjs` 的 **I1** 锚点原来写 `[tasks, archivedTasks, todayPlan, …]`，
  归档集合搬进 hook 后该文本不存在 → **不重锚就是 stale，`judgeProbes` 无条件硬红**。
  已改为 `[tasks, taskList.archivedTasks, todayPlan, …]`（变异体同样换名）并加注释说明重锚原因。
  重锚后实跑：**20/20 条变异都变红、退出码 0**。
- `probe-listview-mutations.mjs`：`INDEX` 是死常量（无变异用它），本批不涉及。
- `probe-model-picker-notify-mutations.mjs`（B7/B8/B10）、`probe-quick-workspace-mutations.mjs`（M6/M14）
  仍是既有失效欠账、已在 `KNOWN_PROBE_DEBT` 登记，属 P6 职责 —— **本批不动**。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有开浏览器**：列表视图的搜索/筛选/排序/类型页签/归档切换/空态只做了源码级与单测级验证；
  P3-1 的浏览器场景（B01/B04 一部分）归 P7 总回归，本批不宣称通过。
- `pnpm build` 的 buildId 与 3080 实例无关（未装盘、未重启）。
- 未跑 `scripts/dev-verify.mjs` 全链（起点就未端到端重跑，且本批无隔离 DB 配置变更）。

### P3-1 出口判据逐条对照（设计文档 §2.1）

| 判据 | P3-1 状态 |
|---|---|
| 1. `WorkbenchApp` ≤600 行 | ❌ 未达成（3568），属 P3-2–P7 的总出口 |
| 2. 入口总行数下降且记录 before→after | ✅ 5138 → 5034（-104），累计 5725 → 5034（-691） |
| 3. 五视图 + 任务详情各自成组件 | 🟡 知识 ✅ / 点子 ✅ / **list ✅**；today、calendar 与任务详情未开工 |
| 4. 状态唯一所有者 | ✅ 列表域 7 项 state + effect + 5 派生 + 10 动作单一 owner，入口 0 残留（自检第 1 组）；空筛选字面量收敛回共享常量 |
| 5. 行为/DOM/CSS/存储键保持 | ✅ 无 CSS/文案改动；存储键与该 key 的读写位置不变；归档副作用顺序逐字保留并写成判据 |
| 6. 每个提交可运行、不提交双实现 | ✅ typecheck/build/全量单测均绿（除既有 EPERM）；旧职责同批删除，无第二份实现 |

## P3-2 任务详情面板

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 5034 行 | **4754 行** | **-280** |
| `WorkbenchApp` 本体 | 3568 行（L214–3781） | **3285 行（L217–3501）** | **-283** |
| 主组件之外的入口代码 | 1466 行 | 1469 行 | +3（新增 `restoreTask`/`createSubtask` 两个注入回调） |
| 新增 `src/client/app/contracts.ts` | — | 32 行 | `WorkbenchView` / `TaskEditDraft` 两个跨域类型 |
| 新增 `src/client/hooks/useTaskDetailModel.ts` | — | 94 行 | 6 个 state + 3 个语义动作 |
| 新增 `src/client/views/TaskDetailPane.tsx` | — | 430 行（入口原 329 行 body） | 纯展示，无 state/HTTP |

累计：入口 5725 → 4754（**-971**）；`WorkbenchApp` 4197 → 3285（**-912**），距 ≤600 还差 2685 行。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **退出码 0**（首轮即通过，本批无 typecheck 返工） |
| `pnpm test` | **992 tests / 991 pass / 1 fail**（起点 985/984/1 ⇒ **+7 用例、0 回归**；唯一失败＝既有 `db migrations, dictionaries and task tree` 的 Windows 清理期 `rmSync` EPERM） |
| `node --test test/taskDetailWiring.test.mjs` | **5/5 通过**（本批新增） |
| `node --test test/progressWiring.test.mjs test/capacityWiring.test.mjs` | 通过（两条既有判据改指新 owner 后） |
| `python scripts/lib/d17-p3b-exit-check.py` | **退出码 0**，7 组共 **56 项**全过 |
| `python scripts/lib/d17-p1-exit-check.py` / `d17-p2-exit-check.py` / `d17-p3a-exit-check.py` | **均退出码 0**（32 / 49 / 47 项；P1/P2/P3-1 判据未被 P3-2 打回） |
| `python scripts/lib/d17-mutate-p3b.py` | **6/6 条变异被断言发现**，还原后 sha256 逐字节一致 |

### 出口自检（`d17-p3b-exit-check.py`，7 组 56 项）

| 组 | 内容 |
|---|---|
| 1 | 入口不再 `useState` 那 6 项；10 个名字（`detailTab`/`sessionPickerOpen`/`eventsExpanded`/`sessionPickerBusy`/`setDetailTab`/`setSessionPickerOpen`/`setSessionPickerRole`/`setSessionPickerQuery`/`setEventsExpanded`/`openSessionPicker`）在入口**一次都不出现** |
| 2 | 入口恰好 1 处 `<TaskDetailPane`、无 `: selected === null` 判定、空态文案无副本；三路分派仍在入口 |
| 3 | 视图纯度：不发 `api|fetch`、无 `useState`/`useEffect`/`useMemo`、不 import 入口 |
| 4 | 6 项 state 的 `const [x,` 全客户端**只在 hook**；三个动作各唯一实现、入口无裸 `setDetailTab`、调用点无两连 setState |
| 5 | **结构指纹**（9 个类名计数）：`wb-detail-tabs` 1 / `wb-detail-tab ${` 4 / `wb-detail-actions` 1 / `wb-session-list` 1 / `wb-session-picker"` 1 / `wb-form-panel` 1 / `wb-event-title` 1 / `wb-card` 7 / `wb-empty` 3 |
| 6 | 三个语义动作的**两行顺序**逐字断言（取出 hook 函数体切片后比对） |
| 7 | 契约不内联：`useState<'today' \| 'calendar'` 全客户端 0 处；`WorkbenchView` / `TaskEditDraft` 定义在 `app/contracts.ts` |

> **本批自检返工（判据写错，不是实现错）**：第一版有 9 项误报 —— ① 入口**解构**出的本地名被"裸名 0 命中"判成"入口还持有状态"；
> ② 结构指纹把**注释里**的 `<div className="wb-card">` 也算进去（先剥注释后是 7、严格计数是 8）；
> ③ 唯一口径比较把 hook 自己漏在集合外。**教训：扫描判据红了先怀疑判据，再怀疑实现。**

### 反向验证（`scripts/lib/d17-mutate-p3b.py`，6/6 全红、退出 0）

基线 sha256：`hooks/useTaskDetailModel.ts` = `fd3ff16b19578b92bf37761b6cbe76de6bfad89676c32d7100945686377dc7fe`、
`index.tsx` = `f0255dc6a6044e759dcb04c5d42d7fe4219ed3e0c54a049014a9ed277efa4849`、
`views/TaskDetailPane.tsx` = `a44b962a930d147dcdb19bf52ba956dd246e8cb8c299304755554c351a1c0137`（还原后逐字节一致）。

| 变异 | 被哪条判据抓住 |
|---|---|
| M-P3B-1 视图内联 `api(...)` | `taskDetailWiring` 第 2 条「视图纯展示」 |
| M-P3B-2 视图自己 `useState` | `taskDetailWiring` 第 2 条 |
| M-P3B-3 `resetDetailView` 两行合成一行 | `taskDetailWiring` 第 4 条 |
| M-P3B-4 入口改回内联联合类型 | `taskDetailWiring` 第 5 条「契约不内联」 |
| M-P3B-5 面板不再装配 `TaskProgress` | `test/progressWiring.test.mjs`（既有判据改指后） |
| M-P3B-6 编辑框初值写死 `''` | `test/capacityWiring.test.mjs` AX-C07（既有判据改指后） |

> 踩坑：变异脚本首跑因没把 stdout 重定向为 utf-8，打印 `✖` 时
> `UnicodeEncodeError: 'gbk' codec can't encode character '\u2716'` 崩溃；`finally` 仍正确还原（sha256 比对确认）。
> 修法：脚本开头 `sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")`。

### 变异探针（**本批有一处必须重锚**）

- `scripts/repro/probe-capacity-mutations.mjs` 的 **I3**（"editDraft 初值改回常量"）原锚 `file: INDEX`，
  而该段代码已搬进 `src/client/views/TaskDetailPane.tsx` → **不重锚就是 stale，`judgeProbes` 无条件硬红**。
  已新增常量 `const TASK_DETAIL_PANE = 'src/client/views/TaskDetailPane.tsx'` 并把 I3 的 `file` 改指它（`from`/`to` 原文不变）。
  重锚后实跑：**20/20 条变异都变红、退出码 0**（I1/I3 两条都在重锚点变红）。
- 其余三个引用入口的探针不锚本批搬走的代码：`repro-task-estimate.mjs` / `repro-quick-workspace-default.mjs` 只用
  `.wb-detail` 这类 DOM 选择器（类名未变）；`probe-listview-mutations.mjs` 的 `INDEX` 是死常量；
  model-picker / quick-workspace 的失效项是既有欠账（属 P6）。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有开浏览器**：详情面板的页签切换/任务进度/会话选择器/记录展开/子任务新建/恢复任务只做了源码级与单测级验证；
  P3-2 的浏览器场景归 P7 总回归，本批不宣称通过。
- **与 HEAD 的等价性是"逐字搬迁"而非运行期证明**：本批只做了 6 处**等价写法替换**（3 个语义动作去重 + 2 处内联请求提成注入回调 + 1 处模块级函数改注入），
  其余 JSX 逐字保留；那 6 处每处都有会失败的判据，但**没有**做逐行走查 diff 的形式化证明。
- `app/contracts.ts` 的新类型只替换了入口两处匿名类型，**没有**推广到其他域（P4–P7 可继续用）。
- 未跑 `scripts/dev-verify.mjs` 全链；未跑 `release-preflight`。

### P3-2 出口判据逐条对照（设计文档 §2.1）

| 判据 | P3-2 状态 |
|---|---|
| 1. `WorkbenchApp` ≤600 行 | ❌ 未达成（3285），属 P3-3–P7 的总出口 |
| 2. 入口总行数下降且记录 before→after | ✅ 5034 → 4754（-280），累计 5725 → 4754（-971） |
| 3. 五视图 + 任务详情各自成组件 | 🟡 知识 ✅ / 点子 ✅ / list ✅ / **任务详情 ✅**；today、calendar 未开工 |
| 4. 状态唯一所有者 | ✅ 详情域 6 项 state + 3 动作单一 owner；同语义的两连调用由入口与视图各写一份 → 收成动作一份 |
| 5. 行为/DOM/CSS/存储键保持 | ✅ 无 CSS/文案/存储键改动；JSX 逐字搬迁；**视图不再发 HTTP**（设计 §3），两处请求本体逐字搬回入口 |
| 6. 每个提交可运行、不提交双实现 | ✅ typecheck/build/全量单测均绿（除既有 EPERM）；详情域旧实现同批删除，无第二份实现 |

## P3-3 任务表单弹窗

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 4754 行 | **4675 行** | **-79** |
| `WorkbenchApp` 本体 | 3285 行（L217–3501） | **3204 行（L219–3422）** | **-81** |
| 主组件之外的入口代码 | 1469 行 | 1471 行 | +2（新增 `useTaskForms` / `TaskFormModal` 两条 import） |
| 新增 `src/client/hooks/useTaskForms.ts` | — | 101 行 | 4 个 state + 1 条表单清空 effect + 8 个语义动作 |
| 新增 `src/client/views/TaskFormModal.tsx` | — | 215 行 | `TaskCreateModal`（非受控）+ `TaskEditModal`（受控），**两个组件不合并** |
| `src/client/views/TaskDetailPane.tsx` | 430 行 | 436 行 | +6（4 个 setter prop 换成语义化的 `editing`/`onOpenEdit`/`onAddSubtask`/`onCancelSubtask`） |

累计：入口 5725 → 4675（**-1050**）；`WorkbenchApp` 4197 → 3204（**-993**），距 ≤600 还差 2604 行。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **退出码 0**（首轮即通过，本批无 typecheck 返工） |
| `pnpm test` | **992 tests / 991 pass / 1 fail**（与 P3-2 后同数 ⇒ **0 回归**；唯一失败＝既有 `db migrations, dictionaries and task tree` 的 Windows 清理期 `rmSync` EPERM） |
| `python scripts/lib/d17-p3c-exit-check.py` | **退出码 0**，7 节共 **67 项**全过（15 / 4 / 7 / 7 / 12 / 6 / 16） |
| `python scripts/lib/d17-p1/p2/p3a/p3b-exit-check.py` | **均退出码 0**（32 / 49 / 47 / 56 项；前三批判据未被 P3-3 打回，p3b 的编辑草稿类型断言已随之改指新 owner） |
| `python scripts/lib/d17-mutate-p3c.py` | **7/7 条变异被断言发现**，还原后 sha256 逐字节一致、还原后基线三条判据退出码全 0 |
| `node scripts/repro/probe-capacity-mutations.mjs` | **20/20 全红、退出码 0**（本批**不需要重锚**，见下） |

### 出口自检（`scripts/lib/d17-p3c-exit-check.py`，7 节 67 项）

| 节 | 内容 |
|---|---|
| 1 | 入口不再自持 4 项 state（`showForm`/`subtaskParent`/`editDraft`/`formWorkspace`）；**不裸用** 5 个 setter（`setShowForm`/`setEditDraft`/`setSubtaskParent`/`setFormWorkspace`/`patchDraft`）；`const forms = useTaskForms()` 恰好 1 处；`const { editDraft, subtaskParent, formWorkspace } = forms` 恰好 1 处；`const { dismissOnTaskChange } = forms.actions`；换任务 effect 依赖正则断言为 `}, [selected?.task.id, dismissOnTaskChange])` |
| 2 | 4 项 state 的 `const [` 全客户端**只有** `src/client/hooks/useTaskForms.ts` 创建（`countInClient` 命中分布断言） |
| 3 | `<TaskCreateModal` / `<TaskEditModal` 各恰好 1 处装配；`open={forms.showForm}`；守卫 `{editDraft !== null && selected !== null && (` 仍在调用点；入口无 `wb-new-task-form` / `name="workspacePath"` / `'\u00a0'.repeat` / `重复：由模板任务管理` 副本 |
| 4 | 视图纯度：不发 `api|fetch`、无 `useState`/`useEffect`/`useMemo`、不 import 入口与域 hook 实现、不出现 `openDirPicker` |
| 5 | **两个弹窗故意不合并**：`export function \w*Modal` 恰好 2 处；`if (!open) return null`；`onPatchDraft({` 恰好 **12** 处；hook 里 null-safe 展开恰好 1 处；入口/两视图 `setEditDraft((prev) =>` 各 0 处；`toggleCreate` 体必须是 `setShowForm((v) => !v)`、`closeCreate` 体必须是 `setShowForm(false)` 且不含 `(v) => !v`（模式 3） |
| 6 | 模式 5（请求本体留装配层）：`const createTask = async (form: FormData): Promise<void> =>`、`const saveEditDraft = async (): Promise<void> =>`、`'/api/workbench/tasks'`、`estimateRangeMessage(DEFAULT_ESTIMATE_MINUTES)`、乐观更新切片 `{ ...task, estimatedMinutes, allDay: editDraft.allDay }` 全在入口；视图里 `/api/workbench` 计数 0 |
| 7 | **结构指纹**：`id="wb-new-task-form"` 1 / `name="workspacePath"` 1 / `wb-form"` 2 / `（顶层）` 1 / **`父任务` 3**（下拉 label + `sourceLabel` 文案里的 2 处）/ `\u00a0` 1 / `AI 策略` 1 / `重复：由模板任务管理` 1 / `wb-form-panel` 0 / `<WorkspacePicker` 2 / `client_meeting`·`p2`·`todo`·`none` 四个 `defaultValue` 各 1 / `rows={2}` 1 / `rows={6}` 1 |

> **本批搬迁脚本踩坑（写同类脚本会再遇到）**：
> ① 编辑弹窗那 12 处 null-safe 展开的尾部**不是** `})` 而是 `})}`（`onChange={(e) => setEditDraft(…)})` 外面还有 JSX 的 `}`），
> 正则必须写成 `… \}\)`；其中 L3395 那处是括号版 `(prev === null ? prev : {…})`，**必须先替换**，否则会多吃一个 `)`。
> ② `settings.defaultEstimateMinutes` 在编辑弹窗里出现 **2 次**（输入框 placeholder + 提示行文案），不能按 1 次断言。

### 反向验证（`scripts/lib/d17-mutate-p3c.py`，7/7 全红、退出 0）

基线 sha256：`hooks/useTaskForms.ts` = `acf1f4ee2da86f44aa6185d1f46fc3e6fd84d8e1a5e6b0b1e529cf7783539413`、
`index.tsx` = `20aebbea944618edae9fe73188a8f33271b28b6a29ab4a5dec75ba191f701540`、
`views/TaskFormModal.tsx` = `46c5ed409daf3e7a524230cee533db5b78fcfcddc2d6e312c9204b7338c229f7`（还原后逐字节一致）。

| 变异 | 被哪条判据抓住 |
|---|---|
| M-P3C-1 视图重新内联 `api` 请求 | p3c 第 4 节「TaskFormModal.tsx 不发 HTTP 请求」+「视图里不出现任何接口路由字面量」 |
| M-P3C-2 视图自己存一份 state | p3c 第 4 节「不自建 state」 |
| M-P3C-3 `closeCreate` 写成开关 | p3c 第 5 节「closeCreate 是关闭语义」+「closeCreate 不许写成开关（模式 3）」 |
| M-P3C-4 入口把 `formWorkspace` 收回去自己 `useState` | p3c 第 1 节 4 条（`不再自己 useState` / `完全不裸用 setFormWorkspace` / `只取自己用到的读取值` / `读取值解构只有一处`） |
| M-P3C-5 跨域 effect 依赖写成 `forms.actions` | p3c 第 1 节「换任务 effect 的依赖是稳定的 `dismissOnTaskChange`，不是 `forms.actions` 对象」 |
| M-P3C-6 表单字段改名 `workspacePath` → `workspace` | `test/workspacePickerWiring.test.mjs`（既有判据改指新 owner 的反向验证） |
| M-P3C-7 编辑草稿丢掉契约类型 | `test/taskDetailWiring.test.mjs`「两份匿名类型收进 `app/contracts.ts`」（既有判据改指新 owner 的反向验证） |

> **脚本能力要点**：`run_checks(files)` 同时支持 `.mjs`（`node --test`）与 `.py`（`sys.executable`）两类目标 ——
> 本批判据一半在 python 出口自检里，只跑 `node --test` 会漏掉 M-P3C-1…5 的发现路径。
> 脚本末尾会「还原后再跑一次基线」并断言退出码全 0，防止"全红"其实是判据自己坏了。
>
> M-P3C-6/7 有意设计成"既有判据改指后的反向验证"：它们不看新文件，只看**被改指的那条旧判据是否还在真实执行**。

### 变异探针（**本批不需要重锚**，逐条实测确认）

- `scripts/repro/probe-capacity-mutations.mjs` = **20/20 全红、退出 0**。I2（payload 删 `estimatedMinutes`）/ I4（客户端就地校验）/
  I5（乐观更新）锚的 `saveEditDraft` 本体**仍留在入口**（本批只把它接到 `onSave` 上，没动内部）；I3（`editDraft` 初值）锚的
  `TASK_DETAIL_PANE` = `src/client/views/TaskDetailPane.tsx` **本批未改这段**；I1 锚容量 memo 依赖数组。四条锚点全部仍然有效。
- `scripts/repro/probe-listview-mutations.mjs` = **17/17 全红、退出 0**；`probe-knowledge-draft-overwrite-mutations.mjs` = 19/19；
  `probe-knowledge-recall-mutations.mjs` = 46/46 —— 均不受本批影响。
- **既有欠账（非本批引入，已用 `git show HEAD:src/client/index.tsx` 对照确认）**：
  `probe-quick-workspace-mutations.mjs` = **13/15**，两条报「变异点没匹配上（源码结构变了，需要同步本探针）」——
  M6 锚 `/setQuickWorkspace\(e\.target\.value\)/`、M14 锚 `{quickWorkspaceSource === 'last-manual' && quickWorkspace.trim() !== '' && !quickWorkspaceTouched && (`，
  **这两条锚点在 HEAD 版里就已经不存在**（现网分别是 `onChange={(path) => { setQuickWorkspaceTouched(true); setQuickWorkspace(path) }}`
  与 `showForget={quickWorkspaceSource === 'last-manual' && !quickWorkspaceTouched}`）；
  `probe-model-picker-notify-mutations.mjs` = **7/10**，3 条同样是 HEAD 版即失效的锚点。
  ⇒ 均属 KNOWN_PROBE_DEBT，归 P6 处理，**不是 P3-3 打坏的**。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有开浏览器**：新建任务的非受控表单提交、编辑弹窗的 12 个字段联动/保存按钮 disabled/父任务下拉缩进、
  两个弹窗的关闭路径（X / 取消 / 保存成功 / 点遮罩）只做了源码级与单测级验证；P3-3 的浏览器场景归 P7 总回归，本批不宣称通过。
- **与 HEAD 的等价性是"逐字搬迁 + 等价写法替换"而非运行期证明**：本批的等价替换只有四类 ——
  `patchDraft` 收 12 处、`toggleCreate`/`closeCreate` 收 3 个调用点、`dismissOnTaskChange` 收 1 条 effect 的两连 setState、
  `setSubtaskParent` 收 3 处；加 `{showForm && (…)}` → `open` + `if (!open) return null`。其余 JSX 逐字保留。
  每类都有会失败的判据（p3c 第 1/3/5 节），但**没有**做逐行走查 diff 的形式化证明。
- **`probe-quick-workspace-mutations` / `probe-model-picker-notify-mutations` 的 KNOWN_PROBE_DEBT 未修**（有意留 P6：
  它们锚的是快速录入与模型选择器接线，提前改会与 P6 的搬迁互相踩）。
- 未跑 `scripts/dev-verify.mjs` 全链；未跑 `release-preflight`。

### P3-3 出口判据逐条对照（设计文档 §2.1）

| 判据 | P3-3 状态 |
|---|---|
| 1. `WorkbenchApp` ≤600 行 | ❌ 未达成（3204），属 P3-4 + P4–P7 的总出口 |
| 2. 入口总行数下降且记录 before→after | ✅ 4754 → 4675（-79），累计 5725 → 4675（-1050） |
| 3. 五视图 + 任务详情各自成组件 | 🟡 知识 ✅ / 点子 ✅ / list ✅ / 详情 ✅；**任务表单弹窗 ✅（本批）**；today、calendar 未开工 |
| 4. 状态唯一所有者 | ✅ 表单域 4 项 state + 8 个动作单一 owner（`useTaskForms`）；同一语义的多处写法收成动作一份；⚠️ `toggleCreate`/`closeCreate` 同名不同语义**刻意不合并**（模式 3） |
| 5. 行为/DOM/CSS/存储键保持 | ✅ 无 CSS/文案/存储键改动；JSX 逐字搬迁；**视图不再发 HTTP**（设计 §3），两处请求本体逐字留入口；表单字段名 `workspacePath` 未改（有判据守着） |
| 6. 每个提交可运行、不提交双实现 | ✅ typecheck/全量单测均绿（除既有 EPERM）；表单域旧实现同批删除，全客户端扫描确认 4 项 state 只有 hook 一份 |

## P3-4 任务数据域

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 4675 行 | **4571 行** | **-104** |
| `WorkbenchApp` 本体 | 3204 行（L219–3422） | **3101 行（L218–3318）** | **-103** |
| 主组件之外的入口代码 | 1471 行 | 1470 行 | -1（新增 `useTaskData` import 一行、删掉 `pendingCompletionMap` import 一行、`PendingCompletionView`/`PendingCompletionsResponse`/`Bootstrap`/`KnowledgeEntry`/`TaskDetail` 五个类型名从 import 里摘掉） |
| 新增 `src/client/hooks/useTaskData.ts` | — | **273 行** | 5 项 state + `selectedRef` + 5 个只读派生 + 8 个域动作 + 3 个装配层原语（`setTasks` / `clearSelectedTask` / `currentTaskId`） |

累计：入口 5725 → 4571（**-1154**）；`WorkbenchApp` 4197 → 3101（**-1096**），距 ≤600 还差 **2501** 行。

⚠️ 本批的**落点**与前三个子批不同：`const data = useTaskData({ onError: setError, onNotice: setNotice })` 必须落在
反馈域 `error`/`notice` **之后**（入口 L365-366），因为注入回调要引用它们而 `const` 没有提升 ——
不能像 P3-1/P3-2/P3-3 那样摆在原 state 声明处。实测入口 L229–L360 之间没有任何代码引用本域符号，无 TDZ 风险。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **退出码 0**（`tsc --noEmit`；本批无 typecheck 返工） |
| `pnpm test` | **992 tests / 991 pass / 1 fail**（与 P3-3 后同数 ⇒ **0 回归**；唯一失败＝既有 `db migrations, dictionaries and task tree` 的 Windows `rmSync` EPERM） |
| `python scripts/lib/d17-p3d-exit-check.py` | **退出码 0**，7 节共 **102 项**全过 |
| `python scripts/lib/d17-p1/p2/p3a/p3b/p3c-exit-check.py` | **均退出码 0**（32 / 49 / 47 / 56 / 67 项；前四批判据未被 P3-4 打回） |
| `python scripts/lib/d17-mutate-p3d.py` | **8/8 条变异被断言发现**，还原后 sha256 逐字节一致、还原后基线（p3d + `progressWiring`）退出码全 0 |
| `node scripts/repro/probe-capacity-mutations.mjs` | **20/20 全红、退出码 0**（本批**不需要重锚**，见下） |
| `node scripts/repro/probe-listview-mutations.mjs` | **17/17 全红、退出码 0** |
| `node scripts/repro/probe-knowledge-draft-overwrite-mutations.mjs` | **19/19 全红** |
| `node scripts/repro/probe-knowledge-recall-mutations.mjs` | **46/46 全红** |

> ⚠️ **串行纪律（本批实测踩到）**：`probe-*.mjs` 会**改写源码再还原**，而 `pnpm test` = `pnpm build && node --test`。
> 本轮第一次全量测试与探针**并发**跑，多出 1 条假红：
> `V04-B/AX-V07：三方构建标识同源 —— 包 manifest = client 内联 = host health`（构建标识在"算输入哈希"与"打包"之间
> 源文件被探针改了）。杀掉并发、串行重跑即恢复 992/991/1。
> **凡是会改源文件的验证脚本，必须与任何含构建的命令串行。**

### 出口自检（`scripts/lib/d17-p3d-exit-check.py`，7 节 102 项）

> ⚠️ **后修订（P4）**：本节写于 P3-4 当时，项数 **102**。P4 因容量 memo 搬进 `hooks/useDayWorkspace.ts`
> 打回了本自检 §7 的一条断言（`tasks: [...tasks, ...taskList.archivedTasks]`），同批重锚并拆成两条后为 **103 项**。
> 下表内容保留 P3-4 当时的记录。

| 节 | 内容 |
|---|---|
| 1 | 入口不再自建本域任何东西：5 项 state 的 `const [` 0 命中、`const selectedRef = useRef` 不在入口、`dicts`/`dictOf`/`pendingMap`/`childrenIndex`/`childrenOf` 与 8 个动作的 `const X = (useMemo\|useCallback\|async\|()` 全 0 命中、**不裸用** `setBootstrap`/`setPendingCompletions`/`setSelected`/`setTaskKnowledge`/`pendingCompletionMap`；`const data = useTaskData({ onError: setError, onNotice: setNotice })` 恰好 1 处；读取值解构行原文在位；`data.actions` 解构出 9 个名字（**`loadTaskKnowledge` 刻意不解构**，另断言入口 0 命中） |
| 2 | 创建者唯一性：用 `git ls-files -co --exclude-standard src/client` 枚举全客户端 `.ts/.tsx`，断言 5 项 state + 5 个派生 + 8 个动作的创建点**只有** `hooks/useTaskData.ts`。⚠️ `selected`/`dicts`/`dictOf`/`refresh` 在别的域也有同名声明（`useKnowledge.ts`/`SettingsModal.tsx`/`useIdeas.ts`），所以对这四个用**完整声明原文**匹配（如 `const [selected, setSelected] = useState<TaskDetail \| null>(null)`），松正则会假红。另断言 `const selectedRef = useRef` 全客户端只 1 份 |
| 3 | 设计 §4.1 红线：hook 的 `loadTaskDetail` 体内**无** `setView(`；`openTaskById` **不在** hook（剥注释后 0 处）；入口 `openTaskById` 体内**有** `setView('list')`；入口 `openTask` 体内有 `resetDetailView()` 且无 `setView(`；hook 的 `saveProgress` 与 `completeTaskFromProgress` 体内都有 `loadTaskDetail(taskId)`、都**无** `openTaskById(` |
| 4 | `refresh` 整块且没拆（设计 §4.1 第 149 行）：体内恰好 **2 处** `Promise.all(`（先三端点快照、再按最新选中 ID 补详情），含 `'/api/workbench/bootstrap'`、`'/api/workbench/tasks'`、`'/api/workbench/tasks/pending-completions'`、`/events\``、`/reviews\`` 五个端点字面量；`pending-completions` 在 hook 内只 1 处（不做 N+1）；`setBootstrap(boot); setTasks(list.tasks); setPendingCompletions(pending)` 原文仍在 |
| 5 | 跨域注入（设计 §5）：hook 剥注释后裸 `setError`/`setNotice`/`setView`/`resetDetailView`/`setDetailTab` 各 0；入参类型含 `onError: (message: string) => void` 与 `onNotice: (message: string) => void`；`onError(e instanceof Error ? e.message : String(e))` 在位；`onNotice(` 恰好 **2** 处（完成任务 / 推迟） |
| 6 | 装配层原语：`setTasks: Dispatch<SetStateAction<Task[]>>` **原形保留**；入口 `setTasks((list) => list.filter((t) => t.id !== id))`（归档后移除）与 `setTasks((prev) => prev.map(`（编辑乐观更新，恰好 1 处）在位；入口 `clearSelectedTask()` 恰好 **2** 处；hook 的 `clearSelectedTask` 体内同时有 `setSelected(null)` 与 `selectedRef.current = null`；入口 `currentTaskId()` 恰好 **3** 处；入口剥注释后 `selectedRef` 0 处 |
| 7 | **结构指纹**：入口仍装配 `pending={pendingMap}` / `dicts={dicts}` / `childrenOf={childrenOf}` / `patchTask={patchTask}` / `saveProgress={saveProgress}` / `completeTaskFromProgress={completeTaskFromProgress}` / `openTask={openTask}`；**既有判据/探针锚的三段原文仍在入口** —— `const taskList = useTaskListModel({ tasks, dictOf })`、`tasks: [...tasks, ...taskList.archivedTasks]`（探针 I1）、`{ ...task, estimatedMinutes, allDay: editDraft.allDay }`（探针 I5）；P3-2 的判据锚 `const restoreTask = (taskId: string): void => {` 与 `const createSubtask = (form: FormData, parent: Task): void => {` 仍在入口；hook 里无 `/restore`、`/subtasks`；hook 内含 `2026-10-01`（BUG 约定注释逐字搬入）与 `ADR 0004`、`一次查询 → 一份 Map → 全列表共用` |

### 反向验证（`scripts/lib/d17-mutate-p3d.py`，8/8 全红、退出 0）

基线 sha256：`hooks/useTaskData.ts` = `d04b5b04302e35c8129e64ad1707fb0983c1cedde720607f5ea7434a7addc269`、
`index.tsx` = `605f3b73c4bc7ad9bcc3bda8f675fd3f23845fa6e957a221313003e5ccfe78cc`（还原后逐字节一致）。

| 变异 | 被哪条判据抓住 |
|---|---|
| M-P3D-1 `loadTaskDetail` 带上 `setView('list')` | p3d 第 3 节「hook 的 `loadTaskDetail` 只刷新数据，不含 `setView`」+ 第 5 节「hook 里不出现裸 `setView`」 |
| M-P3D-2 `refresh` 少拉待验收端点 | p3d 第 4 节「`refresh` 体内含 `'/api/workbench/tasks/pending-completions'`」+「待验收端点全客户端只出现一次」 |
| M-P3D-3 入口把 `selected` 收回去自己 `useState` | p3d 第 1 节 4 条（`不再自己 useState selected` / `不裸用 setSelected` / `解构出本域读取值`）+ 第 2 节「`selected` 的创建点唯一」 |
| M-P3D-4 hook 丢掉注入回调、退化回裸 `setError` | p3d 第 5 节「hook 里不出现裸 `setError`」+「`loadTaskDetail` 的 catch 走注入的 `onError`」 |
| M-P3D-5 装配层原语收窄 `setTasks` | p3d 第 6 节「`setTasks` 保留 `Dispatch<SetStateAction<Task[]>>` 原形」 |
| M-P3D-6 入口 `openTaskById` 去掉 `setView('list')` | `test/progressWiring.test.mjs` 新增的反向判据「刷新详情不带导航副作用」（**既有判据改指 + 补强的反向验证**） |
| M-P3D-7 `clearSelectedTask` 只清 state 不清镜像 ref | p3d 第 6 节「`clearSelectedTask` 体内 `selected` 与 `selectedRef` 一起清」 |
| M-P3D-8 完成任务后改走会导航的 `openTaskById` | p3d 第 3 节两条（「hook 里没有 `openTaskById`」/「`completeTaskFromProgress` 用 `loadTaskDetail` 刷新」）+ `progressWiring` 红线测试 |

> **M-P3D-6 为什么价值最高**：它验证的不是新写的 p3d 自检，而是本批**新加的那条反向判据**本身有效 ——
> 旧版 `progressWiring` 的红线测试用 `indexOf('const saveProgress = async')` 硬切片，源码一搬就 `indexOf = -1`，
> `slice(-1)` 只取最后一个字符，`doesNotMatch` 全部**空洞通过**（比扫红更危险，子代理测绘时专门指出过）。
> 重写后的 `sliceFrom(code, start, end)` 每次切片前先 `assert.notEqual(from, -1)`，所以"锚点消失"本身就会失败。

### 变异探针（**本批不需要重锚**，逐条实测确认）

- `scripts/repro/probe-capacity-mutations.mjs` = **20/20 全红、退出 0**。
  ⚠️ 子代理测绘时曾预警「I1（容量 memo 依赖数组里的 `tasks`）与 I5（`setTasks((prev) => prev.map(...))`）
  会因搬 state 而找不到片段」—— 本批**刻意保留了入口的局部名 `tasks` 与那两段更新函数原文**（只换 owner，
  不改调用点文本），所以两条锚点仍精确命中；这也是为什么入口**必须**解构出局部名而不是写成 `data.tasks`。
  I2/I4 锚入口 `saveEditDraft` 本体、I3 锚 `src/client/views/TaskDetailPane.tsx`，本批都未改。
- `scripts/repro/probe-listview-mutations.mjs` = **17/17 全红、退出 0**；`probe-knowledge-draft-overwrite-mutations.mjs` = 19/19；
  `probe-knowledge-recall-mutations.mjs` = 46/46 —— 均不受本批影响。
- **既有欠账（非本批引入）**：`probe-quick-workspace-mutations.mjs` = **13/15**（2 条报「变异点没匹配上」）、
  `probe-model-picker-notify-mutations.mjs` = **7/10**（3 条同样）—— 这些锚点**在 HEAD 版就已不存在**，
  属 KNOWN_PROBE_DEBT，归 P6 处理，**不是 P3-4 打坏的**。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有开浏览器**：refresh 一屏三端点 + 按选中 ID 补详情的实际渲染、归档后从列表消失、编辑保存的乐观更新、
  提醒 ack/加提醒/关联会话三处读 `currentTaskId()` 的时序、完成任务后"不被弹回任务列表"（2026-10-01 那个 BUG 的回归场景）
  都只做了源码级与单测级验证；P3-4 的浏览器场景归 P7 总回归，本批不宣称通过。
- **跨域注入是"等价替换"而非运行期证明**：`setError(...)` → `onError(...)`、两处 `setNotice(...)` → `onNotice(...)`
  是逐字等价替换（入口注入的就是 `setError`/`setNotice` 本身）；有判据守着（p3d 第 5 节），但没做形式化等价证明。
- **`refresh` 26 处引用的跨域影响没有逐处走查**：本批只保证"函数体一字未改、只是换了 owner 与调用点解构名"。
- **`probe-quick-workspace-mutations` / `probe-model-picker-notify-mutations` 的 KNOWN_PROBE_DEBT 未修**（有意留 P6）。
- 未跑 `scripts/dev-verify.mjs` 全链；未跑 `release-preflight`；未 git commit。

### P3-4 出口判据逐条对照（设计文档 §2.1）

| 判据 | P3-4 状态 |
|---|---|
| 1. `WorkbenchApp` ≤600 行 | ❌ 未达成（3101），属 P4–P7 的总出口 |
| 2. 入口总行数下降且记录 before→after | ✅ 4675 → 4571（-104），累计 5725 → 4571（-1154） |
| 3. 五视图 + 任务详情各自成组件 | 🟡 知识 ✅ / 点子 ✅ / list ✅ / 详情 ✅ / 表单弹窗 ✅；today、calendar 未开工（本批不含视图） |
| 4. 状态唯一所有者 | ✅ 任务数据域 5 项 state + `selectedRef` + 5 个派生 + 8 个动作单一 owner（`useTaskData`）；`clearSelectedTask` 把两处两连写收成一份；⚠️ `loadTaskDetail` 与 `openTaskById` **刻意分处两个 owner**（数据 vs 装配），由判据钉死 |
| 5. 行为/DOM/CSS/存储键保持 | ✅ 无 CSS/文案/存储键改动；被搬函数体逐字保留（含两段长注释原文）；`refresh` 未拆；`setTasks` 原形未收窄 |
| 6. 每个提交可运行、不提交双实现 | ✅ typecheck/全量单测均绿（除既有 EPERM）；任务数据域旧实现同批删除，全客户端扫描确认创建点唯一 |

## P4 日期域

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 4571 行 | **4188 行** | **-383** |
| `WorkbenchApp` 本体 | 3101 行（L218–3318） | **2715 行（L221–2935）** | **-386** |
| 主组件之外的入口代码 | 1470 行 | 1473 行 | +3（新增 `useDayWorkspace` / `TodayPane` / `CalendarView` 三条 import） |
| 新增 `src/client/hooks/useDayWorkspace.ts` | — | **533 行** | 17 项 state + `pickedAnchor` + 4 个候选/容量 memo + 4 个 effect + 17 个动作（含 2 个 bump 动作） |
| 新增 `src/client/views/TodayPane.tsx` | — | **153 行** | 今日视图：统计卡 + 容量条 + `CapacityRulePanel` + `DayPanel` + 今日空态 |
| 新增 `src/client/views/CalendarView.tsx` | — | **106 行** | 日历视图：周/月导航 + `wb-week` / `wb-month` + `DayPanel` |

累计：入口 5725 → 4188（**-1537**）；`WorkbenchApp` 4197 → 2715（**-1482**），距 ≤600 还差 **2115** 行。

本批**入口仍然解构出局部名**（`capacity` / `picked` / `dayTab` / `addTaskToPlan` …），不写成 `day.xxx`：
这是刻意的 —— 探针 I1 锚的 `tasks: [...tasks, ...taskList.archivedTasks]` 与 `d17-p3a/p3d` 的结构指纹都依赖这些原文。

⚠️ 入口残留了 10 个**死 import**（`DayPanel` / `DayTab` / `capacityAriaLabel` / `useDayPanelModel` / `resolveDayPanelTab` /
`buildPlanPrompt` / `todayPlanCandidates` / `computeTodayCapacity` / `capacityTodayKey` / `TaskReportView`）——
**决策：本批不清理**。理由：`noUnusedLocals` 未开、仓库无 lint，且 `PlanPanel` 在 P4 之前就是同类死 import；
清理会扩大 diff 与判据面，与"最小搬迁"原则冲突。P7 组合层收尾时统一清。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | **退出码 0** |
| `pnpm test` | **992 tests / 991 pass / 1 fail**（与 P3-2/P3-3/P3-4 后同数 ⇒ **0 回归**；唯一失败＝既有 `db migrations, dictionaries and task tree` 的 Windows `rmSync` EPERM，`test/db.test.mjs:35`） |
| `node --test`（9 个定向文件） | **97 tests / 97 pass / 0 fail / 退出码 0**（`dayPanelWiring` / `capacityWiring` / `dayPanelTabs` / `capacityPanel` / `progressWiring` / `taskDetailWiring` / `workspacePickerWiring` / `quickWorkspaceDefault` / `clientInvariants`） |
| `python scripts/lib/d17-p4-exit-check.py` | **退出码 0**，7 节共 **161 项**全过 |
| `python scripts/lib/d17-p1/p2/p3a/p3b/p3c/p3d-exit-check.py` | **均退出码 0**（32 / 49 / 47 / 56 / 67 / **103** 项；其中 p3a 与 p3d 各被本批打回 1 处、已同批重锚，见下） |
| `python scripts/lib/d17-mutate-p4.py` | **11/11 条变异被断言发现**，还原后四个文件 sha256 逐字节一致、还原后基线退出码全 0 |
| `node scripts/repro/probe-capacity-mutations.mjs` | **20/20 全红、退出码 0**（I1 本批**已重锚**到 `useDayWorkspace.ts`，见下） |

> ⚠️ **串行纪律仍然适用**：`probe-*.mjs` 会**改写源码再还原**，而 `pnpm test` = `pnpm build && node --test`。
> 本轮全量测试与探针**串行**跑（测试先完工再起探针），结果无假红。

### 既有判据被本批打回（4 条，同批重锚 —— "判据跟着 owner 走"）

| 判据 | 原写法 | 重锚后 |
|---|---|---|
| `scripts/lib/d17-p3a-exit-check.py` `bare()` | 直接在原文上匹配裸名 | **先 `strip_comments`**，且正则收紧为 `(?<![\w.])name\b(?!\s*:)`（**不算对象字面量的键**，也不算注释里提到的名字） |
| 同上 §2 | `"...taskList.archivedTasks]" in INDEX` | `in INDEX or "archivedTasks: taskList.archivedTasks," in INDEX`（memo 本体已进 hook，入口只留**透传**一行） |
| `scripts/lib/d17-p3d-exit-check.py` §7 | `"tasks: [...tasks, ...taskList.archivedTasks]" in INDEX_BARE` | 拆成两条：入口 `"archivedTasks: taskList.archivedTasks,"` + hook `"tasks: [...tasks, ...archivedTasks]"` |
| `test/dayPanelWiring.test.mjs` `:66/:68/:76` | 扫 `index.tsx` 的 `resolveDayPanelTab(` / 负向断言 / `addTaskToPlan` ≥2 | 新增 `const DAY = read('src/client/hooks/useDayWorkspace.ts')`，三条改扫 `DAY`；`index.tsx` 侧**改成正向结构断言**（`count(INDEX, /addTaskToPlan/g) >= 3` 保留，另加 `assert.equal(/const addTaskToPlan = /.test(INDEX), false)` 反向判据） |
| `test/capacityWiring.test.mjs` `:83/:134-148`（AX-G02 / AX-C06） | 扫 `index.tsx` 的 `todayPromptInfo,` 与 `computeTodayCapacity(` 的依赖数组/实参切片 | 新增 `const daySource = read('src/client/hooks/useDayWorkspace.ts')`，容量 memo 与截断提示改扫 `daySource`；入口侧改成**反向**「不许调 `todayPlanCandidates(`」+ 正向 `assert.match(indexSource, /archivedTasks: taskList\.archivedTasks,/)`；两处 `indexOf` 切片**补 `assert.ok(start > 0)` 守卫** |

> **为什么必须补正向断言**：`indexOf(...)` 在锚点消失时返回 `-1`，`slice(-1)` 只取最后一个字符，
> 于是 `doesNotMatch` 全部**空洞通过** —— 比扫红更危险。子代理测绘时专门点出过这个机制，本批照此改法处理。

### 出口自检（`scripts/lib/d17-p4-exit-check.py`，7 节 161 项）

| 节 | 内容 |
|---|---|
| 1 | 入口不再自建本域任何东西：**17 项 state** 的完整声明原文 0 命中、**16 条派生/动作**定义原文 0 命中、17 个 setter 名下**没有 `useState`**；`const day = useDayWorkspace({` 恰好 1 处；入参含 `archivedTasks: taskList.archivedTasks,` 与 `onError: setError,` / `onNotice: setNotice,`；6 行解构原文在位；16 个 action 名**经解构用到**且入口无第二份 `^(const\|function) <action>` 定义；`day.actions.collapseExpanded()` 在位 |
| 2 | **创建者唯一性**：`client_sources()` = `glob.glob('src/client/**/*.ts'\|'*.tsx', recursive=True)`（**含未追踪新文件**），断言 17 项 state 的完整声明原文各自**恰好**出现在 `src/client/hooks/useDayWorkspace.ts` |
| 3 | 四个 effect 搬走且依赖数组原文一致：`}, [view, dayTab, reportSubTab, reportAnchor, reportIsFuture, reportRefreshKey])` / `}, [todayAnchor, todayPlan])` / `}, [view, dayTab, pickedAnchor, planRefreshKey])` / `}, [dayPanel.extraTabsAvailable])` 都在 hook；`}, [todayAnchor, bootstrap])` **不在**（本批唯一的依赖改名：`bootstrap` → `todayPlan` 入参）；hook 里仍发 6 条日域请求；hook 里**没有** `/api/workbench/settings`（设置写入留入口） |
| 4 | **容量 memo 三条接线细节**（探针 I1 的新锚点）：依赖数组 `[tasks, archivedTasks, todayPlan, dailyCapacityMinutes, defaultEstimateMinutes, dailyCapacityIncludeOverdue, capacityTodayKey(now)]` 原文在位；`tasks: [...tasks, ...archivedTasks]`；`plan: todayPlan === null ? null : { ...todayPlan, readable: todayPlan.readable !== false }`；`eslint-disable-next-line react-hooks/exhaustive-deps` 豁免随行；入口**不再有** `computeTodayCapacity(` 调用 |
| 5 | 跨域注入（设计 §5）：hook 剥注释后裸 `setError`/`setNotice`/`setView`/`resetDetailView`/`setDetailTab` 各 0；入参类型含两个回调；`onError(e instanceof Error ? e.message : String(e))` 在位；`onNotice(res.added ? …` 在位 |
| 6 | 视图层：两个组件导出与 props 类型在位；`views/*` **无** `fetch(` / `api[<(]`、**无** `useState[<(]`；入口按 `view === 'today' && (`→`<TodayPane` 与 `view === 'calendar' && (`→`<CalendarView` 分派；`wb-stats wb-stats-sticky` 与 `wb-cal-nav` 的 JSX 已不在入口 |
| 7 | **结构指纹**：`collapseAll` 收成一行 `taskList.actions.clearExpanded(); day.actions.collapseExpanded()`；`planPromptFor(planAnchor)`；`dayPanelProps = {` + `    ...dayPanel,`；两条注入动作 `onClearPlan: () => void clearPlan(dayPanel.day),` / `onDelete: () => { if (currentReport !== null) void deleteReport(currentReport) },`；草稿域 `onDone` 里的 `setPendingDraft(null); bumpPlanRefresh(); bumpReportRefresh();`；三行装配层原文（`tab: dayTab` / `schedulingTaskId: addingPlanTaskId` / `onScheduleToday: … addTaskToPlan(taskId)`）；`reparentCandidates` 仍在入口且仍被使用；两个 settings 写入（`saveIncludeOverdue` / `saveDailyCapacity`）留入口；`saveDailyCapacity` 只读 `day.capacityEdit` |

### 反向验证（`scripts/lib/d17-mutate-p4.py`，11/11 全红、退出 0）

基线 sha256：`hooks/useDayWorkspace.ts` = `c2fb284c98cd38ad57bda8ee54d8ef10b9cfe5cdfdf94205bf7d645cb97d42a3`、
`index.tsx` = `58d7dea240a73db3c9707e49b8b8b4da07d17a6904513753dcc49dd92dec72be`、
`views/CalendarView.tsx` = `9031d15fe021f19b872c7ee82333299681ee0985a288142adca37c1ade38343c`、
`views/TodayPane.tsx` = `d8683e80ae5533d708195a0840aef445c98c4b4765207fd4b1724d4f1d258c27`（还原后四文件逐字节一致）。

| 变异 | 被哪条判据抓住 |
|---|---|
| M-P4-1 入口把 `dayTab` 收回去自己 `useState` | p4 第 1 节（`不再自己 useState` / 17 个 setter 名下无 `useState`）+ 第 2 节「`dayTab` 的创建点唯一」 |
| M-P4-2 容量 memo 依赖塞回 `now` 对象 | **探针 I1** + `test/capacityWiring.test.mjs` AX-C06 两条（改扫 `daySource` 后仍精确命中） |
| M-P4-3 今日计划会话 effect 依赖退回 `bootstrap` | p4 第 3 节（`}, [todayAnchor, todayPlan])` 在位 / `}, [todayAnchor, bootstrap])` 不在） |
| M-P4-4 `collapseAll` 丢掉列表域那一半 | p4 第 7 节（`collapseAll` 一行原文） |
| M-P4-5 `TodayPane` 自己发包 | p4 第 6 节（`views/*` 无 `fetch(` / `api[<(]`） |
| M-P4-6 `CalendarView` 自持 state | p4 第 6 节（`views/*` 无 `useState[<(]`） |
| M-P4-7 hook 退化回裸 `setError` | p4 第 5 节（hook 剥注释后裸 `setError` 0 处） |
| M-P4-8 `onClearPlan` 退回内联 `api(...)` | p4 第 7 节（注入动作原文） |
| M-P4-9 `saveDailyCapacity` 读回本地 `capacityEdit` | p4 第 7 节（`saveDailyCapacity` 只读 `day.capacityEdit`） |
| M-P4-10 入口重新定义 `addTaskToPlan` | `test/dayPanelWiring.test.mjs` 新增反向判据「入口不许有 `const addTaskToPlan = `」 |
| M-P4-11 入口重新调 `todayPlanCandidates` | `test/capacityWiring.test.mjs` AX-G02 反向判据「入口不许调 `todayPlanCandidates(`」+「hook 必须调」 |

> **M-P4-2 为什么价值最高**：它一次同时打中**既有判据**（`AX-C06`）与**既有探针**（I1）两条路。
> 这正是本批重锚策略的要害 —— 探针 I1 从 `index.tsx` 换锚到 `useDayWorkspace.ts` 之后仍然精确命中，
> 证明"换 owner 时只换来源、不改调用点文本"这条纪律让源码文本锚点可以整体平移而不是失效。
> M-P4-10 / M-P4-11 次之：它们验证的是**本批新加的两条反向判据**本身有效（不是新写的 p4 自检）。

### 变异探针（**本批有一处必须重锚**，已重锚并实测）

- `scripts/repro/probe-capacity-mutations.mjs`：新增常量 `const DAY_WORKSPACE = 'src/client/hooks/useDayWorkspace.ts'`
  （与既有 `SHARED` / `INDEX` / `PANEL` / `TASK_DETAIL_PANE` 并列，L39-41），**I1 的 `file` 改为它**、
  `from`/`to` 换成 hook 现文（`[tasks, archivedTasks, todayPlan, …, capacityTodayKey(now)],` → 末尾换 `now],`）。
  重锚后实测 **20/20 全红、退出 0**（S1–S12 + I1–I5 + P1/P2/P3 逐条 `— 变红 ✓`）。
  依据：设计文档 §7 明令「入口 I 系列按新 DayWorkspace 锚定；共享算法变异保持；不减少覆盖」。
- I2 / I4 / I5 锚入口的 `saveEditDraft` 本体，I3 锚 `src/client/views/TaskDetailPane.tsx` —— **本批都未动**，逐条实测仍精确命中。
- `probe-listview-mutations.mjs` = 17/17、`probe-knowledge-draft-overwrite-mutations.mjs` = 19/19、
  `probe-knowledge-recall-mutations.mjs` = 46/46 —— 均不受本批影响。
- **既有欠账（非本批引入）**：`probe-quick-workspace-mutations.mjs` = **13/15**、
  `probe-model-picker-notify-mutations.mjs` = **7/10** —— 锚点在 HEAD 版即不存在，属 KNOWN_PROBE_DEBT，归 P6。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有开浏览器**：今日视图的容量条行内编辑（`capacityEdit` 四个回调）、日历周/月切换与选中日、今日/日历共用一份
  `DayPanel` 装配结果、报告子页签切换与"未来不拉报告"闸门、计划清除/报告删除两条注入动作 ——
  全部只做了源码级 + 单测级验证。P4 的浏览器场景归 P7 总回归，本批不宣称通过。
- **`collapseAll` 的跨域组合只做了文本级验证**：它现在跨两个 owner（列表域 `clearExpanded()` + 日期域 `collapseExpanded()`），
  失败模式（只清一半）有 p4 第 7 节与 M-P4-4 守着，但没有行为级验证。
- **`clearTodayPlan` 是搬迁前就存在的死代码**（入口 0 处引用，靠 `void clearTodayPlan` 消 lint），与 `clearPlan(date)` 语义重叠。
  本批**只换 owner、不改行为**（**决策**：不趁搬迁顺手删，避免把"行为改动"混进"结构调整"），遗留到 P7 评估。
- **跨域注入是"等价替换"而非运行期证明**：hook 里 `setError(...)` → `onError(...)`、`setNotice(...)` → `onNotice(...)`、
  `setPlanRefreshKey((v) => v + 1)` → `bumpPlanRefresh()` 都是逐字等价替换，有判据守着但没做形式化证明。
- **5 个接口回调的时序未走查**：`TodayPane` / `CalendarView` 的 props 是纯注入，但"点容量编辑 → 落库 → 重拉计划"
  这条链的竞态没有行为验证。
- 未跑 `scripts/dev-verify.mjs` 全链；未跑 `release-preflight`；**未 git commit**（P1–P4 全部未提交，`src/client/hooks/`、
  `src/client/views/`、`src/client/app/` 三个目录整目录 untracked）。

### P4 出口判据逐条对照（设计文档 §2.1）

| 判据 | P4 状态 |
|---|---|
| 1. `WorkbenchApp` ≤600 行 | ❌ 未达成（2715），属 P5–P7 的总出口 |
| 2. 入口总行数下降且记录 before→after | ✅ 4571 → 4188（-383），累计 5725 → 4188（-1537） |
| 3. today/calendar/list/knowledge/ideas 五个视图 + 任务详情各自成组件 | ✅ **本批补齐最后两个**（`TodayPane` / `CalendarView`）；知识/点子左右详情 P1/P2 已成组件 |
| 4. 状态唯一所有者 | ✅ 日期域 17 项 state + 4 个 memo + 17 个动作单一 owner（`useDayWorkspace`）；`collapseAll` 是**跨域组合**，按设计 §4.1 留在装配层 |
| 5. 行为/DOM/CSS/存储键保持 | ✅ 无 CSS/文案/存储键改动；被搬函数体逐字保留（含 3 条"别改回去的接线细节"注释与 4 条 `eslint-disable` 豁免）；两个视图 JSX 逐字搬迁，只把「今天」按钮的 `setCursor` 目标改成注入的 `onToday` |
| 6. 每个提交可运行、不提交双实现 | ✅ typecheck / 97 条定向单测 / 全量 992 条均绿（除既有 EPERM）；日期域旧实现同批删除，全客户端递归扫描确认创建点唯一 |

## P5-1 反馈域 + 设置域

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 4188 行 | **4071 行** | **-117** |
| `WorkbenchApp` 本体 | 2715 行（L221–2935） | **2617 行（L202–2818）** | **-98** |
| 主组件之外的入口代码 | 1473 行 | 1454 行 | -19（`SETTINGS_FALLBACK` + `withSettingsFallback` 约 25 行搬去纯模块，换回 3 条 import + 8 处指针注释） |
| 新增 `src/client/settingsFallback.ts` | — | **36 行** | 设置默认值兜底纯模块（0 React / 0 DOM / 0 请求） |
| 新增 `src/client/hooks/useWorkbenchFeedback.ts` | — | **64 行** | 2 个 state + toast 宿主 + 2 条桥接 effect；0 请求 |
| 新增 `src/client/hooks/useWorkbenchSettings.ts` | — | **252 行** | 9 项 state + 12 个 action + 2 条 effect；6 条路由 |

累计：入口 5725 → 4071（**-1654**）；`WorkbenchApp` 4197 → 2617（**-1580**），距 ≤600 还差 **2017** 行。

⚠️ 本批的**落点**约束：反馈域是 4 个已搬 hook 与设置域共同的注入源（`useTaskData` / `useKnowledge` /
`useIdeas` 都要 `onError` / `onNotice`），而 `const` 不提升 ⇒ `feedback` 必须落在原 `error` / `notice` 声明处
（入口 L350）。设置域 hook 又要同时拿任务数据域的 `dictOf` / `refresh` 和反馈域的三个写口，所以它的落点
被推到 `notifyPerm` 之后的 **L400**。这是"装配层仍是唯一能同时看见这些域的地方"的直接结果。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | **退出码 0** |
| `pnpm test` | **992 tests / 991 pass / 1 fail**（0 回归；唯一失败＝既有 `test/db.test.mjs:131` 的 Windows `rmSync` EPERM） |
| `python scripts/lib/d17-p5a-exit-check.py` | **退出码 0**，7 节共 **141 项** |
| 前六批 exit-check（p1/p2/p3a/p3b/p3c/p3d/p4） | 均退出 0（**32 / 49 / 47 / 56 / 67 / 103 / 161** 项） |
| `python scripts/lib/d17-mutate-p5a.py` | **11/11 被断言发现**；还原后 sha256 逐字节一致；还原后基线 exit=[0,0,0,0] |
| `node scripts/repro/probe-quick-workspace-mutations.mjs` | **13/15**（M12/M13 本批重锚后仍变红；未发现的 M6/M14 是 **P6 KNOWN_PROBE_DEBT**，与搬迁前同数） |
| `probe-capacity-mutations.mjs` | **20/20** 全红（基线全绿），与本批前同数 |
| `probe-listview-mutations.mjs` | **17/17** 全红（基线全绿），与本批前同数 |
| `probe-knowledge-draft-overwrite-mutations.mjs` | **19/19** 全红（基线全绿），与本批前同数 |
| `probe-knowledge-recall-mutations.mjs` | **46/46** 全红（基线全绿），与本批前同数 |

### 既有判据被打回 → 已重锚（判据跟着 owner 走）

| 判据 | 打回原因 | 处理 |
|---|---|---|
| `test/knowledgeRecallRoutes.test.mjs:254-257` | 断言入口出现 `/api/workbench/knowledge-recall/log?limit=30`，搬迁后入口不再发这条路由 | 入口改**负向**断言（不许自己发召回端点）+「面板接的仍是真日志」保留 + 新增两条正向断言指向 `src/client/hooks/useWorkbenchSettings.ts` |
| `test/quickWorkspaceDefault.test.mjs:168` | `functionBody(stripped, 'saveSettings')` 返 `null` | 入口改负向断言（`saveSettings` 只能有一个 owner）+ 改从 `src/client/hooks/useWorkbenchSettings.ts` 取函数体；其后 3 条断言（`quickWorkspaceRecent: _ignored` / `JSON.stringify(editable)` / 不许 `JSON.stringify(settings)`）**原文不动即继续有效** |
| `test/draftBannerSessionJump.test.mjs` | — | **无需改动**：入口从 hook 解构出同名 setter，`onSettled={() => setPendingDraft(null)}` 文本未动（M-P5a-11 证明这条判据真的在守着） |
| `scripts/repro/probe-quick-workspace-mutations.mjs` | M12/M13 的锚点在 `saveSettings` 体内，随搬迁离开入口 | 新增常量 `SETTINGS_HOOK = src/client/hooks/useWorkbenchSettings.ts`，M12/M13 的 `file:` 改指它，重跑仍逐条变红 |

重锚后定向：`node --test test/knowledgeRecallRoutes.test.mjs test/draftBannerSessionJump.test.mjs
test/quickWorkspaceDefault.test.mjs test/quickIntakeDefaultWiring.test.mjs test/quickIntakeClient.test.mjs`
= **55 / 55 通过 / 0 失败**。

### 出口自检（`scripts/lib/d17-p5a-exit-check.py`，7 节 141 项，退出 0）

| 节 | 核对内容 | 项数 |
|---|---|---|
| §1 入口不再自建本域任何东西 | 入口不再自建：`error` / `notice` / `useToasts` / 9 项 state / 6 个动作定义；4 条接线原文各恰好 1 次；12 个解构名无第二份定义 | **38** |
| §2 唯一所有者（全客户端递归） | 9 条状态声明 + 6 条动作定义各自只出现在设置 hook；`useToasts()` 解构只在反馈 hook；`SETTINGS_FALLBACK`/`withSettingsFallback` 只在 `settingsFallback.ts` | **22** |
| §3 设置域 effect 与 HTTP 归属 | 装载 effect 原文在 hook 且不在入口；6 条路由在 hook；hook 不碰提醒域/草稿域路由；无原生 `fetch` | **14** |
| §4 跨域注入（设计 §5） | `dictOf`/`refresh`/`onError`/`onNotice`/`onToast` 入参类型齐全；hook 不 import 视图或入口 | **16** |
| §5 反馈域纯度 | 两条桥接 effect 原文与依赖数组；无 api/fetch/域外引用；恰好 2 个 useState + 2 个 useEffect | **14** |
| §6 刻意留在装配层的东西还在 | 8 条动作定义原文、`setSettings(withSettingsFallback(res.settings))` 2 次、18 条 JSX props 原文 | **28** |
| §7 结构指纹与调用顺序 | 3 条 import、hook 调用顺序、指针注释数（反馈域 ≥3 / 设置域 ≥6） | **9** |
| **合计** | 退出码 0 | **141** |

### 反向验证（`scripts/lib/d17-mutate-p5a.py`，11/11 全红、退出 0）

变异基线（还原后逐字节校验一致）：
`src/client/hooks/useWorkbenchFeedback.ts` = `adc37e803dac426bec82a464d12bd60b03e11ac92ce0fa70be4157762bad9922`；
`src/client/hooks/useWorkbenchSettings.ts` = `a09b96509e6572289baafada4412e224efda5808c22493f4ce5579c84132dac9`；
`src/client/index.tsx` = `ab3cb26282777724d5296f2481e3e190874c4fc6ff351b2d0b99d0e5dbc0472b`
（非变异目标，登记备查：`src/client/settingsFallback.ts` = `34679b636289dee2a86072c7c9dd8e59c6a76a8b267afb4ba28b5866fb54b6cb`）。

| 变异 | 打回者 |
|---|---|
| M-P5a-1 入口把 `showSettings` 收回去自己 `useState` | exit-check |
| M-P5a-2 设置 hook 丢掉注入别名、退化回裸 `setError` | exit-check |
| M-P5a-3 入口复活一份 `SETTINGS_FALLBACK` | exit-check |
| M-P5a-4 入口重新内联设置装载 effect | exit-check |
| M-P5a-5 反馈桥接不再清回 `null` | exit-check |
| M-P5a-6 入口重新自己起 `useToasts()` | exit-check |
| M-P5a-7 入口复制一份 `recallSessionRestore` | exit-check（**首次为盲点，见下**） |
| M-P5a-8 设置 hook 越界去发提醒域路由 | exit-check |
| M-P5a-9 `saveSettings` 不再摘掉 `quickWorkspaceRecent` | exit-check + `test/quickWorkspaceDefault.test.mjs` |
| M-P5a-10 召回日志路由 `limit=30`→`31` | exit-check + `test/knowledgeRecallRoutes.test.mjs` |
| M-P5a-11 `DraftBanner` 的 `onSettled` 不再清投影 | `test/draftBannerSessionJump.test.mjs` |

### 本批实测到的一条判据脆弱性（新教训，值得回头复核 P1–P4）

M-P5a-7（入口复制一份 `recallSessionRestore`）**第一次跑没被抓住**。原因不是判据缺失，而是判据写错：
"入口不再有 X 的第二份定义"用的是 `re.search(r"^(const|function)\s+X\b", src, re.M)` —— 而 `WorkbenchApp`
体内的定义**缩进 2 格**，`^const` 永远匹配不到，于是这条断言**永远为真（空洞通过）**。改成
`r"^[ \t]*(const|function)\s+X\b"` 后立刻变红；修口径前 141 项同样是"全过"。

→ **可复用规则**：凡是"某名字在源码里不该再出现第二份定义"的文本判据，正则必须允许行首空白，
且**必须用一条真造得出第二份定义的变异来反证它**，否则它只是个装饰。
P1–P4 的 exit-check 里同类断言（`^(const|function)` 且目标在组件体内）应按这个口径复核。

### 变异探针（本批**有一处必须重锚**）

`scripts/repro/probe-quick-workspace-mutations.mjs` 的 M12/M13 锚在 `saveSettings` 体内，随设置域离开入口
⇒ 新增 `SETTINGS_HOOK` 常量改指 `src/client/hooks/useWorkbenchSettings.ts`，两条仍逐条变红。
其余探针与本批无关（`probe-capacity-mutations.mjs` 的锚点都在 `saveEditDraft`，属 P3-3 留在入口的代码；
`probe-listview-mutations.mjs` / `probe-knowledge-draft-overwrite-mutations.mjs` /
`probe-knowledge-recall-mutations.mjs` 都不读 `src/client/index.tsx`）。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有开浏览器**：设置弹窗（常规 / 字典 / 召回日志三个分区）、字典增删改、微信提醒策略与通道、
  建议值保存、右上角 toast 宿主、两条提示桥接（成功 / 失败）—— 全部只做了源码级 + 单测级 + 文本核对级
  验证。**P5-1 的浏览器场景归 P7 总回归，本批不宣称通过。**
- **两个 hook 没有专门单测**：`useWorkbenchFeedback` / `useWorkbenchSettings` 的行为覆盖来自
  `pnpm test` 的既有接线判据 + exit-check 的文本核对，没有各自的 `*.test.mjs`。这是拆分的既有策略
  （P1–P4 的 12 个新文件同样如此），但它是**覆盖缺口**，不是"已验证"。
- **跨域注入仍只是等价替换**：hook 内 `setError(...)` → `onError(...)`（靠函数体第一行的别名保证逐字未改），
  有判据守着，但没有形式化证明。
- **`pnpm test` 有一条偶发失败**：`test/personaLibrary.test.mjs:585`（`AX-R06 HTTP 资源拒绝：父目录穿越 → 400`，
  `[TypeError: fetch failed] [cause]: Error: bad port`）在本批两次首跑里各出现一次，串行重跑即消失，
  判为端口抖动，**不是 P5-1 回归**；但它说明这套测试对并发敏感。
- 未跑 `scripts/dev-verify.mjs` 全链；未跑 `release-preflight`；**未 git commit**。
- P5-2 / P5-3 未开工：提醒域的 `reminders` / `reminderPolicy` / `reminderChannel` / `notifyPerm`
  与草稿域的 `pendingDraft` / `drafts` 等 state 与动作仍在入口。

### P5-1 出口判据逐条对照（设计文档 §2.1）

| 判据 | P5-1 状态 |
|---|---|
| 1. `WorkbenchApp` ≤600 行 | ❌ 未达成（2617），属 P5-2–P7 的总出口 |
| 2. 入口总行数下降且记录 before→after | ✅ 4188 → 4071（-117），累计 5725 → 4071（**-1654**） |
| 3. today/calendar/list/knowledge/ideas 五个视图 + 任务详情各自成组件 | ✅ 已于 P4 达成（本批不涉及视图） |
| 4. 状态唯一所有者 | ✅ 设置域 9 项 state + 反馈域 2 项 state 全客户端唯一（§2 逐条断言）；`settings` 仍是 P6 的跨域写点，留在装配层 |
| 5. 行为/DOM/CSS/存储键保持 | ✅ 无 CSS / 文案 / 存储键改动；18 条 JSX props 逐字未动；两条桥接 effect 逐字搬迁；`withSettingsFallback` 语义未改 |
| 6. 每个提交可运行、不提交双实现 | ✅ typecheck 0 / 全量 992 条 / 141 项自检全过 / 11 条变异全被捕获；设置域旧实现同批删除，全客户端递归扫描确认创建点唯一 |

## P5-2 提醒域

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 4071 行 | **3926 行** | **-145** |
| `WorkbenchApp` 本体 | 2617 行（L202–2818） | **2471 行（L203–2673）** | **-146** |
| 主组件之外的入口代码 | 1454 行 | 1455 行 | +1（搬走 7 项 state + 3 条设施 + 8 个动作 + 2 条 effect 与 `notifiedRef`/`persistNotified` 约 160 行，换回 1 条 import + 10 处指针注释 + 1 个 hook 调用点与两段解构） |
| 新增 `src/client/hooks/useWorkbenchReminders.ts` | — | **321 行** | 7 项 state + 3 条设施（`notificationCtor`/`notifiedRef`/`persistNotified`）+ 8 个 action + 2 条 effect + `tickDue(isAlive)`；7 条路由；0 定时器 |

累计：入口 5725 → 3926（**-1799**）；`WorkbenchApp` 4197 → 2471（**-1726**），距 ≤600 还差 **1871** 行。

⚠️ 本批的**落点**约束：提醒域要同时拿任务数据域的 `currentTaskId` / `refresh`（`ackReminder` 的闸门、
`addTaskReminder` 的取 id）与设置域的 `showSettings` / `settings.desktopNotify`（策略装载 effect 的开关、
通知 half 的重建条件），所以它的调用点被推到 `prefs` 之后（入口 L407，`prefs` 在 L395）。

⚠️ **轮询刻意不搬**：L633/L634 的 5 秒 `tick` + 15 秒 `refresh` 那条 effect 留在装配层，本批只把 `tick`
里提醒那半段换成 `await tickDue(() => alive)`（**没有新增任何定时器**），整片轮询归 **P5-3** 的
`useWorkbenchPolling`（设计 §7 第 184 行）。`}, [refresh, settings.desktopNotify])` 这行依赖数组**文本未动**。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | **退出码 0** |
| `pnpm test` | **992 tests / 991 pass / 1 fail**（0 回归；唯一失败＝既有 `test/db.test.mjs:131` 的 Windows `rmSync` EPERM） |
| `python scripts/lib/d17-p5b-exit-check.py` | **退出码 0**，7 节共 **156 项** |
| 前八批 exit-check（p1/p2/p3a/p3b/p3c/p3d/p4/p5a） | 均退出 0（**32 / 49 / 47 / 56 / 67 / 103 / 161 / 137** 项；p5a 因本批移交四条断言由 141 降到 137） |
| `python scripts/lib/d17-mutate-p5b.py` | **12/12 被断言发现**；还原后 sha256 逐字节一致；还原后基线 exit=[0,0] |
| `probe-capacity-mutations.mjs` | **20/20** 全红（基线全绿），与本批前同数 |
| `probe-listview-mutations.mjs` | **17/17** 全红（基线全绿），与本批前同数 |
| `probe-knowledge-draft-overwrite-mutations.mjs` | **19/19** 全红（基线全绿），与本批前同数 |
| `probe-knowledge-recall-mutations.mjs` | **46/46** 全红（基线全绿），与本批前同数 |
| `probe-quick-workspace-mutations.mjs` | **13/15**（M12/M13 本批后仍逐条变红；未发现的 M6/M14 是 **P6 KNOWN_PROBE_DEBT**，与本批前同数） |
| `probe-model-picker-notify-mutations.mjs` | **7/10**（未发现的 B7/B8/B10 是 **P6 KNOWN_PROBE_DEBT**，与本批前同数） |

### 既有判据被打回 → 已重锚（判据跟着 owner 走）

| 判据 | 打回原因 | 处理 |
|---|---|---|
| `scripts/lib/d17-p5a-exit-check.py` §6 | 该节逐字断言"四条提醒域动作定义**刻意留在装配层**"，搬迁后入口不再有 | 从 `for decl in [...]` 里删掉 `loadReminderChannel` / `saveReminderPolicy` / `ackReminder` / `resetReminderState` 四条，注释写明"判据跟着 owner 走，改由 p5b 守"；p5a **141 → 137 项**，仍退出 0 |
| `scripts/lib/d17-p3d-exit-check.py:198` | `len(re.findall(r"currentTaskId\(\)", INDEX_BARE)) == 3`，其中两处在 `ackReminder` / `addTaskReminder` 体内，随实现离开入口 | 改成 `== 1`（入口只剩 `linkExistingSession` 一处），注释写明提醒域那两处归 p5b；p3d 复绿 **103 项** |
| 全部 `test/*.mjs` | — | **无需改动**：入口从 `remindersApi` / `remindersApi.actions` 解构出同名值，7 项 state 解构与 15 条 JSX props 文本一字未动 |
| 六个 `scripts/repro/probe-*.mjs` | — | **无需重锚**：只有 `probe-capacity-mutations.mjs` / `probe-listview-mutations.mjs` 读入口，锚点都在任务详情/列表域，不碰提醒域 |

### 出口自检（`scripts/lib/d17-p5b-exit-check.py`，7 节 156 项，退出 0）

| 节 | 核对内容 | 项数 |
|---|---|---|
| §1 入口不再自建本域任何东西 | 10 条声明（7 项 state + 3 条设施）+ 8 个动作定义都不在入口；两条搬走的 effect 体不在入口；`HOOK_CALL` 恰好 1 处且 7 个入参写全；7 项结果解构与 12 名 actions 解构**整块原文**在位；import 原文 | **55** |
| §2 唯一所有者（全客户端递归） | 每条声明/动作的 `owners_of` 必须恰为 `src/client/hooks/useWorkbenchReminders.ts`；`useWorkbenchReminders` 只定义一次；hook 里 `notifyPerm` 只声明一次 | **21** |
| §3 提醒域 effect 与 HTTP 归属 | 两条 effect 原文与依赖数组（`[showSettings]` / `[reminders.length]`）在 hook、不在入口；8 条路由在 hook；5 条别域路由不在；无原生 `fetch`；`api[<(]` ≥9；发通知失败的 `console.warn` 仍在 | **19** |
| §4 跨域注入（设计 §5） | 别名行原文；7 条入参类型；12 个别域名裸名 0、`settings` 裸名 0；不 import 视图/入口；**`ackReminder` 闸门**与 **`addTaskReminder` 取 id 返回**两条用法原文 | **24** |
| §5 `tickDue` 纯度与轮询归属 | `if (!isAlive()) return` 逐字保留且早于 `setReminders` / `sendSystemNotification` / `notifiedRef.current.add`；拉 `due` 端点；`if (notifiedAny) persistNotified()` 在位；入口轮询里 `await tickDue(() => alive)` 在、内联 `api<{ reminders:` 不在、`setInterval(` 仍 2 处；hook 里 0 定时器 | **13** |
| §6 刻意留在装配层的东西还在 | `readNotificationCtor(globalThis)` 2 处（授权 / 测试通知两个内联回调）；15 条 JSX props 原文（含 `onSelectTarget` 那条函数式更新）；`onClick={() => void ackReminder(...)}` 2 处；`pendingCount` 原文；`reminders.length` | **19** |
| §7 结构指纹与调用顺序 | import 原文；调用顺序 `prefs` → `remindersApi` → `useKnowledge` / `useIdeas`；`提醒域（D17/P5-2）` 指针注释 ≥8（实测 10） | **5** |
| **合计** | 退出码 0 | **156** |

### 反向验证（`scripts/lib/d17-mutate-p5b.py`，12/12 全红、退出 0）

变异基线（还原后逐字节校验一致）：
`src/client/hooks/useWorkbenchReminders.ts` = `0493ba10b8395c6b813ad7c5b669c7bd4f8f04afcc72347a90ae5b8eed2aeb54`；
`src/client/index.tsx` = `ac1e928670cd8c7cd91800982130ab098655ef409d2ed6af943551f09b7a5e91`
（非变异目标，登记备查：`src/client/settingsFallback.ts` = `34679b636289dee2a86072c7c9dd8e59c6a76a8b267afb4ba28b5866fb54b6cb`、
`src/client/hooks/useWorkbenchFeedback.ts` = `adc37e803dac426bec82a464d12bd60b03e11ac92ce0fa70be4157762bad9922`、
`src/client/hooks/useWorkbenchSettings.ts` = `a09b96509e6572289baafada4412e224efda5808c22493f4ce5579c84132dac9`）。

| 变异 | 打回者 |
|---|---|
| M-P5b-1 入口把 `reminderModalOpen` 收回去自己 `useState` | exit-check（2 项：入口声明 + 创建者唯一） |
| M-P5b-2 提醒域 hook 丢掉注入别名、退化回裸 `setError` | exit-check |
| M-P5b-3 入口复活一份 `notifiedRef` | exit-check（缩进口径 `defs_of`） |
| M-P5b-4 入口重新内联"设置面板拉策略/通道" effect | exit-check |
| M-P5b-5 `tickDue` 去掉 `isAlive` 守卫 | exit-check（4 项：保留 + 三条先后关系） |
| M-P5b-6 提醒域 hook 越界去发草稿域路由 | exit-check |
| M-P5b-7 提醒域 hook 自己起一个定时器 | exit-check |
| M-P5b-8 `ackReminder` 不再按 `currentTaskId` 闸门刷新 | exit-check（本批新加在 hook 侧的用法断言） |
| M-P5b-9 入口轮询改回内联拉到期提醒 | exit-check（2 项） |
| M-P5b-10 入口把 `desktopNotify` 注入换成常量 `true` | exit-check（`HOOK_CALL` 原文） |
| M-P5b-11 `tickDue` 不再 `persistNotified()` | exit-check（本批新加的持久化断言） |
| M-P5b-12 入口复制一份 `ackReminder` | **exit-check(p5b)=红 / exit-check(p5a)=绿** ⇒ 证明 p5a §6 移交出去的判据确实由 p5b 接管 |

### 变异探针（本批**无需重锚**，逐条实测确认）

`probe-capacity-mutations.mjs`（20/20）、`probe-listview-mutations.mjs`（17/17）、
`probe-knowledge-draft-overwrite-mutations.mjs`（19/19）、`probe-knowledge-recall-mutations.mjs`（46/46）
四条基线全绿且逐条变红；`probe-quick-workspace-mutations.mjs`（13/15）与
`probe-model-picker-notify-mutations.mjs`（7/10）的未发现项仍是 P5-1 起就登记的
**P6 KNOWN_PROBE_DEBT**（M6/M14 锚在快速录入的工作区切换；B7/B8/B10 锚在模型选择器接线），与本批前同数。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有开浏览器**：到期提醒弹窗（自动弹 / 手动关 / 确认）、桌面系统通知与跨会话去重、
  微信提醒设置三个分区（策略 / 通道 / 测试消息）、设置面板打开时的策略与通道装载 ——
  全部只做了源码级 + 单测级 + 文本核对级验证。**P5-2 的浏览器场景归 P7 总回归，本批不宣称通过。**
- **提醒域 hook 没有专门单测**：`useWorkbenchReminders` 的行为覆盖来自 `pnpm test` 的既有接线判据
  + exit-check 的文本核对，没有自己的 `*.test.mjs`。这是拆分的既有策略（P1–P5-1 的 15 个新文件同样如此），
  但它是**覆盖缺口**，不是"已验证"。
- **`tickDue` 的等价性只是论证**：入口 effect 恰好在 `settings.desktopNotify` 变化时重建、`tickDue`
  闭包只捕获这一个可变值 —— 有 §5 + §7 的判据守着，但没有形式化证明，也没有真机跑过 5 秒轮询。
- **本次 `pnpm test` 首跑多报一条 `test/devVerify.test.mjs:204`**（`ENOENT ... lib/build-info.json`）。
  该用例自带前置条件"先跑 `pnpm build`"，属构建产物缺失（`lib/` 是 gitignored 的构建输出）；
  重新 `pnpm build` 后复跑即恢复 **992/991/1**，**不是 P5-2 回归**。已登记为环境事实。
- 未跑 `scripts/dev-verify.mjs` 全链；未跑 `release-preflight`；**未 git commit**。
- P5-3 / P6 / P7 未开工：草稿域的 `pendingDraft` / `drafts` / `draftQuestions` 等 state 与动作、
  5 秒 tick + 15 秒 refresh 那条**混合域轮询 effect**（L606–636）仍在入口；导航域、快速录入域、
  模型选择域、目录选择域与 AI 会话域同样仍在入口。

### P5-2 出口判据逐条对照（设计文档 §2.1）

| 判据 | P5-2 状态 |
|---|---|
| 1. `WorkbenchApp` ≤600 行 | ❌ 未达成（2471），属 P5-3–P7 的总出口。**⚠️ 2026-10-04 起判据 1 改为「结构硬门 + ≤900 护栏」，≤600 降为努力目标 —— 见 [ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md)；本行及本文档其余各批次的「≤600」一律按历史记录读** |
| 2. 入口总行数下降且记录 before→after | ✅ 4071 → 3926（-145），累计 5725 → 3926（**-1799**） |
| 3. today/calendar/list/knowledge/ideas 五个视图 + 任务详情各自成组件 | ✅ 已于 P4 达成（本批不涉及视图） |
| 4. 状态唯一所有者 | ✅ 提醒域 7 项 state + 3 条设施 + 8 个动作全客户端唯一（§2 逐条断言）；**轮询容器刻意留装配层**，归 P5-3 |
| 5. 行为/DOM/CSS/存储键保持 | ✅ 无 CSS / 文案 / 存储键改动（`dsh-workbench:desktop-notified` 语义未改）；15 条 JSX props 与 2 条 `ackReminder` onClick 逐字未动；两条 effect 逐字搬迁 |
| 6. 每个提交可运行、不提交双实现 | ✅ typecheck 0 / 全量 992 条 / 156 项自检全过 / 12 条变异全被捕获（含 1 条专门验证判据移交）；提醒域旧实现同批删除，全客户端递归扫描确认创建点唯一 |

## P5-3 草稿域 + 轮询装配

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 3926 行 | **3724 行** | **-202** |
| `WorkbenchApp` 本体 | 2471 行（L203–2673） | **2267 行（L205–2471）** | **-204** |
| 主组件之外的入口代码 | 1455 行 | 1457 行 | +2（两条新 import） |
| 新增 `src/client/hooks/useWorkbenchDrafts.ts` | — | **348 行** | 7 项 state + 3 个 ref + 6 个动作（含 `tickDrafts`）；4 条路由；0 定时器 |
| 新增 `src/client/hooks/useWorkbenchPolling.ts` | — | **61 行** | 1 条 effect：5 秒 tick（草稿 → 提醒，串行）+ 15 秒 refresh + `alive` 清理；0 state、0 路由 |

累计：入口 5725 → 3724（**-2001**）；`WorkbenchApp` 4197 → 2267（**-1930**）。
按 [ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md) 的新口径：护栏 **≤900** 还差 **1367** 行（≤600 的努力目标还差 1667 行）。

⚠️ **本批解锁了 ADR-0008 硬门的一条**：`WorkbenchApp` 体内 `setInterval(` / `setTimeout(` 均为 **0**
（入口整份文件只剩 1 个 `setInterval`，即插件 setup 作用域里的 `titlebarTimer`，不属 `WorkbenchApp`）。
本批还顺带把 `WorkbenchApp` 体内的草稿端点字面量清零。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **退出码 0**（`tsc --noEmit`，首轮即过） |
| `pnpm build` | **退出码 0**，buildId **`wb-3dae8edbe5fc55f1`**，inputs **173**，`lib/client.js` **542.99 kB**（gzip 154.68 kB） |
| `pnpm test` | **992 tests / 991 pass / 1 fail**（0 回归；唯一失败＝既有 `test/db.test.mjs:131` 的 Windows `rmSync` EPERM） |
| `python scripts/lib/d17-p5c-exit-check.py` | **退出码 0**，8 节共 **151 项** |
| 前九批 exit-check（p1/p2/p3a/p3b/p3c/p3d/p4/p5a/p5b） | 均退出 0（**32 / 49 / 47 / 56 / 67 / 103 / 161 / 137 / 152** 项；p5b 因本批移交五条断言 + 改两条锚点原文，由 156 降到 152） |
| `python scripts/lib/d17-mutate-p5c.py` | **12/12 被断言发现**；还原后 sha256 逐字节一致；还原后基线 exit=[0,0] |
| `probe-capacity-mutations.mjs` | **20/20** 全红（基线全绿），与本批前同数 |
| `probe-listview-mutations.mjs` | **17/17** 全红（基线全绿），与本批前同数 |
| `probe-knowledge-draft-overwrite-mutations.mjs` | **19/19** 全红（基线全绿），与本批前同数 |
| `probe-knowledge-recall-mutations.mjs` | **46/46** 全红（基线全绿），与本批前同数 |
| `probe-quick-workspace-mutations.mjs` | **13/15**（未发现的 M6/M14 是 **P6 KNOWN_PROBE_DEBT**，与本批前同数） |
| `probe-model-picker-notify-mutations.mjs` | **7/10**（未发现的 B7/B8/B10 同属 **P6 KNOWN_PROBE_DEBT**，与本批前同数） |

### 既有判据被打回 → 已重锚（判据跟着 owner 走）

| 判据 | 打回原因 | 处理 |
|---|---|---|
| `scripts/lib/d17-p5b-exit-check.py` §5 五条 | 该节整片断言"入口轮询里 `await tickDue(() => alive)` 在、内联拉提醒不在、入口恰好 2 个 `setInterval`、依赖数组 `[refresh, settings.desktopNotify]` 文本不变"。本批把这条 effect 整片搬进 `useWorkbenchPolling.ts` | 五条整体**移交** `d17-p5c-exit-check.py` §5（改以「装配器持有时段、串行顺序、异常范围与依赖数组」的口径断言），p5b 原地留下注释说明去向 |
| `scripts/lib/d17-p5b-exit-check.py:152`（`REMINDER_ACTIONS["tickDue"]` 定义原文） | 本批把 `tickDue` 包成 `useCallback(async (isAlive) => {…}, [desktopNotify])`，让它的身份只在 `desktopNotify` 变化时改变 —— 否则装配层那条 effect 每次渲染都重建、每渲染多跑一次 tick | 断言原文跟着改成 `const tickDue = useCallback(async (isAlive: () => boolean): Promise<void> => {`，并加注释写明"签名与体内行为一个字没改，只锁身份" |
| `scripts/lib/d17-p5b-exit-check.py:295`（`body_of` 起点） | 同上（起点标记含 `const tickDue = async`） | 起点改成 `const tickDue = useCallback(async (isAlive: () => boolean)`；§5 内其余 6 条（守卫、端点、持久化、0 定时器、不持有 `alive`）**不受影响** |
| 全部 `test/*.mjs` | — | **无需改动**：入口从 `draftsApi` / `draftsApi.actions` 解构出同名值，`onSettled={() => setPendingDraft(null)}`（`test/draftBannerSessionJump.test.mjs:115` 有正则断言）等全部调用点文本一字未动 |
| 六个 `scripts/repro/probe-*.mjs` | — | **无需重锚**：没有任何一条锚在草稿域（`probe-capacity-mutations.mjs` / `probe-listview-mutations.mjs` 读入口但锚在详情/列表域；`repro-banner.mjs:31` 只在注释里提到 `pendingDraft`） |

### 出口自检（`scripts/lib/d17-p5c-exit-check.py`，8 节 151 项，退出 0）

| 节 | 核对内容 | 项数 |
|---|---|---|
| §1 入口不再自建本域任何东西 | 7 项 state + 3 个 ref 声明原文不在入口；`duplicatePrompt` 的内联类型不在；6 个动作定义不在；16 条"入口没有第二份定义"（缩进口径 `defs_of`）；`let alive` 与原依赖数组原文不在；入口不再直接请求草稿端点、不再内联拉草稿 | **37** |
| §2 唯一所有者（全客户端递归） | 16 条声明/动作的 `owners_of` 必须恰为草稿域 hook；两个新导出各只定义一次；`pendingDraft` 在 hook 里只声明一次；两个 hook 都不递归引用自己；装配器不认识草稿域 hook | **21** |
| §3 草稿域 HTTP 归属与纯度 | 4 条草稿/归档路由在 hook；6 条别域路由不在；无原生 `fetch`；`api[<(]` ≥4；0 定时器；不持有 `alive`；`if (isAlive()) {` 逐字保留且早于 `setPendingDraft` / 写 `bannerDraftRef` | **19** |
| §4 跨域注入（设计 §5） | 别名行原文；3 条入参类型；14 个别域名裸名 0；`settings` 裸名 0；不 import 视图/入口；两条用法（`void refresh()` 收口后刷新、用注入的 `setNotice`/`setError` 说话） | **22** |
| §5 轮询装配器（接管 p5b 的五条） | `let alive` 在；两半段**串行且顺序不变**（草稿 → 提醒）；恰好 2 个定时器且两条周期原文（5000 / 15000 + 自带 `catch`）；挂定时器前先立即跑一次；两半段共用同一个 `try`/`catch`；清理原文；依赖数组 `[refresh, desktopNotify, tickDrafts, tickReminders]`；不认识任何端点；0 state；入参类型；入口恰好一处调用点（4 入参**整块比对**）+ 草稿域调用点与两段解构整块比对 | **19** |
| §6 刻意留在装配层的东西还在 | 表单域 `dismissOnTaskChange` effect 原文；`PENDING_ATTR` 宿主 DOM 投影写/清 3 处；13 条 JSX/调用点原文（含 `onSettled`、`reuseExistingTask`、屏蔽集合相关两处 onClick）；`DraftBanner` 跨域 `onDone`；日期域 `hasPendingPlanDraft` | **17** |
| §7 结构指纹与调用顺序 | 两条 import 原文；调用顺序 `data.actions` → `draftsApi` → `prefs` → `remindersApi` → `useWorkbenchPolling`；`草稿域（D17/P5-3）` 指针注释 ≥5 | **7** |
| §8 ADR-0008 结构硬门 + 度量 | 函数体可定位（大括号配对）且 >2000 行、尾部锚点在位；体内零 `setInterval`/`setTimeout`/`fetch`/草稿端点；整份文件只剩 1 个 `setInterval`（插件 setup 的 `titlebarTimer`）且零 `setTimeout`；打印度量快照 | **9** |
| **合计** | 退出码 0 | **151** |

### 反向验证（`scripts/lib/d17-mutate-p5c.py`，12/12 全红、退出 0）

变异基线（还原后逐字节校验一致）：
`src/client/hooks/useWorkbenchDrafts.ts` = `7b5f2e5cbe09cede51f9dc82550fd46628046f9a4a38a744d07f4dd4000623c7`；
`src/client/hooks/useWorkbenchPolling.ts` = `dd8daefe37f994b2c2ffb68fcd22a5be705240c18ab21975b157060a8d4b017e`；
`src/client/index.tsx` = `377606baa5c4ae1bbac1b84a9ec26874af7c3500571f284ef791e164e60f4a2b`。

| 变异 | 打回者 |
|---|---|
| M-P5c-1 入口把 `pendingOpen` 收回去自己 `useState` | exit-check（2 项：入口声明 + 创建者唯一） |
| M-P5c-2 草稿域 hook 丢掉注入别名、退化回裸 `setError` | exit-check |
| M-P5c-3 入口复活一份 `dismissedDraftIdsRef` | exit-check（3 项：声明 + 缩进口径第二份定义 + 创建者唯一） |
| M-P5c-4 入口重新内联拉待确认草稿 | exit-check（2 项：入口不再直接请求 + 函数体内端点清零） |
| M-P5c-5 `tickDrafts` 去掉 `isAlive` 守卫 | exit-check（3 项：保留 + 两条先后关系） |
| M-P5c-6 草稿域 hook 越界去发提醒域路由 | exit-check |
| M-P5c-7 草稿域 hook 自己起一个定时器 | exit-check |
| M-P5c-8 装配器把草稿/提醒对调 | exit-check（串行顺序断言） |
| M-P5c-9 装配器把 tick 频率改成 0.5 秒 | exit-check（周期原文） |
| M-P5c-10 装配器删掉 15 秒 refresh 定时器 | exit-check（2 项：定时器数量 + 周期原文） |
| M-P5c-11 入口把 `PENDING_ATTR` 投影改成空操作 | exit-check（宿主契约断言） |
| M-P5c-12 入口把提醒 tick 改回内联拉取 | **exit-check(p5c)=红 / exit-check(p5b)=绿** ⇒ 证明 p5b §5 移交出去的五条确实由 p5c 接管 |

### 变异探针（本批**无需重锚**，逐条实测确认）

`probe-capacity-mutations.mjs`（20/20）、`probe-listview-mutations.mjs`（17/17）、
`probe-knowledge-draft-overwrite-mutations.mjs`（19/19）、`probe-knowledge-recall-mutations.mjs`（46/46）
四条基线全绿且逐条变红；`probe-quick-workspace-mutations.mjs`（13/15）与
`probe-model-picker-notify-mutations.mjs`（7/10）的未发现项仍是自 P5-1 起登记的
**P6 KNOWN_PROBE_DEBT**（M6/M14 锚在快速录入的工作区切换；B7/B8/B10 锚在模型选择器接线），与本批前同数。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有开浏览器**：草稿横幅（暂存 / 放弃 / 确认 / 屏蔽）、待处理弹窗（唤回暂存草稿 / 从清单重开）、
  重复建单提示（保留两条 / 收口到已有）、"本该创建但没创建"的常驻告警、
  `pendingDraft` 在 `<html>` 上的 `PENDING_ATTR` 投影（插件据此隐藏自己的浮层）——
  全部只做了源码级 + 单测级 + 文本核对级验证。**P5-3 的浏览器场景归 P7 总回归，本批不宣称通过。**
- **两个新 hook 没有专门单测**：`useWorkbenchDrafts` / `useWorkbenchPolling` 的行为覆盖来自
  `pnpm test` 的既有接线判据 + exit-check 的文本核对，没有自己的 `*.test.mjs`。
  这是拆分的既有策略（P1–P5-2 的 17 个新文件同样如此），但它是**覆盖缺口**，不是"已验证"。
- **轮询等价性只是论证 + 文本核对**：`tickDrafts` 的 `useCallback(…, [])` 稳定性与
  `tickDue` 的 `useCallback(…, [desktopNotify])` 身份时机，有 §5 的依赖数组断言与文件头论证守着，
  但**没有真机跑过 5 秒轮询/15 秒刷新**，也验证不了"卸载后才回来的响应"这条守卫的运行时行为。
- **`pendingCount` 的"不经本地屏蔽集合"只由代码结构保证**：该语义（2026-09-15 用户实测 BUG）
  现在由 `useWorkbenchDrafts` 的 `allPendingDrafts` 与入口 `allPendingDrafts.length + reminders.length`
  两处共同承载，没有针对"点一次关闭后计数不掉"的自动化用例。
- 未跑 `scripts/dev-verify.mjs` 全链；未跑 `release-preflight`；**未 git commit**。
- **P5 全部完成**（P5-1/P5-2/P5-3）。P6（快速录入域 / 模型选择域 / 目录选择域 / AI 会话域）
  与 P7（主组件落位 + 总回归）未开工：`WorkbenchApp` 体内仍有 **27 项 state 声明 / 27 处 `api` 调用 /
  4 条 effect / 28 处别域端点字面量**，导航域与 AI 会话域同样仍在入口。

### P5-3 出口判据逐条对照（设计文档 §2.1）

| 判据 | P5-3 状态 |
|---|---|
| 1. `WorkbenchApp` ≤600 行 | ❌ 未达成（2267）。**⚠️ 2026-10-04 起判据 1 改为「结构硬门 + ≤900 护栏」，≤600 降为努力目标 —— 见 [ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md)**；本批**已解锁硬门的一条**：体内零 `setInterval` / `setTimeout` |
| 2. 入口总行数下降且记录 before→after | ✅ 3926 → 3724（-202），累计 5725 → 3724（**-2001**）；判据的绝对口径（<5697）自 P4 起已达成 |
| 3. today/calendar/list/knowledge/ideas 五个视图 + 任务详情各自成组件 | ✅ 已于 P4 达成（本批不涉及视图） |
| 4. 状态唯一所有者 | ✅ 草稿域 7 项 state + 3 个 ref + 6 个动作全客户端唯一（§2 逐条断言）；**轮询容器归 `useWorkbenchPolling`**，入口零定时器；`pendingDraft` → `PENDING_ATTR` 的宿主 DOM 投影**刻意留装配层**（设计 §4.1 末行） |
| 5. 行为/DOM/CSS/存储键保持 | ✅ 无 CSS / 文案 / 存储键改动（`dsh-workbench:desktop-notified`、`PENDING_ATTR` 语义均未动）；13 条调用点原文与 `DraftBanner` 整块 JSX 逐字未动；三条 effect 逐字搬迁（含 `try` 的范围与依赖重建时机） |
| 6. 每个提交可运行、不提交双实现 | ✅ typecheck 0 / 全量 992 条 / 151 项自检全过 / 12 条变异全被捕获（含 1 条专门验证判据移交）；草稿域旧实现同批删除，全客户端递归扫描确认创建点唯一 |

## P6-1 导航 + 忙碌标志

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 3724 行 | **3733 行** | **+9**（1 行 `useState` 换成 hook 调用 + 解构 + import ⇒ 本批是本轮**唯一净增**的子批） |
| `WorkbenchApp` 本体 | 2267 行（L205–2471） | **2274 行** | **+7**（本批源码区间未单独记录） |
| 新增 `src/client/hooks/useWorkbenchNavigation.ts` | — | **43 行** | `view` / `setView`（1 项 state）；零入参、零路由、零定时器 |
| 新增 `src/client/hooks/useWorkbenchBusy.ts` | — | **39 行** | `busy` / `setBusy`（1 项 state）—— **跨域界面瞬态，不属任何业务域**（知识域借用：`useKnowledge` 收 `busy` / `setBusy`） |
| `WorkbenchApp` 体内直接 `useState(` | 27 项 | **25 项** | -2（`view` + `busy`） |
| `WorkbenchApp` 体内 `api(` | 27 处 | 27 处 | 本批只搬 state，无变化 |
| `WorkbenchApp` 体内 `useEffect(` | 4 条 | 4 条 | 无变化 |

累计：入口 5725 → 3733（**-1992**）；`WorkbenchApp` 4197 → 2274（**-1923**）。
按 [ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md) 口径：行数护栏 **≤900** 还差 **1374** 行（≤600 的努力目标还差 1674 行）。

⚠️ 净增 +9 是拆分的正常代价，**不做数字美化**：`busy` 是跨域瞬态（知识域要读、设置域要写），
从入口 1 行 `useState` 变成两个 hook 的 import + 调用 + 解构就必然涨行；这一批换来的是一整域唯一 owner 的成立。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `python scripts/lib/d17-p3b-exit-check.py` | **退出码 0**，7 组 **57 项**（本批 §7 由 56 → 57，见下"既有判据被打回"） |
| `python scripts/lib/d17-mutate-p3b.py` | **退出码 0**，**6/6 全被捕获**（M-P3B-4 的变异靶点随本批搬到导航域 hook） |
| 全量 `npx tsc --noEmit` / `pnpm build` / `pnpm test` | 本批**未单独记录**；P6-4 收尾统一复跑（见 P6-4 节，退出 0 / 退出 0 / 993-992-1） |

### 既有判据被打回 → 已重锚（判据跟着 owner 走）

| 判据 | 打回原因 | 处理 |
|---|---|---|
| `test/taskDetailWiring.test.mjs` | 断言入口含 `useState<WorkbenchView>('today')`；该 state 随导航域搬出入口 | 正向改指 `hooks/useWorkbenchNavigation.ts`，入口补**负向**（该原文不再在入口） |
| `scripts/lib/d17-p3b-exit-check.py` §7 | 同一句 `useState<WorkbenchView>` 随导航域离开入口（§7 原 56 项） | §7 断言改指新 hook ⇒ **56 → 57** |
| `scripts/lib/d17-mutate-p3b.py` | `M-P3B-4`（把视图联合类型改回内联）的变异靶点原本锚在入口 | 靶点跟着 owner 搬到 `useWorkbenchNavigation.ts`，脚本头部注明"P6-1 后靶点在 hook" |

本批**没有**打回 `test/personaWiring.test.mjs` / `test/progressWiring.test.mjs` 等（本批不碰角色与提示词接线）。

### 出口自检（本批**未新增**脚本：**没有** `d17-p6a-exit-check.py`）

本批只搬 2 项 state，**没有新建出口自检脚本**（`scripts/lib/d17-cut-p6a.py` 是一次性搬迁脚本，不是判据）。覆盖方式：

- **本批自己的正/负向**：`d17-p3b-exit-check.py` §7（57 项、退出 0）—— 导航域 `useState` 的唯一 owner；
- **后续三批替本批守 owner 唯一性**：`d17-p6b-exit-check.py` §2 的「P6-1 的导航域仍是唯一所有者」「P6-1 的忙碌标志仍是唯一所有者」两条，
  `d17-p6c-exit-check.py` §2 与 `d17-p6d-exit-check.py` §2 各同样两条；
- 全量 13 个出口自检在 P6-4 收尾**全部复跑、全部退出 0**（逐条计数见 P6-4 节）。

### 反向验证（本批**未新增**变异脚本：**没有** `d17-mutate-p6a.py`）

- 本批相关的反向证据是 `scripts/lib/d17-mutate-p3b.py`（**6/6 全红、退出 0**，靶点已跟到新 hook）；
- `scripts/lib/d17-mutate-p6b.py` 头部声明"给刚迁移的快速录入域（**+ P6-1 的导航/忙碌域**）注入缺陷"，
  但它 13 条变异的注入点实际只有 `src/client/index.tsx` / `src/client/hooks/useWorkbenchQuickIntake.ts` / `src/client/intakeHelpers.ts` 三处，
  **没有任何一条直接变异 `useWorkbenchNavigation.ts` / `useWorkbenchBusy.ts`** ⇒ 记为覆盖缺口（见下）。

### 变异探针（本批未改任何探针文件）

本批**未修改任何 `scripts/repro/probe-*.mjs`**；六个探针的复跑记录归 P6-4 收尾（见 P6-4 节）。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有独立出口自检、也没有独立反向变异脚本**：`view` / `busy` 的 owner 唯一性只有后续三批 §2 的六条旁证 + `p3b` §7 一正一负；
  **没有任何变异直接证明"把 `view` 或 `busy` 塞回入口会变红"**。
- **没有开浏览器**：视图切换（`view`）与全局忙碌态（`busy`）的运行时行为只做了源码级 + 单测级核对；
  **P6 的浏览器场景统一归 P7 总回归，本批不宣称通过**。
- 两个新 hook **没有专门单测**（P1–P5 的既有策略，仍是覆盖缺口，不是"已验证"）。
- `busy` 被知识域借用（`useKnowledge` 收 `busy` / `setBusy`）这条跨域注入只由文本断言守着，没有行为级用例。

## P6-2 快速录入域

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 3733 行 | **3513 行** | **-220** |
| `WorkbenchApp` 本体 | 2274 行 | **2090 行（L171–2260）** | **-184** |
| 新增 `src/client/hooks/useWorkbenchQuickIntake.ts` | — | **364 行** | 8 项 state + 2 个 ref + 两个内部写入点 + 7 个动作 + 1 条卸载清理 effect；**0 定时器** |
| 新增 `src/client/intakeHelpers.ts`（**纯模块**） | — | **66 行** | `newTaskId` / `fileToBase64` / `quickImageToPromptPart`（快速录入域与 P6-3 的 AI 会话域**共用**；hook 不能 import 入口，会成环） |
| `WorkbenchApp` 体内直接 `useState(` | 25 项 | **17 项** | -8 |
| `WorkbenchApp` 体内 `api(` | 27 处 | **13 处** | -14 |
| `WorkbenchApp` 体内 `useEffect(` | 4 条 | **3 条** | -1（卸载时释放图片 object URL 的清理 effect 随域搬走） |

累计：入口 5725 → 3513（**-2212**）；`WorkbenchApp` 4197 → 2090（**-2107**）。
按 ADR-0008：护栏 ≤900 还差 **1190** 行（≤600 的努力目标还差 1490 行）。

搬走的东西：8 项 state（`showQuick` / `quickText` / `quickWorkspace` / `quickWorkspaceTouched` / `quickWorkspaceSource` /
`quickFollowFolder` / `quickAttachments` / `quickAttachmentNotice`）、2 个 ref（`quickImageInputRef` 与附件镜像 ref）、
两个内部写入点（`writeQuickAttachments` / `appendQuickAttachments`）、7 个动作（`openIntake` / `closeIntake` / `cancelIntake` /
`overrideWorkspace` / `addQuickAttachments` / `removeQuickAttachment` / `clearQuickAttachments`），
外加 `rememberQuickWorkspace` / `forgetQuickWorkspace` 两个**设置写入点**（走注入的 `setSettings`，设计 §5）与投影函数
`applyDecision`（原 `applyQuickWorkspaceDecision`，与"打开弹窗""不再记住这个目录"两处共用，仍是唯一实现）。

**刻意留装配层的**：
- `openQuickEntry`（**跨域组合**：① 快速录入域 `openIntake()`；② AI 会话域的角色复位 `setQuickPersona(INHERIT_PERSONA)` + 技能复位 + `loadSkills()`）；
- 提交闸门 `shouldRememberQuickWorkspace(quickWorkspaceTouched, chosen)`（`M-P6b-8` 盯的就是它，行为级判据在 `.mjs` 一侧）；
- `detectWslHost`（入口尾部的模块级纯函数）以**注入**形式交给 hook —— 搬进 hook 会成环；
- JSX 与 `onChange={overrideWorkspace}` 等调用点文本（只换来源，不改文本）。

**落点约束**：hook 调用点必须在 `prefs`（设置域解构）**之后**（`settings` / `setSettings` / `setError` 都是注入进来的，`const` 没有提升）。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `python scripts/lib/d17-p6b-exit-check.py` | **退出码 0**，8 节共 **153 项** |
| `python scripts/lib/d17-mutate-p6b.py` | **退出码 0**，**13/13 全被捕获**；还原后 **sha256 逐字节一致** |
| `node scripts/repro/probe-quick-workspace-mutations.mjs` | **16/16 全红**（原 13/15 ⇒ 本批 M6/M14 重锚 + 新增 M16 后全红） |
| `python scripts/lib/d17-p5a-exit-check.py` | **退出码 0**，§6 由 141 → **135**（两条快速录入写入点的断言按 owner 移交 p6b） |
| 全量 `npx tsc --noEmit` / `pnpm build` / `pnpm test` | 本批**未单独记录**；P6-4 收尾统一复跑（见 P6-4 节） |

### 既有判据被打回 → 已重锚（判据跟着 owner 走）

| 判据 | 打回原因 | 处理 |
|---|---|---|
| `test/quickIntakeDefaultWiring.test.mjs`（:32 附近） | **逐字切片** `openQuickEntry` / `applyQuickWorkspaceDecision` 两个函数体；后者随域搬走 | 切片改从 `hooks/useWorkbenchQuickIntake.ts` 取；`openQuickEntry` 仍留装配层，切片保留但补了跨域组合的语境 |
| `test/quickWorkspaceDefault.test.mjs`（135/156/219/311） | 入口的快速录入与工作区默认值接线（`rememberQuickWorkspace` / touched 闸门 / 投影结果）换了 owner | 正向改指 hook；`rememberQuickWorkspace` 的提交闸门仍留入口 ⇒ 保留入口侧断言（**只换来源、不改调用点文本**那一半照旧） |
| `scripts/repro/probe-quick-workspace-mutations.mjs` | `M6` 锚在内联 `setQuickWorkspace(e.target.value)`（已随域搬走）、`M14` 锚在失效的内联三元 | `M6` 改锚**用户交互唯一写点** `setQuickWorkspace(path)`；`M14` 改锚 `showForget={...}`；**新增 M16** 盯 hook 里判定调用点的 `recent`（**13/15 → 16/16**） |
| `scripts/release-preflight.mjs` 的 `KNOWN_PROBE_DEBT` | quick-workspace 的欠账已消除，名单里再留着会被双向断言判失败 | **销账删除** quick-workspace 那一条（只留 `probe-model-picker-notify-mutations` 一条），并就地写明重锚经过 |
| `scripts/lib/d17-p5a-exit-check.py` §6 | P5-1 亲手列的"入口保留两个 quick-intake 设置写入点"两条断言，被本批打回 | 两条整体**移交** `d17-p6b-exit-check.py`（成对断言，p5a 141 → **135**），原地留注释说明去向 |

### 出口自检（`scripts/lib/d17-p6b-exit-check.py`，8 节 153 项，退出 0）

| 节 | 核对内容 |
|---|---|
| §1 入口不再自建本域任何东西 | 8 项 state / 2 个 ref / 两个内部写入点 / 7 个动作的声明原文不在入口；`defs_of`（缩进口径）确认入口没有第二份定义；两个新文件存在 |
| §2 唯一所有者（递归覆盖整个 `src/client`） | 每条声明/动作的 `owners_of` 必须恰为快速录入域 hook；三个共用小工具只在 `intakeHelpers.ts`；**并替 P6-1 守**「导航域 / 忙碌标志仍是唯一所有者」 |
| §3 本域的 HTTP 归属与纯度 | 本域路由在 hook、别域路由不在；无原生 `fetch`；**0 定时器**；不读 `selected` |
| §4 跨域注入（设计 §5） | 别名行原文、入参类型、别域名裸名 0、不 import 视图/入口 |
| §5 上游接管与调用顺序（`const` 无提升） | 调用点在 `prefs` 之后；`openQuickEntry` 的两半段按原顺序（录入域 → AI 会话域）；`clearQuickAttachments` 的跨域注入交给 P6-3 一侧 |
| §6 刻意留在装配层的还在 | 提交闸门、JSX 与调用点原文、`detectWslHost` 注入契约 |
| §7 结构指纹与顺序 | import 原文、指针注释计数、关键调用顺序 |
| §8 ADR-0008 结构硬门与度量 | 函数体可定位且行数在守卫区间；体内 `useState ≤ 17`；体内零 `setInterval`/`setTimeout`/裸 `fetch`；整份入口只剩 1 个 `setInterval`（插件 setup 的 `titlebarTimer`）；打印度量快照 |

### 反向验证（`scripts/lib/d17-mutate-p6b.py`，13/13 全红、退出 0）

| 变异 | 盯的东西 |
|---|---|
| M-P6b-1 入口把 `quickWorkspace` 收回去自己 `useState` | 同一状态只有一个 owner（exit-check） |
| M-P6b-2 入口复活一份附件镜像 ref | ref/state 一致性构造（exit-check） |
| M-P6b-3 入口重新内联写附件 | 唯一写入出口（exit-check） |
| M-P6b-4 入口把「取消」拆回两连 `setState` | 成组动作没有被拆回两处（exit-check） |
| M-P6b-5 入口把工作区回调拆回内联两连写 | 用户输入的唯一写点 `overrideWorkspace`（exit-check） |
| M-P6b-6 入口把注入的 `setError` 换成空实现 | 设计 §5 跨域注入（exit-check） |
| M-P6b-7 入口把 `detectWslHost` 改名 | 注入而非搬走（exit-check） |
| M-P6b-8 入口去掉 touched 闸门 | 判据跟着 owner 走 + 行为级判据（`.mjs` 两条） |
| M-P6b-9 快速录入域 hook 丢掉注入别名、退化回裸 `setError` | 设计 §5（exit-check） |
| M-P6b-10 快速录入域 hook 越界发别域路由 | 域边界（exit-check） |
| M-P6b-11 快速录入域 hook 自己起定时器 | 本域不拥有定时器（exit-check） |
| M-P6b-12 快速录入域 hook 直接读 `selected` | **v1.15.2 那次事故的机制本身**（exit-check） |
| M-P6b-13 共用的纯模块反过来 import React | `intakeHelpers.ts` 的纯度（exit-check） |

### 变异探针（本批**有一处必须重锚**，已重锚并实测）

`probe-quick-workspace-mutations.mjs` **13/15 → 16/16**（M6/M14 重锚 + 新增 M16），
并因此把 `scripts/release-preflight.mjs` 的 `KNOWN_PROBE_DEBT` 里 quick-workspace 那条**销账删除**。
其余五条本批未改、复跑结果见 P6-4 节（capacity 20/20、listview 17/17、knowledge-draft-overwrite 19/19、
knowledge-recall 46/46、model-picker 7/10）。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有开浏览器**：快速录入弹窗（附件选择与清理、工作区"浏览…"、最近工作区预填、"不再记住"）、
  `openQuickEntry` 的跨域组合顺序 —— 只做了源码级 + 单测级 + 文本核对级验证。**P6-2 的浏览器场景归 P7 总回归**。
- 新 hook 与纯模块**没有专门单测**（`intakeHelpers.ts` 的三件套只由 exit-check 的纯度断言 + 既有接线判据守着）。
- `intakeHelpers.ts` 被"录入域 + AI 会话域"共用这件事只有纯度断言（不许 import React）与 exit-check §2 守着，
  **没有**"两个域都必须能 import 到同一份实现"的独立用例。
- 全量 `tsc`/`build`/`test` 本批未单独记录（P6-4 收尾统一复跑）；本批**未跑** `release-preflight`、**未 git commit**。

## P6-3 AI 会话域

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 3513 行 | **2830 行** | **-683** |
| `WorkbenchApp` 本体 | 2090 行（L171–2260） | **1406 行（L172–1577）** | **-684** |
| 新增 `src/client/hooks/useWorkbenchAISessions.ts` | — | **914 行** | 12 项 state + `promptResolveRef` + `loadSkills` / `askUserPrompt` / `confirmPrompt` / `cancelPrompt` / `toggleSkill` / `AI_PROMPT_LABELS` / `openSessionInPanel` / `startAISession`（**468 行**）/ `reuseAiSessionId`，外加本批**新增** `resetClarifyPicker()` |
| `WorkbenchApp` 体内直接 `useState(` | 17 项 | **5 项** | -12 |
| `WorkbenchApp` 体内 `api(` | 13 处 | **6 处** | -7 |
| `WorkbenchApp` 体内 `useEffect(` | 3 条 | 3 条 | 无变化 |

累计：入口 5725 → 2830（**-2895**）；`WorkbenchApp` 4197 → 1406（**-2791**）。
按 ADR-0008：护栏 ≤900 还差 **506** 行（≤600 的努力目标还差 806 行）。

搬走的东西：12 项 state（含 `promptModal` / `promptPersona` / `promptModelSelection` / `quickModelSelection` /
`modelModalityTable` / `skillCatalog` / `skillsAvailable` / `skillsLoading` / `skillProblem` / `skillQuery` / `selectedSkills` 等）、
1 个 ref（`promptResolveRef`）与 9 个动作；`loadSkills` 是 `useCallback(…, [])`（身份恒定）。

**刻意保留的语义**（本批一个字没改，只换 owner）：
- `promptPersona` 与快速录入域的 `quickPersona` **是两份，不许合并**；
- `promptModelSelection` 与 `quickModelSelection` **同键、两份入口编辑态，不新增实时同步 effect**；
- **新增 `resetClarifyPicker()`**（角色复位成 `INHERIT_PERSONA` + 技能复位 + 重拉技能目录）—— P6-2 的 `openQuickEntry` 靠它把跨域组合的另一半接回来。

**刻意留装配层的**：`openQuickEntry`（两半段的组合点）、AI 会话相关的 JSX 与全部调用点文本、
`reuseAiSessionId` 里读草稿域 `hasPendingPlanDraft` 的那段**判定原文**（随 `reuseAiSessionId` 一起进了 hook，断言跟着 owner 走）。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `python scripts/lib/d17-p6c-exit-check.py` | **退出码 0**，8 节共 **198 项**（收尾时 §8 由 203 项收口，见下） |
| `python scripts/lib/d17-mutate-p6c.py` | **退出码 0**，**13/13 全被捕获**；还原后 **sha256 逐字节一致** |
| `python scripts/lib/d17-p5c-exit-check.py` | **退出码 0**，§6 / §8 跟改后 **151 → 152**（`hasPendingPlanDraft` 那句随 owner 搬走） |
| `python scripts/lib/d17-p4-exit-check.py` | **退出码 0**（`startAISession` 那句随 owner 搬走，断言跟改） |
| 全量 `npx tsc --noEmit` / `pnpm build` / `pnpm test` | 本批**未单独记录**；P6-4 收尾统一复跑（见 P6-4 节） |

### 既有判据被打回 → 已重锚（判据跟着 owner 走）

| 判据 | 打回原因 | 处理 |
|---|---|---|
| `test/personaWiring.test.mjs` | 角色接线原本扫入口；AI 会话域 12 项 state 与提示词动作离开入口 | 新增 `aiHookSource` 常量，**5 条断言改扫** `hooks/useWorkbenchAISessions.ts`，入口**补负向** |
| `test/progressWiring.test.mjs` | 三处提示词切片原本从入口切；`startAISession` 等搬进 hook | 新增 `clientAiHook`，三处切片改从 hook 切，并补 `assert.ok(consult.length > 100)` **防负向断言空洞通过**（见下方教训 ②） |
| `test/modelPickerDegrade.test.mjs` | 模型选择器的提交路径在入口 | 提交路径改扫 hook；**三条负向对入口与 hook 都扫**（避免"只扫入口 ⇒ 搬家后恒真"） |
| `test/quickIntakeClient.test.mjs` | clarify 分支原本扫入口 | 改扫 hook |
| `scripts/lib/d17-p5c-exit-check.py` §6 与 §8 | 计划复用判定（`hasPendingPlanDraft`）随 `reuseAiSessionId` 搬进 AI 会话域 hook | 断言改指新 owner ⇒ **151 → 152** |
| `scripts/lib/d17-p4-exit-check.py` | 随 `startAISession` 搬走的那句仍在断言入口 | 按"判据跟着 owner 走"改指 hook（脚本内注明） |

### 出口自检（`scripts/lib/d17-p6c-exit-check.py`，8 节 198 项，退出 0）

| 节 | 核对内容 |
|---|---|
| §1 入口不再自建本域任何东西 | 12 项 state / 1 个 ref / 9 个动作 / `AI_PROMPT_LABELS` 的声明原文不在入口；新增 `resetClarifyPicker` 只在 hook 定义 |
| §2 唯一所有者（递归覆盖整个 `src/client`） | 每条声明/动作的 `owners_of` 必须恰为 AI 会话域 hook；**并替 P6-1 / P6-2 守**「导航域 / 忙碌标志 / 快速录入域仍是唯一所有者」三条 |
| §3 本域的 HTTP 归属与纯度 | 会话/技能/模型路由在 hook、别域路由不在；无原生 `fetch`；0 定时器 |
| §4 跨域依赖以注入形式进来（设计 §5） | 别名行原文、入参类型、别域名裸名 0、不 import 视图/入口 |
| §5 落点与调用顺序（`const` 无提升） | 调用点在 `prefs` 之后；`resetClarifyPicker` 与 `openQuickEntry` 的先后关系（P6-2 的交接口） |
| §6 刻意留在装配层的还在 | JSX / 调用点原文、`hasPendingPlanDraft` 的判定去向 |
| §7 结构指纹与顺序 | import 原文、指针注释计数（≥3 处）、关键调用顺序 |
| §8 ADR-0008 结构硬门与度量 | 函数体可定位且在守卫区间；体内 `useState == 0`（**P6-4 收尾改的，见教训 ③**）；体内零 `setInterval`/`setTimeout`/裸 `fetch`；整份入口只剩 1 个 `setInterval`；打印度量快照 |

### 反向验证（`scripts/lib/d17-mutate-p6c.py`，13/13 全红、退出 0）

13 条变异覆盖"同一状态两个 owner / 成组动作被拆回两处 / 用户输入唯一写点 / 跨域注入被掐断 / 注入而非搬走 /
域边界与纯度（越界发别域路由、自己起定时器、直接读 `selected`）/ 共用纯模块纯度 / 判据跟着 owner 走"这些同一批机制，
**13/13 全部被 exit-check 或 `.mjs` 判据抓住**；还原后 **sha256 逐字节一致**，还原后基线再跑仍退出 0。

⚠️ **本批抓到的一条真教训（写进纪律）**：`M-P6c-5`（入口把判活回调写死成 `isAlive: () => true`）**第一次跑没被抓住** ——
判据只做了 `"    isAlive: () => instanceAlive," in INDEX_BARE`，而这段原文在入口**出现过两次**（知识域那次 P1 就有）。
改成"**两行带上下文的原文 + 一条负向**"后立刻变红。
⇒ **纪律**：凡"某段原文在入口出现一次以上"的注入点，断言必须带上下文或计数，不能用单行子串判存在。

### 变异探针（本批未改任何探针文件）

本批**未修改任何 `scripts/repro/probe-*.mjs`**；六个探针的复跑记录归 P6-4 收尾（见 P6-4 节）。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有开浏览器**：十 mode 路径、角色/技能选择、共享提示词弹窗、`openSessionInPanel`、`startAISession` 的澄清流程
  —— 只做了源码级 + 单测级 + 文本核对级验证。**P6-3 的浏览器场景归 P7 总回归**。
- 新 hook **没有专门单测**（914 行、12 项 state 的行为覆盖来自 `pnpm test` 的既有接线判据 + exit-check 文本核对）。
- `startAISession` 仍 **468 行**（现在落在 `hooks/useWorkbenchAISessions.ts`，**不再是 `WorkbenchApp` 的顶层块**，
  故不触 ADR-0008 的"主组件顶层块 ≤80 行"硬门）；**入口体内最长顶层块本批未单独度量 ⇒ 未验证**。
- "两份编辑态不许合并/不新增同步 effect"（`promptModelSelection` vs `quickModelSelection`、`promptPersona` vs `quickPersona`）
  只有 exit-check 的原文断言守着，没有行为级用例。

## P6-4 目录选择域

### 改动规模

| 项 | before | after | 增量 |
|---|---|---|---|
| `src/client/index.tsx` | 2830 行 | **2814 行** | **-16** |
| `WorkbenchApp` 本体 | 1406 行（L172–1577） | **1389 行（L173–1561）** | **-17** |
| 新增 `src/client/hooks/useWorkbenchDirectoryPicker.ts` | — | **81 行** | 5 项 state（`dirPickerTarget` / `dirPickerPath` / `dirPickerListing` / `dirPickerLoading` / `dirPickerError`）+ `openFor` / `loadDirPickerDir` / `setDirPickerTarget` / `setDirPickerPath`；**零入参** |
| `WorkbenchApp` 体内直接 `useState(` | 5 项 | **0 项** | -5 |
| `WorkbenchApp` 体内 `api(` | 6 处 | **6 处** | 本批无变化（余下 6 处是 **P7 欠账**） |
| `WorkbenchApp` 体内 `useEffect(` | 3 条 | 3 条 | 无变化 |

累计：入口 5725 → 2814（**-2911**）；`WorkbenchApp` 4197 → 1389（**-2808**）。
按 ADR-0008：护栏 **≤900** 还差 **489** 行；距设计 §2.1 的 ≤600 努力目标还差 **789** 行。

**本批完成 P6 的收官硬门**：`WorkbenchApp` 体内直接 `useState(` = **0**（D17 起点 114 项，P6 开工时 27 项；P6-1 搬 2 / P6-2 搬 8 / P6-3 搬 12 / P6-4 搬 5）。
体内 `api(` 仍 **6** 处、`useEffect(` 仍 **3** 条 —— 均归 P7。

**刻意留装配层的两件事**（本批的核心决策）：
- `openDirPicker(target)` —— 起始目录来自**快速录入 / 表单 / 编辑草稿三个域的当前值**，是纯装配（谁也不是它的 owner）；
- `applyWorkspaceDir(dirPath)` —— **唯一分派点**，按 `dirPickerTarget` 写回那三个域。两个函数都在入口，文本未动。

**本批产生的两个死 import**（`localDirRequestUrl`、`LocalDirListing`）按 P4 的决定**留给 P7 一次性清**（入口死 import 累计 12 个）。

### 命令证据（全部真实执行）

| 命令 | 结果 |
|---|---|
| `python scripts/lib/d17-p6d-exit-check.py` | **退出码 0**，8 节共 **94 项** |
| `python scripts/lib/d17-mutate-p6d.py` | **退出码 0**，**13/13 全被捕获**；还原后 **sha256 逐字节一致** |
| `python scripts/lib/d17-p6c-exit-check.py` | **退出码 0**，**203 → 198**（§8 的 `direct_state == 5` 假红改成 `== 0`，那 5 项 `dirPicker*` 归 p6d 守） |
| **13 个出口自检全部复跑** | **全部退出 0**：P1 **32** / P2 **49** / P3a **47** / P3b **57** / P3c **67** / P3d **103** / P4 **161** / P5a **135** / P5b **152** / P5c **152** / P6b **153** / P6c **198** / P6d **94** |
| `npx tsc --noEmit` | **退出码 0** |
| `pnpm build` | **退出码 0**，buildId **`wb-171198408fbddb4d`**，inputs **179**，`lib/client.js` **545.95 kB** |
| `pnpm test` | **993 tests / 992 通过 / 1 失败**（P6 开工时 **992/991/1** ⇒ **0 回归**；唯一失败＝既有 `test/db.test.mjs` 的 Windows `rmSync` EPERM：`Error: EPERM, Permission denied: \\?\<TEMP>\dsh-personal-workbench-db-*`） |
| 六个变异探针（P6-4 收尾复跑） | capacity **20/20**、listview **17/17**、knowledge-draft-overwrite **19/19**、knowledge-recall **46/46**、quick-workspace **16/16**、model-picker **7/10**（**3 条未捕获**：B7/B8/B10 锚点失效） |

### 既有判据被打回 → 已重锚（判据跟着 owner 走）

| 判据 | 打回原因 | 处理 |
|---|---|---|
| `scripts/lib/d17-p6c-exit-check.py` §8 | 本批把最后 5 项 `dirPicker*` state 搬走后，p6c §8 的 `direct_state == 5` 变成**假红**（原断言写的是"P6-3 收尾时余 5 项"这个瞬时状态） | 改成 `direct_state == 0` 并注明"那 5 项归 `d17-p6d-exit-check.py` 守" ⇒ p6c **203 → 198** |
| （其余无） | 本批未改任何 `test/*.mjs`、未改任何 `scripts/repro/probe-*.mjs` | — |

### 出口自检（`scripts/lib/d17-p6d-exit-check.py`，8 节 94 项，退出 0）

| 节 | 核对内容 |
|---|---|
| §1 入口不再自建目录选择域任何东西 | 5 项 state 声明原文不在入口；`loadDirPickerDir` 定义不在入口；`openDirPicker` / `applyWorkspaceDir` **仍在**入口 |
| §2 唯一所有者（递归覆盖整个 `src/client`） | 5 项 state 的 `owners_of` 恰为目录选择域 hook；**并替 P6-1/P6-2/P6-3 守**「导航域 / 忙碌标志 / 快速录入域 / AI 会话域仍是唯一所有者」四条 |
| §3 本域职责与纯度 | 本域路由在 hook、别域路由不在；无原生 `fetch`；0 定时器；零入参 |
| §4 跨域：装配层只留「算起始目录」与「选完写到哪」 | `openDirPicker` 起始目录来自三域当前值；`applyWorkspaceDir` 是唯一分派点（按 `dirPickerTarget` 写回三域） |
| §5 落点与调用顺序（`const` 无提升） | hook 调用点在三个域之后；`openDirPicker` / `applyWorkspaceDir` 的顺序 |
| §6 刻意留在装配层的 JSX 还在（只换来源、不改调用点文本） | 目录选择弹窗 JSX 与 `onChange` / `onSelect` 等调用点原文 |
| §7 结构指纹与交给 P7 的欠账 | 指针注释；**死 import 名单恰好 `["localDirRequestUrl", "LocalDirListing"]` 两处**（多了说明还有别的搬家没登记） |
| §8 ADR-0008 结构硬门与度量 | 函数体可定位（200 < 行数 < 3500 是**解析器守卫，不是出口判据**）；**体内直接 `useState` == 0**；体内零 `setInterval`/`setTimeout`/裸 `fetch`；整份入口只剩 1 个 `setInterval`（`titlebarTimer`）；整份入口零 `setTimeout`；打印度量快照（入口/hook 行数、`api(` 的 6 处逐行、`useEffect(` 3 处） |

### 反向验证（`scripts/lib/d17-mutate-p6d.py`，13/13 全红、退出 0）

13 条变异覆盖"同一状态两个 owner / 成组动作被拆回两处 / 跨域注入被掐断 / 注入而非搬走 / 域边界与纯度 /
判据跟着 owner 走"这批同构机制，**13/13 全部被 exit-check 或 `.mjs` 判据抓住**；
**还原后 sha256 逐字节一致**，还原后基线再跑仍退出 0。

### 变异探针（P6-4 收尾**六条统一复跑**）

`probe-capacity-mutations` **20/20**、`probe-listview-mutations` **17/17**、
`probe-knowledge-draft-overwrite-mutations` **19/19**、`probe-knowledge-recall-mutations` **46/46**、
`probe-quick-workspace-mutations` **16/16**（P6-2 从 13/15 修到全红）—— 五条**全红**；
`probe-model-picker-notify-mutations` **7/10**（**3 条未捕获 B7/B8/B10**，锚点失效，**无真盲点，重锚即可**）
⇒ **这是 P6 收尾后唯一剩下的探针欠账**（`scripts/release-preflight.mjs` 的 `KNOWN_PROBE_DEBT` 现在只剩它一条）。

### 未验证 / 覆盖缺口（不得当作通过）

- **没有开浏览器**：目录选择弹窗（打开起始目录、列目录、`dirPickerError` 分支、选中后按 target 写回快速录入/表单/编辑草稿三域）
  —— 只做了源码级 + 单测级 + 文本核对级验证。**P6-4 的浏览器场景归 P7 总回归**。
- 新 hook **没有专门单测**（81 行、5 项 state 的行为覆盖来自 exit-check 文本核对）。
- **入口 6 处 `api(` 仍在 `WorkbenchApp` 体内**（P6-4 的 §8 会把它们逐行打印出来）—— 这是 **P7 欠账**，
  ADR-0008 的业务请求硬门**尚未达成**。
- **入口 12 个死 import**（P4 遗留 10 个 + P6-4 新增 2 个）**仍未清理**，留给 P7 一次性清。
- **P6-1 没有独立出口自检与反向变异脚本**（见 P6-1 节），这条覆盖缺口在 P6 收尾时**未被补齐**。
- model-picker 探针 **B7/B8/B10 三条未捕获**仍未重锚（唯一剩余探针欠账）。
- 未跑 `scripts/dev-verify.mjs` 全链；未跑 `release-preflight` 全链；**未 git commit**。
- **P6 四批全部完成**（P6-1 导航 + 忙碌标志 / P6-2 快速录入域 / P6-3 AI 会话域 / P6-4 目录选择域）。
  剩给 **P7** 的是：`views/*` JSX 收口、工具栏/弹窗装配提取、入口 12 个死 import、
  `useDayWorkspace.ts` 的 `clearTodayPlan` 死代码、体内 **6 处 `api(`**、体内 **3 条 `useEffect(`**，以及总回归（含浏览器场景）。

## P7 入口收口（P7-1 请求归域 / P7-2 JSX 四段搬迁 / P7-3 死代码清理）

P7 是**纯结构收口**批次：不加功能、不改行为，只把入口剩下的三样东西搬走或清掉
（最后 6 处 `api(`、四段 JSX、死 import 与死解构），并让 [ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md) 的硬门全部落地。

### 改动规模（三批，逐批实测）

| 子批 | 入口行数 | `WorkbenchApp` | 做了什么 |
| --- | --- | --- | --- |
| P7-1 | 2814 → **2750** | 1389 → **1325** | 最后 6 处 `api(` 归域 |
| P7-2 | 2750 → **2102** | 1325 → **673** | 四段 JSX 搬进 `src/client/app/` + 装配束 |
| P7-3 | 2102 → **1972** | 673 → **631** | 清死 import/死解构 + 收排版 |
| **P7 合计** | **2814 → 1972（-842）** | **1389 → 631（-758）** | D17 起点 5725 / 4197 ⇒ 累计 **-3753 / -3566** |

**P7-1（最后 6 处业务请求归域）**：`linkSessionRequest` / `archiveSelectedTask` / `restoreTask` /
`createTask` / `createSubtask` → `src/client/hooks/useTaskData.ts`；
`saveIncludeOverdue` / `saveDailyCapacity(rawEdit: string)` → `src/client/hooks/useWorkbenchSettings.ts`。
新增三条跨域注入回调（把"结果接到别的域"这一半留在装配层）：
`onTaskCreated: () => forms.actions.closeCreate()`、`onSubtaskParentCleared: () => forms.actions.setSubtaskParent(null)`、
`onTaskRestored: () => taskList.actions.setArchivedMode(false)`。
规则写在两个 hook 的文件头：**请求形状与它的输入校验归域；把结果接到哪些域的状态归装配层**。

**P7-2（四段 JSX 搬进 `src/client/app/`）**：新增
`src/client/app/WorkbenchHeader.tsx` **44 行**、`app/WorkbenchOverlays.tsx` **195 行**、
`app/WorkbenchBody.tsx` **224 行**、`app/WorkbenchDialogs.tsx` **358 行**，以及
`src/client/app/assembly.ts`（`export interface WorkbenchAssembly`：16 个域 hook 结果（一律 `ReturnType<typeof useXxx>`）
+ `runtime` / `closePanel` / `loadModelModalityTable` / `aiSessionUsable` + 17 个装配层本地值）。
入口只剩 `const assembly: WorkbenchAssembly = { … }` + 5 行渲染，**顺序 = 搬迁前 DOM 顺序**（Header → Overlays → Body → Dialogs → ToastHost）。
四段是**逐字搬出**（内层缩进一字未改），只把外层标签挪进各自的 `return`；overlays/dialogs 用 `<>…</>` 包住。
生成器 `scripts/lib/d17-cut-p7b.py` 的做法：先用 guard 钉死 17 个边界行，再读"JSX 之外"的全部绑定
（props / 解构 / 缩进 0–2 格的 `const` 声明 / import），按来源分组生成每个组件的 `const { … } = props.xxx`。
⚠️ 扫描依赖**必须先剥注释与单双引号字符串（不动模板串）**，否则 `<Icon name="list" />`、`view === 'list'`、
注释里的 `openWorkspacePaths` 都会被当成依赖；剩下两个漏网之鱼进显式 denylist（`ATTR_DENY = {"name", "host"}`）。
**为什么是大对象整束注入而不是逐个 props**：四段是同一份装配结果的不同位置，逐个传会得到四份几乎重复的 40+ 字段清单；
设计 §4 约束的是**状态所有权**，不是"读"。刻意不做 Context / 全局 store / 把 setter 传下去。

**P7-3（死代码与死解构清理）**：`npx tsc --noEmit --noUnusedLocals` 是权威判据（不是正则）—— 第一次跑出
**184 处**未使用（P7-2 搬走 JSX 后，入口为那段 JSX 解构出来的 130+ 个字段全成了死名字）。
一次性脚本 `scripts/lib/d17-clean-unused.py` 按**语句**粒度删指定符（多行排版原样保留），每轮改完立刻跑全项目
`tsc --noEmit`，**只要有任何输出就整体还原并 exit 1**；随后手工删 3 处单行死声明
（`openTree`、`openTasks`、模块级 `let activeHost`），最后 `scripts/lib/d17-tidy-p7b.py` 收 9 处排版。
收尾实测：入口 **0 项未使用**、全项目 `tsc --noEmit` 0；**12 个死 import 全部清零**
（P4 起登记并刻意留到 P7 的 10 个 + P6-4 的 `localDirRequestUrl` / `LocalDirListing`）。

### 命令证据（全部真实执行）

- `npx tsc --noEmit` 退出 **0**（另跑 `--noUnusedLocals` 核验入口 0 项未使用）。
- `pnpm build` 退出 **0**：`lib/client.js` **549.00 kB**（gzip 162.69 kB）。
- `pnpm test`：**993 tests / 992 通过 / 1 失败**（与 P6 收尾同值 ⇒ **0 回归**；唯一失败＝既有
  `db migrations, dictionaries and task tree` 的 Windows `rmSync` EPERM：
  `Error: EPERM, Permission denied: \\?\<TEMP>\dsh-personal-workbench-db-*`）。
- `python scripts/lib/d17-measure3.py`：入口 **1972 行**；`WorkbenchApp` 第 **92–722 行 = 631 行**。
- `node scripts/release-preflight.mjs --phase pre` **退出 0**（门禁通过；剩 3 条登记在案的警告：db EPERM 与两条 PII 良性命中）。

### 既有判据被打回 → 已重锚（判据跟着 owner 走，**不是放宽**）

P7 三次搬家把"锚在入口的判据"逐批打红，改法是同一条：
**正向断言指向真实 owner（`src/client/app/*.tsx` 或域 hook）+ 入口侧补负向断言**；跨文件不变量改用客户端全集递归；
唯一所有者仍由 `owners_of(...) == [owner]` 单独守（所有权没有被放宽）。

- **P7-2**：13 个出口自检里约 40 处「JSX 原文仍在入口」改锚 app 层（`d17-reanchor-p7b-checks.py`）；
  9 个 `test/*.mjs` 共 12 处断言重锚（`d17-reanchor-p7b-tests.py`；
  `workspacePickerWiring` 4、`taskDetailWiring` 3、`quickIntakeDefaultWiring` 2、`quickWorkspaceDefault` 3、
  `personaWiring` 3、`quickIntakeClient` 2、`knowledgeRecallRoutes`/`progressWiring`/`draftBannerSessionJump` 各 1）；
  4 个变异靶点随 JSX 走（`d17-reanchor-p7b-mutations.py`：M-P5a-11、M-P6b-4/5/8）。
  **顺带堵掉两处空洞通过**：`test/taskDetailWiring.test.mjs` 原来那条 `onRestoreTask={restoreTask}` 是靠入口的**注释**匹配上的。
- **P7-3**：9 个出口自检（p3c/p3d/p4/p5a/p5b/p5c/p6b/p6c/p6d）里"冻结入口解构块原文 / 断言入口 import 某模块"的断言
  按当前真实原文重锚，已变成负向的（`import intakeHelpers`、`import settingsFallback`、两个死 import）
  改成**反向断言 + 正向指真实 owner**（`d17-reanchor-p7c-checks.py`，19 条补丁）；
  8 个变异脚本的"入口把 X 收回去自己 useState"锚点从已消失的 `} = X.actions` 收尾行改到当前真实收尾行
  （`d17-reanchor-p7c-mutations.py`）；`test/personaWiring.test.mjs` 的
  `from './components/PersonaPicker.js'` 断言在死 import 清掉后归零 ⇒ 改成两个装配层文件各查一次来源。
  ⚠️ 这一步**先收排版再重锚**（否则要改两遍）；重锚脚本的坑：**同一文件的多条补丁必须累积到一份内存文本再写一次**
  （逐条"读盘→替换→写盘"会让先写的被后读的原始内容覆盖 —— 第一版就踩了，症状是"脚本报成功但判据没变"）。

### 出口自检

`scripts/lib/d17-p7a-exit-check.py`（8 节 **72 项**，退出 0）：入口不再有本批搬走的 5 条声明；6 个动作/2 个设置写入
的唯一所有者（用**完整声明原文**做 `owners_of`）；路由字面量归属（`'/api/workbench/settings'` 有 3 个合法 owner，
所以只断言"设置域 ≥3 处且入口 0 处"）；三条注入回调原文各恰好 1 次；落点顺序；ADR-0008 硬门 + 顶层块表。
`scripts/lib/d17-p7b-exit-check.py`（8 节 **220 项**，退出 0）：入口 JSX 收口；四段组件与装配束的唯一所有者；
组件纯度（不持有 state、不发请求、不 import 域 hook）；依赖方向；渲染顺序；装配束字段完整性；结构指纹；ADR-0008 硬门。

**P7 收尾 15 个出口自检全部退出 0**：P1 / P2 / P3a / P3b / P3c / P3d / P4（这七个脚本的汇总行是"结果：全部通过"，不打印计数）、
**P5a 138 / P5b 152 / P5c 152 / P6b 155 / P6c 198 / P6d 96 / P7a 72 / P7b 220 项**。

### 反向验证（基线绿 → 注入缺陷必红 → 还原再绿）

- 新增 `scripts/lib/d17-mutate-p7a.py`（**6/6 全红**，退出 0）：入口重新内联业务请求（体内出现 `api(`）／入口把
  `archiveSelectedTask` 或 `createTask` 收回来自己定义（两个 owner）／归档路由被改掉／跨域注入回调被写成别的东西／
  `saveDailyCapacity` 签名退化。还原后三个文件 sha256 逐字节一致、基线 exit=0。
- `scripts/lib/d17-mutate-p7b.py`（**13/13 全红**）：JSX 回流入口 / 四段少一段 / 顺序被改 / 不再整束注入 /
  入口又出现 `api(` / 入口长回 87 行顶层块 / 第二个 owner / `collapseAll` 被搬走 / 装配束改名 / overlays 发请求 /
  body 自持 state / body import 域 hook / dialogs 用 `props.actions`。
- **14 个既有变异脚本全部复跑通过**：p1（sha 一致 + 退出 0）、p2 3/3、p3a 4/4、p3b 6/6、p3c 7/7、p3d 8/8、
  p4 11/11、p5a 11/11、p5b 12/12、p5c 12/12、p6b 13/13、p6c 13/13、p6d 13/13。

### 变异探针（**最后一条欠账已销账**）

六个探针全部 **0 存活**：`probe-capacity-mutations` 20/20、`probe-listview-mutations` 17/17、
`probe-knowledge-draft-overwrite-mutations` 19/19、`probe-knowledge-recall-mutations` 46/46、
`probe-quick-workspace-mutations` **16/16**（M2/M14 随快速录入弹窗 JSX 改锚 `app/WorkbenchDialogs.tsx`）、
`probe-model-picker-notify-mutations` **10/10**（B7/B8/B10 三条**不是真盲点而是探针失效**：
锚点还停在 `index.tsx`，而提交路径随 P6-3 搬进 `useWorkbenchAISessions.ts`、门禁成因的调用点一直在
`components/ModelPicker.tsx`，且变量名已从 `quickModelSelection` 漂到 `modelSelection`）。
⇒ `scripts/release-preflight.mjs` 的 `KNOWN_PROBE_DEBT` 里 model-picker 一条已按双向断言要求删除，
现在该名单为空，`--phase pre` 退出 0。

### ADR-0008 结构硬门与护栏校准（本批全部落地）

| 判据 | 口径 | 实测 |
| --- | --- | --- |
| 体内直接 `useState(` | = 0 | **0**（P5-3 时 34 → P6 起点 27 → P6-3 后 0） |
| 体内 `api(` / `fetch(` | = 0 | **0 / 0**（P6-4 时还有 6 处 `api(`，P7-1 归域后清零） |
| 体内 `setInterval(` / `setTimeout(` | = 0 | **0 / 0** |
| 单个顶层块 ≤80 行 | 全部满足 | **41 个块，超限 0 个**（最大 66 行 `saveEditDraft`；P7-2 之前唯一违例是 676 行的 `return (`） |
| `WorkbenchApp` 行数护栏 | ADR 原值 ≤900 | **631 行 ≤ 900 ✓**，并按 ADR「P6 收尾后按实测校准一次」**校准为 ≤650**（写入 `d17-p7b-exit-check.py`） |
| `WorkbenchApp` 努力目标 | ≤600（不是门） | **631，未达成（差 31 行）** |
| 入口总行数单调下降 | 必须 | 5725 → 5451 → 5138 → 4754 → 4571 → 4188 → 3724 → … → 2814 → 2750 → 2102 → **1972**（每批都下降） |

**631 行的构成（为什么没做到 ≤600）**：`dayPanelProps` 41 行、`saveEditDraft` 66 行、
`linkExistingSession` 31 行、`openQuickEntry`/`openDirPicker`/`applyWorkspaceDir`/`openTaskById` 等装配层动作 ~120 行、
17 项 hook 调用与解构 ~90 行、`assembly` 束 21 行、3 条刻意留装配层的 `useEffect` ~40 行、
模块级纯助手（`loadModelModalityTable` / `detectWslHost` / `openWorkspacePaths` / `connectWorkspace` /
`aiSessionUsable` / `estimateRangeMessage`）~150 行。
**再往下压只能把装配层本身拆成 hook**（会引入新一层间接、且与 ADR"护栏值按实测校准"的意图相反），
所以按 ADR 的口径**记录为未达努力目标**，而不是为凑数字继续拆。

### 未验证 / 覆盖缺口（不得当作通过）

- ~~**没有开浏览器**~~ → **2026-10-04 已在 3080 隔离实例补跑**：10 套白名单套件全绿 + 装盘 + 三层验收，见下一节
  「浏览器验收链与装盘」。下面这句保留为 P7 收尾当时的实况：P7 三段只跑了 typecheck / build / unit / test / 出口自检 / 变异脚本这几层。
- **没有 git commit**（**仍未做**）：P1–P7 全部改动仍在工作树（`git show HEAD:src/client/index.tsx` 仍是 5725 行的 D17 之前版本）。
- ~~**没有装盘**~~ → **已装到 profile `web`（3080）**：正式库未迁移（目标实例用的是 `verify-web.db`）；版本号仍 **1.16.2**（未升）；
  19387/desktop 侧**未换**，仍是 2026-10-02 的 dev 构建。
- 刻意保留的既有欠账（本批不动、已登记）：`src/client/hooks/useDayWorkspace.ts#clearTodayPlan` 是**搬迁前就存在**的死代码
  （不是 D17 引入），留待后续批次评估；`src/client/index.tsx` 里 3 条 `useEffect(` 是刻意的装配层投影/桥接 effect
  （实测三条：入口 L283 启动 `refresh` 装配、L314 `dismissOnTaskChange`、L316 `PENDING_ATTR` DOM 投影；
  **error→toast 桥接自 P5-1 起就随反馈域在 `src/client/hooks/useWorkbenchFeedback.ts`，不在体内**）。
- `pnpm test` 的唯一失败是 Windows 环境的 `rmSync` EPERM（既有、已登记在 `KNOWN_TEST_FAILURES`），
  **不代表本批改动无回归**——但也不能当作"全绿"转述。


## 浏览器验收链与装盘（2026-10-04，3080 隔离实例）

**这一节把上面那条"没有开浏览器 / 没有装盘"的覆盖缺口补掉了。** 装进去的是 D17 的同一份工作树构建（**未 commit**），
走本仓库自己的研发验收链 `scripts/dev-verify.mjs`，在真实浏览器里跑完白名单套件。

### 目标与隔离（装盘前逐条实测）

| 项 | 值 |
|---|---|
| 目标实例 | **3080**（独立实例：`node …/@deepseek-ai/dsh/lib/bin.js web --port 3080 --no-open`，由 `~/.dsh/launchers/open-dsh.ps1` 拉起） |
| 目标 profile | `%USERPROFILE%\.dsh\profiles\web` |
| 目标库（隔离证明） | `%USERPROFILE%\.dsh\workbench\verify-web.db`（该 profile 的 `cordis.patch.yml` 显式声明了 `dbPath`；与正式库 `workbench.db` **不是同一个物理文件**） |
| 本会话所在实例 | profile `desktop` / 19387 —— 与目标**不同实例、不同库**（自锁判据不触发；链的 preflight 独立复核了这条） |

### 链路阶段（真跑，退出码 0）

```
node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web \
  --profile-dir "%USERPROFILE%\.dsh\profiles\web" \
  --db-path "%USERPROFILE%\.dsh\workbench\verify-web.db"
```

preflight ✅ → version-before ✅ → build ✅（**buildId `wb-27d63c3bb09513e1`**，184 个输入）→ install ✅ →
profile-diff ✅（**只有本插件那一行变**）→ dump-config ✅ → version-after ✅ → restart ✅（按端口归属 kill 旧 PID 后拉起）→
health ✅（version **1.16.2** / buildId 包·host·client **三者一致** / schema 19）→ token ✅（用真实请求认证过）→ suites ✅×10 → evidence ✅ → cleanup ✅

### 套件结果（十个全绿；不是"应该通过"）

| 套件 | 通过 | 失败 | 跳过 |
|---|---|---|---|
| verify-safety | 20 | 0 | 0 |
| legacy-acceptance | 18 | 0 | 0 |
| legacy-final-2 | 9 | 0 | 0 |
| legacy-sidebar-collapse | 6 | 0 | 0 |
| legacy-duplicate-task | 11 | 0 | 0 |
| progress | 13 | 0 | 0 |
| daily-effort | 13 | 0 | 0 |
| day-panel | 11 | 0 | 0 |
| workspace-picker | 8 | 0 | 0 |
| persona | 12 | 0 | 1（已登记：真实模型链路 `workbench_load_persona`） |

- 证据包：`test-results/workbench-verify/20261004-113439-551e0e/`（`summary.md` + 每套件截图）；首轮失败包 `…/20261004-112953-c55dca/` 保留作对照。
- **装盘后复检**（必须显式把 `DSH_PROFILE_DIR` 指到 web —— 与 `dev-install` 内部一致，否则会去核对 desktop 的副本）：
  `check-installed-fingerprint.mjs` ✅ **240/240 逐文件一致**、`check-installed-version.mjs` ✅ 一致、`dsh --profile web --dump-config` exit 0、
  health 返回 `{"ok":true,"version":"1.16.2","buildId":"wb-27d63c3bb09513e1","db":{"schemaVersion":"19"}}`。

### 首轮红：`day-panel` 的 AX-T03 主判据是**套件自身的假红**（已修，断言一字未改）

- 现象：首轮 `day-panel` **10/11**，失败项 `AX-T03 主判据：今日与「日历选中今天」是同一份面板 —— 页签与行逐一相同`，
  detail `tabs相同=true 行相同=false 今日2行 / 日历0行`。
- 根因（**截图 + 受控顺序实测**，不是推断）：页签状态 `dayTab` 是**今日/日历共用**的一份 state
  （`src/client/hooks/useDayWorkspace.ts:390`），而套件在切到「日历」之前刚点过「逾期」「未排期」——
  「未排期」是补集页签、当天恰好 0 行，于是主判据拿"今日的计划行(2)"比"日历的未排期行(0)"。
  首轮截图 `suite-day-panel/02-日历选中今天.png` 里能直接看到「未排期」页签是激活态、内容区写着"没有未排期的任务"。
- **不是 D17 回归**（三条独立证据）：① `scripts/verify/suites/day-panel.mjs` 相对 HEAD **无改动**（`git diff` 为空）；
  ② `git show HEAD:src/client/index.tsx` 里 pre-D17 的 `dayTab` 处理与现状**逐条相同**（同一个 `useState<DayTab>('plan')`、同一组 effect、
  同样没有"切视图复位"）；③ 受控顺序实测（一次性诊断 `_local-build/diag-day-panel-tab.mjs`）：
  `今日(计划) == 日历(首次，计划)` = **true**、`今日(计划) == 日历(点回计划)` = **true**（都是 2 行、来源均为「进行中」），
  只有把 state 停在「未排期」时才是 0 行。套件自己在 L160 已经为「已完成」踩过同一个坑并写了注释，
  是 2026-10-02 那批（commit `6ff84b0`）新增「逾期/未排期」循环时**又踩了一次**。
- 修法（**只归一前置状态，不改断言**）：进日历前补一次 `await clickTab('计划')` + 写明理由。修后单跑 **11/11**，整链复跑 **exit 0**。

### 补拍的视图（套件白名单**没有**覆盖的两条线）

`_local-build/diag-views.mjs`（一次性诊断）在 3080 上逐视图截图 + 红字扫描（`undefined` / `NaN` / `[object Object]` / `TypeError` / `出错了` …）：
**知识库 / 点子 / 任务 / 今日 / 设置弹框** 五张全部 `hits: []`，无排版破损 —— 这两条线的 JSX 正是 P7-2 搬进 `src/client/app/` 的那批。
截图落 `test-results/workbench-verify/diag-views/`。
**必须说清：这是诊断性补拍，不是判据** —— 知识库 / 点子仍然没有任何白名单套件（缺口照旧登记，见下一节）。

### 仍未做（不得当作已完成）

- **未 git commit**：套件修复与 D17 全部改动仍在工作树。
- **未在 19387 / desktop 上换版**：本次只装到 `web`(3080)；desktop 侧仍是 2026-10-02 的 dev 构建（`wb-a4ca2b1f98cf3ea1`，pre-D17），
  所以本会话看到的界面**不是** D17 构建。
- 知识库 / 点子两条线仍只有诊断性截图。


## 环境事实（截至 P7 实测）

- 截至 P7 **未** git commit。P1–P7 全部改动仍在工作树：`git show HEAD:src/client/index.tsx` 仍是 **5725 行**（D17 之前的版本），
  而 `src/client/hooks/`、`src/client/views/`、`src/client/app/`、`src/client/intakeHelpers.ts` 与 `src/client/settingsFallback.ts`
  中，`hooks`/`views`/`app` 三个目录整目录 untracked（`git status` 已增至 100+ 条）。
- **P7 收尾全量（度量、命令与产物）**：入口 `src/client/index.tsx` **1972 行**（D17 起点 5725 ⇒ 累计 **-3753**）；
  `WorkbenchApp` 本体 **631 行（L92–722）**（D17 起点 4197 ⇒ 累计 **-3566**；[ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md)
  的 ≤900 护栏达标，并按 ADR「P6 收尾后按实测校准一次」**校准为 ≤650**；
  设计 §2.1 的 ≤600 努力目标**未达成，差 31 行**，构成见上一节「631 行的构成」）；
  体内直接 `useState(` **0**、`api(` **0**、`useEffect(` **3**（刻意留装配层的投影/桥接）、
  `setInterval(`/`setTimeout(`/`fetch(` 均 **0**；单个顶层块 **41 个、超限 0 个**。
  `npx tsc --noEmit` 退出 0；`pnpm build` 退出 0（`lib/client.js` **549.00 kB** / gzip 162.69 kB）；
  `pnpm test` **993 / 992 通过 / 1 失败**（与 P6 收尾同值 ⇒ **0 回归**；唯一失败＝既有 `test/db.test.mjs` 的
  Windows `rmSync` EPERM：`Error: EPERM, Permission denied: \\?\<TEMP>\dsh-personal-workbench-db-*`）。
  **15 个出口自检全部退出 0**（P5a 138 / P5b 152 / P5c 152 / P6b 155 / P6c 198 / P6d 96 / **P7a 72** / **P7b 220** 项；
  P1–P4 四个脚本只打印「结果：全部通过」不打印计数）；**15 个变异脚本全部真跑 N/N 且还原后逐字节一致**；
  六个探针 **0 存活**；`node scripts/release-preflight.mjs --phase pre` **退出 0**（`KNOWN_PROBE_DEBT` 已清空）。
- 以下按批次保留各批**当时**的实测数字（历史值，不代表当前状态）：
- 截至 P6-4 **未** git commit。P1–P6-4 全部改动仍在工作树：`git show HEAD:src/client/index.tsx` 仍是 **5725 行**（D17 之前的版本），
  而 `src/client/hooks/`、`src/client/views/`、`src/client/app/`、`src/client/intakeHelpers.ts` 与 `src/client/settingsFallback.ts`
  中，**三个目录整目录 untracked**（`git status` 已增至 95+ 条）。
- **P6-4 收尾全量（度量、命令与产物）**：入口 `src/client/index.tsx` **2814 行**（D17 起点 5725 ⇒ 累计 **-2911**）；
  `WorkbenchApp` 本体 **1389 行（L173–1561）**（D17 起点 4197 ⇒ 累计 **-2808**；距设计 §2.1 的 ≤600 努力目标还差 **789**、
  距 [ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md) 的 ≤900 护栏还差 **489**）；
  `WorkbenchApp` 体内直接 `useState(` **0**、`api(` **6**（P7 欠账）、`useEffect(` **3**、`setInterval(`/`setTimeout(`/`fetch(` 均 **0**。
  `npx tsc --noEmit` 退出 0；`pnpm build` 退出 0（buildId **`wb-171198408fbddb4d`**、inputs **179**、`lib/client.js` **545.95 kB**）；
  `pnpm test` **993 / 992 通过 / 1 失败**（P6 开工时 **992/991/1** ⇒ **0 回归**；唯一失败＝既有 `test/db.test.mjs` 的
  Windows `rmSync` EPERM：`Error: EPERM, Permission denied: \\?\<TEMP>\dsh-personal-workbench-db-*`）。
  13 个出口自检全部退出 0：**32 / 49 / 47 / 57 / 67 / 103 / 161 / 135 / 152 / 152 / 153 / 198 / 94**
  （P1/P2/P3a/P3b/P3c/P3d/P4/P5a/P5b/P5c/P6b/P6c/P6d；其中 P3b 由 56→57、P5a 由 137→135、P5c 由 151→152 是 P6 期间的重锚结果）。
- P6-4 新增/改动：新增 `src/client/hooks/useWorkbenchDirectoryPicker.ts`、
  `scripts/lib/d17-p6d-exit-check.py`、`scripts/lib/d17-mutate-p6d.py`、`scripts/lib/d17-cut-p6d.py`；
  改 `src/client/index.tsx`、`scripts/lib/d17-p6c-exit-check.py`（§8 `direct_state` 5→0，203→198 项）；
  **没有改任何 `test/*.mjs`，也没有改任何 `scripts/repro/probe-*.mjs`**。
- P6-3 新增/改动：新增 `src/client/hooks/useWorkbenchAISessions.ts`、
  `scripts/lib/d17-p6c-exit-check.py`、`scripts/lib/d17-mutate-p6c.py`、`scripts/lib/d17-cut-p6c.py`；
  改 `src/client/index.tsx`、`scripts/lib/d17-p5c-exit-check.py`（§6/§8 跟改，151→152 项）、
  `scripts/lib/d17-p4-exit-check.py`（随 `startAISession` 搬走的那句跟改）、
  `test/personaWiring.test.mjs`、`test/progressWiring.test.mjs`、`test/modelPickerDegrade.test.mjs`、`test/quickIntakeClient.test.mjs`。
- P6-2 新增/改动：新增 `src/client/hooks/useWorkbenchQuickIntake.ts`、`src/client/intakeHelpers.ts`、
  `scripts/lib/d17-p6b-exit-check.py`、`scripts/lib/d17-mutate-p6b.py`、`scripts/lib/d17-cut-p6b.py`；
  改 `src/client/index.tsx`、`scripts/lib/d17-p5a-exit-check.py`（§6 两条移交 p6b，141→135 项）、
  `scripts/repro/probe-quick-workspace-mutations.mjs`（M6/M14 重锚 + 新增 M16 ⇒ 16/16）、
  `scripts/release-preflight.mjs`（`KNOWN_PROBE_DEBT` 里 quick-workspace 一条销账删除，只剩 model-picker 一条）、
  `test/quickIntakeDefaultWiring.test.mjs`、`test/quickWorkspaceDefault.test.mjs`。
- P6-1 新增/改动：新增 `src/client/hooks/useWorkbenchNavigation.ts`、`src/client/hooks/useWorkbenchBusy.ts`、
  `scripts/lib/d17-cut-p6a.py`（一次性搬迁脚本）；改 `src/client/index.tsx`、`test/taskDetailWiring.test.mjs`、
  `scripts/lib/d17-p3b-exit-check.py`（§7 56→57 项）、`scripts/lib/d17-mutate-p3b.py`（M-P3B-4 靶点跟到 hook）。
  ⚠️ 本批是 P6 里**唯一净增行数**的子批（入口 +9、`WorkbenchApp` +7），且**没有独立出口自检/反向变异脚本**（无 `d17-p6a-exit-check.py` / `d17-mutate-p6a.py`）。
- P5-3 新增/改动：新增 `src/client/hooks/useWorkbenchDrafts.ts`、`src/client/hooks/useWorkbenchPolling.ts`、
  `scripts/lib/d17-p5c-exit-check.py`、`scripts/lib/d17-mutate-p5c.py`、`scripts/lib/d17-cut-p5c.py`；
  改 `src/client/index.tsx`、`src/client/hooks/useWorkbenchReminders.ts`（`tickDue` 包 `useCallback`）、
  `scripts/lib/d17-p5b-exit-check.py`（§5 五条移交 p5c + 两条 `tickDue` 锚点原文跟改，156→152 项）。
  **没有改任何 `test/*.mjs`，也没有改任何 `scripts/repro/probe-*.mjs`**（本批声称并实测"零判据重锚"）。
- P5-3 的一次真实事故（已修，登记为教训）：`scripts/lib/d17-cut-p5c.py` 第一版在 Python 双引号字符串里
  直接写了中文引号 `"暂存→唤回"` → `SyntaxError`（与 p5b 同款坑，第二次踩）。**cut 脚本里的中文注释一律用「」。**
- P5-2 新增/改动：新增 `src/client/hooks/useWorkbenchReminders.ts`、
  `scripts/lib/d17-p5b-exit-check.py`、`scripts/lib/d17-mutate-p5b.py`、`scripts/lib/d17-cut-p5b.py`；
  改 `src/client/index.tsx`、`scripts/lib/d17-p5a-exit-check.py`（§6 移交四条断言，141→137）、
  `scripts/lib/d17-p3d-exit-check.py`（`currentTaskId()` 3→1）、`docs/design/2026-09-09-client-split-backlog.md`。
  **没有改任何 `test/*.mjs`，也没有改任何 `scripts/repro/probe-*.mjs`**（本批声称并实测"零判据重锚"）。
- P5-1 新增/改动：新增 `src/client/settingsFallback.ts`、`src/client/hooks/useWorkbenchFeedback.ts`、
  `src/client/hooks/useWorkbenchSettings.ts`、`scripts/lib/d17-p5a-exit-check.py`、`scripts/lib/d17-mutate-p5a.py`、
  `scripts/lib/d17-cut-p5a.py`；改 `src/client/index.tsx`、`test/knowledgeRecallRoutes.test.mjs`、
  `test/quickWorkspaceDefault.test.mjs`、`scripts/repro/probe-quick-workspace-mutations.mjs`、
  `docs/design/2026-09-09-client-split-backlog.md`。
- 工作树改动（P4 后）：
  `src/client/index.tsx`（M）、`src/client/views/TaskDetailPane.tsx`（M）、
  `test/listViewWiring.test.mjs`（M）、`test/capacityWiring.test.mjs`（M）、`test/progressWiring.test.mjs`（M）、
  `test/taskDetailWiring.test.mjs`（M）、`test/workspacePickerWiring.test.mjs`（M）、`test/dayPanelWiring.test.mjs`（M，P4 新改）、
  `scripts/repro/probe-capacity-mutations.mjs`（M，P4 新改：I1 重锚）、`docs/design/2026-09-09-client-split-backlog.md`（M）、
  新增 `src/client/app/contracts.ts`、
  `src/client/hooks/{useKnowledge,useIdeas,useTaskListModel,useTaskDetailModel,useTaskForms,useTaskData,useDayWorkspace}.ts`、
  `src/client/views/{KnowledgeListView,KnowledgeDetailPane,IdeasListView,IdeasDetailPane,TaskListView,TaskDetailPane,TaskFormModal,TodayPane,CalendarView}.tsx`、
  `test/_clientSources.mjs`、`test/taskDetailWiring.test.mjs`、
  `scripts/lib/d17-*.py`（exit-check **七个**、mutate **七个**、`d17-cut-p3a/p3b/p3c/p3d/p4.py`、`d17-comment-scan.py`、`d17-measure3.py`、
  `d17-scan.py`、`d17-scope.py` 等）。
- 3080 / 19387 **未动**；正式库未迁移；未装盘；未改版本号（仍 1.16.2）。
- `lib/` 是构建产物（gitignored），本地构建产物只代表本次本地构建，不代表浏览器套件跑过 —— 截至 P6-4 仍**没有开浏览器**。
- 入口死 import **累计 12 个**（P4 的 10 个 + P6-4 新增的 `localDirRequestUrl` / `LocalDirListing`），按 P4 的决定**留给 P7 一次性清**；
  `useDayWorkspace.ts` 的 `clearTodayPlan` 死代码仍留 hook。

