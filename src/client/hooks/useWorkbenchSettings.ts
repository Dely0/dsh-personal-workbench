/**
 * D17 / P5-1：**设置域（WorkbenchSettings）的唯一所有者**。
 *
 * 拆分前这些散在 `src/client/index.tsx` 的 `WorkbenchApp` 里（声明在 L400 / L413-417 / L424-427，
 * 动作在 L570 / L578-590 / L593-604 / L625-628 / L1492-1533 / L1537-1555）。本 hook 收口的是
 * **设置与字典这一域**：
 *
 * - 9 项 state：`settings` / `showSettings` / `settingsSaving` / `recallLog` / `recallSessionOff` /
 *   `dictKind` / `dictForm` / `dictEditCode` / `dictError`。
 * - 装配层原语：`setSettings`（**必须是原生 `Dispatch`**：入口的 `saveIncludeOverdue` /
 *   `saveDailyCapacity` / `rememberQuickWorkspace` / `forgetQuickWorkspace` 都用**函数式更新**
 *   写它，而那几个函数属别的域、本批不搬）。
 * - 域动作：`saveSettings` / `saveDictionaryEntry` / `toggleDictionaryEntry` / `deleteDictionaryEntry` /
 *   `loadRecallLog` / `recallSessionRestore`，外加四个语义化 setter（`setShowSettings` /
 *   `setDictKind` / `setDictForm` / `setDictEditCode` / `setDictError` 由装配层直接透给 `SettingsModal`）。
 * - 两条 effect：装载 `GET /api/workbench/settings`；打开设置面板时拉一次召回日志。
 *
 * ## 刻意**不**拥有的东西（跨域，按设计 §5 由装配层组合或注入）
 * - **字典内容**：`dictOf(kind)` 是任务数据域（`useTaskData`）的读口，本 hook 只读不拥有；
 *   字典改动后要 `await refresh()` 才算生效，所以 `refresh` 也走注入。
 * - **反馈**：本域的结果以 toast 呈现（原注释：把结果收敛到 toast，不再挤压任务列表），
 *   所以 `setError` / `setNotice` / `pushToast` 三个写口全部注入。
 * - **微信提醒的写入动作**（`saveReminderPolicy` / `saveChannelTarget` / `testNotification`）：
 *   它们写的是提醒域的 state（`reminderPolicy` / `reminderChannel` / `reminderOptions` /
 *   `reminderBusy`），属 P5-2，**留在装配层**；本 hook 只交出 `setShowSettings` 给它们共用的弹窗。
 * - **`saveIncludeOverdue` / `saveDailyCapacity`**：P4 的明确决策 —— 它们写 `settings` 但读的是
 *   日期域的 `day.capacityEdit`，两个域各有一半，留在装配层；本 hook 交出 `setSettings` 原语。
 * - **quick-intake 的两个写入点**（`rememberQuickWorkspace` / `forgetQuickWorkspace`）：属 P6，
 *   留在装配层；它们也用 `setSettings` 原语（且用 `withSettingsFallback`）。
 *
 * ## 为什么注入回调要在这里改回原名
 * `const { onError: setError, onNotice: setNotice, onToast: pushToast } = input` —— 这样下面
 * 从入口搬过来的函数体**逐字未改**，既有判据/探针里那些以源码文本为锚的断言不用重锚
 * （P4 起沿用的「只换来源、不改调用点文本」纪律）。
 */
