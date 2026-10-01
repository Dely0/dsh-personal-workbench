/**
 * 「今日容量 · 规则与账本」面板（T2/D09 起口径 = 当日**计划投入**，ADR 0002）。
 *
 * ## 职责边界（本项目最大的 bug 类别是"同一语义两处算"）
 * 这个组件**只吃 props，不自己算一遍**：`planned` / `doneMinutes` / `unscheduled` /
 * `byPriority` 全部来自纯函数 `computeTodayCapacity` →
 * `src/shared/dailyPlanPolicy.ts#computeCapacityLedger`。
 * 组件里**不许**出现 `reduce(` + `minutes` 这种求和，也不许自己判"今天到期/逾期"。
 *
 * ## 状态所有权
 * `includeOverdue`（显示逾期待办候选）与 `defaultEstimateMinutes`（默认投入）的
 * **唯一权威源是 `settings`**（服务端 meta）。本组件只渲染值、把动作回调出去，
 * **不存第二份副本** —— 否则会出现"面板开关是开的、容量按关的算"这种假控件。
 *
 * 文案与 ADR 0002 逐条对应，改这里必须同步改文档。
 */
import type { CapacityLedger, CapacityPlanRow, CapacityUnscheduledRow } from '../../shared/dailyPlanPolicy.js'
import { Icon } from './Icon.js'

/** 面板只吃 props；`capacity` 由页面从纯函数结果直接传进来，不做二次加工。 */
export interface CapacityRulePanelProps {
  capacity: CapacityLedger
  /** 每天可投入时长（分钟）—— 头部读数用。 */
  dailyCapacityMinutes: number
  /** 默认投入（分钟）—— 文案里要显示"默认 N 分钟"，所以必须用**当前设置值**而不是字面量 30。 */
  defaultEstimateMinutes: number
  includeOverdue: boolean
  /** 逾期候选开关（唯一权威源是 settings；这里只回调）。 */
  onIncludeOverdueChange: (next: boolean) => void
  expanded: boolean
  onExpandedChange: (next: boolean) => void
  /** 一键排入（每条未排入行）；返回的 Promise 失败时父级负责显示中文错误。 */
  onAddToPlan?: (taskId: string, minutes: number) => Promise<void>
  /** 正在排入的 taskId（禁用重复点击）。 */
  addingTaskId?: string | null
  /**
   * 只渲染**头部那个开关**，不渲染摘要与展开体（2026-10-01）。
   *
   * 用户要求："规则按钮放到上面一行去"（与容量彩条/图例同一行），并删掉那段
   * "已排…未排入…"的提示段 —— 它独占一整行，而同样的数字在上面的
   * 「已排 / 可投入 / 余」里已经有了，属于**同一事实的第二处展示**。
   * 所以内联模式下这里只出一个开关按钮；展开体仍由本组件渲染（口径不变）。
   */
  inlineToggle?: boolean
}

/** 计划项的来源标签（逐字，用户能一眼看出这条是 AI 排的还是手动的）。 */
export function capacitySourceLabel(source: CapacityPlanRow['source']): string {
  if (source === 'plan-ai') return 'AI 提案'
  if (source === 'plan-manual') return '手动排入'
  return '导入'
}

/** 账本一行的补充标记（任务状态 / 数据异常）。 */
export function capacityRowLabels(row: CapacityPlanRow): string[] {
  const labels: string[] = []
  if (row.taskMissing) labels.push('任务不存在')
  else if (row.taskClosed) labels.push(row.statusCode === 'done' ? '任务已完成' : row.statusCode === 'cancelled' ? '任务已取消' : '任务已归档')
  if (row.effortDone) labels.push('今日投入已结束')
  return labels
}

/** 条形读数的 `aria-label`：读屏用户与视觉用户看到的口径必须一致。 */
export function capacityAriaLabel(capacity: CapacityLedger): string {
  if (!capacity.readable) return `今日容量不可计算：${capacity.reason ?? '计划数据无法解析'}`
  return `今日计划投入占比：紧急 ${capacity.byPriority.p0} 分钟、高 ${capacity.byPriority.p1} 分钟、`
    + `普通 ${capacity.byPriority.p2} 分钟、低 ${capacity.byPriority.p3} 分钟、空闲 ${capacity.free} 分钟；`
    + `已排 ${capacity.plannedCount} 条 / ${capacity.planned} 分钟（其中今日投入已结束 ${capacity.doneMinutes} 分钟），`
    + `未排入 ${capacity.unscheduledCount} 条 / 建议投入合计 ${capacity.unscheduledSuggestedMinutes} 分钟。`
}

