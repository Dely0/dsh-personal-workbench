/**
 * 「任务进度」的**唯一权威口径**（纯模块：零 React / 零 DOM / 零 Node I/O / 零 SQLite）。
 *
 * ## 为什么单独成模块
 *
 * 进度这个字段最容易被复制成多份口径：工具一份、HTTP 一份、客户端下拉一份。
 * 而 ADR 0003/0004 定下的语义有**两个值空间**，任何一处抄错都会变成静默改写：
 *
 * - `0–99` 是**可存储的进度**（人写什么就是什么，不由子任务比例派生）；
 * - `100` **不是可存储的进度**，它是「提交完成验收申请」的触发值 ——
 *   库里永远不出现 100（DDL 的 CHECK 是最后一道防线），
 *   真正的「已完成」只由 `tasks.status_code = done` 表达。
 *
 * 本模块把这两条写成一个纯函数 `checkProgressInput()`，服务端与客户端共用；
 * 客户端只额外借它做**展示投影**（`projectProgress()`），不另造一套判定。
 */
import type { PublicTask } from './contracts.js'

/** 可存储进度的下界。 */
export const MIN_PROGRESS_PERCENT = 0
/** 可存储进度的上界。`100` 不在这个空间里（见文件头）。 */
export const MAX_PROGRESS_PERCENT = 99
/** 「提交完成验收」的触发值；**不落库**。 */
export const COMPLETION_TRIGGER_PERCENT = 100

/**
 * 「开任务」判定：未归档且状态不是终态。
 *
 * 与 `db/repo/status.ts#isClosedStatus`、`shared/dailyPlanPolicy` 同口径，
 * 三处都写作两个字符串比较（没有可共享的常量表可依赖，故此处以注释互相钉住）。
 */
export function isOpenTask(task: Pick<PublicTask, 'statusCode' | 'archived'>): boolean {
  if (task.archived === 1) return false
  return task.statusCode !== 'done' && task.statusCode !== 'cancelled'
}

/**
 * 校验一个**可存储**的进度值。
 *
 * 只接受有限整数 `0–99`。明确拒绝（而不是夹取）：
 * 字符串（含 `"50"`）、`null`、布尔、小数、负数、`NaN`/`Infinity`、`100` 与更大的数。
 * 超界值**不静默夹到 99** —— 那是"静默改写"，本项目明令禁止。
 *
 * @returns 合法时 `{ ok: true, value }`；非法时 `{ ok: false, reason }`（**中文**，可直接回给用户/AI）。
 */
export function checkProgressInput(value: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  if (typeof value === 'string') return reject(value, '不能是字符串（请直接传数字，例如 50）')
  if (typeof value === 'boolean') return reject(value, '不能是布尔值')
  if (value === null) return reject(value, '不能是 null')
  if (value === undefined) return reject(value, '不能缺省')
  if (typeof value !== 'number') return reject(value, '必须是数字')
  if (Number.isNaN(value)) return reject(value, '不能是 NaN')
  if (!Number.isFinite(value)) return reject(value, '不能是 Infinity/-Infinity')
  if (!Number.isInteger(value)) return reject(value, '必须是整数百分比')
  if (value < MIN_PROGRESS_PERCENT) return reject(value, `不能小于 ${MIN_PROGRESS_PERCENT}`)
  if (value > MAX_PROGRESS_PERCENT) {
    return {
      ok: false,
      reason: value === COMPLETION_TRIGGER_PERCENT
        ? '100 不是可存储的进度值：它表示「提交完成验收申请」，请走完成验收路径（workbench_request_completion），库里只存 0–99'
        : `不能大于 ${MAX_PROGRESS_PERCENT}（库里只存 0–${MAX_PROGRESS_PERCENT}；100 表示提交完成验收，不是进度值）`,
    }
  }
  return { ok: true, value }
}

function reject(value: unknown, why: string): { ok: false; reason: string } {
  return { ok: false, reason: `进度必须是 0–${MAX_PROGRESS_PERCENT} 的整数：${JSON.stringify(value) ?? String(value)} ${why}` }
}

/**
 * 把库里读到的进度夹进可显示区间。
 *
 * 为什么要有：库有 CHECK 兜底，但**旧库/手工改过的库**仍可能读到越界值，
 * 而界面把 `120%` 画成超出条宽的方块比显示 `99%` 更糟。夹取只作用于**展示**，
 * 不写回库（写入口一律走 `checkProgressInput` 拒绝非法值）。
 */
export function clampProgressForDisplay(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MIN_PROGRESS_PERCENT
  return Math.min(MAX_PROGRESS_PERCENT, Math.max(MIN_PROGRESS_PERCENT, Math.round(value)))
}

// ---------------------------------------------------------------------------
// 直接子任务旁证
// ---------------------------------------------------------------------------

export interface ChildFacts {
  /** 直接子任务总数（不递归：口径就是「直接子任务」，见 ADR 0004）。 */
  total: number
  /** 其中已完成的条数。 */
  done: number
  /** 其中已取消的条数 —— **不计入 done**（取消不等于"工作已完成"）。 */
  cancelled: number
}

