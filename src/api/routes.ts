/**
 * /api/workbench/* 路由。Loopback-only 保护（同 dsh-ssh 的信任围栏）。
 */
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import {
  abandonDraft, addReminder, archiveTask, confirmDailyPlanDraft, confirmSubtaskPlanDraft, confirmTaskDraft,
  createTaskReview,
  createDraft, createTask, deleteDailyPlan, fireReminder, getDailyPlan, getDictionary, getDraft, getDraftBySession,
  getLatestPendingDraft, getTask, linkTaskSession, listArchivedTasks, listChildren,
  listDictionaries, listDueReminders, listReminders, listTaskEvents, listTaskReviews,
  listTaskSessions, listTasks, localDateString, restoreTask, updateTask, type TaskInput,
} from '../db/repo.js'

const TASKS_PREFIX = '/api/workbench/tasks'
const DRAFTS_PREFIX = '/api/workbench/drafts'
const REMINDERS_PREFIX = '/api/workbench/reminders'
const PLANS_PREFIX = '/api/workbench/plans'

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let url: URL
  try { url = new URL(`http://${host}`) } catch { return false }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === url.host } catch { return false }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}

function pathSegments(url: URL, prefix: string): string[] {
  const rest = url.pathname.slice(prefix.length)
  return rest.split('/').filter((part) => part !== '')
}

function requireCode(db: DatabaseSync, kind: string, code: string, field: string): void {
  if (typeof code !== 'string' || code.trim() === '') throw new Error(`${field} is required`)
  const entry = getDictionary(db, kind, code)
  if (entry === undefined || entry.active === 0) throw new Error(`${field}: unknown or inactive ${kind} code "${code}"`)
}

