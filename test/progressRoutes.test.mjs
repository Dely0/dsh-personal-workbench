/**
 * D03/D04 的 HTTP 侧：进度 PATCH 的原子性与待验收投影（AX-P05、AX-P06 的路由部分）。
 *
 * 重点不是"能写进度"，而是**失败时什么都没写**：
 * 用户界面上一次 PATCH 可能同时带 statusCode + dueAt + progressPercent，
 * 如果进度非法却把状态写进去了，用户看到的是"报错了但任务状态变了"——
 * 这比直接报错更难发现（本项目"静默半写"的经典形态）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { createTask, getTask, listTaskEvents, setTaskProgress, submitCompletionDraft, updateTask } from '../lib/db/repo.js'

async function withServer(fn) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const routes = makeRoutes(db, {})
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close(); db.close()
    throw new Error(`测试服务器没有拿到端口（address=${String(address)}）`)
  }
  const port = address.port
  const request = async (method, path, body) => {
    const init = { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init)
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  try {
    await fn({ db, request })
  } finally {
    server.close()
    db.close()
  }
}

test('PATCH progressPercent：0–99 写入成功，并写一条 actor=user 的 updated 事件', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: '任务', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing' })
    const res = await request('PATCH', `/api/workbench/tasks/${task.id}`, { progressPercent: 60 })
    assert.equal(res.status, 200)
    assert.equal(res.body.task.progressPercent, 60)
    assert.equal(res.body.task.statusCode, 'doing')
    assert.equal(getTask(db, task.id).progressPercent, 60)
    const event = listTaskEvents(db, task.id).find((e) => e.event_code === 'updated' && e.actor === 'user')
    assert.ok(event, '用户改进度也要留痕')
    /**
     * 事件体是**整个任务的 before/after 快照**（`updateTask` 的既有契约，
     * 记录页签靠它做"哪一栏从什么变成什么"）。
     * 这里只断言"这次改动确实体现在 after 里"，不去比对事件形状 ——
     * 比对形状会把这条测试变成"改事件结构就红"的脆断言。
     */
    assert.equal(JSON.parse(event.after_json).progressPercent, 60)
    assert.equal(JSON.parse(event.before_json).progressPercent, 0)
  })
})

test('PATCH progressPercent：非法进度时**多字段 PATCH 一个都不生效**（AX-P05）', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: '原标题', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing' })
    const before = getTask(db, task.id)
    const events = listTaskEvents(db, task.id).length

    for (const bad of [-1, 101, 100, 1.5, 'abc', null, true]) {
      const res = await request('PATCH', `/api/workbench/tasks/${task.id}`, {
        title: '被改掉的标题',
        statusCode: 'blocked',
        dueAt: '2026-12-31T00:00:00.000Z',
        progressPercent: bad,
      })
      assert.equal(res.status, 400, `progressPercent=${JSON.stringify(bad)} 必须 400`)
      assert.match(res.body.error, /进度|100/, '错误要能读（中文）')
      const after = getTask(db, task.id)
      assert.equal(after.title, before.title, '非法进度不得顺手改标题')
      assert.equal(after.statusCode, before.statusCode, '非法进度不得顺手改状态')
      assert.equal(after.dueAt, before.dueAt, '非法进度不得顺手改截止时间')
      assert.equal(after.progressPercent, before.progressPercent)
      assert.equal(listTaskEvents(db, task.id).length, events, '被拒的 PATCH 不得写事件')
    }
  })
})

test('PATCH progressPercent：100 在普通 PATCH 里被拒（界面走完成任务动作，不入库 100）', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: '任务', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing' })
    const res = await request('PATCH', `/api/workbench/tasks/${task.id}`, { progressPercent: 100 })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /100 不是可存储的进度值/)
    assert.match(res.body.error, /workbench_request_completion/)
    assert.equal(getTask(db, task.id).progressPercent, 0)
    assert.equal(getTask(db, task.id).statusCode, 'doing', '100 不得顺手完成任务')
  })
})

