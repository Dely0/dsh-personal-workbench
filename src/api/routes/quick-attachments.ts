/**
 * 快速录入附件解析：把 PDF / DOCX 的正文抽成纯文本，供澄清会话读取。
 *
 * ## 为什么这个文件是"重写"而不是"照抄 fork"
 *
 * fork（`Guojing6/dsh-workbench` 的 `9972ce6`）的实现里有一个**解压炸弹（OOM/DoS）**，
 * 三个错叠加（`docs/2026-09-15-fork-survey.md` 3.6 节，逐行核过）：
 *
 * 1. 两处 `inflate` **都没传 `maxOutputLength`**；
 * 2. `uncompressedSize` 是**从 zip 中央目录读出来的、攻击者可控**的字段；
 * 3. `.subarray(0, uncompressedSize)` 发生在**解压之后** —— 内存里已经躺着整份膨胀结果。
 *
 * 请求体上限 5 MiB、deflate 最大压缩比约 1032:1 ⇒ **一个 5 MB 的恶意 .docx 足以打爆主进程内存**。
 * 端点是 loopback-only，但攻击路径很现实：**别人发你一个文档，你拖进快速录入**。
 *
 * 本实现的三层护栏（缺一不可）：
 *
 * - **解压前**：按中央目录里**声明的** `uncompressedSize` 先拦一道（声明值超限直接拒绝）；
 * - **解压时**：`inflateRawSync/inflateSync(data, { maxOutputLength })` —— zlib 在膨胀**过程中**
 *   就停下，而不是先解出整份再截断；
 * - **解压后**：再复核一次实际长度（防御"声明值撒谎"的压缩包）。
 *
 * 另外两条同源问题也一并改掉：
 *
 * - `Buffer.from(data, 'base64')` 的**宽松**解码（非法字符静默丢弃、长度不校验）→
 *   改为宿主 `admitEncodedImages` 同款 **canonical round-trip 校验**；
 * - PDF 里对每个匹配都 `source.lastIndexOf('<<', match.index)` 回扫是 **O(n²)** →
 *   改成**单向前进**的游标扫描（`indexOf` 的起点单调递增），并把每段字典的窗口限死在 8 KiB。
 *
 * ## 端点
 *
 * `POST /api/workbench/quick-attachments/extract-text`
 * 请求 `{name, mediaType, data(base64)}` → 响应 `{ok, name, mediaType, content, truncated, size}`。
 * loopback-only；失败一律返回**中文原因**。
 */
import { inflateRawSync, inflateSync } from 'node:zlib'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackRequest, readJsonBody, writeJson } from '../http.js'
import {
  MAX_QUICK_ATTACHMENT_BYTES, QUICK_DOCUMENT_MEDIA_TYPES, QUICK_IMAGE_MEDIA_TYPES,
} from '../../shared/quickAttachments.js'

export { MAX_QUICK_ATTACHMENT_BYTES, QUICK_DOCUMENT_MEDIA_TYPES, QUICK_IMAGE_MEDIA_TYPES }

export const QUICK_ATTACHMENTS_PREFIX = '/api/workbench/quick-attachments'

/** 请求体上限：base64 膨胀 4/3 + 一点 JSON 余量。 */
export const MAX_QUICK_ATTACHMENT_BODY_BYTES = Math.ceil(MAX_QUICK_ATTACHMENT_BYTES * 4 / 3) + 64 * 1024

/** 单次解压允许产出的字节上限（32 MiB）—— 解压炸弹的第一道闸。 */
export const MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES = 32 * 1024 * 1024

/** PDF 单条流允许解出的上限（8 MiB）；超出的流几乎都是图片/字体，直接跳过。 */
export const MAX_PDF_STREAM_DECODED_BYTES = 8 * 1024 * 1024

/** PDF 全部流合计允许解出的上限（64 MiB）—— 防止"很多条小炸弹"叠加。 */
export const MAX_PDF_TOTAL_DECODED_BYTES = 64 * 1024 * 1024

/** 一次请求最多处理的 PDF 流数量（同样是工作量上限）。 */
export const MAX_PDF_STREAMS = 4096

/** 每个 `stream` 关键字往前允许回看的字典窗口（把回扫成本钉成常数）。 */
export const PDF_HEADER_WINDOW_BYTES = 16 * 1024

