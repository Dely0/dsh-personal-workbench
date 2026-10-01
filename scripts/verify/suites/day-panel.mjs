/**
 * 批次2 D15 的浏览器判据：**日期面板收敛**（AX-T03 / AX-T04 / AX-T05）。
 *
 * 判据（B 层：真实鼠标 + DOM 重读 + 截图）：
 * - AX-T03：从「今日」进入与从「日历选中今天」进入得到**同一个面板** ——
 *   同一组页签（计划/已完成/报告）、同一批行（标题 + 来源徽标逐一相同）；
 * - AX-T04：逐条标来源（每行都有 `[data-task-source]`，取值只可能是到期/计划/进行中的组合）；
 * - AX-T05：旧口径的补丁文案「另有 N 个进行中任务未设置截止时间，暂列今天」**不再出现**，
 *   而「已完成」页签在**今日**视图里也拿得到（这是收敛带来的收益，原需求 #5）。
 *
 * 约定与其它套件一致：真实鼠标（坐标点击，滚进视口后**重新量一次**）、拿不到前置一律 fail。
 */
import { startSuite, createApi, launchSuiteBrowser, parseSuiteArgs, sleep, waitFor, ensureWorkbenchPanel } from './_harness.mjs'
import { discoverBrowser } from '../browser.mjs'

const options = parseSuiteArgs()
if (options.url === undefined) { console.error('用法：node scripts/verify/suites/day-panel.mjs --url <目标> [--evidence-dir <目录>]'); process.exit(2) }

const AX = ['AX-T03', 'AX-T04', 'AX-T05']
const suite = startSuite({ id: 'day-panel', title: '批次2 D15：今日 = 日历选中今天的同一日期面板', url: options.url, evidenceDir: options.evidenceDir, axIds: AX })
const api = createApi(options.url, { token: options.token })
const report = {}

let browser = null

