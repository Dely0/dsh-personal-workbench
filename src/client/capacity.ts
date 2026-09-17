/**
 * 「今日容量」的唯一权威源（纯函数）。
 *
 * ## 为什么要有这个模块
 * 这套算法原先**内联在一个 4987 行的组件体里**：没有纯函数、没有测试，
 * `t.estimatedMinutes ?? 30` 一个常量在 4 处复制粘贴，逾期任务完全不参与、
 * 全天任务（`allDay`）一次都没被读过。于是用户看到「已排 0 min」时
 * 无法判断那是"今天真没事"还是"系统把事算丢了"。
 *
 * 本模块把规则收成**一处实现**：
 * - 不 import React、不碰 DOM、不读 `document` → `node --test` 可直接测；
 * - `now` 与全部阈值**显式入参**，不读系统时钟（否则测试不可复现）；
 * - 接收**全量任务列表**（含 archived / done / cancelled）并**在内部过滤**。
 *   调用点不要先滤一遍：同一语义两个地方算，是本项目最大的 bug 类别。
 *
 * ## 规则（界面文案 §12.2 逐条对应，改这里必须同步改文案）
 * 1. `open` = `!archived && status ∉ {done, cancelled}`；
 * 2. 有效截止时间落在**今天本地日** → 计入（"今天到期"；继承来的同样参与）；
 * 3. 自身与继承都**没有**截止时间且状态是 `doing`/`blocked` → 计入（"无截止但在推进"）；
 * 4. 有效截止时间**早于今天 0 点** → 逾期：**默认不计入**，开关打开才计入（与 2 互斥）；
 * 5. 每条任务的分钟数 = `estimatedMinutes`（有限整数 1..1440），否则用**默认耗时**；
 * 6. 全天任务与普通任务**同算法**（`allDay` 只影响展示与重复锚点）；
 * 7. 账本两半 `included[]` / `overdueExcluded[]`，表尾合计必须等于 `planned`。
 */
import { localDateString } from './format.js'

/** 没填耗时时的兜底分钟数（缺省值；用户可在设置里改，见 `defaultEstimateMinutes` 入参）。 */
export const DEFAULT_ESTIMATE_MINUTES = 30
/** 默认耗时可设置的下界。 */
export const MIN_ESTIMATE_MINUTES = 5
/** `estimatedMinutes` 与默认耗时的上界（与 `dailyCapacityMinutes` 的上限一致）。 */
export const MAX_ESTIMATE_MINUTES = 1440

export type CapacityBand = 'p0' | 'p1' | 'p2' | 'p3'

/** 计入原因（账本「来源」列的权威取值）。 */
export type CapacitySource = 'due-today' | 'no-due-doing' | 'overdue-included'

/** 容量计算需要的最小任务形状。传全量列表：归档 / 已完成 / 已取消由函数内部排除。 */
export interface CapacityTask {
  id: string
  parentId: string | null
  title: string
  statusCode: string
  priorityCode: string
  /** 有效截止时间（仓储层已算好"自身优先、否则沿父链继承"的结果）。 */
  effectiveDueAt: string | null
  /** 任务自己写的截止时间（null 表示这条的 `effectiveDueAt` 是继承来的）。 */
  dueAt: string | null
  allDay: boolean
  estimatedMinutes: number | null
  archived?: boolean
}

export interface CapacityBreakdown {
  id: string
  title: string
  statusCode: string
  minutes: number
  band: CapacityBand
  /** 任务自己填的耗时（未归一化）；null 表示没填。 */
  estimated: number | null
  /** 是否走了默认耗时（没填、或填了非法值）。 */
  usedFallback: boolean
  allDay: boolean
  /** 逾期被开关放进来时置 true（账本里要能一眼看出这条是"逾期计入"）。 */
  overdueIncluded: boolean
  /** `effectiveDueAt` 来自祖先（任务自身 `dueAt` 为 null）。 */
  inheritedDue: boolean
  /** 继承自已取消父任务/祖先的过期 due（既有语义，见设计文档「幽灵逾期」）。 */
  ghostFromCancelledAncestor: boolean
  /**
   * 有效截止时间是**无法解析的脏串**（`Date.parse` → NaN）。
   *
   * 这种任务既算不了"今天到期"也算不了"逾期"，但**绝不能静默消失**：
   * 它一律进 `overdueExcluded` 账本并在界面标出来（"截止时间无法解析"），
   * 否则用户看到的是"少了一条又没人说"。它**不参与** `overdueMinutes` 合计。
   */
  dueUnparseable: boolean
  /** 判定原因；未计入时为 null。 */
  source: CapacitySource | null
  /**
   * 父子同链标记（D6：本次**不**去重，只让账本看得出"这两条是同一条链上的"）。
   * 取最近祖先的 id（顶层任务取自身 id）——纯派生，不引入新的产品语义。
   */
  chainId: string
}

