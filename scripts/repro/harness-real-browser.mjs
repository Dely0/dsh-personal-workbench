/**
 * 真浏览器渲染验证（不依赖 React 运行时）。
 *
 * ## 做法
 *
 * 用 `react-dom/server` 把**真实组件**渲染成 HTML → 拼进一个真页面 → 带上**真实的 `WORKBENCH_CSS`**
 * → 在 headless Edge 里加载 → 用 CDP 做**布局与像素级断言**。
 *
 * ## 为什么必须补这一层
 *
 * - `node --test` 的 `renderToStaticMarkup` 只能验证"渲染成什么 HTML"，
 *   **真实 CSS 下的布局**（分组头、2 列网格、分页条位置、☑ 的 hover/焦点可见性）在那里不存在；
 * - 原型打样页（`demo/kb-styles/`）用的是手写假组件，证明不了这份实现；
 * - 宿主页面缓存着旧插件 bundle，重启前看不到新行为。
 *
 * ## 这一层达不到的（如实标注，不假装覆盖）
 *
 * `createPortal` 的运行时归属、`useLayoutEffect` 的滚动重算、点击后的状态变化
 * 需要 React 运行时。本机没有可用的浏览器端 bundler（esbuild 未安装；让 tsdown 把整个
 * react-dom 打进 IIFE 会卡死），所以这三点由 `test/listViews.test.mjs` 的纯函数断言
 * （`placeFolderMenu`/`folderMenuAnchor`/`samePlacement` 逐条边界）+ 变异探针覆盖，
 * 真机交互留给用户重启后手点。
 *
 * 用法：node scripts/repro/harness-real-browser.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const OUT = resolve('_local-archive/listviews/harness')
mkdirSync(OUT, { recursive: true })

const { KnowledgeList, KnowledgePager, KnowledgeToolbar, EMPTY_KNOWLEDGE_FILTERS, kindTabs, selectedKind } = await import(pathToFileURL(resolve('lib/client/components/KnowledgeList.js')).href)
const { IdeaCardGrid } = await import(pathToFileURL(resolve('lib/client/components/IdeaCardGrid.js')).href)
const { buildListPage, toContentItem } = await import(pathToFileURL(resolve('lib/client/listPresentation.js')).href)
const { WORKBENCH_CSS } = await import(pathToFileURL(resolve('lib/client/styles.js')).href)

const DAY = 86400000
const HOUR = 3600000
const NOW = Date.parse('2026-09-25T15:00:00+08:00')
const at = (msAgo) => new Date(NOW - msAgo).toISOString()

const KINDS = [
  { kind: 'knowledge_kind', code: 'note', name: '笔记', config: { color: '#4F86F7' } },
  { kind: 'knowledge_kind', code: 'lesson', name: '经验教训', config: { color: '#E7634C' } },
  { kind: 'knowledge_kind', code: 'decision', name: '决策记录', config: { color: '#8B7BE8' } },
  { kind: 'knowledge_kind', code: 'snippet', name: '片段/模板', config: { color: '#2E9B7B' } },
]
const IDEA_KINDS = [
  { kind: 'idea_kind', code: 'project', name: '项目点子', config: { color: '#4F86F7' } },
  { kind: 'idea_kind', code: 'spark', name: '突发奇想', config: { color: '#E7634C' } },
]

/** 137 条：够 3 页，跨多个时间档位，标签/类型分布明显 */
const entries = Array.from({ length: 137 }, (_, i) => toContentItem({
  id: 'k' + i,
  title: `知识条目 ${i}：cloudflared 端口 ${i % 13}`,
  contentMd: `现象：第 ${i} 条。\n原因：正文里也要能被搜到。\n解法：判定抽成纯函数。`,
  tags: i % 3 === 0 ? ['踩坑', 'DSH'] : ['性能'],
  kindCode: KINDS[i % KINDS.length].code,
  createdAt: at((i % 500) * DAY),
  updatedAt: at(i < 8 ? i * HOUR : i < 30 ? (1 + (i % 5)) * DAY : i < 60 ? (8 + (i % 20)) * DAY : (60 + i) * DAY),
}))
const ideas = Array.from({ length: 4 }, (_, i) => ({
  ...toContentItem({
    id: 'i' + i,
    title: `点子 ${i}：天线测试系统接入 AI 调试`,
    contentMd: '通过 AIDebugBridge 让 AI 自己截图、看 DOM、点 UI、读参数。',
    tags: ['AI', '天线测试'],
    kindCode: IDEA_KINDS[i % IDEA_KINDS.length].code,
    createdAt: at(30 * DAY),
    updatedAt: at((i + 1) * DAY),
  }),
  clusterIds: i === 0 ? ['f1'] : [],
}))
const CLUSTERS = [{ id: 'f1', title: '天线测试方向' }, { id: 'f2', title: '工作台优化' }]

