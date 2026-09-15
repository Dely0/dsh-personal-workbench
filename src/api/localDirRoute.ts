/**
 * 知识库“选择本地文档”弹窗使用的目录/文件浏览路由。
 * 独立成文件是为了在热重载时能作为新模块被重新加载（routes.ts 会被 ESM 缓存，
 * 新增路由无法通过 dev_reload_package 立即生效）。
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join as pathJoin } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { assertValidFileLink } from '../db/repo.js'
import { isLoopbackRequest, readJsonBody, writeJson } from './http.js'

function fileLinkToPath(link: string): string {
  const trimmed = link.trim()
  if (/^file:/i.test(trimmed)) {
    const url = new URL(trimmed)
    if (url.protocol !== 'file:') throw new Error('not a file URL')
    let pathname = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1)
    return pathname
  }
  return trimmed
}

function toNativePath(link: string): string {
  let path = fileLinkToPath(link)
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(path)) {
    const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(path)
    if (match !== null) {
      const drive = match[1].toLowerCase()
      const rest = (match[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
      path = rest === '' ? `/mnt/${drive}` : `/mnt/${drive}/${rest}`
    }
  }
  return path
}

async function listLocalDirectory(rawPath?: string): Promise<{
  path: string
  parent: string | null
  home: string
  entries: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean; hidden: boolean }>
}> {
  const dir = rawPath === undefined || rawPath.trim() === '' ? homedir() : toNativePath(assertValidFileLink(rawPath)!)
  const info = await stat(dir)
  if (!info.isDirectory()) throw new Error('path is not a directory')
  const dirents = await readdir(dir, { withFileTypes: true })
  const entries = dirents
    .filter((d) => d.isDirectory() || d.isFile())
    .map((d) => ({
      name: d.name,
      path: pathJoin(dir, d.name),
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
      hidden: d.name.startsWith('.'),
    }))
    .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1))
    .slice(0, 500)
  const parent = dirname(dir) === dir ? null : dirname(dir)
  return { path: dir, parent, home: homedir(), entries }
}

export function makeLocalDirRoute(): WebRoute {
  return {
    kind: 'exact',
    path: '/api/workbench/knowledge/list-local-dir',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method ?? 'GET'
      const body = method === 'POST' ? await readJsonBody(req) : undefined
      const rawPath = method === 'GET'
        ? url.searchParams.get('path') ?? undefined
        : method === 'POST' && body !== undefined && typeof body.path === 'string' ? body.path : undefined
      try {
        const listing = await listLocalDirectory(rawPath)
        return writeJson(res, 200, { ok: true, ...listing })
      } catch (error) {
        return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
