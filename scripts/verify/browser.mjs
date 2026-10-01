/**
 * 浏览器发现（plan.md V02 / AX-V02）。
 *
 * ## 为什么要单独一个模块
 *
 * 被搬进仓库的 CDP 驱动原来把 Edge 路径**硬编码**成
 * `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`（见 `.pwtest/cdp.mjs`）。
 * 换一台机器（或 64 位 Edge）就静默失能。这里的规矩：
 *
 * 1. `DSH_VERIFY_BROWSER` **优先**，且"不可执行/不存在"必须**报错**——不许静默忽略去用别的浏览器，
 *    否则用户以为自己在验 A，实际验的是 B。
 * 2. 其次按平台标准路径**发现**（Windows Edge/Chrome、macOS、Linux）。
 * 3. 一个都没找到 → 失败，并且**把探测过的路径全列出来**（"未找到浏览器"这句话本身不含信息）。
 *
 * 纯函数 + 可注入的 `exists/平台/env`，所以能在没有浏览器的机器上测。
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'

/** 按平台列出候选（顺序即优先级）。 */
export function browserCandidates({ env = process.env, platform = process.platform } = {}) {
  const list = []
  const push = (path, source) => { if (typeof path === 'string' && path !== '') list.push({ path, source }) }

  if (platform === 'win32') {
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = env['LOCALAPPDATA'] ?? ''
    push(`${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`, 'edge-x86')
    push(`${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`, 'edge-x64')
    push(`${programFiles}\\Google\\Chrome\\Application\\chrome.exe`, 'chrome-x64')
    push(`${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`, 'chrome-x86')
    if (localAppData !== '') push(`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`, 'chrome-user')
  } else if (platform === 'darwin') {
    push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome-app')
    push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'edge-app')
    push('/Applications/Chromium.app/Contents/MacOS/Chromium', 'chromium-app')
  } else {
    push('/usr/bin/google-chrome', 'chrome')
    push('/usr/bin/google-chrome-stable', 'chrome-stable')
    push('/usr/bin/microsoft-edge', 'edge')
    push('/usr/bin/chromium', 'chromium')
    push('/usr/bin/chromium-browser', 'chromium-browser')
    push('/snap/bin/chromium', 'chromium-snap')
  }
  return list
}

function defaultIsExecutable(path, platform) {
  try {
    if (!statSync(path).isFile()) return { ok: false, reason: '不是可执行文件（是个目录？）' }
  } catch (error) {
    return { ok: false, reason: `读不了：${error instanceof Error ? error.message : String(error)}` }
  }
  // Windows 上没有 POSIX 执行位，存在且是文件就算可执行；POSIX 上要真的能执行。
  if (platform === 'win32') return { ok: true }
  try {
    accessSync(path, constants.X_OK)
    return { ok: true }
  } catch {
    return { ok: false, reason: '没有可执行权限（chmod +x）' }
  }
}

/**
 * 找到一个可用的浏览器。
 *
 * @returns {{ok: true, path: string, source: string, probed: string[]}
 *        | {ok: false, reason: string, probed: string[], overridePath?: string}}
 */
export function discoverBrowser(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.existsSync ?? existsSync
  const isExecutable = options.isExecutable ?? ((path) => defaultIsExecutable(path, platform))
  const probed = []

  const overridePath = options.overridePath ?? env.DSH_VERIFY_BROWSER
  if (typeof overridePath === 'string' && overridePath.trim() !== '') {
    const path = overridePath.trim()
    if (!exists(path)) {
      return { ok: false, reason: `DSH_VERIFY_BROWSER 指向的浏览器不存在：${path}`, probed: [path], overridePath: path }
    }
    const verdict = isExecutable(path)
    if (!verdict.ok) {
      return { ok: false, reason: `DSH_VERIFY_BROWSER 指向的浏览器不可执行：${path} —— ${verdict.reason}`, probed: [path], overridePath: path }
    }
    return { ok: true, path, source: 'DSH_VERIFY_BROWSER', probed: [path] }
  }

  const candidates = [...browserCandidates({ env, platform }), ...(options.extraCandidates ?? [])]
  for (const candidate of candidates) {
    probed.push(candidate.path)
    if (!exists(candidate.path)) continue
    const verdict = isExecutable(candidate.path)
    if (!verdict.ok) continue
    return { ok: true, path: candidate.path, source: candidate.source, probed }
  }
  return {
    ok: false,
    reason: `没有找到可用的浏览器（可用 DSH_VERIFY_BROWSER 显式指定）。已探测 ${probed.length} 个路径：\n${probed.map((path) => `  - ${path}`).join('\n')}`,
    probed,
    overridePath: undefined,
  }
}
