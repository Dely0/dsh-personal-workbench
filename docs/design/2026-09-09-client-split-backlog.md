# D17 客户端拆分：WorkbenchApp 新版施工图

> 状态：**拆分实施中 —— P1（知识域）、P2（点子域）、P3-1（任务列表域）、P3-2（任务详情面板）、P3-3（任务表单弹窗）、P3-4（任务数据域）、P4（日期域）、P5-1（反馈域 + 设置域）、P5-2（提醒域）、P5-3（草稿域 + 轮询装配）、P6-1（导航 + 忙碌标志）、P6-2（快速录入域）、P6-3（AI 会话域）、P6-4（目录选择域）已完成。至此设计 §2.1 判据 3「today/calendar/list/knowledge/ideas 五个视图及任务详情各自成组件」全部达成，且 P5 整批出口口径「无双轮询；计数与屏蔽分离；通知不重复」闭合；入口 5725 → 2814、`WorkbenchApp` 4197 → 1389，`setInterval`/`setTimeout`/`fetch` 三条结构硬门已为 0，**`WorkbenchApp` 体内直接 `useState(` 亦已为 0**（P6 四批把最后 27 项 state 全部归域）；P6 收尾时只剩 **P7 未开工**（`views/*` JSX 收口、工具栏/弹窗装配提取、入口 12 个死 import、体内 6 处 `api(`）**。**P7 后：**P7-1/P7-2/P7-3 三批已完成 —— 入口 **2814 → 1972**、`WorkbenchApp` **1389 → 631**（P7-1 最后 6 处请求归域 / P7-2 四段 JSX 进 `app/` + 装配束 `app/assembly.ts` / P7-3 死 import 与死解构清零），体内 `useState(`/`api(`/`fetch(`/`setInterval(`/`setTimeout(` **全为 0**、单个顶层块 ≤80 行 **0 违例**，行数护栏按 ADR 校准为 **≤650**（实测 631；≤600 努力目标未达成、差 31 行）**。本版替代原 1958 行时代施工图。
> 对应任务：`8e5ea61d-0021-4317-8398-419b8501e6a9`。
> 实施进度与证据见 [任务资料夹](../tasks/8e5ea61d-0021-4317-8398-419b8501e6a9-D17客户端拆分/handover.md)；
> 各批次行数 before→after 与验证结果见同目录 [verification.md](../tasks/8e5ea61d-0021-4317-8398-419b8501e6a9-D17客户端拆分/verification.md)。
> 原文件路径保留，避免现有任务、ADR 和计划链接失效。历史实现过程由 Git 保留。
>
> 实测施工起点（2026-10-03，HEAD `f99bf77`，与 §1 的"本次源码调研快照"**逐项一致**；
> 度量脚本 `scripts/lib/d17-measure3.py`，口径 = 去掉 CRLF 后的物理行数）：
> 入口 **5725 行** / `WorkbenchApp` 本体 **4197 行**（276–4472）/ 主组件直接 `useState` **114**；
> `pnpm test` **984 条 / 983 通过 / 1 失败**（唯一失败 = 既有 `test/db.test.mjs` 清理期 EPERM）。
> P1 后：入口 **5451 行**（-274）/ `WorkbenchApp` **3975 行**（-222）。
> P2 后：入口 **5138 行**（-313）/ `WorkbenchApp` **3660 行**（-315）；累计 5725 → 5138（-587）。
> P3-1 后：入口 **5034 行**（-104）/ `WorkbenchApp` **3568 行**（-92）；累计 5725 → 5034（-691）/ 4197 → 3568（-629）。
> P3-2 后：入口 **4754 行**（-280）/ `WorkbenchApp` **3285 行**（-283）；累计 5725 → 4754（-971）/ 4197 → 3285（-912）。
> P3-3 后：入口 **4675 行**（-79）/ `WorkbenchApp` **3204 行**（-81）；累计 5725 → 4675（-1050）/ 4197 → 3204（-993）。
> P3-4 后：入口 **4571 行**（-104）/ `WorkbenchApp` **3101 行**（-103，源码 218–3318）；累计 5725 → 4571（-1154）/ 4197 → 3101（-1096，距 `WorkbenchApp` ≤600 还差 2501）；
> P4 后：入口 **4188 行**（-383）/ `WorkbenchApp` **2715 行**（-386，源码 221–2935）；累计 5725 → 4188（**-1537**）/ 4197 → 2715（**-1482**，距 `WorkbenchApp` ≤600 还差 **2115**）；新增 `hooks/useDayWorkspace.ts`（533 行）、`views/TodayPane.tsx`（153 行）、`views/CalendarView.tsx`（106 行）；
> P4 后（含 P3 各批汇总）：`pnpm test` **992 条 / 991 通过 / 1 失败**（与 P3-2/P3-3 后同数 ⇒ 0 回归；唯一失败仍是既有 db EPERM）；
> 出口自检 **32 / 49 / 47 / 56 / 67 / 103 / 161** 项（P1 / P2 / P3a / P3b / P3c / P3d / P4）全退出 0，反向变异 **2/2、3/3、4/4、6/6、7/7、8/8、11/11** 全被捕获；
> `probe-capacity-mutations.mjs` 的 I1 已二次重锚到 `hooks/useDayWorkspace.ts`（新增常量 `DAY_WORKSPACE`），重锚后 **20/20 全红**。
> P5-1 后：入口 **4071 行**（-117）/ `WorkbenchApp` **2617 行**（-98，源码 202–2818）；累计 5725 → 4071（**-1654**）/ 4197 → 2617（**-1580**，距 `WorkbenchApp` ≤600 还差 **2017**）；新增 `hooks/useWorkbenchFeedback.ts`（64 行）、`hooks/useWorkbenchSettings.ts`（252 行）、纯模块 `settingsFallback.ts`（36 行，从入口搬出 `SETTINGS_FALLBACK` + `withSettingsFallback`）；
> `pnpm test` **992 / 991 / 1**（0 回归）；出口自检 **141** 项（P5a）退出 0，反向变异 **11/11** 全被捕获，`probe-quick-workspace-mutations.mjs` 的 M12/M13 已重锚到 `hooks/useWorkbenchSettings.ts`（仍 13/15，未发现的 M6/M14 是 P6 既有欠账）。
> P5-2 后：入口 **3926 行**（-145）/ `WorkbenchApp` **2471 行**（-146，源码 203–2673）；累计 5725 → 3926（**-1799**）/ 4197 → 2471（**-1726**，距 `WorkbenchApp` ≤600 还差 **1871**）；新增 `hooks/useWorkbenchReminders.ts`（321 行，7 项 state + 3 条设施 + 8 个动作 + `tickDue(isAlive)` + 2 条 effect，**0 定时器**）；
> `pnpm test` **992 / 991 / 1**（0 回归）；出口自检 **137 / 156** 项（P5a / P5b）退出 0，反向变异 **12/12** 全被捕获；
> **P5-2 是"零判据重锚"的最干净样本**：`test/*.mjs` 与六个探针**一条都没改**（提醒域没有任何客户端文本断言），六个探针逐条复跑、条数全同（20/20、17/17、19/19、46/46、13/15、7/10）。
> 唯一被打回的两处是**上一批自己写下的跨批出口自检**：`d17-p5a-exit-check.py` §6 四条提醒域动作（141 → 137）与 `d17-p3d-exit-check.py:198` 的 `currentTaskId()` 计数 3 → 1。
> ⚠️ 轮询刻意**不**随 P5-2 搬迁：5 秒 `tick` + 15 秒 `refresh` 那条混合域 effect 只把提醒半段换成 `await tickDue(() => alive)`（L629），整片归 P5-3 的 `useWorkbenchPolling`。
> P5-3 后：入口 **3724 行**（-202）/ `WorkbenchApp` **2267 行**（-204，源码 205–2471）；累计 5725 → 3724（**-2001**）/ 4197 → 2267（**-1930**）；新增 `hooks/useWorkbenchDrafts.ts`（348 行，7 项 state + 3 个 ref + 10 个动作 + `tickDrafts(isAlive)`）、`hooks/useWorkbenchPolling.ts`（61 行，无业务状态、只接管 1 条 effect）；`hooks/useWorkbenchReminders.ts` 的 `tickDue` 改为 `useCallback(…, [desktopNotify])`；
> `pnpm test` **992 / 991 / 1**（0 回归，唯一失败仍是既有 db EPERM）；出口自检 **137 / 152 / 151** 项（P5a / P5b / P5c）退出 0，反向变异 **12/12** 全被捕获；
> **P5-3 达成一条 ADR-0008 硬门**：`WorkbenchApp` 体内 `setInterval(` / `setTimeout(` 均为 **0**（入口整份文件只剩插件 setup 作用域的 `titlebarTimer`）；尚未清零的是直接 `useState(` 27 项、`api(` 27 处、`useEffect(` 4 条，最长顶层块仍是 `startAISession` 500 行。
> **P5-3 是第二个"零判据重锚"样本**：`test/*.mjs` 与六个探针**一条都没改**；唯一要改的是上一批自己写下的五条轮询断言（`d17-p5b-exit-check.py` §5），按"判据跟着 owner 走"移交 p5c 并加注释说明（156 → 152）。
>
> **2026-10-04 判据 1 变更**（[ADR-0008](../adr/0008-workbenchapp-exit-criteria.md)）：上表各批次里「距 `WorkbenchApp` ≤600 还差 N」只是**历史记录**，自本日起验收改为两半——**结构约束（0 直接 state / 0 业务请求 / 0 定时器 / 顶层块 ≤80 行）是硬门，行数 ≤900 是护栏**（每批单调下降，P6 收尾后按实测校准）。实测依据：P5-2 后 `WorkbenchApp` 2471 行 = JSX 676 行 + 装配 1794 行，内直接 `useState(` 34 项、`api(` 32 处、`setInterval(` 2 处，最长顶层块 `startAISession` 500 行（P5-3 后降为 2267 行 / 27 项 state / 27 处 api / 0 定时器；余下 27 项 state 逐项属于 P6 的四个域，**P7 清单里没有任何 state**）。故 P7 是纯 JSX 与装配收口，≤600 需额外把 props 拼装一并归位——那一步收益单独论证，不由整数逼出。
>
> **P7 后（P7-1～P7-3 全部完成）**：入口 **2814 → 1972（-842）** / `WorkbenchApp` **1389 → 631（-758）**；累计 5725 → **1972（-3753）** / 4197 → **631（-3566）**。
> 结构硬门**全部达成**：体内直接 `useState(` **0**、`api(` **0**、`fetch(` **0**、`setInterval(` **0**、`setTimeout(` **0**、单个顶层块 >80 行的 **0 个**（共 41 个顶层块，最大 66 行 `saveEditDraft`）；`useEffect(` **3**（刻意留装配层：L283 启动 `refresh` 装配 / L314 `dismissOnTaskChange` / L316 `PENDING_ATTR` DOM 投影）。
> **行数护栏按 ADR 校准为 ≤650**（原值 ≤900，实测 631 达标）；§2.1 的 ≤600 是努力目标，实测 **631，未达成（差 31 行）**。
> 新增：`app/assembly.ts`（91 行，`WorkbenchAssembly` = 16 个域 hook 结果 + `runtime`/`closePanel`/`loadModelModalityTable`/`aiSessionUsable` + 17 个装配层本地值）、
> `app/WorkbenchHeader.tsx`（44）/ `app/WorkbenchOverlays.tsx`（195）/ `app/WorkbenchBody.tsx`（224）/ `app/WorkbenchDialogs.tsx`（358）；
> 入口渲染顺序 = 搬迁前 DOM 顺序（Header → Overlays → Body → Dialogs → ToastHost，入口 L715–719）；四段**逐字搬出**、不持有 state / 不发请求 / 不 import 域 hook。
> **与 §3 / §7 的偏差**：`WorkbenchApp` **未**移入 `app/WorkbenchApp.tsx`（仍在 `src/client/index.tsx` 第 92–722 行），搬走的是四段 JSX 与装配束。
> 判据与门禁：出口自检 **15 个全部退出 0**（P7a 72 / P7b 220；P5a 138 / P5b 152 / P5c 152 / P6b 155 / P6c 198 / P6d 96），反向变异 **15 个全部真跑 N/N**（P7a 6/6、P7b 13/13）；
> 六个探针 **0 存活**（capacity 20/20、listview 17/17、knowledge-draft-overwrite 19/19、knowledge-recall 46/46、quick-workspace 16/16、model-picker 10/10）；
> `node scripts/release-preflight.mjs --phase pre` 退出 **0**（`KNOWN_PROBE_DEBT` 已清空）；`npx tsc --noEmit` 0；`pnpm build` 0（`lib/client.js` 549.00 kB / gzip 162.69 kB）；
> `pnpm test` **993 / 992 通过 / 1 失败**（唯一失败＝既有 Windows `rmSync` EPERM）。
> **未做（如实登记）**：没有开浏览器跑 §9 的 10 套浏览器判据、没有 `git commit`（P1–P7 全在工作树）、没有装盘、3080 / 19387 端口未动、正式库未迁移、版本号仍 **1.16.2**；`hooks/useDayWorkspace.ts#clearTodayPlan` 死代码**保留**（搬迁前即存在，不是 D17 引入）。

