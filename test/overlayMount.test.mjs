/**
 * 回归：**浮层 portal 到宿主的 overlay 层，而不是 document.body**
 * （2026-10-17 用户实测的"设置页弹窗跑到工作台后面 / 模型列表选不了"）。
 *
 * ## 事故（两份 console 日志为证）
 *
 * 面板 `.wb-panel-host`（z-index:55）挂在宿主的 overlay 层里，而那一层
 * 自己是 `position:absolute; z-index:1000` 且**自成层叠上下文**：
 *
 * ```
 * body
 *  ├─ div#root > … > div.BynINW_overlayLayer(absolute, z=1000)  ← 面板挂这里
 *  │                                 └─ div.wb-panel-host(55)
 *  ├─ div.wb-overlay(fixed, z=300)   ← 设置页弹窗：portal 到 body
 *  └─ div.wb-model-menu(fixed, z=330) ← 模型列表：portal 到 body
 * ```
 *
 * 弹窗与面板**不在同一个层叠上下文**，body 这一层比的是"1000 那一整支"对"300"：
 * 面板赢。`elementsFromPoint(弹窗中心)` 实测命中的是 `.wb-nav` / `.wb-plan-scroll`
 * （面板内容），不是弹窗自己；用户看到的就是"弹窗在面板后面、看不见也点不到"，
 * 以及"AI 执行弹窗里模型列表在弹窗后面、无法选择"。
 * 抬 z-index 能治这一例（用户当场验证过），但那是跟宿主抢数字 —— 挂进同一层才是对症修法。
 * （同类结构问题宿主仓库也报过：deepseek-ai/deepseek-harness#6440，建议 b 同上。）
 *
 * ## 这个文件盯三件事
 *
 * 1. `overlayMount.ts` 的纯判定（有就用、没有/游离/会改包含块就退回 body）——表驱动；
 * 2. **扫描**：客户端里每一处 `createPortal(` 的落点都必须走 `overlayMountContainer()`，
 *    不许再直接挂 `document.body`（"不存在第二处实现"只能扫源码证明）；
 * 3. **扫描**：portal 出去的浮层必须自带 `pointer-events:auto` —— 宿主那一层是
 *    `pointer-events:none` 的纯覆盖容器，而 pointer-events **会继承**，
 *    漏一个就是"浮层看得见、一次都点不动"（比原 bug 更难查）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'
import {
  SHELL_OVERLAY_SELECTOR, overlayIsUsableMount, overlayMountOrBody, resolveOverlayMount,
} from '../lib/client/overlayMount.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** 递归收集 `src/client` 下的 .ts/.tsx（跳过手工备份）。 */
function clientSources(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry.includes('.bak-')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { out.push(...clientSources(full)); continue }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}
const rel = (path) => relative(SRC, path).split(sep).join('/')
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// ---------------------------------------------------------------------------
// 1) 纯判定：表驱动
// ---------------------------------------------------------------------------

/** 最小假元素：只需要 isConnected 这一个事实。 */
const fakeElement = (isConnected = true) => ({ isConnected, nodeType: 1 })

/** 注入一个"会抛"的读取器：Element 只是结构类型，这里断言成入参类型。 */
const throwingReader = () => { throw new Error('boom') }

test('overlayIsUsableMount：节点判定表', () => {
  assert.equal(overlayIsUsableMount(null), false, '没有节点不可用')
  assert.equal(overlayIsUsableMount(fakeElement(true)), true, '在文档里且没注入样式读取器 → 可用')
  assert.equal(overlayIsUsableMount(fakeElement(false)), false,
    '已脱离文档（宿主重渲染中途摘掉它）不可用：挂到游离节点会让浮层整个不可见')
})

test('overlayIsUsableMount：会让 fixed 后代改包含块的样式，一律判不可用', () => {
  const bad = (style) => overlayIsUsableMount(fakeElement(true), () => style)
  assert.equal(bad({ transform: 'none', filter: 'none', backdropFilter: 'none' }), true, '全是 none → 可用')
  assert.equal(bad({ transform: 'translateY(0)' }), false, 'transform 会当 fixed 后代的包含块')
  assert.equal(bad({ filter: 'blur(1px)' }), false, 'filter 同理')
  assert.equal(bad({ backdropFilter: 'blur(2px)' }), false, 'backdrop-filter 同理（.wb-overlay 自己就吃过这个亏）')
  assert.equal(bad({ willChange: 'transform' }), false, 'will-change 也算')
  assert.equal(bad({}), true, '读取器给了空对象（没有信息）时不否决 —— 宁可用，也不因测不到而退回旧行为')
  assert.equal(overlayIsUsableMount(fakeElement(true), () => null), true, '读取器返回 null → 视为无信息')
  assert.equal(overlayIsUsableMount(fakeElement(true), () => { throw new Error('boom') }), false,
    '读取器抛错时保守判不可用（由调用方退回 body），不把异常冒到渲染里')
})

test('resolveOverlayMount / overlayMountOrBody：有就用、没有就退 body', () => {
  const overlay = fakeElement(true)
  const body = fakeElement(true)
  const doc = (hit) => ({ querySelector: (sel) => (sel === SHELL_OVERLAY_SELECTOR ? hit : null), body })
  assert.equal(resolveOverlayMount(doc(overlay)), overlay, '查到了就用它')
  assert.equal(resolveOverlayMount(doc(null)), null, '查不到（宿主太旧/改名）→ 退回')
  assert.equal(resolveOverlayMount(doc(fakeElement(false))), null, '游离节点 → 退回')
  assert.equal(resolveOverlayMount(null), null, '没有文档 → 退回')
  assert.equal(resolveOverlayMount(undefined), null, '缺参 → 退回')
  assert.equal(overlayMountOrBody(doc(overlay)), overlay, '可用时挂 overlay 层')
  assert.equal(overlayMountOrBody(doc(null)), body, '不可用时**必须**挂 body（等于修复前行为，不会更糟）')
  const throwing = { querySelector: () => { throw new Error('bad selector') }, body }
  assert.equal(overlayMountOrBody(throwing), body, 'querySelector 抛错也退回 body，绝不让弹窗渲染失败')
})

