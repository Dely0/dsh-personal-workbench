/**
 * D03：`workbench_update_progress` 工具与共用验收服务（AX-P02/P03/P04、AX-G01 的工具侧）。
 *
 * 这一组断言盯的是 **ADR 0003 的两个值空间**在**工具边界**上是否真的分开了：
 * - 写 0–99：只改进度，状态一动都不动；
 * - 写 100：**一个字节的进度都不写**，只走验收草稿（与 `workbench_request_completion` 同一实现）。
 *
 * 另外还钉住一条"反向变异"判据（AX-G01）：AI 不能通过 `workbench_update_task`
 * 直接把任务标成 done/cancelled —— 那条硬拦拆掉必须变红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { requestCompletionTool, updateProgressTool, updateTaskTool } from '../lib/tools.js'
import {
  createTask, getPendingDraftForTask, getTask, listTaskEvents, setTaskProgress, updateTask,
} from '../lib/db/repo.js'

function openDb() {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  return db
}

function exec(sessionId = null) {
  return { agent: { session: sessionId === null ? undefined : { id: sessionId } } }
}

// ---------------------------------------------------------------------------
// 0–99：只改进度
// ---------------------------------------------------------------------------

test('workbench_update_progress：0–99 写入成功、状态不变、回执含最终值', async () => {
  const db = openDb()
  try {
    const task = createTask(db, { title: '长任务', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing', estimatedMinutes: 600 })
    const tool = updateProgressTool(db)
    const out = await tool.execute({ task_id: task.id, progress: 40, note: '把接口打通了' }, exec('s-1'))

    assert.match(out, /40%/, '回执必须回显最终值（不许静默改写）')
    const after = getTask(db, task.id)
    assert.equal(after.progressPercent, 40)
    assert.equal(after.statusCode, 'doing', '写进度不得改变状态')
    assert.equal(after.estimatedMinutes, 600, '写进度不得动预计耗时')
    assert.equal(after.completedAt, null)
    // 事件留痕：actor=ai（与用户写的区分得开）
    const event = listTaskEvents(db, task.id).find((e) => e.event_code === 'updated' && e.actor === 'ai')
    assert.ok(event)
    assert.deepEqual(JSON.parse(event.after_json), { progressPercent: 40 })
  } finally {
    db.close()
  }
})

test('workbench_update_progress：同值重复提交是幂等的（不写事件、回执说明未改动）', async () => {
  const db = openDb()
  try {
    const task = createTask(db, { title: '任务', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing' })
    const tool = updateProgressTool(db)
    await tool.execute({ task_id: task.id, progress: 50 }, exec())
    const eventsAfterFirst = listTaskEvents(db, task.id).length
    const out = await tool.execute({ task_id: task.id, progress: 50 }, exec())
    assert.match(out, /已经是 50%/)
    assert.equal(listTaskEvents(db, task.id).length, eventsAfterFirst, '同值不得追加事件')
  } finally {
    db.close()
  }
})

test('workbench_update_progress：非法值与越界（含小数/负数/101）拒绝且无部分写入', async () => {
  const db = openDb()
  try {
    const task = createTask(db, { title: '任务', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing' })
    const tool = updateProgressTool(db)
    await tool.execute({ task_id: task.id, progress: 30 }, exec())
    const before = getTask(db, task.id)
    const events = listTaskEvents(db, task.id).length

    /**
     * 参数**类型**错误由 `defineTool` 的 schema 校验挡在最外层（抛 `ToolArgsError`），
     * 数值**范围**错误由工具自己返回中文错误。两者都要保证"什么都没写进去"。
     */
    for (const value of [-1, 101, 1.5, 0.5, 1000]) {
      const out = await tool.execute({ task_id: task.id, progress: value }, exec())
      assert.match(out, /^错误：/, `${value} 必须被当场拒绝，实际：${out}`)
      assert.match(out, /进度/, '原因要说清是进度不合法')
    }
    for (const value of ['50', null, true, {}]) {
      await assert.rejects(
        () => tool.execute({ task_id: task.id, progress: value }, exec()),
        /must be a number/,
        `${JSON.stringify(value)} 类型不对，schema 层就该拦下`,
      )
    }
    const after = getTask(db, task.id)
    assert.equal(after.progressPercent, 30, '拒绝时进度不变')
    assert.equal(after.updatedAt, before.updatedAt, '拒绝时 updatedAt 不变')
    assert.equal(listTaskEvents(db, task.id).length, events, '拒绝时无事件')
  } finally {
    db.close()
  }
})

