/**
 * 白名单套件的**共享脚手架**（plan.md V05 / requirements.md §7.3 / AX-V01 的"不许静默丢件"）。
 *
 * ## 为什么要有它
 *
 * 四套历史回归 + 四套新增套件都是"进链、独立子进程、最后一行吐 JSON 汇总"的形态
 * （契约见 `scripts/verify/runtime.mjs#runSuiteProcess`）。如果每套各写一份 argv 解析、
 * 各写一份 `process.exit`，迟早会出现三件事：
 *
 * 1. **某套的失败被 `finally` 吞成 0** —— 历史脚本真的这么干过（`verify-final-2.mjs` 的
 *    `check()` 形参错位导致恒过；`verify-acceptance.mjs` 的同步 `process.exit` 把挂死
 *    伪装成"提前通过"）。
 * 2. **某套条件少测还报满数** —— `verify-sidebar-collapse.mjs` 找不到按钮时直接跳过 check。
 *    本脚手架里 `skipped > 0` 对必需套件**就是失败**，而且"找不到前置"一律记 fail 不记 skip。
 * 3. **空计数当通过** —— `total <= 0` 一律按失败退出。
 *
 * ## 契约（照抄给链）
 *
 * ```sh
 * node scripts/verify/suites/<id>.mjs --url <目标> --evidence-dir <本次证据目录> --user-data-root <临时浏览器目录根>
 * ```
 * - token 只在环境变量 `DSH_VERIFY_TOKEN` 里（**故意不走 argv**：argv 在进程列表里可见）。
 * - stdout 最后一行是 `{"passed":n,"failed":n,"skipped":n,"total":n}`；
 *   同一份汇总也写 `<evidence-dir>/suite-<id>.json`（链两条路都认）。
 * - 退出码：0 = 全过；1 = 有失败/异常；**绝不用 0 表示"没跑"**。
 *
 * ## 证据
 *
 * 每个套件把截图、DOM 读数、HTTP 重读结果写进 `<evidence-dir>/suite-<id>/`。
 * 写盘**不过 redact**（那是链的 `evidence.mjs` 的职责）—— 所以这里**绝不**把 token
 * 写进任何文件：`api()` 只在内存里带它，落盘的一律是脱敏后的形状。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_WAIT_MS = 20000

// ── argv / env ──────────────────────────────────────────────────────────────

export function parseSuiteArgs(argv = process.argv.slice(2)) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--url') options.url = argv[++index]
    else if (arg === '--evidence-dir') options.evidenceDir = argv[++index]
    else if (arg === '--user-data-root') options.userDataRoot = argv[++index]
    else if (arg === '--browser') options.browser = argv[++index]
    /**
     * `--profile-dir` / `--db-path` / `--profile`：链**不传**它们（套件契约只有 url/evidence/user-data-root），
     * 但"安全复核"类套件需要知道"目标到底被声明成什么"，所以支持手动传。
     *
     * ⚠️ 这里**必须**把两件事分开，不能都从环境变量取（T6 第一次跑实测踩到）：
     * - `profile` / `profileDir` = **当前会话所在实例**（自锁判据的"我自己是谁"），来自环境变量；
     * - `targetProfile` / `targetProfileDir` / `dbPath` = **要被验收的那个实例**，来自显式参数。
     *
     * 混用会得到一条很能骗人的假红：子进程里 `DSH_PROFILE_DIR` 是**目标**的目录，
     * 于是预检看到"当前 profile 目录 == 目标 profile 目录"而正确地拒绝，
     * 看上去像"链坏了"，实际是套件把当前当成了目标。
     */
    else if (arg === '--profile-dir') options.profileDir = argv[++index]
    else if (arg === '--db-path') options.dbPath = argv[++index]
    else if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--target-profile') options.targetProfile = argv[++index]
    else if (arg === '--target-profile-dir') options.targetProfileDir = argv[++index]
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++index])
    else if (arg.startsWith('--')) options.bad = `未知参数：${arg}`
  }
  options.token = process.env.DSH_VERIFY_TOKEN ?? ''
  options.profile = options.profile ?? process.env.DSH_PROFILE ?? 'web'
  options.profileDir = options.profileDir ?? process.env.DSH_PROFILE_DIR ?? ''
  options.dbPath = options.dbPath ?? process.env.WORKBENCH_EXPECTED_DB_PATH ?? ''
  /** 目标默认 = 预授权范围（ADR0006：3080 / web）——**绝不从 DSH_PROFILE 继承**。 */
  options.targetProfile = options.targetProfile ?? 'web'
  options.targetProfileDir = options.targetProfileDir ?? ''
  return options
}

