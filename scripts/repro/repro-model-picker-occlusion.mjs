/**
 * 复现/验收「快速录入 → 模型选择框被遮挡」（2026-09-15 用户报的 bug）。
 *
 * ## 为什么要专门写一个浏览器里的复现脚本
 *
 * 这个 bug **只有真浏览器能判**：它是"绝对定位的浮层落在 `overflow:auto`
 * 的滚动容器里、被上方内容裁掉"这类布局问题 —— 读源码、跑 typecheck、
 * 甚至跑单测都看不出来（判据是像素位置，不是分支）。
 * 本脚本用**产物真样式**（把 `src/client/styles.ts` 里的 `RAW_CSS`
 * 与 `tokenLayerCss()` 拼出来的那份 `WORKBENCH_CSS`）+
 * **与组件一致的 DOM 骨架**，在真实无头浏览器里量 `getBoundingClientRect()`，
 * 输出 JSON 判据与截图。
 *
 * ⚠️ **本脚本只证明"几何 + 样式"这一层，不证明组件接线。** 具体说：
 * - `--placement=css`：把 **v1.15.1 的历史规则**（从 `cfb0b64:src/client/styles.ts`
 *   整条取回、并把修后的 `.wb-model-menu` 规则删掉）贴回去当对照基线 → 复现 bug；
 * - `--placement=module`：**按修后实现来摆**（浮层挪到 `document.body`、`position: fixed`、
 *   位置由产物 `lib/client/popoverPlacement.js` 的 `placePopover()` 算）→ 应当全绿。
 *   但它**读不到** `src/client/index.tsx` 里的 React 接线，所以运行前会先做一次
 *   "修后接线真的在源码里"的**前提检查**（portal / placePopover / 捕获阶段 scroll / fixed 规则），
 *   前提不成立就把 verdict 判成 `wiring-missing` 并以非零码退出 ——
 *   否则把整个修复撤掉，这份"修后证据"照样全绿（v1.15.2 复审的 F3）。
 *   组件接线本身由 `test/quickIntakeClient.test.mjs` 的源码扫描守着。
 *
 * 用法（先 `pnpm build`，两种模式都要用产物）：
 *   node scripts/repro/repro-model-picker-occlusion.mjs --placement=css
 *   node scripts/repro/repro-model-picker-occlusion.mjs --placement=module
 *   node scripts/repro/repro-model-picker-occlusion.mjs --placement=module --size=1000x400 --scroll=1
 *
 * 输出落在 `.gitignore` 覆盖的 `_local-archive/model-picker-occlusion/`
 * （截图 + metrics.json，仓库约定"验收截图归这里"）。
 * 可选：`--size=1280x800`（默认常见与偏小两档）、`--scroll=1`、`--out=<目录>`。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ACTIVE_ATTR, OFFICIAL_ATTR, PENDING_ATTR, VIEW_ATTR,
} from '../../lib/client/constants.js'
import { panelContainerCss, toWorkbenchTokens, tokenLayerCss } from '../../lib/client/entryContract.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const PLACEMENT = argOf('placement', 'css')
const OUT = resolve(ROOT, argOf('out', join('_local-archive', 'model-picker-occlusion')))
const SIZES = argOf('size', '1440x900,1100x640').split(',').map((s) => {
  const [w, h] = s.split('x').map(Number)
  return { width: w, height: h }
})
const SCROLL = argOf('scroll', '') !== ''
/**
 * `css` 模式要把 **v1.15.1 的历史实现**整条贴回去当对照基线：
 * 修完之后 `.wb-model-menu` 在源码里已经是 `position: fixed; box-sizing: border-box; …`，
 * 所以"修前的样子"只能自己带，脚本才长期可复跑（否则修完就再也复现不出旧 bug）。
 *
 * ⚠️ 必须是**整条替换**、不能只覆盖几条声明（v1.15.2 复审的 F5）：覆盖式写法会继承
 * 修后那条规则里历史没有的声明（`box-sizing`/`overscroll-behavior`/`scrollbar-width`），
 * 于是"修前基线"变成"v1.15.0 的定位 + v1.15.2 的盒模型"，列表一长就分岔。
 * 所以下面这段**整条取自 `cfb0b64:src/client/styles.ts`**，并且使用时会把修后那条规则删掉。
 */
