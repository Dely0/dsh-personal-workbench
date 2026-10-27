/**
 * 模型目录的"问哪个会话 + 怎么持有" —— 2026-10-26 桌面端 DSH 0.2.1-rc.3 的**选不了模型**事故。
 *
 * 事故形态（用户截图）：
 *
 * ```text
 * 模型选择接口在场，但这次取不到该会话的模型目录（宿主要求先把该会话 retain 起来才能取它的模型目录）：
 * 宿主为会话 310293e7-… 解析模型目录时抛错：ui-model-selection: session "310293e7-…" resolved no scope
 * ```
 *
 * 根因：宿主 `directoryFor()` 先查 `sessions.scope(id)`，而 scope 只在有人 `retain()` 过
 * 这个会话之后才存在；插件自己解析目录、自己没 retain，还退到"列表第一个会话"。
 *
 * 本文件钉住四件事：
 *
 * 1. `pickDirectorySessionId()` 的挑选顺序（当前 → 已被持有 → `ids[0]` → 空）；
 * 2. `sessionRef.ts` 的 `createSessionHold()` 引用计数语义
 *    （多使用者只 retain 一次、最后一个离开才 release、已有人持有则不重复 retain）；
 * 3. `resolveModelDirectoryOutcome()` 的**单次重试**（只在 `no scope`/`no binding` 时补持有）；
 * 4. 结构性约束：全仓只有 `sessionRef.ts` 一处真的 retain 会话，`ModelPicker` 不许自己挑
 *    `current ?: ids[0]`。
 *
 * 纯逻辑，不 import React、不碰 DOM → `node --test` 直接跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'

import { createSessionHold, hasAnyRetention } from '../lib/client/sessionRef.js'
import { pickDirectorySessionId } from '../lib/client/modelDirectorySession.js'
import { installServiceScope, resetServiceScope, serviceScopeCtx } from '../lib/client/serviceScope.js'
import { modelDirectoryUnavailableReason, resolveModelDirectoryOutcome } from '../lib/client/modelCapability.js'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

/** 一个"像宿主那样"的持有面替身：`retain` 会真的把会话"物化"（scope 才有）。 */
const fakeSessions = (options = {}) => {
  const scopes = new Map()
  const stats = { retainCalls: 0, releaseCalls: 0 }
  const { alreadyRetained = false, retainThrows = false, retainUnavailable = false, readyRejects = false } = options
  if (alreadyRetained && options.sessionId !== undefined) scopes.set(options.sessionId, { refs: 1, by: { mainView: 1 } })
  return {
    scopes,
    stats,
    ...(retainUnavailable ? {} : {
      retain(id) {
        stats.retainCalls += 1
        if (retainThrows) throw new Error('session cannot be opened')
        const record = scopes.get(id) ?? { refs: 0, by: {} }
        record.refs += 1
        record.by['personal-workbench'] = (record.by['personal-workbench'] ?? 0) + 1
        scopes.set(id, record)
        let released = false
        return {
          get ready() { return readyRejects ? Promise.reject(new Error('open failed')) : Promise.resolve(undefined) },
          release() {
            if (released) return
            released = true
            stats.releaseCalls += 1
            const current = scopes.get(id)
            if (current === undefined) return
            current.refs -= 1
            const count = current.by['personal-workbench'] ?? 0
            if (count <= 1) delete current.by['personal-workbench']
            else current.by['personal-workbench'] = count - 1
            if (current.refs <= 0) scopes.delete(id)
          },
        }
      },
    }),
    retainInfo(id) {
      return {
        getSnapshot: () => {
          const record = scopes.get(id)
          return { referenceCount: record?.refs ?? 0, retainedBy: record === undefined ? {} : { ...record.by } }
        },
      }
    },
  }
}

/** 一个"像宿主那样"的目录服务：没有 scope 就抛 no scope（与 0.2.1-rc.3 逐字同形）。 */
const fakeModelDirectories = (sessions) => ({
  calls: [],
  directoryFor(id) {
    this.calls.push(id)
    if (sessions.scopes.get(id) === undefined) {
      throw new Error(`ui-model-selection: session "${id}" resolved no scope`)
    }
    return { store: { getSnapshot: () => ({ current: null, groups: [], failures: [], status: 'idle', error: null }) } }
  },
})

// ============================================================ 挑选会话

