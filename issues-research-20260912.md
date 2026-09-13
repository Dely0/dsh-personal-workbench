# Dely0/dsh-personal-workbench — Open Issues 调研报告

> 调研重点：核实全部 open issue 的**真实性**（是否属实、是否已修、是否被澄清为非 BUG），并给出可执行的修复计划。

| 项 | 内容 |
|---|---|
| **抓取时间** | **2026-09-12 20:20 (+08:00)**；GitHub API 快照取自同一时刻 |
| **抓取时 open issue 总数** | **3 条**（#1 / #2 / #3），**无 PR、无 milestone** |
| **已关闭 issue 总数** | **0 条**（仓库自创建以来从未关闭过任何 issue） |
| **仓库身份核实** | 本地工作区 `D:\Code\Linksight\dsh-workbench` 的 `origin` = `https://github.com/Dely0/dsh-personal-workbench.git`；GitHub API 返回 `full_name = Dely0/dsh-personal-workbench`，`has_issues = true`、`archived = false` ✅ 与任务目标仓库一致 |
| **代码基线** | `main` = `d39cc3d`（**v1.13.3**，2026-09-11）；工作区干净（仅 1 个未跟踪文件：`docs/issues/2026-09-12-subtask-type-code-silently-dropped.md`） |
| **仓库其他事实** | 24 stars / 8 forks；创建于 2026-08-15；最后 push 2026-09-10；最后 update 2026-09-11 |
| **验证方式** | GitHub REST API（`/issues`、`/issues/{n}`、`/issues/{n}/comments`、`/releases`）+ 本地源码逐行核对 + 本机 DSH 主程序主题包核对 |

### 数据口径说明（重要）

GitHub 的 `updated_at` **不是**「最后更新时间由谁产生」的证明，也不能作为「issue 已处理」的依据。本报告对每条 issue 均按**源码 / Release 证据**判定其真实状态，而非按 API 的 open/closed 或时间戳推断。

---

## 一、结论速览（先回答「是否属实」）

| # | 标题（缩写） | 属实性 | 当前真实状态 | 一句话结论 |
|---|---|---|---|---|
| **#1** | 关联会话显示对话名 + 添加已有对话到任务 | ✅ 属实，但**是功能需求不是 BUG** | **已实现**（v1.10.0，2026-09-05） | 维护者已在评论中说明「V1.10.0 已加上」；issue 未关闭 |
| **#2** | 快速录入出现问题（无工作区能力） | ✅ 报错属实；**用户已自述「好像是我的用法有问题」** | **已修复两次**（v1.10.1 → v1.13.3） | 根因是 DSH 运行时 API 迁移 + 插件把 `uiWorkspace` 写成硬依赖；现已改为软探测。issue 未关闭 |
| **#3** | 侧栏「工作台」入口未纳入 sidebar-entry 家族 | ✅ **属实，且 100% 未修复** | **仍存在**（v1.13.3 代码逐行吻合） | 唯一需要动手改代码的问题 |

**与你记忆的对应关系：**
- 「一个 issue 已经修改了」→ 实际有**两个**：#1（v1.10.0 加功能）与 #2（v1.10.1 + v1.13.3 修 API 兼容）。
- 「一个已经澄清不是 BUG」→ **#2**：报错本身真实，但**不是插件的逻辑错误**，而是 DSH 大版本 API 迁移 + 用户 fork 停在旧版插件；用户自己先说了「好像是我的用法有问题」，维护者随后定位并修复。
- 补充一条你可能没注意的：**#1 也不是 BUG，是功能需求**（enhancement），只是当年被开成了 issue。
- 另外，**这三条 issue 全部处于 open 状态，仓库从未关闭过任何 issue** —— 这是本次调研发现的一个独立问题（见改进点 P1）。

---

## 二、Issue 清单表

抓取时间 2026-09-12 20:20 (+08:00)。时间为北京时间（API 原始值为 UTC，已 +8 换算）。

