/**
 * AX-V03 / V04 / V05 与 AX-G03：自锁与安装目标校验。
 *
 * 判据来源：requirements.md §7.1（环境与授权）、acceptance.md AX-V03–V05 / AX-G03、plan.md V03。
 *
 * 这一组全部是**负向**判据 —— 正常路径只有一条，拒绝路径有一堆：
 *
 * | 拒绝理由 | 为什么必须拒绝 |
 * |---|---|
 * | 同端口 | 目标就是当前会话所在实例，装盘/重启会掐断自己 |
 * | 同 profile **物理目录**（含链接指过去） | 同上，换个端口也还是同一个实例 |
 * | 同**数据库物理文件** | 默认 DB 跨 profile 共用；写进去就是写用户的正式库 |
 * | 目标没显式配置独立 DB | "换端口/换 profile 名"根本不构成隔离证据 |
 * | `--db-path` 与实际配置不一致 | 参数是声明，不是证据 |
 * | 实际配置读不完整/多层冲突 | 证明不了独立 → fail-closed |
 * | 环境事实缺失/非法 | 拿不到 DSH_WEB_URL 就没法证明"目标不是当前实例" |
 * | 继承来的 desktop `DSH_PROFILE_DIR` | dev-install 会把它当成 web 的目标 |
 * | 非 3080/web | 超出预授权范围，`--force` 不能扩权 |
 *
 * 并且：**拒绝时安装/kill/DB 写次数必须是 0**（AX-V03/V05 的硬要求）。
 * 本文件里 preflight 被注入了 spawn/kill/writeDb/writeFile 探针，跑完必须全是 0；
 * 另有源码级断言：safety.mjs 不许 import child_process、不许出现写文件的调用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUTHORIZED_PORT,
  OVERRIDDEN_ENV,
  SCRUBBED_ENV,
  STAGE_PLAN,
  findPluginEntries,
  isLoopbackHost,
  normalizePath,
  parseHttpUrl,
  preflight,
  resolveDbPathConfig,
} from '../scripts/verify/safety.mjs'
import { buildPortOwnerScript, findPortOwner, isTargetDshProcess, resolveDshCommand } from '../scripts/verify/runtime.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const ROOTFS = process.platform === 'win32' ? 'C:\\' : '/'
const DSH_HOME = join(ROOTFS, 'home', 'tester', '.dsh')
const CURRENT_DIR = join(DSH_HOME, 'profiles', 'desktop')
const TARGET_DIR = join(DSH_HOME, 'profiles', 'web')
const OTHER_WEB_DIR = join(DSH_HOME, 'profiles', 'web-staging')
const VERIFY_DB = join(DSH_HOME, 'workbench', 'verify-web.db')
const SHARED_DB = join(DSH_HOME, 'workbench', 'workbench.db')

const pathKey = (path) => (process.platform === 'win32' ? String(path).toLowerCase() : String(path))

/** 组装一个全注入的预检环境：零真实 FS 访问 + 副作用探针全为 0。 */
function harness({ configs = {}, existing = [TARGET_DIR, CURRENT_DIR], realpathMap = {} } = {}) {
  const existsSet = new Set(existing.map(pathKey))
  const realpaths = new Map(Object.entries(realpathMap).map(([key, value]) => [pathKey(key), value]))
  const effects = { spawned: 0, killed: 0, dbWrites: 0, filesWritten: 0 }
  const deps = {
    platform: process.platform,
    existsSync: (path) => existsSet.has(pathKey(path)),
    realpath: (path) => realpaths.get(pathKey(path)) ?? path,
    statSync: () => ({ isDirectory: () => true }),
    spawn: () => { effects.spawned += 1 },
    kill: () => { effects.killed += 1 },
    writeDb: () => { effects.dbWrites += 1 },
    writeFileSync: () => { effects.filesWritten += 1 },
    readActualConfig: ({ profileDir }) => {
      const entry = configs[pathKey(profileDir)]
      if (entry === undefined) return { ok: true, values: {}, sources: [], conflicts: [], unparsable: [] }
      return {
        ok: (entry.unparsable ?? []).length === 0 && (entry.conflicts ?? []).length === 0,
        values: entry.values ?? {},
        sources: entry.sources ?? [],
        conflicts: entry.conflicts ?? [],
        unparsable: entry.unparsable ?? [],
      }
    },
  }
  return { deps, effects }
}

