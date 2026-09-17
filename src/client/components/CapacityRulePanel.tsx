/**
 * 「今日容量 · 规则与账本」面板。
 *
 * ## 职责边界（本项目最大的 bug 类别是"同一语义两处算"）
 * 这个组件**只吃 props，不自己算一遍**：`planned` / `byPriority` / 账本两半全部来自
 * `computeTodayCapacity`（纯函数，`src/client/capacity.ts`）。
 * 组件里**不许**出现 `reduce(` + `estimatedMinutes` 这种求和，也不许自己判"今天到期"。
 *
 * ## 状态所有权
 * `includeOverdue`（逾期是否计入）与 `defaultEstimateMinutes`（默认耗时）的**唯一权威源是
 * `settings`**（服务端 meta）。本组件只负责把值渲染出来、把用户动作回调出去，
 * **不存第二份副本** —— 否则就会出现"面板开关是开的、容量按关的算"这种假控件。
 *
 * 文案与设计文档 §12.1–§12.3 逐字对应，改这里必须同步改文档。
 */
import type { CapacityResult, CapacityBreakdown } from '../capacity.js'

/** 面板只吃 props；`capacity` 由页面从纯函数结果直接传进来，不做二次加工。 */
export interface CapacityRulePanelProps {
  capacity: CapacityResult
  /** 每天可投入时长（分钟）—— 头部读数用。 */
  dailyCapacityMinutes: number
  /** 默认耗时（分钟）—— 文案里要显示"默认 N 分钟"，所以必须用**当前设置值**而不是字面量 30。 */
  defaultEstimateMinutes: number
  includeOverdue: boolean
  /** 逾期口径开关（唯一权威源是 settings；这里只回调）。 */
  onIncludeOverdueChange: (next: boolean) => void
  expanded: boolean
  onExpandedChange: (next: boolean) => void
}

/**
 * 账本「来源」列的取值（逐字，见设计文档 §12.3）。
 *
 * 一条任务可能同时命中多个标记（例如"逾期计入 + 按默认 30"），所以返回数组而不是单值 ——
 * 只给一个标签会让用户以为"没有别的特殊情况"。
 */
export function capacitySourceLabels(row: CapacityBreakdown, defaultEstimateMinutes: number): string[] {
  const labels: string[] = []
  if (row.dueUnparseable) labels.push('截止时间无法解析')
  else if (row.overdueIncluded) labels.push('逾期计入')
  else if (row.source === 'due-today') labels.push('今天到期')
  else if (row.source === 'no-due-doing') labels.push('无截止·推进中')
  if (row.usedFallback) labels.push(`按默认 ${defaultEstimateMinutes}`)
  if (row.allDay) labels.push('全天')
  if (row.inheritedDue) {
    // 继承来源要看祖先状态：已取消父任务的过期 due = "幽灵逾期"（既有语义，本任务不修只标注）
    labels.push(row.ghostFromCancelledAncestor ? '继承自已取消父任务' : '继承父任务截止')
  }
  return labels
}

/** 条形读数的 `aria-label`：把三个计数也带上，读屏用户与视觉用户看到的口径必须一致。 */
export function capacityAriaLabel(capacity: CapacityResult): string {
  return `今日任务时间占比：紧急 ${capacity.byPriority.p0} 分钟、高 ${capacity.byPriority.p1} 分钟、`
    + `普通 ${capacity.byPriority.p2} 分钟、低 ${capacity.byPriority.p3} 分钟、空闲 ${capacity.free} 分钟；`
    + `今天到期 ${capacity.dueTodayCount} 条、无截止推进中 ${capacity.noDueDoingCount} 条、`
    + `逾期未计入 ${capacity.overdueExcluded.filter((row) => !row.dueUnparseable).length} 条 / ${capacity.overdueMinutes} 分钟。`
}

const RULE_TEXTS = (defaultEstimateMinutes: number): Array<{ title: string; body: string }> => [
  { title: '算哪些任务', body: '只看未归档、未完成、未取消的任务。' },
  { title: '截止时间会沿任务树继承', body: '任务自己没设截止时间时，用它最近的有截止时间的祖先的。' },
  { title: '今天到期', body: '有效截止时间落在今天（本地日）的，计入「已排」。' },
  { title: '无截止但在推进', body: '自己和祖先都没有截止时间、且状态是进行中/受阻的，计入「已排」。' },
  { title: '逾期的默认不计入', body: '有效截止时间早于今天 0 点且未完成的，默认不计入「已排」（下面可以打开开关把它算进去）。它和「今天到期」互不重叠，不会算两遍。' },
  { title: '每条任务算多少分钟', body: `用任务的「预计耗时」；没填的按默认耗时 ${defaultEstimateMinutes} 分钟（可在设置里改）。全天任务同样按预计耗时算 —— 「全天」只影响显示与重复锚点，不改变容量计算。` },
  { title: '汇总口径', body: '已排 = 上面所有计入任务的分钟之和；余 = max(0, 可投入 − 已排)；已排 > 可投入 时读数标为超支。下面的账本逐条列出了每个数字的来源。' },
]

