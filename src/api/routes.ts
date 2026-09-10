/**
 * /api/workbench/* 路由入口。Loopback-only 保护（同 dsh-ssh 的信任围栏）。
 *
 * 领域路由已拆分到 routes/：tasks / reminders / drafts / ideas / idea-clusters /
 * knowledge / ai-sessions / reports / plans。本文件保留组合入口与跨领域基础端点
 * （workspaces/ensure、settings、bootstrap、maintenance、health）。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  ensureRecurringInstances, fireReminder, getDailyPlan, getTask, listDictionaries, listDueReminders, listTasks,
  localDateString, readMeta, repairParentCompletion, writeMeta,
} from '../db/repo.js'
import { makeAiSessionRoutes } from './routes/ai-sessions.js'
import { makeDraftRoutes } from './routes/drafts.js'
import { isLoopbackRequest, readJsonBody, todayRange, writeJson } from './routes/helpers.js'
import { makeIdeaClusterRoutes } from './routes/idea-clusters.js'
import { makeIdeaRoutes } from './routes/ideas.js'
import { makeKnowledgeRoutes } from './routes/knowledge.js'
import { makePlanRoutes } from './routes/plans.js'
import { makeReminderRoutes, type ReminderRouteDeps } from './routes/reminders.js'
import { makeReportRoutes } from './routes/reports.js'
import { makeTaskRoutes } from './routes/tasks.js'

/**
 * 插件版本：直接读包内 package.json，避免再出现"代码已升级、health 还报旧版本"的漂移。
 * lib/api/routes.js 相对包根是 ../../package.json。
 */
const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch { return 'unknown' }
})()

/** 每天可投入时长（分钟）：存 meta，缺省 390（6.5 小时），夹在 30–1440 之间。 */
export const DEFAULT_DAILY_CAPACITY_MINUTES = 390
export function readDailyCapacityMinutes(db: DatabaseSync): number {
  const raw = Number(readMeta(db, 'daily_capacity_minutes'))
  if (!Number.isFinite(raw) || raw < 30) return DEFAULT_DAILY_CAPACITY_MINUTES
  return Math.min(1440, Math.round(raw))
}


export function makeRoutes(db: DatabaseSync, deps: ReminderRouteDeps = {}): WebRoute[] {
  return [
    ...makeReminderRoutes(db, {
      channel: deps.channel,
      policy: deps.policy,
      test: deps.test,
      // 优先用调用方注入的实现（入口会带上"策略开关 + 补发窗口"语义）；
      // 未注入时退回朴素版本，供测试等场景直接使用。**不要在这里硬编码覆盖**——
      // 曾经因为硬编码 listDueReminders(db) 把入口注入的策略/窗口语义悄悄吃掉。
      listDue: deps.listDue ?? (() => listDueReminders(db)),
      fire: deps.fire ?? ((id: string) => fireReminder(db, id)),
    }),
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
              defaultWorkspace: readMeta(db, 'ai_default_workspace') ?? '',
              autoCreateTypeFolders: (readMeta(db, 'auto_create_type_folders') ?? '1') === '1',
              desktopNotify: (readMeta(db, 'desktop_notify') ?? '1') === '1',
              dailyCapacityMinutes: readDailyCapacityMinutes(db),
            },
          })
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          if (typeof body.defaultWorkspace === 'string') writeMeta(db, 'ai_default_workspace', body.defaultWorkspace)
          if (body.autoCreateTypeFolders === true || body.autoCreateTypeFolders === false) writeMeta(db, 'auto_create_type_folders', body.autoCreateTypeFolders ? '1' : '0')
          if (body.desktopNotify === true || body.desktopNotify === false) writeMeta(db, 'desktop_notify', body.desktopNotify ? '1' : '0')
          if (typeof body.dailyCapacityMinutes === 'number' && Number.isFinite(body.dailyCapacityMinutes)) {
            const minutes = Math.min(1440, Math.max(30, Math.round(body.dailyCapacityMinutes)))
            writeMeta(db, 'daily_capacity_minutes', String(minutes))
          }
          return writeJson(res, 200, { ok: true, settings: {
            defaultWorkspace: readMeta(db, 'ai_default_workspace') ?? '',
            autoCreateTypeFolders: (readMeta(db, 'auto_create_type_folders') ?? '1') === '1',
            desktopNotify: (readMeta(db, 'desktop_notify') ?? '1') === '1',
            dailyCapacityMinutes: readDailyCapacityMinutes(db),
          } })
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
    ...makeTaskRoutes(db),
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
    ...makeDraftRoutes(db),
    ...makeIdeaRoutes(db),
    ...makeIdeaClusterRoutes(db),
    ...makeKnowledgeRoutes(db),
    ...makeAiSessionRoutes(db),
    ...makeReportRoutes(db),
    ...makePlanRoutes(db),
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
          version: PACKAGE_VERSION,
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
