/**
 * 只读基线探针：量「今日容量」当前口径的真实影响。
 *
 * 为什么要它：任务要求的「已排」目前是纯内联计算（index.tsx），
 * 没有测试、也没有任何可复算的输出。动手改之前先量清楚三件事：
 *   1. 有多少条计入今日容量的任务**没填** estimatedMinutes（一律按 30 分钟兜底）；
 *   2. 逾期未完成任务有多少、它们**没有**计入「已排」，量级多大；
 *   3. 全天任务（all_day=1）有多少、当前与普通任务同算法。
 *
 * 只读：以 readonly 打开真库（不复制、不写）。用法：
 *   node scripts/repro/measure-capacity-baseline.mjs [--db <path>] [--json]
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : join(homedir(), '.dsh', 'workbench', 'workbench.db')
const asJson = args.includes('--json')

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db.prepare('SELECT id, parent_id, title, status_code, priority_code, due_at, all_day, estimated_minutes, archived FROM tasks').all()
db.close()

const now = new Date()
const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
const end = new Date(start.getTime() + 86400000)
const parse = (s) => (s == null ? null : Date.parse(s))
/**
 * 本地日期串（YYYY-MM-DD）。**不要用 `toISOString().slice(0,10)`** ——
 * 那是把"本地零点"当 UTC 再取日期，在 UTC+8 会**退回前一天**（本探针第一版就踩了：
 * 2026-09-17 20:08 跑出来显示"今天：2026-09-16"，与库里真实 due 日期一起错位一天）。
 * 口径与服务端 routes.ts 的 localDateString 一致。
 */
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 复刻仓储层 effectiveDueAtForTask：自身 due 优先，否则沿父链向上找最近有 due 的祖先（带防环）。 */
const byId = new Map(rows.map((r) => [r.id, r]))
const effectiveDue = (task) => {
  let cur = task
  let depth = 0
  const seen = new Set([task.id])
  while (cur !== undefined && depth < 20) {
    if (cur.due_at !== null) return cur.due_at
    const next = cur.parent_id === null ? undefined : byId.get(cur.parent_id)
    if (next === undefined || seen.has(next.id)) return null
    seen.add(next.id)
    cur = next
    depth += 1
  }
  return null
}

let planned = 0
let fallbackCount = 0
const byPriority = { p0: 0, p1: 0, p2: 0, p3: 0 }
const counted = []
const overdueNotCounted = []
let allDayCounted = 0
let allDayMinutes = 0

for (const t of rows) {
  if (t.archived === 1) continue
  if (t.status_code === 'done' || t.status_code === 'cancelled') continue
  // 与客户端真算法同一口径：用「有效截止时间」（可继承祖先），不是原始 due_at。
  // 第一版读原始 due_at，导致继承到祖先过期 due 的子任务被漏记（实测少报 6 条）。
  const due = parse(effectiveDue(t))
  const isToday = due !== null && due >= start.getTime() && due < end.getTime()
  const isDoing = t.status_code === 'doing' || t.status_code === 'blocked'
  const minutes = t.estimated_minutes ?? 30
  const isOverdue = due !== null && due < now.getTime() && !isToday
  const included = due === null ? isDoing : isToday
  if (included) {
    planned += minutes
    const band = ['p0', 'p1', 'p2', 'p3'].includes(t.priority_code) ? t.priority_code : 'p3'
    byPriority[band] += minutes
    if (t.estimated_minutes === null) fallbackCount += 1
    if (t.all_day === 1) { allDayCounted += 1; allDayMinutes += minutes }
    counted.push({ id: t.id, title: t.title, minutes, estimated: t.estimated_minutes, allDay: t.all_day === 1, status: t.status_code, priority: band })
  } else if (isOverdue) {
    overdueNotCounted.push({ id: t.id, title: t.title, minutes, dueAt: due })
  }
}

const out = {
  dbPath,
  now: now.toISOString(),
  today: { start: localDate(start), end: localDate(end) },
  capacity: {
    plannedMinutes: planned,
    countedTasks: counted.length,
    fallback30Count: fallbackCount,
    byPriority,
    allDayCounted,
    allDayMinutes,
  },
  overdueNotCounted: {
    count: overdueNotCounted.length,
    minutesIfCounted: overdueNotCounted.reduce((s, t) => s + t.minutes, 0),
    items: overdueNotCounted.slice(0, 10),
  },
  counted: counted.slice(0, 20),
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2))
} else {
  console.log(`库：${dbPath}`)
  console.log(`今天：${localDate(start)}`)
  console.log(`已排合计：${planned} min（${counted.length} 条；其中 ${fallbackCount} 条没填估算 → 按 30 兜底 = ${fallbackCount * 30} min）`)
  console.log(`按优先级：p0=${byPriority.p0} p1=${byPriority.p1} p2=${byPriority.p2} p3=${byPriority.p3}`)
  console.log(`全天任务计入：${allDayCounted} 条 / ${allDayMinutes} min（与普通任务同算法）`)
  console.log(`逾期未完成但**不计入**已排：${overdueNotCounted.length} 条 / ${out.overdueNotCounted.minutesIfCounted} min`)
  for (const t of out.overdueNotCounted.items) console.log(`  - [${localDate(new Date(t.dueAt))}] ${t.title} (${t.minutes} min)`)
}
