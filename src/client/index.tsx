/**
 * dsh-personal-workbench client v0.2 — 方案 A 左右分栏：
 *  - 左侧导航区：今日 / 可导航日历(周/月) / 树状列表（默认折叠、记忆展开）
 *  - 右侧详情区：仅显示选中任务；未选中显示占位
 *  - AI 澄清/咨询/拆解统一跳官方会话区；工作台侧边栏显示待确认草稿红点
 */
import { createRoot, type Root } from 'react-dom/client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildTaskTree,
  countTaskTreeBy,
  createTaskSorter,
  filterTaskTree,
  isTaskDueOnDay,
  isTaskFilterEmpty,
  matchesTaskFilter,
  type TaskFilterState,
  type TaskSortDir,
  type TaskSortKey,
  type TaskTreeNode,
} from './taskFilterSort.js'
import { isWslStylePath, joinPath, normalizeWindowsPathToWsl } from './workspacePath.js'
import { WORKBENCH_CSS } from './styles.js'
import { ACTIVE_ATTR, OFFICIAL_ATTR, PANEL_NAME, PENDING_ATTR, VIEW_ATTR } from './constants.js'
import { panelDataOpen, shouldShowPanel } from './panelState.js'
import { checkHostCapabilities, refuseToStart, type SlotsProbe } from './capabilities.js'
import {
  ENTRY_TITLE, OFFICIAL_MAIN_SLOT, OFFICIAL_OVERLAY_SLOT, OFFICIAL_PANEL_LIST_SLOT,
} from './entryContract.js'
import { Modal } from './components/Modal.js'
import { SettingsModal } from './components/SettingsModal.js'
import { DraftBanner, type DraftConfirmOutcome } from './components/DraftBanner.js'
import { MarkdownText } from './components/MarkdownText.js'
import { ToastHost, useToasts } from './components/Toast.js'
import { api } from './api.js'
import { withSkillPromptBlock } from './skillPrompt.js'
import type {
  DraftView,
  ReminderChannelStatus as ReminderChannelView,
  ReminderOptionsView,
  ReminderPolicyView,
  SkillsResponse,
  SkillSummary,
  WorkbenchSettings,
} from '../shared/contracts.js'
import { Icon } from './components/Icon.js'
import { Badge, MultiSelectDropdown, TaskTreeRows, countTaskTree } from './components/TaskList.js'
import { PlanPanel } from './components/PlanPanel.js'
import {
  clientFileLinkToPath, draftKindLabel, eventIcon, eventLabel, fmtTime, folderForText, localDateString,
  roleLabel, sameDay, shortId, startOfDay, startOfWeek, toLocalInput,
} from './format.js'
import type {
  Bootstrap, DailyPlanItemView, DailyPlanView, Dict, DshSessionListState, DshSessionSummary, Idea, IdeaClusterView,
  KnowledgeEntry, SessionDriver, Task, TaskDetail, TaskReportView, WorkbenchRuntime,
} from './viewTypes.js'

const CSS = WORKBENCH_CSS


