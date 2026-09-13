# 架构规范（当前代码框架下的硬约束）

> 回答三个问题：**代码怎么分层**、**依赖朝哪个方向**、**什么操作不允许**。
> 每条都注明"为什么不许"与"谁来拦"（拦得住才有意义）。
> 编码规范见 [SKILL.md](../SKILL.md)；交付流程见 [delivery.md](./delivery.md)。
>
> 规模基线（2026-09-13，`(Get-Content f).Count` 口径）：**87 个源文件**，
> 最大文件 `src/client/index.tsx` **3942 行**（这是历史遗留，见第 5 节）。

## 1. 两半两入口

| 半边 | 入口 | 运行环境 | 产物 |
|---|---|---|---|
| **宿主半边** | `src/index.ts` | Node（DSH 主机进程） | `lib/index.js`（`package.json.main`） |
| **客户端半边** | `src/client/index.tsx` | 浏览器（宿主页面） | `lib/client.js`（**单文件 bundle**，`window.__ModuleLoader__.load({id, factory})` 的 CJS 包） |

- 客户端**不能** import Node 内置模块（`node:fs` / `node:sqlite` 等）；宿主半边**不能**碰 DOM。
- 客户端产物是**一个文件**：没有按目录拆分的运行时模块，所以"能不能被 `node --test` 测"
  只取决于**源码是否与 DOM/React 解耦**（见第 3 节）。
- 构建：`pnpm build`（`tsc -p tsconfig.build.json` + `tsdown`）。
  **`tsconfig.build.json` 的 `include` 是白名单** —— 新增一个"要给测试用"的纯模块，
  必须把它加进去，否则 `lib/` 里没有它、测试 import 不到。

## 2. 分层与依赖方向（严格单向，不允许反向）

```
客户端：
  index.tsx（组装 / 生命周期 / 槽位注册）
     ├─▶ components/*.tsx（纯展示：只发意图，不碰 DOM 存储）
     ├─▶ panelState.ts / capabilities.ts（纯函数：无 React、无 DOM）
     ├─▶ entryContract.ts（槽位名 + 样式门控 + 诊断查询）
     ├─▶ styles.ts（CSS 文本）      └─▶ constants.ts（常量）
     └─▶ api.ts（HTTP）─▶ viewTypes.ts（视图类型）

宿主半边：
  index.ts（apply：装配 / 降级 / 告警）
     ├─▶ api/routes.ts ─▶ api/routes/*.ts ─▶ db/repo.ts
     ├─▶ tools.ts（agent 工具）──▶ db/repo.ts
     ├─▶ reminder/*（调度与通道适配）
     └─▶ review-memory.ts（内部记忆能力，可选）

数据层：
  db/repo/*.ts  ── 只有 shared.ts 与 task-primitives.ts 是"零 repo 内依赖"的底座；
                   drafts.ts 可以依赖 tasks.ts / dictionaries.ts / reminders.ts；
                   反向依赖（tasks.ts → drafts.ts）**禁止**（会成环）。
  db/schema.ts  ── SCHEMA_VERSION + MIGRATIONS（只追加）
```

**规矩：**

- **纯函数模块（`panelState.ts` / `capabilities.ts` / `api.ts` / `viewTypes.ts` / `format.ts`）不得 import React、不得碰 DOM。**
  这是它们能被 `node --test` 直接测的前提；破了这条，"策略"就再也锁不住。
  （现有例外只有两处，都是**诊断/查询用途**：`entryContract.ts` 的 `officialPanelRowRendered()`
  做 `querySelector`、`constants.ts` 里只是注释提到 `document`。）
- **`db/repo/shared.ts` 必须保持零 repo 内依赖**：它是确认草稿的公共骨架，
  一旦它反过来 import `drafts.ts`（为了用 `updateDraft`），`drafts.ts ↔ shared.ts` 就成环了。
  需要写 payload 时**直接写 SQL**（现有实现就是这么做的），不要为了复用而制造环。
- 组件不 import `db/*`、不 import `node:*`；路由不 import 组件。

## 3. 客户端：意图 / 投影分离

- **组件只做两件事**：把快照喂给纯函数、把结果渲染出来。**业务判定不进组件。**
- **唯一权威源**：面板可见性只由 `panelState.ts` 的 `decidePanel()` 回答；
  `data-open` 由同一个函数的派生 `panelDataOpen()` 给出（判定与投影不可能不一致）。
- **只读缓存不得充当决策依据**：从槽位 props 读到的宿主状态是渲染期缓存，
  决策只能走 `decidePanel()`。任何"在别处再算一遍"都是下一个 bug（见 SKILL.md 第 0 节）。
- **禁止渲染期副作用**：不写 DOM、不改模块级变量、不 `createRoot().render()`。
  一律进 `useEffect`，并且**幂等**（同值不写 —— MutationObserver 对"写相同值"也会派发记录）。

## 4. 允许写哪些 DOM（白名单）

| 允许 | 位置 | 说明 |
|---|---|---|
| `<html data-dsh-personal-workbench-active>` | `documentElement` | 自用 CSS 门控 + 标题栏高亮，**幂等写** |
| `<html style="--wb-sidebar-w: Npx">` | `documentElement` | 面板左边界（运行时量出侧栏宽度），**幂等写** |
| `<html data-dsh-personal-workbench-official>` / `-pending` | `documentElement` | 自用：官方路径就绪 / 有草稿浮卡 |
| `[data-dsh-personal-workbench-view]` 子树 | **自建节点** | 组件自己的容器 |

