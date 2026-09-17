/**
 * 修前 / 修后对照（**同一个库、同一时刻、同一批任务**）。
 *
 * ## 为什么要单独一个脚本
 * "修前 vs 修后"最容易变成两张无法复现的截图。这里把两边都变成**可重跑的命令**：
 * - **修前**：用 `measure-capacity-baseline.mjs` 那份实现（内联算法的复刻）算；
 * - **修后**：用**产品真函数** `lib/client/capacity.js#computeTodayCapacity` 算（跑的是刚 build 的产物）。
 *
 * 两边读的是同一个真库（readonly 打开，不复制不改），所以差异只可能来自算法本身。
 * 输出 JSON 原样贴进 `_local-archive/capacity/before-after.md`，不写复现不出来的百分比。
 *
 * ⚠️ 真库数字是**时变**的：这个脚本的输出只作为"某时刻的快照"存档，
 * **不要**把它的具体数字写进任何测试断言（明天就会红）。
 *
 * 用法：node scripts/repro/compare-capacity-before-after.mjs [--db <path>] [--json] [--default-minutes 30]
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : join(homedir(), '.dsh', 'workbench', 'workbench.db')
const asJson = args.includes('--json')
const defaultEstimateMinutes = args.includes('--default-minutes') ? Number(args[args.indexOf('--default-minutes') + 1]) : 30

const { computeTodayCapacity } = await import(pathToFileURL(resolve('lib/client/capacity.js')).href)

const db = new DatabaseSync(dbPath, { readOnly: true })
/**
 * ⚠️ 列必须**显式列全**：本探针的历史版本漏选 `parent_id` → 继承分支静默走空、少报 6 条逾期；
 * 另一次漏选 `archived` → 过滤恒假、脚本零输出。写 SQL 时先把列列全，别用 SELECT *了事。
 */
const rows = db.prepare('SELECT id, parent_id, title, status_code, priority_code, due_at, all_day, estimated_minutes, archived FROM tasks').all()
db.close()

const now = new Date()
const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
const end = new Date(start.getTime() + 86400000)
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** 服务端支持的列齐备性自检：缺列会让某个分支**静默**走空（本项目已发生三次）。 */
for (const column of ['id', 'parent_id', 'status_code', 'priority_code', 'due_at', 'all_day', 'estimated_minutes', 'archived']) {
  if (!(column in (rows[0] ?? {}))) throw new Error(`SQL 漏选了列 ${column}（继承/过滤分支会静默失效）`)
}

// ------------------------------------------------------------------ 修前：内联算法的复刻
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
const before = (() => {
  let planned = 0
  let fallbackCount = 0
  const byPriority = { p0: 0, p1: 0, p2: 0, p3: 0 }
  let includedCount = 0
  let overdueCount = 0
  let overdueMinutes = 0
  let missingEstimate = 0
  for (const t of rows) {
    if (t.archived === 1) continue
    if (t.status_code === 'done' || t.status_code === 'cancelled') continue
    if (t.estimated_minutes === null) missingEstimate += 1
    const due = effectiveDue(t) === null ? null : Date.parse(effectiveDue(t))
    const isToday = due !== null && due >= start.getTime() && due < end.getTime()
    const isDoing = t.status_code === 'doing' || t.status_code === 'blocked'
    // 「不做任何提示」是修前的关键特征之一：逾期既不参与也不显示
    const isOverdue = due !== null && due < now.getTime() && !isToday
    const included = due === null ? isDoing : isToday
    const minutes = t.estimated_minutes ?? defaultEstimateMinutes
    if (included) {
      planned += minutes
      const band = ['p0', 'p1', 'p2', 'p3'].includes(t.priority_code) ? t.priority_code : 'p3'
      byPriority[band] += minutes
      if (t.estimated_minutes === null) fallbackCount += 1
      includedCount += 1
    } else if (isOverdue) {
      overdueCount += 1
      overdueMinutes += minutes
    }
  }
  return {
    planned,
    byPriority,
    includedCount,
    fallbackCount,
    missingEstimateActiveCount: missingEstimate,
    overdueCount,
    overdueMinutes,
    // 修前的事实：逾期**完全不参与**，界面里也不提
    overdueVisibleInUi: false,
    fallbackVisibleInUi: false,
  }
})()

