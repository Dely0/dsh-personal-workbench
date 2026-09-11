/**
 * 点子王域路由（= 点子「文件夹」）
 *
 * 术语：数据库里叫 idea_clusters，UI 上叫「文件夹」。一个点子可同时属于多个文件夹
 * （idea_links 主键是 (cluster_id, idea_id)），所以既支持 AI 自动关联，也支持手动归入。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { addIdeaToCluster, createIdeaCluster, deleteIdeaCluster, getIdeaCluster, listIdeaClusters, listIdeaClustersForIdea, mergeIdeaClusters, removeIdeaFromCluster, updateIdeaCluster } from '../../db/repo.js'
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
        const body = method === 'POST' || method === 'PATCH' ? await readJsonBody(req) : undefined
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
        // 改名 / 改摘要：文件夹管理的主力动作
        if (segments.length === 1 && method === 'PATCH') {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          try {
            const cluster = updateIdeaCluster(db, segments[0], {
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
              ...(typeof body.summaryMd === 'string' ? { summaryMd: body.summaryMd } : {}),
              ...(Array.isArray(body.tags) ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
            })
            return writeJson(res, cluster === undefined ? 404 : 200, cluster === undefined ? { error: 'cluster not found' } : { ok: true, cluster })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (segments.length === 1 && method === 'DELETE') {
          return writeJson(res, 200, { ok: true, deleted: deleteIdeaCluster(db, segments[0]) })
        }
        // 成员：POST /:id/ideas { ideaId } 归入；DELETE /:id/ideas/:ideaId 移出
        if (segments.length === 2 && segments[1] === 'ideas' && method === 'POST') {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const ideaId = typeof body.ideaId === 'string' ? body.ideaId : ''
          if (ideaId === '') return writeJson(res, 400, { error: 'ideaId is required' })
          const cluster = addIdeaToCluster(db, segments[0], ideaId, typeof body.note === 'string' ? body.note : null)
          return writeJson(res, cluster === undefined ? 404 : 200, cluster === undefined ? { error: 'cluster or idea not found' } : { ok: true, cluster })
        }
        if (segments.length === 3 && segments[1] === 'ideas' && method === 'DELETE') {
          const cluster = removeIdeaFromCluster(db, segments[0], segments[2])
          return writeJson(res, cluster === undefined ? 404 : 200, cluster === undefined ? { error: 'cluster not found' } : { ok: true, cluster })
        }
        // 合并：POST /:id/merge { into: targetId } —— 把自己并入目标后删除自己
        if (segments.length === 2 && segments[1] === 'merge' && method === 'POST') {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const into = typeof body.into === 'string' ? body.into : ''
          if (into === '') return writeJson(res, 400, { error: 'into (target cluster id) is required' })
          try {
            const cluster = mergeIdeaClusters(db, segments[0], into)
            return writeJson(res, cluster === undefined ? 404 : 200, cluster === undefined ? { error: 'cluster not found' } : { ok: true, cluster })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}