const LEGACY_COMMIT = 'cfb0b64'
const LEGACY_MENU_CSS = '.wb-model-menu { position: absolute; left: 0; bottom: calc(100% + 4px); z-index: 30; width: 320px; max-height: 360px; overflow-y: auto; padding: 6px; border: 1px solid var(--wb-border, rgba(127,127,127,.22)); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, #1c1c1f); box-shadow: 0 12px 32px rgba(0,0,0,.45); }'

/** 从 git 取回 v1.15.1 的 `.wb-model-menu` 规则；仓库没有那段历史（浅克隆/换仓）时用上面的字面量。 */
function legacyMenuRule() {
  try {
    const text = execFileSync('git', ['show', `${LEGACY_COMMIT}:src/client/styles.ts`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const hit = /(?:^|\n)\s*\.wb-model-menu\s*\{([^}]*)\}/.exec(text)
    if (hit !== null) return { rule: `.wb-model-menu {${hit[1]}}`, source: `git:${LEGACY_COMMIT}:src/client/styles.ts` }
  } catch { /* 例如没有该 commit 的浅克隆 */ }
  return { rule: LEGACY_MENU_CSS, source: '脚本内字面量（取不到 git 历史时的兜底）' }
}

/** 从样式表里**整条**删掉一个规则。 */
function dropRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return css.replace(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`, 'g'), '')
}

/** 解析一条规则里的声明（自检用：确认基线真的是历史那一份，而不是被继承过的）。 */
function declarationsOf(rule) {
  const body = /\{([^}]*)\}/.exec(rule)
  const map = new Map()
  for (const part of (body?.[1] ?? '').split(';')) {
    const idx = part.indexOf(':')
    if (idx < 0) continue
    map.set(part.slice(0, idx).trim().toLowerCase(), part.slice(idx + 1).trim())
  }
  return map
}

/**
 * 「修后实现真的在源码里吗」的前提检查（F3 的修法）。
 *
 * 本脚本的 module 模式是自己摆浮层的，读不到 `index.tsx` 的 React 接线 ——
 * 于是"把整个修复撤掉，修后证据照样全绿"。这里把接线当成**证据成立的前提**：
 * 前提不成立 → verdict 记 `wiring-missing`、退出码非 0。
 */
function checkProductionWiring() {
  const problems = []
  let component = ''
  try { component = readFileSync(join(ROOT, 'src/client/index.tsx'), 'utf8') } catch { problems.push('读不到 src/client/index.tsx') }
  const picker = /function QuickModelPicker\([\s\S]*?\r?\n\}\r?\n/.exec(component)
  if (picker === null) problems.push('index.tsx 里找不到 QuickModelPicker')
  else {
    if (!/createPortal\(/.test(picker[0]) || !/,\s*document\.body,\s*\)/.test(picker[0])) problems.push('组件没有把浮层 portal 到 document.body')
    if (!/placePopover\(\{/.test(picker[0])) problems.push('组件没有用 placePopover() 定位')
    if (!/window\.addEventListener\('scroll', update, true\)/.test(picker[0])) problems.push('组件没有在捕获阶段监听 scroll 重算')
    if (!/new ResizeObserver\(update\)/.test(picker[0])) problems.push('组件没有观察菜单尺寸变化')
  }
  let styles = ''
  try { styles = readFileSync(join(ROOT, 'src/client/styles.ts'), 'utf8') } catch { problems.push('读不到 src/client/styles.ts') }
  const menuRule = /(?:^|\n)\s*\.wb-model-menu\s*\{([^}]*)\}/.exec(styles)
  if (menuRule === null) problems.push('styles.ts 里找不到 .wb-model-menu 规则')
  else {
    if (!/position:\s*fixed/.test(menuRule[1])) problems.push('.wb-model-menu 不是 position: fixed')
    if (!/box-sizing:\s*border-box/.test(menuRule[1])) problems.push('.wb-model-menu 不是 border-box')
  }
  return { ok: problems.length === 0, problems }
}

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
if (EDGE === undefined) throw new Error('找不到 Edge（本脚本需要真实浏览器）')

/**
 * 产物真样式：`styles.ts` 里没有类型注解，去掉 import / export 后可直接求值。
 * （styles.ts 故意不进构建产物，见该文件顶部注释 —— 所以这里就地求值，
 *   用的仍是**同一份源**，不是抄一份 CSS 到脚本里。）
 */
function workbenchCss() {
  const src = readFileSync(join(ROOT, 'src/client/styles.ts'), 'utf8')
  const body = src.replace(/^import .*$/gm, '').replace(/^export const /gm, 'const ')
  const evaluate = new Function(
    'ACTIVE_ATTR', 'OFFICIAL_ATTR', 'PENDING_ATTR', 'VIEW_ATTR',
    'panelContainerCss', 'toWorkbenchTokens', 'tokenLayerCss',
    `${body}\nreturn WORKBENCH_CSS`,
  )
  return evaluate(ACTIVE_ATTR, OFFICIAL_ATTR, PENDING_ATTR, VIEW_ATTR, panelContainerCss, toWorkbenchTokens, tokenLayerCss)
}

/** 与 `QuickModelPicker` 的渲染结果一致的菜单内容（三个模型 + 一行 warn）。 */
const MENU_OPTIONS = `
  <button type="button" class="wb-model-option selected" role="option" aria-selected="true">
    <span class="wb-model-option-main">跟随 DSH 默认模型</span>
  </button>
  <div>
    <div class="wb-model-group-title">DeepSeek 官方</div>
    <button type="button" class="wb-model-option" role="option" aria-selected="false">
      <span class="wb-model-option-main">
        <span class="wb-model-option-name">DeepSeek-V4-Pro</span>
        <span class="wb-model-option-note warn">High · 不支持图片输入</span>
      </span>
    </button>
    <button type="button" class="wb-model-option" role="option" aria-selected="false">
      <span class="wb-model-option-main">
        <span class="wb-model-option-name">DeepSeek-V4-Flash-Vision-Exp</span>
        <span class="wb-model-option-note">High</span>
      </span>
    </button>
    <button type="button" class="wb-model-option" role="option" aria-selected="false">
      <span class="wb-model-option-main">
        <span class="wb-model-option-name">DeepSeek-Flash</span>
        <span class="wb-model-option-note">High</span>
      </span>
    </button>
    <button type="button" class="wb-model-option" role="option" aria-selected="false">
      <span class="wb-model-option-main">
        <span class="wb-model-option-name">DeepSeek-V4-Flash</span>
        <span class="wb-model-option-note">High</span>
      </span>
    </button>
  </div>`

/** 快速录入弹窗的 DOM 骨架（类名/层级与 `index.tsx` + `Modal.tsx` 一致）。 */
function dialogMarkup() {
  const menu = `<div class="wb-model-menu" id="menu" role="listbox" aria-label="选择模型">${MENU_OPTIONS}</div>`
  return `
<div class="wb-overlay">
  <div class="wb-dialog wb-dialog-md" role="dialog" aria-modal="true" tabindex="-1">
    <header class="wb-dialog-head">
      <h3>✦ 快速录入</h3>
      <div class="wb-dialog-head-extra"></div>
      <button class="wb-dialog-close" aria-label="关闭">×</button>
    </header>
    <div class="wb-dialog-body">
      <label class="wb-field">
        <span>一句话描述任务</span>
        <textarea rows="3" id="quick-text" placeholder="一句话描述任务，例如：周五 10:30 接待重要客户；也可以粘贴或拖入图片、PDF、DOCX"></textarea>
      </label>
      <div class="wb-field">
        <span>附件<span class="wb-field-note">图片最多 10 张 · PDF/DOCX 最多 4 份 · 单份 ≤ 5MB</span></span>
        <div class="wb-quick-actions">
          <button type="button" class="wb-btn">🖼 添加附件</button>
          <!-- 包装盒按模式对齐真实组件：修前是 position:relative（浮层就地 absolute），
               修后是 display:flex（浮层已 portal 出去，盒子只负责排列） -->
          <div style="${PLACEMENT === 'css' ? 'position:relative' : 'display:flex'}" id="picker">
            <button type="button" class="wb-btn" id="trigger" aria-haspopup="listbox" aria-expanded="true" title="选择本次澄清会话使用的模型">
              ▤ 跟随 DSH 默认模型 <span style="flex:none">▲</span>
            </button>
            ${menu}
          </div>
        </div>
      </div>
      <div class="wb-field">
        <span>AI 会话工作区<span class="wb-field-note">继承自父任务「快速录入：模型选择框被遮挡」</span></span>
        <input value="E:\\Code\\dsh-personal-workbench\\dsh-personal-workbench">
      </div>
      <div class="wb-hint">留空则沿用既有规则（跟随父任务 → 否则默认工作区）；路径不存在时会<b>明确报错</b>，不会静默换目录。</div>
      <div class="wb-hint">AI 会先澄清必要信息（一次一个主题，最多 5 轮），再提交任务草稿由你确认。</div>
    </div>
    <footer class="wb-dialog-foot">
      <span class="wb-foot-note">会跳转到官方会话区，由 AI 澄清后生成任务草稿</span>
      <button class="wb-btn">取消</button>
      <button class="wb-btn primary">创建澄清会话</button>
    </footer>
  </div>
</div>`
}

/** 页面内的量取脚本：报告菜单到底有多少是"用户真能看见的"。 */
const MEASURE_JS = `
const rectOf = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height } }
const area = (r) => Math.max(0, r.width) * Math.max(0, r.height)
const intersect = (a, b) => {
  const top = Math.max(a.top, b.top), left = Math.max(a.left, b.left)
  const bottom = Math.min(a.bottom, b.bottom), right = Math.min(a.right, b.right)
  return { top, left, bottom, right, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}
const body = document.querySelector('.wb-dialog-body')
const trigger = document.querySelector('#trigger')
const menu = document.querySelector('#menu')
const firstOption = menu.querySelector('.wb-model-option')

// ① 先按生产实现把浮层放好
if (window.__placement === 'module') {
  menu.style.position = 'fixed'
  menu.style.left = '0px'; menu.style.top = '0px'
  menu.style.width = String(window.__menuWidth) + 'px'
  menu.style.visibility = 'hidden'
  document.body.appendChild(menu)
  const anchor = trigger.getBoundingClientRect()
  // 自然高度 = scrollHeight（内容 + padding）+ 边框（.wb-model-menu 是 border-box，
  // 而 placePopover 的 max-height 指的是"整块菜单的高度"）
  const menuStyle = getComputedStyle(menu)
  const borderY = (parseFloat(menuStyle.borderTopWidth) || 0) + (parseFloat(menuStyle.borderBottomWidth) || 0)
  const natural = menu.scrollHeight + borderY
  const placement = window.placePopover({
    anchor: { top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right },
    menu: { width: window.__menuWidth, height: natural },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  })
  menu.style.left = placement.left + 'px'
  menu.style.top = placement.top + 'px'
  menu.style.width = placement.width + 'px'
  menu.style.maxHeight = placement.maxHeight + 'px'
  menu.style.visibility = ''
  window.__placementResult = { ...placement, naturalHeight: natural }
}

const viewportRect = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth, width: window.innerWidth, height: window.innerHeight }
const menuRect = rectOf(menu)
const bodyRect = rectOf(body)
const triggerRect = rectOf(trigger)
const textRect = rectOf(document.querySelector('#quick-text'))
// 滚动容器（.wb-dialog-body）是 menu 的裁剪者之一（css 模式下就是它把菜单裁掉的）
const clipRect = window.__placement === 'module' ? viewportRect : bodyRect
const visible = intersect(intersect(menuRect, clipRect), viewportRect)
const visibleRatio = area(menuRect) === 0 ? 0 : area(visible) / area(menuRect)
const clipped = {
  top: menuRect.top < clipRect.top - 0.5,
  bottom: menuRect.bottom > clipRect.bottom + 0.5,
  left: menuRect.left < clipRect.left - 0.5,
  right: menuRect.right > clipRect.right + 0.5,
}
const insideViewport = menuRect.top >= -0.5 && menuRect.left >= -0.5
  && menuRect.bottom <= window.innerHeight + 0.5 && menuRect.right <= window.innerWidth + 0.5
