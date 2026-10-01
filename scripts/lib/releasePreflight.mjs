/**
 * 发布前门禁的**判定逻辑**（纯函数，无 I/O）—— 供 `scripts/release-preflight.mjs` 与
 * `test/releasePreflight.test.mjs` 共用。
 *
 * ## 为什么要独立成模块
 *
 * 发布门禁本身必须**可被测试**：如果判定逻辑只活在 CLI 的 `if` 里，那"门禁真的会红吗"
 * 就只能靠手工试（本项目已经吃过"探针看起来全绿、其实一条都没拦住"的亏，见
 * `docs/issues/2026-10-01-mutation-probe-maintenance.md`）。
 * 这里每个函数只吃**已经拿到的文本/数字**，吐判定结果 —— 测试可以喂真实输出样本。
 *
 * ## 一条贯穿全部的设计：欠账必须**显式登记**，不许静默放过
 *
 * 仓库里有三类"已知但不阻塞发布"的欠账（历史测试失败、探针盲点、良性 PII 命中）。
 * 处理方式统一为**显式名单 + 双向断言**：
 *
 * - 名单外的红 → **失败**（不许新欠账偷偷进来）；
 * - 名单里已经不再红的项 → **也失败**（欠账还清了必须把名单删掉，否则名单会腐烂成
 *   "反正都列着"的橡皮图章）。
 *
 * 判定结果统一形状：`{ ok, failures, debts, notes }`
 * - `failures`：阻塞发布（每条一句话，带证据）
 * - `debts`：允许放过但要显眼提示的欠账
 * - `notes`：需要人跟进但不阻塞
 */

/** @returns {{ok: boolean, failures: string[], debts: string[], notes: string[]}} */
function emptyVerdict() {
  return { ok: true, failures: [], debts: [], notes: [] }
}

/**
 * @param {string[]} items
 * @returns {string[]}
 */
export function dedupe(items) {
  return [...new Set(items)]
}

// ───────────────────────────────────────────────────────────────────────────
// 1) 单测结果
// ───────────────────────────────────────────────────────────────────────────

/**
 * 解析 `node --test` 的汇总输出。
 *
 * 形如：
 * ```
 * ℹ tests 929
 * ℹ pass 928
 * ℹ fail 1
 * ✖ failing tests:
 * ✖ db migrations, dictionaries and task tree (880.07ms)
 * ```
 * @param {string} stdout
 * @returns {{tests: number, pass: number, fail: number, failing: string[]}}
 */
export function parseTestSummary(stdout) {
  const line = (label) => {
    const m = new RegExp(`^\\s*ℹ ${label} (\\d+)\\s*$`, 'm').exec(stdout)
    return m === null ? 0 : Number(m[1])
  }
  /** @type {string[]} */
  const failing = []
  const at = stdout.indexOf('failing tests:')
  if (at >= 0) {
    for (const raw of stdout.slice(at).split(/\r?\n/).slice(1)) {
      // 失败块里的用例行：`✖ <name> (12.3ms)`；遇到下一个汇总行或空行就停
      const m = /^\s*✖\s+(.+?)\s*(?:\(\d+(?:\.\d+)?ms\))?\s*$/.exec(raw)
      if (m !== null) failing.push(m[1].trim())
      else if (failing.length > 0 && (/^\s*ℹ /.test(raw) || /^\s*$/.test(raw))) break
    }
  }
  return { tests: line('tests'), pass: line('pass'), fail: line('fail'), failing: dedupe(failing) }
}

/**
 * 判单测。`allowed` 是**显式登记**的已知失败（用例名必须**完全相等**，不做模糊匹配 ——
 * 模糊匹配会随时间悄悄放宽范围）。
 *
 * @param {{tests: number, pass: number, fail: number, failing: string[]}} summary
 * @param {Array<{test: string, reason: string}>} allowed
 */
export function judgeTests(summary, allowed) {
  const v = emptyVerdict()
  const allowedNames = new Set(allowed.map((a) => a.test))
  if (summary.tests === 0) {
    v.ok = false
    v.failures.push('没解析到任何用例（输出格式变了？）—— 门禁不能把"读不到"当成"通过"')
    return v
  }
  for (const name of summary.failing) {
    if (allowedNames.has(name)) {
      const reason = allowed.find((a) => a.test === name)?.reason ?? ''
      v.debts.push(`已知失败（登记在案）：${name} —— ${reason}`)
    } else {
      v.ok = false
      v.failures.push(`单测失败：${name}`)
    }
  }
  // 一致性：fail 数与解析出的失败用例名应当吻合（防止解析漏名而"看起来没问题"）
  if (summary.fail !== summary.failing.length) {
    v.ok = false
    v.failures.push(`汇总说 fail=${summary.fail}，但只解析出 ${summary.failing.length} 个失败用例名 —— 解析结果不可信`)
  }
  for (const a of allowed) {
    if (!summary.failing.includes(a.test)) {
      v.ok = false
      v.failures.push(`登记为"已知失败"的用例这次是绿的：${a.test} —— 还清了就要把名单删掉，别让名单腐烂`)
    }
  }
  return v
}

