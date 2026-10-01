/**
 * AX-R02 / AX-R03 / AX-R06：三级角色库发现、稳定 ID/优先级、设置形状、资源安全边界
 * （D11 / requirements §6.1、§6.3、§6.4）。
 *
 * ## 为什么用**真实临时目录 + 真实 HTTP** 而不是替身
 *
 * 这一项的判据里有大量"文件系统角落"（符号链接、junction、大小写、BOM、超限、
 * 二进制）与"路径安全"（`..`、UNC、盘符、编码绕过）。用替身测这些等于测自己写的替身：
 * 真实文件系统拒绝做的事，替身一律照做。所以：
 * - 三级库用 `mkdtempSync` 造三个真实目录，通过 `makePersonaRoutes(db, {builtinDir, userDir, home})` 注入；
 * - 资源边界走**真实 HTTP 请求**（`fetch`），断言状态码与响应 JSON。
 *
 * 失败信息一律带"哪个输入、期望什么、实际什么"，因为这条链最容易出现"看起来过了"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { discoverPersonas, personaIdFromRelativePath, sourceKeyForRoot } from '../lib/personas/library.js'
import { checkPersonaResourcePathShape, readPersonaResource } from '../lib/personas/resources.js'
import { PERSONA_RESOURCE_MAX_BYTES } from '../lib/shared/persona.js'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

/** 造一个临时目录；返回 { dir, cleanup }（cleanup 带重试，Windows 句柄释放慢）。 */
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `wb-persona-${label}-`))
  return {
    dir,
    cleanup() {
      for (let i = 0; i < 10; i += 1) {
        try {
          rmSync(dir, { recursive: true, force: true })
          return
        } catch {
          /** Windows 上偶尔还占着句柄；重试，最终失败也不掩盖断言结果。 */
        }
      }
    },
  }
}

/** 与真实 LS-Skills 同形态的合成角色文档（**内容自造，不含任何公司私人正文**）。 */
function personaText({ title = '合成角色', category = 'engineering', mode = '只读诊断', emoji = '🧪', description = '一段合成简介。', body = '## 身份\n\n合成正文。\n' } = {}) {
  return `# ${title}\n\n> 自定义专家 · 分类 \`${category}\` · 工作模式：**${mode}**\n> 建议 emoji：\`${emoji}\`　建议简介（\`description\`，≤160 字符）：\n> ${description}\n\n---\n\n${body}`
}

function writePersona(root, relativePath, text) {
  const full = join(root, relativePath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text, 'utf8')
  return full
}

/** 起一个只挂工作台路由的真实 HTTP 服务（角色相关由 `deps.personas` 注入真实目录）。 */
async function withServer(fn, { deps = {}, roles = {} } = {}) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const routes = [...makeRoutes(db, { ...deps, personas: roles })]
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试服务器没有拿到端口')
  const port = address.port
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: res.status, body: parsed, raw: text }
  }
  try {
    await fn({ db, request, port })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
}

// ---------------------------------------------------------------------------
// AX-R02：发现、ID、覆盖顺序、排除项、诊断
// ---------------------------------------------------------------------------

test('AX-R02 递归发现 rf/dotnet 子目录，稳定 ID = 相对路径，分组取首层目录', () => {
  const builtin = tempDir('builtin')
  const user = tempDir('user-empty')
  try {
    writePersona(builtin.dir, join('rf', 'rf-天线测量专家.md'), personaText({ title: '天线测量专家' }))
    writePersona(builtin.dir, join('dotnet', 'dotnet-审查官.md'), personaText({ title: '.NET 审查官' }))
    writePersona(builtin.dir, '顶层角色.md', personaText({ title: '顶层角色' }))
    writePersona(builtin.dir, 'README.md', '# 说明\n\n不是角色\n')
    const discovery = discoverPersonas({ builtinDir: builtin.dir, userDir: user.dir, platform: 'win32' })
    const ids = discovery.personas.map((persona) => persona.id).sort()
    assert.deepEqual(ids, ['dotnet/dotnet-审查官', 'rf/rf-天线测量专家', '顶层角色'], `实际：${ids.join(', ')}`)
    const rf = discovery.personas.find((persona) => persona.id === 'rf/rf-天线测量专家')
    assert.equal(rf.group, 'rf')
    assert.equal(rf.source, 'builtin')
    assert.equal(rf.sourceKey, 'builtin')
    assert.equal(rf.enabled, true)
    assert.equal(rf.favorite, false)
    assert.equal(rf.mode, '只读诊断')
    assert.equal(rf.emoji, '🧪')
    const top = discovery.personas.find((persona) => persona.id === '顶层角色')
    assert.equal(top.group, '其他', '根目录下的文档分组是「其他」')
    assert.equal(discovery.personas.some((persona) => persona.id === 'README'), false, 'README.md 必须被排除')
    assert.equal(personaIdFromRelativePath('rf\\子目录\\甲.md'), 'rf/子目录/甲')
  } finally {
    builtin.cleanup()
    user.cleanup()
  }
})

