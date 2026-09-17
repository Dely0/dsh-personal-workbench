/**
 * 任务资料夹规矩的单测（v1.15.1）。
 *
 * ## 这份测试真正在防什么
 *
 * 1. **新口径**：资料夹名 = `<任务ID>-<标题片段>`，判定只看 ID 前缀
 *    （改标题不再产生孤儿目录、同名任务不再挤同一目录）；
 * 2. **老路径兼容**：本机真实库里那 3 条"标题型"自动路径必须仍被判为**自动生成**。
 *    不覆盖这一条，照抄 fork 的实现会把这 3 条判成"用户手填" → **永不再迁移**
 *    （这正是调研文档 3.1 结尾标了 ⚠️ 的那一条）；
 * 3. **手填型永不触碰**：本机 26+ 条用户手填的真实项目目录不能被当成自动路径改写。
 *
 * 后两类的样本取自**真实库**（`.pwtest/dump-legacy-workspace-samples.mjs` 只读导出），
 * 不是编的字符串 —— 编的样本会刚好绕过真实数据里的那些边界（24 字截断、全角冒号、中文）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_TASK_ID_PREFIX_LENGTH,
  classifyTaskWorkspacePath, isAutoTaskWorkspacePath, lastPathSegment,
  legacyTitleFolderNames, sanitizeTaskId, taskWorkspaceFolderName,
} from '../lib/client/taskFolder.js'

const ID = '2da8c5bb-30fb-4fba-b3f7-e5cecb513737'

/** 本机的默认任务根目录（设置里的 `ai_default_workspace`）。 */
const TASKS_ROOT = 'D:\\DSHWorkspace'

/** 本机真实库里的 3 条标题型自动路径（含 id/title/path，逐字取自只读导出）。 */
const REAL_LEGACY_TITLE_PATHS = [
  {
    id: '2da8c5bb-30fb-4fba-b3f7-e5cecb513737',
    title: '工作台任务提醒接入微信（可选增量能力）',
    path: 'D:\\DSHWorkspace\\工作台任务提醒接入微信（可选增量能力）',
  },
  {
    id: 'e061977d-0a61-40bd-98b3-6865da0bbaac',
    title: 'Phase 0：实测 dsh-im 可用性与版本兼容（闸门）',
    path: 'D:\\DSHWorkspace\\Phase 0：实测 dsh-im 可用性与版本',
  },
  {
    id: 'd30f4582-b2b4-4e74-8c50-710b525ef8b9',
    title: 'Phase -1（前置）：升级本机 DSH 到 0.1.2-rc.1',
    path: 'D:\\DSHWorkspace\\Phase -1（前置）：升级本机 DSH 到',
  },
]

/** 本机真实库里的手填型样本（用户自己的项目目录，任何情况下都不许被改写）。 */
const REAL_MANUAL_PATHS = [
  { id: '09dbf543-837a-4b99-b153-c87c38ef1ede', title: '设计提醒策略层（分级 / 静默 / 节流 / 补发）', path: 'D:\\Code\\my-workspace' },
  { id: '2287f2e7-0000-0000-0000-000000000000', title: '建设团队共享记忆系统', path: 'D:\\Code\\my-project\\dsh-team-memory' },
]

