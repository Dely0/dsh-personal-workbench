/**
 * 研发验收链（plan.md V04 / requirements.md §7.2 / AX-V06–V09、AX-G04 的"不许吞错"部分）。
 *
 * ```sh
 * node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web \
 *   --profile-dir <测试 profile 绝对目录> --db-path <独立测试 DB 绝对路径>
 * node scripts/dev-verify.mjs ... --dry-run     # 只读预检 + 打印阶段计划，零写入
 * ```
 *
 * ## 阶段与退出码
 *
 * 预检 → 装前版本门禁 → 构建 → 打包装盘 → 零增量 diff → dump-config → 装后版本门禁 →
 * 只重启目标 → health → token → 白名单套件 → 证据包 → 清理本次浏览器。
 * **任一必需阶段非 0 立刻停**（不进入后续危险动作）。
 *
 * | 退出码 | 含义 |
 * |---|---|
 * | 0 | 所有必需阶段/套件通过 |
 * | 1 | 构建/装盘/断言失败，或 health 200 但构建标识不匹配（旧构建） |
 * | 2 | 配置/自锁拒绝/前置资源缺失（含必需套件还没迁入） |
 * | 3 | 等待超时（health 120s / token 60s / 单套件 180s） |
 *
 * ## 不许出现的失败模式（每条都有负向判据）
 *
 * - **缺套件/认证失败/空测试计数当通过** → 一律 blocked（AX-V07）。
 * - **finally 把失败吞成 0** → `finally` 只做清理与落盘，绝不改退出码（AX-V09）。
 * - **token 进证据** → 抓到那一刻就注册进脱敏表，之后所有写盘都过 redact（AX-V08）。
 * - **清理误伤** → 只删本次 run 的临时目录子树，不碰用户浏览器/别的进程（AX-V09）。
 * - **dry-run 有副作用** → dry-run 在预检通过后直接返回，证据目录都不建（AX-V05）。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvidenceRun, EVIDENCE_ROOT } from './verify/evidence.mjs'
import { AUTHORIZED_PORT, AUTHORIZED_PROFILE, PLUGIN_NAME, preflight, STAGE_PLAN } from './verify/safety.mjs'
import {
  fileSize,
  httpGetJson,
  readInstalledInfo,
  readLogFrom,
  readProfileDependencies,
  restartTarget,
  runCommand,
  runSuiteProcess,
  extractLatestToken,
  verifyTokenWorks,
} from './verify/runtime.mjs'

export const EXIT = { OK: 0, FAILED: 1, REFUSED: 2, TIMEOUT: 3 }

export const DEFAULT_TIMEOUTS = {
  healthMs: 120000,
  httpMs: 5000,
  tokenMs: 60000,
  suiteMs: 180000,
  commandMs: 900000,
}

export function parseArgs(argv) {
  const options = { timeouts: { ...DEFAULT_TIMEOUTS } }
  const take = (index) => argv[index + 1]
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--url') options.url = take(index)
    else if (arg === '--profile') options.profile = take(index)
    else if (arg === '--profile-dir') options.profileDir = take(index)
    else if (arg === '--db-path') options.dbPath = take(index)
    else if (arg === '--force') options.force = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--launcher') options.launcher = take(index)
    else if (arg === '--browser') options.browser = take(index)
    else if (arg === '--suites') options.suites = String(take(index) ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '')
    else if (arg === '--manifest') options.manifestPath = take(index)
    else if (arg === '--evidence-root') options.evidenceRoot = take(index)
    else if (arg === '--repo-root') options.repoRoot = take(index)
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--health-timeout') options.timeouts.healthMs = Number(take(index))
    else if (arg === '--token-timeout') options.timeouts.tokenMs = Number(take(index))
    else if (arg === '--suite-timeout') options.timeouts.suiteMs = Number(take(index))
    else if (arg.startsWith('--')) { options.bad = `未知参数：${arg}` }
    else continue
    if (arg !== '--force' && arg !== '--dry-run' && arg !== '--json' && arg !== '--help' && arg !== '-h') index += 1
  }
  return options
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

/** 默认依赖：真实实现。测试逐项注入假货来做故障注入。 */
export function defaultDeps(repoRoot) {
  return {
    repoRoot,
    preflight,
    runCommand: (command, options) => runCommand(command, options),
    httpJson: (url, timeoutMs) => httpGetJson(url, timeoutMs),
    verifyToken: (url, token, timeoutMs) => verifyTokenWorks(url, token, timeoutMs),
    readLogFrom,
    fileSize,
    readInstalledInfo,
    readProfileDependencies,
    restartTarget,
    runSuiteProcess,
    createEvidenceRun,
    existsSync,
    readFileSync,
    rmSync,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => new Date(),
    log: (text) => console.log(text),
  }
}

