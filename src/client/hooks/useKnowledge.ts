/**
 * 知识域（D17 / P1）—— `index.tsx` 里知识库相关的**唯一所有者**。
 *
 * 从入口拆出来的东西（一一对应，没有第二份实现）：
 * - state：条目 / 筛选 / 选中 / 编辑态 / 刷新键 / 本地文档弹窗五件套；
 * - 本地存储读写（`readKnowledgeFilters` / `writeKnowledgeFilters`，原先在入口文件顶层）；
 * - effect：进入知识视图时按 `refreshKey` 重新拉一次、筛选落盘、字典到齐后校正分类；
 * - 动作：`reload` / `updateFilters` / 文件选择五件套 / `openKnowledgeFile`。
 *
 * ⚠️ 依赖方向（设计 §3）：本文件是**纯 .ts**（不写 JSX，视图在 `views/` 里），
 * 只 import 纯模块与共享契约，**不得** import `index.tsx`；跨域协作由入口注入类型化回调。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import {
  EMPTY_KNOWLEDGE_FILTERS, reconcileKnowledgeKinds, selectedKind,
  type KnowledgeFilters,
} from '../components/KnowledgeList.js'
import { localDirRequestUrl } from '../localDirBrowser.js'
import {
  buildListPage, DEFAULT_SORT_DIR, normalizePageSize, normalizeSortDir, normalizeSortKey, toContentItem,
  type ContentItem, type ListPage,
} from '../listPresentation.js'
import { clientFileLinkToPath } from '../format.js'
import { safeService } from '../runtimeServices.js'
import type { LocalDirEntry, LocalDirListing } from '../components/LocalDocModal.js'
import type { Dict, KnowledgeEntry, Task, WorkbenchRuntime } from '../viewTypes.js'
import type { PersonaSelection } from '../personaPicker.js'
import type { QuickAttachmentDraft } from '../quickAttachments.js'

/** 知识库列表状态在 localStorage 里的键（原样保留：换键会让用户的选择凭空消失）。 */
const KNOWLEDGE_FILTER_STORAGE_KEY = 'dsh.personal-workbench.knowledgeList'

/** 右侧详情的编辑态（新建/编辑表单的字段，与拆分前逐字一致）。 */
export interface KnowledgeDraft {
  title: string
  contentMd: string
  kindCode: string
  tags: string
  sourceTaskId: string
  sourceReviewId: string
  fileLink: string
}

/**
 * 文件选择弹窗里的一条。
 *
 * 直接用 `LocalDocModal` 的 `LocalDirEntry`（而不是自己再声明一份三字段的子形状）：
 * 拆分前入口写的是内联结构类型，这里收紧成同一份命名类型 —— 形状完全一致，
 * 但少一处"同一语义两处声明"。
 */
export type LocalFileEntry = LocalDirEntry

/**
 * 读回知识库列表状态。
 *
 * 存储里的值**一律不可信**（分类可能被删、排序键可能改过、JSON 可能被手改）。
 * ⚠️ 分类的合法性**必须拿到字典后才能判**（字典是异步来的），所以这里只做"形状"归一化，
 * 真正"这个分类还在不在"由 `useEffect` 里的 `reconcileKnowledgeKinds` 收口 —— 否则删过分类的用户
 * 下次打开会看到**空列表且没有任何 Tab 高亮**（v1.15.2 复审 F3）。
 * localStorage 不可用（隐私模式）时静默降级为默认值。
 */
function readKnowledgeFilters(): KnowledgeFilters {
  try {
    const raw = localStorage.getItem(KNOWLEDGE_FILTER_STORAGE_KEY)
    if (raw === null) return EMPTY_KNOWLEDGE_FILTERS
    const saved = JSON.parse(raw) as Record<string, unknown>
    const kinds = Array.isArray(saved.kinds) && saved.kinds.every((k) => typeof k === 'string') && saved.kinds.length > 0
      ? saved.kinds as string[]
      : ['all']
    const tags = Array.isArray(saved.tags) ? saved.tags.filter((t): t is string => typeof t === 'string') : []
    const sortKey = normalizeSortKey(saved.sortKey)
    return {
      keyword: '',
      kinds,
      tags,
      sortKey,
      sortDir: saved.sortDir === undefined ? DEFAULT_SORT_DIR : normalizeSortDir(saved.sortDir),
      page: 0,
      pageSize: normalizePageSize(saved.pageSize),
    }
  } catch {
    return EMPTY_KNOWLEDGE_FILTERS
  }
}

