/**
 * 容量/候选夹具（**唯一一份**）。测试与真机 harness 都 import 这里，禁止各写一份。
 *
 * ## T2 起口径的根本变化（ADR 0002）
 *
 * 旧夹具（v1.15.1–T1）是"容量 = 按**到期任务**求和"，基准数字 420/1380/480 已被
 * 那张口径锁定。T2 把「已排」改成"**该日计划投入分钟快照之和**"，于是那组数字整体作废
 * —— 这里按**新口径**重建夹具，并把"旧口径下会被算进去的任务"全部保留在任务表里，
 * 用来证明它们现在**不再**自动计入已排（这是本次改动最核心的一条）。
 *
 * ## 约定
 * - 时间一律**本地组件构造** `new Date(y, m, d, h)`，不用带时区的 ISO 串 ——
 *   后者在换机器/换时区时会把日期挪走（本地组件构造的语义在任何时区都成立）。
 * - `effectiveDueAt` 显式给值，模拟仓储层已经算好继承的结果（夹具不复刻继承逻辑）。
 * - 任务表是**全量**（含 archived / done / cancelled / 未来 todo / 脏 due）：
 *   候选判定内部自己过滤，调用点不要再滤一遍。
 */

const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute, 0, 0)
const iso = (d) => d.toISOString()

const T = (id, extra) => ({
  id,
  parentId: null,
  title: id,
  statusCode: 'todo',
  priorityCode: 'p2',
  dueAt: null,
  effectiveDueAt: null,
  estimatedMinutes: null,
  archived: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...extra,
})

/** 冻结的"现在"：2026-09-30 15:00 本地。 */
export const CAPACITY_NOW = at(30, 15)
/** 夹具日（本地）：2026-09-30。 */
export const CAPACITY_TODAY = '2026-09-30'
/** 本地日起止（显式传给共享函数，不读系统时钟）。 */
export const CAPACITY_DAY_START = at(30, 0).getTime()
export const CAPACITY_DAY_END = at(31, 0).getTime()

/**
 * 任务表（14 条）。逐条说明它在新口径下的角色：
 *
 * | id | 形状 | 今日候选？ | 在计划里？ |
 * |---|---|---|---|
 * | S1 | p0 今天 18:00 到期，估时 90 | ✅ 今天到期 | ✅ 计划 90 |
 * | S2 | p1 **截止在 5 天后**（长任务）但状态 doing，估时 600 | ✅ **在推进**（旧口径看不见它） | ✅ 计划 120 |
 * | S3 | p1 昨天到期，估时 45 | 仅开关打开时 | ❌ |
 * | S4 | p2 今天 09:00 到期，估时 45 | ✅ 今天到期 | ✅ 计划 60（显式覆盖探针） |
 * | S5 | p2 今天 23:30 到期，估时 45 | ✅ 今天到期 | ❌ |
 * | S6 | p2 blocked 无截止，估时 60 | ✅ 在推进 | ✅ 计划 60 |
 * | S7 | p2 继承父任务 S6 的截止（今天 18:00） | ✅ 今天到期（继承） | ❌ |
 * | S8 | p3 今天 00:00:00 到期（日界左端点），估时 30 | ✅ 今天到期 | ✅ 计划 30 |
 * | S9 | 明天 00:00 到期（日界右端点），估时 30 | ❌（不是今天） | ❌ |
 * | S10 | doing，`effectiveDueAt` 是**坏串**，估时 30 | ✅ 在推进（带诊断） | ❌ |
 * | S11 | 明天到期，todo，估时 30 | ❌ 未来 todo 不自动入候选 | ❌ |
 * | S12 | todo，无截止，估时 30 | ❌ 无截止且不在推进 | ❌ |
 * | S13 | done，估时 999 | ❌ | ❌ |
 * | S14 | archived，今天到期 | ❌ | ❌ |
 */

