/**
 * 链接政策（P0：点外部链接导致 DSH 白屏，2026-10-01）—— **会失败的测试**。
 *
 * 事故形态：`MarkdownText` 直接渲染 `<a href="...">`，点击即导航宿主文档。
 * Web 端页面不可用；桌面端文档 URL 是 `dsh-app://app/…`，相对/协议相对/`dsh-app:` 的 href
 * 解析后仍是 `dsh-app:` 协议 —— 桌面主进程的 `will-navigate` 闸**只拦非 dsh-app 目标**，
 * 于是真导航发生 → `dsh-app://app/<未知路径>` 被转发给本地 host → 404/空页 → 白屏，
 * 且桌面壳没有地址栏/后退，刷新只是重发同一个坏 URL → **不可恢复**。
 *
 * 因此这里钉住三条：
 *
 * | 编号 | 不变量 | 为什么 |
 * |---|---|---|
 * | L1 | 只有 `http(s)` 才是 `external`，其余一切都 `inert` | "能导航宿主文档"的 href 集合必须**有界** |
 * | L2 | `inert` 的链接**不产出可导航 token**（解析层就没有 `<a>` 的来源） | 判据只有一处实现 |
 * | L3 | 点击只有一个开法：未加修饰键左键 → preventDefault + open | 与宿主 `dsh-web-frontend` 逐字同构 |
 *
 * 外加源码级扫描（"不存在第二处"只能扫出来）：组件里不许再自己判 href；
 * 全仓唯一的 `<a>` 必须带 `target`/`rel`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'
import { handleExternalLinkClick, projectLink } from '../lib/client/externalLink.js'
import { parseInline } from '../lib/client/inlineMarkdown.js'

// ── L1：判据表 ────────────────────────────────────────────────────────────────

const EXTERNAL = [
  ['https://github.com/Dely0/dsh-personal-workbench/blob/main/README.md', 'https://github.com/Dely0/dsh-personal-workbench/blob/main/README.md'],
  ['http://127.0.0.1:8080/a.md', 'http://127.0.0.1:8080/a.md'],
  ['HTTPS://Example.COM/A', 'https://example.com/A'],
  ['  https://a.b/c  ', 'https://a.b/c'],
]

const INERT = [
  // —— 本次事故的主犯：在 `dsh-app://app/…` 文档里，这些都会解析成 dsh-app: 导航 ——
  ['README.md', 'not-absolute'],
  ['./README.md', 'not-absolute'],
  ['../docs/a.md', 'not-absolute'],
  ['/docs/a.md', 'not-absolute'],
  ['//evil.example.com/x', 'not-absolute'],
  ['dsh-app://app/README.md', 'protocol:dsh-app:'],
  // —— 其它不该能点的 ——
  ['', 'empty'],
  ['   ', 'empty'],
  ['javascript:alert(1)', 'protocol:javascript:'],
  ['JavaScript:alert(1)', 'protocol:javascript:'],
  ['data:text/html,<b>x</b>', 'protocol:data:'],
  ['file:///D:/Code/a.md', 'protocol:file:'],
  ['mailto:a@b.c', 'protocol:mailto:'],
  ['https://user:pw@example.com/x', 'credentials'],
  ['不是链接', 'not-absolute'],
]

test('L1：只有 http(s) 才判 external —— 其余一律 inert（相对路径在桌面端就是白屏）', () => {
  for (const [raw, href] of EXTERNAL) {
    const link = projectLink(raw)
    assert.equal(link.kind, 'external', `${raw} 应当可点`)
    assert.equal(link.href, href, `${raw} 的规范化 href`)
    assert.equal(link.target, '_blank', '外链必须 _blank（绝不开进宿主文档）')
    assert.equal(link.rel, 'noopener noreferrer')
    assert.equal(link.because, 'http(s)')
  }
  for (const [raw, because] of INERT) {
    const link = projectLink(raw)
    assert.equal(link.kind, 'inert', `${JSON.stringify(raw)} 不该可点（判据应为 ${because}）`)
    assert.equal(link.href, '', 'inert 不许带 href')
    assert.equal(link.because, because, `${JSON.stringify(raw)} 的判据`)
    assert.ok(link.hint.length > 0, 'inert 必须有给人看的 hint')
  }
})

test('L1：判据不依赖"页面在哪" —— 同一 href 在任何环境下结论都一样', () => {
  // 相对路径在浏览器里也许能解析成同源地址，但桌面端是 dsh-app:，一律不许可点。
  for (const raw of ['README.md', './a.md', '//host/x']) {
    assert.equal(projectLink(raw).kind, 'inert', `${raw} 在任何宿主下都不许变成导航`)
  }
})

// ── L2：解析层就不产出可导航 token ───────────────────────────────────────────

test('L2：inert 的链接只产出 link-inert（渲染层拿不到 href）', () => {
  for (const [raw, because] of INERT) {
    const tokens = parseInline(`见 [说明](${raw})`)
    const link = tokens.find((token) => token.type === 'link')
    assert.equal(link, undefined, `[说明](${raw}) 不该产出可导航 token`)
    const inert = tokens.filter((token) => token.type === 'link-inert')
    assert.equal(inert.length, 1, `[说明](${raw}) 应当产出恰好一个 link-inert`)
    assert.equal(inert[0].reason, because, `[说明](${raw}) 的判据`)
    assert.equal(inert[0].text, '说明')
    assert.ok(inert[0].hint.length > 0)
  }
})

test('L2：http(s) 链接产出 link token，属性全部来自 projectLink', () => {
  const tokens = parseInline('参考 [README.md](https://github.com/a/b/blob/main/README.md) 与 **粗体**')
  assert.deepEqual(tokens, [
    { type: 'text', text: '参考 ' },
    { type: 'link', text: 'README.md', href: 'https://github.com/a/b/blob/main/README.md', target: '_blank', rel: 'noopener noreferrer' },
    { type: 'text', text: ' 与 ' },
    { type: 'strong', text: '粗体' },
  ])
})

test('L2：原有的行内样式行为不变（粗体 / 代码 / 未闭合）', () => {
  assert.deepEqual(parseInline('**a**'), [{ type: 'strong', text: 'a' }])
  assert.deepEqual(parseInline('`a`'), [{ type: 'code', text: 'a' }])
  assert.deepEqual(parseInline('普通文本'), [{ type: 'text', text: '普通文本' }])
  // 未闭合 / 不是链接的方括号 → 原样文本
  assert.deepEqual(parseInline('[a](b'), [{ type: 'text', text: '[a](b' }])
  assert.deepEqual(parseInline('[a]'), [{ type: 'text', text: '[a]' }])
  // 代码里的链接标记不参与解析
  assert.deepEqual(parseInline('`[a](https://b.c)`'), [{ type: 'code', text: '[a](https://b.c)' }])
})

// ── L3：唯一的开法 ───────────────────────────────────────────────────────────

const clickEvent = (overrides = {}) => {
  const calls = { prevented: 0 }
  return {
    calls,
    event: {
      button: 0,
      preventDefault: () => { calls.prevented += 1 },
      ...overrides,
    },
  }
}

test('L3：未加修饰键的左键 → preventDefault + open（宿主文档绝不被导航）', () => {
  const opened = []
  const { event, calls } = clickEvent()
  const outcome = handleExternalLinkClick(event, 'https://a.b/c', { open: (url) => opened.push(url) })
  assert.equal(outcome, 'opened')
  assert.equal(calls.prevented, 1, '必须先取消默认导航')
  assert.deepEqual(opened, ['https://a.b/c'])
})

test('L3：带修饰键 / 非左键 → 不拦不开（交还浏览器，新标签语义由 target=_blank 承担）', () => {
  for (const overrides of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) {
    const opened = []
    const { event, calls } = clickEvent(overrides)
    const outcome = handleExternalLinkClick(event, 'https://a.b/c', { open: (url) => opened.push(url) })
    assert.equal(outcome, 'browser-handled', `${JSON.stringify(overrides)} 应当交还浏览器`)
    assert.equal(calls.prevented, 0)
    assert.deepEqual(opened, [])
  }
})

// ── 源码级扫描：判据只有一处实现（**结构性判据**，不是写法黑名单） ───────────
//
// ⚠️ 这一节被独立审查（fresh-eyes）打回来**重写过一次**，教训值得留着：
// 第一版是"枚举几种已知写法 + 断言文件里含有某串文本"。审查者只加了三处
// （动态标签名 `<AnchorTag {...{href: raw}}/>`、复用唯一那个 `<a>` 配 `{...anchorProps(token)}`、
// 再留一行含 `href={token.href}` 的字符串当诱饵），**10 条测试全绿却把 P0 原样装了回去**。
// 所以现在的规矩是：
//   1. 判据必须**结构化**：锚点标签用括号感知的方式取出，属性逐条校验；
//   2. "另一种写法"一律堵死：`'a'` 这种字面量、属性展开 `{...}`、字符串诱饵；
//   3. 产物也要盯：单测读 `lib/`、探针读部署产物 —— 改完 src 不重建就是假绿。

/** 剥掉注释（扫描只看会执行的代码；注释里写攻击示例是允许的）。 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 仓库源码根（扫描对象）；单测 import 的 `lib/` 则由下面的"产物新鲜度"两条盯住。 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** 递归收集 src 下的 `*.ts` / `*.tsx`（跳过 `.bak-*` 之类的手工备份）。 */
function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry.includes('.bak-')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

