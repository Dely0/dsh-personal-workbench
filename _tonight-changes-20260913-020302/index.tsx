/**
 * dsh-personal-workbench client v0.2 — 方案 A 左右分栏：
 *  - 左侧导航区：今日 / 可导航日历(周/月) / 树状列表（默认折叠、记忆展开）
 *  - 右侧详情区：仅显示选中任务；未选中显示占位
 *  - AI 澄清/咨询/拆解统一跳官方会话区；工作台侧边栏显示待确认草稿红点
 */
import { createRoot, type Root } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { ACTIVATE_EVENT, ACTIVE_ATTR, OFFICIAL_ATTR, PANEL_NAME, PENDING_ATTR, VIEW_ATTR } from './constants.js'
import {
  BLOCKED_ATTR, ENTRY_ATTR, ENTRY_CLASS, ENTRY_HTML, ENTRY_PLUGIN_ATTR, ENTRY_PLUGIN_ID, ENTRY_PART_ATTR,
  ENTRY_PART_VALUE, ENTRY_TITLE, OFFICIAL_MAIN_SLOT, OFFICIAL_PANEL_LIST_SLOT, SIDEBAR_COLLAPSED_ATTR,
  SIDEBAR_ENTRY_SELECTOR, isSiblingPanelActive, matchesCollapsedClass, officialPathConfirmed,
  officialSlotDecision, siblingActiveFilter,
} from './entryContract.js'
import { Modal } from './components/Modal.js'
import { SettingsModal } from './components/SettingsModal.js'
import { DraftBanner } from './components/DraftBanner.js'
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
   * 记下 id 后，轮询结果里命中这个集合的直接忽略。
   */
  const dismissedDraftIdsRef = useRef<Set<string>>(new Set())
  const [reminders, setReminders] = useState<Array<{ reminderId: string; taskId: string; title: string; dueAt: string; methodCode: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reminderModalOpen, setReminderModalOpen] = useState(false)
  const [pendingOpen, setPendingOpen] = useState(false)
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
        // 用户已经处理过的草稿不再推上来（见 dismissedDraftIdsRef 的说明）。
        const dismissed = dismissedDraftIdsRef.current
        const nextDraft = res.draft !== null && dismissed.has(res.draft.id) ? null : res.draft
        if (alive) { setPendingDraft(nextDraft); setDeferredDrafts((res.deferredDrafts ?? []).filter((d) => !dismissed.has(d.id))) }
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
      const ws = safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.list.getSnapshot() ?? { items: [] }
      let workspaceId = ws.items[0]?.workspaceId
      const hostHome = safeService<WorkbenchRuntime['connection']>(runtime, 'connection')?.generation.getSnapshot()?.host.home
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

  const sessionListSnapshot = safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')?.list.getSnapshot() ?? { ids: [], byId: {}, current: undefined }
  /** 待你处理的事项数：待确认草稿 + 已暂存草稿 + 到期提醒。 */
  const pendingCount = (pendingDraft === null ? 0 : 1) + deferredDrafts.length + reminders.length
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
  /** 唤回一份暂存草稿：清掉暂存标记，它会立刻重新弹出待确认弹窗。 */
  const resumeDeferredDraft = async (draftId: string): Promise<void> => {
    try {
      await api(`/api/workbench/drafts/${draftId}/resume`, { method: 'POST' })
      setPendingOpen(false)
      const res = await api<{ draft: DraftView | null; deferredDrafts?: DraftView[] }>('/api/workbench/drafts')
      setPendingDraft(res.draft); setDeferredDrafts(res.deferredDrafts ?? [])
      setNotice('已唤回，待你决定')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
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
        onDismissed={() => { dismissedDraftIdsRef.current.add(pendingDraft.id) }}
        /**
         * 「暂存」：把横幅收掉，但**绝不能**把 id 记进屏蔽集合。
         *
         * 那条集合是给"确认/放弃"用的（防止 5 秒轮询再把已终结的草稿推上来）。
         * 暂存的草稿服务端仍是 pending、只是 `deferred_at` 有值，前台还要在
         * 「待处理 → 已暂存」里继续展示；一旦记进集合，轮询返回的 `deferredDrafts`
         * 会被同一集合过滤掉 —— 用户看到的就是"暂存了但列表里没有，
         * 切到别的会话再回来才出现"（2026-09-12 实测 BUG）。
         * 顺手立刻刷一次列表，不用等下一个 5 秒轮询。
         */
        onDeferred={() => {
          dismissedDraftIdsRef.current.delete(pendingDraft.id)
          setPendingDraft(null)
          void refresh()
        }}
        onDone={() => { setPendingDraft(null); setPlanRefreshKey((v) => v + 1); setReportRefreshKey((v) => v + 1); setKnowledgeRefreshKey((v) => v + 1); setIdeaRefreshKey((v) => v + 1); void refresh() }}
        /**
         * 右上角 X / Esc / 点遮罩 = **收起这条横幅**（不是放弃草稿）。
         *
         * 必须把 id 记进 dismissed 集合，否则 5 秒轮询立刻又把它推上来 ——
         * 用户看到的就是"关闭按钮没有任何逻辑，关掉 5 秒后又弹出"
         * （2026-09-12 实测 BUG）。草稿本身仍是 pending，会留在「待处理」里等你决定。
         */
        onClose={() => { dismissedDraftIdsRef.current.add(pendingDraft.id); setPendingDraft(null) }}
      />}

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
            {pendingDraft !== null && (
              <div className="wb-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <span style={{ flex: 1 }}>
                  <b>待确认的{draftKindLabel(pendingDraft.kindCode)}</b>
                  <span className="wb-switch-desc">AI 已提交，确认后才会写入工作台。</span>
                </span>
                <button className="wb-btn primary" onClick={() => setPendingOpen(false)}>知道了</button>
              </div>
            )}
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
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  return column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement ?? (column.firstElementChild as HTMLElement | undefined)
}
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  return Array.from(root.children).find((child): child is HTMLButtonElement => child.tagName === 'BUTTON')
}
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>('[data-pane="conversation"], [class*="centerCol"]') ?? undefined
}

