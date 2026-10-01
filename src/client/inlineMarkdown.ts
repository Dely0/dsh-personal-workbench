/**
 * 行内 markdown 的**解析**（纯函数，产出 token；渲染由组件做）。
 *
 * ## 为什么把解析从组件里搬出来
 *
 * 原来 `MarkdownText.tsx` 的 `renderInline()` 一边扫文本一边直接 `push(<a href=...>)`：
 * 判据与 JSX 缠在一起 → **没法测**。而这次的事故（点链接白屏）恰好就发生在"哪一段文本
 * 会变成锚点"这个判据上：只有把它变成"输入文本 → 输出 token 列表"的纯函数，
 * 才能用 `node --test` 钉住"非 http(s) 的链接**不会**产出可导航 token"。
 *
 * 依赖方向：**只依赖 `externalLink.ts`（链接判据的唯一权威源）**，不依赖 React / DOM。
 * `MarkdownText.tsx` 只负责把 token 映射成 JSX（组件里不再有任何链接判定）。
 */

import { projectLink } from './externalLink.js'

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string; target: '_blank'; rel: string }
  /** 判定为不可点的链接：只当文本渲染（带 tooltip 说明为什么点不了）。 */
  | { type: 'link-inert'; text: string; reason: string; hint: string }

/**
 * 行内元素的正则（与改造前逐字一致，行为不变）：
 * `**粗体**` / `` `代码` `` / `[文本](目标)`。
 */
const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]*\))/g

/**
 * 把一行文本切成 token。
 *
 * 关键不变量：**只有 `projectLink()` 判为 `external` 的链接才会产出 `link` token**；
 * 其余（相对路径 / `//host` / `file:` / `javascript:` / `data:` / `dsh-app:` / `mailto:` …）
 * 一律是 `link-inert` —— 组件因此**不可能**为它们渲染出 `<a href>`。
 */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let last = 0
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const idx = match.index ?? 0
    if (idx > last) tokens.push({ type: 'text', text: text.slice(last, idx) })
    const token = match[0]
    if (token.startsWith('**')) {
      tokens.push({ type: 'strong', text: token.slice(2, -2) })
    } else if (token.startsWith('`')) {
      tokens.push({ type: 'code', text: token.slice(1, -1) })
    } else {
      const parsed = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(token)
      if (parsed === null) {
        tokens.push({ type: 'text', text: token })
      } else {
        const link = projectLink(parsed[2])
        tokens.push(link.kind === 'external'
          ? { type: 'link', text: parsed[1], href: link.href, target: link.target, rel: link.rel }
          : { type: 'link-inert', text: parsed[1], reason: link.because, hint: link.hint })
      }
    }
    last = idx + token.length
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) })
  return tokens
}
