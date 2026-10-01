/**
 * 任务进度 / 待验收的**客户端纯投影**（零 React、零 DOM、零网络）。
 *
 * ## 为什么单独成模块
 *
 * 「这一行要不要画进度条、画多少、要不要显示待验收徽标」是一个**判定**，
 * 而本项目最大的 bug 类别就是"同一语义在两个地方各算一遍"。所以：
 *
 * - 判定只有一份：`shared/taskProgress.ts#projectProgress()`（服务端也用同一个函数）；
 * - 本模块只负责**把数据折成调用方要的最小形状**（`Map` / 记录），不做任何 I/O；
 * - `index.tsx`（巨型组件）与 `components/TaskProgress.tsx` 都**只消费**这里的输出，
 *   绝不在渲染体里另写一套 `statusCode === 'done' ? ...` 的分支。
 *
 * 因为不碰 DOM/React，`node --test` 能直接测它 —— 而写在 `.tsx` 里的判定测不了。
 */
import type { PendingCompletionView } from '../shared/contracts.js'
import { projectProgress, type ProgressProjection } from '../shared/taskProgress.js'
import type { Task } from './viewTypes.js'

export type { ProgressProjection }

/**
 * 待验收投影：把服务端返回的列表折成 `taskId → { deferred }`。
 *
 * `available === false` 表示服务端**拿不到**这份投影（更旧的服务端）→ 返回 `null`，
 * 调用方必须按"不支持"处理：不显示任何待验收徽标，**不推测**。
 * `null` 与"空 Map（确实没有人待验收）"是两件不同的事，不能合并。
 */
export function pendingCompletionMap(view: PendingCompletionView | null | undefined): ReadonlyMap<string, { deferred: boolean }> | null {
  if (view === null || view === undefined || view.available !== true) return null
  const map = new Map<string, { deferred: boolean }>()
  for (const item of view.items) {
    if (typeof item?.taskId !== 'string' || item.taskId === '') continue
    map.set(item.taskId, { deferred: item.deferred === true })
  }
  return map
}

export interface TaskProgressViewInput {
  task: Task
  /** **直接**子任务（不递归）——不传/空数组表示"没有子任务旁证"。 */
  children?: ReadonlyArray<Task>
  /** 来自 `pendingCompletionMap()`；`null` = 服务端不支持这份投影。 */
  pending?: ReadonlyMap<string, { deferred: boolean }> | null
}

/**
 * 折出某个任务要画的进度视图。
 *
 * 三件事在这里一次算清，调用方不再判：
 * 1. `showBar`/`percent` —— 画不画进度条、多少；
 * 2. `badge` —— 待验收 / 待验收（暂存）/ 已完成 / 已取消 / 已归档（没有就不画）；
 * 3. `childLabel` / `hint` —— 直接子任务旁证与"子任务全完成但本任务未完成"的提示。
 *
 * ⚠️ 待验收徽标只在 `pending !== null`（服务端确实提供了投影）时出现。
 */
export interface TaskProgressView {
  /** 是否画进度条（`done`/`cancelled`/已归档/待验收都**不画**：那些状态用徽标表达）。 */
  showBar: boolean
  /** 要显示的百分比（`showBar` 为 false 时也会给出，供 aria/提示用）。 */
  percent: number
  /** 徽标文案（没有徽标时为 null）。 */
  badge: string | null
  /** 徽标类型：待验收 / 暂存 / 终态。 */
  badgeKind: 'pending' | 'deferred' | 'terminal' | null
  /** 直接子任务旁证（无子任务时 null）。 */
  childLabel: string | null
  /** 旁证与状态矛盾时的提示（如"子任务已全部完成，是否把本任务标记完成？"）。 */
  hint: string | null
}

export function taskProgressView(input: TaskProgressViewInput): TaskProgressView {
  const task = input.task
  /**
   * 边界归一化：客户端 `archived` 是 `boolean`，共享契约的 `PublicTask.archived` 是 `0|1`。
   * **只在这里转一次** —— 把共享投影放宽成 `boolean | number` 会让那个类型失去
   * "契约字段"的意义，而在两边各判一次正是要避免的"同一语义两处实现"。
   *
   * 旧服务端不下发 `progressPercent`（`undefined`）→ 按 0 处理。
   * 这**不是**"假装有进度"，而是"没有人写过进度"的正确读数（迁移 19 也把旧任务一律置 0）。
   */
  const normalizedTask = {
    ...task,
    archived: task.archived ? 1 : 0,
    progressPercent: typeof task.progressPercent === 'number' ? task.progressPercent : 0,
  }
  const completion = input.pending === null || input.pending === undefined ? undefined : input.pending.get(task.id)
  const projection = projectProgress({ task: normalizedTask, children: input.children ?? [], completion })

  const badgeKind: TaskProgressView['badgeKind'] = projection.pendingLabel !== null
    ? (projection.pendingLabel.includes('暂存') ? 'deferred' : 'pending')
    : projection.terminalLabel !== null ? 'terminal' : null
  const badge = projection.pendingLabel ?? projection.terminalLabel

  return {
    showBar: projection.state === 'progress',
    percent: projection.percent,
    badge,
    badgeKind,
    childLabel: projection.childLabel,
    hint: projection.hint,
  }
}
