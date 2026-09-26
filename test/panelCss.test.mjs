/**
 * 回归：**面板的样式门控与令牌层必须真的可用**。
 *
 * ## 这个文件为什么存在（2026-09-13 真实事故）
 *
 * 架构重构「阶段 2」删 DOM 降级腿时，`entryContract.ts` 被**顺手重写**，
 * 其中两个**有实际语义的实现**被换成了占位/改写版本：
 *
 * | 函数 | 我的错误版本 | 后果 |
 * |---|---|---|
 * | `tokenLayerCss()` | `return ''` | 整个 `--wb-*` 令牌层消失 |
 * | `panelContainerCss()` | 新写的一套 `.wb-panel-host { display:none }` 规则 | 面板**整个不显示** |
 *
 * 用户重启后的原话：**"插件入口不可用了，工作台插件无法正常显示"**。
 *
 * 两处都不是"逻辑写错"，而是**把可测的实现改成了不可测的占位** ——
 * 而当时没有任何测试盯着"生成的 CSS 里有没有那几条关键规则"。
 * 本文件就是补上这个盯防：
 *
 * 1. 令牌层必须**非空**，且样式里用到的每个 `--wb-*` 都要有定义；
 * 2. 门控 CSS 必须包含"官方路径下、宿主选中我们时才显示面板"的那条规则；
 * 3. 门控必须按 `VIEW_ATTR`（真正承载内容的节点）写，不能按 `.wb-panel-host` 类名写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { VIEW_ATTR } from '../lib/client/constants.js'
import {
  OFFICIAL_MAIN_SLOT, OFFICIAL_OVERLAY_SLOT, OFFICIAL_PANEL_LIST_SLOT,
  panelContainerCss, registeredTokenNames, toWorkbenchTokens, tokenLayerCss,
} from '../lib/client/entryContract.js'

const OWN_ATTR = { view: VIEW_ATTR, official: 'data-x-official', active: 'data-x-active' }

test('令牌层必须非空，并且逐项带回退值（缺失时退化为"跟随明暗"，不是变黑）', () => {
  const css = tokenLayerCss()
  assert.ok(css.length > 100, `tokenLayerCss() 几乎是空的（${css.length} 字符）—— 令牌层被清掉了`)
  for (const name of registeredTokenNames()) {
    assert.ok(css.includes(`--wb-${name}: var(--dsw-alias-${name},`),
      `令牌层里缺少 --wb-${name} 的定义（或没带回退值）`)
  }
  assert.ok(css.includes('color-scheme: light dark'), '要显式声明 color-scheme，否则 light-dark() 不生效')
})

test('样式表里用到的每个 --wb-* 都必须"有定义 或 带兜底值"（否则令牌缺失时就是一处黑块）', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  /**
   * 三条来源合并成"已定义"集合：
   * 1. `tokenLayerCss()` 产出的 `--wb-<name>`（令牌层，styles.ts 里那 100+ 处引用都指它）；
   * 2. `styles.ts` 自己就地定义的（例如 `.wb-app { --wb-border: … }`、优先级色板）；
   * 3. **运行时由 JS 写在 `<html>` 上的** `--wb-sidebar-w`（见 index.tsx 的 syncSidebarWidth）。
   */
  const defined = new Set([
    '--wb-font',
    ...registeredTokenNames().map((n) => `--wb-${n}`),
    ...[...styles.matchAll(/(--wb-[a-z0-9-]+)\s*:/gi)].map((m) => m[1]),
    '--wb-sidebar-w',
  ])
  const used = [...styles.matchAll(/var\(\s*(--wb-[a-z0-9-]+)\s*(,|\))/gi)]
  assert.ok(used.length > 0, 'styles.ts 里应当引用若干 --wb-* 令牌')
  const bad = []
  for (const [whole, name, closer] of used) {
    if (defined.has(name)) continue
    // 没定义就必须自带兜底值，否则该处在令牌缺失时会退化成浏览器默认（常见是透明/黑）
    if (closer === ',') continue
    bad.push(`${name}（${whole.trim()} 既没定义也没兜底）`)
  }
  assert.deepEqual(bad, [], `这些令牌既没定义也没兜底：\n  - ${bad.join('\n  - ')}`)
})

