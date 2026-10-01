/**
 * 旧回归套件 4/4：**duplicate-task**（11 项，LEG-D01–LEG-D11）。
 *
 * 判据输入：`legacy-regression.md` §4；原脚本 `.pwtest/verify-duplicate-task.mjs`。
 *
 * ⚠️ **这套会写库**（创建草稿 / 任务 / 归档）。LEG 文档与 requirements §7.3 都写明：
 * 只能在**显式隔离的测试 DB** 上跑。本套自己再设一道闸：
 * 启动时用 `GET /api/workbench/health` 读目标库的 `taskCount`，把它连同目标 URL
 * 记进证据；**不对正式库做任何"先删干净再跑"的操作**，只归档本次 runId 造出的任务。
 *
 * 迁移摘要（脚手架差异）：
 * 1. 合成标题原为**固定字符串常量**（`【回归·临时】重复建单验收`）—— 这同时意味着
 *    "历史上跑这个脚本就是在正式库里按标题批量归档同名任务"（LEG 文档明确点名
 *    "不按其他用户同名标题批量归档"）。迁移后标题一律带 `runId`，清理只认登记过的 id。
 * 2. **LEG-D01 原来只比版本号** → 本地迭代刻意不改版本号（T5 交接 §3.2），
 *    只比版本会让"跑着旧包"通过。迁移后版本 **和** buildId 都比（LEG 文档同款要求）。
 * 3. 原脚本 `process.exit` 在 `finally` 之外；异常路径 `fatalError` 与 `results` 各自维护，
 *    容易出现"有致命错误但仍打印通过数"。迁移后统一 `suite.fatalError()` + harness 汇总。
 * 4. `finally` 清理里若抛错，原脚本会把它记成 check 失败 —— 这本身是对的（不能吞），
 *    迁移后保留该语义（LEG-D11）。
 */
import { startSuite, createApi, createSyntheticAssets, launchSuiteBrowser, parseSuiteArgs, sleep, waitFor, safeJson, readPackageVersion, readBuiltBuildId } from './_harness.mjs'
import { discoverBrowser } from '../browser.mjs'

const options = parseSuiteArgs()
if (options.url === undefined) { console.error('用法：node scripts/verify/suites/legacy-duplicate-task.mjs --url <目标>'); process.exit(2) }

const LEGACY_IDS = ['LEG-D01', 'LEG-D02', 'LEG-D03', 'LEG-D04', 'LEG-D05', 'LEG-D06', 'LEG-D07', 'LEG-D08', 'LEG-D09', 'LEG-D10', 'LEG-D11']
const suite = startSuite({ id: 'legacy-duplicate-task', title: '旧回归：同名任务重复建单（事件形态 + 真实点击收口）', url: options.url, evidenceDir: options.evidenceDir, legacyIds: LEGACY_IDS })
const api = createApi(options.url, { token: options.token })

const report = {}
let browser
const cleanupProblems = []

/** 本次 runId（模块级：`cleanupSynthetic` 也要用，且它必须在 `try` 之前声明好）。 */
let RUN_ID = ''
/** 本次 runId 造出来的标题（精确匹配，绝不按别人的同名标题批量归档）。 */
let SYNTHETIC_TITLE = ''

const titleOf = (assets) => assets.title('重复建单')

/**
 * 收尾：归档本次 runId 造出的任务 + 放弃本次草稿，然后**重读**确认归零。
 *
 * 只在 `finally` 里调用；抛错由调用方兜住并记成一条失败（不许吞）。
 * 匹配条件同时要求"标记前缀"与"本次 runId"—— 前者防止误伤真实任务，
 * 后者防止误伤别的轮次残留（LEG 文档：不按其他用户同名标题批量归档）。
 */
