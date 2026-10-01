/**
 * 旧回归套件 1/4：**acceptance**（17 项，LEG-A01–LEG-A17）。
 *
 * 判据输入：`docs/tasks/36c8e8ef-…/legacy-regression.md` §1（43 个 LEG 编号之一部分）。
 * 原脚本：`.pwtest/verify-acceptance.mjs`（本机可读，逐条核对过）。
 * 迁移方式：**逐字保留判据语义**，去机器路径/认证参数，脚手架换成仓库的
 * `cdp.mjs` + `harness.mjs`。迁移摘要（脚手架差异）：
 *
 * | 原脚本 | 迁移后 | 为什么 |
 * |---|---|---|
 * | `process.exit` 写在 `finally` 里、靠 `fatalError` 兜 | 汇总 + 退出码由 harness 统一 | 同步 `process.exit` 会把挂死/未处理拒绝伪装成"提前通过" |
 * | 固定 `sleep(11000)` | `waitFor` 有上限的状态轮询 | 固定 sleep 不是产品要求，机器快慢都会假红 |
 * | 端口写死 9794 | 端口由 `cdp.mjs` 动态取空闲 | 与别的探针/用户程序撞车时会误连 |
 * | `launchDebugBrowser({headless:false, appUrl: url})` 用**带 token 的 URL** | 仍是带 token 的页面 URL，但 token 走 `DSH_VERIFY_TOKEN` | argv 在进程列表里可见 |
 * | 找不到入口/返回按钮 → 后续 check 静默少测 | **一律记 fail**（harness.require） | LEG 文档明写"找不到入口/返回按钮是失败，不跳过" |
 * | LEG-A09 的标题写"收起后再点"、动作其实是"再点一次" | **按实际序列执行**，在 detail 里写明 | LEG 文档要求"迁移需显式记录实际序列，不以标题虚报步骤" |
 */
import { startSuite, createApi, launchSuiteBrowser, parseSuiteArgs, sleep, waitFor, safeJson, removeDirWithRetry, readBuiltBuildId } from './_harness.mjs'
import { discoverBrowser } from '../browser.mjs'

const options = parseSuiteArgs()
if (options.url === undefined) { console.error('用法：node scripts/verify/suites/legacy-acceptance.mjs --url <目标> [--evidence-dir <目录>]'); process.exit(2) }

const LEGACY_IDS = ['LEG-A01', 'LEG-A02', 'LEG-A03', 'LEG-A04', 'LEG-A05', 'LEG-A06', 'LEG-A07', 'LEG-A08', 'LEG-A09',
  'LEG-A10', 'LEG-A11', 'LEG-A12', 'LEG-A13', 'LEG-A14', 'LEG-A15', 'LEG-A16', 'LEG-A17']

const suite = startSuite({ id: 'legacy-acceptance', title: '旧回归：侧栏入口 / 面板开合 / 皮肤 / 控制台', url: options.url, evidenceDir: options.evidenceDir, legacyIds: LEGACY_IDS })
const api = createApi(options.url, { token: options.token })