| # | 标题 | 作者 | 标签 | 打开时间 | 最后更新 | 评论数 | 状态 | 链接 |
|---|---|---|---|---|---|---|---|---|
| **#1** | 能不能更新下关联对话显示对话名？还有添加已有对话到任务里 | lhmhz | **无** | 2026-08-26 09:20 | 2026-09-07 10:38 | **1** | open | https://github.com/Dely0/dsh-personal-workbench/issues/1 |
| **#2** | 快速录入出现问题。 | Guojing6 | **无** | 2026-09-07 23:04 | 2026-09-08 13:52 | **1** | open | https://github.com/Dely0/dsh-personal-workbench/issues/2 |
| **#3** | 侧栏「工作台」入口未纳入统一 sidebar-entry 家族（`[data-dsh-*-entry]`），导致聚焦/激活状态异常 | tujunwenjie | **无** | 2026-09-11 22:03 | 2026-09-11 23:57 | **2** | open | https://github.com/Dely0/dsh-personal-workbench/issues/3 |

> 标签说明：仓库**已定义** 10 个标准标签（`bug` / `enhancement` / `question` / `invalid` / `duplicate` / `documentation` / `accessibility` / `good first issue` / `help wanted` / `wontfix`），但**三条 issue 全都没打标签**。这对后续筛选与自动化是浪费——见改进点 P1。

### 评论明细（全部原样列出，均为维护者/报告人本人）

| # | 评论人 | 时间 | 内容摘要 |
|---|---|---|---|
| #1 | **Dely0**（维护者） | 2026-09-07 10:38 | 「已经在 V1.10.0 版本中加上了该功能」 |
| #2 | **Dely0**（维护者） | 2026-09-08 13:52 | 报错来自 DSH 0.1.2 客户端运行时 API 迁移：`connection.hostDescription` → `connection.generation.host`、`workspaces.connectWorkspace` → `uiWorkspace.connectWorkspace`；旧版插件拿不到工作区能力。**已在插件 v1.10.1 修复并发布**（npm + GitHub Release）。「你的 fork 已基于 v1.10.1，升级后即可正常使用」 |
| #3 | **tujunwenjie**（报告人） | 2026-09-11 22:05 | 「以上 issue 内容是 AI 编辑的，**bug 确认真实**，希望对你修复有帮助」 |
| #3 | **tujunwenjie**（报告人） | 2026-09-11 23:57 | 附**本地修复分支**：fork `tujunwenjie/dsh-personal-workbench` 分支 `fix/sidebar-entry-family`，改动 `src/client/{constants,index,styles}.ts` **+63 / −26**；`tsc --noEmit` 通过、`node --test test/*.mjs` **91 pass / 0 fail**、构建通过；本机 DSH 0.1.5-rc.1 实测 |

---

## 三、逐条核实（附证据）

### #1 — 功能需求，**已实现**，issue 未关闭

**用户诉求（原文全文即标题）：**

> 能不能更新下关联对话显示对话名？还有添加已有对话到任务里

**核实结论：已实现。** 证据——**v1.10.0 Release Notes（2026-09-05）**逐字写明：

> - 任务详情的"关联会话"改为列表形式，**显示 DSH 对话名而不是短 ID**
> - **新增"添加已有对话"**：从当前 DSH 会话列表中选择会话，并选择关联角色

代码侧同样可见：`src/client/index.tsx:373` 调用 `POST /api/workbench/tasks/{id}/sessions` 写入「会话 + 关联角色」；v1.9.0 时关联会话还是「Chip（角色 + 短 ID）」，v1.10.0 改成列表显示对话名——与用户诉求完全对应。

**判定：** 不属于 BUG，属 **enhancement**，功能已交付约 7 天仍挂 open。是一次**漏关**，不是功能缺失。

---

### #2 — 报错属实，但**已澄清 + 已修复**，issue 未关闭

**用户原始描述：**

> 当前 DSH 运行时没有提供工作区能力，请检查插件是否注入 workspaces 关闭。
> **这个好像是我的用法有问题，求解答。**

**核实结论：报错真实；根因不是用户误用，而是 DSH 的破坏性 API 迁移 + 插件把它写成了硬依赖。**

**时间线（三段式，这是本条最有价值的部分）：**

