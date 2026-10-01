/**
 * T2/D08：当日候选纯函数（`src/shared/dailyPlanPolicy.ts`）—— AX-C01。
 *
 * 表驱动：每行给一个任务形状 + 期望的"进不进候选 / 理由 / 诊断"。
 * 这里**只测纯函数**：零 React、零 DOM、零 I/O（本模块的存在理由就是能被这样测）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPlanMinutes, parsePlanItems, planCandidates, selectPromptCandidates, PLAN_PROMPT_CANDIDATE_LIMIT } from '../lib/shared/dailyPlanPolicy.js'
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
    expect: { in: true, reasons: ['planned'], planned: true, plannedMinutes: 45, plannedOrder: 3 },
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
    for (const key of ['reasons', 'dueToday', 'overdue', 'inProgress', 'planned', 'plannedMinutes', 'plannedOrder', 'dueUnparseable']) {
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

test('AX-C01 未排入 = 候选 − 计划 taskId（父在计划里、子在候选里照常出现）', () => {
  const tasks = [T('parent', { statusCode: 'doing' }), T('child', { parentId: 'parent', statusCode: 'doing' })]
  const result = run(tasks, { planItems: [{ taskId: 'parent', order: 1, minutes: 60 }] })
  assert.equal(result.total, 2)
  assert.deepEqual(result.unscheduled.map((row) => row.taskId), ['child'])
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
