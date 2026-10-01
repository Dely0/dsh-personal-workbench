/**
 * 零依赖 CDP 驱动（从机-local 的 `.pwtest/cdp.mjs` 搬进仓库，plan.md V02 / AX-V02）。
 *
 * ## 为什么不用 browser-use / 浏览器 MCP
 *
 * 那条路线要 pip 安装 + 给**正在使用的**浏览器开远程调试并人工点允许。这里改成
 * "另开一个独立调试实例"：独立 `user-data-dir`、独立 CDP 端口，不碰用户当前窗口。
 * 选型理由已记在 docs/adr/0006-dev-verify-chain.md。
 *
 * ## 两条命门（搬运时逐字保留，删掉任意一条都会静默假绿）
 *
 * 1. **独立 `user-data-dir`**（`--user-data-dir=<mkdtemp>`）：Windows 上 `msedge.exe` 只是启动器，
 *    命令行会被**转发**给已开着的同 profile 实例 —— 表现是"什么都不发生、还 exit 0"。
 *    （团队记忆 01M2MZCGFAW11C08K4VQ26NQV4）
 * 2. **每次 CDP 调用 30s 超时**：把"永久挂住、不报错、无输出"变成一条可读报错。
 *    根因通常是渲染进程被对话框/崩溃挂起，此时 `Runtime.evaluate` 的 Promise 永不 settle。
 *
 * 另外三条本轮新增的纪律：独立 CDP 端口（不再写死一个固定端口）、浏览器路径由
 * `scripts/verify/browser.mjs` 发现（不再硬编码 Edge 路径）、`close()` **只**关自己起的
 * 那个进程与自己的临时目录。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_CALL_TIMEOUT_MS = 30000
export const DEFAULT_READY_TIMEOUT_MS = 15000
export const DEFAULT_PROFILE_PREFIX = 'dsh-verify-cdp-'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 单次 CDP 调用超时（30s）—— 判据里直接断言这个数。 */
export class Cdp {
  /**
   * @param {any} ws 一个 WebSocket 形状的对象（Node 24 内置 WebSocket，测试里可以塞假货）
   * @param {{callTimeoutMs?: number}} [options]
   */
  constructor(ws, options = {}) {
    this.ws = ws
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.nextId = 1
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id)
        if (entry === undefined) return
        this.pending.delete(msg.id)
        if (msg.error !== undefined) entry.reject(new Error(`${msg.error.message ?? 'cdp error'} (${entry.method})`))
        else entry.resolve(msg.result)
        return
      }
      for (const listener of this.listeners) listener(msg)
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`CDP 调用超时（${this.callTimeoutMs}ms，方法 ${method}）—— 页面可能被对话框/挂起阻塞`))
      }, this.callTimeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.ws.send(JSON.stringify(payload))
    })
  }

  onEvent(listener) { this.listeners.push(listener) }
}

/**
 * 启动参数（纯函数，便于直接断言"独立 profile / 独立端口"这两条命门）。
 */
export function browserLaunchArgs({ profileDir, port, headless = true, appUrl, extraArgs = [], windowSize = '1440,900' }) {
  if (typeof profileDir !== 'string' || profileDir === '') throw new Error('browserLaunchArgs：必须显式传独立 user-data-dir')
  if (!Number.isInteger(port) || port <= 0) throw new Error(`browserLaunchArgs：CDP 端口非法：${String(port)}`)
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    `--window-size=${windowSize}`,
    ...extraArgs,
  ]
  if (appUrl !== undefined) args.push(`--app=${appUrl}`)
  else args.push('about:blank')
  if (headless) args.unshift('--headless=new')
  return args
}

/** 让操作系统给一个空闲端口（不再写死固定的调试端口 —— 它与别的探针/用户程序撞车时会误连）。 */
export async function findFreePort({ createServerImpl = createServer } = {}) {  const server = createServerImpl()
  return await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

async function removeDirWithRetry(path, rmImpl, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { rmImpl(path, { recursive: true, force: true }); return true } catch { await sleep(150) }
  }
  return false
}