test('pickDirectorySessionId：当前会话优先，其次已被持有的，最后才 ids[0]', () => {
  const list = {
    ids: ['s1', 's2'],
    byId: { s1: { id: 's1', retainedBy: {} }, s2: { id: 's2', retainedBy: { mainView: 1 } } },
  }
  assert.equal(pickDirectorySessionId('current', list), 'current', '当前会话就是宿主此刻在渲染的那个，必须先选它')
  assert.equal(pickDirectorySessionId('', list), 's2', '没有当前会话时，先挑"已经有人持有"的那个（省一次 retain + open）')
  assert.equal(
    pickDirectorySessionId('', { ids: ['s3'], byId: { s3: { id: 's3', retainedBy: {} } } }),
    's3',
    '一个都没被持有时才退回 ids[0]（随后由持有登记表兜底）',
  )
  assert.equal(pickDirectorySessionId('', { ids: [], byId: {} }), '', '一个会话都没有 ⇒ 空串，让调用方按"还没有会话"处理，绝不猜')
  assert.equal(pickDirectorySessionId('', undefined), '', '列表快照缺失也不能抛')
})

test('hasAnyRetention：零值/缺字段一律当"没有持有"', () => {
  assert.equal(hasAnyRetention(undefined), false)
  assert.equal(hasAnyRetention({}), false)
  assert.equal(hasAnyRetention({ mainView: 0 }), false)
  assert.equal(hasAnyRetention({ mainView: 1 }), true)
  assert.equal(hasAnyRetention({ mainView: 1, sidebarView: 0 }), true)
})

// ============================================================ 持有（引用计数）

test('hold：同一 holder 重复 acquire 幂等，只 retain 一次', () => {
  const sessions = fakeSessions()
  const hold = createSessionHold()
  const holder = {}
  assert.equal(hold.acquire(sessions, 's1', holder), true)
  assert.equal(hold.acquire(sessions, 's1', holder), true)
  assert.equal(sessions.stats.retainCalls, 1, '同一个使用者重复登记不许把宿主的引用计数越加越高')
  assert.equal(hold.holderCount('s1'), 1)
  hold.release('s1', holder)
  assert.equal(hold.holding('s1'), false)
  assert.equal(sessions.stats.releaseCalls, 1, '最后一个使用者离开必须 release（否则会话 scope 永不回收）')
})

test('hold：两个使用者只 retain 一次，先走的那个不许把别人的目录带走', () => {
  const sessions = fakeSessions()
  const hold = createSessionHold()
  const a = {}
  const b = {}
  hold.acquire(sessions, 's1', a)
  hold.acquire(sessions, 's1', b)
  assert.equal(sessions.stats.retainCalls, 1)
  assert.equal(hold.holderCount('s1'), 2)
  hold.release('s1', a)
  assert.equal(sessions.stats.releaseCalls, 0, '还有一个使用者在读这份目录，不许释放')
  assert.equal(hold.holding('s1'), true)
  hold.release('s1', b)
  assert.equal(sessions.stats.releaseCalls, 1)
  assert.equal(hold.holding('s1'), false)
})

test('hold：宿主已有人持有（mainView）时不重复 retain', () => {
  const sessions = fakeSessions({ alreadyRetained: true, sessionId: 's1' })
  const hold = createSessionHold()
  assert.equal(hold.acquire(sessions, 's1', {}), false, 'scope 本来就在 ⇒ 不需要我们再持有')
  assert.equal(sessions.stats.retainCalls, 0, '别白跑一次宿主 open')
  assert.equal(hold.holding('s1'), false, '没持有就别假装持有（release 时也就不会误放别人的引用）')
})

test('hold：旧宿主没有 retain / retain 抛错 ⇒ 如实返回 false，不假装成功', () => {
  const holder = {}
  const noRetain = createSessionHold()
  assert.equal(noRetain.acquire({}, 's1', holder), false, '0.1.5 及更早没有 retain，只能退回原来的报错')
  const throwing = createSessionHold()
  assert.equal(throwing.acquire(fakeSessions({ retainThrows: true }), 's1', holder), false)
  assert.equal(throwing.holding('s1'), false)
  const missing = createSessionHold()
  assert.equal(missing.acquire(undefined, 's1', holder), false, '服务都拿不到时不许抛')
  assert.equal(missing.acquire(fakeSessions(), '', holder), false, '空会话 id 不持有（那是"还没有会话"）')
})

