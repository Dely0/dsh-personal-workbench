/**
 * /api/workbench/* 路由。Loopback-only 保护（同 dsh-ssh 的信任围栏）。
 */
import { mkdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import {
  abandonDraft, addReminder, addTaskMemory, archiveTask, assertValidFileLink, completeTaskCascade, confirmDailyPlanDraft, confirmIdeaClusterDraft, confirmIdeaTaskDraft, confirmKnowledgeDraft, confirmReportDraft, confirmSubtaskPlanDraft, confirmTaskDraft,
  createDictionaryEntry, createIdea, createIdeaCluster, createKnowledge, createTaskReview,
  createDraft, createTask, deleteDailyPlan, deleteDictionaryEntry, deleteIdea, deleteIdeaCluster, deleteKnowledge, deleteTaskReport, ensureRecurringInstances, fireReminder, getAiSession, getDailyPlan, getDictionary, getDraft, getDraftBySession,
  getIdea, getIdeaCluster, getKnowledge, getLatestPendingDraft, getTask, getTaskMemoryContext, getTaskReport, getTaskRootId, linkTaskSession, listArchivedTasks, listChildren,
  listDictionaries, listDueReminders, listIdeas, listIdeaClusters, listIdeaClustersForIdea, listKnowledge, listReminders, listTaskEvents, listTaskMemories, listTaskReports, listTaskReviews,
  listTaskSessions, listTasks, localDateString, registerAiSession, repairParentCompletion, restoreTask, updateDailyPlan, updateDictionaryEntry, updateIdea, updateKnowledge, updateTask, updateTaskWithCompletion, type ReportPeriodCode, type TaskInput,
} from '../db/repo.js'

const TASKS_PREFIX = '/api/workbench/tasks'
const DRAFTS_PREFIX = '/api/workbench/drafts'
const REMINDERS_PREFIX = '/api/workbench/reminders'
const PLANS_PREFIX = '/api/workbench/plans'
const REPORTS_PREFIX = '/api/workbench/reports'
const AI_SESSIONS_PREFIX = '/api/workbench/ai-sessions'
const KNOWLEDGE_PREFIX = '/api/workbench/knowledge'
const IDEAS_PREFIX = '/api/workbench/ideas'
const IDEA_CLUSTERS_PREFIX = '/api/workbench/idea-clusters'
const DICTIONARIES_PREFIX = '/api/workbench/dictionaries'

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

const MAX_LOCAL_DOC_BYTES = 1024 * 1024

/** 把 file:// URL 或绝对路径转成服务器本地文件路径。 */
function fileLinkToPath(link: string): string {
  const trimmed = link.trim()
  if (/^file:/i.test(trimmed)) {
    const url = new URL(trimmed)
    if (url.protocol !== 'file:') throw new Error('not a file URL')
    let pathname = decodeURIComponent(url.pathname)
    // file:///D:/... 在 URL.pathname 中会是 /D:/...，去掉盘符前多余的斜杠。
    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1)
    return pathname
  }
  return trimmed
}

