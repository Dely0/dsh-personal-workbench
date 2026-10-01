/**
 * 会话 ↔ 角色：**绑定**与**按绑定加载**（D12 / requirements §6.4）。
 *
 * ## 为什么这一层必须存在（而不是让路由和工具各写一遍）
 *
 * "绑定"与"加载"各自都有**多步判定**：
 *
 * | 动作 | 步骤 |
 * |---|---|
 * | 绑定 | 校验入参 → `resolvePersona` 解析校验 → 读既有绑定 → 同绑定幂等 / 不同绑定 409 → 落库 |
 * | 加载 | 读绑定（缺/坏分开）→ `resolvePersona(expectedRevision)` → 正文 + 资源清单 |
 *
 * 任何一处各写一遍，就会出现"HTTP 说绑上了、工具说没绑定"这类**同一语义两处实现**
 * （本仓最大的 bug 类别）。所以：
 *
 * - 路由（`api/routes/personas.ts`）与工具（`tools.ts`）**都只调这里**；
 * - 绑定行的读写只有 `db/repo/persona-bindings.ts` 一处；
 * - 角色解析/校验只有 `personas/library.ts#resolvePersona` 一处。
 *
 * ## 失败四态（+2 条会话侧）
 *
 * | code | 含义 | 行为 |
 * |---|---|---|
 * | `no-session` | 工具拿不到真实会话 id | 拒绝（**绝不**用任何入参代替） |
 * | `not-bound` | 该会话没有绑定 | 拒绝（默认无角色的会话就是这条） |
 * | `binding-corrupt` | 有绑定行但解析不出来 | 拒绝并提示"数据坏了"（不等于没绑定） |
 * | `not-found` | 库里没有这个 id | 拒绝（可能被删/改名/来源被禁用） |
 * | `source-unavailable` | 该来源根不可达 | 拒绝，**不切到其他来源** |
 * | `revision-changed` | 正文与绑定时不一致 | 拒绝，**不返回新正文**（需求 §6.4） |
 * | `invalid-document` | 文档现在解析不过 | 拒绝，带上格式原因 |
 */
import type { DatabaseSync } from 'node:sqlite'
import { relative, sep } from 'node:path'
import { readPersonaBinding, writePersonaBinding } from '../db/repo/persona-bindings.js'
import {
  PERSONA_BINDING_VERSION,
  samePersonaIdentity,
  type PersonaBindingRecord,
  type PersonaDiagnostic,
  type PersonaDocument,
  type PersonaSummary,
} from '../shared/persona.js'
import { resolvePersona, type PersonaResolveFailure } from './library.js'
import { personaLookupOptions, type PersonaRootOptions } from './roots.js'

export type { PersonaRootOptions }
import { listPersonaResources, readPersonaResource, type PersonaResourceEntry, type PersonaResourceFailure } from './resources.js'

/** 绑定失败码（封闭枚举；界面/测试按码断言，不按中文）。 */
export type PersonaBindFailureCode =
  | 'missing-session'
  | 'missing-persona'
  | 'not-found'
  | 'source-unavailable'
  | 'invalid-document'
  | 'binding-conflict'
  | 'binding-corrupt'

export type PersonaBindResult =
  | {
    ok: true
    /** 新建 = 201，幂等命中 = 200。 */
    status: 200 | 201
    binding: PersonaBindingRecord
    created: boolean
    /**
     * 同一个角色（同 id + 同来源）但**文件内容已变**。
     *
     * 这时**不覆盖**既有绑定（保留旧 revision，加载时明确拒绝旧版本 —— 需求 §6.4），
     * 只把这件事回给调用方，让界面能说清"要读新内容请新建会话"。
     */
    revisionChanged: boolean
  }
  | { ok: false; status: 400 | 409; code: PersonaBindFailureCode; message: string; binding?: PersonaBindingRecord }

