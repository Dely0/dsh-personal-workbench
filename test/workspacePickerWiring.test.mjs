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

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = readFileSync(join(root, 'src/client/index.tsx'), 'utf8')
const MODAL = readFileSync(join(root, 'src/client/components/LocalDocModal.tsx'), 'utf8')
const PICKER = readFileSync(join(root, 'src/client/components/WorkspacePicker.tsx'), 'utf8')

const count = (source, pattern) => (source.match(pattern) ?? []).length

test('#2: 三个入口各挂一次 WorkspacePicker（快速录入 / 新建任务 / 编辑任务）', () => {
  assert.equal(count(INDEX, /<WorkspacePicker/g), 3,
    '工作区选择器必须在三个入口各出现一次（少一个就有入口只能手打路径）')
  // 三个入口的 onBrowse 必须各自指出"选完写回哪" —— 否则浏览完不知道落到谁身上
  for (const target of ["openDirPicker('quick')", "openDirPicker('form')", "openDirPicker('edit')"]) {
    assert.ok(INDEX.includes(target), `缺少 ${target}：浏览弹窗需要知道自己是从哪个入口打开的`)
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
  // index.tsx 里两处用法：知识库(file，默认) + 工作区(dir)
  assert.equal(count(INDEX, /<LocalDocModal/g), 2, '两个弹窗用法：知识库文件的 + 工作区的')
  assert.match(INDEX, /mode="dir"/, '工作区那一处必须显式 dir 模式')
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
  assert.match(INDEX, /name="workspacePath"/, '表单提交读的仍是 workspacePath 字段名（改字段名等于改接口）')
  assert.match(INDEX, /const \[formWorkspace, setFormWorkspace\]/, '表单里的工作区必须受控，否则「浏览…」写不进值')
  assert.match(INDEX, /if \(showForm\) setFormWorkspace\(''\)/,
    '每次打开新建表单都要清空 —— 否则上一次浏览选的目录会留在下一次')
})