/** 根据宿主平台把用户输入的绝对路径归一化为服务器可读路径（WSL 下 D:\Code -> /mnt/d/Code）。 */
function toNativePath(link: string): string {
  let path = fileLinkToPath(link)
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(path)) {
    const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(path)
    if (match !== null) {
      const drive = match[1].toLowerCase()
      const rest = (match[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
      path = rest === '' ? `/mnt/${drive}` : `/mnt/${drive}/${rest}`
    }
  }
  return path
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

const PERIOD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function periodRange(periodCode: ReportPeriodCode, periodStart: string): { start: string; end: string } | undefined {
  if (!PERIOD_DATE_RE.test(periodStart)) return undefined
  const [y, m, d] = periodStart.split('-').map(Number)
  const start = new Date(y, m - 1, d)
  if (Number.isNaN(start.getTime())) return undefined
  const end = new Date(start)
  end.setDate(end.getDate() + (periodCode === 'day' ? 1 : 7))
  return { start: start.toISOString(), end: end.toISOString() }
}

function reportContext(db: DatabaseSync, periodCode: ReportPeriodCode, periodStart: string): Record<string, unknown> | undefined {
  const range = periodRange(periodCode, periodStart)
  if (range === undefined) return undefined
  const startMs = Date.parse(range.start)
  const endMs = Date.parse(range.end)
  ensureRecurringInstances(db, periodStart)
  const tasks = listTasks(db, { includeArchived: true })
  const inRange = (iso: string | null): boolean => iso !== null && Date.parse(iso) >= startMs && Date.parse(iso) < endMs
  const completed = tasks.filter((task) => inRange(task.completedAt))
  const created = tasks.filter((task) => inRange(task.createdAt))
  const eventRows = db.prepare('SELECT * FROM task_events WHERE at >= ? AND at < ? ORDER BY at ASC LIMIT 500').all(range.start, range.end) as unknown as Array<{
    id: string
    task_id: string
    event_code: string
    actor: string
    note: string | null
    at: string
  }>
  const events = eventRows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    taskTitle: getTask(db, row.task_id)?.title ?? '(任务已删除)',
    eventCode: row.event_code,
    actor: row.actor,
    note: row.note,
    at: row.at,
  }))
  const plan = periodCode === 'day' ? getDailyPlan(db, periodStart) ?? null : null
  return {
    period: { code: periodCode, start: periodStart, range },
    completedTasks: completed.map((task) => ({ id: task.id, title: task.title, typeCode: task.typeCode, priorityCode: task.priorityCode, completedAt: task.completedAt })),
    createdTasks: created.map((task) => ({ id: task.id, title: task.title, typeCode: task.typeCode, priorityCode: task.priorityCode, statusCode: task.statusCode, createdAt: task.createdAt })),
    events,
    plan,
  }
}

function publicTask(task: NonNullable<ReturnType<typeof getTask>>): Record<string, unknown> {
  return { ...task, allDay: task.allDay === 1 }
}

function defaultRecurrenceRule(code: string, anchor?: string | null): Record<string, unknown> {
  const base = anchor !== undefined && anchor !== null ? new Date(anchor) : new Date()
  const date = Number.isNaN(base.getTime()) ? new Date() : base
  return {
    interval: 1,
    startDate: localDateString(date),
    weekdays: [date.getDay()],
    monthDay: date.getDate(),
  }
}

