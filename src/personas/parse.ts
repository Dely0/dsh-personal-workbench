/**
 * 角色文档**纯解析**（D10 / S10 / requirements §6.2）。
 *
 * ## 这个模块的硬约束（AX-R01）
 *
 * **零 FS、零 React、零 DOM、零网络**：它只接受"已经读进来的字符串"。
 * 解析规则要能被表驱动单测穷举（合成 fixture），而任何 `readFileSync` 都会让
 * "解析规则"与"文件系统角落"缠在一起。文件系统那一半在 `library.ts`。
 *
 * ## 形态（与公司 `LS-Skills/personas/` 完全对齐，零改动可读）
 *
 * ```
 * # 天线测量专家
 *
 * > 自定义专家 · 分类 `engineering` · 工作模式：**只读诊断**
 * > 建议 emoji：`📡`　建议简介（`description`，≤160 字符）：
 * > 天线与阵列的测量、判据与根因诊断：……
 *
 * ---
 *
 * ## 身份
 * …正文…
 * ```
 *
 * 规则（逐条对应 requirements §6.2）：
 * 1. UTF-8、去 BOM、CRLF/CR 归一成 LF；
 * 2. **必须有** `# 名称` 一级标题；空名/无正文 → 禁用并给原因；
 * 3. 一级标题之后**连续**的元信息 blockquote（可隔空行，但中间不能出现正文）；
 *    支持既有写法：`分类 \`engineering\``、`工作模式：**只读诊断**`、
 *    `建议 emoji：\`📡\``、`建议简介（…）：` 以及**下一行**的简介正文；
 * 4. 可选 frontmatter **只支持顶层标量** `name/description/group/mode/emoji`（字符串），
 *    有则优先；不支持的 YAML 结构（嵌套/序列/锚点/块标量/对象/标签）→ **禁用该文档并给格式原因**，
 *    不猜测、不静默忽略；
 * 5. 简介最长 160（超长只在**摘要**里省略并标 `descriptionTruncated`，绝不裁正文）；
 * 6. 正文 `.length`（UTF-16 code units、归一换行后）1–20000，超限禁用，不静默裁。
 */
import {
  PERSONA_BODY_MAX_CHARS,
  PERSONA_DESCRIPTION_MAX_CHARS,
  PERSONA_NAME_MAX_CHARS,
  type PersonaDiagnostic,
  type PersonaDocument,
  type PersonaParseResult,
} from '../shared/persona.js'

/** 去 UTF-8 BOM（`\uFEFF`）并归一换行（CRLF / 单个 CR → LF）。 */
export function normalizePersonaText(raw: string): string {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return withoutBom.replace(/\r\n?/g, '\n')
}

/**
 * 取值清洗：去首尾空白、成对的引号/反引号，去 markdown 强调标记。
 *
 * 只用于**元信息字段的值**（`**只读诊断**` → `只读诊断`、`` `📡` `` → `📡`），
 * 不用于正文。
 */
function cleanValue(text: string): string {
  let value = text.trim()
  for (let i = 0; i < 3; i += 1) {
    const before = value
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if (first === last && (first === '"' || first === "'" || first === '`')) {
        value = value.slice(1, -1).trim()
      }
    }
    value = value.replace(/^\*\*(.*)\*\*$/s, '$1').trim()
    if (value === before) break
  }
  return value
}

/** frontmatter 顶层标量允许的键（**封闭**：多一个键就说明作者以为是完整 YAML）。 */
const FRONTMATTER_KEYS = ['name', 'description', 'group', 'mode', 'emoji'] as const

/**
 * 检测**不支持的 YAML 结构**。
 *
 * 明确的判据（宁可禁用也不猜）：行内注释、嵌套映射（`a: b: c`）、序列（`- x`）、
 * 流式集合（`[` / `{`）、锚点别名（`&` / `*`）、块标量（`|` / `>`）、标签（`!`）、
 * 块级序列的键（`key:` 后面没有值）。
 *
 * 我们**不声称**支持完整 YAML —— 出现这些结构时禁用该文档并给格式原因，
 * 因为"猜错了"的后果是把一段正文当成了名称。
 */
