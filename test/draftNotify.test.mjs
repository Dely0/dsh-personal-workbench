/**
 * 验收「暂存」+ 草稿通知（微信）单测。
 *
 * 覆盖三条底线：
 * 1. 暂存后草稿仍是 pending（可确认/可驳回），但不再自动弹窗；
 * 2. 只有验收类草稿可暂存；
 * 3. 草稿通知只推一次、按类型开关、受静默/节流约束、通道未就绪不标记已通知。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import {
  createDraft, createTask, deferDraft, getDeferredDraftForTask, getLatestActiveDraft, getLatestPendingDraft,
  isDeferrableDraftKind, listDeferredDrafts, resumeDraft, updateDraft,
} from '../lib/db/repo.js'
import { DEFAULT_REMINDER_POLICY, normalizeReminderPolicy } from '../lib/reminder/config.js'
import {
  draftNotifyBody, draftNotifyPriority, enqueueDraftNotify, flushDraftNotifications, listDraftNotifyQueue,
  listNotifiableDrafts, markDraftNotified, nextDigestAt, nextQuietEnd, scanDraftNotifications,
} from '../lib/reminder/draft-notify.js'

async function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-draft-'))
  let db
  try {
    db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    return await fn(db)
  } finally {
    try { db?.close() } catch { /* 已关闭 */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

const AT = '2026-09-10T02:00:00.000Z'
const fixedNow = () => new Date(AT)

function completionDraft(db, taskId, summary = '做完了') {
  return createDraft(db, { kindCode: 'completion', sessionId: 's1', payload: { taskId, summary, sessionId: 's1' } })
}

function fakeAdapter({ available = true, fail = false } = {}) {
  const sent = []
  return {
    sent,
    available: () => available,
    circuitVerdict: () => ({ open: false, retryAfterMs: 0 }),
    send: async (message) => {
      sent.push(message)
      return fail ? { ok: false, reason: 'failed' } : { ok: true }
    },
  }
}

const policy = (overrides = {}) => normalizeReminderPolicy({ ...DEFAULT_REMINDER_POLICY, enabled: true, ...overrides })

function deps(db, adapter, extra = {}) {
  return {
    db,
    adapter,
    isTargetConfigured: () => true,
    throttleState: () => ({ sentLastHour: 0, sentToday: 0, circuitOpenUntil: null }),
    now: fixedNow,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// 暂存
// ---------------------------------------------------------------------------

test('暂存：completion 草稿仍是 pending，只是带上 deferredAt 与计数', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    const draft = completionDraft(db, task.id)
    const deferred = deferDraft(db, draft.id, AT)
    assert.equal(deferred.statusCode, 'pending')
    assert.equal(deferred.deferredAt, AT)
    assert.equal(deferred.deferCount, 1)
    // 二次暂存累加计数
    assert.equal(deferDraft(db, draft.id, AT).deferCount, 2)
  })
})

test('暂存：只有验收类草稿可暂存', async () => {
  await withDb(async (db) => {
    assert.equal(isDeferrableDraftKind('completion'), true)
    assert.equal(isDeferrableDraftKind('review'), true)
    assert.equal(isDeferrableDraftKind('report'), false)
    const draft = createDraft(db, { kindCode: 'report', payload: { periodCode: 'day' } })
    assert.equal(deferDraft(db, draft.id, AT), undefined)
  })
})

test('暂存：自动弹窗查询跳过暂存项，但待确认查询仍能看到', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    const draft = completionDraft(db, task.id)
    assert.equal(getLatestActiveDraft(db)?.id, draft.id)
    deferDraft(db, draft.id, AT)
    assert.equal(getLatestActiveDraft(db), undefined)
    assert.equal(getLatestPendingDraft(db)?.id, draft.id)
    assert.deepEqual(listDeferredDrafts(db).map((d) => d.id), [draft.id])
    assert.equal(getDeferredDraftForTask(db, 'completion', task.id)?.id, draft.id)
  })
})

test('暂存：唤回后重新进入自动弹窗队列', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    const draft = completionDraft(db, task.id)
    deferDraft(db, draft.id, AT)
    const resumed = resumeDraft(db, draft.id, AT)
    assert.equal(resumed.deferredAt, null)
    assert.equal(resumed.deferCount, 1, '唤回不清零历史次数')
    assert.equal(getLatestActiveDraft(db)?.id, draft.id)
    assert.equal(listDeferredDrafts(db).length, 0)
  })
})

