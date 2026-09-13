# dsh-personal-workbench

[![npm version](https://img.shields.io/npm/v/@dely0/dsh-personal-workbench)](https://www.npmjs.com/package/@dely0/dsh-personal-workbench)

A personal workbench plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web.
Turn your DSH into a **calendar + task list + AI assistant workbench**.

[English](#english) · 简体中文

---

# 中文

## 这是什么

`dsh-personal-workbench` 是一个 **DSH 个人工作台插件**：

- 📅 日历（周/月可切换）+ 任务列表（树状层级）
- ✨ 自然语言快速录入，AI 澄清后自动生成任务
- 🧠 每个任务可关联多个 AI 会话：澄清 / 咨询 / 拆解 / 执行 / 复盘
- 🎯 AI 会话前可勾选本机已安装的 Skill，提示词自动注入“加载这些技能”的指令
- ✅ 任务执行采用“AI 申请完成 → 用户验收”闭环
- 🗂️ 每个任务一个 AI 会话工作区（默认工作区 + 任务名文件夹）
- 📝 Markdown 任务描述、复盘记录、变更历史
- ⏰ 到期提醒（页内横幅）
- 🗄️ 归档区、任务恢复

数据完全存储在本地 `~/.dsh/workbench`，不上传任何服务器。

## 截图

> 以下截图来自 **v1.14.58 + DSH 0.1.5-rc.1**（2026-09-13 实机拍摄）。
> 面板走**官方槽位**路径：侧栏入口由宿主渲染，面板从侧栏右侧铺开、不覆盖左侧导航。

| 今日（任务 + 今日容量） | 今日排序 | 任务列表 |
|---|---|---|
| ![今日任务](screenshot/%E4%BB%8A%E6%97%A5%E4%BB%BB%E5%8A%A1.PNG) | ![今日排序](screenshot/%E4%BB%8A%E6%97%A5%E6%8E%92%E5%BA%8F.png) | ![任务列表](screenshot/%E4%BB%BB%E5%8A%A1%E5%88%97%E8%A1%A8.png) |

| 日历 | 知识库 | 点子 |
|---|---|---|
| ![日历](screenshot/%E6%97%A5%E5%8E%86%E5%8A%9F%E8%83%BD.png) | ![知识库](screenshot/%E7%9F%A5%E8%AF%86%E5%BA%93.png) | ![点子](screenshot/%E7%82%B9%E5%AD%90%E5%8A%9F%E8%83%BD.png) |

| 快速录入 | 微信接入 |
|---|---|
| ![快速录入](screenshot/%E5%BF%AB%E9%80%9F%E5%BD%95%E5%85%A5.png) | ![微信接入](screenshot/%E5%BE%AE%E4%BF%A1%E6%8E%A5%E5%85%A5.png) |

## 功能清单

### 任务
- 任务字段：标题、Markdown 描述、类型、状态、优先级、截止时间、AI 策略、提醒、工作区
- 无限层级子任务；今日 / 日历 / 列表三种视图
- 任务页筛选/排序：关键词（标题/描述）+ 状态/优先级/类型下拉多选可组合筛选；支持截止时间/优先级/创建时间/标题升降序；筛选保留父子层级，归档列表共用
- 任务类型、状态、优先级全部由字典表驱动，可自行扩展（设置页“字典管理”已支持新增/编辑/停用类型、状态、优先级、点子类型，默认项受保护）
- 已完成 / 已取消任务不可再次执行

### AI
- **快速录入澄清**：一句话 → 官方会话区进行需求澄清 → 生成待确认草稿
- **AI 咨询**：对任务提问、要建议（不执行）
- **AI 拆解**：生成子任务提案树，确认后落库
- **AI 执行**：任意节点（含父任务）且 AI 策略为“可执行”时均可执行；AI 完成后提交验收申请，用户验收后才算完成；父任务验收通过时未完成子任务会级联完成
- **验收「暂存」**：验收弹窗除「验收通过 / 驳回」外新增「暂存（先验证）」——草稿仍是待确认状态，但不再自动弹窗打断你；你先去跑回归测试，之后从「待处理」弹窗的「已暂存」段点「继续验收」唤回。仅验收类草稿（完成验收申请 / 复盘草稿）支持暂存
- **驳回有痕、AI 可见**：驳回或暂存都会写入任务事件与任务共享记忆；`workbench_request_completion` 支持 `feedback` 参数，返回里会告知「本次是第几次提交、上次被驳回/暂存于何时、原因」，AI 不必等你口头转述
- **草稿通知推送微信**：AI 提交草稿（验收申请 / 复盘 / 日报周报 / 知识 / 点子提案）时可经微信推送，复用任务提醒同一条通道与策略（静默时段、小时/日上限、汇总、熔断、未装 dsh-im 静默降级）；默认只开「验收申请」与「复盘草稿」，可在设置页按类型开关
- **Skill 选择器（AI 会话前加载技能）**：发起 AI 执行/协助/拆解/复盘/排序/报告等会话前，提示词弹窗内可直接勾选本机已安装的 DSH Skill（支持按名称/描述搜索、多选、点击标签移除）；选中项会以“请加载这些技能”的指令注入到提示词开头，技能正文由 AI 通过 `skill` 工具按需加载。技能目录来自宿主 `skills` 注册表（`GET /api/workbench/skills`），宿主未安装该服务时选择器自动隐藏、行为与旧版完全一致
- **状态聚合**：所有子任务完成后父任务自动完成（递归到根）；直接完成父任务会级联完成后代
- **任务共享记忆**：同一任务/子树下的多个 AI 会话共享上下文，父任务会话自动加载整棵子树记忆，避免跨会话失忆
- **存量修复**：提供 `pnpm repair` / `POST /api/workbench/maintenance/repair-parents` 幂等补齐历史父任务完成状态
- **AI 智能排序（任意日期）**：今日/日历任一日期一键生成执行顺序提案，确认后应用（不修改任务字段）
- **AI 日报/周报**：基于任务事件与完成记录自动生成报告草稿，确认后保存并可回看、删除
- **系统级桌面提醒**：任务到期时在浏览器已授权的情况下发送系统通知（页面可最小化）
- **重复任务**：任务可设置每天/每周/每月重复，到期自动生成实例（模板归档即停止）
- **个人知识库 / 错题集**：经验教训、决策、笔记、片段沉淀为可搜索知识条目，复盘一键沉淀，AI 可提交知识草稿
- **点子文件夹**：点子按「文件夹」组织——AI 可自动关联成文件夹，也能手动新建空文件夹、改名、删除、合并（A 并入 B），并把点子归入/移出一个或多个文件夹（多对多）；「未归类」区收散点子，文件夹可整体转成任务树
- **今日容量**：今日页顶部把当天要做的事按 `estimatedMinutes × 优先级` 摊成一条时间轴，并与你设置的「每天可投入时长」（默认 6.5 小时，点击数字即可改）对比，一眼看出今天塞不塞得下
- **会话标题栏入口**：通过 DSH 官方槽位 `conversation.session.header.actions` 在每个会话标题栏注册「工作台」按钮（切换开关，再点收起）；DSH 侧栏入口同时保留
- **知识库增强（AI 总结本地文档 + 文件链接）**：知识库页面支持弹窗浏览选择本地文件，也可直接填写本地文档路径或 `file://`；后端读取文档内容并让 AI 总结为知识草稿；知识条目可保存 `file_link` 并一键调用系统默认程序打开/追溯本地文件
- **点子 / 点子王**：灵感卡片快速记录；AI 自动找关联生成“点子王”；AI 头脑风暴后可确认转为任务
- **AI 复盘**：已完成任务一键复盘，结论确认后写回任务
- 同一任务只保留一个复盘会话；重复复盘进入同一会话

### 数据与安全
- SQLite（`~/.dsh/workbench/workbench.db`）+ 每日 JSON 备份规划
- 所有工作台 API 均挂载在 `/api/workbench/*` 且仅允许 loopback 访问
- 不读取、不上传 DSH 之外的任何数据

## 安装

### 前置条件

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **0.1.5-rc.1 及以上** Web 版
  （这是硬边界：低于它面板整块不启动，理由见「兼容性与已知限制」）
- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm `>=11.7.0 <12`
- 网络可访问 npm registry（或使用镜像）

> ⚠️ **装完必须重启 `dsh web`，刷新页面不够。**
> 客户端 bundle 由 `dsh-client-modules` 在宿主**启动时**读进内存 Map
> （`bundleResource()` 只查那张 Map），所以"装好了 → 刷新浏览器"拿到的是**旧代码**，
> 连 URL 上的 `rev` 都对不上。同理，升级/回退之后也都要重启。

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add @dely0/dsh-personal-workbench
```

或使用 npm 直接安装到项目：

```sh
npm install @dely0/dsh-personal-workbench
```

### 从 GitHub 安装

```sh
dsh plugin --profile web add git+https://github.com/Dely0/dsh-personal-workbench.git
```

或安装 Release tarball：

```sh
dsh plugin --profile web add file:/path/to/dsh-personal-workbench-<version>.tgz
```

安装后重启 `dsh web`，浏览器硬刷新（Ctrl+Shift+R）。

### 从源码开发

```sh
git clone https://github.com/Dely0/dsh-personal-workbench.git
cd dsh-personal-workbench
pnpm install
pnpm check      # 类型检查 + 构建
pnpm test       # 最小回归测试（使用构建产物）
```

以开发模式挂载：

```sh
pnpm build
dsh plugin --profile web add link:/path/to/dsh-personal-workbench
```

> 开发模式修改代码后需要重新 `pnpm build` 并重启 `dsh web`。

## 兼容性与已知限制

> 滚动维护的**已知问题与待办清单**见 [`docs/issues/2026-09-13-outstanding-issues.md`](docs/issues/2026-09-13-outstanding-issues.md)。
> 本节只讲**当前版本的依赖与支持边界**。历史结论（DOM 降级腿、家族互斥）已随 v1.14.53 删除，
> **别照着旧文档配环境**。

### 一句话依赖结论

| 项 | 要求 | 说明 |
|---|---|---|
| **DSH** | **`0.1.5-rc.1` 及以上**（Web 版） | 低于此版本**客户端面板整块不启动**（刻意如此，见下） |
| Node | `^22.19.0` 或 `>=24.0.0` | 与 `package.json` 的 `engines` 一致 |
| pnpm | `>=11.7.0 <12` | 仅开发/构建时需要 |
| `@deepseek-ai/cordis` | `^4.0.1` | peer 依赖 |
| `@deepseek-ai/dsh-host-webserver` / `dsh-system-prompt` / `dsh-tools` | `^0.1.0-rc.6` | peer 依赖（服务端半边） |
| DSH 提供的客户端槽位 | `sidebar.panellist` + `main` + `shell.overlay` | **三个都要有**，缺一个就不启动 |
| `layout.selectPanel` | 必须有 | 它是"面板能被选中"的唯一开关 |
| `@xmanrui/dsh-im` | 可选 | 微信提醒通道；未装则降级为页内提醒 + 桌面通知 |

**最低支持版本：DSH `0.1.5-rc.1`。** 这一条是硬边界，不是"建议"。

### 低于最低版本会怎样：**明确不启动**（不是降级）

`inject` 精确声明 5 项：`sessions` / `workspaces` / `connection` / `slots` / `layout`
（唯一实现见 `src/client/capabilities.ts`，`test/capabilities.test.mjs` 把它锁死）。
缺任何一项，cordis 会让插件 pending；万一进来了但槽位不全，`apply()` 会打一条
**含"缺什么 + 要求什么版本"的中文日志**后直接返回 —— **不注册任何东西、不写任何 DOM**。

为什么不做兼容层：早先的实现是"探测不到官方槽位就换自建 DOM 腿"，
而那条腿会铺一张 `position:fixed; inset:0` 的**满屏层**，一旦收不起来就永久盖住会话区
（用户原话："除左栏外什么都点不了"）。与其"半死不活地降级"，不如**明确不启动并说明原因**。

> **服务端能力不受此限制**：任务/日历/知识库/点子、提醒、日报周报与 `workbench_*` 工具
> 只需要 `0.1.0-rc.6+`。所以老宿主上你仍能用 AI 侧的工具与提醒，只是**看不到面板界面**。

### 支持的能力矩阵

| 能力 | 需要的 DSH 版本 | 拿不到时 |
|---|---|---|
| 服务端能力：任务/日历/知识库/点子、AI 会话关联、提醒、日报周报、`workbench_*` 工具 | 0.1.0-rc.6+ | — |
| **面板本体：`sidebar.panellist` + `main` + `shell.overlay`** | **0.1.5-rc.1+** | **面板整块不启动**（打可读日志） |
| **`layout.selectPanel`**（面板选中状态由宿主单值状态管理） | **0.1.5-rc.1+** | 同上 |
| 会话标题栏入口（官方槽位 `conversation.session.header.actions`） | 0.1.5-rc.1+ | 无该按钮；侧栏面板行仍可用 |
| 官方 `uiWorkspace.connectWorkspace`（AI 会话切工作区） | 0.1.5-rc.1+ | 回落 `workspaces.openPath` |
| 微信提醒 | 可选插件 `@xmanrui/dsh-im` | 静默降级为页内提醒 + 桌面通知 |
| 技能选择器 | 宿主 `skills` 注册表 | 选择器自动隐藏 |

> 历史说明（仅供对照，**已不适用**）：v1.14.0–v1.14.52 曾支持 DSH `0.1.1-rc.1`，
> 走的是"往侧栏 DOM 注入入口行 + 自建覆盖层"的降级腿。那条腿连同社区
> 「sidebar-entry 家族约定」（`data-dsh-<pkg>-entry` / `dsh-panel-activate` / 摘兄弟
> `data-dsh-*-active`）在 v1.14.53 **整体删除**。定稿设计见
> [`docs/design/2026-09-13-client-architecture-official-only.md`](docs/design/2026-09-13-client-architecture-official-only.md)。

### 唯一的入口与面板路径（v1.14.53 起）

1. **侧栏面板行**注册到官方槽位 `sidebar.panellist`（`kind=list`、`scope=root`）——
   行按钮、Tooltip、`aria-label`/`aria-current`、行高与折叠态圆形**全部由宿主 `PanelRow` 渲染**，
   本插件只提供图标（`WorkbenchPanelIcon`）。
2. **中央面板**注册到官方键槽 `main`，但**只放一个返回 `null` 的空占位** ——
   它存在的唯一理由是让 `layout.selectPanel(id)` 的校验通过。
3. **真内容**注册到 `shell.overlay`（框架级浮层，**始终挂载**）。
   为什么不放 `main`：`main` 是键槽，`activePanelId` 一变宿主就卸载整棵子树，
   而我们这棵树里装着**跨页面常驻的草稿弹框** —— 关面板会连弹框一起消失
   （用户实测"只能回到工作台页面才看得到弹框"）。
4. **面板显隐**只有一个答案：`decidePanel()`（`src/client/panelState.ts`，纯函数 + 表驱动单测）。
   宿主状态可读时只信 `activePanelId`，不可读时才退回本地意图。
   `data-open` 属性由同一个函数派生（`panelDataOpen()`），所以"决策"与"投影"不可能打架。

**没有第二条路径。** 本插件不往宿主侧栏注入任何 DOM（`test/clientInvariants.test.mjs` 的 I6 钉住）。

判定"面板该不该显示"的只有一处实现（`decidePanel()`）；**没有"走哪条路径"的选择逻辑了** ——
`officialSlotDecision()` / `officialPathConfirmed()` 随降级腿一起删除。**能力不满足就明确不启动。**

### 硬规则：可选服务一律软探测

**任何 DSH 服务，只要不是所有受支持版本都有，就必须 `ctx.get('x')` 软探测，绝不放进
`inject`、也绝不直接 `ctx.x`。** cordis 的 `inject` 语义是"缺一个就整个插件 pending"，
把它当成"可选依赖"用会让插件在旧宿主上整体加载失败（前端表现为 `Failed to load plugins`）。

这条规则来自三次真实事故：v1.10.1 的 `uiWorkspace`、v1.13.0 的 `runtime.slots`、
v1.13.3 的再次根治；v1.13.1 的标题栏入口则是因为直接读 `ctx.slots` 而崩。

**边界要分清**：`slots` / `layout` 是**面板功能的前置条件**，
所以它们进 `inject` —— 拿不到就整块不启动（明说原因），而不是偷偷降级；
`uiWorkspace` / `dshIm` / `skills` 是**可选增强**，一律软探测、缺了只是少一个能力。

### 其它

- 入口只有一个：**宿主渲染的侧栏面板行**（`sidebar.panellist`）。会话标题栏按钮同样走官方槽位
  `conversation.session.header.actions`。
- **面板互斥由 DSH 宿主的 `activePanelId` 保证**（`layout.selectPanel` 是单值状态）。
  若同时使用**不使用官方槽位、而以 DOM 接管中栏**的插件（如 `dsh-client-ui-task-board` /
  `dsh-ssh` / `dsh-mnemon`），可能出现两个面板同时激活 ——
  **这是宿主缺少统一面板机制导致的已知限制，不是本插件的缺陷**：那些插件没向宿主注册面板，
  宿主的 `activePanelId` 无从知晓它们存在。因此本插件**不做跨插件 DOM 协调**：
  不读、不写任何兄弟插件的 `data-dsh-*` 属性，也不广播/监听 `dsh-panel-activate`。
  本插件只写两个自带属性（且幂等）：`<html data-dsh-personal-workbench-active>` 与
  `<html style="--wb-sidebar-w: Npx">`；`test/clientInvariants.test.mjs` 的 I4/I5 把这两条钉住。
- 微信提醒依赖 `@xmanrui/dsh-im`：**软探测**（`ctx.get('dshIm')`），未安装或未配置投递目标时静默降级为页内提醒 + 桌面通知，不影响其它功能。
- 技能目录依赖宿主 `skills` 注册表：未安装时 Skill 选择器自动隐藏。
- 仅支持单用户本地使用；无云同步、无多用户权限体系。
- AI 能力依赖你在 DSH 中已配置的模型与凭证；执行/咨询等会真实消耗 token。

## 遗留问题与已知限制

**已知问题、待办与"已确认不是问题"的清单集中在
[`docs/issues/2026-09-13-outstanding-issues.md`](docs/issues/2026-09-13-outstanding-issues.md)**（滚动更新）。
下面只列与本版本最相关的两条：

1. **`.pwtest/` 里有一批脚本是"架构变更前"写的**（约 80 个长期迭代产物）。
   家族互斥与 DOM 降级腿已在 v1.14.53 删除，`verify-mutex-family.mjs` /
   `verify-board-takeover.mjs` / `verify-board-overlap.mjs` / `verify-stable.mjs`
   仍断言那些已删除的行为，**跑起来会失败但那是假失败**，别当成回归。
   `verify-acceptance.mjs` 里示范了正确做法（反转判据 + 写清原因）。
2. **客户端改动必须重启 `dsh web` 才生效** —— 不是"刷新页面即可"。
   `dsh-client-modules` 的 `bundleResource()` 只从宿主**启动时**建好的内存 Map 取 bundle，
   所以改完要走：改版本号 → `pnpm build` → `pnpm pack` → `dsh plugin add <新 tgz>` → 重启。

## 版本历史

> 详细发行说明（含依赖/支持边界、验收证据、踩坑记录）：**[`docs/releases/v1.14.57.md`](docs/releases/v1.14.57.md)**；
> 更早的见 [`docs/releases/`](docs/releases/)。

| 版本 | 要点 |
|---|---|
| **1.14.57** | **架构重构三阶段完成，只支持 DSH 新版（最低 `0.1.5-rc.1`）**：① 抽出 `panelState.ts` —— 面板可见性的**唯一权威源**（原先把同一语义写了 5 遍、读的输入还不同，bug 2/6/9 都出在这里），决策表 5 行穷举并有表驱动单测 + 源码级断言"不许再内联判定"；② **删除 DOM 降级腿与家族互斥**（不再往宿主侧栏注入入口行、不再自建覆盖层容器、不再读写兄弟插件的 `data-dsh-*`、不再广播 `dsh-panel-activate`）——`entryContract.ts` 652→145 行、`index.tsx` 4109→3795 行，新增 I4/I5/I6 源码扫描测试；③ 新增 `capabilities.ts` 能力门槛（`inject` 精确 5 项、缺能力时**明确不启动并打可读日志**，不再"半死不活地降级"），README 写清最低版本与冲突政策。另修：点「回到会话」后弹框要等 5 秒轮询才消失（改为同一帧收掉）。出口判据：`verify-acceptance` 17/17、`verify-final-2` 9/9、`verify-sidebar-collapse` 6/6、`verify-duplicate-task` 11/11 |
| **1.14.51** | 修复「快速录入 → AI 执行 → 验收后，待处理里多出一条**同名重复任务**」：根因是 `withDraftConfirm()` 不校验草稿状态也不记录产出（同一条 task 草稿确认两次就建出两条任务），且 `confirmTaskDraft()` 没有同父同名幂等。现在确认会把产出回写草稿并支持**回放**（同一条草稿绝不会产出两个任务）；跨草稿同名**只告警不静默合并**（新增「库里已经有一条同名任务」选择框：保留两条 / 就用已有那条并归档多建的）；`workbench_submit_task` 在当前会话就是该任务关联会话时直说"几乎肯定是重复录入" |
| **1.14.10** | 修复**在官方 `main` 槽位里自建独立 React root** 引发的连串问题（弹框反复重挂 → 背景一顿一顿变黑、按钮要点两次、`inactive context` 报错、同一构建下部分 App 窗口整片黑）：官方槽位里改为**直接返回 `WorkbenchApp`**、生命周期交给宿主 reconciler（与宿主自带弹框一致）；面板容器改 `position:absolute; inset:0`，不再依赖宿主高度链；新增**可见性自查**（激活时容器持续 0 尺寸就自动切覆盖层）。顺带移除上一版引入的"自愈复核"（它会在注册其实成功时撤销注册，导致侧栏出现两行入口）与 generator 形式的 `slots.inject`（本宿主的 cordis 不支持，注册不生效） |
| **1.14.1** | 修复 1.14.0 本机验收发现的 4 个问题：① 点「工作台」导致会话区**整片空白且回不去**（`entriesOfSlot` 脱绑调用被误判成"宿主不支持" + `selectPanel` 抛错时 `open` 已被置真）—— 改为**自愈判定**：注册表与 DOM 两侧都有证据才走官方槽位，4 秒复核窗口内不成立就撤销注册并回退 DOM 腿，且入口与覆盖层始终就绪，绝不留空白；② 草稿弹框背景变黑/闪烁、点「暂存」要连点 5-8 次（`WorkbenchApp` 被挂了两份互相打架）—— 两种容器严格二选一；③ 快速录入提示文字被输入框遮挡（`.wb-hint` 只有设置页作用域样式）；④ 顶层 `type_code` 非法值被**静默改写成 personal** 而非拒绝（与工具描述、子任务校验口径不一致）—— 改为封闭枚举严格校验 + 回执回显最终落库字段 |
| **1.14.0** | **侧栏入口与中央面板改用 DSH 官方槽位**（`sidebar.panellist` + `main`，互斥交给宿主 `activePanelId`）；**任务支持改父任务**（含防环校验 + 变更留痕 + 表单选择项 + AI 工具，取代直接改库）；**快速录入/澄清支持指定工作区**（默认值与旧隐式行为逐字一致，路径不可用会明确报错而非静默换目录）；**所有草稿类型都可暂存**（白名单改为默认全开）且**草稿弹框信息量补齐**（任务草稿展示描述/截止/预估/工作区/AI 策略/子任务 + 回到会话）；**子任务 code 非法不再静默丢弃**（回传 problems 并在界面标黄，工具描述带封闭枚举）；数据库 schema 过新时**降级空转而不是拖死 DSH 启动** |
| 1.13.4 | 修复：`uiWorkspace` 不再作为硬依赖（旧宿主上不再 `Failed to load plugins`）；数据库 schema 过新时降级而不是拒绝启动 |
| 1.13.1 | 修复会话标题栏入口导致前端加载失败（cordis 服务读取必须用 `ctx.get`）；新增点子「文件夹」（手动建/改名/删除/合并、多对多归入与移出、整体转任务树）；新增「今日容量」条与每天可投入时长设置；UI 视觉层统一（边框/阴影/字号/间距，浅色下保持模块可辨识）；用户入口改用官方槽位 |
| 1.12.1 | 微信草稿通知正文精简（任务标题 + 摘要首行 + 一行操作）；修复 reminder 测试在 Windows 下未关库导致临时目录删除失败 |
| 1.12.0 | 验收「暂存」（草稿保持待确认但不再自动弹窗，可唤回）；驳回/暂存留痕并回传提交历史给 AI；草稿通知接入微信（默认只开验收与复盘） |
| 1.11.0 | Skill 选择器：AI 会话前可勾选本机已安装 Skill，注入「加载这些技能」指令（不内联正文） |
| 1.10.x | 微信任务提醒：通道适配、分级/静默/节流/熔断、补发队列、策略配置界面 |
| 1.9.0 | 工作台 UI 优化 P0-P2（大屏分栏、详情摘要卡与吸顶操作条、变更历史时间线、空状态 CTA） |

## 路线图

- [x] V1：任务 / 日历 / 快速录入澄清 / 子任务 / 会话关联
- [x] V1.5：AI 执行 + 用户验收 / 复盘 / 归档 / 变更历史 / 任务工作区
- [x] V2 每日 AI 智能排序（0.6.0）
- [x] V2：系统级桌面提醒（0.8.0）
- [x] V2 日报/周报（0.7.0）
- [x] V2：重复任务（0.12.0）
- [x] V2：个人知识库 / 错题集（1.0.0）
- [x] V2：知识库增强（AI 总结本地文档 + 文件链接）（1.2.0）
- [x] V2：今日计划面板长列表优化（sticky 统计卡 / 固定高度内部滚动 / 展开收起 / 面板内完成·推迟）（1.4.0）
- [x] V2：AI 会话前自定义提示词输入（除快速录入外，默认提示词 + 用户输入追加）（1.5.0）
- [x] V2：今日/日历计划面板手动编辑（上下移、改备注、从今日任务增删计划项；保留 AI 生成 + 确认 + 完成/推迟）（1.5.0）
- [x] V2：UI 美化（卡片/列表/表单/点子关联展示统一）
- [x] V2：任务类型自定义 UI（设置页字典管理：类型/状态/优先级/点子类型）
- [x] V2：任务到期提醒接入微信（1.10.x）
- [x] V2：Skill 选择器（1.11.0）
- [x] V2：验收暂存 / 驳回反馈闭环 / 草稿通知（1.12.0）
- [x] V2：UI 视觉层重构 + 点子文件夹 + 官方槽位入口（1.13.x）
- [x] V2：提醒状态语义修复（窗口/终态分离 + 重新武装）（1.13.2）
- [x] V2：侧栏入口迁移到官方槽位 + 改父任务 + 草稿暂存推广（1.14.0）
- [ ] 待规划：客户端 `WorkbenchApp` 拆分（施工图见 `docs/design/2026-09-09-client-split-backlog.md`）
- [ ] V2：定时自动化
- [ ] 未来：多端同步、任务拖拽排序、数据导入导出

## 免责声明

本插件为社区项目，与 DeepSeek 官方无关，不提供任何担保。安装即表示你信任该代码会以你的 DSH 用户权限在本机运行。执行类 AI 操作可能修改工作区文件、消耗 API 额度，请先阅读代码并谨慎使用。

## License

本项目代码使用 [MIT License](./LICENSE)。

部分 DOM 挂载模式和客户端构建包装参考了以下开源项目，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)：
- `dsh-task-board`（dsh-web-ui，BSD-3-Clause）
- `dsh-genui`（MIT）

---

# English

## What is this

`dsh-personal-workbench` is a personal workbench plugin for DeepSeek Harness Web:
calendar + hierarchical task list, natural-language task intake with AI clarification,
multiple AI sessions per task (clarify / consult / break down / execute / review),
execution with user acceptance, AI prioritization for any date, daily/weekly reports,
desktop notifications, per-task AI workspaces, reminders, archives, and Markdown reviews.

All task data is stored locally under `~/.dsh/workbench`.

## Install

```sh
# From npm (recommended)
dsh plugin --profile web add @dely0/dsh-personal-workbench

# From source or release tarball
dsh plugin --profile web add git+https://github.com/Dely0/dsh-personal-workbench.git
dsh plugin --profile web add file:/path/to/dsh-personal-workbench-<version>.tgz
```

Then restart `dsh web` and hard-refresh the browser.

## Compatibility

**Minimum: DeepSeek Harness `0.1.5-rc.1` (Web).** This is a hard boundary, not a suggestion.

| Requirement | Version | Notes |
|---|---|---|
| DSH (Web) | **`0.1.5-rc.1`+** | Below this, **the panel does not start at all** (see below) |
| Client slots provided by DSH | `sidebar.panellist` + `main` + `shell.overlay` | **All three** are required |
| `layout.selectPanel` | required | The only switch that can select our panel |
| Node.js | `^22.19.0 \|\| >=24.0.0` | matches `engines` |
| pnpm | `>=11.7.0 <12` | dev/build only |
| `@deepseek-ai/cordis` | `^4.0.1` | peer |
| `@deepseek-ai/dsh-host-webserver`, `dsh-system-prompt`, `dsh-tools` | `^0.1.0-rc.6` | peer (server half) |
| `@xmanrui/dsh-im` | optional | WeChat reminder channel; falls back to in-page + desktop notifications |

### On older hosts the panel **refuses to start** (it does not degrade)

`inject` declares exactly five services — `sessions`, `workspaces`, `connection`, `slots`, `layout`
(see `src/client/capabilities.ts`; `test/capabilities.test.mjs` locks the list). Missing any of them
makes cordis keep the plugin `pending`. If it does load but a slot is missing, `apply()` logs a
**readable reason (what is missing + which version is required)** and returns immediately —
**registering nothing and writing no DOM**.

Why there is no compatibility layer: the old implementation fell back to a self-built DOM leg, which
laid down a full-screen `position:fixed; inset:0` layer. When it failed to collapse it covered the
conversation area permanently (user quote: "nothing outside the left column is clickable").
Refusing to start with a clear log is strictly better than half-working degradation.

> **Server-side features are not gated by this**: tasks/calendar/knowledge/ideas, reminders,
> reports and the `workbench_*` agent tools only need `0.1.0-rc.6+`. On an older host you can still
> use them through the agent — you just get **no panel UI**.

### Panel arbitration & sibling plugins: an explicit "not our problem" policy

- Official slots only: `sidebar.panellist` for the sidebar row, `main` for a null placeholder
  (so `layout.selectPanel` validation passes), `shell.overlay` for the real content —
  it is always mounted, so the draft dialog survives closing the panel.
- Whether the panel is visible is answered in **exactly one place**: `decidePanel()`
  (`src/client/panelState.ts`, a pure function with table-driven tests).
- **No cross-plugin DOM coordination.** Panel arbitration is owned by the host's single-value
  `activePanelId`. Plugins that do *not* use official slots and instead take over the center column
  via DOM (e.g. `dsh-client-ui-task-board`, `dsh-ssh`, `dsh-mnemon`) may end up active at the same
  time. That is a **known limitation caused by the host lacking a unified panel registry**, not a
  defect of this plugin. Accordingly we never read or write another plugin's `data-dsh-*`
  attributes and never dispatch `dsh-panel-activate`. We only write two attributes of our own:
  `<html data-dsh-personal-workbench-active>` and `<html style="--wb-sidebar-w: Npx">`
  (enforced by `test/clientInvariants.test.mjs`, I4/I5/I6).

### Soft-probing (this does not contradict the above)

**Any DSH service that is not present in every supported version must be soft-probed with
`ctx.get(name)` and never listed in `inject`.** The distinction:

- `slots` / `layout` are **preconditions of the panel feature** → they go into `inject`,
  and a missing one means the panel block does not start (with a readable log);
- `uiWorkspace` / `dshIm` / `skills` are **optional enhancements** →
  soft-probed; missing one only removes a feature.

Does **not** depend on `dsh-web-ui`.

## Roadmap

- [x] V2: AI prioritization for any date, OS-level notifications, daily/weekly reports
- [x] V2: recurring tasks, personal knowledge base / lessons, ideas & idea clusters
- [x] V2: Today plan panel long-list optimization (sticky stats / fixed-height inner scroll / expand-collapse / inline complete & defer) (1.4.0)
- [x] V2: Custom prompt input before AI sessions (except quick intake; append user input after the default prompt) (1.5.0)
- [x] V2: Manual editing for today/calendar plan panel (reorder, edit notes, add/remove plan items; keep AI generate + confirm + complete/defer) (1.5.0)
- [x] V2: Official sidebar slots, task re-parenting, defer for every draft kind (1.14.0)
- [x] Official-slots-only architecture: single source of truth for panel visibility, DOM fallback leg removed, capability gate (1.14.57)
- [ ] Future: scheduled automation, multi-device sync, drag-and-drop, import/export

## License

MIT. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
