/**
 * 「AI 排序」候选 → 提示词的**唯一构造实现**（纯模块：零 React / 零 DOM / 零 I/O）。
 *
 * ## 为什么单独成模块
 *
 * 需求 §5.1 有两条容易被写歪的规则，两条都只有一份实现才不会漂移：
 * 1. **最多列 30 条，先排序后截取**，并且必须**显式写出还有几条**没列出来
 *    （"不给用户全量排序的假印象，也不把未列条目说成没有任务"）；
 * 2. 候选本身只能来自 `shared/dailyPlanPolicy.ts#planCandidates()`，
 *    组件里不许再 filter 一遍。
 *
 * 所以这里只做"纯函数把快照拼成文本"：不读系统时钟、不碰 DOM、不发请求。
 * `index.tsx` 只负责把 `planCandidates()` 的输出喂进来，并把结果贴进提示词。
 */
import {
  PLAN_PROMPT_CANDIDATE_LIMIT,
  selectPromptCandidates,
  type PlanCandidate,
  type PlanCandidateDiagnostic,
} from '../shared/dailyPlanPolicy.js'

export interface BuildPlanPromptInput {
  /** 目标日（YYYY-MM-DD）。 */
  planDate: string
  /** 候选全集（**必须先经 `planCandidates()`**；这里不重新过滤）。 */
  candidates: readonly PlanCandidate[]
  /** 候选判定给出的诊断（脏 due 等），会作为"数据有问题的条目"列出。 */
  diagnostics?: readonly PlanCandidateDiagnostic[]
  /** 该日计划里已有多少条（提示模型"这是重排还是新增"）。 */
  existingPlanCount?: number
  /** 提示词上限；缺省 30（`PLAN_PROMPT_CANDIDATE_LIMIT`）。 */
  limit?: number
}

export interface PlanPromptPayload {
  /** 已排序、已截断的候选（回执/界面要显示"已列 N 条"时用它）。 */
  listed: PlanCandidate[]
  /** 完整候选条数（**不是**截断后的条数）。 */
  total: number
  /** 没列出来的条数。 */
  omitted: number
  /** 是否发生了截断（`omitted > 0`）。界面据此决定要不要显示 `notice`。 */
  truncated: boolean
  /** 截断提示（未截断时为 ''）。 */
  notice: string
  /** 可直接贴进提示词的 Markdown 文本。 */
  text: string
}

const STATUS_LABELS: Record<string, string> = {
  todo: '待办',
  doing: '进行中',
  blocked: '受阻',
}

function statusLabel(statusCode: string): string {
  return STATUS_LABELS[statusCode] ?? statusCode
}

function reasonLabel(candidate: PlanCandidate): string {
  const labels: string[] = []
  if (candidate.planned) labels.push(`已排入（第 ${candidate.plannedOrder ?? '?'} 位，计划投入 ${candidate.plannedMinutes ?? '?'} min）`)
  if (candidate.dueToday) labels.push('今天到期')
  if (candidate.overdue) labels.push('已逾期')
  if (candidate.inProgress) labels.push('在推进')
  if (candidate.dueUnparseable) labels.push('截止时间无法解析')
  return labels.length === 0 ? '候选' : labels.join('、')
}

function dueLabel(candidate: PlanCandidate): string {
  if (candidate.effectiveDueAt === null) return '无截止'
  const ms = Date.parse(candidate.effectiveDueAt)
  if (!Number.isFinite(ms)) return `截止无法解析（${candidate.effectiveDueAt}）`
  const date = new Date(ms)
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return `截止 ${stamp}`
}

export function buildPlanPrompt(input: BuildPlanPromptInput): PlanPromptPayload {
  const selection = selectPromptCandidates(input.candidates, input.limit ?? PLAN_PROMPT_CANDIDATE_LIMIT)
  const { listed, omitted, total, notice, truncated } = selection
  const lines: string[] = []

  lines.push(`## 候选任务（${input.planDate}）`)
  lines.push('')
  lines.push(`共 ${total} 条候选；下面按「优先级 → 有效截止 → 创建时间」稳定排序，最多列 ${input.limit ?? PLAN_PROMPT_CANDIDATE_LIMIT} 条。`)
  if (input.existingPlanCount !== undefined && input.existingPlanCount > 0) {
    lines.push(`该日计划里已有 ${input.existingPlanCount} 条；带「已排入」的候选是既有成员，重排时保持它们的计划投入不变，除非用户明确改。`)
  }
  if (notice !== '') lines.push(`⚠️ ${notice} —— 未列出的条目**不是没有任务**，只是这次没进排序窗口；不要声称已对全量做排序。`)
  lines.push('')
  if (listed.length === 0) {
    lines.push('（没有候选任务：没有今天到期的、也没有在推进的、也没有已排入该日计划的）')
  }
  for (const candidate of listed) {
    const minutes = candidate.planned ? candidate.plannedMinutes : candidate.suggestedMinutes
    const minutesLabel = candidate.planned ? `计划投入 ${minutes} min` : `建议投入 ${minutes} min${candidate.usedDefaultEstimate ? '（按默认）' : ''}`
    lines.push(`- #${candidate.rank} [${candidate.band.toUpperCase()}] ${candidate.title}（${statusLabel(candidate.statusCode)}，${dueLabel(candidate)}，${minutesLabel}）— ${reasonLabel(candidate)}`)
  }
  const diagnostics = input.diagnostics ?? []
  if (diagnostics.length > 0) {
    lines.push('')
    lines.push('### 数据有问题的条目（照实告知用户，不要悄悄丢掉）')
    for (const item of diagnostics) lines.push(`- ${item.message}`)
  }
  lines.push('')
  lines.push('提交提案时每项给 {task_id, order, note, minutes?}：minutes 是“今天在这条上计划投入多少分钟”（1–1440），不是任务总耗时；不要传 effortDone（今日投入是否结束只能由用户操作）。')

  return { listed, total, omitted, truncated, notice, text: lines.join('\n') }
}
