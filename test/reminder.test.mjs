import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import {
  addReminder, countQueue, createTask, enqueueReminder, getTask, listDueRemindersInWindow,
  listQueue, markQueueAttempt, readMeta, removeQueueEntry, writeMeta,
} from '../lib/db/repo.js'
import { normalizeReminderPolicy, readReminderPolicy, writeReminderPolicy, breakerCooldownMs, DEFAULT_REMINDER_POLICY } from '../lib/reminder/config.js'
import { checkThrottle, decideReminder, formatDigest, isQuietTime } from '../lib/reminder/policy.js'
import { normalizeErrorCode, WechatChannelAdapter } from '../lib/reminder/adapter.js'
import { ReminderScheduler } from '../lib/reminder/scheduler.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-reminder-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    return fn(db)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 假 dsh-im：可控的成功/失败与目标列表。 */
function fakeIm({ bots = [{ botId: 'wx_test', name: '微信机器人', channel: 'weixin' }], targets = [{ targetId: 'workbench', name: 'Phase 0 实测目标', kind: 'user' }], failWith = null } = {}) {
  const sent = []
  return {
    sent,
    listBots: () => bots,
    listTargets: () => targets,
    send: async (botId, targetId, text) => {
      if (failWith !== null) {
        const error = new Error(failWith)
        error.code = failWith
        throw error
      }
      sent.push({ botId, targetId, text })
      return { sent: true }
    },
  }
}

function makeAdapter(db, im) {
  return new WechatChannelAdapter({
    db,
    probe: () => im,
    readConfiguredTarget: () => ({ botId: readMeta(db, 'reminder_bot_id') ?? null, targetId: readMeta(db, 'reminder_target_id') ?? null }),
    queue: {
      enqueue: (entry, nextAttemptAt) => { enqueueReminder(db, { ...entry, nextAttemptAt }) },
      listDue: (nowIso) => listQueue(db).filter((entry) => entry.nextAttemptAt <= nowIso),
      remove: (id) => { removeQueueEntry(db, id) },
      markAttempt: (id, error, nextAttemptAt) => { markQueueAttempt(db, id, error, nextAttemptAt) },
      count: () => countQueue(db),
      statsSince: () => 0,
    },
  })
}

test('reminder policy: normalisation clamps bad input and keeps defaults', () => {
  const normalized = normalizeReminderPolicy({
    enabled: 'yes',
    immediatePriorities: ['P0', 'p0', ' p1 '],
    hourlyLimit: 999,
    dailyLimit: -5,
    digestAt: '25:00',
    quietHours: { start: '09:00', end: '09:00' },
    channel: 'nope',
  })
  assert.equal(normalized.enabled, false)                       // 非 true 一律 false
  assert.deepEqual(normalized.immediatePriorities, ['p0', 'p1']) // 小写化 + 去重
  assert.equal(normalized.hourlyLimit, 60)                       // 夹紧到上限
  assert.equal(normalized.dailyLimit, 1)                         // 夹紧到下限
  assert.equal(normalized.digestAt, DEFAULT_REMINDER_POLICY.digestAt) // 非法时间回退
  assert.equal(normalized.quietHours, null)                      // start === end 视为不启用
  assert.equal(normalized.channel, 'auto')
  assert.equal(normalizeReminderPolicy(null).catchupWindowHours, 24)
})

test('reminder policy: persists to meta and survives round-trip', () => {
  withDb((db) => {
    assert.equal(readReminderPolicy(db).enabled, false)
    writeReminderPolicy(db, { enabled: true, hourlyLimit: 3, quietHoursBypassPriorities: ['p0'] })
    const read = readReminderPolicy(db)
    assert.equal(read.enabled, true)
    assert.equal(read.hourlyLimit, 3)
    // 损坏的 JSON 回退默认值，不抛错
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('{not json', 'reminder_policy')
    assert.equal(readReminderPolicy(db).enabled, false)
  })
})

test('quiet hours: cross-midnight window and P0 bypass', () => {
  const policy = normalizeReminderPolicy({ enabled: true, quietHours: { start: '22:00', end: '08:00' } })
  assert.equal(isQuietTime(policy, new Date('2026-09-09T23:30:00')), true)
  assert.equal(isQuietTime(policy, new Date('2026-09-09T03:00:00')), true)
  assert.equal(isQuietTime(policy, new Date('2026-09-09T08:00:00')), false)
  assert.equal(isQuietTime(policy, new Date('2026-09-09T21:59:00')), false)

  const candidate = (priorityCode) => ({
    reminderId: 'r1', taskId: 't1', rootTaskId: 't1', title: '开会',
    priorityCode, dueAt: '2026-09-09T23:30:00.000Z', fireAt: '2026-09-09T23:30:00.000Z',
  })
  const nowMs = Date.parse('2026-09-09T23:31:00.000Z')
  const state = { sentLastHour: 0, sentToday: 0, circuitOpenUntil: null }
  // P0 穿透静默
  assert.deepEqual(decideReminder(policy, candidate('p0'), state, nowMs), { action: 'send', reason: 'quiet-bypass' })
  // P1 静默期不推，进队列
  assert.deepEqual(decideReminder(policy, candidate('p1'), state, nowMs), { action: 'queue', reason: 'quiet-hours' })
})

