# 时间与容量规则透明化 —— 可执行实施方案（v2，经独立审查收口）

任务：`7d9bb4ec-6400-44df-b14d-6e445f0203b8`（feature_opt / p2）
基线：`main` @ `03fcdb5`，`pnpm typecheck` 0，`pnpm test` 448/448，工作区干净，version 1.15.1。

> **v2 修订说明**：v1 经一轮空上下文独立审查（另一 agent、只读、每条发现要复现命令）+ 我自己逐条复跑。
> 独立报告的 6 条里 **2 条被我实测推翻**（详见第九节"审查收口"），其余 4 条已并入下文；
> 我自己的复核又抓出 **2 个真缺陷**（基线探针时区串味、探针与真算法口径不一致）。
> 本版把全部修订落进正文，执行时直接照做。

---

## 一、现状勘察结论（代码事实 + 实测数字）

| 项 | 现状 | 位置 |
|---|---|---|
| 「已排」算法 | **内联在 4987 行的组件里**，无纯函数、无测试 | `src/client/index.tsx:1989-2014` |
| 计入范围 | `openTasks`（非 done/cancelled）中：`effectiveDueAt===null ? status ∈ {doing,blocked} : isTaskDueOnDay(t, now)` | 同上 |
| 耗时取值 | `t.estimatedMinutes ?? 30`（4 处重复：合计 + p0/p1/p2/p3） | 同上 |
| 逾期 | **完全不参与**（既不进「已排」，界面上也无任何提示） | 同上 |
| 全天任务 | 与普通任务**同算法**（`allDay` 在容量计算里一次都没被读）；且**没有任何写入入口** | 同上、编辑弹窗 |
| 任务设置页面 | **没有耗时输入框**，也没有全天开关 | `index.tsx:3753-3790`、`607`、`3299` |
| 服务端 | PATCH 支持 `estimatedMinutes`，但**无夹取**（`type === 'number'` 就原样落库） | `src/api/routes/tasks.ts:95` |
| 设置项对照 | `dailyCapacityMinutes` **有**夹取（`Math.min(1440, Math.max(30, Math.round(…)))`） | `src/api/routes.ts:175-177` |
| `now` | 在**渲染体内每帧新建**（不能直接进 `useMemo` 依赖数组） | `src/client/index.tsx:1880` |
| 死字段 | `capacity.count` / `planCovered` **只写不读**（全仓各 1 次出现 = 赋值行本身） | `:2012-2013` |
| 测试锁 | `test/` 里**没有**任何 `wb-cap-bar` / 旧 aria-label 的断言（可放心改） | — |

### 实测（`scripts/repro/measure-capacity-baseline.mjs`，只读，2026-09-17 20:0x）

```
库：C:\Users\dupenglai\.dsh\workbench\workbench.db   schema 18
今天：2026-09-17
已排合计：0 min（0 条）
逾期未完成但**不计入**已排：10 条 / 750 min
  - [09-13] 方案设计：AI 调试桥 API 与安全模型 (30)
  - [09-13] POC：在 DEMO 模式跑通截图+DOM+点击/输入 (30)
  - [09-13] 代码实现：完整调试桥服务（本地 HTTP API） (30)
  - [09-13] 代码实现：AI 调试菜单/插件与安全开关 (30)
  - [09-13] 代码实现：DSH/AI 侧 MCP/CLI 集成 (30)
  - [09-13] 验证：真实 UI Bug 闭环 (30)
  - [09-13] 文档与知识沉淀 (30)
  - [09-15] 公司所有硬件产品版本归档管理 (30)
  - [09-14] AntennaField 核心算法代码抽离并加密公共算法库 API (480)
  - [09-14] AntennaField平台标准化发布脚本适配新架构 (30)
```

另一份**独立实现**的复核脚本（`verify-capacity-review-claims.mjs`）给出同样结论，用于交叉校验：
`活跃 26 条 | 没填耗时 20 条 | 没填且 p2 3 条 | 今天计入 0 条 | 逾期 10 条 / 750 min | all_day=1 共 3 条（均已归档/完成，未归档未完成 0 条） | 父子同时未完成 2 对`。

**核心动机（修正后的表述）**：今天显示「已排 0 min」，而同一批数据里躺着 **10 条 / 750 min 的逾期**与 **20 条没填耗时**（合计按 30 兜底 = 600 min，只是今天恰好没有一条落到"今天到期"）。用户看不到这两件事，也就无法判断「0」是"今天真没事"还是"系统把事算丢了"。**把规则与账本摆出来，是这个任务的价值所在，而不是改一个数字。**

### ⚠️ 一个必须知道的既有语义：CANCELLED 祖先的"幽灵逾期"

上面 10 条逾期里，**6 条**来自**已取消父任务**的 due 继承（源均为「实现 AntennaField 应用内 AI 调试桥…」这个已取消的父任务，其下 6 个子任务拿不到自己的 due 就继承了它 09-13 的过期 due）：
`effectiveDueAtForTask` 只沿父链找 `due_at`，**不看祖先状态**，所以父任务被取消后，其未完成子任务仍继承它的过期 due。
其余 4 条（含 480 min 那条）是**自身** due 已过期。
这不是本次引入的：服务端 bootstrap 的「逾期」统计（`src/api/routes.ts:204-205`）是 **12 条 / 全表**（含归档行），而活跃集是 10 条——**两个口径都对，只是范围不同**，因为 bootstrap 不排除归档行。
→ **本次口径与它保持一致（不修语义）**，但在界面账本里必须把这类条目标注出来（`逾期·继承自已取消父任务`），否则用户会以为系统在凭空造事。
→ "取消父任务时是否级联处理子任务的 due 继承"应另开一条需求，不塞进本任务。

---

## 二、需要你确认的决策（审查后新增 1 条）

**决策 1｜逾期的未完成任务算不算「今日容量」？**

| 口径 | 今天显示 | 代价 |
|---|---|---|
| A 不算 + 界面写清（含"若计入 = 750 min"） | 已排 0 / 余 300，旁标「10 条逾期 750 min 未计入」 | 数字仍反直觉，但规则可见 |
| B 默认算进去 | 已排 750 / 超支 450 | 把历史欠账混进"今天要做的事" |
| **C 给开关、默认不算（推荐）** | 默认同 A；勾上立即变 B；选择记在服务端 | 多一个 meta 键 + 一个开关，成本极小 |

方案按 **C** 写；选 A 就删掉开关段，选 B 就把缺省值翻成开。

**决策 2（新增，审查发现）｜`estimatedMinutes` 允许的下界是多少？**
服务端 PATCH 现在**不夹取**，而容量算法把 `≤0` 视为"没填"。我按 **1–1440** 落：`≥1` 都接受（不再有第二个"5 分钟"阈值，避免"存进去了但不算"的错位）；`0`/负数/非有限/非整数 → 存 `null`（= 没填，走默认）；`>1440` → 夹到 1440。
若你希望 5 分钟也有意义，说一声，改动只有一行。

---

## 三、算法规格（改完之后，界面要一字不差地这么写）

### 3.1 谁能进「今日容量」

`open` 集合 = `!archived && status ∉ {done, cancelled}`（与今天视图同一个源，不另算一遍）。

对 `open` 里每条任务的**有效截止时间** `effectiveDueAt`（自身 `due_at` 优先，否则沿父链向上取最近祖先的 `due_at`）：