/**
 * 一条内容流里最多抽多少个文本片段（工作量上限）。
 *
 * 这是 fresh-eyes 审查 F1 那条 DoS 的第二道闸：扫描本身已经是 O(n)，
 * 但"解出 8 MiB 的内容流再全量扫一遍"仍是可以被反复触发的固定开销，
 * 所以给片段数一个明确上限，并让它在测试里可断言。
 */
export const MAX_PDF_LITERALS = 20000

/**
 * zlib 的"输出超过 `maxOutputLength`"判定。
 *
 * 为什么要单独判：`ERR_BUFFER_TOO_LARGE` 的 message 是英文原文
 * （`Cannot create a Buffer larger than N bytes`），直接回给中文界面等于没解释。
 * fresh-eyes 审查 F3 就是这么抓到的。
 */
export function isInflateTooLargeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; message?: unknown }
  if (candidate.code === 'ERR_BUFFER_TOO_LARGE') return true
  return typeof candidate.message === 'string' && /larger than \d+ bytes/.test(candidate.message)
}

/** 把 zlib 的英文超限错误翻译成与"声明值"分支同款的中文原因。 */
function tooLargeMessage(limit: number): string {
  return `文档解压后过大（实际超过 ${limit} 字节上限）`
}

/** 抽取正文的字符上限。 */
export const MAX_QUICK_ATTACHMENT_TEXT_CHARS = 24000

export const DOCX_MEDIA_TYPE = QUICK_DOCUMENT_MEDIA_TYPES[1]
export const PDF_MEDIA_TYPE = QUICK_DOCUMENT_MEDIA_TYPES[0]

const ZIP_EOCD_SIG = 0x06054b50
const ZIP_CENTRAL_SIG = 0x02014b50
const ZIP_LOCAL_SIG = 0x04034b50
/** ZIP 结尾注释最大 65535 字节 + EOCD 固定 22 字节 —— 回扫范围只能这么大。 */
const ZIP_EOCD_MAX_SCAN = 22 + 0xffff

/**
 * 严格（canonical）base64 解码。
 *
 * 与宿主 `admitEncodedImages` 同款判据：**解码后再编码必须逐字相等**。
 * `Buffer.from(data, 'base64')` 是宽松的 —— 非法字符会被静默丢弃、长度也不校验，
 * 于是"看起来是 base64"的垃圾能一路走到解析器里。
 */
export function decodeCanonicalBase64(data: string): Buffer {
  if (typeof data !== 'string' || data === '') throw new Error('附件内容为空')
  if (data.length > MAX_QUICK_ATTACHMENT_BODY_BYTES) throw new Error('附件内容超过大小上限')
  const decoded = Buffer.from(data, 'base64')
  if (decoded.toString('base64') !== data) throw new Error('附件不是合法的 base64 编码（含非法字符或长度不合法）')
  return decoded
}

/** 把 DOCX 的 `word/document.xml` 转成纯文本。 */
export function xmlText(xml: string): string {
  return xml
    .replace(/<w:(?:tab|br|cr)\b[^>]*>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 从尾部回扫定位 EOCD；找不到返回 -1。 */
function findZipEocd(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - ZIP_EOCD_MAX_SCAN)
  for (let i = buffer.length - 22; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIG) return i
  }
  return -1
}

/**
 * 从 zip 里取一个条目并解压。
 *
 * 解压护栏见文件头注释：**解压前按声明值拦、解压时带 `maxOutputLength`、解压后复核**。
 */