| 阶段 | 版本 | 发生了什么 |
|---|---|---|
| ① 引入回归 | 插件 v1.10.0 及更早 | 客户端 `inject = ['sessions','workspaces','connection','uiWorkspace']`。DSH **0.1.2** 起 `workspaces.connectWorkspace` 被迁移到 `uiWorkspace.connectWorkspace`，于是把 `uiWorkspace` 加进 `inject` 才能用 |
| ② 第一次修复 | **v1.10.1**（2026-09-07） | 对齐 DSH 0.1.2 API：`hostDescription` → `generation.host`、`connectWorkspace` → `uiWorkspace`，inject 追加 `uiWorkspace`。用户报错即停在这一版之前 |
| ③ 真正的根治 | **v1.13.3**（2026-09-10，commit `d39cc3d`） | 发现 ②是**用新硬依赖换旧硬依赖**：`uiWorkspace` 是 DSH **0.1.5-rc.1** 才有的服务，而 cordis 的 `inject` 语义是「缺一个就整个插件 pending」→ 在 DSH 0.1.1-rc.1（如 WSL 测试实例）上直接 `Failed to load plugins / @dely0/dsh-personal-workbench: pending (waiting for service: uiWorkspace)`。现已从 `inject` 移除，改为**软探测** |

**代码证据（当前 `main` = v1.13.3，逐行确认）：**

```
src/client/index.tsx:2346  export const inject = ['sessions', 'workspaces', 'connection']   ← uiWorkspace 已移除
src/client/index.tsx:2376  const uiWorkspace = optionalService<...>(ctx, 'uiWorkspace')      ← 软探测
src/client/index.tsx:2377  if (typeof uiWorkspace?.connectWorkspace === 'function') return await uiWorkspace.connectWorkspace(workspaceId)
src/client/index.tsx:2379  const openPath = runtime?.workspaces?.openPath                      ← 降级路径
src/client/index.tsx:2387  throw new Error('当前 DSH 版本没有可用的工作区切换接口（需要 uiWorkspace 或 workspaces.openPath），请先手动切到任务工作区再发起 AI 会话')
```

v1.13.3 Release Notes 亦明确记录：修复后 WSL 实例（DSH 0.1.1-rc.1）升级启动无告警，`/api/workbench/health` 返回 `1.13.3 / schema 15`；被服务的客户端 bundle 注入数组确认为 `["sessions","workspaces","connection"]`。

**判定：** 用户报错**属实但不属插件逻辑缺陷**——是「DSH 快速迭代破坏性变更 + 插件把可选服务做成硬依赖」的兼容性问题，已被维护者**两次**修复（v1.10.1 对齐新 API、v1.13.3 改为软探测）。用户「好像是我的用法有问题」这一自述，**在结论上是对的**（升级即可解决），但**根因不在用户**。→ 建议按 **question / 已修复** 关闭。

---

### #3 — **BUG 属实，至今未修复**（唯一需要动手的问题）

报告人 `tujunwenjie` 的 issue 写得极完整：环境、现象、复现步骤、根因（**按 v1.13.3 逐行引用**）、期望行为、修复建议。我在本地以 v1.13.3 源码**逐条复核，全部吻合**：

| issue 中的断言 | 本地核实结果 |
|---|---|
| `src/client/index.tsx:2513` 的 `family` 只匹配 `[data-dsh-taskboard-entry], [data-dsh-ssh-entry]` | ✅ **完全一致**（缺 `mnemon`，也不含自身） |
| `:2514` 用 `family[0]` 当 anchor | ✅ **完全一致** |
| `:2487` 只设 `data-dsh-personal-workbench-entry`，无 `data-dsh-plugin` / `data-dsh-part="sidebar-entry"` | ✅ **完全一致**；全仓库 grep `data-dsh-plugin` / `data-dsh-part` / `sidebar-entry` **零命中** |
| 行内是自带 `svg + span.wb-label`，无 `aria-label` / `title` | ✅ **完全一致**（`index.tsx:2488`） |
| `styles.ts:17-23` 是另一套：`height:32px / gap:8px / padding:0 12px`；折叠态靠 `[data-dsh-frame][data-sidebar-collapsed]` + 仅居中 | ✅ **完全一致** |
| `constants.ts:11` `SIBLING_ATTRS` 不含 `data-dsh-mnemon-active`；`styles.ts:14-16` 门控同样缺 Mnemon | ✅ **完全一致**（`['data-dsh-taskboard-active','data-dsh-ssh-active']`） |
| `index.tsx:2529` `onClickSidebarRow` 只认 `sessionRow/projectRow/searchResultRow/searchResultWorkspace/newSession` | ✅ **完全一致**（没有 `[data-dsh-*-entry]`） |
| 修复分支 `fix/sidebar-entry-family` 未合入 | ✅ **未合入**：`main` 自 2026-09-11 起无任何 sidebar-entry 相关提交；仓库无共享核心 `sidebar-entry-core.ts` |