1. `effectiveDueAt !== null && 落在今天本地日` → **计入**（"今天到期"）
2. **自身与继承都为 null** 且 `status ∈ {doing, blocked}` → **计入**（"无截止但在推进"）
3. `effectiveDueAt !== null && < 今天本地 00:00` → **逾期**：默认不计入；开关打开才计入（**与第 1 条互斥，不重复计**）
4. 其余 → **不计入**

> ⚠️ **第 2 条的"无截止"指"自身与继承都没有"**。一条 `doing` 的子任务若父任务已过期，它拿到的是**继承来的过期 due**，走第 3 条 → 默认被排除。
> 这一条必须在界面文案里写明（"截止时间会沿任务树向上继承"），否则"无截止但推进中会算进去"这句话对这类任务是错的。

### 3.2 每条任务的耗时取值（客户端做展示、服务端做落库，两侧同一规则）

- `estimatedMinutes` 是**有限、整数、≥1** 的分钟数 → 用它（上限 1440，超出按 1440）；
- `null` / `0` / 负数 / 非有限 / 小数 → 视为**没填** → 用**默认耗时**（meta `default_estimated_minutes`，缺省 30，夹 5–1440）；
- **写入口必须夹取**（P3 一并加在服务端 PATCH 上）：`>1440 → 1440`、`0/负/非有限/小数 → null`。
  依据：设置项 `dailyCapacityMinutes` 早就有同构夹取（`routes.ts:175-177`），本字段漏了 → 会出现"库里 99999、界面按默认 30 算"的双口径。

### 3.3 全天任务（all_day）

- **容量口径：与普通任务一致**（3 小时的全天任务 = 180 min，不吃"整天 480"）。理由：容量问的是"投入多少时间"，全天只说明"什么时候"。
- **截止时间不特殊化**：`due_at` 该怎么存还怎么存，全天只是展示语义（周/月日历与重复实例锚点）。
- 界面必须写明：**「全天任务只影响显示与重复锚点，不改变容量计算」**。这就是本任务第 2 点的答案。

### 3.4 汇总与读数

- `planned = 计入任务耗时之和`；`free = max(0, 可投入 − planned)`；`over = planned > 可投入`
- 条形分母 `total = max(可投入, planned, 1)`（沿用现状；第三参数在正常路径不可达，但**不得为零除的兜底**）
- 分优先级 `p0/p1/p2/p3`（未知优先级归 p3，沿用现状）
- **账本两半**（界面显示的每个数字都要在这里找到出处）：
  - `included[]`：`{id, title, minutes, band, estimated, usedFallback, allDay, overdueIncluded, inheritedDue}`
  - `overdueExcluded[]`：同上 + `ghostFromCancelledAncestor`（第 1 节那个语义要标出来）
  - 表尾 `合计 = planned`；逾期区显示 `N 条 / M min`
- **计数字段要够用**：新 `aria-label` 需要"今天到期 N 条 / 无截止推进 M 条 / 逾期未计入 K 条"，`CapacityResult` 里必须**显式给这几个计数**（不能指望从死字段 `count`/`planCovered` 拿——它们没有消费点，见第十一节）。

---

## 四、手算基准数据集（验收第 3 条的"固定数据可手工复算"）

`now = 2026-09-16T15:00`**本地时间**（测试里用 `new Date(2026, 8, 16, 15, 0, 0)` 构造，**不用带 `+08:00` 的 ISO 串**，理由见下），可投入 `300`，默认耗时 `30`，`includeOverdue=false`：

| id | status | priority | due | minutes | allDay | 判定 | 计入 |
|---|---|---|---|---|---|---|---|
| T1 今天到期 | todo | p0 | 09-16 18:00 本地 | 60 | 否 | 今天到期 | 60 |
| T2 没填耗时 | todo | p1 | 09-16 18:00 本地 | null | 否 | 今天到期，30 兜底 | 30 |
| T3 无截止在推进 | doing | p2 | null | 120 | 否 | 自身与继承都为 null + doing | 120 |
| T4 无截止没在推进 | todo | p2 | null | null | 否 | 不满足 | 0 |
| T5 逾期 | todo | p1 | 09-14 18:00 本地 | 480 | 否 | 逾期（默认排除） | 0 |
| T6 逾期 | todo | p0 | 09-15 18:00 本地 | 480 | 否 | 逾期（默认排除） | 0 |
| T7 全天今天到期 | todo | p2 | 09-16 00:00 本地 | 180 | **是** | 今天到期，与普通同算法 | 180 |
| T8 已完成 | done | p0 | 09-16 18:00 本地 | 999 | 否 | 不在 open | 0 |
| T9 已取消 | cancelled | p0 | 09-16 18:00 本地 | 999 | 否 | 不在 open | 0 |
| T10 已归档 | todo | p0 | 09-16 18:00 本地 | 999 | 否 | archived | 0 |
| T11 继承父任务截止 | todo | p3 | null（父 T1） | null | 否 | effectiveDueAt=09-16 → 今天，30 兜底 | 30 |

**手算期望值（已逐行复算两遍）**

- 默认：计入 T1/T2/T3/T7/T11 共 **5 条**；**`planned = 420`**；`byPriority = {p0:60, p1:30, p2:300, p3:30}`；`free = 0`；`over = true`；`total = 420`；`fallbackCount = 2`（T2、T11）；`dueTodayCount = 4`。
- 开关打开：`planned = 420 + 480 + 480 = 1380`；`byPriority = {p0:540, p1:510, p2:300, p3:30}`。
- 默认耗时改 60：`planned = 60+60+120+180+60 = 480`（**不是 540**）。

**时区可移植性（审查提出、我实测后的正确结论）**
时区**不影响**这组断言：`new Date('2026-09-16T18:00:00+08:00').toDateString()` 在 `TZ=America/Anchorage`（UTC-9）下仍是 `Wed Sep 16`（本地日只由本地时刻决定，同一真实瞬间在 UTC-9 是 09-16 02:00）。
但为了让测试**不依赖机器时区**，基准数据一律用 `new Date(2026, 8, 16, 18, 0)` 这类**本地组件构造**；并额外加一条"跨时区可移植"断言（用 `TZ` 环境变量各跑一次不现实，改为直接断言两个本地构造的 `toDateString()` 关系）。

### 4.1 夹具（`test/fixtures/capacityFixture.mjs`，测试与 harness 共用同一份，禁止各写一份）

