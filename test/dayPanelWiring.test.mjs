/**
 * 批次2 D14 / AX-T02：日期来源判定**只有一份实现**（源码扫描）。
 *
 * 为什么只能靠扫描证明：`planCandidates` 与 `dayPanelTreeSources` 都可能"看起来各自算对了"，
 * 但只有"两处都调同一个 `classifyTaskDay`"才能保证**改了工作日界/状态口径不会只改一半**。
 *
 * 注：D15 会把客户端那份 `planKeep`（`index.tsx` 里今日/日历的当日过滤）也收进城建树，
 * 那时本文件要加一条"客户端不许再出现第二份来源公式"的判据 —— 现在还没有，所以先不写假的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const POLICY = readFileSync(join(root, 'src/shared/dailyPlanPolicy.ts'), 'utf8')

const count = (source, pattern) => (source.match(pattern) ?? []).length

test('AX-T02: 候选池与日期面板树共用 classifyTaskDay（唯一口径）', () => {
  assert.equal(count(POLICY, /export function classifyTaskDay\(/g), 1, '判定函数只允许有一个定义')
  assert.ok(count(POLICY, /classifyTaskDay\(\{/g) >= 2,
    '至少两处调用：planCandidates（候选池）+ dayPanelTreeSources（日期面板树）共用同一口径')
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
