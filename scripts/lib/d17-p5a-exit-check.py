#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""D17 / P5-1（反馈域 + 设置域）出口自检 —— 只做文本核对，行为以 typecheck / pnpm test 为准。

本批把下面这些从 `src/client/index.tsx` 的 `WorkbenchApp` 里搬走：

* **反馈域** → `src/client/hooks/useWorkbenchFeedback.ts`
  - 2 项 state：`error`（原 L366）、`notice`（原 L367）
  - toast 队列宿主 `useToasts()`（原 L418）
  - 把上面两者转成右上角 toast 的两条桥接 effect（原 L651-658）
* **设置域** → `src/client/hooks/useWorkbenchSettings.ts`
  - 9 项 state：`settings`（原 L400）、`showSettings`（L413）、`settingsSaving`（L414）、
    `recallLog`（L416）、`recallSessionOff`（L417）、`dictKind`（L424）、`dictForm`（L425）、
    `dictEditCode`（L426）、`dictError`（L427）
  - 动作：`saveSettings`（原 L1537-1555）、三个字典动作（原 L1492-1533）、`loadRecallLog`（原 L578-590）、
    `recallSessionRestore`（原 L593-604）
  - 两条 effect：设置装载（原 L570）、召回日志（原 L625-628）
  - 模块级纯助手 `SETTINGS_FALLBACK` / `withSettingsFallback`（原 L150-174）→ `src/client/settingsFallback.ts`

**刻意留在装配层（本批不动，动它们属别的批次）**：

* `saveIncludeOverdue`（L1698）/ `saveDailyCapacity`（L1715）—— 写 `settings` 但读日期域的
  `day.capacityEdit`，P4 的明确决策：两个域各一半，留在入口。
* `rememberQuickWorkspace`（L1897）/ `forgetQuickWorkspace`（L1918）—— quick-intake 域，属 P6。
* `ackReminder`（L722）/ `resetReminderState`（L733）/ `loadReminderChannel`（L1440）/
  `saveReminderPolicy`（L1472）—— 提醒域，属 P5-2。
* `DraftBanner` 整块 —— 它的 `onDone` 同时写点子域的 `ideas.actions.refresh()`。
* 全部 JSX / props / className / portal 位置。

