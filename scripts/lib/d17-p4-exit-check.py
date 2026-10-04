#!/usr/bin/env python3
"""D17 P4 出口核对（独立于 typecheck 的机械检查），与 d17-p1/p2/p3a/p3b/p3c/p3d-exit-check.py 同构。

本批把**日期域**（今日视图 / 日历视图 / 右侧日期面板）搬出入口：

- 17 项 state（`capacityEdit` / `capacityExpanded` / `reportSubTab` / `currentReport` / `reportSession` /
  `pickedPlan` / `pickedPlanSession` / `planRefreshKey` / `reportRefreshKey` / `todayPlanSession` /
  `todayExpanded` / `calendarExpanded` / `picked` / `addingPlanTaskId` / `cursor` / `calMode` / `dayTab`）；
- 只读派生 `pickedAnchor` / 候选快照 `planCandidateInfo` / 两个截断提示 / 两份候选行 / `capacity` /
  `reportAnchor` / `reportIsFuture` / `todayAnchor` / `thisWeekAnchor` / `weekDays` / `monthGrid` / `dayPanel`；
- 动作 `addTaskToPlan` / `patchPlanItem` / `savePlan` / `clearPlan` / `deleteReport` / `moveWeek` /
  `moveMonth` / 两个展开 toggle / `set*` 一族 / `bumpPlanRefresh` / `bumpReportRefresh`；
- 4 个 effect（报告加载 / 今日计划会话 / 选中日计划 / 页签复位）与 `useDayPanelModel` 调用；
- 两块 JSX 提成 `views/TodayPane.tsx` 与 `views/CalendarView.tsx`（视图**不发 HTTP**，模式 5）。

**刻意留在装配层**：
- `saveDailyCapacity` / `saveIncludeOverdue`（写的是 **settings**，设置域的唯一权威源，P6 才搬）；
- `dayPanelProps`（同时混入任务数据域 / 列表域 / 导航域，跨域组合归装配层）；
- `startAISession` 的四处包装（`onSort` / `onGenerate` / `onStartPlanAISession` / 空态按钮）；
- `collapseAll`（先让列表域收自己的树，再让日期域收两棵 —— 两域组合）；
- `openQuickEntry` / `forms.actions.toggleCreate()`。

核对：
1. 入口里**不再自己 `useState` / `useMemo` / `useCallback` 创建**本域的任何东西；只经 `day` / `day.actions` 取；
2. 17 项 state 的创建者**恰好**是 `hooks/useDayWorkspace.ts`（全客户端唯一所有者）；
3. 四个 effect 逐字搬走且依赖数组口径不变（`bootstrap` → `todayPlan` 是唯一改名）；
4. 容量 memo 的三条「别改回去」接线细节仍在（日键依赖 / 传全量列表 / 设置只读）；
5. 跨域靠注入（设计 §5）：hook 里没有裸 `setError` / `setNotice` / `setView`；
6. 两块视图 JSX 已提组件，且 `views/*` 里没有 `api(` / `fetch(`；
7. 结构指纹：搬迁没有丢 render、也没有把别域请求卷进 hook。

只做文本核对，不是行为验证；行为/结构以 `pnpm typecheck` / `pnpm test` 为准。
"""
import glob
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def load(p):
    return open(p, encoding="utf-8", newline="").read().replace("\r\n", "\n")


def strip_comments(s):
    s = re.sub(r"/\*[\s\S]*?\*/", " ", s)
    return re.sub(r"^[ \t]*//.*$", "", s, flags=re.M)


INDEX = load("src/client/index.tsx")
HOOK = load("src/client/hooks/useDayWorkspace.ts")
TODAY_PANE = load("src/client/views/TodayPane.tsx")
SETTINGS_HOOK = load("src/client/hooks/useWorkbenchSettings.ts")
CALENDAR_VIEW = load("src/client/views/CalendarView.tsx")
HOOK_BARE = strip_comments(HOOK)
INDEX_BARE = strip_comments(INDEX)

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

failures = []


def check(ok, message):
    print(("  ✔ " if ok else "  ✖ ") + message)
    if not ok:
        failures.append(message)


def bare(src, name, origin=None):
    """不被 `day.` / `day.actions.` 前缀引用的裸出现次数。"""
    return len(re.findall(r"(?<![\w.])" + re.escape(name) + r"\b", INDEX_BARE if origin is None else origin))


