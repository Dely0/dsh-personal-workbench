/**
 * 反向前置 #7（第一方证据）：任务关联**晚于**会话开始建立时，「开工前」召回不能静默消失。
 *
 * 真实时序（客户端先 `sessions.prompt()`、随后才 POST 关联）：`agent/session-start`
 * 触发时 `task_sessions` 里还没有这一行，且会话 cwd 不一定含任务 UUID → 我的
 * `prime()` 直接 `return undefined`，**既不检索也不留日志**。
 *
 * 有缺陷时退出码非零：这里模拟"关联晚到"，要求
 *  ①关联出现后补一次开工前召回（能注入【工作台知识库】）；
 *  ②至少留下一条"这次没检索"的可读日志（不静默）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../../lib/db/database.js'
import { seedDictionaries } from '../../../lib/db/seed.js'
import { createKnowledge, createTask } from '../../../lib/db/repo.js'
import { linkTaskSession } from '../../../lib/db/repo/task-sessions.js'
import { listRecallLog } from '../../../lib/knowledge-recall-log.js'
import { installKnowledgeRecall } from '../../../lib/knowledge-recall.js'

const dir = mkdtempSync(join(tmpdir(), 'wb-late-link-'))
const db = openWorkbenchDb({ dbPath: join(dir, 'w.db') })
seedDictionaries(db)

const t = createTask(db, { typeCode: 'code_impl', priorityCode: 'p2', title: '修复选择文件出不了 C 盘', description: '盘符 根目录 parent 为 null' })
createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null', sourceTaskId: t.id })

// 捕获注册
const listeners = new Map()
let contextText
const logs = []
const ctx = {
  logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {} },
  effect: (fn) => { fn(); return () => {} },
  systemPrompt: { section: () => () => {}, context: (spec) => { contextText = spec.text; return () => {} } },
  on: (name, fn) => { listeners.set(name, fn); return () => {} },
  get: () => undefined,
}
const manager = installKnowledgeRecall(ctx, db, { log: (m) => logs.push(m) })

// ① 会话开始：**还没有** task_sessions 关联，cwd 也不是任务资料夹
const agent = { session: { header: { id: 'sess-late', cwd: 'E:\\Code\\dsh-personal-workbench' }, snapshotEvents: () => [] } }
listeners.get('agent/session-start')({ agent, source: 'startup' })

let failed = false
console.log(`会话开始时（无关联）：模型可见内容 = ${JSON.stringify(contextText({ agent }))}（期望：无知识块，但**要有日志**）`)
const startLogs = logs.filter((l) => l.includes('开工前') || l.includes('未关联'))
console.log(`  相关日志 ${startLogs.length} 条${startLogs.length > 0 ? `，例如：${startLogs[0]}` : ''}`)
if (startLogs.length === 0) { console.log('FAIL: 什么都没做，也没留一行日志（静默）'); failed = true }

// ② 关联晚到（客户端随后 POST），下一次回合收尾时应当补一次开工前召回
linkTaskSession(db, { taskId: t.id, sessionId: 'sess-late', roleCode: 'execute' })
/**
 * ⚠️ 回合收尾钩子的前提是"这一回合真的有一句用户提问"（真实形状：`data` 就是消息本体）。
 * 第一版探针给了空事件序列，于钩子直接早返回，测不出"关联晚到补做"这件事 ——
 * 探针自己的缺陷，已在报告里说明。
 */
const turnEvents = [
  { type: 'turn/start', seq: 1, time: 1, data: { turn: { turn: 1 } } },
  { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '这个报错怎么查' }], source: { kind: 'user' } } },
]
agent.session.snapshotEvents = () => turnEvents
const turnHook = listeners.get('agent/turn-stopping')
if (typeof turnHook !== 'function') { console.log('FAIL: 没有注册 agent/turn-stopping'); failed = true } else {
  turnHook({ agent, turn: 1, signal: {} })
}
const injected = contextText({ agent })
console.log(`关联补上后，模型可见内容 = ${JSON.stringify(injected.slice(0, 60))}…`)
if (!injected.includes('【工作台知识库】')) { console.log('FAIL: 关联晚到后没有补上开工前召回'); failed = true }
const rows = listRecallLog(db, { sessionId: 'sess-late' })
console.log(`  召回日志行数 = ${rows.length}（期望 ≥1）`)
if (rows.length === 0) { console.log('FAIL: 一次召回都没落日志'); failed = true }

void manager
db.close()
rmSync(dir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
