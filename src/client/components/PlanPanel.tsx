/**
 * 今日计划面板：查看 / 逐项完成与顺延 / 手动编辑排序（从 index.tsx 抽出，行为不变）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.js'
import { localDateString, sameDay } from '../format.js'
import type { DailyPlanView, Task } from '../viewTypes.js'

export function PlanPanel({ plan, tasks, title, onComplete, onDefer, onRefresh, onClear, onSave, canEdit = true }: {
  plan: DailyPlanView
  tasks: Task[]
  title?: string
  onComplete: (taskId: string) => Promise<void>
  onDefer: (taskId: string) => Promise<void>
  onRefresh?: () => void
  onClear?: () => void
  onSave?: (items: Array<{ taskId: string; note: string }>) => Promise<void>
  canEdit?: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [visibleCount, setVisibleCount] = useState(plan.items.length)
  const [editing, setEditing] = useState(false)
  const [editItems, setEditItems] = useState<Array<{ taskId: string; title: string; note: string }>>([])
  const [saving, setSaving] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const total = plan.items.length
  const taskById = (id: string): Task | undefined => tasks.find((t) => t.id === id)
  const runAction = async (taskId: string, action: () => Promise<void>): Promise<void> => {
    if (actingId !== null) return
    setActingId(taskId)
    try { await action() } finally { setActingId(null) }
  }
  const enterEdit = (): void => {
    setEditItems(plan.items.map((item) => ({ taskId: item.taskId, title: item.title, note: item.note ?? '' })))
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
  const removeItem = (index: number): void => {
    setEditItems((prev) => prev.filter((_, i) => i !== index))
  }
  const addTask = (taskId: string): void => {
    const task = taskById(taskId)
    if (task === undefined) return
    setEditItems((prev) => (prev.some((item) => item.taskId === taskId) ? prev : [...prev, { taskId, title: task.title, note: '' }]))
  }
  const planDay = new Date(`${plan.planDate}T00:00:00`)
  const isToday = plan.planDate === localDateString()
  const candidateTasks = tasks.filter((t) =>
    t.statusCode !== 'done' && t.statusCode !== 'cancelled' &&
    !editItems.some((item) => item.taskId === t.id) &&
    ((t.effectiveDueAt !== null && sameDay(new Date(t.effectiveDueAt), planDay)) || (isToday && t.effectiveDueAt === null))
  )
  const handleSave = async (): Promise<void> => {
    if (onSave === undefined) return
    if ((plan.sourceCode ?? '') !== 'manual' && !window.confirm('保存将覆盖当前 AI 生成计划并标记为手动编辑，确定继续？')) return
    setSaving(true)
    try {
      await onSave(editItems.map((item, index) => ({ taskId: item.taskId, note: item.note.trim() })))
      setEditing(false)
    } catch {
      // 父级 savePlan 已通过全局错误条展示原因；保持编辑模式让用户修正后重试。
    } finally { setSaving(false) }
  }
  const handleRefresh = (): void => {
    if ((plan.sourceCode ?? '') === 'manual' && !window.confirm('当前计划包含手动调整，重新生成会覆盖手动调整。确定继续？')) return
    onRefresh?.()
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
      <div ref={scrollRef} className="wb-plan-scroll">
        {editing ? (
          editItems.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '6px 2px' }}>暂无计划项，可从下方添加任务。</div>
          ) : (
            editItems.map((item, index) => {
              const task = taskById(item.taskId)
              const closed = task !== undefined && (task.statusCode === 'done' || task.statusCode === 'cancelled')
              return (
                <div key={item.taskId} className={`wb-plan-item ${closed ? 'closed' : ''}`}>
                  <span className="wb-plan-num">{index + 1}</span>
                  <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{item.title}</span>
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
            const closed = task !== undefined && (task.statusCode === 'done' || task.statusCode === 'cancelled')
            return (
              <div key={item.taskId} className={`wb-plan-item ${closed ? 'closed' : ''}`}>
                <span className="wb-plan-num">{index + 1}</span>
                <b>{item.title}</b>
                {item.note !== '' && <span className="wb-plan-note">— {item.note}</span>}
                {task !== undefined && !closed && (
                  <span className="wb-plan-item-actions">
                    <button type="button" className="wb-plan-act done" disabled={actingId !== null} onClick={() => void runAction(item.taskId, () => onComplete(item.taskId))}>完成</button>
                    <button type="button" className="wb-plan-act defer" disabled={actingId !== null} onClick={() => void runAction(item.taskId, () => onDefer(item.taskId))}>明天</button>
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
              {candidateTasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <span style={{ flex: 1 }} />
            <button className="wb-btn" disabled={saving} onClick={() => setEditing(false)}>取消</button>
            <button className="wb-btn primary" disabled={saving || editItems.length === 0} onClick={() => void handleSave()}>保存</button>
          </>
        ) : (
          <>
            <span>{overflowing ? `共 ${total} 项 · 默认展示前 ${visibleCount} 项，滚动/展开可查看全部` : `共 ${total} 项 · 已全部展示`}</span>
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