test('hold：open 失败（ready reject）后登记表要自己摘掉，不留下"以为持有"的假状态', async () => {
  const sessions = fakeSessions({ readyRejects: true })
  const hold = createSessionHold()
  hold.acquire(sessions, 's1', {})
  assert.equal(hold.holding('s1'), true, 'retain 同步返回时先记上（宿主 materializeScope 是同步的）')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(hold.holding('s1'), false, 'open 失败 ⇒ 引用作废，登记表要跟着清')
})

// ============================================================ 解析 + 单次重试

test('resolveModelDirectoryOutcome：不传钩子时行为与本补丁之前逐字一致', () => {
  const sessions = fakeSessions()
  const service = fakeModelDirectories(sessions)
  const outcome = resolveModelDirectoryOutcome(() => service, 's1')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'session')
  assert.match(outcome.detail, /resolved no scope/)
  assert.equal(sessions.stats.retainCalls, 0, '没有钩子就不许自己动宿主（本模块不认识 sessions）')
})

test('resolveModelDirectoryOutcome：no scope ⇒ 补一次持有，重试成功', () => {
  const sessions = fakeSessions()
  const service = fakeModelDirectories(sessions)
  const hold = createSessionHold()
  const outcome = resolveModelDirectoryOutcome(() => service, 's1', {
    ensureScope: (id) => hold.acquire(sessions, id, {}),
  })
  assert.equal(outcome.ok, true, '补上持有后目录必须能解析出来（事故的核心诉求）')
  assert.equal(outcome.ok && outcome.directory !== undefined, true)
  assert.equal(sessions.stats.retainCalls, 1)
  assert.equal(service.calls.length, 2, '第一次失败 + 重试一次 = 两次解析，不许循环重试')
})

test('resolveModelDirectoryOutcome：ensureScope 说"补不上" ⇒ 原样返回第一次的成因，不谎报', () => {
  const sessions = fakeSessions({ retainUnavailable: true })
  const service = fakeModelDirectories(sessions)
  let seen = ''
  const outcome = resolveModelDirectoryOutcome(() => service, 's1', {
    ensureScope: (id) => { seen = id; return false },
  })
  assert.equal(seen, 's1', '钩子要拿到会话 id')
  assert.equal(outcome.ok, false)
  assert.match(outcome.detail, /resolved no scope/)
  assert.equal(/retain/.test(outcome.detail), false, '没补上就不许在原因里提"已 retain"，那是假话')
})

test('resolveModelDirectoryOutcome：补过持有仍失败 ⇒ 原因里写明"已重试"，下一层不必再猜', () => {
  const service = {
    directoryFor() { throw new Error('ui-model-selection: session "s1" resolved no binding') },
  }
  const outcome = resolveModelDirectoryOutcome(() => service, 's1', { ensureScope: () => true })
  assert.equal(outcome.ok, false)
  assert.match(outcome.detail, /retain/)
  assert.match(outcome.detail, /仍取不到模型目录/)
})

test('resolveModelDirectoryOutcome：服务缺失 / fiber 已销毁**不**触发重试（retain 救不了，别掩盖成因）', () => {
  let retried = 0
  const ensureScope = () => { retried += 1; return true }
  const missing = resolveModelDirectoryOutcome(() => undefined, 's1', { ensureScope })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'service')
  assert.equal(retried, 0, '"没装 provider" 与 "scope 不在" 是两件事，前者重试也白搭')
  const inactive = resolveModelDirectoryOutcome(
    () => ({ directoryFor: () => { throw new Error('cannot get required service "x" in inactive context') } }),
    's1',
    { ensureScope },
  )
  assert.equal(inactive.ok, false)
  assert.equal(retried, 0, '"inactive context" 是 fiber 已销毁，重试只会掩盖成因')
})

test('降级原因仍能翻译成人话（用户看到的那句不许变成英文异常）', () => {
  const sessions = fakeSessions()
  const outcome = resolveModelDirectoryOutcome(() => fakeModelDirectories(sessions), 's1')
  const reason = modelDirectoryUnavailableReason(outcome)
  assert.match(reason, /取不到该会话的模型目录/)
  assert.match(reason, /retain/, '提示里要点名"宿主要求先 retain 起来"，这是能照做的线索')
  assert.equal(/未提供模型选择接口/.test(reason), false, '本机 provider 是装着的，说"没提供接口"就是误诊')
})