test('AX-R02 覆盖顺序：用户 > 外部 > 内置（同逻辑路径只留一份并给诊断）', () => {
  const builtin = tempDir('builtin')
  const user = tempDir('user')
  const external = tempDir('external')
  try {
    writePersona(builtin.dir, 'reviewer.md', personaText({ title: '内置审查者' }))
    writePersona(external.dir, 'reviewer.md', personaText({ title: '外部审查者' }))
    writePersona(user.dir, 'reviewer.md', personaText({ title: '我的审查者' }))
    /** 只有外部有、用户没有的：外部那份要出现。 */
    writePersona(external.dir, 'only-external.md', personaText({ title: '只在外部' }))

    const discovery = discoverPersonas({ builtinDir: builtin.dir, userDir: user.dir, externalDir: external.dir, platform: 'win32' })
    const reviewer = discovery.personas.filter((persona) => persona.id === 'reviewer')
    assert.equal(reviewer.length, 1, '同逻辑路径必须只留一份')
    assert.equal(reviewer[0].name, '我的审查者', '用户库覆盖外部与内置')
    assert.equal(reviewer[0].source, 'user')
    assert.equal(discovery.personas.find((persona) => persona.id === 'only-external')?.source, 'external')

    /** 去掉用户库那份，外部就该赢过内置（覆盖顺序是逐级比较，不是"只要用户库存在就全赢"）。 */
    const noUser = discoverPersonas({ builtinDir: builtin.dir, userDir: tempDir('empty-user').dir, externalDir: external.dir, platform: 'win32' })
    assert.equal(noUser.personas.find((persona) => persona.id === 'reviewer')?.name, '外部审查者')

    const codes = discovery.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.id ?? ''}`)
    assert.equal(codes.includes('duplicate-id-overridden:reviewer'), true, `覆盖必须留诊断，实际：${codes.join(', ')}`)
  } finally {
    builtin.cleanup()
    user.cleanup()
    external.cleanup()
  }
})

test('AX-R02 同显示名但不同相对路径 = 两个角色并存（绝不按名字合并）', () => {
  const builtin = tempDir('builtin')
  try {
    writePersona(builtin.dir, join('a', '同名专家.md'), personaText({ title: '同名专家', body: 'A 的正文\n' }))
    writePersona(builtin.dir, join('b', '同名专家.md'), personaText({ title: '同名专家', body: 'B 的正文\n' }))
    const discovery = discoverPersonas({ builtinDir: builtin.dir, userDir: tempDir('u').dir, platform: 'win32' })
    const same = discovery.personas.filter((persona) => persona.name === '同名专家')
    assert.equal(same.length, 2, `同显示名必须并存，实际：${same.map((persona) => persona.id).join(', ')}`)
    assert.deepEqual(same.map((persona) => persona.id).sort(), ['a/同名专家', 'b/同名专家'])
    assert.deepEqual(same.map((persona) => persona.group).sort(), ['a', 'b'])
  } finally {
    builtin.cleanup()
  }
})

test('AX-R02 排除隐藏目录/文件、资源同名附件目录、非 md；链接另行拒绝', () => {
  const builtin = tempDir('builtin')
  try {
    writePersona(builtin.dir, '甲.md', personaText({ title: '甲' }))
    writePersona(builtin.dir, join('甲', 'note.md'), personaText({ title: '不该被当成角色（资源附件）' }))
    writePersona(builtin.dir, join('.hidden', '乙.md'), personaText({ title: '乙' }))
    writePersona(builtin.dir, '.hidden.md', personaText({ title: '隐藏文件' }))
    writePersona(builtin.dir, 'notes.txt', '不是 md\n')
    writePersona(builtin.dir, join('深1', '深2', '深3', '深4', '丙.md'), personaText({ title: '丙' }))
    writePersona(builtin.dir, join('深1', '深2', '深3', '深4', '深5', '丁.md'), personaText({ title: '丁' }))
    const discovery = discoverPersonas({ builtinDir: builtin.dir, userDir: tempDir('u').dir, platform: 'win32' })
    const ids = [...discovery.personas.map((persona) => persona.id)].sort()
    assert.deepEqual(ids, ['深1/深2/深3/深4/丙', '甲'], `实际：${ids.join(', ')}`)
    const messages = discovery.diagnostics.map((diagnostic) => diagnostic.message).join('\n')
    assert.match(messages, /隐藏文件\/目录/)
    assert.match(messages, /非 `\.md` 文件/)
    /** 深度超限（第 5 层）必须有诊断，否则就是静默丢件。 */
    assert.match(messages, /深度超过 4 层/)
  } finally {
    builtin.cleanup()
  }
})

test('AX-R02/R03 非法文档与超限文件**逐个报诊断**，不静默丢件', () => {
  const builtin = tempDir('builtin')
  try {
    writePersona(builtin.dir, '好.md', personaText({ title: '好的角色' }))
    writePersona(builtin.dir, '无标题.md', '没有一级标题\n\n正文\n')
    writePersona(builtin.dir, '无正文.md', '# 只有标题\n\n> 分类 `engineering`\n')
    writePersona(builtin.dir, '坏frontmatter.md', '---\nname: 甲\nmeta: {a: 1}\n---\n# 甲\n\n正文\n')
    writeFileSync(join(builtin.dir, '超大.md'), `# 超大\n\n${'字'.repeat(200 * 1024)}`, 'utf8')
    const discovery = discoverPersonas({ builtinDir: builtin.dir, userDir: tempDir('u').dir, platform: 'win32' })
    assert.deepEqual(discovery.personas.map((persona) => persona.id), ['好'])
    const byCode = new Map()
    for (const diagnostic of discovery.diagnostics) byCode.set(diagnostic.code, (byCode.get(diagnostic.code) ?? 0) + 1)
    assert.equal(byCode.get('missing-title'), 1, JSON.stringify(discovery.diagnostics))
    assert.equal(byCode.get('empty-body'), 1)
    assert.equal(byCode.get('unsupported-frontmatter'), 1)
    assert.equal(byCode.get('oversized-file'), 1)
    for (const diagnostic of discovery.diagnostics.filter((item) => ['missing-title', 'empty-body', 'unsupported-frontmatter', 'oversized-file'].includes(item.code))) {
      assert.equal(typeof diagnostic.id, 'string', '坏文档的诊断必须能指回 id（不许只给一条"有文档坏了"）')
      assert.equal(diagnostic.message.length > 0, true)
    }
  } finally {
    builtin.cleanup()
  }
})

