import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CAPACITY_EXPECTED, CAPACITY_FIXTURE, CAPACITY_NOW,
} from './fixtures/capacityFixture.mjs'
import { computeTodayCapacity } from '../lib/client/capacity.js'
import {
  CapacityRulePanel, capacityAriaLabel, capacitySourceLabels,
} from '../lib/client/components/CapacityRulePanel.js'

/**
 * 面板层测试：用 `react-dom/server` 把组件**真的渲染成 HTML** 再断言。
 *
 * 比源码扫描强：断言的是"页面上渲染出什么"。本任务的价值就是"把规则与账本摆到用户面前"，
 * 所以"文案在不在渲染结果里"必须由渲染测试守，而不是靠 grep 源码。
 */

function renderPanel(overrides = {}) {
  const capacity = computeTodayCapacity({
    tasks: CAPACITY_FIXTURE.tasks.map((task) => ({ ...task })),
    dailyCapacityMinutes: CAPACITY_FIXTURE.dailyCapacityMinutes,
    defaultEstimateMinutes: CAPACITY_FIXTURE.defaultEstimateMinutes,
    includeOverdue: false,
    now: CAPACITY_NOW,
    ...overrides,
  })
  const html = renderToStaticMarkup(createElement(CapacityRulePanel, {
    capacity,
    dailyCapacityMinutes: CAPACITY_FIXTURE.dailyCapacityMinutes,
    defaultEstimateMinutes: CAPACITY_FIXTURE.defaultEstimateMinutes,
    includeOverdue: false,
    onIncludeOverdueChange: () => {},
    expanded: true,
    onExpandedChange: () => {},
    ...overrides.panelProps,
  }))
  return { capacity, html }
}

test('紧凑态：页面上就显示基准数字 420，且规则正文不渲染', () => {
  const { capacity, html } = renderPanel({ panelProps: { expanded: false } })
  assert.equal(capacity.planned, CAPACITY_EXPECTED.default.planned, '基准先自检：夹具算出来必须是 420')
  assert.match(html, /已排 <b>420<\/b> min/, '紧凑态就要能看到「已排 420 min」')
  assert.match(html, /可投入 <b>300<\/b> min/)
  assert.match(html, /余 <b>0<\/b> min/)
  assert.match(html, /超支/, '已排 > 可投入 要标超支')
  assert.match(html, /⌄ 规则/, '有展开入口')
  assert.doesNotMatch(html, /算哪些任务/, '收起时规则正文不渲染（省空间）')
  assert.doesNotMatch(html, /wb-cap-audit/, '收起时账本不渲染')
})

test('展开态：七条规则逐条可见（含继承 / 全天 / 逾期三条关键口径）', () => {
  const { html } = renderPanel()
  for (const title of ['算哪些任务', '截止时间会沿任务树继承', '今天到期', '无截止但在推进', '逾期的默认不计入', '每条任务算多少分钟', '汇总口径']) {
    assert.ok(html.includes(title), `规则「${title}」必须在页面上`)
  }
  assert.match(html, /「全天」只影响显示与重复锚点，不改变容量计算/, '全天口径要写清（这是任务第 2 点的答案）')
  assert.match(html, /它和「今天到期」互不重叠，不会算两遍/, '逾期与今天到期互斥要写清')
})

test('展开态：账本逐条列出计入任务，表尾合计 = 已排', () => {
  const { html } = renderPanel()
  // 5 行计入（T1/T2/T3/T7/T11），每条的标题都要出现
  for (const id of CAPACITY_EXPECTED.default.includedIds) {
    assert.ok(html.includes(`>${id}<`), `账本里要有 ${id}`)
  }
  // 行数用 `<td` 数而不是 `<tr` 数：每个表还有一个表头 `<tr>`（含 `<th>`），
  // 拿 `<tr>` 当"数据行"会多算账本的个数 —— 测试口径自己也要防错
  const cells = html.match(/<td /g) ?? []
  assert.equal(cells.length, (5 + 2) * 4, `账本数据单元格 = (计入 5 + 逾期 2) × 4 列，实际 ${cells.length}`)
  assert.match(html, /合计 = 已排 <b>420<\/b> min/, '表尾合计必须等于已排')
  // 来源标记（逐字）
  for (const label of ['今天到期', '无截止·推进中', '按默认 30', '全天', '继承父任务截止']) {
    assert.ok(html.includes(label), `来源标记缺「${label}」`)
  }
})

test('展开态：逾期区显示条数与分钟，且开关是「未勾选」起手（默认不计入）', () => {
  const { html } = renderPanel()
  assert.match(html, /逾期未完成 <b>2<\/b> 条 \/ <b>960<\/b> min —— 默认不计入「已排」/, '逾期区读数要写清"默认不计入"')
  assert.match(html, /把逾期任务计入今日容量/, '开关文案逐字')
  // 默认关：checkbox 没有 checked 属性
  const checkbox = html.match(/<input type="checkbox"[^>]*>/)
  assert.ok(checkbox !== null, '有开关')
  assert.doesNotMatch(checkbox[0], /checked/, '默认必须是关的（方案 C：默认不计入）')
})

test('打开开关后：徽标变勾选、planned 变 1380，逾期区消失（都进了「已排」）', () => {
  const { capacity, html } = renderPanel({ includeOverdue: true, panelProps: { expanded: true, includeOverdue: true } })
  assert.equal(capacity.planned, CAPACITY_EXPECTED.includeOverdue.planned, '基准：开关开 → 1380')
  assert.match(html, /已排 <b>1380<\/b> min/, '页面上要显示 1380')
  assert.match(html, /<input type="checkbox"[^>]*checked/, '开关显示为已勾选')
  assert.doesNotMatch(html, /逾期未完成/, '逾期区不渲染（没有逾期被排除）')
  assert.match(html, /逾期计入/, '账本里要能看出 T5/T6 是"逾期计入"')
})

