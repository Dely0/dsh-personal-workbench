/**
 * 旧回归套件 3/4：**sidebar-collapse**（6 项，LEG-S01–LEG-S06）。
 *
 * 判据输入：`legacy-regression.md` §3；原脚本 `.pwtest/verify-sidebar-collapse.mjs`。
 *
 * 这套的核心**不是外观**，而是"点完之后主线程还活着吗"——用户报的原始 bug 是
 * "点收起侧边栏后 Edge 挂了、但 DSH 后台正常、重新打开页面就好"，即渲染进程主线程被占满。
 * 所以判据是：一个页面内自增心跳（`setTimeout(tick, 50)`）在读两次之间**必须递增**，
 * 且两次读取都在 6s 内返回。
 *
 * 迁移摘要（脚手架差异）：
 * 1. **旧实现有条件跳过**：`report.expand !== undefined` / `openPanel` / `collapseWithPanel`
 *    三个 `if` 只在找得到后续按钮时才 check —— 找不到就**少测却仍报 6/6**。
 *    LEG 文档明写"迁移必须改为明确前置失败，不允许少测却报 6/6"。迁移后每一步找不到
 *    目标按钮都走 `suite.require()` = **fail**，且 LEG-S01–S04 四项**必定**产生断言。
 * 2. 心跳变量只在**本次独立调试浏览器**的页面里设置，收尾由 `close()` 关掉整个实例清理。
 * 3. 端口写死 9830 → 动态空闲端口。
 * 4. `process.exit(1)` 在找不到按钮时**直接退出**，`finally` 里的 `browser.close()` 被绕过 →
 *    浏览器残留。迁移后退出统一走 `finally`。
 */
import { startSuite, createApi, launchSuiteBrowser, parseSuiteArgs, sleep, waitFor, safeJson } from './_harness.mjs'
import { discoverBrowser } from '../browser.mjs'

const options = parseSuiteArgs()
if (options.url === undefined) { console.error('用法：node scripts/verify/suites/legacy-sidebar-collapse.mjs --url <目标>'); process.exit(2) }

const LEGACY_IDS = ['LEG-S01', 'LEG-S02', 'LEG-S03', 'LEG-S04', 'LEG-S05', 'LEG-S06']
const suite = startSuite({ id: 'legacy-sidebar-collapse', title: '旧回归：侧栏收起后主线程仍响应（心跳）', url: options.url, evidenceDir: options.evidenceDir, legacyIds: LEGACY_IDS })
const api = createApi(options.url, { token: options.token })

/** 带超时的 evaluate：主线程被占满时 `Runtime.evaluate` 可能永不 settle。 */
const withTimeout = async (label, promise, ms = 8000) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`超时 ${ms}ms：${label}`)), ms) }),
    ])
  } finally { clearTimeout(timer) }
}

const FIND_TOGGLE = `
  const el = Array.from(document.querySelectorAll('button')).find((b) => {
    const a = b.getAttribute('aria-label') || '';
    return a.includes('收起侧边栏') || a.includes('展开侧边栏') || a.includes('侧边栏');
  });
  if (el === undefined) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), aria: el.getAttribute('aria-label') };
`

const FIND_ENTRY = `
  const sb = document.querySelector('[class*="sidebarCol"]');
  if (sb === null) return null;
  const rows = Array.from(sb.querySelectorAll('button')).filter((el) => (el.getAttribute('aria-label') || '').includes('工作台') || el.hasAttribute('data-dsh-personal-workbench-entry'));
  const vis = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().width > 0; };
  const row = rows.find(vis);
  if (row === undefined) return null;
  const r = row.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
`

/**
 * 收尾：把侧栏还原成**展开**态。
 *
 * 本套件的 LEG-S04 是"面板开着时收起侧栏"，跑完**侧栏是收起的**。同一链里的后续套件
 * 要先打开面板，而**收起的侧栏里没有「工作台」入口行**（宿主不渲染）⇒ 下一条套件会以
 * "没找到按钮"失败，报错指向错误的方向（实测 `legacy-duplicate-task` LEG-D04）。
 *
 * 判定用**行为式**（入口行可见吗），不猜宿主内部标记。
 * 返回 `'entry-visible' | 'expanded' | 'toggle-not-found' | 'entry-still-missing'`，只留痕、不改判定。
 */