test('AX-R03 外部根不存在/无权限 → 只禁用该来源，其余来源照常，配置值原样保留', async () => {
  const builtin = tempDir('builtin')
  const user = tempDir('user')
  try {
    writePersona(builtin.dir, '内置.md', personaText({ title: '内置角色' }))
    await withServer(async ({ request }) => {
      const missing = join(tmpdir(), `definitely-missing-${Date.now()}`)
      const written = await request('POST', '/api/workbench/settings', { personaExternalDir: missing })
      assert.equal(written.status, 200)
      assert.equal(written.body.settings.personaExternalDir, missing, '配置值必须原样保留（不因为目录不存在就被清空）')
      const list = await request('GET', '/api/workbench/personas')
      assert.equal(list.status, 200)
      assert.equal(list.body.personas.some((persona) => persona.id === '内置'), true, '内置来源不受外部根失效影响')
      const diagnostic = list.body.diagnostics.find((item) => item.code === 'root-missing')
      assert.equal(diagnostic !== undefined, true, `必须有 root-missing 诊断，实际：${JSON.stringify(list.body.diagnostics)}`)
      assert.match(diagnostic.message, /只禁用该来源/)
      /** 不自动创建外部目录：跑完之后那个目录仍然不存在。 */
      assert.equal(list.body.personas.some((persona) => persona.source === 'external'), false)
    }, { roles: { builtinDir: builtin.dir, userDir: user.dir, home: user.dir } })
  } finally {
    builtin.cleanup()
    user.cleanup()
  }
})

