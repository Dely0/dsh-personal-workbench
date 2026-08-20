/**
 * 知识库“打开本地文件”路由。
 * 独立成文件是为了在热重载时能作为新模块被重新加载（routes.ts 会被 ESM 缓存，
 * 新增/修复路由无法通过 dev_reload_package 立即生效）。
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { assertValidFileLink } from '../db/repo.js'

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let url: URL
  try { url = new URL(`http://${host}`) } catch { return false }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === url.host } catch { return false }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
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

function wslPathToWindowsPath(filePath: string): string {
  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(filePath)
  if (match === null) return filePath
  const drive = match[1].toUpperCase()
  const rest = (match[2] ?? '').replace(/\//g, '\\')
  return rest === '' ? `${drive}:\\` : `${drive}:\\${rest}`
}

function tryOpen(candidates: Array<{ command: string; args: string[] }>): Promise<void> {
  return new Promise((resolve, reject) => {
    let index = 0
    const errors: unknown[] = []
    const attempt = (): void => {
      if (index >= candidates.length) {
        reject(new AggregateError(errors, `无法打开文件：所有打开命令均失败（${errors.map((e) => e instanceof Error ? e.message : String(e)).join('; ')}）`))
        return
      }
      const { command, args } = candidates[index++]
      execFile(command, args, { windowsVerbatimArguments: process.platform === 'win32' }, (error) => {
        if (error) { errors.push(error); attempt() } else resolve()
      })
    }
    attempt()
  })
}

function openLocalFile(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    return tryOpen([{ command: 'cmd', args: ['/c', 'start', '', filePath] }])
  }
  if (process.platform === 'darwin') {
    return tryOpen([{ command: 'open', args: [filePath] }])
  }
  const winPath = wslPathToWindowsPath(filePath)
  const candidates: Array<{ command: string; args: string[] }> = []
  if (winPath !== filePath) {
    candidates.push({ command: 'cmd.exe', args: ['/c', 'start', '', winPath] })
    candidates.push({ command: 'explorer.exe', args: [winPath] })
  }
  candidates.push({ command: 'wslview', args: [filePath] })
  candidates.push({ command: 'xdg-open', args: [filePath] })
  candidates.push({ command: 'gio', args: ['open', filePath] })
  return tryOpen(candidates)
}

export function makeOpenFileRoute(): WebRoute {
  return {
    kind: 'exact',
    path: '/api/workbench/knowledge/open-file',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
      if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
      const body = await readJsonBody(req)
      if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
      const raw = typeof body.fileLink === 'string' ? body.fileLink : typeof body.path === 'string' ? body.path : undefined
      if (raw === undefined || raw.trim() === '') return writeJson(res, 400, { error: 'fileLink is required' })
      try {
        const fileLink = assertValidFileLink(raw)
        if (fileLink === null) return writeJson(res, 400, { error: 'fileLink is required' })
        const filePath = toNativePath(fileLink)
        const info = await stat(filePath)
        if (!info.isFile()) return writeJson(res, 400, { error: 'path is not a file' })
        await openLocalFile(filePath)
        return writeJson(res, 200, { ok: true, path: filePath })
      } catch (error) {
        return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