test('throttle: hourly/daily limits and breaker short-circuit', () => {
  const policy = normalizeReminderPolicy({ enabled: true, hourlyLimit: 2, dailyLimit: 3 })
  assert.equal(checkThrottle(policy, { sentLastHour: 1, sentToday: 1, circuitOpenUntil: null }, 0).allowed, true)
  assert.equal(checkThrottle(policy, { sentLastHour: 2, sentToday: 2, circuitOpenUntil: null }, 0).reason, 'hourly')
  assert.equal(checkThrottle(policy, { sentLastHour: 1, sentToday: 3, circuitOpenUntil: null }, 0).reason, 'daily')
  // 熔断优先于预算
  const verdict = checkThrottle(policy, { sentLastHour: 0, sentToday: 0, circuitOpenUntil: 5_000 }, 1_000)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reason, 'breaker')
  assert.equal(verdict.retryAfterMs, 4_000)
  // 冷却翻倍有上限
  assert.equal(breakerCooldownMs(policy, 1), policy.breakerCooldownMinutes * 60_000)
  assert.equal(breakerCooldownMs(policy, 2), policy.breakerCooldownMinutes * 2 * 60_000)
  assert.equal(breakerCooldownMs(policy, 20), 4 * 60 * 60_000)
})

test('decision: catch-up window rejects stale reminders', () => {
  const policy = normalizeReminderPolicy({ enabled: true, catchupWindowHours: 24 })
  const nowMs = Date.parse('2026-09-09T12:00:00.000Z')
  const state = { sentLastHour: 0, sentToday: 0, circuitOpenUntil: null }
  const fresh = { reminderId: 'r', taskId: 't', rootTaskId: 't', title: 'x', priorityCode: 'p1', dueAt: '2026-09-09T11:00:00.000Z', fireAt: '2026-09-09T11:00:00.000Z' }
  const stale = { ...fresh, fireAt: '2026-09-07T11:00:00.000Z' }
  assert.equal(decideReminder(policy, fresh, state, nowMs).action, 'send')
  assert.deepEqual(decideReminder(policy, stale, state, nowMs), { action: 'skip', reason: 'too-old' })
  // 未到触发时刻
  const future = { ...fresh, fireAt: '2026-09-09T13:00:00.000Z' }
  assert.deepEqual(decideReminder(policy, future, state, nowMs), { action: 'skip', reason: 'not-due' })
})

test('digest formatting caps item count', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ title: `任务${i + 1}`, dueAt: '2026-09-09T14:00:00.000Z' }))
  const text = formatDigest(entries, 3)
  assert.match(text, /1\. 任务1/)
  assert.match(text, /3\. 任务3/)
  assert.match(text, /…等 5 条/)
  assert.doesNotMatch(text, /任务4/)
})

test('adapter: degrades silently when dsh-im is not installed', async () => {
  await withDb(async (db) => {
    const adapter = makeAdapter(db, undefined)
    assert.equal(adapter.available(), false)
    assert.deepEqual(await adapter.send({ title: 'x', body: 'y' }), { ok: false, reason: 'not-installed' })
    const status = adapter.status()
    assert.equal(status.installed, false)
    assert.equal(status.configured, false)
  })
})

test('adapter: resolves target automatically and sends through dsh-im', async () => {
  await withDb(async (db) => {
    const im = fakeIm()
    const adapter = makeAdapter(db, im)
    assert.equal(adapter.available(), true)
    const target = await adapter.resolveTarget()
    assert.deepEqual(target, { botId: 'wx_test', targetId: 'workbench', botLabel: '微信机器人' })
    const outcome = await adapter.send({ title: '任务提醒：开会', body: '到期时间：今天' })
    assert.deepEqual(outcome, { ok: true, delivered: true })
    assert.equal(im.sent.length, 1)
    assert.match(im.sent[0].text, /任务提醒：开会/)
  })
})

