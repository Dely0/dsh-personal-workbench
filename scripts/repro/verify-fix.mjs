/**
 * 修后验收：走真实 HTTP 路由，验证
 *  ① 同一条 task 草稿被确认两次 → 只建一条任务，第二次回放同一条（replayed=true）
 *  ② 两条独立同内容草稿各确认一次 → 第二条会带 duplicateOf 告警，但**不阻止**创建
 *  ③ intent=dedupe → 用户选择"复用已有那条"时不新建
 *  ④ 已完成/已放弃的草稿再确认 → 400，绝不新建
 */
import http from 'node:http'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { seedDictionaries } from '../../lib/db/seed.js'
import { makeRoutes } from '../../lib/api/routes.js'
import { listTasks } from '../../lib/db/repo.js'

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
const mk = (sessionId, description) => ({
  kindCode: 'task', sessionId,
  payload: { title: '仅测试，不思考，直接提交任务', typeCode: 'personal', priorityCode: 'p3', statusCode: 'todo', description, subtasks: [] },
})

console.log('=== ① 同一条草稿确认两次 ===')
const d1 = (await request('POST', '/api/workbench/drafts', mk('s1', 'A'))).body.draft
const r1 = await request('POST', `/api/workbench/drafts/${d1.id}/confirm`)
const r1b = await request('POST', `/api/workbench/drafts/${d1.id}/confirm`)
console.log('  第一次:', r1.status, r1.body.task.id.slice(0, 8), 'created=' + r1.body.created)
console.log('  第二次:', r1b.status, r1b.body.task.id.slice(0, 8), 'replayed=' + r1b.body.replayed, '同一条=' + (r1.body.task.id === r1b.body.task.id))
console.log('  库里该标题条数:', listTasks(db).filter((t) => t.title === '仅测试，不思考，直接提交任务').length)

console.log('\n=== ② 两条独立草稿（复现事故形态）===')
const d2 = (await request('POST', '/api/workbench/drafts', mk('s2', 'B'))).body.draft
const r2 = await request('POST', `/api/workbench/drafts/${d2.id}/confirm`)
console.log('  第二条确认:', r2.status, r2.body.task.id.slice(0, 8))
console.log('  duplicateOf 告警:', JSON.stringify(r2.body.duplicateOf))
console.log('  库里该标题条数:', listTasks(db).filter((t) => t.title === '仅测试，不思考，直接提交任务').length, '（②不阻止建单，符合"只告警"决策）')

console.log('\n=== ③ intent=dedupe（用户看到告警后选择复用）===')
const d3 = (await request('POST', '/api/workbench/drafts', mk('s3', 'C'))).body.draft
const r3 = await request('POST', `/api/workbench/drafts/${d3.id}/confirm`, { intent: 'dedupe' })
console.log('  确认:', r3.status, r3.body.task.id.slice(0, 8), 'reused=' + r3.body.reused, '| 与第一条同一条=' + (r3.body.task.id === r1.body.task.id))
console.log('  库里该标题条数:', listTasks(db).filter((t) => t.title === '仅测试，不思考，直接提交任务').length, '（dedupe 不新建）')

console.log('\n=== ④ 已放弃的草稿再确认 ===')
const d4 = (await request('POST', '/api/workbench/drafts', mk('s4', 'D'))).body.draft
await request('POST', `/api/workbench/drafts/${d4.id}/abandon`)
const r4 = await request('POST', `/api/workbench/drafts/${d4.id}/confirm`)
console.log('  状态/响应:', r4.status, JSON.stringify(r4.body))
console.log('  库里该标题条数:', listTasks(db).filter((t) => t.title === '仅测试，不思考，直接提交任务').length)

console.log('\n=== ⑤ 已完成任务后，验收草稿确认不会动任务数 ===')
const before = listTasks(db).length
const done = (await request('POST', '/api/workbench/drafts', { kindCode: 'completion', sessionId: 's5', payload: { taskId: r1.body.task.id, summary: '做完' } })).body.draft
const c1 = await request('POST', `/api/workbench/drafts/${done.id}/confirm`)
const c2 = await request('POST', `/api/workbench/drafts/${done.id}/confirm`)
console.log('  第一次:', c1.status, c1.body.task?.statusCode, '| 第二次:', c2.status, JSON.stringify(c2.body))
console.log('  任务数 before/after:', before, listTasks(db).length)

server.close(); db.close()
