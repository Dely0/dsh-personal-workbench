/**
 * T2/D05–D07 的端到端测试：**每日计划投入与"今日投入结束"的完整生命周期**。
 *
 * 覆盖需求 §4 与验收 AX-D03 / AX-D05 / AX-D06 / AX-D09 / AX-C05，以及 CP2 的合成长任务闭环：
 *
 * > 合成 doing 任务估时 600、截止未来 5 天，今天排 90 并结束投入；刷新后 task 仍 doing、
 * > progress 原值、minutes 90、effortDone=true、明天新项=false。
 *
 * 证据分层（与 acceptance.md 一致）：
 * - 仓储层（真 SQLite，`:memory:`）：草稿确认 / 全量编辑 / 原子追加 / 项级更新；
 * - HTTP 层（真 server + fetch）：路由语义（404 vs 400、过去只读、未来不得结束）；
 * - 容量层：读回的 minutes 快照与 `computeCapacityLedger` 一致（**证明容量真从计划派生**）。
 *
 * ⚠️ **每个测试都开一份全新的内存库**（不是共用一份）：计划是按日期唯一的，
 * 共用库会让"今天"这个日期在多个测试间互相污染 —— 那正是最难查的一类假失败。
 * 只操作内存库；不碰用户真库、不装盘、不重启。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { makeDictionaryRoute } from '../lib/api/dictionaryRoute.js'
import { makeLocalDirRoute } from '../lib/api/localDirRoute.js'
import { makeOpenFileRoute } from '../lib/api/openFileRoute.js'
import {
  addDailyPlanItem, confirmDailyPlanDraft, createDraft, createTask, deleteDailyPlan, getDailyPlan,
  localDateString, updateDailyPlan, updateDailyPlanItem, updateTask,
} from '../lib/db/repo.js'
import { computeCapacityLedger } from '../lib/shared/dailyPlanPolicy.js'

const iso = (d) => d.toISOString()
const today = () => localDateString()
const tomorrow = () => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return localDateString(d)
}
const inDays = (n) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return iso(d)
}
const dayRange = (date) => {
  const [y, m, d] = date.split('-').map(Number)
  return {
    dayStartMs: new Date(y, m - 1, d, 0, 0, 0, 0).getTime(),
    dayEndMs: new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime(),
  }
}

/**
 * 每个测试一份隔离环境：内存库 + 真 HTTP server + 便捷的 `request` / `ledger`。
 * `withEnv` 在 finally 里关服务与库（不留下句柄，也就不会出现"临时目录删不掉"）。
 */
async function withEnv(fn) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const routes = [makeDictionaryRoute(db), makeLocalDirRoute(), makeOpenFileRoute(), ...makeRoutes(db)]
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
    throw new Error('测试服务器没有拿到端口')
  }
  const port = address.port
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  const newTask = (title, extra = {}) => createTask(db, { title, typeCode: 'code_impl', priorityCode: 'p2', ...extra })
  const ledgerFor = (date) => {
    const plan = getDailyPlan(db, date)
    const rows = db.prepare('SELECT id, parent_id, title, status_code, priority_code, due_at, estimated_minutes, archived, created_at FROM tasks').all()
    return computeCapacityLedger({
      tasks: rows.map((row) => ({
        id: row.id,
        parentId: row.parent_id,
        title: row.title,
        statusCode: row.status_code,
        priorityCode: row.priority_code,
        effectiveDueAt: row.due_at,
        estimatedMinutes: row.estimated_minutes,
        archived: row.archived === 1,
        createdAt: row.created_at,
      })),
      planItems: (plan?.items ?? []).map((item) => ({ taskId: item.taskId, order: item.order, title: item.title, minutes: item.minutes, effortDone: item.effortDone })),
      planExists: plan !== undefined,
      planReadable: plan?.readable !== false,
      reason: plan?.diagnostics[0] ?? null,
      sourceCode: plan?.sourceCode ?? null,
      dailyCapacityMinutes: 390,
      defaultEstimateMinutes: 30,
      includeOverdue: true,
      ...dayRange(date),
    })
  }
  try {
    await fn({ db, request, newTask, ledgerFor })
  } finally {
    server.close()
    db.close()
  }
}

