import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeDictionaryRoute } from '../lib/api/dictionaryRoute.js'
import { makeLocalDirRoute } from '../lib/api/localDirRoute.js'
import { makeOpenFileRoute } from '../lib/api/openFileRoute.js'
import { makeRoutes } from '../lib/api/routes.js'
import { createKnowledge, createTask, localDateString, updateTask } from '../lib/db/repo.js'

function startTestServer() {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  // 生产路径由 apply() 播种字典；测试里也要播，否则 POST /drafts 的 kind 校验会 400。
  seedDictionaries(db)
  const routes = [makeDictionaryRoute(db), makeLocalDirRoute(), makeOpenFileRoute(), ...makeRoutes(db)]
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
    // health 的版本必须跟随 package.json，防止升级后还报旧版本
    const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    assert.equal(health.body.version, pkgVersion)

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

      const listDir = await request('GET', `/api/workbench/knowledge/list-local-dir?path=${encodeURIComponent(dir)}`)
      assert.equal(listDir.status, 200)
      assert.equal(listDir.body.path, dir)
      assert.ok(listDir.body.entries.some((e) => e.name === 'note.md' && e.isFile && e.path === docPath))

      const openMissing = await request('POST', '/api/workbench/knowledge/open-file', { fileLink: '/no/such/file.md' })
      assert.equal(openMissing.status, 400)
      const openNoLink = await request('POST', '/api/workbench/knowledge/open-file', {})
      assert.equal(openNoLink.status, 400)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dictionary CRUD API creates, edits, deactivates, protects builtin and blocks invalid code', async () => {
  await withServer(async ({ db, request }) => {
    seedDictionaries(db)

    const created = await request('POST', '/api/workbench/dictionaries', { kind: 'type', code: 'research', name: '研究', config: { color: '#16A085' }, sortOrder: 95 })
    assert.equal(created.status, 200)
    assert.equal(created.body.ok, true)
    assert.equal(created.body.dictionary.name, '研究')
    assert.equal(created.body.dictionary.code, 'research')

    const dup = await request('POST', '/api/workbench/dictionaries', { kind: 'type', code: 'research', name: '重复' })
    assert.equal(dup.status, 400)
    assert.match(dup.body.error, /已存在/)

    const invalid = await request('POST', '/api/workbench/dictionaries', { kind: 'type', code: 'Bad Code', name: '非法' })
    assert.equal(invalid.status, 400)
    assert.match(invalid.body.error, /小写字母/)

    const patch = await request('PATCH', '/api/workbench/dictionaries/type/research', { name: '专项研究', active: false, config: { color: '#2E9B7B' } })
    assert.equal(patch.status, 200)
    assert.equal(patch.body.dictionary.name, '专项研究')
    assert.equal(patch.body.dictionary.active, 0)

    const del = await request('DELETE', '/api/workbench/dictionaries/type/research')
    assert.equal(del.status, 200)
    assert.equal(del.body.ok, true)

    const delBuiltin = await request('DELETE', '/api/workbench/dictionaries/type/code_impl')
    assert.equal(delBuiltin.status, 400)
    assert.match(delBuiltin.body.error, /受保护/)

    const inuse = await request('POST', '/api/workbench/dictionaries', { kind: 'type', code: 'inuse_type', name: '使用中', config: {} })
    assert.equal(inuse.status, 200)
    createTask(db, { title: 'uses custom type', typeCode: 'inuse_type', priorityCode: 'p2' })
    const delInUse = await request('DELETE', '/api/workbench/dictionaries/type/inuse_type')
    assert.equal(delInUse.status, 400)
    assert.match(delInUse.body.error, /已被 1 条数据使用/)

    const deactivate = await request('PATCH', '/api/workbench/dictionaries/type/code_impl', { active: false })
    assert.equal(deactivate.status, 200)
    assert.equal(deactivate.body.dictionary.active, 0)
  })
})

test('archive/restore a task that was already deleted returns 404 instead of crashing', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: 'deleted test task', typeCode: 'code_impl', priorityCode: 'p2' })
    // 模拟 AI/外部已把任务行删除，前端仍残留该任务并尝试归档。
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)

    const archive = await request('POST', `/api/workbench/tasks/${task.id}/archive`)
    assert.equal(archive.status, 404)
    assert.match(archive.body.error, /task not found/)

    const restore = await request('POST', `/api/workbench/tasks/${task.id}/restore`)
    assert.equal(restore.status, 404)
    assert.match(restore.body.error, /task not found/)

    const patchArchive = await request('PATCH', `/api/workbench/tasks/${task.id}`, { archived: true })
    assert.equal(patchArchive.status, 404)
    assert.match(patchArchive.body.error, /task not found/)
  })
})

