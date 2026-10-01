/**
 * 日期面板的**装配数据层**（批次2 D15 的第二个片段）。
 *
 * ## 为什么要从 index.tsx 里搬出来
 *
 * D15 把「今日」与「日历选中某天」合成同一个面板后，`index.tsx` 里需要一份
 * "当前面板是那一天、它的树/计划/页签数据长什么样"的派生值。第一版直接写在那儿，
 * 结果 `index.tsx` **变长了**（5743 → 5774）—— 而 D15 的出口判据恰恰是"它必须变短"。
 *
 * 所以这一层搬到这里：判定与派生照旧只有一份实现（纯函数都在
 * `shared/dailyPlanPolicy.ts` / `taskFilterSort.ts`），`index.tsx` 只保留**一次调用**。
 *
 * ## 边界
 *
 * - 只做派生，不做请求、不写 DOM；输入全是显式快照（含"每一天"的展开集合与提示信息）；
 * - 树的成员口径 = `dayPanelTreeSources`（当日到期 ∪ 当日计划项 ∪ 进行中），
 *   **不在这里再写一遍过滤公式**。
 */
import { useCallback, useMemo } from 'react'
import { capacityDayRange } from './capacity.js'
import { buildTaskTree, filterTaskTree, type TaskTreeNode } from './taskFilterSort.js'
import { sameDay } from './format.js'
import { dayPanelSourceLabel, dayPanelTreeSources } from '../shared/dailyPlanPolicy.js'
import type { DailyPlanView, Task } from './viewTypes.js'

export interface DayPanelModelInput {
  /** 当前是不是「今日」视图（决定取哪一份锚点、计划、展开集合、提示信息）。 */
  isTodayView: boolean
  tasks: Task[]
  /** 今日与日历各自的快照 —— 调用点按 `isTodayView` 选，模型不猜。 */
  todayPlan: DailyPlanView | null
  pickedPlan: DailyPlanView | null
  todayCandidateRows: Array<{ id: string; title: string }>
  pickedCandidateRows: Array<{ id: string; title: string }>
  todayExpanded: Set<string>
  calendarExpanded: Set<string>
  todayToggleExpanded: (taskId: string) => void
  calendarToggleExpanded: (taskId: string) => void
  todayPromptInfo: { truncated: boolean; notice: string }
  pickedPromptInfo: { truncated: boolean; notice: string }
  /** 今日与选中那天的本地日键。 */
  todayAnchor: string
  pickedAnchor: string
  /** 选中那天的 Date（算"已完成"与日界用）。 */
  pickedDate: Date
  /** 今日的 Date（`now`）。 */
  todayDate: Date
}

export interface DayPanelModel {
  day: string
  isToday: boolean
  readOnly: boolean
  plan: DailyPlanView | null
  candidateRows: Array<{ id: string; title: string }>
  promptInfo: { truncated: boolean; notice: string }
  planTree: TaskTreeNode<Task>[]
  doneTree: TaskTreeNode<Task>[]
  doneContextIds: Set<string>
  expanded: Set<string>
  onToggleExpanded: (taskId: string) => void
  sourceLabelOf: (taskId: string) => string | null
}

export function useDayPanelModel(input: DayPanelModelInput): DayPanelModel {
  const {
    isTodayView, tasks, todayPlan, pickedPlan, todayCandidateRows, pickedCandidateRows,
    todayExpanded, calendarExpanded, todayToggleExpanded, calendarToggleExpanded,
    todayPromptInfo, pickedPromptInfo, todayAnchor, pickedAnchor, pickedDate, todayDate,
  } = input

  const day = isTodayView ? todayAnchor : pickedAnchor
  const isToday = day === todayAnchor
  const plan = isTodayView ? todayPlan : pickedPlan
  const candidateRows = isTodayView ? todayCandidateRows : pickedCandidateRows
  const expanded = isTodayView ? todayExpanded : calendarExpanded
  const onToggleExpanded = isTodayView ? todayToggleExpanded : calendarToggleExpanded
  const promptInfo = isTodayView ? todayPromptInfo : pickedPromptInfo
  const readOnly = day < todayAnchor

  /** 树来源判定：**唯一口径**（`dayPanelTreeSources`），候选池用的是同一个 `classifyTaskDay`。 */
  const sourceInfo = useMemo(
    () => dayPanelTreeSources({
      tasks,
      planItems: (plan?.items ?? []).map((item) => ({ taskId: item.taskId })),
      ...capacityDayRange(isTodayView ? todayDate : pickedDate),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用日键代替 Date（同 capacityTodayKey 的做法）
    [tasks, plan, day],
  )
  const keep = useMemo(() => new Set(sourceInfo.entries.map((entry) => entry.taskId)), [sourceInfo])
  const sourceLabelOf = useCallback((taskId: string): string | null => {
    const entry = sourceInfo.entries.find((item) => item.taskId === taskId)
    if (entry === undefined) return null
    return entry.sources.map(dayPanelSourceLabel).join(' · ')
  }, [sourceInfo])

  const planOrder = useMemo(() => {
    if (plan === null || plan.items.length === 0) return undefined
    return new Map(plan.items.map((item) => [item.taskId, item.order]))
  }, [plan])
  const planTree = useMemo(
    () => filterTaskTree(buildTaskTree(tasks, planOrder), (task) => keep.has(task.id)),
    [tasks, keep, planOrder],
  )

  /** 已完成：按 `completedAt` 落在这一天（与旧口径逐字一致）。 */
  const doneKeep = useCallback(
    (task: Task): boolean => task.completedAt !== null && sameDay(new Date(task.completedAt), isTodayView ? todayDate : pickedDate),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上
    [day],
  )
  const doneTree = useMemo(() => filterTaskTree(buildTaskTree(tasks), doneKeep), [tasks, doneKeep])
  // 已完成面板中保留的父/祖父链只是上下文，不计入统计，也以灰色弱化展示。
  const doneContextIds = useMemo(() => {
    const ids = new Set<string>()
    const walk = (nodes: TaskTreeNode<Task>[]): void => {
      for (const node of nodes) {
        if (!doneKeep(node.task)) ids.add(node.task.id)
        walk(node.children)
      }
    }
    walk(doneTree)
    return ids
  }, [doneTree, doneKeep])

  return { day, isToday, readOnly, plan, candidateRows, promptInfo, planTree, doneTree, doneContextIds, expanded, onToggleExpanded, sourceLabelOf }
}