const baseEnv = () => ({
  DSH_WEB_URL: 'http://127.0.0.1:19387',
  DSH_PROFILE: 'desktop',
  DSH_PROFILE_DIR: CURRENT_DIR,
  DSH_HOME,
})

const baseInput = (overrides = {}) => ({
  url: `http://127.0.0.1:${AUTHORIZED_PORT}`,
  profile: 'web',
  profileDir: TARGET_DIR,
  dbPath: VERIFY_DB,
  env: baseEnv(),
  ...overrides,
})

const codes = (verdict, severity = 'error') => verdict.reasons.filter((entry) => entry.severity === severity).map((entry) => entry.code)

function isolatedHarness(overrides = {}) {
  return harness({
    configs: {
      [pathKey(TARGET_DIR)]: { values: { dbPath: VERIFY_DB } },
      [pathKey(CURRENT_DIR)]: { values: {} },
      ...(overrides.configs ?? {}),
    },
    ...overrides,
  })
}

test('AX-V05：正常路径（目标独立 DB + 不同端口/profile 名 + 目录不同）通过，且副作用全 0', () => {
  const { deps, effects } = isolatedHarness()
  const verdict = preflight(baseInput(), deps)
  assert.equal(verdict.ok, true, `不该拒绝：${JSON.stringify(verdict.reasons)}`)
  assert.equal(verdict.exitCode, 0)
  assert.deepEqual(effects, { spawned: 0, killed: 0, dbWrites: 0, filesWritten: 0 }, '预检不许有任何副作用')
  assert.equal(verdict.facts.target.dbPath.toLowerCase().includes('verify-web.db'), true)
  assert.equal(verdict.facts.current.dbPath.toLowerCase().includes('workbench.db'), true)
  assert.notEqual(verdict.facts.target.dbPath, verdict.facts.current.dbPath)
  assert.deepEqual(Object.keys(verdict.plan.childEnv).sort(), ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'WORKBENCH_EXPECTED_DB_PATH', 'WORKBENCH_PROFILE_DIR'])
  assert.equal(verdict.plan.stages.length, STAGE_PLAN.length)
  assert.equal(verdict.plan.stages[0].name, 'preflight')
  assert.equal(verdict.plan.stages[0].readonly, true)
  assert.deepEqual(verdict.plan.overrideEnv, OVERRIDDEN_ENV)
  assert.deepEqual(verdict.plan.scrubEnv, SCRUBBED_ENV)
})

test('AX-V03：目标端口 == 当前 DSH_WEB_URL 端口 → 拒绝，且 --force 绕不过', () => {
  const { deps } = isolatedHarness()
  const env = { ...baseEnv(), DSH_WEB_URL: `http://127.0.0.1:${AUTHORIZED_PORT}` }
  for (const force of [false, true]) {
    const verdict = preflight(baseInput({ env, force }), deps)
    assert.equal(verdict.ok, false, `--force=${force} 时同端口必须仍然拒绝`)
    assert.ok(codes(verdict).includes('SAME_PORT'))
    assert.equal(verdict.exitCode, 2)
  }
  assert.equal(codes(preflight(baseInput({ env, force: true }), deps)).includes('SAME_PORT'), true)
})

