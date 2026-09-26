/**
 * 面板位置的两处**几何测量**（左边界 = 侧栏宽度；上边界 = 桌面壳标题栏高度）。
 *
 * ## 为什么单独一个模块（DSH 0.1.7-rc.2 桌面端真实事故，2026-09-26）
 *
 * 两个现象、同一个根因类别：**面板的定位参数是从宿主 DOM 上量出来的，
 * 而宿主的 DOM 形状在 rc2 变了**。
 *
 * | 现象 | 原因 |
 * |---|---|
 * | 顶部压住桌面端标题栏、标题点不动 | rc2 桌面壳在 `<html>` 上加 `data-windows-titlebar`，给 frame 加了 `padding-top: var(--dsh-windows-titlebar-height)` 与一条 `-webkit-app-region: drag` 的标题栏。面板是 `position:fixed; top:0`（不跟着那个 padding 走）→ 直接盖在标题栏上 |
 * | 收起侧栏后左边界还是 280px、铺不满 | 旧实现把"量到的宽度"当成**增量**：`width<=0` 就 `return`（不更新），于是侧栏收到 0 之后变量永远停在收起前的旧值 |
 *
 * 所以这里把测量拆成两个**纯函数**：输入是显式快照，输出是"该写进 CSS 变量的值"，
 * 由 `index.tsx` 负责取几何、写变量。纯函数可被 `node --test` 直接测
 * （见 `test/panelGeometry.test.mjs`），不用起浏览器。
 *
 * ## 两条判据的取值口径（都是"宁可偏一点，也不能盖住别人"）
 */

/** 侧栏宽度快照。`sidebarColumnExists` = 找到了候选元素；`width` = 它的像素宽（可能为 0）。 */
export interface SidebarWidthSnapshot {
  /** 侧栏容器存在吗？找不到时**不写变量**（保持上一次的值，仍好过写 0）。 */
  exists: boolean
  /** 量到的宽度（px）。0 在 rc2 上是**合法值**（侧栏收起时栏目宽度就是 0）。 */
  width: number
  /**
   * 宿主自己公布的侧栏宽度（rc2 把 `--dsh-windows-sidebar-width` 写在 frame 上）。
   * 几何量不到时用它判"是否收起"。
   */
  declaredWidth: number | null
  viewportWidth: number
}

/** 侧栏宽度判定结果。`width === null` = 不更新变量。 */
export interface SidebarWidthDecision {
  width: number | null
  because: string
}

/**
 * 侧栏宽度 → `--wb-sidebar-w`。
 *
 * 判据顺序（每一档都写进 `because`，面板出问题时能直接从 console 看出是哪一档）：
 *
 * 1. 元素都找不到 → 不更新（保住上一次的值：**兜底 280px 偏一点，也远好过 0px 盖住侧栏**）；
 * 2. 宿主公布了宽度 → **直接采信**（这是宿主自己的权威值，侧栏收起时就是 0）；
 * 3. 几何量到 ≤0 → 采信 0（rc2 收起侧栏就是"栏目宽度 0"；负数是量取异常，也归一成 0）；
 * 4. 宽度超过视口 40% → 说明选中的元素根本不是侧栏（例如命中了整列的类名）→ 不更新；
 * 5. 其余 → 用几何值。
 *
 * ⚠️ 这一条**推翻了 v1.14.21 的旧口径**（旧：`width<=0` 一律 return）。旧口径在
 * rc2 上的后果正是"收起侧栏后铺不满"：0 被判成"量取失败"，于是变量永远停在旧值。
 */
export function decideSidebarWidth(snapshot: SidebarWidthSnapshot): SidebarWidthDecision {
  if (!snapshot.exists) return { width: null, because: '找不到侧栏容器（保留上一次的值）' }
  if (snapshot.declaredWidth !== null && Number.isFinite(snapshot.declaredWidth)) {
    const declared = Math.max(0, Math.round(snapshot.declaredWidth))
    return { width: declared, because: `采信宿主公布的侧栏宽度 ${declared}px` }
  }
  const maxReasonable = snapshot.viewportWidth > 0 ? snapshot.viewportWidth * 0.4 : Number.POSITIVE_INFINITY
  if (!Number.isFinite(snapshot.width)) return { width: null, because: '量到的宽度不是有限数（保留上一次的值）' }
  const measured = Math.round(snapshot.width)
  if (measured <= 0) return { width: 0, because: '侧栏栏目宽度为 0（收起状态）' }
  if (measured > maxReasonable) return { width: null, because: `量到 ${measured}px 超过视口 40%，判定为量错了元素（保留上一次的值）` }
  return { width: measured, because: `几何量到侧栏宽度 ${measured}px` }
}