def body_of(src, start, end=None):
    """从 start 切到 end（都必须在），用于只看函数体。end 省略时取到文件尾。"""
    i = src.find(start)
    if i < 0:
        return None
    rest = src[i:]
    if end is None:
        return rest
    j = rest.find(end, len(start))
    return None if j < 0 else rest[:j]


def client_sources():
    """全客户端源码（含未追踪的新文件）——用于「唯一所有者」断言。"""
    out = []
    for pat in ("src/client/**/*.ts", "src/client/**/*.tsx"):
        for p in glob.glob(pat, recursive=True):
            if os.path.isfile(p):
                out.append(os.path.normpath(p))
    return sorted(set(out))


SOURCES = {p: load(p) for p in client_sources()}
HOOK_PATH = os.path.normpath("src/client/hooks/useDayWorkspace.ts")

STATES = [
    "const [capacityEdit, setCapacityEdit] = useState<string | null>(null)",
    "const [capacityExpanded, setCapacityExpanded] = useState(false)",
    "const [reportSubTab, setReportSubTab] = useState<ReportSubTab>('day')",
    "const [currentReport, setCurrentReport] = useState<TaskReportView | null>(null)",
    "const [reportSession, setReportSession] = useState<{ sessionId: string } | null>(null)",
    "const [pickedPlan, setPickedPlan] = useState<DailyPlanView | null>(null)",
    "const [pickedPlanSession, setPickedPlanSession] = useState<{ sessionId: string } | null>(null)",
    "const [planRefreshKey, setPlanRefreshKey] = useState(0)",
    "const [reportRefreshKey, setReportRefreshKey] = useState(0)",
    "const [todayPlanSession, setTodayPlanSession] = useState<{ sessionId: string } | null>(null)",
    "const [todayExpanded, setTodayExpanded] = useState<Set<string>>(new Set())",
    "const [calendarExpanded, setCalendarExpanded] = useState<Set<string>>(new Set())",
    "const [picked, setPicked] = useState<Date>(() => startOfDay(now))",
    "const [addingPlanTaskId, setAddingPlanTaskId] = useState<string | null>(null)",
    "const [cursor, setCursor] = useState<Date>(() => startOfWeek(now))",
    "const [calMode, setCalMode] = useState<'week' | 'month'>('week')",
    "const [dayTab, setDayTab] = useState<DayTab>('plan')",
]

SETTERS = [
    "setCapacityEdit", "setCapacityExpanded", "setReportSubTab", "setCurrentReport", "setReportSession",
    "setPickedPlan", "setPickedPlanSession", "setPlanRefreshKey", "setReportRefreshKey",
    "setTodayPlanSession", "setTodayExpanded", "setCalendarExpanded", "setPicked",
    "setAddingPlanTaskId", "setCursor", "setCalMode", "setDayTab",
]

# 日期域交出来的**动作**：装配层必须经解构或 `day.actions.` 用它，绝不许自己再定义一份。
# （`toggleTodayExpanded` / `toggleCalendarExpanded` 只被 hook 内部的 `useDayPanelModel` 消费，
#   装配层不直接用 —— 它们单独核对。）
ACTIONS = [
    "addTaskToPlan", "patchPlanItem", "savePlan", "clearPlan", "deleteReport",
    "moveWeek", "moveMonth", "setCapacityEdit", "setCapacityExpanded", "setReportSubTab",
    "setPicked", "setCursor", "setCalMode", "setDayTab",
    "bumpPlanRefresh", "bumpReportRefresh",
]

OWN_DECLS = [
    "const pickedAnchor = localDateString(picked)",
    "const planCandidateInfo = useMemo(",
    "const capacity = useMemo(",
    "const weekDays = Array.from({ length: 7 }",
    "const monthGrid = (() => {",
    "const moveWeek = (delta: number): void => {",
    "const moveMonth = (delta: number): void =>",
    "const toggleTodayExpanded = (id: string): void =>",
    "const toggleCalendarExpanded = (id: string): void =>",
    "const addTaskToPlan = async (taskId: string, minutes?: number)",
    "const patchPlanItem = async (",
    "const savePlan = async (",
    "const reportAnchor = reportSubTab === 'week'",
    "const reportIsFuture = reportSubTab === 'week'",
    "const todayAnchor = localDateString(new Date())",
    "const dayPanel = useDayPanelModel(",
]

