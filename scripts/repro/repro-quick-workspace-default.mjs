/**
 * 快速录入「默认工作区被上一次执行的任务污染」——真机复现 / 验收脚本。
 *
 * ## 复现的用户步骤（与任务验收标准一一对应）
 *
 * 1. 打开工作台 → 在「任务」里点开任务 A（工作区 X）—— 这一步是「AI 执行」的**前置条件**
 *    （「AI 执行」按钮只在任务详情里出现，点了它会 `closePanel()` 把面板收起来）；
 * 2. 点「返回对话」把面板收起（= `startAISession` 结尾的 `closePanel()`，同一条路径）；
 * 3. 再点「打开工作台」→ 面板回来时**任务详情还在**（React 树从未卸载）→ 点「快速录入」；
 * 4. 读 `input[name="quick-workspace"]` 的值 —— 这就是"快速录入的默认工作区"。
 *
 * - 修前：等于 X（被上一次执行的任务工作区污染）；
 * - 修后：等于「上次手动选择的值（settings.quickWorkspaceRecent[0]）」或「默认工作区」。
 *
 * 为什么用「收起/展开面板」而不是真去点「AI 执行」：真点会向模型发一次执行提示词并**真的开始干活**。
 * 执行这一步对客户端状态的效果只有 `closePanel()`（`src/client/index.tsx` 里 `startAISession`
 * 结尾），会话本身不触碰任何快速录入状态；本脚本复现的就是这条 `closePanel()` 路径。
 *
 * 用法：
 *   node scripts/repro/repro-quick-workspace-default.mjs --token <DSH token> [--expect buggy|stable] \
 *        [--task <taskId>] [--out _local-archive/quick-workspace-default]
 *
 * `--expect` 与实测不符时以非零码退出（可当验收门禁用）。
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
const EXPECT = arg('expect')
const WANT_TASK = arg('task')
const OUT = arg('out', '_local-archive/quick-workspace-default')
const HOST = arg('host', 'http://127.0.0.1:3080')

if (TOKEN === '') {
  console.error('缺少 --token（从 ~/.dsh/logs/dsh-web.log 的 "dsh web: http://127.0.0.1:3080/?token=..." 取）')
  process.exit(2)
}
if (EDGE === undefined) {
  console.error('找不到 Edge')
  process.exit(2)
}

// ------------------------------------------------------------------ 选目标任务
const apiJson = async (path) => await (await fetch(`${HOST}${path}`)).json()
const settingsRes = await apiJson('/api/workbench/settings')
const tasksRes = await apiJson('/api/workbench/tasks')
const settings = settingsRes.settings
const candidates = tasksRes.tasks.filter((t) => typeof t.effectiveWorkspacePath === 'string' && t.effectiveWorkspacePath !== '')
const target = WANT_TASK === ''
  ? candidates.find((t) => t.statusCode !== 'done' && t.statusCode !== 'cancelled') ?? candidates[0]
  : tasksRes.tasks.find((t) => t.id === WANT_TASK)
if (target === undefined) {
  console.error('找不到带工作区的目标任务（用 --task <id> 指定）')
  process.exit(2)
}
const taskWorkspace = target.effectiveWorkspacePath
const recent = Array.isArray(settings.quickWorkspaceRecent) ? settings.quickWorkspaceRecent : []
const stableDefault = (recent[0] ?? '') !== '' ? recent[0] : settings.defaultWorkspace
console.log('目标任务 :', target.id, '|', target.title)
console.log('任务工作区 X :', taskWorkspace)
console.log('设置.defaultWorkspace :', JSON.stringify(settings.defaultWorkspace))
console.log('设置.quickWorkspaceRecent :', JSON.stringify(recent))
console.log('修后应看到的稳定默认值 :', JSON.stringify(stableDefault))

// ------------------------------------------------------------------ CDP
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

const port = await freePort()
const profile = mkdtempSync(join(tmpdir(), 'wb-wsrepro-'))
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1440,900',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })

let exitCode = 0
let browserWs = null
try {
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

  const loaded = once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: `${HOST}/?token=${TOKEN}` })
  await loaded

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`页面内异常：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (expression, label, timeoutMs = 15000) => {
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
  /** 真实鼠标事件（程序化 el.click() 不可靠；见项目 skill 第 13 条）。 */
  const clickPoint = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    }
    await sleep(120)
  }
  const clickSelector = async (selector, label, index = 0) => {
    const rect = await evaluate(`(() => {
      const list = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      const el = list[${index}]
      if (el === undefined) return null
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return null
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
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
  const readQuickWorkspace = async () => await evaluate(`document.querySelector('input[name="quick-workspace"]')?.value ?? null`)

  // ---------------------------------------------------------------- 步骤 1：打开工作台
  await until(`document.querySelector('.wb-panel-host') !== null`, '客户端装载出工作台面板容器', 30000)
  await clickSelector('[aria-label^="打开工作台"]', '打开工作台')
  await until(`document.querySelector('.wb-panel-host')?.getAttribute('data-open') === '1'`, '面板 data-open=1')
  await shot('01-panel-open')

  // ---------------------------------------------------------------- 步骤 2：选中任务 A
  await clickByText('.wb-seg', '任务', '「任务」标签页')
  await sleep(400)
  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder="搜索标题 / 描述"]')
    if (input === null) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(target.title.slice(0, 12))})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(500)
  const rows = await evaluate(`Array.from(document.querySelectorAll('.wb-row .wb-row-title')).map((el) => el.textContent)`)
  const rowIndex = rows.findIndex((text) => String(text) === target.title)
  if (rowIndex === -1) {
    console.log('筛选后列表里的标题：', JSON.stringify(rows.slice(0, 12)))
    throw new Error(`列表里找不到任务「${target.title}」的行`)
  }
  await clickSelector('.wb-row', `任务行「${target.title}」`, rowIndex)
  await until(`document.querySelector('.wb-detail')?.textContent?.includes(${JSON.stringify(target.title)}) === true`, '任务详情里出现目标任务')
  // 详情右侧「AI 工作区：」那行应当就是 X —— 这是「执行时会用任务自己的工作区」的现场证据
  const detailWorkspaceLine = await evaluate(`(document.querySelector('.wb-detail')?.textContent ?? '').match(/AI 工作区：[^\\n]*/)?.[0] ?? null`)
  await shot('02-task-selected')

  // ---------------------------------------------------------------- 步骤 3：快速录入（选中任务之后）
  await clickByText('.wb-btn', '快速录入', '「快速录入」按钮')
  await until(`document.querySelector('input[name="quick-workspace"]') !== null`, '快速录入弹窗的默认工作区输入框')
  const beforeClose = await readQuickWorkspace()
  const sourceHintBefore = await evaluate(`document.querySelector('input[name="quick-workspace"]')?.closest('.wb-field')?.querySelector('.wb-field-note')?.textContent ?? null`)
  await shot('03-quick-entry-after-select')
  await clickByText('.wb-btn', '取消', '「取消」关闭快速录入')
  await until(`document.querySelector('input[name="quick-workspace"]') === null`, '快速录入弹窗已关闭')

  // ---------------------------------------------------------------- 步骤 4：收起面板（= 执行结束时的 closePanel）
  await clickByText('.wb-btn', '返回对话', '「返回对话」收起面板')
  await until(`document.querySelector('.wb-panel-host')?.getAttribute('data-open') === null`, '面板已收起（data-open 移除）')
  const selectedSurvivedHidden = await evaluate(`document.querySelector('.wb-detail')?.textContent?.includes(${JSON.stringify(target.title)}) === true`)
  await shot('04-panel-closed')

  // ---------------------------------------------------------------- 步骤 5：再打开 → 再快速录入
  await clickSelector('[aria-label^="打开工作台"]', '再次打开工作台')
  await until(`document.querySelector('.wb-panel-host')?.getAttribute('data-open') === '1'`, '面板重新打开')
  const selectedSurvivedReopen = await evaluate(`document.querySelector('.wb-detail')?.textContent?.includes(${JSON.stringify(target.title)}) === true`)
  await shot('05-panel-reopened')
  await clickByText('.wb-btn', '快速录入', '「快速录入」按钮（第二次）')
  await until(`document.querySelector('input[name="quick-workspace"]') !== null`, '快速录入弹窗（第二次）')
  const afterReopen = await readQuickWorkspace()
  const sourceHintAfter = await evaluate(`document.querySelector('input[name="quick-workspace"]')?.closest('.wb-field')?.querySelector('.wb-field-note')?.textContent ?? null`)
  await shot('06-quick-entry-after-reopen')

  // ---------------------------------------------------------------- 判定
  const same = (a, b) => String(a ?? '').trim().replace(/[\\/]+$/, '').toLowerCase() === String(b ?? '').trim().replace(/[\\/]+$/, '').toLowerCase()
  const polluted = same(afterReopen, taskWorkspace) && !same(afterReopen, stableDefault)
  const verdict = polluted ? 'buggy' : 'stable'
  const report = {
    at: new Date().toISOString(),
    task: { id: target.id, title: target.title, workspacePath: target.workspacePath, effectiveWorkspacePath: taskWorkspace },
    detailWorkspaceLine,
    settings: { defaultWorkspace: settings.defaultWorkspace, quickWorkspaceRecent: recent },
    stableDefault,
    quickWorkspace: { afterSelect: beforeClose, afterReopen, sourceHintAfterSelect: sourceHintBefore, sourceHintAfterReopen: sourceHintAfter },
    selectedSurvived: { whileClosed: selectedSurvivedHidden, afterReopen: selectedSurvivedReopen },
    verdict,
  }
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'repro-result.json'), JSON.stringify(report, null, 2))
  console.log('\n=== 复现结果 ===')
  console.log(JSON.stringify(report, null, 2))

  if (EXPECT !== '' && EXPECT !== verdict) {
    console.error(`\n❌ 期望 ${EXPECT}，实测 ${verdict}`)
    exitCode = 1
  } else if (EXPECT !== '') {
    console.log(`\n✅ 期望 ${EXPECT}，实测一致`)
  }
  cdp.close()
} catch (error) {
  console.error('复现失败：', error)
  exitCode = 1
} finally {
  if (browserWs !== null) {
    try {
      const browser = newCdpClient(browserWs)
      await browser.ready
      await browser.send('Browser.close')
      browser.close()
    } catch { /* 关不掉就 kill */ }
  }
  child.kill()
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* 忽略 */ }
}
process.exit(exitCode)
