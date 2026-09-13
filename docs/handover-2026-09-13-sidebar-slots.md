# 交接文档 · 工作台插件侧栏入口与官方槽位收敛

> 写于 2026-09-13。上一个会话上下文被压缩两次，此文档用于**在新会话继续**。
> 所有"实测"结论都标注了验证方式，可直接复跑确认，不必重新推导。
>
> ---
> ## ⚠️ 2026-09-13 后续会话的三处**更正**（原文有误，先看这里）
>
> 后续会话（1.14.45）把本文档列的 5 个问题**全部修完并逐项实测通过**。过程中发现
> 原文有三处会误导判断，已在正文相应位置改正，这里先汇总：
>
> 1. **第 1 节铁律 1「客户端改动浏览器直读磁盘，刷新即生效」—— 不成立。**
>    实测（`.pwtest/which-file-is-served.mjs`、`probe-visual-states.mjs` 的共同结论）：
>    浏览器加载的是 **profile 里 `node_modules` 那份冻结副本**（`~/.dsh/profiles/web/node_modules/@dely0/…/lib/client.js`），
>    **不是**开发树的 `lib/`。所以"改源码 → 构建 → 刷新"**不会**生效。
>    能生效的只有两条路：
>    - 正式：改版本号 → `pnpm build` → `pnpm pack` → `dsh plugin add <新 tgz>`；
>    - 快迭代：把 `lib/` 直接抄进装盘目录再刷新（**不需要重启宿主**，client 是 HTTP 静态资源）。
> 2. **第 2 节「装盘 1.14.43 是旧构建，与当前 lib 不一致」—— 结论反了。**
>    两份 `client.js` 的字节差异只是**压缩器标识符分配不同**（装盘版把
>    `dshWorkbench_entryIcon` 内联成短名后整体左移），语义完全相同。
> 3. **第 7 节把 `verify-final-2.mjs` 当"当前主验收"—— 它当时是恒过的。**
>    该脚本的 `check()` 形参写的是 `(id, name, ok, detail)`，而 9 个调用点全部按
>    `(id, 条件, 说明)` 传参 → `ok` 收到的是说明字符串（永远真值）→ **9/9 恒过**，
>    侧栏明明两行入口它照样报通过。已修正形参顺序，并把 `sidebarRows` 的判据从
>    `textContent === '工作台'` 改成 `aria-label`（见第 8 节第 3 条的同一个坑）。
>    同一形参错位还存在于另外 15 个 `.pwtest/*.mjs`（未逐个修，用它们的结论前先看形参）。
>
> 另外补两条本次新踩到的坑（第 8 节末尾有详述）：
> **`MutationObserver` 的 `attributeFilter: []` 一个回调都不触发**（不是"观察全部"），
> 以及**官方路径下写 `BLOCKED_ATTR` 会让页面卡死**。

---

## 0. 一句话现状

**根因已找到并修好（`inject` 缺声明），但"官方槽位入口 + 入口去重 + 开合对齐"这三件事我一次动了，互相打架，没收敛。**
用户已决定：**回退到可用形态，然后分开一步步修**。当前源码已回退 `lib` 已重建，但**装盘还是旧的那一版（1.14.43），没装新的**。

---

## 1. 环境与铁律（先看，违反会伤到用户）

| 项 | 值 |
|---|---|
| 仓库 | `D:\Code\Linksight\dsh-workbench` |
| profile | `C:\Users\Administrator\.dsh\profiles\web` |
| 宿主进程 | `node ...\@deepseek-ai\dsh\lib\bin.js web --port 3080 --no-open`，启动命令在 `%TEMP%\dsh-server-3080.log` 尾部 |
| token | 同上文件里最后一条 `token=...`（**重启会换**） |
| 隔离调试浏览器 | `.pwtest/cdp.mjs`（零依赖 CDP，Node 24 内置 WebSocket） |

### 铁律

1. **`dsh web` 进程同时是 agent 的宿主** —— 重启它会**掐断当前会话**（agent 自己也会被杀）。所以：
   - **绝不要自己重启**；要重启就让用户做，或明确征得同意；
   - 想验证"需要重启才生效"的改动时，优先用**客户端改动**（client bundle 是浏览器直接读磁盘的，刷新即生效）。
