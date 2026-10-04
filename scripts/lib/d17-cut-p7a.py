# -*- coding: utf-8 -*-
"""
D17 / P7-1：把 WorkbenchApp 体内最后 6 处 `api(...)` 归域（ADR-0008 结构硬门「体内 0 业务请求」）。

分工（一句话规则：**请求形状与它的输入校验归域；把结果接到哪些域的状态归装配层**）：
- `hooks/useTaskData.ts` 收：
  · `linkSessionRequest(taskId, sessionId, roleCode)` —— **请求原语**（调用点还要跟详情域的
    会话选择器状态拼，跨域组合归装配层）；
  · `archiveSelectedTask()` —— **整条用例**（只用到本域状态 + 注入反馈）；
  · `restoreTask(taskId)` / `createSubtask(form, parent)` / `createTask(form)` —— 用例本体，
    跨域那一步以注入回调交回装配层（`onTaskRestored` / `onSubtaskParentCleared` / `onTaskCreated`）。
- `hooks/useWorkbenchSettings.ts` 收 `saveIncludeOverdue(next)`（整条）与
  `saveDailyCapacity(rawEdit)`（入参是日期域交出的行内编辑态原文）。

⚠️ 脚本纪律：所有替换都要求**恰好命中 1 次**，任一不成立就整体中止、不写任何文件；
写回一律 `newline="\\n"`（否则 Windows 上会把整份 index.tsx 写成 CRLF）。
中文注释里不使用 ASCII 双引号（Python 字符串定界符，已踩过两次 SyntaxError）。
"""
import io
import pathlib
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[2]
INDEX = ROOT / "src/client/index.tsx"
TASK_HOOK = ROOT / "src/client/hooks/useTaskData.ts"
SETTINGS_HOOK = ROOT / "src/client/hooks/useWorkbenchSettings.ts"

ERRORS = []


def sub1(text, old, new, label):
    n = text.count(old)
    if n != 1:
        ERRORS.append("[%s] 命中 %d 次（要求恰好 1 次）" % (label, n))
        return text
    return text.replace(old, new, 1)


def read(path):
    return path.read_text(encoding="utf-8")


def write(path, text):
    path.write_text(text, encoding="utf-8", newline="\n")


# ────────────────────────────── A. useTaskData.ts ──────────────────────────────
task = read(TASK_HOOK)

task = sub1(
    task,
    "import { api } from '../api.js'\n",
    "import { api } from '../api.js'\nimport { localDateString } from '../format.js'\nimport { MAX_ESTIMATE_MINUTES } from '../capacity.js'\n",
    "A1 useTaskData import",
)

task = sub1(
    task,
    " * - 动作：`refresh` / `loadTaskKnowledge` / `loadTaskDetail` / `patchTask` / `completePlanTask` /\n"
    " *   `saveProgress` / `completeTaskFromProgress` / `deferPlanTask`。\n",
    " * - 动作：`refresh` / `loadTaskKnowledge` / `loadTaskDetail` / `patchTask` / `completePlanTask` /\n"
    " *   `saveProgress` / `completeTaskFromProgress` / `deferPlanTask`。\n"
    " * - D17/P7-1 追加：装配层里**最后 6 处 `api(...)` 归域**（ADR-0008 结构硬门「体内 0 业务请求」）——\n"
    " *   `archiveSelectedTask` / `restoreTask` / `createSubtask` / `createTask` 是**整条用例**，\n"
    " *   跨域那一步以注入回调交回装配层；`linkSessionRequest` 只交**请求原语**（它的调用点还要跟\n"
    " *   详情域的会话选择器状态拼）；设置域那两个 `save*` 见 `useWorkbenchSettings.ts`。\n",
    "A2 useTaskData 文件头",
)

