/**
 * 知识库样式选型打样冒烟：真浏览器（Edge headless + CDP）逐个打开 4 款打样页，
 * 断言：无页面异常 / 无 console 错误、列表有行、修前/修后切换后 DOM 真的变了、
 * 修后才有分页（修前显示"没有分页"提示）、详情区可用。
 * 顺便把每款两种形态的截图落盘，供人选型时直接看。
 *
 * 用法：node scripts/repro/smoke-kb-styles.mjs [--out <dir>]
 * 退出码 0 = 全绿；非 0 = 有断言失败。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
if (EDGE === undefined) { console.error('SKIP: 未找到 Edge'); process.exit(2) }

const outIdx = process.argv.indexOf('--out')
const OUT = resolve(outIdx >= 0 ? process.argv[outIdx + 1] : '_local-archive/kb-styles')
mkdirSync(OUT, { recursive: true })

const STYLES = [
  { id: 'gallery', name: '1 卡片瀑布' },
  { id: 'dense', name: '2 密集列表+时间分组' },
  { id: 'sidenav', name: '3 左导航树+双栏' },
  { id: 'magazine', name: '4 杂志式首屏' },
]

const PORT = 9700 + Math.floor(Math.random() * 200)
const profile = mkdtempSync(join(tmpdir(), 'kb-styles-'))
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1200,740', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function endpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list.find((x) => x.type === 'page')
      if (t !== undefined) return t.webSocketDebuggerUrl
    } catch { /* not ready */ }
    await sleep(250)
  }
  throw new Error('CDP 端点超时')
}

