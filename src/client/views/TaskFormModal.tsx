/**
 * D17 / P3-3：任务表单弹窗 —— 新建任务（非受控表单）与编辑任务（受控草稿）。
 *
 * 拆分前这两个弹窗内联在 `index.tsx` 的 `WorkbenchApp` 尾部（第 3302–3421 行，120 行），
 * 是本组件里最后两块表单 JSX。现在它们只做**展示**：
 * - 表单自己的 4 项状态（`showForm` / `subtaskParent` / `editDraft` / `formWorkspace`）来自
 *   `hooks/useTaskForms.ts`（唯一 owner），跨域的数据与动作由入口按 props 注入 ——
 *   本文件不发请求、不持有 state、不 import 入口（设计 §3 的依赖单向向下）。
 * - 本文件**不发 HTTP**：新建弹窗只 `preventDefault` + 收 `FormData` 交给 `onSubmit`（与详情面板的
 *   子任务表单同一先例），编辑弹窗只在「保存」时喊 `onSave()`；payload 拼接与 `api(...)` 留在装配层（模式 5）。
 *
 * ⚠️ 两个组件**故意不合并**（设计模式 3：同一个名字在不同调用点语义不同，不许硬合成一个）：
 * - `TaskCreateModal`：**非受控** —— 七个字段各用 `defaultValue`，提交时读一次 `FormData`，没有草稿状态；
 * - `TaskEditModal`：**受控草稿** —— 12 个字段逐个 `onPatchDraft({...})` 改草稿，另有「保存」按钮，
 *   因此它**可以带着未保存的改动被关掉**（原样行为）。硬合成一个只会得到一堆 `mode === 'create' ? … : …` 分支。
 *
 * ⚠️ 搬迁纪律：两段 JSX **逐字保留**（字段顺序、`name=`、`required`、文案、`rows`、条件渲染、防环提示
 * 都没动），只做了这几类**等价**替换：
 * ① `settings.defaultEstimateMinutes` / `settings.defaultWorkspace` → `defaultEstimateMinutes` /
 *    `defaultWorkspace`（入口解构出的标量，注入即可，不必把整份 `settings` 传给视图）；
 * ② `onBrowse={() => openDirPicker('form' | 'edit')}` → `onBrowseWorkspace()`（入口仍按入口身份分流，
 *    目录弹窗状态只有一份，见入口的 `applyWorkspaceDir`）；
 * ③ 编辑弹窗里 12 处逐字重复的 `setEditDraft((prev) => prev === null ? prev : { ...prev, X })`
 *    → `onPatchDraft({ X })`（同一语义原先写了 12 遍，属 §0 去重）；
 * ④ `onClose` / 「取消」/ 「保存」→ `onClose` / `onSave`；`selected.task.recurrenceMasterId`
 *    → `recurrenceMasterId`（入口解出的一个标量，视图不去读整个 `selected`）。
 * 新建弹窗的"打开与否"原先写在调用点的 `{showForm && …}` 上，现在等价收进组件的 `if (!open) return null`
 * （两者都是"不打开就不挂载"，弹窗内部的初值语义不变）。
 */
import { Modal } from '../components/Modal.js'
import { Icon } from '../components/Icon.js'
import { WorkspacePicker } from '../components/WorkspacePicker.js'
import type { WorkspaceCandidate } from '../workspacePicker.js'
import type { Dict } from '../viewTypes.js'
import type { TaskEditDraft } from '../app/contracts.js'

/** 新建任务弹窗的 props（跨域依赖全部显式注入；本组件不发请求）。 */
export type TaskCreateModalProps = {
  /** 是否打开（入口的 `forms.showForm`；等价于拆分前的 `{showForm && …}`）。 */
  open: boolean
  /** 「取消」与右上角关闭（入口的 `forms.actions.closeCreate`）。 */
  onClose: () => void
  /** 提交：视图只负责 `preventDefault` + 收 `FormData`，payload 拼接与 POST 在装配层。 */
  onSubmit: (form: FormData) => void
  dictOf: (kind: string) => Dict[]
  /** 「耗时」输入框 placeholder 里的默认值。 */
  defaultEstimateMinutes: number
  /** 工作区 placeholder（默认工作区）。 */
  defaultWorkspace: string
  /** 已有工作区候选（入口那唯一一处 `workspaceCandidates(...)` 的结果）。 */
  workspaceChoices: readonly WorkspaceCandidate[]
  /** 表单里的工作区值：表单非受控，靠一个 hidden 输入把它带进 FormData。 */
  formWorkspace: string
  onFormWorkspaceChange: (path: string) => void
  /** 「浏览…」：由入口按入口身份分流（表单 / 编辑 / 快速录入共用一份目录弹窗）。 */
  onBrowseWorkspace: () => void
  busy: boolean
}

