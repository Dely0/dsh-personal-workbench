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
  /** 归档标记：仓储行是 `0|1`，客户端 `Task` 是布尔，**可选**（`PlanCandidateTask` 就省略它）。 */
  archived?: number | boolean
  /**
   * 同级排序键（ADR0010 的子树展开要用）。**可选**：省略时退化成只按 id 词典序，
   * 与 `planCandidates` / 日期面板树的"`createdAt` 升序、再 id"口径一致。
   */
  createdAt?: string
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

// ---------------------------------------------------------------------------
// 可执行叶子（ADR0010）：一个任务什么时候有资格成为某日计划项
// ---------------------------------------------------------------------------

/** 树深度硬上限（与 `isTaskWithinSubtree` 的环保护同一个数量级）。 */
const MAX_TREE_DEPTH = 64

interface LeafWalk {
  byId: ReadonlyMap<string, PlanTaskRef>
  byParent: ReadonlyMap<string | null, PlanTaskRef[]>
}

/** 同级排序：`createdAt` 升序、再 id 词典序（与 `planCandidates` / 日期面板树同口径）。 */
function compareSiblings(a: PlanTaskRef, b: PlanTaskRef): number {
  const left = a.createdAt ?? ''
  const right = b.createdAt ?? ''
  if (left !== right) return left < right ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function buildLeafWalk(tasks: readonly PlanTaskRef[]): LeafWalk {
  const byId = new Map<string, PlanTaskRef>()
  const byParent = new Map<string | null, PlanTaskRef[]>()
  for (const task of tasks) {
    byId.set(task.id, task)
    const siblings = byParent.get(task.parentId)
    if (siblings === undefined) byParent.set(task.parentId, [task])
    else siblings.push(task)
  }
  for (const siblings of byParent.values()) siblings.sort(compareSiblings)
  return { byId, byParent }
}

/** 未完成（open）= 未终结状态且未归档 —— **唯一判据** `isOpenTask` 的本地包装。 */
function isOpenRef(task: PlanTaskRef): boolean {
  return isOpenTask({ statusCode: task.statusCode, archived: archivedFlag(task.archived) })
}

/** 该任务有没有**未完成的直接子任务**。 */
function hasOpenChild(walk: LeafWalk, taskId: string): boolean {
  return (walk.byParent.get(taskId) ?? []).some(isOpenRef)
}

/**
 * 一个任务是不是**可执行叶子**：自己未完成，且下面没有未完成子任务。
 *
 * 为什么要有这个判定（ADR0010）：计划项必须是可执行叶子 —— 父子同时入列会把同一份工作
 * 在容量里算两遍；而在父任务上点「排入今日」的正确含义是**展开它下面的叶子**（见
 * `expandPlanLeaves`）。判定只在这里实现一份：写入校验、候选池、页签成员、容量未排入区
 * 全部消费它，任何"在别处再判一次叶子"的写法都是下一个同类 bug。
 *
 * 输入是**全量任务**（含归档/终结），open 过滤在函数内做。
 */
export function executableLeafIds(tasks: readonly PlanTaskRef[]): Set<string> {
  const walk = buildLeafWalk(tasks)
  const leaves = new Set<string>()
  for (const task of walk.byId.values()) {
    if (isOpenRef(task) && !hasOpenChild(walk, task.id)) leaves.add(task.id)
  }
  return leaves
}

/**
 * 把"排入这个任务"展开成**要落库的叶子 id 列表**（ADR0010 的核心动作）。
 *
 * 规则：
 * - 目标是叶子 → `[它自己]`；
 * - 目标是非叶子 → 它下面**全部未完成叶子**，按**树序**（先父后子；同级 `createdAt` 升序、
 *   再 id 词典序）—— 与日期面板树看到的顺序一致，叶子随其父成组；
 * - 终结/归档的后代**跳过**（今天不做已完成的活）；
 * - 目标未知或自己不是 open → `[]`。
 *
 * ⚠️ **返回空数组不等于成功**：成环的脏数据也会得到 `[]`（两个节点各有一个"未完成子任务"，
 * 没有叶子可言）。调用方必须让写入校验去拒绝它并给出可读原因，**不许**把"什么都没加"当成
 * 排入成功（那是静默丢件）。
 */
export function expandPlanLeaves(tasks: readonly PlanTaskRef[], rootId: string): string[] {
  const walk = buildLeafWalk(tasks)
  const root = walk.byId.get(rootId)
  if (root === undefined || !isOpenRef(root)) return []
  const out: string[] = []
  const visited = new Set<string>()
  const visit = (task: PlanTaskRef, depth: number): void => {
    if (depth > MAX_TREE_DEPTH || visited.has(task.id)) return
    visited.add(task.id)
    const children = (walk.byParent.get(task.id) ?? []).filter(isOpenRef)
    if (children.length === 0) {
      out.push(task.id)
      return
    }
    for (const child of children) visit(child, depth + 1)
  }
  visit(root, 0)
  return out
}

/**
 * 某一天「**已安排**」的任务集合（ADR0010 的口径，**唯一实现**）。
 *
 * 两种情形都算已安排：
 * 1. **自己是**该日计划项（叶子）；
 * 2. 它是**非叶子任务**，且它子树内的**全部可执行叶子**都已是该日计划项 —— 即
 *    "排期状态按子树继承"。只排了一部分叶子 → **不算**已安排（它还欠着活），于是它留在
 *    「未排期」页签，一键排入 = 把剩下的叶子补齐。
 *
 * 为什么不"排了任意一条就算"：那样父任务会在还剩 3 个子任务没排时就跳进「计划」，
 * 「未排期」页签里再也找不到那个补齐入口（用户 2026-10-05 拍板选"全部排完才算"）。
 *
 * 「未排期」因此仍然是**补集**（`open − 已安排 − 逾期`），三页签划分性质不变。
 */
export function dayPlacedIds(
  tasks: readonly PlanTaskRef[],
  planItems: readonly { taskId: string }[],
): Set<string> {
  const walk = buildLeafWalk(tasks)
  const planIds = new Set(planItems.map((item) => item.taskId))
  const placed = new Set<string>()
  for (const task of walk.byId.values()) {
    if (planIds.has(task.id)) placed.add(task.id)
  }

  /** 子树内的「可执行叶子总数 / 其中已排数」——自底向上算一次，避免每个任务各遍历一遍。 */
  const stats = new Map<string, { total: number; planned: number }>()
  const visiting = new Set<string>()
  const statsOf = (id: string): { total: number; planned: number } => {
    const cached = stats.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return { total: 0, planned: 0 } // 成环：按"没有叶子"处理，不死循环
    visiting.add(id)
    let total = 0
    let planned = 0
    for (const child of walk.byParent.get(id) ?? []) {
      if (!isOpenRef(child)) continue
      const childStats = statsOf(child.id)
      total += childStats.total
      planned += childStats.planned
    }
    // 它自己是可执行叶子才算一条（非叶子任务自己不占叶子名额）
    const self = walk.byId.get(id)
    if (self !== undefined && isOpenRef(self) && !hasOpenChild(walk, id)) {
      total += 1
      if (planIds.has(id)) planned += 1
    }
    visiting.delete(id)
    const result = { total, planned }
    stats.set(id, result)
    return result
  }

  for (const task of walk.byId.values()) {
    if (!isOpenRef(task)) continue
    const own = statsOf(task.id)
    if (own.total > 0 && own.planned === own.total) placed.add(task.id)
  }
  return placed
}

/** 一个**非叶子任务**在日期面板「计划」页签里当分组行时显示的合计。 */
export interface PlanGroupSummary {
  /** 它子树内的可执行叶子总数。 */
  totalLeaves: number
  /** 其中已是该日计划项的条数。 */
  plannedLeaves: number
  /** 这些已排叶子的计划投入合计（分钟）。 */
  plannedMinutes: number
}

/**
 * 分组行的合计（ADR0010，**唯一实现**）—— 只给**非叶子任务**产出条目。
 *
 * 为什么放共享层：它是"这条父任务今天排了多少"的口径，界面（日期面板）与将来的调用方
 * 必须共用同一份；散在组件里就是"同一语义两处实现"。
 */
export function planGroupSummaries(
  tasks: readonly PlanTaskRef[],
  planItems: ReadonlyArray<{ taskId: string; minutes?: number }>,
): Map<string, PlanGroupSummary> {
  const walk = buildLeafWalk(tasks)
  const itemMinutes = new Map<string, number>()
  for (const item of planItems) {
    if (itemMinutes.has(item.taskId)) continue
    itemMinutes.set(item.taskId, typeof item.minutes === 'number' && Number.isFinite(item.minutes) ? item.minutes : 0)
  }

  /** 递归用的备忘（**会包含叶子**）；对外只暴露非叶子任务，见下面的 `out`。 */
  const memo = new Map<string, PlanGroupSummary>()
  /** 对外的分组行合计：只放非叶子任务。 */
  const out = new Map<string, PlanGroupSummary>()
  const visiting = new Set<string>()
  const summaryOf = (id: string): PlanGroupSummary => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return { totalLeaves: 0, plannedLeaves: 0, plannedMinutes: 0 } // 成环：不死循环
    visiting.add(id)
    let totalLeaves = 0
    let plannedLeaves = 0
    let minutes = 0
    for (const child of walk.byParent.get(id) ?? []) {
      if (!isOpenRef(child)) continue
      const childSummary = summaryOf(child.id)
      totalLeaves += childSummary.totalLeaves
      plannedLeaves += childSummary.plannedLeaves
      minutes += childSummary.plannedMinutes
    }
    const self = walk.byId.get(id)
    if (self !== undefined && isOpenRef(self) && !hasOpenChild(walk, id) && itemMinutes.has(id)) {
      totalLeaves += 1
      plannedLeaves += 1
      minutes += itemMinutes.get(id) ?? 0
    } else if (self !== undefined && isOpenRef(self) && !hasOpenChild(walk, id)) {
      totalLeaves += 1
    }
    visiting.delete(id)
    const summary = { totalLeaves, plannedLeaves, plannedMinutes: minutes }
    memo.set(id, summary)
    return summary
  }

  /**
   * 只给**非叶子任务**产出条目。2026-10-05 实测踩到过反过来：递归会把叶子也记进备忘里，
   * 于是叶子行也被画上「已排 1 / 共 1 个子任务 · 合计 30 分钟」—— 那是噪声（叶子自己就是计划项，
   * 它旁边已经有投入分钟）。
   */
  for (const task of walk.byId.values()) {
    if (!isOpenRef(task)) continue
    if (hasOpenChild(walk, task.id)) out.set(task.id, summaryOf(task.id))
  }
  return out
}