test('AX-R02 sourceKey：内置固定、用户/外部带规范根哈希且改根就换身份', () => {
  assert.equal(sourceKeyForRoot('builtin', 'C:\\whatever', 'win32'), 'builtin')
  const a = sourceKeyForRoot('external', 'D:\\Code\\LS-Skills\\personas', 'win32')
  const b = sourceKeyForRoot('external', 'd:\\code\\ls-skills\\personas', 'win32')
  const c = sourceKeyForRoot('external', 'D:\\Code\\Other\\personas', 'win32')
  assert.equal(a, b, 'Windows 上大小写不同但同一个根 → 同一个 sourceKey')
  assert.notEqual(a, c, '换根必须换 sourceKey（否则"改配置"会被当成"文件变了"）')
  assert.match(a, /^external:[0-9a-f]{12}$/)
  assert.match(sourceKeyForRoot('user', 'C:\\Users\\x\\.dsh\\workbench\\personas', 'win32'), /^user:[0-9a-f]{12}$/)
})

test('AX-R02 revision = 归一换行后内容哈希：同内容同哈希，改一个字节就变', () => {
  const builtin = tempDir('builtin')
  try {
    writePersona(builtin.dir, '甲.md', '# 甲\n\n正文\n')
    const first = discoverPersonas({ builtinDir: builtin.dir, userDir: tempDir('u').dir, platform: 'win32' })
    const second = discoverPersonas({ builtinDir: builtin.dir, userDir: tempDir('u2').dir, platform: 'win32' })
    assert.equal(first.personas[0].revision, second.personas[0].revision, '内容没变 → revision 必须稳定')
    assert.match(first.personas[0].revision, /^[0-9a-f]{64}$/)
    /** 只有换行风格变了（CRLF）→ 归一之后内容相同 → revision 不变。 */
    writeFileSync(join(builtin.dir, '甲.md'), '# 甲\r\n\r\n正文\r\n', 'utf8')
    const crlf = discoverPersonas({ builtinDir: builtin.dir, userDir: tempDir('u3').dir, platform: 'win32' })
    assert.equal(crlf.personas[0].revision, first.personas[0].revision, 'CRLF 与 LF 必须同哈希（否则一 checkout 就"文件变了"）')
    writeFileSync(join(builtin.dir, '甲.md'), '# 甲\n\n正文改了一个字\n', 'utf8')
    const changed = discoverPersonas({ builtinDir: builtin.dir, userDir: tempDir('u4').dir, platform: 'win32' })
    assert.notEqual(changed.personas[0].revision, first.personas[0].revision)
  } finally {
    builtin.cleanup()
  }
})

// ---------------------------------------------------------------------------
// AX-R03：设置（GET/POST 同形状、收藏/禁用去重、摘要不回正文与绝对路径）
// ---------------------------------------------------------------------------

test('AX-R03 settings：三个角色字段缺省值、写读同形状、数组去重、不传就不动', async () => {
  await withServer(async ({ request }) => {
    const initial = await request('GET', '/api/workbench/settings')
    assert.equal(initial.status, 200)
    assert.equal(initial.body.settings.personaExternalDir, '', '外部根缺省空串（不自动指向任何目录）')
    assert.deepEqual(initial.body.settings.personaFavorites, [])
    assert.deepEqual(initial.body.settings.personaDisabledIds, [])

    const written = await request('POST', '/api/workbench/settings', {
      personaExternalDir: 'D:\\Code\\LS-Skills\\personas',
      personaFavorites: ['rf/甲', 'rf/甲', '  ', 'rf/乙', ''],
      personaDisabledIds: ['dotnet/丙', 'dotnet/丙'],
    })
    assert.equal(written.status, 200)
    assert.equal(written.body.settings.personaExternalDir, 'D:\\Code\\LS-Skills\\personas')
    assert.deepEqual(written.body.settings.personaFavorites, ['rf/甲', 'rf/乙'], `去重后应保序：${JSON.stringify(written.body.settings.personaFavorites)}`)
    assert.deepEqual(written.body.settings.personaDisabledIds, ['dotnet/丙'])

    /** GET 与 POST 返回的形状必须逐键一致（设置页拿响应回填 state）。 */
    const back = await request('GET', '/api/workbench/settings')
    assert.deepEqual(Object.keys(back.body.settings).sort(), Object.keys(written.body.settings).sort())
    assert.deepEqual(back.body.settings, written.body.settings)

    /** 不传就不动：整表回传时漏字段不许把用户的值冲掉。 */
    const kept = await request('POST', '/api/workbench/settings', { defaultWorkspace: 'D:\\Code\\x' })
    assert.equal(kept.body.settings.personaExternalDir, 'D:\\Code\\LS-Skills\\personas')
    assert.deepEqual(kept.body.settings.personaFavorites, ['rf/甲', 'rf/乙'])

    /** 整表替换语义：能把收藏删掉。 */
    const removed = await request('POST', '/api/workbench/settings', { personaFavorites: ['rf/乙'] })
    assert.deepEqual(removed.body.settings.personaFavorites, ['rf/乙'])

    /** 脏值不让接口打挂：非数组/坏 JSON 一律退化成空数组。 */
    const bad = await request('POST', '/api/workbench/settings', { personaFavorites: 'not-an-array' })
    assert.deepEqual(bad.body.settings.personaFavorites, ['rf/乙'], '非数组不当成空数组覆盖（宁可不动）')
  })
})

