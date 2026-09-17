import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAX_ESTIMATE_MINUTES, DEFAULT_ESTIMATE_MINUTES } from '../lib/client/capacity.js'

/**
 * 接线不变量（源码级扫描 + 源码抽取行为断言）。
 *
 * 纯函数由 `test/capacity.test.mjs` 逐条测；这里只锁**接线**上那些
 * "删掉也不会报错、但会让功能悄悄退化"的点 —— 本项目规范要求
 * 「政策要变成会失败的测试，不要写成注释」。
 *
 * 其中 M10（memo 依赖塞回 `now`）、M11（payload 丢 `estimatedMinutes`）、
 * M12（editDraft 初值改常量）都是"接线类"缺陷：纯函数全绿，功能照样坏。
 * 所以它们必须有**源码级**断言守着，`scripts/repro/probe-capacity-mutations.mjs`
 * 会把这三条变异装回去验证它们真的会变红。
 */
/**
 * ⚠️ 行尾归一化：Windows 检出是 CRLF，而下面所有片段/正则是按 `\n` 写的。
 * 不归一化就会出现"片段明明在源码里、`includes` 却说不存在"的假红（本项目已踩过一次）。
 */
const indexSource = readFileSync('src/client/index.tsx', 'utf8').replace(/\r\n/g, '\n')
const capacitySource = readFileSync('src/client/capacity.ts', 'utf8').replace(/\r\n/g, '\n')
const settingsSource = readFileSync('src/client/components/SettingsModal.tsx', 'utf8').replace(/\r\n/g, '\n')

/** 去掉注释：避免"注释里提到某个写法"被当成代码里的实现/第二处实现。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1')
}

/** 抽出 `computeTodayCapacity` 那次 `useMemo` 的依赖数组字面量。 */
function memoDepsLiteral(source) {
  const callStart = source.indexOf('computeTodayCapacity(')
  assert.ok(callStart > 0, 'index.tsx 里应该有 computeTodayCapacity 的调用')
  // 依赖数组是 useMemo 的第二个实参：调用结束（`}),`）之后紧跟的那个 `[`
  const callEnd = source.indexOf('}),', callStart)
  assert.ok(callEnd > callStart, '找不到 useMemo 调用的结束位置')
  const open = source.indexOf('[', callEnd)
  const close = source.indexOf(']', open)
  assert.ok(open > callEnd && close > open, '依赖数组应是一段字面量')
  return source.slice(open + 1, close)
}

/** 抽出 `computeTodayCapacity({...})` 那一段实参源码。 */
function capacityCallLiteral(source) {
  const start = source.indexOf('computeTodayCapacity(')
  assert.ok(start > 0, '调用存在')
  const end = source.indexOf('}),', start)
  assert.ok(end > start, '调用实参可定位')
  return source.slice(start, end)
}

/** 抽出 `saveEditDraft` 的**函数体**（这次调用的范围，不含后面的函数）。 */
function saveEditDraftBody(source) {
  const start = source.indexOf('const saveEditDraft = async (): Promise<void> => {')
  assert.ok(start > 0, 'saveEditDraft 存在')
  // 以它之后第一个 `\n  }\n` 作为函数体结束（组件内所有成员都是两级缩进）
  const end = source.indexOf('\n  }\n', start)
  assert.ok(end > start, 'saveEditDraft 函数体结束位置可定位')
  return source.slice(start, end)
}

