/**
 * 反向验证：把 2026-09-28 那两处 P0 BUG **装回去**，断言必须变红。
 *
 * 为什么要有它：本次修复的核心不是"多写了一个函数"，而是**三个接线点**：
 *
 * 1. 快速录入提交路径不再抛错、改走 `selectionToApply()` 降级；
 * 2. 选择器的门禁在"有残留选择"时仍开得出清空出口（`hasSelection`）；
 * 3. 系统通知的请求/发送都收敛到可观测的唯一实现。
 *
 * 接线错了，纯函数单测全绿也照样出事（旧代码就是"判定都在、接线在那儿抛错"）。
 * 所以每条变异都必须是"把缺陷装回去"而不是"随便改坏一行"：
 * 装回去仍然全绿 ⇒ 这条修复没有任何断言在守。
 *
 * 每条变异跑完立刻从内存还原原文件（`finally`），工作区不留改动。
 *
 * 用法：node scripts/repro/probe-model-picker-notify-mutations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** 变异 `lib/` 里编译后的 `.js`（单测 import 的就是它）。 */
const MODEL = join(ROOT, 'lib', 'client', 'modelCapability.js')
const NOTIFY = join(ROOT, 'lib', 'client', 'notificationCapability.js')
/** 变异 `src/` 源码（"接线"类断言扫的是它）。 */
const COMPONENT = join(ROOT, 'src', 'client', 'index.tsx')

const TEST_FILES = ['test/modelPickerDegrade.test.mjs', 'test/quickIntakeClient.test.mjs']

const MUTATIONS = [
  {
    name: 'B1 把"拿不到目录就抛错"装回纯判据（2026-09-28 死锁的原始形态，验收标准 1）',
    file: MODEL,
    from: /if \(outcome\.ok\) \{\s*\n\s*return \{\s*\n\s*kind: 'apply',/,
    to: "if (outcome.ok === false)\n        throw new Error('当前 DSH 未提供模型选择接口（modelDirectories），无法为快速录入切换模型。');\n    if (outcome.ok) {\n        return {\n            kind: 'apply',",
    expect: '拿不到目录必须降级跟随默认模型，绝不中断整条快速录入',
  },
  {
    name: 'B2 门禁不再接收"出口可达性"（写死 false ⇒ 界面出口消失，验收标准 2）',
    file: MODEL,
    from: /input\.recoverable \? reason : `\$\{reason\}；当前也没有已保存的模型选择可以清掉，所以这个菜单暂时没有可用操作。`/,
    to: '`${reason}；当前也没有已保存的模型选择可以清掉，所以这个菜单暂时没有可用操作。`',
    expect: '出口可达时不许说"没有可清的选择"（那会让用户以为无路可走）',
  },
  {
    name: 'B3 降级菜单退回"整份目录"（拿不到目录却照样渲染模型行 ⇒ 没有出口也没有真数据）',
    file: MODEL,
    from: /if \(!input\.hasSelection\)\s*\n\s*return \{ mode: 'full', reason: '' \};\s*\n\s*return \{\s*\n\s*mode: 'clear-only',/,
    to: "return {\n    mode: 'full',",
    expect: '拿不到目录 + 有残留选择时必须只给清空出口',
  },
  {
    name: 'B4 请求授权不再先判"不支持"（rc.2 上抛 TypeError，点了没反应）',
    file: NOTIFY,
    from: /if \(ctor === undefined\) \{\s*\n\s*log\(`\[workbench\] 请求通知授权失败：\$\{NOTIFICATION_UNSUPPORTED_REASON\}`\);\s*\n\s*return \{ ok: false, permission: 'unsupported', reason: NOTIFICATION_UNSUPPORTED_REASON \};\s*\n\s*\}/,
    to: 'if (false) { /* 已停用"不支持"前置判定 */ }',
    expect: '不支持的客户端上请求授权必须当场失败并说清原因',
  },
  {
    name: 'B5 发送失败重新被空 catch 吞掉（"显示已开启但毫无反应"，验收标准 5）',
    file: NOTIFY,
    from: /return fail\(error instanceof Error \? error\.message : String\(error\)\);/,
    to: "return { ok: true, reason: '' };",
    expect: '构造失败必须返回原因并留痕，不许静默当成成功',
  },
  {
    name: 'B6 三态退回二态：拿不到构造函数也算 granted（"授权显示已开启"的假象）',
    file: NOTIFY,
    from: /if \(ctor === undefined\)\s*\n\s*return 'unsupported';/,
    to: "if (ctor === undefined)\n        return 'granted';",
    expect: '拿不到构造函数必须判"不支持"，否则界面会显示已授权却永远弹不出来',
  },
  {
    name: 'B7 接线复辟：提交路径不再走 selectionToApply（判定对但没接上）',
    file: COMPONENT,
    from: /sel?ectionApplication = selectionToApply\(quickModelSelection, outcome, \{/,
    to: 'selectionApplication = { kind: `follow-default`, notice: `` }; void ({',
    expect: '提交路径必须真的用纯判据决定换不换模型',
  },
  {
    name: 'B8 接线复辟：门禁的成因改成硬编码（审查 F1：同一个事实又被拼成"接口没提供"）',
    file: COMPONENT,
    from: /unavailableReason: reason,/,
    to: "unavailableReason: '当前 DSH 未提供模型选择接口（modelDirectories），无法读取模型列表',",
    expect: '门禁的成因必须来自 modelDirectoryUnavailableReason（唯一实现）',
  },
  {
    name: 'B9 降级提示重新写死"拿不到模型选择接口"（审查 F1 的提交路径那一半）',
    file: MODEL,
    from: /notice: `\$\{QUICK_MODEL_DEGRADE_PREFIX\}。原因：\$\{reason\}`/,
    to: 'notice: `${QUICK_MODEL_DEGRADE_PREFIX}：当前拿不到模型选择接口。`',
    expect: '降级提示里的成因必须是真的那一个，不许再写死',
  },
  {
    name: 'B10 接线复辟：提交路径不再把"出口可达"告诉提示（用户被叫去点不存在的出口）',
    file: COMPONENT,
    from: /clearExitReachable: quickModelSelection !== null,/,
    to: 'clearExitReachable: false,',
    expect: '有残留选择时提示必须告诉用户出口在哪',
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