export function readZipEntry(buffer: Buffer, entryName: string): Buffer | undefined {
  const eocd = findZipEocd(buffer)
  if (eocd < 0) return undefined
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  // 中央目录必须整段落在文件里；伪造的偏移量在这里就被挡掉（否则后面会读到垃圾）。
  if (centralOffset < 0 || centralSize < 0 || centralOffset + centralSize > buffer.length) return undefined
  let cursor = centralOffset
  const end = Math.min(buffer.length, centralOffset + centralSize)
  while (cursor + 46 <= end && buffer.readUInt32LE(cursor) === ZIP_CENTRAL_SIG) {
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLen = buffer.readUInt16LE(cursor + 28)
    const extraLen = buffer.readUInt16LE(cursor + 30)
    const commentLen = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    if (name === entryName) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIG) {
        throw new Error('DOCX 内部结构损坏（本地头找不到）')
      }
      if (method !== 0 && method !== 8) throw new Error(`DOCX 使用了不支持的压缩方式（method=${method}）`)
      /**
       * ① 解压**前**拦：这个值来自中央目录、攻击者可控，所以它是"声明值"而不是"事实"，
       * 但用它先挡掉明显超限的压缩包是完全免费的（连解压都不用做）。
       * ZIP64 的占位值 `0xFFFFFFFF` 也会在这里被拦下（fail closed）。
       */
      if (uncompressedSize > MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES) {
        throw new Error(`文档解压后过大（声明 ${uncompressedSize} 字节，上限 ${MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES} 字节）`)
      }
      const localNameLen = buffer.readUInt16LE(localOffset + 26)
      const localExtraLen = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLen + localExtraLen
      if (dataStart > buffer.length || dataStart + compressedSize > buffer.length) {
        throw new Error('DOCX 数据不完整（压缩数据被截断）')
      }
      // subarray 是**视图**不是拷贝：下面无论是直取还是解压都不会先复制一份。
      const data = buffer.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) {
        if (data.length > MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES) {
          throw new Error(`文档解压后过大（${data.length} 字节，上限 ${MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES} 字节）`)
        }
        return data
      }
      /** ② 解压**时**拦：`maxOutputLength` 让 zlib 在膨胀过程中就停下。 */
      let out: Buffer
      try {
        out = inflateRawSync(data, { maxOutputLength: MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES })
      } catch (error) {
        /**
         * zlib 抛的是英文原文，**不能直接回给中文界面**（fresh-eyes 审查 F3）：
         * 用户拿到 `Cannot create a Buffer larger than 33554432 bytes` 既看不懂，
         * 也无法判断"是文件太大还是坏了、该换什么"。
         */
        if (isInflateTooLargeError(error)) throw new Error(tooLargeMessage(MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES))
        throw new Error(`DOCX 正文解压失败（文件可能已损坏）：${error instanceof Error ? error.message : String(error)}`)
      }
      /** ③ 解压**后**复核：声明值撒谎也拦得住。 */
      if (out.length > MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES) throw new Error(tooLargeMessage(MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES))
      return out
    }
    cursor += 46 + nameLen + extraLen + commentLen
  }
  return undefined
}

/** 抽取 DOCX 正文（`word/document.xml`）。 */
export function extractDocxText(buffer: Buffer): string {
  const docXml = readZipEntry(buffer, 'word/document.xml')
  if (docXml === undefined) throw new Error('无法读取 DOCX 正文（可能不是 .docx，或文件已损坏）')
  const text = xmlText(docXml.toString('utf8'))
  if (text === '') throw new Error('DOCX 中没有可提取的文字')
  return text
}

/** 解 PDF 字符串字面量里的转义（`\n` / `\ooo` 等）。 */
export function decodePdfLiteral(input: string): string {
  return input
    .replace(/\\([nrtbf()\\])/g, (_m, ch: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[ch] ?? ch))
    .replace(/\\([0-7]{1,3})/g, (_m, octal: string) => String.fromCharCode(parseInt(octal, 8)))
}

/** 内容流里可以按"纯文本"读的判定：既没有 Flate 也没有已知的二进制图像滤镜。 */
function isBinaryImageStream(header: string): boolean {
  return /\/(?:DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)\b/.test(header)
}

/**
 * 从 `>>` 往回找出与之**配对**的 `<<`（只在本对象的字典窗口内回扫，代价是常数）。
 *
 * 为什么需要配对而不是"最近的 `<<`"：PDF 字典可以嵌套
 * （`<< /A << /B 1 >> /Filter /FlateDecode >>`），最近的 `<<` 是**内层**的，
 * 从它开始切会把外层的 `/Filter` 切掉 → 该解压的不解压、该跳过的乱码当文本。
 *
 * ⚠️ 更不能"从窗口开头直接切到 `>>`"（这是最初的写法，被 `test/quickAttachments` 里的
 * DCTDecode 样本抓出来）：8 KiB 窗口会跨过**前一个对象**的字典，
 * 于是前一个对象的 `/DCTDecode` 会把当前这条**纯文本**流误判成图片而整条跳过。
 *
 * @returns 配对 `<<` 的起始下标；窗口内找不到返回 -1（调用方按"无法判断"处理）。
 */
