/**
 * 知识库 / 点子卡片列表的展示判定（**唯一权威源**）。
 *
 * ## 为什么单独一个文件
 *
 * 「哪些条目可见、分到哪个时间组、这一页是哪几条」如果散在组件里，就是本项目最大的 bug 类别
 * ——**同一个语义被独立计算多次**（同类记录见 `panelState.ts` 开头）。所以这里只做纯计算，
 * 组件只负责把结果渲染出来。
 *
 * ## 硬约束
 *
 * - **不 import React、不碰 DOM、不读 `document` / `localStorage`** → 可被 `node --test` 直接测。
 * - 时间以**注入的 `now` 毫秒**为准，不调 `Date.now()`（否则测试会随"今天"漂移）。
 * - 分组/分页的边界全部在这里定义，组件不得再算第二遍。
 *
 * ## 一条业务判断：时间分组必须自适应
 *
 * 真实数据里条目常挤在同一天（本机知识库 59 条有 49 条是同一天），硬分组会出现
 * 「今天 1 / 本周 0 / 本月 58」这种稀疏组头。所以：**条目数 < `MIN_GROUP` 的组并回下一组**。
 * 数据少时看起来是「本月 53 / 更早 6」，不浪费行高。
 */

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 列表条目需要的最小形状（知识库条目与点子都满足）。 */
export interface PresentableItem {
  id: string
  title: string
  /** 关键词命中范围之一（知识库正文 / 点子内容）。 */
  body: string
  /** 关键词命中范围之一（标签）。 */
  tags: readonly string[]
  /** 排序与分组的依据时间（ISO8601）。 */
  updatedAt: string
  /** 仅用于「创建时间」排序；缺省时该项落到稳定兜底。 */
  createdAt?: string
}

/**
 * 知识库条目与点子**共用**的展示形状：两者字段一致（`contentMd` → `body`），
 * 所以不再各写一个适配函数 —— 同一个语义两处实现正是本项目最大的 bug 类别。
 */
export interface ContentItem extends PresentableItem {
  kindCode: string
  createdAt: string
}

export interface TagCount { tag: string; count: number }

export type SortKey = 'updatedAt' | 'createdAt' | 'title'
export type SortDir = 'asc' | 'desc'

export interface SortOption { key: SortKey; name: string }

/** 可用排序键；**第一项是默认键**（更新时间倒序，验收要求）。 */
export const SORT_OPTIONS: readonly SortOption[] = Object.freeze([
  { key: 'updatedAt', name: '更新时间' },
  { key: 'createdAt', name: '创建时间' },
  { key: 'title', name: '标题' },
])

export const DEFAULT_SORT_KEY: SortKey = 'updatedAt'
/** 默认方向：更新时间倒序（与验收要求一致）。 */
export const DEFAULT_SORT_DIR: SortDir = 'desc'

/** 每页条数档位。**默认 10**（用户要求）：列表区一屏约 7 行，10 条最接近"一屏看完、少滚"。 */
export const PAGE_SIZES: readonly number[] = Object.freeze([10, 20, 50, 100])
export const DEFAULT_PAGE_SIZE = 10

/** 少于这个条数的组不单独占一行组头，并回下一组。 */
export const MIN_GROUP = 6

/**
 * 时间分组档位（从新到旧）。判定用"天数差"，边界**只在这里写一次**。
 */
export const GROUP_TIERS: readonly string[] = Object.freeze(['今天', '本周', '本月', '近三个月', '一年内', '更早'])

const DAY = 86400000

/** 条目落在哪个时间档（导出供测试与组件共用，避免两处写边界）。 */
export function groupTierOf(updatedAt: string, now: number): string {
  const t = Date.parse(updatedAt)
  if (Number.isNaN(t)) return GROUP_TIERS[GROUP_TIERS.length - 1]
  const days = (now - t) / DAY
  if (days < 1) return '今天'
  if (days < 7) return '本周'
  if (days < 31) return '本月'
  if (days < 90) return '近三个月'
  if (days < 365) return '一年内'
  return '更早'
}

/* ------------------------------------------------------------------ *
 * 输入 / 输出
 * ------------------------------------------------------------------ */

export interface ListQuery {
  /** Tab / 类型筛选：'all' 或具体 code；判据由调用方给出（`tabOf`），本模块不猜字段名。 */
  tab: string
  keyword: string
  /** 选中的标签（同维度 OR）。 */
  tags: readonly string[]
  sortKey: SortKey
  sortDir: SortDir
  /** 0 起。 */
  page: number
  pageSize: number
}

export interface ListGroup<T> { name: string; items: T[] }

