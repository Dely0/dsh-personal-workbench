/**
 * **日期面板**：承载「某一天」全部内容的唯一界面（计划 / 逾期 / 未排期 / 已完成 / 报告）。
 *
 * ## 为什么存在（ADR0001 口径冻结，批次2 D15）
 *
 * 在它出现之前，「今日」页与「日历选中某天」是**两份装配**：
 * 今日树按「全部未完成任务」，日历计划树按「当日到期 ∪ 今天无截止」——
 * 同一个语义两处实现，于是两边看到的任务集永远对不上（本项目最大的 bug 类别）。
 *
 * 现在：**「今日」就是这个面板的 today 实例**（外层额外加统计卡与容量条），
 * 「日历」只是它的周/月容器。任务页签的成员口径来自
 * `shared/dailyPlanPolicy.ts#dayPanelTabMembers`（计划 ∪ 逾期 ∪ 未排期，逐条标来源）
 * ——**判定不在这份文件里**，组件只负责把父级算好的快照画出来（项目规范第 2 条）。
 *
 * ## 边界
 *
 * - 不读全局：页签状态、计划、树、报告都由 props 进来；
 * - 不做候选过滤、不拼请求：写入一律通过回调交给父级；
 * - 「逾期」/「未排期」是否可见由 `extraTabsAvailable` 决定（过去日期不显示，见 ADR0001 口径补充），
 *   兜底落点用 `resolveDayPanelTab()`（与装配层同一份判定，不许各写一遍）。
 */
import type { ReactNode } from 'react'
import { Icon } from './Icon.js'
import { MarkdownText } from './MarkdownText.js'
import { PlanPanel } from './PlanPanel.js'
import { TaskTreeRows, countTaskTree, type PendingMap } from './TaskList.js'
import type { DailyPlanView, Dict, Task, TaskReportView } from '../viewTypes.js'
import { countTaskTreeBy, type TaskTreeNode } from '../taskFilterSort.js'
import { localDateString, startOfWeek } from '../format.js'
import { isDayPanelExtraTab, resolveDayPanelTab, type DayPanelTabCode } from '../../shared/dailyPlanPolicy.js'

/** 面板的页签（**类型定义在共享层**：装配层与组件引用同一份，不许各写一份字面量联合）。 */
export type DayTab = DayPanelTabCode

