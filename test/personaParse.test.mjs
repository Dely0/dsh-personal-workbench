/**
 * AX-R01：角色文档**纯解析**（D10 / requirements §6.2）。
 *
 * 这个文件是表驱动的：每条规则一组输入、一个期望，失败信息自带输入形状。
 * 它只 import `lib/personas/parse.js`（纯函数）—— 不需要任何临时目录或文件系统，
 * 这本身就是"解析器不碰 FS"的证明（真碰了，这个文件就跑不起来）。
 *
 * 另外有一条**源码扫描**断言：parser 不得 import React/DOM/fs，避免有人日后
 * "顺手"在里面加一个 `readFileSync`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parsePersonaDocument, normalizePersonaText,
} from '../lib/personas/parse.js'
import {
  PERSONA_BODY_MAX_CHARS, PERSONA_DESCRIPTION_MAX_CHARS, PERSONA_NAME_MAX_CHARS,
} from '../lib/shared/persona.js'

/** 合成 fixture：形态与公司 LS-Skills 的 9 篇一致（但内容自造，不含任何真实私人正文）。 */
function lsSkillsShaped(name = '合成测量专家', extra = {}) {
  const { title = name, quote2 = '> 建议 emoji：`📡`　建议简介（`description`，≤160 字符）：', desc = '天线与阵列的测量、判据与根因诊断：方向图、增益、极化、ECC、静区。', body = '## 身份\n\n你是资深工程师。\n' } = extra
  return `# ${title}\n\n> 自定义专家 · 分类 \`engineering\` · 工作模式：**只读诊断**（读资料、判数据、给结论）\n${quote2}\n> ${desc}\n\n---\n\n${body}`
}

test('AX-R01 标准形态：H1 + 两行 blockquote（含下一行简介）+ 分隔线 + 正文', () => {
  const parsed = parsePersonaDocument(lsSkillsShaped())
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics))
  assert.equal(parsed.document.name, '合成测量专家')
  assert.equal(parsed.document.mode, '只读诊断（读资料、判数据、给结论）')
  assert.equal(parsed.document.emoji, '📡')
  assert.equal(parsed.document.description, '天线与阵列的测量、判据与根因诊断：方向图、增益、极化、ECC、静区。')
  assert.equal(parsed.document.group, '', '分组由路径决定，解析器不猜')
  assert.equal(parsed.document.descriptionTruncated, false)
  assert.match(parsed.document.body, /^## 身份/)
  assert.equal(parsed.document.body.includes('自定义专家'), false, '元信息块不进正文')
  assert.equal(parsed.document.body.includes('---'), false, '分隔线不进正文')
})

test('AX-R01 元信息块允许隔空行（需求 §6.2 明写）', () => {
  const text = '# 甲\n\n> 分类 `engineering`\n\n> 工作模式：**只读**\n> 建议简介：一段简介\n\n正文开始\n'
  const parsed = parsePersonaDocument(text)
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics))
  assert.equal(parsed.document.mode, '只读')
  assert.equal(parsed.document.description, '一段简介')
  assert.equal(parsed.document.body, '正文开始')
})

test('AX-R01 BOM 与 CRLF：去 BOM、归一成 LF，正文长度按归一后算', () => {
  const crlf = '# 甲\r\n\r\n> 分类 `engineering`\r\n> 建议简介：简介\r\n\r\n正文\r\n第二行\r\n'
  const parsed = parsePersonaDocument(`\uFEFF${crlf}`)
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics))
  assert.equal(parsed.document.body.includes('\r'), false, '正文里不许残留 CR')
  assert.equal(parsed.document.body, '正文\n第二行')
  assert.equal(normalizePersonaText('\uFEFFa\r\nb\rc'), 'a\nb\nc')
})

