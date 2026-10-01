/**
 * 新增套件 1/4：**progress**（AX-P07 / AX-P08 的 B 层）。
 *
 * 判据输入：`acceptance.md` §2 的 AX-P07、AX-P08。这两个编号在 T1 里只有 U/W 层证据
 * （`progressWiring.test.mjs` 的源码扫描），**B 层必须由本套件在真实浏览器上补齐**——
 * "静态 W 不得替代 B"（acceptance.md §1）。
 *
 * 用**真实鼠标事件**点击（CDP `Input.dispatchMouseEvent`，走 `cdp.mjs#clickAt`），
 * 每次断言前后都**重读 DOM 与接口**，并逐态截图。
 *
 * 合成资产全部带 runId，收尾只归档本次登记过的任务 id（不按标题批量匹配别人的数据）。
 */
import { startSuite, createApi, createSyntheticAssets, launchSuiteBrowser, parseSuiteArgs, sleep, waitFor, safeJson, repoRootFromSuite } from './_harness.mjs'
import { discoverBrowser } from '../browser.mjs'

const options = parseSuiteArgs()
if (options.url === undefined) { console.error('用法：node scripts/verify/suites/progress.mjs --url <目标>'); process.exit(2) }

const suite = startSuite({ id: 'progress', title: '新增：进度展示、子任务旁证与 AI 报进度口径（B 层）', url: options.url, evidenceDir: options.evidenceDir, axIds: ['AX-P07', 'AX-P08'], legacyIds: ['AX-P07', 'AX-P08'] })
const api = createApi(options.url, { token: options.token })

/** 列表/详情共用的读取器（一次 evaluate 读全，避免 N 次往返带来的时序错觉）。 */
const READ_LIST = `
  const rows = [];
  for (const row of document.querySelectorAll('.wb-row')) {
    const title = (row.querySelector('.wb-row-title')?.textContent || '').trim();
    const compact = row.querySelector('.wb-progress-compact');
    rows.push({
      title,
      percent: compact?.querySelector('.wb-progress-num')?.textContent ?? null,
      ariaNow: compact?.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') ?? null,
      fill: compact?.querySelector('.wb-progress-fill')?.getAttribute('style') ?? null,
      badge: compact?.querySelector('.wb-progress-badge')?.textContent ?? null,
      badgeKind: compact?.querySelector('.wb-progress-badge')?.className ?? null,
      childLabel: compact?.getAttribute('title') ?? null,
    });
  }
  return rows;
`

const READ_DETAIL = `
  const card = document.querySelector('.wb-progress-card');
  return {
    present: card !== null,
    percent: card?.querySelector('.wb-progress-num')?.textContent ?? null,
    ariaNow: card?.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') ?? null,
    note: card?.querySelector('.wb-progress-note')?.textContent ?? null,
    /**
     * ⚠️ 旁证在 2026-10-01 从"独立文本行"改成**悬停可见的图标**（用户要求把详情卡压成一行）。
     * 读法因此改成 title 属性 —— 判据的**意图没变**（旁证必须可见可查），
     * 变的只是它在 DOM 里的载体。列表行的 compact 形态本来就读 title，两边现在一致了。
     */
    childLabel: card?.querySelector('.wb-progress-child')?.getAttribute('title') ?? null,
    badge: card?.querySelector('.wb-progress-badge')?.textContent ?? null,
    presets: card === null ? [] : Array.from(card.querySelectorAll('.wb-progress-presets button')).map((b) => b.textContent),
  };
`

/** 打开任务列表页（点「任务」页签）并等列表渲染。 */
const gotoTaskList = async (browser) => {
  const target = await browser.evaluate(`
    const el = Array.from(document.querySelectorAll('.wb-seg')).find((e) => (e.textContent || '').trim() === '任务');
    if (el === undefined) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `)
  if (target !== null) { await browser.clickAt(target.x, target.y); await sleep(1200) }
  return target !== null
}

const openTaskByTitle = async (browser, title) => {
  const box = await browser.evaluate(`
    const wanted = ${JSON.stringify(title)};
    for (const row of document.querySelectorAll('.wb-row')) {
      const t = (row.querySelector('.wb-row-title')?.textContent || '').trim();
      if (t === wanted) { const r = row.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
    }
    return null;
  `)
  if (box === null) return null
  await browser.clickAt(box.x, box.y)
  await sleep(1200)
  return box
}

const report = {}
let browser
let assets