2. **装盘前必做**：改 `package.json` 版本号 → `pnpm build` → `pnpm pack` → `dsh plugin add <新 tgz>`。
   **同版本号的 tgz 会被 pnpm 缓存复用，新代码装不进去**（本次踩过两次）。
   装完必须跑 `node scripts/check-installed-fingerprint.mjs`（应输出"逐文件一致"）。
3. **改 profile 前先备份** `package.json` + `pnpm-lock.yaml`（`~/AGENTS.md` 第 2 节的要求），装完 `node scripts/check-installed-version.mjs` 应为 0。
4. **`cordis.patch.yml` 与 `.dsh-market/state.json` 都管插件启停**，后者优先级更高且被运行中的 DSH 监听（`patchReload: live`）——
   运行中改 `cordis.patch.yml` 会就地重建插件树。改这两处要先停 DSH。

---

## 2. 版本与状态（交接瞬间的准确值）

```
源码 package.json   : 1.14.43
lib/（已重建）      : 含「回退版入口可见性」逻辑，与源码一致
装盘               : 1.14.43（旧构建，与当前 lib 不一致）
运行中宿主          : 1.14.34
```

- **源码 ≠ 装盘**：源码已回退入口可见性逻辑并重建了 `lib`，但没 pack/install。
  下次继续时：**先把版本号提到 1.14.44 → build → pack → install**，才能把你改的东西装上。
- 运行中宿主 1.14.34 **落后装盘 9 个版本**（服务端改动未生效；客户端改动一直是生效的）。

---

## 3. 已修好并验证的（**不要回退这些**）

### 3.1 `inject` 必须声明 `slots` / `layout`（本轮最重要的发现）

```ts
export const inject = ['sessions', 'workspaces', 'connection', 'slots', 'layout']
```

**为什么**：cordis 不允许访问**未声明 inject** 的服务，`ctx.get('layout')` **永远返回 undefined**。
原先只声明三个服务 + 软探测 `slots`/`layout` → 探不到 → 判定"宿主不支持官方槽位" → 静默降级到自建 DOM 腿
→ 那条腿会铺 `position:fixed; inset:0; z-index:55` 的**满屏层**，收不起来就永久盖住会话区
（用户原话："除左栏外什么都点不了"）；同时宿主渲染我们的槽位条目时崩
`TypeError: Cannot read properties of undefined (reading 'subscribe')`。

**参照证据**（用户建议"看别人怎么写"，一句点醒）：
- `dsh-pocket`：`var inject = ["slots", "connection", "layout", "locale", "sessionLogDownload"]` → 它同时用
  `shell.overlay` + `conversation.session.header.actions`，从未出问题；
- `dsh-client-ui-task-board`：**完全不碰官方槽位**，源码注释写明 *external plugins cannot declare slots*，
  改用「DOM 接管 `[class*="centerCol"]` + `<html>` 上的 data 属性切换 + CSS 隐藏会话内容」。

**验证**：`layout=undefined` 告警消失；`slot entry crashed` 消失；`pnpm test` 141 pass。

### 3.2 皮肤被误摘（`data-dsh-wallpaper-active` / `data-dsh-backdrop-active`）

工作台为和兄弟插件互斥会摘 `documentElement` 上的 `data-dsh-*-active`，**误伤了皮肤中心的壁纸标记**
（皮肤中心用 `MutationObserver({attributeFilter:['data-dsh-wallpaper-active']})` 监听它 → 一被摘就卸载壁纸且不恢复）。

**坑中坑**：这条判定写了两份 —— `entryContract.ts` 的 `isSiblingActiveAttribute()` 和
`index.tsx` 里 `retractSiblingPanels()` 的内联副本。我第一次只修了前者，**等于没修**。
现在 `retractSiblingPanels()` 复用 `isSiblingActiveAttribute()`，且后者对这两个属性返回 false。

**验证**：`node .pwtest/probe-skin-break.mjs "<url>"` → 输出「①→②/②→③/①→③ 净变化：无变化」。

### 3.3 其它已修（本次会话较早）

