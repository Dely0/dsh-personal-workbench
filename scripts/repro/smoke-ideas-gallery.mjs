/**
 * 点子页「1 号卡片瀑布」确认稿冒烟：真浏览器（Edge headless + CDP）打开
 * demo/kb-styles/ideas-gallery.html，断言修前/修后两种形态、多选、归入文件夹菜单、
 * 搜索、分页条、文件夹区未被改动。
 *
 * 用法：node scripts/repro/smoke-ideas-gallery.mjs [--out <dir>]
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

const PAGE = resolve('demo/kb-styles/ideas-gallery.html')
if (!existsSync(PAGE)) { console.error('FAIL: 确认稿不存在 ' + PAGE); process.exit(1) }

const PORT = 9500 + Math.floor(Math.random() * 300)
const profile = mkdtempSync(join(tmpdir(), 'ideas-gallery-'))
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

await send('Page.navigate', { url: pathToFileURL(PAGE).href })
await sleep(700)

check('无页面异常', pageErrors.length === 0, pageErrors.join(' | '))
check('无 console.error', consoleErrors.length === 0, consoleErrors.join(' | '))

const shape = () => evaluate(`(() => {
  const cards = [...document.querySelectorAll('#cards .card')]
  const cs = getComputedStyle(document.querySelector('#cards'))
  const first = cards[0]
  const fc = first === undefined ? null : getComputedStyle(first)
  return {
    mode: document.documentElement.dataset.mode,
    count: cards.length,
    display: cs.display,
    columns: cs.gridTemplateColumns,
    borderLeft: fc === null ? '' : fc.borderLeftWidth,
    direct: cards.filter((c) => c.parentElement.id === 'cards').length,
    picks: document.querySelectorAll('#cards .pick').length,
    foldBtns: document.querySelectorAll('#cards .foldbtn').length,
    folders: document.querySelectorAll('.folders .folder').length,
    folderItems: document.querySelectorAll('.folders .folder .fm span').length,
    pager: document.querySelector('#pager').textContent.replace(/\\s+/g, ' ').trim().slice(0, 80),
  }
})()`)

// ---- 修后（默认） ----
const after = await shape()
check('修后默认形态', after.mode === 'after', after.mode)
check('修后是 2 列网格', after.display === 'grid' && after.columns.split(' ').length === 2, `${after.display} / ${after.columns}`)
check('修后卡片有类型色左边框', parseFloat(after.borderLeft) >= 3, after.borderLeft)
check('卡片右上角有多选 ☑', after.picks === after.count && after.picks > 0, `${after.picks}/${after.count}`)
check('卡片底部有「归入文件夹」入口', after.foldBtns === after.count, `${after.foldBtns}/${after.count}`)
check('文件夹区照旧（网格 + 成员行）', after.folders === 2 && after.folderItems >= 1, `folders=${after.folders} items=${after.folderItems}`)
check('修后有编号分页条', /共\\s*\\d+\\s*条/.test(after.pager) || /共/.test(after.pager), after.pager)
check('修后三视图 Tab 都在', (await evaluate(`document.querySelectorAll('#tabs button').length`)) === 3, '')

const shotAfter = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(OUT, 'ideas-after.png'), Buffer.from(shotAfter.data, 'base64'))

// ---- 交互：多选（Alt+点击卡片） ----
const multi = await evaluate(`(() => {
  const card = document.querySelector('#cards .card')
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
  return new Promise((res) => setTimeout(() => res({
    picked: document.querySelectorAll('#cards .card.picked').length,
  }), 120))
})()`)
check('Alt+点击可多选（对应现有 ☑ → AI 关联）', multi.picked === 1, JSON.stringify(multi))

// ---- 交互：归入文件夹菜单 ----
const folderMenu = await evaluate(`(() => {
  document.querySelector('#cards .foldbtn').click()
  return new Promise((res) => setTimeout(() => {
    const menu = document.querySelector('#cards .foldmenu')
    res({ open: menu !== null, items: menu === null ? 0 : menu.querySelectorAll('button').length })
  }, 120))
})()`)
check('「归入文件夹」菜单能弹出', folderMenu.open === true && folderMenu.items === 2, JSON.stringify(folderMenu))

// ---- 交互：搜索 ----
const search = await evaluate(`(() => {
  document.body.click()
  const input = document.querySelector('#kw')
  input.value = '天线'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return new Promise((res) => setTimeout(() => res({ cards: document.querySelectorAll('#cards .card').length }), 150))
})()`)
check('搜索能过滤点子卡片', search.cards >= 1 && search.cards < 4, JSON.stringify(search))

// ---- 修前形态 ----
await evaluate(`(() => {
  const input = document.querySelector('#kw'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('#mode [data-mode="before"]').click()
  return true
})()`)
await sleep(250)
const before = await shape()
check('修前是单列平铺', before.mode === 'before' && before.display === 'block', `${before.mode} / ${before.display}`)
check('修前无分页（提示不分页）', /不分页/.test(before.pager), before.pager)
check('修前不显示摘要与类型色条', parseFloat(before.borderLeft) === 0, before.borderLeft)

const shotBefore = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(OUT, 'ideas-before.png'), Buffer.from(shotBefore.data, 'base64'))

ws.close(); child.kill(); await sleep(200)

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`点子页确认稿冒烟：${results.length - failed.length}/${results.length} 通过；截图在 ${OUT}`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail)
  process.exit(1)
}
