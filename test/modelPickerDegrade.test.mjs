/**
 * 两处 P0 BUG 的**会失败的测试**（先红后绿）。
 *
 * 覆盖：
 *
 * 1. **快速录入模型选择死锁**（2026-09-28 用户实测）
 *    - 已存模型选择 + 解析不到模型目录时，快速录入**必须跑完**（不得抛错中断）；
 *    - 解析失败要**区分**"服务没提供"与"会话/目录还没就绪"，不许把成因说错；
 *    - 界面必须留着"改回跟随 DSH 默认模型"的出口（不许只在菜单里）。
 * 2. **rc.2 客户端系统通知不可用**
 *    - 三态：`unsupported` / `default`（可请求）/ `granted`；
 *    - 不支持时去请求授权必须**失败得可读且可观测**（不是静默 no-op）；
 *    - 发送失败必须**被报出来**（不再是空 `catch {}`）。
 *
 * 纯逻辑，不 import React、不碰 DOM → `node --test` 直接跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  CLEAR_SELECTION_LABEL, QUICK_MODEL_DEGRADE_PREFIX, clearQuickModelSelection,
  gateModelPicker, modelDirectoryUnavailableReason, modelMenuMode,
  resolveModelDirectoryOutcome, selectionToApply,
} from '../lib/client/modelCapability.js'
import {
  NOTIFICATION_UNSUPPORTED_REASON, classifyNotificationPermission, notificationStateText,
  readNotificationCtor, requestNotificationPermission, sendSystemNotification,
} from '../lib/client/notificationCapability.js'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/** 一个"像宿主那样"的模型目录替身。 */
const fakeDirectory = (current = null) => ({
  store: { getSnapshot: () => ({ current, groups: [], failures: [], status: 'ready', error: null }), subscribe: () => () => {} },
  load: async () => undefined,
  select: async () => ({ ok: true }),
})

// ============================================================ BUG 1：自动降级

test('BUG1-A：解析不到模型目录时**不抛错**，降级成"跟随 DSH 默认模型"', () => {
  // 服务在场、但这个会话取不到目录（宿主 `directoryFor` 返回空）——事故的第二步
  const outcome = resolveModelDirectoryOutcome(() => ({ directoryFor: () => undefined }), 'session-1')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'session', '给的是会话 id、服务也在 ⇒ 是"会话/目录还没就绪"，不是"服务没提供"')
  assert.ok(outcome.detail !== '')

  // 核心断言：这条路径必须给出"用默认模型"的口径，而不是把选择塞回去让它抛错。
  const applied = selectionToApply({ provider: 'deepseek', model: 'deepseek-flash' }, outcome)
  assert.equal(applied.kind, 'follow-default', '解析不到目录 ⇒ 本次必须跟随默认模型，而不是中断整条快速录入')
  assert.match(applied.notice, /默认模型/, '提示必须明确"本次用的是默认模型"（不许静默）')
  assert.match(applied.notice, new RegExp(QUICK_MODEL_DEGRADE_PREFIX))
  // 有残留选择 ⇒ 提示里要告诉他出口在哪（否则用户被叫去点一个说不清的按钮）
  const withExit = selectionToApply({ provider: 'deepseek', model: 'deepseek-flash' }, outcome, { clearExitReachable: true })
  assert.match(withExit.notice, new RegExp(CLEAR_SELECTION_LABEL), '要给出口，并把控件上的文案说出来')
  assert.match(withExit.notice, /清掉这条残留选择/)
  // 没有残留选择 ⇒ 不许提一个不存在的东西
  const noExit = selectionToApply({ provider: 'deepseek', model: 'deepseek-flash' }, outcome, { clearExitReachable: false })
  assert.equal(/清掉这条残留选择/.test(noExit.notice), false, '出口不可达时不许让用户去找它')

  /**
   * 提示里的成因必须是**真的那一个**：这条路是"服务在场、会话取不到目录"，
   * 绝不许出现"接口没提供 / 未提供模型选择接口"（2026-09-28 审查 F1：
   * 本机 provider 明明装着，这句话会把排查方向整个带偏）。
   */
  assert.equal(
    /未提供模型选择接口|没有提供 modelDirectories/.test(applied.notice), false,
    `成因必须准确，不能把"会话没就绪"说成"接口没提供"：${applied.notice}`,
  )
  assert.match(applied.notice, /取不到该会话的模型目录/, '要把真实成因说出来')
})

