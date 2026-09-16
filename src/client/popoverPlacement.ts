/**
 * 浮层放置算法（v1.15.2 修「快速录入 → 模型选择框被遮挡」）。
 *
 * ## 这个真 bug 是什么（2026-09-15 用户截图）
 *
 * 模型选择器原来用 `.wb-model-menu { position: absolute; left: 0;
 * bottom: calc(100% + 4px) }`，挂在触发按钮的 `position: relative` 包装盒里 ——
 * 而那个包装盒在 `.wb-dialog-body { overflow: auto }` **里面**，于是：
 *
 * 1. 浮层只会**朝上**开，且不看还有多少地方可用：触发按钮上方只有 ~130px
 *    （弹窗高度是内容撑开的 ~396px，按钮在中下部），而菜单内容 ~262–360px，
 *    多出来的部分被 `.wb-dialog-body` 的滚动容器**裁掉**（实测常见窗口下
 *    只有 48% 可见、窗口小一点时连视口外都有）；
 * 2. 被裁掉的是**最上面**几条 —— 「跟随 DSH 默认模型」和前几个模型正好在那里，
 *    也就是"想选的看不见、看见的盖住了输入框"；
 * 3. `z-index` 与层叠上下文**不是**成因（浮层本来就画在文字上面），
 *    是纯粹的"父容器 overflow 裁剪 + 没做翻转/收敛"。
 *
 * ## 修法为什么是"portal + fixed + 这个纯函数"
 *
 * 光调 `bottom`/`max-height` 治不了根：只要浮层还挂在滚动容器里，
 * 容器就会继续裁它，而且容器一滚浮层就跟着动。所以：
 * - **portal 到 `document.body`**（`.wb-dialog` 有 `overflow: hidden`、
 *   `.wb-overlay` 有 `backdrop-filter`，两者都会裁/影响 fixed 定位）；
 * - `position: fixed` + 每次滚动/改尺寸**重算**位置（第 6 条规矩：依赖运行时量取值的地方要有重试与重算路径）；
 * - 摆放规则抽成本文件 —— **不 import React、不碰 DOM**，可被 `node --test` 直接测。
 *
 * 判定表（`fits` 指"整块菜单放得下"）：
 *
 * | 上方放得下 | 下方放得下 | 结果 |
 * |---|---|---|
 * | 是 | 是 | `top`（保持原方向，用户视觉习惯不变） |
 * | 否 | 是 | `bottom`（**翻转**，这是原来缺的那一步） |
 * | 否 | 否 | 选空间大的一侧，并把高度**收敛**到该侧可用高度（宁可菜单变矮可滚动，也不越出可视区） |
 *
 * 宽度与水平位置同理收敛：菜单比视口还宽时收窄，贴右边界时向左挪，
 * 左右各留 `margin`，保证 `left ≥ margin` 且 `left + width ≤ viewport.width - margin`。
 */

