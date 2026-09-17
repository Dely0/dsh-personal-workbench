/**
 * 真机复现：「任务设置页可改耗时，改完**不刷新**立即影响今日容量，刷新后保持」。
 *
 * ## 为什么必须自带库隔离（fresh-eyes 审查第 3 条）
 * 这个脚本打的是**用户真实库**（跑中的 DSH 实例）。早先的方案写的是"改用户某个任务的耗时"——
 * 那会往生产库写不可逆的脏数据（用户根本不知道自己的任务被改过）。
 * 现在的做法：整个验证只在**一条临时任务**上做，且临时任务的创建与删除都通过 API 完成：
 *
 *   create → 断言（含 F5 刷新） → finally 删除并断言删除成功
 *
 * 即使中间任何一步抛错，`finally` 也会删；删不掉就**非零退出**并明确报错，
 * 绝不留下"多出来一条任务"的现场。
 *
 * ## 这一步验的是单测覆盖不到的东西
 * 单测用桩验证 payload 与乐观更新逻辑；harness 验证真 CSS 下的布局与文案。
 * 只有这里能验证真实链路：**真的点到编辑弹窗、真的发 PATCH、真的落库、真的刷新后还在**。
 *
 * 用法：
 *   node scripts/repro/repro-task-estimate.mjs --token <DSH token> [--out <dir>]
 * token 从 `~/.dsh/logs/dsh-web.log` 里的 "dsh web: http://127.0.0.1:3080/?token=..." 取。
 *
 * 前置：插件已装盘且 DSH 已重启（否则跑中的实例是旧 bundle，脚本会明确报"接线缺失"）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const args = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : String(args[index + 1] ?? '')
}
const TOKEN = arg('token')
const OUT = arg('out', '_local-archive/capacity/repro')
const HOST = arg('host', 'http://127.0.0.1:3080')
/** 临时任务标题前缀：扫库时一眼能认出这是复现脚本的产物（万一清理失败便于人工处理）。 */
const TEMP_PREFIX = '__capacity-repro__'
/** 本次要设的耗时：取一个"不太可能与其他任务的默认 30 撞上"的值，便于对账。 */
const TARGET_MINUTES = 123

if (TOKEN === '') {
  console.error('缺少 --token（从 ~/.dsh/logs/dsh-web.log 的 "dsh web: http://127.0.0.1:3080/?token=..." 取）')
  process.exit(2)
}
if (EDGE === undefined) {
  console.error('找不到 Edge')
  process.exit(2)
}

const apiJson = async (path, init) => {
  const res = await fetch(`${HOST}${path}`, init)
  const text = await res.text()
  let body = null
  try { body = text === '' ? null : JSON.parse(text) } catch { body = { raw: text } }
  return { status: res.status, body }
}
const post = (path, payload) => apiJson(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})

/** 本地日 18:00 的 ISO（让临时任务落在"今天到期"分支 → 会计入今日容量）。 */
const todayDueAt = () => {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0, 0).toISOString()
}

// ------------------------------------------------------------------ 建临时任务
const created = await post('/api/workbench/tasks', {
  title: `${TEMP_PREFIX}耗时验证-${Date.now()}`,
  typeCode: 'code_impl',
  priorityCode: 'p2',
  statusCode: 'todo',
  dueAt: todayDueAt(),
  description: '由 scripts/repro/repro-task-estimate.mjs 创建，用于验证"改耗时立即影响已排"，结束时会被删除。',
})
if (created.status !== 200 && created.status !== 201) {
  console.error(`建临时任务失败（${created.status}）：${JSON.stringify(created.body)}`)
  process.exit(1)
}
const TEMP_ID = created.body?.task?.id
if (typeof TEMP_ID !== 'string' || TEMP_ID === '') {
  console.error(`建临时任务没有拿到 id：${JSON.stringify(created.body)}`)
  process.exit(1)
}
const TEMP_TITLE = created.body.task.title
console.log(`临时任务 : ${TEMP_ID} | ${TEMP_TITLE}`)
console.log(`目标耗时 : ${TARGET_MINUTES} 分钟（初始未设置 → 按默认计时）`)

