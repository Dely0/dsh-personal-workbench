/**
 * AX-V06–V09 + AX-G04（"套件不许吞错报绿"那一半）+ V04-B 构建标识。
 *
 * 判据来源：requirements.md §7.2–7.3、acceptance.md AX-V06–V09 / AX-G04、plan.md V04/V04-B。
 *
 * 全部用**注入的假阶段**做故障注入（真跑要装盘+重启一个真实实例，归 T6 在隔离环境执行）：
 *
 * | 编号 | 这一组要钉住的 |
 * |---|---|
 * | AX-V06 | 逐阶段注入 构建/装盘/diff/dump-config 失败 → 后阶段**不运行**；装前/装后版本门禁都必须 0 |
 * | AX-V07 | health 200 但旧构建 → 拒绝；health/token 超时 → 退出码 3 且带阶段名；缺套件/空计数/required skipped 都不通过 |
 * | AX-V08 | token 全程不进证据（真证据包 + 假 token 走一遍，全树查不到原串） |
 * | AX-V09 | 套件超时退出码 3；链内部异常退出码 1（`finally` 不覆盖失败为 0）；清理只碰本次临时目录 |
 * | AX-G04 | 套件没有汇总/0 用例 = 失败，绝不报绿 |
 * | V04-B | buildId 确定性、三方标识（包 manifest / health / client 内联）同源 |
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWED_REQUIRED_SKIPS, EXIT, runDevVerify } from '../scripts/dev-verify.mjs'
import { createEvidenceRun, EVIDENCE_ROOT, makeRunId, readAllText, redact } from '../scripts/verify/evidence.mjs'
import { STAGE_PLAN } from '../scripts/verify/safety.mjs'
import { BUILD_INFO_RELATIVE, collectInputFiles, computeBuildId, writeBuildInfo } from '../scripts/build-info.mjs'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { readInlineBuildId } from '../lib/client/buildId.js'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))

const FAKE_TOKEN = 'FAKEtok3nValueForRedactionCheck'
const MANIFEST_PATH = join(REPO, 'scripts', 'verify', 'suites.json')

const evidenceRoot = () => mkdtempSync(join(tmpdir(), 'wb-devverify-evidence-'))

function clock(startMs = Date.parse('2026-10-01T00:00:00Z'), stepMs = 1000) {
  let ticks = 0
  return () => new Date(startMs + (ticks += stepMs))
}

const okResult = (extra = {}) => ({ status: 0, stdout: '', stderr: '', ms: 1, timedOut: false, ...extra })

/** 组装一个全部注入的链环境；`overrides` 逐项替换依赖或改假结果。 */
function makeEnv(overrides = {}) {
  const calls = { commands: [], suites: [], http: 0, restarts: 0, removed: [], finalized: 0, secrets: [] }
  let dependencyReads = 0
  const clockNow = clock()

  const manifest = overrides.manifest ?? {
    suites: [{ id: 'legacy-acceptance', kind: 'legacy', required: true, status: 'active', repoPath: 'scripts/verify/suites/legacy-acceptance.mjs' }],
  }
  const files = new Map([
    [join(REPO, BUILD_INFO_RELATIVE), JSON.stringify({ buildId: 'wb-fixture' })],
    [MANIFEST_PATH, JSON.stringify(manifest)],
    ...(overrides.files ?? []),
  ])

  const defaultPreflight = {
    ok: true,
    exitCode: 0,
    reasons: [],
    errors: [],
    warnings: overrides.preflightWarnings ?? [],
    facts: {
      current: { url: 'http://127.0.0.1:19387', port: 19387, profile: 'desktop', profileDir: 'C:/profiles/desktop', dbPath: 'C:/shared/workbench.db', sources: [] },
      target: { url: 'http://127.0.0.1:3080', port: 3080, profile: 'web', profileDir: 'C:/profiles/web', dbPath: 'C:/verify/verify-web.db', declaresDb: true, sources: [{ file: 'C:/profiles/web/cordis.patch.yml', found: true }] },
      force: false,
    },
    plan: {
      stages: STAGE_PLAN,
      childEnv: { DSH_PROFILE: 'web', DSH_PROFILE_DIR: 'C:/profiles/web', WORKBENCH_PROFILE_DIR: 'C:/profiles/web' },
      overrideEnv: ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'WORKBENCH_PROFILE_DIR'],
      scrubEnv: ['WORKBENCH_DB_PATH'],
      sideEffects: { installed: false, restarted: false, dbWrites: 0, browsers: 0 },
    },
  }

  const commandTable = overrides.commandTable ?? (() => okResult())

  const deps = {
    now: clockNow,
    sleep: async () => {},
    log: () => {},
    preflight: async () => overrides.preflight ?? defaultPreflight,
    runCommand: async (command, options) => {
      calls.commands.push({ command, options })
      return commandTable(command, options, calls)
    },
    httpJson: async () => {
      calls.http += 1
      return overrides.httpJson === undefined
        ? { ok: true, status: 200, body: { ok: true, name: '@dely0/dsh-personal-workbench', version: '1.15.8', buildId: 'wb-fixture', db: { schemaVersion: '19', taskCount: 1, dictionaryCount: 1 } } }
        : overrides.httpJson(calls)
    },
    readLogFrom: () => {
      if (overrides.readLogFrom !== undefined) return overrides.readLogFrom(calls)
      return { text: `dsh web: http://127.0.0.1:3080/?token=${FAKE_TOKEN}`, offset: 400, truncated: false }
    },
    /**
     * 取日志里最后一个 token（T6 加的真实实现是 `extractLatestToken`；这里直接内联同样的语义，
     * 让单测不必 import 生产模块）。
     */
    extractLatestToken: (text) => {
      const matches = [...String(text ?? '').matchAll(/token=([A-Za-z0-9_\-]+)/g)]
      return matches.length === 0 ? undefined : matches[matches.length - 1][1]
    },
    /**
     * token 必须**真的认证通过**才算拿到（T6 加：读到 ≠ 能用）。
     * 默认返回通过；要测"token 无效导致超时"就覆盖它返回 `{ok:false}`。
     */
    verifyToken: async () => (overrides.verifyToken === undefined ? { ok: true, status: 303 } : overrides.verifyToken(calls)),
    fileSize: () => 0,
    readInstalledInfo: () => overrides.installedInfo ?? { version: '1.15.8', buildId: 'wb-fixture', schemaVersion: 19 },
    readProfileDependencies: () => {
      dependencyReads += 1
      if (overrides.readProfileDependencies !== undefined) return overrides.readProfileDependencies(dependencyReads)
      return dependencyReads === 1
        ? { '@dely0/dsh-personal-workbench': 'file:/_local-build/old.tgz', 'other-plugin': '^1.0.0' }
        : { '@dely0/dsh-personal-workbench': 'file:/_local-build/new-dev-20261001.tgz', 'other-plugin': '^1.0.0' }
    },
    restartTarget: async () => {
      calls.restarts += 1
      if (overrides.restartTarget !== undefined) return overrides.restartTarget(calls)
      return { ok: true, method: 'native', killedPid: 4242, logOffset: 100, logPath: 'C:/tmp/dsh-server-3080.log' }
    },
    runSuiteProcess: async (input) => {
      calls.suites.push(input)
      if (overrides.runSuiteProcess !== undefined) return overrides.runSuiteProcess(input, calls)
      return { status: 0, timedOut: false, summary: { passed: 3, failed: 0, skipped: 0, total: 3 }, stdout: '{"passed":3,"failed":0,"skipped":0,"total":3}', ms: 5 }
    },
    createEvidenceRun: overrides.createEvidenceRun ?? ((options) => {
      const run = {
        runId: 'fixture-run',
        dir: 'C:/evidence/fixture-run',
        relDir: 'test-results/workbench-verify/fixture-run',
        secrets: [],
        addSecret(value) { calls.secrets.push(value); run.secrets.push(value); return value },
        writeText() {},
        writeJson() {},
        writeBuffer() {},
        finalize() { calls.finalized += 1; return { summary: {} } },
      }
      return run
    }),
    existsSync: (path) => files.has(path) || path.endsWith('lib') === false,
    readFileSync: (path) => {
      if (files.has(path)) return files.get(path)
      throw new Error(`fixture 没有这个文件：${path}`)
    },
    rmSync: (path) => { calls.removed.push(path) },
    ...overrides.deps,
  }
  return { deps, calls, manifest }
}

