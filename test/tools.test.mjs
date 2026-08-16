import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { proposeDailyPlanTool, submitTaskTool, updateTaskTool, requestCompletionTool } from '../lib/tools.js'
import { createTask, getTask, getDraftBySession, getPendingDailyPlanDraft, getPendingDraftForTask } from '../lib/db/repo.js'

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

    const proposePlan = proposeDailyPlanTool(db)
    const t1 = createTaskForTest(db)
    const planOut = await proposePlan.execute(
      { summary: '先清逾期再推进方案', items: [{ task_id: t1.id, order: 1, note: '上午整块时间' }] },
      { agent: { session: { id: 'sess-plan' } } },
    )
    assert.match(planOut, /今日计划提案已保存/)
    const planDraft = getPendingDailyPlanDraft(db, 'sess-plan')
    assert.ok(planDraft)
    // 同一会话同日再次提交：更新同一草稿，不重复创建
    const planOut2 = await proposePlan.execute(
      { summary: '第二版排序', items: [{ task_id: t1.id, order: 1, note: '下午' }] },
      { agent: { session: { id: 'sess-plan' } } },
    )
    assert.match(planOut2, /今日计划提案已保存/)
    assert.equal(getPendingDailyPlanDraft(db, 'sess-plan').id, planDraft.id)
    // 已完成任务不能进入计划
    await updateTaskTool(db).execute({ task_id: t1.id, status_code: 'done' })
    assert.equal(getTask(db, t1.id).statusCode, 'done')
    const badPlan = await proposePlan.execute(
      { summary: '不应成功', items: [{ task_id: t1.id, order: 1, note: '' }] },
      { agent: { session: { id: 'sess-plan-bad' } } },
    )
    assert.match(badPlan, /已归档或已关闭/)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createTaskForTest(db) {
  return createTask(db, { title: 'execution target', typeCode: 'code_impl', priorityCode: 'p1' })
}
