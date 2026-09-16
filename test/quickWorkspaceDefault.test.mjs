/**
 * 「快速录入的默认工作区」回归（v1.15.2）。
 *
 * ## 真实事故（2026-09-16 真机复现，截图在 `_local-archive/quick-workspace-default/before/`）
 *
 * 用户执行过一次任务 A（工作区 X）之后，打开「快速录入」，「AI 会话工作区」
 * 预填的就是 X，提示还写着「继承自父任务「…」」。
 *
 * 成因不是"执行时写坏了什么"，而是默认值**从当前选中的任务派生**：
 * 「AI 执行」按钮只在任务详情里（所以点它时 `selected` 必然 = 任务 A），
 * 而 `closePanel()` 只把面板收起来、React 树从不卸载 → 用户下次打开面板时
 * `selected` 还是 A → 默认值就是 A 的工作区。
 *
 * 本文件守两件事：
 * 1. **判定表**（`decideQuickWorkspaceDefault`）：输入只有"用户偏好 + 系统配置"，
 *    没有任何任务/选中项 —— "任务字段传进来也不参与判定"要有实测；
 * 2. **接线**：`openQuickEntry` 不得再读选中任务；提交时"要不要记进最近手动选择"
 *    必须走 `shouldRememberQuickWorkspace`（否则自动预填的值会自己污染自己）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  decideQuickWorkspaceDefault, quickWorkspaceSourceLabel, shouldRememberQuickWorkspace,
} from '../lib/client/quickWorkspaceDefault.js'

// ---------------------------------------------------------------- 判定表

test('quickWorkspaceDefault: 上次手动选择 > 系统默认 > 未设置', () => {
  assert.deepEqual(
    decideQuickWorkspaceDefault({ recent: ['X'], defaultWorkspace: 'D' }),
    { path: 'X', source: 'last-manual' },
  )
  assert.deepEqual(
    decideQuickWorkspaceDefault({ recent: [], defaultWorkspace: 'D' }),
    { path: 'D', source: 'system-default' },
  )
  assert.deepEqual(
    decideQuickWorkspaceDefault({ recent: [], defaultWorkspace: '' }),
    { path: '', source: 'unset' },
  )
  // 脏值一律当"没选过"（手改过 meta / 旧版本写过别的形状）
  assert.deepEqual(decideQuickWorkspaceDefault({}), { path: '', source: 'unset' })
  assert.deepEqual(decideQuickWorkspaceDefault({ recent: null, defaultWorkspace: null }), { path: '', source: 'unset' })
  assert.deepEqual(decideQuickWorkspaceDefault({ recent: undefined, defaultWorkspace: 'D' }), { path: 'D', source: 'system-default' })
})

test('quickWorkspaceDefault: 空白条目跳过、前后空格去掉、只有第一条算"上次"', () => {
  assert.deepEqual(decideQuickWorkspaceDefault({ recent: ['   '], defaultWorkspace: 'D' }), { path: 'D', source: 'system-default' })
  assert.deepEqual(decideQuickWorkspaceDefault({ recent: ['', '  Y  '], defaultWorkspace: 'D' }), { path: 'Y', source: 'last-manual' })
  assert.deepEqual(decideQuickWorkspaceDefault({ recent: ['X', 'Y'], defaultWorkspace: 'D' }), { path: 'X', source: 'last-manual' })
  assert.deepEqual(decideQuickWorkspaceDefault({ recent: [], defaultWorkspace: '  D  ' }), { path: 'D', source: 'system-default' })
})

test('quickWorkspaceDefault: WSL 下把 Windows 形态归一化（两种来源都要）', () => {
  assert.deepEqual(
    decideQuickWorkspaceDefault({ recent: ['D:\\Code\\proj'], defaultWorkspace: 'E:\\x', isWsl: true }),
    { path: '/mnt/d/Code/proj', source: 'last-manual' },
  )
  assert.deepEqual(
    decideQuickWorkspaceDefault({ recent: [], defaultWorkspace: 'D:\\Code\\proj', isWsl: true }),
    { path: '/mnt/d/Code/proj', source: 'system-default' },
  )
  // 已在 /mnt 下的原样返回
  assert.equal(decideQuickWorkspaceDefault({ recent: ['/mnt/d/x'], isWsl: true }).path, '/mnt/d/x')
  // 非 WSL：逐字保留（别把 Windows 路径改成 /mnt/...）
  assert.equal(decideQuickWorkspaceDefault({ recent: ['D:\\Code\\proj'], isWsl: false }).path, 'D:\\Code\\proj')
})

/**
 * **本次事故的正面断言**：把"当前选中/最近执行的任务"塞进输入，判定结果**不许**改变。
 *
 * 这条比"读代码没看到 selected"强 —— 它直接锁住"任务不参与默认值"这个语义。
 */
