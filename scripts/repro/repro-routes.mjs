/**
 * 在真实 HTTP 路由层复现「验收后出现同名重复任务」。
 * 用的就是工作台的 route handler + 内存库（与 test/routes.test.mjs 同一套装配）。
 */
import http from 'node:http'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { seedDictionaries } from '../../lib/db/seed.js'
import { makeRoutes } from '../../lib/api/routes.js'
import { listTasks, listTaskEvents } from '../../lib/db/repo.js'

const db = openWorkbenchDb({ dbPath: ':memory:' })
seedDictionaries(db)
const routes = makeRoutes(db, {})
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  for (const route of routes) {
    if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
    if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
  }
  res.writeHead(404).end('{}')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const request = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : JSON.parse(text) }
}
const log = (...a) => console.log(...a)

const ws = 'D:\\Code\\Linksight\\dsh-workbench\\仅测试，不思考，直接提交任务'
const draftBody = {
  kindCode: 'task', sessionId: 'session-6e9b609e',
  payload: { title: '仅测试，不思考，直接提交任务', typeCode: 'personal', priorityCode: 'p3', statusCode: 'todo', workspacePath: ws, description: 'A', subtasks: [] },
}

log('=== 事件 1：快速录入草稿 06:10:42 ===')
const d1 = (await request('POST', '/api/workbench/drafts', draftBody)).body.draft
log('    draft1 =', d1.id)

log('=== 事件 2：用户确认 → 任务 A（06:11:36） ===')
const c1 = await request('POST', `/api/workbench/drafts/${d1.id}/confirm`)
log('    confirm1:', c1.status, c1.body.task?.id, c1.body.task?.statusCode)

log('=== 事件 3：执行会话又提交了一份同内容 task 草稿（06:12:05） ===')
const d2 = (await request('POST', '/api/workbench/drafts', { ...draftBody, sessionId: 'session-5cf75152', payload: { ...draftBody.payload, description: 'B', aiPolicyCode: 'none' } })).body.draft
log('    draft2 =', d2.id)

log('=== 事件 4：GET /drafts 前端会拿到哪一份？ ===')
const poll = await request('GET', '/api/workbench/drafts')
log('    latest active =', poll.body.draft?.id, '| kind =', poll.body.draft?.kindCode, '| 提示标题 =', JSON.stringify(poll.body.draft?.payload?.title))

log('=== 事件 5：暂存验收草稿（06:13:13）后再 GET ===')
log('=== 事件 6：用户点「验收通过」→ 确认的是哪一份？ ===')
const c2 = await request('POST', `/api/workbench/drafts/${d2.id}/confirm`)
log('    confirm2:', c2.status, c2.body.task?.id, c2.body.task?.statusCode)
const tasks = listTasks(db)
log('\n结果：库里的顶层任务');
for (const t of tasks) log('   ', t.statusCode, t.id, t.title)

log('\n=== 对照实验：同一条草稿被 POST confirm 两次 ===')
const d3 = (await request('POST', '/api/workbench/drafts', { ...draftBody, sessionId: 's-dup', payload: { ...draftBody.payload, title: '双确认实验' } })).body.draft
const x1 = await request('POST', `/api/workbench/drafts/${d3.id}/confirm`)
const x2 = await request('POST', `/api/workbench/drafts/${d3.id}/confirm`)
log('    第一次:', x1.status, x1.body.task?.id)
log('    第二次:', x2.status, x2.body.task?.id ?? JSON.stringify(x2.body))
log('    库里「双确认实验」条数:', listTasks(db).filter((t) => t.title === '双确认实验').length)

server.close(); db.close()
