/**
 * 批次2 #2 的浏览器判据：**工作区双模式**（AX-W02 / AX-W03）。
 *
 * 判据（B 层：真实鼠标 + DOM 重读 + 截图，不看源码）：
 * - AX-W02 三个入口（快速录入 / 新建任务 / 编辑任务）都能 ① 从**已有工作区下拉**选中
 *   ② 打开**文件夹弹框**浏览并「选择此文件夹」，且选中的值真的落到该入口的工作区字段；
 * - AX-W03 弹框是**同一个组件**的 `dir` 模式：`data-doc-mode="dir"`、file 模式独有的
 *   「开始总结」按钮（`[data-doc-run]`）在 dir 模式下**不出现**；失败路径要有可读错误。
 *
 * 写法约定（与其它套件一致）：
 * - 交互一律走**真实鼠标**（`cdp.js#clickAt`，坐标点击）—— 程序化 `el.click()` 测不出 React 合成事件；
 * - 下拉框没有"点开选项"的可靠鼠标路径，所以用**原生 setter + 派发 change** 模拟用户选择，
 *   这一步在断言里明确标注（不假装是鼠标点的）；
 * - 每个阶段前重新加载页面：弹窗是同一个 React 树里的状态，不重载就可能把上一阶段的开合状态带进来；
 * - 拿不到前置（找不到入口/找不到元素）一律 `suite.require` = **fail**，不做有条件跳过。
 */
import { startSuite, createApi, launchSuiteBrowser, parseSuiteArgs, sleep, waitFor, ensureWorkbenchPanel } from './_harness.mjs'
import { discoverBrowser } from '../browser.mjs'

const options = parseSuiteArgs()
if (options.url === undefined) { console.error('用法：node scripts/verify/suites/workspace-picker.mjs --url <目标> [--evidence-dir <目录>]'); process.exit(2) }

const AX = ['AX-W02', 'AX-W03']
const suite = startSuite({ id: 'workspace-picker', title: '批次2 #2：工作区双模式（已有工作区下拉 + 文件夹弹框）', url: options.url, evidenceDir: options.evidenceDir, axIds: AX })
const api = createApi(options.url, { token: options.token })
const report = {}

let browser = null

/**
 * 真实鼠标点一个选择器。
 *
 * ⚠️ 必须**两轮量坐标**：`scrollIntoView` 之后布局要一帧才稳定，拿滚之前的坐标去点等于点在旧位置
 * （本套件第一次跑就踩了这个：点在目录行上 → 只是进了目录，而"选中"根本没发生，表现为
 * "值没落进去"的假故障）。这里的形状与 `cdp.mjs#clickByText` 保持一致（它是被同样的问题逼出来的）。
 */
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

/** 弹窗是否已关闭（硬判据用；不许用 `.catch(() => undefined)` 把"没关"吞掉）。 */
const modalClosed = () => browser.evaluate(`return document.querySelector('[data-doc-modal]') === null;`)

/** 读工作区选择器当前状态（下拉选项、选中项、输入框值）。形状**恒定**：拿不到也返回完整字段，
 * 否则调用方一读 `.options.length` 就崩（崩溃会把"判据失败"掩盖成"套件坏了"）。 */
const READ_PICKER = `
  const pickers = Array.from(document.querySelectorAll('[data-workspace-picker]'));
  const p = pickers[0] === undefined ? null : pickers[0];
  if (p === null) return { count: 0, options: [], selectedValue: null, inputValue: null, hiddenValue: null, hasBrowse: false, browseDisabled: null };
  const select = p.querySelector('[data-workspace-select]');
  const input = p.querySelector('[data-workspace-input]');
  const hidden = document.querySelector('input[type=hidden][name=workspacePath]');
  const browse = p.querySelector('[data-workspace-browse]');
  return {
    count: pickers.length,
    options: select === null ? [] : Array.from(select.options).map((o) => ({ value: o.value, text: o.textContent })),
    selectedValue: select === null ? null : select.value,
    inputValue: input === null ? null : input.value,
    hiddenValue: hidden === null ? null : hidden.value,
    hasBrowse: browse !== null,
    browseDisabled: browse === null ? null : browse.disabled,
  };
`

/** 用原生 setter + change 事件选中下拉里的某一项（React 受控组件必须这样改）。 */
const pickOption = (index) => `
  const p = document.querySelector('[data-workspace-picker]');
  const select = p.querySelector('[data-workspace-select]');
  const option = select.options[${index}];
  if (option === undefined) return null;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(select, option.value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return option.value;
`