test('PATCH：done/cancelled/已归档任务拒绝改进度，但同一次 PATCH 里完成任务仍可用', async () => {
  await withServer(async ({ db, request }) => {
    const done = createTask(db, { title: '已完成', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'done' })
    const res1 = await request('PATCH', `/api/workbench/tasks/${done.id}`, { progressPercent: 30 })
    assert.equal(res1.status, 400)
    assert.match(res1.body.error, /已完成/)

    const cancelled = createTask(db, { title: '已取消', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'cancelled' })
    assert.equal((await request('PATCH', `/api/workbench/tasks/${cancelled.id}`, { progressPercent: 30 })).status, 400)

    const archived = createTask(db, { title: '已归档', typeCode: 'feature_opt', priorityCode: 'p1' })
    updateTask(db, archived.id, { archived: true })
    const res3 = await request('PATCH', `/api/workbench/tasks/${archived.id}`, { progressPercent: 30 })
    assert.equal(res3.status, 400)
    assert.match(res3.body.error, /已归档/)

    // 「完成任务」路径（statusCode: done）不受进度校验影响：那是完成动作，不是写进度
    const open = createTask(db, { title: '进行中', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing' })
    const complete = await request('PATCH', `/api/workbench/tasks/${open.id}`, { statusCode: 'done' })
    assert.equal(complete.status, 200)
    assert.equal(complete.body.task.statusCode, 'done')
  })
})

test('PATCH 完成后向上聚合父任务，但一律不写进度（原显式值保留）', async () => {
  await withServer(async ({ db, request }) => {
    const parent = createTask(db, { title: '父', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing' })
    const child = createTask(db, { title: '子', typeCode: 'feature_opt', priorityCode: 'p1', parentId: parent.id, statusCode: 'doing' })
    setTaskProgress(db, parent.id, 60)
    setTaskProgress(db, child.id, 20)
    const res = await request('PATCH', `/api/workbench/tasks/${child.id}`, { statusCode: 'done' })
    assert.equal(res.status, 200)
    // 子任务完成 → 父任务被既有聚合规则自动完成（行为不变）
    assert.equal(getTask(db, parent.id).statusCode, 'done')
    assert.equal(getTask(db, parent.id).progressPercent, 60, '聚合完成不得改写父任务显式进度')
    assert.equal(getTask(db, child.id).progressPercent, 20, '完成不得改写自己的显式进度')
  })
})

test('GET /tasks/pending-completions：一次返回全部待验收，含暂存标记（AX-P07 的服务端侧）', async () => {
  await withServer(async ({ db, request }) => {
    const a = createTask(db, { title: 'A', typeCode: 'feature_opt', priorityCode: 'p1', aiPolicyCode: 'execute' })
    const b = createTask(db, { title: 'B', typeCode: 'feature_opt', priorityCode: 'p1', aiPolicyCode: 'execute' })
    const empty = await request('GET', '/api/workbench/tasks/pending-completions')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body.pending, { available: true, items: [] })

    const draftA = submitCompletionDraft(db, { taskId: a.id, summary: 'A 好了', sessionId: null, requireSummary: false })
    const draftB = submitCompletionDraft(db, { taskId: b.id, summary: 'B 好了', sessionId: null, requireSummary: false })
    db.prepare('UPDATE task_drafts SET deferred_at = ? WHERE id = ?').run('2026-09-30T10:00:00.000Z', draftB.result.draftId)

    const res = await request('GET', '/api/workbench/tasks/pending-completions')
    assert.equal(res.status, 200)
    assert.equal(res.body.pending.available, true)
    assert.equal(res.body.pending.items.length, 2)
    assert.equal(res.body.pending.items.find((i) => i.taskId === b.id).deferred, true, '暂存仍算待验收')
    assert.equal(res.body.pending.items.find((i) => i.taskId === a.id).deferred, false)

    // 驳回后不再出现
    db.prepare("UPDATE task_drafts SET status_code = 'abandoned' WHERE id = ?").run(draftA.result.draftId)
    const after = await request('GET', '/api/workbench/tasks/pending-completions')
    assert.deepEqual(after.body.pending.items.map((i) => i.taskId), [b.id])
  })
})

test('GET /tasks/:id：带待验收时返回 pendingCompletion，没有时不带这个字段', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: '任务', typeCode: 'feature_opt', priorityCode: 'p1', aiPolicyCode: 'execute' })
    const none = await request('GET', `/api/workbench/tasks/${task.id}`)
    assert.equal(none.status, 200)
    assert.equal('pendingCompletion' in none.body, false, '没有 pending 草稿就不该有这个字段')

    const draft = submitCompletionDraft(db, { taskId: task.id, summary: '好了', sessionId: null, requireSummary: false })
    const pending = await request('GET', `/api/workbench/tasks/${task.id}`)
    assert.deepEqual(pending.body.pendingCompletion, { deferred: false })

    db.prepare('UPDATE task_drafts SET deferred_at = ? WHERE id = ?').run('2026-09-30T10:00:00.000Z', draft.result.draftId)
    const deferred = await request('GET', `/api/workbench/tasks/${task.id}`)
    assert.deepEqual(deferred.body.pendingCompletion, { deferred: true })
  })
})

test('GET /tasks：列表项带 progressPercent（前端进度条的数据源）', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: '任务', typeCode: 'feature_opt', priorityCode: 'p1', statusCode: 'doing' })
    setTaskProgress(db, task.id, 35)
    const res = await request('GET', '/api/workbench/tasks')
    assert.equal(res.status, 200)
    const row = res.body.tasks.find((t) => t.id === task.id)
    assert.equal(row.progressPercent, 35)
    assert.equal(typeof row.allDay, 'boolean', '原有序列化行为不变')
  })
})