/** 分组行文案（**唯一实现**）：`已排 2 / 共 5 个子任务 · 合计 60 分钟`。 */
export function planGroupSummaryLabel(summary: PlanGroupSummary): string {
  return `已排 ${summary.plannedLeaves} / 共 ${summary.totalLeaves} 个子任务 · 合计 ${summary.plannedMinutes} 分钟`
}

/**
 * 新增项与既有计划项同链时的"对方"（先判它是不是在别人的子树里 = 上级，再判别人在不在它子树里）。
 *
 * 方向只影响文案（"先移除上级"还是"先移除那条子任务"）。两个方向都**复用**
 * `isTaskWithinSubtree` —— 不另写第二份链判定，是这条规则的唯一实现。
 */
function relatedPlannedRef(
  byId: ReadonlyMap<string, PlanTaskRef>,
  taskId: string,
  preexistingIds: ReadonlySet<string>,
): { ref: PlanTaskRef; direction: 'up' | 'down' } | undefined {
  let down: { ref: PlanTaskRef; direction: 'down' } | undefined
  for (const other of preexistingIds) {
    if (other === taskId) continue
    const ref = byId.get(other)
    if (ref === undefined) continue
    if (isTaskWithinSubtree(byId, taskId, other)) return { ref, direction: 'up' }
    if (down === undefined && isTaskWithinSubtree(byId, other, taskId)) down = { ref, direction: 'down' }
  }
  return down
}

