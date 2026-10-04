/**
 * D17 / P4：**今日视图**（原 `src/client/index.tsx` 的 `{view === 'today' && …}` 块，逐字搬迁）。
 *
 * 今日视图 = 日期面板的 **today 实例**（ADR 0001 口径冻结 / D15）。上面两张卡
 * （今日统计 + 今日容量）是今日视图**独有**的，面板本身与日历共用同一份装配。
 *
 * ## 边界（为什么这样切）
 * - 视图**不发 HTTP**（模式 5）：`saveDailyCapacity` / `saveIncludeOverdue` 是**设置域**的写入，
 *   留在装配层，这里只注入 `onCapacityEditStart/Change/Commit/Cancel` 与 `onIncludeOverdueChange`。
 * - `onAddToPlan` 是**日期域**的 `addTaskToPlan`（唯一写入口 `POST /plans/:date/items`），
 *   容量条的"未排入"区与行内「排入今日」必须复用它，不许各写一份。
 * - `dayPanelProps` 是装配层拼好的整份日期面板 props（跨五域），本视图只负责「上面加两张卡 + 空态」，
 *   所以它整体透传而不是在这里重新拼。
 */
import { CapacityRulePanel, capacityAriaLabel } from '../components/CapacityRulePanel.js'
import { DayPanel, type DayPanelProps } from '../components/DayPanel.js'
import { Icon } from '../components/Icon.js'
import type { CapacityLedger } from '../capacity.js'
import type { Bootstrap } from '../viewTypes.js'

export type TodayPaneProps = {
  /** 今日统计（`bootstrap.stats`；首屏未加载时为 `undefined`，渲染 0）。 */
  stats: Bootstrap['stats'] | undefined
  capacity: CapacityLedger
  /** 行内编辑「可投入时长」的临时值（`null` = 只读展示）。 */
  capacityEdit: string | null
  dailyCapacityMinutes: number
  defaultEstimateMinutes: number
  includeOverdue: boolean
  capacityExpanded: boolean
  /** 点击「可投入」数字 → 进入行内编辑（初值由装配层按 settings 填）。 */
  onCapacityEditStart: () => void
  onCapacityEditChange: (value: string) => void
  /** 失焦 / 回车 → 提交（装配层负责校验并落库）。 */
  onCapacityEditCommit: () => void
  /** Esc → 放弃编辑。 */
  onCapacityEditCancel: () => void
  onIncludeOverdueChange: (next: boolean) => void
  onCapacityExpandedChange: (expanded: boolean) => void
  onAddToPlan: (taskId: string, minutes: number) => Promise<void>
  addingTaskId: string | null
  /** 装配层拼好的整份日期面板 props（不含空态，空态是今日视图独有的）。 */
  dayPanelProps: Omit<DayPanelProps, 'emptyPlanAction'>
  onQuickEntry: () => void
  onNewTask: () => void
}

