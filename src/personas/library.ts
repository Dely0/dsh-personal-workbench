/**
 * 三级角色库发现（D11-A / S10 / requirements §6.1、§6.3）。
 *
 * ## 三级来源与优先级
 *
 * | 来源 | 位置 | 可写 | `sourceKey` |
 * |---|---|---|---|
 * | 内置 | 包内 `assets/personas/`（`lib/personas/library.js` → `../../assets/personas`） | 只读 | `builtin` |
 * | 用户 | `<home>/.dsh/workbench/personas/` | 用户自己放文档 | `user:<根哈希>` |
 * | 外部 | 设置项 `personaExternalDir`（默认空，如公司内部的 `personas/` 目录） | **只读**，工作台从不写 | `external:<根哈希>` |
 *
 * **同逻辑路径（ID）覆盖顺序：用户 > 外部 > 内置。**
 * **同显示名但不同相对路径 = 两个不同角色**，绝不按名称合并（需求 §6.1）。
 *
 * ## 为什么 `sourceKey` 带根哈希
 *
 * 外部根是**可配置**的：用户把 `personaExternalDir` 从 A 改到 B 之后，
 * "同一个 id" 可能指向另一份完全不同的文件。绑定要记住"当时读的是哪个来源"
 * （T4），所以来源身份必须**把根算进去** —— 否则改根会被静默当成"文件内容变了"。
 * 根不存在时也要有稳定身份（配置写错时绑定仍可解释），所以哈希取自
 * **规范化路径字符串**（`realpath` 只在存在时才能算，不能作为身份依据）。
 *
 * ## 边界（AX-R02/R03）
 *
 * - 递归最多 `PERSONA_MAX_DEPTH`（4）层，最多 `PERSONA_MAX_DOCUMENTS`（1000）篇；
 *   超限**报告诊断**，不声称读完；
 * - 排除 `README.md`（大小写不敏感）、隐藏目录/文件、**所有符号链接与 junction**、
 *   以及"与角色同名目录"里的附件；
 * - 根不存在/无权限 → **只禁用该来源**，其余来源照常；**不自动创建外部目录**；
 * - 不复制、不派生、不修改任何来源里的文件。
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve, sep } from 'node:path'
import {
  PERSONA_FILE_MAX_BYTES,
  PERSONA_MAX_DEPTH,
  PERSONA_MAX_DOCUMENTS,
  personaCompareKey,
  dedupeByPersonaKey,
  type PersonaDiagnostic,
  type PersonaDocument,
  type PersonaSourceKind,
  type PersonaSourceKey,
  type PersonaSummary,
} from '../shared/persona.js'
import { normalizePersonaText, parsePersonaDocument } from './parse.js'

/**
 * 平台口径的比较/去重**唯一实现在 `shared/persona.ts`**（客户端也要用同一把尺子，
 * 而本模块会 import `node:fs`，客户端打包不能碰）。这里只再导出，保持既有 import 路径可用。
 */
export { personaCompareKey, dedupeByPersonaKey }

/** 工作台在用户主目录下的落盘根（与 `db/database.ts` 的 `~/.dsh/workbench` 同根）。 */
export function defaultUserPersonaRoot(home: string = homedir()): string {
  return join(home, '.dsh', 'workbench', 'personas')
}

/** 包内置角色库的根（`lib/personas/library.js` → 包根 `assets/personas`）。 */
export function defaultBuiltinPersonaRoot(moduleUrl: string = import.meta.url): string {
  return resolve(fileURLToPath(new URL('../../assets/personas', moduleUrl)))
}

export interface PersonaLibrarySource {
  kind: PersonaSourceKind
  root: string
}

export interface PersonaLibraryOptions {
  /** 内置库根；缺省包内 `assets/personas`。 */
  builtinDir?: string
  /** 用户库根；缺省 `~/.dsh/workbench/personas`。 */
  userDir?: string
  /** 外部角色目录（设置项）；空串/undefined = 未配置（该来源不参与）。 */
  externalDir?: string
  /** 收藏的 ID（设置项，去重后传入）。 */
  favorites?: readonly string[]
  /** 被禁用的 ID（设置项，去重后传入）。 */
  disabledIds?: readonly string[]
  /** 判"大小写不敏感"的平台（测试可传 `win32`）；缺省 `process.platform`。 */
  platform?: string
}

