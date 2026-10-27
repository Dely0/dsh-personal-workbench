/**
 * 「模型目录该向哪个会话要」—— **唯一判定**（2026-10-26，桌面端 DSH 0.2.1-rc.3）。
 *
 * ## 这个模块解决什么
 *
 * 宿主的 `dsh-client-ui-model-selection` 在 `directoryFor(sessionId)` 里先查
 * `sessions.scope(sessionId)`，没有就抛
 * `ui-model-selection: session "…" resolved no scope`（0.1.7-rc.2 时的措辞是 `no binding`），
 * 而 scope **只在有人 `retain()` 过这个会话之后才存在**
 * （`ClientSessions.retainScope()`：`this.scopes.get(id) ?? this.materializeScope(id)`）。
 *
 * 主视图（`mainView`）与右侧栏（`sidebarView`）各自 retain，所以"会话界面上的"模型按钮
 * 一直正常；本插件是在自己的面板里**自己挑会话**，于是挑到谁就决定了能不能解析：
 *
 * - 工作台面板打开时主视图往往没有会话 → `currentSessionIdOf()` 返回空串；
 * - 这时如果盲取 `sessions.list.ids[0]`，那个会话往往**谁都没持有** → 红字，选不了模型。
 *
 * 所以这条挑选口径本身是一份判定，必须有单测；**持有**（retain / 引用计数 / 释放）不在这里，
 * 它在 `sessionRef.ts` 的 `createSessionHold()`（全仓"借会话"的唯一实现，由
 * `test/panelCss.test.mjs` 的源码扫描钉住）。
 *
 * ## 硬约束
 *
 * 不 import React、不碰 DOM、不读 `document` → 可被 `node --test` 直接跑
 * （`test/modelDirectorySession.test.mjs`）。
 */
import { hasAnyRetention } from './sessionRef.js'

/** 会话列表快照里本模块真正用到的部分（`DshSessionListState` 的子集）。 */
export interface DirectorySessionSummary {
  readonly id?: string
  /**
   * 宿主按来源统计的持有数（`{ mainView: 1, sidebarView: 1 }`）。
   *
   * ⚠️ 它不在 `viewTypes.ts` 声明的 `DshSessionSummary` 子集里（0.2.x 才投影出来），
   * 所以这里单独声明、并一律按"可能没有"读取。
   */
  readonly retainedBy?: Record<string, number>
}

export interface DirectorySessionList {
  readonly ids?: readonly string[]
  readonly byId?: Record<string, DirectorySessionSummary | undefined>
}

/**
 * 该向哪个会话要模型目录。
 *
 * 顺序：
 *
 * 1. 用户正在看的那个会话（`currentSessionIdOf()` 给的 id）—— 它就是宿主框架此刻渲染的
 *    会话，`mainView` 也一定 retain 着它，目录解析必然成立；
 * 2. 列表里**任意一个已被持有的**会话（按 `ids` 顺序取第一个）—— 目录是"宿主这一代的
 *    全局模型表 + 这个会话的持久投影"，读哪一份得到的模型列表都一样；有持有者就用它，
 *    省一次 retain + 宿主 open；
 * 3. `ids[0]`：只是"目录得有个会话可问"的兜底，由调用方补上持有（`createSessionHold`）；
 * 4. 都没有 ⇒ 空串（调用方按"还没有会话"处理，绝不猜）。
 *
 * ⚠️ 0.1.7-rc.2 起列表快照**不再有 `current`**，所以第 1 步只能靠 `currentSessionIdOf()`
 * （`currentSession.ts` 那唯一入口），这里不再自己读列表字段。
 *
 * ⚠️ 挑出来的 id **只用来问模型表**，不能拿去推断工作区 —— 工作区必须精确，猜错会把文件
 * 建进别人的项目目录（见 `intakeWorkspace.ts` 的口径）。
 *
 * @param currentId - 当前会话 id（空串 = 判定不出来）。
 * @param list - `sessions.list.getSnapshot()`（允许缺失）。
 * @returns 用来解析模型目录的会话 id；没有任何会话时是空串。
 */
export function pickDirectorySessionId(currentId: string, list: DirectorySessionList | undefined): string {
  if (currentId !== '') return currentId
  const byId = list?.byId ?? {}
  const ids = list?.ids ?? []
  for (const id of ids) {
    if (hasAnyRetention(byId[id]?.retainedBy)) return id
  }
  for (const summary of Object.values(byId)) {
    const id = summary?.id
    if (typeof id === 'string' && id !== '' && hasAnyRetention(summary?.retainedBy)) return id
  }
  return ids[0] ?? ''
}
