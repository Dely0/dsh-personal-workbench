import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT_DIR,
  DEFAULT_SORT_KEY,
  GROUP_TIERS,
  MIN_GROUP,
  SORT_OPTIONS,
  buildListPage,
  collectTags,
  compareItems,
  groupByTier,
  groupTierOf,
  matchesKeyword,
  matchesTags,
  normalizePageSize,
  normalizeSortDir,
  normalizeSortKey,
  slicePage,
  toContentItem,
} from '../lib/client/listPresentation.js'

/** 固定"现在"，否则测试会随真实日期漂移（这正是判定模块要求注入 now 的原因）。 */
const NOW = Date.parse('2026-09-25T12:00:00Z')
const HOUR = 3600000
const DAY = 86400000
const at = (msAgo) => new Date(NOW - msAgo).toISOString()

const item = (id, overrides = {}) => ({
  id,
  title: '条目 ' + id,
  body: '正文 ' + id,
  tags: [],
  updatedAt: at(0),
  createdAt: at(0),
  ...overrides,
})

/* ------------------------------ 归一化 ------------------------------ */

test('listPresentation: 默认排序是"更新时间倒序"（验收要求）', () => {
  assert.equal(DEFAULT_SORT_KEY, 'updatedAt')
  assert.equal(DEFAULT_SORT_DIR, 'desc')
  assert.equal(SORT_OPTIONS[0].key, 'updatedAt')
})

test('listPresentation: 坏值一律落回默认，不把界面打挂', () => {
  assert.equal(normalizeSortKey('nope'), 'updatedAt')
  assert.equal(normalizeSortKey(undefined), 'updatedAt')
  assert.equal(normalizeSortKey('title'), 'title')
  assert.equal(normalizeSortDir('nope'), 'desc')
  assert.equal(normalizeSortDir('asc'), 'asc')
  assert.equal(normalizePageSize(999), DEFAULT_PAGE_SIZE)
  assert.equal(normalizePageSize('100'), 100)
  assert.equal(normalizePageSize(undefined), DEFAULT_PAGE_SIZE)
})

/* ------------------------------ 搜索 ------------------------------ */

test('listPresentation: 关键词命中标题 / 正文 / 标签', () => {
  const a = item('a', { title: '登录闪退', body: '复现步骤见附件', tags: ['TTS'] })
  assert.equal(matchesKeyword(a, '登录'), true, '标题')
  assert.equal(matchesKeyword(a, '复现步骤'), true, '正文')
  assert.equal(matchesKeyword(a, 'tts'), true, '标签 + 大小写不敏感')
  assert.equal(matchesKeyword(a, '不存在的词'), false)
  assert.equal(matchesKeyword(a, '   '), true, '空关键词全放行')
})

test('listPresentation: 搜索必须能命中正文（只搜标题是缺陷）', () => {
  const only = item('x', { title: '无关标题', body: '里面提到 bad port' })
  assert.equal(matchesKeyword(only, 'bad port'), true)
})

/* ------------------------------ 标签筛选 ------------------------------ */

test('listPresentation: 标签筛选是同维度 OR，空选全放行', () => {
  const a = item('a', { tags: ['TTS', '性能'] })
  const b = item('b', { tags: ['DSH'] })
  assert.equal(matchesTags(a, []), true)
  assert.equal(matchesTags(a, ['TTS']), true)
  assert.equal(matchesTags(b, ['TTS']), false)
  assert.equal(matchesTags(b, ['TTS', 'DSH']), true, '同维度 OR')
})

test('listPresentation: chip 上的标签点下去必须真能筛到（两侧归一化口径一致）', () => {
  // 写入端（API / 工具）不 trim，所以库里可能有 "踩坑 " 这种值；chip 是 trim 后生成的
  const messy = item('messy', { tags: ['踩坑 ', ' TTS'] })
  assert.deepEqual(collectTags([messy]), [{ tag: '踩坑', count: 1 }, { tag: 'TTS', count: 1 }], 'chip 用 trim 后的键')
  // 点 chip 传的是 trim 后的值，必须命中
  assert.equal(matchesTags(messy, ['踩坑']), true, '点 #踩坑 必须命中 "踩坑 "')
  assert.equal(matchesTags(messy, ['TTS']), true, '点 #TTS 必须命中 " TTS"')
  const page = build([{ ...messy, kindCode: 'note' }], { tags: ['踩坑'] })
  assert.equal(page.total, 1, '筛选后不该是 0 条')
})

