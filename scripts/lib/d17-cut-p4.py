# -*- coding: utf-8 -*-
"""D17 / P4 一次性搬迁：把日期域（今日/日历/日期面板）从 src/client/index.tsx
切进 hooks/useDayWorkspace.ts，并把两块 JSX 提成 views/TodayPane.tsx 与 views/CalendarView.tsx。

房屋风格同 d17-cut-p3c.py / d17-cut-p3d.py：所有断言先跑完，problems 为空才落盘。
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
    """删除 [start .. end] 这段（含两端标记），用 new 替代。两端标记都必须恰好出现 1 次。"""
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


src = INDEX.read_text(encoding="utf-8")
if "\r\n" in src:
    problems.append("index.tsx 含 CRLF，先转成 LF 再搬")
orig_len = len(src.splitlines())

# ---------------------------------------------------------------- 1. imports
src = replace_once(
    src,
    "import { useTaskData } from './hooks/useTaskData.js'\n",
    "import { useTaskData } from './hooks/useTaskData.js'\n"
    "import { useDayWorkspace } from './hooks/useDayWorkspace.js'\n",
    "import useDayWorkspace",
)
src = replace_once(
    src,
    "import { TaskCreateModal, TaskEditModal } from './views/TaskFormModal.js'\n",
    "import { TaskCreateModal, TaskEditModal } from './views/TaskFormModal.js'\n"
    "import { TodayPane } from './views/TodayPane.js'\n"
    "import { CalendarView } from './views/CalendarView.js'\n",
    "import TodayPane / CalendarView",
)

# ------------------------------------------------- 2. 删掉 17 项 state 的声明
src = replace_once(
    src,
    "  /** 今日容量里「可投入时长」的行内编辑态（null = 只读展示） */\n"
    "  const [capacityEdit, setCapacityEdit] = useState<string | null>(null)\n"
    "  /** 「规则与账本」面板是否展开（纯展示态，不影响任何计算）。 */\n"
    "  const [capacityExpanded, setCapacityExpanded] = useState(false)\n",
    "  // 日期域（D17/P4）：`capacityEdit` / `capacityExpanded` 已收进 hooks/useDayWorkspace.ts\n",
    "del capacityEdit/capacityExpanded state",
)
src = replace_once(
    src,
    "  const [reportSubTab, setReportSubTab] = useState<'day' | 'week'>('day')\n"
    "  const [currentReport, setCurrentReport] = useState<TaskReportView | null>(null)\n"
    "  const [reportSession, setReportSession] = useState<{ sessionId: string } | null>(null)\n"
    "  const [pickedPlan, setPickedPlan] = useState<DailyPlanView | null>(null)\n"
    "  const [pickedPlanSession, setPickedPlanSession] = useState<{ sessionId: string } | null>(null)\n"
    "  const [planRefreshKey, setPlanRefreshKey] = useState(0)\n",
    "  // 日期域（D17/P4）：报告 / 选中日计划的 6 项状态已收进 hooks/useDayWorkspace.ts\n",
    "del report/plan states",
)
src = replace_once(
    src,
    "  const [reportRefreshKey, setReportRefreshKey] = useState(0)\n"
    "  const [todayPlanSession, setTodayPlanSession] = useState<{ sessionId: string } | null>(null)\n",
    "  // 日期域（D17/P4）：`reportRefreshKey` / `todayPlanSession` 已收进 hooks/useDayWorkspace.ts\n",
    "del reportRefreshKey/todayPlanSession",
)
src = replace_once(
    src,
    "  // 今日/日历/列表三棵树：默认全部收起\n"
    "  const [todayExpanded, setTodayExpanded] = useState<Set<string>>(new Set())\n"
    "  const [calendarExpanded, setCalendarExpanded] = useState<Set<string>>(new Set())\n",
    "  // 日期域（D17/P4）：今日/日历两棵树的展开集合已收进 hooks/useDayWorkspace.ts\n",
    "del todayExpanded/calendarExpanded",
)

# --------------------------------------------- 3. 两个展开开关 + collapseAll
src = replace_once(
    src,
    "  const toggleTodayExpanded = (id: string): void => setTodayExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })\n"
    "  const toggleCalendarExpanded = (id: string): void => setCalendarExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })\n"
    "  const collapseAll = (): void => { taskList.actions.clearExpanded(); setTodayExpanded(new Set()); setCalendarExpanded(new Set()) }\n",
    "  /**\n"
    "   * 收起全部（跨域组合，按设计 §4.1 第 148 行留在装配层）：\n"
    "   * 列表域那棵交给它自己的 `clearExpanded()`，今日/日历两棵交给日期域。\n"
    "   */\n"
    "  const collapseAll = (): void => { taskList.actions.clearExpanded(); day.actions.collapseExpanded() }\n",
    "toggles + collapseAll",
)

# ------------------------------------- 4. 插入 useDayWorkspace，删掉日期域实现块
DAY_CALL = """  /**
   * D17 / P4：日期域（今日视图 / 日历视图 / 右侧日期面板）的唯一所有者。
   *
   * 17 项 state、只读派生（候选快照 / 容量账本 / 报告锚点 / 周与月网格 / dayPanel）与域动作都收在
   * `hooks/useDayWorkspace.ts`。调用点选在这里（原 `picked` 的声明处）是因为入参 `now` /
   * `todayPlan` / `taskList.archivedTasks` 到这里都已可用；两个注入回调是反馈域的
   * `setError` / `setNotice`，`refresh` 来自任务数据域（计划写入成功后必须重拉 bootstrap 才生效）。
   */
  const day = useDayWorkspace({
    view,
    now,
    tasks,
    archivedTasks: taskList.archivedTasks,
    todayPlan,
    dailyCapacityMinutes: settings.dailyCapacityMinutes,
    defaultEstimateMinutes: settings.defaultEstimateMinutes,
    dailyCapacityIncludeOverdue: settings.dailyCapacityIncludeOverdue,
    refresh,
    onError: setError,
    onNotice: setNotice,
  })
  const {
    capacity, capacityEdit, capacityExpanded, reportSubTab, currentReport, reportSession, reportAnchor,
    reportIsFuture, pickedPlan, picked, addingPlanTaskId, cursor, calMode, dayTab, weekDays, monthGrid,
    dayPanel, planPromptFor,
  } = day
  const {
    addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, moveWeek, moveMonth, setPicked,
    setCalMode, setCursor, setDayTab, setReportSubTab, setCapacityEdit, setCapacityExpanded,
    bumpPlanRefresh, bumpReportRefresh,
  } = day.actions
