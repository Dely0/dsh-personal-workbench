/**
 * 受控实验：还原 06:12–06:13 的每一步，看「用户看到的弹框」是否会被静默换掉。
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
/** 模拟前端 5 秒轮询：`pendingDraft = res.draft`（未被 dismiss 的那份）。 */
const banner = async (label) => {
  const r = await request('GET', '/api/workbench/drafts')
  const d = r.body.draft
  console.log(`   [${label}] 弹框显示 → ${d === null ? '(无)' : `${d.kindCode} / ${d.id.slice(0, 8)} / 「${String(d.payload?.title ?? d.payload?.taskId ?? '').slice(0, 20)}」 / deferCount=${d.deferCount}`}`)
  return d
}

const ws = 'D:\\Code\\Linksight\\dsh-workbench\\仅测试，不思考，直接提交任务'
const mkTask = (sessionId, description) => ({
  kindCode: 'task', sessionId,
  payload: { title: '仅测试，不思考，直接提交任务', typeCode: 'personal', priorityCode: 'p3', statusCode: 'todo', workspacePath: ws, description, subtasks: [] },
})

console.log('① 快速录入草稿（06:10:42）')
const dTaskA = (await request('POST', '/api/workbench/drafts', mkTask('session-6e9b609e', 'A'))).body.draft
await banner('06:10:42')
console.log('② 用户确认 → 任务 A（06:11:36）')
await request('POST', `/api/workbench/drafts/${dTaskA.id}/confirm`)
console.log('③ 执行会话提交完成验收草稿（06:12:07）')
const dDone = (await request('POST', '/api/workbench/drafts', { kindCode: 'completion', sessionId: 'session-5cf75152', payload: { taskId: 'x', summary: '做完了' } })).body.draft
await banner('06:12:07')
console.log('④ 用户点「暂存（先验证）」（06:12:35）→ 前端会 dismiss 这份 id')
await request('POST', `/api/workbench/drafts/${dDone.id}/defer`)

console.log('⑤ 执行会话又提交了一份同内容的 task 草稿（06:12:05 的真实顺序里它更早）')
const dTaskB = (await request('POST', '/api/workbench/drafts', mkTask('session-5cf75152', 'B'))).body.draft
let shown = await banner('06:12:35 起（轮询）')
console.log('   → 用户以为弹框里还是那份「验收申请」，实际上：', shown.kindCode, String(shown.payload?.title ?? '').slice(0, 24))
console.log('⑥ 用户点「⏸ 暂存」，其实暂存掉的是这份草稿（06:13:13 的第二次 defer）')
await request('POST', `/api/workbench/drafts/${shown.id}/defer`)
shown = await banner('06:13:13 起')
console.log('⑦ 此时 user 想「先把验收申请叫回来」→ 点「唤回」')
await request('POST', `/api/workbench/drafts/${dDone.id}/resume`)
shown = await banner('06:13:20 起')
console.log('⑧ 用户点主按钮（自以为在验收）→ confirm 的是：', shown.kindCode, shown.id.slice(0, 8))
await request('POST', `/api/workbench/drafts/${shown.id}/confirm`)

console.log('\n结果：库里的顶层任务')
for (const t of listTasks(db)) console.log('   ', t.statusCode, t.id.slice(0, 8), t.title, '|', String(t.description ?? '').slice(0, 20))
server.close(); db.close()