test('默认耗时改 60：文案跟着变（不是写死的 30，否则用户改了设置界面还在说谎）', () => {
  const { capacity, html } = renderPanel({
    defaultEstimateMinutes: 60,
    panelProps: { defaultEstimateMinutes: 60, includeOverdue: false },
  })
  assert.equal(capacity.planned, CAPACITY_EXPECTED.defaultEstimate60.planned, '基准：默认 60 → 480')
  assert.match(html, /已排 <b>480<\/b> min/)
  assert.match(html, /没填的按默认耗时 60 分钟/, '规则文案里的默认耗时必须取当前设置值')
  assert.match(html, /按默认 60/, '账本来源标记同理')
  assert.match(html, /默认耗时 60 分钟（在设置里改）/, '底部提示同理')
  assert.doesNotMatch(html, /默认耗时 30 分钟（在设置里改）/, '不许残留写死的 30')
})

test('aria-label 必须带上三个计数与逾期读数（读屏用户看到的口径与视觉一致）', () => {
  const { capacity } = renderPanel()
  const label = capacityAriaLabel(capacity)
  assert.match(label, /紧急 60 分钟、高 30 分钟、普通 300 分钟、低 30 分钟、空闲 0 分钟/)
  assert.match(label, /今天到期 4 条、无截止推进中 1 条、逾期未计入 2 条 \/ 960 分钟/)
  const { html } = renderPanel()
  assert.ok(html.includes('aria-label="' + label + '"'), 'aria-label 要真的渲染到容量条上')
  assert.match(html, /aria-expanded="true"/, '展开按钮要带 aria-expanded')
})

test('账本「来源」标记：一条任务可以同时命中多个（逾期计入 + 按默认 + 继承）', () => {
  const base = { id: 'x', title: 'x', statusCode: 'todo', minutes: 30, band: 'p2', estimated: null, usedFallback: true, allDay: false, overdueIncluded: false, inheritedDue: false, ghostFromCancelledAncestor: false, dueUnparseable: false, source: null, chainId: 'x' }
  assert.deepEqual(capacitySourceLabels({ ...base, source: 'due-today' }, 30), ['今天到期', '按默认 30'])
  assert.deepEqual(capacitySourceLabels({ ...base, source: 'no-due-doing', usedFallback: false }, 30), ['无截止·推进中'])
  assert.deepEqual(capacitySourceLabels({ ...base, overdueIncluded: true, inheritedDue: true, ghostFromCancelledAncestor: true, source: 'overdue-included' }, 60), ['逾期计入', '按默认 60', '继承自已取消父任务'])
  assert.deepEqual(capacitySourceLabels({ ...base, allDay: true, usedFallback: false, source: 'due-today' }, 30), ['今天到期', '全天'])
  assert.deepEqual(capacitySourceLabels({ ...base, dueUnparseable: true }, 30), ['截止时间无法解析', '按默认 30'])
})

test('面板不自己算：读数全部来自传入的 capacity（改 props 就改读数）', () => {
  // 造一个"与任何真实任务都无关"的 capacity：组件若自己算，就会算出别的数字
  const fake = {
    planned: 12345, free: 7, over: false, total: 12345,
    byPriority: { p0: 1, p1: 2, p2: 3, p3: 4 },
    counted: 1, dueTodayCount: 8, noDueDoingCount: 9, fallbackCount: 0,
    included: [], overdueExcluded: [], overdueMinutes: 0,
  }
  const html = renderToStaticMarkup(createElement(CapacityRulePanel, {
    capacity: fake,
    dailyCapacityMinutes: 999,
    defaultEstimateMinutes: 30,
    includeOverdue: false,
    onIncludeOverdueChange: () => {},
    expanded: true,
    onExpandedChange: () => {},
  }))
  assert.match(html, /已排 <b>12345<\/b> min/, '读数必须来自 props')
  assert.match(html, /可投入 <b>999<\/b> min/)
  assert.match(html, /今天没有计入的任务/, '空账本要给出可读的空态，而不是空白')
})

test('脏 due 串单独成区：既不算逾期，也不静默消失', () => {
  const dirty = {
    id: 'dirty', parentId: null, title: '截止时间坏了', statusCode: 'todo', priorityCode: 'p2',
    effectiveDueAt: 'abc', dueAt: 'abc', allDay: false, estimatedMinutes: 20, archived: false,
  }
  const capacity = computeTodayCapacity({
    tasks: [...CAPACITY_FIXTURE.tasks.map((t) => ({ ...t })), dirty],
    dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false, now: CAPACITY_NOW,
  })
  const html = renderToStaticMarkup(createElement(CapacityRulePanel, {
    capacity, dailyCapacityMinutes: 300, defaultEstimateMinutes: 30, includeOverdue: false,
    onIncludeOverdueChange: () => {}, expanded: true, onExpandedChange: () => {},
  }))
  assert.match(html, /截止时间无法解析 <b>1<\/b> 条/, '脏数据要有独立区块')
  assert.match(html, /逾期未完成 <b>2<\/b> 条 \/ <b>960<\/b> min/, '脏数据不许混进"逾期 N 条 / M min"读数（否则读数虚高）')
  assert.match(capacityAriaLabel(capacity), /逾期未计入 2 条 \/ 960 分钟/, 'aria-label 同理')
})
