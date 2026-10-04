/**
 * D17 / P3-2：任务详情区的接线不变量（源码级扫描）。
 *
 * 为什么用源码扫描：`index.tsx`（4700+ 行、要宿主运行时）没法在 node 里渲染，
 * "详情卡真的接上同一个 `TaskProgress`""空态真的搬进了组件"这类**接线**只能用扫描钉住；
 * 能跑行为的（`taskProgressView` / `taskFilterSort`）另有测试。
 *
 * 判据口径（设计 §8.2）：
 * - 正向断言读**真实 owner**（`views/TaskDetailPane.tsx` / `hooks/useTaskDetailModel.ts`），
 *   实现搬到哪判据就指哪；
 * - 负向唯一性**递归全客户端**（`countInClient`），因为"入口没有第二份"在搬家后会空洞通过。
 *
 * 本批最要紧的两条（设计 §3 的硬规矩）：
 * ① `views/` **不许发 HTTP** —— 详情面板里原先有两处内联 `void api(...)`（恢复任务、新建子任务），
 *    P3-2 把它们提成装配层注入的 `onRestoreTask` / `onCreateSubtask`；
 * ② 详情域状态**只有一个 owner** —— 6 项 `useState` 搬进 `useTaskDetailModel`，
 *    入口不再持有第二份可写副本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { read, stripComments, countInClient, assertClientCount } from './_clientSources.mjs'

const indexSource = read('src/client/index.tsx')
const paneSource = read('src/client/views/TaskDetailPane.tsx')
const hookSource = read('src/client/hooks/useTaskDetailModel.ts')
/** D17/P3-3：编辑草稿这一格（连同它的契约类型）已随任务表单域搬进这个 hook。 */
const formsHookSource = read('src/client/hooks/useTaskForms.ts')
/**
 * D17/P6-1：视图联合类型的 `useState` 随**导航域**搬进这个 hook。
 * 断言跟着 owner 走 —— 入口改成负向（"不再持有"），正向指到新 owner（不是放宽）。
 */
const navHookSource = read('src/client/hooks/useWorkbenchNavigation.ts')
/**
 * D17/P7-1：`restoreTask` / `createSubtask` 的请求本体随**任务数据域**归域（`WorkbenchApp`
 * 体内不许再有 `api(` / `fetch(` —— ADR-0008 的结构硬门）。
 */
const taskDataHookSource = read('src/client/hooks/useTaskData.ts')
const contractsSource = read('src/client/app/contracts.ts')
/** D17/P7-2：四段 JSX 搬进 app/ —— 详情面板与三路分派的装配点在 WorkbenchBody。 */
const appBodySource = read('src/client/app/WorkbenchBody.tsx')

const DETAIL_STATES = [
  'detailTab', 'sessionPickerOpen', 'sessionPickerRole',
  'sessionPickerQuery', 'sessionPickerBusy', 'eventsExpanded',
]

