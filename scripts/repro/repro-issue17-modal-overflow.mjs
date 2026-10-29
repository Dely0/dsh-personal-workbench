#!/usr/bin/env node
/**
 * issue #17 实机复现/验收：「AI 执行」补充提示词弹窗高于视口、底部「取消/开始」被挤出屏幕。
 *
 * ## 为什么必须真浏览器 + 真实例
 *
 * 判据是**像素几何**（弹窗盒子是否超出视口、底部按钮是否落在视口内、是否被裁剪），
 * 读源码 / typecheck / 单测都看不出来。这里走真实实例的 UI（点入口 → 选任务 → 点「AI 执行」），
 * 用 getBoundingClientRect() + getComputedStyle() 量，截图留证。
 *
 * ## 两种相位（同一套测量、同一套判定）
 *
 * - --phase=after    ：目标实例上**原样**测（期望 VERDICT: FIXED）。
 * - --phase=mutation ：在同一页面上用 CDP 注入覆盖样式，把修复**摘掉**
 *                      （max-height:none / overflow:visible / actions position:static），
 *                      期望 VERDICT: BUG_REPRODUCED —— 这是**变异探针**：
 *                      证明这套测量真的抓得住这个 bug，而不是"看起来正常"。
 * - --phase=before   ：语义同 mutation（未修版本），仅为兼容旧调用保留。
 *
 * 判定函数**只有一份**，相位只决定"期望哪个结论"，不参与判定 ——
 * 否则就成了一套会自己给自己发绿牌的判据。
 *
 * ## 安全
 *
 * **绝不点「开始」**（会真建执行会话、写任务进度）。只用 elementFromPoint(按钮中心)
 * 做 hit-test 判断该点命中的是不是按钮本身。
 *
 * 用法：
 *   node scripts/repro/repro-issue17-modal-overflow.mjs --phase=after --url="http://127.0.0.1:3080/?token=..."
 *   node scripts/repro/repro-issue17-modal-overflow.mjs --phase=mutation --url="http://127.0.0.1:3080/?token=..."
 *   可选：--sizes=1280x720,900x600  --out=<目录>
 *
 * 退出码：0 = 与相位期望一致；1 = 不一致（after 复现出 bug / mutation 没复现出 bug）；
 *        2 = 环境或前置失败（起不来浏览器、找不到任务行、弹窗打不开……）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverBrowser } from '../verify/browser.mjs'
import { launchDebugBrowser } from '../verify/cdp.mjs'
import { tmpdir } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const PHASE = argOf('phase', 'after')
if (!['after', 'mutation', 'before'].includes(PHASE)) {
  console.error('未知 --phase：' + PHASE + '（只接受 after / mutation / before）')
  process.exit(2)
}
/** mutation / before 都是"未修"语义：期望复现出 bug。 */
const EXPECTED = PHASE === 'after' ? 'FIXED' : 'BUG_REPRODUCED'

const OUT = resolve(ROOT, argOf('out', join('..', '_local-archive', 'issue17', PHASE)))
const SIZES = argOf('sizes', '1280x720,900x600').split(',').map((s) => {
  const parts = s.trim().split('x').map(Number)
  const w = parts[0]
  const h = parts[1]
  if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error('--sizes 解析失败：' + s)
  return { width: w, height: h }
})

/**
 * 自动发现目标 URL 用的服务日志：默认系统临时目录下的 `dsh-server-3080.log`。
 * 指到自己实例的日志时传 `--log=...` 或设 `DSH_SERVER_LOG=...` —— 仓库里不留本机账号路径。
 */
const LOG_PATH = argOf('log', process.env.DSH_SERVER_LOG ?? join(tmpdir(), 'dsh-server-3080.log'))
/** token 只在内存里；落盘一律脱敏。 */
function redact(url) {
  return String(url).replace(/token=[^&]+/g, 'token=***')
}
function fromLog() {
  if (!existsSync(LOG_PATH)) return ''
  const text = readFileSync(LOG_PATH, 'utf8')
  const hits = Array.from(text.matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_\-]+)/g))
  return hits.length === 0 ? '' : hits[hits.length - 1][1]
}
const TARGET_URL = argOf('url', '') || process.env.DSH_VERIFY_URL || fromLog()
if (TARGET_URL === '') {
  console.error('没有目标 URL：传 --url="http://127.0.0.1:3080/?token=..."（或不传，脚本会去 3080 日志里找最后一条）')
  process.exit(2)
}

