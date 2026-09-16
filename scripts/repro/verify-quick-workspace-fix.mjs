/**
 * 修前 / 修后**对照**：直接跑两个版本源码里**真实的 `openQuickEntry`**。
 *
 * ## 为什么不是"再写一个复刻"
 *
 * 上一轮的 fresh-eyes 审查点名过一种假证据：复现脚本自己手写一份逻辑，
 * 于是**撤掉修复照样全绿**（脚本对源码不敏感）。这里的做法是：
 *
 * 1. 从 `git show <rev>:src/client/index.tsx`（`WORK` = 工作区当前文件）里
 *    **逐字抽出** `openQuickEntry` 的函数体与提交处的"记不记 recent"判定表达式；
 * 2. 用一个只提供外部依赖的桩环境把它包成真函数并调用；
 * 3. 于是"改源码 → 结果必变"是构造上成立的：抽不到就 `extract-missing` 非零退出。
 *
 * ## 两个版本、两个场景
 *
 * - 修前 `947fa63`：①（选中/执行过任务 A）默认工作区 = A 的工作区 X ——
 *   这一条与真机复现（`scripts/repro/repro-quick-workspace-default.mjs --expect buggy`）
 *   的观测值必须一致，否则说明本探针没有忠实建模；
 * - 修后 `WORK/HEAD`：默认工作区 = 上次手动选择 或 系统默认（绝不是 X）。
 * - 另加"提交时会不会把自动预填的值记成『上次手动选择』"（默认值自激污染那条腿）。
 *
 * 用法：
 *   node scripts/repro/verify-quick-workspace-fix.mjs [--before 947fa63] [--after WORK] \
 *        [--task-workspace <X>] [--default-workspace <D>] [--recent <W>] [--fixture <json>]
 *
 * 不带参数时：设置读本机工作台接口（回环可读），任务工作区读真机复现的 fixture。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decideQuickWorkspaceDefault, shouldRememberQuickWorkspace } from '../../lib/client/quickWorkspaceDefault.js'
import { normalizeWindowsPathToWsl } from '../../lib/client/workspacePath.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : String(argv[index + 1] ?? '')
}
const BEFORE_REV = arg('before', '947fa63')
const AFTER_REV = arg('after', 'WORK')
const FIXTURE = arg('fixture', join(ROOT, '_local-archive', 'quick-workspace-default', 'before', 'repro-result.json'))

// ------------------------------------------------------------------ 输入快照
let fixture = null
if (existsSync(FIXTURE)) {
  try { fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) } catch { fixture = null }
}
let liveSettings = null
try {
  const res = await fetch('http://127.0.0.1:3080/api/workbench/settings', { signal: AbortSignal.timeout(3000) })
  liveSettings = (await res.json()).settings
} catch { liveSettings = null }

const defaultWorkspace = arg('default-workspace',
  liveSettings?.defaultWorkspace ?? fixture?.settings?.defaultWorkspace ?? '')
const recentRaw = arg('recent', '')
const recent = recentRaw !== ''
  ? [recentRaw]
  : (liveSettings?.quickWorkspaceRecent ?? fixture?.settings?.quickWorkspaceRecent ?? [])
const taskWorkspace = arg('task-workspace', fixture?.task?.effectiveWorkspacePath ?? '')
if (taskWorkspace === '') {
  console.error('缺少任务工作区 X：真机复现 fixture 不在，请用 --task-workspace <X> 指定')
  process.exit(2)
}

/** 场景：选中（并执行过）任务 A（工作区 X） */
const selectedTaskA = { task: { id: 'A', title: '任务 A', effectiveWorkspacePath: taskWorkspace } }
const settings = { defaultWorkspace, autoCreateTypeFolders: true, quickWorkspaceRecent: recent }

const stableDefault = decideQuickWorkspaceDefault({ recent, defaultWorkspace }).path

console.log('输入快照')
console.log(`  任务 A（被选中的那个）工作区 X = ${JSON.stringify(taskWorkspace)}`)
console.log(`  settings.defaultWorkspace       = ${JSON.stringify(defaultWorkspace)}`)
console.log(`  settings.quickWorkspaceRecent   = ${JSON.stringify(recent)}`)
console.log(`  修后应当预填的稳定默认值         = ${JSON.stringify(stableDefault)}`)
console.log(`  设置来源：${liveSettings === null ? '（接口不可读，用 fixture/参数）' : '本机工作台接口'}`)

