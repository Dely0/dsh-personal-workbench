/**
 * 研发验收链的**安全预检**（plan.md V03 / AX-V03–V05 / AX-G03）。
 *
 * ## 这个模块存在的唯一理由
 *
 * 验收链会**装盘 + 重启一个真实 DSH 实例**。装错目标、重启错实例、写到用户正式库上，
 * 任何一条都是"把用户的会话/数据弄坏"。所以判据必须是 **fail-closed**：
 * 证明不了"目标是隔离的"就拒绝，而不是"看情况继续"。
 *
 * ## 五条硬规则（每一条都有负向测试，且 `--force` 不能绕）
 *
 * 1. **同端口拒绝**：目标端口 == `DSH_WEB_URL` 的端口 → 目标就是当前会话所在实例。
 * 2. **同 profile 物理目录拒绝**：realpath 相等（含链接/junction 指过去）→ 同一个实例。
 * 3. **同数据库物理文件拒绝**：默认 DB 是 `~/.dsh/workbench/workbench.db`，**不随 profile 区分**
 *    —— 换端口/换 profile 名根本不能证明 DB 隔离。必须读目标的**实际配置**，
 *    证明它显式指向了另一个 dbPath/dataDir，并且与 `--db-path` 声明一致。
 *    `--db-path` 只是"声明并核对"，**不是**隔离证据（拿参数当证据正是要防的假绿）。
 * 4. **环境事实缺失/非法拒绝**：`DSH_WEB_URL`/`DSH_PROFILE`/`DSH_PROFILE_DIR` 拿不到就没法自锁。
 * 5. **授权范围拒绝**：预授权只限 `3080 / web`（ADR0006），非此范围一律拒绝，`--force` 不能扩权。
 *
 * `--force` **只**能绕一条：profile **名字**相同但目录/实例/DB 确实不同（ADR0006 的措辞），
 * 且被绕时必须在报告里写明原因。
 *
 * ## 只读
 *
 * 本模块不做任何副作用：不 spawn、不 kill、不写文件、不碰 DB（源码里连子进程模块都不 import）。
 *
 * 子进程环境由 `planChildEnv()` 描述，交给调用方设置。
 */
import { existsSync as defaultExistsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 预授权范围（ADR0006）：只有测试实例 3080 / web 能被这条链重启。 */
export const AUTHORIZED_PORT = 3080
export const AUTHORIZED_PROFILE = 'web'
export const PLUGIN_ID = 'personal-workbench'
export const PLUGIN_NAME = '@dely0/dsh-personal-workbench'

/** 阶段顺序（`--dry-run` 打印它；链按它执行，任一步失败就停）。 */
export const STAGE_PLAN = [
  { name: 'preflight', readonly: true, detail: '自锁/环境/DB 独立预检（本阶段不产生任何副作用）' },
  { name: 'version-before', readonly: false, detail: '装盘前版本一致性门禁（必须 0）' },
  { name: 'build', readonly: false, detail: 'pnpm build（生成 lib/ 与 lib/build-info.json）' },
  { name: 'install', readonly: false, detail: 'dev-install --apply：打包装盘（备份 + 只改本插件一处依赖）' },
  { name: 'profile-diff', readonly: true, detail: '零增量 diff：除本插件外其余依赖与装盘版本一个都不许变' },
  { name: 'dump-config', readonly: true, detail: '插件树能否组装（dsh --profile web --dump-config）' },
  { name: 'version-after', readonly: false, detail: '装盘后版本一致性门禁（必须 0）' },
  { name: 'restart', readonly: false, detail: '只重启目标实例（校验端口归属后 kill 归属进程，再以清洗过的环境启动）' },
  { name: 'health', readonly: true, detail: `HTTP health ≤120s（每次 ≤5s）：ok + version + schema + buildId 必须与本次包一致` },
  { name: 'token', readonly: true, detail: '从本次启动的日志抓 token（≤60s），只进内存，证据里脱敏' },
  { name: 'suites', readonly: false, detail: '跑白名单套件（单套 ≤180s；必需套件缺失/空计数/required skipped 都不算通过）' },
  { name: 'evidence', readonly: false, detail: '写证据包（test-results/workbench-verify/<runId>/）' },
  { name: 'cleanup-browser', readonly: false, detail: '只关本次起的浏览器与临时目录' },
]

/** 子进程必须被清掉/重设的环境变量（防 dev-install 继承当前 desktop 路径）。 */
export const OVERRIDDEN_ENV = ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'WORKBENCH_PROFILE_DIR']
export const SCRUBBED_ENV = ['WORKBENCH_DB_PATH', 'WORKBENCH_DATA_DIR', 'DSH_SESSION_ID']