/**
 * 清理临时任务。
 *
 * ⚠️ **工作台没有 DELETE 任务端点**（我第一版就是按 DELETE 写的，实测拿到
 * `{"error":"not found"}`，于是清理失败、在用户库里留下一条 `__capacity-repro__` 任务）。
 * 任务的终结语义只有两种：**取消**（status=cancelled）与**归档**（archived=true）。
 * 这里两步都做：
 * - 取消 → 它绝不会进任何活跃视图与容量账本；
 * - 归档 → 从任务列表彻底隐藏（列表默认只返回非归档）。
 * 两步幂等（重复调用结果一致），且清理后**回读活跃列表与归档列表**双确认。
 */
async function cleanup() {
  const cancelled = await apiJson(`/api/workbench/tasks/${TEMP_ID}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ statusCode: 'cancelled', title: `${TEMP_TITLE}（已由复现脚本清理）` }),
  })
  const archived = await post(`/api/workbench/tasks/${TEMP_ID}/archive`, {})
  const activeList = await apiJson('/api/workbench/tasks')
  const stillActive = Array.isArray(activeList.body?.tasks) && activeList.body.tasks.some((t) => t.id === TEMP_ID)
  const archivedList = await apiJson('/api/workbench/tasks?archived=true')
  const inArchive = Array.isArray(archivedList.body?.tasks) && archivedList.body.tasks.some((t) => t.id === TEMP_ID)
  console.log(`清理：PATCH=${cancelled.status} / archive=${archived.status} / 活跃列表仍可见=${stillActive} / 归档列表可见=${inArchive}`)
  if (stillActive) {
    console.error(`❌ 清理失败：临时任务 ${TEMP_ID}（${TEMP_TITLE}）仍在活跃列表里`)
    return false
  }
  if (!inArchive) {
    // 也算成功（已被彻底移除），但要说清楚，避免把"真的没了"误读成"清理没找到"
    console.log('（提示：归档列表里也没有它 —— 已被彻底移除，同样算清理成功）')
  }
  console.log(`临时任务已取消并归档，活跃列表回读确认不可见：${TEMP_ID}`)
  return true
}

let exitCode = 0
let cleaned = false
let browserWs = null
let child = null
let profile = null

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

try {
  const port = await freePort()
  profile = mkdtempSync(join(tmpdir(), 'wb-estimate-'))
  child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1440,1000',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' })

  const deadline = Date.now() + 25000
  let version = null
  while (version === null) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() } catch { version = null }
    if (version === null && Date.now() > deadline) throw new Error('Edge 没在 25s 内打开 DevTools 端口')
    if (version === null) await new Promise((r) => setTimeout(r, 200))
  }
  browserWs = version.webSocketDebuggerUrl
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  const cdp = newCdpClient(page.webSocketDebuggerUrl)
  await cdp.ready
  const once = (method) => new Promise((res) => cdp.on((m) => { if (m.method === method) res(m) }))
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`页面内异常：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result.value
  }
  const until = async (expression, label, timeoutMs = 20000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await evaluate(expression) === true) return true
      await sleep(150)
    }
    throw new Error(`等待超时：${label}`)
  }
  const shot = async (name) => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  /** 真实鼠标事件（程序化 el.click() 不可靠 —— 见项目 skill 第 13 条）。 */
  const clickPoint = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    }
    await sleep(140)
  }
  const rectOf = async (selector, index = 0) => await evaluate(`(() => {
    const list = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
    const el = list[${index}]
    if (el === undefined) return null
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  const clickSelector = async (selector, label, index = 0) => {
    const rect = await rectOf(selector, index)
    if (rect === null) throw new Error(`找不到可点的元素：${label}（${selector}[${index}]）`)
    await clickPoint(rect.x, rect.y)
  }
  const clickByText = async (selector, text, label) => {
    const rect = await evaluate(`(() => {
      const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((node) => (node.textContent || '').trim().includes(${JSON.stringify(text)}))
      if (el === undefined) return null
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return null
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (rect === null) throw new Error(`找不到可点的元素：${label}（含文本「${text}」）`)
    await clickPoint(rect.x, rect.y)
  }
  /** 读容量条头部那句「已排 N min」。 */
  const readPlanned = async () => await evaluate(`(() => {
    const m = (document.querySelector('.wb-cap-meta')?.textContent ?? '').match(/已排\\s*(\\d+)\\s*min/)
    return m === null ? null : Number(m[1])
  })()`)
  const readDetailEstimate = async () => await evaluate(`(() => {
    const m = (document.querySelector('.wb-detail')?.textContent ?? '').match(/预计耗时：([^\\n·]*)/)
    return m === null ? null : m[1].trim()
  })()`)
  /** 在弹窗里写 input 值：必须走原生 setter + input 事件，否则 React 收不到。 */
  const setInputValue = async (selector, value) => await evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (input === null) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(String(value))})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

  const loadPage = async (label) => {
    const loaded = once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url: `${HOST}/?token=${TOKEN}` })
    await loaded
    await until(`document.querySelector('.wb-panel-host') !== null`, `${label}：面板容器出现`, 30000)
  }

  // ---------------------------------------------------------------- 步骤 0：打开工作台
  await loadPage('初次加载')
  await clickSelector('[aria-label^="打开工作台"]', '打开工作台')
  await until(`document.querySelector('.wb-panel-host')?.getAttribute('data-open') === '1'`, '面板 data-open=1')

  // 接线前提：本次改动（容量账本 / 预计耗时）必须在跑中的 bundle 里，否则验的是旧代码
  const wiring = await evaluate(`({
    capRule: document.querySelector('.wb-cap-rule') !== null,
    capMeta: document.querySelector('.wb-cap-meta') !== null,
  })`)
  if (wiring.capRule !== true || wiring.capMeta !== true) {
    throw new Error(`接线缺失：跑中的客户端 bundle 里没有新版容量面板（capRule=${wiring.capRule} / capMeta=${wiring.capMeta}）—— 需要先装盘并重启 DSH，再跑本脚本`)
  }

  // ---------------------------------------------------------------- 步骤 1：选中临时任务
  await clickByText('.wb-seg', '任务', '「任务」标签页')
  await sleep(400)
  await setInputValue('input[placeholder="搜索标题 / 描述"]', TEMP_TITLE.slice(0, 16))
  await sleep(600)
  const rows = await evaluate(`Array.from(document.querySelectorAll('.wb-row .wb-row-title')).map((el) => el.textContent)`)
  const rowIndex = rows.findIndex((text) => String(text) === TEMP_TITLE)
  if (rowIndex === -1) {
    console.log('筛选后列表里的标题：', JSON.stringify(rows.slice(0, 12)))
    throw new Error(`列表里找不到临时任务「${TEMP_TITLE}」的行`)
  }
  await clickSelector('.wb-row', `临时任务行`, rowIndex)
  await until(`document.querySelector('.wb-detail')?.textContent?.includes(${JSON.stringify(TEMP_TITLE)}) === true`, '详情里出现临时任务')

  // 回到「今日」页读「已排」（容量条在今日页）
  await clickByText('.wb-seg', '今日', '「今日」标签页')
  await until(`document.querySelector('.wb-cap-meta') !== null`, '今日容量条出现')
  await sleep(500)
  const plannedBefore = await readPlanned()
  await shot('01-before')
  console.log(`改之前「已排」 : ${plannedBefore} min`)

  // ---------------------------------------------------------------- 步骤 2：改耗时 → 不刷新读「已排」
  await clickByText('.wb-seg', '任务', '「任务」标签页（回去选任务）')
  await sleep(400)
  await setInputValue('input[placeholder="搜索标题 / 描述"]', TEMP_TITLE.slice(0, 16))
  await sleep(500)
  await clickSelector('.wb-row', `临时任务行（第二次）`, rowIndex)
  await until(`document.querySelector('.wb-detail') !== null`, '任务详情出现')
  const detailBefore = await readDetailEstimate()
  console.log(`改之前详情行   : 预计耗时：${detailBefore}`)

  await clickByText('.wb-btn', '编辑', '「编辑」按钮')
  await until(`document.querySelector('input[type="number"][min="1"][max="1440"]') !== null`, '编辑弹窗里的耗时输入框（接线缺失会在这里超时）')
  const prefilled = await evaluate(`document.querySelector('input[type="number"][min="1"][max="1440"]').value`)
  await shot('02-dialog')
  await setInputValue('input[type="number"][min="1"][max="1440"]', TARGET_MINUTES)
  await sleep(150)
  await clickByText('.wb-btn', '保存', '弹窗「保存」')
  await until(`document.querySelector('input[type="number"][min="1"][max="1440"]') === null`, '弹窗已关闭（保存完成）')
  await sleep(400)

  const detailAfter = await readDetailEstimate()
  await clickByText('.wb-seg', '今日', '「今日」标签页')
  await until(`document.querySelector('.wb-cap-meta') !== null`, '今日容量条出现（改后）')
  await sleep(600)
  const plannedAfter = await readPlanned()
  await shot('03-after-save-no-reload')
  console.log(`改之后「已排」（未刷新） : ${plannedAfter} min`)

  // ---------------------------------------------------------------- 步骤 3：F5 后仍是目标值
  await loadPage('刷新后')
  await clickSelector('[aria-label^="打开工作台"]', '打开工作台（刷新后）')
  await until(`document.querySelector('.wb-panel-host')?.getAttribute('data-open') === '1'`, '面板重新打开')
  await clickByText('.wb-seg', '任务', '「任务」标签页（刷新后）')
  await sleep(400)
  await setInputValue('input[placeholder="搜索标题 / 描述"]', TEMP_TITLE.slice(0, 16))
  await sleep(600)
  const rows2 = await evaluate(`Array.from(document.querySelectorAll('.wb-row .wb-row-title')).map((el) => el.textContent)`)
  const rowIndex2 = rows2.findIndex((text) => String(text) === TEMP_TITLE)
  if (rowIndex2 === -1) throw new Error('刷新后列表里找不到临时任务')
  await clickSelector('.wb-row', '临时任务行（刷新后）', rowIndex2)
  await until(`document.querySelector('.wb-detail') !== null`, '刷新后任务详情出现')
  const detailAfterReload = await readDetailEstimate()
  await clickByText('.wb-btn', '编辑', '「编辑」按钮（刷新后）')
  await until(`document.querySelector('input[type="number"][min="1"][max="1440"]') !== null`, '刷新后编辑弹窗的耗时输入框')
  const prefilledAfterReload = await evaluate(`document.querySelector('input[type="number"][min="1"][max="1440"]').value`)
  await shot('04-after-reload')
  await clickByText('.wb-btn', '取消', '关闭弹窗')

  // 库里也直接读一次（界面之外的第二条证据）
  const fromApi = await apiJson(`/api/workbench/tasks/${TEMP_ID}`)
  const storedMinutes = fromApi.body?.task?.estimatedMinutes ?? null
  console.log(`界面详情行（刷新后） : 预计耗时：${detailAfterReload}`)
  console.log(`弹窗回显（刷新后）   : ${prefilledAfterReload}`)
  console.log(`库里 estimatedMinutes : ${storedMinutes}`)

  // ---------------------------------------------------------------- 步骤 4：非法输入不发请求
  await clickByText('.wb-btn', '编辑', '「编辑」按钮（校验用例）')
  await until(`document.querySelector('input[type="number"][min="1"][max="1440"]') !== null`, '编辑弹窗（校验用例）')
  await setInputValue('input[type="number"][min="1"][max="1440"]', '99999')
  await sleep(150)
  await clickByText('.wb-btn', '保存', '弹窗「保存」（校验用例）')
  await sleep(600)
  // 仍然停在弹窗里（保存被阻止）＋ 有红字提示
  const blocked = await evaluate(`(() => {
    const stillOpen = document.querySelector('input[type="number"][min="1"][max="1440"]') !== null
    const toast = document.body.textContent.includes('耗时必须是 1–1440')
    return { stillOpen, toast }
  })()`)
  await shot('05-invalid-blocked')
  await clickByText('.wb-btn', '取消', '关闭弹窗（校验用例）')

  const storedAfterInvalid = (await apiJson(`/api/workbench/tasks/${TEMP_ID}`)).body?.task?.estimatedMinutes ?? null

  // ---------------------------------------------------------------- 判定
  const checks = [
    { name: '改之前临时任务未单独设耗时（走默认）', ok: detailBefore !== null && String(detailBefore).includes('默认'), detail: `详情行=${detailBefore}` },
    { name: `详情行不刷新就显示「${TARGET_MINUTES} 分钟」`, ok: detailAfter !== null && String(detailAfter).includes(String(TARGET_MINUTES)), detail: `详情行=${detailAfter}` },
    { name: `不刷新时「已排」正好增加 ${TARGET_MINUTES} min`, ok: plannedBefore !== null && plannedAfter === plannedBefore + TARGET_MINUTES, detail: `${plannedBefore} → ${plannedAfter}` },
    { name: `F5 后详情行仍是「${TARGET_MINUTES} 分钟」`, ok: String(detailAfterReload).includes(String(TARGET_MINUTES)), detail: `详情行=${detailAfterReload}` },
    { name: `F5 后重开弹窗回显 ${TARGET_MINUTES}`, ok: String(prefilledAfterReload) === String(TARGET_MINUTES), detail: `弹窗=${prefilledAfterReload}` },
    { name: `库里 estimatedMinutes = ${TARGET_MINUTES}`, ok: storedMinutes === TARGET_MINUTES, detail: `库=${String(storedMinutes)}` },
    { name: '非法输入（99999）不发请求：弹窗不关、有红字、库里值不变', ok: blocked.stillOpen === true && blocked.toast === true && storedAfterInvalid === TARGET_MINUTES, detail: JSON.stringify({ ...blocked, stored: storedAfterInvalid }) },
  ]
  const report = {
    at: new Date().toISOString(),
    tempTask: { id: TEMP_ID, title: TEMP_TITLE, targetMinutes: TARGET_MINUTES },
    observed: { plannedBefore, plannedAfter, detailBefore, detailAfter, detailAfterReload, prefilledBefore: prefilled, prefilledAfterReload, storedMinutes, storedAfterInvalid, blocked },
    checks,
    verdict: checks.every((c) => c.ok) ? 'pass' : 'fail',
  }
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'repro-task-estimate.json'), JSON.stringify(report, null, 2))
  console.log('\n=== 结果 ===')
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail === '' ? '' : '  — ' + c.detail}`)
  cdp.close()
  if (report.verdict !== 'pass') exitCode = 1
} catch (error) {
  console.error('复现失败：', error instanceof Error ? error.message : error)
  exitCode = 1
} finally {
  // ⚠️ 清理必须在**退出之前**完成，且必须断言"真的删掉了"：
  // 留一条 `__capacity-repro__` 任务在用户库里，比脚本失败严重得多。
  try {
    cleaned = await cleanup()
  } catch (error) {
    console.error('清理时抛错：', error instanceof Error ? error.message : error)
    cleaned = false
  }
  if (!cleaned) exitCode = 1
  if (browserWs !== null) {
    try {
      const browser = newCdpClient(browserWs)
      await browser.ready
      await browser.send('Browser.close')
      browser.close()
    } catch { /* 关不掉就 kill */ }
  }
  if (child !== null) child.kill()
  if (profile !== null) {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* 忽略 */ }
  }
}
process.exit(exitCode)
