/**
 * AI 会话注册表路由
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { getAiSession, registerAiSession } from '../../db/repo.js'
import { AI_SESSIONS_PREFIX, isLoopbackRequest, pathSegments, PERIOD_DATE_RE, readJsonBody, requireCode, writeJson } from './helpers.js'

export function makeAiSessionRoutes(db: DatabaseSync): WebRoute[] {
  return [
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
  ]
}