/** 目标 URL 的 origin（API 基址）。套件一律只打这个 origin，不做任何跨机请求。 */
export function originOf(url) {
  return new URL(url).origin
}

/**
 * **幂等**地确保工作台面板已打开（2026-10-01）。
 *
 * ## 为什么必须有它（真实假红，两次）
 *
 * 侧栏那个入口是**开关**：面板开着时点一下是**关**。而多个套件原来都写成
 * "点一次入口 → 断言 data-open=1"：
 *
 * - `legacy-acceptance` 的「点返回对话」偶发点空（第一次假红）；
 * - `progress` 紧跟别的套件跑时，面板被前一套件留在开态 → 这一下把它**关掉**，
 *   于是 `data-open=null`，后续 7 条全部因前置缺失连锁红（第二次假红）。
 *
 * 两次都表现为"单独重跑全过、整套跑偶发红"，排查成本很高。
 * 修法是让"打开"这句话在任何初始状态下都成立：先读状态，只有确实没开才点，
 * 点完等它真的开；最多两轮，仍开不了就返回状态让调用方**显式失败**（不猜）。
 *
 * @returns 最终 `data-open` 值（`'1'` = 已打开；`null` = 面板壳还没渲染）
 */
/**
 * 点一下侧栏开合按钮（**只有在"等渲染等够了还是没有入口行"时**才该调用 —— 见
 * `ensureWorkbenchPanel` 的顺序）。
 *
 * ⚠️ **踩过的坑（2026-10-02）**：先判"入口可见吗"再决定点不点，会把**首帧还没渲染**
 * 误判成"侧栏已收起"，于是**把本来展开的侧栏收起来**，之后 12s 也找不到入口 ——
 * 自作聪明的恢复反而制造了故障。所以判定顺序是"先等渲染，等不到才动开关"。
 *
 * @returns {Promise<'clicked'|'toggle-not-found'>}
 */
export async function clickSidebarToggleOnce(browser) {
  const toggle = await browser.evaluate(`
    const el = Array.from(document.querySelectorAll('button')).find((b) => {
      const a = b.getAttribute('aria-label') || '';
      return a.includes('收起侧边栏') || a.includes('展开侧边栏') || a.includes('侧边栏');
    });
    if (el === undefined) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `)
  if (toggle === null) return 'toggle-not-found'
  await browser.clickAt(toggle.x, toggle.y)
  await new Promise((resolve) => setTimeout(resolve, 700))
  return 'clicked'
}

export async function ensureWorkbenchPanel(browser, options = {}) {
  const { attempts = 3, timeoutMs = 15000, entryWaitMs = 12000 } = options
  const readOpen = () => browser.evaluate(
    `const h = document.querySelector('.wb-panel-host'); return h === null ? null : h.getAttribute('data-open');`,
  )
  const entryVisible = () => browser.evaluate(`
    const hit = Array.from(document.querySelectorAll('button'))
      .find((n) => (n.textContent || '').includes('工作台') && n.offsetParent !== null);
    return hit === undefined ? false : true;
  `)
  /** 等入口行渲染出来（冷启动首帧要一会儿；旧实现只试一次就返回，报错方向完全指错）。 */
  const waitEntry = async (ms) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if ((await entryVisible()) === true) return true
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return false
  }
  for (let round = 0; round < attempts; round += 1) {
    if ((await readOpen()) === '1') return '1'
    if ((await waitEntry(entryWaitMs)) !== true) {
      // 等够了还是没有 ⇒ 才认定侧栏被收起了（收起的侧栏里宿主不渲染入口行），点开合按钮
      await clickSidebarToggleOnce(browser)
      if ((await waitEntry(5000)) !== true) continue
    }
    const entry = await browser.clickByText('工作台', 'button')
    if (entry === null) continue
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await readOpen()) === '1') return '1'
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  return await readOpen()
}

