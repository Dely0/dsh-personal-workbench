/**
 * T2/D08：当日候选纯函数（`src/shared/dailyPlanPolicy.ts`）—— AX-C01。
 *
 * 表驱动：每行给一个任务形状 + 期望的"进不进候选 / 理由 / 诊断"。
 * 这里**只测纯函数**：零 React、零 DOM、零 I/O（本模块的存在理由就是能被这样测）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPlanTaskSet, dayPlacedIds, executableLeafIds, expandPlanLeaves, planGroupSummaries, planGroupSummaryLabel, checkPlanMinutes, parsePlanItems, planCandidates, selectPromptCandidates, PLAN_PROMPT_CANDIDATE_LIMIT } from '../lib/shared/dailyPlanPolicy.js'
import { buildPlanPrompt } from '../lib/client/dailyPlanPrompt.js'

const DAY_START = new Date(2026, 8, 30, 0, 0, 0, 0).getTime()
const DAY_END = new Date(2026, 9, 1, 0, 0, 0, 0).getTime()

const T = (id, extra = {}) => ({
  id,
  parentId: null,
  title: id,
  statusCode: 'todo',
  priorityCode: 'p2',
  effectiveDueAt: null,
  estimatedMinutes: null,
  archived: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...extra,
})

function run(tasks, overrides = {}) {
  return planCandidates({
    tasks,
    planItems: [],
    dayStartMs: DAY_START,
    dayEndMs: DAY_END,
    includeOverdue: false,
    defaultEstimateMinutes: 30,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// 表驱动：进不进候选
// ---------------------------------------------------------------------------

const CASES = [
  {
    name: '今天到期（todo）→ 进候选，理由 due-today',
    task: T('due-today', { effectiveDueAt: new Date(2026, 8, 30, 18, 0).toISOString() }),
    expect: { in: true, reasons: ['due-today'], dueToday: true, overdue: false, inProgress: false },
  },
  {
    name: '本地日 00:00:00 到期 → 仍算今天（日界左闭）',
    task: T('midnight', { effectiveDueAt: new Date(2026, 8, 30, 0, 0, 0, 0).toISOString() }),
    expect: { in: true, reasons: ['due-today'], dueToday: true },
  },
  {
    name: '次日 00:00:00 到期 → 不算今天（日界右开），也不进候选',
    task: T('next-midnight', { effectiveDueAt: new Date(2026, 9, 1, 0, 0, 0, 0).toISOString() }),
    expect: { in: false },
  },
  {
    name: '截止在未来的 doing 长任务 → 进候选（理由 in-progress）',
    task: T('future-doing', { statusCode: 'doing', effectiveDueAt: new Date(2026, 9, 5, 18, 0).toISOString() }),
    expect: { in: true, reasons: ['in-progress'], dueToday: false, inProgress: true },
  },
  {
    name: '截止在未来的 blocked → 同样进候选',
    task: T('future-blocked', { statusCode: 'blocked', effectiveDueAt: new Date(2026, 9, 5, 18, 0).toISOString() }),
    expect: { in: true, reasons: ['in-progress'] },
  },
  {
    name: '截止在未来的 todo → **不**自动进候选（不许 AI 自己养出候选）',
    task: T('future-todo', { effectiveDueAt: new Date(2026, 9, 5, 18, 0).toISOString() }),
    expect: { in: false },
  },
  {
    name: '无截止且 doing → 进候选',
    task: T('no-due-doing', { statusCode: 'doing' }),
    expect: { in: true, reasons: ['in-progress'] },
  },
  {
    name: '无截止且 todo → 不进候选',
    task: T('no-due-todo', {}),
    expect: { in: false },
  },
  {
    name: '逾期 todo 且开关关 → 不进候选',
    task: T('overdue-off', { effectiveDueAt: new Date(2026, 8, 29, 18, 0).toISOString() }),
    expect: { in: false },
  },
  {
    name: '逾期 todo 且开关开 → 进候选，理由 overdue',
    task: T('overdue-on', { effectiveDueAt: new Date(2026, 8, 29, 18, 0).toISOString() }),
    overrides: { includeOverdue: true },
    expect: { in: true, reasons: ['overdue'], overdue: true },
  },
  {
    name: '逾期但**在推进** → 开关关也进候选（开关不隐藏推进中的事）',
    task: T('overdue-doing', { statusCode: 'doing', effectiveDueAt: new Date(2026, 8, 29, 18, 0).toISOString() }),
    expect: { in: true, reasons: ['in-progress'], overdue: true },
  },
  {
    name: '已在计划中 → 永远进候选（即便 todo、未来截止、开关关）',
    task: T('planned', { effectiveDueAt: new Date(2026, 9, 5, 18, 0).toISOString() }),
    overrides: { planItems: [{ taskId: 'planned', order: 3, minutes: 45 }] },
    expect: { in: true, reasons: ['planned'], selfPlanned: true, dayPlaced: true, plannedMinutes: 45, plannedOrder: 3 },
  },
  {
    name: 'done → 不进候选',
    task: T('done', { statusCode: 'done', effectiveDueAt: new Date(2026, 8, 30, 18, 0).toISOString() }),
    expect: { in: false },
  },
  {
    name: 'cancelled → 不进候选',
    task: T('cancelled', { statusCode: 'cancelled', effectiveDueAt: new Date(2026, 8, 30, 18, 0).toISOString() }),
    expect: { in: false },
  },
  {
    name: '已归档 → 不进候选',
    task: T('archived', { archived: true, effectiveDueAt: new Date(2026, 8, 30, 18, 0).toISOString() }),
    expect: { in: false },
  },
  {
    name: '坏截止串且 todo → 不进候选（但也没有"今天到期"可言）',
    task: T('bad-due-todo', { effectiveDueAt: '不是时间' }),
    expect: { in: false },
  },
  {
    name: '坏截止串且 doing → 进候选并带诊断（不当作"无截止"）',
    task: T('bad-due-doing', { statusCode: 'doing', effectiveDueAt: '不是时间' }),
    expect: { in: true, reasons: ['in-progress'], dueUnparseable: true, diagnostic: true },
  },
]

for (const scenario of CASES) {
  test(`AX-C01 候选表驱动：${scenario.name}`, () => {
    const result = run([scenario.task], scenario.overrides ?? {})
    const found = result.candidates.find((row) => row.taskId === scenario.task.id)
    if (scenario.expect.in === false) {
      assert.equal(found, undefined, `${scenario.task.id} 不该进候选`)
      return
    }
    assert.ok(found, `${scenario.task.id} 必须进候选`)
    for (const key of ['reasons', 'dueToday', 'overdue', 'inProgress', 'selfPlanned', 'dayPlaced', 'plannedMinutes', 'plannedOrder', 'dueUnparseable']) {
      if (scenario.expect[key] === undefined) continue
      assert.deepEqual(found[key], scenario.expect[key], `${scenario.task.id}.${key}`)
    }
    if (scenario.expect.diagnostic === true) {
      assert.ok(result.diagnostics.some((item) => item.taskId === scenario.task.id && item.code === 'due-unparseable'))
    }
  })
}

// ---------------------------------------------------------------------------
// 排序 / 建议投入 / 继承
// ---------------------------------------------------------------------------

test('AX-C01 稳定排序：p0/p1/p2/p3（未知按 p3）→ 截止升序（无/坏值最后）→ createdAt → id', () => {
  const result = run([
    T('z-unknown-priority', { priorityCode: 'weird', effectiveDueAt: new Date(2026, 8, 30, 8, 0).toISOString() }),
    T('b-p2-later', { priorityCode: 'p2', effectiveDueAt: new Date(2026, 8, 30, 20, 0).toISOString() }),
    T('a-p2-earlier', { priorityCode: 'p2', effectiveDueAt: new Date(2026, 8, 30, 9, 0).toISOString() }),
    T('p1', { priorityCode: 'p1', effectiveDueAt: new Date(2026, 8, 30, 23, 0).toISOString() }),
    T('p0', { priorityCode: 'p0', effectiveDueAt: new Date(2026, 8, 30, 23, 0).toISOString() }),
    T('bad-due-doing', { statusCode: 'doing', effectiveDueAt: '不是时间' }),
    T('no-due-doing', { statusCode: 'doing' }),
  ])
  assert.deepEqual(result.candidates.map((row) => row.taskId), [
    'p0',
    'p1',
    // p2 档内按截止升序
    'a-p2-earlier',
    'b-p2-later',
    // 无截止 / 坏值排最后；两条都没有可比较的截止，按 createdAt 再按 id
    'bad-due-doing',
    'no-due-doing',
    // 未知优先级归 p3，排最后
    'z-unknown-priority',
  ])
})

test('AX-C01 同优先级同截止时按 createdAt 再按 id（排序必须完全确定）', () => {
  const due = new Date(2026, 8, 30, 10, 0).toISOString()
  const result = run([
    T('b', { effectiveDueAt: due, createdAt: '2026-09-02T00:00:00.000Z' }),
    T('a', { effectiveDueAt: due, createdAt: '2026-09-02T00:00:00.000Z' }),
    T('first', { effectiveDueAt: due, createdAt: '2026-09-01T00:00:00.000Z' }),
  ])
  assert.deepEqual(result.candidates.map((row) => row.taskId), ['first', 'a', 'b'])
})

test('AX-C01 建议投入：合法估时优先，否则默认；两者都给 usedDefaultEstimate 标记', () => {
  const result = run([
    T('est', { statusCode: 'doing', estimatedMinutes: 45 }),
    T('no-est', { statusCode: 'doing' }),
    T('bad-est', { statusCode: 'doing', estimatedMinutes: 0 }),
  ])
  const byId = new Map(result.candidates.map((row) => [row.taskId, row]))
  assert.equal(byId.get('est').suggestedMinutes, 45)
  assert.equal(byId.get('est').usedDefaultEstimate, false)
  assert.equal(byId.get('no-est').suggestedMinutes, 30)
  assert.equal(byId.get('no-est').usedDefaultEstimate, true)
  assert.equal(byId.get('bad-est').suggestedMinutes, 30, '0 不是合法估时 → 走默认')
  assert.equal(byId.get('bad-est').usedDefaultEstimate, true)
})

test('AX-C01 默认投入可配：settings 的 defaultEstimateMinutes 通过入参生效', () => {
  const result = run([T('no-est', { statusCode: 'doing' })], { defaultEstimateMinutes: 15 })
  assert.equal(result.candidates[0].suggestedMinutes, 15)
})

test('AX-C01 继承来的截止照常算"今天到期"（候选不复刻继承逻辑，用传入的 effectiveDueAt）', () => {
  const result = run([
    T('parent', { effectiveDueAt: new Date(2026, 9, 5, 10, 0).toISOString(), statusCode: 'doing' }),
    T('child', { parentId: 'parent', effectiveDueAt: new Date(2026, 8, 30, 10, 0).toISOString() }),
  ])
  const child = result.candidates.find((row) => row.taskId === 'child')
  assert.ok(child)
  assert.deepEqual(child.reasons, ['due-today'])
})

test('AX-C01 未排入 = 候选 − 计划 taskId（ADR0010：父任务不是候选，子任务照常是）', () => {
  const tasks = [T('parent', { statusCode: 'doing' }), T('child', { parentId: 'parent', statusCode: 'doing' })]
  const result = run(tasks, { planItems: [{ taskId: 'parent', order: 1, minutes: 60 }] })
  assert.equal(result.total, 1, '父任务（非叶子）不进候选池，哪怕它自己是既有计划项')
  assert.deepEqual(result.unscheduled.map((row) => row.taskId), ['child'], '子任务照常是候选、照常在未排入区')
})

test('AX-C01 逾期开关只增不减：打开后候选集合是关闭时的超集', () => {
  const tasks = [
    T('overdue', { effectiveDueAt: new Date(2026, 8, 29, 10, 0).toISOString() }),
    T('today', { effectiveDueAt: new Date(2026, 8, 30, 10, 0).toISOString() }),
    T('doing', { statusCode: 'doing' }),
  ]
  const off = run(tasks)
  const on = run(tasks, { includeOverdue: true })
  const offIds = new Set(off.candidates.map((row) => row.taskId))
  for (const row of on.candidates) {
    if (offIds.has(row.taskId)) continue
    assert.equal(row.taskId, 'overdue', '开关只能把逾期的放进来')
  }
  assert.equal(on.candidates.length, off.candidates.length + 1)
})

// ---------------------------------------------------------------------------
// AX-C02：30 条上限与"另有 N 条未列出"
// ---------------------------------------------------------------------------

test('AX-C02 31 条候选：列表只列 30 条，提示词与回执都写明另有 1 条（不说全量）', () => {
  const tasks = Array.from({ length: 31 }, (_, index) => T(`t${String(index).padStart(2, '0')}`, {
    priorityCode: 'p2',
    effectiveDueAt: new Date(2026, 8, 30, 1 + (index % 20), index % 60).toISOString(),
  }))
  const result = run(tasks)
  assert.equal(result.total, 31)
  const selection = selectPromptCandidates(result.candidates)
  assert.equal(selection.listed.length, PLAN_PROMPT_CANDIDATE_LIMIT)
  assert.equal(selection.omitted, 1)
  assert.equal(selection.truncated, true)
  assert.match(selection.notice, /另有 1 条未列出/)
  assert.match(selection.notice, /候选共 31 条/)

  const payload = buildPlanPrompt({ planDate: '2026-09-30', candidates: result.candidates })
  assert.equal(payload.listed.length, 30)
  assert.equal(payload.omitted, 1)
  assert.equal(payload.total, 31)
  assert.match(payload.text, /共 31 条候选/)
  assert.match(payload.text, /另有 1 条未列出/)
  assert.match(payload.text, /不要声称已对全量做排序/)
  // 只说列了 30 条，不说"只有 30 条任务"
  assert.match(payload.text, /最多列 30 条/)
})

test('AX-C02 未到上限时不出现"另有 N 条"（避免假告警）', () => {
  const tasks = Array.from({ length: 5 }, (_, index) => T(`t${index}`, { statusCode: 'doing' }))
  const payload = buildPlanPrompt({ planDate: '2026-09-30', candidates: run(tasks).candidates })
  assert.equal(payload.omitted, 0)
  assert.equal(payload.truncated, false)
  assert.equal(payload.notice, '')
  assert.doesNotMatch(payload.text, /另有/)
})

test('AX-C02 提示词列出每条候选的理由与建议投入，并带上数据诊断', () => {
  const result = run([
    T('due', { effectiveDueAt: new Date(2026, 8, 30, 18, 0).toISOString(), estimatedMinutes: 45 }),
    T('bad', { statusCode: 'doing', effectiveDueAt: '不是时间' }),
  ])
  const payload = buildPlanPrompt({ planDate: '2026-09-30', candidates: result.candidates, diagnostics: result.diagnostics })
  assert.match(payload.text, /#1 \[P2\] due/)
  assert.match(payload.text, /今天到期/)
  assert.match(payload.text, /建议投入 45 min/)
  assert.match(payload.text, /#2 \[P2\] bad/)
  assert.match(payload.text, /截止时间无法解析/)
  assert.match(payload.text, /数据有问题的条目/)
})

// ---------------------------------------------------------------------------
// 计划项解析 / 分钟校验
// ---------------------------------------------------------------------------

test('分钟校验：1 与 1440 合法，0/1441/小数/字符串/null 全部拒绝（不夹取）', () => {
  assert.deepEqual(checkPlanMinutes(1), { ok: true, value: 1 })
  assert.deepEqual(checkPlanMinutes(1440), { ok: true, value: 1440 })
  for (const bad of [0, -1, 1441, 1.5, '90', null, undefined, true, Number.NaN, Number.POSITIVE_INFINITY]) {
    const check = checkPlanMinutes(bad)
    assert.equal(check.ok, false, `${String(bad)} 必须被拒绝`)
    assert.match(check.reason, /计划投入/)
  }
})

test('parsePlanItems：坏 JSON / 非数组 → readable=false（容量必须显示不可计算）', () => {
  assert.equal(parsePlanItems('{oops').readable, false)
  assert.equal(parsePlanItems('{"a":1}').readable, false)
  assert.equal(parsePlanItems(null).readable, false)
})

test('parsePlanItems：坏项被跳过但留下诊断，合法项照常可读（不静默丢件）', () => {
  const parsed = parsePlanItems([
    { taskId: 'ok', order: 1, title: 'ok', note: '', minutes: 30, effortDone: true },
    'garbage',
    { order: 2, title: '无 taskId' },
    { taskId: 'no-minutes', order: 3, title: 'x', note: '' },
  ])
  assert.equal(parsed.readable, true)
  assert.deepEqual(parsed.items.map((item) => item.taskId), ['ok', 'no-minutes'])
  assert.equal(parsed.items[0].effortDone, true)
  assert.equal(parsed.items[1].minutes, 30, '缺 minutes 时给默认值，并由诊断说明')
  assert.equal(parsed.diagnostics.length, 3)
})

test('AX-C01 午夜/DST 边界：日界显式传入，跨"当天 23:59"与"次日 00:00"仍分得清', () => {
  /**
   * 本机在 UTC+8（无夏令时），所以这里用**本地组件构造**造出"夏令时切换日"的 23:59 与
   * 次日 00:00。两个时刻的**本地日历日**必然不同，因此"23:59 算今天、次日 00:00 不算"
   * 这条判据在任何时区（含 DST 切换日与 23/25 小时的日子）都成立 ——
   * 这正是 `dayStartMs/dayEndMs` 必须由调用方按**本地日**算好再传进来的理由：
   * 模块内部如果用 UTC 或 `+86400000` 推次日，DST 那天就会差一小时并可复现地误判。
   */
  const day = new Date(2026, 2, 8)
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0)
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0)
  const lateToday = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 0, 0)
  const nextMidnight = dayEnd
  const result = planCandidates({
    tasks: [
      T('late-today', { effectiveDueAt: lateToday.toISOString() }),
      T('next-midnight', { effectiveDueAt: nextMidnight.toISOString() }),
    ],
    planItems: [],
    dayStartMs: dayStart.getTime(),
    dayEndMs: dayEnd.getTime(),
    includeOverdue: false,
    defaultEstimateMinutes: 30,
  })
  assert.deepEqual(result.candidates.map((row) => row.taskId), ['late-today'])
  assert.equal(result.candidates[0].dueToday, true)
})