test('AX-V03：DSH_WEB_URL 缺失/非法/非本机 → 拒绝（拿不到环境事实就没法自锁）', () => {
  const { deps } = isolatedHarness()
  for (const bad of [undefined, '', 'ftp://127.0.0.1:19387', 'http://10.0.0.5:19387', '不是URL']) {
    const env = { ...baseEnv(), DSH_WEB_URL: bad }
    const verdict = preflight(baseInput({ env }), deps)
    assert.equal(verdict.ok, false, `DSH_WEB_URL=${String(bad)} 必须拒绝`)
    assert.ok(codes(verdict).includes('ENV_URL_INVALID'), `期望 ENV_URL_INVALID，实际 ${codes(verdict)}`)
  }
  const missingProfile = preflight(baseInput({ env: { ...baseEnv(), DSH_PROFILE: undefined } }), deps)
  assert.ok(codes(missingProfile).includes('ENV_MISSING'))
  const missingDir = preflight(baseInput({ env: { ...baseEnv(), DSH_PROFILE_DIR: undefined } }), deps)
  assert.ok(codes(missingDir).includes('ENV_MISSING'))
})

test('AX-V03：非 3080/web 目标拒绝，--force 不能扩权', () => {
  const { deps } = isolatedHarness()
  const outOfPort = preflight(baseInput({ url: 'http://127.0.0.1:3999', force: true }), deps)
  assert.equal(outOfPort.ok, false)
  assert.ok(codes(outOfPort).includes('TARGET_OUT_OF_SCOPE'))
  const outOfProfile = preflight(baseInput({ profile: 'desktop', force: true }), deps)
  assert.equal(outOfProfile.ok, false)
  assert.ok(codes(outOfProfile).includes('TARGET_OUT_OF_SCOPE'))
  const remote = preflight(baseInput({ url: 'http://192.168.1.9:3080' }), deps)
  assert.ok(codes(remote).includes('TARGET_NOT_LOOPBACK'))
})

test('AX-V04：不同端口但 profile 是同一个物理目录（链接指过去）→ 拒绝', () => {
  const link = join(ROOTFS, 'links', 'web-via-desktop')
  const { deps } = isolatedHarness({ existing: [TARGET_DIR, CURRENT_DIR, link], realpathMap: { [link]: CURRENT_DIR } })
  const verdict = preflight(baseInput({ profileDir: link }), deps)
  assert.equal(verdict.ok, false)
  assert.ok(codes(verdict).includes('SAME_PROFILE_DIR'), `期望 SAME_PROFILE_DIR，实际 ${codes(verdict)}`)
})

test('AX-V05：目标 DB 与当前是同一个物理文件 → 拒绝（--force 也绕不过）', () => {
  const { deps } = harness({
    configs: {
      [pathKey(TARGET_DIR)]: { values: { dataDir: join(DSH_HOME, 'workbench') } },
      [pathKey(CURRENT_DIR)]: { values: {} },
    },
  })
  const verdict = preflight(baseInput({ dbPath: SHARED_DB, force: true }), deps)
  assert.equal(verdict.ok, false)
  assert.ok(codes(verdict).includes('SAME_DB'), `期望 SAME_DB，实际 ${codes(verdict)}`)
})

test('AX-V05：目标没有显式独立 DB 配置 → 拒绝，并点名"它会用默认共享库"', () => {
  const { deps } = harness({ configs: { [pathKey(TARGET_DIR)]: { values: {} }, [pathKey(CURRENT_DIR)]: { values: {} } } })
  const verdict = preflight(baseInput(), deps)
  assert.equal(verdict.ok, false)
  assert.ok(codes(verdict).includes('DB_NOT_DECLARED'))
  const message = verdict.errors.find((entry) => entry.code === 'DB_NOT_DECLARED').message
  assert.ok(message.includes('workbench.db'), '必须说清它会落到哪个共享库')
  assert.ok(message.includes('换端口/换 profile 名都不能证明 DB 隔离'))
})