/** `resolvePersona` 的失败原因 → 对外失败码（**唯一映射处**）。 */
export function bindFailureCodeFromResolve(reason: PersonaResolveFailure): PersonaBindFailureCode {
  if (reason === 'not-found') return 'not-found'
  if (reason === 'source-unavailable') return 'source-unavailable'
  return 'invalid-document'
}

/** 角色解析失败的**中文原因**（路由与工具共用同一段文案，避免两处措辞漂移）。 */
export function personaResolveMessage(personaId: string, reason: PersonaResolveFailure, diagnostics: PersonaDiagnostic[]): string {
  if (reason === 'not-found') return `角色「${personaId}」不存在（可能被删除、改名，或该来源被禁用）。`
  if (reason === 'source-unavailable') {
    return `角色「${personaId}」的来源（用户库 / 外部角色目录）已不可用。已明确报错，**不会自动切换到其他来源**；请检查「工作台 → 设置 → 角色库」里的外部角色目录，或把该角色放回用户库。`
  }
  if (reason === 'revision-changed') {
    return `角色「${personaId}」的正文在上次绑定之后发生了变化。已明确拒绝旧绑定（不会悄悄读新文件）：如需使用最新内容，请**新建会话**重新选择角色。`
  }
  const detail = diagnostics.map((diagnostic) => diagnostic.message).filter((message) => message !== '').join('；')
  return `角色「${personaId}」当前解析不过${detail === '' ? '（文档格式不符合要求）' : `：${detail}`}`
}

/**
 * "同一个逻辑 ID 现在解析到了**另一个来源**"（AX-R05）。
 *
 * 触发面有三条，全部来自需求：外部角色目录被改配置（= 换身份）、角色被从原来源删掉
 * 而同名角色在别的来源里存在、以及同名覆盖顺序变化。三者的正确行为都是**明确报错**，
 * 而不是把另一个来源的正文当成"同一个角色"给出去。
 */
export function personaSourceChangedMessage(binding: PersonaBindingRecord): string {
  return `角色「${binding.personaId}」现在解析到的**来源已不是绑定时的那一个**（绑定来源 ${binding.sourceKey}）。`
    + '已明确报错，**不会把其他来源的同名角色当成同一个角色**（也不返回它的正文）。'
    + '改外部角色目录等于换来源身份：请新建会话重新选择角色。'
}

/** 加载失败码：会话侧两条 + 解析侧四条 + 绑定损坏。 */export type PersonaLoadFailureCode =
  | 'no-session'
  | 'not-bound'
  | 'binding-corrupt'
  | PersonaResolveFailure

export interface PersonaLoadSuccess {
  ok: true
  binding: PersonaBindingRecord
  summary: PersonaSummary
  document: PersonaDocument
  revision: string
  /** 资源清单（相对路径 + 字节数；**不含绝对路径**）。 */
  resources: PersonaResourceEntry[]
  resourceDiagnostics: PersonaDiagnostic[]
  /** 服务端用的资源根 + 来源根：**只在本进程内传递**，绝不进工具输出。 */
  resourceDir: string
  sourceRoot: string
}

export type PersonaLoadResult = PersonaLoadSuccess | { ok: false; code: PersonaLoadFailureCode; message: string }

/** 会话侧文案（工具与路由共用）。 */
export function personaSessionMessage(code: 'no-session' | 'not-bound' | 'binding-corrupt', personaId?: string): string {
  if (code === 'no-session') {
    return '无法确定当前会话：本工具只能读取**执行上下文里的真实会话 id**，没有任何 session_id 入参。请在（工作台发起的）AI 会话内调用它。'
  }
  if (code === 'not-bound') {
    return '当前会话没有绑定任何角色（发起会话时选择「无角色」，或没走工作台入口）。角色正文只能按会话绑定读取，不能由调用方指定。'
  }
  return `当前会话的角色绑定记录已损坏（版本不是 ${PERSONA_BINDING_VERSION}，或缺少 personaId/sourceKey/revision 字段${personaId === undefined ? '' : `，记录里的角色是「${personaId}」`}）。这**不等于"没有绑定"**：请新建会话重新选择角色。`
}

