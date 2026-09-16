/**
 * 反向验证：把 v1.15.2「快速录入默认工作区」的修复**装回去**，断言必须变红。
 *
 * 为什么要有它：这次修复的核心是"**接线**"（默认值不再从选中任务派生；
 * 只有用户动过的选择才进 recent；建资料夹的默认勾选不按路径来源分叉；
 * 最近列表能删）。接线错了，纯函数单测全绿也照样出事 ——
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
const SHARED = join(ROOT, 'lib', 'shared', 'quickWorkspaceRecent.js')
const TEST_FILES = ['test/quickWorkspaceDefault.test.mjs', 'test/quickIntakeDefaultWiring.test.mjs']

/**
 * 每条变异：{ name, file, from（正则）, to, expect（这条修复守的是什么，仅用于展示） }
 *
 * ⚠️ 变异 `lib/` 里编译后的 `.js`（单测 import 的就是它）；`src/` 里的源码由
 * "源码抽取"类断言守（test/quickIntakeDefaultWiring.test.mjs）。
 */
const MUTATIONS = [
  {
    name: 'M1 还原成"从当前选中任务派生默认值"（本次事故的原形态）',
    file: COMPONENT,
    from: /applyQuickWorkspaceDecision\(decideQuickWorkspaceDefault\(\{[\s\S]*?\n    \}\), settings\.autoCreateTypeFolders\)/,
    to: [
      "const legacyInherited = selected?.task.effectiveWorkspacePath ?? ''",
      "applyQuickWorkspaceDecision(legacyInherited !== ''",
      "  ? { path: legacyInherited, source: 'last-manual' }",
      "  : { path: settings.defaultWorkspace, source: 'system-default' }, settings.autoCreateTypeFolders)",
    ].join('\n'),
    expect: '默认值只能由"用户偏好 + 系统配置"决定',
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
    from: /const manual = normalizeRecentWorkspaces\(input\.recent\)\[0\]/,
    to: 'const manual = undefined',
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
    name: 'M5 判定不再做 WSL 路径归一化（判定内部）',
    file: MODULE,
    from: /input\.isWsl === true \? normalizeWindowsPathToWsl\(value\) : value/,
    to: 'value',
    expect: 'WSL 下把 Windows 形态归一化',
  },
  {
    name: 'M6 在 openQuickEntry **之外**补一句"跟随任务工作区"的写入（换个入口重新引入污染）',
    file: COMPONENT,
    from: /setQuickWorkspace\(e\.target\.value\)/,
    to: "setQuickWorkspace(selected?.task.effectiveWorkspacePath ?? e.target.value)",
    expect: 'setQuickWorkspace 的实参只允许是判定结果或用户输入',
  },
  {
    name: 'M7 建任务资料夹的默认勾选改成恒 false（等于静默丢掉 v1.15.1 的任务资料夹保证）',
    file: MODULE,
    from: /return autoCreateTypeFolders === true && String\(path \?\? ''\)\.trim\(\) !== ''/,
    to: 'return false',
    expect: 'quickFollowFolderDefault 只看全局开关与"有没有目标目录"',
  },
  {
    name: 'M8 合并不再置顶（同一目录再选一次不作数）→ 默认值停在旧的第一条',
    file: SHARED,
    from: /return normalizeRecentWorkspaces\(\[trimmed, \.\.\.\(Array\.isArray\(current\) \? current : \[\]\)\]\)/,
    to: 'return normalizeRecentWorkspaces(Array.isArray(current) ? current : [])',
    expect: '合并 = 置顶 + 去重',
  },
  {
    name: 'M9 删除变成空操作（用户再也改不回设置里的默认工作区）',
    file: SHARED,
    from: /return normalizeRecentWorkspaces\(items\.filter\(\(item\) => recentWorkspaceKey\(String\(item\)\) !== target\)\)/,
    to: 'return normalizeRecentWorkspaces(items)',
    expect: '删除 = 删得掉（这是"改回默认工作区"的唯一路径）',
  },
  {
    name: 'M10 调用点把 recent 传成空数组（判定对、喂错了）',
    file: COMPONENT,
    from: /recent: settings\.quickWorkspaceRecent,/,
    to: 'recent: [],',
    expect: '调用点真的把 recent 传对了（行为级接线）',
  },
  {
    name: 'M11 调用点把 isWsl 写死 false（判定对、喂错了）',
    file: COMPONENT,
    from: /isWsl: detectWslHost\(runtime\),/,
    to: 'isWsl: false,',
    expect: '调用点真的把 isWsl 传对了（行为级接线）',
  },
  {
    name: 'M12 设置弹窗整表回传 recent（陈旧快照会把并发记下的顶掉）',
    file: COMPONENT,
    from: /const \{ quickWorkspaceRecent: _ignored, \.\.\.editable \} = settings/,
    to: 'const editable = settings',
    expect: 'saveSettings 必须把 quickWorkspaceRecent 摘掉再提交',
  },
]

const run = () => spawnSync(process.execPath, ['--test', ...TEST_FILES], { cwd: ROOT, encoding: 'utf8' })

/** 基线：未变异时必须全绿，否则后面的"变红"没有意义。 */
const baseline = run()
if (baseline.status !== 0) {
  console.error('基线就没过 —— 先修好单测再跑反向验证：')
  console.error(baseline.stdout)
  process.exit(2)
}
console.log(`基线：${TEST_FILES.join(' + ')} 全绿\n`)

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