/** 桌面壳标题栏快照。 */
export interface TitlebarSnapshot {
  /** frame 上有没有 `data-windows-titlebar`（rc2 桌面壳才会加）。 */
  attributePresent: boolean
  /** frame 的计算样式里 `padding-top` 的像素值（没标记时通常是 0）。 */
  framePaddingTop: number
  /**
   * `--dsh-windows-titlebar-height` 的**计算后**取值（px）。
   * 宿主用它给 frame 加 padding，所以它就是权威高度；`null` = 取不到。
   */
  declaredHeight: number | null
}

/** 面板上边界判定结果。 */
export interface TopInsetDecision {
  /** 写进 `--wb-top-inset` 的像素值。 */
  inset: number
  because: string
}

/**
 * 从一批同名候选元素里挑出"真正的宿主 frame"。
 *
 * 为什么需要它：DSH 的布局类名带构建期 hash（`ZTP-Xa_frame`），只能按子串
 * `[class*="frame"]` 找 —— 而**别的组件也可能带这个子串**（同一份 CSS module 里的
 * 其它类、或第三方壳）。挑错的后果不是崩溃，而是"量不到值 → 静默退回兜底"，
 * 也就是标题栏让位/侧栏宽度都用不上真值。
 *
 * 判据：**谁真的让出了顶部空间**谁就是 frame（rc2 给 frame 加
 * `padding-top: var(--dsh-windows-titlebar-height)`）。全部为 0 时退回第一个候选 ——
 * 网页版上本来就该是 0，取谁都一样。
 *
 * @param candidates 候选元素的 `padding-top` 像素值（顺序与文档顺序一致）
 * @returns 选中的下标；`candidates` 为空时返回 -1
 */
export function pickFrameCandidate(candidates: readonly number[]): number {
  if (candidates.length === 0) return -1
  let best = 0
  for (let i = 1; i < candidates.length; i++) {
    const current = Number.isFinite(candidates[i]) ? candidates[i] : 0
    const bestSoFar = Number.isFinite(candidates[best]) ? candidates[best] : 0
    if (current > bestSoFar) best = i
  }
  return best
}

/**
 * 桌面壳标题栏高度 → 面板上边界 `--wb-top-inset`。
 *
 * 判据顺序：
 * 1. 没有 `data-windows-titlebar` → 0（普通网页版 / macOS / 老宿主都走这条，**零影响**）；
 * 2. `padding-top` 量到 >0 → 用它（最贴事实：那正是宿主给内容区让出的高度）；
 * 3. 否则用宿主公布的变量值；
 * 4. 都取不到再退到 32px —— 与 dsh-better-sidebar 对"Electron 无 WCO 窗口"的既有取值一致
 *    （宁可多让 32px 出一条空带，也不能把标题栏压住导致点不动）。
 */
export function decideTopInset(snapshot: TitlebarSnapshot): TopInsetDecision {
  if (!snapshot.attributePresent) return { inset: 0, because: '非桌面壳（无 data-windows-titlebar）' }
  const padding = snapshot.framePaddingTop
  if (Number.isFinite(padding) && padding > 0) {
    const inset = Math.round(padding)
    return { inset, because: `frame 的 padding-top = ${inset}px` }
  }
  const declared = snapshot.declaredHeight
  if (declared !== null && Number.isFinite(declared) && declared > 0) {
    const inset = Math.round(declared)
    return { inset, because: `采信 --dsh-windows-titlebar-height = ${inset}px` }
  }
  return { inset: 32, because: '桌面壳但量不到高度，按 Windows 无 WCO 标题栏 32px 让位' }
}