async function cleanupSynthetic() {
  const problems = []
  const liveResponse = await api.get('/api/workbench/tasks')
  const archivedResponse = await api.get('/api/workbench/tasks?archived=true')
  const ours = [...(liveResponse.body?.tasks ?? []), ...(archivedResponse.body?.tasks ?? [])]
    .filter((task) => typeof task.title === 'string' && task.title.includes(RUN_ID) && task.title.startsWith('【回归·临时·'))
  for (const task of ours) {
    try {
      const archived = await api.post(`/api/workbench/tasks/${task.id}/archive`)
      if (archived.status !== 200) problems.push(`归档 ${task.id.slice(0, 8)} 返回 ${archived.status}`)
    } catch (error) { problems.push(`归档 ${task.id.slice(0, 8)} 抛错：${error instanceof Error ? error.message : String(error)}`) }
  }
  const drafts = await api.get('/api/workbench/drafts')
  for (const draft of [drafts.body?.draft, ...(drafts.body?.deferredDrafts ?? [])].filter((entry) => entry !== null && entry !== undefined)) {
    if (typeof draft.payload?.title === 'string' && draft.payload.title.includes(RUN_ID)) {
      try {
        const abandoned = await api.post(`/api/workbench/drafts/${draft.id}/abandon`)
        if (abandoned.status !== 200 && abandoned.status !== 404) problems.push(`放弃草稿 ${draft.id.slice(0, 8)} 返回 ${abandoned.status}`)
      } catch (error) { problems.push(`放弃草稿 ${draft.id.slice(0, 8)} 抛错：${error instanceof Error ? error.message : String(error)}`) }
    }
  }
  const after = await api.get('/api/workbench/tasks')
  const left = (after.body?.tasks ?? []).filter((task) => typeof task.title === 'string' && task.title.includes(RUN_ID))
  return { problems, liveLeft: left.length }
}

