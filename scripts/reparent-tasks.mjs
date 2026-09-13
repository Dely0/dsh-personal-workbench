/**
 * 把已有任务挂到指定父任务下（重新挂载 / re-parent）。
 *
 * ## ⚠️ 已被 v1.14.0 取代 —— 正常情况下不要再用它
 *
 * v1.14.0 起工作台**已有「改父任务」这条一等公民路径**，任一方式都比改库好：
 * - 界面：任务详情 → 编辑 → 「父任务」选择项（候选自动排除自身与后代）；
 * - 工具：`workbench_update_task({ task_id, parent_id })` 或 `parent_title`；
 * - HTTP：`PATCH /api/workbench/tasks/:id` body `{ "parentId": "<id>" | null }`（null = 顶层）。
 *
 * 上面三条都带**防环校验**（repo 层 `updateTask` + `isDescendantOf`）并写 `reparented`
 * 事件（任务详情「记录」页签显示「调整父任务 · 父任务：A → B」）。
 *
 * 保留本脚本的唯一用途是**救援**：数据库里的结构已经脏到 API 走不通
 * （例如已存在环、任务挂在已删除的父 id 下），需要绕过服务层直接修。
 * 这种情况下它仍然有用，但请注意下面这条历史限制。
 *
 * 历史限制（只在直接用本脚本时成立）：直接改库**会绕过 `task_events`**，
 * 重组不会出现在任务详情的「记录」页签里。因救援而用它时请手工补一条说明。
 *
 * 防护：WAL 安全快照备份 → 前置校验（父任务存在、被挂任务存在、环检测）
 *      → `BEGIN IMMEDIATE` 事务内 UPDATE → 回读校验 → 失败自动 ROLLBACK + 从备份恢复。
 *
 * 用法：
 *   node scripts/reparent-tasks.mjs --parent <父任务id> --tasks <id1,id2,...> [--dry-run]
 *   node scripts/reparent-tasks.mjs --parent <父任务id> --tasks <id1> --no-backup
 *
 * 选项：
 *   --dry-run    只校验与打印，不写入
 *   --no-backup  跳过备份（不推荐）
 *   --db <path>  指定数据库（默认 ~/.dsh/workbench/workbench.db）
 */

import { copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function parseArgs(argv) {
  const out = { dryRun: false, backup: true }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--dry-run') out.dryRun = true
    else if (flag === '--no-backup') out.backup = false
    else if (flag === '--parent') out.parent = argv[++index]
    else if (flag === '--tasks') out.tasks = String(argv[++index] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (flag === '--db') out.db = argv[++index]
  }
  return out
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

const args = parseArgs(process.argv.slice(2))
if (args.parent === undefined || args.tasks === undefined || args.tasks.length === 0) {
  console.error('用法: node scripts/reparent-tasks.mjs --parent <父任务id> --tasks <id1,id2,...> [--dry-run]')
  process.exit(2)
}

const dbPath = args.db ?? join(homedir(), '.dsh', 'workbench', 'workbench.db')
if (!existsSync(dbPath)) {
  console.error(`✗ 数据库不存在: ${dbPath}`)
  process.exit(1)
}

console.log(`数据库: ${dbPath}`)
console.log(`模式  : ${args.dryRun ? 'DRY-RUN（不写入）' : '实际写入'}`)
console.log('')

// ---------- 1. 备份（WAL 模式下用 sqlite backup API 才是一致快照） ----------
let backupPath
if (!args.dryRun && args.backup) {
  backupPath = `${dbPath}.bak-reparent-${stamp()}`
  const source = new DatabaseSync(dbPath, { readOnly: true })
  const target = new DatabaseSync(backupPath)
  source.backup(target)
  target.close()
  source.close()
  console.log(`✓ 已备份: ${basename(backupPath)}`)
}

// ---------- 2. 前置校验 ----------
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON')

const parent = db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(args.parent)
if (parent === undefined) {
  console.error(`✗ 父任务 ${args.parent} 不存在，中止`)
  db.close()
  process.exit(1)
}
console.log(`✓ 父任务: ${parent.title}`)

for (const taskId of args.tasks) {
  const row = db.prepare('SELECT id, title, parent_id FROM tasks WHERE id = ?').get(taskId)
  if (row === undefined) {
    console.error(`✗ 任务 ${taskId} 不存在，中止`)
    db.close()
    process.exit(1)
  }
  console.log(`  待挂载: ${String(row.title).slice(0, 46)}  (当前 parent_id=${row.parent_id ?? 'null'})`)
}

// 环检测：被挂载任务的子树里不能含有父任务
for (const taskId of args.tasks) {
  const stack = [taskId]
  const seen = new Set()
  while (stack.length > 0) {
    const cursor = stack.pop()
    if (seen.has(cursor)) continue
    seen.add(cursor)
    if (cursor === args.parent) {
      console.error(`✗ 挂载 ${taskId} 会形成环（其子树含父任务），中止`)
      db.close()
      process.exit(1)
    }
    for (const child of db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(cursor)) {
      stack.push(child.id)
    }
  }
}
console.log('✓ 环检测通过')

if (args.dryRun) {
  console.log('')
  console.log('DRY-RUN 结束，未写入任何内容。')
  db.close()
  process.exit(0)
}

// ---------- 3. 事务内写入 + 回读校验 ----------
const update = db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?')
try {
  db.exec('BEGIN IMMEDIATE')
  for (const taskId of args.tasks) update.run(args.parent, taskId)
  for (const taskId of args.tasks) {
    const got = db.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(taskId).parent_id
    if (got !== args.parent) throw new Error(`回读不一致: ${taskId} -> ${got}，期望 ${args.parent}`)
  }
  db.exec('COMMIT')
  console.log('✓ 写入并回读校验通过')
} catch (error) {
  db.exec('ROLLBACK')
  db.close()
  console.error(`✗ 失败已回滚: ${error}`)
  if (backupPath !== undefined) {
    copyFileSync(backupPath, dbPath)
    console.error(`  已从备份恢复: ${basename(backupPath)}`)
  }
  process.exit(1)
}

// ---------- 4. 终态 ----------
console.log('')
console.log('=== 父任务现在的子任务 ===')
for (const row of db.prepare('SELECT title, status_code FROM tasks WHERE parent_id = ? ORDER BY created_at').all(args.parent)) {
  console.log(`  - ${String(row.title).slice(0, 52)}  [${row.status_code}]`)
}
const total = db.prepare('SELECT count(*) AS n FROM tasks WHERE parent_id = ?').get(args.parent).n
console.log(`  共 ${total} 个子任务`)
db.close()
console.log('')
console.log('⚠️ 直接改库绕过了事件日志：这次重组不会出现在任务详情的「记录」页签。')
if (backupPath !== undefined) console.log(`如需回滚: copy "${backupPath}" "${dbPath}"`)
