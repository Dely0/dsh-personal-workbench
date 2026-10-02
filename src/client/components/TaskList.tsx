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

export function TaskTreeRows({ roots, depth, expanded, toggle, dicts, onOpen, selectedId, contextIds, pending = null, childrenOf, sourceLabelOf, onSchedule, scheduledIds, schedulingTaskId }: {
  roots: TaskTreeNode<Task>[]; depth: number; expanded: Set<string>; toggle: (id: string) => void
  dicts: Dict[]; onOpen: (task: Task) => void; selectedId?: string; contextIds?: Set<string>
  /** 待验收投影（一次取全量后传下来，绝不逐行发请求）。`null` = 服务端不支持。 */
  pending?: PendingMap
  /** 取某任务的**直接子任务**（旁证口径）；缺省表示没有旁证数据。 */
  childrenOf?: (taskId: string) => readonly Task[] | undefined
  /**
   * 行来源标签（批次2 D15）：日期面板的树要逐条标出这条任务为什么在这一天
   *（到期 / 计划 / 进行中，可多标）。判定在 `shared/dailyPlanPolicy.ts`，
   * 这里只把父级给的字符串画成一个徽标 —— 组件不自己判。
   */
  sourceLabelOf?: (taskId: string) => string | null
  /**
   * 行内「排入今日」（2026-10-02）：只由日期面板的**逾期 / 未排期**页签在**今天**这一实例上传入。
   * 组件不判"该不该显示" —— 缺省（undefined）就是不渲染，判定在父级。
   */
  onSchedule?: (taskId: string) => void
  /** 已排进这一天的任务：按钮不渲染（点了只会得到"已经在计划里"，那种假入口是噪音）。 */
  scheduledIds?: Set<string>
  /** 正在排入的任务 id（禁用重复点击）。 */
  schedulingTaskId?: string | null
}): JSX.Element {
  return (
    <>
      {roots.map((node) => (
        <div key={node.task.id}>
          <div className={`wb-row ${selectedId === node.task.id ? 'selected' : ''} ${contextIds?.has(node.task.id) ? 'wb-row-context' : ''}`} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => onOpen(node.task)}>
            <button type="button" className="wb-btn" style={{ padding: '2px 6px', border: 'none', flex: 'none' }} onClick={(e) => { e.stopPropagation(); toggle(node.task.id) }}>
              {node.children.length > 0 ? (expanded.has(node.task.id) ? '▼' : '▶') : '·'}
            </button>
            <TaskRow
              task={node.task}
              dicts={dicts}
              onOpen={onOpen}
              bare
              pending={pending}
              childrenOf={childrenOf}
              sourceLabel={sourceLabelOf?.(node.task.id) ?? null}
              onSchedule={onSchedule === undefined ? undefined : () => onSchedule(node.task.id)}
              alreadyScheduled={scheduledIds?.has(node.task.id) === true}
              scheduling={schedulingTaskId === node.task.id}
            />
          </div>
          {node.children.length > 0 && expanded.has(node.task.id) && (
            <TaskTreeRows roots={node.children} depth={depth + 1} expanded={expanded} toggle={toggle} dicts={dicts} onOpen={onOpen} selectedId={selectedId} contextIds={contextIds} pending={pending} childrenOf={childrenOf} sourceLabelOf={sourceLabelOf} onSchedule={onSchedule} scheduledIds={scheduledIds} schedulingTaskId={schedulingTaskId} />
          )}
        </div>
      ))}
    </>
  )
}

export function TaskRow({ task, dicts, onOpen, selected, bare = false, pending = null, childrenOf, sourceLabel = null, onSchedule, alreadyScheduled = false, scheduling = false }: {
  task: Task; dicts: Dict[]; onOpen: (task: Task) => void; selected?: boolean; bare?: boolean
  pending?: PendingMap
  childrenOf?: (taskId: string) => readonly Task[] | undefined
  /** 该行在这一天命中的来源（已由父级拼好，可多来源如「到期 · 计划」）。 */
  sourceLabel?: string | null
  /** 行内「排入今日」动作；缺省 = 不渲染按钮（是否显示由父级决定）。 */
  onSchedule?: () => void
  /** 已经排进这一天（父级告知）→ 不渲染按钮。 */
  alreadyScheduled?: boolean
  /** 正在排入 → 按钮禁用且文案变成「排入中…」（不许假成功、不许重复提交）。 */
  scheduling?: boolean
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
      <div className="wb-row-title" style={{ fontWeight: 600 }}>
        {/**
          * ⚠️ 标题文字**必须有自己的节点**（`.wb-row-title-text`），不要把徽标塞进标题的文字流里。
          *
          * 2026-10-02 实测踩到：批次2 的「逐条标来源」把 `<span class="wb-src">` 直接追加在标题文字后面，
          * `.wb-row-title` 的 `textContent` 于是变成「标题 + 徽标」—— 所有拿它当"标题"做**严格相等**比较的
          * 套件/脚本全部找不到行（`progress` 套件 10 条断言级联失败，看着像"进度 UI 没了"，
          * 实际是定位点被徽标污染）。给标题一个稳定节点，比让每个消费者各自去猜文本构成可靠。
          */}
        <span className="wb-row-title-text">{task.title}</span>
        {sourceLabel !== null && sourceLabel !== '' && (
          <span className="wb-src" data-task-source={sourceLabel} title={`为什么在这一天：${sourceLabel}`}>{sourceLabel}</span>
        )}
      </div>
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
  /**
   * 行内「排入今日」（2026-10-02）：只在日期面板的**逾期 / 未排期**页签、且**今天**这一实例上出现
   *（父级通过 `onSchedule` 是否存在来表达"这里该不该有它"）。
   *
   * 三条纪律：
   * - `alreadyScheduled` → **不渲染**（点了只会得到"已经在计划里"，那种假入口是噪音）；
   * - `scheduling` → 禁用 + 文案「排入中…」（不许重复提交、不许假成功）；
   * - 点击必须 `stopPropagation`（否则会连带打开右侧任务详情）。
   */
  const scheduleAction = onSchedule !== undefined && !alreadyScheduled ? (
    <button
      type="button"
      className="wb-btn wb-schedule"
      disabled={scheduling}
      title="排进今天的计划（投入分钟按任务的预计耗时；没填则按设置里的默认投入）"
      onClick={(event) => { event.stopPropagation(); onSchedule() }}
    >{scheduling ? '排入中…' : '排入今日'}</button>
  ) : null
  if (bare) return <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>{content}{scheduleAction}</div>
  const closed = task.statusCode === 'done' || task.statusCode === 'cancelled'
  return (
    <div className={`wb-row ${selected === true ? 'selected' : ''} ${closed ? 'done' : ''}`} style={{ flex: 1, minWidth: 0 }} onClick={() => onOpen(task)}>
      {content}{scheduleAction}
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