export const name = 'personal-workbench-client'
/**
 * 硬依赖只保留在旧版本 DSH 里也稳定存在的三个服务。
 *
 * `uiWorkspace` 是 DSH 0.1.5-rc.1 才引入的（0.1.1 的 dsh-client-ui-workspace 里
 * 没有这个符号）。cordis 的 inject 是"缺一个就整个插件 pending"，所以把它放这里
 * 会让老版本 DSH 直接报 "Failed to load plugins"；既然它只在启动 AI 会话时用一次，
 * 就按插件既有原则做成软探测（见 connectWorkspace）。
 */
export const inject = ['sessions', 'workspaces', 'connection']

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

/**
 * 生命周期计数探针（v1.14.6 起）。
 *
 * 为什么保留在正式代码里：这次的"累积型轮询泄漏"只发生在**真实交互时序**下
 * （反复开关面板 / 切会话），单测和一次性手测都抓不到。计数日志每次都只在
 * `apply()` / `cleanup()` / 清扫 / 挂载时各打**一行**，不刷屏，但把
 * "宿主到底重挂了几次、旧实例到底拆掉了没有"变成可读的事实 ——
 * 下次同类问题不必再靠猜。
 */
let lifecycleSeq = 0
const lifecycleTrace: string[] = []

function traceLifecycle(step: string): void {
  lifecycleSeq += 1
  const line = `#${lifecycleSeq} ${step} · 存活实例=${liveInstanceCount}`
  lifecycleTrace.push(line)
  if (lifecycleTrace.length > 40) lifecycleTrace.shift()
  console.log(`[workbench] ${line}`)
}

/**
 * 把宿主递来的 slot 容器描述成一行可读文本（诊断用）。
 *
 * 用来回答"宿主为什么反复换容器"：如果每次的 `parent` 相同而节点不同，
 * 说明宿主在重渲 slot 的元素本身；如果连 `parent` 都变，那是整块面板被重建。
 * 只打一行、只读属性，不产生副作用。
 */
function describeNode(node: Element): string {
  const attrs = Array.from(node.attributes)
    .filter((a) => a.name !== 'style')
    .map((a) => (a.value === '' ? a.name : `${a.name}="${a.value.slice(0, 24)}"`))
    .slice(0, 4)
    .join(' ')
  const parent = node.parentElement
  const parentDesc = parent === null
    ? '(无父级)'
    : `<${parent.tagName.toLowerCase()}>${Array.from(parent.attributes).slice(0, 2).map((a) => `[${a.name}]`).join('')} 子元素=${parent.children.length}`
  const siblings = parent === null ? 0 : Array.from(parent.children).filter((c) => c.hasAttribute(VIEW_ATTR)).length
  return `[${attrs}] · parent=${parentDesc} · 同父本插件容器=${siblings}`
}

/**
 * 当前存活的 App 实例数（每次挂载 +1、每次卸载 -1）。
 *
 * 这是判断"单实例守卫是否生效"的唯一硬指标：如果它只增不减，
 * 就说明 `cleanup()` 没跑或没卸干净 —— 那正是"背景一次比一次黑 + 按钮点两次"的成因。
 */
let liveInstanceCount = 0

/**
 * 官方 `main` 槽位当前的容器节点（宿主每次重挂都会换一个新的）。
 *
 * 它只作为 **portal 目标**使用：App 的 React 树挂在我们自建的固定宿主上，
 * 容器怎么换都不会卸载 App —— 见 `mountPanelContent()` 的说明。
 */
let portalTarget: HTMLDivElement | undefined

/**
 * 把 App 渲染进宿主容器，但**不把自己的根建在宿主容器里**。
 *
 * 宿主（DSH 的官方槽位）会反复重挂面板容器，实测 30 秒内换 10 次。
 * 如果根建在容器里，每次换容器都等于重建整个 App：5 秒轮询被重启、
 * `open` 状态清零、弹窗状态丢失 —— 用户看到"按钮点两次""请求量暴涨"。
 * portal 把这层变化隔离掉：容器只是"渲染目的地"。
 */
function OfficialPanelMount({ target, children }: { target: HTMLDivElement; children: ReactNode }): ReactNode {
  return createPortal(children, target)
}

/** 主动拆掉上一轮实例（幂等；没有任何残留时是 no-op）。 */
function disposePreviousInstance(): void {
  const disposer = activeDisposer
  if (disposer === undefined) return
  activeDisposer = undefined
  try { disposer() } catch (error) {
    console.warn('[workbench] 上一轮实例清理失败（继续挂载新实例）：', String(error))
  }
}

