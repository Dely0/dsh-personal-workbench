/**
 * 接线不变量（源码级扫描）—— T2/D09、AX-C06、AX-G02。
 *
 * 本项目最大的 bug 类别是"同一个语义被独立计算多次"：本次改造把「当日候选」
 * 收进 `src/shared/dailyPlanPolicy.ts`，而它有三个消费点（AI 排序 / 手动池 /
 * 容量未排入区）。**"不存在第二处实现"只能用扫描证明**，所以这里逐条钉住：
 *
 * 1. 候选判定只有 `planCandidates` 一份实现；
 * 2. `index.tsx` 不再内联"今天到期/doing/无截止"那套 filter，也不再 `.slice(0, 30)`；
 * 3. 30 条上限只有 `selectPromptCandidates` 一份，且 `dailyPlanPrompt.ts` 不自己 slice；
 * 4. `client/capacity.ts` 变成薄接线：不求和、不判 open、不内联默认耗时；
 * 5. 容量组件不自己 reduce，面板拿到的候选就是共享函数的输出。
 *
 * 绝不断言行号（本项目明确禁止脆行号断言），只按符号与调用点断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAX_ESTIMATE_MINUTES, DEFAULT_ESTIMATE_MINUTES } from '../lib/client/capacity.js'

/**
 * ⚠️ 行尾归一化：Windows 检出是 CRLF，而下面所有片段/正则是按 `\n` 写的。
 * 不归一化就会出现"片段明明在源码里、`includes` 却说不存在"的假红。
 */
const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const indexSource = read('src/client/index.tsx')
const capacitySource = read('src/client/capacity.ts')
const policySource = read('src/shared/dailyPlanPolicy.ts')
const promptSource = read('src/client/dailyPlanPrompt.ts')
const panelSource = read('src/client/components/CapacityRulePanel.tsx')
const planPanelSource = read('src/client/components/PlanPanel.tsx')
// D17/P3-2：任务详情区的 JSX 搬进 `views/TaskDetailPane.tsx`，"编辑框初值"那条判据跟着实现走。
const taskDetailPaneSource = read('src/client/views/TaskDetailPane.tsx')
// D17/P4：日期域（候选快照 / 容量账本 / 提示词 payload）搬进 `hooks/useDayWorkspace.ts`，
// 下面凡是从前扫 `index.tsx` 的实现类判据全部跟着实现走 —— 不是放宽，owner 换人了而已。
const daySource = read('src/client/hooks/useDayWorkspace.ts')

/** 去掉注释：避免"注释里提到某个写法"被当成代码里的实现/第二处实现。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1')
}

// ---------------------------------------------------------------------------
// 唯一实现
// ---------------------------------------------------------------------------

test('AX-G02 候选判定只有一份实现：dailyPlanPolicy.ts 导出，client 只是接线', () => {
  assert.match(policySource, /export function planCandidates\(/, '权威实现必须在共享模块里')
  assert.equal((policySource.match(/export function planCandidates\(/g) ?? []).length, 1)
  // 客户端不许再定义自己的候选函数
  assert.doesNotMatch(capacitySource, /export function planCandidates\(/)
  assert.doesNotMatch(indexSource, /function planCandidates\(/)
})

test('AX-G02 index.tsx 不再内联"今天到期/doing/无截止"那套候选 filter', () => {
  const code = stripComments(indexSource)
  // 旧实现的特征：按 effectiveDueAt 与 planDayEnd 比较、以及"今天且无截止"这条腿
  assert.doesNotMatch(code, /planDayEnd\.getTime\(\)/, '不许再内联按截止过滤的候选公式')
  assert.doesNotMatch(code, /planCandidates\b(?!Info|For)/, '不许再内联名为 planCandidates 的过滤结果')
  assert.doesNotMatch(code, /todayPlanCandidates\(/, 'D17/P4 后入口不许自己调候选函数（owner 是日期域 hook）')
  assert.match(stripComments(daySource), /todayPlanCandidates\(/, '候选必须走共享函数（经 client/capacity.ts 接线）')
})

test('AX-C02 30 条上限只有一份：selectPromptCandidates；调用点不许自己 slice', () => {
  assert.match(policySource, /export function selectPromptCandidates\(/)
  // 共享模块里除"定义"外**只允许**在 planCandidates 附近出现；客户端不许再实现一遍
  assert.doesNotMatch(stripComments(capacitySource), /selectPromptCandidates/)
  assert.match(promptSource, /selectPromptCandidates\(/, '提示词模块必须复用共享的截断口径')
  assert.doesNotMatch(stripComments(promptSource), /\.slice\(0, *30\)/, '提示词模块不许自己截断')
  assert.doesNotMatch(stripComments(capacitySource), /slice\(0, *30\)/, '容量接线不许截断候选')
  assert.doesNotMatch(stripComments(indexSource), /slice\(0, *30\)/, 'index.tsx 不许再静默截断候选')
  assert.equal((stripComments(policySource).match(/\.slice\(0, safeLimit\)/g) ?? []).length, 1, '截断只许有一处')
})

test('AX-C02 截断提示必须同时出现在提示词与发起窗口（不宣称全量）', () => {
  // 唯一的提示文案在共享模块里（"另有 N 条未列出"），提示词模块只负责把它贴进 prompt
  assert.match(policySource, /另有 \$\{omitted\} 条未列出/)
  assert.match(promptSource, /\$\{notice\} —— 未列出的条目/)
  assert.match(promptSource, /不要声称已对全量做排序/)
  /**
   * ⚠️ 2026-10-01 更新（批次2 D15）：发起窗口的提示从 `index.tsx` 的两处内联
   *（todayPromptInfo / pickedPromptInfo）经**数据层** `dayPanelModel.ts` 送进
   * 日期面板组件 `DayPanel.tsx`。判据跟着实现走、**不是放宽**：
   * 要求的仍然是"截断时界面必须说出来"，所以三段链路都要在 ——
   * index.tsx 把两个视图的提示都交给模型、模型按当前视图选一个、面板把它显示出来。
   * ⚠️ D17/P4：第三段（把两个提示交给数据层）的落点随实现搬进 `hooks/useDayWorkspace.ts`。
   */
  assert.match(daySource, /todayPromptInfo,\n\s+pickedPromptInfo,/, '日期域必须把两个视图的截断信息都交给数据层')
  const model = readFileSync(new URL('../src/client/dayPanelModel.ts', import.meta.url), 'utf8')
  assert.match(model, /const promptInfo = isTodayView \? todayPromptInfo : pickedPromptInfo/,
    '数据层必须按当前视图给出对应的截断信息（两处各判一遍就是"同一语义两处实现"）')
  const dayPanel = readFileSync(new URL('../src/client/components/DayPanel.tsx', import.meta.url), 'utf8')
  assert.match(dayPanel, /promptInfo\.truncated/, '日期面板必须在截断时显示提示（不宣称全量）')
  assert.match(dayPanel, /role="status"/, '提示要带 role=status（无障碍与判据都要）')
})

