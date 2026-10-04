/**
 * D17 / P3-2：任务详情区（右侧栏）—— 描述 / 子任务 / 会话 / 记录四个页签与全部行内动作。
 *
 * 拆分前它内联在 `index.tsx` 的 `wb-detail` 里（第 3042–3374 行，约 330 行），是主组件里最大的一块 JSX。
 * 现在本文件只做**展示**：
 * - 详情自身的状态来自 `hooks/useTaskDetailModel.ts`（6 个详情 state 的唯一 owner）；
 * - 跨域数据/动作（任务数据、任务列表、知识、AI 会话、设置、字典）由入口按 props 注入 ——
 *   本文件不发请求、不持有 state、不 import 入口（设计 §3 的依赖单向向下）。
 * - `selected === null` 的空态由本组件自己判；入口只保留 ideas / knowledge / 本组件三路分派。
 *
 * ⚠️ 搬迁纪律：从 `<div className="wb-card">` 到变更历史结尾的大段 JSX **逐字保留**
 * （注释、文案、`data-*`、DOM 层级与交互顺序都没动），只做了 6 处**等价**写法替换：
 * ① 会话行的 `aiSessionUsable(runtime, sid)`、复盘行的 `aiSessionUsable(runtime, existing.session_id)`
 *    → `isSessionUsable(id)`（入口那个模块级判定按设计 §5 作为**类型化回调**注入）；
 * ② 「添加已有对话」与「取消」两处的两连 setState → 域 hook 的 `openSessionPicker()` /
 *    `closeSessionPicker()`（同一语义原先在入口与面板各写了一份，属 §0 去重）；
 * ③ 「恢复任务」与「新建子任务」两处内联的 `void api(...)` → `onRestoreTask(taskId)` /
 *    `onCreateSubtask(form, parent)` 两个类型化回调（设计 §3 明令 `views/` 不做 api 请求；
 *    请求本体与 payload 拼接原样搬到装配层，一个字没改）。
 * 不多包一层 DOM：返回值仍是 Fragment，与拆分前的 `<>…</>` 一致。
 */
import { Icon } from '../components/Icon.js'
import { Badge, type PendingMap } from '../components/TaskList.js'
import { TaskProgress } from '../components/TaskProgress.js'
import { MarkdownText } from '../components/MarkdownText.js'
import { taskProgressView } from '../taskProgressView.js'
import { eventIcon, eventLabel, fmtTime, roleLabel, shortId, toLocalInput } from '../format.js'
import type { Dict, DshSessionListState, DshSessionSummary, KnowledgeEntry, Task, TaskDetail } from '../viewTypes.js'
import type { WorkbenchSettings } from '../../shared/contracts.js'
import type { StartAISessionFn, UseKnowledgeResult } from '../hooks/useKnowledge.js'
import type { UseTaskDetailModelResult } from '../hooks/useTaskDetailModel.js'
import type { TaskEditDraft, WorkbenchView } from '../app/contracts.js'

