/**
 * 仓储层：任务 / 草稿 / 会话关联 / 提醒 / 事件。
 * 所有写操作都记 task_events；字典 code 在服务层进一步校验。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { effectiveDueAtForTask, effectiveWorkspacePathForTask, parseTask, appendEvent, collectArchivedDescendants, type RawTaskRow } from './repo/task-primitives.js'
export { effectiveDueAtForTask, effectiveWorkspacePathForTask, parseTask, appendEvent } from './repo/task-primitives.js'
export type { RawTaskRow } from './repo/task-primitives.js'

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


// 字典域已抽到 repo/dictionaries.ts
import { listDictionaries, getDictionary, dictionaryUsageCount } from './repo/dictionaries.js'
export {
  listDictionaries, getDictionary, createDictionaryEntry, updateDictionaryEntry, deleteDictionaryEntry, dictionaryUsageCount,
} from './repo/dictionaries.js'

// 任务域已抽到 repo/tasks.ts
import { createTask, getTask, listTasks, listChildren, updateTask } from './repo/tasks.js'
export { createTask, getTask, listTasks, listChildren, updateTask } from './repo/tasks.js'

// 状态聚合与级联已抽到 repo/status.ts
import {
  completeTaskCascade, updateTaskWithCompletion, repairParentCompletion,
  archiveTask, restoreTask, listArchivedTasks, listTaskEvents, createTaskReview, listTaskReviews,
} from './repo/status.js'
export {
  completeTaskCascade, updateTaskWithCompletion, repairParentCompletion,
  archiveTask, restoreTask, listArchivedTasks, listTaskEvents, createTaskReview, listTaskReviews,
} from './repo/status.js'
export type { TaskReviewInput } from './repo/status.js'

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

// 任务会话关联已抽到 repo/task-sessions.ts
import { linkTaskSession } from './repo/task-sessions.js'
export { linkTaskSession, listTaskSessions } from './repo/task-sessions.js'


// 任务共享记忆已抽到 repo/task-memory.ts
export { getTaskRootId, getTaskMemory, listTaskMemories, addTaskMemory, getTaskMemoryContext } from './repo/task-memory.js'
export type { TaskMemoryRow } from './repo/task-memory.js'

// 提醒域已抽到 repo/reminders.ts
import { addReminder } from './repo/reminders.js'
export { listDueReminders, listReminders, fireReminder, addReminder } from './repo/reminders.js'
export type { DueReminder, TaskReminderRow } from './repo/reminders.js'

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