## 1. 依据与基线

权威约束：

- [项目编码规范](../../.dsh/skills/dsh-plugin-change/SKILL.md)，尤其 §0 状态权威源、§2 纯逻辑与 DOM/React 解耦、§9 删除顺序、§12 拆分出口。
- [架构约束](../../.dsh/skills/dsh-plugin-change/references/architecture.md)：依赖单向、宿主 DOM 写入白名单、官方槽位、单组件目标 ≤300 行、纯模块目标 ≤200 行。该文的旧行数和 schema 数字是历史快照，不是当前基线。
- [ADR0001 日期面板](../adr/0001-today-is-the-day-panel.md)、[批次2计划 D17](../tasks/36c8e8ef-1104-4e68-b55f-a2a6cc533ab9-工作台插件优化/plan.md)、[批次2剩余清单](../tasks/36c8e8ef-1104-4e68-b55f-a2a6cc533ab9-工作台插件优化/todo.md)。
- 当前入口 [src/client/index.tsx](../../src/client/index.tsx)、[DayPanel](../../src/client/components/DayPanel.tsx)、[日期面板数据层](../../src/client/dayPanelModel.ts)、[WorkspacePicker](../../src/client/components/WorkspacePicker.tsx)。

本次源码调研快照：

| 项目 | 历史任务口径 | 本次读取结果 | 实施记录方式 |
|---|---|---|---|
| 包版本 | 批次2发布 1.16.1 | package.json 为 1.16.2 | 只表示源码声明，不代表当前运行实例或发布状态 |
| 入口总行数 | 5697 | **5725（实测施工起点）** | 施工前重新测量；历史目标不得因基线增长而放宽 |
| WorkbenchApp 本体 | 约4170 | **4197（实测施工起点），源码快照276–4472** | 用函数边界测量，不把行号当迁移锚点 |
| 主组件直接 useState | 117（旧统计） | 114 | §4 列出114项；全文件另有2处宿主组件 tick，合计116 |
| 日期面板 | 三页签时期 | 计划/逾期/未排期/已完成/报告 | 复用已有组件与纯成员判定 |
| 浏览器白名单 | 10套 | 10套 active + required | 清单声明不是本轮通过证据 |
| 单测 | 历史957条，956通过/1既有失败 | **984条，983通过/1失败（施工起点实测）** | 失败用例 = 既有 `db migrations, dictionaries and task tree` 清理期 EPERM |