/** 共用观测定义（legacy-regression.md §0）：入口 / 面板 / 整屏 blocker / 皮肤 / 控制台。 */
const SNAP = `
  const W = window.innerWidth, H = window.innerHeight;
  const html = document.documentElement;
  const vis = (el) => { if (el === null) return false; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const sidebar = document.querySelector('[class*="sidebarCol"]');
  const wbRows = sidebar === null ? [] : Array.from(sidebar.querySelectorAll('button'))
    .filter((el) => el.hasAttribute('data-dsh-personal-workbench-entry') || (el.getAttribute('aria-label') || '').includes('工作台'))
    .map((el) => ({ ours: el.hasAttribute('data-dsh-personal-workbench-entry'), text: (el.textContent || '').trim().slice(0, 24), visible: vis(el) }));
  const host = document.querySelector('.wb-panel-host');
  const hr = host === null ? null : host.getBoundingClientRect();
  const blockers = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
    if (cs.pointerEvents === 'none' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < W * 0.8 || r.height < H * 0.8) continue;
    blockers.push({ cls: (el.className || el.tagName).toString().slice(0, 40), z: cs.zIndex, ours: el.classList.contains('wb-panel-host') });
  }
  const centre = document.elementFromPoint(Math.round(W * 0.6), Math.round(H * 0.5));
  /**
   * 「中心观测点是不是工作台层」——**按元素树判，不按叶子元素的 className 判**。
   *
   * 旧脚本写的是 /^wb-/ 测 centre.className；那在当时的 DOM 上成立。现在的面板结构是
   * .wb-panel-host > .wb-app-scope > .wb-app > …，而视口正中常常正好落在**没有 class 的
   * 布局 DIV** 上（实测 cls=""）—— 叶子元素没 class，但它的祖先链整条都是工作台层。
   * 判据的**意图**是"这一点上最上层的是工作台，而不是别的东西"，所以这里沿父链找最近的
   * 带 class 的祖先再检查它是不是 wb-。这是**适配 DOM 结构**，不是放宽：
   * LEG-A11 用同一条链判"收起态不再是工作台层"，两侧一起收紧。
   */
  let centreWb = null;
  let probe = centre;
  for (let depth = 0; probe !== null && depth < 14; depth += 1) {
    const cls = String(probe.className || '');
    if (cls !== '') { centreWb = cls.trim().split(/\s+/)[0]; break; }
    probe = probe.parentElement;
  }
  return {
    wbRows,
    wbVisibleRows: wbRows.filter((r) => r.visible).length,
    dataOpen: host === null ? null : host.getAttribute('data-open'),
    panelPresent: host !== null,
    hostShown: vis(host),
    hostRect: hr === null ? null : [Math.round(hr.width), Math.round(hr.height)],
    buildIdAttr: host === null ? null : host.getAttribute('data-workbench-build-id'),
    wbActive: html.hasAttribute('data-dsh-personal-workbench-active'),
    siblingActive: html.getAttributeNames().filter((n) => n.startsWith('data-dsh-') && n.endsWith('-active')
      && n !== 'data-dsh-personal-workbench-active' && n !== 'data-dsh-wallpaper-active' && n !== 'data-dsh-backdrop-active'),
    blockers,
    centre: centre === null ? '(null)' : (centre.className || centre.tagName).toString().slice(0, 36),
    centreWb,
    skin: ['data-dsh-wallpaper-active', 'data-dsh-backdrop-active'].filter((a) => html.hasAttribute(a)),
  };
`

/** 找到那一行**可见**入口并返回中心点（找不到返回 null → 调用方记 fail）。 */
const FIND_ENTRY = `
  const sidebar = document.querySelector('[class*="sidebarCol"]');
  if (sidebar === null) return null;
  const vis = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const rows = Array.from(sidebar.querySelectorAll('button'))
    .filter((el) => el.hasAttribute('data-dsh-personal-workbench-entry') || (el.getAttribute('aria-label') || '').includes('工作台'))
    .filter(vis);
  const row = rows.find((el) => !el.hasAttribute('data-dsh-personal-workbench-entry')) || rows[0];
  if (row === undefined) return null;
  const r = row.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), ours: row.hasAttribute('data-dsh-personal-workbench-entry'), aria: row.getAttribute('aria-label') };
`

const FIND_BACK = `
  const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').includes('返回对话'));
  if (b === undefined) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
`

const report = {}
let browser
let cleanupOk = true

const capture = async (name) => {
  await browser.screenshot(`${suite.dir}/${name}.png`)
  const snap = await browser.evaluate(SNAP)
  report[name] = snap
  console.log(`   [${name}] 入口可见=${snap.wbVisibleRows} data-open=${snap.dataOpen} 面板可见=${snap.hostShown} rect=${safeJson(snap.hostRect)} 兄弟标记=${safeJson(snap.siblingActive)} 遮挡=${snap.blockers.length}`)
  return snap
}

const nonOursBlockers = (snap) => snap.blockers.filter((entry) => !entry.ours)

