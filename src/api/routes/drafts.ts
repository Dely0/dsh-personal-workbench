/**
 * 草稿域路由（查询 / 确认 / 放弃 / 复盘 / 完成申请）
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { abandonDraft, addTaskMemory, appendEvent, completeTaskCascade, confirmDailyPlanDraft, confirmIdeaClusterDraft, confirmIdeaTaskDraft, confirmKnowledgeDraft, confirmReportDraft, confirmSubtaskPlanDraft, confirmTaskDraft, createDraft, createTaskReview, deferDraft, getDictionary, getDraft, getDraftBySession, getLatestActiveDraft, getTask, isDeferrableDraftKind, linkTaskSession, listDeferredDrafts, resumeDraft, updateDraft, updateTaskWithCompletion } from '../../db/repo.js'
import { DRAFTS_PREFIX, isLoopbackRequest, pathSegments, publicTask, readJsonBody, writeJson } from './helpers.js'
import { writeReviewToTeamMemory, type TeamMemoryService } from '../../review-memory.js'

/** 草稿关联的任务 id（验收 / 复盘 / 拆解类草稿会带；任务类草稿确认后才存在）。 */
function taskIdOf(draft: { payload: Record<string, unknown> }): string | undefined {
  return typeof draft.payload.taskId === 'string' && draft.payload.taskId !== '' ? draft.payload.taskId : undefined
}

/**
 * 草稿被用户「暂存 / 驳回」时的留痕：写 task_events + 任务共享记忆，
 * 让后续（尤其是提交草稿的那个）会话知道自己的产出被暂存/驳回过、暂存了几次。
 *
 * 文案通用化：v1.12.0 只给验收类写留痕，措辞也写死"验收"。现在所有草稿类型都能暂存，
 * 再用"验收"就会误导（比如一份日报草稿的留痕写着"验收暂存"）。
 * `eventCode` 仍按是否验收类分流，便于界面上区分图标与措辞。
 */
function recordDraftFeedback(
  db: DatabaseSync,
  draft: { id: string; kindCode: string; payload: Record<string, unknown>; sessionId: string | null; deferCount?: number },
  action: 'rejected' | 'deferred',
  note: string,
  at: string,
): void {
  const taskId = taskIdOf(draft)
  if (taskId === undefined || getTask(db, taskId) === undefined) return
  const isCompletion = draft.kindCode === 'completion'
  const eventCode = `${isCompletion ? 'completion' : 'draft'}_${action}`
  appendEvent(db, taskId, eventCode, {
    actor: 'user',
    note: `draft:${draft.id}${note === '' ? '' : ` | ${note}`}`,
    after: { draftId: draft.id, kindCode: draft.kindCode, deferCount: draft.deferCount ?? 0 },
    at,
  })
  const label = action === 'rejected' ? '驳回' : '暂存'
  const what = isCompletion ? 'AI 提交的完成验收申请' : `AI 提交的「${draft.kindCode}」草稿`
  const content = note === ''
    ? `【草稿${label}】用户于 ${at} ${label}了${what}（草稿 ${draft.id}），未填写原因。若要重新提交，请先确认用户关心的问题。`
    : `【草稿${label}】用户于 ${at} ${label}了${what}（草稿 ${draft.id}）。用户反馈：${note}`
  addTaskMemory(db, { taskId, kind: action === 'rejected' ? 'note' : 'context', content, sourceSessionId: draft.sessionId })
}

