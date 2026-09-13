/**
 * 防「装盘版本与声明版本不一致」门禁。
 *
 * 2026-09-12 真实事故：`dsh plugin add` 是 pnpm 转发器，会按 pnpm-lock.yaml
 * 对齐**整个** profile —— 装一个无关插件时把工作台从 1.13.3 回退成 1.12.1。
 * 而库已被 1.13.3 迁到 schema 15，1.12.1 只支持到 14 → migrate() 抛错 →
 * 整个 DSH 拒绝启动。
 *
 * 这道门禁只能在**装插件之后、重启之前**跑，作用是在重启前抓住"装盘版本
 * 落后于 profile 声明的版本 / 落后于数据库 schema"这类不一致。
 *
 * 跑法（在 profile 目录下即可）：
 *   node D:/Code/Linksight/dsh-workbench/scripts/check-installed-version.mjs
 *
 * 退出码：0 = 一致；1 = 发现不一致或有风险。
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const PLUGIN = '@dely0/dsh-personal-workbench'

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** "1.13.3" / "^1.13.3" / "1.13.3" → 数值数组，便于比较。 */
function parseVersion(raw) {
  const match = String(raw ?? '').match(/(\d+)\.(\d+)\.(\d+)/)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

const profileDir = process.env.WORKBENCH_PROFILE_DIR
  ?? join(homedir(), '.dsh', 'profiles', 'web')

const problems = []
const notes = []

// 1) 装盘版本
const installedPath = join(profileDir, 'node_modules', ...PLUGIN.split('/'), 'package.json')
const installedPkg = readJson(installedPath)
if (installedPkg === undefined) {
  problems.push(`装盘找不到 ${PLUGIN}：${installedPath}`)
} else {
  notes.push(`装盘版本      : ${installedPkg.version}`)
}

// 2) profile 声明版本
const profilePkg = readJson(join(profileDir, 'package.json'))
const declared = profilePkg?.dependencies?.[PLUGIN]
if (declared === undefined) {
  problems.push(`profile ${join(profileDir, 'package.json')} 未声明 ${PLUGIN}`)
} else {
  notes.push(`profile 声明  : ${declared}`)
}

// 3) 锁文件里的版本（pnpm 实际会对齐到它）
const lockPath = join(profileDir, 'pnpm-lock.yaml')
let locked
if (existsSync(lockPath)) {
  const lock = readFileSync(lockPath, 'utf8')
  const match = lock.match(new RegExp(`'?${PLUGIN.replace('/', '\\/')}@(\\d+\\.\\d+\\.\\d+)'?:`))
  locked = match?.[1]
  notes.push(`锁文件解析为  : ${locked ?? '(未找到)'}`)
}

// 4) 数据库 schema 与插件支持的 schema
const dbPath = join(homedir(), '.dsh', 'workbench', 'workbench.db')
let dbVersion
if (existsSync(dbPath)) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    dbVersion = row === undefined ? 0 : Number(row.value)
    db.close()
    notes.push(`数据库 schema : ${dbVersion}`)
  } catch (error) {
    problems.push(`读取数据库失败：${String(error)}`)
  }
} else {
  notes.push('数据库        : (不存在，首次启动会新建)')
}

const installedSchemaPath = join(profileDir, 'node_modules', ...PLUGIN.split('/'), 'lib', 'db', 'schema.js')
if (existsSync(installedSchemaPath)) {
  const match = readFileSync(installedSchemaPath, 'utf8').match(/SCHEMA_VERSION\s*=\s*(\d+)/)
  const installedSchema = match === undefined ? undefined : Number(match[1])
  notes.push(`插件支持 schema: ${installedSchema ?? '(未找到)'}`)

  // 核心判定：数据库比装盘插件新 → 下一次重启必然启动失败。
  if (dbVersion !== undefined && installedSchema !== undefined && dbVersion > installedSchema) {
    problems.push(
      `数据库 schema ${dbVersion} 比装盘插件支持的 ${installedSchema} 新 —— 重启会直接启动失败（宿主拒绝启动）。`
      + ` 修复：dsh plugin --profile web add ${PLUGIN}@<与 schema ${dbVersion} 匹配的版本>`,
    )
  }
} else {
  problems.push(`装盘缺少 ${installedSchemaPath}`)
}

// 5) 装盘 / 声明 / 锁文件三者一致性（回退的典型指纹）
const installedVersion = parseVersion(installedPkg?.version)
const lockedVersion = parseVersion(locked)
if (installedVersion !== undefined && lockedVersion !== undefined && compare(installedVersion, lockedVersion) !== 0) {
  problems.push(`装盘版本 ${installedPkg.version} 与锁文件 ${locked} 不一致 —— 下次装任何插件都会被拉回锁文件版本。`)
}

console.log('=== 工作台版本一致性检查 ===')
for (const note of notes) console.log(`  ${note}`)

if (problems.length === 0) {
  console.log('  ✅ 一致，可以安全重启')
  process.exit(0)
}

console.log('')
for (const problem of problems) console.log(`  ✖ ${problem}`)
process.exit(1)