export function parseHttpUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: '空值' }
  let url
  try { url = new URL(raw.trim()) } catch { return { ok: false, reason: `不是合法 URL：${raw}` } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `只接受 http/https，实际 ${url.protocol}` }
  const port = url.port !== '' ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, reason: `端口非法：${url.port}` }
  return { ok: true, href: url.href, protocol: url.protocol, hostname: url.hostname, port }
}

export function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** 跨平台路径归一（比较用）：resolve + Windows 小写；realpath 拿不到时退回 resolve。 */
export function normalizePath(path, deps = {}) {
  const realpath = deps.realpath ?? ((value) => realpathSync.native(value))
  const platform = deps.platform ?? process.platform
  let absolute
  try { absolute = realpath(path) } catch { absolute = resolve(path) }
  return platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function samePath(left, right, deps = {}) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return normalizePath(left, deps) === normalizePath(right, deps)
}

// ── 读「实际配置」────────────────────────────────────────────────────────────

const stripQuotes = (value) => {
  const trimmed = String(value).trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1)
  return trimmed
}

/** 值是不是"可静态判定"的标量；`!!js` / `$` / 对象/数组都算不可判定。 */
function scalarOrUndefined(value) {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  if (text.startsWith('!!js') || text.startsWith('$') || text.startsWith('{') || text.startsWith('[') || text.startsWith('&') || text.startsWith('*') || text.startsWith('|') || text.startsWith('>')) return undefined
  return stripQuotes(text)
}

/**
 * 从一个 cordis patch 文件里挑出**本插件**的条目，读出它的 `config.dbPath/dataDir`。
 *
 * 为什么手写而不是引 yaml：这条链要在**没有 node_modules 的机器**上跑（仓库里没有 yaml 依赖），
 * 而需要的信息只有两个标量键。读不懂的情形一律返回 `unparsable`，由调用方 fail-closed。
 *
 * 支持两种真实形态：
 * - profile patch：顶层数组 `- id: personal-workbench` + `config:`；
 * - 包自带 bundle patch：`- insert:` 下面嵌套 `- id: personal-workbench`。
 */
