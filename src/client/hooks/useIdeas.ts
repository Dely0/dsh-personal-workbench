/**
 * D17 / P2：点子域（点子 + 点子王/文件夹）的全部状态、派生、请求与动作。
 *
 * 边界（设计文档 §3/§5）：
 * - 本模块只依赖 `api` 与共享类型；**不 import React 组件、不 import 入口**。
 * - 提示词拼装、`startAISession` 的调用不进这里 —— 那些是 AI 会话域的职责，由入口/视图回调注入。
 * - `ideaQuery` / `ideaKind` 的旧语义是"请求参数"：`ideaKind` 当年没有 UI 写入点，`setIdeaKind` 从未被调用。
 *   这里按实测状态保留 `query` 与 `kind` 两个可写状态与 `setQuery`/`setKind`（gate 与依赖数组逐字对应原
 *   `useCallback(..., [ideaQuery, ideaKind])`），既不删旧状态、也不新增同步 effect。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { toContentItem } from '../listPresentation.js'
import type { IdeaCardItem } from '../components/IdeaCardGrid.js'
import type { Idea, IdeaClusterView } from '../viewTypes.js'

/** 文件夹（= 点子王）的新建/改名表单。 */
export type IdeaFolderForm = {
  mode: 'create' | 'rename'
  id: string | null
  title: string
  summaryMd: string
}

/** 点子编辑表单（新建与编辑共用一份形状，`ideaEditId === null` 表示新建）。 */
export type IdeaDraft = {
  title: string
  contentMd: string
  kindCode: string
  tags: string
}

export type IdeasTab = 'ideas' | 'unfiled' | 'clusters'

export type UseIdeasInput = {
  /** 视图门控：只有 `ideas` 视图才拉取（与拆分前的 effect 依赖 `[view, loadIdeas, ideaRefreshKey]` 一致）。 */
  activeView: string
  setError: (message: string | null) => void
  setNotice: (message: string | null) => void
}

export type UseIdeasResult = {
  ideas: Idea[]
  clusters: IdeaClusterView[]
  tab: IdeasTab
  /** 切页签：同时按原语义清掉"另一个"选择（见 `changeTab`）。 */
  setTab: (tab: IdeasTab) => void
  query: string
  setQuery: (query: string) => void
  kind: string
  setKind: (kind: string) => void
  pickedIds: ReadonlySet<string>
  togglePick: (id: string) => void
  selectedIdea: Idea | null
  selectedCluster: IdeaClusterView | null
  draft: IdeaDraft | null
  editId: string | null
  folderForm: IdeaFolderForm | null
  /** 点子卡片网格的入参：附上"属于哪些文件夹"，组件不自己去翻 ideaClusters。 */
  cardItems: IdeaCardItem[]
  /** 没有被任何文件夹引用的点子（「未归类」区）。 */
  unfiledIdeas: Idea[]
  /** AI 提示词要用的点子全集（只读快照，避免入口再持有第二份可写状态）。 */
  allIdeas: Idea[]
  setFolderForm: (form: IdeaFolderForm | null) => void
  patchFolderForm: (patch: Partial<IdeaFolderForm>) => void
  actions: {
    refresh: () => void
    /** 卡片网格点开：按 id 从当前列表里找，找不到就什么都不做（连点子王选择都不清）。 */
    openIdeaById: (id: string) => void
    /** 文件夹成员行点开：直接用手上的对象（成员可能不在当前筛选出的列表里）。 */
    openIdea: (idea: Idea) => void
    openCluster: (cluster: IdeaClusterView) => void
    startCreate: () => void
    startEdit: (idea: Idea) => void
    patchDraft: (patch: Partial<IdeaDraft>) => void
    closeDraft: () => void
    saveDraft: (input: { title: string; contentMd: string; kindCode: string; tags: string[] }) => void
    deleteIdea: (id: string) => void
    saveFolder: () => void
    deleteFolder: (id: string) => void
    fileIdeaInto: (ideaId: string, clusterId: string) => void
    unfileIdeaFrom: (ideaId: string, clusterId: string) => void
    mergeFolderInto: (sourceId: string, targetId: string) => void
  }
}

