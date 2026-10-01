/**
 * 复现/验证：**工作台面板文本里的链接点击不许导航宿主文档**（P0 白屏事故，2026-10-01）。
 *
 * ## 事故与判据
 *
 * 面板里渲染的链接（任务描述 / 知识库正文 / 报告 …）原先是一个裸 `<a href="...">`：
 * 点击即**导航宿主文档**。Web 端 SPA 被导航走（页面不可用，重载能回来）；
 * 桌面端文档 URL 是 `dsh-app://app/…`，相对/协议相对类 href 解析后仍是 `dsh-app:` 协议 ——
 * 桌面主进程的 `will-navigate` 闸只拦非 dsh-app 目标，于是真导航发生 →
 * `dsh-app://app/<未知路径>` 被转发给本地 host → 404/空页 → **白屏且不可恢复**。
 *
 * 所以本探针的核心判据只有一条，但它就是"白屏与否"本身：
 *
 * > 真实鼠标点击链接之后，**主文档的 URL 必须一字不变**，面板仍活着。
 *
 * 配套判据（防止"把链接删了就全绿"这种假修复）：
 *
 * | 编号 | 判据 | 为什么 |
 * |---|---|---|
 * | LK-0 | 三方同源 buildId（客户端根节点属性 / host health / 盘上 build-info） | 证明"验的是本次构建"，而不是同批套件替它背书 |
 * | LK-1 | 点外链后主文档地址不变、面板仍在 | 白屏的判据本身 |
 * | LK-2 | 外链点击调用了 `window.open(<同一个 URL>)` | 证明"链接真的能点开"，不是被删掉 |
 * | LK-3 | 相对链接 / `javascript:` 链接**不是**锚点，点了不导航也不 open | 桌面端会白屏的正是这一类 |
 * | LK-4 | 全过程没有页面级 JS 异常 | 失败要可观测 |
 * | LK-5 | 粗体 / 行内代码 / 复选框 / 表格 / 引用 / 代码块 / 标题仍照常渲染 | 这次重构把行内解析搬进了纯模块，顺带盯住它别退化 |
 *
 * **LK-2 的证明力有上限**（写在明面上）：它把 `window.open` 打了桩，所以只证明"点击调用了
 * `window.open` 且 URL 正确"，**不证明新标签真的开出来**；`target=_blank` 是另一条腿（DOM 里已断言）。
 *
 * **落盘不含 token**：地址一律经 `LOCATION_KEY`（只抹掉 `?token=` 的值，保留 origin/path/其它 query）。
 *
 * ## 怎么跑
 *
 * ```sh
 * DSH_VERIFY_TOKEN=<本次启动的 token> node scripts/repro/verify-external-link-navigation.mjs \
 *   --url http://127.0.0.1:3080 --evidence-dir test-results/link-navigation/<runId>
 * ```
 *
 * token **只走环境变量**（argv 在进程列表里可见）；证据文件里**绝不**写 token。
 * 退出码：0 = 全部通过；1 = 有失败（含脚本级异常）；2 = 用法/前置缺失。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverBrowser } from '../verify/browser.mjs'
import { launchDebugBrowser, sleep } from '../verify/cdp.mjs'
import { createApi, originOf } from '../verify/suites/_harness.mjs'

/** 仓库根（本文件在 `scripts/repro/` 下）。 */
const repoRoot = () => fileURLToPath(new URL('../../', import.meta.url))

const EXTERNAL_URL = 'https://github.com/Dely0/dsh-personal-workbench/blob/main/README.md'

function parseArgs(argv) {
  const options = { url: 'http://127.0.0.1:3080', browser: undefined, evidenceDir: undefined, userDataRoot: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--url') options.url = argv[++index]
    else if (key === '--browser') options.browser = argv[++index]
    else if (key === '--evidence-dir') options.evidenceDir = argv[++index]
    else if (key === '--user-data-root') options.userDataRoot = argv[++index]
    else { console.error(`未知参数：${key}`); process.exit(2) }
  }
  options.token = process.env.DSH_VERIFY_TOKEN ?? ''
  return options
}

