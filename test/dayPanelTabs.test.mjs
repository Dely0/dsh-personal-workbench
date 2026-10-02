/**
 * 日期面板的三个任务页签（计划 / 逾期 / 未排期）—— ADR0001「口径补充（2026-10-02）」。
 *
 * 这一层测两件事，缺一不可：
 * 1. **纯函数**（`dayPanelTabMembers`）：划分性质（并集=全部 open、未排期是补集、
 *    允许"逾期 ∩ 计划"的事实重叠）+ 边界（午夜、脏 due、归档/取消/重复模板）；
 * 2. **组件真的渲染**（`react-dom/server`，与 `listViews.test.mjs` 同一套做法）：
 *    五个页签在不在、过去日期有没有把两个新页签藏起来、空态有没有把判据说清楚。
 *
 * "组件里不许再 filter 一遍"由 `test/dayPanelWiring.test.mjs` 的源码扫描钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  dayPanelExtraTabsAvailable, dayPanelTabMembers, isDayPanelExtraTab, resolveDayPanelTab,
} from '../lib/shared/dailyPlanPolicy.js'
import { DayPanel } from '../lib/client/components/DayPanel.js'

/** 目标本地日 D = 2026-10-01（显式传 ms，便于午夜边界测试）。 */
const DAY_START = new Date(2026, 9, 1, 0, 0, 0, 0).getTime()
const DAY_END = new Date(2026, 9, 2, 0, 0, 0, 0).getTime()
const iso = (ms) => new Date(ms).toISOString()
const DAY = 86400_000

function task(over = {}) {
  return {
    id: 't1',
    parentId: null,
    title: '任务',
    description: '',
    typeCode: 'code_impl',
    statusCode: 'todo',
    priorityCode: 'p2',
    aiPolicyCode: 'consult',
    dueAt: null,
    effectiveDueAt: null,
    allDay: false,
    estimatedMinutes: 30,
    source: 'user',
    workspacePath: null,
    effectiveWorkspacePath: null,
    progressPercent: 0,
    archived: false,
    extra: {},
    recurrenceCode: null,
    recurrenceRule: {},
    recurrenceMasterId: null,
    recurrenceLastGenerated: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    cancelledAt: null,
    ...over,
  }
}

/** 一条覆盖"三来源 + 逾期 + 无归属 + 终态"的固定数据。 */
function fixture() {
  const tasks = [
    task({ id: 'due-today', title: '今天到期', effectiveDueAt: iso(DAY_START + 3600_000) }),
    task({ id: 'planned', title: '已排入该日', effectiveDueAt: iso(DAY_START + 5 * DAY) }),
    task({ id: 'doing', title: '进行中无截止', statusCode: 'doing' }),
    task({ id: 'overdue-todo', title: '逾期待办', effectiveDueAt: iso(DAY_START - DAY) }),
    task({ id: 'overdue-doing', title: '逾期且进行中', statusCode: 'doing', effectiveDueAt: iso(DAY_START - DAY) }),
    task({ id: 'no-due', title: '无截止' }),
    task({ id: 'future', title: '十天后到期', effectiveDueAt: iso(DAY_START + 10 * DAY) }),
    task({ id: 'done', title: '已完成', statusCode: 'done', effectiveDueAt: iso(DAY_START - DAY) }),
    task({ id: 'cancelled', title: '已取消', statusCode: 'cancelled' }),
    task({ id: 'archived', title: '已归档', archived: true }),
  ]
  const planItems = [{ taskId: 'planned' }, { taskId: 'overdue-doing' }]
  const members = dayPanelTabMembers({ tasks, planItems, dayStartMs: DAY_START, dayEndMs: DAY_END })
  return { tasks, planItems, members }
}

const OPEN_IDS = ['due-today', 'planned', 'doing', 'overdue-todo', 'overdue-doing', 'no-due', 'future']

test('划分：计划 ∪ 逾期 ∪ 未排期 == 全部 open 任务（没有任何任务没有归宿）', () => {
  const { members } = fixture()
  const union = new Set([...members.plan.map((entry) => entry.taskId), ...members.overdue, ...members.unscheduled])
  assert.deepEqual([...union].sort(), [...OPEN_IDS].sort())
  for (const id of ['done', 'cancelled', 'archived']) {
    assert.equal(union.has(id), false, `${id} 是终结态/归档，不许进任何任务页签`)
  }
})

test('划分：未排期是第一补集（与计划、逾期都不相交）', () => {
  const { members } = fixture()
  const plan = new Set(members.plan.map((entry) => entry.taskId))
  const overdue = new Set(members.overdue)
  for (const id of members.unscheduled) {
    assert.equal(plan.has(id), false, `${id} 已命中「计划」，不该出现在「未排期」`)
    assert.equal(overdue.has(id), false, `${id} 已逾期，不该出现在「未排期」`)
  }
  assert.deepEqual([...members.unscheduled].sort(), ['future', 'no-due'])
})