/**
 * 把修复摘掉用的覆盖样式（变异探针）。
 * 必须**整条覆盖**这三条属性：max-height / overflow / overscroll-behavior；
 * actions 同时去掉 sticky 与 bottom —— 正好是修复加上的那几条。
 */
const MUTATION_CSS = [
  '.wb-modal{max-height:none !important;overflow:visible !important;overscroll-behavior:auto !important;}',
  '.wb-modal-actions{position:static !important;bottom:auto !important;padding:0 !important;background:transparent !important;}',
].join('\n')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 页面内测量（一次求值拿全量数据） ────────────────────────────────────────

const MEASURE = (`
  const modal = document.querySelector('.wb-modal');
  const mask = document.querySelector('.wb-modal-mask');
  if (modal === null || mask === null) return { error: 'no-modal' };
  const round = (n) => Math.round(n * 10) / 10;
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { top: round(r.top), left: round(r.left), right: round(r.right), bottom: round(r.bottom), width: round(r.width), height: round(r.height) };
  };
  const cs = getComputedStyle(modal);
  const mcs = getComputedStyle(mask);
  const actions = modal.querySelector('.wb-modal-actions');
  const acs = actions === null ? null : getComputedStyle(actions);
  const scope = actions === null ? modal : actions;
  const all = Array.from(scope.querySelectorAll('button'));
  const startBtn = all.find((b) => (b.textContent || '').trim().includes('开始')) ?? null;
  const btnInfo = (btn) => {
    if (btn === null) return null;
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const inViewport = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
    const hitEl = inViewport ? document.elementFromPoint(cx, cy) : null;
    const hit = hitEl === null ? (inViewport ? 'null' : 'outside-viewport')
      : (hitEl === btn || btn.contains(hitEl) ? 'self'
        : hitEl.tagName.toLowerCase() + '.' + String(hitEl.className || '').slice(0, 40));
    const fullyVisible = r.width > 0 && r.height > 0
      && r.top >= -0.5 && r.left >= -0.5
      && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
    const clippedBy = [];
    let p = btn.parentElement;
    while (p !== null && p !== document.body) {
      const pcs = getComputedStyle(p);
      if (pcs.overflowX !== 'visible' || pcs.overflowY !== 'visible') {
        const pr = p.getBoundingClientRect();
        if (r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) {
          clippedBy.push({ cls: String(p.className || '').slice(0, 40), overflowY: pcs.overflowY, top: round(pr.top), bottom: round(pr.bottom) });
        }
      }
      p = p.parentElement;
    }
    return {
      text: (btn.textContent || '').trim().slice(0, 20),
      disabled: btn.disabled === true,
      rect: rectOf(btn),
      fullyVisible,
      hit,
      reachable: fullyVisible && hit === 'self',
      clippedBy,
    };
  };
  const modalScrollable = modal.scrollHeight > modal.clientHeight + 1
    && ['auto', 'scroll'].includes(cs.overflowY);
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    modal: {
      rect: rectOf(modal),
      scrollTop: round(modal.scrollTop),
      scrollHeight: modal.scrollHeight,
      clientHeight: modal.clientHeight,
      clientWidth: modal.clientWidth,
      scrollWidth: modal.scrollWidth,
      /** content-box 时 max-height 只管内容盒：判定要换算成内容高度（见 judge）。 */
      contentHeight: round(modal.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0')),
      style: {
        boxSizing: cs.boxSizing,
        paddingTop: cs.paddingTop,
        paddingBottom: cs.paddingBottom,
        borderTop: cs.borderTopWidth,
        borderBottom: cs.borderBottomWidth,
        maxHeight: cs.maxHeight,
        overflowY: cs.overflowY,
        overflowX: cs.overflowX,
        overscrollBehavior: cs.overscrollBehavior || cs.overscrollBehaviorY,
        position: cs.position,
        height: cs.height,
      },
      overflow: { contentOverflow: modal.scrollHeight > modal.clientHeight + 1, scrollable: modalScrollable },
    },
    mask: {
      rect: rectOf(mask),
      style: { position: mcs.position, alignItems: mcs.alignItems, overflowY: mcs.overflowY },
      scrollHeight: mask.scrollHeight,
      clientHeight: mask.clientHeight,
      scrollable: mask.scrollHeight > mask.clientHeight + 1 && ['auto', 'scroll'].includes(mcs.overflowY),
    },
    actions: actions === null ? null : {
      rect: rectOf(actions),
      style: { position: acs.position, bottom: acs.bottom, paddingTop: acs.paddingTop, background: acs.backgroundColor },
      buttons: all.map((b) => (b.textContent || '').trim().slice(0, 12)),
    },
    startButton: btnInfo(startBtn),
    page: {
      docScrollHeight: document.documentElement.scrollHeight,
      docClientHeight: document.documentElement.clientHeight,
      pageScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    },
  };
`)