task = sub1(
    task,
    "    deferPlanTask: (taskId: string) => Promise<void>\n"
    "    /**\n"
    "     * 装配层直接改任务快照的**原语**",
    "    deferPlanTask: (taskId: string) => Promise<void>\n"
    "    /**\n"
    "     * D17 / P7-1：**请求原语** —— 装配层里最后一处 `api(...)`（关联已有会话）收进本域。\n"
    "     *\n"
    "     * 为什么只交原语：这个动作的调用点还要跟**详情域**的会话选择器状态拼（读 `sessionPickerRole`、\n"
    "     * 写 `sessionPickerBusy`、成功后 `closeSessionPicker()`）。按设计 §4.1 第 148 行的定案\n"
    "     * 「跨域组合归装配层」，本域只交出请求形状（与既有 `patchTask` 同一先例）。\n"
    "     * ⚠️ 不做 catch / notice / refresh：错误原样抛给装配层，由它决定记 `setError` 还是别的。\n"
    "     */\n"
    "    linkSessionRequest: (taskId: string, sessionId: string, roleCode: string) => Promise<void>\n"
    "    /**\n"
    "     * 归档当前选中任务（D17/P7-1：**整条用例**从装配层收进本域）。\n"
    "     *\n"
    "     * 为什么能整条收：它只用到本域的 `selected` / `setTasks` / `clearSelectedTask` / `refresh`\n"
    "     * 与注入的 `onNotice` / `onError`，没有第三个域参与。行为逐字保留（含「任务已不存在」的\n"
    "     * 自愈分支与那句 `window.confirm` 确认策略 —— 本域的「完成任务」早就是这个口径）。\n"
    "     */\n"
    "    archiveSelectedTask: () => void\n"
    "    /**\n"
    "     * 「恢复任务」与「新建子任务」（D17/P7-1：请求本体从装配层收进本域）。\n"
    "     *\n"
    "     * 跨域的那一件事各自以注入回调交回装配层：恢复成功要退出列表域的「查看归档」\n"
    "     * （`onTaskRestored`）、子任务建好要收起表单域的子任务表单（`onSubtaskParentCleared`）。\n"
    "     * 调用次序与拆分前逐字一致（先提示 / 先收表单，再 `refresh()`）。\n"
    "     */\n"
    "    restoreTask: (taskId: string) => void\n"
    "    createSubtask: (form: FormData, parent: Task) => void\n"
    "    /**\n"
    "     * 新建任务（D17/P7-1：payload 拼接 + POST + `refresh` 从装配层收进本域）。\n"
    "     *\n"
    "     * 表单域那一件事（收起新建弹窗）以 `onTaskCreated` 注入 —— 与 P6-3 把 `closeIntake()`\n"
    "     * 注入 AI 会话域同一手法。次序逐字保留：POST → 收弹窗 → `await refresh()`。\n"
    "     */\n"
    "    createTask: (form: FormData) => Promise<void>\n"
    "    /**\n"
    "     * 装配层直接改任务快照的**原语**",
    "A3 useTaskData 类型声明",
)

TASK_IMPL = '''  /**
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

'''

task = sub1(
    task,
    "  /** 清掉当前选中（`selected` 与它的最新值镜像 `selectedRef` 必须一起清，见类型声明里的说明）。 */",
    TASK_IMPL
    + "  /** 清掉当前选中（`selected` 与它的最新值镜像 `selectedRef` 必须一起清，见类型声明里的说明）。 */",
    "A4 useTaskData 实现",
)

task = sub1(
    task,
    "      deferPlanTask,\n      setTasks,\n",
    "      deferPlanTask,\n"
    "      linkSessionRequest,\n"
    "      archiveSelectedTask,\n"
    "      restoreTask,\n"
    "      createSubtask,\n"
    "      createTask,\n"
    "      setTasks,\n",
    "A5 useTaskData 返回",
)

# 入参：三个跨域注入回调
task = sub1(
    task,
    "export type UseTaskDataInput = {\n"
    "  /** 反馈域注入：详情加载失败时把消息交给入口的错误条（逐字保留拆分前的取值方式）。 */\n"
    "  onError: (message: string) => void\n"
    "  /** 反馈域注入：任务动作完成后的提示语（「完成任务」「推迟」两处）。 */\n"
    "  onNotice: (message: string) => void\n"
    "}",
    "export type UseTaskDataInput = {\n"
    "  /** 反馈域注入：详情加载失败时把消息交给入口的错误条（逐字保留拆分前的取值方式）。 */\n"
    "  onError: (message: string) => void\n"
    "  /** 反馈域注入：任务动作完成后的提示语（「完成任务」「推迟」两处）。 */\n"
    "  onNotice: (message: string) => void\n"
    "  /**\n"
    "   * 表单域注入（D17/P7-1）：新建任务成功后收起新建弹窗（原装配层那句 `forms.actions.closeCreate()`）。\n"
    "   * 域拥有用例、跨域那一步以类型化回调交回装配层 —— 与 P6-3 把 `closeIntake()` 注入 AI 会话域同一手法。\n"
    "   */\n"
    "  onTaskCreated: () => void\n"
    "  /** 表单域注入（D17/P7-1）：子任务创建成功后收起子任务表单（原 `forms.actions.setSubtaskParent(null)`）。 */\n"
    "  onSubtaskParentCleared: () => void\n"
    "  /** 列表域注入（D17/P7-1）：恢复归档任务成功后退出「查看归档」（原 `taskList.actions.setArchivedMode(false)`）。 */\n"
    "  onTaskRestored: () => void\n"
    "}",
    "A6 useTaskData 入参类型",
)