test('adapter: installed but no target degrades to not-configured', async () => {
  await withDb(async (db) => {
    const adapter = makeAdapter(db, fakeIm({ targets: [] }))
    assert.equal(adapter.available(), true)
    assert.deepEqual(await adapter.send({ title: 'x', body: 'y' }), { ok: false, reason: 'not-configured' })
  })
})

test('adapter: delivery-failed opens the circuit and short-circuits later sends', async () => {
  await withDb(async (db) => {
    writeReminderPolicy(db, { enabled: true, breakerCooldownMinutes: 30 })
    let calls = 0
    const im = {
      listBots: () => [{ botId: 'wx_test', name: '微信机器人', channel: 'weixin' }],
      listTargets: () => [{ targetId: 'workbench', kind: 'user' }],
      send: async () => { calls += 1; const error = new Error('delivery-failed'); error.code = 'delivery-failed'; throw error },
    }
    const adapter = makeAdapter(db, im)
    const first = await adapter.send({ title: 'a', body: 'b' })
    assert.deepEqual(first, { ok: false, reason: 'failed', detail: 'delivery-failed' })
    assert.equal(calls, 1)
    // 熔断已开：第二次不再发网络请求
    const second = await adapter.send({ title: 'a', body: 'b' })
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'throttled')
    assert.equal(calls, 1)
    assert.equal(adapter.status().circuitOpen, true)
    // 恢复信号（收到用户消息）→ 熔断解除
    adapter.noteInboundCount(1)
    const recovered = adapter.noteInboundCount(2)
    assert.equal(recovered, true)
    assert.equal(adapter.status().circuitOpen, false)
  })
})

test('adapter: error codes normalise as designed', () => {
  assert.equal(normalizeErrorCode('bot-not-connected'), 'channel-offline')
  assert.equal(normalizeErrorCode('unknown-target'), 'not-configured')
  assert.equal(normalizeErrorCode('unknown-bot'), 'not-configured')
  assert.equal(normalizeErrorCode('delivery-failed'), 'failed')
  assert.equal(normalizeErrorCode(undefined), 'failed')
})

test('adapter: queue flush merges entries into one digest and clears them', async () => {
  await withDb(async (db) => {
    writeReminderPolicy(db, { enabled: true })
    const im = fakeIm()
    const adapter = makeAdapter(db, im)
    enqueueReminder(db, { reminderId: 'r1', rootTaskId: 'root', taskId: 't1', title: '任务A', body: 'b', priorityCode: 'p1', dueAt: '2026-09-09T10:00:00.000Z', nextAttemptAt: '2026-09-09T00:00:00.000Z' })
    enqueueReminder(db, { reminderId: 'r2', rootTaskId: 'root', taskId: 't2', title: '任务B', body: 'b', priorityCode: 'p1', dueAt: '2026-09-09T11:00:00.000Z', nextAttemptAt: '2026-09-09T00:00:00.000Z' })
    assert.equal(countQueue(db), 2)
    const result = await adapter.flushQueue()
    assert.deepEqual({ sent: result.sent, merged: result.merged, failed: result.failed }, { sent: 2, merged: 1, failed: 0 })
    assert.equal(im.sent.length, 1)                       // 合并成一条，不是两条
    assert.match(im.sent[0].text, /任务A/)
    assert.match(im.sent[0].text, /任务B/)
    assert.equal(countQueue(db), 0)
  })
})

test('scheduler: scan sends immediate reminders once and writes fired_at', async () => {
  await withDb(async (db) => {
    writeReminderPolicy(db, { enabled: true, quietHours: null, immediatePriorities: ['p1'] })
    const im = fakeIm()
    const adapter = makeAdapter(db, im)
    const task = createTask(db, { title: '开会', typeCode: 'code_impl', priorityCode: 'p1', dueAt: new Date(Date.now() - 60_000).toISOString() })
    addReminder(db, task.id, 0)
    const scheduler = new ReminderScheduler({ db, adapter, isTargetConfigured: () => true })
    const first = await scheduler.scan()
    assert.equal(first.sent, 1)
    assert.equal(im.sent.length, 1)
    // 幂等：再扫一次不再发
    const second = await scheduler.scan()
    assert.equal(second.scanned, 0)
    assert.equal(im.sent.length, 1)
    // fired_at 已写 → 前端 due 列表不再返回
    assert.equal(listDueRemindersInWindow(db, 24).length, 0)
  })
})