/**
 * 测试/运维用的**根覆盖**（显式指定三级根）。
 *
 * 为什么留这个注入口而不是让测试去改 `homedir()`：`homedir()` 读的是 OS 真实主目录，
 * 不认传进来的环境变量；没有注入口，"用户库覆盖内置"这条覆盖顺序就**没法用真实文件测**
 * （本仓对"能测的语义"一贯不留只能读代码的角落）。生产调用点不传它。
 */
export interface PersonaRootOverrides {
  builtinDir?: string
  userDir?: string
}

/** 稳定的**逻辑 ID**：相对所属根的路径，去 `.md`、分隔符统一 `/`、Unicode NFC。 */
export function personaIdFromRelativePath(relativePath: string): string {
  const unified = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const withoutExt = unified.toLowerCase().endsWith('.md') ? unified.slice(0, -3) : unified
  return withoutExt.normalize('NFC')
}

/** 分组缺省：**路径首层目录名**；根目录下的文档给「其他」（需求 §6.2）。 */
export function personaGroupForId(id: string, explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : '其他'
}

/** 根身份短哈希：取**规范化路径**的 SHA-256 前 12 位（根不存在也稳定）。 */
export function sourceKeyForRoot(kind: PersonaSourceKind, root: string, platform: string = process.platform): PersonaSourceKey {
  if (kind === 'builtin') return 'builtin'
  const canonical = personaCompareKey(resolve(root), platform)
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)
  return `${kind}:${hash}`
}

/**
 * 内容哈希（SHA-256，hex）。
 *
 * 哈希的是**归一换行、去 BOM 之后**的文本 —— 与 `parse.ts` 的入参口径逐条一致。
 * 这样"同一份内容"必然同哈希，绑定才能做"文件有没有变"的判定（T4/AX-R05）。
 */
export function revisionOfText(normalizedText: string): string {
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex')
}

interface WalkResult {
  docs: string[]
  diagnostics: PersonaDiagnostic[]
  skippedReadme: number
  skippedHidden: number
  skippedSymlink: number
  skippedOther: number
}

/**
 * 递归收集某根下的 `.md`。
 *
 * 计数型跳过（README/隐藏/链接/非 md）只汇总成**每个来源一条**诊断 ——
 * 逐文件刷屏会把真正的错误（读不了/没标题）淹掉。
 */