task = sub1(
    task,
    "export function useTaskData({ onError, onNotice }: UseTaskDataInput): UseTaskDataResult {",
    "export function useTaskData({ onError, onNotice, onTaskCreated, onSubtaskParentCleared, onTaskRestored }: UseTaskDataInput): UseTaskDataResult {",
    "A7 useTaskData 签名",
)

# ──────────────────────────── B. useWorkbenchSettings.ts ────────────────────────────
settings = read(SETTINGS_HOOK)

settings = sub1(
    settings,
    "  saveSettings: () => Promise<void>\n",
    "  saveSettings: () => Promise<void>\n"
    "  /**\n"
    "   * D17/P7-1：逾期口径开关（从装配层收进本域）。「今日容量 → 规则」面板与设置页写**同一个**\n"
    "   * settings 键，所以只能有一份实现；乐观写 + 失败回滚，不静默失败。\n"
    "   */\n"
    "  saveIncludeOverdue: (next: boolean) => Promise<void>\n"
    "  /**\n"
    "   * D17/P7-1：保存「每天可投入时长」（分钟）；`<30` 视为无效、恢复默认 390。\n"
    "   * 入参是**日期域**交出的行内编辑态原文 —— 本域不拥有它、也不去读它（跨域只传值）。\n"
    "   */\n"
    "  saveDailyCapacity: (rawEdit: string) => Promise<void>\n",
    "B1 useWorkbenchSettings 动作类型",
)

SETTINGS_IMPL = '''  /**
   * 逾期口径开关（D17/P7-1：从装配层收进本域）。
   *
   * 为什么两处共用一个回调：`dailyCapacityIncludeOverdue` 的唯一权威源是 settings（服务端 meta）。
   * 若面板自己存一份 state，就会出现「面板开关是开的、容量按关的算」这种假控件。
   * 保存失败**回滚**（把 settings 改回去），不静默失败。
   */
  const saveIncludeOverdue = async (next: boolean): Promise<void> => {
    const previous = settings.dailyCapacityIncludeOverdue
    if (next === previous) return
    setSettings((prev) => ({ ...prev, dailyCapacityIncludeOverdue: next }))
    try {
      await api('/api/workbench/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailyCapacityIncludeOverdue: next }),
      })
      setNotice(next ? '逾期任务会计入今日容量' : '逾期任务不再计入今日容量')
    } catch (e) {
      setSettings((prev) => ({ ...prev, dailyCapacityIncludeOverdue: previous }))
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 保存「每天可投入时长」（D17/P7-1：从装配层收进本域）；`<30` 视为无效，恢复默认 390。
   *
   * 入参 `rawEdit` 是**日期域**交出的行内编辑态原文：日期域在自己的 hook 调用点把值取出来、
   * 立刻置空，再把原文递进来（跨域只传值，不把可写副本递出去 —— 设计 §5）。
   */
  const saveDailyCapacity = async (rawEdit: string): Promise<void> => {
    const raw = rawEdit.trim()
    const parsed = Number(raw)
    const next = Number.isFinite(parsed) && parsed >= 30 ? Math.min(1440, Math.round(parsed)) : 390
    if (next === settings.dailyCapacityMinutes) return
    try {
      await api<{ settings: { dailyCapacityMinutes: number } }>('/api/workbench/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailyCapacityMinutes: next }),
      })
      setSettings((prev) => ({ ...prev, dailyCapacityMinutes: next }))
      setNotice(`每天可投入时长已设为 ${next} 分钟`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

'''

