import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import {
  createTask, updateTask, getTask, listTasks, listArchivedTasks, listChildren,
  createDraft, confirmTaskDraft, confirmDailyPlanDraft, confirmReportDraft, getDailyPlan, updateDailyPlan, deleteDailyPlan,
  getTaskReport, listTaskReports, deleteTaskReport,
  getAiSession, registerAiSession, listReminders, ensureRecurringInstances,
  createKnowledge, listKnowledge, getKnowledge, deleteKnowledge, confirmKnowledgeDraft,
  createIdea, listIdeas, createIdeaCluster, getIdeaCluster, confirmIdeaClusterDraft, confirmIdeaTaskDraft,
  getDraftBySession, listTaskSessions, linkTaskSession, localDateString,
  completeTaskCascade, repairParentCompletion, addTaskMemory, getTaskMemoryContext, listTaskMemories,
} from '../lib/db/repo.js'

test('db migrations, dictionaries and task tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-db-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    const dicts = db.prepare('SELECT kind, COUNT(*) AS c FROM dictionaries GROUP BY kind ORDER BY kind').all()
    assert.ok(dicts.some((d) => d.kind === 'type' && d.c >= 8))
    const parent = createTask(db, { title: 'parent', typeCode: 'code_impl', priorityCode: 'p1' })
    const child = createTask(db, { title: 'child', typeCode: 'personal', priorityCode: 'p2', parentId: parent.id })
    assert.equal(listChildren(db, parent.id).length, 1)
    updateTask(db, child.id, { statusCode: 'done' })
    assert.equal(getTask(db, child.id).statusCode, 'done')
    const draft = createDraft(db, { kindCode: 'task', sessionId: 's1', payload: { title: 'from draft', typeCode: 'solution_design', priorityCode: 'p2' } })
    const task = confirmTaskDraft(db, draft.id)
    assert.equal(task.title, 'from draft')
    const draftWithReminder = createDraft(db, { kindCode: 'task', sessionId: 's1b', payload: { title: 'with reminder', typeCode: 'code_impl', priorityCode: 'p1', dueAt: '2026-08-20T10:00:00+08:00', reminderOffsetMinutes: 15, subtasks: [{ title: 'child from draft', type_code: 'code_impl', priority_code: 'p1' }] } })
    const taskWithReminder = confirmTaskDraft(db, draftWithReminder.id)
    assert.equal(listReminders(db, taskWithReminder.id).length, 1)
    assert.equal(listReminders(db, taskWithReminder.id)[0].offsetMinutes, 15)
    assert.equal(listChildren(db, taskWithReminder.id).length, 1)
    linkTaskSession(db, { taskId: task.id, sessionId: 's1', roleCode: 'clarify' })
    assert.equal(listTaskSessions(db, task.id).length, 1)
    updateTask(db, parent.id, { archived: true })
    assert.equal(listTasks(db).some((t) => t.id === parent.id), false)
    assert.equal(listArchivedTasks(db).some((t) => t.id === parent.id), true)
    // 归档列表应能展示归档任务的整棵子树（子任务即使未单独归档也随父任务可见）
    assert.equal(listArchivedTasks(db).some((t) => t.id === child.id), true)
    assert.equal(listArchivedTasks(db).length, 2)

    // V2 daily plan: draft -> confirm -> persisted per date, replace & delete work
    const planDate = localDateString()
    const planTask = createTask(db, { title: 'plan target', typeCode: 'code_impl', priorityCode: 'p2' })
    const planDraft = createDraft(db, { kindCode: 'daily_plan', sessionId: 's-plan', payload: { planDate, summary: '先清逾期', items: [{ taskId: planTask.id, order: 1, note: '先做' }] } })
    const plan = confirmDailyPlanDraft(db, planDraft.id)
    assert.equal(plan.planDate, planDate)
    assert.equal(plan.items.length, 1)
    assert.equal(getDailyPlan(db, planDate).summary, '先清逾期')
    const planDraft2 = createDraft(db, { kindCode: 'daily_plan', sessionId: 's-plan-2', payload: { planDate, summary: '第二版', items: [{ taskId: task.id, order: 1, note: '' }] } })
    confirmDailyPlanDraft(db, planDraft2.id)
    assert.equal(getDailyPlan(db, planDate).items[0].taskId, task.id)
    // V2 manual plan update: reorder/notes saved and source marked manual
    const updatedPlan = updateDailyPlan(db, planDate, { items: [
      { taskId: planTask.id, order: 1, note: '改到前面' },
      { taskId: task.id, order: 2, note: '手动备注' },
    ] })
    assert.equal(updatedPlan.sourceCode, 'manual')
    assert.equal(updatedPlan.items.length, 2)
    assert.equal(updatedPlan.items[0].taskId, planTask.id)
    assert.equal(updatedPlan.items[0].note, '改到前面')
    assert.equal(updatedPlan.items[1].note, '手动备注')
    assert.equal(getDailyPlan(db, planDate).sourceCode, 'manual')
    // validation: empty items and unknown task still throw; archived/closed tasks are allowed as plan records
    assert.throws(() => updateDailyPlan(db, planDate, { items: [] }), /at least one item/)
    assert.throws(() => updateDailyPlan(db, planDate, { items: [{ taskId: 'no-such-task', order: 1 }] }), /unknown task/)
    const donePlanTask = createTask(db, { title: 'done plan target', typeCode: 'code_impl', priorityCode: 'p2' })
    updateTask(db, donePlanTask.id, { statusCode: 'done' })
    const withDone = updateDailyPlan(db, planDate, { items: [{ taskId: donePlanTask.id, order: 1, note: '保留已完成' }] })
    assert.equal(withDone.items[0].taskId, donePlanTask.id)
    assert.equal(withDone.items[0].note, '保留已完成')
    const archivedPlanTask = createTask(db, { title: 'archived plan target', typeCode: 'code_impl', priorityCode: 'p2' })
    updateTask(db, archivedPlanTask.id, { archived: true })
    const withArchived = updateDailyPlan(db, planDate, { items: [{ taskId: archivedPlanTask.id, order: 1, note: '保留已归档' }] })
    assert.equal(withArchived.items[0].taskId, archivedPlanTask.id)
    assert.equal(withArchived.items[0].note, '保留已归档')
    const doneDraft = createDraft(db, { kindCode: 'daily_plan', sessionId: 's-done-plan', payload: { planDate, summary: '含已完成任务', items: [{ taskId: donePlanTask.id, order: 1 }] } })
    const confirmedDonePlan = confirmDailyPlanDraft(db, doneDraft.id)
    assert.equal(confirmedDonePlan.items[0].taskId, donePlanTask.id)
    assert.equal(deleteDailyPlan(db, planDate), true)
    assert.equal(getDailyPlan(db, planDate), undefined)

    // V2 reports: draft -> confirm -> persisted per period, replace & list & delete work
    const reportDraft = createDraft(db, { kindCode: 'report', sessionId: 's-report', payload: { periodCode: 'day', periodStart: planDate, title: '日报', summaryMd: '# 完成 1 项', stats: { completed: 1 } } })
    const report = confirmReportDraft(db, reportDraft.id)
    assert.equal(report.periodCode, 'day')
    assert.equal(getTaskReport(db, 'day', planDate).summaryMd, '# 完成 1 项')
    const reportDraft2 = createDraft(db, { kindCode: 'report', sessionId: 's-report-2', payload: { periodCode: 'day', periodStart: planDate, title: '日报 v2', summaryMd: '# 完成 2 项' } })
    confirmReportDraft(db, reportDraft2.id)
    assert.equal(getTaskReport(db, 'day', planDate).title, '日报 v2')
    assert.equal(listTaskReports(db, { periodCode: 'day' }).length, 1)
    assert.equal(deleteTaskReport(db, 'day', planDate), true)
    assert.equal(getTaskReport(db, 'day', planDate), undefined)

    // V2 AI session registry: one session per scope+anchor, repeated register refreshes instead of duplicating
    registerAiSession(db, { scopeCode: 'day_report', anchor: planDate, sessionId: 'sess-day-report', workspace: 'ws-1' })
    assert.equal(getAiSession(db, 'day_report', planDate).sessionId, 'sess-day-report')
    registerAiSession(db, { scopeCode: 'day_report', anchor: planDate, sessionId: 'sess-day-report-2' })
    assert.equal(getAiSession(db, 'day_report', planDate).sessionId, 'sess-day-report-2')

    // V2.4 recurring tasks: daily template lazily generates instances, idempotent per day
    const recurring = createTask(db, { title: 'daily standup', typeCode: 'team_mgmt', priorityCode: 'p2', dueAt: '2026-08-16T09:30:00+08:00', recurrenceCode: 'daily', recurrenceRule: { interval: 1, startDate: '2026-08-16', weekdays: [], monthDay: 16 } })
    assert.equal(ensureRecurringInstances(db, '2026-08-16'), 1)
    assert.equal(listChildren(db, recurring.id).length, 1)
    assert.equal(ensureRecurringInstances(db, '2026-08-17'), 1)
    assert.equal(listChildren(db, recurring.id).length, 2)
    assert.equal(ensureRecurringInstances(db, '2026-08-17'), 0)
    assert.equal(getTask(db, recurring.id).recurrenceLastGenerated, '2026-08-17')

    // knowledge base: create / search / draft confirm / delete
    const k1 = createKnowledge(db, { title: 'edge-tts 方案', kindCode: 'lesson', contentMd: '# 结论\n免费可用', tags: ['TTS', '踩坑'] })
    assert.equal(listKnowledge(db, { q: 'edge' }).length, 1)
    assert.equal(listKnowledge(db, { kindCode: 'lesson' }).length, 1)
    const kDraft = createDraft(db, { kindCode: 'knowledge', sessionId: 's-know', payload: { title: 'AI 提交的经验', contentMd: '# 内容', kindCode: 'note', tags: ['AI'], sourceReviewId: 'review-1' } })
    const kConfirmed = confirmKnowledgeDraft(db, kDraft.id)
    assert.equal(kConfirmed.title, 'AI 提交的经验')
    assert.equal(getKnowledge(db, kConfirmed.id).tags[0], 'AI')
    assert.equal(getKnowledge(db, kConfirmed.id).sourceReviewId, 'review-1')
    assert.equal(listKnowledge(db, { sourceReviewId: 'review-1' }).length, 1)
    assert.equal(deleteKnowledge(db, k1.id), true)
    assert.equal(getKnowledge(db, k1.id), undefined)

    // ideas & clusters
    const i1 = createIdea(db, { title: 'TTS 语音输出', kindCode: 'plugin', tags: ['TTS'] })
    const i2 = createIdea(db, { title: '语音备忘录', kindCode: 'skill', tags: ['语音'] })
    assert.equal(listIdeas(db, { q: '语音' }).length, 2)
    const clusterDraft = createDraft(db, { kindCode: 'idea_cluster', sessionId: 's-cluster', payload: { clusters: [{ title: '语音方向', summary: '两个语音点子', idea_ids: [i1.id, i2.id] }] } })
    const clusters = confirmIdeaClusterDraft(db, clusterDraft.id)
    assert.equal(clusters.length, 1)
    assert.equal(getIdeaCluster(db, clusters[0].id).ideas.length, 2)
    const taskDraft = createDraft(db, { kindCode: 'idea_tasks', sessionId: 's-idea-task', payload: { sourceIdeaIds: [i1.id], tasks: [{ title: '验证 TTS 方案', type_code: 'code_impl', priority_code: 'p1' }] } })
    const tasks = confirmIdeaTaskDraft(db, taskDraft.id)
    assert.equal(tasks.length, 1)
    assert.deepEqual(tasks[0].extra.sourceIdeaIds, [i1.id])
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('effective due date dynamically inherits nearest ancestor due', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-effective-due-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)

    const parent = createTask(db, { title: 'parent', typeCode: 'code_impl', priorityCode: 'p1', dueAt: '2026-08-20T10:00:00+08:00' })
    const child = createTask(db, { title: 'child', typeCode: 'code_impl', priorityCode: 'p1', parentId: parent.id })
    const grandchild = createTask(db, { title: 'grandchild', typeCode: 'code_impl', priorityCode: 'p1', parentId: child.id })
    assert.equal(getTask(db, child.id).effectiveDueAt, parent.dueAt)
    assert.equal(getTask(db, grandchild.id).effectiveDueAt, parent.dueAt)
    assert.ok(listTasks(db).every((t) => typeof t.effectiveDueAt === 'string' || t.effectiveDueAt === null))

    // 父任务修改截止时间后，未单独设置截止时间的后代自动更新
    updateTask(db, parent.id, { dueAt: '2026-08-21T09:00:00+08:00' })
    assert.equal(getTask(db, child.id).effectiveDueAt, '2026-08-21T09:00:00+08:00')
    assert.equal(getTask(db, grandchild.id).effectiveDueAt, '2026-08-21T09:00:00+08:00')

    // 已单独设置截止时间的子任务不受父任务修改影响
    const explicitChild = createTask(db, { title: 'explicit child', typeCode: 'code_impl', priorityCode: 'p1', parentId: parent.id, dueAt: '2026-08-22T08:00:00+08:00' })
    updateTask(db, parent.id, { dueAt: '2026-08-23T08:00:00+08:00' })
    assert.equal(getTask(db, explicitChild.id).effectiveDueAt, '2026-08-22T08:00:00+08:00')

    // 父任务清空截止时间后，未单独设置截止时间的后代继续继承更上层祖先（如有）
    const top = createTask(db, { title: 'top', typeCode: 'code_impl', priorityCode: 'p1', dueAt: '2026-08-24T08:00:00+08:00' })
    const mid = createTask(db, { title: 'mid', typeCode: 'code_impl', priorityCode: 'p1', parentId: top.id, dueAt: '2026-08-25T08:00:00+08:00' })
    const leaf = createTask(db, { title: 'leaf', typeCode: 'code_impl', priorityCode: 'p1', parentId: mid.id })
    assert.equal(getTask(db, leaf.id).effectiveDueAt, mid.dueAt)
    updateTask(db, mid.id, { dueAt: null })
    assert.equal(getTask(db, leaf.id).effectiveDueAt, top.dueAt)
    updateTask(db, top.id, { dueAt: null })
    assert.equal(getTask(db, leaf.id).effectiveDueAt, null)

    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status cascade aggregation, repair and shared memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-cascade-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)

    // 3 层：所有叶子完成 -> 父节点递归自动完成
    const root = createTask(db, { title: 'root', typeCode: 'code_impl', priorityCode: 'p1' })
    const child = createTask(db, { title: 'child', typeCode: 'code_impl', priorityCode: 'p1', parentId: root.id })
    const leaf1 = createTask(db, { title: 'leaf1', typeCode: 'code_impl', priorityCode: 'p1', parentId: child.id })
    const leaf2 = createTask(db, { title: 'leaf2', typeCode: 'code_impl', priorityCode: 'p1', parentId: child.id })
    completeTaskCascade(db, leaf1.id)
    assert.equal(getTask(db, child.id).statusCode, 'todo')
    completeTaskCascade(db, leaf2.id)
    assert.equal(getTask(db, child.id).statusCode, 'done')
    assert.equal(getTask(db, root.id).statusCode, 'done')
    // 幂等：重复完成不再回退/重复触发
    completeTaskCascade(db, leaf2.id)
    assert.equal(getTask(db, child.id).statusCode, 'done')
    assert.equal(getTask(db, root.id).statusCode, 'done')

    // 父任务直接完成 -> 级联完成后代
    const p2 = createTask(db, { title: 'p2', typeCode: 'code_impl', priorityCode: 'p1' })
    const c2 = createTask(db, { title: 'c2', typeCode: 'code_impl', priorityCode: 'p1', parentId: p2.id })
    const c3 = createTask(db, { title: 'c3', typeCode: 'code_impl', priorityCode: 'p1', parentId: c2.id })
    completeTaskCascade(db, p2.id)
    assert.equal(getTask(db, c2.id).statusCode, 'done')
    assert.equal(getTask(db, c3.id).statusCode, 'done')

    // 存量修复：子任务已全部完成但父任务未完成 -> 补完成，且幂等
    const p3 = createTask(db, { title: 'p3', typeCode: 'code_impl', priorityCode: 'p1' })
    const c4 = createTask(db, { title: 'c4', typeCode: 'code_impl', priorityCode: 'p1', parentId: p3.id })
    const c5 = createTask(db, { title: 'c5', typeCode: 'code_impl', priorityCode: 'p1', parentId: p3.id })
    updateTask(db, c4.id, { statusCode: 'done' })
    updateTask(db, c5.id, { statusCode: 'done' })
    assert.equal(getTask(db, p3.id).statusCode, 'todo')
    assert.equal(repairParentCompletion(db), 1)
    assert.equal(getTask(db, p3.id).statusCode, 'done')
    assert.equal(repairParentCompletion(db), 0)

    // 共享记忆：按整棵任务树共享，父/子会话都能读取
    addTaskMemory(db, { taskId: leaf1.id, kind: 'decision', content: '使用方案A' })
    assert.match(getTaskMemoryContext(db, leaf2.id), /使用方案A/)
    assert.match(getTaskMemoryContext(db, root.id), /使用方案A/)
    assert.equal(listTaskMemories(db, { taskId: leaf1.id }).length, 1)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
