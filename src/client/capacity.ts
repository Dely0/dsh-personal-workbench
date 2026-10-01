/**
 * 「今日容量」的客户端接线层（唯一权威算法在 `src/shared/dailyPlanPolicy.ts`）。
 *
 * ## 为什么这个文件现在这么薄（T2/D09，ADR 0002）
 *
 * 旧版容量是"按**到期任务**求和"：今天到期 + 无截止但在推进 + 可选的逾期。
 * ADR 0002 把它改成"**按当天计划投入快照**求和"——
 * 「已排 = 该日所有有效计划项 minutes 之和」，非计划项永不自动计入；
 * 未排入的候选另区展示并可一键排入。
 *
 * 于是"算容量"这件事必须与"当日候选"共用同一份判定（需求 §5.1/§5.2），
 * 而候选判定同时被服务端（工具/路由/容量读取）与客户端使用 —— 所以真正的实现
 * 在 `shared/dailyPlanPolicy.ts`，这里**只是**：
 * 1. 把客户端的 `Task` 快照折成共享函数的入参（含本地日界）；
 * 2. 不再自己写任何过滤/求和（`test/capacityWiring.test.mjs` 用源码扫描钉住）。
 *
 * ⚠️ 这里**不许**再出现 `planned` 的求和、`estimatedMinutes ?? 30`、
 * 「今天到期」判定或 `slice(0, 30)` —— 那些都属于共享模块。
 */
import {
  DEFAULT_PLAN_MINUTES,
  MAX_PLAN_MINUTES,
  computeCapacityLedger,
  planCandidates,
  type CapacityLedger,
  type PlanCandidateResult,
  type PlanCandidateTask,
} from '../shared/dailyPlanPolicy.js'

/** 没填耗时时的兜底分钟数（与设置项 `defaultEstimateMinutes` 的缺省一致）。 */
export const DEFAULT_ESTIMATE_MINUTES = DEFAULT_PLAN_MINUTES
/**
 * 预计耗时 / 默认投入的合法下界。
 *
 * T2/D09 实测修正：原先这里写的是 **5**，而服务端 `api/routes/helpers.ts#clampEstimateForStorage`
 * 用的是 **1** —— 两把尺子不一致，跨模块等价性断言（`test/routes.test.mjs`）当场变红，
 * 且 1–4 分钟的合法估时会被客户端悄悄当成"没填"。现在两侧都是 1，与
 * `shared/dailyPlanPolicy.ts#MIN_PLAN_MINUTES`（计划投入下界）也一致。
 */
export const MIN_ESTIMATE_MINUTES = 1
/** `estimatedMinutes` 与默认耗时的上界（与 `dailyCapacityMinutes` 的上限一致）。 */
export const MAX_ESTIMATE_MINUTES = MAX_PLAN_MINUTES

export type { CapacityLedger } from '../shared/dailyPlanPolicy.js'

/**
 * 容量计算需要的最小任务形状。
 *
 * 与共享层的 `PlanCandidateTask` 同构：这里显式继承它，是为了让"客户端多传了字段"
 * 也不能悄悄改变判定（多出来的字段不参与任何判定）。
 */
export interface CapacityTask extends PlanCandidateTask {
  /** 任务自己写的截止时间（`null` 表示 `effectiveDueAt` 是继承来的）。 */
  dueAt?: string | null
  allDay?: boolean
  /** 用户手填的预计耗时（未归一化）；`null` 表示没填。 */
  estimatedMinutes: number | null
}

/** 该日计划项（客户端视图里的字段；`readable=false` 时容量必须显示"不可计算"）。 */
export interface CapacityPlanItemView {
  taskId: string
  order: number
  title?: string
  minutes?: number
  effortDone?: boolean
}

/**
 * 把「用户输入的预计耗时」归一化成可落库/可参与计算的值。
 *
 * - 有限整数且 ≥1 → `min(1440, 值)`；
 * - `0` / 负数 / 非有限（NaN、Infinity）/ 小数 / 非数字 → `null`（= 没填）。
 *
 * ⚠️ **服务端 PATCH（`src/api/routes/helpers.ts#clampEstimateForStorage`）必须与这里同口径**，
 * 否则会出现"库里 99999、界面按默认 30 算"的双口径。为什么没有直接共享这一份：客户端与宿主
 * 是两个编译容器（客户端不进宿主产物，反之亦然）。所以服务端写了一份同构夹取，并用
 * `test/routes.test.mjs` 里一条**跨模块等价性断言**（同一批输入两份实现必须给同一个结果）
 * 钉住它们不许漂移。
 *
 * 注意：T2 起**容量不再用它**（容量读计划投入快照，不读估时）。它保留下来是因为
 * `estimatedMinutes` 这个字段本身仍然有"没填 / 填了"的语义，客户端入队前需要同一把尺子。
 */
