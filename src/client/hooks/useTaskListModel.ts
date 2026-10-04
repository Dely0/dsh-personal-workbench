/**
 * 任务列表域（D17 / P3-1）—— `index.tsx` 里"任务页左侧列表"相关的**唯一所有者**。
 *
 * 从入口拆出来的东西（一一对应，没有第二份实现）：
 * - state：归档集合 / 归档模式 / 筛选 / 排序键 / 排序方向 / 打开的下拉 / 展开集合；
 * - effect：展开集合落盘（键 `dsh.personal-workbench.treeExpanded` 原样保留）；
 * - 派生：优先级权重 / 排序器 / 可见任务树 / 类型 Tab（含条数徽标）；
 * - 动作：筛选增删、清空、类型页签选择、排序、归档切换、展开与全收起。
 *
 * ⚠️ 依赖方向（设计 §3）：本文件是**纯 .ts**（不写 JSX，视图在 `views/TaskListView.tsx` 里），
 * 只 import 纯模块与共享契约，**不得** import `index.tsx`；跨域协作由入口注入。
 *
 * ⚠️ 数据源 `tasks` 属于任务数据域（P3-4 的 `useTaskData`），本 hook 只**读**它；
 * 归档集合是本域自己拉取的（原样），两者一起构成"当前数据源"。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { ALL, buildTabs, toggleTab, type TabItem } from '../components/TabBar.js'
import {
  EMPTY_TASK_FILTER, buildTaskTree, countTasksByType, createTaskSorter, filterTaskTree, matchesTaskFilter,
  type TaskFilterState, type TaskSortDir, type TaskSortKey, type TaskTreeNode,
} from '../taskFilterSort.js'
import type { Dict, Task } from '../viewTypes.js'

/** 树展开集合在 localStorage 里的键（原样保留：换键会让用户的展开状态凭空消失）。 */
const TREE_EXPANDED_STORAGE_KEY = 'dsh.personal-workbench.treeExpanded'

/** 当前被打开的下拉筛选（同一时刻只允许一个）。 */
export type TaskFilterField = 'status' | 'priority' | 'type'

export type UseTaskListModelInput = {
  /** 任务全集（本域只读它；归档模式打开时改用本域自己拉取的归档集合）。 */
  tasks: Task[]
  /** 字典查询（与知识库/点子域共用同一份，来自任务数据域的 bootstrap）。 */
  dictOf: (kind: string) => Dict[]
}

export type UseTaskListModelResult = {
  filter: TaskFilterState
  sortKey: TaskSortKey
  sortDir: TaskSortDir
  openFilter: TaskFilterField | null
  archivedMode: boolean
  /**
   * 归档任务集合的只读快照 —— 容量计算要把它拼进全量列表（归档任务本就不进容量，
   * 为空数组也不影响结果），这是**跨域只读**，可写状态仍然只有本 hook 一份。
   */
  archivedTasks: Task[]
  /** 展开的任务 id 集合（`TaskTreeRows` 要求可变 `Set`，只经 `actions.toggleExpanded` 改）。 */
  expanded: Set<string>
  /**
   * 当前数据源是否为空 —— 两种"空列表"文案由视图按 `archivedMode` 分派。
   * 口径：归档模式看归档集合，否则看任务全集（与拆分前逐字一致）。
   */
  sourceEmpty: boolean
  visibleTree: TaskTreeNode<Task>[]
  typeTabs: TabItem[]
  actions: {
    patchFilter: (patch: Partial<TaskFilterState>) => void
    clearFilter: () => void
    selectType: (code: string, multi: boolean) => void
    setSortKey: (key: TaskSortKey) => void
    toggleSortDir: () => void
    setOpenFilter: (field: TaskFilterField | null) => void
    toggleOpenFilter: (field: TaskFilterField) => void
    toggleArchived: () => void
    /** 直接置归档模式（任务详情里「恢复任务」成功后要退出归档视图，原行为）。 */
    setArchivedMode: (mode: boolean) => void
    toggleExpanded: (id: string) => void
    clearExpanded: () => void
  }
}

