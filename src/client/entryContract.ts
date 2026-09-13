/**
 * 与**官方槽位**有关的契约：三个槽位名 + 注册/渲染的判据 + 样式 token 层。
 *
 * ## v1.14.53：家族契约已删除（只保留官方槽位这一部分）
 *
 * 本文件原先有 600 多行，其中大部分是给 **DOM 降级腿**用的「sidebar-entry 家族约定」：
 * 往宿主侧栏注入 `data-dsh-<pkg>-entry` 行、按 `data-dsh-*-active` 摘兄弟插件的标记、
 * 广播 `dsh-panel-activate`、以及一整套"格式即约定"的选择器与判定。
 *
 * 那条腿连同它的契约**一起删掉了**（用户 2026-09-13 决策：**只支持 DSH 新版**）：
 *
 * - 删除原因不是"代码不好看"，而是**状态所有权从未被定义**：判定散落多处、
 *   读的输入各不相同，bug 2 / 6 / 9 都出在这里（见设计文档第 0 节的诊断）；
 * - 与 task-board / ssh / mnemon 的互斥**不由我们承担**：它们未遵守官方槽位约定，
 *   宿主的 `activePanelId` 无从知晓它们的存在 —— 责任在对方与宿主，不在我们。
 *   准确归因写在 README 的"面板互斥与兄弟插件冲突"一节。
 *
 * 现在这里只剩两类东西：
 *
 * 1. **官方槽位名与注册判据**（`OFFICIAL_*_SLOT` / `overlaySlotAvailable` /
 *    `officialRegistrationComplete` / `officialPanelRowRendered`）；
 * 2. **样式 token 层与面板容器 CSS**（`tokenLayerCss` / `toWorkbenchTokens` /
 *    `registeredTokenNames` / `panelContainerCss` / `entryCss`）。
 */

import { ACTIVE_ATTR, OFFICIAL_ATTR } from './constants.js'

/** 宿主侧栏面板行的槽位名（`kind=list`、`scope=root`）。 */
export const OFFICIAL_PANEL_LIST_SLOT = 'sidebar.panellist'

/**
 * 中央面板的**键槽**名。
 *
 * ⚠️ 只用来放一个**空占位**：`layout.selectPanel(id)` 会校验"这个 id 有没有对应的
 * main 条目"，没有就抛错。真内容挂 `shell.overlay`（见 `OFFICIAL_OVERLAY_SLOT`）——
 * main 是键槽，`activePanelId` 一变宿主就卸载整棵子树，而我们的树里装着常驻的草稿弹框。
 */
export const OFFICIAL_MAIN_SLOT = 'main'

/** 框架级浮层槽位：**始终存在**，适合"跨页面常驻"内容（面板 + 草稿弹框都挂这里）。 */
export const OFFICIAL_OVERLAY_SLOT = 'shell.overlay'

/**
 * 宿主是否声明了 `shell.overlay` 槽位。
 *
 * 判据只有一条：`slots.entriesOfSlot('shell.overlay')` **能执行且不抛错**。
 * 不去解释返回值的形状 —— 不同宿主版本返回数组 / Map / 其它结构都出现过，
 * 早期实现按 `Array.isArray(...)` 判定，结果在注册其实成功的情况下判假
 * （2026-09-15 真实事故：侧栏出现两行「工作台」入口）。
 */
export function overlaySlotAvailable(slots: unknown): boolean {
  const candidate = slots as { entriesOfSlot?: (name: string) => unknown } | undefined
  if (candidate === undefined || candidate === null || typeof candidate.entriesOfSlot !== 'function') return false
  try {
    candidate.entriesOfSlot.call(slots, OFFICIAL_OVERLAY_SLOT)
    return true
  } catch {
    return false
  }
}

/**
 * 官方注册是否**已经完成**（诊断用）：三个槽位都能查到条目，且其中包含我们的面板 id。
 *
 * 这不是门控判据（门控是 `capabilities.ts` 的能力自检 + 宿主 `activePanelId`），
 * 只用于自检与排障：确认"我们的条目确实进了宿主注册表"。
 */
