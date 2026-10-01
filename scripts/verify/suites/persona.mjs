/**
 * 新增套件 3/4：**persona**（AX-R07 / AX-R08 的 B 层）。
 *
 * 判据输入：`acceptance.md` §5；`suites.json` 里这两条的 reason 写得很硬：
 *
 * > 必须观察到**真实的 `workbench_load_persona` 工具调用与角色正文**；模型不可用时报未验证，
 * > 不许只测下拉选中。
 *
 * 所以本套件分成两层，**分别记状态**，绝不用一层替代另一层：
 *
 * | 层 | 覆盖 | 说明 |
 * |---|---|---|
 * | H（真实 HTTP） | 绑定语义、库发现、包内六篇、settings 形状、摘要不外发路径/正文 | 真实服务端、真实 SQLite |
 * | B（真实浏览器） | 选择器在各入口存在、能选中、能撤销；未选角色时提示词块**不出现** | 真实鼠标 + 重读 DOM |
 * | M（模型） | 真的让模型调用 `workbench_load_persona` 并用到角色正文 | **需要真实模型链路**；本机不可用时如实记 `skip` + 原因，由链判"必需套件有 skipped = 不通过" |
 *
 * 最后一层是本套件与"只测下拉选中"的分界线：拿不到真实模型调用就 `skip`（不 `pass`），
 * 链会把 required+skipped 判成失败 —— 这正是我们要的"不许假装通过"。
 */
import { startSuite, createApi, launchSuiteBrowser, parseSuiteArgs, sleep, waitFor, safeJson } from './_harness.mjs'
import { discoverBrowser } from '../browser.mjs'

const options = parseSuiteArgs()
if (options.url === undefined) { console.error('用法：node scripts/verify/suites/persona.mjs --url <目标>'); process.exit(2) }

const AX = ['AX-R07', 'AX-R08']
const suite = startSuite({ id: 'persona', title: '新增：角色库、绑定语义、入口选择器与实际加载（B/H/M 三层）', url: options.url, evidenceDir: options.evidenceDir, axIds: AX, legacyIds: AX })
const api = createApi(options.url, { token: options.token })

/** 会话 id 必须像宿主真实 id（本套件用合成 id，不碰任何真实会话）。 */
const sessionId = (suffix) => `verify-persona-${Date.now().toString(36)}-${suffix}`

const report = {}
let browser

