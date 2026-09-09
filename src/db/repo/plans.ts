/**
 * 每日计划域（V2 每日 AI 智能排序）。
 *
 * 从 repo.ts 原样抽出（行为不变）。对外符号由 repo.ts 再导出。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, getDraft, withDraftConfirm, getTask, type DraftRow } from '../repo.js'


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
  return withDraftConfirm(db, draftId, 'daily_plan', () => saveDailyPlan(db, { planDate, summary: payload.summary ?? '', items, sourceCode: 'ai', sessionId: draft.sessionId }, at), { at })
}

export function getPendingDailyPlanDraft(db: DatabaseSync, sessionId: string | null, planDate?: string): DraftRow | undefined {
  if (sessionId === null || sessionId === undefined) return undefined
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND kind_code = 'daily_plan' ORDER BY created_at DESC").all() as unknown as Array<{
    id: string
    kind_code: string
    session_id: string | null
    payload_json: string
    status_code: string
    created_at: string
    updated_at: string
  }>
  for (const row of rows) {
    if (row.session_id !== sessionId) continue
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    if (planDate !== undefined && payload.planDate !== planDate) continue
    return {
      id: row.id,
      kindCode: row.kind_code,
      sessionId: row.session_id,
      payload,
      statusCode: row.status_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
  return undefined
}
