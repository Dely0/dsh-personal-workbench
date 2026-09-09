/**
 * 点子王域路由
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { createIdeaCluster, deleteIdeaCluster, getIdeaCluster, listIdeaClusters, listIdeaClustersForIdea } from '../../db/repo.js'
import { IDEA_CLUSTERS_PREFIX, isLoopbackRequest, pathSegments, readJsonBody, writeJson } from './helpers.js'

export function makeIdeaClusterRoutes(db: DatabaseSync): WebRoute[] {
  return [
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
  ]
}
