"""D17 / P3-3 一次性搬迁脚本：把两个任务表单弹窗（入口 3302–3421）抽成 views/TaskFormModal.tsx。

四项表单状态与动作已经手写进 `hooks/useTaskForms.ts`，本脚本负责另外两件事：
- `index.tsx`：state/effect 换成 `const forms = useTaskForms()`；散落的 setter 调用点换成
  `forms.actions.*`；两段弹窗 JSX 换成两个组件装配；
- `views/TaskDetailPane.tsx`：把 `editDraft`/`setEditDraft`/`setSubtaskParent` 三个跨域 setter
  换成**意图回调**（`editing` / `onOpenEdit` / `onAddSubtask` / `onCancelSubtask`，设计 §5）。

设计约束（照 P1/P2/P3-1/P3-2 的教训写）：
- **锚点必须唯一**：每处替换都断言命中恰好 1 次，否则整体中止、一个文件都不写（避免"切错位置 + 写半截"）。
- **区间删除双向校验**：首行、末行都要子串匹配，并核对行数。
- 所有断言先跑完，最后才落盘。
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
INDEX = ROOT / 'src' / 'client' / 'index.tsx'
PANE = ROOT / 'src' / 'client' / 'views' / 'TaskDetailPane.tsx'
VIEW = ROOT / 'src' / 'client' / 'views' / 'TaskFormModal.tsx'

problems: list[str] = []


def replace_once(text: str, old: str, new: str, label: str) -> str:
    n = text.count(old)
    if n != 1:
        problems.append(f'{label}: 期望命中 1 次，实际 {n} 次')
        return text
    return text.replace(old, new)


def sub_once(text: str, pattern: str, new: str, label: str, want: int = 1) -> str:
    out, n = re.subn(pattern, new, text)
    if n != want:
        problems.append(f'{label}: 期望命中 {want} 次，实际 {n} 次')
        return text
    return out


def dedent(text: str, n: int) -> str:
    """统一左移最多 n 个空格，保留相对缩进。"""
    out = []
    for l in text.split('\n'):
        lead = len(l) - len(l.lstrip(' '))
        out.append(l[min(lead, n):])
    return '\n'.join(out)


index_src = INDEX.read_text(encoding='utf-8')
pane_src = PANE.read_text(encoding='utf-8')
for name, text in (('index.tsx', index_src), ('TaskDetailPane.tsx', pane_src)):
    if '\r\n' in text:
        problems.append(f'{name} 出现了 CRLF，脚本按 LF 设计')
lines = index_src.split('\n')
pane_lines = pane_src.split('\n')

# ── 1. 弹窗区间定位与双向校验 ─────────────────────────────────────────────────
for no, want in [
    (3302, '{showForm && ('),
    (3303, '<Modal'),
    (3304, '新建任务'),
    (3306, 'onClose={() => setShowForm(false)}'),
    (3308, 'id="wb-new-task-form"'),
    (3344, '保存任务'),
    (3348, '</Modal>'),
    (3349, ')}'),
    (3351, '{editDraft !== null && selected !== null && ('),
    (3352, '<Modal'),
    (3353, '编辑任务'),
    (3420, '</Modal>'),
    (3421, ')}'),
    (3422, '{pendingOpen && ('),
]:
    if want not in lines[no - 1]:
        problems.append(f'index.tsx 边界校验失败：第 {no} 行不含 {want!r}；实际 {lines[no - 1]!r}')

if problems:
    print('\n'.join(problems))
    sys.exit(1)

create_raw = lines[3302:3348]   # 1-based 3303..3348
edit_raw = lines[3351:3420]     # 1-based 3352..3420
if len(create_raw) != 46:
    problems.append(f'新建弹窗 body 行数应为 46，实际 {len(create_raw)}')
if len(edit_raw) != 69:
    problems.append(f'编辑弹窗 body 行数应为 69，实际 {len(edit_raw)}')

create_body = dedent('\n'.join(create_raw), 4)
edit_body = dedent('\n'.join(edit_raw), 4)

# ── 2. body 内的等价替换 ─────────────────────────────────────────────────────
create_body = replace_once(create_body, 'onClose={() => setShowForm(false)}', 'onClose={onClose}',
                           'create/onClose')
create_body = replace_once(
    create_body,
    'onSubmit={(e) => void createTask(e)}',
    'onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)) }}',
    'create/提交收 FormData',
)
create_body = replace_once(create_body, 'settings.defaultEstimateMinutes', 'defaultEstimateMinutes',
                           'create/默认耗时')
create_body = replace_once(create_body, 'settings.defaultWorkspace', 'defaultWorkspace',
                           'create/默认工作区')
create_body = replace_once(create_body, 'onChange={setFormWorkspace}', 'onChange={onFormWorkspaceChange}',
                           'create/工作区受控值')
create_body = replace_once(create_body, "onBrowse={() => openDirPicker('form')}", 'onBrowse={onBrowseWorkspace}',
                           'create/浏览…')
create_body = replace_once(create_body, 'onClick={() => setShowForm(false)}>取消', 'onClick={onClose}>取消',
                           'create/取消')

edit_body = replace_once(edit_body, 'onClose={() => setEditDraft(null)}', 'onClose={onClose}', 'edit/onClose')
edit_body = replace_once(edit_body, 'onClick={() => setEditDraft(null)}>取消', 'onClick={onClose}>取消', 'edit/取消')
edit_body = replace_once(edit_body, 'onClick={() => void saveEditDraft()}', 'onClick={onSave}', 'edit/保存')
edit_body = sub_once(
    edit_body,
    r'setEditDraft\(\(prev\) => \(prev === null \? prev : \{ \.\.\.prev, ([A-Za-z]+): ([^}]*?) \}\)\)',
    r'onPatchDraft({ \1: \2 })',
    'edit/带括号的那处 null-safe 展开 → onPatchDraft',
)
edit_body = sub_once(
    edit_body,
    r'setEditDraft\(\(prev\) => prev === null \? prev : \{ \.\.\.prev, ([A-Za-z]+): ([^}]*?) \}\)',
    r'onPatchDraft({ \1: \2 })',
    'edit/另外 11 处 null-safe 展开 → onPatchDraft',
    want=11,
)
edit_body = replace_once(edit_body, 'selected.task.recurrenceMasterId', 'recurrenceMasterId',
                         'edit/重复由模板管理')
edit_body = edit_body.replace('editDraft.', 'draft.')
edit_body = sub_once(edit_body, r'settings\.defaultEstimateMinutes', 'defaultEstimateMinutes',
                     'edit/默认耗时', want=2)
edit_body = replace_once(edit_body, 'settings.defaultWorkspace', 'defaultWorkspace',
                         'edit/默认工作区')
edit_body = replace_once(edit_body, "onBrowse={() => openDirPicker('edit')}", 'onBrowse={onBrowseWorkspace}',
                         'edit/浏览…')

for bad in ['setEditDraft', 'editDraft', 'settings.', 'openDirPicker', 'saveEditDraft', 'createTask(',
            'showForm']:
    if bad in create_body:
        problems.append(f'新建弹窗 body 里仍残留 {bad}')
    if bad in edit_body and bad != 'createTask(':
        problems.append(f'编辑弹窗 body 里仍残留 {bad}')

# ── 3. 生成视图文件 ───────────────────────────────────────────────────────────
HEADER = '''/**
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
'''

EDIT_SPLIT = '''  )
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
'''

view_text = HEADER + create_body + '\n' + EDIT_SPLIT + edit_body + '''
  )
}
'''

# ── 4. index.tsx 的编辑 ──────────────────────────────────────────────────────
# 4.1 两段弹窗 JSX → 两个组件装配（先用原始行文本取块，避免后面几处替换串味）
old_block = '\n'.join(lines[3301:3421])  # 1-based 3302..3421
new_block = '''      <TaskCreateModal
        open={forms.showForm}
        onClose={forms.actions.closeCreate}
        onSubmit={createTask}
        dictOf={dictOf}
        defaultEstimateMinutes={settings.defaultEstimateMinutes}
        defaultWorkspace={settings.defaultWorkspace}
        workspaceChoices={workspaceChoices}
        formWorkspace={formWorkspace}
        onFormWorkspaceChange={forms.actions.setFormWorkspace}
        onBrowseWorkspace={() => openDirPicker('form')}
        busy={busy}
      />

      {editDraft !== null && selected !== null && (
        <TaskEditModal
          draft={editDraft}
          recurrenceMasterId={selected.task.recurrenceMasterId}
          onClose={forms.actions.closeEdit}
          onSave={() => void saveEditDraft()}
          onPatchDraft={forms.actions.patchDraft}
          dictOf={dictOf}
          defaultEstimateMinutes={settings.defaultEstimateMinutes}
          defaultWorkspace={settings.defaultWorkspace}
          workspaceChoices={workspaceChoices}
          onBrowseWorkspace={() => openDirPicker('edit')}
          busy={busy}
          reparentCandidates={reparentCandidates}
        />
      )}'''
index_src = replace_once(index_src, old_block, new_block, 'index/两段弹窗 JSX → 组件装配')

# 4.2 import
index_src = replace_once(
    index_src,
    "import { useTaskDetailModel } from './hooks/useTaskDetailModel.js'\n",
    "import { useTaskDetailModel } from './hooks/useTaskDetailModel.js'\n"
    "import { useTaskForms } from './hooks/useTaskForms.js'\n",
    'import：useTaskForms',
)
index_src = replace_once(
    index_src,
    "import { TaskDetailPane } from './views/TaskDetailPane.js'\n",
    "import { TaskDetailPane } from './views/TaskDetailPane.js'\n"
    "import { TaskCreateModal, TaskEditModal } from './views/TaskFormModal.js'\n",
    'import：两个弹窗组件',
)

# 4.3 四项 state → hook
index_src = replace_once(
    index_src,
    '  const [showForm, setShowForm] = useState(false)\n'
    '  const [subtaskParent, setSubtaskParent] = useState<Task | null>(null)\n'
    '  const [editDraft, setEditDraft] = useState<TaskEditDraft | null>(null)\n',
    '  /**\n'
    '   * 任务表单域（D17/P3-3）：原来摊在这里的 3 个 state（`showForm`/`subtaskParent`/`editDraft`）\n'
    '   * 与文件中部那个 `formWorkspace` 一起收进了 `hooks/useTaskForms.ts`。\n'
    '   *\n'
    '   * 入口自己只需要三样**读取值**（编辑草稿、子任务父任务、表单工作区）与动作 —— 动作全部经\n'
    '   * `forms.actions` 取，不再持有可写副本（设计 §5：视图拿意图，不拿 setter）。\n'
    '   */\n'
    '  const forms = useTaskForms()\n'
    '  const { editDraft, subtaskParent, formWorkspace } = forms\n'
    '  const { dismissOnTaskChange } = forms.actions\n',
    'state/表单域 3 个 state → hook',
)
index_src = replace_once(
    index_src,
    '  /** 新建任务表单里的工作区（表单本身是非受控的，这一格必须受控才能被"浏览…"写值）。 */\n'
    "  const [formWorkspace, setFormWorkspace] = useState('')\n",
    '  // 任务表单域（D17/P3-3）：`formWorkspace` 已随 4 项状态收进 hooks/useTaskForms.ts\n',
    'state/formWorkspace → hook',
)
index_src = replace_once(
    index_src,
    '  /** 新建任务表单每次打开都从空白开始（否则上一次"浏览…"选的目录会留在下一次）。 */\n'
    "  useEffect(() => { if (showForm) setFormWorkspace('') }, [showForm])\n",
    '  // 新建任务表单"每次打开都清空工作区"的 effect 已随 4 项状态收进 hooks/useTaskForms.ts（P3-3）\n',
    'effect/表单清空 → hook',
)

# 4.4 散落的 setter 调用点
index_src = replace_once(
    index_src,
    "  useEffect(() => { setEditDraft(null); setSubtaskParent(null) }, [selected?.task.id])\n",
    '  /** 换任务时把两个瞬态表单收掉（表单域的动作；触发条件来自任务数据域）。 */\n'
    '  useEffect(() => { dismissOnTaskChange() }, [selected?.task.id, dismissOnTaskChange])\n',
    'effect/换任务收表单',
)
index_src = replace_once(
    index_src,
    "    if (target === 'form') { setFormWorkspace(picked); return }\n"
    "    if (target === 'edit') { setEditDraft((prev) => (prev === null ? prev : { ...prev, workspacePath: picked })) }\n",
    "    if (target === 'form') { forms.actions.setFormWorkspace(picked); return }\n"
    "    if (target === 'edit') { forms.actions.patchDraft({ workspacePath: picked }) }\n",
    'applyWorkspaceDir 两个分流',
)
index_src = replace_once(
    index_src,
    "      setEditDraft(null)\n      pushToast('任务已更新', 'success')\n",
    "      forms.actions.closeEdit()\n      pushToast('任务已更新', 'success')\n",
    'saveEditDraft 成功分支',
)
index_src = replace_once(
    index_src,
    '  const createTask = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {\n'
    '    event.preventDefault()\n'
    '    const form = new FormData(event.currentTarget)\n',
    '  /**\n'
    '   * 新建任务（弹窗提交）。视图只 `preventDefault` + 收 `FormData`（与详情面板的子任务表单同一先例），\n'
    '   * payload 拼接与 POST 留在这里 —— 设计 §3：`views/` 不许发 HTTP。\n'
    '   */\n'
    '  const createTask = async (form: FormData): Promise<void> => {\n',
    'createTask 收 FormData',
)
index_src = replace_once(
    index_src,
    '    setShowForm(false); await refresh()\n',
    '    forms.actions.closeCreate(); await refresh()\n',
    'createTask 收尾',
)
index_src = replace_once(
    index_src,
    "{ setSubtaskParent(null); setNotice('子任务已创建')",
    "{ forms.actions.setSubtaskParent(null); setNotice('子任务已创建')",
    'createSubtask 收表单',
)
index_src = replace_once(
    index_src,
    '<button className="wb-btn" onClick={() => setShowForm((v) => !v)}><Icon name="plus" /><span className="wb-label">新建</span></button>',
    '<button className="wb-btn" onClick={() => forms.actions.toggleCreate()}><Icon name="plus" /><span className="wb-label">新建</span></button>',
    '工具栏「新建」开关',
)
index_src = replace_once(
    index_src,
    '<button className="wb-btn" onClick={() => setShowForm((v) => !v)}>新建任务</button>',
    '<button className="wb-btn" onClick={() => forms.actions.toggleCreate()}>新建任务</button>',
    '空态「新建任务」开关',
)

# 4.5 TaskDetailPane 的 props：三个跨域 setter → 意图回调
index_src = replace_once(
    index_src,
    '                editDraft={editDraft}\n'
    '                setEditDraft={setEditDraft}\n'
    '                subtaskParent={subtaskParent}\n'
    '                setSubtaskParent={setSubtaskParent}\n',
    '                editing={editDraft !== null}\n'
    '                onOpenEdit={forms.actions.openEdit}\n'
    '                subtaskParent={subtaskParent}\n'
    '                onAddSubtask={forms.actions.setSubtaskParent}\n'
    '                onCancelSubtask={() => forms.actions.setSubtaskParent(null)}\n',
    'TaskDetailPane props',
)

# ── 5. TaskDetailPane.tsx 的编辑 ─────────────────────────────────────────────
pane_src = replace_once(
    pane_src,
    '  editDraft: TaskEditDraft | null\n'
    '  setEditDraft: (draft: TaskEditDraft | null) => void\n'
    '  subtaskParent: Task | null\n'
    '  setSubtaskParent: (task: Task | null) => void\n',
    '  /** 编辑弹窗是否打开（表单域 `editDraft !== null` 折出的**布尔**；草稿本体不再进视图）。 */\n'
    '  editing: boolean\n'
    '  /** 打开编辑弹窗：整份草稿由本视图按当前任务折出（原 `setEditDraft({...})` 的调用点）。 */\n'
    '  onOpenEdit: (draft: TaskEditDraft) => void\n'
    '  /** 子任务表单挂在哪个任务上（`null` = 收起）；值由入口的表单域持有。 */\n'
    '  subtaskParent: Task | null\n'
    '  /** 「手动添加子任务」：开表单（**跨域**，写入表单域；页签由本视图自己切）。 */\n'
    '  onAddSubtask: (task: Task) => void\n'
    '  /** 子任务表单「取消」。 */\n'
    '  onCancelSubtask: () => void\n',
    'pane/props 类型',
)
pane_src = replace_once(
    pane_src,
    '  editDraft, setEditDraft, subtaskParent, setSubtaskParent, startAISession, setNotice, patchTask,\n',
    '  editing, onOpenEdit, subtaskParent, onAddSubtask, onCancelSubtask, startAISession, setNotice, patchTask,\n',
    'pane/解构',
)
pane_src = replace_once(
    pane_src,
    '  {editDraft === null && (\n',
    '  {!editing && (\n',
    'pane/编辑弹窗打开时收起下半区',
)
pane_src = replace_once(
    pane_src,
    'onClick={() => setEditDraft({ title: selected.task.title,',
    'onClick={() => onOpenEdit({ title: selected.task.title,',
    'pane/编辑按钮',
)
pane_src = replace_once(
    pane_src,
    'onClick={() => { setSubtaskParent(selected.task); setDetailTab(\'children\') }}',
    'onClick={() => { onAddSubtask(selected.task); setDetailTab(\'children\') }}',
    'pane/子任务按钮',
)
pane_src = replace_once(
    pane_src,
    'onClick={() => setSubtaskParent(null)}>取消</button>',
    'onClick={onCancelSubtask}>取消</button>',
    'pane/子任务取消',
)

# ── 6. 残余自查 ──────────────────────────────────────────────────────────────
for name, src_text in (('index.tsx', index_src), ('TaskDetailPane.tsx', pane_src)):
    code = re.sub(r'/\*[\s\S]*?\*/', ' ', src_text)
    code = re.sub(r'^[ \t]*//.*$', '', code, flags=re.M)
    for pat, label in [
        (r'(?<![\w.])setShowForm\b', 'setShowForm'),
        (r'(?<![\w.])setEditDraft\b', 'setEditDraft'),
        (r'(?<![\w.])setSubtaskParent\b', 'setSubtaskParent'),
        (r'(?<![\w.])setFormWorkspace\b', 'setFormWorkspace'),
        (r'(?<![\w.])showForm\b', 'showForm'),
    ]:
        if re.search(pat, code):
            problems.append(f'{name} 里仍残留裸的 {label}')
if 'wb-new-task-form' in index_src:
    problems.append('index.tsx 里仍有新建任务表单（应已随组件搬走）')
if 'wb-new-task-form' not in view_text:
    problems.append('TaskFormModal.tsx 缺新建任务表单')
if 'id="wb-new-task-form"' not in view_text:
    problems.append('TaskFormModal.tsx 缺表单 id')
hook_src = (ROOT / 'src' / 'client' / 'hooks' / 'useTaskForms.ts').read_text(encoding='utf-8')
for name in ['showForm', 'subtaskParent', 'editDraft', 'formWorkspace']:
    if f'const [{name},' not in hook_src:
        problems.append(f'useTaskForms.ts 里没有 const [{name},（hook 没写全？）')
    if f'const [{name},' in index_src:
        problems.append(f'index.tsx 里仍有 const [{name},（状态没搬干净）')

if problems:
    print('ABORT（未写任何文件）：')
    print('\n'.join(problems))
    sys.exit(1)

VIEW.write_text(view_text, encoding='utf-8', newline='\n')
INDEX.write_text(index_src, encoding='utf-8', newline='\n')
PANE.write_text(pane_src, encoding='utf-8', newline='\n')
print(f'ok: {VIEW.relative_to(ROOT)} = {view_text.count(chr(10))} 行')
print(f'ok: {INDEX.relative_to(ROOT)} = {index_src.count(chr(10))} 行')
print(f'ok: {PANE.relative_to(ROOT)} = {pane_src.count(chr(10))} 行')
