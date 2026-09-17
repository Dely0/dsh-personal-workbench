/**
 * 反向前置 #3：知识库超过候选集上限时，不能"静默"少召回。
 * 有缺陷时退出码非零：523 条知识里只有 500 条进入候选集，且没有任何可观测信号。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../../lib/db/database.js'
import { seedDictionaries } from '../../../lib/db/seed.js'
import { createKnowledge } from '../../../lib/db/repo.js'
import { KnowledgeRecallManager } from '../../../lib/knowledge-recall.js'

const dir = mkdtempSync(join(tmpdir(), 'wb-ceiling-'))
const db = openWorkbenchDb({ dbPath: join(dir, 'w.db') })
seedDictionaries(db)

const TOTAL = 523
for (let i = 0; i < TOTAL; i += 1) {
  createKnowledge(db, { title: `批量条目 ${i} 探针主题`, contentMd: `探针主题 内容 ${i}` })
}
const logs = []
const manager = new KnowledgeRecallManager(db, { log: (line) => logs.push(line) })
const candidates = manager.candidates(null).length
console.log(`知识库实际 ${TOTAL} 条，进入候选集 ${candidates} 条`)

let failed = false
if (candidates < TOTAL) {
  console.log(`FAIL: 少了 ${TOTAL - candidates} 条，且没有可观测信号`)
  failed = true
}
if (failed && logs.length === 0) console.log('（候选集被截断，但日志里一个字都没有 —— 静默截断）')

db.close()
rmSync(dir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
