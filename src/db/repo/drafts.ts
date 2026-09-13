/**
 * 草稿域：提案草稿的建/读/改，以及把草稿确认成实体。
 *
 * 从 repo.ts 原样抽出（行为不变）。对外符号由 repo.ts 再导出。
 * 草稿行类型与确认骨架在 repo/shared.ts；实体创建分散在各自域。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, getDraft, setDraftStatus, withDraftConfirm, parseDraft, type DraftRow, type RawDraftRow } from './shared.js'
import { getTask, listTasks, createTask } from './tasks.js'
import { getDictionary } from './dictionaries.js'
import { linkTaskSession } from './task-sessions.js'
import { checkWorkspacePath } from '../../workspace-check.js'
import { addReminder } from './reminders.js'
import type { DraftInput, TaskInput, TaskRow } from '../repo.js'




/** 提案类草稿里的单个任务节点：工具侧写 snake_case，表单/任务草稿侧写 camelCase。 */
export type DraftTaskItem = Partial<TaskInput> & Record<string, unknown>

/**
 * 把草稿里的一个任务节点归一化成 createTask 入参。
 * 三条确认路径（task / subtask_plan / idea_tasks）共用，避免各自只处理一种写法而静默丢字段
 * （历史事故：estimated_minutes 只读 camelCase，而提案工具写的是 snake_case）。
 */
export function toTaskInputFromDraftItem(
  item: DraftTaskItem,
  defaults: { typeCode: string; priorityCode: string; statusCode?: string; source?: string; extra?: Record<string, unknown> },
): { title: string; input: TaskInput } | undefined {
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  if (title === '') return undefined
  const estimate = item.estimatedMinutes ?? item.estimated_minutes
  const allDay = item.allDay ?? item.all_day
  return {
    title,
    input: {
      title,
      description: typeof item.description === 'string' ? item.description : undefined,
      typeCode: String(item.typeCode ?? item.type_code ?? defaults.typeCode),
      priorityCode: String(item.priorityCode ?? item.priority_code ?? defaults.priorityCode),
      statusCode: typeof item.statusCode === 'string' ? item.statusCode : typeof item.status_code === 'string' ? item.status_code : defaults.statusCode,
      dueAt: typeof item.dueAt === 'string' ? item.dueAt : typeof item.due_at === 'string' ? item.due_at : null,
      allDay: allDay === true,
      estimatedMinutes: typeof estimate === 'number' ? estimate : undefined,
      aiPolicyCode: typeof item.aiPolicyCode === 'string' ? item.aiPolicyCode : undefined,
      source: defaults.source,
      workspacePath: typeof item.workspacePath === 'string' && item.workspacePath !== '' ? item.workspacePath : undefined,
      extra: (item.extra as Record<string, unknown> | undefined) ?? defaults.extra,
    },
  }
}

/**
 * 幂等建节点：同 parent 下已有同名（trim 后精确相等）任务时复用它，不新建。
 * 重复确认同一份拆解提案曾导致整棵任务树第二次落地（见 docs/issues/2026-09-09-*）。
 */
function findSiblingByTitle(db: DatabaseSync, parentId: string | null, title: string): TaskRow | undefined {
  const normalized = title.trim()
  return listTasks(db, { parentId, includeArchived: true }).find((task) => task.title.trim() === normalized)
}


