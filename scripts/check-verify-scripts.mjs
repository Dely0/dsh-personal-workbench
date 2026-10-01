/**
 * 过时验收脚本治理 + 现役白名单校验（plan.md V01 / P1-1 / AX-V01）。
 *
 * ## 它解决什么问题
 *
 * `.pwtest/` 下堆了一大批本机验收脚本，其中一部分测的是**已经删掉的行为**
 * （旧面板接管、旧 data-* 标记、降级腿…）。不治理的话，验收链一跑就是成片假失败，
 * 真信号被噪声吃掉（ADR0006 §6 把这条列为链的前置依赖）。
 *
 * ## 三条纪律（都是硬要求，不是风格）
 *
 * 1. **绝不删脚本**：本工具只读 + 可选地在命中项顶部插一行失效警告（幂等），
 *    从不删除、从不移动、从不改判据正文。
 * 2. **关键词只标嫌疑**：命中 ≠ 作废。作废必须由人在 `suites.json` 的 `deprecated[]`
 *    里写明原因；命中项只出现在报告的"嫌疑"一栏。
 * 3. **计数动态生成**：脚本数、命中数、白名单数一律现算。历史值（150 个脚本 / 22 份命中）
 *    是 2026-09-30 的快照，**不是本工具的输出**，也不许写进判据。
 *
 * ## 白名单语义（`scripts/verify/suites.json`）
 *
 * - `active`：现役。**文件必须存在且非空**，缺文件 = 退出码 1（"缺必需套件"不许静默变绿）。
 * - `pending-migration`：已登记、文件还没迁进仓库。必须写 `reason`，否则算配置错误。
 *    它不会被当成通过 —— 链看到必需的 pending 套件时拒绝报绿（见 scripts/dev-verify.mjs）。
 * - `deprecated[]`：明确作废，禁止进入任何执行链；文件保留。
 * - 套件目录里出现**未声明**的 `*.mjs` 也算错误（静默丢件：文件在、却永远不会被执行）。
 *   以 `_` 开头的辅助模块豁免。
 *
 * ## 用法
 *
 * ```sh
 * node scripts/check-verify-scripts.mjs              # 人读报告
 * node scripts/check-verify-scripts.mjs --json       # 机读（链/测试用）
 * node scripts/check-verify-scripts.mjs --annotate   # 给命中项插失效警告头（幂等、不删）
 * ```
 *
 * 退出码：0 = 没有错误（警告不算失败）；1 = 白名单/清单有错误；2 = 参数或文件读不了。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 插进命中脚本顶部的那一行 —— 幂等判据就是"文件里有没有它"。 */
export const SUSPICION_MARKER = '⚠️ 架构变更后失效（P1-1 关键词扫描命中，见 scripts/check-verify-scripts.mjs）'

export const VALID_STATUS = ['active', 'pending-migration', 'deprecated']

const toPosix = (value) => String(value).split('\\').join('/')

/** 统一的报告行格式，供 CLI 与测试共用（不靠人肉比对措辞）。 */
const line = (kind, text) => ({ kind, text })

export function loadManifest(manifestPath, deps = {}) {
  const read = deps.readFileSync ?? readFileSync
  const exists = deps.existsSync ?? existsSync
  if (!exists(manifestPath)) {
    return { manifest: undefined, problems: [`白名单文件不存在：${toPosix(manifestPath)}`] }
  }
  try {
    const manifest = JSON.parse(read(manifestPath, 'utf8'))
    return { manifest, problems: [] }
  } catch (error) {
    return { manifest: undefined, problems: [`白名单不是合法 JSON：${toPosix(manifestPath)} —— ${String(error)}`] }
  }
}

/**
 * 校验白名单本身（结构 + 现役文件是否真的在）。
 *
 * @param {any} manifest
 * @param {{root: string, exists?: Function, readFileSync?: Function, readdirSync?: Function}} options
 */
