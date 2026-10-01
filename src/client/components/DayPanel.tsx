/**
 * **日期面板**：承载「某一天」全部内容的唯一界面（计划 / 已完成 / 报告）。
 *
 * ## 为什么存在（ADR0001 口径冻结，批次2 D15）
 *
 * 在它出现之前，「今日」页与「日历选中某天」是**两份装配**：
 * 今日树按「全部未完成任务」，日历计划树按「当日到期 ∪ 今天无截止」——
 * 同一个语义两处实现，于是两边看到的任务集永远对不上（本项目最大的 bug 类别）。
 *
 * 现在：**「今日」就是这个面板的 today 实例**（外层额外加统计卡与容量条），
 * 「日历」只是它的周/月容器。树的口径来自 `shared/dailyPlanPolicy.ts#dayPanelTreeSources`
 * （当日到期 ∪ 当日计划项 ∪ 进行中，逐条标来源）——**判定不在这份文件里**，
 * 组件只负责把父级算好的快照画出来（项目规范第 2 条）。
 *
 * ## 边界
 *
 * - 不读全局：页签状态、计划、树、报告都由 props 进来；
 * - 不做候选过滤、不拼请求：写入一律通过回调交给父级。
 */
import type { ReactNode } from 'react'
import { Icon } from './Icon.js'
import { MarkdownText } from './MarkdownText.js'
import { PlanPanel } from './PlanPanel.js'
import { TaskTreeRows, countTaskTree, type PendingMap } from './TaskList.js'
import type { DailyPlanView, Dict, Task, TaskReportView } from '../viewTypes.js'
import { countTaskTreeBy, type TaskTreeNode } from '../taskFilterSort.js'
import { localDateString, startOfWeek } from '../format.js'

/** 面板的三个页签。 */
export type DayTab = 'plan' | 'done' | 'report'

export interface DayPanelProps {
  /** 该日的本地日键（YYYY-MM-DD）——面包屑与只读判据都用它。 */
  day: string
  /** 是否"今天"（决定能不能结束当日投入、以及空态文案）。 */
  isToday: boolean
  /** 过去日期只读（不能排序、不能改计划）。 */
  readOnly: boolean
  tab: DayTab
  onTabChange: (tab: DayTab) => void
  /** 该日计划（`null` = 还没有计划）。 */
  plan: DailyPlanView | null
  /** 手动添加候选（父级用唯一候选函数算好）。 */
  candidateRows: Array<{ id: string; title: string }>
  /** AI 提示词候选被截断时的告知（不许给"全量排序"的假印象）。 */
  promptInfo: { truncated: boolean; notice: string }
  /** 计划树（**已经**按 `dayPanelTreeSources` 过滤过）。 */
  planTree: TaskTreeNode<Task>[]
  /** 已完成树。 */
  doneTree: TaskTreeNode<Task>[]
  doneContextIds?: Set<string>
  expanded: Set<string>
  onToggleExpanded: (taskId: string) => void
  /** 行来源标签（来自 `dayPanelTreeSources`，界面不自己判）。 */
  sourceLabelOf?: (taskId: string) => string | null
  tasks: Task[]
  dicts: Dict[]
  selectedId?: string
  pending: PendingMap
  childrenOf?: (taskId: string) => readonly Task[] | undefined
  busy: boolean
  onOpen: (task: Task) => void
  /** 「AI 智能排序 / 继续编辑该日计划」。 */
  onSort: () => void
  onComplete: (taskId: string) => Promise<void>
  onDefer: (taskId: string) => Promise<void>
  onEffortChange?: (taskId: string, next: boolean) => Promise<void>
  onMinutesChange?: (taskId: string, minutes: number) => Promise<void>
  onProgressChange?: (taskId: string, percent: number) => Promise<void>
  onClearPlan: () => void
  onSavePlan?: (items: Array<{ taskId: string; note: string; minutes?: number }>) => Promise<void>
  report: {
    subTab: 'day' | 'week'
    onSubTabChange: (tab: 'day' | 'week') => void
    /** 未来日期：报告只做复盘，不排期。 */
    isFuture: boolean
    current: TaskReportView | null
    /** 是否已有该周期的报告会话（决定按钮文案：继续编辑 / 生成）。 */
    sessionActive: boolean
    onGenerate: () => void
    onDelete: () => void
  }
  /** 计划页签下、"计划里还没有内容"时的空态动作（今日给「快速录入 / 新建任务」，其它日期给「AI 智能排序」）。 */
  emptyPlanAction?: ReactNode
}

