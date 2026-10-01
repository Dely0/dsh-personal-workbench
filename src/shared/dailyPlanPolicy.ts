/**
 * 「每日计划投入 / 当日候选 / 今日容量」的**唯一权威口径**
 * （纯模块：零 React / 零 DOM / 零 Node I/O / 零 SQLite）。
 *
 * ## 为什么需要
 *
 * 计划项的 `minutes`（今天在这条上投多少分钟）与任务的 `estimatedMinutes` **不是同一件事**：
 * 前者是"某一天的计划投入快照"，后者是"整件事大概要多久"。requirements §4.1 明确
 * 两者规则不同（一个 1–1440 且非法**整份拒绝**、一个非法退回 null"没填"）。
 *
 * 把它们写成同一个函数正是"同一语义两处实现"的反面教材，
 * 所以这里单独给计划投入一份校验，并由工具、路由、仓储草稿确认**共用**。
 *
 * ## 这个模块被谁消费（不许在别处再算一遍）
 *
 * - **服务端**：`db/repo/plans.ts`（校验/合并/守卫）、`tools.ts`（提案 minutes 快照）、
 *   `api/routes/plans.ts`（PUT/POST/PATCH）。
 * - **客户端**：`client/capacity.ts`（容量账本）、`client/index.tsx`（AI 排序入口的候选）。
 *
 * 需求 §5.1 明令"AI 排序、手动添加、容量未排入区都消费同一全集，不各自重复 filter"。
 * 所以候选判定 `planCandidates()` 只在这里实现一份；`test/dailyPlanPolicy.test.mjs` 与
 * `test/capacityWiring.test.mjs`（源码扫描）一起把它钉住。
 *
 * ## 依赖方向
 *
 * 只 import `./contracts.js` 与 `./taskProgress.js`（都是纯类型/纯函数），
 * 因此服务端与客户端两个编译容器都能引用。
 */

import type { PublicTask } from './contracts.js'
import { isOpenTask } from './taskProgress.js'

/** 计划投入的下界（0 表示"没投入"是非法输入，缺省才走默认值）。 */
export const MIN_PLAN_MINUTES = 1
/** 计划投入的上界（与 `dailyCapacityMinutes` / `estimatedMinutes` 一致）。 */
export const MAX_PLAN_MINUTES = 1440
/** 任务的预计耗时也取不到时的兜底计划投入（与设置项 `defaultEstimateMinutes` 的缺省一致）。 */
export const DEFAULT_PLAN_MINUTES = 30

/** AI 提示词里最多列多少条候选（需求 §5.1；UI 手动池与账本**不截断**）。 */
export const PLAN_PROMPT_CANDIDATE_LIMIT = 30

export type PlanMinutesCheck = { ok: true; value: number } | { ok: false; reason: string }

/**
 * 校验显式给出的计划投入分钟。
 *
 * 与 `estimatedMinutes` 的差别（**刻意不同，别合并**）：
 * - 这里是**显式输入**，非法值**整份提案/编辑拒绝**并报出 `items[index]` 与字段；
 * - `estimatedMinutes` 非法时退回 `null`（= 没填），因为它是可选的存量字段。
 *
 * @param value - 待校验值（来自 AI 工具参数或 HTTP body，故类型是 unknown）。
 */
export function checkPlanMinutes(value: unknown): PlanMinutesCheck {
  if (typeof value !== 'number') return fail(value, '必须是数字')
  if (Number.isNaN(value)) return fail(value, '不能是 NaN')
  if (!Number.isFinite(value)) return fail(value, '不能是 Infinity/-Infinity')
  if (!Number.isInteger(value)) return fail(value, '必须是整数分钟')
  if (value < MIN_PLAN_MINUTES) return fail(value, `不能小于 ${MIN_PLAN_MINUTES}（省略该字段才走默认投入，不要填 0）`)
  if (value > MAX_PLAN_MINUTES) return fail(value, `不能大于 ${MAX_PLAN_MINUTES}`)
  return { ok: true, value }
}

function fail(value: unknown, why: string): { ok: false; reason: string } {
  return { ok: false, reason: `计划投入必须是 ${MIN_PLAN_MINUTES}–${MAX_PLAN_MINUTES} 的整数分钟：${JSON.stringify(value) ?? String(value)} ${why}` }
}

/**
 * 省略 minutes 时的**快照取值**：任务合法预计耗时优先，否则设置里的默认投入。
 *
 * 「快照」是硬要求（requirements §4.1）：提案创建那一刻算出来就冻结，
 * 之后用户改任务的预计耗时**不会**回头改写已有计划项。
 */
export function resolveDefaultPlanMinutes(taskEstimatedMinutes: unknown, settingsDefault: unknown): number {
  if (typeof taskEstimatedMinutes === 'number' && Number.isInteger(taskEstimatedMinutes) && taskEstimatedMinutes >= MIN_PLAN_MINUTES && taskEstimatedMinutes <= MAX_PLAN_MINUTES) {
    return taskEstimatedMinutes
  }
  if (typeof settingsDefault === 'number' && Number.isInteger(settingsDefault) && settingsDefault >= MIN_PLAN_MINUTES && settingsDefault <= MAX_PLAN_MINUTES) {
    return settingsDefault
  }
  return DEFAULT_PLAN_MINUTES
}