// ---------------------------------------------------------------------------
// 草稿通知
// ---------------------------------------------------------------------------

test('通知优先级：验收/复盘 p1，其余 p2', () => {
  assert.equal(draftNotifyPriority('completion'), 'p1')
  assert.equal(draftNotifyPriority('review'), 'p1')
  assert.equal(draftNotifyPriority('report'), 'p2')
  assert.equal(draftNotifyPriority('knowledge'), 'p2')
})

test('通知正文：任务标题 + 截断摘要 + 一句操作提示（保持精简）', () => {
  const longSummary = `${'很长的一段总结'.repeat(30)}`
  const body = draftNotifyBody({ kindCode: 'completion', payload: { taskId: 't1', summary: longSummary } }, 'Skill 选择器：AI 会话前可选 Skill 列表')
  const lines = body.split('\n')
  assert.equal(lines[0], 'Skill 选择器：AI 会话前可选 Skill 列表')
  assert.equal(lines[1].endsWith('…'), true)
  assert.equal(lines[1].length <= 61, true, `摘要行应≤61 字符，实际 ${lines[1].length}`)
  assert.equal(lines[2], '打开工作台：验收通过 / 暂存（先验证）/ 驳回')
  assert.equal(body.length < 120, true, `正文应短于 120 字符，实际 ${body.length}`)
  // 不带任务标题时退回草稿自带的 title
  assert.equal(draftNotifyBody({ kindCode: 'report', payload: { title: '日报草稿', summary: '今天做了 A、B' } }).split('\n')[0], '日报草稿')
})

test('默认只开验收与复盘两类通知', () => {
  assert.deepEqual([...DEFAULT_REMINDER_POLICY.draftNotifyKinds], ['completion', 'review'])
  // 显式传空数组 = 全部关掉（不被默认值覆盖）
  assert.deepEqual(normalizeReminderPolicy({ draftNotifyKinds: [] }).draftNotifyKinds, [])
  // 非法值被过滤
  assert.deepEqual(normalizeReminderPolicy({ draftNotifyKinds: ['completion', 'bogus'] }).draftNotifyKinds, ['completion'])
})

test('待通知草稿：跳过已暂存、已通知与未开启的类型', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    const fresh = completionDraft(db, task.id)
    const deferred = completionDraft(db, task.id)
    deferDraft(db, deferred.id, AT)
    const notified = completionDraft(db, task.id)
    markDraftNotified(db, notified.id, AT)
    const report = createDraft(db, { kindCode: 'report', payload: {} })
    const ids = listNotifiableDrafts(db, ['completion', 'review']).map((d) => d.id)
    assert.deepEqual(ids, [fresh.id])
    assert.equal(listNotifiableDrafts(db, []).length, 0)
    assert.equal(listNotifiableDrafts(db, ['report']).map((d) => d.id).includes(report.id), true)
  })
})

test('扫描：即时推送并标记已通知，重复扫描不重复推送', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    completionDraft(db, task.id)
    const adapter = fakeAdapter()
    const p = policy({ quietHours: null })
    const first = await scanDraftNotifications(deps(db, adapter), p)
    assert.equal(first.sent, 1)
    assert.equal(adapter.sent[0].title.includes('完成验收申请'), true)
    assert.equal(adapter.sent[0].priorityCode, 'p1')
    const second = await scanDraftNotifications(deps(db, adapter), p)
    assert.equal(second.sent, 0)
    assert.equal(adapter.sent.length, 1)
  })
})

test('扫描：AI 更新同一草稿不重复通知', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    const draft = completionDraft(db, task.id, 'v1')
    const adapter = fakeAdapter()
    const p = policy({ quietHours: null })
    await scanDraftNotifications(deps(db, adapter), p)
    updateDraft(db, draft.id, { taskId: task.id, summary: 'v2' })
    await scanDraftNotifications(deps(db, adapter), p)
    assert.equal(adapter.sent.length, 1)
  })
})

test('扫描：通道未就绪不标记已通知（恢复后仍能补推）', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    const draft = completionDraft(db, task.id)
    const offline = fakeAdapter({ available: false })
    const p = policy({ quietHours: null })
    const result = await scanDraftNotifications(deps(db, offline), p)
    assert.equal(result.unavailable, 1)
    assert.deepEqual(listNotifiableDrafts(db, ['completion']).map((d) => d.id), [draft.id])
  })
})

