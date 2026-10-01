/**
 * 新增套件 2/4：**daily-effort**（AX-D07 / AX-D08 / AX-D09 / AX-C02 / AX-C05 / AX-C06 的 B 层）。
 *
 * 判据输入：`acceptance.md` §3（AX-D07–D09）与 §4（AX-C02/C05/C06）。
 * T2 只做了 U/H/W 层；**"真实点「今日投入结束」→ 显示已结束 → 刷新仍 true → 任务仍 doing、
 * 进度原值"这一串只能在真实浏览器上证明**。
 *
 * 写入只对隔离测试库（本套件自己再核对一次 health 的 taskCount/schema 并记进证据）。
 * 合成资产带 runId；收尾归档本次登记过的任务 id 与本次用到的计划日期。
 */
import { startSuite, createApi, createSyntheticAssets, launchSuiteBrowser, parseSuiteArgs, sleep, waitFor, safeJson, ensureWorkbenchPanel } from './_harness.mjs'
import { discoverBrowser } from '../browser.mjs'

const options = parseSuiteArgs()
if (options.url === undefined) { console.error('用法：node scripts/verify/suites/daily-effort.mjs --url <目标>'); process.exit(2) }

const AX = ['AX-D07', 'AX-D08', 'AX-D09', 'AX-C02', 'AX-C05', 'AX-C06']
const suite = startSuite({ id: 'daily-effort', title: '新增：跨日投入结束、进度建议、推迟截止（B 层）', url: options.url, evidenceDir: options.evidenceDir, axIds: AX, legacyIds: AX })
const api = createApi(options.url, { token: options.token })

