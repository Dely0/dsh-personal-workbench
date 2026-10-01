/**
 * D04：客户端接线与执行提示词（AX-P05/P07/P08 的静态侧 + 客户端纯投影侧）。
 *
 * ## 为什么这个文件里既有"跑代码"又有"扫源码"
 *
 * - **能跑的就跑**：`taskProgressView` / `pendingCompletionMap` 是纯模块，
 *   真正的行为断言写在这里（比如"服务端不支持时不许显示徽标"）；
 * - **跑不了的才扫**：`index.tsx`（5700+ 行、需要宿主运行时）没法在 node 里渲染，
 *   "进度组件真的接进了列表/详情"只能靠**源码级不变量**钉住。
 *
 * ⚠️ 扫描判据刻意避开行号与字面量顺序：只断言"唯一实现存在"与"第二份实现不存在"，
 * 免得下次无关重构就把测试扫红（脆断言最耗排查时间）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pendingCompletionMap, taskProgressView } from '../lib/client/taskProgressView.js'
import { projectProgress } from '../lib/shared/taskProgress.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8')

const clientIndex = read('src/client/index.tsx')
const taskList = read('src/client/components/TaskList.tsx')
const taskProgressComponent = read('src/client/components/TaskProgress.tsx')
const taskProgressViewSource = read('src/client/taskProgressView.ts')
const sharedProgress = read('src/shared/taskProgress.ts')
const serviceChrome = read('src/index.ts')

/**
 * 剥掉注释再扫。
 *
 * ⚠️ 不剥会**假红**（本仓踩过两次）：注释里逐字引用反面写法是正常的注释风格，
 * 比如"旧写法是 `openTaskById(taskId)`"——扫描器会把那句注释当成"代码里还有它"。
 * 规矩：**扫描前剥注释**（团队记忆里那条"扫之前记得剥注释"就是这么来的）。
 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// ---------------------------------------------------------------------------
// 客户端纯投影
// ---------------------------------------------------------------------------

const mkTask = (over = {}) => ({
  id: 't1', parentId: null, title: '任务', description: '', typeCode: 'feature_opt', statusCode: 'doing',
  priorityCode: 'p1', aiPolicyCode: 'consult', dueAt: null, effectiveDueAt: null, allDay: false,
  estimatedMinutes: null, source: 'manual', workspacePath: null, effectiveWorkspacePath: null,
  progressPercent: 45, archived: false, extra: {}, recurrenceCode: null, recurrenceRule: {},
  recurrenceMasterId: null, recurrenceLastGenerated: null, createdAt: '', updatedAt: '', completedAt: null, cancelledAt: null,
  ...over,
})

test('pendingCompletionMap：available=false（服务端不支持）→ null，与"空 Map"是两件事', () => {
  assert.equal(pendingCompletionMap(null), null)
  assert.equal(pendingCompletionMap(undefined), null)
  assert.equal(pendingCompletionMap({ available: false, items: [] }), null, '服务端不支持时必须返回 null（界面据此不显示徽标）')
  const empty = pendingCompletionMap({ available: true, items: [] })
  assert.ok(empty instanceof Map)
  assert.equal(empty.size, 0, '确实没人待验收 → 空 Map（而不是 null）')
})

test('pendingCompletionMap：taskId 去重与 deferred 标记', () => {
  const map = pendingCompletionMap({
    available: true,
    items: [
      { taskId: 'a', draftId: 'd1', deferred: false, summary: 's', updatedAt: '' },
      { taskId: 'b', draftId: 'd2', deferred: true, summary: 's', updatedAt: '' },
      { taskId: '', draftId: 'd3', deferred: false, summary: 's', updatedAt: '' },
    ],
  })
  assert.deepEqual([...map.keys()], ['a', 'b'], '空 taskId 不能进 Map')
  assert.equal(map.get('b').deferred, true)
})

test('taskProgressView：pending 显示待验收徽标；不支持时不显示（AX-P07 判定侧）', () => {
  const pending = new Map([['t1', { deferred: false }]])
  const withPending = taskProgressView({ task: mkTask(), pending })
  assert.equal(withPending.showBar, false, '待验收时不画进度条（用徽标表达）')
  assert.equal(withPending.badge, '待验收')
  assert.equal(withPending.badgeKind, 'pending')

  const deferred = taskProgressView({ task: mkTask(), pending: new Map([['t1', { deferred: true }]]) })
  assert.equal(deferred.badge, '待验收（暂存）')
  assert.equal(deferred.badgeKind, 'deferred')

  const unsupported = taskProgressView({ task: mkTask(), pending: null })
  assert.equal(unsupported.badge, null, '服务端不支持这份投影 → 绝不推测、不显示徽标')
  assert.equal(unsupported.showBar, true)
  assert.equal(unsupported.percent, 45)
})

test('taskProgressView：done/cancelled 不画进度；缺 progressPercent 的旧服务端按 0 读', () => {
  for (const [statusCode, label] of [['done', '已完成'], ['cancelled', '已取消']]) {
    const view = taskProgressView({ task: mkTask({ statusCode }) })
    assert.equal(view.showBar, false, `${statusCode} 不画进度条`)
    assert.equal(view.badge, label)
  }
  const legacy = taskProgressView({ task: mkTask({ progressPercent: undefined }) })
  assert.equal(legacy.percent, 0, '旧服务端不下发该字段 = 没人写过进度（0），不是"假装有"')
  assert.equal(legacy.showBar, true)
})

test('taskProgressView：直接子任务旁证用**直接**子任务，且不改写显式进度（AX-P08）', () => {
  const view = taskProgressView({
    task: mkTask({ progressPercent: 30 }),
    children: [mkTask({ id: 'c1', statusCode: 'done' }), mkTask({ id: 'c2', statusCode: 'cancelled' })],
  })
  assert.equal(view.percent, 30, '旁证不得改写显式进度（不派生的判据）')
  assert.match(view.childLabel, /子任务 1\/2 已完成/)
  assert.match(view.childLabel, /另 1 个已取消/)
  assert.equal(view.hint, null, '有取消项就不算"全完成"，不给提示')
})

test('客户端与共享层走的是**同一个**投影函数（不许第二份判定）', () => {
  assert.match(taskProgressViewSource, /import \{ projectProgress/, '客户端必须调用共享投影')
  assert.match(taskProgressViewSource, /projectProgress\(/, '不是"抄一份进来"，而是真的调用')
  // 组件里不得再出现状态判定分支（那是"同一语义两处实现"的入口）
  assert.doesNotMatch(taskProgressComponent, /statusCode === 'done'/, 'TaskProgress 组件内不得判状态')
  assert.doesNotMatch(taskProgressComponent, /statusCode === 'cancelled'/, 'TaskProgress 组件内不得判状态')
})

test('共享投影只有一处实现：没有第二份 projectProgress', () => {
  const sources = [clientIndex, taskList, taskProgressViewSource, taskProgressComponent]
  for (const source of sources) {
    assert.doesNotMatch(source, /function projectProgress|const projectProgress/, '投影只允许在 shared/taskProgress.ts 里实现')
  }
  assert.match(sharedProgress, /export function projectProgress/)
})

// ---------------------------------------------------------------------------
// 接线（源码级不变量）
// ---------------------------------------------------------------------------

test('TaskProgress 独立组件存在，且列表行与详情都接线到它', () => {
  assert.match(taskProgressComponent, /export function TaskProgress\b/, '独立组件必须存在（requirements §3.2）')
  assert.match(taskProgressComponent, /export function ProgressBar\b/)
  assert.match(taskList, /import \{ TaskProgress \} from '\.\/TaskProgress\.js'/, '列表行必须用这个组件')
  assert.match(taskList, /<TaskProgress compact/, '列表行用 compact 形态')
  assert.match(clientIndex, /<TaskProgress\b/, '详情页也用同一个组件')
})

test('列表行的进度数据来自**一次**待验收查询（不做 N+1）', () => {
  assert.match(clientIndex, /tasks\/pending-completions/, '待验收投影走一次性端点')
  assert.match(clientIndex, /pendingCompletionMap\(/, '折成 Map 后再分发到各行')
  assert.match(clientIndex, /pending=\{pendingMap\}/, '列表树必须接到这份投影')
  // 反向：不许在渲染里逐任务发请求
  assert.doesNotMatch(clientIndex, /tasks\/\$\{task\.id\}\/pending/, '不得逐行请求待验收')
})

test('进度保存与"完成任务"是两个动作，且 100 不走保存路径', () => {
  assert.match(clientIndex, /progressPercent: percent/, '保存进度只写 progressPercent')
  assert.match(clientIndex, /completeTaskFromProgress/, '"完成任务"是独立动作')
  // 100 档位必须落到 onComplete（完成任务），而不是 onSave（保存进度）
  assert.match(taskProgressComponent, /preset\.value === 100[\s\S]{0,120}onComplete/, '100 档位必须走完成任务')
  /**
   * "100 不是普通保存值"这句**必须留在界面上**（requirements §3.1）。
   * 2026-10-01 用户要求删掉卡片里那段长 tip（它把详情页撑高），所以语义搬到**按钮 title**：
   * 不占高度，但鼠标悬停时仍然说清"这一步是完成任务、会提示级联"。判据跟着改到 title 上。
   */
  assert.match(taskProgressComponent, /100% 请点这里[\s\S]{0,80}不是把 100 存进进度/, '界面要写清 100 不是普通保存值（放在按钮 title 里）')
  assert.doesNotMatch(taskProgressComponent, /wb-progress-tip/, '那段落地的长 tip 已按用户要求删除')
  assert.match(clientIndex, /window\.confirm\(question\)/, '完成任务要先确认')
  assert.match(clientIndex, /级联完成/, '有子任务时提示要说明级联')
})

