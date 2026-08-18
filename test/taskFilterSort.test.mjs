import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_TASK_FILTER,
  buildTaskTree,
  compareTasks,
  createTaskSorter,
  filterTaskTree,
  isTaskFilterEmpty,
  matchesTaskFilter,
} from '../lib/client/taskFilterSort.js'

const task = (id, overrides = {}) => ({
  id,
  parentId: null,
  title: '',
  description: '',
  statusCode: 'todo',
  priorityCode: 'p2',
  typeCode: 'feature_opt',
  dueAt: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

test('task filter: keyword matches title/description and conditions combine', () => {
  const a = task('a', { title: '修复登录闪退', description: '复现步骤见附件' })
  const b = task('b', { title: '无关任务', description: '里面提到了 闪退 关键词' })
  const c = task('c', { title: '登录页样式', statusCode: 'doing', priorityCode: 'p1', typeCode: 'code_impl' })

  assert.equal(matchesTaskFilter(a, { ...EMPTY_TASK_FILTER, keyword: '登录' }), true)
  assert.equal(matchesTaskFilter(b, { ...EMPTY_TASK_FILTER, keyword: '闪退' }), true)
  assert.equal(matchesTaskFilter(a, { ...EMPTY_TASK_FILTER, keyword: '不存在的词' }), false)
  assert.equal(matchesTaskFilter(c, { ...EMPTY_TASK_FILTER, statusCode: 'doing', priorityCode: 'p1', typeCode: 'code_impl' }), true)
  assert.equal(matchesTaskFilter(c, { ...EMPTY_TASK_FILTER, statusCode: 'doing', priorityCode: 'p2' }), false)
  assert.equal(isTaskFilterEmpty(EMPTY_TASK_FILTER), true)
  assert.equal(isTaskFilterEmpty({ ...EMPTY_TASK_FILTER, keyword: '  ' }), true)
  assert.equal(isTaskFilterEmpty({ ...EMPTY_TASK_FILTER, statusCode: 'todo' }), false)
})

test('task tree filter keeps parent chain when a descendant matches', () => {
  const parent = task('p', { title: '父任务' })
  const hitChild = task('c1', { parentId: 'p', title: '包含 特殊词 的子任务' })
  const missChild = task('c2', { parentId: 'p', title: '不匹配的子任务' })
  const otherRoot = task('r', { title: '另一个根任务' })

  const tree = buildTaskTree([parent, hitChild, missChild, otherRoot])
  const filtered = filterTaskTree(tree, (t) => matchesTaskFilter(t, { ...EMPTY_TASK_FILTER, keyword: '特殊词' }))

  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].task.id, 'p')
  assert.equal(filtered[0].children.length, 1)
  assert.equal(filtered[0].children[0].task.id, 'c1')
})

test('task tree filter drops non-matching children under a matching parent', () => {
  const parent = task('p', { title: '匹配的父任务' })
  const child = task('c1', { parentId: 'p', title: '子任务' })

  const tree = buildTaskTree([parent, child])
  const filtered = filterTaskTree(tree, (t) => matchesTaskFilter(t, { ...EMPTY_TASK_FILTER, keyword: '父任务' }))

  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].task.id, 'p')
  assert.equal(filtered[0].children.length, 0)
})

test('task sorter: dueAt asc/desc with nulls last', () => {
  const early = task('a', { dueAt: '2024-01-01T00:00:00.000Z' })
  const late = task('b', { dueAt: '2024-06-01T00:00:00.000Z' })
  const none = task('c', { dueAt: null })

  assert.deepEqual([late, none, early].sort(createTaskSorter('dueAt', 'asc')).map((t) => t.id), ['a', 'b', 'c'])
  assert.deepEqual([early, none, late].sort(createTaskSorter('dueAt', 'desc')).map((t) => t.id), ['b', 'a', 'c'])
})

test('task sorter: priority asc means high priority first, desc means low priority first', () => {
  const weights = new Map([['p0', 0], ['p1', 1], ['p2', 2], ['p3', 3]])
  const p0 = task('a', { priorityCode: 'p0' })
  const p2 = task('b', { priorityCode: 'p2' })
  const p3 = task('c', { priorityCode: 'p3' })

  assert.deepEqual([p2, p0, p3].sort(createTaskSorter('priority', 'asc', weights)).map((t) => t.id), ['a', 'b', 'c'])
  assert.deepEqual([p2, p0, p3].sort(createTaskSorter('priority', 'desc', weights)).map((t) => t.id), ['c', 'b', 'a'])
})

test('task sorter: createdAt and title', () => {
  const older = task('a', { createdAt: '2024-01-01T00:00:00.000Z', title: 'Alpha' })
  const newer = task('b', { createdAt: '2024-02-01T00:00:00.000Z', title: 'Beta' })

  assert.deepEqual([newer, older].sort(createTaskSorter('createdAt', 'asc')).map((t) => t.id), ['a', 'b'])
  assert.deepEqual([older, newer].sort(createTaskSorter('createdAt', 'desc')).map((t) => t.id), ['b', 'a'])
  assert.deepEqual([older, newer].sort(createTaskSorter('title', 'asc')).map((t) => t.id), ['a', 'b'])
  assert.deepEqual([older, newer].sort(createTaskSorter('title', 'desc')).map((t) => t.id), ['b', 'a'])
})

test('buildTaskTree with sorter only reorders siblings, not across levels', () => {
  const rootA = task('ra', { title: '根B' })
  const rootB = task('rb', { title: '根A' })
  const childA = task('ca', { parentId: 'ra', title: '子B' })
  const childB = task('cb', { parentId: 'ra', title: '子A' })

  const tree = buildTaskTree([rootA, rootB, childA, childB], undefined, createTaskSorter('title', 'asc'))
  assert.deepEqual(tree.map((n) => n.task.id), ['rb', 'ra'])
  assert.deepEqual(tree[1].children.map((n) => n.task.id), ['cb', 'ca'])
})

test('compareTasks returns deterministic tie-breaker', () => {
  const a = task('a', { createdAt: '2024-01-01T00:00:00.000Z' })
  const b = task('b', { createdAt: '2024-01-01T00:00:00.000Z' })
  assert.equal(compareTasks(a, b, 'title', 'asc'), a.id.localeCompare(b.id))
})