test('AX-C01 日界必须由调用方给：入参区间不覆盖该日时，当天到期的任务也不进候选', () => {
  const dueToday = T('due-today', { effectiveDueAt: new Date(2026, 8, 30, 18, 0).toISOString() })
  const shifted = planCandidates({
    tasks: [dueToday],
    planItems: [],
    // 故意错开一天（模拟"算错了本地日"）：判据必须跟着入参走，不许自己读系统时钟
    dayStartMs: new Date(2026, 9, 1, 0, 0, 0, 0).getTime(),
    dayEndMs: new Date(2026, 9, 2, 0, 0, 0, 0).getTime(),
    includeOverdue: false,
    defaultEstimateMinutes: 30,
  })
  assert.equal(shifted.total, 0)
})

// ---------------------------------------------------------------------------
// ADR0010：可执行叶子与子树展开（纯函数，唯一实现）
// ---------------------------------------------------------------------------

test('ADR0010：可执行叶子 = 自己 open 且下面没有未完成子任务', () => {
  const tasks = [
    T('parent'),
    T('leaf-a', { parentId: 'parent' }),
    T('leaf-b', { parentId: 'parent' }),
    T('done-parent', { statusCode: 'done' }),
    T('done-parent-child', { parentId: 'done-parent' }),
    T('all-closed-parent'),
    T('all-closed-child', { parentId: 'all-closed-parent', statusCode: 'done' }),
    T('archived-leaf', { archived: true }),
    T('cancelled-leaf', { statusCode: 'cancelled' }),
  ]
  const leaves = executableLeafIds(tasks)
  assert.equal(leaves.has('parent'), false, '有未完成子任务的父任务不是叶子')
  assert.equal(leaves.has('leaf-a'), true)
  assert.equal(leaves.has('leaf-b'), true)
  assert.equal(leaves.has('done-parent'), false, '已完成的父任务自己不是 open，不是叶子')
  assert.equal(leaves.has('done-parent-child'), true, '父已完成不影响子任务自己是叶子')
  assert.equal(leaves.has('all-closed-parent'), true, '子任务全终结 → 它自己就是叶子')
  assert.equal(leaves.has('all-closed-child'), false, '终结态子任务不是叶子')
  assert.equal(leaves.has('archived-leaf'), false, '归档任务不是叶子')
  assert.equal(leaves.has('cancelled-leaf'), false)
})

