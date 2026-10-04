#!/usr/bin/env python3
"""D17 P1 主体切片：把已搬到 hooks/useKnowledge.ts + views/Knowledge*.tsx 的知识域痕迹从入口删掉。

规矩（本仓 skill §14）：**切片必须用唯一标记**，命中 0 次或 >1 次一律报错不写。
本脚本只做「精确删除 / 精确替换」，不做正则；每步打印命中次数与增删字符数。
"""
FILE = "src/client/index.tsx"
src = open(FILE, encoding="utf-8", newline="").read()
orig_len = len(src)
results = []


def cut(label, snippet):
    global src
    n = src.count(snippet)
    if n != 1:
        raise SystemExit(f"ABORT {label}: 命中 {n} 次（要求恰好 1 次）")
    src = src.replace(snippet, "", 1)
    results.append(f"CUT   {label}  -{len(snippet)}")


def replace(label, old, new):
    global src
    n = src.count(old)
    if n != 1:
        raise SystemExit(f"ABORT {label}: 命中 {n} 次（要求恰好 1 次）")
    src = src.replace(old, new, 1)
    results.append(f"REPL  {label}  {len(new) - len(old):+d}")


# ---------------------------------------------------------------- 1) 域模型接线
replace(
    "state → 域模型占位（紧跟 loadSkills 之后，那里 dictOf/busy/view 都已声明）",
    "  const loadIdeas = useCallback(async () => {\r\n",
    "  /**\r\n"
    "   * D17 / P1：知识域的全部 state / effect / 动作已经收进 `hooks/useKnowledge.ts`。\r\n"
    "   *\r\n"
    "   * ⚠️ 为什么调用点在这里而不是 state 声明区：本 hook 的入参里有 `dictOf` / `busy` / `activeView`，\r\n"
    "   * 它们在本组件里**先声明后使用**（`const` 没有提升）—— 放到前面会直接 ReferenceError。\r\n"
    "   * 调用顺序（hook 调用次序）与拆分前一致（原先这些 state/effect 也都在这个位置之前之后连续声明），\r\n"
    "   * 域 hook 常驻在顶层、不在条件视图里，所以切视图不会重置知识域状态（设计 §4.2）。\r\n"
    "   */\r\n"
    "  const knowledge = useKnowledge({\r\n"
    "    activeView: view,\r\n"
    "    dictOf,\r\n"
    "    busy,\r\n"
    "    setBusy,\r\n"
    "    runtime,\r\n"
    "    isAlive: () => instanceAlive,\r\n"
    "    startAISession,\r\n"
    "    setError: (message) => setError(message),\r\n"
    "    setNotice: (message) => setNotice(message),\r\n"
    "  })\r\n"
    "  const loadIdeas = useCallback(async () => {\r\n",
)

# ---------------------------------------------------------------- 2) state 声明
cut(
    "state: knowledgeEntries … filePickerError",
    "  const [knowledgeEntries, setKnowledgeEntries] = useState<KnowledgeEntry[]>([])\r\n"
    "  /**\r\n"
    "   * 知识库列表的筛选/排序/分页状态。\r\n"
    "   *\r\n"
    "   * 首屏从 localStorage 读回，保证「刷新 / 重开面板后 Tab 与排序还在」（验收项）。\r\n"
    "   * 判定全部交给 `listPresentation.ts`，这里只存状态、不存\"哪些条目可见\"。\r\n"
    "   */\r\n"
    "  const [knowledgeFilters, setKnowledgeFilters] = useState<KnowledgeFilters>(() => readKnowledgeFilters())\r\n"
    "  const [selectedKnowledge, setSelectedKnowledge] = useState<KnowledgeEntry | null>(null)\r\n"
    "  const [knowledgeDraft, setKnowledgeDraft] = useState<{ title: string; contentMd: string; kindCode: string; tags: string; sourceTaskId: string; sourceReviewId: string; fileLink: string } | null>(null)\r\n"
    "  const [knowledgeEditId, setKnowledgeEditId] = useState<string | null>(null)\r\n"
    "  const [knowledgeRefreshKey, setKnowledgeRefreshKey] = useState(0)\r\n"
    "  const [localDocPath, setLocalDocPath] = useState('')\r\n"
    "  const [filePickerOpen, setFilePickerOpen] = useState(false)\r\n"
    "  const [filePickerListing, setFilePickerListing] = useState<LocalDirListing | null>(null)\r\n"
    "  const [filePickerLoading, setFilePickerLoading] = useState(false)\r\n"
    "  const [filePickerError, setFilePickerError] = useState<string | null>(null)\r\n",
)

