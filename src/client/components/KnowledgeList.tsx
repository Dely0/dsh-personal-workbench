/**
 * 知识库列表（打样 2 号：密集列表 + 时间分组）。
 *
 * ## 只做渲染
 *
 * 「分到哪个时间组、这一页是哪几条、命中了多少条」全部由 `listPresentation.ts` 判定，
 * 本组件**不再算第二遍**（本项目最大的 bug 类别就是同一个语义被独立计算多次）。
 * 组件里唯一的状态是"展开哪一页"这类纯 UI 选择 —— 而当前页码也是外部传入 + 回传意图。
 *
 * ## 从 index.tsx 抽出来的原因
 *
 * `index.tsx` 已有 4,800+ 行、规范要求"不许再涨，新增 UI 一律进 components/"。
 */
import type { ListGroup } from '../listPresentation.js'
import type { ContentItem, ListPage, SortDir, SortKey, TagCount } from '../listPresentation.js'
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, SORT_OPTIONS } from '../listPresentation.js'
import { ALL, buildTabs, TabBar, toggleTab, type TabItem } from './TabBar.js'
import { TagFilter } from './TagFilter.js'
import { Icon } from './Icon.js'
import { fmtTime } from '../format.js'
import type { Dict } from '../viewTypes.js'

export interface KnowledgeFilters {
  keyword: string
  kinds: readonly string[]
  tags: readonly string[]
  sortKey: SortKey
  sortDir: SortDir
  page: number
  pageSize: number
}

export const EMPTY_KNOWLEDGE_FILTERS: KnowledgeFilters = Object.freeze({
  keyword: '',
  kinds: Object.freeze([ALL]) as readonly string[],
  tags: Object.freeze([]) as readonly string[],
  sortKey: 'updatedAt' as SortKey,
  sortDir: 'desc' as SortDir,
  page: 0,
  pageSize: DEFAULT_PAGE_SIZE,
})

/** 当前选中的分类 code。**唯一**的派生点 —— 页面与工具条都调它，不各自写 `kinds[0] ?? 'all'`。 */
export function selectedKind(filters: KnowledgeFilters): string {
  return filters.kinds[0] ?? ALL
}

/** 「其他」伪分类：字典外的 kindCode 归到这里，`reconcileKnowledgeKinds` 也要认得它。 */
export const OTHER_KIND = 'other'

/**
 * 分类合法性的唯一收口：字典里没有这个分类（被删了 / 旧数据）→ 回「全部」。
 * 返回 `null` 表示不需要改（避免无谓 setState 引起重渲染）。
 *
 * ⚠️ 必须在**拿到字典之后**调用（字典是异步来的）—— 读 localStorage 时判不了。
 * 放在组件模块而不是 `index.tsx` 里，是因为 `index.tsx` 会碰 `window`、`node --test` 导入不了，
 * 判定就没人测得动（"想锁住的行为要搬到纯模块"是本项目的硬规矩）。
 */
export function reconcileKnowledgeKinds(filters: KnowledgeFilters, knownCodes: readonly string[]): KnowledgeFilters | null {
  const current = selectedKind(filters)
  if (current === ALL || current === OTHER_KIND) return null
  /**
   * 字典还没到（空列表）时**什么都不判**。
   *
   * 这一步不能省：bootstrap 是异步的，首屏渲染时字典可能是空的，那时任何分类都"不在字典里"，
   * 一动手就会把用户存下来的分类清成「全部」—— 那是"拿不可读的状态做决策"，比原问题更糟。
   * 只对**读到了字典、且确实不在里面**的分类动手。
   */
  if (knownCodes.length === 0) return null
  if (knownCodes.includes(current)) return null
  return { ...filters, kinds: [ALL], page: 0 }
}

export function knowledgeFilterActive(f: KnowledgeFilters): boolean {
  return f.keyword.trim() !== '' || f.tags.length > 0 || selectedKind(f) !== ALL
}