test('BUG1-A4（审查 F1）：门禁的成因**只能来自** modelDirectoryUnavailableReason，不许自己拼', () => {
  const inSession = resolveModelDirectoryOutcome(
    () => ({ directoryFor: () => { throw new Error('ui-model-selection: session "s1" resolved no binding') } }),
    's1',
  )
  const reason = modelDirectoryUnavailableReason(inSession)
  const gate = gateModelPicker({
    hasDirectory: false, sessionId: 's1', unavailableReason: reason, recoverable: true,
  })
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, reason, '门禁必须原样用传进来的成因（唯一实现），不许自己再拼一句')
  assert.match(gate.reason, /取不到该会话的模型目录/)
  assert.equal(
    /当前 DSH 未提供模型选择接口/.test(gate.reason), false,
    '服务在场时说"未提供接口"就是误诊 —— 这正是审查 F1 报的那条',
  )

  // 反向：**真的**服务不在场时，那句话才是对的（别把准确的成因一起改掉）
  const absent = resolveModelDirectoryOutcome(() => undefined, 's1')
  assert.match(modelDirectoryUnavailableReason(absent), /未提供模型选择接口（modelDirectories）/)
})

test('BUG1-A2：服务真的不在场时也降级（成因措辞与"会话没就绪"必须不同）', () => {
  const absent = resolveModelDirectoryOutcome(() => undefined, '')
  assert.equal(absent.ok, false)
  assert.equal(absent.code, 'service')
  // 同样是"服务不在场"，但这一次会话已经就绪 —— 两者的**说明**必须不同：
  // 事故里把"会话没就绪"说成"服务没提供"，排查方向整个被带偏。
  const notReady = resolveModelDirectoryOutcome(() => undefined, 'session-1')
  assert.equal(notReady.code, 'service')
  const inSession = resolveModelDirectoryOutcome(() => ({ directoryFor: () => undefined }), 'session-1')
  assert.equal(inSession.code, 'session')
  assert.notEqual(absent.detail, inSession.detail, '两种成因不能共用一句话 —— 那正是本次把方向带偏的原因')

  // 目录正常时照旧应用用户选的模型（不许把"不抛错"改成"永远不换模型"）
  const ok = resolveModelDirectoryOutcome(() => ({ directoryFor: () => fakeDirectory() }), 'session-1')
  assert.equal(ok.ok, true)
  assert.equal(selectionToApply({ provider: 'deepseek', model: 'deepseek-flash' }, ok).kind, 'apply')
})

test('BUG1-A3：宿主 directoryFor 抛错时必须被分类，不许吞成"接口没提供"', () => {
  // ⚠️ 抛错必须发生在 `directoryFor` **调用**里（宿主的真实行为），
  // 而不是在"读服务"那一步 —— 两种抛错的成因不同，归的类也必须不同。
  const outcome = resolveModelDirectoryOutcome(
    () => ({ directoryFor: () => { throw new Error('ui-model-selection: session "s1" resolved no binding') } }),
    's1',
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'session', '服务在场、是这个会话取不到目录 ⇒ 归"会话/目录"类')
  assert.match(outcome.detail, /no binding/, '真实原因要带上，不能只剩一句"未提供接口"')

  // 反向：读服务本身抛错（cordis 的 inactive context）归"服务"类
  const inactive = resolveModelDirectoryOutcome(() => { throw new Error('cannot get required service "modelDirectories" in inactive context') }, 's1')
  assert.equal(inactive.ok, false)
  assert.equal(inactive.code, 'service')
  assert.match(inactive.detail, /inactive context/)
})

// ============================================================ BUG 1：保留出口

test('BUG1-B：有残留选择时，即使拿不到目录也**必须**能清掉它（界面出口）', () => {
  const stuck = { provider: 'deepseek', model: 'deepseek-flash', label: 'deepseek-flash' }

  const cleared = clearQuickModelSelection(stuck)
  assert.equal(cleared, null, '清空就是 null ⇒ 上层 writeQuickModelSelection(null) 会 removeItem')
  assert.equal(CLEAR_SELECTION_LABEL, '跟随 DSH 默认模型')

  // 清空后再算一次：这条路径不依赖任何模型目录，所以服务缺失时也走得通
  assert.equal(selectionToApply(null, resolveModelDirectoryOutcome(() => undefined, 's1')).kind, 'follow-default')
})

