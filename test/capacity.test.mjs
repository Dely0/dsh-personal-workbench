import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPACITY_EXPECTED,
  CAPACITY_FIXTURE,
  CAPACITY_INHERITANCE_EXPECTED,
  CAPACITY_INHERITANCE_TASKS,
  CAPACITY_NOW,
} from './fixtures/capacityFixture.mjs'
import {
  DEFAULT_ESTIMATE_MINUTES,
  MAX_ESTIMATE_MINUTES,
  clampEstimatedMinutes,
  computeTodayCapacity,
} from '../lib/client/capacity.js'

/**
 * `capacity.ts`（今日容量的唯一权威源）的行为测试。
 *
 * 两条纪律：
 * 1. **夹具只有一份**（`test/fixtures/capacityFixture.mjs`）—— 同一组数字要同时出现在
 *    单测、harness 与设计文档里，各维护一份迟早分叉。基准数字由
 *    `scripts/repro/verify-capacity-fixed-dataset.mjs` 用**另一套独立实现**复核。
 * 2. **等价性必须对拍**：抽纯函数最容易犯的错是"顺手改了口径"（本项目最大的 bug 类别），
 *    所以下面有一条"把旧内联公式复刻成 legacyPlanned() 再随机 200 组对拍"。
 */

const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute, 0, 0)

/** 每次调用都拿一份新的任务数组：容量函数只读，但夹具是共享的，别让某条测试改坏它。 */
function baseTasks() {
  return CAPACITY_FIXTURE.tasks.map((task) => ({ ...task }))
}

function run(overrides = {}) {
  return computeTodayCapacity({
    tasks: baseTasks(),
    dailyCapacityMinutes: CAPACITY_FIXTURE.dailyCapacityMinutes,
    defaultEstimateMinutes: CAPACITY_FIXTURE.defaultEstimateMinutes,
    includeOverdue: false,
    now: CAPACITY_NOW,
    ...overrides,
  })
}

const ids = (rows) => rows.map((row) => row.id)

/**
 * 旧实现（`index.tsx:1989-2014`）的**逐字复刻**，只为对拍用。
 * 它保留旧口径里那个"`estimatedMinutes: 0` 就真的算 0 分钟"的行为 —— 那是被刻意
 * 修掉的差异，见下面单独那条测试。
 */
function legacyPlanned({ tasks, dailyCapacityMinutes, defaultEstimateMinutes, now }) {
  const sameDay = (a, b) => a.toDateString() === b.toDateString()
  const openTasks = tasks.filter((t) => !['done', 'cancelled'].includes(t.statusCode) && t.archived !== true)
  const todayTasks = openTasks.filter((t) =>
    t.effectiveDueAt === null
      ? (t.statusCode === 'doing' || t.statusCode === 'blocked')
      : sameDay(new Date(t.effectiveDueAt), now))
  const minutesOf = (t) => (typeof t.estimatedMinutes === 'number' ? Math.min(1440, t.estimatedMinutes) : defaultEstimateMinutes)
  const planned = todayTasks.reduce((sum, t) => sum + minutesOf(t), 0)
  const byPriority = {
    p0: todayTasks.filter((t) => t.priorityCode === 'p0').reduce((s, t) => s + minutesOf(t), 0),
    p1: todayTasks.filter((t) => t.priorityCode === 'p1').reduce((s, t) => s + minutesOf(t), 0),
    p2: todayTasks.filter((t) => t.priorityCode === 'p2').reduce((s, t) => s + minutesOf(t), 0),
    p3: todayTasks.filter((t) => !['p0', 'p1', 'p2'].includes(t.priorityCode)).reduce((s, t) => s + minutesOf(t), 0),
  }
  return {
    planned,
    byPriority,
    free: Math.max(0, dailyCapacityMinutes - planned),
    over: planned > dailyCapacityMinutes,
  }
}

/** 确定性 PRNG（mulberry32）：随机对拍必须可复现，否则红了也不知道是哪一组。 */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// 基准数据集（设计文档 §4.2，数字与独立实现、harness 三处同源）
// ---------------------------------------------------------------------------

