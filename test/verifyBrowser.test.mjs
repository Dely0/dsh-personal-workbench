/**
 * AX-V02（U/N/B）：CDP 驱动可移植 + 环境覆盖 + 超时 + 只关己方浏览器。
 *
 * 判据来源：requirements.md §7.1–7.2、acceptance.md AX-V02、plan.md V02。
 *
 * 这一组的重点是**搬运时不能丢的两条命门**（ADR0006 §4）与"缺浏览器必须可读地失败"：
 * 1. 独立 `user-data-dir`（丢了 → Windows 把命令行转发给已有实例 → 什么都不发生还 exit 0）；
 * 2. 每次 CDP 调用 30s 超时（丢了 → 永久挂住、无输出）；
 * 3. 浏览器路径靠发现 + `DSH_VERIFY_BROWSER` 覆盖（原来硬编码 Edge 路径，换机器即失能）；
 * 4. `DSH_VERIFY_BROWSER` 指向不可执行的东西**必须报错**，不许静默换一个浏览器；
 * 5. `close()` 只动自己的子进程与自己的临时目录；
 * 6. 独立 CDP 端口（不再写死 9333）。
 *
 * 真实浏览器的 B 层点击归 T6（本机隔离实例就绪后）。这里全部用假 WebSocket / 假 spawn，
 * 因为"缺浏览器的机器上也要能跑这条判据"正是 AX-V02 的要求之一。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserCandidates, discoverBrowser } from '../scripts/verify/browser.mjs'
import { Cdp, DEFAULT_CALL_TIMEOUT_MS, browserLaunchArgs, findFreePort, launchDebugBrowser } from '../scripts/verify/cdp.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 收集 spawned/killed 记录的假 spawn。 */
function fakeSpawn() {
  const calls = []
  const impl = (command, args, options) => {
    const child = {
      command,
      args,
      options,
      killed: 0,
      kill() { this.killed += 1; return true },
    }
    calls.push(child)
    return child
  }
  return { impl, calls }
}

/** 假 WebSocket：send() 之后同步回一条 result（模拟 CDP 的正常应答）。 */
function fakeWebSocket({ autoRespond = true, onSend } = {}) {
  const instances = []
  class FakeWebSocket {
    constructor(url) {
      this.url = url
      this.sent = []
      this.listeners = new Map()
      instances.push(this)
      queueMicrotask(() => this.emit('open', {}))
    }
    addEventListener(type, handler) {
      const list = this.listeners.get(type) ?? []
      list.push(handler)
      this.listeners.set(type, list)
    }
    emit(type, event) {
      for (const handler of this.listeners.get(type) ?? []) handler(event)
    }
    send(text) {
      this.sent.push(text)
      const payload = JSON.parse(text)
      onSend?.(this, payload)
      if (autoRespond && payload.method !== undefined) {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: payload.id, result: {} }) }))
      }
    }
    close() { this.closed = true }
  }
  return { FakeWebSocket, instances }
}

function fakeFetch(routes) {
  return async (url) => {
    const entry = Object.entries(routes).find(([key]) => String(url).includes(key))
    if (entry === undefined) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => entry[1] }
  }
}