test('AX-R03 GET /personas 摘要：字段齐全、不回正文、不回绝对路径、enabled/favorite 反映设置', async () => {
  const builtin = tempDir('builtin')
  const user = tempDir('user')
  try {
    writePersona(builtin.dir, '甲.md', personaText({ title: '甲角色', description: '甲的简介' }))
    writePersona(builtin.dir, join('rf', '乙.md'), personaText({ title: '乙角色' }))
    await withServer(async ({ request }) => {
      await request('POST', '/api/workbench/settings', { personaFavorites: ['rf/乙'], personaDisabledIds: ['甲'] })
      const list = await request('GET', '/api/workbench/personas')
      assert.equal(list.status, 200)
      assert.equal(list.body.ok, true)
      assert.equal(list.body.personas.length, 2)
      const jia = list.body.personas.find((persona) => persona.id === '甲')
      assert.deepEqual(Object.keys(jia).sort(), ['description', 'descriptionTruncated', 'emoji', 'enabled', 'favorite', 'group', 'id', 'mode', 'name', 'revision', 'source', 'sourceKey'].sort())
      assert.equal(jia.enabled, false, '被禁用的角色 enabled=false')
      const yi = list.body.personas.find((persona) => persona.id === 'rf/乙')
      assert.equal(yi.favorite, true)
      assert.equal(yi.enabled, true)
      /** 摘要**绝不含正文/绝对路径**（AX-R03 的硬判据，按原始响应文本断言而不是按对象）。 */
      assert.equal(list.raw.includes('合成正文'), false, '响应里不许出现正文')
      assert.equal(list.raw.includes(builtin.dir.replace(/\\/g, '\\\\')), false, '响应里不许出现绝对路径')
      assert.equal(list.raw.includes(builtin.dir), false, '响应里不许出现绝对路径')
    }, { roles: { builtinDir: builtin.dir, userDir: user.dir, home: user.dir } })
  } finally {
    builtin.cleanup()
    user.cleanup()
  }
})

// ---------------------------------------------------------------------------
// AX-R06：资源路径形状（表驱动，纯函数）
// ---------------------------------------------------------------------------

const SHAPE_REJECTS = [
  ['绝对 POSIX 路径', '/etc/passwd'],
  ['盘符', 'C:/Windows/win.ini'],
  ['盘符反斜杠', 'D:\\secret.txt'],
  ['UNC 路径（反斜杠）', '\\\\server\\share\\a.txt'],
  ['UNC 路径（正斜杠）', '//server/share/a.txt'],
  ['父目录穿越', '../outside.md'],
  ['深层父目录穿越', 'docs/../../outside.md'],
  ['反斜杠穿越', '..\\outside.md'],
  ['百分号编码穿越', '%2e%2e/outside.md'],
  ['百分号编码斜杠', 'docs%2f..%2foutside.md'],
  ['双重编码', '%252e%252e/outside.md'],
  ['单独百分号', 'a%b.txt'],
  ['NUL 字符', 'a\u0000b.txt'],
  ['空字符串', ''],
  ['只有空白', '   '],
  ['末尾是目录', 'resources/'],
  ['只有点', '.'],
]
for (const [label, input] of SHAPE_REJECTS) {
  test(`AX-R06 资源路径形状拒绝：${label}`, () => {
    const problem = checkPersonaResourcePathShape(input)
    assert.equal(typeof problem, 'string', `应拒绝但被接受：${JSON.stringify(input)}`)
    assert.equal(problem.length > 0, true)
  })
}

