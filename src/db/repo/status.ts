/**
 * 状态聚合与级联：完成/取消的向上聚合、归档、事件与复盘记录。
 *
 * 从 repo.ts 原样抽出（行为不变）。对外符号由 repo.ts 再导出。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { appendEvent } from './task-primitives.js'
import { getTask, listTasks, listChildren, updateTask } from './tasks.js'
import { nowIso, type TaskPatch, type TaskRow } from '../repo.js'


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

