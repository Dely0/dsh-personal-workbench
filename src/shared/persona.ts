/**
 * 角色（persona）**共享契约**：来源、上限、诊断码、摘要形状。
 *
 * ## 为什么单独成模块而不是塞进 `contracts.ts`
 *
 * `contracts.ts` 是"任务/设置/知识"等**跨域**面；角色域目前只有 T3（库/资源）与
 * T4（绑定/选择器）两个写入者。单独成文件让"角色域的形状"只有一处定义，
 * 同时减少两个子任务对同一个巨型文件的争用（共同执行契约：共享文件串行改）。
 *
 * ## 为什么这些常量必须共享而不是各写一份
 *
 * 上限（20000 / 128KiB / 1000 / 200 / 4 层 / 160）同时出现在**解析器、库发现、
 * 资源读取、摘要**四处。任何一处写另一个数字，就会出现"列表里能看见、加载时被拒"
 * 这类**同一语义两处口径**的 bug —— 本仓最大的 bug 类别（见 dsh-plugin-change 规范）。
 * 所以它们只在这里定义，其余模块一律 import。
 */

/** 正文上限：JS UTF-16 code units（归一换行后）。沿用 agency `customExpertInputSchema.prompt` 契约。 */
export const PERSONA_BODY_MAX_CHARS = 20000
/** 摘要（简介）上限：超出只在摘要里截断并标 `descriptionTruncated`，**不裁正文**。 */
export const PERSONA_DESCRIPTION_MAX_CHARS = 160
/** 角色名上限（与 agency 的 `名称 1–40 字符` 同口径）。 */
export const PERSONA_NAME_MAX_CHARS = 40
/** 单个角色文档的读取上限（读取**之前**判，避免把超大文件整个读进内存）。 */
export const PERSONA_FILE_MAX_BYTES = 256 * 1024
/** 单个资源文件上限。 */
export const PERSONA_RESOURCE_MAX_BYTES = 128 * 1024
/** 资源解码 + 归一换行后的字符上限。 */
export const PERSONA_RESOURCE_MAX_CHARS = 20000
/** 递归发现的最大目录深度（根 = 0，即最多向下 4 层）。 */
export const PERSONA_MAX_DEPTH = 4
/** 最多发现多少个角色文档；超限报告诊断，**不声称读完**。 */
export const PERSONA_MAX_DOCUMENTS = 1000
/** 单个角色的资源最多多少个；超限在清单里给诊断，**不静默漏项**。 */
export const PERSONA_MAX_RESOURCES = 200

/** 资源允许的扩展名（小写，含点）。**执行脚本一律拒绝**，哪怕它是文本。 */
export const PERSONA_RESOURCE_EXTENSIONS: readonly string[] = [
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.ts', '.js', '.mjs', '.py', '.ps1',
]

/** 三个来源标签（摘要里给界面分组用）。 */
export type PersonaSourceKind = 'builtin' | 'user' | 'external'

/**
 * 默认平台口径。
 *
 * ⚠️ **这个模块同时被打进客户端 bundle**（客户端要复用同一把比较尺子：选择器判"是不是同一个角色"
 * 必须与服务端同口径），而**浏览器里没有 `process`** —— 写成默认参数 `platform = process.platform`
 * 会让客户端在运行时报 `ReferenceError: process is not defined`（一进 AI 会话入口就炸）。
 *
 * 所以这里显式判一次存在性：服务端拿真实平台；浏览器退回 `'win32'`（= 大小写不敏感）。
 * 折叠方向在这里不会造成误判：客户端比较的两个值（选择器里的 id、服务端返回的绑定 id）
 * **都来自服务端**，本来就是同一份规范化后的逻辑 ID。
 */
export function defaultPersonaPlatform(): string {
  return typeof process !== 'undefined' && typeof process.platform === 'string' ? process.platform : 'win32'
}