async function restoreSidebarExpanded(browser) {
  const entryVisible = () => browser.evaluate(`
    const hit = Array.from(document.querySelectorAll('button'))
      .find((n) => (n.textContent || '').includes('工作台') && n.offsetParent !== null);
    return hit === undefined ? false : true;
  `)
  if ((await entryVisible()) === true) return 'entry-visible'
  const toggle = await browser.evaluate(FIND_TOGGLE)
  if (toggle === null) return 'toggle-not-found'
  await browser.clickAt(toggle.x, toggle.y)
  await new Promise((resolve) => setTimeout(resolve, 700))
  return (await entryVisible()) === true ? 'expanded' : 'entry-still-missing'
}

const report = {}
const steps = {}
let browser

try {
  const discovered = discoverBrowser({ overridePath: options.browser })
  if (discovered.ok !== true) throw new Error(`没有可用浏览器：${discovered.reason}`)
  browser = await launchSuiteBrowser({ url: options.url, token: options.token, userDataRoot: options.userDataRoot, browserPath: discovered.path })
  await browser.goto(api.pageUrl())
  /**
   * 等宿主把侧栏开合按钮渲染出来（**有上限的轮询**，不是固定 sleep）。
   * 这一套的判据是"点完之后主线程还响应吗"；按钮都没找到就退化成"什么都没测"——
   * LEG 文档明写"找不到后续按钮要明确前置失败"。
   */
  const toggleReady = await waitFor(async () => (await browser.evaluate(FIND_TOGGLE)) !== null, { timeoutMs: 45000, description: '侧栏开合按钮出现' }).then(() => true).catch(() => false)
  if (!toggleReady) suite.note('等待 45s 仍找不到侧栏开合按钮 —— 下面按 LEG 文档记前置失败（不跳过、不报成通过）')
  await sleep(500)

  // 埋心跳：主线程被占满时这个计数会停住（只在本次独立实例的页面里）
  await browser.evaluate(`
    globalThis.__HB__ = 0;
    const tick = () => { globalThis.__HB__ += 1; setTimeout(tick, 50); };
    setTimeout(tick, 50);
    return true;
  `)
  await sleep(500)
  const hb = async () => {
    try { return await withTimeout('读心跳', browser.evaluate('return globalThis.__HB__;'), 6000) } catch { return null }
  }

  const clickAndCheck = async (label, x, y) => {
    const before = await hb()
    await browser.clickAt(x, y)
    await sleep(2500)
    const after = await hb()
    return { label, before, after, alive: before !== null && after !== null && after > before }
  }

  await browser.screenshot(`${suite.dir}/01-初始.png`)

  // ── LEG-S01 收起侧栏：心跳 after > before，两次读取均在 6s 内返回 ─────────
  const toggle1 = await browser.evaluate(FIND_TOGGLE)
  report.toggle = toggle1
  if (toggle1 === null) {
    suite.require({ id: '收起侧边栏后页面仍响应', legacyId: 'LEG-S01', layer: 'B', detail: '找不到侧栏开合按钮（旧脚本在这里直接 exit(1)，绕过 finally 清理浏览器）' })
    for (const [legacyId, label] of [['LEG-S02', '再次展开侧边栏'], ['LEG-S03', '打开工作台面板'], ['LEG-S04', '面板开着时收起侧栏']]) {
      suite.require({ id: `${label}后页面仍响应`, legacyId, layer: 'B', detail: '前置（开合按钮）缺失' })
    }
  } else {
    suite.note(`侧栏开合按钮：${safeJson(toggle1)}`)
    steps.collapse = await clickAndCheck('收起侧边栏', toggle1.x, toggle1.y)
    report.collapse = steps.collapse
    await browser.screenshot(`${suite.dir}/02-收起后.png`)
    suite.check({ id: '收起侧边栏后页面仍响应（心跳递增）', legacyId: 'LEG-S01', layer: 'B', ok: steps.collapse.alive === true, detail: `心跳 ${steps.collapse.before} → ${steps.collapse.after}` })

    // ── LEG-S02 再次展开：心跳递增 ─────────────────────────────────────────
    await sleep(1000)
    const toggle2 = await browser.evaluate(FIND_TOGGLE)
    if (toggle2 === null) suite.require({ id: '再次展开侧边栏后页面仍响应', legacyId: 'LEG-S02', layer: 'B', detail: '展开后找不到开合按钮' })
    else {
      steps.expand = await clickAndCheck('再次展开侧边栏', toggle2.x, toggle2.y)
      report.expand = steps.expand
      await browser.screenshot(`${suite.dir}/03-展开后.png`)
      suite.check({ id: '再次展开侧边栏后页面仍响应（心跳递增）', legacyId: 'LEG-S02', layer: 'B', ok: steps.expand.alive === true, detail: `心跳 ${steps.expand.before} → ${steps.expand.after}` })
    }

    // ── LEG-S03 打开工作台面板：心跳递增 ───────────────────────────────────
    const entry = await browser.evaluate(FIND_ENTRY)
    report.entry = entry
    if (entry === null) suite.require({ id: '打开工作台面板后页面仍响应', legacyId: 'LEG-S03', layer: 'B', detail: '找不到可见的工作台入口' })
    else {
      steps.openPanel = await clickAndCheck('打开工作台面板', entry.x, entry.y)
      report.openPanel = steps.openPanel
      await browser.screenshot(`${suite.dir}/04-面板打开.png`)
      suite.check({ id: '打开工作台面板后页面仍响应（心跳递增）', legacyId: 'LEG-S03', layer: 'B', ok: steps.openPanel.alive === true, detail: `心跳 ${steps.openPanel.before} → ${steps.openPanel.after}` })

      // ── LEG-S04 面板开着时收起侧栏：心跳递增 ─────────────────────────────
      const toggle3 = await browser.evaluate(FIND_TOGGLE)
      if (toggle3 === null) suite.require({ id: '面板开着时收起侧栏后页面仍响应', legacyId: 'LEG-S04', layer: 'B', detail: '面板打开态下找不到开合按钮' })
      else {
        steps.collapseWithPanel = await clickAndCheck('面板开着时收起侧栏', toggle3.x, toggle3.y)
        report.collapseWithPanel = steps.collapseWithPanel
        await browser.screenshot(`${suite.dir}/05-面板开着收起侧栏.png`)
        suite.check({ id: '面板开着时收起侧栏后页面仍响应（心跳递增）', legacyId: 'LEG-S04', layer: 'B', ok: steps.collapseWithPanel.alive === true, detail: `心跳 ${steps.collapseWithPanel.before} → ${steps.collapseWithPanel.after}` })
      }
    }
  }

  // ── LEG-S05 全序列：ResizeObserver loop / Maximum update depth / Too many re-renders = 0 ──
  const rosLoops = browser.consoleLines.filter((line) => /ResizeObserver loop|Maximum update depth|Too many re-renders/i.test(line.text))
  report.console = browser.consoleLines.map((line) => `[${line.level}] ${line.text.slice(0, 200)}`)
  suite.check({ id: '全序列无 ResizeObserver loop / 无限重渲染告警', legacyId: 'LEG-S05', layer: 'B', ok: rosLoops.length === 0, detail: `命中 ${rosLoops.length} 条${rosLoops.length === 0 ? '' : `：${rosLoops.map((line) => line.text.slice(0, 120)).join(' | ')}`}` })
  // ── LEG-S06 全序列：未捕获异常 = 0 ─────────────────────────────────────
  const errs = browser.pageErrors.filter((entry) => !/^\[network\]/.test(entry))
  report.errors = browser.pageErrors
  suite.check({ id: '全序列无未捕获异常', legacyId: 'LEG-S06', layer: 'B', ok: errs.length === 0, detail: `命中 ${errs.length} 条${errs.length === 0 ? '' : `：${errs.slice(0, 3).map((entry) => String(entry).slice(0, 120)).join(' | ')}`}` })
} catch (error) {
  suite.fatalError(error)
} finally {
  try {
    if (browser !== undefined) {
      /**
       * **收尾必须把侧栏还原成展开态**（2026-10-02 修）。
       *
       * 本套件的 LEG-S04 刻意在面板开着时把侧栏收起；而链是**同一个浏览器**跑完所有套件，
       * 收起的侧栏会让**下一条套件**找不到「工作台」入口 —— 实测
       * `legacy-duplicate-task` 的 LEG-D04 就是这么红的（`{present:true, dataOpen:null, w:0}`），
       * 报错还指向"面板没打开"，与真实原因（侧栏被别人收起了）不符。
       *
       * 纪律：**谁污染谁还原**。harness 侧另有一层兜底（`expandSidebarIfCollapsed`），
       * 这里做的是"不留脏状态"的本分。
       */
      const restored = await restoreSidebarExpanded(browser)
      suite.note(`收尾：侧栏还原 = ${restored}`)
      await browser.screenshot(`${suite.dir}/99-收尾.png`).catch(() => undefined)
      await browser.close()
    }
    suite.writeEvidence('dom-readings.json', { ...report, heartbeat: steps })
  } catch (error) {
    suite.note(`收尾失败（不覆盖原判定）：${error instanceof Error ? error.message : String(error)}`)
  }
  process.exit(suite.finish())
}
