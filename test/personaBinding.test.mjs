/**
 * AX-R04 / AX-R05（会话部分）：**角色会话绑定**与**按绑定加载**（D12 / requirements §6.3、§6.4）。
 *
 * ## 为什么用真实临时目录 + 真实 HTTP + 真实工具对象
 *
 * 这一项的判据全是"跨层"的：绑定行落在 `ai_session_registry`、角色来自三级真实目录、
 * 工具只认 exec 上下文的 sessionId、资源读取要先过绑定与 revision。用替身测这些等于
 * 测自己写的替身，所以：
 * - 三级库用 `mkdtempSync` 造真实目录，经 `makeRoutes(db, { personas })` / 工具第二参注入；
 * - 绑定/幂等/409 走**真实 HTTP 请求**（`fetch`）；
 * - 工具行为直接驱动 `loadPersonaTool()` / `readPersonaResourceTool()` 的 `execute`。
 *
 * 失败信息一律带"哪个输入、期望什么、实际什么"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { getAiSession, registerAiSession } from '../lib/db/repo.js'
import { readPersonaBinding, writePersonaBinding, PERSONA_BINDING_SCOPE } from '../lib/db/repo/persona-bindings.js'
import { writePersonaSettings } from '../lib/db/repo/personas.js'
import { bindSessionPersona, loadSessionPersona, readSessionPersonaResource } from '../lib/personas/binding.js'
import { loadPersonaTool, readPersonaResourceTool } from '../lib/tools.js'
import { PERSONA_BINDING_VERSION } from '../lib/shared/persona.js'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `wb-bind-${label}-`))
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

function personaText({ title = '合成角色', description = '合成简介。', body = '## 身份\n\n合成正文。\n' } = {}) {
  return `# ${title}\n\n> 自定义专家 · 分类 \`engineering\` · 工作模式：**只读诊断**\n> 建议 emoji：\`🧪\`　建议简介（\`description\`，≤160 字符）：\n> ${description}\n\n---\n\n${body}`
}

function writePersona(root, relativePath, text) {
  const full = join(root, relativePath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text, 'utf8')
  return full
}

/** 起一个只挂工作台路由的真实 HTTP 服务。 */
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
    const raw = await res.text()
    let parsed
    try { parsed = JSON.parse(raw) } catch { parsed = raw }
    return { status: res.status, body: parsed, raw }
  }
  try {
    await fn({ db, request, port })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
}

/** 一套真实三级库（内置 + 用户 + 外部），返回注入参数与清理器。 */
function makeLibrary() {
  const builtin = tempDir('builtin')
  const user = tempDir('user')
  const external = tempDir('external')
  writePersona(builtin.dir, join('engineering', '实现者.md'), personaText({ title: '实现者', body: '## 身份\n\n内置实现者。\n' }))
  writePersona(external.dir, join('rf', 'rf-天线测量专家.md'), personaText({ title: '天线测量专家', description: '合成外部角色。', body: '## 身份\n\n外部天线测量专家。\n' }))
  writePersona(external.dir, join('rf', 'rf-天线测量专家', 'resources', 'checklist.md'), '# 清单\n\n- 一条合成检查项\n')
  return {
    roots: { builtinDir: builtin.dir, userDir: user.dir, platform: 'win32' },
    dirs: { builtin, user, external },
    cleanup() { builtin.cleanup(); user.cleanup(); external.cleanup() },
  }
}

/** 外部根经设置项生效（生产同一条路）。 */
function setExternalDir(db, dir) {
  writePersonaSettings(db, { personaExternalDir: dir })
}

// ---------------------------------------------------------------------------
// AX-R04：绑定（幂等 / 409 / 不串 scope / 仅按真实 sessionId）
// ---------------------------------------------------------------------------

