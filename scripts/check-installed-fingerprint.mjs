/**
 * 校验「装盘产物 == 当前开发树构建产物」（逐文件指纹比对）。
 *
 * ## 为什么需要这个脚本
 *
 * 2026-09-12 我连续踩了两次同一个坑：`pnpm build && pnpm pack && dsh plugin add <tgz>`
 * 之后，profile 的 `node_modules` 里**仍是旧代码**，于是"修完再验"验的一直是旧包，
 * 白白多花了几轮。原因：
 *
 * 1. pnpm 的 store 按**包名+版本号**做内容寻址。同名同版本的 tarball 即使内容变了，
 *    也可能直接复用 store 里的旧副本（实测 `--force` 也无效）；
 * 2. Windows 上解包会保留 mtime，所以**看文件时间戳完全判断不出来**。
 *
 * 结论：**改代码后必须换版本号**，并且用内容指纹确认装盘成功。
 * 这个脚本把第 2 步做成一条命令，避免再靠肉眼。
 *
 * 用法：
 *   node scripts/check-installed-fingerprint.mjs
 *   node scripts/check-installed-fingerprint.mjs --json
 *
 * 退出码：0 = 一致；1 = 不一致（会把有差异的文件列出来）。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROFILE = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web')
const DEV = join(ROOT, 'lib')
const INSTALLED = join(PROFILE, 'node_modules', '@dely0', 'dsh-personal-workbench', 'lib')

const json = process.argv.includes('--json')

/** 递归列出目录下的文件（相对路径，统一用 /）。 */
function listFiles(dir, base = dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

const report = { dev: {}, installed: {}, missing: [], extra: [], differing: [] }
for (const file of listFiles(DEV)) report.dev[file] = sha(join(DEV, file))
for (const file of listFiles(INSTALLED)) report.installed[file] = sha(join(INSTALLED, file))

for (const [file, hash] of Object.entries(report.dev)) {
  const other = report.installed[file]
  if (other === undefined) report.missing.push(file)
  else if (other !== hash) report.differing.push(file)
}
for (const file of Object.keys(report.installed)) {
  if (report.dev[file] === undefined) report.extra.push(file)
}

// package.json 的版本也要对上（否则 profile 声明与实际不符）
let devVersion = 'unknown'
let installedVersion = 'unknown'
try { devVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version } catch { /* ignore */ }
try {
  installedVersion = JSON.parse(readFileSync(join(PROFILE, 'node_modules', '@dely0', 'dsh-personal-workbench', 'package.json'), 'utf8')).version
} catch { /* ignore */ }

const consistent = report.missing.length === 0 && report.differing.length === 0 && devVersion === installedVersion

if (json) {
  console.log(JSON.stringify({ consistent, devVersion, installedVersion, ...report }, null, 2))
} else {
  console.log('=== 装盘指纹校验（开发树 lib/ vs profile node_modules）===')
  console.log(`  开发树版本    : ${devVersion}`)
  console.log(`  装盘版本      : ${installedVersion}`)
  console.log(`  开发树文件数  : ${Object.keys(report.dev).length}`)
  console.log(`  装盘文件数    : ${Object.keys(report.installed).length}`)
  if (report.missing.length > 0) console.log(`  ❌ 装盘缺失    : ${report.missing.join(', ')}`)
  if (report.differing.length > 0) console.log(`  ❌ 内容不一致  : ${report.differing.join(', ')}`)
  if (report.extra.length > 0) console.log(`  ℹ️ 装盘多出    : ${report.extra.join(', ')}`)
  if (consistent) console.log('  ✅ 装盘产物与当前构建**逐文件一致**')
  else {
    console.log('  ❌ 装盘产物不是当前构建 —— 很可能是「同版本号 tarball 被 pnpm 复用」')
    console.log('     修法：改 package.json 版本号 → pnpm build → pnpm pack → dsh plugin add <新 tgz>')
  }
}

process.exit(consistent ? 0 : 1)