/** 从任务行取"建议投入"：合法预计耗时，否则默认。 */
export function suggestedPlanMinutes(task: { estimatedMinutes?: number | null } | undefined, settingsDefault: unknown): number {
  return resolveDefaultPlanMinutes(task?.estimatedMinutes ?? null, settingsDefault)
}

// ---------------------------------------------------------------------------
// 计划项形状与解析
// ---------------------------------------------------------------------------

/**
 * 持久化的计划项（`daily_plans.items_json[]`）。
 *
 * `minutes` / `effortDone` 是迁移 19 起就存在的字段；旧数据可能缺（迁移已回填，
 * 但手工改过的库仍可能缺），所以**解析层必须容忍**并给出诊断，而不是把整份计划读废。
 */
export interface PlanItemShape {
  taskId: string
  order: number
  title: string
  note: string
  minutes: number
  effortDone: boolean
}

export type PlanItemsParse =
  | { readable: true; items: PlanItemShape[]; diagnostics: string[] }
  | { readable: false; reason: string }

/**
 * 解析 `items_json`（未知输入 → 可判别结果）。
 *
 * ## 为什么坏项**保留**而不是过滤掉
 *
 * "静默丢件是禁区"（项目硬约束）：一项读不出来时，把它从数组里剔掉会让用户看到
 * "计划里少了一条，又没人说"。所以坏项**原样进 `diagnostics`**、不进 `items`，
 * 但整体仍标记为可读（其余合法项照常展示与计容量）。
 *
 * 只有**整串**不是 JSON / 不是数组时才算"计划数据无法解析"（容量必须显示"不可计算"
 * 而不是假装 0）。
 */
export function parsePlanItems(raw: unknown): PlanItemsParse {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return { readable: false, reason: 'items_json 不是合法 JSON' }
    }
  }
  if (!Array.isArray(value)) return { readable: false, reason: 'items_json 不是数组' }

  const items: PlanItemShape[] = []
  const diagnostics: string[] = []
  value.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      diagnostics.push(`第 ${index + 1} 项不是对象，已跳过（原数据未改动）`)
      return
    }
    const row = entry as Record<string, unknown>
    const taskId = typeof row.taskId === 'string' ? row.taskId : ''
    if (taskId === '') {
      diagnostics.push(`第 ${index + 1} 项缺 taskId，已跳过（原数据未改动）`)
      return
    }
    const rawMinutes = row.minutes
    const minutesCheck = checkPlanMinutes(rawMinutes)
    if (!minutesCheck.ok) {
      diagnostics.push(`第 ${index + 1} 项（${taskId}）的 minutes 非法：${minutesCheck.reason}`)
    }
    items.push({
      taskId,
      order: typeof row.order === 'number' && Number.isFinite(row.order) ? row.order : index + 1,
      title: typeof row.title === 'string' ? row.title : '',
      note: typeof row.note === 'string' ? row.note : '',
      minutes: minutesCheck.ok ? minutesCheck.value : DEFAULT_PLAN_MINUTES,
      effortDone: row.effortDone === true,
    })
  })
  return { readable: true, items, diagnostics }
}

// ---------------------------------------------------------------------------
// 写入校验：任务存在 / 关闭 / 父子链
// ---------------------------------------------------------------------------

/** 校验需要的最小任务形状（`getTask` 的行 / 客户端 `Task` / `PublicTask` 都满足）。 */
export interface PlanTaskRef {
  id: string
  parentId: string | null
  title: string
  statusCode: string
  archived: number | boolean
}

export type PlanValidation = { ok: true } | { ok: false; reason: string }

/**
 * `archived` 在两种容器里的类型不同：仓储行是 `0|1` 数字，客户端 `Task` 是布尔。
 * **必须两种都认** —— 写成 `archived === true ? 1 : 0` 会把仓储行的 `1` 判成"未归档"，
 * 于是"新增已归档任务"会被静默放行（这是实测抓到的真 bug，不是理论风险）。
 */
function archivedFlag(archived: number | boolean | undefined): number {
  return archived === true || archived === 1 ? 1 : 0
}

/** 一个任务是否在 `ancestorId` 的子树内（含相等）。未知任务 → false，带环保护。 */
export function isTaskWithinSubtree(
  byId: ReadonlyMap<string, PlanTaskRef>,
  candidateId: string,
  ancestorId: string,
): boolean {
  if (candidateId === ancestorId) return true
  const seen = new Set<string>([candidateId])
  let cursor = byId.get(candidateId)
  let guard = 0
  while (cursor !== undefined && cursor.parentId !== null && guard < 64) {
    const parentId = cursor.parentId
    if (seen.has(parentId)) return false
    seen.add(parentId)
    if (parentId === ancestorId) return true
    cursor = byId.get(parentId)
    guard += 1
  }
  return false
}