计数应统一为物理行数，含末行无换行的情况；PowerShell 可用 `(Get-Content -LiteralPath src/client/index.tsx).Count`。实现时记录提交标识、起止边界、总行数、主组件直接状态数及通过用例数。不要把 import 里的 `useState` 当调用计数，不把子组件内调用算作主组件直接调用。

本轮工具中的 PowerShell 启动以 `3221225794` 退出，未获得 Git 状态或 diff 检查结果；设计依据来自文件读取和源码检索。本轮没有执行构建、测试、探针、安装、重启或发布。

> 补充（2026-10-03，施工起点）：随后已实测 `pnpm typecheck`=0、`pnpm build`=0、
> `pnpm test` 984/983/1，并把该行数/用例数写进本文件文首与 §1 表格。上文那句只描述**设计轮**的状态。

## 2. 目标与范围

### 2.1 硬出口

1. `WorkbenchApp` 本体**只装配模型、布局、视图和弹窗**——不承载业务状态、业务请求、长 handler、政策判定、轮询或宿主 DOM 操作（**硬门**，源码扫描证伪：主组件体内直接 `useState(` / `api(` / `fetch(` / `setInterval(` / `setTimeout(` 各为 **0**，单个顶层块 **≤80 行**）；行数 **≤900 且每批单调下降**（**护栏**，P6 收尾后按实测校准一次 —— **P7 收尾实测校准为 ≤650**，≤600 降为努力目标）。口径、被否方案与理由见 [ADR-0008](../adr/0008-workbenchapp-exit-criteria.md)。
2. `src/client/index.tsx` 最终总行数 **<5697，且小于实际施工起点**；每个代码迁移提交记录入口和主组件 before→after。仅文档/测试提交注明“不改变入口行数”。
3. today/calendar/list/knowledge/ideas 五个视图及任务详情各自成组件；右侧知识、点子详情也归各自域。
4. §4 的状态以及关联 ref/effect/handler 有唯一所有者；派生量由权威输入计算，不复制成第二份可写状态。
5. 原行为、DOM层级、CSS类名、data属性、表单字段、portal挂载位置和交互顺序保持。保留现有纯政策、API与持久化键。
6. 每个迁移提交可运行，源码扫描与变异锚点同步迁移；不提交双实现或未接线的半成品。

### 2.2 必须纳入拆分

除五个视图与任务详情外，还包含任务新建/编辑、快速录入、共享提示词、待处理/重复任务/提醒弹窗、知识文件选择、工作区目录选择、设置接线、草稿轮询和AI会话流程。只搬视图不能达到布局型主组件。

### 2.3 不纳入本次行为改动

- 不改变 API、工具、数据库迁移、进度/验收语义、计划投入快照、未来排期规则。
- 不调整CSS、文案、通知频率、会话复用政策或存储键，不引入全局store或新依赖。
- 不为了降低props数量引入Context；旧“超过约40个props就用Context”的规则撤销。职责边界与类型化参数优先。
- 不把逻辑整体搬入万能 `useWorkbenchModel`、巨型controller或全域Context。门面仅组合较小模块。
- 不借拆分修模型跨入口同步、错误吞掉、异步竞争或既有文案偏差。发现问题记录证据；行为修复单独范围、提交与判据。
- 不因父任务级联完成而认定D17完成；本任务自身出口和证据必须独立验收。

## 3. 模块结构与依赖方向

以下路径是**拟新增模块**，不是已存在的实现；现有组件可继续直接复用。每个域可以细分子hook，但不得复制其权威状态。

| 层/目录 | 拟新增职责 | 允许依赖 | 不允许依赖 |
|---|---|---|---|
| `src/client/index.tsx` | 现有客户端入口与宿主生命周期装配；组合WorkbenchApp | app、既有宿主适配/政策/样式 | 业务流程内联 |
| `src/client/app/WorkbenchApp.tsx` | 主布局、调用域hook、传入显式跨域回调 | hooks、views、详情与弹窗 | SQL/Node、视图成员政策内联 |
| `src/client/app/contracts.ts` | 输入快照、动作接口、刷新范围的类型契约 | `viewTypes.ts`、共享类型（type import） | React、DOM、域实现 |
| `src/client/hooks/` | 拥有状态、请求、effect和动作 | api、纯政策、明确输入回调 | views、index、兄弟域hook实现 |
| `src/client/views/` | 五个视图薄装配；展示快照、发用户意图 | components、类型、纯格式化 | api请求、存储、宿主私有API |
| `src/client/components/` | 详情分区、弹窗、现有通用展示件 | 类型、纯展示工具 | 域hook、跨域数据写入 |
| `src/client/policies/`（按需） | 从入口搬出的可测试纯判定 | 共享纯模块和类型 | React、DOM、浏览器存储、宿主服务 |
| `src/client/host/`（仅必要时） | 入口已有宿主适配，保持原判定与清理 | runtimeServices、panelState、entryContract等 | 业务视图、域数据请求 |