export function createDraft(db: DatabaseSync, input: DraftInput, at = nowIso()): DraftRow {
  const id = randomUUID()
  const row: DraftRow = {
    id,
    kindCode: input.kindCode ?? 'task',
    sessionId: input.sessionId ?? null,
    payload: input.payload,
    statusCode: 'pending',
    deferredAt: null,
    deferCount: 0,
    createdAt: at,
    updatedAt: at,
  }
  db.prepare(`
    INSERT INTO task_drafts (id, kind_code, session_id, payload_json, status_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(row.id, row.kindCode, row.sessionId, JSON.stringify(row.payload), row.createdAt, row.updatedAt)
  return row
}


export function updateDraft(db: DatabaseSync, id: string, payload: Record<string, unknown>, at = nowIso()): DraftRow | undefined {
  const draft = getDraft(db, id)
  if (draft === undefined || draft.statusCode !== 'pending') return undefined
  db.prepare('UPDATE task_drafts SET payload_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(payload), at, id)
  return getDraft(db, id)
}

export function getDraftBySession(db: DatabaseSync, sessionId: string): DraftRow | undefined {
  return parseDraft(db.prepare('SELECT * FROM task_drafts WHERE session_id = ? AND status_code = \'pending\' ORDER BY created_at DESC LIMIT 1').get(sessionId) as RawDraftRow | undefined)
}



/**
 * 草稿确认时「本该创建、但没创建」的条目。
 *
 * 存在的原因是一次真实事故：`workbench_submit_task` 的 subtasks 里只要有一个
 * `type_code` 不在字典中，旧实现就 `continue` —— 无告警、无记录、接口照样返回成功，
 * 用户看到的是「5 个子任务里凭空少了 2 个」（见
 * docs/issues/2026-09-12-subtask-type-code-silently-dropped.md）。
 *
 * 现在的契约：**任何一项没建出来，都必须出现在 problems 里**，由确认接口回传、
 * 界面标黄列出。宁可让用户看见一条"没建成功"，也绝不静默丢件。
 */
export interface DraftItemProblem {
  /** 该条目的标题（可能为空串，用于展示"哪一条没建"）。 */
  title: string
  /** 非法字段：typeCode / priorityCode。 */
  field: 'typeCode' | 'priorityCode'
  /** 调用方实际传入的值。 */
  code: string
  /** 给人看的中文原因。 */
  reason: string
}

/**
 * 校验一个草稿任务节点的 type/priority code 是否可落库。
 * 返回 undefined 表示通过；否则返回问题项（调用方应收集并跳过创建）。
 *
 * 注意这里是**两遍扫描的第一遍**：validate → collect，第二遍才真正建树。
 * 这样"父层非法"能整棵子树跳过并只报一条，不会出现"父没了子还在"的半截树。
 */
export function validateDraftTaskItem(
  db: DatabaseSync,
  normalized: { title: string; input: { typeCode: string; priorityCode: string } },
): DraftItemProblem | undefined {
  const { title, input } = normalized
  if (getDictionary(db, 'type', input.typeCode)?.active !== 1) {
    return { title, field: 'typeCode', code: input.typeCode, reason: `任务类型「${input.typeCode}」不在字典中（或已停用），本项及其子项未创建` }
  }
  if (getDictionary(db, 'priority', input.priorityCode)?.active !== 1) {
    return { title, field: 'priorityCode', code: input.priorityCode, reason: `优先级「${input.priorityCode}」不在字典中（或已停用），本项及其子项未创建` }
  }
  return undefined
}

/** `confirmTaskDraft` 的返回：建出来的任务 + 没建出来的条目。 */
export interface ConfirmTaskDraftResult {
  task: TaskRow
  /** 计划创建但被校验拦下的条目（正常情况为空数组）。 */
  problems: DraftItemProblem[]
  /** 实际创建的子任务数（不含父任务）。 */
  childCount: number
  /**
   * 本次没有新建任何东西，返回的是**先前已经落地的那个任务**。
   *
   * 出现场景：同一条草稿被确认两次（前端并发点击、网络级重试、
   * 或本幂等守卫上线前就已确认过的老草稿）。
   */
  replayed?: boolean
  /** 复用了本次之前就已存在的同名同级任务（老草稿恢复路径）。 */
  reused?: boolean
  /**
   * 库里**另有一条**同名任务（不是本次要复用/回放的那条）。
   *
   * ⚠️ 只是告警，**不阻止创建**：同一个标题建两条任务是正当需求
   * （每周例会、按月重复的跟进）。这里把事实摆出来，由用户决定。
   * 真实事故：快速录入建的草稿 + AI 执行会话又提交的同名草稿各被确认一次
   * → 「待处理」里冒出一条同名任务（见 docs/issues/2026-09-13-*）。
   */
  duplicateOf?: {
    task: TaskRow
    /** 与本次草稿的差别（描述/工作区不同则说明是两次独立录入，而非重复提交）。 */
    sameDescription: boolean
    sameWorkspace: boolean
  }
}

/** `confirmSubtaskPlanDraft` 的返回：建出来（或复用）的任务 + 没建出来的条目。 */
export interface ConfirmSubtaskPlanResult {
  tasks: TaskRow[]
  problems: DraftItemProblem[]
}

export function confirmTaskDraft(
  db: DatabaseSync,
  draftId: string,
  actor = 'user',
  at = nowIso(),
  /**
   * 用户的明确意图：
   *
   * - `create`（默认）：正常建单。同父同名**只告警不合并** —— 同名任务可能真的需要两条
   *   （每周例会），静默合并会吃掉用户的正当需求。
   * - `dedupe`：用户在界面上看到了「库里已有同名任务」的告警，并且**选择复用那一条**。
   *   此时不新建，直接把已有任务当作本次产出（幂等落库，草稿照样标 confirmed）。
   */
  intent: 'create' | 'dedupe' = 'create',
): ConfirmTaskDraftResult | undefined {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'task') return undefined
  const payload = draft.payload as Partial<TaskInput> & { reminderOffsetMinutes?: number; reminder_offset_minutes?: number; subtasks?: Array<Partial<TaskInput> & Record<string, unknown>> }
  const title = typeof payload.title === 'string' ? payload.title : ''
  if (title.trim() === '') throw new Error('draft payload requires a non-empty title')
  const parentId = typeof payload.parentId === 'string' ? payload.parentId : null
  /**
   * 工作区路径校验（v1.14.25，补子任务 4 的原始验收标准）。
   *
   * 原始标准要求"不存在/不可写的工作区给出明确提示，**而不是静默回落默认值**"。
   * 实测过：提交 `Z:\不存在的目录\xyz` 会被静默接受（HTTP 200 / problems=0）。
   * 这里在建任务**之前**拦下：路径无效就直接抛错，草稿保持 pending 供用户改，
   * 调用方（路由层）把中文原因回传给界面/工具。
   */
  const workspaceCheck = checkWorkspacePath(typeof payload.workspacePath === 'string' ? payload.workspacePath : null)
  if (!workspaceCheck.ok) throw new Error(String(workspaceCheck.reason))
  return withDraftConfirm(db, draftId, 'task', (confirmedDraft): ConfirmTaskDraftResult => {
    const problems: DraftItemProblem[] = []
    let childCount = 0
    /**
     * `dedupe` 意图：用户在「已有同名任务」告警里选了"就复用那一条，别再建"。
     *
     * ⚠️ **只在这个显式意图下复用同名任务**。默认路径（`create`）即使同名也照建 ——
     * 同一个标题建两条是正当需求（每周例会），而且"重复提交同一份草稿"这一半根因
     * 已经由 `confirmResult` 回放彻底堵住（同一条草稿绝不会产出两个任务）。
     * 把默认路径也改成"同名就复用"，会静默吃掉用户明确要建的第二条任务。
     *
     * 判据复用 `findSiblingByTitle`（`confirmSubtaskPlanDraft` 早就在用同一招防
     * "重复确认整棵树建两遍"）—— 两条确认路径从此共享同一个判据，
     * 不再一条有幂等、一条没有。
     */
    const sibling = findSiblingByTitle(db, parentId, title)
    if (intent === 'dedupe' && sibling !== undefined) {
      return { task: sibling, problems, childCount: listTasks(db, { parentId: sibling.id, includeArchived: true }).length, reused: true }
    }
    const task = createTask(db, {
      title,
      description: typeof payload.description === 'string' ? payload.description : undefined,
      typeCode: String(payload.typeCode ?? ''),
      statusCode: typeof payload.statusCode === 'string' ? payload.statusCode : undefined,
      priorityCode: String(payload.priorityCode ?? 'p2'),
      aiPolicyCode: typeof payload.aiPolicyCode === 'string' ? payload.aiPolicyCode : undefined,
      dueAt: typeof payload.dueAt === 'string' ? payload.dueAt : null,
      allDay: payload.allDay === true,
      estimatedMinutes: typeof payload.estimatedMinutes === 'number' ? payload.estimatedMinutes : null,
      source: typeof payload.source === 'string' ? payload.source : 'nl',
      parentId,
      // 用校验后的**归一化**路径：`/mnt/d/code` 在 Windows 上会被存成 `D:\code`，
      // 避免同一个工作区因为写法不同被当成两个。
      workspacePath: workspaceCheck.normalized,
      extra: payload.extra ?? {},
    }, actor, at)
    const explicitOffset = typeof payload.reminderOffsetMinutes === 'number'
      ? payload.reminderOffsetMinutes
      : typeof payload.reminder_offset_minutes === 'number' ? payload.reminder_offset_minutes : undefined
    const typeDefault = getDictionary(db, 'type', task.typeCode)?.config.defaultReminderMinutes
    const priorityDefault = getDictionary(db, 'priority', task.priorityCode)?.config.defaultReminderMinutes
    const reminderOffset = explicitOffset ?? (typeof typeDefault === 'number' ? typeDefault : typeof priorityDefault === 'number' ? priorityDefault : undefined)
    if (task.dueAt !== null && typeof reminderOffset === 'number' && Number.isFinite(reminderOffset) && reminderOffset >= 0) {
      addReminder(db, task.id, reminderOffset, 'browser', at)
    }
    // workbench_submit_task 的 subtasks 参数：确认任务时同步创建简版子任务。
    const rawChildren = Array.isArray(payload.subtasks) ? payload.subtasks as DraftTaskItem[] : []
    const walkChildren = (items: DraftTaskItem[], parentId2: string): void => {
      for (const item of items) {
        const normalized = toTaskInputFromDraftItem(item, { typeCode: task.typeCode, priorityCode: task.priorityCode, statusCode: 'todo', source: 'nl' })
        if (normalized === undefined) continue
        // 非法 code 不再 continue 了事：收进 problems 回传，界面能看见"哪一条没建、为什么"。
        const problem = validateDraftTaskItem(db, normalized)
        if (problem !== undefined) { problems.push(problem); continue }
        const child = createTask(db, { ...normalized.input, parentId: parentId2 }, actor, at)
        childCount += 1
        if (Array.isArray(item.children)) walkChildren(item.children as DraftTaskItem[], child.id)
      }
    }
    walkChildren(rawChildren, task.id)
    if (confirmedDraft.sessionId !== null && confirmedDraft.sessionId !== undefined) {
      linkTaskSession(db, { taskId: task.id, sessionId: confirmedDraft.sessionId, roleCode: 'clarify' }, at)
    }
    /**
     * **只告警、不合并**（用户 2026-09-13 决策）。
     *
     * 走到这里东西是新建的，但库里可能**另有一条**同名任务 —— 这正是本次事故的形态：
     * 快速录入的草稿建出任务 A，AI 执行会话又提交了一份同内容草稿、随后也被确认。
     * 把事实报给界面（含是否同描述/同工作区），由用户决定删哪一条；
     * 静默合并会误伤"同名重复任务"这种正当场景。
     */
    const duplicate = findSiblingByTitle(db, parentId, title)
    const duplicateOf = duplicate === undefined || duplicate.id === task.id
      ? undefined
      : {
          task: duplicate,
          sameDescription: (duplicate.description ?? '') === (task.description ?? ''),
          sameWorkspace: (duplicate.workspacePath ?? '') === (task.workspacePath ?? ''),
        }
    return { task, problems, childCount, ...(duplicateOf === undefined ? {} : { duplicateOf }) }
  }, {
    at,
    /**
     * 回放：这条草稿以前确认过 → 把当次建出来的任务原样还回去，**绝不重建**。
     *
     * payload 里存的是 `ConfirmTaskDraftResult` 本体（含 `task` / `childCount`）。
     * 老草稿（本守卫上线前确认、payload 里没有 `confirmResult`）拿不到 id 时不再猜测，
     * 抛可读错误让用户显式「放弃」—— 猜错的代价是又建一条重复任务，那正是本 BUG 本身。
     */
    replay: (cached): ConfirmTaskDraftResult => {
      const record = typeof cached === 'object' && cached !== null ? cached as { task?: { id?: unknown }; childCount?: unknown } : {}
      const taskId = typeof record.task?.id === 'string' ? record.task.id : undefined
      const existing = taskId === undefined ? undefined : getTask(db, taskId)
      if (existing === undefined) {
        throw new Error('这条任务草稿此前已经确认过（对应任务已不存在，或为旧版本留下的半截数据），不能重复确认；请选择「放弃」，或重新提交一份新草稿')
      }
      return {
        task: existing,
        problems: [],
        childCount: typeof record.childCount === 'number' ? record.childCount : listTasks(db, { parentId: existing.id, includeArchived: true }).length,
        replayed: true,
      }
    },
  })
}

export function confirmSubtaskPlanDraft(db: DatabaseSync, draftId: string, actor = 'user', at = nowIso()): ConfirmSubtaskPlanResult {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'subtask_plan') return { tasks: [], problems: [] }
  const payload = draft.payload as { parentTaskId?: string; subtasks?: DraftTaskItem[] }
  const parentTaskId = typeof payload.parentTaskId === 'string' ? payload.parentTaskId : undefined
  if (parentTaskId === undefined) throw new Error('subtask_plan requires parentTaskId')
  const parent = getTask(db, parentTaskId)
  if (parent === undefined) throw new Error(`parent task ${parentTaskId} not found`)
  if (parent.archived === 1 || parent.statusCode === 'done' || parent.statusCode === 'cancelled') {
    throw new Error(`parent task「${parent.title}」is archived or closed`)
  }
  const subtasks = Array.isArray(payload.subtasks) ? payload.subtasks : []
  return withDraftConfirm(db, draftId, 'subtask_plan', (): ConfirmSubtaskPlanResult => {
    const created: TaskRow[] = []
    const problems: DraftItemProblem[] = []
    const walk = (items: DraftTaskItem[], parentId: string | null): void => {
      for (const item of items) {
        const normalized = toTaskInputFromDraftItem(item, { typeCode: parent.typeCode, priorityCode: parent.priorityCode, source: parent.source })
        if (normalized === undefined) continue
        const { title, input } = normalized
        // 同 confirmTaskDraft：非法 code 收进 problems 而不是静默 continue。
        const problem = validateDraftTaskItem(db, normalized)
        if (problem !== undefined) { problems.push(problem); continue }
        // 幂等：同父下已有同名节点就复用，不重复建树（重确认同一份提案时保持任务 id/状态/用户编辑不变）。
        const existing = findSiblingByTitle(db, parentId, title)
        const task = existing ?? createTask(db, { ...input, parentId }, actor, at)
        created.push(task)
        if (Array.isArray(item.children)) walk(item.children as DraftTaskItem[], task.id)
      }
    }
    walk(subtasks, parentTaskId)
    if (draft.sessionId !== null && draft.sessionId !== undefined) {
      for (const task of created) {
        linkTaskSession(db, { taskId: task.id, sessionId: draft.sessionId, roleCode: 'breakdown' }, at)
      }
    }
    return { tasks: created, problems }
  }, { at, emptyValue: { tasks: [], problems: [] } })
}

export function getLatestPendingDraft(db: DatabaseSync): DraftRow | undefined {
  return parseDraft(db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' ORDER BY created_at DESC LIMIT 1").get() as RawDraftRow | undefined)
}

/**
 * 自动弹窗的数据源：只取**未暂存**的最新待确认草稿。
 * 暂存过的草稿仍是 pending（可确认/可驳回），只是不再打断用户。
 */
export function getLatestActiveDraft(db: DatabaseSync): DraftRow | undefined {
  return parseDraft(db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND deferred_at IS NULL ORDER BY created_at DESC LIMIT 1").get() as RawDraftRow | undefined)
}

/** 已暂存的待确认草稿（按暂存时间倒序），供「待处理」弹窗的「已暂存」段展示。 */
export function listDeferredDrafts(db: DatabaseSync): DraftRow[] {
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND deferred_at IS NOT NULL ORDER BY deferred_at DESC").all() as unknown as RawDraftRow[]
  return rows.map((row) => parseDraft(row)).filter((draft): draft is DraftRow => draft !== undefined)
}

/** 该任务是否已有暂存中的草稿（用于 AI 重提时提示）。 */
export function getDeferredDraftForTask(db: DatabaseSync, kindCode: string, taskId: string): DraftRow | undefined {
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND deferred_at IS NOT NULL AND kind_code = ? ORDER BY deferred_at DESC").all(kindCode) as unknown as RawDraftRow[]
  for (const row of rows) {
    const draft = parseDraft(row)
    if (draft !== undefined && draft.payload.taskId === taskId) return draft
  }
  return undefined
}

/**
 * 「暂存」的适用范围：**默认全部草稿类型都可暂存**。
 *
 * 历史：v1.12.0 只给验收类草稿（completion / review）加了「⏸ 暂存（先验证）」，
 * 其余 9 种（task / subtask_plan / daily_plan / report / knowledge / idea_cluster /
 * idea_tasks）只有「确认」和「放弃」两个出口 —— 草稿 pending 时红点常驻、轮询每 5 秒
 * 把它拉回来，用户被"钉"在工作台里，想去 DSH 里核对一下都做不到。
 *
 * 现在反过来：默认全部可暂存，用**黑名单**排除确实不该暂存的类型。
 * 目前黑名单为空 —— 保留这个开关是为了将来万一出现"暂存会造成语义错误"的类型
 * （例如某个必须在同一回合内处理完的即时确认）时有地方可写，而不是重新变回硬编码白名单。
 */
export const NON_DEFERRABLE_DRAFT_KINDS = [] as const

/** 兼容旧调用方（曾反向表达）：现在永远是空数组。 */
export const DEFERRABLE_DRAFT_KINDS = NON_DEFERRABLE_DRAFT_KINDS

export function isDeferrableDraftKind(kindCode: string): boolean {
  return !(NON_DEFERRABLE_DRAFT_KINDS as readonly string[]).includes(kindCode)
}

/** 暂存：pending 的草稿都可暂存（黑名单除外）；返回 undefined 表示不允许。 */
export function deferDraft(db: DatabaseSync, draftId: string, at = nowIso()): DraftRow | undefined {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.statusCode !== 'pending' || !isDeferrableDraftKind(draft.kindCode)) return undefined
  db.prepare('UPDATE task_drafts SET deferred_at = ?, defer_count = defer_count + 1, updated_at = ? WHERE id = ?').run(at, at, draftId)
  return getDraft(db, draftId)
}

/** 唤回：清掉暂存标记，草稿重新进入自动弹窗队列。 */
export function resumeDraft(db: DatabaseSync, draftId: string, at = nowIso()): DraftRow | undefined {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.statusCode !== 'pending') return undefined
  db.prepare('UPDATE task_drafts SET deferred_at = NULL, updated_at = ? WHERE id = ?').run(at, draftId)
  return getDraft(db, draftId)
}

export function getPendingDraftForTask(db: DatabaseSync, kindCode: string, taskId: string): DraftRow | undefined {
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND kind_code = ? ORDER BY created_at DESC").all(kindCode) as unknown as RawDraftRow[]
  for (const row of rows) {
    const draft = parseDraft(row)
    if (draft !== undefined && draft.payload.taskId === taskId) return draft
  }
  return undefined
}

export function abandonDraft(db: DatabaseSync, draftId: string, at = nowIso()): void {
  setDraftStatus(db, draftId, 'abandoned', at)
}