# ---------------------------------------------------------------- 3) 取数 effect
cut(
    "loader: loadKnowledge + effect",
    "  // 知识库：一次取回后**全部在客户端**搜索/筛选/排序/分页 —— 千级规模下每次敲字都打库是不可接受的。\r\n"
    "  const loadKnowledge = useCallback(async () => {\r\n"
    "    const res = await api<{ entries: KnowledgeEntry[] }>('/api/workbench/knowledge')\r\n"
    "    setKnowledgeEntries(res.entries)\r\n"
    "  }, [])\r\n"
    "  useEffect(() => {\r\n"
    "    if (view === 'knowledge') void loadKnowledge().catch(() => undefined)\r\n"
    "  }, [view, loadKnowledge, knowledgeRefreshKey])\r\n",
)

# ---------------------------------------------------------------- 4) 文件选择五件套
cut(
    "handlers: summarizeLocalDoc … pickAndSummarizeLocalFile",
    "  const summarizeLocalDoc = async (pathOverride?: string): Promise<void> => {\r\n"
    "    const path = (pathOverride ?? localDocPath).trim()\r\n"
    "    if (path === '') {\r\n"
    "      setError('请输入本地文档路径')\r\n"
    "      return\r\n"
    "    }\r\n"
    "    setBusy(true); setError(null)\r\n"
    "    try {\r\n"
    "      const res = await api<{ fileLink: string; content: string; name: string; truncated: boolean }>(`/api/workbench/knowledge/read-local-file?path=${encodeURIComponent(path)}`)\r\n"
    "      await startAISession('knowledge_doc', null, res.fileLink, [], { fileLink: res.fileLink, content: res.content, name: res.name, truncated: res.truncated })\r\n"
    "    } catch (e) {\r\n"
    "      setError(e instanceof Error ? e.message : String(e))\r\n"
    "    } finally {\r\n"
    "      setBusy(false)\r\n"
    "    }\r\n"
    "  }\r\n"
    "\r\n"
    "  const loadFilePickerDir = async (path?: string | null): Promise<void> => {\r\n"
    "    setFilePickerLoading(true); setFilePickerError(null)\r\n"
    "    try {\r\n"
    "      // `null` = 要看「此电脑」（盘符列表）；不传 = 默认落在主目录。\r\n"
    "      // 请求形状的唯一实现在 `localDirBrowser.ts`（工作区的「浏览…」弹窗共用）。\r\n"
    "      const res = await api<LocalDirListing>(localDirRequestUrl(path))\r\n"
    "      setFilePickerListing(res)\r\n"
    "    } catch (e) {\r\n"
    "      setFilePickerError(e instanceof Error ? e.message : String(e))\r\n"
    "    } finally {\r\n"
    "      setFilePickerLoading(false)\r\n"
    "    }\r\n"
    "  }\r\n"
    "\r\n"
    "  const openFilePicker = (): void => {\r\n"
    "    setFilePickerOpen(true)\r\n"
    "    void loadFilePickerDir()\r\n"
    "  }\r\n"
    "\r\n"
    "  const pickLocalFile = (entry: { path: string; isDirectory: boolean; isFile: boolean }): void => {\r\n"
    "    if (entry.isDirectory) {\r\n"
    "      void loadFilePickerDir(entry.path)\r\n"
    "      return\r\n"
    "    }\r\n"
    "    setLocalDocPath(entry.path)\r\n"
    "    setFilePickerOpen(false)\r\n"
    "    setNotice('已选择本地文件，可点击「开始总结」')\r\n"
    "  }\r\n"
    "\r\n"
    "  const pickAndSummarizeLocalFile = (entry: { path: string; isDirectory: boolean; isFile: boolean }): void => {\r\n"
    "    if (entry.isDirectory) {\r\n"
    "      void loadFilePickerDir(entry.path)\r\n"
    "      return\r\n"
    "    }\r\n"
    "    setLocalDocPath(entry.path)\r\n"
    "    setFilePickerOpen(false)\r\n"
    "    void summarizeLocalDoc(entry.path)\r\n"
    "  }\r\n"
    "\r\n",
)