依赖从装配层向下。跨域协作通过装配层注入类型化回调或只读快照；不同域hook不能互相import实现。同域门面可单向调用自己的子hook，子hook不得反向import门面。类型契约不反向引用hook返回类型，防止通过类型也形成依赖环。既有 `dayPanelModel.ts` 本身是React hook，不应为了目录整齐搬进纯policy目录。现有通用组件自身的局部UI状态（如选择器浮层）继续保留；禁止迁入组件的是跨域数据权威源与业务写入流程。

主组件拟定分工：`WorkbenchToolbar` + 当前View + 右侧对应详情 + `WorkbenchDialogs` + 已有ToastHost。`WorkbenchDialogs` 只装配弹窗，不拥有全部弹窗状态；右侧分派器不统一存三域详情。组件迁移不得多包一层DOM，可用Fragment保持层级。

任务详情进一步拆为标题/动作、描述、子任务、会话、记录/复盘/记忆、关联知识等小展示区；AI会话拆为选项、提示词、执行流程、宿主引用生命周期。每个新文件在接近规范规模目标时继续按职责分解，不把入口变短等价为架构完成。

## 4. 状态所有权清单（114项完整映射）

保留当前变量名作为迁移检索键。数量按主组件**直接**调用计算，不含已有 `useToasts` 等hook内部状态。括号中的数量合计114；目录与名称为拟定接口。

| 所有者 | 当前state（逐项列出） | 边界 |
|---|---|---|
| `useWorkbenchNavigation`（1） | `view` | 只负责视图选择；打开任务的导航意图从装配层注入 |
| `useTaskData`（5） | `bootstrap`, `tasks`, `pendingCompletions`, `selected`, `taskKnowledge` | bootstrap含字典/今日计划仍保留原响应权威源；详情和任务关联知识不由知识列表覆盖 |
| `useTaskDetailModel`（6） | `detailTab`, `sessionPickerOpen`, `sessionPickerRole`, `sessionPickerQuery`, `sessionPickerBusy`, `eventsExpanded` | 消费选中详情；关联会话通过明确动作；切视图不自动重置 |
| `useTaskForms`（4） | `showForm`, `subtaskParent`, `editDraft`, `formWorkspace` | 保留新建表单非受控字段和工作区受控字段、隐藏字段提交协议 |
| `useQuickIntake`（9） | `showQuick`, `quickText`, `quickWorkspace`, `quickWorkspaceTouched`, `quickWorkspaceSource`, `quickFollowFolder`, `quickAttachments`, `quickAttachmentNotice`, `quickPersona` | 打开时预填/复位及附件列表写入唯一；clarify仍用快速录入入口 |
| `useDrafts`（7） | `pendingDraft`, `deferredDrafts`, `draftProblems`, `draftSwitchedFrom`, `allPendingDrafts`, `pendingOpen`, `duplicatePrompt` | 服务端清单与本地自动弹出投影分离；重复提示不静默合并任务 |
| `useReminders`（7） | `reminders`, `reminderModalOpen`, `notifyPerm`, `reminderPolicy`, `reminderChannel`, `reminderOptions`, `reminderBusy` | 通知去重、授权、发送、提醒设置同域子边界；不复制settings |
| `useWorkbenchFeedback`（2） | `error`, `notice` | 保留当前effect转Toast桥接语义；各域注入消息出口，不各建一份Toast队列 |
| `useWorkbenchSettings`（9） | `settings`, `showSettings`, `settingsSaving`, `recallLog`, `recallSessionOff`, `dictKind`, `dictForm`, `dictEditCode`, `dictError` | 设置值唯一；字典CRUD成功刷新bootstrap；召回日志按打开设置门控 |
| `useDayWorkspace`及内部日期/计划/报告子hook（17） | `capacityEdit`, `capacityExpanded`, `reportSubTab`, `currentReport`, `reportSession`, `pickedPlan`, `pickedPlanSession`, `planRefreshKey`, `reportRefreshKey`, `todayPlanSession`, `todayExpanded`, `calendarExpanded`, `picked`, `addingPlanTaskId`, `cursor`, `calMode`, `dayTab` | 共享dayTab；两套展开集合分开；复用dayPanelModel；设置写入委托settings所有者 |
| `useKnowledge`（11） | `knowledgeEntries`, `knowledgeFilters`, `selectedKnowledge`, `knowledgeDraft`, `knowledgeEditId`, `knowledgeRefreshKey`, `localDocPath`, `filePickerOpen`, `filePickerListing`, `filePickerLoading`, `filePickerError` | 知识列表/详情/文件模式选择；筛选持久化与当前加载门控不变 |
| `useIdeas`（12） | `ideas`, `ideaClusters`, `ideaTab`, `ideaQuery`, `ideaKind`, `selectedIdeaIds`, `selectedIdea`, `selectedCluster`, `ideaForm`, `ideaEditId`, `folderForm`, `ideaRefreshKey` | 点子/点子王/未归类及右侧编辑；文件夹菜单纯UI继续在IdeaCardGrid |
| `useTaskListModel`（7） | `archivedTasks`, `archivedMode`, `taskFilter`, `taskSortKey`, `taskSortDir`, `openFilter`, `expanded` | 当前/归档数据不混源；消费任务数据、字典和唯一排序政策 |
| `useAISessions`及选项/提示词子hook（12） | `busy`, `promptModal`, `skillCatalog`, `skillsAvailable`, `skillsLoading`, `skillProblem`, `skillQuery`, `selectedSkills`, `promptPersona`, `promptModelSelection`, `quickModelSelection`, `modelModalityTable` | 保留原共享busy用途；两入口模型编辑态独立，唯一持久化适配负责同键读写 |
| `useWorkspaceDirectoryPicker`（5） | `dirPickerTarget`, `dirPickerPath`, `dirPickerListing`, `dirPickerLoading`, `dirPickerError` | 唯一目录弹窗，明确quick/form/edit目标；只经各表单动作写值 |

### 4.1 ref、effect与派生量必须一起迁移

