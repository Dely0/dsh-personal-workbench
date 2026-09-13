/**
 * 侧栏入口「家族契约」的回归守卫（issue #3）。
 *
 * 这些断言盯的都是**曾经真实偏离过**的点：
 * - 家族选择器漏项 / 硬编码兄弟包名（`[data-dsh-taskboard-entry], [data-dsh-ssh-entry]` 漏了 mnemon）；
 * - 入口行不输出 `data-dsh-plugin` / `data-dsh-part="sidebar-entry"`（皮肤中心锚定不到）；
 * - 入口行没有 `aria-label` / `title`（折叠态没有文案时不可读）；
 * - 折叠态选择器写死 `[data-dsh-frame]`（宿主根本没这个属性 → 永不命中）；
 * - 行样式与家族基线不一致（32px/12px 内边距 vs 36px/10px）。
 *
 * 断言用的是**生成后的字符串**（模块导出的常量与 CSS 模板），所以重构只要改变了
 * 最终产物就会被抓住；反过来，纯内部改名不会误报。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BLOCKED_ATTR, ENTRY_ATTR, ENTRY_CLASS, ENTRY_HTML, ENTRY_ICON_CLASS, ENTRY_ICON_SVG, ENTRY_LABEL_CLASS,
  ENTRY_PART_ATTR, ENTRY_PART_VALUE, ENTRY_PLUGIN_ATTR, ENTRY_PLUGIN_ID, ENTRY_TITLE,
  OFFICIAL_MAIN_SLOT, OFFICIAL_PANEL_LIST_SLOT, SIDEBAR_COLLAPSED_ATTR,
  SIDEBAR_ENTRY_SELECTOR, entryCss, hostPanelRowVisible, isSiblingActiveAttribute, isSiblingPanelActive,
  matchesCollapsedClass, officialPanelRowRendered, officialPathConfirmed, officialRegistrationComplete,
  officialSlotDecision, panelContainerCss, registeredTokenNames, retractSiblingPanelMarks, siblingActiveFilter,
  siblingPanelViewMounted, toWorkbenchTokens, tokenLayerCss,
} from '../lib/client/entryContract.js'
import { ACTIVATE_EVENT, ACTIVE_ATTR, OFFICIAL_ATTR, PANEL_NAME, VIEW_ATTR } from '../lib/client/constants.js'

const ENTRY_CSS = entryCss()

/** 假 DOM：只实现 officialPanelRowRendered 用到的 querySelector（断言"查了什么"，不测浏览器行为）。 */
function fakeDom(rendered) {
  return {
    lastSelector: '',
    querySelector(selector) {
      this.lastSelector = selector
      return rendered ? {} : null
    },
  }
}

/** 假 slots 服务：注册表内容由测试决定。 */
function registrySlots({ panellistIds = [], mainKeys = [] } = {}) {
  return {
    inject: () => {},
    register: () => () => {},
    entriesOfSlot: () => [],
    entries(name) {
      if (name === OFFICIAL_PANEL_LIST_SLOT) return panellistIds.map((id) => ({ options: { id } }))
      if (name === OFFICIAL_MAIN_SLOT) return mainKeys.map((key) => ({ options: { key } }))
      return []
    },
  }
}

/** 造一个「看起来像官方 slots 服务」的假对象；传 undefined 的字段即模拟该能力缺失。 */
function fakeSlots({ inject = () => {}, register = () => () => {}, entriesOfSlot = () => [] } = {}) {
  return { inject, register, entriesOfSlot }
}

test('官方槽位路径：槽位名是官方契约里的字面值（写错就是静默不注册）', () => {
  // 这两个字符串来自 dsh-client-ui-sidebar / dsh-client-ui-layout 的槽位声明，
  // 拼错不会报错、只会"入口消失"，所以必须逐字锁住。
  assert.equal(OFFICIAL_PANEL_LIST_SLOT, 'sidebar.panellist')
  assert.equal(OFFICIAL_MAIN_SLOT, 'main')
  // main 是 keyed 槽位：key 必须与侧栏入口 id 同值，否则点了入口中央面板不渲染。
  assert.equal(PANEL_NAME, 'personal-workbench')
})

test('官方槽位判定：缺任一前置条件都回退 DOM 腿（宁可降级，不可"面板打不开"）', () => {
  // ① 旧宿主：没有 slots 服务
  assert.equal(officialSlotDecision(undefined).useOfficial, false)
  assert.equal(officialSlotDecision(null).useOfficial, false)
  assert.match(officialSlotDecision(undefined).reason, /slots/)

  // ② slots 形状不对（没有 inject/register）
  assert.equal(officialSlotDecision({ entriesOfSlot: () => [] }).useOfficial, false)
  assert.match(officialSlotDecision({ entriesOfSlot: () => [] }).reason, /inject/)

  // ③ 有 slots 没有 entriesOfSlot：无法确认宿主侧栏真的声明了 sidebar.panellist
  //    注意这里不能传 undefined（会被工厂的默认值补上），要传 null 表示"确实没有这个能力"。
  const noEntries = { inject: () => {}, register: () => () => {}, entriesOfSlot: null }
  assert.equal(officialSlotDecision(noEntries).useOfficial, false)
  assert.match(officialSlotDecision(noEntries).reason, /entriesOfSlot/)

  // ④ 探测本身抛错（槽位不存在时宿主可能直接抛）→ 当"不可用"，绝不冒泡
  const throwing = fakeSlots({ entriesOfSlot: () => { throw new Error('unknown slot sidebar.panellist') } })
  const throwingDecision = officialSlotDecision(throwing)
  assert.equal(throwingDecision.useOfficial, false)
  assert.match(throwingDecision.reason, /sidebar\.panellist unavailable/)
})