**禁止**（每一条都有事故或扫描测试兜着）：

- ❌ 往宿主侧栏/中栏 `appendChild` / `insertBefore` / `remove` 任何节点（I6 扫描）
- ❌ 读写任何 `data-dsh-<其它插件>-*`（I5 扫描）
- ❌ 广播/监听 `dsh-panel-activate`（家族土办法；宿主机制已覆盖）(I5 扫描)
- ❌ 写非 `data-dsh-personal-workbench-*` 前缀的属性到 `<html>`（I4 扫描）
- ❌ 用 `closest()` / `matches()` 读**自己刚写的**属性来做决策（自激）
- ❌ 用宿主 class 名（`sidebarCol` / `logoRow` / `centerCol` 这类）**做挂载或布局决策** ——
  它们是可以被读来量尺寸的（如侧栏宽度），但**不能当作我们的挂载点或显示判据**（DSH 一升级就失效）
- ❌ 直连宿主私有 API：`ctx.x.y` 链式访问一律走 `safeService` / `optionalService` 封装，
  且**每层都加 `?.`**（`a?.b.c` 在 `b` 为 undefined 时照样抛）

## 5. 文件规模与拆分

| 现状 | 约束 |
|---|---|
| `index.tsx` **3942 行** | **不许再涨**。新增 UI 一律进 `components/`；新增判定一律进纯函数模块 |
| 单个 `.tsx` 组件 | 目标 ≤ 300 行（`DraftBanner.tsx` 774 行已是上限，不再加分支类型） |
| 纯逻辑模块 | 目标 ≤ 200 行（`panelState.ts` 127 / `capabilities.ts` 133 是样板） |
| `db/repo/*.ts` | 按域拆（现有最大 `drafts.ts` 433 行）；新域开新文件 |

**拆分的出口判据是"目标文件变小"**（写进提交信息）。历史上有过一次未完成的客户端拆分：
计划拆巨型组件，结果它从 1958 涨到 2491 行、最后被取消（细节见 SKILL.md 第 12 节）。
**拆分不许留两份实现** —— "两份"正是本项目最大的 bug 类别。

## 6. 数据库与写入契约

- **`SCHEMA_VERSION` 只单向前进**（当前 15）：新增迁移**追加到 `MIGRATIONS` 末尾**，
  **绝不改旧迁移**。库比插件新时：**升级插件，不降级数据库**。
- **库比插件新不是"崩溃"而是"降级"**：`SchemaTooNewError` + `applyDegraded()`
  （不注册任何路由/工具，但注册 systemPrompt 告警）。**可选功能插件没有资格让宿主起不来。**
- **写入路径唯一**：`UI / 工具 → HTTP 路由 → db/repo → SQL`。组件与工具**不得**直接写 SQL。
- **幂等**：确认/提交类写入口先判状态、再写、并记录产出（可回放）；
  幂等判据抽成一处（例：`findSiblingByTitle` 被两条确认路径共用）。
- **静默丢件是禁区**：校验不过 → 回 `problems[]` + 界面标黄；非法 code 当场拒绝并回显合法枚举。

## 7. 状态与语义（容易写错的一类）

- **状态机语义只在 `db/repo/status.ts` 定义**（终态/窗口/重新武装这类），别在路由或组件里各写一遍。
- **提醒的"终态"与"窗口"是两件事**：`fired_at` 的三种语义曾被混用，导致"逾期提醒永久滞留"。
- **草稿的确认是幂等语义**：一条草稿 = 一次决定 = 一个产出。
- **不要用"再加一个标志"去协调两个源**（见 SKILL.md 第 0 节的反例）；
  先把归属写下来：谁能写、谁只读、不可读时谁兜底。

## 8. 一页速查：不许做 / 必须做

| ❌ 不许 | ✅ 必须 | 谁拦 |
|---|---|---|
| 在组件里写 DOM / 改模块级状态 | 副作用进 `useEffect` 且幂等 | code review + panelCss 测试 |
| 在别处再算一遍"该不该显示" | 调 `decidePanel()` / 其派生 | `panelStateSource.test.mjs` 扫描 |
| 往宿主侧栏插入口行 | 注册官方槽位 `sidebar.panellist` | I6 扫描 |
| 读写兄弟插件属性 / 广播家族事件 | 不参与；互斥交给宿主 | I5 扫描 |
| 给宿主根元素写别家属性 | 只用 `data-dsh-personal-workbench-*` | I4 扫描 |
| `ctx.x.y.z` 直接链式访问宿主服务 | 走封装 + 每层 `?.` | code review |
| `db/repo/shared.ts` import `drafts.ts` | payload 直接写 SQL | 会成环，构建/运行时暴露 |
| 改旧迁移 / 降级数据库 | 追加新迁移；升级插件 | `SCHEMA_VERSION` + 部署检查 |
| 校验失败就 `continue`（静默丢件） | 回 `problems[]` 并标黄 | 回归测试 `db.test.mjs` |
| 拆分留两份实现 / 半途而废 | 搬完就删原实现；出口判据是文件变小 | code review |
| 在真实库上跑会写数据的验收脚本 | 先 grep 写操作；只读的直接跑 | 见 delivery.md 第 5 节 |

> 新增一条"不许"时：**同时想清楚谁拦它**。拦不住的规矩等于没有 ——
> 能写成扫描/单测的就写成扫描/单测（本项目 I4/I5/I6 就是这么来的）。