export function TodayPane(props: TodayPaneProps): JSX.Element {
  const {
    stats, capacity, capacityEdit, dailyCapacityMinutes, defaultEstimateMinutes, includeOverdue,
    capacityExpanded, onCapacityEditStart, onCapacityEditChange, onCapacityEditCommit, onCapacityEditCancel,
    onIncludeOverdueChange, onCapacityExpandedChange, onAddToPlan, addingTaskId, dayPanelProps,
    onQuickEntry, onNewTask,
  } = props

  return (
    <>
      <div className="wb-stats wb-stats-sticky">
        <div className="wb-stat"><b>{stats?.overdue ?? 0}</b><span>逾期</span></div>
        <div className="wb-stat"><b>{stats?.todayDue ?? 0}</b><span>今天到期</span></div>
        <div className="wb-stat"><b>{stats?.doing ?? 0}</b><span>进行中</span></div>
        <div className="wb-stat"><b>{stats?.total ?? 0}</b><span>总数</span></div>
      </div>

      {/*
        今日容量（v1.15.1）：把"今天投得进多少时间"及其**算法**显式化。
        这里只负责画：算全在 `computeTodayCapacity`（纯函数），
        口径偏好只在 `settings`（见 CapacityRulePanel 的注释）。
      */}
      <div className="wb-cap">
        <div className="wb-cap-head">
          <h3>今日容量</h3>
          <div className="wb-cap-meta">
            <span>已排 <b>{capacity.planned}</b> min</span>
            <span>
              可投入{' '}
              <b>
                {capacityEdit === null
                  ? <span className="wb-cap-edit" title="点击修改每天可投入时长" onClick={onCapacityEditStart}>{dailyCapacityMinutes}</span>
                  : <input
                      autoFocus
                      type="number"
                      min={30}
                      max={1440}
                      step={30}
                      value={capacityEdit}
                      style={{ width: 64, font: 'inherit', fontVariantNumeric: 'tabular-nums' }}
                      onChange={(e) => onCapacityEditChange(e.target.value)}
                      onBlur={onCapacityEditCommit}
                      onKeyDown={(e) => { if (e.key === 'Enter') onCapacityEditCommit(); if (e.key === 'Escape') onCapacityEditCancel() }}
                    />}
              </b>{' '}
              min
            </span>
            <span>余 <b>{capacity.free}</b> min</span>
          </div>
        </div>
        <div className="wb-cap-bar" role="img" aria-label={capacityAriaLabel(capacity)}>
          {(['p0', 'p1', 'p2', 'p3'] as const).map((code) => capacity.byPriority[code] > 0
            ? <i key={code} className={code} style={{ width: `${(capacity.byPriority[code] / capacity.total) * 100}%` }} title={`${code} · ${capacity.byPriority[code]} min`} />
            : null)}
          {capacity.free > 0 && <i className="free" style={{ width: `${(capacity.free / capacity.total) * 100}%` }} title={`空闲 · ${capacity.free} min`} />}
        </div>
        {/**
          * 容量图例 + 「规则」按钮**同一行**（2026-10-01 用户要求）。
          *
          * ⚠️ `CapacityRulePanel` 的**内联模式**只把那个按钮渲染进这一行；
          * 它的展开体（规则清单 / 账本 / 未排入）由 CSS 拿到**全宽的下方**
          * （`.wb-cap-rule[data-inline=1] { display: contents }`）。
          * 早期版本把整块塞进这一行 —— 一展开，长内容就被挤在这条窄行里，
          * 按钮位置也跟着跳（用户原话："打开、收起规则 的按钮还不在同一个位置"）。
          */}
        <div className="wb-cap-legend" data-cap-expanded={capacityExpanded ? '1' : '0'}>
          <span className="wb-cap-legend-item"><i style={{ background: 'var(--wb-p0)' }} />紧急 <b>{capacity.byPriority.p0}</b></span>
          <span className="wb-cap-legend-item"><i style={{ background: 'var(--wb-p1)' }} />高 <b>{capacity.byPriority.p1}</b></span>
          <span className="wb-cap-legend-item"><i style={{ background: 'var(--wb-p2)' }} />普通 <b>{capacity.byPriority.p2}</b></span>
          <span className="wb-cap-legend-item"><i style={{ background: 'var(--wb-p3)' }} />低 <b>{capacity.byPriority.p3}</b></span>
          <span className="wb-cap-legend-item"><i style={{ background: 'color-mix(in srgb, var(--wb-ok) 36%, transparent)' }} />空闲 <b>{capacity.free}</b></span>
          <CapacityRulePanel
            capacity={capacity}
            dailyCapacityMinutes={dailyCapacityMinutes}
            defaultEstimateMinutes={defaultEstimateMinutes}
            includeOverdue={includeOverdue}
            onIncludeOverdueChange={onIncludeOverdueChange}
            expanded={capacityExpanded}
            onExpandedChange={onCapacityExpandedChange}
            onAddToPlan={onAddToPlan}
            addingTaskId={addingTaskId}
            inlineToggle
          />
        </div>
      </div>
      {/**
        * 今日 = 日期面板的 **today 实例**（ADR0001 口径冻结 / D15）。
        * 上面两张卡（统计 + 容量）是今日视图独有的，面板本身与日历共用一份。
        */}
      <DayPanel
        {...dayPanelProps}
        emptyPlanAction={(
          <div className="wb-empty" style={{ padding: '28px 18px' }}>
            <div style={{ marginBottom: 6, color: 'var(--dsw-alias-state-business-primary, #4f8ef7)' }}><Icon name="today" size={30} /></div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>今天没有需要关注的任务</div>
            <div style={{ fontSize: 12, opacity: .8, marginBottom: 12 }}>可以快速录入一个新任务，或新建一个待办</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="wb-btn primary" onClick={onQuickEntry}>快速录入</button>
              <button className="wb-btn" onClick={onNewTask}>新建任务</button>
            </div>
          </div>
        )}
      />
    </>
  )
}
