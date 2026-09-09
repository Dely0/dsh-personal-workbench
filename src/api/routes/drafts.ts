/**
 * 草稿域路由（查询 / 确认 / 放弃 / 复盘 / 完成申请）
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { abandonDraft, addTaskMemory, completeTaskCascade, confirmDailyPlanDraft, confirmIdeaClusterDraft, confirmIdeaTaskDraft, confirmKnowledgeDraft, confirmReportDraft, confirmSubtaskPlanDraft, confirmTaskDraft, createDraft, createTaskReview, getDictionary, getDraft, getDraftBySession, getLatestPendingDraft, getTask, linkTaskSession, updateTaskWithCompletion } from '../../db/repo.js'
import { DRAFTS_PREFIX, isLoopbackRequest, pathSegments, publicTask, readJsonBody, writeJson } from './helpers.js'

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
            if (sessionId === undefined) return writeJson(res, 200, { ok: true, draft: getLatestPendingDraft(db) ?? null })
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
          abandonDraft(db, id)
          return writeJson(res, 200, { ok: true })
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}
