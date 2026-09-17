/**
 * 实测复现：「知识草稿静默覆盖」修复前 → 修复后（任务 f4a3430f）。
 *
 * ## 验收要求的三步，本脚本一条命令跑完
 *
 * 1. **连续提交两次**：用**真实的 `workbench_submit_knowledge` 工具**（同一会话 id）提交两条
 *    独立主题的知识，把两次原始回执逐字打出来；
 * 2. **到界面确认**：把**真实组件** `KnowledgeDraftBody`（弹窗里 `kindCode === 'knowledge'`
 *    那一块）渲染成 HTML → 在 headless Edge 里加载 → 断言"这是替换、不是新增"的提示
 *    **真的画出来了**（尺寸/可见性/文本），并截图；
 * 3. **检查实际入库内容**：调**真实的 `confirmKnowledgeDraft`**（HTTP 确认接口走的就是它）
 *    完成"用户点确认入库"，然后回读知识库：入库的是**第二次**的内容，第一次的内容
 *    在库里**找不到任何痕迹** —— 这就是那条"静默覆盖"，现在它至少在界面上和回执里可见了。
 *
 * ## 安全边界（务必保留）
 *
 * 全程在**真实库的只读副本**上跑（`~/.dsh/workbench/workbench.db` → `VACUUM INTO` 到
 * `_local-archive/`），会话 id 用 `repro-overwrite-…` 这种一次性的，
 * **不碰用户的任何草稿/知识条目**。跑完把本次造出来的草稿与条目删掉并断言删除成功
 * （脚本自己也验证"删除确实生效"，避免留下脏数据）。
 *
 * 用法：node scripts/repro/repro-knowledge-draft-overwrite.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const ROOT = resolve('.')
const OUT = resolve('_local-archive/knowledge-draft-overwrite')
mkdirSync(OUT, { recursive: true })

const { openWorkbenchDb } = await import(pathToFileURL(resolve('lib/db/database.js')).href)
const { submitKnowledgeTool } = await import(pathToFileURL(resolve('lib/tools.js')).href)
const { confirmKnowledgeDraft, createDraft, deleteDraftRow, deleteKnowledge, getDraft, listKnowledge } = await import(pathToFileURL(resolve('lib/db/repo.js')).href)
const { KnowledgeDraftBody } = await import(pathToFileURL(resolve('lib/client/components/KnowledgeDraftBody.js')).href)
const { WORKBENCH_CSS } = await import(pathToFileURL(resolve('lib/client/styles.js')).href)

const LIVE_DB = join(homedir(), '.dsh', 'workbench', 'workbench.db')
const COPY_DB = join(OUT, 'workbench-copy.db')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// ---------------------------------------------------------------- 0. 真实库的只读副本

if (!existsSync(LIVE_DB)) {
  console.error(`SKIP: 没找到真实库 ${LIVE_DB}`)
  process.exit(2)
}
if (existsSync(COPY_DB)) rmSync(COPY_DB, { force: true })
{
  // `VACUUM INTO` 读的是同一时刻的一致快照（直接复制 .db 可能撞上 WAL 里未落盘的页）。
  const live = new DatabaseSync(LIVE_DB, { readOnly: true })
  try {
    live.exec(`VACUUM INTO '${COPY_DB.replace(/'/g, "''")}'`)
  } finally {
    live.close()
  }
}
console.log(`真实库副本：${COPY_DB}\n`)

const db = openWorkbenchDb({ dbPath: COPY_DB })

// ---------------------------------------------------------------- 1. 连续提交两次（真实工具）

const SESSION = `repro-overwrite-${Date.now().toString(36)}`
const FIRST = {
  title: '复现实测·第一条：cloudflared 连 3081 被 WSL2 劫持',
  content_md: '## 现象\n端口连不上。\n## 解法\n改用 3082。\n\n（这是**第一次**提交的内容，若被覆盖就再也看不到了）',
  tags: ['复现', '第一条'],
}
const SECOND = {
  title: '复现实测·第二条：VACUUM INTO 才是安全的库副本',
  content_md: '## 结论\n直接复制 .db 可能撞上未落盘的 WAL 页，改用 VACUUM INTO。\n\n（这是**第二次**提交的内容，最终入库的应该是这一条）',
  tags: ['复现', '第二条'],
}

const tool = submitKnowledgeTool(db)
const out1 = await tool.execute({ ...FIRST, kind_code: 'lesson' }, { agent: { session: { id: SESSION } } })
const out2 = await tool.execute({ ...SECOND, kind_code: 'lesson' }, { agent: { session: { id: SESSION } } })

console.log('===== 第一次提交的工具回执 =====')
console.log(out1)
console.log('\n===== 第二次提交的工具回执（本次修复的重点）=====')
console.log(out2)
console.log('')

const draft = getDraftIdOfSession()
function getDraftIdOfSession() {
  const rows = db.prepare("SELECT id FROM task_drafts WHERE session_id = ? AND kind_code = 'knowledge' AND status_code = 'pending'").all(SESSION)
  return rows.length === 1 ? String(rows[0].id) : null
}

check('两次提交命中的是同一份草稿（去重语义未改，这是有意设计）', draft !== null, `draft id = ${draft}`)
check('第一次回执说明"已新建"', /知识草稿已新建/.test(out1))
check('第二次回执说明"已更新本会话已有草稿 / 不是新建"', /已更新本会话已有草稿/.test(out2) && /不是新建/.test(out2))
check('第二次回执带上草稿 id（用户不再"看不到 id"）', draft !== null && out2.includes(draft))
check('第二次回执说出被替换掉的那条标题', out2.includes(FIRST.title))
check('第二次回执把"一个会话只产生 1 条 + 绕行路由"写清楚', /一个会话最多产出 1 条知识/.test(out2) && /POST \/api\/workbench\/drafts/.test(out2))

const draftRow = getDraft(db, draft)
check('草稿 payload 里落了覆盖历史（界面靠它显示"这是替换"）',
  draftRow.payload.revision === 2 && Array.isArray(draftRow.payload.replacedTitles) && draftRow.payload.replacedTitles[0] === FIRST.title,
  `revision=${String(draftRow.payload.revision)} replacedTitles=${JSON.stringify(draftRow.payload.replacedTitles)}`)
check('草稿里现在只剩第二次的内容（第一次的内容已被替换掉）',
  draftRow.payload.title === SECOND.title && String(draftRow.payload.contentMd) === SECOND.content_md)

// ---------------------------------------------------------------- 2. 界面：真组件 + 真样式 + 真浏览器

console.log('')
/**
 * **修前对照**：把 `revision` / `replacedTitles` 摘掉再渲染同一个组件 ——
 * 那正是修复前的 payload 形态（历史根本没落库），界面上一句提示都没有。
 * 两个版本并排放在同一页，一张截图就能看出"修前静默 / 修后有提示"。
 */