try {
  // 每个 runId 一份合成资产（标题带 runId；清理只认登记过的 id）
  const probeRunId = `p${Date.now().toString(36)}`
  const assets = createSyntheticAssets(api, probeRunId)
  RUN_ID = probeRunId
  report.runId = probeRunId
  const TITLE = titleOf(assets)
  SYNTHETIC_TITLE = TITLE
  suite.note(`合成标题：${TITLE}`)

  const listByTitle = async (archived) => {
    const response = await api.get(`/api/workbench/tasks${archived ? '?archived=true' : ''}`)
    return (response.body?.tasks ?? []).filter((task) => task.title === TITLE)
  }

  // ── LEG-D01 health：version 等于目标包版本；新链另比 buildId ──────────────
  const health = await api.get('/api/workbench/health')
  const pkgVersion = readPackageVersion()
  const pkgBuildId = readBuiltBuildId()
  report.health = health.body
  report.targetPackage = { version: pkgVersion, buildId: pkgBuildId }
  report.database = health.body?.db ?? null
  suite.note(`目标库：schema=${health.body?.db?.schemaVersion} 任务数=${health.body?.db?.taskCount}（写入类判据只在隔离测试库上有意义）`)
  const versionOk = health.body?.version === pkgVersion
  const buildIdOk = health.body?.buildId !== undefined && health.body.buildId === pkgBuildId
  suite.check({
    id: `health 版本 = 目标包版本（${pkgVersion}）且 buildId 与本次构建一致`,
    legacyId: 'LEG-D01', layer: 'B', ok: versionOk && buildIdOk,
    detail: `health version=${health.body?.version} buildId=${health.body?.buildId ?? '(旧包不报)'} / 包 version=${pkgVersion} buildId=${pkgBuildId}`,
  })
  if (!versionOk) {
    // 与旧脚本一致：服务端还是旧代码时后续判据没有意义 —— 但**不能静默**，
    // 所以记为一条明确的致命前置，并让后续 LEG 逐条记 fail（不是跳过）。
    suite.fatalError(new Error(`目标实例跑的还是旧代码（health version ${health.body?.version} ≠ 包 ${pkgVersion}）—— 先装盘+重启再跑`))
  }

  // ── LEG-D02 提交并确认第一份同名 task 草稿 → HTTP200 且返回 task.id ──────
  const draftPayload = {
    title: TITLE,
    description: `回归用（runId=${probeRunId}），结束即归档。`,
    typeCode: 'personal', priorityCode: 'p3', statusCode: 'todo', subtasks: [],
  }
  const created1 = await api.post('/api/workbench/drafts', { kindCode: 'task', sessionId: `session-verify-dup-${probeRunId}-1`, payload: draftPayload })
  const d1 = assets.track.draft(created1.body?.draft)
  const first = await api.post(`/api/workbench/drafts/${d1?.id}/confirm`)
  if (first.body?.task?.id !== undefined) assets.track.task(first.body.task)
  suite.check({ id: '第一份草稿确认成功并返回 task.id', legacyId: 'LEG-D02', layer: 'B', ok: first.status === 200 && first.body?.task?.id !== undefined, detail: `status=${first.status}` })

  // ── LEG-D03 再提交第二份同名草稿但未确认 → 该 runId 标题未归档任务仍 1 条、另有 pending 草稿 ──
  const created2 = await api.post('/api/workbench/drafts', { kindCode: 'task', sessionId: `session-verify-dup-${probeRunId}-2`, payload: { ...draftPayload, description: `回归用第二份（runId=${probeRunId}，模拟执行会话重复提交）。` } })
  const d2 = assets.track.draft(created2.body?.draft)
  const liveAfterSecondDraft = await listByTitle(false)
  const pending = await api.get('/api/workbench/drafts')
  const pendingHasSecond = [pending.body?.draft, ...(pending.body?.deferredDrafts ?? [])].some((entry) => entry !== null && entry !== undefined && entry.id === d2?.id)
  suite.check({ id: '第二份草稿存在且该标题未归档任务仍是 1 条', legacyId: 'LEG-D03', layer: 'B', ok: liveAfterSecondDraft.length === 1 && pendingHasSecond, detail: `未归档=${liveAfterSecondDraft.length} 第二份仍在待确认=${pendingHasSecond}` })

  // ── LEG-D04 打开工作台（面板存在，data-open=1 且宽>200）────────────────
  const discovered = discoverBrowser({ overridePath: options.browser })
  if (discovered.ok !== true) throw new Error(`没有可用浏览器：${discovered.reason}`)
  browser = await launchSuiteBrowser({ url: options.url, token: options.token, userDataRoot: options.userDataRoot, browserPath: discovered.path })
  await browser.goto(api.pageUrl())
  /**
   * 等侧栏真的渲染出**可见**的工作台入口再点。
   * 固定 `sleep(4000)` 会偶发点空（T6 实测踩到过一次），而"点空了"会被 LEG-D04 记成失败 ——
   * 判据没错，但失败原因会指向错误的地方（看起来像"面板打不开"，实际是页面还没画完）。
   */
  const entryReady = await waitFor(async () => (await browser.evaluate(`
    const sidebar = document.querySelector('[class*="sidebarCol"]');
    if (sidebar === null) return 0;
    const vis = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    return Array.from(sidebar.querySelectorAll('button'))
      .filter((el) => el.hasAttribute('data-dsh-personal-workbench-entry') || (el.getAttribute('aria-label') || '').includes('工作台'))
      .filter(vis).length;
  `)) >= 1, { timeoutMs: 45000, description: '侧栏露出可见的工作台入口' }).then(() => true).catch(() => false)
  if (!entryReady) suite.note('等待 45s 仍无可见入口 —— 下面按 LEG 文档逐条记 fail（不跳过）')
  await sleep(800)
  const clicked = await browser.clickByText('工作台', 'button')
  suite.note(`点击侧栏工作台入口：${clicked === null ? '(没找到按钮)' : '已点'}`)
  await waitFor(async () => {
    const snap = await browser.evaluate(`const h = document.querySelector('.wb-panel-host'); return h !== null && h.getAttribute('data-open') === '1';`)
    return snap === true
  }, { timeoutMs: 15000, description: '面板 data-open=1' }).catch(() => undefined)
  const opened = await browser.evaluate(`
    const host = document.querySelector('.wb-panel-host');
    const r = host === null ? null : host.getBoundingClientRect();
    return { present: host !== null, dataOpen: host === null ? null : host.getAttribute('data-open'), w: r === null ? 0 : Math.round(r.width) };
  `)
  report.panel = opened
  await browser.screenshot(`${suite.dir}/01-panel-open.png`)
  suite.check({ id: '工作台面板已打开（data-open=1 且宽>200）', legacyId: 'LEG-D04', layer: 'B', ok: opened.present && opened.dataOpen === '1' && opened.w > 200, detail: safeJson(opened) })

  // ── LEG-D05 点第二份「确认入册」→ 出现「库里已经有一条同名任务」选择框 ──
  await sleep(6000) // 等宿主 5 秒轮询把第二份草稿推上来
  await browser.screenshot(`${suite.dir}/02-draft-banner.png`)
  const clickedConfirm = await browser.clickByText('确认入册', 'button')
  if (clickedConfirm === null) suite.require({ id: '找到「确认入册」按钮', legacyId: 'LEG-D05', layer: 'B', detail: '面板里没有可见的「确认入册」按钮' })
  await sleep(2500)
  const prompt = await browser.evaluate(`
    const t = Array.from(document.body.querySelectorAll('*')).map((n) => n.textContent || '').join(' ');
    return {
      hasPrompt: t.includes('库里已经有一条同名任务'),
      hasReuse: t.includes('就用已有那条'),
      hasKeep: t.includes('保留两条'),
    };
  `)
  report.prompt = prompt
  await browser.screenshot(`${suite.dir}/03-duplicate-prompt.png`)
  suite.check({ id: '弹出「库里已经有一条同名任务」选择框', legacyId: 'LEG-D05', layer: 'B', ok: prompt.hasPrompt === true, detail: safeJson(prompt) })

  // ── LEG-D06/D07 真实鼠标点「就用已有那条」→ 未归档只剩 1；多出那条已归档不硬删 ──
  if (prompt.hasReuse === true) {
    const reuseClicked = await browser.clickByText('就用已有那条', 'button')
    suite.note(`真实鼠标点「就用已有那条」：${reuseClicked === null ? '(没找到按钮)' : '已点'}`)
    await sleep(2500)
    await browser.screenshot(`${suite.dir}/04-after-dedupe.png`)
  } else {
    suite.require({ id: '真实鼠标点「就用已有那条」', legacyId: 'LEG-D06', layer: 'B', detail: '选择框里没有「就用已有那条」按钮' })
  }
  const live = await listByTitle(false)
  const archived = await listByTitle(true)
  report.afterDedupe = { live: live.length, archived: archived.length }
  suite.check({ id: '该 runId 标题在未归档任务里只剩 1 条', legacyId: 'LEG-D06', layer: 'B', ok: live.length === 1, detail: `未归档 ${live.length} 条` })
  suite.check({ id: '多建出来的那条已归档且数据保留（不硬删）', legacyId: 'LEG-D07', layer: 'B', ok: archived.length >= 1, detail: `归档 ${archived.length} 条：${archived.map((task) => task.id.slice(0, 8)).join(',')}` })

  // ── LEG-D08/D09 再确认同一份第二草稿 → replayed=true 且未归档数量不变 ──
  const replay = await api.post(`/api/workbench/drafts/${d2?.id}/confirm`)
  suite.check({ id: '同一份草稿再确认为回放（replayed=true）', legacyId: 'LEG-D08', layer: 'B', ok: replay.status === 200 && replay.body?.replayed === true, detail: `status=${replay.status} replayed=${replay.body?.replayed}` })
  const liveAfterReplay = await listByTitle(false)
  suite.check({ id: '回放不改变未归档任务数量', legacyId: 'LEG-D09', layer: 'B', ok: liveAfterReplay.length === live.length, detail: `${live.length} → ${liveAfterReplay.length}` })

  // ── LEG-D10 全序列：无 slot crash / Uncaught / TypeError / ReferenceError ──
  const crashed = [...browser.consoleLines.map((line) => line.text), ...browser.pageErrors.map((entry) => String(entry))]
    .filter((text) => /slot entry crashed|Uncaught|TypeError|ReferenceError/i.test(text))
  report.console = browser.consoleLines.map((line) => `[${line.level}] ${line.text.slice(0, 200)}`)
  report.errors = browser.pageErrors
  suite.check({ id: '全序列无 slot crash / Uncaught / TypeError / ReferenceError', legacyId: 'LEG-D10', layer: 'B', ok: crashed.length === 0, detail: crashed.slice(0, 3).map((text) => text.slice(0, 120)).join(' | ') || '无' })
} catch (error) {
  suite.fatalError(error)
} finally {
  // ── LEG-D11 finally 清理此次生成资产；失败不能吞掉原失败 ────────────────
  try {
    if (browser !== undefined) {
      await browser.screenshot(`${suite.dir}/99-收尾.png`).catch(() => undefined)
      await browser.close()
    }
    const cleanup = await cleanupSynthetic()
    for (const problem of cleanup.problems) cleanupProblems.push(problem)
    suite.check({
      id: 'finally 清理本次 runId 合成资产（未归档同名任务归 0）', legacyId: 'LEG-D11', layer: 'B',
      ok: cleanup.liveLeft === 0 && cleanupProblems.length === 0,
      detail: `未归档剩 ${cleanup.liveLeft} 条；清理问题 ${cleanupProblems.length} 条${cleanupProblems.length === 0 ? '' : `：${cleanupProblems.join(' / ')}`}`,
    })
  } catch (error) {
    suite.check({ id: 'finally 清理本次 runId 合成资产', legacyId: 'LEG-D11', layer: 'B', ok: false, detail: `清理抛错（原失败不被覆盖）：${error instanceof Error ? error.message : String(error)}` })
  }
  process.exit(suite.finish())
}
