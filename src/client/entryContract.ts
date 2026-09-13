/**
 * 侧栏入口的「家族契约」——上游目前没有官方 sidebar 导航 slot，第三方侧栏插件
 * （dsh-ssh / dsh-client-ui-task-board / dsh-client-ui-skill-explorer / dsh-mnemon）
 * 之间靠一套约定互相识别，本模块把本插件要遵守的那部分单独收在一处，
 * 便于测试锁住不变量，也避免各文件各写一份选择器字符串。
 *
 * 参考实现：`@linxin666/dsh-ssh` 的 `src/client/sidebar-entry-core.ts`（createEntry/placeEntry）。
 * 语义属性契约：`@linxin666/dsh-client-ui-skin-center` 的 `contracts/semantic-attrs-v1.md`。
 *
 * 约定内容：
 * 1. 行元素带 `data-dsh-<pkg>-entry`，并输出 `data-dsh-plugin` + `data-dsh-part="sidebar-entry"`
 *    （皮肤中心按后者锚定侧栏入口行；owner 是 family，但组件主动输出更准更快）；
 * 2. 行内结构固定为「图标槽 + 文案」（`entryIcon` / `entryLabel`），并给出
 *    `aria-label` + `title`（折叠态没有文案时仍可读、可 tooltip）；
 * 3. 激活态走行上的 `data-active`；
 * 4. 折叠态不认死 `[data-sidebar-collapsed]` 祖先是否带 `[data-dsh-frame]`
 *    （DSH 0.1.5 的 frame 元素没有 `data-dsh-frame`，见 matchesCollapsedClass 的注释）。
 *
 * ## v1.14.0：官方槽位优先，这套契约退为**降级腿**
 *
 * DSH 0.1.5-rc.1 提供了官方 `sidebar.panellist`（kind=list、scope=root）与 `main`
 * （kind=keyed、scope=root）槽位。走官方路径时：
 * - 行按钮、Tooltip、`aria-label`/`aria-current="page"`、行高与折叠态圆形都由宿主
 *   `PanelRow` 渲染，本插件只提供图标；
 * - 互斥由宿主的 `activePanelId`（**单值**状态）保证，不再需要上面第 1 条的属性约定、
 *   也不需要摘兄弟插件的 `*-active`。
 *
 * 但**上面这套契约不删**：撑不起官方槽位的宿主（如 DSH 0.1.1-rc.1）仍然存在，
 * 那些机器上 DOM 注入是唯一可用的入口。两条路径的选择由
 * `officialSlotDecision()` 决定（纯函数，可单测）。
 */

import { ACTIVE_ATTR, PANEL_NAME } from './constants.js'

/** 语义属性 `data-dsh-plugin` 的值：用插件名，而不是包名。 */
export const ENTRY_PLUGIN_ID = PANEL_NAME

/** 行元素自身的家族标识：`data-dsh-<pkg>-entry`。 */
export const ENTRY_ATTR = 'data-dsh-personal-workbench-entry'

/** 皮肤中心锚定侧栏入口行用的语义属性。 */
export const ENTRY_PLUGIN_ATTR = 'data-dsh-plugin'
export const ENTRY_PART_ATTR = 'data-dsh-part'
export const ENTRY_PART_VALUE = 'sidebar-entry'

/** 行内结构与类名（家族统一：行 / 图标槽 / 文案）。 */
export const ENTRY_CLASS = 'dshWorkbench_entry'
export const ENTRY_ICON_CLASS = 'dshWorkbench_entryIcon'
export const ENTRY_LABEL_CLASS = 'dshWorkbench_entryLabel'

/** 无障碍：折叠态没有可见文案，所以 title / aria-label 必须由行本身给出。 */
export const ENTRY_LABEL_TEXT = '工作台'
export const ENTRY_TITLE = '打开工作台（任务 / 日历 / 知识库 / 点子）'

/**
 * 图标几何：图标槽固定 24px，图标 18px（折叠态 20px），stroke 1.5。
 * 与家族同排入口一致（`aria-hidden`，语义由行上的 aria-label 承担）。
 */
export const ENTRY_ICON_VIEWBOX = '0 0 18 18'

/** 行图标（日历 + 勾选），与原有视觉一致，仅换取尺寸与描边。 */
export const ENTRY_ICON_SVG = '<svg aria-hidden="true" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5">'
  + '<rect x="2.25" y="3.75" width="13.5" height="12" rx="2.25"/>'
  + '<path d="M2.25 7.5h13.5M6 2.25v3M12 2.25v3"/>'
  + '<path d="M6.75 11.25l1.75 1.75 3.25-3.5"/></svg>'

