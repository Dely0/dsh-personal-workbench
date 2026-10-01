#!/usr/bin/env node
/**
 * 发布门禁：**一条命令跑完所有机械判据**。
 *
 * ## 为什么要有它
 *
 * `dsh-release` skill 的门禁原来只写在文档里，靠人逐条记得 —— 2026-10-01 发 v1.16.1 时
 * **变异探针那条就被整条漏跑了**（skill 里写的路径还是过时的，照着敲根本找不到文件），
 * 补跑后才发现 3 处判据盲点。结论：**门禁要能被执行，而不是被记住**。
 *
 * ## 两个阶段
 *
 * ```sh
 * node scripts/release-preflight.mjs                 # 发版前：typecheck / 单测 / 全探针 / PII / 文档与版本号
 * node scripts/release-preflight.mjs --phase post --version 1.16.2   # 发布后：只信 tarball 的产物对账
 * ```
 *
 * ## 三条设计纪律
 *
 * 1. **欠账显式登记、双向断言**：名单外的红 → 失败；名单里已经不红的 → **也失败**
 *    （见 `scripts/lib/releasePreflight.mjs` 头部说明）。
 * 2. **探针之间必须 `pnpm build`**：探针只还原 `src/` 而**不重建 `lib/`**，
 *    连着跑会把上一个变异体的构建产物留给下一个，跑出**假红**（本次实测：单跑 0/4，
 *    `pnpm build` 后 83/83）。
 * 3. **发布复核一律直连 registry**，不用 `npm view` / `npm i` 当判据 ——
 *    它们会命中**本地 npm 缓存**，而中间态（元数据 200、tarball 404、网页显示 Published）
 *    正是靠直连才认出来的。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  judgePii, judgePostArtifact, judgePreVersion, judgeProbes, judgeTests, merge, parsePiiRules,
  parseProbeResult, parseTestSummary,
} from './lib/releasePreflight.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PKG_NAME = PKG.name

/**
 * 显式登记的**已知失败**。用例名必须完全相等。
 * 每加一条都要问自己：这是"与本次改动无关的历史问题"吗？有 issue 追踪吗？
 */
const KNOWN_TEST_FAILURES = [
  {
    test: 'db migrations, dictionaries and task tree',
    reason: 'Windows 清理期 rmSync EPERM（既有环境问题、与代码无关；已长期存在，不删断言）',
  },
]

/**
 * 显式登记的**已知探针欠账**（还清了必须删掉，否则门禁会红）。
 *
 * ⚠️ 每条都要写清是**真盲点**（装回缺陷后仍全绿 → 要补判据）还是**探针失效**
 *（变异点没匹配上 → 要重锚探针）。两者混在一起会让这份名单同时虚高与虚低 ——
 * 详见 `docs/issues/2026-10-01-mutation-probe-maintenance.md`。
 */
const KNOWN_PROBE_DEBT = [
  {
    probe: 'probe-capacity-mutations',
    reason: '真盲点 5 条（M11/M12/M13/M14/M19 —— 编辑耗时的保存与初值、就地校验、乐观更新、'
      + '逾期开关变假控件）+ 失效 14 条（M1–M10/M15–M18：容量计算已迁出 src/client/capacity.ts）',
  },
  {
    probe: 'probe-model-picker-notify-mutations',
    reason: '失效 3 条（B7/B8/B10：selectionToApply / unavailableReason / clearExitReachable 的写法与位置变了）—— '
      + '**无真盲点**，重锚即可',
  },
  {
    probe: 'probe-quick-workspace-mutations',
    reason: '失效 2 条（M6/M14：调用点与按钮渲染条件已换位置，需重锚）—— 真盲点 M10 已于 2026-10-02 补判据并销账',
  },
]

/** PII 扫描的良性规则基线（逐条人工判断过）。 */
const PII_BASELINE = ['通用占位家目录（允许，仅提示）', '凭据文件名引用']

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback = null) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}

const PHASE = valueOf('--phase', 'pre')
const VERSION = valueOf('--version', PHASE === 'pre' ? PKG.version : null)
const ONLY = valueOf('--only', null)
const SKIP_INSTALL = has('--no-install')
const JSON_OUT = valueOf('--json', null)