// ───────────────────────────────────────────────────────────────────────────
// 2) 变异探针
// ───────────────────────────────────────────────────────────────────────────

/**
 * 解析单个探针的输出。**仓库里同时存在两种汇总约定**（2026-10-02 实测摸清）：
 *
 * | 约定 | 成功行 | 用在 |
 * |---|---|---|
 * | A | `✅ 46/46 条变异都被断言抓到（还原后仍全绿）` | knowledge-recall / knowledge-draft / model-picker / quick-workspace |
 * | B | `变异探针：17/17 条变异都变红` | capacity / listview |
 *
 * 另有三种形态**都不算通过**：
 * - `❌ 3/10 条变异没有被断言发现` → 有存活（门禁在工作，但判据有洞）
 * - `找不到替换片段（探针失效，需更新）` → 探针**本身**失效
 * - `基线就没过 —— 先修好单测再跑反向验证` → 结果**不可信**
 *
 * ⚠️ 认不出的格式一律按不通过处理：门禁宁可误报，也不许把"读不懂"当"没问题"。
 *
 * @param {{id: string, exitCode: number, stdout: string}} result
 */
export function parseProbeResult(result) {
  const out = result.stdout
  const allA = /✅\s*(\d+)\/(\d+)\s*条变异都被断言抓到/.exec(out)
  const allB = /变异探针：\s*(\d+)\/(\d+)\s*条变异都变红/.exec(out)
  const bad = /❌\s*(\d+)\/(\d+)\s*条变异没有被断言发现/.exec(out)
  const stale = /找不到替换片段|探针失效/.test(out)
  const unreliable = /基线就没过|基线.*没过/.test(out)

  let caught = null
  let total = null
  let survived = null
  const summarized = allA ?? allB
  if (summarized !== null) {
    caught = Number(summarized[1])
    total = Number(summarized[2])
    survived = total - caught
  } else if (bad !== null) {
    survived = Number(bad[1])
    total = Number(bad[2])
    caught = total - survived
  }

  const caughtAll = result.exitCode === 0 && summarized !== null && survived === 0 && !stale && !unreliable
  const detail = stale
    ? '探针失效（锚的源码片段已经不在了）'
    : unreliable
      ? '基线没过 ⇒ 结果不可信'
      : survived === null
        ? `无法解析探针输出（退出码 ${result.exitCode}）—— 探针换了汇总格式？门禁必须跟上`
        : `存活 ${survived} / 共 ${total}`
  return { id: result.id, caughtAll, caught, total, stale, unreliable, survived, detail }
}

/**
 * 判探针。`debt` 是**显式登记**的已知盲点（探针 id → 理由）。
 *
 * ⚠️ **"探针失效"与"基线没过"不算欠账，直接失败** —— 它们意味着这条门禁此刻根本没有在工作，
 * 而不是"发现了问题但先放过"。
 *
 * @param {Array<ReturnType<typeof parseProbeResult>>} results
 * @param {Array<{probe: string, reason: string}>} debt
 */
export function judgeProbes(results, debt) {
  const v = emptyVerdict()
  const debtIds = new Set(debt.map((d) => d.probe))
  if (results.length === 0) {
    v.ok = false
    v.failures.push('一个探针都没跑 —— 门禁不能把"没跑"当成"通过"')
    return v
  }
  for (const r of results) {
    if (r.stale || r.unreliable) {
      v.ok = false
      v.failures.push(`探针 ${r.id}：${r.detail} —— 这条门禁此刻不在工作，必须先修探针`)
      continue
    }
    if (r.caughtAll) {
      if (debtIds.has(r.id)) {
        v.ok = false
        v.failures.push(`登记为"已知盲点"的探针这次全红：${r.id} —— 盲点已消除，请从名单删掉`)
      }
      continue
    }
    if (debtIds.has(r.id)) {
      const reason = debt.find((d) => d.probe === r.id)?.reason ?? ''
      v.debts.push(`已知盲点（登记在案）：${r.id} ${r.detail} —— ${reason}`)
      continue
    }
    v.ok = false
    v.failures.push(`探针 ${r.id}：${r.detail}（新盲点，需补判据）`)
  }
  return v
}

// ───────────────────────────────────────────────────────────────────────────
// 3) PII 扫描
// ───────────────────────────────────────────────────────────────────────────

/**
 * 解析 `scripts/check-pii.mjs` 的输出，取出**命中了哪些规则**。
 *
 * 为什么按"规则集合"而不是"命中条数"做基线：条数会随正常内容变动
 *（新增 skill 里提了两句凭据文件名，`凭据文件名引用` 就从 3 变成 6），
 * 拿条数当基线只会逼人不断改数字；而**新冒出来的规则**才是真信号。
 *
 * @param {string} stdout
 * @returns {Array<{name: string, count: number}>}
 */