// ============================================================ 结构性约束（防回归）

/** 递归列出 `src/client/**` 下的源码文件（返回绝对路径）。 */
const CLIENT_DIR = fileURLToPath(new URL('../src/client/', import.meta.url))
const listClientSources = (dir = CLIENT_DIR) => {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listClientSources(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * 剥掉块注释再扫源码 —— 否则"文档里提一句 `sessions.retain()`"就会被当成第二处实现。
 * （本仓所有解释性注释都是块注释。）
 */
const stripBlockComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '')

test('全仓只有 sessionRef.ts 一处真的去 retain 会话（与 panelCss 的守护同口径）', () => {
  const RETAIN_CALL = /sessions\??\.retain\s*\(|retain\.call\(\s*sessions/
  const withRetain = listClientSources()
    .filter((file) => RETAIN_CALL.test(stripBlockComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(CLIENT_DIR, file).split(sep).join('/'))
    .sort()
  assert.deepEqual(withRetain, ['sessionRef.ts'], `持有语义只能有一处实现，实际：${withRetain.join('、')}`)
})

test('ModelPicker 走唯一入口：挑会话用 pickDirectorySessionId，持有用 hold.acquire/release', () => {
  const source = read('src/client/components/ModelPicker.tsx')
  assert.match(source, /pickDirectorySessionId\(/, '挑目录该问哪个会话只能走纯函数（它带单测）')
  assert.match(source, /createSessionHold\(/, '持有必须走 sessionRef.ts 的唯一实现')
  assert.match(source, /hold\.acquire\(/, '解析目录前必须先持有会话（0.2.x 的 scope 契约）')
  assert.match(source, /hold\.release\(/, '持有必须与释放配对，否则会话 scope 永不回收')
  assert.equal(
    /directorySessionId = currentSessionId !== ''/.test(source), false,
    '不许再自己写"当前会话 ?: ids[0]"—— 那个兜底正是本次事故的形态',
  )
})

// ============================================================ 调用方 inject 作用域

test('serviceScope：装上了就用带 inject 的作用域，没装就退回原 ctx', () => {
  resetServiceScope()
  assert.equal(serviceScopeCtx('fallback'), 'fallback', '没装时（老宿主）必须退回调用方 ctx，不许返回 undefined')

  const scoped = { tag: 'scoped' }
  let requested
  installServiceScope({
    inject(deps, callback) {
      requested = deps
      callback(scoped)
    },
  })
  assert.deepEqual(requested, ['remote.session'], '必须请求宿主 provider 真正需要的那个 inject')
  assert.equal(serviceScopeCtx('fallback'), scoped, '装上之后取服务要走作用域 ctx')

  resetServiceScope()
  assert.equal(serviceScopeCtx('fallback'), 'fallback', '卸载后必须清空，不能继续拿已销毁的 fiber')
})

test('serviceScope：旧宿主没有 inject / 回调一直不来 ⇒ 不抛、保持兜底', () => {
  resetServiceScope()
  assert.doesNotThrow(() => installServiceScope({}))
  assert.equal(serviceScopeCtx('fallback'), 'fallback')
  assert.doesNotThrow(() => installServiceScope({ inject() { throw new Error('boom') } }), 'inject 抛错不许冒到界面')
  assert.equal(serviceScopeCtx('fallback'), 'fallback')
  // 可选依赖永远不 ready（没装 dsh-client-ui-model-selection 的机器）：作用域一直是空的
  installServiceScope({ inject() { /* 永远不调用 callback */ } })
  assert.equal(serviceScopeCtx('fallback'), 'fallback', '依赖缺席时只能退回兜底，绝不能把面板拖死')
})

test('接线：apply 装作用域，ModelPicker 取服务时用它', () => {
  const index = read('src/client/index.tsx')
  assert.match(index, /installServiceScope\(ctx\)/, 'apply() 必须装这条作用域（否则首次创建目录会被宿主报 inject 错）')
  assert.match(index, /resetServiceScope\(\)/, '卸载时必须清空作用域')
  const picker = read('src/client/components/ModelPicker.tsx')
  assert.match(picker, /serviceScopeCtx\(getPluginCtx\(\)\)/, '取 modelDirectories 必须经由 serviceScopeCtx')
})