test('基准 1：默认口径（不计逾期）逐字段对上夹具期望值', () => {
  const result = run({ includeOverdue: false })
  const expected = CAPACITY_EXPECTED.default
  assert.equal(result.planned, expected.planned, 'planned')
  assert.deepEqual(result.byPriority, expected.byPriority, 'byPriority')
  assert.equal(result.free, expected.free, 'free')
  assert.equal(result.over, expected.over, 'over')
  assert.equal(result.total, expected.total, 'total')
  assert.equal(result.counted, expected.counted, 'counted')
  assert.equal(result.dueTodayCount, expected.dueTodayCount, 'dueTodayCount（T11 靠继承父任务截止也算今天到期）')
  assert.equal(result.noDueDoingCount, expected.noDueDoingCount, 'noDueDoingCount')
  assert.equal(result.fallbackCount, expected.fallbackCount, 'fallbackCount')
  assert.deepEqual([...ids(result.included)].sort(), [...expected.includedIds].sort(), 'included 的 id 集合')
  assert.equal(result.overdueExcluded.length, expected.overdueExcludedCount, '逾期排除条数')
  assert.equal(result.overdueMinutes, expected.overdueMinutes, '逾期分钟合计')
  // archived / done / cancelled 三条**绝不能**出现在任何账本里
  for (const gone of ['T8', 'T9', 'T10']) {
    assert.ok(!ids(result.included).includes(gone), `${gone} 不该被计入`)
    assert.ok(!ids(result.overdueExcluded).includes(gone), `${gone} 不该出现在逾期账本`)
  }
  assert.ok(!ids(result.included).includes('T4'), 'T4 无截止又没在推进 → 不计入')
})

test('基准 2：打开「把逾期计入」开关 → planned/分档/账本同步变', () => {
  const result = run({ includeOverdue: true })
  const expected = CAPACITY_EXPECTED.includeOverdue
  assert.equal(result.planned, expected.planned)
  assert.deepEqual(result.byPriority, expected.byPriority)
  assert.equal(result.free, expected.free)
  assert.equal(result.over, expected.over)
  assert.equal(result.total, expected.total)
  assert.equal(result.counted, expected.counted)
  assert.deepEqual([...ids(result.included)].sort(), [...expected.includedIds].sort())
  assert.equal(result.overdueExcluded.length, 0, '开关打开后逾期区为空')
  assert.equal(result.overdueMinutes, 0)
  for (const id of ['T5', 'T6']) {
    assert.equal(result.included.find((row) => row.id === id)?.overdueIncluded, true, `${id} 要标 overdueIncluded`)
  }
  // 开关只影响逾期：三个计数一个都不该变
  assert.equal(result.dueTodayCount, 4)
  assert.equal(result.noDueDoingCount, 1)
  assert.equal(result.fallbackCount, 2)
})

test('基准 3：默认耗时改成 60 → planned 变 480（不是 540）', () => {
  const result = run({ defaultEstimateMinutes: 60 })
  assert.equal(result.planned, CAPACITY_EXPECTED.defaultEstimate60.planned)
  assert.equal(result.fallbackCount, CAPACITY_EXPECTED.defaultEstimate60.fallbackCount)
  assert.equal(result.counted, CAPACITY_EXPECTED.defaultEstimate60.counted)
})

// ---------------------------------------------------------------------------
// 等价性对拍：抽纯函数不许顺手改口径
// ---------------------------------------------------------------------------