"""
src = cut_between(
    src,
    "  /**\n   * 日历选中日（`picked` / `pickedAnchor`）在**这里**声明",
    "  const pickedAnchor = localDateString(picked)\n",
    DAY_CALL,
    "insert useDayWorkspace",
)

# 候选快照 → 容量账本 → addTaskToPlan → patchPlanItem（`save*` 两个设置写入保留）
src = cut_between(
    src,
    "  /**\n   * 当日候选快照（唯一实现见 `shared/dailyPlanPolicy.ts#planCandidates`）。",
    "  /**\n   * 逾期口径开关（「今日容量 → 规则」面板与设置页**写同一个 settings 键**）。",
    "  // 日期域（D17/P4）：候选快照 / 容量账本 / `addTaskToPlan` / `patchPlanItem` 等派生与动作\n"
    "  // 已收进 hooks/useDayWorkspace.ts。\n"
    "  // ⚠️ 下面两个 `save*` 写的是 **settings**（设置域的唯一权威源，P6 才搬），刻意留在这里。\n"
    "  /**\n"
    "   * 逾期口径开关（「今日容量 → 规则」面板与设置页**写同一个 settings 键**）。",
    "del candidates/capacity/addTaskToPlan/patchPlanItem",
)

# `savePlan` + 周月日历 state + 报告锚点 + 三个加载 effect
# ⚠️ 结束标记必须是 `reparentCandidates` —— 它夹在这一段与 `weekDays` 之间，**不能**被带走。
src = cut_between(
    src,
    "  /**\n   * 全量保存（手动编辑顺序/备注/计划投入）。",
    "  /**\n   * 「改父任务」选择项的候选列表（v1.14.0）。",
    "  // 日期域（D17/P4）：`savePlan` / 周月日历状态 / 报告锚点与 `reportIsFuture` / 三个加载 effect\n"
    "  // 都已收进 hooks/useDayWorkspace.ts。\n"
    "  /**\n"
    "   * 「改父任务」选择项的候选列表（v1.14.0）。",
    "del savePlan + calendar states + effects",
)

# 周月网格 + useDayPanelModel + dayTab 复位 effect
src = cut_between(
    src,
    "  const weekDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(cursor); d.setDate(d.getDate() + i); return d })\n",
    '  /**\n   * 两个入口**共用的一份面板 props**（今日与日历只差"哪一天"，而那已由 `dayPanel` 给出）。',
    "  // 日期域（D17/P4）：`weekDays` / `moveWeek` / `monthGrid` / `moveMonth` / `useDayPanelModel`\n"
    "  // 调用 / dayTab 复位 effect 都已收进 hooks/useDayWorkspace.ts。\n"
    "  /**\n"
    '   * 两个入口**共用的一份面板 props**（今日与日历只差"哪一天"，而那已由 `dayPanel` 给出）。',
    "del weekGrids + dayPanel + tab reset",
)

# ------------------------------------------- 5. 设置域写入改读日期域的解构名
src = replace_once(
    src,
    "const raw = capacityEdit === null ? '' : capacityEdit.trim()\n    setCapacityEdit(null)",
    "const raw = day.capacityEdit === null ? '' : day.capacityEdit.trim()\n    day.actions.setCapacityEdit(null)",
    "saveDailyCapacity 读日期域",
)

# ------------------------------------------------- 6. dayPanelProps 装配改写
src = replace_once(
    src,
    "    onClearPlan: () => {\n"
    "      void api(`/api/workbench/plans/${dayPanel.day}`, { method: 'DELETE' })\n"
    "        .then(() => { setPlanRefreshKey((v) => v + 1); setNotice('该日计划已清除') })\n"
    "        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))\n"
    "    },\n",
    "    onClearPlan: () => void clearPlan(dayPanel.day),\n",
    "dayPanelProps onClearPlan",
)
src = replace_once(
    src,
    "      onDelete: () => {\n"
    "        if (currentReport === null) return\n"
    "        void api(`/api/workbench/reports/${currentReport.periodCode}/${currentReport.periodStart}`, { method: 'DELETE' })\n"
    "          .then(() => { setCurrentReport(null); setReportSession(null); void refresh() })\n"
    "          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))\n"
    "      },\n",
    "      onDelete: () => { if (currentReport !== null) void deleteReport(currentReport) },\n",
    "dayPanelProps report.onDelete",
)
# 断言：装配层这几处**保持原文**（只换来源，不改调用点文本）
for anchor in (
    "    tab: dayTab,\n    onTabChange: setDayTab,\n",
    "    schedulingTaskId: addingPlanTaskId,\n",
    "    onScheduleToday: dayPanel.isToday ? (taskId: string) => void addTaskToPlan(taskId) : undefined,\n",
    "    onEffortChange: (taskId: string, next: boolean) => patchPlanItem(dayPanel.day, taskId, { effortDone: next }),\n",
    "    onSavePlan: (items: Array<{ taskId: string; note: string; minutes?: number }>) => savePlan(dayPanel.day, items),\n",
    "      subTab: reportSubTab,\n      onSubTabChange: setReportSubTab,\n      isFuture: reportIsFuture,\n      current: currentReport,\n      sessionActive: reportSession !== null,\n",
):
    src = replace_once(src, anchor, anchor, f"装配层原文保持: {anchor.strip()[:34]}")

# ------------------------------------------------- 7. 装配层其它跨域引用点
src = replace_once(
    src,
    "      const planPromptPayload = planCandidateInfo.promptFor(planAnchor)\n",
    "      const planPromptPayload = planPromptFor(planAnchor)\n",
    "startAISession 用 planPromptFor",
)
src = replace_once(
    src,
    "          : pickedPlan !== null && pickedPlan.planDate === planAnchor\n",
    "          : pickedPlan !== null && pickedPlan.planDate === planAnchor\n",
    "startAISession pickedPlan 锚",
)
src = replace_once(
    src,
    "        onDone={() => { setPendingDraft(null); setPlanRefreshKey((v) => v + 1); setReportRefreshKey((v) => v + 1); knowledge.bumpRefreshKey(); ideas.actions.refresh(); void refresh() }}\n",
    "        onDone={() => { setPendingDraft(null); bumpPlanRefresh(); bumpReportRefresh(); knowledge.bumpRefreshKey(); ideas.actions.refresh(); void refresh() }}\n",
    "draft onDone 的跨域刷新",
)

# ------------------------------------------------------- 8. 两块视图 JSX 提组件
TODAY_JSX = """          {view === 'today' && (
            <TodayPane
              stats={bootstrap?.stats}
              capacity={capacity}
              capacityEdit={capacityEdit}
              dailyCapacityMinutes={settings.dailyCapacityMinutes}
              defaultEstimateMinutes={settings.defaultEstimateMinutes}
              includeOverdue={settings.dailyCapacityIncludeOverdue}
              capacityExpanded={capacityExpanded}
              onCapacityEditStart={() => setCapacityEdit(String(settings.dailyCapacityMinutes))}
              onCapacityEditChange={setCapacityEdit}
              onCapacityEditCommit={() => void saveDailyCapacity()}
              onCapacityEditCancel={() => setCapacityEdit(null)}
              onIncludeOverdueChange={(next) => void saveIncludeOverdue(next)}
              onCapacityExpandedChange={setCapacityExpanded}
              onAddToPlan={addTaskToPlan}
              addingTaskId={addingPlanTaskId}
              dayPanelProps={dayPanelProps}
              onQuickEntry={openQuickEntry}
              onNewTask={() => forms.actions.toggleCreate()}
            />
          )}
