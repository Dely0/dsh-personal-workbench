/**
 * 前后端共享的 API 契约。
 *
 * 为什么需要：client 与 host 曾各自定义 Task/TaskRow 两套形状，36 处 API 调用全是内联泛型。
 * 后端改字段时前端不会编译报错，只会在运行时变成 undefined。这里把"HTTP 返回什么"
 * 收敛成单一事实来源，两侧共用。
 *
 * 约定：本文件只放类型与纯常量，不 import 任何运行时依赖（client bundle 会打到浏览器）。
 */

// ---------------------------------------------------------------------------
// 字典
// ---------------------------------------------------------------------------

export interface DictionaryEntry {
  id: string
  kind: string
  code: string
  name: string
  config: Record<string, unknown>
  builtin: number
  active: number
  sortOrder: number
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

/** 任务在 HTTP 层的形状：与 repo 的 TaskRow 一致，但 allDay 是布尔。 */
export interface PublicTask {
  id: string
  parentId: string | null
  title: string
  description: string
  typeCode: string
  statusCode: string
  priorityCode: string
  aiPolicyCode: string
  dueAt: string | null
  /** 动态有效截止时间（自身为空时继承最近祖先） */
  effectiveDueAt: string | null
  allDay: boolean
  estimatedMinutes: number | null
  source: string
  workspacePath: string | null
  /** 动态有效工作区（自身为空时继承最近祖先） */
  effectiveWorkspacePath: string | null
  archived: number
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

export interface TaskReminderView {
  id: string
  taskId: string
  offsetMinutes: number
  methodCode: string
  firedAt: string | null
}

export interface TaskDetailView {
  task: PublicTask
  children: PublicTask[]
  sessions: Array<Record<string, unknown>>
  reminders: TaskReminderView[]
  events: Array<Record<string, unknown>>
}

export interface TaskSessionView {
  taskId: string
  sessionId: string
  roleCode: string
  workspace: string | null
  note: string | null
  createdAt: string
  lastActivityAt: string | null
}

// ---------------------------------------------------------------------------
// 草稿
// ---------------------------------------------------------------------------

export type DraftKind = 'task' | 'subtask_plan' | 'daily_plan' | 'report' | 'knowledge' | 'idea_cluster' | 'idea_tasks' | 'completion'

export interface DraftView {
  id: string
  kindCode: DraftKind | string
  sessionId: string | null
  payload: Record<string, unknown>
  statusCode: string
  /** 非空表示已「暂存」：仍是待确认，但不再自动弹窗 */
  deferredAt: string | null
  /** 累计暂存次数 */
  deferCount: number
  createdAt: string
  updatedAt: string
}

/**
 * 确认草稿时「本该创建、但没创建」的条目。
 *
 * 契约意义：确认接口**不允许**静默丢件。任何一项没建出来都必须出现在 `problems` 里，
 * 界面负责标黄列出（2026-09-12 事故：5 个子任务里 2 个因为 type_code 非法
 * 被静默过滤，接口却返回成功）。
 */
export interface DraftConfirmProblemView {
  /** 没建出来的那条的标题。 */
  title: string
  /** 非法字段。 */
  field: 'typeCode' | 'priorityCode'
  /** 调用方实际传入的值。 */
  code: string
  /** 给人看的中文原因。 */
  reason: string
}

/** 确认草稿的响应：`problems` 非空时界面必须显式告警。 */
export interface DraftConfirmResponse {
  ok: true
  task?: PublicTask
  tasks?: PublicTask[]
  /** 实际创建/入册的节点数（父任务草稿含父任务自身）。 */
  created?: number
  problems?: DraftConfirmProblemView[]
  reviewId?: string
  /** 复盘确认时写入团队记忆的结果（v1.14.0）。 */
  memory?: ReviewMemoryResultView
}

/** 复盘 → 团队记忆库的写入结果（v1.14.0）。 */
export interface ReviewMemoryResultView {
  /** 用户是否选择了写入（未选则不写，且不是错误）。 */
  enabled: boolean
  /** 生效的可见性。 */
  scope: 'private' | 'team'
  /** 真正新写入的条数（幂等：重复确认时为 0）。 */
  written: number
  /** 因幂等被跳过的条数。 */
  skipped: number
  /** 记忆库不可达等降级原因；非空表示"本地已留档、等补传"或"只落了本地"。 */
  degradedReason?: string
  /** 落地的本地 Markdown 文件名（便于用户核对）。 */
  files?: string[]
}

// ---------------------------------------------------------------------------
// 提醒
// ---------------------------------------------------------------------------

export interface ReminderPolicyView {
  enabled: boolean
  immediatePriorities: string[]
  digestPriorities: string[]
  digestAt: string
  quietHours: { start: string; end: string } | null
  quietHoursBypassPriorities: string[]
  hourlyLimit: number
  dailyLimit: number
  catchupWindowHours: number
  catchupMaxItems: number
  breakerCooldownMinutes: number
  channel: 'auto' | 'wechat' | 'browser'
  /** 草稿通知：哪些草稿类型推送到微信（空数组 = 全部不推） */
  draftNotifyKinds: string[]
}

export interface ReminderChannelStatus {
  installed: boolean
  configured: boolean
  botId: string | null
  targetId: string | null
  botLabel: string | null
  circuitOpen: boolean
  circuitUntil: string | null
  queued: number
}

export interface ReminderTargetOption {
  targetId: string
  label: string
  kind: string
}

export interface ReminderBotOption {
  botId: string
  label: string
  targets: ReminderTargetOption[]
}

export interface ReminderOptionsView {
  installed: boolean
  bots: ReminderBotOption[]
}

export interface DueReminderView {
  reminderId: string
  taskId: string
  title: string
  dueAt: string
  offsetMinutes: number
  methodCode: string
}

export interface ReminderQueueEntry {
  id: string
  reminderId: string | null
  rootTaskId: string
  taskId: string
  title: string
  body: string
  priorityCode: string
  dueAt: string | null
  attempts: number
  nextAttemptAt: string
  lastError: string | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

export interface WorkbenchSettings {
  defaultWorkspace: string
  autoCreateTypeFolders: boolean
  desktopNotify: boolean
  /** 每天可投入时长（分钟），用于「今日容量」对比；缺省 390（6.5 小时） */
  dailyCapacityMinutes: number
  /**
   * 快速录入（澄清）里「最近用过的工作区」路径，最新的在前（最多 5 条）。
   *
   * 为什么放在设置里而不是 localStorage：工作区路径是**任务数据的属性**
   * （任务详情、AI 会话目录都与它一致），换台机器/换个浏览器打开工作台时
   * 仍然应该看到同一批候选；localStorage 会随浏览器消失。
   */
  quickWorkspaceRecent: string[]
}

// ---------------------------------------------------------------------------
// 点子 / 知识
// ---------------------------------------------------------------------------

export interface IdeaView {
  id: string
  title: string
  contentMd: string
  kindCode: string
  tags: string[]
  sourceSessionId: string | null
  createdAt: string
  updatedAt: string
}

export interface IdeaClusterView {
  id: string
  title: string
  summary: string
  ideaIds: string[]
  notes: Record<string, unknown>
  createdAt: string
}

export interface KnowledgeView {
  id: string
  title: string
  contentMd: string
  kindCode: string
  tags: string[]
  sourceTaskId: string | null
  sourceReviewId: string | null
  fileLink: string | null
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// 技能目录（AI 会话前的 Skill 选择器）
// ---------------------------------------------------------------------------

/** 技能摘要：不含正文（正文由模型侧 skill 工具按需加载）。 */
export interface SkillSummary {
  name: string
  description: string
  whenToUse?: string
  provider: string
  source: string
  userInvocable: boolean
  modelInvocable: boolean
}

/**
 * available=false 表示宿主未注册 skills 服务（或技能发现失败），
 * 此时 skills 为空数组，前端隐藏选择器、保持既有行为。
 */
export interface SkillsResponse { ok: true; available: boolean; skills: SkillSummary[]; error?: string }

// ---------------------------------------------------------------------------
// 响应封装
// ---------------------------------------------------------------------------

/** 所有成功响应都带 ok: true；失败响应形状见 ApiError。 */
export interface ApiError {
  ok?: false
  error: string
}

export interface TasksResponse { ok: true; tasks: PublicTask[]; archivedOnly: boolean }
export interface TaskResponse { ok: true; task: PublicTask; cascade?: boolean }
export type TaskDetailResponse = { ok: true } & TaskDetailView
export interface SettingsResponse { ok: true; settings: WorkbenchSettings }
export interface ReminderPolicyResponse { ok: true; policy: ReminderPolicyView }
export interface ReminderChannelResponse { ok: true; status: ReminderChannelStatus; options: ReminderOptionsView; queue: ReminderQueueEntry[] }
export interface ReminderChannelSaveResponse { ok: true; status: ReminderChannelStatus }
export interface ReminderTestResponse { ok: boolean; reason?: string }
export interface DueRemindersResponse { ok: true; reminders: DueReminderView[] }
export interface DraftResponse { ok: true; draft: DraftView | null; /** 仅无 session_id 的列表查询返回 */ deferredDrafts?: DraftView[] }
export interface DraftsResponse { ok: true; drafts: DraftView[] }
export interface IdeasResponse { ok: true; ideas: IdeaView[] }
export interface KnowledgeResponse { ok: true; entries: KnowledgeView[] }
export interface IdeaClustersResponse { ok: true; clusters: IdeaClusterView[] }
export interface DeletedResponse { ok: true; deleted: boolean }