test('扫描：目标缓存为空也要尝试发送（否则通知永远发不出去）', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    completionDraft(db, task.id)
    const adapter = fakeAdapter()
    // isTargetConfigured=false 模拟"适配层还没解析出目标"；仍应尝试发送并由 send() 自行解析
    const result = await scanDraftNotifications(deps(db, adapter, { isTargetConfigured: () => false }), policy({ quietHours: null }))
    assert.equal(result.sent, 1)
    assert.equal(adapter.sent.length, 1)
  })
})

test('扫描：静默时段入队并推到静默结束之后', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    completionDraft(db, task.id)
    const adapter = fakeAdapter()
    // 本地时间 2026-09-10 10:00（AT=02:00Z 在 +08 时区）→ 用全天静默强制入队
    const p = policy({ quietHours: { start: '00:00', end: '23:59' } })
    const result = await scanDraftNotifications(deps(db, adapter), p)
    assert.equal(result.queued, 1)
    assert.equal(adapter.sent.length, 0)
    const queue = listDraftNotifyQueue(db)
    assert.equal(queue.length, 1)
    assert.equal(queue[0].nextAttemptAt > AT, true)
  })
})

test('扫描：小时上限打满后转入队列', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    completionDraft(db, task.id)
    const adapter = fakeAdapter()
    const p = policy({ quietHours: null, hourlyLimit: 1 })
    const result = await scanDraftNotifications(deps(db, adapter, {
      throttleState: () => ({ sentLastHour: 1, sentToday: 1, circuitOpenUntil: null }),
    }), p)
    assert.equal(result.queued, 1)
    assert.equal(adapter.sent.length, 0)
  })
})

test('队列释放：同批多条合并成一条摘要', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    const a = completionDraft(db, task.id)
    const b = completionDraft(db, task.id)
    const past = '2026-09-10T00:00:00.000Z'
    enqueueDraftNotify(db, { draftId: a.id, kindCode: 'completion', title: '工作台 · 待你确认：完成验收申请', body: 'a', priorityCode: 'p1', nextAttemptAt: past, at: past })
    enqueueDraftNotify(db, { draftId: b.id, kindCode: 'completion', title: '工作台 · 待你确认：完成验收申请', body: 'b', priorityCode: 'p1', nextAttemptAt: past, at: past })
    const adapter = fakeAdapter()
    const result = await flushDraftNotifications(deps(db, adapter), policy({ quietHours: null }))
    assert.equal(result.sent, 1)
    assert.equal(result.merged, 2)
    assert.equal(listDraftNotifyQueue(db).length, 0)
    assert.equal(adapter.sent[0].title.includes('汇总'), true)
  })
})

test('队列释放：发送失败保留队列并退避', async () => {
  await withDb(async (db) => {
    const task = createTask(db, { title: 't', typeCode: 'code_impl', priorityCode: 'p1' })
    const draft = completionDraft(db, task.id)
    const past = '2026-09-10T00:00:00.000Z'
    enqueueDraftNotify(db, { draftId: draft.id, kindCode: 'completion', title: 'x', body: 'y', priorityCode: 'p1', nextAttemptAt: past, at: past })
    const adapter = fakeAdapter({ fail: true })
    const result = await flushDraftNotifications(deps(db, adapter), policy({ quietHours: null }))
    assert.equal(result.failed, 1)
    const queue = listDraftNotifyQueue(db)
    assert.equal(queue.length, 1)
    assert.equal(queue[0].attempts, 1)
    assert.equal(queue[0].nextAttemptAt > AT, true)
  })
})

test('静默/汇总时间计算', () => {
  const p = policy({ quietHours: { start: '22:00', end: '08:00' }, digestAt: '09:00' })
  const inQuiet = new Date('2026-09-09T15:00:00.000Z') // +08 = 23:00
  const end = nextQuietEnd(p, inQuiet)
  assert.equal(end.getHours(), 8)
  assert.equal(end.getDate() > inQuiet.getDate() || end.getMonth() > inQuiet.getMonth(), true)
  const beforeDigest = new Date('2026-09-10T00:30:00.000Z') // +08 = 08:30
  const digest = nextDigestAt(p, beforeDigest)
  assert.equal(digest.getHours(), 9)
  assert.equal(digest.getDate(), beforeDigest.getDate())
})
