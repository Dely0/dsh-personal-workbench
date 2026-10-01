/**
 * 「AI 会话工作区」选择器的候选集与标签 —— **唯一权威**（2026-10-01，批次2 #2）。
 *
 * ## 为什么要有这个文件
 *
 * 在它出现之前，候选集是 `index.tsx` 里现场拼的一行：
 *
 * ```ts
 * [...new Set([...(settings.quickWorkspaceRecent ?? []), ...openWorkspacePaths(runtime), settings.defaultWorkspace])]
 * ```
 *
 * 三个问题：
 * 1. **去重口径是 `Set` 的逐字比较**，而全项目对"同一个工作区目录"的比较口径是
 *    `shared/quickWorkspaceRecent.ts#recentWorkspaceKey`（大小写、尾分隔符、`\` 与 `/` 都算同一个）。
 *    于是 `D:\Code\X` 与 `d:/code/x/` 会同时出现在候选里。
 * 2. 它只喂给 `<datalist>`（浏览器原生输入提示），**没有"已打开的工作区"下拉语义** ——
 *    用户反馈的正是"工作区只能手打，不能从已有工作区里选"。
 * 3. 批次2 要给三个入口（快速录入 / 新建任务 / 编辑任务）共用，再在组件里各拼一遍
 *    就是本项目最大的 bug 类别"同一语义多处计算"。
 *
 * ## 硬约束
 *
 * 不 import React、不碰 DOM、不读 `document` —— 可被 `node --test` 直接测。
 */
import { recentWorkspaceKey } from '../shared/quickWorkspaceRecent.js'

/** 候选来源。顺序即优先级：已打开的工作区 > 最近手动选择 > 系统默认工作区。 */
export type WorkspaceCandidateSource = 'open' | 'recent' | 'default'

export interface WorkspaceCandidate {
  /** 原始路径（照原样展示与写入，不做归一化改写）。 */
  readonly path: string
  readonly source: WorkspaceCandidateSource
}

export interface WorkspaceCandidateInput {
  /** 宿主已注册的工作区路径（`workspaces.list` 快照）。 */
  readonly open?: readonly string[] | null
  /** `settings.quickWorkspaceRecent`（最近手动选择，最新的排最前）。 */
  readonly recent?: readonly string[] | null
  /** `settings.defaultWorkspace`。 */
  readonly defaultWorkspace?: string | null
}

/**
 * 候选条数上限。
 *
 * 12 是"够用且不至于把下拉撑成一屏半"的经验值：已打开工作区通常 1–5 个，
 * 最近手动选择另有 5 个上限（`QUICK_WORKSPACE_RECENT_LIMIT`），加默认值最多溢出一点点。
 */
export const WORKSPACE_CANDIDATE_LIMIT = 12

/**
 * 把三个来源并按 **`recentWorkspaceKey` 去重**成一个候选列表。
 *
 * 去重保留**最靠前**的那条原文（即已打开工作区的写法优先）—— 与
 * `normalizeRecentWorkspaces` 的"保留最靠前"一致，不另立一套。
 */
export function workspaceCandidates(input: WorkspaceCandidateInput): WorkspaceCandidate[] {
  const out: WorkspaceCandidate[] = []
  const seen = new Set<string>()
  const push = (value: unknown, source: WorkspaceCandidateSource): void => {
    /**
     * 只接受字符串：这些值来自宿主快照与设置（可能是手改过的 meta、旧版本客户端写的数组），
     * 用 `String(value)` 兜会把 `42` 变成候选路径 `'42'` —— 界面上多出一个点了必然失败的选项。
     */
    if (typeof value !== 'string') return
    const path = value.trim()
    if (path === '') return
    const key = recentWorkspaceKey(path)
    if (key === '' || seen.has(key)) return
    seen.add(key)
    out.push({ path, source })
  }
  for (const path of input.open ?? []) push(path, 'open')
  for (const path of input.recent ?? []) push(path, 'recent')
  push(input.defaultWorkspace, 'default')
  return out.slice(0, WORKSPACE_CANDIDATE_LIMIT)
}

/** 候选来源的中文标签（下拉选项前缀）。 */
export function workspaceCandidateLabel(source: WorkspaceCandidateSource): string {
  if (source === 'open') return '已打开'
  if (source === 'recent') return '最近'
  return '默认'
}

/**
 * 下拉当前应当选中哪一项。
 *
 * 只有 `value` 与某个候选**同键**时才返回那个候选的原文；否则返回 `''`
 * （＝"这是用户手打的自定义路径"，下拉落回占位项）—— 界面不猜、不改写用户输入。
 */
export function selectedCandidatePath(value: string, candidates: readonly WorkspaceCandidate[]): string {
  const key = recentWorkspaceKey(value)
  if (key === '') return ''
  const hit = candidates.find((candidate) => recentWorkspaceKey(candidate.path) === key)
  return hit === undefined ? '' : hit.path
}

/** 下拉的占位项文案（没有可用工作区时说清原因，不给一个永远点不动的空下拉）。 */
export function candidatePlaceholder(candidates: readonly WorkspaceCandidate[]): string {
  return candidates.length === 0 ? '（宿主没有已打开的工作区）' : '选择已有工作区…'
}