export function parsePiiRules(stdout) {
  /** @type {Array<{name: string, count: number}>} */
  const rules = []
  const re = /^\s*\[命中 (\d+)\]\s*(.+?)\s*$/gm
  let m
  while ((m = re.exec(stdout)) !== null) rules.push({ name: m[2].trim(), count: Number(m[1]) })
  return rules
}

/**
 * 判 PII。`baseline` 是逐条人工判断过的**良性规则名**。
 * 少了要提示（规则可能坏了），多了直接失败（新规则命中必须先人工判断再登记）。
 *
 * @param {Array<{name: string, count: number}>} rules
 * @param {string[]} baseline
 */
export function judgePii(rules, baseline) {
  const v = emptyVerdict()
  const seen = new Set(rules.map((r) => r.name))
  for (const r of rules) {
    if (baseline.includes(r.name)) v.debts.push(`良性命中（已逐条判断）：${r.name} ×${r.count}`)
    else v.failures.push(`新规则命中，必须逐条人工判断后再登记：${r.name} ×${r.count}`)
  }
  for (const name of baseline) {
    if (!seen.has(name)) v.notes.push(`基线里的规则这次没命中：${name}（规则可能失效，值得看一眼）`)
  }
  v.ok = v.failures.length === 0
  return v
}

// ───────────────────────────────────────────────────────────────────────────
// 4) 版本链路（发版前 vs 发布后）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 发版前：文档是否就位、版本号是否与计划一致。
 *
 * @param {{plannedVersion: string, packageVersion: string, releaseNotesExists: boolean, readmeHasVersionRow: boolean}} input
 */
export function judgePreVersion(input) {
  const v = emptyVerdict()
  if (input.packageVersion !== input.plannedVersion) {
    v.ok = false
    v.failures.push(`package.json 的 version 是 ${input.packageVersion}，与计划发布的 ${input.plannedVersion} 不一致`)
  }
  if (!input.releaseNotesExists) {
    v.ok = false
    v.failures.push(`缺少 docs/releases/v${input.plannedVersion}.md —— 文档必须排在发版动作之前（skill 第 1 条）`)
  }
  if (!input.readmeHasVersionRow) {
    v.ok = false
    v.failures.push(`README 的版本历史里没有 ${input.plannedVersion} 这一行`)
  }
  return v
}

/**
 * 发布后：**只信 tarball**（skill §7）。
 *
 * 三处证据缺一不可：dist-tags 指向它、tarball 能下载、sha1 与 registry 记录逐字节一致。
 * `versionDocStatus` 单独收进来是因为它有**误导性** —— 中间态下它返回 200，而 tarball 是 404。
 *
 * @param {{plannedVersion: string, distTagLatest: string | null, versionDocStatus: number | null, tarballStatus: number | null, sha1: string | null, expectedSha1: string | null}} input
 */
export function judgePostArtifact(input) {
  const v = emptyVerdict()
  if (input.distTagLatest !== input.plannedVersion) {
    v.ok = false
    v.failures.push(`dist-tags.latest = ${String(input.distTagLatest)}，不是 ${input.plannedVersion}`)
  }
  if (input.tarballStatus !== 200) {
    v.ok = false
    const hint = input.versionDocStatus === 200
      ? `（注意：版本文档返回 ${input.versionDocStatus} 也不算数 —— 中间态就是这样，tarball 才是判据）`
      : ''
    v.failures.push(`tarball 返回 ${String(input.tarballStatus)}，不是 200 ${hint}`)
  }
  if (input.tarballStatus === 200) {
    if (input.sha1 === null || input.expectedSha1 === null) {
      v.ok = false
      v.failures.push('拿不到本机 sha1 或 registry 的 dist.shasum，无法对账')
    } else if (input.sha1.toLowerCase() !== input.expectedSha1.toLowerCase()) {
      v.ok = false
      v.failures.push(`sha1 不一致：本机 ${input.sha1} vs registry ${input.expectedSha1} —— 产物不是同一份`)
    }
  }
  return v
}

// ───────────────────────────────────────────────────────────────────────────

/**
 * 把若干判定合并成一个总判定（失败合并、欠账并列、ok 取与）。
 *
 * @param {Array<{name: string, verdict: {ok: boolean, failures: string[], debts: string[], notes: string[]}}>} verdicts
 */
export function merge(verdicts) {
  /** @type {string[]} */
  const failures = []
  /** @type {string[]} */
  const debts = []
  /** @type {string[]} */
  const notes = []
  for (const { name, verdict } of verdicts) {
    for (const f of verdict.failures) failures.push(`[${name}] ${f}`)
    for (const d of verdict.debts) debts.push(`[${name}] ${d}`)
    for (const n of verdict.notes) notes.push(`[${name}] ${n}`)
  }
  return { ok: failures.length === 0, failures, debts, notes }
}