// ---------------------------------------------------------------------------
// AX-D03：minutes 快照
// ---------------------------------------------------------------------------

test('AX-D03 提案创建时快照 minutes：之后改任务估时，确认下来仍是创建那一刻的值', async () => {
  await withEnv(async ({ db, newTask }) => {
    const task = newTask('长任务·估时 600', { estimatedMinutes: 600, statusCode: 'doing', dueAt: inDays(5) })
    const date = today()
    const draft = createDraft(db, {
      kindCode: 'daily_plan',
      sessionId: 's-snap',
      payload: { planDate: date, summary: '先推进长任务', items: [{ taskId: task.id, order: 1, note: '', minutes: 600 }] },
    })
    // 提案创建**之后**用户把估时改成 120 —— 快照必须不受影响
    updateTask(db, task.id, { estimatedMinutes: 120 })
    const plan = confirmDailyPlanDraft(db, draft.id)
    assert.equal(plan.items[0].minutes, 600, '确认后仍是创建草稿时的快照')
    assert.equal(plan.items[0].effortDone, false)
  })
})

test('AX-D03 同 taskId 既有项省略 minutes 时保留既有值；API 改备注不丢 minutes 与结束状态', async () => {
  await withEnv(async ({ db, request, newTask }) => {
    const task = newTask('保留既有投入', { estimatedMinutes: 90 })
    const date = today()
    const created = updateDailyPlan(db, date, { items: [{ taskId: task.id, order: 1, note: '第一版', minutes: 90 }] })
    assert.equal(created.items[0].minutes, 90)
    updateDailyPlanItem(db, date, task.id, { effortDone: true })
    // 只改备注（省略 minutes / effortDone）→ 两样都保留
    const saved = await request('PUT', `/api/workbench/plans/${date}`, { items: [{ taskId: task.id, order: 1, note: '改了备注' }] })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.plan.items[0].note, '改了备注')
    assert.equal(saved.body.plan.items[0].minutes, 90, '旧客户端省略新字段不许抹掉 minutes')
    assert.equal(saved.body.plan.items[0].effortDone, true, '省略 effortDone 不许清掉结束状态')
  })
})

test('AX-D03 显式给 minutes 才更改；非法 minutes 整份拒绝且不部分生效', async () => {
  await withEnv(async ({ db, newTask }) => {
    const a = newTask('A')
    const b = newTask('B')
    const date = today()
    updateDailyPlan(db, date, { items: [{ taskId: a.id, order: 1, minutes: 60 }, { taskId: b.id, order: 2, minutes: 30 }] })
    const changed = updateDailyPlan(db, date, { items: [{ taskId: a.id, order: 1, minutes: 120 }, { taskId: b.id, order: 2 }] })
    assert.equal(changed.items[0].minutes, 120)
    assert.equal(changed.items[1].minutes, 30, '省略的那条保留原值')
    assert.throws(
      () => updateDailyPlan(db, date, { items: [{ taskId: a.id, order: 1, minutes: 999 }, { taskId: b.id, order: 2, minutes: 0 }] }),
      /items\[1\] 的 minutes 非法/,
    )
    assert.equal(getDailyPlan(db, date).items[0].minutes, 120, '被拒的写入不得有部分生效')
  })
})

// ---------------------------------------------------------------------------
// AX-D04：共同校验
// ---------------------------------------------------------------------------