**产生原因（三层，从直接到根本）：**

1. **契约层面的历史债。** 上游 DSH **没有提供侧栏导航的官方 slot**，插件只能往侧栏 DOM 里注入入口（README 第 137 行自己写明：「DSH 侧栏入口仍沿用 **DOM 契约**（`data-pane`、`logoRow`、`centerCol` 等 class）」）。而兄弟插件（dsh-ssh / task-board / skill-explorer / mnemon）之间为了互相识别，**自发形成了一套非正式「家族约定」**：行元素带 `data-dsh-<pkg>-entry`、统一输出 `data-dsh-plugin` + `data-dsh-part="sidebar-entry"` + `aria-label`/`title`、统一行样式与折叠态、用 `dsh-panel-activate` 事件 + `html[data-dsh-<pkg>-active]` 做面板互斥。
2. **本插件当时是独立实现的**（自有 `ENTRY_ATTR` + `.wb-label` + 自有尺寸），**没有加入这套约定**。于是三处后果：皮肤中心按 `[data-dsh-part="sidebar-entry"]` / `[data-dsh-plugin]` 锚定时**永远命中不到这一行**（拿不到统一高亮/聚焦外观）；折叠态形态与同排不一致；**面板互斥协议漏项**。
3. **互斥失效是双方选择器不匹配的必然结果。** 点「工作台」时：本插件广播的 `detail` 是 `personal-workbench` → `dsh-mnemon` 0.5.7 的 `onActivate`（只认 `taskboard` / `ssh`）不认；点击落不进 Mnemon 的 `SIDEBAR_CONTEXT_SELECTOR`；Mnemon 的 MutationObserver 只看 `mnemon/taskboard/ssh` 三个 active 属性，不看 `data-dsh-personal-workbench-active` → **Mnemon 面板不关，两个入口同时高亮，两个面板同时挂在会话列上**。反向（先工作台后 Mnemon）正常，缺的正是这一半协议。

**关键点：这条 issue 的时效性。** 报告人明确说「以上 issue 内容是 AI 编辑的，**bug 确认真实**」，并附了**本地已验证的修复分支**（+63/−26，91 项测试全过）。也就是说：**修复方案已被外部贡献者写好并自测，维护者只需复核 + cherry-pick。**

**一处需要修正的分支说法（我实测的相反结论）：** 该分支的改动 #3 声称 `--dsw-specific-sidebar-nav-item-hover/active` 由皮肤中心计算注入、**没装皮肤中心时未定义**，导致 hover/active 背景整条失效（invalid at computed-value time）。就**本机 DSH 主程序**核对，此说法**不成立**：

- `src/client/styles.ts:19-20` 确实用了这两个 token，且 **`var()` 内没有逗号兜底**（形式上无 fallback）——这一点属实；
- 但这两个 token **由 DSH 自带主题包定义**：`@deepseek-ai/dsh-client-ui-theme/lib/client.js` 中 `body{…}`（浅色）与 `body[data-ds-dark-theme]{…}`（深色）**两个作用域都定义了** `--dsw-specific-sidebar-nav-item-hover` 与 `--dsw-specific-sidebar-nav-item-active`（取值为 `--dsw-static-neutral-bluish-75/100/850/750`），该 bundle 共 2 处定义、覆盖两种主题；
- 全机扫描 `%USERPROFILE%\.dsh`（web profile，9966 个 js/css 文件）**只有工作台插件自己**引用这三个 token，**并未安装皮肤中心**（`@linxin666/*` 与 `dsh-mnemon` 在本机 web profile 中均不存在），而入口样式在此环境下并无声明的失效。

