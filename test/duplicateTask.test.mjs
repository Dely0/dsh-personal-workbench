/**
 * 回归：**草稿确认不得二次建单**（2026-09-13 真实事故）。
 *
 * ## 用户报的现象
 *
 * > 我用快速录入录了一个任务，然后 AI 执行并发起验收，然后「待处理」里突然出现了同名的任务申请，
 * > 是验收导致这个任务被重新提交了？
 *
 * ## 实测到的两个独立缺陷（本文件逐条锁住）
 *
 * 1. `withDraftConfirm()` **不校验草稿是否还是 pending**：
 *    同一条 task 草稿 `POST /confirm` 两次 → 两条同名任务。
 *    （复现脚本：`node scripts/repro/repro-routes.mjs`，修前输出"库里「双确认实验」条数: 2"）
 * 2. `confirmTaskDraft()` 没有把"本次确认建了什么"记下来，
 *    所以"同一份产出落两次地"在数据层没有任何拦截点。
 *
 * 关键事实：**验收流程本身不建任务** —— `completion` 草稿只调 `completeTaskCascade`。
 * 多出来的那条任务，只能来自一次 `kindCode === 'task'` 草稿的确认。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import {
  abandonDraft, completeTaskCascade, confirmSubtaskPlanDraft, confirmTaskDraft,
  createDraft, createTask, getDraft, getTask, listTasks,
} from '../lib/db/repo.js'

/** 每个用例一个临时库；Windows 上必须先关库再删目录，否则 EPERM 会盖掉真正的失败原因。 */
function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-dup-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  try {
    seedDictionaries(db)
    fn(db)
  } finally {
    try { db.close() } catch { /* 已经关过就算了 */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

const taskDraft = (db, patch = {}) => createDraft(db, {
  kindCode: 'task',
  sessionId: patch.sessionId ?? 'session-clarify',
  payload: {
    title: '仅测试，不思考，直接提交任务',
    description: '## 背景\n用户要求直接提交',
    typeCode: 'personal',
    priorityCode: 'p3',
    statusCode: 'todo',
    subtasks: [],
    ...(patch.payload ?? {}),
  },
})

test('同一条 task 草稿确认两次：只建一条任务，第二次回放第一次的产出', () => {
  withDb((db) => {
    const draft = taskDraft(db)

    const first = confirmTaskDraft(db, draft.id)
    const second = confirmTaskDraft(db, draft.id)

    // 修前：第二次会 createTask，库里出现两条同名顶层任务（事故形态）。
    assert.equal(listTasks(db).length, 1, '同一条草稿确认两次只能建出一条任务')
    assert.equal(getDraft(db, draft.id).statusCode, 'confirmed')
    assert.equal(second.task.id, first.task.id, '第二次必须回放第一次建出来的那条任务')
    assert.equal(second.replayed, true, '第二次应当被标记为回放')
    // 回放不能谎报子任务数
    assert.equal(second.childCount, first.childCount)
  })
})

test('回放要跟着任务的**当前**状态，而不是复制创建那一刻的快照', () => {
  withDb((db) => {
    const draft = taskDraft(db)
    const task = confirmTaskDraft(db, draft.id).task
    // 用户随后把它做完了
    completeTaskCascade(db, task.id, 'user')

    const replay = confirmTaskDraft(db, draft.id)
    assert.equal(replay.task.id, task.id)
    assert.equal(replay.task.statusCode, 'done', '回放返回的是库里那条任务的最新状态')
    assert.equal(listTasks(db).length, 1)
  })
})

test('老草稿（没有 confirmResult 的已确认草稿）不重建，也不误报成功', () => {
  withDb((db) => {
    const draft = taskDraft(db)
    const task = confirmTaskDraft(db, draft.id).task
    /**
     * 模拟"本守卫上线前就已确认过"的历史数据：状态是 confirmed，但 payload 里
     * 没有 `confirmResult`。此时无法知道当次建了什么，**唯一正确的行为是什么都不建**
     * （返回 undefined，由调用方给出可读结果）。
     */
    const payload = { ...getDraft(db, draft.id).payload }
    delete payload.confirmResult
    db.prepare('UPDATE task_drafts SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), draft.id)

    assert.equal(confirmTaskDraft(db, draft.id), undefined, '没有产出记录时不许猜、不许重建')
    assert.equal(listTasks(db).length, 1)
    assert.equal(getTask(db, task.id).statusCode, 'todo')
  })
})

test('确认记录在、但那条任务已被删除：抛可读错误，绝不"顺手再建一条"', () => {
  withDb((db) => {
    const draft = taskDraft(db)
    const task = confirmTaskDraft(db, draft.id).task
    // 用户把任务删了（真库里的删除是硬删），草稿仍是 confirmed
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)

    assert.throws(() => confirmTaskDraft(db, draft.id), /不能重复确认/)
    assert.equal(listTasks(db).length, 0, '抛错路径不能留下新任务')
  })
})

test('已放弃的草稿不能再确认，也不建任何东西', () => {
  withDb((db) => {
    const draft = taskDraft(db)
    abandonDraft(db, draft.id)

    assert.equal(confirmTaskDraft(db, draft.id), undefined)
    assert.equal(listTasks(db).length, 0)
  })
})

test('两条独立草稿各自确认：默认都建（同名任务可能是正当需求），但第二条要带 duplicateOf 告警', () => {
  withDb((db) => {
    // 事故形态：快速录入的草稿建出任务 A，执行会话又提交了一份同内容草稿
    const quickEntry = taskDraft(db, { sessionId: 'session-clarify' })
    const taskA = confirmTaskDraft(db, quickEntry.id).task

    const execSession = taskDraft(db, {
      sessionId: 'session-execute',
      payload: { description: '## 背景\n用户要求直接提交\n\n## 说明\n执行会话补充的那份' },
    })
    const second = confirmTaskDraft(db, execSession.id)

    assert.equal(listTasks(db).length, 2, '默认意图下不静默合并同名任务')
    assert.equal(second.task.id === taskA.id, false)
    assert.ok(second.duplicateOf !== undefined, '必须把"库里已有同名任务"这件事报出来')
    assert.equal(second.duplicateOf.task.id, taskA.id)
    assert.equal(second.duplicateOf.sameWorkspace, true)
    assert.equal(second.duplicateOf.sameDescription, false, '描述不同 → 这是两次独立录入，不是重复提交')
  })
})

test('intent=dedupe：用户在告警里选了"复用那一条"时不新建', () => {
  withDb((db) => {
    const first = confirmTaskDraft(db, taskDraft(db).id).task
    const draft = taskDraft(db, { sessionId: 'session-execute' })

    const result = confirmTaskDraft(db, draft.id, 'user', new Date().toISOString(), 'dedupe')

    assert.equal(result.task.id, first.id)
    assert.equal(result.reused, true)
    assert.equal(listTasks(db).length, 1)
    assert.equal(getDraft(db, draft.id).statusCode, 'confirmed', '复用也算处理完了，草稿要收口')
  })
})

test('subtask_plan 草稿确认两次：不建第二棵树（它早就有 findSiblingByTitle 幂等，别被这次改动弄坏）', () => {
  withDb((db) => {
    const parent = createTask(db, { title: '父任务', typeCode: 'code_impl', priorityCode: 'p2' })
    const draft = createDraft(db, {
      kindCode: 'subtask_plan',
      sessionId: 'session-breakdown',
      payload: {
        parentTaskId: parent.id,
        subtasks: [
          { title: '子任务一', type_code: 'code_impl', priority_code: 'p2' },
          { title: '子任务二', type_code: 'code_impl', priority_code: 'p2' },
        ],
      },
    })
    confirmSubtaskPlanDraft(db, draft.id)
    confirmSubtaskPlanDraft(db, draft.id)
    assert.equal(listTasks(db, { parentId: parent.id }).length, 2, '重复确认不能建出第二套子任务')
  })
})

test('草稿确认结果回写 payload 时不动用户原始字段', () => {
  withDb((db) => {
    const draft = taskDraft(db)
    confirmTaskDraft(db, draft.id)
    const payload = getDraft(db, draft.id).payload
    assert.equal(payload.title, '仅测试，不思考，直接提交任务')
    assert.equal(payload.typeCode, 'personal')
    assert.equal(payload.confirmResult.task.id, getTask(db, payload.confirmResult.task.id).id)
  })
})