const filters = { ...EMPTY_KNOWLEDGE_FILTERS }
const page = buildListPage({
  items: entries,
  query: { tab: selectedKind(filters), keyword: '', tags: [], sortKey: 'updatedAt', sortDir: 'desc', page: 0, pageSize: filters.pageSize },
  now: NOW,
  tabOf: (e) => e.kindCode,
  tabCodes: KINDS.map((k) => k.code),
})

const toolbar = renderToStaticMarkup(createElement(KnowledgeToolbar, {
  filters, tabs: kindTabs(KINDS, page.tabCounts), tagCounts: page.tagCounts, total: page.total,
  onChange: () => {}, onClear: () => {}, onCreate: () => {}, onSummarizeDoc: () => {},
}))
const list = renderToStaticMarkup(createElement(KnowledgeList, { page, dicts: KINDS, selectedId: 'k2', onOpen: () => {} }))
const pager = renderToStaticMarkup(createElement(KnowledgePager, { page, pageSize: 10, onPage: () => {}, onPageSize: () => {} }))
const grid = renderToStaticMarkup(createElement(IdeaCardGrid, {
  ideas, dicts: IDEA_KINDS, selectedId: 'i0', pickedIds: new Set(['i0']), clusters: CLUSTERS,
  onOpen: () => {}, onTogglePick: () => {}, onFileInto: () => {}, onCreateFolder: () => {},
}))

writeFileSync(join(OUT, 'workbench.css'), WORKBENCH_CSS)
const PAGE = join(OUT, 'harness.html')
writeFileSync(PAGE, `<!DOCTYPE html>
<html lang="zh-CN" data-dsh-personal-workbench-official data-dsh-personal-workbench-active><head><meta charset="UTF-8"><title>真组件 + 真样式渲染验证</title>
<link rel="stylesheet" href="workbench.css">
<style>
  html, body { margin:0; padding:0; background:#0f0f12; height:100%; }
  /* .wb-panel-host 是 fixed + overflow:hidden 的容器（复审 F4 的场景）
     .wb-app-scope 是它内部的**滚动区** —— 与真实面板一致 */
  .wb-app-scope { overflow: auto; }
  .pane { width: 880px; padding: 14px; box-sizing: border-box; }
  #ideas { padding-top: 24px; }
</style></head>
<body><div class="wb-panel-host" data-open="1"><div class="wb-app-scope" data-dsh-personal-workbench-view data-harness-scroller>
  <div class="pane" id="knowledge" data-kb-harness>${toolbar}${list}${pager}</div>
  <div class="pane" id="ideas">${grid}</div>
</div></div>
<script>
  // 用一个**最小替身菜单**验证 CSS 层：真菜单要 React 运行时（见文件头说明）。
  // 它的类名与内联定位方式与真菜单一致。
  window.__openStubMenu = function () {
    const anchor = document.querySelector('#ideas [data-idea-fold]')
    const box = anchor.getBoundingClientRect()
    const el = document.createElement('div')
    el.className = 'wb-idea-foldmenu'
    el.setAttribute('data-idea-foldmenu', '')
    el.style.position = 'fixed'
    el.style.top = (box.bottom + 6) + 'px'
    el.style.left = box.left + 'px'
    el.style.width = '210px'
    // 放真按钮进去：空盒子高度为 0，elementFromPoint 命中不了，也就测不出"点不动"
    for (const label of ['天线测试方向', '工作台优化', '＋新建文件夹…']) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = label
      el.appendChild(btn)
    }
    document.body.appendChild(el)   // portal 到 body，与真实现一致
    return el
  }
</script>
</body></html>`)

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
if (EDGE === undefined) { console.error('SKIP: 未找到 Edge'); process.exit(2) }