test('等价性：200 组随机快照与旧内联公式在 planned/byPriority/free/over 上逐值一致', () => {
  const random = rng(20260916)
  const statuses = ['todo', 'doing', 'blocked', 'done', 'cancelled']
  const priorities = ['p0', 'p1', 'p2', 'p3', 'px']
  let compared = 0
  for (let round = 0; round < 200; round += 1) {
    const count = 1 + Math.floor(random() * 12)
    const tasks = []
    for (let i = 0; i < count; i += 1) {
      const pick = random()
      // due 候选：今天到期 / 逾期 / 未来 / 无
      let effectiveDueAt = null
      if (pick < 0.3) effectiveDueAt = at(16, 18).toISOString()
      else if (pick < 0.5) effectiveDueAt = at(14, 18).toISOString()
      else if (pick < 0.65) effectiveDueAt = at(20, 9).toISOString()
      const estimatePick = random()
      // 注意：旧实现的 `0` 会真的算 0 分钟，这里是**刻意**排除 0 的那条差异在别处单测
      const estimatedMinutes = estimatePick < 0.25 ? null : estimatePick < 0.5 ? 15 : estimatePick < 0.75 ? 90 : 1440
      tasks.push({
        id: `R${round}-${i}`,
        parentId: null,
        title: `任务 ${i}`,
        statusCode: statuses[Math.floor(random() * statuses.length)],
        priorityCode: priorities[Math.floor(random() * priorities.length)],
        effectiveDueAt,
        dueAt: effectiveDueAt,
        allDay: random() < 0.3,
        estimatedMinutes,
        archived: random() < 0.15,
      })
    }
    const dailyCapacityMinutes = [0, 60, 300, 480, 1440][Math.floor(random() * 5)]
    const defaultEstimateMinutes = [5, 30, 60, 1440][Math.floor(random() * 4)]
    const actual = computeTodayCapacity({ tasks, dailyCapacityMinutes, defaultEstimateMinutes, includeOverdue: false, now: CAPACITY_NOW })
    const legacy = legacyPlanned({ tasks, dailyCapacityMinutes, defaultEstimateMinutes, now: CAPACITY_NOW })
    assert.deepEqual(
      { planned: actual.planned, byPriority: actual.byPriority, free: actual.free, over: actual.over },
      legacy,
      `第 ${round} 组对拍不一致`,
    )
    compared += 1
  }
  assert.equal(compared, 200, '必须真的跑满 200 组（别让某次重构把循环提前 break 掉）')
})

test('刻意差异（防改回）：`estimatedMinutes: 0` 旧实现算 0 分钟，新实现按「没填」走默认', () => {
  // 旧实现：`t.estimatedMinutes ?? 30` → 0 不是 null/undefined，于是**真的算 0 分钟**，
  // 容量条会因此少算一件任务的成本。新实现把 0 视为"没填"，走默认耗时。
  // 这是本任务**唯一**允许与旧实现不同的地方，所以单独钉一条，改回去就会变红。
  const tasks = [{ id: 'Z', parentId: null, title: 'Z', statusCode: 'todo', priorityCode: 'p2', effectiveDueAt: at(16, 18).toISOString(), dueAt: at(16, 18).toISOString(), allDay: false, estimatedMinutes: 0, archived: false }]
  const legacy = legacyPlanned({ tasks, dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, now: CAPACITY_NOW })
  assert.equal(legacy.planned, 0, '旧实现确实算 0（这条断言是差异的证据，不是期望行为）')
  const result = computeTodayCapacity({ tasks, dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW })
  assert.equal(result.planned, 30, '新实现按没填处理 → 默认 30')
  assert.equal(result.fallbackCount, 1)
  assert.equal(result.included[0].usedFallback, true)
})

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------

test('边界：planned = 0 时 total = 可投入、over=false、free=可投入', () => {
  const result = computeTodayCapacity({ tasks: [], dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW })
  assert.equal(result.planned, 0)
  assert.equal(result.total, 300)
  assert.equal(result.over, false)
  assert.equal(result.free, 300)
  assert.deepEqual(result.included, [])
  assert.deepEqual(result.overdueExcluded, [])
})

test('边界：可投入 = 0 时不出现 NaN / 除零（total 取 max(0,planned,1)）', () => {
  const result = run({ dailyCapacityMinutes: 0 })
  assert.equal(result.free, 0)
  assert.equal(result.total, result.planned)
  assert.ok(Number.isFinite(result.total) && result.total > 0, 'total 必须是正数（条形分母）')
  assert.equal(result.over, true, '有已排而可投入为 0 → 超支')
  const noTasks = computeTodayCapacity({ tasks: [], dailyCapacityMinutes: 0, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW })
  assert.equal(noTasks.total, 1, '零任务 + 零可投入 → 兜底 1，避免除零')
})

test('跨日：今天 00:00:00 与 23:59:59 都算今天，昨天 23:59:59 不算', () => {
  const make = (iso) => ({ id: 'D', parentId: null, title: 'D', statusCode: 'todo', priorityCode: 'p2', effectiveDueAt: iso, dueAt: iso, allDay: false, estimatedMinutes: 45, archived: false })
  const runOne = (iso) => computeTodayCapacity({ tasks: [make(iso)], dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW })
  assert.equal(runOne(at(16, 0, 0).toISOString()).planned, 45, '今天 00:00 计入')
  assert.equal(runOne(at(16, 23, 59).toISOString()).planned, 45, '今天 23:59:59 计入')
  const yesterday = runOne(at(15, 23, 59).toISOString())
  assert.equal(yesterday.planned, 0, '昨天 23:59:59 不计入')
  assert.deepEqual(ids(yesterday.overdueExcluded), ['D'], '但它必须进逾期账本（不许静默消失）')
})