/** 只写"要在刷新后保持"的字段：关键词与页码是瞬时意图，不落盘。 */
function writeKnowledgeFilters(filters: KnowledgeFilters): void {
  try {
    localStorage.setItem(KNOWLEDGE_FILTER_STORAGE_KEY, JSON.stringify({
      kinds: filters.kinds,
      tags: filters.tags,
      sortKey: filters.sortKey,
      sortDir: filters.sortDir,
      pageSize: filters.pageSize,
    }))
  } catch { /* localStorage 不可用时静默降级：状态只在本次会话内有效 */ }
}

/**
 * 按 kind 取字典的函数签名。
 *
 * 只收窄到本包**已用到的 kind 取值**：入口的 `dictOf` 是 `(kind: string) => Dict[]`，
 * 传进来天然兼容；视图里写错 kind（例如 `dictOf('knowledge_king')`）会在 `pnpm typecheck` 当场变红，
 * 而不是静默画出空下拉。
 */
export type KnowledgeKind = 'knowledge_kind' | 'idea_kind' | 'type' | 'priority' | 'status' | 'ai_policy' | 'recurrence' | 'session_role'
export type KnowledgeDictFn = (kind: KnowledgeKind) => Dict[]

/**
 * 发起 AI 会话的签名。
 *
 * ⚠️ 单独抽出来是为了给下面的 ref 型入参用：`startAISession` 在入口里是组件中部的 `const`，
 * 没有提升，所以入口传的是 `useRef` 出来的**惰性转发 ref**（在函数定义之后才写入 `current`）。
 *
 * mode 覆盖全部十个入口（设计 §6.2）：知识域只用 `knowledge_doc`，点子域用
 * `idea_association` / `idea_brainstorm`，本类型收的是**完整** mode 集合 ——
 * 收窄成单值会让兄弟域的视图直接 typecheck 失败（P2 实测）。
 */
export type AISessionMode =
  | 'clarify' | 'consult' | 'breakdown' | 'execute' | 'review'
  | 'plan' | 'report' | 'idea_association' | 'idea_brainstorm' | 'knowledge_doc'

export type StartAISessionFn = (
  mode: AISessionMode,
  task: Task | null,
  text: string,
  previousSessions?: Array<Record<string, unknown>>,
  docContext?: { fileLink: string; content: string; name?: string; truncated?: boolean },
  workspaceOverride?: string,
  clarifyOptions?: { attachments?: readonly QuickAttachmentDraft[]; followFolder?: boolean; persona?: PersonaSelection },
) => Promise<void>

export interface UseKnowledgeInput {
  /** 当前视图：进入 `knowledge` 时才拉数据（与拆分前同一门控）。 */
  activeView: string
  /** 按 kind 取字典（来自任务域的只读派生）。 */
  dictOf: KnowledgeDictFn
  /** 共享的忙碌标志（原样读写，属于 AI 会话域）。 */
  busy: boolean
  setBusy: (value: boolean) => void
  runtime: WorkbenchRuntime
  /** 面板已关闭后不再写状态（原 `instanceAlive` 的语义）。 */
  isAlive: () => boolean
  /**
   * 发起 AI 会话的**惰性转发 ref**（不是函数本身）。
   *
   * 入口在 `startAISession` 定义之后写下 `ref.current = startAISession`；本 hook 只在真实发会话时解引用。
   */
  startAISession: { current: StartAISessionFn | null }
  /** 入口的 `setError`：本域会写 `null` 来清掉上一条提示，所以必须收 `string | null`。 */
  setError: (message: string | null) => void
  /** 同上（`setNotice`）。 */
  setNotice: (message: string | null) => void
}

export interface KnowledgeFilePicker {
  path: string
  setPath: (path: string) => void
  open: boolean
  listing: LocalDirListing | null
  loading: boolean
  error: string | null
  openPicker: () => void
  close: () => void
  loadDir: (path?: string | null) => Promise<void>
  pickFile: (entry: LocalFileEntry) => void
  pickAndSummarize: (entry: LocalFileEntry) => void
  /** 直接总结某条路径（不传则用输入框里的值）。 */
  summarize: (pathOverride?: string) => Promise<void>
}