export interface ListPage<T> {
  /** 当前页的条目（排序 + 分组后，已按组拆好）。 */
  groups: ListGroup<T>[]
  /** 当前页条目数（所有组相加）。 */
  pageCount: number
  /** 命中总数（**不受分页限制**）。 */
  total: number
  /** 页码总数（至少 1）。 */
  pageTotal: number
  /** 归一化后的当前页（0 起，已夹在合法范围）。 */
  page: number
  /** 当前页在全集里的下标区间，左闭右开 —— 用于显示"第 x–y 条"。 */
  rangeStart: number
  rangeEnd: number
  /** 从当前命中集里现算的标签（按出现次数倒序），供 chip 使用。 */
  tagCounts: TagCount[]
  /** 每个 Tab 的命中数（**不受当前 tab 限制**，其余条件生效）——用于 Tab 徽标。 */
  tabCounts: Readonly<Record<string, number>>
}

/* ------------------------------------------------------------------ *
 * 归一化（持久化 / 外部传入的值都不可信）
 * ------------------------------------------------------------------ */

export function normalizeSortKey(raw: unknown): SortKey {
  return SORT_OPTIONS.some((o) => o.key === raw) ? raw as SortKey : DEFAULT_SORT_KEY
}

export function normalizeSortDir(raw: unknown): SortDir {
  return raw === 'asc' || raw === 'desc' ? raw : DEFAULT_SORT_DIR
}

export function normalizePageSize(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : raw
  return PAGE_SIZES.includes(n as number) ? n as number : DEFAULT_PAGE_SIZE
}

export function normalizePage(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : raw
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n as number)) : 0
}

/* ------------------------------------------------------------------ *
 * 搜索 / 筛选
 * ------------------------------------------------------------------ */

/** 关键词命中范围：标题 + 正文 + 标签（大小写不敏感）。 */
export function matchesKeyword(item: PresentableItem, keyword: string): boolean {
  const q = keyword.trim().toLowerCase()
  if (q === '') return true
  return `${item.title}\n${item.body}\n${item.tags.join(' ')}`.toLowerCase().includes(q)
}

/**
 * 标签的唯一归一化口径。
 *
 * 为什么必须统一：`collectTags` 用 trim 后的键做成 chip，而 `matchesTags` 若按原值比较，
 * 一个 `"踩坑 "`（写入端不 trim —— `src/api/routes/knowledge.ts` 只过滤类型）就会变成
 * **看得见、点得动、点下去 0 条**的 chip。两侧都走这个函数，就不可能不一致。
 */
export function normalizeTag(tag: string): string {
  return tag.trim()
}

/** 标签筛选：同维度 OR（空选 = 全放行）。两侧都用 `normalizeTag` 后的值比较。 */
export function matchesTags(item: PresentableItem, selected: readonly string[]): boolean {
  if (selected.length === 0) return true
  const owned = item.tags.map(normalizeTag)
  return selected.some((tag) => owned.includes(normalizeTag(tag)))
}

