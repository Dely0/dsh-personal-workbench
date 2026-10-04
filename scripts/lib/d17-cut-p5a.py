# -*- coding: utf-8 -*-
"""D17 / P5-1 一次性搬迁：把**反馈域**（error/notice + toast 宿主 + 两条桥接 effect）与
**设置域**（settings/字典/召回 9 项 state + 4 个动作 + 2 条 effect）从 src/client/index.tsx
切进 hooks/useWorkbenchFeedback.ts 与 hooks/useWorkbenchSettings.ts，并把纯数据兜底
`SETTINGS_FALLBACK` / `withSettingsFallback` 搬到 settingsFallback.ts。

房屋风格同 d17-cut-p3c.py / p3d.py / p4.py：所有断言先跑完，problems 为空才落盘。
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "src" / "client" / "index.tsx"

problems: list[str] = []


def replace_once(text: str, old: str, new: str, label: str) -> str:
    n = text.count(old)
    if n != 1:
        problems.append(f"{label}: 期望恰好 1 处，实际 {n} 处")
        return text
    return text.replace(old, new, 1)


def cut_between(text: str, start: str, end: str, new: str, label: str) -> str:
    """删除 [start .. end]（含两端标记）用 new 替代。两端标记都必须恰好 1 次。"""
    a = text.count(start)
    b = text.count(end)
    if a != 1:
        problems.append(f"{label}: 起始标记出现 {a} 次（期望 1）")
        return text
    if b != 1:
        problems.append(f"{label}: 结束标记出现 {b} 次（期望 1）")
        return text
    i = text.find(start)
    j = text.find(end)
    if j < i:
        problems.append(f"{label}: 结束标记在起始标记之前")
        return text
    return text[:i] + new + text[j + len(end):]


def cut_up_to(text: str, start: str, nxt: str, new: str, label: str) -> str:
    """删除从 start 起、到 nxt **之前**（不含 nxt）的整段，用 new 替代。两端标记都必须恰好 1 次。"""
    a = text.count(start)
    b = text.count(nxt)
    if a != 1:
        problems.append(f"{label}: 起始标记出现 {a} 次（期望 1）")
        return text
    if b != 1:
        problems.append(f"{label}: 下一段标记出现 {b} 次（期望 1）")
        return text
    i = text.find(start)
    j = text.find(nxt)
    if j < i:
        problems.append(f"{label}: 下一段标记在起始标记之前")
        return text
    return text[:i] + new + text[j:]


src = INDEX.read_text(encoding="utf-8")
if "\r\n" in src:
    problems.append("index.tsx 含 CRLF，先转成 LF 再搬")
orig_len = len(src.splitlines())

# ------------------------------------------------------------------ 1. imports
src = replace_once(
    src,
    "import { ToastHost, useToasts } from './components/Toast.js'\n",
    "import { ToastHost } from './components/Toast.js'\n",
    "import 去掉 useToasts",
)
src = replace_once(
    src,
    "import { api } from './api.js'\n",
    "import { api } from './api.js'\n"
    "import { withSettingsFallback } from './settingsFallback.js'\n",
    "import withSettingsFallback",
)
src = replace_once(
    src,
    "import { useDayWorkspace } from './hooks/useDayWorkspace.js'\n",
    "import { useDayWorkspace } from './hooks/useDayWorkspace.js'\n"
    "import { useWorkbenchFeedback } from './hooks/useWorkbenchFeedback.js'\n"
    "import { useWorkbenchSettings } from './hooks/useWorkbenchSettings.js'\n",
    "import 两个 P5-1 hook",
)

# ------------------------------------- 2. 纯数据兜底搬到 settingsFallback.ts（模块级，不在主组件里）
src = cut_between(
    src,
    "/** 容量两项偏好的兜底值（与 `capacity.ts` 的常量同值：一处读书、一处落库，必须一致）。 */",
    "    dailyCapacityIncludeOverdue: settings.dailyCapacityIncludeOverdue ?? SETTINGS_FALLBACK.dailyCapacityIncludeOverdue,\n"
    "  }\n"
    "}",
    "// 设置域（D17/P5-1）：`SETTINGS_FALLBACK` / `withSettingsFallback` 已搬到纯模块 settingsFallback.ts\n"
    "// （设置域 hook 与仍留在入口的 quick-intake 两个写入点共用它）。\n",
    "move withSettingsFallback",
)

# ------------------------------------------------------- 3. 反馈域：两项 state
src = replace_once(
    src,
    "  const [error, setError] = useState<string | null>(null)\n"
    "  const [notice, setNotice] = useState<string | null>(null)\n",
    "  // 反馈域（D17/P5-1）：`error` / `notice` 与 toast 宿主已收进 hooks/useWorkbenchFeedback.ts。\n"
    "  // ⚠️ 它必须落在**最早处**：下面的 useTaskData / useKnowledge / useIdeas / 设置域全都注入它的\n"
    "  // 写口（`const` 没有提升，声明在前才拿得到），所以不能为了\"离使用者近\"而下移。\n"
    "  const feedback = useWorkbenchFeedback()\n"
    "  const { toasts } = feedback\n"
    "  const { setError, setNotice, pushToast, dismissToast } = feedback.actions\n",
    "feedback hook 调用点",
)

# ------------------------------------------------ 4. 设置域：settings 那一行
src = replace_once(
    src,
    "  const [settings, setSettings] = useState<WorkbenchSettings>({ defaultWorkspace: '', autoCreateTypeFolders: true, desktopNotify: true, dailyCapacityMinutes: 390, quickWorkspaceRecent: [], autoKnowledgeRecall: true, defaultEstimateMinutes: DEFAULT_ESTIMATE_MINUTES, dailyCapacityIncludeOverdue: false, personaExternalDir: '', personaFavorites: [], personaDisabledIds: [] })\n",
    "  // 设置域（D17/P5-1）：`settings` 已收进 hooks/useWorkbenchSettings.ts（调用点在下方 `notifyPerm` 之后）。\n",
    "del settings state",
)

# --------------------------------- 5. 设置域：hook 调用点 + 解构（接在 notifyPerm 之后）
src = replace_once(
    src,
    "  const [showSettings, setShowSettings] = useState(false)\n"
    "  const [settingsSaving, setSettingsSaving] = useState(false)\n"
    "  /** 知识库召回回执：人类可读的日志行 + 每个会话的开关覆盖（设置页「知识库召回」分区用）。 */\n"
    "  const [recallLog, setRecallLog] = useState<{ lines: string[]; loading: boolean; error: string | null }>({ lines: [], loading: false, error: null })\n"
    "  const [recallSessionOff, setRecallSessionOff] = useState<string[]>([])\n",
    "  // 设置域（D17/P5-1）：9 项 state + 设置/字典/召回动作已收进 hooks/useWorkbenchSettings.ts。\n"
    "  // 落点必须在 `dictOf` / `refresh`（任务数据域）与反馈域三个写口之后 —— 它们都是以注入形式进来的。\n"
    "  const prefs = useWorkbenchSettings({ dictOf, refresh, onError: setError, onNotice: setNotice, onToast: pushToast })\n"
    "  const { settings, showSettings, settingsSaving, recallLog, recallSessionOff, dictKind, dictForm, dictEditCode, dictError } = prefs\n"
    "  const {\n"
    "    setSettings, setShowSettings, setDictKind, setDictForm, setDictEditCode, setDictError,\n"
    "    saveSettings, saveDictionaryEntry, toggleDictionaryEntry, deleteDictionaryEntry,\n"
    "    loadRecallLog, recallSessionRestore,\n"
    "  } = prefs.actions\n",
    "settings hook 调用点",
)

# ---------------------------------------------------- 6. 反馈域：useToasts() 宿主
src = replace_once(
    src,
    "  const { toasts, pushToast, dismissToast } = useToasts()\n",
    "  // 反馈域（D17/P5-1）：`useToasts()` 的宿主已随 `error`/`notice` 一起进 hooks/useWorkbenchFeedback.ts\n"
    "  // （`toasts` / `pushToast` / `dismissToast` 见上面第 3 步的解构）。\n",
    "del useToasts 调用",
)

# --------------------------------------------------------- 7. 设置域：字典 4 项 state
src = replace_once(
    src,
    "  const [dictKind, setDictKind] = useState<DictKind>('type')\n"
    "  const [dictForm, setDictForm] = useState<{ name: string; code: string; color: string; sortOrder: number } | null>(null)\n"
    "  const [dictEditCode, setDictEditCode] = useState<string | null>(null)\n"
    "  const [dictError, setDictError] = useState<string | null>(null)\n",
    "  // 设置域（D17/P5-1）：字典表单的 4 项 state 已收进 hooks/useWorkbenchSettings.ts（见上面的解构）。\n",
    "del 字典 4 项 state",
)

# ------------------------------------------- 8. 设置域：装载 effect + loadRecallLog 等四段
src = cut_up_to(
    src,
    "  useEffect(() => { void api<{ settings: WorkbenchSettings }>('/api/workbench/settings')",
    "  /**\n   * 拉一次知识库召回回执（日志行 + 单会话关闭清单）。",
    "  // 设置域（D17/P5-1）：设置装载 effect 已收进 hooks/useWorkbenchSettings.ts。\n\n",
    "del settings 装载 effect",
)
src = cut_up_to(
    src,
    "  /**\n   * 拉一次知识库召回回执（日志行 + 单会话关闭清单）。",
    '  /** 解除某个会话的"显式关闭"（恢复跟随全局）。 */',
    "  // 设置域（D17/P5-1）：`loadRecallLog` 已收进 hooks/useWorkbenchSettings.ts。\n\n",
    "del loadRecallLog",
)
src = cut_up_to(
    src,
    '  /** 解除某个会话的"显式关闭"（恢复跟随全局）。 */',
    "  // 打开设置面板时加载微信提醒策略与通道状态（含自动发现的可选投递目标）",
    "  // 设置域（D17/P5-1）：`recallSessionRestore` 已收进 hooks/useWorkbenchSettings.ts。\n\n",
    "del recallSessionRestore",
)
src = cut_up_to(
    src,
    "  /**\n   * 知识库召回日志（v1.15.3）：打开设置面板时拉一次，用户按需刷新。",
    "  /**\n   * 桌面通知去重集合：持久化到 localStorage。",
    "  // 设置域（D17/P5-1）：召回日志 effect 已收进 hooks/useWorkbenchSettings.ts。\n\n",
    "del 召回日志 effect",
)

# ----------------------------------------------- 9. 设置域：字典 CRUD + saveSettings
src = cut_up_to(
    src,
    "  const saveDictionaryEntry = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {",
    "  // ---- 设置弹窗：保存与微信提醒操作（把结果收敛到 toast，不再挤压任务列表）----",
    "  // 设置域（D17/P5-1）：字典 CRUD（`saveDictionaryEntry` / `toggleDictionaryEntry` /\n"
    "  // `deleteDictionaryEntry`）已收进 hooks/useWorkbenchSettings.ts。\n\n",
    "del 字典 CRUD",
)
src = cut_up_to(
    src,
    "  const saveSettings = async (): Promise<void> => {",
    "  const loadReminderChannel = async (): Promise<void> => {",
    "  // 设置域（D17/P5-1）：`saveSettings` 已收进 hooks/useWorkbenchSettings.ts。\n\n",
    "del saveSettings",
)

# ------------------------------------------------------------ 10. 反馈域：两条桥接 effect
src = cut_up_to(
    src,
    "  // 提示 / 错误统一转成右上角 toast：不再作为文档流横幅把任务列表挤下去。",
    "  // 有到期提醒时自动弹出提醒弹窗（关掉后本次不再自动弹；新提醒到达会再弹一次）。",
    "  // 反馈域（D17/P5-1）：`notice`/`error` → toast 的两条桥接 effect 已收进 hooks/useWorkbenchFeedback.ts。\n\n",
    "del 两条桥接 effect",
)

# ------------------------------------------------------------------ 落盘
if problems:
    print("❌ 未落盘，problems:")
    for p in problems:
        print("  -", p)
    raise SystemExit(1)

INDEX.write_text(src, encoding="utf-8", newline="\n")
print(f"✅ index.tsx: {orig_len} -> {len(src.splitlines())} 行")