test('官方槽位判定：layout 取不到**不**降级，但 layout 明确没有 selectPanel 必须降级', () => {
  /**
   * 这条守卫同时锁住两个方向 —— 它们是**语义不同**的两种情形，历史上各踩过一次：
   *
   * ## ① `layout` 取不到（undefined）→ 照走官方路径
   *
   * 事故复盘（2026-09-13）：原先把 `layout.selectPanel` 当硬前置条件，结果装了
   * task-board / skin-center（二者都用 cordis 的 isolate/intercept）之后
   * `ctx.get('layout')` 取不到 → 工作台**静默降级回 DOM 老路径**，
   * 而当时要验的恰恰是"与兄弟插件共存"。
   * **信息不足时不该改判** —— 这条继续保持。
   *
   * ## ② `layout` 在、但**没有** `selectPanel` → 必须降级（v1.14.48 新增）
   *
   * 真实低版本宿主（DSH 0.1.1-rc.1）实测：`sidebar.panellist` 槽位**存在**，
   * 而 `ctx.layout` 的 `protoKeys` 只有
   * `[constructor, attachPanels, toggleSidebar, openDetails, closeDetails]`
   * —— 没有 `selectPanel`。此时宿主侧栏**没有选中面板的机制**，
   * `activePanelId` 永远是 null → 面板永远不显示，
   * 而我们的自建入口又被"官方行可见就隐藏自己"藏起来 → **用户根本打不开工作台**。
   * 这是**确凿的无能力**，与 ① 的"信息不足"完全不同，必须回退 DOM 腿。
   */
  const slots = fakeSlots()

  // ① 信息不足：不应因此降级
  assert.equal(officialSlotDecision(slots).useOfficial, true, 'layout 未知时不应降级')
  assert.equal(officialSlotDecision(slots, undefined).useOfficial, true, 'layout=undefined 不应降级')

  // ② 确凿无能力：必须降级，且原因要写清楚
  const noSelect = officialSlotDecision(slots, { toggleSidebar: () => {} })
  assert.equal(noSelect.useOfficial, false, 'layout 存在但没有 selectPanel 时必须回退 DOM 腿')
  assert.match(noSelect.reason, /selectPanel/, '原因里要写明是 selectPanel 缺失')

  // ③ 能力齐备：正常走官方
  assert.equal(officialSlotDecision(slots, { selectPanel: () => {} }).useOfficial, true)

  /**
   * `layout` 的**可选性**由行为断言保证（上面第 ① 组：少传一个参数照样能用）。
   *
   * ⚠️ 不要用 `officialSlotDecision.length === 1` 来锁这件事 ——
   * `Function.length` 数的是"第一个带默认值的参数之前"的个数，
   * 所以签名写成 `(slots, layout)`（两者都没有默认值）时它返回 **2**，
   * 与"layout 可选"并不矛盾。用行为断言，不要用元信息断言。
   */
})

test('官方槽位判定：条件齐备即走官方路径，且探测确实问了 sidebar.panellist', () => {
  const asked = []
  const slots = fakeSlots({ entriesOfSlot: (name) => { asked.push(name); return [] } })
  const decision = officialSlotDecision(slots)
  assert.equal(decision.useOfficial, true)
  assert.equal(decision.reason, '')
  assert.deepEqual(asked, ['sidebar.panellist'])
})