test('划分：「逾期」允许与「计划」重叠（事实重叠，刻意允许）', () => {
  const { members } = fixture()
  // 逾期 + 进行中：既要有「进行中」这个来源（进计划树），也要在「逾期」页签里
  assert.deepEqual([...members.overdue].sort(), ['overdue-doing', 'overdue-todo'])
  const overdueDoing = members.plan.find((entry) => entry.taskId === 'overdue-doing')
  assert.deepEqual(overdueDoing?.sources, ['plan', 'doing'], '排入该日 + 进行中，两个来源都要标')
})

test('逾期口径：截止 < 该日 00:00 才算（当天 00:00 起算"当日到期"，不是逾期）', () => {
  const at = (ms) => dayPanelTabMembers({
    tasks: [task({ id: 'x', effectiveDueAt: iso(ms) })],
    planItems: [],
    dayStartMs: DAY_START,
    dayEndMs: DAY_END,
  })
  assert.deepEqual(at(DAY_START - 1).overdue, ['x'], '前一天 23:59:59.999 是逾期')
  assert.deepEqual(at(DAY_START).overdue, [], '当天 00:00 不是逾期（它是"当日到期"）')
  assert.deepEqual(at(DAY_START).unscheduled, [], '当天 00:00 命中「计划」，同样不是未排期')
  assert.deepEqual(at(DAY_END).unscheduled, ['x'], '次日 00:00 起既不到期也不逾期 → 未排期')
})

test('脏截止串：不算逾期、也不算无截止 —— 落进「未排期」并留诊断（不许静默丢件）', () => {
  const members = dayPanelTabMembers({
    tasks: [task({ id: 'dirty', title: '坏截止', effectiveDueAt: '不是时间' })],
    planItems: [],
    dayStartMs: DAY_START,
    dayEndMs: DAY_END,
  })
  assert.deepEqual(members.overdue, [])
  assert.deepEqual(members.unscheduled, ['dirty'])
  assert.equal(members.diagnostics.length, 1)
  assert.equal(members.diagnostics[0].code, 'due-unparseable')
  assert.match(members.diagnostics[0].message, /按"未排期"处理/)
})

test('脏截止串已在「计划」树里时不重复报诊断（诊断只有一处产出，不刷两条）', () => {
  const members = dayPanelTabMembers({
    tasks: [task({ id: 'dirty', title: '坏截止', statusCode: 'doing', effectiveDueAt: '不是时间' })],
    planItems: [],
    dayStartMs: DAY_START,
    dayEndMs: DAY_END,
  })
  assert.equal(members.diagnostics.length, 1, '「进行中」已经让它进了计划树，那条诊断足够')
  assert.deepEqual(members.unscheduled, [])
})

test('计划项指向的任务已不存在 → 透传 missingTaskIds（树里不渲染，但要说清为什么少了）', () => {
  const members = dayPanelTabMembers({
    tasks: [task({ id: 'exists', effectiveDueAt: iso(DAY_START + 3600_000) })],
    planItems: [{ taskId: 'exists' }, { taskId: 'gone' }],
    dayStartMs: DAY_START,
    dayEndMs: DAY_END,
  })
  assert.deepEqual(members.missingTaskIds, ['gone'])
})

test('过去日期不显示「逾期」/「未排期」；今天与未来显示', () => {
  assert.equal(dayPanelExtraTabsAvailable('2026-09-30', '2026-10-02'), false, '过去日期')
  assert.equal(dayPanelExtraTabsAvailable('2026-10-02', '2026-10-02'), true, '今天')
  assert.equal(dayPanelExtraTabsAvailable('2026-10-03', '2026-10-02'), true, '未来（"到那天为止"的投影）')
  assert.equal(isDayPanelExtraTab('overdue'), true)
  assert.equal(isDayPanelExtraTab('unscheduled'), true)
  for (const tab of ['plan', 'done', 'report']) assert.equal(isDayPanelExtraTab(tab), false, tab)
})

test('resolveDayPanelTab：不可用时两个新页签都落到「计划」，其余页签原样保留', () => {
  assert.equal(resolveDayPanelTab('overdue', false), 'plan')
  assert.equal(resolveDayPanelTab('unscheduled', false), 'plan')
  assert.equal(resolveDayPanelTab('plan', false), 'plan')
  assert.equal(resolveDayPanelTab('done', false), 'done', '「已完成」在过去日期依然存在（按当日完成记录）')
  assert.equal(resolveDayPanelTab('report', false), 'report')
  assert.equal(resolveDayPanelTab('overdue', true), 'overdue')
  assert.equal(resolveDayPanelTab('unscheduled', true), 'unscheduled')
})