| 原符号/职责 | 新归属 | 保持的不变量 |
|---|---|---|
| `selectedRef`、详情加载/刷新 | TaskData | ref只镜像选中ID；成功/清空时按原路径更新；不可成为第二份详情数据 |
| `quickAttachmentsRef`, `quickImageInputRef`, `writeQuickAttachments` | QuickIntake | 所有附件修改使用同一出口，同时写state/ref；清理和对象URL释放沿用原时机 |
| `dismissedDraftIdsRef`, `deferredWhenDismissedRef`, `bannerDraftRef` | Drafts | 收起不改变待处理计数；仅真实暂存→唤回转换解除屏蔽；不同类型递补告知保持 |
| `notifiedRef`, `persistNotified` | Reminders | 使用原存储键、>500保留后250规则；不可因重挂载重发旧提醒 |
| `promptResolveRef` | AI提示词子hook | 确认/取消各按原路径结算；搬迁不引入双resolve或遗失resolver |
| pendingMap、childrenIndex、dicts/dictOf | TaskData只读派生 | pending不可用=null与空Map不同；只算直接子任务旁证 |
| today/picked候选、capacity、dayPanel props | DayWorkspace | 从现有纯政策派生；todayPlan读取bootstrap，不复制一份可写今日计划 |
| knowledgePage、ideaCardItems、unfiledIdeas | 对应域只读派生 | 不新增可写可见集合；维持现有查询与筛选口径 |
| 宿主selected镜像、面板显示、几何与槽位effect | 现有宿主适配 | `decidePanel`/`panelDataOpen`保持唯一；DOM白名单和清理不变 |

实施前在任务资料夹补充机器可核对的迁移台账：每个state/ref/effect/handler的旧符号、新owner、全部写入口、读取者、依赖、存储键、请求、清理、测试、迁移提交。§4已覆盖状态；effect/handler逐项台账应从当前源码再生成，不能以这张职责概览冒充已完成逐项核对。

### 4.2 状态生命周期

所有会随视图切换仍保留的域hook在 `WorkbenchApp` 顶层无条件调用，放在条件视图渲染之外。视图可以按条件挂载，但不能因此重置域筛选、选中、编辑、展开或日期。请求仍通过 `activeView`、`showSettings`、`dayTab` 等原门控触发；hook常驻不等于全域持续请求。

保持原面板关闭/重开、客户端卸载以及表单关闭时的实际重置点；不要把“关闭面板”和“卸载React组件”假定为同一件事。补充切视图往返和开关面板回归场景。

## 5. 接口与跨域协作

### 5.1 输入和动作约束

每域返回小型 `snapshot` 与 `actions`，其类型字段显式声明；不得全量spread一个域模型进任意组件。可按任务/计划/AI等自然职责聚合props，不设数量阈值。展示组件不拿跨域setter，不自行调用HTTP。

关键动作拟定契约（名称可在实施时沿原符号保留，语义必须保持）：

| 动作 | 输入/结果 | 所有者与协作 |
|---|---|---|
| `loadTaskDetail(taskId)` | 只加载，不导航；保留原返回/错误处理方式 | TaskData |
| `openTaskById(taskId)` | 加载详情并按原行为切list | 装配层组合TaskData与Navigation |
| `refreshTaskSnapshot()` | 更新bootstrap/tasks/pending，并按最新选中ID刷新详情/事件/复盘/关联知识 | TaskData；初期对应原refresh，不能拆成多个独立重复请求 |
| `patchTask(id, patch)` / 保存进度 / 完成任务 | 保留原请求、确认、验收与刷新顺序 | TaskData动作；触及计划时经注入回调作原刷新 |
| `addTaskToPlan(taskId, minutes?)` | 沿用POST项级唯一写入口和服务端分钟回执 | DayWorkspace；所有行入口调用同一动作 |
| `patchPlanItem(date, taskId, patch)` / `savePlan(date, items)` | 保留items、minutes、effortDone与历史只读规则 | DayWorkspace |
| `saveSettings` / 修改容量或最近工作区 | 所有设置写入和最终setSettings只在一域 | Settings；日期/录入域注入类型化设置动作 |
| `startAISession(...)` | 保留十个mode、原参数及Promise语义；不增加任务字段 | AISessions；各域提供任务/日期/点子/文档快照 |
| `openDirectory(target)` / `applyDirectory(path)` | target仅quick/form/edit；保持关闭、错误、写入行为 | DirectoryPicker；装配层注入三个sink动作 |
| `onDraftConfirmed(outcome, draft)` | 按原类型驱动刷新、导航、重复提示 | Drafts接收装配层回调；不import各域hook |

不要为了统一接口强行把所有void动作改成Promise、把所有请求改成新错误形状；类型应贴合现有操作，新增契约首先用于明确边界。

### 5.2 刷新图

迁移前逐个记录原handler的顺序；下面是职责归属，不授权额外刷新：

| 触发 | 刷新/失效范围 | 不能发生 |
|---|---|---|
| 启动/原15秒刷新 | TaskData现有refresh链 | 每行查pending、各视图重复bootstrap |
| 保存进度/完成进度动作 | 原任务刷新 + 仅详情加载，保持当前view | 调openTaskById使今日/日历跳回list |
| 手工保存/追加/修改计划 | 原任务bootstrap刷新 + 计划失效 | 多套计划写入口或重复累计投入 |
| 知识/点子CRUD或相应草稿确认 | 对应域原加载/失效；必要时原关联详情刷新 | 只刷新列表导致右侧旧数据，或全域轮询 |
| 设置/字典修改 | 唯一设置快照或原bootstrap链 | 日历/录入各持有另一份settings |
| 角色/计划/报告会话创建或复用 | 原会话注册与对应anchor刷新 | 每个入口各实现一次复用政策 |
| 草稿暂存/唤回/确认 | 原草稿投影及类型相关刷新 | 用dismissed集合过滤服务端待处理计数 |

`*RefreshKey`归各域；装配层只调用失效动作，不递增域内部key。刷新门面可以调多个注入的动作，但不能再拥有tasks/selected等数据副本。异步取消、防旧请求覆盖和并发策略在本次保持既有行为；若发现真实缺陷另列修复，不顺手重设计数据缓存。

### 5.3 轮询与副作用

当前草稿/提醒共用5秒tick，任务refresh为15秒；同effect随settings变化重建并带alive/clearInterval清理。拟用 `useWorkbenchPolling` 作为**无业务状态的effect装配器**，注入Drafts/Reminders/TaskData各自的tick动作，保留原请求顺序、频率、依赖重建和异常范围。

不能因拆域无意启动多份计时器，也不能把原顺序请求改为并发。若分离轮询失败隔离属于修复，须另行说明和验证。卸载后alive与现有释放路径保持；render不写DOM、不retain/release引用。

## 6. 必须保持的业务与宿主边界

### 6.1 日期面板

- TodayView只增加今日统计卡与容量条，CalendarView只增加周/月导航；二者消费同一 `DayPanel` 装配结果。
- 计划成员仍是当日到期∪当日计划项∪进行中；逾期允许与计划重叠；未排期=open−计划−逾期。不能断言三页签计数之和等于open总数。
- 过去日期隐藏逾期/未排期，按 `resolveDayPanelTab` 同一判定复位共享dayTab，避免“显示计划但请求闸门未加载”。
- 行内排入今日仅今天实例的逾期/未排期行且未在今日计划时出现；未来不出现。
- 今日计划取bootstrap，日历计划取picked请求；报告anchor随实际面板日期和日/周子页签派生，未来不拉报告。
- ADR0001 Consequences里容量条归入日期面板的旧措辞与当前“仅今日显示”不一致；D17以当前已验证实现和具体判据为准，不通过重构改变容量显示范围。