test('AX-D04 新增未知/关闭任务、非叶子整份拒绝；既有缺失项原样保留也不妨碍追加合法项', async () => {
  await withEnv(async ({ db, newTask }) => {
    const parent = newTask('父任务')
    const child = newTask('子任务', { parentId: parent.id })
    const open = newTask('正常任务')
    const archived = newTask('已归档')
    updateTask(db, archived.id, { archived: true })
    const date = today()

    assert.throws(() => updateDailyPlan(db, date, { items: [{ taskId: 'ghost', order: 1 }] }), /不存在/)
    assert.throws(() => updateDailyPlan(db, date, { items: [{ taskId: archived.id, order: 1 }] }), /已归档/)
    // ADR0010：PUT（全量保存）**不展开** —— 非叶子直接整份拒绝，并告诉调用方改排子任务
    assert.throws(
      () => updateDailyPlan(db, date, { items: [{ taskId: parent.id, order: 1 }, { taskId: child.id, order: 2 }] }),
      /不是可执行的叶子/,
    )
    assert.equal(getDailyPlan(db, date), undefined, '被拒的写入不许留下半份计划')
    // 它下面的叶子自己可以排（这就是"改排子任务"）
    const leafOnly = updateDailyPlan(db, date, { items: [{ taskId: child.id, order: 1 }] })
    assert.equal(leafOnly.items.length, 1)
    // 兄弟叶子允许
    const siblingA = newTask('叶子A', { parentId: parent.id })
    const siblingB = newTask('叶子B', { parentId: parent.id })
    const ok = updateDailyPlan(db, date, { items: [{ taskId: siblingA.id, order: 1 }, { taskId: siblingB.id, order: 2 }] })
    assert.equal(ok.items.length, 2)

    // 手工塞一个"任务已不存在"的合法项（模拟任务被删）：读回保留、且不妨碍追加合法项
    const injected = [...ok.items, { taskId: 'deleted-task', title: '被删除的任务', note: '', minutes: 25, effortDone: false, order: 3 }]
    db.prepare('UPDATE daily_plans SET items_json = ? WHERE plan_date = ?').run(JSON.stringify(injected), date)
    const appended = addDailyPlanItem(db, date, { taskId: open.id, minutes: 45 })
    assert.equal(appended.ok, true)
    assert.equal(appended.plan.items.length, 4)
    const kept = appended.plan.items.find((item) => item.taskId === 'deleted-task')
    assert.ok(kept, '既有缺失项必须原样保留（不许为了过滤而默默移除）')
    assert.equal(kept.title, '被删除的任务')
    assert.equal(kept.minutes, 25)

    // 已在计划里的缺失项再次追加 = 幂等返回（不因"任务不存在"报错，也不改动）
    const reAdd = addDailyPlanItem(db, date, { taskId: 'deleted-task', minutes: 25 })
    assert.equal(reAdd.ok, true)
    assert.equal(reAdd.added, false)
    // 真正不存在的任务 → 拒绝新增
    const unknownAdd = addDailyPlanItem(db, date, { taskId: 'never-existed' })
    assert.equal(unknownAdd.ok, false)
    assert.match(unknownAdd.error, /不存在/)
  })
})

test('AX-D04 AI 提案里带 effortDone 由工具层直接报错（今日投入只能由用户操作）', async () => {
  await withEnv(async ({ db, newTask }) => {
    const { proposeDailyPlanTool } = await import('../lib/tools.js')
    const task = newTask('不许被 AI 结束')
    const tool = proposeDailyPlanTool(db)
    const out = await tool.execute(
      { summary: '想替用户结束', items: [{ task_id: task.id, order: 1, effortDone: true }] },
      { agent: { session: { id: 's-effort' } } },
    )
    assert.match(out, /effortDone/)
    assert.equal(getDailyPlan(db, today())?.items.some((item) => item.effortDone === true) ?? false, false)
  })
})

// ---------------------------------------------------------------------------
// AX-D05：项级 PATCH 只改当日 effortDone
// ---------------------------------------------------------------------------

