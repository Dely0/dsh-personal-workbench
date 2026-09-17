/**
 * 任务与会话的关联（澄清/拆解/执行/复盘等会话挂到任务上）。
 *
 * 从 repo.ts 原样抽出（行为不变）。对外符号由 repo.ts 再导出。
 */
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, appendEvent, type TaskSessionLinkInput } from '../repo.js'


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

/**
 * 反查：这个会话是挂在哪个任务上的（v1.15.3 知识库自动召回用）。
 *
 * 为什么需要它：自动召回要"**先查本任务/本任务树**，再扩到全局"，
 * 而会话侧只知道自己的 id 与 cwd。权威映射就是这张表（客户端在开启执行/澄清会话时写入）。
 * 一个会话理论上只挂一个任务，但 `role_code` 允许多行 → 取最近活跃的一条，
 * 并把任务 id 一并返回，便于调用方在自己的任务链上继续。
 */
export function findTaskIdBySession(db: DatabaseSync, sessionId: string): string | undefined {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  const row = db.prepare(
    'SELECT task_id FROM task_sessions WHERE session_id = ? ORDER BY last_activity_at DESC, created_at DESC LIMIT 1',
  ).get(sessionId) as { task_id: string } | undefined
  return row?.task_id
}
