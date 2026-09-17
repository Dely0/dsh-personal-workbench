/**
 * 把"用正文打补丁"的取代关系**结构化成 `supersededById`**（P2 + 收尾②）。
 *
 * ## 为什么需要它
 *
 * 用户当时的做法是：删掉一条写错的条目、新建一条修正条，在正文里手写一句
 * "请以本条为准，那条可以删掉"。两句并存期间召回会把两条都带出来，
 * 模型没有任何**结构化**信号判断该信哪条 —— 只能靠它读正文时"碰巧注意到"。
 *
 * P2 给条目加了 `supersededById` / `validUntil`：被标注的条目在召回时**压制**。
 * 这个脚本负责把已经写进正文的关系补成字段。
 *
 * ## 安全边界（都写成守卫，不靠"我会小心"）
 *
 * 1. **默认 dry-run**：不加 `--apply` 只打印将要做什么，一个字都不写；
 * 2. `--apply` 前**强制备份**（`<db>.bak-<时间戳>`），备份失败就中止；
 * 3. 先校验两条 id 都存在、且**不是同一条**（自己取代自己会让它永久消失）；
 * 4. 校验库里**已经有** `superseded_by_id` 列 —— 没有就说明当前装盘版本还不是 v1.15.7
 *    （schema 18）。此时**不自己 ALTER**：手工加列会让正在运行的旧插件读到
 *    "schema 比它新" 而整体降级。正确顺序是先装盘新版本（迁移到 18），再跑本脚本。
 * 5. 结果用**一次真实召回**复验：被取代的那条必须不再出现。
 *
 * 用法：
 *   node scripts/knowledge-supersede.mjs --old <被取代的id> --by <取代它的id>            # 预演
 *   node scripts/knowledge-supersede.mjs --old <被取代的id> --by <取代它的id> --apply    # 真写
 *   node scripts/knowledge-supersede.mjs --list                                        # 找候选
 */
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openWorkbenchDb } from '../lib/db/database.js'
import { getKnowledge, updateKnowledge } from '../lib/db/repo.js'
import { KnowledgeRecallManager } from '../lib/knowledge-recall.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] !== undefined && !args[index + 1].startsWith('--') ? args[index + 1] : true) : undefined
}
const DB = typeof flag('--db') === 'string' ? flag('--db') : join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(DB)) { console.error(`找不到工作台库 ${DB}`); process.exit(2) }

const REQUIRED_SCHEMA = 18

/**
 * 前置：库里必须是**已经迁移过**的 schema 18。
 *
 * ⚠️ 判断必须用**原始连接**读 `meta.schema_version`，不能在 `openWorkbenchDb` 之后判 ——
 * 那个函数自己会跑迁移，等它跑完这里永远是 18，守卫就成了摆设（"看起来有守卫、实际没有"
 * 正是本仓最忌讳的一类）。而且**必须**先判：本脚本一旦打开库就会把 schema 推到 18，
 * 而正在运行的旧插件（v17）下次启动会读到"schema 比它新"而整体降级 ——
 * 所以正确顺序永远是「先装盘 v1.15.7，再跑本脚本」。
 */
function rawSchemaVersion(path) {
  let raw
  try {
    raw = new DatabaseSync(path, { readOnly: true })
    const row = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    return row === undefined ? 0 : Number(row.value)
  } catch {
    return 0
  } finally {
    try { raw?.close() } catch { /* 关不掉不影响判断 */ }
  }
}

const version = rawSchemaVersion(DB)
if (version < REQUIRED_SCHEMA) {
  console.error(`✘ 这个库的 schema 版本是 ${version}，本脚本要求 ${REQUIRED_SCHEMA}（v1.15.7）。`)
  console.error('  正确顺序：先装盘新版本（打开库时自动迁移到 18），再跑本脚本。')
  console.error('  不自己 ALTER 的原因：手工加列/改版本号之后，正在运行的旧插件会读到"schema 比它新"而整体降级。')
  process.exit(3)
}

const db = openWorkbenchDb({ dbPath: DB })

if (flag('--list') !== undefined) {
  const rows = db.prepare('SELECT id, title, superseded_by_id FROM knowledge_entries ORDER BY updated_at DESC').all()
  console.log(`共 ${rows.length} 条：`)
  for (const row of rows) {
    if (row.superseded_by_id === null) continue
    console.log(`  [已被取代] ${row.id}  ${String(row.title).slice(0, 48)} → ${row.superseded_by_id}`)
  }
  console.log('（未标注的不列出；候选清单见 scripts/repro/find-supersede-candidates.mjs）')
  db.close()
  process.exit(0)
}

const oldId = typeof flag('--old') === 'string' ? flag('--old').trim() : ''
const byId = typeof flag('--by') === 'string' ? flag('--by').trim() : ''
if (oldId === '' || byId === '') {
  console.error('用法：--old <被取代的id> --by <取代它的id> [--apply] ｜ --list')
  db.close()
  process.exit(2)
}
if (oldId === byId) { console.error('✘ --old 与 --by 不能是同一条（自己取代自己会让它永久消失）'); db.close(); process.exit(2) }
const oldEntry = getKnowledge(db, oldId)
const byEntry = getKnowledge(db, byId)
if (oldEntry === undefined) { console.error(`✘ 找不到被取代的条目：${oldId}`); db.close(); process.exit(2) }
if (byEntry === undefined) { console.error(`✘ 找不到取代它的条目：${byId}`); db.close(); process.exit(2) }

console.log('被取代：', `[${oldEntry.id}] ${oldEntry.title}`)
console.log('取代它的：', `[${byEntry.id}] ${byEntry.title}`)
console.log('当前标注：', oldEntry.supersededById ?? '（空）')

const manager = new KnowledgeRecallManager(db, { log: () => {} })
const probeQuery = oldEntry.title.replace(/[《》【】：:（）()]/g, ' ').slice(0, 24)
const before = manager.recallToText({ taskId: null, query: probeQuery })
console.log(`\n预演召回「${probeQuery}」：命中 ${before.hits.length} 条，其中被取代那条${before.hits.some((hit) => hit.id === oldId) ? '**在**命中里' : '不在命中里'}；压制 ${before.droppedAsSuperseded} 条`)

if (flag('--apply') !== true) {
  console.log('\n（dry-run：什么都没写。加 --apply 才会真正落库，落库前会自动备份）')
  db.close()
  process.exit(0)
}

const backup = `${DB}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
try {
  copyFileSync(DB, backup)
  console.log(`\n已备份 → ${backup}`)
} catch (error) {
  console.error(`✘ 备份失败，已中止（不写库）：${error instanceof Error ? error.message : String(error)}`)
  db.close()
  process.exit(1)
}

updateKnowledge(db, oldId, { supersededById: byId })
manager.invalidate()
const after = manager.recallToText({ taskId: null, query: probeQuery })
const stillThere = after.hits.some((hit) => hit.id === oldId)
console.log(`写入完成。复验召回「${probeQuery}」：命中 ${after.hits.length} 条，压制 ${after.droppedAsSuperseded} 条，被取代那条${stillThere ? '**仍在命中里 ✘**' : '已不再出现 ✔'}`)
if (stillThere) {
  console.error('✘ 复验失败：被取代的条目仍被召回 —— 请检查实现或回滚备份。')
  db.close()
  process.exit(1)
}
console.log('（回滚方式：关闭插件进程后用备份文件覆盖回去）')
db.close()