```js
// 一律本地组件构造：月份 0-based。不写 ISO 串（避免时区把日期挪走）。
const at = (day, hour) => new Date(2026, 8, day, hour, 0, 0)          // 2026-09
const NOW = at(16, 15)                                                // 冻结的"现在"
const iso = (d) => d.toISOString()                                    // 存进夹具仍用 ISO（Task 行就是这个形状）
const T = (id, extra) => ({ id, parentId: null, title: id, statusCode: 'todo', priorityCode: 'p2',
  dueAt: null, effectiveDueAt: null, allDay: false, estimatedMinutes: null, archived: false, ...extra })

export const CAPACITY_FIXTURE = {
  now: NOW,
  dailyCapacityMinutes: 300,
  defaultEstimateMinutes: 30,
  // effectiveDueAt 在夹具里**显式给值**（模拟仓储层已算好继承），不在这里复刻继承逻辑
  // ⚠️ 夹具是**全量任务列表**（含 archived / done / cancelled）—— computeTodayCapacity 内部自己过滤，
  //    调用点不要先滤一遍（"同一语义两个地方算"就是本项目最大的 bug 类别）。T10 专门守归档过滤。
  tasks: [
    T('T1',  { statusCode: 'todo', priorityCode: 'p0', dueAt: iso(at(16, 18)), effectiveDueAt: iso(at(16, 18)), estimatedMinutes: 60 }),
    T('T2',  { statusCode: 'todo', priorityCode: 'p1', dueAt: iso(at(16, 18)), effectiveDueAt: iso(at(16, 18)) }),
    T('T3',  { statusCode: 'doing', priorityCode: 'p2', estimatedMinutes: 120 }),
    T('T4',  { statusCode: 'todo',  priorityCode: 'p2' }),
    T('T5',  { statusCode: 'todo',  priorityCode: 'p1', dueAt: iso(at(14, 18)), effectiveDueAt: iso(at(14, 18)), estimatedMinutes: 480 }),
    T('T6',  { statusCode: 'todo',  priorityCode: 'p0', dueAt: iso(at(15, 18)), effectiveDueAt: iso(at(15, 18)), estimatedMinutes: 480 }),
    T('T7',  { statusCode: 'todo',  priorityCode: 'p2', dueAt: iso(at(16, 0)), effectiveDueAt: iso(at(16, 0)), estimatedMinutes: 180, allDay: true }),
    T('T8',  { statusCode: 'done',      priorityCode: 'p0', dueAt: iso(at(16, 18)), effectiveDueAt: iso(at(16, 18)), estimatedMinutes: 999 }),
    T('T9',  { statusCode: 'cancelled', priorityCode: 'p0', dueAt: iso(at(16, 18)), effectiveDueAt: iso(at(16, 18)), estimatedMinutes: 999 }),
    T('T10', { statusCode: 'todo', priorityCode: 'p0', dueAt: iso(at(16, 18)), effectiveDueAt: iso(at(16, 18)), estimatedMinutes: 999, archived: true }),
    T('T11', { statusCode: 'todo', priorityCode: 'p3', parentId: 'T1', dueAt: null, effectiveDueAt: iso(at(16, 18)) }),
  ],
}
```

### 4.2 期望输出（**逐字段**，测试与 harness 断言同一份）

```
includeOverdue=false（默认）                      includeOverdue=true
planned            420                            1380
byPriority         {p0:60, p1:30, p2:300, p3:30}  {p0:540, p1:510, p2:300, p3:30}
free               0                              0
over               true                           true
total              420                            1380
counted            5                              7
dueTodayCount      4  (T1,T2,T7,T11)              4      ← T11 靠继承父任务 T1 的截止也算今天到期
noDueDoingCount    1  (T3)                        1
fallbackCount      2  (T2,T11)                    2
included（id 集）  {T1,T2,T3,T7,T11}              + {T5,T6}
overdueExcluded    2 条 / 960 min（T5,T6）        0 条 / 0 min
overdueMinutes     960                            0
```

> **这两个数字我手算错过、被独立实现抓出来了**（v2 里写的 `dueTodayCount=3`、`p1=30` 是错的，本文档该处已全部改正）：
> `dueTodayCount` 是 **4**（T11 继承父任务 T1 的截止 → 也算"今天到期"）；`includeOverdue` 下的 `p1` 是 **510**（T2 30 + T5 480）。
> 抓出它的正是刻意用**另一种写法**写的 `scripts/repro/verify-capacity-fixed-dataset.mjs` —— 手算 + 照抄期望值的实现会一起绿，所以基准必须两套算。
> **执行会话的第一件事**就是跑那个脚本（见 §13）。

> 两个数字必须**同时**被记住，别混：
> `fallbackCount = 2`（计入集里没填耗时的条数 = T2、T11），而**全库口径**的"没填耗时"是 20 条（真库实测）——后者不进任何断言，只进文档。
> 逾期的 `overdueMinutes = 960`（T5 480 + T6 480），而**真库口径**是 750 min（10 条）——同理，不进测试。

### 4.3 记账自洽断言（防"账本好看但对不上"）

```
sum(included[].minutes)        === planned
sum(overdueExcluded[].minutes) === overdueMinutes
counted                        === included.length
dueTodayCount + noDueDoingCount + (overdueIncluded ? overdueCount : 0) === counted
byPriority 四档之和            === planned
```


---

## 五、实施阶段（每阶段独立提交、独立验收）

### P1 —— 抽纯函数 + 基准测试 + 变异探针（界面不动）

**新增** `src/client/capacity.ts`（不 import React、不碰 DOM，`now` 与全部阈值显式入参，与 `taskFilterSort.ts` 同风格）：

```ts
export const DEFAULT_ESTIMATE_MINUTES = 30
export const MIN_ESTIMATE_MINUTES = 5
export const MAX_ESTIMATE_MINUTES = 1440
export type CapacityBand = 'p0' | 'p1' | 'p2' | 'p3'
export interface CapacityTask { id: string; parentId: string | null; title: string; statusCode: string
  priorityCode: string; effectiveDueAt: string | null; dueAt: string | null; allDay: boolean
  estimatedMinutes: number | null; archived?: boolean }
export interface CapacityBreakdown { id: string; title: string; minutes: number; band: CapacityBand
  estimated: number | null; usedFallback: boolean; allDay: boolean; overdueIncluded: boolean
  inheritedDue: boolean; ghostFromCancelledAncestor: boolean; statusCode: string }
export interface CapacityResult {
  planned: number; free: number; over: boolean; total: number
  byPriority: Record<CapacityBand, number>
  counted: number                    // 计入条数（= included.length）
  dueTodayCount: number              // 今天到期条数（aria-label 用）
  noDueDoingCount: number            // 无截止在推进条数
  fallbackCount: number              // 计入且用了默认耗时的条数
  included: CapacityBreakdown[]
  overdueExcluded: CapacityBreakdown[]
  overdueMinutes: number
}
export function normalizeEstimateMinutes(value: number | null | undefined, fallback: number): number
export function computeTodayCapacity(input: { tasks: readonly CapacityTask[]; dailyCapacityMinutes: number
  defaultEstimateMinutes: number; includeOverdue: boolean; now: Date; cancelledAncestorIds?: ReadonlySet<string> }): CapacityResult
```

**前置动作（不做就第一天跑不起来）**：把 `src/client/capacity.ts` 与 P2 的 `CapacityRulePanel.tsx` 加进 **`tsconfig.build.json` 的 include 白名单**。
依据：`pnpm test` = `pnpm build && node --test test/*.test.mjs`，而 `build` 会 `rmSync('lib')` 后只编译白名单 → 不在白名单里的模块 `test/` 根本 import 不到（`ERR_MODULE_NOT_FOUND`）。

**改** `index.tsx`：
- 用 `useMemo(() => computeTodayCapacity({...}), deps)` 替换 1989-2014 的内联块；
- **`now` 不进依赖数组**（`:1880` 是渲染体内每帧新建的对象，放进去等于 memo 每帧失效）：显式依赖 `[tasks, settings.dailyCapacityMinutes, settings.defaultEstimateMinutes, settings.dailyCapacityIncludeOverdue, capacityTodayKey]`，其中 `capacityTodayKey = localDateString(now)`（字符串，跨天才变）。
- 旧的 `capacity.count` / `planCovered` **一并删除**（已验：全仓无读取点），但要在提交信息里写明"确认过无消费点"，不静默消失。

