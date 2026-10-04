/**
 * 任务数据域（D17 / P3-4）—— `index.tsx` 里"服务端任务快照 + 当前选中任务详情"的**唯一所有者**。
 *
 * 从入口拆出来的东西（一一对应，没有第二份实现）：
 * - state：`bootstrap` / `tasks` / `pendingCompletions` / `selected` / `taskKnowledge`（设计 §4.1 第 100 行的 5 项）；
 * - ref：`selectedRef`（设计 §4.1 第 119 行：**只镜像选中 ID**，永远不是第二份详情数据）；
 * - 只读派生：`dicts` / `dictOf` / `pendingMap` / `childrenIndex` / `childrenOf`（设计 §4.1 第 124 行）；
 * - 动作：`refresh` / `loadTaskKnowledge` / `loadTaskDetail` / `patchTask` / `completePlanTask` /
 *   `saveProgress` / `completeTaskFromProgress` / `deferPlanTask`。
 * - D17/P7-1 追加：装配层里**最后 6 处 `api(...)` 归域**（ADR-0008 结构硬门「体内 0 业务请求」）——
 *   `archiveSelectedTask` / `restoreTask` / `createSubtask` / `createTask` 是**整条用例**，
 *   跨域那一步以注入回调交回装配层；`linkSessionRequest` 只交**请求原语**（它的调用点还要跟
 *   详情域的会话选择器状态拼）；设置域那两个 `save*` 见 `useWorkbenchSettings.ts`。
 *
 * ⚠️ 依赖方向（设计 §3）：本文件是**纯 .ts**（不写 JSX），只 import 纯模块与共享契约，
 * **不得** import `index.tsx`。
 *
 * ⚠️ **故意留在这里的两件事都不属于本域**，所以它们**没有**跟着搬进来：
 * - 导航：`openTaskById` 的第一句是 `setView('list')`（Navigation 域）。设计 §4.1 第 148 行定案——
 *   `openTaskById` 由**装配层**组合 TaskData 与 Navigation，本域只提供"只加载、不导航"的
 *   `loadTaskDetail`（第 147 行）。`openTask` 同理（它要调详情域的 `resetDetailView()`）。
 * - 反馈：详情加载失败的错误条与任务动作完成后的提示语属于反馈域，这里按设计 §5
 *   「跨域靠装配层注入类型化回调」由入口注入 `onError` / `onNotice`。
 *
 * ⚠️ `refresh` 整块保留（设计 §4.1 第 149 行：**不能拆成多个独立重复请求**）：它一次
 * `Promise.all` 拉 bootstrap + 任务列表 + 待验收投影，再按最新选中 ID 补一次详情/事件/复盘/
 * 关联知识。拆开会让每处调用点各拉一遍，正是设计 §4.2 第 166 行列的反例。
 */
import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api } from '../api.js'
import { localDateString } from '../format.js'
import { MAX_ESTIMATE_MINUTES } from '../capacity.js'
import { pendingCompletionMap } from '../taskProgressView.js'
import type { PendingCompletionView, PendingCompletionsResponse } from '../../shared/contracts.js'
import type { Bootstrap, Dict, KnowledgeEntry, Task, TaskDetail } from '../viewTypes.js'

export type UseTaskDataInput = {
  /** 反馈域注入：详情加载失败时把消息交给入口的错误条（逐字保留拆分前的取值方式）。 */
  onError: (message: string) => void
  /** 反馈域注入：任务动作完成后的提示语（「完成任务」「推迟」两处）。 */
  onNotice: (message: string) => void
  /**
   * 表单域注入（D17/P7-1）：新建任务成功后收起新建弹窗（原装配层那句 `forms.actions.closeCreate()`）。
   * 域拥有用例、跨域那一步以类型化回调交回装配层 —— 与 P6-3 把 `closeIntake()` 注入 AI 会话域同一手法。
   */
  onTaskCreated: () => void
  /** 表单域注入（D17/P7-1）：子任务创建成功后收起子任务表单（原 `forms.actions.setSubtaskParent(null)`）。 */
  onSubtaskParentCleared: () => void
  /** 列表域注入（D17/P7-1）：恢复归档任务成功后退出「查看归档」（原 `taskList.actions.setArchivedMode(false)`）。 */
  onTaskRestored: () => void
}

