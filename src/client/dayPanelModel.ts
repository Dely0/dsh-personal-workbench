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
 * - 三个任务页签的成员口径 = `dayPanelTabMembers`（计划 ∪ 逾期 ∪ 未排期，2026-10-02 口径补充），
 *   **不在这里再写一遍过滤公式**。
 */
import { useCallback, useMemo } from 'react'
import { capacityDayRange } from './capacity.js'
import { buildTaskTree, filterTaskTree, type TaskTreeNode } from './taskFilterSort.js'
import { sameDay } from './format.js'
import {
  dayPanelExtraTabsAvailable, dayPanelSourceLabel, dayPanelTabMembers,
} from '../shared/dailyPlanPolicy.js'
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
  /** 「逾期」/「未排期」在该日是否可见（过去日期不可见，见 ADR0001 口径补充）。 */
  extraTabsAvailable: boolean
  plan: DailyPlanView | null
  candidateRows: Array<{ id: string; title: string }>
  promptInfo: { truncated: boolean; notice: string }
  planTree: TaskTreeNode<Task>[]
  overdueTree: TaskTreeNode<Task>[]
  unscheduledTree: TaskTreeNode<Task>[]
  doneTree: TaskTreeNode<Task>[]
  doneContextIds: Set<string>
  overdueContextIds: Set<string>
  unscheduledContextIds: Set<string>
  expanded: Set<string>
  onToggleExpanded: (taskId: string) => void
  sourceLabelOf: (taskId: string) => string | null
  /**
   * 已排进这一天的 taskId（= 「计划」页签成员）。
   *
   * 给「排入今日」用：逾期页签里"已在计划中"的行是**事实重叠**，不该再给一个只会返回
   * "已经在计划里"的按钮 —— 这里给出集合，由组件决定隐藏。
   */
  plannedIds: Set<string>
}

/**
 * "只是上下文、不是成员"的行（父/祖父链）：**唯一实现**。
 *
 * 三个页签（已完成 / 逾期 / 未排期）都要同一件事 —— 把为保住树形而保留的祖先灰化、
 * 且不计入计数。三处各写一遍遍历就是本项目最大的 bug 类别，所以收成一个函数。
 */
function contextIdsOf(tree: TaskTreeNode<Task>[], isMember: (task: Task) => boolean): Set<string> {
  const ids = new Set<string>()
  const walk = (nodes: TaskTreeNode<Task>[]): void => {
    for (const node of nodes) {
      if (!isMember(node.task)) ids.add(node.task.id)
      walk(node.children)
    }
  }
  walk(tree)
  return ids
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
  /** 「逾期」/「未排期」只对今天与未来有意义（过去日期不显示，判定在纯模块里）。 */
  const extraTabsAvailable = useMemo(
    () => dayPanelExtraTabsAvailable(day, todayAnchor),
    [day, todayAnchor],
  )

  /**
   * 三个任务页签的成员判定：**唯一口径**（`dayPanelTabMembers` 内部复用
   * `dayPanelTreeSources` 与 `classifyTaskDay`）。这里一条都不自己 filter。
   */
  const members = useMemo(
    () => dayPanelTabMembers({
      tasks,
      planItems: (plan?.items ?? []).map((item) => ({ taskId: item.taskId })),
      ...capacityDayRange(isTodayView ? todayDate : pickedDate),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用日键代替 Date（同 capacityTodayKey 的做法）
    [tasks, plan, day],
  )
  const plannedIds = useMemo(() => new Set(members.plan.map((entry) => entry.taskId)), [members])
  const overdueKeep = useMemo(() => new Set(members.overdue), [members])
  const unscheduledKeep = useMemo(() => new Set(members.unscheduled), [members])
  const sourceLabelOf = useCallback((taskId: string): string | null => {
    const entry = members.plan.find((item) => item.taskId === taskId)
    if (entry === undefined) return null
    return entry.sources.map(dayPanelSourceLabel).join(' · ')
  }, [members])

  const planOrder = useMemo(() => {
    if (plan === null || plan.items.length === 0) return undefined
    return new Map(plan.items.map((item) => [item.taskId, item.order]))
  }, [plan])
  const planTree = useMemo(
    () => filterTaskTree(buildTaskTree(tasks, planOrder), (task) => plannedIds.has(task.id)),
    [tasks, plannedIds, planOrder],
  )
  /** 逾期 / 未排期两棵树不带计划顺序（它们不是"这一天要按什么顺序做"，而是清欠与待安排）。 */
  const overdueTree = useMemo(
    () => filterTaskTree(buildTaskTree(tasks), (task) => overdueKeep.has(task.id)),
    [tasks, overdueKeep],
  )
  const unscheduledTree = useMemo(
    () => filterTaskTree(buildTaskTree(tasks), (task) => unscheduledKeep.has(task.id)),
    [tasks, unscheduledKeep],
  )

  /** 已完成：按 `completedAt` 落在这一天（与旧口径逐字一致）。 */
  const doneKeep = useCallback(
    (task: Task): boolean => task.completedAt !== null && sameDay(new Date(task.completedAt), isTodayView ? todayDate : pickedDate),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上
    [day],
  )
  const doneTree = useMemo(() => filterTaskTree(buildTaskTree(tasks), doneKeep), [tasks, doneKeep])
  // 已完成面板中保留的父/祖父链只是上下文，不计入统计，也以灰色弱化展示。
  const doneContextIds = useMemo(() => contextIdsOf(doneTree, doneKeep), [doneTree, doneKeep])
  const overdueContextIds = useMemo(
    () => contextIdsOf(overdueTree, (task) => overdueKeep.has(task.id)),
    [overdueTree, overdueKeep],
  )
  const unscheduledContextIds = useMemo(
    () => contextIdsOf(unscheduledTree, (task) => unscheduledKeep.has(task.id)),
    [unscheduledTree, unscheduledKeep],
  )

  return {
    day, isToday, readOnly, extraTabsAvailable, plan, candidateRows, promptInfo,
    planTree, overdueTree, unscheduledTree, doneTree,
    doneContextIds, overdueContextIds, unscheduledContextIds,
    expanded, onToggleExpanded, sourceLabelOf, plannedIds,
  }
}
