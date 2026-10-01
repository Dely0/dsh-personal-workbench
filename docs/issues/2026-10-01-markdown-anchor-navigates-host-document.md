# INCIDENT：面板里的链接是真导航 —— Web 端 SPA 被顶走，桌面端白屏且不可恢复

| 项 | 内容 |
|---|---|
| **发生时间** | 2026-10-01（用户实测报告；仅桌面端 DSH **0.2.0-rc.2** 复现白屏） |
| **严重级别** | P0（桌面端**整页白屏且无法恢复**；Web 端页面不可用） |
| **触发动作** | 在工作台面板的文本区（任务描述 / 知识库正文 / 报告 / 点子 …）里**点一个链接** |
| **影响范围** | 客户端渲染层；无写库、无数据损失 |
| **修复位置** | `src/client/externalLink.ts`（新，判据唯一权威源）+ `src/client/inlineMarkdown.ts`（新，行内解析）+ `src/client/components/MarkdownText.tsx`（改为纯投影） |
| **验证** | Web 端 DSH（profile `web`，:3080，独立库 `verify-web.db`）：**同一探针**修复前 3 通过/4 失败、修复后 **12/12 通过**；回归套件 `legacy-acceptance` 18/18、`legacy-duplicate-task` 11/11、`legacy-final-2` 9/9；防回归测试 `test/linkPolicy.test.mjs` 14 条（4 个反向变体实测变红） |

---

## 1. 事故链

```
任务描述里写着 [README.md](https://github.com/.../README.md)
        └─ MarkdownText 直接渲染 <a href="...">（没有 target、没有 onClick）
             └─ 浏览器语义：点击 = 【导航当前文档】
                  ├─ Web 端：宿主文档 = http://127.0.0.1:3080/  → 整个 SPA 被 github.com 顶掉
                  │           （实测：点击后 location.href 变成那个 github 地址，面板 DOM 消失）
                  └─ 桌面端：宿主文档 = dsh-app://app/
                      └─ 主进程 will-navigate 闸只拦「非 dsh-app 协议」的目标
                           └─ 相对 / 协议相对 / dsh-app: 形状的 href 解析后仍是 dsh-app: → 闸不拦
                                └─ protocol.handle 把 dsh-app://app/<非白名单路径> 转发给本地 host
                                     └─ 404/空响应 → 桌面壳没有地址栏/后退，刷新只是重发同一个坏 URL
                                          └─ 白屏，完全无法恢复
```

## 2. 根因：我们的渲染是宿主里**唯一**的例外

宿主自己渲染 markdown 链接时（`dsh-web-frontend` 的链接组件）做的是：

```js
// http(s) 才有 target/onClick；未加修饰键的左键 → preventDefault + openExternalLink(url)
<a href={url} target="_blank" rel="noopener noreferrer" onClick={…}>{label}</a>
```

`openExternalLink` 的实现在插件侧也有等价物（`dsh-client-ui-chat` 的 `conversation.view` inject）：
侧栏浏览器 tab，否则 `window.open(url, '_blank', 'noopener,noreferrer')`。
**宿主从来不把外链当同页导航。** 我们的 `MarkdownText` 是唯一的反例：

```diff
- <a key={idx} href={m[2]} style={…}>{m[1]}</a>
```

这一行在 Web 端表现为"页面不可用、重载能回来"，在桌面端表现为"整页白屏、不可恢复"——
差异只来自**宿主文档的协议**（`http://127.0.0.1:3080/` vs `dsh-app://app/`）与**桌面壳那两道闸的覆盖范围**：

| 环境 | 闸 | 覆盖 | 结果 |
|---|---|---|---|
| Web | 无 | — | 真导航 → SPA 被顶走（重载能回来） |
| 桌面 | `setWindowOpenHandler`（http/https → `shell.openExternal` + deny） | 只覆盖 `window.open` / `target=_blank` | 裸 `<a>` 走不到这里 |
| 桌面 | `will-navigate`（`dsh-app:` 与同源 http 之外一律 preventDefault） | 覆盖 https，**不覆盖 `dsh-app:` 形状** | https 外链会被拦；相对/协议相对/`dsh-app:` 形状绕过去 → 白屏 |