function unsupportedYamlReason(valueLine: string): string | undefined {
  if (/^#/.test(valueLine)) return '出现 YAML 注释（本解析器不支持，请删掉注释）'
  if (/^\s*-\s+/.test(valueLine)) return '出现 YAML 序列（本解析器只支持顶层标量）'
  if (/^\s*(?:\.\.\.|---)\s*$/.test(valueLine)) return 'frontmatter 内部出现分隔线'
  if (/^[^:\s][^:]*:\s*$/.test(valueLine)) return '键后面没有值（疑似嵌套映射/块序列，只支持顶层标量）'
  const value = valueLine.slice(valueLine.indexOf(':') + 1).trim()
  if (value === '') return undefined
  /** 行内注释：`x # 说明`（`#` 前必须有空白才算注释，避免误伤 `#标签`）。 */
  if (/\s#/.test(value)) return '出现行内注释（`#`），本解析器不支持 YAML 注释'
  if (/[|>]\s*$/.test(value)) return '出现块标量（`|` / `>`），只支持顶层标量'
  if (/^[&*]/.test(value)) return '出现锚点/别名（`&` / `*`），只支持顶层标量'
  if (/^!/.test(value)) return '出现 YAML 标签（`!`），只支持顶层标量'
  if (/^[[{]/.test(value)) return '出现流式集合（`[]` / `{}`），只支持顶层标量'
  if (/^(["'`]).*\1$/.test(value) === false && /:\s+\S/.test(value)) return '同一行出现第二个冒号（疑似嵌套映射），只支持顶层标量'
  return undefined
}

interface FrontmatterOutcome {
  fields: Record<string, string>
  error?: string
}

/** 解析可选的 frontmatter；返回**字段 + 拒因**（有错就禁用整份文档）。 */
function readFrontmatter(lines: string[]): FrontmatterOutcome | undefined {
  if (lines[0]?.trim() !== '---') return undefined
  const fields: Record<string, string> = {}
  /** 先找结束分隔线：找不到就**明确报"未闭合"**，而不是把后续正文当 YAML 硬解析（那会给出误导性的原因）。 */
  let closeIndex = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---' || lines[i].trim() === '...') { closeIndex = i; break }
  }
  if (closeIndex === -1) return { fields, error: 'frontmatter 没有结束分隔线（`---`）' }
  for (let i = 1; i < closeIndex; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon <= 0) return { fields, error: `frontmatter 第 ${i + 1} 行不是「键: 值」形式：${line.trim()}` }
    const key = line.slice(0, colon).trim()
    if (FRONTMATTER_KEYS.includes(key as (typeof FRONTMATTER_KEYS)[number]) === false) {
      return { fields, error: `frontmatter 键「${key}」不受支持（只支持 ${FRONTMATTER_KEYS.join(' / ')}）` }
    }
    const reason = unsupportedYamlReason(line)
    if (reason !== undefined) return { fields, error: `frontmatter 格式不受支持：${reason}` }
    const rawValue = line.slice(colon + 1).trim()
    /** 显式空标量（`name: ""` / `name: ''`）：那是作者的笔误，禁用而不是"当成没写"。 */
    if (/^(["'])\1$/.test(rawValue)) return { fields, error: `frontmatter 的「${key}」是空字符串` }
    fields[key] = cleanValue(rawValue)
  }
  return { fields }
}

/** 元信息 blockquote 里我们认识的键（用于判断"下一行是延续的简介"还是"另一个字段"）。 */
const META_KEYS = ['分类', '工作模式', '建议 emoji', '建议简介']

function isMetaFieldLine(text: string): boolean {
  return META_KEYS.some((key) => text.includes(key))
}

/**
 * 元信息行的片段拆分。
 *
 * 既有 9 篇里同一个 blockquote 行会写**多个字段**，分隔符既有 `·` / `|`，也有
 * **全角空格**（`建议 emoji：\`📡\`　建议简介（…）：`）。所以按"已知字段标签"切，
 * 而不是按固定分隔符切 —— 否则 emoji 会把后面整段建议简介一起吞掉。
 */
const META_LABELS = {
  /** 顺序 = 匹配优先级（emoji 的取值必须以"下一个字段"为界）。 */
  emoji: ['建议 emoji', '建议 emoji：', 'emoji'],
  description: ['建议简介'],
} as const

interface MetaPiece {
  kind: 'emoji' | 'description' | 'mode' | 'category' | 'text'
  value: string
}

/** 取"从某个标签之后、到下一个字段标签之前"的片段（emoji 的取值因此不会吞掉后面的简介）。 */
function sliceBetweenLabel(text: string, markers: readonly string[]): { rest: string; afterMarker: string } | undefined {
  for (const marker of markers) {
    const index = text.indexOf(marker)
    if (index === -1) continue
    const rest = text.slice(index + marker.length)
    const stops = [rest.indexOf('建议简介'), rest.indexOf('建议 emoji'), rest.indexOf('工作模式'), rest.indexOf('分类')]
      .filter((stop) => stop >= 0)
    const end = stops.length === 0 ? rest.length : Math.min(...stops)
    return { rest: rest.slice(0, end), afterMarker: marker }
  }
  return undefined
}

/** 冒号之后的取值（没有冒号就返回空串）。 */
function valueAfterColon(text: string): string {
  const colon = Math.max(text.lastIndexOf('：'), text.lastIndexOf(':'))
  return colon === -1 ? '' : cleanValue(text.slice(colon + 1))
}

/**
 * 把一行元信息拆成片段。
 *
 * ⚠️ 两个坑都踩过：
 * 1. **不能按固定分隔符切** —— 既有写法里字段之间是**全角空格**（`建议 emoji：\`📡\`　建议简介（…）`）；
 * 2. **不能按第一个冒号拆键值** —— 简介正文自己就带冒号（`…根因诊断：方向图、增益…`）。
 * 所以一律按"已知标签"取，并以"下一个标签"为界。
 */
function metaPieces(text: string): MetaPiece[] {
  const flat = text.replace(/\*\*/g, '')
  const pieces: MetaPiece[] = []
  const description = sliceBetweenLabel(flat, META_LABELS.description)
  if (description !== undefined) {
    const hint = description.rest
    /** 冒号后为空 = 简介在下一行（既有写法：`建议简介（…）：` 换行接正文）。 */
    pieces.push({ kind: 'description', value: valueAfterColon(hint) })
  }
  const emoji = sliceBetweenLabel(flat, META_LABELS.emoji)
  if (emoji !== undefined) pieces.push({ kind: 'emoji', value: valueAfterColon(emoji.rest) })

  for (const [marker, kind] of [['工作模式', 'mode'], ['分类', 'category']] as const) {
    const index = flat.indexOf(marker)
    if (index === -1) continue
    const rest = flat.slice(index + marker.length).replace(/^[\s:：·|]+/, '')
    const stops = [rest.search(/[·|　]/), rest.indexOf('建议简介'), rest.indexOf('建议 emoji'), rest.indexOf('工作模式'), rest.indexOf('分类')]
      .filter((stop) => stop >= 0)
    const end = stops.length === 0 ? rest.length : Math.min(...stops)
    pieces.push({ kind, value: cleanValue(rest.slice(0, end)) })
  }
  if (pieces.length === 0) pieces.push({ kind: 'text', value: cleanValue(flat) })
  return pieces
}

interface MetadataOutcome {
  mode?: string
  emoji?: string
  description?: string
  /** blockquote 原文行（诊断用）。 */
  quoteLines: string[]
  lastQuoteIndex: number
  error?: string
}

/**
 * 读元信息 blockquote 块。
 *
 * 关键取舍：**"连续"是指中间没有正文行**。空行允许穿过（需求明写"可以隔空行"），
 * 而一旦出现非空的非引用行（正文）就结束该块 —— 这样"元信息块之后才是正文"这条边界
 * 不会被正文里的 `>` 引用行破坏。
 */
function readMetadataBlock(lines: string[], startIndex: number): MetadataOutcome {
  const quoteLines: string[] = []
  let lastQuoteIndex = startIndex - 1
  let mode: string | undefined
  let emoji: string | undefined
  let description: string | undefined
  let inDescription = false
  let error: string | undefined

  const pushDescription = (text: string): void => {
    if (text === '') return
    description = description === undefined ? text : `${description} ${text}`
    inDescription = true
  }

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') {
      /** 空行本身不结束元信息块；但"下一个非空行不是引用"就说明块结束了。 */
      let next = i + 1
      while (next < lines.length && lines[next].trim() === '') next += 1
      if (next < lines.length && lines[next].trim().startsWith('>')) continue
      break
    }
    if (line.trim().startsWith('>') === false) break
    lastQuoteIndex = i
    const text = line.trim().replace(/^>+\s?/, '').trim()
    quoteLines.push(text)
    if (text === '') continue
    if (inDescription) {
      if (isMetaFieldLine(text)) {
        error = `元信息块里「建议简介」前面又出现了字段行：${text}`
        break
      }
      pushDescription(text)
      continue
    }
    let matched = false
    for (const piece of metaPieces(text)) {
      if (piece.kind === 'description') {
        matched = true
        if (piece.value !== '') pushDescription(piece.value)
        else inDescription = true
        continue
      }
      if (piece.kind === 'emoji') {
        emoji = piece.value
        matched = true
        continue
      }
      if (piece.kind === 'mode') {
        mode = piece.value
        matched = true
        continue
      }
      /** `分类` 不进摘要形状（§6.3），识别出来只是为了不把它混进简介。 */
      if (piece.kind === 'category') {
        matched = true
        continue
      }
      /** 同一行里剩下的就是简介延续。 */
      if (piece.value !== '') pushDescription(piece.value)
      matched = true
    }
    if (matched === false) pushDescription(text)
  }

  return { mode, emoji, description, quoteLines, lastQuoteIndex, error }
}

/**
 * 解析一份角色文档。
 *
 * @param raw 已经读进来的文本（本函数自己做 BOM/换行归一）。
 */
export function parsePersonaDocument(raw: string): PersonaParseResult {
  const diagnostics: PersonaDiagnostic[] = []
  const text = normalizePersonaText(raw)
  const lines = text.split('\n')

  const frontmatter = readFrontmatter(lines)
  if (frontmatter?.error !== undefined) {
    return {
      ok: false,
      diagnostics: [{ code: 'unsupported-frontmatter', message: frontmatter.error }],
    }
  }
  const fmFields = frontmatter?.fields ?? {}
  let cursor = 0
  if (frontmatter !== undefined) {
    cursor = 1
    while (cursor < lines.length && lines[cursor].trim() !== '---' && lines[cursor].trim() !== '...') cursor += 1
    cursor += 1
  }

  let title: string | undefined
  let titleIndex = -1
  for (let i = cursor; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    const match = /^#\s+(.*)$/.exec(lines[i])
    if (match === null) break
    title = match[1].trim()
    titleIndex = i
    break
  }
  if (titleIndex === -1) {
    return {
      ok: false,
      diagnostics: [{ code: 'missing-title', message: '文档开头没有 `# 名称` 一级标题（角色必须有名称）' }],
    }
  }
  if (title === '') {
    return { ok: false, diagnostics: [{ code: 'invalid-title', message: '一级标题是空的（`#` 后面没有名称）' }] }
  }

  const metadata = readMetadataBlock(lines, titleIndex + 1)
  if (metadata.error !== undefined) {
    return { ok: false, diagnostics: [{ code: 'unsupported-metadata', message: metadata.error }] }
  }

  let bodyStart = metadata.lastQuoteIndex + 1
  while (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart += 1
  if (bodyStart < lines.length && /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(lines[bodyStart])) {
    bodyStart += 1
    while (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart += 1
  }
  /** 去掉正文末尾的空白/换行：它是文件结构而不是内容（长度契约按 `.length` 判定）。 */
  const body = lines.slice(bodyStart).join('\n').trim()
  if (body.trim() === '') {
    return { ok: false, diagnostics: [{ code: 'empty-body', message: '文档没有正文（元信息块之后是空的）' }] }
  }
  if (body.length > PERSONA_BODY_MAX_CHARS) {
    return {
      ok: false,
      diagnostics: [{
        code: 'oversized-body',
        message: `正文 ${body.length} 字符，超过上限 ${PERSONA_BODY_MAX_CHARS} 字符（不静默裁剪，请精简或拆成多篇）`,
      }],
    }
  }

  const heading = title as string
  const fmName = fmFields.name
  const name: string = fmName !== undefined && fmName !== '' ? fmName : heading
  if (name.length > PERSONA_NAME_MAX_CHARS) {
    return {
      ok: false,
      diagnostics: [{
        code: 'invalid-title',
        message: `角色名 ${name.length} 字符，超过上限 ${PERSONA_NAME_MAX_CHARS} 字符`,
      }],
    }
  }

  const fmDescription = fmFields.description ?? ''
  const rawDescription: string = fmDescription !== '' ? fmDescription : (metadata.description ?? '')
  const normalizedDescription = rawDescription.replace(/\s+/g, ' ').trim()
  const truncated = normalizedDescription.length > PERSONA_DESCRIPTION_MAX_CHARS
  const description = truncated ? normalizedDescription.slice(0, PERSONA_DESCRIPTION_MAX_CHARS) : normalizedDescription
  if (truncated) {
    diagnostics.push({
      code: 'description-truncated',
      message: `简介 ${normalizedDescription.length} 字符，超过 ${PERSONA_DESCRIPTION_MAX_CHARS}，摘要里已省略后半段（正文未改）`,
    })
  }

  const document: PersonaDocument = {
    name,
    description,
    descriptionTruncated: truncated,
    /** 分组缺省取**目录一级**，根目录下的文档给「其他」（由库层按 ID 补全）。 */
    group: fmFields.group ?? '',
    mode: (fmFields.mode ?? '') !== '' ? (fmFields.mode as string) : (metadata.mode ?? ''),
    emoji: (fmFields.emoji ?? '') !== '' ? (fmFields.emoji as string) : (metadata.emoji ?? ''),
    body,
  }
  return { ok: true, document, diagnostics }
}
