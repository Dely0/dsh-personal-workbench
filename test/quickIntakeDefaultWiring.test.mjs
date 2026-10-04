/**
 * 「快速录入默认工作区」的**行为级接线**测试（v1.15.2，fresh-eyes 审查 F3 的收口）。
 *
 * ## 为什么需要这个文件
 *
 * `test/quickWorkspaceDefault.test.mjs` 里的接线断言都是"源码里有没有这个字符串"的**形态扫描**：
 * 判定函数本身有判定表，但**调用点**（`recent:` / `isWsl:` 传了什么、`followFolder` 怎么算）
 * 一条行为断言都没有 —— 审查用变异证明过：
 *
 * | 变异 | 形态扫描 | 本文件 |
 * |---|---|---|
 * | R3 `followFolder` 改成忽略 source/开关 | 绿 | **红** |
 * | R4 调用点把 `recent` 传成 `[]` | 绿 | **红** |
 * | R5 调用点把 `isWsl` 传成 `false` | 绿 | **红** |
 *
 * ## 做法：跑**源码里真实的**函数，而不是手写复刻
 *
 * 从 `src/client/index.tsx` 里逐字抽出 `openQuickEntry` 与 `applyQuickWorkspaceDecision`
 * 的函数体，用一个只提供外部依赖（判定函数、setState、宿主探测）的桩包成真函数调用。
 * 于是"改源码 → 结果必变"是构造上成立的：抽不到就显式失败，绝不静默跳过。
 *
 * 这是本项目里"组件逻辑不可测"的既定解法之一（同 `test/quickIntakeClient.test.mjs` 的扫描断言 +
 * `scripts/repro/verify-quick-workspace-fix.mjs` 的修前/修后对照）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideQuickWorkspaceDefault, quickFollowFolderDefault, shouldRememberQuickWorkspace,
} from '../lib/client/quickWorkspaceDefault.js'
import { read, stripComments } from './_clientSources.mjs'

/**
 * D17/P6-2 之后，工作区预填的**真实 owner** 是快速录入域的 hook：
 * `openIntake`（打开弹窗）与它调用的 `applyDecision`（把判定结果投影到那几个状态上）。
 * 入口 `src/client/index.tsx` 只剩「跨域组合」的 `openQuickEntry` 与提交闸门。
 *
 * 判据跟着 owner 走：函数体从新 owner 里抽（抽不到就失败），入口那两条形态断言（提交闸门、
 * `quickWorkspaceSourceLabel`）仍读入口。
 */
const HOOK_SOURCE = read('src/client/hooks/useWorkbenchQuickIntake.ts')
const SOURCE = read('src/client/index.tsx')
/** D17/P7-2：提交闸门那行随快速录入弹窗搬进 app/WorkbenchDialogs.tsx。 */
const DIALOGS_SOURCE = read('src/client/app/WorkbenchDialogs.tsx')

/** 切出 `const name = ... => { ... }` 的函数体（缩进 2 空格的收尾大括号）。 */
function functionBody(source, name) {
  const matched = new RegExp(`const ${name} = [^\\n]*=> \\{([\\s\\S]*?)\\r?\\n  \\}`).exec(source)
  return matched === null ? null : matched[1]
}

/**
 * 把源码里真实的 `openIntake`（+ 它调用的投影函数 `applyDecision`）装成可调用的函数。
 *
 * @returns `null` = 源码结构变了（抽不到）—— 调用方必须**失败**，不能跳过。
 */
function buildOpenQuickEntry() {
  const openBody = functionBody(HOOK_SOURCE, 'openIntake')
  const applyBody = functionBody(HOOK_SOURCE, 'applyDecision')
  if (openBody === null || applyBody === null) return null
  const factory = new Function('deps', `
    'use strict'
    const { settings, runtime, state, detectWslHost, decideQuickWorkspaceDefault, quickFollowFolderDefault } = deps
    const setQuickText = (value) => { state.quickText = value }
    const setQuickWorkspace = (value) => { state.quickWorkspace = value }
    const setQuickWorkspaceSource = (value) => { state.quickWorkspaceSource = value }
    const setQuickWorkspaceTouched = (value) => { state.quickWorkspaceTouched = value }
    const setQuickFollowFolder = (value) => { state.quickFollowFolder = value }
    const setShowQuick = (value) => { state.showQuick = value }
    /*
     * 角色/技能复位（T4/D13-B + 2026-10-01）仍在**装配层**的 openQuickEntry 里
     * （P6-3 会换成 AI 会话域的 resetClarifyPicker）—— 本文件测的是工作区预填，
     * 那两行不在 openIntake 里，所以这里不再需要桩。
     */
    const applyDecision = (decided, autoCreateTypeFolders) => {${applyBody}}
    return () => {${openBody}}
  `)
  return (input) => {
    const state = {}
    factory({
      settings: input.settings,
      runtime: {},
      state,
      detectWslHost: () => input.isWsl === true,
      decideQuickWorkspaceDefault,
      quickFollowFolderDefault,
    })()
    return state
  }
}

const open = buildOpenQuickEntry()

test('接线行为：抽得到源码里真实的 openIntake / applyDecision（抽不到就是这条红，不是静默跳过）', () => {
  assert.ok(open !== null,
    '抽不到 openIntake / applyDecision —— 结构变了就要同步本文件与 '
    + 'scripts/repro/verify-quick-workspace-fix.mjs，不能让它静默不测')
})

/**
 * 比"行为上没用 selected"更强的一条：快速录入域的 hook **构造上就拿不到** selected ——
 * 它的入参里没有任务、也没有选中项（这正是 v1.15.2 那次事故的修法）。
 *
 * 扫的是**剥注释后**的源码：hook 的文档注释里必须留着"原实现是从 selected 派生"这段历史。
 */