**新增** `test/capacity.test.mjs`（**import `test/fixtures/capacityFixture.mjs`，不要另写夹具**）：
1. 第四节整张表逐字段断言（含 `dueTodayCount/noDueDoingCount/counted/fallbackCount` 与 `included` 的 id 列表、`overdueExcluded` 的 id 列表）；
2. **等价性（防重构走形）**：把旧内联公式复刻成测试内 `legacyPlanned()`，随机 200 组快照对拍 `planned/byPriority/free/over`，断言与 `computeTodayCapacity({includeOverdue:false, defaultEstimateMinutes:30})` 一致 —— **唯一允许的差异是"`estimatedMinutes: 0` 走兜底"**，为此单列一条测试标注这是刻意修正；
3. 边界：`planned > 可投入`、`planned = 0`、`可投入 = 0`、跨日（今天 00:00:00 与 23:59:59 算今天，昨天 23:59:59 不算）、非法 due 串、`estimatedMinutes` 为 `0 / -5 / 1e9 / 0.5 / NaN`、全天任务、继承 due（含**继承自已取消祖先**的 ghost 标记）；
4. `fallbackCount` 只数"没填且被计入"的。

**新增** `scripts/repro/probe-capacity-mutations.mjs`：≥ 8 条定向变异，**每条必须让测试变红**（沿用 `probe-listview-mutations.mjs:186-207` 的 CRLF 归一化 + 还原写法）：
`?? 30 → ?? 0`；去掉 done/cancelled 过滤；去掉 archived 过滤；逾期改默认计入；全天改按 480 计；`free` 去掉 `max(0,·)`；未知优先级归 p0 而非 p3；`fallbackCount` 漏算继承截止那条。

### P2 —— 界面：规则可见 + 可复算账（任务第 1 点）

**新增** `src/client/components/CapacityRulePanel.tsx`（**只吃 props，不自己算一遍**）：

- 头部两行：`已排 <b>420</b> min · 见规则 ⟳`（`⟳` = 展开按钮，带 `aria-expanded`；展开后 `aria-label` 带上"今天到期 N 条 / 无截止推进 M 条 / 逾期未计入 K 条"）；
- 展开区：**七条规则**（第三节逐条，含"截止会沿任务树继承""全天不改变容量""逾期默认不计入"）；
- **账本表**：逐条 `标题 / 优先级 / 分钟 / 来源标记`（`今天到期`｜`无截止·推进中`｜`逾期计入`｜`按默认 30`｜`全天`｜`继承父任务截止`｜`继承自已取消父任务`），**表尾合计 = 已排**；
- **逾期区**：`10 条 / 750 min 默认不计入` + 逐条标题 + 开关「把逾期任务计入今日容量」；
- 底部：`默认耗时 30 分钟（在设置里改）` 链接 + 「为什么是这些数字」一句指向规则。

**状态所有权**（本项目最大的 bug 类别）：`includeOverdue` 与 `defaultEstimateMinutes` **唯一权威源是 `settings`**；面板只接收 props。面板内不存第二个副本、不重新算 `planned`。

**样式**：`styles.ts` 追加 `.wb-cap-rule*` / `.wb-cap-audit*`（沿用现有 token；小屏可滚动）。

**新增** `test/capacityWiring.test.mjs`（源码级不变量，沿用 `listViewWiring` 的抽取写法）：
- `index.tsx` 里**不存在第二处** `estimatedMinutes ?? ` / 分优先级求和（只有唯一调用点）；
- 页面上的容量数字**只**来自 `capacity.*`（组件内不现算）；
- `CapacityRulePanel` 的 props 含账本两半与三个计数；
- `useMemo` 依赖数组**不含 `now`**（断言源码里依赖数组的字面内容）。

**改** `scripts/repro/harness-real-browser.mjs`（审查确认：现在是**线性脚本、无 `process.argv` 解析**，"复用"实为需要先做参数化重构）：
- 加 `--case <name>` 参数（默认跑全部，保持向后兼容）；
- 成功路径补**显式 `process.exit(0)`**（现在成功靠自然结束；CDP/Edge 子进程若挂住会出现假绿）；
- 加容量批：真组件 + 真样式渲染（夹具 = 第四节的 11 条固定任务，**不依赖真库**，可复算），断言**页面上就显示 420**、账本行数与固定集的计入条数一致（5 行）、切开关后变 1380、收起回到紧凑态；截图进 `_local-archive/capacity/`。
  > 注意别把真库的当日数字（今天的 10 条 / 750 min）写进 harness 断言——它是时变的，明天就会红。真库数字只出现在 P5 的 `before-after.md` 快照与设计文档里，并带时点。
- 把"组件接线存在"做成**证据前提**：撤掉 `CapacityRulePanel` → 非零退出（反向验证）。

### P3 —— 任务设置页可自定义耗时（任务第 3 点，用户原话那条）

**改** `src/client/index.tsx`：
- `editDraft` 类型加 `estimatedMinutes: string`、`allDay: boolean`（`:607`；初始化 `:3299` 用 `String(task.estimatedMinutes ?? '')` 与 `task.allDay`）；
- 编辑弹窗（`:3767-3790`）加：
  - `耗时（分钟）`：`number`、`min=1 max=1440 step=5`、placeholder `留空 = 默认 30 分钟`，下方提示「改完立即影响今日容量的『已排』」；
  - `全天任务`：复选框 + 提示「只影响显示与重复锚点，不改变容量计算」；
- **校验**（不靠服务端 400 猜）：空串 → `null`；非有限 / `<1` / `>1440` → 行内红字报错并**阻止保存**（不发请求）；小数 → 四舍五入；
- `saveEditDraft` 的 payload 加 `estimatedMinutes`、`allDay`；
- **乐观更新**：`patchTask` 成功后 `setTasks(prev => prev.map(t => t.id === id ? {...t, estimatedMinutes: next, allDay} : t))`，随后 `refresh()` 对账（同 id 字段合并、幂等；失败不更新并回显原因）；
- 详情页（`:3320` 旁）加：`预计耗时：90 分钟` 或 `预计耗时：默认 30 分钟（未单独设置）`，全天任务追加 `· 全天`；
- 新建任务表单（`:3736-3749`）同样补耗时输入（否则"新建时不能设"是同一字段的第二个洞）。

**改** `src/api/routes/tasks.ts:95`（审查发现 2）：加与服务端设置项同构的夹取：
`>1440 → 1440`；`0 / 负 / 非有限 / 非整数 → null`；`1..1440` 原样。补 routes 测试（`99999 → 1440`、`-5 → null`、`0.5 → null`、`"90"`（字符串）→ null）。

**新增测试**（并入 `test/capacityWiring.test.mjs` 或新开 `test/taskEstimateForm.test.mjs`）：
- 源码抽取 `saveEditDraft`（它是 4987 行组件里的**闭包**，不能直接 import，沿用本项目"抽取源码 + 注入桩"的做法，抽不到即显式失败），注入桩跑行为断言：`'' → null`、`'90' → 90`、`'0' → 报错且不调用 patchTask`、`'2000' → 报错`；
- 断言 payload **确实带** `estimatedMinutes` 与 `allDay`（形态扫描不算数，必须是桩收到的实参）；
- 断言 `editDraft` 初值来自 `task.estimatedMinutes`（不是常量）。

**新增** `scripts/repro/repro-task-estimate.mjs`（真机 CDP）：**必须自带库隔离与还原**（审查发现 3）——
脚本开头**新建一条临时任务**（标题带 `__capacity-repro__` 前缀），全部断言在同一条临时任务上做，结尾在 `finally` 里删除它（**即使断言失败也删**），并断言删除成功。
断言：① 打开编辑 → 填 90 → 保存 → **不刷新**读「已排」，差值 = +90；② `F5` 后仍是 90（"刷新后保持"）；③ 重开弹窗回显 90；④ 中途失败也要清理。
**不允许**直接改用户已有任务的耗时——那是往生产库写不可逆的脏数据（我 v1 方案里就是这么写的，已改）。