export function findPluginEntries(text, { ids = [PLUGIN_ID], names = [PLUGIN_NAME] } = {}) {
  const lines = String(text ?? '').split(/\r?\n/)
  const entries = []
  const unparsable = []
  const idRe = /^(\s*)-\s+id:\s*(.+?)\s*$/
  for (let index = 0; index < lines.length; index += 1) {
    const match = idRe.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    const block = [lines[index]]
    let cursor = index + 1
    while (cursor < lines.length) {
      const line = lines[cursor]
      if (line.trim() === '') { block.push(line); cursor += 1; continue }
      const lineIndent = line.length - line.trimStart().length
      if (lineIndent <= indent) break
      block.push(line)
      cursor += 1
    }
    index = cursor - 1

    let id = stripQuotes(idRe.exec(block[0])[2])
    let name
    let configRaw
    let configIndent
    let configInline
    for (let inner = 1; inner < block.length; inner += 1) {
      const line = block[inner]
      const keyMatch = /^(\s+)([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line)
      if (keyMatch === null) continue
      const key = keyMatch[2]
      const keyIndent = keyMatch[1].length
      if (key === 'id' && id === undefined) id = stripQuotes(keyMatch[3])
      else if (key === 'name' && name === undefined) name = stripQuotes(keyMatch[3])
      else if (key === 'config' && configRaw === undefined) {
        configRaw = keyMatch[3]
        configIndent = keyIndent
        configInline = stripQuotes(keyMatch[3])
      }
    }
    const wanted = (id !== undefined && ids.includes(id)) || (name !== undefined && names.includes(name))
    if (!wanted) continue

    const config = {}
    const unknownKeys = []
    if (configRaw !== undefined && configInline !== '' && configInline !== '{}') {
      unparsable.push({ id, name, reason: `config 行不可静态判定：${String(configRaw).trim()}` })
    } else if (configRaw !== undefined && configInline === '') {
      // 多行 mapping：取 config: 之下、缩进更深、且处于**最小缩进**的那些 key
      const childLines = []
      for (let inner = 1; inner < block.length; inner += 1) {
        const line = block[inner]
        if (line.trim() === '') continue
        const lineIndent = line.length - line.trimStart().length
        if (lineIndent > configIndent) childLines.push({ indent: lineIndent, text: line.trim() })
      }
      const minIndent = childLines.reduce((min, entry) => (entry.indent < min ? entry.indent : min), Number.POSITIVE_INFINITY)
      for (const entry of childLines) {
        if (entry.indent !== minIndent) continue
        const pair = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(entry.text)
        if (pair === null) { unparsable.push({ id, name, reason: `config 里有读不懂的行：${entry.text}` }); continue }
        const value = scalarOrUndefined(pair[2])
        if (value === undefined) unknownKeys.push(pair[1])
        else config[pair[1]] = value
      }
    }
    entries.push({ id, name, config, unknownKeys })
  }
  return { entries, unparsable }
}

/**
 * 读出某 profile 的**实际**工作台配置（各 patch 层逐个读，冲突就报冲突，不猜）。
 *
 * 层次（低 → 高）：装盘包自带 bundle patch < `$DSH_HOME/cordis.patch.yml` 全局 patch
 * < `<profileDir>/cordis.patch.yml` profile patch。
 */
export function readActualConfig({ profileDir, dshHome, deps = {} } = {}) {
  const exists = deps.existsSync ?? defaultExistsSync
  const read = deps.readFileSync ?? readFileSync
  const home = dshHome ?? join(homedir(), '.dsh')
  const sources = [
    { key: 'installed-bundle', file: join(profileDir, 'node_modules', ...PLUGIN_NAME.split('/'), 'cordis.patch.yml') },
    { key: 'global-patch', file: join(home, 'cordis.patch.yml') },
    { key: 'profile-patch', file: join(profileDir, 'cordis.patch.yml') },
  ]
  const values = {}
  const conflicts = []
  const unparsable = []
  const seen = []
  const declaredBy = {}
  for (const source of sources) {
    if (!exists(source.file)) { seen.push({ ...source, exists: false, found: false }); continue }
    let text
    try { text = String(read(source.file)) } catch (error) {
      unparsable.push({ file: source.file, reason: `读不了：${error instanceof Error ? error.message : String(error)}` })
      seen.push({ ...source, exists: true, found: false, error: 'read-failed' })
      continue
    }
    const found = findPluginEntries(text)
    for (const bad of found.unparsable) unparsable.push({ file: source.file, ...bad })
    const entry = found.entries[0]
    seen.push({ ...source, exists: true, found: entry !== undefined, config: entry?.config, unknownKeys: entry?.unknownKeys ?? [] })
    if (entry === undefined) continue
    if (entry.unknownKeys.length > 0) unparsable.push({ file: source.file, id: entry.id, reason: `config 里有不可静态判定的键：${entry.unknownKeys.join('、')}` })
    for (const key of ['dbPath', 'dataDir']) {
      if (entry.config[key] === undefined) continue
      if (values[key] !== undefined && values[key] !== entry.config[key]) conflicts.push({ key, values: [values[key], entry.config[key]], files: [declaredBy[key], source.file] })
      values[key] = entry.config[key]
      declaredBy[key] = source.file
    }
  }
  return { profileDir, home, values, sources: seen, conflicts, unparsable, ok: unparsable.length === 0 && conflicts.length === 0 }
}

/** 把 patch 里的 dbPath/dataDir 解析成**实际数据库文件路径**（与 openWorkbenchDb 同语义）。 */
export function resolveDbPathConfig(config = {}, { home = join(homedir(), '.dsh') } = {}) {
  const fallback = join(home, 'workbench', 'workbench.db')
  if (typeof config.dbPath === 'string' && config.dbPath.trim() !== '') return resolve(config.dbPath.trim())
  if (typeof config.dataDir === 'string' && config.dataDir.trim() !== '') return resolve(join(config.dataDir.trim(), 'workbench.db'))
  return resolve(fallback)
}

/** 子进程环境：显式固定目标 + 清掉会继承当前实例的键。 */
export function planChildEnv({ profile, profileDir, dbPath }) {
  return {
    DSH_PROFILE: profile,
    DSH_PROFILE_DIR: profileDir,
    WORKBENCH_PROFILE_DIR: profileDir,
    ...(dbPath === undefined ? {} : { WORKBENCH_EXPECTED_DB_PATH: dbPath }),
  }
}

// ── 预检主流程 ──────────────────────────────────────────────────────────────

const reason = (code, severity, message, extra = {}) => ({ code, severity, message, ...extra })

/**
 * @param {{url?: string, profile?: string, profileDir?: string, dbPath?: string, force?: boolean,
 *          env?: Record<string, string|undefined>, home?: string, dshHome?: string}} input
 * @param {{readActualConfig?: Function, existsSync?: Function, realpath?: Function, platform?: string}} [deps]
 */
export function preflight(input, deps = {}) {
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const dshHome = input.dshHome ?? env.DSH_HOME ?? join(home, '.dsh')
  const exists = deps.existsSync ?? defaultExistsSync
  const readConfig = deps.readActualConfig ?? ((options) => readActualConfig({ ...options, deps: { ...deps, readFileSync: deps.readFileSync } }))
  const pathDeps = { realpath: deps.realpath, platform: deps.platform }
  const reasons = []
  const force = input.force === true

  // 1) 环境事实（拿不到就无法自锁）
  const currentUrlRaw = env.DSH_WEB_URL
  const currentUrl = parseHttpUrl(currentUrlRaw)
  if (!currentUrl.ok) reasons.push(reason('ENV_URL_INVALID', 'error', `DSH_WEB_URL 缺失或非法（${currentUrl.reason}）—— 无法证明目标不是当前实例，拒绝`))
  else if (!isLoopbackHost(currentUrl.hostname)) reasons.push(reason('ENV_URL_INVALID', 'error', `DSH_WEB_URL 不是本机地址：${currentUrl.href}`))
  if (typeof env.DSH_PROFILE !== 'string' || env.DSH_PROFILE === '') reasons.push(reason('ENV_MISSING', 'error', 'DSH_PROFILE 缺失 —— 无法判断目标 profile 是否为当前实例'))
  if (typeof env.DSH_PROFILE_DIR !== 'string' || env.DSH_PROFILE_DIR === '') reasons.push(reason('ENV_MISSING', 'error', 'DSH_PROFILE_DIR 缺失 —— 无法做物理目录比对'))

  // 2) 目标本身
  const target = parseHttpUrl(input.url)
  if (!target.ok) reasons.push(reason('TARGET_URL_INVALID', 'error', `--url 缺失或非法（${target.reason}）`))
  else if (!isLoopbackHost(target.hostname)) reasons.push(reason('TARGET_NOT_LOOPBACK', 'error', `只允许 loopback 目标，实际 ${target.hostname}`))
  const profile = typeof input.profile === 'string' ? input.profile : ''
  if (profile === '') reasons.push(reason('TARGET_PROFILE_INVALID', 'error', '--profile 必填'))
  if (target.ok && (target.port !== AUTHORIZED_PORT || profile !== AUTHORIZED_PROFILE)) {
    reasons.push(reason('TARGET_OUT_OF_SCOPE', 'error', `授权范围只有 ${AUTHORIZED_PORT} / ${AUTHORIZED_PROFILE}（ADR0006）；实际 ${target.port} / ${profile || '(空)'}。--force 不能扩权`))
  }

  // 3) 同端口
  if (currentUrl.ok && target.ok && currentUrl.port === target.port) {
    reasons.push(reason('SAME_PORT', 'error', `目标端口 ${target.port} 与当前会话 DSH_WEB_URL 的端口相同 —— 目标就是当前实例，任何情况下都不许重启/装盘（--force 也绕不过）`, { bypassable: false }))
  }

  // 4) profile 物理目录
  let targetProfileDir
  if (typeof input.profileDir !== 'string' || input.profileDir.trim() === '') reasons.push(reason('PROFILE_DIR_REQUIRED', 'error', '--profile-dir 必填（必须是目标的绝对目录，不许靠继承）'))
  else {
    targetProfileDir = isAbsolute(input.profileDir.trim()) ? resolve(input.profileDir.trim()) : undefined
    if (targetProfileDir === undefined) reasons.push(reason('PROFILE_DIR_NOT_ABSOLUTE', 'error', `--profile-dir 必须是绝对路径：${input.profileDir}`))
    else if (!exists(targetProfileDir)) reasons.push(reason('PROFILE_DIR_MISSING', 'error', `目标 profile 目录不存在：${targetProfileDir}`))
    else {
      const stat = deps.statSync ?? statSync
      try {
        if (!stat(targetProfileDir).isDirectory()) reasons.push(reason('PROFILE_DIR_NOT_DIR', 'error', `--profile-dir 不是目录：${targetProfileDir}`))
      } catch (error) {
        reasons.push(reason('PROFILE_DIR_NOT_DIR', 'error', `--profile-dir 读不了：${targetProfileDir} —— ${error instanceof Error ? error.message : String(error)}`))
      }
    }
  }
  if (targetProfileDir !== undefined && typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR !== '' && exists(env.DSH_PROFILE_DIR)) {
    if (samePath(targetProfileDir, env.DSH_PROFILE_DIR, pathDeps)) {
      reasons.push(reason('SAME_PROFILE_DIR', 'error', `目标 profile 目录与当前 DSH_PROFILE_DIR 是同一个物理目录（${targetProfileDir}）—— 装盘/重启会打到当前实例（--force 也绕不过）`, { bypassable: false }))
    }
  }
  if (profile !== '' && typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE !== '' && env.DSH_PROFILE === profile && targetProfileDir !== undefined && typeof env.DSH_PROFILE_DIR === 'string' && !samePath(targetProfileDir, env.DSH_PROFILE_DIR, pathDeps)) {
    const message = `目标 profile 名与当前相同（${profile}）但目录不同：当前 ${env.DSH_PROFILE_DIR}，目标 ${targetProfileDir}`
    if (force) reasons.push(reason('PROFILE_NAME_COLLISION', 'warning', `${message}；已由 --force 显式确认为不同环境`, { bypassable: true, bypassedBy: 'force' }))
    else reasons.push(reason('PROFILE_NAME_COLLISION', 'error', `${message} —— 若确认两者确实是不同环境，请显式加 --force`, { bypassable: true }))
  }

  // 5) 数据库隔离：默认 DB 跨 profile 共用，必须读**实际配置**证明
  const currentConfig = typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR !== '' && exists(env.DSH_PROFILE_DIR)
    ? readConfig({ profile: env.DSH_PROFILE ?? '', profileDir: env.DSH_PROFILE_DIR, dshHome })
    : { ok: true, values: {}, sources: [], conflicts: [], unparsable: [] }
  const targetConfig = targetProfileDir === undefined ? { ok: true, values: {}, sources: [], conflicts: [], unparsable: [] } : readConfig({ profile, profileDir: targetProfileDir, dshHome })

  if (typeof input.dbPath !== 'string' || input.dbPath.trim() === '') {
    reasons.push(reason('DB_PATH_REQUIRED', 'error', '--db-path 必填：默认 DB（~/.dsh/workbench/workbench.db）跨 profile 共用，必须声明并核对独立测试库'))
  }
  if (targetConfig.unparsable.length > 0) {
    reasons.push(reason('DB_UNKNOWN', 'error', `目标 profile 的实际配置读不完整，无法证明 DB 隔离：${targetConfig.unparsable.map((entry) => `${entry.file}(${entry.reason})`).join('；')}`))
  }
  if (targetConfig.conflicts.length > 0) {
    reasons.push(reason('DB_CONFLICT', 'error', `目标 profile 的多层 patch 对 DB 配置互相矛盾，无法判定实际库：${JSON.stringify(targetConfig.conflicts)}`))
  }
  const declaredDb = resolveDbPathConfig(targetConfig.values ?? {}, { home: dshHome })
  const declaresDb = typeof targetConfig.values?.dbPath === 'string' || typeof targetConfig.values?.dataDir === 'string'
  if (targetConfig.unparsable.length === 0 && targetConfig.conflicts.length === 0 && !declaresDb) {
    reasons.push(reason('DB_NOT_DECLARED', 'error', `目标 profile 的实际配置里没有 dbPath/dataDir —— 它会用默认共享库 ${declaredDb}（与当前实例同一个文件）。换端口/换 profile 名都不能证明 DB 隔离`, { bypassable: false }))
  }
  if (typeof input.dbPath === 'string' && input.dbPath.trim() !== '' && declaresDb && !samePath(input.dbPath, declaredDb, pathDeps)) {
    reasons.push(reason('DB_PATH_MISMATCH', 'error', `--db-path 声明的库（${resolve(input.dbPath.trim())}）与目标实际配置指向的库（${declaredDb}）不是同一个文件 —— 参数不算隔离证据`, { bypassable: false }))
  }
  if (currentConfig.unparsable.length > 0) {
    reasons.push(reason('DB_UNKNOWN', 'error', `当前实例的实际配置读不完整，无法证明与目标不同库：${currentConfig.unparsable.map((entry) => entry.file).join('；')}`))
  }
  const currentDb = resolveDbPathConfig(currentConfig.values ?? {}, { home: dshHome })
  if (currentConfig.unparsable.length === 0 && declaresDb && samePath(declaredDb, currentDb, pathDeps)) {
    reasons.push(reason('SAME_DB', 'error', `目标 DB 与当前实例的 DB 是同一个物理文件（${currentDb}）—— 验收写入会落到正式库上（--force 也绕不过）`, { bypassable: false }))
  }

  // 6) 继承污染（AX-V04）：继承来的 desktop 路径绝不许传给 web 安装
  const inheritedWorkbench = env.WORKBENCH_PROFILE_DIR
  if (typeof inheritedWorkbench === 'string' && inheritedWorkbench !== '' && targetProfileDir !== undefined && !samePath(inheritedWorkbench, targetProfileDir, pathDeps)) {
    reasons.push(reason('WORKBENCH_PROFILE_DIR_MISMATCH', 'error', `环境里的 WORKBENCH_PROFILE_DIR（${inheritedWorkbench}）与装盘目标（${targetProfileDir}）不一致 —— 门禁会去核对另一个 profile。子进程必须重设它`, { bypassable: false }))
  }
  if (typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR !== '' && targetProfileDir !== undefined && !samePath(env.DSH_PROFILE_DIR, targetProfileDir, pathDeps)) {
    reasons.push(reason('INHERITED_PROFILE_DIR', 'warning', `当前环境继承的 DSH_PROFILE_DIR（${env.DSH_PROFILE_DIR}）指向另一个 profile；链会把子进程的 DSH_PROFILE/DSH_PROFILE_DIR/WORKBENCH_PROFILE_DIR 全部重设为目标`, { bypassable: true, bypassedBy: 'plan' }))
  }

  const errors = reasons.filter((entry) => entry.severity === 'error')
  const ok = errors.length === 0
  return {
    ok,
    exitCode: ok ? 0 : 2,
    reasons,
    errors,
    warnings: reasons.filter((entry) => entry.severity === 'warning'),
    facts: {
      current: { url: currentUrl.ok ? currentUrl.href : null, port: currentUrl.ok ? currentUrl.port : null, profile: env.DSH_PROFILE ?? null, profileDir: env.DSH_PROFILE_DIR ?? null, dbPath: currentDb, sources: currentConfig.sources ?? [] },
      target: { url: target.ok ? target.href : null, port: target.ok ? target.port : null, profile, profileDir: targetProfileDir ?? null, dbPath: declaredDb, declaresDb, sources: targetConfig.sources ?? [] },
      force,
    },
    plan: {
      stages: STAGE_PLAN,
      childEnv: targetProfileDir === undefined ? {} : planChildEnv({ profile, profileDir: targetProfileDir, dbPath: input.dbPath }),
      overrideEnv: OVERRIDDEN_ENV,
      scrubEnv: SCRUBBED_ENV,
      sideEffects: { installed: false, restarted: false, dbWrites: 0, browsers: 0 },
    },
  }
}