**结论**：不管宿主版本有没有闸、闸覆盖到哪，插件都**不该依赖它**——
Web 端根本没有闸。判据必须是"我们自己不产生导航"。

## 3. 修复

1. **`src/client/externalLink.ts`（新）——判据唯一权威源**：
   - 只有 `http:` / `https:`（且不带用户名密码）判 `external`，给出规范化 `href` + `target="_blank"` + `rel="noopener noreferrer"`；
   - 其余一切（相对路径 / `//host/p` / `file:` / `javascript:` / `data:` / `dsh-app:` / `mailto:`）判 `inert`，**不许带 href**；
   - 点击只有一种开法 `handleExternalLinkClick()`：未加修饰键的左键 → `preventDefault()` + `env.open(url)`（与宿主逐字同构），其余交还浏览器。
2. **`src/client/inlineMarkdown.ts`（新）**：把行内解析从组件里搬出来（`parseInline(text) → token[]`）。
   `inert` 的链接**在解析层就只产出 `link-inert` token** —— 渲染层拿不到 href 可写，这是"结构上不可能"而不是"约定不要"。
3. **`MarkdownText.tsx`**：只剩投影（token → JSX）。唯一那个 `<a>` 的 `href`/`target`/`rel` 全部来自 token。
   `inert` 渲染成不可点的 `<span>`，`title` 说明为什么点不了（例："未在 DSH 内打开：相对路径链接"）。

## 4. 验证（Web 端 DSH 实测）

探针：`scripts/repro/verify-external-link-navigation.mjs`（真浏览器 + 真鼠标事件；自带 buildId 自证）。
**修复前 / 修复后跑的是同一个探针**（旧包 = `dev-69a310f`，新包 = `dev-0d95769`，都装进 profile `web`、重启 :3080）：

| 编号 | 判据 | 修复前（旧包） | 修复后（新包） |
|---|---|---|---|
| LK-0 | 浏览器加载的 buildId == host health 的 buildId | ✅ `wb-09bd61aad71747a2` | ✅ `wb-5da350973e611148`（且 == 盘上构建） |
| LK-1 | 点外链后**主文档地址一字不变** | ❌ `after=https://github.com/…/README.md` | ✅ `after=http://127.0.0.1:3080/` |
| LK-1b | 面板仍活着（`data-open=1`） | ❌ `panelPresent=false` | ✅ |
| LK-2 | 点外链走了 `window.open(<同一个 URL>)` | ❌ `[]` | ✅ |
| LK-3a/b | 相对 / `javascript:` 链接**不是**锚点 | ❌ 3 个锚点 | ✅ 只有 1 个（外链） |
| LK-3c | 点这两个文本块：无导航、无新的 `window.open` | —（页面已不在，探针中断） | ✅ ×2 |
| LK-5 | 粗体/行内代码/复选框/表格/引用/代码块/标题仍渲染 | — | ✅ |
| LK-4 | 无页面级 JS 异常 | — | ✅ |

汇总：修复前 `{"passed":3,"failed":4,"total":7}`（探针在页面被顶走后中断）；修复后 `{"passed":12,"failed":0,"total":12}`。
回归套件（同一实例、同一轮）：`legacy-acceptance` 18/18、`legacy-duplicate-task` 11/11、`legacy-final-2` 9/9，全 `status:"pass"`。

产物：`test-results/link-navigation/{RED-baseline,GREEN-after-fix}/`（JSON + 截图 + 套件证据）。

> 修复前那张 `RED-baseline/02-after-external-click.png` **本身就是一张纯白屏**（5.6 KB、1424×861 全白）——
> 点击后宿主文档被顶走、面板 DOM 消失，正是用户描述的形态；修复后同一张截图里面板与内容都还在。
> 证据树里**查不到本次实例的 token**（用真 token 串全树扫过，0 命中；探针落盘的地址一律先抹掉 `?token=` 的值）。