function taskInputFromBody(body: Record<string, unknown>): TaskInput {
  const str = (key: string): string | undefined => typeof body[key] === 'string' ? body[key] as string : undefined
  const recurrenceCode = str('recurrenceCode')
  const recurrenceRule = typeof body.recurrenceRule === 'object' && body.recurrenceRule !== null ? body.recurrenceRule as Record<string, unknown> : undefined
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
    recurrenceCode: recurrenceCode ?? null,
    recurrenceRule: recurrenceCode !== undefined && recurrenceCode !== 'none' ? recurrenceRule ?? defaultRecurrenceRule(recurrenceCode, str('dueAt')) : recurrenceRule,
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
              desktopNotify: (metaGet('desktop_notify') ?? '1') === '1',
            },
          })
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          if (typeof body.defaultWorkspace === 'string') metaSet('ai_default_workspace', body.defaultWorkspace)
          if (body.autoCreateTypeFolders === true || body.autoCreateTypeFolders === false) metaSet('auto_create_type_folders', body.autoCreateTypeFolders ? '1' : '0')
          if (body.desktopNotify === true || body.desktopNotify === false) metaSet('desktop_notify', body.desktopNotify ? '1' : '0')
          return writeJson(res, 200, { ok: true, settings: {
            defaultWorkspace: metaGet('ai_default_workspace') ?? '',
            autoCreateTypeFolders: (metaGet('auto_create_type_folders') ?? '1') === '1',
            desktopNotify: (metaGet('desktop_notify') ?? '1') === '1',
          } })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      },
    },
    // ------------------------------------------------------------------ dictionaries
    {
      kind: 'prefix',
      path: DICTIONARIES_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, DICTIONARIES_PREFIX)
        const method = req.method ?? 'GET'
        if (segments.length === 0) {
          if (method === 'GET') {
            const kind = url.searchParams.get('kind') ?? undefined
            return writeJson(res, 200, { ok: true, dictionaries: listDictionaries(db, kind) })
          }
          if (method === 'POST') {
            const body = await readJsonBody(req)
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            try {
              const entry = createDictionaryEntry(db, {
                kind: typeof body.kind === 'string' ? body.kind : '',
                code: typeof body.code === 'string' ? body.code : '',
                name: typeof body.name === 'string' ? body.name : '',
                config: typeof body.config === 'object' && body.config !== null ? body.config as Record<string, unknown> : {},
                sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : undefined,
                active: typeof body.active === 'boolean' ? body.active : undefined,
              })
              return writeJson(res, 200, { ok: true, dictionary: entry })
            } catch (error) {
              return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        }
        if (segments.length >= 2) {
          const kind = decodeURIComponent(segments[0])
          const code = decodeURIComponent(segments[1])
          if (method === 'PATCH') {
            const body = await readJsonBody(req)
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            try {
              const entry = updateDictionaryEntry(db, kind, code, {
                name: typeof body.name === 'string' ? body.name : undefined,
                config: typeof body.config === 'object' && body.config !== null ? body.config as Record<string, unknown> : undefined,
                sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : undefined,
                active: typeof body.active === 'boolean' ? body.active : undefined,
              })
              return writeJson(res, 200, { ok: true, dictionary: entry })
            } catch (error) {
              return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          }
          if (method === 'DELETE') {
            try {
              deleteDictionaryEntry(db, kind, code)
              return writeJson(res, 200, { ok: true })
            } catch (error) {
              return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        }
        return writeJson(res, 400, { error: 'invalid path' })
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
        ensureRecurringInstances(db, localDateString(now))
        const tasks = listTasks(db)
        const overdue = tasks.filter((task) =>
          task.statusCode !== 'done' && task.statusCode !== 'cancelled' && task.effectiveDueAt !== null && Date.parse(task.effectiveDueAt) < now.getTime())
        const todayDue = tasks.filter((task) =>
          task.statusCode !== 'done' && task.statusCode !== 'cancelled' && task.effectiveDueAt !== null &&
          Date.parse(task.effectiveDueAt) >= Date.parse(start) && Date.parse(task.effectiveDueAt) < Date.parse(end))
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
        if (method === 'GET' && action === undefined) {
          ensureRecurringInstances(db)
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
            if ('estimatedMinutes' in body) patch.estimatedMinutes = typeof body.estimatedMinutes === 'number' ? body.estimatedMinutes : null
            if (body.archived === true || body.archived === false) patch.archived = body.archived
            if ('workspacePath' in body) patch.workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath : null
            if (typeof body.extra === 'object' && body.extra !== null) patch.extra = body.extra as Record<string, unknown>
            // 新语义：任意节点直接完成时，在同一事务内级联完成未完成子节点，并向上递归聚合父节点。
            const task = updateTaskWithCompletion(db, id, patch)
            if (task === undefined) return writeJson(res, 404, { error: 'task not found' })
            if (patch.recurrenceCode !== undefined || patch.recurrenceRule !== undefined) ensureRecurringInstances(db)
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
    // ------------------------------------------------------------------ maintenance
    {
      kind: 'exact',
      path: '/api/workbench/maintenance/repair-parents',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          const changed = repairParentCompletion(db)
          return writeJson(res, 200, { ok: true, changed })
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
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
    // ------------------------------------------------------------------ ideas
    {
      kind: 'prefix',
      path: IDEAS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, IDEAS_PREFIX)
        const method = req.method ?? 'GET'
        const body = ['POST', 'PATCH'].includes(method) ? await readJsonBody(req) : undefined
        if (segments.length === 0) {
          if (method === 'GET') {
            const q = url.searchParams.get('q') ?? undefined
            const kindCode = url.searchParams.get('kind_code') ?? undefined
            if (kindCode !== undefined && getDictionary(db, 'idea_kind', kindCode) === undefined) return writeJson(res, 400, { error: 'unknown idea_kind' })
            return writeJson(res, 200, { ok: true, ideas: listIdeas(db, { q, kindCode }) })
          }
          if (method === 'POST') {
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            const title = typeof body.title === 'string' ? body.title.trim() : ''
            if (title === '') return writeJson(res, 400, { error: 'title is required' })
            const kindCode = typeof body.kindCode === 'string' ? body.kindCode : 'spark'
            requireCode(db, 'idea_kind', kindCode, 'kindCode')
            const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20) : []
            return writeJson(res, 201, { ok: true, idea: createIdea(db, { title, contentMd: typeof body.contentMd === 'string' ? body.contentMd : '', kindCode, tags, sourceSessionId: typeof body.sourceSessionId === 'string' ? body.sourceSessionId : null }) })
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        }
        const id = segments[0]
        if (method === 'GET' && segments.length === 1) {
          const idea = getIdea(db, id)
          return writeJson(res, idea === undefined ? 404 : 200, idea === undefined ? { error: 'idea not found' } : { ok: true, idea, clusters: listIdeaClustersForIdea(db, id) })
        }
        if (method === 'PATCH' && segments.length === 1) {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const patch: Parameters<typeof updateIdea>[2] = {}
          if (typeof body.title === 'string') patch.title = body.title.trim()
          if (typeof body.contentMd === 'string') patch.contentMd = body.contentMd
          if (typeof body.kindCode === 'string') { requireCode(db, 'idea_kind', body.kindCode, 'kindCode'); patch.kindCode = body.kindCode }
          if (Array.isArray(body.tags)) patch.tags = body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20)
          const idea = updateIdea(db, id, patch)
          if (idea === undefined) return writeJson(res, 404, { error: 'idea not found' })
          return writeJson(res, 200, { ok: true, idea })
        }
        if (method === 'DELETE' && segments.length === 1) {
          return writeJson(res, 200, { ok: true, deleted: deleteIdea(db, id) })
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
    // ------------------------------------------------------------------ idea clusters
    {
      kind: 'prefix',
      path: IDEA_CLUSTERS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, IDEA_CLUSTERS_PREFIX)
        const method = req.method ?? 'GET'
        const body = method === 'POST' ? await readJsonBody(req) : undefined
        if (segments.length === 0 && method === 'GET') {
          return writeJson(res, 200, { ok: true, clusters: listIdeaClusters(db) })
        }
        if (segments.length === 0 && method === 'POST') {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const title = typeof body.title === 'string' ? body.title.trim() : ''
          if (title === '') return writeJson(res, 400, { error: 'title is required' })
          const ideaIds = Array.isArray(body.ideaIds) ? body.ideaIds.filter((id): id is string => typeof id === 'string') : []
          return writeJson(res, 201, { ok: true, cluster: createIdeaCluster(db, { title, summaryMd: typeof body.summaryMd === 'string' ? body.summaryMd : '', tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [], ideaIds }) })
        }
        if (segments.length === 1 && method === 'GET') {
          const cluster = getIdeaCluster(db, segments[0])
          return writeJson(res, cluster === undefined ? 404 : 200, cluster === undefined ? { error: 'cluster not found' } : { ok: true, cluster })
        }
        if (segments.length === 1 && method === 'DELETE') {
          return writeJson(res, 200, { ok: true, deleted: deleteIdeaCluster(db, segments[0]) })
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
    // ------------------------------------------------------------------ knowledge
    {
      kind: 'prefix',
      path: KNOWLEDGE_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, KNOWLEDGE_PREFIX)
        const method = req.method ?? 'GET'
        const body = ['POST', 'PATCH'].includes(method) ? await readJsonBody(req) : undefined
        if (segments.length === 1 && segments[0] === 'read-local-file') {
          const rawPath = method === 'GET'
            ? url.searchParams.get('path') ?? undefined
            : method === 'POST' && body !== undefined && typeof body.path === 'string' ? body.path : undefined
          if (rawPath === undefined || rawPath.trim() === '') return writeJson(res, 400, { error: 'path is required' })
          try {
            const fileLink = assertValidFileLink(rawPath)
            if (fileLink === null) return writeJson(res, 400, { error: 'path is required' })
            const filePath = toNativePath(fileLink)
            const info = await stat(filePath)
            if (!info.isFile()) return writeJson(res, 400, { error: 'path is not a file' })
            const content = await readFile(filePath, 'utf8')
            const truncated = content.length > MAX_LOCAL_DOC_BYTES
            return writeJson(res, 200, {
              ok: true,
              path: filePath,
              fileLink,
              name: basename(filePath),
              content: truncated ? content.slice(0, MAX_LOCAL_DOC_BYTES) : content,
              truncated,
              size: info.size,
            })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (segments.length === 0) {
          if (method === 'GET') {
            const q = url.searchParams.get('q') ?? undefined
            const kindCode = url.searchParams.get('kind_code') ?? undefined
            const sourceTaskId = url.searchParams.get('source_task_id') ?? undefined
            const sourceReviewId = url.searchParams.get('source_review_id') ?? undefined
            if (kindCode !== undefined && getDictionary(db, 'knowledge_kind', kindCode) === undefined) return writeJson(res, 400, { error: 'unknown knowledge_kind' })
            return writeJson(res, 200, { ok: true, entries: listKnowledge(db, { q, kindCode, sourceTaskId, sourceReviewId }) })
          }
          if (method === 'POST') {
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            try {
              const title = typeof body.title === 'string' ? body.title.trim() : ''
              if (title === '') throw new Error('title is required')
              const kindCode = typeof body.kindCode === 'string' ? body.kindCode : 'note'
              requireCode(db, 'knowledge_kind', kindCode, 'kindCode')
              const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20) : []
              const fileLink = body.fileLink === undefined || body.fileLink === null ? null : typeof body.fileLink === 'string' ? body.fileLink : undefined
              if (fileLink === undefined) throw new Error('fileLink must be a string or null')
              const entry = createKnowledge(db, {
                kindCode,
                title,
                contentMd: typeof body.contentMd === 'string' ? body.contentMd : '',
                tags,
                sourceTaskId: typeof body.sourceTaskId === 'string' ? body.sourceTaskId : null,
                sourceSessionId: typeof body.sourceSessionId === 'string' ? body.sourceSessionId : null,
                sourceReviewId: typeof body.sourceReviewId === 'string' ? body.sourceReviewId : null,
                fileLink,
              })
              return writeJson(res, 201, { ok: true, knowledge: entry })
            } catch (error) {
              return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        }
        const id = segments[0]
        if (method === 'GET' && segments.length === 1) {
          const entry = getKnowledge(db, id)
          return writeJson(res, entry === undefined ? 404 : 200, entry === undefined ? { error: 'knowledge not found' } : { ok: true, knowledge: entry })
        }
        if (method === 'PATCH' && segments.length === 1) {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const patch: Parameters<typeof updateKnowledge>[2] = {}
          if (typeof body.title === 'string') patch.title = body.title.trim()
          if (typeof body.contentMd === 'string') patch.contentMd = body.contentMd
          if (typeof body.kindCode === 'string') { requireCode(db, 'knowledge_kind', body.kindCode, 'kindCode'); patch.kindCode = body.kindCode }
          if (Array.isArray(body.tags)) patch.tags = body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20)
          if ('sourceTaskId' in body) patch.sourceTaskId = typeof body.sourceTaskId === 'string' ? body.sourceTaskId : null
          if ('sourceReviewId' in body) patch.sourceReviewId = typeof body.sourceReviewId === 'string' ? body.sourceReviewId : null
          if ('fileLink' in body) patch.fileLink = typeof body.fileLink === 'string' ? body.fileLink : null
          const entry = updateKnowledge(db, id, patch)
          if (entry === undefined) return writeJson(res, 404, { error: 'knowledge not found' })
          return writeJson(res, 200, { ok: true, knowledge: entry })
        }
        if (method === 'DELETE' && segments.length === 1) {
          return writeJson(res, 200, { ok: true, deleted: deleteKnowledge(db, id) })
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
    // ------------------------------------------------------------------ ai session registry
    {
      kind: 'prefix',
      path: AI_SESSIONS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, AI_SESSIONS_PREFIX)
        const method = req.method ?? 'GET'
        if (segments.length !== 0) return writeJson(res, 404, { error: 'not found' })
        if (method === 'GET') {
          const scopeCode = url.searchParams.get('scope_code')
          const anchor = url.searchParams.get('anchor')
          if (scopeCode === null || scopeCode === '') return writeJson(res, 400, { error: 'scope_code is required' })
          if (anchor === null || anchor === '') return writeJson(res, 400, { error: 'anchor is required' })
          requireCode(db, 'ai_session_scope', scopeCode, 'scope_code')
          if (['daily_plan', 'day_report', 'week_report'].includes(scopeCode) && !PERIOD_DATE_RE.test(anchor)) return writeJson(res, 400, { error: 'anchor must be YYYY-MM-DD' })
          return writeJson(res, 200, { ok: true, session: getAiSession(db, scopeCode, anchor) ?? null })
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const scopeCode = typeof body.scopeCode === 'string' ? body.scopeCode : undefined
          const anchor = typeof body.anchor === 'string' ? body.anchor : undefined
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
          if (scopeCode === undefined || anchor === undefined || anchor === '' || sessionId === undefined || sessionId.trim() === '') return writeJson(res, 400, { error: 'scopeCode, anchor and sessionId are required' })
          requireCode(db, 'ai_session_scope', scopeCode, 'scope_code')
          if (['daily_plan', 'day_report', 'week_report'].includes(scopeCode) && !PERIOD_DATE_RE.test(anchor)) return writeJson(res, 400, { error: 'anchor must be YYYY-MM-DD' })
          return writeJson(res, 201, { ok: true, session: registerAiSession(db, {
            scopeCode,
            anchor,
            sessionId,
            workspace: typeof body.workspace === 'string' ? body.workspace : null,
            note: typeof body.note === 'string' ? body.note : null,
          }) })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      },
    },
    // ------------------------------------------------------------------ reports
    {
      kind: 'prefix',
      path: REPORTS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, REPORTS_PREFIX)
        const method = req.method ?? 'GET'
        if (segments.length === 0 && method === 'GET') {
          const periodCode = url.searchParams.get('period_code') ?? undefined
          if (periodCode !== undefined && periodCode !== 'day' && periodCode !== 'week') return writeJson(res, 400, { error: 'invalid period_code' })
          const limitParam = Number(url.searchParams.get('limit') ?? 200)
          const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 500)) : 200
          return writeJson(res, 200, { ok: true, reports: listTaskReports(db, { periodCode: periodCode as ReportPeriodCode | undefined, limit }) })
        }
        if (segments.length === 1 && segments[0] === 'context' && method === 'GET') {
          const periodCode = url.searchParams.get('period_code')
          const periodStart = url.searchParams.get('period_start')
          if (periodCode !== 'day' && periodCode !== 'week') return writeJson(res, 400, { error: 'period_code must be day or week' })
          if (periodStart === null || periodStart === '') return writeJson(res, 400, { error: 'period_start is required' })
          const context = reportContext(db, periodCode, periodStart)
          if (context === undefined) return writeJson(res, 400, { error: 'invalid period_start' })
          return writeJson(res, 200, { ok: true, context })
        }
        if (segments.length === 2 && method === 'GET') {
          const [periodCode, periodStart] = segments
          if (periodCode !== 'day' && periodCode !== 'week') return writeJson(res, 400, { error: 'invalid period_code' })
          const report = getTaskReport(db, periodCode, periodStart)
          return writeJson(res, 200, { ok: true, report: report ?? null })
        }
        if (segments.length === 2 && method === 'DELETE') {
          const [periodCode, periodStart] = segments
          if (periodCode !== 'day' && periodCode !== 'week') return writeJson(res, 400, { error: 'invalid period_code' })
          return writeJson(res, 200, { ok: true, deleted: deleteTaskReport(db, periodCode, periodStart) })
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
          if (!PERIOD_DATE_RE.test(planDate)) return writeJson(res, 400, { error: 'date must be YYYY-MM-DD' })
          const plan = getDailyPlan(db, planDate)
          return writeJson(res, 200, { ok: true, plan: plan ?? null })
        }
        if (segments.length === 1 && method === 'PUT') {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(segments[0])) return writeJson(res, 400, { error: 'invalid plan date' })
          if (segments[0] < localDateString()) return writeJson(res, 400, { error: 'past plan is read-only' })
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          try {
            const items = Array.isArray(body.items)
              ? (body.items as Array<Record<string, unknown>>).map((item) => ({
                  taskId: typeof item.taskId === 'string' ? item.taskId : '',
                  order: typeof item.order === 'number' ? item.order : 0,
                  note: typeof item.note === 'string' ? item.note : '',
                }))
              : []
            const plan = updateDailyPlan(db, segments[0], {
              summary: typeof body.summary === 'string' ? body.summary : undefined,
              items,
              sourceCode: 'manual',
              sessionId: null,
            })
            return writeJson(res, 200, { ok: true, plan })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
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
          name: '@dely0/dsh-personal-workbench',
          version: '1.5.2',
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
