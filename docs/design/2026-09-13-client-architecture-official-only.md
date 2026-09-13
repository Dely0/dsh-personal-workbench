# 工作台客户端架构设计 · 只支持 DSH 新版（官方槽位）

> 状态：**设计已定稿，待实施**
> 决策人：用户（2026-09-13）
> 实施方：任务 `db5b2f6b-cb34-4fae-b8c0-4cdb7d51a351` 的执行会话
> 前置证据：`docs/handover-2026-09-13-sidebar-slots.md`、`docs/releases/v1.14.45-sidebar-slots-acceptance.md`

---

## 0. 为什么要重做（不是"代码不好看"）

15 小时排查里，**同一类缺陷发作了三次**，每次从不同入口冒出来：

| 事故 | 现象 | 共同根因 |
|---|---|---|
| bug 2 | 点宿主官方行 → 中央一片空白 | "面板该不该显示"被**独立计算了 3 次** |
| bug 6 | 面板被兄弟插件挤掉后**再也打不开** | 同上（显示条件与观察器各判一次） |
| bug 9 | 低版本宿主上面板**永不显示** | 同上（判定问错问题 + 两个权威源） |

代码实测（`src/client/index.tsx`，4109 行）：

- **6 个可变标志 + 3 个 DOM 属性 + 1 个实时扫描**共同表达"面板开/关"
- `officialConfirmed` 一个标志被引用 **19 处**（行 3212–3377），是把三个判据**缝在一起**的线
- 同一概念有 3 个求值表达式，读的输入集合不同，**逻辑上可以互相矛盾**

**结论（诊断）**：这不是"写错了"，是**状态所有权从未被定义**。
**本次设计的核心目标**：让这类缺陷**在结构上无法出现**，而不是"更小心一点"。

---

## 1. 前提与范围（用户已决策）

| 决策 | 内容 |
|---|---|
| **只支持 DSH 新版** | 必须有 `slots` 服务 + `sidebar.panellist` / `main` / `shell.overlay` 槽位 + `layout.selectPanel` + 槽位组件的 `usePanelInfo` |
| **删除 DOM 降级腿** | 不再往宿主侧栏注入入口行、不再自建覆盖层容器、不再挂 `[data-dsh-*]` 家族标记 |
| **不处理兄弟插件冲突** | 与 task-board / ssh / mnemon 的互斥**不由我们承担**；它们未遵守官方槽位约定，责任在对方与宿主 |
| **不做兼容层** | 不写"探测到老版本就降级"的分支；老宿主上插件不启动是可接受的（有明确日志与文档） |

**明确放弃的能力**（写进 README，避免用户误解）：

- 在 DSH `0.1.1-rc.x` 上使用工作台（该版本 `layout` 不提供 `selectPanel`，官方路径无法成立）
- 与"用 DOM 接管中栏"的插件同时获得互斥的激活态

---

## 2. 设计原则（六条，每条都可被静态检查）

| # | 原则 | 可检查的判据 |
|---|---|---|
| P1 | **单一权威源**：面板可见性只由宿主 `activePanelId` 决定 | 全仓只有 `panelState.ts` 的 `decidePanel()` 回答"该不该显示" |
| P2 | **零影子副本**：本地不复制宿主状态 | 不存在 `officialConfirmed` 这类"我们自己判断宿主能不能用"的标志 |
| P3 | **写者唯一**：每个 DOM 属性只有一个写入点 | 我们只写 2 个属性（见第 5 节白名单） |
| P4 | **意图 / 投影分离**：UI 只发意图，不写 DOM | 组件里不出现 `document.` / `getComputedStyle` / `setAttribute` |
| P5 | **失败可观测**：能力不满足时**显式不启动**并留日志 | `inject` 声明完整；缺依赖时 cordis pending 且日志可读 |
| P6 | **冲突不归我们**：不读写兄弟插件的任何属性 | 源码中不出现 `data-dsh-taskboard` / `data-dsh-ssh` / `data-dsh-mnemon` |

---

## 3. 目标模块结构