test('AX-C06 客户端容量接线是薄的：不求和、不判 open、不内联默认耗时', () => {
  const code = stripComments(capacitySource)
  assert.doesNotMatch(code, /if \(task\.archived === true\) continue/, '归档过滤必须在共享函数里')
  assert.doesNotMatch(code, /statusCode === 'done'/, 'open 判定必须复用共享函数')
  assert.doesNotMatch(code, /estimatedMinutes \?\? 30/, '默认投入取值必须在共享函数里')
  assert.doesNotMatch(code, /\breduce\(/, '容量接线不许自己求和')
  assert.match(code, /computeCapacityLedger\(/, '唯一实现是共享模块的 computeCapacityLedger')
})

test('AX-C06 容量组件只吃 props：不 reduce、不自己判今天到期', () => {
  const code = stripComments(panelSource)
  assert.doesNotMatch(code, /\.reduce\(/, '面板不许再算合计')
  assert.doesNotMatch(code, /effectiveDueAt/, '面板不许自己判到期/逾期')
  assert.doesNotMatch(code, /estimatedMinutes/, '面板不许自己取估时')
  assert.match(code, /capacity\.plannedItems/, '账本直接渲染纯函数给的明细')
  assert.match(code, /capacity\.unscheduled/, '未排入区直接渲染纯函数给的候选')
})

test('AX-C06 手动池（PlanPanel）不再内联候选过滤，吃父级喂的 candidateTasks', () => {
  const code = stripComments(planPanelSource)
  assert.match(code, /candidateTasks/, '手动池候选必须由父级用共享函数算好传进来')
  assert.doesNotMatch(code, /statusCode !== 'done' && t\.statusCode !== 'cancelled'/, '不许再内联 open 过滤')
  assert.doesNotMatch(code, /effectiveDueAt/, '不许再自己判到期')
})

test('AX-C06 三个调用点都指向同一份候选：AI 排序 / 手动池 / 未排入区', () => {
  const code = stripComments(daySource)
  // 未排入区在 CapacityRulePanel 里由 capacity.unscheduled 渲染（父级用 computeTodayCapacity 算）
  assert.match(code, /computeTodayCapacity\(/)
  // 手动池候选
  assert.match(code, /todayPlanCandidateRows/)
  assert.match(code, /pickedPlanCandidateRows/)
  // AI 排序提示词
  assert.match(code, /buildPlanPrompt\(/)
  // D17/P4：4 处调用（candidatesFor 里的候选快照 + 今日候选行 + picked 候选行 + 提示词 memo）。
  // 数不变、落点从入口换成日期域 —— 「同一份候选函数」这个要求本身没动。
  assert.equal((code.match(/todayPlanCandidates\(/g) ?? []).length, 3, '三个入口共用同一份候选函数')
})

// ---------------------------------------------------------------------------
// 口径不变量
// ---------------------------------------------------------------------------

test('容量 memo 依赖日键而不是 `now` 对象（放进去等于每帧失效）', () => {
  // D17/P4：memo 本体搬进日期域 hook，但"依赖日键、不许放 now 对象"这条口径逐字不变。
  const start = daySource.indexOf('computeTodayCapacity(')
  assert.ok(start > 0)
  const end = daySource.indexOf('}),', start)
  const depsStart = daySource.indexOf('[', end)
  const depsEnd = daySource.indexOf(']', depsStart)
  const deps = daySource.slice(depsStart, depsEnd)
  assert.match(deps, /capacityTodayKey\(now\)/)
  assert.doesNotMatch(deps, /,\s*now\s*,/)
  assert.match(deps, /todayPlan/, '计划变了必须重算容量（已排来自计划快照）')
})

test('容量 memo 喂的是**全量**任务列表（归档过滤在共享函数里）', () => {
  const start = daySource.indexOf('computeTodayCapacity(')
  const end = daySource.indexOf('}),', start)
  const call = daySource.slice(start, end)
  // D17/P3-1/P4：归档集合的可写状态归 `hooks/useTaskListModel.ts`，入口读它的**只读快照**再作为
  // 日期域入参传入（同一语义一处实现）；入口仍原样传 `taskList.archivedTasks`。
  assert.match(call, /tasks: \[\.\.\.tasks, \.\.\.archivedTasks\]/)
  assert.match(call, /plan: todayPlan === null \? null : \{ \.\.\.todayPlan/)
  assert.match(indexSource, /archivedTasks: taskList\.archivedTasks,/, '入口必须把归档快照透传，不许自己再算一份')
})

test('一分钟口径只有一处：DEFAULT / MAX 与共享模块同值', () => {
  assert.equal(DEFAULT_ESTIMATE_MINUTES, 30)
  assert.equal(MAX_ESTIMATE_MINUTES, 1440)
  assert.match(policySource, /export const DEFAULT_PLAN_MINUTES = 30/)
  assert.match(policySource, /export const MAX_PLAN_MINUTES = 1440/)
  assert.match(capacitySource, /DEFAULT_ESTIMATE_MINUTES = DEFAULT_PLAN_MINUTES/)
})

test('逾期开关只影响候选：容量函数的 planned 与它无关（源码级：ledger 入参里没有开关就改不了已排）', () => {
  const code = stripComments(policySource)
  // computeCapacityLedger 内已排只累加计划项 minutes，includeOverdue 只传给 planCandidates
  assert.match(code, /planned \+= minutes/)
  assert.match(code, /const candidateResult = planCandidates\(\{/)
  assert.equal((code.match(/planned \+= minutes/g) ?? []).length, 1, '已排只允许累加一次（在计划项循环里）')
})

/**
 * 编辑耗时的四个**接线点**：保存 payload / 编辑框初值 / 就地校验 / 乐观更新。
 *
 * 为什么要源码扫描而不是行为测试（2026-10-02 补，来自变异探针的反向验证）：
 * 这四处都在 `index.tsx` 的事件处理器里，而 `react-dom/server` 渲染不到交互 ——
 * 变异探针把任一处装回缺陷版时，纯函数测试与组件渲染测试**全都是绿的**
 *（实测 I2/I3/I4/I5 四条变异集体存活）。项目纪律：能搬进纯模块的就搬；
 * 搬不动的（宿主交互接线）用源码扫描钉住，并用探针反向验证"装回缺陷必须变红"。
 */
test('AX-C07 编辑耗时的四个接线点都在（保存 payload / 编辑框初值 / 就地校验 / 乐观更新）', () => {
  const code = stripComments(indexSource)
  assert.match(code, /estimatedMinutes,\n\s+allDay: editDraft\.allDay,/,
    '保存 payload 必须带上 estimatedMinutes —— 否则"编辑耗时"保存不进去（静默丢字段）')
  assert.match(stripComments(taskDetailPaneSource), /estimatedMinutes: selected\.task\.estimatedMinutes === null \? '' : String\(selected\.task\.estimatedMinutes\)/,
    '编辑框初值必须来自库里真实值 —— 写死空串等于打开编辑框看不见真实值（D17/P3-2 后这一行在详情面板里）')
  assert.doesNotMatch(code, /estimatedMinutes: selected\.task\.estimatedMinutes/,
    '入口不再保留第二份"编辑框初值"（同一语义只有一个 owner，D17/P3-2）')
  assert.match(code, /estimated !== null && \(!Number\.isFinite\(estimated\) \|\| estimated < 1 \|\| estimated > MAX_ESTIMATE_MINUTES\)/,
    '客户端必须就地校验非法耗时 —— 否则只能靠服务端 400 猜')
  assert.match(code, /\{ \.\.\.task, estimatedMinutes, allDay: editDraft\.allDay \}/,
    '乐观更新必须把新耗时写回列表 —— 否则要刷新页面才看到「已排」变')
})
