/**
 * 字典管理路由（类型/状态/优先级/点子类型等 dictionaries 通用增改）。
 * 独立成文件是为了在热重载时能作为新模块被重新加载（routes.ts 会被 ESM 缓存，
 * 新增路由无法通过 dev_reload_package 立即生效）。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { createDictionaryEntry, deleteDictionaryEntry, listDictionaries, updateDictionaryEntry } from '../db/repo.js'
import { isLoopbackRequest, readJsonBody, writeJson } from './http.js'

const DICTIONARIES_PREFIX = '/api/workbench/dictionaries'

function pathSegments(url: URL, prefix: string): string[] {
  const rest = url.pathname.slice(prefix.length)
  return rest.split('/').filter((part) => part !== '')
}

export function makeDictionaryRoute(db: DatabaseSync): WebRoute {
  return {
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
  }
}
