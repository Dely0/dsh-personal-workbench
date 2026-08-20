import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { createKnowledge, createTask, localDateString, updateTask } from '../lib/db/repo.js'

function startTestServer() {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  const routes = makeRoutes(db)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) {
        return route.handler(req, res)
      }
      if (route.kind === 'exact' && url.pathname === route.path) {
        return route.handler(req, res)
      }
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  return { db, server }
}

async function withServer(fn) {
  const { db, server } = startTestServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
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

test('manual plan editing PUT saves added task instead of returning not found', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: 'manual plan task', typeCode: 'code_impl', priorityCode: 'p2' })
    const child = createTask(db, { title: 'manual plan child', typeCode: 'code_impl', priorityCode: 'p2', parentId: task.id })
    const planDate = localDateString()

    const health = await request('GET', '/api/workbench/health')
    assert.equal(health.status, 200)
    assert.equal(health.body.version, '1.5.2')

    // Simulates: open edit mode, add an existing task, then save.
    const put = await request('PUT', `/api/workbench/plans/${planDate}`, {
      items: [
        { taskId: task.id, order: 1, note: 'first' },
        { taskId: child.id, order: 2, note: 'added manually' },
      ],
    })
    assert.equal(put.status, 200)
    assert.equal(put.body.ok, true)
    assert.equal(put.body.plan.items.length, 2)
    assert.equal(put.body.plan.items[1].taskId, child.id)
    assert.equal(put.body.plan.sourceCode, 'manual')

    const get = await request('GET', `/api/workbench/plans?date=${planDate}`)
    assert.equal(get.status, 200)
    assert.equal(get.body.plan.items.length, 2)
    assert.equal(get.body.plan.items[1].note, 'added manually')
  })
})

