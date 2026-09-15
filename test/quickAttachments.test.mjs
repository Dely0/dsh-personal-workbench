/**
 * 快录附件解析的护栏单测（v1.15.1）。
 *
 * ## 这份测试防的是 fork 那个**解压炸弹**（调研文档 3.6）
 *
 * fork 的写法有三个错叠加：
 * 1. `inflateRawSync/inflateSync` **没传 `maxOutputLength`**；
 * 2. `uncompressedSize` 是**从 zip 中央目录读出来的、攻击者可控**的字段；
 * 3. `.subarray(0, uncompressedSize)` 在**解压之后** —— 内存里已经躺着整份膨胀结果。
 *
 * deflate 最大压缩比约 1030:1，所以**一个 5 MB 的恶意 .docx 足以打爆主进程内存**。
 *
 * 断言分三层，对应三道护栏（缺一道就会漏）：
 * - **解压前**：声明值超限 → 报"解压后过大"，且**根本没碰 zlib**（用故意损坏的压缩数据证明）；
 * - **解压时**：声明值撒谎 → `maxOutputLength` 让 zlib 抛 `ERR_BUFFER_TOO_LARGE`（实测确认）；
 * - **解压后**：复核实际长度（防御声明值为 0 之类的伪造）。
 *
 * 「不 OOM」的判据：① 调用**抛错而不是返回大缓冲**；② `process.memoryUsage().external`
 * 的增量被压在哨兵值以内（`Buffer` 走 external 而不是 heap，所以**只看 heapUsed 会漏报** ——
 * 这一点是 `probe-zlib-maxoutput.mjs` 实测出来的：无护栏解出 512 MiB 时 heapUsed 只涨了 4 MiB）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync, deflateSync } from 'node:zlib'
import {
  MAX_QUICK_ATTACHMENT_BYTES,
  MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES,
  decodeCanonicalBase64,
  extractDocxText,
  extractPdfText,
  extractQuickAttachmentText,
  parseQuickAttachmentRequest,
  readZipEntry,
  truncateQuickAttachmentText,
  xmlText,
} from '../lib/api/routes/quick-attachments.js'

// ---------------------------------------------------------------- zip 构造工具

/** 组装一个最小可用的 zip（本地头 + 数据 + 中央目录 + EOCD），只放一个条目。 */
function buildZip(entryName, data, options = {}) {
  const method = options.method ?? 8
  const stored = options.stored ?? data
  const declaredUncompressed = options.declaredUncompressed ?? stored.length
  const nameBuf = Buffer.from(entryName, 'utf8')
  const head = Buffer.alloc(30)
  head.writeUInt32LE(0x04034b50, 0)
  head.writeUInt16LE(20, 4)
  head.writeUInt16LE(0, 6)
  head.writeUInt16LE(method, 8)
  head.writeUInt32LE(0, 14)
  head.writeUInt32LE(stored.length, 18)
  head.writeUInt32LE(declaredUncompressed, 22)
  head.writeUInt16LE(nameBuf.length, 26)
  head.writeUInt16LE(0, 28)
  const local = Buffer.concat([head, nameBuf, stored])

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(method, 10)
  central.writeUInt32LE(0, 16)
  central.writeUInt32LE(stored.length, 20)
  central.writeUInt32LE(declaredUncompressed, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt32LE(0, 42)
  const centralDir = Buffer.concat([central, nameBuf])

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(local.length, 16)
  return Buffer.concat([local, centralDir, eocd])
}

/**
 * 解压炸弹样本的明文大小。
 *
 * ⚠️ 这里**刻意不放在模块顶层**：第一版写的是两个模块级 `Buffer.alloc(512 * 1024 * 1024)`，
 * 于是**每个测试文件进程一加载就立刻吃 1 GiB**（`pnpm test` 默认并发跑 20+ 个文件）。
 * 现在按需构建一次、只留压缩后的小块（几百 KB），明文临时缓冲用完即可被 GC。
 *
 * 取值要求：**必须显著大于** `MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES`（32 MiB），
 * 否则"解压炸弹"样本根本没超过上限，测试会变成假绿 —— 下面有用例专门断言这条。
 */
const BOMB_PLAINTEXT_BYTES = 128 * 1024 * 1024

/** 惰性构建的压缩炸弹（缓存，避免每个用例都压一遍 128 MiB）。 */
let bombCompressedCache
function bombCompressed() {
  if (bombCompressedCache === undefined) {
    const plaintext = Buffer.alloc(BOMB_PLAINTEXT_BYTES, 0x41)
    bombCompressedCache = deflateRawSync(plaintext)
  }
  return bombCompressedCache
}

const buildDocx = (documentXml) => buildZip('word/document.xml', deflateRawSync(Buffer.from(documentXml, 'utf8')))

// ---------------------------------------------------------------- 正常路径

test('quickAttachments: 正常 DOCX 能抽出正文', () => {
  const docx = buildDocx('<w:document><w:body><w:p><w:r><w:t>周五接待重要客户</w:t></w:r></w:p><w:p><w:r><w:t>准备材料</w:t></w:r></w:p></w:body></w:document>')
  const text = extractDocxText(docx)
  assert.match(text, /周五接待重要客户/)
  assert.match(text, /准备材料/)
  assert.ok(text.includes('\n'), '段落之间必须换行，否则正文粘成一坨')
})

test('quickAttachments: 正常 PDF 能抽出正文（含 FlateDecode 与字面量转义）', () => {
  const content = 'BT /F1 12 Tf (Hello workbench) Tj [(Line1) -20 (Line2)] TJ ET'
  const stream = deflateSync(Buffer.from(content, 'latin1'))
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ])
  const text = extractPdfText(pdf)
  assert.match(text, /Hello workbench/)
  assert.match(text, /Line1/)
  assert.match(text, /Line2/)
})