export interface DayPanelProps {
  /** 该日的本地日键（YYYY-MM-DD）——面包屑与只读判据都用它。 */
  day: string
  /** 是否"今天"（决定能不能结束当日投入、以及空态文案）。 */
  isToday: boolean
  /** 过去日期只读（不能排序、不能改计划）。 */
  readOnly: boolean
  /** 「逾期」/「未排期」在该日是否显示（过去日期不显示）。 */
  extraTabsAvailable: boolean
  tab: DayTab
  onTabChange: (tab: DayTab) => void
  /** 该日计划（`null` = 还没有计划）。 */
  plan: DailyPlanView | null
  /** 手动添加候选（父级用唯一候选函数算好）。 */
  candidateRows: Array<{ id: string; title: string }>
  /** AI 提示词候选被截断时的告知（不许给"全量排序"的假印象）。 */
  promptInfo: { truncated: boolean; notice: string }
  /** 计划树（**已经**按 `dayPanelTabMembers` 过滤过）。 */
  planTree: TaskTreeNode<Task>[]
  /** 逾期树 / 未排期树（同上，成员口径在共享层）。 */
  overdueTree: TaskTreeNode<Task>[]
  unscheduledTree: TaskTreeNode<Task>[]
  /** 已完成树。 */
  doneTree: TaskTreeNode<Task>[]
  doneContextIds?: Set<string>
  overdueContextIds?: Set<string>
  unscheduledContextIds?: Set<string>
  /** 「计划」页签的分组行（ADR0010）：灰化、不计入计划条数。 */
  planContextIds?: Set<string>
  /** 分组行合计文案（父级从共享纯函数算好；缺省 = 不画）。 */
  groupSummaryOf?: (taskId: string) => string | null
  expanded: Set<string>
  onToggleExpanded: (taskId: string) => void
  /** 行来源标签（来自 `dayPanelTabMembers`，界面不自己判）。 */
  sourceLabelOf?: (taskId: string) => string | null
  /**
   * 行内「排入今日」（2026-10-02）：只在**今天**这一实例 + **逾期 / 未排期**两个页签上传入。
   *
   * 未来日期**不传**：那一天要按"未来排期"语义另画（现版本只做今天，见 ADR0001 口径补充），
   * 而 `POST /plans/:date/items` 的排入入口目前只服务今天 —— 给未来日渲染一个写着"排入今日"的按钮，
   * 点了却排到今天，就是骗人。
   */
  onScheduleToday?: (taskId: string) => void
  /** 已排进这一天（父级给出）→ 那些行不渲染「排入今日」。 */
  scheduledIds?: Set<string>
  /** 正在排入的任务 id（禁用重复点击）。 */
  schedulingTaskId?: string | null
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
    day, isToday, readOnly, extraTabsAvailable, tab, onTabChange, plan, candidateRows, promptInfo,
    planTree, overdueTree, unscheduledTree, doneTree,
    doneContextIds, overdueContextIds, unscheduledContextIds, planContextIds, groupSummaryOf,
    expanded, onToggleExpanded, sourceLabelOf, tasks, dicts, selectedId, pending, childrenOf,
    busy, onOpen, onSort, onComplete, onDefer, onEffortChange, onMinutesChange, onProgressChange,
    onClearPlan, onSavePlan, report, emptyPlanAction,
    onScheduleToday, scheduledIds, schedulingTaskId,
  } = props

  const reportAnchor = report.subTab === 'week' ? localDateString(startOfWeek(new Date(day))) : day
  const doneCount = countTaskTreeBy(doneTree, (task: Task) => task.completedAt !== null)
  /**
   * 当前真正生效的页签：过去日期上「逾期」/「未排期」不存在，兜底到「计划」。
   * 用共享层的 `resolveDayPanelTab`（装配层把 state 收回来的落点与它**必须一致**）。
   */
  const activeTab = resolveDayPanelTab(tab, extraTabsAvailable)
  /** 上下文行（父/祖父链）不计入计数 —— 与「已完成」页签同一条规矩。 */
  const countMembers = (tree: TaskTreeNode<Task>[], contextIds: Set<string> | undefined): number =>
    (contextIds === undefined ? countTaskTree(tree) : countTaskTreeBy(tree, (task: Task) => !contextIds.has(task.id)))

  const tabDefs: Array<{ code: DayTab; label: string; icon: string; count: number }> = [
    /**
     * 「计划」页签的计数 = **真计划项**条数：分组行（父/祖先链）只作上下文，不计入
     *（ADR0010：父任务自己不是计划项）。
     */
    { code: 'plan', label: '计划', icon: 'list', count: countMembers(planTree, planContextIds) },
    { code: 'overdue', label: '逾期', icon: 'bell', count: countMembers(overdueTree, overdueContextIds) },
    { code: 'unscheduled', label: '未排期', icon: 'calendar', count: countMembers(unscheduledTree, unscheduledContextIds) },
    { code: 'done', label: '已完成', icon: 'check', count: doneCount },
    { code: 'report', label: '报告', icon: 'report', count: 0 },
  ]
  const visibleTabs = tabDefs.filter((def) => (isDayPanelExtraTab(def.code) ? extraTabsAvailable : true))

  const roots = activeTab === 'plan'
    ? planTree
    : activeTab === 'overdue'
      ? overdueTree
      : activeTab === 'unscheduled' ? unscheduledTree : doneTree
  const contextIds = activeTab === 'done'
    ? doneContextIds
    : activeTab === 'overdue' ? overdueContextIds : activeTab === 'unscheduled' ? unscheduledContextIds : activeTab === 'plan' ? planContextIds : undefined
  /**
   * 行内「排入今日」只在**今天** + **逾期 / 未排期**两个页签上（那两页里的行按定义都还没排进今天，
   * 除"逾期∩计划"的事实重叠行 —— 那些由 `scheduledIds` 挡掉）。缺 `onScheduleToday` 就整列不出现。
   */
  const showScheduleAction = isToday && onScheduleToday !== undefined
    && (activeTab === 'overdue' || activeTab === 'unscheduled')

  return (
    <>
      {/* 任务页签（计划/逾期/未排期）+ 已完成 + 报告 —— 今日与日历共用同一份（ADR0001） */}
      <div className="wb-segmented wb-sub-segmented" data-day-tabs>
        {visibleTabs.map((def) => (
          <button key={def.code} className={`wb-seg ${activeTab === def.code ? 'on' : ''}`} onClick={() => onTabChange(def.code)}>
            <Icon name={def.icon} />{def.label}{def.code !== 'report' && <span className="count">{def.count}</span>}
          </button>
        ))}
      </div>

      {activeTab === 'plan' && (
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
            */}
        </>
      )}

      {activeTab === 'report' ? (
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
        <div className="wb-list" data-day-tree={activeTab}>
          <TaskTreeRows
            roots={roots}
            depth={0}
            expanded={expanded}
            toggle={onToggleExpanded}
            dicts={dicts}
            onOpen={onOpen}
            selectedId={selectedId}
            contextIds={contextIds}
            pending={pending}
            childrenOf={childrenOf}
            sourceLabelOf={activeTab === 'plan' ? sourceLabelOf : undefined}
            groupSummaryOf={activeTab === 'plan' ? groupSummaryOf : undefined}
            onSchedule={showScheduleAction ? onScheduleToday : undefined}
            scheduledIds={showScheduleAction ? scheduledIds : undefined}
            schedulingTaskId={showScheduleAction ? schedulingTaskId : undefined}
          />
          {roots.length === 0 && (
            <div className="wb-empty" style={{ padding: '24px 18px' }} data-day-empty={activeTab}>
              {planEmptyNode(activeTab, day, emptyPlanAction)}
            </div>
          )}
        </div>
      )}
    </>
  )
}

