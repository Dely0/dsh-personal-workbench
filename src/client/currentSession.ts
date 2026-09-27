/**
 * 「用户当前正在看的那个会话」—— **唯一判定入口**（v1.15.6）。
 *
 * ## 为什么必须有这个模块（2026-09-27，DSH 0.1.7-rc.2 桌面端真实退化）
 *
 * 0.1.7-rc.2 把「当前会话」从会话列表里搬走了：
 *
 * | 宿主 | 「当前会话」在哪 |
 * |---|---|
 * | ≤ 0.1.5 | `sessions.list.getSnapshot().current`（会话列表快照自带） |
 * | 0.1.7-rc.2 | 列表快照**不再发布 `current`**（只剩 `ids` / `byId` / `phase` / `projectionsBySession`）；选择语义搬进了 `uiWorkspace` 的 `mainView` 引用，由 `uiSession` 的绑定源对外投影 |
 *
 * 后者的官方出口是 **`uiSession.adapter.current`**：宿主自己的槽位框架就用它渲染
 * `session` / `session-maybe` 作用域（`ui-session` 的 `publishMain()` 挑"持有
 * `mainView` 引用"的那个会话），语义与旧 `current` 完全一致。两端代码逐字一致，
 * 所以这条判据同时覆盖新旧宿主。
 *
 * ## 不修会怎样（用户实测的现象）
 *
 * 工作台「快速录入推断工作区」的判据第 1 档是"**当前会话的 cwd 精确命中已注册工作区**"
 * —— 读不到当前会话时这一档**静默失效**，判定直接掉到第 2/3 档。工作区多于一个候选时
 * 结果是"明确拒绝"，而拒绝文案还让用户"在 DSH 里切到目标任务所在的工作区"：
 * 切了也读不到。所以这不是提示问题，是**功能退化**。
 *
 * ## 硬约束
 *
 * 纯函数、不 import React、不碰 DOM、不读 service —— 只吃调用方传进来的两份**快照**，
 * 因此能被 `node --test` 直接测（见 `test/currentSession.test.mjs`）。
 * 取服务那一步留在 `index.tsx`（`currentSessionIdOf`），本模块只管判定。
 */

/**
 * 判定输入：两份宿主快照。
 *
 * 两份都允许缺失 —— 缺失的语义是"**不知道**"，而不是"没有会话"：
 * 调用方据此不下结论（绝不猜一个会话，猜错会把文件建进别人的项目目录）。
 */
export interface CurrentSessionProbe {
  /**
   * 宿主 `uiSession` 服务（0.1.5 起就有 `adapter.current`，0.1.7-rc.2 仍是权威出口）。
   * 传 `ctx.get('uiSession')` 的结果；取不到就传 `undefined`。
   */
  uiSession?: unknown
  /** `sessions.list.getSnapshot()`（旧宿主在这里带 `current`）。 */
  list?: { current?: string | undefined } | undefined
}

/** 读一个"会话 id"字段：空白串与非法类型一律当没有（id 不可能是空串）。 */
function readId(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

/**
 * 从 `uiSession.adapter.current` 这个**绑定源**里读出会话 id。
 *
 * 形状（0.1.5 与 0.1.7-rc.2 的实现逐字一致）：
 *
 * - `adapter.current` 是 `{ value, getSnapshot(), subscribe() }` 的绑定源；
 * - 它的值既可能是"当前绑定"（`{ key, props: { sessionId } }`），
 *   也可能是"缺席绑定"（`key: undefined` —— 还没有任何会话被 `mainView` 持有）；
 * - 所以 `key` / `sessionId` / `props.sessionId` 三个位置都试，取第一个可用的。
 *
 * 读不到一律返回空串（"不知道"），绝不退化成"列表里第一个会话"。
 */
function readUiSessionCurrentId(uiSession: unknown): string {
  const adapter = (uiSession as { adapter?: { current?: unknown } } | undefined)?.adapter
  const source = adapter?.current
  if (source === null || source === undefined) return ''
  const snapshot = typeof (source as { getSnapshot?: () => unknown }).getSnapshot === 'function'
    ? (source as { getSnapshot: () => unknown }).getSnapshot()
    : (source as { value?: unknown }).value
  if (snapshot === null || typeof snapshot !== 'object') return ''
  const record = snapshot as { key?: unknown; sessionId?: unknown; props?: { sessionId?: unknown } }
  return readId(record.key) || readId(record.sessionId) || readId(record.props?.sessionId)
}

/**
 * 判定"当前会话"的 id；**不知道时返回空串**。
 *
 * 判据顺序：
 *
 * 1. 宿主 `uiSession` 的绑定源 —— 0.1.7-rc.2 上**唯一**的事实来源，且它就是宿主框架
 *    此刻渲染的那个会话（比"列表里选中了谁"更贴事实）；
 * 2. 旧宿主会话列表快照里的 `current` —— ≤0.1.5 的权威来源。
 *
 * @param probe - 两份宿主快照（都允许缺失）
 * @returns 会话 id；判定不出来时是空串（调用方必须按"不知道"处理）
 */
export function readCurrentSessionId(probe: CurrentSessionProbe): string {
  const fromUiSession = readUiSessionCurrentId(probe.uiSession)
  if (fromUiSession !== '') return fromUiSession
  return readId(probe.list?.current)
}
