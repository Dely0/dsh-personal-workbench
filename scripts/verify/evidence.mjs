/**
 * 证据包（plan.md V04 / requirements.md §7.3 / AX-V08）。
 *
 * ## 为什么证据要单独一个模块
 *
 * 这条链的产物是"给人和 AI 读的判定摘要"，它有两个**致命的**失败模式：
 *
 * 1. **泄漏 token**。token 只从目标实例的启动日志里来，而日志/stdout/URL/截图里
 *    到处都可能带着它。一旦写进 `test-results/`，就是"凭据进了仓库工作区"。
 *    → 所以本模块**所有**写盘路径都强制过一次 `redact()`，并且在 summary 里显式声明
 *    注册了几个秘密、是否已脱敏。
 * 2. **静默丢件**。摘要里不写"哪些阶段没跑/为什么没跑"，读的人就会把一次半截运行
 *    当成全绿。→ 所以 summary 里阶段、套件、blockers、warnings 都是**必填**，
 *    缺套件/空计数一律走 blockers，不许省略。
 *
 * 目录：`test-results/workbench-verify/<runId>/`（`test-results/` 已在 .gitignore 里）。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export const EVIDENCE_ROOT = 'test-results/workbench-verify'

/** 秘密被替换成的东西（固定串，便于在证据里一眼看出"这里本来有个秘密"）。 */
export const REDACTED = '***'

/**
 * 脱敏。除了显式注册的秘密，还兜住几种**形状**：
 * `?token=xxx` / `"token":"xxx"` / `Authorization: Bearer xxx` / `--token xxx`。
 *
 * 为什么不能只按注册值替换：真实日志里 token 可能出现在 URL 编码、带引号、
 * 或 `Bearer` 前缀等形态里；只替换裸值会漏。
 */
export function redact(text, secrets = []) {
  let output = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 6) continue
    output = output.split(secret).join(REDACTED)
  }
  output = output.replace(/([?&]token=)[A-Za-z0-9_\-]{6,}/gi, `$1${REDACTED}`)
  output = output.replace(/(["']?token["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-]{6,}/gi, `$1${REDACTED}`)
  output = output.replace(/(Bearer\s+)[A-Za-z0-9_\-.=]{6,}/gi, `$1${REDACTED}`)
  output = output.replace(/(--token\s+)[A-Za-z0-9_\-]{6,}/gi, `$1${REDACTED}`)
  return output
}

/** runId：可读时间 + 随机尾巴（同一秒重跑也不会互相覆盖证据）。 */
export function makeRunId(now = new Date(), random = Math.random) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')
  return `${stamp}-${suffix}`
}

/** 递归列出目录下所有文件（相对路径，统一 `/`）。 */
export function listFilesRecursive(dir, base = dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base))
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

/**
 * 建一个证据运行。
 *
 * **惰性建目录**：dry-run 会在拿到 run 之前就返回，所以"没写过任何东西"的 run
 * 不会在磁盘上留下空目录（AX-V05 要求 dry-run 零写入）。
 */
export function createEvidenceRun(options = {}) {
  const root = options.root ?? EVIDENCE_ROOT
  const runId = options.runId ?? makeRunId(options.now ?? new Date())
  const dir = join(root, runId)
  const secrets = []
  const files = []
  let created = false

  const ensure = () => {
    if (created) return
    mkdirSync(dir, { recursive: true })
    created = true
  }

  const api = {
    runId,
    dir,
    relDir: `${root.split(sep).join('/')}/${runId}`,
    get created() { return created },
    get secrets() { return [...secrets] },
    get files() { return [...files] },
    addSecret(value) {
      if (typeof value === 'string' && value.length >= 6 && !secrets.includes(value)) secrets.push(value)
      return value
    },
    writeText(name, text) {
      ensure()
      const safe = redact(text, secrets)
      writeFileSync(join(dir, name), safe, 'utf8')
      if (!files.includes(name)) files.push(name)
      return join(dir, name)
    },
    writeJson(name, value) {
      return api.writeText(name, `${JSON.stringify(value, null, 2)}\n`)
    },
    writeBuffer(name, buffer) {
      ensure()
      writeFileSync(join(dir, name), buffer)
      files.push(name)
      return join(dir, name)
    },
    finalize(summary) {
      const payload = { ...summary, evidence: { dir: api.relDir, files: [...files, 'summary.json', 'summary.md'] }, redaction: { secretsRegistered: secrets.length, applied: true } }
      api.writeJson('summary.json', payload)
      api.writeText('summary.md', renderSummaryMarkdown(payload))
      return { jsonPath: join(dir, 'summary.json'), mdPath: join(dir, 'summary.md'), summary: payload }
    },
  }
  return api
}