print("1) 入口不再自建日期域的任何 state / 派生 / 动作")
for decl in STATES + OWN_DECLS:
    check(decl not in INDEX_BARE, f"入口里没有 `{decl[:52]}…`")
for setter in SETTERS:
    check(not re.search(r"useState[^\n]*\b" + setter + r"\b", INDEX_BARE),
          f"入口里没有以 `useState` 创建 `{setter}`（state 的 setter 不再由入口创建）")
check(len(re.findall(r"const day = useDayWorkspace\(\{", INDEX_BARE)) == 1,
      "入口恰好一次 `const day = useDayWorkspace({`)")
for action in ACTIONS:
    # P7-2 后 JSX 在 app/ 四段里；P7-3 又把入口只为 JSX 解构的名字清掉 —— 所以
    # "装配层用到它"要在「入口 + app/ 四段」这个整体里看（域 hook 不在名单里：接线跑进 hook 仍会红）。
    check(bare(None, action) >= 1 or re.search(r"(?<![\w.])" + re.escape(action) + r"\b", UI_ALL) is not None,
          f"装配层通过 `day.actions` 用到 `{action}`（入口或 src/client/app/ 四段）")
    check(not re.search(r"^(const|function) " + action + r"\b", INDEX_BARE, flags=re.M),
          f"入口里没有 `{action}` 的第二份定义")
check("day.actions.collapseExpanded()" in INDEX_BARE,
      "collapseAll 只调 `day.actions.collapseExpanded()`（跨域组合留在装配层）")
check("todayToggleExpanded: toggleTodayExpanded," in HOOK
      and "calendarToggleExpanded: toggleCalendarExpanded," in HOOK,
      "两个展开 toggle 只被 hook 内部的 useDayPanelModel 消费（装配层不再下传）")
check("const day = useDayWorkspace({" in INDEX and
      "    archivedTasks: taskList.archivedTasks,\n" in INDEX and
      "    onError: setError,\n    onNotice: setNotice,\n" in INDEX,
      "入参含归档快照透传与两个注入回调（onError/onNotice，同 useTaskData 法）")
# P7-3 后入口只为 JSX 解构的名字已清 —— 这里冻结的是入口真读的 3 行原文。
for name in ["reportSubTab, currentReport, reportSession, reportAnchor, reportIsFuture,",
             "pickedPlan, addingPlanTaskId, dayTab, dayPanel, planPromptFor,",
             "addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, setDayTab, setReportSubTab } = day.actions",
             ]:
    check(name in INDEX, f"入口解构了 `{name[:56]}…`")
# 反面：只为 JSX 解构的名字不该再回流入库（调用点在 app/ 四段里，由上面的 ACTIONS 循环盯住）。
for name in ["capacity,", "capacityEdit,", "capacityExpanded,", "cursor,", "calMode,", "weekDays,",
             "monthGrid,", "moveWeek,", "moveMonth,", "setPicked,", "setCalMode,", "setCursor,",
             "setCapacityEdit,", "setCapacityExpanded,", "bumpPlanRefresh,", "bumpReportRefresh,"]:
    check("\n    " + name not in INDEX_BARE, f"入口不再解构 `{name}`（P7-3 清理）")

print("2) 17 项 state 的创建者全客户端唯一，且就是 hooks/useDayWorkspace.ts")
for decl in STATES:
    owners = [p for p, s in SOURCES.items() if decl in s]
    check(owners == [HOOK_PATH], f"`{decl[:46]}…` 的创建者是 {owners or '（无）'}")
check(len(re.findall(r"const \[dayTab, setDayTab\]", HOOK)) == 1 and
      len(re.findall(r"const \[calMode, setCalMode\]", HOOK)) == 1,
      "hook 自己创建 dayTab / calMode（不靠装配层回填）")

print("3) 四个 effect 逐字搬进 hook，依赖数组口径不变")
for deps in ["}, [view, dayTab, reportSubTab, reportAnchor, reportIsFuture, reportRefreshKey])",
             "}, [todayAnchor, todayPlan])",
             "}, [view, dayTab, pickedAnchor, planRefreshKey])",
             "}, [dayPanel.extraTabsAvailable])"]:
    check(deps in HOOK_BARE, f"hook 里有依赖数组 `{deps[-46:]}")
