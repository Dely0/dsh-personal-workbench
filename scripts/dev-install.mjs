/**
 * 本地开发装盘：**不消耗公开版本号**地把当前构建装进 profile。
 *
 * ## 为什么要有它
 *
 * 2026-09-15 复盘：本地每验一次就 `package.json` +1，patch 号一路吃到 14.59
 * （`_local-archive/` 里 84 个 tgz 就是 84 次本地迭代），而公开版本号本应只在**发布**时增长。
 *
 * 逼出"每次 +1"的是那条老结论：「换了构建产物就必须换版本号」。实测（pnpm 11.7.0，
 * `node-linker=hoisted`，与 profile 同配置）之后，准确的机制是：
 *
 * | 做法 | 结果 |
 * |---|---|
 * | `dsh plugin add file:X.tgz` = `pnpm add file:X.tgz`（DSH 是 pnpm 原样转发器） | 内容变了**会**重新解包 ✅ |
 * | 覆盖 tarball 后只跑 `pnpm install` | **不会**刷新 ❌ |
 * | 覆盖 tarball 后 `pnpm install --frozen-lockfile` | **不会**刷新 ❌ |
 *
 * 也就是说"换版本号"从来不是刷新的**必要条件**；真正的坑是**用 `pnpm install` 顶替
 * `dsh plugin add`**，以及另一个独立陷阱——客户端 bundle 的 rev 缓存（必须重启宿主）。
 *
 * 本脚本更进一步：每次打包都落到**带构建戳的新路径**（`_local-build/…-dev-<hash>-<时间>.tgz`）。
 * profile 依赖的身份就是那个路径，所以路径一变必然重新解包 —— 不依赖 pnpm 是否重新 hash
 * 这个实现细节。于是：
 *
 * - `package.json.version` **只在发布时**改（下一个发布版本是 1.15.0）；
 * - 本地迭代用构建戳区分，历史包丢 `_local-archive/`；
 * - 依然保留"冻结副本"的安全属性（不像 `link:` 那样把 profile 绑死在开发树上）。
 *
 * ## 用法
 *
 * ```sh
 * node scripts/dev-install.mjs              # 只构建 + 打包 + 校验，打印命令，不动 profile
 * node scripts/dev-install.mjs --apply      # 真的装进 profile（自动备份 + diff + 跑门禁）
 * ```
 *
 * 选项：`--profile <name>`（默认 web）、`--no-build`、`--skip-dump-config`、`--keep <n>`。
 *
 * **本脚本绝不重启 DSH** —— 重启会掐断用户正在用的会话，必须由用户明确发起。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1] ?? fallback
}

const APPLY = has('--apply')
const NO_BUILD = has('--no-build')
const SKIP_DUMP = has('--skip-dump-config')
const PROFILE = valueOf('--profile', 'web')
const KEEP = Number(valueOf('--keep', '3'))
const DEV_DIR = join(ROOT, '_local-build')
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', PROFILE)

const step = (n, text) => console.log(`\n[${n}] ${text}`)
const fail = (text) => { console.error(`\n✖ ${text}`); process.exit(1) }

function run(command, options = {}) {
  return execFileSync(command, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
}
function runVisible(command, env) {
  const result = spawnSync(command, { encoding: 'utf8', shell: true, stdio: 'inherit', env: { ...process.env, ...env } })
  return result.status ?? 1
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const PLUGIN = pkg.name

// ── 1. 构建 ────────────────────────────────────────────────────────────────
step(1, NO_BUILD ? '跳过构建（--no-build）' : '构建 lib/')
if (!NO_BUILD) {
  try { runVisible('pnpm build', undefined) === 0 || fail('pnpm build 失败') } catch (error) { fail(`pnpm build 失败：${String(error)}`) }
}

// ── 2. 打包到带构建戳的新路径 ──────────────────────────────────────────────
step(2, '打包（构建戳路径 = profile 依赖的新身份）')
mkdirSync(DEV_DIR, { recursive: true })
let commit = 'nogit'
try { commit = run('git rev-parse --short HEAD', { cwd: ROOT }).trim() } catch { /* 无 git 也不阻塞 */ }
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
const tgzName = `${PLUGIN.split('/').pop()}-dev-${commit}-${stamp}.tgz`
const staging = join(DEV_DIR, '.staging')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
try {
  run(`pnpm pack --pack-destination "${staging}"`, { cwd: ROOT })
} catch (error) {
  fail(`pnpm pack 失败：${error.stderr ?? String(error)}`)
}
const packed = readdirSync(staging).find((file) => file.endsWith('.tgz'))
if (packed === undefined) fail(`打包目录里没有 tgz：${staging}`)
const tgzPath = join(DEV_DIR, tgzName)
renameSync(join(staging, packed), tgzPath)
rmSync(staging, { recursive: true, force: true })
console.log(`  ${tgzPath}`)
console.log(`  包内版本：${VERSION}（本地迭代不改它；发布时才动）`)