test('ADR0010：展开按树序（先父后子、同级 createdAt 再 id），跳过终结态，叶子展开=它自己', () => {
  const tasks = [
    T('root'),
    // 同级排序：mid(09-02) → a-early(09-03) → z-late(09-05)
    T('mid', { parentId: 'root', createdAt: '2026-09-02T00:00:00.000Z' }),
    T('z-late', { parentId: 'root', createdAt: '2026-09-05T00:00:00.000Z' }),
    T('a-early', { parentId: 'root', createdAt: '2026-09-03T00:00:00.000Z' }),
    T('same-day-b', { parentId: 'root', createdAt: '2026-09-06T00:00:00.000Z', title: 'bb' }),
    T('same-day-a', { parentId: 'root', createdAt: '2026-09-06T00:00:00.000Z' }),
    T('mid-leaf-1', { parentId: 'mid', createdAt: '2026-09-01T00:00:00.000Z' }),
    T('mid-leaf-2', { parentId: 'mid', createdAt: '2026-09-01T00:00:01.000Z' }),
    T('mid-done', { parentId: 'mid', statusCode: 'done' }),
    T('mid-archived', { parentId: 'mid', archived: true }),
  ]
  assert.deepEqual(expandPlanLeaves(tasks, 'root'),
    ['mid-leaf-1', 'mid-leaf-2', 'a-early', 'z-late', 'same-day-a', 'same-day-b'],
    '树序：同一父下的叶子连在一起；同级按 createdAt 升序、同日再按 id 词典序')
  assert.deepEqual(expandPlanLeaves(tasks, 'mid'), ['mid-leaf-1', 'mid-leaf-2'])
  assert.deepEqual(expandPlanLeaves(tasks, 'a-early'), ['a-early'], '叶子展开 = 它自己')
  assert.deepEqual(expandPlanLeaves(tasks, 'mid-done'), [], '终结态根不展开（它在写入校验里就会被拒）')
  assert.deepEqual(expandPlanLeaves(tasks, '不存在'), [])
})

