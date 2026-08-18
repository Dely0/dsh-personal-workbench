import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { makeRoutes } from '../lib/api/routes.js'
import { createTask, localDateString } from '../lib/db/repo.js'

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