export type TaskDetailPaneProps = {
  /** 当前选中的任务（含 children/sessions/reminders/events/reviews）；`null` 时渲染空态。 */
  selected: TaskDetail | null
  /** 任务详情域模型：页签 / 会话选择器 / 事件折叠（唯一 owner = `hooks/useTaskDetailModel.ts`）。 */
  detail: UseTaskDetailModelResult
  /** 字典全量（「重复」那一行用 `dicts.find(...)` 直接找，保持拆分前写法）。 */
  dicts: Dict[]
  dictOf: (kind: string) => Dict[]
  /** 列表那次共用查询折出的待验收投影（避免详情页 N+1；详情页以自身 `pendingCompletion` 为准）。 */
  pendingMap: PendingMap
  settings: WorkbenchSettings
  /** 该任务的关联知识（复盘卡「已沉淀」判据用；不是知识域列表）。 */
  taskKnowledge: KnowledgeEntry[]
  /** 知识域模型：复盘卡里「沉淀为经验 / 打开知识条目」要写知识域的草稿与选中。 */
  knowledge: UseKnowledgeResult
  /** AI 会话是否在跑（复盘/子任务按钮的 disabled）。 */
  busy: boolean
  /** 编辑弹窗是否打开（表单域 `editDraft !== null` 折出的**布尔**；草稿本体不再进视图）。 */
  editing: boolean
  /** 打开编辑弹窗：整份草稿由本视图按当前任务折出（原 `setEditDraft({...})` 的调用点）。 */
  onOpenEdit: (draft: TaskEditDraft) => void
  /** 子任务表单挂在哪个任务上（`null` = 收起）；值由入口的表单域持有。 */
  subtaskParent: Task | null
  /** 「手动添加子任务」：开表单（**跨域**，写入表单域；页签由本视图自己切）。 */
  onAddSubtask: (task: Task) => void
  /** 子任务表单「取消」。 */
  onCancelSubtask: () => void
  startAISession: StartAISessionFn
  setNotice: (message: string) => void
  patchTask: (id: string, patch: Record<string, unknown>) => Promise<void>
  saveProgress: (taskId: string, percent: number) => Promise<void>
  completeTaskFromProgress: (taskId: string) => Promise<void>
  archiveSelectedTask: () => void
  openTask: (task: Task) => void
  /** 恢复归档任务（`POST /tasks/:id/restore`）：请求与后续刷新都在装配层 —— 本文件不发 HTTP（设计 §3）。 */
  onRestoreTask: (taskId: string) => void
  /** 新建子任务：视图只负责阻止默认提交与收 `FormData`，校验与 payload 拼接在装配层（逐字保留）。 */
  onCreateSubtask: (form: FormData, parent: Task) => void
  /** 跳到知识视图（复盘卡沉淀之后）。 */
  setView: (view: WorkbenchView) => void
  /** 历史会话可用性判定（入口模块级 `aiSessionUsable` 的类型化回调形态，见文件头 ①）。 */
  isSessionUsable: (sessionId: string) => boolean
  /** 会话页签：候选会话 + 会话元信息快照 + 已关联集合 + 关联/打开动作。 */
  sessionCandidates: DshSessionSummary[]
  sessionListSnapshot: DshSessionListState
  linkedSessionIds: Set<string>
  linkExistingSession: (sessionId: string) => Promise<void>
  openSessionInPanel: (sessionId: string) => void
  /** 记录页签的提醒动作。 */
  addTaskReminder: (offsetMinutes: number) => Promise<void>
  resetReminderState: (reminderId: string) => Promise<void>
}

