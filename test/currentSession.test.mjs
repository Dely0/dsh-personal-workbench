/**
 * 「当前会话」判定的单测（v1.15.6）。
 *
 * ## 这份测试防的是哪个真退化
 *
 * 2026-09-27 用户在 DSH 0.1.7-rc.2 桌面端上遇到：任务详情页的「AI 执行 / 协助 / 拆解」
 * 对**工作区落在任务资料夹里**的任务直接报「无法确定这次会话该用哪个工作区」。
 *
 * 根因不在工作区判定本身，而在它的**第 1 档输入**：0.1.7-rc.2 的
 * `sessions.list.getSnapshot()` 不再发布 `current`，而插件还在读它 →
 * "当前会话 cwd 命中谁就用谁"这一档静默失效 → 只剩"唯一候选"那两档，工作区一多必然拒绝。
 *
 * 所以断言按**宿主形态**写，而不是按实现细节：
 * - 0.1.7 形态（列表没有 `current`）：必须能从 `uiSession.adapter.current` 读出来；
 * - 0.1.5 形态（列表带 `current`、没有 uiSession）：必须还能读出来；
 * - 两边都读不到：必须返回空串（"不知道"），**绝不猜一个会话**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCurrentSessionId } from '../lib/client/currentSession.js'

/** 造一个宿主 `uiSession` 替身：`shape` 决定 `adapter.current` 给出什么。 */
function uiSessionWith(value) {
  return { adapter: { current: { value, getSnapshot: () => value, subscribe: () => () => {} } } }
}

test('0.1.7-rc.2 形态：列表没有 current，从 uiSession 的绑定源读出当前会话', () => {
  const id = readCurrentSessionId({
    uiSession: uiSessionWith({ key: 'session-abc', props: { sessionId: 'session-abc' } }),
    // 真实形态：0.1.7-rc.2 的 list 快照里根本没有 current
    list: { ids: ['session-abc', 'session-def'] },
  })
  assert.equal(id, 'session-abc')
})

test('0.1.7-rc.2：key 缺失时用 props.sessionId 兜底（绑定值形状可能只有其一）', () => {
  const id = readCurrentSessionId({ uiSession: uiSessionWith({ props: { sessionId: 'session-def' } }) })
  assert.equal(id, 'session-def')
})

test('0.1.7-rc.2：只给 getSnapshot 不给 value 也要能读（绑定源的真实接口）', () => {
  const source = { getSnapshot: () => ({ key: 'session-only-snapshot' }) }
  assert.equal(readCurrentSessionId({ uiSession: { adapter: { current: source } } }), 'session-only-snapshot')
})

test('缺席绑定（还没有任何会话被 mainView 持有）→ 空串，不猜', () => {
  assert.equal(readCurrentSessionId({ uiSession: uiSessionWith({ key: undefined, props: {} }), list: { ids: ['session-first'] } }), '')
})

test('旧宿主形态（≤0.1.5）：没有 uiSession 时退到列表快照的 current', () => {
  assert.equal(readCurrentSessionId({ list: { current: 'session-legacy' } }), 'session-legacy')
})

test('两个来源都在时以 uiSession 为准（它就是宿主此刻渲染的会话）', () => {
  const id = readCurrentSessionId({
    uiSession: uiSessionWith({ key: 'session-rendered' }),
    list: { current: 'session-stale' },
  })
  assert.equal(id, 'session-rendered')
})

test('uiSession 拿不到 → 仍然用旧的 current（不能因为加了新来源就丢掉旧宿主）', () => {
  assert.equal(readCurrentSessionId({ uiSession: undefined, list: { current: 'session-legacy' } }), 'session-legacy')
})

test('两份快照都缺失 / 都是脏值 → 空串（"不知道"，绝不退化成列表第一个）', () => {
  assert.equal(readCurrentSessionId({}), '')
  assert.equal(readCurrentSessionId({ list: undefined }), '')
  assert.equal(readCurrentSessionId({ uiSession: 'not-an-object', list: {} }), '')
  assert.equal(readCurrentSessionId({ uiSession: { adapter: {} } }), '')
  assert.equal(readCurrentSessionId({ uiSession: { adapter: { current: null } } }), '')
  assert.equal(readCurrentSessionId({ uiSession: uiSessionWith('session-as-string') }), '')
  assert.equal(readCurrentSessionId({ uiSession: uiSessionWith({ key: 42 }) }), '')
  assert.equal(readCurrentSessionId({ uiSession: uiSessionWith({ key: '   ' }) }), '')
  assert.equal(readCurrentSessionId({ list: { current: '' } }), '')
  assert.equal(readCurrentSessionId({ list: { current: 123 } }), '')
})

test('纯函数性：不读输入对象以外的任何东西，同输入同输出', () => {
  const probe = { uiSession: uiSessionWith({ key: 'session-x' }), list: { current: 'session-y' } }
  const frozen = JSON.parse(JSON.stringify(probe))
  assert.equal(readCurrentSessionId(probe), 'session-x')
  assert.equal(readCurrentSessionId(probe), 'session-x')
  assert.deepEqual(JSON.parse(JSON.stringify(probe)), frozen, '判定不得改动输入')
})