/**
 * 平台相关的大小写口径：Windows 上根与 ID 的比较一律不敏感（需求 §6.1）。
 *
 * ⚠️ 这个函数（以及 `dedupeByPersonaKey`）**住在共享契约里**，不在 `personas/library.ts` ——
 * 因为客户端也要判"选中的角色与既有绑定是不是同一个"（`client/personaPicker.ts`），
 * 而 `library.ts` 会 import `node:fs`（客户端打包不能碰）。同一语义两处实现正是本仓
 * 最大的 bug 类别，所以实现只有这一处，`library.ts` 只做再导出。
 */
export function personaCompareKey(value: string, platform: string = defaultPersonaPlatform()): string {
  const normalized = value.normalize('NFC').replace(/\\/g, '/')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 「按平台口径去重」的通用实现：保序、保原值、按比较键去重（设置层与库层共用一份）。 */
export function dedupeByPersonaKey(values: readonly string[], platform: string = defaultPersonaPlatform()): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '') continue
    const key = personaCompareKey(trimmed, platform)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

/**
 * `sourceKey`：**绑定要记的东西**（T4 用）。
 *
 * - 内置/用户库本身是固定位置，所以是常量；
 * - 外部根**可配置**，配置一改，"同一个 id" 可能指向另一份文件 —— 所以外部来源
 *   必须带**规范根 realpath 的短哈希**，否则"改根"会被静默当成"文件变了"。
 */
export type PersonaSourceKey = string

/**
 * 诊断码（**封闭枚举**：界面/测试按码断言，不按中文文案）。
 *
 * 覆盖解析（AX-R01）、发现（AX-R02/R03）、资源（AX-R06）三组。
 */
export type PersonaDiagnosticCode =
  // ---- 来源级（发现阶段）
  | 'root-missing'
  | 'root-unreadable'
  | 'root-skipped-cycle'
  | 'document-limit'
  | 'depth-limit'
  // ---- 文档级（解析阶段）
  | 'unsupported-frontmatter'
  | 'unsupported-metadata'
  | 'missing-title'
  | 'invalid-title'
  | 'empty-body'
  | 'oversized-body'
  | 'oversized-file'
  | 'not-utf8'
  // ---- 信息级
  | 'description-truncated'
  | 'name-truncated'
  | 'duplicate-id-overridden'
  | 'skipped-readme'
  | 'skipped-hidden'
  | 'skipped-symlink'
  | 'skipped-non-markdown'
  // ---- 资源级
  | 'resource-not-found'
  | 'resource-invalid-path'
  | 'resource-unsupported-type'
  | 'resource-oversized'
  | 'resource-binary'
  | 'resource-limit'
  | 'resource-skipped-symlink'

export interface PersonaDiagnostic {
  /** 出错/被跳过时**至少要能指回**哪一份文档或哪个来源（绝对路径不进 HTTP 摘要，仅服务端诊断用）。 */
  sourceKey?: PersonaSourceKey
  /** 相对所属根的 id（能定位时为它）。 */
  id?: string
  /** 服务端本地绝对路径：**只用于服务端诊断/日志**，路由不得外发（AX-R03）。 */
  path?: string
  code: PersonaDiagnosticCode
  /** 可读中文原因（人能看懂"为什么这份没出现"）。 */
  message: string
}

/** 解析出的角色（成功时的完整形状）。 */
export interface PersonaDocument {
  /** 显示名（H1 或 frontmatter `name`）。 */
  name: string
  /** 简介（frontmatter `description` 优先，否则元信息块里的"建议简介"）。 */
  description: string
  descriptionTruncated: boolean
  /** 分组：frontmatter `group` → 路径首层目录名 → `其他`。 */
  group: string
  /** 工作模式原样文本（如 `只读诊断`）。 */
  mode: string
  /** 建议 emoji（可能为空串）。 */
  emoji: string
  /** 正文（元信息块与可选分隔线之后的内容，已归一换行）。 */
  body: string
}