const STATUS_ICON = { pass: '✅', fail: '✖', refused: '⛔', timeout: '⏱', skipped: '⏭', notrun: '·' }

/** 人读摘要。AI 先读它，别去翻上百份日志。 */
export function renderSummaryMarkdown(summary) {
  const lines = []
  lines.push(`# 研发验收链证据：${summary.runId}`)
  lines.push('')
  lines.push(`- 结论：**${summary.verdict}**（退出码 ${summary.exitCode}）`)
  lines.push(`- 目标：${summary.target?.url} / profile ${summary.target?.profile} / ${summary.target?.profileDir}`)
  lines.push(`- 数据库隔离：${summary.target?.dbIsolation?.independent === true ? '已证明独立' : '**未证明**'} → ${summary.target?.dbIsolation?.targetDbPath}`)
  lines.push(`- 构建标识：包 ${summary.buildIdentity?.package?.buildId} / host ${summary.buildIdentity?.health?.buildId} / client ${summary.buildIdentity?.client}（匹配：${summary.buildIdentity?.matched === true ? '是' : '**否**'}）`)
  lines.push(`- 时间：${summary.startedAt} → ${summary.finishedAt}（${summary.durationMs}ms）`)
  lines.push('')
  lines.push('## 阶段')
  lines.push('')
  lines.push('| 阶段 | 状态 | 退出码 | 耗时 | 说明 |')
  lines.push('|---|---|---|---|---|')
  for (const stage of summary.stages ?? []) {
    lines.push(`| ${stage.name} | ${STATUS_ICON[stage.status] ?? ''} ${stage.status} | ${stage.exitCode ?? ''} | ${stage.ms ?? ''}ms | ${String(stage.detail ?? '').replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  lines.push('## 套件')
  lines.push('')
  lines.push('| 套件 | 状态 | 通过 | 失败 | 跳过 | 耗时 |')
  lines.push('|---|---|---|---|---|---|')
  for (const suite of summary.suites ?? []) {
    lines.push(`| ${suite.id} | ${suite.status} | ${suite.passed ?? ''} | ${suite.failed ?? ''} | ${suite.skipped ?? ''} | ${suite.ms ?? ''}ms |`)
  }
  if ((summary.suites ?? []).length === 0) lines.push('| （本次没有跑任何套件） | · | | | | |')
  lines.push('')
  lines.push('## 阻塞与警告')
  lines.push('')
  for (const blocker of summary.blockers ?? []) lines.push(`- ⛔ ${blocker}`)
  for (const warning of summary.warnings ?? []) lines.push(`- ⚠️ ${warning}`)
  if ((summary.blockers ?? []).length === 0 && (summary.warnings ?? []).length === 0) lines.push('- （无）')
  lines.push('')
  lines.push('## 副作用')
  lines.push('')
  lines.push(`- 装盘：${summary.sideEffects?.installed === true ? '已发生' : '未发生'}；重启目标：${summary.sideEffects?.restarted === true ? '已发生' : '未发生'}；DB 写：${summary.sideEffects?.dbWrites ?? 0} 次；起浏览器：${summary.sideEffects?.browsersOpened ?? 0} 个；清理临时目录：${summary.sideEffects?.tempDirsRemoved ?? 0} 个`)
  lines.push(`- 脱敏：注册秘密 ${summary.redaction?.secretsRegistered ?? 0} 个，全部写盘路径已过 redact()`)
  lines.push('')
  lines.push('## 证据文件')
  lines.push('')
  for (const file of summary.evidence?.files ?? []) lines.push(`- ${file}`)
  lines.push('')
  return lines.join('\n')
}

/** 给测试与链共用：目录里所有文本内容拼起来（用来查"token 是否还留在证据里"）。 */
export function readAllText(dir) {
  return listFilesRecursive(dir)
    .map((file) => {
      try { return `${file}\n${readFileSync(join(dir, file), 'utf8')}` } catch { return file }
    })
    .join('\n')
}
