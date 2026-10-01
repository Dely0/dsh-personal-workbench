/**
 * 批次2 D14 / AX-T01、AX-T02：日期面板任务树的**来源判定**（ADR0001 口径冻结）。
 *
 * 口径：树的成员 = **当日到期 ∪ 当日计划项 ∪ 进行中**，逐条标出**全部**命中来源；
 * 只收 open（`done`/`cancelled`/归档不进）；「逾期」**不是**来源（是否加第 4 个来源待用户定案）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DAY_PANEL_SOURCE_ORDER, classifyTaskDay, dayPanelSourceLabel, dayPanelTreeSources,
} from '../lib/shared/dailyPlanPolicy.js'

/** 目标本地日 D = 2026-10-01（本地时区，显式传入 ms 便于边界测试）。 */
const DAY_START = new Date(2026, 9, 1, 0, 0, 0, 0).getTime()
const DAY_END = new Date(2026, 9, 2, 0, 0, 0, 0).getTime()

function task(over = {}) {
  return {
    id: 't1',
    parentId: null,
    title: '任务',
    statusCode: 'todo',
    priorityCode: 'p2',
    effectiveDueAt: null,
    estimatedMinutes: 30,
    archived: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

const iso = (ms) => new Date(ms).toISOString()

test('AX-T01 三种来源单独命中：当日到期 / 当日计划项 / 进行中', () => {
  const dueToday = task({ id: 'due', effectiveDueAt: iso(DAY_START + 9 * 3600_000) })
  const planned = task({ id: 'plan', effectiveDueAt: iso(DAY_START + 5 * 86400_000) })  // 5 天后到期
  const doing = task({ id: 'doing', statusCode: 'doing', effectiveDueAt: null })
  const out = dayPanelTreeSources({
    tasks: [dueToday, planned, doing],
    planItems: [{ taskId: 'plan' }],
    dayStartMs: DAY_START,
    dayEndMs: DAY_END,
  })
  const byId = new Map(out.entries.map((e) => [e.taskId, e.sources]))
  assert.deepEqual(byId.get('due'), ['due'])
  assert.deepEqual(byId.get('plan'), ['plan'], '「当日计划项」不看截止日：排进这一天就该出现')
  assert.deepEqual(byId.get('doing'), ['doing'], '进行中但无截止也要出现在日期面板里（不许静默消失）')
  assert.deepEqual(out.missingTaskIds, [])
})

test('AX-T01 多来源同时命中时必须全部标出，且顺序固定 到期→计划→进行中', () => {
  const all = task({ id: 'all', statusCode: 'doing', effectiveDueAt: iso(DAY_START + 3600_000) })
  const dueAndDoing = task({ id: 'due+doing', statusCode: 'blocked', effectiveDueAt: iso(DAY_START + 7200_000) })
  const planAndDoing = task({ id: 'plan+doing', statusCode: 'doing', effectiveDueAt: iso(DAY_START + 10 * 86400_000) })
  const out = dayPanelTreeSources({
    // 「计划项」只看 taskId，所以这一条同时是到期 + 计划 + 进行中
    tasks: [all, dueAndDoing, planAndDoing],
    planItems: [{ taskId: 'all' }, { taskId: 'plan+doing' }],
    dayStartMs: DAY_START,
    dayEndMs: DAY_END,
  })
  const byId = new Map(out.entries.map((e) => [e.taskId, e.sources]))
  assert.deepEqual(byId.get('all'), ['due', 'plan', 'doing'], '三者全中要全标，不许只留一个"主来源"')
  assert.deepEqual(byId.get('due+doing'), ['due', 'doing'])
  assert.deepEqual(byId.get('plan+doing'), ['plan', 'doing'])
  for (const sources of byId.values()) {
    const ordered = [...sources].sort((a, b) => DAY_PANEL_SOURCE_ORDER.indexOf(a) - DAY_PANEL_SOURCE_ORDER.indexOf(b))
    assert.deepEqual(sources, ordered, '来源顺序必须与 DAY_PANEL_SOURCE_ORDER 一致（界面按它渲染）')
  }
})

test('AX-T01 done / cancelled / 归档一律不进树；父链由调用方处理（本函数不过滤父子）', () => {
  const out = dayPanelTreeSources({
    tasks: [
      task({ id: 'done', statusCode: 'done', effectiveDueAt: iso(DAY_START + 3600_000) }),
      task({ id: 'cancelled', statusCode: 'cancelled', effectiveDueAt: iso(DAY_START + 3600_000) }),
      task({ id: 'archived', archived: 1, effectiveDueAt: iso(DAY_START + 3600_000) }),
      task({ id: 'child', parentId: 'done', effectiveDueAt: iso(DAY_START + 3600_000) }),
    ],
    planItems: [{ taskId: 'done' }, { taskId: 'cancelled' }],
    dayStartMs: DAY_START,
    dayEndMs: DAY_END,
  })
  assert.deepEqual(out.entries.map((e) => e.taskId), ['child'],
    'done/cancelled/归档即使到期或已排入也不进树；子任务自己到期仍然要进')
})

test('AX-T01 冻结口径：逾期**不是**来源 —— 只逾期（todo、未排入、未推进）不进树', () => {
  const overdueTodo = task({ id: 'overdue-todo', effectiveDueAt: iso(DAY_START - 86400_000) })
  const overdueDoing = task({ id: 'overdue-doing', statusCode: 'doing', effectiveDueAt: iso(DAY_START - 86400_000) })
  const out = dayPanelTreeSources({
    tasks: [overdueTodo, overdueDoing],
    planItems: [],
    dayStartMs: DAY_START,
    dayEndMs: DAY_END,
  })
  const byId = new Map(out.entries.map((e) => [e.taskId, e.sources]))
  assert.equal(byId.has('overdue-todo'), false,
    '逾期且不在推进、未排入 → 按 2026-10-01 冻结口径不进树（是否加第 4 个来源待用户定案，别顺手加）')
  assert.deepEqual(byId.get('overdue-doing'), ['doing'], '逾期 + 进行中 → 靠"进行中"这一来源进来')
})

test('AX-T01 计划项指向的任务已不存在 → 记进 missingTaskIds（树里不渲染，但要能说清为什么少了）', () => {
  const out = dayPanelTreeSources({
    tasks: [task({ id: 'exists', effectiveDueAt: iso(DAY_START + 3600_000) })],
    planItems: [{ taskId: 'exists' }, { taskId: 'gone' }],
    dayStartMs: DAY_START,
    dayEndMs: DAY_END,
  })
  assert.deepEqual(out.missingTaskIds, ['gone'])
})

test('AX-T01 脏截止串：既不算"当日到期"也不静默当"无截止"，留诊断', () => {
  const dirty = task({ id: 'dirty', title: '坏截止', statusCode: 'doing', effectiveDueAt: '不是时间' })
  const out = dayPanelTreeSources({ tasks: [dirty], planItems: [], dayStartMs: DAY_START, dayEndMs: DAY_END })
  assert.deepEqual(out.entries.map((e) => e.sources), [['doing']], '脏 due 仍按"进行中"进树')
  assert.equal(out.diagnostics.length, 1)
  assert.equal(out.diagnostics[0].code, 'due-unparseable')
  assert.equal(out.diagnostics[0].taskId, 'dirty')
})

test('classifyTaskDay 的边界：dayStart 含、dayEnd 不含（午夜归属只有一处口径）', () => {
  const at = (ms) => classifyTaskDay({
    effectiveDueAt: iso(ms), statusCode: 'todo', planned: false, dayStartMs: DAY_START, dayEndMs: DAY_END,
  })
  assert.equal(at(DAY_START).dueToday, true, '当日 00:00:00.000 属于这一天')
  assert.equal(at(DAY_END - 1).dueToday, true, '23:59:59.999 仍属于这一天')
  assert.equal(at(DAY_END).dueToday, false, '次日 00:00 不属于这一天')
  assert.equal(at(DAY_START - 1).overdue, true, '前一天 23:59:59.999 是逾期')
  assert.equal(at(DAY_END).overdue, false)
  const noDue = classifyTaskDay({ effectiveDueAt: null, statusCode: 'todo', planned: false, dayStartMs: DAY_START, dayEndMs: DAY_END })
  assert.deepEqual([noDue.dueToday, noDue.overdue, noDue.dueUnparseable], [false, false, false], '无截止不是"逾期"也不是"脏值"')
})

test('dayPanelSourceLabel: 行标签由唯一实现给出', () => {
  assert.equal(dayPanelSourceLabel('due'), '到期')
  assert.equal(dayPanelSourceLabel('plan'), '计划')
  assert.equal(dayPanelSourceLabel('doing'), '进行中')
  assert.deepEqual([...DAY_PANEL_SOURCE_ORDER], ['due', 'plan', 'doing'])
})
