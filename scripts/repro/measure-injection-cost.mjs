/**
 * P3（减少两步消费）+ 收尾①（注入表头不再回显整段描述）的**成本对照**。
 *
 * ## 这份脚本要回答的两个问题
 *
 * 1. 收尾①：开工前那次的 query 是「任务标题 + 整段描述」（实测 483 字），
 *    它每回合被搬进对话一次 —— 改成"前 60 字 + 前 12 个关键词"之后省了多少？
 * 2. P3：98% 的条目正文 > 160 字（平均 1637 字），注入只给 160 字摘要 + id，
 *    于是"检索得回来、消费不下去"（模型还得再调一次工具取全文 = 两步）。
 *    top-1 放宽到 400 字之后，单次注入多了多少字符、能覆盖多少条目的正文？
 *
 * ## 口径说明（别把它当成"跑了两遍代码"）
 *
 * 脚本跑的是**当前**实现，得到真实的注入文本（字符数 / 条数都是实测）。
 * "改前"那一列是**同一份 outcome 的加性分解**：
 *   改前 = 当前 − (query 被截掉的字符数) − (top-1 摘要多出来的字符数)
 * 两项正好对应本次的两个改动，没有第三处改动会影响这段文本 ——
 * 所以分解是等价的，而比"再拉一份旧代码跑一遍"更容易复现。
 * 落库的 `query` **仍是全文**（`appendRecallLog` 不经截断），这一点也在下面单独验证。
 *
 * 用法：node scripts/repro/measure-injection-cost.mjs [--db <path>]
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { KnowledgeRecallManager } from '../../lib/knowledge-recall.js'
import { listRecallLog } from '../../lib/knowledge-recall-log.js'
import { listKnowledge, listTasks } from '../../lib/db/repo.js'
import { linkTaskSession } from '../../lib/db/repo/task-sessions.js'
import { echoQuery, formatRecallText, RECALL_DEFAULTS } from '../../lib/shared/knowledgeRecall.js'

const args = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const SOURCE = flag('--db', join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db'))
if (!existsSync(SOURCE)) { console.error(`找不到工作台库 ${SOURCE}`); process.exit(2) }

const dir = mkdtempSync(join(tmpdir(), 'wb-injection-cost-'))
const copy = join(dir, 'workbench.db')
copyFileSync(SOURCE, copy)
for (const suffix of ['-wal', '-shm']) if (existsSync(`${SOURCE}${suffix}`)) copyFileSync(`${SOURCE}${suffix}`, `${copy}${suffix}`)
const db = openWorkbenchDb({ dbPath: copy })
const manager = new KnowledgeRecallManager(db, { log: () => {} })

const knowledge = listKnowledge(db, { limit: 5000 })
const bodyLengths = knowledge.map((entry) => entry.contentMd.length).filter((n) => n > 0)
const longShare = bodyLengths.length === 0 ? 0 : bodyLengths.filter((n) => n > RECALL_DEFAULTS.snippetLength).length / bodyLengths.length
const avgBody = bodyLengths.length === 0 ? 0 : Math.round(bodyLengths.reduce((a, b) => a + b, 0) / bodyLengths.length)
console.log(`知识库：${knowledge.length} 条；有正文的 ${bodyLengths.length} 条，正文平均 ${avgBody} 字`)
console.log(`正文 > ${RECALL_DEFAULTS.snippetLength} 字的占比：${(longShare * 100).toFixed(0)}%`)

/** 这一份注入文本的"改前"长度（加性分解：表头回显全文 + top-1 摘要只有 160 字）。 */
function beforeLength(outcome, text) {
  if (outcome.hits.length === 0) return { text: 0, header: 0, snippet: 0 }
  // 改前表头**更长**（回显全文）；改前 top-1 摘要**更短**（只有 160 字）→ 一加一减
  const queryExtra = Math.max(0, outcome.query.length - echoQuery(outcome.query).length)
  const snippetExtra = Math.max(0, (outcome.hits[0]?.snippet.length ?? 0) - RECALL_DEFAULTS.snippetLength)
  return { text: text.length + queryExtra - snippetExtra, header: queryExtra, snippet: snippetExtra }
}

