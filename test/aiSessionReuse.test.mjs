/**
 * 表驱动单测：**复用型会话"还能不能复用"的唯一权威源**（2026-09-17 真实故障的回归锁）。
 *
 * 钉住四件事：
 * 1. 归档过的会话**不可复用**（哪怕它还留在宿主会话列表里）；
 * 2. 宿主列表 `ready` 却查不到该会话 → **不可复用**（会话被物理删除的情形）；
 * 3. 列表 `pending`（`ids` 还是空的）→ 复用（**不**把"还没加载"当成"没了"）；
 * 4. 旧宿主缺归档集 / 会话列表快照 → 复用（零回归）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAiSessionReusable } from '../lib/client/aiSessionReuse.js'

const ready = (ids, current = ids[0]) => ({ ids, current, phase: 'ready' })
const pending = () => ({ ids: [], current: undefined, phase: 'pending' })

const CASES = [
  { name: '列表就绪且含该会话 → 复用', probe: { sessionId: 's1', archivedSessionIds: [], list: ready(['s1', 's2']) }, want: true },
  { name: '归档集含该会话 → 不复用（哪怕列表里还有）', probe: { sessionId: 's1', archivedSessionIds: ['s1'], list: ready(['s1']) }, want: false },
  { name: '归档集含该会话、且列表 pending → 不复用（归档是硬判据）', probe: { sessionId: 's1', archivedSessionIds: ['s1'], list: pending() }, want: false },
  { name: '列表就绪但查不到该会话 → 不复用（真被删除）', probe: { sessionId: 's1', archivedSessionIds: [], list: ready(['s2']) }, want: false },
  { name: '列表就绪、它就是当前会话 → 复用', probe: { sessionId: 's1', archivedSessionIds: [], list: { ids: ['s2'], current: 's1', phase: 'ready' } }, want: true },
  { name: '列表 pending（ids 还空）→ 复用（不误判成删除）', probe: { sessionId: 's1', archivedSessionIds: [], list: pending() }, want: true },
  { name: '旧宿主：拿不到会话列表快照 → 复用', probe: { sessionId: 's1', archivedSessionIds: ['other'] }, want: true },
  { name: '旧宿主：没有归档集字段 → 复用', probe: { sessionId: 's1', list: ready(['s1']) }, want: true },
  { name: '归档集为 undefined（字段缺失）→ 按无归档处理', probe: { sessionId: 's1', archivedSessionIds: undefined, list: ready(['s1']) }, want: true },
]

for (const item of CASES) {
  test(item.name, () => {
    assert.equal(isAiSessionReusable(item.probe), item.want)
  })
}

test('判据是纯函数：不改输入、可重复', () => {
  const probe = { sessionId: 's1', archivedSessionIds: ['s1'], list: ready(['s1']) }
  const before = JSON.stringify(probe)
  assert.equal(isAiSessionReusable(probe), false)
  assert.equal(isAiSessionReusable(probe), false)
  assert.equal(JSON.stringify(probe), before)
})