const beforePayload = { ...draftRow.payload }
delete beforePayload.revision
delete beforePayload.replacedTitles
const beforeHtml = renderToStaticMarkup(createElement(KnowledgeDraftBody, { draftId: draft, payload: beforePayload }))
const afterHtml = renderToStaticMarkup(createElement(KnowledgeDraftBody, { draftId: draft, payload: draftRow.payload }))
const PAGE = join(OUT, 'draft-banner.html')
writeFileSync(PAGE, `<!doctype html><html data-dsh-personal-workbench-official><head><meta charset="utf-8">
<style>${WORKBENCH_CSS}</style>
<style>body{margin:0;background:#1b1f27;color:#d8dde4;font-family:system-ui,"Microsoft YaHei",sans-serif}
.rail{display:flex;gap:16px;padding:12px}
.pane{flex:1 1 0;max-width:560px;background:#1c1c1f;color:#eee;border:1px solid rgba(255,255,255,.2);border-radius:12px;padding:12px}
.tag{font-size:11px;opacity:.7;margin-bottom:6px}</style></head>
<body><div class="wb-panel-host" data-open="1"><div class="wb-app-scope" data-dsh-personal-workbench-view><div class="rail">
  <div class="wb-dialog-body" id="before"><div class="tag">修前（payload 里没有覆盖历史）</div>${beforeHtml}</div>
  <div class="wb-dialog-body" id="after"><div class="tag">修后（同一次覆盖，历史已落库）</div>${afterHtml}</div>
</div></div></div></body></html>`)

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
if (EDGE === undefined) {
  console.error('SKIP: 未找到 Edge（界面层无法验证，其余断言已完成）')
} else {
  const PORT = 9800 + Math.floor(Math.random() * 150)
  const profile = mkdtempSync(join(tmpdir(), 'kd-overwrite-'))
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1200,900', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const endpoint = async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        const target = list.find((x) => x.type === 'page')
        if (target !== undefined) return target.webSocketDebuggerUrl
      } catch { /* not ready */ }
      await sleep(250)
    }
    throw new Error('CDP 端点超时')
  }
  const ws = new WebSocket(await endpoint())
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error !== undefined) reject(new Error(JSON.stringify(msg.error))); else ok(msg.result)
    }
  }
  const send = (method, params = {}) => {
    const mid = ++id
    return new Promise((ok, reject) => { pending.set(mid, { resolve: ok, reject }); ws.send(JSON.stringify({ id: mid, method, params })) })
  }
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate threw')
    return r.result.value
  }
  try {
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Page.navigate', { url: pathToFileURL(PAGE).href })
    await sleep(1000)
    const probe = await evaluate(`(() => {
      const el = document.querySelector('#after .wb-draft-overwrite-notice')
      const beforeEl = document.querySelector('#before .wb-draft-overwrite-notice')
      if (el === null) return { found: false, beforeFound: beforeEl !== null }
      const rect = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const title = document.querySelector('#after > div:nth-of-type(3)')
      return {
        found: true,
        beforeFound: beforeEl !== null,
        text: el.textContent,
        width: Math.round(rect.width), height: Math.round(rect.height),
        top: Math.round(rect.top),
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        borderLeft: cs.borderLeftColor,
        containsDraftId: el.textContent.includes(${JSON.stringify(draft)}),
        beforeTitle: title !== null && el.compareDocumentPosition(title) === 4,
      }
    })()`)
    check('修前对照：同一个组件、同一份知识草稿，修前**没有**任何覆盖提示（静默的原始形态）', probe.beforeFound === false)
    check('界面真的渲染出了"这是替换"的提示块', probe.found === true)
    if (probe.found) {
      check('提示块有真实尺寸与可见的警示边框（不是被 CSS 藏起来）',
        probe.width > 200 && probe.height > 20 && probe.display !== 'none' && probe.visibility !== 'none' &&
        Number(probe.opacity) > 0 && !/rgba\(0, 0, 0, 0\)|transparent/.test(probe.borderLeft),
        `${probe.width}x${probe.height} display=${probe.display} visibility=${probe.visibility} opacity=${probe.opacity} borderLeft=${probe.borderLeft}`)
      check('提示块文本带草稿 id', probe.containsDraftId === true)
      check('提示块说清"前 N 次已被覆盖"', /前 1 次的内容已被覆盖/.test(probe.text) && probe.text.includes(FIRST.title))
      check('提示块排在标题/正文之上（用户点确认前先看到）', probe.beforeTitle === true)
      console.log(`\n界面提示原文：\n${probe.text}\n`)
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, 'draft-banner.png'), Buffer.from(shot.data, 'base64'))
    console.log(`界面截图：${join(OUT, 'draft-banner.png')}`)
  } finally {
    ws.close()
    child.kill()
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* Windows 上偶发占用，忽略 */ }
  }
}

