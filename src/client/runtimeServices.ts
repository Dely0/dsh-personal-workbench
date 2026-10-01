/**
 * 宿主服务的**统一软探测入口**（2026-10-01 从 `index.tsx` 抽出）。
 *
 * ## 为什么抽出来
 *
 * 抽 `ModelPicker` 组件时暴露了一件事：这几个辅助（`pluginCtx` / `optionalService` /
 * `safeService` / `currentSessionIdOf`）原本是 `index.tsx` 的**模块私有**，
 * 而它们描述的是"怎么跟宿主说话"，与"面板长什么样"没有关系。
 * 组件要用它们 = 要么把组件留在巨型文件里，要么让它们有第二个家。
 * 正确答案是后者：**一处实现，多个使用者**。
 *
 * ## 三条不可动摇的口径（都有真事故背书）
 *
 * 1. **可选服务一律走 `ctx.get` 软探测**，绝不写进客户端 `inject` ——
 *    没装那个插件的机器上，写进 inject 会让**整个工作台面板 pending**
 *    （丢整块面板换一个下拉框，不可逆的不对称成本）。
 * 2. **连"必需"服务也要包一层**：cordis 在 fiber 已销毁后访问服务会抛
 *    `cannot get required service "sessions" in inactive context`（2026-09-12 实测，
 *    19 条控制台 error 里绝大多数是它），成因是已卸载实例仍在跑异步回调。
 *    拿不到就当 `undefined`，让调用点自己决定降级 —— 绝不把残留回调的错误抛给用户。
 * 3. `pluginCtx` 由 `apply()` 记录、卸载时清空，避免持有已废弃的 fiber。
 */
import { readCurrentSessionId } from './currentSession.js'

/** 宿主上下文（由 `apply()` 记录）。卸载时用 `setPluginCtx(undefined)` 清空。 */
let pluginCtx: unknown

/** 记录/清空宿主上下文（唯一写入口）。 */
export function setPluginCtx(ctx: unknown): void {
  pluginCtx = ctx
}

/** 读当前记录的宿主上下文（`undefined` = 还没 apply 或已卸载）。 */
export function getPluginCtx(): unknown {
  return pluginCtx
}

/** 软探测可选服务（cordis 代理访问未声明服务会抛错，必须用 ctx.get）。 */
export function optionalService<T>(ctx: unknown, name: string): T | undefined {
  const getter = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  if (typeof getter !== 'function') return undefined
  try {
    return getter(name) as T | undefined
  } catch {
    return undefined
  }
}

/** 安全读取宿主服务：拿不到（或 fiber 已失效）返回 `undefined`，绝不抛。 */
export function safeService<T>(runtime: unknown, name: string): T | undefined {
  const target = runtime as Record<string, unknown> | undefined
  if (target === undefined || target === null) return undefined
  try {
    return target[name] as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 读「用户当前正在看的那个会话」的 id —— **全插件唯一入口**（v1.15.6）。
 *
 * ## 为什么必须有它（2026-09-27，DSH 0.1.7-rc.2 桌面端真实退化）
 *
 * 插件原先在三处直接读 `sessions.list.getSnapshot().current`，而 0.1.7-rc.2 已经把
 * 这个字段**整个删掉**了（列表快照只剩 `ids` / `byId` / `phase`），选择语义搬进了
 * `uiWorkspace` 的 `mainView` 引用 —— 对外由 `uiSession.adapter.current` 投影。
 * 于是那三处**静默拿到 undefined**：
 *
 * 1. 「快速录入」的模型目录按 `ids[0]`（列表第一个会话）解析，不是当前会话；
 * 2. 「快速录入」推断工作区时 `currentCwd` 恒为空，第 1 档判据"当前会话 cwd 命中谁
 *    就用谁"整档失效 → 工作区多于一个候选时**必然拒绝**（用户实测的红字）；
 * 3. 复用型会话的可用性判据少了"它就是当前会话"这条旁证。
 *
 * 判据（含新旧两端）在 `currentSession.ts`，那里是纯函数、有单测；这里只负责取服务。
 *
 * @param runtime - 插件运行上下文（`ctx`）
 * @returns 会话 id；判定不出来时是空串（调用方按"不知道"处理，绝不猜一个）
 */
export function currentSessionIdOf(runtime: unknown): string {
  const list = safeService<{ list?: { getSnapshot?: () => unknown } }>(runtime, 'sessions')?.list?.getSnapshot?.()
  /**
   * `uiSession` 走 `ctx.get` 软探测（**不放进 inject**）：它只有 0.1.5+ 才有，
   * 写进 inject 会让旧宿主上整个插件 pending —— 与 `slots` / `layout` / `uiWorkspace`
   * 同一条政策（见 `viewTypes.ts` 里那段决策说明）。
   */
  return readCurrentSessionId({
    uiSession: optionalService<{ adapter?: { current?: string } }>(runtime, 'uiSession'),
    list: list as { current?: string } | undefined,
  })
}
