import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { seedDictionaries } from '../../lib/db/seed.js'
import { createDraft, confirmTaskDraft, listTasks, getDraft } from '../../lib/db/repo.js'

const dir = mkdtempSync(join(tmpdir(), 'wb-repro-'))
const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
seedDictionaries(db)

const payload = {
  title: '仅测试，不思考，直接提交任务', typeCode: 'personal', priorityCode: 'p3', statusCode: 'todo',
  workspacePath: dir, description: 'A', subtasks: [],
}

// 场景 A：同一条草稿确认两次 —— 会不会建两条？
const d1 = createDraft(db, { kindCode: 'task', sessionId: 's1', payload })
const r1 = confirmTaskDraft(db, d1.id)
const r1b = confirmTaskDraft(db, d1.id)
console.log('[A] 同一条草稿确认两次 → 任务数:', listTasks(db).length, '| 第二次返回:', r1b?.task?.id === r1?.task?.id ? '同一任务(幂等)' : `新任务 ${r1b?.task?.id}`)
console.log('    draft status now =', getDraft(db, d1.id).statusCode)

// 场景 B：两条独立草稿（同标题、同工作区），先后确认 —— 复现 06:11:36 / 06:13:35
const d2 = createDraft(db, { kindCode: 'task', sessionId: 's2', payload: { ...payload, description: 'B' } })
const r2 = confirmTaskDraft(db, d2.id)
const all = listTasks(db)
console.log('[B] 两条独立草稿各确认一次 → 任务数:', all.length)
for (const t of all) console.log('    ', t.statusCode, t.createdAt, t.id, t.title.slice(0, 12))

rmSync(dir, { recursive: true, force: true })
