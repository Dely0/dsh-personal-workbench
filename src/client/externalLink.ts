/**
 * 「面板文本里的链接能不能点、点了往哪儿开」—— **唯一权威源**。
 *
 * ## 为什么要单独一个模块（2026-10-01 的真实 P0）
 *
 * 事故：任务描述 / 知识库正文里出现链接时，用户一点就**整个 DSH 白屏**；
 * 桌面端（Electron 0.2.0-rc.2）**完全无法恢复**。
 *
 * 根因不是"链接写错了"，而是**我们的 markdown 渲染是宿主里唯一的例外**：
 * 组件直接渲染 `<a href="...">`（`MarkdownText.tsx`），点击即**导航宿主文档本身**。
 *
 * - **Web 端**：SPA 被导航走 → 页面不可用（重载能回来）。
 * - **桌面端**：文档 URL 是 `dsh-app://app/…`，相对/协议相对/`dsh-app:` 这类 href
 *   解析出来还是 `dsh-app:` 协议 —— 桌面主进程的 `will-navigate` 闸**只拦非 dsh-app 的目标**，
 *   于是导航真的发生了；而 `dsh-app://app/<未知路径>` 会被协议处理器转发给本地 host → 404/空页。
 *   桌面壳没有地址栏/后退，刷新又只是重发同一个坏 URL → **白屏且不可恢复**。
 *
 * 宿主自己（`dsh-web-frontend` 里渲染 markdown 的那个组件）从来不这么干：
 * http(s) 链接一律 `target="_blank" rel="noopener noreferrer"` + `onClick` 里
 * `preventDefault()` 后交给 `openExternalLink`（侧栏浏览器 / `window.open`）。
 * 本模块把这套判据收成**一处**：谁能点、点了开什么、开不了怎么显示，都在这里回答。
 *
 * ## 规矩（改这个文件之前先读）
 *
 * - **纯函数、零 DOM、零 React**：`node --test` 直接测（宿主闸门那种"只有真机才炸"的路径，
 *   在这里必须变成会失败的用例）。
 * - **不判断"页面在哪"**：判据只看 href 本身。相对路径在浏览器里或许能解析成同源地址，
 *   但在桌面端就是 `dsh-app:` —— 我们**一律不许**它变成导航，所以一律判 `inert`。
 * - **外部链接只有一种开法**（`handleExternalLinkClick`）：未加修饰键的左键
 *   → `preventDefault()` + `env.open(url)`；其余（Ctrl/Cmd/Shift/Alt/中键）**交还浏览器**，
 *   由 `target="_blank"` 决定去哪 —— 与宿主逐字同构。
 */

/** 链接判定结果：`external` 才允许渲染成可导航锚点。 */
export type LinkProjection =
  | {
    kind: 'external'
    /** 原始 href（trim 后） */
    raw: string
    /** `new URL()` 规范化后的绝对地址（唯一允许写进 `href` 的值） */
    href: string
    /** 固定 `_blank`：外链永远不开进宿主文档 */
    target: '_blank'
    /** 固定 `noopener noreferrer` */
    rel: string
    because: 'http(s)'
  }
  | {
    kind: 'inert'
    raw: string
    href: ''
    /** 机器可读的判据（测试断言用，稳定） */
    because: string
    /** 给人看的中文说明（tooltip） */
    hint: string
  }

/**
 * `inert` 的 `because` 只有三类固定的：`empty` / `not-absolute` / `credentials`，
 * 以及协议类 `protocol:<scheme>`（方案名来自 `new URL()`，永远小写带冒号）。
 * 测试按"表驱动 + 前缀"断言这套编码，改动这里要让用例一起变。
 */
const HINTS: Record<string, string> = {
  empty: '空链接',
  'not-absolute': '相对路径链接',
  credentials: '含用户名/密码的链接',
  'protocol:file:': '本地文件链接',
  'protocol:javascript:': '脚本链接（已屏蔽）',
  'protocol:data:': '内嵌数据链接（已屏蔽）',
  'protocol:dsh-app:': 'DSH 内部地址',
  'protocol:mailto:': '邮件链接',
}

/**
 * 判定一个 markdown 链接目标。
 *
 * 允许点击的**只有** `http:` / `https:`：这两个协议在 Web 端（新标签）与
 * 桌面端（`setWindowOpenHandler` → `shell.openExternal`，主窗口不动）都有明确出口。
 * 其余一切 —— 相对路径、协议相对（`//host/p`）、`file:`、`javascript:`、`data:`、
 * `dsh-app:`、`mailto:`、带凭据的 http(s) —— 都判 `inert`：
 * 它们没有"不会破坏宿主"的开法，宁可不可点也不要再白屏一次。
 */
export function projectLink(raw: string): LinkProjection {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return inert(text, 'empty')
  let url: URL
  try {
    // 没有 base：相对路径 / 协议相对 / 裸域名一律解析失败 → inert（这正是我们要的）
    url = new URL(text)
  } catch {
    return inert(text, 'not-absolute')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return inert(text, `protocol:${url.protocol}`)
  if (url.username !== '' || url.password !== '') return inert(text, 'credentials')
  return { kind: 'external', raw: text, href: url.href, target: '_blank', rel: 'noopener noreferrer', because: 'http(s)' }
}

function inert(raw: string, because: string): LinkProjection {
  return { kind: 'inert', raw, href: '', because, hint: HINTS[because] ?? '该链接不在 DSH 内打开' }
}

/** 触发一次链接点击所需的最小事件形状（React 的合成事件结构上就是它）。 */
export interface LinkClickEvent {
  button: number
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  preventDefault(): void
}

/** 打开外部链接的出口（由组件注入，便于测试）。 */
export interface LinkOpenEnv {
  open(url: string): unknown
}

export type LinkClickOutcome = 'opened' | 'browser-handled'

/**
 * 处理一次外链点击 —— **外部链接唯一的开法**。
 *
 * 未加修饰键的**左键**：`preventDefault()` 后自己 `open()`。为什么不是"直接放任锚点导航"：
 * 那样宿主文档会被导航走（本次白屏事故）。为什么还要 preventDefault 而不是只靠 `target=_blank`：
 * 与宿主 `dsh-web-frontend` 的链接渲染逐字一致，`href` 因此**永远不会成为导航入口**。
 *
 * 带修饰键 / 非左键：不拦、不开，交还浏览器（新标签语义由 `target="_blank"` 承担）。
 */
export function handleExternalLinkClick(event: LinkClickEvent, href: string, env: LinkOpenEnv): LinkClickOutcome {
  if (event.button !== 0) return 'browser-handled'
  if (event.metaKey === true || event.ctrlKey === true || event.shiftKey === true || event.altKey === true) return 'browser-handled'
  event.preventDefault()
  env.open(href)
  return 'opened'
}