/**
 * 校验一份**最终**计划项集合（需求 §4.1 的"共同链校验"）。
 *
 * 规则：
 * 1. 同一 taskId 不得重复；
 * 2. 任务必须存在 —— **但只对新增项强制**：事务里读到既有计划中的缺失任务时，
 *    允许原样保留（"未知任务只拒绝新增"）；缺失/已关闭的项不能操作任务与结束投入；
 * 3. 新增项的任务必须未归档、未 done/cancelled（既有关闭项允许保留为历史记录）；
 * 4. 同一父子链不能同时入计划（同一祖先下的不同兄弟叶子允许）。
 *    **两项都在既有计划里**的历史脏数据不因本次无关写入被拒（不擅自替用户改历史决定）。
 *
 * @param items 最终集合（顺序即展示顺序）
 * @param byId 全量任务索引
 * @param preexistingIds 本次写入前**已在**该日计划中的 taskId（用于第 2/3/4 条的豁免）
 */
export function checkPlanTaskSet(
  items: ReadonlyArray<{ taskId: string }>,
  byId: ReadonlyMap<string, PlanTaskRef>,
  preexistingIds: ReadonlySet<string>,
): PlanValidation {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.taskId)) {
      const name = byId.get(item.taskId)?.title ?? item.taskId
      return { ok: false, reason: `任务「${name}」在同一天的计划里重复出现` }
    }
    seen.add(item.taskId)
  }

  for (const item of items) {
    const isNew = !preexistingIds.has(item.taskId)
    const task = byId.get(item.taskId)
    if (task === undefined) {
      if (isNew) return { ok: false, reason: `计划里的任务不存在：${item.taskId}` }
      continue
    }
    if (isNew && !isOpenTask({ statusCode: task.statusCode, archived: archivedFlag(task.archived) })) {
      const why = archivedFlag(task.archived) === 1 ? '已归档' : task.statusCode === 'done' ? '已完成' : '已取消'
      return { ok: false, reason: `任务「${task.title}」${why}，不能新增进计划（既有项可以原样保留）` }
    }
  }

  const ids = [...seen]
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i]
      const b = ids[j]
      const related = isTaskWithinSubtree(byId, a, b) || isTaskWithinSubtree(byId, b, a)
      if (!related) continue
      // 两项都在既有计划里 → 历史脏数据，不因本次写入被拒（用户可自行移除）。
      if (preexistingIds.has(a) && preexistingIds.has(b)) continue
      const nameA = byId.get(a)?.title ?? a
      const nameB = byId.get(b)?.title ?? b
      return { ok: false, reason: `任务「${nameA}」与「${nameB}」在同一父子链上，不能同时列入计划` }
    }
  }
  return { ok: true }
}

/**
 * 合并「草稿/AI 提案」与「服务端最新计划」，得到确认要落库的最终项。
 *
 * 三条硬规则（requirements §4.1/§4.2）：
 * 1. **各来源省略 minutes 都保留既有值**（列表里同 taskId 已存在 → 用库里的快照）；
 *    显式给出 minutes 才更改（草稿的 minutes 是提案时算的显式快照，优先）；
 * 2. **`effortDone` 只能由用户写**：一律取服务端最新计划项的值，AI 输入无效；
 *    AI 传了 `effortDone` 由工具层直接报错（这里只做"不采信"的兜底）；
 * 3. 新项（库里没有同 taskId）`effortDone=false`。
 */
export function mergePlanItems(
  incoming: ReadonlyArray<{ taskId: string; order?: number; title?: string; note?: string; minutes?: number }>,
  existing: ReadonlyArray<PlanItemShape>,
  titleOf: (taskId: string) => string,
): PlanItemShape[] {
  const existingByTask = new Map(existing.map((item) => [item.taskId, item]))
  return incoming.map((item, index) => {
    const previous = existingByTask.get(item.taskId)
    const explicit = checkPlanMinutes(item.minutes)
    const currentTitle = titleOf(item.taskId)
    return {
      taskId: item.taskId,
      order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : index + 1,
      // 任务还在 → 用最新标题；任务已缺失 → **保留**上一次存下的标题（不许静默丢件）。
      title: currentTitle !== '' ? currentTitle : (previous?.title ?? item.title ?? ''),
      note: item.note ?? previous?.note ?? '',
      minutes: explicit.ok ? explicit.value : (previous?.minutes ?? DEFAULT_PLAN_MINUTES),
      effortDone: previous?.effortDone ?? false,
    }
  }).sort((a, b) => a.order - b.order)
}

// ---------------------------------------------------------------------------
// 当日候选（唯一实现：AI 排序 / 手动池 / 账本未排入区共用）
// ---------------------------------------------------------------------------