test('quickAttachments: PDF 里的图像滤镜（DCTDecode）被跳过，不会产出乱码', () => {
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /DCTDecode >>\nstream\n', 'latin1'),
    Buffer.from('\xFF\xD8\xFF\xE0(binary garbage)Tj', 'latin1'),
    Buffer.from('\nendstream\n2 0 obj\n<< >>\nstream\n(Qualified text) Tj\nendstream\n%%EOF', 'latin1'),
  ])
  const text = extractPdfText(pdf)
  assert.match(text, /Qualified text/)
  assert.equal(text.includes('binary garbage'), false, 'JPEG 流必须整条跳过')
})

test('quickAttachments: PDF 字典必须按"配对括号"取，而不是取最近/最远的 <<', () => {
  /**
   * 两种错法都能被这个样本抓出来：
   * - 取**最近**的 `<<`（内层）→ 切掉外层的 `/Filter /FlateDecode` → 压缩数据被当文本读；
   * - 从窗口开头切到 `>>` → 会把**前一个对象**的 `/DCTDecode` 带进来 → 本条纯文本流被误跳。
   */
  const nestedFlat = deflateSync(Buffer.from('(nested dict text) Tj', 'latin1'))
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /DCTDecode >>\nstream\n\xFF\xD8image\nendstream\n', 'latin1'),
    Buffer.from('2 0 obj\n<< /Type /XObject << /Subtype /Image >> /Filter /FlateDecode /Length ' + nestedFlat.length + ' >>\nstream\r\n', 'latin1'),
    nestedFlat,
    Buffer.from('\r\nendstream\n%%EOF', 'latin1'),
  ])
  const text = extractPdfText(pdf)
  assert.match(text, /nested dict text/, '嵌套字典里的 /Filter 必须被识别出来并解压')
})

test('quickAttachments: PDF 里没有 <<…>> 紧贴 stream 的内容不会被当正文（不做"猜"）', () => {
  const pdf = Buffer.from('%PDF-1.4\nstream\n(Raw not a dict) Tj\nendstream\n%%EOF', 'latin1')
  assert.throws(() => extractPdfText(pdf), /没有可提取的文字/)
})

test('quickAttachments: xmlText 处理制表/换行/实体', () => {
  assert.equal(xmlText('<w:p><w:r><w:t>a</w:t></w:r><w:br/><w:r><w:t>&amp;b</w:t></w:r></w:p>'), 'a\n&b')
})

// ---------------------------------------------------------------- 护栏 1：解压前按声明值拦

