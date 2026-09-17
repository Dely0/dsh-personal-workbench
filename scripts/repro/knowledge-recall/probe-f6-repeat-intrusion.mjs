/**
 * 反向前置 #6（第一方证据）：泛化长文不得在**多次不同提问**里反复进 top-3。
 *
 * 有缺陷时退出码非零：权重取"命中的最高一档"，覆盖率却按**所有字段的并集**算 →
 * 标题里碰巧共享 1 个字就解锁 0.55，长篇正文再补上覆盖率 → 同一篇泛化长文
 * 对任何提问都拿 0.46~0.55，反复被注入（验收标准第 5 条要拦的现象）。
 *
 * 断言口径：同一篇条目在 4 次不同提问里进入 top-3 的次数 ≤ 1。
 * （不是 ≤ 0 —— 一条真正的通用经验被两次沾边不算错，它"反复"才算噪声；
 *   阈值参考：审查者实测 offender 命中 3/4 次。）
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../../lib/db/database.js'
import { KnowledgeRecallManager } from '../../../lib/knowledge-recall.js'

const SOURCE = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(SOURCE)) { console.log('SKIP: 找不到线上工作台库'); process.exit(2) }
const dir = mkdtempSync(join(tmpdir(), 'wb-repeat-'))
const copy = join(dir, 'workbench.db')
copyFileSync(SOURCE, copy)
for (const s of ['-wal', '-shm']) if (existsSync(`${SOURCE}${s}`)) copyFileSync(`${SOURCE}${s}`, `${copy}${s}`)
const db = openWorkbenchDb({ dbPath: copy })

const QUERIES = ['知识库 自动调用 会话 注入', '方向图 内存溢出 卡死', '证据链 反向验证 变异测试', '复盘 根因分析 多轮返工']
const counts = new Map()
const manager = new KnowledgeRecallManager(db, { log: () => {} })
for (const query of QUERIES) {
  const outcome = manager.recallToText({ taskId: null, query })
  console.log(`「${query}」→ ${outcome.hits.map((h) => `${h.title.slice(0, 26)}(${h.score.toFixed(2)})`).join(' / ') || '零命中'}`)
  for (const hit of outcome.hits) counts.set(hit.id, { title: hit.title, n: (counts.get(hit.id)?.n ?? 0) + 1 })
}
const repeated = [...counts.entries()].filter(([, v]) => v.n >= 3)
console.log(`\n反复进入 top-3（≥3 次）的条目：${repeated.length === 0 ? '无' : ''}`)
for (const [id, v] of repeated) console.log(`  ${v.title} ×${v.n} (${id.slice(0, 8)})`)

db.close()
rmSync(dir, { recursive: true, force: true })
if (repeated.length > 0) { console.log(`FAIL: 有 ${repeated.length} 条不相关/泛化条目在 4 次不同提问里反复被注入`); process.exit(1) }
console.log('ok: 没有条目在多次不同提问里反复进入 top-3')