test('listPresentation: 标签从数据现算，按次数倒序', () => {
  const items = [
    item('a', { tags: ['x', 'y'] }),
    item('b', { tags: ['x'] }),
    item('c', { tags: ['x', 'z'] }),
    item('d', { tags: [''] }),
  ]
  assert.deepEqual(collectTags(items), [
    { tag: 'x', count: 3 },
    { tag: 'y', count: 1 },
    { tag: 'z', count: 1 },
  ])
})

/* ------------------------------ 排序 ------------------------------ */

test('listPresentation: 默认按更新时间倒序；切方向后正序', () => {
  const older = item('old', { updatedAt: at(3 * DAY) })
  const newer = item('new', { updatedAt: at(1 * DAY) })
  const desc = [older, newer].sort((a, b) => compareItems(a, b, 'updatedAt', 'desc'))
  assert.deepEqual(desc.map((i) => i.id), ['new', 'old'])
  const asc = [older, newer].sort((a, b) => compareItems(a, b, 'updatedAt', 'asc'))
  assert.deepEqual(asc.map((i) => i.id), ['old', 'new'])
})

test('listPresentation: 等值项有稳定兜底（翻页不会乱跳）', () => {
  const sameTime = at(DAY)
  const a = item('aaa', { updatedAt: sameTime })
  const b = item('bbb', { updatedAt: sameTime })
  const first = [a, b].sort((x, y) => compareItems(x, y, 'updatedAt', 'desc')).map((i) => i.id)
  const second = [b, a].sort((x, y) => compareItems(x, y, 'updatedAt', 'desc')).map((i) => i.id)
  assert.deepEqual(first, ['aaa', 'bbb'])
  assert.deepEqual(second, ['aaa', 'bbb'], '与输入顺序无关')
})

/* ------------------------------ 时间分组（自适应） ------------------------------ */

test('listPresentation: 六个档位的边界只在一处定义', () => {
  assert.deepEqual(GROUP_TIERS, ['今天', '本周', '本月', '近三个月', '一年内', '更早'])
  assert.equal(groupTierOf(at(1 * HOUR), NOW), '今天')
  assert.equal(groupTierOf(at(3 * DAY), NOW), '本周')
  assert.equal(groupTierOf(at(10 * DAY), NOW), '本月')
  assert.equal(groupTierOf(at(60 * DAY), NOW), '近三个月')
  assert.equal(groupTierOf(at(200 * DAY), NOW), '一年内')
  assert.equal(groupTierOf(at(500 * DAY), NOW), '更早')
  assert.equal(groupTierOf('not-a-date', NOW), '更早', '坏时间落最后一档而不是抛')
})

test('listPresentation: 稀疏组并回下一组（条目少时不出现"今天 1 / 本周 0"）', () => {
  const items = [
    item('t1', { updatedAt: at(1 * HOUR) }),
    item('w1', { updatedAt: at(2 * DAY) }),
    item('o1', { updatedAt: at(20 * DAY) }),
  ]
  const groups = groupByTier(items, NOW)
  // 今天(1)、本周(1) 都 < MIN_GROUP → 都并进更旧的"本月"（20 天，7–31 天区间）
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '本月')
  assert.deepEqual(groups[0].items.map((i) => i.id), ['t1', 'w1', 'o1'])
})

test('listPresentation: 达到阈值的组保留组头，组内顺序不变', () => {
  const items = []
  for (let i = 0; i < MIN_GROUP; i++) items.push(item('t' + i, { updatedAt: at(i * HOUR + HOUR) }))
  items.push(item('old', { updatedAt: at(20 * DAY) }))
  const groups = groupByTier(items, NOW)
  assert.deepEqual(groups.map((g) => g.name), ['今天', '本月'])
  assert.equal(groups[0].items.length, MIN_GROUP)
  assert.deepEqual(groups[0].items.map((i) => i.id), items.slice(0, MIN_GROUP).map((i) => i.id))
})

test('listPresentation: 合并只往更旧的方向（最新的一批不会被稀释到最旧档）', () => {
  // 今天够 MIN_GROUP → 保住自己的组头；后面的稀疏组往更旧的方向并，取更旧那一档的名字
  const items = []
  for (let i = 0; i < MIN_GROUP; i++) items.push(item('t' + i, { updatedAt: at(i * HOUR + HOUR) }))
  items.push(item('m1', { updatedAt: at(10 * DAY) }))
  items.push(item('y1', { updatedAt: at(200 * DAY) }))
  const groups = groupByTier(items, NOW)
  assert.deepEqual(groups.map((g) => g.name), ['今天', '一年内'])
  assert.equal(groups[0].items.length, MIN_GROUP, '最新的一批没被并走')
  assert.deepEqual(groups[1].items.map((i) => i.id), ['m1', 'y1'], '稀疏的"本月"并进了更旧的"一年内"，顺序仍是新的在前')
})

