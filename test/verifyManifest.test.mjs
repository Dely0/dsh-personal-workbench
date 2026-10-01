/**
 * AX-V01（U/N）：验收脚本卫生与现役白名单。
 *
 * 判据来源：requirements.md §7.3（P1-1）、acceptance.md AX-V01、plan.md V01。
 *
 * 这一组要钉住的**不是**"22 份命中"这个数字（那是 2026-09-30 的本机快照），而是：
 * 1. 命中**只标嫌疑**，作废必须人工写进 `deprecated[]`；
 * 2. **不删脚本**：插警告头之后原文件还在、正文逐字未动、重复插是幂等的；
 * 3. **现役缺文件 = 硬失败**（不许条件少测报绿）；作废项不许同时被声明成现役；
 * 4. 新机器（没有 `.pwtest`）照样能用仓库白名单，且不谎报"扫过 0 份 = 没问题"；
 * 5. 统计**动态生成**：给 3 份脚本就报 3，不报 150；
 * 6. 套件目录里的**未声明**脚本是错误（文件在却永不执行 = 静默丢件）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SUSPICION_MARKER,
  annotateSuspects,
  loadManifest,
  runCheck,
  scanSuspects,
  validateManifest,
} from '../scripts/check-verify-scripts.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))

function tempRoot(label) {
  return mkdtempSync(join(tmpdir(), `wb-verify-manifest-${label}-`))
}

function withRoot(label, fn) {
  const root = tempRoot(label)
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

/** 造一份 fixture 白名单 + 目录结构。 */
function fixture(root, { suites = [], deprecated = [], keywords = ['旧标记'], localScripts = undefined, suiteFiles = [] } = {}) {
  mkdirSync(join(root, 'scripts', 'verify'), { recursive: true })
  const manifest = {
    version: 1,
    roots: { repoSuites: 'scripts/verify/suites', localScripts: '.pwtest' },
    suspectKeywords: keywords,
    suites,
    deprecated,
  }
  const manifestPath = join(root, 'scripts', 'verify', 'suites.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  if (suiteFiles.length > 0) {
    mkdirSync(join(root, 'scripts', 'verify', 'suites'), { recursive: true })
    for (const name of suiteFiles) writeFileSync(join(root, 'scripts', 'verify', 'suites', name), '// fixture suite\n', 'utf8')
  }
  if (localScripts !== undefined) {
    mkdirSync(join(root, '.pwtest'), { recursive: true })
    for (const [name, text] of Object.entries(localScripts)) writeFileSync(join(root, '.pwtest', name), text, 'utf8')
  }
  return { manifestPath, manifest }
}

test('AX-V01：现役套件缺文件是硬失败（不许条件少测报绿）', () => withRoot('active-missing', (root) => {
  fixture(root, {
    suites: [{ id: 'legacy-acceptance', kind: 'legacy', required: true, status: 'active', repoPath: 'scripts/verify/suites/legacy-acceptance.mjs' }],
  })
  const result = runCheck({ root })
  assert.equal(result.exitCode, 1, '现役套件文件不存在时必须失败')
  assert.ok(result.problems.some((text) => text.includes('现役套件缺文件') && text.includes('legacy-acceptance')), `缺文件必须被点名，实际：${result.problems.join(' | ')}`)
}))

test('AX-V01：现役套件文件存在且非空才算通过', () => withRoot('active-present', (root) => {
  fixture(root, {
    suites: [{ id: 'legacy-acceptance', kind: 'legacy', required: true, status: 'active', repoPath: 'scripts/verify/suites/legacy-acceptance.mjs' }],
    suiteFiles: ['legacy-acceptance.mjs'],
  })
  const empty = { id: 'empty', kind: 'new', required: true, status: 'active', repoPath: 'scripts/verify/suites/empty.mjs' }
  mkdirSync(join(root, 'scripts', 'verify', 'suites'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'verify', 'suites', 'empty.mjs'), '', 'utf8')
  const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'verify', 'suites.json'), 'utf8'))
  manifest.suites.push(empty)
  writeFileSync(join(root, 'scripts', 'verify', 'suites.json'), JSON.stringify(manifest), 'utf8')
  const result = runCheck({ root })
  assert.equal(result.exitCode, 1)
  assert.ok(result.problems.some((text) => text.includes('空文件') && text.includes('empty')), '空文件必须算缺件')
}))

