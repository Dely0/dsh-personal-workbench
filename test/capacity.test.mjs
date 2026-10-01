/**
 * T2/D09：今日容量的新口径（ADR 0002）—— **已排 = 该日计划投入分钟快照之和**。
 *
 * 覆盖 AX-C03 / AX-C04（以及 §5.2 的"无计划=0 但未排入可见""坏 JSON 不可计算"）。
 *
 * 两条纪律：
 * 1. **夹具只有一份**（`test/fixtures/capacityFixture.mjs`），并且它显式带着
 *    "旧口径下会被算进去的任务"——用来证明它们现在**不再**自动计入已排。
 * 2. 断言打的是**共享纯函数**（`lib/shared/dailyPlanPolicy.js`）与**客户端接线**
 *    （`lib/client/capacity.js`）两条路径：接线只许做形状转换，数字必须完全一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPACITY_EXPECTED,
  CAPACITY_FIXTURE,
  CAPACITY_LEGACY_DUE_SUM,
  CAPACITY_DAY_END,
  CAPACITY_DAY_START,
  CAPACITY_NOW,
  CAPACITY_PLAN_A,
  CAPACITY_TODAY,
} from './fixtures/capacityFixture.mjs'
import { computeCapacityLedger, planCandidates } from '../lib/shared/dailyPlanPolicy.js'
import { computeTodayCapacity, capacityDayRange, todayPlanCandidates } from '../lib/client/capacity.js'

const tasks = () => CAPACITY_FIXTURE.tasks.map((task) => ({ ...task }))
const planA = () => CAPACITY_PLAN_A.map((item) => ({ ...item }))

function ledger(overrides = {}) {
  return computeCapacityLedger({
    tasks: tasks(),
    planItems: planA(),
    planExists: true,
    planReadable: true,
    sourceCode: 'ai',
    dailyCapacityMinutes: CAPACITY_FIXTURE.dailyCapacityMinutes,
    defaultEstimateMinutes: CAPACITY_FIXTURE.defaultEstimateMinutes,
    includeOverdue: false,
    dayStartMs: CAPACITY_DAY_START,
    dayEndMs: CAPACITY_DAY_END,
    ...overrides,
  })
}

const ids = (rows) => rows.map((row) => row.taskId)

// ---------------------------------------------------------------------------
// AX-C03：无计划 / 计划求和 / 删除项 / 关闭不自动减
// ---------------------------------------------------------------------------

test('AX-C03 无计划：已排 0，但候选里未排入的**全部可见**（不回退到到期任务求和）', () => {
  const result = ledger({ planItems: [], planExists: false })
  assert.equal(result.planned, 0)
  assert.equal(result.plannedCount, 0)
  assert.equal(result.readable, true)
  assert.deepEqual(ids(result.plannedItems), [])
  // 8 条候选（开关关）全部是"未排入"，而不是被静默丢掉
  assert.equal(result.unscheduledCount, CAPACITY_EXPECTED.noPlanCandidates.total)
  assert.deepEqual(ids(result.unscheduled), CAPACITY_EXPECTED.noPlanCandidates.ids)
  assert.equal(result.unscheduledSuggestedMinutes, CAPACITY_EXPECTED.noPlanCandidates.unscheduledSuggested)
  // 明确断言"新版 ≠ 旧口径"：按到期求和会得到 240，新版必须是 0
  assert.equal(CAPACITY_LEGACY_DUE_SUM, 240)
  assert.notEqual(result.planned, CAPACITY_LEGACY_DUE_SUM)
})

test('AX-C03 计划合计：90+120+60+60+30=360 逐字段一致，且**只**由计划项构成', () => {
  const result = ledger()
  assert.deepEqual({
    planned: result.planned,
    doneMinutes: result.doneMinutes,
    remainingMinutes: result.remainingMinutes,
    plannedCount: result.plannedCount,
    free: result.free,
    over: result.over,
    total: result.total,
    byPriority: result.byPriority,
  }, CAPACITY_EXPECTED.planA)
  // 账本逐行 minutes 与计划项一字不差（S4 是 60 而不是它的估时 45）
  assert.deepEqual(result.plannedItems.map((row) => [row.taskId, row.minutes]), [['S1', 90], ['S2', 120], ['S4', 60], ['S6', 60], ['S8', 30]])
  assert.equal(result.plannedItems.find((row) => row.taskId === 'S4').minutes, 60)
  assert.equal(CAPACITY_FIXTURE.tasks.find((task) => task.id === 'S4').estimatedMinutes, 45)
})

test('AX-C03 删掉 60 分钟那条后已排 360→300（只有移除计划项才会减少）', () => {
  const before = ledger()
  const after = ledger({ planItems: planA().filter((item) => item.taskId !== 'S4') })
  assert.equal(before.planned, 360)
  assert.equal(after.planned, 300)
  assert.equal(after.free, 0)
  assert.equal(after.over, false, '300 = 可投入 300，不算超支')
})

test('AX-C03/C04 已结束投入与已完成/已取消/已归档/已删除任务的历史投入都**不自动减**已排', () => {
  const result = ledger({
    planItems: [
      { taskId: 'S1', order: 1, title: 'S1', minutes: 90, effortDone: true },
      { taskId: 'S13', order: 2, title: 'S13', minutes: 45, effortDone: false },
      { taskId: 'gone-task', order: 3, title: '已删除的任务', minutes: 25, effortDone: true },
      { taskId: 'S14', order: 4, title: 'S14', minutes: 20, effortDone: false },
    ],
  })
  assert.equal(result.planned, 90 + 45 + 25 + 20)
  assert.equal(result.doneMinutes, 90 + 25)
  assert.equal(result.remainingMinutes, 45 + 20)
  const gone = result.plannedItems.find((row) => row.taskId === 'gone-task')
  assert.equal(gone.taskMissing, true)
  assert.equal(gone.title, '已删除的任务', '缺失任务保留 title，不许静默丢件')
  assert.equal(result.plannedItems.find((row) => row.taskId === 'S13').taskClosed, true)
  assert.equal(result.plannedItems.find((row) => row.taskId === 'S14').taskClosed, true)
})

test('AX-C03 已排与可投入的先后：余 = max(0, 可投入 − 已排)，超支只由计划决定', () => {
  const small = ledger({ dailyCapacityMinutes: 100 })
  assert.equal(small.free, 0)
  assert.equal(small.over, true)
  const big = ledger({ dailyCapacityMinutes: 1000 })
  assert.equal(big.free, 640)
  assert.equal(big.over, false)
  const zero = ledger({ dailyCapacityMinutes: 0 })
  assert.equal(zero.free, 0)
  assert.equal(zero.over, true)
  assert.equal(zero.total, 360, '分母取 max(可投入, 已排, 1)')
})

test('AX-C03 计划里同一 taskId 重复出现时只计一次，并给出诊断（不静默多算）', () => {
  const result = ledger({
    planItems: [
      { taskId: 'S1', order: 1, title: 'S1', minutes: 90, effortDone: false },
      { taskId: 'S1', order: 2, title: 'S1', minutes: 90, effortDone: false },
    ],
  })
  assert.equal(result.planned, 90)
  assert.equal(result.plannedCount, 1)
  assert.ok(result.diagnostics.some((text) => text.includes('重复')), '重复项必须留下诊断')
})

// ---------------------------------------------------------------------------
// AX-C04：坏数据 / 脏 due / 默认估时快照
// ---------------------------------------------------------------------------

test('AX-C04 计划 JSON 无法解析 → readable=false、已排显示不可计算而不是假 0', () => {
  const result = ledger({ planItems: [], planReadable: false, reason: 'items_json 不是合法 JSON' })
  assert.equal(result.readable, false)
  assert.equal(result.planned, 0)
  assert.match(result.reason ?? '', /不是合法 JSON/)
})

test('AX-C04 计划项缺合法 minutes（旧数据）→ 用默认值展示但**必须**给诊断', () => {
  const result = ledger({
    planItems: [{ taskId: 'S1', order: 1, title: 'S1', minutes: undefined, effortDone: false }],
  })
  assert.equal(result.planned, 30, '缺 minutes 时按默认投入展示，不是 0')
  assert.ok(result.diagnostics.some((text) => text.includes('minutes')), '缺字段必须可观测')
})

test('AX-C04 脏 due 的 doing 任务仍进候选，但带"截止时间无法解析"诊断（不当作无截止）', () => {
  const result = ledger({ planItems: [], planExists: false })
  const s10 = result.unscheduled.find((row) => row.taskId === 'S10')
  assert.ok(s10, 'S10 是 doing，必须进候选')
  assert.ok(result.diagnostics.some((text) => text.includes('截止时间无法解析')), '脏 due 必须有诊断')
})

test('AX-C04 默认估时改了也不会改写已有 minutes 快照（容量只读计划）', () => {
  const base = ledger()
  const withBiggerDefault = ledger({ defaultEstimateMinutes: 240 })
  assert.equal(withBiggerDefault.planned, base.planned)
  assert.deepEqual(withBiggerDefault.plannedItems.map((row) => row.minutes), base.plannedItems.map((row) => row.minutes))
})

test('AX-C04 计划里有末来截止的长任务也照它的快照计入（不按到期与否过滤历史投入）', () => {
  const result = ledger()
  const s2 = result.plannedItems.find((row) => row.taskId === 'S2')
  assert.equal(s2.minutes, 120)
  assert.equal(s2.taskClosed, false)
})

// ---------------------------------------------------------------------------
// 接线一致性 + 日界
// ---------------------------------------------------------------------------

test('客户端接线与共享纯函数必须给同一个账本（同一次判定）', () => {
  const viaShared = ledger()
  const viaClient = computeTodayCapacity({
    tasks: tasks(),
    plan: { items: planA(), sourceCode: 'ai', readable: true },
    dailyCapacityMinutes: CAPACITY_FIXTURE.dailyCapacityMinutes,
    defaultEstimateMinutes: CAPACITY_FIXTURE.defaultEstimateMinutes,
    includeOverdue: false,
    now: CAPACITY_NOW,
  })
  assert.equal(viaClient.planned, viaShared.planned)
  assert.deepEqual(viaClient.byPriority, viaShared.byPriority)
  assert.deepEqual(ids(viaClient.unscheduled), ids(viaShared.unscheduled))
  assert.deepEqual(viaClient.plannedItems.map((row) => [row.taskId, row.minutes]), viaShared.plannedItems.map((row) => [row.taskId, row.minutes]))
})

test('客户端候选入口与共享候选判定给同一份全集（含诊断）', () => {
  const shared = planCandidates({
    tasks: tasks(),
    planItems: planA(),
    dayStartMs: CAPACITY_DAY_START,
    dayEndMs: CAPACITY_DAY_END,
    includeOverdue: false,
    defaultEstimateMinutes: CAPACITY_FIXTURE.defaultEstimateMinutes,
  })
  const client = todayPlanCandidates({
    tasks: tasks(),
    plan: { items: planA() },
    includeOverdue: false,
    defaultEstimateMinutes: CAPACITY_FIXTURE.defaultEstimateMinutes,
    now: CAPACITY_NOW,
  })
  assert.deepEqual(client.candidates.map((row) => row.taskId), shared.candidates.map((row) => row.taskId))
  assert.deepEqual(client.diagnostics.map((row) => row.taskId), shared.diagnostics.map((row) => row.taskId))
})

test('日界：本地日 00:00:00 算"今天"，下一天 00:00:00 不算', () => {
  const range = capacityDayRange(new Date(2026, 8, 30, 15, 0, 0))
  assert.deepEqual(range, { dayStartMs: CAPACITY_DAY_START, dayEndMs: CAPACITY_DAY_END })
  assert.equal(CAPACITY_TODAY, '2026-09-30')
  const noPlan = ledger({ planItems: [], planExists: false })
  assert.ok(ids(noPlan.unscheduled).includes('S8'), 'S8 元在本地日 00:00:00，必须算今天到期')
  assert.ok(!ids(noPlan.unscheduled).includes('S9'), 'S9 是次日 00:00:00，不许算今天')
})

// ---------------------------------------------------------------------------
// AX-C01/C02：候选判定（表驱动）
// ---------------------------------------------------------------------------

test('AX-C01 候选表驱动：未来 doing 入候选、未来 todo 不入、归档/done/cancelled 不入', () => {
  const result = planCandidates({
    tasks: tasks(),
    planItems: [],
    dayStartMs: CAPACITY_DAY_START,
    dayEndMs: CAPACITY_DAY_END,
    includeOverdue: false,
    defaultEstimateMinutes: CAPACITY_FIXTURE.defaultEstimateMinutes,
  })
  const byId = new Map(result.candidates.map((row) => [row.taskId, row]))
  assert.ok(byId.has('S2'), '截止在 5 天后的 doing 长任务必须可见（旧口径的"排不出来"根因）')
  assert.ok(!byId.has('S11'), '未来截止的 todo 不自动入候选')
  assert.ok(!byId.has('S12'), '无截止且不在推进的不入候选')
  assert.ok(!byId.has('S13'), 'done 不入候选')
  assert.ok(!byId.has('S14'), 'archived 不入候选')
  assert.equal(byId.get('S8').dueToday, true)
  assert.equal(byId.get('S8').overdue, false)
  assert.deepEqual(byId.get('S2').reasons, ['in-progress'])
  assert.deepEqual(byId.get('S6').reasons, ['in-progress'])
  assert.deepEqual(byId.get('S7').reasons, ['due-today'])
  assert.deepEqual(byId.get('S10').reasons, ['in-progress'])
  assert.equal(byId.get('S10').dueUnparseable, true)
})

test('AX-C01 逾期候选只受开关影响：关着不入、打开才入，且都不改已排', () => {
  const off = ledger()
  const on = ledger({ includeOverdue: true })
  assert.deepEqual(ids(off.unscheduled), CAPACITY_EXPECTED.planAUnscheduled.ids)
  assert.deepEqual(ids(on.unscheduled), CAPACITY_EXPECTED.planAUnscheduledOverdue.ids)
  assert.equal(on.planned, off.planned, '开关不许改变已排')
  assert.equal(on.unscheduledSuggestedMinutes, CAPACITY_EXPECTED.planAUnscheduledOverdue.suggested)
  assert.equal(off.unscheduledSuggestedMinutes, CAPACITY_EXPECTED.planAUnscheduled.suggested)
})

test('AX-C01 已在计划中的任务永远进候选（不会被开关或截止判定藏掉）', () => {
  const result = ledger({ includeOverdue: false })
  const s2 = result.unscheduled.find((row) => row.taskId === 'S2')
  assert.equal(s2, undefined, 'S2 已在计划里 → 不出现在未排入区')
  const candidates = planCandidates({
    tasks: tasks(),
    planItems: planA(),
    dayStartMs: CAPACITY_DAY_START,
    dayEndMs: CAPACITY_DAY_END,
    includeOverdue: false,
    defaultEstimateMinutes: CAPACITY_FIXTURE.defaultEstimateMinutes,
  })
  const planned = candidates.candidates.find((row) => row.taskId === 'S2')
  assert.ok(planned.planned)
  assert.equal(planned.plannedMinutes, 120, '已排入的候选要带计划投入快照（界面要显示它）')
})

test('AX-C01 排序稳定：优先级 → 有效截止升序（坏值最后）→ createdAt → id', () => {
  const result = ledger({ includeOverdue: false })
  assert.deepEqual(result.unscheduled.map((row) => row.taskId), CAPACITY_EXPECTED.sortedIds)
  // rank 是候选**全集**里的稳定序号（未排入区保留了它在全集里的位置，不再重编 1..n）
  assert.deepEqual(result.unscheduled.map((row) => row.rank), [4, 5, 6])
  const all = planCandidates({
    tasks: tasks(),
    planItems: planA(),
    dayStartMs: CAPACITY_DAY_START,
    dayEndMs: CAPACITY_DAY_END,
    includeOverdue: false,
    defaultEstimateMinutes: CAPACITY_FIXTURE.defaultEstimateMinutes,
  })
  // 含已排入项时的完整顺序：p0 S1 → p1 S2(在推进,未来截止) → p2 按截止 → p3 S8
  assert.equal(all.candidates[0].taskId, 'S1')
  assert.equal(all.candidates[1].taskId, 'S2', 'p1 档优先于所有 p2')
  assert.equal(all.candidates[all.candidates.length - 1].taskId, 'S8', 'p3 档排在最后')
  assert.ok(!all.candidates.some((row) => row.taskId === 'S9'), '次日 00:00 到期的不进今天的候选')
  assert.ok(!all.candidates.some((row) => row.taskId === 'S11'), '未来 todo 不进候选')
  assert.ok(!all.candidates.some((row) => row.taskId === 'S13'), 'done 不进候选')
})

test('AX-C01 未排入给的是**建议投入**（当前估时/默认），与已排严格分开', () => {
  const result = ledger()
  const byId = new Map(result.unscheduled.map((row) => [row.taskId, row]))
  assert.equal(byId.get('S5').suggestedMinutes, 45)
  assert.equal(byId.get('S7').suggestedMinutes, 30, 'S7 没填估时 → 默认 30')
  assert.equal(byId.get('S7').usedDefaultEstimate, true)
  assert.equal(byId.get('S10').suggestedMinutes, 30)
  // 建议投入合计**不进** planned
  assert.equal(result.unscheduledSuggestedMinutes, CAPACITY_EXPECTED.planAUnscheduled.suggested)
  assert.equal(result.planned, CAPACITY_EXPECTED.planA.planned)
})