export function validateManifest(manifest, options) {
  const root = resolve(options.root ?? process.cwd())
  const exists = options.existsSync ?? existsSync
  const read = options.readFileSync ?? readFileSync
  const list = options.readdirSync ?? readdirSync
  const problems = []
  const notes = []
  const suites = []

  if (typeof manifest !== 'object' || manifest === null) {
    return { problems: ['白名单根节点不是对象'], notes, suites, counts: { active: 0, pending: 0, deprecated: 0 } }
  }
  if (typeof manifest.version !== 'number') problems.push('白名单缺少数字类型的 version')

  const declared = new Set()
  const entries = Array.isArray(manifest.suites) ? manifest.suites : []
  if (!Array.isArray(manifest.suites)) problems.push('白名单缺少 suites 数组')

  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id : '(缺 id)'
    if (typeof entry?.id !== 'string' || entry.id === '') { problems.push(`套件条目缺少字符串 id：${JSON.stringify(entry)}`); continue }
    if (declared.has(entry.id)) problems.push(`套件 id 重复：${entry.id}`)
    declared.add(entry.id)
    if (!VALID_STATUS.includes(entry.status)) { problems.push(`套件 ${id} 的 status 非法：${String(entry.status)}（只允许 ${VALID_STATUS.join(' / ')}）`); continue }
    if (typeof entry.required !== 'boolean') problems.push(`套件 ${id} 缺少布尔型 required`)

    let fileState = 'n/a'
    if (entry.status === 'deprecated') {
      problems.push(`套件 ${id} 被标成 deprecated —— 作废项请写进顶层 deprecated[]，不要混在 suites[] 里`)
      continue
    }
    if (typeof entry.repoPath !== 'string' || entry.repoPath === '') {
      problems.push(`套件 ${id}（${entry.status}）缺少 repoPath`)
      continue
    }
    const absolute = resolve(root, entry.repoPath)
    if (entry.status === 'active') {
      if (!exists(absolute)) {
        problems.push(`现役套件缺文件：${entry.id} → ${toPosix(entry.repoPath)}`)
        fileState = 'missing'
      } else {
        let size = 0
        try { size = String(read(absolute, 'utf8')).length } catch (error) { problems.push(`现役套件读不了：${entry.id} → ${String(error)}`) }
        if (size === 0) problems.push(`现役套件是空文件：${entry.id} → ${toPosix(entry.repoPath)}`)
        else fileState = 'present'
      }
    } else {
      // pending-migration：文件现在不在是正常的，但必须留下原因，且不许在报告里被当通过。
      if (typeof entry.reason !== 'string' || entry.reason === '') problems.push(`待迁移套件 ${id} 缺少 reason（"为什么还没迁"必须写明）`)
      fileState = exists(absolute) ? 'present-but-pending' : 'missing'
      if (fileState === 'present-but-pending') notes.push(`套件 ${id} 的文件已存在但状态仍是 pending-migration —— 迁完记得翻成 active`)
    }
    suites.push({ id: entry.id, status: entry.status, required: entry.required === true, repoPath: toPosix(entry.repoPath), fileState, legacyIds: entry.legacyIds ?? [], axIds: entry.axIds ?? [] })
  }

  // 套件目录里未声明的 .mjs = 静默丢件（文件在，却永远不会被链执行）
  const suiteRoot = typeof manifest.roots?.repoSuites === 'string' ? resolve(root, manifest.roots.repoSuites) : undefined
  if (suiteRoot !== undefined && exists(suiteRoot)) {
    const declaredPaths = new Set(entries.filter((entry) => typeof entry?.repoPath === 'string').map((entry) => resolve(root, entry.repoPath)))
    for (const name of list(suiteRoot)) {
      if (!name.endsWith('.mjs') || name.startsWith('_')) continue
      const absolute = join(suiteRoot, name)
      if (!declaredPaths.has(resolve(absolute))) problems.push(`套件目录里有未声明的脚本（不会被任何链执行）：${toPosix(join(manifest.roots.repoSuites, name))}`)
    }
  }

  const deprecated = Array.isArray(manifest.deprecated) ? manifest.deprecated : []
  if (manifest.deprecated !== undefined && !Array.isArray(manifest.deprecated)) problems.push('deprecated 必须是数组')
  for (const entry of deprecated) {
    if (typeof entry?.path !== 'string' || entry.path === '') { problems.push(`作废条目缺少 path：${JSON.stringify(entry)}`); continue }
    if (typeof entry.reason !== 'string' || entry.reason === '') problems.push(`作废条目缺少 reason：${toPosix(entry.path)}`)
    if (suites.some((suite) => suite.repoPath === toPosix(entry.path) && suite.status === 'active')) {
      problems.push(`作废条目同时被声明为现役套件：${toPosix(entry.path)}`)
    }
  }

  const counts = {
    active: suites.filter((suite) => suite.status === 'active').length,
    pending: suites.filter((suite) => suite.status === 'pending-migration').length,
    requiredPending: suites.filter((suite) => suite.status === 'pending-migration' && suite.required).length,
    deprecated: deprecated.length,
  }
  return { problems, notes, suites, counts }
}

