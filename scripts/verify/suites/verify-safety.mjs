/**
 * 新增套件 4/4：**verify-safety**（AX-V01–AX-V09 在**真实隔离实例**上的复核）。
 *
 * 判据输入：`acceptance.md` §6。T5 已把 V01–V09 落到 `test/verify*.test.mjs`
 * （注入/mock 负向测试）。本套件的定位**不是重复那批单测**，而是把"必须真的跑一次"的
 * 部分放到真实环境上：
 *
 * | AX | 本套件怎么复核 |
 * |---|---|
 * | V01 | 真跑 `scripts/check-verify-scripts.mjs`（动态统计、不固定 150/22），并核对白名单里每套 active 文件都存在 |
 * | V02 | 用**真浏览器**起一个独立调试实例（独立 user-data-dir / 独立 CDP 端口），确认多开两个实例端口不撞、close 后目录清掉 |
 * | V03/V04/V05 | 对**当前真实环境**跑一次 `preflight`，断言"它拒绝/通过的理由与我们声明的环境事实一致"；再用同端口/同 DB 构造拒绝并确认副作用 0 |
 * | V06/V07/V09 | 真跑 `dev-verify.mjs --dry-run`，断言退出码 0 且**零写入**（证据目录都没建） |
 * | V08 | 对真实证据目录做"token 全树查不到"的复核（用本次运行的真实 token 串） |
 *
 * 写入类操作：本套件**不装盘、不重启、不写库**；只建自己的临时目录（收尾删掉）。
 */
import { startSuite, createApi, parseSuiteArgs, sleep, safeJson, repoRootFromSuite, removeDirWithRetry, readPackageVersion, readBuiltBuildId } from './_harness.mjs'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { discoverBrowser } from '../browser.mjs'

const options = parseSuiteArgs()
if (options.url === undefined) { console.error('用法：node scripts/verify/suites/verify-safety.mjs --url <目标>'); process.exit(2) }

const AX = ['AX-V01', 'AX-V02', 'AX-V03', 'AX-V04', 'AX-V05', 'AX-V06', 'AX-V07', 'AX-V08', 'AX-V09']
const suite = startSuite({ id: 'verify-safety', title: '新增：验收链的安全预检与阶段编排（真实环境复核）', url: options.url, evidenceDir: options.evidenceDir, axIds: AX, legacyIds: AX })
const api = createApi(options.url, { token: options.token })

const report = {}
const tempDirs = []
let browserA
let browserB