"""
CALENDAR_JSX = """          {view === 'calendar' && (
            <CalendarView
              calMode={calMode}
              cursor={cursor}
              now={now}
              picked={picked}
              weekDays={weekDays}
              monthGrid={monthGrid}
              tasks={tasks}
              dayPanelProps={dayPanelProps}
              onMoveWeek={moveWeek}
              onMoveMonth={moveMonth}
              onToday={() => (calMode === 'week' ? setCursor(startOfWeek(now)) : setCursor(new Date(now.getFullYear(), now.getMonth(), 1)))}
              onPick={setPicked}
              onCalModeChange={setCalMode}
              onStartPlanAISession={(d) => void startAISession('plan', null, d)}
              readOnly={dayPanel.readOnly}
              day={dayPanel.day}
            />
          )}
"""
KNOWLEDGE_LINE = "          {view === 'knowledge' && <KnowledgeListView"
src = cut_between(
    src,
    "          {view === 'today' && (\n",
    KNOWLEDGE_LINE,
    TODAY_JSX + CALENDAR_JSX + "\n" + KNOWLEDGE_LINE,
    "两块视图 JSX 提组件",
)

# ------------------------------------------------------------------ 9. 落盘
if problems:
    print("❌ 未落盘，问题如下：")
    for p in problems:
        print("   -", p)
    raise SystemExit(1)

INDEX.write_text(src, encoding="utf-8")
print(f"✅ index.tsx: {orig_len} -> {len(src.splitlines())} 行")
