/**
 * 「带宿主 inject 的服务调用作用域」—— 2026-10-27 桌面端 DSH 0.2.1-rc.3 的**第二个宿主缺陷**。
 *
 * ## 症状
 *
 * 修掉 `ui-model-selection: session "…" resolved no scope`（见 `modelDirectorySession.ts`）之后，
 * 紧接着冒出 `cannot get property "remote.session" without inject` —— 而且只发生在
 * **"首次为某个会话创建模型目录"**时：同一入口点第二次就正常，宿主自己的模型按钮也一切正常。
 *
 * ## 机制（从 app.asar 里的 cordis 实现读出来的）
 *
 * cordis 的 traceable 服务在**方法被调用**时，会把服务实例上的 `ctx` 属性影射成
 * **调用方的 ctx**（`getTraceable` → `createShadow`，tracker 的 `property` 就是 `'ctx'`）。
 * 宿主的 `dsh-client-ui-model-selection` 里正好有这一行：
 *
 * ```js
 * directoryFor(sessionId) {
 *   …
 *   const directory = new ModelDirectory(this.ctx.remote.session, …)  // this.ctx = 调用方 ctx
 * ```
 *
 * 所以**调用方 ctx 必须声明过 `remote.session`**，服务里那句 `this.ctx.remote.session` 才成立。
 * 宿主自己的模型按钮跑在一个 `inject: [… 'remote.session' …]` 的插件里，永远成立；
 * 本插件既没声明、也**不能**直接写进 inject —— 那会让没装该 provider 的机器上
 * **整块工作台面板 pending**（`viewTypes.ts` 里那段"成本不对称"的决策）。
 *
 * ## 修法
 *
 * `apply()` 时用 `ctx.inject(['remote.session'], cb)` 拿一个**声明了该 inject 的子 ctx**
 * —— cordis 的"可选依赖"用法：依赖不在就一直 pending，**不会**把面板拖死。
 * 之后取 `modelDirectories` 一律经由它；拿不到就退回原 ctx，行为与本补丁之前一致。
 *
 * ⚠️ 这是对宿主缺陷的**规避**，不是长期方案：已连同证据写进 issue，等待宿主修。
 *
 * 纯模块、不 import React、不碰 DOM → 可被 `node --test` 直接测。
 */

/** 需要声明在调用方 ctx 上的 inject（宿主缺陷的直接来源）。 */
export const SERVICE_SCOPE_DEPS = ['remote.session'] as const

/** 本模块唯一用到的 ctx 能力（cordis 的"加载一个带 inject 的子插件"）。 */
export interface ServiceScopeCtx {
  inject?(deps: readonly string[], callback: (scoped: unknown) => void): unknown
}

let scopedCtx: unknown

/**
 * 安装作用域 —— 每次 `apply()` 调用一次（HMR/重挂会重装，旧的回调只会覆盖同一个变量）。
 *
 * @param ctx - 插件的客户端 ctx。
 */
export function installServiceScope(ctx: unknown): void {
  if (ctx === null || ctx === undefined) return
  const inject = (ctx as ServiceScopeCtx).inject
  if (typeof inject !== 'function') return
  try {
    inject.call(ctx, SERVICE_SCOPE_DEPS, (scoped: unknown) => {
      scopedCtx = scoped
    })
  } catch {
    /* 老宿主没有可选 inject：退回原 ctx —— 结果只是"拿不到目录"，不是崩 */
  }
}

/**
 * 取服务时要用的 ctx：**优先**用声明了 `remote.session` 的那个作用域，拿不到就用 `fallback`。
 *
 * 为什么必须"拿不到就退回"：旧宿主（0.1.x）与没装 `dsh-client-ui-model-selection` 的机器上，
 * 这条可选依赖永远不 ready —— 此时用组件的 ctx 照旧能取到 `modelDirectories`（或者取不到，
 * 由调用方给可读报错）。
 */
export function serviceScopeCtx(fallback: unknown): unknown {
  return scopedCtx ?? fallback
}

/** 卸载时清空（`apply()` 的 cleanup 调用），避免持有已销毁的 fiber。 */
export function resetServiceScope(): void {
  scopedCtx = undefined
}