// ---------------------------------------------------------------- 3. 到界面确认 → 入库内容

console.log('')
const created = confirmKnowledgeDraft(db, draft) // HTTP POST .../confirm 走的就是它
check('确认入库成功（用户点「确认入库」的效果）', created !== undefined, `knowledge id = ${created?.id}`)

const mine = listKnowledge(db).filter((entry) => entry.sourceSessionId === SESSION)
check('本会话确认后只入库了 1 条（一个会话只产生 1 条知识）', mine.length === 1, `入库 ${mine.length} 条`)
check('入库的是第二次的内容（第一次的内容真的没进库）',
  mine.length === 1 && mine[0].title === SECOND.title && mine[0].contentMd === SECOND.content_md)
check('第一次的内容在整库里搜不到（这就是被"静默覆盖"掉的东西）',
  listKnowledge(db).every((entry) => !entry.contentMd.includes('这是**第一次**提交的内容')))

console.log('\n===== 入库回读 =====')
for (const entry of mine) console.log(`- [${entry.id}] ${entry.title}\n  ${entry.contentMd.slice(0, 60).replace(/\n/g, ' ')}…`)
console.log(`\n第一次提交的内容（"${FIRST.title}" / ${FIRST.content_md.length} 字）在库里无任何痕迹 —— 覆盖是真实的；` +
  '本次修复让它在**回执**与**界面提示**上都可见。')

// ---------------------------------------------------------------- 4. 官方绕行方案确实可用

console.log('')
const multi1 = createDraft(db, { kindCode: 'knowledge', sessionId: SESSION, payload: { title: '绕行A', contentMd: 'x', kindCode: 'note' } })
const multi2 = createDraft(db, { kindCode: 'knowledge', sessionId: SESSION, payload: { title: '绕行B', contentMd: 'y', kindCode: 'note' } })
check('文档里指的绕行路由（POST /api/workbench/drafts → createDraft）在同一会话能并存多份草稿',
  multi1.id !== multi2.id && getDraft(db, multi1.id) !== undefined && getDraft(db, multi2.id) !== undefined)

// ---------------------------------------------------------------- 收尾：清掉本次造的数据

console.log('')
for (const d of [multi1.id, multi2.id]) db.prepare('DELETE FROM task_drafts WHERE id = ?').run(d)
if (created !== undefined) deleteKnowledge(db, created.id)
db.prepare('DELETE FROM task_drafts WHERE session_id = ?').run(SESSION)
const leftovers = db.prepare('SELECT COUNT(*) AS n FROM task_drafts WHERE session_id = ?').get(SESSION)
const leftoverEntries = listKnowledge(db).filter((entry) => entry.sourceSessionId === SESSION).length
check('收尾：本次造的草稿与知识条目已删干净（副本里不留脏数据）',
  Number(leftovers.n) === 0 && leftoverEntries === 0)
void deleteDraftRow

db.close()

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 项断言通过`)
if (failed.length > 0) {
  for (const f of failed) console.error(`FAIL  ${f.name}${f.detail === '' ? '' : '  — ' + f.detail}`)
  process.exit(1)
}
console.log('✅ 覆盖行为在**工具回执**与**界面提示**上都可见；入库内容与"只入库最后一次"的事实一致。')
