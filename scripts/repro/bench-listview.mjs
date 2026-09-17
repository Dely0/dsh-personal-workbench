/**
 * 列表判定的响应时间证据（验收项："条目规模到千级时滚动与筛选不卡顿，给出可观察的响应时间证据"）。
 *
 * 测的是 `listPresentation.buildListPage()` 这条**每次敲字/切 Tab/翻页都会走**的路径：
 * 搜索 + 标签 + Tab + 排序 + 分组 + 分页的合成耗时。分位数用排序取，避免均值被抖动带偏。
 *
 * 用法：node scripts/repro/bench-listview.mjs
 */
import { buildListPage, toContentItem } from '../../lib/client/listPresentation.js'

const TAGS = ['踩坑', 'TTS', 'DSH', '工作台', 'SQLite', 'React', '性能', '发布', '内网', '端口']
const KINDS = ['note', 'lesson', 'decision', 'snippet']
const NOW = Date.parse('2026-09-25T15:00:00+08:00')
const DAY = 86400000

function makeEntries(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const tags = [TAGS[i % TAGS.length], TAGS[(i * 7 + 3) % TAGS.length]]
    // 时间铺开 400 天，保证时间分组真的有多个档位（和真实库一样）
    const updated = new Date(NOW - (i % 400) * DAY - (i % 24) * 3600000).toISOString()
    out.push(toContentItem({
      id: 'k' + i,
      title: `知识条目 ${i} cloudflared 端口 ${i % 97}`,
      contentMd: `现象：第 ${i} 条的场景描述。\n原因：需要覆盖正文搜索。\n解法：把判定抽成纯函数。`,
      tags,
      kindCode: KINDS[i % KINDS.length],
      createdAt: new Date(NOW - (i % 500) * DAY).toISOString(),
      updatedAt: updated,
    }))
  }
  return out
}

const QUERY = {
  base: { tab: 'all', keyword: '', tags: [], sortKey: 'updatedAt', sortDir: 'desc', page: 0, pageSize: 50 },
  search: { tab: 'all', keyword: '端口 97', tags: [], sortKey: 'updatedAt', sortDir: 'desc', page: 0, pageSize: 50 },
  tab: { tab: 'lesson', keyword: '', tags: [], sortKey: 'updatedAt', sortDir: 'desc', page: 0, pageSize: 50 },
  facet: { tab: 'all', keyword: '', tags: ['TTS'], sortKey: 'updatedAt', sortDir: 'desc', page: 0, pageSize: 50 },
  deep: { tab: 'all', keyword: '', tags: [], sortKey: 'updatedAt', sortDir: 'desc', page: 18, pageSize: 50 },
  title: { tab: 'all', keyword: '', tags: [], sortKey: 'title', sortDir: 'asc', page: 0, pageSize: 50 },
}

function percentile(samples, p) {
  const sorted = samples.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function bench(items, query, rounds = 40) {
  const fn = () => buildListPage({
    items,
    query,
    now: NOW,
    tabOf: (e) => e.kindCode,
    tabCodes: KINDS,
  })
  fn() // 预热（JIT + 首次分配）
  const samples = []
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now()
    const page = fn()
    samples.push(performance.now() - t0)
    if (page.total < 0) throw new Error('unreachable')
  }
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: Math.max(...samples) }
}

const pad = (s, n) => String(s).padEnd(n)

console.log('列表判定响应时间（buildListPage：搜索 + 标签 + Tab + 排序 + 分组 + 分页）')
console.log(`运行环境：node ${process.version} / ${process.platform}\n`)

const rows = []
for (const size of [120, 1000, 3000, 5000]) {
  const items = makeEntries(size)
  for (const [name, query] of Object.entries(QUERY)) {
    const r = bench(items, query)
    rows.push({ size, name, ...r })
  }
}

// ---- 定位热点：把 sort 从整条链路里拆出来量（判断瓶颈是排序还是别处） ----
console.log('\n热点拆分（3,000 条 base）')
{
  const items = makeEntries(3000)
  const time = (label, fn, rounds = 30) => {
    fn()
    const s = []
    for (let i = 0; i < rounds; i++) { const t0 = performance.now(); fn(); s.push(performance.now() - t0) }
    console.log(`  ${pad(label, 26)}P50 ${percentile(s, 0.5).toFixed(2)} ms   P95 ${percentile(s, 0.95).toFixed(2)} ms`)
  }
  time('全量 buildListPage', () => buildListPage({ items, query: QUERY.base, now: NOW, tabOf: (e) => e.kindCode, tabCodes: KINDS }))
  time('仅排序（array.sort 整对象）', () => items.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)))
  time('仅排序（先取时间戳再排）', () => items.map((e) => [e, Date.parse(e.updatedAt)]).sort((a, b) => b[1] - a[1]))
  time('仅 map 适配', () => items.map((e) => ({ ...e })))
}

// ---- 结果表 ----
console.log(pad('条目数', 8) + pad('操作', 10) + pad('P50', 9) + pad('P95', 9) + '最坏')
for (const row of rows) {
  console.log(pad(row.size.toLocaleString('zh-CN'), 8) + pad(row.name, 10)
    + pad(row.p50.toFixed(2) + ' ms', 9) + pad(row.p95.toFixed(2) + ' ms', 9) + row.max.toFixed(2) + ' ms')
}

// 断言式收口：千级规模下每次操作都该在"人感觉不到"的量级内（一帧 16.7ms 是最宽的口子）
const worst1000 = rows.filter((r) => r.size === 1000)
const worst3000 = rows.filter((r) => r.size === 3000)
const budgetMs = 16.7
const over1000 = worst1000.filter((r) => r.p95 > budgetMs)
const over3000 = worst3000.filter((r) => r.p95 > budgetMs)
console.log('')
console.log(`1000 条的 P95 上限 ${budgetMs}ms（一帧）：${over1000.length === 0 ? '全部通过' : '超预算 → ' + over1000.map((r) => r.name).join(', ')}`)
console.log(`3000 条的 P95 上限 ${budgetMs}ms（一帧）：${over3000.length === 0 ? '全部通过' : '超预算 → ' + over3000.map((r) => r.name).join(', ')}`)
if (over1000.length > 0) process.exit(1)