/**
 * 分组名的**显示名**（2026-10-01）。
 *
 * ## 为什么需要它
 *
 * 内置角色分成两个来源区之后，目录名（也是缺省分组名）是 `generic` / `domain` ——
 * 那是**仓库内部的组织方式**，不该原样出现在中文界面上（用户看到的是
 * "domain 9 个角色"，既不像中文也不知道那是什么）。
 *
 * ⚠️ 这里**只改显示**：目录名、角色 id、`group` 字段一律不动 ——
 * id 是收藏/停用/会话绑定记录里的**持久键**，为了好看去改它就会让既有记录全部失配。
 * 映射表找不到的组名原样返回（用户的用户库/外部目录可以有任意分组名）。
 */
const PERSONA_GROUP_LABELS: Record<string, string> = {
  generic: '通用工作方式',
  domain: '领域岗位',
  testing: '测试',
  engineering: '工程',
  quality: '质量',
  rf: '射频与计量',
  dotnet: 'dotnet',
}

/** 分组显示名（映射表里没有就原样返回，绝不吞掉用户自己的分组名）。 */
export function personaGroupLabel(group: string): string {
  return PERSONA_GROUP_LABELS[group] ?? group
}

/**
 * 分组**展示顺序**（列表按它稳定排序，不靠字典序碰运气）。
 *
 * 通用工作方式排前面：它们是"任何任务都能用的行为约束"，领域岗位是"这件事该由谁来判断"，
 * 先通用再专用更符合选角色的思路。表外的组名按字母序排在最后。
 */
const PERSONA_GROUP_ORDER: readonly string[] = ['generic', 'domain', 'engineering', 'testing', 'quality', 'rf', 'dotnet']

/** 分组排序键（小 → 前；表外的组名按字典序排在表内之后）。 */
export function personaGroupRank(group: string): number {
  const index = PERSONA_GROUP_ORDER.indexOf(group)
  return index === -1 ? PERSONA_GROUP_ORDER.length : index
}

export interface PersonaParseResult {
  ok: boolean
  document?: PersonaDocument
  diagnostics: PersonaDiagnostic[]
}

/** 列表/摘要里的一份角色：**不含正文**（AX-R03：摘要不回正文）。 */
export interface PersonaSummary {
  /** 稳定逻辑 ID = 角色文件相对所属根的路径（去 `.md`、`/` 分隔、NFC）。 */
  id: string
  name: string
  description: string
  /** 简介被截断过（界面标注"摘要已省略"）。 */
  descriptionTruncated: boolean
  group: string
  mode: string
  emoji: string
  source: PersonaSourceKind
  sourceKey: PersonaSourceKey
  /** 是否启用（设置里的 `personaDisabledIds` 取反）。 */
  enabled: boolean
  favorite: boolean
  /** 内容哈希（SHA-256，归一换行后正文）——绑定用，**不是** mtime。 */
  revision: string
}

export interface PersonaListResponse {
  ok: true
  personas: PersonaSummary[]
  diagnostics: PersonaDiagnostic[]
}

/** 资源读取的失败码（HTTP 层按它映射状态码，不按中文文案）。 */
export type PersonaResourceErrorCode = Extract<PersonaDiagnosticCode,
  | 'resource-not-found'
  | 'resource-invalid-path'
  | 'resource-unsupported-type'
  | 'resource-oversized'
  | 'resource-binary'
  | 'resource-limit'
  | 'resource-skipped-symlink'>

// ---------------------------------------------------------------------------
// 会话 ↔ 角色 绑定（D12 / requirements §6.4）
// ---------------------------------------------------------------------------

/** 绑定记录版本。**换版本 = 旧绑定必须被明确拒绝**（不猜、不迁移）。 */
export const PERSONA_BINDING_VERSION = 1