test('ADR0010：成环的任务树不死循环，返回空数组（调用方不许把空数组当成功）', () => {
  const cyclic = [T('a', { parentId: 'b' }), T('b', { parentId: 'a' })]
  assert.deepEqual(expandPlanLeaves(cyclic, 'a'), [], '环里没有叶子可言（两个节点各有一个未完成"子"任务）')
  assert.equal(executableLeafIds(cyclic).size, 0)
})

// ---------------------------------------------------------------------------
// ADR0010：写入校验第 4 条 = 「新增项必须是可执行叶子」
// ---------------------------------------------------------------------------

test('ADR0010：新增项必须是可执行叶子 —— 非叶子拒绝、兄弟叶子允许、既有项豁免', () => {
  const parent = T('parent', { title: '父任务' })
  const childA = T('child-a', { parentId: 'parent' })
  const childB = T('child-b', { parentId: 'parent' })
  const byId = new Map([parent, childA, childB].map((task) => [task.id, task]))
  const none = new Set()

  assert.deepEqual(checkPlanTaskSet([{ taskId: 'child-a' }, { taskId: 'child-b' }], byId, none), { ok: true },
    '同一父下的兄弟叶子允许同时入列（这正是展开的产物）')

  const rejected = checkPlanTaskSet([{ taskId: 'parent' }], byId, none)
  assert.equal(rejected.ok, false)
  assert.match(rejected.reason, /不是可执行的叶子/)
  assert.match(rejected.reason, /下面还有 2 个未完成任务/)
  assert.match(rejected.reason, /改排它下面的子任务/)

  assert.deepEqual(checkPlanTaskSet([{ taskId: 'parent' }], byId, new Set(['parent'])), { ok: true },
    '既有项不被新规则回头拒绝（历史脏数据豁免，不擅自替用户改决定）')
  assert.deepEqual(checkPlanTaskSet([{ taskId: 'parent' }, { taskId: 'child-a' }], byId, new Set(['parent', 'child-a'])), { ok: true },
    '两项都在既有计划里 → 一律豁免')
})