/** 打开「浏览…」并等 dir 模式弹窗出现。 */
async function openDirModal(selector = '[data-workspace-browse]') {
  const clicked = await clickSelector(selector)
  if (!clicked) return false
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('[data-doc-modal][data-doc-mode="dir"]') !== null;`)) === true,
    { timeoutMs: 10000, description: 'dir 模式弹窗出现' }).catch(() => undefined)
  return (await browser.evaluate(`return document.querySelector('[data-doc-modal][data-doc-mode="dir"]') !== null;`)) === true
}

/**
 * 在 dir 弹窗里选一个文件夹：优先点某个子目录行的「选择此文件夹」，
 * 没有子目录就点「选定当前文件夹」。返回被选中的路径（从 DOM 上读，不猜）。
 */
async function pickFolderInModal() {
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('[data-doc-pick-dir], [data-doc-pick-current]') !== null;`)) === true,
    { timeoutMs: 10000, description: '目录行或"选定当前文件夹"可用' }).catch(() => undefined)
  const entry = await browser.evaluate(`
    const row = document.querySelector('[data-doc-entry]');
    const dirBtn = document.querySelector('[data-doc-pick-dir]');
    if (dirBtn !== null) return { mode: 'row', path: dirBtn.getAttribute('data-doc-pick-dir') };
    const current = document.querySelector('[data-doc-pick-current]');
    const crumb = document.querySelector('[data-doc-crumb]');
    if (current !== null && crumb !== null) return { mode: 'current', path: crumb.textContent.trim() };
    return null;
  `)
  if (entry === null) return null
  // 诊断：这个按钮到底在哪、该点上是什么元素（点了不生效时靠它定位，不留"不知道为什么"）
  const diag = await browser.evaluate(`
    const btn = document.querySelector('[data-doc-pick-dir], [data-doc-pick-current]');
    if (btn === null) return 'no-button';
    const r = btn.getBoundingClientRect();
    const cs = getComputedStyle(btn);
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const hit = (cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight) ? document.elementFromPoint(cx, cy) : null;
    const parent = btn.parentElement === null ? null : btn.parentElement.getBoundingClientRect();
    return JSON.stringify({
      attr: btn.getAttribute('data-doc-pick-dir') ?? btn.getAttribute('data-doc-pick-current') ?? null,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      center: { cx, cy },
      viewport: { w: innerWidth, h: innerHeight },
      style: { display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents, position: cs.position },
      parentRect: parent === null ? null : { x: Math.round(parent.left), y: Math.round(parent.top), w: Math.round(parent.width), h: Math.round(parent.height) },
      hitIsButton: hit === btn,
      hit: hit === null ? null : hit.tagName + '.' + (hit.className || '') + ' :: ' + (hit.textContent || '').trim().slice(0, 24),
      count: document.querySelectorAll('[data-doc-pick-dir]').length,
    });
  `)
  suite.note(`选文件夹按钮诊断：${diag}`)
  const clicked = entry.mode === 'row'
    ? await clickSelector('[data-doc-pick-dir]')
    : await clickSelector('[data-doc-pick-current]')
  if (!clicked) return null
  return entry
}

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

  // ── 阶段 1：快速录入 ───────────────────────────────────────────────────────
  if ((await reload()) === null) suite.require({ id: '打开工作台面板（前置）', axId: 'AX-W02', layer: 'B', detail: '找不到侧栏工作台入口' })
  const openedQuick = await browser.clickByText('快速录入', 'button')
  if (openedQuick === null) suite.require({ id: '打开快速录入弹窗（前置）', axId: 'AX-W02', layer: 'B', detail: '面板里找不到「快速录入」按钮' })
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('[data-workspace-picker]') !== null;`)) === true,
    { timeoutMs: 10000, description: '快速录入里的工作区选择器' }).catch(() => undefined)

  const quick = await browser.evaluate(READ_PICKER)
  report.quick = quick
  suite.note(`快速录入选择器：${JSON.stringify(quick)}`)
  suite.check({
    id: '快速录入：工作区选择器在位，且「已有工作区下拉 + 浏览按钮」都在',
    axId: 'AX-W02', layer: 'B',
    ok: quick.count === 1 && quick.hasBrowse === true && quick.options.length >= 1,
    detail: `pickers=${quick.count} options=${quick.options.length} browse=${quick.hasBrowse}`,
  })
  suite.check({
    id: '快速录入：下拉里是「已有工作区」候选（不是空下拉 / 不是原生 datalist）',
    axId: 'AX-W02', layer: 'B',
    ok: quick.options.length >= 1 && quick.options.some((o) => o.text.includes('·')),
    detail: `options=${JSON.stringify(quick.options.slice(0, 4))}`,
  })
  await browser.screenshot(`${suite.dir}/01-快速录入-选择器.png`)

  // 下拉选择（原生 setter + change；不是鼠标点选项）
  const pickIndex = quick.options.length >= 2 ? 1 : 0
  const pickedOption = quick.options.length === 0 ? null : await browser.evaluate(pickOption(pickIndex))
  await sleep(400)
  const afterSelect = await browser.evaluate(READ_PICKER)
  report.quickAfterSelect = afterSelect
  suite.check({
    id: '快速录入：从下拉选中后，输入框的值跟着变成该工作区（标注：改值走 change 事件，非鼠标点选项）',
    axId: 'AX-W02', layer: 'B',
    ok: pickedOption !== null && pickedOption !== '' && afterSelect.inputValue === pickedOption,
    detail: `选中=${JSON.stringify(pickedOption)} 输入框=${JSON.stringify(afterSelect.inputValue)}`,
  })
  await browser.screenshot(`${suite.dir}/02-快速录入-下拉选中.png`)

  // 文件夹弹框
  const dirOpen = await openDirModal()
  if (!dirOpen) suite.require({ id: '打开文件夹弹框（前置）', axId: 'AX-W03', layer: 'B', detail: '点「浏览…」后 dir 模式弹窗没出现' })
  const modalProbe = await browser.evaluate(`
    return {
      mode: document.querySelector('[data-doc-modal]').getAttribute('data-doc-mode'),
      title: document.querySelector('[data-doc-modal] h4').textContent.trim(),
      hasRun: document.querySelector('[data-doc-run]') !== null,
      hasPickCurrent: document.querySelector('[data-doc-pick-current]') !== null,
    };
  `)
  report.dirModal = modalProbe
  suite.check({
    id: '弹框是同一个组件的 dir 模式（标题/模式标记正确，file 独有的「开始总结」不出现）',
    axId: 'AX-W03', layer: 'B',
    ok: modalProbe.mode === 'dir' && modalProbe.title.includes('文件夹') && modalProbe.hasRun === false && modalProbe.hasPickCurrent === true,
    detail: JSON.stringify(modalProbe),
  })
  await browser.screenshot(`${suite.dir}/03-文件夹弹框-dir模式.png`)

  const picked = await pickFolderInModal()
  if (picked === null) suite.require({ id: '在弹框里选中一个文件夹（前置）', axId: 'AX-W02', layer: 'B', detail: '既没有目录行也没有「选定当前文件夹」' })
  // 硬判据：点了「选择此文件夹」就必须写值 + 关弹窗；"没关"不许被静默吞掉（这正是第一次跑漏掉的）
  await waitFor(modalClosed, { timeoutMs: 8000, description: '选完弹窗关闭' }).catch(() => undefined)
  const closedQuick = await modalClosed()
  const afterPick = await browser.evaluate(READ_PICKER)
  report.quickAfterPick = { picked, closed: closedQuick, ...afterPick }
  suite.check({
    id: '弹框选中的文件夹写进了快速录入的工作区输入框，且弹窗已关闭',
    axId: 'AX-W02', layer: 'B',
    ok: closedQuick === true && afterPick.inputValue === picked.path,
    detail: `选中=${picked.path}（${picked.mode}）输入框=${JSON.stringify(afterPick.inputValue)} 弹窗已关=${closedQuick}`,
  })
  await browser.screenshot(`${suite.dir}/04-快速录入-弹框选中后.png`)

  // ── 阶段 2：新建任务表单 ──────────────────────────────────────────────────
  if ((await reload()) === null) suite.require({ id: '打开工作台面板（新建任务前置）', axId: 'AX-W02', layer: 'B', detail: '找不到侧栏入口' })
  const openedForm = await browser.clickByText('新建', 'button')
  if (openedForm === null) suite.require({ id: '打开新建任务表单（前置）', axId: 'AX-W02', layer: 'B', detail: '找不到「新建」按钮' })
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('input[type=hidden][name=workspacePath]') !== null;`)) === true,
    { timeoutMs: 10000, description: '新建任务表单里的工作区字段' }).catch(() => undefined)
  const form = await browser.evaluate(READ_PICKER)
  report.form = form
  suite.check({
    id: '新建任务：工作区选择器在位，且提交字段仍是 name="workspacePath"',
    axId: 'AX-W02', layer: 'B',
    ok: form.count === 1 && form.hasBrowse === true && form.hiddenValue !== null,
    detail: `pickers=${form.count} hidden=${JSON.stringify(form.hiddenValue)} options=${form.options.length}`,
  })
  await browser.screenshot(`${suite.dir}/05-新建任务-选择器.png`)

  const formDirOpen = await openDirModal()
  if (!formDirOpen) suite.require({ id: '新建任务：打开文件夹弹框（前置）', axId: 'AX-W02', layer: 'B', detail: 'dir 弹窗没出现' })
  const formPicked = await pickFolderInModal()
  if (formPicked === null) suite.require({ id: '新建任务：在弹框里选中文件夹（前置）', axId: 'AX-W02', layer: 'B', detail: '没有可点的目录行/当前文件夹' })
  await waitFor(modalClosed, { timeoutMs: 8000, description: '选完弹窗关闭' }).catch(() => undefined)
  const closedForm = await modalClosed()
  const formAfter = await browser.evaluate(READ_PICKER)
  report.formAfterPick = { picked: formPicked, closed: closedForm, ...formAfter }
  suite.check({
    id: '新建任务：弹框选中的文件夹落到了提交字段（hidden workspacePath）与输入框',
    axId: 'AX-W02', layer: 'B',
    ok: closedForm === true && formAfter.inputValue === formPicked.path && formAfter.hiddenValue === formPicked.path,
    detail: `选中=${formPicked.path} input=${JSON.stringify(formAfter.inputValue)} hidden=${JSON.stringify(formAfter.hiddenValue)} 弹窗已关=${closedForm}`,
  })
  await browser.screenshot(`${suite.dir}/06-新建任务-弹框选中后.png`)

  // ── 阶段 3：编辑任务弹窗 ─────────────────────────────────────────────────
  if ((await reload()) === null) suite.require({ id: '打开工作台面板（编辑任务前置）', axId: 'AX-W02', layer: 'B', detail: '找不到侧栏入口' })
  const toList = await browser.clickByText('任务', '.wb-seg')
  if (toList === null) suite.require({ id: '切到「任务」页签（前置）', axId: 'AX-W02', layer: 'B', detail: '找不到任务页签' })
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('.wb-row') !== null;`)) === true,
    { timeoutMs: 15000, description: '任务列表出现行' }).catch(() => undefined)
  const rowClicked = await clickSelector('.wb-row')
  if (!rowClicked) suite.require({ id: '打开一条任务详情（前置）', axId: 'AX-W02', layer: 'B', detail: '点不到任务行' })
  await waitFor(async () => (await browser.evaluate(`return Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '编辑');`)) === true,
    { timeoutMs: 12000, description: '详情里出现「编辑」按钮' }).catch(() => undefined)
  const editClicked = await browser.clickByText('编辑', 'button')
  if (editClicked === null) suite.require({ id: '打开编辑任务弹窗（前置）', axId: 'AX-W02', layer: 'B', detail: '点不到「编辑」按钮' })
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('[data-workspace-picker]') !== null;`)) === true,
    { timeoutMs: 10000, description: '编辑弹窗里的工作区选择器' }).catch(() => undefined)
  const edit = await browser.evaluate(READ_PICKER)
  report.edit = edit
  suite.check({
    id: '编辑任务：工作区选择器在位（三个入口都有），且带「浏览…」',
    axId: 'AX-W02', layer: 'B',
    ok: edit.count === 1 && edit.hasBrowse === true && edit.options.length >= 1,
    detail: `pickers=${edit.count} options=${edit.options.length} browse=${edit.hasBrowse}`,
  })
  await browser.screenshot(`${suite.dir}/07-编辑任务-选择器.png`)
} catch (error) {
  suite.fatalError(error)
} finally {
  if (browser !== null) await browser.close().catch(() => undefined)
  process.exit(suite.finish({ report }))
}
