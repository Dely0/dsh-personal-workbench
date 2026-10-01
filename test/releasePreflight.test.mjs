/**
 * 发布门禁的判定逻辑（`scripts/lib/releasePreflight.mjs`）单测。
 *
 * ## 为什么这些用例必须存在
 *
 * 门禁本身是"判据的判据"：它出错的方式是**假绿**（该红不红），而假绿在发布流程里
 * 会被读成"一切正常"。所以这里刻意用**真实观察到的输出样本**（v1.16.1 发布当天抓的），
 * 而不是自己编的漂亮字符串 —— 样本一旦漂移，这些用例会先红。
 *
 * 覆盖的三类真实形态：
 * - 单测：历史失败被显式登记（名单外的红必须阻塞）
 * - 探针：`✅ 全红` / `❌ 有存活` / `找不到替换片段（探针失效）` / `基线就没过`
 * - 发布会话：**中间态**（版本文档 200、tarball 404、`npm view` 因本地缓存报 404）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dedupe, judgePii, judgePostArtifact, judgePreVersion, judgeProbes, judgeTests, merge,
  parsePiiRules, parseProbeResult, parseTestSummary,
} from '../scripts/lib/releasePreflight.mjs'

// ── 真实样本（2026-10-01 发 v1.16.1 当天抓的）────────────────────────────────

const REAL_TEST_TAIL = `
✖ db migrations, dictionaries and task tree (886.9033ms)
ℹ tests 929
ℹ pass 928
ℹ fail 1
ℹ cancelled 0
✖ failing tests:
✖ db migrations, dictionaries and task tree (886.9033ms)
`

const REAL_PROBE_OK = `
  基线：先构建，再确认未变异时相关测试是绿的
  ✔ M45 引用判定不判前缀唯一（标题前 12 字碰撞 → 甲乙都标成被引用）

  ✅ 46/46 条变异都被断言抓到（还原后仍全绿）
`

const REAL_PROBE_SURVIVORS = `
  ✔ B5 发送失败重新被空 catch 吞掉

  ❌ 3/10 条变异没有被断言发现
`

const REAL_PROBE_STALE = `
  FAIL  M7 未知优先级归 p0 而不是 p3（把"没识别"当成"最紧急"）
  找不到替换片段（探针失效，需更新）
`

const REAL_PROBE_UNRELIABLE = `
  基线就没过 —— 先修好单测再跑反向验证：
  ✖ test\\modelPickerDegrade.test.mjs (41.1989ms)
`

/** 约定 B（capacity / listview）：成功时打印 `变异探针：N/M 条变异都变红`。 */
const REAL_PROBE_OK_CONVENTION_B = `
基线 ok（全绿）

ok    升序排序被忽视（档位与合并方向都按降序走） — 变红 ✓
ok    portal 菜单 z-index 低于面板宿主（被卡片盖住，点到的还是卡片） — 变红 ✓

已还原全部源码并重建。

变异探针：17/17 条变异都变红
`

const REAL_PII = `
  === 面一 · GitHub 公开面（git 跟踪）：398 个文件 ===
    [命中 4] 通用占位家目录（允许，仅提示）
        test/workspacePath.test.mjs:27: assert.equal(normalizeWindowsPathToWsl('/home/user/code'), '/home/user/code')
    [干净] 公司域名
  === 面二 · npm 包内容（lib/**）===
    [命中 6] 凭据文件名引用
        scripts/new-github-release.ps1:62: ...'.gh_token.txt'
  === 合计命中 10 处 ===
`

// ── 单测汇总 ────────────────────────────────────────────────────────────────

test('解析 node --test 汇总：数字与失败用例名都要拿到', () => {
  const s = parseTestSummary(REAL_TEST_TAIL)
  assert.equal(s.tests, 929)
  assert.equal(s.pass, 928)
  assert.equal(s.fail, 1)
  assert.deepEqual(s.failing, ['db migrations, dictionaries and task tree'])
})

