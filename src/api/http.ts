/**
 * 路由层**唯一的** HTTP 请求围栏与响应工具（v1.15.1）。
 *
 * ## 为什么要有这个文件（真实事故的防复发）
 *
 * `isLoopbackRequest` / `writeJson` / `readJsonBody` 原先在**四处**各有一份逐字相同的副本：
 * `src/api/dictionaryRoute.ts`、`localDirRoute.ts`、`openFileRoute.ts`、`src/api/routes/helpers.ts`。
 * 调研（`docs/2026-09-15-fork-survey.md` 3.5）逐字比对确认：当时它们**完全相同、尚未漂移**，
 * 所以这是"防未来漂移"的卫生改进 —— 但这类"多份同一语义"正是本项目最大的 bug 类别
 * （第 0 节：同一个语义被独立计算多次）：只要有人给其中一处加一条安全头或改一次 origin 判定，
 * 另外三处就悄悄落后，而**没有任何测试会红**。
 *
 * 现在只有一份实现，并由 `test/httpFence.test.mjs` 做源码级扫描钉住"不存在第二处实现"。
 *
 * ## 两个安全头
 *
 * 所有 `/api/workbench/*` 响应都带 `cache-control: no-store` 与
 * `x-content-type-options: nosniff`：
 *
 * - `no-store`：这些接口返回的是任务/知识/点子等**用户私有数据**，不能被浏览器或中间层缓存；
 * - `nosniff`：禁止浏览器按内容猜 MIME（返回体是 `application/json`，不猜就不会被当成可执行内容）。
 *
 * `referrer-policy: no-referrer` 是原有头，保留。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 只接受回环请求（同 dsh-ssh 的信任围栏）。 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
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

/** 所有工作台接口共用的响应头（单一来源：新增安全头只需改这里）。 */
export function workbenchResponseHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, workbenchResponseHeaders())
  res.end(JSON.stringify(body))
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<Record<string, unknown> | undefined> {
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