/** 从条目里现算标签及出现次数，按次数倒序、同次数按名字 —— 选项不依赖任何字典。 */
export function collectTags(items: readonly PresentableItem[]): TagCount[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const raw of item.tags) {
      const key = normalizeTag(raw)
      if (key === '') continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return Array.from(counts, ([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'))
}

/* ------------------------------------------------------------------ *
 * 排序
 * ------------------------------------------------------------------ */

function timeOf(raw: string): number | null {
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : t
}

/**
 * 排序一次就建一个"时间戳缓存"。
 *
 * 为什么必须缓存：`Array.prototype.sort` 的比较次数是 O(n log n)，每次比较都 `Date.parse`
 * 一个 ISO 字符串的话，3,000 条要解析上万次 —— 实测 P95 从 6.9ms 降到 1.3ms（5 倍），
 * 而这条路径**每次敲字**都会走。缓存只在单次排序内有效，不跨渲染留状态。
 */
function makeTimeReader(): (raw: string) => number | null {
  const cache = new Map<string, number | null>()
  return (raw) => {
    const hit = cache.get(raw)
    if (hit !== undefined) return hit
    const parsed = timeOf(raw)
    cache.set(raw, parsed)
    return parsed
  }
}

export function compareItems(a: PresentableItem, b: PresentableItem, key: SortKey, dir: SortDir): number {
  return compareWithReader(a, b, key, dir, makeTimeReader())
}

function compareWithReader(a: PresentableItem, b: PresentableItem, key: SortKey, dir: SortDir, readTime: (raw: string) => number | null): number {
  const factor = dir === 'asc' ? 1 : -1
  if (key === 'title') {
    const diff = a.title.localeCompare(b.title, 'zh-Hans-CN')
    if (diff !== 0) return diff * factor
  } else {
    // ⚠️ 括号不能省：`key === 'x' ? a.x : a.y ?? ''` 里 `??` 会绑到整个三元式上，
    // 于是两边都读同一个对象的字段（"按创建时间排序"退化成按 id 排）。这条是复审 F2 之后
    // 补的整链顺序断言抓出来的。
    const at = readTime((key === 'updatedAt' ? a.updatedAt : a.createdAt) ?? '')
    const bt = readTime((key === 'updatedAt' ? b.updatedAt : b.createdAt) ?? '')
    if (at !== null && bt !== null && at !== bt) return (at - bt) * factor
  }
  // 稳定兜底：更新时间倒序 → id。等值项翻页时不会乱跳。
  const au = readTime(a.updatedAt)
  const bu = readTime(b.updatedAt)
  if (au !== null && bu !== null && au !== bu) return bu - au
  return a.id.localeCompare(b.id)
}

/** 排序：**置顶优先于排序键**，其余按排序键；时间戳只在本次排序内解析一次。 */
export function orderItems<E extends PresentableItem>(entries: readonly E[], state: { pinned: readonly string[]; sortKey: SortKey; sortDir: SortDir }): E[] {
  const pinned = new Set(state.pinned)
  const readTime = makeTimeReader()
  const decorated = entries.map((entry) => ({ entry, rank: pinned.has(entry.id) ? 0 : 1 }))
  decorated.sort((x, y) => x.rank - y.rank || compareWithReader(x.entry, y.entry, state.sortKey, state.sortDir, readTime))
  return decorated.map((d) => d.entry)
}

/* ------------------------------------------------------------------ *
 * 分组（自适应）
 * ------------------------------------------------------------------ */

/**
 * 按时间档分组，并把**条目数 < `minGroup`** 的稀疏组并回**相邻的保留下来的那一组**。
 *
 * ## ⚠️ 档位序与合并方向必须跟随排序方向（v1.15.2 复审 F1）
 *
 * 第一版把档位序写死成「今天→更早」、合并一律往旧的方向，结果**升序排序按钮是假控件**：
 * 跨档位时页内顺序永远"新在前"，`sortDdir=asc` 与 `desc` 渲染出来的 HTML 逐字节相同
 * （只有在整页恰好落进单一档位时才真的按排序键排）。复审用 `probe-asc.mjs` 抓到了这一点。
 *
 * 现在 `descending` 决定档位遍历方向，而"合并方向"统一表述为
 * **并进输出序列里相邻的那一组**（按遍历顺序的前一组）—— 于是两种方向下都保持排序键顺序。
 *
 * 名称语义：合并后的组用**被并进去的那一组**的名字。数据少时（本机库 59 条有 49 条同一天）
 * desc 下结果就是「本月 53 / 更早 6」，不会出现「今天 1 / 本周 0」这种空壳组头。
 */
export function groupByTier<T extends PresentableItem>(items: readonly T[], now: number, minGroup = MIN_GROUP, descending = true): ListGroup<T>[] {
  const buckets = new Map<string, T[]>()
  for (const tier of GROUP_TIERS) buckets.set(tier, [])
  for (const item of items) buckets.get(groupTierOf(item.updatedAt, now))!.push(item)
  // 遍历顺序固定为 GROUP_TIERS（今天→更早）；`descending` 只决定**输出**顺序。
  const nonEmpty = GROUP_TIERS.filter((tier) => buckets.get(tier)!.length > 0)
  const out: ListGroup<T>[] = []
  // 从最旧的档往前走：`out[0]` 因此就是上一次放入的那一组（在遍历顺序里紧邻着它）
  for (let i = nonEmpty.length - 1; i >= 0; i--) {
    const tier = nonEmpty[i]
    const list = buckets.get(tier)!
    const neighbor = out[0]
    if (neighbor !== undefined && list.length < minGroup) {
      // 并进相邻那一组。合并方向必须与输出顺序一致，否则组内顺序会乱：
      // desc 时新档在前 → 这些更新鲜的条目要放到组首；asc 时旧档在前 → 放到组尾。
      if (descending) neighbor.items.unshift(...list)
      else neighbor.items.push(...list)
    } else {
      if (descending) out.unshift({ name: tier, items: list.slice() })
      else out.push({ name: tier, items: list.slice() })
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 分页
 * ------------------------------------------------------------------ */

/**
 * 按**条目**分页后再按组分块 —— 保证「第 x–y 条」的口径与页内条目数一致
 * （若先按组分页，一页里的条目数就不等于 pageSize，页码会更难解释）。
 *
 * `group` 为 `false` 时**不做时间分组**，整页平铺成一组 —— 用于"排序键不是时间"的场景
 * （见 `buildListPage` 里的说明）。
 */
export function slicePage<T extends PresentableItem>(sorted: readonly T[], page: number, pageSize: number, now: number, minGroup = MIN_GROUP, options: { group?: boolean; descending?: boolean } = {}): {
  groups: ListGroup<T>[]
  page: number
  pageTotal: number
  rangeStart: number
  rangeEnd: number
} {
  const size = normalizePageSize(pageSize)
  const pageTotal = Math.max(1, Math.ceil(sorted.length / size))
  const safePage = Math.min(normalizePage(page), pageTotal - 1)
  const rangeStart = safePage * size
  const rangeEnd = Math.min(rangeStart + size, sorted.length)
  const chunk = sorted.slice(rangeStart, rangeEnd)
  const groups = options.group === false
    ? (chunk.length > 0 ? [{ name: '', items: chunk.slice() }] : [])
    : groupByTier(chunk, now, minGroup, options.descending !== false)
  return { groups, page: safePage, pageTotal, rangeStart, rangeEnd }
}

/* ------------------------------------------------------------------ *
 * 对外唯一入口
 * ------------------------------------------------------------------ */

export interface BuildInput<T extends PresentableItem> {
  items: readonly T[]
  query: ListQuery
  /** 当前时间（注入，便于测试）。 */
  now: number
  /** Tab 取值列 → 是否属于该 tab（'all' 由本模块处理，不需要调用方判断）。 */
  tabOf: (item: T) => string
  /** 所有 tab code（用于 tabCounts 的键，保证没有命中的 tab 也有 0）。 */
  tabCodes: readonly string[]
}

/** 搜索 + 筛选 + 排序 + 分组 + 分页的**唯一**实现。 */
export function buildListPage<T extends PresentableItem>(input: BuildInput<T>): ListPage<T> {
  const { items, query, now, tabOf, tabCodes } = input
  const keyword = query.keyword
  const tags = query.tags

  const searched = items.filter((item) => matchesKeyword(item, keyword))
  const tagFiltered = searched.filter((item) => matchesTags(item, tags))

  // Tab 徽标：**不受当前 tab 限制**，其余条件（搜索 + 标签）照常生效。
  // 未知 code 记进「其他」而不是被静默丢掉 —— 否则"all 有 2 条、各 Tab 相加只有 1 条"，
  // 用户会以为列表漏了东西（静默丢件是禁区）。
  const tabCounts: Record<string, number> = { all: tagFiltered.length, other: 0 }
  for (const code of tabCodes) tabCounts[code] = 0
  for (const item of tagFiltered) {
    const code = tabOf(item)
    if (tabCounts[code] !== undefined) tabCounts[code] += 1
    else tabCounts.other += 1
  }

  const hit = query.tab === 'all' ? tagFiltered : tagFiltered.filter((item) => tabOf(item) === query.tab)
  const sortKey = normalizeSortKey(query.sortKey)
  const sortDir = normalizeSortDir(query.sortDir)
  const sorted = orderItems(hit, { pinned: [], sortKey, sortDir })
  /**
   * 只有"按更新时间排"时时间档位才有意义。
   *
   * 按标题/创建时间排的时候，组头（今天/本周/…）会把排序结果**重新按时间分块**，
   * 于是用户点了「按标题排序」看到的仍是被时间打乱的顺序 —— 复审 F1 抓到的就是这个。
   * 所以：非时间键**不分组**，整页平铺。
   */
  const grouped = sortKey === 'updatedAt'
  const sliced = slicePage(sorted, query.page, query.pageSize, now, MIN_GROUP, { group: grouped, descending: sortDir === 'desc' })

  return {
    groups: sliced.groups,
    pageCount: sliced.rangeEnd - sliced.rangeStart,
    total: sorted.length,
    pageTotal: sliced.pageTotal,
    page: sliced.page,
    rangeStart: sliced.rangeStart,
    rangeEnd: sliced.rangeEnd,
    tagCounts: collectTags(tagFiltered),
    tabCounts,
  }
}

/**
 * 知识库条目 / 点子 → 展示条目的**唯一**适配点。
 * 两者的字段形状一致（`contentMd` → `body`），所以只有一个函数，不留两份。
 */
export function toContentItem(source: { id: string; title: string; contentMd: string; tags: readonly string[]; kindCode: string; createdAt: string; updatedAt: string }): ContentItem {
  return {
    id: source.id,
    title: source.title,
    body: source.contentMd,
    tags: source.tags,
    kindCode: source.kindCode,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
}
