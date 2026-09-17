/**
 * 用**独立实现的第二套算法**复算夹具，与 `test/fixtures/capacityFixture.mjs` 里写死的期望值对拍。
 *
 * 为什么要第二套实现：夹具的期望值（420 / 1380 / 480）是**手算**出来的。手算会错，
 * 而"错的期望值"配上"照抄期望值的实现"会全绿 —— 经典的自证循环。这里刻意用**不同写法**
 * （时间戳数字比较、显式循环、不共享任何工具函数）再算一遍，两套必须给出同一组数字。
 *
 * 不 import 任何产品代码：run 在 `capacity.ts` 落地**之前**，用来固化基准；落地之后
 * 它应当与 `computeTodayCapacity` 的输出一致（那是另一条断言，见 P1 的自检清单）。
 *
 * 用法：node scripts/repro/verify-capacity-fixed-dataset.mjs
 */
import { CAPACITY_FIXTURE, CAPACITY_EXPECTED, CAPACITY_INHERITANCE_EXPECTED, CAPACITY_INHERITANCE_TASKS } from '../../test/fixtures/capacityFixture.mjs'

const LOCAL_DAY_MS = 86400000
const localMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** 第二套实现：全部用"时间戳 + 显式循环"，与计划里纯函数的写法刻意不同。 */
function computeIndependently({ tasks, dailyCapacityMinutes, defaultEstimateMinutes, includeOverdue, now }) {
  const dayStart = localMidnight(now)
  const dayEnd = dayStart + LOCAL_DAY_MS
  let planned = 0
  let fallbackCount = 0
  let dueTodayCount = 0
  let noDueDoingCount = 0
  const byPriority = { p0: 0, p1: 0, p2: 0, p3: 0 }
  const included = []
  const overdueExcluded = []

  for (const t of tasks) {
    if (t.archived === true) continue
    if (t.statusCode === 'done') continue
    if (t.statusCode === 'cancelled') continue

    const raw = t.effectiveDueAt === null || t.effectiveDueAt === undefined ? NaN : Date.parse(t.effectiveDueAt)
    const hasDue = Number.isFinite(raw)
    const doing = t.statusCode === 'doing' || t.statusCode === 'blocked'
    const isToday = hasDue && raw >= dayStart && raw < dayEnd
    const isPast = hasDue && raw < dayStart

    let include = false
    let reason = ''
    if (isToday) { include = true; reason = 'due-today' } else if (!hasDue && doing) { include = true; reason = 'no-due-doing' } else if (isPast && includeOverdue) { include = true; reason = 'overdue-included' }

    // 耗时取值：有限整数 ≥1 用它（上限 1440），否则算"没填"
    let minutes
    const e = t.estimatedMinutes
    if (typeof e === 'number' && Number.isFinite(e) && Number.isInteger(e) && e >= 1) minutes = Math.min(1440, e)
    else { minutes = defaultEstimateMinutes; }

    const row = { id: t.id, minutes }
    if (include) {
      planned += minutes
      if (!(typeof e === 'number' && Number.isFinite(e) && Number.isInteger(e) && e >= 1)) fallbackCount += 1
      const band = t.priorityCode === 'p0' || t.priorityCode === 'p1' || t.priorityCode === 'p2' ? t.priorityCode : 'p3'
      byPriority[band] += minutes
      if (reason === 'due-today') dueTodayCount += 1
      if (reason === 'no-due-doing') noDueDoingCount += 1
      included.push(row)
    } else if (isPast) {
      overdueExcluded.push(row)
    }
  }

  const overdueMinutes = overdueExcluded.reduce((s, r) => s + r.minutes, 0)
  return {
    planned,
    byPriority,
    free: Math.max(0, dailyCapacityMinutes - planned),
    over: planned > dailyCapacityMinutes,
    total: Math.max(dailyCapacityMinutes, planned, 1),
    counted: included.length,
    dueTodayCount,
    noDueDoingCount,
    fallbackCount,
    includedIds: included.map((r) => r.id),
    overdueExcludedCount: overdueExcluded.length,
    overdueMinutes,
  }
}

/**
 * 继承分支的独立实算：**单独一段**，因为它要自己走父链（父的 due 决定子任务的归属），
 * 而主干那段刻意不碰继承（夹具里 effectiveDueAt 是显式给的）。
 * 两段写法不同也是刻意的：与产品实现共享代码就等于放弃"第二套算一遍"的意义。
 *
 * 返回的键名与 `CAPACITY_INHERITANCE_EXPECTED` 一一对应（它是"期望值的审计报告"，
 * 不是产品的 `CapacityResult` 形状）。
 */
