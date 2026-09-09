/**
 * AI 会话注册表（V2：日报/周报/每日计划等复用型会话，每个 scope+anchor 一个）。
 *
 * 从 repo.ts 原样抽出（行为不变）。对外符号由 repo.ts 再导出。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from '../repo.js'


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