test('ADR0010：新增叶子而它的上级已是既有计划项 → 拒绝并说清先移除谁', () => {
  const parent = T('parent', { title: '父任务' })
  const leaf = T('leaf', { parentId: 'parent', title: '叶子任务' })
  const byId = new Map([parent, leaf].map((task) => [task.id, task]))
  const result = checkPlanTaskSet([{ taskId: 'parent' }, { taskId: 'leaf' }], byId, new Set(['parent']))
  assert.equal(result.ok, false)
  assert.match(result.reason, /上级任务「父任务」已在同一天的计划里/)
  assert.match(result.reason, /先移除/)
})

test('ADR0010：新增叶子的子任务已是既有计划项（历史项）→ 同样拒绝并说清', () => {
  const parent = T('parent', { title: '父任务' })
  const doneChild = T('done-child', { parentId: 'parent', title: '已完成的子任务', statusCode: 'done' })
  const byId = new Map([parent, doneChild].map((task) => [task.id, task]))
  // 子任务已终结 → 父任务自己是可执行叶子；但子任务那一天已在计划里（历史投入），不许再排父任务
  assert.deepEqual(checkPlanTaskSet([{ taskId: 'parent' }], byId, new Set()), { ok: true }, '没有历史项时父任务可以排')
  const result = checkPlanTaskSet([{ taskId: 'parent' }], byId, new Set(['done-child']))
  assert.equal(result.ok, false)
  assert.match(result.reason, /「已完成的子任务」已在同一天的计划里/)
  assert.match(result.reason, /先移除/)
})

