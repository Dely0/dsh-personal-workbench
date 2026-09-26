/**
 * **宿主（DSH 桌面壳）自己拥有**的 DOM 标记 —— 我们只读，绝不写。
 *
 * ## 为什么单独一个模块，而不是塞进 `constants.ts`
 *
 * `constants.ts` 的不变量（I4）是"**这个文件里声明的每个 `*_ATTR` 都必须以
 * `data-dsh-personal-workbench-` 为前缀**"—— 那是"我们写进宿主根元素的东西必须自用、
 * 绝不与别的插件撞名"这条政策的载体（见 `test/clientInvariants.test.mjs`）。
 *
 * 而这里两个标记属于**宿主**：`data-windows-titlebar` 是 DSH 桌面壳加的，
 * `data-sidebar-collapsed` 是宿主布局加的。我们只是**读**它们来决定面板几何。
 * 把它们混进 `constants.ts` 会逼着我们放宽那条前缀政策 —— 那等于用一个真政策
 * 换一点文件整洁，不划算。所以换成"另一个模块 + 扫描时显式排除"，
 * 并让排除本身也被断言（下面那两条），这样"新增宿主标记"仍然要过一次脑子。
 */

/**
 * DSH 桌面壳的标题栏标记（0.1.7-rc.2 起加在 `<html>` 上）。
 *
 * 它同时给 frame 加了 `padding-top: var(--dsh-windows-titlebar-height)` 与一条
 * `-webkit-app-region: drag` 的标题栏（窗口按钮就在那条带子里）。
 * 工作台面板挂在 `shell.overlay` 下、自己 `position:fixed`，**不跟着那个 padding 走**，
 * 所以必须读它给面板让位（`--wb-top-inset`），否则面板压住标题栏、窗口按钮点不动。
 *
 * 普通网页版 / macOS / 老宿主没有这个属性 → 让位值 0，行为与改动前完全一致。
 */
export const HOST_WINDOWS_TITLEBAR_ATTR = 'data-windows-titlebar'

/**
 * 宿主布局的"侧栏已收起"标记（DSH 0.1.7-rc.2）。
 *
 * 收起/展开是**属性变化**而不是元素替换，几何还要走 300ms 过渡 ——
 * 所以除了观察侧栏列自身的尺寸，还要盯这个属性：属性一变就按宿主公布的宽度
 * 同步面板左边界（判据见 `panelGeometry.ts` 的 `decideSidebarWidth`）。
 */
export const HOST_SIDEBAR_COLLAPSED_ATTR = 'data-sidebar-collapsed'

/**
 * 宿主公布侧栏宽度的 CSS 变量名（rc2 把它写在 frame 的内联样式上，值形如 `280px`）。
 * 它是"栏目宽度"的**权威值**：侧栏收起时就是 `0px`。
 */
export const HOST_SIDEBAR_WIDTH_VAR = '--dsh-windows-sidebar-width'

/** 宿主公布标题栏高度的 CSS 变量名。 */
export const HOST_TITLEBAR_HEIGHT_VAR = '--dsh-windows-titlebar-height'