import { useCallback, useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import { api } from '../api.js'
import { DEFAULT_ESTIMATE_MINUTES } from '../capacity.js'
import { withSettingsFallback } from '../settingsFallback.js'
import type { ToastTone } from '../components/Toast.js'
import type { DictKind } from '../components/SettingsModal.js'
import type { WorkbenchSettings } from '../../shared/contracts.js'
import type { Dict } from '../viewTypes.js'

/** 召回回执：人类可读的日志行 + 加载/错误态（设置页「知识库召回」分区用）。 */
export interface RecallLogState {
  lines: string[]
  loading: boolean
  error: string | null
}

/** 「字典项」表单的草稿值（新增与编辑共用一份）。 */
export interface DictFormState {
  name: string
  code: string
  color: string
  sortOrder: number
}

export interface UseWorkbenchSettingsInput {
  /** 任务数据域的字典读口：本域只读，不拥有字典内容。 */
  dictOf: (kind: DictKind) => Dict[]
  /** 任务数据域的 `refresh`：字典改动后必须重新拉 bootstrap 才算生效。 */
  refresh: () => Promise<void>
  onError: (message: string | null) => void
  onNotice: (message: string | null) => void
  /** 反馈域的 toast 推送口：本域的操作结果以 toast 呈现。 */
  onToast: (message: string, tone?: ToastTone) => void
}

export interface UseWorkbenchSettingsActions {
  /** 装配层原语（**原生 `Dispatch`**，因为外部写入点用函数式更新）。 */
  setSettings: Dispatch<SetStateAction<WorkbenchSettings>>
  setShowSettings: Dispatch<SetStateAction<boolean>>
  setDictKind: Dispatch<SetStateAction<DictKind>>
  setDictForm: Dispatch<SetStateAction<DictFormState | null>>
  setDictEditCode: Dispatch<SetStateAction<string | null>>
  setDictError: Dispatch<SetStateAction<string | null>>
  saveSettings: () => Promise<void>
  /**
   * D17/P7-1：逾期口径开关（从装配层收进本域）。「今日容量 → 规则」面板与设置页写**同一个**
   * settings 键，所以只能有一份实现；乐观写 + 失败回滚，不静默失败。
   */
  saveIncludeOverdue: (next: boolean) => Promise<void>
  /**
   * D17/P7-1：保存「每天可投入时长」（分钟）；`<30` 视为无效、恢复默认 390。
   * 入参是**日期域**交出的行内编辑态原文 —— 本域不拥有它、也不去读它（跨域只传值）。
   */
  saveDailyCapacity: (rawEdit: string) => Promise<void>
  saveDictionaryEntry: (event: FormEvent<HTMLFormElement>) => Promise<void>
  toggleDictionaryEntry: (entry: Dict) => Promise<void>
  deleteDictionaryEntry: (entry: Dict) => Promise<void>
  loadRecallLog: () => Promise<void>
  recallSessionRestore: (sessionId: string, mode: 'on' | 'clear') => Promise<void>
}

export interface UseWorkbenchSettingsResult {
  settings: WorkbenchSettings
  showSettings: boolean
  settingsSaving: boolean
  recallLog: RecallLogState
  recallSessionOff: string[]
  dictKind: DictKind
  dictForm: DictFormState | null
  dictEditCode: string | null
  dictError: string | null
  actions: UseWorkbenchSettingsActions
}

export function useWorkbenchSettings(input: UseWorkbenchSettingsInput): UseWorkbenchSettingsResult {
  // 注入回调改回域内原名（见文件头「为什么注入回调要在这里改回原名」）。
  const { dictOf, refresh, onError: setError, onNotice: setNotice, onToast: pushToast } = input

  const [settings, setSettings] = useState<WorkbenchSettings>({ defaultWorkspace: '', autoCreateTypeFolders: true, desktopNotify: true, dailyCapacityMinutes: 390, quickWorkspaceRecent: [], autoKnowledgeRecall: true, defaultEstimateMinutes: DEFAULT_ESTIMATE_MINUTES, dailyCapacityIncludeOverdue: false, personaExternalDir: '', personaFavorites: [], personaDisabledIds: [] })
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  /** 知识库召回回执：人类可读的日志行 + 每个会话的开关覆盖（设置页「知识库召回」分区用）。 */
  const [recallLog, setRecallLog] = useState<RecallLogState>({ lines: [], loading: false, error: null })
  const [recallSessionOff, setRecallSessionOff] = useState<string[]>([])
  const [dictKind, setDictKind] = useState<DictKind>('type')
  const [dictForm, setDictForm] = useState<DictFormState | null>(null)
  const [dictEditCode, setDictEditCode] = useState<string | null>(null)
  const [dictError, setDictError] = useState<string | null>(null)

  useEffect(() => { void api<{ settings: WorkbenchSettings }>('/api/workbench/settings').then((r) => setSettings(withSettingsFallback(r.settings))).catch(() => undefined) }, [])

  /**
   * 拉一次知识库召回回执（日志行 + 单会话关闭清单）。
   *
   * 两件事一次请求拿全（`/log` 与 `/status` 分两次会让界面出现"半新半旧"的中间态：
   * 日志刷新了、会话开关还是旧的，用户会以为"恢复了却没生效"）。
   */
  const loadRecallLog = useCallback(async () => {
    setRecallLog((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const [log, status] = await Promise.all([
        api<{ lines: string[] }>('/api/workbench/knowledge-recall/log?limit=30'),
        api<{ sessionOff: string[] }>('/api/workbench/knowledge-recall/status'),
      ])
      setRecallLog({ lines: log.lines, loading: false, error: null })
      setRecallSessionOff(status.sessionOff)
    } catch (e: unknown) {
      setRecallLog({ lines: [], loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  /** 解除某个会话的"显式关闭"（恢复跟随全局）。 */
  const recallSessionRestore = useCallback(async (sessionId: string, mode: 'on' | 'clear') => {
    try {
      const res = await api<{ sessionOff: string[] }>('/api/workbench/knowledge-recall/session', {
        method: 'POST',
        body: JSON.stringify({ sessionId, mode }),
      })
      setRecallSessionOff(res.sessionOff)
      pushToast('已恢复该会话的自动召回', 'success')
    } catch (e: unknown) {
      pushToast(`恢复失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [pushToast])

  /**
   * 知识库召回日志（v1.15.3）：打开设置面板时拉一次，用户按需刷新。
   *
   * 为什么不在启动时就拉：这是"排查/见证"用的信息，不是每次打开工作台都要看的东西；
   * 而它背后是每个会话每回合一行记录，无脑轮询纯浪费。
   */
  useEffect(() => {
    if (!showSettings) return
    void loadRecallLog()
  }, [showSettings, loadRecallLog])

  const saveDictionaryEntry = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
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

  // ---- 设置弹窗：保存（把结果收敛到 toast，不再挤压任务列表）----

  const saveSettings = async (): Promise<void> => {
    setSettingsSaving(true)
    try {
      /**
       * ⚠️ 刻意**不带** `quickWorkspaceRecent`：这个列表在设置弹窗里根本不可编辑，
       * 而服务端现在是"整表替换"语义 —— 一个开着很久的设置弹窗会把期间
       * 快速录入刚记下的工作区顶掉。它只由 `rememberQuickWorkspace` / `forgetQuickWorkspace`
       * 这两个知道自己手上是不是最新列表的地方写。
       */
      const { quickWorkspaceRecent: _ignored, ...editable } = settings
      await api('/api/workbench/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(editable) })
      setShowSettings(false)
      pushToast('设置已保存', 'success')
    } catch (e) {
      pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSettingsSaving(false)
    }
  }

  /**
   * 逾期口径开关（D17/P7-1：从装配层收进本域）。
   *
   * 为什么两处共用一个回调：`dailyCapacityIncludeOverdue` 的唯一权威源是 settings（服务端 meta）。
   * 若面板自己存一份 state，就会出现「面板开关是开的、容量按关的算」这种假控件。
   * 保存失败**回滚**（把 settings 改回去），不静默失败。
   */
  const saveIncludeOverdue = async (next: boolean): Promise<void> => {
    const previous = settings.dailyCapacityIncludeOverdue
    if (next === previous) return
    setSettings((prev) => ({ ...prev, dailyCapacityIncludeOverdue: next }))
    try {
      await api('/api/workbench/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailyCapacityIncludeOverdue: next }),
      })
      setNotice(next ? '逾期任务会计入今日容量' : '逾期任务不再计入今日容量')
    } catch (e) {
      setSettings((prev) => ({ ...prev, dailyCapacityIncludeOverdue: previous }))
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 保存「每天可投入时长」（D17/P7-1：从装配层收进本域）；`<30` 视为无效，恢复默认 390。
   *
   * 入参 `rawEdit` 是**日期域**交出的行内编辑态原文：日期域在自己的 hook 调用点把值取出来、
   * 立刻置空，再把原文递进来（跨域只传值，不把可写副本递出去 —— 设计 §5）。
   */
  const saveDailyCapacity = async (rawEdit: string): Promise<void> => {
    const raw = rawEdit.trim()
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

  return {
    settings,
    showSettings,
    settingsSaving,
    recallLog,
    recallSessionOff,
    dictKind,
    dictForm,
    dictEditCode,
    dictError,
    actions: {
      setSettings,
      setShowSettings,
      setDictKind,
      setDictForm,
      setDictEditCode,
      setDictError,
      saveSettings,
      saveIncludeOverdue,
      saveDailyCapacity,
      saveDictionaryEntry,
      toggleDictionaryEntry,
      deleteDictionaryEntry,
      loadRecallLog,
      recallSessionRestore,
    },
  }
}