test('AX-D05 今日投入结束/继续投入只改该日 effortDone：task 状态/进度/截止/估时与其他项全不变', async () => {
  await withEnv(async ({ db, newTask }) => {
    const target = newTask('今日投入目标', { statusCode: 'doing', estimatedMinutes: 600, dueAt: inDays(5), priorityCode: 'p1' })
    updateTask(db, target.id, { progressPercent: 40 })
    const other = newTask('另一条', { estimatedMinutes: 45 })
    const date = today()
    const before = updateDailyPlan(db, date, {
      items: [{ taskId: target.id, order: 1, note: '先做这条', minutes: 90 }, { taskId: other.id, order: 2, note: '顺带', minutes: 45 }],
    })
    const taskBefore = db.prepare('SELECT status_code, progress_percent, due_at, estimated_minutes, updated_at FROM tasks WHERE id = ?').get(target.id)

    const end = updateDailyPlanItem(db, date, target.id, { effortDone: true })
    assert.equal(end.ok, true)
    assert.equal(end.changed, true)
    const after = getDailyPlan(db, date)
    assert.equal(after.items[0].effortDone, true)
    assert.equal(after.items[0].minutes, 90, '结束投入不改分钟')
    assert.equal(after.items[1].effortDone, false, '其他项一点没动')
    assert.equal(after.items[1].minutes, 45)
    const taskAfter = db.prepare('SELECT status_code, progress_percent, due_at, estimated_minutes, updated_at FROM tasks WHERE id = ?').get(target.id)
    assert.deepEqual(taskAfter, taskBefore, '任务行必须逐字段不变')
    assert.equal(before.items[0].effortDone, false)

    // 相同值重复提交 → 幂等（不刷 updatedAt）
    const planUpdatedAt = getDailyPlan(db, date).updatedAt
    const again = updateDailyPlanItem(db, date, target.id, { effortDone: true })
    assert.equal(again.ok, true)
    assert.equal(again.changed, false)
    assert.equal(getDailyPlan(db, date).updatedAt, planUpdatedAt)

    // 继续投入
    const resume = updateDailyPlanItem(db, date, target.id, { effortDone: false })
    assert.equal(resume.ok, true)
    assert.equal(getDailyPlan(db, date).items[0].effortDone, false)
  })
})

test('AX-D05 只改 effortDone 时 sourceCode 保留原值；改 minutes 才变 manual', async () => {
  await withEnv(async ({ db, newTask }) => {
    const date = today()
    const a = newTask('AI 计划项')
    const aiPlan = createDraft(db, { kindCode: 'daily_plan', sessionId: 's-src', payload: { planDate: date, summary: 'AI 版', items: [{ taskId: a.id, order: 1, minutes: 45 }] } })
    confirmDailyPlanDraft(db, aiPlan.id)
    assert.equal(getDailyPlan(db, date).sourceCode, 'ai')
    updateDailyPlanItem(db, date, a.id, { effortDone: true })
    assert.equal(getDailyPlan(db, date).sourceCode, 'ai', '结束投入不把 AI 计划改成手动')
    updateDailyPlanItem(db, date, a.id, { minutes: 30 })
    assert.equal(getDailyPlan(db, date).sourceCode, 'manual', '改分钟算用户显式编辑')
  })
})

test('AX-D09 关闭/缺失的计划项：留行、拒绝再结束或调分钟；重新打开后可继续操作', async () => {
  await withEnv(async ({ db, newTask }) => {
    const task = newTask('将被完成')
    const date = today()
    updateDailyPlan(db, date, { items: [{ taskId: task.id, order: 1, minutes: 30 }] })
    updateTask(db, task.id, { statusCode: 'done' })
    const blocked = updateDailyPlanItem(db, date, task.id, { effortDone: true })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /已完成/)
    assert.equal(getDailyPlan(db, date).items.length, 1, '计划行必须留着（历史记录）')
    assert.equal(getDailyPlan(db, date).items[0].effortDone, false)

    const missing = updateDailyPlanItem(db, date, 'never-existed', { effortDone: true })
    assert.equal(missing.ok, false)
    assert.equal(missing.notFound, true)

    updateTask(db, task.id, { statusCode: 'doing' })
    const ok = updateDailyPlanItem(db, date, task.id, { effortDone: true })
    assert.equal(ok.ok, true)
  })
})

// ---------------------------------------------------------------------------
// AX-D06 / AX-C05：HTTP 语义与并发
// ---------------------------------------------------------------------------