export type UseTaskDataResult = {
  bootstrap: Bootstrap | null
  tasks: Task[]
  pendingCompletions: PendingCompletionView | null
  /** 当前选中任务的详情（`null` = 没选中任何任务）。 */
  selected: TaskDetail | null
  /** 当前选中任务关联的知识条目（由详情加载链维护，**不**由知识库列表覆盖）。 */
  taskKnowledge: KnowledgeEntry[]
  dicts: Dict[]
  dictOf: (kind: string) => Dict[]
  pendingMap: ReadonlyMap<string, { deferred: boolean }> | null
  childrenIndex: Map<string, Task[]>
  childrenOf: (taskId: string) => Task[] | undefined
  actions: {
    /** 刷新任务快照（bootstrap + 列表 + 待验收，并按最新选中 ID 补详情）——原 `refresh` 逐字搬迁。 */
    refresh: () => Promise<void>
    loadTaskKnowledge: (taskId: string) => Promise<void>
    /** 只**加载详情数据**，不导航、不重置页签（红线见下方注释原文）。 */
    loadTaskDetail: (taskId: string) => void
    patchTask: (id: string, patch: Record<string, unknown>) => Promise<void>
    completePlanTask: (taskId: string) => Promise<void>
    saveProgress: (taskId: string, percent: number) => Promise<void>
    completeTaskFromProgress: (taskId: string) => Promise<void>
    deferPlanTask: (taskId: string) => Promise<void>
    /**
     * D17 / P7-1：**请求原语** —— 装配层里最后一处 `api(...)`（关联已有会话）收进本域。
     *
     * 为什么只交原语：这个动作的调用点还要跟**详情域**的会话选择器状态拼（读 `sessionPickerRole`、
     * 写 `sessionPickerBusy`、成功后 `closeSessionPicker()`）。按设计 §4.1 第 148 行的定案
     * 「跨域组合归装配层」，本域只交出请求形状（与既有 `patchTask` 同一先例）。
     * ⚠️ 不做 catch / notice / refresh：错误原样抛给装配层，由它决定记 `setError` 还是别的。
     */
    linkSessionRequest: (taskId: string, sessionId: string, roleCode: string) => Promise<void>
    /**
     * 归档当前选中任务（D17/P7-1：**整条用例**从装配层收进本域）。
     *
     * 为什么能整条收：它只用到本域的 `selected` / `setTasks` / `clearSelectedTask` / `refresh`
     * 与注入的 `onNotice` / `onError`，没有第三个域参与。行为逐字保留（含「任务已不存在」的
     * 自愈分支与那句 `window.confirm` 确认策略 —— 本域的「完成任务」早就是这个口径）。
     */
    archiveSelectedTask: () => void
    /**
     * 「恢复任务」与「新建子任务」（D17/P7-1：请求本体从装配层收进本域）。
     *
     * 跨域的那一件事各自以注入回调交回装配层：恢复成功要退出列表域的「查看归档」
     * （`onTaskRestored`）、子任务建好要收起表单域的子任务表单（`onSubtaskParentCleared`）。
     * 调用次序与拆分前逐字一致（先提示 / 先收表单，再 `refresh()`）。
     */
    restoreTask: (taskId: string) => void
    createSubtask: (form: FormData, parent: Task) => void
    /**
     * 新建任务（D17/P7-1：payload 拼接 + POST + `refresh` 从装配层收进本域）。
     *
     * 表单域那一件事（收起新建弹窗）以 `onTaskCreated` 注入 —— 与 P6-3 把 `closeIntake()`
     * 注入 AI 会话域同一手法。次序逐字保留：POST → 收弹窗 → `await refresh()`。
     */
    createTask: (form: FormData) => Promise<void>
    /**
     * 装配层直接改任务快照的**原语**（唯一的两处调用点都在入口，都是"本地先改、服务端随后对账"）：
     * 归档成功后把该条从列表移除；编辑保存成功后把新耗时/全天写回列表（乐观更新）。
     *
     * 刻意保留 `Dispatch<SetStateAction<Task[]>>` 原形：两处都用了更新函数形式，收窄成
     * `(tasks: Task[]) => void` 会要求调用点先读一份渲染期快照——那正是**旧的**写法，
     * 会丢掉并发更新（设计 §5：跨域协作不许把可写副本递出去，但装配层自己可以持原语）。
     */
    setTasks: Dispatch<SetStateAction<Task[]>>
    /**
     * 清掉当前选中（归档成功 / 任务已被别处删掉两条路径共用）。
     *
     * 拆分前这句「两连写」`setSelected(null); selectedRef.current = null` 在
     * `archiveSelectedTask` 里**各写了一遍**（成功分支 + not found 自愈分支）——
     * 漏掉 ref 那一半会让下一次 `refresh` 又去拉一条已经不存在的详情。
     */
    clearSelectedTask: () => void
    /**
     * 当前选中任务 id —— 读 `selectedRef` 这个"最新值镜像"，**异步回调里必须用它**，
     * 不能用渲染期捕获的 `selected`（提醒、关联会话、归档都踩过这个口径）。
     */
    currentTaskId: () => string | null
  }
}

