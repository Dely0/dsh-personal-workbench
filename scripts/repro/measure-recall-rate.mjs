/**
 * P1 基线测量：**用本会话真实发生过的提问**去跑当前召回，看到底差多远。
 *
 * 为什么不用我现编的查询：自动层的失败是"真实口语提问召不回来"，
 * 而现编查询很容易被我自己优化成"刚好能命中"——那就是自欺。这里直接取
 * `knowledge_recall_log` 里本会话 `trigger=turn` 的**原始提问**，一条不改。
 *
 * 同时打印**低于阈值但接近**的候选（minScore=0），这样才能判断该改什么：
 * - 最好的分数在 0.25~0.34 → 阈值/因子微调即可；
 * - 最好只有 0.05~0.15 → 打分几何本身对长提问不利，要改结构。
 *
 * 用法：node scripts/repro/measure-recall-rate.mjs
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { KnowledgeRecallManager } from '../../lib/knowledge-recall.js'
import { formatRelevance } from '../../lib/shared/knowledgeRecall.js'

const SOURCE = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(SOURCE)) { console.error('找不到线上库'); process.exit(2) }
const dir = mkdtempSync(join(tmpdir(), 'wb-recall-rate-'))
const copy = join(dir, 'workbench.db')
copyFileSync(SOURCE, copy)
for (const s of ['-wal', '-shm']) if (existsSync(`${SOURCE}${s}`)) copyFileSync(`${SOURCE}${s}`, `${copy}${s}`)
const db = openWorkbenchDb({ dbPath: copy })

// ── 真实提问：本会话 turn 行里的原文（一条不改）
const real = db.prepare(`
  SELECT query, matched, hits_json, created_at FROM knowledge_recall_log
  WHERE trigger_code = 'turn' AND length(query) > 6
  ORDER BY id DESC LIMIT 12
`).all()
const queries = []
const seen = new Set()
for (const row of real) {
  const q = String(row.query).trim()
  if (q === '' || seen.has(q)) continue
  seen.add(q)
  queries.push({ q, source: '本会话真实提问', loggedHits: JSON.parse(row.hits_json).length, at: row.created_at.slice(11, 16) })
}

// ── 对照组：四时机演示里那几条"关键词式"查询（必须继续命中，用于防退化）
for (const q of ['知识库 自动调用 会话 注入', '方向图 内存溢出 卡死', '证据链 反向验证 变异测试', '复盘 根因分析 多轮返工']) {
  queries.push({ q, source: '关键词式对照', loggedHits: null, at: '-' })
}

const strict = new KnowledgeRecallManager(db, { log: () => {} })
const loose = new KnowledgeRecallManager(db, { minScore: 0, maxEntries: 3, log: () => {} })

let realTotal = 0
let realHit = 0
let realHint = 0
let ctrlTotal = 0
let ctrlHit = 0
console.log('查询'.padEnd(4) + ' 来源           命中  提示  最好原始分  最好相关度  top-1')
console.log('─'.repeat(126))
for (const item of queries) {
  const out = strict.recallToText({ taskId: null, query: item.q })
  const diag = loose.recallToText({ taskId: null, query: item.q })
  const best = diag.hits[0]
  const isReal = item.source === '本会话真实提问'
  const surfaced = out.hits.length > 0 || out.nearMisses.length > 0
  if (isReal) { realTotal += 1; if (out.hits.length > 0) realHit += 1; if (surfaced) realHint += 1 }
  else { ctrlTotal += 1; if (out.hits.length > 0) ctrlHit += 1 }
  const flag = out.hits.length > 0 ? '✅' : (out.nearMisses.length > 0 ? '🔸' : '❌')
  const title = best === undefined ? '(一条都没碰到关键词)' : `${best.title.slice(0, 30)}`
  console.log(`${flag}    ${isReal ? '真实' : '对照'}(${String(item.q.length).padStart(3)}字) `
    + `${String(out.hits.length).padStart(2)} 条 ${String(out.nearMisses.length).padStart(2)} 条  `
    + `${best === undefined ? '  -  ' : best.score.toFixed(3)}      `
    + `${best === undefined ? '  -  ' : formatRelevance(best.score)}      ${title}`)
  console.log(`      「${item.q.slice(0, 70).replace(/\s+/g, ' ')}${item.q.length > 70 ? '…' : ''}」`)
  if (out.nearMisses.length > 0 && out.hits.length === 0) {
    console.log(`      提示行：${out.nearMisses.map((h) => `${h.title.slice(0, 22)}(${formatRelevance(h.score)})`).join(' / ')}`)
  }
}

console.log('─'.repeat(126))
console.log(`真实提问：完整注入 ${realHit}/${realTotal}    有可见内容（完整+提示）**${realHint}/${realTotal}**`
  + `    关键词式对照：完整注入 ${ctrlHit}/${ctrlTotal}`)
db.close()
rmSync(dir, { recursive: true, force: true })