export const CAPACITY_FIXTURE = {
  now: CAPACITY_NOW,
  /** 每天可投入（余 = max(0, 可投入 − 已排) 用）。 */
  dailyCapacityMinutes: 300,
  defaultEstimateMinutes: 30,
  tasks: [
    T('S1', { priorityCode: 'p0', dueAt: iso(at(30, 18)), effectiveDueAt: iso(at(30, 18)), estimatedMinutes: 90 }),
    T('S2', { priorityCode: 'p1', statusCode: 'doing', dueAt: iso(new Date(2026, 9, 5, 18, 0, 0)), effectiveDueAt: iso(new Date(2026, 9, 5, 18, 0, 0)), estimatedMinutes: 600 }),
    T('S3', { priorityCode: 'p1', dueAt: iso(at(29, 18)), effectiveDueAt: iso(at(29, 18)), estimatedMinutes: 45 }),
    T('S4', { priorityCode: 'p2', dueAt: iso(at(30, 9)), effectiveDueAt: iso(at(30, 9)), estimatedMinutes: 45 }),
    T('S5', { priorityCode: 'p2', dueAt: iso(at(30, 23, 30)), effectiveDueAt: iso(at(30, 23, 30)), estimatedMinutes: 45 }),
    T('S6', { priorityCode: 'p2', statusCode: 'blocked', estimatedMinutes: 60 }),
    T('S7', { priorityCode: 'p2', parentId: 'S6', effectiveDueAt: iso(at(30, 18)), estimatedMinutes: null }),
    T('S8', { priorityCode: 'p3', dueAt: iso(at(30, 0)), effectiveDueAt: iso(at(30, 0)), estimatedMinutes: 30 }),
    T('S9', { priorityCode: 'p2', dueAt: iso(at(31, 0)), effectiveDueAt: iso(at(31, 0)), estimatedMinutes: 30 }),
    T('S10', { priorityCode: 'p2', statusCode: 'doing', effectiveDueAt: '不是时间', estimatedMinutes: 30 }),
    T('S11', { priorityCode: 'p2', dueAt: iso(at(31, 18)), effectiveDueAt: iso(at(31, 18)), estimatedMinutes: 30 }),
    T('S12', { priorityCode: 'p2', estimatedMinutes: 30 }),
    T('S13', { priorityCode: 'p0', statusCode: 'done', dueAt: iso(at(30, 18)), effectiveDueAt: iso(at(30, 18)), estimatedMinutes: 999 }),
    T('S14', { priorityCode: 'p0', archived: true, dueAt: iso(at(30, 18)), effectiveDueAt: iso(at(30, 18)), estimatedMinutes: 999 }),
  ],
}

/**
 * 计划 A（对应需求 §5.2 与 AX-C03/C04 的基准）：
 * `S1 90 + S2 120 + S4 60 + S6 60 + S8 30 = 360`。
 *
 * 三条刻意的设计：
 * 1. `S4` 的 60 **不等于**它的估时 45 —— 证明"计划投入是快照"，容量只读计划不读估时；
 * 2. `S2` 截止在 5 天后且估时 600，却在计划里（长任务也可排入今天）；
 * 3. `S6` 是 `S7` 的父任务：计划里有父任务，子任务 `S7` 照常进候选（父子链限制
 *    只在**同一天同时排入**时生效）。
 */
export const CAPACITY_PLAN_A = [
  { taskId: 'S1', order: 1, title: 'S1', minutes: 90, effortDone: false },
  { taskId: 'S2', order: 2, title: 'S2', minutes: 120, effortDone: false },
  { taskId: 'S4', order: 3, title: 'S4', minutes: 60, effortDone: false },
  { taskId: 'S6', order: 4, title: 'S6', minutes: 60, effortDone: false },
  { taskId: 'S8', order: 5, title: 'S8', minutes: 30, effortDone: false },
]

/** 计划 A 逐字段期望（改夹具必须同时改这里；对不上宁可让测试红）。 */
export const CAPACITY_EXPECTED = {
  planA: {
    planned: 360,
    doneMinutes: 0,
    remainingMinutes: 360,
    plannedCount: 5,
    free: 0,
    over: true,
    total: 360,
    byPriority: { p0: 90, p1: 120, p2: 120, p3: 30 },
  },
  /** 计划 A 未排入候选（开关关）：S7 S5 S10（=3 条 / 建议 30+45+30=105）。 */
  planAUnscheduled: { ids: ['S7', 'S5', 'S10'], suggested: 105 },
  /** 开关打开后多出 S3（45 min 建议）→ 4 条 / 150。 */
  planAUnscheduledOverdue: { ids: ['S3', 'S7', 'S5', 'S10'], suggested: 150 },
  /** 无计划时的候选（开关关）：S1 S2 S4 S7 S5 S10 S6 S8 = 8 条（排序口径见下）。 */
  noPlanCandidates: { ids: ['S1', 'S2', 'S4', 'S7', 'S5', 'S10', 'S6', 'S8'], total: 8, unscheduledSuggested: 930 },
  /** 开关打开后多出逾期 todo S3（p1，所以紧跟 S2）→ 9 条。 */
  noPlanCandidatesOverdue: { ids: ['S1', 'S2', 'S3', 'S4', 'S7', 'S5', 'S10', 'S6', 'S8'], total: 9 },
  /**
   * 计划 A 下的**未排入**排序（p2 档内按有效截止升序，坏值最后）：
   * S7 10:00Z < S5 15:30Z < S10（`不是时间` → 排最后）。
   */
  sortedIds: ['S7', 'S5', 'S10'],
  /** 无计划时候选的完整排序（p0 → p1 → p2 → p3，档内按有效截止，坏值最后）。 */
  sortedAllIds: ['S1', 'S2', 'S4', 'S7', 'S5', 'S10', 'S6', 'S8'],
}

/**
 * 旧口径（按到期任务求和）的**期望废值**：留一条断言证明新版不再等于它。
 *
 * 旧口径会把 S1(90) + S4(45) + S5(45) + S7(30) + S8(30) 算成 240；新版在**无计划**时必须是 0。
 * 这条数字的唯一用途就是"新版不许等于旧版"。
 */
export const CAPACITY_LEGACY_DUE_SUM = 240