/** 候选进入候选集合的原因（界面与提示词都直接展示它）。 */
export type PlanCandidateReason = 'planned' | 'overdue' | 'due-today' | 'in-progress'

/** 只有 `dueUnparseable` 一种诊断码：截止串是脏值但任务仍按 doing/已排入候选。 */
export type PlanCandidateDiagnosticCode = 'due-unparseable'

export interface PlanCandidateDiagnostic {
  code: PlanCandidateDiagnosticCode
  taskId: string
  message: string
}

/**
 * 候选判定需要的最小任务形状。
 *
 * `effectiveDueAt` 是仓储层算好的"自身优先、否则沿父链继承"结果（客户端 `Task` 同样有）。
 */
export interface PlanCandidateTask {
  id: string
  parentId: string | null
  title: string
  statusCode: string
  priorityCode: string
  effectiveDueAt: string | null
  estimatedMinutes: number | null
  archived?: number | boolean
  createdAt: string
}

export interface PlanCandidate {
  taskId: string
  title: string
  /** 最终顺序（1 起）。 */
  rank: number
  /** 影响排序的档位（未知优先级归 p3）。 */
  band: 'p0' | 'p1' | 'p2' | 'p3'
  /** 全部命中原因（可能同时"逾期"且"在推进"）。 */
  reasons: PlanCandidateReason[]
  dueToday: boolean
  overdue: boolean
  inProgress: boolean
  planned: boolean
  /** 已排入该日计划时的**计划投入快照**；未排入为 undefined。 */
  plannedMinutes: number | undefined
  /** 该日计划里的顺序；未排入为 undefined。 */
  plannedOrder: number | undefined
  /** 未排入时给界面/账本看的"建议投入"（当前估时/默认），明确不是已有投入。 */
  suggestedMinutes: number
  /** 该任务是否走了默认估时（界面据此标注"按默认 N 分钟"）。 */
  usedDefaultEstimate: boolean
  /** 截止串无法解析（仍是候选，但标记异常，绝不当作"无截止"）。 */
  dueUnparseable: boolean
  statusCode: string
  effectiveDueAt: string | null
  createdAt: string
}

export interface PlanCandidateInput {
  /** **全量**任务列表（含归档/done/cancelled）—— open 过滤在函数内做。 */
  tasks: readonly PlanCandidateTask[]
  /** 该日计划项（`minutes` = 计划投入快照）。无计划传 `[]`。 */
  planItems: readonly { taskId: string; order: number; minutes?: number }[]
  /** 目标本地日 D 的起止 epoch 毫秒（**显式传入**，便于午夜/DST 测试，不读系统时钟）。 */
  dayStartMs: number
  dayEndMs: number
  /** 「显示逾期待办候选」开关：只扩充"逾期且不在推进/不在计划中"的候选。 */
  includeOverdue: boolean
  /** 省略估时时的默认投入（settings.defaultEstimateMinutes）。 */
  defaultEstimateMinutes: number
}

export interface PlanCandidateResult {
  /** **完整**候选全集（稳定排序，不截断）。AI 提示词 / 手动池 / 未排入区共用它。 */
  candidates: PlanCandidate[]
  /** 未排入 = 候选 − 计划 taskId（账本"未排入"区与一键排入的数据源）。 */
  unscheduled: PlanCandidate[]
  /** 全部诊断（脏 due 等），界面必须显示而不是静默吞掉。 */
  diagnostics: PlanCandidateDiagnostic[]
  /** 候选全量条数（**不是**提示词截断后的条数）。 */
  total: number
}

function candidateBand(priorityCode: string): 'p0' | 'p1' | 'p2' | 'p3' {
  return priorityCode === 'p0' || priorityCode === 'p1' || priorityCode === 'p2' ? priorityCode : 'p3'
}

const BAND_RANK: Record<'p0' | 'p1' | 'p2' | 'p3', number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

/**
 * 一个任务在**某一天 D** 上的事实命中 —— 全项目唯一口径（ADR0001 口径冻结 / 批次2 D14）。
 *
 * 为什么必须抽出来：候选池（`planCandidates`）与日期面板的任务树
 * （`dayPanelTreeSources`）问的是同一个问题 ——"这条任务和 D 这一天什么关系"。
 * 各自再写一遍 `Date.parse` / 状态判断，就是本项目最大的 bug 类别
 * （"同一个语义被独立计算多次"）：改了工作日界算法却只改了其中一处。
 *
 * `dayStartMs` / `dayEndMs` 由调用方显式传入（便于午夜与 DST 测试，不读系统时钟）。
 */
export interface TaskDayFacts {
  /** 截止落在 [dayStart, dayEnd)。 */
  dueToday: boolean
  /** 截止早于 dayStart。 */
  overdue: boolean
  /** 状态是 `doing` / `blocked`（"在推进"）。 */
  inProgress: boolean
  /** 已排入该日计划。 */
  planned: boolean
  /** 截止串存在但无法解析（脏值）—— 它不是"无截止"，必须能被观测到。 */
  dueUnparseable: boolean
}

