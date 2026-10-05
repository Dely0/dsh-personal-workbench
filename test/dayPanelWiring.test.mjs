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
const LIST = read('src/client/components/TaskList.tsx')
const INDEX = read('src/client/index.tsx')
const DAY = read('src/client/hooks/useDayWorkspace.ts')

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
  assert.ok(count(DAY, /resolveDayPanelTab\(/g) >= 1, '装配层把 state 收回来时必须用它（同一份判定）')
  assert.equal(/===\s*'overdue'\s*\?\s*'plan'/.test(PANEL), false, '不许在组件里内联一份兜底落点')
  assert.equal(/===\s*'overdue'\s*\?\s*'plan'/.test(DAY), false, '不许在装配层里内联一份兜底落点')
})

test('AX-T02: 行内「排入今日」不自己发请求（组件只回调，写入口仍只有一处）', () => {
  for (const [name, source] of [['TaskList.tsx', LIST], ['DayPanel.tsx', PANEL]]) {
    assert.equal(/fetch\(|api</.test(source), false,
      `${name} 里不许拼请求：行内动作只能回调，写入口是 hooks/useDayWorkspace.ts 的 addTaskToPlan（`+"`POST /plans/:date/items`"+`）`)
  }
  assert.ok(count(DAY, /addTaskToPlan/g) >= 2, '定义 + 导出必须成对出现（唯一写入口在日期域）')
  assert.equal(/const addTaskToPlan = /.test(INDEX), false,
    '定义只允许在日期域：装配层只能注入同一个 addTaskToPlan，不许自己再写一份')
  assert.ok(count(INDEX, /addTaskToPlan/g) >= 3,
    '解构 + 容量未排入区 + 行内「排入今日」必须复用同一个 addTaskToPlan（不一致就会多出一条写路径）')
  assert.equal(/onScheduleToday[\s\S]{0,200}?localDateString\(\)[\s\S]{0,80}?\/items/.test(PANEL), false,
    '组件里不许出现"自己算今天 + 自己请求"的写法')
})

/**
 * 2026-10-05 追加：清除某日计划漏了 `await refresh()`（用户实测：「清除」之后今日计划卡片与
 * 被排期的任务都还在）。
 *
 * 根因：`clearPlan` 只 bump `planRefreshKey`，而 `planRefreshKey` 只驱动**日历视图选中日**的
 * pickedPlan（那个 effect 在 `view !== 'calendar'` 时直接 return）；`todayPlan` 来自
 * `bootstrap`，只有任务数据域的 `refresh()` 会重拉它。
 *
 * 当时同一文件里还有一份**没接线**的 `clearTodayPlan`（DELETE 之后 `await refresh()`，写对了，
 * 但只被一句 `void clearTodayPlan` 丢掉）—— "同一件事两份实现，写对的那份没接线"正是本项目
 * 第一 bug 类别。所以这里既断言"只有一处实现"，也断言"它写完之后必须重新拉 bootstrap"。
 */
test('AX-T02: 清除某日计划只有一处实现，且写完之后必须重新拉 bootstrap', () => {
  /*
   * 只数**计划**的 DELETE：同文件里 reports 的删除也是一条 `method: 'DELETE'`，
   * 那是另一件事，不能拿总量当判据（会把无关的删除算进来）。
   */
  const deletePlan = /api\(`\/api\/workbench\/plans\/[^`]*`, \{ method: 'DELETE' \}\)/g
  assert.equal(count(DAY, deletePlan), 1,
    '清除计划的请求只允许有一处实现（两份实现时，写对的那份往往没接线）')
  /*
   * 判据落在**函数体**上而不是"DELETE 的下一行"：两者之间允许有解释性注释，
   * 否则以后想写清楚"为什么必须重拉"就会把判据弄红（判据不该绑定文本形态）。
   */
  const clearStart = DAY.indexOf('const clearPlan = ')
  assert.ok(clearStart > 0, 'clearPlan 必须存在（清除计划的唯一接线段）')
  const clearRest = DAY.slice(clearStart + 1)
  const clearNext = clearRest.indexOf('\n  const ')
  const clearBody = clearNext < 0 ? clearRest : clearRest.slice(0, clearNext)
  const deleteAt = clearBody.search(/\/api\/workbench\/plans\/[^`]*`, \{ method: 'DELETE' \}\)/)
  const refreshAt = clearBody.indexOf('await refresh()')
  assert.ok(deleteAt >= 0, '清除计划的 DELETE 必须发生在 clearPlan 里，不许挪到别处')
  assert.ok(refreshAt >= 0,
    'clearPlan 必须 await refresh()：todayPlan 来自 bootstrap，只 bump planRefreshKey 在「今日」视图上什么都刷不到')
  assert.ok(refreshAt > deleteAt, '必须**先** DELETE 再 refresh（否则刷到的还是旧计划）')
  for (const fn of ['addTaskToPlan', 'patchPlanItem', 'savePlan', 'clearPlan']) {
    const start = DAY.indexOf(`const ${fn} = `)
    assert.ok(start > 0, `${fn} 必须存在于日期域（计划写入的唯一落点）`)
    const rest = DAY.slice(start + 1)
    const next = rest.indexOf('\n  const ')
    const body = next < 0 ? rest : rest.slice(0, next)
    assert.match(body, /await refresh\(\)/,
      `${fn} 写完之后必须 await refresh()（漏一处就是"清除了、页面却还在"）`)
  }
})

/**
 * ADR0010：AI 侧的排期口径必须与写入校验同一句话 —— **只能排可执行叶子**。
 *
 * 为什么用扫描锁住：这句话在四个地方各写了一遍（工具体 description、系统提示词、
 * 客户端计划提示词、提示词构造器）。它们漂移的方式很隐蔽 —— 模型照旧被教"父子二选一"，
 * 于是提交的提案里带父任务、被校验整份拒绝，用户看到的是"AI 排不出计划"。
 */
test('ADR0010: AI 侧四处口径都只说「只能排可执行叶子」，不再教「同一父子链」', () => {
  const files = {
    'src/tools.ts': read('src/tools.ts'),
    'src/index.ts': read('src/index.ts'),
    'src/client/dailyPlanPrompt.ts': read('src/client/dailyPlanPrompt.ts'),
    'src/client/hooks/useWorkbenchAISessions.ts': read('src/client/hooks/useWorkbenchAISessions.ts'),
  }
  for (const [name, source] of Object.entries(files)) {
    assert.equal(source.includes('同一父子链'), false, `${name} 里不许再教"同一父子链二选一"（ADR0010 已改口径）`)
    assert.ok(source.includes('可执行叶子'), `${name} 必须把新口径说清：只能排可执行叶子`)
  }
  assert.match(files['src/tools.ts'], /整份拒绝/, '工具描述要写明代价：非叶子提案会被整份拒绝')
  assert.match(files['src/client/dailyPlanPrompt.ts'], /整份拒绝/, '提示词构造器同样要说清代价')
})

/**
 * 2026-10-05 实测踩到过两次：① `contextIdsOf(tree, isMember)` 的成员判定传成否定式 → **计划项
 * （叶子）自己反被灰化**；② 传成 `planItemIds`（真计划项）→ "进行中/今天到期但不是计划项"的
 * **单任务**也被当成上下文行、被灰化且不计入条数。用户拍板：**计划页签的灰行关掉**。
 * 这两条扫描把"计划页签不灰化"与"计数用计划树成员判定"钉住。
 */
test('ADR0010: 计划页签不灰化，且计数用的上下文判定必须是「计划树成员」', () => {
  const model = read('src/client/dayPanelModel.ts')
  assert.match(model, /contextIdsOf\(planTree, \(task\) => plannedIds\.has\(task\.id\)\)/,
    '计数用的上下文判定必须传计划树成员 plannedIds：传 planItemIds 会把进行中的单任务误判成上下文')
  assert.equal(/contextIdsOf\(planTree, \(task\) => !/.test(model), false, '不许用否定式成员判定')
  const panel = read('src/client/components/DayPanel.tsx')
  assert.equal(/activeTab === 'plan' \? planContextIds/.test(panel), false,
    '计划页签不再灰化（2026-10-05 用户拍板）：不许把 planContextIds 传给行渲染')
})