### P3b —— 测试用例清单（逐条勾着写，别只写"覆盖了"）

**`test/capacity.test.mjs`（纯函数，预计 22–26 条）**

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | 基准数据集默认口径 | `planned=420`、`byPriority={p0:60,p1:30,p2:300,p3:30}`、`free=0`、`over=true`、`total=420`、`counted=5`、`dueTodayCount=4`、`noDueDoingCount=1`、`fallbackCount=2`、`included` 的 id 集合 = {T1,T2,T3,T7,T11} |
| 2 | 同上但 `includeOverdue=true` | `planned=1380`、`byPriority={p0:540,p1:510,p2:300,p3:30}`、`overdueExcluded` 空、`included` 含 T5/T6 且 `overdueIncluded=true` |
| 3 | 默认耗时改 60 | `planned=480`、`fallbackCount=2` |
| 4 | 等价性对拍（200 组随机快照） | 与测试内的 `legacyPlanned()` 在 `planned/byPriority/free/over` 上逐值一致 |
| 5 | 刻意差异：`estimatedMinutes: 0` | 新实现走兜底（30）；用例注释**必须**写明这是刻意修正，防被改回 |
| 6 | 边界：`planned=0` | `total=max(可投入,0,1)=可投入`、`over=false`、`free=可投入` |
| 7 | 边界：可投入 = 0 | `free=0`、`total=max(0,planned,1)`、无 `NaN`/除零 |
| 8 | 跨日：今天 00:00:00 | 计入 |
| 9 | 跨日：今天 23:59:59 | 计入 |
| 10 | 跨日：昨天 23:59:59 | 不计入（落逾期分组） |
| 11 | 非法 `effectiveDueAt`（`'abc'`） | 不抛异常；按"无法判定"处理并**计入 excluded 账本**（不允许静默消失） |
| 12 | `estimatedMinutes` 为 `-5 / 0.5 / NaN / Infinity / 1e9` | 分别 → 兜底 / 兜底 / 兜底 / 兜底 / 1440 |
| 13 | 全天任务 `allDay=true` | 与同 minutes 的普通任务**结果完全相同** |
| 14 | 继承 due：子无 due、父今天到期 | 子计入，`inheritedDue=true` |
| 15 | 继承 due：子无 due、父已过期、子 doing | **不计入**（走逾期分支，`overdueExcluded`，标 `ghostFromCancelledAncestor=false`） |
| 16 | 同上但父 `cancelled` | `ghostFromCancelledAncestor=true` |
| 17 | 父与子都在 open 且都今天到期 | 都计入（**不去重**，账本给同链标记）——断言这是**当前刻意行为** |
| 18 | 未知优先级 `'px'` | 归 p3 |
| 19 | 未归档但父已归档的开放子任务 | 按自身 due 参与判定（与产品既有语义一致） |
| 20 | `included` 与 `overdueExcluded` 的分钟合计 | 分别等于 `planned` 与 `overdueMinutes`（账本自洽） |

**`test/capacityWiring.test.mjs`（源码级不变量，预计 8–10 条）**

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | 唯一实现 | `index.tsx` 全文搜不到 `estimatedMinutes ?? `，也搜不到 `capacityByPriority` 之类的第二处求和 |
| 2 | 调用点唯一 | `computeTodayCapacity(` 在 `index.tsx` 恰好出现 1 次 |
| 3 | 依赖数组 | `useMemo` 的依赖字面量**不含 `now`**，含 `localDateString(now)` |
| 4 | 死字段 | `planCovered` / `capacity.count` 在 `src/` 里 0 次出现 |
| 5 | 面板 props | `CapacityRulePanel` 的 props 含 `included`、`overdueExcluded` 与三个计数 |
| 6 | 面板不自己算 | 面板组件内搜不到 `reduce(` + `estimatedMinutes`（防第二份实现） |
| 7 | `saveEditDraft` payload | 抽取源码 + 注入桩，断言 patchTask 收到 `estimatedMinutes` 与 `allDay` |
| 8 | 输入校验 | `''→null`、`'90'→90`、`'0'`/`'2000'`/`'abc'` → 报错且**不调用** patchTask |
| 9 | `editDraft` 初值 | 抽取初始化表达式，断言来自 `task.estimatedMinutes` 而非常量 |
| 10 | settings 初值 | `JSON.stringify` 初值对象含 `defaultEstimateMinutes` 与 `dailyCapacityIncludeOverdue` |

**`test/routes.test.mjs` 增补（3–4 条）**：`estimatedMinutes` 夹取（`99999→1440`、`-5→null`、`0.5→null`、`'90'→null`）；新设置键默认值 / 写入回读 / 越界夹取（`1→5`、`99999→1440`）。

### P3c —— 变异探针矩阵（`probe-capacity-mutations.mjs`，每条必须让测试变红）

| # | 变异（把好代码改成坏代码） | 期望变红的用例 |
|---|---|---|
| M1 | `?? 30` → `?? 0` | 基准 1（`planned`、`fallbackCount`） |
| M2 | 去掉 `status ∉ {done, cancelled}` 过滤 | 基准 1（T8/T9 被计入） |
| M3 | 去掉 `archived` 过滤 | 基准 1（T10 被计入） |
| M4 | 逾期改成默认计入 | 基准 1（`planned` 变 1380） |
| M5 | 全天任务改按 480 计 | 基准 1 / 用例 13 |
| M6 | `free` 去掉 `max(0, ·)` | 基准 2（超支时 `free` 变负） |
| M7 | 未知优先级归 `p0` | 用例 18 |
| M8 | `fallbackCount` 漏算"继承截止且未填"的那条 | 基准 1（`fallbackCount` 变 1） |
| M9 | `fallback` 参数不用传入值、写死 30 | 用例 3（改 60 后 `planned` 不变） |
| M10 | `useMemo` 依赖数组塞回 `now` | 接线 3 |
| M11 | `saveEditDraft` payload 删掉 `estimatedMinutes` | 接线 7 |
| M12 | `editDraft` 初值改回常量 | 接线 9 |

（M10–M12 是"接线类"变异，证明**接线本身**被测试锁住，而不是只测了纯函数。）

### P4 —— 服务端设置：默认耗时 + 逾期开关

**改** `src/shared/contracts.ts`：`WorkbenchSettings` 加
`defaultEstimateMinutes: number`、`dailyCapacityIncludeOverdue: boolean`（doc 注释写清语义、范围、默认值）。

**改** `src/api/routes.ts`：
- `readWorkbenchSettings` 读 meta `default_estimated_minutes`（夹 5–1440，缺省 30）与 `daily_capacity_include_overdue`（缺省关）；
- `POST /api/workbench/settings` 接受两字段并夹取落库（与 `dailyCapacityMinutes` 同一写法）；
- **不动 schema、不加迁移**（meta 存偏好）。

**改** `src/client/components/SettingsModal.tsx`：加两个控件 + 各一句说明（改完回写 `settings`）。

**改** `src/client/index.tsx:745` 的 settings 初值补两个字段（**漏了就是 `undefined` → 容量算成 NaN**）。

**新增测试**：`test/routes.test.mjs` 补默认值 / 写入后回读 / 越界夹取（`1 → 5`、`99999 → 1440`）；`capacityWiring` 里用 `JSON.stringify(settings初值)` 断言含两键。另加一条：**settings 异步加载期间初值 30 与服务端值不同只造成一次重算，不得出现 NaN/闪烁断言失败**（把"加载中"写进规则文案即可）。