settings = sub1(
    settings,
    "  return {\n    settings,\n    showSettings,\n",
    SETTINGS_IMPL + "  return {\n    settings,\n    showSettings,\n",
    "B2 useWorkbenchSettings 实现",
)

settings = sub1(
    settings,
    "      saveSettings,\n      saveDictionaryEntry,\n",
    "      saveSettings,\n      saveIncludeOverdue,\n      saveDailyCapacity,\n      saveDictionaryEntry,\n",
    "B3 useWorkbenchSettings 返回",
)

# ────────────────────────────────── C. index.tsx ──────────────────────────────────
index = read(INDEX)

index = sub1(
    index,
    "  const data = useTaskData({ onError: setError, onNotice: setNotice })\n",
    "  /**\n"
    "   * D17/P7-1：三个**跨域注入回调** —— 域拥有用例，跨域那一步以类型化回调交回装配层\n"
    "   *（与 P6-3 把 `closeIntake()` / `clearQuickAttachments()` 注入 AI 会话域同一手法）。\n"
    "   * `taskList`（列表域）声明在本行之后：闭包在用户交互时才求值，没有 TDZ 问题。\n"
    "   */\n"
    "  const data = useTaskData({\n"
    "    onError: setError, onNotice: setNotice,\n"
    "    onTaskCreated: () => forms.actions.closeCreate(),\n"
    "    onSubtaskParentCleared: () => forms.actions.setSubtaskParent(null),\n"
    "    onTaskRestored: () => taskList.actions.setArchivedMode(false),\n"
    "  })\n",
    "C1 data 调用",
)

index = sub1(
    index,
    "    setTasks,\n    clearSelectedTask,\n    currentTaskId,\n  } = data.actions\n",
    "    setTasks,\n    clearSelectedTask,\n    currentTaskId,\n"
    "    linkSessionRequest,\n    archiveSelectedTask,\n    restoreTask,\n    createSubtask,\n    createTask,\n"
    "  } = data.actions\n",
    "C2 data 解构",
)

index = sub1(
    index,
    "      await api(`/api/workbench/tasks/${taskId}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, roleCode: sessionPickerRole }) })\n",
    "      await linkSessionRequest(taskId, sessionId, sessionPickerRole)\n",
    "C3 linkExistingSession 请求",
)

index = sub1(
    index,
    "  /**\n"
    "   * 归档当前选中的任务（2026-10-01 从详情页动作行的内联箭头函数提出来）。\n"
    "   *\n"
    "   * 为什么要提出来：用户要求把「归档」移到详情页**右上角**，与下面那排 AI 动作按钮分开——\n"
    "   * 那排按钮的 onClick 都是一行巨型内联表达式，把这段 200 多字符的逻辑塞进\n"
    "   * `title` + 按钮里会完全不可读。行为一个字没改（含\"任务已不存在\"的自愈分支）。\n"
    "   */\n"
    "  const archiveSelectedTask = (): void => {\n"
    "    if (selected === null) return\n"
    "    if (!window.confirm('归档后任务会从工作台列表隐藏（其子任务也会一并从列表隐藏），可在列表页“查看归档”中恢复。确认归档？')) return\n"
    "    const id = selected.task.id\n"
    "    setTasks((list) => list.filter((t) => t.id !== id))\n"
    "    void api(`/api/workbench/tasks/${id}/archive`, { method: 'POST' })\n"
    "      .then(() => {\n"
    "        clearSelectedTask()\n"
    "        setNotice('任务已归档，可在列表页“查看归档”恢复。')\n"
    "        void refresh()\n"
    "      })\n"
    "      .catch((e: unknown) => {\n"
    "        const msg = e instanceof Error ? e.message : String(e)\n"
    "        // 任务已被别处删掉时不要把用户卡在\"点了没反应\"：清掉选中并明确告知。\n"
    "        if (msg.includes('not found')) {\n"
    "          clearSelectedTask()\n"
    "          void refresh()\n"
    "          setNotice('该任务已不存在，已从当前视图移除')\n"
    "        }\n"
    "        setError(msg)\n"
    "      })\n"
    "  }\n\n",
    "  // 归档当前选中任务（D17/P7-1）：整条用例（含 window.confirm 与 not found 自愈分支）已收进\n"
    "  // hooks/useTaskData.ts —— 它只用到任务数据域自己的状态 + 注入反馈，没有第三个域参与。\n"
    "  // 详情面板的 `archiveSelectedTask={archiveSelectedTask}` 仍从这里解构出的动作传下去。\n\n",
    "C4 删 archiveSelectedTask",
)

