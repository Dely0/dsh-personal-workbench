/**
 * 验收链的**真实**副作用实现（plan.md V04）。
 *
 * 编排逻辑在 `scripts/dev-verify.mjs`，那里全部依赖注入；本文件只放"真的要动系统"的那几件事，
 * 目的是让编排可以在没有 DSH、没有浏览器、没有真进程的机器上被测（AX-V06–V09 全是 mock 故障注入）。
 *
 * ## 这里的每一条都对应一次真实事故
 *
 * - **端口归属校验**：`~/.dsh/launchers/open-dsh.ps1` 的历史教训 —— 按 `@deepseek-ai` 匹配
 *   会误杀 WSL 里另一个实例（团队记忆 01M2A0A5GB1RJWQ9MF41VARASY）。所以只认
 *   "端口是它监听的 **且** 命令行是 dsh web 的 **那个** node 进程"，只 kill 它一个。
 * - **stdout 重定向到文件而不是管道**：启动器会拉起浏览器，浏览器继承管道写端后
 *   `Out-String` 永不返回（团队记忆 01M2HZBQ8D0FMK11DK2G8QK56C §2）。这里同样只写文件。
 * - **token 从"本次启动位置"往后读**：日志是 append 的，不记 offset 就会读到上一次的 token。
 * - **token 只经内存/环境变量传给孩子**：不进 argv（argv 在进程列表里可见）。
 */
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const TOKEN_PATTERN = /token=([A-Za-z0-9_\-]+)/

/** 跑一条命令，带超时；超时**不抛异常**，而是把 `timedOut` 交回编排去判退出码 3。 */
export async function runCommand(command, options = {}) {
  const { cwd, env, timeoutMs = 600000, shell = true } = options
  const startedAt = Date.now()
  return await new Promise((resolve) => {
    const child = spawn(command, { cwd, env: env === undefined ? process.env : { ...process.env, ...env }, shell, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* ignore */ }
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ status: 1, stdout, stderr: `${stderr}${String(error)}`, ms: Date.now() - startedAt, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code ?? 1, stdout, stderr, ms: Date.now() - startedAt, timedOut })
    })
  })
}