test('AX-V01：套件目录里未声明的脚本是错误（静默丢件），下划线开头的辅助模块豁免', () => withRoot('undeclared', (root) => {
  fixture(root, {
    suites: [{ id: 'legacy-final-2', kind: 'legacy', required: true, status: 'active', repoPath: 'scripts/verify/suites/legacy-final-2.mjs' }],
    suiteFiles: ['legacy-final-2.mjs', 'ghost.mjs', '_helpers.mjs'],
  })
  const result = runCheck({ root })
  assert.equal(result.exitCode, 1)
  assert.ok(result.problems.some((text) => text.includes('未声明') && text.includes('ghost.mjs')))
  assert.ok(!result.problems.some((text) => text.includes('_helpers.mjs')), '下划线开头的辅助模块不该被当成套件')
}))

test('AX-V01：作废项必须写原因，且不许同时被声明为现役套件', () => withRoot('deprecated', (root) => {
  fixture(root, {
    suites: [{ id: 'stale', kind: 'legacy', required: false, status: 'active', repoPath: 'scripts/repro/stale.mjs' }],
    suiteFiles: [],
    deprecated: [{ path: 'scripts/repro/stale.mjs' }],
  })
  mkdirSync(join(root, 'scripts', 'repro'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'repro', 'stale.mjs'), '// stale\n', 'utf8')
  const result = runCheck({ root })
  assert.equal(result.exitCode, 1)
  assert.ok(result.problems.some((text) => text.includes('缺少 reason')))
  assert.ok(result.problems.some((text) => text.includes('同时被声明为现役套件')))
}))

test('AX-V01：待迁移套件必须写 reason；文件已存在但仍是 pending 要给提醒', () => withRoot('pending', (root) => {
  fixture(root, {
    suites: [{ id: 'persona', kind: 'new', required: true, status: 'pending-migration', repoPath: 'scripts/verify/suites/persona.mjs' }],
  })
  const missingReason = runCheck({ root })
  assert.equal(missingReason.exitCode, 1)
  assert.ok(missingReason.problems.some((text) => text.includes('缺少 reason')))

  fixture(root, {
    suites: [{ id: 'persona', kind: 'new', required: true, status: 'pending-migration', repoPath: 'scripts/verify/suites/persona.mjs', reason: 'V05（T6）' }],
    suiteFiles: ['persona.mjs'],
  })
  const presentButPending = runCheck({ root })
  assert.equal(presentButPending.exitCode, 0, '待迁移不是错误（但它也不等于通过）')
  assert.equal(presentButPending.counts.requiredPending, 1, '链必须看得到"必需的还没迁完"')
  assert.ok(presentButPending.lines.some((entry) => entry.kind === 'note' && entry.text.includes('已存在但状态仍是 pending')))
}))

test('AX-V01：新机器（没有 .pwtest）照样能用仓库白名单，且动态统计说的是"缺失"而不是"0 份没问题"', () => withRoot('no-pwtest', (root) => {
  fixture(root, {
    suites: [{ id: 'legacy-acceptance', kind: 'legacy', required: true, status: 'active', repoPath: 'scripts/verify/suites/legacy-acceptance.mjs' }],
    suiteFiles: ['legacy-acceptance.mjs'],
  })
  const result = runCheck({ root })
  assert.equal(result.exitCode, 0)
  assert.equal(result.local.present, false)
  assert.ok(result.lines.some((entry) => entry.text.includes('本地脚本目录缺失')), '缺 .pwtest 必须如实说是"缺失"')
}))

test('AX-V01：统计动态生成 —— 3 份脚本就报 3 份，永不写死 150/22', () => withRoot('dynamic-count', (root) => {
  fixture(root, {
    suites: [],
    keywords: ['已删除标记'],
    localScripts: {
      'a.mjs': '// 已删除标记\n',
      'b.mjs': '// 干净\n',
      'c.mjs': '// 已删除标记 与 已删除标记\n',
      'd.txt': '已删除标记（不是 .mjs，不该被数）\n',
    },
  })
  const result = runCheck({ root })
  assert.equal(result.counts.localScripts, 3, `只数 .mjs，实际 ${result.counts.localScripts}`)
  assert.equal(result.counts.suspects, 2)
  assert.deepEqual(result.local.suspects.map((entry) => entry.file).sort(), ['a.mjs', 'c.mjs'])
  assert.notEqual(result.counts.localScripts, 150)
}))

