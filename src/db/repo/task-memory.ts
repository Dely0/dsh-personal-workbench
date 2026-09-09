/**
 * 任务共享记忆（任务/子树共享上下文，跨会话续作）。
 *
 * 从 repo.ts 原样抽出（行为不变）。对外符号由 repo.ts 再导出。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, appendEvent, getTask } from '../repo.js'


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

