/**
 * 旧回归套件 2/4：**final-2**（9 项，LEG-F01–LEG-F09）。
 *
 * 判据输入：`legacy-regression.md` §2；原脚本 `.pwtest/verify-final-2.mjs`。
 * 该套定位是**开/关最小闭环**，与 acceptance 有重叠但不替代（LEG 文档原话）。
 *
 * 迁移摘要（脚手架差异，逐条记）：
 * 1. 原脚本注释自己写明：**修正前它是恒过的**（`check()` 形参写成了
 *    `(id, name, ok, detail)`，而 9 个调用点都按 `(id, ok, detail)` 传 → `ok` 收到的是
 *    说明字符串，永远真值）。迁移后由 harness 统一 `check({ok})`，**形参错位这种坑
 *    在结构上不可能再犯**（没有位置参数可错位）。
 * 2. 原脚本 `if (btn !== null && btn.x > 0)` —— 找不到收起按钮时**静默少测**。
 *    迁移后找不到按钮 → `suite.require()` = **fail**（LEG 文档：不允许少测却报满数）。
 * 3. `process.exit` 在 `finally` 之外，靠 `failed.length` 决定 —— 脚本级异常会让
 *    `results` 为空 → `0/0 通过`、退出码 0。迁移后异常一律 `suite.fatalError()`。
 * 4. 端口写死 9785 → 动态空闲端口。
 */
import { startSuite, createApi, launchSuiteBrowser, parseSuiteArgs, sleep, waitFor, safeJson } from './_harness.mjs'
import { discoverBrowser } from '../browser.mjs'

const options = parseSuiteArgs()
if (options.url === undefined) { console.error('用法：node scripts/verify/suites/legacy-final-2.mjs --url <目标>'); process.exit(2) }

const LEGACY_IDS = ['LEG-F01', 'LEG-F02', 'LEG-F03', 'LEG-F04', 'LEG-F05', 'LEG-F06', 'LEG-F07', 'LEG-F08', 'LEG-F09']
const suite = startSuite({ id: 'legacy-final-2', title: '旧回归：开/关最小闭环', url: options.url, evidenceDir: options.evidenceDir, legacyIds: LEGACY_IDS })
const api = createApi(options.url, { token: options.token })

const SNAP = `
  const W = window.innerWidth, H = window.innerHeight;
  const vis = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0; };
  const sidebar = document.querySelector('[class*="sidebarCol"]');
  const inSidebar = (el) => sidebar !== null && sidebar.contains(el);
  const rows = Array.from(document.querySelectorAll('button'))
    .filter((el) => inSidebar(el))
    .filter((el) => el.hasAttribute('data-dsh-personal-workbench-entry') || (el.getAttribute('aria-label') || '').includes('工作台'))
    .map((el) => ({ text: (el.textContent || '').trim().slice(0, 22), ours: el.hasAttribute('data-dsh-personal-workbench-entry'), visible: vis(el) }));
  const host = document.querySelector('.wb-panel-host');
  const hr = host === null ? null : host.getBoundingClientRect();
  const blockers = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
    if (cs.pointerEvents === 'none' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < W * 0.8 || r.height < H * 0.8) continue;
    blockers.push({ cls: (el.className || el.tagName).toString().slice(0, 30), z: cs.zIndex, ours: el.classList.contains('wb-panel-host') });
  }
  const center = document.elementFromPoint(Math.round(W * 0.6), Math.round(H * 0.5));
  return {
    sidebarRows: rows,
    sidebarVisibleRows: rows.filter((r) => r.visible).length,
    dataOpen: host === null ? null : host.getAttribute('data-open'),
    hostRect: hr === null ? null : [Math.round(hr.width), Math.round(hr.height)],
    officialAttr: document.documentElement.hasAttribute('data-dsh-personal-workbench-official'),
    blockers,
    centerTop: center === null ? '(null)' : (center.className || center.tagName).toString().slice(0, 30),
    skinAttrs: ['data-dsh-wallpaper-active', 'data-dsh-backdrop-active'].filter((a) => document.documentElement.hasAttribute(a)),
  };
`

const FIND_ENTRY = `
  const sidebar = document.querySelector('[class*="sidebarCol"]');
  if (sidebar === null) return null;
  const vis = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0; };
  const rows = Array.from(sidebar.querySelectorAll('button'))
    .filter((el) => el.hasAttribute('data-dsh-personal-workbench-entry') || (el.getAttribute('aria-label') || '').includes('工作台'))
    .filter(vis);
  const row = rows[0];
  if (row === undefined) return null;
  const r = row.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
`

const FIND_BACK = `
  const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').includes('返回对话'));
  if (b === null || b === undefined) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
`

const report = {}
let browser