const firstOptionRect = rectOf(firstOption)
const report = {
  placement: window.__placement,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  dialog: rectOf(document.querySelector('.wb-dialog')),
  body: { ...bodyRect, scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight },
  trigger: triggerRect,
  menu: menuRect,
  clip: clipRect,
  placementResult: window.__placementResult ?? null,
  clipped,
  insideViewport,
  visibleRatio: Number(visibleRatio.toFixed(3)),
  hiddenPixels: Math.round(area(menuRect) - area(visible)),
  coversTrigger: area(intersect(menuRect, triggerRect)) > 1,
  coversTextarea: area(intersect(menuRect, textRect)) > 1,
  firstOption: { top: firstOptionRect.top, visible: firstOptionRect.top >= clipRect.top - 0.5 },
  menuHidesTriggerWhenOpen: area(intersect(menuRect, triggerRect)) > 1,
  verdict: (visibleRatio >= 0.999 && insideViewport && firstOptionRect.top >= clipRect.top - 0.5) ? 'ok' : 'clipped',
}
const pre = document.createElement('pre')
pre.id = 'metrics'
pre.textContent = JSON.stringify(report, null, 2)
pre.style.cssText = 'position:fixed;left:-9999px;top:0'
document.body.appendChild(pre)
document.title = report.verdict
`

function buildHtml(css, placement) {
  const moduleSource = placement === 'module'
    ? readFileSync(join(ROOT, 'lib/client/popoverPlacement.js'), 'utf8')
    : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>pending</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; font-family: system-ui, 'Segoe UI', sans-serif; }
${css}
${placement === 'css' ? LEGACY_MENU_CSS : ''}
</style></head>
<body>
${dialogMarkup()}
<script>
window.__placement = ${JSON.stringify(placement)};
window.__menuWidth = 320;
window.__pageError = null;
window.addEventListener('error', (e) => { window.__pageError = String(e.message) });
</script>
${placement === 'module' ? `<script type="module">\n${moduleSource}\nwindow.placePopover = placePopover\nwindow.dispatchEvent(new Event('placement-ready'))\n</script>` : ''}
<script>
${SCROLL ? `document.querySelector('.wb-dialog-body').scrollTop = 120` : ''}
const runMeasure = () => { ${MEASURE_JS} }
if (window.__placement === 'module') window.addEventListener('placement-ready', () => setTimeout(runMeasure, 0))
else runMeasure()
</script>
</body></html>`
}