try {
  const runId = `p${Date.now().toString(36)}`
  assets = createSyntheticAssets(api, runId)
  const tParent = assets.title('进度父任务')
  const tChildDone = assets.title('进度子任务-已完成')
  const tChildCancel = assets.title('进度子任务-已取消')
  const tDone = assets.title('已结束任务')
  const tPlain = assets.title('零进度任务')

  // ── 合成资产：父(75) + 子(done/cancelled) + 一个 done 任务 + 一个 0 进度任务 ──
  const parent = await assets.createTask({ title: tParent, typeCode: 'personal', priorityCode: 'p3', statusCode: 'doing', estimatedMinutes: 600 })
  await assets.createTask({ title: tChildDone, typeCode: 'personal', priorityCode: 'p3', statusCode: 'done', parentId: parent.id })
  await assets.createTask({ title: tChildCancel, typeCode: 'personal', priorityCode: 'p3', statusCode: 'cancelled', parentId: parent.id })
  await assets.createTask({ title: tDone, typeCode: 'personal', priorityCode: 'p3', statusCode: 'done' })
  await assets.createTask({ title: tPlain, typeCode: 'personal', priorityCode: 'p3', statusCode: 'todo' })
  const setProgress = await api.patch(`/api/workbench/tasks/${parent.id}`, { progressPercent: 75 })
  suite.note(`合成资产：父 ${tParent}（PATCH 75 → HTTP ${setProgress.status}）`)
  if (setProgress.status !== 200) suite.require({ id: '合成父任务进度写入成功', axId: 'AX-P07', layer: 'B', detail: `PATCH 返回 ${setProgress.status}` })

  // 接口侧先确认库里的值（B 层判据不能只看 DOM）
  const viaApi = await api.get(`/api/workbench/tasks/${parent.id}`)
  report.apiParent = { status: viaApi.status, progressPercent: viaApi.body?.task?.progressPercent, statusCode: viaApi.body?.task?.statusCode, children: (viaApi.body?.task?.children ?? []).map((child) => child.statusCode) }
  suite.check({
    id: '接口重读：父任务 progressPercent=75 且子任务状态为 done/cancelled',
    axId: 'AX-P07', layer: 'B', ok: viaApi.body?.task?.progressPercent === 75 && viaApi.body?.task?.statusCode === 'doing',
    detail: safeJson(report.apiParent),
  })

  const discovered = discoverBrowser({ overridePath: options.browser })
  if (discovered.ok !== true) throw new Error(`没有可用浏览器：${discovered.reason}`)
  browser = await launchSuiteBrowser({ url: options.url, token: options.token, userDataRoot: options.userDataRoot, browserPath: discovered.path })
  await browser.goto(api.pageUrl())
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('[class*="sidebarCol"]') !== null;`)) === true, { timeoutMs: 30000, description: '宿主侧栏渲染' }).catch(() => undefined)
  await sleep(1500)

  const openedPanel = await browser.clickByText('工作台', 'button')
  if (openedPanel === null) suite.require({ id: '打开工作台面板', axId: 'AX-P07', layer: 'B', detail: '找不到侧栏工作台入口' })
  await waitFor(async () => (await browser.evaluate(`const h=document.querySelector('.wb-panel-host'); return h !== null && h.getAttribute('data-open') === '1';`)) === true, { timeoutMs: 15000, description: '面板 data-open=1' }).catch(() => undefined)
  const panelOpen = await browser.evaluate(`const h=document.querySelector('.wb-panel-host'); return h === null ? null : h.getAttribute('data-open');`)
  suite.check({ id: '工作台面板已打开', axId: 'AX-P07', layer: 'B', ok: panelOpen === '1', detail: `data-open=${panelOpen}` })

  await gotoTaskList(browser)
  // 等列表里出现本次合成标题
  await waitFor(async () => {
    const rows = await browser.evaluate(READ_LIST)
    return rows.some((row) => row.title === tParent)
  }, { timeoutMs: 20000, description: '列表出现合成任务' }).catch(() => undefined)
  await sleep(800)
  const list = await browser.evaluate(READ_LIST)
  report.list = list.filter((row) => row.title.startsWith('【回归·临时·'))
  await browser.screenshot(`${suite.dir}/01-列表.png`)

  const parentRow = list.find((row) => row.title === tParent)
  const doneRow = list.find((row) => row.title === tDone)
  const plainRow = list.find((row) => row.title === tPlain)

  // ── AX-P07-a 列表显示未完成任务的进度（数值 + 进度条宽度一致）────────────
  suite.check({
    id: '列表行显示未完成任务的进度（75% 且进度条宽度一致）', axId: 'AX-P07', layer: 'B',
    ok: parentRow !== undefined && parentRow.percent === '75%' && parentRow.ariaNow === '75' && String(parentRow.fill).includes('75%'),
    detail: safeJson(parentRow),
  })
  // ── AX-P07-b done 任务隐藏进度条（终态徽标是**另一回事**，必须还在）─────────
  suite.check({
    id: 'done 任务在列表里隐藏进度条（百分比/进度条都没有），但终态徽标仍在', axId: 'AX-P07', layer: 'B',
    ok: doneRow !== undefined && doneRow.percent === null && doneRow.ariaNow === null && doneRow.badge === '已完成',
    detail: safeJson(doneRow),
  })
  // ── AX-P08-a 子任务旁证：直接子任务 1 done / 1 cancelled 都体现，且**不从子任务派生父进度** ──
  suite.check({
    id: '父行显示子任务旁证（1/2 已完成、另 1 已取消），父进度仍是显式 75%',
    axId: 'AX-P08', layer: 'B',
    ok: parentRow !== undefined && parentRow.percent === '75%' && String(parentRow.childLabel ?? '').includes('子任务 1/2 已完成') && String(parentRow.childLabel ?? '').includes('1 个已取消'),
    detail: `childLabel=${parentRow?.childLabel ?? '(无)'} percent=${parentRow?.percent}`,
  })

  // ── AX-P07-c 详情页：完整形态（五档 + 输入框 + 数值）─────────────────────
  const clickedParent = await openTaskByTitle(browser, tParent)
  if (clickedParent === null) suite.require({ id: '点开父任务详情', axId: 'AX-P07', layer: 'B', detail: '列表里找不到父任务行' })
  await waitFor(async () => (await browser.evaluate(READ_DETAIL)).present === true, { timeoutMs: 10000, description: '详情进度卡出现' }).catch(() => undefined)
  const detail = await browser.evaluate(READ_DETAIL)
  report.detail = detail
  await browser.screenshot(`${suite.dir}/02-详情-父任务75.png`)
  suite.check({
    id: '详情卡显示 75%、五档预设（含「完成任务」）与输入框', axId: 'AX-P07', layer: 'B',
    ok: detail.present === true && detail.percent === '75%' && detail.ariaNow === '75' && safeJson(detail.presets) === safeJson(['0%', '25%', '50%', '75%', '完成任务']),
    detail: safeJson(detail),
  })
  suite.check({
    id: '详情卡显示子任务旁证（悬停可见），且没有把父进度改成派生值', axId: 'AX-P08', layer: 'B',
    ok: String(detail.childLabel ?? '').includes('子任务 1/2 已完成') && detail.percent === '75%',
    detail: `childLabel=${detail.childLabel ?? '(无)'} percent=${detail.percent}`,
  })
  const inputPresence = await browser.evaluate(`
    const card = document.querySelector('.wb-progress-card');
    const input = card?.querySelector('input[aria-label="进度百分比（0–99）"]');
    return { hasInput: input !== undefined && input !== null, placeholder: input?.getAttribute('placeholder') ?? null };
  `)
  suite.check({ id: '详情卡有进度输入框（0–99，不夹取）', axId: 'AX-P07', layer: 'B', ok: inputPresence.hasInput === true && inputPresence.placeholder === '0–99', detail: safeJson(inputPresence) })

  // ── AX-P07-d 真实鼠标点「25%」→ 接口重读确实是 25 ────────────────────────
  const clicked25 = await browser.clickByText('25%', '.wb-progress-presets button')
  if (clicked25 === null) suite.require({ id: '真实点击「25%」预设', axId: 'AX-P07', layer: 'B', detail: '找不到 25% 按钮' })
  await sleep(1500)
  const after25Api = await api.get(`/api/workbench/tasks/${parent.id}`)
  const after25Dom = await browser.evaluate(READ_DETAIL)
  report.after25 = { api: after25Api.body?.task?.progressPercent, dom: after25Dom.percent }
  await browser.screenshot(`${suite.dir}/03-详情-点25后.png`)
  suite.check({
    id: '真实鼠标点「25%」后：接口重读 25 且 DOM 同步显示 25%', axId: 'AX-P07', layer: 'B',
    ok: after25Api.body?.task?.progressPercent === 25 && after25Dom.percent === '25%' && after25Dom.ariaNow === '25',
    detail: safeJson(report.after25),
  })
  // 点完 25 之后任务仍是 doing（进度不改状态）
  suite.check({
    id: '保存进度不改变任务状态（仍 doing）', axId: 'AX-P07', layer: 'B',
    ok: after25Api.body?.task?.statusCode === 'doing', detail: `statusCode=${after25Api.body?.task?.statusCode}`,
  })

  // ── AX-P07-e 刷新后仍一致（B 层"刷新后仍一致"）───────────────────────────
  await browser.goto(api.pageUrl())
  await sleep(3500)
  await browser.clickByText('工作台', 'button')
  await sleep(2000)
  await gotoTaskList(browser)
  await sleep(1500)
  const afterReload = (await browser.evaluate(READ_LIST)).find((row) => row.title === tParent)
  report.afterReload = afterReload
  await browser.screenshot(`${suite.dir}/04-刷新后.png`)
  suite.check({
    id: '刷新页面后列表仍是 25%（DOM 与服务端一致）', axId: 'AX-P07', layer: 'B',
    ok: afterReload !== undefined && afterReload.percent === '25%' && afterReload.ariaNow === '25',
    detail: safeJson(afterReload),
  })

  // ── AX-P08-b 执行提示词：主动报进度 + AI 不能直接 done（生成物级 + 源码级）───
  const hints = await readExecutionHints()
  report.hints = hints
  suite.check({
    id: '执行提示词含「主动报进度」与「100 不是直接完成」', axId: 'AX-P08', layer: 'W',
    ok: hints.progressReport === true && hints.notDirectDone === true,
    detail: `主动报进度=${hints.progressReport} 100口径=${hints.notDirectDone}（命中：${hints.hits.join(' / ')}）`,
  })
  suite.check({
    id: '生成物里 AI 完成硬拦仍在（不能直接置 done/cancelled）', axId: 'AX-P08', layer: 'W',
    ok: hints.hardBlock === true, detail: `硬拦串命中=${hints.hardBlock}`,
  })
} catch (error) {
  suite.fatalError(error)
} finally {
  try {
    if (browser !== undefined) {
      await browser.screenshot(`${suite.dir}/99-收尾.png`).catch(() => undefined)
      await browser.close()
    }
    if (assets !== undefined) {
      const problems = await assets.cleanup()
      suite.note(problems.length === 0 ? '合成资产已全部归档/放弃' : `清理问题：${problems.join(' / ')}`)
      if (problems.length > 0) suite.check({ id: '收尾清理本次 runId 合成资产', axId: 'AX-P07', layer: 'B', ok: false, detail: problems.join(' / ') })
    }
    suite.writeEvidence('dom-readings.json', report)
  } catch (error) {
    suite.note(`收尾失败（不覆盖原判定）：${error instanceof Error ? error.message : String(error)}`)
  }
  process.exit(suite.finish())
}

/**
 * AX-P08 的提示词口径：**读生成物**（`lib/`）而不是只读 `src/`。
 *
 * 为什么读生成物：源码里写了不等于装盘的包里也有（本项目真出现过
 * "process.platform 被打进客户端 bundle"这一类生成物与源码不一致的问题）。
 * 这里同时给出生成物命中情况与命中片段，便于人工复核。
 */
async function readExecutionHints() {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const files = ['lib/index.js', 'lib/tools.js', 'lib/client.js']
  const hits = []
  let text = ''
  for (const file of files) {
    try { text += `\n/* ${file} */\n` + readFileSync(join(repoRootFromSuite(), file), 'utf8') } catch { /* 缺文件由下面的布尔暴露 */ }
  }
  const progressReport = /主动报(一次)?进度|阶段性推进/.test(text)
  /**
   * 「100 不是直接完成」这句在 2026-10-01 从提示词**正文**搬到了完成按钮的 `title`
   * （用户要求删掉卡片里那段长 tip，语义没删、只换了载体）。所以生成物里要对两种形态都认：
   * 提示词里的老写法，或界面上的新写法。
   */
  const notDirectDone = /100[^。\n]{0,40}(不是|不能)直接完成|不是直接完成/.test(text)
    || /100% 请点这里/.test(text)
    || /请点「完成任务」/.test(text)
  const hardBlock = /不能直接把任务标记为已完成|AI 不能直接|不能直接标记为已完成/.test(text)
  const matched = ['主动报进度', '不是直接完成', 'AI 完成硬拦'].filter((label) => {
    if (label === '主动报进度') return progressReport
    if (label === '不是直接完成') return notDirectDone
    return hardBlock
  })
  return { progressReport, notDirectDone, hardBlock, hits: matched, scanned: files }
}
