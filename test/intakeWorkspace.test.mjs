/**
 * 「这次 AI 会话该用哪个工作区」的单测（v1.15.1）。
 *
 * ## 这份测试防的是哪个真 bug
 *
 * `src/client/index.tsx` 原先写 `let workspaceId = ws.items[0]?.workspaceId` ——
 * **随手取列表里第一个工作区**。任务没填路径、默认工作区也为空时，
 * 会话会挂到一个与用户当前连接完全无关的工作区上（最坏是别的任务的资料夹），
 * 于是本次澄清产生的文件全落进了别人的目录。
 *
 * 断言按"用户能感觉到的结果"写，而不是按实现细节：
 * - 当前会话在一个工作区里 → **必须**用它；
 * - 只剩一个候选 → 用它；
 * - 有歧义 → **必须拒绝**并给出可读原因（绝不猜第一个）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickIntakeWorkspace, workspacePathKeys } from '../lib/client/intakeWorkspace.js'

const TASKS_ROOT = 'D:\\DSHWorkspace'

/** 典型现场：默认任务根 + 一个任务资料夹 + 用户真实项目目录。 */
const items = [
  { workspaceId: 'ws-task-folder', path: `${TASKS_ROOT}\\工作台任务提醒接入微信（可选增量能力）` },
  { workspaceId: 'ws-project', path: 'D:\\Code\\my-workspace' },
  { workspaceId: 'ws-other', path: 'D:\\Code\\team-memory' },
]

test('intakeWorkspace: 当前会话的 cwd 命中谁就用谁（不取列表第一个）', () => {
  const verdict = pickIntakeWorkspace({ items, currentCwd: 'D:\\Code\\my-workspace', tasksRoot: TASKS_ROOT })
  assert.deepEqual(verdict, { ok: true, workspaceId: 'ws-project', because: 'current-cwd' })
})

test('intakeWorkspace: 无路径任务不会落到无关工作区（回归：ws.items[0]）', () => {
  // 列表第一个是「别的任务的资料夹」——这正是旧实现会选中的那个
  const verdict = pickIntakeWorkspace({ items, currentCwd: 'D:\\Code\\team-memory', tasksRoot: TASKS_ROOT })
  assert.equal(verdict.ok, true)
  assert.notEqual(verdict.workspaceId, items[0].workspaceId, '绝不能取第一个（那是另一个任务的资料夹）')
  assert.equal(verdict.workspaceId, 'ws-other')
})

test('intakeWorkspace: 排除任务资料夹型工作区后只剩一个 → 用它', () => {
  const verdict = pickIntakeWorkspace({
    items: [items[0], { workspaceId: 'ws-only-real', path: 'D:\\Code\\proj' }],
    currentCwd: '',
    tasksRoot: TASKS_ROOT,
  })
  assert.deepEqual(verdict, { ok: true, workspaceId: 'ws-only-real', because: 'only-candidate' })
})

test('intakeWorkspace: 有歧义时明确拒绝，并给出可读、可照做的原因', () => {
  const verdict = pickIntakeWorkspace({ items, currentCwd: '', tasksRoot: TASKS_ROOT })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /无法确定/)
  assert.match(verdict.reason, /快速录入/, '原因里要告诉用户去哪儿指定')
  // 候选路径用的是夹具里那个中性目录名（原先写的是本机真实仓库名，已改成示例路径）
  assert.ok(verdict.reason.includes('my-workspace'), '原因里要列出候选路径，否则用户不知道有哪些')
  assert.ok(verdict.reason.includes('不会随手取第一个工作区'))
})

test('intakeWorkspace: 只有一个已注册工作区时直接用（没有歧义）', () => {
  const verdict = pickIntakeWorkspace({ items: [items[0]], currentCwd: '', tasksRoot: TASKS_ROOT })
  assert.deepEqual(verdict, { ok: true, workspaceId: 'ws-task-folder', because: 'single-workspace' })
})

test('intakeWorkspace: 一个工作区都没有 → 可读拒绝', () => {
  const verdict = pickIntakeWorkspace({ items: [], currentCwd: '', tasksRoot: '' })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /没有可用工作区/)
})

test('intakeWorkspace: 未配置默认根目录时不排除任何工作区（不能凭空猜"这是任务资料夹"）', () => {
  const verdict = pickIntakeWorkspace({ items: [items[0], items[1]], currentCwd: '', tasksRoot: '' })
  assert.equal(verdict.ok, false, '两个候选 + 没有根目录判据 → 有歧义，必须拒绝而不是选第一个')
})

test('intakeWorkspace: 路径比较容错（大小写、斜杠方向、Windows↔WSL 混写）', () => {
  assert.deepEqual(workspacePathKeys('D:\\Code\\Proj\\'), workspacePathKeys('d:/code/proj'))
  assert.ok(workspacePathKeys('D:\\Code\\Proj').includes('/mnt/d/Code/Proj'.toLowerCase()),
    'Windows 形态要同时给出 WSL 形态的键，覆盖"宿主在 WSL、设置里填 Windows 路径"的混写')
  assert.deepEqual(workspacePathKeys(''), [])
  const verdict = pickIntakeWorkspace({ items, currentCwd: '/mnt/d/code/my-workspace', tasksRoot: TASKS_ROOT })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.workspaceId, 'ws-project', 'WSL 形态的 cwd 也要能命中 Windows 形态的工作区路径')
})