// ------------------------------------------------------------------ 修后：产品真函数（跑的是刚 build 的产物）
const tasks = rows.map((r) => {
  const effective = effectiveDue(r)
  return {
    id: r.id,
    parentId: r.parent_id,
    title: r.title,
    statusCode: r.status_code,
    priorityCode: r.priority_code,
    dueAt: r.due_at,
    effectiveDueAt: effective,
    allDay: r.all_day === 1,
    estimatedMinutes: r.estimated_minutes,
    archived: r.archived === 1,
  }
})
const base = { tasks, dailyCapacityMinutes: 390, defaultEstimateMinutes, now }
const afterDefault = computeTodayCapacity({ ...base, includeOverdue: false })
const afterWithOverdue = computeTodayCapacity({ ...base, includeOverdue: true })
const after = {
  planned: afterDefault.planned,
  byPriority: afterDefault.byPriority,
  includedCount: afterDefault.counted,
  fallbackCount: afterDefault.fallbackCount,
  dueTodayCount: afterDefault.dueTodayCount,
  noDueDoingCount: afterDefault.noDueDoingCount,
  overdueCount: afterDefault.overdueExcluded.filter((r) => !r.dueUnparseable).length,
  overdueMinutes: afterDefault.overdueMinutes,
  unparseableDueCount: afterDefault.overdueExcluded.filter((r) => r.dueUnparseable).length,
  ghostFromCancelledAncestorCount: afterDefault.overdueExcluded.filter((r) => r.ghostFromCancelledAncestor).length,
  overdueVisibleInUi: true,
  fallbackVisibleInUi: true,
  plannedIfOverdueIncluded: afterWithOverdue.planned,
}
/**
 * `dailyCapacityMinutes: 390` 是这里的**显式入参**（脚本不读用户设置）。
 * 所以下面的 `over`/`free` 只能表示"按 390 分钟口径"的读数，不代表用户真实设置下的显示 ——
 * 真机上用户设的是别的值。这一点必须写出来，否则读表的人会以为"超支"是真实结论。
 */
const comparison = {
  dbPath,
  at: now.toISOString(),
  today: localDate(start),
  dailyCapacityMinutesAssumption: 390,
  defaultEstimateMinutes,
  library: {
    totalTasks: rows.length,
    activeTasks: rows.filter((r) => r.archived !== 1 && r.status_code !== 'done' && r.status_code !== 'cancelled').length,
    allDayTasks: rows.filter((r) => r.all_day === 1).length,
  },
  before,
  after,
  /** 同一批数据下，两边**应当一致**的口径（不一致就说明抽纯函数时改了口径）。 */
  consistency: {
    plannedSame: before.planned === after.planned,
    includedCountSame: before.includedCount === after.includedCount,
    overdueCountSame: before.overdueCount === after.overdueCount,
    overdueMinutesSame: before.overdueMinutes === after.overdueMinutes,
  },
}

if (asJson) {
  console.log(JSON.stringify(comparison, null, 2))
} else {
  console.log(`库：${dbPath}`)
  console.log(`时刻：${localDate(start)}（${comparison.at}） 口径假设：可投入 ${comparison.dailyCapacityMinutesAssumption} min / 默认耗时 ${defaultEstimateMinutes} min`)
  console.log(`库规模：任务 ${comparison.library.totalTasks} 条 · 活跃 ${comparison.library.activeTasks} 条 · all_day=1 ${comparison.library.allDayTasks} 条`)
  console.log('')
  console.log('修前（内联算法复刻）  修后（产品真函数 computeTodayCapacity）')
  console.log(`  已排            ${String(before.planned).padStart(5)}  ${String(after.planned).padStart(5)}`)
  console.log(`  计入条数        ${String(before.includedCount).padStart(5)}  ${String(after.includedCount).padStart(5)}`)
  console.log(`  走默认耗时条数  ${String(before.fallbackCount).padStart(5)}  ${String(after.fallbackCount).padStart(5)}`)
  console.log(`  逾期条数        ${String(before.overdueCount).padStart(5)}  ${String(after.overdueCount).padStart(5)}`)
  console.log(`  逾期分钟        ${String(before.overdueMinutes).padStart(5)}  ${String(after.overdueMinutes).padStart(5)}`)
  console.log(`  逾期在界面上可见      ${before.overdueVisibleInUi ? '是' : '否'}      是`)
  console.log(`  默认耗时在界面上可见  ${before.fallbackVisibleInUi ? '是' : '否'}      是`)
  console.log('')
  console.log(`逾期计入开关打开后 已排 = ${after.plannedIfOverdueIncluded} min`)
  console.log(`其中「继承自已取消父任务」的逾期：${after.ghostFromCancelledAncestorCount} 条`)
  console.log(`截止时间无法解析（脏 due 串）：${after.unparseableDueCount} 条`)
  console.log('')
  const same = Object.entries(comparison.consistency)
  console.log(`口径一致性：${same.every(([, v]) => v) ? '全部一致 ✓' : '存在差异 ✗ ' + JSON.stringify(comparison.consistency)}`)
}

const broken = Object.entries(comparison.consistency).filter(([, v]) => !v)
if (broken.length > 0) {
  console.error(`\n❌ 修前/修后在应当一致的口径上出现差异：${broken.map(([k]) => k).join('、')}`)
  console.error('   → 抽纯函数时改了口径（本该只加"逾期可见/分类"，不该动 planned 的口径）')
  process.exit(1)
}