test('解析不出任何用例时必须判失败（把"读不到"当"通过"是门禁最危险的假绿）', () => {
  const v = judgeTests(parseTestSummary('some unrelated output'), [])
  assert.equal(v.ok, false)
  assert.match(v.failures[0], /没解析到任何用例/)
})

test('名单外的失败必须阻塞发布', () => {
  const v = judgeTests(parseTestSummary(REAL_TEST_TAIL), [])
  assert.equal(v.ok, false)
  assert.match(v.failures.join('\n'), /单测失败：db migrations/)
})

test('显式登记的已知失败放过，但必须作为欠账显示出来', () => {
  const v = judgeTests(parseTestSummary(REAL_TEST_TAIL), [
    { test: 'db migrations, dictionaries and task tree', reason: 'Windows EPERM' },
  ])
  assert.equal(v.ok, true)
  assert.equal(v.failures.length, 0)
  assert.equal(v.debts.length, 1)
  assert.match(v.debts[0], /Windows EPERM/)
})

test('登记为已知失败的用例转绿了 → 必须失败（否则名单会腐烂成橡皮图章）', () => {
  const green = REAL_TEST_TAIL.replace('ℹ fail 1', 'ℹ fail 0').replace(/✖ db migrations.*\n/g, '')
  const v = judgeTests(parseTestSummary(green), [
    { test: 'db migrations, dictionaries and task tree', reason: 'Windows EPERM' },
  ])
  assert.equal(v.ok, false)
  assert.match(v.failures.join('\n'), /这次是绿的/)
})

test('fail 数与解析出的失败名不一致时判失败（解析漏名不能当成没问题）', () => {
  const broken = 'ℹ tests 10\nℹ pass 8\nℹ fail 2\n✖ failing tests:\n✖ only one (1ms)\n'
  const v = judgeTests(parseTestSummary(broken), [])
  assert.equal(v.ok, false)
  assert.match(v.failures.join('\n'), /解析结果不可信/)
})

// ── 变异探针 ────────────────────────────────────────────────────────────────

test('探针：全红样本识别为通过', () => {
  const p = parseProbeResult({ id: 'probe-knowledge-recall-mutations', exitCode: 0, stdout: REAL_PROBE_OK })
  assert.equal(p.caughtAll, true)
  assert.equal(p.caught, 46)
  assert.equal(p.total, 46)
  assert.equal(p.survived, 0)
  assert.equal(p.stale, false)
})

test('探针：有存活样本识别为不通过，并报出存活数', () => {
  const p = parseProbeResult({ id: 'probe-model-picker-notify-mutations', exitCode: 1, stdout: REAL_PROBE_SURVIVORS })
  assert.equal(p.caughtAll, false)
  assert.equal(p.survived, 3)
  assert.equal(p.total, 10)
})

test('探针：**约定 B** 的汇总行（`变异探针：17/17 条变异都变红`）也要认出来', () => {
  const p = parseProbeResult({ id: 'probe-listview-mutations', exitCode: 0, stdout: REAL_PROBE_OK_CONVENTION_B })
  assert.equal(p.caughtAll, true, '认不出约定 B 会把绿的判成红（第一次跑就踩了）')
  assert.equal(p.caught, 17)
  assert.equal(p.total, 17)
  assert.equal(p.survived, 0)
})

test('探针：约定 B 的失败形态（N<M）→ 存活数 = 差', () => {
  const p = parseProbeResult({
    id: 'probe-listview-mutations', exitCode: 1,
    stdout: '变异探针：15/17 条变异都变红\n防线有洞：\n  - 某条 :: 仍然全绿 ✗\n',
  })
  assert.equal(p.caughtAll, false)
  assert.equal(p.survived, 2)
  assert.equal(p.total, 17)
})