```
src/client/
├── index.tsx              # 只剩 apply()：生命周期、inject、装配、cleanup（目标 <120 行）
├── capabilities.ts        # 宿主能力门槛：要求哪些服务/槽位；失败时给出可读原因
├── panelState.ts          # 【核心】纯函数状态选择器 + 状态权威表（无 DOM、可单测）
├── panelSlots.tsx         # 槽位注册三件套：panellist 图标 / main 占位 / shell.overlay 内容
├── contracts.ts           # 与宿主的接口形状（TS interface，仅类型 + 少量常量）
├── styles.ts              # 既有 CSS（去掉双容器二选一后大幅简化）
├── api.ts                 # HTTP 封装（保留网络级重试与可读报错）
└── components/            # 纯展示组件（既有一致，不重构）
```

**依赖方向（严格单向，不允许反向）**：

```
index.tsx ──▶ panelSlots.tsx ──▶ panelState.ts ──▶ contracts.ts
    │                │                │
    └──▶ capabilities.ts             └──▶ （无依赖，纯函数）
    └──▶ api.ts ──▶ （无依赖）
```

**硬约束**：`panelState.ts` / `contracts.ts` / `api.ts` **不得 import React、不得触碰 DOM** ——
这保证核心逻辑可以被 `node --test` 直接测，不依赖浏览器。

---

## 4. 核心设计：单一派生（P1 + P2）

### 4.1 状态权威表（唯一的真相）

| 状态 | 所有者 | 我们的读法 | 我们的可写性 |
|---|---|---|---|
| 宿主当前选中的面板 | **宿主**（`activePanelId`） | 槽位组件 props `usePanelInfo(sel)` | ❌ 只读；改变它只能通过 `layout.selectPanel(id\|null)` |
| 宿主是否给了 `usePanelInfo` | 宿主 | 首次渲染时记录一次（**不是决定"走哪条腿"，只决定"能否读状态"**） | ❌ |
| 本地"我发起的开合意图" | 我们 | `intentOpen`，**仅在宿主状态不可读时**作为回落 | ✅（唯一写者：`setOpen`） |
| 兄弟插件的激活态 | **对方**（或宿主） | **不读**（P6） | ❌ |
| 门控标记（`data-…-active`） | 我们（自用 CSS/高亮） | 由 `decidePanel()` 的派生结果投影 | ✅（唯一写者：投影函数） |

> ⚠️ **关键约定**：那些"我们从槽位 props 读到的宿主状态"只是**渲染期缓存**，
> **不得作为任何分支决策的依据** —— 决策只能走 `decidePanel()`。

### 4.2 唯一派生函数

```ts
// src/client/panelState.ts —— 纯函数，无 DOM、无 React
export interface PanelSnapshot {
  /** 宿主当前选中的面板 id；undefined = 拿不到 usePanelInfo（状态不可读） */
  readonly hostPanelId: string | null | undefined
  /** 本地开合意图（只在宿主状态不可读时参与判断） */
  readonly intentOpen: boolean
}

export type PanelDecision =
  | { readonly show: true }
  | { readonly show: false; readonly because: 'host-selected-other' | 'not-selected' | 'intent-closed' }

/**
 * 「面板该不该显示」的**唯一**答案。
 *
 * 决策表（穷举，测试逐行覆盖）：
 *   hostPanelId === PANEL_NAME                  → show
 *   hostPanelId === null | 其它 id               → hide(not-selected / host-selected-other)
 *   hostPanelId === undefined && intentOpen      → show
 *   hostPanelId === undefined && !intentOpen     → hide(intent-closed)
 */
export function decidePanel(snapshot: PanelSnapshot): PanelDecision
```

**三条渲染不变量**（由 `panelSlots.tsx` 单点执行，别再散落）：

1. `decidePanel().show === true` ⟺ 面板容器 `data-open="1"`（唯一写者）
2. `<html data-dsh-personal-workbench-active>` 的存在 ⟺ `show === true`（**幂等：值没变不写**）
3. 面板内容**只挂一次**（`shell.overlay`），开合只切 `display`，绝不卸载 —— 草稿弹框要跨页面常驻