check("}, [todayAnchor, bootstrap])" not in HOOK_BARE,
      "今日计划会话 effect 的依赖不再是 bootstrap（改成 todayPlan，语义等价且不再随任意 bootstrap 变化重拉）")
for route in ["/api/workbench/reports/${reportSubTab}/${reportAnchor}",
              "/api/workbench/ai-sessions?scope_code=${reportScope}&anchor=${reportAnchor}",
              "/api/workbench/ai-sessions?scope_code=daily_plan&anchor=${todayAnchor}",
              "/api/workbench/plans?date=${pickedAnchor}",
              "/api/workbench/plans/${localDateString()}/items",
              "/api/workbench/plans/${date}/items/${encodeURIComponent(taskId)}"]:
    check(route in HOOK, f"hook 里仍发 `{route[:52]}…`")
check("/api/workbench/settings" not in HOOK,
      "hook 里没有 settings 写入（写设置留在装配层，P6 才搬）")

print("4) 容量 memo 的三条「别改回去」接线细节仍在")
check("[tasks, archivedTasks, todayPlan, dailyCapacityMinutes, defaultEstimateMinutes, "
      "dailyCapacityIncludeOverdue, capacityTodayKey(now)]" in HOOK,
      "依赖数组用日键 capacityTodayKey(now)、不含 now 对象（探针 I1 锚点，已重锚至此）")
check("tasks: [...tasks, ...archivedTasks]" in HOOK, "memo 喂的是全量任务列表（归档过滤在共享函数里）")
check("    tasks: [...tasks, ...archivedTasks],\n" in HOOK and
      "plan: todayPlan === null ? null : { ...todayPlan, readable: todayPlan.readable !== false }" in HOOK,
      "已排来自计划快照、readable 兜底口径逐字保留")
check("capacityTodayKey(now)" in HOOK and "eslint-disable-next-line react-hooks/exhaustive-deps" in HOOK,
      "「now 不能进依赖数组」的口径注释与豁免一起搬进 hook")
check(not re.search(r"computeTodayCapacity\(", INDEX_BARE),
      "入口里没有 computeTodayCapacity 的调用（owner 换人；import 可以留着不动）")

print("5) 跨域靠注入：hook 里没有裸反馈 setter / 导航动作")
for name in ["setError", "setNotice", "setView", "resetDetailView", "setDetailTab"]:
    check(bare(HOOK, name, HOOK_BARE) == 0, f"hook 剥注释后没有裸 `{name}`")
check("onError: (message: string) => void" in HOOK and "onNotice: (message: string) => void" in HOOK,
      "入参类型里有 onError / onNotice 注入回调")
check("onError(e instanceof Error ? e.message : String(e))" in HOOK, "catch 里统一走注入的 onError")
check("onNotice(res.added ? `已排入今日计划" in HOOK,
      "「已排入今日计划」的提示在日期域内发出（写入口与提示同一处）")

print("6) 两块视图已提组件，且视图层不发 HTTP")
check("export function TodayPane(" in TODAY_PANE and "export type TodayPaneProps" in TODAY_PANE,
      "views/TodayPane.tsx 导出 TodayPane + TodayPaneProps")
check("export function CalendarView(" in CALENDAR_VIEW and "export type CalendarViewProps" in CALENDAR_VIEW,
      "views/CalendarView.tsx 导出 CalendarView + CalendarViewProps")
for name, src in [("TodayPane.tsx", TODAY_PANE), ("CalendarView.tsx", CALENDAR_VIEW)]:
    check(not re.search(r"fetch\(|\bapi[<(]", src), f"{name} 里不许拼请求（模式 5：动作靠注入回调）")
    check(not re.search(r"\buseState[<(]", src), f"{name} 里不许自持 state（视图只读 props）")
check("view === 'today' && (\n            <TodayPane" in UI_BODY, "按 view 分派到 TodayPane（D17/P7-2 起在 app/WorkbenchBody.tsx）")
check("view === 'calendar' && (\n            <CalendarView" in UI_BODY, "按 view 分派到 CalendarView（同上）")
check("className=\"wb-stats wb-stats-sticky\"" not in INDEX, "今日统计卡的 JSX 已不在入口")
check("className=\"wb-cal-nav\"" not in INDEX, "日历导航的 JSX 已不在入口")