function matchingDictStart(source: string, windowStart: number, closeIdx: number): number {
  let depth = 0
  for (let i = closeIdx - 1; i > windowStart; i -= 1) {
    if (source[i] === '>' && source[i - 1] === '>') { depth += 1; i -= 1; continue }
    if (source[i] === '<' && source[i - 1] === '<') {
      if (depth === 0) return i - 1
      depth -= 1
      i -= 1
    }
  }
  return -1
}

const PDF_WHITESPACE = new Set(['\u0000', '\t', '\n', '\f', '\r', ' '])

/**
 * 从一个 `(` 开始读 PDF 字符串字面量。
 *
 * PDF 允许括号嵌套与 `\` 转义，所以必须按深度扫，不能靠"到第一个 `)` 为止"。
 * 转义序列**原样保留**在返回值里，交给 `decodePdfLiteral` 解（与旧实现一致）。
 *
 * @returns 起始位置、结束位置（`)` 之后）与原始字面量内容；未闭合返回 undefined。
 */
function readPdfLiteral(text: string, start: number): { raw: string; end: number } | undefined {
  let depth = 1
  let i = start + 1
  let raw = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      raw += ch + (text[i + 1] ?? '')
      i += 2
      continue
    }
    if (ch === '(') { depth += 1; raw += ch; i += 1; continue }
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return { raw, end: i + 1 }
      raw += ch
      i += 1
      continue
    }
    raw += ch
    i += 1
  }
  return undefined
}

/** 跳过 PDF 空白。 */
function skipPdfWhitespace(text: string, start: number): number {
  let i = start
  while (i < text.length && PDF_WHITESPACE.has(text[i])) i += 1
  return i
}

/** 位置 `i` 之后（允许空白）是否是操作符 `op`，且 `op` 后面不是标识符字符。 */
function isPdfOperatorAfter(text: string, i: number, op: string): boolean {
  const at = skipPdfWhitespace(text, i)
  if (!text.startsWith(op, at)) return false
  const next = text[at + op.length]
  return next === undefined || !/[A-Za-z0-9]/.test(next)
}

/**
 * 按**线性扫描**抽出内容流里的文本（`(…)Tj` 与 `[…]TJ`）。
 *
 * ## ⚠️ 不要改回正则（v1.15.3 修的真 DoS，fresh-eyes 审查 F1）
 *
 * 原写法是两条正则：
 * `/(\((?:\\.|[^\\)])*)\)\s*Tj/g` 与 `/\[((?:.|\r|\n)*?)\]\s*TJ/g`。
 * 第二条里的 `(?:.|\r|\n)*?` 在"大量 `[` 却没有 `]`"的输入上是**灾难性回溯** ——
 * 实测输入字符数翻倍耗时 ×4：8k→45ms、16k→171ms、32k→673ms、64k→2770ms，
 * 3 MiB 样本 300 秒不返回。而 `extractPdfText` 是**同步**函数、跑在宿主 event loop 上，
 * 且客户端在用户**拖入文档的瞬间**就请求这个端点 ⇒ 一个 3 KB 的恶意 pdf
 * 足以让整个 dsh web 无响应（不是"慢"，是没有返回值）。5 MiB 上限与 64 MiB 解码预算
 * 都拦不住它：这不是内存炸弹，是 **CPU / 事件循环炸弹**。
 *
 * 现在的实现是单遍 O(n)、无回溯，并带可测的工作量上限 `MAX_PDF_LITERALS`；
 * 遇到未闭合的 `(` / `[` 直接**停止扫这条流**（继续扫会让开销退化成 O(n²)）。
 *
 * @param text - 一条已解码的内容流（latin1）。
 * @param chunks - 结果累加处（保持旧实现的 `TJ` 组尾部补 `\n` 语义）。
 */
export function pushPdfTextLiterals(text: string, chunks: string[]): void {
  let i = 0
  let pushed = 0
  while (i < text.length && pushed < MAX_PDF_LITERALS) {
    const ch = text[i]
    if (ch === '(') {
      const literal = readPdfLiteral(text, i)
      if (literal === undefined) return
      i = literal.end
      if (isPdfOperatorAfter(text, i, 'Tj')) { chunks.push(decodePdfLiteral(literal.raw)); pushed += 1 }
      continue
    }
    if (ch === '[') {
      const end = findPdfArrayEnd(text, i)
      if (end < 0) return
      const inner = text.slice(i + 1, end)
      for (const literal of collectPdfArrayLiterals(inner)) {
        if (pushed >= MAX_PDF_LITERALS) break
        chunks.push(decodePdfLiteral(literal))
        pushed += 1
      }
      if (isPdfOperatorAfter(text, end + 1, 'TJ')) { chunks.push('\n'); pushed += 1 }
      i = end + 1
      continue
    }
    i += 1
  }
}