test('BUG1-B2：**没有**残留选择时，服务缺失仍按"不可用"拒绝打开菜单（保住既有设计意图）', () => {
  const gateOf = (hasDirectory, unavailableReason, recoverable) => gateModelPicker({
    hasDirectory, sessionId: 's1', unavailableReason, recoverable,
  })

  // "还没有可用的会话"优先于成因（会话都没有，谈不上目录）
  assert.match(
    gateModelPicker({ hasDirectory: false, sessionId: '', unavailableReason: '随便一句', recoverable: false }).reason,
    /还没有可用的会话/,
  )

  const reachable = gateOf(false, '模型选择接口在场，但这次取不到该会话的模型目录：no binding', true)
  assert.equal(reachable.ok, false, '仍然是"不可用"（菜单只给清空出口）')
  assert.match(reachable.reason, /no binding/, '出口可达时只说成因，不画蛇添足')

  const stuck = gateOf(false, '模型选择接口在场，但这次取不到该会话的模型目录：no binding', false)
  assert.equal(stuck.ok, false)
  assert.match(stuck.reason, /没有已保存的模型选择/, '出口不可达时必须说清"点了也没用"，别让用户白点')

  assert.equal(gateOf(true, '', false).ok, true)
  assert.ok(gateOf(false, '', false).reason.length > 0, '成因缺失时也不许出现空提示')
})

test('BUG1-B3：拿不到目录 + 有残留选择 ⇒ 菜单必须退化并**说明原因**（而不是摆一份假目录）', () => {
  const reason = '模型选择接口在场，但这次取不到该会话的模型目录：no binding'
  const clearOnly = modelMenuMode({ directory: undefined, hasSelection: true, unavailableReason: reason })
  assert.equal(clearOnly.mode, 'clear-only', '有残留选择时必须只给清空出口（否则用户被锁死）')
  assert.match(clearOnly.reason, /no binding/, '原因必须带到菜单里（用户点进来第一眼就能看到为什么）')
  assert.match(clearOnly.reason, new RegExp(CLEAR_SELECTION_LABEL))

  const noSelection = modelMenuMode({ directory: undefined, hasSelection: false, unavailableReason: reason })
  assert.equal(noSelection.mode, 'full', '没有残留选择时不必退化（那种情况由门禁直接拦下）')

  const normal = modelMenuMode({ directory: fakeDirectory(), hasSelection: true, unavailableReason: '' })
  assert.equal(normal.mode, 'full', '目录正常时必须照旧列整份目录')
  assert.equal(normal.reason, '')
})

test('BUG1-B4（审查 F2）：清空出口的判据只有一处 —— 门禁从菜单判定读，不自己看 hasSelection', () => {
  const source = read('src/client/components/ModelPicker.tsx')
  const code = stripComments(source)
  /** 门禁那一次调用的实参块（到该调用闭合的 `})` 为止）。 */
  const gateCall = /gateModelPicker\(\{([\s\S]*?)\n    \}\)/.exec(code)
  assert.ok(gateCall !== null, '没找到 gateModelPicker 调用（改名了就要同步这条断言）')
  assert.equal(
    /**
     * ⚠️ 只看**顶层**实参（行首 6 空格 = `gateModelPicker({` 的成员）。
     * `recoverable` 那个实参内部**必然**会写 `hasSelection`（它把事实交给唯一判定），
     * 用宽泛的 `hasSelection:` 去扫会把正常写法判成违规。
     */
    /\n {6}hasSelection:/.test(gateCall[1]), false,
    '门禁的实参里不许直接出现 hasSelection（那会让"有没有清空出口"有两处实现）—— 只接收算好的 recoverable',
  )
  assert.match(
    gateCall[1],
    /recoverable: modelMenuMode\(\{[\s\S]{0,300}?\}\)\.mode === 'clear-only'/,
    '出口可达性必须由 modelMenuMode 的唯一判定给出',
  )
  // 只写不读的 state 是"看起来接上了、其实没接"的典型形态
  assert.equal(
    /degradeReason/.test(code), false,
    '降级原因只有一个读者：渲染期算出的 menuDecision.reason；不许再存一份只写不读的 state',
  )
})

