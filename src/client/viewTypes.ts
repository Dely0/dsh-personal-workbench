/**
 * 工作台客户端的视图模型类型（从 index.tsx 抽出，行为不变）。
 * 前后端 HTTP 契约在 src/shared/contracts.ts；这里只放客户端渲染用的行数据形状。
 */
export interface Dict { kind: string; code: string; name: string; config: Record<string, unknown>; builtin?: number; active?: number; sortOrder?: number; createdAt?: string; updatedAt?: string }
export interface Task {
  id: string
  parentId: string | null
  title: string
  description: string
  typeCode: string
  statusCode: string
  priorityCode: string
  aiPolicyCode: string
  dueAt: string | null
  effectiveDueAt: string | null
  allDay: boolean
  estimatedMinutes: number | null
  source: string
  workspacePath: string | null
  effectiveWorkspacePath: string | null
  archived: boolean
  extra: Record<string, unknown>
  recurrenceCode: string | null
  recurrenceRule: Record<string, unknown>
  recurrenceMasterId: string | null
  recurrenceLastGenerated: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  cancelledAt: string | null
}
export interface DailyPlanItemView { taskId: string; order: number; title: string; note: string }
export interface DailyPlanView { id: string; planDate: string; summary: string; items: DailyPlanItemView[]; sourceCode: string; sessionId: string | null; createdAt: string; updatedAt: string }
export interface TaskReportView { id: string; periodCode: 'day' | 'week'; periodStart: string; title: string; summaryMd: string; stats: Record<string, unknown>; sessionId: string | null; createdAt: string; updatedAt: string }

// 提醒相关类型来自共享契约（前后端单一事实来源），此处不再重复定义。
export interface KnowledgeEntry { id: string; kindCode: string; title: string; contentMd: string; tags: string[]; sourceTaskId: string | null; sourceSessionId: string | null; sourceReviewId: string | null; fileLink: string | null; createdAt: string; updatedAt: string }
export interface Idea { id: string; title: string; contentMd: string; kindCode: string; tags: string[]; sourceSessionId: string | null; createdAt: string; updatedAt: string }
export interface IdeaClusterView { id: string; title: string; summaryMd: string; tags: string[]; ideas: Idea[]; createdAt: string; updatedAt: string }
export interface Bootstrap { dictionaries: Dict[]; stats: { overdue: number; todayDue: number; doing: number; total: number }; todayPlan?: DailyPlanView | null }
export interface TaskDetail { task: Task; children: Task[]; sessions: Array<Record<string, unknown>>; reminders: Array<{ id: string; taskId: string; offsetMinutes: number; methodCode: string; firedAt: string | null; skippedAt?: string | null; acknowledgedAt?: string | null }>; events: Array<Record<string, unknown>>; reviews: Array<Record<string, unknown>> }

export interface SessionDriver {
  sessionId: string
  prompt(content: Array<{ type: 'text'; text: string }>, mode: 'queue'): Promise<{ ok?: boolean; error?: unknown }>
  rename(title: string): Promise<unknown>
}
export interface DshSessionSummary {
  id: string
  title?: string
  displayTitle: string
  cwd?: string
  running?: boolean
  blank?: boolean
  updatedAt?: number
}
export interface DshSessionListState {
  ids: string[]
  byId: Record<string, DshSessionSummary>
  current?: string
}
export interface WorkbenchRuntime {
  sessions: {
    list: { getSnapshot(): DshSessionListState }
    binding(id: string): { session: SessionDriver } | undefined
    open(id: string): void
  }
  workspaces: {
    list: { getSnapshot(): { items: readonly { workspaceId: string; path?: string }[] } }
    create?(input: { path: string }): Promise<{ workspaceId?: string }>
    openPath?(path: string): Promise<void>
  }
  uiWorkspace: {
    connectWorkspace(workspaceId: string): Promise<string>
  }
  connection?: {
    generation: {
      getSnapshot(): { host: { home: string } } | undefined
    }
  }
}