test('AX-R01 frontmatter 顶层标量优先于元信息块', () => {
  const text = [
    '---',
    'name: 前端实现者',
    'description: 从 frontmatter 来的简介',
    'group: engineering',
    'mode: 可动手改代码',
    'emoji: "⚙️"',
    '---',
    '# 元信息块里的名字（应被覆盖）',
    '',
    '> 分类 `engineering` · 工作模式：**只读**',
    '> 建议 emoji：`🔍`　建议简介（`description`，≤160 字符）：',
    '> 元信息块里的简介（应被覆盖）',
    '',
    '正文',
  ].join('\n')
  const parsed = parsePersonaDocument(text)
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics))
  assert.equal(parsed.document.name, '前端实现者')
  assert.equal(parsed.document.description, '从 frontmatter 来的简介')
  assert.equal(parsed.document.group, 'engineering')
  assert.equal(parsed.document.mode, '可动手改代码')
  assert.equal(parsed.document.emoji, '⚙️')
  assert.equal(parsed.document.body, '正文')
})

const FRONTMATTER_REJECTS = [
  ['嵌套映射', ['---', 'name: 甲', 'meta: {a: 1}', '---', '# 甲', '', '正文'].join('\n'), /不受支持|格式/],
  ['未知键', ['---', 'name: 甲', 'tags: x', '---', '# 甲', '', '正文'].join('\n'), /键「tags」不受支持/],
  ['序列', ['---', 'name: 甲', '- x', '---', '# 甲', '', '正文'].join('\n'), /不是「键: 值」|序列/],
  ['块标量', ['---', 'name: 甲', 'description: |', '  多行', '---', '# 甲', '', '正文'].join('\n'), /块标量/],
  ['锚点', ['---', 'name: 甲', 'description: &anchor x', '---', '# 甲', '', '正文'].join('\n'), /锚点/],
  ['别名', ['---', 'name: 甲', 'description: *alias', '---', '# 甲', '', '正文'].join('\n'), /锚点|别名/],
  ['行内注释', ['---', 'name: 甲', 'description: x # comment', '---', '# 甲', '', '正文'].join('\n'), /不受支持|注释/],
  ['未闭合', ['---', 'name: 甲', '# 甲', '', '正文'].join('\n'), /没有结束分隔线/],
  ['空字符串标量', ['---', 'name: ""', '---', '# 甲', '', '正文'].join('\n'), /空字符串/],
  ['键后无值', ['---', 'name:', '---', '# 甲', '', '正文'].join('\n'), /格式不受支持|键后面没有值/],
]
for (const [label, text, pattern] of FRONTMATTER_REJECTS) {
  test(`AX-R01 不支持的 frontmatter → 禁用并给格式原因：${label}`, () => {
    const parsed = parsePersonaDocument(text)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.document, undefined)
    assert.equal(parsed.diagnostics.length, 1)
    assert.equal(parsed.diagnostics[0].code, 'unsupported-frontmatter')
    assert.match(parsed.diagnostics[0].message, pattern)
  })
}

const BAD_DOCS = [
  ['没有 H1（文档以普通文字开头）', '这段文字不是一级标题\n\n正文', 'missing-title'],
  ['先出现正文再出现 H1', '前言\n\n# 甲\n\n正文', 'missing-title'],
  ['空标题', '# \n\n正文', 'invalid-title'],
  ['数字标题不是 H1', '## 甲\n\n正文', 'missing-title'],
  ['没有正文', '# 甲\n\n> 分类 `engineering`\n> 建议简介：简介\n', 'empty-body'],
  ['正文只有空白', '# 甲\n\n   \n\t\n', 'empty-body'],
]
for (const [label, text, code] of BAD_DOCS) {
  test(`AX-R01 坏文档 → 禁用并给可读原因：${label}`, () => {
    const parsed = parsePersonaDocument(text)
    assert.equal(parsed.ok, false, `应被禁用：${label}（实际 name=${parsed.document?.name}）`)
    assert.equal(parsed.document, undefined)
    assert.equal(parsed.diagnostics[0].code, code)
    assert.equal(typeof parsed.diagnostics[0].message, 'string')
    assert.equal(parsed.diagnostics[0].message.length > 0, true)
  })
}