/** 触发元素在视口坐标系里的矩形（只用到这几条边，便于单测直接构造）。 */
export interface PopoverAnchor {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

/** 浮层期望的尺寸（高度传"内容自然高度"，由算法决定是否收敛）。 */
export interface PopoverMenuSize {
  readonly width: number
  readonly height: number
}

/** 视口尺寸。 */
export interface PopoverViewport {
  readonly width: number
  readonly height: number
}

/** 摆放结果：直接写进浮层的 inline style。 */
export interface PopoverPlacement {
  /** `top` = 开在触发元素上方；`bottom` = 翻转开在下方。 */
  readonly side: 'top' | 'bottom'
  readonly left: number
  readonly top: number
  readonly width: number
  /** 高度上限：菜单自己的 `max-height`（超过就内部滚动）。 */
  readonly maxHeight: number
  /** 按 `maxHeight` 收敛后的实际高度（用于把 `top` 算准）。 */
  readonly height: number
}

/** 浮层与触发元素之间的间距。 */
export const POPOVER_GAP = 6
/** 浮层与视口边缘之间至少留出的间距。 */
export const POPOVER_MARGIN = 8

/**
 * 算出浮层该放在哪儿。
 *
 * **保证**（下面每条都有单测）：`left ≥ margin`、`left + width ≤ viewport.width - margin`、
 * `top ≥ margin`、`top + height ≤ viewport.height - margin`、`height ≤ menu.height`、
 * 输出永远是有限数。视口极端小（可用高度为 0）时会退化成高度 0 —— 这是"宁可不显示也不越出可视区"
 * 的显式选择，不会静默画到屏幕外。
 *
 * ⚠️ **高度必须同时受"视口"约束**（v1.15.2 复审补的）。第一版只按"锚点那一侧的空间"收敛，
 * 而锚点自己可以在视口外：实测过的几何是 `anchor.top = -94`、视口 1000x400、菜单自然高 450 ——
 * 那时 `side=bottom` 侧的"可用空间"有 445px，比整个视口（去掉上下边距只剩 384px）还大，
 * 于是盒子下沿跑到视口外 53px；而打开「快速录入」弹窗时 `Modal` 会把 `body` 锁成
 * `overflow: hidden`，这 53px 内容**没有任何办法滚到**。少了这一条，上面那句保证就是假的。
 */
export function placePopover(input: {
  readonly anchor: PopoverAnchor
  readonly menu: PopoverMenuSize
  readonly viewport: PopoverViewport
  readonly gap?: number
  readonly margin?: number
}): PopoverPlacement {
  const gap = finite(input.gap ?? POPOVER_GAP, POPOVER_GAP)
  const margin = Math.max(0, finite(input.margin ?? POPOVER_MARGIN, POPOVER_MARGIN))
  const viewportWidth = Math.max(0, finite(input.viewport.width, 0))
  const viewportHeight = Math.max(0, finite(input.viewport.height, 0))
  const menuWidth = Math.max(0, finite(input.menu.width, 0))
  const menuHeight = Math.max(0, finite(input.menu.height, 0))
  const anchorTop = finite(input.anchor.top, 0)
  const anchorBottom = finite(input.anchor.bottom, anchorTop)
  const anchorLeft = finite(input.anchor.left, 0)

  const width = Math.max(0, Math.min(menuWidth, viewportWidth - margin * 2))
  // 贴右边界时向左挪；`max(margin, …)` 保证窗口比"菜单 + 两侧边距"还窄时仍从 margin 起
  const left = Math.min(Math.max(anchorLeft, margin), Math.max(margin, viewportWidth - margin - width))

  const spaceAbove = Math.max(0, anchorTop - gap - margin)
  const spaceBelow = Math.max(0, viewportHeight - anchorBottom - gap - margin)
  const fitsAbove = spaceAbove >= menuHeight
  const fitsBelow = spaceBelow >= menuHeight
  const side: 'top' | 'bottom' = fitsAbove
    ? 'top'
    : fitsBelow
      ? 'bottom'
      : (spaceAbove >= spaceBelow ? 'top' : 'bottom')

  /** 三个上限里最小的那个：菜单自然高、该侧可用空间、**视口本身**。 */
  const height = Math.max(0, Math.min(menuHeight, side === 'top' ? spaceAbove : spaceBelow, viewportHeight - margin * 2))
  const top = side === 'top' ? anchorTop - gap - height : anchorBottom + gap
  /**
   * 最后一道收敛：触发元素**自己就在视口外**时（弹窗被拖出可视区、或测量发生在滚动中途，
   * 实测 1000x400 且弹窗滚动过时按钮顶边被顶到 -94px），按锚点算出来的位置会贴着视口外面。
   * 这里统一把盒子夹回 `[margin, viewport - margin - height]`：
   * 菜单因此可能"不再紧贴按钮"，但那比"半个菜单在屏幕外"可接受得多 ——
   * 也正是本项目第 9 条讲的"兜底值选最坏情况可接受的那个"。
   */
  const maxTop = Math.max(margin, viewportHeight - margin - height)
  return {
    side,
    left,
    top: Math.min(Math.max(top, margin), maxTop),
    width,
    maxHeight: height,
    height,
  }
}

/**
 * 非有限输入（`NaN` / `Infinity` / `undefined`）一律按兜底值处理。
 *
 * 为什么纯函数也要守：这个函数的返回值会**直接写进 DOM 定位**，
 * 一个 `NaN` 会让浮层跳到视口左上角或整块消失，而调用点（量 `getBoundingClientRect`）
 * 在某些时刻**确实可能量不到**（元素还没上树、宿主没渲染完）。
 * 与其把 `NaN` 传染给样式，不如给一个"最坏情况可接受"的确定值。
 */
function finite(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 两次摆放结果是否一致 —— 用来避免**同值重复写状态**。
 *
 * 为什么必须有它：摆放是"量 DOM → 写状态 → 再渲染"的回路，
 * 每次 setState 都会再触发一次 layout effect；没有相等判断就会自激
 * （本项目第 6 条规矩的实证：同值也会让观察器回路不收敛）。
 */
export function samePlacement(a: PopoverPlacement, b: PopoverPlacement): boolean {
  return a.side === b.side && a.left === b.left && a.top === b.top
    && a.width === b.width && a.maxHeight === b.maxHeight
}

/**
 * 方向键在选项列表里的落点（roving focus 的纯逻辑部分）。
 *
 * - `current = -1` 表示"焦点还在触发按钮上"：`delta > 0` 落到第一项，`delta < 0` 落到最后一项；
 * - 到边界就**停住**（不环绕）：列表框里"到底了"比"跳回另一端"更可预期；
 * - `count = 0` 返回 `-1`（没有可聚焦的目标）。
 */
export function stepIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : count - 1
  const next = current + delta
  if (next < 0) return 0
  if (next > count - 1) return count - 1
  return next
}
