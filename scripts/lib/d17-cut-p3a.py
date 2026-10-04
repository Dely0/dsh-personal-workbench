#!/usr/bin/env python3
"""D17 P3-1：把"任务页左侧列表"域从 `src/client/index.tsx` 搬走。

一次性做完：接线 `useTaskListModel`（调用点仍在原 state 声明处）→ 左侧视图换成 `<TaskListView>` →
删掉旧 state / 落盘 effect / `toggleExpanded` / 派生（priorityWeights / taskSorter / visibleTaskTree /
taskTypeTabs）→ 改 `collapseAll` → 收拾 import。

每处替换都要求命中恰好 1 次，命中不对或"已应用"以外的偏差一律整体中止、不写文件。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, "rb").read().decode("utf-8")
src = src.replace("\r\n", "\n").replace("\r", "\n")


def sub1(old, new, tag):
    global src
    if new in src and old not in src:
        print(f"  --  {tag}（已应用，跳过）")
        return
    n = src.count(old)
    if n != 1:
        i = src.find(old) if n else -1
        ctx = src[max(0, i - 200):i + 200] if i >= 0 else ""
        raise SystemExit(f"ABORT [{tag}] 命中 {n} 次\n  ctx={ctx!r}")
    src = src.replace(old, new, 1)
    print(f"  ok  {tag}")


# ============================================================ 0. 接线：useTaskListModel
BLOCK_A = '''  // 树展开状态（列表树记住用户展开）
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([])
  const [archivedMode, setArchivedMode] = useState(false)
  const [taskFilter, setTaskFilter] = useState<TaskFilterState>({ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] })
  const [taskSortKey, setTaskSortKey] = useState<TaskSortKey>('dueAt')
  const [taskSortDir, setTaskSortDir] = useState<TaskSortDir>('asc')
  const [openFilter, setOpenFilter] = useState<'status' | 'priority' | 'type' | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('dsh.personal-workbench.treeExpanded') ?? '[]') as string[]) } catch { return new Set() }
  })
  useEffect(() => {
    try { localStorage.setItem('dsh.personal-workbench.treeExpanded', JSON.stringify([...expanded])) } catch { /* ignore */ }
  }, [expanded])
  const toggleExpanded = (id: string): void => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
'''
BLOCK_A_NEW = '''  /**
   * D17 / P3-1：任务列表域（state / 落盘 / 派生 / 动作）已经收进 `hooks/useTaskListModel.ts`。
   *
   * ⚠️ 调用点仍在原来那批 state 的声明处（`const` 没有提升）：入参 `tasks` / `dictOf` 到这里都已声明，
   * hook 内部的调用次序也与拆分前那批 `useState` / `useMemo` 一致。常驻在顶层、不放进条件视图，
   * 所以切视图不会重置列表的筛选与展开集合（设计 §4.2）。
   */
  const taskList = useTaskListModel({ tasks, dictOf })
'''
sub1(BLOCK_A, BLOCK_A_NEW, "接线 useTaskListModel（替换 7 个 state + 落盘 effect + toggleExpanded）")

# ============================================================ 1. collapseAll 改调本域动作
sub1("  const collapseAll = (): void => { setExpanded(new Set()); setTodayExpanded(new Set()); setCalendarExpanded(new Set()) }",
     "  const collapseAll = (): void => { taskList.actions.clearExpanded(); setTodayExpanded(new Set()); setCalendarExpanded(new Set()) }",
     "collapseAll 改为 taskList.actions.clearExpanded()")

# ============================================================ 2. 删派生（保留中间那条与此无关的注释）
sub1("  const priorityWeights = useMemo(() => new Map(dictOf('priority').map((d) => [d.code, Number(d.config.weight ?? 99)])), [dicts])\n",
     "", "删 priorityWeights")

BLOCK_C = '''  const taskSorter = useMemo(() => createTaskSorter(taskSortKey, taskSortDir, priorityWeights), [taskSortKey, taskSortDir, priorityWeights])
  const visibleTaskTree = useMemo(() => {
    const source = archivedMode ? archivedTasks : tasks
    return filterTaskTree(buildTaskTree(source, undefined, taskSorter), (t) => matchesTaskFilter(t, taskFilter))
  }, [archivedMode, archivedTasks, tasks, taskSorter, taskFilter])
  /**
   * 任务页的类型 Tab：条数按"搜索 + 状态 + 优先级"算，**不含类型自身** ——
   * 每个 Tab 显示的是"切过去能看到几条"（与知识库的 Tab 徽标同一套口径，走同一个 buildTabs）。
   */
  const taskTypeDicts = useMemo(() => dictOf('type'), [dictOf])
  const taskTypeTabs = useMemo(() => {
    const source = archivedMode ? archivedTasks : tasks
    const { byType, all } = countTasksByType(buildTaskTree(source, undefined, taskSorter), taskFilter, taskTypeDicts.map((d) => d.code))
    return buildTabs(taskTypeDicts, { ...byType, all }, { includeOther: false })
  }, [archivedMode, archivedTasks, tasks, taskSorter, taskFilter, taskTypeDicts])
'''
sub1(BLOCK_C, "", "删 taskSorter / visibleTaskTree / taskTypeDicts / taskTypeTabs")

# ============================================================ 3. 左侧视图整块换成一行
START = "          {view === 'list' && (\n"
END = "          )}\n        </div>\n\n        <div className=\"wb-detail\">"
i = src.find(START)
if i < 0:
    raise SystemExit("ABORT 找不到列表视图起点")
j = src.find(END, i)
if j < 0:
    raise SystemExit("ABORT 找不到列表视图终点")
block = src[i:j + len(END)]
for must in ("MultiSelectDropdown", "TaskTreeRows", "taskTypeTabs", "查看归档", "countTaskTree(visibleTaskTree)"):
    if must not in block:
        raise SystemExit(f"ABORT 列表视图块缺标记 {must}")
NEW = ("          {view === 'list' && <TaskListView model={taskList} dictOf={dictOf} dicts={dicts} "
       "selectedId={selected?.task.id} pending={pendingMap} childrenOf={childrenOf} onOpen={openTask} />}\n"
       "        </div>\n\n        <div className=\"wb-detail\">")
src = src[:i] + NEW + src[j + len(END):]
print(f"  ok  左侧列表视图 -{block.count(chr(10)) - 3} 行")

# ============================================================ 4. import 收拾
sub1('''import {
  buildTaskTree,
  countTaskTreeBy,
  countTasksByType,
  createTaskSorter,
  filterTaskTree,
  isTaskDueOnDay,
  isTaskFilterEmpty,
  matchesTaskFilter,
  type TaskFilterState,
  type TaskSortDir,
  type TaskSortKey,
  type TaskTreeNode,
} from './taskFilterSort.js'
''', "import { buildTaskTree, isTaskDueOnDay } from './taskFilterSort.js'\n",
     "taskFilterSort import 收窄")

sub1("import { Badge, MultiSelectDropdown, TaskTreeRows, countTaskTree } from './components/TaskList.js'\n",
     "import { Badge } from './components/TaskList.js'\n", "TaskList import 收窄")

sub1("import { ALL, buildTabs, TabBar, toggleTab } from './components/TabBar.js'\n",
     "", "删 TabBar import")

sub1("import { IdeasDetailPane } from './views/IdeasDetailPane.js'\n",
     "import { IdeasDetailPane } from './views/IdeasDetailPane.js'\n"
     "import { useTaskListModel } from './hooks/useTaskListModel.js'\n"
     "import { TaskListView } from './views/TaskListView.js'\n",
     "加 useTaskListModel / TaskListView import")

open(FILE, "w", encoding="utf-8", newline="\n").write(src)
print(f"lines -> {src.count(chr(10)) + 1}")