// ------------------------------------------------------------------ 从源码抽函数
function sourceOf(rev) {
  if (rev === 'WORK') return { text: readFileSync(join(ROOT, 'src', 'client', 'index.tsx'), 'utf8'), label: 'WORK（工作区当前文件）' }
  const text = execFileSync('git', ['show', `${rev}:src/client/index.tsx`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { text, label: rev }
}

/** 抽出 `openQuickEntry` 的函数体，装成一个真函数（外部依赖全部由桩提供）。 */
function openQuickEntryOf(source) {
  const matched = /const openQuickEntry = \(\): void => \{([\s\S]*?)\r?\n  \}/.exec(source)
  if (matched === null) return null
  const factory = new Function('deps', `
    'use strict'
    const { settings, selected, runtime, state, detectWslHost, normalizeWindowsPathToWsl, decideQuickWorkspaceDefault } = deps
    const setQuickText = (value) => { state.quickText = value }
    const setQuickWorkspace = (value) => { state.quickWorkspace = value }
    const setQuickWorkspaceSource = (value) => { state.quickWorkspaceSource = value }
    const setQuickWorkspaceTouched = (value) => { state.quickWorkspaceTouched = value }
    const setQuickFollowFolder = (value) => { state.quickFollowFolder = value }
    const setShowQuick = (value) => { state.showQuick = value }
    return () => {${matched[1]}}
  `)
  return factory
}

/**
 * 抽出提交处「记不记 recent」的判定表达式：`if (<expr>) void rememberQuickWorkspace(chosen)`。
 *
 * 用括号配平向前找 `if (`，因为表达式里自己还可能带括号
 * （`shouldRememberQuickWorkspace(quickWorkspaceTouched, chosen)`）。
 */
function rememberGateOf(source) {
  const marker = 'void rememberQuickWorkspace(chosen)'
  const index = source.indexOf(marker)
  if (index === -1) return null
  const head = source.slice(0, index)
  const openParen = head.lastIndexOf('if (')
  if (openParen === -1) return null
  /** 从 `if` 后面那个 `(` 本身开始配平（它计入 depth）。 */
  const start = openParen + 3
  let depth = 0
  for (let i = start; i < head.length; i += 1) {
    if (head[i] === '(') depth += 1
    else if (head[i] === ')') {
      depth -= 1
      if (depth === 0) return head.slice(start + 1, i)
    }
  }
  return null
}

function runOpenQuickEntry(source, selected, settingsOverride) {
  const factory = openQuickEntryOf(source)
  if (factory === null) return null
  const state = {}
  const open = factory({
    settings: settingsOverride ?? settings,
    selected,
    runtime: {},
    state,
    detectWslHost: () => false,
    normalizeWindowsPathToWsl,
    decideQuickWorkspaceDefault,
  })
  open()
  return state
}

function gateRecords(source, touched, chosen) {
  const expression = rememberGateOf(source)
  if (expression === null) return null
  // 判定表达式必须在源码里真实存在（撤掉修复就会变成别的形态 → 这里随之变化）
  const evaluate = new Function('quickWorkspaceTouched', 'chosen', 'shouldRememberQuickWorkspace', `return (${expression})`)
  return evaluate(touched, chosen, shouldRememberQuickWorkspace)
}

// ------------------------------------------------------------------ 对照
const revs = [BEFORE_REV, AFTER_REV].map((rev) => ({ rev, ...sourceOf(rev) }))
let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ✔ ${label}${detail === undefined ? '' : ` —— ${detail}`}`)
  } else {
    console.log(`  ✖ ${label}${detail === undefined ? '' : ` —— ${detail}`}`)
    failures += 1
  }
}

const results = {}
for (const item of revs) {
  console.log(`\n── ${item.label}`)
  const scenario1 = runOpenQuickEntry(item.text, selectedTaskA)
  /** ③ 没有"上次手动选择"时（recent 为空）该落到系统默认 */
  const scenario3 = runOpenQuickEntry(item.text, selectedTaskA, { ...settings, quickWorkspaceRecent: [] })
  if (scenario1 === null) {
    console.error('  ✖ extract-missing：抽不到 openQuickEntry（源码结构变了就要同步本探针）')
    failures += 1
    results[item.rev] = null
    continue
  }
  const untouchedRecords = gateRecords(item.text, false, taskWorkspace)
  const touchedRecords = gateRecords(item.text, true, 'W')
  results[item.rev] = {
    defaultAfterSelectingTaskA: scenario1.quickWorkspace,
    defaultSource: scenario1.quickWorkspaceSource ?? '(修前没有这个字段)',
    followFolder: scenario1.quickFollowFolder,
    defaultWithEmptyRecent: scenario3?.quickWorkspace,
    untouchedValueRecordedAsManual: untouchedRecords,
    touchedValueRecordedAsManual: touchedRecords,
  }
  console.log(`  ① 选中/执行过任务 A（工作区 X）后打开快速录入 → 预填 ${JSON.stringify(scenario1.quickWorkspace)}`
    + `（来源 ${scenario1.quickWorkspaceSource ?? '修前无此字段'}）`)
  console.log(`  ② 没有"上次手动选择"时 → 预填 ${JSON.stringify(scenario3?.quickWorkspace)}（系统默认 ${JSON.stringify(defaultWorkspace)}）`)
  console.log(`  ③ 提交时"没动过输入框"的值会不会被记成「上次手动选择」→ ${untouchedRecords}`)
  console.log(`  ④ 提交时"用户手动填的 W"会不会被记下 → ${touchedRecords}`)
}

console.log('\n=== 断言 ===')
const before = results[BEFORE_REV]
const after = results[AFTER_REV]

console.log(`[修前 ${BEFORE_REV}]`)
check('复现缺陷：默认工作区 = 被执行任务的工作区 X',
  before?.defaultAfterSelectingTaskA === taskWorkspace,
  `实测 ${JSON.stringify(before?.defaultAfterSelectingTaskA)}`)
check('与真机复现的观测值一致（探针忠实建模）',
  fixture === null || fixture.quickWorkspace?.afterReopen === before?.defaultAfterSelectingTaskA,
  `真机 ${JSON.stringify(fixture?.quickWorkspace?.afterReopen)}`)
check('第二条腿：自动预填的值会被记进「上次手动选择」（默认值自激污染）',
  before?.untouchedValueRecordedAsManual === true,
  `实测 ${before?.untouchedValueRecordedAsManual}`)

console.log(`[修后 ${AFTER_REV}]`)
check('默认工作区不再是 X', after?.defaultAfterSelectingTaskA !== taskWorkspace,
  `实测 ${JSON.stringify(after?.defaultAfterSelectingTaskA)}`)
check('默认工作区 = 上次手动选择（或系统默认）',
  after?.defaultAfterSelectingTaskA === stableDefault,
  `实测 ${JSON.stringify(after?.defaultAfterSelectingTaskA)}，期望 ${JSON.stringify(stableDefault)}`)
check('没有"上次手动选择"时落到系统默认（不是 X）',
  after?.defaultWithEmptyRecent === defaultWorkspace && after?.defaultWithEmptyRecent !== taskWorkspace,
  `实测 ${JSON.stringify(after?.defaultWithEmptyRecent)}，期望 ${JSON.stringify(defaultWorkspace)}`)
check('来源由判定一并给出（界面不再自己判一遍）',
  typeof after?.defaultSource === 'string' && after.defaultSource !== '',
  `实测 ${JSON.stringify(after?.defaultSource)}`)
check('第二条腿：自动预填的值不再被记成「上次手动选择」',
  after?.untouchedValueRecordedAsManual === false,
  `实测 ${after?.untouchedValueRecordedAsManual}`)
check('用户真动过输入框时仍然记得住（别把便利功能一起修掉）',
  after?.touchedValueRecordedAsManual === true,
  `实测 ${after?.touchedValueRecordedAsManual}`)

if (failures > 0) {
  console.error(`\n❌ ${failures} 条断言没过`)
  process.exit(1)
}
console.log('\n✅ 修前复现 / 修后不再复现，两条腿都成立')