const PORT = 9800 + Math.floor(Math.random() * 150)
const profile = mkdtempSync(join(tmpdir(), 'lv-harness-'))
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1340,900', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function endpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const list_ = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list_.find((x) => x.type === 'page')
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
const pageErrors = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id); pending.delete(msg.id)
    if (msg.error !== undefined) reject(new Error(JSON.stringify(msg.error))); else ok(msg.result)
    return
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
await send('Page.navigate', { url: pathToFileURL(PAGE).href })
await sleep(1200)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : '  — ' + detail}`)
}
check('页面无脚本异常', pageErrors.length === 0, pageErrors.join(' | '))

// ---- 真样式是否真的作用上了（否则后面所有断言都是空的） ----
const styleApplied = await evaluate(`(() => {
  const cards = document.querySelector('.wb-idea-cards')
  return {
    tabsDisplay: getComputedStyle(document.querySelector('.wb-tabs')).display,
    rowDisplay: getComputedStyle(document.querySelector('.wb-kb-row')).display,
    cardsDisplay: getComputedStyle(cards).display,
    cardsCols: getComputedStyle(cards).gridTemplateColumns,
    // 用 computed style 而不是翻 cssRules：position:fixed 那条规则在 @media 块里，平铺查 cssRules 查不到
    menuPosition: (() => {
      const el = document.createElement('div')
      el.className = 'wb-idea-foldmenu'
      document.body.appendChild(el)
      const pos = getComputedStyle(el).position
      el.remove()
      return pos
    })(),
    // ☑ 的静息态必须在这里读：后面的用例会 focus 它，一旦 focus 就会被 :focus-within 显形。
    // ⚠️ 要看**未选中**那张卡：第一张是 picked，它的 ☑ 本来就该常显（单独断言）。
    pickIdleOpacity: getComputedStyle(document.querySelector('.wb-idea-card2:not(.picked) [data-idea-pick]')).opacity,
    pickedPickOpacity: getComputedStyle(document.querySelector('.wb-idea-card2.picked [data-idea-pick]')).opacity,
    paneWidth: Math.round(document.querySelector('#ideas').getBoundingClientRect().width),
    viewportWidth: window.innerWidth,
  }
})()`)
check('真样式已生效（Tab / 行 / 卡片都有布局）', styleApplied.tabsDisplay === 'flex' && styleApplied.rowDisplay === 'flex' && styleApplied.cardsDisplay === 'grid', JSON.stringify(styleApplied))
check('☑ 未选中时静息不可见（opacity 0）', styleApplied.pickIdleOpacity === '0', styleApplied.pickIdleOpacity)
check('☑ 已选中时常显（否则会忘了选过什么）', styleApplied.pickedPickOpacity === '1', styleApplied.pickedPickOpacity)
check('菜单 CSS 是 position:fixed', styleApplied.menuPosition === 'fixed', styleApplied.menuPosition)
check('卡片是 2 列网格（窗口够宽时）', styleApplied.cardsCols.split(' ').length === 2, `cols=${styleApplied.cardsCols} pane=${styleApplied.paneWidth} viewport=${styleApplied.viewportWidth}`)

// ---- 知识库：结构 + 布局 ----
const kb = await evaluate(`(() => {
  const pane = document.querySelector('#knowledge')
  const tabs = [...pane.querySelectorAll('.wb-tab')]
  const groups = [...pane.querySelectorAll('[data-kb-group]')].map((g) => g.getAttribute('data-kb-group'))
  const rows = [...pane.querySelectorAll('[data-kb-row]')]
  const pagerBox = pane.querySelector('[data-kb-pager]').getBoundingClientRect()
  const listBox = pane.querySelector('[data-kb-list]').getBoundingClientRect()
  return {
    tabCount: tabs.length,
    tabLabels: tabs.map((t) => t.textContent.trim()),
    activeTabs: tabs.filter((t) => t.classList.contains('on')).length,
    groups, rows: rows.length,
    pagerBelowList: pagerBox.top >= listBox.bottom - 1,
    rowWidth: Math.round(rows[0].getBoundingClientRect().width),
    hasSummary: (pane.querySelector('.wb-kb-sum')?.textContent ?? '').length > 5,
    hasChip: pane.querySelector('.wb-kb-chip') !== null,
    hasTags: pane.querySelector('.wb-kb-tg') !== null,
    selected: pane.querySelectorAll('.wb-kb-row.sel').length,
    groupHeadsHaveCount: [...pane.querySelectorAll('.wb-kb-gcnt')].every((c) => /^\\d+$/.test(c.textContent.trim())),
  }
})()`)
check('知识库：5 个 Tab 且只有一个高亮', kb.tabCount === 5 && kb.activeTabs === 1, JSON.stringify({ n: kb.tabCount, active: kb.activeTabs }))
check('知识库：Tab 带条数徽标', kb.tabLabels.every((l) => /\d/.test(l)), JSON.stringify(kb.tabLabels))
check('知识库：时间分组头 ≥2 且带条数', kb.groups.length >= 2 && kb.groupHeadsHaveCount, JSON.stringify(kb.groups))
check('知识库：每页 10 行（用户定的默认）', kb.rows === 10, String(kb.rows))
check('知识库：行有摘要/类型徽标/标签', kb.hasSummary && kb.hasChip && kb.hasTags, JSON.stringify({ s: kb.hasSummary, c: kb.hasChip, t: kb.hasTags }))
check('知识库：选中行有 sel 态', kb.selected === 1, String(kb.selected))
check('知识库：分页条在列表下方（没被挤到视口外）', kb.pagerBelowList === true, JSON.stringify(kb))

// ---- 工具栏：三个按钮必须在同一行且右对齐（用户要求） ----
const toolbarBox = await evaluate(`(() => {
  const bar = document.querySelector('.wb-kb-bar')
  const btn = (sel) => { const el = bar.querySelector(sel); return el === null ? null : el.getBoundingClientRect() }
  const nw = btn('[data-kb-new]'), sum = btn('[data-kb-summarize]'), clr = btn('[data-kb-clear]')
  const search = btn('[data-kb-search]'), hit = btn('[data-kb-hit]')
  const barBox = bar.getBoundingClientRect()
  // 判"同一行"用**各元素中心线**与工具栏中心线的偏差，而不是 top 相等：
  // 小字号的命中数（11.5px）与按钮（30px 高）在同一行里 top 本来就会差几像素（垂直居中）。
  const barCenter = barBox.top + barBox.height / 2
  const centered = (b) => b !== null && Math.abs((b.top + b.height / 2) - barCenter) < 4
  const sameRow = (a, b) => a !== null && b !== null && Math.abs(a.top - b.top) < 2
  return {
    barHeight: Math.round(barBox.height),
    btnRowHeight: nw === null ? 0 : Math.round(nw.height),
    tops: { search: search === null ? null : Math.round(search.top), hit: hit === null ? null : Math.round(hit.top), nw: nw === null ? null : Math.round(nw.top) },
    // 全部 5 个控件都在工具栏这一条的中心线上 ⇒ 真的只有一行
    allCenteredOnBar: [nw, sum, clr, search, hit].every(centered),
    allSameRow: sameRow(nw, sum) && sameRow(sum, clr),
    // 按钮右对齐：三个按钮都在工具栏右半边
    buttonsRightOfCenter: [nw, sum, clr].every((b) => b !== null && b.left > barBox.left + barBox.width * 0.5),
    // 左半部分（搜索/命中数）在左半边
    leftHalf: search.left < barBox.left + barBox.width * 0.5 && hit.left < barBox.left + barBox.width * 0.5,
    // 按钮没被压成竖排：宽 > 高
    noVerticalSquash: [nw, sum, clr].every((b) => b !== null && b.width > b.height),
    order: [nw, sum, clr].map((b) => (b === null ? -1 : Math.round(b.left))),
    searchWidth: search === null ? 0 : Math.round(search.width),
    spacerWidth: Math.round((bar.querySelector('.wb-kb-spacer')?.getBoundingClientRect().width) ?? 0),
    widths: [...bar.children].map((c) => ({ cls: String(c.className).replace('wb-btn ', ''), w: Math.round(c.getBoundingClientRect().width) })),
    barWidth: Math.round(barBox.width),
  }
})()`)
check('工具栏：真实宽度下搜索框够用（≥200px）', toolbarBox.searchWidth >= 200, `search=${toolbarBox.searchWidth}px 预算=${JSON.stringify(toolbarBox.widths)}`)

/**
 * 真实面板宽度下再量一次。
 *
 * 窄窗（内容区 632px）是**压力测试**：一行放不下时按用户要求"先降搜索宽度"。
 * 但真实左侧列表区是 `flex:0 0 min(56%, 880px)`，1920 屏上约 880px、1366 屏上约 709px ——
 * 所以真正要守住的是"日常宽度下搜索框够宽敞"。
 */
const wideToolbar = await evaluate(`(() => {
  const pane = document.querySelector('#knowledge')
  const prev = pane.style.width
  pane.style.width = '900px'
  const bar = document.querySelector('.wb-kb-bar')
  const box = (sel) => { const el = bar.querySelector(sel); return el === null ? null : el.getBoundingClientRect() }
  const search = box('[data-kb-search]')
  const nw = box('[data-kb-new]'), sum = box('[data-kb-summarize]'), clr = box('[data-kb-clear]')
  const barBox = bar.getBoundingClientRect()
  const result = {
    searchWidth: search === null ? 0 : Math.round(search.width),
    spacerWidth: Math.round((bar.querySelector('.wb-kb-spacer')?.getBoundingClientRect().width) ?? 0),
    allOneRow: [nw, sum, clr, search].every((b) => b !== null && Math.abs((b.top + b.height / 2) - (barBox.top + barBox.height / 2)) < 4),
    buttonsRight: [nw, sum, clr].every((b) => b !== null && b.left > barBox.left + barBox.width * 0.5),
  }
  pane.style.width = prev
  return result
})()`)
check('工具栏：真实面板宽度（900px 内容区）下搜索框宽敞（≥200px）', wideToolbar.searchWidth >= 200, JSON.stringify(wideToolbar))
check('工具栏：真实宽度下仍是一行、按钮仍右对齐', wideToolbar.allOneRow === true && wideToolbar.buttonsRight === true, JSON.stringify(wideToolbar))
check('工具栏：三按钮 + 搜索/命中数在**同一行**', toolbarBox.allCenteredOnBar === true && toolbarBox.allSameRow === true, JSON.stringify(toolbarBox))
check('工具栏：按钮右对齐、搜索与命中数左对齐', toolbarBox.buttonsRightOfCenter === true && toolbarBox.leftHalf === true, JSON.stringify(toolbarBox))
check('工具栏：按钮没被压成竖排（宽>高）', toolbarBox.noVerticalSquash === true, JSON.stringify(toolbarBox))
check('工具栏：按钮顺序为 新建 → AI 总结 → 清空筛选', toolbarBox.order[0] < toolbarBox.order[1] && toolbarBox.order[1] < toolbarBox.order[2], JSON.stringify(toolbarBox.order))
check('工具栏：只占一行（高度接近一个控件）', toolbarBox.barHeight < toolbarBox.btnRowHeight * 2, `bar=${toolbarBox.barHeight} btn=${toolbarBox.btnRowHeight}`)

// ---- 点子卡片：真布局 + hover/focus ----
const idea = await evaluate(`(async () => {
  const pane = document.querySelector('#ideas')
  const cards = [...pane.querySelectorAll('[data-idea-card]')]
  const boxes = cards.map((c) => c.getBoundingClientRect())
  const pick = pane.querySelector('[data-idea-pick]')
  const fold = pane.querySelector('[data-idea-fold]')
  // focus 是异步落焦的：必须等一帧再读 computed style，否则读到的是 focus 之前的态
  pick.focus()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const focusedOpacity = getComputedStyle(pick).opacity
  const focusVisible = document.activeElement === pick
  const pickBox = pick.getBoundingClientRect()
  const cardBox = cards[0].getBoundingClientRect()
  const result = {
    cards: cards.length,
    twoColumns: Math.abs(boxes[0].top - boxes[1].top) < 2 && Math.abs(boxes[0].left - boxes[1].left) > 100,
    equalHeights: Math.abs(boxes[0].height - boxes[1].height) < 2,
    leftBorder: getComputedStyle(cards[0]).borderLeftWidth,
    colorVar: getComputedStyle(cards[0]).getPropertyValue('--wb-idea-color').trim(),
    focusedOpacity, focusVisible,
    pickInsideCard: pickBox.top >= cardBox.top && pickBox.right <= cardBox.right + 1,
    foldDisabled: fold.disabled,
    pickedCount: pane.querySelectorAll('.wb-idea-card2.picked').length,
    pressedTrue: pane.querySelector('[aria-pressed="true"]') !== null,
  }
  pick.blur()
  return result
})()`)
check('点子：4 张卡片、2 列、等高', idea.cards === 4 && idea.twoColumns && idea.equalHeights, JSON.stringify({ n: idea.cards, two: idea.twoColumns, eq: idea.equalHeights }))
check('点子：卡片有类型色左边框', parseFloat(idea.leftBorder) >= 3 && idea.colorVar !== '', JSON.stringify({ border: idea.leftBorder, color: idea.colorVar }))
check('点子：键盘聚焦后 ☑ 可见（复审 F6）', idea.focusVisible === true && idea.focusedOpacity === '1', JSON.stringify({ focus: idea.focusVisible, op: idea.focusedOpacity }))
check('点子：☑ 在卡片内部（没飘出去）', idea.pickInsideCard === true, JSON.stringify(idea))
check('点子：已选卡片有 picked + aria-pressed', idea.pickedCount === 1 && idea.pressedTrue === true, JSON.stringify({ picked: idea.pickedCount, pressed: idea.pressedTrue }))
check('点子：有文件夹时「归入文件夹」可点', idea.foldDisabled === false, String(idea.foldDisabled))

// ---- 菜单（CSS 层替身）：fixed + 不被 overflow 祖先裁 + 不随滚动移动 ----
// 先把按钮滚进视口：替身只按"按钮下方"摆，不像真 placeFolderMenu 那样会翻转到视口内
await evaluate(`document.querySelector('#ideas').scrollIntoView({ block: 'center' })`)
await sleep(300)
const menu = await evaluate(`(async () => {
  const el = window.__openStubMenu()
  const scroller = document.querySelector('.wb-app-scope')
  const boxBefore = el.getBoundingClientRect()
  // 命中「菜单里的一项」——菜单容器本身是 pointer-events:none（两段式的第一段），
  // 只有它的子元素可点；探容器内边距会永远命不中，测的就不是真问题了。
  const probe = el.querySelector('button')
  const hitAtRest = (() => { const r = probe.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === probe })()
  scroller.scrollBy(0, 40)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const boxAfter = el.getBoundingClientRect()
  const hit = (() => { const r = probe.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === probe : hitAtRest })()
  return {
    parentIsBody: el.parentElement === document.body,
    anchorVisible: boxBefore.top > 0 && boxBefore.bottom < innerHeight,
    inViewport: (() => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight })(),
    hitAtRest,
    position: getComputedStyle(el).position,
    // overflow:auto 的祖先**不是** fixed 的包含块：滚动后视口坐标应当不变（证明前提正确）
    viewportStable: Math.round(boxBefore.top) === Math.round(boxAfter.top) && Math.round(boxBefore.left) === Math.round(boxAfter.left),
    scrolled: scroller.scrollTop,
    // 面板的 overflow 裁不住 fixed 元素：它仍然可被命中
    hitTestable: hit,
    insideViewport: boxAfter.left >= 0 && boxAfter.top >= 0,
  }
})()`)
check('菜单：portal 到 body（复审 F4）', menu.parentIsBody === true, String(menu.parentIsBody))
check('菜单：position 为 fixed', menu.position === 'fixed', menu.position)
check('菜单：不被面板的 overflow 裁掉（仍可命中，pointer-events 两段式生效）', menu.hitAtRest === true, JSON.stringify({ hit: menu.hitAtRest, anchorVisible: menu.anchorVisible, inViewport: menu.inViewport }))
check('菜单：滚动时视口坐标不变（证明 overflow 祖先不是包含块）', menu.viewportStable === true && menu.scrolled > 0, JSON.stringify(menu))
check('菜单：整块在视口内', menu.insideViewport === true, String(menu.insideViewport))

// 截图前把面板滚回顶部、并移掉那个浮动菜单：
// 菜单是 fixed（不随滚动移动，这是设计使然），留着会压在知识库列表上，截图会误导人。
// 工具栏与 Tab 条在顶部，是这次改动最该看的地方。
await evaluate(`(() => {
  document.querySelector('.wb-app-scope').scrollTop = 0
  document.querySelector('[data-idea-foldmenu]')?.remove()
  return true
})()`)
await sleep(250)
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(OUT, 'real-render.png'), Buffer.from(shot.data, 'base64'))

ws.close(); child.kill(); await sleep(200)
rmSync(profile, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`真组件 + 真样式渲染验证：${results.length - failed.length}/${results.length} 通过；截图 ${join(OUT, 'real-render.png')}`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail)
  process.exit(1)
}