const SHAPE_ACCEPTS = [
  ['普通文件', 'checklist.md'],
  ['子目录', 'resources/checklist.md'],
  ['反斜杠当分隔符（归一后仍在根内）', 'resources\\checklist.md'],
  ['带点号的文件名', 'v1.2/template.md'],
  ['中文名', '模板/评审清单.md'],
]
for (const [label, input] of SHAPE_ACCEPTS) {
  test(`AX-R06 资源路径形状接受：${label}`, () => {
    assert.equal(checkPersonaResourcePathShape(input), undefined, `应接受但被拒绝：${input}`)
  })
}

test('AX-R06 扩展名白名单：允许文本、拒绝其他一切（脚本不会被工作台执行）', () => {
  const root = tempDir('res')
  try {
    mkdirSync(root.dir, { recursive: true })
    for (const name of ['a.md', 'b.txt', 'c.json', 'd.yaml', 'e.yml', 'f.csv', 'g.ts', 'h.js', 'i.mjs', 'j.py', 'k.ps1']) {
      writeFileSync(join(root.dir, name), 'text\n', 'utf8')
    }
    writeFileSync(join(root.dir, 'x.exe'), 'MZ\n', 'utf8')
    writeFileSync(join(root.dir, 'y.png'), 'x\n', 'utf8')
    writeFileSync(join(root.dir, 'noext'), 'x\n', 'utf8')
    for (const name of ['a.md', 'b.txt', 'c.json', 'd.yaml', 'e.yml', 'f.csv', 'g.ts', 'h.js', 'i.mjs', 'j.py', 'k.ps1']) {
      const read = readPersonaResource(root.dir, name, { platform: 'win32' })
      assert.equal(read.ok, true, `${name} 应可读：${JSON.stringify(read)}`)
      assert.equal(read.text.trim(), 'text')
    }
    for (const name of ['x.exe', 'y.png', 'noext']) {
      const read = readPersonaResource(root.dir, name, { platform: 'win32' })
      assert.equal(read.ok, false, `${name} 应被拒绝`)
      assert.equal(read.code, 'resource-unsupported-type')
    }
  } finally {
    root.cleanup()
  }
})

test('AX-R06 二进制 / 坏 UTF-8 / 超限明确拒绝，且不静默截断', () => {
  const root = tempDir('res')
  try {
    writeFileSync(join(root.dir, 'nul.md'), Buffer.from([0x23, 0x20, 0x00, 0x41]))
    writeFileSync(join(root.dir, 'bad.md'), Buffer.from([0xff, 0xfe, 0x41]))
    writeFileSync(join(root.dir, 'big.md'), `# 大\n\n${'字'.repeat(PERSONA_RESOURCE_MAX_BYTES + 10)}`, 'utf8')
    writeFileSync(join(root.dir, 'long.md'), '字'.repeat(20001), 'utf8')
    const nul = readPersonaResource(root.dir, 'nul.md', { platform: 'win32' })
    assert.equal(nul.ok, false)
    assert.equal(nul.code, 'resource-binary')
    const bad = readPersonaResource(root.dir, 'bad.md', { platform: 'win32' })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'resource-binary')
    assert.match(bad.message, /UTF-8/)
    const big = readPersonaResource(root.dir, 'big.md', { platform: 'win32' })
    assert.equal(big.ok, false)
    assert.equal(big.code, 'resource-oversized')
    assert.match(big.message, /128 KiB/)
    const long = readPersonaResource(root.dir, 'long.md', { platform: 'win32' })
    assert.equal(long.ok, false)
    assert.equal(long.code, 'resource-oversized')
    assert.match(long.message, /20000/)
    const missing = readPersonaResource(root.dir, 'nope.md', { platform: 'win32' })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'resource-not-found')
  } finally {
    root.cleanup()
  }
})

