/**
 * D17 / P3-3：任务表单域 —— 新建任务弹窗的三个开关与编辑任务草稿的**唯一 owner**。
 *
 * 拆分前这四项状态散在 `index.tsx` 的四处（`showForm`/`subtaskParent`/`editDraft` 在文件头，
 * `formWorkspace` 落在目录选择器那一簇里），写入口也散在各处：
 * - `setShowForm` 有两个语义不同的调用点 —— 工具栏「新建」是**开关** `(v) => !v`，
 *   弹窗的 `onClose`/「取消」/创建成功是**关闭** `false`。设计模式 3 明令不同语义不许合并，
 *   所以这里给两个动作：`toggleCreate()` 与 `closeCreate()`（逐字保留各自的写法）。
 * - `setEditDraft` 有 12 处逐字段的 `(prev) => prev === null ? prev : { ...prev, X }`，
 *   同一语义（null 安全地改一格）写了 12 遍 —— 收成 `patchDraft(patch)` 一处（§0 去重）。
 *
 * 视图只拿到**意图**，不拿原始 setter（设计 §5）：`views/TaskFormModal.tsx` 用
 * `onPatchDraft` / `onClose` / `onSubmit`，`views/TaskDetailPane.tsx` 用
 * `onOpenEdit` / `onAddSubtask` / `onCancelSubtask`。
 *
 * 与 `useTaskListModel` / `useTaskDetailModel` 同构：state 平铺在返回值上（只读快照），
 * 写路径统一挂在 `actions` 命名空间下。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Task } from '../viewTypes.js'
import type { TaskEditDraft } from '../app/contracts.js'

export interface UseTaskFormsResult {
  /** 新建任务弹窗是否打开（工具栏「新建」是个开关，见 `toggleCreate`）。 */
  showForm: boolean
  /** 子任务表单挂在哪个任务上（详情面板「子任务」按钮开、取消/创建成功关）。 */
  subtaskParent: Task | null
  /** 编辑任务草稿；非 null 时弹窗打开（详情面板「编辑」按钮用当前任务的值构造）。 */
  editDraft: TaskEditDraft | null
  /**
   * 新建任务表单里的工作区。
   *
   * 表单本身是**非受控**的（提交时读 `FormData`），所以这一格必须受控才能被「浏览…」写值 ——
   * 值再由一个 `hidden` 输入承接进 FormData。目录选择器写回的**唯一分派点**仍在装配层
   * （`applyWorkspaceDir` 按 `dirPickerTarget` 分流，不能各入口各写一份）。
   */
  formWorkspace: string
  actions: {
    /** 工具栏「新建」：开关（与拆分前 `setShowForm((v) => !v)` 逐字一致）。 */
    toggleCreate: () => void
    /** 关闭新建弹窗：`onClose` / 「取消」/ 创建成功三处共用。 */
    closeCreate: () => void
    /** 打开编辑弹窗（整份草稿由调用方构造 —— 详情面板从 `selected.task` 折出）。 */
    openEdit: (draft: TaskEditDraft) => void
    /** 关闭编辑弹窗（取消 / 保存成功后）。 */
    closeEdit: () => void
    /** 改编辑草稿的若干字段（原 12 处内联 null-safe 展开的唯一实现）。 */
    patchDraft: (patch: Partial<TaskEditDraft>) => void
    /** 子任务表单的父任务（`null` = 收起）。 */
    setSubtaskParent: (task: Task | null) => void
    /** 「浏览…」把选中的目录写回新建任务表单（`applyWorkspaceDir` 的 form 分流）。 */
    setFormWorkspace: (path: string) => void
    /**
     * 换任务（`selected?.task.id` 变了）时把两个瞬态表单收掉：子任务表单 + 编辑草稿。
     *
     * 拆分前这是入口里的一个两连 setState 的 effect；触发条件是**任务数据域**的变化，
     * 而两个 state 属本域，所以按设计 §0/模式 5 收成一个动作，由装配层的跨域 effect 调用。
     */
    dismissOnTaskChange: () => void
  }
}

export function useTaskForms(): UseTaskFormsResult {
  const [showForm, setShowForm] = useState(false)
  const [subtaskParent, setSubtaskParent] = useState<Task | null>(null)
  const [editDraft, setEditDraft] = useState<TaskEditDraft | null>(null)
  const [formWorkspace, setFormWorkspace] = useState('')

  /** 新建任务表单每次打开都从空白开始（否则上一次"浏览…"选的目录会留在下一次）。 */
  useEffect(() => { if (showForm) setFormWorkspace('') }, [showForm])

  const toggleCreate = useCallback((): void => { setShowForm((v) => !v) }, [])
  const closeCreate = useCallback((): void => { setShowForm(false) }, [])
  const openEdit = useCallback((draft: TaskEditDraft): void => { setEditDraft(draft) }, [])
  const closeEdit = useCallback((): void => { setEditDraft(null) }, [])
  const patchDraft = useCallback((patch: Partial<TaskEditDraft>): void => {
    setEditDraft((prev) => (prev === null ? prev : { ...prev, ...patch }))
  }, [])
  const setSubtaskParentAction = useCallback((task: Task | null): void => { setSubtaskParent(task) }, [])
  const setFormWorkspaceAction = useCallback((path: string): void => { setFormWorkspace(path) }, [])
  const dismissOnTaskChange = useCallback((): void => {
    setEditDraft(null); setSubtaskParent(null)
  }, [])

  return {
    showForm,
    subtaskParent,
    editDraft,
    formWorkspace,
    actions: {
      toggleCreate,
      closeCreate,
      openEdit,
      closeEdit,
      patchDraft,
      setSubtaskParent: setSubtaskParentAction,
      setFormWorkspace: setFormWorkspaceAction,
      dismissOnTaskChange,
    },
  }
}