/** 行结构（家族三段式）：图标槽 + 文案槽。 */
export const ENTRY_HTML = `<span class="${ENTRY_ICON_CLASS}">${ENTRY_ICON_SVG}</span>`
  + `<span class="${ENTRY_LABEL_CLASS}">${ENTRY_LABEL_TEXT}</span>`

/** 宿主 frame 的折叠标记（`dsh-client-ui-layout` 写在 frame 元素上）。 */
export const SIDEBAR_COLLAPSED_ATTR = 'data-sidebar-collapsed'

/**
 * 宿主官方侧栏面板行（`sidebar.panellist` 里那一行的 `PanelRow`）的可见性判定。
 *
 * ## 为什么必须有它（2026-09-13 实测）
 *
 * 官方行**不是** `<button>` + 短文案：宿主 `PanelRow` 把注册时给的 `label`
 * 同时写进 `textContent`、`aria-label` 和 tooltip。实测 DOM：
 *
 * ```html
 * <button class="hHd-Xa_panelRow" aria-label="打开工作台（任务 / 日历 / 知识库 / 点子）">
 *   打开工作台（任务 / 日历 / 知识库 / 点子）
 * </button>
 * ```
 *
 * 而旧判定查的是 `textContent === '工作台'`（`ENTRY_LABEL_TEXT`）——
 * 那条**永远不命中**（宿主写的是长文案 `ENTRY_TITLE`），于是"官方行可见就藏起自己"
 * 从不生效，侧栏稳定出现**两行**「工作台」入口（用户多次反馈的现象）。
 *
 * 顺带印证了交接文档第 8 节第 3 条：**标签长短必须分清**。
 * 这里统一按 `aria-label` 认（`textContent` 只作兜底），并且用 `ENTRY_ATTR` 排除
 * 我们自己的行 —— 两条腿的行取的都是同一个 `ENTRY_TITLE`，只能靠属性区分身份。
 *
 * @param root - 查询起点（通常是 `document`）。
 * @returns 宿主渲染的官方行**可见**时为 true。
 */
export function hostPanelRowVisible(root: ParentNode): boolean {
  let rows: Element[]
  try {
    rows = Array.from(root.querySelectorAll(`button[aria-label="${ENTRY_TITLE.replace(/"/g, '\\"')}"]`))
  } catch { return false }
  for (const row of rows) {
    // 自己的行不算（我们注入的行属性在 ENTRY_ATTR 上）
    if (row.hasAttribute(ENTRY_ATTR)) continue
    const element = row as HTMLElement
    try {
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      if (element.getBoundingClientRect().width <= 0) continue
    } catch { continue }
    return true
  }
  return false
}

/**
 * 兄弟插件的面板**视图容器**是否已经挂上（`[data-dsh-*-view]`）。
 *
 * ⚠️ **这不是"对方面板正开着"的判据，绝不要拿它做门控**（v1.14.45 实测，差点写错）。
 *
 * task-board 的容器是**常驻**的：`panel-mount-core.ensure()` 把容器永久挂在会话列里
 * （`[class*="centerCol"]` 的尾部子节点，React 不管它），显隐完全由
 * `<html data-dsh-taskboard-active>` + 它自己的 CSS 决定。所以本函数在本机
 * **永远返回 true** —— 一旦拿它当"兄弟面板开着"，本插件就永远打不开。
 *
 * 唯一可信的判据是那个属性，见 `isSiblingPanelActive()`。
 * 本函数保留下来**只作诊断/自检**：确认对方容器确实存在，以及它有没有被谁的
 * 样式误伤（例如某次重构把 `data-dsh-taskboard-view` 丢了）。
 *
 * @param root - 通常是 `document`。
 * @returns 存在兄弟插件的面板视图容器时为 true（不代表它可见）。
 */
export function siblingPanelViewMounted(root: ParentNode): boolean {
  try {
    return root.querySelector('[data-dsh-taskboard-view], [data-dsh-ssh-view], [data-dsh-mnemon-view]') !== null
  } catch { return false }
}

