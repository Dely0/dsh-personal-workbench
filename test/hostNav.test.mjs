/**
 * 回归测试：DSH 0.1.7 客户端契约适配（src/client/hostNav.ts）。
 *
 * 背景：0.1.7 移除了 `sessions.open(id)` 与 `SessionListState.current`，
 * 并把 `workspaces.openPath` 搬走。这组用例锁住替代实现，防止再次静默漂移：
 *  - 当前会话必须按宿主的 `retainedBy.mainView > 0` 口径判定
 *  - 导航必须走 `uiWorkspace.openSession`（且保留 this 绑定）
 *  - 宿主不提供 uiWorkspace / 服务读取抛错时，只能告警并返回 false，不能抛
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { currentSessionIdOf, openHostSession } from '../lib/client/hostNav.js'

const summary = (id, retainedBy) => ({ id, displayTitle: id, ...(retainedBy === undefined ? {} : { retainedBy }) })

test('currentSessionIdOf 按 mainView 保留计数判定当前会话', () => {
  const state = {
    ids: ['a', 'b', 'c'],
    byId: {
      a: summary('a', { gateway: 1 }),
      b: summary('b', { mainView: 1, gateway: 2 }),
      c: summary('c', { controllerOperation: 1 }),
    },
  }
  assert.equal(currentSessionIdOf(state), 'b')
})

test('currentSessionIdOf 在没有 mainView 保留时返回 undefined', () => {
  const state = { ids: ['a'], byId: { a: summary('a', { gateway: 3 }) } }
  assert.equal(currentSessionIdOf(state), undefined)
})

test('currentSessionIdOf 容忍 0.1.6 形态的摘要（没有 retainedBy 字段）', () => {
  const state = { ids: ['a'], byId: { a: summary('a') } }
  assert.equal(currentSessionIdOf(state), undefined)
})

test('openHostSession 通过 uiWorkspace.openSession 导航，并保留 this 绑定', () => {
  const seen = []
  const uiWorkspace = {
    marker: 'service',
    openSession(target) { seen.push([this === uiWorkspace, target]) },
  }
  const runtime = { get: (key) => (key === 'uiWorkspace' ? uiWorkspace : undefined) }
  assert.equal(openHostSession(runtime, 'sess-1'), true)
  assert.deepEqual(seen, [[true, 'sess-1']])
})

test('宿主未提供 uiWorkspace 时只告警并返回 false', () => {
  const warned = []
  const original = console.warn
  console.warn = (...args) => { warned.push(args.join(' ')) }
  try {
    assert.equal(openHostSession({ get: () => undefined }, 'sess-2'), false)
    assert.equal(openHostSession(undefined, 'sess-2'), false)
    assert.equal(openHostSession({ get: () => ({}) }, 'sess-2'), false)
  } finally {
    console.warn = original
  }
  assert.equal(warned.length, 3)
  assert.match(warned[0], /uiWorkspace\.openSession/)
})

test('ctx.get 抛错（未声明 inject 的 cordis 代理）不得冒泡', () => {
  const warned = []
  const original = console.warn
  console.warn = () => { warned.push(1) }
  try {
    const runtime = { get: () => { throw new Error('cannot get property "uiWorkspace" without inject') } }
    assert.equal(openHostSession(runtime, 'sess-3'), false)
  } finally {
    console.warn = original
  }
  assert.equal(warned.length, 1)
})
