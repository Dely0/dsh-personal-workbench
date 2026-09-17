/**
 * P1b 标定：**只在真实数据上选 `massSat`**（信息量饱和阈值）。
 *
 * ## 为什么要有这个脚本
 *
 * v1.15.6 的 `LENGTH_SATURATION = 3`（"命中 3 个词就满分"）是拍出来的量纲，
 * P1b 换成 `Σ idf(t)`（信息量总量）之后，那个 3 不再有任何意义 ——
 * 新量纲下必须**重新量一个数**，而不是"看起来差不多就写 4.5"。
 *
 * 判据（缺一不可，全部来自用户给的验收口径）：
 * 1. **真实提问的完整注入率要显著高于现状**（现状 1/11~3/12）；
 * 2. **噪声不变量不许退化**：
 *    - A 字面共享诱饵不比真实提问更宽；
 *    - B 库外字诱饵**零命中**；
 *    - C 没有条目在 ≥3 次不同提问里进 top-3；
 *    - 关键词式对照不退化（改前 4/4）。
 *
 * 真实提问直接取自 `knowledge_recall_log` 的 `trigger=turn` 行（**原文，一条不改**）：
 * 现编查询很容易被我优化成"刚好命中"，那就是自欺。
 *
 * 用法：node scripts/repro/calibrate-idf.mjs [--db <path>]
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { KnowledgeRecallManager } from '../../lib/knowledge-recall.js'
import { listKnowledge } from '../../lib/db/repo.js'
import { formatRelevance, idfOf, termStatsOf } from '../../lib/shared/knowledgeRecall.js'

const args = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const SOURCE = flag('--db', join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db'))
if (!existsSync(SOURCE)) { console.error(`找不到工作台库 ${SOURCE}`); process.exit(2) }

const dir = mkdtempSync(join(tmpdir(), 'wb-calibrate-idf-'))
const copy = join(dir, 'workbench.db')
copyFileSync(SOURCE, copy)
for (const suffix of ['-wal', '-shm']) if (existsSync(`${SOURCE}${suffix}`)) copyFileSync(`${SOURCE}${suffix}`, `${copy}${suffix}`)
const db = openWorkbenchDb({ dbPath: copy })

// ── 真实提问（原文） + 关键词式对照
const realRows = db.prepare(`
  SELECT query FROM knowledge_recall_log
  WHERE trigger_code = 'turn' AND length(query) > 6
  ORDER BY id DESC LIMIT 12
`).all()
const realQueries = []
for (const row of realRows) {
  const q = String(row.query).trim()
  if (q !== '' && !realQueries.includes(q)) realQueries.push(q)
}
const CONTROL = ['知识库 自动调用 会话 注入', '方向图 内存溢出 卡死', '证据链 反向验证 变异测试', '复盘 根因分析 多轮返工']

// ── 诱饵
const knowledge = listKnowledge(db, { limit: 5000 })
const corpusText = knowledge.map((e) => `${e.title}${e.contentMd}${e.tags.join('')}`.toLowerCase()).join('')
const RARE = ['龘', '靐', '齉', '爨', '麤', '黌', '鸝', '蠡', '彧', '翀', '燚', '鑫', '淼', '焱', '垚', '犇', '猋', '驫']
const outside = RARE.filter((char) => !corpusText.includes(char))
const SHARING = [
  ['方向图 内存溢出 卡死', '方问图 内存益出 卡死'],
  ['复盘 根因分析 多轮返工', '复盆 根音分析 多轮返工'],
  ['证据链 反向验证 变异测试', '证据连 反向验证 变导测试'],
  ['转台操作 SOP', '转抬操作 SOP'],
]

// ── 语料统计一览（让人能判断 idf 的刻度是否合理）
const stats = termStatsOf(knowledge.map((entry) => ({ entry, fromTask: false })))
console.log(`语料：${stats.size} 条；库外汉字样本 ${outside.slice(0, 6).join('')}（共 ${outside.length} 个）`)
const sample = ['盘', '符', '知', '识', '库', '一', '时', '序', '阈']
console.log('idf 刻度：' + sample.map((t) => `${t}=${idfOf(stats, t).toFixed(2)}(df=${stats.df.get(t) ?? 0})`).join('  '))
console.log('')

const realHitCount = (manager) => realQueries.filter((q) => manager.recallToText({ taskId: null, query: q }).hits.length > 0).length
const realVisibleCount = (manager) => realQueries.filter((q) => {
  const out = manager.recallToText({ taskId: null, query: q })
  return out.hits.length > 0 || out.nearMisses.length > 0
}).length

const invariants = (manager) => {
  const control = CONTROL.filter((q) => manager.recallToText({ taskId: null, query: q }).hits.length > 0).length
  let sharingReal = 0
  let sharingDecoy = 0
  for (const [real, decoy] of SHARING) {
    sharingReal += manager.recallToText({ taskId: null, query: real }).hits.length
    sharingDecoy += manager.recallToText({ taskId: null, query: decoy }).hits.length
  }
  let outsideHits = 0
  for (let i = 0; i + 2 < outside.length && i < 8; i += 3) {
    outsideHits += manager.recallToText({ taskId: null, query: `${outside[i]}${outside[i + 1]}${outside[i + 2]}` }).hits.length
  }
  const counts = new Map()
  for (const q of CONTROL) {
    for (const hit of manager.recallToText({ taskId: null, query: q }).hits) counts.set(hit.id, (counts.get(hit.id) ?? 0) + 1)
  }
  const repeated = [...counts.values()].filter((n) => n >= 3).length
  return { control, sharingReal, sharingDecoy, outsideHits, repeated }
}

console.log('massSat | 真实完整注入 | 真实有可见内容 | 对照 | A诱饵(诱/真) | B零命中 | C重复')
console.log('─'.repeat(96))
const MADES = [0.6, 0.8, 1.0, 1.2, 1.5]
const rows = []
for (const massSat of MADES) {
  const manager = new KnowledgeRecallManager(db, { massSat, log: () => {} })
  const inv = invariants(manager)
  const hit = realHitCount(manager)
  const visible = realVisibleCount(manager)
  rows.push({ massSat, hit, visible, ...inv })
  console.log(
    `${String(massSat).padStart(7)} | ${String(hit + '/' + realQueries.length).padStart(12)} | ${String(visible + '/' + realQueries.length).padStart(14)} | `
    + `${String(inv.control + '/' + CONTROL.length).padStart(4)} | ${String(inv.sharingDecoy + '/' + inv.sharingReal).padStart(11)} | `
    + `${String(inv.outsideHits === 0 ? '✔' : '✘ ' + inv.outsideHits).padStart(8)} | ${String(inv.repeated === 0 ? '✔' : '✘ ' + inv.repeated).padStart(6)}`,
  )
}
console.log('─'.repeat(96))
console.log('注意：massSat 越大 → 长度因子越难饱和 → 分数整体下降。选定值必须同时满足')
console.log('      「对照 4/4」「B 零命中」「C 无重复」「A 诱饵 ≤ 真实」，并让完整注入率最高。')

/**
 * 阈值也该在新量纲下重新量：`0.34` 是**旧公式**（`hits/3` 长度因子）下算出来的。
 * 换量纲后"同一个数字"不再表示同一件事 —— 但**结构约束不变**：
 * 正文权重 0.25 < 阈值，所以"只有正文命中"永远过不了线。
 */