### P5 —— 收口：对照说明 + 交付文档 + 门禁

- 用**修好的** `scripts/repro/measure-capacity-baseline.mjs`（v2：本地日期串 + `effectiveDueAt` + `parent_id`）在真库副本上重跑修前数字，实施后重跑修后数字 → `_local-archive/capacity/before-after.md`（**原样贴实测 JSON**，不写复现不出来的百分比）。
  > 探针 v1 有两个缺陷（都是我自己的）：① 用 `toISOString().slice(0,10)` 打印本地日期 → 在 UTC+8 **退回前一天**（跑出"今天：2026-09-16"而实际是 09-17）；② 读原始 `due_at` 且 SQL 忘了选 `parent_id` → 继承分支静默走空，**少报 6 条逾期**。v2 已修，并与**另一份独立实现**交叉校验一致（0 条计入 / 10 条逾期 / 750 min）。
- `docs/design/2026-09-25-capacity-rules.md`：算法规格 + 手算基准 + 三条刻意差异（`0` 走兜底 / 逾期默认口径 / 全天口径）+ "幽灵逾期"既有语义 + 变异探针结论 + 已知边界。
- 门禁：`pnpm typecheck` → `pnpm test`（448 + ≥55 新增）→ 变异探针全红 → `harness --case capacity` 全绿 → `node scripts/dev-install.mjs --apply`（**需要你明确授权**，走 `dsh-safe-plugin-ops` 门禁 A：备份 / 零增量 diff / 指纹 / 版本一致性 / `--dump-config`）。
- **版本号不动**（仍 1.15.1），**不自行重启**；重启后由你按第六节清单逐条手点。

---

## 六、验证矩阵（验收标准 → 验证方式）

| 任务验收标准 | 怎么证 |
|---|---|
| 界面上能查到完整规则：已排怎么算、全天怎么算、逾期怎么计 | P2 七条规则 + harness 断言"展开后能看到这七句 + 逾期 10 条/750 min 提示" |
| 任务设置页可改耗时，改完立即影响今日容量，刷新后保持 | P3 真机脚本（**临时任务**，finally 删除）：不刷新读到 +90 / `F5` 后仍是 90 / 重开回显 90 + payload 行为断言 |
| 固定数据可手工复算，界面「已排」与手算一致 | 11 行基准表 → 单测断言 `planned=420`；harness 断言**页面上就显示 420**；`verify-capacity-fixed-dataset.mjs` 打印同组数字（三处同一组数） |
| 给出修前/修后对照说明 | P5 `before-after.md`：修复后的探针在同库副本上的两次实测输出 |

**反向验证（必须真做）**：把变异装回产品代码 → 测试变红（P1 的 8 条 + P3 的 2 条：删 payload 字段 / 改回常量初始化 `editDraft`）；撤掉 `CapacityRulePanel` → harness 非零退出。

---

## 七、修前 / 修后对照（修前数字已实测；"修后"待实施后填实测）

| 场景 | 修前（实测） | 修后（预期，P5 用实测替换） |
|---|---|---|
| 用户想知道「已排 0」怎么来的 | 无任何规则文本，`aria-label` 也不提口径 | 展开即见七条规则 + 账本逐条出处（表尾合计=已排） |
| 今天有 10 条逾期 750 min | 数字里**看不见**，无任何提示 | 明确列「10 条 / 750 min 默认不计入」+ 开关（→ planned 750 / 超支 450） |
| 其中 6 条来自已取消父任务的继承 | 完全不可见（连 bootstrap 的逾期计数里也混着） | 标「继承自已取消父任务」，并说明这是既有语义 |
| 全天任务 | 无写入入口、无说明（`all_day=1` 共 3 条，均已归档/完成） | 任务设置页可勾选；界面写明"不改变容量计算" |
| 某任务耗时想改成 90 分钟 | **做不到**（编辑弹窗没这字段，只有 AI 工具能写） | 设置页改 90 → 保存 → **不刷新**已排 +90 → `F5` 仍 90 |
| 没填耗时的任务（活跃 26 条里 20 条） | 静默按 30 计，用户不知情 | 账本逐条标「按默认 30」，头部显示「N 条按默认」（今日 N=0，因为今天计入 0 条） |
| 规则可否复算 | 只能读 4987 行源码 | 固定数据集 + 单测 + harness + 脚本四处同数字 |

> 上一版这里写死了「头部显示 3 条按默认」——那是占位值，与实际不符（今天计入 0 条 → N=0）。已改成带占位的 `N`，并标注数字时点。

---

## 八、风险、边界与回滚

**已知边界（写进设计文档，不假装没有）**
1. **继承 due 的行为面**：无 due 的活跃任务里 **6 条**继承到祖先的**已过期** due（父任务今天到期时会走"今天到期"分支计入）——沿用既有继承语义，规则里写明。
2. **幽灵逾期**：继承**不看祖先状态**，取消父任务后子任务仍继承其过期 due（实测：活跃集的 10 条逾期里 **6 条**属此类；bootstrap 的逾期统计是 12 条 / 全表口径，含归档行）。与既有语义一致，账本标注；改语义另开需求。
3. **父子可能重复计**：父子同时未完成时各自计一份（实测当前 2 对）。引入去重会改变既有口径，**本次不做**，只在账本里给同链标记。
4. **`estimatedMinutes: 0`** 旧代码计 0 分钟、新代码按"没填"走默认 —— **刻意修正**，测试标注防被改回。
5. **子任务体系**：AI 拆解出来的子任务基本都不填耗时 → 一父多子会让"已排"快速膨胀（30/条）。属功能可见后的自然结果，靠账本让用户看得见，不设上限。
6. 不做的事：虚拟滚动、批量改耗时、按类型分别设默认耗时、把容量搬到服务端（权威源仍是 `capacity.ts`）、取消父任务时的级联 due 处理。

**风险与应对**
| 风险 | 应对 |
|---|---|
| 抽纯函数时改口径（本项目最大 bug 类别） | P1 先跑 200 组等价性对拍，再动界面 |
| `now` 进 memo 依赖导致每帧失效 | 依赖数组用 `localDateString(now)` 字符串；接线测试断言依赖数组不含 `now` |
| settings 新键漏进客户端初值 → NaN | P4 用 `JSON.stringify` 断言初值含两键；`computeTodayCapacity` 内部守非有限输入 |
| 真机脚本污染用户数据 | 临时任务 + `finally` 删除 + 删除成功断言（P3） |
| harness 假绿 | `--case` 参数化 + 成功路径显式 `exit(0)` + 接线断言做成前提 |
| 面板挤坏容量条 | harness 像素级断言（同一行不换行 / 数字不截断 / 搜索框宽度，沿用 listview 那套） |

**回滚**：全部改动在分支 `feat/capacity-rules-transparency`，各阶段可单独 revert。装盘后回滚 = 恢复 `profiles/web/package.json.bak-*` + `pnpm install`，或 `dsh plugin --profile web add file:<上一个 dev tgz>`。新 meta 键是纯增量，旧代码读不到也不崩。

---

## 九、审查收口（独立报告 6 条 → 我的裁定）