> ⚠️ **诚实的范围说明**：桌面端白屏**没有**在桌面端本体上直接复现（重启桌面壳=掐断用户正在用的会话，本轮不允许）。
> 桌面侧的结论来自 `resources/app.asar` 里 `lib/main.js` 的**逐行阅读**（`will-navigate` 闸 L11171-11178、
> `setWindowOpenHandler` L11109-11112、`protocol.handle` 转发 L11542-11551，另实测 host 对未知路径返回 404）
> ＋ 在 Web 端复现的**同一类真导航**。修复不依赖任何宿主闸门，因此两端同时归零；桌面端仍建议由用户重开应用后手点一次确认。
>
> 探针判据的**上限**也要写清：LK-2 把 `window.open` 打了桩，只证明"点击调用了 `window.open` 且 URL 正确"，
> **不证明新标签真的开出来**；`target="_blank"` 是另一条腿（DOM 里已断言）。

## 5. 防回归（政策 = 会失败的测试）

`test/linkPolicy.test.mjs`（`pnpm test` 内，**14 条**）：

- `projectLink` 判据表：4 类 external + 15 类 inert（含 `dsh-app://app/README.md`、`//host/x`、`../docs/a.md`）；
- `parseInline` 表驱动：`inert` 链接**不产出 `link` token**；原有粗体/代码/未闭合行为不变；
- `handleExternalLinkClick`：未加修饰键左键 → `preventDefault` + `open`；Ctrl/Cmd/Shift/Alt/中键/右键 → 交还浏览器；
- **源码扫描（结构性，不是"枚举写法"）**：
  1. 协议判定（`.protocol` / http(s) 字面量 / `/^https?/` / `startsWith('http…')`）只允许在 `externalLink.ts`；
  2. 全仓 `<a>` **只有** `MarkdownText.tsx` 一处，标签用**括号感知**的方式取出来（`<a[^>]*>` 会被 `onClick={(e) => …}` 里的 `>` 截断）；
     标签里必须有 `href={token.href}` / `target={token.target}` / `rel={token.rel}`，**且不许出现属性展开 `{...`**；
  3. `href=` 的值只允许是 `{token.href}`；且不许把属性名写成字符串（`'href={token.href}'` 这种"喂饱 includes 断言"的诱饵）；
  4. `'a'` / `"a"` / `` `a` `` 不许作为字面量出现（动态标签名 `<AnchorTag/>`、`createElement('a')`、`jsx(`a`)` 都靠它兜住）；
  5. 不许出现 `location.href =` / `window.location` / `location.assign(` / `location.replace(` / `history.pushState|replaceState` /
     `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `dangerouslySetInnerHTML` / `document.write(`；
  6. 行内解析不许留在组件里（`renderInline` 只能委派 `parseInline`，不得自己 `matchAll`/`.exec`）；
  7. **产物新鲜度**：`lib/client/externalLink.js`、`lib/client/inlineMarkdown.js`、`lib/client.js` 比对应 src 旧就报红
     —— 单测读 `lib/`、探针验部署产物，"改完没重建"的绿是假绿；另断言 bundle 里真的有修复文案与唯一开法。

**反向验证（装回去必须变红）**：

| 装回的 bug | 结果 |
|---|---|
| `MarkdownText` 换回裸 `<a href={m[2]}>` | ✅ 扫描变红（`href={m[2]}` 不在白名单） |
| `projectLink` 放宽成"相对路径也可点" | ✅ L1/L2 共 3 条变红（需重建 lib —— 单测读的是 `lib/`） |
| **变体 B3**：`const AnchorTag: any = 'a'` + `<AnchorTag {...{href: raw}}/>`（审查者构造的绕过） | ✅ 2 条变红（`a` 字面量 + 行内解析不许留在组件里） |
| **变体 B2**：复用唯一那个 `<a>`、属性改 `{...anchorProps(token)}`、再放一行 `'href={token.href} …'` 诱饵 | ✅ 3 条变红（属性展开/缺 href + 把属性名写成字符串 + bundle 里修复文案消失） |

> **这一节被独立审查（fresh-eyes）打回来重写过一次，教训值得留着**：
> 初版是"枚举几种已知写法 + 断言文件里含有某串文本"。审查者只加了三处就让**10 条全绿、
> P0 原样复活**（就是上表的 B2 / B3）。改成结构性判据 + 产物新鲜度之后，两个变体都被抓住。
> 另一条教训是探针自己的口径：`LK-3c` 原本比 `window.__linkProbe.opened.length === 0`（累计值），
> 外链那一步已 push 1 条 → 把"产品是对的"判成红。**反向验证要同时验产品和验探针。**

## 6. 未覆盖 / 待办

- **桌面端实测**：需用户在桌面端装上新构建并**重开应用**后手点一次（本轮不动桌面实例）。
- **发布链**：本修复随下一个版本发布（桌面端跑的是已发布的 1.15.8，**在发布+重装前仍有此 bug**）。
- **`file://` 链接**：现在渲染为不可点文本（原先点了也只是被 Electron 拦掉、什么都不会发生）。
  若将来要支持"点本地文件链接打开文档"，应当走宿主能力（`workspaces.openPath` / 侧栏资源）而不是 `href`。
- **`mailto:` 链接**：同样变成不可点文本。桌面端原本就是死路（`will-navigate` 拦掉、且非 http/https 不会
  `openExternal`）；**Web 端原本会交给系统邮件客户端**，这一点本轮**没有实测**（无法验 OS 关联），属已知的行为变更。
- **弹窗被拦时无提示**：`handleExternalLinkClick` 不看 `window.open()` 的返回值 —— 这是**刻意与宿主保持一致**
  （宿主自己的 markdown 链接同样不处理被拦，见 `dsh-client-ui-chat` 的 `openExternalLink`）。
  要改进的话应当**两处一起**改成"被拦则复制链接 + 提示"，否则又是"同一语义两处实现"。

## 7. 独立审查（fresh-eyes）与处置

改完之后由一个**不带本会话上下文的子 agent** 做只读审查（给它的约束：不改仓库文件、不装插件、不重启实例、
要验证就在 `%TEMP%` 的副本里改、每条发现必须带"位置 + 复现命令 + 实测输出"）。它**逐行核对**了桌面壳三道闸、
用真 token 之外的独立方法复核了证据链，并构造了两个能绕过防回归扫描的变体（B2 / B3）。
处置：

| 审查发现 | 处置 |
|---|---|
| 源码扫描只是"枚举写法"的黑名单，B2/B3 两个变体 10/10 全绿却复活 P0（**中**） | **已修**：扫描改成结构性判据（括号感知取标签 + 禁止属性展开/动态标签名/字符串诱饵），见 §5；两个变体现在实测变红 |
| 单测读 `lib/`、扫描读 `src/`，"改了 src 没重建"会得到假绿（低） | **已修**：加"产物新鲜度"两条断言（lib 旧于 src 就报红 + bundle 必须含修复文案） |
| 文档 §5 数字与代码不符、漏列新增守卫（低） | **已修**：本条文档（inert 15 类、14 条测试、7 类扫描） |
| "真实 buildId 的实例"探针自身不校验（低） | **已修**：探针新增 LK-0（DOM buildId == health buildId，并记录与盘上构建是否一致） |
| `mailto:` 变不可点是用户可见变更，§6 没列（低） | **已修**：写入 §6，并标明"Web 端原本会交给邮件客户端"未实测 |
| 探针落盘 `location.href` 是 token 泄漏单点（低） | **已修**：落盘一律走 `LOCATION_KEY`（只抹 `?token=` 的值，保留 origin/path），并复扫证据树 0 命中 |
| LK-2 打桩，不证明新标签真开出来 | 属**探针上限**，已写进 §4 的范围说明（不假装覆盖） |