/**
 * 绑定一个角色到某个会话（**首次 prompt 之前**由工作台客户端调用）。
 *
 * 幂等/冲突口径（需求 §6.3）：
 * - 没有绑定 → 落库（201）；
 * - 已有**同一角色身份**（逻辑 ID + 来源）→ 幂等返回既有绑定（200），**不覆盖** revision；
 * - 已有**不同角色** → 409：换角色必须新建会话。
 */
export function bindSessionPersona(
  db: DatabaseSync,
  input: { sessionId: unknown; personaId: unknown },
  options: PersonaRootOptions = {},
): PersonaBindResult {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
  if (sessionId === '') {
    return { ok: false, status: 400, code: 'missing-session', message: 'sessionId 必填（要绑定角色的那个会话）。' }
  }
  const personaId = typeof input.personaId === 'string' ? input.personaId.trim() : ''
  if (personaId === '') {
    return {
      ok: false,
      status: 400,
      code: 'missing-persona',
      message: '未选择角色，不写绑定。要清空角色请不要调用绑定接口（默认无角色本来就等于没有绑定行）。',
    }
  }

  const lookupOptions = personaLookupOptions(db, options)
  const platform = options.platform
  /** 绑定时**不带** expectedRevision：这一步就是"登记当前内容"（需求 §6.4）。 */
  const resolved = resolvePersona(personaId, lookupOptions)
  if (resolved.ok === false) {
    return {
      ok: false,
      status: 400,
      code: bindFailureCodeFromResolve(resolved.reason),
      message: personaResolveMessage(personaId, resolved.reason, resolved.diagnostics),
    }
  }

  const existingLookup = readPersonaBinding(db, sessionId)
  if (existingLookup.corrupt) {
    return {
      ok: false,
      status: 409,
      code: 'binding-corrupt',
      message: personaSessionMessage('binding-corrupt'),
    }
  }
  const record: PersonaBindingRecord = {
    version: PERSONA_BINDING_VERSION,
    personaId: resolved.summary.id,
    sourceKey: resolved.summary.sourceKey,
    /** 相对**来源根**的真实文件路径（带 `.md`）：诊断时一眼看出"当时读的是哪个文件"。 */
    relativePath: relative(resolved.sourceRoot, resolved.filePath).split(sep).join('/'),
    revision: resolved.revision,
  }

  const existing = existingLookup.binding
  if (existing !== undefined) {
    if (samePersonaIdentity(existing, record, platform)) {
      /**
       * 同角色：**保持既有绑定不变**（连 revision 都不覆盖）。
       * 文件内容变过时只回一个 `revisionChanged` 让界面能说清"要读新内容请新建会话"。
       */
      return { ok: true, status: 200, binding: existing, created: false, revisionChanged: existing.revision !== record.revision }
    }
    return {
      ok: false,
      status: 409,
      code: 'binding-conflict',
      message: `该会话已绑定角色「${existing.personaId}」（来源 ${existing.sourceKey}），不能再改成「${record.personaId}」。换角色必须**新建会话**（旧会话的绑定保持不变）。`,
      binding: existing,
    }
  }

  writePersonaBinding(db, sessionId, record)
  return { ok: true, status: 201, binding: record, created: true, revisionChanged: false }
}

/**
 * 按会话绑定加载角色正文（工具的唯一入口）。
 *
 * ⚠️ `sessionId` 必须来自**工具的 exec 上下文**。这里刻意不接受 personaId 入参：
 * AI 不能通过传一个 id 去读另一个角色的内容（AX-R04：仅 `exec.sessionId`）。
 */