const RULE_TEXTS = (defaultEstimateMinutes: number): Array<{ title: string; body: string }> => [
  { title: '「已排」只算当天计划', body: '已排 = 当天的「计划投入」分钟之和。没有排进当天计划的任务，即使今天到期也不计入 —— 它们出现在下面的「未排入」区，可以一键排入。' },
  { title: '计划投入是快照', body: '每条计划项的分钟数在排入那一刻就冻结：之后改任务的「预计耗时」不会回头改写它。要改就单独改这一条的计划投入。' },
  { title: '历史投入不自动减', body: '任务完成/取消/归档、或者今日投入已结束时，那一天的投入**仍然算在已排里**（它是那天的计划记录）。只有你移除该日计划项或删除整份计划才会减少。' },
  { title: '未排入只是候选', body: `下面的「未排入」是你今天可能做的事，每条显示**建议投入**（任务的预计耗时，没填就按默认 ${defaultEstimateMinutes} 分钟，可在设置里改）。建议投入**不计入**已排，避免把两件事混成一个数字。` },
  { title: '逾期不改变已排', body: '「显示逾期待办候选」只决定逾期的未完成任务要不要出现在候选里，**不改变已排**，也不会把它们自动排进计划。' },
  { title: '不含实际工时', body: '这里没有计时器：计划投入是你打算投多少，今日投入是否结束是你自己的判断，两者都不是实际工时，也不会自动累加任务进度。' },
  { title: '提醒与日历不受影响', body: '提醒、逾期判定与日历上的到期展示仍按「截止时间」走，本次改造只动了「今天要投入多少」这件事。' },
]

