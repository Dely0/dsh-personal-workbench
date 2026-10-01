/**
 * 今日/某日计划面板：查看 / 逐项「今日投入结束」与「继续投入」 / 手动编辑排序与计划投入。
 *
 * ## T2/D07 的两条硬规则（用户 2026-09-30 明确确认）
 *
 * 1. **「今日投入结束」≠「任务完成」**：前者只 PATCH 计划项的 `effortDone`，
 *    任务的 `statusCode` / `progressPercent` / `dueAt` / `estimatedMinutes` 全都不变；
 *    后者（完成任务）是另一条独立路径（走既有完成动作与级联确认）。
 * 2. **结束投入后不自动改进度**：只在"进度还是 0"时给一个**非自动**的显式
 *    25/50/75 建议按钮，点了才独立 PATCH 进度；进度写失败不撤销已经成功结束的投入。
 *
 * 组件职责边界：所有写入都通过 props 回调出去（父级走 PATCH/POST 接口），
 * 组件自己不拼整份计划、不做候选过滤（候选来自 `shared/dailyPlanPolicy.ts`，
 * 由父级传 `candidateTasks`）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.js'
import { localDateString, sameDay } from '../format.js'
import { checkPlanMinutes } from '../../shared/dailyPlanPolicy.js'
import type { DailyPlanView, Task } from '../viewTypes.js'

/** 编辑态的一行（`minutesText` 用字符串：用户输入中途的 "9" 不能被夹成 9）。 */
interface EditItem {
  taskId: string
  title: string
  note: string
  minutesText: string
}

