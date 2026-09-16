/**
 * 反向验证：把 v1.15.2「快速录入默认工作区」的修复**装回去**，新断言必须变红。
 *
 * 为什么要有它：这次修复的核心是"**接线**"（默认值不再从选中任务派生；
 * 只有用户动过的选择才进 recent）。接线错了，纯函数单测全绿也照样出事 ——
 * 所以每条断言都要能证明它真的在守东西：撤掉修复 → 必须红。
 *
 * 每条变异跑完立刻从内存还原原文件（`finally`），工作区不留改动。
 * 任何一条变异"照样全绿"就以非零码退出。
 *
 * 用法：node scripts/repro/probe-quick-workspace-mutations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const COMPONENT = join(ROOT, 'src', 'client', 'index.tsx')
const MODULE = join(ROOT, 'lib', 'client', 'quickWorkspaceDefault.js')
const TEST_FILE = 'test/quickWorkspaceDefault.test.mjs'

/**
 * 每条变异：{ name, file, from（正则）, to, expect（期望变红的那条断言的关键词，仅用于展示） }
 */
const MUTATIONS = [
  {
    name: 'M1 还原成"从当前选中任务派生默认值"（本次事故的原形态）',
    file: COMPONENT,
    from: /const decided = decideQuickWorkspaceDefault\(\{[\s\S]*?\n    \}\)/,
    to: [
      "const legacyInherited = selected?.task.effectiveWorkspacePath ?? ''",
      'const decided = legacyInherited !== \'\'',
      "  ? { path: legacyInherited, source: 'last-manual' }",
      "  : { path: settings.defaultWorkspace, source: 'system-default' }",
    ].join('\n'),
    expect: '最终打开快速录入时的默认工作区不该来自 selected',
  },
  {
    name: 'M2 去掉 touched 闸门：自动预填的值也记进「最近手动选择」',
    file: COMPONENT,
    from: /shouldRememberQuickWorkspace\(quickWorkspaceTouched, chosen\)/,
    to: "chosen !== ''",
    expect: 'rememberQuickWorkspace 的调用必须先问 shouldRememberQuickWorkspace',
  },
  {
    name: 'M3 判定不再看「上次手动选择」',
    file: MODULE,
    from: /\.find\(\(item\) => item !== ''\)/,
    to: '.find(() => false)',
    expect: '上次手动选择 > 系统默认 > 未设置',
  },
  {
    name: 'M4 shouldRememberQuickWorkspace 丢掉 touched',
    file: MODULE,
    from: /return touched && String\(path \?\? ''\)\.trim\(\) !== ''/,
    to: "return String(path ?? '').trim() !== ''",
    expect: '只有"用户真动过输入框"的选择才配被记下来',
  },
  {
    name: 'M5 判定不再做 WSL 路径归一化',
    file: MODULE,
    from: /input\.isWsl === true \? normalizeWindowsPathToWsl\(value\) : value/,
    to: 'value',
    expect: 'WSL 下把 Windows 形态归一化',
  },
]

const run = () => spawnSync(process.execPath, ['--test', TEST_FILE], { cwd: ROOT, encoding: 'utf8' })

/** 基线：未变异时必须全绿，否则后面的"变红"没有意义。 */
const baseline = run()
if (baseline.status !== 0) {
  console.error('基线就没过 —— 先修好单测再跑反向验证：')
  console.error(baseline.stdout)
  process.exit(2)
}
console.log(`基线：${TEST_FILE} 全绿\n`)

let failures = 0
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8')
  if (!mutation.from.test(original)) {
    console.error(`✖ ${mutation.name}\n    变异点没匹配上（源码结构变了，需要同步本探针）`)
    failures += 1
    continue
  }
  try {
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to))
    const result = run()
    const firstFail = (result.stdout.match(/✖ ([^\n]*)/g) ?? [])[0]?.trim() ?? '(无失败行)'
    if (result.status === 0) {
      console.error(`✖ ${mutation.name}\n    装回缺陷后**仍然全绿** → 这条修复没有任何断言在守`)
      failures += 1
    } else {
      console.log(`✔ ${mutation.name}\n    变红：${firstFail}`)
    }
  } finally {
    writeFileSync(mutation.file, original)
  }
}

// 收尾自检：还原后必须还能全绿（防止探针把工作区改坏）
const restored = run()
if (restored.status !== 0) {
  console.error('还原后单测反而红了 —— 探针没把文件还原干净')
  process.exit(2)
}

if (failures > 0) {
  console.error(`\n❌ ${failures}/${MUTATIONS.length} 条变异没有被断言发现`)
  process.exit(1)
}
console.log(`\n✅ ${MUTATIONS.length}/${MUTATIONS.length} 条变异都被断言抓到（还原后仍全绿）`)