test('AX-R04 绑定在首次 prompt 之前：POST /personas/bind 落一行 persona scope 的绑定', async () => {
  const lib = makeLibrary()
  try {
    await withServer(async ({ db, request }) => {
      setExternalDir(db, lib.dirs.external.dir)
      const created = await request('POST', '/api/workbench/personas/bind', { sessionId: 'sess-1', personaId: 'rf/rf-天线测量专家' })
      assert.equal(created.status, 201, `期望 201，实际 ${created.status}：${created.raw}`)
      assert.equal(created.body.created, true)
      assert.equal(created.body.binding.personaId, 'rf/rf-天线测量专家')
      assert.match(created.body.binding.sourceKey, /^external:/)
      assert.match(created.body.binding.revision, /^[0-9a-f]{64}$/, 'revision 必须是内容 SHA-256')

      // 落库位置：ai_session_registry 的 (persona, sessionId) 一行，note 是版本化 JSON
      const row = getAiSession(db, PERSONA_BINDING_SCOPE, 'sess-1')
      assert.ok(row !== undefined, '绑定必须写进 ai_session_registry')
      assert.equal(row.sessionId, 'sess-1')
      const note = JSON.parse(row.note)
      assert.equal(note.version, PERSONA_BINDING_VERSION)
      assert.equal(note.personaId, 'rf/rf-天线测量专家')
      assert.match(note.relativePath, /^rf[\\/]rf-天线测量专家\.md$/, 'relativePath 是相对来源根的真实文件路径')
      assert.equal(note.revision, created.body.binding.revision)
      assert.equal(/absolute|:\\\\|[A-Za-z]:\\/.test(JSON.stringify(created.body)), false, 'HTTP 响应不得出现绝对路径')
    }, { roles: lib.roots })
  } finally {
    lib.cleanup()
  }
})

test('AX-R04 同绑定重复幂等（200 + created=false，且不覆盖 revision）；不同绑定 409', async () => {
  const lib = makeLibrary()
  try {
    await withServer(async ({ db, request }) => {
      setExternalDir(db, lib.dirs.external.dir)
      const first = await request('POST', '/api/workbench/personas/bind', { sessionId: 'sess-2', personaId: 'rf/rf-天线测量专家' })
      assert.equal(first.status, 201)
      const again = await request('POST', '/api/workbench/personas/bind', { sessionId: 'sess-2', personaId: 'rf/rf-天线测量专家' })
      assert.equal(again.status, 200, `同绑定必须幂等，实际 ${again.status}：${again.raw}`)
      assert.equal(again.body.created, false)
      assert.equal(again.body.revisionChanged, false)
      assert.deepEqual(again.body.binding, first.body.binding)

      // 换角色 → 409，且旧绑定**保持原样**
      const conflict = await request('POST', '/api/workbench/personas/bind', { sessionId: 'sess-2', personaId: 'engineering/实现者' })
      assert.equal(conflict.status, 409, `不同绑定必须 409，实际 ${conflict.status}：${conflict.raw}`)
      assert.equal(conflict.body.code, 'binding-conflict')
      assert.match(conflict.body.error, /新建会话/)
      const after = await request('GET', `/api/workbench/personas/bind?session_id=sess-2`)
      assert.deepEqual(after.body.binding, first.body.binding, '409 不得改动既有绑定')

      // 未选角色 → 400，且**不写绑定行**
      const none = await request('POST', '/api/workbench/personas/bind', { sessionId: 'sess-none', personaId: '' })
      assert.equal(none.status, 400)
      assert.equal(none.body.code, 'missing-persona')
      assert.equal(readPersonaBinding(db, 'sess-none').missing, true, '未选角色不得写绑定')
      // 角色不存在 → 400（不是 500）
      const missing = await request('POST', '/api/workbench/personas/bind', { sessionId: 'sess-x', personaId: '不存在/的角色' })
      assert.equal(missing.status, 400)
      assert.equal(missing.body.code, 'not-found')
      // GET 没绑过 → binding:null（不是报错）
      const empty = await request('GET', '/api/workbench/personas/bind?session_id=sess-never')
      assert.equal(empty.status, 200)
      assert.equal(empty.body.binding, null)
    }, { roles: lib.roots })
  } finally {
    lib.cleanup()
  }
})