7 条核对：① 入口不再自建 ② 唯一所有者 ③ 设置域 effect 与路由归属 ④ 跨域注入
⑤ 反馈域纯度 ⑥ 刻意留在入口的东西还在 ⑦ 结构指纹与调用顺序。
"""

from __future__ import annotations

import glob
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
os.chdir(ROOT)

INDEX_PATH = os.path.join("src", "client", "index.tsx")
FEEDBACK_HOOK_PATH = os.path.normpath(os.path.join("src", "client", "hooks", "useWorkbenchFeedback.ts"))
SETTINGS_HOOK_PATH = os.path.normpath(os.path.join("src", "client", "hooks", "useWorkbenchSettings.ts"))
FALLBACK_PATH = os.path.normpath(os.path.join("src", "client", "settingsFallback.ts"))

# ---------------------------------------------------------------- D17/P7-2：JSX 已分四段搬进 app/
# 判据跟着 owner 走：凡「某组件 / 某 props 仍挂在装配层」的断言不再锚 `index.tsx`，
# 而是锚这四段组件 —— 它们才是装配层的 JSX owner。
# 注意：域 hook 不在这份名单里，所以「接线跑进 hook」仍然会红。
def _app_read(name):
    with open(os.path.join("src", "client", "app", name), encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


UI_HEADER = _app_read("WorkbenchHeader.tsx")
UI_OVERLAYS = _app_read("WorkbenchOverlays.tsx")
UI_BODY = _app_read("WorkbenchBody.tsx")
UI_DIALOGS = _app_read("WorkbenchDialogs.tsx")
UI_ALL = "\n".join((UI_HEADER, UI_OVERLAYS, UI_BODY, UI_DIALOGS))

failures: list[str] = []
checks = 0


def load(p: str) -> str:
    with open(p, encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


def strip_comments(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r"^[ \t]*//.*$", "", s, flags=re.M)
    return s


def check(ok: bool, message: str) -> None:
    global checks
    checks += 1
    if ok:
        print(f"  \u2714 {message}")
    else:
        print(f"  \u2716 {message}")
        failures.append(message)


def bare(src: str, name: str, origin: str) -> int:
    """裸名在（已剥注释的）src 里的命中数：不算 `a.name` 这类成员访问，也不算对象字面量的键。"""
    return len(re.findall(r"(?<![\w.])" + re.escape(name) + r"\b(?!\s*:)", src))


def body_of(src: str, start: str, end: str | None = None) -> str | None:
    i = src.find(start)
    if i < 0:
        return None
    if end is None:
        return src[i:]
    j = src.find(end, i)
    if j < 0:
        return None
    return src[i:j]


def client_sources() -> list[str]:
    pats = ["src/client/**/*.ts", "src/client/**/*.tsx"]
    out: list[str] = []
    for pat in pats:
        out.extend(glob.glob(pat, recursive=True))
    return sorted({os.path.normpath(p) for p in out if os.path.isfile(p)})


SOURCES = {p: load(p) for p in client_sources()}
INDEX = SOURCES[os.path.normpath(INDEX_PATH)]
INDEX_BARE = strip_comments(INDEX)
FEEDBACK = SOURCES[FEEDBACK_HOOK_PATH]
SETTINGS = SOURCES[SETTINGS_HOOK_PATH]

# 从入口搬走的 9 项设置状态声明原文（搬进 hook 后逐字未改）
SETTINGS_STATES = [
    "const [showSettings, setShowSettings] = useState(false)",
    "const [settingsSaving, setSettingsSaving] = useState(false)",
    "const [recallLog, setRecallLog] = useState<RecallLogState>({ lines: [], loading: false, error: null })",
    "const [recallSessionOff, setRecallSessionOff] = useState<string[]>([])",
    "const [dictKind, setDictKind] = useState<DictKind>('type')",
    "const [dictForm, setDictForm] = useState<DictFormState | null>(null)",
    "const [dictEditCode, setDictEditCode] = useState<string | null>(null)",
    "const [dictError, setDictError] = useState<string | null>(null)",
]
# `settings` 的声明原文含全部默认值，太长，单独放一份
SETTINGS_DEFAULTS_LINE = (
    "const [settings, setSettings] = useState<WorkbenchSettings>({ defaultWorkspace: '', "
    "autoCreateTypeFolders: true, desktopNotify: true, dailyCapacityMinutes: 390, "
    "quickWorkspaceRecent: [], autoKnowledgeRecall: true, "
    "defaultEstimateMinutes: DEFAULT_ESTIMATE_MINUTES, dailyCapacityIncludeOverdue: false, "
    "personaExternalDir: '', personaFavorites: [], personaDisabledIds: [] })"
)

SETTINGS_ACTIONS = {
    "saveSettings": "const saveSettings = async (): Promise<void> => {",
    "saveDictionaryEntry": "const saveDictionaryEntry = async (event: FormEvent<HTMLFormElement>): Promise<void> => {",
    "toggleDictionaryEntry": "const toggleDictionaryEntry = async (entry: Dict): Promise<void> => {",
    "deleteDictionaryEntry": "const deleteDictionaryEntry = async (entry: Dict): Promise<void> => {",
    "loadRecallLog": "const loadRecallLog = useCallback(async () => {",
    "recallSessionRestore": "const recallSessionRestore = useCallback(async (sessionId: string, mode: 'on' | 'clear') => {",
}

# 入口解构出来的名字（本批刻意解构，保持所有调用点文本不变）
# P7-3 清理后入口只为 JSX 解构的名字已删；这里冻结"入口真读的两项 + 两个写口"。
DESTRUCTURED_RESULT = (
    "const { settings, showSettings } = prefs"
)
DESTRUCTURED_ACTIONS_BLOCK = (
    "const { setSettings, saveDailyCapacity: saveDailyCapacitySetting } = prefs.actions"
)
DESTRUCTURED_ACTIONS = [
    "setSettings", "setShowSettings", "setDictKind", "setDictForm", "setDictEditCode", "setDictError",
    "saveSettings", "saveDictionaryEntry", "toggleDictionaryEntry", "deleteDictionaryEntry",
    "loadRecallLog", "recallSessionRestore",
]

print("=" * 78)
print("D17 / P5-1 出口自检（反馈域 + 设置域）")
print("=" * 78)

# ---------------------------------------------------------------- §1 入口不再自建
print("\n§1 入口不再自建本域任何东西")

check(FEEDBACK_HOOK_PATH in SOURCES, "useWorkbenchFeedback.ts 存在")
check(SETTINGS_HOOK_PATH in SOURCES, "useWorkbenchSettings.ts 存在")
check(FALLBACK_PATH in SOURCES, "settingsFallback.ts 存在")

check("const [error, setError] = useState<string | null>(null)" not in INDEX_BARE,
      "入口不再声明反馈域的 error state")
check("const [notice, setNotice] = useState<string | null>(null)" not in INDEX_BARE,
      "入口不再声明反馈域的 notice state")
check("const { toasts, pushToast, dismissToast } = useToasts()" not in INDEX_BARE,
      "入口不再自己起 toast 队列（useToasts 已进反馈域）")
check(bare(INDEX_BARE, "useToasts", "INDEX") == 0,
      "入口剥注释后不再出现裸名 useToasts")

for decl in SETTINGS_STATES:
    check(decl not in INDEX_BARE, f"入口不再声明：{decl[:58]}…")
check(SETTINGS_DEFAULTS_LINE not in INDEX_BARE, "入口不再声明 settings 的完整默认值")

check(INDEX_BARE.count("const feedback = useWorkbenchFeedback()") == 1,
      "入口恰好一处 const feedback = useWorkbenchFeedback()")
check(INDEX_BARE.count("const { toasts } = feedback") == 1,
      "入口恰好一处 const { toasts } = feedback")
check(INDEX_BARE.count("const { setError, setNotice, pushToast, dismissToast } = feedback.actions") == 1,
      "入口恰好一处解构反馈域 4 个写口（改名会连累所有注入点）")
check(INDEX_BARE.count(
    "const prefs = useWorkbenchSettings({ dictOf, refresh, onError: setError, onNotice: setNotice, onToast: pushToast })") == 1,
    "入口恰好一处 const prefs = useWorkbenchSettings({…})，且 5 个入参写全")
check(DESTRUCTURED_RESULT in INDEX_BARE,
      "入口解构了设置域结果（P7-3 起只剩入口真读的 settings / showSettings）")
check(DESTRUCTURED_ACTIONS_BLOCK in INDEX_BARE,
      "入口解构了设置域的两个写口（setSettings 与外层的 saveDailyCapacity）")
for name in DESTRUCTURED_ACTIONS:
    # ⚠️ 必须允许行首缩进：WorkbenchApp 体内的定义都是缩进 2 格的，
    # 写成 `^const` 会让这条"不许有第二份定义"的判据**永远为真**（空洞通过）。
    check(re.search(r"^[ \t]*(const|function)\s+" + re.escape(name) + r"\b", INDEX_BARE, re.M) is None,
          f"入口不再有 {name} 的第二份定义")
check(bare(INDEX_BARE, "setRecallLog", "INDEX") == 0, "入口不解构 setRecallLog（本域独占）")
check(bare(INDEX_BARE, "setRecallSessionOff", "INDEX") == 0, "入口不解构 setRecallSessionOff（本域独占）")
check(bare(INDEX_BARE, "setSettingsSaving", "INDEX") == 0, "入口不解构 setSettingsSaving（本域独占）")
check("SETTINGS_FALLBACK = {" not in INDEX_BARE, "入口不再定义 SETTINGS_FALLBACK")
check("function withSettingsFallback(" not in INDEX_BARE, "入口不再定义 withSettingsFallback")

# ---------------------------------------------------------------- §2 唯一所有者
print("\n§2 唯一所有者（全客户端递归）")


def owners(text: str) -> list[str]:
    return [p for p, s in SOURCES.items() if text in s]


def show(ps: list[str]) -> str:
    return ", ".join(ps) if ps else "（无）"


state_owner_texts = [SETTINGS_DEFAULTS_LINE] + SETTINGS_STATES
for decl in state_owner_texts:
    hits = owners(decl)
    check(hits == [SETTINGS_HOOK_PATH],
          f"创建者唯一 = {SETTINGS_HOOK_PATH}（{decl[:44]}…）实际：{show(hits)}")

for name, decl in SETTINGS_ACTIONS.items():
    hits = owners(decl)
    check(hits == [SETTINGS_HOOK_PATH],
          f"动作 {name} 只有一处定义，在设置域 hook（实际：{show(hits)}）")

check(owners("const { toasts, pushToast, dismissToast } = useToasts()") == [FEEDBACK_HOOK_PATH],
      "useToasts 的宿主全客户端只有一处（反馈域 hook）")
check(FEEDBACK.count("const [error, setError] = useState<string | null>(null)") == 1
      and "const [error, setError] = useState<string | null>(null)" not in INDEX_BARE,
      "反馈域 error 的 useState 只在反馈 hook 里")
check(FEEDBACK.count("const [notice, setNotice] = useState<string | null>(null)") == 1
      and "const [notice, setNotice] = useState<string | null>(null)" not in INDEX_BARE,
      "反馈域 notice 的 useState 只在反馈 hook 里")
check(owners("const SETTINGS_FALLBACK = {") == [FALLBACK_PATH],
      "SETTINGS_FALLBACK 只定义在 settingsFallback.ts")
check(owners("export function withSettingsFallback(") == [FALLBACK_PATH],
      "withSettingsFallback 只定义在 settingsFallback.ts")
check(owners("export function useWorkbenchFeedback(") == [FEEDBACK_HOOK_PATH],
      "useWorkbenchFeedback 只定义一次")
check(owners("export function useWorkbenchSettings(") == [SETTINGS_HOOK_PATH],
      "useWorkbenchSettings 只定义一次")

# ------------------------------------------------------- §3 设置域 effect 与路由
print("\n§3 设置域 effect 与 HTTP 归属")

SETTINGS_LOAD_EFFECT = ("useEffect(() => { void api<{ settings: WorkbenchSettings }>('/api/workbench/settings')"
                        ".then((r) => setSettings(withSettingsFallback(r.settings))).catch(() => undefined) }, [])")
check(SETTINGS_LOAD_EFFECT in SETTINGS, "设置装载 effect 原文进了设置域 hook")
check(SETTINGS_LOAD_EFFECT not in INDEX_BARE, "入口不再有设置装载 effect")
check("}, [showSettings, loadRecallLog])" in SETTINGS, "召回日志 effect 依赖数组原文进了 hook")
check("if (!showSettings) return" in SETTINGS, "召回日志 effect 的 showSettings 闸门还在")
for route in ["/api/workbench/settings",
              "/api/workbench/knowledge-recall/log?limit=30",
              "/api/workbench/knowledge-recall/status",
              "/api/workbench/knowledge-recall/session",
              "/api/workbench/dictionaries/",
              "/api/workbench/dictionaries', { method: 'POST'"]:
    check(route in SETTINGS, f"设置域 hook 里仍有路由：{route}")
check("/api/workbench/reminders" not in SETTINGS, "设置域 hook 不碰提醒域路由（属 P5-2）")
check("/api/workbench/drafts" not in SETTINGS, "设置域 hook 不碰草稿域路由（属 P5-3）")
check(bare(SETTINGS, "fetch", "SETTINGS") == 0, "设置域 hook 不用原生 fetch（统一走 api）")
check(SETTINGS.count("api<") + SETTINGS.count("api(") >= 7, "设置域 hook 至少 7 处 api 调用（装载 + 召回 2 + 还原 1 + 字典 3）")

# ---------------------------------------------------------------- §4 跨域注入
print("\n§4 跨域注入（设计 §5）")

INJECT_LINE = ("const { dictOf, refresh, onError: setError, onNotice: setNotice, onToast: pushToast } = input")
check(INJECT_LINE in SETTINGS, "注入回调在 hook 里改回域内原名（函数体才不用改）")
check("dictOf: (kind: DictKind) => Dict[]" in SETTINGS, "入参类型声明了 dictOf")
check("refresh: () => Promise<void>" in SETTINGS, "入参类型声明了 refresh")
check("onToast: (message: string, tone?: ToastTone) => void" in SETTINGS, "入参类型声明了 onToast")
SETTINGS_BARE = strip_comments(SETTINGS)
for name in ["setView", "resetDetailView", "setDetailTab", "setTasks", "setSelected",
             "useKnowledge", "useIdeas", "useTaskListModel", "useDayWorkspace", "useTaskData"]:
    check(bare(SETTINGS_BARE, name, "SETTINGS") == 0,
          f"设置域 hook 不引用别的域：{name}")
check(not re.search(r"^import .*views/", SETTINGS, re.M), "设置域 hook 不 import 任何 view")
check(not re.search(r"^import .*from '\.\./index", SETTINGS, re.M), "设置域 hook 不 import 入口")

# ---------------------------------------------------------------- §5 反馈域纯度
print("\n§5 反馈域纯度")

check("if (notice !== null) { pushToast(notice, 'success'); setNotice(null) }" in FEEDBACK,
      "notice → toast 桥接 effect 原文")
check("}, [notice, pushToast])" in FEEDBACK, "notice 桥接的依赖数组原文")
check("if (error !== null) { pushToast(error, 'error'); setError(null) }" in FEEDBACK,
      "error → toast 桥接 effect 原文")
check("}, [error, pushToast])" in FEEDBACK, "error 桥接的依赖数组原文")
check("return { error, notice, toasts, actions: { setError, setNotice, pushToast, dismissToast } }" in FEEDBACK,
      "反馈域返回值原文")
FEEDBACK_BARE = strip_comments(FEEDBACK)
for name in ["api", "fetch", "setView", "useKnowledge", "useIdeas", "useTaskData", "useDayWorkspace"]:
    check(bare(FEEDBACK_BARE, name, "FEEDBACK") == 0, f"反馈域 hook 不引用：{name}")
check(FEEDBACK_BARE.count("useState<") == 2, "反馈域 hook 恰好 2 项 state（error / notice）")
check(FEEDBACK_BARE.count("useEffect(") == 2, "反馈域 hook 恰好 2 条 effect（两条桥接）")

# ---------------------------------------------------------------- §6 留在入口的
print("\n§6 刻意留在装配层的东西还在")

# ⚠️ 判据跟着 owner 走（P5-2 口径修正）：这里原本还断言四条**提醒域**动作留在入口
#（`loadReminderChannel` / `saveReminderPolicy` / `ackReminder` / `resetReminderState`）。
# D17/P5-2 已把提醒域整域搬进 src/client/hooks/useWorkbenchReminders.ts，所以这四条
# 从本列表删除；"入口里不该再有它们 + hook 里必须恰好有一份"改由
# scripts/lib/d17-p5b-exit-check.py 的「入口不存在 + hook 存在」成对断言负责。
#
# ⚠️ 判据跟着 owner 走（P6-2 口径修正）：同一条道理，快速录入域的两个写入点
#（`rememberQuickWorkspace` / `forgetQuickWorkspace`）与它们用的
# `setSettings(withSettingsFallback(res.settings))` 原语**也搬走了**
#（src/client/hooks/useWorkbenchQuickIntake.ts），所以这两条也从本列表删除，
# 归 scripts/lib/d17-p6b-exit-check.py 的成对断言。本征 P5-1 的其余断言
#（`saveIncludeOverdue` / `saveDailyCapacity` 两个设置写入点、`clearTodayPlan`、设置弹窗 props）不变。
# ⚠️ 判据跟着 owner 走（D17/P7-1 口径修正）：`saveIncludeOverdue` 的整条用例与
# `saveDailyCapacity` 的**请求本体**也搬走了（src/client/hooks/useWorkbenchSettings.ts）。
# 入口只留 `saveDailyCapacity` 的装配层半边（读日期域的编辑态 + 把原文递进去），
# 成对断言（入口不存在 + 新 owner 里恰好一份）写在这里而不是删除。
check("const saveDailyCapacity = async (): Promise<void> => {" in INDEX_BARE,
      "仍在入口：saveDailyCapacity 的装配层半边（读日期域的 capacityEdit）")
check("const saveIncludeOverdue" not in INDEX_BARE,
      "saveIncludeOverdue 已不在入口（D17/P7-1 整条搬进设置域）")
check(SETTINGS.count("const saveIncludeOverdue = async (next: boolean): Promise<void> => {") == 1
      and SETTINGS.count("const saveDailyCapacity = async (rawEdit: string): Promise<void> => {") == 1,
      "两个 settings 写入的请求本体在设置域各恰好一份（D17/P7-1 归域）")
check(bare(INDEX_BARE, "clearTodayPlan", "INDEX") <= 1, "未碰日期域（clearTodayPlan 仍按 P4 原样）")
check(INDEX_BARE.count("setSettings(withSettingsFallback(res.settings))") == 0,
      "quick-intake 的两个写入点已不在入口（P6-2 搬走；新 owner 由 p6b 盯）")

for jsx in ["onSettingsChange={setSettings}",
            "onSaveSettings={saveSettings}",
            "saving={settingsSaving}",
            "dictKind={dictKind}",
            "dictForm={dictForm}",
            "dictEditCode={dictEditCode}",
            "dictError={dictError}",
            "onSaveDictionary={saveDictionaryEntry}",
            "onToggleDictionary={toggleDictionaryEntry}",
            "onDeleteDictionary={deleteDictionaryEntry}",
            "recallLog={recallLog}",
            "onRefreshRecallLog={() => void loadRecallLog()}",
            "recallSessionOff={recallSessionOff}",
            "onRecallSessionOffChange={(sessionId, mode) => void recallSessionRestore(sessionId, mode)}",
            "onClose={() => setShowSettings(false)}",
            "onClick={() => setShowSettings((v) => !v)}"]:
    # 最后一条是顶栏的「设置」开关 —— P7-2 起它在 app/WorkbenchHeader.tsx，其余在 app/WorkbenchBody.tsx。
    check(jsx in UI_BODY or jsx in UI_HEADER, f"JSX props 原文未动：{jsx}（D17/P7-2 起在 app/WorkbenchBody.tsx / app/WorkbenchHeader.tsx）")
check("{showSettings && (" in UI_BODY, "SettingsModal 的条件渲染原文（P7-2 起在 app/WorkbenchBody.tsx）")
check("<ToastHost items={toasts} onDismiss={dismissToast} />" in INDEX_BARE, "ToastHost 接线原文")

# ---------------------------------------------------------------- §7 结构指纹
print("\n§7 结构指纹与调用顺序")

check("import { withSettingsFallback } from '../settingsFallback.js'" in SETTINGS,
      "设置域 import settingsFallback（P7-3 后入口已不再 import —— 写 settings 的原语全在域里）")
check("import { withSettingsFallback } from './settingsFallback.js'" not in INDEX,
      "入口不再 import settingsFallback（P7-3 清理成果，不是放宽：正向由上一句盯 owner）")
check("import { useWorkbenchFeedback } from './hooks/useWorkbenchFeedback.js'" in INDEX,
      "入口 import 反馈域 hook")
check("import { useWorkbenchSettings } from './hooks/useWorkbenchSettings.js'" in INDEX,
      "入口 import 设置域 hook")
check(not re.search(r"^\s*import .*\buseToasts\b", INDEX, re.M), "入口 import 语句里不再带 useToasts")

i_feedback = INDEX_BARE.find("const feedback = useWorkbenchFeedback()")
i_data = INDEX_BARE.find("const data = useTaskData(")
i_prefs = INDEX_BARE.find("const prefs = useWorkbenchSettings(")
i_knowledge = INDEX_BARE.find("const knowledge = useKnowledge(")
i_ideas = INDEX_BARE.find("const ideas = useIdeas(")
check(i_feedback > 0 and i_data > 0 and i_prefs > 0 and i_knowledge > 0 and i_ideas > 0,
      "五个关键调用点都找得到（顺序断言的前提）")
check(0 < i_feedback < i_data < i_prefs,
      "调用顺序：feedback → useTaskData → prefs（注入的 const 都在声明之后）")
check(i_prefs < i_knowledge and i_prefs < i_ideas,
      "调用顺序：prefs 还在 useKnowledge / useIdeas 之前")

for comment, least in [("反馈域（D17/P5-1）", 3), ("设置域（D17/P5-1）", 6)]:
    check(INDEX.count(comment) >= least, f"入口保留了指针注释：{comment}（{INDEX.count(comment)} 处）")

print("\n" + "=" * 78)
if failures:
    print(f"✖ {len(failures)} / {checks} 项未通过")
    for f in failures:
        print(f"   - {f}")
    sys.exit(1)
print(f"✔ 全部 {checks} 项通过")
sys.exit(0)