test('quickAttachments: 解压炸弹（声明值超限）被**解压前**拦下，且根本没调用 zlib', () => {
  /**
   * 关键构造：`stored` 是**故意损坏的数据**（不是合法 deflate）。
   * 如果护栏生效（先按声明值拦），报错必须是"解压后过大"；
   * 如果实现是先解压再判（fork 的写法），报错会是 zlib 的解压错误 ——
   * 于是这条断言**能区分"解压前拦"与"解压后拦"**，而不是只看有没有报错。
   */
  const docx = buildZip('word/document.xml', Buffer.from('not a deflate stream at all'), {
    method: 8,
    stored: Buffer.from('not a deflate stream at all'),
    declaredUncompressed: MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES + 1,
  })
  assert.throws(
    () => extractDocxText(docx),
    (error) => {
      assert.match(String(error.message), /解压后过大/, `必须是声明值护栏报的错，实际：${error.message}`)
      assert.match(String(error.message), new RegExp(String(MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES)), '原因里要写清上限')
      return true
    },
  )
})

test('quickAttachments: ZIP64 占位值（0xFFFFFFFF）按 fail-closed 处理', () => {
  const docx = buildZip('word/document.xml', bombCompressed(), { declaredUncompressed: 0xffffffff })
  assert.throws(() => extractDocxText(docx), /解压后过大/)
})

test('quickAttachments: 炸弹样本自检 —— 它必须真的超过解压上限，否则下面全是假绿', () => {
  assert.ok(
    BOMB_PLAINTEXT_BYTES >= MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES * 2,
    `炸弹明文 ${BOMB_PLAINTEXT_BYTES} 必须 ≥ 上限的 2 倍（${MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES} × 2），否则"被拦下"只说明样本太小`,
  )
  assert.ok(bombCompressed().length < 2 * 1024 * 1024, '压缩后应当很小（否则"压缩炸弹"这个前提不成立）')
  assert.ok(/A{1000}/.test(deflateRawSync(Buffer.from('A'.repeat(1000))).toString('latin1')) === false)
})

// ---------------------------------------------------------------- F1 回归：PDF 文本抽取必须是线性

test('回归 F1：`[` 未闭合的对抗性 PDF 必须在上限内返回（不许 O(n²) 卡死事件循环）', () => {
  /**
   * fresh-eyes 审查 F1 的实测：旧实现用 `/\[((?:.|\r|\n)*?)\]\s*TJ/g`，
   * 输入字符数翻倍耗时 ×4（8k→45ms、16k→171ms、32k→673ms、64k→2770ms），
   * 3 MiB 样本 300 秒不返回 —— 而这是**同步**函数、跑在宿主 event loop 上。
   *
   * 断言写成"耗时随规模**近似线性**"而不是"小于某个绝对毫秒数"：
   * 绝对阈值会在慢机器上假红，比值不会。
   */
  const timeFor = (repeats) => {
    const inner = '['.repeat(repeats) + ' TJ '
    const stream = deflateSync(Buffer.from(inner, 'latin1'))
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
      stream, Buffer.from('\nendstream\n%%EOF\n', 'latin1'),
    ])
    const started = process.hrtime.bigint()
    try { extractPdfText(pdf) } catch { /* 抛错也算"返回了" */ }
    return Number(process.hrtime.bigint() - started) / 1e6
  }
  // 预热一次，避免把首次 JIT/解压开销算进小样本
  timeFor(4000)
  const small = Math.max(timeFor(32000), 0.5)
  const big = timeFor(256000)   // 规模 ×8
  assert.ok(
    big < small * 80,
    `规模 ×8 后耗时 ${big.toFixed(1)}ms vs 基准 ${small.toFixed(1)}ms —— 超过线性太多，疑似回退成 O(n²)（旧实现是 ×64）`,
  )
  // 同时钉住绝对可接受上限：对抗性输入必须在 2 秒内返回
  const started = Date.now()
  timeFor(1024 * 1024)
  assert.ok(Date.now() - started < 2000, `1 MiB 对抗性输入耗时 ${Date.now() - started}ms，超过 2 秒上限`)
})

test('回归 F1：幂等的文本抽取结果（线性扫描与旧正则行为一致）', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nstream\nBT (Hello \\050world\\051) Tj [(A) -20 (B)] TJ ET\nendstream\n%%EOF', 'latin1')
  const text = extractPdfText(pdf)
  assert.match(text, /Hello \(world\)/, 'PDF 字面量里的八进制转义要继续解对')
  assert.match(text, /A/)
  assert.match(text, /B/)
})

// ---------------------------------------------------------------- 护栏 2/3：解压时 + 解压后

