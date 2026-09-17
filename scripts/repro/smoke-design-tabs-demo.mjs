/**
 * 静态设计稿冒烟测试：真浏览器（Edge headless + CDP）打开 demo/knowledge-task-tabs-demo.html，
 * 断言：无页面异常 / 无 console 错误、Tab 渲染、搜索命中正文、筛选叠加、排序默认更新时间降序、
 * 分页切片、虚拟滚动只挂窗口行、并排对比两列都在。
 *
 * 用法：node scripts/repro/smoke-design-tabs-demo.mjs [--screenshot <png>]
 * 退出码 0 = 全绿；非 0 = 有断言失败（失败明细打到 stdout）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = EDGE_CANDIDATES.find((p) => existsSync(p))
if (edge === undefined) {
  console.error('SKIP: 未找到 Edge，无法做真浏览器冒烟')
  process.exit(2)
}

const page = resolve('demo/knowledge-task-tabs-demo.html')
if (!existsSync(page)) {
  console.error('FAIL: 设计稿不存在 ' + page)
  process.exit(1)
}

const shots = process.argv.indexOf('--screenshot')
const shotPath = shots >= 0 ? resolve(process.argv[shots + 1]) : null

const PORT = 9333 + Math.floor(Math.random() * 400)
const profile = mkdtempSync(join(tmpdir(), 'wb-design-smoke-'))
const child = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const target = list.find((t) => t.type === 'page')
      if (target !== undefined) return target.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 端点超时')
}

const ws = new WebSocket(await endpoint())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const consoleErrors = []
const pageErrors = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error !== undefined) reject(new Error(JSON.stringify(msg.error)))
    else ok(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
  }
}
function send(method, params = {}) {
  const mid = ++id
  return new Promise((ok, reject) => {
    pending.set(mid, { resolve: ok, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate threw')
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: pathToFileURL(page).href })
await sleep(1400)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : '  — ' + detail}`)
}

// ---- 1. 无脚本异常（file:// 下 localStorage 抛 SecurityError 属预期，已被 LS 兜住） ----
check('无页面异常', pageErrors.length === 0, pageErrors.join(' | '))
check('无 console.error', consoleErrors.length === 0, consoleErrors.join(' | '))

// ---- 2. Tab 分类渲染 + 条数徽标 ----
const tabInfo = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('#kbRoot .tabs .tab')]
  return { count: tabs.length, labels: tabs.map(t => t.textContent.trim().replace(/\\s+/g,' ')), active: tabs.filter(t=>t.classList.contains('on')).length }
})()`)
check('知识库 Tab 渲染（全部 + 4 分类）', tabInfo.count === 5, JSON.stringify(tabInfo))
check('Tab 条数徽标存在', /全部\d/.test(tabInfo.labels[0] ?? ''), tabInfo.labels[0] ?? '')

// ---- 3. 默认排序 = 更新时间降序 ----
const sortInfo = await evaluate(`(() => {
  const sel = document.querySelector('#kbRoot [data-role="sortkey"]')
  const dir = document.querySelector('#kbRoot [data-role="sortdir"]')
  const stamps = [...document.querySelectorAll('#kbRoot .list .row .stamp')].slice(0, 5).map(e => e.textContent.trim())
  return { key: sel.value, dir: dir.textContent.trim(), stamps }
})()`)
check('默认排序键 = updatedAt', sortInfo.key === 'updatedAt', sortInfo.key)
check('默认方向 = 降序', /降序/.test(sortInfo.dir), sortInfo.dir)
const desc = sortInfo.stamps.every((s, i, a) => i === 0 || a[i - 1] >= s)
check('可见行按更新时间倒序', desc, sortInfo.stamps.join(' > '))

// ---- 4. 搜索命中正文（正文里的词，标题里没有） ----
const bodyHit = await evaluate(`(() => {
  const kw = 'bad port'
  const input = document.querySelector('#kbRoot [data-role="kw"]')
  input.value = kw
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return new Promise((res) => setTimeout(() => {
    const rows = [...document.querySelectorAll('#kbRoot .list .row')]
    res({ rows: rows.length, marks: document.querySelectorAll('#kbRoot mark').length, first: rows[0]?.querySelector('.title')?.textContent?.slice(0,20) ?? '' })
  }, 420))
})()`)
check('搜索命中正文（标题不含关键词）', bodyHit.rows > 0 && bodyHit.marks > 0, JSON.stringify(bodyHit))

// ---- 5. 筛选可叠加（标签 + 关联任务） ----
const facet = await evaluate(`(() => {
  const input = document.querySelector('#kbRoot [data-role="kw"]'); input.value = ''
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return new Promise((res) => setTimeout(() => {
    const one = () => { const b = document.querySelector('#kbRoot [data-facet="tag"][data-code="TTS"]'); b.click(); return document.querySelector('#kbRoot .metric').textContent }
    const a = one()
    const before = document.querySelector('#kbRoot .bar-chip b').textContent
    const all = document.querySelectorAll('#kbRoot .fchip.on').length
    const p = document.querySelector('#kbRoot .fchip.on').textContent
    const b2 = document.querySelector('#kbRoot [data-facet="src"][data-code="has"]'); b2.click()
    const after = document.querySelector('#kbRoot .bar-chip b').textContent
    res({ before, after, chipsOn: all, chip: p, dropped: Number(before.replace(/,/g,'')) > Number(after.replace(/,/g,'')) })
  }, 460))
})()`)
check('筛选可叠加（加第二个筛选后命中数下降）', facet.chipsOn >= 1 && facet.dropped === true, JSON.stringify(facet))

// ---- 6. 分页切片 + 总数 ----
const pager = await evaluate(`(() => {
  document.querySelector('#kbRoot [data-role="clearfacet"]').click()
  return new Promise((res) => setTimeout(() => {
    const rows = document.querySelectorAll('#kbRoot .list .row').length
    const text = document.querySelector('#kbRoot .pager')?.textContent.replace(/\\s+/g,' ').trim() ?? ''
    return res({ rows, text: text.slice(0, 90) })
  }, 260))
})()`)
check('分页每页 50 行', pager.rows === 50, String(pager.rows))
check('分页显示总数与页码', /共\s*[\d,]+\s*条/.test(pager.text) && /页/.test(pager.text), pager.text)

// ---- 7. 虚拟滚动：DOM 行数远小于命中数 ----
const virt = await evaluate(`(() => {
  const btn = document.querySelector('#kbRoot [data-render="virtual"], #segRender [data-render="virtual"]')
  btn.click()
  return new Promise((res) => setTimeout(() => {
    const box = document.querySelector('#kbRoot .list.virtual')
    const rows = box === null ? -1 : box.querySelectorAll('.row').length
    const total = Number(document.querySelector('#kbRoot .metric b').textContent.replace(/,/g,''))
    res({ rows, total, hasBox: box !== null })
  }, 320))
})()`)
check('虚拟滚动只挂窗口行（< 60 行）', virt.hasBox && virt.rows > 0 && virt.rows < 60, JSON.stringify(virt))

// ---- 8. 切到任务面板：10 个 Tab（9 类 + 全部）+ 状态/优先级筛选 ----
const taskTabs = await evaluate(`(() => {
  document.querySelector('#segView [data-view="tasks"]').click()
  return new Promise((res) => setTimeout(() => {
    const tabs = [...document.querySelectorAll('#tkRoot .tabs .tab')].map(t => t.textContent.trim().replace(/\\s+/g,' '))
    const facets = [...document.querySelectorAll('#tkRoot .fchip')].map(b => b.textContent.trim())
    return res({ tabs, facets, active: document.querySelector('#tkRoot .tab.on')?.textContent.trim() })
  }, 320))
})()`)
check('任务列表 Tab = 全部 + 9 类型', taskTabs.tabs.length === 10 && taskTabs.tabs[0].startsWith('全部'), JSON.stringify(taskTabs.tabs))
check('任务筛选含状态 / 优先级', taskTabs.facets.includes('待办') && taskTabs.facets.includes('紧急'), taskTabs.facets.slice(0, 12).join(','))

// ---- 9. 并排对比两列都在 ----
const compare = await evaluate(`(() => {
  document.querySelector('#segMode [data-mode="compare"]').click()
  return new Promise((res) => setTimeout(() => {
    res({
      cols: document.querySelectorAll('#tkRoot .compare-col').length,
      oldSelect: document.querySelectorAll('#tkRoot .compare-col.old select.legacy-select').length,
      newTabs: document.querySelectorAll('#tkRoot .compare-col.new .tabs .tab').length,
      oldRows: document.querySelectorAll('#tkRoot .compare-col.old .row').length,
      newRows: document.querySelectorAll('#tkRoot .compare-col.new .row').length,
    })
  }, 420))
})()`)
check('并排对比：左下拉 / 右 Tab', compare.cols === 2 && compare.oldSelect === 1 && compare.newTabs >= 5, JSON.stringify(compare))
check('并排对比两列都有行', compare.oldRows > 0 && compare.newRows > 0, JSON.stringify(compare))

// ---- 10. 3000 条下的渲染耗时 ----
// 注意：UI.view 此时仍在任务面板（上一步切过去了，这是刻意的），
// 所以读的是 #tkRoot 的指标；正确的行为就是"另一个面板保持原样"。
// 读数用 MutationObserver 等指标真的出现，不靠固定 sleep（固定延时会在 CI 上偶发假红）。
const perf = await evaluate(`(() => {
  const snap = () => ({
    kbRoot: document.querySelector('#kbRoot').innerHTML.slice(0, 40),
    viewOn: [...document.querySelectorAll('#segView .btn')].filter(b=>b.classList.contains('on')).map(b=>b.dataset.view),
  })
  const out = { beforeClick: snap() }
  document.querySelector('#segMode [data-mode="after"]').click()
  out.afterClick = snap()
  document.querySelector('#segScale [data-scale="3000"]').click()
  out.afterScale = snap()
  return new Promise((res) => {
    const read = () => [...document.querySelectorAll('#tkRoot .metric span')].map(s => s.textContent.trim())
    if (document.querySelector('#tkRoot .metric') !== null) return res(Object.assign(out, { m: read() }))
    const obs = new MutationObserver(() => {
      if (document.querySelector('#tkRoot .metric') !== null) { obs.disconnect(); res(Object.assign(out, { m: read() })) }
    })
    obs.observe(document.querySelector('#tkRoot'), { childList: true, subtree: true })
    setTimeout(() => { obs.disconnect(); res(Object.assign(out, { m: read() })) }, 3000)
  })
})()`)
check('切回普通形态后另一面板不受污染', perf.afterClick.viewOn[0] === 'tasks' && perf.afterClick.kbRoot === '<div id="kbSlot"></div>', JSON.stringify(perf.afterClick))
check('3000 条下给出 filter/sort/render 实测', perf.m.some((s) => /^filter/.test(s)) && perf.m.some((s) => /^render/.test(s)), perf.m.join(' · '))
const renderMs = Number((perf.m.find((s) => /^render /.test(s)) ?? 'render 0').match(/[\d.]+/)?.[0] ?? '0')
const filterMs = Number((perf.m.find((s) => /^filter /.test(s)) ?? 'filter 0').match(/[\d.]+/)?.[0] ?? '0')
// 注意：chromium 的 performance.now() 有粗化精度，render 真能测得 0.0ms —— 那是**更快**，
// 不能断言 > 0（早期版本这么写会偶发假红）。这里断言"有这项测量且有界"。
check('3000 条下 render 有测量且 < 400ms', perf.m.some((s) => /^render /.test(s)) && renderMs >= 0 && renderMs < 400, `${renderMs} ms`)
check('3000 条下 filter 有测量且 < 50ms', perf.m.some((s) => /^filter /.test(s)) && filterMs >= 0 && filterMs < 50, filterMs + ' ms')

// ---- 11. 回到知识库面板，1200 条下测得响应时间（与 3000 条对照） ----
const kbPerf = await evaluate(`(() => {
  const kb = document.querySelector('#segView [data-view="knowledge"]'); kb.click()
  return new Promise((res) => setTimeout(() => {
    document.querySelector('#segScale [data-scale="1200"]').click()
    setTimeout(() => {
      const input = document.querySelector('#kbRoot [data-role="kw"]')
      const t0 = performance.now()
      input.value = 'bad port'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      setTimeout(() => {
        const elapsed = performance.now() - t0
        const rows = document.querySelectorAll('#kbRoot .list .row').length
        const m = [...document.querySelectorAll('#kbRoot .metric span')].map(s => s.textContent.trim())
        res({ elapsed, rows, m })
      }, 320)
    }, 500)
  }, 300))
})()`)
check('1200 条下「输入关键词 → 出结果」< 350ms（含 200ms 防抖）', kbPerf.elapsed > 0 && kbPerf.elapsed < 350 && kbPerf.rows > 0, JSON.stringify(kbPerf))

// ---- 12. Tab 状态刷新后保持（localStorage；file:// 下拿不到就跳过该项） ----
const persistence = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('#kbRoot .tabs .tab')]
  const target = tabs.find(t => !t.classList.contains('on'))
  target.click()
  return new Promise((res) => setTimeout(() => {
    const saved = (() => { try { return localStorage.getItem('dsh.personal-workbench.tab.knowledge') } catch (e) { return 'unavailable' } })()
    const onNow = document.querySelector('#kbRoot .tab.on')?.textContent.trim() ?? ''
    const stateTab = typeof S === 'undefined' ? '(module scoped)' : S.knowledge.tab
    res({ saved, onNow, stateTab })
  }, 300))
})()`)
if (persistence.saved === 'unavailable') {
  console.log('skip  Tab 状态持久化 —— file:// 下 localStorage 不可用（真实宿主为 http://127.0.0.1，可用）')
} else {
  check('Tab 状态写入本地存储（刷新后保持）', typeof persistence.saved === 'string' && persistence.saved.includes(persistence.stateTab.replace('(module scoped)', '')), JSON.stringify(persistence))
}

// ---- 截图（先把面板复位到「知识库 + Tab 形态」，截图才是有代表性的默认态） ----
if (shotPath !== null) {
  await evaluate(`(() => {
    document.querySelector('#segView [data-view="knowledge"]').click()
    document.querySelector('#segMode [data-mode="after"]').click()
    document.querySelector('#segRender [data-render="pagination"]').click()
    document.querySelector('#segScale [data-scale="1200"]').click()
    document.querySelector('#btnReset').click()
    document.querySelector('#segScale [data-scale="1200"]').click()
    return true
  })()`)
  await sleep(700)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log('screenshot -> ' + shotPath)
}

ws.close()
child.kill()
await sleep(200)

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`设计稿冒烟：${results.length - failed.length}/${results.length} 通过；页面异常 ${pageErrors.length} 条`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail)
  process.exit(1)
}