function walkPersonaRoot(root: string, platform: string, sourceKey: PersonaSourceKey): WalkResult {
  const result: WalkResult = { docs: [], diagnostics: [], skippedReadme: 0, skippedHidden: 0, skippedSymlink: 0, skippedOther: 0 }
  let realRoot: string
  try {
    realRoot = resolve(root)
    if (lstatSync(realRoot).isSymbolicLink()) {
      result.diagnostics.push({ sourceKey, code: 'root-skipped-cycle', message: `来源根是符号链接/junction，按边界整根跳过：${root}` })
      return result
    }
    if (lstatSync(realRoot).isDirectory() === false) {
      result.diagnostics.push({ sourceKey, code: 'root-missing', message: `来源根不是目录，已只禁用该来源：${root}` })
      return result
    }
  } catch (error) {
    result.diagnostics.push({
      sourceKey,
      code: 'root-missing',
      message: `来源根不可达，已**只禁用该来源**（其余来源照常）：${root}（${error instanceof Error ? error.message : String(error)}）`,
    })
    return result
  }

  /**
   * @param resourceDirName 上一层传下来的"资源同名目录"名（已归一）。该目录整棵子树跳过 ——
   *   需求 §6.1：资源同名目录里的附件不算角色文档。
   */
  const visit = (dir: string, depth: number, resourceDirName: string | undefined): void => {
    if (depth > PERSONA_MAX_DEPTH) {
      result.diagnostics.push({ sourceKey, code: 'depth-limit', path: dir, message: `目录深度超过 ${PERSONA_MAX_DEPTH} 层，已停止向下发现：${dir}` })
      return
    }
    if (resourceDirName !== undefined) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      result.diagnostics.push({ sourceKey, code: 'root-unreadable', path: dir, message: `目录读不了，已跳过：${dir}（${error instanceof Error ? error.message : String(error)}）` })
      return
    }
    /** 本层哪些名字是"角色文档同名目录"（大小写/Unicode 口径按平台）。 */
    const docStems = new Set<string>()
    for (const entry of entries) {
      if (entry.isFile() && isMarkdownFile(entry.name) && entry.name.toLowerCase() !== 'readme.md') {
        docStems.add(personaCompareKey(entry.name.slice(0, -3), platform))
      }
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.name.startsWith('.')) {
        result.skippedHidden += 1
        continue
      }
      let isLink = entry.isSymbolicLink()
      if (isLink === false) {
        try {
          isLink = lstatSync(full).isSymbolicLink()
        } catch {
          result.skippedOther += 1
          continue
        }
      }
      /** 链接/junction **一律跳过**（即使在根内），需求 §6.1/§6.4。 */
      if (isLink) {
        result.skippedSymlink += 1
        continue
      }
      if (entry.isDirectory()) {
        if (docStems.has(personaCompareKey(entry.name, platform))) {
          visit(full, depth + 1, entry.name.normalize('NFC'))
          continue
        }
        visit(full, depth + 1, undefined)
        continue
      }
      if (entry.isFile() === false) {
        result.skippedOther += 1
        continue
      }
      if (isMarkdownFile(entry.name) === false) {
        result.skippedOther += 1
        continue
      }
      if (entry.name.toLowerCase() === 'readme.md') {
        result.skippedReadme += 1
        continue
      }
      if (result.docs.length >= PERSONA_MAX_DOCUMENTS) {
        result.diagnostics.push({
          sourceKey,
          code: 'document-limit',
          path: dir,
          message: `角色文档数达到上限 ${PERSONA_MAX_DOCUMENTS}，**没有读完**该来源：${root}`,
        })
        return
      }
      result.docs.push(full)
    }
  }

  visit(realRoot, 0, undefined)

  const aggregated: Array<[number, PersonaDiagnostic['code'], string]> = [
    [result.skippedReadme, 'skipped-readme', 'README.md（不是角色文档）'],
    [result.skippedHidden, 'skipped-hidden', '隐藏文件/目录'],
    [result.skippedSymlink, 'skipped-symlink', '符号链接/junction'],
    [result.skippedOther, 'skipped-non-markdown', '非 `.md` 文件或特殊文件'],
  ]
  for (const [count, code, label] of aggregated) {
    if (count === 0) continue
    result.diagnostics.push({ sourceKey, code, path: realRoot, message: `${root}：跳过 ${count} 项${label}` })
  }
  return result
}

function isMarkdownFile(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}

/** 读取单个角色文档（读取前先判大小；解析交给纯解析器）。 */
export function readPersonaDocumentFile(path: string): { ok: true; document: PersonaDocument; revision: string } | { ok: false; diagnostics: PersonaDiagnostic[] } {
  let size: number
  try {
    size = lstatSync(path).size
  } catch (error) {
    return { ok: false, diagnostics: [{ code: 'root-unreadable', path, message: `文件读不了：${path}（${error instanceof Error ? error.message : String(error)}）` }] }
  }
  if (size > PERSONA_FILE_MAX_BYTES) {
    return {
      ok: false,
      diagnostics: [{
        code: 'oversized-file',
        path,
        message: `文件 ${size} 字节，超过上限 ${PERSONA_FILE_MAX_BYTES} 字节，未读取（不静默截断）`,
      }],
    }
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return { ok: false, diagnostics: [{ code: 'root-unreadable', path, message: `文件读不了：${path}（${error instanceof Error ? error.message : String(error)}）` }] }
  }
  const parsed = parsePersonaDocument(raw)
  if (parsed.ok === false || parsed.document === undefined) {
    return { ok: false, diagnostics: parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, path })) }
  }
  return { ok: true, document: parsed.document, revision: revisionOfText(normalizePersonaText(raw)) }
}