function todayRange(now: Date): { start: string; end: string } {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

function publicTask(task: NonNullable<ReturnType<typeof getTask>>): Record<string, unknown> {
  return { ...task, allDay: task.allDay === 1 }
}

function taskInputFromBody(body: Record<string, unknown>): TaskInput {
  const str = (key: string): string | undefined => typeof body[key] === 'string' ? body[key] as string : undefined
  return {
    title: str('title') ?? '',
    description: str('description'),
    typeCode: str('typeCode') ?? '',
    statusCode: str('statusCode'),
    priorityCode: str('priorityCode') ?? 'p2',
    aiPolicyCode: str('aiPolicyCode'),
    dueAt: body.dueAt === null ? null : str('dueAt'),
    allDay: body.allDay === true,
    estimatedMinutes: typeof body.estimatedMinutes === 'number' ? body.estimatedMinutes : null,
    source: str('source'),
    parentId: body.parentId === null ? null : str('parentId'),
    workspacePath: body.workspacePath === null ? null : str('workspacePath'),
    extra: typeof body.extra === 'object' && body.extra !== null ? body.extra as Record<string, unknown> : undefined,
  }
}

export function makeRoutes(db: DatabaseSync): WebRoute[] {
  const metaGet = (key: string): string | undefined => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
  const metaSet = (key: string, value: string): void => {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
  }
  return [
    // ------------------------------------------------------------------ workspace ensure
    {
      kind: 'exact',
      path: '/api/workbench/workspaces/ensure',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const path = typeof body?.path === 'string' && body.path.trim() !== '' ? body.path.trim() : undefined
        if (path === undefined) return writeJson(res, 400, { error: 'path is required' })
        try {
          mkdirSync(path, { recursive: true })
          return writeJson(res, 200, { ok: true, path })
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------------ settings
    {
      kind: 'exact',
      path: '/api/workbench/settings',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          return writeJson(res, 200, {
            ok: true,
            settings: {
              defaultWorkspace: metaGet('ai_default_workspace') ?? '',
              autoCreateTypeFolders: (metaGet('auto_create_type_folders') ?? '1') === '1',
            },
          })
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          if (typeof body.defaultWorkspace === 'string') metaSet('ai_default_workspace', body.defaultWorkspace)
          if (body.autoCreateTypeFolders === true || body.autoCreateTypeFolders === false) metaSet('auto_create_type_folders', body.autoCreateTypeFolders ? '1' : '0')
          return writeJson(res, 200, { ok: true, settings: { defaultWorkspace: metaGet('ai_default_workspace') ?? '', autoCreateTypeFolders: (metaGet('auto_create_type_folders') ?? '1') === '1' } })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      },
    },
    // ------------------------------------------------------------------ bootstrap
    {
      kind: 'exact',
      path: '/api/workbench/bootstrap',
      handler(req, res) {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const now = new Date()
        const { start, end } = todayRange(now)
        const tasks = listTasks(db)
        const overdue = tasks.filter((task) =>
          task.statusCode !== 'done' && task.statusCode !== 'cancelled' && task.dueAt !== null && Date.parse(task.dueAt) < now.getTime())
        const todayDue = tasks.filter((task) =>
          task.statusCode !== 'done' && task.statusCode !== 'cancelled' && task.dueAt !== null &&
          Date.parse(task.dueAt) >= Date.parse(start) && Date.parse(task.dueAt) < Date.parse(end))
        const doing = tasks.filter((task) => task.statusCode === 'doing' || task.statusCode === 'blocked')
        const plan = getDailyPlan(db, localDateString(now))
        const planView = plan === undefined ? null : {
          ...plan,
          items: plan.items
            .map((item) => {
              const task = getTask(db, item.taskId)
              return task === undefined ? null : { taskId: item.taskId, order: item.order, title: task.title, note: item.note }
            })
            .filter((item): item is { taskId: string; order: number; title: string; note: string } => item !== null),
        }
        writeJson(res, 200, {
          ok: true,
          dictionaries: listDictionaries(db),
          stats: { overdue: overdue.length, todayDue: todayDue.length, doing: doing.length, total: tasks.length },
          todayPlan: planView,
          now: now.toISOString(),
        })
      },
    },
    // ------------------------------------------------------------------ tasks
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
              const task = createTask(db, input)
              return writeJson(res, 201, { ok: true, task: publicTask(task) })
            } catch (error) {
              return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        }

        const id = segments[0]
        const action = segments[1]
        if (method === 'GET' && action === undefined) {
          const task = getTask(db, id)
          if (task === undefined) return writeJson(res, 404, { error: 'task not found' })
          return writeJson(res, 200, {
            ok: true,
            task: publicTask(task),
            children: listChildren(db, id).map(publicTask),
            sessions: listTaskSessions(db, id),
            reminders: listReminders(db, id),
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
            if ('dueAt' in body) patch.dueAt = typeof body.dueAt === 'string' ? body.dueAt : null
            if (body.allDay === true || body.allDay === false) patch.allDay = body.allDay
            if ('estimatedMinutes' in body) patch.estimatedMinutes = typeof body.estimatedMinutes === 'number' ? body.estimatedMinutes : null
            if (body.archived === true || body.archived === false) patch.archived = body.archived
            if ('workspacePath' in body) patch.workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath : null
            if (typeof body.extra === 'object' && body.extra !== null) patch.extra = body.extra as Record<string, unknown>
            const task = updateTask(db, id, patch)
            if (task === undefined) return writeJson(res, 404, { error: 'task not found' })
            return writeJson(res, 200, { ok: true, task: publicTask(task) })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (method === 'POST' && action === 'archive') {
          const task = archiveTask(db, id)
          if (task === undefined) return writeJson(res, 404, { error: 'task not found' })
          return writeJson(res, 200, { ok: true, task: publicTask(task) })
        }
        if (method === 'POST' && action === 'restore') {
          const task = restoreTask(db, id)
          if (task === undefined) return writeJson(res, 404, { error: 'task not found' })
          return writeJson(res, 200, { ok: true, task: publicTask(task) })
        }
        if (method === 'GET' && action === 'events') {
          if (getTask(db, id) === undefined) return writeJson(res, 404, { error: 'task not found' })
          return writeJson(res, 200, { ok: true, events: listTaskEvents(db, id) })
        }
        if (method === 'GET' && action === 'reviews') {
          if (getTask(db, id) === undefined) return writeJson(res, 404, { error: 'task not found' })
          return writeJson(res, 200, { ok: true, reviews: listTaskReviews(db, id) })
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
    // ------------------------------------------------------------------ drafts
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
              updateTask(db, taskId, { statusCode: 'done' }, 'user')
              const sessionId = typeof draft.payload.sessionId === 'string' ? draft.payload.sessionId : null
              if (sessionId !== null) linkTaskSession(db, { taskId, sessionId, roleCode: 'execute' })
              const now = new Date().toISOString()
              db.prepare('UPDATE task_drafts SET status_code = ?, updated_at = ? WHERE id = ?').run('confirmed', now, id)
              return writeJson(res, 200, { ok: true, task: publicTask(getTask(db, taskId)!) })
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
    // ------------------------------------------------------------------ reminders
    {
      kind: 'prefix',
      path: REMINDERS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, REMINDERS_PREFIX)
        const method = req.method ?? 'GET'
        if (segments.length === 1 && segments[0] === 'due' && method === 'GET') {
          return writeJson(res, 200, { ok: true, reminders: listDueReminders(db) })
        }
        if (segments.length === 2 && segments[1] === 'fire' && method === 'POST') {
          fireReminder(db, segments[0])
          return writeJson(res, 200, { ok: true })
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
    // ------------------------------------------------------------------ plans
    {
      kind: 'prefix',
      path: PLANS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, PLANS_PREFIX)
        const method = req.method ?? 'GET'
        if (segments.length === 0 && method === 'GET') {
          const planDate = url.searchParams.get('date') ?? localDateString()
          const plan = getDailyPlan(db, planDate)
          return writeJson(res, 200, { ok: true, plan: plan ?? null })
        }
        if (segments.length === 1 && method === 'DELETE') {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(segments[0])) return writeJson(res, 400, { error: 'invalid plan date' })
          return writeJson(res, 200, { ok: true, deleted: deleteDailyPlan(db, segments[0]) })
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
    // ------------------------------------------------------------------ health
    {
      kind: 'exact',
      path: '/api/workbench/health',
      handler(_req, res) {
        if (!isLoopbackRequest(_req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
        writeJson(res, 200, {
          ok: true,
          name: 'dsh-workbench',
          version: '0.6.0',
          db: {
            schemaVersion: versionRow?.value ?? 'unknown',
            taskCount: listTasks(db, { includeArchived: true }).length,
            dictionaryCount: listDictionaries(db).length,
          },
        })
      },
    },
  ]
}