try {
  const discovered = discoverBrowser({ overridePath: options.browser })
  if (discovered.ok !== true) throw new Error(`没有可用浏览器：${discovered.reason}`)
  browser = await launchSuiteBrowser({ url: options.url, token: options.token, userDataRoot: options.userDataRoot, browserPath: discovered.path })
  await browser.goto(api.pageUrl())
  /**
   * 等**可见入口**真的出来（不能只等 data-open 出现：面板壳可能先于侧栏渲染，
   * 那时 LEG-F01 会报"入口 0 个"——判据没错、等待条件太松；T6 实测踩到过一次）。
   */
  const entryReady = await waitFor(async () => (await browser.evaluate(SNAP)).sidebarVisibleRows >= 1, { timeoutMs: 45000, description: '侧栏露出可见的工作台入口' }).then(() => true).catch(() => false)
  if (!entryReady) suite.note('等待 45s 仍无可见入口 —— 按 LEG 文档"找不到入口是失败"，下面逐条记 fail')
  await sleep(1200)

  const before = await browser.evaluate(SNAP)
  report.before = before
  await browser.screenshot(`${suite.dir}/01-初始.png`)
  console.log(`① 初始：${safeJson({ 可见入口: before.sidebarVisibleRows, dataOpen: before.dataOpen, 中央: before.centerTop })}`)

  // ── LEG-F01 初始侧栏：可点工作台入口恰好 1 ──────────────────────────────
  suite.check({ id: '初始侧栏可点工作台入口恰好 1', legacyId: 'LEG-F01', layer: 'B', ok: before.sidebarVisibleRows === 1, detail: `可点=${before.sidebarVisibleRows} 明细=${safeJson(before.sidebarRows)}` })
  // ── LEG-F02 初始页面：非工作台 blocker = 0 ──────────────────────────────
  suite.check({ id: '初始无非工作台 blocker', legacyId: 'LEG-F02', layer: 'B', ok: before.blockers.filter((b) => !b.ours).length === 0, detail: safeJson(before.blockers) })
  // ── LEG-F03 初始中心：不是 wb- 工作台层 ─────────────────────────────────
  suite.check({ id: '初始中心不是 wb- 工作台层', legacyId: 'LEG-F03', layer: 'B', ok: !/^wb-/.test(before.centerTop), detail: `中央=${before.centerTop}` })

  // ── LEG-F04 点击入口 → data-open=1 且面板宽 >300 ────────────────────────
  const target = await browser.evaluate(FIND_ENTRY)
  if (target === null) {
    suite.require({ id: '找到可点工作台入口', legacyId: 'LEG-F04', layer: 'B', detail: '侧栏里没有可见的工作台入口' })
  } else {
    await browser.clickAt(target.x, target.y)
    await waitFor(async () => (await browser.evaluate(SNAP)).dataOpen === '1', { timeoutMs: 15000, description: '面板打开' }).catch(() => undefined)
    await sleep(1000)
    const opened = await browser.evaluate(SNAP)
    report.opened = opened
    await browser.screenshot(`${suite.dir}/02-打开.png`)
    suite.check({ id: '点入口 → data-open=1 且面板宽 >300', legacyId: 'LEG-F04', layer: 'B', ok: opened.dataOpen === '1' && (opened.hostRect?.[0] ?? 0) > 300, detail: `data-open=${opened.dataOpen} rect=${safeJson(opened.hostRect)}` })

    // ── LEG-F05 点击返回对话 → data-open 不再为 1 ─────────────────────────
    const back = await browser.evaluate(FIND_BACK)
    report.backButton = back
    if (back === null || back.w <= 0) {
      suite.require({ id: '找到「返回对话」按钮', legacyId: 'LEG-F05', layer: 'B', detail: `未找到：${safeJson(back)}（旧脚本在这里静默少测，迁移后记失败）` })
    } else {
      await browser.clickAt(back.x, back.y)
      await waitFor(async () => (await browser.evaluate(SNAP)).dataOpen !== '1', { timeoutMs: 15000, description: '面板收起' }).catch(() => undefined)
      await sleep(1000)
      suite.check({ id: '点返回对话 → data-open 不再为 1', legacyId: 'LEG-F05', layer: 'B', ok: (await browser.evaluate(SNAP)).dataOpen !== '1', detail: '已点击并重读 data-open' })
    }

    const closed = await browser.evaluate(SNAP)
    report.closed = closed
    await browser.screenshot(`${suite.dir}/03-收起.png`)
    // ── LEG-F06 收起后：非工作台 blocker = 0 且中心不是 wb- 层 ─────────────
    suite.check({ id: '收起后无非工作台 blocker 且中心不是 wb- 层', legacyId: 'LEG-F06', layer: 'B', ok: closed.blockers.filter((b) => !b.ours).length === 0 && !/^wb-/.test(closed.centerTop), detail: `遮挡=${safeJson(closed.blockers)} 中央=${closed.centerTop}` })
    // ── LEG-F07 收起侧栏：入口仍恰好 1 ─────────────────────────────────────
    suite.check({ id: '收起后侧栏入口仍恰好 1', legacyId: 'LEG-F07', layer: 'B', ok: closed.sidebarVisibleRows === 1, detail: `可点=${closed.sidebarVisibleRows}` })

    // ── LEG-F08 全序列：无槽位崩溃、无未捕获异常 ───────────────────────────
    const crashes = browser.consoleLines.filter((line) => /slot entry crashed/.test(line.text))
    const errs = browser.pageErrors.filter((entry) => !/^\[network\]/.test(entry))
    report.console = browser.consoleLines.map((line) => `[${line.level}] ${line.text.slice(0, 200)}`)
    report.errors = browser.pageErrors
    suite.check({ id: '全序列无槽位崩溃、无未捕获异常', legacyId: 'LEG-F08', layer: 'B', ok: crashes.length === 0 && errs.length === 0, detail: `崩溃=${crashes.length} 异常=${errs.length}` })
    // ── LEG-F09 开合前后：皮肤属性集合相同 ─────────────────────────────────
    suite.check({ id: '开合前后皮肤属性集合相同', legacyId: 'LEG-F09', layer: 'B', ok: safeJson(before.skinAttrs) === safeJson(closed.skinAttrs), detail: `${safeJson(before.skinAttrs)} → ${safeJson(closed.skinAttrs)}` })
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
    suite.note(`收尾失败（不覆盖原判定）：${error instanceof Error ? error.message : String(error)}`)
  }
  process.exit(suite.finish())
}
