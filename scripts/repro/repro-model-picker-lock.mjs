#!/usr/bin/env node
/**
 * 需求 **#3「快速选择模型失效」** 的复现脚本（`requirements.md` §8.1 的「D 不修」条目）。
 *
 * ## 口径（为什么这么判）
 *
 * 原始口径：**选过模型 → 重启/换会话 → 再提交复测**；仍失效则**另记新 BUG**；
 * **不改** `profiles/node_modules`（宿主侧缺陷，只留复现记录 + 上报决策）。
 *
 * ## 复现的机理
 *
 * "选过模型"唯一的持久落点是 `localStorage['dsh-personal-workbench.quickModelSelection']`
 *（`ModelPicker.tsx` 的 `QUICK_MODEL_STORAGE_KEY`）。v1.15.7 修的那个 P0 是：
 * 该键有值时若**当次解析不到模型目录**，旧代码在 `openQuickEntry` 第一行就抛错 ⇒
 * **点「快速录入」毫无反应**，而且唯一的写入口（模型下拉）被门禁挡死 ⇒ 界面内改不回默认。
 *
 * 所以本脚本按"这个键有值 + 目录解析不到"来复现：
 * 写入一个**形状合法但不存在**的选择 → 重载页面（客户端状态重建，localStorage 保留，
 * 等价于"重启后第一次打开"）→ 依次验四件事：
 *
 * | # | 判据 | 历史失效时的表现 |
 * |---|---|---|
 * | 1 | 点「快速录入」能**打开弹窗** | 完全没反应（`openQuickEntry` 抛错） |
 * | 2 | 模型下拉能**打开并给出可读原因** | 菜单打不开 / 只说"接口没提供" |
 * | 3 | 有**「跟随 DSH 默认模型」出口**且可用 | 门禁挡死，界面内清不掉残留选择 |
 * | 4 | 提交后**不抛错**，要么成功要么给出可读提示 | 抛错中断整条快速录入 |
 *
 * ## 用法
 *
 * ```powershell
 * node scripts/repro/repro-model-picker-lock.mjs --url http://127.0.0.1:3080 --evidence-dir <目录>
 * ```
 * 会把观察结果写成 `<evidence-dir>/repro-model-picker-lock.json`，并把控制台输出留给复现记录引用。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApi, ensureWorkbenchPanel, launchSuiteBrowser, parseSuiteArgs, sleep, waitFor } from '../verify/suites/_harness.mjs'
import { discoverBrowser } from '../verify/browser.mjs'

const KEY = 'dsh-personal-workbench.quickModelSelection'
const PROBE_SELECTION = {
  provider: 'repro-nonexistent-provider',
  model: 'repro-nonexistent-model',
  label: '复现用（不存在的模型）',
}

const options = parseSuiteArgs()
if (options.url === undefined) {
  console.error('用法：node scripts/repro/repro-model-picker-lock.mjs --url <目标> [--evidence-dir <目录>]')
  process.exit(2)
}
const evidenceDir = options.evidenceDir ?? join(process.cwd(), '_local-build', 'repro-model-picker')
mkdirSync(evidenceDir, { recursive: true })

const api = createApi(options.url, { token: options.token })
const report = { url: options.url, probeSelection: PROBE_SELECTION, steps: [], verdict: 'unknown' }
const step = (name, detail) => {
  report.steps.push({ name, detail })
  console.log(`  · ${name}：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

/** 真实鼠标点击（滚进视口 → 重新量一次 → 点中心），与各套件同一套做法。 */
async function clickSelector(browser, selector) {
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

const READ_DIALOG = `
  const body = document.querySelector('.wb-dialog-body');
  const foot = document.querySelector('.wb-dialog-foot');
  const ta = document.querySelector('.wb-dialog-body textarea');
  return {
    dialogOpen: body !== null,
    placeholder: ta === null ? null : ta.getAttribute('placeholder'),
    footButtons: foot === null ? [] : Array.from(foot.querySelectorAll('button')).map((b) => (b.textContent || '').trim()),
    primaryDisabled: foot === null ? null : Array.from(foot.querySelectorAll('button.primary')).map((b) => b.disabled),
    pickerPresent: document.querySelector('.wb-btn.wb-model-picker') !== null,
    pickerLabel: (document.querySelector('.wb-btn.wb-model-picker')?.textContent ?? '').trim(),
  };
`

const READ_MENU = `
  const menu = document.querySelector('.wb-model-menu');
  const err = document.querySelector('.wb-model-menu-error');
  const empty = document.querySelector('.wb-model-menu-empty');
  const opts = Array.from(document.querySelectorAll('.wb-model-option')).map((o) => (o.textContent || '').trim());
  const clearOption = Array.from(document.querySelectorAll('.wb-model-option'))
    .find((o) => (o.textContent || '').includes('跟随 DSH 默认模型'));
  return {
    menuOpen: menu !== null,
    menuError: err === null ? null : (err.textContent || '').trim(),
    menuEmpty: empty === null ? null : (empty.textContent || '').trim(),
    optionCount: opts.length,
    clearOptionPresent: clearOption !== undefined,
    clearOptionDisabled: clearOption === undefined ? null : clearOption.disabled === true,
    firstOptions: opts.slice(0, 4),
  };
`

let browser = null
try {
  const discovered = discoverBrowser({ overridePath: options.browser })
  if (discovered.ok !== true) throw new Error(`没有可用浏览器：${discovered.reason}`)
  browser = await launchSuiteBrowser({ url: options.url, token: options.token, userDataRoot: options.userDataRoot, browserPath: discovered.path })

  const load = async () => {
    await browser.goto(api.pageUrl())
    await waitFor(async () => (await browser.evaluate(`return document.querySelector('[class*="sidebarCol"]') !== null;`)) === true,
      { timeoutMs: 30000, description: '宿主侧栏渲染' }).catch(() => undefined)
    await sleep(1200)
    return await ensureWorkbenchPanel(browser)
  }

  // ── 0. 基线：记下当前有没有残留选择（用完要还原） ───────────────────────────
  if ((await load()) === null) throw new Error('打不开工作台面板（前置不成立）')
  const baseline = await browser.evaluate(`return localStorage.getItem(${JSON.stringify(KEY)});`)
  step('基线：localStorage 里的模型选择', baseline === null ? '（无）' : baseline)

  // ── 1. 制造「选过模型」：写入形状合法但不存在的选择 ─────────────────────────
  await browser.evaluate(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(PROBE_SELECTION))}); return true;`)
  step('写入复现用的模型选择', PROBE_SELECTION)

  // ── 2. 重载（客户端状态重建，localStorage 保留 = "重启后第一次打开"） ───────
  if ((await load()) === null) throw new Error('重载后打不开工作台面板')
  const persisted = await browser.evaluate(`return localStorage.getItem(${JSON.stringify(KEY)});`)
  step('重载后选择仍在', persisted !== null)

  // ── 3. 判据 1：点「快速录入」能不能打开弹窗 ────────────────────────────────
  await browser.evaluate(`
    window.__reproErrors = [];
    window.addEventListener('error', (e) => window.__reproErrors.push('error: ' + String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__reproErrors.push('unhandledrejection: ' + String(e.reason)));
    return true;
  `)
  const clicked = await browser.clickByText('快速录入', 'button')
  step('点击「快速录入」', clicked === null ? '没找到按钮' : '已点击')
  await sleep(900)
  const dialog = await browser.evaluate(READ_DIALOG)
  report.dialog = dialog
  step('判据 1 · 弹窗是否打开', dialog.dialogOpen)
  await browser.screenshot(join(evidenceDir, '01-快速录入-弹窗.png'))

  // ── 4. 判据 2/3：模型下拉能不能打开、有没有可读原因与出口 ──────────────────
  if (dialog.dialogOpen) {
    const openedMenu = dialog.pickerPresent ? await clickSelector(browser, '.wb-btn.wb-model-picker') : false
    await sleep(700)
    const menu = await browser.evaluate(READ_MENU)
    report.menu = menu
    step('判据 2 · 菜单打开/可读原因', JSON.stringify(menu))
    step('判据 3 · 「跟随 DSH 默认模型」出口', menu.clearOptionPresent)
    await browser.screenshot(join(evidenceDir, '02-模型下拉.png'))
    // 关掉菜单（点遮罩），避免它挡住提交按钮
    await clickSelector(browser, '.wb-model-scrim')
    await sleep(300)
  }

  // ── 5. 判据 4：提交一次，看是抛错还是给出可读结果 ──────────────────────────
  if (dialog.dialogOpen) {
    await browser.evaluate(`
      const ta = document.querySelector('.wb-dialog-body textarea');
      if (ta === null) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '复现脚本：验证模型选择残留时快速录入是否仍可用');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `)
    await sleep(400)
    const submitted = await clickSelector(browser, '.wb-dialog-foot .wb-btn.primary')
    step('点击提交', submitted)
    await sleep(3500)
    const after = await browser.evaluate(`
      const errs = window.__reproErrors ?? [];
      const bodyText = document.body.innerText;
      return {
        dialogStillOpen: document.querySelector('.wb-dialog-body') !== null,
        panelError: (document.querySelector('.wb-err, .wb-error')?.textContent ?? '').trim(),
        degradeNoticeShown: bodyText.includes('本次未切换模型'),
        errors: errs,
        excerpt: bodyText.split('\\n').filter((l) => l.trim() !== '').slice(0, 14),
      };
    `)
    report.afterSubmit = after
    step('判据 4 · 提交后', JSON.stringify({ dialogStillOpen: after.dialogStillOpen, degradeNoticeShown: after.degradeNoticeShown, errors: after.errors }))
    await browser.screenshot(join(evidenceDir, '03-提交后.png'))
  }

  // ── 6. 还原基线（不留痕） ─────────────────────────────────────────────────
  await browser.evaluate(baseline === null
    ? `localStorage.removeItem(${JSON.stringify(KEY)}); return true;`
    : `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(baseline)}); return true;`)
  const restored = await browser.evaluate(`return localStorage.getItem(${JSON.stringify(KEY)});`)
  step('还原基线', restored === baseline)

  // ── 7. 判定 ───────────────────────────────────────────────────────────────
  const d = report.dialog ?? {}
  const m = report.menu ?? {}
  const a = report.afterSubmit ?? {}
  const checks = {
    '弹窗能打开（历史失效时点不动）': d.dialogOpen === true,
    '模型下拉能打开或给出可读原因': m.menuOpen === true || (m.menuError ?? '') !== '',
    '「跟随 DSH 默认模型」出口可达': m.clearOptionPresent === true,
    '提交不抛错': Array.isArray(a.errors) && a.errors.length === 0,
  }
  report.checks = checks
  report.verdict = Object.values(checks).every(Boolean) ? 'pass' : 'fail'
  console.log('\n判定：')
  for (const [name, ok] of Object.entries(checks)) console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  console.log(`\n结论：${report.verdict === 'pass' ? '未复现（v1.15.7 的修复在这个形态下有效）' : '复现了 —— 需要另记新 BUG'}`)
  writeFileSync(join(evidenceDir, 'repro-model-picker-lock.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(`证据：${join(evidenceDir, 'repro-model-picker-lock.json')}`)
  if (browser !== null) await browser.close().catch(() => undefined)
  process.exit(report.verdict === 'pass' ? 0 : 1)
} catch (error) {
  console.error(`复现脚本自身出错：${error instanceof Error ? error.message : String(error)}`)
  if (browser !== null) await browser.close().catch(() => undefined)
  process.exit(2)
}