/**
 * 用 CDP 驱动 Edge（不用 `--dump-dom`：本机 Edge 上它不出输出，
 * 而且 `--screenshot` 与"控制视口尺寸"要分两次进程，容易各量各的）。
 * 一个进程里：设视口 → 导航 → 求值拿 metrics → 截图。
 *
 * 两个已被实测教育的细节：
 * - **不能靠子进程的 exit/stderr 判断浏览器起来没有**：Windows 上 `msedge.exe`
 *   只是启动器，它自己立刻退出、浏览器继续跑，且不打印 "DevTools listening"。
 *   所以这里**预留端口 + 轮询 `/json/version`**，收尾用 `Browser.close`。
 * - 必须 `--user-data-dir=<临时目录>`：否则命令行会被转发给用户已经在用的那个 Edge，
 *   于是既没有截图也没有报错（本机第一次跑就是这么静默失败的）。
 */async function withEdgePage(size, run) {
  const port = await freePort()
  const profile = mkdtempSync(join(tmpdir(), 'wb-repro-'))
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', detached: false })
  let browserWs = null
  try {
    const version = await poll(async () => {
      try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() } catch { return null }
    }, 20000, 'Edge 没在 20s 内打开 DevTools 端口')
    browserWs = version.webSocketDebuggerUrl
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page === undefined) throw new Error('没有 page target')
    return await run(newCdpClient(page.webSocketDebuggerUrl), size)
  } finally {
    if (browserWs !== null) {
      try {
        const browser = newCdpClient(browserWs)
        await browser.ready
        await browser.send('Browser.close')
        browser.close()
      } catch { /* 关不掉就走下面的 kill */ }
    }
    child.kill()
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* 临时目录删不掉不影响结论 */ }
  }
}