test('workbench_update_progress：不存在 / 归档 / done / cancelled 拒绝，不重开任务', async () => {
  const db = openDb()
  try {
    const tool = updateProgressTool(db)
    assert.match(await tool.execute({ task_id: 'nope', progress: 10 }, exec()), /不存在/)

    const done = createTask(db, { title: '已完成', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'done' })
    assert.match(await tool.execute({ task_id: done.id, progress: 10 }, exec()), /已完成/)
    const cancelled = createTask(db, { title: '已取消', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'cancelled' })
    assert.match(await tool.execute({ task_id: cancelled.id, progress: 10 }, exec()), /已取消/)
    const archived = createTask(db, { title: '已归档', typeCode: 'feature_opt', priorityCode: 'p1' })
    updateTask(db, archived.id, { archived: true })
    assert.match(await tool.execute({ task_id: archived.id, progress: 10 }, exec()), /已归档/)

    assert.equal(getTask(db, done.id).statusCode, 'done', '拒绝不得把任务重开')
    assert.equal(getTask(db, done.id).progressPercent, 0)
  } finally {
    db.close()
  }
})

// ---------------------------------------------------------------------------
// 100：只提交验收，绝不写进度
// ---------------------------------------------------------------------------

test('workbench_update_progress(100)：只创建 completion 草稿，progress 仍 75、status 仍 doing（AX-P03）', async () => {
  const db = openDb()
  try {
    const task = createTask(db, { title: '执行任务', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing', aiPolicyCode: 'execute' })
    setTaskProgress(db, task.id, 75, 'user', '2026-09-30T10:00:00.000Z')
    const tool = updateProgressTool(db)
    const out = await tool.execute({ task_id: task.id, progress: 100, summary: '接口打通、测试补齐，可以验收了。' }, exec('s-exec'))

    assert.match(out, /完成验收申请已提交/)
    assert.match(out, /没有.*写入 100|库里\*\*没有\*\*写入 100/, '回执必须说清 100 没有落库')
    const after = getTask(db, task.id)
    assert.equal(after.progressPercent, 75, '100 不得写入进度（连 99 都不代写）')
    assert.equal(after.statusCode, 'doing', '100 不得直接完成任务')
    const draft = getPendingDraftForTask(db, 'completion', task.id)
    assert.ok(draft, '必须创建 completion 草稿')
    assert.equal(draft.payload.summary, '接口打通、测试补齐，可以验收了。')
    assert.equal(draft.statusCode, 'pending')

    // 重复提交 → 仍只有一份 pending（不出现两份待验收）
    await tool.execute({ task_id: task.id, progress: 100, summary: '补充一句：文档也更新了。' }, exec('s-exec'))
    const pendingDrafts = db.prepare("SELECT COUNT(*) AS n FROM task_drafts WHERE kind_code = 'completion' AND status_code = 'pending'").get()
    assert.equal(pendingDrafts.n, 1)
    assert.equal(getTask(db, task.id).progressPercent, 75)
  } finally {
    db.close()
  }
})

test('workbench_update_progress(100)：缺 summary / 非 execute / 已归档 / done / cancelled 拒绝且无草稿（AX-P04）', async () => {
  const db = openDb()
  try {
    const tool = updateProgressTool(db)

    const consult = createTask(db, { title: '咨询任务', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing', aiPolicyCode: 'consult' })
    const noPolicy = await tool.execute({ task_id: consult.id, progress: 100, summary: '写完了' }, exec())
    assert.match(noPolicy, /AI 策略不是/)
    assert.equal(getPendingDraftForTask(db, 'completion', consult.id), undefined, '拒绝时不得留草稿')

    /**
     * 缺 summary 只用**可执行**的任务测：服务端拒绝顺序是先策略后 summary，
     * 拿 consult 任务测会得到"策略不对"而不是"缺 summary"（断言会指向错的原因）。
     */
    const execute = createTask(db, { title: '可执行任务', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing', aiPolicyCode: 'execute' })
    const missingSummary = await tool.execute({ task_id: execute.id, progress: 100 }, exec())
    assert.match(missingSummary, /必须同时提供 summary/)
    assert.equal(getPendingDraftForTask(db, 'completion', execute.id), undefined, '缺 summary 不得创建草稿')
    assert.equal(getTask(db, execute.id).progressPercent, 0, '缺 summary 不得写进度')

    const blankSummary = await tool.execute({ task_id: execute.id, progress: 100, summary: '   ' }, exec())
    assert.match(blankSummary, /必须同时提供 summary/)
    assert.equal(getPendingDraftForTask(db, 'completion', execute.id), undefined, '空白 summary 等同缺失')

    const done = createTask(db, { title: '已完成', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'done', aiPolicyCode: 'execute' })
    assert.match(await tool.execute({ task_id: done.id, progress: 100, summary: 'x' }, exec()), /已经是已完成状态/)
    const cancelled = createTask(db, { title: '已取消', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'cancelled', aiPolicyCode: 'execute' })
    assert.match(await tool.execute({ task_id: cancelled.id, progress: 100, summary: 'x' }, exec()), /已取消/)
    const archived = createTask(db, { title: '已归档', typeCode: 'feature_opt', priorityCode: 'p1', aiPolicyCode: 'execute' })
    updateTask(db, archived.id, { archived: true })
    assert.match(await tool.execute({ task_id: archived.id, progress: 100, summary: 'x' }, exec()), /已归档/)
    assert.equal(getPendingDraftForTask(db, 'completion', archived.id), undefined)
  } finally {
    db.close()
  }
})

// ---------------------------------------------------------------------------
// 共用实现：两个工具的草稿写入路径必须一致（不许第二套验收实现）
// ---------------------------------------------------------------------------

test('workbench_request_completion 与 update_progress(100) 走同一条草稿路径（可互相更新，不产生第二份）', async () => {
  const db = openDb()
  try {
    const task = createTask(db, { title: '任务', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing', aiPolicyCode: 'execute' })
    const request = requestCompletionTool(db)
    const progress = updateProgressTool(db)

    const first = await request.execute({ task_id: task.id, summary: '旧工具提交' }, exec('s-a'))
    assert.match(first, /完成验收申请已提交/)
    const draftId = getPendingDraftForTask(db, 'completion', task.id).id

    const second = await progress.execute({ task_id: task.id, progress: 100, summary: '新工具更新' }, exec('s-a'))
    assert.match(second, /（更新）/, '新工具必须更新同一份草稿而不是新建')
    const drafts = db.prepare("SELECT id, payload_json FROM task_drafts WHERE kind_code = 'completion' AND status_code = 'pending'").all()
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0].id, draftId)
    assert.match(drafts[0].payload_json, /新工具更新/)

    // 反向：旧工具保留 summary 可选的既有行为（不扩大变更）
    const legacy = await request.execute({ task_id: task.id }, exec('s-a'))
    assert.match(legacy, /完成验收申请已提交/)
    assert.equal(getPendingDraftForTask(db, 'completion', task.id).id, draftId)
  } finally {
    db.close()
  }
})

// ---------------------------------------------------------------------------
// AX-G01：硬拦必须还在（拆掉就变红）
// ---------------------------------------------------------------------------

test('AX-G01：AI 仍不能通过 workbench_update_task 直接把任务标成 done/cancelled', async () => {
  const db = openDb()
  try {
    const task = createTask(db, { title: '任务', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing' })
    const tool = updateTaskTool(db)
    for (const status of ['done', 'cancelled']) {
      const out = await tool.execute({ task_id: task.id, status_code: status }, exec())
      assert.match(out, /AI 不能直接把任务标记为已完成\/已取消/, `${status} 必须被硬拦`)
      assert.match(out, /workbench_request_completion/, '拦下来之后要指路正确的路径')
    }
    assert.equal(getTask(db, task.id).statusCode, 'doing', '硬拦生效时任务状态一点没动')
    // 正常状态仍可改（硬拦不是"什么都不能改"）
    const ok = await tool.execute({ task_id: task.id, status_code: 'blocked' }, exec())
    assert.match(ok, /已更新任务/)
    assert.equal(getTask(db, task.id).statusCode, 'blocked')
  } finally {
    db.close()
  }
})

test('工具描述里写清了 100 的语义与"主动报进度"，避免模型当成普通保存值', () => {
  const db = openDb()
  try {
    const tool = updateProgressTool(db)
    assert.equal(tool.name, 'workbench_update_progress')
    assert.match(tool.description, /100 不是可存储的进度值/)
    assert.match(tool.description, /总结|summary/)
    assert.match(tool.description, /主动/)
    assert.match(tool.description, /不能直接把任务标记为已完成/)
    assert.ok(tool.parameters.properties.progress, 'progress 必须是声明的参数')
    assert.equal(tool.parameters.properties.progress.type, 'number')
    assert.ok(tool.parameters.required.includes('task_id'))
    assert.ok(tool.parameters.required.includes('progress'))
  } finally {
    db.close()
  }
})