export interface TaskDayFactsInput {
  effectiveDueAt: string | null
  statusCode: string
  planned: boolean
  dayStartMs: number
  dayEndMs: number
}

/** 判定一个任务的"当日事实"。**唯一实现** —— 候选池与日期面板树都调它。 */
export function classifyTaskDay(input: TaskDayFactsInput): TaskDayFacts {
  const dueMs = input.effectiveDueAt === null ? Number.NaN : Date.parse(input.effectiveDueAt)
  const hasDue = Number.isFinite(dueMs)
  return {
    dueToday: hasDue && dueMs >= input.dayStartMs && dueMs < input.dayEndMs,
    overdue: hasDue && dueMs < input.dayStartMs,
    inProgress: input.statusCode === 'doing' || input.statusCode === 'blocked',
    planned: input.planned,
    dueUnparseable: input.effectiveDueAt !== null && !hasDue,
  }
}

/**
 * 日期面板任务树的**来源**（ADR0001 口径冻结，2026-10-01 用户拍板）：
 * **当日到期 ∪ 当日计划项 ∪ 进行中**。
 *
 * ⚠️ 「逾期」**不是**来源之一（是否加第 4 个来源待用户定案，见 ADR0001 的 ⚠️ 条）：
 * 逾期任务只会因为"在推进"或"已排入计划"而出现在树里。
 */
export type DayPanelSource = 'due' | 'plan' | 'doing'

/** 行标签的固定显示顺序：到期 → 计划 → 进行中（不许用"主来源"覆盖其余）。 */
export const DAY_PANEL_SOURCE_ORDER: readonly DayPanelSource[] = ['due', 'plan', 'doing']

/** 来源的中文行标签（界面直接用，不另写一份判断）。 */
export function dayPanelSourceLabel(source: DayPanelSource): string {
  if (source === 'due') return '到期'
  if (source === 'plan') return '计划'
  return '进行中'
}

export interface DayPanelSourceInput {
  /** **全量**任务（含 done/cancelled/归档）—— open 过滤在函数内做。 */
  tasks: readonly PlanCandidateTask[]
  /** 该日计划项（只看 taskId）。 */
  planItems: readonly { taskId: string }[]
  dayStartMs: number
  dayEndMs: number
}

export interface DayPanelSourceEntry {
  taskId: string
  /** 命中的全部来源，按 `DAY_PANEL_SOURCE_ORDER` 排序（可能同时命中多个）。 */
  sources: DayPanelSource[]
}

export interface DayPanelSourceResult {
  /** 应进入该日面板树的任务及其全部来源（**不过滤父链** —— 树由调用方构建）。 */
  entries: DayPanelSourceEntry[]
  /** 计划项指向但任务已不存在的 taskId（树里不渲染，但要能说清为什么少了）。 */
  missingTaskIds: string[]
  diagnostics: PlanCandidateDiagnostic[]
}

/**
 * 日期面板树的任务来源判定（**唯一实现**）。
 *
 * 与候选池的分工：候选池回答"AI/手动**可以往今天排**什么"（多一个"逾期开关"维度、还要排序与截断）；
 * 本函数回答"这一天的树里**应该显示**什么"。两者共用 `classifyTaskDay`，不共用筛选公式。
 */
export function dayPanelTreeSources(input: DayPanelSourceInput): DayPanelSourceResult {
  const planIds = new Set(input.planItems.map((item) => item.taskId))
  const entries: DayPanelSourceEntry[] = []
  const diagnostics: PlanCandidateDiagnostic[] = []
  const seen = new Set<string>()

  for (const task of input.tasks) {
    if (!isOpenTask({ statusCode: task.statusCode, archived: archivedFlag(task.archived) })) continue
    const facts = classifyTaskDay({
      effectiveDueAt: task.effectiveDueAt,
      statusCode: task.statusCode,
      planned: planIds.has(task.id),
      dayStartMs: input.dayStartMs,
      dayEndMs: input.dayEndMs,
    })
    const sources: DayPanelSource[] = []
    if (facts.dueToday) sources.push('due')
    if (facts.planned) sources.push('plan')
    if (facts.inProgress) sources.push('doing')
    if (sources.length === 0) continue
    seen.add(task.id)
    if (facts.dueUnparseable) {
      diagnostics.push({
        code: 'due-unparseable',
        taskId: task.id,
        message: `任务「${task.title}」的截止时间无法解析（${task.effectiveDueAt ?? ''}）：仍按${facts.inProgress ? '进行中' : '已排入计划'}进入日期面板，但没有"当日到期"可言`,
      })
    }
    entries.push({ taskId: task.id, sources })
  }

  return {
    entries,
    missingTaskIds: [...planIds].filter((id) => !seen.has(id)),
    diagnostics,
  }
}