test('未登记的 dsw 令牌保持原样改写（不静默改错）', () => {
  assert.equal(toWorkbenchTokens('color: var(--dsw-alias-not-registered, #111);'),
    'color: var(--dsw-alias-not-registered, #111);')
  assert.equal(toWorkbenchTokens('color: var(--dsw-alias-label-primary, #eee);'),
    'color: var(--wb-label-primary);')
  assert.equal(toWorkbenchTokens('font: var(--dsw-font-family, system-ui);'), 'font: var(--wb-font);')
})

test('门控 CSS 必须放行"官方路径 + 已激活"时的面板内容（按 VIEW_ATTR，不是按类名）', () => {
  const rules = panelContainerCss(OWN_ATTR).join('\n')
  // ① 会话列里那份内容一律隐藏
  assert.ok(rules.includes(`html[${OWN_ATTR.official}] [${OWN_ATTR.view}] { display: none; }`),
    '缺少"会话列里那份内容隐藏"的规则')
  // ② 官方容器里那份按 VIEW_ATTR 放行 —— 这**正是**事故里丢掉的那条
  assert.ok(rules.includes(`html[${OWN_ATTR.official}] .wb-panel-host [${OWN_ATTR.view}] { display: block; }`),
    '缺少"官方容器里按 VIEW_ATTR 放行内容"的规则 —— 面板会整个不显示（v1.14.53 事故）')
  // ③ 不能按 .wb-panel-host 这个**类名**去 display:none（承载内容的是带 VIEW_ATTR 的节点）
  assert.equal(/\[data-x-official\]\s*\.wb-panel-host\s*\{\s*display:\s*none/.test(rules), false,
    '不得按 .wb-panel-host 类名整体关闭容器 —— 那会把内容节点一起关掉')
})

test('兜底：官方标记缺失时仍按 ACTIVE_ATTR 放行（任何情况下不出现"全黑"）', () => {
  const rules = panelContainerCss(OWN_ATTR).join('\n')
  assert.ok(rules.includes(`html:not([${OWN_ATTR.official}])[${OWN_ATTR.active}]`),
    '缺少"官方标记缺失时按 active 兜底放行"的规则')
})

test('面板容器自身的基线样式仍在（display:none + data-open=1 才显示）', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  assert.ok(styles.includes('.wb-panel-host {'), 'styles.ts 里应当有 .wb-panel-host 的基线样式')
  assert.ok(styles.includes(".wb-panel-host[data-open='1'] { display: block; }"),
    '面板容器的显隐必须由 data-open 决定（决策 ⟺ 投影，见 panelState.ts）')
})

/**
 * 回归：**面板左边界要"宁可偏一点，也不能遮住侧栏"**。
 *
 * v1.14.54 真实事故：`.wb-panel-host` 的 `left: var(--wb-sidebar-w, 0px)` ——
 * 而 `--wb-sidebar-w` 是运行时量出来的（`syncSidebarWidth`）。阶段 2 删 DOM 腿时
 * 顺带删掉了唯一会**反复**调用它的 `MutationObserver`，于是 `apply()` 那一刻
 * 侧栏还没渲染 → 变量从未被写上 → 兜底 `0px` 生效 →
 * **工作台把整个 DSH 页面（含侧栏）盖住**（用户："侧边栏都没有了"）。
 */
test('左边界兜底值不得为 0（否则量宽失败就会盖住侧栏）', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  assert.ok(styles.includes('left: var(--wb-sidebar-w, 280px)'),
    '左边界必须用 280px（DSH 侧栏默认宽度）兜底；0px 在量宽失败时会遮住整个侧栏')
  assert.equal(/left:\s*var\(--wb-sidebar-w,\s*0px\)/.test(styles), false, '不得回退成 0px 兜底')
})