console.log('\n=== 逐次注入的字符数（实测当前 vs 改前分解）===')
console.log('场景'.padEnd(34) + ' 条数  当前字符  改前字符  省/多   其中表头  其中摘要')
console.log('─'.repeat(104))

const print = (label, outcome, text) => {
  const before = beforeLength(outcome, text)
  const delta = text.length - before.text
  console.log(
    label.padEnd(32) + String(outcome.hits.length).padStart(4) + String(text.length).padStart(10)
    + String(before.text).padStart(10) + String(delta >= 0 ? `+${delta}` : String(delta)).padStart(8)
    + String(-before.header).padStart(10) + String(before.snippet).padStart(10),
  )
  return { text, before: before.text, hits: outcome.hits.length }
}

/**
 * ① 开工前那次（最刺眼的例子）：query = 任务标题 + 整段描述。
 * 取关联知识最多的那个任务，与 demo 脚本同一套挑法（可重复）。
 */
const linkedCounts = new Map()
for (const entry of knowledge) if (entry.sourceTaskId !== null) linkedCounts.set(entry.sourceTaskId, (linkedCounts.get(entry.sourceTaskId) ?? 0) + 1)
const taskId = [...linkedCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
if (taskId !== null) {
  linkTaskSession(db, { taskId, sessionId: 'cost-prime', roleCode: 'execute' })
  const outcome = manager.prime('cost-prime', undefined)
  if (outcome !== undefined) {
    const text = manager.injectionFor('cost-prime', 0) || formatRecallText(outcome)
    const row = print('① 开工前（标题+描述）', outcome, text)
    console.log(`    query 长度 ${outcome.query.length} 字 → 表头只回显 ${echoQuery(outcome.query).length} 字（+ 前 ${RECALL_DEFAULTS.queryEchoTerms} 个关键词）`)
    const top = outcome.hits[0]
    if (top !== undefined) console.log(`    top-1「${top.title.slice(0, 30)}」摘要 ${top.snippet.length} 字（改前 160）`)
    // 落库的 query 必须**仍是全文**（表头截断不许影响账）
    const rows = listRecallLog(db, { sessionId: 'cost-prime', limit: 1 })
    const stored = rows[0]?.query ?? ''
    console.log(`    落库 query 长度 ${stored.length} 字 → ${stored.length === outcome.query.length ? '与全文一致 ✔（账没被截断）' : '与全文不一致 ✘'}`)
    void row
  }
}

/** ② 回合路径：用本会话真实提问（原文）逐条算一次。 */
const realRows = db.prepare(`
  SELECT query FROM knowledge_recall_log WHERE trigger_code = 'turn' AND length(query) > 6 ORDER BY id DESC LIMIT 8
`).all()
const seen = new Set()
let index = 0
for (const row of realRows) {
  const query = String(row.query).trim()
  if (query === '' || seen.has(query)) continue
  seen.add(query)
  index += 1
  const sessionId = `cost-turn-${index}`
  const outcome = manager.recallToText({ taskId: null, query })
  const text = formatRecallText(outcome)
  if (outcome.hits.length === 0) { console.log(`   ${sessionId} 零命中（不插占位，0 字符）`); continue }
  print(`② 「${query.slice(0, 18)}…」`, outcome, text)
}

/** ③ 提示档的成本（对比完整块）：给一个必然只落提示档的查询。 */
console.log('\n=== 两档闸门的成本对比（同一份数据）===')
const hintOutcome = manager.recallToText({ taskId: null, query: '知识库' })
console.log(`查询「知识库」：完整命中 ${hintOutcome.hits.length} 条、提示档 ${hintOutcome.nearMisses.length} 条`
  + `（完整块约 ${hintOutcome.hits.length === 0 ? 0 : formatRecallText(hintOutcome).length} 字符，提示行约 90 字符）`)

console.log('\n结论：表头截断省下的字符数 = 「query 长度 − 60」；top-1 摘要多出的字符数 ≤ 240（400 − 160）。')
console.log('      两者都是**单向**的（表头只减、摘要只在 top-1 上加），所以单次注入成本可预期。')
db.close()
rmSync(dir, { recursive: true, force: true })