const baseOptions = (overrides = {}) => ({
  url: 'http://127.0.0.1:3080',
  profile: 'web',
  profileDir: 'C:/profiles/web',
  dbPath: 'C:/verify/verify-web.db',
  repoRoot: REPO,
  timeouts: { healthMs: 5000, httpMs: 100, tokenMs: 3000, suiteMs: 1000, commandMs: 1000 },
  ...overrides,
})

const stageNames = (result) => result.summary?.stages?.map((stage) => stage.name) ?? []
const findStage = (result, name) => (result.summary?.stages ?? []).find((stage) => stage.name === name)

// ── V04-B 构建标识 ───────────────────────────────────────────────────────────

test('V04-B：buildId 是构建输入的内容哈希（同输入同值；改一个源文件就变；不含时间戳）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-buildinfo-'))
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"x","version":"1.0.0"}', 'utf8')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    const first = computeBuildId(root)
    assert.match(first, /^wb-[0-9a-f]{16}$/)
    assert.equal(computeBuildId(root), first, '同输入必须同值（不许掺时间戳/随机数）')
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2\n', 'utf8')
    assert.notEqual(computeBuildId(root), first, '改源码必须换标识')

    // 生成时间不进哈希
    const info1 = writeBuildInfo({ root, now: new Date('2026-01-01T00:00:00Z') })
    const info2 = writeBuildInfo({ root, now: new Date('2027-01-01T00:00:00Z') })
    assert.equal(info1.buildId, info2.buildId)
    assert.notEqual(info1.generatedAt, info2.generatedAt)
    assert.ok(info1.inputs >= 2)

    // test/ 与 docs/ 不是构建输入（改它不该改变"本次构建"）
    mkdirSync(join(root, 'test'))
    writeFileSync(join(root, 'test', 'x.test.mjs'), '// 无关\n', 'utf8')
    assert.equal(computeBuildId(root), info1.buildId, '改测试不该改变构建标识')
    assert.equal(collectInputFiles(root).some((file) => file.startsWith('test/')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('V04-B/AX-V07：三方构建标识同源 —— 包 manifest = client 内联 = host health', async () => {
  const manifest = JSON.parse(readFileSync(join(REPO, BUILD_INFO_RELATIVE), 'utf8'))
  assert.match(manifest.buildId, /^wb-[0-9a-f]{16}$/, '构建产物里必须有构建标识（先跑 pnpm build）')

  // ① client 内联值（bundle 最外层那句 globalThis.__WORKBENCH_BUILD_ID__）
  const clientBundle = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.ok(clientBundle.includes(manifest.buildId), 'client bundle 必须内联本次构建标识（不能靠 health 抄）')
  assert.ok(clientBundle.includes('__WORKBENCH_BUILD_ID__'))

  // ② host health 报的值：真路由 handler，读的是随包的同一份 lib/build-info.json
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const routes = makeRoutes(db, {})
  const healthRoute = routes.find((route) => route.path === '/api/workbench/health')
  assert.ok(healthRoute !== undefined, 'health 路由必须存在')
  let captured
  const response = {
    writeHead() {},
    end(body) { captured = JSON.parse(body) },
  }
  healthRoute.handler({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' }, url: '/api/workbench/health' }, response)
  assert.equal(captured.ok, true)
  assert.equal(captured.buildId, manifest.buildId, 'health 的 buildId 必须来自随包 manifest')
  db.close()

  // ③ 客户端根节点的属性读的是内联值（不是 health）
  assert.equal(readInlineBuildId({ __WORKBENCH_BUILD_ID__: manifest.buildId }), manifest.buildId)
  assert.equal(readInlineBuildId({}), 'unknown')
  assert.equal(readInlineBuildId(null), 'unknown')
  const clientSource = readFileSync(join(REPO, 'src', 'client', 'index.tsx'), 'utf8')
  assert.ok(/className="wb-panel-host"[^>]*data-workbench-build-id=\{WORKBENCH_BUILD_ID\}/.test(clientSource)
    || clientSource.includes('data-workbench-build-id={WORKBENCH_BUILD_ID}'), '自建根节点必须带 data-workbench-build-id')
  assert.equal(/data-workbench-build-id[^\n]*health/i.test(clientSource), false, '不许从 health 接口抄构建标识')
})

// ── 正常路径 ─────────────────────────────────────────────────────────────────

test('正常路径：阶段全过 → 退出码 0，阶段顺序/副作用/三元标识都写进 summary', async () => {
  const { deps, calls } = makeEnv()
  const result = await runDevVerify(baseOptions(), deps)
  assert.equal(result.exitCode, EXIT.OK, `阶段：${JSON.stringify(result.summary?.stages)}`)
  assert.equal(result.verdict, 'pass')
  assert.deepEqual(stageNames(result), ['preflight', 'version-before', 'build', 'install', 'profile-diff', 'dump-config', 'version-after', 'restart', 'health', 'token', 'suites', 'evidence', 'cleanup-browser'])
  assert.equal(result.summary.sideEffects.installed, true)
  assert.equal(result.summary.sideEffects.restarted, true)
  assert.equal(result.summary.sideEffects.tempDirsRemoved, 1)
  assert.equal(result.summary.buildIdentity.matched, true)
  assert.equal(result.summary.buildIdentity.package.buildId, 'wb-fixture')
  assert.equal(result.summary.buildIdentity.health.buildId, 'wb-fixture')
  assert.equal(result.summary.suites.length, 1)
  assert.equal(result.summary.suites[0].passed, 3)
  assert.equal(calls.secrets.includes(FAKE_TOKEN), true, 'token 抓到那一刻就必须注册进脱敏表')
  assert.equal(calls.finalized >= 1, true)
  // 清理只碰本次证据目录里的临时子树
  assert.ok(calls.removed.length >= 1)
  for (const path of calls.removed) assert.ok(path.includes('fixture-run'), `清理越界了：${path}`)
})

test('--dry-run：只读取预检 + 打印计划，零副作用（不建证据、不跑命令、不清理）', async () => {
  const { deps, calls } = makeEnv()
  const result = await runDevVerify(baseOptions({ dryRun: true }), deps)
  assert.equal(result.exitCode, EXIT.OK)
  assert.equal(result.verdict, 'dry-run')
  assert.equal(calls.commands.length, 0, 'dry-run 不许跑任何命令')
  assert.equal(calls.restarts, 0)
  assert.equal(calls.http, 0)
  assert.equal(calls.finalized, 0, 'dry-run 不许写证据')
  assert.equal(calls.removed.length, 0)
  assert.equal(result.summary, undefined, 'dry-run 不产出 summary（也就不会写任何证据文件）')
  assert.ok(result.lines.some((line) => line.includes('dry-run')))
  assert.ok(result.lines.some((line) => line.includes('install')))
})

test('预检拒绝：退出码 2，且不进任何后续阶段（安装/kill/DB 写 0 次）', async () => {
  const refused = {
    ok: false,
    exitCode: 2,
    errors: [{ code: 'DB_NOT_DECLARED', message: '目标 profile 没有独立 DB 配置' }],
    warnings: [],
    reasons: [],
    facts: { current: {}, target: {} },
    plan: { stages: STAGE_PLAN, childEnv: {}, overrideEnv: [], scrubEnv: [], sideEffects: {} },
  }
  const { deps, calls } = makeEnv({ preflight: refused })
  const result = await runDevVerify(baseOptions(), deps)
  assert.equal(result.exitCode, EXIT.REFUSED)
  assert.equal(result.verdict, 'refused')
  assert.equal(calls.commands.length, 0)
  assert.equal(calls.restarts, 0)
  assert.equal(calls.finalized, 0)
  assert.ok(result.lines.some((line) => line.includes('DB_NOT_DECLARED')))
  assert.ok(result.lines.some((line) => line.includes('dry-run 与真实运行共用同一条预检')))
})

// ── AX-V06 阶段失败即停 ──────────────────────────────────────────────────────

for (const [label, failOn, expectedStops] of [
  ['构建', 'pnpm build', ['install', 'profile-diff', 'dump-config', 'restart', 'health', 'token', 'suites']],
  ['装盘', 'dev-install.mjs', ['profile-diff', 'dump-config', 'restart', 'health', 'token', 'suites']],
  ['diff（无关插件被改）', 'DIFF', ['dump-config', 'restart', 'health', 'token', 'suites']],
  ['dump-config', '--dump-config', ['restart', 'health', 'token', 'suites']],
]) {
  test(`AX-V06：${label}失败 → 退出码 1，后续危险阶段一个都不跑`, async () => {
    const env = makeEnv({
      commandTable: (command) => (command.includes(failOn) && failOn !== 'DIFF' ? { status: 1, stdout: '', stderr: `${label} 炸了`, ms: 2, timedOut: false } : okResult()),
      readProfileDependencies: (nth) => (failOn === 'DIFF' && nth > 1
        ? { '@dely0/dsh-personal-workbench': 'file:/_local-build/new-dev.tgz', 'other-plugin': '^2.0.0' }
        : { '@dely0/dsh-personal-workbench': 'file:/_local-build/new-dev.tgz', 'other-plugin': '^1.0.0' }),
    })
    const result = await runDevVerify(baseOptions(), env.deps)
    assert.equal(result.exitCode, EXIT.FAILED)
    const names = stageNames(result)
    assert.ok(names.includes('preflight'))
    for (const later of expectedStops) {
      assert.equal(names.includes(later), false, `${label} 失败后不该跑 ${later}（实际阶段：${names.join(',')}）`)
    }
    assert.equal(env.calls.restarts, 0, `${label} 失败后绝不重启`)
    assert.equal(env.calls.http, 0, `${label} 失败后不该探 health`)
    assert.equal(env.calls.suites.length, 0)
  })
}

test('AX-V06：装前/装后版本门禁都必须 0；装前不过就停、装后不过也停', async () => {
  const before = makeEnv({ commandTable: (command) => (command.includes('check-installed-version') ? { status: 1, stdout: '', stderr: '版本不一致', ms: 1, timedOut: false } : okResult()) })
  const failedBefore = await runDevVerify(baseOptions(), before.deps)
  assert.equal(failedBefore.exitCode, EXIT.FAILED)
  assert.equal(stageNames(failedBefore).includes('build'), false)
  assert.equal(before.calls.commands.filter((entry) => entry.command.includes('check-installed-version')).length, 1)

  let gateCalls = 0
  const after = makeEnv({ commandTable: (command) => {
    if (!command.includes('check-installed-version')) return okResult()
    gateCalls += 1
    return gateCalls >= 2 ? { status: 1, stdout: '', stderr: '装后不一致', ms: 1, timedOut: false } : okResult()
  } })
  const failedAfter = await runDevVerify(baseOptions(), after.deps)
  assert.equal(failedAfter.exitCode, EXIT.FAILED)
  assert.equal(stageNames(failedAfter).includes('restart'), false, '装后门禁不过就不许重启')
  assert.equal(after.calls.restarts, 0)
})

test('AX-V06：构建产物缺 buildId → 当作构建失败（版本号不是构建戳）', async () => {
  const { deps, calls } = makeEnv({ files: [[join(REPO, BUILD_INFO_RELATIVE), JSON.stringify({ buildId: 'unknown' })]] })
  const result = await runDevVerify(baseOptions(), deps)
  assert.equal(result.exitCode, EXIT.FAILED)
  assert.match(findStage(result, 'build')?.detail ?? '', /构建标识/)
  assert.equal(calls.commands.some((entry) => entry.command.includes('dev-install')), false)
})

// ── AX-V07 health / token / 套件 ─────────────────────────────────────────────

test('AX-V07：health 200 但构建标识是旧的 → 退出码 1（旧构建不算成功），后续阶段不跑', async () => {
  const { deps, calls } = makeEnv({
    httpJson: () => ({ ok: true, status: 200, body: { ok: true, version: '1.15.8', buildId: 'wb-OLD', db: { schemaVersion: '19' } } }),
  })
  const result = await runDevVerify(baseOptions(), deps)
  assert.equal(result.exitCode, EXIT.FAILED)
  assert.match(findStage(result, 'health')?.detail ?? '', /不匹配|旧构建/)
  assert.equal(stageNames(result).includes('token'), false)
  assert.equal(calls.suites.length, 0)
})

test('AX-V07：health 一直不通 → 退出码 3 且阶段名是 health', async () => {
  const { deps } = makeEnv({ httpJson: () => ({ ok: false, status: 0, error: 'ECONNREFUSED' }) })
  const result = await runDevVerify(baseOptions(), deps)
  assert.equal(result.exitCode, EXIT.TIMEOUT)
  assert.equal(findStage(result, 'health')?.status, 'timeout')
  assert.match(findStage(result, 'health')?.detail ?? '', /超时/)
})

test('AX-V07：token 60s 内拿不到 → 退出码 3；套件一个都不跑', async () => {
  const { deps, calls } = makeEnv({ readLogFrom: () => ({ text: '只有启动横幅，没有 token', offset: 10, truncated: false }) })
  const result = await runDevVerify(baseOptions({ timeouts: { healthMs: 2000, httpMs: 100, tokenMs: 2000, suiteMs: 200, commandMs: 200 } }), deps)
  assert.equal(result.exitCode, EXIT.TIMEOUT)
  assert.equal(findStage(result, 'token')?.status, 'timeout')
  assert.equal(calls.suites.length, 0)
})

test('AX-V07/G04：必需套件还没迁入 → 退出码 2（缺套件不通过，也不假绿）', async () => {
  const { deps, calls } = makeEnv({
    manifest: { suites: [{ id: 'persona', kind: 'new', required: true, status: 'pending-migration', repoPath: 'scripts/verify/suites/persona.mjs', reason: 'T6 迁' }] },
  })
  const result = await runDevVerify(baseOptions(), deps)
  assert.equal(result.exitCode, EXIT.REFUSED)
  assert.match(findStage(result, 'suites')?.detail ?? '', /必需套件/)
  assert.ok(result.summary.blockers.some((text) => text.includes('persona')))
  assert.equal(calls.suites.length, 0)
})

test('AX-V07/G04：套件 0 用例 / 没有汇总 / required skipped / 断言失败 → 四种都不通过', async () => {
  const cases = [
    ['零用例', { status: 0, timedOut: false, summary: { passed: 0, failed: 0, skipped: 0, total: 0 }, ms: 1 }, /用例数是 0/],
    ['没有汇总', { status: 0, timedOut: false, summary: undefined, ms: 1 }, /没有产出汇总/],
    ['required skipped', { status: 0, timedOut: false, summary: { passed: 5, failed: 0, skipped: 1, total: 6 }, ms: 1 }, /跳过/],
    ['断言失败', { status: 1, timedOut: false, summary: { passed: 2, failed: 1, skipped: 0, total: 3 }, ms: 1 }, /失败/],
  ]
  for (const [label, suiteResult, pattern] of cases) {
    const { deps, calls } = makeEnv({ runSuiteProcess: () => suiteResult })
    const result = await runDevVerify(baseOptions(), deps)
    assert.equal(result.exitCode, EXIT.FAILED, `${label} 必须失败`)
    assert.match(findStage(result, 'suites')?.detail ?? '', pattern, `${label} 的失败原因要可读`)
    assert.equal(calls.finalized >= 1, true, `${label} 也要留证据`)
    assert.equal(stageNames(result).includes('evidence'), false, '套件失败后不再走"证据包"阶段（summary 由 finally 落盘）')
  }
})

test('AX-V09：套件超时 → 退出码 3，且不进入后续阶段', async () => {
  const { deps } = makeEnv({ runSuiteProcess: () => ({ status: 1, timedOut: true, summary: undefined, ms: 999999 }) })
  const result = await runDevVerify(baseOptions(), deps)
  assert.equal(result.exitCode, EXIT.TIMEOUT)
  assert.equal(findStage(result, 'suites')?.status, 'timeout')
})

/**
 * 必需套件的跳过：**登记过的放过、没登记的仍然失败**（2026-10-02 加）。
 *
 * 为什么这条要有：`persona` 那条"真实模型调用"按规格就该跳过，而旧规则"必需套件有任何跳过 ⇒ 失败"
 * 让链**永远红** —— 真正的红会被淹没在"又是这条"里。改成显式名单后必须两条都锁住：
 * ① 名单内的跳过 → 通过；② 名单外的跳过 → 仍然失败（**不许静默跳过**）。
 */
test('AX-V10：必需套件跳过 —— 名单内放过、名单外仍然失败（不许静默跳过）', async () => {
  const allowed = ALLOWED_REQUIRED_SKIPS[0]
  const manifest = {
    suites: [{ id: allowed.suite, kind: 'new', required: true, status: 'active', repoPath: `scripts/verify/suites/${allowed.suite}.mjs` }],
  }
  const summaryFor = (skippedChecks) => ({
    status: 0, timedOut: false, ms: 5,
    summary: { passed: 5, failed: 0, skipped: skippedChecks.length, total: 5 + skippedChecks.length, skippedChecks },
  })

  // ① 名单内的跳过 ⇒ 通过，且日志里要写明"跳过项已登记"
  const allowedEnv = makeEnv({ manifest, runSuiteProcess: () => summaryFor([allowed.check]) })
  const allowedResult = await runDevVerify(baseOptions(), allowedEnv.deps)
  assert.equal(allowedResult.exitCode, EXIT.OK, '登记过的跳过不该拦发布')
  assert.match(findStage(allowedResult, 'suites')?.detail ?? '', /跳过项已登记/, '要显式说明这次跳过是登记过的')

  // ② 名单外的跳过 ⇒ 失败，且把**跳过的条目 id** 打出来（只给计数没法核对）
  const otherEnv = makeEnv({ manifest, runSuiteProcess: () => summaryFor(['某条没登记过的检查']) })
  const otherResult = await runDevVerify(baseOptions(), otherEnv.deps)
  assert.equal(otherResult.exitCode, EXIT.FAILED, '名单外的跳过必须失败')
  assert.match(findStage(otherResult, 'suites')?.detail ?? '', /某条没登记过的检查/, '失败原因要带上跳过的条目 id')

  // ③ 套件连"跳过了哪条"都没报出来 ⇒ 也失败（没 id 就没法核对名单）
  const noIdEnv = makeEnv({ manifest, runSuiteProcess: () => ({ status: 0, timedOut: false, ms: 5, summary: { passed: 5, failed: 0, skipped: 1, total: 6 } }) })
  const noIdResult = await runDevVerify(baseOptions(), noIdEnv.deps)
  assert.equal(noIdResult.exitCode, EXIT.FAILED, '报不出跳过项 id 时不许放行')
  assert.match(findStage(noIdResult, 'suites')?.detail ?? '', /无法核对名单/)
})

test('AX-V09：链内部抛异常 → 退出码 1（finally 绝不覆盖成 0），且清理与证据仍然发生', async () => {
  const { deps, calls } = makeEnv({ runSuiteProcess: () => { throw new Error('注入的套件崩溃') } })
  const result = await runDevVerify(baseOptions(), deps)
  assert.equal(result.exitCode, EXIT.FAILED, '异常绝不能变成 0')
  assert.equal(findStage(result, 'chain')?.status, 'fail')
  assert.match(findStage(result, 'chain')?.detail ?? '', /注入的套件崩溃/)
  assert.ok(calls.removed.length >= 1, '异常时也要清理本次临时目录')
  assert.equal(calls.finalized >= 1, true, '异常时也要落盘证据')
})

test('AX-V09：清理只处理本次 run 的临时目录子树，不碰 profile/系统临时目录', async () => {
  const { deps, calls } = makeEnv()
  await runDevVerify(baseOptions(), deps)
  assert.equal(calls.removed.length, 1)
  const removed = String(calls.removed[0])
  assert.ok(removed.includes('fixture-run'), `清理路径必须是本 run 的证据目录：${removed}`)
  assert.ok(removed.endsWith('browser-temp'), removed)
  assert.equal(removed.includes('profiles'), false)
})

test('AX-V06：装盘阶段把目标 profile 与独立 DB 显式透传给子进程（不许靠继承）', async () => {
  const { deps, calls } = makeEnv()
  await runDevVerify(baseOptions(), deps)
  const install = calls.commands.find((entry) => entry.command.includes('dev-install.mjs'))
  assert.ok(install !== undefined)
  assert.ok(install.command.includes('--profile-dir "C:/profiles/web"'), install.command)
  assert.ok(install.command.includes('--db-path "C:/verify/verify-web.db"'), install.command)
  assert.equal(install.options.env.DSH_PROFILE, 'web')
  assert.equal(install.options.env.DSH_PROFILE_DIR, 'C:/profiles/web')
  assert.equal(install.options.env.WORKBENCH_PROFILE_DIR, 'C:/profiles/web')
})

// ── AX-V08 脱敏（用真证据包跑一遍）──────────────────────────────────────────

test('AX-V08：token 出现在日志/命令输出/测试 URL 里，证据全树都查不到原串', async () => {
  const root = evidenceRoot()
  try {
    const seen = []
    const deps = {
      ...makeEnv({
        commandTable: (command) => {
          if (command.includes('--dump-config')) return { status: 1, stdout: '', stderr: `组装失败：http://127.0.0.1:3080/?token=${FAKE_TOKEN}`, ms: 1, timedOut: false }
          return okResult()
        },
      }).deps,
      createEvidenceRun: (options) => createEvidenceRun({ ...options, root, runId: 'redaction-fixture' }),
      log: () => {},
    }
    const real = makeEnv()
    deps.preflight = real.deps.preflight
    const result = await runDevVerify(baseOptions({ evidenceRoot: root }), deps)
    assert.equal(result.exitCode, EXIT.FAILED, 'dump-config 失败要如实失败')

    const evidenceDir = join(root, 'redaction-fixture')
    const all = readAllText(evidenceDir)
    assert.ok(all.length > 0, '证据包必须真的写了东西')
    assert.equal(all.includes(FAKE_TOKEN), false, `token 原串绝不能出现在证据里：${all.slice(0, 400)}`)
    assert.ok(all.includes('***'), '脱敏后应当能看到 *** 占位')
    assert.ok(readFileSync(join(evidenceDir, 'summary.md'), 'utf8').includes('脱敏'))
    seen.push(evidenceDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('AX-V08：redact 兜住的几种形态（裸值 / token= / JSON / Bearer / --token）', () => {
  const secret = 'ZY9secretTokenValue'
  const text = [
    `裸值：${secret}`,
    'URL：http://127.0.0.1:3080/?token=abcdef123456',
    'JSON：{"token":"anotherSecret123"}',
    'Authorization: Bearer bearerSecret12345',
    'CLI：--token cliSecret123456',
  ].join('\n')
  const safe = redact(text, [secret])
  assert.equal(safe.includes(secret), false)
  assert.equal(safe.includes('abcdef123456'), false)
  assert.equal(safe.includes('anotherSecret123'), false)
  assert.equal(safe.includes('bearerSecret12345'), false)
  assert.equal(safe.includes('cliSecret123456'), false)
  assert.equal(safe.includes('***'), true)
  // 太短的"秘密"不参与替换（避免把普通词替换掉）
  assert.equal(redact('token=abc', ['abc']), 'token=abc')
})

test('AX-V08：证据目录形状（runId 命名 + summary.json/md + 相对路径记录）', () => {
  const root = evidenceRoot()
  try {
    const run = createEvidenceRun({ root, runId: 'shape-fixture' })
    assert.equal(EVIDENCE_ROOT, 'test-results/workbench-verify', '默认证据根目录（gitignored）')
    assert.equal(run.relDir.endsWith('/shape-fixture'), true)
    assert.equal(run.relDir.includes(root.replace(/\\/g, '/')), true, '证据相对路径必须能追溯到本次目录')
    run.addSecret(FAKE_TOKEN)
    run.writeText('stdout.log', `?token=${FAKE_TOKEN}`)
    run.finalize({ runId: 'shape-fixture', verdict: 'pass', exitCode: 0, stages: [], suites: [], blockers: [], warnings: [], sideEffects: {}, target: {}, buildIdentity: {} })
    const summary = JSON.parse(readFileSync(join(root, 'shape-fixture', 'summary.json'), 'utf8'))
    assert.equal(summary.redaction.secretsRegistered, 1)
    assert.equal(summary.redaction.applied, true)
    assert.ok(summary.evidence.files.includes('summary.json'))
    assert.ok(summary.evidence.files.includes('stdout.log'))
    assert.equal(readFileSync(join(root, 'shape-fixture', 'stdout.log'), 'utf8').includes(FAKE_TOKEN), false)
    assert.match(makeRunId(new Date('2026-10-01T12:00:00Z'), () => 0.5), /^20261001-\d{6}-[0-9a-f]{6}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 小结：真正的实跑交给 T6 ─────────────────────────────────────────────────

/**
 * AX-V07 / AX-V08 的补充判据（T6 实测踩到后加的）：
 *
 * `dsh web` 起起来时会**截断**日志文件，所以"从启动前 offset 往后读"会拿到**上一次启动**的 token。
 * 症状极具欺骗性：health 阶段用 `Bearer` 打 API 照样 200（loopback 本来就通），
 * 只有浏览器判据红，而红的是"侧栏没有工作台入口"（其实是认证页）。
 * 判据因此改成：**取整份日志里最后一个 token**，并且**真的用它认证一次**。
 */
test('AX-V07：token 取日志里最后一个（不是按 offset 的第一段），且必须真的认证通过', async () => {
  const { extractLatestToken, extractToken, verifyTokenWorks } = await import('../scripts/verify/runtime.mjs')
  const log = [
    'dsh web: http://127.0.0.1:3080/?token=OLDTOKEN123456',
    '[dsh-cost-meter] 已加载',
    'dsh web: http://127.0.0.1:3080/?token=NEWTOKEN789012',
  ].join('\n')
  assert.equal(extractToken(log), 'OLDTOKEN123456', 'extractToken 仍是"第一个"（保留给单段文本用）')
  assert.equal(extractLatestToken(log), 'NEWTOKEN789012', '必须取最后一个：最新那次启动的 token')
  assert.equal(extractLatestToken('没有 token 的日志'), undefined)

  // 认证判据：401 / "authentication required" 一律不算通过
  const fakeFetch = (body, status) => async () => ({ status, text: async () => body })
  assert.equal((await verifyTokenWorks('http://127.0.0.1:3080', 'X', 100, fakeFetch('dsh web authentication required; reopen the URL printed by dsh web.', 401))).ok, false)
  assert.equal((await verifyTokenWorks('http://127.0.0.1:3080', 'X', 100, fakeFetch('<html>app</html>', 303))).ok, true, '303 跳转 = 认证成功')
})

/**
 * 本机真实状态的一致性判据（T6 改过一次口径，**不是放宽**）。
 *
 * 原来的写法把"**当时**这台机器的状态"当成了判据：断言 web profile 里没有独立 DB 配置、
 * 于是预检必须拒绝。T6 给 web profile 配了独立测试库之后，那条断言变成**必然假红** ——
 * 它测的是机器状态，不是代码行为（"把环境当 fixture"是这类测试的通病）。
 *
 * 现在的口径：预检结论必须与**读到的实际配置**一致。
 * - 目标 profile 真的声明了独立 dbPath/dataDir → 必须通过（隔离成立就该放行）；
 * - 没声明 → 必须拒绝（fail-closed）。
 * 两侧都真实读配置，所以无论环境怎么变都成立，而且它仍然会在"fail-closed 被拆掉"时变红。
 */
test('本机真实状态：预检结论必须与目标 profile 的实际 DB 配置一致（声明了隔离就放行、没声明就拒绝）', async () => {
  const { preflight, readActualConfig } = await import('../scripts/verify/safety.mjs')
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '/'
  const profileDir = join(home, '.dsh', 'profiles', 'web')
  const dbPath = join(home, '.dsh', 'workbench', 'verify-web.db')
  if (process.env.DSH_WEB_URL === undefined) {
    const verdict = preflight({ url: 'http://127.0.0.1:3080', profile: 'web', profileDir, dbPath, env: process.env })
    assert.equal(verdict.ok, false, '没有 DSH_WEB_URL 时无法自锁，必须 fail-closed')
    return
  }
  const actual = readActualConfig({ profileDir, dshHome: process.env.DSH_HOME ?? join(home, '.dsh') })
  const declaresDb = typeof actual.values?.dbPath === 'string' || typeof actual.values?.dataDir === 'string'
  const verdict = preflight({ url: 'http://127.0.0.1:3080', profile: 'web', profileDir, dbPath, env: process.env })
  if (declaresDb) {
    assert.equal(verdict.ok, true, `目标 profile 已声明独立 DB（${JSON.stringify(actual.values)}），预检不该拒绝：${JSON.stringify(verdict.errors.map((entry) => entry.code))}`)
  } else {
    assert.equal(verdict.ok, false, '目标 profile 没有独立 DB 配置时必须拒绝（fail-closed）')
    assert.ok(verdict.errors.some((entry) => ['DB_NOT_DECLARED', 'SAME_PORT', 'DB_UNKNOWN', 'DB_PATH_MISMATCH'].includes(entry.code)), `实际理由：${JSON.stringify(verdict.errors.map((entry) => entry.code))}`)
  }
})