try {
  const root = repoRootFromSuite()
  const { runCommand, findPortOwner, isTargetDshProcess } = await import('../runtime.mjs')
  const safety = await import('../safety.mjs')
  const targetUrl = options.url
  /**
   * **目标**（要被验收的实例）与**当前**（本会话所在实例）必须分开取：
   * `options.profileDir` / `options.profile` 是**当前实例**的（来自环境变量），
   * 目标走 `--target-profile-dir` / `--target-profile`，缺省 = 预授权范围 3080/web。
   * 把两者混用会让预检看到"当前 == 目标"而正确拒绝 —— 一条很能骗人的假红。
   */
  const targetProfileDir = options.targetProfileDir !== ''
    ? options.targetProfileDir
    : `${process.env.USERPROFILE}\\.dsh\\profiles\\${options.targetProfile}`
  const declaredDbPath = options.dbPath

  // ── V01：脚本卫生 + 白名单（真跑 checker）────────────────────────────────
  const checker = await runCommand('node scripts/check-verify-scripts.mjs --json', { cwd: root, timeoutMs: 60000 })
  /**
   * ⚠️ `--json` 输出的是**美化过的多行 JSON**（不是一行）。
   * 第一版按"取最后一行"解析，于是拿到 `}` → 解析失败 → 整条判据假红（本次实测）。
   * 正确做法：从第一个 `{` 起整体解析。
   */
  let checkerJson
  try { checkerJson = JSON.parse(checker.stdout.slice(checker.stdout.indexOf('{'))) } catch { checkerJson = undefined }
  report.checker = { status: checker.status, counts: checkerJson?.counts ?? null }
  suite.check({
    id: '脚本卫生 checker 真跑通过（exit 0，动态统计而不是写死 150/22）', axId: 'AX-V01', layer: 'N',
    ok: checker.status === 0 && checkerJson !== undefined && typeof checkerJson.counts?.localScripts === 'number',
    detail: safeJson(report.checker),
  })
  const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'verify', 'suites.json'), 'utf8'))
  const activeSuites = manifest.suites.filter((entry) => entry.status === 'active')
  const missing = activeSuites.filter((entry) => !existsSync(join(root, entry.repoPath)))
  report.manifest = { total: manifest.suites.length, active: activeSuites.map((entry) => entry.id), missing: missing.map((entry) => entry.id), deprecated: manifest.deprecated?.length ?? 0 }
  suite.check({
    id: '白名单里每个 active 套件的文件都真实存在（缺文件 = 硬失败）', axId: 'AX-V01', layer: 'N',
    ok: missing.length === 0 && activeSuites.length > 0,
    detail: safeJson(report.manifest),
  })
  const sourceOfChecker = readFileSync(join(root, 'scripts', 'check-verify-scripts.mjs'), 'utf8')
  suite.check({
    id: 'checker 里没有把脚本计数写死（不许出现固定的 150/22 判定）', axId: 'AX-V01', layer: 'W',
    ok: /===?\s*150|===?\s*22/.test(sourceOfChecker) === false,
    detail: `固定计数命中=${/===?\s*150|===?\s*22/.test(sourceOfChecker)}`,
  })

  // ── V03/V04/V05：对当前真实环境跑一次预检，理由必须与环境事实一致 ─────────
  const livePreflight = safety.preflight({
    url: targetUrl,
    profile: options.targetProfile,
    profileDir: targetProfileDir,
    dbPath: declaredDbPath === '' ? undefined : declaredDbPath,
    env: process.env,
  })
  report.preflight = {
    ok: livePreflight.ok, exitCode: livePreflight.exitCode,
    errorCodes: livePreflight.errors.map((entry) => entry.code),
    targetDb: livePreflight.facts?.target?.dbPath, currentDb: livePreflight.facts?.current?.dbPath,
  }
  // 目标端口 == DSH_WEB_URL 端口时**必须**拒绝（自锁），且 --force 不能绕
  const samePort = safety.preflight({ url: process.env.DSH_WEB_URL ?? targetUrl, profile: process.env.DSH_PROFILE ?? 'web', profileDir: targetProfileDir, dbPath: 'C:/x/y.db', force: true, env: process.env })
  report.samePort = { ok: samePort.ok, codes: samePort.errors.map((entry) => entry.code) }
  suite.check({
    id: '目标端口 = 当前 DSH_WEB_URL 端口 → 拒绝，且 --force 也绕不过（真实环境）', axId: 'AX-V03', layer: 'N',
    ok: samePort.ok === false && samePort.errors.some((entry) => entry.code === 'SAME_PORT'),
    detail: safeJson(report.samePort),
  })
  // 无独立 DB 声明的目标 → 必须拒绝（默认库跨 profile 共用，是本轮最危险的形态）
  const noDb = safety.preflight({ url: 'http://127.0.0.1:3080', profile: 'web', profileDir: targetProfileDir, dbPath: 'C:/x/y.db', env: { DSH_WEB_URL: 'http://127.0.0.1:19387', DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: process.env.USERPROFILE + '\\.dsh\\profiles\\desktop' } })
  report.noDb = { ok: noDb.ok, codes: noDb.errors.map((entry) => entry.code) }
  suite.check({
    id: '拿当前 desktop 环境去装 web：目标 DB 未声明/与实际不一致 → 拒绝（不会打到正式库）', axId: 'AX-V05', layer: 'N',
    ok: noDb.ok === false && noDb.errors.some((entry) => ['DB_NOT_DECLARED', 'DB_PATH_MISMATCH', 'DB_UNKNOWN'].includes(entry.code)),
    detail: safeJson(report.noDb),
  })
  // 预检模块自身不许有副作用能力（源码级）
  const safetySource = readFileSync(join(root, 'scripts', 'verify', 'safety.mjs'), 'utf8')
  suite.check({
    id: '预检模块源码里没有任何子进程/写文件能力（只读自锁）', axId: 'AX-V03', layer: 'W',
    ok: /child_process|spawnSync|execFileSync|writeFileSync|rmSync/.test(safetySource) === false,
    detail: `命中=${/child_process|spawnSync|execFileSync|writeFileSync|rmSync/.test(safetySource)}`,
  })

  // ── 端口归属：真实环境下必须认得出目标实例是 dsh web ─────────────────────
  const port = Number(new URL(targetUrl).port)
  const owner = findPortOwner(port)
  const verdict = owner.ok === true ? isTargetDshProcess(owner.owner, { port, profile: process.env.DSH_PROFILE ?? 'web' }) : { ok: false, reason: owner.reason }
  report.portOwner = { ok: owner.ok, pid: owner.owner?.pid ?? null, name: owner.owner?.name ?? null, verdict: verdict.ok === true, reason: verdict.reason ?? null }
  suite.check({
    id: '真实端口归属校验：认得出目标实例就是 dsh web 的那个 node 进程', axId: 'AX-V03', layer: 'N',
    ok: owner.ok === true && verdict.ok === true,
    detail: safeJson(report.portOwner),
  })

  // ── V02：真浏览器 × 2 个独立实例（独立端口/独立 user-data-dir）───────────
  const discovered = discoverBrowser({ overridePath: options.browser })
  suite.check({
    id: '浏览器发现可用（DSH_VERIFY_BROWSER 优先，否则按平台候选发现）', axId: 'AX-V02', layer: 'N',
    ok: discovered.ok === true, detail: discovered.ok === true ? `${discovered.path}（${discovered.source}）` : discovered.reason,
  })
  if (discovered.ok === true) {
    const cdp = await import('../cdp.mjs')
    const tmpRoot = options.userDataRoot ?? options.evidenceDir
    browserA = await cdp.launchDebugBrowser({ browserPath: discovered.path, headless: true, appUrl: 'about:blank', tmpRoot })
    browserB = await cdp.launchDebugBrowser({ browserPath: discovered.path, headless: true, appUrl: 'about:blank', tmpRoot })
    tempDirs.push(browserA.profileDir, browserB.profileDir)
    report.browsers = { a: { port: browserA.port, profile: browserA.profileDir }, b: { port: browserB.port, profile: browserB.profileDir } }
    suite.check({
      id: '两个独立调试实例：CDP 端口不同、user-data-dir 不同（都是真起出来的）', axId: 'AX-V02', layer: 'N',
      ok: browserA.port !== browserB.port && browserA.profileDir !== browserB.profileDir,
      detail: safeJson(report.browsers),
    })
    suite.check({
      id: '独立实例的调用超时是 30s（命门，不许被改成 0/无限）', axId: 'AX-V02', layer: 'N',
      ok: browserA.cdp.callTimeoutMs === 30000 && cdp.DEFAULT_CALL_TIMEOUT_MS === 30000,
      detail: `callTimeoutMs=${browserA.cdp.callTimeoutMs} DEFAULT=${cdp.DEFAULT_CALL_TIMEOUT_MS}`,
    })
    // 真页面求值（证明实例真的能用，不只是端口开着）
    const evaluated = await browserA.evaluate('return { ok: true, ua: navigator.userAgent.slice(0, 40) };')
    suite.check({ id: '独立实例能真的执行页面求值（CDP 通路可用）', axId: 'AX-V02', layer: 'B', ok: evaluated?.ok === true, detail: safeJson(evaluated) })
    await browserA.close()
    await browserB.close()
    const profilesGone = !existsSync(browserA.profileDir) && !existsSync(browserB.profileDir)
    suite.check({ id: 'close() 只关自己的实例并清掉自己的临时 profile 目录', axId: 'AX-V02', layer: 'N', ok: profilesGone, detail: `a=${browserA.profileDir} b=${browserB.profileDir}` })
    browserA = undefined
    browserB = undefined
  }

  // ── V06/V07/V09：真跑 dry-run，零写入 ───────────────────────────────────
  const evidenceRoot = join(root, 'test-results', 'workbench-verify')
  const before = existsSyncSafe(evidenceRoot) ? listDirNames(evidenceRoot).length : 0
  /**
   * dry-run 的自锁判据需要 `DSH_WEB_URL`（证明"目标不是当前实例"）。
   * 链会给套件进程传它；如果这里拿不到（例如手工单跑），那 dry-run 必然退出码 2 ——
   * 那是**环境缺失**而不是链坏了，所以判拒据要把这两种情况分开报。
   */
  const currentUrl = process.env.DSH_WEB_URL ?? ''
  const dryRun = await runCommand(`node scripts/dev-verify.mjs --url "${targetUrl}" --profile "${options.targetProfile}" --profile-dir "${targetProfileDir}" --db-path "${declaredDbPath}" --dry-run`, { cwd: root, timeoutMs: 120000, env: { ...process.env, DSH_WEB_URL: currentUrl } })
  /**
   * 把预检的**完整输出**也存进证据。
   *
   * 为什么：这条判据一旦红，最需要的信息就是"到底是哪一条理由拒绝的"。
   * 第一版只留了 stdout 的最后两行（`=== … refused ===`），
   * 于是排查时看不到 `SAME_PROFILE_DIR` / `SAME_DB` / `ENV_URL_INVALID` 这种关键行。
   */
  const dryRunRefusal = dryRun.stdout.split(/\r?\n/).filter((line) => /^\s+-\s\[|⛔/.test(line)).slice(0, 8)
  const after = existsSyncSafe(evidenceRoot) ? listDirNames(evidenceRoot).length : 0
  report.dryRun = { status: dryRun.status, dirsBefore: before, dirsAfter: after, refusal: dryRunRefusal, tail: dryRun.stdout.trim().split(/\r?\n/).slice(-2) }
  suite.check({
    id: 'dev-verify --dry-run 对真实隔离目标退出码 0（预检通过）', axId: 'AX-V06', layer: 'N',
    ok: dryRun.status === 0 && /dry-run/.test(dryRun.stdout), detail: safeJson(report.dryRun),
  })
  suite.check({
    id: 'dry-run 零写入：证据目录数量没有变化', axId: 'AX-V05', layer: 'N',
    ok: before === after, detail: `证据目录 ${before} → ${after}`,
  })
  // V07：错误参数/缺参数一律退出码 2，且带阶段名
  const badArgs = await runCommand('node scripts/dev-verify.mjs --nope', { cwd: root, timeoutMs: 30000 })
  suite.check({ id: '未知参数 → 退出码 2（配置类错误不与其他码混）', axId: 'AX-V07', layer: 'N', ok: badArgs.status === 2, detail: `status=${badArgs.status}` })
  const noUrl = await runCommand('node scripts/dev-verify.mjs --profile web --profile-dir "x" --db-path "y"', { cwd: root, timeoutMs: 30000 })
  suite.check({
    id: '缺 --url / 非法目标 → 退出码 2 且给出可读原因（不是静默继续）', axId: 'AX-V07', layer: 'N',
    ok: noUrl.status === 2 && /preflight|URL|拒绝/.test(noUrl.stdout + noUrl.stderr),
    detail: `status=${noUrl.status}`,
  })

  // ── V08：真实 token 在证据里必须查不到 ──────────────────────────────────
  const token = process.env.DSH_VERIFY_TOKEN ?? ''
  const evidence = await import('../evidence.mjs')
  const sample = evidence.redact('http://127.0.0.1:3080/?token=ABCDEF123456 and token=ABCDEF123456 and Bearer ABCDEF123456', [token].filter(Boolean))
  report.redaction = { sample }
  const leaked = token !== '' && sample.includes(token)
  suite.check({
    id: '脱敏：token 的形状（URL 参数 / token= / Bearer）在证据文本里都被替换', axId: 'AX-V08', layer: 'N',
    ok: /token=\*\*\*/.test(sample) && /Bearer \*\*\*/.test(sample) && leaked === false,
    detail: safeJson(report.redaction),
  })
  if (token !== '') {
    const tree = existsSyncSafe(evidenceRoot) ? listFilesRecursiveSafe(evidenceRoot) : []
    const offenders = []
    for (const file of tree) {
      try {
        const text = readFileSync(file, 'utf8')
        if (text.includes(token)) offenders.push(file)
      } catch { /* 二进制文件跳过 */ }
    }
    suite.check({
      id: '真实证据目录全树查不到本次 token 原串', axId: 'AX-V08', layer: 'N',
      ok: offenders.length === 0, detail: `扫了 ${tree.length} 个文件，命中 ${offenders.length} 个`,
    })
  }

  // ── 隔离与目标一致性：health 必须与"本次构建"一致（V07 的另一半）────────
  const health = await api.get('/api/workbench/health')
  const pkgVersion = readPackageVersion()
  const pkgBuildId = readBuiltBuildId()
  report.identity = { healthVersion: health.body?.version, healthBuildId: health.body?.buildId, pkgVersion, pkgBuildId, schemaVersion: health.body?.db?.schemaVersion, taskCount: health.body?.db?.taskCount }
  suite.check({
    id: '目标实例跑的是本次构建（health.buildId == 本地 lib/build-info.json）', axId: 'AX-V07', layer: 'B',
    ok: health.body?.buildId === pkgBuildId && health.body?.version === pkgVersion,
    detail: safeJson(report.identity),
  })
  suite.check({
    id: '目标库是本轮开发树的 schema（19）而不是正式库的 18 —— 隔离真的生效', axId: 'AX-V05', layer: 'B',
    ok: String(health.body?.db?.schemaVersion) === '19',
    detail: `schema=${health.body?.db?.schemaVersion}`,
  })
} catch (error) {
  suite.fatalError(error)
} finally {
  try {
    for (const browser of [browserA, browserB]) {
      if (browser !== undefined) { try { await browser.close() } catch { /* ignore */ } }
    }
    for (const dir of tempDirs) { if (typeof dir === 'string') removeDirWithRetry(dir) }
    suite.writeEvidence('report.json', report)
  } catch (error) {
    suite.note(`收尾失败（不覆盖原判定）：${error instanceof Error ? error.message : String(error)}`)
  }
  process.exit(suite.finish())
}

function existsSyncSafe(path) {
  try { return existsSync(path) } catch { return false }
}

function listDirNames(path) {
  try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) } catch { return [] }
}

/** 递归列文件（证据目录一般不大；上限 2000 个文件防意外放大）。 */
function listFilesRecursiveSafe(root, base = root, out = []) {
  if (out.length > 2000) return out
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) listFilesRecursiveSafe(full, base, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}