// ---------------------------------------------------------------------------
// ADR0010：「已安排」按子树继承（dayPlacedIds，唯一实现）
// ---------------------------------------------------------------------------

test('ADR0010：dayPlacedIds —— 非叶子任务要它子树内的叶子全排了才算已安排', () => {
  const parent = T('parent')
  const a = T('a', { parentId: 'parent' })
  const b = T('b', { parentId: 'parent' })
  const solo = T('solo')
  const tasks = [parent, a, b, solo]

  assert.deepEqual([...dayPlacedIds(tasks, [])], [], '什么都没排 → 谁都不算已安排')
  assert.deepEqual([...dayPlacedIds(tasks, [{ taskId: 'a' }])].sort(), ['a'], '只排了一条 → 父任务还不算已安排（它还欠着 b）')
  assert.deepEqual([...dayPlacedIds(tasks, [{ taskId: 'a' }, { taskId: 'b' }])].sort(), ['a', 'b', 'parent'],
    '叶子全排 → 父任务也算该日已安排（分组行）')
  assert.deepEqual([...dayPlacedIds(tasks, [{ taskId: 'solo' }])].sort(), ['solo'], '叶子排了自己就算已安排')
})

test('ADR0010：非叶子任务既不进候选、也不出现在「未排入」区（补齐入口在日期面板的「未排期」页签）', () => {
  const parent = T('parent', { title: '项目', statusCode: 'doing' })
  const a = T('a', { parentId: 'parent', statusCode: 'doing' })
  const b = T('b', { parentId: 'parent', statusCode: 'doing' })
  const tasks = [parent, a, b]
  const run = (planItems) => planCandidates({
    tasks, planItems, dayStartMs: DAY_START, dayEndMs: DAY_END, includeOverdue: false, defaultEstimateMinutes: 30,
  })

  const partial = run([{ taskId: 'a', order: 1, minutes: 30 }])
  assert.deepEqual(partial.candidates.map((row) => row.taskId), ['a', 'b'],
    '父任务不进候选（哪怕它在推进）：排它的含义是展开到叶子，候选池只放可排的东西')
  assert.equal(partial.candidates.find((row) => row.taskId === 'a').dayPlaced, true, '已排的叶子 dayPlaced=true')
  assert.deepEqual(partial.unscheduled.map((row) => row.taskId), ['b'], '未排入区只有叶子 b')

  const full = run([{ taskId: 'a', order: 1, minutes: 30 }, { taskId: 'b', order: 2, minutes: 30 }])
  assert.deepEqual(full.unscheduled, [], '叶子全排 → 未排入区为空')
  assert.ok(full.candidates.every((row) => row.selfPlanned), '候选里剩下的都是真计划项（叶子）')
})