# ---------------------------------------------------------------- 5) openKnowledgeFile
cut(
    "handler: openKnowledgeFile",
    "  const openKnowledgeFile = async (fileLink: string): Promise<void> => {\r\n"
    "    try {\r\n"
    "      const workspaces = safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')\r\n"
    "      if (workspaces?.openPath) {\r\n"
    "        await workspaces.openPath(clientFileLinkToPath(fileLink))\r\n"
    "        if (instanceAlive) setNotice('已调用系统打开文件')\r\n"
    "        return\r\n"
    "      }\r\n"
    "    } catch {\r\n"
    "      // 原生 openPath 不可用时回退到后端打开接口\r\n"
    "    }\r\n"
    "    try {\r\n"
    "      await api('/api/workbench/knowledge/open-file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileLink }) })\r\n"
    "      setNotice('已调用系统打开文件')\r\n"
    "    } catch (e) {\r\n"
    "      setError(e instanceof Error ? e.message : String(e))\r\n"
    "    }\r\n"
    "  }\r\n"
    "\r\n",
)

# ---------------------------------------------------------------- 6) 派生与 effect 区
cut(
    "derived: knowledgeDicts … reconcile effect",
    "  /**\r\n"
    "   * 知识库：把「条目 + 筛选状态」交给 `listPresentation.ts` 判定，组件只渲染结果。\r\n"
    "   *\r\n"
    "   * `now` 每次渲染现取：时间分组（今天/本周/…）本来就要跟着现实时间走，\r\n"
    "   * 而\"判定输入是显式快照\"这条约束要求它是显式传进来的，不是在判定模块里读 `Date.now()`。\r\n"
    "   */\r\n"
    "  const knowledgeDicts = useMemo(() => dictOf('knowledge_kind'), [dictOf])\r\n"
    "  const knowledgePage = useMemo(() => buildListPage({\r\n"
    "    items: knowledgeEntries.map(toContentItem),\r\n"
    "    query: {\r\n"
    "      tab: selectedKind(knowledgeFilters),\r\n"
    "      keyword: knowledgeFilters.keyword,\r\n"
    "      tags: knowledgeFilters.tags,\r\n"
    "      sortKey: knowledgeFilters.sortKey,\r\n"
    "      sortDir: knowledgeFilters.sortDir,\r\n"
    "      page: knowledgeFilters.page,\r\n"
    "      pageSize: knowledgeFilters.pageSize,\r\n"
    "    },\r\n"
    "    now: Date.now(),\r\n"
    "    tabOf: (entry) => entry.kindCode,\r\n"
    "    tabCodes: knowledgeDicts.map((d) => d.code),\r\n"
    "  }), [knowledgeEntries, knowledgeFilters, knowledgeDicts])\r\n",
)

# ---------------------------------------------------------------- 7) 入口里的文件弹窗（file 模式）
cut(
    "jsx: <LocalDocModal> file 模式（已随知识域搬进 KnowledgeListView）",
    "              <LocalDocModal\r\n"
    "                open={filePickerOpen}\r\n"
    "                path={localDocPath}\r\n"
    "                listing={filePickerListing}\r\n"
    "                loading={filePickerLoading}\r\n"
    "                error={filePickerError}\r\n"
    "                busy={busy}\r\n"
    "                onPathChange={setLocalDocPath}\r\n"
    "                onClose={() => setFilePickerOpen(false)}\r\n"
    "                onNavigate={(target) => void loadFilePickerDir(target)}\r\n"
    "                onPick={pickLocalFile}\r\n"
    "                onPickAndSummarize={pickAndSummarizeLocalFile}\r\n"
    "                onSummarize={() => void summarizeLocalDoc()}\r\n"
    "              />\r\n",
)

