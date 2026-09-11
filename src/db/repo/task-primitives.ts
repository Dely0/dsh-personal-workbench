/**
 * 任务原语：行类型、有效截止/工作区继承、行解析、事件写入、归档子树收集。
 *
 * 从 repo.ts 原样抽出（行为不变）。tasks / drafts / reminders 等域都依赖它们。
 * 只从 repo.ts 导入类型（编译期擦除），运行时不形成循环依赖。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, type TaskRow } from '../repo.js'

export interface RawTaskRow {
  id: string
  parent_id: string | null
  title: string
  description: string
  type_code: string
  status_code: string
  priority_code: string
  ai_policy_code: string
  due_at: string | null
  all_day: number
  estimated_minutes: number | null
  source: string
  workspace_path: string | null
  archived: number
  extra: string
  recurrence_code: string | null
  recurrence_rule: string
  recurrence_master_id: string | null
  recurrence_last_generated: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  cancelled_at: string | null
}

/** 递归向上查找最近一个有截止时间的祖先（含自身）。带深度/防环保护。 */
export function effectiveDueAtForTask(db: DatabaseSync, task: Pick<TaskRow, 'id' | 'parentId' | 'dueAt'>): string | null {
  if (task.dueAt !== null) return task.dueAt
  const seen = new Set<string>([task.id])
  let cursorId = task.parentId
  let guard = 0
  while (cursorId !== null && guard < 64) {
    if (seen.has(cursorId)) return null
    seen.add(cursorId)
    const row = db.prepare('SELECT id, parent_id, due_at FROM tasks WHERE id = ?').get(cursorId) as { id: string; parent_id: string | null; due_at: string | null } | undefined
    if (row === undefined) return null
    if (row.due_at !== null) return row.due_at
    cursorId = row.parent_id
    guard += 1
  }
  return null
}

/**
 * 递归向上查找最近一个已设置工作区的祖先（含自身）。带深度/防环保护。
 * 语义与 effectiveDueAtForTask 完全同构：子任务未显式设工作区时，跟随最近的祖先；
 * 一旦子任务自己设了工作区，父任务再改动也不会影响它。
 */
export function effectiveWorkspacePathForTask(
  db: DatabaseSync,
  task: Pick<TaskRow, 'id' | 'parentId' | 'workspacePath'>,
): string | null {
  if (task.workspacePath !== null) return task.workspacePath
  const seen = new Set<string>([task.id])
  let cursorId = task.parentId
  let guard = 0
  while (cursorId !== null && guard < 64) {
    if (seen.has(cursorId)) return null
    seen.add(cursorId)
    const row = db.prepare('SELECT id, parent_id, workspace_path FROM tasks WHERE id = ?').get(cursorId) as
      | { id: string; parent_id: string | null; workspace_path: string | null }
      | undefined
    if (row === undefined) return null
    if (row.workspace_path !== null) return row.workspace_path
    cursorId = row.parent_id
    guard += 1
  }
  return null
}

export function parseTask(row: RawTaskRow | undefined, db?: DatabaseSync): TaskRow | undefined {
  if (row === undefined) return undefined
  const task: TaskRow = {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    typeCode: row.type_code,
    statusCode: row.status_code,
    priorityCode: row.priority_code,
    aiPolicyCode: row.ai_policy_code,
    dueAt: row.due_at,
    effectiveDueAt: db === undefined ? row.due_at : effectiveDueAtForTask(db, { id: row.id, parentId: row.parent_id, dueAt: row.due_at }),
    allDay: row.all_day,
    estimatedMinutes: row.estimated_minutes,
    source: row.source,
    workspacePath: row.workspace_path,
    effectiveWorkspacePath: db === undefined
      ? row.workspace_path
      : effectiveWorkspacePathForTask(db, { id: row.id, parentId: row.parent_id, workspacePath: row.workspace_path }),
    archived: row.archived,
    extra: JSON.parse(row.extra) as Record<string, unknown>,
    recurrenceCode: row.recurrence_code,
    recurrenceRule: JSON.parse(row.recurrence_rule) as Record<string, unknown>,
    recurrenceMasterId: row.recurrence_master_id,
    recurrenceLastGenerated: row.recurrence_last_generated,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
  }
  return task
}

export function appendEvent(
  db: DatabaseSync,
  taskId: string,
  eventCode: string,
  opts: { before?: unknown; after?: unknown; actor?: string; note?: string; at?: string } = {},
): void {
  db.prepare(`
    INSERT INTO task_events (id, task_id, event_code, before_json, after_json, actor, note, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    taskId,
    eventCode,
    opts.before === undefined ? null : JSON.stringify(opts.before),
    opts.after === undefined ? null : JSON.stringify(opts.after),
    opts.actor ?? 'user',
    opts.note ?? null,
    opts.at ?? nowIso(),
  )
}

/**
 * 找出所有「祖先已归档」的任务 id（不含自身已归档的节点，那些由 archived 过滤处理）。
 * 用于让正常列表不返回无法建树的孤儿节点；带防环保护。
 */
export function collectArchivedDescendants(db: DatabaseSync, rows: RawTaskRow[]): Set<string> {
  const parentOf = new Map<string, string | null>()
  const archived = new Set<string>()
  for (const row of rows) {
    parentOf.set(row.id, row.parent_id)
    if (row.archived === 1) archived.add(row.id)
  }
  // 部分调用（parentId 过滤）只拿到一层，祖先状态需要回查一次全表。
  const missingParents = new Set<string>()
  for (const row of rows) {
    if (row.parent_id !== null && !parentOf.has(row.parent_id)) missingParents.add(row.parent_id)
  }
  for (const id of missingParents) {
    const row = db.prepare('SELECT id, parent_id, archived FROM tasks WHERE id = ?').get(id) as
      | { id: string; parent_id: string | null; archived: number }
      | undefined
    if (row === undefined) continue
    parentOf.set(row.id, row.parent_id)
    if (row.archived === 1) archived.add(row.id)
  }
  const excluded = new Set<string>()
  for (const row of rows) {
    if (row.archived === 1) continue
    const seen = new Set<string>([row.id])
    let cursorId = row.parent_id
    let guard = 0
    while (cursorId !== null && guard < 64) {
      if (seen.has(cursorId)) break
      seen.add(cursorId)
      if (archived.has(cursorId)) { excluded.add(row.id); break }
      const next = parentOf.get(cursorId)
      if (next === undefined) break
      cursorId = next
      guard += 1
    }
  }
  return excluded
}
