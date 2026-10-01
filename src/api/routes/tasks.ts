/**
 * 任务域路由（列表 / 详情 / 增改 / 归档恢复 / 提醒 / 事件 / 复盘）。
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import {
  addReminder, addTaskMemory, archiveTask, completeTaskCascade, createTask, createTaskReview, ensureRecurringInstances,
  getDictionary, getTask, getTaskMemoryContext, getTaskRootId, getTaskPendingCompletion, linkTaskSession, listArchivedTasks, listChildren, listPendingCompletions, listReminders, listTaskEvents,
  listTaskMemories, listTaskReviews, listTaskSessions, listTasks, repairParentCompletion, restoreTask, updateTask, updateTaskWithCompletion,
} from '../../db/repo.js'
import { checkProgressInput } from '../../shared/taskProgress.js'
import { TASKS_PREFIX, clampEstimateForStorage, defaultRecurrenceRule, isLoopbackRequest, pathSegments, publicTask, readJsonBody, requireCode, taskInputFromBody, todayRange, writeJson } from './helpers.js'

export function makeTaskRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: TASKS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, TASKS_PREFIX)
        const method = req.method ?? 'GET'
        const body = ['POST', 'PATCH'].includes(method) ? await readJsonBody(req) : undefined

        if (segments.length === 0) {
          if (method === 'GET') {
            ensureRecurringInstances(db)
            const parentId = url.searchParams.get('parent_id') ?? undefined
            const archivedOnly = url.searchParams.get('archived') === 'true'
            const tasks = archivedOnly ? listArchivedTasks(db) : listTasks(db, { parentId })
            return writeJson(res, 200, { ok: true, tasks: tasks.map(publicTask), archivedOnly })
          }
          if (method === 'POST') {
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            try {
              const input = taskInputFromBody(body)
              if (input.title.trim() === '') throw new Error('title is required')
              requireCode(db, 'type', input.typeCode, 'typeCode')
              requireCode(db, 'priority', input.priorityCode, 'priorityCode')
              if (input.statusCode !== undefined) requireCode(db, 'status', input.statusCode, 'statusCode')
              if (input.aiPolicyCode !== undefined) requireCode(db, 'ai_policy', input.aiPolicyCode, 'aiPolicyCode')
              if (input.recurrenceCode !== undefined && input.recurrenceCode !== null && input.recurrenceCode !== 'none') requireCode(db, 'recurrence', input.recurrenceCode, 'recurrenceCode')
              const task = createTask(db, input)
              // 直接建任务时按「类型默认 → 优先级默认」补提醒：否则这里建出来的任务永不提醒。
              if (task.dueAt !== null) {
                const typeDefault = getDictionary(db, 'type', task.typeCode)?.config.defaultReminderMinutes
                const priorityDefault = getDictionary(db, 'priority', task.priorityCode)?.config.defaultReminderMinutes
                const offset = typeof typeDefault === 'number' ? typeDefault : typeof priorityDefault === 'number' ? priorityDefault : undefined
                if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) addReminder(db, task.id, offset, 'browser')
              }
              ensureRecurringInstances(db)
              return writeJson(res, 201, { ok: true, task: publicTask(task) })
            } catch (error) {
              return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        }

        const id = segments[0]
        const action = segments[1]
        /**
         * 「待验收」投影（requirements §3.2）：**列表刷新共用一次**查询，
         * 绝不逐行发请求查草稿。旧服务端没有这个端点时前端不显示徽标（不推测）。
         *
         * 判据写成 `id === 'pending-completions' && action === undefined`（而不是
         * `action === 'pending-completions'`）：这个端点只有**一段**路径，
         * 判据必须与 URL 形状一致，否则将来谁在这个位置加一段路径就会静默落到
         * 任务详情分支去（那次我确实是靠"端点 404"才发现的，不该再犯第二次）。
         */
        if (method === 'GET' && id === 'pending-completions' && action === undefined) {
          return writeJson(res, 200, { ok: true, pending: listPendingCompletions(db) })
        }
        if (method === 'GET' && action === undefined) {
          ensureRecurringInstances(db)
          const task = getTask(db, id)
          if (task === undefined) return writeJson(res, 404, { error: 'task not found' })
          /**
           * 详情页的待验收投影（列表用 `GET /tasks/pending-completions` 一次取全量）。
           * 没有 pending completion 草稿时**不带这个字段**，前端按"没有待验收"处理。
           */
          const pending = getTaskPendingCompletion(db, id)
          return writeJson(res, 200, {
            ok: true,
            task: publicTask(task),
            children: listChildren(db, id).map(publicTask),
            sessions: listTaskSessions(db, id),
            reminders: listReminders(db, id),
            ...(pending === undefined ? {} : { pendingCompletion: { deferred: pending.deferred } }),
          })
        }
        if (method === 'PATCH' && action === undefined) {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          try {
            const patch: Parameters<typeof updateTask>[2] = {}
            if (typeof body.title === 'string') patch.title = body.title
            if (typeof body.description === 'string') patch.description = body.description
            if (typeof body.typeCode === 'string') { requireCode(db, 'type', body.typeCode, 'typeCode'); patch.typeCode = body.typeCode }
            if (typeof body.statusCode === 'string') { requireCode(db, 'status', body.statusCode, 'statusCode'); patch.statusCode = body.statusCode }
            if (typeof body.priorityCode === 'string') { requireCode(db, 'priority', body.priorityCode, 'priorityCode'); patch.priorityCode = body.priorityCode }
            if (typeof body.aiPolicyCode === 'string') { requireCode(db, 'ai_policy', body.aiPolicyCode, 'aiPolicyCode'); patch.aiPolicyCode = body.aiPolicyCode }
            if (typeof body.recurrenceCode === 'string') {
              if (body.recurrenceCode !== 'none') requireCode(db, 'recurrence', body.recurrenceCode, 'recurrenceCode')
              const current = getTask(db, id)
              if (current?.recurrenceMasterId !== null && current?.recurrenceMasterId !== undefined) {
                return writeJson(res, 400, { error: 'recurrence can only be edited on the template task' })
              }
              patch.recurrenceCode = body.recurrenceCode
              if (typeof body.recurrenceRule === 'object' && body.recurrenceRule !== null) {
                patch.recurrenceRule = body.recurrenceRule as Record<string, unknown>
              } else if (body.recurrenceCode === 'none') {
                patch.recurrenceRule = {}
              } else if (current?.recurrenceCode === null || current?.recurrenceCode === undefined || current.recurrenceCode === 'none') {
                patch.recurrenceRule = defaultRecurrenceRule(body.recurrenceCode, current?.dueAt)
              }
            }
            if ('dueAt' in body) patch.dueAt = typeof body.dueAt === 'string' ? body.dueAt : null
            if (body.allDay === true || body.allDay === false) patch.allDay = body.allDay
            if ('estimatedMinutes' in body) patch.estimatedMinutes = clampEstimateForStorage(body.estimatedMinutes)
            if (body.archived === true || body.archived === false) patch.archived = body.archived
            if ('workspacePath' in body) patch.workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath : null
            // 改父任务：string = 挂到该父任务下；null / 空串 = 移到顶层。
            // 存在性、归档与防环校验都在仓储层（updateTask），抛出的中文原因由下面的 catch 统一转 400。
            if ('parentId' in body) {
              const rawParentId = body.parentId
              if (rawParentId === null || rawParentId === undefined) patch.parentId = null
              else if (typeof rawParentId === 'string') patch.parentId = rawParentId.trim() === '' ? null : rawParentId
              else return writeJson(res, 400, { error: 'parentId 必须是任务 id 字符串或 null（null 表示移到顶层）' })
            }
            if (typeof body.extra === 'object' && body.extra !== null) patch.extra = body.extra as Record<string, unknown>
            /**
             * 进度（S4 / AX-P05）：`PATCH /api/workbench/tasks/:id` 新增 `progressPercent`（0–99）。
             *
             * 三条与工具侧**刻意不同**的边界：
             * 1. `100` 在普通 PATCH 里**拒绝** —— 100 不是可存储的进度，界面选择 100 时显式调用
             *    现有完成任务动作（`statusCode: 'done'`）并展示同等的级联确认提示，库里永远不出现 100；
             * 2. **原子**：先校验完再写。非法进度时其余字段（标题/状态/截止…）**一个都不生效** ——
             *    "多字段 PATCH 只写了一半"是比报错更糟的结果；
             * 3. 已完成/已取消/已归档的任务拒绝更新进度（与 `setTaskProgress` 同口径），
             *    但**不拦"同一次 PATCH 里顺手完成任务"**（即 patch 把状态改成 done 的时候）。
             */
            const pendingStatus = typeof patch.statusCode === 'string' ? patch.statusCode : undefined
            if (pendingStatus !== 'done' && pendingStatus !== 'cancelled' && 'progressPercent' in body) {
              const checked = checkProgressInput(body.progressPercent)
              if (!checked.ok) return writeJson(res, 400, { error: checked.reason })
              const current = getTask(db, id)
              if (current === undefined) return writeJson(res, 404, { error: 'task not found' })
              if (current.archived === 1) return writeJson(res, 400, { error: `任务「${current.title}」已归档，不能更新进度` })
              if (current.statusCode === 'done' || current.statusCode === 'cancelled') {
                return writeJson(res, 400, { error: `任务「${current.title}」已是${current.statusCode === 'done' ? '已完成' : '已取消'}状态，不能更新进度（重新打开任务后才能改）` })
              }
              patch.progressPercent = checked.value
            }
            // 新语义：任意节点直接完成时，在同一事务内级联完成未完成子节点，并向上递归聚合父节点。
            const task = updateTaskWithCompletion(db, id, patch)
            if (task === undefined) return writeJson(res, 404, { error: 'task not found' })
            // 改/设截止时间时，若该任务还没有生效中的提醒，按默认提前量补一条。
            if ('dueAt' in body && task.dueAt !== null) {
              const active = listReminders(db, id).filter((r) => r.enabled === 1 && r.firedAt === null && r.skippedAt === null && r.acknowledgedAt === null)
              if (active.length === 0) {
                const typeDefault = getDictionary(db, 'type', task.typeCode)?.config.defaultReminderMinutes
                const priorityDefault = getDictionary(db, 'priority', task.priorityCode)?.config.defaultReminderMinutes
                const offset = typeof typeDefault === 'number' ? typeDefault : typeof priorityDefault === 'number' ? priorityDefault : undefined
                if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) addReminder(db, id, offset, 'browser')
              }
            }
            if (patch.recurrenceCode !== undefined || patch.recurrenceRule !== undefined) ensureRecurringInstances(db)
            return writeJson(res, 200, { ok: true, task: publicTask(task) })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (method === 'POST' && action === 'archive') {
          try {
            const cascade = body?.cascade === true
            const task = archiveTask(db, id, 'user', { cascade })
            if (task === undefined) return writeJson(res, 404, { error: 'task not found' })
            return writeJson(res, 200, { ok: true, task: publicTask(task), cascade })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (method === 'POST' && action === 'restore') {
          try {
            const task = restoreTask(db, id)
            if (task === undefined) return writeJson(res, 404, { error: 'task not found' })
            return writeJson(res, 200, { ok: true, task: publicTask(task) })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (method === 'GET' && action === 'events') {
          if (getTask(db, id) === undefined) return writeJson(res, 404, { error: 'task not found' })
          return writeJson(res, 200, { ok: true, events: listTaskEvents(db, id) })
        }
        if (method === 'GET' && action === 'reviews') {
          if (getTask(db, id) === undefined) return writeJson(res, 404, { error: 'task not found' })
          return writeJson(res, 200, { ok: true, reviews: listTaskReviews(db, id) })
        }
        if (method === 'GET' && action === 'memories') {
          if (getTask(db, id) === undefined) return writeJson(res, 404, { error: 'task not found' })
          const rootTaskId = getTaskRootId(db, id)
          return writeJson(res, 200, { ok: true, memories: rootTaskId === undefined ? [] : listTaskMemories(db, { rootTaskId }) })
        }
        if (method === 'GET' && action === 'memory-context') {
          if (getTask(db, id) === undefined) return writeJson(res, 404, { error: 'task not found' })
          return writeJson(res, 200, { ok: true, context: getTaskMemoryContext(db, id) })
        }
        if (method === 'POST' && action === 'memories') {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          if (getTask(db, id) === undefined) return writeJson(res, 404, { error: 'task not found' })
          const content = typeof body.content === 'string' ? body.content.trim() : ''
          if (content === '') return writeJson(res, 400, { error: 'content is required' })
          const kind = typeof body.kind === 'string' && body.kind.trim() !== '' ? body.kind.trim() : 'note'
          const sourceSessionId = typeof body.sourceSessionId === 'string' ? body.sourceSessionId : null
          try {
            const memory = addTaskMemory(db, { taskId: id, kind, content, sourceSessionId })
            return writeJson(res, 201, { ok: true, memory })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (method === 'POST' && action === 'sessions') {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
          const roleCode = typeof body.roleCode === 'string' ? body.roleCode : 'consult'
          if (sessionId === undefined || sessionId.trim() === '') return writeJson(res, 400, { error: 'sessionId is required' })
          requireCode(db, 'session_role', roleCode, 'roleCode')
          if (getTask(db, id) === undefined) return writeJson(res, 404, { error: 'task not found' })
          linkTaskSession(db, {
            taskId: id,
            sessionId,
            roleCode,
            workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
            note: typeof body.note === 'string' ? body.note : undefined,
          })
          return writeJson(res, 201, { ok: true })
        }
        if (method === 'POST' && action === 'reminders') {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const offset = typeof body.offsetMinutes === 'number' ? body.offsetMinutes : null
          if (offset === null || offset < 0) return writeJson(res, 400, { error: 'offsetMinutes must be a non-negative number' })
          const methodCode = typeof body.methodCode === 'string' ? body.methodCode : 'browser'
          requireCode(db, 'reminder_method', methodCode, 'methodCode')
          if (getTask(db, id) === undefined) return writeJson(res, 404, { error: 'task not found' })
          return writeJson(res, 201, { ok: true, reminderId: addReminder(db, id, offset, methodCode) })
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}