/** 直接子任务旁证：`x/y` 里 x 只数 done，y 含 cancelled 并额外单列取消数。 */
export function childFacts(children: ReadonlyArray<Pick<PublicTask, 'statusCode'>>): ChildFacts {
  let done = 0
  let cancelled = 0
  for (const child of children) {
    if (child.statusCode === 'done') done += 1
    else if (child.statusCode === 'cancelled') cancelled += 1
  }
  return { total: children.length, done, cancelled }
}

/**
 * 旁证文案。取消数**单独标注**，不把 cancelled 算成"已完成"。
 *
 * @returns 无子任务时返回 `null`（界面不渲染旁证）。
 */
export function childFactsLabel(facts: ChildFacts): string | null {
  if (facts.total === 0) return null
  const cancelled = facts.cancelled > 0 ? `（另 ${facts.cancelled} 个已取消）` : ''
  return `子任务 ${facts.done}/${facts.total} 已完成${cancelled}`
}

// ---------------------------------------------------------------------------
// 展示投影
// ---------------------------------------------------------------------------

export type ProgressVisualState = 'hidden-terminal' | 'hidden-archived' | 'pending-acceptance' | 'progress'

export interface ProgressProjection {
  /** `progress` = 画进度条；其余一律不画。 */
  state: ProgressVisualState
  /** 要显示的百分比（`state === 'progress'` 时有意义）。 */
  percent: number
  /** 待验收提示（`pending-acceptance` 时给出）；`deferred` 与 `pending` 都算待验收。 */
  pendingLabel: string | null
  /** 状态徽标位要显示的替代文案（done/cancelled/已归档）。 */
  terminalLabel: string | null
  /** 直接子任务旁证（无子任务时为 null）。 */
  childLabel: string | null
  /** 旁证与显式进度**矛盾**时的提示（子任务全完成但任务还没完成）；否则 null。 */
  hint: string | null
}

export interface ProjectProgressInput {
  task: Pick<PublicTask, 'statusCode' | 'archived' | 'progressPercent'>
  /** **直接**子任务（只要 statusCode）；不传表示"没有子任务信息"，旁证为空。 */
  children?: ReadonlyArray<Pick<PublicTask, 'statusCode'>>
  /**
   * 该任务是否有 pending 的 completion 草稿，以及它是否已暂存。
   * `undefined` = 旧服务端没有这份投影 → **不推测、不显示徽标**（宁可没有，也不要假徽标）。
   */
  completion?: { deferred: boolean } | undefined
}

/**
 * 把「任务 + 直接子任务 + 待验收投影」折成界面要画的东西。
 *
 * 规则（逐条对应 requirements §3.2）：
 * 1. `done` / `cancelled` 不画进度条，只显示状态（`已完成` / `已取消`）；
 * 2. 已归档同理（归档视图里也没有"进度"可言）；
 * 3. 有 pending completion 草稿 → 显示待验收；`deferredAt` 非空显示**暂存**；
 *    被驳回的草稿状态是 abandoned，不在 pending 里 → 自然没有徽标；
 * 4. 其余未关闭任务按显式值画进度；
 * 5. 子任务旁证只是**旁证**：不派生、不改写显式进度；两者矛盾时给提示而不是替用户决定。
 */
export function projectProgress(input: ProjectProgressInput): ProgressProjection {
  const { task } = input
  const kids = input.children ?? []
  const facts = childFacts(kids)
  const childLabel = childFactsLabel(facts)
  // 「子任务全完成但自己还没完成」= 旁证与状态矛盾。cancelled **不算**完成，
  // 所以判据是 done === total（全部 done），不是 done + cancelled === total。
  const allChildrenDone = facts.total > 0 && facts.done === facts.total
  const hint = allChildrenDone && task.statusCode !== 'done' ? '直接子任务已全部完成，是否把本任务标记完成？' : null

  if (task.statusCode === 'done') {
    return { state: 'hidden-terminal', percent: clampProgressForDisplay(task.progressPercent), pendingLabel: null, terminalLabel: '已完成', childLabel, hint: null }
  }
  if (task.statusCode === 'cancelled') {
    return { state: 'hidden-terminal', percent: clampProgressForDisplay(task.progressPercent), pendingLabel: null, terminalLabel: '已取消', childLabel, hint: null }
  }
  if (task.archived === 1) {
    return { state: 'hidden-archived', percent: clampProgressForDisplay(task.progressPercent), pendingLabel: null, terminalLabel: '已归档', childLabel, hint }
  }
  if (input.completion !== undefined) {
    return {
      state: 'pending-acceptance',
      percent: clampProgressForDisplay(task.progressPercent),
      pendingLabel: input.completion.deferred ? '待验收（暂存）' : '待验收',
      terminalLabel: null,
      childLabel,
      hint,
    }
  }
  return { state: 'progress', percent: clampProgressForDisplay(task.progressPercent), pendingLabel: null, terminalLabel: null, childLabel, hint }
}
