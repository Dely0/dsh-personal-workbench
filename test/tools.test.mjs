import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { proposeDailyPlanTool, proposeIdeaClustersTool, submitIdeaTasksTool, submitKnowledgeTool, submitReportTool, submitTaskTool, updateTaskTool, requestCompletionTool } from '../lib/tools.js'
import { createIdea, createTask, getTask, getDraftBySession, getPendingDailyPlanDraft, getPendingDraftForSession, getPendingDraftForTask, getPendingReportDraft, updateTask } from '../lib/db/repo.js'

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

    // AI 可能发明/使用字典外的 type_code：training 应合法，未知 code 应回退不报错
    const training = await submit.execute({ title: '学做东北菜', type_code: 'training', priority_code: 'p2' }, { agent: { session: { id: 'sess-training' } } })
    assert.match(training, /草稿已保存/)
    assert.equal(getDraftBySession(db, 'sess-training').payload.typeCode, 'training')
    const unknown = await submit.execute({ title: '未知类型任务', type_code: 'foobar', priority_code: 'p2' }, { agent: { session: { id: 'sess-unknown' } } })
    assert.match(unknown, /草稿已保存/)
    assert.equal(getDraftBySession(db, 'sess-unknown').payload.typeCode, 'personal')

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
    // 幂等：同一任务再次申请完成，更新同一草稿
    await completion.execute({ task_id: task.id, summary: '完成总结 v2' }, { agent: { session: { id: 'sess-exec' } } })
    assert.equal(getPendingDraftForTask(db, 'completion', task.id).id, pending.id)
    // AI 不能直接关闭任务
    const deniedClose = await update.execute({ task_id: task.id, status_code: 'done' })
    assert.match(deniedClose, /不能直接/)

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
    updateTask(db, t1.id, { statusCode: 'done' })
    assert.equal(getTask(db, t1.id).statusCode, 'done')
    const badPlan = await proposePlan.execute(
      { summary: '不应成功', items: [{ task_id: t1.id, order: 1, note: '' }] },
      { agent: { session: { id: 'sess-plan-bad' } } },
    )
    assert.match(badPlan, /已归档或已关闭/)

    const submitReport = submitReportTool(db)
    const reportOut = await submitReport.execute(
      { period_code: 'day', period_start: localDateStr(), title: '日报', summary_md: '# 今日' },
      { agent: { session: { id: 'sess-report' } } },
    )
    assert.match(reportOut, /报告草稿已保存/)
    const reportDraft = getPendingReportDraft(db, 'sess-report', 'day', localDateStr())
    assert.ok(reportDraft)
    const reportOut2 = await submitReport.execute(
      { period_code: 'day', period_start: localDateStr(), title: '日报 v2', summary_md: '# 今日 v2' },
      { agent: { session: { id: 'sess-report' } } },
    )
    assert.match(reportOut2, /报告草稿已保存/)
    assert.equal(getPendingReportDraft(db, 'sess-report', 'day', localDateStr()).id, reportDraft.id)

    const submitKnowledge = submitKnowledgeTool(db)
    const kOut = await submitKnowledge.execute(
      { title: '经验：先验证再开发', content_md: '# 结论', kind_code: 'lesson', tags: ['流程'] },
      { agent: { session: { id: 'sess-know' } } },
    )
    assert.match(kOut, /知识草稿已保存/)
    assert.match(await submitKnowledge.execute(
      { title: '经验：先验证再开发 v2', content_md: '# 结论 v2', kind_code: 'lesson', tags: ['流程'] },
      { agent: { session: { id: 'sess-know' } } },
    ), /知识草稿已保存/)

    const idea1 = createIdea(db, { title: '点子A', kindCode: 'spark', tags: ['x'] })
    const idea2 = createIdea(db, { title: '点子B', kindCode: 'plugin', tags: ['x'] })
    const clusterTool = proposeIdeaClustersTool(db)
    const cOut = await clusterTool.execute({ clusters: [{ title: 'X 方向', summary: '相关', idea_ids: [idea1.id, idea2.id] }] }, { agent: { session: { id: 'sess-cluster' } } })
    assert.match(cOut, /点子王提案已保存/)
    assert.ok(getPendingDraftForSession(db, 'sess-cluster', 'idea_cluster'))
    const taskTool = submitIdeaTasksTool(db)
    const tOut = await taskTool.execute({ source_idea_ids: [idea1.id], tasks: [{ title: '落地A', type_code: 'code_impl', priority_code: 'p1' }], summary: '结论' }, { agent: { session: { id: 'sess-idea-task' } } })
    assert.match(tOut, /点子落地任务提案已保存/)
    assert.ok(getPendingDraftForSession(db, 'sess-idea-task', 'idea_tasks'))
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createTaskForTest(db) {
  return createTask(db, { title: 'execution target', typeCode: 'code_impl', priorityCode: 'p1', aiPolicyCode: 'execute' })
}

function localDateStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