test('ADR0010：非叶子任务「已安排」由 dayPlacedIds 判定（分组行/离开未排期都看它，不看候选池）', () => {
  const parent = T('parent', { title: '项目', statusCode: 'doing' })
  const a = T('a', { parentId: 'parent', statusCode: 'doing' })
  const b = T('b', { parentId: 'parent', statusCode: 'doing' })
  const tasks = [parent, a, b]

  const partial = dayPlacedIds(tasks, [{ taskId: 'a' }])
  assert.equal(partial.has('parent'), false, '只排了一条叶子 → 父任务还不算已安排（它留在「未排期」可一键补齐）')
  assert.equal(partial.has('a'), true)

  const full = dayPlacedIds(tasks, [{ taskId: 'a' }, { taskId: 'b' }])
  assert.equal(full.has('parent'), true, '叶子全排 → 父任务算已安排（进「计划」作分组行）')
})

test('ADR0010：分组行合计只给非叶子任务，算「已排 N / 共 M 个子任务 · 合计 X 分钟」', () => {
  const parent = T('parent')
  const a = T('a', { parentId: 'parent' })
  const b = T('b', { parentId: 'parent' })
  const solo = T('solo')
  const tasks = [parent, a, b, solo]

  const none = planGroupSummaries(tasks, [])
  assert.deepEqual(none.get('parent'), { totalLeaves: 2, plannedLeaves: 0, plannedMinutes: 0 },
    '一条都没排时父任务的合计是 0 / 2')
  assert.equal(none.has('solo'), false, '叶子不是分组行（自己就是计划项）')

  const partial = planGroupSummaries(tasks, [{ taskId: 'a', minutes: 25 }])
  assert.deepEqual(partial.get('parent'), { totalLeaves: 2, plannedLeaves: 1, plannedMinutes: 25 })
  assert.equal(planGroupSummaryLabel(partial.get('parent')), '已排 1 / 共 2 个子任务 · 合计 25 分钟')

  const full = planGroupSummaries(tasks, [{ taskId: 'a', minutes: 25 }, { taskId: 'b', minutes: 35 }])
  assert.deepEqual(full.get('parent'), { totalLeaves: 2, plannedLeaves: 2, plannedMinutes: 60 },
    '合计只算已排叶子的投入之和')
  assert.equal(planGroupSummaryLabel(full.get('parent')), '已排 2 / 共 2 个子任务 · 合计 60 分钟')
})