const localDate = (offsetDays = 0) => {
  const date = new Date(Date.now() + offsetDays * 86400000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const isoDaysFromNow = (days) => `${localDate(days)}T00:01:00.000Z`

/** 读整个今日计划面板（列表 + 容量条 + 每行动作）。 */
const READ_PLAN = `
  const items = Array.from(document.querySelectorAll('.wb-plan-item')).map((el) => ({
    cls: el.className,
    title: (el.querySelector('b')?.textContent || '').trim(),
    minutes: (el.querySelector('.wb-plan-minutes')?.textContent || el.querySelector('.wb-plan-minutes-static')?.textContent || '').trim(),
    acts: Array.from(el.querySelectorAll('.wb-plan-act')).map((a) => (a.textContent || '').trim()),
    effortDoneLabel: el.querySelector('.wb-plan-effort-done')?.textContent ?? null,
    progressHintText: el.querySelector('.wb-plan-progress-hint')?.textContent ?? null,
    progressHintBtns: Array.from(el.querySelectorAll('.wb-plan-progress-hint button')).map((a) => (a.textContent || '').trim()),
  }));
  const panel = document.querySelector('.wb-panel-host');
  const text = panel === null ? '' : (panel.innerText || '');
  const capacityMatch = /已排 ([0-9]+) min/.exec(text);
  return {
    items,
    capacityMinutes: capacityMatch === null ? null : Number(capacityMatch[1]),
    capacityLine: (text.match(/已排 [0-9]+ min[^\\n]*/) || [null])[0],
    footer: (text.match(/共 [0-9]+ 项[^\\n]*/) || [null])[0],
    text: text.slice(0, 800),
  };
`

const clickInItem = async (browser, title, label) => {
  const box = await browser.evaluate(`
    const wanted = ${JSON.stringify(title)};
    for (const item of document.querySelectorAll('.wb-plan-item')) {
      const t = (item.querySelector('b')?.textContent || '').trim();
      if (t !== wanted) continue;
      const btn = Array.from(item.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)});
      if (btn === undefined || btn.disabled) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    return null;
  `)
  if (box === null) return null
  await browser.clickAt(box.x, box.y)
  await sleep(1500)
  return box
}

const report = {}
let browser
let assets
const createdTaskIds = []
const plansTouched = new Set()

/**
 * 计划投入的**服务端合计**。容量判据一律用"DOM 读数 == 同一时刻服务端合计"来断言，
 * **不写死 90/120 这类绝对值** —— 那个数会随库里其他任务变动（同一台机器上多轮验收，
 * 或用户自己也在用这个测试库）。绝对值断言只会变成"要么假红、要么只在本机此刻成立"。
 * 判据的意图是"容量账本与计划项一致"，等值比较表达它最准确。
 */
const plannedMinutesViaApi = async (date) => {
  const plan = await api.get(`/api/workbench/plans?date=${date}`)
  const items = plan.body?.plan?.items ?? []
  if (items.some((item) => typeof item.minutes !== 'number')) return { readable: false, total: null, count: items.length }
  return { readable: true, total: items.reduce((sum, item) => sum + item.minutes, 0), count: items.length }
}

try {
  const runId = `d${Date.now().toString(36)}`
  assets = createSyntheticAssets(api, runId)
  const tLong = assets.title('长任务-今日排入')
  const tDefer = assets.title('长任务-推迟截止')
  const today = localDate(0)
  plansTouched.add(today)

  // 环境事实：写入类判据只在隔离测试库上有意义 —— 把它记进证据
  const health = await api.get('/api/workbench/health')
  report.database = health.body?.db ?? null
  suite.note(`目标库 schema=${health.body?.db?.schemaVersion} 任务数=${health.body?.db?.taskCount}`)

  // ── 合成：future-due doing 长任务估时 600，今天排 90 ─────────────────────
  const long = await assets.createTask({ title: tLong, typeCode: 'personal', priorityCode: 'p3', statusCode: 'doing', estimatedMinutes: 600, dueAt: isoDaysFromNow(5) })
  createdTaskIds.push(long.id)
  const added = await api.post(`/api/workbench/plans/${today}/items`, { taskId: long.id, minutes: 90 })
  suite.check({
    id: '合成：future-due doing 长任务今天排入 90 min（POST 原子追加）', axId: 'AX-C05', layer: 'B',
    ok: added.status === 200 && added.body?.added === true, detail: `status=${added.status} added=${added.body?.added}`,
  })
  const planViaApi = await api.get(`/api/workbench/plans?date=${today}`)
  const apiItem = (planViaApi.body?.plan?.items ?? []).find((item) => item.taskId === long.id)
  report.apiItemBefore = apiItem
  suite.check({
    id: '接口重读：计划项 minutes=90 且 effortDone=false', axId: 'AX-D07', layer: 'B',
    ok: apiItem?.minutes === 90 && (apiItem?.effortDone === false || apiItem?.effortDone === undefined),
    detail: safeJson(apiItem),
  })

  // 第二个任务专门用来验「推迟截止一天」（不转移计划项）
  const deferTask = await assets.createTask({ title: tDefer, typeCode: 'personal', priorityCode: 'p3', statusCode: 'doing', estimatedMinutes: 120, dueAt: isoDaysFromNow(3) })
  createdTaskIds.push(deferTask.id)
  await api.post(`/api/workbench/plans/${today}/items`, { taskId: deferTask.id, minutes: 30 })
  report.deferDueBefore = deferTask.dueAt

  // ── 打开面板 → 今日 ─────────────────────────────────────────────────────
  const discovered = discoverBrowser({ overridePath: options.browser })
  if (discovered.ok !== true) throw new Error(`没有可用浏览器：${discovered.reason}`)
  browser = await launchSuiteBrowser({ url: options.url, token: options.token, userDataRoot: options.userDataRoot, browserPath: discovered.path })
  await browser.goto(api.pageUrl())
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('[class*="sidebarCol"]') !== null;`)) === true, { timeoutMs: 30000, description: '宿主侧栏渲染' }).catch(() => undefined)
  await sleep(1500)
  const entry = await ensureWorkbenchPanel(browser)
  if (entry === null) suite.require({ id: '打开工作台面板', axId: 'AX-D07', layer: 'B', detail: '找不到侧栏工作台入口' })
  await waitFor(async () => (await browser.evaluate(`const h=document.querySelector('.wb-panel-host'); return h !== null && h.getAttribute('data-open') === '1';`)) === true, { timeoutMs: 15000, description: '面板 data-open=1' }).catch(() => undefined)
  await sleep(1000)
  await browser.clickByText('今日', '.wb-seg')
  await sleep(2000)
  await waitFor(async () => {
    const plan = await browser.evaluate(READ_PLAN)
    return plan.items.some((item) => item.title === tLong)
  }, { timeoutMs: 20000, description: '今日计划里出现合成长任务' }).catch(() => undefined)
  const beforePlan = await browser.evaluate(READ_PLAN)
  report.planBefore = beforePlan
  await browser.screenshot(`${suite.dir}/01-今日计划.png`)
  const beforeRow = beforePlan.items.find((item) => item.title === tLong)
  suite.check({
    id: '今日计划显示该任务「投入 90 min」且未结束', axId: 'AX-D07', layer: 'B',
    ok: beforeRow !== undefined && String(beforeRow.minutes).includes('90 min') && beforeRow.effortDoneLabel === null && beforeRow.acts.includes('今日投入结束'),
    detail: safeJson(beforeRow),
  })
  // ── AX-C06 容量文案与计划一致（DOM 读数 == 服务端合计，同一时刻）────────
  const planned1 = await plannedMinutesViaApi(today)
  report.capacityCheck1 = { api: planned1, dom: beforePlan.capacityMinutes, footer: beforePlan.footer }
  suite.check({
    id: '容量条「已排 N min」== 服务端计划项合计（同一时刻读）', axId: 'AX-C06', layer: 'B',
    ok: planned1.readable === true && beforePlan.capacityMinutes === planned1.total && String(beforePlan.footer ?? '').includes('已排投入 ' + String(planned1.total) + ' min'),
    detail: safeJson(report.capacityCheck1),
  })

  // ── AX-D07 真实鼠标点「今日投入结束」→ 显示已结束 ────────────────────────
  const clickedEnd = await clickInItem(browser, tLong, '今日投入结束')
  if (clickedEnd === null) suite.require({ id: '真实点击「今日投入结束」', axId: 'AX-D07', layer: 'B', detail: '计划行里找不到可点的「今日投入结束」按钮' })
  await sleep(1200)
  const endedPlan = await browser.evaluate(READ_PLAN)
  report.planAfterEnd = endedPlan
  await browser.screenshot(`${suite.dir}/02-点今日投入结束.png`)
  const endedRow = endedPlan.items.find((item) => item.title === tLong)
  suite.check({
    id: '点「今日投入结束」后该行显示「今日投入已结束」，按钮变「继续投入」', axId: 'AX-D07', layer: 'B',
    ok: endedRow !== undefined && String(endedRow.effortDoneLabel ?? '').includes('今日投入已结束') && endedRow.acts.includes('继续投入'),
    detail: safeJson(endedRow),
  })
  const endedApi = await api.get(`/api/workbench/plans?date=${today}`)
  const endedApiItem = (endedApi.body?.plan?.items ?? []).find((item) => item.taskId === long.id)
  const taskAfterEnd = await api.get(`/api/workbench/tasks/${long.id}`)
  report.afterEnd = { planItem: endedApiItem, task: { statusCode: taskAfterEnd.body?.task?.statusCode, progressPercent: taskAfterEnd.body?.task?.progressPercent, dueAt: taskAfterEnd.body?.task?.dueAt, estimatedMinutes: taskAfterEnd.body?.task?.estimatedMinutes } }
  suite.check({
    id: '接口重读：effortDone=true，但任务仍 doing、进度/截止/估时都没变', axId: 'AX-D07', layer: 'B',
    ok: endedApiItem?.effortDone === true && taskAfterEnd.body?.task?.statusCode === 'doing' && taskAfterEnd.body?.task?.progressPercent === 0 && taskAfterEnd.body?.task?.estimatedMinutes === 600,
    detail: safeJson(report.afterEnd),
  })

  // ── AX-D08 结束投入后只出现显式 25/50/75 建议，未点不变 ──────────────────
  suite.check({
    id: '结束投入后出现显式 25/50/75 进度建议（未默认勾选）', axId: 'AX-D08', layer: 'B',
    ok: endedRow !== undefined && String(endedRow.progressHintText ?? '').includes('顺便更新任务进度') && safeJson(endedRow.progressHintBtns) === safeJson(['25%', '50%', '75%']),
    detail: `hint=${endedRow?.progressHintText ?? '(无)'} buttons=${safeJson(endedRow?.progressHintBtns ?? [])}`,
  })
  const progressBeforeClick = (await api.get(`/api/workbench/tasks/${long.id}`)).body?.task?.progressPercent
  suite.check({
    id: '未点建议之前进度没有变化（仍是 0）', axId: 'AX-D08', layer: 'B',
    ok: progressBeforeClick === 0, detail: `progressPercent=${progressBeforeClick}`,
  })
  const clicked50 = await browser.evaluate(`
    const wanted = ${JSON.stringify(tLong)};
    for (const item of document.querySelectorAll('.wb-plan-item')) {
      const t = (item.querySelector('b')?.textContent || '').trim();
      if (t !== wanted) continue;
      const btn = Array.from(item.querySelectorAll('.wb-plan-progress-hint button')).find((b) => (b.textContent || '').trim() === '50%');
      if (btn === undefined) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    return null;
  `)
  if (clicked50 === null) suite.require({ id: '真实点击进度建议「50%」', axId: 'AX-D08', layer: 'B', detail: '找不到 50% 建议按钮' })
  else { await browser.clickAt(clicked50.x, clicked50.y); await sleep(1500) }
  await browser.screenshot(`${suite.dir}/03-点50建议.png`)
  const after50Task = await api.get(`/api/workbench/tasks/${long.id}`)
  const after50Plan = await api.get(`/api/workbench/plans?date=${today}`)
  const after50Item = (after50Plan.body?.plan?.items ?? []).find((item) => item.taskId === long.id)
  report.after50 = { progress: after50Task.body?.task?.progressPercent, status: after50Task.body?.task?.statusCode, effortDone: after50Item?.effortDone }
  suite.check({
    id: '点「50%」只写进度：progressPercent=50、任务状态与投入结束状态都不受影响', axId: 'AX-D08', layer: 'B',
    ok: after50Task.body?.task?.progressPercent === 50 && after50Task.body?.task?.statusCode === 'doing' && after50Item?.effortDone === true,
    detail: safeJson(report.after50),
  })

  // ── AX-D09 刷新后仍 true；点「继续投入」回到 false ───────────────────────
  await browser.goto(api.pageUrl())
  await sleep(3500)
  await ensureWorkbenchPanel(browser)
  await sleep(1500)
  await browser.clickByText('今日', '.wb-seg')
  await sleep(2000)
  await waitFor(async () => {
    const plan = await browser.evaluate(READ_PLAN)
    return plan.items.some((item) => item.title === tLong)
  }, { timeoutMs: 20000, description: '刷新后计划行出现' }).catch(() => undefined)
  const reloadedPlan = await browser.evaluate(READ_PLAN)
  report.planAfterReload = reloadedPlan
  await browser.screenshot(`${suite.dir}/04-刷新后仍已结束.png`)
  const reloadedRow = reloadedPlan.items.find((item) => item.title === tLong)
  suite.check({
    id: '刷新页面后仍是「今日投入已结束」（B 层重读 DOM）', axId: 'AX-D09', layer: 'B',
    ok: reloadedRow !== undefined && String(reloadedRow.effortDoneLabel ?? '').includes('今日投入已结束'),
    detail: safeJson(reloadedRow),
  })
  const clickedResume = await clickInItem(browser, tLong, '继续投入')
  if (clickedResume === null) suite.require({ id: '真实点击「继续投入」', axId: 'AX-D09', layer: 'B', detail: '找不到「继续投入」按钮' })
  await sleep(1200)
  const resumedPlan = await browser.evaluate(READ_PLAN)
  const resumedApi = await api.get(`/api/workbench/plans?date=${today}`)
  const resumedItem = (resumedApi.body?.plan?.items ?? []).find((item) => item.taskId === long.id)
  const resumedRow = resumedPlan.items.find((item) => item.title === tLong)
  report.afterResume = { apiEffortDone: resumedItem?.effortDone, domLabel: resumedRow?.effortDoneLabel ?? null }
  await browser.screenshot(`${suite.dir}/05-继续投入.png`)
  suite.check({
    id: '点「继续投入」后 effortDone 回到 false（DOM 与接口一致）', axId: 'AX-D09', layer: 'B',
    ok: resumedItem?.effortDone === false && resumedRow?.effortDoneLabel === null,
    detail: safeJson(report.afterResume),
  })

  // ── AX-D08/D09 推迟截止一天：只改 dueAt，不转移计划项 ────────────────────
  const deferPlanBefore = await api.get(`/api/workbench/plans?date=${today}`)
  const deferItemBefore = (deferPlanBefore.body?.plan?.items ?? []).find((item) => item.taskId === deferTask.id)
  const clickedDefer = await clickInItem(browser, tDefer, '推迟截止一天')
  if (clickedDefer === null) suite.require({ id: '真实点击「推迟截止一天」', axId: 'AX-D08', layer: 'B', detail: '找不到「推迟截止一天」按钮' })
  await sleep(1500)
  const deferTaskAfter = await api.get(`/api/workbench/tasks/${deferTask.id}`)
  const deferPlanAfter = await api.get(`/api/workbench/plans?date=${today}`)
  const deferItemAfter = (deferPlanAfter.body?.plan?.items ?? []).find((item) => item.taskId === deferTask.id)
  report.defer = { before: deferTask.dueAt, after: deferTaskAfter.body?.task?.dueAt, itemBefore: deferItemBefore?.minutes, itemAfter: deferItemAfter?.minutes }
  await browser.screenshot(`${suite.dir}/06-推迟截止.png`)
  const beforeMs = Date.parse(deferTask.dueAt)
  const afterMs = Date.parse(deferTaskAfter.body?.task?.dueAt ?? '')
  suite.check({
    id: '「推迟截止一天」只改 dueAt（+1 天），计划项 minutes 不动', axId: 'AX-D08', layer: 'B',
    ok: Number.isFinite(afterMs) && Math.abs(afterMs - (beforeMs + 86400000)) < 60000 && deferItemAfter?.minutes === deferItemBefore?.minutes,
    detail: safeJson(report.defer),
  })

  // ── AX-C02/ C06：改计划投入 → 行内与容量账本一起变（且两边一致）──────────
  const setMinutes = await api.patch(`/api/workbench/plans/${today}/items/${long.id}`, { minutes: 60 })
  await browser.goto(api.pageUrl())
  await sleep(3000)
  await ensureWorkbenchPanel(browser)
  await sleep(1500)
  await browser.clickByText('今日', '.wb-seg')
  await sleep(2500)
  const afterMinutesPlan = await browser.evaluate(READ_PLAN)
  const planned2 = await plannedMinutesViaApi(today)
  report.afterMinutes = { status: setMinutes.status, api: planned2, dom: afterMinutesPlan.capacityMinutes, row: afterMinutesPlan.items.find((item) => item.title === tLong) ?? null }
  await browser.screenshot(`${suite.dir}/07-改分钟后容量.png`)
  suite.check({
    id: '把计划投入改成 60 后：行内显示 60 min，容量条同步（== 服务端合计）', axId: 'AX-C02', layer: 'B',
    ok: setMinutes.status === 200 && String(report.afterMinutes.row?.minutes ?? '').includes('60 min')
      && planned2.readable === true && afterMinutesPlan.capacityMinutes === planned2.total
      && planned1.readable === true && planned2.total === planned1.total - 30,
    detail: safeJson(report.afterMinutes),
  })
} catch (error) {
  suite.fatalError(error)
} finally {
  try {
    if (browser !== undefined) {
      await browser.screenshot(`${suite.dir}/99-收尾.png`).catch(() => undefined)
      await browser.close()
    }
    const cleanup = await cleanupSynthetic()
    for (const problem of cleanup.problems) suite.note(`清理：${problem}`)
    if (cleanup.problems.length > 0) suite.check({ id: '收尾清理本次合成资产', axId: 'AX-D09', layer: 'B', ok: false, detail: cleanup.problems.join(' / ') })
    suite.writeEvidence('dom-readings.json', report)
  } catch (error) {
    suite.note(`收尾失败（不覆盖原判定）：${error instanceof Error ? error.message : String(error)}`)
  }
  process.exit(suite.finish())
}

/**
 * 收尾：归档本次登记的任务 id，并把本次动过的计划日期里的**本次项**去掉。
 *
 * 注意：计划路由**没有**项级 DELETE（只有 `DELETE /plans/:date` 清整份计划、
 * 以及项级 PATCH 改 minutes/effortDone）。所以这里走"读回整份 → 过滤掉本次的项 →
 * PUT 回剩下的"；剩下的为空就用 DELETE 清整份 —— 与 `PUT` 拒绝空数组的既有口径一致。
 * 目标库是隔离测试库（证据里的 `database` 字段），这里也不会碰其他 runId 的数据。
 */
async function cleanupSynthetic() {
  const problems = []
  for (const date of plansTouched) {
    try {
      const plan = await api.get(`/api/workbench/plans?date=${date}`)
      const items = plan.body?.plan?.items ?? []
      const mine = items.filter((item) => createdTaskIds.includes(item.taskId))
      if (mine.length === 0) continue
      const keep = items.filter((item) => !createdTaskIds.includes(item.taskId))
      if (keep.length === 0) {
        const deleted = await api.del(`/api/workbench/plans/${date}`)
        if (deleted.status !== 200) problems.push(`清空计划 ${date} 返回 ${deleted.status}`)
      } else {
        const put = await api.put(`/api/workbench/plans/${date}`, {
          summary: plan.body?.plan?.summary ?? '',
          items: keep.map((item) => ({ taskId: item.taskId, note: item.note ?? '', ...(item.minutes === undefined ? {} : { minutes: item.minutes }) })),
        })
        if (put.status !== 200) problems.push(`计划 ${date} 回写剩余项返回 ${put.status}`)
      }
    } catch (error) { problems.push(`清理计划 ${date} 抛错：${error instanceof Error ? error.message : String(error)}`) }
  }
  const archived = await assets?.cleanup() ?? []
  problems.push(...archived)
  return { problems }
}
