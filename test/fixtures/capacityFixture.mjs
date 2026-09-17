/**
 * 容量夹具（唯一一份）。测试与真机 harness 都 import 这里，**禁止各写一份**。
 *
 * 为什么单独成文件：基准数字（420 / 1380 / 480）要同时出现在单测、harness 断言与设计文档里，
 * 三处若各维护一份夹具，迟早会出现"测试绿但 harness 红"的经典分歧。
 *
 * ## 约定
 * - 时间一律**本地组件构造** `new Date(y, m, d, h)`，不用带时区的 ISO 串 ——
 *   后者在换机器/换时区时会把日期挪走（本地组件构造的语义在任何时区都成立）。
 * - `effectiveDueAt` 在夹具里**显式给值**，模拟仓储层已经算好继承的结果；
 *   夹具不复刻继承逻辑（那是产品代码的职责，复刻等于制造第二份实现）。
 * - 夹具是**全量任务列表**（含 archived / done / cancelled）：`computeTodayCapacity`
 *   内部自己过滤，调用点不要再滤一遍（"同一语义两个地方算"是本项目最大的 bug 类别）。
 *   T10 专门守归档过滤。
 */

const at = (day, hour) => new Date(2026, 8, day, hour, 0, 0)
const iso = (d) => d.toISOString()

const T = (id, extra) => ({
  id,
  parentId: null,
  title: id,
  statusCode: 'todo',
  priorityCode: 'p2',
  dueAt: null,
  effectiveDueAt: null,
  allDay: false,
  estimatedMinutes: null,
  archived: false,
  ...extra,
})

/** 冻结的"现在"：2026-09-16 15:00 本地。 */
export const CAPACITY_NOW = at(16, 15)

export const CAPACITY_FIXTURE = {
  now: CAPACITY_NOW,
  dailyCapacityMinutes: 300,
  defaultEstimateMinutes: 30,
  tasks: [
    T('T1', { priorityCode: 'p0', dueAt: iso(at(16, 18)), effectiveDueAt: iso(at(16, 18)), estimatedMinutes: 60 }),
    T('T2', { priorityCode: 'p1', dueAt: iso(at(16, 18)), effectiveDueAt: iso(at(16, 18)) }),
    T('T3', { statusCode: 'doing', estimatedMinutes: 120 }),
    T('T4', {}),
    T('T5', { priorityCode: 'p1', dueAt: iso(at(14, 18)), effectiveDueAt: iso(at(14, 18)), estimatedMinutes: 480 }),
    T('T6', { priorityCode: 'p0', dueAt: iso(at(15, 18)), effectiveDueAt: iso(at(15, 18)), estimatedMinutes: 480 }),
    T('T7', { dueAt: iso(at(16, 0)), effectiveDueAt: iso(at(16, 0)), estimatedMinutes: 180, allDay: true }),
    T('T8', { statusCode: 'done', priorityCode: 'p0', dueAt: iso(at(16, 18)), effectiveDueAt: iso(at(16, 18)), estimatedMinutes: 999 }),
    T('T9', { statusCode: 'cancelled', priorityCode: 'p0', dueAt: iso(at(16, 18)), effectiveDueAt: iso(at(16, 18)), estimatedMinutes: 999 }),
    T('T10', { priorityCode: 'p0', dueAt: iso(at(16, 18)), effectiveDueAt: iso(at(16, 18)), estimatedMinutes: 999, archived: true }),
    T('T11', { priorityCode: 'p3', parentId: 'T1', effectiveDueAt: iso(at(16, 18)) }),
  ],
}

/**
 * 期望输出（**逐字段**）。测试与 harness 断言同一份，设计文档 §4.2 抄的也是这份。
 * 改夹具就必须改这里，两处对不上时宁可让测试红。
 */
