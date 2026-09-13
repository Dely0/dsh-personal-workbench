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

/** 祖先链遍历的深度上限（防脏数据/既有环把遍历拖成无限循环）。 */
export const MAX_ANCESTOR_DEPTH = 64

/** 祖先链上的一行任务投影：只含向上遍历与「向上继承」需要的列。 */
export interface AncestorRow {
  id: string
  parentId: string | null
  dueAt: string | null
  workspacePath: string | null
  archived: number
}

/** 读取单个任务的祖先投影；任务不存在时返回 undefined。 */
function readAncestorRow(db: DatabaseSync, id: string): AncestorRow | undefined {
  const row = db.prepare('SELECT id, parent_id, due_at, workspace_path, archived FROM tasks WHERE id = ?').get(id) as
    | { id: string; parent_id: string | null; due_at: string | null; workspace_path: string | null; archived: number }
    | undefined
  if (row === undefined) return undefined
  return { id: row.id, parentId: row.parent_id, dueAt: row.due_at, workspacePath: row.workspace_path, archived: row.archived }
}

/**
 * **唯一**一份「沿 parent_id 向上走父链」的实现：有效截止继承、有效工作区继承、
 * 归档祖先判定与环检测（isDescendantOf）全部复用它，避免同一模式被复制多份。
 *
 * 防环/防深：`seen` 记住走过的节点（含 selfId），一旦重复或超过 MAX_ANCESTOR_DEPTH 立即停止，
 * 因此**既有脏数据里已经存在环时也不会死循环**；`resolve` 返回 undefined（任务已删除/取不到）
 * 时同样停止。`visit` 返回非 undefined 即短路，把该值作为结果返回。
 */
export function walkUpAncestors<T>(
  resolve: (id: string) => AncestorRow | undefined,
  selfId: string,
  startParentId: string | null,
  visit: (row: AncestorRow) => T | undefined,
): T | undefined {
  const seen = new Set<string>([selfId])
  let cursorId = startParentId
  let guard = 0
  while (cursorId !== null && guard < MAX_ANCESTOR_DEPTH) {
    if (seen.has(cursorId)) return undefined
    seen.add(cursorId)
    const row = resolve(cursorId)
    if (row === undefined) return undefined
    const hit = visit(row)
    if (hit !== undefined) return hit
    cursorId = row.parentId
    guard += 1
  }
  return undefined
}

/** 向上查找最近一个有截止时间的祖先（含自身）。带深度/防环保护。 */
export function effectiveDueAtForTask(db: DatabaseSync, task: Pick<TaskRow, 'id' | 'parentId' | 'dueAt'>): string | null {
  if (task.dueAt !== null) return task.dueAt
  return walkUpAncestors((id) => readAncestorRow(db, id), task.id, task.parentId, (row) => row.dueAt ?? undefined) ?? null
}

/**
 * 向上查找最近一个已设置工作区的祖先（含自身）。带深度/防环保护。
 * 语义与 effectiveDueAtForTask 完全同构：子任务未显式设工作区时，跟随最近的祖先；
 * 一旦子任务自己设了工作区，父任务再改动也不会影响它。
 */
export function effectiveWorkspacePathForTask(
  db: DatabaseSync,
  task: Pick<TaskRow, 'id' | 'parentId' | 'workspacePath'>,
): string | null {
  if (task.workspacePath !== null) return task.workspacePath
  return walkUpAncestors((id) => readAncestorRow(db, id), task.id, task.parentId, (row) => row.workspacePath ?? undefined) ?? null
}

/**
 * 判断 candidateId 是否在 ancestorId 的子树内（含两者相等）。带防环保护，不会因既有环而死循环。
 *
 * 用于「改父任务」前的环检测：把任务挂到自己的后代下会形成环，必须拒绝。
 * 走的是向上父链（深度上限 MAX_ANCESTOR_DEPTH），不需要向下展开整棵子树。
 */
export function isDescendantOf(db: DatabaseSync, candidateId: string, ancestorId: string): boolean {
  if (candidateId === ancestorId) return true
  const self = readAncestorRow(db, candidateId)
  if (self === undefined) return false
  return walkUpAncestors(
    (id) => readAncestorRow(db, id),
    candidateId,
    self.parentId,
    (row) => (row.id === ancestorId ? true : undefined),
  ) === true
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
  // 祖先状态优先用内存映射（避免逐层回查）；映射里没有的节点视为链断（与旧实现一致）。
  const resolveFromMap = (id: string): AncestorRow | undefined => {
    if (!parentOf.has(id)) return undefined
    return {
      id,
      parentId: parentOf.get(id) ?? null,
      dueAt: null,
      workspacePath: null,
      archived: archived.has(id) ? 1 : 0,
    }
  }
  const excluded = new Set<string>()
  for (const row of rows) {
    if (row.archived === 1) continue
    const hitArchived = walkUpAncestors(resolveFromMap, row.id, row.parent_id, (ancestor) => (ancestor.archived === 1 ? true : undefined))
    if (hitArchived === true) excluded.add(row.id)
  }
  return excluded
}