console.log('')
console.log('minScore 扫描（massSat 固定）：真实完整注入 / 对照 / 不变量')
console.log('─'.repeat(96))
const MS = [0.36, 0.34, 0.33, 0.32, 0.30, 0.28, 0.26]
for (const massSat of MADES) {
  const cells = []
  for (const minScore of MS) {
    const manager = new KnowledgeRecallManager(db, { massSat, minScore, log: () => {} })
    const inv = invariants(manager)
    const ok = inv.control === CONTROL.length && inv.outsideHits === 0 && inv.repeated === 0 && inv.sharingDecoy <= inv.sharingReal
    cells.push(`${minScore}:${realHitCount(manager)}/${realQueries.length}${ok ? '' : '!'}`)
  }
  console.log(`massSat=${String(massSat).padStart(4)}  ${cells.join('  ')}   （! = 不变量破了；冒号前是阈值）`)
}


if (args.includes('--detail')) {
  const chosen = Number(flag('--mass', '0.6'))
  console.log(`\n=== 逐条明细（massSat=${chosen}，阈值 ${(await import('../../lib/shared/knowledgeRecall.js')).RECALL_DEFAULTS.minScore}）===`)
  const manager = new KnowledgeRecallManager(db, { massSat: chosen, minScore: 0, log: () => {} })
  for (const q of realQueries) {
    const out = manager.recallToText({ taskId: null, query: q })
    console.log(`\n「${q.slice(0, 60).replace(/\s+/g, ' ')}${q.length > 60 ? '…' : ''}」(${q.length}字) matched=${out.matched}`)
    for (const hit of out.hits.slice(0, 2)) {
      console.log(`   ${hit.score.toFixed(3)}  ${hit.title.slice(0, 40)}  ｜${hit.reason}`)
    }
  }
  const noise = '可以，先把skill做了。然后我们再讨论知识库功能bug'
  const out = manager.recallToText({ taskId: null, query: noise })
  console.log(`\n[噪声对照]「${noise}」`)
  for (const hit of out.hits.slice(0, 2)) console.log(`   ${hit.score.toFixed(3)}  ${hit.title.slice(0, 40)}  ｜${hit.reason}`)
}
db.close()
rmSync(dir, { recursive: true, force: true })