/**
 * 校验一份**最终**计划项集合（需求 §4.1 的"共同链校验"）。
 *
 * 规则：
 * 1. 同一 taskId 不得重复；
 * 2. 任务必须存在 —— **但只对新增项强制**：事务里读到既有计划中的缺失任务时，
 *    允许原样保留（"未知任务只拒绝新增"）；缺失/已关闭的项不能操作任务与结束投入；
 * 3. 新增项的任务必须未归档、未 done/cancelled（既有关闭项允许保留为历史记录）；
 * 4. **新增项必须是可执行叶子**（ADR0010），且不得与**任何既有计划项**同链 —— 同链时
 *    给可读原因（"先移除它"），不静默替换。
 *    历史脏数据（"父任务作为计划项"那一类）不因本次无关写入被拒（不擅自替用户改历史决定）。
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

  /**
   * 第 4 条（ADR0010）：新增项必须是**可执行叶子**，且不得与既有计划项同链。
   *
   * 为什么不再是"同链互斥"：那条规则的前提是"计划项可以是父任务"，它的目的是防重复计数；
   * 现在计划项只能是叶子，父子同时入列在结构上不可能。剩下两种要拦的形态：
   * ① 新增了一条**非叶子**（AI 草稿/全量保存直接塞了父任务）→ 告诉它改排子任务；
   * ② 新增的叶子与**历史脏数据**里的计划项同链（库里早有"父任务作为计划项"）→ 让用户先移除它。
   */
  const refs = [...byId.values()]
  const leaves = executableLeafIds(refs)
  for (const taskId of seen) {
    if (preexistingIds.has(taskId)) continue
    const task = byId.get(taskId)
    if (task === undefined) continue
    if (!leaves.has(taskId)) {
      const pending = expandPlanLeaves(refs, taskId).length
      const detail = pending > 0 ? `它下面还有 ${pending} 个未完成任务` : '它的子任务里没有一个可执行的叶子'
      return { ok: false, reason: `任务「${task.title}」不是可执行的叶子（${detail}），不能新增进该日计划，请改排它下面的子任务` }
    }
    const blocker = relatedPlannedRef(byId, taskId, preexistingIds)
    if (blocker !== undefined) {
      const direction = blocker.direction === 'up' ? '上级任务' : '子任务'
      return {
        ok: false,
        reason: `任务「${task.title}」的${direction}「${blocker.ref.title}」已在同一天的计划里，请先移除它再把这条排进来`,
      }
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
  /** **自己就是**该日计划项（带 `plannedMinutes`/`plannedOrder`）。 */
  selfPlanned: boolean
  /**
   * 该日**已安排**：自己是计划项，**或者**它是非叶子任务且子树内的可执行叶子全都已排
   *（判定唯一实现在 `dayPlacedIds`）。账本/提示词/标签读这个，不要读 `selfPlanned`。
   */
  dayPlaced: boolean
  /** 已排入该日计划时的**计划投入快照**；不是"自己是计划项"（见 `selfPlanned`）时为 undefined。 */
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
  /** 该日**已安排**（自己的计划项，或非叶子任务的全部叶子都已排 —— 见 `dayPlacedIds`）。 */
  planned: boolean
  /** 截止串存在但无法解析（脏值）—— 它不是"无截止"，必须能被观测到。 */
  dueUnparseable: boolean
}

export interface TaskDayFactsInput {
  effectiveDueAt: string | null
  statusCode: string
  /** 传入前必须过 `dayPlacedIds`（"已安排"的唯一口径），不要自己判 `planIds.has(id)`。 */
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
  /** 「已安排」走 ADR0010 的子树继承口径：非叶子任务的全部叶子都排了才算。 */
  const placed = dayPlacedIds(input.tasks, input.planItems)
  const entries: DayPanelSourceEntry[] = []
  const diagnostics: PlanCandidateDiagnostic[] = []
  const seen = new Set<string>()

  for (const task of input.tasks) {
    if (!isOpenTask({ statusCode: task.statusCode, archived: archivedFlag(task.archived) })) continue
    const facts = classifyTaskDay({
      effectiveDueAt: task.effectiveDueAt,
      statusCode: task.statusCode,
      planned: placed.has(task.id),
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

// ---------------------------------------------------------------------------
// 日期面板的页签成员（逾期 / 未排期，2026-10-02 用户拍板）
// ---------------------------------------------------------------------------

/**
 * 日期面板的页签（**唯一类型定义处**：装配层与组件都引用它，不许各写一份字面量联合）。
 *
 * 前三个是"任务视图"，`done` 按 `completedAt` 落在该日，`report` 是报告卡。
 */
export type DayPanelTabCode = 'plan' | 'overdue' | 'unscheduled' | 'done' | 'report'

/** 「只对今天/未来有意义」的两个页签（过去日期不显示它们，见 ADR0001 口径补充）。 */
export function isDayPanelExtraTab(tab: DayPanelTabCode): boolean {
  return tab === 'overdue' || tab === 'unscheduled'
}

/**
 * 该日能不能显示「逾期」/「未排期」：**过去日期不显示**。
 *
 * 为什么不做历史快照：真正的"截至 9/20 的逾期"要回放 `task_events` 的状态历史，
 * 而库里只有**当前状态** —— 把今天的欠账画到 9/20 上就是编造（比"没有这一页"更糟）。
 * 未来日显示的是"到那天为止"的投影，与"当日到期"同属排期语义，可以给。
 *
 * 日键是 `localDateString()` 产出的 `YYYY-MM-DD` **定宽**串，词典序 == 日期序。
 */
export function dayPanelExtraTabsAvailable(day: string, todayAnchor: string): boolean {
  return day >= todayAnchor
}

/**
 * 页签在"不可用"时的落点 —— **唯一实现**。
 *
 * 两个消费点必须用同一份判定，否则会出现"组件显示计划、装配层以为在看某页签"的错位：
 * 1. 组件渲染前兜底（过去日期只剩三个页签）；
 * 2. 装配层把 state 收回 `plan`（否则"该日计划"的加载闸门按旧页签关着，计划列表会是空的）。
 */
export function resolveDayPanelTab(tab: DayPanelTabCode, extraTabsAvailable: boolean): DayPanelTabCode {
  return extraTabsAvailable || !isDayPanelExtraTab(tab) ? tab : 'plan'
}

export interface DayPanelTabMembers {
  /** 「计划」页签成员（= `dayPanelTreeSources` 的输出，含逐条命中来源）。 */
  plan: DayPanelSourceEntry[]
  /**
   * 「逾期」的 taskId：open 且截止早于该日 00:00。
   *
   * ⚠️ **允许与 `plan` 重叠**（事实重叠）：逾期不会因为它同时被排进今天/正在进行中而消失。
   */
  overdue: string[]
  /** 「未排期」的 taskId：open 且**既不逾期、也不命中「计划」**（补集，不留死角）。 */
  unscheduled: string[]
  /** 计划项指向但任务已不存在（沿用 `dayPanelTreeSources` 的语义，界面负责说清为什么少了）。 */
  missingTaskIds: string[]
  /** 全部诊断（脏 due 等），界面必须显示而不是静默吞掉。 */
  diagnostics: PlanCandidateDiagnostic[]
}

/**
 * 三个任务页签（计划 / 逾期 / 未排期）的成员判定 —— **唯一实现**。
 *
 * 与 `dayPanelTreeSources` 的分工：那个回答"这一天的**计划**树里该有谁"（口径冻结，未改动）；
 * 本函数在它之上补齐另外两个页签，构成 **open 任务的一个划分**：
 *
 * - `plan`：当日到期 ∪ 当日计划项 ∪ 进行中；
 * - `overdue`：`effectiveDueAt < 该日 00:00`（**可与 plan 重叠**）；
 * - `unscheduled`：`open − plan − overdue`（补集）。
 *
 * 性质（`test/dayPanelTabs.test.mjs` 逐条断言）：
 * 1. 三者并集 == 全部 open 任务（**没有任务会没有归宿**）；
 * 2. `unscheduled` 与另两者**不相交**；
 * 3. `plan ∩ overdue` 可以非空（事实重叠，刻意允许）。
 *
 * 判定全部经 `classifyTaskDay`（唯一口径），本函数里**没有**一处 `Date.parse` 或状态比较。
 */
export function dayPanelTabMembers(input: DayPanelSourceInput): DayPanelTabMembers {
  const plan = dayPanelTreeSources(input)
  const planIds = new Set(plan.entries.map((entry) => entry.taskId))
  /** 与 `dayPanelTreeSources` 同一份「已安排」判定（不许这里再算一遍）。 */
  const placed = dayPlacedIds(input.tasks, input.planItems)
  const overdue: string[] = []
  const unscheduled: string[] = []
  const diagnostics = [...plan.diagnostics]
  const reported = new Set(diagnostics.map((entry) => entry.taskId))

  for (const task of input.tasks) {
    if (!isOpenTask({ statusCode: task.statusCode, archived: archivedFlag(task.archived) })) continue
    const facts = classifyTaskDay({
      effectiveDueAt: task.effectiveDueAt,
      statusCode: task.statusCode,
      planned: placed.has(task.id),
      dayStartMs: input.dayStartMs,
      dayEndMs: input.dayEndMs,
    })
    if (facts.dueUnparseable && !reported.has(task.id)) {
      /**
       * 脏截止串既不是"无截止"也不是"逾期"：它仍要有归宿（否则就是静默丢件），
       * 所以落进「未排期」，同时把原因说出来。
       */
      reported.add(task.id)
      diagnostics.push({
        code: 'due-unparseable',
        taskId: task.id,
        message: `任务「${task.title}」的截止时间无法解析（${task.effectiveDueAt ?? ''}）：既不算"逾期"也没有"当日到期"可言，按"未排期"处理`,
      })
    }
    if (facts.overdue) {
      overdue.push(task.id)
      continue
    }
    if (!planIds.has(task.id)) unscheduled.push(task.id)
  }

  return { plan: plan.entries, overdue, unscheduled, missingTaskIds: plan.missingTaskIds, diagnostics }
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
  /** 该日"已安排"全集（含"非叶子任务的全部叶子都已排"）—— 判定唯一实现在 `dayPlacedIds`。 */
  const placed = dayPlacedIds(input.tasks, input.planItems)
  /** 叶子判定要用的树索引（候选池只收可执行叶子，见循环里的跳过）。 */
  const walk = buildLeafWalk(input.tasks)
  const candidates: PlanCandidate[] = []
  const diagnostics: PlanCandidateDiagnostic[] = []

  for (const task of input.tasks) {
    if (!isOpenTask({ statusCode: task.statusCode, archived: archivedFlag(task.archived) })) continue
    /**
     * **非叶子任务不进候选池**（ADR0010）：它不是"可以排进今天的东西" —— 排它的含义是
     * **展开它下面的叶子**（那件事由日期面板的父任务行 + 一键排入做）。
     *
     * 三个消费者都因此变干净：AI 提示词不再可能收到"排父任务"的提案（否则整份被拒）、
     * 手动"添加任务"下拉只列可排项、容量"未排入"区不再给出一行按它自己估时算的假数字。
     * 它在日期面板里照旧以**分组行**出现（那条路径吃 `dayPanelTabMembers`，不看候选池）。
     */
    if (hasOpenChild(walk, task.id)) continue

    const planned = planByTask.get(task.id)
    /**
     * 当日事实走**唯一口径**（`classifyTaskDay`，与日期面板树共用）。
     * 这里不再自己 `Date.parse` / 比状态 —— 两处各写一份正是本函数被抽出来的原因。
     */
    const facts = classifyTaskDay({
      effectiveDueAt: task.effectiveDueAt,
      statusCode: task.statusCode,
      planned: placed.has(task.id),
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
    /** 建议投入 = 它自己的合法估时，否则设置里的默认值（非叶子任务已在上面被跳过）。 */
    const suggestion = { minutes: resolveDefaultPlanMinutes(estimate, input.defaultEstimateMinutes), usedDefault: estimate === null }

    candidates.push({
      taskId: task.id,
      title: task.title,
      rank: 0,
      band: candidateBand(task.priorityCode),
      reasons,
      dueToday,
      overdue,
      inProgress,
      selfPlanned: planned !== undefined,
      dayPlaced: placed.has(task.id),
      plannedMinutes: planned?.minutes,
      plannedOrder: planned?.order,
      suggestedMinutes: suggestion.minutes,
      usedDefaultEstimate: suggestion.usedDefault,
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
    unscheduled: candidates.filter((candidate) => !candidate.dayPlaced),
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
