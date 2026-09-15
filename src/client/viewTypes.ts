/**
 * 工作台客户端的视图模型类型（从 index.tsx 抽出，行为不变）。
 * 前后端 HTTP 契约在 src/shared/contracts.ts；这里只放客户端渲染用的行数据形状。
 */
import type { PromptContentPart } from './quickAttachments.js'

export type { PromptContentPart }


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
export interface Bootstrap {
  dictionaries: Dict[]
  stats: { overdue: number; todayDue: number; doing: number; total: number }
  todayPlan?: DailyPlanView | null
  /**
   * 团队记忆是否可用（v1.14.58）。
   *
   * 团队记忆是**公司内部系统**、不会开源，开源用户拿不到 `dsh-team-memory` 与内网服务。
   * 所以复盘弹框里的「🧠 同步到团队记忆库」**拿得到才渲染** ——
   * 否则开源用户会看到一个永远用不了的勾选框（它引用的服务在那边根本不存在）。
   *
   * `undefined`（旧服务端 / bootstrap 还没回来）= **按不可用处理**，宁可不显示。
   */
  memoryAvailable?: boolean
}
export interface TaskDetail { task: Task; children: Task[]; sessions: Array<Record<string, unknown>>; reminders: Array<{ id: string; taskId: string; offsetMinutes: number; methodCode: string; firedAt: string | null; skippedAt?: string | null; acknowledgedAt?: string | null }>; events: Array<Record<string, unknown>>; reviews: Array<Record<string, unknown>> }

export interface SessionDriver {
  sessionId: string
  /**
   * 发送一轮用户消息。
   *
   * v1.15.1 起内容不再只有文本：图片附件走宿主**原生多模态管线**的
   * `{type:'image', mediaType, data, name?}` 片段（不依赖任何视觉插件）。
   */
  prompt(content: PromptContentPart[], mode: 'queue'): Promise<{ ok?: boolean; error?: unknown }>
  rename(title: string): Promise<unknown>
}

/** 模型选择（宿主 `ModelSelection` 的本地形状）。 */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** 用户在工作台里显式选中的模型（含给界面看的可读标签）。 */
export interface QuickModelSelection extends ModelSelection {
  readonly label: string
  readonly effortLabel?: string
}

export interface ModelCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: { readonly efforts: ReadonlyArray<{ id: string; name: string }>; readonly defaultEffort?: string }
}

export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelCatalogModel[]
}

/**
 * 会话级模型目录快照（宿主 `dsh-client-ui-model-selection` 的 `ModelDirectoryState` 子集）。
 *
 * ⚠️ `current` 是**宿主的持久投影**（下一次请求会用哪个模型），本插件只读不算 ——
 * 判定与展示都走它，"用户选的"与"聊天里显示的"才是同一个事实。
 */
export interface ModelDirectoryState {
  readonly current: ModelSelection | null
  readonly routable?: boolean | null
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: ReadonlyArray<{ id: string; name: string; message: string }>
  readonly status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  readonly error: string | null
}

export interface ModelDirectoryRuntime {
  readonly store: {
    getSnapshot(): ModelDirectoryState
    subscribe(listener: () => void): () => void
  }
  load(): Promise<ModelDirectoryState>
  select(selection: ModelSelection): Promise<void>
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
  /**
   * 会话级模型目录（宿主 `dsh-client-ui-model-selection` 提供）。
   *
   * ## 为什么这里是**可选**、而不是写进客户端 `inject`
   *
   * 两条规则在这里冲突（调研文档 3.3 点名的那个决策）：
   *
   * - 本项目规范："前置条件进 `inject`、可选增强软探测"；
   * - 同一份规范又说："未声明 `inject` 的服务用 `ctx.get` 也拿不到（恒 undefined）"。
   *
   * 第二条在本宿主上**不成立**：cordis 4.0.1 的 `Registry.get(name, strict)` 文档原话是
   * "Read a service from the store **without the inject requirement**"，
   * 只要求提供方 fiber 处于活动态；抛 `cannot get property "…" without inject` 的是
   * **代理属性访问**（`ctx.modelDirectories`）那条路 —— 而我们一律走
   * `optionalService(ctx, name)`（= `ctx.get`），`slots`/`layout`/`uiWorkspace` 都是这么拿的。
   *
   * 所以决策是：**软探测，不进 `inject`**。理由是不可逆的成本不对称 ——
   * `dsh-client-ui-model-selection` 是**另一个客户端插件**，用户可以在 profile 里不装它；
   * 写进 `inject` 会让那种机器上**整个工作台面板 pending**（丢整块面板换一个下拉框）。
   * 未声明 `inject` 的判定由 `test/injectPolicy.test.mjs` 钉住。
   */
  modelDirectories?: {
    directoryFor(sessionId: string): ModelDirectoryRuntime
  }
  connection?: {
    generation: {
      getSnapshot(): { host: { home: string } } | undefined
    }
  }
}