export function useIdeas({ activeView, setError, setNotice }: UseIdeasInput): UseIdeasResult {
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [clusters, setClusters] = useState<IdeaClusterView[]>([])
  const [tab, setTabState] = useState<IdeasTab>('ideas')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set())
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null)
  const [selectedCluster, setSelectedCluster] = useState<IdeaClusterView | null>(null)
  const [draft, setDraft] = useState<IdeaDraft | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [folderForm, setFolderForm] = useState<IdeaFolderForm | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    const params = new URLSearchParams()
    if (query.trim() !== '') params.set('q', query.trim())
    if (kind !== '') params.set('kind_code', kind)
    const qs = params.toString()
    const [ideasRes, clustersRes] = await Promise.all([
      api<{ ideas: Idea[] }>(`/api/workbench/ideas${qs === '' ? '' : `?${qs}`}`),
      api<{ clusters: IdeaClusterView[] }>('/api/workbench/idea-clusters'),
    ])
    setIdeas(ideasRes.ideas); setClusters(clustersRes.clusters)
  }, [query, kind])
  useEffect(() => {
    if (activeView === 'ideas') void load().catch(() => undefined)
  }, [activeView, load, refreshKey])

  /** 点子卡片网格的入参：附上"属于哪些文件夹"，组件不自己去翻 ideaClusters。 */
  const cardItems = useMemo<IdeaCardItem[]>(() => ideas.map((idea) => ({
    ...toContentItem(idea),
    clusterIds: clusters.filter((cluster) => cluster.ideas.some((member) => member.id === idea.id)).map((cluster) => cluster.id),
  })), [ideas, clusters])

  /**
   * 点子页的文件夹派生数据：
   * - unfiledIdeas：没有被任何文件夹引用的点子（「未归类」区）
   * 数据层无需变更：idea_clusters = 文件夹，idea_links 已支持多对多。
   */
  const unfiledIdeas = useMemo(() => {
    const filed = new Set(clusters.flatMap((cluster) => cluster.ideas.map((idea) => idea.id)))
    return ideas.filter((idea) => !filed.has(idea.id))
  }, [ideas, clusters])

  const refresh = useCallback((): void => { setRefreshKey((value) => value + 1) }, [])

  const patchFolderForm = useCallback((patch: Partial<IdeaFolderForm>): void => {
    setFolderForm((prev) => (prev === null ? prev : { ...prev, ...patch }))
  }, [])
  const patchDraft = useCallback((patch: Partial<IdeaDraft>): void => {
    setDraft((prev) => (prev === null ? prev : { ...prev, ...patch }))
  }, [])

  const startCreate = useCallback((): void => {
    setEditId(null); setSelectedIdea(null); setDraft({ title: '', contentMd: '', kindCode: 'spark', tags: '' })
  }, [])
  const startEdit = useCallback((idea: Idea): void => {
    setEditId(idea.id); setSelectedIdea(idea)
    setDraft({ title: idea.title, contentMd: idea.contentMd, kindCode: idea.kindCode, tags: idea.tags.join(', ') })
  }, [])
  const closeDraft = useCallback((): void => { setDraft(null); setEditId(null) }, [])
  /**
   * 切页签。与拆分前逐字一致：切到「文件夹」只清**点子**选择，切到「全部/未归类」只清**点子王**选择
   * —— 原实现是"只清另一个"，不是两份都清（P2 第一版写成两份都清，已修回）。
   */
  const changeTab = useCallback((next: IdeasTab): void => {
    if (next === 'clusters') setSelectedIdea(null)
    else setSelectedCluster(null)
    setTabState(next)
  }, [])
  /** 卡片网格点开（原写法是 find + 找不到就早退，连 selectedCluster 都不清）。 */
  const openIdeaById = useCallback((id: string): void => {
    const idea = ideas.find((item) => item.id === id)
    if (idea === undefined) return
    setSelectedCluster(null); setSelectedIdea(idea)
  }, [ideas])
  /** 文件夹成员行点开（原写法直接用手上的对象；成员可能不在当前筛选出的 `ideas` 里）。 */
  const openIdea = useCallback((idea: Idea): void => {
    setSelectedCluster(null); setSelectedIdea(idea)
  }, [])
  const openCluster = useCallback((cluster: IdeaClusterView): void => {
    setSelectedIdea(null); setSelectedCluster(cluster)
  }, [])

  /** 保存点子（新建 POST / 编辑 PATCH）。标题非空与标签切分由调用方（视图）判定，保持拆分前的行为。 */
  const saveDraft = useCallback((input: { title: string; contentMd: string; kindCode: string; tags: string[] }): void => {
    const payload = { title: input.title, contentMd: input.contentMd, kindCode: input.kindCode, tags: input.tags }
    const isEdit = editId !== null
    void api(isEdit ? `/api/workbench/ideas/${editId}` : '/api/workbench/ideas', {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(() => { setDraft(null); setEditId(null); setRefreshKey((v) => v + 1); setNotice(isEdit ? '点子已更新' : '点子已保存') })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [editId, setError, setNotice])

  /** 删除点子。 */
  const deleteIdea = useCallback((id: string): void => {
    void api(`/api/workbench/ideas/${id}`, { method: 'DELETE' })
      .then(() => { setSelectedIdea(null); setRefreshKey((v) => v + 1); setNotice('已删除') })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [setError, setNotice])

  /** 新建空文件夹 / 文件夹改名。 */
  const saveFolder = useCallback((): void => {
    if (folderForm === null) return
    const title = folderForm.title.trim()
    if (title === '') { setError('文件夹名称不能为空'); return }
    const finish = (res: { cluster: IdeaClusterView }, notice: string): void => {
      setNotice(notice); setSelectedCluster(res.cluster); setFolderForm(null); refresh()
    }
    if (folderForm.mode === 'create') {
      void api<{ cluster: IdeaClusterView }>('/api/workbench/idea-clusters', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, summaryMd: folderForm.summaryMd }),
      }).then((res) => finish(res, '文件夹已创建'))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    } else if (folderForm.id !== null) {
      void api<{ cluster: IdeaClusterView }>(`/api/workbench/idea-clusters/${folderForm.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, summaryMd: folderForm.summaryMd }),
      }).then((res) => finish(res, '文件夹已更新'))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    }
  }, [folderForm, refresh, setError, setNotice])

  /** 删除文件夹（点子本身保留，回到「未归类」）。 */
  const deleteFolder = useCallback((id: string): void => {
    void api(`/api/workbench/idea-clusters/${id}`, { method: 'DELETE' })
      .then(() => {
        setSelectedCluster((prev) => (prev?.id === id ? null : prev))
        setNotice('文件夹已删除，点子回到「未归类」')
        refresh()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refresh, setError, setNotice])

  /** 把点子归入文件夹（可多对多；已在其中则忽略）。 */
  const fileIdeaInto = useCallback((ideaId: string, clusterId: string): void => {
    void api(`/api/workbench/idea-clusters/${clusterId}/ideas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ideaId }),
    }).then(() => { setNotice('已归入文件夹'); refresh() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refresh, setError, setNotice])

  /** 把点子移出文件夹。 */
  const unfileIdeaFrom = useCallback((ideaId: string, clusterId: string): void => {
    void api(`/api/workbench/idea-clusters/${clusterId}/ideas/${ideaId}`, { method: 'DELETE' })
      .then(() => {
        refresh()
        return api<{ cluster: IdeaClusterView }>(`/api/workbench/idea-clusters/${clusterId}`)
      })
      .then((res) => setSelectedCluster(res.cluster))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refresh, setError])

  /** 合并文件夹：把当前文件夹并入目标文件夹（成员挂过去，源文件夹删除）。 */
  const mergeFolderInto = useCallback((sourceId: string, targetId: string): void => {
    if (sourceId === targetId) return
    void api<{ cluster: IdeaClusterView }>(`/api/workbench/idea-clusters/${sourceId}/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ into: targetId }),
    }).then((res) => { setNotice('文件夹已合并'); setSelectedCluster(res.cluster); refresh() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refresh, setError, setNotice])

  /** 选中集合的增删（`IdeaCardGrid` 的多选）。 */
  const togglePick = useCallback((id: string): void => {
    setPickedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  return {
    ideas, clusters, tab, setTab: changeTab, query, setQuery, kind, setKind,
    pickedIds, togglePick, selectedIdea, selectedCluster, draft, editId, folderForm,
    cardItems, unfiledIdeas, allIdeas: ideas,
    setFolderForm, patchFolderForm,
    actions: {
      refresh, openIdeaById, openIdea, openCluster, startCreate, startEdit, patchDraft, closeDraft,
      saveDraft, deleteIdea, saveFolder, deleteFolder, fileIdeaInto, unfileIdeaFrom, mergeFolderInto,
    },
  }
}
