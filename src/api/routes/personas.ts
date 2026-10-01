/**
 * 角色库 HTTP（D11 / D12 / requirements §6.3、§6.4）。
 *
 * ## 端点
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/api/workbench/personas` | 摘要列表：**不回正文、不回绝对路径**，附带诊断 |
 * | GET | `/api/workbench/personas/resources?persona_id=..&path=..` | 读一条资源（只读、边界见 `personas/resources.ts`） |
 * | GET | `/api/workbench/personas/bind?session_id=..` | 读该会话的角色绑定（没有 → `null`） |
 * | POST | `/api/workbench/personas/bind` | 在**首次 prompt 之前**绑定角色（幂等 / 409） |
 *
 * ## 硬约束
 *
 * - loopback-only（与其余路由同一道围栏）；
 * - 响应里**永远不出现**绝对路径/正文（`PersonaSummary` 里就没有这两个字段）；
 * - 资源失败给**明确的中文原因 + 诊断码**，绝不回退去用户机器别处找文件；
 * - 绑定的判定**只有一处**（`personas/binding.ts`）：路由只做 HTTP ↔ 结果映射，
 *   与 `workbench_load_persona` 工具共用同一份"幂等/409/四态"语义。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { readPersonaBinding } from '../../db/repo/persona-bindings.js'
import { bindSessionPersona, type PersonaBindResult } from '../../personas/binding.js'
import { discoverPersonas, resolvePersona } from '../../personas/library.js'
import {
  personaLookupOptions, resolvePersonaRoots, type PersonaRootOptions,
} from '../../personas/roots.js'
import { listPersonaResources, readPersonaResource } from '../../personas/resources.js'
import { personaBindingView, type PersonaDiagnostic, type PersonaResourceResponse } from '../../shared/persona.js'
import { isLoopbackRequest, readJsonBody, writeJson } from './helpers.js'

export const PERSONAS_PREFIX = '/api/workbench/personas'
/** 请求体/查询串里最长能接受的 id（防"用一个 10 万字符的 id 打库"）。 */
const MAX_PERSONA_ID_CHARS = 512
/** 会话 id 的长度上限（宿主 id 是 uuid 量级；留足余量，只防滥用）。 */
const MAX_SESSION_ID_CHARS = 512

/** 三级根与 resolve 入参由 `personas/roots.ts` 提供（路由与工具共用一处）。 */
export type PersonaRouteOptions = PersonaRootOptions

export { personaLookupOptions, resolvePersonaRoots }

/** 资源失败码 → HTTP 状态码（**集中在唯一一处**，测试按码断言）。 */
export function statusForResourceFailure(code: string): number {
  if (code === 'resource-not-found' || code === 'resource-skipped-symlink') return 404
  if (code === 'resource-oversized') return 413
  return 400
}

export function makePersonaRoutes(db: DatabaseSync, options: PersonaRouteOptions = {}): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: PERSONAS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        const tail = url.pathname.slice(PERSONAS_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
        if (tail === 'bind') {
          if (method === 'GET') return writeBinding(res, db, url)
          if (method === 'POST') return writeBindResult(res, await bindFromRequest(req, db, options))
          return writeJson(res, 405, { error: 'method not allowed' })
        }
        if (method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        if (tail === '') return writeSummary(res, db, options)
        if (tail === 'resources') return writeResource(res, db, url, options)
        return writeJson(res, 404, { error: `未知的角色接口：${tail}` })
      },
    },
  ]
}