test('ADR0010：非叶子任务**不进候选池**（候选 = 可执行叶子）；叶子照旧按自己的估时给建议', () => {
  const parent = T('parent', { statusCode: 'doing', estimatedMinutes: 480 })
  const a = T('a', { parentId: 'parent', statusCode: 'doing', estimatedMinutes: 25 })
  const b = T('b', { parentId: 'parent', estimatedMinutes: 35 })
  const tasks = [parent, a, b]
  const run = (planItems) => planCandidates({
    tasks, planItems, dayStartMs: DAY_START, dayEndMs: DAY_END, includeOverdue: false, defaultEstimateMinutes: 30,
  })

  const none = run([])
  assert.deepEqual(none.candidates.map((row) => row.taskId), ['a'],
    '父任务（非叶子）不是候选；未排的叶子 b 也不是候选（它没有到期/在推进）—— 候选池的既有口径不变')
  assert.equal(none.candidates.find((row) => row.taskId === 'a').suggestedMinutes, 25, '叶子读自己的估时')

  const partial = run([{ taskId: 'a', order: 1, minutes: 25 }])
  assert.deepEqual(partial.unscheduled, [], '叶子 a 已排、b 不是候选 → 未排入区为空')
  assert.equal(partial.candidates.some((row) => row.taskId === 'parent'), false, '已排/未排都不影响"非叶子不进候选"')
})