/** 同步跑一条命令（用于端口查询这种必须立刻拿到结果的小查询）。 */
export function runCommandSync(command, options = {}) {
  const { cwd, env, timeoutMs = 20000 } = options
  try {
    const stdout = execFileSync(command, { cwd, env: { ...process.env, ...env }, shell: true, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

export async function httpGetJson(url, timeoutMs = 5000, fetchImpl = fetch, headers = undefined) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), ...(headers === undefined ? {} : { headers }) })
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    return { ok: true, status: response.status, body: await response.json() }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

export function fileSize(path) {
  try { return statSync(path).size } catch { return 0 }
}

export function readLogFrom(path, offset, deps = {}) {
  const exists = deps.existsSync ?? existsSync
  const read = deps.readFileSync ?? readFileSync
  if (!exists(path)) return { text: '', offset, truncated: false }
  let text
  try { text = String(read(path, 'utf8')) } catch { return { text: '', offset, truncated: false } }
  // 日志被截断/轮转过：从头读，但如实标注（不假装只有新内容）
  if (text.length < offset) return { text, offset: text.length, truncated: true }
  return { text: text.slice(offset), offset: text.length, truncated: false }
}

export function extractToken(text) {
  const match = TOKEN_PATTERN.exec(String(text ?? ''))
  return match === null ? undefined : match[1]
}

/**
 * 取日志里**最后**一个 token —— 本次重启真正生效的那个。
 *
 * ## 为什么不能按 offset 读（2026-10-01 T6 实测踩到，代价是两条判据假红）
 *
 * 原设计：`restartTarget` 记下"启动前日志长度"`logOffset`，token 阶段从该 offset **往后**读。
 * 前提是"新实例只会往日志**追加**"。实测这个前提**不成立**：
 * `dsh web` 起来时会**截断**重写日志文件（甚至同一份 banner 内容长度更短），
 * 于是 `fileSize` 变小、`logOffset` 失效；此时读取要么拿到 0 字节，要么——
 * 更坏的情况——拿到**上一次启动残留**的 token。
 * 表现极具欺骗性：health 阶段用 `Bearer` 打 API 照样 200（loopback 本来就通），
 * 只有浏览器判据红，而红的是"侧栏没有工作台入口"（其实是认证页），
 * 让人一路怀疑 DOM/选择器/等待条件，真正的根因是**token 是旧的那一个**。
 *
 * 判据改成"**整份日志里最后一个 token**"：token 每次启动轮换、新的一定在旧的后面的写入位置，
 * 所以"最后一个 = 最新"。同时链在拿到之后**必须真的用它认证一次**（见 dev-verify 的 token 阶段）——
 * "读到了 token"和"读到的是能用的 token"是两件事。
 */
export function extractLatestToken(text) {
  const matches = [...String(text ?? '').matchAll(new RegExp(TOKEN_PATTERN.source, 'g'))]
  return matches.length === 0 ? undefined : matches[matches.length - 1][1]
}

/** 用 token 打一次本机页面，确认它**真的能认证**（不是"看起来像 token"）。 */
export async function verifyTokenWorks(url, token, timeoutMs = 5000, fetchImpl = fetch) {
  if (typeof token !== 'string' || token === '') return { ok: false, reason: '没有 token' }
  const page = await fetchImpl(`${url.replace(/\/$/, '')}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  // 认证成功会 303 跳到 /（并种 cookie）；失败是 401 且正文写着 authentication required。
  const text = await page.text().catch(() => '')
  if (page.status === 401 || /authentication required/i.test(text)) return { ok: false, reason: `token 未被接受（HTTP ${page.status}）` }
  return { ok: true, status: page.status }
}

/**
 * 查监听某个端口的进程**归属**。Windows 用 PowerShell（纯 ASCII 脚本，避免 5.1 代码页问题）。
 * 非 Windows 一律返回 `ok:false` —— 宁可拒绝，也不猜着杀进程。
 */
/**
 * 端口归属探测用的 PowerShell 脚本（用**文件**跑，不做内联转义）。
 *
 * 为什么不内联：内联要穿过 node → `-Command` → PowerShell 解析三层，双引号得写成
 * `\"` 才能让 PowerShell 看见引号 —— 而 `Write-Output '{\"none\":true}'` 一旦有一层
 * 理解错，输出的就是**非法 JSON** `{none:true}`。2026-10-01 T6 第一次真跑就撞上：
 * 判据报"归属输出无法解析"，而它的下一步是拉起实例 —— 判据说不出话却照样往下走。
 * 落成 `.ps1` 文件后，脚本内容原样进 PowerShell，`ConvertTo-Json` 的输出必然是合法 JSON。
 */
export function buildPortOwnerScript(port) {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    'try {',
    `  $c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1`,
    '  if (-not $c) { Write-Output \'{"none":true}\'; exit 0 }',
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)" -ErrorAction SilentlyContinue',
    '  if (-not $p) { Write-Output \'{"none":true}\'; exit 0 }',
    '  $o = [ordered]@{ pid = [int]$c.OwningProcess; name = [string]$p.Name; commandLine = [string]$p.CommandLine }',
    '  Write-Output ($o | ConvertTo-Json)',
    '} catch {',
    '  Write-Output \'{"none":true}\'',
    '}',
  ].join("\n")
}

export function findPortOwner(port, deps = {}) {
  const platform = deps.platform ?? process.platform
  const run = deps.runCommandSync ?? runCommandSync
  if (platform !== 'win32') return { ok: false, reason: `端口归属校验目前只支持 Windows（当前 ${platform}）—— 拒绝在没有归属校验能力时杀进程` }
  const write = deps.writeFileSync ?? writeFileSync
  const rm = deps.rmSync ?? rmSync
  const scriptPath = join(tmpdir(), `dsh-verify-port-owner-${port}.ps1`)
  try { write(scriptPath, buildPortOwnerScript(port), 'utf8') } catch (error) {
    return { ok: false, reason: `写端口归属脚本失败（${scriptPath}）：${error instanceof Error ? error.message : String(error)}` }
  }
  let result
  try {
    result = run(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeoutMs: 20000 })
  } finally {
    try { rm(scriptPath, { force: true }) } catch { /* 临时文件删不掉不阻塞判据 */ }
  }
  if (result.status !== 0) return { ok: false, reason: `查询端口 ${port} 归属失败：${result.stderr.trim() || result.stdout.trim()}` }
  let parsed
  const stdout = result.stdout.trim()
  try { parsed = JSON.parse(stdout) } catch {
    /**
     * 兜底：`ConvertTo-Json` 的输出可能带前导噪声行（PowerShell 的 clixml/警告走 stdout）。
     * 从**最后一个 `{`** 起到结尾再试一次；再不行就如实报"无法解析"（不猜）。
     */
    const start = stdout.lastIndexOf('{')
    try { parsed = start === -1 ? undefined : JSON.parse(stdout.slice(start)) } catch { parsed = undefined }
    if (parsed === undefined) return { ok: false, reason: `端口 ${port} 归属输出无法解析：${stdout}` }
  }
  if (parsed?.none === true || parsed?.pid === undefined) return { ok: true, owner: undefined }
  return { ok: true, owner: { pid: Number(parsed.pid), name: String(parsed.name ?? ''), commandLine: String(parsed.commandLine ?? '') } }
}