/**
 * 关键词扫描机-local 脚本目录。**只标嫌疑**，不判定作废。
 *
 * 目录不存在 = 正常（新机器没有 .pwtest），报告成"本地资料缺失"而不是失败。
 */
export function scanSuspects(dir, keywords, deps = {}) {
  const exists = deps.existsSync ?? existsSync
  const list = deps.readdirSync ?? readdirSync
  const read = deps.readFileSync ?? readFileSync
  if (!exists(dir)) return { present: false, scanned: 0, suspects: [], unreadable: [] }
  const suspects = []
  const unreadable = []
  /** 只数 `.mjs`：这些目录里还可能有 json/截图等非脚本产物。 */
  const files = list(dir).filter((name) => name.endsWith('.mjs')).sort()
  for (const name of files) {
    let text
    try { text = String(read(join(dir, name), 'utf8')) } catch (error) { unreadable.push({ file: name, error: String(error) }); continue }
    const hits = keywords.filter((keyword) => text.includes(keyword))
    if (hits.length > 0) suspects.push({ file: name, keywords: hits, alreadyAnnotated: text.includes(SUSPICION_MARKER) })
  }
  return { present: true, scanned: files.length, suspects, unreadable }
}

/**
 * 给命中脚本插一行失效警告。幂等（已有标记就跳过）、保 shebang、不删任何内容。
 */
export function annotateSuspects(dir, suspects, deps = {}) {
  const read = deps.readFileSync ?? readFileSync
  const write = deps.writeFileSync ?? writeFileSync
  const results = []
  for (const suspect of suspects) {
    const file = join(dir, suspect.file)
    let text
    try { text = String(read(file, 'utf8')) } catch (error) { results.push({ file: suspect.file, action: 'failed', error: String(error) }); continue }
    if (text.includes(SUSPICION_MARKER)) { results.push({ file: suspect.file, action: 'already' }); continue }
    const header = `/* ${SUSPICION_MARKER} */\n`
    const lines = text.split('\n')
    const next = lines[0]?.startsWith('#!') ? [lines[0], header.trimEnd(), ...lines.slice(1)] : [header.trimEnd(), ...lines]
    try {
      write(file, next.join('\n'))
      results.push({ file: suspect.file, action: 'annotated' })
    } catch (error) {
      results.push({ file: suspect.file, action: 'failed', error: String(error) })
    }
  }
  return results
}