function computeInheritanceIndependently(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const childrenOfCancelled = (task) => {
    const seen = new Set([task.id])
    let cursor = task.parentId === null ? null : byId.get(task.parentId) ?? null
    while (cursor !== null) {
      if (seen.has(cursor.id)) return false
      seen.add(cursor.id)
      if (cursor.statusCode === 'cancelled') return true
      cursor = cursor.parentId === null ? null : byId.get(cursor.parentId) ?? null
    }
    return false
  }
  const rows = []
  for (const task of tasks) {
    if (task.statusCode === 'cancelled' || task.statusCode === 'done' || task.archived === true) continue
    const raw = task.effectiveDueAt === null ? NaN : Date.parse(task.effectiveDueAt)
    const hasDue = Number.isFinite(raw)
    const dueToday = hasDue && new Date(raw).toDateString() === new Date(2026, 8, 16).toDateString()
    const overdue = hasDue && raw < new Date(2026, 8, 16).getTime()
    const doing = task.statusCode === 'doing' || task.statusCode === 'blocked'
    let reason = 'none'
    if (dueToday) reason = 'due-today'
    else if (!hasDue && doing) reason = 'no-due-doing'
    else if (overdue) reason = 'overdue-excluded'
    rows.push({
      id: task.id,
      minutes: task.estimatedMinutes ?? 30,
      reason,
      inheritedDue: task.dueAt === null && task.effectiveDueAt !== null,
      ghost: childrenOfCancelled(task),
    })
  }
  const inc = rows.filter((r) => r.reason === 'due-today' || r.reason === 'no-due-doing')
  const exc = rows.filter((r) => r.reason === 'overdue-excluded')
  return {
    planned: inc.reduce((s, r) => s + r.minutes, 0),
    counted: inc.length,
    dueTodayCount: inc.filter((r) => r.reason === 'due-today').length,
    noDueDoingCount: inc.filter((r) => r.reason === 'no-due-doing').length,
    fallbackCount: inc.filter((r) => r.minutes === 30).length,
    includedIds: inc.map((r) => r.id),
    overdueExcludedIds: exc.map((r) => r.id),
    overdueMinutes: exc.reduce((s, r) => s + r.minutes, 0),
    c3Ghost: inc.find((r) => r.id === 'C3')?.ghost,
    c2Ghost: exc.find((r) => r.id === 'C2')?.ghost,
  }
}

const base = { ...CAPACITY_FIXTURE }
const runs = [
  ['default', computeIndependently({ ...base, includeOverdue: false })],
  ['includeOverdue', computeIndependently({ ...base, includeOverdue: true })],
  ['defaultEstimate60', computeIndependently({ ...base, includeOverdue: false, defaultEstimateMinutes: 60 })],
]

let failures = 0
for (const [name, actual] of runs) {
  const expected = CAPACITY_EXPECTED[name]
  console.log(`\n【${name}】`)
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key]
    const same = JSON.stringify(got) === JSON.stringify(want)
    if (!same) failures += 1
    console.log(`  ${same ? '✅' : '❌'} ${key}: 期望 ${JSON.stringify(want)} / 实算 ${JSON.stringify(got)}`)
  }
  // 记账自洽（与期望值无关，纯内部一致）
  const sum = actual.includedIds.length
  const prioritySum = Object.values(actual.byPriority).reduce((a, b) => a + b, 0)
  const selfConsistent = prioritySum === actual.planned && sum === actual.counted
  if (!selfConsistent) failures += 1
  console.log(`  ${selfConsistent ? '✅' : '❌'} 记账自洽: byPriority 之和 ${prioritySum} == planned ${actual.planned}；included ${sum} == counted ${actual.counted}`)
}

/**
 * 第二组（继承 due / 幽灵逾期）：同样用独立实现复算。
 * 这组的期望值是手算的，所以它需要与主干同等强度的"另一套算法对拍"。
 */
{
  const actual = computeInheritanceIndependently(CAPACITY_INHERITANCE_TASKS)
  console.log('\n【inheritance（继承 due / 幽灵逾期）】')
  for (const [key, want] of Object.entries(CAPACITY_INHERITANCE_EXPECTED)) {
    const got = actual[key]
    const same = JSON.stringify(got) === JSON.stringify(want)
    if (!same) failures += 1
    console.log(`  ${same ? '✅' : '❌'} ${key}: 期望 ${JSON.stringify(want)} / 实算 ${JSON.stringify(got)}`)
  }
  const selfConsistent = actual.includedIds.length === actual.counted
    && actual.dueTodayCount + actual.noDueDoingCount === actual.counted
  if (!selfConsistent) failures += 1
  console.log(`  ${selfConsistent ? '✅' : '❌'} 记账自洽: included ${actual.includedIds.length} == counted ${actual.counted}；今天到期 ${actual.dueTodayCount} + 无截止推进 ${actual.noDueDoingCount} == counted ${actual.counted}`)
}

console.log(failures === 0
  ? '\n结果：夹具期望值与独立实现**完全一致**（0 处不符）→ 基准可交给单测与 harness。'
  : `\n结果：${failures} 处不符 → 夹具（或其期望值）有错，先修再谈实现。`)
if (failures > 0) process.exit(1)