test('自愈判据：注册表 + DOM 两侧都有证据才算确认（2026-09-12 空白屏事故的回归守卫）', () => {
  const both = registrySlots({ panellistIds: [PANEL_NAME], mainKeys: [PANEL_NAME] })

  // ① 两侧齐备 → 确认走官方路径
  assert.equal(officialRegistrationComplete(both, PANEL_NAME), true)
  assert.equal(officialPanelRowRendered(fakeDom(true), ENTRY_TITLE), true)
  assert.deepEqual(officialPathConfirmed(both, PANEL_NAME, fakeDom(true), ENTRY_TITLE), { confirmed: true, reason: '' })

  // ② 只注册了入口、没注册 main：宿主 selectPanel 会失败 → 必须回退
  const entryOnly = registrySlots({ panellistIds: [PANEL_NAME], mainKeys: [] })
  assert.equal(officialRegistrationComplete(entryOnly, PANEL_NAME), false)
  assert.equal(officialPathConfirmed(entryOnly, PANEL_NAME, fakeDom(true), ENTRY_TITLE).confirmed, false)

  // ③ 只注册了 main、侧栏没入口：面板能开但用户找不到入口 → 同样必须回退
  const mainOnly = registrySlots({ panellistIds: [], mainKeys: [PANEL_NAME] })
  assert.equal(officialRegistrationComplete(mainOnly, PANEL_NAME), false)

  // ④ 注册表齐了但宿主没把行画出来（槽位订阅晚于渲染）→ 回退，理由要说清是哪一半缺
  const rowMissing = officialPathConfirmed(both, PANEL_NAME, fakeDom(false), ENTRY_TITLE)
  assert.equal(rowMissing.confirmed, false)
  assert.match(rowMissing.reason, /没有渲染出面板行/)

  // ⑤ 服务形状不对 / 调用抛错 → 一律 false，绝不冒泡
  assert.equal(officialRegistrationComplete(undefined, PANEL_NAME), false)
  assert.equal(officialRegistrationComplete({}, PANEL_NAME), false)
  assert.equal(officialRegistrationComplete({ entries: () => { throw new Error('boom') } }, PANEL_NAME), false)
  assert.equal(officialPanelRowRendered({ querySelector: () => { throw new Error('boom') } }, ENTRY_TITLE), false)

  // ⑥ 别的插件的条目不能冒充我们（id/key 必须精确匹配）
  const other = registrySlots({ panellistIds: ['taskboard'], mainKeys: ['taskboard'] })
  assert.equal(officialRegistrationComplete(other, PANEL_NAME), false)
})

