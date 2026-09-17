/**
 * P1b 引入的**新开销**实测：`termStatsOf` 要扫全库正文统计 df。
 *
 * 之前每个回合只读候选行、不扫正文；现在多了这一步（与候选集同缓存、15s TTL）。
 * 本脚本在真库副本上量三件事：候选加载+统计（缓存未命中）、缓存命中的召回、以及
 * 逐条放大到 1000 / 5000 条时的外推。
 *
 * 用法：node scripts/repro/bench-idf-stats.mjs
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { KnowledgeRecallManager } from '../../lib/knowledge-recall.js'
import { createKnowledge, listKnowledge } from '../../lib/db/repo.js'

const SOURCE = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(SOURCE)) { console.error(`找不到工作台库 ${SOURCE}`); process.exit(2) }
const dir = mkdtempSync(join(tmpdir(), 'wb-bench-idf-'))
const copy = join(dir, 'workbench.db')
copyFileSync(SOURCE, copy)
for (const suffix of ['-wal', '-shm']) if (existsSync(`${SOURCE}${suffix}`)) copyFileSync(`${SOURCE}${suffix}`, `${copy}${suffix}`)
const db = openWorkbenchDb({ dbPath: copy })

const entries = listKnowledge(db, { limit: 5000 })
const totalChars = entries.reduce((sum, entry) => sum + entry.title.length + entry.contentMd.length + entry.tags.join('').length, 0)
console.log(`真库：${entries.length} 条，参与统计的字符总量约 ${Math.round(totalChars / 10000)} 万`)

const manager = new KnowledgeRecallManager(db, { log: () => {} })
let t = performance.now()
manager.recallToText({ taskId: null, query: '盘符 根目录 文件选择' })
const cold = performance.now() - t

t = performance.now()
for (let i = 0; i < 20; i += 1) manager.recallToText({ taskId: null, query: `盘符 根目录 文件选择 ${i}` })
const warm = (performance.now() - t) / 20

console.log(`首次召回（加载候选 + 统计 df + 打分）：${cold.toFixed(1)} ms`)
console.log(`缓存命中后的召回（仅打分）：${warm.toFixed(2)} ms`)

/** 外推：按"每条 1600 字"批量插入，看统计那一步的代价随条数怎么涨。 */
for (const target of [500, 2000, 5000]) {
  const need = target - listKnowledge(db, { limit: 5000 }).length
  if (need <= 0) continue
  const body = '这是一段用于压测的正文。'.repeat(160)
  for (let i = 0; i < need; i += 1) createKnowledge(db, { title: `压测条目 ${target}-${i} 盘符根目录压测`, contentMd: body })
  const scaled = new KnowledgeRecallManager(db, { log: () => {} })
  const start = performance.now()
  scaled.recallToText({ taskId: null, query: '盘符 根目录 压测' })
  console.log(`语料 ${target} 条时首次召回（含统计）：${(performance.now() - start).toFixed(1)} ms`)
}

db.close()
rmSync(dir, { recursive: true, force: true })
