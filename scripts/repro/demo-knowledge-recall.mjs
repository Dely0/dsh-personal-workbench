/**
 * 四时机演示 + 噪声实测（v1.15.3「知识库被会话 AI 自动调用」验收证据）。
 *
 * ## 这份脚本要回答验收标准里的三件事
 *
 * 1. **四个时机各有一个可演示的例子**，并且能看到「检索了哪些关键词、命中哪几条、
 *    是否被引用」——本脚本把每一时机都跑一遍，打印三份证据：
 *    ①AI 侧日志行（用户/排查者看的）②结构化命中（关键词 + 逐条分数与依据）
 *    ③`knowledge_recall_log` 落库行（含 `cited_ids`＝是否被引用）。
 * 2. **开关关闭后不再注入** —— 关掉会话后重跑，必须得到"不检索且无注入文本"。
 * 3. **噪声可控** —— 两类诱饵（字面共享型 / 完全无关型）分别给出实测数字。
 *
 * ## 为什么用**真实库的副本**
 *
 * 演示的数据必须是真的（本机 59 条知识条目），否则打分的可信度无从谈起；
 * 但脚本**绝不写线上库**（复制到临时目录再操作）。`--keep` 可保留副本便于复查。
 *
 * 用法：
 *   node scripts/repro/demo-knowledge-recall.mjs                  # 自动找 %USERPROFILE%\.dsh\workbench\workbench.db
 *   node scripts/repro/demo-knowledge-recall.mjs --db <path>      # 指定库
 *   node scripts/repro/demo-knowledge-recall.mjs --task <taskId>  # 指定"本任务"（默认取有知识条目的任务）
 *   node scripts/repro/demo-knowledge-recall.mjs --quiet          # 只打印断言（CI/回归用）
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { KnowledgeRecallManager } from '../../lib/knowledge-recall.js'
import { listRecallLog } from '../../lib/knowledge-recall-log.js'
import { listKnowledge, listTasks } from '../../lib/db/repo.js'
import { linkTaskSession } from '../../lib/db/repo/task-sessions.js'

const args = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const QUIET = args.includes('--quiet')
const DEFAULT_DB = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
const source = flag('--db', DEFAULT_DB)

if (!existsSync(source)) {
  console.error(`SKIP: 找不到工作台库 ${source}（用 --db 指定）`)
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'wb-knowledge-recall-'))
const copyPath = join(work, 'workbench.db')
copyFileSync(source, copyPath)
// WAL/SHM 也要带上，否则副本可能读不到最新写入
for (const suffix of ['-wal', '-shm']) {
  if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${copyPath}${suffix}`)
}

const db = openWorkbenchDb({ dbPath: copyPath })
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}
const say = (...parts) => { if (!QUIET) console.log(...parts) }

// ------------------------------------------------------------------ 挑一个"本任务"
const knowledge = listKnowledge(db, { limit: 500 })
say(`知识库条目：${knowledge.length} 条（真实库副本）`)
const requestedTask = flag('--task')
const taskWithKnowledge = requestedTask ?? knowledge.find((entry) => entry.sourceTaskId !== null)?.sourceTaskId ?? null
const taskTitle = taskWithKnowledge === null ? '(无)' : (listTasks(db, { includeArchived: true }).find((t) => t.id === taskWithKnowledge)?.title ?? '(已删除)')
say(`本任务：${taskWithKnowledge ?? '(无)'} 「${taskTitle}」\n`)

const manager = new KnowledgeRecallManager(db, { log: () => {} })
const sessionFor = (suffix) => `demo-${taskWithKnowledge ?? 'global'}-${suffix}`
if (taskWithKnowledge !== null) {
  // 让 resolveTaskId 走**权威路径**（task_sessions），而不是靠工作目录命名猜
  for (const suffix of ['before', 'error', 'code', 'accept']) {
    linkTaskSession(db, { taskId: taskWithKnowledge, sessionId: sessionFor(suffix), roleCode: 'execute' })
  }
}

// ------------------------------------------------------------------ ① 四个时机
/**
 * 每个时机给**两句**真实会出现的提问：主用第一句，零命中时用第二句。
 *
 * 为什么允许"零命中"并如实记录：知识库是长出来的，某个时机确实可能还没有相关条目 ——
 * 那正是"零命中也是有效信息"这条口径要表达的东西。但验收要求"四个时机各有一个
 * 可演示的例子"，所以每格都备一句**库里确实有覆盖**的提问，并打印实际用了哪句。
 */