test('非法 effectiveDueAt（"abc"）：不抛异常，按「无法判定」处理且仍进账本', () => {
  const task = { id: 'B', parentId: null, title: 'B', statusCode: 'todo', priorityCode: 'p2', effectiveDueAt: 'abc', dueAt: 'abc', allDay: false, estimatedMinutes: 20, archived: false }
  const result = computeTodayCapacity({ tasks: [task], dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW })
  assert.equal(result.planned, 0)
  assert.deepEqual(ids(result.overdueExcluded), ['B'], '既不计入也不逾期，但账本里要有它（避免"少了一条又没人说"）')
  assert.equal(result.overdueExcluded[0].dueUnparseable, true, '要标出这是"截止时间无法解析"的脏数据')
  assert.equal(result.overdueMinutes, 0, '脏 due 串没有"逾期分钟"可言，不许虚增逾期合计')
  // 开关打开也不行：它压根不是逾期，混进「已排」等于凭空多算时间
  const withSwitch = computeTodayCapacity({ tasks: [task], dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: true, now: CAPACITY_NOW })
  assert.equal(withSwitch.planned, 0, '脏 due 串不受"把逾期计入"开关影响')
  assert.equal(withSwitch.overdueExcluded[0].dueUnparseable, true)
  // 若它是在推进中的任务，脏 due 串应视同"没有截止时间"
  const doing = computeTodayCapacity({ tasks: [{ ...task, statusCode: 'doing' }], dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW })
  assert.equal(doing.planned, 20, 'doing + 脏 due → 按"无截止但在推进"计入')
  assert.equal(doing.noDueDoingCount, 1)
})

test('耗时取值：-5 / 0.5 / NaN / Infinity / 1e9 分别走兜底，1e9 夹到 1440', () => {
  const withEstimate = (estimatedMinutes) => {
    const task = { id: 'E', parentId: null, title: 'E', statusCode: 'todo', priorityCode: 'p2', effectiveDueAt: at(16, 18).toISOString(), dueAt: at(16, 18).toISOString(), allDay: false, estimatedMinutes, archived: false }
    return computeTodayCapacity({ tasks: [task], dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW })
  }
  for (const bad of [-5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 0, null]) {
    const result = withEstimate(bad)
    assert.equal(result.planned, 30, `${String(bad)} 应走默认耗时`)
    assert.equal(result.fallbackCount, 1)
  }
  assert.equal(withEstimate(1e9).planned, MAX_ESTIMATE_MINUTES, '1e9 夹到 1440')
  assert.equal(withEstimate(1440).planned, 1440)
  assert.equal(withEstimate(1).planned, 1, '下界 1 分钟有效')
  assert.equal(withEstimate(90).fallbackCount, 0)
})

test('全天任务与普通任务结果完全相同（allDay 不参与容量计算）', () => {
  const plain = { id: 'A', parentId: null, title: 'A', statusCode: 'todo', priorityCode: 'p2', effectiveDueAt: at(16, 0).toISOString(), dueAt: at(16, 0).toISOString(), allDay: false, estimatedMinutes: 180, archived: false }
  const allDay = { ...plain, allDay: true }
  const calc = (task) => computeTodayCapacity({ tasks: [task], dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW })
  assert.equal(calc(allDay).planned, calc(plain).planned)
  assert.equal(calc(allDay).free, calc(plain).free)
  assert.equal(calc(allDay).byPriority.p2, calc(plain).byPriority.p2)
  assert.equal(calc(allDay).included[0].allDay, true, '但账本要能标出它是全天任务')
  assert.equal(calc(plain).included[0].allDay, false)
})