// ============================================================ BUG 2：三态与可观测

test('BUG2-A：三态分类 —— unsupported / default（可请求）/ granted', () => {
  /**
   * ⚠️ 替身必须是"函数 + 静态 permission"：真机上的 `Notification` 就是这样，
   * 而拿不到构造函数（`undefined`）才是"不支持"。用 `{ permission }` 这种普通对象
   * 当替身会把"不支持"与"权限是 default"混起来，测出来的结论是假的。
   */
  const withPermission = (permission) => {
    const ctor = class { } // eslint-disable-line no-empty-function
    Object.defineProperty(ctor, 'permission', { value: permission })
    return ctor
  }
  assert.equal(classifyNotificationPermission(readNotificationCtor({})), 'unsupported')
  assert.equal(classifyNotificationPermission(readNotificationCtor({ Notification: withPermission('default') })), 'default')
  assert.equal(classifyNotificationPermission(readNotificationCtor({ Notification: withPermission('granted') })), 'granted')
  assert.equal(classifyNotificationPermission(readNotificationCtor({ Notification: withPermission('denied') })), 'denied')
  assert.equal(
    classifyNotificationPermission(readNotificationCtor({ Notification: withPermission('granted') })),
    'granted', '读得到的构造函数直接判，不必再回落到 globalThis',
  )
  assert.equal(
    classifyNotificationPermission(undefined),
    'unsupported', '拿不到构造函数就是"不支持"，绝不留一个永远转圈的授权按钮',
  )
})

test('BUG2-A2：设置面板文案覆盖三态，且"已开启"必须说清前提', () => {
  const unsupported = notificationStateText('unsupported')
  const requestable = notificationStateText('default')
  const granted = notificationStateText('granted')
  assert.match(unsupported, /不支持/)
  assert.match(requestable, /授权/)
  assert.match(granted, /已授权/)
  assert.notEqual(unsupported, requestable)
  assert.notEqual(requestable, granted)
  // 用户实测的坑正是"显示已开启但毫无反应"，所以已授权文案不能只写一句"已授权"。
  assert.match(granted, /系统|专注|通知/, '已授权时也要交代"系统级通知可能被 OS 丢弃"这件事')
})

test('BUG2-B：不支持的客户端上请求授权必须**拒绝并说清原因**（不是静默 no-op）', async () => {
  const global = {}
  const verdict = await requestNotificationPermission(readNotificationCtor(global))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, NOTIFICATION_UNSUPPORTED_REASON)
  assert.match(verdict.reason, /不支持/, '用户要能看懂为什么没反应')
  assert.equal(verdict.permission, 'unsupported')
})

test('BUG2-C：发送失败必须可观测 —— 返回原因，绝不空 catch 吞掉', () => {
  // ⚠️ 替身要带上 `permission = 'granted'`：否则根本走不到构造那一步，
  // 这条断言就成了"没测到构造函数抛错"的假绿（真机上的失败正是构造期抛的）。
  const boom = class { static permission = 'granted'; constructor() { throw new Error('Illegal constructor') } }
  const failed = sendSystemNotification({
    NotificationCtor: boom, title: 't', body: 'b', log: () => {},
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'Illegal constructor')
  assert.match(failed.reason, /Illegal/, '要把宿主抛出来的原话带出来，否则无从排查')

  const ok = sendSystemNotification({
    NotificationCtor: class { static permission = 'granted'; constructor(title, options) { this.title = title; this.body = options?.body } },
    title: 't', body: 'b', log: () => {},
  })
  assert.equal(ok.ok, true)
})

test('BUG2-C2：未授权/不支持时也要给可读原因，且控制台留痕', () => {
  const logs = []
  const denied = sendSystemNotification({
    NotificationCtor: class { static permission = 'denied' }, permission: 'denied', title: 't', log: (m) => logs.push(m),
  })
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /授权/)
  assert.equal(logs.length, 1, '失败必须在控制台留一条（用户截图看不到 console，排查时靠它）')

  const unsupported = sendSystemNotification({ NotificationCtor: undefined, title: 't', log: (m) => logs.push(m) })
  assert.equal(unsupported.ok, false)
  assert.match(unsupported.reason, /不支持/)
  assert.equal(logs.length, 2)
})

