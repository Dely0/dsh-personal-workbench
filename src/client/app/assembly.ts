/**
 * D17 / P7-2：装配层交给四段 JSX 的**那一束东西**。
 *
 * 为什么是大对象而不是逐个 props：这四段是"同一份装配结果的不同位置"（顶栏、提示层、
 * 主体、弹窗），逐个传会得到四份几乎重复的 40+ 字段清单，任一处漏传都只在运行期露头；
 * 而设计 §4 的边界（"同一语义只有一个所有者"）约束的是**状态**，不是"读"。
 * 所以：域的**结果**整束注入，每个组件只解构自己真正用到的那几个字段 ——
 * 组件文件头那段 `const { … } = props.xxx` 就是它的真实依赖声明（也是审查入口）。
 *
 * 刻意不做的事：不引入 Context、不做全局 store、不把域 hook 的返回值拆成 setter 传下去
 *（视图拿意图不拿 setter，设计 §5）。
 */
import type { DayPanelProps } from '../components/DayPanel.js'
import type { useDayWorkspace } from '../hooks/useDayWorkspace.js'
import type { useIdeas } from '../hooks/useIdeas.js'
import type { useKnowledge } from '../hooks/useKnowledge.js'
import type { useTaskData } from '../hooks/useTaskData.js'
import type { useTaskDetailModel } from '../hooks/useTaskDetailModel.js'
import type { useTaskForms } from '../hooks/useTaskForms.js'
import type { useTaskListModel } from '../hooks/useTaskListModel.js'
import type { useWorkbenchAISessions } from '../hooks/useWorkbenchAISessions.js'
import type { useWorkbenchBusy } from '../hooks/useWorkbenchBusy.js'
import type { useWorkbenchDirectoryPicker } from '../hooks/useWorkbenchDirectoryPicker.js'
import type { useWorkbenchDrafts } from '../hooks/useWorkbenchDrafts.js'
import type { useWorkbenchFeedback } from '../hooks/useWorkbenchFeedback.js'
import type { useWorkbenchNavigation } from '../hooks/useWorkbenchNavigation.js'
import type { useWorkbenchQuickIntake } from '../hooks/useWorkbenchQuickIntake.js'
import type { useWorkbenchReminders } from '../hooks/useWorkbenchReminders.js'
import type { useWorkbenchSettings } from '../hooks/useWorkbenchSettings.js'
import type { DshSessionListState, DshSessionSummary, Task, WorkbenchRuntime } from '../viewTypes.js'
import type { workspaceCandidates } from '../workspacePicker.js'

export interface WorkbenchAssembly {
  /** 导航域（D17/P6-1）。 */
  nav: ReturnType<typeof useWorkbenchNavigation>
  /** 任务数据域（D17/P3-4）。 */
  data: ReturnType<typeof useTaskData>
  /** 任务表单域（D17/P3-3）。 */
  forms: ReturnType<typeof useTaskForms>
  /** 任务详情域（D17/P3-2）。 */
  detail: ReturnType<typeof useTaskDetailModel>
  /** 任务列表域（D17/P3-1）。 */
  taskList: ReturnType<typeof useTaskListModel>
  /** 日期域（D17/P4）。 */
  day: ReturnType<typeof useDayWorkspace>
  /** 快速录入域（D17/P6-2）。 */
  quick: ReturnType<typeof useWorkbenchQuickIntake>
  /** AI 会话域（D17/P6-3）。 */
  ai: ReturnType<typeof useWorkbenchAISessions>
  /** 设置域（D17/P5-1）。 */
  prefs: ReturnType<typeof useWorkbenchSettings>
  /** 目录选择域（D17/P6-4）。 */
  dir: ReturnType<typeof useWorkbenchDirectoryPicker>
  /** 界面忙碌标志（D17/P6-1）。 */
  busyApi: ReturnType<typeof useWorkbenchBusy>
  /** 提醒域（D17/P5-2）。 */
  remindersApi: ReturnType<typeof useWorkbenchReminders>
  /** 草稿域（D17/P5-3）。 */
  draftsApi: ReturnType<typeof useWorkbenchDrafts>
  /** 知识域（D17/P1）。 */
  knowledge: ReturnType<typeof useKnowledge>
  /** 点子域（D17/P2）。 */
  ideas: ReturnType<typeof useIdeas>
  /** 反馈域（D17/P5-1）：toast 宿主与三个写口。 */
  feedback: ReturnType<typeof useWorkbenchFeedback>

  /* ---- 宿主与模块级助手（刻意留在入口的模块作用域，以注入形式下发，避免成环） ---- */
  runtime: WorkbenchRuntime
  closePanel: () => void
  loadModelModalityTable: () => Promise<ReadonlyMap<string, readonly string[] | null>>
  aiSessionUsable: (runtime: WorkbenchRuntime, sessionId: string) => boolean

  /* ---- 装配层本地值：跨域组合算出来的，不属任何域 ---- */
  collapseAll: () => void
  dayPanelProps: Omit<DayPanelProps, 'emptyPlanAction'>
  now: Date
  pendingCount: number
  linkedSessionIds: Set<string>
  sessionCandidates: DshSessionSummary[]
  sessionListSnapshot: DshSessionListState
  reparentCandidates: Array<{ id: string; title: string; depth: number }>
  workspaceChoices: ReturnType<typeof workspaceCandidates>
  openTask: (task: Task) => void
  openTaskById: (taskId: string) => void
  linkExistingSession: (sessionId: string) => Promise<void>
  saveDailyCapacity: () => Promise<void>
  saveEditDraft: () => Promise<void>
  openQuickEntry: () => void
  openDirPicker: (target: 'quick' | 'form' | 'edit') => void
  applyWorkspaceDir: (dirPath: string) => void
}