**结论：** 该 token 在标准 DSH 安装下可解析，**「必须装皮肤中心才有高亮」不成立**；改动 #3 属**防御性加固**（加 `var(…, var(--dsw-alias-interactive-bg-hover))` 兜底）是可以做的**低成本好实践**，但**不应作为本 issue 的修复理由**，否则会掩盖真实根因（家族契约缺失）。若要采纳，请按「加固」而非「修 BUG」记录。

**未被本次覆盖：** 本机**未安装** `dsh-mnemon` / `task-board` / `ssh` / 皮肤中心，因此**无法实机复现**「两个入口同时高亮」的现场。报告人已在 DSH 0.1.5-rc.1 上实测并附验证记录；结论以其源码级分析 + 我的源码逐行复核互相印证为准（见第六节局限）。

---

## 四、痛点分类统计

按**用户可感知的痛点**归类（一条 issue 可能贡献多个痛点，故痛点条数 > issue 条数；「频次」= 提及该痛点的 issue 数 / 评论数）。

| 分类 | 痛点 | 频次 | 来源 issue |
|---|---|---|---|
| **Bug** | 侧栏入口未纳入家族契约 → 两个面板同时打开、两个入口同时高亮（**面板互斥失效**） | 1 | **#3** |
| **Bug** | 侧栏入口缺语义属性 → 皮肤/皮肤中心锚定不到，拿不到统一高亮/hover/聚焦外观 | 1 | **#3** |
| **Bug** | 侧栏折叠态形态与同排入口不一致（非 36px 圆形、要求 `[data-dsh-frame]` 祖先） | 1 | **#3** |
| **Bug（兼容性）** | `.wb-label` 自有类名 + 自有尺寸 → 与家族行类名/尺寸/图标槽约定分叉，长期漂移风险 | 1 | **#3** |
| **Bug（兼容性，已修）** | DSH 运行时 API 破坏性迁移 → 插件整体 pending / `Failed to load plugins`（`uiWorkspace` 硬依赖） | 1 | **#2**（+ v1.13.1 的 `runtime.slots` 同类崩溃，属同一族问题，见 Release Notes） |
| **体验问题** | 关联会话只显示短 ID，不显示对话名（可读性差） | 1 | **#1**（v1.10.0 已修） |
| **体验问题** | 无法把**已有**对话关联到任务（只能从任务发起） | 1 | **#1**（v1.10.0 已修） |
| **功能需求** | 关联会话列表化 + 会话选择器 + 关联角色选择 | 1 | **#1** |
| **文档/协作问题** | 侧栏入口依赖 DOM 契约这件事，README 仅一段泛泛提示，**未写明「家族约定」**（`data-dsh-*-entry` / `data-dsh-plugin` / `data-dsh-part` / `dsh-panel-activate` / `*-active` 互斥协议） | 1 | **#3**（根因之一） |
| **文档/协作问题** | 插件与兄弟插件的**互斥协议**没有成文契约，导致各方各自硬编码对方名字（Mnemon 只认 `taskboard`/`ssh`；本插件 `SIBLING_ATTRS` 也只列 taskboard/ssh） | 1 | **#3** |
| **其他（流程）** | **3 条 open issue 中有 2 条实际已解决却未关闭；仓库从未关闭过任何 issue；3 条全无标签** → 公开 backlog 不可信，会持续制造「问题很多」的错觉（本次调研本身就是被这个假象触发的） | 3 | **#1 #2 #3** |

**统计小结（按 issue 主分类，互斥口径）：**

| 主分类 | 条数 | issue |
|---|---|---|
| Bug | **1** | #3（真实存在，待修） |
| 体验问题 | 0（并入 #1 的已交付项） | — |
| 功能需求 | **1** | #1（已实现，待关闭） |
| 文档问题 | 0（作为 #3 的**根因之一**，非独立 issue） | — |
| 其他 / 兼容性澄清 | **1** | #2（已修复两次，待关闭） |

**高频痛点结论：样本量只有 3 条，不存在统计意义上的「高频」。** 唯一有工程价值的痛点是 **#3 的侧栏家族契约缺失**——它一次贡献了 **4 个可感知 Bug**（互斥/皮肤/折叠态/契约漂移），且根因是**跨插件约定缺失**，同类问题必然复发。

---

## 五、改进点建议（含优先级）