const stageStatusForExit = (exitCode) => (exitCode === 3 ? 'timeout' : exitCode === 2 ? 'refused' : 'fail')

/**
 * 跑整条链。
 *
 * @returns {Promise<{exitCode:number, verdict:string, summary:object|undefined, lines:string[]}>}
 */
export async function runDevVerify(options, deps = {}) {
  const d = { ...defaultDeps(options.repoRoot ?? process.cwd()), ...deps }
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts ?? {}) }
  const lines = []
  const stages = []
  const blockers = []
  const warnings = []
  const sideEffects = { installed: false, restarted: false, dbWrites: 0, browsersOpened: 0, tempDirsRemoved: 0 }
  const log = (text) => { lines.push(text); d.log?.(text) }
  const startedAt = d.now()
  const repoRoot = options.repoRoot ?? process.cwd()
  const url = options.url ?? `http://127.0.0.1:${AUTHORIZED_PORT}`
  const profile = options.profile ?? AUTHORIZED_PROFILE
  const profileDir = options.profileDir
  const dbPath = options.dbPath
  const manifestPath = options.manifestPath ?? join(repoRoot, 'scripts', 'verify', 'suites.json')
  const evidenceRoot = options.evidenceRoot ?? join(repoRoot, EVIDENCE_ROOT)
  const logPath = join(tmpdir(), `dsh-server-${new URL(url).port ?? AUTHORIZED_PORT}.log`)

  let run
  let finalized = false
  let context = {}

  /**
   * 浏览器侧构建标识（三方标识的第三只脚，AX-V07 / V04-B）。
   *
   * 为什么从**套件产物**里取而不是链自己去开浏览器：根属性 `data-workbench-build-id`
   * 只存在于真实页面里，而"打开面板并读它"这件事白名单里的 `legacy-acceptance`
   * 已经在做（它是唯一会打开面板的套件）。链在这里把它读回来汇进 summary，
   * 避免为了一个字段再起一次浏览器（那会多一次真实副作用）。
   */
  const readClientBuildId = () => {
    try {
      const path = join(run.dir, 'suite-legacy-acceptance.json')
      const parsed = JSON.parse(d.readFileSync(path, 'utf8'))
      const found = parsed?.checks?.find((entry) => entry.id.includes('浏览器根属性'))
      if (found?.detail === undefined || found.detail === null) return {}
      const detail = JSON.parse(found.detail)
      return { client: detail.clientAttr ?? null, clientMatched: found.status === 'pass', clientSource: 'suite-legacy-acceptance.json', clientExpected: detail.expectedBuildId ?? null }
    } catch {
      /** 读不到就**一个字段都不改**（不是把这几个字段写成 undefined 去盖掉已有的值）。 */
      return {}
    }
  }

  /** 只保留有值的键：避免"读不到"把已经算好的字段覆盖成 undefined。 */
  const withoutUndefined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

  const summaryBase = () => ({
    runId: run?.runId ?? null,
    startedAt: startedAt.toISOString(),
    finishedAt: d.now().toISOString(),
    durationMs: d.now() - startedAt,
    exitCode: EXIT.OK,
    verdict: 'pass',
    dryRun: options.dryRun === true,
    target: {
      url,
      profile,
      profileDir: profileDir ?? null,
      dbIsolation: {
        independent: context.verdict?.ok === true,
        targetDbPath: context.verdict?.facts?.target?.dbPath ?? null,
        currentDbPath: context.verdict?.facts?.current?.dbPath ?? null,
        declaredBy: (context.verdict?.facts?.target?.sources ?? []).filter((source) => source.found === true).map((source) => source.file),
      },
    },
    buildIdentity: context.buildIdentity ?? { package: {}, health: {}, client: null, matched: false, mismatches: [] },
    stages,
    suites: context.suites ?? [],
    blockers,
    warnings,
    sideEffects,
  })

  const record = (name, status, detail, extra = {}) => {
    stages.push({ name, status, detail, exitCode: extra.exitCode, ms: extra.ms ?? 0 })
    log(`  ${status === 'pass' ? '✅' : status === 'timeout' ? '⏱' : status === 'refused' ? '⛔' : '✖'} [${name}] ${detail}`)
  }

  // ── 预检（唯一在 dry-run 也会跑的阶段；只读）───────────────────────────────
  const verdict = await d.preflight({
    url, profile, profileDir, dbPath, force: options.force === true,
    env: options.env ?? process.env,
    home: options.home,
    dshHome: options.dshHome,
  }, d.preflightDeps ?? {})
  context.verdict = verdict
  if (verdict.ok !== true) {
    for (const entry of verdict.errors) blockers.push(`[${entry.code}] ${entry.message}`)
    record('preflight', 'refused', `${verdict.errors.length} 条拒绝理由（安装/kill/DB 写均为 0 次）`, { exitCode: EXIT.REFUSED })
    log('')
    log('⛔ 预检拒绝，未做任何构建/装盘/重启/写库：')
    for (const entry of verdict.errors) log(`   - [${entry.code}] ${entry.message}`)
    log('   说明：dry-run 与真实运行共用同一条预检；要真正跑链，先在目标 profile 里配置独立的 dbPath/dataDir（人工确认 + safe-plugin-ops），再重试。')
    return { exitCode: EXIT.REFUSED, verdict: 'refused', summary: undefined, lines }
  }
  for (const warning of verdict.warnings) warnings.push(`[${warning.code}] ${warning.message}`)
  record('preflight', 'pass', `目标 ${url} / profile ${profile} / DB ${verdict.facts.target.dbPath}（与当前实例不是同一个库）`)

  if (options.dryRun === true) {
    log('')
    log('· dry-run：只做只读预检 + 打印阶段计划，**不构建/不装盘/不重启/不写 DB/不开浏览器**（证据目录也不创建）')
    for (const [index, stage] of STAGE_PLAN.entries()) log(`   ${String(index + 1).padStart(2)}. ${stage.name}${stage.readonly ? '（只读）' : ''} — ${stage.detail}`)
    log(`  子进程环境会被重设为：${JSON.stringify(verdict.plan.childEnv)}`)
    return { exitCode: EXIT.OK, verdict: 'dry-run', summary: undefined, lines }
  }

  run = d.createEvidenceRun({ root: evidenceRoot, now: startedAt })
  const userDataRoot = join(run.dir, 'browser-temp')

  const stop = (exitCode, stageName, detail) => {
    record(stageName, stageStatusForExit(exitCode), detail, { exitCode })
    return { exitCode, verdict: stageStatusForExit(exitCode) }
  }

  let terminal
  try {
    // ── 装前版本门禁 ────────────────────────────────────────────────────────
    {
      const result = await d.runCommand(`node "${join(repoRoot, 'scripts', 'check-installed-version.mjs')}" --profile-dir "${profileDir}" --db-path "${dbPath}"`, { cwd: repoRoot, timeoutMs: timeouts.commandMs })
      if (result.status !== 0) { terminal = stop(EXIT.FAILED, 'version-before', `装前版本门禁未过（退出码 ${result.status}）：${(result.stdout + result.stderr).trim().split('\n').slice(-4).join(' / ')}`) }
      else record('version-before', 'pass', '装前后版本一致性的"装前"检查通过', { ms: result.ms })
    }

    // ── 构建 ────────────────────────────────────────────────────────────────
    if (terminal === undefined) {
      const result = await d.runCommand('pnpm build', { cwd: repoRoot, timeoutMs: timeouts.commandMs })
      if (result.status !== 0) { terminal = stop(EXIT.FAILED, 'build', `pnpm build 退出码 ${result.status}：${(result.stderr || result.stdout).trim().split('\n').slice(-4).join(' / ')}`) }
      else {
        const infoPath = join(repoRoot, 'lib', 'build-info.json')
        let buildId
        try { buildId = JSON.parse(d.readFileSync(infoPath, 'utf8')).buildId } catch { buildId = undefined }
        if (typeof buildId !== 'string' || buildId === '' || buildId === 'unknown') {
          terminal = stop(EXIT.FAILED, 'build', `构建产物缺少可用的构建标识（${infoPath}）—— buildId 是"是不是本次构建"的唯一判据，版本号不算`)
        } else {
          context.builtBuildId = buildId
          record('build', 'pass', `构建完成，本次 buildId=${buildId}`, { ms: result.ms })
        }
      }
    }

    // ── 打包装盘 ────────────────────────────────────────────────────────────
    if (terminal === undefined) {
      context.beforeDeps = d.readProfileDependencies(profileDir)
      const result = await d.runCommand(
        `node "${join(repoRoot, 'scripts', 'dev-install.mjs')}" --apply --no-build --profile ${profile} --profile-dir "${profileDir}" --db-path "${dbPath}" --skip-dump-config`,
        { cwd: repoRoot, env: verdict.plan.childEnv, timeoutMs: timeouts.commandMs },
      )
      if (result.status !== 0) { terminal = stop(EXIT.FAILED, 'install', `dev-install --apply 退出码 ${result.status}：${(result.stderr || result.stdout).trim().split('\n').slice(-5).join(' / ')}`) }
      else {
        sideEffects.installed = true
        context.installOutput = result.stdout
        record('install', 'pass', '已装盘（dev-install 内部的备份/零增量 diff/门禁都过了）', { ms: result.ms })
      }
    }

    // ── 零增量 diff ─────────────────────────────────────────────────────────
    if (terminal === undefined) {
      const after = d.readProfileDependencies(profileDir)
      const before = context.beforeDeps ?? {}
      const problems = []
      if (after === undefined) problems.push('读不了 profile package.json')
      else {
        for (const [name, spec] of Object.entries(before)) {
          if (name === PLUGIN_NAME) continue
          if (after[name] !== spec) problems.push(`无关插件被改了：${name} ${spec} → ${after[name]}`)
        }
        for (const name of Object.keys(after)) if (name !== PLUGIN_NAME && before[name] === undefined) problems.push(`凭空多出依赖：${name}`)
        const ours = after[PLUGIN_NAME]
        if (typeof ours !== 'string' || !ours.startsWith('file:')) problems.push(`${PLUGIN_NAME} 没有指向本地冻结包：${String(ours)}`)
      }
      if (problems.length > 0) terminal = stop(EXIT.FAILED, 'profile-diff', `零增量 diff 不干净：${problems.join('；')}`)
      else record('profile-diff', 'pass', `只有 ${PLUGIN_NAME} 变成本次的 file: 包，其余依赖与装盘版本零变化`)
    }

    // ── dump-config ─────────────────────────────────────────────────────────
    if (terminal === undefined) {
      const result = await d.runCommand(`dsh --profile ${profile} --dump-config`, { cwd: repoRoot, env: verdict.plan.childEnv, timeoutMs: timeouts.commandMs })
      if (result.status !== 0) terminal = stop(EXIT.FAILED, 'dump-config', `插件树组装失败（退出码 ${result.status}）：${(result.stderr || result.stdout).trim().split('\n').slice(-4).join(' / ')}`)
      else record('dump-config', 'pass', '插件树可以组装（--dump-config 退出码 0）', { ms: result.ms })
    }

    // ── 装后版本门禁 ─────────────────────────────────────────────────────────
    if (terminal === undefined) {
      const result = await d.runCommand(`node "${join(repoRoot, 'scripts', 'check-installed-version.mjs')}" --profile-dir "${profileDir}" --db-path "${dbPath}"`, { cwd: repoRoot, env: verdict.plan.childEnv, timeoutMs: timeouts.commandMs })
      if (result.status !== 0) terminal = stop(EXIT.FAILED, 'version-after', `装后版本门禁未过（退出码 ${result.status}）：${(result.stdout + result.stderr).trim().split('\n').slice(-4).join(' / ')}`)
      else record('version-after', 'pass', '装盘版本/声明/锁文件/库 schema 一致', { ms: result.ms })
    }

    // ── 只重启目标 ──────────────────────────────────────────────────────────
    if (terminal === undefined) {
      context.installed = d.readInstalledInfo(profileDir)
      const restarted = await d.restartTarget({
        port: new URL(url).port,
        profile,
        profileDir,
        dbPath,
        workDir: options.workDir ?? repoRoot,
        launcher: options.launcher,
        logPath,
        childEnv: verdict.plan.childEnv,
        env: options.env ?? process.env,
      }, d)
      if (restarted.ok !== true) { terminal = stop(restarted.exitCode ?? EXIT.FAILED, 'restart', `重启目标失败：${restarted.reason}`) }
      else {
        sideEffects.restarted = true
        context.logOffset = restarted.logOffset
        context.restart = restarted
        record('restart', 'pass', restarted.method === 'launcher'
          ? `已通过启动器重启目标：${restarted.launcher}`
          : `已按端口归属 kill PID ${restarted.killedPid ?? '(无旧进程)'} 并拉起 dsh web --port ${new URL(url).port} --no-open（日志 ${logPath}）`)
      }
    }

    // ── health ──────────────────────────────────────────────────────────────
    if (terminal === undefined) {
      const deadline = d.now().getTime() + timeouts.healthMs
      let sawHttp = false
      let mismatchStreak = 0
      let lastMismatch = []
      let body
      while (d.now().getTime() < deadline) {
        const response = await d.httpJson(`${url.replace(/\/$/, '')}/api/workbench/health`, timeouts.httpMs)
        if (response.ok === true && response.body !== undefined) {
          sawHttp = true
          body = response.body
          const mismatches = []
          if (body.ok !== true) mismatches.push('ok!=true')
          if (context.installed?.version !== undefined && body.version !== context.installed.version) mismatches.push(`包版本 ${context.installed.version} ≠ health ${body.version}`)
          if (context.installed?.buildId !== undefined && body.buildId !== context.installed.buildId) mismatches.push(`包 buildId ${context.installed.buildId} ≠ health ${body.buildId}`)
          if (context.installed?.schemaVersion !== undefined && Number(body.db?.schemaVersion) !== context.installed.schemaVersion) mismatches.push(`包 schema ${context.installed.schemaVersion} ≠ health ${body.db?.schemaVersion}`)
          if (mismatches.length === 0) { lastMismatch = []; break }
          mismatchStreak += 1
          lastMismatch = mismatches
          if (mismatchStreak >= 3) break
        }
        await d.sleep(1000)
      }
      const healthy = lastMismatch.length === 0 && body !== undefined
      context.health = body
      context.buildIdentity = {
        package: { version: context.installed?.version, buildId: context.installed?.buildId },
        health: { version: body?.version, buildId: body?.buildId, schemaVersion: body?.db?.schemaVersion },
        /**
         * 浏览器那一脚**这时还读不到**：它写在 `suite-legacy-acceptance.json` 里，
         * 而套件要到下一步才跑。所以这里留占位，真正的值在 `suites` 阶段之后
         * （写证据包之前）由 `readClientBuildId()` 补上。
         * 早期版本在这里就读 —— 于是 summary 里永远是 `client: null / 读不到`
         * （T6 实测：链跑了整整一轮，三方标识的第三只脚却是空的）。
         */
        client: null,
        clientMatched: false,
        clientSource: 'suite-legacy-acceptance.json（待 suites 阶段）',
        /**
         * `matched` = 包 == health（链自己比得出来）。
         * 浏览器那一脚由套件判（`clientMatched`），两者**分别**记录 ——
         * 合成一个布尔会把"浏览器没打开/套件没跑"与"标识不一致"混成同一种失败。
         */
        matched: healthy,
        mismatches: lastMismatch,
      }
      if (healthy) record('health', 'pass', `health ok：版本 ${body.version} / buildId ${body.buildId} / schema ${body.db?.schemaVersion}`)
      else if (sawHttp && lastMismatch.length > 0) terminal = stop(EXIT.FAILED, 'health', `health 有 200 但构建标识不匹配（旧构建不算成功）：${lastMismatch.join('；')}`)
      else terminal = stop(EXIT.TIMEOUT, 'health', `等待 health ≤${timeouts.healthMs}ms 超时（每次请求 ≤${timeouts.httpMs}ms）`)
    }

    // ── token ───────────────────────────────────────────────────────────────
    if (terminal === undefined) {
      const deadline = d.now().getTime() + timeouts.tokenMs
      let token
      let verified
      while (d.now().getTime() < deadline) {
        /**
         * 读**整份日志**取最后一个 token，不按 `logOffset` 读。
         * 原因见 `runtime.mjs#extractLatestToken`：`dsh web` 起来会截断日志，
         * offset 失效时按 offset 读会拿到**上一次启动**的 token，而那个 token 已过期 ——
         * 症状是 health 用 Bearer 照样通过、只有浏览器判据红（极难定位）。
         */
        const read = d.readLogFrom(logPath, 0)
        token = extractLatestToken(read.text)
        if (token !== undefined) {
          /**
           * **读到 ≠ 能用**：拿到之后真的用它认证一次。
           * 认证不过就继续等（可能是上一次启动的 token 还在日志里，新的还没写出来）。
           */
          verified = await d.verifyToken(`${url}`, token, timeouts.httpMs)
          if (verified.ok === true) break
          token = undefined
        }
        await d.sleep(500)
      }
      if (token === undefined) terminal = stop(EXIT.TIMEOUT, 'token', `等待可用 token ≤${timeouts.tokenMs}ms 超时（读 ${logPath}${verified === undefined ? '' : `；最后一次尝试：${verified.reason}`}）`)
      else {
        run.addSecret(token)
        context.token = token
        record('token', 'pass', `已从日志抓到本次启动的 token 并**用真实请求认证通过**（长度 ${token.length}，已注册脱敏，绝不写入证据）`)
      }
    }

    // ── 白名单套件 ──────────────────────────────────────────────────────────
    if (terminal === undefined) {
      const loaded = loadSuitesManifest(manifestPath, d)
      if (loaded.problems.length > 0) {
        for (const problem of loaded.problems) blockers.push(problem)
        terminal = stop(EXIT.REFUSED, 'suites', `白名单读不了：${loaded.problems.join('；')}`)
      } else {
        const required = loaded.manifest.suites.filter((suite) => suite.required === true)
        const notReady = required.filter((suite) => suite.status !== 'active')
        for (const suite of notReady) blockers.push(`必需套件未迁入仓库（${suite.status}）：${suite.id} → ${suite.repoPath}`)
        if (notReady.length > 0) {
          terminal = stop(EXIT.REFUSED, 'suites', `${notReady.length} 个必需套件还不是 active —— 缺套件一律不通过（不条件少测报绿）`)
        } else {
          const wanted = options.suites === undefined ? loaded.manifest.suites : loaded.manifest.suites.filter((suite) => options.suites.includes(suite.id))
          if (options.suites !== undefined) {
            const unknown = options.suites.filter((id) => !loaded.manifest.suites.some((suite) => suite.id === id))
            if (unknown.length > 0) terminal = stop(EXIT.REFUSED, 'suites', `--suites 里有点不出来的套件：${unknown.join('、')}`)
          }
          if (terminal === undefined) {
            context.suites = []
            for (const suite of wanted) {
              if (terminal !== undefined) break
              const result = await d.runSuiteProcess({ suite, repoRoot, url, token: context.token, evidenceDir: run.dir, userDataRoot, timeoutMs: timeouts.suiteMs, target: { profile, profileDir, dbPath } }, d)
              const summary = result.summary ?? {}
              const passed = Number(summary.passed ?? 0)
              const failed = Number(summary.failed ?? 0)
              const skipped = Number(summary.skipped ?? 0)
              const total = Number(summary.total ?? passed + failed + skipped)
              context.suites.push({ id: suite.id, status: result.timedOut ? 'timeout' : result.status === 0 ? 'pass' : 'fail', passed, failed, skipped, total, ms: result.ms ?? 0, command: `node ${suite.repoPath}` })
              if (result.timedOut) terminal = stop(EXIT.TIMEOUT, 'suites', `套件 ${suite.id} 超过 ${timeouts.suiteMs}ms 未结束（超时按 3 退出，且不进入后续阶段）`)
              else if (result.summary === undefined) terminal = stop(EXIT.FAILED, 'suites', `套件 ${suite.id} 没有产出汇总（空计数/读不到 summary 都不算通过）`)
              else if (total <= 0) terminal = stop(EXIT.FAILED, 'suites', `套件 ${suite.id} 的用例数是 0 —— 空测试不算通过`)
              else if (failed > 0 || result.status !== 0) terminal = stop(EXIT.FAILED, 'suites', `套件 ${suite.id} 失败：passed ${passed} / failed ${failed} / skipped ${skipped}`)
              else if (suite.required === true && skipped > 0) terminal = stop(EXIT.FAILED, 'suites', `必需套件 ${suite.id} 有 ${skipped} 项被跳过 —— skipped 意味着不通过`)
              else record('suites', 'pass', `套件 ${suite.id}：passed ${passed} / failed ${failed} / skipped ${skipped}`)
            }
          }
        }
      }
    }

    // ── 证据包 ──────────────────────────────────────────────────────────────
    if (terminal === undefined) {
      /**
       * 到这里 `legacy-acceptance` 已经跑完，浏览器侧构建标识可以读了 —— 补进三方标识，
       * 让 summary 里的 `client` 不再永远是 null。补齐后再落盘（顺序很关键）。
       */
      context.buildIdentity = { ...context.buildIdentity, ...withoutUndefined(readClientBuildId()) }
      const exitCode = EXIT.OK
      const summary = { ...summaryBase(), exitCode, verdict: 'pass', suites: context.suites ?? [] }
      run.finalize(summary)
      finalized = true
      record('evidence', 'pass', `证据包已写入 ${run.relDir}/（summary.json + summary.md）`)
    }
  } catch (error) {
    /**
     * 链内部抛异常（含注入的故障）**绝不能**变成退出码 0。
     * 这是 AX-V09 "finally 不覆盖失败为 0" 的另一半：连 catch 也不许吞。
     */
    terminal = stop(EXIT.FAILED, 'chain', `链内部异常：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    /**
     * `finally` **只**做两件事：清理本次的临时目录、把还没写过的 summary 落盘。
     * 它绝不把 exitCode 改成 0 —— AX-V09 点名的"finally 吞掉失败"就在这里防。
     */
    try {
      const removed = cleanupOwnTempDirs([userDataRoot], d)
      sideEffects.tempDirsRemoved = removed
      if (terminal !== undefined || finalized) {
        record('cleanup-browser', 'pass', `只清理本次的浏览器临时目录 ${userDataRoot}（${removed} 个目录）；用户浏览器与其他进程一律不碰`)
      }
    } catch (error) {
      warnings.push(`清理临时目录失败（不影响判定，但需要人工看一眼）：${String(error)}`)
    }
    if (run !== undefined && (terminal !== undefined || finalized)) {
      /**
       * 落盘前把浏览器侧构建标识补齐。
       *
       * 放在 `finally` 而不是只在"全绿"那条路上补：**失败的那一轮也要有它**。
       * 本轮真跑的失败点恰好落在这里 —— persona 的必需套件被 skip 判失败，
       * 于是走的是 `finally` 落盘那条路；如果只在成功路径补，summary 里的三方标识
       * 就永远是 `client: null`（T6 实测踩到）。
       */
      context.buildIdentity = { ...context.buildIdentity, ...withoutUndefined(readClientBuildId()) }
      const exitCode = terminal?.exitCode ?? EXIT.OK
      const summary = { ...summaryBase(), exitCode, verdict: terminal?.verdict ?? 'pass', suites: context.suites ?? [] }
      try {
        run.finalize(summary)
        finalized = true
      } catch (error) {
        warnings.push(`写 summary 失败：${String(error)}`)
      }
      terminal = { exitCode, verdict: terminal?.verdict ?? 'pass' }
    }
  }

  const finalExitCode = terminal?.exitCode ?? EXIT.OK
  const finalVerdict = terminal?.verdict ?? 'pass'
  return { exitCode: finalExitCode, verdict: finalVerdict, summary: finalized ? { ...summaryBase(), exitCode: finalExitCode, verdict: finalVerdict, suites: context.suites ?? [] } : undefined, lines, runId: run?.runId }
}

/** 只清本次 run 自己的临时目录子树（`test-results/workbench-verify/<runId>/...`）。 */
export function cleanupOwnTempDirs(dirs, deps = {}) {
  const rm = deps.rmSync ?? rmSync
  let removed = 0
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir === '') continue
    try { rm(dir, { recursive: true, force: true }); removed += 1 } catch { /* 被占着就留着，交给人工 */ }
  }
  return removed
}

export function loadSuitesManifest(manifestPath, deps = {}) {
  const exists = deps.existsSync ?? existsSync
  const read = deps.readFileSync ?? readFileSync
  if (!exists(manifestPath)) return { manifest: undefined, problems: [`白名单文件不存在：${manifestPath}`] }
  try {
    const manifest = JSON.parse(read(manifestPath, 'utf8'))
    if (!Array.isArray(manifest.suites)) return { manifest: undefined, problems: ['白名单缺少 suites 数组'] }
    return { manifest, problems: [] }
  } catch (error) {
    return { manifest: undefined, problems: [`白名单不是合法 JSON：${String(error)}`] }
  }
}

if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('用法：node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web --profile-dir <目录> --db-path <独立DB> [--dry-run] [--force] [--launcher <启动器>] [--suites a,b] [--json]')
    process.exit(0)
  }
  if (options.bad !== undefined) { console.error(`✖ ${options.bad}`); process.exit(2) }
  if (options.repoRoot === undefined) options.repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const result = await runDevVerify(options)
  console.log('')
  console.log(`=== 研发验收链：${result.verdict}（退出码 ${result.exitCode}）===`)
  if (options.json && result.summary !== undefined) console.log(JSON.stringify(result.summary, null, 2))
  else if (result.runId !== undefined) console.log(`  证据：${EVIDENCE_ROOT}/${result.runId}/summary.md`)
  process.exit(result.exitCode)
}