### 6.2 快速录入与AI

- `clarify` + `consult/breakdown/execute/review/plan/report/idea_association/idea_brainstorm/knowledge_doc`共十个mode，统一流程；两类弹窗仍各挂Model/Skill/Persona选择器。
- 保留角色inherit/none/selected三态、身份/来源判断、复用分流、绑定成功后才发prompt、角色块→技能块→正文顺序、工作区解析及任务资料夹逻辑。
- 保留宿主会话引用retain/release、模型应用与降级告知；宿主服务只经既有安全适配，不直连私有链式API。
- **模型所有权定案（保持行为）**：AI选项域拥有quick/prompt两份入口编辑态；同localStorage键只有既有持久化适配写入。两份值仍按mode选择，不新增实时同步effect。旧注释“同一份状态”可修正为“同键持久偏好、两份入口编辑态”，但同步行为单独修复。
- quickPersona归录入域，promptPersona归提示词域；共用PersonaSelection类型和纯判据，不能合并成一个会互相覆盖的值。
- 目录候选仍只有 `workspaceCandidates` 一处实现，读取宿主工作区快照集中一次；三入口通过共享DirectoryPicker与显式sink写回。

### 6.3 宿主与DOM

官方slots、面板可见性、buildId投影、hostSelectedFromMirror、侧栏量宽重试、TopInset清理及DOM白名单保持。D17优先不搬宿主apply主体；若入口辅助函数迁出以降总行数，同批迁移panelCss/panelStateSource/clientInvariants判据。禁止改inject、profile、启动方式或在宿主侧栏插节点。

## 7. 迁移批次与每次提交出口

这些是D17内部实施步骤，不自动创建工作台子任务。同一工作树共享入口编辑串行；仅独立审阅/证据整理可以并行。

| 批次 | 内容 | 必须同时交付 | 阶段出口 |
|---|---|---|---|
| P0 设计与基线 | 本文；实施前实测基线、详细所有权台账、现役失败归因 | 原职责→owner→扫描→变异→浏览器映射 | 没有未知owner；原门禁阻塞与D17新增回归明确区分 |
| P1 知识域 ✅ | KnowledgeView、知识详情/编辑、文件选择、useKnowledge | list/recall/knowledge扫描与探针同步 | 列表/右侧/编辑/文档入口保持；删旧知识实现 |
| P2 点子域 ✅ | IdeasView、点子/点子王详情与表单、useIdeas | 筛选/选择/归类/文件夹判据 | 点子全链与往返状态保持；删旧点子实现 |
| P3 任务域 ✅ | TaskData、TaskListView/Model、详情分区、任务表单 | progress/list/workspace/关联知识接线与场景 | 刷新不导航；新增/编辑/归档/子任务等保持 —— **P3-1（TaskListView + useTaskListModel）✅已完成**；**P3-2（TaskDetailPane + useTaskDetailModel + app/contracts）✅已完成**；**P3-3（TaskFormModal + useTaskForms）✅已完成**；**P3-4（useTaskData + 3 个装配层原语）✅已完成 —— P3 整批收尾** |
| P4 日期域 ✅ | TodayView/CalendarView、日期计划报告子hook | capacity/dayPanel/daily-effort扫描与变异 | 一份DayPanel装配；五页签/投入/容量/日期行为保持 —— **已完成**：落点 `hooks/useDayWorkspace.ts`（533 行）+ `views/TodayPane.tsx`（153 行）+ `views/CalendarView.tsx`（106 行）；探针 I1 已重锚到新 hook（新增常量 `DAY_WORKSPACE`），重锚后 20/20 全红；入口 4571 → 4188（-383） |
| P5 设置/提醒/草稿 | 设置与通知所有者、Drafts、反馈、轮询装配 | draft/duplicate/recall/提醒/面板开关判据 | 无双轮询；计数与屏蔽分离；通知不重复 —— **P5-1（反馈域 `hooks/useWorkbenchFeedback.ts` 64 行 + 设置域 `hooks/useWorkbenchSettings.ts` 252 行 + 纯模块 `src/client/settingsFallback.ts` 36 行）✅已完成**：入口 4188 → 4071（-117），`WorkbenchApp` 2715 → 2617（-98）；设置域 9 项 state + 12 个动作 + 6 条路由全部换 owner；出口自检 141 项、反向变异 11/11；`knowledgeRecallRoutes` 与 `quickWorkspaceDefault` 两条既有判据已"负向留入口 + 正向改指 hook"；探针 M12/M13 重锚到 `SETTINGS_HOOK`。**P5-2（提醒域 `hooks/useWorkbenchReminders.ts` 321 行）✅已完成**：入口 4071 → 3926（-145），`WorkbenchApp` 2617 → 2471（-146）；提醒域 7 项 state + 3 条设施 + 8 个动作全部换 owner（8 条路由），**`tickDue(isAlive)` 只搬混合域轮询的提醒半段、0 定时器**；出口自检 156 项、反向变异 12/12；`test/*.mjs` 与六个探针**零改动**（唯一重锚是跨批出口自检 p5a §6 与 p3d:198）。**P5-3（草稿域 `hooks/useWorkbenchDrafts.ts` 348 行 + 轮询装配 `hooks/useWorkbenchPolling.ts` 61 行）✅已完成**：入口 3926 → 3724（-202），`WorkbenchApp` 2471 → 2267（-204）；草稿域 7 项 state + 3 个 ref + 10 个动作全部换 owner（4 条路由），5 秒/15 秒混合域轮询整片搬进装配器 ⇒ **入口 `setInterval` 归零**，`tickDue` 改 `useCallback(…, [desktopNotify])`；出口自检 151 项、反向变异 12/12；`test/*.mjs` 与六个探针**零改动**（唯一重锚是 p5b §5 五条轮询断言按 owner 移交 p5c）。**P6 未开工** |
| P6 AI/录入/目录 ✅ | 会话选项、提示词、流程、引用、QuickIntake、DirectoryPicker | persona/model/quick/workspace判据与探针 | 十mode路径、三目录入口及附件清理保持 —— **✅ 全部完成（P6-1 导航+忙碌标志 / P6-2 快速录入域 / P6-3 AI 会话域 / P6-4 目录选择域）**：入口 3724 → 2814（P6-1 **+9**、P6-2 -220、P6-3 -683、P6-4 -16），`WorkbenchApp` 2267 → 1389（+7 / -184 / -684 / -17）；新 hook `hooks/useWorkbenchNavigation.ts`（43 行）+ `hooks/useWorkbenchBusy.ts`（39 行）+ `hooks/useWorkbenchQuickIntake.ts`（364 行）+ 纯模块 `src/client/intakeHelpers.ts`（66 行）+ `hooks/useWorkbenchAISessions.ts`（914 行）+ `hooks/useWorkbenchDirectoryPicker.ts`（81 行）；**`WorkbenchApp` 体内直接 `useState(` 27 → 0**、`api(` 27 → 6（P7 欠账）、`useEffect(` 4 → 3，距 ≤900 护栏还差 **489**；出口自检 153 / 198 / 94 项（P6-1 无独立脚本），反向变异 13/13 × 3；quick-workspace 探针 13/15 → **16/16** 并销账；`pnpm test` 993/992/1（**0 回归**），唯一失败＝既有 db EPERM |
| P7 入口组合与总回归 ✅ | 最后 6 处请求归域 + 四段 JSX 进 `app/` + 装配束 `app/assembly.ts` + 死 import / 死解构清理（**`WorkbenchApp` 未移入 `app/WorkbenchApp.tsx`**） | 入口扫描递归 / 函数测量 / 全套回归证据（15 个出口自检 + 15 个反向变异 + 六个探针 + preflight） | 主组件**结构硬门**（0 直接 state / 0 业务请求 / 0 定时器、单个顶层块 ≤80 行）+ **行数 ≤900 护栏**（[ADR-0008](../adr/0008-workbenchapp-exit-criteria.md)）—— **✅ 已跑绿**：入口 **2814 → 1972** / `WorkbenchApp` **1389 → 631**（入口第 92–722 行）；体内直接 `useState(` / `api(` / `fetch(` / `setInterval(` / `setTimeout(` **全 0**、`useEffect(` **3** 条、顶层块 **41** 个且 >80 行的 **0** 个；护栏按 ADR **校准为 ≤650**（实测 631 达标）；≤600 努力目标**未达成（差 31 行）**；入口 12 个死 import 已清零；`useDayWorkspace.ts#clearTodayPlan` 死代码**保留**（不是 D17 引入） |