test('AX-R04 scope=persona 不覆盖 daily_plan 登记（同一 sessionId 两行互不影响）', async () => {
  const lib = makeLibrary()
  try {
    await withServer(async ({ db, request }) => {
      setExternalDir(db, lib.dirs.external.dir)
      // 先按既有路径登记一次"今日计划"会话（同一个 sessionId）
      registerAiSession(db, { scopeCode: 'daily_plan', anchor: '2026-10-01', sessionId: 'sess-3' })
      const bound = await request('POST', '/api/workbench/personas/bind', { sessionId: 'sess-3', personaId: 'rf/rf-天线测量专家' })
      assert.equal(bound.status, 201)
      const planRow = getAiSession(db, 'daily_plan', '2026-10-01')
      assert.equal(planRow.sessionId, 'sess-3', 'daily_plan 登记必须原样保留')
      assert.equal(planRow.note, null)
      const personaRow = getAiSession(db, PERSONA_BINDING_SCOPE, 'sess-3')
      assert.ok(personaRow !== undefined)
      assert.match(personaRow.note, /"personaId":"rf\/rf-天线测量专家"/)
    }, { roles: lib.roots })
  } finally {
    lib.cleanup()
  }
})

test('AX-R04 工具只按 exec.sessionId 读：无 session / 未绑定 / 传入任意 session_id 都读不到别人的角色', async () => {
  const lib = makeLibrary()
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    seedDictionaries(db)
    setExternalDir(db, lib.dirs.external.dir)
    const load = loadPersonaTool(db, lib.roots)
    const read = readPersonaResourceTool(db, lib.roots)

    // 参数形状：没有 session_id / persona_id / id 这类入参（越权面在结构上不存在）
    for (const tool of [load, read]) {
      const props = tool.parameters?.properties ?? {}
      const keys = Object.keys(props)
      assert.equal(keys.includes('session_id'), false, `${tool.name} 不得接受 session_id`)
      assert.equal(keys.includes('persona_id'), false, `${tool.name} 不得接受 persona_id`)
      assert.equal(keys.includes('personaId'), false, `${tool.name} 不得接受 personaId`)
    }
    assert.deepEqual(Object.keys(load.parameters?.properties ?? {}), [], 'load_persona 没有任何入参')

    const noSession = await load.execute({}, {})
    assert.match(noSession, /角色加载失败（no-session）/)
    const noSessionRead = await read.execute({ path: 'resources/checklist.md' }, {})
    assert.match(noSessionRead, /角色资源读取失败（no-session）/)

    const notBound = await load.execute({}, { agent: { session: { id: 'sess-unbound' } } })
    assert.match(notBound, /角色加载失败（not-bound）/)
    assert.match(notBound, /不能由调用方指定/)

    // 另一个会话绑了角色：本会话**仍然读不到**（工具不吃 session_id 入参）
    bindSessionPersona(db, { sessionId: 'sess-other', personaId: 'rf/rf-天线测量专家' }, lib.roots)
    const stillNotBound = await load.execute({}, { agent: { session: { id: 'sess-mine' } } })
    assert.match(stillNotBound, /not-bound/)
    // 即使有人把 session_id 塞进 args，也不起作用（参数未声明 → 忽略）
    const injected = await load.execute({ session_id: 'sess-other', persona_id: 'rf/rf-天线测量专家' }, { agent: { session: { id: 'sess-mine' } } })
    assert.match(injected, /not-bound/, '未声明的入参不得改变读取目标')

    // 自己的会话绑定了 → 能读到，且输出里**没有绝对路径**
    bindSessionPersona(db, { sessionId: 'sess-mine', personaId: 'rf/rf-天线测量专家' }, lib.roots)
    const ok = await load.execute({}, { agent: { session: { id: 'sess-mine' } } })
    assert.match(ok, /已加载本次会话绑定的角色「天线测量专家」/)
    assert.match(ok, /外部天线测量专家/)
    assert.match(ok, /resources\/checklist\.md/, '资源清单必须是相对路径')
    assert.equal(ok.includes(lib.dirs.external.dir), false, `工具输出不得出现来源绝对路径：${ok}`)
  } finally {
    db.close()
    lib.cleanup()
  }
})

// ---------------------------------------------------------------------------
// AX-R05：revision / 源丢失 / 资源先验绑定
// ---------------------------------------------------------------------------