print("7) 结构指纹：装配层的跨域组合与既有判据锚点原文都在")
check("const collapseAll = (): void => { taskList.actions.clearExpanded(); day.actions.collapseExpanded() }" in INDEX,
      "collapseAll 留在装配层（列表域 + 日期域两域组合，hook 只暴露 collapseExpanded）")
# P6-3：这句随 `startAISession` 搬进 AI 会话域 hook ⇒ 判据跟着 owner 走（正向指新家 + 入口负向）。
# 日期域要守的语义没变：计划提示词仍**只经 `planPromptFor` 取同一份候选**，不自己再算一遍。
AI_HOOK_PATH = os.path.normpath(os.path.join("src", "client", "hooks", "useWorkbenchAISessions.ts"))
AI_HOOK = load(AI_HOOK_PATH)
check("const planPromptPayload = planPromptFor(planAnchor)" in AI_HOOK,
      "startAISession('plan') 仍取同一份候选（经 planPromptFor 注入，而不是自己再算一遍）")
check("const planPromptPayload = planPromptFor(planAnchor)" not in INDEX,
      "入口不再有第二份 planPromptFor 消费点（判据跟着 owner 走）")
check("const dayPanelProps = {" in INDEX and "    ...dayPanel,\n" in INDEX,
      "dayPanelProps 组装留在装配层（跨任务数据域 / 列表域 / 导航域）")
check("onClearPlan: () => void clearPlan(dayPanel.day)" in INDEX,
      "清空计划的内联 api 已提成 hook 动作，装配层只注入")
check("onDelete: () => { if (currentReport !== null) void deleteReport(currentReport) }" in INDEX,
      "删除报告的内联 api 已提成 hook 动作，装配层只注入")
check("setPendingDraft(null); bumpPlanRefresh(); bumpReportRefresh();" in UI_OVERLAYS,
      "草稿域 onDone 的跨域刷新走两个 bump 动作（不再直接写 refreshKey；P7-2 起在 app/WorkbenchOverlays.tsx）")
for keep in ["    tab: dayTab,\n    onTabChange: setDayTab,\n",
             "    schedulingTaskId: addingPlanTaskId,\n",
             "    onScheduleToday: dayPanel.isToday ? (taskId: string) => void addTaskToPlan(taskId) : undefined,\n"]:
    check(keep in INDEX, f"装配层原文保持：`{keep.strip()[:44]}`")
check("const reparentCandidates = useMemo(" in INDEX,
      "reparentCandidates 仍在入口（切块时绝不能被本批带走）")
check(bare(None, "reparentCandidates") >= 2, "reparentCandidates 仍被装配层使用（不是死代码）")
# ⚠️ 判据跟着 owner 走（D17/P7-1 口径修正）：两个 settings 写入的**请求本体**已归设置域
#（src/client/hooks/useWorkbenchSettings.ts）—— 装配层体内不许再有 api(。入口只留
# `saveDailyCapacity` 的装配层半边（读日期域的行内编辑态、把原文递进设置域）。
check("const saveDailyCapacity = async (): Promise<void> =>" in INDEX
      and "const saveDailyCapacity = async (rawEdit: string): Promise<void> =>" in SETTINGS_HOOK
      and "const saveIncludeOverdue = async (next: boolean): Promise<void> =>" not in INDEX
      and "const saveIncludeOverdue = async (next: boolean): Promise<void> =>" in SETTINGS_HOOK,
      "两个 settings 写入：请求本体归设置域（D17/P7-1），入口只留 saveDailyCapacity 的装配层半边")
check("const raw = day.capacityEdit === null ? '' : day.capacityEdit.trim()" in INDEX and
      "day.actions.setCapacityEdit(null)" in INDEX,
      "saveDailyCapacity 只读日期域的 capacityEdit（写入仍归设置域）")
for route in ["/today", "/calendar", "/api/workbench/settings"]:
    check(route not in HOOK, f"hook 里没有别域的 `{route}`")

print(f"\n结果：{'全部通过' if not failures else str(len(failures)) + ' 项不通过'}")
sys.exit(1 if failures else 0)