test('AX-V05：仅 --db-path 声明不能冒充隔离（必须与目标实际配置指向同一个文件）', () => {
  const { deps } = harness({ configs: {
    [pathKey(TARGET_DIR)]: { values: { dbPath: join(DSH_HOME, 'workbench', 'other.db') } },
    [pathKey(CURRENT_DIR)]: { values: {} },
  } })
  const verdict = preflight(baseInput({ dbPath: VERIFY_DB }), deps)
  assert.equal(verdict.ok, false)
  assert.ok(codes(verdict).includes('DB_PATH_MISMATCH'))
  const ok = preflight(baseInput({ dbPath: join(DSH_HOME, 'workbench', 'other.db') }), deps)
  assert.equal(ok.ok, true, `实际配置与 --db-path 一致时应通过：${JSON.stringify(ok.reasons)}`)
})

test('AX-V05：目标/当前实际配置读不完整、多层冲突、缺 --db-path → 全部 fail-closed', () => {
  const unparsable = preflight(baseInput(), harness({ configs: {
    [pathKey(TARGET_DIR)]: { values: {}, unparsable: [{ file: 'x.yml', reason: 'config 里有不可静态判定的键：dbPath' }] },
    [pathKey(CURRENT_DIR)]: { values: {} },
  } }).deps)
  assert.ok(codes(unparsable).includes('DB_UNKNOWN'))

  const currentUnparsable = preflight(baseInput(), harness({ configs: {
    [pathKey(TARGET_DIR)]: { values: { dbPath: VERIFY_DB } },
    [pathKey(CURRENT_DIR)]: { values: {}, unparsable: [{ file: 'desktop.yml', reason: '读不了' }] },
  } }).deps)
  assert.ok(codes(currentUnparsable).includes('DB_UNKNOWN'), '当前实例的库也算不出来时不许声称"不同"')

  const conflict = preflight(baseInput(), harness({ configs: {
    [pathKey(TARGET_DIR)]: { values: { dbPath: VERIFY_DB }, conflicts: [{ key: 'dbPath', values: ['a', 'b'] }] },
    [pathKey(CURRENT_DIR)]: { values: {} },
  } }).deps)
  assert.ok(codes(conflict).includes('DB_CONFLICT'))

  const noDbPath = preflight(baseInput({ dbPath: undefined }), isolatedHarness().deps)
  assert.ok(codes(noDbPath).includes('DB_PATH_REQUIRED'))
})

test('AX-V04：继承 desktop 的 DSH_PROFILE_DIR 不许传给 web 安装（子进程环境必须被重设）', () => {
  const { deps } = isolatedHarness()
  const verdict = preflight(baseInput(), deps)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.plan.childEnv.DSH_PROFILE, 'web')
  assert.equal(verdict.plan.childEnv.DSH_PROFILE_DIR, TARGET_DIR)
  assert.equal(verdict.plan.childEnv.WORKBENCH_PROFILE_DIR, TARGET_DIR)
  assert.notEqual(verdict.plan.childEnv.DSH_PROFILE_DIR, CURRENT_DIR.replace(/desktop$/, 'desktop'))
  assert.equal(verdict.plan.childEnv.DSH_PROFILE_DIR, TARGET_DIR, '必须显式指向目标，而不是继承来的 desktop 目录')
  assert.ok(verdict.warnings.some((entry) => entry.code === 'INHERITED_PROFILE_DIR'), '继承污染必须被如实警告并说明会被重设')
  assert.deepEqual(verdict.plan.overrideEnv, ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'WORKBENCH_PROFILE_DIR'])

  const mismatch = preflight(baseInput({ env: { ...baseEnv(), WORKBENCH_PROFILE_DIR: CURRENT_DIR } }), deps)
  assert.equal(mismatch.ok, false)
  assert.ok(codes(mismatch).includes('WORKBENCH_PROFILE_DIR_MISMATCH'))

  const aligned = preflight(baseInput({ env: { ...baseEnv(), WORKBENCH_PROFILE_DIR: TARGET_DIR } }), deps)
  assert.equal(aligned.ok, true, `一致时不该报错：${JSON.stringify(aligned.reasons)}`)
})