排序原则：**影响面（是否影响所有装了兄弟插件的用户）× 实现成本 × 是否阻塞外部贡献**。

### P0 — 合入侧栏入口家族契约（唯一真实 Bug，且方案已就绪）

> **状态：已实施（2026-09-12，本工作区）。** 详见 `docs/issues/2026-09-12-sidebar-entry-family-contract.md`。
> 改动：新增 `src/client/entryContract.ts`（契约常量 + `entryCss()` + 格式驱动的互斥判定）、
> `index.tsx` 入口行补齐语义属性/aria/三段式结构/折叠态同步、`styles.ts` 门控改为动态 blocked 标记；
> 新增 `test/entryContract.test.mjs`（11 项契约守卫）。`pnpm typecheck` 与 `pnpm test`（102 项）通过。
> **待实机验证**：本机未装兄弟插件，「开着 Mnemon 点工作台 → Mnemon 让位」的双向互斥需装齐后复测。

| 项 | 内容 |
|---|---|
| **问题** | #3：入口不在家族内 → 面板互斥失效（两个入口同时高亮）、皮肤锚定不到、折叠态不一致 |
| **影响面** | 中高。凡同时使用 `dsh-mnemon` / task-board / ssh / 皮肤中心的用户必然命中；纯单插件用户不受影响 |
| **实现成本** | **低**。~~外部贡献者已给出可复核分支~~ → **已在本工作区实施完成**（新增 `entryContract.ts`，改动 `src/client/{index.tsx,styles.ts,constants.ts}` + 测试），`pnpm typecheck` 与 `pnpm test`（102 项，原 91 项 + 新增 11 项）通过 |
| **建议动作** | 1) ~~复核 fork 分支或自行实现~~ **已实现**；2) 逐项对齐：输出 `data-dsh-plugin="personal-workbench"` + `data-dsh-part="sidebar-entry"` + `aria-label`/`title`；行样式对齐 `min-height:36px / gap:10px / padding:0 10px` + 折叠态 36px 圆形；互斥**改为属性名格式驱动**（不再列兄弟包名清单）；3) **装齐兄弟插件实机验证双向互斥**（本机当前未装，必须补测）；4) 验证通过后再发 npm / 开 PR |
| **验收** | ①两个方向开面板都只有一个入口高亮；②装了皮肤中心后该行能吃到 `sidebar-entry` 语义覆盖；③折叠态与同排入口视觉一致；④91 项测试 + typecheck + 构建通过 |

### P1 — 清理 issue 跟踪卫生（0 成本、立刻恢复 backlog 可信度）

| 项 | 内容 |
|---|---|
| **问题** | #1、#2 已实际解决仍挂 open；仓库**从未关闭过任何 issue**；3 条全无标签。这会让任何外部读者（包括本次调研）误判项目问题积压 |
| **影响面** | 高（对外信誉 + 后续每次调研的信噪比），成本**极低** |
| **建议动作** | 1) **关闭 #1**（`enhancement`，v1.10.0 已交付，评论已说明）；2) **关闭 #2**（`question`，v1.10.1 + v1.13.3 已修，处置理由引用 Release）；3) 给 #3 打 `bug`（可加 `help wanted`，因为已有外部修复分支）；4) 在 README 或 `CONTRIBUTING` 写明**关闭口径**：功能在 Release Notes 中交付即关闭并与 Release 互链 |
| **验收** | open issue 数 = 1（#3），且带 `bug` 标签；被关闭的 issue 评论里链接到对应 Release |

### P2 — 把「侧栏入口家族约定」写成成文契约（阻断同类问题复发）

