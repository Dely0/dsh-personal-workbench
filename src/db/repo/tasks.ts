/**
 * 任务域：建、读、列、改（含列表排序与父任务归属过滤）。
 *
 * 从 repo.ts 原样抽出（行为不变）。对外符号由 repo.ts 再导出。
 * 级联完成/归档在 repo/status.ts，任务原语在 repo/task-primitives.ts。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { parseTask, effectiveDueAtForTask, effectiveWorkspacePathForTask, appendEvent, collectArchivedDescendants, isDescendantOf, type RawTaskRow } from './task-primitives.js'
import { listDictionaries } from './dictionaries.js'
import { nowIso, type TaskInput, type TaskPatch, type TaskRow } from '../repo.js'


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
 * 改父任务（re-parent）的守卫，放在仓储层：路由、AI 工具、级联/归档等**所有**调用方
 * 都走 updateTask，因此校验只此一份，不会有人绕过。
 *
 * 拒绝的四种情况（消息直接回给用户，所以用中文说清楚原因）：
 * 1. 挂到自己身上；2. 父任务不存在；3. 父任务已归档；4. 父任务在自己的子树里（会成环）。
 * 返回归一化后的 parentId（null = 顶层）。
 */
function assertParentChangeAllowed(db: DatabaseSync, task: Pick<TaskRow, 'id' | 'title'>, parentId: string | null): string | null {
  if (parentId === null) return null
  if (parentId === task.id) throw new Error('不能把任务挂到自己身上')
  const parent = getTask(db, parentId)
  if (parent === undefined) throw new Error(`父任务不存在：${parentId}`)
  if (parent.archived === 1) throw new Error(`父任务「${parent.title}」已归档，不能把任务挂到它下面`)
  if (isDescendantOf(db, parentId, task.id)) throw new Error('不能把任务挂到它自己的子任务下（会形成环）')
  return parentId
}

/** 「记录」页签里可读的父任务描述：顶层 / 父任务标题（取不到时退回 id）。 */
function parentLabel(db: DatabaseSync, parentId: string | null): string {
  if (parentId === null) return '顶层'
  return getTask(db, parentId)?.title ?? parentId
}

export function updateTask(db: DatabaseSync, id: string, patch: TaskPatch, actor = 'user', at = nowIso()): TaskRow | undefined {
  const before = getTask(db, id)
  if (before === undefined) return undefined
  // 改父任务：undefined = 不变，null = 移到顶层，字符串 = 挂到该父任务下（先校验再写）。
  const parentId = patch.parentId === undefined ? before.parentId : assertParentChangeAllowed(db, before, patch.parentId)
  const next: TaskRow = {
    ...before,
    parentId,
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
      workspace_path = ?, parent_id = ?, extra = ?, recurrence_code = ?, recurrence_rule = ?,
      updated_at = ?, completed_at = ?, cancelled_at = ?
    WHERE id = ?
  `).run(
    next.title, next.description, next.typeCode, next.statusCode, next.priorityCode,
    next.aiPolicyCode, next.dueAt, next.allDay, next.estimatedMinutes, next.archived,
    next.workspacePath, next.parentId, JSON.stringify(next.extra), next.recurrenceCode, JSON.stringify(next.recurrenceRule),
    next.updatedAt, next.completedAt, next.cancelledAt, id,
  )
  appendEvent(db, id, 'updated', { before, after: next, actor, at })
  // 改父任务额外留一条可读事件：任务详情「记录」页签直接显示「父任务：A → B」，
  // 而不是让用户从 before/after JSON 里自己比对 parent_id。
  if (next.parentId !== before.parentId) {
    appendEvent(db, id, 'reparented', {
      before: { parentId: before.parentId },
      after: { parentId: next.parentId },
      actor,
      at,
      note: `父任务：${parentLabel(db, before.parentId)} → ${parentLabel(db, next.parentId)}`,
    })
  }
  return next
}