export interface PersonaDiscovery {
  /** 实际参与的顺序（用户 > 外部 > 内置）。 */
  sources: PersonaLibrarySource[]
  /** 按覆盖顺序排好的角色摘要（**不含正文**）。 */
  personas: PersonaSummary[]
  diagnostics: PersonaDiagnostic[]
}

/**
 * 发现三级角色库。
 *
 * 同 ID 冲突时**保留优先级更高的那个**，并留下 `duplicate-id-overridden` 诊断
 * （"谁把谁盖住了"必须可解释；AX-R02）。
 */
export function discoverPersonas(options: PersonaLibraryOptions = {}): PersonaDiscovery {
  const platform = options.platform ?? process.platform
  const sources: PersonaLibrarySource[] = []
  const userDir = options.userDir ?? defaultUserPersonaRoot()
  if (userDir !== '') sources.push({ kind: 'user', root: userDir })
  const externalDir = (options.externalDir ?? '').trim()
  if (externalDir !== '') sources.push({ kind: 'external', root: externalDir })
  sources.push({ kind: 'builtin', root: options.builtinDir ?? defaultBuiltinPersonaRoot() })

  const favorites = new Set(dedupeByPersonaKey(options.favorites ?? [], platform).map((id) => personaCompareKey(id, platform)))
  const disabled = new Set(dedupeByPersonaKey(options.disabledIds ?? [], platform).map((id) => personaCompareKey(id, platform)))

  const diagnostics: PersonaDiagnostic[] = []
  const byKey = new Map<string, PersonaSummary>()
  const order: PersonaSummary[] = []

  for (const source of sources) {
    const sourceKey = sourceKeyForRoot(source.kind, source.root, platform)
    const walked = walkPersonaRoot(source.root, platform, sourceKey)
    diagnostics.push(...walked.diagnostics)
    const rootResolved = resolve(source.root)
    for (const path of walked.docs) {
      const rel = relative(rootResolved, resolve(path)).split(sep).join('/')
      const id = personaIdFromRelativePath(rel)
      const read = readPersonaDocumentFile(path)
      if (read.ok === false) {
        diagnostics.push(...read.diagnostics.map((diagnostic) => ({ ...diagnostic, id, sourceKey })))
        continue
      }
      const summary: PersonaSummary = {
        id,
        name: read.document.name,
        description: read.document.description,
        descriptionTruncated: read.document.descriptionTruncated,
        group: personaGroupForId(id, read.document.group),
        mode: read.document.mode,
        emoji: read.document.emoji,
        source: source.kind,
        sourceKey,
        enabled: disabled.has(personaCompareKey(id, platform)) === false,
        favorite: favorites.has(personaCompareKey(id, platform)),
        revision: read.revision,
      }
      const key = personaCompareKey(id, platform)
      const existing = byKey.get(key)
      if (existing === undefined) {
        byKey.set(key, summary)
        order.push(summary)
        continue
      }
      /** 覆盖顺序：用户 > 外部 > 内置（sources 已按该顺序遍历，先到者优先）。 */
      diagnostics.push({
        sourceKey: summary.sourceKey,
        id,
        code: 'duplicate-id-overridden',
        message: `同一逻辑路径「${id}」在 ${summary.source} 与 ${existing.source} 都存在；按 用户 > 外部 > 内置 采用 ${existing.source} 那份`,
      })
    }
  }
  return { sources, personas: order, diagnostics }
}

/** 按 ID 在发现结果里找一份摘要（平台口径）。 */
export function findPersonaSummary(discovery: PersonaDiscovery, id: string, platform: string = process.platform): PersonaSummary | undefined {
  const key = personaCompareKey(id, platform)
  return discovery.personas.find((persona) => personaCompareKey(persona.id, platform) === key)
}

export type PersonaResolveFailure =
  /** 库里没有这个 id（不是"读不到文件"，两者诊断不同）。 */
  | 'not-found'
  /** 该来源已不可达（根被删/改名/配置被改）——**不切到别的来源**。 */
  | 'source-unavailable'
  /** 文件内容与摘要时的 revision 不一致（文件被改过）。 */
  | 'revision-changed'
  /** 文档现在解析不过（被改坏了）。 */
  | 'invalid-document'