/**
 * ⑤ 的判据（2026-10-01 用户报的 BUG）：**刷新详情不许顺带导航**。
 *
 * 现象："在任何页面修改任务的进度，工作台都会被弹回任务页。"
 * 根因：刷新详情走的是 `openTaskById`，而它第一句是 `setView('list')`。
 *
 * 这条写成**源码级不变量**的理由与上面那条一样：`index.tsx` 需要宿主运行时，跑不起来。
 * 判据刻意不依赖行号，只切函数体（`slice` 到下一个 `const `），无关重构不会扫红。
 */
test('刷新详情不带导航副作用：saveProgress 走 loadTaskDetail，而 loadTaskDetail 里没有 setView', () => {
  const code = stripComments(clientIndex)
  const detailBody = code.slice(code.indexOf('const loadTaskDetail = (taskId: string): void =>'))
    .slice(0, code.slice(code.indexOf('const loadTaskDetail = (taskId: string): void =>')).indexOf('const openTask = '))
  assert.doesNotMatch(detailBody, /setView\(/, 'loadTaskDetail 只刷新数据，不许切视图')

  const saveBody = code.slice(code.indexOf('const saveProgress = async')).slice(0, 400)
  assert.match(saveBody, /loadTaskDetail\(taskId\)/, '保存进度后用 loadTaskDetail 刷新')
  assert.doesNotMatch(saveBody, /openTaskById\(/, '保存进度**不许**走 openTaskById（它内部会 setView(\'list\')）')

  const completeBody = code.slice(code.indexOf('const completeTaskFromProgress = async')).slice(0, 800)
  assert.match(completeBody, /loadTaskDetail\(taskId\)/, '完成任务后同样只刷新')
  assert.doesNotMatch(completeBody, /openTaskById\(/, '完成任务后也不许把用户弹走')
})

test('执行提示词要求主动报进度、并说清 100 不是直接完成（AX-P08）', () => {
  const executePrompt = clientIndex.slice(clientIndex.indexOf('你是“个人工作台”的任务执行助手'))
  const promptBody = executePrompt.slice(0, 2000)
  assert.match(promptBody, /阶段性推进后主动报一次进度/, '执行提示词必须要求主动报进度')
  assert.match(promptBody, /workbench_update_progress/, '提示词要给出具体工具')
  assert.match(promptBody, /100 不是进度值/, '要写清 100 的语义')
  assert.match(promptBody, /不要声称已经完成|不算完成/, '仍然不许声称已完成')

  // 服务端系统提示同样要说清（斜杠命令/其它入口不经过客户端提示词）
  assert.match(serviceChrome, /阶段性推进后请主动调用 workbench_update_progress/, '系统提示要有这条')
  assert.match(serviceChrome, /咨询\/拆解\/排序会话不得被这条提示诱导去执行任务/, '必须写清不诱导非执行会话')
})

test('非执行模式的提示词里**没有**进度工具指令（不诱导咨询/拆解会话执行任务）', () => {
  const consult = clientIndex.slice(clientIndex.indexOf('你是“个人工作台”的任务协助助手'), clientIndex.indexOf('你是“个人工作台”的任务拆解助手'))
  assert.doesNotMatch(consult, /workbench_update_progress/, '咨询模式不得被诱导去写进度')
  const breakdown = clientIndex.slice(clientIndex.indexOf('你是“个人工作台”的任务拆解助手'), clientIndex.indexOf('你是“个人工作台”的任务复盘助手'))
  assert.doesNotMatch(breakdown, /workbench_update_progress/, '拆解模式不得被诱导去写进度')
})

test('工具已注册进插件入口（只注册一处）', () => {
  assert.match(serviceChrome, /updateProgressTool\(db\)/, '新工具必须在入口注册')
  const registrations = serviceChrome.match(/updateProgressTool\(db\)/g) ?? []
  assert.equal(registrations.length, 1, '只允许注册一次')
})