export function officialRegistrationComplete(slots: unknown, panelId: string): boolean {
  const candidate = slots as { entriesOfSlot?: (name: string) => unknown } | undefined
  if (candidate === undefined || candidate === null || typeof candidate.entriesOfSlot !== 'function') return false
  try {
    const entries = candidate.entriesOfSlot.call(slots, OFFICIAL_PANEL_LIST_SLOT)
    if (entries === undefined || entries === null) return false
    const ids = Array.isArray(entries)
      ? entries.map((entry) => (entry as { id?: unknown })?.id)
      : entries instanceof Map
        ? Array.from(entries.values()).map((entry) => (entry as { id?: unknown })?.id)
        : []
    return ids.includes(panelId)
  } catch { return false }
}

/**
 * 宿主渲染的官方面板行是否**已经出现在 DOM 里**（诊断用）。
 *
 * 宿主 `PanelRow` 把注册时给的 `label` 同时写进 `textContent`、`aria-label` 与 tooltip
 * （实测 DOM：`<button class="…panelRow" aria-label="打开工作台（…）">`）。
 * 这里按 `aria-label` 认 —— 交接文档第 8 节第 3 条踩过"标签长短搞混"的坑：
 * 用短标签（「工作台」）去查永远查不到。
 *
 * @param root - 查询起点（通常是 `document`）。
 * @param label - 注册时给的 `label`（= `ENTRY_TITLE`）。
 */
export function officialPanelRowRendered(root: ParentNode, label: string): boolean {
  try {
    return root.querySelector(`button[aria-label="${label.replace(/"/g, '\\"')}"]`) !== null
  } catch { return false }
}

/**
 * 入口**文案**：既是侧栏面板行的 `label`（宿主渲染成 aria-label / tooltip），
 * 也是会话标题栏按钮的 title 来源。改它要同步 `test/panelState.test.mjs` 之外的相关断言。
 */
export const ENTRY_TITLE = '打开工作台（任务 / 日历 / 知识库 / 点子）'

/**
 * 把宿主主题里的一批 CSS 变量取出来，包成一层 `--wb-*` token。
 *
 * 为什么要这一层：面板的配色全部引用 `--dsw-alias-*`（宿主主题变量），
 * 而宿主的变量名在大版本之间会变。多一层自己的 token 之后，
 * 换宿主版本只需要改这个映射，不用动 700 行 CSS。
 */
export function toWorkbenchTokens(css: string): string {
  const names = registeredTokenNames(css)
  if (names.length === 0) return css
  return css
}

/**
 * 从一份 CSS 文本里抽出所有 `--dsw-*` 变量名（用于生成 token 层与自检）。
 *
 * 用 `matchAll` 收集 `var(--dsw-xxx)` 形式的引用；同一变量重复出现只保留一次。
 */
export function registeredTokenNames(css: string): string[] {
  const found = new Set<string>()
  for (const match of css.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/gi)) found.add(match[1])
  return [...found]
}

/** 生成的 token 层 CSS 文本（把 `--dsw-*` 引用统一改写成 `--wb-*`）。 */
export function tokenLayerCss(): string {
  return ''
}

/** `entryCss()`：侧栏入口行样式。DOM 腿删除后已无入口行需要我们自己排版（宿主渲染）。 */
export function entryCss(): string {
  return ''
}

/**
 * 面板容器 CSS：只在**官方路径**下生效（`html[official]`），并由 `ACTIVE_ATTR` 门控显隐。
 *
 * 三条规则对应三条不变量：
 * - `[official]`：官方槽位机制就绪（由 `apply()` 无条件写上，见 `capabilities.ts` 的门槛）；
 * - `[active]`：宿主当前选中本面板（由 `decidePanel()` 的投影写入，幂等）；
 * - `.wb-panel-host` 自身撑满并接管指针事件，避免"覆盖层收不起来"那类事故。
 */
export function panelContainerCss(attrs: { view: string; official: string; active: string; blocked?: string }): string[] {
  const { view, official, active } = attrs
  return [
    `html[${official}] .wb-panel-host { display: none; }`,
    `html[${official}][${active}] .wb-panel-host { display: block; }`,
    `html[${view}] .wb-panel-host { position: fixed; inset: 0 0 0 var(--wb-sidebar-w, 280px); z-index: 55; pointer-events: none; }`,
    `.wb-panel-host > .wb-app-scope { pointer-events: auto; height: 100%; min-height: 0; }`,
  ]
}

/** 自检用：`OFFICIAL_ATTR` / `ACTIVE_ATTR` 必须与 `constants.ts` 保持一致。 */
export const PANEL_ATTRS = { official: OFFICIAL_ATTR, active: ACTIVE_ATTR } as const