/**
 * `ai_session_registry.note` 里存的**版本化绑定记录**（`scope_code='persona'`、`anchor=sessionId`）。
 *
 * - **不存正文、不存资源**：正文由 `resolvePersona()` 按需读（需求 §6.4）；
 * - `revision` 是**内容哈希**（去 BOM + CRLF 归一的文本 SHA-256），不是 mtime：
 *   文件被改过时绑定必须明确拒绝旧版本，而不是"悄悄读新文件"；
 * - `relativePath` 是**相对所属来源根的真实文件路径**（带 `.md`），
 *   `personaId` 是逻辑 ID（去 `.md`）—— 保留两者只为诊断时能一眼看出"当时读的是哪个文件"。
 */
export interface PersonaBindingRecord {
  version: typeof PERSONA_BINDING_VERSION
  personaId: string
  sourceKey: PersonaSourceKey
  relativePath: string
  revision: string
}

/** HTTP / 工具对外可见的绑定视图（需求 §6.3 的 `bind` 响应形状，**不含相对路径**）。 */
export interface PersonaBindingView {
  personaId: string
  sourceKey: PersonaSourceKey
  revision: string
}

/** 持久化形状（note 列）。字段顺序固定，便于人肉排查与断言。 */
export function serializePersonaBinding(record: PersonaBindingRecord): string {
  return JSON.stringify({
    version: PERSONA_BINDING_VERSION,
    personaId: record.personaId,
    sourceKey: record.sourceKey,
    relativePath: record.relativePath,
    revision: record.revision,
  })
}

/**
 * 解析 note 里的绑定记录。
 *
 * **坏值一律返回 `undefined`**（不抛错、不猜版本）：`note` 列是自由文本，
 * 手改过 meta / 旧版本写过别的形状 / 别的 scope 复用了这一行都可能出现。
 * 调用方据此报"绑定记录损坏"，而不是把它当成"没绑定"或"绑定有效"。
 */
export function parsePersonaBinding(note: unknown): PersonaBindingRecord | undefined {
  if (typeof note !== 'string' || note.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(note)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const raw = parsed as Record<string, unknown>
  if (raw.version !== PERSONA_BINDING_VERSION) return undefined
  const personaId = raw.personaId
  const sourceKey = raw.sourceKey
  const relativePath = raw.relativePath
  const revision = raw.revision
  if (typeof personaId !== 'string' || personaId.trim() === '') return undefined
  if (typeof sourceKey !== 'string' || sourceKey.trim() === '') return undefined
  if (typeof relativePath !== 'string') return undefined
  if (typeof revision !== 'string' || revision.trim() === '') return undefined
  return { version: PERSONA_BINDING_VERSION, personaId, sourceKey, relativePath, revision }
}

/** 记录 → 对外视图。 */
export function personaBindingView(record: PersonaBindingRecord): PersonaBindingView {
  return { personaId: record.personaId, sourceKey: record.sourceKey, revision: record.revision }
}

/** 两个绑定的**角色身份**是否相同（逻辑 ID + 来源）。平台口径由 `personaCompareKey` 统一。 */
export function samePersonaIdentity(
  a: { personaId: string; sourceKey: string },
  b: { personaId: string; sourceKey: string },
  platform: string = defaultPersonaPlatform(),
): boolean {
  return a.sourceKey === b.sourceKey
    && personaCompareKey(a.personaId, platform) === personaCompareKey(b.personaId, platform)
}

/** 资源读取响应：**只回文本**，绝不回绝对路径（AX-R03/R06）。 */
export interface PersonaResourceResponse {
  ok: true
  personaId: string
  /** 相对资源根的路径（`/` 分隔）。 */
  path: string
  text: string
  bytes: number
  characters: number
  revision: string
  /** 资源根里还有哪些文件（相对路径清单，供模型知道"还能读什么"）。 */
  resources: Array<{ path: string; bytes: number }>
  diagnostics: PersonaDiagnostic[]
}