/**
 * 清扫**历史残留**的工作台容器。
 *
 * 为什么单靠 `disposePreviousInstance()` 不够：
 * - `activeDisposer` 只记住**最后一次** apply 的清理函数。一旦它被覆盖、清空，
 *   或者某轮 `cleanup()` 中途抛错（宿主重渲染、容器已被摘走都可能触发），
 *   更早那几轮的 React 根就再也没人回收 —— 它们会继续每 5 秒轮询草稿、
 *   继续渲染弹窗，于是"背景一次比一次黑、要点好几次才关得掉"。
 * - 2026-09-12/13 实测：硬刷新后干净加载是 30 秒 6 次草稿请求（1 份轮询），
 *   而反复打开面板/切会话之后同一页面变成 12 秒 24 次（≈10 份轮询），
 *   刷新即归零 —— 典型的**累积泄漏**。
 *
 * 这个清扫是幂等的、按 VIEW_ATTR 精确限定在"本插件自己的容器"上：
 * 本轮马上要重建全新容器，所以此刻凡是存在的本插件容器，一定都是历史残留。
 * 摘掉容器虽然不会跑 React 的卸载流程，但根从此失去 DOM、定时器也随之失去意义；
 * 真正的卸载交给 `cleanup()` 里新加的 `officialRoot?.unmount()`。
 */
