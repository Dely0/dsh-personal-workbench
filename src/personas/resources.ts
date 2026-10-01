/**
 * 角色资源**安全读取**（D11-B / requirements §6.4）。
 *
 * ## 资源是什么
 *
 * 资源位于**与角色文档同目录的同名文件夹**里：
 * `rf/rf-天线测量专家.md` → `rf/rf-天线测量专家/`。
 * 工具只接受**该文件夹内的相对路径**（`workbench_read_persona_resource(path)`）。
 *
 * ## 为什么这里写得这么"啰嗦"
 *
 * 这是一条**只读边界**：读错一个路径就可能把用户机器上根目录外的文件（SSH key、
 * 别项目的源码）读进模型上下文。所以每一道都独立成步、各有明确的拒绝理由，
 * 而不是"一句 `resolve` 之后 `startsWith` 就完事"：
 *
 * 1. **形状拒绝**：绝对路径 / 盘符（`C:`）/ UNC（`\\host\share`）/ POSIX 绝对（`/x`）、
 *    `..` 段、NUL、**任何 `%` 编码**（`%2e%2e` / `%2f` 这类编码绕过）；
 * 2. **前缀逐段 `lstat`**：根 → 中间每一级 → 文件，**任何一级是符号链接/junction 就拒绝**
 *    （即使在根内也拒绝，需求 §6.4）；
 * 3. **`realpath` 复校**：真实路径仍必须位于资源根内（防"根本身是个链接指向别处"这类情形）；
 * 4. **类型白名单**：只允许 `PERSONA_RESOURCE_EXTENSIONS` 里的文本扩展名；
 *    **脚本一律不执行**（只返回文本，且 `.js/.mjs/.py/.ps1` 只在白名单里"可读"）；
 * 5. **体积/编码**：单件 ≤128KiB、解码后 ≤20000 字符；NUL/非法 UTF-8 → 明确拒绝。
 *
 * 所有失败都返回**可读中文原因 + 诊断码**，绝不回退去别处找文件。
 */
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  PERSONA_MAX_DEPTH,
  PERSONA_MAX_RESOURCES,
  PERSONA_RESOURCE_EXTENSIONS,
  PERSONA_RESOURCE_MAX_BYTES,
  PERSONA_RESOURCE_MAX_CHARS,
  type PersonaDiagnostic,
  type PersonaDiagnosticCode,
} from '../shared/persona.js'

export interface PersonaResourceEntry {
  /** 相对于资源文件夹的路径（`/` 分隔）。 */
  path: string
  /** 字节数（真实读到的）。 */
  bytes: number
}

export interface PersonaResourceList {
  resources: PersonaResourceEntry[]
  diagnostics: PersonaDiagnostic[]
}

export type PersonaResourceFailure = PersonaDiagnosticCode | 'not-found'

export type PersonaResourceReadResult =
  | { ok: true; path: string; text: string; bytes: number; characters: number }
  | { ok: false; code: PersonaResourceFailure; message: string }

function reject(code: PersonaDiagnosticCode, message: string): PersonaResourceReadResult {
  return { ok: false, code, message }
}

/**
 * 判定相对资源路径的**形状**（不碰文件系统，可单独表驱动测试）。
 *
 * 返回 `undefined` = 形状合法；否则给可读中文原因。
 */
