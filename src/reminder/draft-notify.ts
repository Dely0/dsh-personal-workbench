/**
 * 草稿通知 → 微信通道。
 *
 * 与任务到期提醒共用同一条管道（dsh-im 软探测 → 队列 → 调度器 → 策略节流/静默/汇总），
 * 只是"通知源"换成工作台草稿：AI 提交的验收申请、报告草稿、知识草稿、点子提案等。
 *
 * 关键语义：
 * - **只推一次**：`task_drafts.notified_at` 非空即视为已进过队列，AI 反复更新同一草稿不重复打扰。
 * - **类型开关**：`policy.draftNotifyKinds` 决定哪些草稿类型推送，默认只开验收/复盘。
 * - **不穿透静默**：草稿通知最高 p1，按策略走静默时段入队、次日汇总，不做 P0 穿透。
 * - 通道未就绪（未装/未配 dsh-im）：**不标记 notified_at**，等通道可用后再推。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from '../db/repo.js'
import type { ReminderPolicy } from './config.js'
import { decideReminder, formatDigest, type ReminderCandidate, type ThrottleState } from './policy.js'
import type { SendOutcome, WechatChannelAdapter } from './adapter.js'

export interface DraftNotifyEntry {
  id: string
  draftId: string
  kindCode: string
  title: string
  body: string
  priorityCode: string
  attempts: number
  nextAttemptAt: string
  lastError: string | null
  createdAt: string
}

interface RawDraftNotifyRow {
  id: string
  draft_id: string
  kind_code: string
  title: string
  body: string
  priority_code: string
  attempts: number
  next_attempt_at: string
  last_error: string | null
  created_at: string
}

const parseEntry = (row: RawDraftNotifyRow): DraftNotifyEntry => ({
  id: row.id,
  draftId: row.draft_id,
  kindCode: row.kind_code,
  title: row.title,
  body: row.body,
  priorityCode: row.priority_code,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  lastError: row.last_error,
  createdAt: row.created_at,
})

/** 草稿类型 → 通知优先级。验收/复盘需要用户立刻动手 → p1（即时）；其余 → p2（进汇总）。 */
export function draftNotifyPriority(kindCode: string): string {
  return kindCode === 'completion' || kindCode === 'review' ? 'p1' : 'p2'
}

const KIND_LABELS: Record<string, string> = {
  completion: '完成验收申请',
  review: '复盘草稿',
  report: '日报/周报草稿',
  knowledge: '知识条目草稿',
  idea_cluster: '点子王提案',
  idea_tasks: '点子落地任务提案',
  subtask_plan: '子任务提案',
  task: '任务草稿',
}

export function draftNotifyTitle(kindCode: string): string {
  return `工作台 · 待你确认：${KIND_LABELS[kindCode] ?? kindCode}`
}

/** 通知正文里的摘要截断长度（微信上太长反而看不清）。 */
export const DRAFT_NOTIFY_SUMMARY_LIMIT = 60

/**
 * 通知正文：任务标题 + 极短摘要 + 一句操作提示。
 *
 * 刻意保持精简：微信里一眼能看完、一眼知道该干什么。任务标题优先用调用方查到的
 * 真实任务标题（验收申请草稿只存 taskId），查不到才退回草稿自带的 title 字段。
 */
export function draftNotifyBody(draft: { kindCode: string; payload: Record<string, unknown> }, taskTitle?: string | null): string {
  const payload = draft.payload
  const lines: string[] = []
  const heading = typeof taskTitle === 'string' && taskTitle.trim() !== ''
    ? taskTitle.trim()
    : (typeof payload.title === 'string' ? payload.title.trim() : '')
  if (heading !== '') lines.push(heading)
  const rawSummary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
  if (rawSummary !== '') {
    const firstLine = rawSummary.split('\n')[0].trim()
    lines.push(firstLine.length > DRAFT_NOTIFY_SUMMARY_LIMIT ? `${firstLine.slice(0, DRAFT_NOTIFY_SUMMARY_LIMIT)}…` : firstLine)
  }
  lines.push('打开工作台：验收通过 / 暂存（先验证）/ 驳回')
  return lines.join('\n')
}

