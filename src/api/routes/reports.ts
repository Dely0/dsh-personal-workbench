/**
 * 日报 / 周报域路由
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { getTaskReport, listTaskReports, deleteTaskReport } from '../../db/repo.js'
import type { ReportPeriodCode } from '../../db/repo.js'
import { REPORTS_PREFIX, isLoopbackRequest, pathSegments, readJsonBody, reportContext, writeJson } from './helpers.js'

export function makeReportRoutes(db: DatabaseSync): WebRoute[] {
  return [
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
  ]
}