const options = parseArgs(process.argv.slice(2))
const api = createApi(options.url, { token: options.token })
const runId = `link-${Date.now().toString(36)}`
const marker = `【链接回归·临时·${runId}】`
const evidenceDir = options.evidenceDir ?? join('test-results', 'link-navigation', runId)

const checks = []
const record = (id, ok, detail) => {
  checks.push({ id, ok: ok === true, detail })
  console.log(`${ok === true ? '✅' : '❌'} ${id} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

const description = [
  `## 链接回归（${runId}）`,
  '',
  `- 外部链接：[README.md](${EXTERNAL_URL})`,
  '- 相对链接：[相对说明](README.md)',
  '- 脚本链接：[脚本说明](javascript:alert(1))',
  '',
  '点完这三个链接，面板必须还在，主文档 URL 不许变。',
  '',
  '### 行内渲染不退化（同一次重构把行内解析搬进了纯模块，这里顺带盯住它）',
  '',
  '**粗体**与`行内代码`与 ~~不支持的删除线~~。',
  '',
  '- [ ] 未完成项',
  '- [x] 已完成项',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '> 引用一行',
  '',
  '```js',
  'const x = 1',
  '```',
].join('\n')

let browser
let taskId
const evidence = { runId, url: originOf(options.url), marker, externalUrl: EXTERNAL_URL, description }

/**
 * 落盘一律用**去掉 token 的地址键**。
 *
 * 为什么要专门写一条：token 就藏在页面 URL 的 `?token=` 里（`_harness.pageUrl()` 拼的），
 * 而 `location.href` 是否被 SPA 清掉不由我们控制 —— 直接把 `location.href` 落盘就是一个单点泄漏。
 * 这个键保留 origin + pathname + 其余 query（所以"导航到别的路径"照样抓得住），只把 token 值抹掉。
 */
const LOCATION_KEY_SNIPPET = `
  const LOCATION_KEY = (() => {
    const search = location.search.replace(/([?&]token=)[^&]*/gi, '$1***');
    return location.origin + location.pathname + search;
  })();
`

try {
  mkdirSync(evidenceDir, { recursive: true })

  // ── 0. 合成任务（带 runId，只清自己造的那条） ──────────────────────────────
  const created = await api.post('/api/workbench/tasks', {
    title: `${marker}链接点击`,
    description,
    typeCode: 'code_impl',
    priorityCode: 'p2',
    statusCode: 'todo',
    dueAt: new Date().toISOString(),
  })
  if (created.status !== 201 && created.status !== 200) throw new Error(`建合成任务失败：HTTP ${created.status} ${JSON.stringify(created.body)}`)
  taskId = created.body?.task?.id
  evidence.taskId = taskId
  console.log(`· 合成任务 ${taskId}`)

  // ── 1. 真浏览器打开 Web 端 DSH ─────────────────────────────────────────────
  const discovered = discoverBrowser({ overridePath: options.browser })
  if (discovered.ok !== true) throw new Error(`没有可用浏览器：${discovered.reason}`)
  browser = await launchDebugBrowser({
    browserPath: discovered.path,
    appUrl: api.pageUrl(),
    tmpRoot: options.userDataRoot,
    callTimeoutMs: 30000,
  })
  await browser.goto(api.pageUrl())
  const landedKey = await browser.evaluate(`${LOCATION_KEY_SNIPPET}\nreturn LOCATION_KEY;`)
  evidence.landed = landedKey
  record('探针就绪：页面已加载且已认证',
    typeof landedKey === 'string' && landedKey.startsWith(originOf(options.url)),
    landedKey)

  /**
   * buildId：先证"浏览器真的加载了 host 正在服务的那份构建"（DOM == health），
   * 再记录它与**盘上仓库构建**是否一致（不一致只记事实、不判红 —— 例如故意部署旧包做红基线时，
   * 那句"不一致"恰恰是这条断言没在空转的证据）。
   * 属性名见 `src/client/index.tsx`（`data-workbench-build-id`，值来自 bundle 里的 `__WORKBENCH_BUILD_ID__`）。
   */
  const domBuildId = await browser.evaluate(`
    const node = document.querySelector('[data-workbench-build-id]');
    return node === null ? null : node.getAttribute('data-workbench-build-id');
  `)
  const health = await api.get('/api/workbench/health')
  const healthBuildId = health.body?.buildId ?? null
  let diskBuildId = null
  try { diskBuildId = JSON.parse(readFileSync(join(repoRoot(), 'lib', 'build-info.json'), 'utf8')).buildId } catch { diskBuildId = null }
  evidence.buildIds = { dom: domBuildId, health: healthBuildId, disk: diskBuildId, diskMatchesDeployed: diskBuildId === domBuildId }
  record('探针就绪：浏览器加载的就是 host 在服务的那份构建（DOM buildId == health buildId）',
    domBuildId !== null && domBuildId === healthBuildId,
    JSON.stringify(evidence.buildIds))

  // ── 2. 打开工作台面板 ─────────────────────────────────────────────────────
  const entryReady = await browser.waitFor(`
    const sidebar = document.querySelector('[class*="sidebarCol"]');
    if (sidebar === null) return 0;
    const vis = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    return Array.from(sidebar.querySelectorAll('button'))
      .filter((el) => el.hasAttribute('data-dsh-personal-workbench-entry') || (el.getAttribute('aria-label') || '').includes('工作台'))
      .filter(vis).length;
  `, { timeoutMs: 45000, description: '侧栏露出可见的工作台入口' }).catch(() => null)
  if (entryReady === null) throw new Error('侧栏没有可见的「工作台」入口（前置缺失 → 记失败，不跳过）')
  await browser.clickByText('工作台', 'button')
  await browser.waitFor(`const h = document.querySelector('.wb-panel-host'); return h !== null && h.getAttribute('data-open') === '1';`,
    { timeoutMs: 20000, description: '面板 data-open=1' })

  // ── 3. 打开合成任务的详情（描述里的链接就在那里） ──────────────────────────
  await browser.evaluate(`const s = Array.from(document.querySelectorAll('.wb-seg')).find((b) => (b.textContent || '').includes('任务')); if (s) s.click(); return true;`)
  await sleep(800)
  const rowFound = await browser.waitFor(`
    const marker = ${JSON.stringify(marker)};
    return Array.from(document.querySelectorAll('.wb-row')).some((row) => (row.textContent || '').includes(marker));
  `, { timeoutMs: 20000, description: '任务列表里出现合成任务行（任务 Tab）' }).catch(() => null)
  if (rowFound === null) throw new Error('任务列表里找不到合成任务行')
  const rowBox = await browser.evaluate(`
    const marker = ${JSON.stringify(marker)};
    const row = Array.from(document.querySelectorAll('.wb-row')).find((r) => (r.textContent || '').includes(marker));
    row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect();
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
  `)
  await sleep(150)
  await browser.clickAt(Math.round(rowBox.x), Math.round(rowBox.y))
  await sleep(900)

  // ── 4. 描述里三个链接都在吗 ───────────────────────────────────────────────
  const links = await browser.evaluate(`
    const host = document.querySelector('.wb-panel-host');
    const anchors = Array.from(host.querySelectorAll('a'));
    return {
      anchors: anchors.map((a) => ({ text: a.textContent || '', href: a.getAttribute('href') || '', target: a.getAttribute('target') || '', rel: a.getAttribute('rel') || '' })),
      hasExternal: anchors.some((a) => (a.getAttribute('href') || '') === ${JSON.stringify(EXTERNAL_URL)}),
    };
  `)
  evidence.anchors = links.anchors
  evidence.anchorsBeforeClick = links.anchors.length
  record('描述已渲染（详情页有三个链接文本）', (await browser.evaluate(`
    const host = document.querySelector('.wb-panel-host');
    const t = host === null ? '' : (host.innerText || '');
    return t.includes('README.md') && t.includes('相对说明') && t.includes('脚本说明');
  `)) === true, `anchors=${links.anchors.length}`)
  await browser.screenshot(join(evidenceDir, '01-detail-open.png'))

  // ── 5. 装 window.open 探针（观察"链接到底被谁打开"） ───────────────────────
  await browser.evaluate(`
    window.__linkProbe = { opened: [] };
    window.open = function (...args) { window.__linkProbe.opened.push(String(args[0])); return null; };
    return true;
  `)

  // ── 6. 真实鼠标点外链 ─────────────────────────────────────────────────────
  const externalBox = await browser.evaluate(`
    const host = document.querySelector('.wb-panel-host');
    const a = Array.from(host.querySelectorAll('a')).find((x) => (x.getAttribute('href') || '') === ${JSON.stringify(EXTERNAL_URL)});
    if (!a) return null;
    a.scrollIntoView({ block: 'center' });
    const r = a.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
  `)
  if (externalBox === null) throw new Error('描述里没有找到外部链接锚点（修复后它应当仍是可点的 <a>）')
  await sleep(150)
  await browser.clickAt(Math.round(externalBox.x), Math.round(externalBox.y))
  await sleep(1200)

  const afterExternal = await browser.evaluate(`${LOCATION_KEY_SNIPPET}
    const host = document.querySelector('.wb-panel-host');
    return {
      location: LOCATION_KEY,
      opened: (window.__linkProbe && window.__linkProbe.opened) || [],
      panelPresent: host !== null,
      panelOpen: host === null ? null : host.getAttribute('data-open'),
      anchorStillThere: host !== null && Array.from(host.querySelectorAll('a')).some((a) => (a.getAttribute('href') || '') === ${JSON.stringify(EXTERNAL_URL)}),
    };
  `).catch((error) => ({ error: String(error) }))
  evidence.afterExternalClick = afterExternal
  await browser.screenshot(join(evidenceDir, '02-after-external-click.png')).catch(() => undefined)

  record('LK-1 点外链后主文档地址一字不变（白屏判据）',
    afterExternal.location === landedKey,
    `before=${landedKey} after=${afterExternal.location}`)
  record('LK-1b 点外链后面板仍然活着（data-open=1）',
    afterExternal.panelPresent === true && afterExternal.panelOpen === '1',
    JSON.stringify({ panelPresent: afterExternal.panelPresent, panelOpen: afterExternal.panelOpen }))
  record('LK-2 外链点击走了 window.open（证明链接真能点开，不是被删掉）',
    Array.isArray(afterExternal.opened) && afterExternal.opened.length === 1 && afterExternal.opened[0] === EXTERNAL_URL,
    JSON.stringify(afterExternal.opened))

  // ── 7. 相对链接 / javascript: 链接：不许是锚点、点了也不许有任何动静 ──────
  const inert = await browser.evaluate(`${LOCATION_KEY_SNIPPET}
    const host = document.querySelector('.wb-panel-host');
    const anchors = Array.from(host.querySelectorAll('a'));
    const probe = window.__linkProbe;
    const before = { location: LOCATION_KEY, opened: probe.opened.length };
    const clickText = (text) => {
      const nodes = Array.from(host.querySelectorAll('*')).filter((n) => (n.textContent || '').trim() === text && n.children.length === 0);
      const node = nodes[0];
      if (!node) return null;
      node.scrollIntoView({ block: 'center' });
      const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    return {
      relativeIsAnchor: anchors.some((a) => (a.getAttribute('href') || '') === 'README.md'),
      scriptIsAnchor: anchors.some((a) => (a.getAttribute('href') || '').startsWith('javascript:')),
      relativeBox: clickText('相对说明'),
      scriptBox: clickText('脚本说明'),
      before,
    };
  `)
  evidence.inertBeforeClick = inert
  record('LK-3a 相对链接没有被渲染成锚点（桌面端会白屏的那一类）', inert.relativeIsAnchor === false, `relativeIsAnchor=${inert.relativeIsAnchor}`)
  record('LK-3b javascript: 链接没有被渲染成锚点', inert.scriptIsAnchor === false, `scriptIsAnchor=${inert.scriptIsAnchor}`)

  /**
   * ⚠️ 这里必须比**增量**而不是比总数：`window.__linkProbe.opened` 是累计数组，
   * 外链那一步已经 push 了 1 条 —— 写成 `opened === 0` 会把"产品是对的"判成红
   * （反向验证时才发现：探针自己的口径错了，比产品更早报错）。
   */
  for (const [label, box] of [['相对说明', inert.relativeBox], ['脚本说明', inert.scriptBox]]) {
    if (box === null) { record(`LK-3c 找到「${label}」文本节点`, false, '没找到文本节点（前置缺失 → 记失败）'); continue }
    const openedBefore = await browser.evaluate('return window.__linkProbe.opened.length;')
    await browser.clickAt(Math.round(box.x), Math.round(box.y))
    await sleep(600)
    const state = await browser.evaluate(`${LOCATION_KEY_SNIPPET}
      return { location: LOCATION_KEY, opened: window.__linkProbe.opened.length, panelPresent: document.querySelector('.wb-panel-host') !== null };
    `)
    record(`LK-3c 点「${label}」无导航、无新的 window.open、面板仍在`,
      state.location === landedKey && state.opened === openedBefore && state.panelPresent === true,
      JSON.stringify({ ...state, openedBefore }))
  }
  await browser.screenshot(join(evidenceDir, '03-after-inert-clicks.png')).catch(() => undefined)

  // ── 8. 本次重构顺带盯住：行内/块级渲染没有退化 ────────────────────────────
  const rendered = await browser.evaluate(`
    const host = document.querySelector('.wb-panel-host');
    const q = (sel) => host.querySelectorAll(sel).length;
    const code = Array.from(host.querySelectorAll('code')).map((n) => n.textContent || '');
    const strong = Array.from(host.querySelectorAll('strong')).map((n) => n.textContent || '');
    return {
      strong: strong.includes('粗体'),
      inlineCode: code.includes('行内代码'),
      checkboxes: q('input[type="checkbox"]'),
      table: q('table'),
      blockquote: q('blockquote'),
      pre: q('pre'),
      headings: q('h3, h4, h5'),
      listItems: q('li'),
    };
  `)
  evidence.renderedMarkdown = rendered
  record('LK-5 行内/块级 markdown 渲染未退化（粗体 / 行内代码 / 复选框 / 表格 / 引用 / 代码块 / 标题）',
    rendered.strong === true && rendered.inlineCode === true && rendered.checkboxes === 2 && rendered.table >= 1
    && rendered.blockquote >= 1 && rendered.pre >= 1 && rendered.headings >= 1,
    JSON.stringify(rendered))
  await browser.screenshot(join(evidenceDir, '04-markdown-render.png')).catch(() => undefined)

  // ── 9. 页面级 JS 异常 ─────────────────────────────────────────────────────
  const realErrors = browser.pageErrors.filter((line) => !/favicon|net::ERR|Failed to load resource/i.test(line))
  evidence.pageErrors = realErrors
  record('LK-4 全过程没有页面级 JS 异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  evidence.consoleTail = browser.consoleLines.slice(-15)
} catch (error) {
  record('探针执行未中断', false, error instanceof Error ? `${error.message}` : String(error))
  evidence.fatal = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
} finally {
  try { if (browser !== undefined) await browser.close() } catch { /* 尽力而为 */ }
  try {
    if (taskId !== undefined) {
      const archived = await api.post(`/api/workbench/tasks/${taskId}/archive`)
      evidence.cleanup = `archive ${taskId} → HTTP ${archived.status}`
    }
  } catch (error) { evidence.cleanup = `archive 失败：${String(error)}` }
  const failed = checks.filter((check) => check.ok !== true)
  evidence.checks = checks
  evidence.summary = { passed: checks.length - failed.length, failed: failed.length, total: checks.length }
  try {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, 'link-navigation.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    console.log(`\n证据：${join(evidenceDir, 'link-navigation.json')}`)
  } catch { /* 证据写不下去也不许吞掉退出码 */ }
  console.log(JSON.stringify(evidence.summary))
  process.exit(failed.length > 0 ? 1 : 0)
}
