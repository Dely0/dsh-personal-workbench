/**
 * 会话引用：**把一个新建的 AI 会话从"只是有个 id"变成"能真的发消息"**。
 *
 * ## 这个模块为什么存在（2026-09-26，DSH 0.1.7-rc.2 桌面端真实事故）
 *
 * 旧实现在 `connectWorkspace()` 之后直接 `sessions.binding(id)`，
 * rc2 上**恒为 undefined** → 用户点「快速录入 / 创建澄清会话」看到
 * 「会话绑定未就绪，请稍后重试」，整条澄清链路不可用。
 *
 * 原因是 rc2 把"谁能拿到会话绑定"改了语义（drift，同一大版本内改名/改语义，
 * 与 `connection.hostDescription` → `connection.generation` 是同一类事故）：
 *
 * | 宿主版本 | `binding(id)` 的判据 |
 * |---|---|
 * | ≤ 0.1.5 | "在会话列表里 **或** 是当前会话" → 刚 `create()` 出来的会话能拿到 |
 * | 0.1.7-rc.2 | **只查已被 retain 的 scope**：没有人 `retain()` 就永远拿不到 |
 *
 * 官方文档的措辞就是新契约：「Callers **retain** the returned identity before
 * borrowing its binding.」而面板关闭时宿主自己 `release()` —— 所以插件必须自己
 * retain / release，不能指望宿主替我们持有。
 *
 * ## 为什么不把两条腿都写成"探测"
 *
 * 两条腿的分工是**同一个语义的两种宿主实现**（"我要用这个会话说几句话"），
 * 不是两套业务判定：新宿主走 `retain`，旧宿主走 `binding`，选哪条**只由宿主
 * 有没有 `retain` 决定**，且只在这一处决定。业务代码只认 `SessionReference`。
 *
 * ## 本模块的硬约束
 *
 * 不 import React、不碰 DOM、不读 document —— 因此能被 `node --test` 直接测
 * （见 `test/sessionRef.test.mjs`）。
 */
import type { SessionDriver, WorkbenchRuntime } from './viewTypes.js'

/** 插件内部统一的"会话引用"：业务只认这个，不关心底层是 retain 还是 binding。 */
export interface SessionReference {
  /** 释放钩子；不抛错，可重复调用（由 `acquireSession` 包装）。 */
  release(): void
  /** 这个引用对应的会话驱动。 */
  session: SessionDriver
}

/** 建立引用时要写给宿主看的能力来源标签（宿主按它做引用计数与释放）。 */
const RETAIN_SOURCE = 'personal-workbench'

/** 拿不到绑定时给用户看的原因：要能指导用户，而不是只丢一句"稍后重试"。 */
export const SESSION_BINDING_ERROR = '会话绑定未就绪，请稍后重试'

/** 两条腿都没有时给用户看的原因（`sessions.open` 在 0.1.7-rc.2 已被移除）。 */
export const SESSION_OPEN_UNAVAILABLE = '当前 DSH 没有可用的会话切换接口（需要 uiWorkspace.openSession 或 sessions.open），请升级 DSH 或先在会话列表里手动打开'

/** 读宿主服务：属性直取（inject 声明的服务）与 `ctx.get`（可选服务）两种取法都试。 */
function readService(ctx: unknown, name: string): unknown {
  const target = ctx as Record<string, unknown> | undefined
  if (target !== undefined && target !== null) {
    try {
      const direct = target[name]
      if (direct !== undefined && direct !== null) return direct
    } catch { /* 未 inject 的服务读属性会抛，退到 ctx.get */ }
  }
  try {
    const getter = (target as { get?: (key: string) => unknown } | undefined)?.get
    if (typeof getter === 'function') return getter.call(target, name)
  } catch { /* 取不到就当没有 */ }
  return undefined
}

