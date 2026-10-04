/**
 * D17 / P4：**日历视图**（原 `src/client/index.tsx` 的 `{view === 'calendar' && …}` 块，逐字搬迁）。
 *
 * 职责只有两件：① 周/月导航与格子（`weekDays` / `monthGrid` / 选中日高亮）；② 选中某天 = **同一个**
 * 日期面板（ADR 0001 / D15）。页签（计划/已完成/报告）、计划面板、任务树、报告卡都来自那一份装配 ——
 * 原来的两份装配（口径还不一致）已经删掉，本视图**不再自己拼一遍**。
 *
 * ## 边界
 * - 视图**不发 HTTP**（模式 5）：`onStartPlanAISession(day)` 是注入回调（`startAISession('plan', …)`
 *   属会话域，留在装配层）。
 * - 周的起点口径来自共享实现（`format.ts#startOfWeek`，**周一**为首日），本视图不自己算。
 * - `calMode` / `cursor` / `picked` 都是**日期域 state**（`useDayWorkspace`），这里只读写注入的动作。
 */
import { DayPanel, type DayPanelProps } from '../components/DayPanel.js'
import { sameDay, startOfDay } from '../format.js'
import { isTaskDueOnDay } from '../taskFilterSort.js'
import type { Task } from '../viewTypes.js'

export type CalendarViewProps = {
  calMode: 'week' | 'month'
  cursor: Date
  /** 渲染期的"现在"（今日高亮与"今天"按钮用）。 */
  now: Date
  /** 选中日（周格/月格高亮）。 */
  picked: Date
  weekDays: Date[]
  monthGrid: Date[]
  tasks: Task[]
  /** 装配层拼好的整份日期面板 props（不含空态，空态是日历视图独有的）。 */
  dayPanelProps: Omit<DayPanelProps, 'emptyPlanAction'>
  onMoveWeek: (delta: number) => void
  onMoveMonth: (delta: number) => void
  /** 「今天」按钮：周视图回到本周、月视图回到本月。 */
  onToday: () => void
  onPick: (date: Date) => void
  onCalModeChange: (mode: 'week' | 'month') => void
  /** 空态里的「AI 智能排序」（发起会话属会话域，走注入回调）。 */
  onStartPlanAISession: (day: string) => void
  /** 该日是否过去日期（过去日期给不出空态动作）。 */
  readOnly: boolean
  /** 当前面板日期键（空态文案用）。 */
  day: string
}

export function CalendarView(props: CalendarViewProps): JSX.Element {
  const {
    calMode, cursor, now, picked, weekDays, monthGrid, tasks, dayPanelProps,
    onMoveWeek, onMoveMonth, onToday, onPick, onCalModeChange, onStartPlanAISession, readOnly, day,
  } = props

  return (
    <>
      <div className="wb-cal-nav">
        <button className="wb-btn" onClick={() => (calMode === 'week' ? onMoveWeek(-1) : onMoveMonth(-1))}>◀</button>
        <button className="wb-btn" onClick={onToday}>今天</button>
        <button className="wb-btn" onClick={() => (calMode === 'week' ? onMoveWeek(1) : onMoveMonth(1))}>▶</button>
        <div style={{ flex: 1, textAlign: 'center', fontWeight: 600 }}>
          {calMode === 'week' ? `${cursor.getFullYear()}/${cursor.getMonth() + 1}/${cursor.getDate()} 周` : `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`}
        </div>
        <div className="wb-segmented wb-sub-segmented">
          <button className={`wb-seg ${calMode === 'week' ? 'on' : ''}`} onClick={() => onCalModeChange('week')}>周</button>
          <button className={`wb-seg ${calMode === 'month' ? 'on' : ''}`} onClick={() => onCalModeChange('month')}>月</button>
        </div>
      </div>

      {calMode === 'week' && (
        <div className="wb-week">
          {weekDays.map((d) => {
            const n = tasks.filter((t) => isTaskDueOnDay(t, d)).length
            return (
              <div key={d.toISOString()} className={`wb-day ${sameDay(d, now) ? 'today' : ''} ${sameDay(d, picked) ? 'selected' : ''}`} onClick={() => onPick(startOfDay(d))}>
                <div className="wb-day-date" style={{ fontSize: 12, color: '#999' }}>{d.getMonth() + 1}/{d.getDate()}</div>
                {n > 0 && <div className="wb-chip" style={{ background: '#4f8ef7', marginTop: 4 }}>{n} 个任务</div>}
              </div>
            )
          })}
        </div>
      )}
      {calMode === 'month' && (
        <div className="wb-month">
          {monthGrid.map((d) => (
            <div key={d.toISOString()} className={`wb-mday ${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${sameDay(d, now) ? 'today' : ''} ${sameDay(d, picked) ? 'selected' : ''}`} onClick={() => onPick(startOfDay(d))}>
              <div className="wb-mday-date" style={{ fontSize: 12 }}>{d.getDate()}</div>
              {tasks.some((t) => isTaskDueOnDay(t, d)) && <div className="wb-chip" style={{ background: '#4f8ef7', marginTop: 2 }}>•</div>}
            </div>
          ))}
        </div>
      )}

      {/**
        * 日历选中某天 = **同一个** 日期面板（ADR0001 / D15）。
        * 页签（计划/已完成/报告）、计划面板、任务树、报告卡都来自它 ——
        * 原来的两份装配（口径还不一致）已经删掉。
        */}
      <DayPanel
        {...dayPanelProps}
        emptyPlanAction={readOnly ? undefined : (
          <>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{day} 没有计划任务</div>
            <button className="wb-btn primary" style={{ marginTop: 8 }} onClick={() => onStartPlanAISession(day)}>AI 智能排序</button>
          </>
        )}
      />
    </>
  )
}
