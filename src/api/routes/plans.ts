/**
 * 每日计划域路由（读取 / 保存 / 删除）
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { getDailyPlan, updateDailyPlan, deleteDailyPlan, localDateString } from '../../db/repo.js'
import { isLoopbackRequest, pathSegments, PERIOD_DATE_RE, PLANS_PREFIX, readJsonBody, writeJson } from './helpers.js'

export function makePlanRoutes(db: DatabaseSync): WebRoute[] {
  return [
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
  ]
}
