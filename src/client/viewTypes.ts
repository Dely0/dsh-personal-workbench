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

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export type PromptContentPart = { type: 'text'; text: string } | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface ModelProviderGroup {
  id: string
  name: string
  models: ReadonlyArray<{
    id: string
    name: string
    reasoning?: { defaultEffort?: string; efforts: ReadonlyArray<{ id: string; name: string }> }
  }>
}
export interface ModelDirectoryState {
  current: ModelSelection | null
  groups: readonly ModelProviderGroup[]
  failures: ReadonlyArray<{ id: string; name: string; message: string }>
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}
export interface ModelDirectoryRuntime {
  store: {
    getSnapshot(): ModelDirectoryState
    subscribe(listener: () => void): () => void
  }
  load(): Promise<ModelDirectoryState>
  select(selection: ModelSelection): Promise<void>
}

export interface SessionDriver {
  sessionId: string
  prompt(content: PromptContentPart[], mode: 'queue'): Promise<{ ok?: boolean; error?: unknown }>
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
  /**
   * 本地保留计数（按来源）。DSH 0.1.7 起 `SessionListState` 删除了 `current`，
   * 宿主统一用 `retainedBy.mainView > 0` 判定「当前会话」，见 hostNav.ts。
   */
  retainedBy?: Readonly<Record<string, number>>
}
export interface DshSessionListState {
  ids: string[]
  byId: Record<string, DshSessionSummary>
}
export interface WorkbenchRuntime {
  /** cordis 非严格服务读取（软探测未声明 inject 的服务只能走它）。 */
  get?: (key: string) => unknown
  sessions: {
    list: { getSnapshot(): DshSessionListState }
    binding(id: string): { session: SessionDriver } | undefined
  }
  workspaces: {
    list: { getSnapshot(): { items: readonly { workspaceId: string; path?: string }[] } }
    create?(input: { path: string }): Promise<{ workspaceId?: string }>
  }
  uiWorkspace?: {
    connectWorkspace(workspaceId: string): Promise<string>
    /** DSH 0.1.7 起取代 `sessions.open(id)` 的官方导航入口。 */
    openSession?(target: string): void
  }
  connection?: {
    generation: {
      getSnapshot(): { host: { home: string } } | undefined
    }
  }
  modelDirectories?: {
    directoryFor(sessionId: string): ModelDirectoryRuntime
  }
}
