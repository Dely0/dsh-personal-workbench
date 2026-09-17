/**
 * 路由层共享工具：路径、时间区间、任务序列化。
 *
 * 从 routes.ts 原样抽出（不改行为），供按域拆分的路由模块共用。
 * 所有函数显式接收 db / req / res，便于单测与复用。
 *
 * ⚠️ v1.15.1：请求围栏（`isLoopbackRequest` / `writeJson` / `readJsonBody`）已迁到
 * `src/api/http.ts`，这里**只做再导出**，让既有 `from './helpers.js'` 的调用点不必改动。
 * 原地再写一份实现正是"同一个语义两处实现"，由 `test/httpFence.test.mjs` 扫描禁止。
 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  ensureRecurringInstances, getDailyPlan, getDictionary, getTask, listTasks, localDateString,
  type ReportPeriodCode, type TaskInput,
} from '../../db/repo.js'

export { isLoopbackRequest, readJsonBody, writeJson } from '../http.js'

export const TASKS_PREFIX = '/api/workbench/tasks'
export const DRAFTS_PREFIX = '/api/workbench/drafts'
export const REMINDERS_PREFIX = '/api/workbench/reminders'
export const PLANS_PREFIX = '/api/workbench/plans'
export const REPORTS_PREFIX = '/api/workbench/reports'
export const AI_SESSIONS_PREFIX = '/api/workbench/ai-sessions'
export const KNOWLEDGE_PREFIX = '/api/workbench/knowledge'
/** 知识库自动召回的可观测端点前缀（日志/状态/开关），见 `api/knowledgeRecallRoute.ts`。 */
export const KNOWLEDGE_RECALL_PREFIX = '/api/workbench/knowledge-recall'
export const IDEAS_PREFIX = '/api/workbench/ideas'
export const IDEA_CLUSTERS_PREFIX = '/api/workbench/idea-clusters'

export const MAX_LOCAL_DOC_BYTES = 1024 * 1024

/** 把 file:// URL 或绝对路径转成服务器本地文件路径。 */
export function fileLinkToPath(link: string): string {
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

/**
 * 根据宿主平台把用户输入的绝对路径归一化为服务器可读路径（WSL 下 D:\Code -> /mnt/d/Code）。
 *
 * @param link - `file://` URL 或绝对路径。
 * @param platform - 宿主平台（默认 `process.platform`；显式传入便于单测）。
 */
export function toNativePath(link: string, platform: string = process.platform): string {
  let path = fileLinkToPath(link)
  if (platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(path)) {
    const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(path)
    if (match !== null) {
      const drive = match[1].toLowerCase()
      const rest = (match[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
      path = rest === '' ? `/mnt/${drive}` : `/mnt/${drive}/${rest}`
    }
  }
  return path
}

/**
 * 把**已经拼好的**路径按宿主平台归一化（不做 `file://` 解析）。
 *
 * fresh-eyes 审查 F5：`/workbench` 命令侧用 `node:path.join` 拼出 `D:\DSHWorkspace\<id>-<标题>`
 * 之后直接 `mkdirSync` 并写进提示词，而客户端那条链路算的是 `/mnt/d/DSHWorkspace/...` ——
 * 同一台 WSL 宿主上两条入口给出**形态不同**的路径，`mkdirSync` 会在当前目录
 * 建出一个名叫 `D:\DSHWorkspace` 的单层目录。这里复用**同一份**归一化实现（不另写一套）。
 *
 * @param path - 已拼好的路径。
 * @param platform - 宿主平台（默认 `process.platform`；显式传入便于单测）。
 */
export function normalizeHostPath(path: string, platform: string = process.platform): string {
  return toNativePath(path, platform)
}

export function pathSegments(url: URL, prefix: string): string[] {
  const rest = url.pathname.slice(prefix.length)
  return rest.split('/').filter((part) => part !== '')
}

export function requireCode(db: DatabaseSync, kind: string, code: string, field: string): void {
  if (typeof code !== 'string' || code.trim() === '') throw new Error(`${field} is required`)
  const entry = getDictionary(db, kind, code)
  if (entry === undefined || entry.active === 0) throw new Error(`${field}: unknown or inactive ${kind} code "${code}"`)
}

export function todayRange(now: Date): { start: string; end: string } {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

export const PERIOD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function periodRange(periodCode: ReportPeriodCode, periodStart: string): { start: string; end: string } | undefined {
  if (!PERIOD_DATE_RE.test(periodStart)) return undefined
  const [y, m, d] = periodStart.split('-').map(Number)
  const start = new Date(y, m - 1, d)
  if (Number.isNaN(start.getTime())) return undefined
  const end = new Date(start)
  end.setDate(end.getDate() + (periodCode === 'day' ? 1 : 7))
  return { start: start.toISOString(), end: end.toISOString() }
}

export function reportContext(db: DatabaseSync, periodCode: ReportPeriodCode, periodStart: string): Record<string, unknown> | undefined {
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

/** 任务在 HTTP 层的形状：allDay 由 0/1 转布尔。 */
export function publicTask(task: NonNullable<ReturnType<typeof getTask>>): Record<string, unknown> {
  return { ...task, allDay: task.allDay === 1 }
}

export function defaultRecurrenceRule(code: string, anchor?: string | null): Record<string, unknown> {
  const base = anchor !== undefined && anchor !== null ? new Date(anchor) : new Date()
  const date = Number.isNaN(base.getTime()) ? new Date() : base
  return {
    interval: 1,
    startDate: localDateString(date),
    weekdays: [date.getDay()],
    monthDay: date.getDate(),
  }
}

export function taskInputFromBody(body: Record<string, unknown>): TaskInput {
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