/**
 * 把主视图切到某个会话 —— **全插件唯一的实现**。
 *
 * ## 为什么单独抽出来（2026-09-26，rc2 第二处宿主契约漂移）
 *
 * 用户现象：澄清会话已经能建、AI 也回了，但界面仍报错
 * **`kr(...)?.open is not a function`**。`kr` 是打包后的 `safeService(...)`：
 * `sessions` 服务在、`open` 方法**没了**。
 *
 * | 宿主 | 切主视图的入口 |
 * |---|---|
 * | ≤ 0.1.5 | `sessions.open(id)`（内部 `manager.select`） |
 * | 0.1.7-rc.2 | **`sessions.open` 已移除**；官方口径是 `uiWorkspace.openSession(target)`（内部 `retain(id,{source:'mainView'})` + 选中，并释放上一个 mainView 引用） |
 *
 * `uiWorkspace.openSession` **两版都有**（0.1.5 里它就是 `sessions.open` 的包装），
 * 所以判据顺序是"先官方、再回落"，与同环境里能正常工作的 `dsh-better-sidebar` 一致
 * （它也是 `ctx.get('uiWorkspace')?.openSession(target)`，再 `sessions.open?.(target)`）。
 *
 * ⚠️ **不要自己用 `sessions.retain(id,{source:'mainView'})` 模拟**：宿主布局是按
 * "谁被 mainView retain 着"找当前会话的，手动 retain 会与宿主自己那条引用**同时存在**
 * （两个 `retainedBy.mainView > 0`，宿主 `find()` 取谁就变得不确定）。
 *
 * @param ctx - 插件上下文（本文件里刻意只把它当"能取服务的对象"，不做别的假设）
 * @param sessionId - 要切过去的会话 id
 * @returns 实际走的腿（便于日志与排查）
 * @throws 会话 id 为空、或两条腿都没有时 —— 绝不静默什么都不做
 */
export function openSessionInMainView(ctx: unknown, sessionId: string): 'uiWorkspace' | 'sessions' {
  if (sessionId === '') throw new Error('会话 id 为空，无法切换')
  const uiWorkspace = readService(ctx, 'uiWorkspace') as { openSession?: (target: string) => void } | undefined
  if (typeof uiWorkspace?.openSession === 'function') {
    uiWorkspace.openSession(sessionId)
    return 'uiWorkspace'
  }
  const sessions = readService(ctx, 'sessions') as { open?: (id: string) => void } | undefined
  if (typeof sessions?.open === 'function') {
    sessions.open(sessionId)
    return 'sessions'
  }
  throw new Error(SESSION_OPEN_UNAVAILABLE)
}

/**
 * 取一个**可用**的会话引用。
 *
 * 1. 宿主有 `retain`（0.1.7-rc.2+）：`retain(id, {source})` → 等 `ready` →
 *    把 binding 里的会话取出来（**提前取**：引用被 release 之后 `binding` 这个
 *    getter 会抛）。调用方**必须**在 `finally` 里 `release()`。
 * 2. 旧宿主没有 `retain`：退到 `binding(id)`，释放是 no-op（旧宿主自己管生命周期）。
 *
 * 失败一律抛错，绝不返回"半可用"的引用 —— 静默降级会让用户以为会话发出去了。
 */
export async function acquireSession(
  sessions: WorkbenchRuntime['sessions'] | undefined,
  sessionId: string,
): Promise<SessionReference> {
  const retain = sessions?.retain
  if (typeof retain === 'function') {
    const reference = retain.call(sessions, sessionId, { source: RETAIN_SOURCE })
    /**
     * 引用已经拿到手了：从这里开始**任何失败都必须 release**，
     * 否则这个会话的 scope 会一直被我们持有（宿主按引用计数回收）。
     */
    try {
      if (reference !== null && reference !== undefined && typeof reference.ready?.then === 'function') {
        await reference.ready
      }
      const session = reference?.binding?.session
      if (session === undefined || session === null) throw new Error(SESSION_BINDING_ERROR)
      return { session, release: once(() => safeRelease(reference)) }
    } catch (error) {
      safeRelease(reference)
      throw error
    }
  }
  const binding = sessions?.binding?.(sessionId)
  if (binding === undefined || binding === null) throw new Error(SESSION_BINDING_ERROR)
  return { session: binding.session, release: () => undefined }
}

/** release 只做一次：重复 release 会让宿主的引用计数减多（会话被别人持有时被提前回收）。 */
function once(fn: () => void): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}

/** 释放期间宿主可能已经换代/卸载：释放失败不该盖住真正的业务错误。 */
function safeRelease(reference: { release?: () => void } | null | undefined): void {
  try {
    if (typeof reference?.release === 'function') reference.release()
  } catch {
    /* 释放阶段的异常一律吞掉：它不代表业务失败 */
  }
}