大批次按具体职责继续拆成小提交；新增路径验证通过后删除旧职责应落在**同一个完成的迁移提交**中。工作中可短暂加新路径验证，提交时只留一个owner。不得为降低行数删注释或把代码压成一行。

提交说明模板：`D17/<域>: 入口 <before>→<after>（历史5697）；WorkbenchApp <before>→<after>；迁移owner...；判据/变异...；验证...`。迁移与行为修复不混；未通过或未实测的项写明，不自动commit/push。

## 8. 扫描测试与变异迁移映射

以下文件名是当前检索入口，实施前重新确认其锚点；定位用职责/函数名，不用旧行号切片。

| 职责 | 当前防线 | 搬迁要求 |
|---|---|---|
| 日期/容量/计划 | `test/capacityWiring.test.mjs`, `dayPanelWiring.test.mjs`, `dayPanelTabs.test.mjs`, `capacityPanel.test.mjs` | 候选/提示词/完整tasks输入/两个实例接线按实际owner查；复用共享成员政策；保留三段数据→模型→展示约束 |
| 进度与详情 | `test/progressWiring.test.mjs` | pending单次查询、只读详情刷新、100触发行为与提示词按实际调用链验 |
| 快速录入默认值 | `test/quickIntakeDefaultWiring.test.mjs`, `quickWorkspaceDefault.test.mjs`, `quickIntakeClient.test.mjs` | 真实函数抽取跟随QuickIntake；找不到函数必须红；设置写入允许列表更新到唯一owner |
| 三工作区入口 | `test/workspacePickerWiring.test.mjs` | 三真实使用入口、两种LocalDocModal、受控字段和sink写回；import/注释不计实例 |
| 模型/角色/技能 | `test/personaWiring.test.mjs`, `modelPickerDegrade.test.mjs`, `quickIntakeClient.test.mjs` | 两弹窗的选择器和十mode接线；绑定→提示词顺序改测真实调用链 |
| 知识/点子列表 | `test/listViewWiring.test.mjs`, `knowledgeRecallRoutes.test.mjs` | 过滤/分页/加载/TabBar/设置召回日志读真实owner，不再绑定入口 |
| 草稿/会话跳转 | `test/draftBannerSessionJump.test.mjs` | onSettled清投影、唤回、会话跳转与重复处理保持 |
| 宿主/DOM/引用 | `test/panelStateSource.test.mjs`, `panelCss.test.mjs`, `clientInvariants.test.mjs`, `devVerify.test.mjs` | 递归扫描client；函数例外范围精确；buildId和引用释放仍覆盖 |
| 容量接线变异 | `scripts/repro/probe-capacity-mutations.mjs` | 入口I系列按新DayWorkspace锚定；共享算法变异保持；不减少覆盖 |
| 工作区/模型变异 | `scripts/repro/probe-quick-workspace-mutations.mjs`, `probe-model-picker-notify-mutations.mjs` | 新QuickIntake/AI选项/弹窗owner同步重锚；src与lib变异分清 |
| 其它变异 | `scripts/repro/probe-*-mutations.mjs` | 每个批次查依赖搬迁职责的全部探针，不局限上述三份 |

通用规则：

1. 正向接线测试读真实owner；跨模块顺序测调用链，不盲拼多文件凑同函数文本顺序。
2. 负向唯一性递归覆盖相关客户端源码，剥注释、归一CRLF，区分类型/导入和真实调用；不能只在旧入口查“没有第二份”。
3. 函数抽取缺锚/空切片必须失败，不能让“不含坏写法”的负向断言空洞通过。
4. JSX数量按真实入口计算，拆子组件后验证父入口与子组件调用链；不得下调原业务覆盖或靠注释补次数。
5. 同缺陷反向验证：未变异基线绿→恢复相同缺陷必红→还原再绿；迁移后记录旧变异ID、新锚点和结果。
6. 探针每次运行前按既有链构建，探针之间重建，避免仅恢复src而lib仍有变异；核对源码/产物恢复、无残留备份。
7. 需要Node直接导入的新纯模块/组件按实际测试用途加入 `tsconfig.build.json`；不要假定客户端bundle会产生独立组件文件。

## 9. 浏览器验收补充清单

保留 [现役10套白名单](../../scripts/verify/suites.json)全部有效判据。新增场景可加进对应现役套件或单独登记；数量不作为覆盖代替物。以下是实施时的补充需求，当前均**未验证**：