test('唯一实现：容量算法只有 capacity.ts 一份，index.tsx 不再自己算', () => {
  const code = stripComments(indexSource)
  // 旧内联块的特征符号必须彻底消失（`?? 30` 逐处求和就是"第二份实现"的样子）
  assert.doesNotMatch(code, /capacityPlanned|capacityByPriority|capacityTotal|capacityFromPlan/, '旧的 4 处内联求和必须彻底删掉')
  assert.doesNotMatch(code, /capacityTodayTasks/, '旧的"先筛一遍再求和"必须删掉')
  assert.equal((code.match(/computeTodayCapacity\(/g) ?? []).length, 1, '唯一调用点')
  assert.match(capacitySource, /export function computeTodayCapacity/, '权威实现在纯函数模块里')
  /**
   * ⚠️ 这里**不**断言"全文搜不到 `estimatedMinutes ??`"：AI 计划提示词里有一处
   * `${t.estimatedMinutes ?? '未知'}`，那是**给模型看的文案兜底**，不是容量口径。
   * 断言把两者混为一谈就会为了让它变绿而去改一段无关代码 —— 库里已有的教训是
   * "别拿一个过宽的正则当政策"。所以这里锁的是**容量段自己的形状**：
   * 唯一调用点 + 容量块里没有逐处求和。
   */
  const capacityBlock = code.slice(code.indexOf('const capacity = useMemo'), code.indexOf('const saveDailyCapacity'))
  assert.doesNotMatch(capacityBlock, /estimatedMinutes/, '容量计算结果只能来自纯函数，页面里不许再碰这个字段')
  assert.doesNotMatch(capacityBlock, /\.reduce\(|\.filter\(/, '页面里不许再自己算一遍（只调用纯函数）')
})

test('接线：memo 依赖数组不含 now，改用日期字符串（否则每帧失效）', () => {
  const deps = memoDepsLiteral(indexSource)
  // 只要出现独立的 `now` 标识符就算退化（`capacityTodayKey(now)` 里那个被括号包住，不算独立）
  const bareNow = deps.split(',').map((part) => part.trim()).filter((part) => part === 'now')
  assert.deepEqual(bareNow, [], `依赖数组里不许直接放 now：${deps.trim()}`)
  assert.match(deps, /capacityTodayKey\(now\)/, '用日字符串代替 now（跨天才变）')
  assert.match(capacitySource, /export function capacityTodayKey/, '派生函数在纯函数模块里')
})

test('接线：传的是全量列表，过滤在函数内做（同一语义不许两处算）', () => {
  const call = capacityCallLiteral(indexSource)
  assert.match(call, /tasks: \[\.\.\.tasks, \.\.\.archivedTasks\]/, '传入任务全集')
  assert.doesNotMatch(call, /\.filter\(/, '调用点不许自己先滤一遍')
  assert.match(capacitySource, /if \(task\.archived === true\) continue/, '归档过滤在函数内')
  assert.match(capacitySource, /task\.statusCode === 'done' \|\| task\.statusCode === 'cancelled'\) continue/, 'done/cancelled 过滤在函数内')
})

test('死字段已删：`capacity.count` / `planCovered` 在 src/ 里 0 次出现', () => {
  const code = stripComments(indexSource)
  assert.doesNotMatch(code, /planCovered/, 'planCovered 从未被读取，已删')
  assert.doesNotMatch(code, /capacity\.count/, 'capacity.count 从未被读取，已删')
})

test('settings 初值补齐两个新键（漏了就是 undefined → 容量算成 NaN）', () => {
  const start = indexSource.indexOf('useState<WorkbenchSettings>(')
  assert.ok(start > 0, 'settings 初值存在')
  const literal = indexSource.slice(start, indexSource.indexOf('})', start))
  assert.match(literal, /defaultEstimateMinutes:/, '初值必须含 defaultEstimateMinutes')
  assert.match(literal, /dailyCapacityIncludeOverdue:/, '初值必须含 dailyCapacityIncludeOverdue')
  // 初值用共享常量而不是再写一个字面量 30，避免"常量改了初值没改"
  assert.match(literal, /defaultEstimateMinutes: DEFAULT_ESTIMATE_MINUTES/)
})

/**
 * `saveEditDraft` 是 4986 行组件里的**闭包**，`node --test` 导入不了 `index.tsx`
 * （它碰 `window`），所以沿用本项目既有的"从源码逐字抽出函数体 + 注入桩"的做法。
 * 抽不到就显式失败 —— 那说明接线改名了，测试必须跟着更新，而不是静默全绿。
 */
function extractSaveEditDraft() {
  const start = indexSource.indexOf('const saveEditDraft = async (): Promise<void> => {')
  assert.ok(start > 0, 'saveEditDraft 源码存在（抽不到即接线改名，需同步本测试）')
  const end = indexSource.indexOf('\n  }\n', start)
  assert.ok(end > start, 'saveEditDraft 函数体结束位置可定位')
  /**
   * 抽出来的是 **TypeScript** 源码，而 `new Function` 跑的是 JS —— 必须先把
   * 类型注解去掉（`async (): Promise<void> =>`），否则构造时就 `SyntaxError`，
   * 表现是"三条测试全报 Unexpected token ':'"，很容易被误读成产品代码坏了。
   */
  return indexSource
    .slice(start, end + 4)
    .replace('async (): Promise<void> =>', 'async () =>')
    .replace('const payload: Record<string, unknown> =', 'const payload =')
}

/** 把抽出来的源码包成真函数：注入它实际用到的那几个外部符号。 */
function makeSaveEditDraft({ editDraft, selected, settings, patchTask, setTasks, setEditDraft, pushToast }) {
  const body = extractSaveEditDraft()
  // 文案函数与常量来自模块作用域：常量用**真值**（import 自 lib），
  // 文案函数用同构复刻（`index.tsx` 碰 window，测试里 import 不了它）
  const estimateRangeMessage = (defaultMinutes) => `耗时必须是 1–1440 之间的整数（留空表示用默认 ${defaultMinutes} 分钟）`
  // eslint-disable-next-line no-new-func -- 测试专用：跑的是仓库里的真实源码
  return new Function(
    'editDraft', 'selected', 'settings', 'patchTask', 'setTasks', 'setEditDraft', 'pushToast',
    'MAX_ESTIMATE_MINUTES', 'DEFAULT_ESTIMATE_MINUTES', 'estimateRangeMessage',
    `${body}\nreturn saveEditDraft`,
  )(editDraft, selected, settings, patchTask, setTasks, setEditDraft, pushToast,
    MAX_ESTIMATE_MINUTES, DEFAULT_ESTIMATE_MINUTES, estimateRangeMessage)
}

const BASE_DRAFT = {
  title: '任务标题',
  description: '描述',
  typeCode: 'code_impl',
  priorityCode: 'p2',
  statusCode: 'todo',
  aiPolicyCode: 'consult',
  dueLocal: '',
  workspacePath: '',
  recurrenceCode: 'none',
  parentId: '',
  estimatedMinutes: '90',
  allDay: false,
}

function draftOf(overrides = {}) {
  return { ...BASE_DRAFT, ...overrides }
}

async function runSave(editDraft, { patchFails = false } = {}) {
  const calls = []
  const toasts = []
  const taskUpdates = []
  const save = makeSaveEditDraft({
    editDraft,
    selected: { task: { id: 'task-1', recurrenceMasterId: null } },
    settings: { defaultEstimateMinutes: 30 },
    patchTask: async (id, payload) => {
      if (patchFails) throw new Error('服务端拒绝')
      calls.push({ id, payload })
    },
    setTasks: (updater) => { taskUpdates.push(updater) },
    setEditDraft: () => {},
    pushToast: (message, tone) => { toasts.push({ message, tone }) },
  })
  await save()
  return { calls, toasts, taskUpdates }
}

/** 用乐观更新的更新函数去跑一遍本地列表，看它到底把哪条改成了什么。 */
function applyOptimistic(taskUpdates, task) {
  const list = [task, { id: 'other', estimatedMinutes: 15, allDay: false }]
  return taskUpdates[0](list)
}

test('payload 真的带 estimatedMinutes 与 allDay（桩收到的实参，不是形态扫描）', async () => {
  const { calls } = await runSave(draftOf({ estimatedMinutes: '90', allDay: true }))
  assert.equal(calls.length, 1, '合法输入必须发一次请求')
  assert.equal(calls[0].payload.estimatedMinutes, 90, 'payload.estimatedMinutes 必须是数字 90')
  assert.equal(calls[0].payload.allDay, true, 'payload.allDay 必须带上')
  // 留空 → null（= 没填，走默认耗时），不是 0、不是 NaN
  const blank = await runSave(draftOf({ estimatedMinutes: '' }))
  assert.equal(blank.calls[0].payload.estimatedMinutes, null, '留空 → null')
  const alsoBlank = await runSave(draftOf({ estimatedMinutes: '   ' }))
  assert.equal(alsoBlank.calls[0].payload.estimatedMinutes, null, '纯空格也算留空')
})

test('耗时输入非法时就地报错并阻止保存（不发请求，不靠服务端 400 猜）', async () => {
  for (const bad of ['0', '-5', '2000', 'abc', '1441', '1.5abc']) {
    const { calls, toasts } = await runSave(draftOf({ estimatedMinutes: bad }))
    assert.equal(calls.length, 0, `非法值 ${bad} 不许发请求`)
    assert.equal(toasts.length, 1, `非法值 ${bad} 必须给一条行内提示`)
    assert.equal(toasts[0].tone, 'error', '必须报错而不是静默')
    assert.match(toasts[0].message, /1–1440|1-1440/, '提示要写清合法区间')
  }
  // 合法的边界值必须放行
  for (const [raw, want] of [['1', 1], ['1440', 1440], ['30', 30]]) {
    const { calls } = await runSave(draftOf({ estimatedMinutes: raw }))
    assert.equal(calls.length, 1, `合法值 ${raw} 必须放行`)
    assert.equal(calls[0].payload.estimatedMinutes, want)
  }
  // 小数四舍五入（用户拖 number 输入框的步进值可能带小数）
  const rounded = await runSave(draftOf({ estimatedMinutes: '90.6' }))
  assert.equal(rounded.calls[0].payload.estimatedMinutes, 91, '小数四舍五入')
})

test('乐观更新：保存成功后立刻改本地列表（不刷新就能看到「已排」跟着变）', async () => {
  const { calls, taskUpdates } = await runSave(draftOf({ estimatedMinutes: '90', allDay: true }))
  assert.equal(calls.length, 1)
  assert.equal(taskUpdates.length, 1, '成功后必须调一次 setTasks（乐观更新）')
  const next = applyOptimistic(taskUpdates, { id: 'task-1', estimatedMinutes: null, allDay: false, title: 't' })
  assert.deepEqual(
    next.find((t) => t.id === 'task-1'),
    { id: 'task-1', estimatedMinutes: 90, allDay: true, title: 't' },
    '被编辑的那条要立刻变成新值（其余字段不动）',
  )
  assert.deepEqual(
    next.find((t) => t.id === 'other'),
    { id: 'other', estimatedMinutes: 15, allDay: false },
    '别的任务不能被顺手改掉',
  )
  // 幂等：再跑一次同样的更新，结果一致
  const again = taskUpdates[0](next)
  assert.deepEqual(again, next, '同一个更新函数重复应用结果一致')
  // 失败路径不乐观更新：否则界面会显示一个服务端并没有接受的值
  const failed = await runSave(draftOf({ estimatedMinutes: '90' }), { patchFails: true })
  assert.equal(failed.taskUpdates.length, 0, '保存失败时不许乐观更新')
  assert.equal(failed.toasts.length, 1)
  assert.equal(failed.toasts[0].tone, 'error')
})

test('editDraft 初值来自 task.estimatedMinutes / task.allDay，不是常量', () => {
  const start = indexSource.indexOf('setEditDraft({ title: selected.task.title')
  assert.ok(start > 0, '编辑按钮里的 setEditDraft 初始化存在（抽不到即接线改名）')
  const init = indexSource.slice(start, indexSource.indexOf('}))', start))
  assert.match(init, /estimatedMinutes: selected\.task\.estimatedMinutes === null \? '' : String\(selected\.task\.estimatedMinutes\)/, '耗时初值取自任务（未填 → 空串）')
  assert.match(init, /allDay: selected\.task\.allDay/, '全天初值取自任务')
})

test('新建任务表单也补了同一组字段（同一字段两个入口，不许两套说法）', () => {
  const form = indexSource.slice(indexSource.indexOf('id="wb-new-task-form"'), indexSource.indexOf('</form>', indexSource.indexOf('id="wb-new-task-form"')))
  assert.ok(form.length > 0, '新建任务表单存在')
  assert.match(form, /name="estimatedMinutes"/, '新建表单也要能设耗时')
  assert.match(form, /name="allDay"/, '新建表单也要能设全天')
  assert.match(indexSource, /allDay: form\.get\('allDay'\) !== null/, 'createTask 的 payload 要带上 allDay')
  assert.match(indexSource, /estimatedMinutes, allDay: form\.get\('allDay'\)/, 'createTask 的 payload 要带上 estimatedMinutes')
})

test('设置页有两个新控件的入口（默认耗时 + 逾期口径）', () => {
  assert.match(settingsSource, /defaultEstimateMinutes/, '设置页要有默认耗时控件')
  assert.match(settingsSource, /dailyCapacityIncludeOverdue/, '设置页要有逾期口径开关')
})