test('AX-V01：命中只标嫌疑 —— 插警告头幂等、保 shebang、正文逐字不变、文件不删', () => withRoot('annotate', (root) => {
  fixture(root, { suites: [], keywords: ['旧行为'], localScripts: {
    'suspect.mjs': '#!/usr/bin/env node\n// 正文第一行\nconst 旧行为 = 1\n',
    'clean.mjs': '// 完全干净\n',
  } })
  const dir = join(root, '.pwtest')
  const scanned = scanSuspects(dir, ['旧行为'])
  assert.equal(scanned.scanned, 2)
  assert.deepEqual(scanned.suspects.map((entry) => entry.file), ['suspect.mjs'])

  const first = annotateSuspects(dir, scanned.suspects)
  assert.deepEqual(first, [{ file: 'suspect.mjs', action: 'annotated' }])
  const after = readFileSync(join(dir, 'suspect.mjs'), 'utf8')
  assert.ok(after.startsWith('#!/usr/bin/env node\n'), 'shebang 必须还在第一行')
  assert.ok(after.includes(SUSPICION_MARKER))
  assert.ok(after.includes('// 正文第一行\nconst 旧行为 = 1'), '正文必须逐字保留（只多一行警告）')

  const second = annotateSuspects(dir, scanSuspects(dir, ['旧行为']).suspects)
  assert.deepEqual(second, [{ file: 'suspect.mjs', action: 'already' }], '第二次必须是幂等的')
  assert.equal(readFileSync(join(dir, 'suspect.mjs'), 'utf8'), after)
  assert.ok(existsSync(join(dir, 'clean.mjs')), '不命中的脚本一个都不许动')
}))

test('AX-V01：manifest 结构错误被点名（status 非法 / id 重复 / 缺 repoPath）', () => {
  const validated = validateManifest({
    version: 1,
    roots: { repoSuites: 'nope', localScripts: 'nope' },
    suites: [
      { id: 'a', required: true, status: '现役', repoPath: 'x.mjs' },
      { id: 'b', required: true, status: 'active' },
      { id: 'b', required: true, status: 'active', repoPath: 'y.mjs' },
    ],
    deprecated: [],
  }, { root: REPO })
  assert.ok(validated.problems.some((text) => text.includes('status 非法')))
  assert.ok(validated.problems.some((text) => text.includes('缺少 repoPath')))
  assert.ok(validated.problems.some((text) => text.includes('id 重复')))
})

test('AX-V01：非法 JSON 的白名单报"读不了"，不是"没问题"', () => withRoot('bad-json', (root) => {
  mkdirSync(join(root, 'scripts', 'verify'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'verify', 'suites.json'), '{ 这不是 JSON', 'utf8')
  const result = runCheck({ root })
  assert.equal(result.exitCode, 2)
  assert.ok(result.problems.some((text) => text.includes('不是合法 JSON')))
}))

test('AX-V01：仓库真实白名单自洽（每一条必需套件要么现役且文件在、要么待迁移且写了原因）', () => {
  const manifestPath = join(REPO, 'scripts', 'verify', 'suites.json')
  const loaded = loadManifest(manifestPath)
  assert.deepEqual(loaded.problems, [])
  const manifest = loaded.manifest
  assert.ok(Array.isArray(manifest.suites) && manifest.suites.length === 8, '本轮登记 8 套：4 套历史回归 + 4 套新增（S17-N）')

  // 历史四套的判据编号必须与 legacy-regression.md 的 43 个 LEG 逐一对上
  const expectedLegacy = { 'legacy-acceptance': 17, 'legacy-final-2': 9, 'legacy-sidebar-collapse': 6, 'legacy-duplicate-task': 11 }
  for (const [id, count] of Object.entries(expectedLegacy)) {
    const entry = manifest.suites.find((suite) => suite.id === id)
    assert.ok(entry !== undefined, `缺 ${id}`)
    assert.equal(entry.legacyIds.length, count, `${id} 的 LEG 编号数必须是 ${count}`)
    assert.ok(entry.legacyIds.every((legacyId) => /^LEG-[AFSD]\d{2}$/.test(legacyId)), `${id} 的 LEG 编号形状不对`)
  }

  for (const entry of manifest.suites) {
    if (entry.status === 'active') {
      assert.ok(existsSync(join(REPO, entry.repoPath)), `现役套件缺文件：${entry.id}`)
    } else if (entry.status === 'pending-migration') {
      assert.equal(typeof entry.reason, 'string', `待迁移套件 ${entry.id} 必须写原因`)
      assert.ok(entry.reason.length > 0)
    } else {
      assert.fail(`套房 ${entry.id} 的 status 不该是 ${entry.status}`)
    }
  }
  assert.ok(manifest.deprecated.length >= 3, 'T2 标过时的三个 scripts/repro 脚本必须在作废清单里（保留不删）')

  const result = runCheck({ root: REPO })
  assert.equal(result.exitCode, 0, `仓库白名单必须自洽：${result.problems.join(' | ')}`)
  assert.equal(result.counts.active + result.counts.pending, 8)
})