---

## 5. 能力门槛与"不启动"契约（P5 + P6）

### 5.1 inject 声明（唯一判据，不再软探测）

```ts
// src/client/index.tsx
export const inject = ['sessions', 'workspaces', 'connection', 'slots', 'layout'] as const
```

**语义**：任一不满足 → cordis 让插件 pending（不加载）。这是**刻意的**：
老宿主上与其"半死不活地降级"，不如**明确不启动**，并在 README 写清最低版本。

配套：

- `capabilities.ts` 在 `apply()` 开头做一次**廉价自检**（不猜、不分支）：
  `slots.entriesOfSlot('sidebar.panellist' | 'main' | 'shell.overlay')` 三个槽位是否都在；
  缺则 `console.error` 一条**可读**信息（含缺哪个、要求什么版本），然后 **return 空清理函数，不注册任何东西**。
- **不写"探测失败就换一条腿"的分支** —— 这是本次要删除的头号复杂度来源。

### 5.2 我们允许写的 DOM 白名单（P3）

| 允许 | 说明 |
|---|---|
| `<html data-dsh-personal-workbench-active>` | 自用 CSS 门控 + 标题栏高亮；**幂等写** |
| `<html style="--wb-sidebar-w: Npx">` | 面板左边界；**幂等写**（同值不写） |

**禁止**（逐条对应删掉的代码）：

- ❌ 往宿主侧栏/中栏 `appendChild` / `insertBefore` / `remove` 任何节点
- ❌ 读写任何 `data-dsh-<其它插件>-*` 属性
- ❌ 广播/监听 `dsh-panel-activate`（家族土办法，宿主机制已覆盖官方路径）
- ❌ 用 `closest()` / `matches()` 直接读我们自己刚写的属性来**做决策**
- ❌ 渲染期写 DOM（一律 `useEffect`）

---

## 6. 兄弟插件冲突：明确的"不处理"政策

**归因**：这些插件（task-board / ssh / mnemon）未使用官方槽位，宿主无从知晓它们的存在，
因此宿主的 `activePanelId` 互斥机制**覆盖不到它们**。我们已进入官方机制，**不再为它们的缺席买单**。

**因此删除**：

- `retractSiblingPanels` / `retractSiblingPanelMarks`（摘对方 `*-active`）
- `siblingObserver`（监听对方属性变化后让位）
- `isSiblingActiveAttribute` / `isSiblingPanelActive` / `siblingPanelViewMounted` 及其过滤集
- `BLOCKED_ATTR` 与相关 CSS 门控

**保留的只有**：`isLoopbackRequest` 这类**安全围栏**（与互斥无关，别误删）。

**README 需写明**（准确归因，别写成我们的缺陷）：

> 面板互斥由 DSH 宿主的 `activePanelId` 保证。若同时使用**不使用官方槽位、
> 而以 DOM 接管中栏**的插件（如 task-board / ssh / dsh-mnemon），可能出现两个面板同时激活。
> 这是宿主缺少统一面板机制导致的已知限制，本插件不做跨插件 DOM 协调。

---

## 7. 不变量与测试（判据要能"静态失败"）

| 编号 | 不变量 | 测试方式 |
|---|---|---|
| I1 | "该不该显示"只有一处实现 | 表驱动单测穷举 `decidePanel` 的 4 种输入（含 `undefined`） |
| I2 | 决策表与渲染投影一致 | 组件测试：给定 snapshot → 断言 `data-open` 与 `-active` 属性 |
| I3 | inject 完整且不被"顺手"削减 | 断言 `inject` 精确等于 5 项数组 |
| I4 | 我们只写白名单里的 2 个属性 | 源码扫描：`setAttribute/removeAttribute` 的目标必须是白名单 |
| I5 | 不再触碰兄弟插件 | 源码扫描：不得出现 `data-dsh-taskboard` / `-ssh` / `-mnemon` / `dsh-panel-activate` |
| I6 | 不再有侧栏 DOM 注入 | 源码扫描：不得出现 `insertBefore` / `sidebarRoot` / `newSessionButton` |
| I7 | 网络瞬时故障可自愈 | `api.ts` 重试单测（网络 TypeError 重试；4xx/5xx 不重试） |
| I8 | 幂等写：同值不写 DOM | 连续调用 3 次 `syncActiveAttribute(true)` → 断言只写 1 次 |