/** 全量检查（CLI 与 test 共用同一条路径，避免"测的是一个版本、跑的是另一个版本"）。 */
export function runCheck(options = {}) {
  const root = resolve(options.root ?? process.cwd())
  const manifestPath = resolve(root, options.manifest ?? 'scripts/verify/suites.json')
  const lines = []
  const loaded = loadManifest(manifestPath, options)
  for (const problem of loaded.problems) lines.push(line('error', problem))
  if (loaded.manifest === undefined) {
    return { exitCode: 2, manifestPath: toPosix(manifestPath), lines, problems: [...loaded.problems], counts: {}, suites: [], local: {} }
  }

  const validated = validateManifest(loaded.manifest, { ...options, root })
  for (const problem of validated.problems) lines.push(line('error', problem))
  for (const note of validated.notes) lines.push(line('note', note))

  const localRoot = resolve(root, options.localRoot ?? loaded.manifest.roots?.localScripts ?? '.pwtest')
  const keywords = Array.isArray(options.keywords) ? options.keywords : (loaded.manifest.suspectKeywords ?? [])
  const local = scanSuspects(localRoot, keywords, options)

  if (!local.present) {
    lines.push(line('note', `本地脚本目录缺失（${toPosix(localRoot)}）—— 正常：仓库内的白名单不依赖它；本机嫌疑扫描本次不做`))
  } else {
    lines.push(line('note', `本地脚本动态统计：${local.scanned} 份 .mjs（关键词：${keywords.join('、') || '（无）'}）`))
    lines.push(line('note', `嫌疑命中：${local.suspects.length} 份（命中只标嫌疑，作废必须人工写进 deprecated[]）`))
    for (const suspect of local.suspects) {
      lines.push(line('suspect', `${suspect.file} ← ${suspect.keywords.join('、')}${suspect.alreadyAnnotated ? '（已插警告头）' : ''}`))
    }
    for (const bad of local.unreadable) lines.push(line('suspect', `${bad.file} 读不了：${bad.error}`))
  }

  const deprecated = Array.isArray(loaded.manifest.deprecated) ? loaded.manifest.deprecated : []
  lines.push(line('note', `白名单动态统计：现役 ${validated.counts.active} / 待迁移 ${validated.counts.pending}（其中必需 ${validated.counts.requiredPending}）/ 作废 ${validated.counts.deprecated}`))
  for (const suite of validated.suites) {
    lines.push(line(suite.status === 'active' ? 'ok' : 'warn', `${suite.status === 'active' ? '现役' : '待迁移'} ${suite.id} → ${suite.repoPath}（文件：${suite.fileState}）`))
  }
  for (const entry of deprecated) lines.push(line('warn', `作废（禁入链）${toPosix(entry.path)}：${entry.reason ?? '(缺原因)'}`))

  const errors = lines.filter((entry) => entry.kind === 'error')
  const warnings = lines.filter((entry) => entry.kind === 'warn' || entry.kind === 'suspect')
  return {
    exitCode: errors.length > 0 ? 1 : 0,
    manifestPath: toPosix(manifestPath),
    localRoot: toPosix(localRoot),
    problems: errors.map((entry) => entry.text),
    warnings: warnings.map((entry) => entry.text),
    counts: { ...validated.counts, localScripts: local.scanned, suspects: local.suspects.length },
    suites: validated.suites,
    local,
    lines,
  }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--annotate') options.annotate = true
    else if (arg === '--root') options.root = argv[++index]
    else if (arg === '--manifest') options.manifest = argv[++index]
    else if (arg === '--local-root') options.localRoot = argv[++index]
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) { console.error(`未知参数：${arg}`); options.bad = true }
  }
  return options
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(readFileSync(join(HERE, 'check-verify-scripts.mjs'), 'utf8').split('\n').slice(1, 12).join('\n'))
    process.exit(0)
  }
  if (options.bad) process.exit(2)
  const result = runCheck(options)
  if (options.annotate && result.local?.present) {
    const results = annotateSuspects(resolve(options.root ?? process.cwd(), result.localRoot ?? '.pwtest'), result.local.suspects)
    result.annotations = results
    for (const entry of results) {
      if (entry.action === 'annotated') console.log(`  ✎ 插入失效警告：${entry.file}`)
      else if (entry.action === 'failed') console.log(`  ⚠️ 插警告失败（文件未改）：${entry.file} —— ${entry.error}`)
    }
    console.log(`  插警告：新增 ${results.filter((entry) => entry.action === 'annotated').length} / 已有 ${results.filter((entry) => entry.action === 'already').length} / 失败 ${results.filter((entry) => entry.action === 'failed').length}（**没有任何脚本被删除**）`)
  }
  if (options.json) {
    console.log(JSON.stringify({ exitCode: result.exitCode, counts: result.counts, problems: result.problems, warnings: result.warnings, suites: result.suites, suspectFiles: (result.local?.suspects ?? []).map((entry) => entry.file) }, null, 2))
  } else {
    console.log('=== 验收脚本卫生 + 现役白名单 ===')
    for (const entry of result.lines) {
      const prefix = entry.kind === 'error' ? '✖' : entry.kind === 'suspect' ? '⚠️' : entry.kind === 'warn' ? '⚠️' : entry.kind === 'ok' ? '✅' : '·'
      console.log(`  ${prefix} ${entry.text}`)
    }
    console.log(`  动态统计：现役 ${result.counts.active} / 待迁移 ${result.counts.pending}（必需 ${result.counts.requiredPending}）/ 作废 ${result.counts.deprecated} / 本地脚本 ${result.counts.localScripts ?? 0} / 嫌疑 ${result.counts.suspects ?? 0}`)
    if (result.exitCode === 0 && (result.counts.requiredPending ?? 0) > 0) {
      console.log(`\n⚠️ 白名单没有错误，但有 ${result.counts.requiredPending} 个**必需**套件还没迁进仓库 —— 链在它们就绪前拒绝报绿（不是通过）`)
    } else if (result.exitCode === 0) {
      console.log('\n✅ 白名单没有错误，现役套件文件齐、作废项不会进链')
    } else {
      console.log('\n✖ 白名单有错误，先修上面 ✖ 的条目')
    }
  }
  process.exit(result.exitCode)
}