test('listPresentation: 组合都够阈值时各档独立成组（合并不会误伤）', () => {
  const items = []
  for (let i = 0; i < MIN_GROUP; i++) items.push(item('今天' + i, { updatedAt: at(i * HOUR + HOUR) }))
  for (let i = 0; i < MIN_GROUP; i++) items.push(item('本月' + i, { updatedAt: at(9 * DAY + i * HOUR) }))
  for (let i = 0; i < MIN_GROUP; i++) items.push(item('更早' + i, { updatedAt: at(400 * DAY + i * HOUR) }))
  const groups = groupByTier(items, NOW)
  assert.deepEqual(groups.map((g) => g.name), ['今天', '本月', '更早'])
  assert.deepEqual(groups.map((g) => g.items.length), [MIN_GROUP, MIN_GROUP, MIN_GROUP])
})

test('listPresentation: 全空输入不产生空组', () => {
  assert.deepEqual(groupByTier([], NOW), [])
})

/* ------------------------------ 分页 ------------------------------ */

test('listPresentation: 分页按条目切，页码与区间自洽', () => {
  const items = Array.from({ length: 120 }, (_, i) => item('i' + i, { updatedAt: at(i * HOUR) }))
  const p0 = slicePage(items, 0, 50, NOW)
  assert.equal(p0.rangeStart, 0)
  assert.equal(p0.rangeEnd, 50)
  assert.equal(p0.pageTotal, 3)
  assert.equal(p0.groups.reduce((n, g) => n + g.items.length, 0), 50)

  const p2 = slicePage(items, 2, 50, NOW)
  assert.equal(p2.rangeStart, 100)
  assert.equal(p2.rangeEnd, 120)
  assert.equal(p2.groups.reduce((n, g) => n + g.items.length, 0), 20)
})

test('listPresentation: 越界页码被夹回合法范围（不是渲染空页）', () => {
  const items = Array.from({ length: 10 }, (_, i) => item('i' + i))
  assert.equal(slicePage(items, 99, 50, NOW).page, 0)
  assert.equal(slicePage(items, -3, 50, NOW).page, 0)
  const empty = slicePage([], 5, 50, NOW)
  assert.equal(empty.page, 0)
  assert.equal(empty.pageTotal, 1, '空列表也是 1 页，避免出现 0/0')
  assert.equal(empty.rangeEnd, 0)
})

/* ------------------------------ 入口：叠加规则 ------------------------------ */

const build = (items, query, tabOf = (i) => i.kindCode ?? 'note', tabCodes = ['note', 'lesson']) => buildListPage({
  items, query: { tab: 'all', keyword: '', tags: [], sortKey: 'updatedAt', sortDir: 'desc', page: 0, pageSize: 50, ...query }, now: NOW, tabOf, tabCodes,
})

test('listPresentation: 搜索 / 标签 / Tab 三者是叠加（AND）关系', () => {
  const items = [
    { ...item('a', { title: '登录闪退', tags: ['TTS'] }), kindCode: 'lesson' },
    { ...item('b', { title: '登录慢', tags: ['性能'] }), kindCode: 'lesson' },
    { ...item('c', { title: '登录闪退', tags: ['TTS'] }), kindCode: 'note' },
  ]
  assert.equal(build(items, { keyword: '登录' }).total, 3)
  assert.equal(build(items, { keyword: '登录', tags: ['TTS'] }).total, 2)
  assert.equal(build(items, { keyword: '登录', tags: ['TTS'], tab: 'lesson' }).total, 1)
  assert.equal(build(items, { keyword: '登录', tags: ['TTS'], tab: 'lesson' }).groups[0].items[0].id, 'a')
})

test('listPresentation: Tab 徽标不受当前 Tab 限制，但受搜索/标签限制', () => {
  const items = [
    { ...item('a', { tags: ['TTS'] }), kindCode: 'lesson' },
    { ...item('b', { tags: ['TTS'] }), kindCode: 'note' },
    { ...item('c', { tags: ['性能'] }), kindCode: 'note' },
  ]
  const all = build(items, { tab: 'lesson' })
  assert.deepEqual(all.tabCounts, { all: 3, other: 0, note: 2, lesson: 1 }, '切到 lesson 也能看到 note 有几条')
  assert.equal(all.total, 1, '但命中只有当前 Tab 的')
  const filtered = build(items, { tab: 'all', tags: ['TTS'] })
  assert.deepEqual(filtered.tabCounts, { all: 2, other: 0, note: 1, lesson: 1 })
  const searched = build(items, { tab: 'all', keyword: '条目 c' })
  assert.deepEqual(searched.tabCounts, { all: 1, other: 0, note: 1, lesson: 0 }, '没有命中的 Tab 计 0 而不是缺键')
})

