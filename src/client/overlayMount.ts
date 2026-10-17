/**
 * 浮层的 portal 挂载点：**宿主的官方 overlay 层**（`shell.overlay` 槽渲染出的
 * `[data-shell-overlay]` 容器），而不是 `document.body`。
 *
 * ## 为什么 body 不够（2026-10-17 用户实测，桌面端）
 *
 * 面板（`.wb-panel-host`，`z-index: 55`）本来就挂在宿主的 overlay 层里，
 * 而该层自己的 computed `z-index` 是 **1000**（`position: absolute`，自成层叠上下文）。
 * 于是把弹窗 portal 到 `document.body` 的浮层（`.wb-overlay` 300 / `.wb-model-menu` 330）
 * 与面板**不在同一个层叠上下文**：在 body 这一层比的是「overlay 层的 1000」对
 * 「弹窗的 300」—— 宿主 overlay 层整支胜出，**面板把自家弹窗和模型列表全部盖住**。
 * 真实症状（两份 console 日志为证）：
 *
 * 1. 设置页弹窗打开后整块躲到工作台面板后面：`elementsFromPoint` 在弹窗中心
 *    命中的是 `.wb-nav` / `.wb-plan-scroll` 等**面板内容**，而不是弹窗自己；
 * 2. AI 执行弹窗里展开模型选择器，列表排在弹窗与面板之下，无法选择。
 *
 * （同一类结构问题在宿主仓库也被报过：deepseek-ai/deepseek-harness#6440，
 * 其建议 b 正是「让对话框类浮层走宿主自己的 overlay 层渲染」。）
 *
 * ## 为什么挂 overlay 层才是对症的修法
 *
 * 挂进 `[data-shell-overlay]` 之后，浮层与面板回到**同一个**层叠上下文，
 * 各自的 z-index（55 / 300 / 329 / 330）恢复互相可比 —— 一行数字都不用改。
 * 代价是必须正视两点，分别在这里与 `styles.ts` 处理：
 *
 * - 该层是 `pointer-events: none` 的纯覆盖容器：挂在它下面的浮层**必须自己声明
 *   `pointer-events: auto`**，否则"看得见、点不动"（面板容器与 `.wb-app-scope`
 *   早已按这套规矩成对书写）；
 * - 拿不到该容器（宿主太旧 / 改名 / 那一瞬被摘掉 / 它自带 transform 或 filter
 *   会改写 `position: fixed` 的包含块）时**退回 `document.body`** —— 等于修复前的
 *   行为，不会更糟。兜底值选"最坏情况可接受"的那个（规范第 9 条）。
 *
 * 判定全部放成纯函数（不 import React、不摸真 `document`，样式读取由调用方注入），
 * 因此能被 `node --test` 表驱动测住（规范第 2、3 条）。
 */

/** 宿主官方 overlay 层的属性钩子（宿主 AppFrame 渲染时带的 `data-shell-overlay`）。 */
export const SHELL_OVERLAY_SELECTOR = '[data-shell-overlay]'

/** 纯判定需要的最小文档接口：能按选择器找一个元素、并知道 body。 */
export interface DocumentLike {
  querySelector(selector: string): Element | null
  readonly body: Element
}

/** 注入的样式读取器：拿不到样式时返回 `null`（当作"无信息"，不否决挂载）。 */
export type StyleReader = (element: Element) => Record<string, string> | null

/**
 * 会让 `position: fixed` 后代改以该元素为包含块的属性 —— overlay 层若自带这些，
 * 浮层里按视口算出来的 `left/top`（见 `popoverPlacement.ts`）会整体错位，
 * 那种情况下退回 body 比挂上去更好。
 */
const CONTAINING_BLOCK_PROPERTIES = ['transform', 'translate', 'scale', 'rotate', 'filter', 'backdropFilter', 'perspective', 'willChange', 'contain'] as const

const isNoneish = (value: string | undefined): boolean =>
  value === undefined || value === '' || value === 'none' || value === 'auto' || value === 'normal'

/**
 * 这个 overlay 容器**能不能**当浮层的挂载点。
 *
 * 三条判据，任一不成立就退回 body：
 * 1. 节点仍在文档里（宿主重渲染中途可能已把它摘掉 —— 挂到游离节点会让浮层整个不可见）；
 * 2. 它不改写 fixed 后代的包含块（`readStyle` 给不出样式时跳过这条：宁可用，也不因
 *    "测不到"否决修复；这正是 `StyleReader` 允许返回 `null` 的理由）；
 * 3. 不要求它有 `pointer-events` —— 那条由我们自己的 CSS 兜住（见 `styles.ts` 的
 *    `SHELL_OVERLAY_LAYER_CSS`），因为宿主的值随时可能变。
 */
export function overlayIsUsableMount(element: Element | null, readStyle?: StyleReader): boolean {
  if (element == null) return false
  if (element.isConnected === false) return false
  if (readStyle == null) return true
  let style: Record<string, string> | null = null
  try {
    style = readStyle(element)
  } catch {
    return false // 读取器本身出错 → 保守：退回 body（等于修复前行为），不把异常冒进渲染
  }
  if (style == null) return true // 明确"读不到样式" = 没有信息，不因此否决修复
  return CONTAINING_BLOCK_PROPERTIES.every((property) => isNoneish(style![property]))
}

/** 当前文档里可用的 overlay 层；`null` 表示"该退回 body"。 */
export function resolveOverlayMount(doc: DocumentLike | null | undefined, readStyle?: StyleReader): Element | null {
  if (doc == null) return null
  let hit: Element | null = null
  try {
    hit = doc.querySelector(SHELL_OVERLAY_SELECTOR)
  } catch {
    return null
  }
  return overlayIsUsableMount(hit, readStyle) ? hit : null
}

/** 挂载值：有 overlay 层就用它，否则用 body。 */
export function overlayMountOrBody(doc: DocumentLike, readStyle?: StyleReader): Element {
  return resolveOverlayMount(doc, readStyle) ?? doc.body
}

/**
 * 组件里 `createPortal(node, …)` 的第二参。
 *
 * SSR（`node --test` 里的 `renderToStaticMarkup`）没有 `document`，返回 `null` ——
 * 调用点本来就带 `typeof document === 'undefined'` 守卫，不会走到用这个值的那支。
 */
export function overlayMountContainer(): Element | null {
  if (typeof document === 'undefined') return null
  const readStyle: StyleReader = (element) => {
    if (typeof window === 'undefined' || typeof window.getComputedStyle != 'function') return null
    try {
      const computed = window.getComputedStyle(element) as unknown as Record<string, string>
      return {
        transform: computed.transform,
        translate: computed.translate,
        scale: computed.scale,
        rotate: computed.rotate,
        filter: computed.filter,
        backdropFilter: computed.backdropFilter,
        perspective: computed.perspective,
        willChange: computed.willChange,
        contain: computed.contain,
      }
    } catch {
      return null
    }
  }
  return overlayMountOrBody(document as unknown as DocumentLike, readStyle)
}
