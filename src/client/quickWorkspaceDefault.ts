/**
 * 「快速录入的默认工作区」——唯一权威判定（v1.15.2）。
 *
 * ## 修的真事故（2026-09-16 真机复现）
 *
 * 用户现象：**执行过一次某个任务之后，快速录入的默认工作区就变成了那个任务的工作区**。
 *
 * 根因不在"执行"，而在**默认值的来源**：`openQuickEntry()` 原来写的是
 *
 * ```ts
 * const inherited = selected?.task.effectiveWorkspacePath ?? ''
 * const base = inherited !== '' ? inherited : settings.defaultWorkspace
 * ```
 *
 * 即**从"当前选中的任务"派生**。而"执行任务"这件事在客户端留下的状态恰好就是它：
 *
 * 1. 「AI 执行」按钮只出现在任务详情里 → 点它之前 `selected` 必然 = 被执行的任务 A；
 * 2. `startAISession` 结尾 `closePanel()` 只是把面板**收起来**（`data-open` 摘掉），
 *    React 树从不卸载 → `selected` 原样留着；
 * 3. 用户再打开工作台点「快速录入」→ 默认工作区 = A 的工作区 X。
 *
 * 换句话说：**"快速录入该用哪个目录"与"我最近在看/执行哪个任务"共用了 `selected` 这一个状态**。
 * 而这两件事没有任何关系 —— 换任务、执行任务都不该改变新任务默认落在哪个目录。
 *
 * ## 判据（只有这一处实现）
 *
 * 1. **上次手动选过的目录**（`settings.quickWorkspaceRecent` 里最近的一条）——用户自己定的，最不意外；
 * 2. 否则用**系统默认工作区**（`settings.defaultWorkspace`）；
 * 3. 都没有 → 空（交给 DSH 当前工作区，与改动前一致）。
 *
 * **输入里刻意不含任何任务 / 选中项**：默认值只由"用户偏好"与"系统配置"两点决定，
 * 从类型上就杜绝了"再被某个任务污染"。
 *
 * ## 硬约束
 *
 * 不 import React、不碰 DOM、不读 `document` —— 可被 `node --test` 直接测。
 */
import { normalizeWindowsPathToWsl } from './workspacePath.js'
import { normalizeRecentWorkspaces } from '../shared/quickWorkspaceRecent.js'

/** 参与判定的设置片段（只声明用得到的字段）。 */
export interface QuickWorkspaceDefaultInput {
  /** 用户手动选择过的工作区，最新的排最前（对应 `settings.quickWorkspaceRecent`）。 */
  readonly recent?: readonly string[] | null
  /** 系统默认工作区（对应 `settings.defaultWorkspace`）。 */
  readonly defaultWorkspace?: string | null
  /** 宿主是否跑在 WSL（决定要不要把 `D:\x` 归一化成 `/mnt/d/x`）。 */
  readonly isWsl?: boolean
}

/**
 * 默认值的来源。**它是给用户看的一句话**（见 `quickWorkspaceSourceLabel`），
 * 所以必须由判定一并给出 —— 让界面自己再猜一遍就是"同一个语义两处实现"。
 */
export type QuickWorkspaceDefaultSource = 'last-manual' | 'system-default' | 'unset'

export interface QuickWorkspaceDefaultDecision {
  /** 应当预填进「AI 会话工作区」输入框的路径；`''` = 不预填。 */
  readonly path: string
  readonly source: QuickWorkspaceDefaultSource
}

/**
 * 算出「快速录入」应当预填的工作区。
 *
 * 输入只有用户偏好与系统配置 —— **任何"当前选中/最近执行的任务"都不参与**。
 */
export function decideQuickWorkspaceDefault(input: QuickWorkspaceDefaultInput): QuickWorkspaceDefaultDecision {
  const normalize = (value: string): string => (input.isWsl === true ? normalizeWindowsPathToWsl(value) : value)
  /** 归一化只有一处实现（`shared/quickWorkspaceRecent.ts`）：这里只需问"最靠前的那一条是什么"。 */
  const manual = normalizeRecentWorkspaces(input.recent)[0]
  if (manual !== undefined) return { path: normalize(manual), source: 'last-manual' }
  const fallback = String(input.defaultWorkspace ?? '').trim()
  if (fallback !== '') return { path: normalize(fallback), source: 'system-default' }
  return { path: '', source: 'unset' }
}

/**
 * 「在该工作区下建任务资料夹」的默认勾选。
 *
 * 口径 = **全局设置本身的语义**（"自动为每个任务创建独立文件夹"）+ 有目标目录。
 * 刻意**不按路径来源分叉**（fresh-eyes 审查 F2）：
 * 按来源分叉会让"上次手动选择"这一支静默把默认勾选从 true 翻成 false，
 * 于是新任务的文件不再落进 `W/<任务ID>-<标题片段>`、提示词里也没有 `workspace_path` ——
 * 那正是 v1.15.1 任务资料夹改造要消灭的"文件散在目录里"。
 */
export function quickFollowFolderDefault(path: string, autoCreateTypeFolders: boolean): boolean {
  return autoCreateTypeFolders === true && String(path ?? '').trim() !== ''
}

/**
 * 默认值来源的中文说明（输入框右侧那行小字）。
 *
 * 用户点过输入框之后界面显示"手动指定"，那属于**本次交互状态**，由组件按 `touched` 覆盖。
 */
export function quickWorkspaceSourceLabel(source: QuickWorkspaceDefaultSource): string {
  if (source === 'last-manual') return '上次手动选择'
  if (source === 'system-default') return '使用默认工作区'
  return '未设置（DSH 当前工作区）'
}

/**
 * 这次提交要不要把工作区记进「最近手动选择」（`settings.quickWorkspaceRecent`）？
 *
 * ⚠️ **必须带 `touched`**：这个列表同时是**下一次的默认值来源**，
 * 所以只有"用户真的动过这个输入框"的选择才有资格写进去。
 * 无脑记的话，自动预填进来的值会在下一次变成"上次手动选择" —— 自激污染，
 * 也就是本次事故的第二条腿（真机复现时 `recent[0]` 会被执行任务的目录顶掉）。
 */
export function shouldRememberQuickWorkspace(touched: boolean, path: string): boolean {
  return touched && String(path ?? '').trim() !== ''
}
