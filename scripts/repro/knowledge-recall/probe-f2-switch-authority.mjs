/**
 * 反向前置 #2：官方配置 `knowledgeRecallEnabled` 与设置页开关（meta）不能各说各话。
 * 有缺陷时退出码非零：config.enabled=false 时设置页把它打开，行为仍然是关的（假控件）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../../lib/db/database.js'
import { seedDictionaries } from '../../../lib/db/seed.js'
import { KnowledgeRecallManager } from '../../../lib/knowledge-recall.js'

const dir = mkdtempSync(join(tmpdir(), 'wb-authority-'))
const db = openWorkbenchDb({ dbPath: join(dir, 'w.db') })
seedDictionaries(db)

let failed = false
// 情形 A：没有 meta 时，config=false 应当生效（部署方能一键默认关闭）
const a = new KnowledgeRecallManager(db, { enabled: false, log: () => {} })
console.log(`A) config.enabled=false 且 meta 未写 → autoEnabled()=${a.autoEnabled()}（期望 false）`)
if (a.autoEnabled() !== false) failed = true

// 情形 B：用户在设置页把它打开（写 meta=1）后，行为必须跟着变
a.setAutoEnabled(true)
const b = a.autoEnabled()
console.log(`B) 设置页开启后（meta=1）→ autoEnabled()=${b}（期望 true）`)
if (b !== true) failed = true

// 情形 C：用户在设置页关掉（meta=0）后，即使 config=true 也必须是关的
const c = new KnowledgeRecallManager(db, { enabled: true, log: () => {} })
c.setAutoEnabled(false)
const d = c.autoEnabled()
console.log(`C) 设置页关闭后（meta=0，config=true）→ autoEnabled()=${d}（期望 false）`)
if (d !== false) failed = true

db.close()
rmSync(dir, { recursive: true, force: true })
if (failed) { console.log('FAIL: 开关存在两个权威源，设置页可能是假控件'); process.exit(1) }
console.log('ok: meta 是唯一权威源，config 只提供缺省值')
