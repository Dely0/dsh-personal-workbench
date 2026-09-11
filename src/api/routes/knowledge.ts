/**
 * 知识库域路由（含 read-local-file）
 * 从 routes.ts 原样抽出（行为不变），由 makeRoutes 组合。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { assertValidFileLink, createKnowledge, deleteKnowledge, getDictionary, getKnowledge, listKnowledge, updateKnowledge } from '../../db/repo.js'
import { isLoopbackRequest, KNOWLEDGE_PREFIX, MAX_LOCAL_DOC_BYTES, pathSegments, readJsonBody, requireCode, toNativePath, writeJson } from './helpers.js'

export function makeKnowledgeRoutes(db: DatabaseSync): WebRoute[] {
  return [
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
  ]
}
