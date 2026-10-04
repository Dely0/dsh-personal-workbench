"""D17 / P3-2 一次性搬迁脚本：把任务详情区（入口 3042–3374）抽成 views/TaskDetailPane.tsx。

设计约束（照 P1/P2/P3-1 的教训写）：
- **锚点必须唯一**：每处替换都断言命中恰好 1 次，否则整体中止、一个文件都不写（避免"切错位置 + 写半截"）。
- **区间删除双向校验**：首行、末行都要子串匹配。
- 所有断言先跑完，最后才落盘。
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
INDEX = ROOT / 'src' / 'client' / 'index.tsx'
VIEW = ROOT / 'src' / 'client' / 'views' / 'TaskDetailPane.tsx'

problems: list[str] = []


def replace_once(text: str, old: str, new: str, label: str) -> str:
    n = text.count(old)
    if n != 1:
        problems.append(f'{label}: 期望命中 1 次，实际 {n} 次')
        return text
    return text.replace(old, new)


src = INDEX.read_text(encoding='utf-8')
if '\r\n' in src:
    problems.append('index.tsx 出现了 CRLF，脚本按 LF 设计')
lines = src.split('\n')


def line(no: int) -> str:
    return lines[no - 1]


# ── 1. 区间定位与双向校验 ─────────────────────────────────────────────────────
checks = [
    (3040, ': selected === null'),
    (3041, 'className="wb-empty"'),
    (3042, ': ('),
    (3043, '<>'),
    (3373, '</>'),
    (3374, ')}'),
]
for no, want in checks:
    if want not in line(no):
        problems.append(f'边界校验失败：第 {no} 行不含 {want!r}；实际 {line(no)!r}')
if problems:
    print('\n'.join(problems))
    sys.exit(1)

body = lines[3043:3372]  # 1-based 3044..3372（不含末尾换行）
if len(body) != 329:
    problems.append(f'body 行数应为 329，实际 {len(body)}')

# ── 2. body 内的 4 处等价替换 ─────────────────────────────────────────────────
body_text = '\n'.join(body)
body_text = replace_once(
    body_text,
    'if (!aiSessionUsable(runtime, sid)) {',
    'if (!isSessionUsable(sid)) {',
    'body/会话可用性判定（会话行）',
)
body_text = replace_once(
    body_text,
    'aiSessionUsable(runtime, existing.session_id)',
    'isSessionUsable(existing.session_id)',
    'body/会话可用性判定（复盘行）',
)
body_text = replace_once(
    body_text,
    "onClick={() => { setSessionPickerQuery(''); setSessionPickerOpen(true) }}",
    'onClick={() => openSessionPicker()}',
    'body/展开会话选择器',
)
body_text = replace_once(
    body_text,
    "onClick={() => { setSessionPickerOpen(false); setSessionPickerQuery('') }}",
    'onClick={() => closeSessionPicker()}',
    'body/收起会话选择器',
)
if 'setSessionPickerOpen(' in body_text:
    problems.append('body 里仍残留 setSessionPickerOpen(（应只剩 hook 内部的实现）')


def dedent14(text: str) -> str:
    """统一左移最多 14 个空格（原 JSX 深度 16 → 视图里 2），保留相对缩进。"""
    out = []
    for l in text.split('\n'):
        lead = len(l) - len(l.lstrip(' '))
        out.append(l[min(lead, 14):])
    return '\n'.join(out)


dedented = dedent14(body_text)

# ── 3. 生成视图文件 ───────────────────────────────────────────────────────────
header = '''/**
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
 * （注释、文案、`data-*`、DOM 层级与交互顺序都没动），只做了 4 处**等价**写法替换：
 * ① 会话行的 `aiSessionUsable(runtime, sid)`、复盘行的 `aiSessionUsable(runtime, existing.session_id)`
 *    → `isSessionUsable(id)`（入口那个模块级判定按设计 §5 作为**类型化回调**注入）；
 * ② 「添加已有对话」与「取消」两处的两连 setState → 域 hook 的 `openSessionPicker()` /
 *    `closeSessionPicker()`（同一语义原先在入口与面板各写了一份，属 §0 去重）。
 * 不多包一层 DOM：返回值仍是 Fragment，与拆分前的 `<>…</>` 一致。
 */
import { api } from '../api.js'
import { Icon } from '../components/Icon.js'
import { Badge, type PendingMap } from '../components/TaskList.js'
import { TaskProgress } from '../components/TaskProgress.js'
import { MarkdownText } from '../components/MarkdownText.js'
import { taskProgressView } from '../taskProgressView.js'
import { eventIcon, eventLabel, fmtTime, roleLabel, shortId, toLocalInput } from '../format.js'
import type { Dict, DshSessionListState, DshSessionSummary, KnowledgeEntry, Task, TaskDetail } from '../viewTypes.js'
import type { WorkbenchSettings } from '../../shared/contracts.js'
import type { StartAISessionFn, UseKnowledgeResult } from '../hooks/useKnowledge.js'
import type { UseTaskListModelResult } from '../hooks/useTaskListModel.js'
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
  /** 列表域模型：仅「恢复任务」成功后用它把列表切出归档态。 */
  taskList: UseTaskListModelResult
  /** AI 会话是否在跑（复盘/子任务按钮的 disabled）。 */
  busy: boolean
  editDraft: TaskEditDraft | null
  setEditDraft: (draft: TaskEditDraft | null) => void
  subtaskParent: Task | null
  setSubtaskParent: (task: Task | null) => void
  startAISession: StartAISessionFn
  setNotice: (message: string) => void
  setError: (message: string) => void
  patchTask: (id: string, patch: Record<string, unknown>) => Promise<void>
  saveProgress: (taskId: string, percent: number) => Promise<void>
  completeTaskFromProgress: (taskId: string) => Promise<void>
  archiveSelectedTask: () => void
  openTask: (task: Task) => void
  refresh: () => Promise<void>
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
  selected, detail, dicts, dictOf, pendingMap, settings, taskKnowledge, knowledge, taskList, busy,
  editDraft, setEditDraft, subtaskParent, setSubtaskParent, startAISession, setNotice, setError, patchTask,
  saveProgress, completeTaskFromProgress, archiveSelectedTask, openTask, refresh, setView, isSessionUsable,
  sessionCandidates, sessionListSnapshot, linkedSessionIds, linkExistingSession, openSessionInPanel,
  addTaskReminder, resetReminderState,
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
'''

view_text = header + dedented + '''
  </>
  )
}
'''

# ── 4. index.tsx 的编辑 ──────────────────────────────────────────────────────
src = replace_once(
    src,
    "import { TaskListView } from './views/TaskListView.js'\n",
    "import { TaskListView } from './views/TaskListView.js'\n"
    "import { useTaskDetailModel } from './hooks/useTaskDetailModel.js'\n"
    "import { TaskDetailPane } from './views/TaskDetailPane.js'\n",
    'import：hook 与视图',
)
src = replace_once(
    src,
    "} from './viewTypes.js'\n",
    "} from './viewTypes.js'\n"
    "import type { TaskEditDraft, WorkbenchView } from './app/contracts.js'\n",
    'import：类型契约',
)
src = replace_once(
    src,
    "const [view, setView] = useState<'today' | 'calendar' | 'list' | 'knowledge' | 'ideas'>('today')",
    'const [view, setView] = useState<WorkbenchView>(\'today\')',
    'state/view 类型改用契约',
)
src = replace_once(
    src,
    'const [editDraft, setEditDraft] = useState<{ title: string; description: string; typeCode: string; '
    'priorityCode: string; statusCode: string; aiPolicyCode: string; dueLocal: string; workspacePath: string; '
    'recurrenceCode: string; parentId: string; estimatedMinutes: string; allDay: boolean } | null>(null)',
    'const [editDraft, setEditDraft] = useState<TaskEditDraft | null>(null)',
    'state/editDraft 类型改用契约',
)
src = replace_once(
    src,
    "  const [detailTab, setDetailTab] = useState<'desc' | 'children' | 'sessions' | 'records'>('desc')\n"
    '  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)\n'
    "  const [sessionPickerRole, setSessionPickerRole] = useState('consult')\n"
    "  const [sessionPickerQuery, setSessionPickerQuery] = useState('')\n"
    '  const [sessionPickerBusy, setSessionPickerBusy] = useState(false)\n'
    '  const [eventsExpanded, setEventsExpanded] = useState(false)\n',
    '  /**\n'
    '   * 任务详情域（D17/P3-2）：原来摊在这里的 6 个 state 收进了 `hooks/useTaskDetailModel.ts`。\n'
    '   *\n'
    '   * 入口自己只需要四样：关联会话时要开关选择器 + 连接期间置忙，打开任务时要复位详情视图。\n'
    '   * 其余读取值（页签、折叠态、选择器是否展开、搜索词…）由 `TaskDetailPane` 直接从 `detail` 取，\n'
    '   * 不再经过本文件 —— 所以这里**只解构入口真正用到的那几个**。\n'
    '   */\n'
    '  const detail = useTaskDetailModel()\n'
    '  const { sessionPickerRole, sessionPickerQuery } = detail\n'
    '  const { setSessionPickerBusy, resetDetailView, closeSessionPicker } = detail.actions\n',
    'state/详情域 6 个 state → hook',
)
src = replace_once(
    src,
    "    setDetailTab('desc')\n    setEventsExpanded(false)\n    loadTaskDetail(task.id)\n",
    '    resetDetailView()\n    loadTaskDetail(task.id)\n',
    'openTask 复位详情',
)
src = replace_once(
    src,
    "    setView('list')\n    setDetailTab('desc')\n    setEventsExpanded(false)\n    loadTaskDetail(taskId)\n",
    "    setView('list')\n    resetDetailView()\n    loadTaskDetail(taskId)\n",
    'openTaskById 复位详情',
)
src = replace_once(
    src,
    "      setSessionPickerOpen(false)\n      setSessionPickerQuery('')\n      await refresh()\n",
    '      closeSessionPicker()\n      await refresh()\n',
    'linkExistingSession 收起选择器',
)

dispatch_props = '''              <TaskDetailPane
                selected={selected}
                detail={detail}
                dicts={dicts}
                dictOf={dictOf}
                pendingMap={pendingMap}
                settings={settings}
                taskKnowledge={taskKnowledge}
                knowledge={knowledge}
                taskList={taskList}
                busy={busy}
                editDraft={editDraft}
                setEditDraft={setEditDraft}
                subtaskParent={subtaskParent}
                setSubtaskParent={setSubtaskParent}
                startAISession={startAISession}
                setNotice={setNotice}
                setError={setError}
                patchTask={patchTask}
                saveProgress={saveProgress}
                completeTaskFromProgress={completeTaskFromProgress}
                archiveSelectedTask={archiveSelectedTask}
                openTask={openTask}
                refresh={refresh}
                setView={setView}
                isSessionUsable={(sessionId) => aiSessionUsable(runtime, sessionId)}
                sessionCandidates={sessionCandidates}
                sessionListSnapshot={sessionListSnapshot}
                linkedSessionIds={linkedSessionIds}
                linkExistingSession={linkExistingSession}
                openSessionInPanel={openSessionInPanel}
                addTaskReminder={addTaskReminder}
                resetReminderState={resetReminderState}
              />'''

old_block = '\n'.join(lines[3039:3374])  # 1-based 3040..3374
src = replace_once(
    src,
    old_block,
    ': (\n' + dispatch_props + '\n            )}',
    '详情 JSX → <TaskDetailPane />',
)

if problems:
    print('ABORT（未写任何文件）：')
    print('\n'.join(problems))
    sys.exit(1)

VIEW.write_text(view_text, encoding='utf-8', newline='\n')
INDEX.write_text(src, encoding='utf-8', newline='\n')
print(f'ok: {VIEW.relative_to(ROOT)} = {view_text.count(chr(10))} 行')
print(f'ok: {INDEX.relative_to(ROOT)} = {src.count(chr(10))} 行')