function AuditTable({ rows }: { rows: CapacityPlanRow[] }): JSX.Element {
  return (
    <table className="wb-cap-audit">
      <thead>
        <tr><th>任务</th><th>优先级</th><th>分钟</th><th>来源</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.taskId}>
            <td className="t" title={row.title}>{row.title}</td>
            <td className="p">{row.band.toUpperCase()}</td>
            <td className="m">{row.minutes}</td>
            <td className="s">
              <span className="tag">{capacitySourceLabel(row.source)}</span>
              {capacityRowLabels(row).map((label) => <span key={label} className="tag">{label}</span>)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function UnscheduledTable({ rows, defaultEstimateMinutes, onAddToPlan, addingTaskId }: {
  rows: CapacityUnscheduledRow[]
  defaultEstimateMinutes: number
  onAddToPlan?: (taskId: string, minutes: number) => Promise<void>
  addingTaskId?: string | null
}): JSX.Element {
  return (
    <table className="wb-cap-audit">
      <thead>
        <tr><th>任务</th><th>优先级</th><th>建议投入</th><th>来源</th><th /></tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const labels: string[] = []
          if (row.dueToday) labels.push('今天到期')
          if (row.overdue) labels.push('逾期')
          if (row.inProgress) labels.push('在推进')
          if (row.usedDefaultEstimate) labels.push(`按默认 ${defaultEstimateMinutes}`)
          return (
            <tr key={row.taskId}>
              <td className="t" title={row.title}>{row.title}</td>
              <td className="p">{row.band.toUpperCase()}</td>
              <td className="m">{row.suggestedMinutes}</td>
              <td className="s">{labels.map((label) => <span key={label} className="tag">{label}</span>)}</td>
              <td className="a">
                {onAddToPlan !== undefined && (
                  <button
                    type="button"
                    className="wb-btn"
                    disabled={addingTaskId !== null && addingTaskId !== undefined}
                    onClick={() => void onAddToPlan(row.taskId, row.suggestedMinutes)}
                  >
                    {addingTaskId === row.taskId ? '排入中…' : '排入今日'}
                  </button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * 计划数据不可解析时的**唯一**呈现：绝不给假 0。
 * 界面要说清"哪一天的计划读不出来"以及"原数据没被改动"。
 */
function UnreadableNotice({ reason }: { reason: string }): JSX.Element {
  return (
    <div className="wb-cap-unreadable" role="alert" style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', padding: '6px 2px' }}>
      <b>今日容量不可计算</b>：{reason}。<br />
      原数据没有被改动，也不会被自动覆盖。请先备份数据库，再手工修复该日计划的 <code>items_json</code>，或显式清空这份计划。
    </div>
  )
}

export function CapacityRulePanel(props: CapacityRulePanelProps): JSX.Element {
  const { capacity, dailyCapacityMinutes, defaultEstimateMinutes, includeOverdue, onIncludeOverdueChange, expanded, onExpandedChange, onAddToPlan, addingTaskId, inlineToggle = false } = props
  return (
    <div className="wb-cap-rule" data-cap-expanded={expanded ? '1' : '0'} data-inline={inlineToggle ? '1' : '0'}>
      <div className="wb-cap-rule-head">
        <button
          type="button"
          className="wb-cap-rule-toggle"
          aria-expanded={expanded}
          aria-label={capacityAriaLabel(capacity)}
          onClick={() => onExpandedChange(!expanded)}
        >
          {/**
            * ⚠️ 文案在两态之间必须**完全相同**，只有箭头的旋转角度变。
            *
            * 2026-10-01 实测：旧文案「收起规则 ⌃」↔「⌄ 规则」宽度差 2px（`Icon name="chevron"`
            * 是左向字形，更糟的是视觉上也指错方向），按钮位置在开合之间会跳动
            * —— 用户原话："打开、收起规则的按钮还不在同一个位置"。
            * 现在固定成「规则」两字 + 一个箭头图标（CSS 按展开态旋转 180°），
            * 按钮宽度与位置在两态之间**逐像素一致**。
            */}
          <span className="wb-cap-rule-arrow" aria-hidden="true">
            <Icon name="chevron" size={12} />
          </span>
          规则
        </button>
        {/**
          * 摘要只在**非内联**模式下渲染。
          *
          * 内联模式（图例那一行）里，这段"已排 N min（M 条）· 可投入 X · 余 Y · 未排入 Z 条"
          * 与上面「已排 / 可投入 / 余」是**同一事实的第二处展示** —— 用户明确要求删掉它换高度。
          * 信息没丢：数字仍在标题行，`未排入` 的入口在展开体里（那里有逐条列表与一键排入）。
          */}
        {!inlineToggle && (
          <span className="wb-cap-rule-sum">
            {capacity.readable
              ? <>
                  已排 <b>{capacity.planned}</b> min（{capacity.plannedCount} 条，已结束 {capacity.doneMinutes} min） ·
                  可投入 <b>{dailyCapacityMinutes}</b> min · 余 <b>{capacity.free}</b> min{capacity.over ? ' · 超支' : ''}
                  {capacity.unscheduledCount > 0 ? ` · 未排入 ${capacity.unscheduledCount} 条 / 建议 ${capacity.unscheduledSuggestedMinutes} min` : ''}
                </>
              : <><b>不可计算</b>：{capacity.reason ?? '计划数据无法解析'}</>}
          </span>
        )}
      </div>

      {expanded && (
        <div className="wb-cap-rule-body">
          <ol className="wb-cap-rules">
            {RULE_TEXTS(defaultEstimateMinutes).map((rule) => (
              <li key={rule.title}><b>{rule.title}</b>：{rule.body}</li>
            ))}
          </ol>

          {!capacity.readable && <UnreadableNotice reason={capacity.reason ?? '计划数据无法解析'} />}

          {capacity.diagnostics.length > 0 && (
            <div className="wb-cap-diagnostics" style={{ fontSize: 12, lineHeight: 1.7, padding: '4px 2px' }}>
              <div><b>数据提示（{capacity.diagnostics.length} 条）</b></div>
              <ul className="wb-cap-rules">
                {capacity.diagnostics.map((text) => <li key={text}>{text}</li>)}
              </ul>
            </div>
          )}

          <div className="wb-cap-audit-wrap">
            <div className="wb-cap-audit-title">账本 · 已排明细（{capacity.plannedItems.length} 条 / 合计 {capacity.planned} min）</div>
            {capacity.plannedItems.length === 0
              ? <div className="wb-cap-audit-empty">今天还没有排入任何计划投入（「已排」= 0）。下面的未排入区可以直接排入。</div>
              : <AuditTable rows={capacity.plannedItems} />}
            <div className="wb-cap-audit-total">合计 = 已排 <b>{capacity.planned}</b> min（其中今日投入已结束 <b>{capacity.doneMinutes}</b> min）</div>
          </div>

          <div className="wb-cap-unscheduled">
            <div className="wb-cap-overdue-head">
              未排入候选 <b>{capacity.unscheduledCount}</b> 条 / 建议投入合计 <b>{capacity.unscheduledSuggestedMinutes}</b> min —— 默认不计入「已排」
            </div>
            {capacity.unscheduledCount === 0
              ? <div className="wb-cap-audit-empty">没有未排入的候选（今天到期的、在推进的、已排入的都已经在计划里，或者逾期开关没打开）。</div>
              : <UnscheduledTable rows={capacity.unscheduled} defaultEstimateMinutes={defaultEstimateMinutes} onAddToPlan={onAddToPlan} addingTaskId={addingTaskId} />}
          </div>

          <label className="wb-cap-switch">
            <input
              type="checkbox"
              checked={includeOverdue}
              onChange={(e) => onIncludeOverdueChange(e.target.checked)}
            />
            <span>显示逾期待办候选</span>
            <span className="hint" title="只影响逾期的未完成任务是否出现在候选里；不改「已排」，也不会自动排进计划">?</span>
          </label>

          <div className="wb-cap-foot">
            默认投入 {defaultEstimateMinutes} 分钟（在设置里改） · 口径见 docs/adr/0002-capacity-reads-daily-plan.md
          </div>
        </div>
      )}
    </div>
  )
}