export function PlanPanel({
  plan, tasks, title, candidateTasks, canEdit = true, canEndEffort = false,
  onComplete, onDefer, onRefresh, onClear, onSave, onEffortChange, onMinutesChange, onProgressChange,
}: {
  plan: DailyPlanView
  tasks: Task[]
  title?: string
  /**
   * 手动"添加任务"的候选（**必须**由父级用 `shared/dailyPlanPolicy.ts` 的候选全集传入）。
   * 不传时退回"只显示已经在计划里的任务"（旧服务端/旧调用点）。
   */
  candidateTasks?: Array<{ id: string; title: string }>
  canEdit?: boolean
  /** 「今日投入结束」是否可用：只有**当天**的计划项可以被结束（未来只能改分钟）。 */
  canEndEffort?: boolean
  /** 完成整个任务（明确与"今日投入结束"分开：这一步会走既有完成动作与级联确认）。 */
  onComplete: (taskId: string) => Promise<void>
  /** 「推迟截止一天」——只改 dueAt，**不转移计划项**（原「明天」按钮的新名字）。 */
  onDefer: (taskId: string) => Promise<void>
  onRefresh?: () => void
  onClear?: () => void
  onSave?: (items: Array<{ taskId: string; note: string; minutes?: number }>) => Promise<void>
  /** 今日投入结束（true）/ 继续投入（false）。只改当日 effortDone。 */
  onEffortChange?: (taskId: string, next: boolean) => Promise<void>
  /** 修改该日计划投入（分钟）。 */
  onMinutesChange?: (taskId: string, minutes: number) => Promise<void>
  /** 显式写任务进度（0–99）；投入结束后的建议按钮用它，**不自动调用**。 */
  onProgressChange?: (taskId: string, percent: number) => Promise<void>
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [visibleCount, setVisibleCount] = useState(plan.items.length)
  const [editing, setEditing] = useState(false)
  const [editItems, setEditItems] = useState<EditItem[]>([])
  const [saving, setSaving] = useState(false)
  /** 单行错误（就地显示中文原因，不假成功、也不覆盖整块界面）。 */
  const [rowError, setRowError] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [minutesEdit, setMinutesEdit] = useState<{ taskId: string; text: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const total = plan.items.length
  const taskById = (id: string): Task | undefined => tasks.find((t) => t.id === id)
  const runAction = async (taskId: string, action: () => Promise<void>): Promise<void> => {
    if (actingId !== null) return
    setActingId(taskId)
    setRowError(null)
    try { await action() } catch (e) { setRowError(e instanceof Error ? e.message : String(e)) } finally { setActingId(null) }
  }
  const enterEdit = (): void => {
    setEditItems(plan.items.map((item) => ({
      taskId: item.taskId,
      title: item.title,
      note: item.note ?? '',
      minutesText: item.minutes === undefined ? '' : String(item.minutes),
    })))
    setEditError(null)
    setEditing(true)
  }
  const moveItem = (index: number, delta: -1 | 1): void => {
    setEditItems((prev) => {
      const next = [...prev]
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }
  const updateNote = (index: number, note: string): void => {
    setEditItems((prev) => prev.map((item, i) => (i === index ? { ...item, note } : item)))
  }
  const updateMinutesText = (index: number, minutesText: string): void => {
    setEditItems((prev) => prev.map((item, i) => (i === index ? { ...item, minutesText } : item)))
  }
  const removeItem = (index: number): void => {
    setEditItems((prev) => prev.filter((_, i) => i !== index))
  }
  const addTask = (taskId: string): void => {
    const task = taskById(taskId)
    if (task === undefined) return
    setEditItems((prev) => (prev.some((item) => item.taskId === taskId) ? prev : [...prev, { taskId, title: task.title, note: '', minutesText: '' }]))
  }
  const planDay = new Date(`${plan.planDate}T00:00:00`)
  const isToday = plan.planDate === localDateString()
  /**
   * 手动"添加任务"的候选。
   *
   * **不许**在这里内联一份过滤公式（需求 §5.1：AI 排序、手动池、账本未排入区共用
   * `shared/dailyPlanPolicy.ts` 的同一份候选）。父级把候选全集传进来，这里只做
   * "去掉已经在编辑列表里的"这一层展示过滤；`candidateTasks` 缺省时**不提供**候选
   * （宁可给空列表，也不内联第二份公式 —— 那正是本项目最大的 bug 类别）。
   */
  const addCandidates = (candidateTasks ?? []).filter((t) => !editItems.some((item) => item.taskId === t.id))
  const handleSave = async (): Promise<void> => {
    if (onSave === undefined) return
    if ((plan.sourceCode ?? '') !== 'manual' && !window.confirm('保存将覆盖当前 AI 生成计划并标记为手动编辑，确定继续？')) return
    // 计划投入逐条校验（非法**整份拒绝**并指出是第几项，不夹取、不静默丢弃）
    const payload: Array<{ taskId: string; note: string; minutes?: number }> = []
    for (let index = 0; index < editItems.length; index += 1) {
      const item = editItems[index]
      const text = item.minutesText.trim()
      if (text === '') {
        payload.push({ taskId: item.taskId, note: item.note.trim() })
        continue
      }
      const check = checkPlanMinutes(Number(text))
      if (!check.ok) {
        setEditError(`第 ${index + 1} 项（${item.title}）的计划投入非法：${check.reason}`)
        return
      }
      payload.push({ taskId: item.taskId, note: item.note.trim(), minutes: check.value })
    }
    setSaving(true)
    setEditError(null)
    try {
      await onSave(payload)
      setEditing(false)
    } catch (e) {
      // 父级已通过全局错误条展示原因；这里留一份就地可读的原因，保持编辑模式让用户修正。
      setEditError(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }
  const handleRefresh = (): void => {
    if ((plan.sourceCode ?? '') === 'manual' && !window.confirm('当前计划包含手动调整，重新生成会覆盖手动调整。确定继续？')) return
    onRefresh?.()
  }
  const commitMinutes = async (taskId: string): Promise<void> => {
    if (minutesEdit === null || onMinutesChange === undefined) return
    const check = checkPlanMinutes(Number(minutesEdit.text.trim()))
    if (!check.ok) {
      setRowError(check.reason)
      return
    }
    const current = plan.items.find((item) => item.taskId === taskId)?.minutes
    if (current === check.value) { setMinutesEdit(null); return }
    await runAction(taskId, async () => {
      await onMinutesChange(taskId, check.value)
      setMinutesEdit(null)
    })
  }
  const measureOverflow = useCallback(() => {
    const el = scrollRef.current
    if (el === null || expanded) return
    const over = el.scrollHeight > el.clientHeight + 1
    setOverflowing(over)
    if (!over) {
      setVisibleCount(total)
      return
    }
    const containerRect = el.getBoundingClientRect()
    let count = 0
    for (const item of Array.from(el.querySelectorAll<HTMLElement>('.wb-plan-item'))) {
      const rect = item.getBoundingClientRect()
      if (rect.bottom <= containerRect.bottom + 1) count += 1
      else break
    }
    setVisibleCount(Math.min(Math.max(count, 1), total))
  }, [expanded, total])
  useEffect(() => {
    measureOverflow()
    const el = scrollRef.current
    if (el === null) return
    const ro = new ResizeObserver(() => measureOverflow())
    ro.observe(el)
    return () => ro.disconnect()
  }, [measureOverflow, plan.items, plan.summary])
  /**
   * 计划数据无法解析：显式说出来，**不假装是一份空计划**。
   * 容量那边同样会显示"不可计算"（同一个 `readable` 判定）。
   */
  if (plan.readable === false) {
    return (
      <div className="wb-card wb-plan wb-plan-unreadable">
        <h4><Icon name="sparkles" /><span>{title ?? `${plan.planDate} 计划`}</span></h4>
        <div role="alert" style={{ fontSize: 12, lineHeight: 1.7, padding: '6px 2px' }}>
          <b>这份计划的数据无法解析</b>：{plan.diagnostics?.[0] ?? 'items_json 不是合法 JSON 或不是数组'}。<br />
          原数据没有被改动，也不会被自动覆盖。请先备份数据库再手工修复，或显式清空这份计划。
        </div>
        <div className="wb-plan-footer">
          <span>计划不可读</span>
          <span style={{ flex: 1 }} />
          {canEdit && onClear !== undefined && <button className="wb-btn" onClick={() => { if (window.confirm('确定要清空这份无法解析的计划吗？清空后不可恢复。')) onClear() }}><Icon name="trash" />清除</button>}
        </div>
      </div>
    )
  }
  return (
    <div className={`wb-card wb-plan ${expanded ? 'wb-plan-expanded' : ''}`}>
      <h4>
        <Icon name="sparkles" />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title ?? `${plan.planDate} 计划`}</span>
        {editing && <span style={{ fontSize: 11, color: '#d9a03f', border: '1px solid rgba(217,160,63,.4)', borderRadius: 6, padding: '1px 6px' }}>编辑模式</span>}
        <span style={{ flex: 1 }} />
        {!editing && overflowing && (
          <button className="wb-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `展开全部（${total}）`}
          </button>
        )}
      </h4>
      {plan.summary !== '' && !editing && <div style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 6 }}>{plan.summary}</div>}
      {plan.diagnostics !== undefined && plan.diagnostics.length > 0 && (
        <div style={{ fontSize: 12, lineHeight: 1.7, color: '#d9a03f', padding: '2px 2px 6px' }}>
          {plan.diagnostics.map((text) => <div key={text}>⚠️ {text}</div>)}
        </div>
      )}
      {rowError !== null && (
        <div role="alert" style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--wb-danger, #d9534f)', padding: '2px 2px 6px' }}>{rowError}</div>
      )}
      <div ref={scrollRef} className="wb-plan-scroll">
        {editing ? (
          editItems.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '6px 2px' }}>暂无计划项，可从下方添加任务。</div>
          ) : (
            editItems.map((item, index) => {
              const task = taskById(item.taskId)
              const closed = item.taskId !== '' && task !== undefined && (task.statusCode === 'done' || task.statusCode === 'cancelled')
              return (
                <div key={item.taskId} className={`wb-plan-item ${closed ? 'closed' : ''}`}>
                  <span className="wb-plan-num">{index + 1}</span>
                  <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{item.title}</span>
                  <input
                    className="wb-plan-edit-minutes"
                    inputMode="numeric"
                    value={item.minutesText}
                    placeholder="投入分钟"
                    title="今天的计划投入（1–1440 分钟），留空表示不改"
                    onChange={(e) => updateMinutesText(index, e.target.value)}
                  />
                  <input className="wb-plan-edit-note" value={item.note} onChange={(e) => updateNote(index, e.target.value)} placeholder="备注（可选）" />
                  <span className="wb-plan-edit-actions">
                    <button className="wb-btn" disabled={index === 0} onClick={() => moveItem(index, -1)}>↑</button>
                    <button className="wb-btn" disabled={index === editItems.length - 1} onClick={() => moveItem(index, 1)}>↓</button>
                    <button className="wb-btn" onClick={() => removeItem(index)}>移除</button>
                  </span>
                </div>
              )
            })
          )
        ) : (
          plan.items.map((item, index) => {
            const task = taskById(item.taskId)
            // 任务状态优先用服务端给的 taskStatusCode（任务已删除时列表里查不到，但计划行必须留着）
            const statusCode = item.taskStatusCode ?? task?.statusCode ?? 'missing'
            const missing = statusCode === 'missing'
            const closed = statusCode === 'done' || statusCode === 'cancelled' || statusCode === 'archived'
            const effortDone = item.effortDone === true
            const progress = task?.progressPercent ?? 0
            const canAct = canEdit && !missing && !closed
            return (
              <div key={item.taskId} className={`wb-plan-item ${closed || missing ? 'closed' : ''} ${effortDone ? 'effort-done' : ''}`}>
                <span className="wb-plan-num">{index + 1}</span>
                <b>{item.title}</b>
                {/* 计划投入：快照值；点一下可改（改的是这一天的投入，不改任务估时） */}
                {onMinutesChange !== undefined && canAct
                  ? (minutesEdit !== null && minutesEdit.taskId === item.taskId
                    ? <input
                        className="wb-plan-minutes-input"
                        autoFocus
                        inputMode="numeric"
                        value={minutesEdit.text}
                        onChange={(e) => setMinutesEdit({ taskId: item.taskId, text: e.target.value })}
                        onBlur={() => void commitMinutes(item.taskId)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitMinutes(item.taskId)
                          if (e.key === 'Escape') setMinutesEdit(null)
                        }}
                      />
                    : <button
                        type="button"
                        className="wb-plan-minutes"
                        title="今天的计划投入（点击修改）"
                        disabled={actingId !== null}
                        onClick={() => setMinutesEdit({ taskId: item.taskId, text: item.minutes === undefined ? '' : String(item.minutes) })}
                      >{item.minutes === undefined ? '投入未记录' : `投入 ${item.minutes} min`}</button>)
                  : <span className="wb-plan-minutes-static">{item.minutes === undefined ? '投入未记录' : `投入 ${item.minutes} min`}</span>}
                {item.note !== '' && <span className="wb-plan-note">— {item.note}</span>}
                {missing && <span className="wb-plan-note">任务不存在（保留为历史记录）</span>}
                {closed && !missing && <span className="wb-plan-note">{statusCode === 'done' ? '任务已完成' : statusCode === 'cancelled' ? '任务已取消' : '任务已归档'}</span>}
                {effortDone && <span className="wb-plan-effort-done">今日投入已结束</span>}
                {canAct && (
                  <span className="wb-plan-item-actions">
                    {/* 主动作：今日投入结束 / 继续投入（只改当日 effortDone） */}
                    {onEffortChange !== undefined && canEndEffort && (
                      <button
                        type="button"
                        className={`wb-plan-act effort ${effortDone ? 'on' : ''}`}
                        disabled={actingId !== null}
                        title={effortDone ? '恢复为「今日还需投入」（不改任务状态/进度/截止）' : '只结束今天的投入：任务仍是进行中，进度与截止都不变'}
                        onClick={() => void runAction(item.taskId, () => onEffortChange(item.taskId, !effortDone))}
                      >{effortDone ? '继续投入' : '今日投入结束'}</button>
                    )}
                    {/* 完成任务：与上面完全不同的一件事，走既有完成动作与级联确认 */}
                    <button
                      type="button"
                      className="wb-plan-act done"
                      disabled={actingId !== null}
                      title="把整个任务标记为已完成（未完成子任务会按既有规则级联完成）"
                      onClick={() => void runAction(item.taskId, () => onComplete(item.taskId))}
                    >完成任务</button>
                    {/* 原「明天」按钮改名：它只改截止时间，**不转移计划项** */}
                    <button
                      type="button"
                      className="wb-plan-act defer"
                      disabled={actingId !== null}
                      title="只把任务的截止时间推后一天；今天的计划项保持不动"
                      onClick={() => void runAction(item.taskId, () => onDefer(item.taskId))}
                    >推迟截止一天</button>
                  </span>
                )}
                {/* 结束投入后的**非自动**进度建议：只有进度还是 0 时才出现，且不默认勾选 */}
                {canAct && effortDone && progress === 0 && onProgressChange !== undefined && (
                  <span className="wb-plan-progress-hint">
                    顺便更新任务进度？
                    {[25, 50, 75].map((percent) => (
                      <button
                        key={percent}
                        type="button"
                        className="wb-btn"
                        disabled={actingId !== null}
                        onClick={() => void runAction(item.taskId, () => onProgressChange(item.taskId, percent))}
                      >{percent}%</button>
                    ))}
                  </span>
                )}
              </div>
            )
          })
        )}
      </div>
      <div className="wb-plan-footer">
        {editing ? (
          <>
            <select className="wb-plan-add" defaultValue="" onChange={(e) => { const v = e.target.value; if (v !== '') { addTask(v); e.target.value = '' } }}>
              <option value="">+ 添加任务…</option>
              {addCandidates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <span style={{ flex: 1 }} />
            <button className="wb-btn" disabled={saving} onClick={() => setEditing(false)}>取消</button>
            <button className="wb-btn primary" disabled={saving || editItems.length === 0} onClick={() => void handleSave()}>保存</button>
          </>
        ) : (
          <>
            <span>
              {overflowing ? `共 ${total} 项 · 默认展示前 ${visibleCount} 项，滚动/展开可查看全部` : `共 ${total} 项 · 已全部展示`}
              {' · '}已排投入 <b>{plan.items.reduce((sum, item) => sum + (typeof item.minutes === 'number' ? item.minutes : 0), 0)}</b> min
              {' · '}已结束 <b>{plan.items.filter((item) => item.effortDone === true).reduce((sum, item) => sum + (typeof item.minutes === 'number' ? item.minutes : 0), 0)}</b> min
              {' · '}未结束 <b>{plan.items.filter((item) => item.effortDone !== true).reduce((sum, item) => sum + (typeof item.minutes === 'number' ? item.minutes : 0), 0)}</b> min
              <span title="计划投入不是实际工时；这里也没有计时器">?</span>
            </span>
            <span style={{ flex: 1 }} />
            {canEdit && onSave !== undefined && <button className="wb-btn" onClick={enterEdit}><Icon name="edit" />编辑</button>}
            {canEdit && onRefresh !== undefined && <button className="wb-btn" onClick={handleRefresh}><Icon name="refresh" />重新生成</button>}
            {canEdit && onClear !== undefined && <button className="wb-btn" onClick={() => { if (window.confirm('确定要清除该日计划吗？清除后不可恢复。')) onClear() }}><Icon name="trash" />清除</button>}
          </>
        )}
      </div>
    </div>
  )
}
