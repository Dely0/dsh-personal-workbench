/**
 * 批次2 D15 的浏览器判据：**日期面板收敛**（AX-T03 / AX-T04 / AX-T05）。
 *
 * 判据（B 层：真实鼠标 + DOM 重读 + 截图）：
 * - AX-T03：从「今日」进入与从「日历选中今天」进入得到**同一个面板** ——
 *   同一组页签（计划/逾期/未排期/已完成/报告）、同一批行（标题 + 来源徽标逐一相同）；
 * - AX-T04：逐条标来源（每行都有 `[data-task-source]`，取值只可能是到期/计划/进行中的组合）；
 * - AX-T05：旧口径的补丁文案「另有 N 个进行中任务未设置截止时间，暂列今天」**不再出现**，
 *   而「已完成」页签在**今日**视图里也拿得到（这是收敛带来的收益，原需求 #5）。
 *
 * 2026-10-02 追加（ADR0001 口径补充，仍归在 AX-T03「面板身份」下）：
 * - 「逾期」/「未排期」两个页签点得开、内容区真的切换、行数与页签计数一致（上下文行不算成员）；
 * - **过去日期**：两个新页签消失、页签兜底到「计划」—— 且刻意把 state 停在「逾期」再翻到过去日期，
 *   证明不会出现"面板显示计划、列表却是空的"假空。
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
    id: '今日有日期面板的五个任务页签（计划 / 逾期 / 未排期 / 已完成 / 报告）—— 原需求 #5 的「已完成页签」由此获得',
    axId: 'AX-T03', layer: 'B',
    ok: today.hasTabs === true && today.tabs.length === 5
      && ['计划', '逾期', '未排期', '已完成', '报告'].every((label) => today.tabs.some((t) => t.includes(label))),
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

  // ── 「逾期」/「未排期」两个页签（2026-10-02 口径补充）──────────────────────
  /**
   * 读页签 + 内容区。`label` 只取按钮里的**文本节点**（图标是 svg、计数是 span.count），
   * 计数与成员行必须对得上：`rows` 只数**非上下文行**（`.wb-row-context` 是父链旁证，不算成员）。
   */
  const readTabState = async () => browser.evaluate(`
    const tabs = Array.from(document.querySelectorAll('[data-day-tabs] .wb-seg')).map((b) => ({
      label: Array.from(b.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim(),
      count: b.querySelector('.count') === null ? null : Number((b.querySelector('.count').textContent || '').trim()),
      on: b.classList.contains('on'),
    }));
    const tree = document.querySelector('[data-day-tree]');
    const rows = Array.from(document.querySelectorAll('.wb-row:not(.wb-row-context) .wb-row-title-text'))
      .map((e) => (e.textContent || '').trim()).filter((t) => t !== '');
    return { tabs, active: tree === null ? null : tree.getAttribute('data-day-tree'), rows };
  `)

  const clickTab = async (label) => {
    const clicked = await browser.clickByText(label, '[data-day-tabs] .wb-seg')
    if (clicked === null) suite.require({ id: `点「${label}」页签（前置）`, axId: 'AX-T03', layer: 'B', detail: `找不到页签「${label}」` })
    await sleep(500)
  }

  /**
   * 把页签里的**折叠父行全部展开**再数行。
   *
   * 为什么必须有：计数判据比的是"成员行数 == 页签徽标"，而树里嵌套成员在折叠状态下**根本不渲染**
   * （只画根行）。2026-10-05 实测：真实数据是深树，未排期 12 个成员只有 1 个根行可见 → 判据假红。
   * 用**真实鼠标点击**（先 scrollIntoView 再量坐标），不用 `el.click()`；一次只展开一个，
   * 因为展开会让后面的行位移、坐标失效。
   */
  const expandAllRows = async () => {
    for (let round = 0; round < 40; round += 1) {
      const box = await browser.evaluate(`
        for (const btn of document.querySelectorAll('[data-day-tree] .wb-row button')) {
          if ((btn.textContent || '').trim() !== '▶') continue;
          btn.scrollIntoView({ block: 'center' });
          const r = btn.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      `)
      if (box === null || box === undefined) return
      await browser.clickAt(box.x, box.y)
      await sleep(250)
    }
  }

  for (const [label, key, shot] of [['逾期', 'overdue', '04-逾期页签.png'], ['未排期', 'unscheduled', '05-未排期页签.png']]) {
    await clickTab(label)
    await expandAllRows()
    const state = await readTabState()
    report[`${key}Tab`] = state
    const badge = state.tabs.find((t) => t.label === label)?.count ?? -1
    suite.check({
      id: `「${label}」页签：点得开、内容区真的切过去、行数与页签计数一致（上下文行不计入）`,
      axId: 'AX-T03', layer: 'B',
      ok: state.active === key && state.rows.length === badge,
      detail: JSON.stringify({ active: state.active, rows: state.rows.length, badge, tabs: state.tabs.map((t) => `${t.label}:${t.count}`) }),
    })
    suite.note(`「${label}」页签：${state.rows.length} 行 / 计数 ${badge}`)
    await browser.screenshot(`${suite.dir}/${shot}`)
  }

  /**
   * **切回「计划」再进日历**（与上面 L160 那条同一个坑，2026-10-04 补）。
   *
   * 页签状态是**今日/日历共用的**（`dayTab` 一份 state，见 `useDayWorkspace`），上面这轮
   * 刚把 state 停在「未排期」——而「未排期」是补集页签，今天恰好 0 行。不归位就切视图，
   * 下面的主判据会拿"今日的计划行(2)"去比"日历的未排期行(0)"，得到一条毫无意义的假红。
   *
   * 实测复现（2026-10-04，3080 / v1.16.2）：受控顺序下 `今日(计划)` 与 `日历(计划)` 的行
   * 逐字相同（2 行，来源均为「进行中」）；只有把 state 停在「未排期」时才是 0 行。
   * 判据本身一字未改 —— 这里只是把**被测量前的前置状态**归一。
   */
  await clickTab('计划')

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

  // ── 过去日期：两个新页签必须消失，且页签兜底到「计划」──────────────────────
  /**
   * 刻意先把页签停在「逾期」再翻到过去日期：这是"面板显示计划、列表却是空的"假空的唯一入口
   *（该日计划的加载闸门是按旧页签关着的）。判据同时覆盖"藏掉两个页签"与"兜底到计划"。
   *
   * 过去的那一天怎么点：本周条里"今天"之前的那一格；若今天就是本周第一天，先翻到上一周，
   * 再点那一周的最后一天（那一周全部是过去）—— 两条路径都不依赖运行日期，不会随机红。
   */
  await clickTab('逾期')
  const probePast = await browser.evaluate(`
    const cells = Array.from(document.querySelectorAll('.wb-day'));
    if (cells.length === 0) return null;
    const idx = cells.findIndex((c) => c.classList.contains('today'));
    const pick = (cell) => { const r = cell.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
    if (idx > 0) return { how: 'same-week', ...pick(cells[idx - 1]) };
    return { how: 'prev-week' };
  `)
  let pastHow = probePast === null ? null : probePast.how
  if (pastHow === 'same-week') {
    await browser.clickAt(probePast.x, probePast.y)
  } else if (pastHow === 'prev-week') {
    const back = await browser.clickByText('◀', '.wb-cal-nav .wb-btn')
    if (back === null) suite.require({ id: '翻到上一周（前置）', axId: 'AX-T03', layer: 'B', detail: '找不到上一周按钮' })
    await sleep(400)
    const last = await browser.evaluate(`
      const cells = Array.from(document.querySelectorAll('.wb-day'));
      if (cells.length === 0) return null;
      const r = cells[cells.length - 1].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `)
    if (last === null) pastHow = null
    else await browser.clickAt(last.x, last.y)
  } else {
    pastHow = null
  }
  await sleep(800)
  const pastState = await readTabState()
  report.pastDay = { how: pastHow, tabs: pastState.tabs.map((t) => t.label), active: pastState.active }
  suite.check({
    id: '过去日期：不显示「逾期」/「未排期」，页签兜底到「计划」（state 停在逾期也不许假空）',
    axId: 'AX-T03', layer: 'B',
    ok: pastHow !== null && pastState.tabs.length === 3
      && pastState.tabs.every((t) => ['计划', '已完成', '报告'].includes(t.label))
      && pastState.active === 'plan',
    detail: JSON.stringify(report.pastDay),
  })
  await browser.screenshot(`${suite.dir}/06-过去日期-两页签消失.png`)
} catch (error) {
  suite.fatalError(error)
} finally {
  if (browser !== null) await browser.close().catch(() => undefined)
  process.exit(suite.finish({ report }))
}