// ── 判定（只有一份；相位不参与） ────────────────────────────────────────────

function round1(n) { return Math.round(n * 10) / 10 }

function judge(viewports) {
  const problems = []
  const notes = []
  for (const vp of viewports) {
    const tag = vp.label
    if (vp.initial === null || vp.initial.error !== undefined) {
      problems.push(tag + '：量不到弹窗（' + JSON.stringify(vp.initial) + '）')
      continue
    }
    const m = vp.initial
    const limit = Math.min(0.88 * m.viewport.h, 900)
    /**
     * `.wb-modal` 是默认的 content-box（padding:18px），而 `max-height` 只约束**内容盒** ——
     * 于是 rect.height 恒等于 max-height + padding + border，直接拿 rect.height 比
     * min(88vh,900) 会把"修复后"误判成"超限"（实测：720 高视口下 max-height=633.6、
     * clientHeight=670、rect.height=671.6，差的就是 18*2 的 padding + 边框）。
     * 所以按 box-sizing 换算：border-box 比 rect.height，content-box 比内容盒高度。
     */
    const modalHeight = m.modal.style.boxSizing === 'border-box' ? m.modal.rect.height : m.modal.contentHeight
    if (modalHeight > limit + 1) {
      problems.push(tag + '：.wb-modal 内容盒高度 ' + modalHeight + 'px（box-sizing=' + m.modal.style.boxSizing
        + '，rect.height=' + m.modal.rect.height + '）> min(88vh,900px)=' + round1(limit) + 'px')
    }
    if (m.modal.rect.top < -1 || m.modal.rect.bottom > m.viewport.h + 1) {
      problems.push(tag + '：.wb-modal 纵向出界 top=' + m.modal.rect.top + ' bottom=' + m.modal.rect.bottom + '（视口高 ' + m.viewport.h + '）')
    }
    const sb = m.startButton
    if (sb === null) {
      problems.push(tag + '：弹窗里找不到「开始」按钮')
    } else {
      if (sb.fullyVisible !== true) {
        problems.push(tag + '：「开始」按钮不在可视区内 rect=' + JSON.stringify(sb.rect) + '（视口高 ' + m.viewport.h + '）')
      } else if (sb.hit !== 'self') {
        problems.push(tag + '：「开始」按钮可见但 hit-test 命中的是 ' + sb.hit)
      }
      if (sb.clippedBy.length > 0) {
        problems.push(tag + '：「开始」按钮被祖先裁剪 ' + JSON.stringify(sb.clippedBy))
      }
    }
    if (m.modal.overflow.contentOverflow && m.modal.overflow.scrollable !== true) {
      problems.push(tag + '：内容溢出（scrollHeight ' + m.modal.scrollHeight + ' > clientHeight ' + m.modal.clientHeight + '）但不可滚（overflow-y=' + m.modal.style.overflowY + '）')
    }
    if (m.actions !== null && m.actions.style.position !== 'sticky') {
      notes.push(tag + '：.wb-modal-actions 的 position=' + m.actions.style.position + '（期望 sticky，但不作为几何判定条件）')
    }
  }
  return { verdict: problems.length === 0 ? 'FIXED' : 'BUG_REPRODUCED', problems, notes }
}

// ── 主流程 ────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true })
const evidence = {
  issue: 17,
  phase: PHASE,
  expected: EXPECTED,
  generatedAt: new Date().toISOString(),
  target: redact(TARGET_URL),
  sizes: SIZES,
  browserPath: '',
  buildId: null,
  steps: {},
  viewports: [],
  mutationCss: PHASE === 'after' ? null : MUTATION_CSS,
  verdict: null,
  problems: [],
  notes: [],
  screenshots: [],
}