// ── 结果记录 ────────────────────────────────────────────────────────────────

export const CHECK_LAYERS = new Set(['U', 'H', 'W', 'B', 'N'])

/**
 * 建一个套件结果收集器。
 *
 * @param {{ id: string, title?: string, evidenceDir?: string, url?: string, legacyIds?: string[] }} options
 */
export function createSuite(options) {
  const { id } = options
  const dir = options.evidenceDir === undefined ? undefined : join(options.evidenceDir, `suite-${id}`)
  if (dir !== undefined) mkdirSync(dir, { recursive: true })
  const checks = []
  const notes = []
  let fatal

  const push = (entry) => {
    checks.push(entry)
    const icon = entry.status === 'pass' ? '✅' : entry.status === 'skip' ? '⏭' : '❌'
    const label = entry.legacyId ?? entry.axId ?? entry.id
    console.log(`${icon} ${label}${entry.detail === undefined ? '' : ` — ${entry.detail}`}`)
    return entry
  }

  const suite = {
    id,
    title: options.title ?? id,
    url: options.url,
    dir,
    legacyIds: options.legacyIds ?? [],
    axIds: options.axIds ?? options.legacyIds ?? [],
    get checks() { return [...checks] },
    get fatal() { return fatal },
    get failed() { return checks.filter((entry) => entry.status === 'fail') },
    get passed() { return checks.filter((entry) => entry.status === 'pass') },
    get skipped() { return checks.filter((entry) => entry.status === 'skip') },

    /**
     * 记一条断言。**`ok === true` 才算通过**：`undefined` / 抛出来的异常都不是通过。
     *
     * @param {{ id: string, legacyId?: string, axId?: string, layer?: string, ok: boolean, detail?: unknown,
     *           skipped?: boolean, skipReason?: string }} entry
     */
    check(entry) {
      const detail = entry.detail === undefined ? undefined : (typeof entry.detail === 'string' ? entry.detail : safeJson(entry.detail))
      if (entry.skipped === true) return push({ ...entry, status: 'skip', detail: entry.skipReason ?? detail })
      return push({ ...entry, status: entry.ok === true ? 'pass' : 'fail', detail })
    },

    /** 前置缺失 → **fail**（不是 skip）。历史脚本在这里条件少测，是本轮明确要修掉的形态。 */
    require(entry) {
      return suite.check({ ...entry, ok: false, detail: `${entry.detail ?? ''}${entry.detail === undefined ? '' : '；'}前置缺失一律记失败（不许条件少测）`.trim() })
    },

    note(text) {
      notes.push(String(text))
      console.log(`   · ${text}`)
    },

    /** 脚本级故障。**必须**让退出码为 1（AX-V09「finally 不吞失败」）。 */
    fatalError(error) {
      fatal = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
      console.error(`\n❌ 套件 ${id} 中断：${String(fatal).split('\n')[0]}`)
      return fatal
    },

    /** 写一个证据文件（截图之外的文本/JSON）。一律不带 token。 */
    writeEvidence(name, content) {
      if (dir === undefined) return undefined
      const path = join(dir, name)
      writeFileSync(path, typeof content === 'string' ? content : `${safeJson(content)}\n`, 'utf8')
      return path
    },

    counts() {
      const passed = suite.passed.length
      const failed = suite.failed.length
      const skipped = suite.skipped.length
      /**
       * `skippedChecks` / `failedChecks` 带上**条目 id**：链要判"这条跳过是不是登记过的"
       *（2026-10-02 加）。只给计数的话，链只能"必需套件有任何跳过就判失败" ——
       * 而 persona 那条"真实模型调用"按规格就该跳过，于是链**永远红**，
       * 真正的红反而被淹没在"又一次这条"里。
       */
      return {
        passed,
        failed,
        skipped,
        total: checks.length,
        skippedChecks: suite.skipped.map((entry) => entry.id),
        failedChecks: suite.failed.map((entry) => entry.id),
      }
    },

    /**
     * 收尾：写 `suite-<id>.json`、打印最后一行汇总、**显式设定退出码后返回它**。
     *
     * 为什么返回退出码而不是在这里 `process.exit`：调用方可能还要跑 `finally` 清理。
     * 调用方必须 `process.exit(code)` —— 这是链读到的唯一判据之一。
     */
    finish(extra = {}) {
      const counts = suite.counts()
      const failed = counts.failed > 0 || fatal !== undefined
      const exitCode = failed ? 1 : 0
      const payload = {
        suite: id,
        title: suite.title,
        url: suite.url,
        legacyIds: suite.legacyIds,
        exitCode,
        fatal: fatal === undefined ? null : String(fatal).split('\n')[0],
        counts,
        checks: checks.map((entry) => ({
          id: entry.id,
          legacyId: entry.legacyId ?? null,
          axId: entry.axId ?? null,
          layer: entry.layer ?? null,
          status: entry.status,
          detail: entry.detail ?? null,
        })),
        notes,
        ...extra,
      }
      suite.writeEvidence(`../suite-${id}.json`, payload)
      // 汇总也留在自己目录里一份（便于单套重跑时直接看）
      suite.writeEvidence('summary.json', payload)
      console.log(`\n=== 套件 ${id}：${counts.passed}/${counts.total} 通过（failed ${counts.failed} / skipped ${counts.skipped}）===`)
      for (const entry of suite.failed) console.log(`  ❌ ${entry.id}`)
      console.log(safeJson(counts))
      return exitCode
    },
  }
  return suite
}