/**
 * 当日候选全集（需求 §5.1）——**唯一实现**。
 *
 * 候选 = open 且满足任一：
 * - `effectiveDueAt` 落在 D 的本地日；
 * - 状态是 `doing`/`blocked`（含截止在未来的长任务）；
 * - 已在 D 的计划中；
 * - `effectiveDueAt` 早于 D 且 `includeOverdue=true`。
 *
 * 稳定排序：p0/p1/p2/p3（未知按 p3）→ 有效截止升序（无/坏值最后）→ `createdAt` 升序 → id 词典序。
 */
export function planCandidates(input: PlanCandidateInput): PlanCandidateResult {
  const planByTask = new Map(input.planItems.map((item) => [item.taskId, item]))
  const candidates: PlanCandidate[] = []
  const diagnostics: PlanCandidateDiagnostic[] = []

  for (const task of input.tasks) {
    if (!isOpenTask({ statusCode: task.statusCode, archived: archivedFlag(task.archived) })) continue

    const planned = planByTask.get(task.id)
    /**
     * 当日事实走**唯一口径**（`classifyTaskDay`，与日期面板树共用）。
     * 这里不再自己 `Date.parse` / 比状态 —— 两处各写一份正是本函数被抽出来的原因。
     */
    const facts = classifyTaskDay({
      effectiveDueAt: task.effectiveDueAt,
      statusCode: task.statusCode,
      planned: planned !== undefined,
      dayStartMs: input.dayStartMs,
      dayEndMs: input.dayEndMs,
    })
    const { dueToday, overdue, inProgress, dueUnparseable } = facts

    const reasons: PlanCandidateReason[] = []
    if (facts.planned) reasons.push('planned')
    if (overdue && input.includeOverdue) reasons.push('overdue')
    if (dueToday) reasons.push('due-today')
    if (inProgress) reasons.push('in-progress')
    // 逾期但开关关着、又不在推进也不在计划里 → 不是候选（这是开关唯一的作用面）。
    if (reasons.length === 0) continue

    if (dueUnparseable) {
      diagnostics.push({
        code: 'due-unparseable',
        taskId: task.id,
        message: `任务「${task.title}」的截止时间无法解析（${task.effectiveDueAt ?? ''}）：仍按${inProgress ? '推进中' : '已排入'}参与候选，但没有"今天到期/逾期"可言`,
      })
    }

    const estimate = typeof task.estimatedMinutes === 'number' && Number.isInteger(task.estimatedMinutes)
      && task.estimatedMinutes >= MIN_PLAN_MINUTES && task.estimatedMinutes <= MAX_PLAN_MINUTES
      ? task.estimatedMinutes
      : null

    candidates.push({
      taskId: task.id,
      title: task.title,
      rank: 0,
      band: candidateBand(task.priorityCode),
      reasons,
      dueToday,
      overdue,
      inProgress,
      planned: planned !== undefined,
      plannedMinutes: planned?.minutes,
      plannedOrder: planned?.order,
      suggestedMinutes: resolveDefaultPlanMinutes(estimate, input.defaultEstimateMinutes),
      usedDefaultEstimate: estimate === null,
      dueUnparseable,
      statusCode: task.statusCode,
      effectiveDueAt: task.effectiveDueAt,
      createdAt: task.createdAt,
    })
  }

  candidates.sort((a, b) => {
    const band = BAND_RANK[a.band] - BAND_RANK[b.band]
    if (band !== 0) return band
    const dueA = dueSortKey(a.effectiveDueAt)
    const dueB = dueSortKey(b.effectiveDueAt)
    if (dueA !== dueB) return dueA - dueB
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
  })
  candidates.forEach((candidate, index) => { candidate.rank = index + 1 })

  return {
    candidates,
    unscheduled: candidates.filter((candidate) => !candidate.planned),
    diagnostics,
    total: candidates.length,
  }
}

/** 排序用的截止键：无截止 / 坏值排最后。 */
function dueSortKey(raw: string | null): number {
  if (raw === null) return Number.MAX_SAFE_INTEGER
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER
}

// ---------------------------------------------------------------------------
// 今日容量（从计划快照派生；唯一实现）
// ---------------------------------------------------------------------------

/** 账本一行的来源（逐字对应用户能看到的标签）。 */
export type CapacityRowSource =
  | 'plan-manual'
  | 'plan-ai'
  | 'plan-imported'

export interface CapacityPlanRow {
  taskId: string
  order: number
  title: string
  /** 计划投入快照（**权威数字**，不随任务估时变化）。 */
  minutes: number
  effortDone: boolean
  band: 'p0' | 'p1' | 'p2' | 'p3'
  statusCode: string
  /** 库里已经查不到这个 taskId（"任务不存在"：保留 title/minutes，不能操作）。 */
  taskMissing: boolean
  /** 任务已归档/完成/取消：计划记录仍然是历史投入，**不自动减掉**。 */
  taskClosed: boolean
  source: CapacityRowSource
}

