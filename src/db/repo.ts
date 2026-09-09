/**
 * 仓储层：任务 / 草稿 / 会话关联 / 提醒 / 事件。
 * 所有写操作都记 task_events；字典 code 在服务层进一步校验。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, getDraft, setDraftStatus, withDraftConfirm, parseDraft, type DraftRow, type RawDraftRow } from './repo/shared.js'
export { nowIso, getDraft, setDraftStatus, withDraftConfirm } from './repo/shared.js'
export type { DraftRow } from './repo/shared.js'
import { effectiveDueAtForTask, effectiveWorkspacePathForTask, parseTask, appendEvent, collectArchivedDescendants, type RawTaskRow } from './repo/task-primitives.js'
export { effectiveDueAtForTask, effectiveWorkspacePathForTask, parseTask, appendEvent } from './repo/task-primitives.js'
export type { RawTaskRow } from './repo/task-primitives.js'


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

// 草稿域已抽到 repo/drafts.ts
export {
  createDraft, updateDraft, getDraftBySession, confirmTaskDraft, confirmSubtaskPlanDraft,
  getLatestPendingDraft, getPendingDraftForTask, abandonDraft, toTaskInputFromDraftItem,
} from './repo/drafts.js'
export type { DraftTaskItem } from './repo/drafts.js'


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
