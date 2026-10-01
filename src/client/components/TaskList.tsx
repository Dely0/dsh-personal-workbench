/**
 * 任务列表渲染：状态徽章、树形行、多选下拉（从 index.tsx 抽出，行为不变）。
 *
 * v1.16.0（T1/D04）：行内新增进度条与待验收徽标。判定**不在本文件**——
 * 一律来自 `client/taskProgressView.ts#taskProgressView()`（纯模块，有单测），
 * 组件只渲染它给出的结果。`pending === null` 表示服务端没提供待验收投影 →
 * 不显示任何徽标（不推测）。
 */
import type { TaskTreeNode } from '../taskFilterSort.js'
import { fmtTime } from '../format.js'
import { taskProgressView } from '../taskProgressView.js'
import type { Dict, Task } from '../viewTypes.js'
import { TaskProgress } from './TaskProgress.js'

/** 待验收投影（`null` = 服务端不支持，界面不显示徽标）。 */
export type PendingMap = ReadonlyMap<string, { deferred: boolean }> | null

function progressViewFor(task: Task, children: readonly Task[] | undefined, pending: PendingMap): ReturnType<typeof taskProgressView> {
  return taskProgressView({ task, children, pending })
}

export function Badge({ dict, code }: { dict: Dict[]; code: string }): JSX.Element {
  const entry = dict.find((d) => d.code === code)
  const color = String(entry?.config.color ?? '#8a9aa8')
  return <span className="wb-chip" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, fontWeight: 600 }}>{entry?.name ?? code}</span>
}

export function countTaskTree(roots: TaskTreeNode<Task>[]): number {
  return roots.reduce((sum, node) => sum + 1 + countTaskTree(node.children), 0)
}

export function TaskTreeRows({ roots, depth, expanded, toggle, dicts, onOpen, selectedId, contextIds, pending = null, childrenOf }: {
  roots: TaskTreeNode<Task>[]; depth: number; expanded: Set<string>; toggle: (id: string) => void
  dicts: Dict[]; onOpen: (task: Task) => void; selectedId?: string; contextIds?: Set<string>
  /** 待验收投影（一次取全量后传下来，绝不逐行发请求）。`null` = 服务端不支持。 */
  pending?: PendingMap
  /** 取某任务的**直接子任务**（旁证口径）；缺省表示没有旁证数据。 */
  childrenOf?: (taskId: string) => readonly Task[] | undefined
}): JSX.Element {
  return (
    <>
      {roots.map((node) => (
        <div key={node.task.id}>
          <div className={`wb-row ${selectedId === node.task.id ? 'selected' : ''} ${contextIds?.has(node.task.id) ? 'wb-row-context' : ''}`} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => onOpen(node.task)}>
            <button type="button" className="wb-btn" style={{ padding: '2px 6px', border: 'none', flex: 'none' }} onClick={(e) => { e.stopPropagation(); toggle(node.task.id) }}>
              {node.children.length > 0 ? (expanded.has(node.task.id) ? '▼' : '▶') : '·'}
            </button>
            <TaskRow task={node.task} dicts={dicts} onOpen={onOpen} bare pending={pending} childrenOf={childrenOf} />
          </div>
          {node.children.length > 0 && expanded.has(node.task.id) && (
            <TaskTreeRows roots={node.children} depth={depth + 1} expanded={expanded} toggle={toggle} dicts={dicts} onOpen={onOpen} selectedId={selectedId} contextIds={contextIds} pending={pending} childrenOf={childrenOf} />
          )}
        </div>
      ))}
    </>
  )
}

export function TaskRow({ task, dicts, onOpen, selected, bare = false, pending = null, childrenOf }: {
  task: Task; dicts: Dict[]; onOpen: (task: Task) => void; selected?: boolean; bare?: boolean
  pending?: PendingMap
  childrenOf?: (taskId: string) => readonly Task[] | undefined
}): JSX.Element {
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
      {/**
        * 右侧固定列区：优先级 / 状态 / 到期 / 进度。
        *
        * ⚠️ 进度**必须占一格固定宽度**（2026-10-01 用户截图："有进度和 0 进度的任务标签没有对齐，
        * 进度 > 10% 会导致标签被挤压"）。
        * 原因：之前进度是网格**外面**的一个 flex 兄弟（`.wb-progress-compact`，`max-width:46%`），
        * 于是进度条一长就把它左边的 `minmax(88px, 1fr)` 到期列压窄，同一屏里几行的列宽就对不齐。
        * 现在四列全部由网格定宽，进度条在自己的格子里伸缩 —— 行与行永远对齐。
        */}
      <div className="wb-row-meta" style={{ gridTemplateColumns: '46px 56px minmax(88px, 1fr) 96px' }}>
        <Badge dict={dicts.filter((d) => d.kind === 'priority')} code={task.priorityCode} />
        <Badge dict={dicts.filter((d) => d.kind === 'status')} code={task.statusCode} />
        <span className="wb-due">{dueText}</span>
        <TaskProgress compact view={progressViewFor(task, childrenOf?.(task.id), pending)} />
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