/** GET `/personas/bind?session_id=..`：读该会话的绑定（没有 → `binding: null`）。 */
function writeBinding(res: Parameters<WebRoute['handler']>[1], db: DatabaseSync, url: URL): void {
  const sessionId = (url.searchParams.get('session_id') ?? '').trim()
  if (sessionId === '' || sessionId.length > MAX_SESSION_ID_CHARS) {
    return writeJson(res, 400, { ok: false, code: 'missing-session', error: 'session_id 必填（要查绑定的会话），且不能超长' })
  }
  const lookup = readPersonaBinding(db, sessionId)
  if (lookup.corrupt) {
    /**
     * 行列在、内容坏了：**不返回 `binding: null`** —— 那会让界面以为"没绑角色"
     * 并把用户引向"重新选一次"。这里如实说清楚，同时保持 `binding:null`
     * 让旧客户端不会崩（它只认 binding 字段）。
     */
    return writeJson(res, 200, {
      ok: true,
      binding: null,
      problem: `该会话的角色绑定记录已损坏（版本不符或缺字段），这不是"没有绑定"。请新建会话重新选择角色。`,
    })
  }
  return writeJson(res, 200, { ok: true, binding: lookup.binding === undefined ? null : personaBindingView(lookup.binding) })
}

async function bindFromRequest(
  req: Parameters<WebRoute['handler']>[0],
  db: DatabaseSync,
  options: PersonaRouteOptions,
): Promise<PersonaBindResult> {
  const body = await readJsonBody(req)
  if (body === undefined) {
    return { ok: false, status: 400, code: 'missing-session', message: 'invalid JSON body' }
  }
  return bindSessionPersona(db, { sessionId: body.sessionId, personaId: body.personaId }, options)
}

function writeBindResult(res: Parameters<WebRoute['handler']>[1], result: PersonaBindResult): void {
  if (result.ok === false) {
    return writeJson(res, result.status, {
      ok: false,
      code: result.code,
      error: result.message,
      ...(result.binding === undefined ? {} : { binding: personaBindingView(result.binding) }),
    })
  }
  writeJson(res, result.status, {
    ok: true,
    created: result.created,
    revisionChanged: result.revisionChanged,
    binding: personaBindingView(result.binding),
  })
}

function writeSummary(res: Parameters<WebRoute['handler']>[1], db: DatabaseSync, options: PersonaRouteOptions): void {
  const discovery = discoverPersonas(personaLookupOptions(db, options))
  writeJson(res, 200, { ok: true, personas: discovery.personas, diagnostics: discovery.diagnostics })
}

function writeResource(res: Parameters<WebRoute['handler']>[1], db: DatabaseSync, url: URL, options: PersonaRouteOptions): void {
  const personaId = url.searchParams.get('persona_id') ?? ''
  const path = url.searchParams.get('path') ?? ''
  if (personaId.trim() === '' || personaId.length > MAX_PERSONA_ID_CHARS) {
    return writeJson(res, 400, { ok: false, code: 'resource-invalid-path', error: 'persona_id 必填（角色逻辑 ID），且不能超长' })
  }
  if (path === '') {
    return writeJson(res, 400, { ok: false, code: 'resource-invalid-path', error: 'path 必填（相对该角色附件目录的路径）' })
  }
  const platform = options.platform
  const resolved = resolvePersona(personaId, personaLookupOptions(db, options))
  if (resolved.ok === false) {
    const message = resolved.reason === 'not-found'
      ? `角色「${personaId}」不存在（可能被删除、改名或被禁用来源）`
      : resolved.diagnostics[0]?.message ?? '角色当前不可读'
    return writeJson(res, 404, { ok: false, code: 'resource-not-found', error: message })
  }
  const list = listPersonaResources(resolved.resourceDir)
  const read = readPersonaResource(resolved.resourceDir, path, { platform })
  if (read.ok === false) {
    return writeJson(res, statusForResourceFailure(read.code), { ok: false, code: read.code, error: read.message })
  }
  const diagnostics: PersonaDiagnostic[] = [...list.diagnostics]
  const body: PersonaResourceResponse = {
    ok: true,
    personaId: resolved.summary.id,
    path: read.path,
    text: read.text,
    bytes: read.bytes,
    characters: read.characters,
    revision: resolved.revision,
    resources: list.resources,
    diagnostics,
  }
  writeJson(res, 200, body)
}