function AuditTable({ rows, defaultEstimateMinutes }: { rows: CapacityBreakdown[]; defaultEstimateMinutes: number }): JSX.Element {
  return (
    <table className="wb-cap-audit">
      <thead>
        <tr><th>任务</th><th>优先级</th><th>分钟</th><th>来源</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td className="t" title={row.title}>{row.title}</td>
            <td className="p">{row.band.toUpperCase()}</td>
            <td className="m">{row.minutes}</td>
            <td className="s">{capacitySourceLabels(row, defaultEstimateMinutes).map((label) => <span key={label} className="tag">{label}</span>)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function CapacityRulePanel(props: CapacityRulePanelProps): JSX.Element {
  const { capacity, dailyCapacityMinutes, defaultEstimateMinutes, includeOverdue, onIncludeOverdueChange, expanded, onExpandedChange } = props
  // 逾期区只统计**真逾期**：脏 due 串也在这个账本里（不许静默消失），但它不是逾期，
  // 不能混进"逾期 N 条 / M min"这个读数里（会让用户以为历史欠账比实际更多）。
  const overdueRows = capacity.overdueExcluded.filter((row) => !row.dueUnparseable)
  const unparseableRows = capacity.overdueExcluded.filter((row) => row.dueUnparseable)
  // 分钟合计**用纯函数给的值**，不在这里再 reduce 一遍：同一语义两处算就是下一个 bug
  // （`overdueMinutes` 的定义里已经排除了脏 due 串）。
  const overdueMinutes = capacity.overdueMinutes
  return (
    <div className="wb-cap-rule" data-cap-expanded={expanded ? '1' : '0'}>
      <div className="wb-cap-rule-head">
        <button
          type="button"
          className="wb-cap-rule-toggle"
          aria-expanded={expanded}
          aria-label={capacityAriaLabel(capacity)}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? '收起规则 ⌃' : '⌄ 规则'}
        </button>
        <span className="wb-cap-rule-sum">
          已排 <b>{capacity.planned}</b> min · 可投入 <b>{dailyCapacityMinutes}</b> min ·
          余 <b>{capacity.free}</b> min{capacity.over ? ' · 超支' : ''}
          {capacity.fallbackCount > 0 ? ` · ${capacity.fallbackCount} 条按默认 ${defaultEstimateMinutes} 分钟` : ''}
        </span>
      </div>

      {expanded && (
        <div className="wb-cap-rule-body">
          <ol className="wb-cap-rules">
            {RULE_TEXTS(defaultEstimateMinutes).map((rule) => (
              <li key={rule.title}><b>{rule.title}</b>：{rule.body}</li>
            ))}
          </ol>

          <div className="wb-cap-audit-wrap">
            <div className="wb-cap-audit-title">账本 · 每个数字的来源（{capacity.included.length} 条计入）</div>
            {capacity.included.length === 0
              ? <div className="wb-cap-audit-empty">今天没有计入的任务（上面七条规则决定了谁会进来）。</div>
              : <AuditTable rows={capacity.included} defaultEstimateMinutes={defaultEstimateMinutes} />}
            <div className="wb-cap-audit-total">合计 = 已排 <b>{capacity.planned}</b> min</div>
          </div>

          {overdueRows.length > 0 && (
            <div className="wb-cap-overdue">
              <div className="wb-cap-overdue-head">
                逾期未完成 <b>{overdueRows.length}</b> 条 / <b>{overdueMinutes}</b> min —— 默认不计入「已排」
              </div>
              <AuditTable rows={overdueRows} defaultEstimateMinutes={defaultEstimateMinutes} />
            </div>
          )}

          {unparseableRows.length > 0 && (
            <div className="wb-cap-overdue">
              {/* 脏 due 串：既不进"已排"也不进"逾期"，但绝不能消失 —— 列出来让用户知道有数据坏了 */}
              <div className="wb-cap-overdue-head">
                截止时间无法解析 <b>{unparseableRows.length}</b> 条 —— 既不计入「已排」，也不算逾期
              </div>
              <AuditTable rows={unparseableRows} defaultEstimateMinutes={defaultEstimateMinutes} />
            </div>
          )}

          <label className="wb-cap-switch">
            <input
              type="checkbox"
              checked={includeOverdue}
              onChange={(e) => onIncludeOverdueChange(e.target.checked)}
            />
            <span>把逾期任务计入今日容量</span>
            <span className="hint" title={`打开后上面的「已排」会变成 ${capacity.planned + (includeOverdue ? 0 : overdueMinutes)} min`}>?</span>
          </label>

          <div className="wb-cap-foot">
            默认耗时 {defaultEstimateMinutes} 分钟（在设置里改） · 口径说明见设计文档 docs/design/2026-09-25-capacity-rules.md
          </div>
        </div>
      )}
    </div>
  )
}