| 独立报告 | 裁定 | 依据（我复跑的结果） |
|---|---|---|
| 1 `count`/`planCovered` 是死字段 | **成立（且原本就是排除项）** | 全仓各 1 次出现 = 赋值行；结论是"新 `aria-label` 需要显式计数字段"，已并入 P2 |
| 2 `estimatedMinutes` 服务端无夹取 | **成立（高）** | `routes/tasks.ts:95` 只判 `typeof === 'number'`；对照 `routes.ts:176` 设置项有夹取。已并入 P3 |
| 3 真机脚本会写用户真实库且无还原 | **成立（高）** | v1 方案确实没写隔离；已改为临时任务 + `finally` 删除 |
| 4 "库已漂移／全天 3 条／探针复现不出 77%" | **部分推翻** | 实测 `all_day=1` 共 **3** 条（**全部已归档/完成**，未归档未完成 0 条）——我 v1 写"0 条（从未写入）"不准确，**已改为带时点的实测值**；但"今天 09-16 → 现在 09-17"**不是库漂移，是我探针的时区 bug**（`toISOString().slice(0,10)` 在 UTC+8 退回前一天），已修 |
| 5 基线探针用 `due_at`、与 `effectiveDueAt` 口径不一致 | **成立（且我实测出更严重的第二因）** | 除了反例 `due_at`，探针的 SQL **还漏选了 `parent_id`** → 继承分支静默走空，**少报 6 条逾期**（4 条 vs 真值 10 条）。两处都已修，并与独立实现交叉校验一致 |
| 6 `--case` 参数不存在 / 成功路径无 `exit 0` | **成立（低）** | `harness-real-browser.mjs` 里 `process.argv` 零匹配、尾部只有失败分支 exit。已并入 P2 |

**独立报告提出但被我实测推翻的**：时区可移植性（若测试机 ≤ UTC-9，`18:00+08:00` 会掉到前一天 → `planned=330`）。
实测：`TZ=America/Anchorage` 下 `new Date('2026-09-16T18:00:00+08:00').toDateString()` = `Wed Sep 16`，`sameDay` 仍为 true —— **该断言在任何时区都成立**（Node 在 Windows 上确实认 `TZ`，我验证过 `Intl…timeZone` 变成 `America/Anchorage`）。
不过它给的**建议**（测试别依赖机器时区）我采纳了：基准数据一律用本地组件构造。

**我自己抓出的两个真缺陷**（都不在独立报告里）：
① 探针 `toISOString().slice(0,10)` 的**本地日期串时区串味**（会把"今天"报成前一天、due 日期也错位一天）；
② 探针 SQL **漏选 `parent_id`** → 继承判定静默失效、少报逾期。
→ 已修，并新增 `scripts/repro/verify-capacity-review-claims.mjs` 作为**独立实现的交叉校验**（两份不同实现必须给出同一个 `planned/overdue`）。

---

## 十、工作量与提交序列

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | `capacity.ts` + 白名单 + 基准/等价性测试 + 8 条变异探针 + index.tsx 换调用 | 3–4 h |
| P2 | 规则面板 + 账本 + 开关 + 样式 + 接线测试 + harness 参数化 + 容量批 | 4–5 h |
| P3 | 编辑弹窗耗时/全天 + 校验 + 乐观更新 + 详情行 + 新建表单 + **服务端夹取** + 真机脚本（临时任务） | 3–4 h |
| P4 | 契约/路由/设置页两偏好 + 路由测试 | 1–2 h |
| P5 | 对照说明 + 设计文档 + 门禁 + 装盘（需你授权） | 1–2 h |

提交：`refactor(capacity): 抽出容量计算纯函数、基准与等价性测试` → `feat(capacity): 规则与账本可见（含逾期口径开关）` → `feat(tasks): 任务可自定义耗时与全天标记（含服务端夹取）` → `feat(settings): 默认耗时与逾期口径` → `docs(capacity): 修前修后对照与交付说明`。
每步跑 `pnpm typecheck` + `pnpm test`；P1/P2/P3 各跑对应变异探针；P2 跑 harness。

---

## 十一、决策锁定与前置约定（执行会话按此直接开工）

> 本节是 v2 方案经审查收口后的**执行前提**。咨询会话在此之前**不写产品代码**（用户明确要求：后续新开会话执行）。

| # | 决策 | 采用值 | 依据 |
|---|---|---|---|
| D1 | 逾期未完成任务是否计入「今日容量」 | **默认不计入 + 界面写清 + 一个默认关闭的开关（选择存服务端 meta）**，即方案 C | 逾期是历史欠账，混进"今天要做的事"会让读数失去意义；开关让口径可切换且可见 |
| D2 | `estimatedMinutes` 的合法区间 | **1–1440**；`0`/负/非有限/小数 → `null`（= 没填）；`>1440` → `1440` | 不再引入"5 分钟"第二阈值（避免"存进去了但不算"的错位）；1440 与 `dailyCapacityMinutes` 的上限一致 |
| D3 | 默认耗时（没填时的兜底） | **30 分钟**，可在设置页改（5–1440），存 meta `default_estimated_minutes` | 沿用现状常数 30，但从"写死的代码"变成"可见可改的偏好" |
| D4 | 全天任务是否改变容量计算 | **不改变**（与普通任务同算法）；只影响显示与重复锚点 | 容量问的是"投入多少时间"，全天只说明"什么时候" |
| D5 | 幽灵逾期（继承自已取消祖先的 due） | **本次不改语义**，只在账本里标注来源 | 服务端 bootstrap 逾期统计早就是这个语义；改它属级联行为，另开需求 |
| D6 | 父子同时未完成是否去重 | **本次不去重**，只在账本里给同链标记 | 去重会改变既有口径，且"父任务要不要占时间"本身需要产品判断 |
| D7 | 容量计算的权威源 | 客户端纯函数 `src/client/capacity.ts`（**不上移到服务端**） | 容量是派生视图量，不需要落库；上移会引入两处实现的经典风险 |
| D8 | 版本号与装盘 | **不 bump 版本号（仍 1.15.1）**；装盘走门禁 A 且**需用户显式授权**；**绝不自行重启** | 项目交付约定：版本号只在发布时改；重启必然由用户发起 |

**执行会话的开工顺序**：先读本节 → 再读第五节对应阶段 → 按第十三节清单自检。**遇到与本节冲突的既有代码，以本节为准，并在提交信息里写明取舍。**

---

## 十二、界面文案定稿（实现时逐字使用，别临场改写）

### 12.1 「今日容量」头部（紧凑态）

```
今日容量                    已排 420 min   可投入 300 min   余 0 min   ⌄ 规则
[▓▓▓▓▓▓▓▓ 条状图（按优先级着色，逾期计入时多一段斜纹）]
紧急 60   高 30   普通 300   低 30   空闲 0
```

- `⌄ 规则` 是按钮（`aria-expanded`），点开即 12.2。
- 条形 `aria-label` 必须含口径：`今日任务时间占比：紧急 60 分钟、高 30 分钟、普通 300 分钟、低 30 分钟、空闲 0 分钟；今天到期 1 条、无截止推进中 1 条、逾期未计入 10 条 / 750 分钟。`

### 12.2 规则面板（展开态）——七条，逐字

1. **算哪些任务**：只看**未归档、未完成、未取消**的任务。
2. **截止时间会沿任务树继承**：任务自己没设截止时间时，用它**最近的有截止时间的祖先**的。
3. **今天到期**：有效截止时间落在**今天**（本地日）的，计入「已排」。
4. **无截止但在推进**：自己和祖先都没有截止时间、且状态是**进行中/受阻**的，计入「已排」。
5. **逾期的默认不计入**：有效截止时间**早于今天 0 点**且未完成的，默认**不计入**「已排」（下面可以打开开关把它算进去）。它和「今天到期」互不重叠，不会算两遍。
6. **每条任务算多少分钟**：用任务的「预计耗时」；**没填的按默认耗时 30 分钟**（可在设置里改）。全天任务**同样**按预计耗时算 —— 「全天」只影响显示与重复锚点，**不改变容量计算**。
7. **汇总口径**：`已排 = 上面所有计入任务的分钟之和`；`余 = max(0, 可投入 − 已排)`；`已排 > 可投入` 时读数标为**超支**。下面的账本逐条列出了每个数字的来源。