# ---------------------------------------------------------------- 8) 知识左侧视图
replace(
    "jsx: view === 'knowledge' 分支 → <KnowledgeListView>",
    "          {view === 'knowledge' && (\r\n"
    "            <>\r\n"
    "              {/* 本地文档三件套已收进弹窗（LocalDocModal）；工具栏只留一个按钮，和「新建」「清空筛选」同一行右对齐 */}\r\n"
    "              <KnowledgeToolbar\r\n"
    "                filters={knowledgeFilters}\r\n"
    "                tabs={kindTabs(knowledgeDicts, knowledgePage.tabCounts)}\r\n"
    "                tagCounts={knowledgePage.tagCounts}\r\n"
    "                total={knowledgePage.total}\r\n"
    "                onChange={updateKnowledgeFilters}\r\n"
    "                onClear={() => updateKnowledgeFilters({ keyword: '', kinds: ['all'], tags: [], page: 0 })}\r\n"
    "                onCreate={() => { setKnowledgeEditId(null); setKnowledgeDraft({ title: '', contentMd: '', kindCode: 'note', tags: '', sourceTaskId: '', sourceReviewId: '', fileLink: '' }) }}\r\n"
    "                onSummarizeDoc={openFilePicker}\r\n"
    "                busy={busy}\r\n"
    "              />\r\n"
    "              {knowledgeEntries.length === 0 ? (\r\n"
    "                <div className=\"wb-empty\" style={{ padding: '28px 18px' }}>\r\n"
    "                  <div style={{ marginBottom: 6, color: 'var(--dsw-alias-state-business-primary, #4f8ef7)' }}><Icon name=\"book\" size={30} /></div>\r\n"
    "                  <div style={{ fontWeight: 600, marginBottom: 4 }}>还没有知识条目</div>\r\n"
    "                  <div style={{ fontSize: 12, opacity: .8, marginBottom: 12 }}>沉淀经验教训、决策和可复用片段；也可以在 AI 复盘后一键写入</div>\r\n"
    "                  <button className=\"wb-btn primary\" onClick={() => { setKnowledgeEditId(null); setKnowledgeDraft({ title: '', contentMd: '', kindCode: 'note', tags: '', sourceTaskId: '', sourceReviewId: '', fileLink: '' }) }}>新建知识</button>\r\n"
    "                </div>\r\n"
    "              ) : (\r\n"
    "                <>\r\n"
    "                  <KnowledgeList\r\n"
    "                    page={knowledgePage}\r\n"
    "                    dicts={knowledgeDicts}\r\n"
    "                    selectedId={selectedKnowledge?.id}\r\n"
    "                    onOpen={(item) => {\r\n"
    "                      const entry = knowledgeEntries.find((e) => e.id === item.id)\r\n"
    "                      if (entry === undefined) return\r\n"
    "                      setKnowledgeEditId(null); setKnowledgeDraft(null); setSelectedKnowledge(entry)\r\n"
    "                    }}\r\n"
    "                  />\r\n"
    "                  <KnowledgePager\r\n"
    "                    page={knowledgePage}\r\n"
    "                    pageSize={knowledgeFilters.pageSize}\r\n"
    "                    onPage={(page) => updateKnowledgeFilters({ page })}\r\n"
    "                    onPageSize={(pageSize) => updateKnowledgeFilters({ pageSize, page: 0 })}\r\n"
    "                  />\r\n"
    "                </>\r\n"
    "              )}\r\n"
    "            </>\r\n"
    "          )}\r\n",
    "          {view === 'knowledge' && <KnowledgeListView model={knowledge} dictOf={dictOf} busy={busy} />}\r\n",
)

# ---------------------------------------------------------------- 9) 知识右侧详情（交给 d17-cut-p1c.py：
# 中文行不适合写进这份带转义的脚本，单独一步按行窗口切，见同目录脚本）

open(FILE, "w", encoding="utf-8", newline="").write(src)
print("\n".join(results))
print(f"len {orig_len} -> {len(src)}  ({len(src) - orig_len:+d})")