try {
  const discovered = discoverBrowser({ overridePath: options.browser })
  if (discovered.ok !== true) throw new Error(`没有可用浏览器：${discovered.reason}`)
  suite.note(`浏览器：${discovered.path}（来源 ${discovered.source}）`)

  browser = await launchSuiteBrowser({ url: options.url, token: options.token, userDataRoot: options.userDataRoot, browserPath: discovered.path })
  await browser.goto(api.pageUrl())

  /**
   * 等宿主把侧栏里的工作台入口渲染出来。
   *
   * ⚠️ 条件必须是**交互元素真的出来了**（`wbVisibleRows > 0`），不能只等 `.wb-panel-host`：
   * host 节点由客户端插件注入，可能早于宿主侧栏渲染；只等它会在"面板壳有了、侧栏还没画完"
   * 的那一刻继续往下跑，然后 LEG-A01 报"入口 0 行"——**判据没错，是等待条件太松**
   * （T6 第二次真跑就撞上：同一份代码，第一次 17/17、第二次 16/17 的差异全在这里）。
   * 这里同时把等待时间放到 45s，并在超时后如实打印一次快照，便于人工判断是"慢"还是"真没有"。
   */
  const entryReady = await waitFor(async () => {
    const snap = await browser.evaluate(SNAP)
    return snap.wbVisibleRows > 0
  }, { timeoutMs: 45000, description: '侧栏露出可见的工作台入口' }).then(() => true).catch(() => false)
  if (!entryReady) {
    const late = await browser.evaluate(SNAP)
    suite.note(`等待 45s 仍无可见入口，快照：${safeJson({ sidebarFound: late.panelPresent, rows: late.wbRows, dataOpen: late.dataOpen })}`)
  }
  await sleep(1200)

  const initial = await capture('01-初始')

  // ── LEG-A01 初始侧栏：可见工作台入口恰好 1 行 ────────────────────────────
  suite.check({ id: '初始侧栏可见工作台入口恰好 1 行', legacyId: 'LEG-A01', layer: 'B', ok: initial.wbVisibleRows === 1, detail: `可见=${initial.wbVisibleRows} 明细=${safeJson(initial.wbRows)}` })
  // ── LEG-A02 初始页面：非本插件整屏 blocker = 0 ──────────────────────────
  suite.check({ id: '初始无非本插件整屏 blocker', legacyId: 'LEG-A02', layer: 'B', ok: nonOursBlockers(initial).length === 0, detail: safeJson(initial.blockers) })

  const target = await browser.evaluate(FIND_ENTRY)
  report.target = target
  console.log(`\n点击目标：${safeJson(target)}`)
  if (target === null) {
    // LEG 文档：找不到入口是**失败**，不能少测后报通过。
    suite.require({ id: '找到可见的工作台入口（点击目标）', legacyId: 'LEG-A03', layer: 'B', detail: '侧栏里没有可见的工作台入口' })
  } else {
    // ── LEG-A03 点击可见入口 → data-open=1 / hostShown / 宽 >300 ──────────
    await browser.clickAt(target.x, target.y)
    await waitFor(async () => (await browser.evaluate(SNAP)).dataOpen === '1', { timeoutMs: 15000, description: '面板打开 data-open=1' }).catch(() => undefined)
    await sleep(1200)
    const opened = await capture('02-点击入口后')
    suite.check({ id: '点入口 → 面板打开（data-open=1 / hostShown / 宽>300）', legacyId: 'LEG-A03', layer: 'B', ok: opened.dataOpen === '1' && opened.hostShown === true && (opened.hostRect?.[0] ?? 0) > 300, detail: `data-open=${opened.dataOpen} 可见=${opened.hostShown} rect=${safeJson(opened.hostRect)}` })
    // ── LEG-A04 打开态中心观测点：工作台面板在最上层 ────────────────────────
    suite.check({ id: '打开态中心观测点是工作台层', legacyId: 'LEG-A04', layer: 'B', ok: /^wb-/.test(String(opened.centreWb ?? '')), detail: `最近祖先类=${opened.centreWb} 叶子=${opened.centre}` })
    // ── LEG-A05 打开态：非本插件 blocker = 0 ───────────────────────────────
    suite.check({ id: '打开态无非本插件整屏 blocker', legacyId: 'LEG-A05', layer: 'B', ok: nonOursBlockers(opened).length === 0, detail: safeJson(opened.blockers) })

    /**
     * ── 三方构建标识的第三只脚（AX-V07 / V04-B）─────────────────────────────
     *
     * requirements §7.2 要求**同时**比对"目标包 manifest / host health / 浏览器根属性"三者。
     * 前两者由链在 health 阶段比；**浏览器根属性只能在真浏览器里读**，所以落在这里。
     * 它的意义是证明"浏览器真的加载了本次 bundle"，而不是"服务端换了包、页面还是旧的"。
     * 判据写死"必须等于本次构建的 buildId"，并把它写进套件 JSON，供链汇总进 summary。
     */
    const identity = await api.get('/api/workbench/health')
    const expectedBuildId = readBuiltBuildId()
    const clientBuildId = opened.buildIdAttr
    report.clientIdentity = { clientAttr: clientBuildId, healthBuildId: identity.body?.buildId ?? null, expectedBuildId }
    suite.check({
      id: '浏览器根属性 data-workbench-build-id == 本地构建 == host health（三方同源）',
      axId: 'AX-V07', layer: 'B',
      ok: typeof clientBuildId === 'string' && clientBuildId !== '' && clientBuildId === expectedBuildId && identity.body?.buildId === expectedBuildId,
      detail: safeJson(report.clientIdentity),
    })

    // ── LEG-A06/A07 兄弟插件标记（隔离测试页 fixture，finally 撤销）────────
    const mutexTrigger = await browser.evaluate(`
      try { document.documentElement.setAttribute('data-dsh-taskboard-active', ''); return { ok: true }; }
      catch (error) { return { ok: false, error: String(error) }; }
    `)
    suite.note(`隔离 fixture 写入 data-dsh-taskboard-active：${safeJson(mutexTrigger)}（生产代码不读/不改兄弟标记）`)
    await sleep(2000)
    const mutex = await capture('03-兄弟插件标记写入后')
    suite.check({ id: '兄弟插件标记不影响本插件（打开且可见）', legacyId: 'LEG-A06', layer: 'B', ok: mutex.dataOpen === '1' && mutex.hostShown === true, detail: `data-open=${mutex.dataOpen} 可见=${mutex.hostShown}` })
    suite.check({ id: '兄弟标记仍在（本插件没有删它）', legacyId: 'LEG-A07', layer: 'B', ok: mutex.siblingActive.includes('data-dsh-taskboard-active'), detail: `兄弟标记=${safeJson(mutex.siblingActive)}` })
    report.mutexSimulated = true

    // ── LEG-A08 撤销 fixture 标记 → 本插件仍打开可见，无幽灵变化 ───────────
    await browser.evaluate(`
      try { document.documentElement.removeAttribute('data-dsh-taskboard-active'); return { ok: true }; }
      catch (error) { return { ok: false, error: String(error) }; }
    `)
    await sleep(2000)
    const afterMutex = await capture('04-兄弟标记撤销后')
    suite.check({ id: '撤销兄弟标记后本插件仍稳定（无幽灵变化）', legacyId: 'LEG-A08', layer: 'B', ok: afterMutex.dataOpen === '1' && afterMutex.hostShown === true, detail: `data-open=${afterMutex.dataOpen} 可见=${afterMutex.hostShown}` })

    // ── LEG-A09 再次点击入口 → 仍能处于打开可见状态 ───────────────────────
    // 实际序列：**面板当前是打开态**，再点一次入口。旧脚本标题写"收起后再点"，
    // 而真正的收起/重开由 LEG-A10 与本套后续（final-2 覆盖）承担 —— 这里如实记录。
    const target2 = await browser.evaluate(FIND_ENTRY)
    if (target2 === null) suite.require({ id: '再次定位入口', legacyId: 'LEG-A09', layer: 'B', detail: '第二次找不到可见入口' })
    else {
      await browser.clickAt(target2.x, target2.y)
      await sleep(2000)
      const reopened = await capture('05-再次点击入口')
      suite.check({ id: '再次点击入口后仍处于打开可见状态', legacyId: 'LEG-A09', layer: 'B', ok: reopened.dataOpen === '1' && reopened.hostShown === true, detail: `实际序列=面板打开态下再点一次入口（旧标题写"收起后再点"与脚本动作不一致，此处按实际序列）；data-open=${reopened.dataOpen} 可见=${reopened.hostShown}` })
    }

    // ── LEG-A10 点「返回对话」→ data-open 不再为 1 且 hostShown=false ──────
    const back = await browser.evaluate(FIND_BACK)
    report.backButton = back
    console.log(`  「返回对话」按钮：${safeJson(back)}`)
    if (back === null || back.w <= 0) suite.require({ id: '找到「返回对话」按钮', legacyId: 'LEG-A10', layer: 'B', detail: `未找到可点按钮：${safeJson(back)}` })
    else {
      await browser.clickAt(back.x, back.y)
      await waitFor(async () => (await browser.evaluate(SNAP)).dataOpen !== '1', { timeoutMs: 15000, description: '面板收起' }).catch(() => undefined)
      await sleep(1200)
    }
    const closed = await capture('06-点返回对话后')
    suite.check({ id: '点「返回对话」→ 面板收起（data-open ≠ 1 且不可见）', legacyId: 'LEG-A10', layer: 'B', ok: closed.dataOpen !== '1' && closed.hostShown === false, detail: `data-open=${closed.dataOpen} 可见=${closed.hostShown}` })
    // ── LEG-A11 收起态中心观测点：不再是工作台层 ───────────────────────────
    suite.check({ id: '收起态中心不再是工作台层', legacyId: 'LEG-A11', layer: 'B', ok: !/^wb-/.test(String(closed.centreWb ?? '')), detail: `最近祖先类=${closed.centreWb} 叶子=${closed.centre}` })
    // ── LEG-A12 收起态：非本插件 blocker = 0 ───────────────────────────────
    suite.check({ id: '收起态无非本插件整屏 blocker', legacyId: 'LEG-A12', layer: 'B', ok: nonOursBlockers(closed).length === 0, detail: safeJson(closed.blockers) })
    // ── LEG-A13 收起态侧栏：入口仍恰好 1 行 ────────────────────────────────
    suite.check({ id: '收起态侧栏入口仍恰好 1 行', legacyId: 'LEG-A13', layer: 'B', ok: closed.wbVisibleRows === 1, detail: `可见=${closed.wbVisibleRows}` })

    // ── LEG-A14 全序列控制台：slot crash=0 且未捕获异常=0 ─────────────────
    const crashes = browser.consoleLines.filter((line) => /slot entry crashed/.test(line.text))
    const errs = browser.pageErrors.filter((entry) => !/^\[network\]/.test(entry))
    report.console = browser.consoleLines.map((line) => `[${line.level}] ${line.text.slice(0, 240)}`)
    report.errors = browser.pageErrors
    suite.check({ id: '全序列无 slot entry crashed / 无未捕获异常', legacyId: 'LEG-A14', layer: 'B', ok: crashes.length === 0 && errs.length === 0, detail: `崩溃=${crashes.length} 异常=${errs.length}${errs.length === 0 ? '' : ` 首条=${String(errs[0]).slice(0, 200)}`}` })

    // ── LEG-A15 每一个采集状态：非本插件 blocker 全部为 0 ──────────────────
    const snapshots = Object.entries(report).filter(([, value]) => value !== null && typeof value === 'object' && Array.isArray(value.blockers))
    const offending = snapshots.filter(([, value]) => nonOursBlockers(value).length > 0)
    suite.check({ id: '每一态都没有非本插件整屏 blocker（不只比首尾）', legacyId: 'LEG-A15', layer: 'B', ok: offending.length === 0, detail: `检查了 ${snapshots.length} 个状态${offending.length === 0 ? '' : `；命中 ${safeJson(offending.map(([key, value]) => [key, nonOursBlockers(value)]))}`}` })

    // ── LEG-A16 初始与收起态皮肤属性集合相同 ───────────────────────────────
    suite.check({ id: '初始与收起态皮肤属性集合相同', legacyId: 'LEG-A16', layer: 'B', ok: safeJson(initial.skin) === safeJson(closed.skin), detail: `${safeJson(initial.skin)} → ${safeJson(closed.skin)}` })
    // ── LEG-A17 初始与兄弟 fixture 撤销后皮肤属性集合相同 ─────────────────
    suite.check({ id: '初始与兄弟 fixture 撤销后皮肤属性集合相同', legacyId: 'LEG-A17', layer: 'B', ok: safeJson(initial.skin) === safeJson(afterMutex.skin), detail: `${safeJson(initial.skin)} → ${safeJson(afterMutex.skin)}` })

    // 收起态再读一次构建标识（确认属性不是只在打开那瞬间存在）
    report.buildIdentityOnClose = { clientAttr: closed.buildIdAttr }
  }
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
    cleanupOk = false
    suite.note(`收尾失败（不覆盖原判定）：${error instanceof Error ? error.message : String(error)}`)
  }
  if (cleanupOk && browser !== undefined) {
    // 只清本次自己起的临时 profile 目录（cdp.close 已做一次，这里兜底并如实报告）
    const tempRoot = options.userDataRoot
    if (typeof tempRoot === 'string' && tempRoot !== '') removeDirWithRetry(tempRoot)
  }
  process.exit(suite.finish())
}