test('quickAttachments: 解压炸弹（声明值撒谎）被 maxOutputLength 拦下且不 OOM', () => {
  const docx = buildZip('word/document.xml', bombCompressed(), {
    declaredUncompressed: 1024, // 撒谎：真实膨胀远超上限
  })
  const beforeExternal = process.memoryUsage().external
  const beforeRss = process.memoryUsage().rss
  let thrown
  try {
    const out = readZipEntry(docx, 'word/document.xml')
    // 真的解出来了 → 说明护栏失效（这条分支必须不可达）
    assert.fail(`解压炸弹没有被拦下，产出了 ${out?.length} 字节`)
  } catch (error) {
    thrown = error
  }
  const externalGrowth = process.memoryUsage().external - beforeExternal
  const rssGrowth = process.memoryUsage().rss - beforeRss
  assert.ok(thrown !== undefined)
  /**
   * 判据从"抛的是不是 zlib 的 `ERR_BUFFER_TOO_LARGE`"改成了**文案区分**：
   * F3 修复后 zlib 的原始错误已经被翻译成中文，错误码不再外泄。
   * 而"实际超过 N 字节上限"这句话**只有** `maxOutputLength` 那条路会产生
   * （声明值那条路说的是"声明 N 字节"）—— 所以它同样能证明"解压时"的护栏生效了，
   * 又不会把"错误可读性"这条要求重新破坏掉。
   */
  assert.match(String(thrown.message), /实际超过 \d+ 字节上限/,
    `期望"解压时"护栏（maxOutputLength）报的错，实际：${thrown.name} ${thrown.message}`)
  assert.equal(/Cannot create a Buffer/.test(String(thrown.message)), false, '不许泄漏 zlib 英文原文')
  /**
   * 不 OOM 的哨兵：无护栏实现会真的分配整份明文（且**走 external 而不是 heap**，
   * 所以只看 heapUsed 会漏报 —— 这一点是 `.pwtest/probe-zlib-maxoutput.mjs` 实测出来的）。
   * 取"明文的一半"：护栏下最多只解到 32 MiB，远低于它；无护栏则至少要到明文大小，必然超标。
   */
  const SENTINEL = BOMB_PLAINTEXT_BYTES / 2
  assert.ok(externalGrowth < SENTINEL, `external 内存增长 ${Math.round(externalGrowth / 1024 / 1024)}MiB，超过哨兵值 ${Math.round(SENTINEL / 1024 / 1024)}MiB —— 护栏没生效`)
  assert.ok(rssGrowth < SENTINEL, `RSS 增长 ${Math.round(rssGrowth / 1024 / 1024)}MiB，超过哨兵值 ${Math.round(SENTINEL / 1024 / 1024)}MiB —— 护栏没生效`)
})

test('回归 F3：解压超限必须给**中文**原因，不许把 zlib 的英文原文甩给用户', () => {
  /**
   * fresh-eyes 审查 F3 的实测：`inflate*Sync` 抛的是
   * `Cannot create a Buffer larger than 33554432 bytes`（`ERR_BUFFER_TOO_LARGE`），
   * 旧实现直接把它回给 HTTP → 中文界面弹一句英文内部错误，用户无法判断该换什么。
   */
  const docx = buildZip('word/document.xml', bombCompressed(), { declaredUncompressed: 2048 })
  assert.throws(
    () => extractDocxText(docx),
    (error) => {
      assert.match(String(error.message), /解压后过大/, `必须翻译成我们自己的中文文案，实际：${error.message}`)
      assert.match(String(error.message), /[\u4e00-\u9fff]/, '必须含中文')
      assert.equal(/Cannot create a Buffer|ERR_BUFFER_TOO_LARGE/.test(String(error.message)), false,
        '不许泄漏 zlib 的英文原文 / 错误码')
      assert.match(String(error.message), new RegExp(String(MAX_QUICK_ATTACHMENT_UNCOMPRESSED_BYTES)), '要写清上限')
      return true
    },
  )
  // PDF 侧同样是中文（超限的流被跳过，最后给一句说明而不是"可能是扫描件"）
  const pdfBomb = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n', 'latin1'),
    deflateSync(Buffer.alloc(16 * 1024 * 1024, 0x41)),
    Buffer.from('\nendstream\n%%EOF', 'latin1'),
  ])
  assert.throws(
    () => extractPdfText(pdfBomb),
    (error) => {
      assert.match(String(error.message), /[\u4e00-\u9fff]/)
      assert.equal(/Cannot create a Buffer/.test(String(error.message)), false)
      return true
    },
  )
})

