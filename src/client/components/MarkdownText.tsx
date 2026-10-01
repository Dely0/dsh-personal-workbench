/**
 * 极简 Markdown 渲染（标题 / 列表 / 表格 / 引用 / 代码块 / 行内样式）。
 *
 * ## 行内判定已经不在这个文件里（2026-10-01）
 *
 * 行内解析搬去了纯模块 `inlineMarkdown.ts`，链接判据在 `externalLink.ts`：
 * 这里**只做投影**（token → JSX）。原因是真实事故：本组件原先直接渲染
 * `<a href="...">`（没有 target、没有 onClick），点击即**导航宿主文档**，
 * 桌面端（`dsh-app://app/…`）会白屏且不可恢复。规矩因此变成：
 *
 * - **组件里不许出现任何 href 判定**（谁可点由 `parseInline` 决定）；
 * - 唯一允许出现的 `<a>` 的 `href` / `target` / `rel` 全部来自 token
 *   （而 token 来自 `projectLink()` 的规范化结果）；
 * - 点击统一走 `handleExternalLinkClick()`（与宿主 markdown 逐字同构：
 *   未加修饰键的左键 → `preventDefault()` + `window.open(..., '_blank')`）。
 */
import { handleExternalLinkClick } from '../externalLink.js'
import { parseInline, type InlineToken } from '../inlineMarkdown.js'

const LINK_STYLE = { color: 'var(--dsw-alias-state-business-primary,#8fa8c8)' } as const
const CODE_STYLE = { background: 'rgba(127,127,127,.14)', padding: '0 4px', borderRadius: 4 } as const

/** token → JSX（纯投影，无判定）。 */
function renderTokens(tokens: InlineToken[]): (string | JSX.Element)[] {
  return tokens.map((token, index) => {
    if (token.type === 'text') return token.text
    if (token.type === 'strong') return <strong key={index}>{token.text}</strong>
    if (token.type === 'code') return <code key={index} style={CODE_STYLE}>{token.text}</code>
    if (token.type === 'link-inert') {
      // 不可点：**不渲染 href**，只留文本 + 说明为什么点不了（相对路径在桌面端会白屏）
      return <span key={index} style={LINK_STYLE} title={`未在 DSH 内打开：${token.hint}`}>{token.text}</span>
    }
    return (
      <a
        key={index}
        href={token.href}
        target={token.target}
        rel={token.rel}
        style={LINK_STYLE}
        onClick={(event) => {
          handleExternalLinkClick(event, token.href, {
            open: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
          })
        }}
      >
        {token.text}
      </a>
    )
  })
}

function renderInline(text: string): (string | JSX.Element)[] {
  return renderTokens(parseInline(text))
}