- 复盘写团队记忆**不幂等**（重复确认重复写）→ 已把首次 `reviewId` 记回草稿 payload；
- 工作区路径**无校验**（`Z:\不存在` 静默接受）→ 新增 `src/workspace-check.ts`（WSL↔Windows 互转 + 存在性 + 可写性），
  接入 `confirmTaskDraft` 与 `workbench_submit_task`；
- 草稿弹框改非模态浮卡（右下角，不再全屏遮挡）；
- 单测 141 pass / 0 fail。

---

## 4. 还没修好的（本次交接的**真正任务**）

| # | 问题 | 现象证据 |
|---|---|---|
| 1 | **侧栏出现两个「工作台」入口** | 我们注入的 `button.dshWorkbench_entry`（文本「工作台」）+ 宿主官方行（文本「打开工作台（任务 / 日历 / 知识库 / …）」）同时可见 |
| 2 | **点「返回对话」关不掉面板** | `data-open` 仍为 `"1"`、`hostRect=[1144,861]` |
| 3 | **官方入口行点了不接线** | 用户实测反馈；我未验证到它能开面板 |
| 4 | task-board 的 `_7D6uKa_modalBackdrop`（z=1300）偶现 | 出现在某次收起之后，来源未查 |
| 5 | DOM 降级腿的**家族互斥**未做到 | 用户："taskboard 和工作台的入口的点击没有做到互斥（两个都可以同时被选中）" |

**用户明确的目标形态**（原话）：
> 高版本 DSH 上就用官方槽位的方式，低版本再退回 DOM，DOM 要遵守 `sidebar-entry` 家族约定。

---

## 5. 当前代码是什么形态（接手时先读这三处）

1. **`export const inject = ['sessions','workspaces','connection','slots','layout']`** —— 已修，保留。
2. **面板内容挂在哪**：`slots.inject(OFFICIAL_OVERLAY_SLOT, …)` 注册 `WorkbenchPanelContent`
   → **官方 `shell.overlay`**（`useSelfHostedOverlay` 改为按需，不再强制）。
   `WorkbenchPanelContent` 只依赖模块级句柄的**本地权威状态**（`isLocalOpen` / `isForcedClosed` /
   `subscribe`），**绝不调用宿主注入的 `usePanelInfo`**（那个 store 不可用时调用会崩整个槽位条目）。
3. **入口可见性**：`syncEntryVisibility()` 刚回退成 1.14.42 形态 ——
   `officialRowVisible()` 为真则藏我们自己的行，否则显示。
   （我上一版把它和 `hideRedundantOfficialRow()` 合并成一条"双向兜底"规则，结果和开合逻辑打架，已回退。）

**问题所在**：**三套判据各说各话** ——
入口去重按 DOM 判、面板开合按本地状态判、内容挂官方槽位（由宿主 `activePanelId` 驱动）。
本次失败的根因就是"一次同时改这三者"。

---

## 6. 建议的修复顺序（**一次只做一件，每件都验证**）

### 第 1 步：让**官方路径的开合**正确（先不碰入口去重）

- 目标：点官方侧栏行 → 面板开；点「返回对话」→ 面板关。
- 方向：既然 `layout` 现在可读，**开合以宿主 `activePanelId` 为准**（`layout.selectPanel` +
  `subscribePanelInfo`），本地 `forcedClosed` 仅作为"宿主状态不可读时"的兜底。
- 验证：`node .pwtest/verify-final-2.mjs "<url>"` 的 ④⑤ 两项必须过。
- ⚠️ 只有这一步过了，才做第 2 步。

### 第 2 步：入口去重（**只在第 1 步通过后做**）

- 目标：侧栏**只有一行**「工作台」，且那一行**能开面板**。
- 判据要基于"这一行点了到底能不能开面板"，而不是"它长什么样"。
- 验证：`verify-final-2.mjs` 的 ①（`sidebarVisibleRows === 1`）。

### 第 3 步：DOM 降级腿的家族互斥（低版本宿主）

- 用户要求 DOM 腿遵守 `sidebar-entry` 家族约定（`entryContract.ts` 里已有契约与 11 项不变量测试）。
- 与 task-board 的互斥：注意 **task-board 不用官方槽位**，它靠 DOM 注入 + `<html>` 上的数据属性，
  所以互斥要在 DOM 契约这一层做（`retractSiblingPanels` / `isSiblingPanelActive` 已有基础）。