test('AX-R06 resolve+realpath 复校：根内正常文件可读，根外文件读不到', () => {
  const outer = tempDir('outer')
  const res = tempDir('res')
  try {
    writeFileSync(join(outer.dir, 'secret.md'), 'SHOULD-NOT-LEAK\n', 'utf8')
    writeFileSync(join(res.dir, 'ok.md'), 'fine\n', 'utf8')
    const ok = readPersonaResource(res.dir, 'ok.md', { platform: 'win32' })
    assert.equal(ok.ok, true)
    assert.equal(ok.text.trim(), 'fine')
    /** 用相对穿越指到外面的真实文件 → 形状层就拒绝（不依赖 realpath 兜底）。 */
    const escape = readPersonaResource(res.dir, `..${process.platform === 'win32' ? '\\' : '/'}${outer.dir.split(/[\\/]/).pop()}\\secret.md`, { platform: 'win32' })
    assert.equal(escape.ok, false)
    assert.equal(escape.text, undefined)
  } finally {
    outer.cleanup()
    res.cleanup()
  }
})

test('AX-R06 符号链接与 junction：即使在根内也拒绝（目录链接整棵跳过）', (t) => {
  const res = tempDir('res')
  const outside = tempDir('outside')
  try {
    writeFileSync(join(res.dir, 'real.md'), 'REAL\n', 'utf8')
    writeFileSync(join(outside.dir, 'target.md'), 'OUTSIDE\n', 'utf8')

    let linked = false
    try {
      symlinkSync(join(outside.dir, 'target.md'), join(res.dir, 'link-file.md'), 'file')
      linked = true
    } catch {
      /** Windows 上需要开发者模式/管理员；拿不到就明确跳过而不是假装通过。 */
    }
    if (linked) {
      const read = readPersonaResource(res.dir, 'link-file.md', { platform: 'win32' })
      assert.equal(read.ok, false, '根内的文件符号链接也必须拒绝')
      assert.equal(read.code, 'resource-invalid-path')
      assert.match(read.message, /符号链接/)
    } else {
      t.diagnostic('文件符号链接不可创建（Windows 需要开发者模式/管理员），本用例的文件链接分支未验证')
    }

    /** junction：`mklink /J` 不需要管理员，Windows 上可测。 */
    let junction = false
    if (process.platform === 'win32') {
      try {
        execFileSync('cmd', ['/c', 'mklink', '/J', join(res.dir, 'linkdir'), outside.dir], { stdio: 'ignore' })
        junction = true
      } catch {
        junction = false
      }
    } else {
      try {
        symlinkSync(outside.dir, join(res.dir, 'linkdir'), 'dir')
        junction = true
      } catch { /* 同样跳过 */ }
    }
    if (junction) {
      const read = readPersonaResource(res.dir, 'linkdir/target.md', { platform: 'win32' })
      assert.equal(read.ok, false, 'junction 里的文件必须拒绝')
      assert.equal(read.code, 'resource-invalid-path')
      assert.match(read.message, /符号链接|junction/)
      assert.equal(read.text, undefined, '绝不许回退去读根外文件')
    } else {
      t.diagnostic('目录 junction 不可创建，本用例的 junction 分支未验证')
    }
  } finally {
    res.cleanup()
    outside.cleanup()
  }
})

// ---------------------------------------------------------------------------
// AX-R06：资源读取走真实 HTTP
// ---------------------------------------------------------------------------

/** 造一个带附件目录的角色库：`甲.md` + `甲/`。 */
function makePersonaWithResources() {
  const builtin = tempDir('builtin')
  const user = tempDir('user')
  writePersona(builtin.dir, '甲.md', personaText({ title: '甲角色' }))
  const resourceDir = join(builtin.dir, '甲')
  mkdirSync(resourceDir, { recursive: true })
  writeFileSync(join(resourceDir, 'checklist.md'), '# 清单\n\n- 一\n- 二\n', 'utf8')
  mkdirSync(join(resourceDir, 'resources'), { recursive: true })
  writeFileSync(join(resourceDir, 'resources', 'template.json'), '{"a":1}\n', 'utf8')
  writeFileSync(join(resourceDir, 'secret.bin'), Buffer.from([0x00, 0x01]))
  return { builtin, user, resourceDir }
}

