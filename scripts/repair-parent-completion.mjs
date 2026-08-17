#!/usr/bin/env node
/**
 * 存量数据修复：扫描所有父节点，若直接子节点已全部完成/取消但父节点未完成，
 * 则递归补完成。脚本幂等，可重复执行。
 *
 * 用法：
 *   node scripts/repair-parent-completion.mjs
 *   WORKBENCH_DB=/path/to/workbench.db node scripts/repair-parent-completion.mjs
 */
import { openWorkbenchDb, defaultDbPath } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { repairParentCompletion } from '../lib/db/repo.js'

const dbPath = process.env.WORKBENCH_DB ?? defaultDbPath()
const db = openWorkbenchDb({ dbPath })
try {
  seedDictionaries(db)
  const changed = repairParentCompletion(db)
  console.log(`repair-parent-completion: done, ${changed} task(s) marked done (idempotent; re-run returns 0)`)
} finally {
  db.close()
}