test('继承 due：子任务无自身 due、继承到今天 → 计入且标 inheritedDue', () => {
  const result = run()
  const row = result.included.find((item) => item.id === 'T11')
  assert.ok(row !== undefined, 'T11 应被计入')
  assert.equal(row.inheritedDue, true)
  assert.equal(row.minutes, 30, '没填耗时 → 默认 30')
  assert.equal(row.ghostFromCancelledAncestor, false, '父任务 T1 没被取消')
  assert.equal(row.chainId, 'T1', '账本要能标出"它属于 T1 这条链"')
  assert.equal(result.dueTodayCount, 4, 'T11 也算"今天到期"（这条曾被手算漏掉）')
})

test('继承 due：继承到过期 due → 走逾期分支被排除，标 ghostFromCancelledAncestor', () => {
  const result = computeTodayCapacity({
    tasks: CAPACITY_INHERITANCE_TASKS.map((task) => ({ ...task })),
    dailyCapacityMinutes: 300,
    defaultEstimateMinutes: 30,
    includeOverdue: false,
    now: CAPACITY_NOW,
  })
  const expected = CAPACITY_INHERITANCE_EXPECTED
  assert.equal(result.planned, expected.planned)
  assert.equal(result.counted, expected.counted)
  assert.equal(result.dueTodayCount, expected.dueTodayCount)
  assert.equal(result.noDueDoingCount, expected.noDueDoingCount)
  assert.equal(result.fallbackCount, expected.fallbackCount)
  assert.deepEqual([...ids(result.included)].sort(), [...expected.includedIds].sort())
  assert.deepEqual(ids(result.overdueExcluded), expected.overdueExcludedIds)
  assert.equal(result.overdueMinutes, expected.overdueMinutes)

  const c3 = result.included.find((row) => row.id === 'C3')
  assert.equal(c3?.inheritedDue, true, 'C3 的 due 是继承来的')
  // ghost 标记描述的是"来源是已取消祖先"，**不是**"被排除"：C3 继承到今天 → 照常计入
  assert.equal(c3?.ghostFromCancelledAncestor, expected.c3Ghost, 'C3 的来源同样是已取消父任务')
  assert.equal(c3?.overdueIncluded, false, 'C3 不是"逾期计入"（它今天到期）')

  const c2 = result.overdueExcluded.find((row) => row.id === 'C2')
  assert.equal(c2?.ghostFromCancelledAncestor, expected.c2Ghost, 'C2 继承自已取消父任务的过期 due → 幽灵逾期')
  assert.equal(c2?.inheritedDue, true)
  assert.equal(c2?.chainId, 'C1')

  // 已取消的父任务 C1 自己绝不能进账本
  assert.ok(!ids(result.included).includes('C1') && !ids(result.overdueExcluded).includes('C1'))
})

test('父子同链都计入时不去重（D6：本次刻意不去重，只给同链标记）', () => {
  const parent = { id: 'P', parentId: null, title: 'P', statusCode: 'doing', priorityCode: 'p2', effectiveDueAt: at(16, 18).toISOString(), dueAt: at(16, 18).toISOString(), allDay: false, estimatedMinutes: 60, archived: false }
  const child = { id: 'C', parentId: 'P', title: 'C', statusCode: 'todo', priorityCode: 'p2', effectiveDueAt: at(16, 18).toISOString(), dueAt: null, allDay: false, estimatedMinutes: 60, archived: false }
  const result = computeTodayCapacity({ tasks: [parent, child], dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW })
  assert.equal(result.planned, 120, '父子各计一份（当前刻意行为）')
  assert.equal(result.counted, 2)
  assert.equal(result.included.find((row) => row.id === 'C')?.chainId, 'P', '子任务标出所属链')
})

test('未知优先级归 p3（不是 p0）', () => {
  const task = { id: 'X', parentId: null, title: 'X', statusCode: 'todo', priorityCode: 'px', effectiveDueAt: at(16, 18).toISOString(), dueAt: at(16, 18).toISOString(), allDay: false, estimatedMinutes: 40, archived: false }
  const result = computeTodayCapacity({ tasks: [task], dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW })
  assert.equal(result.byPriority.p3, 40)
  assert.equal(result.byPriority.p0, 0)
  assert.equal(result.included[0].band, 'p3')
})