export function useTaskData({ onError, onNotice, onTaskCreated, onSubtaskParentCleared, onTaskRestored }: UseTaskDataInput): UseTaskDataResult {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  /**
   * 待验收投影（T1/D04）：来自 `GET /api/workbench/tasks/pending-completions` 的**一次**查询。
   * `null` = 服务端不支持这份投影（不显示徽标，不推测）。
   */
  const [pendingCompletions, setPendingCompletions] = useState<PendingCompletionView | null>(null)
  const [selected, setSelected] = useState<TaskDetail | null>(null)
  const [taskKnowledge, setTaskKnowledge] = useState<KnowledgeEntry[]>([])
  const selectedRef = useRef<string | null>(null)

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

  const loadTaskKnowledge = async (taskId: string): Promise<void> => {
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
   *
   * ⚠️ P3-4 起 `openTask` / `openTaskById` 留在**装配层**（它们要导航域与详情域），本函数留在本域
   * —— 这条红线就是靠这个分工守住的，别把三者又合回同一个文件。
   */
  const loadTaskDetail = (taskId: string): void => {
    selectedRef.current = taskId
    void Promise.all([
      api<TaskDetail>(`/api/workbench/tasks/${taskId}`),
      api<{ events: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${taskId}/events`).catch(() => ({ events: [] })),
      api<{ reviews: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${taskId}/reviews`).catch(() => ({ reviews: [] })),
      loadTaskKnowledge(taskId).catch(() => setTaskKnowledge([])),
    ]).then(([detail, ev, rv]) => setSelected({ ...detail, events: ev.events, reviews: rv.reviews })).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }
  const patchTask = async (id: string, patch: Record<string, unknown>): Promise<void> => {
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
    onNotice('任务已完成（未完成子任务已按既有规则级联完成）')
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
    onNotice(`已推迟到 ${next.getMonth() + 1}/${next.getDate()}`)
  }

  /**
   * D17 / P7-1：装配层最后一处 `api(...)`（关联已有会话）的**请求原语** —— 见类型声明里的说明。
   * 请求形状、payload 字段与拆分前逐字一致；错误原样抛给装配层。
   */
  const linkSessionRequest = async (taskId: string, sessionId: string, roleCode: string): Promise<void> => {
    await api(`/api/workbench/tasks/${taskId}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, roleCode }) })
  }

  /**
   * 归档当前选中任务（D17/P7-1：从装配层整条收进本域）。行为逐字保留 ——
   * 包括「先本地摘掉再发请求」的乐观更新、成功后的三连（清选中 / 提示 / 刷新），
   * 以及服务端说 not found 时的自愈提示（原实现里那句 `setError(msg)` 仍然无条件走到）。
   */
  const archiveSelectedTask = (): void => {
    if (selected === null) return
    if (!window.confirm('归档后任务会从工作台列表隐藏（其子任务也会一并从列表隐藏），可在列表页“查看归档”中恢复。确认归档？')) return
    const id = selected.task.id
    setTasks((list) => list.filter((t) => t.id !== id))
    void api(`/api/workbench/tasks/${id}/archive`, { method: 'POST' })
      .then(() => {
        clearSelectedTask()
        onNotice('任务已归档，可在列表页“查看归档”恢复。')
        void refresh()
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        // 任务已被别处删掉时不要把用户卡在“点了没反应”：清掉选中并明确告知。
        if (msg.includes('not found')) {
          clearSelectedTask()
          void refresh()
          onNotice('该任务已不存在，已从当前视图移除')
        }
        onError(msg)
      })
  }

  /**
   * 恢复归档任务（D17/P7-1：从装配层收进本域）。跨域那一件事（退出列表域的「查看归档」）
   * 以 `onTaskRestored` 注入；次序与拆分前逐字一致：提示 → 退出归档态 → 刷新。
   */
  const restoreTask = (taskId: string): void => {
    void api(`/api/workbench/tasks/${taskId}/restore`, { method: 'POST' }).then(() => { onNotice('任务已恢复'); onTaskRestored(); void refresh() }).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  /**
   * 新建任务的请求本体（D17/P7-1：从装配层搬进本域）。视图仍然只 `preventDefault` + 收 `FormData`；
   * payload 字段、耗时夹取规则与顺序、早退条件（空标题不提交）**逐字未改**。
   */
  const createTask = async (form: FormData): Promise<void> => {
    const title = String(form.get('title') ?? '').trim()
    if (title === '') return
    const due = String(form.get('due') ?? '')
    const dueAt = due === '' ? null : new Date(due).toISOString()
    const recurrenceCode = String(form.get('recurrence') ?? 'none')
    const recurrenceAnchor = dueAt !== null ? new Date(dueAt) : new Date()
    /**
     * 耗时与全天（v1.15.1）：与编辑弹窗**同一规则**——留空 = null（走默认耗时）、
     * 非法值当作没填（服务端还会再夹一次，但这里不把脏值发出去）。
     * 非法值不静默改写：用户看到的是“没填”的语义（详情行会写“未单独设置”）。
     */
    const estimatedRaw = String(form.get('estimatedMinutes') ?? '').trim()
    const estimatedParsed = estimatedRaw === '' ? null : Number(estimatedRaw)
    const estimatedMinutes = estimatedParsed !== null && Number.isFinite(estimatedParsed) && estimatedParsed >= 1
      ? Math.min(MAX_ESTIMATE_MINUTES, Math.round(estimatedParsed))
      : null
    await api('/api/workbench/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, description: String(form.get('description') ?? ''), typeCode: String(form.get('type') ?? ''), priorityCode: String(form.get('priority') ?? ''), statusCode: String(form.get('status') ?? 'todo'), workspacePath: String(form.get('workspacePath') ?? '').trim() || null, dueAt, estimatedMinutes, allDay: form.get('allDay') !== null, recurrenceCode: recurrenceCode === 'none' ? null : recurrenceCode, recurrenceRule: recurrenceCode === 'none' ? undefined : { interval: 1, startDate: localDateString(recurrenceAnchor), weekdays: [recurrenceAnchor.getDay()], monthDay: recurrenceAnchor.getDate() } }) })
    onTaskCreated()
    await refresh()
  }

  /**
   * 新建子任务的请求本体（D17/P7-1：从装配层搬进本域）。跨域那一件事（收起子任务表单）
   * 以 `onSubtaskParentCleared` 注入；次序与拆分前逐字一致：收表单 → 提示 → 刷新。
   */
  const createSubtask = (form: FormData, parent: Task): void => {
    const title = String(form.get('title') ?? '').trim()
    if (title === '') return
    const due = String(form.get('due') ?? '')
    void api('/api/workbench/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, typeCode: String(form.get('type') ?? parent.typeCode), priorityCode: String(form.get('priority') ?? parent.priorityCode), statusCode: 'todo', parentId: parent.id, dueAt: due === '' ? null : new Date(due).toISOString() }) }).then(() => { onSubtaskParentCleared(); onNotice('子任务已创建'); void refresh() }).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  /** 清掉当前选中（`selected` 与它的最新值镜像 `selectedRef` 必须一起清，见类型声明里的说明）。 */
  const clearSelectedTask = useCallback((): void => {
    setSelected(null)
    selectedRef.current = null
  }, [])

  /** 读当前选中任务 id（`selectedRef` 是"最新值镜像"，异步回调里以此为唯一口径）。 */
  const currentTaskId = useCallback((): string | null => selectedRef.current, [])

  return {
    bootstrap,
    tasks,
    pendingCompletions,
    selected,
    taskKnowledge,
    dicts,
    dictOf,
    pendingMap,
    childrenIndex,
    childrenOf,
    actions: {
      refresh,
      loadTaskKnowledge,
      loadTaskDetail,
      patchTask,
      completePlanTask,
      saveProgress,
      completeTaskFromProgress,
      deferPlanTask,
      linkSessionRequest,
      archiveSelectedTask,
      restoreTask,
      createSubtask,
      createTask,
      setTasks,
      clearSelectedTask,
      currentTaskId,
    },
  }
}
