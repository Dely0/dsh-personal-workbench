/**
 * ⚠️ 事故修复：把线上库**回退**到 schema 17。
 *
 * 起因：我为排查"用正文打补丁的条目"跑了一个诊断脚本，它用 `openWorkbenchDb()` 打开了
 * **线上库** —— 那个函数会**自动跑迁移**，于是线上库被推到了 schema 18，
 * 而正在运行的插件还是 v17：下次重启它会读到"schema 比它新"而进入降级模式
 * （不注册路由/工具，只留一条 systemPrompt 告警）。
 *
 * 修法：把两列与索引删掉、`meta.schema_version` 改回 17。
 * 这样旧插件（17 == 17）与新插件（装盘后迁移 18 会正常加列）**两边都对**。
 *
 * 用法：node scripts/repro/rollback-live-schema.mjs            # 预演
 *       node scripts/repro/rollback-live-schema.mjs --apply    # 真回退（先备份）
 */
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const index = args.indexOf('--db')
const DB = index >= 0 && args[index + 1] !== undefined
  ? args[index + 1]
  : join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(DB)) { console.error(`找不到库 ${DB}`); process.exit(2) }

const db = new DatabaseSync(DB)
const read = (sql) => db.prepare(sql).get()
const columns = db.prepare('PRAGMA table_info(knowledge_entries)').all().map((row) => String(row.name))
const version = Number(read("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? 0)
const count = Number(read('SELECT COUNT(*) AS c FROM knowledge_entries').c)
console.log(`库：${DB}`)
console.log(`当前 schema_version=${version}；知识条目 ${count} 条；两列${columns.includes('superseded_by_id') ? '**存在**' : '不存在'}`)

if (version <= 17 && !columns.includes('superseded_by_id')) {
  console.log('已经是 17 且没有那两列 —— 不需要回退。')
  db.close()
  process.exit(0)
}

if (args.includes('--apply') !== true) {
  console.log('\n（预演）将会执行：DROP INDEX idx_knowledge_superseded；DROP COLUMN superseded_by_id / valid_until；schema_version ← 17')
  console.log('加 --apply 才会真正执行（执行前自动备份）。')
  db.close()
  process.exit(0)
}

const backup = `${DB}.bak-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`
copyFileSync(DB, backup)
console.log(`\n已备份 → ${backup}`)

db.exec('BEGIN')
try {
  if (columns.includes('superseded_by_id')) {
    db.exec('DROP INDEX IF EXISTS idx_knowledge_superseded')
    db.exec('ALTER TABLE knowledge_entries DROP COLUMN superseded_by_id')
  }
  if (columns.includes('valid_until')) db.exec('ALTER TABLE knowledge_entries DROP COLUMN valid_until')
  db.prepare("UPDATE meta SET value = '17' WHERE key = 'schema_version'").run()
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  console.error(`✘ 回退失败（已回滚，库未改）：${error instanceof Error ? error.message : String(error)}`)
  db.close()
  process.exit(1)
}

const nowColumns = db.prepare('PRAGMA table_info(knowledge_entries)').all().map((row) => String(row.name))
const nowVersion = Number(read("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? 0)
const nowCount = Number(read('SELECT COUNT(*) AS c FROM knowledge_entries').c)
console.log(`回退后：schema_version=${nowVersion}；两列${nowColumns.includes('superseded_by_id') ? '仍在 ✘' : '已删除 ✔'}；知识条目 ${nowCount} 条`)
db.close()
if (nowVersion !== 17 || nowColumns.includes('superseded_by_id') || nowCount !== count) {
  console.error('✘ 复验失败 —— 用备份文件覆盖回去。')
  process.exit(1)
}
console.log('✅ 回退完成（条目数未变；下次装盘 v1.15.7 时迁移 18 会正常加列）')