function sweepLeakedContainers(): void {
  const stale = document.querySelectorAll(`[${VIEW_ATTR}]`)
  if (stale.length === 0) return
  for (const node of Array.from(stale)) node.remove()
  traceLifecycle(`清扫残留容器 ×${stale.length}`)
  console.warn(`[workbench] 已清扫 ${stale.length} 个历史残留的工作台容器（上一轮未完成卸载）`)
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

/** 从运行时快照判断 DSH 跑在 WSL 还是原生 Windows（用于路径形态选择）。 */
function detectWslHost(runtime: WorkbenchRuntime): boolean {
  const hostHome = safeService<WorkbenchRuntime['connection']>(runtime, 'connection')?.generation.getSnapshot()?.host.home
  if (hostHome !== undefined) return isWslStylePath(hostHome)
  const items = safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.list.getSnapshot().items ?? []
  return items.some((item) => typeof item.path === 'string' && isWslStylePath(item.path))
}

/** 已打开的工作区路径列表（快速录入的工作区候选之一，去重由调用方做）。 */
function openWorkspacePaths(runtime: WorkbenchRuntime): string[] {
  return (safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.list.getSnapshot().items ?? [])
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
  const active = hostPanelId !== undefined
    ? hostPanelId === PANEL_NAME
    : workbench.isHostSelected?.() ?? workbench.isOpen()
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
 * 官方侧栏面板行里的图标（`sidebar.panellist`，kind=list、scope=root）。
 *
 * 行按钮、Tooltip、`aria-label`、`aria-current="page"`、行高与折叠态圆形
 * **全部由宿主 `PanelRow` 渲染** —— 本组件只负责图标本身，这正是不再需要
 * 自己往侧栏 DOM 里注入 `<button>` + 硬编码尺寸的原因。
 */
function WorkbenchPanelIcon({ size }: PanelIconProps): JSX.Element {
  return <Icon name="today" size={size} />
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
  traceLifecycle('apply 进入')
  disposePreviousInstance()
  // 兜底：清扫更早几轮留下的孤儿容器（`activeDisposer` 只记最后一轮，见函数注释）。
  sweepLeakedContainers()
  instanceAlive = true

  let open = false
  ensureStyle()

  /**
   * 是否**确认**走官方槽位路径（可变量，见下方 verifyOfficialPath 的说明）。
   *
   * 初始值只代表"宿主有这个槽位"，**不代表"我们注册成功了"**：注册要等
   * `slots.inject` 的回调执行，回调里还可能抛错；而 `layout.selectPanel(id)`
   * 只校验 main 的注册键、不校验侧栏入口。于是可能出现"面板开不了、会话列却已经让位"
   * 的空白屏（2026-09-12 用户实测，且回不去）。
   */
  let officialConfirmed = false
  /** 清理幂等标记：`disposePreviousInstance()` 与 cordis 都可能调用清理。 */
  let disposed = false
  /** 自愈复核窗口内的进度（见 verifyOfficialPath）。 */
  let verifyAttempts = 0
  let verifySettled = false
  const officialDisposers: Array<() => void> = []
  /** 承载 App 的容器：**始终只有一个**（官方 main 或自建覆盖层）。 */
  let activeHost: HTMLElement | undefined
  /**
   * 自建覆盖层（DOM 腿 + 官方路径失效时的兜底）。
   *
   * 这三个变量**提前声明**：`mountOverlayContent()` 在 setOpen 里就要能调用，
   * 而它的实体在文件更下方的"DOM 降级腿"一节里创建。
   */
  let overlayView: HTMLDivElement | undefined
  let overlayRoot: Root | undefined
  let overlayMounted = false
  /**
   * 官方 `main` 槽位那个 React 根。
   *
   * **必须持有**：`createRoot()` 的返回值一旦丢弃，这个根就再也拿不到 ——
   * 既不能 `unmount()`，App 里的 5 秒草稿轮询也就永远不会 `clearInterval`。
   * 2026-09-12/13 的实测症状：反复打开面板/切会话后，页面上累积了约 10 份
   * 各跑各的轮询（12 秒 24 次请求），草稿弹窗随之叠成多层、要连点多次才关得掉；
   * 硬刷新归零（干净加载实测 30 秒 6 次 = 1 份轮询），下次操作又重新累积。
   */
  let officialRoot: Root | undefined

  /**
   * 挂载官方 `main` 面板的内容（由注册给宿主的组件 ref 回调调用）。
   *
   * 用 ref 回调而非 hooks：让注册给宿主的组件保持**无 hooks 的稳定函数**，
   * 否则每次 apply 生成新组件类型，宿主重渲染时会整块卸载重挂。
   *
   * 这里再确认一次 `officialConfirmed`：自愈可能已把路径切成 DOM 腿，
   * 那种情况下官方容器必须留空（内容在覆盖层），否则就是两份 App 互相打架。
   */
  const mountPanelContent = (node: HTMLDivElement | null): void => {
    if (node === null || !officialConfirmed) return
    /**
     * **portal 式单根（v1.14.8）**。
     *
     * 前两版的教训：
     * - v1.14.4 及更早：守卫用 `node.dataset.mounted`（**元素级**），宿主换新节点就
     *   再 `createRoot` 一个 —— 探针实测 `apply()` 只进 1 次、挂载 8 次、**存活实例 7**。
     * - v1.14.7：改成实例级单根（卸载旧根再挂新根），存活实例稳住了，但暴露出宿主
     *   **在持续重挂容器**（实测 30 秒内 mount/unmount 交替 10 轮）——每轮重建 App，
     *   5 秒轮询被不断"重启"，请求频率被重挂频率支配；`open` 状态每轮清零，
     *   这正是"按钮点两次、第一次变绿但面板不开"的来源。
     *
     * 所以正确解法不是"更快地重建"，而是**让 App 活过宿主的重挂**：
     * 根挂在一个**自建的固定宿主元素**上（只建一次），再用 `createPortal`
     * 把 App 搬进宿主容器；宿主换节点时只换 portal 目标（`portalTarget`），
     * React 树本身**不卸载** —— `open` 状态、5 秒轮询、选中任务等全部保持。
     */
    const firstMount = officialRoot === undefined
    let root = officialRoot
    if (root === undefined) {
      const host = document.createElement('div')
      host.className = 'wb-panel-host'
      /**
       * **必须带 `VIEW_ATTR`（2026-09-13 实测事故）**。
       *
       * 工作台的全部样式都写成 `[data-dsh-personal-workbench-view] .xxx { … }`，
       * 这个属性就是样式的唯一入口。v1.14.8 改成 portal 宿主时漏了这一行，
       * 后果是官方路径下**整张样式表都不生效**：容量条失去 `display:flex` / `height:9px`
       * 与内部色块宽度（表现为"容量条没渲染"），统计卡、任务行也只能靠浏览器默认样式。
       * 属性打在**承载 portal 的宿主元素**上即可 —— CSS 只看祖先链，与技术上的可见性无关。
       */
      host.setAttribute(VIEW_ATTR, '')
      root = createRoot(host)
      officialRoot = root
      activeHost = host
      liveInstanceCount += 1
    } else if (portalTarget === node) {
      return
    } else {
      traceLifecycle('宿主换新容器，App 未重建 · 新节点 ' + describeNode(node))
    }
    portalTarget = node
    root.render(
      <OfficialPanelMount target={portalTarget}>
        <WorkbenchApp runtime={runtime} closePanel={() => setOpen(false)} />
      </OfficialPanelMount>,
    )
    if (firstMount) traceLifecycle('官方主面板根已建立（portal 宿主）')
  }

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
  const officialDecision = officialSlotDecision(slots, selectPanel)
  /** 宿主的槽位能力齐备（还要等自愈复核注册结果，才把 officialConfirmed 置真）。 */
  const officialSlotCapable = officialDecision.useOfficial
  if (!officialSlotCapable) {
    console.info(`[workbench] 使用 DOM 入口（${officialDecision.reason}）`)
  }

  /**
   * 家族互斥：把 documentElement 上「别人的面板激活标记」摘掉，再亮自己。
   *
   * 兄弟插件（dsh-ssh / task-board / dsh-mnemon …）的协调逻辑各自硬编码对方名字，
   * 靠广播 `dsh-panel-activate` 或彼此摘属性来互斥。本插件无法保证对方认识
   * `personal-workbench` 这个 detail（dsh-mnemon 0.5.7 的 onActivate 只认
   * taskboard / ssh），所以这里既广播通用事件、也主动摘掉对方的激活标记：
   * 只要属性名符合 `data-dsh-<pkg>-active` 就是对方的面板标记。
   */
  const retractSiblingPanels = (): void => {
    const root = document.documentElement
    for (const name of root.getAttributeNames()) {
      if (name === ACTIVE_ATTR || !name.startsWith('data-dsh-') || !name.endsWith('-active')) continue
      root.removeAttribute(name)
    }
  }
  /**
   * 面板显示门控：有别人的面板开着时，本插件自己的面板让位。
   *
   * 时序说明——「本插件先开、别人后开」不会触发本插件的 activate 监听（对方不广播），
   * 也没有点击可听，只能靠属性观察；因此这里把判定结果落到 documentElement 上，
   * 由 CSS 的 `:not([blocked])` 门控，避免样式里逐个 `:not([data-dsh-xxx-active])`
   * 硬编码兄弟插件名（漏一个就是 issue #3 的现象 1）。
   */
  const syncPanelBlocked = (): void => {
    const root = document.documentElement
    if (isSiblingPanelActive(root.getAttributeNames())) root.setAttribute(BLOCKED_ATTR, '')
    else root.removeAttribute(BLOCKED_ATTR)
  }
  /**
   * 撤销官方注册并回退 DOM 腿。幂等，可在任何时候调用。
   *
   * 必须真的撤销注册：留着"半个注册"会让宿主认为这个面板存在
   * （`layout.selectPanel` 会成功），但侧栏没有入口 —— 用户既打不开也回不去。
   */
  const fallbackToDomLeg = (reason: string): void => {
    officialConfirmed = false
    document.documentElement.removeAttribute(OFFICIAL_ATTR)
    for (const dispose of officialDisposers.splice(0)) {
      try { dispose() } catch { /* 撤销失败也要继续，别把回退本身卡住 */ }
    }
    console.warn(`[workbench] 官方槽位路径不可用，已回退 DOM 入口：${reason}`)
    traceLifecycle(`回退 DOM 腿（${reason.slice(0, 40)}）`)
  }

  /**
   * 自愈复核：注册表 + DOM 两侧都有证据才算确认，否则回退 DOM 腿。
   *
   * 为什么必须要这一步：判定"宿主有这个槽位"和确认"我们注册进去了"是两件事，
   * 中间隔着 inject 回调时序与 register 抛错。只做前者就会出现
   * 「探测通过 → 期望面板在官方容器里 → 实际什么都没渲染 → 整片空白」。
   *
   * 复核窗口用**时间**而不是调用次数：DOM 观察在页面启动时会连续触发很多次，
   * 按次数计数会在几毫秒内把 6 次用完，而宿主侧栏可能几百毫秒后才渲染。
   */
  const VERIFY_WINDOW_MS = 4000
  const VERIFY_MIN_ATTEMPTS = 3
  const verifyStartedAt = Date.now()
  const verifyOfficialPath = (): void => {
    if (verifySettled || !officialSlotCapable || officialDisposers.length === 0) return
    verifyAttempts += 1
    const verdict = officialPathConfirmed(slots, PANEL_NAME, document, ENTRY_TITLE)
    if (verdict.confirmed) {
      verifySettled = true
      officialConfirmed = true
      document.documentElement.setAttribute(OFFICIAL_ATTR, '')
      syncEntryVisibility()
      console.info('[workbench] 已启用官方侧栏槽位 sidebar.panellist + main')
      return
    }
    if (Date.now() - verifyStartedAt >= VERIFY_WINDOW_MS) {
      verifySettled = true
      fallbackToDomLeg(verdict.reason)
      syncEntryVisibility()
      mountOverlayContent()
    }
  }

  /**
   * 把 App 挂到自建覆盖层（DOM 腿 / 兜底路径）。
   * 只在**没有**确认走官方路径、且覆盖层尚未承载 App 时执行，保证全局只有一个实例。
   */
  const mountOverlayContent = (): void => {
    if (officialConfirmed || overlayMounted || overlayView === undefined || overlayRoot === undefined) return
    overlayMounted = true
    activeHost = overlayView
    overlayRoot.render(<WorkbenchApp runtime={runtime} closePanel={() => setOpen(false)} />)
    liveInstanceCount += 1
    traceLifecycle('挂载 DOM 覆盖层')
  }

  /**
   * 宿主当前是否真的选中本插件面板（`layout.activePanelId === PANEL_NAME`）。
   *
   * 为什么不能只信本地 `open` 标志：用户"从会话页进入工作台 → 返回会话"时，
   * 宿主已经把面板切走了，但本地 `open` 仍是 `true`（订阅在部分宿主形态下拿不到
   * 通知）。此时点击标题栏按钮走的是 `toggle(open)` → 第一次执行的是**关闭**
   * （关一个本来就关着的面板，看起来"点了没反应"），**第二次才真正打开**。
   * 2026-09-13 用户实测描述的"再进工作台要点两次"正是这个。
   *
   * 只读、不产生副作用；拿不到宿主状态时返回 `undefined`，由调用方退回本地标志。
   */
  const hostPanelOpen = (): boolean | undefined => {
    try {
      const candidate = layout as unknown as { getSnapshot?: () => { activePanelId?: unknown } }
      const snapshot = candidate?.getSnapshot?.()
      if (snapshot !== undefined && snapshot !== null && 'activePanelId' in snapshot) {
        return snapshot.activePanelId === PANEL_NAME
      }
    } catch { /* 宿主形态未知，退回本地标志 */ }
    return undefined
  }

  const setOpen = (value: boolean): void => {
    if (officialConfirmed) {
      /**
       * 官方路径：**唯一的开关是 `layout.selectPanel`**（宿主单值状态）。
       *
       * 不在这里摘兄弟插件的 `*-active`，互斥由宿主保证；但 ACTIVE_ATTR 仍要维护，
       * 因为 CSS 门控与标题栏按钮高亮都读它。
       * `selectPanel` 会校验面板是否注册，抛错就立刻回退 DOM 腿并重试本函数 ——
       * **绝不允许出现"门控开了但没内容"的空白屏**。
       */
      /**
       * **幂等**：宿主已经处于目标状态时，不再调 `selectPanel`、也不改标志。
       *
       * 这是"再进工作台要点两次"的根治：期望值与宿主实际状态一致就直接返回，
       * 本地 `open` 标志顺手纠回真值 —— 按钮的高亮与真实面板状态从此不会再漂。
       */
      const hostNow = hostPanelOpen()
      if (hostNow !== undefined && hostNow === value) {
        open = value
        if (value) document.documentElement.setAttribute(ACTIVE_ATTR, '')
        else document.documentElement.removeAttribute(ACTIVE_ATTR)
        syncEntryVisibility?.()
        return
      }
      try {
        selectPanel?.(value ? PANEL_NAME : null)
      } catch (error) {
        fallbackToDomLeg(`layout.selectPanel 调用失败：${error instanceof Error ? error.message : String(error)}`)
        setOpen(value)
        return
      }
      open = value
      if (value) document.documentElement.setAttribute(ACTIVE_ATTR, '')
      else document.documentElement.removeAttribute(ACTIVE_ATTR)
      return
    }
    // ---- DOM 腿（同时是官方路径不可用时的兜底）----
    open = value
    if (open) {
      retractSiblingPanels()
      syncPanelBlocked()
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
      mountOverlayContent()
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
      document.documentElement.removeAttribute(BLOCKED_ATTR)
    }
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
        open = info?.activePanelId === PANEL_NAME
        // 按钮高亮与 CSS 门控都读 ACTIVE_ATTR：宿主侧切换面板时必须一起纠回来，
        // 否则会出现"窗口回来了但按钮还是绿的""按钮绿着但面板不开"这类不同步。
        if (open) document.documentElement.setAttribute(ACTIVE_ATTR, '')
        else document.documentElement.removeAttribute(ACTIVE_ATTR)
        syncEntryVisibility()
        listener()
      })
      return typeof dispose === 'function' ? dispose : () => {}
    } catch { return () => {} }
  }
  const hostSelected = (): boolean => {
    const candidate = layout as unknown as { getSnapshot?: () => { activePanelId?: unknown } }
    try {
      const snapshot = candidate.getSnapshot?.()
      if (snapshot !== undefined && 'activePanelId' in snapshot) return snapshot.activePanelId === PANEL_NAME
    } catch { /* 读不到就退回本地标志 */ }
    return open
  }

  const slotApi: WorkbenchSlotApi = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    /**
     * 目标状态取**宿主真值**（`hostSelected()`),本地标志只作兜底。
     *
     * 曾经这里是 `setOpen(!open)` —— 本地标志漂了就会"第一次点击变成关闭"，
     * 用户看到的现象就是"再进工作台要点两次"（2026-09-13 实测）。
     */
    toggle: () => setOpen(!hostSelected()),
    isOpen: () => hostSelected() || open,
    subscribe: subscribePanelInfo,
    isHostSelected: hostSelected,
  }
  if (slots !== undefined) {
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
     * v1.14.0 主迁移：侧栏入口走官方 `sidebar.panellist`，面板内容走官方 `main`。
     *
     * 为什么原来那套要退场：社区约定靠「各方硬编码对方包名 + 互摘 `data-dsh-<pkg>-active`」
     * 模拟互斥，家族每加一个成员所有老成员都得改一遍，漏一个就是两个面板同时打开。
     * 官方槽位把这件事变成宿主的 `activePanelId` 单值状态。
     *
     * **disposer 必须留着**：自愈判定失败时要把注册撤掉 —— 留着"半个注册"会让
     * `layout.selectPanel` 成功但侧栏没有入口，用户既打不开也回不去。
     */
    if (officialSlotCapable) {
      try {
        const disposeList = slots.inject(OFFICIAL_PANEL_LIST_SLOT, () => slots.register(
          { name: OFFICIAL_PANEL_LIST_SLOT, id: PANEL_NAME, order: -4, label: ENTRY_TITLE },
          // 宿主把 owner props（size/active）与全局 props 一起传下来；本插件只用 size，
          // active 由宿主 PanelRow 自己用于 aria-current 与高亮，不需要我们参与。
          ((props: Record<string, unknown>) => (
            <WorkbenchPanelIcon size={typeof props.size === 'number' ? props.size : 18} />
          )),
        ))
        if (typeof disposeList === 'function') officialDisposers.push(disposeList)
        const disposeMain = slots.inject(OFFICIAL_MAIN_SLOT, () => slots.register(
          // key 必填且必须与侧栏入口 id 同值 —— 宿主据此把「选中的入口」映射到「渲染哪个面板」。
          { name: OFFICIAL_MAIN_SLOT, id: PANEL_NAME, key: PANEL_NAME, order: -4 },
          /**
           * **`VIEW_ATTR` 必须打在这个元素上（2026-09-13 实测事故）**。
           *
           * 它是**唯一处于活 DOM 中**的 `.wb-panel-host`，也是 portal 的落点 ——
           * App 的全部 DOM 都是它的后代。而工作台的整套样式（`styles.ts`，94 处选择器）
           * 都写成 `[data-dsh-personal-workbench-view] .xxx { … }`：这个属性就是样式的
           * **唯一入口**，缺了它对整张样式表都不生效。实测表现就是"容量条没渲染"
           * ——其实是它失去了 `display:flex` 与内部色块宽度。
           *
           * 别和 `mountPanelContent()` 里那个自建 portal 宿主搞混：那个元素**脱离 DOM**，
           * 属性打在那儿对 CSS 毫无作用（第一次修复正是打错在那里，所以"没生效"）。
           */
          (() => (
            <div
              className="wb-panel-host"
              {...{ [VIEW_ATTR]: '' }}
              ref={(node: HTMLDivElement | null) => mountPanelContent(node)}
            />
          )),
        ))
        if (typeof disposeMain === 'function') officialDisposers.push(disposeMain)
      } catch (error) {
        console.warn('[workbench] official slot registration failed, falling back to DOM entry:', String(error))
      }
    }
  }

  // ---------------------------------------------------------------- DOM 降级腿
  /**
   * 旧宿主（没有官方槽位 / 布局服务）的降级路径：往侧栏 DOM 注入入口行 + 覆盖式面板。
   *
   * **这条腿是正式支持的路径，不是临时兼容**：能撑起 DOM 契约的宿主（如 DSH 0.1.1-rc.1）
   * 在社区里仍然存在，删掉它会让那些机器上的工作台直接不可用。契约与格式驱动的互斥
   * 判定都在 `entryContract.ts`（有 11 项不变量测试锁住）。
   */

  // 家族契约（见 entryContract.ts）：行标识 + 语义属性 + 三段式结构 + aria-label/title。
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.className = ENTRY_CLASS
  entry.setAttribute(ENTRY_ATTR, '')
  entry.setAttribute(ENTRY_PLUGIN_ATTR, ENTRY_PLUGIN_ID)
  entry.setAttribute(ENTRY_PART_ATTR, ENTRY_PART_VALUE)
  entry.setAttribute('aria-label', ENTRY_TITLE)
  entry.setAttribute('title', ENTRY_TITLE)
  entry.innerHTML = ENTRY_HTML
  entry.addEventListener('click', () => { setOpen(!open) })
  const syncEntry = (): void => { if (open) entry.dataset.active = 'true'; else delete entry.dataset.active }
  /**
   * 折叠态要**跟着宿主实时变**：DSH 的折叠/展开只改 frame 上的属性（`data-sidebar-collapsed`）
   * 与侧栏根的类名，不重建 DOM —— 只用 childList 的 placeEntry 是跟不上的
   * （placeEntry 在 placed 时直接 return）。所以这里连 `data-sidebar-collapsed`
   * 的属性变化一起听（该属性可能挂在 documentElement 或 frame 上，两处都在观察范围内生效）。
   *
   * `syncCollapsed` 用函数声明（下方定义）：声明提升让观察回调能引用它，而它自己在
   * 被调用时才读 rootEl，因此不存在「先观察后赋值」的时序问题。
   */
  const entryObserver = new MutationObserver(() => { syncEntry(); syncCollapsed() })
  entryObserver.observe(document.documentElement, { attributes: true, attributeFilter: [ACTIVE_ATTR, SIDEBAR_COLLAPSED_ATTR] })
  entryObserver.observe(document.body, { attributes: true, subtree: true, attributeFilter: [SIDEBAR_COLLAPSED_ATTR] })
  syncEntry()

  /**
   * 覆盖层视图节点：**永远创建、永远插进会话列**，但只有在"没确认走官方路径"时才
   * 渲染 App 且被 CSS 放行（见 styles.ts 的 OFFICIAL_ATTR 门控）。
   *
   * 为什么必须常备：2026-09-12 的空白屏事故里，官方注册中途失败时原先的实现
   * 既没有覆盖层、门控却已经生效，界面直接空白且无法恢复。
   * 兜底那一路常备之后，最坏情况是"看起来像迁移前"，而不是"什么都看不到"。
   */
  const view = document.createElement('div')
  view.setAttribute(VIEW_ATTR, '')
  overlayView = view
  overlayRoot = createRoot(view)

  let rootEl: HTMLElement | undefined
  let placed = false
  let column: HTMLElement | undefined

  /**
   * 把宿主的折叠态带到本插件这一行，并标出「谁是侧栏」。
   *
   * 宿主把折叠标记写在 frame 元素上（`data-sidebar-collapsed`，DSH 0.1.5 的
   * `dsh-client-ui-layout` AppFrame）；本插件的行插在侧栏列里，是 frame 的后代。
   * 这里顺手把它标到侧栏根节点上：这样样式里的折叠态不再依赖 `[data-dsh-frame]`
   * ——那个属性宿主根本没有，旧写法是永不命中的死代码。
   */
  function syncCollapsed(): void {
    if (rootEl === undefined || !rootEl.isConnected) return
    const frame = rootEl.closest(`[${SIDEBAR_COLLAPSED_ATTR}]`) ?? rootEl.closest('[class*="_frame"]')
    const collapsed = frame !== null
      && (frame.hasAttribute(SIDEBAR_COLLAPSED_ATTR) || matchesCollapsedClass(Array.from(frame.classList)))
    if (collapsed) rootEl.setAttribute(SIDEBAR_COLLAPSED_ATTR, '')
    else rootEl.removeAttribute(SIDEBAR_COLLAPSED_ATTR)
  }

  /**
   * 把入口行放进侧栏。
   *
   * **不再按官方判定提前跳过**：那一跳正是空白屏事故的一环 ——
   * 判定说"走官方"，于是这行不插；结果官方注册没成 → 入口根本不存在。
   * 现在总是准备好这一行，仅在被**确认**走官方路径时隐藏它
   * （见 syncEntryVisibility）。最坏也只是多一个隐藏按钮，比没有入口好得多。
   */
  const placeEntry = (): void => {
    if (rootEl !== undefined && !rootEl.isConnected) { rootEl = undefined; placed = false }
    if (placed) { if (document.body.contains(entry)) return; placed = false }
    rootEl ??= sidebarRoot()
    if (rootEl === undefined) return
    const button = newSessionButton(rootEl)
    if (button === undefined) return
    if (entry.parentElement !== rootEl) {
      const row = button.closest('[class*="logoRow"]')
      const base = row !== null && row.parentElement === rootEl ? row : button
      // 锚点固定：紧跟 logoRow（其内是 New Session 行）之后。
      // 旧实现拿「家族入口的第一行」当锚（`insertBefore(entry, family[0])`），位置取决于
      // 兄弟插件谁先渲染、顺序不稳；issue #3 的建议本身就是用固定锚点 + 家族统一形态。
      const anchor = base.nextElementSibling
      rootEl.insertBefore(entry, anchor)
      syncCollapsed()
    }
    placed = true
  }
  /** 官方确认可用时把自建入口行藏掉，避免侧栏出现两个「工作台」入口。 */
  const syncEntryVisibility = (): void => {
    if (officialConfirmed) entry.style.display = 'none'
    else entry.style.removeProperty('display')
  }
  const placeView = (): void => {
    column ??= conversationColumn()
    if (column !== undefined && !column.contains(view)) column.appendChild(view)
  }
  const watcher = new MutationObserver(() => {
    placeEntry(); placeView(); syncEntryVisibility()
    // 宿主侧栏常常晚于插件加载才渲染，所以自愈复核也挂在 DOM 观察上（不只靠定时器）。
    if (!verifySettled) verifyOfficialPath()
  })
  watcher.observe(document.body, { childList: true, subtree: true })
  placeEntry(); placeView()

  const onOtherActivate = (event: Event): void => {
    if (officialConfirmed) return
    if ((event as CustomEvent).detail !== PANEL_NAME && open) setOpen(false)
  }
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (officialConfirmed || !open) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    // 家族入口行用同一套属性识别（原来只列 session/project/search/newSession —— 正好是
    // dsh-mnemon 的 SIDEBAR_CONTEXT_SELECTOR 抄漏本插件属性的镜像问题）。
    if (target.closest(`[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"], ${SIDEBAR_ENTRY_SELECTOR}`) !== null) setOpen(false)
  }
  /**
   * 别人的面板标记变化时重新判定门控：对方很多实现只设自己的 `*-active`
   * （不一定广播 detail），这条观察负责兜住「本插件先开、对方后开」的时序。
   * 官方路径下不需要 —— 门控由宿主的 `activePanelId` 负责。
   */
  const siblingObserver = new MutationObserver(() => { if (!officialConfirmed) syncPanelBlocked() })
  siblingObserver.observe(document.documentElement, { attributes: true, attributeFilter: siblingActiveFilter() })
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  document.addEventListener('click', onClickSidebarRow, true)

  /**
   * 自愈复核的三个定时点 + 收口点。
   *
   * 主触发是上面的 DOM 观察（宿主侧栏后渲染时最准）；定时器覆盖
   * "宿主早已渲染完、观察不再触发"的情况（例如插件热重载时页面已稳定）。
   */
  const verifyTimers = [
    window.setTimeout(() => verifyOfficialPath(), 300),
    window.setTimeout(() => verifyOfficialPath(), 1200),
    window.setTimeout(() => verifyOfficialPath(), 2600),
  ]
  /** 复核窗口结束后收口一次：入口可见性与兜底路径对齐（绝不留下半开状态）。 */
  const settleTimer = window.setTimeout(() => {
    verifyOfficialPath()
    if (verifyAttempts < VERIFY_MIN_ATTEMPTS) verifyOfficialPath()
    // 仍未确认就强制回退：宁可回到迁移前那套（能用），也不留"面板打不开"的空白屏。
    if (!officialConfirmed && !verifySettled) fallbackToDomLeg('复核窗口内未取得注册证据')
    syncEntryVisibility()
    if (!officialConfirmed) mountOverlayContent()
    verifySettled = true
  }, VERIFY_WINDOW_MS + 200)

  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    /**
     * **第一步**就卸 React 根，早于任何可能抛错的操作。
     *
     * `unmount()` 对"没渲染过"的 root 是无害 no-op（React 18 只在真正卸载时告警），
     * 但漏掉一次就会留下一个**活着**的 App 实例继续轮询、继续弹 Modal ——
     * 那正是"背景一次比一次黑"的成因。所以宁可多调一次。
     *
     * 官方 `main` 槽位那条腿的根原先**没有被持有**，于是它的 `unmount()` 从来没发生过：
     * 每次面板重建都多留一份 App（各自 5 秒轮询草稿），累积到十几份时页面就崩坏 ——
     * 这就是 2026-09-13 实测"硬刷新后 30 秒 6 次请求、操作一段时间后 12 秒 24 次"的来源。
     *
     * 放在最前面还有个理由：清理中途一旦抛错（观察器/宿主状态异常都可能），
     * 排在后面的步骤就整段被跳过，而"没卸载的根"恰恰是这里后果最重的一步。
     */
    try { overlayRoot?.unmount() } catch { /* 已卸载 */ }
    try { officialRoot?.unmount() } catch { /* 已卸载 */ }
    overlayRoot = undefined
    officialRoot = undefined
    portalTarget = undefined
    overlayMounted = false
    if (liveInstanceCount > 0) liveInstanceCount -= 1
    traceLifecycle('cleanup 已拆本轮')
    instanceAlive = false
    watcher.disconnect(); entryObserver.disconnect(); siblingObserver.disconnect()
    for (const timer of verifyTimers) window.clearTimeout(timer)
    window.clearTimeout(settleTimer)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    document.removeEventListener('click', onClickSidebarRow, true)
    for (const dispose of officialDisposers.splice(0)) {
      try { dispose() } catch { /* 卸载阶段不再纠缠 */ }
    }
    entry.remove()
    view.remove()
    // 官方容器是宿主 slot 容器里的子节点，宿主不会替我们摘；漏掉它就等于留了一份 DOM。
    activeHost?.remove()
    activeHost = undefined
    const html = document.documentElement
    html.removeAttribute(ACTIVE_ATTR); html.removeAttribute(BLOCKED_ATTR); html.removeAttribute(OFFICIAL_ATTR)
    if (rootEl !== undefined) rootEl.removeAttribute(SIDEBAR_COLLAPSED_ATTR)
    if (pluginCtx === ctx) pluginCtx = undefined
    if (activeDisposer === cleanup) activeDisposer = undefined
  }
  // 注册给模块级守卫：下一次 apply() 会先调用它拆掉本轮，避免残留实例。
  activeDisposer = cleanup
  return cleanup
}