test('listPresentation: 字典外的 kindCode 记进「其他」，不被静默丢掉', () => {
  const items = [
    { ...item('a'), kindCode: 'note' },
    { ...item('b'), kindCode: 'note' },
    { ...item('c'), kindCode: '已经被删掉的分类' },
  ]
  const page = build(items, {})
  assert.equal(page.tabCounts.all, 3)
  assert.equal(page.tabCounts.other, 1, '未知 code 计入 other')
  assert.equal(page.tabCounts.note + page.tabCounts.lesson + page.tabCounts.other, 3, '各 Tab 相加必须等于 all')
})

test('listPresentation: 命中数不受分页限制；页内条目数等于页大小', () => {
  const items = Array.from({ length: 130 }, (_, i) => ({ ...item('i' + i, { updatedAt: at(i * HOUR) }), kindCode: 'note' }))
  const page = build(items, { page: 0, pageSize: 50 })
  assert.equal(page.total, 130)
  assert.equal(page.pageTotal, 3)
  assert.equal(page.pageCount, 50)
  assert.equal(page.tagCounts.length, 0)
})

/* ------------------------------ 整链顺序（复审 F1/F2） ------------------------------ */

/** 把决策结果摊平成"实际渲染顺序"的 id 数组 —— 这才是用户看到的东西。 */
const rendered = (page) => page.groups.flatMap((g) => g.items.map((i) => i.id))

test('listPresentation: sortDir 必须真的改变渲染顺序（升序不能与降序相同）', () => {
  // 跨两个时间档位，且两档都不稀疏（不会被合并），专门暴露"档位序写死"的缺陷
  const items = []
  for (let i = 0; i < 6; i++) items.push({ ...item('t' + i, { updatedAt: at(i * HOUR + HOUR) }), kindCode: 'note' })
  // 40 天落在「近三个月」（本月是 7–31 天）
  for (let i = 0; i < 6; i++) items.push({ ...item('o' + i, { updatedAt: at(40 * DAY + i * HOUR) }), kindCode: 'note' })

  const desc = build(items, { sortKey: 'updatedAt', sortDir: 'desc' })
  const asc = build(items, { sortKey: 'updatedAt', sortDir: 'asc' })
  assert.deepEqual(desc.groups.map((g) => g.name), ['今天', '近三个月'], '降序：新档在前')
  assert.deepEqual(asc.groups.map((g) => g.name), ['近三个月', '今天'], '升序：旧档在前')
  assert.deepEqual(rendered(desc), ['t0', 't1', 't2', 't3', 't4', 't5', 'o0', 'o1', 'o2', 'o3', 'o4', 'o5'])
  assert.deepEqual(rendered(asc), ['o5', 'o4', 'o3', 'o2', 'o1', 'o0', 't5', 't4', 't3', 't2', 't1', 't0'])
  assert.notDeepEqual(rendered(desc), rendered(asc), '两个方向渲染出来的顺序必须不同')
})

test('listPresentation: 升序时组内的"最旧"在最前面（顺序完整单调）', () => {
  const items = []
  for (let i = 0; i < 4; i++) items.push({ ...item('t' + i, { updatedAt: at(i * HOUR + HOUR) }), kindCode: 'note' })
  for (let i = 0; i < 4; i++) items.push({ ...item('o' + i, { updatedAt: at(40 * DAY + i * HOUR) }), kindCode: 'note' })
  const asc = build(items, { sortKey: 'updatedAt', sortDir: 'asc' })
  const times = rendered(asc).map((id) => Date.parse(items.find((x) => x.id === id).updatedAt))
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] >= times[i - 1], `第 ${i} 项比前一项更旧：顺序不单调`)
  }
})

