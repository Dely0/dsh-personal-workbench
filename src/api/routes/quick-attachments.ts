import { inflateRawSync, inflateSync } from 'node:zlib'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackRequest, readJsonBody, writeJson } from './helpers.js'

const QUICK_ATTACHMENTS_PREFIX = '/api/workbench/quick-attachments'
const MAX_QUICK_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_QUICK_ATTACHMENT_BODY_BYTES = Math.ceil(MAX_QUICK_ATTACHMENT_BYTES * 4 / 3) + 64 * 1024
const MAX_QUICK_ATTACHMENT_TEXT_CHARS = 24000

function xmlText(xml: string): string {
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

function readZipEntry(buffer: Buffer, entryName: string): Buffer | undefined {
  const eocdSig = 0x06054b50
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSig) { eocd = i; break }
  }
  if (eocd < 0) return undefined
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  let cursor = centralOffset
  const end = Math.min(buffer.length, centralOffset + centralSize)
  while (cursor + 46 <= end && buffer.readUInt32LE(cursor) === 0x02014b50) {
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLen = buffer.readUInt16LE(cursor + 28)
    const extraLen = buffer.readUInt16LE(cursor + 30)
    const commentLen = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    if (name === entryName && localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLen = buffer.readUInt16LE(localOffset + 26)
      const localExtraLen = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLen + localExtraLen
      const data = buffer.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data, { finishFlush: 2 }).subarray(0, uncompressedSize)
      return undefined
    }
    cursor += 46 + nameLen + extraLen + commentLen
  }
  return undefined
}

function extractDocxText(buffer: Buffer): string {
  const docXml = readZipEntry(buffer, 'word/document.xml')
  if (docXml === undefined) throw new Error('无法读取 DOCX 正文')
  const text = xmlText(docXml.toString('utf8'))
  if (text === '') throw new Error('DOCX 中没有可提取文字')
  return text
}

function decodePdfLiteral(input: string): string {
  return input
    .replace(/\\([nrtbf()\\])/g, (_m, ch: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[ch] ?? ch))
    .replace(/\\([0-7]{1,3})/g, (_m, octal: string) => String.fromCharCode(parseInt(octal, 8)))
}

function extractPdfText(buffer: Buffer): string {
  const source = buffer.toString('latin1')
  const chunks: string[] = []
  const streamRe = /<<(?:.|\r|\n)*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g
  let match: RegExpExecArray | null
  while ((match = streamRe.exec(source)) !== null) {
    const headerStart = source.lastIndexOf('<<', match.index)
    const header = headerStart >= 0 ? source.slice(headerStart, match.index) : ''
    let data = Buffer.from(match[1], 'latin1')
    if (/\/FlateDecode\b/.test(header)) {
      try { data = inflateSync(data) } catch { continue }
    } else if (/\/(?:DCTDecode|JPXDecode|CCITTFaxDecode)\b/.test(header)) {
      continue
    }
    const text = data.toString('latin1')
    for (const literal of text.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) chunks.push(decodePdfLiteral(literal[1]))
    for (const array of text.matchAll(/\[((?:.|\r|\n)*?)\]\s*TJ/g)) {
      for (const literal of array[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) chunks.push(decodePdfLiteral(literal[1]))
      chunks.push('\n')
    }
  }
  const result = chunks.join(' ').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (result === '') throw new Error('PDF 中没有可提取文字，可能是扫描件或加密文件')
  return result
}

function extractQuickAttachmentText(buffer: Buffer, name: string, mediaType: string): string {
  const lower = name.toLowerCase()
  if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || lower.endsWith('.docx')) return extractDocxText(buffer)
  if (mediaType === 'application/pdf' || lower.endsWith('.pdf')) return extractPdfText(buffer)
  throw new Error('快速录入文档仅支持 PDF 和 DOCX')
}

function truncateQuickAttachmentText(text: string): { content: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  return {
    content: normalized.length > MAX_QUICK_ATTACHMENT_TEXT_CHARS ? normalized.slice(0, MAX_QUICK_ATTACHMENT_TEXT_CHARS) : normalized,
    truncated: normalized.length > MAX_QUICK_ATTACHMENT_TEXT_CHARS,
  }
}

function decodeBase64Body(data: string): Buffer {
  const normalized = data.replace(/\s+/g, '')
  if (normalized === '' || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('invalid base64 data')
  }
  const buffer = Buffer.from(normalized, 'base64')
  const canonical = buffer.toString('base64').replace(/=+$/g, '')
  if (canonical !== normalized.replace(/=+$/g, '')) throw new Error('invalid base64 data')
  return buffer
}

function pathSegments(url: URL, prefix: string): string[] {
  const rest = url.pathname.slice(prefix.length)
  return rest.split('/').filter((part) => part !== '')
}

export function makeQuickAttachmentRoutes(): WebRoute[] {
  return [{
    kind: 'prefix',
    path: QUICK_ATTACHMENTS_PREFIX,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const segments = pathSegments(url, QUICK_ATTACHMENTS_PREFIX)
      if ((req.method ?? 'GET') !== 'POST' || segments.length !== 1 || segments[0] !== 'extract-text') return writeJson(res, 404, { error: 'not found' })
      const body = await readJsonBody(req, MAX_QUICK_ATTACHMENT_BODY_BYTES)
      if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
      const name = typeof body.name === 'string' ? body.name : ''
      const mediaType = typeof body.mediaType === 'string' ? body.mediaType : ''
      const data = typeof body.data === 'string' ? body.data : ''
      if (name.trim() === '' || data === '') return writeJson(res, 400, { error: 'name and data are required' })
      try {
        const buffer = decodeBase64Body(data)
        if (buffer.length > MAX_QUICK_ATTACHMENT_BYTES) return writeJson(res, 413, { error: '文档不能超过 5MB' })
        const { content, truncated } = truncateQuickAttachmentText(extractQuickAttachmentText(buffer, name, mediaType))
        return writeJson(res, 200, { ok: true, name, mediaType, content, truncated, size: buffer.length })
      } catch (error) {
        return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }]
}
