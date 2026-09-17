/**
 * 反向前置 #5：长会话（>200 行召回日志）里，**最旧那行**上带出的条目也必须能被回填引用。
 *
 * 有缺陷时退出码非零：`citeRecallLog` 只扫 `ORDER BY id DESC LIMIT 200`，
 * 更早的行永远拿不到引用 —— 模型回报后 `updated` 可能为 0，工具话术还会说
 * "没有匹配到本会话的召回记录"，把"日志没扫到"说成"你没查过"。
 *
 * ⚠️ 断言必须落在**最旧那一行**上，否则会被"新行也有这个 id"糊弄过去
 * （独立审查者的同题探针就是这么写成恒真的：只断言"至少有一行被标记"）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../../lib/db/database.js'
import { seedDictionaries } from '../../../lib/db/seed.js'
import { createKnowledge } from '../../../lib/db/repo.js'
import { KnowledgeRecallManager } from '../../../lib/knowledge-recall.js'
import { listRecallLog } from '../../../lib/knowledge-recall-log.js'

const dir = mkdtempSync(join(tmpdir(), 'wb-citecap-'))
const db = openWorkbenchDb({ dbPath: join(dir, 'w.db') })
seedDictionaries(db)

const entry = createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
const manager = new KnowledgeRecallManager(db, { log: () => {} })
const sid = 's-long'
manager.prefetch(sid, undefined, '盘符根目录')          // 第 1 行：带出了 entry
for (let i = 0; i < 250; i += 1) {                       // 再压 250 行（都不含 entry）
  manager.logSearch({ sessionId: sid, taskId: null, query: `无关噪声 ${i}`, terms: ['噪'], hits: [] })
}
const rows = listRecallLog(db, { sessionId: sid, limit: 500 })
const oldest = rows[rows.length - 1]
console.log(`召回日志共 ${rows.length} 行；最旧一行 id=${oldest.id}，带出的条目 = ${JSON.stringify(oldest.hits.map((h) => h.id.slice(0, 8)))}`)
if (oldest.hits.length === 0) { console.log('前置失败：最旧那行没有带出任何条目'); db.close(); rmSync(dir, { recursive: true, force: true }); process.exit(2) }

manager.reportUsage(sid, [entry.id])
const refreshed = listRecallLog(db, { sessionId: sid, limit: 500 })
const oldestCited = refreshed[refreshed.length - 1].citedIds
console.log(`回报引用后，最旧一行的 cited_ids = ${JSON.stringify(oldestCited.map((x) => x.slice(0, 8)))}`)
db.close()
rmSync(dir, { recursive: true, force: true })
if (!oldestCited.includes(entry.id)) {
  console.log('FAIL: 最旧那行的引用被静默丢弃（只扫最近 200 行）')
  process.exit(1)
}
console.log('ok: 最旧那行的引用也回填了')
