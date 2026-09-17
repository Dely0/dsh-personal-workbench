/**
 * 一次性排查脚本（只读）：把库里"用正文打补丁"的条目找出来（收尾② 的前置）。
 *
 * 背景：用户当时删掉一条写错的条目、新建一条修正条，两条并存期间只能靠正文里
 * 手写一句"本条修正已入库的另一条"来表达取代关系 —— P2 加了结构化字段，
 * 这条脚本负责**找出来并给出可核对的清单**（不写库）。
 *
 * ⚠️ **必须用只读连接**（`new DatabaseSync(path, { readOnly: true })`），不能用
 * `openWorkbenchDb()` —— 那个函数会**自动跑迁移**，拿它读线上库会把 schema 推高，
 * 而正在运行的插件版本还低，下次启动就会因为"schema 比它新"整体降级。
 * （这条注释是一次真实事故换来的：本脚本第一版就是这么把线上库推到 18 的。）
 *
 * 用法：node scripts/repro/find-supersede-candidates.mjs [--db <path>]
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const index = args.indexOf('--db')
const source = index >= 0 && args[index + 1] !== undefined
  ? args[index + 1]
  : join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(source)) { console.error(`找不到工作台库 ${source}`); process.exit(2) }

const db = new DatabaseSync(source, { readOnly: true })
const hasColumn = db.prepare('PRAGMA table_info(knowledge_entries)').all().some((row) => String(row.name) === 'superseded_by_id')
const rows = db.prepare(`
  SELECT id, title, content_md, ${hasColumn ? 'superseded_by_id' : 'NULL AS superseded_by_id'}, ${hasColumn ? 'valid_until' : 'NULL AS valid_until'}, updated_at
  FROM knowledge_entries
  ORDER BY updated_at DESC
`).all()

const KEYWORDS = ['本条修正', '修正已入库', '已被取代', '取代了', '本条已被', '以本条为准', '作废']
const flagged = []
for (const row of rows) {
  const body = String(row.content_md ?? '')
  const hit = KEYWORDS.filter((word) => body.includes(word))
  if (hit.length === 0 && row.superseded_by_id === null) continue
  flagged.push({ ...row, hit })
}

console.log(`知识库共 ${rows.length} 条；疑似"用正文打补丁"或已标注的 ${flagged.length} 条\n`)
for (const row of flagged) {
  console.log(`--- [${row.id}] ${row.title}`)
  console.log(`    更新 ${row.updated_at}｜superseded_by_id=${row.superseded_by_id ?? '（空）'}｜valid_until=${row.valid_until ?? '（空）'}`)
  if (row.hit.length > 0) {
    console.log(`    命中的补丁措辞：${row.hit.join('、')}`)
    const at = Math.max(...row.hit.map((word) => String(row.content_md).indexOf(word)))
    console.log(`    该句上下文：…${String(row.content_md).slice(Math.max(0, at - 60), at + 160).replace(/\s+/g, ' ')}…`)
  }
}
db.close()
