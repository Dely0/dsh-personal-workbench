/**
 * 提醒待发队列（微信提醒把"暂时发不出去"的提醒落库，重启不丢）。
 *
 * 从 repo.ts 原样抽出（行为不变）。对外符号由 repo.ts 再导出。
 * 设计见 docs/design/2026-09-09-reminder-channel-adapter.md §6。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, listDueReminders, type DueReminder } from '../repo.js'


export interface ReminderQueueRow {
  id: string
  reminderId: string | null
  rootTaskId: string
  taskId: string
  title: string
  body: string
  priorityCode: string
  dueAt: string | null
  attempts: number
  nextAttemptAt: string
  lastError: string | null
  createdAt: string
}

/** 队列硬上限：防止极端情况下无限增长（超出丢弃最旧的）。 */
export const REMINDER_QUEUE_LIMIT = 200

export interface ReminderQueueInput {
  reminderId: string | null
  rootTaskId: string
  taskId: string
  title: string
  body: string
  priorityCode: string
  dueAt: string | null
  nextAttemptAt: string
}

export function enqueueReminder(db: DatabaseSync, input: ReminderQueueInput, at = nowIso()): string {
  const id = randomUUID()
  db.exec('BEGIN')
  try {
    db.prepare(`
      INSERT INTO reminder_queue
        (id, reminder_id, root_task_id, task_id, title, body, priority_code, due_at, attempts, next_attempt_at, last_error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)
    `).run(id, input.reminderId, input.rootTaskId, input.taskId, input.title, input.body, input.priorityCode, input.dueAt, input.nextAttemptAt, at)
    const excess = db.prepare('SELECT COUNT(*) AS c FROM reminder_queue').get() as { c: number }
    if (excess.c > REMINDER_QUEUE_LIMIT) {
      const drop = excess.c - REMINDER_QUEUE_LIMIT
      db.prepare(`
        DELETE FROM reminder_queue WHERE id IN (
          SELECT id FROM reminder_queue ORDER BY created_at ASC LIMIT ?
        )
      `).run(drop)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return id
}

/** 取到期的队列条目（按优先级与创建时间）。 */
export function listDueQueue(db: DatabaseSync, nowIso: string, limit = 50): ReminderQueueRow[] {
  const rows = db.prepare(`
    SELECT * FROM reminder_queue
    WHERE next_attempt_at <= ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(nowIso, limit) as unknown as Array<Record<string, unknown>>
  return rows.map(parseQueueRow)
}

export function listQueue(db: DatabaseSync, limit = 100): ReminderQueueRow[] {
  const rows = db.prepare('SELECT * FROM reminder_queue ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as Array<Record<string, unknown>>
  return rows.map(parseQueueRow)
}

export function countQueue(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM reminder_queue').get() as { c: number }).c
}

export function removeQueueEntry(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM reminder_queue WHERE id = ?').run(id)
}

export function markQueueAttempt(db: DatabaseSync, id: string, error: string, nextAttemptAt: string): void {
  db.prepare('UPDATE reminder_queue SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?').run(error, nextAttemptAt, id)
}

function parseQueueRow(row: Record<string, unknown>): ReminderQueueRow {
  return {
    id: String(row.id),
    reminderId: row.reminder_id === null || row.reminder_id === undefined ? null : String(row.reminder_id),
    rootTaskId: String(row.root_task_id),
    taskId: String(row.task_id),
    title: String(row.title),
    body: String(row.body),
    priorityCode: String(row.priority_code),
    dueAt: row.due_at === null || row.due_at === undefined ? null : String(row.due_at),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: String(row.next_attempt_at),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt: String(row.created_at),
  }
}

/** 统计窗口内"已发送/已尝试"的条数（用于节流预算）。 */
export function countFiredRemindersSince(db: DatabaseSync, sinceIso: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM task_reminders WHERE fired_at IS NOT NULL AND fired_at >= ?').get(sinceIso) as { c: number }).c
}

/**
 * 到期提醒（带补发回溯窗口）。
 * 与 listDueReminders 的区别：只返回窗口内到期的，避免逾期很久的提醒被反复取到。
 */
export function listDueRemindersInWindow(db: DatabaseSync, windowHours: number, now = new Date()): DueReminder[] {
  const windowMs = windowHours * 60 * 60_000
  return listDueReminders(db, now).filter((reminder) => {
    const fireMs = Date.parse(reminder.dueAt) - reminder.offsetMinutes * 60_000
    return Number.isFinite(fireMs) && now.getTime() - fireMs <= windowMs
  })
}

/** 取任务树的根 id（用于任务共享记忆与队列归属）。 */
export function getTaskRootIdOrSelf(db: DatabaseSync, taskId: string): string {
  let cursor: string | null = taskId
  const seen = new Set<string>()
  let guard = 0
  while (cursor !== null && guard < 64) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const row = db.prepare('SELECT id, parent_id FROM tasks WHERE id = ?').get(cursor) as { id: string; parent_id: string | null } | undefined
    if (row === undefined) return taskId
    if (row.parent_id === null) return row.id
    cursor = row.parent_id
    guard += 1
  }
  return taskId
}