test('AX-D06 POST 一键排入：追加到末尾、不覆盖已有成员、幂等、未知任务 404', async () => {
  await withEnv(async ({ request, newTask }) => {
    const date = tomorrow()
    const a = newTask('排入A', { estimatedMinutes: 60 })
    const b = newTask('排入B', { estimatedMinutes: 120 })
    const first = await request('POST', `/api/workbench/plans/${date}/items`, { taskId: a.id })
    assert.equal(first.status, 200)
    assert.equal(first.body.added, true)
    assert.equal(first.body.plan.items[0].minutes, 60, '省略 minutes → 取任务估时快照')
    const second = await request('POST', `/api/workbench/plans/${date}/items`, { taskId: b.id, minutes: 30 })
    assert.equal(second.status, 200)
    assert.equal(second.body.plan.items.length, 2)
    assert.equal(second.body.plan.items[1].minutes, 30, '显式 minutes 优先于估时')
    assert.equal(second.body.plan.items[0].taskId, a.id, '第一个成员一点没动')
    assert.equal(second.body.plan.items[0].minutes, 60)
    const again = await request('POST', `/api/workbench/plans/${date}/items`, { taskId: a.id, minutes: 999 })
    assert.equal(again.status, 200)
    assert.equal(again.body.added, false)
    assert.equal(again.body.plan.items.length, 2)
    assert.equal(again.body.plan.items[0].minutes, 60, '重复排入不改已有投入')
    const missing = await request('POST', `/api/workbench/plans/${date}/items`, { taskId: 'nope' })
    assert.equal(missing.status, 404)
    const badMinutes = await request('POST', `/api/workbench/plans/${date}/items`, { taskId: b.id, minutes: 0 })
    assert.equal(badMinutes.status, 400)
  })
})

test('AX-C05 并发追加两条：两次都保留（互相不覆盖）', async () => {
  await withEnv(async ({ request, newTask }) => {
    const date = tomorrow()
    const a = newTask('并发A')
    const b = newTask('并发B')
    const [ra, rb] = await Promise.all([
      request('POST', `/api/workbench/plans/${date}/items`, { taskId: a.id, minutes: 10 }),
      request('POST', `/api/workbench/plans/${date}/items`, { taskId: b.id, minutes: 20 }),
    ])
    assert.equal(ra.status, 200)
    assert.equal(rb.status, 200)
    const after = await request('GET', `/api/workbench/plans?date=${date}`)
    assert.equal(after.body.plan.items.length, 2, '并发新增两条必须都在（不能以客户端旧列表 PUT 模拟追加）')
    assert.deepEqual(after.body.plan.items.map((item) => item.taskId).sort(), [a.id, b.id].sort())
    assert.deepEqual(after.body.plan.items.map((item) => item.minutes).sort((x, y) => x - y), [10, 20])
  })
})

test('AX-D06 PATCH 项级：404 与 400 分清；未来不得结束；过去只读', async () => {
  await withEnv(async ({ request, newTask }) => {
    const date = tomorrow()
    const a = newTask('PATCH 目标')
    assert.equal((await request('PATCH', `/api/workbench/plans/${date}/items/${a.id}`, { minutes: 10 })).status, 404)
    await request('POST', `/api/workbench/plans/${date}/items`, { taskId: a.id, minutes: 30 })
    assert.equal((await request('PATCH', `/api/workbench/plans/${date}/items/ghost`, { minutes: 10 })).status, 404)
    assert.equal((await request('PATCH', `/api/workbench/plans/${date}/items/${a.id}`, {})).status, 400)
    assert.equal((await request('PATCH', `/api/workbench/plans/${date}/items/${a.id}`, { effortDone: 'true' })).status, 400)
    assert.equal((await request('PATCH', `/api/workbench/plans/${date}/items/${a.id}`, { minutes: 0 })).status, 400)
    const futureEnd = await request('PATCH', `/api/workbench/plans/${date}/items/${a.id}`, { effortDone: true })
    assert.equal(futureEnd.status, 400)
    assert.match(futureEnd.body.error, /只在当天可写/)
    const futureMinutes = await request('PATCH', `/api/workbench/plans/${date}/items/${a.id}`, { minutes: 45 })
    assert.equal(futureMinutes.status, 200)
    assert.equal(futureMinutes.body.plan.items[0].minutes, 45)
    assert.equal(futureMinutes.body.plan.items[0].effortDone, false)
    // 过去只读（服务端拦，不只靠 UI）
    assert.equal((await request('PUT', '/api/workbench/plans/2020-01-01', { items: [{ taskId: a.id, order: 1 }] })).status, 400)
    assert.equal((await request('POST', '/api/workbench/plans/2020-01-01/items', { taskId: a.id })).status, 400)
    assert.equal((await request('PATCH', `/api/workbench/plans/2020-01-01/items/${a.id}`, { minutes: 10 })).status, 400)
  })
})

