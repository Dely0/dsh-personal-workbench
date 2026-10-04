# -*- coding: utf-8 -*-
"""D17 / P3-4 一次性搬迁：把任务数据域从 src/client/index.tsx 切进 hooks/useTaskData.ts。

房屋风格同 d17-cut-p3c.py：所有断言先跑完，problems 为空才落盘。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "src" / "client" / "index.tsx"

problems: list[str] = []


def replace_once(text: str, old: str, new: str, label: str) -> str:
    n = text.count(old)
    if n != 1:
        problems.append(f"{label}: 期望恰好 1 处，实际 {n} 处")
        return text
    return text.replace(old, new, 1)


src = INDEX.read_text(encoding="utf-8")
if "\r\n" in src:
    problems.append("index.tsx 含 CRLF，先转成 LF 再搬")
orig_len = len(src.splitlines())

# ---- 1. imports -------------------------------------------------------------
src = replace_once(
    src,
    "import { useTaskForms } from './hooks/useTaskForms.js'\n",
    "import { useTaskForms } from './hooks/useTaskForms.js'\n"
    "import { useTaskData } from './hooks/useTaskData.js'\n",
    "import useTaskData",
)
src = replace_once(
    src,
    "import { pendingCompletionMap, taskProgressView } from './taskProgressView.js'",
    "import { taskProgressView } from './taskProgressView.js'",
    "trim pendingCompletionMap import",
)

# ---- 2. selectedRef + 四个只读派生 + refresh --------------------------------
BLOCK_A_OLD = """  const selectedRef = useRef<string | null>(null)

  const dicts = useMemo(() => bootstrap?.dictionaries ?? [], [bootstrap])
  const dictOf = useCallback((kind: string) => dicts.filter((d) => d.kind === kind), [dicts])

  /**
   * 待验收投影（T1/D04）：一次查询 → 一份 Map → 全列表共用。
   *
   * `pendingCompletionMap()` 在"服务端不支持"时返回 `null`，与"确实没人待验收"（空 Map）
   * 是**两件不同的事**；这个区分一路传到 `taskProgressView()`，界面据此决定要不要显示徽标。
   */
  const pendingMap = useMemo(() => pendingCompletionMap(pendingCompletions), [pendingCompletions])

  /**
   * 直接子任务索引（旁证口径：只算直接子任务，不递归 —— ADR 0004）。
   *
   * 一次遍历建索引，**不是**每条任务 filter 一遍 tasks（那是 O(n²)）。
   */
  const childrenIndex = useMemo(() => {
    const index = new Map<string, Task[]>()
    for (const task of tasks) {
      if (task.parentId === null) continue
      const bucket = index.get(task.parentId)
      if (bucket === undefined) index.set(task.parentId, [task])
      else bucket.push(task)
    }
    return index
  }, [tasks])
  const childrenOf = useCallback((taskId: string) => childrenIndex.get(taskId), [childrenIndex])

  const refresh = useCallback(async () => {
    const [boot, list, pending] = await Promise.all([
      api<Bootstrap>('/api/workbench/bootstrap'),
      api<{ tasks: Task[] }>('/api/workbench/tasks'),
      /**
       * 待验收投影：**列表刷新共用一次**查询（requirements §3.2 明令不做 N+1）。
       * 拿不到（旧服务端没有这个端点）时置 `null` → 界面**不显示任何待验收徽标**，
       * 而不是把每一条都当成"没有待验收"。
       */
      api<PendingCompletionsResponse>('/api/workbench/tasks/pending-completions').then((res) => res.pending).catch(() => null),
    ])
    setBootstrap(boot); setTasks(list.tasks); setPendingCompletions(pending)
    if (selectedRef.current !== null) {
      try {
        const [detail, ev, rv] = await Promise.all([
          api<TaskDetail>(`/api/workbench/tasks/${selectedRef.current}`),
          api<{ events: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${selectedRef.current}/events`).catch(() => ({ events: [] })),
          api<{ reviews: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${selectedRef.current}/reviews`).catch(() => ({ reviews: [] })),
          loadTaskKnowledge(selectedRef.current).catch(() => setTaskKnowledge([])),
        ])
        setSelected({ ...detail, events: ev.events, reviews: rv.reviews })
      } catch { setSelected(null); selectedRef.current = null }
    }
  }, [])
