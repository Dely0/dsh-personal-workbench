import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { submitTaskTool, updateTaskTool, requestCompletionTool } from '../lib/tools.js'
import { createTask, getTask, getDraftBySession, getPendingDraftForTask } from '../lib/db/repo.js'

test('agent tools write pending drafts and update tasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-tools-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    const submit = submitTaskTool(db)
    const out = await submit.execute(
      { title: 'clarified task', type_code: 'client_meeting', priority_code: 'p0' },
      { agent: { session: { id: 'sess-1' } } },
    )
    assert.match(out, /草稿已保存/)
    assert.ok(getDraftBySession(db, 'sess-1'))

    const update = updateTaskTool(db)
    const task = createTaskForTest(db)
    const upd = await update.execute({ task_id: task.id, description: '## 更新后描述' })
    assert.match(upd, /已更新任务/)
    assert.equal(getTask(db, task.id).description, '## 更新后描述')

    const completion = requestCompletionTool(db)
    const done = await completion.execute({ task_id: task.id, summary: '完成总结' }, { agent: { session: { id: 'sess-exec' } } })
    assert.match(done, /验收申请/)
    const pending = getPendingDraftForTask(db, 'completion', task.id)
    assert.ok(pending)
    assert.equal(getTask(db, task.id).statusCode, 'todo') // 验收前不完成
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createTaskForTest(db) {
  return createTask(db, { title: 'execution target', typeCode: 'code_impl', priorityCode: 'p1' })
}