/** 判定一个端口归属进程是否就是"我们要重启的那个 dsh 实例"。 */
export function isTargetDshProcess(owner, { port, profile }) {
  if (owner === undefined) return { ok: false, reason: '端口当前没有监听进程' }
  if (!/node\.exe$/i.test(owner.name)) return { ok: false, reason: `端口被非 node 进程占用（${owner.name}）` }
  const commandLine = owner.commandLine
  if (!/dsh/i.test(commandLine)) return { ok: false, reason: `监听端口的 node 进程不是 dsh（命令行里没有 dsh）：${commandLine}` }
  if (!/(^|\s)web(\s|$)/.test(commandLine)) return { ok: false, reason: `监听端口的 dsh 进程不是 web 子命令：${commandLine}` }
  if (!new RegExp(`--port[= ]${port}(\\s|$)`).test(commandLine)) return { ok: false, reason: `监听端口的 dsh 进程命令行里没有 --port ${port}：${commandLine}` }
  if (profile !== undefined && profile !== '') {
    const explicitProfile = new RegExp(`--profile[= ]${profile}(\\s|$)`).test(commandLine)
    // DSH_PROFILE 环境变量也能决定 profile，命令行里看不到；只在显式指定了别的 profile 时拒绝。
    const otherProfile = /--profile[= ]([A-Za-z0-9_-]+)/.exec(commandLine)
    if (!explicitProfile && otherProfile !== null && otherProfile[1] !== profile) {
      return { ok: false, reason: `监听端口的 dsh 进程用的是 profile ${otherProfile[1]}，不是 ${profile}` }
    }
  }
  return { ok: true, owner }
}

/**
 * 解析"怎么把目标实例拉起来"。
 *
 * ⚠️ **不要走 `dsh.cmd` 外壳**（2026-10-01 T6 实测）：
 * `spawn('"<npm>\dsh.cmd" web --port 3080', { shell: true })` 会多出 **cmd.exe** 一层。
 * 进程确实起来了（端口在听、health 200、buildId 正确），但 **stdout 没有落到日志文件**：
 * 实测连跑三次重启，`%TEMP%\dsh-server-3080.log` 的长度一个字节都没涨 ——
 * 于是 `token` 阶段永远读不到 token（60s 超时，退出码 3），而更早的
 * "从这次启动位置往后读"整段逻辑也就无从谈起。
 *
 * 而且 `dsh.cmd` 里写的还是**全局** dsh：链要能对任意一个装好的 dsh 实例工作。
 *
 * 所以改成**直接起 `node <bin.js>`**（`process.execPath` 就是当前 Node），
 * 完全绕开 shell 与 .cmd：stdio 的继承关系确定，`--no-open` 也不需要窗口。
 * `DSH_VERIFY_DSH_CMD` 仍然可用（显式覆盖，按原样当命令跑）。
 */
