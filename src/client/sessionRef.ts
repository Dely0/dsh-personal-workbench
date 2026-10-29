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

// ---------------------------------------------------------------- 会话持有（retain 登记表）

/**
 * 会话**持有**登记表 —— 与上面的 `acquireSession()` 同属"借会话"的唯一实现。
 *
 * ## 为什么住在同一个文件（2026-10-26，桌面端 DSH 0.2.1-rc.3）
 *
 * 宿主把判据改成"只查**已被 retain 的** scope"之后，凡是要"先拿到会话、再问宿主关于它的事"
 * 的路径都得先 `retain()` 一次：
 *
 * | 用途 | 出口 | 生命周期 |
 * |---|---|---|
 * | 发消息（要 binding 里的 session） | `acquireSession()` | 一次调用，`finally` 释放 |
 * | 让宿主"认识"这个会话（例如读会话模型目录） | `createSessionHold().acquire()` | 界面挂载期间，按使用者计数 |
 *
 * 两者必须**只有一处**：仓里的 `test/panelCss.test.mjs` 用源码扫描钉住"借会话不许出现在
 * 业务代码里"，因为"同一个语义被独立计算多次"是本项目最大的 bug 类别。所以这份登记表
 * 放在本文件，而不是塞进调用它的组件或某个专题模块。
 *
 * ## 为什么持有**不取 binding**
 *
 * 宿主的 `directoryFor(sessionId)` 只要 scope 存在就能解析（`retainScope()` 里
 * `this.scopes.get(id) ?? this.materializeScope(id)` 会同步物化 scope 和 binding），
 * 而 `binding` 这个 getter 在引用被 release 之后**会抛** —— 不取它，就没这条坑。
 * 需要 binding 的路径仍然走 `acquireSession()`（那里已经处理了 release 之后再读的问题）。
 *
 * ## 反面案例（真实事故）
 *
 * 工作台的模型选择器原先自己挑会话、自己 `directoryFor()`，从不 retain：主视图没有会话时
 * 兜底到 `sessions.list.ids[0]`，那个会话没人持有 ⇒ 每次点开都是
 * `ui-model-selection: session "…" resolved no scope`，一个模型都列不出来。
 */

/** 宿主 `sessions.retain()` 返回的引用（只声明持有登记需要的两个成员）。 */
export interface SessionHoldReference {
  /** 宿主 open 完成（或失败）时结算；失败会让引用作废，登记表据此回收。 */
  readonly ready?: Promise<unknown>
  release?(): void
}

/**
 * 宿主的会话持有面（`sessions` 服务的一个子集）。
 *
 * 两个成员**都是可选的**：`retain` 从 0.1.7-rc.2 才有，`retainInfo` 更晚；缺任何一个
 * 都只意味着"这条能力用不上"，不意味着调用方要崩。
 */
export interface SessionHoldSessions {
  retain?(id: string, options: { source: string }): SessionHoldReference | undefined
  retainInfo?(id: string): { getSnapshot(): { readonly retainedBy?: Record<string, number> } } | undefined
}

/** 持有登记表的对外形状（每个使用者持一颗不透明的 `holder` 对象做身份）。 */
export interface SessionHold {
  /**
   * 登记一个使用者（同一 `holder` 重复登记是幂等的）。
   *
   * @returns `true` = 此刻本插件**确实持有**该会话（新 retain 成功，或此前已持有）；
   *          `false` = 没持有（会话 id 为空 / 宿主没有 `retain` / **别人已经持有** /
   *          retain 抛错）—— 调用方不得据此认为后续一定能成功，但可以据此决定是否重试。
   */
  acquire(sessions: SessionHoldSessions | undefined, sessionId: string, holder: object): boolean
  /** 注销一个使用者；计数归零才真正 `release()`（重复注销无副作用）。 */
  release(sessionId: string, holder: object): void
  /** 此刻是否持有该会话。 */
  holding(sessionId: string): boolean
  /** 该会话的使用者数量（诊断与测试用）。 */
  holderCount(sessionId: string): number
}

/** 是否**有任何来源**正持有该会话（`undefined` / 空表 ⇒ false = 不知道）。 */
export function hasAnyRetention(retainedBy: Record<string, number> | undefined): boolean {
  if (retainedBy === undefined || retainedBy === null) return false
  for (const count of Object.values(retainedBy)) {
    if (typeof count === 'number' && count > 0) return true
  }
  return false
}

/** 读宿主当前对该会话的持有快照（拿不到 ⇒ `undefined` = 不知道）。 */
function readRetainedBy(sessions: SessionHoldSessions, sessionId: string): Record<string, number> | undefined {
  try {
    return sessions.retainInfo?.(sessionId)?.getSnapshot?.()?.retainedBy
  } catch {
    return undefined
  }
}

/** 一份 `retain()` 引用 + 正在使用它的使用者集合。 */
interface HeldSession {
  readonly reference: SessionHoldReference
  readonly holders: Set<object>
}

/**
 * 建一份持有登记表（**每个使用者界面一份，绝不共享** —— 共享会让释放时机变成猜）。
 *
 * @param source - 写给宿主看的来源标签（默认与本插件发消息时同一个来源，便于排查）。
 */
export function createSessionHold(source: string = RETAIN_SOURCE): SessionHold {
  const held = new Map<string, HeldSession>()

  /** 释放并删档；**只做一次**（重复 release 会让宿主的引用计数减多）。 */
  const drop = (sessionId: string): void => {
    const entry = held.get(sessionId)
    if (entry === undefined) return
    held.delete(sessionId)
    entry.holders.clear()
    safeRelease(entry.reference)
  }

  return {
    acquire(sessions, sessionId, holder) {
      if (sessionId === '') return false
      const existing = held.get(sessionId)
      if (existing !== undefined) {
        existing.holders.add(holder)
        return true
      }
      if (sessions === undefined || sessions === null || typeof sessions.retain !== 'function') return false
      // 别人已经持有（多半是 mainView）⇒ scope 本来就在，再 retain 只是白跑一次宿主 open
      if (hasAnyRetention(readRetainedBy(sessions, sessionId))) return false
      let reference: SessionHoldReference | undefined
      try {
        reference = sessions.retain(sessionId, { source })
      } catch (error) {
        // 不静默：失败必须可观测（规范第 4 条），但也不把异常抛给用户界面
        console.warn(
          `[workbench] retain 会话 ${sessionId} 失败，本次拿不到会话级能力（例如模型目录）：`
          + (error instanceof Error ? error.message : String(error)),
        )
        return false
      }
      if (reference === undefined || reference === null) return false
      const entry: HeldSession = { reference, holders: new Set<object>([holder]) }
      held.set(sessionId, entry)
      /**
       * 宿主 open 失败时引用作废：只把它从登记表里摘掉，**不**在这里 release ——
       * 宿主已经在拒绝路径上自行释放过，重复释放会让别人的计数被减多。
       * `then(undefined, …)` 同时吃掉 rejection，避免未处理拒绝刷控制台。
       */
      void reference.ready?.then(undefined, () => {
        if (held.get(sessionId) === entry) held.delete(sessionId)
      })
      return true
    },
    release(sessionId, holder) {
      const entry = held.get(sessionId)
      if (entry === undefined) return
      entry.holders.delete(holder)
      if (entry.holders.size > 0) return
      drop(sessionId)
    },
    holding(sessionId) {
      return held.has(sessionId)
    },
    holderCount(sessionId) {
      return held.get(sessionId)?.holders.size ?? 0
    },
  }
}
