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
  createKnowledge, updateKnowledge, listKnowledge, getKnowledge, deleteKnowledge, confirmKnowledgeDraft,
  createIdea, listIdeas, createIdeaCluster, getIdeaCluster, confirmIdeaClusterDraft, confirmIdeaTaskDraft,
  getDraftBySession, listTaskSessions, linkTaskSession, localDateString,
  completeTaskCascade, repairParentCompletion, addTaskMemory, getTaskMemoryContext, listTaskMemories,
  archiveTask, restoreTask, confirmSubtaskPlanDraft, validateDraftTaskItem,
  listActiveDictionaryCodes, listTaskEvents, isDescendantOf,
} from '../lib/db/repo.js'

/**
 * 回归：子任务 type_code 非法时**不能静默丢弃**。
 *
 * 真实事故：提交 1 父任务 + 5 子任务，其中两项的 type_code 用了字典外的 `ops`
 * → 用户确认后只创建出 3 个子任务，另两项凭空消失且接口返回成功。
 * 见 docs/issues/2026-09-12-subtask-type-code-silently-dropped.md
 */
test('confirmTaskDraft reports invalid subtask codes instead of silently dropping them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-drop-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)

    const draft = createDraft(db, {
      kindCode: 'task',
      sessionId: 's-drop',
      payload: {
        title: '父任务', typeCode: 'code_impl', priorityCode: 'p1',
        subtasks: [
          { title: '合法子任务 A', type_code: 'code_impl', priority_code: 'p1' },
          { title: '非法类型子任务', type_code: 'ops', priority_code: 'p1' },
          { title: '合法子任务 B', type_code: 'personal', priority_code: 'p2' },
          // 非法父项下面的合法子项：整棵子树都不该建，且只报父项一条
          { title: '非法优先级子任务', type_code: 'code_impl', priority_code: 'p9', children: [{ title: '孙子任务', type_code: 'code_impl', priority_code: 'p1' }] },
        ],
      },
    })
    const result = confirmTaskDraft(db, draft.id)
    assert.equal(result.task.title, '父任务')
    // 创建出来的只有 2 个合法子任务（孙子任务没建，因为它的父项非法）
    assert.equal(result.childCount, 2)
    assert.equal(listChildren(db, result.task.id).length, 2)
    assert.deepEqual(listChildren(db, result.task.id).map((t) => t.title).sort(), ['合法子任务 A', '合法子任务 B'])
    // 两个问题项都要被报出来，并且带原因与非法值
    assert.equal(result.problems.length, 2)
    const badType = result.problems.find((p) => p.field === 'typeCode')
    assert.equal(badType.code, 'ops')
    assert.equal(badType.title, '非法类型子任务')
    assert.match(badType.reason, /不在字典中/)
    const badPriority = result.problems.find((p) => p.field === 'priorityCode')
    assert.equal(badPriority.code, 'p9')
    assert.match(badPriority.reason, /不在字典中/)
    // 「非法父项」不再牵连出第三条 problem（整棵子树跳过只报一条）
    assert.equal(result.problems.some((p) => p.title === '孙子任务'), false)

    // subtask_plan 路径同样不再静默丢件
    const parent = createTask(db, { title: 'plan parent', typeCode: 'code_impl', priorityCode: 'p1' })
    const planDraft = createDraft(db, {
      kindCode: 'subtask_plan',
      sessionId: 's-drop-2',
      payload: {
        parentTaskId: parent.id,
        subtasks: [{ title: '好节点', type_code: 'code_impl', priority_code: 'p1' }, { title: '坏节点', type_code: 'not_a_type', priority_code: 'p1' }],
      },
    })
    const planResult = confirmSubtaskPlanDraft(db, planDraft.id)
    assert.equal(planResult.tasks.length, 1)
    assert.equal(planResult.tasks[0].title, '好节点')
    assert.equal(planResult.problems.length, 1)
    assert.equal(planResult.problems[0].code, 'not_a_type')

    // 全合法时 problems 为空（正常路径零噪音）
    const okDraft = createDraft(db, {
      kindCode: 'task', sessionId: 's-drop-3',
      payload: { title: '全合法', typeCode: 'code_impl', priorityCode: 'p1', subtasks: [{ title: 'x', type_code: 'code_impl', priority_code: 'p1' }] },
    })
    const okResult = confirmTaskDraft(db, okDraft.id)
    assert.deepEqual(okResult.problems, [])
    assert.equal(okResult.childCount, 1)

    // 只读字典枚举：让 AI 不必靠猜 code（同一事故的根因之一）
    const typeCodes = listActiveDictionaryCodes(db, 'type')
    assert.ok(typeCodes.includes('code_impl'))
    assert.ok(typeCodes.includes('personal'))
    assert.equal(typeCodes.includes('ops'), false)
    assert.ok(listActiveDictionaryCodes(db, 'priority').includes('p2'))

    // 校验器本身：非法 code 返回问题项，合法返回 undefined
    assert.equal(validateDraftTaskItem(db, { title: 'ok', input: { typeCode: 'code_impl', priorityCode: 'p1' } }), undefined)
    assert.equal(validateDraftTaskItem(db, { title: 'bad', input: { typeCode: 'ops', priorityCode: 'p1' } }).field, 'typeCode')

    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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
    const task = confirmTaskDraft(db, draft.id).task
    assert.equal(task.title, 'from draft')
    const draftWithReminder = createDraft(db, { kindCode: 'task', sessionId: 's1b', payload: { title: 'with reminder', typeCode: 'code_impl', priorityCode: 'p1', dueAt: '2026-08-20T10:00:00+08:00', reminderOffsetMinutes: 15, subtasks: [{ title: 'child from draft', type_code: 'code_impl', priority_code: 'p1' }] } })
    const taskWithReminder = confirmTaskDraft(db, draftWithReminder.id).task
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

    // knowledge base: create / search / draft confirm / file_link / delete
    const k1 = createKnowledge(db, { title: 'edge-tts 方案', kindCode: 'lesson', contentMd: '# 结论\n免费可用', tags: ['TTS', '踩坑'], fileLink: 'D:\\docs\\edge-tts.md' })
    assert.equal(getKnowledge(db, k1.id).fileLink, 'D:\\docs\\edge-tts.md')
    assert.equal(listKnowledge(db, { q: 'edge' }).length, 1)
    assert.equal(listKnowledge(db, { kindCode: 'lesson' }).length, 1)
    const updatedK1 = updateKnowledge(db, k1.id, { fileLink: 'file:///mnt/d/docs/edge-tts.md' })
    assert.equal(updatedK1.fileLink, 'file:///mnt/d/docs/edge-tts.md')
    assert.equal(getKnowledge(db, k1.id).fileLink, 'file:///mnt/d/docs/edge-tts.md')
    // file_link 必须是 file:// 或绝对路径，相对路径/空值会被拒绝
    assert.throws(() => createKnowledge(db, { title: 'bad link', kindCode: 'note', contentMd: 'x', fileLink: 'docs/a.md' }), /fileLink must be a file:\/\/ URL or an absolute path/)
    assert.throws(() => updateKnowledge(db, k1.id, { fileLink: 'relative/path.md' }), /fileLink must be a file:\/\/ URL or an absolute path/)
    const kDraft = createDraft(db, { kindCode: 'knowledge', sessionId: 's-know', payload: { title: 'AI 提交的经验', contentMd: '# 内容', kindCode: 'note', tags: ['AI'], sourceReviewId: 'review-1', fileLink: '/mnt/d/docs/ai.md' } })
    const kConfirmed = confirmKnowledgeDraft(db, kDraft.id)
    assert.equal(kConfirmed.title, 'AI 提交的经验')
    assert.equal(getKnowledge(db, kConfirmed.id).tags[0], 'AI')
    assert.equal(getKnowledge(db, kConfirmed.id).sourceReviewId, 'review-1')
    assert.equal(getKnowledge(db, kConfirmed.id).fileLink, '/mnt/d/docs/ai.md')
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

test('subtask_plan confirm is idempotent and preserves estimated_minutes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-subtask-plan-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)

    const parent = createTask(db, { title: 'parent', typeCode: 'code_impl', priorityCode: 'p1' })
    // 提案工具写 snake_case（type_code / estimated_minutes），与 workbench_propose_subtasks 一致
    const payload = {
      parentTaskId: parent.id,
      subtasks: [
        {
          title: 'design layer', type_code: 'solution_design', priority_code: 'p1', estimated_minutes: 195,
          children: [{ title: 'contract', type_code: 'solution_design', priority_code: 'p1', estimated_minutes: 90 }],
        },
        { title: 'scheduler', type_code: 'code_impl', priority_code: 'p1', estimated_minutes: 240 },
      ],
    }
    const draft = createDraft(db, { kindCode: 'subtask_plan', sessionId: 's-breakdown', payload })
    const created = confirmSubtaskPlanDraft(db, draft.id).tasks
    assert.equal(created.length, 3)
    assert.equal(created[0].estimatedMinutes, 195)
    assert.equal(created[1].estimatedMinutes, 90)
    assert.equal(created[2].estimatedMinutes, 240)
    assert.equal(listChildren(db, parent.id).length, 2)

    // 重复确认同一份（或同标题）提案：复用既有节点，不再重复建树
    const draft2 = createDraft(db, { kindCode: 'subtask_plan', sessionId: 's-breakdown-2', payload })
    const again = confirmSubtaskPlanDraft(db, draft2.id).tasks
    assert.equal(again.length, 3)
    assert.deepEqual(again.map((t) => t.id), created.map((t) => t.id))
    assert.equal(listChildren(db, parent.id).length, 2)
    assert.equal(listChildren(db, created[0].id).length, 1)
    assert.equal(listTasks(db, { parentId: parent.id }).length, 2)

    // 复用不覆盖用户对既有任务的编辑
    updateTask(db, created[2].id, { title: 'scheduler' })
    const renamed = createTask(db, { title: 'renamed by user', typeCode: 'code_impl', priorityCode: 'p1', parentId: parent.id })
    const draft3 = createDraft(db, { kindCode: 'subtask_plan', sessionId: 's-breakdown-3', payload: { parentTaskId: parent.id, subtasks: [{ title: 'renamed by user', type_code: 'code_impl', priority_code: 'p1', estimated_minutes: 999 }] } })
    const reused = confirmSubtaskPlanDraft(db, draft3.id).tasks
    assert.equal(reused[0].id, renamed.id)
    assert.equal(getTask(db, renamed.id).estimatedMinutes, null)

    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('idea_tasks confirm preserves estimated_minutes written in snake_case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-idea-est-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)

    const idea = createIdea(db, { title: 'idea', contentMd: 'x' })
    const draft = createDraft(db, {
      kindCode: 'idea_tasks',
      sessionId: 's-idea',
      payload: {
        sourceIdeaIds: [idea.id],
        sourceClusterId: null,
        tasks: [{ title: 'from idea', type_code: 'code_impl', priority_code: 'p1', estimated_minutes: 1095 }],
      },
    })
    const created = confirmIdeaTaskDraft(db, draft.id)
    assert.equal(created.length, 1)
    assert.equal(created[0].estimatedMinutes, 1095)

    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('archiving a task hides its descendants from the active list but keeps them restorable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-archive-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)

    const root = createTask(db, { title: 'root', typeCode: 'code_impl', priorityCode: 'p1' })
    const mid = createTask(db, { title: 'mid', typeCode: 'code_impl', priorityCode: 'p1', parentId: root.id })
    const leaf = createTask(db, { title: 'leaf', typeCode: 'code_impl', priorityCode: 'p1', parentId: mid.id })
    const other = createTask(db, { title: 'other', typeCode: 'code_impl', priorityCode: 'p1' })

    // 默认：只归档单节点；其后代不再出现在活跃列表（否则前端建树会平铺成"重复任务"）
    archiveTask(db, root.id)
    const active = listTasks(db)
    assert.equal(active.some((t) => t.id === root.id), false)
    assert.equal(active.some((t) => t.id === mid.id), false)
    assert.equal(active.some((t) => t.id === leaf.id), false)
    assert.equal(active.some((t) => t.id === other.id), true)
    // 归档视图仍带出整棵子树
    const archived = listArchivedTasks(db)
    assert.equal(archived.length, 3)
    assert.equal(archived.some((t) => t.id === leaf.id), true)
    // 子任务自身 archived 仍为 0：可单独恢复，父恢复后重新出现
    assert.equal(getTask(db, leaf.id).archived, 0)
    restoreTask(db, root.id)
    assert.equal(listTasks(db).some((t) => t.id === leaf.id), true)

    // cascade: true 时整棵子树一起归档
    const root2 = createTask(db, { title: 'root2', typeCode: 'code_impl', priorityCode: 'p1' })
    const child2 = createTask(db, { title: 'child2', typeCode: 'code_impl', priorityCode: 'p1', parentId: root2.id })
    const grand2 = createTask(db, { title: 'grand2', typeCode: 'code_impl', priorityCode: 'p1', parentId: child2.id })
    archiveTask(db, root2.id, 'user', { cascade: true })
    assert.equal(getTask(db, root2.id).archived, 1)
    assert.equal(getTask(db, child2.id).archived, 1)
    assert.equal(getTask(db, grand2.id).archived, 1)
    // 每个节点各留一条 updated 事件
    const events = db.prepare("SELECT COUNT(*) AS c FROM task_events WHERE event_code = 'updated'").get()
    assert.ok(events.c >= 3)
    restoreTask(db, root2.id)
    restoreTask(db, child2.id)
    restoreTask(db, grand2.id)
    assert.equal(listTasks(db).some((t) => t.id === grand2.id), true)

    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('effective workspace path dynamically inherits nearest ancestor workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-effective-ws-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)

    const parent = createTask(db, { title: 'parent', typeCode: 'code_impl', priorityCode: 'p1', workspacePath: '/mnt/d/Code/A' })
    const child = createTask(db, { title: 'child', typeCode: 'code_impl', priorityCode: 'p1', parentId: parent.id })
    const grandchild = createTask(db, { title: 'grandchild', typeCode: 'code_impl', priorityCode: 'p1', parentId: child.id })
    assert.equal(getTask(db, child.id).effectiveWorkspacePath, '/mnt/d/Code/A')
    assert.equal(getTask(db, grandchild.id).effectiveWorkspacePath, '/mnt/d/Code/A')

    // 父任务改工作区 -> 未自设的后代自动跟随
    updateTask(db, parent.id, { workspacePath: '/mnt/d/Code/B' })
    assert.equal(getTask(db, child.id).effectiveWorkspacePath, '/mnt/d/Code/B')
    assert.equal(getTask(db, grandchild.id).effectiveWorkspacePath, '/mnt/d/Code/B')
    // 子任务自身 workspacePath 仍为空（动态继承，不写库）
    assert.equal(getTask(db, child.id).workspacePath, null)

    // 子任务显式设过工作区后，不再受父任务影响
    updateTask(db, child.id, { workspacePath: '/mnt/d/Code/C' })
    updateTask(db, parent.id, { workspacePath: '/mnt/d/Code/D' })
    assert.equal(getTask(db, child.id).effectiveWorkspacePath, '/mnt/d/Code/C')
    assert.equal(getTask(db, grandchild.id).effectiveWorkspacePath, '/mnt/d/Code/C')

    // 中间层清空后，重新继承更上层
    updateTask(db, child.id, { workspacePath: null })
    assert.equal(getTask(db, grandchild.id).effectiveWorkspacePath, '/mnt/d/Code/D')
    updateTask(db, parent.id, { workspacePath: null })
    assert.equal(getTask(db, grandchild.id).effectiveWorkspacePath, null)

    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 改父任务（re-parent）：这条路径以前不存在，只能直接改库（scripts/reparent-tasks.mjs），
 * 既绕过事件日志也绕过任何校验。这里覆盖：真的写库、能移到顶层、四种非法移动被拒、
 * 审计事件、以及移动后有效截止/工作区跟随新父任务。
 */
test('改父任务：写库 / 移到顶层 / 防环守卫 / 审计事件 / 继承跟随新父任务', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-reparent-'))
  let db
  try {
    db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)

    const parentIdOf = (id) => db.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(id).parent_id
    const reparentEvents = (id) => listTaskEvents(db, id).filter((event) => event.event_code === 'reparented')

    const oldParent = createTask(db, { title: '旧父任务', typeCode: 'code_impl', priorityCode: 'p1', dueAt: '2026-09-10T09:00:00+08:00', workspacePath: '/mnt/d/Code/OLD' })
    const newParent = createTask(db, { title: '新父任务', typeCode: 'code_impl', priorityCode: 'p1', dueAt: '2026-09-30T18:00:00+08:00', workspacePath: '/mnt/d/Code/NEW' })
    const moving = createTask(db, { title: '被移动的任务', typeCode: 'code_impl', priorityCode: 'p1', parentId: oldParent.id })
    const child = createTask(db, { title: '它的子任务', typeCode: 'code_impl', priorityCode: 'p1', parentId: moving.id })
    const grandchild = createTask(db, { title: '它的孙任务', typeCode: 'code_impl', priorityCode: 'p1', parentId: child.id })

    // 移动前：有效截止/工作区都跟随旧父任务
    assert.equal(getTask(db, moving.id).effectiveDueAt, oldParent.dueAt)
    assert.equal(getTask(db, moving.id).effectiveWorkspacePath, '/mnt/d/Code/OLD')

    // ① 移到另一个父任务下：parent_id 真的写进库了
    const moved = updateTask(db, moving.id, { parentId: newParent.id })
    assert.equal(moved.parentId, newParent.id)
    assert.equal(parentIdOf(moving.id), newParent.id)
    assert.equal(getTask(db, moving.id).parentId, newParent.id)
    assert.deepEqual(listChildren(db, newParent.id).map((task) => task.id), [moving.id])
    assert.equal(listChildren(db, oldParent.id).length, 0)

    // ② 移动后 effectiveDueAt / effectiveWorkspacePath 跟随新父任务（子树一起跟）
    assert.equal(moved.effectiveDueAt, newParent.dueAt)
    assert.equal(moved.effectiveWorkspacePath, '/mnt/d/Code/NEW')
    assert.equal(getTask(db, moving.id).effectiveDueAt, newParent.dueAt)
    assert.equal(getTask(db, moving.id).effectiveWorkspacePath, '/mnt/d/Code/NEW')
    assert.equal(getTask(db, grandchild.id).effectiveDueAt, newParent.dueAt)
    assert.equal(getTask(db, grandchild.id).effectiveWorkspacePath, '/mnt/d/Code/NEW')

    // ③ 审计：updated 快照 + 一条可读的 reparented 事件（「记录」页签直接显示 父任务：A → B）
    const events = listTaskEvents(db, moving.id)
    assert.ok(events.some((event) => event.event_code === 'updated'))
    const first = reparentEvents(moving.id)
    assert.equal(first.length, 1)
    assert.equal(first[0].note, '父任务：旧父任务 → 新父任务')
    assert.deepEqual(JSON.parse(first[0].before_json), { parentId: oldParent.id })
    assert.deepEqual(JSON.parse(first[0].after_json), { parentId: newParent.id })

    // ④ 移到顶层：null
    const toTop = updateTask(db, moving.id, { parentId: null })
    assert.equal(toTop.parentId, null)
    assert.equal(parentIdOf(moving.id), null)
    assert.equal(getTask(db, moving.id).effectiveDueAt, null)
    assert.equal(getTask(db, moving.id).effectiveWorkspacePath, null)
    const topEvents = reparentEvents(moving.id)
    assert.equal(topEvents.length, 2)
    assert.equal(topEvents.some((event) => event.note === '父任务：新父任务 → 顶层'), true)

    // 同值重挂不算变更：不写多余事件
    updateTask(db, moving.id, { parentId: null })
    assert.equal(reparentEvents(moving.id).length, 2)
    // 真的变了才算变更：从顶层挂回旧父任务会写第 3 条事件
    updateTask(db, moving.id, { parentId: oldParent.id, title: '改名' })
    assert.equal(parentIdOf(moving.id), oldParent.id)
    assert.equal(reparentEvents(moving.id).length, 3)
    assert.equal(reparentEvents(moving.id).some((event) => event.note === '父任务：顶层 → 旧父任务'), true)
    // 不带 parentId 的普通更新（undefined = 不改变父任务）不动 parent_id，也不写事件
    updateTask(db, moving.id, { title: '再改名' })
    assert.equal(parentIdOf(moving.id), oldParent.id)
    assert.equal(reparentEvents(moving.id).length, 3)

    // ⑤ 四条拒绝路径：自己 / 直接子任务 / 深层后代 / 不存在的父任务（外加已归档父任务）
    assert.throws(() => updateTask(db, moving.id, { parentId: moving.id }), /不能把任务挂到自己身上/)
    assert.throws(() => updateTask(db, moving.id, { parentId: child.id }), /不能把任务挂到它自己的子任务下（会形成环）/)
    assert.throws(() => updateTask(db, moving.id, { parentId: grandchild.id }), /不能把任务挂到它自己的子任务下（会形成环）/)
    assert.throws(() => updateTask(db, moving.id, { parentId: 'no-such-parent-id' }), /父任务不存在/)
    archiveTask(db, newParent.id)
    assert.throws(() => updateTask(db, moving.id, { parentId: newParent.id }), /已归档/)
    restoreTask(db, newParent.id)
    // 被拒后库里没有任何变化，也没有多留下 reparented 事件
    assert.equal(parentIdOf(moving.id), oldParent.id)
    assert.equal(reparentEvents(moving.id).length, 3)

    // ⑥ 共享守卫 isDescendantOf：含自身、跨树为假
    assert.equal(isDescendantOf(db, moving.id, moving.id), true)
    assert.equal(isDescendantOf(db, grandchild.id, moving.id), true)
    assert.equal(isDescendantOf(db, moving.id, grandchild.id), false)
    assert.equal(isDescendantOf(db, oldParent.id, newParent.id), false)
    assert.equal(isDescendantOf(db, 'no-such-task', oldParent.id), false)

    // ⑦ 库里已经存在环（脏数据）时，守卫必须能返回而不是死循环
    db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(grandchild.id, oldParent.id)
    assert.equal(isDescendantOf(db, moving.id, grandchild.id), true)
    assert.equal(isDescendantOf(db, moving.id, 'no-such-task'), false)
    assert.throws(() => updateTask(db, moving.id, { parentId: child.id }), /会形成环/)
    db.prepare('UPDATE tasks SET parent_id = NULL WHERE id = ?').run(oldParent.id)
  } finally {
    // 断言失败时也要先关库：Windows 下句柄没释放会让 rmSync 抛 EPERM，把真正的失败原因盖掉。
    try { db?.close() } catch { /* 已经关过就算了 */ }
    rmSync(dir, { recursive: true, force: true })
  }
})