/**
 * 空态文案（每个页签说清"为什么这里是空的"）。
 *
 * 「逾期」/「未排期」必须解释判据 —— 否则用户会以为"任务丢了"（这次需求就是这么来的）。
 */
function planEmptyNode(tab: DayTab, day: string, emptyPlanAction: ReactNode): ReactNode {
  if (tab === 'plan') {
    return emptyPlanAction !== undefined
      ? emptyPlanAction
      : (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{day} 没有计划任务</div>
          <div style={{ fontSize: 12, opacity: .8, marginTop: 4 }}>切换到其他日期查看计划/记录</div>
        </>
      )
  }
  if (tab === 'overdue') {
    return (
      <>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>没有逾期任务</div>
        <div style={{ fontSize: 12, opacity: .8, marginTop: 4 }}>截止时间早于 {day} 的未完成任务会出现在这里（已完成 / 已取消 / 已归档不算）。</div>
      </>
    )
  }
  if (tab === 'unscheduled') {
    return (
      <>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>没有未排期的任务</div>
        <div style={{ fontSize: 12, opacity: .8, marginTop: 4 }}>
          既没逾期、也没排进这一天、状态也不是进行中的未完成任务会出现在这里 —— 想安排它们请先给任务设截止时间，或把状态改成「进行中」。
        </div>
      </>
    )
  }
  return (
    <>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{day} 没有完成记录</div>
      <div style={{ fontSize: 12, opacity: .8, marginTop: 4 }}>切换到其他日期查看计划/记录</div>
    </>
  )
}
