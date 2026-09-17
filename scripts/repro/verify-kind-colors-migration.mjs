/**
 * 迁移 16 在**真实库副本**上的验证（绝不碰线上库）。
 *
 * 断言：知识库/点子类型被回填颜色、已有颜色不被动、字段不被覆盖、其他字典不受影响、
 * 版本号推进到 16、重复跑幂等。
 *
 * 用法：node scripts/repro/verify-kind-colors-migration.mjs
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../../lib/db/database.js'
import { SCHEMA_VERSION } from '../../lib/db/schema.js'

const LIVE = join(process.env.USERPROFILE ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(LIVE)) { console.error('SKIP: 找不到线上库 ' + LIVE); process.exit(2) }

const work = join(tmpdir(), 'wb-migration-check')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const copy = join(work, 'workbench-copy.db')
copyFileSync(LIVE, copy)

const db = new DatabaseSync(copy)

const readKind = (kind) => db.prepare('SELECT code, config FROM dictionaries WHERE kind = ? ORDER BY sort_order').all(kind)
const version = () => Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : '  — ' + detail}`)
}

const before = version()
console.log(`副本版本：${before} → 目标 ${SCHEMA_VERSION}\n`)
console.log('迁移前 knowledge_kind：', JSON.stringify(readKind('knowledge_kind')))
console.log('迁移前 idea_kind：      ', JSON.stringify(readKind('idea_kind')))
console.log('')

// 造两个"用户已经自己配过"的场景，验证不会被覆盖
db.prepare("UPDATE dictionaries SET config = ? WHERE kind = 'knowledge_kind' AND code = 'note'").run(JSON.stringify({ color: '#123456', 自定义: '保留我' }))
db.prepare("UPDATE dictionaries SET config = ? WHERE kind = 'idea_kind' AND code = 'skill'").run(JSON.stringify({ color: '#654321' }))
// 造一个"停用 + 改过名"的行，颜色仍应被补上
db.prepare("UPDATE dictionaries SET active = 0, name = '我改过的名字' WHERE kind = 'knowledge_kind' AND code = 'decision'").run()
// 造一行脏 config（不是合法 JSON）——不该把迁移搞崩
db.prepare("UPDATE dictionaries SET config = 'not-json' WHERE kind = 'idea_kind' AND code = 'random'").run()

migrate(db)

const after = version()
check('版本推进到 16', after === 16, `${before} → ${after}`)

const knowledge = Object.fromEntries(readKind('knowledge_kind').map((r) => [r.code, JSON.parse(r.config)]))
const idea = Object.fromEntries(readKind('idea_kind').map((r) => [r.code, JSON.parse(r.config)]))

check('知识库类型全部有颜色', ['note', 'lesson', 'decision', 'snippet'].every((c) => typeof knowledge[c].color === 'string' && knowledge[c].color.startsWith('#')), JSON.stringify(knowledge))
check('点子类型全部有颜色', ['project', 'skill', 'plugin', 'spark', 'random'].every((c) => typeof idea[c].color === 'string' && idea[c].color.startsWith('#')), JSON.stringify(idea))
check('用户自己配过的颜色**不被覆盖**', knowledge.note.color === '#123456' && idea.skill.color === '#654321', `note=${knowledge.note.color} skill=${idea.skill.color}`)
check('用户在同一 config 里的其他字段被保留', knowledge.note['自定义'] === '保留我', JSON.stringify(knowledge.note))
check('停用/改名的行也补上颜色', knowledge.decision.color === '#8B7BE8', JSON.stringify(knowledge.decision))
check('脏 config（非法 JSON）不崩，且补上颜色', typeof idea.random.color === 'string', JSON.stringify(idea.random))
check('补的颜色互不相同（能区分类型）', new Set(['note', 'lesson', 'decision', 'snippet'].map((c) => knowledge[c].color)).size === 4, JSON.stringify(['note', 'lesson', 'decision', 'snippet'].map((c) => knowledge[c].color)))

// 其他字典不该被动到
const typeColors = db.prepare("SELECT code, config FROM dictionaries WHERE kind = 'type'").all().map((r) => JSON.parse(r.config).color)
check('任务类型字典未受影响', typeColors.every((c) => typeof c === 'string'), JSON.stringify(typeColors))

// 幂等：再跑一次不应改变任何东西
const snapshot = JSON.stringify(db.prepare('SELECT kind, code, config FROM dictionaries ORDER BY kind, code').all())
migrate(db)
check('重复跑幂等（再跑一次内容不变）', JSON.stringify(db.prepare('SELECT kind, code, config FROM dictionaries ORDER BY kind, code').all()) === snapshot)

db.close()
rmSync(work, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`迁移 16 验证（真实库副本）：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail)
  process.exit(1)
}