// ── 3. 校验这个包本身是好的 ────────────────────────────────────────────────
step(3, '校验包完好（scripts/check-tgz.mjs）')
try {
  console.log(run(`node "${join(ROOT, 'scripts', 'check-tgz.mjs')}" "${tgzPath}" ${VERSION}`, { cwd: ROOT }))
} catch (error) {
  fail(`包有问题：${error.stdout ?? ''}${error.stderr ?? ''}`)
}

/**
 * 一份"刚打出来的包"的稳定副本（`current.tgz` + `current.txt` 里记的路径）。
 *
 * ⚠️ 它**不是回退指针** —— 它是本次新包。回退目标只能来自"装盘前 profile 里的那条
 * `file:` 依赖"（见下面 `previousSpec` / `rollbackCommand`）。
 * 2026-09-17 的教训：把这里当回退指针写进提示，就会打印一条指向"刚装上的包"的空回退。
 */
const pointer = join(DEV_DIR, 'current.txt')
writeFileSync(pointer, `${tgzPath}\n`, 'utf8')
copyFileSync(tgzPath, join(DEV_DIR, 'current.tgz'))

/**
 * profile 的 package.json 里当前指着的那个开发包（绝对路径 → 文件名）。
 *
 * 为什么要它：pnpm 在装**任何别的插件**时都会重新对齐整个 profile，
 * 届时这条 `file:` 依赖必须仍然存在，否则装别的插件会连带失败。
 * 所以清理旧包时，正在被指着的那一个**永远不删**。
 */