test('接线行为：快速录入域的入参里没有 selected / effectiveWorkspacePath（构造上不可能继承父任务）', () => {
  const stripped = stripComments(HOOK_SOURCE)
  assert.doesNotMatch(stripped, /\bselected\b/,
    '快速录入域一旦能看见 selected，就会重新长出"执行过任务 A → 默认值变成 A 的工作区"这条污染')
  assert.doesNotMatch(stripped, /effectiveWorkspacePath/)
})

test('接线行为：预填值只由设置决定，且调用点真的把 recent / defaultWorkspace 传对了', () => {
  assert.ok(open !== null)
  // 有"上次手动选择" → 用它；任务 A 的工作区 X 一个字都不许出现
  // （P6-2 之后这条是**构造上**成立的：`useWorkbenchQuickIntake` 的入参里没有 selected）
  const withRecent = open({
    settings: { quickWorkspaceRecent: ['R0', 'R1'], defaultWorkspace: 'D0', autoCreateTypeFolders: true },
  })
  assert.equal(withRecent.quickWorkspace, 'R0',
    'R4 变异（调用点把 recent 传成 []）会让这里变成 D0 —— 那正是本次事故的形态')
  assert.equal(withRecent.quickWorkspaceSource, 'last-manual')
  // 空列表 → 落到系统默认
  const withoutRecent = open({
    settings: { quickWorkspaceRecent: [], defaultWorkspace: 'D0', autoCreateTypeFolders: true },
  })
  assert.equal(withoutRecent.quickWorkspace, 'D0')
  assert.equal(withoutRecent.quickWorkspaceSource, 'system-default')
  // 都没有 → 空
  const empty = open({ settings: { quickWorkspaceRecent: [], defaultWorkspace: '' } })
  assert.equal(empty.quickWorkspace, '')
  assert.equal(empty.quickWorkspaceSource, 'unset')
  // 打开弹窗要清空输入、要真的弹出来、并且预填值不算"用户改过"
  assert.equal(empty.quickText, '')
  assert.equal(empty.showQuick, true)
  assert.equal(empty.quickWorkspaceTouched, false)
})

test('接线行为：调用点真的把 isWsl 传对了（否则 WSL 下预填成 Windows 形态）', () => {
  assert.ok(open !== null)
  const windowsPath = 'D:\\Code\\proj'
  const wsl = open({ settings: { quickWorkspaceRecent: [], defaultWorkspace: windowsPath }, isWsl: true })
  assert.equal(wsl.quickWorkspace, '/mnt/d/Code/proj',
    'R5 变异（调用点把 isWsl 传成 false）会让这里保持 D:\\Code\\proj')
  const native = open({ settings: { quickWorkspaceRecent: [], defaultWorkspace: windowsPath }, isWsl: false })
  assert.equal(native.quickWorkspace, windowsPath)
})

test('接线行为：建任务资料夹的默认勾选与 quickFollowFolderDefault 逐字一致', () => {
  assert.ok(open !== null)
  for (const autoCreateTypeFolders of [true, false]) {
    for (const path of ['D:\\root', 'W', '']) {
      const state = open({ settings: { quickWorkspaceRecent: [path].filter((item) => item !== ''), defaultWorkspace: path === '' ? '' : 'OTHER', autoCreateTypeFolders } })
      assert.equal(state.quickFollowFolder, quickFollowFolderDefault(state.quickWorkspace, autoCreateTypeFolders),
        `path=${JSON.stringify(path)} autoCreate=${autoCreateTypeFolders}：`
        + '默认勾选必须由 quickFollowFolderDefault 给出（按路径来源分叉会让"上次手动选择"静默丢掉任务资料夹）')
    }
  }
})

/**
 * 提交闸门也是"源码里的真实表达式"：`if (<expr>) void rememberQuickWorkspace(chosen)`。
 *
 * 这条守的是第二条腿（自动预填的值被记成"上次手动选择" → 默认值自激污染）。
 */
function buildRememberGate() {
  const marker = 'void rememberQuickWorkspace(chosen)'
  const index = DIALOGS_SOURCE.indexOf(marker)
  if (index === -1) return null
  const head = DIALOGS_SOURCE.slice(0, index)
  const openParen = head.lastIndexOf('if (')
  if (openParen === -1) return null
  const start = openParen + 3
  let depth = 0
  for (let i = start; i < head.length; i += 1) {
    if (head[i] === '(') depth += 1
    else if (head[i] === ')') {
      depth -= 1
      if (depth === 0) {
        const expression = head.slice(start + 1, i)
        const evaluate = new Function('quickWorkspaceTouched', 'chosen', 'shouldRememberQuickWorkspace', `return (${expression})`)
        return (touched, chosen) => evaluate(touched, chosen, shouldRememberQuickWorkspace)
      }
    }
  }
  return null
}

test('接线行为：提交闸门用的是源码里真实的表达式，且自动预填的值不会被记下来', () => {
  const gate = buildRememberGate()
  assert.ok(gate !== null, '没找到 `if (<expr>) void rememberQuickWorkspace(chosen)` —— 结构变了要同步本文件')
  assert.equal(gate(false, 'X'), false, '没动过输入框 → 不许记（否则默认值自激污染）')
  assert.equal(gate(false, ''), false)
  assert.equal(gate(true, 'W'), true, '用户真动过 → 要记住（便利功能不能被一起修掉）')
  assert.equal(gate(true, '   '), false)
})
