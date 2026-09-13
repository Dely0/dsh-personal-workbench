/**
 * 面板可见性的**唯一权威源**（设计文档 2026-09-13 第 4 节，原则 P1 + P2）。
 *
 * ## 为什么必须有这个文件
 *
 * 15 小时排查里同一类缺陷发作了三次（bug 2 / 6 / 9，见设计文档第 0 节），共同根因是
 * **"面板该不该显示"被独立计算了 3 次**，而且三次读的输入集合**并不相同**：
 *
 * | 位置（改动前） | 读的输入 |
 * |---|---|
 * | `WorkbenchPanelContent` 的渲染条件 | `hasPanelInfoHook()` + 槽位 props 的 `activePanelId` |
 * | `isDisplayed()`（家族互斥让位判据） | 模块级 `panelInfoHookSeen` + 模块级镜像 `hostPanelId` |
 * | `WorkbenchHeaderEntry`（标题栏按钮高亮） | `workbench.usePanelInfo` + `isHostSelected()` |
 *
 * 三处**逻辑上可以互相矛盾** —— 这就是"多点点击打不开 / 被挤掉后再也开不了"的来源。
 * 现在它们全部调用本文件的 `decidePanel()`，判据只有一份。
 *
 * ## 硬约束（设计文档第 3 节）
 *
 * **不得 import React、不得触碰 DOM。** 本文件只做纯计算，因此可以被 `node --test`
 * 直接测（`test/panelState.test.mjs`），不需要浏览器。
 *
 * ## 与设计文档示例的一处必要偏差（已在此说明，不是偷偷改）
 *
 * 设计文档的示例 `PanelSnapshot` 只有 `{ hostPanelId, intentOpen }`，靠
 * `hostPanelId === undefined` 表达"宿主状态不可读"。落到真实代码里，
 * "不可读"有两个**互相独立**的成因，必须分开表达，否则会改变既有行为：
 *
 * 1. **没进入官方路径**（`layout.selectPanel` 不可用 / 抛错）→ 显隐以本地意图为准；
 * 2. 进入了官方路径但槽位还没渲染过（首次渲染前）→ `hostPanelId` 仍是 `undefined`，
 *    此时**不能**当成"不可读"退回本地意图（那正是 bug 9 的形态）。
 *
 * 所以快照里显式带一个 `stateReadable`（= "宿主状态驱动着本面板的显隐"）。
 * 决策表仍然是穷举的 5 行，只是把"不可读"的成因写明了。
 */

/**
 * 本插件在宿主里的面板名（决定"是不是选中了我们"）。
 *
 * ⚠️ **不在这里重新定义** —— 常量已经在 `constants.ts` 里（样式与组件也要用同一个值）。
 * 重新定义一份就是"同一个语义两处实现"，正是本次重构要消灭的东西。
 * 这里只是把它转出来，让判定模块的调用方不必同时 import 两个文件。
 */
export { PANEL_NAME } from './constants.js'
import { PANEL_NAME } from './constants.js'

/**
 * 判定输入。三个字段都是**只读快照**，由调用方在需要时现取，本模块不持有任何状态。
 */
export interface PanelSnapshot {
  /**
   * 宿主状态是否驱动着本面板的显隐。
   *
   * - `true`：在官方路径上 —— 宿主 `activePanelId` 说了算，本地意图**不参与**判断；
   * - `false`：没进官方路径（或 `selectPanel` 明确失败过一次）→ 退回 `intentOpen`。
   */
  readonly stateReadable: boolean
  /**
   * 宿主当前选中的面板 id；`null` = 宿主明确"没有选中任何面板"。
   *
   * ⚠️ 只在 `stateReadable === true` 时有意义；`stateReadable === false` 时调用方
   * 可以直接给 `null`（本模块也不会读它）。
   */
  readonly hostPanelId: string | null
  /**
   * 本地"我发起的开合意图"，**仅在 `stateReadable === false` 时作为回落**。
   *
   * 对应代码里的 `open && !forcedClosed`：既没被用户强制关掉、本地也确实打开过。
   */
  readonly intentOpen: boolean
}

/**
 * 唯一的判定结果。
 *
 * `show` 为假时**必须**带上 `because` —— 这样日志、测试与排障都能直接说出
 * "是谁把它关掉的"，而不是只能看到一个 `undefined`。
 */
export type PanelDecision =
  | { readonly show: true }
  | { readonly show: false; readonly because: 'host-selected-other' | 'not-selected' | 'intent-closed' }

/**
 * 「面板该不该显示」的**唯一**答案。
 *
 * ## 决策表（穷举，`test/panelState.test.mjs` 逐行覆盖）
 *
 * | # | stateReadable | hostPanelId | intentOpen | 结果 |
 * |---|---|---|---|---|
 * | 1 | true | `PANEL_NAME` | 任意 | `show` |
 * | 2 | true | `null` | 任意 | `hide(not-selected)` |
 * | 3 | true | 其它 id | 任意 | `hide(host-selected-other)` |
 * | 4 | false | 不读 | true | `show` |
 * | 5 | false | 不读 | false | `hide(intent-closed)` |
 *
 * 三条不变量（设计文档第 4.2 节）：
 *
 * 1. `show === true` ⟺ 面板容器 `data-open="1"`（`panelSlots.tsx` 单点投影）；
 * 2. `<html data-dsh-personal-workbench-active>` 的存在 ⟺ `show === true`（幂等写）；
 * 3. 宿主状态可读时，**本地意图不得参与判断** —— 否则会出现"关掉后再点官方行打不开"
 *    这类"两套判据互相否决"的缺陷。
 */
export function decidePanel(snapshot: PanelSnapshot): PanelDecision {
  if (snapshot.stateReadable) {
    if (snapshot.hostPanelId === PANEL_NAME) return { show: true }
    if (snapshot.hostPanelId === null) return { show: false, because: 'not-selected' }
    return { show: false, because: 'host-selected-other' }
  }
  return snapshot.intentOpen ? { show: true } : { show: false, because: 'intent-closed' }
}

/** `decidePanel(...).show` 的便捷读法（调用方大多只关心真/假）。 */
export function shouldShowPanel(snapshot: PanelSnapshot): boolean {
  return decidePanel(snapshot).show
}

/**
 * 渲染不变量 1 的投影：面板容器的 `data-open` 属性值。
 *
 * 放在这里而不是组件里，是为了让"决策 ⟺ 投影"这条一致性可以被单测直接断言
 * （设计文档 I2）：它和 `shouldShowPanel` 调的是**同一个** `decidePanel()`，
 * 所以"容器 `data-open="1"` 却判定不显示"在结构上不可能。
 * 返回值直接喂给 JSX 的 `data-open={...}`。
 */
export function panelDataOpen(snapshot: PanelSnapshot): '1' | undefined {
  return decidePanel(snapshot).show ? '1' : undefined
}