test('AX-V04/AX-G03：profile 名相同但目录不同 → 无 --force 拒绝；带 --force 通过但必须写明原因', () => {
  const { deps } = harness({
    existing: [TARGET_DIR, OTHER_WEB_DIR],
    configs: {
      [pathKey(TARGET_DIR)]: { values: { dbPath: VERIFY_DB } },
      [pathKey(OTHER_WEB_DIR)]: { values: {} },
    },
  })
  const env = { ...baseEnv(), DSH_PROFILE: 'web', DSH_PROFILE_DIR: OTHER_WEB_DIR }
  const denied = preflight(baseInput({ env }), deps)
  assert.equal(denied.ok, false)
  assert.ok(codes(denied).includes('PROFILE_NAME_COLLISION'))
  assert.equal(denied.errors.find((entry) => entry.code === 'PROFILE_NAME_COLLISION').bypassable, true)

  const forced = preflight(baseInput({ env, force: true }), deps)
  assert.equal(forced.ok, true)
  const warning = forced.warnings.find((entry) => entry.code === 'PROFILE_NAME_COLLISION')
  assert.ok(warning !== undefined, '被 --force 绕过的原因必须留在报告里')
  assert.equal(warning.bypassedBy, 'force')
  assert.ok(warning.message.includes('--force'))
})

test('AX-V03/V05：preflight 全程零副作用（探针 0 / 源码里连 child_process 都不 import）', () => {
  const { deps, effects } = isolatedHarness()
  preflight(baseInput(), deps)
  preflight(baseInput({ force: true, url: 'http://127.0.0.1:3080', env: { ...baseEnv(), DSH_WEB_URL: 'http://127.0.0.1:3080' } }), deps)
  preflight(baseInput({ profileDir: undefined, dbPath: undefined }), deps)
  assert.deepEqual(effects, { spawned: 0, killed: 0, dbWrites: 0, filesWritten: 0 })

  const source = readFileSync(join(REPO, 'scripts', 'verify', 'safety.mjs'), 'utf8')
  assert.equal(source.includes('child_process'), false, '预检模块不许有执行子进程的能力')
  assert.equal(/writeFileSync|rmSync|unlinkSync|execFileSync|spawnSync/.test(source), false, '预检模块不许写文件/删文件')
})

test('V03 解析：patch 里嵌套 insert / profile patch 的 config 都能被读出来；不可静态判定时报 unparsable', () => {
  const bundle = [
    '# bundle layer',
    '- insert:',
    '    - id: personal-workbench',
    "      name: '@dely0/dsh-personal-workbench'",
    '      config: {}',
    '- id: something-else',
    '  config:',
    '    dbPath: /should/not/be/read',
  ].join('\n')
  const parsed = findPluginEntries(bundle)
  assert.equal(parsed.entries.length, 1)
  assert.deepEqual(parsed.entries[0].config, {})
  assert.deepEqual(parsed.unparsable, [])

  const profile = [
    '- id: dsh-pocket',
    '  config:',
    '    port: 3082',
    '- id: personal-workbench',
    "  name: '@dely0/dsh-personal-workbench'",
    '  config:',
    '    dbPath: "C:/tmp/verify/web.db"',
    '    dataDir: C:/tmp/verify',
  ].join('\n')
  const profiled = findPluginEntries(profile)
  assert.equal(profiled.entries.length, 1)
  assert.deepEqual(profiled.entries[0].config, { dbPath: 'C:/tmp/verify/web.db', dataDir: 'C:/tmp/verify' })

  const dynamic = findPluginEntries(['- id: personal-workbench', '  config:', '    dbPath: !!js process.env.WB_DB'].join('\n'))
  assert.equal(dynamic.entries[0].unknownKeys.includes('dbPath'), true, '表达式算不出实际值时必须标记为不可静态判定')
  assert.equal(dynamic.entries[0].config.dbPath, undefined)
})