test('draft defer/resume/abandon API: 暂存不弹窗、可唤回、驳回留痕', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: 'defer test task', typeCode: 'code_impl', priorityCode: 'p1', aiPolicyCode: 'execute' })
    const created = await request('POST', '/api/workbench/drafts', {
      kindCode: 'completion',
      sessionId: 'sess-defer',
      payload: { taskId: task.id, summary: '完成总结', sessionId: 'sess-defer' },
    })
    assert.equal(created.status, 201)
    const draftId = created.body.draft.id

    // 未暂存：自动弹窗查询能取到
    const before = await request('GET', '/api/workbench/drafts')
    assert.equal(before.body.draft.id, draftId)
    assert.deepEqual(before.body.deferredDrafts, [])

    // 暂存：弹窗查询跳过，暂存清单出现
    const deferred = await request('POST', `/api/workbench/drafts/${draftId}/defer`, { note: '先去跑回归' })
    assert.equal(deferred.status, 200)
    assert.equal(deferred.body.draft.deferredAt !== null, true)
    assert.equal(deferred.body.draft.statusCode, 'pending')
    const after = await request('GET', '/api/workbench/drafts')
    assert.equal(after.body.draft, null)
    assert.deepEqual(after.body.deferredDrafts.map((d) => d.id), [draftId])
    // 留痕：任务事件 + 共享记忆
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM task_events WHERE task_id = ? AND event_code = 'completion_deferred'").get(task.id).c, 1)

    // 唤回：重新进入自动弹窗队列
    const resumed = await request('POST', `/api/workbench/drafts/${draftId}/resume`)
    assert.equal(resumed.status, 200)
    assert.equal(resumed.body.draft.deferredAt, null)
    const back = await request('GET', '/api/workbench/drafts')
    assert.equal(back.body.draft.id, draftId)

    // 驳回：带原因，留痕
    const abandoned = await request('POST', `/api/workbench/drafts/${draftId}/abandon`, { reason: '回归测试未通过' })
    assert.equal(abandoned.status, 200)
    const rejectedEvent = db.prepare("SELECT note FROM task_events WHERE task_id = ? AND event_code = 'completion_rejected'").get(task.id)
    assert.equal(rejectedEvent.note.includes('回归测试未通过'), true)
    const memories = db.prepare('SELECT content FROM task_memories WHERE task_id = ? ORDER BY created_at DESC').all(task.id)
    assert.equal(memories.some((row) => row.content.includes('回归测试未通过')), true)
  })
})

test('draft defer API: 非验收类草稿不可暂存', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', '/api/workbench/drafts', { kindCode: 'report', payload: { periodCode: 'day' } })
    const res = await request('POST', `/api/workbench/drafts/${created.body.draft.id}/defer`)
    assert.equal(res.status, 400)
    assert.match(res.body.error, /cannot be deferred/)
  })
})

test('点子文件夹：新建 / 改名 / 归入 / 移出 / 合并', async () => {
  await withServer(async ({ request }) => {
    const a = await request('POST', '/api/workbench/ideas', { title: '点子 A', kindCode: 'plugin', tags: [] })
    const b = await request('POST', '/api/workbench/ideas', { title: '点子 B', kindCode: 'spark', tags: [] })
    assert.equal(a.status, 201)
    assert.equal(b.status, 201)

    // 手动建两个空文件夹
    const f1 = await request('POST', '/api/workbench/idea-clusters', { title: '微信提醒方向' })
    const f2 = await request('POST', '/api/workbench/idea-clusters', { title: 'UI 与交互' })
    assert.equal(f1.status, 201)
    assert.equal(f2.status, 201)
    assert.deepEqual(f1.body.cluster.ideas, [])

    // 改名
    const renamed = await request('PATCH', `/api/workbench/idea-clusters/${f1.body.cluster.id}`, { title: '微信提醒（已改名）' })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.body.cluster.title, '微信提醒（已改名）')

    // 归入：一个点子可进多个文件夹（多对多）
    const in1 = await request('POST', `/api/workbench/idea-clusters/${f1.body.cluster.id}/ideas`, { ideaId: a.body.idea.id })
    assert.equal(in1.body.cluster.ideas.length, 1)
    const in2 = await request('POST', `/api/workbench/idea-clusters/${f2.body.cluster.id}/ideas`, { ideaId: a.body.idea.id })
    assert.equal(in2.body.cluster.ideas.length, 1)

    // 未归类只含 B（A 已被两个文件夹引用）
    const ideas = await request('GET', '/api/workbench/ideas')
    const clusters = await request('GET', '/api/workbench/idea-clusters')
    const filedIds = new Set(clusters.body.clusters.flatMap((cluster) => cluster.ideas.map((idea) => idea.id)))
    assert.equal(ideas.body.ideas.filter((idea) => !filedIds.has(idea.id)).map((idea) => idea.title).join(','), '点子 B')

    // 移出
    const out = await request('DELETE', `/api/workbench/idea-clusters/${f1.body.cluster.id}/ideas/${a.body.idea.id}`)
    assert.equal(out.status, 200)
    assert.equal(out.body.cluster.ideas.length, 0)

    // 合并：把 f2 并入 f1（f2 的成员挂过去、f2 删除；f1 原有成员保留）
    await request('POST', `/api/workbench/idea-clusters/${f2.body.cluster.id}/ideas`, { ideaId: b.body.idea.id })
    const merged = await request('POST', `/api/workbench/idea-clusters/${f2.body.cluster.id}/merge`, { into: f1.body.cluster.id })
    assert.equal(merged.status, 200)
    assert.deepEqual(merged.body.cluster.ideas.map((idea) => idea.title).sort(), ['点子 A', '点子 B'])
    const after = await request('GET', `/api/workbench/idea-clusters/${f2.body.cluster.id}`)
    assert.equal(after.status, 404)
  })
})