export function useTaskListModel({ tasks, dictOf }: UseTaskListModelInput): UseTaskListModelResult {
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([])
  const [archivedMode, setArchivedMode] = useState(false)
  const [filter, setFilter] = useState<TaskFilterState>(EMPTY_TASK_FILTER)
  const [sortKey, setSortKey] = useState<TaskSortKey>('dueAt')
  const [sortDir, setSortDir] = useState<TaskSortDir>('asc')
  const [openFilter, setOpenFilter] = useState<TaskFilterField | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(TREE_EXPANDED_STORAGE_KEY) ?? '[]') as string[]) } catch { return new Set() }
  })
  useEffect(() => {
    try { localStorage.setItem(TREE_EXPANDED_STORAGE_KEY, JSON.stringify([...expanded])) } catch { /* ignore */ }
  }, [expanded])

  const priorityWeights = useMemo(() => new Map(dictOf('priority').map((d) => [d.code, Number(d.config.weight ?? 99)])), [dictOf])
  const taskSorter = useMemo(() => createTaskSorter(sortKey, sortDir, priorityWeights), [sortKey, sortDir, priorityWeights])
  const visibleTree = useMemo(() => {
    const source = archivedMode ? archivedTasks : tasks
    return filterTaskTree(buildTaskTree(source, undefined, taskSorter), (t) => matchesTaskFilter(t, filter))
  }, [archivedMode, archivedTasks, tasks, taskSorter, filter])
  /**
   * 任务页的类型 Tab：条数按"搜索 + 状态 + 优先级"算，**不含类型自身** ——
   * 每个 Tab 显示的是"切过去能看到几条"（与知识库的 Tab 徽标同一套口径，走同一个 buildTabs）。
   */
  const typeDicts = useMemo(() => dictOf('type'), [dictOf])
  const typeTabs = useMemo(() => {
    const source = archivedMode ? archivedTasks : tasks
    const { byType, all } = countTasksByType(buildTaskTree(source, undefined, taskSorter), filter, typeDicts.map((d) => d.code))
    return buildTabs(typeDicts, { ...byType, all }, { includeOther: false })
  }, [archivedMode, archivedTasks, tasks, taskSorter, filter, typeDicts])

  const patchFilter = useCallback((patch: Partial<TaskFilterState>): void => {
    setFilter((prev) => ({ ...prev, ...patch }))
  }, [])
  const clearFilter = useCallback((): void => { setFilter(EMPTY_TASK_FILTER) }, [])
  /** 类型页签：`ALL` 是"全部"哨兵，落回空数组；其余走与知识库同一个 `toggleTab`。 */
  const selectType = useCallback((code: string, multi: boolean): void => {
    setFilter((prev) => {
      const next = toggleTab(prev.typeCodes.length === 0 ? [ALL] : prev.typeCodes, code, multi)
      return { ...prev, typeCodes: next.includes(ALL) ? [] : next }
    })
  }, [])
  const toggleSortDir = useCallback((): void => { setSortDir((prev) => prev === 'asc' ? 'desc' : 'asc') }, [])
  const toggleOpenFilter = useCallback((field: TaskFilterField): void => {
    setOpenFilter((prev) => prev === field ? null : field)
  }, [])
  /**
   * 归档切换：副作用写在更新函数**外面** —— 放进 `setArchivedMode((prev) => …)` 里
   * 会在 React 重复调用更新函数时重复发请求（`api` 请求不是纯计算）。
   */
  const toggleArchived = useCallback((): void => {
    const next = !archivedMode
    setArchivedMode(next)
    if (next) {
      void api<{ tasks: Task[] }>('/api/workbench/tasks?archived=true')
        .then((r) => setArchivedTasks(r.tasks))
        .catch(() => undefined)
    }
  }, [archivedMode])
  const toggleExpanded = useCallback((id: string): void => {
    setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }, [])
  /** 工具栏的"全部收起"只清本域这一份；今日/日历的展开集合属于日期域，由入口一并清（跨域装配）。 */
  const clearExpanded = useCallback((): void => { setExpanded(new Set()) }, [])

  return {
    filter,
    sortKey,
    sortDir,
    openFilter,
    archivedMode,
    archivedTasks,
    expanded,
    sourceEmpty: (archivedMode ? archivedTasks : tasks).length === 0,
    visibleTree,
    typeTabs,
    actions: {
      patchFilter, clearFilter, selectType, setSortKey, toggleSortDir,
      setOpenFilter, toggleOpenFilter, toggleArchived, setArchivedMode, toggleExpanded, clearExpanded,
    },
  }
}
