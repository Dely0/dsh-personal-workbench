/**
 * 仓储层：任务 / 草稿 / 会话关联 / 提醒 / 事件。
 * 所有写操作都记 task_events；字典 code 在服务层进一步校验。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const nowIso = (): string => new Date().toISOString()

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
  allDay: number
  estimatedMinutes: number | null
  source: string
  workspacePath: string | null
  archived: number
  extra: Record<string, unknown>
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
  created_at: string
  updated_at: string
  completed_at: string | null
  cancelled_at: string | null
}

function parseTask(row: RawTaskRow | undefined): TaskRow | undefined {
  if (row === undefined) return undefined
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    typeCode: row.type_code,
    statusCode: row.status_code,
    priorityCode: row.priority_code,
    aiPolicyCode: row.ai_policy_code,
    dueAt: row.due_at,
    allDay: row.all_day,
    estimatedMinutes: row.estimated_minutes,
    source: row.source,
    workspacePath: row.workspace_path,
    archived: row.archived,
    extra: JSON.parse(row.extra) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
  }
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
    allDay: input.allDay ? 1 : 0,
    estimatedMinutes: input.estimatedMinutes ?? null,
    source: input.source ?? 'manual',
    workspacePath: input.workspacePath ?? null,
    archived: 0,
    extra: input.extra ?? {},
    createdAt: at,
    updatedAt: at,
    completedAt: input.statusCode === 'done' ? at : null,
    cancelledAt: input.statusCode === 'cancelled' ? at : null,
  }
  db.prepare(`
    INSERT INTO tasks
      (id, parent_id, title, description, type_code, status_code, priority_code,
       ai_policy_code, due_at, all_day, estimated_minutes, source, workspace_path, archived, extra,
       created_at, updated_at, completed_at, cancelled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `).run(
    task.id, task.parentId, task.title, task.description, task.typeCode,
    task.statusCode, task.priorityCode, task.aiPolicyCode, task.dueAt, task.allDay,
    task.estimatedMinutes, task.source, task.workspacePath, JSON.stringify(task.extra),
    task.createdAt, task.updatedAt, task.completedAt, task.cancelledAt,
  )
  appendEvent(db, id, 'created', { after: task, actor, at })
  return task
}

export function getTask(db: DatabaseSync, id: string): TaskRow | undefined {
  return parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as RawTaskRow | undefined)
}

export function listTasks(db: DatabaseSync, opts: { includeArchived?: boolean; parentId?: string | null } = {}): TaskRow[] {
  const includeArchived = opts.includeArchived ?? false
  const parentId = opts.parentId
  const all = (parentId === undefined
    ? db.prepare('SELECT * FROM tasks').all()
    : db.prepare('SELECT * FROM tasks WHERE parent_id IS ?').all(parentId)) as unknown as RawTaskRow[]
  return all
    .filter((row) => includeArchived || row.archived === 0)
    .map((row) => parseTask(row))
    .filter((task): task is TaskRow => task !== undefined)
    .sort((a, b) => {
      const rank = (task: TaskRow): number => {
        if (task.statusCode === 'done' || task.statusCode === 'cancelled') return 4
        const weight = Number(getDictionary(db, 'priority', task.priorityCode)?.config.weight ?? 99)
        return weight
      }
      const rankDiff = rank(a) - rank(b)
      if (rankDiff !== 0) return rankDiff
      if (a.dueAt === null && b.dueAt === null) return a.createdAt.localeCompare(b.createdAt)
      if (a.dueAt === null) return 1
      if (b.dueAt === null) return -1
      return a.dueAt.localeCompare(b.dueAt)
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
    updatedAt: at,
    completedAt: patch.statusCode === 'done' ? at : patch.statusCode !== undefined ? null : before.completedAt,
    cancelledAt: patch.statusCode === 'cancelled' ? at : patch.statusCode !== undefined ? null : before.cancelledAt,
  }
  db.prepare(`
    UPDATE tasks SET
      title = ?, description = ?, type_code = ?, status_code = ?, priority_code = ?,
      ai_policy_code = ?, due_at = ?, all_day = ?, estimated_minutes = ?, archived = ?,
      workspace_path = ?, extra = ?, updated_at = ?, completed_at = ?, cancelled_at = ?
    WHERE id = ?
  `).run(
    next.title, next.description, next.typeCode, next.statusCode, next.priorityCode,
    next.aiPolicyCode, next.dueAt, next.allDay, next.estimatedMinutes, next.archived,
    next.workspacePath, JSON.stringify(next.extra), next.updatedAt, next.completedAt, next.cancelledAt, id,
  )
  appendEvent(db, id, 'updated', { before, after: next, actor, at })
  return next
}

export function archiveTask(db: DatabaseSync, id: string, actor = 'user'): TaskRow | undefined {
  return updateTask(db, id, { archived: true }, actor)
}

export function restoreTask(db: DatabaseSync, id: string, actor = 'user'): TaskRow | undefined {
  return updateTask(db, id, { archived: false }, actor)
}

export function listArchivedTasks(db: DatabaseSync): TaskRow[] {
  return listTasks(db, { includeArchived: true }).filter((task) => task.archived === 1)
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
  const payload = draft.payload as Partial<TaskInput>
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
  const subtasks = Array.isArray(payload.subtasks) ? payload.subtasks : []
  db.exec('BEGIN')
  try {
    const created: TaskRow[] = []
    const walk = (items: Array<Partial<TaskInput> & Record<string, unknown>>, parentId: string | null): void => {
      for (const item of items) {
        const title = typeof item.title === 'string' ? item.title : ''
        if (title.trim() === '') continue
        // 提案工具写入的是 snake_case（type_code），表单/任务草稿写入的是 camelCase，这里两者都收。
        const typeCode = String(item.typeCode ?? item.type_code ?? 'personal')
        const priorityCode = String(item.priorityCode ?? item.priority_code ?? 'p2')
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
           t.title, t.due_at
    FROM task_reminders r
    JOIN tasks t ON t.id = r.task_id
    WHERE r.enabled = 1 AND r.fired_at IS NULL
      AND t.archived = 0
      AND t.status_code NOT IN ('done', 'cancelled')
      AND t.due_at IS NOT NULL
  `).all() as Array<{
    reminder_id: string
    task_id: string
    offset_minutes: number
    method_code: string
    title: string
    due_at: string
  }>
  const nowMs = now.getTime()
  return rows
    .filter((row) => {
      const dueMs = Date.parse(row.due_at)
      if (!Number.isFinite(dueMs)) return false
      return nowMs >= dueMs - row.offset_minutes * 60_000
    })
    .map((row) => ({
      reminderId: row.reminder_id,
      taskId: row.task_id,
      title: row.title,
      dueAt: row.due_at,
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