---

## 7. 验证工具（`.pwtest/`，共 73 个脚本，常用的这几个）

| 脚本 | 用途 |
|---|---|
| `cdp.mjs` | **基础设施**：零依赖 CDP 封装（`launchDebugBrowser({port, headless, appUrl})`、`evaluate`、`clickByText`、`clickAt`、`screenshot`、`consoleLines`、`pageErrors`、`cdp.send/onEvent`） |
| `verify-final-2.mjs` | **当前主验收**（侧栏限定判据）：入口数、开合、遮挡、崩溃、皮肤 |
| `verify-host-constraints.mjs` | 面板链路 + 零遮挡 + 无槽位崩溃（10 项） |
| `probe-skin-break.mjs` | 皮肤属性在开合前后的净变化（应"无变化"） |
| `probe-entry-click.mjs` | 入口是否可见可点、点击命中谁 |
| `verify-ui.mjs` / `verify-draft.mjs` / `verify-no-remount.mjs` | 面板整体 / 弹框行为 / 无重挂（**注意：部分判据写死了"必须 official=true"，在这台宿主上会假阴性，见第 8 节**） |
| `check-review-memory.mjs` | 复盘写记忆 + 幂等（7 项） |
| `check-workspace-guard.mjs` | 工作区路径校验（8 项） |
| `shots-verify.mjs` | **6 步截图流程**（看图验证，别只看数字） |
| `list-sidebar-entries.mjs` | 列侧栏可见入口（判断有无重复行） |

### 跑测试的统一前置

```powershell
cd D:\Code\Linksight\dsh-workbench
$t = (Get-Content "$env:TEMP\dsh-server-3080.log" | Select-String 'token=([A-Za-z0-9_\-]+)' | Select-Object -Last 1).Matches[0].Groups[1].Value
node .pwtest\verify-final-2.mjs "http://127.0.0.1:3080/?token=$t"
```

---

## 8. 本次踩过的坑与铁律（省你时间，别重犯）

1. **同一条语义判定只允许一份实现**。皮肤那次就是因为判定写了两份（`entryContract.ts` + `index.tsx` 内联副本），
   改了 A 忘了 B，排查多花好几轮。
2. **`data-dsh-*-active` 这类"格式即约定"的属性不可靠**：不同插件用它表达完全不同的状态
   （面板激活 / 壁纸激活）。**按格式整片操作别人的 DOM 是高危动作**：漏摘只是可用性问题，误摘会弄坏别人的功能。
3. **标签长短要分清**：`ENTRY_TITLE`（长文案「打开工作台（…）」）与 `ENTRY_LABEL_TEXT`（短标题「工作台」）。
   官方行的 `aria-label` 是**短**的 —— 用长的去查永远查不到（这是我绕很久的坑之一）。
4. **测试脚本本身会过时**：架构一变，旧判据（`.wb-panel-host`、`official=true`）就变成假阴性。
   **每次改架构都要同步改判据**，否则你会被自己写的测试误导。
5. **`elementFromPoint` 会命中 `pointer-events:none` 的元素**：命中 ≠ 用户点不动。
   判断"谁在遮挡"必须同时看 `pointer-events`。
6. **用截图哈希判断"视觉是否恢复"**：同一页面状态拍两次，hash 不同就是没恢复。
   皮肤那次就是靠它确认的（1.27MB 有壁纸 → 60KB 无壁纸）。
7. **别在渲染期间做副作用**：`onUnreadableHostState()` 会 `createRoot().render()`，
   放在渲染期会让整个槽位条目**不渲染**（页面里查不到容器）。副作用一律走 `useEffect`。
8. **别用 `el.click()` 测交互**：React 合成事件对程序化点击响应不可靠，必须用 CDP 真实鼠标事件
   （`browser.clickAt(x, y)`）。这个假阴性我踩过两次。
9. **`/plugins/??…` 那条聚合 URL 会骗你**：调试器里所有脚本的 URL 末段都可能是同一个 `client.js`，
   必须用 `Debugger.scriptParsed` 建立 scriptId→URL 映射，才能确认调用方归属。