export function checkPersonaResourcePathShape(relativePath: unknown): string | undefined {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return '资源路径必须是相对路径字符串（例：`resources/checklist.md`）'
  const raw = relativePath.trim()
  if (raw.includes('\0')) return '资源路径含 NUL 字符，拒绝'
  /**
   * ⚠️ **任何百分号都拒绝**（而不是"解码后再判"）。
   *
   * 理由：`%2e%2e%2f` / `%252f` 这类多次编码没有穷尽；而"解码后再判"意味着
   * 判定逻辑必须与解码实现完全同步（差一个变体就漏）。资源文件名里出现 `%` 是极少数，
   * 代价换的是**判定不可被绕过**。这条由测试逐条钉住。
   */
  if (raw.includes('%')) return '资源路径含百分号编码（`%`），按边界一律拒绝（防编码绕过）'
  const unified = raw.replace(/\\/g, '/')
  if (unified.startsWith('/')) return '资源路径必须是相对路径：拒绝 POSIX 绝对路径'
  if (/^[A-Za-z]:/.test(unified)) return '资源路径必须是相对路径：拒绝盘符（如 `C:`）'
  if (/^\/\//.test(raw) || raw.startsWith('\\\\')) return '资源路径必须是相对路径：拒绝 UNC 路径'
  if (isAbsolute(raw)) return '资源路径必须是相对路径：拒绝绝对路径'
  const segments = unified.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return '资源路径含 `..` 段，拒绝（不许越出资源根）'
    if (segment.trim() === '') return '资源路径含空白段，拒绝'
  }
  const last = segments[segments.length - 1]
  if (last === undefined || last === '' || last === '.' || last === '..') return '资源路径没有文件名'
  return undefined
}

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase()
  return PERSONA_RESOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * 逐段 `lstat`：根、每一级中间目录、叶子文件。
 *
 * 任何一级是符号链接/junction 就报错并**指出是哪一级**（"哪一级越界"比"越界了"有用得多）。
 */
function findSymlinkSegment(resourceRoot: string, relativePath: string): string | undefined {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.')
  let current = resourceRoot
  for (const part of parts) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) return current
    } catch {
      /** 不存在的那一级：交给后面的存在性判定去报"找不到"。 */
      return undefined
    }
  }
  return undefined
}

/** 是否位于根内（POSIX 相对路径判定 + Windows 大小写口径）。平台无关的纯函数。 */
export function isInsidePersonaRoot(root: string, candidate: string, platform: string = process.platform): boolean {
  const rel = relative(root, candidate)
  if (rel === '') return true
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false
  if (platform === 'win32') {
    /** Windows 上 `relative` 已经做过大小写折叠（同一个卷才可比），这里再兜一层盘符检查。 */
    if (/^[A-Za-z]:/.test(rel)) return false
  }
  return true
}

/**
 * 读取一条资源。
 *
 * @param resourceRoot 资源根（**必须是** `<...>/<角色名>/` 的绝对路径；调用方负责算出它）。
 * @param relativePath 相对资源根的路径。
 */
export function readPersonaResource(
  resourceRoot: string,
  relativePath: unknown,
  options: { platform?: string } = {},
): PersonaResourceReadResult {
  const platform = options.platform ?? process.platform
  const shapeProblem = checkPersonaResourcePathShape(relativePath)
  if (shapeProblem !== undefined) return reject('resource-invalid-path', shapeProblem)
  const raw = (relativePath as string).trim().replace(/\\/g, '/')
  if (hasAllowedExtension(raw) === false) {
    return reject('resource-unsupported-type', `资源类型不允许：只允许 ${PERSONA_RESOURCE_EXTENSIONS.join(' / ')} 文本文件（脚本不会被工作台执行）`)
  }
  const root = resolve(resourceRoot)
  const candidate = resolve(root, raw)
  if (isInsidePersonaRoot(root, candidate, platform) === false) {
    return reject('resource-invalid-path', '资源路径越出资源根（resolve 之后不在根内），拒绝')
  }
  const symlink = findSymlinkSegment(root, raw)
  if (symlink !== undefined) {
    return reject('resource-invalid-path', `路径中的「${symlink}」是符号链接/junction，按边界拒绝（即使在根内也拒绝）`)
  }
  let realRoot: string
  let realFile: string
  try {
    realRoot = realpathSync(root)
    realFile = realpathSync(candidate)
  } catch {
    return reject('resource-not-found', `资源不存在：${raw}（角色没有同名附件目录，或文件已被删除）`)
  }
  if (isInsidePersonaRoot(realRoot, realFile, platform) === false) {
    return reject('resource-invalid-path', `资源的真实路径越出资源根（realpath 复校失败）：${raw}`)
  }
  let size: number
  try {
    const stat = statSync(realFile)
    if (stat.isFile() === false) return reject('resource-unsupported-type', `资源不是普通文件，拒绝：${raw}`)
    size = stat.size
  } catch {
    return reject('resource-not-found', `资源不存在：${raw}`)
  }
  if (size > PERSONA_RESOURCE_MAX_BYTES) {
    return reject('resource-oversized', `资源 ${size} 字节，超过上限 ${PERSONA_RESOURCE_MAX_BYTES} 字节（128 KiB），拒绝（不静默截断）`)
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(realFile)
  } catch {
    return reject('resource-not-found', `资源读不了：${raw}`)
  }
  /** NUL 字节 = 二进制（先判它，再判严格 UTF-8 解码）。 */
  if (bytes.includes(0)) return reject('resource-binary', `资源含 NUL 字节（二进制文件），拒绝：${raw}`)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return reject('resource-binary', `资源不是合法 UTF-8 文本，拒绝：${raw}`)
  }
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (normalized.length > PERSONA_RESOURCE_MAX_CHARS) {
    return reject('resource-oversized', `资源 ${normalized.length} 字符，超过上限 ${PERSONA_RESOURCE_MAX_CHARS} 字符，拒绝（不静默截断）`)
  }
  return { ok: true, path: raw, text: normalized, bytes: size, characters: normalized.length }
}