> 文案里的数字（`已排 420` / `30 分钟` / `10 条 / 750 min`）是**示例**，实现时必须用**当前计算结果**插值。
> 第七条里的 `30` 要取 `settings.defaultEstimateMinutes`，不是字面量 —— 否则用户把默认改成 60 后文案会说谎。

### 12.3 账本（与 12.2 同区，规则之下）

表头：`任务 | 优先级 | 分钟 | 来源`
来源标记枚举（逐字）：`今天到期`、`无截止·推进中`、`逾期计入`、`按默认 30`、`全天`、`继承父任务截止`、`继承自已取消父任务`
表尾：`合计 = 已排 420 min`
逾期区（无逾期时整块不渲染）：`逾期未完成 10 条 / 750 min —— 默认不计入「已排」`
开关：`把逾期任务计入今日容量`（右侧 `?` 提示：「打开后上面的『已排』会变成 750 min」）
底部：`默认耗时 30 分钟（在设置里改）` · `口径说明见设计文档 docs/design/2026-09-25-capacity-rules.md`

### 12.4 任务设置页（编辑弹窗）新增两项

```
耗时（分钟）  [ 90        ]   留空 = 默认 30 分钟
                              改完立即影响今日容量的「已排」
全天任务      [x]             只影响显示与重复锚点，不改变容量计算
```

- 非法输入的**行内红字**（逐字）：`耗时必须是 1–1440 之间的整数（留空表示用默认 30 分钟）`
- 新建任务表单同两行（文案相同），避免同一字段两个入口两套说法。

### 12.5 任务详情页信息行（`:3320-3325` 那一组旁追加）

```
预计耗时：90 分钟
预计耗时：默认 30 分钟（未单独设置）        ← 未填时
预计耗时：默认 30 分钟（未单独设置） · 全天  ← 未填且全天
```

---

## 十三、执行会话开工自检清单（照做，不要凭记忆）

**环境与前置**
- [ ] `git switch -c feat/capacity-rules-transparency`（从 `main` 开分支；当前 main 干净，只有本方案的几个未跟踪文件）
- [ ] `node scripts/repro/verify-capacity-fixed-dataset.mjs` → 必须输出"完全一致（0 处不符）"。**这一步先于写任何代码**：它用手算之外的第二套实现校验基准夹具，基准错了后面全白做
- [ ] 把 `src/client/capacity.ts`、`src/client/components/CapacityRulePanel.tsx` 加进 `tsconfig.build.json` 的 `include`（**不做这步 `test/` 直接 import 不到**：`pnpm test` = `pnpm build`（会 `rmSync('lib')`）+ `node --test`）
- [ ] 跑一次 `node scripts/repro/measure-capacity-baseline.mjs` 与 `node scripts/repro/verify-capacity-review-claims.mjs`，确认两者给出**同一组** `planned / overdue`（真库口径自检）

**P1 完成的判据**
- [ ] `computeTodayCapacity` 是唯一实现；`index.tsx` 里搜不到第二处 `estimatedMinutes ?? `
- [ ] `useMemo` 依赖数组**不含 `now`**（是 `localDateString(now)` 字符串）
- [ ] 基准表断言 `planned=420 / 1380 / 480`、`fallbackCount=2` 全绿
- [ ] 等价性对拍 200 组通过；唯一差异（`estimatedMinutes: 0`）被单列测试标注
- [ ] `probe-capacity-mutations.mjs` **全红**（≥8 条），失败即说明测试没锁住
- [ ] 删掉的 `capacity.count` / `planCovered` 在提交信息里写明"确认过无消费点"

**P2 完成的判据**
- [ ] `CapacityRulePanel` 只吃 props；`includeOverdue`/`defaultEstimateMinutes` 唯一来源是 `settings`
- [ ] `harness-real-browser.mjs --case capacity` 全绿：页面上显示 **420**、账本 5 行、切开关变 **1380**、收起回紧凑态
- [ ] 成功路径有**显式 `process.exit(0)`**；撤掉组件 → 非零退出
- [ ] 12.1–12.3 文案逐字落地（含 `aria-label` 三个计数）

**P3 完成的判据**
- [ ] payload 真带 `estimatedMinutes` 与 `allDay`（桩收到的实参断言，不是形态扫描）
- [ ] `''→null`、`'90'→90`、`'0'→报错且不调用 patchTask`、`'2000'→报错`
- [ ] 服务端夹取：`99999→1440`、`-5→null`、`0.5→null`、`'90'→null`
- [ ] 真机脚本用**临时任务**并在 `finally` 里删除（含失败路径），**校验删除成功**
- [ ] 乐观更新幂等：连续保存两次结果一致

**P4 完成的判据**
- [ ] `WorkbenchSettings` 两个新键在 `index.tsx:745` 初值里（用 `JSON.stringify` 断言）
- [ ] 路由测试覆盖默认值 / 回读 / 夹取

**P5 / 交付**
- [ ] `pnpm typecheck` 0；`pnpm test` 448 + ≥55 全绿
- [ ] `_local-archive/capacity/before-after.md` 用**修好的探针**的实测 JSON（不写复现不出来的百分比）
- [ ] 设计文档 `docs/design/2026-09-25-capacity-rules.md`
- [ ] 装盘前向用户要**显式授权**；不自行重启

---

## 十四、下一会话的交接说明

**已完成的（本咨询会话，未提交）**
- 本方案全文（v2 + 本轮补的 §4.1–§4.3 夹具、§11–§14）
- `test/fixtures/capacityFixture.mjs` —— **基准夹具的唯一一份**（含写死的期望值），测试与 harness 都必须 import 它
- `scripts/repro/verify-capacity-fixed-dataset.mjs` —— 用**第二套独立实现**复算夹具并与期望值对拍（已抓到 2 个手算错误：`dueTodayCount` 3→4、`p1` 30→510）
- `scripts/repro/measure-capacity-baseline.mjs` —— 只读真库基线探针（v2 已修时区串味 + 继承口径 + 补选 `parent_id`）
- `scripts/repro/verify-capacity-review-claims.mjs` —— 真库口径的独立实现交叉校验
- `scripts/repro/measure-capacity-parent-child.mjs` —— 父子链暴露面测量（可删）

**未做的（明确不在此会话做）**
- 任何产品代码改动、任何提交、任何装盘、任何重启

**交接时必须知道的三件事**
1. 三次"SQL 漏选字段 → 过滤恒假/分支走空"的教训已经发生（`parent_id`、`archived`，以及 `toISOString` 时区串味）。写新探针时先断言列齐全，并把**零输出当异常**。
2. 真库当前状态是**时变**的：今天计入 0 条 / 逾期 10 条 750 min / 没填耗时 20 条（2026-09-17 实测）。任何断言都不要把真库当日数字写死进测试，真库数字只进 `before-after.md` 快照。
3. 用户的验收标准第 2 条要求"改完立即影响今日容量"——实现上就是**乐观更新 + 立即重算**，不是"刷新后生效"。