| 项 | 内容 |
|---|---|
| **问题** | 根因是**约定只存在于各插件的代码里**：上游无官方 sidebar slot，兄弟插件靠互相硬编码名字识别（Mnemon 只认 `taskboard`/`ssh`；本插件也只列 taskboard/ssh）。#3 正是这条债务的第一次爆雷，任何新插件都会重踩 |
| **影响面** | 中高（跨插件生态），成本**低**（纯文档 + 选择器收敛） |
| **建议动作** | 1) 在 README「兼容性与已知限制」下新增一节，明确列出家族契约：行属性 `data-dsh-<pkg>-entry`、语义属性 `data-dsh-plugin` + `data-dsh-part="sidebar-entry"` + `aria-label`/`title`、行样式与折叠态基线、互斥协议（`dsh-panel-activate` 事件 + `html[data-dsh-<pkg>-active]`）；2) 把选择器**收敛为通用匹配**（如 `[data-dsh-part="sidebar-entry"], [data-dsh-*-entry]`）替代硬编码兄弟包名，避免每次都漏一个新插件；3) 向 dsh-mnemon / skin-center / dsh-ssh 的维护者同步该契约（其 `onActivate` 只认硬编码 detail 是双向互斥的真正卡点） |
| **验收** | README 有该节；代码中不再出现「逐个列举兄弟包名」的清单式选择器；与至少一个兄弟插件维护者确认统一 detail 判定 |

### P3 — 补一条侧栏入口的回归守卫（防漂移）

| 项 | 内容 |
|---|---|
| **问题** | #3 的三处偏离（漏 mnemon、缺语义属性、自有尺寸）**没有任何自动化测试会发现**——现有 91 项测试全是 DOM 之外的数据/工具层 |
| **影响面** | 中，成本**低**。入口是纯 DOM 注入，最容易被后续重构悄悄改坏（v1.13.0 已出过一次 `runtime.slots` 导致前端整体崩溃的先例） |
| **建议动作** | 用 jsdom / 轻量 DOM 快照断言入口行的不变量：①带 `data-dsh-portable` 家族的三个属性（entry 属性 + `data-dsh-plugin` + `data-dsh-part`）；②`SIBLING_ATTRS` 覆盖全部已知兄弟 active 属性；③折叠态下样式规则命中。CI 里随 `pnpm test` 跑 |
| **验收** | 故意删掉任一语义属性时，该测试必须失败 |

### P4 — 兼容性策略与上线前自检（承接 #2 的教训）

| 项 | 内容 |
|---|---|
| **问题** | #2 暴露的模式会复发：DSH 每升级一次，插件就可能在「`inject` 缺服务 → 整个插件 pending」上整体崩掉（同类已发生 3 次：v1.10.1 的 `uiWorkspace`、v1.13.0 的 `runtime.slots`、v1.13.3 的再次根治） |
| **影响面** | 中高（一崩就是「插件完全不加载」），成本**低** |
| **建议动作** | 1) 把 README 的兼容性从「0.1.0-rc.6 及以上」细化为**支持矩阵**（哪些能力需 ≥0.1.5-rc.1）；2) 固化一条硬规则并写进贡献指南：**可选服务一律 `ctx.get('x')` 软探测，绝不 `ctx.x`、绝不放进 `inject`**（v1.13.1 Release Notes 已把它列为经验）；3) 启动时对宿主版本做一次探测，旧宿主只提示降级能力，不让插件整体 pending |
| **验收** | README 有支持矩阵；插件在 DSH 0.1.1-rc.1 与 0.1.5-rc.1 上均能加载（v1.13.3 已满足后者→前者，补回归即可） |

### 建议的落地顺序

```
P1（关闭 #1/#2 + 打标签，10 分钟，立刻恢复 backlog 可信度）
  └─> P0（合入 #3 家族契约：复核已就绪分支 + 补装兄弟插件实机验证双向互斥）
        └─> P3（补入口回归测试，锁住 P0 的不变量）
              └─> P2（把家族契约写进 README，收敛通用选择器，同步兄弟插件）
                    └─> P4（兼容性矩阵 + 「软探测」硬规则）
```

---

## 六、调研局限（务必与结论一并阅读）