test('quickAttachments: 完整炸弹 DOCX（含 XML 外壳）经统一入口也被拒', () => {
  const docx = buildZip('word/document.xml', bombCompressed(), { declaredUncompressed: 2048 })
  assert.throws(() => extractQuickAttachmentText(docx, 'bomb.docx', ''), /解压后过大/)
})

test('quickAttachments: 结构损坏的 zip 一律给中文原因，不抛底层异常', () => {
  assert.throws(() => extractDocxText(Buffer.from('not a zip at all')), /无法读取 DOCX 正文/)
  const truncated = buildDocx('<w:p><w:t>x</w:t></w:p>').subarray(0, 20)
  assert.throws(() => extractDocxText(truncated), /DOCX/)
})

test('quickAttachments: 不支持的压缩方式（method=12 bzip2）明确拒绝', () => {
  const zip = buildZip('word/document.xml', Buffer.from('x'), { method: 12 })
  assert.throws(() => extractDocxText(zip), /不支持的压缩方式/)
})

// ---------------------------------------------------------------- canonical base64

test('quickAttachments: base64 必须是 canonical（宽松解码是 fork 的另一个坑）', () => {
  const good = Buffer.from('hello').toString('base64')
  assert.equal(decodeCanonicalBase64(good).toString('utf8'), 'hello')
  // 非法字符被 Buffer.from 静默丢弃 → 必须当场拒绝
  assert.throws(() => decodeCanonicalBase64('aGVs!!!bG8='), /不是合法的 base64/)
  // 长度不合法（缺 padding / 多余字符）
  assert.throws(() => decodeCanonicalBase64('aGVsbG8'), /不是合法的 base64/)
  assert.throws(() => decodeCanonicalBase64('aGVsbG8=' + 'AA'), /不是合法的 base64/)
  assert.throws(() => decodeCanonicalBase64(''), /附件内容为空/)
})

// ---------------------------------------------------------------- 请求解析与截断

test('quickAttachments: 请求解析给出 400/413 与中文原因', () => {
  assert.deepEqual(parseQuickAttachmentRequest(undefined), { ok: false, status: 400, error: '请求体不是合法 JSON' })
  assert.equal(parseQuickAttachmentRequest({ name: '', data: 'eA==' }).status, 400)
  assert.equal(parseQuickAttachmentRequest({ name: 'a.pdf', data: '' }).status, 400)
  assert.equal(parseQuickAttachmentRequest({ name: 'a.pdf', data: '!!!' }).status, 400)
  assert.match(parseQuickAttachmentRequest({ name: 'a.pdf', data: '!!!' }).error, /base64/)

  const tooBig = Buffer.alloc(MAX_QUICK_ATTACHMENT_BYTES + 1, 0x41).toString('base64')
  const verdict = parseQuickAttachmentRequest({ name: 'big.pdf', data: tooBig })
  assert.equal(verdict.status, 413, '超限必须是 413（不是笼统的 400）')
  assert.match(verdict.error, /不能超过 5MB/)
  assert.match(verdict.error, /字节/)

  const okVerdict = parseQuickAttachmentRequest({ name: 'a.docx', mediaType: 'x', data: Buffer.from('hi').toString('base64') })
  assert.equal(okVerdict.ok, true)
  assert.equal(okVerdict.buffer.toString('utf8'), 'hi')
})

test('quickAttachments: 正文按 24000 字符截断并回执 truncated', () => {
  // 只归一化换行与首尾空白；连续空行的折叠是 DOCX/PDF 抽取阶段的事，这里不动内容
  const short = truncateQuickAttachmentText('  a\r\n\r\n\r\nb  ')
  assert.deepEqual(short, { content: 'a\n\n\nb', truncated: false })
  const long = truncateQuickAttachmentText('x'.repeat(30000))
  assert.equal(long.content.length, 24000)
  assert.equal(long.truncated, true)
})

test('quickAttachments: 只支持 PDF/DOCX，其它类型给中文原因', () => {
  assert.throws(() => extractQuickAttachmentText(Buffer.from('x'), 'a.txt', 'text/plain'), /仅支持 PDF 和 DOCX/)
})