"""
BLOCK_A_NEW = """  // 任务数据域（D17/P3-4）：`selectedRef`、四个只读派生（`dicts`/`dictOf`/`pendingMap`/
  // `childrenIndex`/`childrenOf`）与 `refresh` 全部收进了 hooks/useTaskData.ts。
  //
  // `refresh` 是**整块**搬走的：它一次 `Promise.all` 取 bootstrap + 任务列表 + 待验收投影，
  // 再按最新选中 id 补详情/事件/复盘/关联知识。按设计 §4.1 第 149 行，这几件事
  // *不能*拆成多个各自发请求的动作（那就是 requirements §3.2 明令禁止的 N+1）。
"""
src = replace_once(src, BLOCK_A_OLD, BLOCK_A_NEW, "block A (selectedRef..refresh)")

# ---- 4. loadTaskKnowledge + loadTaskDetail ----------------------------------
BLOCK_B_OLD = """  const loadTaskKnowledge = async (taskId: string): Promise<void> => {
    const res = await api<{ entries: KnowledgeEntry[] }>(`/api/workbench/knowledge?source_task_id=${encodeURIComponent(taskId)}`)
    setTaskKnowledge(res.entries)
  }
  /**
   * 只**刷新详情数据**，不碰视图、不碰页签。
   *
   * ## 为什么必须与"打开任务"分开（2026-10-01 用户报的 BUG）
   *
   * 用户现象："在任何页面修改任务的进度，工作台都会被弹回任务页。"
   * 根因是刷新详情走的是 `openTaskById`，而那个函数第一句就是 `setView('list')`
   * —— 于是一个纯数据刷新带了"切视图 + 重置页签 + 收起事件"三个副作用：
   * 你在日历/今日页改一下进度，就被扔回任务列表，正在看的详情页签也丢了。
   *
   * 约定（写在这里免得下一个人又合回去）：
   * - **导航**（切视图、重置页签）只在"用户明确要打开某个任务"时发生 → `openTask`
   *   / `openTaskById`；
   * - **刷新**（保存进度、完成任务之后重新读一遍）只看数据 → 本函数。
   */
  const loadTaskDetail = (taskId: string): void => {
    selectedRef.current = taskId
    void Promise.all([
      api<TaskDetail>(`/api/workbench/tasks/${taskId}`),
      api<{ events: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${taskId}/events`).catch(() => ({ events: [] })),
      api<{ reviews: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${taskId}/reviews`).catch(() => ({ reviews: [] })),
      loadTaskKnowledge(taskId).catch(() => setTaskKnowledge([])),
    ]).then(([detail, ev, rv]) => setSelected({ ...detail, events: ev.events, reviews: rv.reviews })).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
"""
BLOCK_B_NEW = """  // 任务数据域（D17/P3-4）：`loadTaskKnowledge` 与 `loadTaskDetail` 已收进 hooks/useTaskData.ts
  // （连同上面那段 2026-10-01 的 BUG 约定注释 —— 那条约定的正文原样搬进了 hook，别在这里重写一份）。
  //
  // 下面两个**留在入口**：它们是"加载 + 导航"的组合，按设计 §4.1 第 148 行
  // `openTaskById` 归装配层，由入口把 TaskData 的动作和 Navigation 的 `setView` 拼起来。
"""
src = replace_once(src, BLOCK_B_OLD, BLOCK_B_NEW, "block B (loadTaskKnowledge/loadTaskDetail)")

# ---- 5. patchTask..deferPlanTask -------------------------------------------
BLOCK_C_OLD = """  const patchTask = async (id: string, patch: Record<string, unknown>): Promise<void> => {
    await api(`/api/workbench/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    await refresh()
  }
  const completePlanTask = async (taskId: string): Promise<void> => {
    await patchTask(taskId, { statusCode: 'done' })
  }
  /**
   * 保存显式进度（0–99），T1/D04。
   *
   * 只走 `PATCH progressPercent` —— 100 **不在这里**（服务端也会拒绝 100）：
   * 界面上选 100 是「完成任务」动作，见 `completeTaskFromProgress`。
   * 刷新后重新拉一次详情，保证详情卡里的进度/徽标与服务端一致（不靠本地乐观值）。
   *
   * 刻意不用 `useCallback`：它们读 `tasks` / `selected` / `childrenIndex` 这些每渲染都变的快照，
   * 写依赖数组只会得到一个"看起来优化了、实际依赖不全"的假象；调用点在事件处理器里，
   * 每次渲染重建一个闭包的成本可以忽略。
   */
  const saveProgress = async (taskId: string, percent: number): Promise<void> => {
    await patchTask(taskId, { progressPercent: percent })
    /**
     * 刷新详情但**不动视图**（⑤ 的修复点）。
     * 旧写法是 `openTaskById(taskId)` —— 它内部 `setView('list')`，
     * 于是用户在任何别处（日历/今日页）改进度都会被弹回任务列表。
     */
    if (selectedRef.current === taskId) loadTaskDetail(taskId)
  }
  /**
   * 「完成任务」动作（进度档位里的 100）。
   *
   * 与界面既有的完成操作走**同一条** PATCH `statusCode: 'done'` 路径（服务端会在同一事务内
   * 级联完成未完成子节点并向上聚合），所以提示语也照抄既有语义：
   * 有子任务时必须说清"未完成子任务会级联完成"，让用户先确认再点。
   */
  const completeTaskFromProgress = async (taskId: string): Promise<void> => {
    const task = tasks.find((t) => t.id === taskId) ?? (selectedRef.current === taskId ? selected?.task : undefined)
    const childCount = childrenIndex.get(taskId)?.length ?? 0
    const question = childCount > 0
      ? `完成任务「${task?.title ?? taskId}」？它有 ${childCount} 个直接子任务，未完成的会被一并级联完成。`
      : `把任务「${task?.title ?? taskId}」标记为已完成？`
    if (!window.confirm(question)) return
    await patchTask(taskId, { statusCode: 'done' })
    setNotice('任务已完成（未完成子任务已按既有规则级联完成）')
    /** 同上：完成任务后只刷新详情，不把用户从当前页面弹走。 */
    if (selectedRef.current === taskId) loadTaskDetail(taskId)
  }
  const deferPlanTask = async (taskId: string): Promise<void> => {
    const task = tasks.find((t) => t.id === taskId)
    if (task === undefined) return
    const base = task.effectiveDueAt !== null ? new Date(task.effectiveDueAt) : new Date()
    const next = new Date(base)
    next.setDate(next.getDate() + 1)
    await patchTask(taskId, { dueAt: next.toISOString() })
    setNotice(`已推迟到 ${next.getMonth() + 1}/${next.getDate()}`)
  }
"""
BLOCK_C_NEW = """  // 任务数据域（D17/P3-4）：`patchTask` / `completePlanTask` / `saveProgress` /
  // `completeTaskFromProgress` / `deferPlanTask` 已收进 hooks/useTaskData.ts。
  // 其中两处反馈（`setNotice`）改成 hook 的注入回调 `onNotice`（设计 §5）。
"""
src = replace_once(src, BLOCK_C_OLD, BLOCK_C_NEW, "block C (patchTask..deferPlanTask)")

# ---- 6. 装配层原语替换 ------------------------------------------------------
src = replace_once(
    src,
    "        setSelected(null)\n        selectedRef.current = null\n",
    "        clearSelectedTask()\n",
    "archive 成功分支 clearSelectedTask",
)
src = replace_once(
    src,
    "          setSelected(null)\n          selectedRef.current = null\n",
    "          clearSelectedTask()\n",
    "archive not-found 分支 clearSelectedTask",
)
src = replace_once(
    src,
    "    if (selectedRef.current !== null) await refresh()\n",
    "    if (currentTaskId() !== null) await refresh()\n",
    "ackReminder currentTaskId",
)
src = replace_once(
    src,
    "  const addTaskReminder = async (offsetMinutes: number): Promise<void> => {\n    const taskId = selectedRef.current\n",
    "  const addTaskReminder = async (offsetMinutes: number): Promise<void> => {\n    const taskId = currentTaskId()\n",
    "addTaskReminder currentTaskId",
)
src = replace_once(
    src,
    "  const linkExistingSession = async (sessionId: string): Promise<void> => {\n    const taskId = selectedRef.current\n",
    "  const linkExistingSession = async (sessionId: string): Promise<void> => {\n    const taskId = currentTaskId()\n",
    "linkExistingSession currentTaskId",
)

stray = [
    (i, ln)
    for i, ln in enumerate(src.splitlines(), start=1)
    if "selectedRef" in ln and not ln.lstrip().startswith(("*", "//"))
]
if stray:
    problems.append(f"入口仍残留 selectedRef 代码（非注释）：{stray[:3]}")

if problems:
    print("P3-4 搬迁未落盘，问题如下：")
    for p in problems:
        print(" -", p)
    sys.exit(1)

INDEX.write_text(src, encoding="utf-8", newline="\n")
print(f"index.tsx: {orig_len} -> {len(src.splitlines())} 行")