index = sub1(
    index,
    "  /**\n"
    "   * 新建任务（弹窗提交）。视图只 `preventDefault` + 收 `FormData`（与详情面板的子任务表单同一先例），\n"
    "   * payload 拼接与 POST 留在这里 —— 设计 §3：`views/` 不许发 HTTP。\n"
    "   */\n"
    "  const createTask = async (form: FormData): Promise<void> => {\n"
    "    const title = String(form.get('title') ?? '').trim()\n"
    "    if (title === '') return\n"
    "    const due = String(form.get('due') ?? '')\n"
    "    const dueAt = due === '' ? null : new Date(due).toISOString()\n"
    "    const recurrenceCode = String(form.get('recurrence') ?? 'none')\n"
    "    const recurrenceAnchor = dueAt !== null ? new Date(dueAt) : new Date()\n"
    "    /**\n"
    "     * 耗时与全天（v1.15.1）：与编辑弹窗**同一规则**——留空 = null（走默认耗时）、\n"
    "     * 非法值当作没填（服务端还会再夹一次，但这里不把脏值发出去）。\n"
    "     * 非法值不静默改写：用户看到的是\"没填\"的语义（详情行会写\"未单独设置\"）。\n"
    "     */\n"
    "    const estimatedRaw = String(form.get('estimatedMinutes') ?? '').trim()\n"
    "    const estimatedParsed = estimatedRaw === '' ? null : Number(estimatedRaw)\n"
    "    const estimatedMinutes = estimatedParsed !== null && Number.isFinite(estimatedParsed) && estimatedParsed >= 1\n"
    "      ? Math.min(MAX_ESTIMATE_MINUTES, Math.round(estimatedParsed))\n"
    "      : null\n"
    "    await api('/api/workbench/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, description: String(form.get('description') ?? ''), typeCode: String(form.get('type') ?? ''), priorityCode: String(form.get('priority') ?? ''), statusCode: String(form.get('status') ?? 'todo'), workspacePath: String(form.get('workspacePath') ?? '').trim() || null, dueAt, estimatedMinutes, allDay: form.get('allDay') !== null, recurrenceCode: recurrenceCode === 'none' ? null : recurrenceCode, recurrenceRule: recurrenceCode === 'none' ? undefined : { interval: 1, startDate: localDateString(recurrenceAnchor), weekdays: [recurrenceAnchor.getDay()], monthDay: recurrenceAnchor.getDate() } }) })\n"
    "    forms.actions.closeCreate(); await refresh()\n"
    "  }\n",
    "  // 新建任务（D17/P7-1）：payload 拼接 + POST + `refresh` 已收进 hooks/useTaskData.ts\n"
    "  //（`onTaskCreated` 注入回表单域收弹窗）。视图仍然只 `preventDefault` + 收 `FormData`：\n"
    "  // 设计 §3 —— `views/` 不许发 HTTP，请求形状归域。\n",
    "C5 删 createTask",
)

index = sub1(
    index,
    "  const restoreTask = (taskId: string): void => {\n"
    "    void api(`/api/workbench/tasks/${taskId}/restore`, { method: 'POST' }).then(() => { setNotice('任务已恢复'); taskList.actions.setArchivedMode(false); void refresh() }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))\n"
    "  }\n"
    "  const createSubtask = (form: FormData, parent: Task): void => {\n"
    "    const title = String(form.get('title') ?? '').trim()\n"
    "    if (title === '') return\n"
    "    const due = String(form.get('due') ?? '')\n"
    "    void api('/api/workbench/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, typeCode: String(form.get('type') ?? parent.typeCode), priorityCode: String(form.get('priority') ?? parent.priorityCode), statusCode: 'todo', parentId: parent.id, dueAt: due === '' ? null : new Date(due).toISOString() }) }).then(() => { forms.actions.setSubtaskParent(null); setNotice('子任务已创建'); void refresh() }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))\n"
    "  }\n",
    "  // 「恢复任务」与「新建子任务」（D17/P7-1）：请求本体已收进 hooks/useTaskData.ts ——\n"
    "  // 跨域那一步（退出列表域的「查看归档」/ 收起表单域的子任务表单）以注入回调交回装配层。\n"
    "  // 详情面板的 `onRestoreTask={restoreTask}` 与 `onCreateSubtask={createSubtask}` 仍从这里传下去。\n",
    "C6 删 restoreTask / createSubtask",
)