const TIMINGS = [
  {
    label: '① 执行任务前（开工前先查相关条目）',
    suffix: 'before',
    queries: ['知识库 自动调用 会话 注入', '知识 检索 注入 提示词'],
  },
  {
    label: '② 遇到报错 / 异常时（拿报错原文关键词查）',
    suffix: 'error',
    queries: ['方向图 内存溢出 卡死', 'NRE 判空 编译失败 中文路径'],
  },
  {
    label: '③ 写代码 / 改代码前（查相关约定与踩坑）',
    suffix: 'code',
    queries: ['证据链 反向验证 变异测试', '单一权威源 断言 校验规则'],
  },
  {
    label: '④ 提交验收 / 复盘前（查相关历史经验）',
    suffix: 'accept',
    queries: ['复盘 根因分析 多轮返工', '验收 收尾 部署 哈希'],
  },
]

const timings = []
for (const spec of TIMINGS) {
  const sessionId = sessionFor(spec.suffix)
  let chosen = null
  for (const query of spec.queries) {
    manager.drainLogs()
    const outcome = manager.prefetch(sessionId, undefined, query)
    const injected = manager.injectionFor(sessionId, 1)
    const logs = manager.drainLogs()
    say('─'.repeat(78))
    say(`【${spec.label}】query = 「${query}」`)
    for (const line of logs) say(`  ${line.replace('[workbench-knowledge] ', '')}`)
    if (outcome === undefined) { say('  （未发生检索：会话开关为关）'); continue }
    say(`  关键词：${outcome.terms.join(' ')}`)
    if (outcome.hits.length === 0) {
      say(`  命中 0 条（候选池匹配 ${outcome.matched}，被阈值挡下 ${outcome.droppedByScore}，已注入过去重 ${outcome.droppedAsSeen}）`)
      continue
    }
    for (const hit of outcome.hits) {
      say(`  ✔ [${hit.id.slice(0, 8)}] ${hit.title}`)
      say(`      相关度 ${hit.score.toFixed(2)}｜${hit.reason}｜${hit.fromTask ? '本任务' : '全库'}`)
    }
    // 回报引用：模型"用到了"第一条（演示 report_usage 落到 cited_ids）
    const report = manager.reportUsage(sessionId, [outcome.hits[0].id])
    const rows = listRecallLog(db, { sessionId, limit: 1 })
    say(`  日志行（落库）：trigger=${rows[0]?.trigger} injected=${rows[0]?.injected} cited=${JSON.stringify(rows[0]?.citedIds ?? [])}（回报命中 ${report.updated} 行）`)
    const injectedLines = injected.split('\n').filter((line) => line.startsWith('- [')).length
    say(`  会话里可见的注入文本：【工作台知识库】… ${injectedLines} 条`)
    chosen = { label: spec.label, sessionId, query, injected: injected !== '', hits: outcome.hits }
    break
  }
  timings.push(chosen ?? { label: spec.label, sessionId, query: spec.queries[0], injected: false, hits: [] })
}

console.log('')
for (const timing of timings) {
  check(`${timing.label} → 有可见的检索结论（命中 ${timing.hits.length} 条，query=「${timing.query}」）`, timing.hits.length > 0)
}
check('四个时机各留下一条落库日志（关键词/命中/是否被引用可回看）', timings.every((t) => listRecallLog(db, { sessionId: t.sessionId }).length === 1))

// ------------------------------------------------------------------ ② 开关关闭后不再注入
console.log('\n=== 开关：关掉后不再注入 ===')
const offSession = sessionFor('before')
manager.setSessionEnabled(offSession, 'off')
manager.drainLogs()
const queryForOff = timings[0].query
const afterOff = manager.prefetch(offSession, undefined, queryForOff)
const injectedAfterOff = manager.injectionFor(offSession, 2)
check('会话关掉后 prefetch 不产生结论（不再检索）', afterOff === undefined)
check('会话关掉后注入文本为空（不再注入）', injectedAfterOff === '')
manager.setSessionEnabled(offSession, 'on')
const afterOn = manager.prefetch(offSession, undefined, queryForOff)
check('重新打开后恢复检索', afterOn !== undefined)

// ------------------------------------------------------------------ ③ 噪声实测
console.log('\n=== 噪声实测（两类诱饵：字面共享 / 完全无关）===')
/**
 * 两类诱饵回答两个**不同**的问题 —— 混为一谈会得出错误结论。
 *
 * **A. 字面共享型**（换掉提问里的一个字）：它其实**应该**命中，因为与真实提问
 * 共享大部分字，逐字检索无法区分。这里只验"不比真实提问更宽"。
 * 第一版打分（`权重 + 0.06*命中词数`）在这类诱饵上会给出与真实提问一样高的分 ——
 * 归一化打分（`权重 × 命中覆盖率`）就是被这组实测逼出来的。
 *
 * **B. 完全无关型**（关键词全是库外字）：它**必须零命中**。这一条才是
 * "无明显不相关条目被反复注入"的直接证据：库里 59 条、逐字匹配，
 * 如果连库外字都能捞到条目，说明阈值形同虚设。
 * 库外字是**算出来的**（在标题+正文+标签里都不出现），不是手挑的。
 */
