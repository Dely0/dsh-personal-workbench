/**
 * T2/D09：「今日容量 · 规则与账本」面板（纯渲染 + 纯文案函数的测试）。
 *
 * 打的是**组件导出的小函数**（`capacitySourceLabel` / `capacityRowLabels` /
 * `capacityAriaLabel`）与真实渲染出的 HTML：面板只吃 props、不许自己算，
 * 所以这里也用纯函数的结果喂它（组件里若偷偷再算一遍，数字就会对不上）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CAPACITY_EXPECTED,
  CAPACITY_FIXTURE,
  CAPACITY_PLAN_A,
  CAPACITY_DAY_END,
  CAPACITY_DAY_START,
} from './fixtures/capacityFixture.mjs'
import { computeCapacityLedger } from '../lib/shared/dailyPlanPolicy.js'
import { CapacityRulePanel, capacityAriaLabel, capacityRowLabels, capacitySourceLabel } from '../lib/client/components/CapacityRulePanel.js'

function ledger(overrides = {}) {
  return computeCapacityLedger({
    tasks: CAPACITY_FIXTURE.tasks.map((task) => ({ ...task })),
    planItems: CAPACITY_PLAN_A.map((item) => ({ ...item })),
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

function render(capacity, props = {}) {
  return renderToStaticMarkup(createElement(CapacityRulePanel, {
    capacity,
    dailyCapacityMinutes: capacity.capacityMinutes,
    defaultEstimateMinutes: CAPACITY_FIXTURE.defaultEstimateMinutes,
    includeOverdue: false,
    onIncludeOverdueChange: () => {},
    expanded: true,
    onExpandedChange: () => {},
    ...props,
  }))
}

// ---------------------------------------------------------------------------
// 纯标签函数
// ---------------------------------------------------------------------------

test('来源标签逐字：AI 提案 / 手动排入 / 导入', () => {
  assert.equal(capacitySourceLabel('plan-ai'), 'AI 提案')
  assert.equal(capacitySourceLabel('plan-manual'), '手动排入')
  assert.equal(capacitySourceLabel('plan-imported'), '导入')
})

test('行标记：任务不存在 / 已完成 / 已取消 / 已归档 / 今日投入已结束', () => {
  assert.deepEqual(capacityRowLabels({ taskMissing: true, taskClosed: false, statusCode: 'missing', band: 'p2', minutes: 10, effortDone: false, order: 1, title: 'x', source: 'plan-ai' }), ['任务不存在'])
  assert.deepEqual(capacityRowLabels({ taskMissing: false, taskClosed: true, statusCode: 'done', band: 'p2', minutes: 10, effortDone: true, order: 1, title: 'x', source: 'plan-ai' }), ['任务已完成', '今日投入已结束'])
  assert.deepEqual(capacityRowLabels({ taskMissing: false, taskClosed: true, statusCode: 'cancelled', band: 'p2', minutes: 10, effortDone: false, order: 1, title: 'x', source: 'plan-ai' }), ['任务已取消'])
  assert.deepEqual(capacityRowLabels({ taskMissing: false, taskClosed: true, statusCode: 'archived', band: 'p2', minutes: 10, effortDone: false, order: 1, title: 'x', source: 'plan-ai' }), ['任务已归档'])
  assert.deepEqual(capacityRowLabels({ taskMissing: false, taskClosed: false, statusCode: 'doing', band: 'p2', minutes: 10, effortDone: false, order: 1, title: 'x', source: 'plan-ai' }), [])
})

test('aria-label 把已排/已结束/未排入三个口径说全（读屏与视觉同口径）', () => {
  const label = capacityAriaLabel(ledger())
  assert.match(label, /已排 5 条 \/ 360 分钟/)
  assert.match(label, /今日投入已结束 0 分钟/)
  assert.match(label, /未排入 3 条 \/ 建议投入合计 105 分钟/)
})

test('aria-label 在计划不可解析时直说"不可计算"，不给假 0', () => {
  const label = capacityAriaLabel(ledger({ planItems: [], planReadable: false, reason: 'items_json 不是合法 JSON' }))
  assert.match(label, /不可计算/)
  assert.match(label, /不是合法 JSON/)
})

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

test('展开后有账本明细：每行给分钟与来源，合计等于已排', () => {
  const html = render(ledger())
  assert.match(html, /已排明细（5 条 \/ 合计 360 min）/)
  assert.match(html, /合计 = 已排 <b>360<\/b> min/)
  assert.match(html, /AI 提案/)
  // S4 的计划投入是 60（不是它的估时 45）
  assert.match(html, />60</)
})

test('未排入区列出完整候选与建议投入（不截断），并给一键排入按钮', () => {
  const html = render(ledger(), { onAddToPlan: async () => undefined })
  assert.match(html, /未排入候选 <b>3<\/b> 条 \/ 建议投入合计 <b>105<\/b> min/)
  assert.match(html, /排入今日/)
  assert.match(html, /建议投入/)
})

test('无计划时：已排 0，但未排入区仍在，并说清"已排 = 0"', () => {
  const html = render(ledger({ planItems: [], planExists: false }))
  assert.match(html, /已排 <b>0<\/b> min（0 条，已结束 0 min）/)
  assert.match(html, /今天还没有排入任何计划投入/)
  assert.match(html, /未排入候选 <b>8<\/b> 条/)
})

test('计划不可解析：显式报"不可计算"并说明原数据未改动，不画账本合计', () => {
  const html = render(ledger({ planItems: [], planReadable: false, reason: 'items_json 不是数组' }))
  assert.match(html, /今日容量不可计算/)
  assert.match(html, /items_json 不是数组/)
  assert.match(html, /原数据没有被改动/)
})

test('规则文案与 ADR 0002 同步：逐条说出"只算计划""快照""历史不减""开关不改已排"', () => {
  const html = render(ledger())
  for (const text of [
    '「已排」只算当天计划',
    '计划投入是快照',
    '历史投入不自动减',
    '未排入只是候选',
    '逾期不改变已排',
    '不含实际工时',
    '提醒与日历不受影响',
  ]) {
    assert.ok(html.includes(text), `规则文案缺：${text}`)
  }
  assert.match(html, /显示逾期待办候选/, '开关文案必须改成"显示逾期待办候选"')
  assert.doesNotMatch(html, /把逾期任务计入今日容量/, '旧文案不许残留')
})

test('已排明细逐条与纯函数一致（组件不许再算一遍）', () => {
  const capacity = ledger()
  const html = render(capacity)
  for (const row of capacity.plannedItems) {
    assert.ok(html.includes(`>${row.minutes}<`), `${row.taskId} 的分钟必须来自纯函数`)
  }
  assert.equal(capacity.plannedItems.reduce((sum, row) => sum + row.minutes, 0), capacity.planned)
  assert.equal(capacity.planned, CAPACITY_EXPECTED.planA.planned)
})

/**
 * 「显示逾期待办候选」开关的**勾选态必须来自 props**。
 *
 * 为什么单独钉一条（2026-10-02）：变异探针里"把开关取值换成常量 includeOverdue=false"
 * 与"把 checked 写死 false"两种缺陷装回去时，**所有既有判据都是绿的** ——
 * 也就是说"这个开关是不是真控件"没人守得住（用户可见的静默失效：点了不勾）。
 * 这里用 SSR 出的 HTML 直接看 `checked` 属性：settings 说开就必须勾上。
 */
test('逾期开关的勾选态来自 props（不是写死的常量）—— 开关不许变成假控件', () => {
  const on = render(ledger(), { includeOverdue: true })
  assert.match(on, /type="checkbox"[^>]*checked/, 'props 说开 → 必须渲染成已勾选')
  const off = render(ledger(), { includeOverdue: false })
  assert.doesNotMatch(off, /type="checkbox"[^>]*checked/, 'props 说关 → 不许勾选')
})