async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((res, rej) => {
    const server = createServer()
    server.on('error', rej)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => res(port))
    })
  })
}

async function poll(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value !== null && value !== undefined) return value
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((r) => setTimeout(r, 200))
  }
}

function newCdpClient(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  const listeners = []
  let nextId = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve: ok, reject: bad } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) bad(new Error(JSON.stringify(message.error)))
      else ok(message.result)
    } else if (message.method !== undefined) {
      for (const listener of listeners) listener(message)
    }
  })
  return {
    ready: new Promise((res, rej) => {
      socket.addEventListener('open', () => res())
      socket.addEventListener('error', (e) => rej(new Error(`CDP 连接失败：${e?.message ?? e}`)))
    }),
    send: (method, params = {}) => new Promise((ok, bad) => {
      const id = ++nextId
      pending.set(id, { resolve: ok, reject: bad })
      socket.send(JSON.stringify({ id, method, params }))
    }),
    on: (listener) => listeners.push(listener),
    close: () => socket.close(),
  }
}

/** 导航到页面、等 metrics 就绪、读数、截图。 */
async function measureAndShoot(cdp, size, htmlPath, pngPath) {
  await cdp.ready
  const once = (method) => new Promise((res) => cdp.on((m) => { if (m.method === method) res(m) }))
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
  })
  const loaded = once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: pathToFileURL(htmlPath).href })
  await loaded
  const deadline = Date.now() + 10000
  let text = null
  while (Date.now() < deadline) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: "document.getElementById('metrics')?.textContent ?? ''", returnByValue: true,
    })
    if (typeof result.result.value === 'string' && result.result.value !== '') { text = result.result.value; break }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (text === null) {
    const err = await cdp.send('Runtime.evaluate', { expression: 'window.__pageError ?? "无异常记录"', returnByValue: true })
    throw new Error(`页面没有产出 metrics（${err.result.value}）`)
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(pngPath, Buffer.from(shot.data, 'base64'))
  cdp.close()
  return JSON.parse(text)
}