export function loadSessionPersona(
  db: DatabaseSync,
  sessionId: string | null | undefined,
  options: PersonaRootOptions = {},
): PersonaLoadResult {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id === '') return { ok: false, code: 'no-session', message: personaSessionMessage('no-session') }
  const lookup = readPersonaBinding(db, id)
  if (lookup.missing) return { ok: false, code: 'not-bound', message: personaSessionMessage('not-bound') }
  if (lookup.corrupt || lookup.binding === undefined) {
    return { ok: false, code: 'binding-corrupt', message: personaSessionMessage('binding-corrupt', lookup.sessionId) }
  }
  const binding = lookup.binding
  const lookupOptions = personaLookupOptions(db, options)
  /** 带 `expectedRevision` = AX-R05 的核心：文件变过就拒绝，**不返回新正文**。 */
  const resolved = resolvePersona(binding.personaId, { ...lookupOptions, expectedRevision: binding.revision })
  if (resolved.ok === true) {
    /**
     * ⚠️ **来源身份必须复核**（AX-R05："源丢失明确报错不切其他来源"）。
     *
     * 只比 revision 是不够的：把外部角色目录改到另一个根、或者把同名角色挪进内置库，
     * 都可能让"同一个逻辑 ID"解析到**另一个来源**。若那份内容恰好与绑定时的正文逐字相同，
     * revision 会一致 —— 那时悄悄返回别的来源的正文，正是需求禁止的"静默切源"。
     * 所以来源标识（`sourceKey`）不一致时一律按"源已变"报错。
     */
    if (resolved.summary.sourceKey !== binding.sourceKey) {
      return { ok: false, code: 'source-unavailable', message: personaSourceChangedMessage(binding) }
    }
    const list = listPersonaResources(resolved.resourceDir)
    return {
      ok: true,
      binding,
      summary: resolved.summary,
      document: resolved.document,
      revision: resolved.revision,
      resources: list.resources,
      resourceDiagnostics: list.diagnostics,
      resourceDir: resolved.resourceDir,
      sourceRoot: resolved.sourceRoot,
    }
  }
  if (resolved.reason === 'revision-changed') {
    /** revision 不符还可能是"换了来源"：再确认一次来源身份，把原因报准（不返回任何正文）。 */
    const plain = resolvePersona(binding.personaId, lookupOptions)
    if (plain.ok === true && plain.summary.sourceKey !== binding.sourceKey) {
      return { ok: false, code: 'source-unavailable', message: personaSourceChangedMessage(binding) }
    }
  }
  return { ok: false, code: resolved.reason, message: personaResolveMessage(binding.personaId, resolved.reason, resolved.diagnostics) }
}

export type PersonaResourceToolResult =
  | {
    ok: true
    binding: PersonaBindingRecord
    summary: PersonaSummary
    path: string
    text: string
    bytes: number
    characters: number
    revision: string
    resources: PersonaResourceEntry[]
  }
  | { ok: false; code: PersonaLoadFailureCode | PersonaResourceFailure; message: string }

/**
 * 读一条角色资源（工具入口）。
 *
 * **先校验会话绑定与角色 revision**（需求 §6.4："每次读工具先校验当前会话绑定及角色revision"），
 * 再在 `resolvePersona` 给出的**资源根**里读——调用点绝不自己拼路径。
 */
export function readSessionPersonaResource(
  db: DatabaseSync,
  sessionId: string | null | undefined,
  relativePath: unknown,
  options: PersonaRootOptions = {},
): PersonaResourceToolResult {
  const loaded = loadSessionPersona(db, sessionId, options)
  if (loaded.ok === false) return { ok: false, code: loaded.code, message: loaded.message }
  const read = readPersonaResource(loaded.resourceDir, relativePath, { platform: options.platform })
  if (read.ok === false) return { ok: false, code: read.code, message: read.message }
  return {
    ok: true,
    binding: loaded.binding,
    summary: loaded.summary,
    path: read.path,
    text: read.text,
    bytes: read.bytes,
    characters: read.characters,
    revision: loaded.revision,
    resources: loaded.resources,
  }
}