/**
 * 打开本插件面板前，把兄弟插件的「正在选中」状态收起来。
 *
 * 这是 task-board / ssh 之间早就存在的家族习俗（可直接读源码核对）：
 * task-board 的 `panel-mount-core.applyActive()` 在打开时执行
 * `documentElement.removeAttribute(siblingActiveAttribute)`，
 * 再 `setAttribute(自己的 active)`，最后广播 `dsh-panel-activate`。
 *
 * ## 为什么官方路径也要做（2026-09-13）
 *
 * 官方路径的唯一开关是宿主的 `selectPanel`，宿主只维护自己的 `activePanelId` ——
 * 它**不认识** task-board（后者不走槽位）。于是用户实测："taskboard 和工作台的入口
 * 的点击没有做到互斥（两个都可以同时被选中）"。
 *
 * 本函数只做 task-board 自己也会被别人做的那两件事（摘 root 属性 + 广播），
 * **不碰对方的 control 状态**（不去猜/改别人的 store），因此最坏情况也只是
 * "对方视图被 CSS 隐藏、其控制状态未同步" —— 不会弄坏对方功能。
 *
 * @param siblingActive - `isSiblingActiveAttribute`（判定只有一份实现）。
 * @param panelName - 本插件面板名（广播 detail）。
 * @param activateEvent - 跨插件激活事件名。
 * @returns 被摘掉的属性名列表（便于日志与测试）。
 */
export function retractSiblingPanelMarks(
  root: HTMLElement,
  siblingActive: (attributeName: string) => boolean,
  panelName: string,
  activateEvent: string,
): string[] {
  const removed: string[] = []
  for (const attributeName of root.getAttributeNames()) {
    if (!siblingActive(attributeName)) continue
    root.removeAttribute(attributeName)
    removed.push(attributeName)
  }
  try {
    root.ownerDocument.dispatchEvent(new CustomEvent(activateEvent, { detail: panelName }))
  } catch { /* 广播失败不影响互斥的 DOM 部分 */ }
  return removed
}

/** `[data-dsh-<pkg>-active]`：第三方侧栏插件在 documentElement 上挂的面板激活标记。 */
const SIBLING_ACTIVE_PREFIX = 'data-dsh-'
const SIBLING_ACTIVE_SUFFIX = '-active'

/**
 * 符合 `data-dsh-*-active` 格式、但**与面板互斥无关**的属性：一律不碰。
 *
 * 全是实测得来（2026-09-13 皮肤失效事故）：
 * - `data-dsh-wallpaper-active` / `data-dsh-backdrop-active`：皮肤中心（skin-center）
 *   用来表示"当前壁纸/背景已激活"。本插件曾把它们当兄弟面板标记摘掉，
 *   导致「点开工作台后皮肤全局失效、回到会话也不恢复」。
 * - `data-dsh-personal-workbench-*`：本插件自己的其它标记，按格式虽不匹配
 *   （前缀后含 `personal-workbench`），这里仍显式列全，避免以后改名时误伤。
 */
const NON_PANEL_ACTIVE_ATTRIBUTES = new Set([
  'data-dsh-wallpaper-active',
  'data-dsh-backdrop-active',
])

/**
 * 判断一个属性名是不是「别的插件的面板激活标记」。
 *
 * 动态识别而不是维护一份包名清单：家族里每个成员都靠硬编码对方属性名做互斥，
 * 于是每新增一个兄弟插件（例如 dsh-mnemon）所有老插件都得改一遍，漏了就出现
 * 「两个面板同时打开、两个入口同时高亮」（issue #3 的现象 1）。按属性名格式识别
 * 就没有这个漏项问题。
 *
 * @param attributeName - 被观察到的属性名。
 * @returns 是别的插件的激活标记时为 true（本插件自己的标记不算）。
 */
export function isSiblingActiveAttribute(attributeName: string): boolean {
  if (attributeName === ACTIVE_ATTR) return false
  if (!attributeName.startsWith(SIBLING_ACTIVE_PREFIX)) return false
  const rest = attributeName.slice(SIBLING_ACTIVE_PREFIX.length)
  if (rest.length <= SIBLING_ACTIVE_SUFFIX.length || !rest.endsWith(SIBLING_ACTIVE_SUFFIX)) return false
  /**
   * ⚠️ **排除非面板用途的同名属性**（2026-09-13 真实事故）。
   *
   * 光看格式会误伤：皮肤中心把「壁纸/背景是否激活」也写成
   * `data-dsh-wallpaper-active` / `data-dsh-backdrop-active` —— 它们同样符合
   * `data-dsh-*-active`，于是被本插件当成"兄弟插件的面板激活标记"**整片摘掉**，
   * 用户表现是「点开工作台后皮肤全局失效、回到会话也不恢复」。
   *
   * 判定原则：**只摘我们确实知道语义的属性**。认不出用途的一律不动 ——
   * 漏摘最多是"两个面板同时开着"（可用性问题），误摘会把别人的功能弄坏（正确性问题）。
   */
  if (NON_PANEL_ACTIVE_ATTRIBUTES.has(attributeName)) return false
  return true
}