function WorkbenchApp({ runtime, closePanel }: { runtime: WorkbenchRuntime; closePanel: () => void }): JSX.Element {
  const [view, setView] = useState<'today' | 'calendar' | 'list' | 'knowledge' | 'ideas'>('today')
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState<TaskDetail | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [subtaskParent, setSubtaskParent] = useState<Task | null>(null)
  const [editDraft, setEditDraft] = useState<{ title: string; description: string; typeCode: string; priorityCode: string; statusCode: string; aiPolicyCode: string; dueLocal: string; workspacePath: string; recurrenceCode: string; parentId: string } | null>(null)
  const [detailTab, setDetailTab] = useState<'desc' | 'children' | 'sessions' | 'records'>('desc')
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  const [sessionPickerRole, setSessionPickerRole] = useState('consult')
  const [sessionPickerQuery, setSessionPickerQuery] = useState('')
  const [sessionPickerBusy, setSessionPickerBusy] = useState(false)
  const [eventsExpanded, setEventsExpanded] = useState(false)
  const [showQuick, setShowQuick] = useState(false)
  const [quickText, setQuickText] = useState('')
  /**
   * 快速录入的工作区选择（v1.14.0）。
   * - `quickWorkspace`：用户最终采用的工作区路径（空 = 交给既有隐式逻辑）。
   * - `quickWorkspaceTouched`：用户是否动过它 —— 决定来源提示显示"默认值"还是"手动指定"。
   * - `quickFollowFolder`：勾选时按任务标题在所选工作区下建子文件夹（复刻旧默认行为）。
   */
  const [quickWorkspace, setQuickWorkspace] = useState('')
  const [quickWorkspaceTouched, setQuickWorkspaceTouched] = useState(false)
  const [quickFollowFolder, setQuickFollowFolder] = useState(false)
  const [pendingDraft, setPendingDraft] = useState<DraftView | null>(null)
  // 已暂存的待确认草稿：不自动弹窗，只在「待处理」弹窗里等你唤回
  const [deferredDrafts, setDeferredDrafts] = useState<DraftView[]>([])
  /**
   * 确认草稿时「本该创建但没创建」的条目（v1.14.0 静默丢件修复的界面侧）。
   * 用常驻横幅而不是 toast：这是"你的东西少了一部分"的告警，不能 4 秒后自己消失。
   */
  const [draftProblems, setDraftProblems] = useState<Array<{ title: string; field: string; code: string; reason: string }>>([])
  /**
   * 已被用户处理过的草稿 id（v1.14.2）。
   *
   * 为什么必须记：待确认草稿有**两个数据源** —— 5 秒轮询的 `/api/workbench/drafts`
   * 与弹框自身的操作结果。用户点了"放弃/确认"之后，如果那个请求失败了
   * （例如并发点击导致"already abandoned"），轮询仍会返回这份草稿，
   * 于是弹框被重新推上来 —— 用户看到的就是"关掉 5 秒后又弹出来"。
   *
   * ⚠️ 语义边界（2026-09-15 修正）：这个集合只管**"要不要自动弹窗"**，
   * **不参与「待处理」计数**。之前用它同时过滤计数，导致"点一次关闭，
   * 右上角待处理就从 1 变 0"（用户实测）—— 而草稿在服务端仍然是 pending，
   * 计数撒谎比不弹窗更糟。计数一律以服务端数据为准。
   */
  const dismissedDraftIdsRef = useRef<Set<string>>(new Set())
  /**
   * 「屏蔽这份草稿时，它处于暂存态」的 id 集合。
   *
   * 只用于识别"暂存 → 唤回"这一次状态转换：唤回后应当解除屏蔽、重新弹框；
   * 而用户单纯点 X 收起（草稿从来不是暂存态）时**不能**因此解除，否则弹框会自己回来。
   */
  const deferredWhenDismissedRef = useRef<Set<string>>(new Set())
  /**
   * 弹框当前显示的是哪一份草稿，以及"这次是被递补上来的"这件事。
   *
   * `draftSwitchedFrom` 非空 = 上一份草稿被收起后，服务端递补了**另一种类型**的草稿上来。
   * 只在类型变化时提示：同类型的下一份（例如两条 task 草稿）不值得打断用户。
   *
   * 为什么需要它（2026-09-13 重复建单事故）：弹框长得一模一样，用户点「暂存」收起
   * 验收申请之后，递补上来的是一份 task 草稿 —— 用户接着点主按钮，确认的已经不是
   * 他以为的那一份，于是库里多出一条同名任务。
   */
  const bannerDraftRef = useRef<DraftView | null>(null)
  const [draftSwitchedFrom, setDraftSwitchedFrom] = useState<{ kindCode: string; draftId: string } | null>(null)
  /**
   * 服务端当前**全部** pending 草稿（含"看过就收起"的）。
   * 「待处理」计数用它，绝不用本地过滤后的 `pendingDraft` —— 否则点一次关闭
   * 计数就掉 0，而草稿其实还在等用户处理（2026-09-15 用户实测的 BUG）。
   */
  const [allPendingDrafts, setAllPendingDrafts] = useState<DraftView[]>([])
  const [reminders, setReminders] = useState<Array<{ reminderId: string; taskId: string; title: string; dueAt: string; methodCode: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reminderModalOpen, setReminderModalOpen] = useState(false)
  const [pendingOpen, setPendingOpen] = useState(false)
  /**
   * 「库里已有同名任务」的待决提示（2026-09-13 重复建单事故的界面侧收口）。
   *
   * 服务端**只告警、不静默合并**（同名任务可能是正当需求，例如每周例会），
   * 所以这里给用户两件明确的事：保留两条，或者把这条草稿收口到已有那条上（不再新建）。
   */
  const [duplicatePrompt, setDuplicatePrompt] = useState<{
    draftId: string
    existingTaskId: string
    existingTitle: string
    sameDescription: boolean
    sameWorkspace: boolean
    /** 本次已经建出来的那条（"就删掉这条新建的"用得上）。 */
    newTaskId: string
  } | null>(null)
  const [settings, setSettings] = useState<WorkbenchSettings>({ defaultWorkspace: '', autoCreateTypeFolders: true, desktopNotify: true, dailyCapacityMinutes: 390, quickWorkspaceRecent: [] })
  /** 今日容量里「可投入时长」的行内编辑态（null = 只读展示） */
  const [capacityEdit, setCapacityEdit] = useState<string | null>(null)
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermission | 'unsupported'>(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const { toasts, pushToast, dismissToast } = useToasts()
  // 微信提醒：策略 + 通道状态（通道可用性由 dsh-im 决定，未安装时静默降级）
  const [reminderPolicy, setReminderPolicy] = useState<ReminderPolicyView | null>(null)
  const [reminderChannel, setReminderChannel] = useState<ReminderChannelView | null>(null)
  const [reminderOptions, setReminderOptions] = useState<ReminderOptionsView | null>(null)
  const [reminderBusy, setReminderBusy] = useState(false)
  const [dictKind, setDictKind] = useState<'type' | 'status' | 'priority' | 'idea_kind'>('type')
  const [dictForm, setDictForm] = useState<{ name: string; code: string; color: string; sortOrder: number } | null>(null)
  const [dictEditCode, setDictEditCode] = useState<string | null>(null)
  const [dictError, setDictError] = useState<string | null>(null)
  const [reportSubTab, setReportSubTab] = useState<'day' | 'week'>('day')
  const [currentReport, setCurrentReport] = useState<TaskReportView | null>(null)
  const [reportSession, setReportSession] = useState<{ sessionId: string } | null>(null)
  const [pickedPlan, setPickedPlan] = useState<DailyPlanView | null>(null)
  const [pickedPlanSession, setPickedPlanSession] = useState<{ sessionId: string } | null>(null)
  const [planRefreshKey, setPlanRefreshKey] = useState(0)
  const [knowledgeEntries, setKnowledgeEntries] = useState<KnowledgeEntry[]>([])
  const [knowledgeQuery, setKnowledgeQuery] = useState('')
  const [knowledgeKind, setKnowledgeKind] = useState<string>('')
  const [selectedKnowledge, setSelectedKnowledge] = useState<KnowledgeEntry | null>(null)
  const [knowledgeDraft, setKnowledgeDraft] = useState<{ title: string; contentMd: string; kindCode: string; tags: string; sourceTaskId: string; sourceReviewId: string; fileLink: string } | null>(null)
  const [knowledgeEditId, setKnowledgeEditId] = useState<string | null>(null)
  const [knowledgeRefreshKey, setKnowledgeRefreshKey] = useState(0)
  const [localDocPath, setLocalDocPath] = useState('')
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [filePickerDir, setFilePickerDir] = useState('')
  const [filePickerParent, setFilePickerParent] = useState<string | null>(null)
  const [filePickerEntries, setFilePickerEntries] = useState<Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean; hidden: boolean }>>([])
  const [filePickerLoading, setFilePickerLoading] = useState(false)
  const [filePickerError, setFilePickerError] = useState<string | null>(null)
  const [taskKnowledge, setTaskKnowledge] = useState<KnowledgeEntry[]>([])
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [ideaClusters, setIdeaClusters] = useState<IdeaClusterView[]>([])
  const [ideaTab, setIdeaTab] = useState<'ideas' | 'unfiled' | 'clusters'>('ideas')
  const [ideaQuery, setIdeaQuery] = useState('')
  const [ideaKind, setIdeaKind] = useState('')
  const [selectedIdeaIds, setSelectedIdeaIds] = useState<Set<string>>(new Set())
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null)
  const [selectedCluster, setSelectedCluster] = useState<IdeaClusterView | null>(null)
  const [ideaForm, setIdeaForm] = useState<{ title: string; contentMd: string; kindCode: string; tags: string } | null>(null)
  const [ideaEditId, setIdeaEditId] = useState<string | null>(null)
  // 文件夹（= 点子王）管理：新建/改名表单，以及「归入文件夹」菜单展开的卡片
  const [folderForm, setFolderForm] = useState<{ mode: 'create' | 'rename'; id: string | null; title: string; summaryMd: string } | null>(null)
  const [folderMenuIdeaId, setFolderMenuIdeaId] = useState<string | null>(null)
  const [ideaRefreshKey, setIdeaRefreshKey] = useState(0)
  const [reportRefreshKey, setReportRefreshKey] = useState(0)
  const [todayPlanSession, setTodayPlanSession] = useState<{ sessionId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [promptModal, setPromptModal] = useState<{ title: string; value: string } | null>(null)
  const promptResolveRef = useRef<((value: { text: string; skills: string[] } | null) => void) | null>(null)
  // AI 会话前的 Skill 选择器：列表来自宿主 skills 注册表（未安装时 available=false，选择器隐藏）
  const [skillCatalog, setSkillCatalog] = useState<SkillSummary[]>([])
  const [skillsAvailable, setSkillsAvailable] = useState(false)
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const selectedRef = useRef<string | null>(null)

  const dicts = useMemo(() => bootstrap?.dictionaries ?? [], [bootstrap])
  const dictOf = useCallback((kind: string) => dicts.filter((d) => d.kind === kind), [dicts])

  const refresh = useCallback(async () => {
    const [boot, list] = await Promise.all([api<Bootstrap>('/api/workbench/bootstrap'), api<{ tasks: Task[] }>('/api/workbench/tasks')])
    setBootstrap(boot); setTasks(list.tasks)
    if (selectedRef.current !== null) {
      try {
        const [detail, ev, rv] = await Promise.all([
          api<TaskDetail>(`/api/workbench/tasks/${selectedRef.current}`),
          api<{ events: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${selectedRef.current}/events`).catch(() => ({ events: [] })),
          api<{ reviews: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${selectedRef.current}/reviews`).catch(() => ({ reviews: [] })),
          loadTaskKnowledge(selectedRef.current).catch(() => setTaskKnowledge([])),
        ])
        setSelected({ ...detail, events: ev.events, reviews: rv.reviews })
      } catch { setSelected(null); selectedRef.current = null }
    }
  }, [])

  /** 技能目录：打开提示词弹窗时按需拉取一次；失败时降级为空目录（选择器隐藏）。 */
  const loadSkills = useCallback(async (): Promise<void> => {
    setSkillsLoading(true)
    try {
      const res = await api<SkillsResponse>('/api/workbench/skills')
      setSkillCatalog(res.skills)
      setSkillsAvailable(res.available && res.skills.length > 0)
    } catch {
      setSkillCatalog([]); setSkillsAvailable(false)
    } finally { setSkillsLoading(false) }
  }, [])

  const loadKnowledge = useCallback(async () => {
    const params = new URLSearchParams()
    if (knowledgeQuery.trim() !== '') params.set('q', knowledgeQuery.trim())
    if (knowledgeKind !== '') params.set('kind_code', knowledgeKind)
    const qs = params.toString()
    const res = await api<{ entries: KnowledgeEntry[] }>(`/api/workbench/knowledge${qs === '' ? '' : `?${qs}`}`)
    setKnowledgeEntries(res.entries)
  }, [knowledgeQuery, knowledgeKind])
  useEffect(() => {
    if (view === 'knowledge') void loadKnowledge().catch(() => undefined)
  }, [view, loadKnowledge, knowledgeRefreshKey])
  const loadIdeas = useCallback(async () => {
    const params = new URLSearchParams()
    if (ideaQuery.trim() !== '') params.set('q', ideaQuery.trim())
    if (ideaKind !== '') params.set('kind_code', ideaKind)
    const qs = params.toString()
    const [ideasRes, clustersRes] = await Promise.all([
      api<{ ideas: Idea[] }>(`/api/workbench/ideas${qs === '' ? '' : `?${qs}`}`),
      api<{ clusters: IdeaClusterView[] }>('/api/workbench/idea-clusters'),
    ])
    setIdeas(ideasRes.ideas); setIdeaClusters(clustersRes.clusters)
  }, [ideaQuery, ideaKind])
  useEffect(() => {
    if (view === 'ideas') void loadIdeas().catch(() => undefined)
  }, [view, loadIdeas, ideaRefreshKey])
  useEffect(() => { void refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) }, [refresh])
  useEffect(() => { void api<{ settings: WorkbenchSettings }>('/api/workbench/settings').then((r) => setSettings(r.settings)).catch(() => undefined) }, [])

  // 打开设置面板时加载微信提醒策略与通道状态（含自动发现的可选投递目标）
  useEffect(() => {
    if (!showSettings) return
    void Promise.all([
      api<{ policy: ReminderPolicyView }>('/api/workbench/reminders/policy'),
      api<{ status: ReminderChannelView; options: ReminderOptionsView }>('/api/workbench/reminders/channel'),
    ]).then(([policyResult, channelResult]) => {
      setReminderPolicy(policyResult.policy)
      setReminderChannel(channelResult.status)
      setReminderOptions(channelResult.options)
    }).catch(() => undefined)
  }, [showSettings])

  /**
   * 桌面通知去重集合：持久化到 localStorage。
   * 原先是纯内存 Set，刷新页面就会对同一条提醒重发一次系统通知。现在跨会话记住，
   * 并在条目数超过上限时淘汰最旧的一半（避免无限增长）。
   */
  const notifiedRef = useRef<Set<string>>((() => {
    try {
      const raw = window.localStorage.getItem('dsh-workbench:desktop-notified')
      const parsed: unknown = raw === null ? [] : JSON.parse(raw)
      return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === 'string')) : new Set<string>()
    } catch { return new Set<string>() }
  })())
  const persistNotified = (): void => {
    try {
      const ids = [...notifiedRef.current]
      const trimmed = ids.length > 500 ? ids.slice(-250) : ids
      notifiedRef.current = new Set(trimmed)
      window.localStorage.setItem('dsh-workbench:desktop-notified', JSON.stringify(trimmed))
    } catch { /* localStorage 不可用时退化为内存去重 */ }
  }

  // 提示 / 错误统一转成右上角 toast：不再作为文档流横幅把任务列表挤下去。
  // 保留既有 setNotice/setError 调用点不变，在这里做一次桥接。
  useEffect(() => {
    if (notice !== null) { pushToast(notice, 'success'); setNotice(null) }
  }, [notice, pushToast])
  useEffect(() => {
    if (error !== null) { pushToast(error, 'error'); setError(null) }
  }, [error, pushToast])

  // 有到期提醒时自动弹出提醒弹窗（关掉后本次不再自动弹；新提醒到达会再弹一次）。
  useEffect(() => {
    if (reminders.length > 0) setReminderModalOpen(true)
  }, [reminders.length])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const res = await api<{ draft: DraftView | null; deferredDrafts?: DraftView[] }>('/api/workbench/drafts')
        /**
         * 已"看过就收起"的草稿不再自动弹窗，但**照样计入「待处理」**：
         * `allPendingDrafts` 存服务端事实（用于计数与清单），
         * `pendingDraft` 才是"要不要弹"。两者分开，计数才不会被本地操作污染。
         */
        const dismissed = dismissedDraftIdsRef.current
        const serverDrafts = [res.draft, ...(res.deferredDrafts ?? [])].filter((d): d is DraftView => d !== null && d !== undefined)
        /**
         * 兜底（v1.14.23）：**屏蔽时它是"已暂存"，现在服务端说它"待确认"→ 解除屏蔽。**
         *
         * 这条只针对"暂存 → 唤回"这一种状态转换：用户（或别的会话）明确把一份
         * 被暂存的草稿叫回来了，就该弹。
         *
         * ⚠️ 不能用"只要 deferredAt 为空就解除"来判断 —— 用户点 X 收起弹框时，
         * 草稿本来就不是暂存状态，那样会在下一轮轮询把屏蔽清掉，**弹框 5 秒后又冒出来**
         * （这正是最早修过的 BUG）。所以必须记住"屏蔽它的时候，它是否处于暂存态"。
         */
        if (res.draft !== null && res.draft.deferredAt === null
          && deferredWhenDismissedRef.current.has(res.draft.id) && dismissed.has(res.draft.id)) {
          dismissed.delete(res.draft.id)
          deferredWhenDismissedRef.current.delete(res.draft.id)
        }
        const nextDraft = res.draft !== null && dismissed.has(res.draft.id) ? null : res.draft
        if (alive) {
          /**
           * ⚠️ **弹框被"静默换人"时必须说出来**（2026-09-13 重复建单事故的界面侧防线）。
           *
           * 事故形态：用户暂存了最新那份草稿（例如验收申请），服务端按"最新活动草稿"
           * 递补下一份 —— 而递补上来的可能是**另一种类型**的草稿（例如一份任务草稿）。
           * 弹框长得一模一样，用户接着点主按钮时，确认的已经不是他以为的那一份了。
           *
           * 实测证据（`node scripts/repro/repro-banner.mjs`）：暂存验收草稿之后，
           * 弹框内容确实会从 `completion` 换成 `task`。
           *
           * 这里不改变递补行为（`getLatestActiveDraft` 的语义没动），只保证
           * **换人这件事一定可见**：类型/来源不同时，弹框里挂一条醒目提示。
           */
          const previous = bannerDraftRef.current
          if (previous !== null && nextDraft !== null && previous.id !== nextDraft.id && previous.kindCode !== nextDraft.kindCode) {
            setDraftSwitchedFrom({ kindCode: previous.kindCode, draftId: previous.id })
          } else if (nextDraft !== null && (previous === null || previous.id !== nextDraft.id)) {
            setDraftSwitchedFrom(null)
          }
          bannerDraftRef.current = nextDraft
          setPendingDraft(nextDraft)
          setAllPendingDrafts(serverDrafts)
          setDeferredDrafts(res.deferredDrafts ?? [])
        }
        const r = await api<{ reminders: Array<{ reminderId: string; taskId: string; title: string; dueAt: string; methodCode: string }> }>('/api/workbench/reminders/due')
        if (!alive) return
        setReminders(r.reminders)
        // 系统级桌面提醒：启用且浏览器已授权时，对每个到期提醒发一次系统通知。
        if (settings.desktopNotify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          let notifiedAny = false
          for (const reminder of r.reminders) {
            if (notifiedRef.current.has(reminder.reminderId)) continue
            notifiedRef.current.add(reminder.reminderId)
            notifiedAny = true
            try {
              new Notification(`任务提醒：${reminder.title}`, {
                body: `截止时间：${fmtTime(reminder.dueAt)}`,
                tag: `dsh-personal-workbench:${reminder.reminderId}`,
              })
            } catch { /* 部分浏览器限制通知构造，忽略降级为页内横幅 */ }
          }
          if (notifiedAny) persistNotified()
        }
      } catch { /* 轮询失败下轮重试 */ }
    }
    void tick()
    const timer = setInterval(() => void tick(), 5000)
    const refreshTimer = setInterval(() => { void refresh().catch(() => undefined) }, 15000)
    return () => { alive = false; clearInterval(timer); clearInterval(refreshTimer) }
  }, [refresh, settings.desktopNotify])

  useEffect(() => { setEditDraft(null); setSubtaskParent(null) }, [selected?.task.id])

  useEffect(() => {
    if (pendingDraft !== null) document.documentElement.setAttribute(PENDING_ATTR, '')
    else document.documentElement.removeAttribute(PENDING_ATTR)
    return () => document.documentElement.removeAttribute(PENDING_ATTR)
  }, [pendingDraft])

  const loadTaskKnowledge = async (taskId: string): Promise<void> => {
    const res = await api<{ entries: KnowledgeEntry[] }>(`/api/workbench/knowledge?source_task_id=${encodeURIComponent(taskId)}`)
    setTaskKnowledge(res.entries)
  }
  const openTask = (task: Task): void => {
    selectedRef.current = task.id
    setDetailTab('desc')
    setEventsExpanded(false)
    void Promise.all([
      api<TaskDetail>(`/api/workbench/tasks/${task.id}`),
      api<{ events: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${task.id}/events`).catch(() => ({ events: [] })),
      api<{ reviews: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${task.id}/reviews`).catch(() => ({ reviews: [] })),
      loadTaskKnowledge(task.id).catch(() => setTaskKnowledge([])),
    ]).then(([detail, ev, rv]) => setSelected({ ...detail, events: ev.events, reviews: rv.reviews })).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const openTaskById = (taskId: string): void => {
    setView('list')
    selectedRef.current = taskId
    setDetailTab('desc')
    setEventsExpanded(false)
    void Promise.all([
      api<TaskDetail>(`/api/workbench/tasks/${taskId}`),
      api<{ events: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${taskId}/events`).catch(() => ({ events: [] })),
      api<{ reviews: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${taskId}/reviews`).catch(() => ({ reviews: [] })),
      loadTaskKnowledge(taskId).catch(() => setTaskKnowledge([])),
    ]).then(([detail, ev, rv]) => setSelected({ ...detail, events: ev.events, reviews: rv.reviews })).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const patchTask = async (id: string, patch: Record<string, unknown>): Promise<void> => {
    await api(`/api/workbench/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    await refresh()
  }
  const completePlanTask = async (taskId: string): Promise<void> => {
    await patchTask(taskId, { statusCode: 'done' })
  }
  const deferPlanTask = async (taskId: string): Promise<void> => {
    const task = tasks.find((t) => t.id === taskId)
    if (task === undefined) return
    const base = task.effectiveDueAt !== null ? new Date(task.effectiveDueAt) : new Date()
    const next = new Date(base)
    next.setDate(next.getDate() + 1)
    await patchTask(taskId, { dueAt: next.toISOString() })
    setNotice(`已推迟到 ${next.getMonth() + 1}/${next.getDate()}`)
  }
  /** 用户点「知道了」：写 acknowledged_at（终态），并把这条从待处理列表移除。 */
  const ackReminder = async (reminderId: string): Promise<void> => {
    try {
      await api(`/api/workbench/reminders/${reminderId}/ack`, { method: 'POST' })
    } catch {
      // 老版本宿主没有 ack 端点时优雅退回 fire（写 fired_at）
      await api(`/api/workbench/reminders/${reminderId}/fire`, { method: 'POST' }).catch(() => undefined)
    }
    setReminders((list) => list.filter((r) => r.reminderId !== reminderId))
    if (selectedRef.current !== null) await refresh()
  }
  /** 重新武装：清掉 fired/skipped/acknowledged，提醒回到「未处理」。 */
  const resetReminderState = async (reminderId: string): Promise<void> => {
    try {
      await api(`/api/workbench/reminders/${reminderId}/reset`, { method: 'POST' })
      setNotice('提醒已重新武装，到点会再次提醒')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const addTaskReminder = async (offsetMinutes: number): Promise<void> => {
    const taskId = selectedRef.current
    if (taskId === null) return
    try {
      await api(`/api/workbench/tasks/${taskId}/reminders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offsetMinutes, methodCode: 'browser' }) })
      setNotice(offsetMinutes === 0 ? '已添加“准时”提醒' : `已添加“提前 ${offsetMinutes} 分钟”提醒`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const linkExistingSession = async (sessionId: string): Promise<void> => {
    const taskId = selectedRef.current
    if (taskId === null) return
    setSessionPickerBusy(true)
    try {
      await api(`/api/workbench/tasks/${taskId}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, roleCode: sessionPickerRole }) })
      setNotice('已关联到任务')
      setSessionPickerOpen(false)
      setSessionPickerQuery('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSessionPickerBusy(false)
    }
  }

  const askUserPrompt = (title: string): Promise<{ text: string; skills: string[] } | null> => new Promise((resolve) => {
    promptResolveRef.current = resolve
    setPromptModal({ title, value: '' })
    setSkillQuery('')
    setSelectedSkills([])
    void loadSkills()
  })
  const confirmPrompt = (): void => {
    const resolve = promptResolveRef.current
    promptResolveRef.current = null
    const value = promptModal?.value ?? ''
    const skills = [...selectedSkills]
    setPromptModal(null)
    resolve?.({ text: value, skills })
  }
  const cancelPrompt = (): void => {
    const resolve = promptResolveRef.current
    promptResolveRef.current = null
    setPromptModal(null)
    resolve?.(null)
  }
  const toggleSkill = (name: string): void => {
    setSelectedSkills((prev) => prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name])
  }
  const AI_PROMPT_LABELS: Record<string, string> = {
    plan: 'AI 智能排序 / 今日计划',
    consult: 'AI 咨询',
    breakdown: 'AI 拆解',
    execute: 'AI 执行',
    review: 'AI 复盘',
    report: 'AI 日报 / 周报',
    idea_association: 'AI 点子关联',
    idea_brainstorm: 'AI 点子头脑风暴',
    knowledge_doc: 'AI 总结本地文档',
  }
  /**
   * 启动 AI 会话。
   *
   * `workspaceOverride`（v1.14.0）来自「快速录入 / 澄清」弹窗里用户**显式选择**的工作区：
   * 之前用户在录入那一刻无法指定工作区，只能接受"父任务继承 → 否则默认工作区 +
   * 按标题建子文件夹"这套隐式规则。传了覆盖值就**逐字使用**它（含不建子文件夹），
   * 不传则行为与改动前完全一致（零回归）。
   */
  const startAISession = async (mode: 'clarify' | 'consult' | 'breakdown' | 'execute' | 'review' | 'plan' | 'report' | 'idea_association' | 'idea_brainstorm' | 'knowledge_doc', task: Task | null, text: string, previousSessions: Array<Record<string, unknown>> = [], docContext?: { fileLink: string; content: string; name?: string; truncated?: boolean }, workspaceOverride?: string): Promise<void> => {
    if (mode === 'clarify' && text.trim() === '') return
    // 澄清会话由自然语言快速录入直接触发，不弹提示词弹窗，也不参与技能选择（保持原流程）。
    const promptInput = mode === 'clarify' ? { text: '', skills: [] as string[] } : await askUserPrompt(AI_PROMPT_LABELS[mode] ?? 'AI 会话')
    if (promptInput === null) return
    const customPrompt = promptInput.text
    const skillNames = promptInput.skills
    const planAnchor = mode === 'plan' ? (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : localDateString()) : ''
    setBusy(true); setError(null)
    try {
      // 复用型会话：计划/报告/点子关联/点子头脑风暴，每个 scope+anchor 只有一个会话。
      if (mode === 'plan' || mode === 'report' || mode === 'idea_association' || mode === 'idea_brainstorm') {
        const [scopeCode, anchor] = mode === 'plan'
          ? ['daily_plan', planAnchor]
          : mode === 'idea_association' ? ['idea_association', text]
          : mode === 'idea_brainstorm' ? ['idea_brainstorm', text]
          : text.startsWith('week:') ? ['week_report', text.slice(5)] : ['day_report', text.slice(4)]
        const existing = await api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=${scopeCode}&anchor=${anchor}`)
        if (existing.session !== null) {
          let shouldReuse = true
          if (mode === 'plan') {
            const hasPlan = planAnchor === localDateString()
              ? todayPlan !== null
              : pickedPlan !== null && pickedPlan.planDate === planAnchor
            const hasPendingPlanDraft = pendingDraft !== null && pendingDraft.kindCode === 'daily_plan' && String(pendingDraft.payload.planDate ?? '') === planAnchor
            shouldReuse = hasPlan || hasPendingPlanDraft
          }
          if (shouldReuse) {
            // 先开会话再关面板（关面板会卸载本面板的 React 树，顺序反了就"点了没反应"）
            safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')?.open(existing.session.sessionId)
            closePanel()
            return
          }
        }
        if (mode === 'report') {
          // 旧版本生成的报告可能还没有登记会话：直接复用报告里的 session_id。
          const periodCode = text.startsWith('week:') ? 'week' : 'day'
          const rep = await api<{ report: { sessionId?: string | null } | null }>(`/api/workbench/reports/${periodCode}/${anchor}`)
          if (typeof rep.report?.sessionId === 'string' && rep.report.sessionId !== '') {
            safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')?.open(rep.report.sessionId)
            closePanel()
            return
          }
        }
      }
      const ws = safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.list?.getSnapshot?.() ?? { items: [] }
      let workspaceId = ws.items[0]?.workspaceId
      /**
       * ⚠️ 与 `detectWslHost` 同一个坑（v1.14.50 一起修）：
       * `?.generation.getSnapshot()` 只保护了外层，`generation` 在低版本宿主上不存在 →
       * 直接抛 `TypeError: … reading 'getSnapshot'`。
       * 这里在**创建 AI 会话的主流程**上，抛错会让"发起澄清/执行"整条链路失败。
       */
      const hostHome = safeService<WorkbenchRuntime['connection']>(runtime, 'connection')?.generation?.getSnapshot?.()?.host?.home
      const isWsl = hostHome !== undefined
        ? isWslStylePath(hostHome)
        : ws.items.some((item) => typeof item.path === 'string' && isWslStylePath(item.path))
      const pathSep = isWsl ? '/' : '\\'
      let desired = ''
      const explicitWorkspace = workspaceOverride?.trim() ?? ''
      if (explicitWorkspace !== '') {
        // 用户在录入弹窗里显式选了工作区：逐字使用，不走下面任何隐式推导
        // （也不按标题建子文件夹 —— 用户选的是"就在这个目录里做"）。
        desired = explicitWorkspace
      } else if (task !== null) {
        // 有效工作区 = 自身 workspacePath，未设置时继承最近祖先的设置（与 effectiveDueAt 同构）。
        // 继承到值就直接用，不再按任务标题建子文件夹——否则子任务会各自散到新目录里。
        desired = task.effectiveWorkspacePath ?? ''
        if (desired === '' && settings.defaultWorkspace !== '' && settings.autoCreateTypeFolders) {
          desired = joinPath(settings.defaultWorkspace, folderForText(task.title), pathSep)
        }
      } else if (mode === 'clarify' && settings.defaultWorkspace !== '' && settings.autoCreateTypeFolders) {
        desired = joinPath(settings.defaultWorkspace, folderForText(text || '需求澄清'), pathSep)
      }
      // WSL 下把 Windows 盘符路径（D:\Code）统一归一化为真实路径（/mnt/d/Code）。
      // 相对路径和已是 /mnt/... 的路径不会被转换；原生 Windows 上不做转换。
      const normalizedDesired = desired === '' ? '' : isWsl ? normalizeWindowsPathToWsl(desired) : desired
      if (normalizedDesired !== '') {
        try {
          await api('/api/workbench/workspaces/ensure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: normalizedDesired }) })
          const created = await safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.create?.({ path: normalizedDesired })
          if (typeof created?.workspaceId === 'string' && created.workspaceId !== '') workspaceId = created.workspaceId
          // 任务自身和祖先都没有工作区时，把解析出的任务文件夹回写，保证后续会话都进同一文件夹
          if (task !== null && task.workspacePath === null && task.effectiveWorkspacePath === null && normalizedDesired !== '') {
            void api(`/api/workbench/tasks/${task.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspacePath: normalizedDesired }) }).catch(() => undefined)
          }
        } catch (workspaceError) {
          // 用户**显式**选的工作区建不出来时必须报错，不能静默回落默认工作区
          // ——否则用户以为自己选好了，会话却开在别的目录里（v1.14.0 验收标准之一）。
          if (explicitWorkspace !== '') {
            throw new Error(`工作区「${normalizedDesired}」不可用（${workspaceError instanceof Error ? workspaceError.message : String(workspaceError)}）。请检查路径是否存在、是否可写，或改回默认工作区。`)
          }
          /* 隐式推导失败则回退当前工作区（与改动前一致） */
        }
      }
      if (workspaceId === undefined) throw new Error('没有可用工作区，请先在 DSH 中打开一个工作区')
      const id = await connectWorkspace(workspaceId)
      // 死上下文防护：`connectWorkspace` 里有 await，期间插件可能已被卸载/重载，
      // 此时读 sessions 会抛 "inactive context"（用户控制台实测的主要报错来源）。
      if (!instanceAlive) return
      const sessions = safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')
      const binding = sessions?.binding(id)
      if (binding === undefined) throw new Error('会话绑定未就绪，请稍后重试')
      await binding.session.rename(mode === 'idea_association' ? '点子关联' : mode === 'idea_brainstorm' ? '点子头脑风暴' : mode === 'knowledge_doc' ? `知识总结：${docContext?.name ?? '本地文档'}` : mode === 'report' ? `${text.startsWith('week:') ? '周报' : '日报'}：${text.split(':')[1] ?? ''}` : mode === 'plan' ? `AI 计划：${planAnchor.slice(5)}` : mode === 'clarify' ? `澄清：${text.slice(0, 24)}` : mode === 'consult' ? `协助：${task?.title.slice(0, 24)}` : mode === 'breakdown' ? `拆解：${task?.title.slice(0, 24)}` : mode === 'review' ? `复盘：${task?.title.slice(0, 24)}` : `执行：${task?.title.slice(0, 24)}`).catch(() => undefined)
      let reportContextText = ''
      if (mode === 'report') {
        const [periodCode, periodStart] = text.split(':')
        const contextRes = await api<{ context: Record<string, unknown> }>(`/api/workbench/reports/context?period_code=${encodeURIComponent(periodCode)}&period_start=${encodeURIComponent(periodStart)}`)
        reportContextText = JSON.stringify(contextRes.context, null, 2)
      }
      const planDayStart = new Date(`${planAnchor}T00:00:00`)
      const planDayEnd = new Date(planDayStart)
      planDayEnd.setDate(planDayEnd.getDate() + 1)
      const planCandidates = tasks
        .filter((t) => t.statusCode !== 'done' && t.statusCode !== 'cancelled')
        .filter((t) => t.recurrenceCode === null || t.recurrenceCode === 'none')
        .filter((t) => (t.effectiveDueAt !== null && Date.parse(t.effectiveDueAt) < planDayEnd.getTime()) || (planAnchor === localDateString() && t.effectiveDueAt === null))
        .slice(0, 30)
      const planTaskLines = planCandidates
        .map((t, i) => `${i + 1}. [${t.id}] ${t.title} | 优先级 ${t.priorityCode} | 状态 ${t.statusCode} | 截止 ${t.effectiveDueAt ?? '无'} | 预计耗时 ${t.estimatedMinutes ?? '未知'} 分钟 | 父任务 ${t.parentId ?? '无'}`)
        .join('\n')
      // 任务/子树共享记忆：父任务会话会加载整棵子树上下文，子任务会话也能看到同树记忆。
      let memoryContext = ''
      if (task !== null && (mode === 'execute' || mode === 'consult' || mode === 'breakdown' || mode === 'review')) {
        try {
          const memRes = await api<{ context: string }>(`/api/workbench/tasks/${task.id}/memory-context`)
          memoryContext = memRes.context
        } catch { memoryContext = '' }
      }
      let ideaPrompt = ''
      if (mode === 'idea_association') {
        const selected = ideas.filter((idea) => text.split(',').includes(idea.id))
        const lines = selected.map((idea, i) => `${i + 1}. [${idea.id}] ${idea.title} | 类型 ${idea.kindCode} | 标签 ${idea.tags.join(',') || '无'}\n   ${idea.contentMd || '（无内容）'}`).join('\n')
        ideaPrompt = `你是“个人工作台”的点子关联助手。请分析下面的点子，把它们按主题关联成若干个“点子王”（每组 2 个点子以上，点子尽量不重复跨组；若只能成一组也可以）。\n\n候选点子：\n${lines}\n\n请调用 workbench_propose_idea_clusters：\n- clusters: [{title, summary, idea_ids, notes?}]\n- title 简洁有主题感（例如“AI 语音方向”）；summary 1-2 句说明关联逻辑\n- 只提交提案草稿，不要创建或修改点子本身。`
      }
      if (mode === 'idea_brainstorm') {
        let sourceIdeas: Idea[] = []
        let sourceClusterId: string | null = null
        if (text.startsWith('cluster:')) {
          sourceClusterId = text.slice(8)
          const clusterRes = await api<{ cluster: IdeaClusterView | null }>(`/api/workbench/idea-clusters/${sourceClusterId}`)
          sourceIdeas = clusterRes.cluster?.ideas ?? []
        } else {
          sourceIdeas = ideas.filter((idea) => text.slice(5).split(',').includes(idea.id))
        }
        const lines = sourceIdeas.map((idea, i) => `${i + 1}. [${idea.id}] ${idea.title} | 类型 ${idea.kindCode} | 标签 ${idea.tags.join(',') || '无'}\n   ${idea.contentMd || '（无内容）'}`).join('\n')
        const typeOptions = dicts.filter((d) => d.kind === 'type').map((d) => `${d.code}=${d.name}`).join(', ')
        ideaPrompt = `你是“个人工作台”的点子落地顾问。请和用户一起把下面${sourceClusterId !== null ? '点子王' : '点子'}头脑风暴成可落地的行动方案。\n\n${sourceClusterId !== null ? `点子王 id：${sourceClusterId}\n` : ''}相关点子：\n${lines}\n\n流程：\n1. 先和用户讨论目标、可行性、第一步（一次问 1-2 个关键问题）\n2. 有结论后调用 workbench_submit_idea_tasks：\n   - source_idea_ids${sourceClusterId !== null ? ' 留空' : '= 讨论的点子 id 数组'}\n   - source_cluster_id${sourceClusterId !== null ? `="${sourceClusterId}"` : ' 留空'}\n   - tasks: 任务数组 {title, description, type_code, priority_code, due_at?, estimated_minutes?, children?}；type_code 必须使用以下字典值：${typeOptions}；priority_code 使用 p0/p1/p2/p3\n   - summary: 1-3 句头脑风暴小结\n3. 只提交提案草稿，不要直接创建任务。`
      }
      let docPrompt = ''
      if (mode === 'knowledge_doc') {
        if (docContext === undefined) throw new Error('知识总结需要文档内容')
        docPrompt = `你是“个人工作台”的知识库总结助手。请阅读下面的本地文档内容，提炼出值得沉淀的知识条目，并调用 workbench_submit_knowledge 提交 pending 草稿。\n\n本地文件：${docContext.fileLink}\n文件名：${docContext.name ?? ''}\n文档内容（${docContext.truncated === true ? '已截断' : '全文'}）：\n"""\n${docContext.content}\n"""\n\n要求：\n- 总结为可检索、可复用的知识条目：背景/结论/可复用做法；正文使用 Markdown\n- title 简洁；kind_code 根据内容选择 note/lesson/decision/snippet；tags 给出 3-5 个关键词\n- file_link 必须填 "${docContext.fileLink}"（或同值的 file:// URL），用于追溯本地文件\n- 只提交知识草稿，不要直接创建知识条目。`
      }
      const planPrompt = `你是“个人工作台”的 AI 计划助手。请为 ${planAnchor}（${'日一二三四五六'[new Date(`${planAnchor}T00:00:00`).getDay()]}）安排执行顺序。\n\n今天：${localDateString()}；当前时间：${new Date().toISOString()}\n\n候选任务（该日期及之前到期、仍未完成的任务${planAnchor === localDateString() ? '；今天额外包含无截止时间的进行中任务' : ''}，最多 30 条）：\n${planTaskLines || '（无候选任务）'}\n\n请综合考虑：优先级（p0 紧急 > p1 高 > p2 普通 > p3 低）、是否已逾期、截止时间、状态（doing/blocked 优先推进）、预计耗时、父子关系与可能的依赖。如果信息不足，可以先问用户 1-2 个关键问题（例如：当天可投入多少小时、哪些必须当天完成）。\n\n然后调用 workbench_propose_daily_plan：\n- plan_date="${planAnchor}"\n- summary：1-3 句排序思路\n- items：扁平顺序数组（1 号最重要），每项 {task_id, order, note}；note 写清为什么排这里或建议时间块\n- 同一父子链上不要同时出现父任务和它下面的子任务；如需排子任务，只排可执行的叶子，并在 note 中说明属于哪个父任务\n- 只提交计划草稿，不要修改任何任务字段，不要执行任务。`
      const prompt = mode === 'idea_association' || mode === 'idea_brainstorm'
        ? ideaPrompt
        : mode === 'knowledge_doc'
        ? docPrompt
        : mode === 'report'
        ? `你是“个人工作台”的日报/周报助手。请根据下面 JSON 数据生成一份 Markdown 报告，然后调用 workbench_submit_report。\n\n报告周期：${text.split(':')[0]}（period_start=${text.split(':')[1] ?? ''}）\n数据：\n${reportContextText}\n\n要求：\n- 结构：今日/本周概览 → 已完成 → 进行中/风险 → 明日/下周建议\n- 只依据给定数据，不要编造；数据不足时如实说明\n- title 简洁；summary_md 用 Markdown；stats 可附 {completed, created} 等数字\n- 只提交草稿，不要修改任务，不要执行任务。`
        : mode === 'plan'
        ? planPrompt
        : mode === 'clarify'
        ? `你是“个人工作台”的任务澄清助手。请按 workbench-intake 规范执行。\n\n用户想创建的任务是：\n「${text}」\n\n当前时间：${new Date().toISOString()}\n默认 AI 工作区：${settings.defaultWorkspace || '未设置'}\n\n请先澄清必要信息（一次一个主题，最多5轮）。如果用户对该任务的 AI 会话有指定工作区，请询问具体路径，并在调用 workbench_submit_task 时传入 workspace_path；否则留空使用默认工作区。信息足够后调用 workbench_submit_task 提交结构化任务草稿。不要执行任务本身。`
        : mode === 'consult'
          ? `你是“个人工作台”的任务协助助手。请针对下面这个任务提供咨询、拆解或复盘建议（咨询模式不执行）。\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode} 状态：${task?.statusCode}\n截止：${task?.effectiveDueAt ?? task?.dueAt ?? '无'}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树）：\n${memoryContext}` : ''}\n\n请先理解任务，再给出建议；如果信息不足，可以一次问一个问题。\n\n重要：如果用户要求把结论/补充信息保存回任务，请调用 workbench_update_task(task_id="${task?.id ?? ''}", description="...") 更新原任务；绝对不要调用 workbench_submit_task 新建任务。`
          : mode === 'breakdown'
            ? `你是“个人工作台”的任务拆解助手。请分析下面这个任务，并调用 workbench_propose_subtasks 提交子任务提案。\n\n父任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode} 截止：${task?.effectiveDueAt ?? task?.dueAt ?? '无'}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树）：\n${memoryContext}` : ''}\n\n粒度规则：每层 2-6 个、最大深度 3 层、叶子 15-240 分钟且有可验证完成标准；子任务的 type_code/priority_code 默认继承父任务；若任务太小，设置 no_breakdown_needed=true。只提交提案，不要执行。如果用户对提案提出修改意见，请带上上一次工具返回的 draft_id 再次调用 workbench_propose_subtasks 更新同一份提案。`
            : mode === 'review'
              ? `你是“个人工作台”的任务复盘助手。请对下面这个已完成任务做复盘：\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树）：\n${memoryContext}` : ''}\n\n请从“做得好 / 做得不好 / 下次改进”三个角度输出 Markdown，并调用 workbench_submit_review(task_id="${task?.id ?? ''}", summary_md="...", lessons=[{"title":"...","content":"..."}])。`
              : `你是“个人工作台”的任务执行助手。请直接完成下面这个任务，不要反复确认已知信息。\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode}\n截止：${task?.effectiveDueAt ?? task?.dueAt ?? '无'}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树，父任务会话会看到整棵子树上下文）：\n${memoryContext}` : ''}\n${previousSessions.length > 0 ? `\n该任务此前已有执行会话：${previousSessions.map((s) => String(s.session_id ?? '')).filter((x) => x !== '').join('、')}\n若这些会话有未完成上下文，请先向用户索取上一会话的总结/未完成事项再继续，不要重复已完成工作。` : ''}\n\n执行过程中请遵守：\n- 如果有关键上下文、阶段性结论、决策或未完成事项，请调用 workbench_save_task_memory(task_id="${task?.id ?? ''}", content="...", kind="note|decision|summary") 写入任务共享记忆，便于后续会话续作。\n- 若当前任务是父任务，且你直接完成父任务，验收通过后系统会级联完成所有未完成子任务。\n- 完成后调用 workbench_request_completion(task_id="${task?.id ?? ''}", summary="2-4句完成总结")，等待用户在个人工作台验收；在用户验收通过前，任务不算完成，不要声称已经完成。若任务无法完成，如实说明原因，不要提交验收。`
      if (mode === 'execute') {
        if (task === null) throw new Error('执行模式需要选择一个任务')
        if (task.statusCode === 'done' || task.statusCode === 'cancelled') throw new Error('该任务已完成或已取消，不能再次执行')
        if (task.aiPolicyCode !== 'execute') throw new Error('该任务未开启“可执行”，请先在任务详情中把 AI 策略改为“可执行”')
      }
      if (mode === 'clarify') setShowQuick(false)
      const basePrompt = customPrompt.trim() === '' ? prompt : `${prompt}\n\n用户补充要求：\n${customPrompt.trim()}`
      // 选中的技能以"加载指令"形式前置（不内联技能正文）；未选技能时逐字等于原提示词。
      const finalPrompt = withSkillPromptBlock(basePrompt, skillNames)
      const result = await binding.session.prompt([{ type: 'text', text: finalPrompt }], 'queue')
      if (result.ok === false) throw new Error(result.error !== undefined ? String(result.error) : '发送失败')
      if (mode === 'plan') {
        await api('/api/workbench/ai-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeCode: 'daily_plan', anchor: planAnchor, sessionId: id, workspace: workspaceId }) })
      }
      if (mode === 'report') {
        const [periodCode, periodStart] = text.split(':')
        await api('/api/workbench/ai-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeCode: periodCode === 'week' ? 'week_report' : 'day_report', anchor: periodStart, sessionId: id, workspace: workspaceId }) })
      }
      if (mode === 'idea_association' || mode === 'idea_brainstorm') {
        await api('/api/workbench/ai-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeCode: mode, anchor: text, sessionId: id, workspace: workspaceId }) })
      }
      if (task !== null && mode !== 'clarify') {
        await api(`/api/workbench/tasks/${task.id}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, roleCode: mode }) }).catch(() => undefined)
      }
      // 这里已经 await 过多次：期间插件可能被卸载/重载，先确认还活着再动宿主服务。
      if (!instanceAlive) return
      // 先开会话再关面板：关面板会卸载本面板的 React 树，顺序反了就成了"点了没反应"。
      safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')?.open(id)
      closePanel()
    } catch (e) {
      if (instanceAlive) setError(e instanceof Error ? e.message : String(e))
    } finally { if (instanceAlive) setBusy(false) }
  }

  const summarizeLocalDoc = async (pathOverride?: string): Promise<void> => {
    const path = (pathOverride ?? localDocPath).trim()
    if (path === '') {
      setError('请输入本地文档路径')
      return
    }
    setBusy(true); setError(null)
    try {
      const res = await api<{ fileLink: string; content: string; name: string; truncated: boolean }>(`/api/workbench/knowledge/read-local-file?path=${encodeURIComponent(path)}`)
      await startAISession('knowledge_doc', null, res.fileLink, [], { fileLink: res.fileLink, content: res.content, name: res.name, truncated: res.truncated })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const loadFilePickerDir = async (path?: string): Promise<void> => {
    setFilePickerLoading(true); setFilePickerError(null)
    try {
      const qs = path === undefined || path === '' ? '' : `?path=${encodeURIComponent(path)}`
      const res = await api<{ path: string; parent: string | null; entries: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean; hidden: boolean }> }>(`/api/workbench/knowledge/list-local-dir${qs}`)
      setFilePickerDir(res.path)
      setFilePickerParent(res.parent)
      setFilePickerEntries(res.entries)
    } catch (e) {
      setFilePickerError(e instanceof Error ? e.message : String(e))
    } finally {
      setFilePickerLoading(false)
    }
  }

  const openFilePicker = (): void => {
    setFilePickerOpen(true)
    void loadFilePickerDir()
  }

  const pickLocalFile = (entry: { path: string; isDirectory: boolean; isFile: boolean }): void => {
    if (entry.isDirectory) {
      void loadFilePickerDir(entry.path)
      return
    }
    setLocalDocPath(entry.path)
    setFilePickerOpen(false)
    setNotice('已选择本地文件，可点击“AI 总结本地文档”')
  }

  const pickAndSummarizeLocalFile = (entry: { path: string; isDirectory: boolean; isFile: boolean }): void => {
    if (entry.isDirectory) {
      void loadFilePickerDir(entry.path)
      return
    }
    setLocalDocPath(entry.path)
    setFilePickerOpen(false)
    void summarizeLocalDoc(entry.path)
  }

  const openKnowledgeFile = async (fileLink: string): Promise<void> => {
    try {
      const workspaces = safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')
      if (workspaces?.openPath) {
        await workspaces.openPath(clientFileLinkToPath(fileLink))
        if (instanceAlive) setNotice('已调用系统打开文件')
        return
      }
    } catch {
      // 原生 openPath 不可用时回退到后端打开接口
    }
    try {
      await api('/api/workbench/knowledge/open-file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileLink }) })
      setNotice('已调用系统打开文件')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const saveDictionaryEntry = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (dictForm === null) return
    const name = dictForm.name.trim()
    if (name === '') { setDictError('名称不能为空'); return }
    const code = (dictEditCode ?? dictForm.code).trim()
    if (!/^[a-z][a-z0-9_]*$/.test(code)) { setDictError('code 必须是小写字母开头，只能包含小写字母/数字/下划线'); return }
    const config = { ...(dictOf(dictKind).find((d) => d.code === code)?.config ?? {}), color: dictForm.color }
    const base = { name, config, sortOrder: dictForm.sortOrder }
    try {
      if (dictEditCode !== null) {
        await api(`/api/workbench/dictionaries/${dictKind}/${encodeURIComponent(dictEditCode)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(base) })
      } else {
        await api('/api/workbench/dictionaries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, kind: dictKind, code }) })
      }
      setDictForm(null); setDictEditCode(null); setDictError(null); setNotice('字典项已保存')
      await refresh()
    } catch (e) {
      setDictError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleDictionaryEntry = async (entry: Dict): Promise<void> => {
    try {
      await api(`/api/workbench/dictionaries/${entry.kind}/${encodeURIComponent(entry.code)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: entry.active !== 1 }) })
      setNotice(entry.active === 1 ? `已停用 ${entry.name}` : `已启用 ${entry.name}`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const deleteDictionaryEntry = async (entry: Dict): Promise<void> => {
    if (!window.confirm(`确认删除“${entry.name}”？`)) return
    try {
      await api(`/api/workbench/dictionaries/${entry.kind}/${encodeURIComponent(entry.code)}`, { method: 'DELETE' })
      setNotice(`已删除 ${entry.name}`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // ---- 设置弹窗：保存与微信提醒操作（把结果收敛到 toast，不再挤压任务列表）----

  const saveSettings = async (): Promise<void> => {
    setSettingsSaving(true)
    try {
      await api('/api/workbench/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) })
      setShowSettings(false)
      pushToast('设置已保存', 'success')
    } catch (e) {
      pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSettingsSaving(false)
    }
  }

  const loadReminderChannel = async (): Promise<void> => {
    setReminderBusy(true)
    try {
      const result = await api<{ status: ReminderChannelView; options: ReminderOptionsView }>('/api/workbench/reminders/channel')
      setReminderChannel(result.status)
      setReminderOptions(result.options)
      pushToast('已刷新通道状态', 'info')
    } catch (e) {
      pushToast(`刷新失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setReminderBusy(false)
    }
  }

  const saveReminderTarget = async (): Promise<void> => {
    if (reminderChannel === null) return
    setReminderBusy(true)
    try {
      const result = await api<{ status: ReminderChannelView }>('/api/workbench/reminders/channel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId: reminderChannel.botId, targetId: reminderChannel.targetId }),
      })
      setReminderChannel(result.status)
      pushToast('投递目标已保存', 'success')
    } catch (e) {
      pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setReminderBusy(false)
    }
  }

  const saveReminderPolicy = async (): Promise<void> => {
    if (reminderPolicy === null) return
    setReminderBusy(true)
    try {
      const result = await api<{ policy: ReminderPolicyView }>('/api/workbench/reminders/policy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reminderPolicy),
      })
      setReminderPolicy(result.policy)
      pushToast('微信提醒策略已保存', 'success')
    } catch (e) {
      pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setReminderBusy(false)
    }
  }

  const sendReminderTest = async (): Promise<void> => {
    setReminderBusy(true)
    try {
      const result = await api<{ ok: boolean; reason?: string }>('/api/workbench/reminders/test', { method: 'POST' })
      if (result.ok) pushToast('测试消息已发送，请查看手机微信', 'success')
      else pushToast(`发送失败：${result.reason ?? 'unknown'}`, 'error')
    } catch (e) {
      pushToast(`发送失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setReminderBusy(false)
    }
  }

  /** 保存任务编辑（详情页编辑弹窗）。 */
  const saveEditDraft = async (): Promise<void> => {
    if (editDraft === null || selected === null) return
    if (editDraft.title.trim() === '') return
    const payload: Record<string, unknown> = {
      title: editDraft.title.trim(),
      description: editDraft.description,
      typeCode: editDraft.typeCode,
      priorityCode: editDraft.priorityCode,
      statusCode: editDraft.statusCode,
      aiPolicyCode: editDraft.aiPolicyCode,
      dueAt: editDraft.dueLocal === '' ? null : new Date(editDraft.dueLocal).toISOString(),
      workspacePath: editDraft.workspacePath.trim() === '' ? null : editDraft.workspacePath.trim(),
      // 改父任务（v1.14.0）：null = 移到顶层。服务端 repo 层会做存在性 + 防环校验，
      // 失败返回 400 中文原因（下面的 catch 会把它显示成 toast），不是 500。
      parentId: editDraft.parentId === '' ? null : editDraft.parentId,
    }
    // 自动生成的实例不允许改重复规则，编辑保存时也不提交该字段，从源头避免 400。
    if (selected.task.recurrenceMasterId === null) payload.recurrenceCode = editDraft.recurrenceCode
    try {
      await patchTask(selected.task.id, payload)
      setEditDraft(null)
      pushToast('任务已更新', 'success')
    } catch (e) {
      pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const createTask = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const title = String(form.get('title') ?? '').trim()
    if (title === '') return
    const due = String(form.get('due') ?? '')
    const dueAt = due === '' ? null : new Date(due).toISOString()
    const recurrenceCode = String(form.get('recurrence') ?? 'none')
    const recurrenceAnchor = dueAt !== null ? new Date(dueAt) : new Date()
    await api('/api/workbench/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, description: String(form.get('description') ?? ''), typeCode: String(form.get('type') ?? ''), priorityCode: String(form.get('priority') ?? ''), statusCode: String(form.get('status') ?? 'todo'), workspacePath: String(form.get('workspacePath') ?? '').trim() || null, dueAt, recurrenceCode: recurrenceCode === 'none' ? null : recurrenceCode, recurrenceRule: recurrenceCode === 'none' ? undefined : { interval: 1, startDate: localDateString(recurrenceAnchor), weekdays: [recurrenceAnchor.getDay()], monthDay: recurrenceAnchor.getDate() } }) })
    setShowForm(false); await refresh()
  }
  // 今日/日历/列表三棵树：默认全部收起
  const [todayExpanded, setTodayExpanded] = useState<Set<string>>(new Set())
  const [calendarExpanded, setCalendarExpanded] = useState<Set<string>>(new Set())

  // 树展开状态（列表树记住用户展开）
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([])
  const [archivedMode, setArchivedMode] = useState(false)
  const [taskFilter, setTaskFilter] = useState<TaskFilterState>({ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] })
  const [taskSortKey, setTaskSortKey] = useState<TaskSortKey>('dueAt')
  const [taskSortDir, setTaskSortDir] = useState<TaskSortDir>('asc')
  const [openFilter, setOpenFilter] = useState<'status' | 'priority' | 'type' | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('dsh.personal-workbench.treeExpanded') ?? '[]') as string[]) } catch { return new Set() }
  })
  useEffect(() => {
    try { localStorage.setItem('dsh.personal-workbench.treeExpanded', JSON.stringify([...expanded])) } catch { /* ignore */ }
  }, [expanded])
  const toggleExpanded = (id: string): void => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const toggleTodayExpanded = (id: string): void => setTodayExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const toggleCalendarExpanded = (id: string): void => setCalendarExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const collapseAll = (): void => { setExpanded(new Set()); setTodayExpanded(new Set()); setCalendarExpanded(new Set()) }

  const priorityWeights = useMemo(() => new Map(dictOf('priority').map((d) => [d.code, Number(d.config.weight ?? 99)])), [dicts])
  // 技能选择器：按名称/描述/适用场景过滤（大小写不敏感）
  const visibleSkills = useMemo(() => {
    const query = skillQuery.trim().toLowerCase()
    if (query === '') return skillCatalog
    return skillCatalog.filter((skill) =>
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query) ||
      (skill.whenToUse ?? '').toLowerCase().includes(query))
  }, [skillCatalog, skillQuery])
  const taskSorter = useMemo(() => createTaskSorter(taskSortKey, taskSortDir, priorityWeights), [taskSortKey, taskSortDir, priorityWeights])
  const visibleTaskTree = useMemo(() => {
    const source = archivedMode ? archivedTasks : tasks
    return filterTaskTree(buildTaskTree(source, undefined, taskSorter), (t) => matchesTaskFilter(t, taskFilter))
  }, [archivedMode, archivedTasks, tasks, taskSorter, taskFilter])

  const now = new Date()
  const todayStart = startOfDay(now)
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1)
  const openTasks = tasks.filter((t) => !['done', 'cancelled'].includes(t.statusCode))
  const openTree = useMemo(() => buildTaskTree(openTasks), [tasks])
  const todayPlan = bootstrap?.todayPlan ?? null
  const todayTree = useMemo(() => {
    if (todayPlan === null || todayPlan.items.length === 0) return openTree
    const order = new Map(todayPlan.items.map((item) => [item.taskId, item.order]))
    return buildTaskTree(openTasks, order)
  }, [tasks, todayPlan])
  const clearTodayPlan = async (): Promise<void> => {
    await api(`/api/workbench/plans/${localDateString()}`, { method: 'DELETE' })
    await refresh()
  }

  /**
   * 点子页的文件夹派生数据：
   * - unfiledIdeas：没有被任何文件夹引用的点子（「未归类」区）
   * - ideasOfFolder：按文件夹聚合的成员（同一数据在卡片里只显示前 2 条缩略）
   * 数据层无需变更：idea_clusters = 文件夹，idea_links 已支持多对多。
   */
  const unfiledIdeas = useMemo(() => {
    const filed = new Set(ideaClusters.flatMap((cluster) => cluster.ideas.map((idea) => idea.id)))
    return ideas.filter((idea) => !filed.has(idea.id))
  }, [ideas, ideaClusters])

  const refreshIdeas = async (): Promise<void> => {
    setIdeaRefreshKey((value) => value + 1)
    setFolderMenuIdeaId(null)
  }

  /** 新建空文件夹 / 文件夹改名。 */
  const saveFolder = async (): Promise<void> => {
    if (folderForm === null) return
    const title = folderForm.title.trim()
    if (title === '') { setError('文件夹名称不能为空'); return }
    try {
      if (folderForm.mode === 'create') {
        const res = await api<{ cluster: IdeaClusterView }>('/api/workbench/idea-clusters', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, summaryMd: folderForm.summaryMd }),
        })
        setNotice('文件夹已创建')
        setSelectedCluster(res.cluster)
      } else if (folderForm.id !== null) {
        const res = await api<{ cluster: IdeaClusterView }>(`/api/workbench/idea-clusters/${folderForm.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, summaryMd: folderForm.summaryMd }),
        })
        setNotice('文件夹已更新')
        setSelectedCluster(res.cluster)
      }
      setFolderForm(null)
      await refreshIdeas()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 删除文件夹（点子本身保留，回到「未归类」）。 */
  const deleteFolder = async (id: string): Promise<void> => {
    try {
      await api(`/api/workbench/idea-clusters/${id}`, { method: 'DELETE' })
      if (selectedCluster?.id === id) setSelectedCluster(null)
      setNotice('文件夹已删除，点子回到「未归类」')
      await refreshIdeas()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  /** 把点子归入文件夹（可多对多；已在其中则忽略）。 */
  const fileIdeaInto = async (ideaId: string, clusterId: string): Promise<void> => {
    try {
      await api(`/api/workbench/idea-clusters/${clusterId}/ideas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ideaId }),
      })
      setNotice('已归入文件夹')
      await refreshIdeas()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  /** 把点子移出文件夹。 */
  const unfileIdeaFrom = async (ideaId: string, clusterId: string): Promise<void> => {
    try {
      await api(`/api/workbench/idea-clusters/${clusterId}/ideas/${ideaId}`, { method: 'DELETE' })
      await refreshIdeas()
      const res = await api<{ cluster: IdeaClusterView }>(`/api/workbench/idea-clusters/${clusterId}`)
      setSelectedCluster(res.cluster)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  /** 合并文件夹：把当前文件夹并入目标文件夹（成员挂过去，源文件夹删除）。 */
  const mergeFolderInto = async (sourceId: string, targetId: string): Promise<void> => {
    if (sourceId === targetId) return
    try {
      const res = await api<{ cluster: IdeaClusterView }>(`/api/workbench/idea-clusters/${sourceId}/merge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ into: targetId }),
      })
      setNotice('文件夹已合并')
      setSelectedCluster(res.cluster)
      await refreshIdeas()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  /** 今日容量：当天要做的事（今天到期 + 无截止的进行中）按 estimatedMinutes 摊开。
   * 没有估算的任务按每件 30 分钟兜底，避免"没填估算就当零成本"导致容量条失真。
   */
  const capacityTodayTasks = openTasks.filter((t) =>
    t.effectiveDueAt === null
      ? (t.statusCode === 'doing' || t.statusCode === 'blocked')
      : isTaskDueOnDay(t, now))
  const capacityTaskIds = new Set(capacityTodayTasks.map((t) => t.id))
  const capacityFromPlan = (todayPlan?.items ?? []).filter((item) => capacityTaskIds.has(item.taskId)).length
  const capacityPlanned = capacityTodayTasks.reduce((sum, t) => sum + (t.estimatedMinutes ?? 30), 0)
  const capacityByPriority = {
    p0: capacityTodayTasks.filter((t) => t.priorityCode === 'p0').reduce((sum, t) => sum + (t.estimatedMinutes ?? 30), 0),
    p1: capacityTodayTasks.filter((t) => t.priorityCode === 'p1').reduce((sum, t) => sum + (t.estimatedMinutes ?? 30), 0),
    p2: capacityTodayTasks.filter((t) => t.priorityCode === 'p2').reduce((sum, t) => sum + (t.estimatedMinutes ?? 30), 0),
    p3: capacityTodayTasks.filter((t) => t.priorityCode !== 'p0' && t.priorityCode !== 'p1' && t.priorityCode !== 'p2').reduce((sum, t) => sum + (t.estimatedMinutes ?? 30), 0),
  }
  const capacityTotal = Math.max(settings.dailyCapacityMinutes, capacityPlanned, 1)
  const capacity = {
    planned: capacityPlanned,
    free: Math.max(0, settings.dailyCapacityMinutes - capacityPlanned),
    over: capacityPlanned > settings.dailyCapacityMinutes,
    byPriority: capacityByPriority,
    total: capacityTotal,
    count: capacityTodayTasks.length,
    planCovered: capacityFromPlan,
  }

  /** 保存「每天可投入时长」（分钟）；<30 视为无效，恢复默认 390。 */
  const saveDailyCapacity = async (): Promise<void> => {    const raw = capacityEdit === null ? '' : capacityEdit.trim()
    setCapacityEdit(null)
    const parsed = Number(raw)
    const next = Number.isFinite(parsed) && parsed >= 30 ? Math.min(1440, Math.round(parsed)) : 390
    if (next === settings.dailyCapacityMinutes) return
    try {
      await api<{ settings: { dailyCapacityMinutes: number } }>('/api/workbench/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailyCapacityMinutes: next }),
      })
      setSettings((prev) => ({ ...prev, dailyCapacityMinutes: next }))
      setNotice(`每天可投入时长已设为 ${next} 分钟`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const savePlan = async (date: string, items: Array<{ taskId: string; note: string }>): Promise<void> => {
    try {
      await api(`/api/workbench/plans/${date}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: items.map((item, index) => ({ taskId: item.taskId, order: index + 1, note: item.note })) }) })
      await refresh()
      setPlanRefreshKey((v) => v + 1)
      setNotice('计划已保存（来源：手动编辑）')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  // 周/月日历
  const [cursor, setCursor] = useState<Date>(startOfWeek(now))
  const [calMode, setCalMode] = useState<'week' | 'month'>('week')
  const [picked, setPicked] = useState<Date>(todayStart)
  const [dayTab, setDayTab] = useState<'plan' | 'done' | 'report'>('plan')
  const reportAnchor = reportSubTab === 'week' ? localDateString(startOfWeek(picked)) : localDateString(picked)
  const reportScope = reportSubTab === 'week' ? 'week_report' : 'day_report'
  const todayAnchor = localDateString(new Date())
  const thisWeekAnchor = localDateString(startOfWeek(new Date()))
  const reportIsFuture = reportSubTab === 'week' ? reportAnchor > thisWeekAnchor : reportAnchor > todayAnchor

  useEffect(() => {
    if (view !== 'calendar' || dayTab !== 'report' || reportIsFuture) {
      setCurrentReport(null); setReportSession(null)
      return
    }
    void Promise.all([
      api<{ report: TaskReportView | null }>(`/api/workbench/reports/${reportSubTab}/${reportAnchor}`),
      api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=${reportScope}&anchor=${reportAnchor}`),
    ]).then(([rep, sess]) => { setCurrentReport(rep.report); setReportSession(sess.session) }).catch(() => { setCurrentReport(null); setReportSession(null) })
  }, [view, dayTab, reportSubTab, picked, reportIsFuture, reportRefreshKey])

  useEffect(() => {
    void api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=daily_plan&anchor=${todayAnchor}`)
      .then((r) => setTodayPlanSession(r.session))
      .catch(() => setTodayPlanSession(null))
  }, [todayAnchor, bootstrap])

  const pickedAnchor = localDateString(picked)
  useEffect(() => {
    if (view !== 'calendar' || dayTab !== 'plan') {
      setPickedPlan(null); setPickedPlanSession(null)
      return
    }
    void Promise.all([
      api<{ plan: DailyPlanView | null }>(`/api/workbench/plans?date=${pickedAnchor}`),
      api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=daily_plan&anchor=${pickedAnchor}`),
    ]).then(([planRes, sessionRes]) => { setPickedPlan(planRes.plan); setPickedPlanSession(sessionRes.session) }).catch(() => { setPickedPlan(null); setPickedPlanSession(null) })
  }, [view, dayTab, pickedAnchor, planRefreshKey])

  /**
   * 「改父任务」选择项的候选列表（v1.14.0）。
   *
   * 必须排除**自身 + 自身的全部后代** —— 否则用户能选到必然被服务端 400 拒绝的选项。
   * 服务端 repo 层仍然独立做防环校验（那是真正的防线），这里只是不给出必错的选项。
   * 这里也顺带给出缩进层级，长列表里能看出树形关系。
   */
  const reparentCandidates = useMemo(() => {
    if (editDraft === null || selected === null) return [] as Array<{ id: string; title: string; depth: number }>
    const byParent = new Map<string | null, Task[]>()
    for (const task of tasks) {
      const key = task.parentId ?? null
      const list = byParent.get(key)
      if (list === undefined) byParent.set(key, [task])
      else list.push(task)
    }
    const out: Array<{ id: string; title: string; depth: number }> = []
    const walk = (parentId: string | null, depth: number): void => {
      if (depth > 6) return
      for (const task of byParent.get(parentId) ?? []) {
        // 排除自身与后代：自身在子树根被拦下，后代随着递归不再展开。
        if (task.id === selected.task.id) continue
        out.push({ id: task.id, title: task.title, depth })
        walk(task.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [editDraft !== null, selected?.task.id, tasks])
  const weekDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(cursor); d.setDate(d.getDate() + i); return d })
  const moveWeek = (delta: number): void => { const d = new Date(cursor); d.setDate(d.getDate() + delta * 7); setCursor(startOfWeek(d)) }
  const monthGrid = (() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const start = startOfWeek(first)
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d })
  })()
  const moveMonth = (delta: number): void => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1))
  const noDueOpen = tasks.filter((t) => t.effectiveDueAt === null && t.statusCode !== 'done' && t.statusCode !== 'cancelled')
  const planKeep = (t: Task): boolean => (t.effectiveDueAt !== null && sameDay(new Date(t.effectiveDueAt), picked) && t.statusCode !== 'cancelled') || (sameDay(picked, now) && noDueOpen.some((x) => x.id === t.id))
  const doneKeep = (t: Task): boolean => t.completedAt !== null && sameDay(new Date(t.completedAt), picked)
  const pickedPlanOrder = useMemo(() => {
    if (pickedPlan === null || pickedPlan.items.length === 0) return undefined
    return new Map(pickedPlan.items.map((item) => [item.taskId, item.order]))
  }, [pickedPlan])
  const pickedPlanTree = useMemo(() => filterTaskTree(buildTaskTree(tasks, pickedPlanOrder), planKeep), [tasks, picked, pickedPlanOrder]) // eslint 语义同 tasks
  const pickedDoneTree = useMemo(() => filterTaskTree(buildTaskTree(tasks), doneKeep), [tasks, picked])
  // 已完成面板中保留的父/祖父链只是上下文，不应计入统计，也以灰色弱化展示。
  const doneContextIds = (() => {
    const ids = new Set<string>()
    const walk = (nodes: TaskTreeNode<Task>[]): void => {
      for (const node of nodes) {
        if (!doneKeep(node.task)) ids.add(node.task.id)
        walk(node.children)
      }
    }
    walk(pickedDoneTree)
    return ids
  })()

  /** 同上：`?.list.getSnapshot()` 只保护外层，低版本宿主缺 `list` 时会抛 —— 一并加固。 */
  const sessionListSnapshot = safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')?.list?.getSnapshot?.() ?? { ids: [], byId: {}, current: undefined }
  /** 待你处理的事项数：待确认草稿 + 已暂存草稿 + 到期提醒。 */
  /** 待你处理的事项数：服务端的待确认草稿 + 到期提醒（草稿数不参与本地过滤）。 */
  const pendingCount = allPendingDrafts.length + reminders.length
  /**
   * 打开「快速录入」并把工作区选择**重置成当前隐式行为的默认值**。
   *
   * 默认值必须与改动前逐字一致（不选 = 无变化），所以这里是复刻 startAISession 的旧推导：
   * 跟随选中任务的 effectiveWorkspacePath，否则用默认工作区（WSL 下归一化路径形态）。
   * 每次打开都重算 —— 用户可能刚换了选中任务或改了默认工作区。
   */
  const openQuickEntry = (): void => {
    const isWsl = detectWslHost(runtime)
    const inherited = selected?.task.effectiveWorkspacePath ?? ''
    const base = inherited !== '' ? inherited : settings.defaultWorkspace
    const normalized = base === '' ? '' : isWsl ? normalizeWindowsPathToWsl(base) : base
    setQuickText('')
    setQuickWorkspace(normalized)
    // 有默认值时显示来源提示；用户改过就切到"手动指定"
    setQuickWorkspaceTouched(false)
    setQuickFollowFolder(inherited === '' && settings.defaultWorkspace !== '' && settings.autoCreateTypeFolders)
    setShowQuick(true)
  }
  /**
   * 记住这次用过的工作区（写进设置，最新的排最前，最多 5 条）。
   * 失败静默：这只是便利功能，不能因为它挡住"创建工作区"这个主流程。
   */
  const rememberQuickWorkspace = async (path: string): Promise<void> => {
    const key = (value: string): string => value.trim().replace(/[\\/]+$/, '').toLowerCase()
    if (path.trim() === '' || (settings.quickWorkspaceRecent ?? []).some((item) => key(item) === key(path))) return
    const next = [path.trim(), ...(settings.quickWorkspaceRecent ?? [])]
      .filter((item, index, all) => all.findIndex((other) => key(other) === key(item)) === index)
      .slice(0, 5)
    try {
      const res = await api<{ settings: WorkbenchSettings }>('/api/workbench/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quickWorkspaceRecent: next }),
      })
      setSettings(res.settings)
    } catch { /* 记不住就算了，不影响主流程 */ }
  }
  /** 收起一条草稿横幅：记屏蔽，并**记下它当时是不是暂存态**（供"暂存→唤回"识别）。 */
  const dismissDraft = (draft: DraftView): void => {
    dismissedDraftIdsRef.current.add(draft.id)
    if (draft.deferredAt !== null) deferredWhenDismissedRef.current.add(draft.id)
    else deferredWhenDismissedRef.current.delete(draft.id)
  }
  /** 从「待处理」里重新打开某份草稿的弹框（撤销"看过就收起"的本地屏蔽）。 */
  const resumePendingDraft = async (draft: DraftView): Promise<void> => {
    dismissedDraftIdsRef.current.delete(draft.id)
    deferredWhenDismissedRef.current.delete(draft.id)
    setPendingOpen(false)
    setPendingDraft(draft)
  }
  /**
   * 唤回一份暂存草稿：清掉暂存标记，它会立刻重新弹出待确认弹窗。
   *
   * ⚠️ **必须同时撤销本地屏蔽**（2026-09-15 用户实测 BUG：唤回后弹框只闪一下就永久消失）。
   *
   * 原因：点「暂存」时我们会把 draft id 记进 `dismissedDraftIdsRef`（"看过就别再自动弹"）。
   * 唤回时若不清掉这条记录，下一轮 5 秒轮询仍会把它过滤掉 —— 于是
   * `setPendingDraft` 造成"短暂出现"，随后被轮询覆盖成"永不出现"，
   * 而服务端明明是 pending（用户会以为草稿丢了）。旁边的「已唤回」toast 只是同时发生。
   */
  const resumeDeferredDraft = async (draftId: string): Promise<void> => {
    try {
      await api(`/api/workbench/drafts/${draftId}/resume`, { method: 'POST' })
      setPendingOpen(false)
      // 用户主动唤回 = 明确要处理它，撤销所有本地屏蔽。
      dismissedDraftIdsRef.current.delete(draftId)
      deferredWhenDismissedRef.current.delete(draftId)
      const res = await api<{ draft: DraftView | null; deferredDrafts?: DraftView[] }>('/api/workbench/drafts')
      setPendingDraft(res.draft)
      setDeferredDrafts(res.deferredDrafts ?? [])
      if (res.draft !== null) setAllPendingDrafts([res.draft, ...(res.deferredDrafts ?? [])])
      setNotice('已唤回，待你决定')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  /**
   * 确认接口的业务回执处理（2026-09-13 重复建单事故的界面侧收口）。
   *
   * 三种回执（都来自服务端的结构化字段，不是文案匹配）：
   *
   * 1. `duplicateOf` —— 库里**另有一条**同名任务。服务端只告警不合并（同名可能是正当需求，
   *    例如每周例会），这里弹一个小选择框：保留两条，或者收口到已有那条上。
   * 2. `replayed` —— 这条草稿此前已经确认过，本次**没有新建任何东西**。
   *    必须说出来：否则用户会以为又建了一条（这正是事故的心理来源）。
   * 3. `reused` —— 用户选了"就用已有那条"，同样没有新建。
   */
  const handleDraftConfirmed = (outcome: DraftConfirmOutcome, draft: DraftView): void => {
    if (outcome.duplicateOf !== undefined) {
      setDuplicatePrompt({
        draftId: draft.id,
        existingTaskId: outcome.duplicateOf.id,
        existingTitle: outcome.duplicateOf.title,
        sameDescription: outcome.duplicateOf.sameDescription,
        sameWorkspace: outcome.duplicateOf.sameWorkspace,
        newTaskId: outcome.taskId ?? '',
      })
      return
    }
    if (outcome.replayed === true) {
      setNotice('这条草稿此前已经确认过了，本次没有重复建单（库里仍是原来那一条）。')
      return
    }
    if (outcome.reused === true) {
      setNotice('已按你选的「就用已有那条」收口，没有新建任务。')
    }
  }
  /**
   * 「就用已有那条」：把这条草稿收口到已有任务上，并清掉本次多建出来的那条。
   *
   * 两步都必须做才算数：
   * 1. 带 `intent=dedupe` 重新确认 → 服务端不新建、草稿收口；
   * 2. 归档本次已经多建出来的那条 —— 否则"没有重复建单"只是句空话。
   *
   * 第 2 步失败不回滚第 1 步（草稿状态已经是对的），但**必须把真实结果说出来**，
   * 不能让用户以为已经干净了。
   */
  const reuseExistingTask = async (prompt: NonNullable<typeof duplicatePrompt>): Promise<void> => {
    try {
      await api(`/api/workbench/drafts/${prompt.draftId}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent: 'dedupe' }),
      })
    } catch (e) {
      // 草稿已不是 pending（并发确认）时服务端会 400 —— 说明它已经收口了，不算失败。
      const message = e instanceof Error ? e.message : String(e)
      if (!/already (confirmed|abandoned)/i.test(message)) {
        setError(`收口失败：${message}`)
        return
      }
    }
    dismissedDraftIdsRef.current.add(prompt.draftId)
    setDuplicatePrompt(null)
    const created = prompt.newTaskId
    if (created !== '') {
      try {
        await api(`/api/workbench/tasks/${created}/archive`, { method: 'POST' })
        setNotice('已收口到已有任务，本次多建的那条已归档（可在列表页「查看归档」恢复）。')
      } catch (e) {
        setNotice(`已收口到已有任务；本次多建的那条自动归档失败（${e instanceof Error ? e.message : String(e)}），请在任务列表里手动归档。`)
      }
    } else {
      setNotice('已收口到已有任务，没有新建。')
    }
    void refresh()
  }
  const linkedSessionIds = new Set((selected?.sessions ?? []).map((s) => typeof s.session_id === 'string' ? s.session_id : '').filter((id) => id !== ''))
  const sessionQuery = sessionPickerQuery.trim().toLowerCase()
  const sessionCandidates = sessionListSnapshot.ids
    .map((id) => sessionListSnapshot.byId[id])
    .filter((s): s is DshSessionSummary => s !== undefined)
    .filter((s) => sessionQuery === '' || s.displayTitle.toLowerCase().includes(sessionQuery) || (s.cwd ?? '').toLowerCase().includes(sessionQuery))

  return (
    <div className="wb-app">
      <div className="wb-h">
        <div className="wb-title"><Icon name="calendar" size={19} />个人工作台</div>
        <div className="wb-segmented">
          <button className={`wb-seg ${view === 'today' ? 'on' : ''}`} onClick={() => setView('today')}><Icon name="today" />今日</button>
          <button className={`wb-seg ${view === 'calendar' ? 'on' : ''}`} onClick={() => setView('calendar')}><Icon name="calendar" />日历</button>
          <button className={`wb-seg ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')}><Icon name="list" />任务</button>
          <button className={`wb-seg ${view === 'knowledge' ? 'on' : ''}`} onClick={() => setView('knowledge')}><Icon name="book" />知识库</button>
          <button className={`wb-seg ${view === 'ideas' ? 'on' : ''}`} onClick={() => setView('ideas')}><Icon name="idea" />点子</button>
        </div>
        <div style={{ flex: 1 }} />
        {pendingCount > 0 && (
          <button className="wb-pending-pill" onClick={() => setPendingOpen(true)} title="待你处理的草稿与提醒">
            <Icon name="bell" size={13} />待处理 <span className="count">{pendingCount}</span>
          </button>
        )}
        <button className="wb-btn primary" onClick={openQuickEntry} disabled={busy}><Icon name="sparkles" /><span className="wb-label">快速录入</span></button>
        <button className="wb-btn" onClick={() => setShowForm((v) => !v)}><Icon name="plus" /><span className="wb-label">新建</span></button>
        <button className="wb-btn" onClick={() => setShowSettings((v) => !v)}><Icon name="settings" /><span className="wb-label">设置</span></button>
        <button className="wb-btn" onClick={collapseAll}><Icon name="list" /><span className="wb-label">收起全部</span></button>
        <button className="wb-btn" onClick={() => closePanel()}><Icon name="back" /><span className="wb-label">返回对话</span></button>
      </div>

      {folderForm !== null && (
        <div className="wb-modal-mask" onClick={() => setFolderForm(null)}>
          <div className="wb-modal" style={{ width: 'min(460px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <h4><Icon name="folder" />{folderForm.mode === 'create' ? '新建文件夹' : '重命名文件夹'}</h4>
            <p>点子可以同时属于多个文件夹；删除文件夹不会删除点子，它们会回到「未归类」。</p>
            <label style={{ display: 'block', marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>文件夹名称</span>
              <input
                autoFocus
                value={folderForm.title}
                onChange={(e) => setFolderForm((prev) => prev === null ? prev : { ...prev, title: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveFolder() } }}
                placeholder="例如：工作台 · 微信提醒方向"
                style={{ width: '100%', marginTop: 4, boxSizing: 'border-box', background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--wb-line, rgba(127,127,127,.26))', color: 'inherit', borderRadius: 8, padding: '8px 10px', font: 'inherit' }}
              />
            </label>
            <label style={{ display: 'block' }}>
              <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>一句话说明（可选）</span>
              <textarea
                value={folderForm.summaryMd}
                onChange={(e) => setFolderForm((prev) => prev === null ? prev : { ...prev, summaryMd: e.target.value })}
                placeholder="这个文件夹收的是哪一类点子"
                style={{ minHeight: 72 }}
              />
            </label>
            <div className="wb-modal-actions">
              <button className="wb-btn" onClick={() => setFolderForm(null)}>取消</button>
              <button className="wb-btn primary" onClick={() => void saveFolder()}>{folderForm.mode === 'create' ? '创建' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
      {promptModal !== null && (
        <div className="wb-modal-mask" onClick={cancelPrompt}>
          <div className="wb-modal" style={skillsAvailable ? { width: 'min(620px, 94vw)' } : undefined} onClick={(e) => e.stopPropagation()}>
            <h4>补充 AI 提示词</h4>
            <p>{promptModal.title}：可留空，留空则继续使用原有默认提示词；填写后会在默认提示词末尾追加你的补充要求。</p>
            <textarea autoFocus value={promptModal.value} onChange={(e) => setPromptModal((prev) => prev === null ? prev : { ...prev, value: e.target.value })} placeholder="输入你想追加给 AI 的补充要求…" />
            {skillsAvailable && (
              <div className="wb-skill-picker">
                <div className="wb-skill-picker-head">
                  <span><Icon name="skill" size={13} /> 加载 Skill</span>
                  <span className="wb-skill-count">{selectedSkills.length > 0 ? `已选 ${selectedSkills.length}` : '可选'}</span>
                </div>
                <input
                  className="wb-skill-search"
                  value={skillQuery}
                  onChange={(e) => setSkillQuery(e.target.value)}
                  placeholder={`搜索技能名或描述（共 ${skillCatalog.length} 个）`}
                />
                {selectedSkills.length > 0 && (
                  <div className="wb-skill-selected">
                    {selectedSkills.map((name) => (
                      <button key={name} type="button" className="wb-skill-tag" onClick={() => toggleSkill(name)} title="点击移除">
                        {name}<span aria-hidden="true">×</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="wb-skill-list">
                  {skillsLoading && <div className="wb-skill-hint">加载技能目录…</div>}
                  {!skillsLoading && visibleSkills.length === 0 && (
                    <div className="wb-skill-hint">{skillCatalog.length === 0 ? '本机暂无可选技能' : '没有匹配的技能'}</div>
                  )}
                  {!skillsLoading && visibleSkills.map((skill) => {
                    const checked = selectedSkills.includes(skill.name)
                    return (
                      <label key={skill.name} className={`wb-skill-item${checked ? ' on' : ''}`} title={skill.whenToUse ?? skill.description}>
                        <input type="checkbox" checked={checked} onChange={() => toggleSkill(skill.name)} />
                        <span className="wb-skill-body">
                          <span className="wb-skill-name">{skill.name}</span>
                          <span className="wb-skill-desc">{skill.description || '（无描述）'}</span>
                        </span>
                        <span className="wb-skill-provider">{skill.provider}</span>
                      </label>
                    )
                  })}
                </div>
                <div className="wb-skill-foot">选中后会在提示词开头注入“请加载这些技能”的指令，技能正文由 AI 按需加载。</div>
              </div>
            )}
            <div className="wb-modal-actions">
              <button className="wb-btn" onClick={cancelPrompt}>取消</button>
              <button className="wb-btn primary" onClick={confirmPrompt}>开始</button>
            </div>
          </div>
        </div>
      )}
      {filePickerOpen && (
        <div className="wb-modal-mask" onClick={() => setFilePickerOpen(false)}>
          <div className="wb-modal" style={{ width: 'min(640px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <h4><Icon name="folder" />选择本地文档</h4>
            <p>浏览并选择一个文件；目录可点击进入，文件可“选择”或“选择并 AI 总结”。</p>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
              <button className="wb-btn" disabled={filePickerParent === null || filePickerLoading} onClick={() => filePickerParent !== null && void loadFilePickerDir(filePickerParent)}>上级</button>
              <code style={{ flex: 1, fontSize: 12, wordBreak: 'break-all', color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', borderRadius: 6, padding: '4px 8px' }}>{filePickerDir || '加载中…'}</code>
              <button className="wb-btn" onClick={() => void loadFilePickerDir()}>主页</button>
            </div>
            {filePickerError !== null && <div style={{ color: '#E74C3C', fontSize: 12, marginBottom: 6 }}>{filePickerError}</div>}
            {filePickerLoading ? (
              <div style={{ padding: 16, color: '#999', fontSize: 13 }}>加载中…</div>
            ) : (
              <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', borderRadius: 8 }}>
                {filePickerEntries.length === 0 && <div style={{ padding: 12, color: '#999', fontSize: 12 }}>此目录没有可选择的文件</div>}
                {filePickerEntries.map((entry) => (
                  <div key={entry.path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer', borderBottom: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))' }} onClick={() => entry.isDirectory ? void loadFilePickerDir(entry.path) : undefined}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                      <Icon name={entry.isDirectory ? 'folder' : 'file'} size={13} /> {entry.name}
                    </span>
                    {entry.isDirectory ? (
                      <button className="wb-btn" onClick={(e) => { e.stopPropagation(); void loadFilePickerDir(entry.path) }}>进入</button>
                    ) : (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="wb-btn" onClick={(e) => { e.stopPropagation(); pickLocalFile(entry) }}>选择</button>
                        <button className="wb-btn primary" onClick={(e) => { e.stopPropagation(); pickAndSummarizeLocalFile(entry) }}>选择并总结</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="wb-modal-actions">
              <button className="wb-btn" onClick={() => setFilePickerOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
      {reminders.length > 0 && reminderModalOpen && (
        <Modal
          title={<><Icon name="bell" />到期提醒（{reminders.length}）</>}
          size="sm"
          onClose={() => setReminderModalOpen(false)}
          footer={(
            <>
              <span className="wb-foot-note">点「知道了」后不再提示；host 侧已推送的不会重复出现</span>
              <button className="wb-btn" onClick={() => setReminderModalOpen(false)}>稍后处理</button>
            </>
          )}
        >
          <div className="wb-scroll-area">
            {reminders.map((r) => (
              <div key={r.reminderId} className="wb-row" style={{ cursor: 'default' }}>
                <span style={{ flex: 1 }}>{r.title} · {fmtTime(r.dueAt)}</span>
                <button className="wb-btn" onClick={() => void ackReminder(r.reminderId)}>知道了</button>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {pendingDraft !== null && <DraftBanner
        draft={pendingDraft}
        runtime={runtime}
        closePanel={closePanel}
        kindName={(kind, code) => dicts.find((d) => d.kind === kind && d.code === code)?.name ?? code}
        onProblems={setDraftProblems}
        onNotice={(message, tone) => pushToast(message, tone)}
        onConfirmed={(outcome) => handleDraftConfirmed(outcome, pendingDraft)}
        switchedFrom={draftSwitchedFrom === null ? undefined : { kindCode: dicts.find((d) => d.kind === 'draft_kind' && d.code === draftSwitchedFrom.kindCode)?.name ?? draftSwitchedFrom.kindCode }}
        onDismissed={() => { dismissDraft(pendingDraft) }}
        /**
         * 「回到…会话」用：**只把横幅从投影里拿掉**，不触发任何网络刷新。
         *
         * 修的是 2026-09-13 用户实测的"点回到会话后过 5 秒弹框才消失"：
         * 旧路径只登记屏蔽集合、不动 `pendingDraft`，于是界面要等下一轮 5 秒轮询
         * 才被覆盖。这里同步清掉，同一帧就消失。
         */
        onSettled={() => setPendingDraft(null)}
        onDone={() => { setPendingDraft(null); setPlanRefreshKey((v) => v + 1); setReportRefreshKey((v) => v + 1); setKnowledgeRefreshKey((v) => v + 1); setIdeaRefreshKey((v) => v + 1); void refresh() }}
        /**
         * 右上角 X / Esc / 点遮罩 = **收起这条横幅**（不是放弃草稿）。
         *
         * 必须把 id 记进 dismissed 集合，否则 5 秒轮询立刻又把它推上来 ——
         * 用户看到的就是"关闭按钮没有任何逻辑，关掉 5 秒后又弹出"
         * （2026-09-12 实测 BUG）。草稿本身仍是 pending，会留在「待处理」里等你决定。
         */
        onClose={() => { dismissDraft(pendingDraft); setPendingDraft(null) }}
      />}

      {/**
        * 「库里已有同名任务」选择框（2026-09-13 重复建单事故）。
        *
        * 服务端**只告警、不静默合并**：同名任务可能是正当需求（每周例会），
        * 所以这里必须由用户明确选一次 —— 要么保留两条，要么把这次的产出收口到已有那条上。
        */}
      {duplicatePrompt !== null && (
        <Modal
          title={<>⚠️ 库里已经有一条同名任务</>}
          size="sm"
          onClose={() => setDuplicatePrompt(null)}
          footer={(
            <>
              <button className="wb-btn" onClick={() => setDuplicatePrompt(null)}>保留两条，我自己处理</button>
              <button className="wb-btn primary" onClick={() => void reuseExistingTask(duplicatePrompt)}>
                就用已有那条（归档本次新建的那条）
              </button>
            </>
          )}
        >
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div style={{ marginBottom: 6 }}>标题：<b>{duplicatePrompt.existingTitle}</b></div>
            <div style={{ marginBottom: 6, color: 'var(--dsw-alias-label-secondary)' }}>
              本次草稿确认后，库里现在有两条同名任务。已有那条 id：{duplicatePrompt.existingTaskId.slice(0, 8)}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' }}>
              {duplicatePrompt.sameDescription
                ? '两条的**描述逐字相同** —— 很可能是同一件事被提交了两次（例如执行会话又交了一份草稿）。'
                : '两条的描述**不同** —— 可能是两次独立录入，也可能是执行会话重复提交，请自行判断。'}
              {duplicatePrompt.sameWorkspace ? ' 工作区相同。' : ' 工作区不同。'}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
              「就用已有那条」会把这条草稿收口到已有任务上，并归档本次新建的那条
              （可在任务列表页「查看归档」恢复，不会丢数据）。
            </div>
          </div>
        </Modal>
      )}

      <div className="wb-body">
        {draftProblems.length > 0 && (
          <div className="wb-draft-problems" role="alert">
            <h5>⚠️ 有 {draftProblems.length} 项没能创建（其余已正常入册）</h5>
            {draftProblems.map((p, i) => (
              <div key={i}>
                <b>{p.title === '' ? '(无标题)' : p.title}</b>：{p.reason}
                <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>（{p.field} = {p.code}）</span>
              </div>
            ))}
            <div style={{ marginTop: 6, color: 'var(--dsw-alias-label-secondary)' }}>
              这些条目<b>没有被创建</b>。请让 AI 用合法 code 重新提交，或在界面上手动补建。
            </div>
            <button className="wb-btn" style={{ marginTop: 6 }} onClick={() => setDraftProblems([])}>知道了，关闭提示</button>
          </div>
        )}
        <div className="wb-nav">
      {showSettings && (
        <SettingsModal
          settings={settings}
          onSettingsChange={setSettings}
          onSaveSettings={saveSettings}
          saving={settingsSaving}
          notifyPermission={notifyPerm}
          onRequestNotifyPermission={() => {
            void Notification.requestPermission().then((perm) => {
              setNotifyPerm(perm)
              if (perm === 'granted') pushToast('桌面通知已开启', 'success')
            })
          }}
          onSendTestNotification={() => {
            try { new Notification('dsh-personal-workbench 通知测试', { body: '如果你看到这条系统通知，说明桌面提醒已正常工作。' }) } catch { /* ignore */ }
          }}
          reminderPolicy={reminderPolicy}
          onReminderPolicyChange={setReminderPolicy}
          onSaveReminderPolicy={saveReminderPolicy}
          reminderChannel={reminderChannel}
          reminderOptions={reminderOptions}
          reminderBusy={reminderBusy}
          onSelectTarget={(botId, targetId) => setReminderChannel((prev) => prev === null ? prev : { ...prev, botId, targetId })}
          onSaveTarget={saveReminderTarget}
          onRefreshChannel={loadReminderChannel}
          onSendTestMessage={sendReminderTest}
          dicts={dicts}
          dictKind={dictKind}
          onDictKindChange={setDictKind}
          dictForm={dictForm}
          onDictFormChange={setDictForm}
          dictEditCode={dictEditCode}
          onDictEditCodeChange={setDictEditCode}
          dictError={dictError}
          onDictErrorChange={setDictError}
          onSaveDictionary={saveDictionaryEntry}
          onToggleDictionary={toggleDictionaryEntry}
          onDeleteDictionary={deleteDictionaryEntry}
          onClose={() => setShowSettings(false)}
        />
      )}
          {view === 'today' && (
            <>
              <div className="wb-stats wb-stats-sticky">
                <div className="wb-stat"><b>{bootstrap?.stats.overdue ?? 0}</b><span>逾期</span></div>
                <div className="wb-stat"><b>{bootstrap?.stats.todayDue ?? 0}</b><span>今天到期</span></div>
                <div className="wb-stat"><b>{bootstrap?.stats.doing ?? 0}</b><span>进行中</span></div>
                <div className="wb-stat"><b>{bootstrap?.stats.total ?? 0}</b><span>总数</span></div>
              </div>

              {/* 今日容量：把"今天投得进多少时间"显式化（estimatedMinutes 按优先级摊成一条时间轴） */}
              <div className="wb-cap">
                <div className="wb-cap-head">
                  <h3>今日容量</h3>
                  <div className="wb-cap-meta">
                    <span>已排 <b>{capacity.planned}</b> min</span>
                    <span>
                      可投入{' '}
                      <b>
                        {capacityEdit === null
                          ? <span className="wb-cap-edit" title="点击修改每天可投入时长" onClick={() => setCapacityEdit(String(settings.dailyCapacityMinutes))}>{settings.dailyCapacityMinutes}</span>
                          : <input
                              autoFocus
                              type="number"
                              min={30}
                              max={1440}
                              step={30}
                              value={capacityEdit}
                              style={{ width: 64, font: 'inherit', fontVariantNumeric: 'tabular-nums' }}
                              onChange={(e) => setCapacityEdit(e.target.value)}
                              onBlur={() => void saveDailyCapacity()}
                              onKeyDown={(e) => { if (e.key === 'Enter') void saveDailyCapacity(); if (e.key === 'Escape') setCapacityEdit(null) }}
                            />}
                      </b>{' '}
                      min
                    </span>
                    <span>余 <b>{capacity.free}</b> min</span>
                  </div>
                </div>
                <div className="wb-cap-bar" role="img" aria-label={`今日任务时间占比：紧急 ${capacity.byPriority.p0} 分钟、高 ${capacity.byPriority.p1} 分钟、普通 ${capacity.byPriority.p2} 分钟、低 ${capacity.byPriority.p3} 分钟、空闲 ${capacity.free} 分钟`}>
                  {(['p0', 'p1', 'p2', 'p3'] as const).map((code) => capacity.byPriority[code] > 0
                    ? <i key={code} className={code} style={{ width: `${(capacity.byPriority[code] / capacity.total) * 100}%` }} title={`${code} · ${capacity.byPriority[code]} min`} />
                    : null)}
                  {capacity.free > 0 && <i className="free" style={{ width: `${(capacity.free / capacity.total) * 100}%` }} title={`空闲 · ${capacity.free} min`} />}
                </div>
                <div className="wb-cap-legend">
                  <span><i style={{ background: 'var(--wb-p0)' }} />紧急 <b>{capacity.byPriority.p0}</b></span>
                  <span><i style={{ background: 'var(--wb-p1)' }} />高 <b>{capacity.byPriority.p1}</b></span>
                  <span><i style={{ background: 'var(--wb-p2)' }} />普通 <b>{capacity.byPriority.p2}</b></span>
                  <span><i style={{ background: 'var(--wb-p3)' }} />低 <b>{capacity.byPriority.p3}</b></span>
                  <span><i style={{ background: 'color-mix(in srgb, var(--wb-ok) 36%, transparent)' }} />空闲 <b>{capacity.free}</b></span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button className="wb-btn primary" disabled={busy || openTasks.length === 0} onClick={() => void startAISession('plan', null, localDateString())}><Icon name="sparkles" />{todayPlan !== null || (pendingDraft?.kindCode === 'daily_plan' && String(pendingDraft.payload.planDate ?? '') === todayAnchor) ? '继续编辑今日计划' : 'AI 智能排序'}</button>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', alignSelf: 'center' }}>AI 会先提交顺序提案，确认后才生效</span>
              </div>
              {todayPlan !== null && (
                <PlanPanel
                  plan={todayPlan}
                  tasks={tasks}
                  title={`今日计划 · ${todayPlan.planDate}`}
                  onComplete={completePlanTask}
                  onDefer={deferPlanTask}
                  onRefresh={() => void startAISession('plan', null, localDateString())}
                  onClear={() => void clearTodayPlan()}
                  onSave={(items) => savePlan(localDateString(), items)}
                />
              )}
              <div className="wb-list">
                <TaskTreeRows roots={todayTree} depth={0} expanded={todayExpanded} toggle={toggleTodayExpanded} dicts={dicts} onOpen={openTask} selectedId={selected?.task.id} />
                {openTasks.length === 0 && (
                  <div className="wb-empty" style={{ padding: '28px 18px' }}>
                    <div style={{ marginBottom: 6, color: 'var(--dsw-alias-state-business-primary, #4f8ef7)' }}><Icon name="today" size={30} /></div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>今天没有需要关注的任务</div>
                    <div style={{ fontSize: 12, opacity: .8, marginBottom: 12 }}>可以快速录入一个新任务，或新建一个待办</div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                      <button className="wb-btn primary" onClick={openQuickEntry}>快速录入</button>
                      <button className="wb-btn" onClick={() => setShowForm((v) => !v)}>新建任务</button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {view === 'calendar' && (
            <>
              <div className="wb-cal-nav">
                <button className="wb-btn" onClick={() => (calMode === 'week' ? moveWeek(-1) : moveMonth(-1))}>◀</button>
                <button className="wb-btn" onClick={() => (calMode === 'week' ? setCursor(startOfWeek(now)) : setCursor(new Date(now.getFullYear(), now.getMonth(), 1)))}>今天</button>
                <button className="wb-btn" onClick={() => (calMode === 'week' ? moveWeek(1) : moveMonth(1))}>▶</button>
                <div style={{ flex: 1, textAlign: 'center', fontWeight: 600 }}>
                  {calMode === 'week' ? `${cursor.getFullYear()}/${cursor.getMonth() + 1}/${cursor.getDate()} 周` : `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`}
                </div>
                <div className="wb-segmented wb-sub-segmented">
                  <button className={`wb-seg ${calMode === 'week' ? 'on' : ''}`} onClick={() => setCalMode('week')}>周</button>
                  <button className={`wb-seg ${calMode === 'month' ? 'on' : ''}`} onClick={() => setCalMode('month')}>月</button>
                </div>
              </div>

              {calMode === 'week' && (
                <div className="wb-week">
                  {weekDays.map((d) => {
                    const n = tasks.filter((t) => isTaskDueOnDay(t, d)).length
                    return (
                      <div key={d.toISOString()} className={`wb-day ${sameDay(d, now) ? 'today' : ''} ${sameDay(d, picked) ? 'selected' : ''}`} onClick={() => setPicked(startOfDay(d))}>
                        <div className="wb-day-date" style={{ fontSize: 12, color: '#999' }}>{d.getMonth() + 1}/{d.getDate()}</div>
                        {n > 0 && <div className="wb-chip" style={{ background: '#4f8ef7', marginTop: 4 }}>{n} 个任务</div>}
                      </div>
                    )
                  })}
                </div>
              )}
              {calMode === 'month' && (
                <div className="wb-month">
                  {monthGrid.map((d) => (
                    <div key={d.toISOString()} className={`wb-mday ${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${sameDay(d, now) ? 'today' : ''} ${sameDay(d, picked) ? 'selected' : ''}`} onClick={() => setPicked(startOfDay(d))}>
                      <div className="wb-mday-date" style={{ fontSize: 12 }}>{d.getDate()}</div>
                      {tasks.some((t) => isTaskDueOnDay(t, d)) && <div className="wb-chip" style={{ background: '#4f8ef7', marginTop: 2 }}>•</div>}
                    </div>
                  ))}
                </div>
              )}

              <div className="wb-segmented wb-sub-segmented">
                <button className={`wb-seg ${dayTab === 'plan' ? 'on' : ''}`} onClick={() => setDayTab('plan')}><Icon name="list" />计划 <span className="count">{countTaskTree(pickedPlanTree)}</span></button>
                <button className={`wb-seg ${dayTab === 'done' ? 'on' : ''}`} onClick={() => setDayTab('done')}><Icon name="check" />已完成 <span className="count">{countTaskTreeBy(pickedDoneTree, doneKeep)}</span></button>
                <button className={`wb-seg ${dayTab === 'report' ? 'on' : ''}`} onClick={() => setDayTab('report')}><Icon name="report" />报告</button>
              </div>
              {dayTab === 'plan' && (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                    {pickedAnchor < todayAnchor
                      ? <span style={{ fontSize: 12, color: '#999' }}>过去日期只读；如需为今天/未来排期，请选择今天或之后的日期。</span>
                      : <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('plan', null, pickedAnchor)}><Icon name="sparkles" />{pickedPlan !== null || (pendingDraft?.kindCode === 'daily_plan' && String(pendingDraft.payload.planDate ?? '') === pickedAnchor) ? '继续编辑该日计划' : `AI 智能排序（${pickedAnchor}）`}</button>}
                    <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>AI 会先提交顺序提案，确认后才生效</span>
                  </div>
                  {pickedPlan !== null && (
                    <PlanPanel
                      plan={pickedPlan}
                      tasks={tasks}
                      title={`${pickedPlan.planDate} 计划`}
                      canEdit={pickedAnchor >= todayAnchor}
                      onComplete={completePlanTask}
                      onDefer={deferPlanTask}
                      onRefresh={pickedAnchor >= todayAnchor ? () => void startAISession('plan', null, pickedAnchor) : undefined}
                      onClear={() => {
                        void api(`/api/workbench/plans/${pickedAnchor}`, { method: 'DELETE' }).then(() => { setPlanRefreshKey((v) => v + 1); setNotice('该日计划已清除') }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                      }}
                      onSave={(items) => savePlan(pickedAnchor, items)}
                    />
                  )}
                </>
              )}
              {dayTab === 'plan' && sameDay(picked, now) && noDueOpen.length > 0 && (
                <div style={{ fontSize: 12, color: '#999', padding: '4px 2px' }}>另有 {noDueOpen.length} 个进行中任务未设置截止时间，暂列今天；点击父任务 ▶ 展开子任务</div>
              )}
              {dayTab === 'report' ? (
                <div className="wb-card">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div className="wb-segmented wb-sub-segmented">
                      <button className={`wb-seg ${reportSubTab === 'day' ? 'on' : ''}`} onClick={() => setReportSubTab('day')}>日报（{localDateString(picked)}）</button>
                      <button className={`wb-seg ${reportSubTab === 'week' ? 'on' : ''}`} onClick={() => setReportSubTab('week')}>周报（{localDateString(startOfWeek(picked))} 起）</button>
                    </div>
                    <div style={{ flex: 1 }} />
                  </div>
                  {reportIsFuture ? (
                    <div className="wb-empty">
                      未来日期属于工作安排，报告只做复盘。<br />如需安排未来工作，请在「计划」页签给任务设置截止时间；AI 未来排期将在下版支持。
                    </div>
                  ) : currentReport !== null ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                        <h4 style={{ flex: 1, margin: 0 }}>{currentReport.title}</h4>
                        <button className="wb-btn" onClick={() => {
                          void api(`/api/workbench/reports/${currentReport.periodCode}/${currentReport.periodStart}`, { method: 'DELETE' }).then(() => { setCurrentReport(null); setReportSession(null); void refresh() }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                        }}>删除</button>
                      </div>
                      <div style={{ marginTop: 6 }}><MarkdownText text={currentReport.summaryMd} /></div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('report', null, `${reportSubTab}:${reportAnchor}`)}>
                          {reportSession !== null || currentReport.sessionId !== null ? '继续编辑报告' : 'AI 生成报告'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="wb-empty" style={{ marginTop: 8 }}>
                      {reportSubTab === 'week' ? '本周' : '当天'}还没有报告。
                      <div style={{ marginTop: 10 }}>
                        <button className="wb-btn primary lg" disabled={busy} onClick={() => void startAISession('report', null, `${reportSubTab}:${reportAnchor}`)}>
                          {reportSession !== null ? '继续编辑报告' : `AI 生成${reportSubTab === 'week' ? '周报' : '日报'}（${reportAnchor}）`}
                        </button>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 8 }}>同一周期只有一个报告会话，重复点击会回到原会话继续修改。</div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="wb-list">
                  <TaskTreeRows roots={dayTab === 'plan' ? pickedPlanTree : pickedDoneTree} depth={0} expanded={calendarExpanded} toggle={toggleCalendarExpanded} dicts={dicts} onOpen={openTask} selectedId={selected?.task.id} contextIds={dayTab === 'done' ? doneContextIds : undefined} />
                  {(dayTab === 'plan' ? pickedPlanTree : pickedDoneTree).length === 0 && (
                    <div className="wb-empty" style={{ padding: '24px 18px' }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{picked.getMonth() + 1}/{picked.getDate()} 没有{dayTab === 'plan' ? '计划任务' : '完成记录'}</div>
                      {dayTab === 'plan' && pickedAnchor >= todayAnchor
                        ? <button className="wb-btn primary" style={{ marginTop: 8 }} onClick={() => void startAISession('plan', null, pickedAnchor)}>AI 智能排序</button>
                        : <div style={{ fontSize: 12, opacity: .8, marginTop: 4 }}>切换到其他日期查看计划/记录</div>}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {view === 'knowledge' && (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <input style={{ flex: 1, minWidth: 180, background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }} placeholder="本地文档路径或 file://，如 D:\docs\方案.md、/mnt/d/docs/方案.md" value={localDocPath} onChange={(e) => setLocalDocPath(e.target.value)} />
                <button className="wb-btn" disabled={busy} onClick={openFilePicker}><Icon name="folder" />选择文件</button>
                <button className="wb-btn primary" disabled={busy} onClick={() => void summarizeLocalDoc()}><Icon name="file" />AI 总结本地文档</button>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <input style={{ flex: 1, minWidth: 140, background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }} placeholder="搜索标题 / 内容 / 标签" value={knowledgeQuery} onChange={(e) => setKnowledgeQuery(e.target.value)} />
                <select style={{ background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }} value={knowledgeKind} onChange={(e) => setKnowledgeKind(e.target.value)}>
                  <option value="">全部分类</option>
                  {dictOf('knowledge_kind').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                </select>
                <button className="wb-btn primary" onClick={() => { setKnowledgeEditId(null); setKnowledgeDraft({ title: '', contentMd: '', kindCode: 'note', tags: '', sourceTaskId: '', sourceReviewId: '', fileLink: '' }) }}><Icon name="plus" />新建</button>
              </div>
              <div className="wb-list">
                {knowledgeEntries.map((entry) => (
                  <div key={entry.id} className={`wb-row ${selectedKnowledge?.id === entry.id ? 'selected' : ''}`} onClick={() => { setKnowledgeEditId(null); setKnowledgeDraft(null); setSelectedKnowledge(entry) }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{entry.title}</div>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginTop: 3 }}>
                        <Badge dict={dictOf('knowledge_kind')} code={entry.kindCode} />
                        {entry.tags.map((tag) => <span key={tag} style={{ fontSize: 11, color: '#999' }}>#{tag}</span>)}
                        {entry.fileLink !== null && entry.fileLink !== '' && <span title={entry.fileLink} style={{ fontSize: 11, color: '#999', display: 'inline-flex', alignItems: 'center', gap: 2 }}><Icon name="file" size={11} />文件</span>}
                        <span style={{ fontSize: 11, color: '#999' }}>{new Date(entry.updatedAt).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {knowledgeEntries.length === 0 && (
                  <div className="wb-empty" style={{ padding: '28px 18px' }}>
                    <div style={{ marginBottom: 6, color: 'var(--dsw-alias-state-business-primary, #4f8ef7)' }}><Icon name="book" size={30} /></div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>还没有知识条目</div>
                    <div style={{ fontSize: 12, opacity: .8, marginBottom: 12 }}>沉淀经验教训、决策和可复用片段；也可以在 AI 复盘后一键写入</div>
                    <button className="wb-btn primary" onClick={() => { setKnowledgeEditId(null); setKnowledgeDraft({ title: '', contentMd: '', kindCode: 'note', tags: '', sourceTaskId: '', sourceReviewId: '', fileLink: '' }) }}>新建知识</button>
                  </div>
                )}
              </div>
            </>
          )}

          {view === 'ideas' && (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <div className="wb-segmented wb-sub-segmented">
                  <button className={`wb-seg ${ideaTab === 'ideas' ? 'on' : ''}`} onClick={() => { setIdeaTab('ideas'); setSelectedCluster(null) }}>全部（{ideas.length}）</button>
                  <button className={`wb-seg ${ideaTab === 'unfiled' ? 'on' : ''}`} onClick={() => { setIdeaTab('unfiled'); setSelectedCluster(null) }}>未归类（{unfiledIdeas.length}）</button>
                  <button className={`wb-seg ${ideaTab === 'clusters' ? 'on' : ''}`} onClick={() => { setIdeaTab('clusters'); setSelectedIdea(null) }}>文件夹（{ideaClusters.length}）</button>
                </div>
                <input style={{ flex: 1, minWidth: 120, background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--wb-line, rgba(127,127,127,.26))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }} placeholder="搜索点子或文件夹" value={ideaQuery} onChange={(e) => setIdeaQuery(e.target.value)} />
                {ideas.length >= 2 && <button className="wb-btn primary" disabled={busy} onClick={() => { const ids = selectedIdeaIds.size >= 2 ? [...selectedIdeaIds] : ideas.map((idea) => idea.id); void startAISession('idea_association', null, ids.sort().join(',')) }}><Icon name="sparkles" />{selectedIdeaIds.size >= 2 ? `AI 关联（已选 ${selectedIdeaIds.size}）` : 'AI 自动关联'}</button>}
                <button className="wb-btn" onClick={() => setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}><Icon name="folder" />新建文件夹</button>
                <button className="wb-btn" onClick={() => { setIdeaEditId(null); setIdeaForm({ title: '', contentMd: '', kindCode: 'spark', tags: '' }); setSelectedIdea(null) }}><Icon name="plus" />记个点子</button>
              </div>
              {ideaTab === 'ideas' || ideaTab === 'clusters' ? (
                <>
                  {ideaClusters.length > 0 && (
                    <>
                      <div className="wb-idea-crumb">
                        <b>文件夹</b> · {ideaClusters.length} 个
                        <span style={{ flex: 1 }} />
                        <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }}>点开看成员；hover 可改名 / 删除</span>
                      </div>
                      <div className="wb-folder-grid">
                        {ideaClusters.map((cluster) => (
                          <div key={cluster.id} className={`wb-folder ${selectedCluster?.id === cluster.id ? 'selected' : ''}`} onClick={() => { setSelectedIdea(null); setSelectedCluster(cluster) }}>
                            <div className="wb-folder-acts" onClick={(e) => e.stopPropagation()}>
                              <button className="wb-icon-btn" title="重命名" onClick={() => setFolderForm({ mode: 'rename', id: cluster.id, title: cluster.title, summaryMd: cluster.summaryMd })}><Icon name="edit" size={13} /></button>
                              <button className="wb-icon-btn" title="删除文件夹（点子保留）" onClick={() => void deleteFolder(cluster.id)}><Icon name="trash" size={13} /></button>
                            </div>
                            <div className="wb-folder-head">
                              <span className="wb-folder-ic"><Icon name="folder" size={13} /></span>
                              <h4>{cluster.title}</h4>
                              <span className="wb-folder-cnt">{cluster.ideas.length}</span>
                            </div>
                            <div className="wb-folder-mini">
                              {cluster.ideas.slice(0, 2).map((idea) => <span key={idea.id}>{idea.title}</span>)}
                              {cluster.ideas.length > 2 && <span className="more">还有 {cluster.ideas.length - 2} 个…</span>}
                              {cluster.ideas.length === 0 && <span className="more">空文件夹 · 可从下方点子归入</span>}
                            </div>
                          </div>
                        ))}
                        <div className="wb-folder new" onClick={() => setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}>+ 新建空文件夹<br /><span style={{ fontSize: 11.5 }}>也可以让 AI 自动关联</span></div>
                      </div>
                    </>
                  )}
                  <div className="wb-idea-crumb">
                    <b>未归类</b> · {unfiledIdeas.length} 个
                    <span style={{ flex: 1 }} />
                    {selectedIdeaIds.size > 0 && <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }}>已选 {selectedIdeaIds.size} 个</span>}
                  </div>
                </>
              ) : (
                <div className="wb-idea-crumb"><b>未归类</b> · {unfiledIdeas.length} 个<span style={{ flex: 1 }} /></div>
              )}
              {ideaTab !== 'clusters' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 9 }}>
                    {unfiledIdeas.map((idea) => (
                      <div key={idea.id} className={`wb-card wb-idea-card ${selectedIdea?.id === idea.id || selectedIdeaIds.has(idea.id) ? 'selected' : ''}`} style={{ marginBottom: 0 }} onClick={() => { setSelectedCluster(null); setSelectedIdea(idea) }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                          <input type="checkbox" checked={selectedIdeaIds.has(idea.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => setSelectedIdeaIds((prev) => { const next = new Set(prev); if (e.target.checked) next.add(idea.id); else next.delete(idea.id); return next })} style={{ width: 16, height: 16, flex: 'none', cursor: 'pointer' }} />
                          <b style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{idea.title}</b>
                        </div>
                        <div className="wb-idea-summary">{idea.contentMd.replace(/[#*`>]/g, '').slice(0, 80) || '（无内容）'}</div>
                        <div className="wb-idea-foot">
                          <Badge dict={dictOf('idea_kind')} code={idea.kindCode} />
                          {idea.tags.slice(0, 3).map((tag) => <span key={tag} style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>#{tag}</span>)}
                        </div>
                        <div style={{ marginTop: 8, position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                          <button className="wb-btn" style={{ fontSize: 11.5, padding: '3px 8px' }} disabled={ideaClusters.length === 0} title={ideaClusters.length === 0 ? '先在右上角新建一个文件夹' : '归入文件夹（一个点子可属于多个）'} onClick={() => setFolderMenuIdeaId((prev) => prev === idea.id ? null : idea.id)}>归入文件夹 ▾</button>
                          {folderMenuIdeaId === idea.id && (
                            <div style={{ position: 'absolute', zIndex: 30, top: '100%', left: 0, marginTop: 4, minWidth: 200, background: 'var(--dsw-alias-bg-layer-2, #1c1c1f)', border: '1px solid var(--wb-line, rgba(127,127,127,.26))', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,.25)', padding: 4 }}>
                              {ideaClusters.map((cluster) => (
                                <button key={cluster.id} className="wb-btn" style={{ width: '100%', justifyContent: 'flex-start', border: 'none', background: 'transparent' }} onClick={() => void fileIdeaInto(idea.id, cluster.id)}>
                                  <Icon name="folder" size={13} />{cluster.title}
                                </button>
                              ))}
                              <button className="wb-btn" style={{ width: '100%', justifyContent: 'flex-start', border: 'none', background: 'transparent' }} onClick={() => { setFolderMenuIdeaId(null); setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' }) }}>
                                <Icon name="plus" size={13} />新建文件夹…
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {unfiledIdeas.length === 0 && (
                      <div className="wb-empty" style={{ gridColumn: '1 / -1', padding: '26px 18px' }}>
                        <div className="wb-empty-ic"><Icon name="idea" size={17} /></div>
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>{ideas.length === 0 ? '还没有点子' : '所有点子都已归类'}</div>
                        <div style={{ fontSize: 12, opacity: .8, marginBottom: 12 }}>{ideas.length === 0 ? '把一闪而过的灵感先记下来，之后可以 AI 找关联、头脑风暴' : '新记的点子会先出现在这里'}</div>
                        <button className="wb-btn primary" onClick={() => { setIdeaEditId(null); setIdeaForm({ title: '', contentMd: '', kindCode: 'spark', tags: '' }); setSelectedIdea(null) }}>记个点子</button>
                      </div>
                    )}
                  </div>
                </>
              )}
              {ideaTab === 'clusters' && ideaClusters.length === 0 && (
                <div className="wb-empty" style={{ padding: '26px 18px' }}>
                  <div className="wb-empty-ic"><Icon name="folder" size={17} /></div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>还没有文件夹</div>
                  <div style={{ fontSize: 12, opacity: .8, marginBottom: 12 }}>先手动建一个，或者选中 2 个以上点子点「AI 关联」自动生成</div>
                  <button className="wb-btn primary" onClick={() => setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}>新建文件夹</button>
                </div>
              )}
            </>
          )}

          {view === 'list' && (
            <>
              <div style={{ position: 'relative', zIndex: 25, display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  style={{ position: 'relative', zIndex: 25, flex: 1, minWidth: 140, background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }}
                  placeholder="搜索标题 / 描述"
                  value={taskFilter.keyword}
                  onChange={(e) => setTaskFilter((prev) => ({ ...prev, keyword: e.target.value }))}
                />
                <MultiSelectDropdown
                  label="状态"
                  options={dictOf('status')}
                  selected={taskFilter.statusCodes}
                  open={openFilter === 'status'}
                  onToggle={() => setOpenFilter((prev) => prev === 'status' ? null : 'status')}
                  onClose={() => setOpenFilter(null)}
                  onChange={(codes) => setTaskFilter((prev) => ({ ...prev, statusCodes: codes }))}
                />
                <MultiSelectDropdown
                  label="优先级"
                  options={dictOf('priority')}
                  selected={taskFilter.priorityCodes}
                  open={openFilter === 'priority'}
                  onToggle={() => setOpenFilter((prev) => prev === 'priority' ? null : 'priority')}
                  onClose={() => setOpenFilter(null)}
                  onChange={(codes) => setTaskFilter((prev) => ({ ...prev, priorityCodes: codes }))}
                />
                <MultiSelectDropdown
                  label="类型"
                  options={dictOf('type')}
                  selected={taskFilter.typeCodes}
                  open={openFilter === 'type'}
                  onToggle={() => setOpenFilter((prev) => prev === 'type' ? null : 'type')}
                  onClose={() => setOpenFilter(null)}
                  onChange={(codes) => setTaskFilter((prev) => ({ ...prev, typeCodes: codes }))}
                  alignRight
                />
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>排序</span>
                <select
                  style={{ background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }}
                  value={taskSortKey}
                  onChange={(e) => setTaskSortKey(e.target.value as TaskSortKey)}
                >
                  <option value="dueAt">截止时间</option>
                  <option value="priority">优先级</option>
                  <option value="createdAt">创建时间</option>
                  <option value="title">标题</option>
                </select>
                <button className="wb-btn" onClick={() => setTaskSortDir((prev) => prev === 'asc' ? 'desc' : 'asc')} title={taskSortDir === 'asc' ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序'}>
                  {taskSortDir === 'asc' ? '↑ 升序' : '↓ 降序'}
                </button>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>共 {countTaskTree(visibleTaskTree)} 条</span>
                <div style={{ flex: 1 }} />
                <button className="wb-btn" disabled={isTaskFilterEmpty(taskFilter)} onClick={() => setTaskFilter({ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] })}><Icon name="refresh" />清空</button>
                <button className="wb-btn" onClick={() => {
                  const next = !archivedMode
                  setArchivedMode(next)
                  if (next) { void api<{ tasks: Task[] }>('/api/workbench/tasks?archived=true').then((r) => setArchivedTasks(r.tasks)).catch(() => undefined) }
                }}>{archivedMode ? '返回任务' : '查看归档'}</button>
              </div>
              <div className="wb-list">
                <TaskTreeRows roots={visibleTaskTree} depth={0} expanded={expanded} toggle={toggleExpanded} dicts={dicts} onOpen={openTask} selectedId={selected?.task.id} />
                {archivedMode && archivedTasks.length === 0 && <div className="wb-empty">没有归档任务</div>}
                {!archivedMode && tasks.length === 0 && <div className="wb-empty">还没有任务，点“快速录入”或“新建”开始</div>}
                {!isTaskFilterEmpty(taskFilter) && visibleTaskTree.length === 0 && <div className="wb-empty">没有符合条件的任务，点“清空”恢复完整列表</div>}
              </div>
            </>
          )}
        </div>

        <div className="wb-detail">
          {view === 'ideas'
            ? ideaForm !== null
              ? (
                <form className="wb-form" onSubmit={(e) => {
                  e.preventDefault()
                  if (ideaForm.title.trim() === '') return
                  const tags = ideaForm.tags.split(/[,#，\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 20)
                  const isEdit = ideaEditId !== null
                  void api(isEdit ? `/api/workbench/ideas/${ideaEditId}` : '/api/workbench/ideas', { method: isEdit ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: ideaForm.title.trim(), contentMd: ideaForm.contentMd, kindCode: ideaForm.kindCode, tags }) })
                    .then(() => { setIdeaForm(null); setIdeaEditId(null); setIdeaRefreshKey((v) => v + 1); setNotice(isEdit ? '点子已更新' : '点子已保存') })
                    .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                }}>
                  <h4 className="full" style={{ margin: 0 }}>{ideaEditId === null ? '记个点子' : '编辑点子'}</h4>
                  <label className="full">标题<input value={ideaForm.title} onChange={(e) => setIdeaForm((prev) => prev === null ? prev : { ...prev, title: e.target.value })} placeholder="一句话说清这个点子" /></label>
                  <label>类型<select value={ideaForm.kindCode} onChange={(e) => setIdeaForm((prev) => prev === null ? prev : { ...prev, kindCode: e.target.value })}>{dictOf('idea_kind').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                  <label>标签<input value={ideaForm.tags} onChange={(e) => setIdeaForm((prev) => prev === null ? prev : { ...prev, tags: e.target.value })} placeholder="逗号/空格分隔，如 AI, 语音" /></label>
                  <label className="full">内容（可选，Markdown）<textarea rows={10} value={ideaForm.contentMd} onChange={(e) => setIdeaForm((prev) => prev === null ? prev : { ...prev, contentMd: e.target.value })} /></label>
                  <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit"><Icon name="check" />保存</button><button className="wb-btn" type="button" onClick={() => { setIdeaForm(null); setIdeaEditId(null) }}>取消</button></div>
                </form>
              )
              : selectedCluster !== null
                ? (
                  <div className="wb-card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <h4 style={{ flex: 1, margin: 0, minWidth: 120 }}><Icon name="folder" />{selectedCluster.title}</h4>
                      <button className="wb-btn" onClick={() => setFolderForm({ mode: 'rename', id: selectedCluster.id, title: selectedCluster.title, summaryMd: selectedCluster.summaryMd })}><Icon name="edit" />重命名</button>
                      {ideaClusters.length > 1 && (
                        <select
                          className="wb-plan-add"
                          value=""
                          title="合并到…（把本文件夹的成员挂到目标文件夹，然后删除本文件夹）"
                          onChange={(e) => { const target = e.target.value; if (target !== '') void mergeFolderInto(selectedCluster.id, target) }}
                        >
                          <option value="">合并到…</option>
                          {ideaClusters.filter((cluster) => cluster.id !== selectedCluster.id).map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.title}</option>)}
                        </select>
                      )}
                      <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `cluster:${selectedCluster.id}`)}>AI 头脑风暴</button>
                      <button className="wb-btn" onClick={() => void deleteFolder(selectedCluster.id)}><Icon name="trash" />删除</button>
                    </div>
                    <MarkdownText text={selectedCluster.summaryMd || '（暂无总结，可在重命名里补充）'} />
                    <div style={{ marginTop: 10 }}>
                      <b>包含点子（{selectedCluster.ideas.length}）</b>
                      {selectedCluster.ideas.map((idea) => (
                        <div key={idea.id} className="wb-member">
                          <span className="t" onClick={() => { setSelectedCluster(null); setSelectedIdea(idea) }} style={{ cursor: 'pointer' }}>{idea.title}</span>
                          <Badge dict={dictOf('idea_kind')} code={idea.kindCode} />
                          <button className="wb-icon-btn" title="移出文件夹" onClick={() => void unfileIdeaFrom(idea.id, selectedCluster.id)}><Icon name="back" size={12} /></button>
                        </div>
                      ))}
                      {selectedCluster.ideas.length === 0 && (
                        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '8px 2px' }}>空文件夹。可以从下方「未归类」的点子上点「归入文件夹」。</div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                      <button className="wb-btn" disabled={busy} onClick={() => void startAISession('idea_association', null, selectedCluster.ideas.map((idea) => idea.id).sort().join(','))}>AI 继续补充关联</button>
                      <button className="wb-btn" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `cluster:${selectedCluster.id}`)}>整体转成任务树</button>
                    </div>
                  </div>
                )
                : selectedIdea !== null
                  ? (
                    <div className="wb-card">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <h4 style={{ flex: 1, margin: 0 }}>{selectedIdea.title}</h4>
                        <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `idea:${selectedIdea.id}`)}>AI 头脑风暴</button>
                        <button className="wb-btn" onClick={() => { setIdeaEditId(selectedIdea.id); setIdeaForm({ title: selectedIdea.title, contentMd: selectedIdea.contentMd, kindCode: selectedIdea.kindCode, tags: selectedIdea.tags.join(', ') }) }}><Icon name="edit" />编辑</button>
                        <button className="wb-btn" onClick={() => { if (window.confirm('删除这个点子？')) { void api(`/api/workbench/ideas/${selectedIdea.id}`, { method: 'DELETE' }).then(() => { setSelectedIdea(null); setIdeaRefreshKey((v) => v + 1); setNotice('已删除') }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))) } }}><Icon name="trash" />删除</button>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
                        <Badge dict={dictOf('idea_kind')} code={selectedIdea.kindCode} />
                        {selectedIdea.tags.map((tag) => <span key={tag} style={{ fontSize: 12, color: '#999' }}>#{tag}</span>)}
                      </div>
                      <MarkdownText text={selectedIdea.contentMd || '（暂无内容）'} />
                    </div>
                  )
                  : <div className="wb-empty">← 从左侧选择一个点子/点子王，或点“记个点子”</div>
            : view === 'knowledge'
            ? knowledgeDraft !== null
              ? (
                <form className="wb-form" onSubmit={(e) => {
                  e.preventDefault()
                  if (knowledgeDraft.title.trim() === '') return
                  const tags = knowledgeDraft.tags.split(/[,#，\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 20)
                  const isEdit = knowledgeEditId !== null
                  const payload = { title: knowledgeDraft.title.trim(), contentMd: knowledgeDraft.contentMd, kindCode: knowledgeDraft.kindCode, tags, sourceTaskId: knowledgeDraft.sourceTaskId.trim() === '' ? null : knowledgeDraft.sourceTaskId.trim(), sourceReviewId: knowledgeDraft.sourceReviewId.trim() === '' ? null : knowledgeDraft.sourceReviewId.trim(), fileLink: knowledgeDraft.fileLink.trim() === '' ? null : knowledgeDraft.fileLink.trim() }
                  void api(isEdit ? `/api/workbench/knowledge/${knowledgeEditId}` : '/api/workbench/knowledge', { method: isEdit ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
                    .then(() => { setKnowledgeDraft(null); setKnowledgeEditId(null); setKnowledgeRefreshKey((v) => v + 1); setNotice(isEdit ? '知识条目已更新' : '知识条目已创建') })
                    .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                }}>
                  <h4 className="full" style={{ margin: 0 }}>{knowledgeEditId === null ? '新建知识条目' : '编辑知识条目'}</h4>
                  <label className="full">标题<input value={knowledgeDraft.title} onChange={(e) => setKnowledgeDraft((prev) => prev === null ? prev : { ...prev, title: e.target.value })} placeholder="可检索的标题" /></label>
                  <label>分类<select value={knowledgeDraft.kindCode} onChange={(e) => setKnowledgeDraft((prev) => prev === null ? prev : { ...prev, kindCode: e.target.value })}>{dictOf('knowledge_kind').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                  <label>标签<input value={knowledgeDraft.tags} onChange={(e) => setKnowledgeDraft((prev) => prev === null ? prev : { ...prev, tags: e.target.value })} placeholder="用逗号/空格分隔，如 TTS, 踩坑" /></label>
                  <label className="full">本地文件链接（可选）<input value={knowledgeDraft.fileLink} onChange={(e) => setKnowledgeDraft((prev) => prev === null ? prev : { ...prev, fileLink: e.target.value })} placeholder="file:// 或绝对路径，如 D:\docs\方案.md、/mnt/d/docs/方案.md" /></label>
                  <label className="full">关联任务 id（可选）<input value={knowledgeDraft.sourceTaskId} onChange={(e) => setKnowledgeDraft((prev) => prev === null ? prev : { ...prev, sourceTaskId: e.target.value })} placeholder="留空表示不关联" /></label>
                  <label className="full">正文（Markdown）<textarea rows={12} value={knowledgeDraft.contentMd} onChange={(e) => setKnowledgeDraft((prev) => prev === null ? prev : { ...prev, contentMd: e.target.value })} /></label>
                  <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit"><Icon name="check" />保存</button><button className="wb-btn" type="button" onClick={() => { setKnowledgeDraft(null); setKnowledgeEditId(null) }}>取消</button></div>
                </form>
              )
              : selectedKnowledge !== null
                ? (
                  <div className="wb-card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <h4 style={{ flex: 1, margin: 0 }}>{selectedKnowledge.title}</h4>
                      <button className="wb-btn" onClick={() => { setKnowledgeEditId(selectedKnowledge.id); setKnowledgeDraft({ title: selectedKnowledge.title, contentMd: selectedKnowledge.contentMd, kindCode: selectedKnowledge.kindCode, tags: selectedKnowledge.tags.join(', '), sourceTaskId: selectedKnowledge.sourceTaskId ?? '', sourceReviewId: selectedKnowledge.sourceReviewId ?? '', fileLink: selectedKnowledge.fileLink ?? '' }) }}><Icon name="edit" />编辑</button>
                      <button className="wb-btn" onClick={() => { if (window.confirm('删除这条知识？')) { void api(`/api/workbench/knowledge/${selectedKnowledge.id}`, { method: 'DELETE' }).then(() => { setSelectedKnowledge(null); setKnowledgeRefreshKey((v) => v + 1); setNotice('已删除') }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))) } }}><Icon name="trash" />删除</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
                      <Badge dict={dictOf('knowledge_kind')} code={selectedKnowledge.kindCode} />
                      {selectedKnowledge.tags.map((tag) => <span key={tag} style={{ fontSize: 12, color: '#999' }}>#{tag}</span>)}
                    </div>
                    {selectedKnowledge.fileLink !== null && selectedKnowledge.fileLink !== '' && (
                      <div style={{ margin: '8px 0', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span>📎 本地文件：</span>
                        <span className="wb-file-chip"><Icon name="file" size={12} /><code>{selectedKnowledge.fileLink}</code></span>
                        <button className="wb-btn" onClick={() => { void openKnowledgeFile(selectedKnowledge.fileLink!) }}><Icon name="file" />打开文件</button>
                      </div>
                    )}
                    {selectedKnowledge.sourceTaskId !== null && (
                      <div style={{ margin: '8px 0', fontSize: 13 }}>
                        🔗 关联任务：
                        <button className="wb-btn" onClick={() => openTaskById(selectedKnowledge.sourceTaskId!)}>
                          {tasks.find((t) => t.id === selectedKnowledge.sourceTaskId)?.title ?? selectedKnowledge.sourceTaskId}
                        </button>
                      </div>
                    )}
                    <MarkdownText text={selectedKnowledge.contentMd} />
                  </div>
                )
                : <div className="wb-empty">← 从左侧选择或新建知识条目</div>
            : selected === null
            ? <div className="wb-empty">← 从左侧选择一个任务查看详情<br /><span style={{ fontSize: 12 }}>AI 澄清/咨询/拆解会跳转到官方会话区，完成后回这里确认草稿</span></div>
            : (
              <>
                <div className="wb-card">
                  {(
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <h4 style={{ flex: 1, margin: 0 }}>{selected.task.title}</h4>
                        {!selected.task.archived && <button className="wb-btn" onClick={() => setEditDraft({ title: selected.task.title, description: selected.task.description, typeCode: selected.task.typeCode, priorityCode: selected.task.priorityCode, statusCode: selected.task.statusCode, aiPolicyCode: selected.task.aiPolicyCode, dueLocal: toLocalInput(selected.task.dueAt), workspacePath: selected.task.workspacePath ?? '', recurrenceCode: selected.task.recurrenceCode ?? 'none', parentId: selected.task.parentId ?? '' })}><Icon name="edit" />编辑</button>}
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
                      <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>AI 工作区：{selected.task.effectiveWorkspacePath ?? (settings.defaultWorkspace || '默认工作区未设置')}{selected.task.workspacePath === null && selected.task.effectiveWorkspacePath !== null ? '（继承父任务）' : ''}</div>
                      <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>
                        重复：{dicts.find((d) => d.kind === 'recurrence' && d.code === (selected.task.recurrenceCode ?? 'none'))?.name ?? '不重复'}
                        {selected.task.recurrenceMasterId !== null ? '（自动生成的实例）' : selected.task.recurrenceCode !== null && selected.task.recurrenceCode !== 'none' ? `（模板，已生成到 ${selected.task.recurrenceLastGenerated ?? '—'}）` : ''}
                      </div>
                    </>
                  )}
                </div>

                {editDraft === null && (
                  <>
                    <div className="wb-detail-actions">
                      {selected.task.archived ? (
                        <button className="wb-btn primary" onClick={() => { void api(`/api/workbench/tasks/${selected.task.id}/restore`, { method: 'POST' }).then(() => { setNotice('任务已恢复'); setArchivedMode(false); void refresh() }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) }}><Icon name="refresh" />恢复任务</button>
                      ) : (
                        <>
                          {selected.task.recurrenceMasterId !== null
                            ? <span style={{ fontSize: 12, color: '#999', alignSelf: 'center' }}>这是重复任务自动生成的实例，可直接执行/验收。</span>
                            : selected.task.recurrenceCode !== null && selected.task.recurrenceCode !== 'none'
                              ? <span style={{ fontSize: 12, color: '#999', alignSelf: 'center' }}>重复任务模板：实例会自动生成到“子任务”中，归档模板即停止重复。</span>
                              : selected.task.statusCode === 'done' || selected.task.statusCode === 'cancelled'
                                ? <button className="wb-btn" disabled={busy} onClick={() => {
                                    const existing = selected.sessions.find((x) => x.role_code === 'review')
                                    if (existing !== undefined && typeof existing.session_id === 'string' && existing.session_id !== '') {
                                      safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')?.open(existing.session_id)
                                      closePanel()
                                    } else {
                                      void startAISession('review', selected.task, selected.task.title)
                                    }
                                  }}><Icon name="report" />{selected.sessions.some((x) => x.role_code === 'review') ? '进入复盘会话' : 'AI 复盘'}</button>
                                : <>
                                    <button className="wb-btn primary" disabled={busy || selected.task.aiPolicyCode !== 'execute'} title={selected.task.aiPolicyCode !== 'execute' ? '请先开启“可执行”' : selected.children.length > 0 ? '执行父任务：验收通过后未完成子任务会级联完成' : selected.sessions.some((x) => x.role_code === 'execute') ? '新建执行会话并携带此前会话提示' : '开始执行'} onClick={() => void startAISession('execute', selected.task, selected.task.title, selected.sessions.filter((x) => x.role_code === 'execute'))}><Icon name="ai" />AI 执行{selected.children.length > 0 ? '（父任务）' : ''}{selected.sessions.some((x) => x.role_code === 'execute') ? '（新会话续作）' : ''}{selected.task.aiPolicyCode !== 'execute' ? '（需可执行）' : ''}</button>
                                    <button className="wb-btn" disabled={busy} onClick={() => void startAISession('consult', selected.task, selected.task.title)}><Icon name="ai" />AI 协助</button>
                                    <button className="wb-btn" disabled={busy} onClick={() => void startAISession('breakdown', selected.task, selected.task.title)}><Icon name="breakdown" />AI 拆解</button>
                                    <button className="wb-btn" onClick={() => { setSubtaskParent(selected.task); setDetailTab('children') }}><Icon name="subtask" />子任务</button>
                                  </>}
                          <button className="wb-btn" onClick={() => { if (window.confirm('归档后任务会从工作台列表隐藏（其子任务也会一并从列表隐藏），可在列表页“查看归档”中恢复。确认归档？')) { const id = selected.task.id; setTasks((list) => list.filter((t) => t.id !== id)); void api(`/api/workbench/tasks/${id}/archive`, { method: 'POST' }).then(() => { setSelected(null); selectedRef.current = null; setNotice('任务已归档，可在列表页“查看归档”恢复。'); void refresh() }).catch((e: unknown) => { const msg = e instanceof Error ? e.message : String(e); if (msg.includes('not found')) { setSelected(null); selectedRef.current = null; void refresh(); setNotice('该任务已不存在，已从当前视图移除') } setError(msg) }) } }}><Icon name="archive" />归档</button>
                        </>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: '#999', margin: '-4px 2px 10px' }}>
                      {selected.task.aiPolicyCode === 'execute' && selected.task.statusCode !== 'done' && selected.task.statusCode !== 'cancelled'
                        ? selected.children.length > 0
                          ? '执行父任务：验收通过后未完成子任务会级联完成；所有子节点完成后父节点也会自动完成。'
                          : '执行会话完成后，AI 会提交验收申请，由你验收后标记完成。'
                        : ''}
                    </div>

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
                            const form = new FormData(e.currentTarget)
                            const title = String(form.get('title') ?? '').trim()
                            if (title === '') return
                            const due = String(form.get('due') ?? '')
                            void api('/api/workbench/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, typeCode: String(form.get('type') ?? subtaskParent.typeCode), priorityCode: String(form.get('priority') ?? subtaskParent.priorityCode), statusCode: 'todo', parentId: subtaskParent.id, dueAt: due === '' ? null : new Date(due).toISOString() }) }).then(() => { setSubtaskParent(null); setNotice('子任务已创建'); void refresh() }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                          }}>
                            <h4 className="full" style={{ margin: 0 }}><Icon name="subtask" />新建子任务（父任务：{subtaskParent.title}）</h4>
                            <label className="full">标题<input name="title" required placeholder="子任务标题" /></label>
                            <label>类型<select name="type" defaultValue={subtaskParent.typeCode}>{dictOf('type').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                            <label>优先级<select name="priority" defaultValue={subtaskParent.priorityCode}>{dictOf('priority').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                            <label>截止时间<input name="due" type="datetime-local" /></label>
                            <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit">保存子任务</button><button className="wb-btn" type="button" onClick={() => setSubtaskParent(null)}>取消</button></div>
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
                        <h4>关联会话（{selected.sessions.length}）<span style={{ flex: 1 }} />{!sessionPickerOpen && <button className="wb-btn" onClick={() => { setSessionPickerQuery(''); setSessionPickerOpen(true) }}><Icon name="plus" />添加已有对话</button>}</h4>
                        {selected.sessions.length > 0
                          ? (
                              <div className="wb-session-list">
                                {selected.sessions.map((s) => {
                                  const sid = typeof s.session_id === 'string' ? s.session_id : ''
                                  const role = String(s.role_code ?? '')
                                  const sessionInfo = sessionListSnapshot.byId[sid]
                                  const name = sessionInfo?.displayTitle ?? shortId(sid)
                                  return (
                                    <button key={`${sid}-${role}`} className="wb-session-row" onClick={() => { if (sid !== '') { safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')?.open(sid); closePanel() } }} title={roleLabel(role)}>
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
                              <button className="wb-btn" onClick={() => { setSessionPickerOpen(false); setSessionPickerQuery('') }}>取消</button>
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
                                  ? <button className="wb-btn" style={{ marginTop: 6 }} onClick={() => { setKnowledgeDraft(null); setKnowledgeEditId(null); setSelectedKnowledge(existingKnowledge); setView('knowledge') }}><Icon name="book" />✅ 已沉淀，打开知识条目</button>
                                  : <button className="wb-btn" style={{ marginTop: 6 }} onClick={() => { setKnowledgeEditId(null); setKnowledgeDraft({ title: `复盘：${selected.task.title}`, contentMd: String(rv.summary_md ?? ''), kindCode: 'lesson', tags: '复盘', sourceTaskId: selected.task.id, sourceReviewId: reviewId, fileLink: '' }); setSelectedKnowledge(null); setView('knowledge') }}><Icon name="book" />💡 沉淀为经验</button>}
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
            )}
        </div>
      </div>
      {showQuick && (
        <Modal
          title={<><Icon name="sparkles" />快速录入</>}
          size="md"
          onClose={() => setShowQuick(false)}
          footer={(
            <>
              <span className="wb-foot-note">会跳转到官方会话区，由 AI 澄清后生成任务草稿</span>
              <button className="wb-btn" onClick={() => setShowQuick(false)}>取消</button>
              <button
                className="wb-btn primary"
                disabled={busy || quickText.trim() === ''}
                onClick={() => {
                  // 工作区选择随会话一起带下去：勾了"按标题建子文件夹"就在所选目录下拼一层，
                  // 否则逐字使用所选目录（用户选的是"就在这个目录里做"）。
                  const isWsl = detectWslHost(runtime)
                  const chosen = quickWorkspace.trim()
                  const effective = chosen !== '' && quickFollowFolder
                    ? joinPath(chosen, folderForText(quickText || '需求澄清'), isWsl ? '/' : '\\')
                    : chosen
                  if (chosen !== '') void rememberQuickWorkspace(chosen)
                  void startAISession('clarify', null, quickText, [], undefined, effective)
                }}
              >
                创建澄清会话
              </button>
            </>
          )}
        >
          <label className="wb-field">
            <span>一句话描述任务</span>
            <textarea
              autoFocus
              rows={3}
              value={quickText}
              onChange={(e) => setQuickText(e.target.value)}
              placeholder="例如：周五 10:30 接待重要客户"
            />
          </label>

          {/* ---------------- 工作区选择（v1.14.0） ----------------
              说明文字一律用 <div className="wb-hint"> 而不是 <p>/<label>：
              `.wb-hint` 自带 margin，而 `.wb-field` 的标签是 display:block、
              里面的 <input> 是行内元素 —— 把提示塞进 <label> 会被输入框的基线顶开重叠
              （2026-09-12 用户实测："提示文字被上方输入框遮挡"）。 */}
          <div className="wb-field">
            <span>
              AI 会话工作区
              <span className="wb-field-note">
                {quickWorkspaceTouched
                  ? '手动指定'
                  : selected !== null && (selected.task.effectiveWorkspacePath ?? '') !== ''
                    ? `继承自父任务「${selected.task.title}」`
                    : quickWorkspace === ''
                      ? '未设置（DSH 当前工作区）'
                      : '使用默认工作区'}
              </span>
            </span>
            <input
              name="quick-workspace"
              list="wb-quick-workspace-options"
              value={quickWorkspace}
              placeholder={settings.defaultWorkspace || '例如 D:\\Code\\my-project 或 /mnt/d/code/my-project'}
              onChange={(e) => { setQuickWorkspaceTouched(true); setQuickWorkspace(e.target.value) }}
            />
            <datalist id="wb-quick-workspace-options">
              {[...new Set([
                ...(settings.quickWorkspaceRecent ?? []),
                ...openWorkspacePaths(runtime),
                settings.defaultWorkspace,
              ].filter((path) => path !== ''))].map((path) => <option key={path} value={path} />)}
            </datalist>
          </div>
          {quickWorkspace.trim() !== '' && (
            <label className="wb-inline-check">
              <input
                type="checkbox"
                checked={quickFollowFolder}
                onChange={(e) => setQuickFollowFolder(e.target.checked)}
              />
              <span>在该工作区下按标题建子文件夹（不勾 = 直接用它本身）</span>
            </label>
          )}
          <div className="wb-hint">
            留空则沿用既有规则（跟随父任务 → 否则默认工作区）；路径不存在时会<b>明确报错</b>，不会静默换目录。
          </div>
          <div className="wb-hint">AI 会先澄清必要信息（一次一个主题，最多 5 轮），再提交任务草稿由你确认。</div>
        </Modal>
      )}

      {showForm && (
        <Modal
          title={<><Icon name="plus" />新建任务</>}
          size="md"
          onClose={() => setShowForm(false)}
        >
          <form className="wb-form" id="wb-new-task-form" onSubmit={(e) => void createTask(e)}>
            <label className="full">标题<input name="title" required placeholder="要做什么？" /></label>
            <label>类型<select name="type" defaultValue="client_meeting">{dictOf('type').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
            <label>优先级<select name="priority" defaultValue="p2">{dictOf('priority').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
            <label>状态<select name="status" defaultValue="todo">{dictOf('status').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
            <label>截止时间<input name="due" type="datetime-local" /></label>
            <label>重复<select name="recurrence" defaultValue="none">{dictOf('recurrence').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
            <label className="full">AI 会话工作区（可选，留空用默认）<input name="workspacePath" placeholder={settings.defaultWorkspace || '默认工作区未设置'} /></label>
            <label className="full">描述<textarea name="description" rows={2} placeholder="背景 / 目标 / 验收标准（Markdown）" /></label>
            <div className="full" style={{ display: 'flex', gap: 8 }}>
              <button className="wb-btn primary lg" type="submit"><Icon name="check" />保存任务</button>
              <button className="wb-btn" type="button" onClick={() => setShowForm(false)}>取消</button>
            </div>
          </form>
        </Modal>
      )}

      {editDraft !== null && selected !== null && (
        <Modal
          title={<><Icon name="edit" />编辑任务</>}
          size="md"
          onClose={() => setEditDraft(null)}
          footer={(
            <>
              <button className="wb-btn" onClick={() => setEditDraft(null)}>取消</button>
              <button className="wb-btn primary" disabled={editDraft.title.trim() === ''} onClick={() => void saveEditDraft()}>
                <Icon name="check" />保存
              </button>
            </>
          )}
        >
          <div className="wb-form" style={{ border: 'none', padding: 0 }}>
            <label className="full">标题<input value={editDraft.title} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, title: e.target.value })} /></label>
            <label>类型<select value={editDraft.typeCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, typeCode: e.target.value })}>{dictOf('type').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
            <label>优先级<select value={editDraft.priorityCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, priorityCode: e.target.value })}>{dictOf('priority').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
            <label>状态<select value={editDraft.statusCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, statusCode: e.target.value })}>{dictOf('status').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
            <label>AI 策略<select value={editDraft.aiPolicyCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, aiPolicyCode: e.target.value })}>{dictOf('ai_policy').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
            {selected.task.recurrenceMasterId === null
              ? <label>重复<select value={editDraft.recurrenceCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, recurrenceCode: e.target.value })}>{dictOf('recurrence').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
              : <div style={{ fontSize: 12, color: '#999', alignSelf: 'center' }}>重复：由模板任务管理</div>}
            <label>截止时间<input type="datetime-local" value={editDraft.dueLocal} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, dueLocal: e.target.value })} /></label>
            <label className="full">AI 会话工作区（留空则继承父任务，父任务也没有才用默认）<input value={editDraft.workspacePath} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, workspacePath: e.target.value })} placeholder={settings.defaultWorkspace || '默认工作区未设置'} /></label>
            <label className="full">描述（Markdown）<textarea rows={6} value={editDraft.description} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, description: e.target.value })} /></label>
            {/* ---------------- 改父任务（v1.14.0） ---------------- */}
            <label className="full">
              父任务
              <select
                value={editDraft.parentId}
                onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, parentId: e.target.value })}
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
      )}
      {pendingOpen && (
        <Modal
          title={<>待你处理（{pendingCount}）</>}
          size="sm"
          onClose={() => setPendingOpen(false)}
          footer={<button className="wb-btn" onClick={() => setPendingOpen(false)}>关闭</button>}
        >
          <div className="wb-scroll-area">
            {/**
              * 待确认草稿一律**按服务端清单**列出（含"关掉横幅先收起"的）：
              * 用户收起横幅只是"别挡着我"，不代表决定过了 —— 必须还能从这里找到。
              */}
            {allPendingDrafts.filter((d) => d.deferredAt === null).map((draft) => (
              <div key={draft.id} className="wb-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <span style={{ flex: 1 }}>
                  <b>待确认的{draftKindLabel(draft.kindCode)}</b>
                  <span className="wb-switch-desc">AI 已提交，确认后才会写入工作台。</span>
                </span>
                <button className="wb-btn" onClick={() => void resumePendingDraft(draft)}>打开弹框</button>
              </div>
            ))}
            {deferredDrafts.length > 0 && (
              <div style={{ marginTop: pendingDraft === null ? 0 : 10 }}>
                <div className="wb-hint" style={{ marginBottom: 4 }}>已暂存（{deferredDrafts.length}）· 做完手上的事再从这里唤回</div>
                {deferredDrafts.map((draft) => (
                  <div key={draft.id} className="wb-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                    <span style={{ flex: 1 }}>
                      <b>{draftKindLabel(draft.kindCode)}</b>
                      <span className="wb-switch-desc">
                        暂存于 {fmtTime(draft.deferredAt ?? draft.updatedAt)}
                        {draft.deferCount > 1 ? ` · 第 ${draft.deferCount} 次` : ''}
                      </span>
                    </span>
                    <button className="wb-btn primary" onClick={() => void resumeDeferredDraft(draft.id)}>唤回处理</button>
                  </div>
                ))}
              </div>
            )}
            {reminders.map((r) => (
              <div key={r.reminderId} className="wb-row" style={{ cursor: 'default' }}>
                <span style={{ flex: 1 }}>{r.title} · {fmtTime(r.dueAt)}</span>
                <button className="wb-btn" onClick={() => void ackReminder(r.reminderId)}>知道了</button>
              </div>
            ))}
            {pendingCount === 0 && <p className="wb-hint">暂无待处理事项。</p>}
          </div>
        </Modal>
      )}
      <ToastHost items={toasts} onDismiss={dismissToast} />
    </div>
  )
}

function ensureStyle(): void {
  if (document.querySelector('style[data-dsh-personal-workbench-style]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshPersonalWorkbenchStyle = ''
  style.textContent = CSS
  document.head.appendChild(style)
}
/**
 * v1.14.53：原先这里还有 `sidebarRoot()` / `newSessionButton()` / `conversationColumn()`
 * 三个"找宿主 DOM 挂点"的辅助函数（给 DOM 降级腿用）。DOM 腿已删除，
 * 侧栏入口与面板容器**全部交给官方槽位**渲染，因此不再需要任何宿主 class 名选择器
 * —— 这也正是"DSH 升级就可能失效"的那一类脆弱依赖。
 */


export const name = 'personal-workbench-client'
/**
 * 声明的服务。
 *
 * ⚠️ **`slots` / `layout` 必须在这里声明**（v1.14.39 定案，2026-09-13）。
 *
 * 踩了很久的坑：原先只声明 `sessions` / `workspaces` / `connection`，
 * 然后想用 `ctx.get('slots')` / `ctx.get('layout')` **软探测**这两个服务。
 * 结果 **`ctx.get('layout')` 永远返回 undefined** —— cordis 不允许访问未声明 inject
 * 的服务（这正是团队记忆里那条"完全不声明 inject 直接调 ctx.interval 会抛
 * cannot get property ... without inject"的同一机制）。
 *
 * 连锁后果（每一条都实测过）：
 *   - 探不到 `layout` → 判定"宿主不支持官方槽位" → 静默降级到自建 DOM 腿；
 *   - 降级后的那条腿会铺一张 `position:fixed; inset:0; z-index:55` 的**满屏层**，
 *     一旦收不起来就永久盖住会话区（用户："除左栏外什么都点不了"）；
 *   - 同时宿主渲染我们的槽位条目时崩
 *     `TypeError: Cannot read properties of undefined (reading 'subscribe')`
 *     （`slot entry crashed in 'conversation.session.header.actions'` / `'shell.overlay'`）。
 *
 * **对照证据**：同机的 `dsh-pocket` 用的是
 * `var inject = ["slots", "connection", "layout", "locale", "sessionLogDownload"]` ——
 * 它**把这两个服务声明进了 inject**，所以能直接 `ctx.slots.inject(...)` /
 * `ctx.layout.toggleSidebar()`，从未出现上述问题。
 * （`dsh-client-ui-task-board` 则完全不碰官方槽位，改用"DOM 接管 centerCol +
 * `<html>` 上的 data 属性切换"，其源码注释明确写着 external plugins cannot declare slots。）
 *
 * 兼容性：这两个服务是 DSH 0.1.5-rc.1 起才有的。若需要支持更老的宿主，
 * 正确做法是 **`ctx.inject(['slots', 'layout'], cb)` 把依赖限定在子 fiber**
 * （缺一个只让这块不启动、插件主体照常加载），而不是"不声明 + 软探测"。
 * 本项目 reminder 调度对 `timer` 就是这么做的（见 src/index.ts 的 `ctx.inject(['timer'], …)`）。
 *
 * ⚠️ **唯一实现在 `capabilities.ts`**（v1.14.52，设计文档 I3）：这里只转出去，
 * 供 `test/capabilities.test.mjs` 断言"精确等于 5 项"。原地再写一份字面量
 * 就是"同一个语义两处实现"——一旦有人只改一边，插件会在半残状态下启动。
 */
export { inject } from './capabilities.js'

/**
 * 宿主上下文（由 apply() 记录），供需要软探测可选服务的模块级函数使用
 * （例如 connectWorkspace 要试 uiWorkspace）。卸载时清空，避免持有已废弃的 fiber。
 */
let pluginCtx: unknown

/**
 * 上一轮 `apply()` 的清理函数（单实例守卫用）。
 *
 * 为什么必须是模块级的：cordis 重载插件时会重新执行 `apply()`，而 `apply()` 内部的
 * 局部变量拿不到上一轮的引用。把清理函数存在模块作用域，新的 `apply()` 才能
 * 主动拆掉上一轮 —— 否则旧实例会继续轮询、继续弹 Modal，用户看到的就是
 * "背景一次比一次黑 + 按钮点不动"（2026-09-12 事故）。
 */
let activeDisposer: (() => void) | undefined

/** 主动拆掉上一轮实例（幂等；没有任何残留时是 no-op）。 */
function disposePreviousInstance(): void {
  const disposer = activeDisposer
  if (disposer === undefined) return
  activeDisposer = undefined
  try { disposer() } catch (error) {
    console.warn('[workbench] 上一轮实例清理失败（继续挂载新实例）：', String(error))
  }
}

/** 软探测可选服务（cordis 代理访问未声明服务会抛错，必须用 ctx.get）。 */
function optionalService<T>(ctx: unknown, name: string): T | undefined {
  const getter = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  if (typeof getter !== 'function') return undefined
  try {
    return getter(name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 安全读取**必需**服务（v1.14.2）。
 *
 * 为什么连必需服务也要包一层：cordis 在 fiber 已销毁后访问服务会抛
 * `cannot get required service "sessions" in inactive context`
 * （2026-09-12 用户控制台实测，19 条 error 里绝大多数是这一条）。
 *
 * 成因是**已经卸载的实例仍在跑异步回调**（例如上一个实例的轮询 tick 或
 * 会话跳转）：那些回调里的 `runtime.sessions` 访问发生在上下文失效之后，
 * cordis 抛错 → React 事件处理器里没人接 → `Uncaught (in promise)`。
 *
 * 处理原则：拿不到就当 `undefined`，让调用点自己决定降级 ——
 * **绝不让"旧实例的残留回调"把错误抛到用户控制台上**。
 */
function safeService<T>(runtime: unknown, name: string): T | undefined {
  const target = runtime as Record<string, unknown> | undefined
  if (target === undefined || target === null) return undefined
  try {
    return target[name] as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 当前是否还有**活着的**插件实例。
 *
 * `apply()` 里置真、清理函数里置假。所有异步回调（轮询 tick、await 之后）
 * 都要先看它一眼：卸载之后继续跑副作用会把已卸载的 React root 又更新一遍，
 * 出现"关掉又回来 / 多层遮罩"这类幽灵行为。
 */
let instanceAlive = false

/**
 * 宿主面板选中态的**模块级镜像**（v1.14.45）。
 *
 * 为什么必须有它：宿主把 panelInfo store 挂在 **root 槽位的全局 hook props**
 * （`usePanelInfo`）上，`ctx.layout` 自己没有订阅接口 —— 也就是说只有当某个槽位
 * 组件渲染时，我们才可能读到 `activePanelId`。`WorkbenchPanelContent` 每次渲染都会
 * 把读数写进这两个变量，于是标题栏按钮（同样注册在槽位上）+ CSS 标记 + 互斥判定
 * 全都共享同一个事实，不会出现"三套判据各说各话"。
 *
 * `undefined` 有明确含义：**宿主从未给过这个 hook**（旧宿主）→ 退回本地标志。
 */
let hostPanelId: string | null | undefined
/** 宿主是否提供了 `usePanelInfo`（只要给过就置真，之后不再回退）。 */
let panelInfoHookSeen = false

/**
 * 从运行时快照判断 DSH 跑在 WSL 还是原生 Windows（用于路径形态选择）。
 *
 * ## ⚠️ 这里曾经让低版本宿主上的「快速录入」整个失效（v1.14.50 修复）
 *
 * 原写法是 `safeService(…, 'connection')?.generation.getSnapshot()?.host.home`。
 * `?.` 只保护了**外层调用**，`generation` 本身仍是直接属性访问 ——
 * 而低版本 DSH（0.1.1-rc.1）的 `connection` 服务**没有 `generation`**，
 * 于是抛 `TypeError: Cannot read properties of undefined (reading 'getSnapshot')`。
 *
 * 后果链（实测）：`openQuickEntry` 第一行就调本函数 → 抛错 →
 * `setShowQuick(true)` 永远执行不到 → **点「快速录入」没有任何反应**（弹窗不出现）。
 * 用户现象就是"WSL 上快速录入用不了"。
 *
 * 修法：**每一层都用 `?.`**（`generation?.getSnapshot?.()`），并且整体包 try/catch ——
 * 这只是一个"猜宿主平台"的启发式判断，**任何情况下都不该把调用方炸掉**。
 *
 * 同类隐患的通用规矩：链式可选访问只有**每个可能为空的环节都加 `?.`** 才安全；
 * `a?.b.c` 在 `a.b === undefined` 时照样抛错。
 */
function detectWslHost(runtime: WorkbenchRuntime): boolean {
  try {
    const connection = safeService<WorkbenchRuntime['connection']>(runtime, 'connection')
    /** 低版本没有 `generation`；旧版本的快照接口 `getSnapshot` 也可能缺 —— 两层都防。 */
    const hostHome = connection?.generation?.getSnapshot?.()?.host?.home
    if (typeof hostHome === 'string' && hostHome !== '') return isWslStylePath(hostHome)
    const items = safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.list?.getSnapshot?.()?.items ?? []
    return items.some((item) => typeof item.path === 'string' && isWslStylePath(item.path))
  } catch {
    /** 探测失败就当"不是 WSL"（最保守：路径按原样处理，不会因此崩掉交互）。 */
    return false
  }
}

/** 已打开的工作区路径列表（快速录入的工作区候选之一，去重由调用方做）。 */
function openWorkspacePaths(runtime: WorkbenchRuntime): string[] {
  /** 与 `detectWslHost` 同一处加固：每一层都要 `?.`，否则低版本缺 `list` 时会抛。 */
  return (safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.list?.getSnapshot?.()?.items ?? [])
    .map((item) => item.path)
    .filter((path): path is string => typeof path === 'string' && path.trim() !== '')
}

/**
 * 把一个 workspace 变成可用的会话（返回新会话 id）。
 *
 * 优先官方 uiWorkspace.connectWorkspace；老版本 DSH（如 0.1.1-rc.1）没有这个服务，
 * 退到 workspaces.openPath；两者都不可用就抛出能指导用户的错误——**而不是**把
 * uiWorkspace 放进 inject 让整个插件在旧版本上 pending。
 *
 * `ctx` 来自 apply() 记录的宿主上下文；没有它时退回 runtime 能力（workspaces.openPath）。
 * 全程用 `safeService`：这个函数常在插件卸载后仍在执行（await 之后），
 * 直接读服务会抛 "inactive context"。
 */
async function connectWorkspace(workspaceId: string): Promise<string> {
  const ctx = pluginCtx as { get?: (key: string) => unknown } | undefined
  const uiWorkspace = optionalService<{ connectWorkspace?: (id: string) => Promise<string> }>(ctx, 'uiWorkspace')
  if (typeof uiWorkspace?.connectWorkspace === 'function') return await uiWorkspace.connectWorkspace(workspaceId)
  const runtime = pluginCtx as WorkbenchRuntime
  const workspaces = safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')
  const openPath = workspaces?.openPath
  if (typeof openPath === 'function') {
    await openPath.call(workspaces, workspaceId)
    const sessions = safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')
    const snapshot = sessions?.list.getSnapshot()
    if (snapshot === undefined) return ''
    const last = snapshot.ids[snapshot.ids.length - 1]
    if (typeof snapshot.current === 'string' && snapshot.current !== '') return snapshot.current
    if (typeof last === 'string' && last !== '') return last
  }
  throw new Error('当前 DSH 版本没有可用的工作区切换接口（需要 uiWorkspace 或 workspaces.openPath），请先手动切到任务工作区再发起 AI 会话')
}

/**
 * 官方槽位入口：会话标题栏的「工作台」按钮。
 *
 * 为什么用它：原先只有"往 DSH 侧栏插 DOM"一条路（依赖宿主 class 名，升级就可能失效）。
 * 这里改用 DSH 官方槽位 `conversation.session.header.actions`（作用域 = session，
 * 所以每个会话的标题栏都会出现这个按钮），与 dsh-cost-meter / dsh-pocket 的接法一致。
 *
 * 契约：组件通过 `inject` 拿到 { workbench }，含 open / close / toggle / isOpen。
 * 通过 rAF 轮询刷新激活态，避免把 store 接口扩展进 WorkbenchRuntime 类型。
 */
export interface SlotRegistration {
  name: string
  id: string
  order: number
  /** keyed 槽位（如官方 `main`）必须给 key；缺省视为与 id 同值。 */
  key?: string
  /** 宿主面板行显示的文字；支持 locale 字典项，这里直接给中文字符串。 */
  label?: string
  inject?: () => Record<string, unknown>
}
/** 侧栏面板图标（官方 `sidebar.panellist`）的 owner props。 */
export interface PanelIconProps {
  /** 宿主请求的方形边长（折叠态 18、展开态 16）。 */
  size?: number
  /** 该面板是否为当前选中项（宿主 PanelRow 的 activePanelId 比对结果）。 */
  active?: boolean
}
export interface SlotsService {
  register: (options: SlotRegistration, component: (props: Record<string, unknown>) => JSX.Element | null) => () => void
  /**
   * 等某个槽位出现后再注册。回调是**普通函数**，其返回值即 disposer ——
   * 见下方注册处的实测说明（generator 形态在本宿主未生效）。
   */
  inject: (name: string, callback: () => (() => void) | void) => void
}

/**
 * 官方布局服务（DSH 0.1.5-rc.1 起）。
 *
 * 只用 `selectPanel` —— 它是「当前选中的中央面板」，是**宿主单值状态**，
 * 迁移后互斥不再靠各方互相摘属性（社区那套 `data-dsh-*-active` / `dsh-panel-activate`
 * 的土办法在本入口上不再需要）。
 */
export interface LayoutService {
  selectPanel?: (panelId: string | null) => void
}

interface WorkbenchSlotApi {
  open: () => void
  close: () => void
  toggle: () => void
  isOpen: () => boolean
  /**
   * 订阅宿主的「当前选中的中央面板」（`PanelInfo.activePanelId`，官方槽位全局 props）。
   * 官方路径下它才是唯一事实来源：用户从宿主 UI 取消选中面板时，
   * 本插件本地那个 `open` 标志收不到通知，只能靠它纠正（否则标题栏按钮会一直显示"已打开"）。
   */
  subscribe?: (listener: () => void) => () => void
  /** 宿主当前是否选中本插件面板；无订阅能力时返回本地状态。 */
  isHostSelected?: () => boolean
  /**
   * 官方槽位的**全局标准 props**：`usePanelInfo(selector)`（snapshot selector hook）。
   * 由宿主注入，只在官方路径下才有 —— 所以它是可选的。
   *
   * ⚠️ **这是本宿主上唯一能真正读到宿主面板选中态的通道**（2026-09-13 读宿主源码核实）：
   * 宿主的 `ctx.layout` 是 `LayoutController`（只有 `selectPanel` / `toggleSidebar` /
   * `openRightbar` / `closeRightbar` / `beginNavigation` / `dispose`），
   * **没有 `subscribe` / `getSnapshot` / `panelInfo`** —— 那个 store 被挂成
   * *root 槽位 hook*（`ui-layout` 的 `ctx.slots.provideRoot({ hooks: { panelInfo } })`），
   * 只能由槽位组件通过这份全局 props 读到。
   */
  usePanelInfo?: (selector: (info: { activePanelId: string | null }) => unknown) => unknown
}

/** 槽位组件的 props 由 `register(..., { inject })` 注入，与 dsh-cost-meter 的写法一致。 */
function WorkbenchHeaderEntry({ workbench }: { workbench: WorkbenchSlotApi }): JSX.Element {
  const [, setTick] = useState(0)
  /**
   * 官方全局 props 的 `usePanelInfo(selector)`：**必须在组件顶层无条件调用**（hooks 规则）。
   * 旧宿主没有这个 props → `undefined` → 整条订阅退化成"以本地标志为准"（与迁移前一致）。
   *
   * 关于"条件调用 hooks"：这里不是条件调用 —— `?.()` 在 props 缺失时确实跳过了它，
   * 但该组件的每个实例渲染期间这个值都恒定（宿主要么给全局 props，要么永远不给），
   * 不存在同一实例内 hooks 数量变化。仅当有的宿主**中途**改变行为才会踩到，届时
   * 表现也只是 React 的 hooks 顺序告警而不是崩溃。
   */
  const hostPanelId = workbench.usePanelInfo?.((info) => info.activePanelId) as string | null | undefined
  useEffect(() => {
    // 订阅激活属性：本按钮与侧栏入口、工作台内「返回对话」保持同步高亮。
    const observer = new MutationObserver(() => setTick((value) => value + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [ACTIVE_ATTR] })
    // 没有全局 props 时才退回通用订阅（两条路都不通就以本地状态为准）。
    const unsubscribe = hostPanelId === undefined ? workbench.subscribe?.(() => setTick((value) => value + 1)) : undefined
    return () => { observer.disconnect(); unsubscribe?.() }
  }, [hostPanelId === undefined])
  /**
   * 本地回落：宿主没给全局 props 时，先问通用订阅句柄，再退到本地开关。
   *
   * 这一段是**取值**（把三条可能的来源收敛成一个布尔），判定本身交给 `decidePanel` ——
   * 与面板容器、`isDisplayed()` 共用同一份判据（设计文档 P1）。
   */
  const localSelected = (hostPanelId === undefined ? workbench.isHostSelected?.() : undefined) ?? workbench.isOpen()
  const active = shouldShowPanel({
    stateReadable: hostPanelId !== undefined,
    hostPanelId: hostPanelId ?? null,
    intentOpen: localSelected,
  })
  return (
    <button
      type="button"
      className="wb-header-entry"
      title={active ? '收起工作台' : '打开工作台（任务 / 日历 / 知识库 / 点子）'}
      aria-pressed={active}
      {...(active ? { 'data-active': '' } : {})}
      onClick={() => workbench.toggle()}
    >
      <Icon name="today" size={14} />
      工作台
    </button>
  )
}

/**
 * 注册给宿主 `sidebar.panellist` 的**稳定组件**（v1.14.5）。
 *
 * 与 `WorkbenchPanelContent` 同样的道理：函数身份一变，宿主重渲染时 React
 * 会卸载重挂整个面板行图标（表现为侧栏那一行闪烁）。
 * 本组件无状态、只读 owner props，所以放在模块作用域零成本。
 */
function WorkbenchPanelEntry(props: Record<string, unknown>): JSX.Element {
  const size = typeof props.size === 'number' ? props.size : 18
  return <WorkbenchPanelIcon size={size} />
}

/**
 * 官方侧栏面板行里的图标（`sidebar.panellist`，kind=list、scope=root）。
 *
 * 行按钮、Tooltip、`aria-label`、`aria-current="page"`、行高与折叠态圆形
 * **全部由宿主 `PanelRow` 渲染** —— 本组件只负责图标本身，这正是不再需要
 * 自己往侧栏 DOM 里注入 `<button>` + 硬编码尺寸的原因。
 */
function WorkbenchPanelIcon({ size }: PanelIconProps): JSX.Element {
  return <Icon name="today" size={size ?? 18} />
}

/**
 * 注册给宿主 `shell.overlay` 的**稳定组件**（v1.14.11 关键修正）。
 *
 * ## 为什么从 `main` 搬到 `shell.overlay`
 *
 * `main` 是**键槽**：`activePanelId` 一变，宿主就卸载旧键的子树、挂载新键的子树。
 * 我们把这个 App（里面除了面板还装着**待确认草稿弹框**）放进 `main` 的后果：
 * 关掉面板 = 整个 App 卸载 = 弹框消失（用户实测"只能回到工作台页面才看得到弹框"），
 * 而且每次开合都重建整棵树，依赖 `useEffect` 拉数据的「今日容量」会在重建窗口里
 * 渲染成空壳。
 *
 * `shell.overlay` 是框架级浮层（list/root，**始终挂载**，契约明说 entries 可自行
 * opt back into pointer events），正好是这种"跨页面常驻"内容的归属地。
 *
 * 面板的显隐不再依赖"宿主渲染哪个键"，而由**是否被选中**（`layout.selectPanel`）决定 ——
 * 见 `WorkbenchPanelContent` 的实现与 CSS 的 `[data-dsh-...-view]` 门控。
 */
let workbenchHost: {
  runtime: WorkbenchRuntime
  isOpen: () => boolean
  closePanel: () => void
  subscribe: (listener: () => void) => () => void
  /**
   * 只在"宿主面板状态不可读"时调用一次：把 App 改挂到自建常驻容器，
   * 使官方满屏层**不承载内容**（否则它会永久盖住界面，2026-09-13 事故）。
   */
  onUnreadableHostState?: () => void
  /**
   * 把「本组件当前观察到的宿主面板选中态」写回模块级状态。
   *
   * 这是**唯一真正可用的宿主状态通道**：宿主的 panelInfo store 挂在 root 槽位的
   * 全局 hook props 上（`usePanelInfo`），`ctx.layout` 自己没有订阅接口。
   * 因此由槽位组件在渲染期间把读到的值回写，供 `slotApi` / 标题栏按钮 / CSS 同步使用。
   * 回写是幂等的纯函数式赋值（同值不触发任何动作），不会引起渲染循环。
   */
  reportHostPanelId?: (panelId: string | null | undefined) => void
  /** 宿主是否给了 `usePanelInfo`（= 宿主面板状态**可读**）。 */
  hasPanelInfoHook?: () => boolean
  /** 宿主面板状态可读时的选中态（不可读返回 undefined）。 */
  hostSelected?: () => boolean | undefined
  /** 兄弟插件是否正开着面板（DOM 契约层判定，官方路径下也要问）。 */
  siblingPanelActive?: () => boolean
  /**
   * 收起兄弟插件的面板标记并广播家族激活事件。
   *
   * 由 `WorkbenchPanelContent` 在「宿主选中了我们」时调用 —— 用于清掉**残留**的
   * 兄弟标记（真实 task-board 只在关闭时才摘自己的标记，所以"被挤掉又点回来"时
   * 它会残留）。做法与 task-board 打开时对 ssh 做的完全一致，属家族既定约定。
   */
  takeOverFamilyPanel?: () => void
  /** 同步 `<html>` 上的激活标记（宿主状态变化后调用，供 CSS 与标题栏按钮读）。 */
  syncActiveAttribute?: (active: boolean) => void
  /** 本地开关的权威状态（不依赖宿主订阅链）。 */
  isLocalOpen?: () => boolean
  /** 本地开关是否处于"被用户强制收起"状态。 */
  isForcedClosed?: () => boolean
  /** 宿主面板状态能否被安全读取（= layout 服务可用）。 */
  stateReadable?: () => boolean
} | undefined

/**
 * 注册给宿主 `shell.overlay` 的面板内容（v1.14.41 恢复官方路径）。
 *
 * ## 关键设计：**开合以宿主 `activePanelId` 为准**（v1.14.45 定案）
 *
 * 上一版按**本地** `open` / `forcedClosed` 两个变量决定显隐，于是宿主自己的入口行
 * 点下去之后：宿主 `activePanelId` 变成 `personal-workbench`（侧栏那一行高亮、
 * 会话内容让位），而我们的 `.wb-panel-host` 拿不到任何通知 → `data-open` 仍是
 * `undefined` → **中央一片空白**（用户截图实测："点了没用"，其实是"没人通知我们"）。
 *
 * 三套判据各说各话的教训（交接文档第 5 节）在这里收敛成一条：
 *
 * ```text
 * 显示 = 没被别人挤掉 && (宿主选中了我们 ?? 本地标志)
 * ```
 *
 * - **宿主状态可读**（拿到了 `usePanelInfo`）→ 唯一事实来源，本地标志不参与判断。
 *   这样"宿主行点开"和"我们自己的行点开"走的是同一条判据，不可能分叉。
 * - **宿主状态不可读**（旧宿主 / 没有该 hook）→ 退回本地标志（迁移前的老行为）。
 *
 * `isForcedClosed` 只在"宿主 state 不可读"时参与 —— 一旦可读，用户的"关"通过
 * `layout.selectPanel(null)` 就能送达宿主，宿主的 `activePanelId` 自己会变成 null，
 * 不需要本地再压一层（压了就会出现"关掉后再点官方行打不开"的另一个 bug）。
 */
function WorkbenchPanelContent(props: Record<string, unknown>): JSX.Element | null {
  const host = workbenchHost
  /**
   * 宿主注入的全局 props。**必须在组件顶层无条件调用**（Hooks 规则）——
   * 这里不是条件调用：`?.()` 只在宿主根本没给这个 props 时跳过，而那种宿主
   * 每个实例渲染期间都恒定不给，同一实例内 hooks 数量不变。
   *
   * 为什么不能省：这是本宿主上**唯一**能拿到 `activePanelId` 的通道
   * （`ctx.layout` 上没有订阅接口，见 `WorkbenchSlotApi.usePanelInfo` 的说明）。
   * 标题栏按钮（`WorkbenchHeaderEntry`）一直是这么读的，本组件只是补上同一条通道。
   */
  const usePanelInfo = props.usePanelInfo as ((selector: (info: { activePanelId: string | null }) => unknown) => unknown) | undefined
  const hostPanelId = usePanelInfo?.((info) => info.activePanelId) as string | null | undefined

  const [, setTick] = useState(0)
  useEffect(() => {
    if (host === undefined) return
    return host.subscribe(() => setTick((value) => value + 1))
  }, [host])
  /**
   * 三个输入都是**取值**（把宿主能力与本地标志读成布尔），判定交给下面的纯函数。
   *
   * - `hostReadable`：宿主是否提供了 `usePanelInfo`（= 面板状态可读，走官方路径）；
   * - `localOpen` / `forcedClosed`：本地开关及其"被用户强制收起"标记，仅作回落。
   */
  const hostReadable = host?.hasPanelInfoHook?.() === true
  const localOpen = host?.isLocalOpen?.() ?? host?.isOpen() ?? false
  const forcedClosed = host?.isForcedClosed?.() ?? false
  const snapshot = { stateReadable: hostReadable, hostPanelId: hostPanelId ?? null, intentOpen: !forcedClosed && localOpen }
  /**
   * 显示与否与 `data-open` 投影都走**同一个** `decidePanel()`（设计文档 P1 + I2）。
   *
   * 改动前这里是内联表达式 `hostReadable ? hostSelected : (!forcedClosed && localOpen)`，
   * 而**同一个语义**在 `isDisplayed()` 里又写了一遍、在 `WorkbenchHeaderEntry` 里写了第三遍 ——
   * 三处读的输入集合不同，bug 2/6/9 都出在这里。
   *
   * `stateReadable` 对应"官方路径是否驱动着显隐"：
   * - 可读 → 只信宿主 `activePanelId`，本地标志**不参与**（否则会出现"关掉后再点官方行打不开"）；
   * - 不可读 → 退回本地意图 `localOpen && !forcedClosed`（与迁移前一致）。
   */
  const open = shouldShowPanel(snapshot)
  const dataOpen = panelDataOpen(snapshot)

  /**
   * ⚠️ **所有 DOM 写入都必须放在 effect 里，绝不能留在渲染期**（v1.14.47 修复）。
   *
   * ## 这里踩了什么
   *
   * 上一版把这两件事直接写在组件体的渲染逻辑里：
   *
   * ```tsx
   * host?.reportHostPanelId?.(hostPanelId)   // 改模块级变量
   * host.syncActiveAttribute?.(open)         // 写 document.documentElement 属性
   * ```
   *
   * 渲染期改 DOM / 改外部可变状态是 React 明令禁止的：它在 concurrent 渲染下可能被
   * **重复执行或丢弃**，而"写属性 → 触发观察器 → 再触发渲染"这种回路会让浏览器
   * 主线程被占满 —— 用户现象就是**点开工作台后整个页面卡死**（WSL 侧）
   * 以及**点「收起侧边栏」后 Edge 卡死**（Windows 侧；两条路径都会经过本组件渲染）。
   *
   * 本文件里我自己在别处写下的规矩就是"副作用一律走 useEffect"
   *（见下方 `takeOverFamilyPanel` 的注释），这两行是执行时的疏漏。
   *
   * ## 现在怎么保证收敛
   *
   * 两个 effect 都是**幂等**的：
   * - `reportHostPanelId` 同值时直接 return（见其实现）；
   * - `syncActiveAttribute` 只在值真的变化时才写属性（见其实现）。
   *
   * 所以"effect 写 → 观察器 → 再渲染 → effect 再跑"这条链会在**第二圈收敛**，
   * 不会无限循环。
   */
  useEffect(() => {
    host?.reportHostPanelId?.(hostPanelId)
    host?.syncActiveAttribute?.(open)
  }, [host, hostPanelId, open])
  /**
   * 宿主已经把我们选为当前面板、但页面上还留着兄弟插件的激活标记时，**由我们把它收起来**。
   *
   * ## 为什么必须有这一步（2026-09-13，本轮最后一个真 bug）
   *
   * 上一版把"兄弟面板开着"同时用在了**两个地方**：① 观察器里"兄弟开了就关掉自己"；
   * ② 显示条件里"兄弟开着就不显示"。第 ② 条制造了一个**死锁**：
   *
   * ```text
   * 面板被兄弟挤掉（我们把自己关了，宿主 activePanelId 仍是我们）
   *   → 兄弟标记如果残留（真实 task-board 就会留着，它只在关闭时摘）
   *   → 显示条件恒假
   *   → 用户再点入口：宿主的 selectPanel(同一个值) 被 React 判定为"无变化"，
   *     连重渲染都不会发生
   *   → 面板**永远打不开**
   * ```
   *
   * 正确做法是把"让位"只保留在 ①（观察器主动关掉自己，宿主状态随之为 null），
   * 而显示与否**只信宿主**；一旦宿主选中我们，我们就把残留的兄弟标记收掉 ——
   * 这正是 task-board 自己打开时对 ssh 做的事（`applyActive()` 里摘兄弟属性 + 广播），
   * 属于家族既定约定，不是新发明。
   */
  useEffect(() => {
    /**
     * 宿主选中我们时收掉残留的兄弟标记。
     *
     * 判据用 `snapshot.hostPanelId`（宿主选中的是不是我们）—— 这与"面板该不该显示"
     * **不是同一个问题**：这里问的是"宿主当前选中项是不是本插件"，所以直接把该值
     * 与 `PANEL_NAME` 比即可，无需再走 `decidePanel()`（那会把本地回落也算进来）。
     */
    if (snapshot.hostPanelId !== PANEL_NAME) return
    host?.takeOverFamilyPanel?.()
  }, [snapshot.hostPanelId, host])
  if (host === undefined) return null
  return (
    <div className="wb-panel-host" data-open={dataOpen}>
      <div className="wb-app-scope" {...{ [VIEW_ATTR]: '' }}>
        <WorkbenchApp runtime={host.runtime} closePanel={host.closePanel} />
      </div>
    </div>
  )
}

export function apply(ctx: unknown): () => void {
  const runtime = ctx as WorkbenchRuntime
  pluginCtx = ctx
  /**
   * 单实例守卫（v1.14.2，2026-09-12 背景渐黑事故的根因修复）。
   *
   * cordis 在热重载/HMR 与某些重挂场景下会**再次**执行 `apply()`，而上一轮的清理函数
   * 未必被调用到。上一版把 React root 建在模块外、且从不卸载，于是每个残留实例都还在：
   * - 每 5 秒轮询一次 `/api/workbench/drafts`；
   * - 各自渲染一个「待确认草稿」Modal。
   *
   * 每个 Modal 自带 `position:fixed` + `background:rgba(0,0,0,.52)` 的遮罩，
   * 三层叠起来就是用户看到的"页面一次比一次黑"（0.52 → 0.77 → 0.89），
   * 同时点击落在最上层那个实例上，导致关闭/暂存按钮要点很多次。
   *
   * 所以每次 `apply` 开头先**主动拆掉上一轮**：断连观察器、卸载 React root、
   * 摘掉所有本插件的 DOM 标记。宁可多拆一次，也不能让旧实例继续活着。
   */
  disposePreviousInstance()
  instanceAlive = true

  let open = false
  /**
   * 「用户在本插件里显式关掉了面板」的本地权威标志（v1.14.30）。
   *
   * 为什么必须有它：当 `layout.selectPanel` 拿不到时，我们**无法通知宿主取消选中**，
   * 宿主的 `activePanelId` 会一直停在 `personal-workbench`。此时若显隐只信宿主状态，
   * 那张 `fixed; inset:0; z-index:55` 的满屏层就**再也关不掉**，永久盖住会话区
   * （2026-09-13 实测：点「返回对话」后 `data-open` 仍为 "1"）。
   *
   * 语义：用户在本插件内的"关"是**权威**的，直到他再次显式打开。
   */
  let forcedClosed = false
  /**
   * 本地开关变化的**权威通知通道**：不依赖宿主订阅链（那条链在 layout 缺失时是死的），
   * 保证 `WorkbenchPanelContent` 每次开合都能重渲染。
   */
  const openListeners = new Set<() => void>()
  const notifyOpenChange = (): void => { for (const listener of openListeners) { try { listener() } catch { /* 单个订阅者出错不影响其它 */ } } }
  ensureStyle()

  /** 清理幂等标记：`disposePreviousInstance()` 与 cordis 都可能调用清理。 */
  let disposed = false
  const officialDisposers: Array<() => void> = []
  /** 承载 App 的容器：**始终只有一个**（官方 `shell.overlay` 槽位）。 */
  let activeHost: HTMLElement | undefined


  /**
   * 挂载官方 `main` 面板的内容（由注册给宿主的组件 ref 回调调用）。
   *
   * 用 ref 回调而非 hooks：让注册给宿主的组件保持**无 hooks 的稳定函数**，
   * 否则每次 apply 生成新组件类型，宿主重渲染时会整块卸载重挂。
   *
   * 这里再确认一次 `officialConfirmed`：自愈可能已把路径切成 DOM 腿，
   * 那种情况下官方容器必须留空（内容在覆盖层），否则就是两份 App 互相打架。
   */
  /**
   * 把运行时依赖交给常驻组件（真正的赋值在下方 `subscribePanelInfo` 定义之后，
   * 因为 `subscribe` 要用到它）。这里只做占位，保证组件拿到句柄前不会渲染成 null。
   */
  workbenchHost = { runtime, isOpen: () => open, closePanel: () => setOpen(false), subscribe: () => () => {} }
  /**
   * 官方槽位 + 布局服务软探测结果。
   *
   * **一律 `ctx.get()` 软探测，绝不放进 `inject`**：`slots` / `layout` 都是
   * DSH 0.1.5-rc.1 才有的，写进 inject 会让旧宿主上整个插件 pending
   * （该模式已复发 3 次：v1.10.1 的 uiWorkspace、v1.13.0 的 runtime.slots、v1.13.3 根治）。
   */
  const slots = (() => {
    // cordis 代理对未声明 inject 的服务，属性访问会直接抛错（"cannot get property ... without inject"），
    // 不能用 runtime.slots；必须走非严格的 ctx.get 软读取（与 dsh-cost-meter 的 ctx.get('slots') 一致）。
    const candidate = optionalService<SlotsService>(ctx, 'slots')
    if (candidate === undefined || candidate === null) return undefined
    return typeof candidate.inject === 'function' && typeof candidate.register === 'function' ? candidate : undefined
  })()
  const layout = optionalService<LayoutService>(ctx, 'layout')
  const selectPanel = typeof layout?.selectPanel === 'function' ? layout.selectPanel.bind(layout) : undefined
  /**
   * ## 宿主能力自检：不满足就**明确不启动**（设计文档 P5，v1.14.52）
   *
   * 这是与"软探测 + 静默降级"**根本不同**的一条路：
   *
   * - 旧做法：探不到 `layout`/`slots` → 判定"宿主不支持官方槽位" → 换 DOM 腿 →
   *   那条腿铺满屏层盖住会话区（用户"除左栏外什么都点不了"），而且**一声不响**；
   * - 新做法：`inject` 声明完整（缺服务 cordis 直接让插件 pending），
   *   万一进来了但槽位不全 → 打一条**可读**日志（含缺什么 + 要求什么版本），
   *   然后**返回空清理函数，不注册任何东西、不写任何 DOM**。
   *
   * 老宿主上工作台不启动是**可接受且刻意**的：与其半死不活地降级，不如明确不启动。
   */
  const capability = checkHostCapabilities({ slots: slots as SlotsProbe | undefined, layout })
  if (!capability.ok) return refuseToStart(capability, (message) => console.error(message))
  /**
   * `layout.selectPanel` 的可用性**决定了走哪条腿**（v1.14.48 修正语义）。
   *
   * ## 判据的语义要分清（这是本项最容易搞错的地方）
   *
   * | 情形 | 含义 | 该怎么做 |
   * |---|---|---|
   * | `layout` 取不到（undefined） | **信息不足**（可能被 isolate/intercept 藏了） | 照走官方路径 |
   * | `layout` 在、但**没有** `selectPanel` | **确凿的无能力** | 必须回退 DOM 腿 |
   *
   * 2026-09-13 在**真实低版本宿主**（DSH 0.1.1-rc.1）上实测到第二种：
   * `protoKeys=[constructor, attachPanels, toggleSidebar, openDetails, closeDetails]`
   * —— 槽位 `sidebar.panellist` 存在，所以旧代码判定"走官方"；
   * 可宿主的侧栏**没有选中面板的机制**，`activePanelId` 永远是 null，
   * 面板永远不显示，而我们的自建入口又被藏起来 → 用户现象"低版本上工作台打不开"。
   *
   * 所以这里把"确凿无能力"作为**回退依据**交给 `officialSlotDecision`，
   * 而"取不到 layout"仍然照走官方（避免重犯 v1.14.27 那次误判）。
   */
  if (typeof selectPanel !== 'function') {
    let shape = `layout=${String(layout)}`
    if (layout !== undefined && layout !== null) {
      try {
        const own = Object.keys(layout as object).slice(0, 20)
        const proto = Object.getPrototypeOf(layout as object)
        const protoKeys = proto === null || proto === undefined ? [] : Object.getOwnPropertyNames(proto).slice(0, 20)
        shape = `typeof=${typeof layout} selectPanelType=${typeof (layout as { selectPanel?: unknown }).selectPanel} ownKeys=[${own.join(',')}] protoKeys=[${protoKeys.join(',')}]`
      } catch (error) {
        shape = `读 layout 形状时抛错：${String(error)}`
      }
    }
    console.warn(`[workbench] 未取到 layout.selectPanel：${shape}`)
  }
  /**
   * `OFFICIAL_ATTR` 是**给 CSS 看的**：它决定"面板内容显示在官方容器里"。
   *
   * ⚠️ 自 v1.14.52 起它**无条件**存在 —— 走不到官方路径时 `apply()` 已在能力自检处
   * 直接返回（见 `capabilities.ts`），所以这里不再有"两条腿二选一"的状态变化。
   * 历史坑：删自愈逻辑时曾把它一起删掉，结果官方面板容器存在但 CSS 不放行
   * → 面板打开后一片空白。
   */
  document.documentElement.setAttribute(OFFICIAL_ATTR, '')
  console.info('[workbench] 已启用官方侧栏槽位 sidebar.panellist + main')

  /**
   * 同步 `<html>` 上的本插件激活标记。
   *
   * 调用点：`setOpen()` 与 `WorkbenchPanelContent` 的 effect（v1.14.47 起副作用只在 effect 里）。
   * **必须幂等**：调用方可能在"属性变化 → 观察器 → 再渲染"的回路里重复调用它，
   * 无脑写属性会让回路停不下来。所以这里只在**值真的变了**时才碰 DOM。
   */
  const syncActiveAttribute = (active: boolean): void => {
    const root = document.documentElement
    const has = root.hasAttribute(ACTIVE_ATTR)
    if (active === has) return
    if (active) root.setAttribute(ACTIVE_ATTR, '')
    else root.removeAttribute(ACTIVE_ATTR)
  }

  /**
   * ⚠️ **已废弃的"自愈复核"——不要恢复它**（v1.14.7 移除，2026-09-15 实测教训）。
   *
   * 曾经的设想：注册表 + DOM 两侧都有证据才算走官方路径，否则撤销注册、回退 DOM 腿，
   * 以此避免"面板打不开但会话列已让位"的空白屏。
   *
   * 实际后果（真实事故）：判定依赖 `Array.isArray(slots.entries(name))`，
   * 而宿主返回的**不是数组** → 判定恒为假 → 我们在**官方注册其实成功**的情况下
   * 主动 `dispose()` 掉注册 → 侧栏同时出现「官方入口行 + 自建 DOM 入口行」两行，
   * 比不做自愈更糟，而且用户没法自己恢复。
   *
   * **结论：不要在不确定的检测结果上做破坏性动作。**
   * v1.14.53 起更进一步：能力不满足就**明确不启动**（`capabilities.ts`），
   * 所以连"降级到另一条腿"这个分支本身都不存在了。
   */

  /**
   * 面板"健康自查" —— **已彻底移除**（v1.14.21）。
   *
   * 曾经的设想：面板处于激活态时若容器测不到尺寸，就自动切到自建常驻容器，
   * 避免用户被卡在"打开没反应"。
   *
   * **实际代价远大于收益**（2026-09-15 用户实测）：
   * - 宿主重排期间完全可能出现**短暂的** 0 尺寸 → 被判为故障；
   * - 一旦判定成立，面板改用自建容器（**界面退化成改造前那套**）；
   * - 而这条判定每 500ms 跑一次，用户**无法自己恢复**（刷新也会在几秒后再次触发）。
   *
   * 判据本身（读自己的几何尺寸）是确定的，但"**在不确定的时机做破坏性动作**"
   * 这个错误和之前那版"自愈复核"是同一个：一次误判就永久降级，而且降级后的形态更糟。
   *
   * v1.14.53：连"切到自建容器"这条退路也随 DOM 腿一起删掉了。
   * 能力不满足时 `apply()` 直接不启动（有可读日志），不存在运行时降级。
   */

  const setOpen = (value: boolean): void => {
    /**
     * 诊断句柄（只为排查用，代价极低）：把"谁在什么时机开关面板"暴露到 window 上。
     * 排查这类"点了没反应"的问题时，光看 DOM 分不清是"没调用"还是"调用了又被重置"。
     */
    try {
      const log = (window as unknown as { __wbDebugLog?: Array<Record<string, unknown>> }).__wbDebugLog
      log?.push({ at: Date.now(), value, caller: new Error().stack?.split('\n')[2]?.trim().slice(0, 90) ?? '' })
      if (log !== undefined && log.length > 50) log.shift()
    } catch { /* ignore */ }
    /**
     * 官方路径：**唯一的开关是 `layout.selectPanel`**（宿主单值状态）。
     *
     * `selectPanel` 抛错是**确定失败信号**（宿主明确说"这个面板没注册"）。
     * v1.14.53 起没有"换覆盖层显示"这条退路了（DOM 腿已删）：只把失败记进日志与
     * `window.__wbDebugLog`，界面保持在宿主选中态 —— 面板打不开时是**可见的空态**，
     * 而不是悄悄换一套容器（那会带来两套门控、双 App 实例与"再也打不开"的连环坑）。
     */
    try {
      selectPanel?.(value ? PANEL_NAME : null)
    } catch (error) {
      console.error('[workbench] layout.selectPanel 调用失败（面板可能未注册）：', String(error))
      return
    }
    open = value
    /**
     * v1.14.45：**不再**用本地 `forcedClosed` 压着显隐。
     *
     * 原因是它会造成一个对称的 bug：关掉面板后 `forcedClosed` 一直为真，
     * 于是用户再点**宿主的**侧栏行（宿主把 `activePanelId` 设回我们）时，
     * 显示条件里的 `!forcedClosed` 仍然为假 → 面板打不开（实测复现）。
     *
     * 现在显隐由 `WorkbenchPanelContent` 按「宿主状态优先」统一判定：
     * `selectPanel(null)` 一成功，宿主的 `activePanelId` 就变成 null，
     * 关这件事已经由**宿主**确认过了，不需要本地再压一层。
     */
    notifyOpenChange()
    syncActiveAttribute(value)
  }

  // 供槽位组件使用的运行时句柄；类型上放在 runtime 的扩展位，避免污染 WorkbenchRuntime。
  /**
   * 订阅 `layout` 的 `activePanelId`：宿主侧取消选中时把本地 `open` 标志纠回来。
   *
   * 只试两种已知形态（不猜第三种）：`layout` 上直接给 subscribe/store，
   * 或 `layout.panelInfo`。拿不到就退回"以本地标志为准"（与迁移前一致）。
   */
  const subscribePanelInfo = (listener: () => void): (() => void) => {
    const candidate = layout as unknown as {
      subscribe?: (fn: (info: { activePanelId?: unknown }) => void) => (() => void) | void
      panelInfo?: { subscribe?: (fn: (info: { activePanelId?: unknown }) => void) => (() => void) | void }
      getSnapshot?: () => { activePanelId?: unknown }
    }
    const subscribe = typeof candidate.subscribe === 'function' ? candidate.subscribe.bind(candidate)
      : typeof candidate.panelInfo?.subscribe === 'function' ? candidate.panelInfo.subscribe.bind(candidate.panelInfo)
        : undefined
    if (subscribe === undefined) return () => {}
    try {
      const dispose = subscribe((info) => {
        /**
         * 宿主通知"当前选中项变了" → 判定改走同一个纯函数（P1）。
         *
         * 注意语义：这里 `intentOpen: false` —— 宿主可读时它根本不参与判断；
         * 只有宿主给了 store 却不给 activePanelId（既不是我们也不是 null）时，
         * 才会得到"不显示"，与原实现 `info.activePanelId === PANEL_NAME` 等价。
         */
        const next = shouldShowPanel({
          stateReadable: true,
          hostPanelId: typeof info?.activePanelId === 'string' ? info.activePanelId : null,
          intentOpen: false,
        })
        try {
          const log = (window as unknown as { __wbDebugLog?: Array<Record<string, unknown>> }).__wbDebugLog
          log?.push({ at: Date.now(), from: 'layout.subscribe', activePanelId: String(info?.activePanelId), value: next })
          if (log !== undefined && log.length > 50) log.shift()
        } catch { /* ignore */ }
        open = next
        listener()
      })
      return typeof dispose === 'function' ? dispose : () => {}
    } catch { return () => {} }
  }
  /**
   * 宿主镜像给出的选中态：`undefined` = 宿主从未提供过状态通道（**不是** "没选中"）。
   *
   * 与 `hostSelected()` 的分工：本函数只回答"宿主说选中的是不是我们"，
   * 不掺任何本地回落 —— 槽位句柄的 `isHostSelected` 需要的正是这个"未知"语义
   * （调用方据此决定是否退回 `subscribe`）。
   */
  const hostSelectedFromMirror = (): boolean | undefined => (
    panelInfoHookSeen ? hostPanelId === PANEL_NAME : undefined
  )
  const hostSelected = (): boolean => {
    /**
     * v1.14.45：优先用**槽位组件回写的模块级镜像**。
     *
     * 原因：`ctx.layout` 是宿主的 `LayoutController`，接口里**只有** `selectPanel` /
     * `toggleSidebar` / `openRightbar` / `closeRightbar` / `beginNavigation` / `dispose`，
     * 既没有 `subscribe` 也没有 `getSnapshot`（读宿主 `ui-layout` 源码核实）。
     * panelInfo store 挂在 root 槽位的全局 hook props 上，只有槽位组件读得到。
     * 下面那段 `getSnapshot` 试探因此在本宿主上永远拿不到值，只能作历史兼容保留。
     *
     * ## 为什么这里也走 `decidePanel()`
     *
     * 本函数被两个地方消费：槽位句柄的 `isHostSelected`（标题栏按钮的回落），
     * 以及"本插件面板是否真的显示着"（家族互斥让位）。**两处问的都是显示态**，
     * 所以判据必须与面板容器同源；改动前三处各写一遍，正是 bug 2/6/9 的根因。
     */
    const mirrored = hostSelectedFromMirror()
    if (mirrored !== undefined) return mirrored
    /**
     * 历史兼容的第二条通道：`layout.getSnapshot()`。
     *
     * 本宿主没有这个接口（恒为 `undefined`），所以走到这里的结果要么是某个旧宿主
     * 给的宿主状态，要么退回本地 `open`。
     */
    let fromLayout: string | null | undefined
    try {
      const candidate = layout as unknown as { getSnapshot?: () => { activePanelId?: unknown } }
      const snapshot = candidate.getSnapshot?.()
      if (snapshot !== undefined && 'activePanelId' in snapshot) {
        fromLayout = typeof snapshot.activePanelId === 'string' ? snapshot.activePanelId : null
      }
    } catch { /* 读不到就退回本地标志 */ }
    return shouldShowPanel({ stateReadable: fromLayout !== undefined, hostPanelId: fromLayout ?? null, intentOpen: open })
  }
  /**
   * 本插件的面板**当前是不是真的显示着**。
   *
   * ## 为什么历史上必须有这个函数（值得留着，别再犯）
   *
   * ⚠️ **不能用 `open` 这个本地标志**（2026-09-13 实测踩到）：
   * 用户点的是**宿主**的侧栏行，宿主直接调 `layout.selectPanel(id)` 把
   * `activePanelId` 设成我们 —— 我们自己的 `setOpen` 根本没被调用，本地 `open`
   * 依然是 `false`。此时面板是**显示着的**（`WorkbenchPanelContent` 按宿主状态渲染），
   * 但任何 `if (open)` 的判断都会说"没开"。
   *
   * v1.14.53：它原先的**唯一消费者**是家族互斥（兄弟插件 `*-active` 出现时让位），
   * 那条逻辑已删除，所以函数本体也删了。判据本身没有丢 ——
   * 面板"该不该显示"仍然只有一个答案：`shouldShowPanel()`（`panelState.ts`）。
   */

  const slotApi: WorkbenchSlotApi = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
    subscribe: subscribePanelInfo,
    isHostSelected: hostSelected,
  }
  /**
   * 把运行时依赖交给常驻组件；`subscribe` 用真正的选中态订阅，
   * 这样"关掉面板"时组件只是重新渲染成隐藏态，**不会被卸载**。
   */
  workbenchHost = {
    runtime,
    isOpen: () => open,
    closePanel: () => setOpen(false),
    subscribe: (listener) => {
      /**
       * 两条来源都要订：① 本地开关变化（权威、不依赖宿主）；
       * ② 宿主状态变化（宿主自己切换面板时跟随）。任一分支失效都不会让组件失联。
       */
      openListeners.add(listener)
      const disposeHost = subscribePanelInfo(listener)
      return () => { openListeners.delete(listener); disposeHost() }
    },
    isLocalOpen: () => open,
    isForcedClosed: () => forcedClosed,
    stateReadable: () => selectPanel !== undefined,
    /**
     * 宿主面板选中态的**唯一可用通道**回写口。
     *
     * `WorkbenchPanelContent` 每次渲染都会把 `usePanelInfo` 读到的值送到这里，
     * 所以本插件的其它两处（标题栏按钮的 `isHostSelected`、CSS 的 ACTIVE_ATTR）
     * 都拿到同一个事实。幂等：同值时只更新变量，不做任何 DOM 写或通知。
     */
    reportHostPanelId: (panelId) => {
      /**
       * 先记"宿主给过 hook"这个事实，再归一化值。
       *
       * `undefined` 单独有意义（= 宿主不给 hook，读不到宿主状态），所以这里**不能**
       * 把 undefined 也当成 null 写进 `hostPanelId` —— 那会让"不可读"伪装成"读到了 null"，
       * 于是"宿主没选中我们"被当成事实，本地兜底路径就永远走不到了。
       */
      panelInfoHookSeen = true
      const normalized = panelId === undefined || panelId === null ? null : String(panelId)
      if (normalized === hostPanelId) return
      hostPanelId = normalized
    },
    hasPanelInfoHook: () => panelInfoHookSeen,
    hostSelected: hostSelectedFromMirror,
    /**
     * 兄弟插件是否正开着面板。
     *
     * ⚠️ **只看 `<html>` 上的 `*-active` 属性，绝不看"视图容器在不在 DOM 里"**
     * （v1.14.45 实测，差点写错）：task-board 的视图容器
     *（`[data-dsh-taskboard-view]`）是**常驻**的 —— 它的 `panel-mount-core` 把容器
     * 永久挂在会话列里，靠 CSS 按 `data-dsh-taskboard-active` 门控显隐。
     * 所以"容器存在"永远为真，拿它做判据会让本插件**永远打不开**。
     *
     * 唯一可信的信号就是那个属性：task-board 打开时写、关闭时摘
     *（`panel-mount-core.applyActive()`），官方路径与 DOM 腿都读它，语义一致。
     */
    syncActiveAttribute,
    /**
     * 宿主面板状态不可读时的安全兜底（2026-09-13 遮挡事故修复）。
     *
     * 官方满屏层（`.wb-panel-host`：`fixed; inset:0; z-index:55`）一旦承载内容
     * 又收不起来，就会永久盖住会话区与其它插件。读不到宿主状态时，官方容器里**不渲染内容**
     * （见 `WorkbenchPanelContent`）。
     *
     * v1.14.53：原实现还会把 App 改挂到**自建常驻容器**；那条路随 DOM 腿一起删除了。
     * 现在的依赖关系是：能力齐备 → 宿主状态必然可读（`usePanelInfo` 存在），
     * 因此这条兜底在受支持宿主上不会被触发；真触发了也只剩"不渲染 + 日志"，
     * 不会再悄悄换一套容器（那正是双 App 实例与"弹框概率性消失"的来源）。
     */
    onUnreadableHostState: () => {
      console.warn('[workbench] 宿主面板状态不可读：官方面板层不承载内容（不会再切自建容器，见 v1.14.53 说明）')
    },
  }
  /**
   * 诊断日志：记录每一次"开关面板"的调用与来源 —— 排查"点了入口面板不开"时，
   * 光看 DOM 分不清是"没调用"还是"调用了又被重置"。读法：`window.__wbDebugLog`。
   */
  ;(window as unknown as { __wbDebugLog?: unknown[] }).__wbDebugLog = []
  if (slots !== undefined) {
    /**
     * 关于 `inject` 的回调形态（**2026-09-15 实测结论，别再改**）：
     *
     * 官方参照实现用的是 generator（`dsh-client-ui-conversation`：
     * `slots.inject("main", function* () { yield slots.register(...) })`），
     * 于是我曾跟着改成 `function*` + `yield`。结果是**注册没有生效**：
     * 侧栏里只剩自建 DOM 入口行，官方面板行虽被登记但我们的判定拿不到证据，
     * 最终表现为「两行入口」。
     *
     * 本宿主的 cordis 版本里 `ctx.slots.inject(name, cb)` 的 `cb` 走的是
     * "普通函数、返回值当 disposer"这一路（前端 bundle 里连
     * `isGeneratorFunction` 都不存在）。**所以这里必须用普通箭头函数**，
     * 并且把 disposer 记进自己的数组以便主动回退。
     *
     * 教训：官方参照写法未必对本宿主的 cordis 版本有效 —— 改了要**实测**再留。
     */
    // 与 dsh-cost-meter / dsh-pocket 同构：inject 保证宿主槽位存在时才注册。
    try {
      slots.inject('conversation.session.header.actions', () => slots.register(
        { name: 'conversation.session.header.actions', id: 'personal-workbench', order: -4, inject: () => ({ workbench: slotApi }) },
        WorkbenchHeaderEntry as unknown as (props: Record<string, unknown>) => JSX.Element | null,
      ))
    } catch (error) {
      console.warn('[workbench] header slot registration failed, falling back to sidebar entry only:', String(error))
    }
    /**
     * 侧栏入口：官方 `sidebar.panellist`（宿主渲染行按钮 + 高亮 + aria）。
     *
     * **面板内容不再注册到 `main`**：`main` 是键槽，`activePanelId` 一变宿主就卸载
     * 整棵子树 —— 而我们这棵树里装着常驻的草稿弹框（关面板就会连弹框一起消失，
     * 用户实测"只能回到工作台页面才看得到弹框"）。改挂**始终存在**的
     * `shell.overlay`（框架级浮层），面板显隐由"是否被选中"决定。
     *
     * 注册进 `main` 的那份只留一个**空占位**：`layout.selectPanel(id)` 会校验
     * "这个 id 有没有对应的 main 条目"，没有就会抛错。给个返回 null 的组件既满足校验，
     * 又不渲染任何东西（真正的内容在 overlay 里）。
     */
    try {
      const disposeList = slots.inject(OFFICIAL_PANEL_LIST_SLOT, () => slots.register(
        { name: OFFICIAL_PANEL_LIST_SLOT, id: PANEL_NAME, order: -4, label: ENTRY_TITLE },
        // 模块级稳定组件（理由见 WorkbenchPanelEntry）
        WorkbenchPanelEntry as unknown as (props: Record<string, unknown>) => JSX.Element | null,
      ))
      if (typeof disposeList === 'function') officialDisposers.push(disposeList)
      // main 只放空占位（让 selectPanel 校验通过）；真内容在 overlay。
      const disposeMain = slots.inject(OFFICIAL_MAIN_SLOT, () => slots.register(
        { name: OFFICIAL_MAIN_SLOT, id: PANEL_NAME, key: PANEL_NAME, order: -4 },
        (() => null) as unknown as (props: Record<string, unknown>) => JSX.Element | null,
      ))
      if (typeof disposeMain === 'function') officialDisposers.push(disposeMain)

      /**
       * 面板内容：**注册到官方 `shell.overlay`**。
       *
       * 为什么不是不 `main`：`main` 是键槽，`activePanelId` 一变宿主就卸载整棵子树 ——
       * 而我们这棵树里装着常驻的草稿弹框（关面板就会连弹框一起消失，用户实测
       * "只能回到工作台页面才看得到弹框"）。`shell.overlay` 是**始终存在**的框架级浮层，
       * 面板显隐由 `decidePanel()`（是否被宿主选中）决定。
       *
       * 历史：2026-09-13 曾因 `slot entry crashed in 'shell.overlay': TypeError: … reading
       * 'subscribe'` 而放弃这个槽位。**那个崩溃的真正根因是 inject 少声明了 `slots` /
       * `layout`**（cordis 没等依赖就绪就调我们的 apply），已由 `inject` 声明修掉，
       * 且现在有 `test/capabilities.test.mjs` 把 inject 精确锁成 5 项。
       */
      const disposeOverlay = slots.inject(OFFICIAL_OVERLAY_SLOT, () => slots.register(
        { name: OFFICIAL_OVERLAY_SLOT, id: PANEL_NAME, order: -4 },
        WorkbenchPanelContent as unknown as (props: Record<string, unknown>) => JSX.Element | null,
      ))
      if (typeof disposeOverlay === 'function') officialDisposers.push(disposeOverlay)
    } catch (error) {
      /**
       * 注册失败**不再降级**（v1.14.53）：DOM 腿已删除，没有第二条路可走。
       * 这里只把失败说清楚 —— 用户看到的是"侧栏没有工作台入口"，
       * 而 console 里能查到确切原因，不会像以前那样悄悄换一套界面。
       */
      console.error('[workbench] 官方槽位注册失败：侧栏不会出现工作台入口。原因：', String(error))
    }
  }

  /**
   * 侧栏宽度 → `--wb-sidebar-w`（面板左边界）。
   *
   * 量出侧栏宽度写进 CSS 变量：面板从侧栏右侧开始铺，
   * **绝不遮住 DSH 左侧导航**（用户实测反馈：改造后面板盖住了整个左侧栏）。
   *
   * 取值保守化（v1.14.21）：只接受 "明显是侧栏" 的宽度（>0 且 < 视口 40%）。
   * 这个值直接决定面板左边界 —— 一旦量错（例如匹配到与视口同宽的元素），
   * 面板宽度会变成 0，看起来就是"面板打不开"。宁可不更新，也不写入可疑值。
   *
   * v1.14.47：加**幂等保护**。本函数由 ResizeObserver 回调调用，而它自己会改
   * `<html>` 上的内联样式 —— 无脑写 CSS 变量可能让布局再变一次、再次触发回调。
   * 用户现象是"点「收起侧边栏」后 Edge 卡死"（侧栏宽度变化正是那条路径）。
   * 现在同值不写，"测量 → 写值 → 再测量"这条链最多跑两圈就收敛。
   */
  const syncSidebarWidth = (): void => {
    const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
    if (column === null) return
    const width = Math.round(column.getBoundingClientRect().width)
    if (width <= 0 || width > window.innerWidth * 0.4) return
    const next = `${width}px`
    if (document.documentElement.style.getPropertyValue('--wb-sidebar-w').trim() === next) return
    document.documentElement.style.setProperty('--wb-sidebar-w', next)
  }
  const sidebarResizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => syncSidebarWidth())
  const observeSidebar = (): void => {
    const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
    if (column === null) return
    sidebarResizeObserver?.disconnect()
    sidebarResizeObserver?.observe(column)
    syncSidebarWidth()
  }
  observeSidebar()

  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    instanceAlive = false
    sidebarResizeObserver?.disconnect()
    for (const dispose of officialDisposers.splice(0)) {
      try { dispose() } catch { /* 卸载阶段不再纠缠 */ }
    }
    const html = document.documentElement
    /**
     * 只摘自己写过的两个属性（设计文档 I4 白名单）：ACTIVE_ATTR 与 OFFICIAL_ATTR。
     * `--wb-sidebar-w` 是内联样式变量，留着无害（下一次 apply 会按真实宽度覆盖）。
     */
    html.removeAttribute(ACTIVE_ATTR); html.removeAttribute(OFFICIAL_ATTR)
    if (pluginCtx === ctx) pluginCtx = undefined
    if (workbenchHost?.closePanel === undefined ? false : workbenchHost.runtime === runtime) workbenchHost = undefined
    if (activeDisposer === cleanup) activeDisposer = undefined
  }
  // 注册给模块级守卫：下一次 apply() 会先调用它拆掉本轮，避免残留实例。
  activeDisposer = cleanup
  return cleanup
}