export interface CapacityUnscheduledRow {
  taskId: string
  title: string
  band: 'p0' | 'p1' | 'p2' | 'p3'
  rank: number
  statusCode: string
  /** 建议投入 = 当前估时/默认；**不是**已有投入，也不进"已排"合计。 */
  suggestedMinutes: number
  usedDefaultEstimate: boolean
  dueToday: boolean
  overdue: boolean
  inProgress: boolean
}

export interface CapacityLedger {
  /**
   * 计划数据是否可解析。`false` 时 `planned=0` 但**界面必须显示"不可计算"**，
   * 不能把它当作"今天没有计划"（需求 §4.2/§5.2）。
   */
  readable: boolean
  /** 不可解析时的中文原因（`readable=false` 时非空）。 */
  reason: string | null
  /** 已排 = 该日所有有效计划项的 `minutes` 快照之和（含已结束、已关闭、缺失任务的历史投入）。 */
  planned: number
  /** 已结束的计划投入分钟（`effortDone=true` 的那部分）。 */
  doneMinutes: number
  /** 未结束的计划投入分钟。 */
  remainingMinutes: number
  /** 可投入（设置的每日容量）。 */
  capacityMinutes: number
  /** 余 = max(0, 可投入 − 已排)。 */
  free: number
  /** 已排 > 可投入。 */
  over: boolean
  /** 条形分母 = max(可投入, 已排, 1)。 */
  total: number
  byPriority: Record<'p0' | 'p1' | 'p2' | 'p3', number>
  plannedCount: number
  bySource: Record<CapacityRowSource, number>
  plannedItems: CapacityPlanRow[]
  /** 未排入候选（完整集合，不截断）。 */
  unscheduled: CapacityUnscheduledRow[]
  /** 未排入条数与建议投入合计（界面"未排入：N 条 / X 分钟"直接用）。 */
  unscheduledCount: number
  unscheduledSuggestedMinutes: number
  /** 脏数据诊断（缺 minutes、坏项等）——必须显示，不许静默。 */
  diagnostics: string[]
}

export interface ComputeCapacityLedgerInput {
  /** 全量任务（含归档/关闭）：未排入候选需要它，历史计划项的"任务不存在"也由它判定。 */
  tasks: readonly PlanCandidateTask[]
  /** 该日计划项（已解析）。无计划传 `[]`。 */
  planItems: ReadonlyArray<{
    taskId: string
    order: number
    title?: string
    minutes: unknown
    effortDone?: boolean
  }>
  /** 该日计划是否存在（不存在 ≠ 不可解析）。 */
  planExists: boolean
  /** 计划数据是否可解析；`false` 时 `reason` 必填。 */
  planReadable: boolean
  /** 不可解析原因。 */
  reason?: string | null
  /** 计划来源（`daily_plans.source_code`），用于账本"来源"列。 */
  sourceCode?: string | null
  dailyCapacityMinutes: number
  defaultEstimateMinutes: number
  includeOverdue: boolean
  dayStartMs: number
  dayEndMs: number
}

/**
 * 今日容量的**唯一权威实现**（需求 §5.2）。
 *
 * 口径（与旧版"按到期任务求和"**根本不同**，这是 ADR 0002 的落地）：
 * - 已排 = 该日**所有有效计划项**的 `minutes` 快照之和。包括 `effortDone`、
 *   任务 done/cancelled/archived/已删除的历史投入 —— 非计划项**永不**自动计入；
 * - 无计划 → 已排 0，未排入候选可见（**不回退**到到期任务求和）；
 * - 未排入 = 候选全集 − 计划 taskId；建议投入来自当前估时/默认，**不与已排混算**；
 * - 计划 JSON 不可解析 → `readable=false`（界面显示"不可计算"），不假装 0。
 */