/**
 * 从 class 列表里认出宿主侧栏的折叠标记。
 *
 * DSH 的 CSS Module 类名带哈希（当前宿主是 `hHd-Xa_collapsed`，前缀会随构建变化），
 * 所以不能写死前缀，只能按「短前缀 + `_collapsed`」的形态认。宿主 **没有**
 * `data-dsh-frame` 这个属性，因此祖先判定不能用它（旧实现写成
 * `[data-dsh-frame][data-sidebar-collapsed] …`，在 0.1.5 上是永不命中的死代码）。
 *
 * @param classList - 元素的 class 列表。
 * @returns 命中折叠态时为 true。
 */
export function matchesCollapsedClass(classList: readonly string[]): boolean {
  for (const token of classList) {
    const separator = token.indexOf('_')
    if (separator <= 0 || separator !== token.length - '_collapsed'.length) continue
    if (token.slice(separator) !== '_collapsed') continue
    const prefix = token.slice(0, separator)
    if (!/^[A-Za-z][\w-]*$/.test(prefix)) continue
    return true
  }
  return false
}

/**
 * 判断当前是否有**别的**插件正开着面板（依据 documentElement 上的属性名列表）。
 *
 * 把判定挪到 JS 之后，互斥不再需要在 CSS 里逐个 `:not([data-dsh-xxx-active])`：
 * 每多一个兄弟插件就要改一次样式，漏了就是 issue #3 的现象 1（两个面板同时挂在
 * 会话列上、两个入口同时高亮）。JS 侧只认属性名格式，新增成员自动覆盖。
 *
 * @param attributeNames - 通常是 `document.documentElement` 的全部属性名。
 * @returns 存在别的插件的激活标记时为 true。
 */
export function isSiblingPanelActive(attributeNames: readonly string[]): boolean {
  return attributeNames.some((name) => isSiblingActiveAttribute(name))
}

/**
 * 面板显示门控用的标记：置上时说明「有别的插件面板开着」，本插件自己的面板让位。
 *
 * 只对「面板已经打开之后、别人又把面板打开」这个时序有意义——那种情况不会触发
 * 本插件的 `dsh-panel-activate` 监听（对方没广播），也没有点击事件可听，只能靠
 * MutationObserver 观察属性变化。
 */
export const BLOCKED_ATTR = 'data-dsh-personal-workbench-blocked'

/**
 * 家族入口行的通用选择器：`[data-dsh-<pkg>-entry]` 或带了语义属性的行。
 *
 * 用它替代「逐个列举兄弟包名」（旧实现是
 * `[data-dsh-taskboard-entry], [data-dsh-ssh-entry]`，因此漏掉了 dsh-mnemon）。
 */
export const SIDEBAR_ENTRY_SELECTOR = '[data-dsh-part="sidebar-entry"], [data-dsh-plugin], [data-dsh-personal-workbench-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-mnemon-entry]'

// ---------------------------------------------------------------------------
// 官方槽位路径的可用性判定（v1.14.0）
// ---------------------------------------------------------------------------

/** 官方侧栏面板图标槽位名（kind=list、scope=root；每个 list id 对应一个 main 面板 key）。 */
export const OFFICIAL_PANEL_LIST_SLOT = 'sidebar.panellist'

/** 官方中央面板槽位名（kind=keyed、scope=root；注册时 `key` 必填）。 */
export const OFFICIAL_MAIN_SLOT = 'main'

/**
 * 官方**框架级浮层**槽位（kind=list、scope=root，始终挂载）。
 *
 * 契约原文："Frame-wide floating layer, above every column and outside their scroll
 * containers. … The layer itself is click-through — entries opt back into pointer
 * events — so an occupant never blocks the app underneath."
 *
 * 为什么工作台主体挂在**这里**而不是 `main`（2026-09-15 定案）：
 * `main` 是**键槽**，`activePanelId` 一变宿主就卸载旧键、挂载新键。而我们的
 * `WorkbenchApp` 里除了面板还装着**待确认草稿弹框**：一旦放进 `main`，
 * 关掉面板 = App 卸载 = 弹框消失（用户实测"只能回到工作台页面才看得到弹框"），
 * 且每次开合都重建整棵树 —— 依赖 `useEffect` 拉数据的区块（今日容量）
 * 会在重建窗口里渲染成空壳。
 *
 * 挂在始终挂载的 `shell.overlay` 上，App 只挂一次，面板显隐由"是否被选中"决定，
 * 弹框跨页面常驻 —— 这才是它该有的生命周期。
 */