/**
 * 组装本次要用的样式表。
 *
 * - `module`：直接用产物真样式（`styles.ts` 拼出来的 `WORKBENCH_CSS`）；
 * - `css`：**整条换成 v1.15.1 的历史规则**（把修后的 `.wb-model-menu` / `.wb-model-scrim`
 *   删掉，再把历史规则贴回去），这样"修前基线"是逐字的历史实现，而不是"历史定位 + 修后盒模型"。
 */
function cssFor(placement) {
  const current = workbenchCss()
  if (placement !== 'css') return { css: current, baseline: null }
  const legacy = legacyMenuRule()
  const css = `${dropRule(dropRule(current, '.wb-model-menu'), '.wb-model-scrim')}\n${legacy.rule}`
  /**
   * 自检：**生效的** `.wb-model-menu` 声明必须与历史规则逐条相等。
   *
   * 这道自检是 F5 的修法本体 —— 光把历史规则"贴上去"不够（覆盖式写法会继承修后规则里
   * 历史没有的声明：`box-sizing` / `overscroll-behavior` / `scrollbar-width`），
   * 必须整条替换，而且**换完之后真的还是历史那一份**要能被验证。
   */
  const emitted = declarationsOf(/(?:^|\n)\s*\.wb-model-menu\s*\{[^}]*\}/.exec(css)?.[0] ?? '')
  const historical = declarationsOf(legacy.rule)
  const drift = []
  for (const [key, value] of historical) if (emitted.get(key) !== value) drift.push(`缺少/不同：${key}=${emitted.get(key) ?? '(未声明)'}，历史=${value}`)
  for (const [key, value] of emitted) if (historical.get(key) !== value) drift.push(`多出/不同：${key}=${value}，历史=${historical.get(key) ?? '(未声明)'}`)
  if (drift.length > 0) {
    throw new Error(`css 模式的基线不是 v1.15.1 的历史规则（"修前"证据不成立）：\n  - ${drift.join('\n  - ')}`)
  }
  return {
    css,
    baseline: {
      source: legacy.source,
      declarations: Object.fromEntries(historical),
      currentRuleRemoved: !/\.wb-model-menu \{[^}]*position:\s*fixed/.test(css),
    },
  }
}