const corpus = knowledge
  .map((entry) => `${entry.title}${entry.contentMd}${entry.tags.join('')}`.toLowerCase())
  .join('')
const RARE = ['龘', '靐', '齉', '爨', '麤', '黌', '鸝', '蠡', '彧', '翀', '燚', '鑫', '淼', '焱', '垚', '犇', '猋', '驫']
const outside = RARE.filter((char) => !corpus.includes(char))
say(`  库外汉字样本：${outside.slice(0, 6).join('')}（共 ${outside.length} 个不在任何条目的标题/正文/标签里）`)

const sharingDecoys = [
  ['方向图 内存溢出 卡死', '方问图 内存益出 卡死'],
  ['复盘 根因分析 多轮返工', '复盆 根音分析 多轮返工'],
  ['证据链 反向验证 变异测试', '证据连 反向验证 变导测试'],
  ['转台操作 SOP', '转抬操作 SOP'],
]
let sharingRealHits = 0
let sharingDecoyHits = 0
for (const [real, decoy] of sharingDecoys) {
  const realOutcome = manager.recallToText({ taskId: taskWithKnowledge, query: real })
  const decoyOutcome = manager.recallToText({ taskId: taskWithKnowledge, query: decoy })
  sharingRealHits += realOutcome.hits.length
  sharingDecoyHits += decoyOutcome.hits.length
  say(`  [A 字面共享] 真实「${real}」→ ${realOutcome.hits.length} 条（${realOutcome.hits.map((h) => h.score.toFixed(2)).join(', ') || '—'}）`)
  say(`               诱饵「${decoy}」→ ${decoyOutcome.hits.length} 条（${decoyOutcome.hits.map((h) => h.score.toFixed(2)).join(', ') || '—'}）`)
}
check('A 字面共享型诱饵不比真实提问更宽（逐字检索的固有边界，如实记录）', sharingDecoyHits <= sharingRealHits, `真实 ${sharingRealHits} 条 vs 诱饵 ${sharingDecoyHits} 条`)

let outsideHits = 0
let outsideMatched = 0
let outsideQueries = 0
for (let index = 0; index + 2 < outside.length && index < 8; index += 3) {
  const query = `${outside[index]}${outside[index + 1]}${outside[index + 2]}`
  const outcome = manager.recallToText({ taskId: taskWithKnowledge, query })
  outsideHits += outcome.hits.length
  outsideMatched += outcome.matched
  outsideQueries += 1
  say(`  [B 完全无关] 「${query}」→ 命中 ${outcome.hits.length} 条（候选池匹配 ${outcome.matched}）`)
}
check('B 完全无关型诱饵**零命中**（库外字捞不到任何条目）', outsideHits === 0, `${outsideQueries} 条查询共命中 ${outsideHits} 条、候选池匹配 ${outsideMatched} 条`)

const batch = ['知识库自动调用', '迁移颜色', 'plugin add ENOENT', '历史经验', '触发时机']
let totalHits = 0
let emptyCount = 0
for (const query of batch) {
  const outcome = manager.recallToText({ taskId: taskWithKnowledge, query })
  totalHits += outcome.hits.length
  if (outcome.hits.length === 0) emptyCount += 1
}
say(`  批量 ${batch.length} 条短提问：共命中 ${totalHits} 条，平均 ${(totalHits / batch.length).toFixed(2)} 条/问，零命中 ${emptyCount} 条`)
check('平均注入条数 ≤ 3（单回合上限），没有把知识库整库灌进上下文', totalHits / batch.length <= 3)
check('短提问也会出现零命中（阈值真的在挡，而不是"问什么都给三条"）', emptyCount > 0 || totalHits < batch.length * 3)

// ------------------------------------------------------------------ 结论
const failed = results.filter((item) => !item.ok)
console.log('')
if (failed.length > 0) {
  console.error(`❌ ${failed.length}/${results.length} 项断言失败：`)
  for (const item of failed) console.error(`   - ${item.name}`)
  db.close()
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true })
  process.exit(1)
}
console.log(`✅ ${results.length}/${results.length} 项断言通过（真实库副本：${copyPath}）`)
db.close()
if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true })
else console.log(`副本保留在 ${work}`)
