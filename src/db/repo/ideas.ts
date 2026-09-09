/**
 * 点子 / 点子王域（1.1.0）。
 *
 * 从 repo.ts 原样抽出（行为不变）。对外符号由 repo.ts 再导出，调用方无需改 import。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, getDraft, withDraftConfirm, toTaskInputFromDraftItem, createTask, getDictionary, type DraftRow, type DraftTaskItem, type TaskRow } from '../repo.js'


export interface IdeaInput {
  title: string
  contentMd?: string
  kindCode?: string
  tags?: string[]
  sourceSessionId?: string | null
}

export interface IdeaRow {
  id: string
  title: string
  contentMd: string
  kindCode: string
  tags: string[]
  sourceSessionId: string | null
  createdAt: string
  updatedAt: string
}

export interface IdeaClusterInput {
  title: string
  summaryMd?: string
  tags?: string[]
  ideaIds?: string[]
  notes?: Record<string, string>
}

export interface IdeaClusterRow {
  id: string
  title: string
  summaryMd: string
  tags: string[]
  ideas: IdeaRow[]
  createdAt: string
  updatedAt: string
}

interface RawIdeaRow {
  id: string
  title: string
  content_md: string
  kind_code: string
  tags_json: string
  source_session_id: string | null
  created_at: string
  updated_at: string
}

function parseIdea(row: RawIdeaRow | undefined): IdeaRow | undefined {
  if (row === undefined) return undefined
  const tags: unknown = JSON.parse(row.tags_json)
  return {
    id: row.id,
    title: row.title,
    contentMd: row.content_md,
    kindCode: row.kind_code,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createIdea(db: DatabaseSync, input: IdeaInput, at = nowIso()): IdeaRow {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO ideas (id, title, content_md, kind_code, tags_json, source_session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.title, input.contentMd ?? '', input.kindCode ?? 'spark', JSON.stringify(input.tags ?? []), input.sourceSessionId ?? null, at, at)
  return getIdea(db, id)!
}

export function getIdea(db: DatabaseSync, id: string): IdeaRow | undefined {
  return parseIdea(db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as RawIdeaRow | undefined)
}

export function listIdeas(db: DatabaseSync, opts: { q?: string; kindCode?: string; limit?: number } = {}): IdeaRow[] {
  const conditions: string[] = []
  const params: Array<string | number> = []
  if (opts.kindCode !== undefined) { conditions.push('kind_code = ?'); params.push(opts.kindCode) }
  if (typeof opts.q === 'string' && opts.q.trim() !== '') {
    const like = `%${opts.q.trim()}%`
    conditions.push('(title LIKE ? OR content_md LIKE ? OR tags_json LIKE ?)')
    params.push(like, like, like)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(opts.limit ?? 300, 500))
  const rows = db.prepare(`SELECT * FROM ideas ${where} ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(...params, limit) as unknown as RawIdeaRow[]
  return rows.map((row) => parseIdea(row)).filter((idea): idea is IdeaRow => idea !== undefined)
}

export function updateIdea(db: DatabaseSync, id: string, patch: Partial<IdeaInput>, at = nowIso()): IdeaRow | undefined {
  const before = getIdea(db, id)
  if (before === undefined) return undefined
  const next: IdeaRow = {
    ...before,
    title: patch.title ?? before.title,
    contentMd: patch.contentMd ?? before.contentMd,
    kindCode: patch.kindCode ?? before.kindCode,
    tags: patch.tags ?? before.tags,
    sourceSessionId: patch.sourceSessionId === undefined ? before.sourceSessionId : patch.sourceSessionId,
    updatedAt: at,
  }
  db.prepare('UPDATE ideas SET title = ?, content_md = ?, kind_code = ?, tags_json = ?, source_session_id = ?, updated_at = ? WHERE id = ?')
    .run(next.title, next.contentMd, next.kindCode, JSON.stringify(next.tags), next.sourceSessionId, next.updatedAt, id)
  return next
}

export function deleteIdea(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM ideas WHERE id = ?').run(id).changes > 0
}

function insertIdeaCluster(db: DatabaseSync, input: IdeaClusterInput, at = nowIso()): string {
  const id = randomUUID()
  db.prepare('INSERT INTO idea_clusters (id, title, summary_md, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, input.title, input.summaryMd ?? '', JSON.stringify(input.tags ?? []), at, at)
  for (const ideaId of input.ideaIds ?? []) {
    db.prepare('INSERT OR IGNORE INTO idea_links (cluster_id, idea_id, note, created_at) VALUES (?, ?, ?, ?)')
      .run(id, ideaId, input.notes?.[ideaId] ?? null, at)
  }
  return id
}

export function createIdeaCluster(db: DatabaseSync, input: IdeaClusterInput, at = nowIso()): IdeaClusterRow {
  db.exec('BEGIN')
  try {
    const id = insertIdeaCluster(db, input, at)
    db.exec('COMMIT')
    return getIdeaCluster(db, id)!
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getIdeaCluster(db: DatabaseSync, id: string): IdeaClusterRow | undefined {
  const row = db.prepare('SELECT * FROM idea_clusters WHERE id = ?').get(id) as {
    id: string; title: string; summary_md: string; tags_json: string; created_at: string; updated_at: string
  } | undefined
  if (row === undefined) return undefined
  const tags: unknown = JSON.parse(row.tags_json)
  const ideaRows = db.prepare(`
    SELECT i.*, l.note AS link_note FROM idea_links l JOIN ideas i ON i.id = l.idea_id
    WHERE l.cluster_id = ? ORDER BY i.created_at
  `).all(id) as unknown as Array<RawIdeaRow & { link_note: string | null }>
  return {
    id: row.id,
    title: row.title,
    summaryMd: row.summary_md,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
    ideas: ideaRows.map((ideaRow) => parseIdea(ideaRow)).filter((idea): idea is IdeaRow => idea !== undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listIdeaClusters(db: DatabaseSync, opts: { limit?: number } = {}): IdeaClusterRow[] {
  const rows = db.prepare('SELECT id FROM idea_clusters ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(opts.limit ?? 200, 500))) as unknown as Array<{ id: string }>
  return rows.map((row) => getIdeaCluster(db, row.id)).filter((cluster): cluster is IdeaClusterRow => cluster !== undefined)
}

export function deleteIdeaCluster(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM idea_clusters WHERE id = ?').run(id).changes > 0
}

export function listIdeaClustersForIdea(db: DatabaseSync, ideaId: string): IdeaClusterRow[] {
  const rows = db.prepare('SELECT cluster_id FROM idea_links WHERE idea_id = ?').all(ideaId) as unknown as Array<{ cluster_id: string }>
  return rows.map((row) => getIdeaCluster(db, row.cluster_id)).filter((cluster): cluster is IdeaClusterRow => cluster !== undefined)
}

export function confirmIdeaClusterDraft(db: DatabaseSync, draftId: string, actor = 'user', at = nowIso()): IdeaClusterRow[] {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'idea_cluster') return []
  const clusters = Array.isArray(draft.payload.clusters) ? draft.payload.clusters as Array<{
    title?: string; summary?: string; idea_ids?: string[]; notes?: Record<string, string>
  }> : []
  if (clusters.length === 0) throw new Error('idea_cluster draft requires at least one cluster')
  return withDraftConfirm(db, draftId, 'idea_cluster', (): IdeaClusterRow[] => {
    const created: IdeaClusterRow[] = []
    for (const cluster of clusters) {
      const title = typeof cluster.title === 'string' && cluster.title.trim() !== '' ? cluster.title.trim() : '未命名点子王'
      const ideaIds = Array.isArray(cluster.idea_ids) ? cluster.idea_ids.filter((id): id is string => typeof id === 'string') : []
      if (ideaIds.length === 0) throw new Error(`点子王「${title}」没有关联点子`)
      const clusterId = insertIdeaCluster(db, {
        title,
        summaryMd: typeof cluster.summary === 'string' ? cluster.summary : '',
        tags: [],
        ideaIds,
        notes: cluster.notes ?? {},
      }, at)
      created.push(getIdeaCluster(db, clusterId)!)
    }
    return created
  }, { at, emptyValue: [] })
}

export function confirmIdeaTaskDraft(db: DatabaseSync, draftId: string, actor = 'user', at = nowIso()): TaskRow[] {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'idea_tasks') return []
  const tasks = Array.isArray(draft.payload.tasks) ? draft.payload.tasks as DraftTaskItem[] : []
  if (tasks.length === 0) throw new Error('idea_tasks draft requires at least one task')
  const sourceIdeaIds = Array.isArray(draft.payload.sourceIdeaIds) ? draft.payload.sourceIdeaIds.filter((id): id is string => typeof id === 'string') : []
  const sourceClusterId = typeof draft.payload.sourceClusterId === 'string' ? draft.payload.sourceClusterId : null
  return withDraftConfirm(db, draftId, 'idea_tasks', (): TaskRow[] => {
    const created: TaskRow[] = []
    const validCode = (kind: string, code: string | undefined, fallback: string): string => {
      if (code !== undefined && getDictionary(db, kind, code)?.active === 1) return code
      // AI 常见同义 code 归一化；其余未知 code 一律回退到安全默认值。
      const aliases: Record<string, string> = { life: 'personal', living: 'personal', home: 'personal', work: 'project_delivery', code: 'code_impl' }
      const candidate = aliases[code ?? ''] ?? fallback
      return getDictionary(db, kind, candidate)?.active === 1 ? candidate : fallback
    }
    const walk = (items: DraftTaskItem[], parentId: string | null): void => {
      for (const item of items) {
        const normalized = toTaskInputFromDraftItem(item, { typeCode: 'personal', priorityCode: 'p2', extra: { sourceIdeaIds, sourceClusterId, source: 'idea' } })
        if (normalized === undefined) continue
        const { input } = normalized
        const typeCode = validCode('type', input.typeCode, 'personal')
        const priorityCode = validCode('priority', input.priorityCode, 'p2')
        const task = createTask(db, {
          ...input,
          typeCode,
          priorityCode,
          aiPolicyCode: validCode('ai_policy', input.aiPolicyCode, 'consult'),
          parentId,
          extra: { sourceIdeaIds, sourceClusterId, source: 'idea' },
        }, actor, at)
        created.push(task)
        if (Array.isArray(item.children)) walk(item.children as DraftTaskItem[], task.id)
      }
    }
    walk(tasks, null)
    if (created.length === 0) throw new Error('idea_tasks draft contains no valid tasks')
    return created
  }, { at, emptyValue: [] })
}

export function getPendingDraftForSession(db: DatabaseSync, sessionId: string | null, kindCode: string): DraftRow | undefined {
  if (sessionId === null || sessionId === undefined) return undefined
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND kind_code = ? ORDER BY created_at DESC").all(kindCode) as unknown as Array<{
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
  return undefined
}