test('AX-V02：DSH_VERIFY_BROWSER 可执行 → 覆盖生效（source 标明来源）', () => {
  const verdict = discoverBrowser({
    env: { DSH_VERIFY_BROWSER: 'D:/tools/chrome.exe' },
    platform: 'win32',
    existsSync: (path) => path === 'D:/tools/chrome.exe',
    isExecutable: () => ({ ok: true }),
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.path, 'D:/tools/chrome.exe')
  assert.equal(verdict.source, 'DSH_VERIFY_BROWSER')
})

test('AX-V02：DSH_VERIFY_BROWSER 指向不存在/不可执行 → 报错，且**不许静默回退**到别的浏览器', () => {
  // 故意让所有候选路径"存在"，证明失败不是"没找到"而是"指定的那个不能用"
  const existsEverything = () => true
  const missing = discoverBrowser({ env: { DSH_VERIFY_BROWSER: 'D:/nope/msedge.exe' }, platform: 'win32', existsSync: (path) => path === 'D:/nope/msedge.exe' ? false : existsEverything() })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /不存在/)
  assert.ok(missing.reason.includes('D:/nope/msedge.exe'))
  assert.deepEqual(missing.probed, ['D:/nope/msedge.exe'], '覆盖模式下不该再去探候选路径')

  const notExecutable = discoverBrowser({
    env: { DSH_VERIFY_BROWSER: '/opt/weird/browser' },
    platform: 'linux',
    existsSync: () => true,
    isExecutable: () => ({ ok: false, reason: '没有可执行权限（chmod +x）' }),
  })
  assert.equal(notExecutable.ok, false)
  assert.match(notExecutable.reason, /不可执行/)
  assert.ok(notExecutable.reason.includes('/opt/weird/browser'))
})

test('AX-V02：没有浏览器时失败，且把**探测过的路径逐条列出来**（"未找到"本身不含信息）', () => {
  const verdict = discoverBrowser({ env: {}, platform: 'win32', existsSync: () => false })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /DSH_VERIFY_BROWSER/)
  for (const candidate of browserCandidates({ env: {}, platform: 'win32' })) {
    assert.ok(verdict.reason.includes(candidate.path), `探测路径必须出现在失败原因里：${candidate.path}`)
  }
  assert.ok(verdict.probed.length >= 4)
})

test('AX-V02：候选发现覆盖 Windows/macOS/Linux 三个平台的标准路径', () => {
  const win = browserCandidates({ env: { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF' }, platform: 'win32' }).map((entry) => entry.path)
  assert.ok(win.some((path) => path.includes('Microsoft\\Edge\\Application\\msedge.exe')))
  assert.ok(win.some((path) => path.includes('Google\\Chrome\\Application\\chrome.exe')))
  const mac = browserCandidates({ env: {}, platform: 'darwin' }).map((entry) => entry.path)
  assert.ok(mac.some((path) => path.includes('Google Chrome.app/Contents/MacOS/Google Chrome')))
  const linux = browserCandidates({ env: {}, platform: 'linux' }).map((entry) => entry.path)
  assert.ok(linux.some((path) => path === '/usr/bin/google-chrome'))
  assert.ok(linux.some((path) => path === '/usr/bin/microsoft-edge'))
})

test('AX-V02：启动参数必须带独立 user-data-dir 与独立 CDP 端口（两条命门之一）', () => {
  const args = browserLaunchArgs({ profileDir: 'C:\\tmp\\wb-cdp-abc', port: 9544, headless: true })
  assert.ok(args.includes('--user-data-dir=C:\\tmp\\wb-cdp-abc'), `缺独立 profile：${args.join(' ')}`)
  assert.ok(args.includes('--remote-debugging-port=9544'))
  assert.equal(args[0], '--headless=new')
  assert.throws(() => browserLaunchArgs({ profileDir: '', port: 9544 }), /user-data-dir/)
  assert.throws(() => browserLaunchArgs({ profileDir: 'x', port: 0 }), /CDP 端口/)
})

test('AX-V02：单次 CDP 调用默认 30s 超时（两条命门之二），被挂住时必须 reject 且报出方法名', async () => {
  assert.equal(DEFAULT_CALL_TIMEOUT_MS, 30000)
  const silent = { addEventListener() {}, send() {} }
  assert.equal(new Cdp(silent).callTimeoutMs, 30000)

  const cdp = new Cdp(silent, { callTimeoutMs: 30 })
  await assert.rejects(
    () => cdp.send('Runtime.evaluate', { expression: '1' }),
    (error) => {
      assert.match(error.message, /CDP 调用超时/)
      assert.match(error.message, /Runtime\.evaluate/, '报错必须说清是哪一步挂住了')
      return true
    },
  )
})

test('AX-V02：正常应答能 resolve；超时之后迟到的应答不会炸（pending 已摘掉）', async () => {
  const listeners = new Map()
  const ws = {
    addEventListener(type, handler) { listeners.set(type, [...(listeners.get(type) ?? []), handler]) },
    send(text) {
      const payload = JSON.parse(text)
      setTimeout(() => {
        for (const handler of listeners.get('message') ?? []) handler({ data: JSON.stringify({ id: payload.id, result: { value: 42 } }) })
      }, 5)
    },
  }
  const cdp = new Cdp(ws, { callTimeoutMs: 200 })
  const result = await cdp.send('Runtime.evaluate', { expression: '42' })
  assert.deepEqual(result, { value: 42 })

  const stalled = new Cdp({ addEventListener() {}, send() {} }, { callTimeoutMs: 20 })
  await assert.rejects(() => stalled.send('Page.navigate'))
  let threw = false
  try { stalled.onEvent(() => {}) } catch { threw = true }
  assert.equal(threw, false)
  assert.equal(stalled.pending.size, 0, '超时后必须把 pending 摘掉，否则迟到应答会走进已 reject 的 promise')
})

test('AX-V02：端口不写死 —— findFreePort 给的是真能绑上的空闲端口', async () => {
  const port = await findFreePort()
  assert.equal(Number.isInteger(port) && port > 0, true)
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(undefined)))
  })
})