/**
 * 找 `[` 的配对 `]`（跳过 `(…)` 里的括号，它们不算数组结构）。
 * `start` 指向 `[`；找不到返回 -1。
 */
function findPdfArrayEnd(text: string, start: number): number {
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '(') {
      const literal = readPdfLiteral(text, i)
      if (literal === undefined) return -1
      i = literal.end
      continue
    }
    if (ch === ']') return i
    i += 1
  }
  return -1
}

/** 抽出数组内部的字符串字面量内容（已跳过转义与嵌套括号）。 */
function collectPdfArrayLiterals(inner: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < inner.length && out.length < MAX_PDF_LITERALS) {
    if (inner[i] !== '(') { i += 1; continue }
    const literal = readPdfLiteral(inner, i)
    if (literal === undefined) break
    out.push(literal.raw)
    i = literal.end
  }
  return out
}

/**
 * 抽取 PDF 正文。
 *
 * ⚠️ **不要改回"每个匹配都回扫"**（fork 的写法）：`lastIndexOf('<<', index)` 对每个
 * `stream` 都从头回扫一次，在 5 MB 字符串上就是 O(n²) —— 和二次解压一样是 DoS 面。
 * 这里每处回看都被 `PDF_HEADER_WINDOW_BYTES` 限死，总代价是 O(n · 常数)。
 */
export function extractPdfText(buffer: Buffer): string {
  const source = buffer.toString('latin1')
  const chunks: string[] = []
  let cursor = 0
  let streams = 0
  let decodedTotal = 0
  let skippedTooLarge = 0
  while (streams < MAX_PDF_STREAMS) {
    const marker = source.indexOf('stream', cursor)
    if (marker < 0) break
    cursor = marker + 'stream'.length
    streams += 1
    const windowStart = Math.max(0, marker - PDF_HEADER_WINDOW_BYTES)
    const before = source.slice(windowStart, marker)
    // `<<…>>` 必须紧贴 `stream`（中间只允许空白）才算一条内容流的字典。
    const dictEnd = before.lastIndexOf('>>')
    if (dictEnd < 0) continue
    if (!/^[\s\0]*$/.test(before.slice(dictEnd + 2))) continue
    const dictStart = matchingDictStart(source, windowStart, windowStart + dictEnd)
    // 配不出字典就**跳过**这条流：宁愿少抽一段文字，也不要把压缩字节当正文读出来。
    if (dictStart < 0) continue
    const header = source.slice(dictStart, windowStart + dictEnd + 2)
    let dataStart = marker + 'stream'.length
    if (source[dataStart] === '\r') dataStart += 1
    if (source[dataStart] === '\n') dataStart += 1
    const endMarker = source.indexOf('endstream', dataStart)
    if (endMarker < 0) break
    let dataEnd = endMarker
    if (source[dataEnd - 1] === '\n') dataEnd -= 1
    if (source[dataEnd - 1] === '\r') dataEnd -= 1
    if (dataEnd <= dataStart) continue
    if (isBinaryImageStream(header)) continue
    let data = Buffer.from(source.slice(dataStart, dataEnd), 'latin1')
    if (/\/FlateDecode\b/.test(header)) {
      /**
       * 护栏：`maxOutputLength` + 解码后复核 + 总量预算，三样都要。
       * 解不出来就跳过这条流（**不做"原始字节当文本"的兜底** —— 那只会产出乱码）；
       * 但"超限"要单独计数，否则一条 PDF 炸弹最后只会得到"可能是扫描件"这种误导性结论。
       */
      try {
        data = inflateSync(data, { maxOutputLength: MAX_PDF_STREAM_DECODED_BYTES })
      } catch (error) {
        if (isInflateTooLargeError(error)) skippedTooLarge += 1
        continue
      }
      if (data.length > MAX_PDF_STREAM_DECODED_BYTES) { skippedTooLarge += 1; continue }
      decodedTotal += data.length
      if (decodedTotal > MAX_PDF_TOTAL_DECODED_BYTES) break
    }
    pushPdfTextLiterals(data.toString('latin1'), chunks)
  }
  const result = chunks.join(' ').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (result === '') {
    throw new Error(skippedTooLarge > 0
      ? `PDF 里有 ${skippedTooLarge} 条内容流解压后超过单条上限（${MAX_PDF_STREAM_DECODED_BYTES} 字节），已跳过；没有可提取的文字`
      : 'PDF 中没有可提取的文字，可能是扫描件或加密文件')
  }
  return result
}