async function clickSelector(selector) {
  const measure = async (scroll) => browser.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    ${scroll ? 'el.scrollIntoView({ block: "center", inline: "center" });' : ''}
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `)
  const first = await measure(true)
  if (first === null) return false
  await sleep(120)
  const settled = (await measure(false)) ?? first
  await browser.clickAt(settled.x, settled.y)
  return true
}

/** 读当前日期面板：页签、行（标题+来源徽标）、以及那句已被删掉的旧文案是否存在。 */
const READ_PANEL = `
  const tabs = Array.from(document.querySelectorAll('[data-day-tabs] .wb-seg')).map((b) => (b.textContent || '').trim().replace(/\\s+/g, ' '));
  const rows = Array.from(document.querySelectorAll('.wb-row')).map((row) => {
    const title = row.querySelector('.wb-row-title-text');
    const src = row.querySelector('[data-task-source]');
    return {
      title: title === null ? '' : (title.childNodes[0] === undefined ? '' : (title.childNodes[0].textContent || '').trim()),
      source: src === null ? null : src.getAttribute('data-task-source'),
    };
  }).filter((row) => row.title !== '');
  return {
    hasTabs: document.querySelector('[data-day-tabs]') !== null,
    tabs,
    rows,
    legacyNote: document.body.innerText.includes('暂列今天'),
    statsCard: document.querySelector('.wb-stats') !== null,
    capCard: document.querySelector('.wb-cap') !== null,
  };
`

try {
  const discovered = discoverBrowser({ overridePath: options.browser })
  if (discovered.ok !== true) throw new Error(`没有可用浏览器：${discovered.reason}`)
  browser = await launchSuiteBrowser({ url: options.url, token: options.token, userDataRoot: options.userDataRoot, browserPath: discovered.path })

  const reload = async () => {
    await browser.goto(api.pageUrl())
    await waitFor(async () => (await browser.evaluate(`return document.querySelector('[class*="sidebarCol"]') !== null;`)) === true,
      { timeoutMs: 30000, description: '宿主侧栏渲染' }).catch(() => undefined)
    await sleep(1200)
    return await ensureWorkbenchPanel(browser)
  }

  // ── 今日 ──────────────────────────────────────────────────────────────────
  if ((await reload()) === null) suite.require({ id: '打开工作台面板（前置）', axId: 'AX-T03', layer: 'B', detail: '找不到侧栏工作台入口' })
  // 面板默认落在「今日」；点一次确保状态确定（幂等：已是今日就再点一次无害）
  await browser.clickByText('今日', '.wb-seg')
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('[data-day-tabs]') !== null;`)) === true,
    { timeoutMs: 12000, description: '今日视图的日期面板页签' }).catch(() => undefined)
  const today = await browser.evaluate(READ_PANEL)
  report.today = { hasTabs: today.hasTabs, tabs: today.tabs, rowCount: today.rows.length, statsCard: today.statsCard, capCard: today.capCard }
  suite.note(`今日面板：${JSON.stringify(report.today)}`)
  await browser.screenshot(`${suite.dir}/01-今日面板.png`)

  suite.check({
    id: '今日有日期面板的三页签（计划 / 已完成 / 报告）—— 原需求 #5 的「已完成页签」由此获得',
    axId: 'AX-T03', layer: 'B',
    ok: today.hasTabs === true && today.tabs.length === 3 && today.tabs.some((t) => t.includes('已完成')) && today.tabs.some((t) => t.includes('报告')),
    detail: `tabs=${JSON.stringify(today.tabs)}`,
  })
  suite.check({
    id: '今日独有的统计卡与容量条仍在（收敛后今日只是该面板的 today 实例）',
    axId: 'AX-T03', layer: 'B',
    ok: today.statsCard === true && today.capCard === true,
    detail: `stats=${today.statsCard} cap=${today.capCard}`,
  })
  suite.check({
    id: '旧口径的补丁文案「另有 N 个进行中任务…暂列今天」已删（该来源已进口径）',
    axId: 'AX-T05', layer: 'B',
    ok: today.legacyNote === false,
    detail: `legacyNote=${today.legacyNote}`,
  })
  suite.check({
    id: '计划树逐条标来源（每行都有来源徽标，取值只可能是 到期/计划/进行中 的组合）',
    axId: 'AX-T04', layer: 'B',
    ok: today.rows.every((row) => typeof row.source === 'string' && /^(到期|计划|进行中)( · (到期|计划|进行中))*$/.test(row.source)),
    detail: JSON.stringify(today.rows.slice(0, 6)),
  })

  /**
   * 页签与下方内容的间距（**用户实测反馈**，2026-10-01）：
   * "计划/已完成/报告 这三个 Tab 切换控件和下面控件的间隔几乎没有，有点丑"。
   * 判据是量出来的真实几何：页签底边到内容顶边至少 8px。
   * 顺带把"点页签真的会切内容"也验了（切到「已完成」后内容区变成已完成树）。
   */
  const tabsGap = await browser.evaluate(`
    const tabs = document.querySelector('[data-day-tabs]');
    const content = document.querySelector('[data-day-tree], .wb-card');
    if (tabs === null || content === null) return null;
    return { gap: Math.round(content.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom), content: content.className };
  `)
  report.tabsGapPlan = tabsGap
  suite.check({
    id: '计划页签：页签底边到内容顶边留出了间距（不再"挤在一起"）',
    axId: 'AX-T03', layer: 'B',
    ok: tabsGap !== null && tabsGap.gap >= 8,
    detail: JSON.stringify(tabsGap),
  })
  // 切到「已完成」页签：点一下真的换内容，且间距同样成立
  const clickedDone = await browser.clickByText('已完成', '.wb-seg')
  if (clickedDone === null) suite.require({ id: '点「已完成」页签（前置）', axId: 'AX-T03', layer: 'B', detail: '找不到已完成页签' })
  await sleep(600)
  const afterDone = await browser.evaluate(`
    const tree = document.querySelector('[data-day-tree]');
    const tabs = document.querySelector('[data-day-tabs]');
    const content = document.querySelector('[data-day-tree], .wb-card');
    return {
      tab: tree === null ? null : tree.getAttribute('data-day-tree'),
      gap: (tabs === null || content === null) ? null : Math.round(content.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom),
    };
  `)
  report.doneTab = afterDone
  suite.check({
    id: '「已完成」页签：点了真换内容，且与页签之间同样有间距',
    axId: 'AX-T03', layer: 'B',
    ok: afterDone.tab === 'done' && afterDone.gap !== null && afterDone.gap >= 8,
    detail: JSON.stringify(afterDone),
  })
  await browser.screenshot(`${suite.dir}/03-已完成页签-间距.png`)

  // 切回「计划」页签：页签状态是**两个视图共用的**，不切回去就会拿"今日的已完成行"去比"日历的已完成行"，
  // 得到一条毫无意义的假红（第一次改成这样就踩了）。
  const backToPlan = await browser.clickByText('计划', '.wb-seg')
  if (backToPlan === null) suite.require({ id: '切回「计划」页签（前置）', axId: 'AX-T03', layer: 'B', detail: '找不到计划页签' })
  await sleep(500)

  // ── 日历（默认选中今天）──────────────────────────────────────────────────
  await browser.clickByText('日历', '.wb-seg')
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('[data-day-tabs]') !== null;`)) === true,
    { timeoutMs: 12000, description: '日历视图的日期面板页签' }).catch(() => undefined)
  const cal = await browser.evaluate(READ_PANEL)
  report.calendar = { hasTabs: cal.hasTabs, tabs: cal.tabs, rowCount: cal.rows.length, statsCard: cal.statsCard, capCard: cal.capCard }
  suite.note(`日历面板（选中今天）：${JSON.stringify(report.calendar)}`)
  await browser.screenshot(`${suite.dir}/02-日历选中今天.png`)

  const sameTabs = JSON.stringify(today.tabs) === JSON.stringify(cal.tabs)
  const sameRows = JSON.stringify(today.rows) === JSON.stringify(cal.rows)
  suite.check({
    id: 'AX-T03 主判据：今日与「日历选中今天」是同一份面板 —— 页签与行（标题+来源）逐一相同',
    axId: 'AX-T03', layer: 'B',
    ok: cal.hasTabs === true && sameTabs && sameRows,
    detail: `tabs相同=${sameTabs} 行相同=${sameRows} 今日${today.rows.length}行 / 日历${cal.rows.length}行`,
  })
  suite.check({
    id: '日历视图不带今日独有的两张卡（统计/容量属于今日实例）',
    axId: 'AX-T03', layer: 'B',
    ok: cal.statsCard === false && cal.capCard === false,
    detail: `stats=${cal.statsCard} cap=${cal.capCard}`,
  })
  await browser.screenshot(`${suite.dir}/03-并排依据.png`)
} catch (error) {
  suite.fatalError(error)
} finally {
  if (browser !== null) await browser.close().catch(() => undefined)
  process.exit(suite.finish({ report }))
}
