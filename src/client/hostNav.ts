/**
 * 宿主会话导航与「当前会话」适配（面向 DSH 0.1.7+）。
 *
 * 背景：0.1.7 的客户端会话服务不再承担导航职责 —— `ISessions` 接口注释写明
 * "navigation belongs to view owners"，旧的 `sessions.open(id)` 已被移除；
 * 同时 `SessionListState` 也删掉了 `current` 字段。官方替代方案：
 *  - 导航 → `ctx.uiWorkspace.openSession(target)`（target = 会话 id 或子代理地址）
 *  - 当前会话 → 宿主自己在 6+ 个包里统一使用的 `retainedBy.mainView > 0` 保留计数
 *    （dsh-client-ui-layout / dsh-client-ui-session / dsh-client-ui-workspace 等）
 *
 * 两个适配都必须软探测：宿主没提供时只告警，不能让工作台整体崩掉。
 * 注意 `uiWorkspace` **不在**本插件的 inject 列表里，直接属性访问 `ctx.uiWorkspace`
 * 会被 cordis 代理抛错（"cannot get property ... without inject"），因此一律走
 * 非严格的 `ctx.get('uiWorkspace')`。
 */
import type { DshSessionListState } from './viewTypes.js'

/** 具备宿主服务软读取能力的最小上下文（WorkbenchRuntime 结构上满足它）。 */
export interface HostNavRuntime {
  /** cordis 非严格服务读取；未声明 inject 的服务只能这样拿。 */
  get?: (key: string) => unknown
}

/** `uiWorkspace` 里本插件用到的能力子集。 */
interface UiWorkspaceNav {
  openSession?: (target: string) => void
}

/**
 * 软读取宿主 `uiWorkspace` 服务。
 * @param runtime - 宿主上下文。
 * @returns 服务对象；不可用时返回 undefined（不抛错）。
 */
function readUiWorkspace(runtime: HostNavRuntime | undefined): UiWorkspaceNav | undefined {
  const get = runtime?.get
  if (typeof get !== 'function') return undefined
  try {
    const candidate = get.call(runtime, 'uiWorkspace')
    return candidate === null || candidate === undefined ? undefined : candidate as UiWorkspaceNav
  } catch {
    return undefined
  }
}

/**
 * 当前主视图正在显示的会话 id。
 *
 * 0.1.7 起 `SessionListState` 没有 `current` 字段；宿主各处一律用
 * 「mainView 保留计数 > 0」判定当前会话，这里保持同一口径。
 * @param state - 会话列表快照。
 * @returns 当前会话 id；没有会话被主视图保留时返回 undefined。
 */
export function currentSessionIdOf(state: DshSessionListState): string | undefined {
  return Object.values(state.byId).find((session) => (session.retainedBy?.mainView ?? 0) > 0)?.id
}

/**
 * 选中并显示一个会话（等价于旧版 `sessions.open(id)`）。
 * @param runtime - 宿主上下文。
 * @param sessionId - 目标会话 id。
 * @returns 是否成功发起导航。
 */
export function openHostSession(runtime: HostNavRuntime | undefined, sessionId: string): boolean {
  const nav = readUiWorkspace(runtime)
  const openSession = nav?.openSession
  if (typeof openSession === 'function') {
    // 用 call 保留 this：openSession 是 UiWorkspaceService 的方法。
    openSession.call(nav, sessionId)
    return true
  }
  console.warn('[workbench] 当前 DSH 未提供 uiWorkspace.openSession，无法跳转到会话', sessionId)
  return false
}