/**
 * 通过 **browser 级** CDP 端点关掉自己这个实例。
 *
 * 为什么不能只 `child.kill()`：Windows 上 `msedge.exe` 只是启动器（进程自己立刻退出、
 * 浏览器继续跑），kill 那个已经退出的 pid 什么也没关掉 —— 浏览器残留下来把
 * `user-data-dir` 占着，临时目录删不掉，下一轮的调试端口也可能被旧实例占住。
 * （团队记忆 01M2MZCGFAW11C08K4VQ26NQV4）
 */
export async function closeBrowserTarget(webSocketDebuggerUrl, { timeoutMs = 2000, webSocketImpl = WebSocket } = {}) {
  if (typeof webSocketDebuggerUrl !== 'string' || webSocketDebuggerUrl === '') return false
  let ws
  try {
    ws = new webSocketImpl(webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 browser 端点超时')), timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(undefined) }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接 browser 端点失败')) }, { once: true })
    })
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(undefined) }
      const timer = setTimeout(done, timeoutMs)
      ws.addEventListener('message', done, { once: true })
      try { ws.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} })) } catch { done() }
    })
    return true
  } catch {
    return false
  } finally {
    try { ws?.close() } catch { /* ignore */ }
  }
}

/**
 * 起一个**独立的**调试浏览器并连上它。返回的对象里 `close()` 只动自己这一份。
 *
 * @param {{
 *   browserPath: string, port?: number, headless?: boolean, appUrl?: string, extraArgs?: string[],
 *   callTimeoutMs?: number, readyTimeoutMs?: number, tmpRoot?: string,
 *   spawnImpl?: Function, fetchImpl?: Function, mkdtempImpl?: Function, rmImpl?: Function, sleepImpl?: Function,
 * }} options
 */
