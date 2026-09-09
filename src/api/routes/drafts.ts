/**
 * 草稿域路由（查询 / 确认 / 放弃 / 复盘 / 完成申请）
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { abandonDraft, addTaskMemory, appendEvent, completeTaskCascade, confirmDailyPlanDraft, confirmIdeaClusterDraft, confirmIdeaTaskDraft, confirmKnowledgeDraft, confirmReportDraft, confirmSubtaskPlanDraft, confirmTaskDraft, createDraft, createTaskReview, deferDraft, getDictionary, getDraft, getDraftBySession, getLatestActiveDraft, getTask, isDeferrableDraftKind, linkTaskSession, listDeferredDrafts, resumeDraft, updateTaskWithCompletion } from '../../db/repo.js'
import { DRAFTS_PREFIX, isLoopbackRequest, pathSegments, publicTask, readJsonBody, writeJson } from './helpers.js'

/** 草稿 → 任务的事件与记忆：确认/驳回/暂存三类动作都要留痕（AI 后续会话据此知道发生了什么）。 */
function taskIdOf(draft: { payload: Record<string, unknown> }): string | undefined {
  return typeof draft.payload.taskId === 'string' && draft.payload.taskId !== '' ? draft.payload.taskId : undefined
}

function recordDraftFeedback(
  db: DatabaseSync,
  draft: { id: string; kindCode: string; payload: Record<string, unknown>; sessionId: string | null; deferCount?: number },
  action: 'rejected' | 'deferred',
  note: string,
  at: string,
): void {
  const taskId = taskIdOf(draft)
  if (taskId === undefined || getTask(db, taskId) === undefined) return
  appendEvent(db, taskId, `completion_${action}`, {
    actor: 'user',
    note: `draft:${draft.id}${note === '' ? '' : ` | ${note}`}`,
    after: { draftId: draft.id, kindCode: draft.kindCode, deferCount: draft.deferCount ?? 0 },
    at,
  })
  const label = action === 'rejected' ? '驳回' : '暂存'
  const content = note === ''
    ? `【验收${label}】用户于 ${at} ${label}了 AI 提交的完成验收申请（草稿 ${draft.id}），未填写原因。继续修改后再次提交前，请先确认用户关心的问题。`
    : `【验收${label}】用户于 ${at} ${label}了 AI 提交的完成验收申请（草稿 ${draft.id}）。用户反馈：${note}`
  addTaskMemory(db, { taskId, kind: action === 'rejected' ? 'note' : 'context', content, sourceSessionId: draft.sessionId })
}