export function resolveDshCommand(env = process.env) {
  if (typeof env.DSH_VERIFY_DSH_CMD === 'string' && env.DSH_VERIFY_DSH_CMD !== '') {
    return { kind: 'override', command: env.DSH_VERIFY_DSH_CMD }
  }
  const appData = env.APPDATA
  const candidates = []
  if (typeof appData === 'string' && appData !== '') {
    candidates.push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  candidates.push(join(env.DSH_HOME ?? join(homedir(), '.dsh'), '..', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { kind: 'node', command: process.execPath, bin: candidate }
  }
  /**
   * 一个都没找到：**明确失败**。不许悄悄回退到 `dsh`（PATH 上的那个可能是别的 profile/别的版本），
   * 那正是 ADR0006 里"不在其他 profile 重试"要防的形态。
   */
  return { kind: 'missing', reason: `没找到 dsh 的 bin.js（探测过：${candidates.join('、')}）；可用 DSH_VERIFY_DSH_CMD 显式指定` }
}

/**
 * 只重启**目标实例**：先按端口归属校验（必须是 dsh web 的那个 node 进程），
 * 再 kill 它一个，然后用清洗过的环境重新拉起 `dsh web --port <port> --no-open`，
 * stdout/stderr 追加到该端口自己的日志文件（**不用管道**）。
 *
 * 返回 `logOffset`：本次启动**之前**日志的长度 —— token 只许从这个位置往后读。
 */
export async function restartTarget(options, deps = {}) {
  const {
    port, profile = 'web', profileDir, dbPath, workDir, launcher,
    logPath = join(tmpdir(), `dsh-server-${port}.log`),
    childEnv = {},
  } = options
  const run = deps.runCommand ?? runCommand
  const runSync = deps.runCommandSync ?? runCommandSync
  const findOwner = deps.findPortOwner ?? findPortOwner
  const resolveCommand = deps.resolveDshCommand ?? resolveDshCommand
  const size = deps.fileSize ?? fileSize
  const env = options.env ?? process.env

  if (typeof launcher === 'string' && launcher !== '') {
    if (!(deps.existsSync ?? existsSync)(launcher)) {
      return { ok: false, exitCode: 2, reason: `--launcher 指定的启动器不存在：${launcher}（不会去别的 profile 找替代品）` }
    }
    const before = size(logPath)
    const result = await run(`cmd /c ""${launcher}"`, { cwd: workDir, env: { ...env, ...childEnv }, timeoutMs: 180000 })
    if (result.status !== 0) return { ok: false, exitCode: 1, reason: `启动器退出码 ${result.status}：${result.stderr || result.stdout}`, logOffset: before }
    return { ok: true, method: 'launcher', launcher, logOffset: before, stdout: result.stdout, stderr: result.stderr }
  }

  const ownership = findOwner(port)
  if (ownership.ok !== true) return { ok: false, exitCode: 2, reason: `无法校验端口归属：${ownership.reason}` }
  const verdict = isTargetDshProcess(ownership.owner, { port, profile })
  if (ownership.owner !== undefined && verdict.ok !== true) return { ok: false, exitCode: 2, reason: `拒绝 kill：${verdict.reason}` }

  if (ownership.owner !== undefined) {
    const killed = runSync(`powershell.exe -NoProfile -NonInteractive -Command "Stop-Process -Id ${ownership.owner.pid} -Force"`)
    if (killed.status !== 0) return { ok: false, exitCode: 1, reason: `kill ${ownership.owner.pid} 失败：${killed.stderr.trim()}` }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }

  const before = size(logPath)
  const resolved = resolveCommand(env)
  if (resolved.kind === 'missing') return { ok: false, exitCode: 2, reason: resolved.reason }
  const args = ['web', '--port', String(port), '--no-open']
  let fd
  try {
    fd = openSync(logPath, 'a')
    /**
     * ⚠️ 实测（2026-10-01 T6 第一次真跑）两处都必须对：
     *
     * 1. **`detached: true`**：`detached: false` + `unref()` 不会活下来 ——
     *    编排进程一退出，Windows 上刚拉起的 `dsh web` 随之消失（restart 报 ok、health 永远等不到）。
     *    被 `unref()` 的句柄不再阻止父进程退出，但子进程仍挂在父进程的作业树上。
     * 2. **不走 shell / 不走 `dsh.cmd`**：见 `resolveDshCommand` 的注释 ——
     *    cmd.exe 那一层会让 stdout **落不进日志文件**，token 阶段直接死掉。
     */
    const spawnImpl = deps.spawn ?? spawn
    const child = resolved.kind === 'override'
      ? spawnImpl(`${resolved.command} web --port ${port} --no-open`, { cwd: workDir, env: { ...env, ...childEnv }, shell: true, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] })
      : spawnImpl(resolved.command, [resolved.bin, ...args], { cwd: workDir, env: { ...env, ...childEnv }, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] })
    child.unref()
    return { ok: true, method: 'native', pid: child.pid, command: resolved.kind === 'override' ? resolved.command : `${resolved.command} ${resolved.bin}`, args: args.join(' '), logPath, logOffset: before, killedPid: ownership.owner?.pid }
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

/** 读装盘产物里的版本/buildId/schema —— 三方构建标识比对要用它。 */
export function readInstalledInfo(profileDir, deps = {}) {
  const exists = deps.existsSync ?? existsSync
  const read = deps.readFileSync ?? readFileSync
  const base = join(profileDir, 'node_modules', '@dely0', 'dsh-personal-workbench')
  const info = { base, version: 'unknown', buildId: 'unknown', schemaVersion: undefined }
  try { info.version = JSON.parse(read(join(base, 'package.json'), 'utf8')).version ?? 'unknown' } catch { /* 缺失留给编排判 */ }
  if (exists(join(base, 'lib', 'build-info.json'))) {
    try { info.buildId = JSON.parse(read(join(base, 'lib', 'build-info.json'), 'utf8')).buildId ?? 'unknown' } catch { info.buildId = 'unparsable' }
  }
  if (exists(join(base, 'lib', 'db', 'schema.js'))) {
    try {
      const match = /SCHEMA_VERSION\s*=\s*(\d+)/.exec(read(join(base, 'lib', 'db', 'schema.js'), 'utf8'))
      info.schemaVersion = match === null ? undefined : Number(match[1])
    } catch { /* 保持 undefined */ }
  }
  return info
}

export function readProfileDependencies(profileDir, deps = {}) {
  const read = deps.readFileSync ?? readFileSync
  try { return JSON.parse(read(join(profileDir, 'package.json'), 'utf8')).dependencies ?? {} } catch { return undefined }
}

/**
 * 跑一个白名单套件（**独立子进程**）。
 *
 * 传参契约（T6 写套件时照这个来）：
 * - argv：`--url <target> --evidence-dir <本次证据目录> --user-data-root <临时浏览器目录根>`
 * - env：`DSH_VERIFY_TOKEN`（**不进 argv**：进程列表里看不到）
 * - stdout：最后一行是一个 JSON 汇总 `{passed,failed,skipped,total}`（也允许写
 *   `<evidence-dir>/suite-<id>.json`）
 *
 * 拿不到汇总 = 失败（**空计数绝不等于通过**）。
 */
export async function runSuiteProcess({ suite, repoRoot, url, token, evidenceDir, userDataRoot, timeoutMs, target }, deps = {}) {
  const run = deps.runCommand ?? runCommand
  const suitePath = join(repoRoot, suite.repoPath)
  /**
   * 套件 argv 契约：`--url / --evidence-dir / --user-data-root`（白名单三件套）+
   * **目标 profile 的显式声明**（`target` = `{profile, profileDir, dbPath}`）。
   *
   * 后三个是 T6 加上的，而且**必须由编排传进来**、不能从环境变量推断：
   * `verify-safety` 套件要复核自锁，它需要同时知道"目标是谁"和"当前是谁"。
   * 环境变量里只有"当前"（DSH_PROFILE/DSH_WEB_URL/DSH_PROFILE_DIR = 会话所在实例），
   * 而链给子进程的 `DSH_PROFILE_DIR` 是**目标**的 —— 早期版本让套件从环境变量推目标，
   * 于是桌面端会话里跑链时目标被推成 desktop，预检正确地报 `TARGET_OUT_OF_SCOPE`，
   * 看上去像"链坏了"，实际是"套件把当前实例当成了目标"（T6 实测踩到）。
   */
  const targetProfile = target?.profile ?? 'web'
  const targetProfileDir = target?.profileDir ?? ''
  const targetDbPath = target?.dbPath ?? ''
  const command = `node "${suitePath}" --url "${url}" --evidence-dir "${evidenceDir}" --user-data-root "${userDataRoot}" `
    + `--target-profile "${targetProfile}"`
    + (targetProfileDir === '' ? '' : ` --target-profile-dir "${targetProfileDir}"`)
    + (targetDbPath === '' ? '' : ` --db-path "${targetDbPath}"`)
  /**
   * 子进程环境：
   * - `DSH_VERIFY_TOKEN`（**故意不进 argv**：进程列表里可见）；
   * - `DSH_WEB_URL`：套件里的**自锁判据**需要它（`verify-safety` 要证明"目标不是当前实例"。
   *   T6 第一次跑时这里没传，于是 `preflight` 因为缺环境事实而拒绝，
   *   dry-run 拿到退出码 2 —— 看上去像"链坏了"，实际是环境没传进去。
   *   传的是**链自己看到的环境**（也就是当前会话的 URL），语义与链的预检完全一致；
   * - `DSH_PROFILE` / `DSH_PROFILE_DIR` / `WORKBENCH_EXPECTED_DB_PATH`：套件需要知道"目标被声明成什么"。
   */
  /**
   * 只放**真的拿到了值**的环境键。写成 `DSH_WEB_URL: ''` 是错的：
   * `spawn` 的 env 里出现空串时，子进程看到的是"这个变量存在但为空"，
   * 于是自锁判据报的是"环境事实非法（空值）"而不是"缺失" —— 排查时会被引偏。
   */
  const childEnv = { DSH_VERIFY_TOKEN: token ?? '' }
  for (const key of ['DSH_WEB_URL', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'WORKBENCH_EXPECTED_DB_PATH']) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') childEnv[key] = value
  }
  const result = await run(command, { cwd: repoRoot, env: childEnv, timeoutMs })
  if (result.timedOut) return { status: result.status, timedOut: true, summary: undefined, stdout: result.stdout, stderr: result.stderr, ms: result.ms }
  const parsed = parseSuiteSummary(result.stdout)
  const fromFile = parsed === undefined ? readSuiteSummaryFile(evidenceDir, suite.id, deps) : undefined
  return { status: result.status, timedOut: false, summary: parsed ?? fromFile, stdout: result.stdout, stderr: result.stderr, ms: result.ms }
}

export function parseSuiteSummary(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue
    try {
      const parsed = JSON.parse(lines[index])
      if (parsed !== null && typeof parsed === 'object' && ['passed', 'failed', 'skipped', 'total'].some((key) => typeof parsed[key] === 'number')) return parsed
    } catch { /* 不是汇总行，继续往前找 */ }
  }
  return undefined
}

export function readSuiteSummaryFile(evidenceDir, suiteId, deps = {}) {
  const exists = deps.existsSync ?? existsSync
  const read = deps.readFileSync ?? readFileSync
  const path = join(evidenceDir, `suite-${suiteId}.json`)
  if (!exists(path)) return undefined
  try {
    const parsed = JSON.parse(read(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch { return undefined }
}