test('自愈判据：行探测按宿主 aria-label 精确匹配（不依赖宿主 CSS Modules 哈希类名）', () => {
  const dom = fakeDom(true)
  officialPanelRowRendered(dom, ENTRY_TITLE)
  assert.match(dom.lastSelector, /^button\[aria-label=/)
  // label 里的引号要转义，否则选择器直接语法错误 → 永远探不到 → 误判成降级
  const quoted = fakeDom(false)
  officialPanelRowRendered(quoted, '含"引号"的标签')
  assert.equal(quoted.lastSelector.includes('\\"'), true)
})

test('颜色令牌层：任何 --dsw-alias-* 都必须被登记（否则令牌缺失时回退成深黑）', () => {
  /**
   * 这条测试盯的是本插件最严重的一次视觉事故（2026-09-12「弹框打开后整屏纯黑」）：
   * 样式里上百处 `var(--dsw-alias-x, <深色回退>)`，而别名令牌只定义在宿主的
   * `body` 上 —— 我们的 Modal portal 到 body 层级后取不到，于是全部落到写死的深色回退。
   *
   * 现在回退集中在 tokenLayerCss() 的 `light-dark()` 里。**新增令牌必须登记**，
   * 否则又会以"深色写死"的形式出现。这条断言就是那个闸门。
   */
  const stylesSource = readFileSync(fileURLToPath(new URL('../src/client/styles.ts', import.meta.url)), 'utf8')
  /**
   * 只扫**代码**，不扫注释：注释里会举反例（例如 `var(--dsw-alias-xxx, #111)`），
   * 把它当成真实引用会误报。去掉块注释与行注释后再提取。
   */
  const code = stylesSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const used = new Set([...code.matchAll(/var\(--dsw-alias-([a-z0-9-]+)/g)].map((m) => m[1]))
  const registered = new Set(registeredTokenNames())
  const unregistered = [...used].filter((name) => !registered.has(name))
  assert.deepEqual(unregistered, [], `styles.ts 里用到但没登记的令牌：${unregistered.join(', ')}`)
  assert.ok(registered.size >= 7, `登记项太少（${registered.size}），可能漏了`)

  // 每个登记项都必须带 light-dark() 兜底（深色写死的回退值正是事故成因）
  const layer = tokenLayerCss()
  for (const name of registered) {
    assert.match(layer, new RegExp(`--wb-${name}: var\\(--dsw-alias-${name}, light-dark\\(`), `${name} 缺少 light-dark 兜底`)
  }
  // color-scheme 必须兜底，否则 light-dark() 在脱离主题作用域的节点里解析不出正确分支
  assert.match(layer, /:root \{ color-scheme: light dark; \}/)
  // 字体令牌也要收编（它定义在 :root，与颜色令牌不同源）
  assert.match(layer, /--wb-font: var\(--dsw-font-family,/)
})

test('颜色令牌层：转换函数把 var(--dsw-alias-x, 回退) 收成 var(--wb-x)（含嵌套回退）', () => {
  assert.equal(toWorkbenchTokens('a{color:var(--dsw-alias-label-primary, #eee)}'), 'a{color:var(--wb-label-primary)}')
  assert.equal(toWorkbenchTokens('a{color:var(--dsw-alias-label-primary)}'), 'a{color:var(--wb-label-primary)}')
  // 回退里含函数与嵌套括号（真实样式里有这种写法）
  assert.equal(
    toWorkbenchTokens('a{bg:var(--dsw-alias-bg-base, var(--dsw-specific-x, rgba(0,0,0,.5)))}'),
    'a{bg:var(--wb-bg-base)}',
  )
  assert.equal(toWorkbenchTokens('a{font:var(--dsw-font-family, system-ui)}'), 'a{font:var(--wb-font)}')
  // **未登记的令牌保持原样**（宁可原样，也不要静默改错）
  assert.equal(toWorkbenchTokens('a{color:var(--dsw-alias-not-registered, #000)}'), 'a{color:var(--dsw-alias-not-registered, #000)}')
  assert.equal(toWorkbenchTokens('a{color:var(--wb-label-primary)}'), 'a{color:var(--wb-label-primary)}')
})

test('styles.ts 的 CSS 模板里不能出现反引号（会提前闭合模板，报错信息极难懂）', () => {
  /**
   * 这个坑在本次会话里踩了 **4 次**，每次报错都很误导：
   * `TS2339: Property 'wb' does not exist on type 'string'` / `TS1005: ',' expected`，
   * 看起来像类型或语法问题，实际只是**注释里写了一个反引号**，
   * 把 CSS 模板字符串提前闭合了（注释里也不行）。
   *
   * 注释里想强调名词就用「」或直接写，别用反引号。
   */
  const source = readFileSync(fileURLToPath(new URL('../src/client/styles.ts', import.meta.url)), 'utf8')
  /**
   * 用正则精确取 RAW_CSS 这一个模板字面量的正文（到**它自己的**结束反引号为止）。
   * 曾经用 lastIndexOf 取结束位置，结果取到了后面 WORKBENCH_CSS 那个模板，
   * 把它的注释也算进来造成了误报 —— 测试自己也会踩坑。
   */
  const match = /const RAW_CSS = `([\s\S]*?)`\n/.exec(source)
  assert.ok(match !== null, '找不到 RAW_CSS 模板字符串')
  const template = match[1]
  /**
   * 注释里的反引号同样会闭合模板，所以整段都要查；本测试的说明文字自己也不能用反引号。
   */
  const offenders = template.split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => text.includes('`'))
  assert.deepEqual(
    offenders.map((o) => `L${o.line}: ${o.text.trim().slice(0, 60)}`),
    [],
    'RAW_CSS 模板里出现反引号 —— 会把模板提前闭合（注释里也不行）',
  )
})

test('两种面板容器严格二选一：panelContainerCss 以 OFFICIAL_ATTR 分流（防两个 App 打架 / 防空白屏）', () => {
  // 这个属性名是 index.tsx 与 styles.ts 之间的契约：改了它但没改样式，
  // 结果就是"两份都显示"或"两份都不显示"，两种都很难从代码上看出来。
  assert.equal(OFFICIAL_ATTR, 'data-dsh-personal-workbench-official')
  const css = panelContainerCss({ view: VIEW_ATTR, official: OFFICIAL_ATTR, active: ACTIVE_ATTR, blocked: BLOCKED_ATTR })
  const text = css.join('\n')
  // 官方就绪时：只放行官方容器，且**不再**让会话列让位（让位是宿主的事）
  assert.ok(text.includes(`html[${OFFICIAL_ATTR}] [${VIEW_ATTR}] { display: none; }`))
  assert.ok(text.includes(`html[${OFFICIAL_ATTR}] .wb-panel-host [${VIEW_ATTR}] { display: block; }`))
  // 未就绪时：覆盖层照旧受 ACTIVE/BLOCKED 门控（行为与迁移前一致）
  assert.ok(text.includes(`html:not([${OFFICIAL_ATTR}])[${ACTIVE_ATTR}]`))
  // 会话列的隐藏规则必须带 not(OFFICIAL) 前缀，否则官方路径会把会话列也吞掉
  const hideRules = css.filter((line) => line.includes('display: none !important'))
  assert.equal(hideRules.length, 1)
  assert.ok(hideRules[0].includes(`html:not([${OFFICIAL_ATTR}])`))
  // 覆盖层容器在官方路径下必须显式关掉，不能只靠"没被放行"
  const viewRules = css.filter((line) => line.startsWith(`html[${OFFICIAL_ATTR}] [${VIEW_ATTR}]`))
  assert.equal(viewRules.length, 1)
})

test('官方槽位路径与 DOM 降级腿并存：家族契约常量在迁移后仍然齐备', () => {
  // 迁移到官方槽位后 DOM 腿不是"死代码"：撑不起官方槽位的宿主仍然走它。
  // 这条断言防止将来有人"顺手清理"掉降级腿所需的常量。
  assert.equal(typeof ENTRY_ATTR, 'string')
  assert.equal(typeof ENTRY_HTML, 'string')
  assert.ok(ENTRY_HTML.includes(ENTRY_ICON_CLASS))
  assert.ok(SIDEBAR_ENTRY_SELECTOR.includes(ENTRY_PART_ATTR))
  assert.equal(SIDEBAR_COLLAPSED_ATTR, 'data-sidebar-collapsed')
})

test('入口行输出家族标识：行属性 + 语义属性 + 无障碍名', () => {
  assert.equal(ENTRY_ATTR, 'data-dsh-personal-workbench-entry')
  assert.equal(ENTRY_PLUGIN_ATTR, 'data-dsh-plugin')
  assert.equal(ENTRY_PART_ATTR, 'data-dsh-part')
  // 语义属性是皮肤中心锚定的关键：part 值必须逐字是 sidebar-entry。
  assert.equal(ENTRY_PART_VALUE, 'sidebar-entry')
  // plugin 值用插件名（与 dsh-panel-activate 的 detail 同一套 id）。
  assert.equal(ENTRY_PLUGIN_ID, PANEL_NAME)
  assert.equal(PANEL_NAME, 'personal-workbench')
  // 折叠态没有可见文案，靠这两个属性保持可读 / 可 tooltip。
  assert.ok(ENTRY_TITLE.length > 0)
})

test('入口行结构是家族三段式：entry / entryIcon / entryLabel', () => {
  assert.equal(ENTRY_CLASS, 'dshWorkbench_entry')
  assert.equal(ENTRY_ICON_CLASS, 'dshWorkbench_entryIcon')
  assert.equal(ENTRY_LABEL_CLASS, 'dshWorkbench_entryLabel')

  assert.ok(ENTRY_HTML.includes(`class="${ENTRY_ICON_CLASS}"`), '图标槽类名缺失')
  assert.ok(ENTRY_HTML.includes(`class="${ENTRY_LABEL_CLASS}"`), '文案槽类名缺失')
  assert.ok(ENTRY_HTML.includes('工作台'), '文案缺失')
  // 图标必须 aria-hidden：语义由行上的 aria-label 承担，否则读屏会读两遍。
  assert.ok(ENTRY_ICON_SVG.includes('aria-hidden="true"'), '图标缺 aria-hidden')
  assert.ok(ENTRY_ICON_SVG.startsWith('<svg'), '图标不是内联 svg')
})

test('家族入口选择器按属性名格式认，不再逐个列举兄弟包名', () => {
  for (const sibling of ['taskboard', 'ssh', 'mnemon']) {
    assert.ok(
      SIDEBAR_ENTRY_SELECTOR.includes(`data-dsh-${sibling}-entry`),
      `家族选择器漏了 data-dsh-${sibling}-entry（issue #3 的原始缺陷）`,
    )
  }
  assert.ok(SIDEBAR_ENTRY_SELECTOR.includes(`[${ENTRY_PART_ATTR}="${ENTRY_PART_VALUE}"]`), '缺少语义属性兜底选择器')
})

test('动态识别兄弟插件的面板激活标记：格式驱动，不靠包名清单', () => {
  // 认识的：data-dsh-<pkg>-active
  assert.equal(isSiblingActiveAttribute('data-dsh-taskboard-active'), true)
  assert.equal(isSiblingActiveAttribute('data-dsh-ssh-active'), true)
  assert.equal(isSiblingActiveAttribute('data-dsh-mnemon-active'), true)
  // 将来新增的兄弟插件自动覆盖（这正是写死包名清单会漏的地方）
  assert.equal(isSiblingActiveAttribute('data-dsh-some-future-plugin-active'), true)

  // 不认识的：本插件自己的标记不能算「兄弟」
  assert.equal(isSiblingActiveAttribute(ACTIVE_ATTR), false)
  assert.equal(ACTIVE_ATTR, 'data-dsh-personal-workbench-active')
  // 家族入口行标记不是面板激活标记
  assert.equal(isSiblingActiveAttribute(ENTRY_ATTR), false)

  /**
   * ⚠️ 非面板用途的同名属性**必须排除**（2026-09-13 皮肤失效事故的回归守卫）。
   *
   * 皮肤中心把「壁纸/背景是否激活」也写成 `data-dsh-*-active`，格式上与兄弟面板标记
   * 完全一致。若只按格式识别，`retractSiblingPanels()` 会把它们一起摘掉 ——
   * 用户表现是「点开工作台后皮肤全局失效、回到会话也不恢复」。
   */
  assert.equal(isSiblingActiveAttribute('data-dsh-wallpaper-active'), false, '壁纸激活标记不是面板标记')
  assert.equal(isSiblingActiveAttribute('data-dsh-backdrop-active'), false, '背景激活标记不是面板标记')
  assert.equal(isSiblingPanelActive(['data-dsh-wallpaper-active', 'data-dsh-backdrop-active']), false, '只有皮肤标记时不应判定为"有兄弟面板开着"')
  assert.equal(isSiblingActiveAttribute('data-dsh-personal-workbench-pending'), false)
  assert.equal(isSiblingActiveAttribute('data-dsh-sidebar-collapsed'), false)
  // 其它宿主的属性
  assert.equal(isSiblingActiveAttribute(SIDEBAR_COLLAPSED_ATTR), false)
  assert.equal(isSiblingActiveAttribute('data-ds-dark-theme'), false)
  assert.equal(isSiblingActiveAttribute('class'), false)
  assert.equal(isSiblingActiveAttribute(''), false)
  // 只有前缀没有后缀 / 只有后缀没有前缀
  assert.equal(isSiblingActiveAttribute('data-dsh-'), false)
  assert.equal(isSiblingActiveAttribute('data-dsh--active'), false)
  assert.equal(isSiblingActiveAttribute('data-other-active'), false)
})

test('面板门控判定：任何一个兄弟插件开着就让位', () => {
  assert.equal(isSiblingPanelActive([]), false)
  assert.equal(isSiblingPanelActive([ACTIVE_ATTR]), false)
  assert.equal(isSiblingPanelActive([ACTIVE_ATTR, 'data-dsh-mnemon-active']), true)
  assert.equal(isSiblingPanelActive([SIDEBAR_COLLAPSED_ATTR, 'data-dsh-taskboard-active']), true)
})

test('观察器过滤器必须返回 undefined（空数组 = 什么都不观察，不是"全部"）', () => {
  /**
   * ⚠️ 2026-09-13 实测：`observe(..., { attributes: true, attributeFilter: [] })`
   * 在 Chromium 上**一次回调都不触发**。原实现返回 `[]` 并注释"空数组 = 观察全部属性"，
   * 结果家族互斥与入口高亮两个观察器全是死代码（现象：taskboard 与工作台
   * "两个都可以同时被选中"）。这条断言把修法钉死：宁可传 undefined（= 省略 = 全都听）。
   *
   * 可复跑的实证：`.pwtest/probe-observer-empty-filter.mjs`。
   */
  assert.equal(siblingActiveFilter(), undefined, '必须返回 undefined；返回 [] 会让观察器永不触发')
  assert.notDeepEqual(siblingActiveFilter(), [], '不要再改回空数组')
})

test('折叠态识别认宿主真实类名（CSS Module 哈希前缀不写死）', () => {
  // 宿主当前构建的真实类名形态
  assert.equal(matchesCollapsedClass(['pI_x6G_frame', 'hHd-Xa_root', 'hHd-Xa_collapsed']), true)
  assert.equal(matchesCollapsedClass(['hHd-Xa_root']), false)
  assert.equal(matchesCollapsedClass([]), false)
  assert.equal(matchesCollapsedClass(['collapsed']), false, '裸 collapsed 类不算（要带前缀）')
  assert.equal(matchesCollapsedClass(['_collapsed']), false, '空前缀不算')
  assert.equal(matchesCollapsedClass(['hHd-Xa_collapsedExtra']), false, '后缀必须逐字结束')
  assert.equal(matchesCollapsedClass(['hHd-Xa_railIn']), false)
})

test('CSS 门控用动态 blocked 标记，不再硬编码兄弟插件名', () => {
  assert.ok(BLOCKED_ATTR.length > 0, '缺少 blocked 标记常量')
  assert.equal(BLOCKED_ATTR, 'data-dsh-personal-workbench-blocked')
  // 硬编码清单的回归守卫：一旦有人再写死兄弟包名，这条会失败
  for (const hardcoded of ['data-dsh-taskboard-active', 'data-dsh-ssh-active', 'data-dsh-mnemon-active']) {
    assert.equal(
      ENTRY_CSS.includes(hardcoded),
      false,
      `入口样式里出现了硬编码的兄弟插件标记 ${hardcoded}（新增成员必漏，issue #3 的根因）`,
    )
  }
})

test('CSS 折叠态不依赖 [data-dsh-frame]（宿主没有这个属性）', () => {
  assert.equal(
    ENTRY_CSS.includes('data-dsh-frame'),
    false,
    'data-dsh-frame 在 DSH 0.1.5 上不存在，用它做祖先判定是死代码',
  )
  assert.ok(
    ENTRY_CSS.includes(`[${SIDEBAR_COLLAPSED_ATTR}] [${ENTRY_ATTR}]`),
    '缺少基于 data-sidebar-collapsed 的折叠态规则',
  )
  assert.ok(ENTRY_CSS.includes('width:36px; min-height:36px; margin:0 auto 12px; border-radius:50%'), '折叠态形态不符合家族基线（36px 圆形 + 12px 下边距）')
  assert.ok(ENTRY_CSS.includes(`[${SIDEBAR_COLLAPSED_ATTR}] [${ENTRY_ATTR}] [${ENTRY_LABEL_CLASS}] { display:none; }`), '折叠态没有隐藏文案槽')
})

test('行样式对齐家族基线：36px 高 / 10px 间距与内边距', () => {
  const rule = ENTRY_CSS.split('\n').find((line) => line.startsWith(`[${ENTRY_ATTR}] {`))
  assert.ok(rule !== undefined, '找不到入口行主规则')
  assert.ok(rule.includes('min-height:36px'), '行高不是家族基线的 36px')
  assert.ok(rule.includes('gap:10px'), '图标与文案间距不是家族基线的 10px')
  assert.ok(rule.includes('padding:0 10px'), '内边距不是家族基线的 0 10px')
  assert.equal(rule.includes('height:32px'), false, '又回到了旧的 32px 行高')
  assert.equal(rule.includes('padding:0 12px'), false, '又回到了旧的 12px 内边距')
})

test('高亮令牌与同排官方行一致，且带兜底', () => {
  const hover = ENTRY_CSS.split('\n').find((line) => line.startsWith(`[${ENTRY_ATTR}]:hover`))
  const active = ENTRY_CSS.split('\n').find((line) => line.startsWith(`[${ENTRY_ATTR}][data-active]`))
  assert.ok(hover !== undefined && active !== undefined, '找不到 hover / active 规则')
  // 宿主自己的 panelRow 用的就是 alias 令牌；用 specific-* 会与同排入口颜色不一致。
  assert.ok(hover.includes('--dsw-alias-interactive-bg-hover'), 'hover 未使用宿主通用令牌')
  assert.ok(active.includes('--dsw-alias-interactive-bg-active'), 'active 未使用宿主通用令牌')
  // var() 必须带兜底：令牌缺失时整条声明会 invalid-at-computed-value-time
  assert.ok(hover.includes('var(--dsw-alias-interactive-bg-hover,'), 'hover 令牌缺兜底')
  assert.ok(active.includes('var(--dsw-alias-interactive-bg-active,'), 'active 令牌缺兜底')
})

// ---------------------------------------------------------------------------
// v1.14.45：入口去重 / 家族互斥的判定（**一次只留一份实现**）
//
// 这一组盯的是 2026-09-13 用户实测的两个具体现象：
//   - 侧栏出现两个「工作台」入口；
//   - taskboard 与工作台"两个都可以同时被选中"。
// 两者的共同根因都是"同一条语义判定写了两份、且其中一份判据是错的"，
// 所以这些测试都直接断言**判据本身**（而不是断言某个调用点）。
// ---------------------------------------------------------------------------

/** 假元素：只实现判定函数用到的那几个成员（断言"查了什么"，不模拟浏览器布局）。 */
function fakeRow({ aria = null, ours = false, display = 'flex', visibility = 'visible', width = 100 } = {}) {
  return { _aria: aria, _ours: ours, _display: display, _visibility: visibility, _width: width }
}
/** 该行是否带我们的家族属性（判定函数只问 ENTRY_ATTR）。 */
const ownsRow = (row) => row._ours === true
/**
 * 安装一套**按元素返回**的 `getComputedStyle` / 布局替身。
 *
 * 为什么不能写成常量替身：第一版把 `getComputedStyle` 装成"永远 display:flex"，
 * 于是 `display:none` 的用例恒为"可见"，测试反而抓不到回归（实测踩到）。
 * 替身必须能表达"这一行是隐藏的"。
 */
function installLayoutStubs() {
  globalThis.getComputedStyle = (el) => ({
    display: el?._display ?? 'flex',
    visibility: el?._visibility ?? 'visible',
  })
}
/** 假 document：querySelectorAll 返回带 hasAttribute 包装的行。 */
function fakeRoot(rows) {
  const wrapped = rows.map((row) => ({
    ...row,
    hasAttribute: (name) => (name === ENTRY_ATTR ? ownsRow(row) : false),
    getAttribute: (name) => (name === 'aria-label' ? row._aria : null),
    getBoundingClientRect: () => ({ width: row._width }),
  }))
  return {
    lastSelector: '',
    querySelectorAll(selector) {
      this.lastSelector = selector
      return wrapped
    },
    querySelector: () => null,
  }
}

test('官方行可见性判定：按 aria-label 查（textContent 是长 title，按短文案查永远不命中）', () => {
  installLayoutStubs()
  const root = fakeRoot([fakeRow({ aria: ENTRY_TITLE })])
  assert.equal(hostPanelRowVisible(root), true)
  assert.ok(
    root.lastSelector.includes(`aria-label="${ENTRY_TITLE}"`),
    `判定必须按 aria-label 查官方行；实际查的是 ${root.lastSelector}`,
  )
  assert.equal(
    root.lastSelector.includes('工作台"'),
    false,
    '不得再用短文案（ENTRY_LABEL_TEXT）做 textContent 精确匹配 —— 那是"两行入口"的根因',
  )
})

test('官方行可见性判定：排除我们自己的行（两条腿用同一个 title，只能靠属性区分）', () => {
  installLayoutStubs()
  // 页面上只有我们注入的行（官方行没渲染出来）→ 必须判定为"官方行不可见"，
  // 否则我们会把自己藏掉，侧栏一个入口都不剩。
  assert.equal(hostPanelRowVisible(fakeRoot([fakeRow({ aria: ENTRY_TITLE, ours: true })])), false)
  // 官方行在 + 我们的行也在 → 官方行可见（我们让位）
  assert.equal(hostPanelRowVisible(fakeRoot([
    fakeRow({ aria: ENTRY_TITLE, ours: true }),
    fakeRow({ aria: ENTRY_TITLE }),
  ])), true)
  // 官方行隐藏（display:none）→ 判定为不可见，我们的行必须显示
  assert.equal(hostPanelRowVisible(fakeRoot([fakeRow({ aria: ENTRY_TITLE, display: 'none' })])), false)
  // visibility:hidden 同理
  assert.equal(hostPanelRowVisible(fakeRoot([fakeRow({ aria: ENTRY_TITLE, visibility: 'hidden' })])), false)
  // 官方行宽度为 0（未布局）→ 同样算不可见
  assert.equal(hostPanelRowVisible(fakeRoot([fakeRow({ aria: ENTRY_TITLE, width: 0 })])), false)
})

test('家族互斥收口：摘掉兄弟插件的激活标记，但绝不误摘皮肤标记', () => {
  /** 假 `<html>`：记录属性读写，并提供 ownerDocument.dispatchEvent 探针。 */
  const makeRoot = (names) => {
    const attrs = new Set(names)
    const events = []
    return {
      attrs,
      events,
      getAttributeNames: () => [...attrs],
      removeAttribute: (name) => { attrs.delete(name) },
      ownerDocument: { dispatchEvent: (event) => { events.push(event) } },
    }
  }
  const root = makeRoot([
    ACTIVE_ATTR, 'data-dsh-taskboard-active', 'data-dsh-ssh-active',
    'data-dsh-wallpaper-active', 'data-dsh-backdrop-active', SIDEBAR_COLLAPSED_ATTR,
  ])
  const removed = retractSiblingPanelMarks(root, isSiblingActiveAttribute, PANEL_NAME, ACTIVATE_EVENT)

  assert.deepEqual(
    removed.sort(),
    ['data-dsh-ssh-active', 'data-dsh-taskboard-active'],
    '只应摘掉兄弟插件的**面板**激活标记',
  )
  // 皮肤标记必须原地不动：皮肤中心的 MutationObserver 监听它们，一被摘就卸载壁纸且不恢复。
  assert.equal(root.attrs.has('data-dsh-wallpaper-active'), true, '壁纸标记被误摘（2026-09-13 真实事故）')
  assert.equal(root.attrs.has('data-dsh-backdrop-active'), true, '背景标记被误摘（2026-09-13 真实事故）')
  // 本插件自己的标记与宿主的折叠标记都不归这里管
  assert.equal(root.attrs.has(ACTIVE_ATTR), true)
  assert.equal(root.attrs.has(SIDEBAR_COLLAPSED_ATTR), true)
  // 摘完必须广播家族激活事件（task-board / ssh 靠它互斥）
  assert.equal(root.events.length, 1)
  assert.equal(root.events[0].type, ACTIVATE_EVENT)
  assert.equal(root.events[0].detail, PANEL_NAME)
})

test('家族互斥收口：没有兄弟标记时不广播（避免无意义的事件风暴）', () => {
  const attrs = new Set([ACTIVE_ATTR, 'data-dsh-wallpaper-active'])
  const events = []
  const root = {
    getAttributeNames: () => [...attrs],
    removeAttribute: (name) => { attrs.delete(name) },
    ownerDocument: { dispatchEvent: (event) => { events.push(event) } },
  }
  // 注意：当前实现是"无论如何都广播"（事件本身无害且对端可能只认事件）。
  // 这条断言锁的是**它的实际行为**，避免将来改语义时没有回归网。
  retractSiblingPanelMarks(root, isSiblingActiveAttribute, PANEL_NAME, ACTIVATE_EVENT)
  assert.equal(events.length, 1)
  assert.equal(attrs.has('data-dsh-wallpaper-active'), true)
})

test('兄弟面板视图容器不是"面板开着"的判据（task-board 的容器是常驻的）', () => {
  /**
   * 这条是 v1.14.45 差点写错的回归守卫。
   *
   * task-board 的 `panel-mount-core.ensure()` 把视图容器**永久**挂在会话列里，
   * 显隐只靠 `<html data-dsh-taskboard-active>` + CSS。若拿"容器存在"当
   * "兄弟面板开着"，本插件就会永远让位、永远打不开。
   */
  const withBoard = { querySelector: (sel) => (sel.includes('data-dsh-taskboard-view') ? {} : null) }
  assert.equal(siblingPanelViewMounted(withBoard), true, '容器存在时本函数应为真（它只报"在不在"）')
  // 判定"开着"必须用属性：容器在、属性不在 → 不算兄弟面板开着
  assert.equal(isSiblingPanelActive([ACTIVE_ATTR]), false, '只有我们自己的标记时不得判定为兄弟面板开着')
  assert.equal(isSiblingPanelActive([ACTIVE_ATTR, 'data-dsh-taskboard-active']), true)
})