// ============================================================ 接线（源码级不变量）

/**
 * 去掉注释再扫源码。
 *
 * 为什么必须这么做：这些断言禁止的是**代码**里的写法，而本仓的注释恰恰要
 * 把"旧写法长什么样"写下来（`new Notification(…)`、空的 `try/catch`）——
 * 不剥注释就会把文档判成违规，于是断言只能被删掉，而不是被满足。
 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1 ')

test('接线：提交路径的降级不许 throw，且选择器保留出口', () => {
  /**
   * 2026-10-01 抽组件后的分工：
   * - **提交路径**（应用模型 / 降级）原在 `index.tsx`，D17/P6-3 随 `startAISession`
   *   搬进 `hooks/useWorkbenchAISessions.ts`；
   * - **门禁与成因**（`gateModelPicker` / `modelDirectoryUnavailableReason`）随组件搬进
   *   `components/ModelPicker.tsx`。
   * 所以这条断言要读**两个**文件，各查各的那一半 —— 不是放宽，是不再把两个文件的
   * 实现混在一起扫（否则任何一次搬家都会假红，而假红正是我们最贵的成本）。
   * 负向那三条则对**两个文件都扫**（提交路径搬到哪都躲不掉）。
   */
  const entrySource = read('src/client/index.tsx')
  const submitSource = read('src/client/hooks/useWorkbenchAISessions.ts')
  const gateSource = read('src/client/components/ModelPicker.tsx')
  const submitCode = stripComments(submitSource)
  const entryCode = stripComments(entrySource)
  const gateCode = stripComments(gateSource)
  for (const [name, code] of [['入口', entrySource], ['AI 会话域', submitSource]]) {
    assert.equal(
      code.includes('无法为快速录入切换模型'), false,
      `${name}里不许有那条"抛错中断整条流程"的写法（验收标准 1）`,
    )
  }
  assert.ok(
    submitCode.includes('selectionToApply('),
    '提交路径必须走纯判据 selectionToApply（否则"不抛错"就只是换了个地方写死）',
  )
  /**
   * 门禁的成因必须**从算好的那一份读**，不许在调用点写字面量：
   * 变异成 `unavailableReason: ''` 时纯函数单测照旧全绿（判定层是对的），
   * 用户看到的却是一句空泛的"当前拿不到模型列表" —— 只有源码扫描拦得住。
   */
  assert.match(
    gateCode,
    /gateModelPicker\(\{\s*hasDirectory: outcome\.ok,\s*sessionId: directorySessionId,\s*unavailableReason: reason,/,
    '门禁的成因必须来自 modelDirectoryUnavailableReason（唯一实现），不许在调用点另写一句',
  )
  assert.match(
    gateCode,
    /const reason = outcome\.ok \? '' : modelDirectoryUnavailableReason\(outcome\)/,
    '成因的唯一来源就是这个纯函数',
  )
  /**
   * ⚠️ 出口是否可达也必须**现算现传**，不能写死 `false`。
   *
   * 纯函数单测（`BUG1-A`）是自己传参的，无论接线怎么改都全绿 —— 那正是
   * "判定对但没接上"的典型：写死 `false` 之后，用户明明有残留选择、出口也点得到，
   * 提示里却永远不提出口在哪儿。这条只有扫源码拦得住
   * （实测：把 `clearExitReachable` 写死成 `false` 时纯函数单测 14/14 全绿）。
   */
  assert.match(
    submitCode,
    /clearExitReachable: modelSelection !== null,/,
    '有残留选择时提示必须告诉用户出口在哪',
  )
  assert.equal(
    /new Notification\(/.test(submitCode), false,
    '系统通知的发送必须唯一走 sendSystemNotification（可观测）；不许在组件里裸 new Notification',
  )
  assert.equal(
    /Notification\.requestPermission\(/.test(submitCode), false,
    '请求授权必须唯一走 requestNotificationPermission（不支持的客户端会抛 TypeError）',
  )
  // 入口侧同样不许出现（提交路径搬家不该在半路留一份）
  assert.equal(/new Notification\(/.test(entryCode), false, '入口也不许裸 new Notification')
  assert.equal(/Notification\.requestPermission\(/.test(entryCode), false, '入口也不许裸请求授权')
})