test('侧栏宽度必须"重试到量到为止"（apply 时宿主还没渲染侧栏）', () => {
  const index = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.ok(index.includes('const observeSidebar = (): boolean =>'),
    'observeSidebar 必须能报告"没找到"，好让调用方继续重试')
  assert.ok(index.includes('if (!observeSidebar()) {'),
    '必须处理"apply 时侧栏还不存在"：首次找不到时要挂观察器重试')
  assert.ok(/sidebarObserver\?\.disconnect\(\)/.test(index),
    '清理函数必须断开侧栏观察器（否则残留实例会继续写 --wb-sidebar-w）')
})

/**
 * 回归：**面板上边界要给桌面壳的标题栏让位**（DSH 0.1.7-rc.2，2026-09-26）。
 *
 * 用户原话："顶部占用了桌面端的 Title，无法正常点击"。rc2 桌面壳给 frame 加了
 * `padding-top: var(--dsh-windows-titlebar-height)` + 一条 `-webkit-app-region: drag`
 * 的标题栏（窗口按钮在带子里），而面板挂在 `shell.overlay` 下、自己 `position:fixed`，
 * **不跟着那个 padding 走** → 直接压在标题栏上。
 *
 * 判据在纯函数 `decideTopInset()` 里（`test/panelGeometry.test.mjs` 逐档断言）；
 * 这里只盯"生成物真的用了那个变量" —— v1.14.53 那次事故的教训就是
 * **实现被顺手改掉而没有任何测试盯生成物**。
 */
test('面板上边界必须由 --wb-top-inset 驱动（否则会压住桌面端标题栏）', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  assert.ok(styles.includes('top: var(--wb-top-inset, 0px)'),
    '.wb-panel-host 的 top 必须是 var(--wb-top-inset, 0px)：0px 兜底在网页版上是正确行为，'
    + '而桌面壳会由 syncTopInset 写进真实标题栏高度')
  const index = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.ok(index.includes("setProperty('--wb-top-inset'"), '必须有人写这个变量（syncTopInset）')
  assert.ok(index.includes('WINDOWS_TITLEBAR_ATTR'), '必须按 data-windows-titlebar 判定，不能无条件让位')
  assert.ok(index.includes("window.removeEventListener('resize', syncTopInset)"),
    '清理函数必须摘掉 resize 监听（否则残留实例继续写变量）')
})

/**
 * 策略：**借会话绑定只有一处**（v1.15.5）。
 *
 * DSH 0.1.7-rc.2 起 `sessions.binding(id)` 只对"已被 retain 的会话"返回绑定，
 * 所以"拿会话"必须是 `acquireSession()`（内部按宿主能力在 retain / binding 之间选，
 * 并保证 release 配对）。业务代码里**再写一次** `sessions.binding(...)` 或
 * `sessions.retain(...)` 就等于绕过引用计数 —— 这正是"同一个语义被独立计算多次"
 * 那类 bug 的入口（见项目规范第 0 节）。
 *
 * 用**源码扫描**证明"不存在第二处实现"：这是唯一能证明"没有第二处"的办法。
 */
test('借会话绑定只允许出现在 sessionRef.ts（业务代码不许直接 binding/retain）', () => {
  const dir = new URL('../src/client/', import.meta.url)
  const files = readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && name !== 'sessionRef.ts')
  assert.ok(files.length > 5, `扫描面太小（${files.length} 个文件），策略形同虚设`)
  const offenders = []
  for (const name of files) {
    const source = readFileSync(new URL(name, dir), 'utf8')
    for (const [index, line] of source.split('\n').entries()) {
      // 只认**代码**里的调用，不认注释里解释这套机制的 `binding(id)`（注释里常写）
      if (!/(sessions?|runtime)\??\.(binding|retain|open)\s*\(/.test(line)) continue
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue
      offenders.push(`${name}:${index + 1}  ${line.trim().slice(0, 90)}`)
    }
  }
  assert.deepEqual(offenders, [],
    '这些地方绕过了 sessionRef.ts 的唯一实现（acquireSession / openSessionInMainView）：\n  - ' + offenders.join('\n  - '))
})