export type PersonaResolveResult =
  | {
    ok: true
    summary: PersonaSummary
    document: PersonaDocument
    revision: string
    /** 来源库根 + 同名附件目录（`<...>/<name>/`），供资源读取限定范围。 */
    sourceRoot: string
    filePath: string
    resourceDir: string
    diagnostics: PersonaDiagnostic[]
  }
  | { ok: false; reason: PersonaResolveFailure; diagnostics: PersonaDiagnostic[] }

/**
 * **按 ID 解析一份角色（含正文）** —— 角色读取的唯一入口。
 *
 * ## 为什么必须走同一条路（而不是各处自己 walk 一遍）
 *
 * id 是**逻辑路径**，它到物理路径的映射依赖三件事：三级来源、平台大小写口径、
 * 同名目录排除规则。任何调用点自己拼一遍路径，就必然出现"列表里是这个、加载时读到那个"
 * 这类**同一语义两处实现**。所以这里把 discover + 定位 + 读文件 + 比对 revision
 * 全部收在一处，对外只暴露一个函数。
 *
 * ## revision 语义（T4 绑定要靠它）
 *
 * - 传 `expectedRevision` 且不一致 → `revision-changed`，**不返回新正文**（不偷偷读新文件）；
 * - 不传 → 返回当前 revision（用于"首次绑定/登记"）。
 *
 * @param noSweep 供"已知 id 精确解析"用：只做一次发现，不做二次定位扫描。
 */
export function resolvePersona(
  id: string,
  options: PersonaLibraryOptions & { expectedRevision?: string } = {},
): PersonaResolveResult {
  const platform = options.platform ?? process.platform
  const discovery = discoverPersonas(options)
  const summary = findPersonaSummary(discovery, id, platform)
  if (summary === undefined) {
    return {
      ok: false,
      reason: 'not-found',
      diagnostics: discovery.diagnostics.filter((diagnostic) => diagnostic.id === undefined || personaCompareKey(diagnostic.id, platform) === personaCompareKey(id, platform)),
    }
  }
  const source = discovery.sources.find((candidate) => candidate.kind === summary.source)
  if (source === undefined) {
    return { ok: false, reason: 'source-unavailable', diagnostics: [] }
  }
  const sourceKey = sourceKeyForRoot(source.kind, source.root, platform)
  const walked = walkPersonaRoot(source.root, platform, sourceKey)
  const rootResolved = resolve(source.root)
  const found = walked.docs.find((path) =>
    personaCompareKey(personaIdFromRelativePath(relative(rootResolved, resolve(path)).split(sep).join('/')), platform) === personaCompareKey(id, platform))
  if (found === undefined) {
    return {
      ok: false,
      reason: 'source-unavailable',
      diagnostics: [{
        sourceKey,
        id,
        code: 'root-missing',
        message: `角色「${id}」的来源（${summary.source}）已不可达：${source.root}。已明确报错，**不切换到其他来源**。`,
      }],
    }
  }
  const read = readPersonaDocumentFile(found)
  if (read.ok === false) {
    return { ok: false, reason: 'invalid-document', diagnostics: read.diagnostics.map((diagnostic) => ({ ...diagnostic, id, sourceKey })) }
  }
  if (options.expectedRevision !== undefined && options.expectedRevision !== read.revision) {
    return {
      ok: false,
      reason: 'revision-changed',
      diagnostics: [{
        sourceKey,
        id,
        path: found,
        code: 'root-unreadable',
        message: `角色「${id}」的文件内容已变化（revision ${read.revision.slice(0, 12)} ≠ 绑定时的 ${options.expectedRevision.slice(0, 12)}）。已**明确拒绝旧绑定**，请新建会话重新选择角色。`,
      }],
    }
  }
  return {
    ok: true,
    summary,
    document: read.document,
    revision: read.revision,
    sourceRoot: rootResolved,
    filePath: found,
    /** 与文档同名的附件目录：`rf/rf-天线测量专家.md` → `rf/rf-天线测量专家/`。 */
    resourceDir: join(found.slice(0, -3)),
    diagnostics: [...discovery.diagnostics, ...walked.diagnostics],
  }
}