export function clampEstimatedMinutes(value: unknown): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value)) return null
  if (!Number.isInteger(value)) return null
  if (value < MIN_ESTIMATE_MINUTES) return null
  return Math.min(MAX_ESTIMATE_MINUTES, value)
}

export interface ComputeTodayCapacityInput {
  /** **全量**任务列表（含 archived / done / cancelled）——过滤在共享函数内部做。 */
  tasks: readonly CapacityTask[]
  /** 该日计划（`null` = 没有计划；`readable:false` = 有但 JSON 坏了）。 */
  plan: { items: readonly CapacityPlanItemView[]; sourceCode?: string | null; readable?: boolean; diagnostics?: readonly string[]; reason?: string | null } | null
  dailyCapacityMinutes: number
  defaultEstimateMinutes: number
  includeOverdue: boolean
  now: Date
}

/** 本地日 D 的起止 epoch（显式传入共享函数：不读系统时钟，便于午夜/DST 测试）。 */
export function capacityDayRange(now: Date): { dayStartMs: number; dayEndMs: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  return { dayStartMs: start.getTime(), dayEndMs: end.getTime() }
}

/**
 * 稳定排序用的"今天"键（YYYY-MM-DD 本地日）。
 *
 * 存在的理由：`index.tsx` 里的 `now` 是**渲染体内每帧新建的对象**，
 * 放进 `useMemo` 依赖数组等于 memo 每帧失效。依赖这个字符串则跨天才变一次。
 */
export function capacityTodayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** 客户端的 Task 快照 → 共享候选判定要的形状（不做任何过滤）。 */
export function toPlanCandidateTask(task: CapacityTask): PlanCandidateTask {
  return {
    id: task.id,
    parentId: task.parentId,
    title: task.title,
    statusCode: task.statusCode,
    priorityCode: task.priorityCode,
    effectiveDueAt: task.effectiveDueAt,
    estimatedMinutes: task.estimatedMinutes,
    archived: task.archived === true ? true : false,
    createdAt: task.createdAt,
  }
}

/**
 * 今日容量账本（客户端入口）。**全部计算都在共享模块里**：
 * 已排 = 计划 minutes 快照之和；未排入 = 候选全集 − 计划 taskId。
 */
export function computeTodayCapacity(input: ComputeTodayCapacityInput): CapacityLedger {
  const { dayStartMs, dayEndMs } = capacityDayRange(input.now)
  const tasks = input.tasks.map(toPlanCandidateTask)
  const plan = input.plan
  const readable = plan === null ? true : plan.readable !== false
  return computeCapacityLedger({
    tasks,
    planItems: plan === null
      ? []
      : plan.items.map((item) => ({
          taskId: item.taskId,
          order: item.order,
          title: item.title,
          minutes: item.minutes,
          effortDone: item.effortDone,
        })),
    planExists: plan !== null,
    planReadable: readable,
    reason: readable ? null : (plan?.reason ?? plan?.diagnostics?.[0] ?? '计划数据无法解析'),
    sourceCode: plan?.sourceCode ?? null,
    dailyCapacityMinutes: input.dailyCapacityMinutes,
    defaultEstimateMinutes: input.defaultEstimateMinutes,
    includeOverdue: input.includeOverdue,
    dayStartMs,
    dayEndMs,
  })
}

/** 当日候选全集（客户端入口）：AI 排序、手动池、未排入区共用同一份输出。 */
export function todayPlanCandidates(input: {
  tasks: readonly CapacityTask[]
  plan: { items: readonly CapacityPlanItemView[] } | null
  includeOverdue: boolean
  defaultEstimateMinutes: number
  now: Date
}): PlanCandidateResult {
  const { dayStartMs, dayEndMs } = capacityDayRange(input.now)
  return planCandidates({
    tasks: input.tasks.map(toPlanCandidateTask),
    planItems: (input.plan?.items ?? []).map((item) => ({ taskId: item.taskId, order: item.order, minutes: item.minutes })),
    dayStartMs,
    dayEndMs,
    includeOverdue: input.includeOverdue,
    defaultEstimateMinutes: input.defaultEstimateMinutes,
  })
}
