/**
 * D01：共享进度校验与展示投影（纯模块，AX-P02 的纯函数部分）。
 *
 * 这里锁的都是**两个值空间**的边界：`0–99` 可存储、`100` 只表示"提交完成验收"。
 * 断言写得比"能跑"更细是有原因的：进度是被工具、HTTP、UI 三处消费的字段，
 * 任何一处把 100 当成"可以存的值"就会造出"库里 100、状态还是 doing"的鬼状态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPLETION_TRIGGER_PERCENT,
  MAX_PROGRESS_PERCENT,
  MIN_PROGRESS_PERCENT,
  checkProgressInput,
  childFacts,
  childFactsLabel,
  clampProgressForDisplay,
  isOpenTask,
  projectProgress,
} from '../lib/shared/taskProgress.js'
import {
  DEFAULT_PLAN_MINUTES,
  MAX_PLAN_MINUTES,
  MIN_PLAN_MINUTES,
  checkPlanMinutes,
  resolveDefaultPlanMinutes,
} from '../lib/shared/dailyPlanPolicy.js'

// ---------------------------------------------------------------------------
// checkProgressInput
// ---------------------------------------------------------------------------

test('checkProgressInput: 0/25/75/99 合法，且**不夹取**越界值', () => {
  for (const value of [0, 25, 50, 75, 99]) {
    assert.deepEqual(checkProgressInput(value), { ok: true, value }, `${value} 应当合法`)
  }
  assert.equal(MIN_PROGRESS_PERCENT, 0)
  assert.equal(MAX_PROGRESS_PERCENT, 99)
  assert.equal(COMPLETION_TRIGGER_PERCENT, 100)

  /**
   * 越界**必须报错**而不是夹成 99：夹取是"静默改写"，用户会以为写进去的是自己填的值。
   */
  for (const value of [-1, 101, 1000, 99.5, 0.5]) {
    const result = checkProgressInput(value)
    assert.equal(result.ok, false, `${value} 应当被拒绝`)
    assert.match(result.reason, /进度/, '原因要能直接给用户看（中文）')
  }
})

test('checkProgressInput: 100 单独给"请走验收路径"的原因（不是普通越界）', () => {
  const result = checkProgressInput(100)
  assert.equal(result.ok, false)
  assert.match(result.reason, /100 不是可存储的进度值/)
  assert.match(result.reason, /workbench_request_completion/)
})

test('checkProgressInput: 字符串/布尔/null/undefined/NaN/Infinity/非数字全部拒绝', () => {
  for (const value of ['50', '0', '', true, false, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, {}, []]) {
    const result = checkProgressInput(value)
    assert.equal(result.ok, false, `${JSON.stringify(value)} 应当被拒绝`)
    assert.equal(typeof result.reason, 'string')
    assert.ok(result.reason.length > 0)
  }
})

test('clampProgressForDisplay 只用于展示：脏值退回 0，越界夹到 99', () => {
  assert.equal(clampProgressForDisplay(42), 42)
  assert.equal(clampProgressForDisplay(120), 99)
  assert.equal(clampProgressForDisplay(-5), 0)
  assert.equal(clampProgressForDisplay(Number.NaN), 0)
  assert.equal(clampProgressForDisplay('50'), 0)
  assert.equal(clampProgressForDisplay(undefined), 0)
})

// ---------------------------------------------------------------------------
// 计划投入（D01 的另一半）
// ---------------------------------------------------------------------------

test('checkPlanMinutes: 1/90/1440 合法；0/1441/小数/字符串整份拒绝', () => {
  assert.equal(MIN_PLAN_MINUTES, 1)
  assert.equal(MAX_PLAN_MINUTES, 1440)
  for (const value of [1, 30, 90, 1440]) {
    assert.deepEqual(checkPlanMinutes(value), { ok: true, value })
  }
  for (const value of [0, -1, 1441, 1.5, '90', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true]) {
    const result = checkPlanMinutes(value)
    assert.equal(result.ok, false, `${JSON.stringify(value)} 应当被拒绝`)
    assert.match(result.reason, /计划投入/, '原因要说明是"计划投入"而不是"预计耗时"')
  }
})