export function makeDraftRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: DRAFTS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, DRAFTS_PREFIX)
        const method = req.method ?? 'GET'
        const body = method === 'POST' ? await readJsonBody(req) : undefined

        if (segments.length === 0) {
          if (method === 'GET') {
            const sessionId = url.searchParams.get('session_id') ?? undefined
            // 自动弹窗只取"未暂存"的最新草稿；暂存清单单独返回，供「待处理」弹窗的「已暂存」段使用。
            if (sessionId === undefined) return writeJson(res, 200, { ok: true, draft: getLatestActiveDraft(db) ?? null, deferredDrafts: listDeferredDrafts(db) })
            const draft = getDraftBySession(db, sessionId)
            return writeJson(res, 200, { ok: true, draft: draft ?? null })
          }
          if (method === 'POST') {
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            const kindCode = typeof body.kindCode === 'string' ? body.kindCode : 'task'
            if (getDictionary(db, 'draft_kind', kindCode) === undefined) return writeJson(res, 400, { error: `unknown draft_kind "${kindCode}"` })
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
            const payload = typeof body.payload === 'object' && body.payload !== null ? body.payload as Record<string, unknown> : {}
            return writeJson(res, 201, { ok: true, draft: createDraft(db, { kindCode, sessionId, payload }) })
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        }

        const id = segments[0]
        const action = segments[1]
        if (method === 'GET' && action === undefined) {
          const draft = getDraft(db, id)
          return writeJson(res, draft === undefined ? 404 : 200, draft === undefined ? { error: 'draft not found' } : { ok: true, draft })
        }
        if (method === 'POST' && action === 'confirm') {
          try {
            const draft = getDraft(db, id)
            if (draft === undefined) return writeJson(res, 404, { error: 'draft not found' })
            if (draft.kindCode === 'task') return writeJson(res, 200, { ok: true, task: publicTask(confirmTaskDraft(db, id)!) })
            if (draft.kindCode === 'subtask_plan') return writeJson(res, 200, { ok: true, tasks: confirmSubtaskPlanDraft(db, id).map(publicTask) })
            if (draft.kindCode === 'daily_plan') {
              return writeJson(res, 200, { ok: true, plan: confirmDailyPlanDraft(db, id) })
            }
            if (draft.kindCode === 'report') {
              return writeJson(res, 200, { ok: true, report: confirmReportDraft(db, id) })
            }
            if (draft.kindCode === 'knowledge') {
              return writeJson(res, 200, { ok: true, knowledge: confirmKnowledgeDraft(db, id) })
            }
            if (draft.kindCode === 'idea_cluster') {
              return writeJson(res, 200, { ok: true, clusters: confirmIdeaClusterDraft(db, id) })
            }
            if (draft.kindCode === 'idea_tasks') {
              return writeJson(res, 200, { ok: true, tasks: confirmIdeaTaskDraft(db, id).map(publicTask) })
            }
            if (draft.kindCode === 'review') {
              const taskId = typeof draft.payload.taskId === 'string' ? draft.payload.taskId : undefined
              const summaryMd = typeof draft.payload.summaryMd === 'string' ? draft.payload.summaryMd : ''
              if (taskId === undefined || getTask(db, taskId) === undefined) return writeJson(res, 404, { error: 'task not found' })
              const sessionId = typeof draft.payload.sessionId === 'string' ? draft.payload.sessionId : null
              const reviewId = createTaskReview(db, { taskId, sessionId, summaryMd, lessonsJson: draft.payload.lessons ?? [] })
              const now = new Date().toISOString()
              db.prepare('UPDATE task_drafts SET status_code = ?, updated_at = ? WHERE id = ?').run('confirmed', now, id)
              return writeJson(res, 200, { ok: true, reviewId })
            }
            if (draft.kindCode === 'completion') {
              const taskId = typeof draft.payload.taskId === 'string' ? draft.payload.taskId : undefined
              if (taskId === undefined) return writeJson(res, 400, { error: 'completion draft requires taskId' })
              const task = getTask(db, taskId)
              if (task === undefined) return writeJson(res, 404, { error: 'task not found' })
              const sessionId = typeof draft.payload.sessionId === 'string' ? draft.payload.sessionId : null
              const completedTask = completeTaskCascade(db, taskId, 'user')
              if (sessionId !== null) linkTaskSession(db, { taskId, sessionId, roleCode: 'execute' })
              const summary = typeof draft.payload.summary === 'string' ? draft.payload.summary.trim() : ''
              if (summary !== '') {
                addTaskMemory(db, { taskId, kind: 'summary', content: summary, sourceSessionId: sessionId })
              }
              const now = new Date().toISOString()
              db.prepare('UPDATE task_drafts SET status_code = ?, updated_at = ? WHERE id = ?').run('confirmed', now, id)
              return writeJson(res, 200, { ok: true, task: publicTask(completedTask ?? getTask(db, taskId)!) })
            }
            return writeJson(res, 400, { error: `unknown draft kind ${draft.kindCode}` })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (method === 'POST' && action === 'abandon') {
          const draft = getDraft(db, id)
          if (draft === undefined) return writeJson(res, 404, { error: 'draft not found' })
          if (draft.statusCode !== 'pending') return writeJson(res, 400, { error: `draft is already ${draft.statusCode}` })
          const now = new Date().toISOString()
          abandonDraft(db, id)
          // 驳回留痕：写任务事件 + 任务共享记忆，让执行会话知道自己被驳回以及原因。
          if (draft.kindCode === 'completion') {
            const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
            recordDraftFeedback(db, draft, 'rejected', reason, now)
          }
          return writeJson(res, 200, { ok: true })
        }
        if (method === 'POST' && action === 'defer') {
          const draft = getDraft(db, id)
          if (draft === undefined) return writeJson(res, 404, { error: 'draft not found' })
          if (draft.statusCode !== 'pending') return writeJson(res, 400, { error: `draft is already ${draft.statusCode}` })
          if (!isDeferrableDraftKind(draft.kindCode)) return writeJson(res, 400, { error: `draft kind "${draft.kindCode}" cannot be deferred` })
          const now = new Date().toISOString()
          const deferred = deferDraft(db, id, now)
          if (deferred === undefined) return writeJson(res, 400, { error: 'defer failed' })
          if (draft.kindCode === 'completion') {
            const note = typeof body?.note === 'string' ? body.note.trim() : ''
            recordDraftFeedback(db, deferred, 'deferred', note, now)
          }
          return writeJson(res, 200, { ok: true, draft: deferred })
        }
        if (method === 'POST' && action === 'resume') {
          const resumed = resumeDraft(db, id)
          if (resumed === undefined) return writeJson(res, 404, { error: 'draft not found or not pending' })
          return writeJson(res, 200, { ok: true, draft: resumed })
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}
