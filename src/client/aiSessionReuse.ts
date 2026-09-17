/**
 * 复用型 AI 会话（计划 / 报告 / 点子关联 / 点子头脑风暴）的**复用判据**。
 *
 * ## 为什么必须有这一层（2026-09-17 真实故障）
 *
 * 这四种会话在 `ai_session_registry` 里是"每个 scope+anchor 一条"，复用分支原先
 * 只问了一句"注册表里有没有登记"——有就直接 `sessions.open()` 并返回。
 *
 * 但登记行**不会**随会话消失而消失：用户把那个对话「归档」以后，宿主只是把 id
 * 收进工作区归档集（连文件都不删），于是：
 *
 * 1. `sessions.open(id)` 自己不抛错（该会话仍在宿主会话列表里）；
 * 2. 宿主的导航策略发现"当前会话已被归档"，立刻把选中清掉（`clearArchivedCurrent`）；
 * 3. 用户看到的只有"点了一下、什么也没发生"，而注册表那行**永不更新**
 *    ——新的头脑风暴会话永远不会被创建，这个点子从此再也点不出会话。
 *
 * 所以复用前必须多问一句"这个会话还能用吗"。答案由宿主的两份快照给出：
 * 归档集（有没有被归档）+ 会话列表（还在不在、列表是否已就绪）。
 *
 * ## 判据宁可少下结论，也不改既有行为
 *
 * - 归档集里有 → **不可复用**（本函数唯一的硬判据）；
 * - 会话列表 `ready` 且查不到该 id → **不可复用**（会话被物理删除的情形）；
 * - 列表 `pending`（`ids` 还是空的）或宿主没给列表 / 归档集 → **不下结论**，
 *   保持改动前的行为——旧宿主、启动瞬间都走这条，零回归。
 */
export interface AiSessionReuseProbe {
  sessionId: string
  /** 宿主工作区归档集；旧宿主没有这个字段。 */
  archivedSessionIds?: readonly string[] | undefined
  /** 宿主会话列表快照；拿不到时传 `undefined`。 */
  list?: { ids: readonly string[]; current?: string | undefined; phase?: string | undefined } | undefined
}

/**
 * 登记在册的复用型会话现在还能不能复用。
 *
 * @param probe - 会话 id + 宿主的两份快照（都允许缺失，缺失即"不下结论"）
 * @returns `false` 表示这条登记已经不能用了，调用方必须**落回新建流程**
 *          （登记接口是 upsert，新建后会自动覆盖那行陈旧登记）
 */
export function isAiSessionReusable(probe: AiSessionReuseProbe): boolean {
  const { sessionId, archivedSessionIds, list } = probe
  if (Array.isArray(archivedSessionIds) && archivedSessionIds.includes(sessionId)) return false
  if (list !== undefined && list.phase === 'ready' && !list.ids.includes(sessionId) && list.current !== sessionId) return false
  return true
}