/** 跑一条命令，返回 `{code, out}`（输出合并 stderr，便于把失败原因原样打出来）。 */
function run(command, { cwd = ROOT, env = {} } = {}) {
  const result = spawnSync(command, {
    cwd, shell: true, encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: result.status === null ? 1 : result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** 直连 HTTP（**绕开 npm 本地缓存**）：用 curl.exe 拿 `{code, out}`。 */
function curl(url, extra = []) {
  return run(`curl.exe -sS --max-time 120 -o NUL -w "%{http_code}" ${extra.join(' ')} "${url}"`)
}

function curlJson(url, extra = []) {
  return run(`curl.exe -sS --max-time 120 ${extra.join(' ')} "${url}"`)
}

const results = []
function add(name, verdict) { results.push({ name, verdict }) }
function banner(text) { console.log(`\n── ${text} ${'─'.repeat(Math.max(0, 66 - text.length))}`) }
function show(verdict) {
  for (const d of verdict.debts) console.log(`   ⚠️  ${d}`)
  for (const n of verdict.notes) console.log(`   ℹ️  ${n}`)
  for (const f of verdict.failures) console.log(`   ❌ ${f}`)
  if (verdict.failures.length === 0) console.log('   ✅ 通过')
}

// ───────────────────────────────────────────────────────────────────────────
// 发版前
// ───────────────────────────────────────────────────────────────────────────

function gateTypecheck() {
  banner('1/5 类型检查')
  const r = run('pnpm typecheck')
  console.log(r.code === 0 ? '   ✅ typecheck 0' : r.out.trim().split('\n').slice(-8).map((l) => `   ${l}`).join('\n'))
  add('typecheck', { ok: r.code === 0, failures: r.code === 0 ? [] : ['pnpm typecheck 非 0'], debts: [], notes: [] })
}

function gateTests() {
  banner('2/5 全量单测')
  const r = run('pnpm test')
  const summary = parseTestSummary(r.out)
  const verdict = judgeTests(summary, KNOWN_TEST_FAILURES)
  console.log(`   ℹ️  tests ${summary.tests} / pass ${summary.pass} / fail ${summary.fail}`)
  show(verdict)
  add('单测', verdict)
}

function gateProbes() {
  banner('3/5 变异探针（每个之间 pnpm build —— 探针只还原 src，不重建 lib）')
  const list = run('node -e "const fs=require(\'fs\');const d=fs.readdirSync(\'scripts/repro\').filter(f=>/^probe-.*-mutations\\.mjs$/.test(f)).sort();console.log(d.join(\'\\n\'))"')
  const files = list.out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '')
  const parsed = []
  for (const file of files) {
    const build = run('pnpm build')
    if (build.code !== 0) {
      console.log(`   ❌ ${file}：构建失败，探针无法执行`)
      parsed.push({ id: file, caughtAll: false, caught: 0, total: 0, stale: false, unreliable: true, survived: null, detail: '构建失败' })
      continue
    }
    const r = run(`node scripts/repro/${file}`)
    const verdict = parseProbeResult({ id: file.replace(/\.mjs$/, ''), exitCode: r.code, stdout: r.out })
    parsed.push(verdict)
    const mark = verdict.caughtAll ? '✅' : '❌'
    console.log(`   ${mark} ${verdict.id}：${verdict.detail}`)
  }
  const verdict = judgeProbes(parsed, KNOWN_PROBE_DEBT)
  show(verdict)
  add('探针', verdict)
}

function gatePii() {
  banner('4/5 PII（两个面：GitHub 跟踪 + 随包 lib/**）')
  const r = run('node scripts/check-pii.mjs')
  const rules = parsePiiRules(r.out)
  const verdict = judgePii(rules, PII_BASELINE)
  show(verdict)
  add('PII', verdict)
}

function gateVersionDocs() {
  banner('5/5 版本号与文档就位')
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const verdict = judgePreVersion({
    plannedVersion: VERSION,
    packageVersion: PKG.version,
    releaseNotesExists: existsSync(join(ROOT, 'docs', 'releases', `v${VERSION}.md`)),
    readmeHasVersionRow: new RegExp(`\\|\\s*\\*{0,2}${VERSION.replace(/\./g, '\\.')}`).test(readme),
  })
  show(verdict)
  add('版本与文档', verdict)
}

// ───────────────────────────────────────────────────────────────────────────
// 发布后
// ───────────────────────────────────────────────────────────────────────────

function gateArtifact() {
  banner(`发布后 1/2 产物对账（version=${VERSION}）`)
  if (VERSION === null) {
    add('产物对账', { ok: false, failures: ['post 阶段必须给 --version'], debts: [], notes: [] })
    return
  }
  const encoded = PKG_NAME.replace('/', '%2f').replace('@', '@')
  const tags = curlJson(`https://registry.npmjs.org/-/package/${PKG_NAME}/dist-tags`)
  let latest = null
  try { latest = JSON.parse(tags.out).latest ?? null } catch { latest = null }
  const doc = curlJson(`https://registry.npmjs.org/${encoded}/${VERSION}`)
  let expectedSha1 = null
  let versionDocStatus = null
  try {
    const parsed = JSON.parse(doc.out)
    expectedSha1 = parsed?.dist?.shasum ?? null
    versionDocStatus = parsed?.version === VERSION ? 200 : null
  } catch { versionDocStatus = null }
  const tarballUrl = `https://registry.npmjs.org/${PKG_NAME}/-/${PKG_NAME.split('/')[1]}-${VERSION}.tgz`
  const tarballStatus = Number(curl(tarballUrl).out.trim()) || null
  let sha1 = null
  if (tarballStatus === 200) {
    const tmp = join(ROOT, '_local-build', `preflight-${VERSION}.tgz`)
    mkdirSync(join(ROOT, '_local-build'), { recursive: true })
    run(`curl.exe -sSL --max-time 300 -o "${tmp}" "${tarballUrl}"`)
    const h = run(`node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha1').update(f.readFileSync(process.argv[1])).digest('hex'))" "${tmp}"`)
    sha1 = h.out.trim().split(/\r?\n/).pop() ?? null
  }
  console.log(`   ℹ️  dist-tags.latest=${String(latest)}  versionDoc=${String(versionDocStatus)}  tarball=${String(tarballStatus)}`)
  const verdict = judgePostArtifact({ plannedVersion: VERSION, distTagLatest: latest, versionDocStatus, tarballStatus, sha1, expectedSha1 })
  show(verdict)
  add('产物对账', verdict)

  if (!SKIP_INSTALL) {
    banner('发布后 1b 用户视角安装（空目录 + 全新缓存，走 latest）')
    const dir = join(ROOT, '_local-build', `preflight-install-${VERSION}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'preflight-smoke', private: true }), 'utf8')
    const r = run(`npm i ${PKG_NAME} --no-audit --no-fund --cache "${join(dir, '.npmcache')}"`, { cwd: dir })
    const installed = existsSync(join(dir, 'node_modules', ...PKG_NAME.split('/'), 'package.json'))
      ? JSON.parse(readFileSync(join(dir, 'node_modules', ...PKG_NAME.split('/'), 'package.json'), 'utf8')).version
      : null
    const ok = r.code === 0 && installed === VERSION
    console.log(ok ? `   ✅ 装到 ${String(installed)}` : `   ❌ 安装失败或版本不符（装到 ${String(installed)}）`)
    if (!ok) console.log(r.out.trim().split('\n').slice(-6).map((l) => `      ${l}`).join('\n'))
    add('用户视角安装', { ok, failures: ok ? [] : [`npm i ${PKG_NAME} 没装到 ${VERSION}`], debts: [], notes: [] })
  }
}

function gateGitHubRelease() {
  banner('发布后 2/2 GitHub Release（走本机代理，公开端点不需要 token）')
  const proxy = process.env.DSH_GITHUB_PROXY ?? 'http://127.0.0.1:5782'
  const r = run(`curl.exe -sS --max-time 60 -x ${proxy} -H "User-Agent: dsh-preflight" -H "Accept: application/vnd.github+json" https://api.github.com/repos/Dely0/dsh-personal-workbench/releases/latest`)
  let tag = null
  try { tag = JSON.parse(r.out).tag_name ?? null } catch { tag = null }
  const ok = tag === `v${VERSION}`
  console.log(ok ? `   ✅ releases/latest = ${String(tag)}` : `   ❌ releases/latest = ${String(tag)}（期望 v${VERSION}）—— 只推 tag 不等于建了 Release`)
  add('GitHub Release', { ok, failures: ok ? [] : [`releases/latest 是 ${String(tag)}，不是 v${VERSION}`], debts: [], notes: [] })
}

// ───────────────────────────────────────────────────────────────────────────

const PLAN = PHASE === 'post'
  ? [['artifact', gateArtifact], ['github', gateGitHubRelease]]
  : [['typecheck', gateTypecheck], ['tests', gateTests], ['probes', gateProbes], ['pii', gatePii], ['version', gateVersionDocs]]

console.log(`发布门禁 · phase=${PHASE} · pkg=${PKG_NAME}@${String(VERSION)}`)
for (const [key, fn] of PLAN) {
  if (ONLY !== null && ONLY !== key) continue
  fn()
}

const summary = merge(results)
banner('汇总')
for (const d of summary.debts) console.log(`   ⚠️  ${d}`)
for (const n of summary.notes) console.log(`   ℹ️  ${n}`)
for (const f of summary.failures) console.log(`   ❌ ${f}`)
console.log(summary.ok
  ? `\n✅ 门禁通过（欠账 ${summary.debts.length} 条，见上）`
  : `\n❌ 门禁未通过：${summary.failures.length} 条阻塞项`)

if (JSON_OUT !== null) {
  const path = resolve(ROOT, JSON_OUT)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ phase: PHASE, version: VERSION, ...summary }, null, 2), 'utf8')
  console.log(`   证据已写入 ${path}`)
}

process.exit(summary.ok ? 0 : 1)