| 编号 | 场景 | 观察与对账 |
|---|---|---|
| B01 | 五视图往返与面板开关 | 过滤、编辑、选择、展开、dayTab保持原生命周期；无重复请求/定时器/主线程卡死 |
| B02 | 知识新增、编辑、删除、筛选、关联任务、文档入口 | 操作后API与列表/右侧重读一致；文件模式选择不受目录模式影响 |
| B03 | 点子新增、编辑、删除、选中/未归类、创建/改名/合并/删除文件夹、归入/移出 | 服务端事实与卡片/详情一致；批选与视图往返保持 |
| B04 | 任务详情主要动作 | 编辑、完成、归档/恢复、加子任务、改父任务、会话关联/打开、记忆/复盘/关联知识按现有功能逐项覆盖 |
| B05 | 今日/日历日期面板与计划/报告 | 同日同页签逐行一致；五页签、过去兜底、未来入口隐藏、minutes/effortDone/容量/报告anchor保持 |
| B06 | 工作区三个入口 | 快速录入/新建/编辑均真实选目录→字段写回→提交→API重读；编辑不能只验选择器在位 |
| B07 | 设置、字典、提醒、待处理 | 保存再重读；权限/通道降级；收起不降待处理计数；暂存/唤回/递补/同名复用与通知去重 |
| B08 | 十AI mode和两弹窗选项 | 入口→选项→取消/提交→复用或新建→相应注册/提示词；真实模型层单独分层记录 |
| B09 | 附件/弹窗层级与引用 | 上限/移除/取消/卸载清理、图片/文档通道、portal点击命中、retain/release无遗漏 |
| B10 | 宿主面板与样式 | 侧栏开关、官方入口、data-open/buildId、窄面板页签换行/间距、控制台无新增异常 |

交互证据应包含点击效果、DOM重读、必要API对账与截图；CDP fallback沿用现有clickAt可观测机制，不能只以“点击函数返回非空”判成功。报告、AI真实模型、通知等无法获得的能力须分层记录未覆盖/跳过，不以源码扫描替代实际行为。

### 9.1 角色真实模型证据

当前persona套件顶层日志关键词扫描不能排除旧日志命中。新版要求证据绑定**本次runId、目标实例、会话ID、所选角色身份/来源**，并证明实际调用 `workbench_load_persona`；仅旧文本含工具名不算通过。采用精确会话结果或精确日志来源，不递归全盘搜日志凑证据。

当前dev-verify的 `ALLOWED_REQUIRED_SKIPS` 明确登记persona的 `真实模型调用 workbench_load_persona 并返回所选角色正文（模型链路）`；实施时重新核对实际名单，名单外required跳过仍失败。即使链允许该条skip，验收报告仍写该层未验证，不声称“真实模型链路通过”。补证或修复证据采集应独立测试基建提交，不混入业务重构。

## 10. 验证命令、基线欠账与验收口径

### 10.1 Windows原生验证

后续实施使用本仓库package scripts，命令示例：

```powershell
pnpm typecheck
pnpm build
pnpm test
node scripts/check-verify-scripts.mjs
node scripts/release-preflight.mjs --phase pre
```

`pnpm test`自身先build。每个代码提交至少typecheck、build和受影响定向测试；迁移涉及源码扫描/产物/探针时同步验证；每个批次结束全量单测及受影响隔离浏览器场景；最终全部现役浏览器套件和补充清单。完整preflight在实施基线和最终收尾执行；探针互相影响时按脚本原构建规则，不盲目省build。

验收链示例（**不能复制占位参数执行**）：

```powershell
node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web --profile-dir "<独立测试profile绝对目录>" --db-path "<实际配置中的独立测试DB绝对路径>" --dry-run
node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web --profile-dir "<独立测试profile绝对目录>" --db-path "<实际配置中的独立测试DB绝对路径>"
```

真实链包含装盘与重启，需要实施会话已有授权和隔离条件；设计文档授权不包含这些动作。目标端口/profile物理目录/实际DB必须独立；预检拒绝则先解决配置，`--force`不绕数据库隔离。配置变更先备份并核对版本一致，不默认同步live profile，不重启19387。包/health/client三方buildId需一致，token不写证据。preflight **不包含**浏览器链，二者分别留证。

### 10.2 单测基线

- 历史tests=957是下限参考；最终实际通过数不低于开工实测通过数，不删/跳过原用例来达标。
- 当前已知失败名单按完整用例名 `db migrations, dictionaries and task tree` 放行，**没有**校验EPERM堆栈；不能把同名任意失败都归为环境欠账。
- 仅经失败栈核对确为同一Windows清理期EPERM才按历史问题记录；业务断言/迁移错误一律新增回归。与基线比较失败名称、错误阶段和栈。
- 登记用例若本次变绿，现有门禁要求销账否则仍红；不得故意制造失败来满足名单。

### 10.3 探针冲突的处理定案

当前 `KNOWN_PROBE_DEBT`仍写model B7/B8/B10、quick-workspace M6/M14失效；capacity已在源码注释中注明销账。`judgeProbes`却对stale/unreliable无条件硬红，登记也不豁免。任务旧“欠账不阻塞”不能等价为“现有pre必过”。

本方案采用以下范围：

1. **D17迁移影响的探针重锚是本次必做**，不能留作非阻塞欠账。探针必须实际执行相同缺陷，不能删除变异以求绿。
2. 只把开工实测确认、与D17无关且仍可正常运行的历史真盲点作为非阻塞登记欠账；不得新增D17引入的存活变异。
3. 上述model/quick失效锚点属于将迁移的职责，安排独立测试基建提交重锚；全捕获后同步删除已销账名单，不改成“stale可豁免”。
4. 开工若发现其它无关历史阻塞，明确issue、证据和边界；不能把pre退出1记为pass。严格最终验收仍要求pre退出0；未解决时交付报告标明“D17代码判据完成、整体门禁未完成”，不提交完全验收。
5. 当前探针门禁对无法解析的登记输出以及债项漏跑存在审计疑点；列为独立基建问题。D17人工核对每个应跑probe都有结果、所有汇总可解析，不借漏洞通过。

这明确区分历史产品欠账与失效防线，保留任务pre通过目标，不要求D17顺带修完所有无关产品问题。

## 11. 验收包与交接

后续实施证据放在任务资料夹 `docs/tasks/8e5ea61d-0021-4317-8398-419b8501e6a9-D17客户端拆分/`，不散放工作区根目录。设计权威入口仍是本文。

验收包至少包含：

- `baseline.md`：施工起点标识、环境/版本、两项行数、状态计数、tests/pass/fail/skip及真实失败栈、探针起点。
- `ownership.md`：§4全量state与ref/effect/handler写读迁移台账；未迁移项必须显式列出。
- `migration-matrix.md`：每项职责的新owner、扫描范围、变异ID/新锚点、浏览器场景和提交。
- `verification.md`：各提交/批次与最终命令退出码、用例计数、浏览器runId/buildId、欠账/skip/未验证层。
- `handover.md`：最终模块职责、调用方向、入口与主组件before→after、出口逐项对照、剩余问题。

本轮只完成本文重写，不建立空证据包、不填造实测结果、不修改任务完成状态。后续实施前可以直接按P0开展基线与逐项台账，不能跳过拥有者和刷新关系核对。