test('探针：完全不认识的输出 → 判不通过（宁可误报，不许把"读不懂"当没问题）', () => {
  const p = parseProbeResult({ id: 'probe-future-format', exitCode: 0, stdout: '一切正常（新格式）\n' })
  assert.equal(p.caughtAll, false)
  assert.match(p.detail, /无法解析探针输出/)
})

test('探针：失效（找不到替换片段）既不算通过，也不算"已知盲点"', () => {
  const p = parseProbeResult({ id: 'probe-capacity-mutations', exitCode: 1, stdout: REAL_PROBE_STALE })
  assert.equal(p.stale, true)
  assert.equal(p.caughtAll, false)
  const v = judgeProbes([p], [{ probe: 'probe-capacity-mutations', reason: '登记过的盲点' }])
  assert.equal(v.ok, false, '探针失效说明门禁不在工作，不能靠"登记过盲点"放过')
  assert.match(v.failures.join('\n'), /必须先修探针/)
})

test('探针：基线没过 ⇒ 结果不可信，不是"发现了问题"', () => {
  const p = parseProbeResult({ id: 'probe-quick-workspace-mutations', exitCode: 1, stdout: REAL_PROBE_UNRELIABLE })
  assert.equal(p.unreliable, true)
  assert.equal(p.caughtAll, false)
})

test('探针：一个都没跑 ⇒ 失败', () => {
  const v = judgeProbes([], [])
  assert.equal(v.ok, false)
  assert.match(v.failures.join('\n'), /一个探针都没跑/)
})

test('探针：登记过的盲点仍然存活 → 作为欠账放过；出现新盲点 → 失败', () => {
  const known = parseProbeResult({ id: 'probe-capacity-mutations', exitCode: 1, stdout: REAL_PROBE_SURVIVORS })
  const fresh = parseProbeResult({ id: 'probe-brand-new', exitCode: 1, stdout: REAL_PROBE_SURVIVORS })
  const ok = judgeProbes([known], [{ probe: 'probe-capacity-mutations', reason: 'M19 存活' }])
  assert.equal(ok.ok, true)
  assert.equal(ok.debts.length, 1)
  const bad = judgeProbes([known, fresh], [{ probe: 'probe-capacity-mutations', reason: 'M19 存活' }])
  assert.equal(bad.ok, false)
  assert.match(bad.failures.join('\n'), /probe-brand-new/)
})

test('探针：登记过的盲点这次全红了 → 失败（请把名单删掉）', () => {
  const p = parseProbeResult({ id: 'probe-capacity-mutations', exitCode: 0, stdout: REAL_PROBE_OK })
  const v = judgeProbes([p], [{ probe: 'probe-capacity-mutations', reason: 'M19 存活' }])
  assert.equal(v.ok, false)
  assert.match(v.failures.join('\n'), /盲点已消除/)
})

// ── PII ────────────────────────────────────────────────────────────────────

test('解析 PII 输出：只取"命中"的规则名（干净的不算）', () => {
  const rules = parsePiiRules(REAL_PII)
  assert.deepEqual(rules.map((r) => r.name), ['通用占位家目录（允许，仅提示）', '凭据文件名引用'])
  assert.deepEqual(rules.map((r) => r.count), [4, 6])
})

test('PII：基线内的规则命中 → 欠账；新规则命中 → 失败', () => {
  const rules = parsePiiRules(REAL_PII)
  const ok = judgePii(rules, ['通用占位家目录（允许，仅提示）', '凭据文件名引用'])
  assert.equal(ok.ok, true)
  assert.equal(ok.debts.length, 2)
  const bad = judgePii(rules, ['通用占位家目录（允许，仅提示）'])
  assert.equal(bad.ok, false)
  assert.match(bad.failures.join('\n'), /凭据文件名引用/)
})

test('PII：基线里的规则这次没命中 → 只是提示，不阻塞（规则可能失效，值得看一眼）', () => {
  const v = judgePii([], ['凭据文件名引用'])
  assert.equal(v.ok, true)
  assert.match(v.notes.join('\n'), /没命中/)
})

