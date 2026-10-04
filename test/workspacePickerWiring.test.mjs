/**
 * 批次2 #2 的接线判据（AX-W02 / AX-W03）。
 *
 * 断言的是**符号与调用点**，不锁行号（本项目规范：判据要跟实现走，但"不许出现第二份实现"
 * 只能用源码扫描证明）。三条不变量：
 *
 * 1. 三个入口各挂一次 `WorkspacePicker`，且**候选集只有一处计算**（`workspaceCandidates`）；
 * 2. 工作区的目录浏览**复用** `LocalDocModal` 的 `dir` 模式，不是第二份弹窗；
 * 3. 列目录的请求形状只有一处（`localDirBrowser.ts`），`index.tsx` 里不许再出现那个路由字面量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { read, assertClientCount } from './_clientSources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = read('src/client/index.tsx')
/** D17/P1：知识库那份 file 模式弹窗已随知识域搬进 `views/KnowledgeListView.tsx`。 */
const KNOWLEDGE_VIEW = read('src/client/views/KnowledgeListView.tsx')
const MODAL = read('src/client/components/LocalDocModal.tsx')
const PICKER = read('src/client/components/WorkspacePicker.tsx')
/** D17/P3-3：新建/编辑任务两个弹窗已搬进这里（选择器仍是同一个组件，三处挂载点跨两个文件）。 */
const TASK_FORM_MODAL = read('src/client/views/TaskFormModal.tsx')
const TASK_FORMS_HOOK = read('src/client/hooks/useTaskForms.ts')
/** D17/P7-2：四段 JSX 已搬进 src/client/app/ —— 装配层的 JSX owner 在那里。 */
const APP_DIALOGS = read('src/client/app/WorkbenchDialogs.tsx')

const count = (source, pattern) => (source.match(pattern) ?? []).length

test('#2: 三个入口各挂一次 WorkspacePicker（快速录入 / 新建任务 / 编辑任务）', () => {
  // 挂载点跨文件：快速录入仍在入口，两个任务表单在 TaskFormModal 里 —— 用全客户端计数。
  assertClientCount(assert, /<WorkspacePicker/g, 3,
    '工作区选择器必须在三个入口各出现一次（少一个就有入口只能手打路径）')
  assert.match(TASK_FORM_MODAL, /<WorkspacePicker/, '任务表单里那两处仍在（新建 + 编辑）')
  assert.equal(count(TASK_FORM_MODAL, /<WorkspacePicker/g), 2,
    '新建与编辑各挂一次 —— 两个弹窗共用一个选择器组件，但各有一处挂载')
  // 三个入口的 onBrowse 必须各自指出"选完写回哪" —— 否则浏览完不知道落到谁身上。
  // D17/P7-2：三处调用点都在 app/WorkbenchDialogs.tsx（快速录入弹窗 + 两个任务表单弹窗）。
  for (const target of ["openDirPicker('quick')", "openDirPicker('form')", "openDirPicker('edit')"]) {
    assert.ok(APP_DIALOGS.includes(target),
      `缺少 ${target}：浏览弹窗需要知道自己是从哪个入口打开的（D17/P7-2 起 owner = src/client/app/WorkbenchDialogs.tsx）`)
  }
  assert.match(INDEX, /const applyWorkspaceDir = /, '选完目录必须有一个统一的分派点')
})

test('#2: 候选集只有一处计算，且旧的现场拼接不许复活', () => {
  assert.equal(count(INDEX, /workspaceCandidates\(/g), 1,
    '候选集只允许在 workspaceCandidates 里算一次；多处计算就是"同一语义两处实现"')
  assert.equal(INDEX.includes('wb-quick-workspace-options'), false,
    '旧实现是 <datalist>（原生输入提示，不是"已有工作区下拉"）—— 已由真下拉取代，不许复活')
  assert.equal(count(INDEX, /openWorkspacePaths\(runtime\)/g), 1,
    '宿主工作区快照只允许在一处读（喂给 workspaceCandidates），别处再读一份就会与下拉不一致')
  // 组件本身不许再判一遍候选/选中：判定全在纯函数里
  assert.equal(PICKER.includes('new Set('), false, '组件里不许再做去重（去重口径在 workspaceCandidates）')
  assert.match(PICKER, /selectedCandidatePath\(/, '当前选中项要问纯函数，组件不自己比路径')
})

test('#2/W03: 目录浏览复用 LocalDocModal 的 dir 模式，不是第二份弹窗', () => {
  assert.equal(count(MODAL, /export function LocalDocModal\(/g), 1, '只允许一个弹窗组件')
  assert.match(MODAL, /data-doc-mode=\{mode\}/, '两种用途要能从 DOM 上区分（判据与排查都要）')
  assert.match(MODAL, /data-doc-pick-dir=/, 'dir 模式要有「选择此文件夹」入口')
  assert.match(MODAL, /data-doc-pick-current/, 'dir 模式要能直接选定当前浏览的文件夹')
  // 两处用法：知识库(file，默认，已随知识域搬进 views/) + 工作区(dir，D17/P7-2 起在
  // src/client/app/WorkbenchDialogs.tsx 的快速录入弹窗里)
  assertClientCount(assert, /<LocalDocModal/g, 2, '两个弹窗用法：知识库文件的 + 工作区的')
  assert.match(KNOWLEDGE_VIEW, /<LocalDocModal/, '知识库那份仍在知识视图里')
  assert.match(APP_DIALOGS, /<LocalDocModal/,
    '工作区那份仍在装配层（D17/P7-2 起 owner = src/client/app/WorkbenchDialogs.tsx）')
  assert.match(APP_DIALOGS, /mode="dir"/, '工作区那一处必须显式 dir 模式')
  assert.doesNotMatch(INDEX, /<LocalDocModal/, '入口不再有第二处装配（P7-2 后 JSX 全在 app/）')
  assert.equal(count(MODAL, /data-doc-run/g), 1, 'file 模式独有按钮只许出现一次')
})

test('#2/W03: 列目录的请求形状只有一处（index.tsx 不许再拼那个路由）', () => {
  assert.equal(INDEX.includes('/knowledge/list-local-dir'), false,
    '路由字面量只允许在 localDirBrowser.ts 里 —— 两处各拼一份，哨兵/编码的口径迟早分叉')
  const clientDir = join(root, 'src/client')
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      if (entry.name === 'localDirBrowser.ts') continue
      if (readFileSync(full, 'utf8').includes('list-local-dir')) offenders.push(full.replace(root, ''))
    }
  }
  walk(clientDir)
  assert.deepEqual(offenders, [], '只允许 localDirBrowser.ts 知道这个路由')
})

test('#2: 新建任务表单的工作区值仍以 workspacePath 进 FormData（提交路径没变）', () => {
  assert.match(TASK_FORM_MODAL, /name="workspacePath"/, '表单提交读的仍是 workspacePath 字段名（改字段名等于改接口）')
  assert.match(TASK_FORMS_HOOK, /const \[formWorkspace, setFormWorkspace\]/, '表单里的工作区必须受控，否则「浏览…」写不进值')
  assert.match(TASK_FORMS_HOOK, /if \(showForm\) setFormWorkspace\(''\)/,
    '每次打开新建表单都要清空 —— 否则上一次浏览选的目录会留在下一次')
})