> I4/I5/I6 是**源码级扫描**，成本极低、防回归最强 —— 它们把"政策"变成"编译期就能失败的约束"。

---

## 8. 迁移路径（⚠️ 阶段必须分开，不得合并）

> 教训来源：本项目最大的一次翻车就是"官方槽位 + 入口去重 + 开合对齐"**一次全改**，
> 导致三套判据互相打架、无法归因。

### 阶段 1：抽出纯选择器（**不删任何逻辑**）

- 新建 `panelState.ts` + 表驱动单测（I1 先绿）
- 把现有 3 处判据改为调用它（行为**保持逐字等价**，可用现状验收脚本对比）
- 出口：`verify-acceptance 17/17`、`verify-sidebar-collapse 6/6` 仍全绿，且无行为变化

### 阶段 2：删除 DOM 腿与家族互斥

- 删第 6 节列出的全部函数与 CSS；删侧栏入口注入与覆盖层容器
- 补 I4/I5/I6 源码扫描测试
- 出口：`verify-final-2`、`verify-acceptance`、`verify-sidebar-collapse` 在新版宿主上全绿；
  `verify-dom-leg-oldhost` **删除**（不再承诺老宿主）

### 阶段 3：能力门槛与文档

- 加 `capabilities.ts` 自检 + 可读日志；断言 inject（I3）
- README 写：最低支持版本、冲突政策、已知限制
- 出口：老宿主上"明确不启动 + 有日志"；新版宿主行为不变

**每阶段独立提交、独立验收**；任一阶段失败只回退该阶段。

---

## 9. 这套设计消除了哪些缺陷（对照证据）

| 已发生的事故 | 在新架构下的状态 |
|---|---|
| bug 2 官方行点了不开（3 个判据分叉） | **结构性不可能**：只有一个 `decidePanel()` |
| bug 6 被挤掉后再也打不开（死锁） | **随互斥代码一起消失**（不再有第二道显示门） |
| bug 9 低版本面板永不显示 | **不可能**：不再有"槽位在但缺 selectPanel"的混合态（缺能力就不启动） |
| bug 3 侧栏两行入口 | **不可能**：不再注入侧栏行 |
| bug 5 `BLOCKED_ATTR` 在官方路径卡死 | **不可能**：该属性与门控已删除 |
| bug 10 双 App 实例之争 | **不可能**：只有 `shell.overlay` 一个承载点 |
| bug 7 `syncCollapsed` 自激 | **不可能**：该函数已删除 |
| bug 8 渲染期写 DOM | 由 P4 约束（组件不写 DOM）+ I4 扫描防回归 |
| bug 4 `attributeFilter: []` 认知错误 | **仍可能发生**（通用 API 认知），但观察器数量从 4 个降到 0–1 个，暴露面大幅缩小 |

**诚实结论**：新架构不能消灭"对浏览器 API 的理解错误"（bug 4/7 那类），
但能消灭**全部**"多权威源 / 多判据 / 家族 DOM 协调"导致的缺陷 —— 而后者占了已发生事故的 6/9。

---

## 10. 与"重复任务"BUG 的关系（本任务的附带目标）

`db5b2f6b` 记录的"验收后出现同名重复任务"，**首先**要按它自己的描述独立定位
（草稿确认路径是否二次建单，入口：`src/api/routes/drafts.ts:87-103` / `:157`）。

**但本次架构变更会顺带大幅缩小它的可能性**：删除 DOM 腿后，客户端不再有
"两条腿各自确认/各自提交"的分叉；`requestCompletion` 的"存在则更新、否则新建"语义
（`src/tools.ts:788-792`）也会成为**唯一**的验收草稿写入点。

**实施方请**：先按原描述定位并修掉重复建单，再叠加架构变更；两者分别提交、分别验收。