export function makeDraftRoutes(db: DatabaseSync, deps: { teamMemory?: TeamMemoryService } = {}): WebRoute[] {
  const teamMemory = deps.teamMemory
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
            /**
             * 确认是**幂等**的（2026-09-13 真实事故的修法）。
             *
             * 已经 confirmed 过的草稿再 POST 一次，历史行为是**当成新的一次确认重新执行**
             * —— 同一条 task 草稿被点两次就建出两条同名任务（实测复现：见
             * `node scripts/repro/repro-routes.mjs`）。
             *
             * 现在分两种处理：
             * - `task` 草稿：回放当次建出来的任务（用户想要的"东西已经建好了"依然成立），
             *   响应里带 `replayed`，界面据此提示"这条已经确认过了"；
             * - 其余类型：明确 400，让调用方知道这次点击没有产生任何新东西。
             */
            if (draft.kindCode === 'task') {
              // `intent=dedupe`：用户在看到「已有同名任务」告警后，选择"就复用那一条"。
              const intent = body?.intent === 'dedupe' ? 'dedupe' : 'create'
              const result = confirmTaskDraft(db, id, 'user', new Date().toISOString(), intent)
              /**
               * `undefined` 有两种含义，**不能一律当 404**：
               * - 草稿真的不在了 → 404（并发删除）；
               * - 草稿还在，但不是 pending 且没有可回放的产出（例如已被「放弃」）→ 400。
               *   报 404 会让用户以为草稿丢了，实际它好好躺在「待处理」里。
               */
              if (result === undefined) {
                const current = getDraft(db, id)
                if (current === undefined) return writeJson(res, 404, { error: 'draft not found' })
                return writeJson(res, 400, { error: `draft is already ${current.statusCode}` })
              }
              // problems 必须回传：界面据此标黄列出「哪几项没建、为什么」，
              // 否则就是 2026-09-12 那次「确认成功但子任务凭空少了两个」的重演。
              return writeJson(res, 200, {
                ok: true,
                task: publicTask(result.task),
                created: result.childCount + 1,
                problems: result.problems,
                ...(result.replayed === true ? { replayed: true } : {}),
                ...(result.reused === true ? { reused: true } : {}),
                ...(result.duplicateOf === undefined ? {} : {
                  duplicateOf: {
                    id: result.duplicateOf.task.id,
                    title: result.duplicateOf.task.title,
                    statusCode: result.duplicateOf.task.statusCode,
                    createdAt: result.duplicateOf.task.createdAt,
                    sameDescription: result.duplicateOf.sameDescription,
                    sameWorkspace: result.duplicateOf.sameWorkspace,
                  },
                }),
              })
            }
            if (draft.statusCode !== 'pending') {
              return writeJson(res, 400, { error: `draft is already ${draft.statusCode}` })
            }
            if (draft.kindCode === 'subtask_plan') {
              const result = confirmSubtaskPlanDraft(db, id)
              return writeJson(res, 200, {
                ok: true,
                tasks: result.tasks.map(publicTask),
                created: result.tasks.length,
                problems: result.problems,
              })
            }
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
              /**
               * **幂等**（v1.14.0 修，对齐验收标准「重复确认同一条复盘不产生重复记忆」）。
               *
               * 曾经每次确认都 `createTaskReview()` 生成一个**新的** reviewId ——
               * 而记忆写入的去重键就是这个 reviewId，于是"幂等"形同虚设：
               * 重复确认把同一条复盘又写成一条记忆（实测 notes 41→43）。
               *
               * 现在把首次生成的 reviewId 记回草稿 payload：重复确认复用同一个 review，
               * `writeReviewToTeamMemory` 的 `review_memory_written` 记录随即命中 → 不再重写。
               * 存 payload 而不是加列：不需要 schema 变更（schema 只单向前进）。
               */
              const existingReviewId = typeof draft.payload.reviewId === 'string' ? draft.payload.reviewId : null
              const reviewId = existingReviewId ?? createTaskReview(db, { taskId, sessionId, summaryMd, lessonsJson: draft.payload.lessons ?? [] })
              if (existingReviewId === null) {
                updateDraft(db, id, { ...draft.payload, reviewId })
              }
              const now = new Date().toISOString()
              db.prepare('UPDATE task_drafts SET status_code = ?, updated_at = ? WHERE id = ?').run('confirmed', now, id)
              /**
               * v1.14.0：复盘确认时**顺带**把结论写进团队记忆库（否则复盘只活在本机）。
               *
               * 三条硬约束：
               * 1. 可见性默认 `private`（复盘可能含客户信息），由确认弹窗传 `memoryScope` 覆盖；
               * 2. `memoryEnabled === false`（用户在弹窗里取消勾选）→ 一个字节都不写；
               * 3. **写失败绝不让复盘确认失败** —— 复盘已经进本地库了，这是"额外的沉淀"，
               *    不是前置条件；失败只回一条 degradedReason 给界面显示。
               */
              const memory = await writeReviewToTeamMemory(db, reviewId, {
                enabled: body?.memoryEnabled !== false,
                scope: body?.memoryScope === 'team' ? 'team' : 'private',
                service: teamMemory,
              })
              return writeJson(res, 200, { ok: true, reviewId, memory })
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
          // 驳回留痕：所有带 taskId 的草稿都写任务事件 + 共享记忆（原来只写 completion）。
          const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
          recordDraftFeedback(db, draft, 'rejected', reason, now)
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
          // 暂存留痕：所有带 taskId 的草稿都写（原来只写 completion）——
          // AI 后续会话要据此知道自己被暂存过、暂存了几次。
          const note = typeof body?.note === 'string' ? body.note.trim() : ''
          recordDraftFeedback(db, deferred, 'deferred', note, now)
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