const { css, baseline } = cssFor(PLACEMENT)
/**
 * 修后模式的前提：**组件接线必须真的在源码里**（见 `checkProductionWiring()` 的说明）。
 * 前提不成立时，这份"修后证据"就没有证明力 —— 记 `wiring-missing` 并以非零码退出。
 */
const wiring = PLACEMENT === 'module' ? checkProductionWiring() : null
mkdirSync(OUT, { recursive: true })
const label = SCROLL ? `${PLACEMENT}-scrolled` : PLACEMENT
if (baseline !== null) {
  console.log(`基线：${baseline.source}`)
  console.log(`  历史声明 ${Object.keys(baseline.declarations).length} 条，修后规则已整条移除=${baseline.currentRuleRemoved}`)
}
if (wiring !== null) {
  console.log(wiring.ok ? '修后接线前提：成立（portal/placePopover/捕获阶段 scroll/ResizeObserver/fixed+border-box 都在）'
    : `修后接线前提：**不成立** —— ${wiring.problems.join('；')}`)
}
const results = []
for (const size of SIZES) {
  const htmlPath = join(OUT, `${label}-${size.width}x${size.height}.html`)
  const pngPath = join(OUT, `${label}-${size.width}x${size.height}.png`)
  writeFileSync(htmlPath, buildHtml(css, PLACEMENT), 'utf8')
  const measured = await withEdgePage(size, (cdp) => measureAndShoot(cdp, size, htmlPath, pngPath))
  const report = wiring === null ? { ...measured, baseline } : { ...measured, wiring }
  // 前提不成立 → 这一档的判定无效（哪怕几何量出来是绿的）
  if (wiring !== null && !wiring.ok) report.verdict = 'wiring-missing'
  results.push(report)
  console.log(`\n=== ${label} @ ${size.width}x${size.height} → ${report.verdict} ===`)
  console.log(`  菜单矩形      top=${report.menu.top.toFixed(1)} bottom=${report.menu.bottom.toFixed(1)} h=${report.menu.height.toFixed(1)}`)
  console.log(`  裁剪容器      ${report.placement === 'module' ? 'viewport' : '.wb-dialog-body'} top=${report.clip.top.toFixed(1)} bottom=${report.clip.bottom.toFixed(1)}`)
  console.log(`  触发按钮      top=${report.trigger.top.toFixed(1)} bottom=${report.trigger.bottom.toFixed(1)}`)
  console.log(`  可见比例      ${report.visibleRatio}（被裁掉 ${report.hiddenPixels} px²）`)
  console.log(`  裁边          ${JSON.stringify(report.clipped)}  在视口内=${report.insideViewport}`)
  console.log(`  第一条可见    ${report.firstOption.visible}（top=${report.firstOption.top.toFixed(1)}）`)
  console.log(`  盖住输入框    ${report.coversTextarea}`)
  console.log(`  截图          ${pngPath}`)
}
const summary = {
  placement: label,
  sizes: SIZES.map((s) => `${s.width}x${s.height}`),
  verdicts: results.map((r) => r.verdict),
  wiring,
  baseline,
  results,
}
writeFileSync(join(OUT, `${label}-metrics.json`), JSON.stringify(summary, null, 2), 'utf8')
const failed = results.filter((r) => r.verdict !== 'ok')
console.log(`\n汇总：${results.length - failed.length}/${results.length} 档位通过（${label}）`)
if (wiring !== null && !wiring.ok) {
  console.log('⚠️ 修后接线前提不成立：本模式只按修后的**摆法**渲染，读不到组件的 React 接线；'
    + '源码里已经不是修后实现，这份证据无效。组件接线见 test/quickIntakeClient.test.mjs 的源码扫描。')
}
process.exitCode = failed.length === 0 ? 0 : 1