function referencedDevPackage() {
  try {
    const deps = JSON.parse(readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8')).dependencies ?? {}
    const match = /file:(.+)$/.exec(String(deps[PLUGIN] ?? ''))
    return match === null ? null : basename(match[1].split('\\').join('/'))
  } catch {
    return null
  }
}

// 只保留最近 KEEP 个开发包（其余历史包请手工归到 _local-archive/）
const referenced = referencedDevPackage()
const devTgz = readdirSync(DEV_DIR).filter((file) => /-dev-.*\.tgz$/.test(file))
/**
 * ⚠️ 两个必须守住的点（2026-09-17 真实踩坑："清理旧开发包"把**刚打好的包**删了，
 * 紧接着的 `dsh plugin add` 报 ENOENT，profile 已被改回去，白跑一轮）：
 *
 * 1. **本次产物绝不在清理范围内** —— 它是下一步要装的东西；
 * 2. 排序按**文件 mtime**而不是文件名：文件名里的时间戳是 `yyyyMMdd-HHmmss`，
 *    但"旧"是和**上一个**包比出来的，用字典序排会在跨构建戳时判错
 *    （实测 `…-20260916-232749` 与 `…-20260917-102248` 的顺序把新包排成了"最旧"）。
 */
const staleCandidates = devTgz
  .filter((file) => join(DEV_DIR, file) !== tgzPath)
  .map((file) => ({ file, mtime: statSync(join(DEV_DIR, file)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
for (const { file: stale } of staleCandidates.slice(KEEP)) {
  if (stale === referenced) {
    console.log(`  （保留 ${stale}：profile 当前指着它，删了会让装别的插件失败）`)
    continue
  }
  rmSync(join(DEV_DIR, stale), { force: true })
  console.log(`  （清理旧开发包 ${stale}）`)
}

const addCommand = `dsh plugin --profile ${PROFILE} add file:${tgzPath.split('\\').join('/')}`

// ── 4. 装进 profile（仅 --apply）──────────────────────────────────────────
if (!APPLY) {
  step(4, 'dry-run：没有改 profile')
  console.log(`  要真的装盘，执行下面任一条：\n`)
  console.log(`    node scripts/dev-install.mjs --apply --profile ${PROFILE}`)
  console.log(`    ${addCommand}\n`)
  console.log('  改完记得重启 dsh web 才生效 —— 重启由你决定（会掐断当前 GUI 会话）。')
  process.exit(0)
}

step(4, `装进 profile：${PROFILE_DIR}`)
const profilePkgPath = join(PROFILE_DIR, 'package.json')
const profileLockPath = join(PROFILE_DIR, 'pnpm-lock.yaml')
const backupStamp = stamp
// 全新 profile（第一次用）：没有既有依赖可保护，也没有 lockfile —— 跳过备份与 diff。
const freshProfile = !existsSync(profilePkgPath)
if (freshProfile) {
  console.log('  全新 profile：没有既有依赖需要保护，跳过备份与 diff')
} else {
  for (const [source, target] of [
    [profilePkgPath, `${profilePkgPath}.bak-devinstall-${backupStamp}`],
    [profileLockPath, `${profileLockPath}.bak-devinstall-${backupStamp}`],
  ]) {
    if (!existsSync(source)) { console.log(`  （没有 ${basename(source)}，跳过）`); continue }
    copyFileSync(source, target)
    console.log(`  备份 ${basename(source)} → ${basename(target)}`)
  }
}
const beforeDeps = freshProfile ? {} : JSON.parse(readFileSync(profilePkgPath, 'utf8')).dependencies ?? {}

/**
 * 顶层 node_modules 里各依赖**已装**的版本 —— 用来抓"装一个插件把别的插件静默回退"。
 *
 * 2026-09-12 的真实事故就是这个形态：`dsh plugin add` 按 pnpm-lock.yaml 重新对齐**整个**
 * profile，把工作台从 1.13.3 静默回退成 1.12.1；package.json 上看不出任何变化。
 * 所以只比对 package.json 抓不到它 —— 这里直接读装盘产物的版本。
 */
function installedVersions(names) {
  const out = {}
  for (const name of names) {
    try {
      out[name] = JSON.parse(readFileSync(join(PROFILE_DIR, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version
    } catch {
      out[name] = '(未装)'
    }
  }
  return out
}

const beforeInstalled = installedVersions(Object.keys(beforeDeps))

/**
 * 回退目标 = **装盘前** profile 里指向的那个包（不是刚打好的这个）。
 *
 * 2026-09-17 实测踩到：`current.txt` 是在装盘**之前**就被写的（写的是本次新包），
 * 于是脚本末尾那句"回退：…"打印出来的命令**指向刚装上的包** —— 一条什么都不做的回退提示。
 * 真出问题要回退时，照它敲一遍等于原地不动。回退指针只能来自"装之前的样子"。
 */
const previousSpec = typeof beforeDeps[PLUGIN] === 'string' ? beforeDeps[PLUGIN] : null
const rollbackCommand = previousSpec !== null
  ? `dsh plugin --profile ${PROFILE} add ${previousSpec}`
  : `（此前 profile 未声明本插件）恢复 ${profilePkgPath}.bak-devinstall-${backupStamp} 后 pnpm install`

const status = runVisible(addCommand)
if (status !== 0) fail(`dsh plugin add 退出码 ${status} —— profile 可能已被改动，用上面的 .bak 回退`)

// ── 5. 写盘后复检：只允许目标插件这一处变化 + 不能有 BOM ────────────────────
step(5, '写盘后复检：零增量 diff + 编码（BOM 会让 DSH 整个起不来）')
const head = readFileSync(profilePkgPath).subarray(0, 3)
if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
  fail(`profile package.json 被写成了 UTF-8 BOM —— Node 的 JSON.parse 会直接抛错、GUI 也进不去。`
    + ` 处理：去掉头 3 字节（正文保留），或恢复 ${profilePkgPath}.bak-devinstall-${backupStamp}`)
}
console.log('  ✅ package.json 无 BOM')

const afterDeps = JSON.parse(readFileSync(profilePkgPath, 'utf8')).dependencies ?? {}
const problems = []
for (const [name, spec] of Object.entries(beforeDeps)) {
  if (name === PLUGIN) continue
  if (afterDeps[name] !== spec) problems.push(`无关插件被改了：${name}  ${spec} → ${afterDeps[name]}`)
}
for (const name of Object.keys(afterDeps)) {
  if (name !== PLUGIN && beforeDeps[name] === undefined) problems.push(`凭空多出依赖：${name}@${afterDeps[name]}`)
}
const ours = afterDeps[PLUGIN]
if (ours === undefined || !String(ours).includes(tgzName)) problems.push(`${PLUGIN} 没有指向本次的开发包：${ours}`)
if (problems.length > 0) {
  for (const problem of problems) console.error(`  ✖ ${problem}`)
  fail(`diff 不干净（备份在 ${profilePkgPath}.bak-devinstall-${backupStamp}）—— 先别重启`)
}
if (freshProfile) console.log(`  ✅ ${PLUGIN} → ${ours}`)
else console.log(`  ✅ 只有 ${PLUGIN} 从 ${beforeDeps[PLUGIN] ?? '(未声明)'} 变成 ${ours}`)

// 连带回退检查：别的插件版本一个都不许变
const afterInstalled = installedVersions(Object.keys(afterDeps))
const collateral = []
for (const name of Object.keys(afterDeps)) {
  if (name === PLUGIN) continue
  const was = beforeInstalled[name]
  if (was !== undefined && was !== afterInstalled[name]) collateral.push(`${name}  ${was} → ${afterInstalled[name]}`)
}
if (collateral.length > 0) {
  for (const line of collateral) console.error(`  ✖ 别的插件被连带改动：${line}`)
  fail(`装盘连带改动了别的插件（静默回退的典型指纹）—— 先别重启，用 .bak-devinstall-${backupStamp} 回退`)
}
if (!freshProfile) console.log(`  ✅ 其余 ${Object.keys(afterDeps).length - 1} 个插件的装盘版本均未变`)

// ── 6. 三道门禁（必须在重启之前跑）────────────────────────────────────────
step(6, '门禁：指纹 / 版本一致性 / 插件树能否组装')
const env = { DSH_PROFILE_DIR: PROFILE_DIR, WORKBENCH_PROFILE_DIR: PROFILE_DIR }
for (const [label, command] of [
  ['装盘指纹（唯一可信判据）', `node "${join(ROOT, 'scripts', 'check-installed-fingerprint.mjs')}"`],
  ['版本一致性', `node "${join(ROOT, 'scripts', 'check-installed-version.mjs')}"`],
]) {
  console.log(`\n  ── ${label}`)
  if (runVisible(command, env) !== 0) fail(`${label} 没过 —— 先别重启，按上面的提示修`)
}

if (!SKIP_DUMP) {
  console.log('\n  ── 插件树组装（dsh --dump-config）')
  if (runVisible(`dsh --profile ${PROFILE} --dump-config`, undefined) !== 0) fail('插件树组装失败 —— 先别重启')
}

step(7, '全部通过')
console.log(`  备份：${profilePkgPath}.bak-devinstall-${backupStamp}`)
console.log(`  装上了：${ours}`)
console.log(`  回退：${rollbackCommand}`)
console.log('  下一步：由你决定何时重启 `dsh web`（重启后硬刷新页面，客户端 bundle 有缓存）。')