// ---------------------------------------------------------------------------
// CP2：合成长任务的完整闭环 + 容量核对
// ---------------------------------------------------------------------------

test('CP2 合成长任务闭环：结束投入后仍 doing、进度原值、容量仍 90、刷新保留、明天新项 false', async () => {
  await withEnv(async ({ db, request, newTask, ledgerFor }) => {
    const long = newTask('合成：估时 600 / 未来 5 天截止', { statusCode: 'doing', estimatedMinutes: 600, dueAt: inDays(5), priorityCode: 'p1' })
    updateTask(db, long.id, { progressPercent: 40 })
    const date = today()
    const before = db.prepare('SELECT status_code, progress_percent, due_at, estimated_minutes FROM tasks WHERE id = ?').get(long.id)

    // 今天排 90 并结束投入（走 HTTP，与真机一致）
    const added = await request('POST', `/api/workbench/plans/${date}/items`, { taskId: long.id, minutes: 90 })
    assert.equal(added.status, 200)
    const ended = await request('PATCH', `/api/workbench/plans/${date}/items/${long.id}`, { effortDone: true })
    assert.equal(ended.status, 200)
    assert.equal(ended.body.plan.items[0].effortDone, true)
    assert.equal(ended.body.plan.items[0].minutes, 90)

    // "刷新"：重新 GET（服务端权威值）
    const refreshed = await request('GET', `/api/workbench/plans?date=${date}`)
    assert.equal(refreshed.body.plan.items[0].minutes, 90)
    assert.equal(refreshed.body.plan.items[0].effortDone, true)
    assert.equal(refreshed.body.plan.items[0].taskStatusCode, 'doing')

    // 任务本身一点没变（进度的原值 = 40）
    const after = db.prepare('SELECT status_code, progress_percent, due_at, estimated_minutes FROM tasks WHERE id = ?').get(long.id)
    assert.deepEqual(after, before)
    assert.equal(after.progress_percent, 40)

    // 容量仍计 90（历史投入不自动减；结束不改变已排）
    const ledgerToday = ledgerFor(date)
    assert.equal(ledgerToday.planned, 90)
    assert.equal(ledgerToday.doneMinutes, 90)
    assert.equal(ledgerToday.plannedItems[0].minutes, 90)
    assert.equal(ledgerToday.free, 300)

    // 明天同任务新项 = false、minutes 按明天的建议（不是把今天的 90 搬过去）
    const dateTomorrow = tomorrow()
    const tomorrowAdd = await request('POST', `/api/workbench/plans/${dateTomorrow}/items`, { taskId: long.id })
    assert.equal(tomorrowAdd.status, 200)
    assert.equal(tomorrowAdd.body.plan.items[0].effortDone, false)
    assert.equal(tomorrowAdd.body.plan.items[0].minutes, 600, '明天取该任务当前估时快照')
    assert.equal(ledgerFor(dateTomorrow).planned, 600, '跨日的已排各自独立')
    assert.equal(ledgerFor(date).planned, 90, '今天那份不受明天影响')
  })
})

test('CP2 删除再添加视为新项：结束状态重置为 false', async () => {
  await withEnv(async ({ db, request, newTask }) => {
    const keep = newTask('留在计划里')
    const task = newTask('删了再加')
    const date = today()
    updateDailyPlan(db, date, { items: [{ taskId: keep.id, order: 1, minutes: 15 }, { taskId: task.id, order: 2, minutes: 30 }] })
    await request('PATCH', `/api/workbench/plans/${date}/items/${task.id}`, { effortDone: true })
    assert.equal(getDailyPlan(db, date).items[1].effortDone, true)
    // 用户把它移除（全量编辑）
    updateDailyPlan(db, date, { items: [{ taskId: keep.id, order: 1, note: '', minutes: 15 }] })
    assert.equal(getDailyPlan(db, date).items.length, 1)
    const readded = await request('POST', `/api/workbench/plans/${date}/items`, { taskId: task.id, minutes: 30 })
    assert.equal(readded.status, 200)
    assert.equal(readded.body.plan.items.length, 2)
    assert.equal(readded.body.plan.items[1].effortDone, false, '删除后重新添加 = 新项，结束状态重置')
  })
})