/**
 * Tab 徽标：`全部` + 每个知识类型 + 「其他」（库里出现了字典外的 kindCode 时不静默丢件）。
 * 拼装逻辑在 `TabBar.buildTabs` —— 与任务页共用一份，不各写一遍。
 */
export function kindTabs(kinds: readonly Dict[], counts: Readonly<Record<string, number>>): TabItem[] {
  return buildTabs(kinds, counts)
}

export function KnowledgeToolbar({ filters, tabs, tagCounts, total, onChange, onClear, onCreate, onSummarizeDoc, busy = false }: {
  filters: KnowledgeFilters
  tabs: readonly TabItem[]
  tagCounts: readonly TagCount[]
  total: number
  onChange: (patch: Partial<KnowledgeFilters>) => void
  onClear: () => void
  onCreate: () => void
  onSummarizeDoc: () => void
  busy?: boolean
}): JSX.Element {
  const sortName = SORT_OPTIONS.find((o) => o.key === filters.sortKey)?.name ?? '更新时间'
  return (
    <>
      {/* 一行：搜索 + 排序 + 命中数左对齐；新建 / AI 总结 / 清空筛选右对齐。
          宽度不够时**缩搜索框**（`.wb-kb-search` 是唯一可缩项），按钮一律 flex:none + nowrap ——
          否则按钮会被压成竖排文字（本项目踩过：缺 flex-shrink/min-width/white-space 三重保护）。
          实测把这行挤爆的主要是「排序」那一组，所以方向按钮**只留箭头**（排序键名在下拉里已有，
          重复一遍白占 ~58px，正好够搜索框）。 */}
      <div className="wb-kb-bar">
        <input
          className="wb-kb-search"
          type="search"
          data-kb-search
          placeholder="搜索标题 / 正文 / 标签"
          value={filters.keyword}
          onChange={(e) => onChange({ keyword: e.target.value, page: 0 })}
        />
        <select
          className="wb-kb-sortkey"
          value={filters.sortKey}
          title="排序键（默认更新时间）"
          onChange={(e) => onChange({ sortKey: e.target.value as SortKey, page: 0 })}
        >
          {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
        </select>
        <button
          type="button"
          className="wb-btn wb-kb-sortdir"
          data-kb-sortdir
          title={`当前按「${sortName}」${filters.sortDir === 'desc' ? '降序' : '升序'}，点击切换`}
          aria-label={`切换排序方向（当前按${sortName}${filters.sortDir === 'desc' ? '降序' : '升序'}）`}
          onClick={() => onChange({ sortDir: filters.sortDir === 'desc' ? 'asc' : 'desc', page: 0 })}
        >
          {filters.sortDir === 'desc' ? '↓' : '↑'}
        </button>
        <span className="wb-kb-hit" data-kb-hit>命中 {total.toLocaleString('zh-CN')} 条</span>
        <span className="wb-kb-spacer" />
        <button type="button" className="wb-btn primary" data-kb-new onClick={onCreate}><Icon name="plus" />新建</button>
        <button type="button" className="wb-btn" data-kb-summarize disabled={busy} onClick={onSummarizeDoc}><Icon name="file" />AI 总结本地文档</button>
        <button type="button" className="wb-btn" disabled={!knowledgeFilterActive(filters)} data-kb-clear onClick={onClear}>清空筛选</button>
      </div>
      <TabBar tabs={tabs} selected={filters.kinds} onSelect={(code, multi) => onChange({ kinds: toggleTab(filters.kinds, code, multi), page: 0 })} ariaLabel="知识库分类" />
      <TagFilter tagCounts={tagCounts} selected={filters.tags} onChange={(tags) => onChange({ tags, page: 0 })} />
    </>
  )
}

/** 状态/类型徽标：与任务列表共用 wb-chip 视觉。 */
function Chip({ dict, code }: { dict: readonly Dict[]; code: string }): JSX.Element {
  const entry = dict.find((d) => d.code === code)
  const color = String(entry?.config.color ?? '#8a9aa8')
  return <span className="wb-kb-chip" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 45%, transparent)` }}>{entry?.name ?? code}</span>
}

function row(entry: ContentItem, dicts: readonly Dict[], selectedId: string | undefined, onOpen: (entry: ContentItem) => void): JSX.Element {
  const classes = ['wb-kb-row']
  if (selectedId === entry.id) classes.push('sel')
  return (
    <div
      key={entry.id}
      className={classes.join(' ')}
      data-kb-row={entry.id}
      onClick={() => onOpen(entry)}
    >
      <span className="wb-kb-dot-sm" style={{ background: String(dicts.find((d) => d.code === entry.kindCode)?.config.color ?? '#8a9aa8') }} />
      <div className="wb-kb-body">
        <div className="wb-kb-title">{entry.title}</div>
        <div className="wb-kb-sum">{entry.body.split('\n')[0]}</div>
        <div className="wb-kb-meta">
          <Chip dict={dicts} code={entry.kindCode} />
          {entry.tags.map((tag) => <span key={tag} className="wb-kb-tg">#{tag}</span>)}
        </div>
      </div>
      <span className="wb-kb-stamp">{fmtTime(entry.updatedAt)}</span>
    </div>
  )
}

export function KnowledgeList({ page, dicts, selectedId, onOpen }: {
  page: ListPage<ContentItem>
  dicts: readonly Dict[]
  selectedId: string | undefined
  onOpen: (entry: ContentItem) => void
}): JSX.Element {
  if (page.total === 0) {
    return (
      <div className="wb-kb-list">
        <div className="wb-empty" data-kb-empty>没有符合条件的知识条目</div>
      </div>
    )
  }
  return (
    <div className="wb-kb-list" data-kb-list>
      {page.groups.map((group: ListGroup<ContentItem>) => (
        <div key={group.name} className="wb-kb-group">
          <div className="wb-kb-ghead" data-kb-group={group.name}>
            {group.name}
            <span className="wb-kb-gcnt">{group.items.length}</span>
            <span className="wb-kb-gline" />
          </div>
          {group.items.map((entry) => row(entry, dicts, selectedId, onOpen))}
        </div>
      ))}
    </div>
  )
}

export function KnowledgePager({ page, pageSize, onPage, onPageSize }: {
  page: ListPage<ContentItem>
  pageSize: number
  onPage: (page: number) => void
  onPageSize: (size: number) => void
}): JSX.Element {
  const around: number[] = []
  for (let p = Math.max(0, page.page - 1); p <= Math.min(page.pageTotal - 1, page.page + 1); p++) around.push(p)
  const btn = (label: string, target: number, disabled: boolean, current = false): JSX.Element => (
    <button key={label} type="button" className={`wb-kb-pnum ${current ? 'on' : ''}`} data-kb-page={target} disabled={disabled} onClick={() => onPage(target)}>{label}</button>
  )
  return (
    <div className="wb-kb-pager" data-kb-pager>
      <span>
        第 {page.total === 0 ? 0 : page.rangeStart + 1}–{page.rangeEnd} 条 / 共 <b>{page.total.toLocaleString('zh-CN')}</b> 条
      </span>
      <span style={{ flex: 1 }} />
      <span className="wb-kb-pages">
        {btn('«', 0, page.page === 0)}
        {btn('‹', page.page - 1, page.page === 0)}
        {around.map((p) => btn(String(p + 1), p, false, p === page.page))}
        {btn('›', page.page + 1, page.page >= page.pageTotal - 1)}
        {btn('»', page.pageTotal - 1, page.page >= page.pageTotal - 1)}
      </span>
      <select className="wb-kb-pagesize" data-kb-pagesize value={pageSize} title="每页条数" onChange={(e) => onPageSize(Number(e.target.value))}>
        {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / 页</option>)}
      </select>
    </div>
  )
}