// ── 版本链路 ────────────────────────────────────────────────────────────────

test('发版前：版本号/Release Notes/README 行三者缺一不可', () => {
  const base = { plannedVersion: '1.16.2', packageVersion: '1.16.2', releaseNotesExists: true, readmeHasVersionRow: true }
  assert.equal(judgePreVersion(base).ok, true)
  assert.match(judgePreVersion({ ...base, packageVersion: '1.16.1' }).failures.join('\n'), /不一致/)
  assert.match(judgePreVersion({ ...base, releaseNotesExists: false }).failures.join('\n'), /缺少 docs\/releases/)
  assert.match(judgePreVersion({ ...base, readmeHasVersionRow: false }).failures.join('\n'), /版本历史/)
})

test('发布后：**中间态**（版本文档 200、tarball 404）必须判失败并点明 tarball 才是判据', () => {
  const v = judgePostArtifact({
    plannedVersion: '1.16.1', distTagLatest: '1.16.0',
    versionDocStatus: 200, tarballStatus: 404, sha1: null, expectedSha1: '46d61b7b',
  })
  assert.equal(v.ok, false)
  const all = v.failures.join('\n')
  assert.match(all, /dist-tags\.latest = 1\.16\.0/)
  assert.match(all, /tarball 返回 404/)
  assert.match(all, /tarball 才是判据/)
})

test('发布后：三项证据齐全且 sha1 一致才算通过', () => {
  const v = judgePostArtifact({
    plannedVersion: '1.16.1', distTagLatest: '1.16.1',
    versionDocStatus: 200, tarballStatus: 200,
    sha1: '46D61B7B4B53036EB6ED053DA80CF8711CC69DCE', expectedSha1: '46d61b7b4b53036eb6ed053da80cf8711cc69dce',
  })
  assert.equal(v.ok, true)
})

test('发布后：sha1 不一致 → 失败（"能下载"不等于"是同一份"）', () => {
  const v = judgePostArtifact({
    plannedVersion: '1.16.1', distTagLatest: '1.16.1', versionDocStatus: 200, tarballStatus: 200,
    sha1: 'b73148b1c90555d1c199c2664ab15bc0b0c0a640', expectedSha1: '46d61b7b4b53036eb6ed053da80cf8711cc69dce',
  })
  assert.equal(v.ok, false)
  assert.match(v.failures.join('\n'), /sha1 不一致/)
})

test('发布后：tarball 200 但拿不到哈希 → 失败（不许"看起来行了"就放行）', () => {
  const v = judgePostArtifact({
    plannedVersion: '1.16.1', distTagLatest: '1.16.1', versionDocStatus: 200, tarballStatus: 200,
    sha1: null, expectedSha1: '46d61b7b',
  })
  assert.equal(v.ok, false)
  assert.match(v.failures.join('\n'), /无法对账/)
})

// ── 汇总 ────────────────────────────────────────────────────────────────────

test('汇总：任一失败 → 总判定失败，且带上门禁名便于定位', () => {
  const s = merge([
    { name: 'typecheck', verdict: { ok: true, failures: [], debts: [], notes: [] } },
    { name: '探针', verdict: { ok: false, failures: ['探针 X：存活 3 / 共 10'], debts: [], notes: [] } },
  ])
  assert.equal(s.ok, false)
  assert.match(s.failures[0], /^\[探针\]/)
})

test('汇总：全通过但有欠账 → ok 为真、欠账照样列出来', () => {
  const s = merge([{ name: '单测', verdict: { ok: true, failures: [], debts: ['已知失败：X'], notes: [] } }])
  assert.equal(s.ok, true)
  assert.equal(s.debts.length, 1)
})

test('dedupe 保持顺序', () => {
  assert.deepEqual(dedupe(['b', 'a', 'b', 'c', 'a']), ['b', 'a', 'c'])
})