export interface UseKnowledgeResult {
  /** 列表快照与派生（判定全在纯模块 `listPresentation.ts` 里）。 */
  entries: KnowledgeEntry[]
  filters: KnowledgeFilters
  page: ListPage<ContentItem>
  dicts: Dict[]
  /** 当前选中的分类 Tab。 */
  currentKind: string
  /** 右侧详情：选中的条目与它的编辑态。 */
  selected: KnowledgeEntry | null
  draft: KnowledgeDraft | null
  editId: string | null
  /**
   * setter：跨域入口（任务详情「✅ 已沉淀，打开知识条目」）用它跳到某条知识。
   * 视图内部一律用 `openEntry` / `startCreate` / `startEdit` / `closeDraft` 这些语义动作。
   */
  setSelected: (entry: KnowledgeEntry | null) => void
  /** 列表刷新键：每次自增触发一次重拉（跨域入口「沉淀为经验」写完后调 `bumpRefreshKey`）。 */
  refreshKey: number
  bumpRefreshKey: () => void
  /** 重新拉一次列表（不改变 refreshKey 的语义，供设置页等处按需调用）。 */
  reload: () => Promise<void>
  updateFilters: (patch: Partial<KnowledgeFilters>) => void
  /** 语义动作（视图用，避免在 JSX 里手写"清空选中 + 重置编辑态"这类多步组合）。 */
  openEntry: (entry: KnowledgeEntry) => void
  openEntryById: (id: string) => void
  startCreate: (seed?: Partial<KnowledgeDraft>) => void
  startEdit: (entry: KnowledgeEntry) => void
  /** 改草稿的某个字段（草稿为 null 时原样返回，与拆分前的 `prev === null ? prev : …` 同义）。 */
  patchDraft: (patch: Partial<KnowledgeDraft>) => void
  closeDraft: () => void
  filePicker: KnowledgeFilePicker
  /** 用系统默认程序打开知识条目关联的本地文件。 */
  openKnowledgeFile: (fileLink: string) => Promise<void>
}