test('AX-V02：launchDebugBrowser 起独立实例；close() 只杀自己那个子进程、只删自己的临时目录', async () => {
  const { impl, calls } = fakeSpawn()
  const ws = fakeWebSocket()
  const removed = []
  const profileDir = 'C:\\tmp\\dsh-verify-cdp-fixture'
  const api = await launchDebugBrowser({
    browserPath: 'C:/browser/msedge.exe',
    port: 9611,
    headless: true,
    spawnImpl: impl,
    webSocketImpl: ws.FakeWebSocket,
    fetchImpl: fakeFetch({
      '/json/version': { webSocketDebuggerUrl: 'ws://127.0.0.1:9611/devtools/browser/x' },
      '/json/list': [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9611/devtools/page/y' }],
    }),
    mkdtempImpl: () => profileDir,
    rmImpl: (path, options) => removed.push({ path, options }),
    sleepImpl: async () => {},
  })
  assert.equal(calls.length, 1, '只许起一个浏览器进程')
  assert.equal(calls[0].command, 'C:/browser/msedge.exe')
  assert.ok(calls[0].args.includes(`--user-data-dir=${profileDir}`), '必须带独立 profile（丢了会被转发给用户已开的浏览器）')
  assert.ok(calls[0].args.includes('--remote-debugging-port=9611'))
  assert.equal(api.profileDir, profileDir)
  assert.equal(api.port, 9611)
  assert.equal(api.closed, false)

  await api.close()
  assert.equal(calls[0].killed, 1, 'close 必须杀掉自己起的进程')
  assert.deepEqual(removed.map((entry) => entry.path), [profileDir], '只许删自己的临时 profile 目录')
  assert.equal(api.closed, true)
  await api.close()
  assert.equal(calls[0].killed, 1, 'close 必须幂等（重复 close 不重复杀）')
})

test('AX-V02：浏览器路径由发现提供 —— cdp.mjs 里不许再有硬编码的浏览器路径', () => {
  const source = readFileSync(join(REPO, 'scripts', 'verify', 'cdp.mjs'), 'utf8')
  assert.equal(source.includes('Program Files'), false, '硬编码 Edge/Chrome 路径必须已经搬去 browser.mjs 的候选发现')
  assert.equal(source.includes('9333'), false, 'CDP 端口不许再写死 9333')
  assert.ok(source.includes('DEFAULT_CALL_TIMEOUT_MS = 30000'), '30s 超时是命门，必须留在源码里')
})
