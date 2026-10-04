/**
 * D17 / P3-2：任务详情域模型 —— 详情页签、会话选择器、事件折叠。
 *
 * 拆分前这 6 个 `useState` 直接摊在 `index.tsx` 的 `WorkbenchApp` 顶部（第 227–232 行），
 * 与 100 多个别的 state 混在一起。现在**唯一所有者**是这里：入口与
 * `views/TaskDetailPane.tsx` 都从这里读写，没有第二份可写副本（设计 §4「有唯一所有者」）。
 *
 * 边界（刻意**不**拥有的东西）：
 * - 不拥有 `selected`（任务数据域，P3-4）；
 * - 不拥有 `subtaskParent` / `editDraft`（任务表单域，P3-3）；
 * - 不拥有 `sessionCandidates` / `sessionListSnapshot` / `linkedSessionIds`（它们要 `runtime` 与 `selected`，
 *   由装配层算好按 props 注入 —— 设计 §5「跨域靠装配层注入类型化回调或只读快照」）。
 *
 * 三个语义动作是**去重**，不是新行为：拆分前同一串两连调用在入口与面板里各写了一遍。
 * - `resetDetailView()`：`setDetailTab('desc')` + `setEventsExpanded(false)`
 *   —— 拆分前 `openTask`(L812-813) 与 `openTaskById`(L819-820) 各一份；
 * - `openSessionPicker()`：`setSessionPickerQuery('')` + `setSessionPickerOpen(true)`（面板「添加已有对话」）；
 * - `closeSessionPicker()`：`setSessionPickerOpen(false)` + `setSessionPickerQuery('')`
 *   —— 拆分前面板「取消」与入口 `linkExistingSession` 各一份。
 *
 * ⚠️ 所有 setter 都**原样透出 `Dispatch<SetStateAction<T>>`**：面板里
 * `setEventsExpanded((v) => !v)` 用的是更新函数形式，收窄成 `(v: T) => void` 会改行为。
 */
import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

/** 详情页签（与拆分前的字面量联合类型逐字一致）。 */
export type TaskDetailTab = 'desc' | 'children' | 'sessions' | 'records'

export interface UseTaskDetailModelResult {
  detailTab: TaskDetailTab
  sessionPickerOpen: boolean
  sessionPickerRole: string
  sessionPickerQuery: string
  sessionPickerBusy: boolean
  eventsExpanded: boolean
  actions: {
    setDetailTab: Dispatch<SetStateAction<TaskDetailTab>>
    setSessionPickerOpen: Dispatch<SetStateAction<boolean>>
    setSessionPickerRole: Dispatch<SetStateAction<string>>
    setSessionPickerQuery: Dispatch<SetStateAction<string>>
    setSessionPickerBusy: Dispatch<SetStateAction<boolean>>
    setEventsExpanded: Dispatch<SetStateAction<boolean>>
    /** 打开任务时复位详情视图（唯一实现，替换拆分前 `openTask`/`openTaskById` 里各一份的两行）。 */
    resetDetailView: () => void
    /** 打开「添加已有对话」：先清空搜索词再展开（顺序与拆分前逐字一致）。 */
    openSessionPicker: () => void
    /** 收起会话选择器并清空搜索词（顺序与拆分前逐字一致）。 */
    closeSessionPicker: () => void
  }
}

export function useTaskDetailModel(): UseTaskDetailModelResult {
  const [detailTab, setDetailTab] = useState<TaskDetailTab>('desc')
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  const [sessionPickerRole, setSessionPickerRole] = useState('consult')
  const [sessionPickerQuery, setSessionPickerQuery] = useState('')
  const [sessionPickerBusy, setSessionPickerBusy] = useState(false)
  const [eventsExpanded, setEventsExpanded] = useState(false)

  const resetDetailView = useCallback((): void => {
    setDetailTab('desc')
    setEventsExpanded(false)
  }, [])

  const openSessionPicker = useCallback((): void => {
    setSessionPickerQuery('')
    setSessionPickerOpen(true)
  }, [])

  const closeSessionPicker = useCallback((): void => {
    setSessionPickerOpen(false)
    setSessionPickerQuery('')
  }, [])

  return {
    detailTab,
    sessionPickerOpen,
    sessionPickerRole,
    sessionPickerQuery,
    sessionPickerBusy,
    eventsExpanded,
    actions: {
      setDetailTab,
      setSessionPickerOpen,
      setSessionPickerRole,
      setSessionPickerQuery,
      setSessionPickerBusy,
      setEventsExpanded,
      resetDetailView,
      openSessionPicker,
      closeSessionPicker,
    },
  }
}