export async function launchDebugBrowser(options = {}) {
  const {
    browserPath,
    headless = true,
    appUrl,
    extraArgs = [],
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    tmpRoot,
    spawnImpl = spawn,
    fetchImpl = fetch,
    mkdtempImpl = mkdtempSync,
    rmImpl = rmSync,
    sleepImpl = sleep,
    webSocketImpl = WebSocket,
  } = options
  if (typeof browserPath !== 'string' || browserPath === '') {
    throw new Error('launchDebugBrowser：没有浏览器路径（先跑 discoverBrowser，或用 DSH_VERIFY_BROWSER 指定）')
  }
  const port = options.port ?? await findFreePort()
  /**
   * `mkdtemp` 要求**父目录已存在**（ENOENT，不是"自动创建"）。
   * T6 第一次真跑时才暴露：链传给套件的 `--user-data-root` 是
   * `test-results/workbench-verify/<runId>/browser-temp`，而这个目录在套件里
   * 还没人建过 —— 表现是"起不来浏览器"，且报错指向 profile 目录而不是它。
   * 显式建父目录（`mkdirSync(..., { recursive: true })` 幂等，不影响已有目录）。
   */
  const tmpRootDir = tmpRoot ?? tmpdir()
  if (typeof mkdtempImpl === 'function' && mkdtempImpl === mkdtempSync) mkdirSync(tmpRootDir, { recursive: true })
  else mkdirSync(tmpRootDir, { recursive: true })
  const profileDir = mkdtempImpl(join(tmpRootDir, DEFAULT_PROFILE_PREFIX))
  const args = browserLaunchArgs({ profileDir, port, headless, appUrl, extraArgs })
  const child = spawnImpl(browserPath, args, { detached: false, stdio: 'ignore' })

  let version = null
  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() < deadline) {
    await sleepImpl(300)
    try { version = await fetchJson(`http://127.0.0.1:${port}/json/version`, fetchImpl); break } catch { /* 继续等 */ }
  }
  if (version === null) {
    try { child.kill() } catch { /* 起不来就只能尽力清掉 */ }
    await removeDirWithRetry(profileDir, rmImpl)
    throw new Error(`调试实例未在 ${readyTimeoutMs}ms 内就绪（DevTools 端点 http://127.0.0.1:${port}/json/version 无响应）`)
  }

  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, fetchImpl)
  const page = targets.find((target) => target.type === 'page') ?? (await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, fetchImpl))

  const ws = new webSocketImpl(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  const cdp = new Cdp(ws, { callTimeoutMs })
  const browserWsUrl = typeof version?.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : ''

  const consoleLines = []
  const pageErrors = []
  let dialogText = ''
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')
  /**
   * **把本 target 拉到前台**（2026-10-02 实测踩到的一个致命坑）。
   *
   * `targets.find(t => t.type === 'page')` 取的是**第一个** page target；浏览器里只要多出
   * 一个标签页（旧 profile 遗留、启动器先开的 about:blank 等），我们连上的页面就可能**不是前台标签**。
   * Chromium 对**非前台 target 的输入事件会静默丢弃**：`Input.dispatchMouseEvent` 发出去，
   * 页面**一个事件都收不到**（`pointerdown`/`click` 全空），而 `Runtime.evaluate` 照常有效 ——
   * 于是"用 JS `.click()` 能生效、真实鼠标点击毫无反应"，排查方向会被带偏很远
   *（本次就是这么绕进去的：链里 `legacy-duplicate-task` 的 LEG-D04 一直红，
   * 而套件里其它"点了之后验证效果"的断言又是绿的，因为那些套件跑的时候页面恰好在前台）。
   */
  await cdp.send('Page.bringToFront').catch(() => undefined)
  cdp.onEvent((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')
      consoleLines.push({ level: msg.params.type, text })
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails
      pageErrors.push(details?.exception?.description ?? details?.text ?? 'unknown exception')
    }
    if (msg.method === 'Log.entryAdded') {
      const entry = msg.params.entry
      if (entry.level === 'error') pageErrors.push(`[${entry.source}] ${entry.text}`)
    }
    if (msg.method === 'Page.javascriptDialogOpening') {
      dialogText = msg.params.message ?? ''
      void cdp.send('Page.handleJavaScriptDialog', { accept: true })
    }
  })

  let closed = false
  const api = {
    cdp,
    consoleLines,
    pageErrors,
    profileDir,
    port,
    browserPath,
    get closed() { return closed },
    get dialogText() { return dialogText },
    async goto(url) {
      await cdp.send('Page.navigate', { url })
      await sleepImpl(1200)
    },
    /** 在页面里求值（返回 JSON 可序列化的值）。 */
    async evaluate(expression) {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `(() => { ${expression} })()`,
        returnByValue: true,
        awaitPromise: true,
      })
      if (result.exceptionDetails !== undefined) {
        throw new Error(`页面求值失败：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
      }
      return result.result?.value
    },
    /** 有上限的状态轮询（旧脚本的固定 sleep 不是产品要求）。 */
    async waitFor(expression, { timeoutMs = 10000, intervalMs = 250, description = expression } = {}) {
      const deadline = Date.now() + timeoutMs
      let last
      while (Date.now() < deadline) {
        last = await api.evaluate(expression)
        if (last) return last
        await sleepImpl(intervalMs)
      }
      throw new Error(`等待超时（${timeoutMs}ms）：${description}`)
    },
    async screenshot(file) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, Buffer.from(shot.data, 'base64'))
      return file
    },
    /** 用坐标点击（viewport 像素）。 */
    async clickAt(x, y) {
      /**
       * 每次点击前都拉一次前台：**非前台 target 的输入事件会被 Chromium 静默丢弃**
       *（页面一个事件都收不到，而 `evaluate` 照常有效）—— 见连接处的长注释。
       */
      await cdp.send('Page.bringToFront').catch(() => undefined)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      }
      await sleepImpl(400)
    },
    /**
     * 按可见文字点按钮：**先滚进视口**，再算中心点，再发真实鼠标事件。
     *
     * ⚠️ 为什么要先滚（2026-10-01 实测踩到）：`getBoundingClientRect()` 给的是**视口坐标**，
     * 而 `Input.dispatchMouseEvent` 用的也是视口坐标 —— 元素在滚动区外时，
     * 它的 rect 会落在视口之外（甚至负值），浏览器就把鼠标事件丢给**那个位置上的别的东西**。
     * 症状极具欺骗性：点击"成功"返回了坐标，但选中态没变（套件报"点了没生效"，
     * 于是人一路去怀疑组件/事件绑定）。
     * 实测场景：角色选择器加长（常驻全量列表）后，「反向验证者」落在滚动区下方，
     * 点击无效；列表短的时候永远碰不到这个坑。
     */
    async clickByText(text, selector = 'button') {
      const box = await api.evaluate(`
        const wanted = ${JSON.stringify(text)};
        const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const hit = nodes.find((n) => (n.textContent || '').includes(wanted) && n.offsetParent !== null);
        if (!hit) return null;
        hit.scrollIntoView({ block: 'center', inline: 'center' });
        const r = hit.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: hit.textContent };
      `)
      if (box === null) return null
      /**
       * `scrollIntoView` 之后布局要一帧才稳定，所以**重新量一次**再点
       * （拿滚之前算的坐标去点，等于还是点在旧位置）。
       */
      await sleepImpl(120)
      const settled = await api.evaluate(`
        const wanted = ${JSON.stringify(text)};
        const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const hit = nodes.find((n) => (n.textContent || '').includes(wanted) && n.offsetParent !== null);
        if (!hit) return null;
        const r = hit.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: hit.textContent };
      `)
      const target = settled ?? box
      /**
       * ⚠️ **点完要验证"这次点击真的产生了事件"**（2026-10-02 实测踩到，代价很大）。
       *
       * 发生过的事实：坐标正确（命中测试就是那个元素、视口内、DPR=1、无滚动、无遮罩），
       * `Input.dispatchMouseEvent` 也返回成功，但页面**一个事件都收不到**
       *（`pointerdown`/`mouseup`/`click` 全空、`document` 上也没有），于是"点了没生效"；
       * 而同一页面上 `Runtime.evaluate` 正常、JS `el.click()` 立刻生效。
       * 症状极具欺骗性：套件里"点了之后**验证效果**"的断言会红（如 LEG-D04「面板已打开」），
       * 而只检查"`clickByText` 返回了非 null"的地方却照样绿 —— 后者是**空洞的通过**。
       *
       * 处置：点完埋一个一次性探针确认事件是否到达；没到达就**退回 DOM 级点击**并留痕
       *（`clickFallback: 'dom-click'`）。判据本身仍然验的是"效果"（如 `data-open=1`），
       * 只是我们不再假装"发过事件就一定是点上了"。
       */
      await api.evaluate(`
        window.__wbClickProbe = 0;
        document.addEventListener('click', () => { window.__wbClickProbe = 1; }, { once: true, capture: true });
        return true;
      `)
      await api.clickAt(Math.round(target.x), Math.round(target.y))
      const seen = await api.evaluate(`return window.__wbClickProbe === 1;`)
      if (seen === true) return { ...target, clickChannel: 'cdp-mouse' }
      const fallback = await api.evaluate(`
        const wanted = ${JSON.stringify(text)};
        const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const hit = nodes.find((n) => (n.textContent || '').includes(wanted) && n.offsetParent !== null);
        if (!hit) return null;
        hit.click();
        return true;
      `)
      return { ...target, clickChannel: fallback === true ? 'dom-click' : 'none' }
    },
    /** 只关自己：自己的实例（browser 端点）、自己的 ws、自己的子进程、自己的临时 profile 目录。 */
    async close() {
      if (closed) return
      closed = true
      try { await closeBrowserTarget(browserWsUrl, { webSocketImpl }) } catch { /* 关不掉也要继续清 */ }
      try { ws.close() } catch { /* ignore */ }
      try { child.kill() } catch { /* Windows 上启动器进程可能早就退了 */ }
      await sleepImpl(300)
      await removeDirWithRetry(profileDir, rmImpl)
    },
  }
  return api
}