test('listPresentation: 升序 + 稀疏组合并后顺序仍单调（合并方向跟着方向走）', () => {
  const items = [
    { ...item('new', { updatedAt: at(HOUR) }), kindCode: 'note' },
    { ...item('mid', { updatedAt: at(3 * DAY) }), kindCode: 'note' },
    { ...item('old', { updatedAt: at(40 * DAY) }), kindCode: 'note' },
  ]
  const asc = build(items, { sortKey: 'updatedAt', sortDir: 'asc' })
  assert.deepEqual(rendered(asc), ['old', 'mid', 'new'], '全部并进一组后仍是旧→新')
  const desc = build(items, { sortKey: 'updatedAt', sortDir: 'desc' })
  assert.deepEqual(rendered(desc), ['new', 'mid', 'old'], '降序是新→旧')
})

test('listPresentation: 非时间排序键不按时间分组（否则排序键会被组序打乱）', () => {
  // 注意时间方向：`at(n)` = n 毫秒**之前**，所以 at(1*DAY) 比 at(3*DAY) 更新
  const items = [
    { ...item('c', { title: 'CCC', updatedAt: at(HOUR), createdAt: at(3 * DAY) }), kindCode: 'note' },
    { ...item('a', { title: 'AAA', updatedAt: at(400 * DAY), createdAt: at(1 * DAY) }), kindCode: 'note' },
    { ...item('b', { title: 'BBB', updatedAt: at(40 * DAY), createdAt: at(2 * DAY) }), kindCode: 'note' },
  ]
  const byTitle = build(items, { sortKey: 'title', sortDir: 'asc' })
  assert.deepEqual(rendered(byTitle), ['a', 'b', 'c'], '标题升序就是标题序')
  assert.equal(byTitle.groups.length, 1, '不分组')
  assert.equal(byTitle.groups[0].name, '', '没有组头')

  const byCreatedAsc = build(items, { sortKey: 'createdAt', sortDir: 'asc' })
  assert.equal(byCreatedAsc.groups.length, 1, '按创建时间也不分组')
  assert.deepEqual(rendered(byCreatedAsc), ['c', 'b', 'a'], '创建时间升序 = 最旧的在前')
  const byCreatedDesc = build(items, { sortKey: 'createdAt', sortDir: 'desc' })
  assert.deepEqual(rendered(byCreatedDesc), ['a', 'b', 'c'], '创建时间降序 = 最新的在前')
})

test('listPresentation: 时间戳相同的条目顺序确定，且与输入顺序无关', () => {
  const same = at(2 * DAY)
  const items = [
    { ...item('bbb', { updatedAt: same }), kindCode: 'note' },
    { ...item('aaa', { updatedAt: same }), kindCode: 'note' },
  ]
  const first = rendered(build(items, { sortKey: 'updatedAt', sortDir: 'desc' }))
  const second = rendered(build(items.slice().reverse(), { sortKey: 'updatedAt', sortDir: 'desc' }))
  assert.deepEqual(first, ['aaa', 'bbb'])
  assert.deepEqual(second, first)
})

test('listPresentation: 排序时时间戳只解析一次（缓存 O(n)，不是每次比较都 parse）', () => {
  // 用**坏时间串**测：它没有缓存价值，所以缓存实现下每个串只解析一次；
  // 若退化成"每次比较都 Date.parse"，同样的串会被反复解析。
  const bad = (id) => item(id, { updatedAt: 'not-a-date-' + id, createdAt: 'not-a-date-' + id })
  const items = Array.from({ length: 300 }, (_, i) => bad('e' + i))
  const original = Date.parse
  let calls = 0
  Date.parse = (value) => { calls += 1; return original(value) }
  try {
    const page = buildListPage({
      items,
      query: { tab: 'all', keyword: '', tags: [], sortKey: 'updatedAt', sortDir: 'desc', page: 0, pageSize: 50 },
      now: NOW,
      tabOf: () => 'note',
      tabCodes: ['note'],
    })
    assert.equal(page.total, 300)
  } finally {
    Date.parse = original
  }
  // 缓存下：已排序键各 1 次 + 兜底读（同样命中缓存）+ 分组时每项 1 次（未缓存）≈ 几百；
  // 无缓存时 300 条的比较次数上千，这里给一个宽松但有区分度的上限。
  assert.ok(calls < 1200, `Date.parse 被调用 ${calls} 次，看起来没有按排序缓存时间戳`)
})

test('listPresentation: 适配函数把 contentMd 映射到 body（知识库与点子共用一个）', () => {
  const entry = { id: 'k1', title: '标题', contentMd: '正文内容', tags: ['a'], kindCode: 'note', createdAt: at(DAY), updatedAt: at(0) }
  const mapped = toContentItem(entry)
  assert.equal(mapped.body, '正文内容')
  assert.equal(mapped.kindCode, 'note')
  assert.equal(matchesKeyword(mapped, '正文内容'), true)
})