test('AX-R05 正文修改后 revision 不符 → 明确拒绝旧绑定，且**不返回新正文**', async () => {
  const lib = makeLibrary()
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    seedDictionaries(db)
    setExternalDir(db, lib.dirs.external.dir)
    const file = join(lib.dirs.external.dir, 'rf', 'rf-天线测量专家.md')
    const bound = bindSessionPersona(db, { sessionId: 's1', personaId: 'rf/rf-天线测量专家' }, lib.roots)
    assert.equal(bound.ok, true)
    const revisionBefore = bound.binding.revision
    /** 绑定时读到的原文（下面用它做"只换行尾"的对照）。 */
    const originalText = personaText({ title: '天线测量专家', description: '合成外部角色。', body: '## 身份\n\n外部天线测量专家。\n' })

    // 改内容（同一文件）
    writeFileSync(file, personaText({ title: '天线测量专家', description: '合成外部角色。', body: '## 身份\n\n改写后的正文：这段绝不能被读到。\n' }), 'utf8')

    const loaded = loadSessionPersona(db, 's1', lib.roots)
    assert.equal(loaded.ok, false)
    assert.equal(loaded.code, 'revision-changed', `期望 revision-changed，实际 ${loaded.code}：${loaded.message}`)
    assert.match(loaded.message, /新建会话/)
    assert.equal(JSON.stringify(loaded).includes('改写后的正文'), false, '拒绝时不得把新正文带出去')

    // CRLF 与 LF 同哈希（T3 口径）：只换行尾不算"内容变了"
    writeFileSync(file, originalText.replace(/\n/g, '\r\n'), 'utf8')
    const lfEquivalent = loadSessionPersona(db, 's1', lib.roots)
    assert.equal(lfEquivalent.ok, true, `CRLF 与 LF 必须同哈希（否则一次 checkout 就让绑定全失效）：${JSON.stringify(lfEquivalent)}`)
    assert.equal(lfEquivalent.revision, revisionBefore)

    // 重复 load 同 revision 幂等一致
    const again = loadSessionPersona(db, 's1', lib.roots)
    assert.equal(again.ok, true)
    assert.equal(again.revision, lfEquivalent.revision)
    assert.deepEqual(again.document, lfEquivalent.document)
  } finally {
    db.close()
    lib.cleanup()
  }
})

test('AX-R05 源丢失/换源：明确报错，**不切到其他来源**（即使同名角色在别的来源里存在且内容一致）', async () => {
  const lib = makeLibrary()
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    seedDictionaries(db)
    setExternalDir(db, lib.dirs.external.dir)
    const externalFile = join(lib.dirs.external.dir, 'rf', 'rf-天线测量专家.md')
    const original = personaText({ title: '天线测量专家', description: '合成外部角色。', body: '## 身份\n\n外部天线测量专家。\n' })
    bindSessionPersona(db, { sessionId: 's1', personaId: 'rf/rf-天线测量专家' }, lib.roots)

    /**
     * 同名角色**逐字相同**地出现在内置库里，然后把外部的删掉。
     * 这时 revision 会一致 —— 只有 sourceKey 复核能拦住"静默切源"。
     */
    writePersona(lib.dirs.builtin.dir, join('rf', 'rf-天线测量专家.md'), original)
    unlinkSync(externalFile)

    const loaded = loadSessionPersona(db, 's1', lib.roots)
    assert.equal(loaded.ok, false, '源丢失必须报错，不能返回别的来源的正文')
    assert.equal(loaded.code, 'source-unavailable', `期望 source-unavailable，实际 ${loaded.code}：${loaded.message}`)
    assert.match(loaded.message, /不会把其他来源的同名角色当成同一个角色/)

    // 改配置 = 换身份：换到另一个外部根（那里有同名角色）
    const otherExternal = tempDir('external-2')
    try {
      writePersona(otherExternal.dir, join('rf', 'rf-天线测量专家.md'), original)
      setExternalDir(db, otherExternal.dir)
      const reconfigured = loadSessionPersona(db, 's1', lib.roots)
      assert.equal(reconfigured.ok, false)
      assert.equal(reconfigured.code, 'source-unavailable', '外部根改配置必须按"源已变"报错，不是"文件变了"')
    } finally {
      otherExternal.cleanup()
    }
  } finally {
    db.close()
    lib.cleanup()
  }
})