/**
 * 括号感知地取出所有 `<a …>` 开始标签。
 *
 * 为什么不能用 `/<a[^>]*>/`：JSX 里的 `onClick={(e) => {…}}` **自带 `>`**，
 * 非贪婪匹配会停在箭头函数处 —— 断言于是"看着过了其实没覆盖"（审查也点了这条）。
 */
function anchorTags(code) {
  const tags = []
  for (let i = code.indexOf('<a'); i !== -1; i = code.indexOf('<a', i + 2)) {
    const after = code[i + 2]
    if (after !== undefined && !/[\s>]/.test(after)) continue
    let depth = 0
    let j = i + 2
    for (; j < code.length; j += 1) {
      const ch = code[j]
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      else if (ch === '>' && depth === 0) break
    }
    tags.push(code.slice(i, j + 1))
  }
  return tags
}

const SOURCES = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}))
const CLIENT_SOURCES = SOURCES.filter(({ path }) => path.startsWith('client/')).map(({ path, text }) => ({ path, code: stripComments(text) }))

test('扫描：客户端里判定"能不能点"的地方只有 externalLink.ts', () => {
  const offenders = []
  for (const { path, code } of CLIENT_SOURCES) {
    if (path === 'client/externalLink.ts') continue
    /**
     * 协议判定必须只有一处：`.protocol` 与 http(s) 字面量/正则/startsWith 都算"自己又判了一遍"。
     * 宿主自己用的是 `["http:","https:"].includes(new URL(href).protocol)` —— 同款写法也在禁列。
     */
    for (const pattern of [/\.protocol\b/, /['"`]https?:?['"`]/, /\/\^?https?/, /startsWith\(\s*['"`]http/]) {
      if (pattern.test(code)) offenders.push(`${path}: ${pattern}`)
    }
    if (/\bprojectLink\s*\(/.test(code) && path !== 'client/inlineMarkdown.ts') {
      offenders.push(`${path}（直接调用 projectLink —— 应当只通过 parseInline 拿 token）`)
    }
  }
  assert.deepEqual(offenders, [],
    '链接判据必须只有一处实现（externalLink.ts）：\n  - ' + offenders.join('\n  - '))
})

test('扫描：全仓唯一的 <a> 在 MarkdownText.tsx，属性逐条只能来自 token', () => {
  const found = []
  const badHref = []
  for (const { path, code } of CLIENT_SOURCES) {
    const tags = anchorTags(code)
    if (tags.length > 0) found.push({ path, tags })
    for (const match of code.matchAll(/href\s*=\s*(\{[^}]*\}|"[^"]*")/g)) {
      if (match[1] !== '{token.href}') badHref.push(`${path}: href=${match[1]}`)
    }
  }
  assert.deepEqual(badHref, [],
    'href 只允许来自 token（token 才经过 projectLink 规范化）：\n  - ' + badHref.join('\n  - '))
  assert.equal(found.length, 1, `渲染 <a> 的文件应当只有 MarkdownText.tsx，实际：${found.map((f) => f.path).join('、')}`)
  const [{ path, tags }] = found
  assert.equal(path, 'client/components/MarkdownText.tsx')
  assert.equal(tags.length, 1, '这个组件只该有一个锚点（唯一入口）')
  const tag = tags[0]
  assert.ok(tag.includes('href={token.href}'), `href 必须来自 token，实际标签：${tag}`)
  assert.ok(tag.includes('target={token.target}'), `target 必须来自 token，实际标签：${tag}`)
  assert.ok(tag.includes('rel={token.rel}'), `rel 必须来自 token，实际标签：${tag}`)
  assert.ok(tag.includes('handleExternalLinkClick('), '点击必须走唯一的开法')
  assert.equal(tag.includes('{...'), false,
    '锚点属性不许用展开 —— `{...anchorProps(token)}` 这类写法绕得过"属性只能来自 token"的判据')
})

test('扫描：`a` 这个标签名只能是 JSX 字面量，不许动态拼', () => {
  /**
   * `const AnchorTag: any = 'a'` / `createElement('a')` / `jsx(`a`)` 都能绕开"扫 `<a`"，
   * 所以直接把"把 a 当字符串用"这件事禁掉：`'a'` / `"a"` / `` `a` `` 一律不许作为**字面量**出现。
   * 唯一例外是 JSX 属性值（`className="a"` 这种形状），所以用 `(?<![=\w.])` 排除等号后面。
   */
  const offenders = []
  for (const { path, code } of CLIENT_SOURCES) {
    const literal = /(?<![=\w.])['"`]a['"`]/g
    for (const match of code.matchAll(literal)) offenders.push(`${path}: ${match[0]}`)
    for (const pattern of [/createElement\(\s*['"`]a['"`]/, /jsxs?\(\s*['"`]a['"`]/]) {
      if (pattern.test(code)) offenders.push(`${path}: ${pattern}`)
    }
  }
  assert.deepEqual(offenders, [],
    '标签名 `a` 只能用 JSX 字面量写（动态标签名会绕过全部锚点扫描）：\n  - ' + offenders.join('\n  - '))
})

test('扫描：客户端不许出现"直接导航宿主文档"或"注入 HTML"的写法', () => {
  const NAVIGATION = [
    'location.href =', 'location =', 'window.location', 'document.location',
    'location.assign(', 'location.replace(', 'history.pushState', 'history.replaceState', 'document.write(',
  ]
  const INJECTION = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'dangerouslySetInnerHTML']
  const offenders = []
  for (const { path, code } of CLIENT_SOURCES) {
    for (const needle of NAVIGATION) if (code.includes(needle)) offenders.push(`${path}: ${needle}`)
    for (const needle of INJECTION) if (code.includes(needle)) offenders.push(`${path}: ${needle}`)
    // 把属性名写成字符串（`const KEEP = 'href={token.href}'`）是"喂饱 includes 断言"的诱饵写法
    if (/['"`][^'"`\n]*href\s*=[^'"`\n]*['"`]/.test(code)) offenders.push(`${path}: 把 href 属性名写成字符串`)
  }
  assert.deepEqual(offenders, [], '工作台面板不接管宿主地址，也不绕过 JSX 判据：\n  - ' + offenders.join('\n  - '))
})

test('扫描：行内解析（含链接判定）不许留在组件里', () => {
  const component = CLIENT_SOURCES.find(({ path }) => path === 'client/components/MarkdownText.tsx')
  assert.ok(component !== undefined, 'MarkdownText.tsx 必须存在')
  const renderInlineBody = /function renderInline\([^]*?\n}/.exec(component.code)?.[0] ?? ''
  assert.ok(renderInlineBody.includes('parseInline(text)'),
    'renderInline 必须只做"解析（纯模块）→ 投影"的委派')
  assert.doesNotMatch(renderInlineBody, /matchAll\(|\.exec\(/,
    '行内解析不许留在组件里 —— 那是 inlineMarkdown.ts / externalLink.ts 的职责')
})

// ── 产物新鲜度：单测读 lib/、探针验部署产物 —— 不重建就是"假绿" ──────────────

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))
const srcMtime = (rel) => statSync(join(SRC, rel)).mtimeMs
const libMtime = (rel) => statSync(join(LIB, rel)).mtimeMs

test('产物新鲜度：lib 比 src 旧就说明"改完没重建"，此刻的绿是假绿', () => {
  for (const [libFile, srcFile] of [
    ['client/externalLink.js', 'client/externalLink.ts'],
    ['client/inlineMarkdown.js', 'client/inlineMarkdown.ts'],
  ]) {
    assert.ok(libMtime(libFile) >= srcMtime(srcFile),
      `${libFile} 比 ${srcFile} 旧 —— 单测 import 的是 lib/，请先跑 pnpm build（或 tsc -p tsconfig.build.json）`)
  }
  assert.ok(libMtime('client.js') >= srcMtime('client/components/MarkdownText.tsx'),
    'lib/client.js（真正部署的 bundle）比 MarkdownText.tsx 旧 —— 先 pnpm build 再验，别拿旧产物当证据')
})

test('产物内容：真正的 bundle 里必须带上"不可点"的投影', () => {
  const bundle = readFileSync(join(LIB, 'client.js'), 'utf8')
  assert.ok(bundle.includes('noopener,noreferrer'), 'bundle 里没有外链的唯一开法')
  assert.ok(bundle.includes('未在 DSH 内打开'), 'bundle 里没有不可点链接的说明文案（修复没被打进产物）')
})