1. **只覆盖 open issue。** 仓库当前 **closed issue = 0**，因此本次没有「已关闭 issue 中可能有价值反馈」的遗漏风险；但一旦后续开始关闭 issue，本报告的清单口径即会与仓库现状脱节（抓取时间 2026-09-12 20:20）。
2. **未覆盖 PR 与 Discussions。** 抓取时 **open PR = 0**；本次未检索 Discussions / Wiki / 提交历史里的社区反馈。**注意：外部贡献者 `tujunwenjie` 的修复分支仅存在于其个人 fork，尚未开成 PR**——若后续开了 PR，应并入调研。
3. **未做量化问卷 / 用户访谈。** 痛点的「频次」仅指「提及该问题的 issue 数」，**不等于受影响用户数**。3 条 issue 的样本量**不足以做任何统计推断**，本报告不做「高频痛点」的量化结论。
4. **#3 未在本机实机复现。** 本机 web profile **未安装** `dsh-mnemon` / `@linxin666/dsh-ssh` / `dsh-client-ui-task-board` / `dsh-client-ui-skin-center`，因此「两个入口同时高亮」「皮肤拿不到统一外观」只能依据 ①报告人在 DSH 0.1.5-rc.1 上的实测记录 + ②我对 v1.13.3 源码的逐行复核（**issue 引用的行号与代码内容 100% 吻合**）。实机复现与验收应在装齐兄弟插件的环境补做。
5. **#1、#2 的「已修复」判定基于 Release Notes + 当前源码，未做端到端实机回归。** #2 的 v1.13.3 修复有维护者的 WSL/DSH 0.1.1-rc.1 实测记录支撑，本次未复跑。
6. **「皮肤中心注入 token」这一分支说法只在 DSH 自带主题包上核对。** 我确认 `@deepseek-ai/dsh-client-ui-theme` 定义了 `--dsw-specific-sidebar-nav-item-hover/active`（浅色 `body{}` + 深色 `body[data-ds-dark-theme]{}` 两处），故该 token 在标准安装下可解析；但**未在其他 DSH 发行版/更早版本上验证该 token 是否始终存在**，故仍建议以「加固」名义为 `var()` 补兜底（改动 #3 可取，理由需改写）。
7. **未评估性能与国际化。** 如 `aria-label`/`title` 需跟随 locale 刷新（issue#3 建议项之一），本次未核对 i18n 现状。
8. **只读调研，未改动目标仓库任何代码、未提 PR、未代发 issue。** 本报告为纯本地产物。

---

## 七、各条原始链接

| # | 内容 | 链接 |
|---|---|---|
| **#1** | issue 本体 | https://github.com/Dely0/dsh-personal-workbench/issues/1 |
| #1 | 对应交付版本 v1.10.0（2026-09-05） | https://github.com/Dely0/dsh-personal-workbench/releases/tag/v1.10.0 |
| **#2** | issue 本体 | https://github.com/Dely0/dsh-personal-workbench/issues/2 |
| #2 | 第一次修复 v1.10.1（2026-09-07） | https://github.com/Dely0/dsh-personal-workbench/releases/tag/v1.10.1 |
| #2 | 根治版本 v1.13.3（2026-09-10，commit `d39cc3d`） | https://github.com/Dely0/dsh-personal-workbench/releases/tag/v1.13.3 |
| **#3** | issue 本体 | https://github.com/Dely0/dsh-personal-workbench/issues/3 |
| #3 | 报告人修复分支（fork） | https://github.com/tujunwenjie/dsh-personal-workbench/tree/fix/sidebar-entry-family |
| #3 | 与 `main` 的完整 diff | https://github.com/Dely0/dsh-personal-workbench/compare/main...tujunwenjie:dsh-personal-workbench:fix/sidebar-entry-family |
| 仓库 | 本地工作区同源仓库 | https://github.com/Dely0/dsh-personal-workbench |

### 报告内引用的本地证据（只读）

| 文件 | 作用 |
|---|---|
| `src/client/constants.ts:6-12` | `ENTRY_ATTR` / `SIBLING_ATTRS`（缺 mnemon）/ `ACTIVATE_EVENT` |
| `src/client/index.tsx:2485-2493` | 入口行构造：自有属性、无 `aria-label`/`title` |
| `src/client/index.tsx:2513-2515` | 家族选择器漏项 + `family[0]` 锚点 |
| `src/client/index.tsx:2524-2532` | 互斥监听与 `onClickSidebarRow` 清单 |
| `src/client/index.tsx:2371-2387` | #2 的软探测修复（`inject` 已移除 `uiWorkspace`） |
| `src/client/styles.ts:14-23` | 面板门控（缺 mnemon）+ 入口行自有样式与 token（无兜底） |
| `README.md:133-138` | 「兼容性与已知限制」——侧栏入口依赖 DOM 契约的自述 |