/**
 * 列出一个角色的资源清单。
 *
 * 根不存在 → 空清单（**这不是错误**：绝大多数角色没有附件目录）；
 * 超 `PERSONA_MAX_RESOURCES` 或超 `PERSONA_MAX_DEPTH` → 给诊断，**不静默漏项**。
 */
export function listPersonaResources(resourceRoot: string): PersonaResourceList {
  const diagnostics: PersonaDiagnostic[] = []
  const resources: PersonaResourceEntry[] = []
  const rootPath = resolve(resourceRoot)
  let root: string
  try {
    if (lstatSync(rootPath).isSymbolicLink()) {
      return {
        resources: [],
        diagnostics: [{ code: 'resource-skipped-symlink', path: resourceRoot, message: '资源根是符号链接/junction，按边界不读取' }],
      }
    }
    root = realpathSync(rootPath)
  } catch {
    return { resources: [], diagnostics }
  }
  const visit = (dir: string, depth: number): void => {
    if (depth > PERSONA_MAX_DEPTH) {
      diagnostics.push({ code: 'resource-limit', path: dir, message: `资源目录超过 ${PERSONA_MAX_DEPTH} 层，未继续向下列出：${dir}` })
      return
    }
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      diagnostics.push({ code: 'resource-not-found', path: dir, message: `资源目录读不了：${dir}（${error instanceof Error ? error.message : String(error)}）` })
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.name.startsWith('.')) continue
      let isLink = entry.isSymbolicLink()
      if (isLink === false) {
        try {
          isLink = lstatSync(full).isSymbolicLink()
        } catch {
          continue
        }
      }
      if (isLink) {
        diagnostics.push({ code: 'resource-skipped-symlink', path: full, message: `跳过符号链接/junction：${entry.name}` })
        continue
      }
      if (entry.isDirectory()) {
        visit(full, depth + 1)
        continue
      }
      if (entry.isFile() === false) continue
      if (resources.length >= PERSONA_MAX_RESOURCES) {
        diagnostics.push({ code: 'resource-limit', path: dir, message: `资源数达到上限 ${PERSONA_MAX_RESOURCES}，**没有列全**：${resourceRoot}` })
        return
      }
      let bytes = 0
      try {
        bytes = statSync(full).size
      } catch { /* 大小读不到不影响列名 */ }
      resources.push({ path: relative(root, full).split(sep).join('/'), bytes })
    }
  }
  visit(root, 0)
  return { resources, diagnostics }
}