export const OFFICIAL_OVERLAY_SLOT = 'shell.overlay'

/** 注册到 `shell.overlay` 时用它判别槽位是否存在（缺失就回退 DOM 腿）。 */
export function overlaySlotAvailable(slots: unknown): boolean {
  const candidate = slots as { entriesOfSlot?: (name: string) => unknown } | undefined
  if (candidate === undefined || candidate === null || typeof candidate.entriesOfSlot !== 'function') return false
  try {
    candidate.entriesOfSlot.call(slots, OFFICIAL_OVERLAY_SLOT)
    return true
  } catch { return false }
}

export interface OfficialSlotDecision {
  /** true = 走官方槽位（侧栏入口 + main 面板）；false = 走 DOM 注入降级腿。 */
  useOfficial: boolean
  /** 不走官方路径时的人类可读原因（写日志用；为空串表示走官方路径）。 */
  reason: string
}

/**
 * 决定「官方槽位路径是否可用」。
 *
 * **三个硬条件**，缺一个才整体回退 DOM 腿：
 * 1. `slots` 服务存在且具备 `inject` / `register`；
 * 2. `slots.entriesOfSlot('sidebar.panellist')` 能正常执行 —— 说明宿主的侧栏确实声明了这个槽位；
 * 3. **`layout.selectPanel` 可用** —— 宿主侧栏的面板行真的能切换中央面板（v1.14.48 新增）。
 *
 * ## 为什么第 3 条是硬条件（2026-09-13 在**真实低版本宿主**上实测）
 *
 * 低版本 DSH（0.1.1-rc.1）上出现了这个组合：**`sidebar.panellist` 槽位存在，
 * 但 `ctx.layout` 上根本没有 `selectPanel`** —— 它的 `protoKeys` 只有
 * `[constructor, attachPanels, toggleSidebar, openDetails, closeDetails]`。
 *
 * 那条路径的后果是**最坏的一种**：我们判定"走官方"，注册进 `sidebar.panellist`，
 * 而宿主侧栏**没有能选中面板的机制**（点击面板行要调 `selectPanel`，它不存在）
 * → `activePanelId` 永远是 null → 面板**永远不显示**；
 * 而我们的自建入口行又被"官方行可见就隐藏自己"的规则藏起来了
 * → 用户现象就是"**低版本上工作台打不开**"。
 *
 * 所以判据不能是"槽位在不在"，而是"**宿主能不能真的把面板选中**"：
 * 官方路径的本质是把中央面板托付给宿主的 `activePanelId`，
 * 没有 `selectPanel` 就没有这个能力，必须走 DOM 腿。
 *
 * ## 与 v1.14.27 的历史结论不冲突
 *
 * 那次把 `selectPanel` 当硬条件，结果是**兄弟插件用 cordis 的 isolate/intercept
 * 把整个 layout 藏起来**时误判成"不支持"。区别在**判据的语义**：
 *   · 那次：`ctx.get('layout')` 拿到 **undefined** —— 信息不足，该照走官方；
 *   · 这次：拿到 layout 对象、且它**明确没有** `selectPanel` —— 确凿的无能力，必须回退。
 * 所以实现上只在"`layout` 非空但缺 `selectPanel`"时判失败；
 * `layout` 为 `undefined` 时**保持历史行为**（不因它改判）。
 *
 * **绝不因为探测失败而抛错**：任何异常都当作"不可用"（旧宿主上抛错是正常现象）。
 *
 * @param slots - 软探测到的槽位服务（形状不做假定，靠鸭子类型判断）。
 * @param layout - 软探测到的 layout 服务；缺 `selectPanel` 时判定不支持官方路径。
 * @returns 判定结果与原因。
 */