export const CAPACITY_EXPECTED = {
  default: {
    planned: 420,
    byPriority: { p0: 60, p1: 30, p2: 300, p3: 30 },
    free: 0,
    over: true,
    total: 420,
    counted: 5,
    // 4 不是 3：T1/T2/T7 是自身今天到期，T11 靠**继承父任务 T1 的截止**也算"今天到期"
    // （v1 手算漏了它，被 scripts/repro/verify-capacity-fixed-dataset.mjs 的独立实现抓出来）
    dueTodayCount: 4,
    noDueDoingCount: 1,
    fallbackCount: 2,
    includedIds: ['T1', 'T2', 'T3', 'T7', 'T11'],
    overdueExcludedCount: 2,
    overdueMinutes: 960,
  },
  includeOverdue: {
    planned: 1380,
    // p1 = 510：T2(30) + T5(480)（v1 手算漏了 T5）
    byPriority: { p0: 540, p1: 510, p2: 300, p3: 30 },
    free: 0,
    over: true,
    total: 1380,
    counted: 7,
    dueTodayCount: 4,
    noDueDoingCount: 1,
    fallbackCount: 2,
    includedIds: ['T1', 'T2', 'T3', 'T5', 'T6', 'T7', 'T11'],
    overdueExcludedCount: 0,
    overdueMinutes: 0,
  },
  defaultEstimate60: {
    planned: 480,
    fallbackCount: 2,
    counted: 5,
  },
}

/**
 * 第二组夹具：**继承 due** 的三条分支（含「幽灵逾期」）。
 *
 * 为什么另起一组而不是往上面那份里加：
 * 上面那 11 条 + `CAPACITY_EXPECTED` 的数字（420 / 1380 / 480 / 960 min）已被
 * `scripts/repro/verify-capacity-fixed-dataset.mjs` 的**独立实现**复核过，
 * 并被设计文档 §4.2 逐字引用。往里面塞任务会让那组"三处同源"的数字全部作废，
 * 而那组数字本身没问题。所以继承分支单独成组，两组互不影响。
 *
 * 这一组的四个任务里，三个子任务都挂在同一个**已取消父任务 C1** 下：
 * - `C2`：无自身 due、继承到父的 09-14（已过期）→ 逾期排除 + `ghostFromCancelledAncestor=true`；
 * - `C3`：无自身 due、继承到今天 18:00 → **计入**（"今天到期"）且 `inheritedDue=true`；
 * - `C4`：无自身 due、无继承 due、状态 `doing` → 计入（"无截止但在推进"）。
 *
 * 期望值 = 手算 + 独立实算对过：
 * 计入 C3(30) + C4(30) = **60**；`dueTodayCount=1`、`noDueDoingCount=1`、`fallbackCount=2`；
 * 逾期排除 1 条 = 30 min。
 *
 * 注意 `ghostFromCancelledAncestor` 描述的是 **due 的来源**（继承自已取消的祖先），
 * 不是"被排除"：C3 同样为 true，但它照常计入（它继承到的截止是今天）。
 * 这一条容易读错，所以单列出来说明。
 */
export const CAPACITY_INHERITANCE_TASKS = [
  // 已取消的父任务：自己不进 open 集合，但它的 due 仍会被子任务继承（既有语义，不修）
  T('C1', { statusCode: 'cancelled', priorityCode: 'p0', dueAt: iso(at(14, 18)), effectiveDueAt: iso(at(14, 18)) }),
  T('C2', { parentId: 'C1', priorityCode: 'p1', dueAt: null, effectiveDueAt: iso(at(14, 18)) }),
  T('C3', { parentId: 'C1', priorityCode: 'p2', dueAt: null, effectiveDueAt: iso(at(16, 18)) }),
  T('C4', { parentId: 'C1', statusCode: 'doing', priorityCode: 'p3', dueAt: null, effectiveDueAt: null }),
]

export const CAPACITY_INHERITANCE_EXPECTED = {
  planned: 60,
  counted: 2,
  dueTodayCount: 1,
  noDueDoingCount: 1,
  fallbackCount: 2,
  includedIds: ['C3', 'C4'],
  overdueExcludedIds: ['C2'],
  overdueMinutes: 30,
  /** 计入的 C3 也是"继承自已取消父任务"的 due —— 该标记只描述**来源**，不代表被排除。 */
  c3Ghost: true,
  /** 被排除的 C2 同样继承自那个已取消父任务。 */
  c2Ghost: true,
}