export interface CapacityResult {
  /** 已排 = 所有计入任务的分钟之和。 */
  planned: number
  /** 余 = max(0, 可投入 − 已排)。 */
  free: number
  /** 已排 > 可投入（读数标为「超支」）。 */
  over: boolean
  /** 条形分母 = max(可投入, 已排, 1)（第三项只为避免除零，正常路径不可达）。 */
  total: number
  byPriority: Record<CapacityBand, number>
  /** 计入条数（= included.length）。 */
  counted: number
  /** 今天到期条数（含靠继承拿到今天截止的）。 */
  dueTodayCount: number
  /** 自身与继承都没有截止、但在推进的条数。 */
  noDueDoingCount: number
  /** 计入且走了默认耗时的条数。 */
  fallbackCount: number
  included: CapacityBreakdown[]
  overdueExcluded: CapacityBreakdown[]
  /** 被排除的逾期分钟合计（= sum(overdueExcluded[].minutes)）。 */
  overdueMinutes: number
}

/** 可投入时长 / 默认耗时的合法化：非有限值一律退回缺省，再夹进区间。 */
function safeNumber(value: number | null | undefined, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}

/**
 * 把「用户输入的预计耗时」归一化成可落库/可参与计算的值。
 *
 * - 有限整数且 ≥1 → `min(1440, 值)`；
 * - `0` / 负数 / 非有限（NaN、Infinity）/ 小数 / 非数字 → `null`（= 没填）。
 *
 * ⚠️ **服务端 PATCH（`src/api/routes/tasks.ts`）必须与这里同口径**，否则会出现
 * "库里 99999、界面按默认 30 算"的双口径。为什么没有直接共享这一份：客户端与宿主
 * 是两个编译容器（客户端不进 `tsconfig.build.json` 的宿主产物），跨容器 import 会把
 * 客户端源码拖进宿主产物。所以服务端写了一份同构夹取，并用 `test/routes.test.mjs`
 * 里一条**跨模块等价性断言**（同一批输入两份实现必须给同一个结果）钉住它们不许漂移。
 */
export function clampEstimatedMinutes(value: unknown): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value)) return null
  if (!Number.isInteger(value)) return null
  if (value < 1) return null
  return Math.min(MAX_ESTIMATE_MINUTES, value)
}

/** 单条任务的耗时取值：填了合法值就用它（夹到 1440），否则用默认耗时。 */
function minutesOf(task: CapacityTask, defaultMinutes: number): { minutes: number; usedFallback: boolean } {
  const normalized = clampEstimatedMinutes(task.estimatedMinutes)
  if (normalized === null) return { minutes: defaultMinutes, usedFallback: true }
  return { minutes: normalized, usedFallback: false }
}

function bandOf(priorityCode: string): CapacityBand {
  // 未知优先级归 p3（沿用既有口径：p0/p1/p2 之外的一切都算最低档）。
  return priorityCode === 'p0' || priorityCode === 'p1' || priorityCode === 'p2' ? priorityCode : 'p3'
}

export interface ComputeTodayCapacityInput {
  /** **全量**任务列表（含 archived / done / cancelled）——过滤在函数内做。 */
  tasks: readonly CapacityTask[]
  dailyCapacityMinutes: number
  defaultEstimateMinutes: number
  includeOverdue: boolean
  now: Date
}