const found = discoverBrowser({})
if (!found.ok) {
  console.error('[FATAL] ' + found.reason)
  process.exit(2)
}
evidence.browserPath = found.path

let browser = null
let exitCode = 2
try {
  browser = await launchDebugBrowser({ browserPath: found.path, headless: true, callTimeoutMs: 30000 })
  const cdp = browser.cdp

  /** 强制不吃缓存（新 bundle 才有修复）：禁缓存 + ignoreCache 重载。 */
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await browser.goto(TARGET_URL)
  await sleep(2500)
  await cdp.send('Page.reload', { ignoreCache: true })
  await sleep(3500)

  evidence.steps.loaded = await browser.evaluate(`
    return {
      title: document.title,
      href: location.href.replace(/token=[^&]+/, 'token=***'),
      buildId: window.__WORKBENCH_BUILD_ID__ ?? null,
      panelHost: document.querySelector('.wb-panel-host') !== null,
    };
  `)
  evidence.buildId = evidence.steps.loaded.buildId

  // ── 打开工作台面板（真实点击；clickByText 自带 scrollIntoView + 命中验证） ──
  const openPanel = async () => {
    const state = await browser.evaluate(`
      const host = document.querySelector('.wb-panel-host');
      return host === null ? null : host.getAttribute('data-open');
    `)
    if (state === '1') return 'already-open'
    const click = await browser.clickByText('打开工作台', 'button')
    if (click === null) throw new Error('侧栏找不到「打开工作台」入口按钮')
    await browser.waitFor(`
      const host = document.querySelector('.wb-panel-host');
      return host !== null && host.getAttribute('data-open') === '1';
    `, { timeoutMs: 15000, description: '工作台面板打开' })
    return 'clicked:' + (click.clickChannel ?? 'unknown')
  }
  evidence.steps.panel = await openPanel()

  // ── 确保任务列表有行（必要时切到「任务」页签） ──
  const rowCount = () => browser.evaluate(`
    return document.querySelectorAll('.wb-nav .wb-row').length;
  `)
  if ((await rowCount()) === 0) {
    const tab = await browser.clickByText('任务', '.wb-segmented button')
    if (tab === null) throw new Error('顶部分段里找不到「任务」页签')
    await browser.waitFor('return document.querySelectorAll(".wb-nav .wb-row").length > 0;', { timeoutMs: 15000, description: '任务行渲染' })
  }
  const picked = await browser.evaluate(`
    const rows = Array.from(document.querySelectorAll('.wb-nav .wb-row'));
    const idx = Math.max(0, rows.findIndex((r) => (r.textContent || '').includes('测试任务1')));
    const row = rows[idx];
    if (row === undefined) return null;
    row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect();
    return { index: idx, x: Math.round(r.left + Math.min(48, r.width / 2)), y: Math.round(r.top + r.height / 2), text: (row.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60), rows: rows.length };
  `)
  if (picked === null) throw new Error('.wb-nav 里没有任何任务行')
  await sleep(150)
  const rowClick = await browser.clickAt(picked.x, picked.y)
  evidence.steps.pickTask = Object.assign({}, picked, { clickChannel: rowClick.clickChannel })
  await browser.waitFor(`
    const btns = Array.from(document.querySelectorAll('.wb-detail button'));
    return btns.some((b) => (b.textContent || '').includes('AI 执行') || (b.textContent || '').includes('AI 协助'));
  `, { timeoutMs: 15000, description: '详情面板出现 AI 按钮' })

  /** 选一个**可用**的 AI 入口：优先「AI 执行」（issue 原文路径），退而用同一个弹窗的「AI 协助」。 */
  const entryInfo = await browser.evaluate(`
    const btns = Array.from(document.querySelectorAll('.wb-detail button'));
    const pick = (label) => btns.find((b) => (b.textContent || '').includes(label) && b.disabled !== true) ?? null;
    const chosen = pick('AI 执行') ?? pick('AI 协助') ?? pick('AI 拆解');
    if (chosen === null) {
      return { ok: false, seen: btns.map((b) => ({ t: (b.textContent || '').trim().slice(0, 20), disabled: b.disabled === true })).slice(0, 20) };
    }
    chosen.scrollIntoView({ block: 'center' });
    const r = chosen.getBoundingClientRect();
    return { ok: true, label: (chosen.textContent || '').trim().slice(0, 20), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `)
  if (entryInfo.ok !== true) throw new Error('详情面板里没有可用的 AI 入口按钮：' + JSON.stringify(entryInfo.seen))
  await sleep(150)

  // ── 变异探针：在当前页面注入覆盖样式，把修复摘掉（相位 after 不注入） ──
  if (PHASE !== 'after') {
    const injectScript = [
      'const old = document.getElementById("__issue17_mutation");',
      'if (old !== null) old.remove();',
      'const style = document.createElement("style");',
      'style.id = "__issue17_mutation";',
      'style.textContent = ' + JSON.stringify(MUTATION_CSS) + ';',
      'document.head.appendChild(style);',
      'return style.isConnected === true;',
    ].join('\n')
    const injected = await browser.evaluate(injectScript)
    if (injected !== true) throw new Error('变异样式注入失败')
    evidence.steps.mutationInjected = true
  }

  /** 点入口打开弹窗（真实鼠标事件；clickAt 内部会验证事件真的到达页面）。 */
  const openModal = async (target) => {
    const box = await browser.evaluate(`
      const btns = Array.from(document.querySelectorAll('.wb-detail button'));
      const hit = btns.find((b) => (b.textContent || '').trim() === ` + JSON.stringify(target.label) + `);
      if (hit === undefined) return null;
      hit.scrollIntoView({ block: 'center' });
      const r = hit.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `)
    if (box === null) throw new Error('点开弹窗时找不到入口按钮：' + target.label)
    const click = await browser.clickAt(box.x, box.y)
    await browser.waitFor('return document.querySelector(".wb-modal") !== null;', { timeoutMs: 15000, description: '提示词弹窗出现' })
    await sleep(400)
    return click.clickChannel ?? 'unknown'
  }
  evidence.steps.modalEntry = { label: entryInfo.label, clickChannel: await openModal(entryInfo) }
  // 弹窗内容（角色列表 / 19 项技能 / 模型选择）是异步加载的，等它稳定再量。
  await sleep(1500)

  // ── 变异探针自检：确认覆盖样式**真的生效**，否则"没复现"只是没注入成功 ──
  if (PHASE !== 'after') {
    const effective = await browser.evaluate(`
      const m = document.querySelector('.wb-modal');
      const a = document.querySelector('.wb-modal-actions');
      const cs = getComputedStyle(m);
      const as = a === null ? null : getComputedStyle(a);
      return { maxHeight: cs.maxHeight, overflowY: cs.overflowY, actionsPosition: as === null ? null : as.position };
    `)
    evidence.steps.mutationEffective = effective
    if (effective.maxHeight !== 'none' || effective.overflowY !== 'visible' || effective.actionsPosition !== 'static') {
      throw new Error('变异样式没有生效（期望 max-height:none / overflow-y:visible / actions position:static）：' + JSON.stringify(effective))
    }
  }

  // ── 逐视口测量 ──
  for (const size of SIZES) {
    const label = size.width + 'x' + size.height
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
    })
    await sleep(700)
    const reset = await browser.evaluate(`
      const m = document.querySelector('.wb-modal');
      if (m === null) return null;
      m.scrollTop = 0;
      return m.scrollTop;
    `)
    await sleep(250)
    const initial = await browser.evaluate(MEASURE)
    const file = join(OUT, 'modal-' + label + '.png')
    await browser.screenshot(file)
    evidence.screenshots.push(file)

    /** 滚到底再量一次：sticky 的操作栏应当仍在视口内（这是"常驻"的直接证据）。 */
    const scrolledTo = await browser.evaluate(`
      const m = document.querySelector('.wb-modal');
      if (m === null) return null;
      m.scrollTop = m.scrollHeight;
      return { scrollTop: m.scrollTop, max: m.scrollHeight - m.clientHeight };
    `)
    await sleep(300)
    const bottom = await browser.evaluate(MEASURE)
    const fileBottom = join(OUT, 'modal-' + label + '-scrolled.png')
    await browser.screenshot(fileBottom)
    evidence.screenshots.push(fileBottom)

    evidence.viewports.push({ label: label, viewport: { w: size.width, h: size.height }, scrollReset: reset, scrolledTo: scrolledTo, initial: initial, scrolled: bottom })
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
    await sleep(200)
  }

  const judged = judge(evidence.viewports)
  evidence.verdict = judged.verdict
  evidence.problems = judged.problems
  evidence.notes = judged.notes
  evidence.matched = judged.verdict === EXPECTED
  exitCode = evidence.matched ? 0 : 1
} catch (error) {
  evidence.fatal = error instanceof Error ? error.message : String(error)
  evidence.verdict = 'ERROR'
  exitCode = 2
} finally {
  try { await browser?.close() } catch { /* 尽力清理 */ }
}

writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8')

// ── 控制台报告 ────────────────────────────────────────────────────────────
const r1 = (n) => (typeof n === 'number' ? String(Math.round(n * 10) / 10) : String(n))
console.log('phase=' + PHASE + '  expected=' + EXPECTED)
console.log('buildId=' + String(evidence.buildId) + '  entry=' + JSON.stringify(evidence.steps.modalEntry ?? null))
if (evidence.steps.mutationEffective !== undefined) {
  console.log('mutation-effective=' + JSON.stringify(evidence.steps.mutationEffective))
}
if (evidence.steps.pickTask !== undefined) {
  console.log('task=' + JSON.stringify({ text: evidence.steps.pickTask.text, index: evidence.steps.pickTask.index, click: evidence.steps.pickTask.clickChannel }))
}
console.log('panel=' + String(evidence.steps.panel))
for (const vp of evidence.viewports) {
  const m = vp.initial
  console.log('--- ' + vp.label + ' ---')
  console.log('  innerHeight=' + m.viewport.h + ' modal.top=' + r1(m.modal.rect.top) + ' modal.height=' + r1(m.modal.rect.height)
    + ' bottom=' + r1(m.modal.rect.bottom) + ' scrollHeight=' + m.modal.scrollHeight + ' clientHeight=' + m.modal.clientHeight)
  console.log('  modal.contentHeight=' + r1(m.modal.contentHeight) + ' boxSizing=' + m.modal.style.boxSizing
    + ' limit(min(88vh,900))=' + r1(Math.min(0.88 * m.viewport.h, 900)))
  console.log('  style maxHeight=' + m.modal.style.maxHeight + ' overflowY=' + m.modal.style.overflowY + ' overscroll=' + m.modal.style.overscrollBehavior
    + ' scrollable=' + m.modal.overflow.scrollable)
  console.log('  actions.position=' + (m.actions === null ? 'n/a' : m.actions.style.position) + ' bottom=' + (m.actions === null ? 'n/a' : m.actions.style.bottom)
    + ' rect.top=' + (m.actions === null ? 'n/a' : r1(m.actions.rect.top)) + ' rect.bottom=' + (m.actions === null ? 'n/a' : r1(m.actions.rect.bottom)))
  console.log('  startButton fullyVisible=' + (m.startButton === null ? 'n/a' : m.startButton.fullyVisible)
    + ' hit=' + (m.startButton === null ? 'n/a' : m.startButton.hit)
    + ' reachable=' + (m.startButton === null ? 'n/a' : m.startButton.reachable)
    + ' rect=' + (m.startButton === null ? 'n/a' : JSON.stringify(m.startButton.rect)))
  if (vp.scrolled !== null && vp.scrolled !== undefined) {
    const s = vp.scrolled
    console.log('  [scrolled-to-bottom] modal.scrollTop=' + r1(s.modal.scrollTop) + ' startButton.fullyVisible='
      + (s.startButton === null ? 'n/a' : s.startButton.fullyVisible) + ' hit=' + (s.startButton === null ? 'n/a' : s.startButton.hit))
  }
}
if (evidence.fatal !== undefined) console.log('FATAL: ' + evidence.fatal)
for (const p of evidence.problems) console.log('  PROBLEM: ' + p)
for (const n of evidence.notes) console.log('  NOTE: ' + n)
console.log('screenshots:')
for (const f of evidence.screenshots) console.log('  ' + f)
console.log('evidence.json: ' + join(OUT, 'evidence.json'))
console.log('VERDICT: ' + evidence.verdict)
console.log(evidence.verdict === EXPECTED
  ? 'EXPECTATION MET (' + PHASE + ' 期望 ' + EXPECTED + ')'
  : 'EXPECTATION MISSED (' + PHASE + ' 期望 ' + EXPECTED + '，实际 ' + evidence.verdict + ')')
process.exit(exitCode)
