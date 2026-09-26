/**
 * 会话引用获取的单测（v1.15.5）。
 *
 * ## 这份测试防的是哪个真 bug（DSH 0.1.7-rc.2 桌面端，2026-09-26）
 *
 * 用户点「快速录入 / 创建澄清会话」报 **"会话绑定未就绪，请稍后重试"**，整条澄清链路不可用。
 *
 * 根因是宿主在同一个大版本里**改了 `sessions.binding(id)` 的语义**：
 *
 * | 宿主 | `binding(id)` 的判据 |
 * |---|---|
 * | ≤ 0.1.5 | "在会话列表里 **或** 是当前会话" → 刚 `create()` 出来的能拿到 |
 * | 0.1.7-rc.2 | **只查已被 retain 的 scope**：没人 `retain()` 就永远拿不到 |
 *
 * 而 `uiWorkspace.connectWorkspace()` 内部只是 `sessions.create()` —— **谁都没 retain**。
 * 所以插件必须自己 `retain(id, {source})`，用完 `release()`。
 *
 * 断言按"调用方拿到什么"写：拿到能用的会话 / 明确报错 / **release 次数与 retain 配对**。
 * 最后一条最要紧：漏释放会让会话 scope 永不回收（宿主按引用计数管理）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acquireSession, openSessionInMainView, SESSION_BINDING_ERROR, SESSION_OPEN_UNAVAILABLE } from '../lib/client/sessionRef.js'

/** 造一个"只能由 retain 拿到绑定"的 rc2 宿主替身。 */
function rc2Host({ session = { prompt: async () => ({ ok: true }), rename: async () => undefined }, readyRejects = null } = {}) {
  const released = { count: 0 }
  const retained = []
  return {
    session,
    released,
    retained,
    sessions: {
      list: { getSnapshot: () => ({ ids: ['new-1'], byId: {}, current: 'new-1' }) },
      // rc2 的真实行为：没 retain 过 → 拿不到
      binding: () => undefined,
      retain: (id, options) => {
        retained.push({ id, options })
        return {
          sessionId: id,
          ready: readyRejects === null ? Promise.resolve() : Promise.reject(readyRejects),
          get binding() {
            if (released.count > 0) throw new Error('released')
            return { session }
          },
          release: () => { released.count += 1 },
        }
      },
    },
  }
}

test('rc2：必须走 retain 才拿得到会话（旧写法 binding() 恒 undefined）', async () => {
  const host = rc2Host()
  const ref = await acquireSession(host.sessions, 'new-1')
  assert.equal(ref.session, host.session, '拿到的必须就是那个会话驱动')
  assert.equal(host.retained.length, 1, '恰好 retain 一次')
  assert.deepEqual(host.retained[0].options, { source: 'personal-workbench' },
    '必须带 source 标签：宿主按它做引用计数，也便于排查"谁占着这个会话"')
})

test('rc2：release 与 retain 一一配对', async () => {
  const host = rc2Host()
  const ref = await acquireSession(host.sessions, 'new-1')
  assert.equal(host.released.count, 0, 'acquire 阶段不该释放')
  ref.release()
  assert.equal(host.released.count, 1)
})

test('rc2：release 必须幂等 —— 重复调用不能把引用计数减多', async () => {
  const host = rc2Host()
  const ref = await acquireSession(host.sessions, 'new-1')
  ref.release()
  ref.release()
  ref.release()
  assert.equal(host.released.count, 1, '重复 release 会让宿主的计数减多（别人还持有时被提前回收）')
})

test('rc2：宿主的 open 失败（ready reject）时，引用必须被释放后再抛错', async () => {
  const host = rc2Host({ readyRejects: new Error('session/open failed') })
  await assert.rejects(() => acquireSession(host.sessions, 'new-1'), /session\/open failed/)
  assert.equal(host.released.count, 1, '失败路径也要释放：否则那个会话的 scope 永不回收')
})