test('V03 解析：DB 路径语义与 openWorkbenchDb 一致（dbPath 优先于 dataDir，都没有就落默认共享库）', () => {
  assert.equal(resolveDbPathConfig({ dbPath: join(ROOTFS, 'x', 'a.db'), dataDir: join(ROOTFS, 'y') }, { home: DSH_HOME }), join(ROOTFS, 'x', 'a.db'))
  assert.equal(resolveDbPathConfig({ dataDir: join(ROOTFS, 'y') }, { home: DSH_HOME }), join(ROOTFS, 'y', 'workbench.db'))
  assert.equal(resolveDbPathConfig({}, { home: DSH_HOME }), join(DSH_HOME, 'workbench', 'workbench.db'))
  assert.equal(parseHttpUrl('http://127.0.0.1:3080/').port, 3080)
  assert.equal(parseHttpUrl('https://localhost/').port, 443)
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('192.168.1.1'), false)
  assert.equal(normalizePath(join(ROOTFS, 'A', 'b')) === normalizePath(join(ROOTFS, 'a', 'B')), process.platform === 'win32')
})

test('AX-V04：dev-install 真的拒绝继承 desktop 目录（真子进程，零副作用：--print-target 不做构建/装盘）', () => {  const script = join(REPO, 'scripts', 'dev-install.mjs')
  const run = (args, env) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, cwd: REPO }) }
    } catch (error) {
      return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
    }
  }
  const clean = { DSH_PROFILE: undefined, DSH_PROFILE_DIR: undefined, WORKBENCH_PROFILE_DIR: undefined }

  const plain = run(['--print-target', '--profile', 'web'], clean)
  assert.equal(plain.status, 0)
  assert.equal(JSON.parse(plain.stdout).profileDirSource.startsWith('默认'), true)

  const polluted = run(['--print-target', '--profile', 'web'], { ...clean, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: CURRENT_DIR })
  assert.notEqual(polluted.status, 0, '继承 desktop 目录去装 web 必须被拒绝')
  assert.match(polluted.stderr, /拒绝继承 profile 目录/)
  assert.match(polluted.stderr, /--profile-dir/)

  const explicit = run(['--print-target', '--profile', 'web', '--profile-dir', TARGET_DIR], { ...clean, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: CURRENT_DIR })
  assert.equal(explicit.status, 0)
  const parsed = JSON.parse(explicit.stdout)
  assert.equal(parsed.profileDir.toLowerCase(), TARGET_DIR.toLowerCase())
  assert.equal(parsed.profileDirSource.includes('--profile-dir'), true)

  const sameProfileInherited = run(['--print-target', '--profile', 'web'], { ...clean, DSH_PROFILE: 'web', DSH_PROFILE_DIR: TARGET_DIR })
  assert.equal(sameProfileInherited.status, 0)
  assert.equal(JSON.parse(sameProfileInherited.stdout).profileDir.toLowerCase(), TARGET_DIR.toLowerCase())
})