test('归档 / 已完成 / 已取消一律不进任何账本（传全量列表、函数内过滤）', () => {
  const base = { parentId: null, title: 'x', priorityCode: 'p2', effectiveDueAt: at(16, 18).toISOString(), dueAt: at(16, 18).toISOString(), allDay: false, estimatedMinutes: 60 }
  const tasks = [
    { ...base, id: 'ok', statusCode: 'todo', archived: false },
    { ...base, id: 'done', statusCode: 'done', archived: false },
    { ...base, id: 'cancelled', statusCode: 'cancelled', archived: false },
    { ...base, id: 'archived', statusCode: 'todo', archived: true },
  ]
  const result = computeTodayCapacity({ tasks, dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW })
  assert.deepEqual(ids(result.included), ['ok'])
  assert.deepEqual(result.overdueExcluded, [])
  assert.equal(result.planned, 60)
})

test('边界：已排 > 可投入时「余」是 0，绝不出现负数', () => {
  // free = max(0, 可投入 − 已排)：去掉 max(0,·) 会让「余」显示成负数（读数看起来像"欠时间"）
  const result = run({ includeOverdue: false })
  assert.ok(result.planned > CAPACITY_FIXTURE.dailyCapacityMinutes, '这组基准本来就是超支的')
  assert.equal(result.free, 0, '超支时余 = 0')
  assert.equal(result.over, true)
  const over = computeTodayCapacity({
    tasks: [{ id: 'O', parentId: null, title: 'O', statusCode: 'todo', priorityCode: 'p2', effectiveDueAt: at(16, 18).toISOString(), dueAt: at(16, 18).toISOString(), allDay: false, estimatedMinutes: 600, archived: false }],
    dailyCapacityMinutes: 300,
    defaultEstimateMinutes: 30,
    includeOverdue: false,
    now: CAPACITY_NOW,
  })
  assert.equal(over.free, 0)
  assert.equal(over.total, 600, '分母取 max(可投入, 已排, 1)')
})

test('账本自洽：两半合计分别等于 planned / overdueMinutes，四档之和等于 planned', () => {
  for (const includeOverdue of [false, true]) {
    const result = run({ includeOverdue })
    const includedSum = result.included.reduce((sum, row) => sum + row.minutes, 0)
    const excludedSum = result.overdueExcluded.reduce((sum, row) => sum + row.minutes, 0)
    const prioritySum = Object.values(result.byPriority).reduce((sum, value) => sum + value, 0)
    assert.equal(includedSum, result.planned, `includeOverdue=${includeOverdue} 账本计入合计 = planned`)
    assert.equal(excludedSum, result.overdueMinutes, `includeOverdue=${includeOverdue} 账本逾期合计 = overdueMinutes`)
    assert.equal(prioritySum, result.planned, '四档之和 = planned')
    assert.equal(result.counted, result.included.length, 'counted = included.length')
    // 三个计数必须能**解释** counted：今天到期 + 无截止推进 + 被开关放进来的逾期 = 计入条数
    const overdueIncluded = result.included.filter((row) => row.overdueIncluded).length
    assert.equal(
      result.dueTodayCount + result.noDueDoingCount + overdueIncluded,
      result.counted,
      '今天到期 + 无截止推进 + 逾期计入 = counted（计数不够用就会出现"账本对不上"）',
    )
  }
})

// ---------------------------------------------------------------------------
// clampEstimatedMinutes（服务端 PATCH 与客户端展示共用这一份）
// ---------------------------------------------------------------------------

test('clampEstimatedMinutes：合法值原样、越界夹取、非法值变 null', () => {
  assert.equal(clampEstimatedMinutes(90), 90)
  assert.equal(clampEstimatedMinutes(1), 1)
  assert.equal(clampEstimatedMinutes(1440), 1440)
  assert.equal(clampEstimatedMinutes(99999), 1440, '上限夹取')
  assert.equal(clampEstimatedMinutes(0), null)
  assert.equal(clampEstimatedMinutes(-5), null)
  assert.equal(clampEstimatedMinutes(0.5), null)
  assert.equal(clampEstimatedMinutes(Number.NaN), null)
  assert.equal(clampEstimatedMinutes(Number.POSITIVE_INFINITY), null)
  assert.equal(clampEstimatedMinutes(null), null)
  assert.equal(clampEstimatedMinutes(undefined), null)
  // 字符串形态必须落到 null：HTTP body 里 "90" 是字符串，不夹取就会出现"库里是字符串"
  assert.equal(clampEstimatedMinutes('90'), null)
  assert.equal(DEFAULT_ESTIMATE_MINUTES, 30, '默认耗时缺省 30')
})
