/**
 * 构建标识（plan.md V04-B / requirements.md §7.2）。
 *
 * ## 为什么必须有一个"本次构建"的标识
 *
 * 2026-09-12 的真实事故形态：装盘之后 profile 里**仍是旧代码**（`pnpm install` 不刷新
 * 同名同版本的 tgz），于是"修完再验"验的一直是旧包，而 `health` 报的版本号**完全一样** ——
 * 版本号根本不是判据（`scripts/check-installed-fingerprint.mjs` 的文件头写着这条结论）。
 *
 * 所以：一次构建生成**一个** `buildId`（构建输入的内容哈希，不用公开版本号充当构建戳），
 * 写进随包的 `lib/build-info.json`，并在 client 编译时**内联**进 bundle。验收前同时比对
 * 「目标包 manifest / host health / 浏览器根属性」三者，缺失或不一致一律失败。
 *
 * ## 输入范围（刻意不含 test/ 与 docs/）
 *
 * 只有**随包发布或决定产物形态**的东西才算构建输入：
 * `src/**`、`assets/**`、`package.json`、`cordis.patch.yml`、`tsdown.config.ts`、`tsconfig*.json`。
 * 改一条测试或一份文档不应该改变构建标识 —— 否则"本次构建"这个词会失去意义。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 构建输入的相对路径（文件或目录；目录递归）。顺序固定，便于复现。 */
export const BUILD_INPUTS = [
  'src',
  'assets',
  'package.json',
  'cordis.patch.yml',
  'tsdown.config.ts',
  'tsconfig.json',
  'tsconfig.build.json',
]

/** 永不进入输入的目录名（构建产物/依赖/证据/本机归档）。 */
export const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'lib', 'test-results', '_local-build', '_local-archive', '.pwtest', 'screenshots'])

export const BUILD_INFO_RELATIVE = 'lib/build-info.json'

const toPosix = (value) => String(value).split(sep).join('/')

export function collectInputFiles(root = REPO_ROOT, deps = {}) {
  const exists = deps.existsSync ?? ((path) => { try { return statSync(path) !== undefined } catch { return false } })
  const list = deps.readdirSync ?? readdirSync
  const stat = deps.statSync ?? statSync
  const out = []

  const walk = (absolute, base) => {
    let entries
    try { entries = list(absolute, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      const full = join(absolute, entry.name)
      if (entry.isDirectory()) { walk(full, base); continue }
      if (!entry.isFile()) continue
      out.push(toPosix(relative(base, full)))
    }
  }

  for (const input of BUILD_INPUTS) {
    const absolute = join(root, input)
    if (!exists(absolute)) continue
    let stats
    try { stats = stat(absolute) } catch { continue }
    if (stats.isDirectory()) walk(absolute, root)
    else out.push(toPosix(input))
  }
  return out.sort()
}

/**
 * 构建标识 = `wb-` + sha256(每个输入文件的 相对路径 + 内容哈希) 的前 16 位十六进制。
 * 纯函数（同输入同输出），所以 `tsdown.config.ts` 可以在编译期算出同一个值。
 */
export function computeBuildId(root = REPO_ROOT, deps = {}) {
  const read = deps.readFileSync ?? readFileSync
  const files = collectInputFiles(root, deps)
  const digest = createHash('sha256')
  for (const file of files) {
    const contentHash = createHash('sha256').update(read(join(root, file))).digest('hex')
    digest.update(`${file}:${contentHash}\n`)
  }
  return `wb-${digest.digest('hex').slice(0, 16)}`
}

export function readPackageMeta(root = REPO_ROOT, deps = {}) {
  const read = deps.readFileSync ?? readFileSync
  try {
    const pkg = JSON.parse(read(join(root, 'package.json'), 'utf8'))
    return { name: pkg.name, version: pkg.version }
  } catch { return { name: 'unknown', version: 'unknown' } }
}

/** 写 `lib/build-info.json`（构建脚本在 tsc/tsdown **之前**调用它）。 */
export function writeBuildInfo(options = {}) {
  const root = options.root ?? REPO_ROOT
  const outPath = join(root, options.out ?? BUILD_INFO_RELATIVE)
  const files = collectInputFiles(root, options)
  const buildId = computeBuildId(root, options)
  const meta = readPackageMeta(root, options)
  const payload = {
    name: meta.name,
    version: meta.version,
    buildId,
    algorithm: 'sha256(相对路径+内容哈希) 前 16 位，不含时间戳',
    inputs: files.length,
    generatedAt: (options.now ?? new Date()).toISOString(),
  }
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return { ...payload, path: outPath, files }
}

/** 读构建标识（health 路由、链、测试共用同一份读取语义）。 */
export function readBuildId(root = REPO_ROOT, deps = {}) {
  const read = deps.readFileSync ?? readFileSync
  try {
    const parsed = JSON.parse(read(join(root, BUILD_INFO_RELATIVE), 'utf8'))
    return typeof parsed?.buildId === 'string' && parsed.buildId !== '' ? parsed.buildId : undefined
  } catch { return undefined }
}

const isMain = process.argv[1] !== undefined && join(process.argv[1]) === join(fileURLToPath(import.meta.url))
if (isMain) {
  const argv = process.argv.slice(2)
  const outIndex = argv.indexOf('--out')
  const result = writeBuildInfo(outIndex === -1 ? {} : { out: argv[outIndex + 1] })
  if (argv.includes('--json')) console.log(JSON.stringify({ buildId: result.buildId, version: result.version, inputs: result.inputs, path: result.path }, null, 2))
  else console.log(`buildId ${result.buildId}（${result.inputs} 个输入文件）→ ${toPosix(relative(REPO_ROOT, result.path))}`)
}
