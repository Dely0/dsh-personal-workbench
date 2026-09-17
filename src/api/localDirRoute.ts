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

/**
 * 「根」视图的哨兵：客户端拿到它就知道"往上走 = 回到盘符/根列表"，而不是某个真实目录。
 * 用哨兵而不是 `null`，是为了把"没有上一级"（Linux 的 `/`）和"上一级是根列表"区分开。
 */
export const ROOTS_PARENT = '\u0000roots'

export interface LocalRoot { path: string; name: string; totalBytes?: number; freeBytes?: number }

/**
 * 列出可浏览的根。
 *
 * ## 为什么必须有这个（真实缺陷）
 *
 * 原先 `listLocalDirectory` 在盘符根就把 `parent` 记为 `null`（`dirname('C:\\') === 'C:\\'`），
 * 于是弹窗里「上级」按钮在 `C:\` 变灰、**再也出不去 C 盘**；而弹窗默认起点是 `homedir()`（在 C 盘）。
 * 用户的实际感受是"选择文件只能选 C 盘的文件"——`E:\Code\...`（本仓）根本选不到。
 *
 * Windows 上直接枚举存在的盘符（不调 wmic/PS：要起子进程、慢且可能被策略挡）。
 * 非 Windows（含 WSL）根就是 `/`。
 */
export async function listLocalRoots(platform: string = process.platform, exists: (p: string) => Promise<boolean> = defaultExists): Promise<LocalRoot[]> {
  if (platform !== 'win32') return [{ path: '/', name: '/' }]
  const roots: LocalRoot[] = []
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code)
    const drive = `${letter}:\\`
    // 逐盘符 probe：读得到才算存在（未插入的读卡器/网络盘会自然略过）
    if (await exists(drive)) roots.push({ path: drive, name: `${letter}: 盘` })
  }
  return roots
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

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
  roots: LocalRoot[]
  entries: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean; hidden: boolean }>
}> {
  const roots = await listLocalRoots()
  // 空 path = 默认落在用户主目录（保留了原来的行为），而不是根列表
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
  /**
   * 上一级：
   * - 到盘符根（`C:\`）/ 文件系统根（`/`）时 `dirname` 等于自身 —— 这时**不能**给 `null`
   *   （那就是"再也出不去 C 盘"的缺陷），而是给「根列表」哨兵，让用户能切到别的盘；
   * - 其余情况照常给父目录。
   */
  const parent = dirname(dir) === dir ? ROOTS_PARENT : dirname(dir)
  return { path: dir, parent, home: homedir(), roots, entries }
}

/** 根列表视图：不带 path 只读盘符，供客户端「此电脑」那一层使用。 */
async function listRootsView(): Promise<{
  path: string
  parent: null
  home: string
  roots: LocalRoot[]
  entries: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean; hidden: boolean }>
}> {
  const roots = await listLocalRoots()
  return {
    path: ROOTS_PARENT,
    parent: null,
    home: homedir(),
    roots,
    entries: roots.map((root) => ({ name: root.name, path: root.path, isDirectory: true, isFile: false, hidden: false })),
  }
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
        // `?path=` 显式传哨兵 = 要看盘符列表；不传 path = 默认主目录（保留原行为）
        const listing = rawPath === ROOTS_PARENT ? await listRootsView() : await listLocalDirectory(rawPath)
        return writeJson(res, 200, { ok: true, ...listing })
      } catch (error) {
        return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
