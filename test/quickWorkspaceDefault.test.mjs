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
 *
 * 行为级接线（把源码里真实的 `openQuickEntry` 抽出来跑）在
 * `test/quickIntakeDefaultWiring.test.mjs`；「最近手动选择」列表的合并/删除在
 * `shared/quickWorkspaceRecent.ts`，前后端共用（服务端整表替换语义的单测在 `routes.test.mjs`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  decideQuickWorkspaceDefault, quickFollowFolderDefault, quickWorkspaceSourceLabel, shouldRememberQuickWorkspace,
} from '../lib/client/quickWorkspaceDefault.js'
import {
  forgetRecentWorkspace, mergeRecentWorkspaces, normalizeRecentWorkspaces, QUICK_WORKSPACE_RECENT_LIMIT,
  recentWorkspaceKey, sameRecentWorkspaces,
} from '../lib/shared/quickWorkspaceRecent.js'

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

/** 按名字切出一个 `const name = ... => { ... }` 的函数体（行为级测试与扫描共用）。 */
function functionBody(source, name) {
  const matched = new RegExp(`const ${name} = [^\\n]*=> \\{([\\s\\S]*?)\\r?\\n  \\}`).exec(source)
  return matched === null ? null : matched[1]
}

test('接线 v1.15.2：判定与投影的接线不许再读"当前选中任务"', () => {
  const { stripped } = readSource('../src/client/index.tsx')
  const openBody = functionBody(stripped, 'openQuickEntry')
  assert.ok(openBody !== null, '没找到 openQuickEntry 实现（改名了就要同步这条断言）')
  assert.match(openBody, /decideQuickWorkspaceDefault\(\{/, '默认值必须由纯函数判定给，不许在组件里重新推导')
  assert.match(openBody, /applyQuickWorkspaceDecision\(/, '投影只能走 applyQuickWorkspaceDecision（唯一一处）')
  const applyBody = functionBody(stripped, 'applyQuickWorkspaceDecision')
  assert.ok(applyBody !== null, '没找到 applyQuickWorkspaceDecision（改名了就要同步这条断言）')
  for (const [label, body] of [['openQuickEntry', openBody], ['applyQuickWorkspaceDecision', applyBody]]) {
    assert.equal(/\bselected\b/.test(body), false,
      `${label} 不许读 selected —— 那正是"执行过任务 A 之后默认值变成 A 的工作区"的成因`)
    assert.equal(/effectiveWorkspacePath/.test(body), false, `${label} 不许读任何任务工作区字段`)
  }
  assert.match(applyBody, /setQuickWorkspaceSource\(decided\.source\)/, '来源提示也要由判定一并给出')
  // 界面上的来源文案只允许来自 quickWorkspaceSourceLabel，不许再内联判断
  assert.match(stripped, /quickWorkspaceSourceLabel\(quickWorkspaceSource\)/)
  assert.equal(/继承自父任务/.test(stripped), false, '「继承自父任务」这句界面文案已随判定一起删掉')
  // 同义的另一句（审查 F4）：快速录入里 task 恒为 null，clarify 分支明确排除父任务 —— 这句是假的
  assert.equal(/跟随父任务/.test(stripped), false, '「跟随父任务」在快速录入里永远不成立，不许再写进提示')
})

test('接线 v1.15.2：把工作区记进「最近手动选择」必须先过 touched 闸门', () => {
  const { stripped } = readSource('../src/client/index.tsx')
  assert.match(stripped, /shouldRememberQuickWorkspace\(quickWorkspaceTouched, chosen\)/,
    'rememberQuickWorkspace 的调用必须先问 shouldRememberQuickWorkspace')
  assert.equal(/if \(chosen !== ''\) void rememberQuickWorkspace/.test(stripped), false,
    '不许退回"只要非空就记"：自动预填的值会被记成"上次手动选择"，下一轮就是默认值')
  const rememberBody = functionBody(stripped, 'rememberQuickWorkspace')
  assert.ok(rememberBody !== null, '没找到 rememberQuickWorkspace（改名了就要同步这条断言）')
  assert.match(rememberBody, /sameRecentWorkspaces\(/, '同值不写：算出来一样就别发请求')
  // recent 同时是下一次的默认值来源 —— 这条链只在设置接口那一处写
  const settingsWriters = stripped.match(/quickWorkspaceRecent:/g) ?? []
  assert.ok(settingsWriters.length >= 1, 'rememberQuickWorkspace 仍要写 quickWorkspaceRecent')
  // 设置弹窗不得整表回传这个列表（服务端是整表替换语义，陈旧快照会把并发记下的顶掉）
  const saveBody = functionBody(stripped, 'saveSettings')
  assert.ok(saveBody !== null, '没找到 saveSettings（改名了就要同步这条断言）')
  assert.match(saveBody, /const \{ quickWorkspaceRecent: _ignored, \.\.\.editable \} = settings/,
    'saveSettings 必须把 quickWorkspaceRecent 摘掉')
  /**
   * ⚠️ 断言必须落在"**发出去的是 editable**"这个语义上（复审 N2）：
   * 只断言解构那一行的话，把 POST 体改回 `JSON.stringify(settings)` 照样全绿
   * （`editable` 变成未使用变量，而 tsconfig 没有 noUnusedLocals，typecheck 也不报）。
   */
  assert.match(saveBody, /JSON\.stringify\(editable\)/, '发出去的必须是摘掉 quickWorkspaceRecent 的 editable')
  assert.equal(/JSON\.stringify\(settings\)/.test(saveBody), false,
    '不许再整表发 settings —— 那会让陈旧快照把并发记下的工作区顶掉')
  // 「不再记住」必须带后置校验：提交成功但记录还在（宿主是旧的合并语义）= 静默失败
  const forgetBody = functionBody(stripped, 'forgetQuickWorkspace')
  assert.ok(forgetBody !== null, '没找到 forgetQuickWorkspace（改名了就要同步这条断言）')
  assert.match(forgetBody, /sameRecentWorkspaces\(res\.settings\.quickWorkspaceRecent, next\)/,
    '删完要核对服务端真的按整表落库了，否则用户以为删掉了、下次它又回来')
  // 基准必须是**服务端当前值**，不是弹窗打开那一刻的本地快照（复审 N1）
  assert.match(forgetBody, /const snapshot = await api<\{ settings: WorkbenchSettings \}>\('\/api\/workbench\/settings'\)/,
    '删除前要现读服务端的当前列表，否则陈旧快照会顺手抹掉别的窗口刚记下的条目')
  assert.match(forgetBody, /forgetRecentWorkspace\(snapshot\.settings\.quickWorkspaceRecent, path\)/,
    '算整表要用刚读到的服务端快照')
  /**
   * 复审 N3：F1 的**用户可见出口**必须真的接在界面上 ——
   * 只守 `forgetQuickWorkspace` 的函数体的话，把渲染条件改成 false 也能全绿。
   */
  assert.match(stripped,
    /\{quickWorkspaceSource === 'last-manual' && quickWorkspace\.trim\(\) !== '' && !quickWorkspaceTouched && \(/,
    '「不再记住」按钮的渲染条件少了就等于这个出口不存在（判定说"上次手动选择"时必须给得出按钮）')
  assert.match(stripped, /onClick=\{\(\) => void forgetQuickWorkspace\(quickWorkspace\)\}/,
    '按钮必须真的调用 forgetQuickWorkspace')
})

/**
 * 上面那条扫的是"预填相关的两个函数"；这条扫的是"所有能让预填值变化的写入点"。
 *
 * 为什么要两条：真正的语义是「预填值只能由判定结果或用户输入决定」。
 * 只盯那两个函数的话，未来在别处加一句 `setQuickWorkspace(task.effectiveWorkspacePath)`
 * （换个入口、加个"跟随任务"按钮）照样能溜过去。
 */
test('接线 v1.15.2：setQuickWorkspace 的实参只允许是判定结果或用户输入', () => {
  const { stripped } = readSource('../src/client/index.tsx')
  const args = [...stripped.matchAll(/setQuickWorkspace\(([^)]*)\)/g)].map((matched) => matched[1].trim())
  assert.ok(args.length >= 2, `预期至少两处写入（打开时预填 + 用户输入），实际 ${args.length} 处`)
  for (const argument of args) {
    assert.ok(
      argument === 'decided.path' || argument === 'e.target.value',
      `setQuickWorkspace(${argument}) 不是允许的形态：预填值只能来自 decideQuickWorkspaceDefault 的结果`
        + '或用户输入 —— 任何"从某个任务/最近执行过的东西派生"的写法都会重新引入本次事故',
    )
  }
})

// ------------------------------------------------------- 「最近手动选择」列表本身（shared/）

test('quickWorkspaceRecent: 归一化 = 去空白 / 按比较键去重 / 截断到上限', () => {
  assert.deepEqual(normalizeRecentWorkspaces(['a', 'A\\', '   ', 'b', 42, 'c', 'd', 'e', 'f']),
    ['a', 'b', 'c', 'd', 'e'])
  assert.equal(normalizeRecentWorkspaces(['a', 'b', 'c', 'd', 'e', 'f']).length, QUICK_WORKSPACE_RECENT_LIMIT)
  assert.deepEqual(normalizeRecentWorkspaces(null), [], '脏值（手改 meta / 旧版本形状）当空列表')
  assert.deepEqual(normalizeRecentWorkspaces('不是数组'), [])
  assert.equal(recentWorkspaceKey('  D:\\Code\\Proj\\  '), 'd:/code/proj')
})

test('quickWorkspaceRecent: 合并 = 置顶 + 去重（同一目录再选一次要挪到第一位）', () => {
  assert.deepEqual(mergeRecentWorkspaces(['W1', 'W2'], 'W3'), ['W3', 'W1', 'W2'])
  assert.deepEqual(mergeRecentWorkspaces(['W1', 'W2'], 'W2'), ['W2', 'W1'],
    '审查 F5：修前实现"已存在就直接 return"，于是预填仍是 W1（而它现在是默认值来源）')
  assert.deepEqual(mergeRecentWorkspaces(['W1', 'w1\\'], 'W1'), ['W1'], '大小写/结尾分隔符差异算同一个')
  assert.deepEqual(mergeRecentWorkspaces(null, 'W'), ['W'])
  assert.deepEqual(mergeRecentWorkspaces(['W'], '   '), ['W'], '空白输入不改变列表')
})

test('quickWorkspaceRecent: 删除 = 删得掉（这是"改回默认工作区"的唯一路径）', () => {
  assert.deepEqual(forgetRecentWorkspace(['W1', 'W2'], 'W1'), ['W2'])
  assert.deepEqual(forgetRecentWorkspace(['W1', 'W2'], 'w1\\'), ['W2'], '比较键相同即同一条')
  assert.deepEqual(forgetRecentWorkspace(['W1'], '别的'), ['W1'])
  assert.deepEqual(forgetRecentWorkspace(['W1'], 'W1'), [], '清空后默认值就回到设置里的默认工作区')
})

test('quickWorkspaceRecent: 同值不写（否则每个 tick 都可能发一次写请求）', () => {
  assert.equal(sameRecentWorkspaces(['W1', 'W2'], ['W1', 'W2']), true)
  assert.equal(sameRecentWorkspaces(['W1', 'W2'], ['w1\\', 'W2']), true, '比较键相同即等价')
  assert.equal(sameRecentWorkspaces(['W1', 'W2'], ['W2', 'W1']), false, '顺序变了就要写（置顶靠它）')
  assert.equal(sameRecentWorkspaces(['W1'], ['W1', 'W2']), false)
  assert.equal(sameRecentWorkspaces(null, []), true)
})

test('quickFollowFolderDefault: 只看全局开关与"有没有目标目录"，不按路径来源分叉', () => {
  assert.equal(quickFollowFolderDefault('D:\\root', true), true)
  assert.equal(quickFollowFolderDefault('D:\\root', false), false)
  assert.equal(quickFollowFolderDefault('', true), false, '没有目标目录就没什么可建')
  assert.equal(quickFollowFolderDefault('   ', true), false)
  assert.equal(quickFollowFolderDefault(null, true), false)
  /**
   * 审查 F2 的正面断言：同一份设置下，"路径来自哪里"不参与判定。
   * 按来源分叉（例如 `source === 'system-default'` 才勾）会让"上次手动选择"这一支
   * 静默把默认勾选翻成 false —— 新任务的文件就不再落进 `W/<任务ID>-<标题片段>`。
   */
  assert.equal(
    quickFollowFolderDefault('W', true),
    quickFollowFolderDefault('D', true),
    '两条不同来源的路径在同一个开关下必须给出同一个默认勾选',
  )
})