10. **`MutationObserver` 的 `attributeFilter: []` = 一个回调都不触发**（2026-09-13 实测，本插件最隐蔽的 bug）。
    `siblingActiveFilter()` 原先 `return []` 并注释"空数组 = 观察全部属性"—— **注释是错的**。
    实测对照（同一页面同时挂四个观察器，只改两个自定义属性）：
    `attributeFilter: []` → **0 次**；省略 → 触发；`['data-probe-x']` → 触发；`undefined` → 触发。
    后果：家族互斥观察器 + 入口行高亮观察器**双双是死代码**，
    用户现象正是"taskboard 和工作台的入口的点击没有做到互斥（两个都可以同时被选中）"。
    探针：`.pwtest/probe-observer-empty-filter.mjs`。修法：返回 `undefined`（并有单测锁死）。
11. **官方路径下写 `BLOCKED_ATTR` 会让页面卡死**（2026-09-13 实测）。
    现象极具迷惑性：**没有 JS 异常、没有 console 输出**，CDP `Runtime.evaluate` 30 秒不返回、
    `Debugger.pause` 只抓到一帧匿名函数（压缩产物读不出归属）。
    二分定位（`.pwtest/probe-bisect-hang2.mjs`，可复跑）：
    回调空操作 ✅ / 只留"关自己" ✅ / 只留 `syncPanelBlocked` ❌ / 加回 `if (officialConfirmed)` 守卫 ✅。
    机制：官方路径下面板显隐由宿主 `activePanelId` 驱动，`BLOCKED_ATTR` 又让 CSS 把同一棵子树
    再关一次 → 两套门控对同一棵子树反复触发样式/布局重算 → 渲染主线程被占满。
    **原代码本来就有这个守卫，是我在 v1.14.45 改造时去掉的** —— 典型的"修一个坏一个"。
12. **别在"页面卡死"时继续读代码**。本轮在这上面绕了好几轮，最后靠**受控实验**（一次只改一处、
    每处都校验"补丁真的改到了"）一次收敛。附带教训：补丁脚必须**校验命中**，
    否则"没改到"会被误读成"改了没用"（第一版六处补丁全部落空，白跑一轮）。
13. **`process.exit` 会吞掉未处理的 Promise 拒绝**：验收脚本的 `finally` 里 `process.exit(failed===0?0:1)`，
    于是任何一步超时/抛错都表现为**静默截断**——控制台只打印到出错前那几项，然后"5/5 通过"、退出码 0。
    **一次真实失败被包装成成功**。修法：显式 `catch` 记录 `fatalError` 并让退出码为 1。

---

## 9. 残留与待办

- **残留物**：`~/.dsh/profiles/probe-nopwb`（我做隔离实验用的 profile 副本，进程句柄未释放删不掉，**可随时手删**）。
  隔离实例（3085 端口）已停止。
- **文档待更新**：`docs/releases/v1.14.0-coverage-and-acceptance.md` 里的验收结论还是分析阶段的，
  没有反映这几轮实测（尤其：子任务 2 的"官方槽位"结论、皮肤那条的真实问题、工作区校验已补齐）。
- **未验证项**：皮肤中心能否覆盖官方侧栏行（原始验收标准之一）；与 dsh-mnemon/ssh 的互斥（本机未装）。
- **task-board**：当前**已启用**且用户反馈正常；`@linxin666/dsh-client-ui-task-board@0.3.20`。
- **`dsh-client-ui-primitives` 在市场里标「已安装，未生效」** —— 已查清：它是普通库（无 `dsh.client` 声明、
  无 host 半边），不进浏览器名单是**预期行为**，与 layout 问题无关。

---

## 10. 团队记忆里已沉淀的（可直接检索）

- `01M2C8EKMB988HYBJCZ60HDWH4` —— **cordis 未声明 inject 的服务 `ctx.get` 拿不到**（本轮最关键结论）
- `01M2C7R63A99518R2VR5QXY5BD` —— 摘 `data-dsh-*-active` 误伤皮肤中心（同判定写两份）
- `01M2BN7C4D2V4A5T9HK02S81FJ` —— z-index 遮挡事故：静默降级导致满屏层盖住整站
- `01M2BJV29QN7TD5W8SEQBPR0PW` —— 草稿「暂存→唤回」幂等（屏蔽集漏撤销时机）
