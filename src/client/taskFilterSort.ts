/**
 * 任务列表页筛选/排序纯函数。
 * 与 React 解耦，便于单元测试；浏览器端由 client bundle 引入。
 */

export type TaskSortKey = 'dueAt' | 'priority' | 'createdAt' | 'title'
export type TaskSortDir = 'asc' | 'desc'

export interface TaskFilterState {
  keyword: string
  statusCode: string
  priorityCode: string
  typeCode: string
}

export const EMPTY_TASK_FILTER: TaskFilterState = Object.freeze({ keyword: '', statusCode: '', priorityCode: '', typeCode: '' })

export function isTaskFilterEmpty(filter: TaskFilterState): boolean {
  return filter.keyword.trim() === '' && filter.statusCode === '' && filter.priorityCode === '' && filter.typeCode === ''
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
  if (filter.statusCode !== '' && task.statusCode !== filter.statusCode) return false
  if (filter.priorityCode !== '' && task.priorityCode !== filter.priorityCode) return false
  if (filter.typeCode !== '' && task.typeCode !== filter.typeCode) return false
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
        if (t.dueAt === null) return null
        const n = Date.parse(t.dueAt)
        return Number.isNaN(n) ? null : n
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