/** 按 mediaType / 扩展名分派抽取实现；不支持的类型给中文原因。 */
export function extractQuickAttachmentText(buffer: Buffer, name: string, mediaType: string): string {
  const lower = name.toLowerCase()
  if (mediaType === DOCX_MEDIA_TYPE || lower.endsWith('.docx')) return extractDocxText(buffer)
  if (mediaType === PDF_MEDIA_TYPE || lower.endsWith('.pdf')) return extractPdfText(buffer)
  throw new Error('快速录入文档仅支持 PDF 和 DOCX')
}

/** 归一化换行并按字符上限截断（`truncated` 会回给界面，用户能看出内容不全）。 */
export function truncateQuickAttachmentText(text: string): { content: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  const truncated = normalized.length > MAX_QUICK_ATTACHMENT_TEXT_CHARS
  return { content: truncated ? normalized.slice(0, MAX_QUICK_ATTACHMENT_TEXT_CHARS) : normalized, truncated }
}

/** 解析一次请求体；纯函数便于单测（路由只做 HTTP 层的事）。 */
export function parseQuickAttachmentRequest(body: Record<string, unknown> | undefined): { ok: true; name: string; mediaType: string; buffer: Buffer } | { ok: false; status: number; error: string } {
  if (body === undefined) return { ok: false, status: 400, error: '请求体不是合法 JSON' }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const mediaType = typeof body.mediaType === 'string' ? body.mediaType : ''
  const data = typeof body.data === 'string' ? body.data : ''
  if (name === '' || data === '') return { ok: false, status: 400, error: 'name 和 data 都是必填项' }
  if (name.length > 260) return { ok: false, status: 400, error: '文件名过长' }
  let buffer: Buffer
  try {
    buffer = decodeCanonicalBase64(data)
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : String(error) }
  }
  if (buffer.length > MAX_QUICK_ATTACHMENT_BYTES) {
    return { ok: false, status: 413, error: `文档不能超过 5MB（当前 ${buffer.length} 字节）` }
  }
  return { ok: true, name, mediaType, buffer }
}

export function makeQuickAttachmentRoutes(): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: QUICK_ATTACHMENTS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.slice(QUICK_ATTACHMENTS_PREFIX.length).split('/').filter((part) => part !== '')
        if ((req.method ?? 'GET') !== 'POST' || rest.length !== 1 || rest[0] !== 'extract-text') {
          return writeJson(res, 404, { error: 'not found' })
        }
        const declaredLength = Number(req.headers['content-length'] ?? '')
        if (Number.isFinite(declaredLength) && declaredLength > MAX_QUICK_ATTACHMENT_BODY_BYTES) {
          return writeJson(res, 413, { error: `请求体过大（上限约 ${Math.round(MAX_QUICK_ATTACHMENT_BODY_BYTES / 1024 / 1024)}MB，文档本身最大 5MB）` })
        }
        const body = await readJsonBody(req, MAX_QUICK_ATTACHMENT_BODY_BYTES)
        if (body === undefined) {
          return writeJson(res, 413, { error: `请求体过大或不是合法 JSON（上限约 ${Math.round(MAX_QUICK_ATTACHMENT_BODY_BYTES / 1024 / 1024)}MB，文档本身最大 5MB）` })
        }
        const parsed = parseQuickAttachmentRequest(body)
        if (!parsed.ok) return writeJson(res, parsed.status, { error: parsed.error })
        try {
          const { content, truncated } = truncateQuickAttachmentText(extractQuickAttachmentText(parsed.buffer, parsed.name, parsed.mediaType))
          return writeJson(res, 200, { ok: true, name: parsed.name, mediaType: parsed.mediaType, content, truncated, size: parsed.buffer.length })
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}
