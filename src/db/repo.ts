/**
 * 仓储层：任务 / 草稿 / 会话关联 / 提醒 / 事件。
 * 所有写操作都记 task_events；字典 code 在服务层进一步校验。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const nowIso = (): string => new Date().toISOString()

/** 服务器本地时区的 YYYY-MM-DD；每日计划按本地“天”划分。 */
export function localDateString(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export interface DictionaryEntry {
  kind: string
  code: string
  name: string
  config: Record<string, unknown>
  builtin: number
  active: number
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface TaskInput {
  title: string
  description?: string
  typeCode: string
  statusCode?: string
  priorityCode: string
  aiPolicyCode?: string
  dueAt?: string | null
  allDay?: boolean
  estimatedMinutes?: number | null
  source?: string
  parentId?: string | null
  workspacePath?: string | null
  extra?: Record<string, unknown>
  children?: Array<Partial<TaskInput>>
  recurrenceCode?: string | null
  recurrenceRule?: Record<string, unknown>
  recurrenceMasterId?: string | null
}

export interface TaskPatch {
  title?: string
  description?: string
  typeCode?: string
  statusCode?: string
  priorityCode?: string
  aiPolicyCode?: string
  dueAt?: string | null
  allDay?: boolean
  estimatedMinutes?: number | null
  archived?: boolean
  workspacePath?: string | null
  extra?: Record<string, unknown>
  recurrenceCode?: string | null
  recurrenceRule?: Record<string, unknown>
}

export interface TaskRow {
  id: string
  parentId: string | null
  title: string
  description: string
  typeCode: string
  statusCode: string
  priorityCode: string
  aiPolicyCode: string
  dueAt: string | null
  /** 动态有效截止时间：优先自身 dueAt，未设置时向上继承最近一个有截止时间的祖先。 */
  effectiveDueAt: string | null
  allDay: number
  estimatedMinutes: number | null
  source: string
  workspacePath: string | null
  /** 动态有效工作区：优先自身 workspacePath，未设置时向上继承最近一个已设工作区的祖先。 */
  effectiveWorkspacePath: string | null
  archived: number
  extra: Record<string, unknown>
  recurrenceCode: string | null
  recurrenceRule: Record<string, unknown>
  recurrenceMasterId: string | null
  recurrenceLastGenerated: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  cancelledAt: string | null
}

export interface DraftInput {
  kindCode?: 'task' | 'subtask_plan' | string
  sessionId?: string | null
  payload: Record<string, unknown>
}

export interface TaskSessionLinkInput {
  taskId: string
  sessionId: string
  roleCode: string
  workspace?: string
  note?: string
}

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
function effectiveDueAtForTask(db: DatabaseSync, task: Pick<TaskRow, 'id' | 'parentId' | 'dueAt'>): string | null {
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
function effectiveWorkspacePathForTask(
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

// 字典域已抽到 repo/dictionaries.ts
import { listDictionaries, getDictionary, dictionaryUsageCount } from './repo/dictionaries.js'
export {
  listDictionaries, getDictionary, createDictionaryEntry, updateDictionaryEntry, deleteDictionaryEntry, dictionaryUsageCount,
} from './repo/dictionaries.js'

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

export function createTask(db: DatabaseSync, input: TaskInput, actor = 'user', at = nowIso()): TaskRow {
  const id = randomUUID()
  const task: TaskRow = {
    id,
    parentId: input.parentId ?? null,
    title: input.title,
    description: input.description ?? '',
    typeCode: input.typeCode,
    statusCode: input.statusCode ?? 'todo',
    priorityCode: input.priorityCode,
    aiPolicyCode: input.aiPolicyCode ?? 'consult',
    dueAt: input.dueAt ?? null,
    effectiveDueAt: null,
    allDay: input.allDay ? 1 : 0,
    estimatedMinutes: input.estimatedMinutes ?? null,
    source: input.source ?? 'manual',
    workspacePath: input.workspacePath ?? null,
    effectiveWorkspacePath: null,
    archived: 0,
    extra: input.extra ?? {},
    recurrenceCode: input.recurrenceCode === undefined || input.recurrenceCode === 'none' ? null : input.recurrenceCode,
    recurrenceRule: input.recurrenceRule ?? {},
    recurrenceMasterId: input.recurrenceMasterId ?? null,
    recurrenceLastGenerated: null,
    createdAt: at,
    updatedAt: at,
    completedAt: input.statusCode === 'done' ? at : null,
    cancelledAt: input.statusCode === 'cancelled' ? at : null,
  }
  task.effectiveDueAt = effectiveDueAtForTask(db, task)
  task.effectiveWorkspacePath = effectiveWorkspacePathForTask(db, task)
  db.prepare(`
    INSERT INTO tasks
      (id, parent_id, title, description, type_code, status_code, priority_code,
       ai_policy_code, due_at, all_day, estimated_minutes, source, workspace_path, archived, extra,
       recurrence_code, recurrence_rule, recurrence_master_id, recurrence_last_generated,
       created_at, updated_at, completed_at, cancelled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id, task.parentId, task.title, task.description, task.typeCode,
    task.statusCode, task.priorityCode, task.aiPolicyCode, task.dueAt, task.allDay,
    task.estimatedMinutes, task.source, task.workspacePath, JSON.stringify(task.extra),
    task.recurrenceCode, JSON.stringify(task.recurrenceRule), task.recurrenceMasterId, task.recurrenceLastGenerated,
    task.createdAt, task.updatedAt, task.completedAt, task.cancelledAt,
  )
  appendEvent(db, id, 'created', { after: task, actor, at })
  return task
}

export function getTask(db: DatabaseSync, id: string): TaskRow | undefined {
  return parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as RawTaskRow | undefined, db)
}

export function listTasks(db: DatabaseSync, opts: { includeArchived?: boolean; parentId?: string | null } = {}): TaskRow[] {
  const includeArchived = opts.includeArchived ?? false
  const parentId = opts.parentId
  const all = (parentId === undefined
    ? db.prepare('SELECT * FROM tasks').all()
    : db.prepare('SELECT * FROM tasks WHERE parent_id IS ?').all(parentId)) as unknown as RawTaskRow[]
  // 正常视图必须排除「祖先已归档」的节点：否则归档父任务后，未归档的子任务会变成
  // 前端无法建树的孤儿节点（父不在返回集），只能平铺到根下，看起来像重复任务。
  // 归档视图（includeArchived）不走这条过滤，它由 listArchivedTasks 自己带出整棵子树。
  const excluded = includeArchived ? new Set<string>() : collectArchivedDescendants(db, all)
  const priorityWeights = new Map(listDictionaries(db, 'priority').map((entry) => [entry.code, Number(entry.config.weight ?? 99)]))
  return all
    .filter((row) => (includeArchived || row.archived === 0) && !excluded.has(row.id))
    .map((row) => parseTask(row, db))
    .filter((task): task is TaskRow => task !== undefined)
    .sort((a, b) => {
      const rank = (task: TaskRow): number => {
        if (task.statusCode === 'done' || task.statusCode === 'cancelled') return 4
        return priorityWeights.get(task.priorityCode) ?? 99
      }
      const rankDiff = rank(a) - rank(b)
      if (rankDiff !== 0) return rankDiff
      if (a.effectiveDueAt === null && b.effectiveDueAt === null) return a.createdAt.localeCompare(b.createdAt)
      if (a.effectiveDueAt === null) return 1
      if (b.effectiveDueAt === null) return -1
      return a.effectiveDueAt.localeCompare(b.effectiveDueAt)
    })
}

export function listChildren(db: DatabaseSync, parentId: string): TaskRow[] {
  return listTasks(db, { parentId })
}

/**
 * 找出所有「祖先已归档」的任务 id（不含自身已归档的节点，那些由 archived 过滤处理）。
 * 用于让正常列表不返回无法建树的孤儿节点；带防环保护。
 */
function collectArchivedDescendants(db: DatabaseSync, rows: RawTaskRow[]): Set<string> {
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

export function updateTask(db: DatabaseSync, id: string, patch: TaskPatch, actor = 'user', at = nowIso()): TaskRow | undefined {
  const before = getTask(db, id)
  if (before === undefined) return undefined
  const next: TaskRow = {
    ...before,
    title: patch.title ?? before.title,
    description: patch.description ?? before.description,
    typeCode: patch.typeCode ?? before.typeCode,
    statusCode: patch.statusCode ?? before.statusCode,
    priorityCode: patch.priorityCode ?? before.priorityCode,
    aiPolicyCode: patch.aiPolicyCode ?? before.aiPolicyCode,
    dueAt: patch.dueAt === undefined ? before.dueAt : patch.dueAt,
    allDay: patch.allDay === undefined ? before.allDay : patch.allDay ? 1 : 0,
    estimatedMinutes: patch.estimatedMinutes === undefined ? before.estimatedMinutes : patch.estimatedMinutes,
    archived: patch.archived === undefined ? before.archived : patch.archived ? 1 : 0,
    workspacePath: patch.workspacePath === undefined ? before.workspacePath : patch.workspacePath,
    extra: patch.extra === undefined ? before.extra : patch.extra,
    recurrenceCode: patch.recurrenceCode === undefined ? before.recurrenceCode : patch.recurrenceCode === 'none' ? null : patch.recurrenceCode,
    recurrenceRule: patch.recurrenceRule === undefined ? before.recurrenceRule : patch.recurrenceRule,
    updatedAt: at,
    completedAt: patch.statusCode === 'done' ? at : patch.statusCode !== undefined ? null : before.completedAt,
    cancelledAt: patch.statusCode === 'cancelled' ? at : patch.statusCode !== undefined ? null : before.cancelledAt,
  }
  next.effectiveDueAt = effectiveDueAtForTask(db, next)
  next.effectiveWorkspacePath = effectiveWorkspacePathForTask(db, next)
  db.prepare(`
    UPDATE tasks SET
      title = ?, description = ?, type_code = ?, status_code = ?, priority_code = ?,
      ai_policy_code = ?, due_at = ?, all_day = ?, estimated_minutes = ?, archived = ?,
      workspace_path = ?, extra = ?, recurrence_code = ?, recurrence_rule = ?,
      updated_at = ?, completed_at = ?, cancelled_at = ?
    WHERE id = ?
  `).run(
    next.title, next.description, next.typeCode, next.statusCode, next.priorityCode,
    next.aiPolicyCode, next.dueAt, next.allDay, next.estimatedMinutes, next.archived,
    next.workspacePath, JSON.stringify(next.extra), next.recurrenceCode, JSON.stringify(next.recurrenceRule),
    next.updatedAt, next.completedAt, next.cancelledAt, id,
  )
  appendEvent(db, id, 'updated', { before, after: next, actor, at })
  return next
}

// ---------------------------------------------------------------------------
// status aggregation / cascade completion
// ---------------------------------------------------------------------------

function isClosedStatus(statusCode: string): boolean {
  return statusCode === 'done' || statusCode === 'cancelled'
}

function allDirectChildrenClosed(db: DatabaseSync, parentId: string): boolean {
  const children = listChildren(db, parentId)
  return children.length > 0 && children.every((child) => isClosedStatus(child.statusCode))
}

/** 事务内执行级联/聚合；调用方必须已开启事务。 */
function completeTaskCascadeInTx(db: DatabaseSync, taskId: string, actor: string, at: string): void {
  const markDone = (id: string): void => {
    const current = getTask(db, id)
    if (current === undefined || isClosedStatus(current.statusCode)) return
    updateTask(db, id, { statusCode: 'done' }, actor, at)
  }
  markDone(taskId)

  // 父任务直接完成时级联完成后代；叶子任务无子节点时此循环为空。
  const stack = [...listChildren(db, taskId)]
  while (stack.length > 0) {
    const child = stack.pop()!
    markDone(child.id)
    stack.push(...listChildren(db, child.id))
  }

  // 向上聚合：只要父节点的直接子节点全部 closed，就自动完成父节点。
  let cursor = getTask(db, taskId)?.parentId ?? null
  let guard = 0
  while (cursor !== null && guard < 64) {
    const parent = getTask(db, cursor)
    if (parent === undefined) break
    if (isClosedStatus(parent.statusCode)) {
      // 已关闭的父节点不再向上传播；但如果它仍有未完成后代（旧数据），仍先补齐后代。
      const stack2 = [...listChildren(db, parent.id)]
      while (stack2.length > 0) {
        const child = stack2.pop()!
        markDone(child.id)
        stack2.push(...listChildren(db, child.id))
      }
      break
    }
    if (allDirectChildrenClosed(db, parent.id)) {
      updateTask(db, parent.id, { statusCode: 'done' }, actor, at)
      cursor = parent.parentId ?? null
    } else {
      break
    }
    guard += 1
  }
}

/**
 * 完成任务并处理级联/聚合：
 * - 把 taskId 标记为 done；
 * - 若 taskId 是父任务（直接完成），级联把所有未完成后代标记为 done；
 * - 完成后向上递归检查：某个父节点的直接子节点全部 closed 时，自动把该父节点标记为 done。
 * 使用事务保证幂等与并发安全；重复调用不会重复写已完成任务。
 */
export function completeTaskCascade(db: DatabaseSync, taskId: string, actor = 'user', at = nowIso()): TaskRow | undefined {
  const task = getTask(db, taskId)
  if (task === undefined) return undefined
  db.exec('BEGIN IMMEDIATE')
  try {
    completeTaskCascadeInTx(db, taskId, actor, at)
    db.exec('COMMIT')
    return getTask(db, taskId)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 原子地应用任务更新；若 patch 把任务标记为 done，则在同一事务内级联/聚合。
 * 避免“任务已 done 但后代未级联”的中间状态。
 */
export function updateTaskWithCompletion(
  db: DatabaseSync,
  id: string,
  patch: TaskPatch,
  actor = 'user',
  at = nowIso(),
): TaskRow | undefined {
  const before = getTask(db, id)
  if (before === undefined) return undefined
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = updateTask(db, id, patch, actor, at)
    if (task !== undefined && patch.statusCode === 'done') {
      completeTaskCascadeInTx(db, id, actor, at)
    }
    db.exec('COMMIT')
    return getTask(db, id)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 存量数据修复：扫描所有“有子任务但未完成”的父节点，若其直接子节点已全部 closed，
 * 则递归补完成。幂等：第二次执行返回 0。
 */
export function repairParentCompletion(db: DatabaseSync, at = nowIso()): number {
  const before = new Map(
    listTasks(db, { includeArchived: true })
      .filter((task) => !isClosedStatus(task.statusCode))
      .map((task) => [task.id, task.statusCode] as const),
  )
  const parents = listTasks(db, { includeArchived: true }).filter((task) => listChildren(db, task.id).length > 0)
  for (const parent of parents) {
    const current = getTask(db, parent.id)
    if (current === undefined || isClosedStatus(current.statusCode)) continue
    if (allDirectChildrenClosed(db, parent.id)) {
      completeTaskCascade(db, parent.id, 'system', at)
    }
  }
  let changed = 0
  for (const [id, status] of before) {
    const current = getTask(db, id)
    if (current !== undefined && current.statusCode !== status) changed += 1
  }
  return changed
}

/**
 * 归档一个任务。
 * 默认只归档该节点本身（保持既有语义）；`cascade: true` 时在同一事务内连整棵子树一起归档，
 * 每个被归档的节点各写一条 updated 事件，便于审计与按事件回放恢复。
 */
export function archiveTask(
  db: DatabaseSync,
  id: string,
  actor = 'user',
  opts: { cascade?: boolean } = {},
): TaskRow | undefined {
  if (opts.cascade !== true) return updateTask(db, id, { archived: true }, actor)
  const root = getTask(db, id)
  if (root === undefined) return undefined
  const subtree: string[] = []
  const stack = [id]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    subtree.push(current)
    for (const child of listTasks(db, { parentId: current, includeArchived: true })) stack.push(child.id)
  }
  db.exec('BEGIN')
  try {
    let updated: TaskRow | undefined
    for (const taskId of subtree) {
      const row = updateTask(db, taskId, { archived: true }, actor)
      if (taskId === id) updated = row
    }
    db.exec('COMMIT')
    return updated
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function restoreTask(db: DatabaseSync, id: string, actor = 'user'): TaskRow | undefined {
  return updateTask(db, id, { archived: false }, actor)
}

export function listArchivedTasks(db: DatabaseSync): TaskRow[] {
  const all = listTasks(db, { includeArchived: true })
  const archivedIds = all.filter((task) => task.archived === 1).map((task) => task.id)
  if (archivedIds.length === 0) return []
  const byParent = new Map<string | null, TaskRow[]>()
  for (const task of all) {
    const list = byParent.get(task.parentId) ?? []
    list.push(task)
    byParent.set(task.parentId, list)
  }
  const included = new Set<string>(archivedIds)
  const stack = [...archivedIds]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const child of byParent.get(id) ?? []) {
      if (included.has(child.id)) continue
      included.add(child.id)
      stack.push(child.id)
    }
  }
  return all.filter((task) => included.has(task.id))
}

export function listTaskEvents(db: DatabaseSync, taskId: string): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY at DESC, id DESC').all(taskId) as unknown as Array<Record<string, unknown>>
}

export interface TaskReviewInput {
  taskId: string
  sessionId?: string | null
  summaryMd: string
  lessonsJson?: unknown
}

export function createTaskReview(db: DatabaseSync, input: TaskReviewInput, at = nowIso()): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO task_reviews (id, task_id, session_id, summary_md, lessons_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.taskId, input.sessionId ?? null, input.summaryMd, JSON.stringify(input.lessonsJson ?? []), at)
  appendEvent(db, input.taskId, 'review_created', { actor: 'ai', note: `review:${id}`, at })
  return id
}

export function listTaskReviews(db: DatabaseSync, taskId: string): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM task_reviews WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as unknown as Array<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// drafts
// ---------------------------------------------------------------------------

export interface DraftRow {
  id: string
  kindCode: string
  sessionId: string | null
  payload: Record<string, unknown>
  statusCode: string
  createdAt: string
  updatedAt: string
}

interface RawDraftRow {
  id: string
  kind_code: string
  session_id: string | null
  payload_json: string
  status_code: string
  created_at: string
  updated_at: string
}

/** 提案类草稿里的单个任务节点：工具侧写 snake_case，表单/任务草稿侧写 camelCase。 */
export type DraftTaskItem = Partial<TaskInput> & Record<string, unknown>

/**
 * 把草稿里的一个任务节点归一化成 createTask 入参。
 * 三条确认路径（task / subtask_plan / idea_tasks）共用，避免各自只处理一种写法而静默丢字段
 * （历史事故：estimated_minutes 只读 camelCase，而提案工具写的是 snake_case）。
 */
export function toTaskInputFromDraftItem(
  item: DraftTaskItem,
  defaults: { typeCode: string; priorityCode: string; statusCode?: string; source?: string; extra?: Record<string, unknown> },
): { title: string; input: TaskInput } | undefined {
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  if (title === '') return undefined
  const estimate = item.estimatedMinutes ?? item.estimated_minutes
  const allDay = item.allDay ?? item.all_day
  return {
    title,
    input: {
      title,
      description: typeof item.description === 'string' ? item.description : undefined,
      typeCode: String(item.typeCode ?? item.type_code ?? defaults.typeCode),
      priorityCode: String(item.priorityCode ?? item.priority_code ?? defaults.priorityCode),
      statusCode: typeof item.statusCode === 'string' ? item.statusCode : typeof item.status_code === 'string' ? item.status_code : defaults.statusCode,
      dueAt: typeof item.dueAt === 'string' ? item.dueAt : typeof item.due_at === 'string' ? item.due_at : null,
      allDay: allDay === true,
      estimatedMinutes: typeof estimate === 'number' ? estimate : undefined,
      aiPolicyCode: typeof item.aiPolicyCode === 'string' ? item.aiPolicyCode : undefined,
      source: defaults.source,
      workspacePath: typeof item.workspacePath === 'string' && item.workspacePath !== '' ? item.workspacePath : undefined,
      extra: (item.extra as Record<string, unknown> | undefined) ?? defaults.extra,
    },
  }
}

/**
 * 幂等建节点：同 parent 下已有同名（trim 后精确相等）任务时复用它，不新建。
 * 重复确认同一份拆解提案曾导致整棵任务树第二次落地（见 docs/issues/2026-09-09-*）。
 */
function findSiblingByTitle(db: DatabaseSync, parentId: string | null, title: string): TaskRow | undefined {
  const normalized = title.trim()
  return listTasks(db, { parentId, includeArchived: true }).find((task) => task.title.trim() === normalized)
}

function parseDraft(row: RawDraftRow | undefined): DraftRow | undefined {
  if (row === undefined) return undefined
  return {
    id: row.id,
    kindCode: row.kind_code,
    sessionId: row.session_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    statusCode: row.status_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createDraft(db: DatabaseSync, input: DraftInput, at = nowIso()): DraftRow {
  const id = randomUUID()
  const row: DraftRow = {
    id,
    kindCode: input.kindCode ?? 'task',
    sessionId: input.sessionId ?? null,
    payload: input.payload,
    statusCode: 'pending',
    createdAt: at,
    updatedAt: at,
  }
  db.prepare(`
    INSERT INTO task_drafts (id, kind_code, session_id, payload_json, status_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(row.id, row.kindCode, row.sessionId, JSON.stringify(row.payload), row.createdAt, row.updatedAt)
  return row
}

export function getDraft(db: DatabaseSync, id: string): DraftRow | undefined {
  return parseDraft(db.prepare('SELECT * FROM task_drafts WHERE id = ?').get(id) as RawDraftRow | undefined)
}

export function updateDraft(db: DatabaseSync, id: string, payload: Record<string, unknown>, at = nowIso()): DraftRow | undefined {
  const draft = getDraft(db, id)
  if (draft === undefined || draft.statusCode !== 'pending') return undefined
  db.prepare('UPDATE task_drafts SET payload_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(payload), at, id)
  return getDraft(db, id)
}

export function getDraftBySession(db: DatabaseSync, sessionId: string): DraftRow | undefined {
  return parseDraft(db.prepare('SELECT * FROM task_drafts WHERE session_id = ? AND status_code = \'pending\' ORDER BY created_at DESC LIMIT 1').get(sessionId) as RawDraftRow | undefined)
}

export function setDraftStatus(db: DatabaseSync, id: string, statusCode: string, at = nowIso()): void {
  db.prepare('UPDATE task_drafts SET status_code = ?, updated_at = ? WHERE id = ?').run(statusCode, at, id)
}

// withDraftConfirm 已抽到 repo/shared.ts；此处再导出保持对外 API 不变
import { withDraftConfirm } from './repo/shared.js'
export { withDraftConfirm } from './repo/shared.js'


export function confirmTaskDraft(db: DatabaseSync, draftId: string, actor = 'user', at = nowIso()): TaskRow | undefined {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'task') return undefined
  const payload = draft.payload as Partial<TaskInput> & { reminderOffsetMinutes?: number; reminder_offset_minutes?: number; subtasks?: Array<Partial<TaskInput> & Record<string, unknown>> }
  const title = typeof payload.title === 'string' ? payload.title : ''
  if (title.trim() === '') throw new Error('draft payload requires a non-empty title')
  return withDraftConfirm(db, draftId, 'task', () => {
    const task = createTask(db, {
      title,
      description: typeof payload.description === 'string' ? payload.description : undefined,
      typeCode: String(payload.typeCode ?? ''),
      statusCode: typeof payload.statusCode === 'string' ? payload.statusCode : undefined,
      priorityCode: String(payload.priorityCode ?? 'p2'),
      aiPolicyCode: typeof payload.aiPolicyCode === 'string' ? payload.aiPolicyCode : undefined,
      dueAt: typeof payload.dueAt === 'string' ? payload.dueAt : null,
      allDay: payload.allDay === true,
      estimatedMinutes: typeof payload.estimatedMinutes === 'number' ? payload.estimatedMinutes : null,
      source: typeof payload.source === 'string' ? payload.source : 'nl',
      parentId: typeof payload.parentId === 'string' ? payload.parentId : null,
      workspacePath: typeof payload.workspacePath === 'string' && payload.workspacePath !== '' ? payload.workspacePath : null,
      extra: payload.extra ?? {},
    }, actor, at)
    const explicitOffset = typeof payload.reminderOffsetMinutes === 'number'
      ? payload.reminderOffsetMinutes
      : typeof payload.reminder_offset_minutes === 'number' ? payload.reminder_offset_minutes : undefined
    const typeDefault = getDictionary(db, 'type', task.typeCode)?.config.defaultReminderMinutes
    const priorityDefault = getDictionary(db, 'priority', task.priorityCode)?.config.defaultReminderMinutes
    const reminderOffset = explicitOffset ?? (typeof typeDefault === 'number' ? typeDefault : typeof priorityDefault === 'number' ? priorityDefault : undefined)
    if (task.dueAt !== null && typeof reminderOffset === 'number' && Number.isFinite(reminderOffset) && reminderOffset >= 0) {
      addReminder(db, task.id, reminderOffset, 'browser', at)
    }
    // workbench_submit_task 的 subtasks 参数：确认任务时同步创建简版子任务。
    const rawChildren = Array.isArray(payload.subtasks) ? payload.subtasks as DraftTaskItem[] : []
    const walkChildren = (items: DraftTaskItem[], parentId: string): void => {
      for (const item of items) {
        const normalized = toTaskInputFromDraftItem(item, { typeCode: task.typeCode, priorityCode: task.priorityCode, statusCode: 'todo', source: 'nl' })
        if (normalized === undefined) continue
        const { input } = normalized
        if (getDictionary(db, 'type', input.typeCode)?.active !== 1) continue
        if (getDictionary(db, 'priority', input.priorityCode)?.active !== 1) continue
        const child = createTask(db, { ...input, parentId }, actor, at)
        if (Array.isArray(item.children)) walkChildren(item.children as DraftTaskItem[], child.id)
      }
    }
    walkChildren(rawChildren, task.id)
    if (draft.sessionId !== null && draft.sessionId !== undefined) {
      linkTaskSession(db, { taskId: task.id, sessionId: draft.sessionId, roleCode: 'clarify' }, at)
    }
    return task
  }, { at })
}

export function confirmSubtaskPlanDraft(db: DatabaseSync, draftId: string, actor = 'user', at = nowIso()): TaskRow[] {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'subtask_plan') return []
  const payload = draft.payload as { parentTaskId?: string; subtasks?: DraftTaskItem[] }
  const parentTaskId = typeof payload.parentTaskId === 'string' ? payload.parentTaskId : undefined
  if (parentTaskId === undefined) throw new Error('subtask_plan requires parentTaskId')
  const parent = getTask(db, parentTaskId)
  if (parent === undefined) throw new Error(`parent task ${parentTaskId} not found`)
  if (parent.archived === 1 || parent.statusCode === 'done' || parent.statusCode === 'cancelled') {
    throw new Error(`parent task「${parent.title}」is archived or closed`)
  }
  const subtasks = Array.isArray(payload.subtasks) ? payload.subtasks : []
  return withDraftConfirm(db, draftId, 'subtask_plan', (): TaskRow[] => {
    const created: TaskRow[] = []
    const walk = (items: DraftTaskItem[], parentId: string | null): void => {
      for (const item of items) {
        const normalized = toTaskInputFromDraftItem(item, { typeCode: parent.typeCode, priorityCode: parent.priorityCode, source: parent.source })
        if (normalized === undefined) continue
        const { title, input } = normalized
        if (getDictionary(db, 'type', input.typeCode)?.active !== 1) continue
        if (getDictionary(db, 'priority', input.priorityCode)?.active !== 1) continue
        // 幂等：同父下已有同名节点就复用，不重复建树（重确认同一份提案时保持任务 id/状态/用户编辑不变）。
        const existing = findSiblingByTitle(db, parentId, title)
        const task = existing ?? createTask(db, { ...input, parentId }, actor, at)
        created.push(task)
        if (Array.isArray(item.children)) walk(item.children as DraftTaskItem[], task.id)
      }
    }
    walk(subtasks, parentTaskId)
    if (draft.sessionId !== null && draft.sessionId !== undefined) {
      for (const task of created) {
        linkTaskSession(db, { taskId: task.id, sessionId: draft.sessionId, roleCode: 'breakdown' }, at)
      }
    }
    return created
  }, { at, emptyValue: [] })
}

export function getLatestPendingDraft(db: DatabaseSync): DraftRow | undefined {
  return parseDraft(db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' ORDER BY created_at DESC LIMIT 1").get() as RawDraftRow | undefined)
}

export function getPendingDraftForTask(db: DatabaseSync, kindCode: string, taskId: string): DraftRow | undefined {
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND kind_code = ? ORDER BY created_at DESC").all(kindCode) as unknown as RawDraftRow[]
  for (const row of rows) {
    const draft = parseDraft(row)
    if (draft !== undefined && draft.payload.taskId === taskId) return draft
  }
  return undefined
}

export function abandonDraft(db: DatabaseSync, draftId: string, at = nowIso()): void {
  setDraftStatus(db, draftId, 'abandoned', at)
}

// ---------------------------------------------------------------------------
// task sessions
// ---------------------------------------------------------------------------

export function linkTaskSession(db: DatabaseSync, input: TaskSessionLinkInput, at = nowIso()): void {
  db.prepare(`
    INSERT INTO task_sessions (task_id, session_id, role_code, workspace, note, created_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, session_id, role_code) DO UPDATE SET last_activity_at = excluded.last_activity_at
  `).run(input.taskId, input.sessionId, input.roleCode, input.workspace ?? null, input.note ?? null, at, at)
  appendEvent(db, input.taskId, 'session_linked', { actor: 'system', note: `${input.roleCode}:${input.sessionId}`, at })
}

export function listTaskSessions(db: DatabaseSync, taskId: string): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM task_sessions WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<Record<string, unknown>>
}

// 任务共享记忆已抽到 repo/task-memory.ts
export { getTaskRootId, getTaskMemory, listTaskMemories, addTaskMemory, getTaskMemoryContext } from './repo/task-memory.js'
export type { TaskMemoryRow } from './repo/task-memory.js'

// ---------------------------------------------------------------------------
// reminders
// ---------------------------------------------------------------------------

export interface DueReminder {
  reminderId: string
  taskId: string
  title: string
  dueAt: string
  offsetMinutes: number
  methodCode: string
}

export function listDueReminders(db: DatabaseSync, now = new Date()): DueReminder[] {
  const rows = db.prepare(`
    SELECT r.id AS reminder_id, r.task_id, r.offset_minutes, r.method_code,
           t.title, t.due_at, t.parent_id
    FROM task_reminders r
    JOIN tasks t ON t.id = r.task_id
    WHERE r.enabled = 1 AND r.fired_at IS NULL
      AND t.archived = 0
      AND t.status_code NOT IN ('done', 'cancelled')
  `).all() as Array<{
    reminder_id: string
    task_id: string
    offset_minutes: number
    method_code: string
    title: string
    due_at: string | null
    parent_id: string | null
  }>
  const nowMs = now.getTime()
  const candidates = rows
    .map((row) => {
      const effectiveDueAt = effectiveDueAtForTask(db, { id: row.task_id, parentId: row.parent_id, dueAt: row.due_at })
      return { ...row, effectiveDueAt }
    })
    .filter((row): row is {
      reminder_id: string
      task_id: string
      offset_minutes: number
      method_code: string
      title: string
      due_at: string | null
      parent_id: string | null
      effectiveDueAt: string
    } => row.effectiveDueAt !== null)
  return candidates
    .filter((row) => {
      const dueMs = Date.parse(row.effectiveDueAt)
      if (!Number.isFinite(dueMs)) return false
      return nowMs >= dueMs - row.offset_minutes * 60_000
    })
    .map((row) => ({
      reminderId: row.reminder_id,
      taskId: row.task_id,
      title: row.title,
      dueAt: row.effectiveDueAt,
      offsetMinutes: row.offset_minutes,
      methodCode: row.method_code,
    }))
}

export interface TaskReminderRow {
  id: string
  taskId: string
  offsetMinutes: number
  methodCode: string
  enabled: number
  firedAt: string | null
  createdAt: string
}

export function listReminders(db: DatabaseSync, taskId: string): TaskReminderRow[] {
  const rows = db.prepare('SELECT * FROM task_reminders WHERE task_id = ? ORDER BY created_at').all(taskId) as unknown as Array<{
    id: string
    task_id: string
    offset_minutes: number
    method_code: string
    enabled: number
    fired_at: string | null
    created_at: string
  }>
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    offsetMinutes: row.offset_minutes,
    methodCode: row.method_code,
    enabled: row.enabled,
    firedAt: row.fired_at,
    createdAt: row.created_at,
  }))
}

export function fireReminder(db: DatabaseSync, reminderId: string, at = nowIso()): void {
  db.prepare('UPDATE task_reminders SET fired_at = ? WHERE id = ?').run(at, reminderId)
}

export function addReminder(
  db: DatabaseSync,
  taskId: string,
  offsetMinutes: number,
  methodCode = 'browser',
  at = nowIso(),
): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO task_reminders (id, task_id, offset_minutes, method_code, enabled, fired_at, created_at)
    VALUES (?, ?, ?, ?, 1, NULL, ?)
  `).run(id, taskId, offsetMinutes, methodCode, at)
  return id
}

// ---------------------------------------------------------------------------
// meta（键值设置：默认工作区、提醒策略等）
// ---------------------------------------------------------------------------

export function readMeta(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

export function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// 提醒队列已抽到 repo/reminder-queue.ts
export {
  REMINDER_QUEUE_LIMIT, enqueueReminder, listDueQueue, listQueue, countQueue, removeQueueEntry, markQueueAttempt, countFiredRemindersSince, listDueRemindersInWindow, getTaskRootIdOrSelf,
} from './repo/reminder-queue.js'
export type { ReminderQueueRow, ReminderQueueInput } from './repo/reminder-queue.js'

// 每日计划域已抽到 repo/plans.ts
export {
  getDailyPlan, saveDailyPlan, updateDailyPlan, deleteDailyPlan, confirmDailyPlanDraft, getPendingDailyPlanDraft,
} from './repo/plans.js'
export type { DailyPlanItem, DailyPlanRow } from './repo/plans.js'

// 日报 / 周报域已抽到 repo/reports.ts
export {
  saveTaskReport, getTaskReport, listTaskReports, deleteTaskReport, confirmReportDraft, getPendingReportDraft,
} from './repo/reports.js'
export type { ReportPeriodCode, TaskReportInput, TaskReportRow } from './repo/reports.js'

// AI 会话注册表已抽到 repo/ai-sessions.ts
export { getAiSession, registerAiSession } from './repo/ai-sessions.js'
export type { AiSessionRegistryRow } from './repo/ai-sessions.js'

// 重复任务域已抽到 repo/recurring.ts
export { ensureRecurringInstances, RECURRENCE_BACKFILL_LIMIT } from './repo/recurring.js'

// 知识库域已抽到 repo/knowledge.ts；此处再导出保持对外 API 不变
export {
  normalizeFileLink, assertValidFileLink, createKnowledge, getKnowledge, listKnowledge,
  updateKnowledge, deleteKnowledge, confirmKnowledgeDraft, getPendingKnowledgeDraft,
} from './repo/knowledge.js'
export type { KnowledgeInput, KnowledgeRow } from './repo/knowledge.js'

// 点子 / 点子王域已抽到 repo/ideas.ts；此处再导出保持对外 API 不变
export {
  createIdea, getIdea, listIdeas, updateIdea, deleteIdea,
  createIdeaCluster, getIdeaCluster, listIdeaClusters, deleteIdeaCluster, listIdeaClustersForIdea,
  confirmIdeaClusterDraft, confirmIdeaTaskDraft, getPendingDraftForSession,
} from './repo/ideas.js'
export type { IdeaInput, IdeaRow, IdeaClusterInput, IdeaClusterRow } from './repo/ideas.js'
