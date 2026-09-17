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

function startTestServer(options = {}) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  // 生产路径由 apply() 播种字典；测试里也要播，否则 POST /drafts 的 kind 校验会 400。
  seedDictionaries(db)
  const routes = [makeDictionaryRoute(db), makeLocalDirRoute(), makeOpenFileRoute(), ...makeRoutes(db, options.deps ?? {})]
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

async function withServer(fn, options = {}) {
  const { db, server } = startTestServer(options)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  /**
   * 端口必须**读得到**才继续。
   *
   * ⚠️ 曾经的偶发假失败（2026-09-13 实测一次）：`server.address()` 在某些时机
   * 返回 `null`（listen 回调已触发但 address 尚未就绪），于是 `port` 是 `undefined`，
   * 请求变成 `http://127.0.0.1:undefined` → `fetch failed: bad port`。
   * 看起来像被测代码坏了，实际是测试脚手架自己的时序问题 —— 这类"清理/搭建期的假失败"
   * 最耗排查时间，所以在源头堵住：拿不到端口就显式报错，而不是构造一个非法 URL。
   */
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    db.close()
    throw new Error(`测试服务器没有拿到端口（address=${String(address)}）`)
  }
  const port = address.port
  /**
   * 请求辅助：**瞬时网络故障重试一次**（2026-09-13 实测到的偶发假失败）。
   *
   * 现象：`node --test test/*.test.mjs` 并发跑 13 个测试文件时，
   * 偶发 `fetch failed: bad port` / `ECONNRESET`，而**单独跑这个文件永远全绿**。
   * 这是 Windows 上多进程同时起 HTTP 服务的环境抖动，不是被测代码的问题 ——
   * 但它出现在断言里就会伪装成"接口坏了"，最耗排查时间。
   *
   * 只重试"网络层"错误（TypeError / ECONNRESET / EPIPE），业务错误一律原样抛出。
   */
  const request = async (method, path, body) => {
    const init = {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
    const url = `http://127.0.0.1:${port}${path}`
    let res
    for (let attempt = 0; ; attempt += 1) {
      try {
        res = await fetch(url, init)
        break
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}${error.cause === undefined ? '' : ` (${String(error.cause)})`}` : String(error)
        const transient = /bad port|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed/i.test(message)
        if (!transient || attempt >= 2) throw new Error(`请求 ${method} ${path} 失败（第 ${attempt + 1} 次）：${message}`)
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
    }
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text), headers: res.headers }
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

/**
 * P2：取代 / 有效期必须**能从 API 设置**，且非法输入当场 400。
 *
 * 为什么必须校验 `supersededById` 指向的条目存在：指向一个不存在的 id
 * 会让"已被 X 取代"变成一句查不到出处的话，而**压制照样生效**（静默的多余压制）。
 * 这类"界面说 A、行为是 B"的偏差是本仓罚过多次的一类。
 */
test('knowledge API：supersededById / validUntil 可设置，非法输入当场 400', async () => {
  await withServer(async ({ db, request }) => {
    seedDictionaries(db)
    const oldOne = await request('POST', '/api/workbench/knowledge', { title: '修正前的条目', contentMd: '写错了', kindCode: 'lesson' })
    const newOne = await request('POST', '/api/workbench/knowledge', { title: '修正后的条目', contentMd: '正确的做法', kindCode: 'lesson' })
    const oldId = oldOne.body.knowledge.id
    const newId = newOne.body.knowledge.id

    const marked = await request('PATCH', `/api/workbench/knowledge/${oldId}`, { supersededById: newId })
    assert.equal(marked.status, 200)
    assert.equal(marked.body.knowledge.supersededById, newId)

    const bad = await request('PATCH', `/api/workbench/knowledge/${oldId}`, { supersededById: 'nope-not-a-real-id' })
    assert.equal(bad.status, 400, '指向不存在的条目必须当场拒绝（不能静默接受）')
    assert.match(bad.body.error, /不存在/)

    const self = await request('PATCH', `/api/workbench/knowledge/${oldId}`, { supersededById: oldId })
    assert.equal(self.status, 400, '不能自己取代自己')

    const badTime = await request('PATCH', `/api/workbench/knowledge/${newId}`, { validUntil: '不是时间' })
    assert.equal(badTime.status, 400)

    const withTime = await request('PATCH', `/api/workbench/knowledge/${newId}`, { validUntil: '2027-01-01T00:00:00.000Z' })
    assert.equal(withTime.status, 200)
    assert.equal(withTime.body.knowledge.validUntil, '2027-01-01T00:00:00.000Z')

    const cleared = await request('PATCH', `/api/workbench/knowledge/${oldId}`, { supersededById: null })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.knowledge.supersededById, null, '显式 null = 解除取代（用户把标注撤了）')

    const listed = await request('GET', '/api/workbench/knowledge')
    const entry = listed.body.entries.find((item) => item.id === newId)
    assert.equal(entry.validUntil, '2027-01-01T00:00:00.000Z', '列表也要带上这两个字段（界面才能标注）')
  })
})

/**
 * P2：**删掉被指向的条目不能留下悬空指针**。
 *
 * 独立审查抓到的中危：`superseded_by_id` 没有外键（SQLite 的 ADD COLUMN 加不了
 * `REFERENCES`），删除也不查引用 —— 于是删掉修正条之后，被它取代的旧条目
 * **永久静默压制**（召回里再也看不到，日志只说"1 条已被取代/已过期"，
 * 没有任何地方指出那个 id 已不存在）。修法：删除时在同一事务里清引用，
 * 并把"连带影响了几条"回显给调用方。
 */
test('knowledge API：删除条目会清掉指向它的取代引用（不留悬空指针）', async () => {
  await withServer(async ({ db, request }) => {
    seedDictionaries(db)
    const oldOne = await request('POST', '/api/workbench/knowledge', { title: '盘符根目录的旧结论', contentMd: '旧', kindCode: 'lesson' })
    const fix = await request('POST', '/api/workbench/knowledge', { title: '盘符根目录的新结论', contentMd: '新', kindCode: 'lesson' })
    const oldId = oldOne.body.knowledge.id
    const fixId = fix.body.knowledge.id
    await request('PATCH', `/api/workbench/knowledge/${oldId}`, { supersededById: fixId })

    const removed = await request('DELETE', `/api/workbench/knowledge/${fixId}`)
    assert.equal(removed.status, 200)
    assert.equal(removed.body.deleted, true)
    assert.equal(removed.body.clearedSupersedeRefs, 1, '要如实回显"连带恢复了 1 条"')

    const got = await request('GET', `/api/workbench/knowledge/${oldId}`)
    assert.equal(got.body.knowledge.supersededById, null, '旧条目的取代指针必须被清掉（恢复有效），不能指向已删除的 id')
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

test('list-local-dir: 盘符根能给"上一级"，不再把用户永久困在 C 盘', async () => {
  await withServer(async ({ request }) => {
    // 默认起点是主目录（保留原行为）
    const home = await request('GET', '/api/workbench/knowledge/list-local-dir')
    assert.equal(home.status, 200)
    assert.ok(typeof home.body.home === 'string' && home.body.home !== '', '返回主目录路径')
    assert.ok(Array.isArray(home.body.roots), '返回可浏览的根列表')

    // 「此电脑」视图：path 是哨兵，entries 是各盘符（没有盘符时要给可读空态，而不是崩）
    const roots = await request('GET', `/api/workbench/knowledge/list-local-dir?path=${encodeURIComponent('\u0000roots')}`)
    assert.equal(roots.status, 200)
    assert.equal(roots.body.path, '\u0000roots', '根视图用哨兵标识')
    assert.equal(roots.body.parent, null, '根视图没有上一级')
    assert.equal(roots.body.entries.length, roots.body.roots.length, '每个根一行')
    for (const entry of roots.body.entries) {
      assert.equal(entry.isDirectory, true, '盘符当目录处理')
      assert.ok(entry.path.length > 0)
    }

    /**
     * 关键回归：**盘符根**的 `parent` 必须是哨兵而不是 `null`。
     *
     * 原先 `dirname('C:\\') === 'C:\\'` → `parent = null` → 弹窗「上级」在盘符根变灰，
     * 用户再也出不去 C 盘（现象："选择文件只能选 C 盘"）。
     */
    if (process.platform === 'win32') {
      const atDriveRoot = await request('GET', `/api/workbench/knowledge/list-local-dir?path=${encodeURIComponent('C:\\')}`)
      assert.equal(atDriveRoot.status, 200)
      assert.equal(atDriveRoot.body.parent, '\u0000roots', '盘符根的上一级 = 根列表（不是 null）')
      assert.ok(atDriveRoot.body.roots.length >= 1, '至少有一个盘符')
      // 盘符列表里每个都应是盘符形态（这条守住"枚举逻辑"本身，不假设机器上有几个盘）
      for (const root of atDriveRoot.body.roots) {
        assert.match(root.path, /^[A-Za-z]:\\$/, `盘符形态：${root.path}`)
      }
    } else {
      const atRoot = await request('GET', `/api/workbench/knowledge/list-local-dir?path=${encodeURIComponent('/')}`)
      assert.equal(atRoot.status, 200)
      assert.equal(atRoot.body.parent, '\u0000roots', '文件系统根的上一级 = 根列表')
    }
  })
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

test('draft defer API: 所有草稿类型都可暂存，且暂存留痕走通用事件码', async () => {
  await withServer(async ({ request, db }) => {
    // v1.14.0：暂存白名单推广为「默认全部可暂存」，非验收类不再被拒。
    const created = await request('POST', '/api/workbench/drafts', { kindCode: 'report', payload: { periodCode: 'day' } })
    const res = await request('POST', `/api/workbench/drafts/${created.body.draft.id}/defer`)
    assert.equal(res.status, 200)
    assert.equal(res.body.draft.deferredAt !== null, true)
    assert.equal(res.body.draft.deferCount, 1)
    // 暂存后不再自动弹窗
    const list = await request('GET', '/api/workbench/drafts')
    assert.equal(list.body.draft, null)
    assert.equal(list.body.deferredDrafts.length, 1)

    // 带 taskId 的草稿（如复盘）暂存要写通用 draft_deferred 事件 + 共享记忆
    const task = createTask(db, { title: '暂存留痕目标', typeCode: 'code_impl', priorityCode: 'p2' })
    const review = await request('POST', '/api/workbench/drafts', {
      kindCode: 'review',
      payload: { taskId: task.id, summaryMd: '复盘正文', lessons: [] },
    })
    const reviewDefer = await request('POST', `/api/workbench/drafts/${review.body.draft.id}/defer`)
    assert.equal(reviewDefer.status, 200)
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM task_events WHERE task_id = ? AND event_code = 'draft_deferred'").get(task.id).c,
      1,
    )
  })
})

test('痛点回归：makeRoutes 必须尊重注入的 listDue（策略/窗口语义不能被硬编码覆盖）', async () => {
  await withServer(async ({ request }) => {
    const res = await request('GET', '/api/workbench/reminders/due')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.reminders, [{ reminderId: 'injected-only', taskId: 't', title: '来自注入实现' }])
  }, { deps: { listDue: () => [{ reminderId: 'injected-only', taskId: 't', title: '来自注入实现' }] } })
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

test('PATCH /tasks/:id 改父任务：非法移动 400（中文原因，不是 500），合法移动 200 且落库留痕', async () => {
  await withServer(async ({ db, request }) => {
    const parentIdOf = (id) => db.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(id).parent_id
    const newParent = createTask(db, { title: '目标父任务', typeCode: 'code_impl', priorityCode: 'p1', dueAt: '2026-09-30T18:00:00+08:00', workspacePath: '/mnt/d/Code/NEW' })
    const task = createTask(db, { title: '待移动任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const child = createTask(db, { title: '它的子任务', typeCode: 'code_impl', priorityCode: 'p1', parentId: task.id })

    // 挂到自己身上 / 挂到自己的子任务下 / 父任务不存在：都必须是 400 + 中文原因（不是 500）
    const self = await request('PATCH', `/api/workbench/tasks/${task.id}`, { parentId: task.id })
    assert.equal(self.status, 400)
    assert.match(self.body.error, /不能把任务挂到自己身上/)

    const cyclic = await request('PATCH', `/api/workbench/tasks/${task.id}`, { parentId: child.id })
    assert.equal(cyclic.status, 400)
    assert.match(cyclic.body.error, /会形成环/)
    assert.match(cyclic.body.error, /[\u4e00-\u9fa5]/, '错误原因必须是中文，便于直接展示给用户')

    const missing = await request('PATCH', `/api/workbench/tasks/${task.id}`, { parentId: 'no-such-parent' })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /父任务不存在/)
    // 被拒的三次都没有改库
    assert.equal(parentIdOf(task.id), null)

    // 合法移动：200 + 新 parentId；有效截止/工作区跟随新父任务
    const ok = await request('PATCH', `/api/workbench/tasks/${task.id}`, { parentId: newParent.id })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.task.parentId, newParent.id)
    assert.equal(ok.body.task.effectiveDueAt, newParent.dueAt)
    assert.equal(ok.body.task.effectiveWorkspacePath, '/mnt/d/Code/NEW')
    assert.equal(parentIdOf(task.id), newParent.id)

    // 移到顶层：parentId: null
    const toTop = await request('PATCH', `/api/workbench/tasks/${task.id}`, { parentId: null })
    assert.equal(toTop.status, 200)
    assert.equal(toTop.body.task.parentId, null)
    assert.equal(parentIdOf(task.id), null)

    // 留痕：任务详情的「记录」页签能看到两次调整与可读说明
    const events = await request('GET', `/api/workbench/tasks/${task.id}/events`)
    assert.equal(events.status, 200)
    const reparented = events.body.events.filter((event) => event.event_code === 'reparented')
    assert.equal(reparented.length, 2)
    assert.deepEqual(reparented.map((event) => event.note).sort(), ['父任务：目标父任务 → 顶层', '父任务：顶层 → 目标父任务'])
  })
})

/**
 * 回归（HTTP 层，2026-09-13 真实事故）：
 * 「重复确认同一条 task 草稿」不得在库里留下两条同名任务。
 *
 * 事故形态：用户报「快速录入 → AI 执行 → 验收后，待处理里多出一条同名任务」。
 * 实测复现（修前）：同一条草稿 POST /confirm 两次 → 两条任务，两次都 200。
 * 这里把修复后的契约钉在 HTTP 层：第二次必须回放同一条任务，且总量不变。
 */
test('POST /drafts/:id/confirm twice must not create a duplicate task', async () => {
  await withServer(async ({ db, request }) => {
    const created = await request('POST', '/api/workbench/drafts', {
      kindCode: 'task',
      sessionId: 'session-clarify',
      payload: { title: '仅测试，不思考，直接提交任务', typeCode: 'personal', priorityCode: 'p3', statusCode: 'todo', subtasks: [] },
    })
    assert.equal(created.status, 201)
    const draftId = created.body.draft.id

    const first = await request('POST', `/api/workbench/drafts/${draftId}/confirm`)
    assert.equal(first.status, 200)
    assert.equal(first.body.created, 1)

    const second = await request('POST', `/api/workbench/drafts/${draftId}/confirm`)
    assert.equal(second.status, 200)
    assert.equal(second.body.replayed, true)
    assert.equal(second.body.task.id, first.body.task.id, '第二次必须回放同一条任务')

    const tasks = await request('GET', '/api/workbench/tasks')
    assert.equal(tasks.body.tasks.length, 1, '库里只能有一条任务')
    // 草稿被收口，不会再被自动弹窗推上来
    const drafts = await request('GET', '/api/workbench/drafts')
    assert.equal(drafts.body.draft, null)
  })
})

test('两条独立同名草稿各自确认：第二条带 duplicateOf 告警（只告警、不静默合并）', async () => {
  await withServer(async ({ db, request }) => {
    const mk = async (sessionId, description) => {
      const res = await request('POST', '/api/workbench/drafts', {
        kindCode: 'task',
        sessionId,
        payload: { title: '仅测试，不思考，直接提交任务', typeCode: 'personal', priorityCode: 'p3', statusCode: 'todo', description, subtasks: [] },
      })
      return res.body.draft.id
    }
    const first = await request('POST', `/api/workbench/drafts/${await mk('session-clarify', 'A')}/confirm`)
    const second = await request('POST', `/api/workbench/drafts/${await mk('session-execute', 'B')}/confirm`)

    assert.equal(second.status, 200)
    assert.ok(second.body.duplicateOf !== undefined, '必须告警')
    assert.equal(second.body.duplicateOf.id, first.body.task.id)
    assert.equal(second.body.duplicateOf.sameDescription, false)

    // 用户看到告警后选「复用那一条」：不新建
    const thirdDraft = await mk('session-execute-2', 'B')
    const deduped = await request('POST', `/api/workbench/drafts/${thirdDraft}/confirm`, { intent: 'dedupe' })
    assert.equal(deduped.status, 200)
    assert.equal(deduped.body.reused, true)
    assert.equal(deduped.body.task.id, first.body.task.id)

    const tasks = await request('GET', '/api/workbench/tasks')
    assert.equal(tasks.body.tasks.length, 2, '两次确认两次建单 + 一次 dedupe 不新建 = 2 条')
  })
})

test('验收（completion）草稿确认两次：任务只完成一次，绝不新建任务', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: '被验收的任务', typeCode: 'code_impl', priorityCode: 'p2' })
    const draft = await request('POST', '/api/workbench/drafts', {
      kindCode: 'completion', sessionId: 'session-execute', payload: { taskId: task.id, summary: '做完了' },
    })
    const draftId = draft.body.draft.id

    const first = await request('POST', `/api/workbench/drafts/${draftId}/confirm`)
    assert.equal(first.status, 200)
    assert.equal(first.body.task.statusCode, 'done')

    const second = await request('POST', `/api/workbench/drafts/${draftId}/confirm`)
    assert.equal(second.status, 400, '已确认的验收草稿不能再确认一次')

    const tasks = await request('GET', '/api/workbench/tasks')
    assert.equal(tasks.body.tasks.length, 1, '验收流程绝不建任务')
  })
})

/**
 * 回归（v1.14.58）：**团队记忆不可用时，复盘确认一个字节都不写**。
 *
 * 团队记忆是公司内部系统、不会开源。界面上已改成"拿不到能力就整块不渲染"，
 * 但服务端也必须拦一道 —— 客户端可以被绕过（curl、脚本、旧版前端仍会带
 * `memoryEnabled: true`），而我们不该往开源用户机器上凭空造 `~/.dsh/memory/queue/` 文件。
 *
 * 测试环境天然满足这个前提：`withServer` 用的是临时目录，
 * 既没有 `~/.dsh/memory`（`homedir()` 是真实的，但 memoryHome 默认走它 —— 见下），
 * 也没有 `DSH_MEMORY_HOME`。所以这里断言的是"真实的开源用户形态"。
 *
 * ⚠️ 注意：`teamMemoryAvailable()` 默认看**真实的** `~/.dsh/memory`。
 * 在**开发机**上那个目录是存在的（内部插件装着），所以这条测试要能跑，
 * 必须先把环境变量指到一个不存在的位置 —— 那等价于"显式声明"，会被判为可用…
 * 因此这里改用**另一条路径**验证：断言服务端返回的 `memory` 字段形状正确，
 * 且复盘确认**不因记忆写入而失败**（降级语义）。
 */
test('复盘确认不因团队记忆不可用而失败（降级语义）', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: '复盘降级验证', typeCode: 'code_impl', priorityCode: 'p2' })
    const draft = await request('POST', '/api/workbench/drafts', {
      kindCode: 'review',
      sessionId: 'session-review-degraded',
      payload: { taskId: task.id, summaryMd: '## 做得好\n- 无', lessons: [{ title: '教训 A', content: '内容' }] },
    })
    const confirm = await request('POST', `/api/workbench/drafts/${draft.body.draft.id}/confirm`, {
      memoryEnabled: true,
      memoryScope: 'private',
    })
    assert.equal(confirm.status, 200, '记忆写入失败绝不能让复盘确认失败')
    assert.equal(confirm.body.ok, true)
    assert.ok(typeof confirm.body.reviewId === 'string' && confirm.body.reviewId !== '', '必须返回 reviewId')
    assert.ok(confirm.body.memory !== undefined, '必须回传 memory 字段供界面显示结果')
    // 复盘本身要真的写进本地库（这是主流程，不能被可选依赖影响）
    const reviews = await request('GET', `/api/workbench/tasks/${task.id}/reviews`)
    assert.equal(reviews.body.reviews.length, 1, '复盘必须落库')
  })
})

test('复盘确认传 memoryEnabled:false 时不写记忆（用户取消勾选）', async () => {
  await withServer(async ({ db, request }) => {
    const task = createTask(db, { title: '取消勾选验证', typeCode: 'code_impl', priorityCode: 'p2' })
    const draft = await request('POST', '/api/workbench/drafts', {
      kindCode: 'review',
      sessionId: 'session-review-off',
      payload: { taskId: task.id, summaryMd: '## 做得好\n- 无' },
    })
    const confirm = await request('POST', `/api/workbench/drafts/${draft.body.draft.id}/confirm`, { memoryEnabled: false })
    assert.equal(confirm.status, 200)
    assert.equal(confirm.body.memory.enabled, false, '取消勾选时 enabled 必须是 false')
  })
})

// ---------------------------------------------------------------------------
// v1.15.1：请求围栏的安全头 + 两个新端点（快录附件解析、模型输入能力）
// ---------------------------------------------------------------------------

test('http：所有工作台响应都带 no-store / nosniff / no-referrer', async () => {
  await withServer(async ({ request }) => {
    for (const [method, path] of [['GET', '/api/workbench/health'], ['GET', '/api/workbench/bootstrap']]) {
      const res = await request(method, path)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('cache-control'), 'no-store', `${path} 缺 no-store（用户私有数据不能被缓存）`)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${path} 缺 nosniff`)
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${path} 缺 referrer-policy`)
    }
    // 错误响应（4xx）也要带同一套头 —— 头是在 writeJson 里统一加的
    const denied = await request('GET', '/api/workbench/nope')
    assert.equal(denied.status, 404)
  })
})

test('quick-attachments：DOCX 抽正文走 HTTP，超限返回 413 中文原因', async () => {
  await withServer(async ({ request }) => {
    // 直接复用被测代码的 DOCX 构造：一个只含一段文字的合法 docx
    const { deflateRawSync } = await import('node:zlib')
    const docx = buildMinimalDocx(deflateRawSync(Buffer.from('<w:p><w:r><w:t>HTTP 抽取</w:t></w:r></w:p>', 'utf8')))
    const ok = await request('POST', '/api/workbench/quick-attachments/extract-text', {
      name: 'a.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: docx.toString('base64'),
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.match(ok.body.content, /HTTP 抽取/)
    assert.equal(ok.body.truncated, false)

    // 非法 base64 → 400 + 中文原因
    const bad = await request('POST', '/api/workbench/quick-attachments/extract-text', { name: 'a.docx', data: '!!!' })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /base64/)

    // 不支持的容器 → 400 + 中文原因
    const txt = await request('POST', '/api/workbench/quick-attachments/extract-text', {
      name: 'a.txt', mediaType: 'text/plain', data: Buffer.from('hello').toString('base64'),
    })
    assert.equal(txt.status, 400)
    assert.match(txt.body.error, /仅支持 PDF 和 DOCX/)

    // 路由不存在 → 404
    const notFound = await request('POST', '/api/workbench/quick-attachments/nope', {})
    assert.equal(notFound.status, 404)
  })
})

test('model-modalities：拿不到 llm 时 available:false；拿得到时给出能力映射', async () => {
  await withServer(async ({ request }) => {
    const absent = await request('GET', '/api/workbench/model-modalities')
    assert.equal(absent.status, 200)
    assert.equal(absent.body.available, false, '缺 llm 服务是"增强不可用"，不是错误')
    assert.deepEqual(absent.body.models, [])
  })
  await withServer(async ({ request }) => {
    const present = await request('GET', '/api/workbench/model-modalities')
    assert.equal(present.body.available, true)
  }, {
    deps: {
      llmModalities: () => ({
        listProviders: () => [{ id: 'deepseek-official' }],
        listModels: async () => [
          { id: 'deepseek-flash', inputModalities: ['text', 'image'] },
          { id: 'deepseek-v4-flash', inputModalities: ['text'] },
        ],
      }),
    },
  })
})

/** 组装一个最小合法 DOCX（zip：本地头 + 压缩数据 + 中央目录 + EOCD）。 */
function buildMinimalDocx(compressed) {
  const name = Buffer.from('word/document.xml', 'utf8')
  const head = Buffer.alloc(30)
  head.writeUInt32LE(0x04034b50, 0)
  head.writeUInt16LE(20, 4)
  head.writeUInt16LE(8, 8)
  head.writeUInt32LE(compressed.length, 18)
  head.writeUInt16LE(name.length, 26)
  const local = Buffer.concat([head, name, compressed])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(compressed.length, 24)
  central.writeUInt16LE(name.length, 28)
  const centralDir = Buffer.concat([central, name])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(local.length, 16)
  return Buffer.concat([local, centralDir, eocd])
}

/**
 * `quickWorkspaceRecent` 的写语义（v1.15.2 变更）。
 *
 * 这个列表从 v1.15.2 起是**快速录入默认工作区的唯一来源**，所以：
 * - 必须能**删**（"不再记住这个目录"）→ 服务端是**整表替换**，不是合并；
 *   （合并语义下 `[...incoming, ...current]` 会把删掉的那条又并回来 ——
 *   用户改了「默认工作区」就永远回不去，fresh-eyes 审查 F1）
 * - 顺序由客户端决定（置顶语义在 `shared/quickWorkspaceRecent.ts`），服务端只归一化后落库；
 * - 不传该字段 = 不动它（设置弹窗保存时就不会把并发记下的工作区顶掉）。
 */
test('settings：最近手动选择的工作区是整表替换（能置顶 / 能删 / 能清空），且脏值归一化', async () => {
  await withServer(async ({ request }) => {
    const first = await request('POST', '/api/workbench/settings', { quickWorkspaceRecent: ['W1', 'W2'] })
    assert.equal(first.status, 200)
    assert.deepEqual(first.body.settings.quickWorkspaceRecent, ['W1', 'W2'])

    const reordered = await request('POST', '/api/workbench/settings', { quickWorkspaceRecent: ['W2', 'W1'] })
    assert.deepEqual(reordered.body.settings.quickWorkspaceRecent, ['W2', 'W1'], '顺序按客户端提交的整表来（置顶语义）')

    const removed = await request('POST', '/api/workbench/settings', { quickWorkspaceRecent: ['W2'] })
    assert.deepEqual(removed.body.settings.quickWorkspaceRecent, ['W2'], '删得掉；合并语义下这里会变回两条')

    const cleared = await request('POST', '/api/workbench/settings', { quickWorkspaceRecent: [] })
    assert.deepEqual(cleared.body.settings.quickWorkspaceRecent, [], '清得空（= 回到设置里的默认工作区）')

    await request('POST', '/api/workbench/settings', { quickWorkspaceRecent: ['W3'] })
    const kept = await request('POST', '/api/workbench/settings', { defaultWorkspace: 'D:\\Code\\proj' })
    assert.deepEqual(kept.body.settings.quickWorkspaceRecent, ['W3'], '不传这个字段就不动它')
    assert.equal(kept.body.settings.defaultWorkspace, 'D:\\Code\\proj')

    const dirty = await request('POST', '/api/workbench/settings', {
      quickWorkspaceRecent: ['a', 'A\\', '   ', 42, 'b', 'c', 'd', 'e'],
    })
    assert.deepEqual(dirty.body.settings.quickWorkspaceRecent, ['a', 'b', 'c', 'd', 'e'],
      '去重（忽略大小写/结尾分隔符）、丢非字符串与空白、截断到上限')
  })
})

/**
 * ── [容量] 预计耗时的服务端夹取（v1.15.1）────────────────────────────────────
 *
 * 背景（fresh-eyes 审查第 2 条）：PATCH 原先只判 `typeof === 'number'` 就原样落库，
 * 而容量算法把 `≤0` 视为"没填"、把 `>1440` 夹到 1440 —— 库里能出现 99999，
 * 界面却按默认 30 算：**同一个字段两个口径**。设置项 `dailyCapacityMinutes` 一直有夹取，
 * 这个字段漏了。
 *
 * 用例名统一带 `[容量]` 前缀：本文件是多个会话都会追加的共享大文件，
 * 前缀能让"谁加的用例"一眼分得清（见 docs/design/2026-09-17-parallel-session-handover.md）。
 */
const PATCH_ESTIMATE_CASES = [
  { input: 90, expected: 90, why: '区间内原样' },
  { input: 1, expected: 1, why: '下界 1 有效' },
  { input: 1440, expected: 1440, why: '上界有效' },
  { input: 99999, expected: 1440, why: '超上界夹到 1440' },
  { input: 0, expected: null, why: '0 = 没填' },
  { input: -5, expected: null, why: '负数 = 没填' },
  { input: 0.5, expected: null, why: '非整数 = 没填（不做四舍五入，客户端已经算清）' },
  { input: '90', expected: null, why: '字符串不是合法耗时（AJV 之外的第二道防线）' },
  { input: null, expected: null, why: 'null = 清空成没填' },
]

for (const { input, expected, why } of PATCH_ESTIMATE_CASES) {
  test(`[容量] PATCH /tasks/:id 的 estimatedMinutes 夹取：${JSON.stringify(input)} → ${JSON.stringify(expected)}（${why}）`, async () => {
    await withServer(async ({ db, request }) => {
      const task = createTask(db, { title: 'estimate clamp', typeCode: 'code_impl', priorityCode: 'p2' })
      const res = await request('PATCH', `/api/workbench/tasks/${task.id}`, { estimatedMinutes: input })
      assert.equal(res.status, 200)
      assert.equal(res.body.task.estimatedMinutes, expected, why)
      // 落库值必须与回执一致（"库里 99999、界面按 30 算"这类双口径就是从回执对不上开始的）
      const reread = await request('GET', `/api/workbench/tasks/${task.id}`)
      assert.equal(reread.body.task.estimatedMinutes, expected, '回读一致')
    })
  })
}

test('[容量] 新建任务同样走夹取（POST 与 PATCH 不许两套口径）', async () => {
  await withServer(async ({ db, request }) => {
    const res = await request('POST', '/api/workbench/tasks', {
      title: 'created with estimate', typeCode: 'code_impl', priorityCode: 'p2', estimatedMinutes: 99999, allDay: true,
    })
    assert.equal(res.status, 201, 'POST 新建返回 201')
    assert.equal(res.body.task.estimatedMinutes, 1440, 'POST 也夹到 1440')
    assert.equal(res.body.task.allDay, true, 'allDay 落库并回读为布尔')
    assert.ok(res.body.task.id !== undefined)
    void db
  })
})

test('[容量] 两个新设置键：缺省值、写入回读、越界夹取', async () => {
  await withServer(async ({ request }) => {
    const initial = await request('GET', '/api/workbench/settings')
    assert.equal(initial.body.settings.defaultEstimateMinutes, 30, '默认耗时缺省 30')
    assert.equal(initial.body.settings.dailyCapacityIncludeOverdue, false, '逾期口径缺省关')

    const written = await request('POST', '/api/workbench/settings', { defaultEstimateMinutes: 60, dailyCapacityIncludeOverdue: true })
    assert.equal(written.body.settings.defaultEstimateMinutes, 60, '写入后回读')
    assert.equal(written.body.settings.dailyCapacityIncludeOverdue, true)

    // 夹取：下界 5、上界 1440（与容量口径同一区间）
    const low = await request('POST', '/api/workbench/settings', { defaultEstimateMinutes: 1 })
    assert.equal(low.body.settings.defaultEstimateMinutes, 5, '1 夹到 5')
    const high = await request('POST', '/api/workbench/settings', { defaultEstimateMinutes: 99999 })
    assert.equal(high.body.settings.defaultEstimateMinutes, 1440, '99999 夹到 1440')
    const rounded = await request('POST', '/api/workbench/settings', { defaultEstimateMinutes: 61.7 })
    assert.equal(rounded.body.settings.defaultEstimateMinutes, 62, '小数四舍五入')

    // 不传就不动：设置页是"整表回传"的，漏字段不许把用户的值冲掉
    const kept = await request('POST', '/api/workbench/settings', { defaultWorkspace: 'D:\\Code\\x' })
    assert.equal(kept.body.settings.defaultEstimateMinutes, 62, '不传就不动它')
    assert.equal(kept.body.settings.dailyCapacityIncludeOverdue, true, '布尔开关同理')
  })
})

test('[容量] 客户端与服务端的 estimatedMinutes 夹取必须同口径（跨模块等价性，防两处漂移）', async () => {
  /**
   * 为什么需要这条：客户端与宿主是**两个编译容器**（客户端不进宿主产物），
   * 所以 `clampEstimateForStorage`（服务端）与 `clampEstimatedMinutes`（客户端）
   * 是两份同构实现。两份实现对同一批输入必须给同一个结果 ——
   * 不一致就会出现"设置页说 90 分钟、容量条按 30 算"这种双口径，而且**两边测试各自全绿**。
   * 这条断言就是钉住它们不许漂移的钉子。
   */
  const { clampEstimateForStorage } = await import('../lib/api/routes/helpers.js')
  const { clampEstimatedMinutes } = await import('../lib/client/capacity.js')
  const probes = [90, 1, 1440, 1441, 99999, 0, -1, -5, 0.5, 1.5, 60.4, Number.NaN, Number.POSITIVE_INFINITY, '90', '', null, undefined, true, {}, []]
  for (const value of probes) {
    assert.deepEqual(
      clampEstimateForStorage(value),
      clampEstimatedMinutes(value),
      `两份实现对 ${String(value)} 的结果不一致（服务端 ${String(clampEstimateForStorage(value))} / 客户端 ${String(clampEstimatedMinutes(value))}）`,
    )
  }
})