/** 找出「待确认、未暂存、未通知过、类型已开启」的草稿。 */
export function listNotifiableDrafts(db: DatabaseSync, kinds: readonly string[]): Array<{ id: string; kindCode: string; payload: Record<string, unknown>; sessionId: string | null }> {
  if (kinds.length === 0) return []
  const placeholders = kinds.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT id, kind_code, payload_json, session_id FROM task_drafts
    WHERE status_code = 'pending' AND deferred_at IS NULL AND notified_at IS NULL AND kind_code IN (${placeholders})
    ORDER BY created_at
  `).all(...kinds) as unknown as Array<{ id: string; kind_code: string; payload_json: string; session_id: string | null }>
  return rows.map((row) => ({ id: row.id, kindCode: row.kind_code, payload: JSON.parse(row.payload_json) as Record<string, unknown>, sessionId: row.session_id }))
}

/** 草稿关联的任务标题（验收申请草稿只存 taskId，通知里带上标题才有信息量）。 */
function taskTitleOf(db: DatabaseSync, draft: { payload: Record<string, unknown> }): string | null {
  const taskId = typeof draft.payload.taskId === 'string' ? draft.payload.taskId : ''
  if (taskId === '') return null
  const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title: string } | undefined
  return row?.title ?? null
}

export function markDraftNotified(db: DatabaseSync, draftId: string, at = nowIso()): void {
  db.prepare('UPDATE task_drafts SET notified_at = ? WHERE id = ?').run(at, draftId)
}

export function enqueueDraftNotify(db: DatabaseSync, input: { draftId: string; kindCode: string; title: string; body: string; priorityCode: string; nextAttemptAt: string; at?: string }): DraftNotifyEntry {
  const at = input.at ?? nowIso()
  db.prepare(`
    INSERT INTO draft_notify_queue (id, draft_id, kind_code, title, body, priority_code, attempts, next_attempt_at, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)
    ON CONFLICT(draft_id) DO NOTHING
  `).run(randomUUID(), input.draftId, input.kindCode, input.title, input.body, input.priorityCode, input.nextAttemptAt, at)
  const row = db.prepare('SELECT * FROM draft_notify_queue WHERE draft_id = ?').get(input.draftId) as unknown as RawDraftNotifyRow
  return parseEntry(row)
}

export function listDraftNotifyQueue(db: DatabaseSync): DraftNotifyEntry[] {
  const rows = db.prepare('SELECT * FROM draft_notify_queue ORDER BY created_at').all() as unknown as RawDraftNotifyRow[]
  return rows.map(parseEntry)
}

export function listDueDraftNotifies(db: DatabaseSync, nowIso_: string): DraftNotifyEntry[] {
  const rows = db.prepare('SELECT * FROM draft_notify_queue WHERE next_attempt_at <= ? ORDER BY created_at').all(nowIso_) as unknown as RawDraftNotifyRow[]
  return rows.map(parseEntry)
}

export function removeDraftNotify(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM draft_notify_queue WHERE id = ?').run(id)
}

export function markDraftNotifyAttempt(db: DatabaseSync, id: string, error: string | null, nextAttemptAt: string): void {
  db.prepare('UPDATE draft_notify_queue SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?').run(error, nextAttemptAt, id)
}

export function countDraftNotifiesSince(db: DatabaseSync, sinceIso: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM task_drafts WHERE notified_at IS NOT NULL AND notified_at >= ?").get(sinceIso) as { n: number } | undefined
  return row?.n ?? 0
}

export interface DraftNotifyDeps {
  db: DatabaseSync
  adapter: WechatChannelAdapter
  isTargetConfigured: () => boolean
  throttleState: (policy: ReminderPolicy, now: Date) => ThrottleState
  now?: () => Date
}

export interface DraftNotifyResult {
  scanned: number
  sent: number
  queued: number
  skipped: number
  unavailable: number
}

/** 扫描一次：把新草稿按策略即时推送或入队。 */
export async function scanDraftNotifications(deps: DraftNotifyDeps, policy: ReminderPolicy): Promise<DraftNotifyResult> {
  const result: DraftNotifyResult = { scanned: 0, sent: 0, queued: 0, skipped: 0, unavailable: 0 }
  if (!policy.enabled || policy.channel === 'browser') return result
  const drafts = listNotifiableDrafts(deps.db, policy.draftNotifyKinds)
  result.scanned = drafts.length
  if (drafts.length === 0) return result

  const now = deps.now?.() ?? new Date()
  // 只用"通道是否装了"做前置门；**不用** isTargetConfigured()——那个读的是适配层的
  // 目标缓存，进程刚起来时缓存为空会让通知永远发不出去（适配层其实会在 send() 时
  // 按需解析目标）。真发不出去时 send() 会失败，下面照常入队退避，不会丢。
  if (!deps.adapter.available()) {
    // 未装 dsh-im：保持"未通知"，前端照旧；装上后自然补推。
    result.unavailable = drafts.length
    return result
  }

  const state = deps.throttleState(policy, now)
  const nowMs = now.getTime()
  for (const draft of drafts) {
    const priorityCode = draftNotifyPriority(draft.kindCode)
    const candidate: ReminderCandidate = {
      reminderId: `draft:${draft.id}`,
      taskId: typeof draft.payload.taskId === 'string' ? draft.payload.taskId : '',
      rootTaskId: '',
      title: draftNotifyTitle(draft.kindCode),
      priorityCode,
      dueAt: now.toISOString(),
      fireAt: now.toISOString(),
    }
    const decision = decideReminder(policy, candidate, state, nowMs)
    const title = draftNotifyTitle(draft.kindCode)
    const body = draftNotifyBody(draft, taskTitleOf(deps.db, draft))
    if (decision.action === 'send') {
      const outcome = await deps.adapter.send({ title, body, priorityCode })
      if (outcome.ok) {
        markDraftNotified(deps.db, draft.id, now.toISOString())
        result.sent += 1
      } else {
        enqueueDraftNotify(deps.db, { draftId: draft.id, kindCode: draft.kindCode, title, body, priorityCode, nextAttemptAt: new Date(nowMs + 15 * 60_000).toISOString(), at: now.toISOString() })
        result.queued += 1
      }
      continue
    }
    if (decision.action === 'queue') {
      // 静默/汇总/节流：算出下次可投递时间后入队（静默期到结束时刻，汇总到当天汇总时刻）
      const retryAt = decision.reason === 'quiet-hours'
        ? nextQuietEnd(policy, now)
        : decision.reason === 'digest'
          ? nextDigestAt(policy, now)
          : new Date(nowMs + 15 * 60_000)
      enqueueDraftNotify(deps.db, { draftId: draft.id, kindCode: draft.kindCode, title, body, priorityCode, nextAttemptAt: retryAt.toISOString(), at: now.toISOString() })
      markDraftNotified(deps.db, draft.id, now.toISOString())
      result.queued += 1
      continue
    }
    result.skipped += 1
  }
  return result
}

/** 释放草稿通知队列：到期条目逐条发送，同批同优先级合并成一条摘要。 */
export async function flushDraftNotifications(deps: DraftNotifyDeps, policy: ReminderPolicy): Promise<{ sent: number; merged: number; failed: number }> {
  const result = { sent: 0, merged: 0, failed: 0 }
  if (!policy.enabled || policy.channel === 'browser') return result
  if (!deps.adapter.available()) return result
  const now = deps.now?.() ?? new Date()
  const due = listDueDraftNotifies(deps.db, now.toISOString())
  if (due.length === 0) return result

  const state = deps.throttleState(policy, now)
  const nowMs = now.getTime()
  // 逐条按策略判定：仍处于静默/汇总窗口的推后，可发的收集起来
  const sendable: DraftNotifyEntry[] = []
  for (const entry of due) {
    const candidate: ReminderCandidate = {
      reminderId: `draft:${entry.draftId}`,
      taskId: '',
      rootTaskId: '',
      title: entry.title,
      priorityCode: entry.priorityCode,
      dueAt: entry.createdAt,
      fireAt: entry.createdAt,
    }
    const decision = decideReminder(policy, candidate, state, nowMs)
    if (decision.action === 'send') { sendable.push(entry); continue }
    if (decision.action === 'queue') {
      const retryAt = decision.reason === 'quiet-hours'
        ? nextQuietEnd(policy, now)
        : decision.reason === 'digest'
          ? nextDigestAt(policy, now)
          : new Date(nowMs + 15 * 60_000)
      markDraftNotifyAttempt(deps.db, entry.id, decision.reason, retryAt.toISOString())
      continue
    }
    removeDraftNotify(deps.db, entry.id)
  }
  if (sendable.length === 0) return result

  if (sendable.length === 1) {
    const entry = sendable[0]
    const outcome: SendOutcome = await deps.adapter.send({ title: entry.title, body: entry.body, priorityCode: entry.priorityCode })
    if (outcome.ok) { removeDraftNotify(deps.db, entry.id); result.sent += 1 } else {
      markDraftNotifyAttempt(deps.db, entry.id, outcome.reason, new Date(nowMs + 15 * 60_000).toISOString())
      result.failed += 1
    }
    return result
  }

  const body = formatDigest(sendable.map((entry) => ({ title: entry.title, dueAt: entry.createdAt })), policy.catchupMaxItems)
  const outcome = await deps.adapter.send({ title: '工作台 · 待你确认（汇总）', body, priorityCode: 'p2' })
  if (outcome.ok) {
    for (const entry of sendable) removeDraftNotify(deps.db, entry.id)
    result.sent += 1
    result.merged = sendable.length
  } else {
    for (const entry of sendable) markDraftNotifyAttempt(deps.db, entry.id, outcome.reason, new Date(nowMs + 15 * 60_000).toISOString())
    result.failed += sendable.length
  }
  return result
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((part) => Number(part))
  return h * 60 + m
}

/** 静默时段结束时刻（跨午夜时若当前在静默内，结束时刻在次日）。 */
export function nextQuietEnd(policy: ReminderPolicy, now: Date): Date {
  const next = new Date(now)
  if (policy.quietHours === null) return next
  const start = minutesOfDay(policy.quietHours.start)
  const end = minutesOfDay(policy.quietHours.end)
  const current = now.getHours() * 60 + now.getMinutes()
  const crossing = start >= end
  const inQuiet = crossing ? (current >= start || current < end) : (current >= start && current < end)
  if (!inQuiet) return next
  next.setHours(0, 0, 0, 0)
  next.setMinutes(end)
  if (crossing && current >= start) next.setDate(next.getDate() + 1)
  return next
}

/** 当天/次日汇总时刻。 */
export function nextDigestAt(policy: ReminderPolicy, now: Date): Date {
  const next = new Date(now)
  next.setHours(0, 0, 0, 0)
  next.setMinutes(minutesOfDay(policy.digestAt))
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}