test('选择器就是宿主那个钩子（改名要同步这里与 CSS 判据）', () => {
  assert.equal(SHELL_OVERLAY_SELECTOR, '[data-shell-overlay]')
})

// ---------------------------------------------------------------------------
// 2) 扫描：每一处 createPortal 都必须走统一挂载点
// ---------------------------------------------------------------------------

const PORTAL_FILES = clientSources(join(SRC, 'client'))
  .map((path) => ({ path, code: stripComments(readFileSync(path, 'utf8')) }))
  .filter(({ code }) => /createPortal\(/.test(code))

test('扫描：客户端确实存在 portal（判据别对着空气通过）', () => {
  assert.ok(PORTAL_FILES.length >= 5,
    `预期至少 5 个文件用 createPortal（Modal/ModelPicker/LocalDocModal/Toast/TagFilter/IdeaCardGrid），实到 ${PORTAL_FILES.length}`)
})

test('扫描：没有任何一处把浮层直接挂回 document.body', () => {
  // 允许的唯一 body 形态是 `overlayMountContainer() ?? document.body`（兜底）。
  for (const { path, code } of PORTAL_FILES) {
    const direct = /createPortal\([\s\S]{0,4000}?,\s*document\.body\s*[,)]/.exec(code)
    if (direct === null) continue
    // 命中的片段里若含 overlayMountContainer()，那是兜底，合法。
    assert.ok(/overlayMountContainer\(\)\s*\?\?\s*document\.body/.test(direct[0]),
      `${rel(path)} 有浮层直接挂 document.body —— 会被宿主 overlay 层(z-index:1000)整支压住，`
      + '症状就是"设置页弹窗/模型列表在工作台面板后面"（见本文件顶部事故说明）')
  }
})

test('扫描：用 portal 的文件必须引 overlayMountContainer（不许各写一套挂载点判定）', () => {
  for (const { path, code } of PORTAL_FILES) {
    assert.match(code, /import \{ overlayMountContainer \} from '[^']*overlayMount\.js'/,
      `${rel(path)} 自己 createPortal 却没走统一挂载点 —— 挂载规则出现第二处实现就是下一个 bug`)
  }
})

// ---------------------------------------------------------------------------
// 3) 扫描：portal 出去的浮层必须自带 pointer-events:auto
// ---------------------------------------------------------------------------

/**
 * 这些是"点击面/滚动面本身"要靠根节点接收事件的浮层：宿主 overlay 层是
 * pointer-events:none，而 pointer-events **会被继承** —— 根节点不显式写 auto，
 * 它自己就收不到点击（遮罩关不掉、列表滚不动）。子元素能重新开启，所以像
 * `.wb-dock`（`> .wb-dialog { auto }`）、`.wb-tagmenu`（`> * { auto }`）这类
 * 带 `>` 后代规则的也算通过。
 * 不含 `.wb-toasts`：它本就 `pointer-events:none`、由 `.wb-toast` 后代各自开启，
 * 挂在 none 祖先下面行为不变（后代开启优先）。
 */
const PORTAL_ROOTS = ['.wb-overlay', '.wb-dock', '.wb-modal-mask', '.wb-model-scrim', '.wb-model-menu', '.wb-tagmenu', '.wb-idea-foldmenu']

test('CSS：portal 浮层的点击面必须能接收事件（宿主 overlay 层是 pointer-events:none）', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  for (const selector of PORTAL_ROOTS) {
    const block = new RegExp(`\\n\\s*\\${selector}\\s*\\{[^}]*\\}`, 's').exec(styles)
    assert.ok(block !== null, `styles.ts 里找不到 ${selector} 规则块`)
    const autoOnSelf = /pointer-events:\s*auto/.test(block[0])
    const autoOnChild = new RegExp(`\\${selector}\\s*>[^{]*\\{[^}]*pointer-events:\\s*auto`, 's').test(styles)
    assert.ok(autoOnSelf || autoOnChild,
      `${selector} 既没自己声明 pointer-events:auto、也没有 "> …{ pointer-events:auto }`
      + ' —— 挂在 pointer-events:none 的宿主 overlay 层下面，它就是"看得见、点不动"')
  }
})

test('CSS：overlay 层的 z-index 高于面板宿主 55（同层比大小的前提）', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  const zIndexOf = (selector) => {
    const match = new RegExp(`\\${selector}\\s*\\{[^}]*z-index:\\s*(-?\\d+)`, 's').exec(styles)
    return match === null ? null : Number(match[1])
  }
  const host = zIndexOf('.wb-panel-host')
  for (const selector of ['.wb-overlay', '.wb-modal-mask', '.wb-model-scrim', '.wb-model-menu', '.wb-tagmenu', '.wb-idea-foldmenu', '.wb-toasts']) {
    const z = zIndexOf(selector)
    assert.ok(z !== null && z > host, `${selector} 的 z-index(${z}) 必须高于面板 ${host} —— 挂进同一层之后，比大小就靠这个数`)
  }
})