export function computeTodayCapacity(input: ComputeTodayCapacityInput): CapacityResult {
  const { tasks, now, includeOverdue } = input
  const capacityMinutes = safeNumber(input.dailyCapacityMinutes, 0, 0, MAX_ESTIMATE_MINUTES)
  const defaultMinutes = safeNumber(input.defaultEstimateMinutes, DEFAULT_ESTIMATE_MINUTES, MIN_ESTIMATE_MINUTES, MAX_ESTIMATE_MINUTES)

  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime()

  const byId = new Map<string, CapacityTask>()
  for (const task of tasks) byId.set(task.id, task)

  /** 父任务（账本用它给"同一条父子链"打标记；顶层任务没有）。 */
  const parentOf = (task: CapacityTask): CapacityTask | null =>
    task.parentId === null ? null : byId.get(task.parentId) ?? null

  /** 祖先链里是否有已取消的任务（"幽灵逾期"判据：继承不看祖先状态，见设计文档 §1）。 */
  const hasCancelledAncestor = (task: CapacityTask): boolean => {
    const seen = new Set<string>([task.id])
    let cursor = task.parentId === null ? null : byId.get(task.parentId) ?? null
    while (cursor !== null) {
      if (seen.has(cursor.id)) return false
      seen.add(cursor.id)
      if (cursor.statusCode === 'cancelled') return true
      cursor = cursor.parentId === null ? null : byId.get(cursor.parentId) ?? null
    }
    return false
  }

  const included: CapacityBreakdown[] = []
  const overdueExcluded: CapacityBreakdown[] = []
  const byPriority: Record<CapacityBand, number> = { p0: 0, p1: 0, p2: 0, p3: 0 }
  let planned = 0
  let dueTodayCount = 0
  let noDueDoingCount = 0
  let fallbackCount = 0

  for (const task of tasks) {
    // 1. open 集合：归档 / 已完成 / 已取消一律不进账本（连"不计入"的理由都不需要给）。
    if (task.archived === true) continue
    if (task.statusCode === 'done' || task.statusCode === 'cancelled') continue

    const inheritedDue = task.dueAt === null && task.effectiveDueAt !== null
    const dueMs = task.effectiveDueAt === null ? Number.NaN : Date.parse(task.effectiveDueAt)
    const hasDue = Number.isFinite(dueMs)
    // 有 due 串但解析不出来 = 脏数据：既不是"今天"也不是"逾期"，但必须能被看见
    const dueUnparseable = task.effectiveDueAt !== null && !hasDue
    const doing = task.statusCode === 'doing' || task.statusCode === 'blocked'
    // 脏 due 串按"无法判定"处理：真没有截止时间（null）才算"无截止"
    const isToday = hasDue && dueMs >= dayStart && dueMs < dayEnd
    const isOverdue = hasDue && dueMs < dayStart

    const { minutes, usedFallback } = minutesOf(task, defaultMinutes)
    const ancestor = parentOf(task)
    const row: CapacityBreakdown = {
      id: task.id,
      title: task.title,
      statusCode: task.statusCode,
      minutes,
      band: bandOf(task.priorityCode),
      estimated: task.estimatedMinutes,
      usedFallback,
      allDay: task.allDay === true,
      overdueIncluded: false,
      inheritedDue,
      ghostFromCancelledAncestor: inheritedDue && hasCancelledAncestor(task),
      dueUnparseable,
      source: null,
      chainId: ancestor?.id ?? task.id,
    }

    if (isToday) {
      row.source = 'due-today'
      included.push(row)
      planned += minutes
      byPriority[row.band] += minutes
      dueTodayCount += 1
      if (usedFallback) fallbackCount += 1
      continue
    }
    if (!hasDue && doing) {
      row.source = 'no-due-doing'
      included.push(row)
      planned += minutes
      byPriority[row.band] += minutes
      noDueDoingCount += 1
      if (usedFallback) fallbackCount += 1
      continue
    }
    if (isOverdue) {
      // 逾期与"今天到期"互斥（上面已经 continue 掉了），不会算两遍。
      if (includeOverdue) {
        row.source = 'overdue-included'
        row.overdueIncluded = true
        included.push(row)
        planned += minutes
        byPriority[row.band] += minutes
        if (usedFallback) fallbackCount += 1
      } else {
        row.source = null
        overdueExcluded.push(row)
      }
      continue
    }
    if (dueUnparseable) {
      // 脏 due 串：无法判定是否今天/是否逾期，一律进账本让用户看见。
      // **不受开关影响**（它本来就不该被当成逾期计入），也**不进** overdueMinutes 合计。
      overdueExcluded.push(row)
      continue
    }
    // 其余（无截止且没在推进 / 状态不匹配）既不计入也不进逾期账本。
  }

  // 合计**只算真的逾期**：脏 due 串（dueUnparseable）也在这个账本里，但它没有"逾期分钟"可言 ——
  // 把它算进来会让"逾期 10 条 / 750 min"这种读数虚高，而且它不受开关影响。
  const overdueMinutes = overdueExcluded.reduce((sum, row) => sum + (row.dueUnparseable ? 0 : row.minutes), 0)
  const free = Math.max(0, capacityMinutes - planned)
  return {
    planned,
    free,
    over: planned > capacityMinutes,
    total: Math.max(capacityMinutes, planned, 1),
    byPriority,
    counted: included.length,
    dueTodayCount,
    noDueDoingCount,
    fallbackCount,
    included,
    overdueExcluded,
    overdueMinutes,
  }
}

/**
 * 稳定排序用的"今天"键（YYYY-MM-DD 本地日）。
 *
 * 存在的理由：`index.tsx` 里的 `now` 是**渲染体内每帧新建的对象**，
 * 放进 `useMemo` 依赖数组等于 memo 每帧失效。依赖这个字符串则跨天才变一次。
 */
export function capacityTodayKey(now: Date): string {
  return localDateString(now)
}
