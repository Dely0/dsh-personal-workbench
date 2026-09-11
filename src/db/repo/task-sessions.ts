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
