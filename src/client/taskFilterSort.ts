/**
 * 任务列表页筛选/排序纯函数。
 * 与 React 解耦，便于单元测试；浏览器端由 client bundle 引入。
 */

export type TaskSortKey = 'dueAt' | 'priority' | 'createdAt' | 'title'
export type TaskSortDir = 'asc' | 'desc'

export interface TaskFilterState {
  keyword: string
  statusCodes: string[]
  priorityCodes: string[]
  typeCodes: string[]
}

export const EMPTY_TASK_FILTER: TaskFilterState = Object.freeze({ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] })

export function isTaskFilterEmpty(filter: TaskFilterState): boolean {
  return filter.keyword.trim() === '' && filter.statusCodes.length === 0 && filter.priorityCodes.length === 0 && filter.typeCodes.length === 0
}

export interface TaskLike {
  id: string
  parentId: string | null
  title: string
  description: string
  statusCode: string
  priorityCode: string
  typeCode: string
  dueAt: string | null
  /** 动态有效截止时间：未设置 own dueAt 时由后端继承最近祖先的 dueAt。 */
  effectiveDueAt?: string | null
  completedAt: string | null
  createdAt: string
}

export interface TaskTreeNode<T> {
  task: T
  children: TaskTreeNode<T>[]
}

export function matchesTaskFilter(task: TaskLike, filter: TaskFilterState): boolean {
  const keyword = filter.keyword.trim().toLowerCase()
  if (keyword !== '') {
    const haystack = `${task.title}\n${task.description ?? ''}`.toLowerCase()
    if (!haystack.includes(keyword)) return false
  }
  if (filter.statusCodes.length > 0 && !filter.statusCodes.includes(task.statusCode)) return false
  if (filter.priorityCodes.length > 0 && !filter.priorityCodes.includes(task.priorityCode)) return false
  if (filter.typeCodes.length > 0 && !filter.typeCodes.includes(task.typeCode)) return false
  return true
}

export function compareTasks<T extends TaskLike>(
  a: T,
  b: T,
  key: TaskSortKey,
  dir: TaskSortDir,
  priorityWeight: Map<string, number> = new Map(),
): number {
  const factor = dir === 'asc' ? 1 : -1
  switch (key) {
    case 'dueAt': {
      const at = (t: T): number | null => {
        const due = t.effectiveDueAt ?? t.dueAt
        if (due !== null) {
          const n = Date.parse(due)
          if (!Number.isNaN(n)) return n
        }
        // 已完成任务无有效截止时间时，列表右侧展示的是完成时间，排序也按它参与。
        if (t.statusCode === 'done' && t.completedAt !== null) {
          const n = Date.parse(t.completedAt)
          if (!Number.isNaN(n)) return n
        }
        return null
      }
      const av = at(a)
      const bv = at(b)
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return (av - bv) * factor
    }
    case 'priority': {
      const weight = (t: T): number => priorityWeight.get(t.priorityCode) ?? Number.MAX_SAFE_INTEGER
      const diff = weight(a) - weight(b)
      if (diff !== 0) return diff * factor
      break
    }
    case 'createdAt': {
      const diff = a.createdAt.localeCompare(b.createdAt)
      if (diff !== 0) return diff * factor
      break
    }
    case 'title': {
      const diff = a.title.localeCompare(b.title, 'zh-Hans-CN')
      if (diff !== 0) return diff * factor
      break
    }
  }
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

export function createTaskSorter<T extends TaskLike>(
  key: TaskSortKey,
  dir: TaskSortDir,
  priorityWeight?: Map<string, number>,
): (a: T, b: T) => number {
  return (a, b) => compareTasks(a, b, key, dir, priorityWeight)
}

export function buildTaskTree<T extends TaskLike>(
  tasks: T[],
  orderOf?: Map<string, number>,
  sortFn?: (a: T, b: T) => number,
): TaskTreeNode<T>[] {
  const byParent = new Map<string | null, T[]>()
  for (const task of tasks) {
    const list = byParent.get(task.parentId) ?? []
    list.push(task)
    byParent.set(task.parentId, list)
  }
  const unlisted = Number.MAX_SAFE_INTEGER
  const walk = (id: string | null): TaskTreeNode<T>[] => {
    const siblings = byParent.get(id) ?? []
    if (sortFn !== undefined) {
      siblings.sort(sortFn)
    } else {
      siblings.sort((a, b) => (orderOf?.get(a.id) ?? unlisted) - (orderOf?.get(b.id) ?? unlisted) || a.createdAt.localeCompare(b.createdAt))
    }
    return siblings.map((task) => ({ task, children: walk(task.id) }))
  }
  return walk(null)
}

export function filterTaskTree<T>(roots: TaskTreeNode<T>[], keep: (task: T) => boolean): TaskTreeNode<T>[] {
  const walk = (nodes: TaskTreeNode<T>[]): TaskTreeNode<T>[] => {
    const out: TaskTreeNode<T>[] = []
    for (const node of nodes) {
      const children = walk(node.children)
      if (keep(node.task) || children.length > 0) out.push({ task: node.task, children })
    }
    return out
  }
  return walk(roots)
}

/** 统计树中满足 keep 的任务数量；父链上下文节点不会被计入。 */
export function countTaskTreeBy<T>(roots: TaskTreeNode<T>[], keep: (task: T) => boolean): number {
  return roots.reduce((sum, node) => sum + (keep(node.task) ? 1 : 0) + countTaskTreeBy(node.children, keep), 0)
}

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()

/** 判断任务是否在某一天有有效截止时间，且未取消。日历标记统一使用该条件。 */
export function isTaskDueOnDay<T extends TaskLike>(task: T, day: Date): boolean {
  return task.effectiveDueAt != null && sameDay(new Date(task.effectiveDueAt), day) && task.statusCode !== 'cancelled'
}