export function TaskCreateModal({
  open, onClose, onSubmit, dictOf, defaultEstimateMinutes, defaultWorkspace,
  workspaceChoices, formWorkspace, onFormWorkspaceChange, onBrowseWorkspace, busy,
}: TaskCreateModalProps): JSX.Element | null {
  if (!open) return null

  return (
    <Modal
      title={<><Icon name="plus" />新建任务</>}
      size="md"
      onClose={onClose}
    >
      <form className="wb-form" id="wb-new-task-form" onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)) }}>
        <label className="full">标题<input name="title" required placeholder="要做什么？" /></label>
        <label>类型<select name="type" defaultValue="client_meeting">{dictOf('type').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>优先级<select name="priority" defaultValue="p2">{dictOf('priority').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>状态<select name="status" defaultValue="todo">{dictOf('status').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>截止时间<input name="due" type="datetime-local" /></label>
        <label>重复<select name="recurrence" defaultValue="none">{dictOf('recurrence').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        {/* 与编辑弹窗同一套字段与文案：同一字段两个入口两套说法 = 迟早打架 */}
        <label>耗时（分钟）<input name="estimatedMinutes" type="number" min={1} max={1440} step={5} placeholder={`留空 = 默认 ${defaultEstimateMinutes} 分钟`} /></label>
        <label style={{ alignSelf: 'end' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <input name="allDay" type="checkbox" />
            全天任务
          </span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>只影响显示与重复锚点，不改变容量计算</span>
        </label>
        {/**
          * 批次2 #2：与快速录入、编辑任务**同一个组件**（两种选法：已有工作区下拉 + 浏览文件夹）。
          * 表单本身是非受控的（提交时读 FormData），所以这里用一个 hidden 输入承接值 ——
          * 受控的可见输入没法直接进 FormData 的可读列表之外的地方，用 hidden 更直白。
          */}
        <div className="full">
          <WorkspacePicker
            value={formWorkspace}
            touched={false}
            sourceLabel="留空 = 用默认工作区"
            candidates={workspaceChoices}
            disabled={busy}
            placeholder={defaultWorkspace || '默认工作区未设置'}
            onChange={onFormWorkspaceChange}
            onBrowse={onBrowseWorkspace}
          />
          <input type="hidden" name="workspacePath" value={formWorkspace} />
        </div>
        <label className="full">描述<textarea name="description" rows={2} placeholder="背景 / 目标 / 验收标准（Markdown）" /></label>
        <div className="full" style={{ display: 'flex', gap: 8 }}>
          <button className="wb-btn primary lg" type="submit"><Icon name="check" />保存任务</button>
          <button className="wb-btn" type="button" onClick={onClose}>取消</button>
        </div>
      </form>
    </Modal>
  )
}

/** 编辑任务弹窗的 props（跨域依赖全部显式注入；本组件不发请求）。 */
export type TaskEditModalProps = {
  /** 草稿（入口的 `forms.editDraft`；打开与否由入口的 `{editDraft !== null && selected !== null && …}` 守）。 */
  draft: TaskEditDraft
  /** 该任务的 `recurrenceMasterId`：非 null 时「重复」只显示"由模板任务管理"（实例任务不许改重复规则）。 */
  recurrenceMasterId: string | null
  onClose: () => void
  /** 「保存」：请求本体与乐观更新在装配层（`saveEditDraft`）。 */
  onSave: () => void
  /** 改草稿的若干字段（原 12 处内联 null-safe 展开的唯一实现，在 `useTaskForms`）。 */
  onPatchDraft: (patch: Partial<TaskEditDraft>) => void
  dictOf: (kind: string) => Dict[]
  /** 「耗时」输入框 placeholder 与提示行里的默认值。 */
  defaultEstimateMinutes: number
  /** 工作区 placeholder（继承 / 默认）。 */
  defaultWorkspace: string
  workspaceChoices: readonly WorkspaceCandidate[]
  /** 「浏览…」：由入口按入口身份分流（见 `applyWorkspaceDir`）。 */
  onBrowseWorkspace: () => void
  busy: boolean
  /** 「父任务」下拉的候选（入口那个 `reparentCandidates` 派生，已排除自身与后代）。 */
  reparentCandidates: Array<{ id: string; title: string; depth: number }>
}

export function TaskEditModal({
  draft, recurrenceMasterId, onClose, onSave, onPatchDraft, dictOf, defaultEstimateMinutes,
  defaultWorkspace, workspaceChoices, onBrowseWorkspace, busy, reparentCandidates,
}: TaskEditModalProps): JSX.Element {
  return (
    <Modal
      title={<><Icon name="edit" />编辑任务</>}
      size="md"
      onClose={onClose}
      footer={(
        <>
          <button className="wb-btn" onClick={onClose}>取消</button>
          <button className="wb-btn primary" disabled={draft.title.trim() === ''} onClick={onSave}>
            <Icon name="check" />保存
          </button>
        </>
      )}
    >
      <div className="wb-form" style={{ border: 'none', padding: 0 }}>
        <label className="full">标题<input value={draft.title} onChange={(e) => onPatchDraft({ title: e.target.value })} /></label>
        <label>类型<select value={draft.typeCode} onChange={(e) => onPatchDraft({ typeCode: e.target.value })}>{dictOf('type').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>优先级<select value={draft.priorityCode} onChange={(e) => onPatchDraft({ priorityCode: e.target.value })}>{dictOf('priority').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>状态<select value={draft.statusCode} onChange={(e) => onPatchDraft({ statusCode: e.target.value })}>{dictOf('status').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>AI 策略<select value={draft.aiPolicyCode} onChange={(e) => onPatchDraft({ aiPolicyCode: e.target.value })}>{dictOf('ai_policy').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        {recurrenceMasterId === null
          ? <label>重复<select value={draft.recurrenceCode} onChange={(e) => onPatchDraft({ recurrenceCode: e.target.value })}>{dictOf('recurrence').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
          : <div style={{ fontSize: 12, color: '#999', alignSelf: 'center' }}>重复：由模板任务管理</div>}
        <label>截止时间<input type="datetime-local" value={draft.dueLocal} onChange={(e) => onPatchDraft({ dueLocal: e.target.value })} /></label>
        {/* ---------------- 预计耗时 / 全天任务（v1.15.1） ---------------- */}
        <label>耗时（分钟）<input type="number" min={1} max={1440} step={5} value={draft.estimatedMinutes} placeholder={`留空 = 默认 ${defaultEstimateMinutes} 分钟`} onChange={(e) => onPatchDraft({ estimatedMinutes: e.target.value })} /></label>
        <label style={{ alignSelf: 'end' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <input type="checkbox" checked={draft.allDay} onChange={(e) => onPatchDraft({ allDay: e.target.checked })} />
            全天任务
          </span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>只影响显示与重复锚点，不改变容量计算</span>
        </label>
        <p className="wb-hint" style={{ gridColumn: '1 / -1', margin: '0 0 4px' }}>
          {`耗时改完立即影响今日容量的「已排」；留空 = 按默认 ${defaultEstimateMinutes} 分钟计入。`}
        </p>
        <div className="full">
          <WorkspacePicker
            value={draft.workspacePath}
            touched={false}
            sourceLabel="留空 = 继承父任务，父任务也没有才用默认"
            candidates={workspaceChoices}
            disabled={busy}
            placeholder={defaultWorkspace || '默认工作区未设置'}
            onChange={(path) => onPatchDraft({ workspacePath: path })}
            onBrowse={onBrowseWorkspace}
          />
        </div>
        <label className="full">描述（Markdown）<textarea rows={6} value={draft.description} onChange={(e) => onPatchDraft({ description: e.target.value })} /></label>
        {/* ---------------- 改父任务（v1.14.0） ---------------- */}
        <label className="full">
          父任务
          <select
            value={draft.parentId}
            onChange={(e) => onPatchDraft({ parentId: e.target.value })}
          >
            <option value="">（顶层）</option>
            {reparentCandidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {'\u00a0'.repeat(candidate.depth * 2)}{candidate.title}
              </option>
            ))}
          </select>
        </label>
        <p className="wb-hint" style={{ gridColumn: '1 / -1', margin: '0 0 4px' }}>
          移动子树：后代跟随一起移动。候选里不列出自身与自身后代（会形成环）；
          服务端另有独立防环校验，失败会给出中文原因。移动会写入任务详情的「记录」页签。
        </p>
      </div>
    </Modal>
  )
}