export function officialSlotDecision(
  slots: unknown,
  layout?: unknown,
): OfficialSlotDecision {
  if (slots === undefined || slots === null) return { useOfficial: false, reason: 'host has no slots service' }
  const candidate = slots as { inject?: unknown; register?: unknown; entriesOfSlot?: unknown }
  if (typeof candidate.inject !== 'function' || typeof candidate.register !== 'function') {
    return { useOfficial: false, reason: 'slots service lacks inject/register' }
  }
  if (typeof candidate.entriesOfSlot !== 'function') {
    return { useOfficial: false, reason: 'slots service has no entriesOfSlot (cannot confirm sidebar.panellist exists)' }
  }
  try {
    // **必须用 .call(slots) 绑回服务对象**：宿主服务的方法依赖实例字段，
    // 脱绑调用会抛 "Cannot read properties of undefined" —— 那会被误判成
    // "这个宿主没有 sidebar.panellist"，于是在明明支持官方槽位的机器上走了 DOM 腿。
    candidate.entriesOfSlot.call(slots, OFFICIAL_PANEL_LIST_SLOT)
  } catch (error) {
    return { useOfficial: false, reason: `sidebar.panellist unavailable: ${error instanceof Error ? error.message : String(error)}` }
  }
  /** 第 3 条：宿主必须真的能切换中央面板（见上方长注释）。 */
  if (layout !== undefined && layout !== null) {
    const layoutCandidate = layout as { selectPanel?: unknown }
    if (typeof layoutCandidate.selectPanel !== 'function') {
      return { useOfficial: false, reason: 'layout has no selectPanel (the host panel list cannot select a central panel, so the panel would never show)' }
    }
  }
  return { useOfficial: true, reason: '' }
}

/**
 * 复核「官方注册到底成没成」——**迁移后唯一可信的判据**。
 *
 * 为什么不能只信 `officialSlotDecision`：它只证明"宿主有这两个槽位"，
 * 不证明"我们注册进去了"。`slots.inject(name, cb)` 的语义是"等槽位出现再执行 cb"，
 * `register` 也可能抛错（我们已 catch）—— 任一环节失败都会只注册一半：
 * 侧栏没有入口、中央没有内容，而 `layout.selectPanel(id)` **可能仍然成功**
 * （宿主只校验 main 的注册键，不校验入口），于是会话列被让位、界面整片空白且回不去。
 * 这正是 2026-09-12 用户遇到的现象。
 *
 * 判据与宿主 `layout` 的 `hasMainPanel` 同一口径：查注册表里有没有我们的 key/id。
 *
 * @param slots - 槽位服务（鸭子类型）。
 * @param panelId - 本插件面板 id（同时是 main 的 key）。
 * @returns 入口与内容都注册到位时为 true。
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
 * 官方面板行是否**真的画到了页面上**（自愈判据的第二半）。
 *
 * 注册表里有条目 ≠ 侧栏渲染了那一行：宿主可能在槽位订阅之前就渲染完了，
 * 或者侧栏根组件还没挂载。所以自愈检查还要看一眼 DOM 里有没有那个行按钮。
 *
 * 宿主 `PanelRow` 输出的 button 带 `aria-label`（值取自我们注册的 label）
 * 与 `aria-current`，这里按 `aria-label` 精确匹配最稳（不依赖宿主 CSS Modules 的哈希类名）。
 *
 * @param root - 查询起点（通常是 document）。
 * @param label - 注册时给的 label（本插件是 `ENTRY_TITLE`）。
 */
export function officialPanelRowRendered(root: ParentNode, label: string): boolean {
  try {
    return root.querySelector(`button[aria-label="${label.replace(/"/g, '\\"')}"]`) !== null
  } catch { return false }
}

/**
 * 自愈判定的结论：官方路径是否**确认可用**。
 *
 * - `confirmed: true`  → 用官方槽位里的容器承载面板（迁移后的正路）；
 * - `confirmed: false` → 撤销官方注册、回退 DOM 腿（覆盖层承载面板）。
 *
 * 关键设计：**默认不可信**。只有注册表与 DOM 两侧同时有证据才算确认；
 * 任何不确定都回退降级腿 —— 降级腿是迁移前跑了很久的成熟路径，
 * 而"面板打不开 / 一片空白"是用户无法自救的故障。
 */
export function officialPathConfirmed(
  slots: unknown,
  panelId: string,
  root: ParentNode,
  label: string,
): { confirmed: boolean; reason: string } {
  if (!officialRegistrationComplete(slots, panelId)) {
    return { confirmed: false, reason: 'sidebar.panellist / main 注册表里查不到本插件条目' }
  }
  if (!officialPanelRowRendered(root, label)) {
    return { confirmed: false, reason: '宿主已登记但侧栏没有渲染出面板行' }
  }
  return { confirmed: true, reason: '' }
}