// ---------------------------------------------------------------------------
// 组件渲染（真渲染成 HTML 再断言，比源码扫描强）
// ---------------------------------------------------------------------------

const node = (t) => [{ task: t, children: [] }]

function panelProps(over = {}) {
  return {
    day: '2026-10-01',
    isToday: true,
    readOnly: false,
    extraTabsAvailable: true,
    tab: 'plan',
    onTabChange: () => {},
    plan: null,
    candidateRows: [],
    promptInfo: { truncated: false, notice: '' },
    planTree: [],
    overdueTree: [],
    unscheduledTree: [],
    doneTree: [],
    doneContextIds: new Set(),
    overdueContextIds: new Set(),
    unscheduledContextIds: new Set(),
    expanded: new Set(),
    onToggleExpanded: () => {},
    sourceLabelOf: () => null,
    tasks: [],
    dicts: [],
    selectedId: undefined,
    pending: null,
    childrenOf: undefined,
    busy: false,
    onOpen: () => {},
    onSort: () => {},
    onComplete: async () => {},
    onDefer: async () => {},
    onEffortChange: async () => {},
    onMinutesChange: async () => {},
    onProgressChange: async () => {},
    onClearPlan: () => {},
    onSavePlan: async () => {},
    report: {
      subTab: 'day',
      onSubTabChange: () => {},
      isFuture: false,
      current: null,
      sessionActive: false,
      onGenerate: () => {},
      onDelete: () => {},
    },
    emptyPlanAction: undefined,
    ...over,
  }
}

const render = (over) => renderToStaticMarkup(createElement(DayPanel, panelProps(over)))

test('渲染：五个页签都在，且计数来自成员（不是上下文行）', () => {
  const html = render({
    planTree: [],
    overdueTree: node(task({ id: 'o1', title: '逾期甲' })),
    unscheduledTree: node(task({ id: 'u1', title: '未排期甲' })),
    doneTree: node(task({ id: 'd1', title: '完成甲', statusCode: 'done', completedAt: iso(DAY_START + 3600_000) })),
  })
  for (const label of ['计划', '逾期', '未排期', '已完成', '报告']) {
    assert.ok(html.includes(`>${label}<`), `页签「${label}」必须渲染出来：${html.slice(0, 400)}`)
  }
  assert.ok(html.includes('data-day-tabs'), '页签容器要在')
  assert.equal(/class="count">1</.test(html), true, '逾期/未排期/已完成各 1 条，计数徽标要显示')
})

test('渲染：过去日期藏掉「逾期」/「未排期」，且页签落在「计划」上（不是空白）', () => {
  const html = render({ extraTabsAvailable: false, tab: 'overdue', readOnly: true, isToday: false, day: '2026-09-20' })
  assert.equal(html.includes('data-day-tree="overdue"'), false, '过去日期不许渲染逾期树')
  assert.equal(html.includes('data-day-tree="unscheduled"'), false)
  assert.equal(html.includes('data-day-tree="plan"'), true, 'state 停在「逾期」时要兜底渲染「计划」，不能是空白')
  assert.equal(html.includes('>逾期<'), false, '「逾期」页签按钮也要藏掉')
  assert.equal(html.includes('>未排期<'), false)
  assert.ok(html.includes('>已完成<') && html.includes('>报告<'), '其余页签照常')
})

test('渲染：逾期页签有成员时显示任务行，空时把判据说清楚', () => {
  const withRow = render({ tab: 'overdue', overdueTree: node(task({ id: 'o1', title: '归档管理欠账' })) })
  assert.ok(withRow.includes('归档管理欠账'), '成员任务要出现在逾期页签里')
  assert.equal(withRow.includes('没有逾期任务'), false)

  const empty = render({ tab: 'overdue' })
  assert.ok(empty.includes('没有逾期任务'))
  assert.match(empty, /截止时间早于 2026-10-01 的未完成任务/, '空态必须说清判据，否则用户以为任务丢了')
})

test('渲染：未排期空态给出"怎么把它排进去"的下一步', () => {
  const html = render({ tab: 'unscheduled' })
  assert.ok(html.includes('没有未排期的任务'))
  assert.match(html, /把状态改成「进行中」/, '空态要给出可操作的下一步')
})

test('渲染：计划页签逐条标来源（徽标来自 props，组件不自己判）', () => {
  const t = task({ id: 'p1', title: '计划中的任务' })
  const html = render({
    tab: 'plan',
    planTree: node(t),
    sourceLabelOf: (id) => (id === 'p1' ? '计划 · 进行中' : null),
  })
  assert.ok(html.includes('data-task-source="计划 · 进行中"'), '来源徽标要渲染出来（ADR0001：逐条标来源）')
})