test('旧宿主（≤0.1.5，没有 retain）：退到 binding()，释放是 no-op', async () => {
  const session = { prompt: async () => ({ ok: true }), rename: async () => undefined }
  const sessions = {
    list: { getSnapshot: () => ({ ids: ['old-1'], byId: {}, current: 'old-1' }) },
    binding: (id) => (id === 'old-1' ? { session } : undefined),
    open: () => undefined,
  }
  const ref = await acquireSession(sessions, 'old-1')
  assert.equal(ref.session, session)
  ref.release() // 旧宿主自己管生命周期：这里只是不能抛
})

test('两边都拿不到 → 明确报错，绝不返回"半可用"的引用', async () => {
  const sessions = {
    list: { getSnapshot: () => ({ ids: [], byId: {} }) },
    binding: () => undefined,
    open: () => undefined,
  }
  await assert.rejects(() => acquireSession(sessions, 'ghost'), (error) => {
    assert.equal(error.message, SESSION_BINDING_ERROR)
    return true
  })
})

test('sessions 服务本身缺失（插件在死上下文里）→ 也是明确报错，不抛 TypeError', async () => {
  await assert.rejects(() => acquireSession(undefined, 'x'), (error) => {
    assert.equal(error.message, SESSION_BINDING_ERROR)
    return true
  })
})

// ── 切换主视图（rc2 移除了 sessions.open）─────────────────────────────

/** 造一个可观察"谁被调用"的替身：attributes 直取 + ctx.get 两种取法都覆盖。 */
function openHost({ uiWorkspace, sessions, viaGet = false } = {}) {
  const calls = { openSession: [], open: [] }
  const services = {
    uiWorkspace: uiWorkspace === undefined ? undefined : { openSession: (id) => { calls.openSession.push(id); uiWorkspace.onCall?.(id) } },
    sessions: sessions === undefined ? undefined : { open: (id) => { calls.open.push(id); sessions.onCall?.(id) } },
  }
  const ctx = viaGet ? { get: (name) => services[name] } : services
  return { ctx, calls }
}

test('切主视图：rc2 走 uiWorkspace.openSession，**不去碰** sessions.open', () => {
  const host = openHost({ uiWorkspace: {}, sessions: {} })
  assert.equal(openSessionInMainView(host.ctx, 's-1'), 'uiWorkspace')
  assert.deepEqual(host.calls.openSession, ['s-1'])
  assert.deepEqual(host.calls.open, [], 'rc2 上 sessions.open 已不存在，不该被调用')
})

test('切主视图：宿主只提供 sessions.open（≤0.1.5 形态）时回落', () => {
  const host = openHost({ sessions: {} })
  assert.equal(openSessionInMainView(host.ctx, 's-2'), 'sessions')
  assert.deepEqual(host.calls.open, ['s-2'])
})

test('切主视图：ctx.get 取法也要能用（未 inject 的可选服务走这条）', () => {
  const host = openHost({ uiWorkspace: {}, viaGet: true })
  assert.equal(openSessionInMainView(host.ctx, 's-3'), 'uiWorkspace')
  assert.deepEqual(host.calls.openSession, ['s-3'])
})

test('切主视图：uiWorkspace 在但没有 openSession → 回落 sessions.open（不抛）', () => {
  const host = openHost({ uiWorkspace: undefined, sessions: {} })
  host.ctx.uiWorkspace = {}
  assert.equal(openSessionInMainView(host.ctx, 's-4'), 'sessions')
  assert.deepEqual(host.calls.open, ['s-4'])
})

test('切主视图：两条腿都没有 → 抛可读错误（绝不静默什么都不发生）', () => {
  assert.throws(() => openSessionInMainView({}, 's-5'), (error) => {
    assert.equal(error.message, SESSION_OPEN_UNAVAILABLE)
    return true
  })
})

test('切主视图：空 id 当场拒绝（不把空串丢给宿主）', () => {
  const host = openHost({ uiWorkspace: {}, sessions: {} })
  assert.throws(() => openSessionInMainView(host.ctx, ''), /会话 id 为空/)
  assert.deepEqual(host.calls.openSession, [])
})

test('切主视图：宿主抛错时原样抛出（由调用方显示原因，不吞）', () => {
  const ctx = { uiWorkspace: { openSession: () => { throw new Error('sessions.retain: unknown session') } } }
  assert.throws(() => openSessionInMainView(ctx, 'ghost'), /unknown session/)
})
