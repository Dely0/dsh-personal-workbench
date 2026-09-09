/**
 * 重复任务域（V2.4：每天/每周/每月模板 → 惰性补齐实例）。
 *
 * 从 repo.ts 原样抽出（行为不变）。对外符号由 repo.ts 再导出。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, createTask, localDateString, parseTask, type RawTaskRow, type TaskRow } from '../repo.js'


export const RECURRENCE_BACKFILL_LIMIT = 100

function nextLocalDate(date: Date): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + 1)
  return next
}

function localDateFromString(value: string | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return undefined
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? undefined : date
}

function recurrenceMatches(code: string, rule: Record<string, unknown>, date: Date, anchor: Date): boolean {
  if (code === 'daily') {
    const interval = typeof rule.interval === 'number' && rule.interval >= 1 ? Math.floor(rule.interval) : 1
    const diffDays = Math.round((date.getTime() - anchor.getTime()) / 86_400_000)
    return diffDays >= 0 && diffDays % interval === 0
  }
  if (code === 'weekly') {
    const weekdays = Array.isArray(rule.weekdays) && rule.weekdays.length > 0
      ? rule.weekdays.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : [anchor.getDay()]
    return weekdays.includes(date.getDay())
  }
  if (code === 'monthly') {
    const monthDay = typeof rule.monthDay === 'number' && rule.monthDay >= 1 && rule.monthDay <= 31 ? Math.floor(rule.monthDay) : anchor.getDate()
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
    return date.getDate() === Math.min(monthDay, lastDay)
  }
  return false
}

function occurrenceDueAt(master: TaskRow, date: Date): { dueAt: string; allDay: boolean } {
  const allDay = master.allDay === 1
  let hours = allDay ? 0 : 18
  let minutes = 0
  if (master.dueAt !== null) {
    const base = new Date(master.dueAt)
    if (!Number.isNaN(base.getTime())) {
      hours = base.getHours()
      minutes = base.getMinutes()
    }
  }
  const due = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0)
  return { dueAt: due.toISOString(), allDay }
}

/** 把重复模板到期实例补齐到 today；单次最多补 RECURRENCE_BACKFILL_LIMIT 条，剩余下一请求继续。 */
export function ensureRecurringInstances(db: DatabaseSync, today = localDateString(), at = nowIso()): number {
  const todayDate = localDateFromString(today)
  if (todayDate === undefined) return 0
  const masters = (db.prepare(`
    SELECT * FROM tasks
    WHERE recurrence_code IN ('daily', 'weekly', 'monthly')
      AND archived = 0 AND status_code NOT IN ('done', 'cancelled')
  `).all() as unknown as RawTaskRow[]).map((row) => parseTask(row, db)).filter((task): task is TaskRow => task !== undefined)

  let created = 0
  db.exec('BEGIN')
  try {
    for (const master of masters) {
      const rule = master.recurrenceRule
      const startDate = localDateFromString(typeof rule.startDate === 'string' ? rule.startDate : undefined)
        ?? (master.dueAt !== null ? localDateFromString(localDateString(new Date(master.dueAt))) : undefined)
        ?? localDateFromString(localDateString(new Date(master.createdAt)))
      if (startDate === undefined) continue
      const endDateRaw = typeof rule.endDate === 'string' ? localDateFromString(rule.endDate) : undefined
      const endDate = endDateRaw !== undefined && endDateRaw < todayDate ? endDateRaw : todayDate
      let cursor = localDateFromString(master.recurrenceLastGenerated)
      cursor = cursor === undefined ? new Date(startDate) : nextLocalDate(cursor)
      let lastGenerated = cursor
      while (cursor <= endDate) {
        if (recurrenceMatches(master.recurrenceCode ?? '', rule, cursor, startDate)) {
          const { dueAt, allDay } = occurrenceDueAt(master, cursor)
          createTask(db, {
            title: master.title,
            description: master.description,
            typeCode: master.typeCode,
            priorityCode: master.priorityCode,
            aiPolicyCode: master.aiPolicyCode,
            dueAt,
            allDay,
            estimatedMinutes: master.estimatedMinutes,
            source: 'recurring',
            parentId: master.id,
            workspacePath: master.workspacePath,
            recurrenceMasterId: master.id,
            extra: { occurrenceDate: localDateString(cursor) },
          }, 'recurring', at)
          created += 1
          lastGenerated = new Date(cursor)
          if (created >= RECURRENCE_BACKFILL_LIMIT) break
        }
        cursor = nextLocalDate(cursor)
      }
      if (cursor > endDate) lastGenerated = new Date(endDate)
      const nextGenerated = lastGenerated <= endDate && lastGenerated >= startDate ? localDateString(lastGenerated) : null
      if (nextGenerated !== null && nextGenerated !== master.recurrenceLastGenerated) {
        db.prepare('UPDATE tasks SET recurrence_last_generated = ?, updated_at = ? WHERE id = ?').run(nextGenerated, at, master.id)
      }
      if (created >= RECURRENCE_BACKFILL_LIMIT) break
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return created
}