/**
 * 颜色令牌层（v1.14.5）—— 修的是"弹框打开后整屏纯黑"。
 *
 * ## 实测到的宿主行为（本机 DSH 0.1.5-rc.1，2026-09-12）
 *
 * | 节点 | `--dsw-alias-bg-base` | `--dsw-font-family` |
 * |---|---|---|
 * | `:root`(html) | **未定义** | 已定义 |
 * | `body` | `#fff` / 深色时 `#17171a` | 已定义 |
 * | 我们的 `.wb-panel-host`（在 body 层级的 portal 里） | **读不到** | 已定义 |
 *
 * 也就是：**别名令牌定义在 `body` 上**（`body{--dsw-alias-…}` + `data-ds-dark-theme`
 * 与深色分支），而字体族定义在 `:root`。我们的 Modal 通过 portal 挂在
 * `document.body` 的层级上，**别名令牌取不到**。
 * 而样式里到处是 `var(--dsw-alias-bg-base, #111)` —— 回退值是**写死的深黑**，
 * 于是浅色机器上出现"白底黑块"，深色机器上就是"整屏纯黑"（用户截图的实际现象）。
 *
 * 顺带解释了一个疑问：为什么"字体是对的、颜色是错的" —— 因为字体令牌在 `:root`、
 * 颜色令牌在 `body`，两者可见性不同。
 *
 * ## 解法
 *
 * 1. 把宿主令牌映射到自己的 `--wb-*`，回退值用 CSS 原生 **`light-dark()`**：
 *    浏览器按 `color-scheme` 自动选浅/深，不依赖宿主是否定义过该令牌，
 *    也不需要 JS 检测主题；
 * 2. `color-scheme` 用 `light dark` 作为**兜底默认**（放在 `:root`），
 *    但**加在 tokenLayerCss 的最前面**：宿主若自己设过 `color-scheme`（更具体的
 *    选择器或内联样式），会覆盖我们这一条，从而"跟随宿主"而不是"自作主张"。
 *
 * 于是"令牌缺失"退化成"跟随明暗"，而不再是"变成黑色"。
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
 * 令牌缺失时变回深黑 —— 正是这次事故的成因。没登记的令牌保持原样
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

/** 已登记的令牌名（单测用）。 */
export function registeredTokenNames(): string[] {
  return Object.keys(TOKENS)
}

/**
 * MutationObserver 的属性过滤器：**返回 `undefined`（= 观察全部属性）**。
 *
 * ## ⚠️ 为什么不是空数组（2026-09-13 实测，本插件最隐蔽的一个 bug）
 *
 * 兄弟插件的激活标记名字是动态的（`data-dsh-<pkg>-active`，对方还可能随时新增），
 * 没法预先列出 `attributeFilter` —— 所以这里想表达的是"全都听"。
 * 原实现写成 `return []`，注释还写着"空数组 = 观察全部属性"。
 * **那条注释是错的**：`MutationObserver.observe(..., { attributeFilter: [] })`
 * 在 Chromium 上**一个回调都不会触发**（过滤器是空集合 → 什么都不匹配）。
 *
 * 后果（本机实测）：家族互斥观察器与入口行高亮观察器**双双变成死代码** ——
 * 用户看到的现象正是"taskboard 和工作台的入口的点击没有做到互斥
 * （两个都可以同时被选中）"。读代码完全看不出问题（观察器建了、回调也对），
 * 只有实测才能发现"回调根本不触发"。
 *
 * 实测数据（同一页面、同时挂四个观察器，只改两个自定义属性）：
 *
 * | observe 选项 | 回调触发次数 |
 * |---|---|
 * | `{ attributes: true, attributeFilter: [] }` | **0** ← 原实现的误解 |
 * | `{ attributes: true }` | 1（两个属性合并成一条记录） |
 * | `{ attributes: true, attributeFilter: ['data-probe-x'] }` | 1 |
 * | `{ attributes: true, attributeFilter: undefined }` | 1 ← 本函数现在返回这个 |
 *
 * 探针脚本：`.pwtest/probe-observer-empty-filter.mjs`（可复跑）。
 *
 * @returns `undefined` —— 调用方应直接写 `attributeFilter: siblingActiveFilter()`，
 *   TypeScript 下该字段可选，传 `undefined` 等价于省略（= 观察全部属性）。
 */
export function siblingActiveFilter(): string[] | undefined {
  return undefined
}

