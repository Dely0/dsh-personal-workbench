/**
 * 任务列表渲染：状态徽章、树形行、多选下拉（从 index.tsx 抽出，行为不变）。
 */
import type { TaskTreeNode } from '../taskFilterSort.js'
import { fmtTime } from '../format.js'
import type { Dict, Task } from '../viewTypes.js'

export function Badge({ dict, code }: { dict: Dict[]; code: string }): JSX.Element {
  const entry = dict.find((d) => d.code === code)
  const color = String(entry?.config.color ?? '#8a9aa8')
  return <span className="wb-chip" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, fontWeight: 600 }}>{entry?.name ?? code}</span>
}

export function countTaskTree(roots: TaskTreeNode<Task>[]): number {
  return roots.reduce((sum, node) => sum + 1 + countTaskTree(node.children), 0)
}

export function TaskTreeRows({ roots, depth, expanded, toggle, dicts, onOpen, selectedId, contextIds }: {
  roots: TaskTreeNode<Task>[]; depth: number; expanded: Set<string>; toggle: (id: string) => void
  dicts: Dict[]; onOpen: (task: Task) => void; selectedId?: string; contextIds?: Set<string>
}): JSX.Element {
  return (
    <>
      {roots.map((node) => (
        <div key={node.task.id}>
          <div className={`wb-row ${selectedId === node.task.id ? 'selected' : ''} ${contextIds?.has(node.task.id) ? 'wb-row-context' : ''}`} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => onOpen(node.task)}>
            <button type="button" className="wb-btn" style={{ padding: '2px 6px', border: 'none', flex: 'none' }} onClick={(e) => { e.stopPropagation(); toggle(node.task.id) }}>
              {node.children.length > 0 ? (expanded.has(node.task.id) ? '▼' : '▶') : '·'}
            </button>
            <TaskRow task={node.task} dicts={dicts} onOpen={onOpen} bare />
          </div>
          {node.children.length > 0 && expanded.has(node.task.id) && (
            <TaskTreeRows roots={node.children} depth={depth + 1} expanded={expanded} toggle={toggle} dicts={dicts} onOpen={onOpen} selectedId={selectedId} contextIds={contextIds} />
          )}
        </div>
      ))}
    </>
  )
}

export function TaskRow({ task, dicts, onOpen, selected, bare = false }: { task: Task; dicts: Dict[]; onOpen: (task: Task) => void; selected?: boolean; bare?: boolean }): JSX.Element {
  const due = task.effectiveDueAt === null ? null : new Date(task.effectiveDueAt)
  const now = new Date()
  const dueText = task.statusCode === 'done'
    ? task.effectiveDueAt !== null
      ? fmtTime(task.effectiveDueAt)
      : task.completedAt !== null ? fmtTime(task.completedAt) : ''
    : task.statusCode === 'cancelled'
      ? '已取消'
      : due === null
        ? '无截止'
        : Number.isNaN(due.getTime())
          ? fmtTime(task.effectiveDueAt!)
          : due.toDateString() === now.toDateString()
            ? `今天 ${fmtTime(task.effectiveDueAt!)}`
            : due.getTime() < now.getTime()
              ? `逾期 ${fmtTime(task.effectiveDueAt!)}`
              : fmtTime(task.effectiveDueAt!)
  const content = (
    <>
      <div className="wb-row-title" style={{ fontWeight: 600 }}>{task.title}</div>
      <div className="wb-row-meta">
        <Badge dict={dicts.filter((d) => d.kind === 'type')} code={task.typeCode} />
        <Badge dict={dicts.filter((d) => d.kind === 'priority')} code={task.priorityCode} />
        <Badge dict={dicts.filter((d) => d.kind === 'status')} code={task.statusCode} />
        <span className="wb-due">{dueText}</span>
      </div>
    </>
  )
  if (bare) return <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>{content}</div>
  const closed = task.statusCode === 'done' || task.statusCode === 'cancelled'
  return (
    <div className={`wb-row ${selected === true ? 'selected' : ''} ${closed ? 'done' : ''}`} style={{ flex: 1, minWidth: 0 }} onClick={() => onOpen(task)}>
      {content}
    </div>
  )
}

export function MultiSelectDropdown({ label, options, selected, open, onToggle, onClose, onChange, alignRight = false }: {
  label: string
  options: Dict[]
  selected: string[]
  open: boolean
  onToggle: () => void
  onClose: () => void
  onChange: (codes: string[]) => void
  alignRight?: boolean
}): JSX.Element {
  const toggleCode = (code: string): void => {
    onChange(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code])
  }
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="wb-btn" onClick={onToggle} style={{ position: 'relative', zIndex: 25, flex: '0 0 auto', minWidth: 118, maxWidth: 180, overflow: 'hidden' }}>
        <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
        {selected.length === 0 ? (
          <span style={{ color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }}>全部</span>
        ) : (
          <span style={{ color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }}>已选 {selected.length} 项</span>
        )}
        <span style={{ flex: 'none' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={onClose} />
          <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: alignRight ? undefined : 0, right: alignRight ? 0 : undefined, zIndex: 30, minWidth: 240, maxHeight: 320, overflowY: 'auto', background: 'var(--dsw-alias-bg-layer-2, #1c1c1f)', border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.22))', borderRadius: 10, padding: 6, boxShadow: '0 12px 32px rgba(0,0,0,.45)' }}>
            {selected.length > 0 && (
              <div style={{ padding: '6px 8px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))', marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 }}>已选（{selected.length}）</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {selected.map((code) => <Badge key={code} dict={options} code={code} />)}
                </div>
              </div>
            )}
            {options.map((d) => {
              const color = String(d.config.color ?? '#8a9aa8')
              const checked = selected.includes(d.code)
              return (
                <label key={d.code} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${checked ? color : 'transparent'}`, background: checked ? `color-mix(in srgb, ${color} 12%, transparent)` : 'transparent' }}>
                  <input type="checkbox" checked={checked} onChange={() => toggleCode(d.code)} />
                  <span style={{ color, fontWeight: 600, fontSize: 12.5 }}>{d.name}</span>
                </label>
              )
            })}
            {options.length === 0 && <div style={{ padding: '6px 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>无选项</div>}
          </div>
        </>
      )}
    </div>
  )
}
