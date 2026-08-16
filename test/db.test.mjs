import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import {
  createTask, updateTask, getTask, listTasks, listArchivedTasks, listChildren,
  createDraft, confirmTaskDraft, confirmDailyPlanDraft, confirmReportDraft, getDailyPlan, deleteDailyPlan,
  getTaskReport, listTaskReports, deleteTaskReport,
  getDraftBySession, listTaskSessions, linkTaskSession, localDateString,
} from '../lib/db/repo.js'

test('db migrations, dictionaries and task tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-db-'))
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
    linkTaskSession(db, { taskId: task.id, sessionId: 's1', roleCode: 'clarify' })
    assert.equal(listTaskSessions(db, task.id).length, 1)
    updateTask(db, parent.id, { archived: true })
    assert.equal(listTasks(db).some((t) => t.id === parent.id), false)
    assert.equal(listArchivedTasks(db).some((t) => t.id === parent.id), true)

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
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