export function DayPanel(props: DayPanelProps): JSX.Element {
  const {
    day, isToday, readOnly, tab, onTabChange, plan, candidateRows, promptInfo, planTree, doneTree,
    doneContextIds, expanded, onToggleExpanded, sourceLabelOf, tasks, dicts, selectedId, pending, childrenOf,
    busy, onOpen, onSort, onComplete, onDefer, onEffortChange, onMinutesChange, onProgressChange,
    onClearPlan, onSavePlan, report, emptyPlanAction,
  } = props

  const reportAnchor = report.subTab === 'week' ? localDateString(startOfWeek(new Date(day))) : day
  const doneCount = countTaskTreeBy(doneTree, (task: Task) => task.completedAt !== null)

  return (
    <>
      {/* 三个页签：计划 / 已完成 / 报告 —— 今日与日历共用同一份（ADR0001：今日的「已完成」由此自动获得） */}
      <div className="wb-segmented wb-sub-segmented" data-day-tabs>
        <button className={`wb-seg ${tab === 'plan' ? 'on' : ''}`} onClick={() => onTabChange('plan')}>
          <Icon name="list" />计划 <span className="count">{countTaskTree(planTree)}</span>
        </button>
        <button className={`wb-seg ${tab === 'done' ? 'on' : ''}`} onClick={() => onTabChange('done')}>
          <Icon name="check" />已完成 <span className="count">{doneCount}</span>
        </button>
        <button className={`wb-seg ${tab === 'report' ? 'on' : ''}`} onClick={() => onTabChange('report')}>
          <Icon name="report" />报告
        </button>
      </div>

      {tab === 'plan' && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            {readOnly
              ? <span style={{ fontSize: 12, color: '#999' }}>过去日期只读；如需为今天/未来排期，请选择今天或之后的日期。</span>
              : <button className="wb-btn primary" disabled={busy} onClick={onSort}><Icon name="sparkles" />{plan !== null ? (isToday ? '继续编辑今日计划' : `继续编辑该日计划`) : (isToday ? 'AI 智能排序' : `AI 智能排序（${day}）`)}</button>}
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>AI 会先提交顺序提案，确认后才生效</span>
            {/* 候选被截断时必须当场说出来：不给"全量排序"的假印象（需求 §5.1） */}
            {promptInfo.truncated && <span style={{ fontSize: 12, color: '#d9a03f' }} role="status">{promptInfo.notice}</span>}
          </div>
          {plan !== null && (
            <PlanPanel
              plan={plan}
              tasks={tasks}
              title={isToday ? `今日计划 · ${plan.planDate}` : `${plan.planDate} 计划`}
              canEdit={!readOnly}
              candidateTasks={candidateRows}
              canEndEffort={isToday}
              onComplete={onComplete}
              onDefer={onDefer}
              onEffortChange={isToday ? onEffortChange : undefined}
              onMinutesChange={readOnly ? undefined : onMinutesChange}
              onProgressChange={onProgressChange}
              onRefresh={readOnly ? undefined : onSort}
              onClear={onClearPlan}
              onSave={onSavePlan}
            />
          )}
          {/**
            * ⚠️ 这里原来有一句「另有 N 个进行中任务未设置截止时间，暂列今天」——
            * 那是旧口径的补丁：无截止的进行中任务当时不在树的判据里，只好"暂列"。
            * 冻结口径下它们由**进行中**这个来源正式承接（ADR0001），所以这句话连同
            * 判据一起删掉了（留着会让用户以为这是特例）。
            */
          }
        </>
      )}

      {tab === 'report' ? (
        <div className="wb-card">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="wb-segmented wb-sub-segmented">
              <button className={`wb-seg ${report.subTab === 'day' ? 'on' : ''}`} onClick={() => report.onSubTabChange('day')}>日报（{day}）</button>
              <button className={`wb-seg ${report.subTab === 'week' ? 'on' : ''}`} onClick={() => report.onSubTabChange('week')}>周报（{localDateString(startOfWeek(new Date(day)))} 起）</button>
            </div>
            <div style={{ flex: 1 }} />
          </div>
          {report.isFuture ? (
            <div className="wb-empty">
              未来日期属于工作安排，报告只做复盘。<br />如需安排未来工作，请在「计划」页签给任务设置截止时间；AI 未来排期将在下版支持。
            </div>
          ) : report.current !== null ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <h4 style={{ flex: 1, margin: 0 }}>{report.current.title}</h4>
                <button className="wb-btn" onClick={report.onDelete}>删除</button>
              </div>
              <div style={{ marginTop: 6 }}><MarkdownText text={report.current.summaryMd} /></div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="wb-btn primary" disabled={busy} onClick={report.onGenerate}>
                  {report.sessionActive || report.current.sessionId !== null ? '继续编辑报告' : 'AI 生成报告'}
                </button>
              </div>
            </>
          ) : (
            <div className="wb-empty" style={{ marginTop: 8 }}>
              {report.subTab === 'week' ? '本周' : '当天'}还没有报告。
              <div style={{ marginTop: 10 }}>
                <button className="wb-btn primary lg" disabled={busy} onClick={report.onGenerate}>
                  {report.sessionActive ? '继续编辑报告' : `AI 生成${report.subTab === 'week' ? '周报' : '日报'}（${reportAnchor}）`}
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 8 }}>同一周期只有一个报告会话，重复点击会回到原会话继续修改。</div>
            </div>
          )}
        </div>
      ) : (
        <div className="wb-list" data-day-tree={tab}>
          <TaskTreeRows
            roots={tab === 'plan' ? planTree : doneTree}
            depth={0}
            expanded={expanded}
            toggle={onToggleExpanded}
            dicts={dicts}
            onOpen={onOpen}
            selectedId={selectedId}
            contextIds={tab === 'done' ? doneContextIds : undefined}
            pending={pending}
            childrenOf={childrenOf}
            sourceLabelOf={tab === 'plan' ? sourceLabelOf : undefined}
          />
          {(tab === 'plan' ? planTree : doneTree).length === 0 && (
            <div className="wb-empty" style={{ padding: '24px 18px' }} data-day-empty={tab}>
              {tab === 'plan' && emptyPlanAction !== undefined
                ? emptyPlanAction
                : (
                  <>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{day} 没有{tab === 'plan' ? '计划任务' : '完成记录'}</div>
                    <div style={{ fontSize: 12, opacity: .8, marginTop: 4 }}>切换到其他日期查看计划/记录</div>
                  </>
                )}
            </div>
          )}
        </div>
      )}
    </>
  )
}
