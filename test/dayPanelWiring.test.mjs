/**
 * 批次2 D14 / AX-T02：日期来源判定**只有一份实现**（源码扫描）。
 *
 * 为什么只能靠扫描证明：`planCandidates` 与 `dayPanelTreeSources` 都可能"看起来各自算对了"，
 * 但只有"两处都调同一个 `classifyTaskDay`"才能保证**改了工作日界/状态口径不会只改一半**。
 *
 * 2026-10-02 追加：三个任务页签（计划/逾期/未排期）的成员判定也必须在共享层
 *（`dayPanelTabMembers`），且**装配层与组件里不许再出现第二份判定**——
 * "逾期/未排期到底是谁"这种判定出现在组件里，就是下一次"同一语义两处实现"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const POLICY = read('src/shared/dailyPlanPolicy.ts')
const MODEL = read('src/client/dayPanelModel.ts')
const PANEL = read('src/client/components/DayPanel.tsx')
const INDEX = read('src/client/index.tsx')

const count = (source, pattern) => (source.match(pattern) ?? []).length

test('AX-T02: 候选池与日期面板树共用 classifyTaskDay（唯一口径）', () => {
  assert.equal(count(POLICY, /export function classifyTaskDay\(/g), 1, '判定函数只允许有一个定义')
  assert.ok(count(POLICY, /classifyTaskDay\(\{/g) >= 3,
    '至少三处调用：planCandidates + dayPanelTreeSources + dayPanelTabMembers 共用同一口径')
  assert.match(POLICY, /export function dayPanelTreeSources\(/, '日期面板树来源判定必须存在且可测')
})

test('AX-T02: 裸判定不许复活（Date.parse / 状态比较只允许在 classifyTaskDay 内）', () => {
  assert.equal(POLICY.includes('Date.parse(task.effectiveDueAt)'), false,
    '截止解析必须只在 classifyTaskDay 里出现一次；在别处再 parse 一遍就是"同一语义两处实现"')
  assert.equal(count(POLICY, /statusCode === 'doing' \|\|/g), 1,
    '"进行中"的状态判断只允许一处')
  // 兜底：候选池里不该再出现任何 dayStartMs/dayEndMs 的直接比较（那是 classifyTaskDay 的活）
  const planCandidatesBody = POLICY.slice(POLICY.indexOf('export function planCandidates('))
  assert.equal(/dayStartMs/.test(planCandidatesBody.replace(/input\.dayStartMs,?\s*$/gm, '')) && />\s*input\.dayStartMs/.test(planCandidatesBody), false,
    'planCandidates 里不许直接比较 dayStartMs（只能把它传给 classifyTaskDay）')
})

test('AX-T02: 三个页签的成员判定只有一处实现（dayPanelTabMembers 复用两个既有实现）', () => {
  assert.equal(count(POLICY, /export function dayPanelTabMembers\(/g), 1)
  const body = POLICY.slice(POLICY.indexOf('export function dayPanelTabMembers('))
  assert.match(body, /dayPanelTreeSources\(/, '「计划」成员必须复用既有实现，不许重写一遍筛选公式')
  assert.match(body, /classifyTaskDay\(\{/, '逾期判定必须走唯一口径')
  assert.equal(count(POLICY, /export function dayPanelExtraTabsAvailable\(/g), 1)
  assert.equal(count(POLICY, /export function resolveDayPanelTab\(/g), 1,
    '"过去日期落到哪个页签"只允许一处实现（装配层复位与组件兜底必须同一份）')
})

test('AX-T02: 装配层与组件都不做判定（不许自己 parse 截止、比状态、判逾期）', () => {
  for (const [name, source] of [['dayPanelModel.ts', MODEL], ['DayPanel.tsx', PANEL]]) {
    assert.equal(/Date\.parse\(/.test(source), false, `${name} 里不许出现 Date.parse（口径只能一处）`)
    assert.equal(/effectiveDueAt/.test(source), false, `${name} 里不许读 effectiveDueAt（逾期/到期判定在共享层）`)
    assert.equal(/archived/.test(source), false, `${name} 里不许自己判归档（isOpenTask 负责）`)
  }
})

test('AX-T02: 页签兜底落点两处都引用同一个函数，不许各写一遍三元表达式', () => {
  assert.ok(count(PANEL, /resolveDayPanelTab\(/g) >= 1, '组件渲染前必须用它兜底')
  assert.ok(count(INDEX, /resolveDayPanelTab\(/g) >= 1, '装配层把 state 收回来时必须用它（同一份判定）')
  assert.equal(/===\s*'overdue'\s*\?\s*'plan'/.test(PANEL), false, '不许在组件里内联一份兜底落点')
  assert.equal(/===\s*'overdue'\s*\?\s*'plan'/.test(INDEX), false, '不许在装配层里内联一份兜底落点')
})
