/**
 * P2 的**真库副本前后对照**（可重跑的证据，不写线上库）。
 *
 * 做法：把线上库复制一份 → 在副本上迁移到 schema 18 → 造一对"写错的 / 修正的"条目
 * （与用户当时的真实操作同形：删掉旧条 + 新建修正条，正文里手写一句"以本条为准"）→
 * 先证明两条**都会**被召回（这就是问题本身），再标注取代关系 → 复验旧条被压制。
 *
 * ## 为什么是在副本上、而不是直接改线上库
 *
 * 线上库当前是 schema 17，装盘中的插件还是 v1.15.7 之前那一版；
 * 一旦打开它就会把 schema 推到 18，正在跑的旧插件下次启动会读到"schema 比它新"而整体降级。
 * 所以线上改动属于**装盘之后**的动作（见 `scripts/knowledge-supersede.mjs` 的前置守卫）。
 *
 * 用法：node scripts/repro/verify-supersede.mjs
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { createKnowledge, updateKnowledge } from '../../lib/db/repo.js'
import { KnowledgeRecallManager } from '../../lib/knowledge-recall.js'

const SOURCE = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(SOURCE)) { console.error(`找不到工作台库 ${SOURCE}`); process.exit(2) }

const dir = mkdtempSync(join(tmpdir(), 'wb-verify-supersede-'))
const copy = join(dir, 'workbench.db')
copyFileSync(SOURCE, copy)
for (const suffix of ['-wal', '-shm']) if (existsSync(`${SOURCE}${suffix}`)) copyFileSync(`${SOURCE}${suffix}`, `${copy}${suffix}`)

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

function rawVersion() {
  const raw = new DatabaseSync(copy, { readOnly: true })
  const row = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  raw.close()
  return row === undefined ? 0 : Number(row.value)
}
const before = rawVersion()
const db = openWorkbenchDb({ dbPath: copy })
const after = rawVersion()
console.log(`线上库副本 schema：${before} → ${after}（打开即迁移）`)
check('迁移到 18（加 superseded_by_id / valid_until 两列，老条目行为不变）', after === 18, `version=${after}`)
const columns = db.prepare('PRAGMA table_info(knowledge_entries)').all().map((row) => String(row.name))
check('两列都真的加上了', columns.includes('superseded_by_id') && columns.includes('valid_until'))
const untouched = db.prepare('SELECT COUNT(*) AS c FROM knowledge_entries WHERE superseded_by_id IS NULL AND valid_until IS NULL').get()
check('迁移只加列，不改任何既有行', Number(untouched.c) === 61, `未标注的仍有 ${untouched.c} 条`)

/** 造一对同形条目（标题高度重合，保证两条都会被召回）。 */
const wrong = createKnowledge(db, { title: '复盘：dsh-ui 围栏降级排查（初版结论）', contentMd: '结论：根因是 DOM 通道没接管。', kindCode: 'lesson' })
const fixed = createKnowledge(db, { title: '复盘：dsh-ui 围栏降级排查（修正结论）', contentMd: '结论：根因是 spec 字段错，与渲染通道无关。', kindCode: 'lesson' })
const query = '复盘 dsh-ui 围栏 降级排查'

const manager = new KnowledgeRecallManager(db, { log: () => {} })
const pre = manager.recallToText({ taskId: null, query })
console.log(`\n标注前召回「${query}」：${pre.hits.map((hit) => hit.title).join(' / ') || '（零命中）'}`)
check('前置：两条**都会**被带出来（这就是"作废结论进上下文"的问题现场）', pre.hits.some((h) => h.id === wrong.id) && pre.hits.some((h) => h.id === fixed.id))

updateKnowledge(db, wrong.id, { supersededById: fixed.id })
manager.invalidate()
const post = manager.recallToText({ taskId: null, query })
console.log(`标注后召回：${post.hits.map((hit) => hit.title).join(' / ') || '（零命中）'}；压制 ${post.droppedAsSuperseded} 条`)
check('标注取代后：修正条仍然被召回', post.hits.some((h) => h.id === fixed.id))
check('标注取代后：作废的那条**不再**被召回', !post.hits.some((h) => h.id === wrong.id))
check('压制条数如实记账（不是混进 droppedByScore）', post.droppedAsSuperseded >= 1, `droppedAsSuperseded=${post.droppedAsSuperseded}`)

updateKnowledge(db, fixed.id, { validUntil: '2020-01-01T00:00:00.000Z' })
manager.invalidate()
const expired = manager.recallToText({ taskId: null, query })
console.log(`再把修正条设成已过期：命中 ${expired.hits.length} 条；压制 ${expired.droppedAsSuperseded} 条`)
check('已过期的条目同样被压制',
  expired.hits.some((hit) => hit.id === wrong.id) === false && expired.hits.some((hit) => hit.id === fixed.id) === false && expired.droppedAsSuperseded >= 2,
  `命中 ${expired.hits.length} 条（库里本来还有一条同主题的老条目，它不该被牵连）`)

updateKnowledge(db, fixed.id, { validUntil: null, supersededById: null })
updateKnowledge(db, wrong.id, { supersededById: null })
manager.invalidate()
const restored = manager.recallToText({ taskId: null, query })
check('解除标注后两条都回来了（可逆，不是单向删除）', restored.hits.length >= 2, `命中 ${restored.hits.length} 条`)

db.close()
rmSync(dir, { recursive: true, force: true })
const failed = results.filter((ok) => !ok).length
if (failed > 0) { console.error(`\n❌ ${failed}/${results.length} 项失败`); process.exit(1) }
console.log(`\n✅ ${results.length}/${results.length} 项通过（副本来去即焚，线上库一字未动）`)