test('scheduler: channel unavailable does NOT write fired_at (frontend keeps working)', async () => {
  await withDb(async (db) => {
    writeReminderPolicy(db, { enabled: true, quietHours: null })
    const adapter = makeAdapter(db, undefined)   // 未安装 dsh-im
    const task = createTask(db, { title: '开会', typeCode: 'code_impl', priorityCode: 'p1', dueAt: new Date(Date.now() - 60_000).toISOString() })
    addReminder(db, task.id, 0)
    const scheduler = new ReminderScheduler({ db, adapter, isTargetConfigured: () => false })
    const result = await scheduler.scan()
    assert.equal(result.unavailable, 1)
    assert.equal(result.sent, 0)
    // 关键：前端仍能拿到这条提醒
    assert.equal(listDueRemindersInWindow(db, 24).length, 1)
    const row = db.prepare('SELECT fired_at FROM task_reminders WHERE task_id = ?').get(task.id)
    assert.equal(row.fired_at, null)
  })
})

test('scheduler: disabled policy is a no-op', async () => {
  await withDb((db) => {
    const im = fakeIm()
    const adapter = makeAdapter(db, im)
    const task = createTask(db, { title: '开会', typeCode: 'code_impl', priorityCode: 'p1', dueAt: new Date(Date.now() - 60_000).toISOString() })
    addReminder(db, task.id, 0)
    const scheduler = new ReminderScheduler({ db, adapter, isTargetConfigured: () => true })
    return scheduler.scan().then((result) => {
      assert.equal(result.scanned, 0)
      assert.equal(im.sent.length, 0)
      assert.equal(listDueRemindersInWindow(db, 24).length, 1)
    })
  })
})

test('scheduler: catch-up merges window reminders into one message', async () => {
  await withDb(async (db) => {
    writeReminderPolicy(db, { enabled: true, quietHours: null })
    const im = fakeIm()
    const adapter = makeAdapter(db, im)
    for (const [title, minutesAgo] of [['任务A', 30], ['任务B', 60], ['任务C', 90]]) {
      const task = createTask(db, { title, typeCode: 'code_impl', priorityCode: 'p1', dueAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
      addReminder(db, task.id, 0)
    }
    const scheduler = new ReminderScheduler({ db, adapter, isTargetConfigured: () => true })
    const result = await scheduler.catchup()
    assert.equal(result.sent, 3)
    assert.equal(im.sent.length, 1)                     // 合并成一条
    assert.match(im.sent[0].text, /错过的工作台提醒/)
    assert.match(im.sent[0].text, /任务A/)
    // 只补发一次
    assert.equal(await scheduler.catchup(), null)
  })
})

test('scheduler: too-old reminders are skipped with an event, not sent', async () => {
  await withDb(async (db) => {
    writeReminderPolicy(db, { enabled: true, quietHours: null, catchupWindowHours: 24 })
    const im = fakeIm()
    const adapter = makeAdapter(db, im)
    const task = createTask(db, { title: '很老的任务', typeCode: 'code_impl', priorityCode: 'p1', dueAt: new Date(Date.now() - 72 * 60 * 60_000).toISOString() })
    addReminder(db, task.id, 0)
    const scheduler = new ReminderScheduler({ db, adapter, isTargetConfigured: () => true })
    const result = await scheduler.scan()
    assert.equal(result.skippedTooOld, 1)
    assert.equal(im.sent.length, 0)
    const events = db.prepare("SELECT event_code FROM task_events WHERE task_id = ? AND event_code = 'reminder_skipped'").all(task.id)
    assert.equal(events.length, 1)
  })
})

test('scheduler: failed send enqueues the reminder and marks it handled', async () => {
  await withDb(async (db) => {
    writeReminderPolicy(db, { enabled: true, quietHours: null })
    const im = {
      listBots: () => [{ botId: 'wx_test', channel: 'weixin' }],
      listTargets: () => [{ targetId: 'workbench', kind: 'user' }],
      send: async () => { const error = new Error('delivery-failed'); error.code = 'delivery-failed'; throw error },
    }
    const adapter = makeAdapter(db, im)
    const task = createTask(db, { title: '开会', typeCode: 'code_impl', priorityCode: 'p1', dueAt: new Date(Date.now() - 60_000).toISOString() })
    addReminder(db, task.id, 0)
    const scheduler = new ReminderScheduler({ db, adapter, isTargetConfigured: () => true })
    const result = await scheduler.scan()
    assert.equal(result.queued, 1)
    assert.equal(countQueue(db), 1)
    // 入队即视为已处理：不会再被扫描到（避免反复撞限流）
    assert.equal(listDueRemindersInWindow(db, 24).length, 0)
    const events = db.prepare("SELECT event_code FROM task_events WHERE task_id = ? AND event_code = 'reminder_queued'").all(task.id)
    assert.equal(events.length, 1)
  })
})