test('AX-R01 正文阈值 20000 严格：恰好 20000 通过、20001 拒绝且不静默裁', () => {
  const at = `# 甲\n\n${'字'.repeat(PERSONA_BODY_MAX_CHARS)}`
  const over = `# 甲\n\n${'字'.repeat(PERSONA_BODY_MAX_CHARS + 1)}`
  const okParsed = parsePersonaDocument(at)
  assert.equal(okParsed.ok, true, JSON.stringify(okParsed.diagnostics))
  assert.equal(okParsed.document.body.length, PERSONA_BODY_MAX_CHARS)
  const overParsed = parsePersonaDocument(over)
  assert.equal(overParsed.ok, false)
  assert.equal(overParsed.diagnostics[0].code, 'oversized-body')
  assert.match(overParsed.diagnostics[0].message, /20001 字符，超过上限 20000/)
})

test('AX-R01 简介阈值 160：只在摘要截断并标 truncated，正文不受影响', () => {
  const long = '简'.repeat(PERSONA_DESCRIPTION_MAX_CHARS + 20)
  const parsed = parsePersonaDocument(`# 甲\n\n> 分类 \`engineering\`\n> 建议简介：${long}\n\n正文一个字都不许少\n`)
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics))
  assert.equal(parsed.document.description.length, PERSONA_DESCRIPTION_MAX_CHARS)
  assert.equal(parsed.document.descriptionTruncated, true)
  assert.equal(parsed.document.body, '正文一个字都不许少', '正文绝不被摘要规则裁掉')
  assert.equal(parsed.diagnostics[0].code, 'description-truncated')
})

test('AX-R01 角色名超 40 字符 → 禁用（与 agency 契约同口径）', () => {
  const parsed = parsePersonaDocument(`# ${'名'.repeat(PERSONA_NAME_MAX_CHARS + 1)}\n\n正文\n`)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.diagnostics[0].code, 'invalid-title')
  assert.match(parsed.diagnostics[0].message, /超过上限 40/)
})

test('AX-R01 元信息块之后出现正文即结束：正文里的 `>` 引用不会被当元信息', () => {
  const text = '# 甲\n\n> 分类 `engineering`\n> 建议简介：简介\n\n正文第一句\n\n> 这是一段正文里的引用，不是元信息\n\n正文第二句\n'
  const parsed = parsePersonaDocument(text)
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics))
  assert.match(parsed.document.body, /^正文第一句/)
  assert.equal(parsed.document.body.includes('这是一段正文里的引用'), true)
})

test('AX-R01 简介前缀后直接换行的形态（真实的 9 篇就是这样）', () => {
  const text = '# 甲\n\n> 自定义专家 · 分类 `engineering` · 工作模式：**只读诊断**\n> 建议简介（`description`，≤160 字符）：\n> 第一行简介\n> 第二行简介\n\n正文\n'
  const parsed = parsePersonaDocument(text)
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics))
  assert.equal(parsed.document.description, '第一行简介 第二行简介')
  assert.equal(parsed.document.mode, '只读诊断')
})

test('AX-R01 纯解析：不 import React/DOM/FS（源码扫描，防止日后顺手加 readFileSync）', () => {
  const source = readFileSync(new URL('../src/personas/parse.ts', import.meta.url), 'utf8')
  /** 注释里允许出现这些词（本文件头就写了"任何 readFileSync"），所以只看**代码行**。 */
  const code = source.split('\n').filter((line) => /^\s*(\/\/|\*|\/\*)/.test(line) === false).join('\n')
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(imports, ['../shared/persona.js'], `parse.ts 只允许 import 共享类型，实际：${imports.join(', ')}`)
  assert.equal(/from\s+'(react|react-dom|node:fs|node:path|node:os)'/.test(code), false, '解析器不得依赖 React/DOM/FS')
  assert.equal(/readFileSync|existsSync|readdirSync/.test(code), false, '解析器不得读文件')
  assert.equal(/document\.|window\./.test(code), false, '解析器不得碰 DOM')
  assert.equal(/import\s*\(/.test(code), false, '解析器不得动态 import（否则源码扫描可以被绕过）')
})

test('AX-R01 解析器是纯函数：不改输入、可重复调用', () => {
  const text = lsSkillsShaped()
  const before = text
  const first = parsePersonaDocument(text)
  const second = parsePersonaDocument(text)
  assert.deepEqual(first, second)
  assert.equal(text, before)
})