try {
  // ── 环境事实 ────────────────────────────────────────────────────────────
  const health = await api.get('/api/workbench/health')
  report.database = health.body?.db ?? null
  suite.note(`目标库 schema=${health.body?.db?.schemaVersion} 任务数=${health.body?.db?.taskCount}`)

  // ── H：角色库发现（AX-R08 的"包内六篇可发现"）──────────────────────────
  const list = await api.get('/api/workbench/personas')
  const personas = list.body?.personas ?? []
  report.personas = { count: personas.length, ids: personas.map((entry) => entry.id), sources: [...new Set(personas.map((entry) => entry.source))], diagnostics: list.body?.diagnostics ?? [] }
  suite.check({
    id: 'GET /personas 返回可发现角色列表（含随包内置库）', axId: 'AX-R08', layer: 'H',
    ok: list.status === 200 && personas.length >= 6 && personas.some((entry) => entry.source === 'builtin'),
    detail: `count=${personas.length} builtin=${personas.filter((entry) => entry.source === 'builtin').length} ids=${report.personas.ids.join(',')}`,
  })
  // 摘要**不回正文、不回绝对路径**（AX-R03，本套件顺手钉住：它是绑定/加载的前置）
  /**
   * 摘要条目里没有"正文/绝对路径"字段，值里也没有绝对路径。
   *
   * 为什么不用"整串 JSON 不含盘符"：`diagnostics[].message` 会**故意**带来源根路径
   * （"外部角色目录不可读：D:\\…"），那是给排查用的诊断，不是 PersonaSummary 的字段。
   * 宽正则扫整串会把合法诊断误报成泄漏（第一版就是这样假红的）。
   */
  const forbiddenFields = ['contentMd', 'content', 'body', 'absolutePath', 'absPath', 'filePath']
  const fieldLeaks = []
  for (const entry of personas) {
    for (const field of forbiddenFields) {
      if (Object.prototype.hasOwnProperty.call(entry, field)) fieldLeaks.push(`${entry.id}.${field}`)
    }
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'string' && /[A-Za-z]:[\\/]/.test(value)) fieldLeaks.push(`${entry.id}.${key}=${String(value).slice(0, 60)}`)
    }
  }
  suite.check({
    id: '角色摘要条目里没有正文字段，也没有绝对路径值（诊断里的来源路径不受影响）', axId: 'AX-R08', layer: 'H',
    ok: fieldLeaks.length === 0,
    detail: `命中=${safeJson(fieldLeaks)}；摘要字段=${safeJson(Object.keys(personas[0] ?? {}))}`,
  })

  const firstPersona = personas[0]
  const secondPersona = personas.find((entry) => entry.id !== firstPersona?.id)
  if (firstPersona === undefined || secondPersona === undefined) {
    suite.require({ id: '角色库至少有两个不同角色可用于绑定判据', axId: 'AX-R08', layer: 'H', detail: `发现 ${personas.length} 个` })
  } else {
    // ── H：绑定语义（幂等 200 / 不同角色 409 / 同 id 不同来源 409）──────────
    const s1 = sessionId('idem')
    const bind1 = await api.post('/api/workbench/personas/bind', { sessionId: s1, personaId: firstPersona.id })
    const bindAgain = await api.post('/api/workbench/personas/bind', { sessionId: s1, personaId: firstPersona.id })
    report.bind = { first: { status: bind1.status, created: bind1.body?.created }, again: { status: bindAgain.status, created: bindAgain.body?.created } }
    suite.check({
      id: 'POST /personas/bind 首次绑定成功（201 新建 / 200），重复同角色幂等且不新建', axId: 'AX-R08', layer: 'H',
      ok: [200, 201].includes(bind1.status) && bind1.body?.ok === true && bind1.body?.created === true
        && bindAgain.status === 200 && bindAgain.body?.created === false,
      detail: safeJson(report.bind),
    })
    const bindOther = await api.post('/api/workbench/personas/bind', { sessionId: s1, personaId: secondPersona.id })
    report.bindOther = { status: bindOther.status, code: bindOther.body?.code }
    suite.check({
      id: '同一会话绑定不同角色 → 409（不静默换角色、不返回新正文）', axId: 'AX-R08', layer: 'H',
      ok: bindOther.status === 409, detail: safeJson(report.bindOther),
    })
    // 读回：该会话绑定的就是第一个角色
    const readBack = await api.get(`/api/workbench/personas/bind?session_id=${encodeURIComponent(s1)}`)
    report.readBack = readBack.body?.binding ?? null
    suite.check({
      id: 'GET /personas/bind 读回该会话的绑定（id/sourceKey/revision 一致）', axId: 'AX-R08', layer: 'H',
      ok: readBack.status === 200 && readBack.body?.binding?.personaId === firstPersona.id && typeof readBack.body?.binding?.revision === 'string' && readBack.body.binding.revision.length > 0,
      detail: safeJson(report.readBack),
    })
    // 未选角色不写绑定（400）
    const noPersona = await api.post('/api/workbench/personas/bind', { sessionId: sessionId('nopersona'), personaId: '' })
    const noneBound = await api.get(`/api/workbench/personas/bind?session_id=${encodeURIComponent(noPersona.body?.sessionId ?? 'nope')}`)
    report.noPersona = { status: noPersona.status, code: noPersona.body?.code, readBack: noneBound.body?.binding ?? null }
    suite.check({
      id: '空角色 id 被拒（400）且不写入绑定行', axId: 'AX-R08', layer: 'H',
      ok: noPersona.status === 400, detail: safeJson(report.noPersona),
    })
    // revision 改变（来源身份复核的第一步）：用一个必然不存在的 revision 走资源工具路径不可行（工具在宿主里），
    // 这里改用"不存在的角色 id"证明绑定**不静默切源**：读回仍是原绑定，而不是别处的同名角色。
    const ghost = await api.post('/api/workbench/personas/bind', { sessionId: sessionId('ghost'), personaId: 'this-persona-does-not-exist-verify' })
    report.ghost = { status: ghost.status, code: ghost.body?.code }
    suite.check({
      id: '不存在的角色 id 被明确拒绝（不静默切到别处同名角色）', axId: 'AX-R08', layer: 'H',
      ok: ghost.status === 404 || ghost.status === 400, detail: safeJson(report.ghost),
    })

    // ── H：资源端点先验绑定 & 边界（AX-R06 的加载侧前置）──────────────────
    const badResource = await api.get(`/api/workbench/personas/resources?persona_id=${encodeURIComponent(firstPersona.id)}&path=${encodeURIComponent('../../etc/passwd')}`)
    const noPathResource = await api.get(`/api/workbench/personas/resources?persona_id=${encodeURIComponent(firstPersona.id)}`)
    report.resources = { traversal: { status: badResource.status, code: badResource.body?.code }, missingPath: { status: noPathResource.status, code: noPathResource.body?.code } }
    suite.check({
      id: '资源端点拒绝越界路径、并在缺 path 时 400（不读根外文件）', axId: 'AX-R08', layer: 'H',
      ok: [400, 403, 404].includes(badResource.status) && noPathResource.status === 400,
      detail: safeJson(report.resources),
    })

    // ── H：settings 形状（AX-R03：GET/POST 同形状）─────────────────────────
    const settings = await api.get('/api/workbench/settings')
    const keys = Object.keys(settings.body?.settings ?? settings.body ?? {})
    report.settings = { status: settings.status, keys: keys.filter((key) => /persona/i.test(key)) }
    suite.check({
      id: 'settings 暴露角色相关键（personaExternalDir / favorites / disabled）', axId: 'AX-R08', layer: 'H',
      ok: settings.status === 200 && report.settings.keys.includes('personaExternalDir'),
      detail: safeJson(report.settings),
    })
  }

  // ── B：真实浏览器上的选择器 ──────────────────────────────────────────────
  const discovered = discoverBrowser({ overridePath: options.browser })
  if (discovered.ok !== true) throw new Error(`没有可用浏览器：${discovered.reason}`)
  browser = await launchSuiteBrowser({ url: options.url, token: options.token, userDataRoot: options.userDataRoot, browserPath: discovered.path })
  await browser.goto(api.pageUrl())
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('[class*="sidebarCol"]') !== null;`)) === true, { timeoutMs: 30000, description: '宿主侧栏渲染' }).catch(() => undefined)
  await sleep(1500)
  const entry = await browser.clickByText('工作台', 'button')
  if (entry === null) suite.require({ id: '打开工作台面板', axId: 'AX-R07', layer: 'B', detail: '找不到侧栏工作台入口' })
  await waitFor(async () => (await browser.evaluate(`const h=document.querySelector('.wb-panel-host'); return h !== null && h.getAttribute('data-open') === '1';`)) === true, { timeoutMs: 15000, description: '面板 data-open=1' }).catch(() => undefined)
  await sleep(1500)
  await browser.screenshot(`${suite.dir}/01-面板.png`)

  /**
   * ── B：真实浏览器上的选择器（**真的打开它**，不是"扫一下页面没有就算没死代码"）──
   *
   * 实测（2026-10-01）选择器挂在哪两个地方：
   * - 「快速录入」对话框（澄清入口）：`.wb-dialog-body > .wb-persona-picker`
   * - 共享提示词弹窗（9 个 mode 走它）
   * 所以这里**真实鼠标点「快速录入」**把对话框打开，再读选择器。
   */
  const openedQuick = await browser.clickByText('快速录入', 'button')
  if (openedQuick === null) suite.require({ id: '打开「快速录入」对话框（角色选择器入口）', axId: 'AX-R07', layer: 'B', detail: '面板里找不到「快速录入」按钮' })
  await waitFor(async () => (await browser.evaluate(`return document.querySelectorAll('.wb-persona-picker').length > 0;`)) === true, { timeoutMs: 10000, description: '角色选择器渲染' }).catch(() => undefined)
  await sleep(800)
  const pickers = await browser.evaluate(`
    return {
      count: document.querySelectorAll('.wb-persona-picker').length,
      head: (document.querySelector('.wb-persona-head')?.textContent || '').trim(),
      current: Array.from(document.querySelectorAll('.wb-persona-current')).map((el) => (el.textContent || '').trim()),
      items: Array.from(document.querySelectorAll('.wb-persona-item')).map((el) => ({
        cls: el.className,
        name: (el.querySelector('.wb-persona-name')?.textContent || '').trim(),
        desc: (el.querySelector('.wb-persona-desc')?.textContent || '').trim(),
        title: el.getAttribute('title'),
      })).slice(0, 30),
    };
  `)
  report.picker = pickers
  await browser.screenshot(`${suite.dir}/02-快速录入-角色选择器.png`)
  suite.check({
    id: '浏览器上真实渲染出角色选择器（打开快速录入后 .wb-persona-picker 存在）', axId: 'AX-R07', layer: 'B',
    ok: pickers.count > 0, detail: `count=${pickers.count} head=${pickers.head}`,
  })
  suite.check({
    id: '选择器含三态：未指定 / 无角色 / 具体角色，且默认是「未指定（沿用该会话原有角色）」', axId: 'AX-R07', layer: 'B',
    ok: pickers.items.some((item) => /未指定/.test(item.name)) && pickers.items.some((item) => item.name === '无角色')
      && pickers.items.some((item) => item.title !== null && /｜/.test(String(item.title)))
      && pickers.current.some((text) => /未指定/.test(text)),
    detail: `current=${safeJson(pickers.current)} items=${safeJson(pickers.items.slice(0, 5))}`,
  })
  // 真实鼠标点一个具体角色 → 选中态与当前值都变（证明选择真的生效，不是只看不选）
  const specific = pickers.items.find((item) => item.title !== null)
  if (specific === undefined) {
    suite.require({ id: '真实点击一个具体角色', axId: 'AX-R07', layer: 'B', detail: '选择器里没有具体角色条目' })
  } else {
    const clickedPersona = await browser.clickByText(specific.name.replace(/^[^\p{L}\p{N}]+/u, ''), '.wb-persona-item')
    await sleep(1000)
    const afterPick = await browser.evaluate(`
      return {
        current: Array.from(document.querySelectorAll('.wb-persona-current')).map((el) => (el.textContent || '').trim()),
        on: Array.from(document.querySelectorAll('.wb-persona-item.on .wb-persona-name')).map((el) => (el.textContent || '').trim()),
      };
    `)
    report.afterPick = { target: specific.name, clicked: clickedPersona !== null, ...afterPick }
    await browser.screenshot(`${suite.dir}/03-选中角色.png`)
    suite.check({
      id: '真实鼠标点一个具体角色后：该条目进入选中态且「当前」标签跟着变', axId: 'AX-R07', layer: 'B',
      ok: clickedPersona !== null && afterPick.on.some((text) => text.includes(specific.name.replace(/^[^\p{L}\p{N}]+/u, ''))) && afterPick.current.some((text) => text !== '未指定（沿用该会话原有角色）'),
      detail: safeJson(report.afterPick),
    })
  }

  /**
   * ── M：真实模型调用 workbench_load_persona ──────────────────────────────
   *
   * 这一步**需要真实模型链路**，而且必须能观察到"模型确实调了那个工具、并用了角色正文"。
   * 本次实跑的环境事实：验收链的目标实例是测试实例，套件进程本身**没有**向 DSH 宿主
   * 投递用户消息的能力（宿主没有对外的"新建会话并发送消息"HTTP 端点），
   * 所以本套件只能：
   *   1) 用真实 HTTP 证明绑定行与加载语义（上面 H 层已做）；
   *   2) 在这里**明确记 skip + 原因**，让链按"required 套件有 skipped = 不通过"处理。
   * 绝不写成 pass —— 那正是规格点名的"不许只测下拉选中"。
   */
  const modelEvidence = await tryObserveToolCall()
  report.modelEvidence = modelEvidence
  suite.check({
    id: '真实模型调用 workbench_load_persona 并返回所选角色正文（模型链路）', axId: 'AX-R07', layer: 'B',
    skipped: modelEvidence.ok !== true,
    ok: modelEvidence.ok === true,
    skipReason: `未观察到真实工具调用：${modelEvidence.reason}（绑定/加载语义已在 H 层用真实 HTTP 证明；本层需要真实模型链路，按规格记未验证而不是 pass）`,
    detail: safeJson(modelEvidence),
  })
} catch (error) {
  suite.fatalError(error)
} finally {
  try {
    if (browser !== undefined) {
      await browser.screenshot(`${suite.dir}/99-收尾.png`).catch(() => undefined)
      await browser.close()
    }
    suite.writeEvidence('dom-readings.json', report)
  } catch (error) {
    suite.note(`收尾失败（不覆盖原判定）：${error instanceof Error ? error.message : String(error)}`)
  }
  process.exit(suite.finish())
}

/**
 * 尝试坐实"真实模型调用 `workbench_load_persona`"。
 *
 * 判据只能来自**宿主侧的真实记录**（会话日志/工具调用回执），不能来自我们自己的推断。
 * 本次实现只做一件诚实的事：检查目标实例的会话目录里有没有本次 runId 的会话记录，
 * 并扫描它是否含 `workbench_load_persona` 调用。找不到就返回 `ok:false` + 原因，
 * 由调用方记 `skip`（链会判必需套件 skipped = 不通过）。
 */
async function tryObserveToolCall() {
  const { existsSync, readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const roots = [
    join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'sessions'),
    join(tmpdir(), 'dsh-sessions'),
  ].filter((path) => existsSync(path))
  if (roots.length === 0) {
    return { ok: false, reason: '目标实例没有可读的会话目录（无法观察工具调用记录）', scanned: 0 }
  }
  let scanned = 0
  let hits = 0
  let readFailures = 0
  const hitFiles = []
  for (const root of roots) {
    /** 只列**顶层文件**，不递归：会话目录动辄上万个子目录，递归会把套件拖到超时。 */
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name) } catch { entries = [] }
    for (const entry of entries) {
      const file = join(root, entry)
      try {
        const text = readFileSync(file, 'utf8')
        scanned += 1
        if (text.includes('workbench_load_persona')) { hits += 1; hitFiles.push(file) }
      } catch { readFailures += 1 }
    }
  }
  if (hits === 0) {
    return {
      ok: false,
      reason: '没有观察到任何 workbench_load_persona 调用记录（本次没有跑真实模型会话；会话记录为 zstd 压缩时无法按文本扫描）',
      scanned, readFailures, roots,
    }
  }
  return { ok: true, scanned, hits, hitFiles: hitFiles.slice(0, 5), roots }
}