test('resolveDefaultPlanMinutes: 任务合法估时优先，否则设置默认，最后 30 分钟', () => {
  assert.equal(DEFAULT_PLAN_MINUTES, 30)
  assert.equal(resolveDefaultPlanMinutes(600, 15), 600, '任务估时优先')
  assert.equal(resolveDefaultPlanMinutes(null, 15), 15, '没估时用设置默认')
  assert.equal(resolveDefaultPlanMinutes(0, 15), 15, '非法估时（0）不能当默认值')
  assert.equal(resolveDefaultPlanMinutes(1441, 15), 15, '越界估时不能当默认值')
  assert.equal(resolveDefaultPlanMinutes(null, null), 30, '两边都拿不到 → 30')
  assert.equal(resolveDefaultPlanMinutes(undefined, 0), 30, '设置值非法也退回 30')
})

// ---------------------------------------------------------------------------
// 直接子任务旁证
// ---------------------------------------------------------------------------

test('childFacts/childFactsLabel: cancelled 不计入 done，且单独列出取消数', () => {
  const facts = childFacts([{ statusCode: 'done' }, { statusCode: 'done' }, { statusCode: 'cancelled' }, { statusCode: 'todo' }])
  assert.deepEqual(facts, { total: 4, done: 2, cancelled: 1 })
  const label = childFactsLabel(facts)
  assert.match(label, /子任务 2\/4 已完成/)
  assert.match(label, /另 1 个已取消/)
  assert.equal(childFactsLabel(childFacts([])), null, '没有子任务就没有旁证')
})

// ---------------------------------------------------------------------------
// projectProgress（服务端与客户端共用的唯一判定）
// ---------------------------------------------------------------------------

const baseTask = { statusCode: 'doing', archived: 0, progressPercent: 40 }

test('projectProgress: done/cancelled 隐藏进度，只给终态文案（AX-P07 的判定部分）', () => {
  for (const [statusCode, label] of [['done', '已完成'], ['cancelled', '已取消']]) {
    const projection = projectProgress({ task: { ...baseTask, statusCode } })
    assert.equal(projection.state, 'hidden-terminal', `${statusCode} 不画进度条`)
    assert.equal(projection.terminalLabel, label)
    assert.equal(projection.pendingLabel, null)
    // 即使 pending 存在也不显示待验收：任务已经结束，完成显示优先。
    const withPending = projectProgress({ task: { ...baseTask, statusCode }, completion: { deferred: false } })
    assert.equal(withPending.pendingLabel, null)
  }
})

test('projectProgress: 已归档隐藏进度并标"已归档"', () => {
  const projection = projectProgress({ task: { ...baseTask, archived: 1 } })
  assert.equal(projection.state, 'hidden-archived')
  assert.equal(projection.terminalLabel, '已归档')
})

test('projectProgress: pending 显示待验收，deferred 显示待验收（暂存）', () => {
  assert.equal(projectProgress({ task: baseTask, completion: { deferred: false } }).pendingLabel, '待验收')
  assert.equal(projectProgress({ task: baseTask, completion: { deferred: true } }).pendingLabel, '待验收（暂存）')
  // 没有 completion 投影（= 旧服务端 / 没有草稿）→ 不显示徽标，也不假装在待验收
  assert.equal(projectProgress({ task: baseTask }).state, 'progress')
  assert.equal(projectProgress({ task: baseTask }).pendingLabel, null)
})

test('projectProgress: 子任务全完成但本任务未完成 → 给提示，且**不**改写进度', () => {
  const projection = projectProgress({
    task: baseTask,
    children: [{ statusCode: 'done' }, { statusCode: 'done' }],
  })
  assert.equal(projection.percent, 40, '旁证不得改写显式进度')
  assert.equal(projection.state, 'progress')
  assert.match(projection.hint, /子任务已全部完成/)
})

test('projectProgress: 子任务里有 cancelled 时**不算**全完成（取消 ≠ 工作已完成）', () => {
  const projection = projectProgress({
    task: baseTask,
    children: [{ statusCode: 'done' }, { statusCode: 'cancelled' }],
  })
  assert.equal(projection.hint, null, '有取消项就不该提示"全部完成"')
  assert.match(projection.childLabel, /另 1 个已取消/)
})

test('isOpenTask: 归档 / done / cancelled 之外都算 open', () => {
  assert.equal(isOpenTask({ statusCode: 'todo', archived: 0 }), true)
  assert.equal(isOpenTask({ statusCode: 'doing', archived: 0 }), true)
  assert.equal(isOpenTask({ statusCode: 'blocked', archived: 0 }), true)
  assert.equal(isOpenTask({ statusCode: 'done', archived: 0 }), false)
  assert.equal(isOpenTask({ statusCode: 'cancelled', archived: 0 }), false)
  assert.equal(isOpenTask({ statusCode: 'todo', archived: 1 }), false)
})