test('AX-R05 资源工具先验绑定与 revision：未绑定拒绝；绑定后正文改过也拒绝；越界路径定向拒绝', async () => {
  const lib = makeLibrary()
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    seedDictionaries(db)
    setExternalDir(db, lib.dirs.external.dir)
    const read = readPersonaResourceTool(db, lib.roots)

    const unbound = await read.execute({ path: 'resources/checklist.md' }, { agent: { session: { id: 's1' } } })
    assert.match(unbound, /not-bound/)

    bindSessionPersona(db, { sessionId: 's1', personaId: 'rf/rf-天线测量专家' }, lib.roots)
    const ok = await read.execute({ path: 'resources/checklist.md' }, { agent: { session: { id: 's1' } } })
    assert.match(ok, /已读取角色「天线测量专家」的资源/)
    assert.match(ok, /一条合成检查项/)

    // 越界：定向拒绝（不是"找不到"）
    const traversal = await read.execute({ path: '../../../../etc/passwd' }, { agent: { session: { id: 's1' } } })
    assert.match(traversal, /resource-invalid-path/)
    const encoded = await read.execute({ path: 'resources/%2e%2e%2fsecret.md' }, { agent: { session: { id: 's1' } } })
    assert.match(encoded, /resource-invalid-path/)
    const absolute = await read.execute({ path: 'C:\\Windows\\win.ini' }, { agent: { session: { id: 's1' } } })
    assert.match(absolute, /resource-invalid-path/)

    // 角色正文改过 → 资源也要拒绝（"每次读工具先校验当前会话绑定及角色revision"）
    writeFileSync(join(lib.dirs.external.dir, 'rf', 'rf-天线测量专家.md'), personaText({ body: '## 身份\n\n改过了。\n' }), 'utf8')
    const stale = await read.execute({ path: 'resources/checklist.md' }, { agent: { session: { id: 's1' } } })
    assert.match(stale, /revision-changed/, `期望 revision-changed，实际：${stale}`)
  } finally {
    db.close()
    lib.cleanup()
  }
})

test('AX-R05 绑定记录损坏 ≠ 没绑定：报"损坏"并保持 GET 的 binding:null（不把损坏当没绑）', async () => {
  const lib = makeLibrary()
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    seedDictionaries(db)
    setExternalDir(db, lib.dirs.external.dir)
    // 直接写一行坏 note（模拟手改/旧版本写的形状）
    registerAiSession(db, { scopeCode: PERSONA_BINDING_SCOPE, anchor: 's-broken', sessionId: 's-broken', note: '{"version":0}' })
    const lookup = readPersonaBinding(db, 's-broken')
    assert.equal(lookup.missing, false)
    assert.equal(lookup.corrupt, true)

    const loaded = loadSessionPersona(db, 's-broken', lib.roots)
    assert.equal(loaded.ok, false)
    assert.equal(loaded.code, 'binding-corrupt')
    assert.match(loaded.message, /不等于"没有绑定"/)

    const readTool = readPersonaResourceTool(db, lib.roots)
    const out = await readTool.execute({ path: 'resources/checklist.md' }, { agent: { session: { id: 's-broken' } } })
    assert.match(out, /binding-corrupt/)

    // 已有坏绑定时再绑定：409（不静默覆盖损坏记录）
    const rebind = bindSessionPersona(db, { sessionId: 's-broken', personaId: 'rf/rf-天线测量专家' }, lib.roots)
    assert.equal(rebind.ok, false)
    assert.equal(rebind.code, 'binding-corrupt')
    assert.equal(rebind.status, 409)
  } finally {
    db.close()
    lib.cleanup()
  }
})

test('AX-R04 绑定写入幂等：同值重复写不新增行、created_at 保持首次', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    seedDictionaries(db)
    const record = {
      version: PERSONA_BINDING_VERSION,
      personaId: 'a/b',
      sourceKey: 'external:abc',
      relativePath: 'a/b.md',
      revision: 'f'.repeat(64),
    }
    const first = writePersonaBinding(db, 's1', record)
    const row1 = getAiSession(db, PERSONA_BINDING_SCOPE, 's1')
    const second = writePersonaBinding(db, 's1', record)
    const row2 = getAiSession(db, PERSONA_BINDING_SCOPE, 's1')
    assert.deepEqual(first, second)
    assert.equal(row1.createdAt, row2.createdAt, '重复写不得刷新 created_at')
    const count = db.prepare('SELECT COUNT(*) AS n FROM ai_session_registry WHERE scope_code = ?').get(PERSONA_BINDING_SCOPE)
    assert.equal(count.n, 1, '同一会话只允许一行绑定')
  } finally {
    db.close()
  }
})