export function useKnowledge(input: UseKnowledgeInput): UseKnowledgeResult {
  const { activeView, dictOf, busy, setBusy, runtime, isAlive, startAISession, setError, setNotice } = input

  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  /**
   * 知识库列表的筛选/排序/分页状态。
   *
   * 首屏从 localStorage 读回，保证「刷新 / 重开面板后 Tab 与排序还在」（验收项）。
   * 判定全部交给 `listPresentation.ts`，这里只存状态、不存"哪些条目可见"。
   */
  const [filters, setFilters] = useState<KnowledgeFilters>(() => readKnowledgeFilters())
  const [selected, setSelected] = useState<KnowledgeEntry | null>(null)
  const [draft, setDraft] = useState<KnowledgeDraft | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [localDocPath, setLocalDocPath] = useState('')
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [filePickerListing, setFilePickerListing] = useState<LocalDirListing | null>(null)
  const [filePickerLoading, setFilePickerLoading] = useState(false)
  const [filePickerError, setFilePickerError] = useState<string | null>(null)

  /**
   * 知识库：一次取回后**全部在客户端**搜索/筛选/排序/分页 —— 千级规模下每次敲字都打库是不可接受的。
   */
  const reload = useCallback(async (): Promise<void> => {
    const res = await api<{ entries: KnowledgeEntry[] }>('/api/workbench/knowledge')
    setEntries(res.entries)
  }, [])
  useEffect(() => {
    if (activeView === 'knowledge') void reload().catch(() => undefined)
  }, [activeView, reload, refreshKey])

  const dicts = useMemo(() => dictOf('knowledge_kind'), [dictOf])
  /**
   * 知识库：把「条目 + 筛选状态」交给 `listPresentation.ts` 判定，组件只渲染结果。
   *
   * `now` 每次渲染现取：时间分组（今天/本周/…）本来就要跟着现实时间走，
   * 而"判定输入是显式快照"这条约束要求它是显式传进来的，不是在判定模块里读 `Date.now()`。
   */
  const page = useMemo(() => buildListPage<ContentItem>({
    items: entries.map(toContentItem),
    query: {
      tab: selectedKind(filters),
      keyword: filters.keyword,
      tags: filters.tags,
      sortKey: filters.sortKey,
      sortDir: filters.sortDir,
      page: filters.page,
      pageSize: filters.pageSize,
    },
    now: Date.now(),
    tabOf: (entry) => entry.kindCode,
    tabCodes: dicts.map((d) => d.code),
  }), [entries, filters, dicts])

  /** 唯一的筛选状态入口：改状态。落盘交给下面的 effect —— **不在 setState 更新函数里写存储**。 */
  const updateFilters = useCallback((patch: Partial<KnowledgeFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }))
  }, [])
  /**
   * 持久化 + 分类合法性收口：只在筛选状态真的变化时写。
   *
   * 不写在 `setFilters` 的更新函数里是有原因的：那个函数是**渲染期计算**，
   * React 可以重复调用它（并发渲染 / StrictMode 双调用），副作用放进去就会被执行多次。
   * 放 effect 里既幂等也符合"副作用只在 effect 里"这条项目硬约束。
   */
  useEffect(() => {
    writeKnowledgeFilters(filters)
  }, [filters])
  /**
   * 字典到了之后校正一次存下来的分类（删过分类的用户不该看到"空列表 + 无 Tab 高亮"）。
   * 字典是异步来的，所以这件事只能在 effect 里做，不能在读 localStorage 时做。
   */
  useEffect(() => {
    const fixed = reconcileKnowledgeKinds(filters, dicts.map((d) => d.code))
    if (fixed !== null) setFilters(fixed)
  }, [filters, dicts])

  const summarize = async (pathOverride?: string): Promise<void> => {
    const path = (pathOverride ?? localDocPath).trim()
    if (path === '') {
      setError('请输入本地文档路径')
      return
    }
    setBusy(true); setError(null)
    try {
      const res = await api<{ fileLink: string; content: string; name: string; truncated: boolean }>(`/api/workbench/knowledge/read-local-file?path=${encodeURIComponent(path)}`)
      const start = startAISession.current
      if (start === null) throw new Error('AI 会话入口尚未就绪')
      await start('knowledge_doc', null, res.fileLink, [], { fileLink: res.fileLink, content: res.content, name: res.name, truncated: res.truncated })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const loadDir = async (path?: string | null): Promise<void> => {
    setFilePickerLoading(true); setFilePickerError(null)
    try {
      // `null` = 要看「此电脑」（盘符列表）；不传 = 默认落在主目录。
      // 请求形状的唯一实现在 `localDirBrowser.ts`（工作区的「浏览…」弹窗共用）。
      const res = await api<LocalDirListing>(localDirRequestUrl(path))
      setFilePickerListing(res)
    } catch (e) {
      setFilePickerError(e instanceof Error ? e.message : String(e))
    } finally {
      setFilePickerLoading(false)
    }
  }

  const openPicker = (): void => {
    setFilePickerOpen(true)
    void loadDir()
  }

  const pickFile = (entry: LocalFileEntry): void => {
    if (entry.isDirectory) {
      void loadDir(entry.path)
      return
    }
    setLocalDocPath(entry.path)
    setFilePickerOpen(false)
    setNotice('已选择本地文件，可点击「开始总结」')
  }

  const pickAndSummarize = (entry: LocalFileEntry): void => {
    if (entry.isDirectory) {
      void loadDir(entry.path)
      return
    }
    setLocalDocPath(entry.path)
    setFilePickerOpen(false)
    void summarize(entry.path)
  }

  const openKnowledgeFile = async (fileLink: string): Promise<void> => {
    try {
      const workspaces = safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')
      if (workspaces?.openPath) {
        await workspaces.openPath(clientFileLinkToPath(fileLink))
        if (isAlive()) setNotice('已调用系统打开文件')
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

  return {
    entries, filters, page, dicts,
    currentKind: selectedKind(filters),
    selected, draft, editId, setSelected,
    refreshKey,
    bumpRefreshKey: () => setRefreshKey((v) => v + 1),
    reload, updateFilters,
    openEntry: (entry) => { setEditId(null); setDraft(null); setSelected(entry) },
    openEntryById: (id) => {
      const entry = entries.find((e) => e.id === id)
      if (entry === undefined) return
      setEditId(null); setDraft(null); setSelected(entry)
    },
    startCreate: (seed) => { setEditId(null); setDraft({ title: '', contentMd: '', kindCode: 'note', tags: '', sourceTaskId: '', sourceReviewId: '', fileLink: '', ...(seed ?? {}) }) },
    startEdit: (entry) => setDraft({
      title: entry.title, contentMd: entry.contentMd, kindCode: entry.kindCode, tags: entry.tags.join(', '),
      sourceTaskId: entry.sourceTaskId ?? '', sourceReviewId: entry.sourceReviewId ?? '', fileLink: entry.fileLink ?? '',
    }),
    patchDraft: (patch) => setDraft((prev) => (prev === null ? prev : { ...prev, ...patch })),
    closeDraft: () => { setDraft(null); setEditId(null) },
    filePicker: {
      path: localDocPath, setPath: setLocalDocPath,
      open: filePickerOpen, listing: filePickerListing, loading: filePickerLoading, error: filePickerError,
      openPicker, close: () => setFilePickerOpen(false),
      loadDir, pickFile, pickAndSummarize, summarize,
    },
    openKnowledgeFile,
  }
}