test('taskFolder: sanitizeTaskId 只留 A-Za-z0-9_-，空则 task', () => {
  assert.equal(sanitizeTaskId(ID), ID)
  assert.equal(sanitizeTaskId('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij')
  assert.equal(sanitizeTaskId('中文 id'), 'id')
  assert.equal(sanitizeTaskId(''), 'task')
  assert.equal(sanitizeTaskId('...'), 'task', '结尾的点会被 Windows 静默吃掉，必须清掉')
})

test('taskFolder: 资料夹名 = <任务ID>-<标题片段>（改良版，稳定 + 可读）', () => {
  assert.equal(taskWorkspaceFolderName(ID, '工作台任务提醒接入微信（可选增量能力）'),
    `${ID}-工作台任务提醒接入微信（可选增量能力）`)
  // 无标题 / 空标题 → 纯 ID（不再退回 '未命名任务'，那不是"没有标题"的意思）
  assert.equal(taskWorkspaceFolderName(ID), ID)
  assert.equal(taskWorkspaceFolderName(ID, ''), ID)
  assert.equal(taskWorkspaceFolderName(ID, '   '), ID)
  // 标题里的路径非法字符被清掉（这里清掉了 / : * ? " < > |），且片段截到 24 字
  assert.equal(taskWorkspaceFolderName('abc', 'a/b:c*d?e"f<g>h|i_j-k l m n o p q r s t u v'),
    'abc-abcdefghi_j-k l m n o p')
  // 非法字符把标题清空时退化成纯 ID
  assert.equal(taskWorkspaceFolderName('abc', '///'), 'abc')
})

test('taskFolder: lastPathSegment 同时兼容 / 与 \\，并忽略结尾分隔符', () => {
  assert.equal(lastPathSegment('D:\\DSHWorkspace\\子目录'), '子目录')
  assert.equal(lastPathSegment('/mnt/d/Code/sub/'), 'sub')
  // 裸盘符根：末段就是 "D:"（既不是 ID 也不是标题，判定会落到 manual —— 语义正确）
  assert.equal(lastPathSegment('D:\\'), 'D:')
  assert.equal(lastPathSegment(''), '')
})

test('taskFolder: legacyTitleFolderNames 就是旧口径 folderForText 的产物（唯一来源）', () => {
  assert.deepEqual(legacyTitleFolderNames('工作台任务提醒接入微信（可选增量能力）'), ['工作台任务提醒接入微信（可选增量能力）'])
  // 超过 24 字 → 旧口径当年就是截断成 24 字的目录名
  assert.deepEqual(legacyTitleFolderNames('Phase 0：实测 dsh-im 可用性与版本兼容（闸门）'), ['Phase 0：实测 dsh-im 可用性与版本'])
  assert.deepEqual(legacyTitleFolderNames(''), [])
  assert.deepEqual(legacyTitleFolderNames(null), [])
})

test('taskFolder 判定（ID 型）：末段 == 任务 ID，或以足够长的 <ID>- 开头', () => {
  const id = 'abc-12345678'   // ≥ MIN_TASK_ID_PREFIX_LENGTH
  assert.equal(classifyTaskWorkspacePath('D:\\root\\abc-12345678', id, '随便什么标题'), 'id')
  assert.equal(classifyTaskWorkspacePath('D:\\root\\abc-12345678-标题片段', id, '标题片段'), 'id')
  assert.equal(classifyTaskWorkspacePath('D:\\root\\abc-12345678-标题片段\\', id, '标题'), 'id')
  // 前缀必须到"边界"为止：abc-123456789 不是 abc-12345678 的资料夹
  assert.equal(classifyTaskWorkspacePath('D:\\root\\abc-123456789', id, '标题'), 'manual')
  assert.equal(classifyTaskWorkspacePath('D:\\root\\xyz', id, '标题'), 'manual')
  // 下划线不再被当作分隔符（生成的名字只用 `-`）；当年那条 `_` 容错就是误判来源之一
  assert.equal(classifyTaskWorkspacePath('D:\\root\\abc-12345678_old', id, '标题'), 'manual')
})

test('taskFolder 判定（F2 回归）：短 ID 不吃前缀，避免手填目录被当成自动资料夹', () => {
  // 实测样本：id='task' 时，手填项目名 `task-old` 曾被判成 'id'
  assert.equal(classifyTaskWorkspacePath('D:\\Code\\proj\\task-old', 'task', '我的项目'), 'manual')
  assert.equal(classifyTaskWorkspacePath('D:\\Code\\proj\\work_notes', 'work', '我的项目'), 'manual')
  // 完全相等仍然算 ID 型（这是"末段就是该任务 ID"的正当形态）
  assert.equal(classifyTaskWorkspacePath('D:\\root\\task', 'task', '我的项目'), 'id')
  assert.equal(MIN_TASK_ID_PREFIX_LENGTH, 8)
})

test('taskFolder 判定（标题型 · 老路径）：本机 3 条真实路径必须仍算"自动"', () => {
  for (const sample of REAL_LEGACY_TITLE_PATHS) {
    assert.equal(
      classifyTaskWorkspacePath(sample.path, sample.id, sample.title, { tasksRoot: TASKS_ROOT }),
      'legacy-title',
      `${sample.path} 在新口径下不以任务 ID 结尾 —— 兼容判据必须把它认成自动路径，否则它永远不再迁移`,
    )
    assert.equal(isAutoTaskWorkspacePath(sample.path, sample.id, sample.title, { tasksRoot: TASKS_ROOT }), true)
  }
})

test('taskFolder 判定（F2 回归）：目录名恰好等于标题、但不在默认根目录下 → 仍是手填', () => {
  /**
   * 这是 fresh-eyes 审查 F2 的核心反例：`folderForText` 对中文/短标题**逐字保留**，
   * 所以"用户手填了一个叫 `<任务标题>` 的项目目录"与"旧口径自动资料夹"在**字符串上无法区分**。
   * 唯一可用的旁证是位置：旧口径的资料夹只可能在默认根目录下面。
   */
  const samples = [
    ['D:\\Code\\proj\\周五接待客户', '周五接待客户'],
    ['D:\\Code\\proj\\Phase 0：实测 dsh-im 可用性与版本', 'Phase 0：实测 dsh-im 可用性与版本兼容（闸门）'],
    ['D:\\Code\\my-workspace', 'dsh-workbench'],
  ]
  for (const [path, title] of samples) {
    assert.equal(
      classifyTaskWorkspacePath(path, ID, title, { tasksRoot: TASKS_ROOT }),
      'manual',
      `${path} 在默认根目录之外，绝不能因为"末段等于标题"被判成自动路径（那会让手填目录被改写）`,
    )
  }
  // 同一个末段，放在根目录下面就恢复成 legacy-title —— 证明差异确实来自"位置旁证"
  assert.equal(
    classifyTaskWorkspacePath(`D:\\DSHWorkspace\\周五接待客户`, ID, '周五接待客户', { tasksRoot: TASKS_ROOT }),
    'legacy-title',
  )
})

test('taskFolder 判定（F2 回归）：不提供 tasksRoot 时一律不判 legacy-title（fail-safe）', () => {
  // 没有根目录旁证 → 无法区分手填与自动 → 宁可"不迁移"（manual），也不冒"误迁移"的险
  for (const sample of REAL_LEGACY_TITLE_PATHS) {
    assert.equal(
      classifyTaskWorkspacePath(sample.path, sample.id, sample.title),
      'manual',
      '缺旁证时必须 fail-safe 成 manual',
    )
  }
  // ID 型判据**不需要**旁证（末段带整个 UUID，本身就是充分证据）
  assert.equal(classifyTaskWorkspacePath(`D:\\任意位置\\${ID}-标题`, ID, '标题'), 'id')
  assert.equal(classifyTaskWorkspacePath(`D:\\任意位置\\${ID}-标题`, ID, '标题', { tasksRoot: '' }), 'id')
  assert.equal(classifyTaskWorkspacePath(`D:\\任意位置\\${ID}-标题`, ID, '标题', { tasksRoot: null }), 'id')
})

test('taskFolder 判定（手填型）：本机真实的项目目录绝不能被认成自动路径', () => {
  for (const sample of REAL_MANUAL_PATHS) {
    assert.equal(classifyTaskWorkspacePath(sample.path, sample.id, sample.title, { tasksRoot: TASKS_ROOT }), 'manual')
    assert.equal(isAutoTaskWorkspacePath(sample.path, sample.id, sample.title, { tasksRoot: TASKS_ROOT }), false)
  }
  // 掉一个 \ 也是手填（不做"猜路径"的模糊匹配）
  assert.equal(classifyTaskWorkspacePath('D:\\Code\\my-project', ID, '标题', { tasksRoot: TASKS_ROOT }), 'manual')
})

test('taskFolder 判定：三种形态互斥且穷举（表驱动）', () => {
  const cases = [
    ['id', `D:\\root\\${ID}-标题片段`, ID, '标题片段'],
    ['id', `/mnt/d/root/${ID}`, ID, '任意标题'],
    ['legacy-title', 'D:\\DSHWorkspace\\工作台任务提醒接入微信（可选增量能力）', ID, '工作台任务提醒接入微信（可选增量能力）'],
    ['legacy-title', 'D:\\DSHWorkspace\\工作台任务提醒接入微信（可选增量能力）', ID, '工作台任务提醒接入微信（可选增量能力）'],
    ['manual', 'D:\\Code\\my-workspace', ID, '某个标题'],
    ['manual', 'D:\\Code\\proj\\周五接待客户', ID, '周五接待客户'],
    ['manual', '', ID, '某个标题'],
    ['manual', '   ', ID, '某个标题'],
  ]
  for (const [expected, path, taskId, title] of cases) {
    const actual = classifyTaskWorkspacePath(path, taskId, title, { tasksRoot: TASKS_ROOT })
    assert.equal(actual, expected, `${JSON.stringify({ path, taskId, title })} 期望 ${expected}，实际 ${actual}`)
  }
})

test('taskFolder 判定：没有标题时，老路径判据不会误伤（只有 ID 型能算自动）', () => {
  const context = { tasksRoot: TASKS_ROOT }
  assert.equal(classifyTaskWorkspacePath('D:\\DSHWorkspace\\工作台任务提醒接入微信（可选增量能力）', ID, null, context), 'manual')
  assert.equal(classifyTaskWorkspacePath('D:\\DSHWorkspace\\工作台任务提醒接入微信（可选增量能力）', ID, '', context), 'manual')
})
