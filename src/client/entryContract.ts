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
  } catch { return false }
}

/**
 * 官方注册是否**已经完成**：侧栏面板行与 main 条目都能查到我们。
 *
 * ⚠️ 用的宿主接口是 `slots.entries(name)`（**不是** `entriesOfSlot`）——
 * 两者在宿主上是不同方法：`entriesOfSlot` 拿来确认"槽位存在"（见 `overlaySlotAvailable`），
 * `entries` 才是"已经注册进去的条目列表"。v1.14.53 重写这个模块时曾把两者搞混
 * （用 `entriesOfSlot` 去取条目），语义就变了 —— 恢复为原始实现。
 *
 * 只作诊断/自检：门控判据是 `capabilities.ts` 的能力自检 + 宿主 `activePanelId`。
 */
export function officialRegistrationComplete(slots: unknown, panelId: string): boolean {
  const candidate = slots as { entries?: (name: string) => Array<{ options?: { id?: unknown; key?: unknown } }> } | undefined
  if (candidate === undefined || candidate === null || typeof candidate.entries !== 'function') return false
  try {
    const panels = candidate.entries.call(slots, OFFICIAL_PANEL_LIST_SLOT)
    const mains = candidate.entries.call(slots, OFFICIAL_MAIN_SLOT)
    const hasEntry = Array.isArray(panels) && panels.some((entry) => entry?.options?.id === panelId)
    const hasMain = Array.isArray(mains) && mains.some((entry) => entry?.options?.key === panelId || entry?.options?.id === panelId)
    return hasEntry && hasMain
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
 * `--wb-*` 令牌层：**每一项都带回退值，且回退值跟随明暗**。
 *
 * ## 这一层为什么必须存在（真实事故，不是洁癖）
 *
 * 面板最初直接写 `var(--dsw-alias-bg-base, #111)`。宿主令牌拿不到时（宿主改名、
 * 或我们的容器不在宿主的主题作用域里），回退值 `#111` 是**深黑** ——
 * 于是整个面板变成黑底 + 深色字，用户看到的是"工作台一片漆黑、字都看不清"。
 *
 * 现在的做法：先映射到我们自己的 `--wb-*`，回退值用 `light-dark()`，
 * 令牌缺失时退化成"跟随系统明暗"，而不是"变成黑色"。
 */
const TOKENS: Record<string, string> = {
  'bg-base': 'light-dark(#ffffff, #17171a)',
  'bg-layer-1': 'light-dark(#f7f7f8, #202024)',
  'bg-layer-2': 'light-dark(#ffffff, #1c1c1f)',
  'border-l1': 'light-dark(rgba(0,0,0,.16), rgba(255,255,255,.20))',
  'label-primary': 'light-dark(#1a1a1c, #eeeeef)',
  'label-secondary': 'light-dark(rgba(0,0,0,.58), rgba(255,255,255,.64))',
  'state-business-primary': 'light-dark(#2f6fe0, #6f9df0)',
}

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif'

/** 生成 `--wb-*` 令牌层 CSS（由 styles.ts 放在样式表最前面）。 */
export function tokenLayerCss(): string {
  const lines = [
    // 兜底：宿主没设 color-scheme 时跟随系统；宿主设了就以宿主的为准（更具体的选择器会覆盖）。
    ':root { color-scheme: light dark; }',
    '.wb-scope, :root {',
    `  --wb-font: var(--dsw-font-family, ${FONT_FAMILY});`,
  ]
  for (const [name, fallback] of Object.entries(TOKENS)) {
    lines.push(`  --wb-${name}: var(--dsw-alias-${name}, ${fallback});`)
  }
  lines.push('}')
  return lines.join('\n')
}

/**
 * 把样式表里的 `var(--dsw-alias-x, <回退>)` 改写成 `var(--wb-x)`（纯函数，可测）。
 *
 * 用函数而不是手工替换上百处：手工替换一定会漏，而**漏掉的那一处**就会在
 * 令牌缺失时变回深黑 —— 正是上面那次事故的成因。没登记的令牌保持原样
 * （宁可原样，也不要静默改错），并由单测把"有没有漏登记的"钉住。
 *
 * 回退值里可能**再套一层 var()**（例如 `var(--dsw-alias-bg-base, var(--dsw-specific-x, #111))`），
 * 所以括号匹配用"含一层嵌套"的写法，而不是 `[^)]*`。
 */
export function toWorkbenchTokens(css: string): string {
  const fallback = String.raw`(?:\s*,\s*(?:[^()]|\((?:[^()]|\([^()]*\))*\))*)?`
  return css
    .replace(
      new RegExp(String.raw`var\(--dsw-alias-([a-z0-9-]+)${fallback}\)`, 'g'),
      (whole: string, name: string) => (TOKENS[name] === undefined ? whole : `var(--wb-${name})`),
    )
    .replace(new RegExp(String.raw`var\(--dsw-font-family${fallback}\)`, 'g'), 'var(--wb-font)')
}

/** 已登记的令牌名（单测用：确保样式里用到的 `--wb-*` 都真的被定义了）。 */
export function registeredTokenNames(): string[] {
  return Object.keys(TOKENS)
}

/**
 * 面板容器的可见性规则（由 styles.ts 拼进 `WORKBENCH_CSS`）。
 *
 * 放在契约模块里而不是 styles.ts 的原因：**样式只在浏览器 bundle 里**，
 * `styles.ts` 不进构建产物、测不到；规则写在这里就能被 `node --test` 锁住。
 *
 * ## 规则怎么读（`view` = `VIEW_ATTR`，`official` = 官方路径就绪标记）
 *
 * 真正承载内容的节点带 `VIEW_ATTR`（`.wb-app-scope` 只是它内部的一层），
 * 所以门控必须按 `VIEW_ATTR` 写 —— 按类名门控 `.wb-panel-host` 等于什么都没放行。
 *
 * - ① 会话列里那份内容一律隐藏：真内容只在官方容器（`shell.overlay`）里；
 * - ② 官方容器里那份照常显示，显隐交给容器自己的 `data-open`（见 index.tsx 的 `panelDataOpen`）；
 * - ③ 会话列正常占位：让位是宿主按 `activePanelId` 自己做的事，我们不再 `display:none` 它。
 *
 * ⚠️ **v1.14.53 的真实事故**：阶段 2 删 DOM 腿时这里被"重写"过一版
 * （`html[official] .wb-panel-host { display:none }` + `html[official][active] { display:block }`），
 * 结果**面板整个不显示**（用户："插件入口不可用了，工作台插件无法正常显示"）。
 * 教训：**迁移期不要"顺手重写"这类门控 CSS** —— 它和 DOM 结构强耦合，改法必须小步可验证。
 */
export function panelContainerCss(attrs: { view: string; official: string; active: string }): string[] {
  const { view, official, active } = attrs
  return [
    // ① 会话列里那份内容一律隐藏（真内容只在官方容器里）
    `html[${official}] [${view}] { display: none; }`,
    // ② 官方容器里那份照常显示（容器的显隐由 data-open 决定）
    `html[${official}] .wb-panel-host [${view}] { display: block; }`,
    // ③ 会话列正常占位（不再由我们 display:none 掉它）
    `html[${official}] [class*='centerCol'] > :not([${view}]) { display: flex; }`,
    // ④ 未就绪兜底：旧行为（官方标记缺失时按 ACTIVE_ATTR 放行），保证任何情况下不会"全黑"
    `html:not([${official}])[${active}] .wb-panel-host [${view}] { display: block; }`,
  ]
}

/** 自检用：`OFFICIAL_ATTR` / `ACTIVE_ATTR` 必须与 `constants.ts` 保持一致。 */
export const PANEL_ATTRS = { official: OFFICIAL_ATTR, active: ACTIVE_ATTR } as const