test('task API returns effectiveDueAt inherited from ancestors and PATCH updates descendants dynamically', async () => {
  await withServer(async ({ db, request }) => {
    const parent = createTask(db, { title: 'due parent', typeCode: 'code_impl', priorityCode: 'p1', dueAt: '2026-08-20T10:00:00+08:00' })
    const child = createTask(db, { title: 'no-due child', typeCode: 'code_impl', priorityCode: 'p1', parentId: parent.id })
    const grandchild = createTask(db, { title: 'no-due grandchild', typeCode: 'code_impl', priorityCode: 'p1', parentId: child.id })

    const list = await request('GET', '/api/workbench/tasks')
    assert.equal(list.status, 200)
    const byId = new Map(list.body.tasks.map((t) => [t.id, t]))
    assert.equal(byId.get(child.id).effectiveDueAt, parent.dueAt)
    assert.equal(byId.get(grandchild.id).effectiveDueAt, parent.dueAt)

    const detail = await request('GET', `/api/workbench/tasks/${child.id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.task.effectiveDueAt, parent.dueAt)
    assert.equal(detail.body.children[0].effectiveDueAt, parent.dueAt)

    const patch = await request('PATCH', `/api/workbench/tasks/${parent.id}`, { dueAt: '2026-08-21T09:00:00+08:00' })
    assert.equal(patch.status, 200)
    assert.equal(patch.body.task.effectiveDueAt, '2026-08-21T09:00:00+08:00')
    const after = await request('GET', `/api/workbench/tasks/${grandchild.id}`)
    assert.equal(after.body.task.effectiveDueAt, '2026-08-21T09:00:00+08:00')

    const clear = await request('PATCH', `/api/workbench/tasks/${parent.id}`, { dueAt: null })
    assert.equal(clear.status, 200)
    assert.equal(clear.body.task.effectiveDueAt, null)
    const clearedChild = await request('GET', `/api/workbench/tasks/${grandchild.id}`)
    assert.equal(clearedChild.body.task.effectiveDueAt, null)
  })
})

test('manual plan editing PUT removes an item and keeps remaining done task', async () => {
  await withServer(async ({ db, request }) => {
    const normal = createTask(db, { title: 'normal plan item', typeCode: 'code_impl', priorityCode: 'p2' })
    const done = createTask(db, { title: 'done plan item', typeCode: 'code_impl', priorityCode: 'p2' })
    updateTask(db, done.id, { statusCode: 'done' })
    const planDate = localDateString()

    // Build a plan containing a normal task and a completed task.
    const initial = await request('PUT', `/api/workbench/plans/${planDate}`, {
      items: [
        { taskId: normal.id, order: 1, note: 'normal' },
        { taskId: done.id, order: 2, note: 'done record' },
      ],
    })
    assert.equal(initial.status, 200)
    assert.equal(initial.body.plan.items.length, 2)

    // Remove the normal item; the remaining done task must still be saved.
    const removed = await request('PUT', `/api/workbench/plans/${planDate}`, {
      items: [
        { taskId: done.id, order: 1, note: 'done record' },
      ],
    })
    assert.equal(removed.status, 200)
    assert.equal(removed.body.ok, true)
    assert.equal(removed.body.plan.items.length, 1)
    assert.equal(removed.body.plan.items[0].taskId, done.id)
    assert.equal(removed.body.plan.items[0].note, 'done record')

    const after = await request('GET', `/api/workbench/plans?date=${planDate}`)
    assert.equal(after.status, 200)
    assert.equal(after.body.plan.items.length, 1)
    assert.equal(after.body.plan.items[0].taskId, done.id)
    assert.equal(after.body.plan.items.some((item) => item.taskId === normal.id), false)

    // Removing the done item as well is also allowed; only an empty plan is rejected.
    const onlyNormal = await request('PUT', `/api/workbench/plans/${planDate}`, {
      items: [{ taskId: normal.id, order: 1, note: 'normal' }],
    })
    assert.equal(onlyNormal.status, 200)
    assert.equal(onlyNormal.body.plan.items.length, 1)
    assert.equal(onlyNormal.body.plan.items[0].taskId, normal.id)

    const empty = await request('PUT', `/api/workbench/plans/${planDate}`, { items: [] })
    assert.equal(empty.status, 400)
    assert.match(empty.body.error, /at least one item/)
  })
})

test('knowledge API supports file_link and local document reading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-knowledge-file-'))
  const docPath = join(dir, 'note.md')
  writeFileSync(docPath, '# 本地文档\n这是需要总结的内容', 'utf8')
  try {
    await withServer(async ({ db, request }) => {
      seedDictionaries(db)
      const created = await request('POST', '/api/workbench/knowledge', {
        title: '本地文档总结',
        contentMd: '# 摘要',
        kindCode: 'note',
        fileLink: docPath,
      })
      assert.equal(created.status, 201)
      assert.equal(created.body.knowledge.fileLink, docPath)
      const id = created.body.knowledge.id

      const got = await request('GET', `/api/workbench/knowledge/${id}`)
      assert.equal(got.status, 200)
      assert.equal(got.body.knowledge.fileLink, docPath)

      const patched = await request('PATCH', `/api/workbench/knowledge/${id}`, { fileLink: `file://${docPath}` })
      assert.equal(patched.status, 200)
      assert.equal(patched.body.knowledge.fileLink, `file://${docPath}`)

      const read = await request('GET', `/api/workbench/knowledge/read-local-file?path=${encodeURIComponent(docPath)}`)
      assert.equal(read.status, 200)
      assert.match(read.body.content, /本地文档/)
      assert.equal(read.body.fileLink, docPath)

      const rel = await request('GET', `/api/workbench/knowledge/read-local-file?path=${encodeURIComponent('relative/path.md')}`)
      assert.equal(rel.status, 400)

      const openMissing = await request('POST', '/api/workbench/knowledge/open-file', { fileLink: '/no/such/file.md' })
      assert.equal(openMissing.status, 400)
      const openNoLink = await request('POST', '/api/workbench/knowledge/open-file', {})
      assert.equal(openNoLink.status, 400)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