export function MarkdownText({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n')
  const blocks: JSX.Element[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let code: string[] = []
  let inCode = false
  let table: string[] = []
  let key = 0
  const renderListItem = (item: string): JSX.Element => {
    const checkbox = /^\[( |x|X)\]\s+(.*)$/.exec(item)
    if (checkbox !== null) {
      return <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, margin: '2px 0' }}><input type="checkbox" readOnly checked={checkbox[1].toLowerCase() === 'x'} style={{ marginTop: 4 }} />{renderInline(checkbox[2])}</label>
    }
    return <span style={{ margin: '2px 0' }}>{renderInline(item)}</span>
  }
  const flushList = () => {
    if (list === null || list.items.length === 0) { list = null; return }
    if (list.ordered) {
      blocks.push(<ol key={key++} style={{ margin: '4px 0 4px 18px', padding: 0 }}>{list.items.map((item, i) => <li key={i}>{renderListItem(item)}</li>)}</ol>)
    } else {
      blocks.push(<ul key={key++} style={{ margin: '4px 0 4px 18px', padding: 0 }}>{list.items.map((item, i) => <li key={i} style={{ listStyleType: /^\[( |x|X)\]\s/.test(item) ? 'none' : undefined }}>{renderListItem(item)}</li>)}</ul>)
    }
    list = null
  }
  const flushCode = () => {
    if (code.length === 0) return
    const codeText = code.join('\n')
    blocks.push(
      <div key={key++} className="wb-code-block">
        <button type="button" className="wb-btn wb-code-copy" onClick={() => { if (navigator.clipboard) void navigator.clipboard.writeText(codeText).catch(() => undefined) }}>复制</button>
        <pre>{codeText}</pre>
      </div>,
    )
    code = []
  }
  const flushTable = () => {
    if (table.length === 0) return
    const rows = table
      .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
      .filter((cells) => cells.length > 0 && cells.some((cell) => cell !== ''))
    const isSeparator = (cells: string[]): boolean => cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
    if (rows.length >= 2 && isSeparator(rows[1])) {
      const header = rows[0] ?? []
      const body = rows.slice(2)
      const border = '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))'
      blocks.push(
        <table key={key++} style={{ borderCollapse: 'collapse', width: '100%', margin: '8px 0', fontSize: 13 }}>
          <thead><tr>{header.map((cell, i) => <th key={i} style={{ border, padding: '4px 8px', textAlign: 'left', background: 'rgba(127,127,127,.10)' }}>{renderInline(cell)}</th>)}</tr></thead>
          <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} style={{ border, padding: '4px 8px' }}>{renderInline(cell)}</td>)}</tr>)}</tbody>
        </table>,
      )
    } else {
      blocks.push(<p key={key++} style={{ margin: '4px 0' }}>{renderInline(table.join('<br/>'))}</p>)
    }
    table = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('```')) { flushList(); flushTable(); if (inCode) { flushCode(); inCode = false } else { code = []; inCode = true } continue }
    if (inCode) { code.push(line); continue }
    if (line.trim().startsWith('|')) { flushList(); table.push(line.trim()); continue }
    if (/^###\s/.test(line)) { flushList(); flushTable(); blocks.push(<h5 key={key++} style={{ margin: '8px 0 4px' }}>{renderInline(line.replace(/^###\s*/, ''))}</h5>); continue }
    if (/^##\s/.test(line)) { flushList(); flushTable(); blocks.push(<h4 key={key++} style={{ margin: '10px 0 4px' }}>{renderInline(line.replace(/^##\s*/, ''))}</h4>); continue }
    if (/^#\s/.test(line)) { flushList(); flushTable(); blocks.push(<h3 key={key++} style={{ margin: '12px 0 4px' }}>{renderInline(line.replace(/^#\s*/, ''))}</h3>); continue }
    if (/^>\s?/.test(line)) { flushList(); flushTable(); flushCode(); blocks.push(<blockquote key={key++} className="wb-blockquote">{renderInline(line.replace(/^>\s?/, ''))}</blockquote>); continue }
    const orderedMatch = /^(\d+)[.)]\s+(.*)$/.exec(line)
    const unorderedMatch = /^[-*]\s+(.*)$/.exec(line)
    if (orderedMatch !== null || unorderedMatch !== null) {
      flushTable(); flushCode()
      const ordered = orderedMatch !== null
      const item = ordered ? orderedMatch[2] : unorderedMatch![1]
      if (list === null || list.ordered !== ordered) flushList()
      if (list === null) list = { ordered, items: [] }
      list.items.push(item)
      continue
    }
    if (line.trim() === '') {
      const next = lines.slice(index + 1).find((l) => l.trim() !== '')
      if (table.length > 0 && next !== undefined && next.trim().startsWith('|')) continue
      flushList(); flushTable(); flushCode(); continue
    }
    flushList(); flushTable(); flushCode()
    blocks.push(<p key={key++} style={{ margin: '4px 0' }}>{renderInline(line)}</p>)
  }
  flushList(); flushTable(); flushCode()
  return <div style={{ lineHeight: 1.7, fontSize: 13 }}>{blocks}</div>
}