test('AX-R06 HTTP：合法相对路径读到文本，回执含清单且不含绝对路径', async () => {
  const { builtin, user } = makePersonaWithResources()
  try {
    await withServer(async ({ request }) => {
      const ok = await request('GET', `/api/workbench/personas/resources?persona_id=${encodeURIComponent('甲')}&path=${encodeURIComponent('checklist.md')}`)
      assert.equal(ok.status, 200, JSON.stringify(ok.body))
      assert.equal(ok.body.path, 'checklist.md')
      assert.match(ok.body.text, /# 清单/)
      assert.equal(typeof ok.body.characters, 'number')
      assert.match(ok.body.revision, /^[0-9a-f]{64}$/)
      const paths = ok.body.resources.map((entry) => entry.path).sort()
      assert.deepEqual(paths, ['checklist.md', 'resources/template.json', 'secret.bin'], `清单：${paths.join(', ')}`)
      assert.equal(ok.raw.includes(builtin.dir), false)
      assert.equal(ok.raw.includes(builtin.dir.replace(/\\/g, '\\\\')), false)

      const nested = await request('GET', `/api/workbench/personas/resources?persona_id=${encodeURIComponent('甲')}&path=${encodeURIComponent('resources/template.json')}`)
      assert.equal(nested.status, 200)
      assert.equal(nested.body.text.trim(), '{"a":1}')
    }, { roles: { builtinDir: builtin.dir, userDir: user.dir, home: user.dir } })
  } finally {
    builtin.cleanup()
    user.cleanup()
  }
})

const HTTP_REJECTS = [
  ['父目录穿越', '../甲.md', 400],
  ['绝对路径', '/etc/passwd', 400],
  ['盘符', 'C:/Windows/win.ini', 400],
  ['UNC', '\\\\server\\share\\a.md', 400],
  ['编码穿越', '%2e%2e/outside.md', 400],
  ['NUL', 'a\u0000b.md', 400],
  ['不支持的扩展名', 'secret.bin', 400],
  ['不存在的资源', 'nope.md', 404],
]
for (const [label, path, status] of HTTP_REJECTS) {
  test(`AX-R06 HTTP 资源拒绝：${label} → ${status}`, async () => {
    const { builtin, user } = makePersonaWithResources()
    try {
      await withServer(async ({ request }) => {
        const res = await request('GET', `/api/workbench/personas/resources?persona_id=${encodeURIComponent('甲')}&path=${encodeURIComponent(path)}`)
        assert.equal(res.status, status, `${label}：期望 ${status}，实际 ${res.status}（${JSON.stringify(res.body)}）`)
        assert.equal(res.body.ok, false, '拒绝时必须是显式的 ok:false（不许既不给 ok 也不给错误码）')
        assert.equal(typeof res.body.error, 'string', '拒绝必须给可读中文原因')
        assert.equal(res.body.text, undefined, '拒绝时绝不能回文件内容')
        assert.equal(res.raw.includes(builtin.dir), false, '拒绝响应不许泄露绝对路径')
      }, { roles: { builtinDir: builtin.dir, userDir: user.dir, home: user.dir } })
    } finally {
      builtin.cleanup()
      user.cleanup()
    }
  })
}

test('AX-R06 HTTP：角色不存在 / 缺 persona_id / 未知子路径 → 明确 404/400，不是 500', async () => {
  const { builtin, user } = makePersonaWithResources()
  try {
    await withServer(async ({ request }) => {
      const noPersona = await request('GET', '/api/workbench/personas/resources?persona_id=%E4%B8%8D%E5%AD%98%E5%9C%A8&path=a.md')
      assert.equal(noPersona.status, 404)
      assert.match(noPersona.body.error, /不存在/)
      const noId = await request('GET', '/api/workbench/personas/resources?path=a.md')
      assert.equal(noId.status, 400)
      const noPath = await request('GET', `/api/workbench/personas/resources?persona_id=${encodeURIComponent('甲')}`)
      assert.equal(noPath.status, 400)
      const unknown = await request('GET', '/api/workbench/personas/whatever')
      assert.equal(unknown.status, 404)
      const noResourceDir = await request('GET', `/api/workbench/personas/resources?persona_id=${encodeURIComponent('乙')}&path=a.md`)
      assert.equal(noResourceDir.status, 404, '角色没有附件目录时 → 找不到该资源')
    }, { roles: { builtinDir: builtin.dir, userDir: user.dir, home: user.dir } })
  } finally {
    builtin.cleanup()
    user.cleanup()
  }
})