export function TaskDetailPane({
  selected, detail, dicts, dictOf, pendingMap, settings, taskKnowledge, knowledge, busy,
  editing, onOpenEdit, subtaskParent, onAddSubtask, onCancelSubtask, startAISession, setNotice, patchTask,
  saveProgress, completeTaskFromProgress, archiveSelectedTask, openTask, onRestoreTask, onCreateSubtask,
  setView, isSessionUsable, sessionCandidates, sessionListSnapshot, linkedSessionIds, linkExistingSession,
  openSessionInPanel, addTaskReminder, resetReminderState,
}: TaskDetailPaneProps): JSX.Element {
  const {
    detailTab, sessionPickerOpen, sessionPickerRole, sessionPickerQuery, sessionPickerBusy, eventsExpanded,
  } = detail
  const {
    setDetailTab, setSessionPickerRole, setSessionPickerQuery, setEventsExpanded, openSessionPicker, closeSessionPicker,
  } = detail.actions

  if (selected === null) {
    return (
  <div className="wb-empty">← 从左侧选择一个任务查看详情<br /><span style={{ fontSize: 12 }}>AI 澄清/咨询/拆解会跳转到官方会话区，完成后回这里确认草稿</span></div>
    )
  }

  return (
  <>
  <div className="wb-card">
    {(
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h4 style={{ flex: 1, margin: 0 }}>{selected.task.title}</h4>
          {/**
            * 「归档」移到详情页**右上角**（2026-10-01 用户要求）。
            * 原来它在下面那排 AI 动作按钮的最右边，一个低频且不可逆的动作
            * 混在高频动作里，还把那一行挤到换行（用户截图："归档掉到第二行"）。
            * 判定与确认弹窗一个字没改，只是位置和视觉权重变了：
            * 这里是 secondary + 危险色，与「编辑」并列。
            */}
          {!selected.task.archived && (
            <button
              className="wb-btn"
              style={{ color: '#e0645c', borderColor: 'color-mix(in srgb, #e0645c 45%, transparent)' }}
              title="归档后任务会从工作台列表隐藏（其子任务也会一并从列表隐藏），可在列表页「查看归档」中恢复"
              onClick={archiveSelectedTask}
            ><Icon name="archive" />归档</button>
          )}
          {!selected.task.archived && <button className="wb-btn" onClick={() => onOpenEdit({ title: selected.task.title, description: selected.task.description, typeCode: selected.task.typeCode, priorityCode: selected.task.priorityCode, statusCode: selected.task.statusCode, aiPolicyCode: selected.task.aiPolicyCode, dueLocal: toLocalInput(selected.task.dueAt), workspacePath: selected.task.workspacePath ?? '', recurrenceCode: selected.task.recurrenceCode ?? 'none', parentId: selected.task.parentId ?? '', estimatedMinutes: selected.task.estimatedMinutes === null ? '' : String(selected.task.estimatedMinutes), allDay: selected.task.allDay })}><Icon name="edit" />编辑</button>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
          <Badge dict={dictOf('type')} code={selected.task.typeCode} />
          <Badge dict={dictOf('priority')} code={selected.task.priorityCode} />
          <Badge dict={dictOf('status')} code={selected.task.statusCode} />
        </div>
        {!selected.task.archived && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '8px 0 4px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>状态
              <select style={{ background: 'var(--dsw-alias-bg-base,#17171a)', color: 'inherit', fontWeight: 600, border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.2))', borderRadius: 8, padding: '6px 10px' }} value={selected.task.statusCode} onChange={(e) => void patchTask(selected.task.id, { statusCode: e.target.value })}>
                {dictOf('status').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>AI 策略
              <select style={{ background: 'var(--dsw-alias-bg-base,#17171a)', color: 'inherit', fontWeight: 600, border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.2))', borderRadius: 8, padding: '6px 10px' }} value={selected.task.aiPolicyCode} onChange={(e) => void patchTask(selected.task.id, { aiPolicyCode: e.target.value })}>
                {dictOf('ai_policy').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
              </select>
            </label>
          </div>
        )}
        <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>截止：{selected.task.effectiveDueAt === null ? '无' : fmtTime(selected.task.effectiveDueAt)}{selected.task.dueAt === null && selected.task.effectiveDueAt !== null ? '（继承父任务）' : ''}</div>
        {/* 预计耗时（v1.15.1）：直接决定今日容量的「已排」，所以未填时必须说清"按默认算"。 */}
        <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>预计耗时：{selected.task.estimatedMinutes === null ? `默认 ${settings.defaultEstimateMinutes} 分钟（未单独设置）` : `${selected.task.estimatedMinutes} 分钟`}{selected.task.allDay ? ' · 全天' : ''}</div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>AI 工作区：{selected.task.effectiveWorkspacePath ?? (settings.defaultWorkspace || '默认工作区未设置')}{selected.task.workspacePath === null && selected.task.effectiveWorkspacePath !== null ? '（继承父任务）' : ''}</div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>
          重复：{dicts.find((d) => d.kind === 'recurrence' && d.code === (selected.task.recurrenceCode ?? 'none'))?.name ?? '不重复'}
          {selected.task.recurrenceMasterId !== null ? '（自动生成的实例）' : selected.task.recurrenceCode !== null && selected.task.recurrenceCode !== 'none' ? `（模板，已生成到 ${selected.task.recurrenceLastGenerated ?? '—'}）` : ''}
        </div>
      </>
    )}
  </div>

  {/**
    * 进度卡（T1/D04）：**独立组件** `TaskProgress`，列表/详情/计划行共用同一份。
    * 判定全部来自纯模块 `taskProgressView()`——这里不写 `statusCode === 'done' ?` 这类分支。
    * `pending` 传的是列表那次**共用查询**折出来的 Map（避免 N+1），
    * 但详情页以自身 `pendingCompletion` 为准（它是最新的单任务读取）。
    */}
  <TaskProgress
    view={taskProgressView({
      task: selected.task,
      children: selected.children,
      pending: selected.pendingCompletion !== undefined
        ? new Map([[selected.task.id, selected.pendingCompletion]])
        : pendingMap,
    })}
    onSave={selected.task.statusCode === 'done' || selected.task.statusCode === 'cancelled' || selected.task.archived
      ? undefined
      : (percent) => saveProgress(selected.task.id, percent)}
    onComplete={selected.task.statusCode === 'done' || selected.task.statusCode === 'cancelled' || selected.task.archived
      ? undefined
      : () => completeTaskFromProgress(selected.task.id)}
  />

  {!editing && (
    <>
      <div className="wb-detail-actions">
        {selected.task.archived ? (
          <button className="wb-btn primary" onClick={() => onRestoreTask(selected.task.id)}><Icon name="refresh" />恢复任务</button>
        ) : (
          <>
            {selected.task.recurrenceMasterId !== null
              ? <span style={{ fontSize: 12, color: '#999', alignSelf: 'center' }}>这是重复任务自动生成的实例，可直接执行/验收。</span>
              : selected.task.recurrenceCode !== null && selected.task.recurrenceCode !== 'none'
                ? <span style={{ fontSize: 12, color: '#999', alignSelf: 'center' }}>重复任务模板：实例会自动生成到“子任务”中，归档模板即停止重复。</span>
                : selected.task.statusCode === 'done' || selected.task.statusCode === 'cancelled'
                  ? <button className="wb-btn" disabled={busy} onClick={() => {
                      const existing = selected.sessions.find((x) => x.role_code === 'review')
                      if (existing !== undefined && typeof existing.session_id === 'string' && existing.session_id !== '' && isSessionUsable(existing.session_id)) {
                        openSessionInPanel(existing.session_id)
                      } else {
                        void startAISession('review', selected.task, selected.task.title)
                      }
                    }}><Icon name="report" />{selected.sessions.some((x) => x.role_code === 'review') ? '进入复盘会话' : 'AI 复盘'}</button>
                  : <>
                      {/**
                        * ⚠️ **文案精简**（2026-10-01 用户要求）。
                        *
                        * 原先把"父任务 / 新会话续作 / 需可执行"三件事全部拼进按钮文字，
                        * 父任务上就成了「AI 执行（父任务）（新会话续作）（需可执行）」——
                        * 一行放不下，整个动作行被挤到换行。用户明确要求精简。
                        *
                        * 精简口径：**按钮上只留"能不能点、点了干什么"**，
                        * 其余全放进 `title`（悬停可看，不占宽度）。唯一保留在文字里的是
                        * 「父任务」——它是**动作语义的一部分**（验收会级联子任务），
                        * 不适合只藏在悬停里。
                        */}
                      <button
                        className="wb-btn primary"
                        disabled={busy || selected.task.aiPolicyCode !== 'execute'}
                        title={selected.task.aiPolicyCode !== 'execute'
                          ? '请先在“AI 策略”里开启「可执行」'
                          : selected.children.length > 0
                            ? '执行父任务：验收通过后未完成子任务会级联完成；所有子节点完成后父节点也会自动完成'
                            : selected.sessions.some((x) => x.role_code === 'execute')
                              ? '新建执行会话并携带此前会话提示'
                              : '开始执行'}
                        onClick={() => void startAISession('execute', selected.task, selected.task.title, selected.sessions.filter((x) => x.role_code === 'execute'))}
                      ><Icon name="ai" />AI 执行{selected.children.length > 0 ? '（父任务）' : ''}</button>
                      <button className="wb-btn" disabled={busy} title="就这个任务向 AI 咨询（不改任务状态）" onClick={() => void startAISession('consult', selected.task, selected.task.title)}><Icon name="ai" />AI 协助</button>
                      <button className="wb-btn" disabled={busy} title="让 AI 把任务拆成子任务提案（确认后才建）" onClick={() => void startAISession('breakdown', selected.task, selected.task.title)}><Icon name="breakdown" />AI 拆解</button>
                      <button className="wb-btn" title="手动添加子任务" onClick={() => { onAddSubtask(selected.task); setDetailTab('children') }}><Icon name="subtask" />子任务</button>
                    </>}
            {/* 「归档」已移到详情页右上角（与「编辑」并列），见本卡片标题那一行 */}
          </>
        )}
      </div>
      {/**
        * ⚠️ 这里原本有一段独立提示（"执行父任务：验收通过后未完成子任务会级联完成…" /
        * "执行会话完成后，AI 会提交验收申请…"）。用户要求删除：它独占一行高度，
        * 而**同样的语义已经在两处说清**——
        * ① 点「完成任务」时的确认弹窗（`completeTaskFromProgress` 的 window.confirm 写明级联）；
        * ② 「AI 执行」按钮的 `title`（"执行父任务：验收通过后未完成子任务会级联完成"）。
        * 删掉它不丢语义，只是不再重复占高度。
        */}
      <div className="wb-detail-tabs">
        <button className={`wb-detail-tab ${detailTab === 'desc' ? 'on' : ''}`} onClick={() => setDetailTab('desc')}>描述</button>
        <button className={`wb-detail-tab ${detailTab === 'children' ? 'on' : ''}`} onClick={() => setDetailTab('children')}>子任务<span className="count">{selected.children.length}</span></button>
        <button className={`wb-detail-tab ${detailTab === 'sessions' ? 'on' : ''}`} onClick={() => setDetailTab('sessions')}>会话<span className="count">{selected.sessions.length}</span></button>
        <button className={`wb-detail-tab ${detailTab === 'records' ? 'on' : ''}`} onClick={() => setDetailTab('records')}>记录<span className="count">{selected.reminders.length + (selected.reviews?.length ?? 0) + (selected.events?.length ?? 0)}</span></button>
      </div>

      {detailTab === 'desc' && (
        <div className="wb-card">
          <MarkdownText text={selected.task.description || '（无描述）'} />
        </div>
      )}

      {detailTab === 'children' && (
        <>
          {subtaskParent !== null && subtaskParent.id === selected.task.id && (
            <form className="wb-form wb-form-panel" onSubmit={(e) => {
              e.preventDefault()
              onCreateSubtask(new FormData(e.currentTarget), subtaskParent)
            }}>
              <h4 className="full" style={{ margin: 0 }}><Icon name="subtask" />新建子任务（父任务：{subtaskParent.title}）</h4>
              <label className="full">标题<input name="title" required placeholder="子任务标题" /></label>
              <label>类型<select name="type" defaultValue={subtaskParent.typeCode}>{dictOf('type').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
              <label>优先级<select name="priority" defaultValue={subtaskParent.priorityCode}>{dictOf('priority').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
              <label>截止时间<input name="due" type="datetime-local" /></label>
              <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit">保存子任务</button><button className="wb-btn" type="button" onClick={onCancelSubtask}>取消</button></div>
            </form>
          )}
          <div className="wb-card">
            <h4>子任务（{selected.children.length}）{selected.children.length > 0 ? ` · ${selected.children.filter((c) => c.statusCode === 'done').length}/${selected.children.length} 已完成` : ''}</h4>
            {selected.children.map((c) => <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}><Badge dict={dictOf('status')} code={c.statusCode} /> <span onClick={() => openTask(c)} style={{ cursor: 'pointer' }}>{c.title}</span></div>)}
            {selected.children.length === 0 && <div style={{ color: '#999', fontSize: 12 }}>无</div>}
          </div>
        </>
      )}

      {detailTab === 'sessions' && (
        <div className="wb-card">
          <h4>关联会话（{selected.sessions.length}）<span style={{ flex: 1 }} />{!sessionPickerOpen && <button className="wb-btn" onClick={() => openSessionPicker()}><Icon name="plus" />添加已有对话</button>}</h4>
          {selected.sessions.length > 0
            ? (
                <div className="wb-session-list">
                  {selected.sessions.map((s) => {
                    const sid = typeof s.session_id === 'string' ? s.session_id : ''
                    const role = String(s.role_code ?? '')
                    const sessionInfo = sessionListSnapshot.byId[sid]
                    const name = sessionInfo?.displayTitle ?? shortId(sid)
                    return (
                      <button key={`${sid}-${role}`} className="wb-session-row" onClick={() => {
                        if (sid === '') return
                        /** 会话页签的行来自历史关联：那条会话可能已被归档或删除，裸切只会静默失败。 */
                        if (!isSessionUsable(sid)) { setNotice('这条会话已被归档或已删除，无法打开'); return }
                        openSessionInPanel(sid)
                      }} title={roleLabel(role)}>
                        <span className="wb-session-role">{roleLabel(role)}</span>
                        <span className="wb-session-name">{name}</span>
                        <span className="wb-session-open">打开 ↗</span>
                      </button>
                    )
                  })}
                </div>
              )
            : <div className="wb-empty">暂无关联会话；点击“添加已有对话”关联，或在任务上启动 AI 会话自动关联。</div>}
          {sessionPickerOpen && (
            <div className="wb-session-picker">
              <div className="wb-session-picker-bar">
                <input className="wb-session-search" placeholder="搜索会话名称 / 工作区" value={sessionPickerQuery} onChange={(e) => setSessionPickerQuery(e.target.value)} autoFocus />
                <select className="wb-session-role-select" value={sessionPickerRole} onChange={(e) => setSessionPickerRole(e.target.value)}>
                  {dictOf('session_role').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                </select>
                <button className="wb-btn" onClick={() => closeSessionPicker()}>取消</button>
              </div>
              <div className="wb-session-picker-list">
                {sessionCandidates.length > 0
                  ? sessionCandidates.map((item) => {
                      const linked = linkedSessionIds.has(item.id)
                      return (
                        <button key={item.id} className="wb-session-option" disabled={sessionPickerBusy || linked} onClick={() => void linkExistingSession(item.id)}>
                          <span className="wb-session-name">{item.displayTitle}</span>
                          {item.cwd !== undefined && <span className="wb-session-cwd">{item.cwd.split(/[\\/]/).filter(Boolean).pop() ?? item.cwd}</span>}
                          <span className="wb-session-add">{linked ? '已关联' : '添加'}</span>
                        </button>
                      )
                    })
                  : <div className="wb-empty">没有找到可添加的会话</div>}
              </div>
            </div>
          )}
        </div>
      )}

      {detailTab === 'records' && (
        <>
          <div className="wb-card">
            <h4>提醒（{selected.reminders.length}）</h4>
            {selected.reminders.map((r) => {
              // 三种终态分开显示：已送达 / 已跳过（太旧）/ 用户已确认 —— 原先把它们都塞在 fired_at 里
              const ackAt = r.acknowledgedAt ?? null
              const skipAt = r.skippedAt ?? null
              const state = ackAt !== null
                ? `已确认 ${fmtTime(ackAt)}`
                : skipAt !== null
                  ? '已跳过（超出补发窗口）'
                  : r.firedAt === null
                    ? '未触发'
                    : `已送达 ${fmtTime(r.firedAt)}`
              const settled = ackAt !== null || skipAt !== null || r.firedAt !== null
              return (
                <div key={r.id} style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                  <Icon name="bell" size={13} />
                  {r.offsetMinutes === 0 ? '准时（截止时间）' : `提前 ${r.offsetMinutes} 分钟`} · {r.methodCode === 'os' ? '系统通知' : '页面/桌面通知'} · {state}
                  {settled && <button className="wb-btn" style={{ padding: '1px 7px', fontSize: 11 }} title="清掉终态、回到未处理，到点会再提醒一次" onClick={() => void resetReminderState(r.id)}>重新武装</button>}
                </div>
              )
            })}
            {selected.task.effectiveDueAt === null
              ? <div style={{ fontSize: 12, color: '#999' }}>任务还没有截止时间，请先在详情里设置截止时间，再添加提醒。</div>
              : selected.task.statusCode === 'done' || selected.task.statusCode === 'cancelled'
                ? <div style={{ fontSize: 12, color: '#999' }}>已完成/已取消的任务不再提醒。</div>
                : (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    {[{ offset: 0, label: '准时' }, { offset: 15, label: '提前15分' }, { offset: 30, label: '提前30分' }, { offset: 60, label: '提前1小时' }, { offset: 1440, label: '提前1天' }].map((item) => (
                      <button key={item.offset} className="wb-btn" disabled={busy} onClick={() => void addTaskReminder(item.offset)}>{item.label}</button>
                    ))}
                  </div>
                )}
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>到提醒时间后：页内横幅 + 桌面通知（设置中授权）。超出补发窗口（默认 24 小时）的提醒会自动标为「已跳过」；任何一条只要显示为已送达 / 已跳过 / 已确认，都可以点「重新武装」让它重新提醒。</div>
          </div>
          <div className="wb-card">
            <h4>复盘记录（{selected.reviews?.length ?? 0}）</h4>
            {(selected.reviews ?? []).map((rv, i) => {
              const reviewId = String(rv.id ?? '')
              const existingKnowledge = taskKnowledge.find((entry) => entry.sourceReviewId === reviewId)
              return (
                <div key={String(rv.id ?? i)} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--wb-border-soft)' }}>
                  <MarkdownText text={String(rv.summary_md ?? '')} />
                  {existingKnowledge !== undefined
                    ? <button className="wb-btn" style={{ marginTop: 6 }} onClick={() => { knowledge.openEntryById(existingKnowledge.id); setView('knowledge') }}><Icon name="book" />✅ 已沉淀，打开知识条目</button>
                    : <button className="wb-btn" style={{ marginTop: 6 }} onClick={() => { knowledge.startCreate({ title: `复盘：${selected.task.title}`, contentMd: String(rv.summary_md ?? ''), kindCode: 'lesson', tags: '复盘', sourceTaskId: selected.task.id, sourceReviewId: reviewId, fileLink: '' }); setView('knowledge') }}><Icon name="book" />💡 沉淀为经验</button>}
                </div>
              )
            })}
            {(selected.reviews?.length ?? 0) === 0 && <div style={{ fontSize: 12, color: '#999' }}>暂无复盘；已完成任务可用“AI 复盘”。</div>}
          </div>
          <div className="wb-card">
            <h4>变更历史（{selected.events?.length ?? 0}）</h4>
            {(() => {
              const events = selected.events ?? []
              const shown = eventsExpanded ? events : events.slice(-5).reverse()
              let lastDate = ''
              return (
                <>
                  {shown.map((ev, i) => {
                    const at = String(ev.at ?? '')
                    const dateKey = at.slice(0, 10)
                    const time = at.slice(11, 16)
                    const code = String(ev.event_code ?? '')
                    const actor = String(ev.actor ?? '')
                    const note = typeof ev.note === 'string' ? ev.note : ''
                    const isNewDate = dateKey !== lastDate
                    lastDate = dateKey
                    return (
                      <div key={String(ev.id ?? i)}>
                        {isNewDate && <div className="wb-event-group-date">{dateKey}</div>}
                        <div className="wb-event-row">
                          <span className="wb-event-icon">{eventIcon(code)}</span>
                          <div className="wb-event-main">
                            <div className="wb-event-title">{eventLabel(code)}{actor !== '' ? ` · ${actor}` : ''}</div>
                            {note !== '' && <div className="wb-event-meta">{note}</div>}
                            <div className="wb-event-meta">{time}</div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {events.length === 0 && <div style={{ fontSize: 12, color: '#999' }}>暂无变更记录。</div>}
                  {events.length > 5 && (
                    <button className="wb-btn" style={{ marginTop: 8 }} onClick={() => setEventsExpanded((v) => !v)}>
                      {eventsExpanded ? '收起' : `展开全部（${events.length} 条）`}
                    </button>
                  )}
                </>
              )
            })()}
          </div>
        </>
      )}
    </>
  )}
  </>
  )
}
