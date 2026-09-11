/**
 * 极简 Markdown 渲染（标题 / 列表 / 表格 / 引用 / 代码块 / 行内样式）。
 * 从 index.tsx 原样抽出：草稿弹窗与详情页都要用，且与组件状态无关。
 */
function renderInline(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = []
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]*\))/g
  let last = 0
  for (const match of text.matchAll(regex)) {
    const idx = match.index
    if (idx > last) parts.push(text.slice(last, idx))
    const token = match[0]
    if (token.startsWith('**')) parts.push(<strong key={idx}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) parts.push(<code key={idx} style={{ background: 'rgba(127,127,127,.14)', padding: '0 4px', borderRadius: 4 }}>{token.slice(1, -1)}</code>)
    else {
      const m = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(token)
      if (m !== null) parts.push(<a key={idx} href={m[2]} style={{ color: 'var(--dsw-alias-state-business-primary,#8fa8c8)' }}>{m[1]}</a>)
      else parts.push(token)
    }
    last = idx + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
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