test('AX-V03：端口归属判据只认"目标那个 dsh web 实例"（杀进程前的最后一关，纯函数全表驱动）', () => {
  const owner = (name, commandLine) => ({ pid: 1234, name, commandLine })
  /**
   * 命令行的真实形态（2026-10-01 本机实测）：
   * `"node" "C:\Users\...\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" web --port 3080 --no-open`
   * —— `dsh` 出现在包路径里，不在可执行名里，所以判据必须看**整个命令行**。
   */
  const BIN = '"C:\\Users\\x\\AppData\\Roaming\\npm\\\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"'
  const cases = [
    ['端口没有监听进程', undefined, false],
    ['端口被别的程序占了', owner('chrome.exe', 'chrome.exe --remote-debugging-port=3080'), false],
    ['node 但不是 dsh', owner('node.exe', 'node C:\\other\\server.js --port 3080'), false],
    ['别的 dsh 无关服务（有 web 但整条命令行里没有 dsh）', owner('node.exe', 'node C:\\apps\\web-server\\bin.js web --port 3080'), false],
    ['是 dsh 但不是 web 子命令', owner('node.exe', `node ${BIN} desktop --port 3080`), false],
    ['dsh web 但端口对不上', owner('node.exe', `node ${BIN} web --port 3081`), false],
    ['dsh web --port 3080（空格式）', owner('node.exe', `node ${BIN} web --port 3080 --no-open`), true],
    ['dsh web --port=3080（等号式）', owner('node.exe', `node ${BIN} web --port=3080`), true],
    ['命令行显式指定了别的 profile', owner('node.exe', `node ${BIN} web --port 3080 --profile desktop`), false],
    ['命令行没写 profile（由 DSH_PROFILE 环境变量决定，允许）', owner('node.exe', `node ${BIN} web --port 3080`), true],
  ]
  for (const [label, candidate, expected] of cases) {
    const verdict = isTargetDshProcess(candidate, { port: 3080, profile: 'web' })
    assert.equal(verdict.ok === true, expected, `${label}：${JSON.stringify(verdict)}`)
    if (!expected) assert.equal(typeof verdict.reason, 'string', `${label} 必须给出可读原因`)
  }
})

test('AX-V03：非 Windows 平台拒绝做端口归属校验（不猜着杀进程）', () => {
  const verdict = findPortOwner(3080, { platform: 'linux', runCommandSync: () => ({ status: 0, stdout: '', stderr: '' }) })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /只支持 Windows/)
})

/**
 * AX-V03：dsh 命令发现。
 *
 * 2026-10-01（T6 第一次真跑）改过行为，判据跟着改，**不是**放宽：
 * 1. 原来"什么都没配就退回 PATH 上的 `dsh`"—— 实测那条路会走 `dsh.cmd`（多一层 cmd.exe），
 *    **stdout 落不进日志文件**，token 阶段必然 60s 超时；而且 PATH 上的 dsh 未必是目标实例的那个。
 *    现在改成：显式覆盖 / 找到 npm 全局的 `bin.js`（直接 `node bin.js`）/ **明确失败**。
 * 2. 返回值从"字符串命令"变成带 `kind` 的对象 —— 编排要按 kind 决定怎么 spawn（shell vs 直接 node）。
 */
test('AX-V03：dsh 命令发现（覆盖优先 → npm 全局 bin.js → 明确失败，不猜 PATH）', () => {
  const withOverride = resolveDshCommand({ DSH_VERIFY_DSH_CMD: 'C:/tools/dsh.cmd' })
  assert.equal(withOverride.kind, 'override')
  assert.equal(withOverride.command, 'C:/tools/dsh.cmd')

  const nothing = resolveDshCommand({})
  assert.equal(nothing.kind, 'missing', '找不到 bin.js 时必须明确失败（不许悄悄用 PATH 上的 dsh）')
  assert.match(nothing.reason, /bin\.js|DSH_VERIFY_DSH_CMD/)

  const withAppData = resolveDshCommand({ APPDATA: join(REPO, 'test', 'fixtures') })
  assert.ok(['node', 'missing'].includes(withAppData.kind), `APPDATA 指向不存在的位置时应为 missing，实际 ${withAppData.kind}`)
})

test('AX-V03：端口归属脚本走 .ps1 文件（不内联转义，ConvertTo-Json 输出必须能被 JSON.parse）', () => {
  const script = buildPortOwnerScript(3080)
  assert.match(script, /Get-NetTCPConnection/)
  assert.match(script, /ConvertTo-Json/)
  assert.equal(/-Compress/.test(script), false, '不许用 -Compress：它输出的 {none:true} 不是合法 JSON（本次实测踩到）')
  assert.match(script, /\{"none":true\}/, '查不到时必须输出**合法** JSON 的空结果')
})