export function safeJson(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

// ── 目标实例 HTTP（只读 + 合成写入都走这里）────────────────────────────────

/**
 * 建一个 API 客户端。
 *
 * token 走 `Authorization: Bearer` —— 与浏览器带 token 的 URL 等价（DSH 的 loopback
 * 信任围栏在 `isLoopbackRequest` 里，token 只是给 WebSocket/页面用的）。
 * **绝不**把 token 拼进任何写盘内容。
 */
export function createApi(url, { token = '' } = {}) {
  const base = originOf(url)
  const headers = token === '' ? {} : { authorization: `Bearer ${token}` }
  const request = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) },
    })
    const text = await response.text()
    let body
    try { body = text === '' ? null : JSON.parse(text) } catch { body = text }
    return { status: response.status, ok: response.ok, body }
  }
  return {
    base,
    request,
    get: (path) => request(path, { method: 'GET' }),
    post: (path, body) => request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
    patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
    put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) }),
    del: (path) => request(path, { method: 'DELETE' }),
    /** 带 token 的页面 URL（只给浏览器用，**不许**写进证据）。 */
    pageUrl: () => (token === '' ? `${base}/` : `${base}/?token=${encodeURIComponent(token)}`),
  }
}

export async function waitFor(check, { timeoutMs = DEFAULT_WAIT_MS, intervalMs = 300, description = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last
    await new Promise((done) => setTimeout(done, intervalMs))
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${description}`)
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ── 合成测试资产（runId 前缀 + 只清自己造的那些）────────────────────────────

/**
 * 合成资产管理器（requirements §7.3 "所有写入场景使用可销毁测试DB和带runId的合成任务"）。
 *
 * 两条纪律：
 * 1. 每个合成对象都带 `runId` 前缀，**绝不**按标题/内容批量匹配别人的数据；
 * 2. 清理只处理登记过的 id，失败不许吞（D11 的"失败不能吞掉原失败"）。
 */
export function createSyntheticAssets(api, runId) {
  const tasks = []
  const drafts = []
  const plans = []
  const marker = `【回归·临时·${runId}】`
  return {
    runId,
    marker,
    title: (suffix) => `${marker}${suffix}`,
    track: {
      task: (task) => { if (task?.id !== undefined) tasks.push(task.id); return task },
      draft: (draft) => { if (draft?.id !== undefined) drafts.push(draft.id); return draft },
      plan: (date) => { plans.push(date); return date },
    },
    get taskIds() { return [...tasks] },
    get draftIds() { return [...drafts] },
    async createTask(body) {
      const response = await api.post('/api/workbench/tasks', body)
      if (response.status !== 201 && response.status !== 200) throw new Error(`建任务失败：HTTP ${response.status} ${safeJson(response.body)}`)
      return this.track.task(response.body.task)
    },
    async cleanup() {
      const problems = []
      for (const id of tasks) {
        try {
          const response = await api.post(`/api/workbench/tasks/${id}/archive`)
          if (response.status !== 200) problems.push(`归档任务 ${id} 返回 ${response.status}`)
        } catch (error) { problems.push(`归档任务 ${id} 抛错：${error instanceof Error ? error.message : String(error)}`) }
      }
      for (const id of drafts) {
        try {
          const response = await api.post(`/api/workbench/drafts/${id}/abandon`)
          if (response.status !== 200 && response.status !== 404) problems.push(`放弃草稿 ${id} 返回 ${response.status}`)
        } catch (error) { problems.push(`放弃草稿 ${id} 抛错：${error instanceof Error ? error.message : String(error)}`) }
      }
      return problems
    },
  }
}

// ── 浏览器 ──────────────────────────────────────────────────────────────────

/**
 * 起一个独立调试浏览器（`scripts/verify/cdp.mjs`）。
 *
 * **本次实现里 T6 用它做真实鼠标点击 + 截图 + DOM 重读**（AX-V10 / AX-P07 等 B 层判据）。
 * headless 由 `--headless` 参数或 `DSH_VERIFY_HEADLESS=1` 决定；链里默认**有头**，
 * 因为"用户看到什么"是判据的一部分，而截图两者都有。
 */
export async function launchSuiteBrowser(options) {
  const { url, token = '', userDataRoot, browserPath } = options
  const cdp = await import('../cdp.mjs')
  const browser = await cdp.launchDebugBrowser({
    browserPath,
    port: options.port,
    headless: options.headless ?? process.env.DSH_VERIFY_HEADLESS === '1',
    appUrl: token === '' ? `${originOf(url)}/` : `${originOf(url)}/?token=${encodeURIComponent(token)}`,
    tmpRoot: userDataRoot,
    callTimeoutMs: options.callTimeoutMs ?? 30000,
  })
  return browser
}

// ── 仓库内路径 / 包版本 ─────────────────────────────────────────────────────

export function repoRootFromSuite() {
  // scripts/verify/suites/<file>.mjs → 仓库根
  return fileURLToPath(new URL('../../../', import.meta.url))
}

export function readPackageVersion(root = repoRootFromSuite()) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? 'unknown' } catch { return 'unknown' }
}

export function readBuiltBuildId(root = repoRootFromSuite()) {
  try {
    const info = JSON.parse(readFileSync(join(root, 'lib', 'build-info.json'), 'utf8'))
    return typeof info.buildId === 'string' && info.buildId !== '' ? info.buildId : 'unknown'
  } catch { return 'unknown' }
}

export function removeDirWithRetry(path, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { rmSync(path, { recursive: true, force: true }); return true } catch { /* 被占着就再试 */ }
  }
  return false
}

export function pathExists(path) {
  return existsSync(path)
}

// ── 入口包装 ────────────────────────────────────────────────────────────────

/**
 * 跑一个套件主体：**任何**异常都必须变成退出码 1，绝不静默。
 *
 * 用法：
 * ```js
 * const { suite, options } = startSuite({ id: 'legacy-acceptance', legacyIds: [...] })
 * try { ... } catch (error) { suite.fatalError(error) } finally { await cleanup(); process.exit(suite.finish()) }
 * ```
 */
export function startSuite({ id, title, url, evidenceDir, legacyIds, axIds }) {
  return createSuite({ id, title, evidenceDir, url, legacyIds, axIds })
}
