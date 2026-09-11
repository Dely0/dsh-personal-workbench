/**
 * 点子域路由
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { createIdea, deleteIdea, getDictionary, getIdea, listIdeaClustersForIdea, listIdeas, updateIdea } from '../../db/repo.js'
import { IDEAS_PREFIX, isLoopbackRequest, pathSegments, readJsonBody, requireCode, writeJson } from './helpers.js'

export function makeIdeaRoutes(db: DatabaseSync): WebRoute[] {
  return [
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
  ]
}