/**
 * 两种面板容器的可见性规则（由 styles.ts 拼进 WORKBENCH_CSS）。
 *
 * 放在契约模块里而不是 styles.ts 的原因有两个：
 * 1. **可测**：样式只在浏览器 bundle 里，`styles.ts` 不进构建产物，规则写在那边就锁不住；
 * 2. **防漂移**：这是"官方容器"与"覆盖层容器"二选一的唯一判据，散落的
 *    `:not([data-dsh-...])` 组合一旦写漏就是"两个 App 同时渲染"或"整片空白"。
 *
 * 三条规则对应三种必须成立的状态：
 * - 官方就绪 → 只放行官方容器（`wb-panel-host`），覆盖层显式关掉；
 * - 官方就绪 → 会话列**不让位**（让位是宿主按 `activePanelId` 自己做的事，
 *   我们再 `display:none` 一遍会把会话列也吞掉）；
 * - 未就绪 → 覆盖层照旧受 `ACTIVE_ATTR` / `BLOCKED_ATTR` 门控，行为与迁移前一致。
 *
 * @param attrs - 参与门控的属性名（便于测试替身）。
 * @returns CSS 片段数组（每项一条规则）。
 */
export function panelContainerCss(attrs: {
  view: string
  official: string
  active: string
  blocked: string
}): string[] {
  const { view, official, active, blocked } = attrs
  return [
    `html[${official}] [${view}] { display: none; }`,
    `html[${official}] .wb-panel-host [${view}] { display: block; }`,
    `html[${official}]:not([${blocked}]) [class*='centerCol'] > :not([${view}]) { display: flex; }`,
    `html:not([${official}])[${active}]:not([${blocked}]) [${view}] { display: block; }`,
    `html:not([${official}])[${active}]:not([${blocked}]) [class*='centerCol'] > :not([${view}]) { display: none !important; }`,
  ]
}

/**
 * 侧栏入口那一行的全部 CSS（由 styles.ts 拼进 WORKBENCH_CSS）。
 *
 * 放在契约模块里而不是 styles.ts：入口行的形态是本 issue 的核心契约，
 * 必须能被 node --test 直接断言（`lib/client/entryContract.js` 是构建产物，
 * 而 styles.ts 只在浏览器 bundle 里）。
 *
 * 关键点：
 * - 行基线对齐家族：`min-height:36px / gap:10px / padding:0 10px`（原来 32px/12px）；
 * - 折叠态：36px 圆形 + `margin:0 auto 12px`，且只依赖 `[data-sidebar-collapsed]`
 *   —— 宿主没有 `data-dsh-frame` 属性，旧写法的祖先判定永不命中；
 * - 高亮令牌用宿主官方面板行同款 `--dsw-alias-interactive-bg-*` 并带兜底：
 *   `var()` 没有兜底时，令牌缺失会让整条 background 声明 invalid-at-computed-value-time。
 *
 * @returns 入口行相关的 CSS 片段（末尾无换行）。
 */
export function entryCss(): string {
  return [
    `[${ENTRY_ATTR}] { position:relative; display:flex; align-items:center; gap:10px; width:100%; min-height:36px; padding:0 10px; background:transparent; border:none; border-radius:8px; color:var(--dsw-alias-label-secondary); cursor:pointer; font:inherit; line-height:22px; font-size:13px; white-space:nowrap; text-align:left; }`,
    `[${ENTRY_ICON_CLASS}] { display:inline-flex; align-items:center; justify-content:center; flex:none; width:24px; height:24px; }`,
    `[${ENTRY_ICON_CLASS}] svg { width:18px; height:18px; display:block; }`,
    `[${ENTRY_LABEL_CLASS}] { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }`,
    `[${ENTRY_ATTR}]:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-specific-sidebar-nav-item-hover, rgba(127,127,127,.16))); color: var(--dsw-alias-label-primary); }`,
    `[${ENTRY_ATTR}][data-active] { background: var(--dsw-alias-interactive-bg-active, var(--dsw-specific-sidebar-nav-item-active, rgba(127,127,127,.24))); color: var(--dsw-alias-label-primary); font-weight:500; }`,
    `[${ENTRY_ATTR}]:focus-visible { outline:2px solid var(--dsw-alias-label-primary); outline-offset:-2px; }`,
    `[${SIDEBAR_COLLAPSED_ATTR}] [${ENTRY_ATTR}] { justify-content:center; padding:0; gap:0; }`,
    `[${SIDEBAR_COLLAPSED_ATTR}][${ENTRY_ATTR}] { width:36px; min-height:36px; margin:0 auto 12px; border-radius:50%; }`,
    `[${SIDEBAR_COLLAPSED_ATTR}] [${ENTRY_ATTR}] [${ENTRY_LABEL_CLASS}] { display:none; }`,
    `[${SIDEBAR_COLLAPSED_ATTR}] [${ENTRY_ATTR}] [${ENTRY_ICON_CLASS}] svg { width:20px; height:20px; }`,
  ].join('\n')
}
