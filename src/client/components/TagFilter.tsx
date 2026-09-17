/**
 * 标签筛选：**单行**「常用 + 更多▾」。
 *
 * ## 为什么不铺开成一片 chip（用户反馈）
 *
 * 原先所有标签用 `flex-wrap` 铺开、并且**只显示前 12 个**：
 * 标签一多就占掉好几行，而且第 13 个之后的标签**根本点不到**（静默截断，比占空间更糟）。
 * 现在固定一行：常显 N 个高频标签 + 一个「更多」按钮，点开是浮层 —— 里面列出**全部**标签、
 * 可搜索、可多选，已选的高亮。
 *
 * ## 判定在哪
 *
 * 「可见哪几个、还有几个没显示、搜索后剩哪些」都是纯函数（`visibleTags`/`filterTagOptions`），
 * 组件只渲染。菜单开合与搜索词是纯 UI 状态，留在组件内。
 */
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TagCount } from '../listPresentation.js'

/** 单行里最多常显几个标签（含"全部标签"入口之外的部分）。 */
export const VISIBLE_TAG_LIMIT = 6

/** 浮层里列出全部标签时，超过这个数就给搜索框。 */
export const TAG_SEARCH_THRESHOLD = 8

/**
 * 只取前 N 个常显标签。**按传入顺序**（`listPresentation.collectTags` 已按出现次数倒序），
 * 所以"常用"是"出现最多"，不是"字母序"。
 */
export function visibleTags(tagCounts: readonly TagCount[], limit = VISIBLE_TAG_LIMIT): TagCount[] {
  return tagCounts.slice(0, Math.max(0, limit))
}

/** 浮层里的搜索过滤：按子串匹配标签名（大小写不敏感）。 */
export function filterTagOptions(tagCounts: readonly TagCount[], keyword: string): TagCount[] {
  const q = keyword.trim().toLowerCase()
  if (q === '') return tagCounts.slice()
  return tagCounts.filter((t) => t.tag.toLowerCase().includes(q))
}

/**
 * 单行里该显示哪些标签：**已选标签必须常显**，哪怕它不在前 N 个里。
 * 否则用户选了「更多」里的某个标签后，单行上没有它的 chip，会以为没选上（也取消不掉）。
 */
export function pinnedVisibleTags(tagCounts: readonly TagCount[], selected: readonly string[], limit = VISIBLE_TAG_LIMIT): TagCount[] {
  const head = visibleTags(tagCounts, limit)
  const missing = selected
    .filter((tag) => !head.some((t) => t.tag === tag))
    .map((tag) => tagCounts.find((t) => t.tag === tag) ?? { tag, count: 0 })
  return [...head, ...missing]
}

export function TagFilter({ tagCounts, selected, onChange, limit = VISIBLE_TAG_LIMIT }: {
  tagCounts: readonly TagCount[]
  selected: readonly string[]
  onChange: (tags: string[]) => void
  limit?: number
}): JSX.Element | null {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuRect, setMenuRect] = useState<{ left: number; top: number } | null>(null)
  const [keyword, setKeyword] = useState('')

  const shown = useMemo(() => pinnedVisibleTags(tagCounts, selected, limit), [tagCounts, selected, limit])
  const hiddenCount = tagCounts.length - visibleTags(tagCounts, limit).length
  const options = useMemo(() => filterTagOptions(tagCounts, keyword), [tagCounts, keyword])

  if (tagCounts.length === 0) return null

  const toggle = (tag: string): void => {
    onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag])
  }

  const openMenu = (target: HTMLElement): void => {
    const box = target.getBoundingClientRect()
    setMenuRect({ left: box.left, top: box.bottom + 4 })
    setKeyword('')
    setMenuOpen(true)
  }

  const menu = menuOpen && menuRect !== null ? (
    <div className="wb-tagmenu" data-tagmenu style={{ left: menuRect.left, top: menuRect.top }}>
      {tagCounts.length >= TAG_SEARCH_THRESHOLD && (
        <input
          className="wb-tagmenu-search"
          data-tagmenu-search
          type="search"
          placeholder={`搜索 ${tagCounts.length} 个标签`}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          autoFocus
        />
      )}
      <div className="wb-tagmenu-list">
        {options.map((option) => (
          <button
            key={option.tag}
            type="button"
            className={`wb-tagmenu-item ${selected.includes(option.tag) ? 'on' : ''}`}
            data-tagmenu-item={option.tag}
            onClick={() => toggle(option.tag)}
          >
            <span className="wb-tagmenu-check">{selected.includes(option.tag) ? '✓' : ''}</span>
            <span className="wb-tagmenu-name">#{option.tag}</span>
            <span className="wb-tagmenu-cnt">{option.count}</span>
          </button>
        ))}
        {options.length === 0 && <div className="wb-tagmenu-empty">没有匹配的标签</div>}
      </div>
      <div className="wb-tagmenu-foot">
        <button type="button" className="wb-btn" data-tagmenu-clear disabled={selected.length === 0} onClick={() => onChange([])}>清空已选</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="wb-btn" data-tagmenu-close onClick={() => setMenuOpen(false)}>关闭</button>
      </div>
    </div>
  ) : null

  return (
    <>
      <div className="wb-kb-tags" data-tagbar>
        <button type="button" className={`wb-kb-tag ${selected.length === 0 ? 'on' : ''}`} data-kb-tag="" onClick={() => onChange([])}>全部标签</button>
        {shown.map((t) => (
          <button
            key={t.tag}
            type="button"
            className={`wb-kb-tag ${selected.includes(t.tag) ? 'on' : ''}`}
            data-kb-tag={t.tag}
            onClick={() => toggle(t.tag)}
          >
            #{t.tag}<span className="wb-kb-tagcnt">{t.count}</span>
          </button>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            className={`wb-kb-tag wb-kb-tag-more ${menuOpen ? 'on' : ''}`}
            data-tagmore
            title={`还有 ${hiddenCount} 个标签没显示`}
            onClick={(e) => (menuOpen ? setMenuOpen(false) : openMenu(e.currentTarget))}
          >
            更多 +{hiddenCount} ▾
          </button>
        )}
      </div>
      {/* portal 到 body：工具栏在滚动容器里，浮层留在里面会被裁掉（与点子菜单同一套做法） */}
      {menu !== null && (typeof document === 'undefined' ? menu : createPortal(menu, document.body))}
    </>
  )
}