const ws = new WebSocket(await endpoint())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
let consoleErrors = []
let pageErrors = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id); pending.delete(msg.id)
    if (msg.error !== undefined) reject(new Error(JSON.stringify(msg.error))); else ok(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
  }
}
const send = (method, params = {}) => {
  const mid = ++id
  return new Promise((ok, reject) => { pending.set(mid, { resolve: ok, reject }); ws.send(JSON.stringify({ id: mid, method, params })) })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate threw')
  return r.result.value
}
await send('Runtime.enable')
await send('Page.enable')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : '  — ' + detail}`)
}

/** 等到列表里有行（不靠固定 sleep 猜速度）。 */
async function waitRows() {
  return evaluate(`new Promise((res) => {
    const t0 = Date.now()
    const tick = () => {
      const n = document.querySelectorAll('[data-list] [data-open]').length
      if (n > 0 || Date.now() - t0 > 3000) res(n)
      else setTimeout(tick, 40)
    }
    tick()
  })`)
}

for (const style of STYLES) {
  const file = resolve(`demo/kb-styles/kb-style-${style.id}.html`)
  if (!existsSync(file)) { check(`${style.name} · 文件存在`, false, file); continue }
  consoleErrors = []
  pageErrors = []
  await send('Page.navigate', { url: pathToFileURL(file).href })
  await sleep(500)
  const rows = await waitRows()
  check(`${style.name} · 修前有列表行`, rows > 0, rows + ' 行')
  check(`${style.name} · 无页面异常`, pageErrors.length === 0, pageErrors.join(' | '))
  check(`${style.name} · 无 console.error`, consoleErrors.length === 0, consoleErrors.join(' | '))

  const before = await evaluate(`(() => {
    const root = document.querySelector('.kbd')
    const pager = root.querySelector('[data-pager]')
    return {
      mode: document.documentElement.dataset.mode,
      hasPager: root.querySelector('.pager') !== null,
      hasNoPager: root.querySelector('.noPager') !== null,
      tabs: root.querySelectorAll('.tabs .tab').length,
      pnums: root.querySelectorAll('.pnum').length,
      rows: root.querySelectorAll('[data-list] [data-open]').length,
      tags: root.querySelectorAll('.tchip').length,
      groups: root.querySelectorAll('.ghead').length,
      stats: root.querySelectorAll('.stat').length,
      spot: root.querySelector('.spot') !== null,
      navItems: root.querySelectorAll('.nitem').length,
      pagerText: pager.textContent.replace(/\\s+/g, ' ').trim().slice(0, 70),
    }
  })()`)
  check(`${style.name} · 修前默认形态 + 无分页`, before.mode === 'before' && before.hasPager === false && before.hasNoPager === true, JSON.stringify(before))
  check(`${style.name} · 修前没有 Tab / 标签筛选`, before.tabs === 0 && before.tags === 0, `tabs=${before.tabs} tags=${before.tags}`)

  const shotBefore = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${style.id}-before.png`), Buffer.from(shotBefore.data, 'base64'))

  // 切到修后
  await evaluate(`window.postMessage({ type: 'kb-demo-mode', mode: 'after' }, '*')`)
  await sleep(500)
  const after = await evaluate(`(() => {
    const root = document.querySelector('.kbd')
    return {
      mode: document.documentElement.dataset.mode,
      hasPager: root.querySelector('.pager') !== null,
      hasNoPager: root.querySelector('.noPager') !== null,
      tabs: root.querySelectorAll('.tabs .tab').length,
      pnums: root.querySelectorAll('.pnum').length,
      rows: root.querySelectorAll('[data-list] [data-open]').length,
      tags: root.querySelectorAll('.tchip').length,
      groups: root.querySelectorAll('.ghead').length,
      stats: root.querySelectorAll('.stat').length,
      spot: root.querySelector('.spot') !== null,
      navItems: root.querySelectorAll('.nitem').length,
      pagerText: root.querySelector('.pager').textContent.replace(/\\s+/g, ' ').trim().slice(0, 70),
    }
  })()`)
  check(`${style.name} · 修后有编号分页`, after.hasPager === true && after.pnums >= 3, after.pagerText)
  check(`${style.name} · 修后每页 50 行`, after.rows > 0 && after.rows <= 50, after.rows + ' 行')
  check(`${style.name} · 修前/修后 DOM 确有变化`, before.rows !== after.rows || before.hasPager !== after.hasPager, `before=${before.rows}行 after=${after.rows}行`)

  if (style.id === 'gallery' || style.id === 'dense' || style.id === 'magazine') {
    check(`${style.name} · 修后有 Tab 分类`, after.tabs === 5, 'tab 数 = ' + after.tabs)
  }
  if (style.id === 'dense') check(`${style.name} · 修后有时间分组头`, after.groups >= 2, after.groups + ' 个组')
  if (style.id === 'magazine') check(`${style.name} · 修后有统计首屏 + 最近更新大卡`, after.stats === 3 && after.spot === true, `stats=${after.stats} spot=${after.spot}`)
  if (style.id === 'sidenav') check(`${style.name} · 修后有左导航类型树`, after.navItems >= 5, after.navItems + ' 项')

  // 搜索 + 点第二页，验证交互真的活着
  const interact = await evaluate(`(() => {
    const root = document.querySelector('.kbd')
    const input = root.querySelector('[data-role="kw"]')
    input.value = 'bad port'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return new Promise((res) => setTimeout(() => {
      const hit = root.querySelectorAll('[data-list] [data-open]').length
      const pagerTxt = root.querySelector('.pager')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''
      res({ hit, pagerTxt: pagerTxt.slice(0, 60) })
    }, 200))
  })()`)
  check(`${style.name} · 搜索命中正文`, interact.hit > 0, JSON.stringify(interact))

  // 详情区：点第一条看有没有内容
  const detail = await evaluate(`(() => {
    const root = document.querySelector('.kbd')
    const first = root.querySelector('[data-list] [data-open]')
    first.click()
    return new Promise((res) => setTimeout(() => {
      const box = root.querySelector('[data-detail]')
      res({ hasTitle: box.querySelector('.dt-h') !== null, text: box.textContent.trim().slice(0, 40) })
    }, 150))
  })()`)
  check(`${style.name} · 点列表能在详情区看到内容`, detail.hasTitle === true, JSON.stringify(detail))

  // 复位到未搜索状态再截图
  await evaluate(`(() => {
    const input = document.querySelector('.kbd [data-role="kw"]')
    if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })) }
    return true
  })()`)
  await sleep(300)
  const shotAfter = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${style.id}-after.png`), Buffer.from(shotAfter.data, 'base64'))
}

// 画廊页单独跑一遍，确认 4 个 iframe 都加载了
// file:// 下父页面**读不到** iframe 的 DOM（跨源），所以靠打样页 postMessage 自报行数
consoleErrors = []
pageErrors = []
await send('Page.navigate', { url: pathToFileURL(resolve('demo/kb-styles/index.html')).href })
// 父页面自己监听 postMessage 并把行数写进卡片徽标；这里等徽标被填满（不靠固定 sleep 猜）
await sleep(900)
await evaluate(`new Promise((res) => {
  const t0 = Date.now()
  const tick = () => {
    const filled = [...document.querySelectorAll('.opt-head .ready')].filter((b) => b.textContent.trim() !== '').length
    if (filled === 4 || Date.now() - t0 > 6000) res(filled)
    else setTimeout(tick, 60)
  }
  tick()
})`)
const gallery = await evaluate(`(() => {
  const frames = [...document.querySelectorAll('.stage iframe')]
  const badges = [...document.querySelectorAll('.opt-head .ready')].map((b) => b.textContent.trim())
  const rows = badges.map((b) => Number((b.match(/(\\d+)/) ?? [0, 0])[1]))
  return {
    cards: document.querySelectorAll('.option').length,
    frames: frames.length,
    badges,
    rows,
    scaled: frames.map((f) => f.style.transform),
  }
})()`)
check('画廊页 · 4 张卡片 4 个 iframe', gallery.cards === 4 && gallery.frames === 4, JSON.stringify({ cards: gallery.cards, frames: gallery.frames }))
check('画廊页 · 4 个打样都自报渲染完成', gallery.rows.length === 4 && gallery.rows.every((n) => n > 0), JSON.stringify(gallery.badges))
check('画廊页 · 卡片上显示已渲染行数', gallery.badges.every((b) => /已渲染 \d+ 行/.test(b)), JSON.stringify(gallery.badges))
check('画廊页 · 缩放到卡片宽度', gallery.scaled.every((s) => s.startsWith('scale(')), JSON.stringify(gallery.scaled))
// 画廊截图用**视口截图**：headless 的全页截图不会绘制视口外的 iframe（会拍出空卡片）
const shotGallery = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(OUT, 'gallery.png'), Buffer.from(shotGallery.data, 'base64'))
// 再往下滚一段，把第 3/4 款也拍一张（同一页的第二次视口截图）
await evaluate(`document.querySelector('.option[data-id="sidenav"]').scrollIntoView({ block: 'start' })`)
await sleep(700)
const shotGallery2 = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(OUT, 'gallery-2.png'), Buffer.from(shotGallery2.data, 'base64'))

ws.close(); child.kill(); await sleep(200)

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`样式打样冒烟：${results.length - failed.length}/${results.length} 通过；截图在 ${OUT}`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail)
  process.exit(1)
}