test('D17/P3-2：详情域 6 项状态的 useState 全客户端只出现一次（唯一所有者）', () => {
  for (const name of DETAIL_STATES) {
    const { hits } = countInClient(new RegExp(`const \\[${name},`, 'g'))
    assert.deepEqual(hits, ['src/client/hooks/useTaskDetailModel.ts×1'],
      `${name} 只许在 useTaskDetailModel 里创建（实际：${hits.join('、') || '无'}）`)
  }
  assert.match(hookSource, /export function useTaskDetailModel\(\): UseTaskDetailModelResult \{/,
    'hook 导出与类型一致')
  assert.match(hookSource, /const \[detailTab, setDetailTab\] = useState<TaskDetailTab>\('desc'\)/,
    '页签初值与拆分前逐字一致')
  assert.match(hookSource, /const \[sessionPickerRole, setSessionPickerRole\] = useState\('consult'\)/,
    '会话角色初值 consult 与拆分前逐字一致')
})

test('D17/P3-2：详情视图是纯展示 —— 不发 HTTP、不持有 state/effect/派生', () => {
  const code = stripComments(paneSource)
  assert.doesNotMatch(code, /\b(api|fetch)\s*[<(]/,
    'views/ 不许发 HTTP（设计 §3）：恢复任务与新建子任务都必须走注入的回调')
  assert.doesNotMatch(code, /\buseState\s*[<(]/, '视图不自建 state')
  assert.doesNotMatch(code, /\buseEffect\s*\(/, '视图不自建 effect')
  assert.doesNotMatch(code, /\buseMemo\s*\(/, '视图不自建派生')
  assert.doesNotMatch(paneSource, /from '\.\.\/index/, '视图不 import 入口')
  // 两处 HTTP 改成注入回调后，请求本体必须在**任务数据域**（唯一一份；D17/P7-1 归域）
  assert.match(taskDataHookSource, /const restoreTask = \(taskId: string\): void => \{\n\s+void api\(`\/api\/workbench\/tasks\/\$\{taskId\}\/restore`, \{ method: 'POST' \}\)/,
    '恢复任务的请求本体在 useTaskData.ts')
  assert.match(taskDataHookSource, /const createSubtask = \(form: FormData, parent: Task\): void => \{/,
    '新建子任务的请求本体在 useTaskData.ts')
  assert.doesNotMatch(indexSource, /const restoreTask = |const createSubtask = /,
    '入口不再各留一份（D17/P7-1：只从 hook 解构使用）')
  assert.match(appBodySource, /onRestoreTask=\{restoreTask\}/,
    '仍把它交给详情面板（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）')
  assert.doesNotMatch(stripComments(indexSource), /onRestoreTask=\{restoreTask\}/,
    '入口不留副本（注释不算）')
  assert.match(code, /onClick=\{\(\) => onRestoreTask\(selected\.task\.id\)\}/, '视图只调注入的回调')
  assert.match(code, /onCreateSubtask\(new FormData\(e\.currentTarget\), subtaskParent\)/,
    '视图只交 FormData 与父任务，payload 拼接在装配层')
})

test('D17/P3-2：入口只保留三路分派，空态与详情 JSX 都归 TaskDetailPane', () => {
  assert.equal((appBodySource.match(/<TaskDetailPane/g) ?? []).length, 1,
    '详情面板装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）')
  assert.doesNotMatch(stripComments(indexSource), /<TaskDetailPane/, '入口不再有第二处装配')
  assert.match(appBodySource, /: view === 'knowledge'\n\s+\? <KnowledgeDetailPane/,
    '三路分派顺序不变（ideas → knowledge → task）')
  assert.doesNotMatch(indexSource, /: selected === null/,
    '入口不再自己判空态（那是详情面板的第一种形态）')
  assert.doesNotMatch(indexSource, /AI 澄清\/咨询\/拆解会跳转到官方会话区/,
    '空态文案不该在入口留副本')
  assert.match(paneSource, /if \(selected === null\) \{[\s\S]{0,400}?wb-empty[\s\S]{0,400}?AI 澄清\/咨询\/拆解会跳转到官方会话区/,
    '空态逐字搬进组件')
})

test('D17/P3-2：三个语义动作只有一份实现，「两连 setState」不再出现在调用点', () => {
  const resetBody = hookSource.slice(hookSource.indexOf('const resetDetailView'), hookSource.indexOf('const openSessionPicker'))
  const openBody = hookSource.slice(hookSource.indexOf('const openSessionPicker'), hookSource.indexOf('const closeSessionPicker'))
  const closeBody = hookSource.slice(hookSource.indexOf('const closeSessionPicker'), hookSource.indexOf('return {'))
  assert.match(resetBody, /setDetailTab\('desc'\)\n\s+setEventsExpanded\(false\)/,
    'resetDetailView 就是拆分前 openTask / openTaskById 里那两行')
  assert.match(openBody, /setSessionPickerQuery\(''\)\n\s+setSessionPickerOpen\(true\)/)
  assert.match(closeBody, /setSessionPickerOpen\(false\)\n\s+setSessionPickerQuery\(''\)/)
  const entryAndPane = stripComments(indexSource) + stripComments(paneSource)
  assert.doesNotMatch(entryAndPane, /setSessionPickerQuery\(''\); setSessionPickerOpen\(true\)/,
    '「清空 + 展开」两连调用只许在 hook 里')
  assert.doesNotMatch(entryAndPane, /setSessionPickerOpen\(false\); setSessionPickerQuery\(''\)/,
    '「收起 + 清空」两连调用只许在 hook 里')
  // 入口只剩三个动作在用，且都经 detail.actions
  assert.match(indexSource, /const \{ setSessionPickerBusy, resetDetailView, closeSessionPicker \} = detail\.actions/)
  assert.doesNotMatch(stripComments(indexSource), /(?<![\w.])setDetailTab\b/,
    '入口不许再直接摸 setDetailTab（页签复位只能走 resetDetailView）')
})

test('D17/P3-2：两份匿名类型收进 app/contracts.ts，入口不再内联', () => {
  assert.match(contractsSource, /export type WorkbenchView = 'today' \| 'calendar' \| 'list' \| 'knowledge' \| 'ideas'/,
    'WorkbenchView 与拆分前的内联联合类型逐字一致')
  assert.match(contractsSource, /export interface TaskEditDraft \{/)
  for (const field of ['title', 'description', 'typeCode', 'priorityCode', 'statusCode', 'aiPolicyCode',
    'dueLocal', 'workspacePath', 'recurrenceCode', 'parentId', 'estimatedMinutes', 'allDay']) {
    assert.match(contractsSource, new RegExp(`\\b${field}:`), `TaskEditDraft.${field} 必须在契约里`)
  }
  assert.match(navHookSource, /const \[view, setView\] = useState<WorkbenchView>\('today'\)/,
    '视图联合类型由导航域（useWorkbenchNavigation）持有')
  assert.doesNotMatch(stripComments(indexSource), /useState<WorkbenchView>/,
    '入口不再持有视图联合类型的 useState（D17/P6-1 后 owner 是 useWorkbenchNavigation）')
  assert.match(formsHookSource, /useState<TaskEditDraft \| null>\(null\)/, '编辑草稿用契约类型')
  assertClientCount(assert, /useState<'today' \| 'calendar'/g, 0,
    '不再内联视图联合类型（一份定义，不是两份）')
})