export function computeCapacityLedger(input: ComputeCapacityLedgerInput): CapacityLedger {
  const capacityMinutes = safeCapacityNumber(input.dailyCapacityMinutes, 0)
  const planByTask = new Map<string, CapacityPlanRow>()
  const forCandidates: Array<{ taskId: string; order: number; minutes?: number }> = []
  const diagnostics: string[] = []
  const bySource: Record<CapacityRowSource, number> = { 'plan-manual': 0, 'plan-ai': 0, 'plan-imported': 0 }
  const source: CapacityRowSource = input.sourceCode === 'ai'
    ? 'plan-ai'
    : input.sourceCode === 'manual'
      ? 'plan-manual'
      : input.sourceCode === null || input.sourceCode === undefined
        ? 'plan-manual'
        : 'plan-imported'

  const taskById = new Map(input.tasks.map((task) => [task.id, task]))
  const plannedItems: CapacityPlanRow[] = []
  const byPriority: Record<'p0' | 'p1' | 'p2' | 'p3', number> = { p0: 0, p1: 0, p2: 0, p3: 0 }
  let planned = 0
  let doneMinutes = 0

  if (input.planReadable) {
    const seen = new Set<string>()
    input.planItems.forEach((item, index) => {
      if (seen.has(item.taskId)) {
        diagnostics.push(`第 ${index + 1} 项（${item.taskId}）与前面的项重复，账本只计一次`)
        return
      }
      seen.add(item.taskId)
      const check = checkPlanMinutes(item.minutes)
      if (!check.ok) {
        // 缺 minutes 的历史项：给默认值显示，但**必须**说清楚这不是快照。
        diagnostics.push(`第 ${index + 1} 项（${item.taskId}）缺合法 minutes：${check.reason}；容量按默认 ${DEFAULT_PLAN_MINUTES} 分钟展示`)
      }
      const minutes = check.ok ? check.value : DEFAULT_PLAN_MINUTES
      const task = taskById.get(item.taskId)
      const row: CapacityPlanRow = {
        taskId: item.taskId,
        order: item.order,
        title: item.title !== undefined && item.title !== '' ? item.title : (task?.title ?? item.taskId),
        minutes,
        effortDone: item.effortDone === true,
        band: candidateBand(task?.priorityCode ?? 'p3'),
        statusCode: task?.statusCode ?? 'missing',
        taskMissing: task === undefined,
        taskClosed: task !== undefined && !isOpenTask({ statusCode: task.statusCode, archived: archivedFlag(task.archived) }),
        source,
      }
      plannedItems.push(row)
      planByTask.set(item.taskId, row)
      forCandidates.push({ taskId: item.taskId, order: item.order, minutes })
      planned += minutes
      if (row.effortDone) doneMinutes += minutes
      byPriority[row.band] += minutes
      bySource[source] += 1
    })
  }

  const candidateResult = planCandidates({
    tasks: input.tasks,
    planItems: forCandidates,
    dayStartMs: input.dayStartMs,
    dayEndMs: input.dayEndMs,
    includeOverdue: input.includeOverdue,
    defaultEstimateMinutes: input.defaultEstimateMinutes,
  })

  const unscheduled: CapacityUnscheduledRow[] = candidateResult.unscheduled.map((candidate) => ({
    taskId: candidate.taskId,
    title: candidate.title,
    band: candidate.band,
    rank: candidate.rank,
    statusCode: candidate.statusCode,
    suggestedMinutes: candidate.suggestedMinutes,
    usedDefaultEstimate: candidate.usedDefaultEstimate,
    dueToday: candidate.dueToday,
    overdue: candidate.overdue,
    inProgress: candidate.inProgress,
  }))

  const unscheduledSuggestedMinutes = unscheduled.reduce((sum, row) => sum + row.suggestedMinutes, 0)
  const free = Math.max(0, capacityMinutes - planned)
  return {
    readable: input.planReadable,
    reason: input.planReadable ? null : (input.reason ?? '计划数据无法解析'),
    planned,
    doneMinutes,
    remainingMinutes: planned - doneMinutes,
    capacityMinutes,
    free,
    over: planned > capacityMinutes,
    total: Math.max(capacityMinutes, planned, 1),
    byPriority,
    plannedCount: plannedItems.length,
    bySource,
    plannedItems,
    unscheduled,
    unscheduledCount: unscheduled.length,
    unscheduledSuggestedMinutes,
    diagnostics: [...diagnostics, ...candidateResult.diagnostics.map((item) => item.message)],
  }
}

/** 可投入时长的合法化：非有限值退回 0，再夹进 0–1440。 */
function safeCapacityNumber(value: number, fallback: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(MAX_PLAN_MINUTES, Math.max(0, Math.round(raw)))
}

// ---------------------------------------------------------------------------
// 候选 → AI 提示词（30 条上限的唯一实现）
// ---------------------------------------------------------------------------

export interface PlanPromptCandidates {
  /** 实际列进提示词的候选（已排序、已截断）。 */
  listed: PlanCandidate[]
  /** 因为超过上限而没列出的条数（>0 时提示词与界面都必须写出来）。 */
  omitted: number
  /** 候选全量条数。 */
  total: number
  /** 是否发生了截断。 */
  truncated: boolean
  /** 给模型/用户看的一句话（**不许**说成"全量"）。 */
  notice: string
}

/**
 * 候选 → 提示词截断口径（需求 §5.1：最多 30 条，**先排序后截取**，并显式告知还有几条）。
 *
 * 这条只在这里实现一次：`client/dailyPlanPrompt.ts` 与 AI 排序入口都调用它，
 * 组件里不许再写 `.slice(0, 30)`。
 */
export function selectPromptCandidates(
  candidates: readonly PlanCandidate[],
  limit: number = PLAN_PROMPT_CANDIDATE_LIMIT,
): PlanPromptCandidates {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : PLAN_PROMPT_CANDIDATE_LIMIT
  const listed = candidates.slice(0, safeLimit)
  const omitted = Math.max(0, candidates.length - listed.length)
  return {
    listed,
    omitted,
    total: candidates.length,
    truncated: omitted > 0,
    notice: omitted > 0
      ? `另有 ${omitted} 条未列出，当前仅为已列候选排序（候选共 ${candidates.length} 条）`
      : '',
  }
}
