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

interface RawTaskRow {
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

function parseTask(row: RawTaskRow | undefined, db?: DatabaseSync): TaskRow | undefined {
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

// ---------------------------------------------------------------------------
// dictionaries
// ---------------------------------------------------------------------------

export function listDictionaries(db: DatabaseSync, kind?: string): DictionaryEntry[] {
  const rows = (kind === undefined
    ? db.prepare('SELECT * FROM dictionaries ORDER BY kind, sort_order, code').all()
    : db.prepare('SELECT * FROM dictionaries WHERE kind = ? ORDER BY sort_order, code').all(kind)) as unknown as Array<{
      kind: string
      code: string
      name: string
      config: string
      builtin: number
      active: number
      sort_order: number
      created_at: string
      updated_at: string
    }>
  return rows.map((row) => ({
    kind: row.kind,
    code: row.code,
    name: row.name,
    config: JSON.parse(row.config) as Record<string, unknown>,
    builtin: row.builtin,
    active: row.active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export function getDictionary(db: DatabaseSync, kind: string, code: string): DictionaryEntry | undefined {
  return listDictionaries(db, kind).find((entry) => entry.code === code)
}

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
  const priorityWeights = new Map(listDictionaries(db, 'priority').map((entry) => [entry.code, Number(entry.config.weight ?? 99)]))
  return all
    .filter((row) => includeArchived || row.archived === 0)
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

export function archiveTask(db: DatabaseSync, id: string, actor = 'user'): TaskRow | undefined {
  return updateTask(db, id, { archived: true }, actor)
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

function setDraftStatus(db: DatabaseSync, id: string, statusCode: string, at = nowIso()): void {
  db.prepare('UPDATE task_drafts SET status_code = ?, updated_at = ? WHERE id = ?').run(statusCode, at, id)
}

export function confirmTaskDraft(db: DatabaseSync, draftId: string, actor = 'user', at = nowIso()): TaskRow | undefined {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'task') return undefined
  const payload = draft.payload as Partial<TaskInput> & { reminderOffsetMinutes?: number; reminder_offset_minutes?: number; subtasks?: Array<Partial<TaskInput> & Record<string, unknown>> }
  const title = typeof payload.title === 'string' ? payload.title : ''
  if (title.trim() === '') throw new Error('draft payload requires a non-empty title')
  db.exec('BEGIN')
  try {
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
    const rawChildren = Array.isArray(payload.subtasks) ? payload.subtasks as Array<Partial<TaskInput> & Record<string, unknown>> : []
    const walkChildren = (items: Array<Partial<TaskInput> & Record<string, unknown>>, parentId: string): void => {
      for (const item of items) {
        const childTitle = typeof item.title === 'string' ? item.title : ''
        if (childTitle.trim() === '') continue
        const typeCode = String(item.typeCode ?? item.type_code ?? task.typeCode)
        const priorityCode = String(item.priorityCode ?? item.priority_code ?? task.priorityCode)
        if (getDictionary(db, 'type', typeCode)?.active !== 1) continue
        if (getDictionary(db, 'priority', priorityCode)?.active !== 1) continue
        const child = createTask(db, {
          title: childTitle,
          description: typeof item.description === 'string' ? item.description : undefined,
          typeCode,
          priorityCode,
          statusCode: 'todo',
          dueAt: typeof item.dueAt === 'string' ? item.dueAt : typeof item.due_at === 'string' ? item.due_at : null,
          estimatedMinutes: typeof item.estimated_minutes === 'number' ? item.estimated_minutes : undefined,
          source: 'nl',
          parentId,
        }, actor, at)
        if (Array.isArray(item.children)) walkChildren(item.children as Array<Partial<TaskInput> & Record<string, unknown>>, child.id)
      }
    }
    walkChildren(rawChildren, task.id)
    if (draft.sessionId !== null && draft.sessionId !== undefined) {
      linkTaskSession(db, { taskId: task.id, sessionId: draft.sessionId, roleCode: 'clarify' }, at)
    }
    setDraftStatus(db, draftId, 'confirmed', at)
    db.exec('COMMIT')
    return task
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function confirmSubtaskPlanDraft(db: DatabaseSync, draftId: string, actor = 'user', at = nowIso()): TaskRow[] {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'subtask_plan') return []
  const payload = draft.payload as { parentTaskId?: string; subtasks?: Array<Partial<TaskInput>> }
  const parentTaskId = typeof payload.parentTaskId === 'string' ? payload.parentTaskId : undefined
  if (parentTaskId === undefined) throw new Error('subtask_plan requires parentTaskId')
  const parent = getTask(db, parentTaskId)
  if (parent === undefined) throw new Error(`parent task ${parentTaskId} not found`)
  if (parent.archived === 1 || parent.statusCode === 'done' || parent.statusCode === 'cancelled') {
    throw new Error(`parent task「${parent.title}」is archived or closed`)
  }
  const subtasks = Array.isArray(payload.subtasks) ? payload.subtasks : []
  db.exec('BEGIN')
  try {
    const created: TaskRow[] = []
    const walk = (items: Array<Partial<TaskInput> & Record<string, unknown>>, parentId: string | null): void => {
      for (const item of items) {
        const title = typeof item.title === 'string' ? item.title : ''
        if (title.trim() === '') continue
        // 提案工具写入的是 snake_case（type_code），表单/任务草稿写入的是 camelCase，这里两者都收。
        const typeCode = String(item.typeCode ?? item.type_code ?? parent.typeCode)
        const priorityCode = String(item.priorityCode ?? item.priority_code ?? parent.priorityCode)
        if (getDictionary(db, 'type', typeCode)?.active !== 1) continue
        if (getDictionary(db, 'priority', priorityCode)?.active !== 1) continue
        const dueAt = typeof item.dueAt === 'string' ? item.dueAt : typeof item.due_at === 'string' ? item.due_at : null
        const task = createTask(db, {
          title,
          description: typeof item.description === 'string' ? item.description : undefined,
          typeCode,
          priorityCode,
          dueAt,
          parentId,
          extra: item.extra ?? {},
        }, actor, at)
        created.push(task)
        if (Array.isArray(item.children)) walk(item.children as Array<Partial<TaskInput>>, task.id)
      }
    }
    walk(subtasks, parentTaskId)
    if (draft.sessionId !== null && draft.sessionId !== undefined) {
      for (const task of created) {
        linkTaskSession(db, { taskId: task.id, sessionId: draft.sessionId, roleCode: 'breakdown' }, at)
      }
    }
    setDraftStatus(db, draftId, 'confirmed', at)
    db.exec('COMMIT')
    return created
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
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

// ---------------------------------------------------------------------------
// task shared memory（任务/子树共享上下文，跨会话续作）
// ---------------------------------------------------------------------------

export interface TaskMemoryInput {
  taskId: string
  kind?: string
  content: string
  sourceSessionId?: string | null
}

export interface TaskMemoryRow {
  id: string
  rootTaskId: string
  taskId: string
  kind: string
  content: string
  sourceSessionId: string | null
  createdAt: string
  updatedAt: string
}

interface RawTaskMemoryRow {
  id: string
  root_task_id: string
  task_id: string
  kind: string
  content: string
  source_session_id: string | null
  created_at: string
  updated_at: string
}

function parseTaskMemory(row: RawTaskMemoryRow | undefined): TaskMemoryRow | undefined {
  if (row === undefined) return undefined
  return {
    id: row.id,
    rootTaskId: row.root_task_id,
    taskId: row.task_id,
    kind: row.kind,
    content: row.content,
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getTaskRootId(db: DatabaseSync, taskId: string): string | undefined {
  let cursor = getTask(db, taskId)
  let guard = 0
  while (cursor !== undefined && cursor.parentId !== null && guard < 64) {
    cursor = getTask(db, cursor.parentId)
    guard += 1
  }
  return cursor?.id
}

export function getTaskMemory(db: DatabaseSync, id: string): TaskMemoryRow | undefined {
  return parseTaskMemory(db.prepare('SELECT * FROM task_memories WHERE id = ?').get(id) as RawTaskMemoryRow | undefined)
}

export function listTaskMemories(
  db: DatabaseSync,
  opts: { rootTaskId?: string; taskId?: string; limit?: number } = {},
): TaskMemoryRow[] {
  const conditions: string[] = []
  const params: Array<string | number> = []
  if (opts.rootTaskId !== undefined) { conditions.push('root_task_id = ?'); params.push(opts.rootTaskId) }
  if (opts.taskId !== undefined) { conditions.push('task_id = ?'); params.push(opts.taskId) }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 300))
  const rows = db.prepare(`SELECT * FROM task_memories ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit) as unknown as RawTaskMemoryRow[]
  return rows.map((row) => parseTaskMemory(row)).filter((memory): memory is TaskMemoryRow => memory !== undefined)
}

export function addTaskMemory(db: DatabaseSync, input: TaskMemoryInput, at = nowIso()): TaskMemoryRow | undefined {
  const task = getTask(db, input.taskId)
  if (task === undefined) return undefined
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  if (content === '') throw new Error('memory content is required')
  const rootTaskId = getTaskRootId(db, input.taskId) ?? input.taskId
  const id = randomUUID()
  const kind = typeof input.kind === 'string' && input.kind.trim() !== '' ? input.kind.trim() : 'note'
  db.prepare(`
    INSERT INTO task_memories (id, root_task_id, task_id, kind, content, source_session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, rootTaskId, input.taskId, kind, content, input.sourceSessionId ?? null, at, at)
  appendEvent(db, input.taskId, 'memory_added', { actor: 'system', note: `${kind}:${id}`, at })
  return getTaskMemory(db, id)
}

/** 格式化任务共享记忆，用于注入 AI 会话 prompt。按整棵任务树（root）共享。 */
export function getTaskMemoryContext(db: DatabaseSync, taskId: string, limit = 30): string {
  const rootTaskId = getTaskRootId(db, taskId)
  if (rootTaskId === undefined) return ''
  const memories = listTaskMemories(db, { rootTaskId, limit })
  if (memories.length === 0) return ''
  return memories.map((memory, index) => {
    const scope = memory.taskId === taskId ? '当前任务' : `任务 ${memory.taskId}`
    return `${index + 1}. [${memory.kind}]（${scope}）${memory.content}`
  }).join('\n')
}

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
// daily plans（V2 每日 AI 智能排序）
// ---------------------------------------------------------------------------

export interface DailyPlanItem {
  taskId: string
  order: number
  title: string
  note?: string
}

export interface DailyPlanInput {
  planDate: string
  summary?: string
  items: DailyPlanItem[]
  sourceCode?: string
  sessionId?: string | null
}

export interface DailyPlanRow {
  id: string
  planDate: string
  summary: string
  items: DailyPlanItem[]
  sourceCode: string
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

interface RawDailyPlanRow {
  id: string
  plan_date: string
  summary: string
  items_json: string
  source_code: string
  session_id: string | null
  created_at: string
  updated_at: string
}

function parseDailyPlan(row: RawDailyPlanRow | undefined): DailyPlanRow | undefined {
  if (row === undefined) return undefined
  const items: unknown = JSON.parse(row.items_json)
  return {
    id: row.id,
    planDate: row.plan_date,
    summary: row.summary,
    items: Array.isArray(items) ? items as DailyPlanItem[] : [],
    sourceCode: row.source_code,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getDailyPlan(db: DatabaseSync, planDate: string): DailyPlanRow | undefined {
  return parseDailyPlan(db.prepare('SELECT * FROM daily_plans WHERE plan_date = ?').get(planDate) as RawDailyPlanRow | undefined)
}

/** 同一日期只保留一份计划；再次确认即覆盖旧计划。 */
export function saveDailyPlan(db: DatabaseSync, input: DailyPlanInput, at = nowIso()): DailyPlanRow {
  const id = randomUUID()
  const items = input.items
    .map((item, index) => ({ taskId: item.taskId, order: Number.isFinite(item.order) ? item.order : index + 1, title: item.title ?? '', note: item.note ?? '' }))
    .sort((a, b) => a.order - b.order)
  db.prepare(`
    INSERT INTO daily_plans (id, plan_date, summary, items_json, source_code, session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_date) DO UPDATE SET
      summary = excluded.summary,
      items_json = excluded.items_json,
      source_code = excluded.source_code,
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
  `).run(id, input.planDate, input.summary ?? '', JSON.stringify(items), input.sourceCode ?? 'ai', input.sessionId ?? null, at, at)
  return getDailyPlan(db, input.planDate)!
}

/** 手动编辑计划：更新顺序/备注/成员，并标记来源为 manual；不存在时按 manual 新建。 */
export function updateDailyPlan(
  db: DatabaseSync,
  planDate: string,
  input: { summary?: string; items: Array<{ taskId: string; order?: number; note?: string }>; sourceCode?: string; sessionId?: string | null },
  at = nowIso(),
): DailyPlanRow {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) throw new Error('planDate must be YYYY-MM-DD')
  if (input.items.length === 0) throw new Error('daily_plan requires at least one item')
  const existing = getDailyPlan(db, planDate)
  const items = input.items
    .map((item, index) => {
      const task = getTask(db, item.taskId)
      if (task === undefined) throw new Error(`daily_plan contains unknown task ${item.taskId}`)
      return {
        taskId: item.taskId,
        order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : index + 1,
        title: task.title,
        note: item.note ?? '',
      }
    })
    .sort((a, b) => a.order - b.order)
  if (existing === undefined) {
    return saveDailyPlan(db, {
      planDate,
      summary: input.summary ?? '',
      items,
      sourceCode: input.sourceCode ?? 'manual',
      sessionId: input.sessionId ?? null,
    }, at)
  }
  db.prepare(`
    UPDATE daily_plans
    SET summary = ?, items_json = ?, source_code = ?, session_id = ?, updated_at = ?
    WHERE plan_date = ?
  `).run(
    input.summary ?? existing.summary,
    JSON.stringify(items),
    input.sourceCode ?? 'manual',
    input.sessionId ?? null,
    at,
    planDate,
  )
  return getDailyPlan(db, planDate)!
}

export function deleteDailyPlan(db: DatabaseSync, planDate: string): boolean {
  return db.prepare('DELETE FROM daily_plans WHERE plan_date = ?').run(planDate).changes > 0
}

export function confirmDailyPlanDraft(db: DatabaseSync, draftId: string, at = nowIso()): DailyPlanRow | undefined {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'daily_plan') return undefined
  const payload = draft.payload as { planDate?: string; summary?: string; items?: DailyPlanItem[] }
  const planDate = typeof payload.planDate === 'string' ? payload.planDate : undefined
  if (planDate === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(planDate)) throw new Error('daily_plan requires a valid planDate (YYYY-MM-DD)')
  const rawItems = Array.isArray(payload.items) ? payload.items : []
  if (rawItems.length === 0) throw new Error('daily_plan requires at least one item')
  const items: DailyPlanItem[] = []
  for (const raw of rawItems) {
    const taskId = typeof raw.taskId === 'string' ? raw.taskId : ''
    const task = getTask(db, taskId)
    if (task === undefined) throw new Error(`daily_plan contains unknown task ${taskId}`)
    items.push({ taskId, order: typeof raw.order === 'number' ? raw.order : items.length + 1, title: task.title, note: typeof raw.note === 'string' ? raw.note : '' })
  }
  db.exec('BEGIN')
  try {
    const plan = saveDailyPlan(db, { planDate, summary: payload.summary ?? '', items, sourceCode: 'ai', sessionId: draft.sessionId }, at)
    setDraftStatus(db, draftId, 'confirmed', at)
    db.exec('COMMIT')
    return plan
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getPendingDailyPlanDraft(db: DatabaseSync, sessionId: string | null, planDate?: string): DraftRow | undefined {
  if (sessionId === null || sessionId === undefined) return undefined
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND kind_code = 'daily_plan' ORDER BY created_at DESC").all() as unknown as RawDraftRow[]
  for (const row of rows) {
    const draft = parseDraft(row)
    if (draft === undefined || draft.sessionId !== sessionId) continue
    if (planDate !== undefined && draft.payload.planDate !== planDate) continue
    return draft
  }
  return undefined
}

// ---------------------------------------------------------------------------
// task reports（V2 日报 / 周报）
// ---------------------------------------------------------------------------

export type ReportPeriodCode = 'day' | 'week'

export interface TaskReportInput {
  periodCode: ReportPeriodCode
  periodStart: string
  title: string
  summaryMd: string
  stats?: Record<string, unknown>
  sessionId?: string | null
}

export interface TaskReportRow {
  id: string
  periodCode: ReportPeriodCode
  periodStart: string
  title: string
  summaryMd: string
  stats: Record<string, unknown>
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

interface RawTaskReportRow {
  id: string
  period_code: ReportPeriodCode
  period_start: string
  title: string
  summary_md: string
  stats_json: string
  session_id: string | null
  created_at: string
  updated_at: string
}

function parseTaskReport(row: RawTaskReportRow | undefined): TaskReportRow | undefined {
  if (row === undefined) return undefined
  const stats: unknown = JSON.parse(row.stats_json)
  return {
    id: row.id,
    periodCode: row.period_code,
    periodStart: row.period_start,
    title: row.title,
    summaryMd: row.summary_md,
    stats: typeof stats === 'object' && stats !== null ? stats as Record<string, unknown> : {},
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 同一周期（日报按天 / 周报按周）只保留一份，重复保存即覆盖。 */
export function saveTaskReport(db: DatabaseSync, input: TaskReportInput, at = nowIso()): TaskReportRow {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO task_reports (id, period_code, period_start, title, summary_md, stats_json, session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(period_code, period_start) DO UPDATE SET
      title = excluded.title,
      summary_md = excluded.summary_md,
      stats_json = excluded.stats_json,
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
  `).run(id, input.periodCode, input.periodStart, input.title, input.summaryMd, JSON.stringify(input.stats ?? {}), input.sessionId ?? null, at, at)
  return getTaskReport(db, input.periodCode, input.periodStart)!
}

export function getTaskReport(db: DatabaseSync, periodCode: ReportPeriodCode, periodStart: string): TaskReportRow | undefined {
  return parseTaskReport(db.prepare('SELECT * FROM task_reports WHERE period_code = ? AND period_start = ?').get(periodCode, periodStart) as RawTaskReportRow | undefined)
}

export function listTaskReports(db: DatabaseSync, opts: { periodCode?: ReportPeriodCode; limit?: number } = {}): TaskReportRow[] {
  const rows = (opts.periodCode === undefined
    ? db.prepare('SELECT * FROM task_reports ORDER BY period_start DESC, created_at DESC LIMIT ?').all(opts.limit ?? 200)
    : db.prepare('SELECT * FROM task_reports WHERE period_code = ? ORDER BY period_start DESC, created_at DESC LIMIT ?').all(opts.periodCode, opts.limit ?? 200)) as unknown as RawTaskReportRow[]
  return rows.map((row) => parseTaskReport(row)).filter((report): report is TaskReportRow => report !== undefined)
}

export function deleteTaskReport(db: DatabaseSync, periodCode: ReportPeriodCode, periodStart: string): boolean {
  return db.prepare('DELETE FROM task_reports WHERE period_code = ? AND period_start = ?').run(periodCode, periodStart).changes > 0
}

export function confirmReportDraft(db: DatabaseSync, draftId: string, at = nowIso()): TaskReportRow | undefined {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'report') return undefined
  const payload = draft.payload as { periodCode?: string; periodStart?: string; title?: string; summaryMd?: string; stats?: Record<string, unknown> }
  if (payload.periodCode !== 'day' && payload.periodCode !== 'week') throw new Error('report requires periodCode "day" or "week"')
  if (typeof payload.periodStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.periodStart)) throw new Error('report requires a valid periodStart (YYYY-MM-DD)')
  const title = typeof payload.title === 'string' && payload.title.trim() !== '' ? payload.title : payload.periodCode === 'day' ? `${payload.periodStart} 日报` : `${payload.periodStart} 周报`
  const summaryMd = typeof payload.summaryMd === 'string' ? payload.summaryMd : ''
  if (summaryMd.trim() === '') throw new Error('report requires summary_md')
  db.exec('BEGIN')
  try {
    const report = saveTaskReport(db, {
      periodCode: payload.periodCode,
      periodStart: payload.periodStart,
      title,
      summaryMd,
      stats: payload.stats ?? {},
      sessionId: draft.sessionId,
    }, at)
    setDraftStatus(db, draftId, 'confirmed', at)
    db.exec('COMMIT')
    return report
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getPendingReportDraft(db: DatabaseSync, sessionId: string | null, periodCode?: string, periodStart?: string): DraftRow | undefined {
  if (sessionId === null || sessionId === undefined) return undefined
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND kind_code = 'report' ORDER BY created_at DESC").all() as unknown as RawDraftRow[]
  for (const row of rows) {
    const draft = parseDraft(row)
    if (draft === undefined || draft.sessionId !== sessionId) continue
    if (periodCode !== undefined && draft.payload.periodCode !== periodCode) continue
    if (periodStart !== undefined && draft.payload.periodStart !== periodStart) continue
    return draft
  }
  return undefined
}

// ---------------------------------------------------------------------------
// AI session registry（V2：日报/周报/每日计划等复用型会话，每个 scope+anchor 一个）
// ---------------------------------------------------------------------------

export interface AiSessionRegistryInput {
  scopeCode: string
  anchor: string
  sessionId: string
  workspace?: string | null
  note?: string | null
}

export interface AiSessionRegistryRow {
  scopeCode: string
  anchor: string
  sessionId: string
  workspace: string | null
  note: string | null
  createdAt: string
  lastActivityAt: string
}

interface RawAiSessionRegistryRow {
  scope_code: string
  anchor: string
  session_id: string
  workspace: string | null
  note: string | null
  created_at: string
  last_activity_at: string
}

function parseAiSession(row: RawAiSessionRegistryRow | undefined): AiSessionRegistryRow | undefined {
  if (row === undefined) return undefined
  return {
    scopeCode: row.scope_code,
    anchor: row.anchor,
    sessionId: row.session_id,
    workspace: row.workspace,
    note: row.note,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  }
}

export function getAiSession(db: DatabaseSync, scopeCode: string, anchor: string): AiSessionRegistryRow | undefined {
  return parseAiSession(db.prepare('SELECT * FROM ai_session_registry WHERE scope_code = ? AND anchor = ?').get(scopeCode, anchor) as RawAiSessionRegistryRow | undefined)
}

/** 登记或刷新复用型 AI 会话；同 scope+anchor 只保留一条。 */
export function registerAiSession(db: DatabaseSync, input: AiSessionRegistryInput, at = nowIso()): AiSessionRegistryRow {
  const existing = getAiSession(db, input.scopeCode, input.anchor)
  const createdAt = existing?.createdAt ?? at
  db.prepare(`
    INSERT INTO ai_session_registry (scope_code, anchor, session_id, workspace, note, created_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_code, anchor) DO UPDATE SET
      session_id = excluded.session_id,
      workspace = excluded.workspace,
      note = excluded.note,
      last_activity_at = excluded.last_activity_at
  `).run(input.scopeCode, input.anchor, input.sessionId, input.workspace ?? null, input.note ?? null, createdAt, at)
  return getAiSession(db, input.scopeCode, input.anchor)!
}

// ---------------------------------------------------------------------------
// recurring tasks（V2.4：每天/每周/每月模板 → 惰性补齐实例）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// knowledge base（V2.5：个人知识库 / 错题集）
// ---------------------------------------------------------------------------

export interface KnowledgeInput {
  kindCode?: string
  title: string
  contentMd?: string
  tags?: string[]
  sourceTaskId?: string | null
  sourceSessionId?: string | null
  sourceReviewId?: string | null
}

export interface KnowledgeRow {
  id: string
  kindCode: string
  title: string
  contentMd: string
  tags: string[]
  sourceTaskId: string | null
  sourceSessionId: string | null
  sourceReviewId: string | null
  createdAt: string
  updatedAt: string
}

interface RawKnowledgeRow {
  id: string
  kind_code: string
  title: string
  content_md: string
  tags_json: string
  source_task_id: string | null
  source_session_id: string | null
  source_review_id: string | null
  created_at: string
  updated_at: string
}

function parseKnowledge(row: RawKnowledgeRow | undefined): KnowledgeRow | undefined {
  if (row === undefined) return undefined
  const tags: unknown = JSON.parse(row.tags_json)
  return {
    id: row.id,
    kindCode: row.kind_code,
    title: row.title,
    contentMd: row.content_md,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
    sourceTaskId: row.source_task_id,
    sourceSessionId: row.source_session_id,
    sourceReviewId: row.source_review_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createKnowledge(db: DatabaseSync, input: KnowledgeInput, at = nowIso()): KnowledgeRow {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO knowledge_entries (id, kind_code, title, content_md, tags_json, source_task_id, source_session_id, source_review_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.kindCode ?? 'note', input.title, input.contentMd ?? '', JSON.stringify(input.tags ?? []), input.sourceTaskId ?? null, input.sourceSessionId ?? null, input.sourceReviewId ?? null, at, at)
  return getKnowledge(db, id)!
}

export function getKnowledge(db: DatabaseSync, id: string): KnowledgeRow | undefined {
  return parseKnowledge(db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as RawKnowledgeRow | undefined)
}

export function listKnowledge(db: DatabaseSync, opts: { q?: string; kindCode?: string; sourceTaskId?: string; sourceReviewId?: string; limit?: number } = {}): KnowledgeRow[] {
  const conditions: string[] = []
  const params: Array<string | number> = []
  if (opts.kindCode !== undefined) { conditions.push('kind_code = ?'); params.push(opts.kindCode) }
  if (opts.sourceTaskId !== undefined) { conditions.push('source_task_id = ?'); params.push(opts.sourceTaskId) }
  if (opts.sourceReviewId !== undefined) { conditions.push('source_review_id = ?'); params.push(opts.sourceReviewId) }
  if (typeof opts.q === 'string' && opts.q.trim() !== '') {
    const like = `%${opts.q.trim()}%`
    conditions.push('(title LIKE ? OR content_md LIKE ? OR tags_json LIKE ?)')
    params.push(like, like, like)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500))
  const rows = db.prepare(`SELECT * FROM knowledge_entries ${where} ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(...params, limit) as unknown as RawKnowledgeRow[]
  return rows.map((row) => parseKnowledge(row)).filter((entry): entry is KnowledgeRow => entry !== undefined)
}

export function updateKnowledge(db: DatabaseSync, id: string, patch: Partial<KnowledgeInput>, at = nowIso()): KnowledgeRow | undefined {
  const before = getKnowledge(db, id)
  if (before === undefined) return undefined
  const next: KnowledgeRow = {
    ...before,
    kindCode: patch.kindCode ?? before.kindCode,
    title: patch.title ?? before.title,
    contentMd: patch.contentMd ?? before.contentMd,
    tags: patch.tags ?? before.tags,
    sourceTaskId: patch.sourceTaskId === undefined ? before.sourceTaskId : patch.sourceTaskId,
    sourceSessionId: patch.sourceSessionId === undefined ? before.sourceSessionId : patch.sourceSessionId,
    sourceReviewId: patch.sourceReviewId === undefined ? before.sourceReviewId : patch.sourceReviewId,
    updatedAt: at,
  }
  db.prepare(`
    UPDATE knowledge_entries SET kind_code = ?, title = ?, content_md = ?, tags_json = ?, source_task_id = ?, source_session_id = ?, source_review_id = ?, updated_at = ?
    WHERE id = ?
  `).run(next.kindCode, next.title, next.contentMd, JSON.stringify(next.tags), next.sourceTaskId, next.sourceSessionId, next.sourceReviewId, next.updatedAt, id)
  return next
}

export function deleteKnowledge(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id).changes > 0
}

export function confirmKnowledgeDraft(db: DatabaseSync, draftId: string, actor = 'user', at = nowIso()): KnowledgeRow | undefined {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'knowledge') return undefined
  const payload = draft.payload as { title?: string; contentMd?: string; kindCode?: string; tags?: string[]; sourceTaskId?: string; sourceSessionId?: string; sourceReviewId?: string }
  const title = typeof payload.title === 'string' ? payload.title.trim() : ''
  if (title === '') throw new Error('knowledge requires a non-empty title')
  const contentMd = typeof payload.contentMd === 'string' ? payload.contentMd : ''
  if (contentMd.trim() === '') throw new Error('knowledge requires content')
  db.exec('BEGIN')
  try {
    const entry = createKnowledge(db, {
      kindCode: payload.kindCode ?? 'note',
      title,
      contentMd,
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      sourceTaskId: typeof payload.sourceTaskId === 'string' ? payload.sourceTaskId : null,
      sourceSessionId: typeof payload.sourceSessionId === 'string' ? payload.sourceSessionId : draft.sessionId,
      sourceReviewId: typeof payload.sourceReviewId === 'string' ? payload.sourceReviewId : null,
    }, at)
    setDraftStatus(db, draftId, 'confirmed', at)
    db.exec('COMMIT')
    return entry
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getPendingKnowledgeDraft(db: DatabaseSync, sessionId: string | null): DraftRow | undefined {
  if (sessionId === null || sessionId === undefined) return undefined
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND kind_code = 'knowledge' ORDER BY created_at DESC").all() as unknown as RawDraftRow[]
  for (const row of rows) {
    const draft = parseDraft(row)
    if (draft !== undefined && draft.sessionId === sessionId) return draft
  }
  return undefined
}

// ---------------------------------------------------------------------------
// ideas & idea clusters（1.1.0 点子 / 点子王）
// ---------------------------------------------------------------------------

export interface IdeaInput {
  title: string
  contentMd?: string
  kindCode?: string
  tags?: string[]
  sourceSessionId?: string | null
}

export interface IdeaRow {
  id: string
  title: string
  contentMd: string
  kindCode: string
  tags: string[]
  sourceSessionId: string | null
  createdAt: string
  updatedAt: string
}

export interface IdeaClusterInput {
  title: string
  summaryMd?: string
  tags?: string[]
  ideaIds?: string[]
  notes?: Record<string, string>
}

export interface IdeaClusterRow {
  id: string
  title: string
  summaryMd: string
  tags: string[]
  ideas: IdeaRow[]
  createdAt: string
  updatedAt: string
}

interface RawIdeaRow {
  id: string
  title: string
  content_md: string
  kind_code: string
  tags_json: string
  source_session_id: string | null
  created_at: string
  updated_at: string
}

function parseIdea(row: RawIdeaRow | undefined): IdeaRow | undefined {
  if (row === undefined) return undefined
  const tags: unknown = JSON.parse(row.tags_json)
  return {
    id: row.id,
    title: row.title,
    contentMd: row.content_md,
    kindCode: row.kind_code,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createIdea(db: DatabaseSync, input: IdeaInput, at = nowIso()): IdeaRow {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO ideas (id, title, content_md, kind_code, tags_json, source_session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.title, input.contentMd ?? '', input.kindCode ?? 'spark', JSON.stringify(input.tags ?? []), input.sourceSessionId ?? null, at, at)
  return getIdea(db, id)!
}

export function getIdea(db: DatabaseSync, id: string): IdeaRow | undefined {
  return parseIdea(db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as RawIdeaRow | undefined)
}

export function listIdeas(db: DatabaseSync, opts: { q?: string; kindCode?: string; limit?: number } = {}): IdeaRow[] {
  const conditions: string[] = []
  const params: Array<string | number> = []
  if (opts.kindCode !== undefined) { conditions.push('kind_code = ?'); params.push(opts.kindCode) }
  if (typeof opts.q === 'string' && opts.q.trim() !== '') {
    const like = `%${opts.q.trim()}%`
    conditions.push('(title LIKE ? OR content_md LIKE ? OR tags_json LIKE ?)')
    params.push(like, like, like)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(opts.limit ?? 300, 500))
  const rows = db.prepare(`SELECT * FROM ideas ${where} ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(...params, limit) as unknown as RawIdeaRow[]
  return rows.map((row) => parseIdea(row)).filter((idea): idea is IdeaRow => idea !== undefined)
}

export function updateIdea(db: DatabaseSync, id: string, patch: Partial<IdeaInput>, at = nowIso()): IdeaRow | undefined {
  const before = getIdea(db, id)
  if (before === undefined) return undefined
  const next: IdeaRow = {
    ...before,
    title: patch.title ?? before.title,
    contentMd: patch.contentMd ?? before.contentMd,
    kindCode: patch.kindCode ?? before.kindCode,
    tags: patch.tags ?? before.tags,
    sourceSessionId: patch.sourceSessionId === undefined ? before.sourceSessionId : patch.sourceSessionId,
    updatedAt: at,
  }
  db.prepare('UPDATE ideas SET title = ?, content_md = ?, kind_code = ?, tags_json = ?, source_session_id = ?, updated_at = ? WHERE id = ?')
    .run(next.title, next.contentMd, next.kindCode, JSON.stringify(next.tags), next.sourceSessionId, next.updatedAt, id)
  return next
}

export function deleteIdea(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM ideas WHERE id = ?').run(id).changes > 0
}

function insertIdeaCluster(db: DatabaseSync, input: IdeaClusterInput, at = nowIso()): string {
  const id = randomUUID()
  db.prepare('INSERT INTO idea_clusters (id, title, summary_md, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, input.title, input.summaryMd ?? '', JSON.stringify(input.tags ?? []), at, at)
  for (const ideaId of input.ideaIds ?? []) {
    db.prepare('INSERT OR IGNORE INTO idea_links (cluster_id, idea_id, note, created_at) VALUES (?, ?, ?, ?)')
      .run(id, ideaId, input.notes?.[ideaId] ?? null, at)
  }
  return id
}

export function createIdeaCluster(db: DatabaseSync, input: IdeaClusterInput, at = nowIso()): IdeaClusterRow {
  db.exec('BEGIN')
  try {
    const id = insertIdeaCluster(db, input, at)
    db.exec('COMMIT')
    return getIdeaCluster(db, id)!
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getIdeaCluster(db: DatabaseSync, id: string): IdeaClusterRow | undefined {
  const row = db.prepare('SELECT * FROM idea_clusters WHERE id = ?').get(id) as {
    id: string; title: string; summary_md: string; tags_json: string; created_at: string; updated_at: string
  } | undefined
  if (row === undefined) return undefined
  const tags: unknown = JSON.parse(row.tags_json)
  const ideaRows = db.prepare(`
    SELECT i.*, l.note AS link_note FROM idea_links l JOIN ideas i ON i.id = l.idea_id
    WHERE l.cluster_id = ? ORDER BY i.created_at
  `).all(id) as unknown as Array<RawIdeaRow & { link_note: string | null }>
  return {
    id: row.id,
    title: row.title,
    summaryMd: row.summary_md,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
    ideas: ideaRows.map((ideaRow) => parseIdea(ideaRow)).filter((idea): idea is IdeaRow => idea !== undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listIdeaClusters(db: DatabaseSync, opts: { limit?: number } = {}): IdeaClusterRow[] {
  const rows = db.prepare('SELECT id FROM idea_clusters ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(opts.limit ?? 200, 500))) as unknown as Array<{ id: string }>
  return rows.map((row) => getIdeaCluster(db, row.id)).filter((cluster): cluster is IdeaClusterRow => cluster !== undefined)
}

export function deleteIdeaCluster(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM idea_clusters WHERE id = ?').run(id).changes > 0
}

export function listIdeaClustersForIdea(db: DatabaseSync, ideaId: string): IdeaClusterRow[] {
  const rows = db.prepare('SELECT cluster_id FROM idea_links WHERE idea_id = ?').all(ideaId) as unknown as Array<{ cluster_id: string }>
  return rows.map((row) => getIdeaCluster(db, row.cluster_id)).filter((cluster): cluster is IdeaClusterRow => cluster !== undefined)
}

export function confirmIdeaClusterDraft(db: DatabaseSync, draftId: string, actor = 'user', at = nowIso()): IdeaClusterRow[] {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'idea_cluster') return []
  const clusters = Array.isArray(draft.payload.clusters) ? draft.payload.clusters as Array<{
    title?: string; summary?: string; idea_ids?: string[]; notes?: Record<string, string>
  }> : []
  if (clusters.length === 0) throw new Error('idea_cluster draft requires at least one cluster')
  const created: IdeaClusterRow[] = []
  db.exec('BEGIN')
  try {
    for (const cluster of clusters) {
      const title = typeof cluster.title === 'string' && cluster.title.trim() !== '' ? cluster.title.trim() : '未命名点子王'
      const ideaIds = Array.isArray(cluster.idea_ids) ? cluster.idea_ids.filter((id): id is string => typeof id === 'string') : []
      if (ideaIds.length === 0) throw new Error(`点子王「${title}」没有关联点子`)
      const clusterId = insertIdeaCluster(db, {
        title,
        summaryMd: typeof cluster.summary === 'string' ? cluster.summary : '',
        tags: [],
        ideaIds,
        notes: cluster.notes ?? {},
      }, at)
      created.push(getIdeaCluster(db, clusterId)!)
    }
    setDraftStatus(db, draftId, 'confirmed', at)
    db.exec('COMMIT')
    return created
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function confirmIdeaTaskDraft(db: DatabaseSync, draftId: string, actor = 'user', at = nowIso()): TaskRow[] {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'idea_tasks') return []
  const tasks = Array.isArray(draft.payload.tasks) ? draft.payload.tasks as Array<Partial<TaskInput> & Record<string, unknown>> : []
  if (tasks.length === 0) throw new Error('idea_tasks draft requires at least one task')
  const sourceIdeaIds = Array.isArray(draft.payload.sourceIdeaIds) ? draft.payload.sourceIdeaIds.filter((id): id is string => typeof id === 'string') : []
  const sourceClusterId = typeof draft.payload.sourceClusterId === 'string' ? draft.payload.sourceClusterId : null
  db.exec('BEGIN')
  try {
    const created: TaskRow[] = []
    const validCode = (kind: string, code: string | undefined, fallback: string): string => {
      if (code !== undefined && getDictionary(db, kind, code)?.active === 1) return code
      // AI 常见同义 code 归一化；其余未知 code 一律回退到安全默认值。
      const aliases: Record<string, string> = { life: 'personal', living: 'personal', home: 'personal', work: 'project_delivery', code: 'code_impl' }
      const candidate = aliases[code ?? ''] ?? fallback
      return getDictionary(db, kind, candidate)?.active === 1 ? candidate : fallback
    }
    const walk = (items: Array<Partial<TaskInput> & Record<string, unknown>>, parentId: string | null): void => {
      for (const item of items) {
        const title = typeof item.title === 'string' ? item.title.trim() : ''
        if (title === '') continue
        const typeCode = validCode('type', String(item.typeCode ?? item.type_code ?? ''), 'personal')
        const priorityCode = validCode('priority', String(item.priorityCode ?? item.priority_code ?? ''), 'p2')
        const task = createTask(db, {
          title,
          description: typeof item.description === 'string' ? item.description : undefined,
          typeCode,
          priorityCode,
          dueAt: typeof item.dueAt === 'string' ? item.dueAt : typeof item.due_at === 'string' ? item.due_at : null,
          estimatedMinutes: typeof item.estimatedMinutes === 'number' ? item.estimatedMinutes : null,
          aiPolicyCode: validCode('ai_policy', typeof item.aiPolicyCode === 'string' ? item.aiPolicyCode : undefined, 'consult'),
          parentId,
          extra: { sourceIdeaIds, sourceClusterId, source: 'idea' },
        }, actor, at)
        created.push(task)
        if (Array.isArray(item.children)) walk(item.children as Array<Partial<TaskInput>>, task.id)
      }
    }
    walk(tasks, null)
    if (created.length === 0) throw new Error('idea_tasks draft contains no valid tasks')
    setDraftStatus(db, draftId, 'confirmed', at)
    db.exec('COMMIT')
    return created
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getPendingDraftForSession(db: DatabaseSync, sessionId: string | null, kindCode: string): DraftRow | undefined {
  if (sessionId === null || sessionId === undefined) return undefined
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND kind_code = ? ORDER BY created_at DESC").all(kindCode) as unknown as RawDraftRow[]
  for (const row of rows) {
    const draft = parseDraft(row)
    if (draft !== undefined && draft.sessionId === sessionId) return draft
  }
  return undefined
}