test('重新打开已完成的任务：该日 effortDone 不被自动重置', async () => {
  await withEnv(async ({ db, request, newTask }) => {
    const task = newTask('重开任务')
    const date = today()
    await request('POST', `/api/workbench/plans/${date}/items`, { taskId: task.id, minutes: 30 })
    await request('PATCH', `/api/workbench/plans/${date}/items/${task.id}`, { effortDone: true })
    updateTask(db, task.id, { statusCode: 'done' })
    assert.equal(getDailyPlan(db, date).items[0].effortDone, true, '任务关闭不改该日投入状态')
    updateTask(db, task.id, { statusCode: 'todo' })
    assert.equal(getDailyPlan(db, date).items[0].effortDone, true, '重新打开也不自动重置')
  })
})

test('容量只能从持久化计划派生：把计划 JSON 改成坏串 → readable=false 且不给假 0', async () => {
  await withEnv(async ({ db, request, newTask, ledgerFor }) => {
    const date = today()
    const task = newTask('坏计划探针')
    await request('POST', `/api/workbench/plans/${date}/items`, { taskId: task.id, minutes: 30 })
    assert.equal(ledgerFor(date).planned, 30)
    const backup = db.prepare('SELECT items_json FROM daily_plans WHERE plan_date = ?').get(date).items_json
    db.prepare('UPDATE daily_plans SET items_json = ? WHERE plan_date = ?').run('{oops', date)
    const ledger = ledgerFor(date)
    assert.equal(ledger.readable, false)
    assert.equal(ledger.planned, 0)
    assert.match(ledger.reason ?? '', /不是合法 JSON/)
    assert.equal(db.prepare('SELECT items_json FROM daily_plans WHERE plan_date = ?').get(date).items_json, '{oops', '原串一个字节不动')
    db.prepare('UPDATE daily_plans SET items_json = ? WHERE plan_date = ?').run(backup, date)
    assert.equal(ledgerFor(date).planned, 30, '修好之后必须恢复可算')
  })
})

test('计划全量清空（DELETE）后已排归零，候选区照常可见', async () => {
  await withEnv(async ({ db, request, newTask, ledgerFor }) => {
    const date = today()
    // 用 doing 任务：无截止且 todo 的**不是候选**（需求 §5.1 的候选口径），
    // 所以这里必须挑一条真正会进候选的任务来验"清空后候选还在"。
    const task = newTask('清空前排入', { statusCode: 'doing', estimatedMinutes: 45 })
    await request('POST', `/api/workbench/plans/${date}/items`, { taskId: task.id, minutes: 45 })
    assert.equal(ledgerFor(date).planned, 45)
    assert.equal(deleteDailyPlan(db, date), true)
    const ledger = ledgerFor(date)
    assert.equal(ledger.planned, 0)
    assert.equal(ledger.unscheduledCount, 1, '无计划也要看得到候选')
    assert.equal(ledger.unscheduled[0].suggestedMinutes, 45)
    assert.equal(ledger.free, 390)
  })
})

test('无截止且不在推进的 todo 不是候选（需求 §5.1 四条候选条件的直接断言）', async () => {
  await withEnv(async ({ request, newTask, ledgerFor }) => {
    const date = today()
    const plainTodo = newTask('无截止的待办', { estimatedMinutes: 45 })
    const ledger = ledgerFor(date)
    assert.equal(ledger.unscheduledCount, 0, '无截止 + todo → 不进候选（也不许静默当成"今天该做"）')
    // 设成 doing 之后立刻可见（不靠 AI 改状态，是用户自己改的）
    const doing = newTask('改成推进中', { statusCode: 'doing', estimatedMinutes: 45 })
    const afterDoing = ledgerFor(date)
    assert.deepEqual(afterDoing.unscheduled.map((row) => row.taskId), [doing.id])
    // 显式排入那条 todo 之后它才进候选（"已在计划中"是第三条候选条件）
    await request('POST', `/api/workbench/plans/${date}/items`, { taskId: plainTodo.id, minutes: 20 })
    const afterPlan = ledgerFor(date)
    assert.ok(afterPlan.unscheduled.every((row) => row.taskId !== plainTodo.id))
    assert.equal(afterPlan.planned, 20)
  })
})
