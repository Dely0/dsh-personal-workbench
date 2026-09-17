/**
 * 反向前置 #4：按**真实 DSH 会话事件形状**驱动 `agent/turn-stopping`，必须真的发生一次召回。
 *
 * 真实形状（权威出处：`@deepseek-ai/dsh-session` 的事件表 `'user/message': UserMessage`、
 * `'turn/start': { turn: number }`；宿主实现 `dsh-agent-loop` 里读的是 `event.data`；
 * 另有 `dsh-team-memory` 的实测注释：「`session/event` 交给监听器的是**带 data 信封的完整事件**」）：
 *
 *   { type: 'turn/start',    seq, data: { turn: { turn: 5 } } }
 *   { type: 'user/message',  seq, data: { content: [...], source: { kind: 'user' } } }
 *
 * 有缺陷时退出码非零：钩子读的是 `event.turn` / `event.data.message` → 恒 undefined
 * → query 为空 → 早返回 → **一次召回都不发生，而且没有任何日志**（静默失效）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../../lib/db/database.js'
import { seedDictionaries } from '../../../lib/db/seed.js'
import { createKnowledge, createTask } from '../../../lib/db/repo.js'
import { linkTaskSession } from '../../../lib/db/repo/task-sessions.js'
import { listRecallLog } from '../../../lib/knowledge-recall-log.js'
import { installKnowledgeRecall, currentTurnOf } from '../../../lib/knowledge-recall.js'

const dir = mkdtempSync(join(tmpdir(), 'wb-envelope-'))
const db = openWorkbenchDb({ dbPath: join(dir, 'w.db') })
seedDictionaries(db)
const t = createTask(db, { typeCode: 'code_impl', priorityCode: 'p2', title: '盘符根目录的坑' })
createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null', sourceTaskId: t.id })
linkTaskSession(db, { taskId: t.id, sessionId: 'sess-env', roleCode: 'execute' })

// ── 真实形状的事件序列（含一条插件注入的 user/message —— 它不该被当成"用户提问"）
const events = [
  { type: 'turn/start', seq: 1, time: 1, data: { turn: { turn: 5 } } },
  { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '盘符根目录' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 3, time: 3, data: {} },
  { type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: '【运行时上下文快照】与本次提问无关的长文本' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } } },
]
const agent = { session: { header: { id: 'sess-env' }, snapshotEvents: () => events } }

// 捕获钩子注册
const hooks = new Map()
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
  on: (name, listener) => { hooks.set(name, listener); return () => {} },
  get: () => undefined,
}
const manager = installKnowledgeRecall(ctx, db, { log: () => {} })

let failed = false
const turn = currentTurnOf(agent)
console.log(`currentTurnOf(真实事件) = ${turn}（期望 5）`)
if (turn !== 5) { console.log('FAIL: 回合号读成了 0 —— 读的是事件顶层而不是 data 信封'); failed = true }

const hook = hooks.get('agent/turn-stopping')
if (typeof hook !== 'function') {
  console.log('FAIL: 没有注册 agent/turn-stopping 钩子')
  failed = true
} else {
  hook({ agent, turn: 5, signal: {} })
  const rows = listRecallLog(db, { sessionId: 'sess-env' })
  console.log(`turn-stopping 后召回日志：${rows.length} 行 → ${rows.map((r) => r.trigger).join(', ')}`)
  /**
   * 期望：至少一行 `turn`（修好信封才有），且**查询必须是用户那句话**。
   * 这里会有两行（`session_start` + `turn`）—— 因为本探针没有先跑 session-start，
   * 于是 `prefetch` 顺带补做了一次"开工前"（关联晚到时的补做，v1.15.4 新增），
   * 两件事各落一行日志、分开记账，这是刻意的口径。
   */
  const turnRows = rows.filter((row) => row.trigger === 'turn')
  if (turnRows.length !== 1) { console.log('FAIL: 回合收尾没有留下 turn 召回记录 —— 静默失效'); failed = true }
  else {
    console.log(`  turn 行的 query = 「${turnRows[0].query}」`)
    if (!turnRows[0].query.includes('盘符根目录')) { console.log('FAIL: 取到的不是用户提问'); failed = true }
  }
  if (rows.some((row) => row.query.includes('运行时上下文'))) {
    console.log('FAIL: 把**插件注入的快照**当成了用户提问（自激风险）')
    failed = true
  }
}

// 同一份事件快照，注入的那条不该被当成提问
void manager
db.close()
rmSync(dir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