test('quickWorkspaceDefault: 任务/选中项不参与判定（传进来也必须被忽略）', () => {
  const polluted = {
    recent: ['W'],
    defaultWorkspace: 'D',
    // 老实现读的就是这两个字段：`selected.task.effectiveWorkspacePath`
    selected: { task: { id: 'A', title: '任务 A', effectiveWorkspacePath: 'X' } },
    selectedTask: { effectiveWorkspacePath: 'X' },
    recentTaskWorkspace: 'X',
  }
  assert.deepEqual(decideQuickWorkspaceDefault(polluted), { path: 'W', source: 'last-manual' })
  assert.deepEqual(
    decideQuickWorkspaceDefault({ ...polluted, recent: [] }),
    { path: 'D', source: 'system-default' },
    '没有手动选择时用系统默认 —— 绝不能是那个"最近执行过"的任务工作区 X',
  )
})

test('quickWorkspaceSourceLabel: 三种来源各有说法，界面不再自己判一遍', () => {
  const labels = ['last-manual', 'system-default', 'unset'].map(quickWorkspaceSourceLabel)
  assert.deepEqual(labels, ['上次手动选择', '使用默认工作区', '未设置（DSH 当前工作区）'])
  assert.equal(new Set(labels).size, 3)
  for (const label of labels) assert.notEqual(label.trim(), '')
})

// ---------------------------------------------------------------- 记不记进「最近手动选择」

test('quickWorkspaceDefault: 只有"用户真动过输入框"的选择才配被记下来', () => {
  assert.equal(shouldRememberQuickWorkspace(true, 'X'), true)
  assert.equal(shouldRememberQuickWorkspace(false, 'X'), false, '自动预填的值不许记 —— 那会让默认值自己污染自己')
  assert.equal(shouldRememberQuickWorkspace(true, ''), false)
  assert.equal(shouldRememberQuickWorkspace(true, '   '), false)
  assert.equal(shouldRememberQuickWorkspace(false, ''), false)
})

// ---------------------------------------------------------------- 接线（源码扫描）

/** 去掉注释再扫：解释性注释里会逐字引用错误写法（老测试踩过这个坑）。 */
function readSource(relative) {
  const raw = readFileSync(new URL(relative, import.meta.url), 'utf8')
  return {
    raw,
    stripped: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
  }
}

test('接线 v1.15.2：openQuickEntry 不得再从"当前选中任务"派生默认工作区', () => {
  const { stripped } = readSource('../src/client/index.tsx')
  const matched = /const openQuickEntry = \(\): void => \{([\s\S]*?)\r?\n  \}/.exec(stripped)
  assert.ok(matched !== null, '没找到 openQuickEntry 实现（改名了就要同步这条断言）')
  const body = matched[1]
  assert.match(body, /decideQuickWorkspaceDefault\(\{/, '默认值必须由纯函数判定给，不许在组件里重新推导')
  assert.equal(/\bselected\b/.test(body), false,
    'openQuickEntry 不许读 selected —— 那正是"执行过任务 A 之后默认值变成 A 的工作区"的成因')
  assert.equal(/effectiveWorkspacePath/.test(body), false,
    'openQuickEntry 不许读任何任务工作区字段')
  assert.match(body, /setQuickWorkspaceSource\(decided\.source\)/, '来源提示也要由判定一并给出')
  // 界面上的来源文案只允许来自 quickWorkspaceSourceLabel，不许再内联判断
  assert.match(stripped, /quickWorkspaceSourceLabel\(quickWorkspaceSource\)/)
  assert.equal(/继承自父任务/.test(stripped), false, '「继承自父任务」这句界面文案已随判定一起删掉')
})

test('接线 v1.15.2：把工作区记进「最近手动选择」必须先过 touched 闸门', () => {
  const { stripped } = readSource('../src/client/index.tsx')
  assert.match(stripped, /shouldRememberQuickWorkspace\(quickWorkspaceTouched, chosen\)/,
    'rememberQuickWorkspace 的调用必须先问 shouldRememberQuickWorkspace')
  assert.equal(/if \(chosen !== ''\) void rememberQuickWorkspace/.test(stripped), false,
    '不许退回"只要非空就记"：自动预填的值会被记成"上次手动选择"，下一轮就是默认值')
  // recent 同时是下一次的默认值来源 —— 这条链只在设置接口那一处写
  const settingsWriters = stripped.match(/quickWorkspaceRecent:/g) ?? []
  assert.ok(settingsWriters.length >= 1, 'rememberQuickWorkspace 仍要写 quickWorkspaceRecent')
})