index = sub1(
    index,
    "  /**\n"
    "   * 逾期口径开关（「今日容量 → 规则」面板与设置页**写同一个 settings 键**）。\n"
    "   *\n"
    "   * 为什么两处共用一个回调：`dailyCapacityIncludeOverdue` 的唯一权威源是 settings\n"
    "   * （服务端 meta）。若面板自己存一份 state，就会出现\"面板开关是开的、容量按关的算\"\n"
    "   * 这种假控件 —— 本项目已经因为\"两个权威源\"翻过车。\n"
    "   * 保存失败回滚（把 settings 改回去），不静默失败。\n"
    "   */\n"
    "  const saveIncludeOverdue = async (next: boolean): Promise<void> => {\n"
    "    const previous = settings.dailyCapacityIncludeOverdue\n"
    "    if (next === previous) return\n"
    "    setSettings((prev) => ({ ...prev, dailyCapacityIncludeOverdue: next }))\n"
    "    try {\n"
    "      await api('/api/workbench/settings', {\n"
    "        method: 'POST', headers: { 'content-type': 'application/json' },\n"
    "        body: JSON.stringify({ dailyCapacityIncludeOverdue: next }),\n"
    "      })\n"
    "      setNotice(next ? '逾期任务会计入今日容量' : '逾期任务不再计入今日容量')\n"
    "    } catch (e) {\n"
    "      setSettings((prev) => ({ ...prev, dailyCapacityIncludeOverdue: previous }))\n"
    "      setError(e instanceof Error ? e.message : String(e))\n"
    "    }\n"
    "  }\n"
    "\n"
    "  /** 保存「每天可投入时长」（分钟）；<30 视为无效，恢复默认 390。 */\n"
    "  const saveDailyCapacity = async (): Promise<void> => {    const raw = day.capacityEdit === null ? '' : day.capacityEdit.trim()\n"
    "    day.actions.setCapacityEdit(null)\n"
    "    const parsed = Number(raw)\n"
    "    const next = Number.isFinite(parsed) && parsed >= 30 ? Math.min(1440, Math.round(parsed)) : 390\n"
    "    if (next === settings.dailyCapacityMinutes) return\n"
    "    try {\n"
    "      await api<{ settings: { dailyCapacityMinutes: number } }>('/api/workbench/settings', {\n"
    "        method: 'POST',\n"
    "        headers: { 'content-type': 'application/json' },\n"
    "        body: JSON.stringify({ dailyCapacityMinutes: next }),\n"
    "      })\n"
    "      setSettings((prev) => ({ ...prev, dailyCapacityMinutes: next }))\n"
    "      setNotice(`每天可投入时长已设为 ${next} 分钟`)\n"
    "    } catch (e) {\n"
    "      setError(e instanceof Error ? e.message : String(e))\n"
    "    }\n"
    "  }\n",
    "  // 逾期口径开关（D17/P7-1）：整条用例（乐观写 + 失败回滚 + 那句「面板与设置页同一权威源」的\n"
    "  // 注释）已收进 hooks/useWorkbenchSettings.ts，入口从那里解构同名动作使用。\n"
    "\n"
    "  /**\n"
    "   * 保存「每天可投入时长」（分钟）的**装配层半边**：读日期域的行内编辑态、立刻置空，\n"
    "   * 再把原文交给设置域（D17/P7-1：请求本体与 `390 / 30 分钟` 口径已进 hooks/useWorkbenchSettings.ts）。\n"
    "   * 跨域只传值 —— 设置域不拥有也不读日期域的编辑态。\n"
    "   */\n"
    "  const saveDailyCapacity = async (): Promise<void> => {\n"
    "    const raw = day.capacityEdit === null ? '' : day.capacityEdit.trim()\n"
    "    day.actions.setCapacityEdit(null)\n"
    "    await saveDailyCapacitySetting(raw)\n"
    "  }\n",
    "C7 删 saveIncludeOverdue / 改 saveDailyCapacity",
)

index = sub1(
    index,
    "  // ⚠️ 下面两个 `save*` 写的是 **settings**（设置域的唯一权威源，P6 才搬），刻意留在这里。\n",
    "  // 设置域（D17/P7-1）：`saveIncludeOverdue` / `saveDailyCapacity` 两个写 settings 的**请求本体**\n"
    "  // 已收进 hooks/useWorkbenchSettings.ts；入口只留 `saveDailyCapacity` 的装配层半边\n"
    "  //（读日期域的行内编辑态并把原文递进去）。\n",
    "C8 save* 注释",
)

index = sub1(
    index,
    "    setSettings, setShowSettings, setDictKind, setDictForm, setDictEditCode, setDictError,\n"
    "    saveSettings, saveDictionaryEntry, toggleDictionaryEntry, deleteDictionaryEntry,\n"
    "    loadRecallLog, recallSessionRestore,\n"
    "  } = prefs.actions\n",
    "    setSettings, setShowSettings, setDictKind, setDictForm, setDictEditCode, setDictError,\n"
    "    saveSettings, saveIncludeOverdue, saveDailyCapacity: saveDailyCapacitySetting,\n"
    "    saveDictionaryEntry, toggleDictionaryEntry, deleteDictionaryEntry,\n"
    "    loadRecallLog, recallSessionRestore,\n"
    "  } = prefs.actions\n",
    "C9 prefs 解构",
)

# ────────────────────────────── 收尾自检 ──────────────────────────────
if ERRORS:
    print("✖ 中止，未写任何文件：")
    for line in ERRORS:
        print("   - " + line)
    sys.exit(1)

body_start = index.index("function WorkbenchApp(")
body_end = len(index)
body = index[body_start:body_end]

checks = [
    ("入口体内 `api(` 归零", body.count("api(") == 0),
    ("入口不再声明 archiveSelectedTask", "const archiveSelectedTask = " not in index),
    ("入口不再声明 createTask 请求本体", "  const createTask = async (form: FormData): Promise<void> => {\n    const title" not in index),
    ("入口不再声明 createSubtask 请求本体", "  const createSubtask = (form: FormData, parent: Task): void => {" not in index),
    ("入口不再声明 restoreTask 请求本体", "  const restoreTask = (taskId: string): void => {\n    void api(" not in index),
    ("入口不再声明 saveIncludeOverdue", "const saveIncludeOverdue = " not in index),
    ("入口保留 saveDailyCapacity 装配层半边", "  const saveDailyCapacity = async (): Promise<void> => {\n    const raw = day.capacityEdit" in index),
    ("入口新增 linkSessionRequest 调用", "await linkSessionRequest(taskId, sessionId, sessionPickerRole)" in index),
    ("入口新增 saveDailyCapacitySetting", "await saveDailyCapacitySetting(raw)" in index),
    ("入口仍把 createTask 交给新建弹窗", "onSubmit={createTask}" in index),
    ("入口仍把 archiveSelectedTask 交给详情面板", "archiveSelectedTask={archiveSelectedTask}" in index),
    ("任务域出现 6 处新声明", task.count("const linkSessionRequest = ") == 1 and task.count("const archiveSelectedTask = ") == 1
     and task.count("const restoreTask = ") == 1 and task.count("const createSubtask = ") == 1
     and task.count("const createTask = ") == 1),
    ("任务域 api( 至少 12 处", task.count("api(") + task.count("api<") >= 12),
    ("设置域出现两个新动作", settings.count("const saveIncludeOverdue = ") == 1 and settings.count("const saveDailyCapacity = ") == 1),
    ("设置域返回体加了两个动作", "      saveIncludeOverdue,\n      saveDailyCapacity,\n" in settings),
]
failed = [name for name, ok in checks if not ok]

print("—— 收尾自检 ——")
for name, ok in checks:
    print(("  ✔ " if ok else "  ✖ ") + name)
if failed:
    print("✖ 自检不过，未写任何文件：" + "、".join(failed))
    sys.exit(1)

write(TASK_HOOK, task)
write(SETTINGS_HOOK, settings)
write(INDEX, index)
print("✔ 已写回：useTaskData.ts / useWorkbenchSettings.ts / index.tsx")
print("   index.tsx 行数 =", index.count("\n") + 1)
