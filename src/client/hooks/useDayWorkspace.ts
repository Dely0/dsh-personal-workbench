/**
 * D17 / P4：**日期域（DayWorkspace）的唯一所有者**。
 *
 * 拆分前这些 state / 派生 / 动作散在 `src/client/index.tsx` 的 `WorkbenchApp` 里（今日视图、日历视图
 * 与右侧日期面板三处共用）。本 hook 收口的是**日期与计划/报告这一域**：
 *
 * - 17 项 state：`capacityEdit` / `capacityExpanded` / `reportSubTab` / `currentReport` / `reportSession` /
 *   `pickedPlan` / `pickedPlanSession` / `planRefreshKey` / `reportRefreshKey` / `todayPlanSession` /
 *   `todayExpanded` / `calendarExpanded` / `picked` / `addingPlanTaskId` / `cursor` / `calMode` / `dayTab`。
 * - 只读派生：`pickedAnchor` / `reportAnchor` / `reportScope` / `todayAnchor` / `thisWeekAnchor` / `reportIsFuture` /
 *   `weekDays` / `monthGrid` / `capacity` / `planCandidateInfo` / 两个截断提示 / 两份候选行 / `dayPanel`。
 * - 域动作：`addTaskToPlan` / `patchPlanItem` / `savePlan` / `clearPlan` / `deleteReport` /
 *   `toggleTodayExpanded` / `toggleCalendarExpanded` / `moveWeek` / `moveMonth` / 一组语义化 setter /
 *   `bumpPlanRefresh` / `bumpReportRefresh`。
 *
 * ## 刻意**不**拥有的东西（跨域，按设计 §5 由装配层组合或注入）
 * - **设置写入**：`saveIncludeOverdue` / `saveDailyCapacity` 写的是 `settings`（唯一权威源在设置域，
 *   P6 才搬），所以留在装配层 —— 本 hook 只把 `capacityEdit` 暴露出去给它们读。
 * - **AI 会话发起**：`onSort`（AI 智能排序）与报告生成都调 `startAISession`（会话域）。
 * - **导航**：本 hook 不碰 `setView`；`view` 只是入参（报告锚点与加载闸门要按当前视图判断）。
 * - **`todayPlan`**：它来自 `bootstrap.todayPlan`（任务数据域），**不在这里复制一份可写今日计划**
 *   （设计文档第 127 行）。
 * - **`dayPanelProps` 装配**：它同时混入任务数据域（`tasks`/`dicts`/`selected`/`pending`/`childrenOf`）、
 *   列表域（`busy`）、会话域（`onSort`/`onGenerate`）与本域值，按设计第 148 行"跨域组合归装配层"
 *   留在 `index.tsx`；本 hook 只交出 `dayPanel` 与几个日期动作。
 * - **`refresh`**：它是任务数据域的动作（`useTaskData`），本 hook 通过注入回调使用它 ——
 *   今日计划的写入路径（`POST /plans/:date/items`）成功后必须重新拉 bootstrap 才算生效。
 *
 * ## 与 `useDayPanelModel` 的关系
 * 日期面板的**树口径**（当日到期 ∪ 当日计划项 ∪ 进行中）与逐条标来源是既有共享实现
 * （`dayPanelModel.ts` + `shared/dailyPlanPolicy.ts`），本 hook 只是把它需要的那一组输入
 * （两份展开集合、两份截断提示、两个锚点）算好传进去，**没有第二份判定**。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { capacityTodayKey, computeTodayCapacity, todayPlanCandidates } from '../capacity.js'
import { useDayPanelModel, type DayPanelModel } from '../dayPanelModel.js'
import { buildPlanPrompt, type PlanPromptPayload } from '../dailyPlanPrompt.js'
import { resolveDayPanelTab } from '../../shared/dailyPlanPolicy.js'
// ⚠️ 这三个日历口径的纯助手**必须**用 `format.ts` 里的共享实现：`startOfWeek` 是**周一**为首日
// （`- ((getDay()+6)%7)`），自己另写一份（周日首日）会让周导航与报告锚点整体偏移一天。
import { localDateString, startOfDay, startOfWeek } from '../format.js'
import type { CapacityLedger } from '../capacity.js'
import type { DayTab } from '../components/DayPanel.js'
import type { DailyPlanView, Task, TaskReportView } from '../viewTypes.js'
import type { WorkbenchView } from '../app/contracts.js'

/** 报告子页签（日/周）。 */
export type ReportSubTab = 'day' | 'week'

export type UseDayWorkspaceInput = {
  /** 当前视图：报告锚点与"要不要拉报告"的闸门都按它判断（`today` 用今天，`calendar` 用选中日）。 */
  view: WorkbenchView
  /** 渲染期的"现在"。刻意**不进** memo 依赖数组 —— 依赖用 `capacityTodayKey(now)`（见 `capacity` 注释）。 */
  now: Date
  tasks: Task[]
  /** 列表域的归档任务（容量计算要全量输入，见 `capacity` 注释 2）。 */
  archivedTasks: Task[]
  /** 今日计划来自 `bootstrap.todayPlan`（任务数据域），这里只读。 */
  todayPlan: DailyPlanView | null
  dailyCapacityMinutes: number
  defaultEstimateMinutes: number
  dailyCapacityIncludeOverdue: boolean
  /** 任务数据域的 `refresh`：计划/报告写入成功后重新拉 bootstrap。 */
  refresh: () => Promise<void>
  onError: (message: string) => void
  onNotice: (message: string) => void
}

export type UseDayWorkspaceActions = {
  /** 行内「排入今日」的唯一写入口（`POST /plans/:date/items`，服务端原子追加）。 */
  addTaskToPlan: (taskId: string, minutes?: number) => Promise<void>
  /** 项级更新（`PATCH /plans/:date/items/:taskId`）。 */
  patchPlanItem: (date: string, taskId: string, patch: { minutes?: number; effortDone?: boolean }) => Promise<void>
  /** 全量保存（`PUT /plans/:date`，手动编辑顺序/备注/计划投入）。 */
  savePlan: (date: string, items: Array<{ taskId: string; note: string; minutes?: number }>) => Promise<void>
  /** 清除某日计划（`DELETE /plans/:date`）。 */
  clearPlan: (date: string) => Promise<void>
  /** 删除一份报告（`DELETE /reports/:periodCode/:periodStart`）。 */
  deleteReport: (report: TaskReportView) => Promise<void>
  toggleTodayExpanded: (taskId: string) => void
  toggleCalendarExpanded: (taskId: string) => void
  /** 收起今日与日历两棵树（列表域那棵由它自己的 `clearExpanded()` 负责，见装配层的 `collapseAll`）。 */
  collapseExpanded: () => void
  moveWeek: (delta: number) => void
  moveMonth: (delta: number) => void
  setCapacityEdit: (value: string | null) => void
  setCapacityExpanded: (expanded: boolean) => void
  setReportSubTab: (tab: ReportSubTab) => void
  setPicked: (date: Date) => void
  setCursor: (date: Date) => void
  setCalMode: (mode: 'week' | 'month') => void
  setDayTab: (tab: DayTab) => void
  /** 让日历选中日的计划重新拉取（草稿落盘后的跨域刷新用）。 */
  bumpPlanRefresh: () => void
  /** 让报告重新拉取（同上）。 */
  bumpReportRefresh: () => void
}

export type UseDayWorkspaceResult = {
  capacity: CapacityLedger
  capacityEdit: string | null
  capacityExpanded: boolean
  reportSubTab: ReportSubTab
  currentReport: TaskReportView | null
  reportSession: { sessionId: string } | null
  reportAnchor: string
  reportIsFuture: boolean
  todayAnchor: string
  pickedPlan: DailyPlanView | null
  todayExpanded: Set<string>
  calendarExpanded: Set<string>
  picked: Date
  pickedAnchor: string
  addingPlanTaskId: string | null
  cursor: Date
  calMode: 'week' | 'month'
  dayTab: DayTab
  weekDays: Date[]
  monthGrid: Date[]
  dayPanel: DayPanelModel
  /**
   * 为指定日期拼 AI 排序提示词（`startAISession('plan', …)` 在装配层调用，所以必须导出）。
   *
   * 它与发起窗口里的"另有 N 条未列出"是**同一次判定**的产物 —— 导出的是同一个闭包，
   * 不是"再造一份候选"（需求 §5.1：发起窗口与提示词不许各算一遍）。
   */
  planPromptFor: (planDate: string) => PlanPromptPayload
  actions: UseDayWorkspaceActions
}

export function useDayWorkspace(input: UseDayWorkspaceInput): UseDayWorkspaceResult {
  const {
    view, now, tasks, archivedTasks, todayPlan,
    dailyCapacityMinutes, defaultEstimateMinutes, dailyCapacityIncludeOverdue,
    refresh, onError, onNotice,
  } = input

  /** 今日容量里「可投入时长」的行内编辑态（null = 只读展示） */
  const [capacityEdit, setCapacityEdit] = useState<string | null>(null)
  /** 「规则与账本」面板是否展开（纯展示态，不影响任何计算）。 */
  const [capacityExpanded, setCapacityExpanded] = useState(false)
  const [reportSubTab, setReportSubTab] = useState<ReportSubTab>('day')
  const [currentReport, setCurrentReport] = useState<TaskReportView | null>(null)
  const [reportSession, setReportSession] = useState<{ sessionId: string } | null>(null)
  const [pickedPlan, setPickedPlan] = useState<DailyPlanView | null>(null)
  const [pickedPlanSession, setPickedPlanSession] = useState<{ sessionId: string } | null>(null)
  const [planRefreshKey, setPlanRefreshKey] = useState(0)
  const [reportRefreshKey, setReportRefreshKey] = useState(0)
  const [todayPlanSession, setTodayPlanSession] = useState<{ sessionId: string } | null>(null)
  // 今日/日历/列表三棵树：默认全部收起
  const [todayExpanded, setTodayExpanded] = useState<Set<string>>(new Set())
  const [calendarExpanded, setCalendarExpanded] = useState<Set<string>>(new Set())
  /**
   * 日历选中日（`picked` / `pickedAnchor`）在**这里**声明，而不是紧跟下面的日历状态块：
   * `planCandidateInfo` 要用它决定"当日候选吃哪一份计划"，而 memo 必须在同一处收口
   * （组件里同样的量声明两遍就是下一个 bug）。
   */
  const [picked, setPicked] = useState<Date>(() => startOfDay(now))
  const pickedAnchor = localDateString(picked)

  const toggleTodayExpanded = (id: string): void => setTodayExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const toggleCalendarExpanded = (id: string): void => setCalendarExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })

  /**
   * 当日候选快照（唯一实现见 `shared/dailyPlanPolicy.ts#planCandidates`）。
   *
   * 为什么在**渲染期**算而不是在 `startAISession` 里算：
   * 1. 发起窗口必须能显示"另有 N 条未列出"，而那句话与提示词里的候选必须**同一次判定**
   *    （两处各算一遍正是本项目最大的 bug 类别）；
   * 2. `startAISession` 是事件处理器，渲染期算出来的快照直接可用，不必再存一份 state。
   *
   * 口径：候选只吃"全量任务 + 该日计划 + 逾期开关"。重复任务的**模板行**被排除
   * （模板不是今天要做的事；实例由 createTask 生成时不带 recurrenceCode，照常可排）。
   */
  const planCandidateInfo = useMemo(() => {
    const todayKey = capacityTodayKey(now)
    const pinnedKey = pickedAnchor
    const planOf = (date: string): DailyPlanView | null => (date === todayKey ? todayPlan : (date === pinnedKey ? pickedPlan : null))
    const candidatesFor = (date: string) => todayPlanCandidates({
      // 排除重复任务的**模板**行（模板不是今天要做的事；实例由 createTask 生成时
      // 不带 recurrenceCode，因此照常可排）。
      tasks: tasks.filter((t) => t.recurrenceCode === null || t.recurrenceCode === 'none'),
      plan: planOf(date),
      includeOverdue: input.dailyCapacityIncludeOverdue,
      defaultEstimateMinutes: input.defaultEstimateMinutes,
      now,
    })
    return {
      /**
       * 为指定日期拼提示词。候选与"另有 N 条未列出"的提示**同一次判定**产出，
       * 发起窗口与提示词不许各算一遍（需求 §5.1）。
       */
      promptFor: (planDate: string) => {
        const result = candidatesFor(planDate)
        return buildPlanPrompt({
          planDate,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          existingPlanCount: planOf(planDate)?.items.length ?? 0,
        })
      },
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- now 用日键代替（见 capacity 的同样注释）
  }, [tasks, todayPlan, pickedPlan, pickedAnchor, dailyCapacityIncludeOverdue, defaultEstimateMinutes, capacityTodayKey(now)])

  /**
   * 今日候选的截断提示（**同一次判定**的产物，不再算一遍）。
   *
   * 只有"另有 N 条未列出"这一件事：候选满 31 条时发起窗口必须显式告知，
   * 否则用户会以为这 30 条就是全部（需求 §5.1、AX-C02）。
   */
  const todayPromptInfo = useMemo(() => {
    const payload = planCandidateInfo.promptFor(capacityTodayKey(now))
    return { truncated: payload.truncated, notice: payload.notice, omitted: payload.omitted, total: payload.total }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- now 用日键代替
  }, [planCandidateInfo, capacityTodayKey(now)])

  /** 今日手动"添加任务"的候选行（**同一份** `planCandidates` 输出，不另写过滤）。 */
  const todayPlanCandidateRows = useMemo(() => todayPlanCandidates({
    tasks: tasks.filter((t) => t.recurrenceCode === null || t.recurrenceCode === 'none'),
    plan: todayPlan,
    includeOverdue: dailyCapacityIncludeOverdue,
    defaultEstimateMinutes,
    now,
  }).candidates.map((candidate) => ({ id: candidate.taskId, title: candidate.title })),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- now 用日键代替
  [tasks, todayPlan, dailyCapacityIncludeOverdue, defaultEstimateMinutes, capacityTodayKey(now)])

  /** 日历选中日的同一份提示（切到该日时显示"另有 N 条未列出"）。 */
  const pickedPromptInfo = useMemo(() => {
    const payload = planCandidateInfo.promptFor(pickedAnchor)
    return { truncated: payload.truncated, notice: payload.notice, omitted: payload.omitted, total: payload.total }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- now 用日键代替
  }, [planCandidateInfo, pickedAnchor, capacityTodayKey(now)])

  /** 日历选中日手动"添加任务"的候选行（同上，同一份候选函数）。 */
  const pickedPlanCandidateRows = useMemo(() => todayPlanCandidates({
    tasks: tasks.filter((t) => t.recurrenceCode === null || t.recurrenceCode === 'none'),
    plan: pickedPlan,
    includeOverdue: dailyCapacityIncludeOverdue,
    defaultEstimateMinutes,
    now,
  }).candidates.map((candidate) => ({ id: candidate.taskId, title: candidate.title })),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- now 用日键代替
  [tasks, pickedPlan, dailyCapacityIncludeOverdue, defaultEstimateMinutes, capacityTodayKey(now)])

  /**
   * 今日容量（唯一权威源 = 纯函数模块 `capacity.ts`）。
   *
   * 三条别改回去的接线细节：
   * 1. **`now` 不能进依赖数组** —— 它是渲染体内每帧新建的对象，放进去等于 memo 每帧失效
   *    （跨天刷新才有必要重算，同一帧里 now 变了也不会引起重渲染）。
   *    依赖改成 `capacityTodayKey(now)`（YYYY-MM-DD 本地日字符串，跨天才变）。
   * 2. **传全量列表、函数内自己过滤**：`input.archivedTasks`（装配层的 `taskList.archivedTasks`）只有打开"查看归档"时才加载，
   *    它为空数组不影响结果（归档任务本就不进容量），也不会出现"同一语义两处算"。
   * 3. 逾期口径与默认耗时的**唯一来源是 settings**，页面不另存副本、不自己算一遍。
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖用下面的日字符串代替 now，见注释 1
  const capacity = useMemo(
    () => computeTodayCapacity({
      tasks: [...tasks, ...archivedTasks],
      plan: todayPlan === null ? null : { ...todayPlan, readable: todayPlan.readable !== false },
      dailyCapacityMinutes,
      defaultEstimateMinutes,
      includeOverdue: dailyCapacityIncludeOverdue,
      now,
    }),
    [tasks, archivedTasks, todayPlan, dailyCapacityMinutes, defaultEstimateMinutes, dailyCapacityIncludeOverdue, capacityTodayKey(now)],
  )

  /**
   * 「一键排入」——**唯一入口**是 `POST /plans/:date/items`（服务端原子追加）。
   *
   * 为什么不能像旧代码那样"把本地列表拼一拼再 PUT 整份计划"：
   * PUT 是全量替换，会把别的窗口/并发追加刚加进去的成员**覆盖掉**（真实丢件）。
   * 所以这里只发一条 taskId（+ 可选 minutes），服务端在事务里读最新计划后追加。
   * 失败保持原显示并给出中文原因，绝不假成功。
   */
  const [addingPlanTaskId, setAddingPlanTaskId] = useState<string | null>(null)
  const addTaskToPlan = async (taskId: string, minutes?: number): Promise<void> => {
    setAddingPlanTaskId(taskId)
    try {
      const res = await api<{ plan: DailyPlanView | null; added: boolean }>(`/api/workbench/plans/${localDateString()}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(minutes === undefined ? { taskId } : { taskId, minutes }),
      })
      await refresh()
      setPlanRefreshKey((v) => v + 1)
      /**
       * 回执里**回显最终落库的投入分钟**（省略 `minutes` 时是服务端按"任务预计耗时 / 设置默认投入"
       * 算出来的快照）。只写"已排入"不给数字，就是让用户去猜服务端替他决定了什么。
       */
      const landed = res.plan?.items.find((item) => item.taskId === taskId)
      const minutesText = typeof landed?.minutes === 'number' ? `（投入 ${landed.minutes} 分钟）` : ''
      onNotice(res.added ? `已排入今日计划${minutesText}` : '这条任务已经在今日计划里了（未改动原有投入与结束状态）')
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setAddingPlanTaskId(null)
    }
  }

  /**
   * 项级更新（今日投入结束 / 继续投入 / 改计划投入）——走
   * `PATCH /plans/:date/items/:taskId`，**只动目标项**，不用本地缓存的整份计划覆盖。
   *
   * 失败必须可读且不假成功：`refresh()` 不会在失败时被调用，界面保持原值并显示中文错误。
   */
  const patchPlanItem = async (date: string, taskId: string, patch: { minutes?: number; effortDone?: boolean }): Promise<void> => {
    try {
      await api(`/api/workbench/plans/${date}/items/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      await refresh()
      setPlanRefreshKey((v) => v + 1)
      if (patch.effortDone === true) onNotice('今日投入已结束（任务状态、进度、截止与估时都没变）')
      else if (patch.effortDone === false) onNotice('已继续投入')
      else onNotice('计划投入已更新')
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  /**
   * 全量保存（手动编辑顺序/备注/计划投入）。
   *
   * `minutes` **只在用户显式填了才发**（`undefined` = 省略）：服务端按 taskId 合并
   * 服务端最新值，所以"只改备注"不会抹掉既有 minutes 与今日结束状态（AX-D03）。
   */
  const savePlan = async (date: string, items: Array<{ taskId: string; note: string; minutes?: number }>): Promise<void> => {
    try {
      await api(`/api/workbench/plans/${date}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: items.map((item, index) => ({
            taskId: item.taskId,
            order: index + 1,
            note: item.note,
            ...(item.minutes === undefined ? {} : { minutes: item.minutes }),
          })),
        }),
      })
      await refresh()
      setPlanRefreshKey((v) => v + 1)
      onNotice('计划已保存（来源：手动编辑）')
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  /** 清除某日计划（原装配层内联的 `onClearPlan`）。 */
  const clearPlan = async (date: string): Promise<void> => {
    try {
      await api(`/api/workbench/plans/${date}`, { method: 'DELETE' })
      /**
       * **必须重新拉 bootstrap**：`todayPlan` 来自 `bootstrap`，而 `planRefreshKey` 只驱动
       * 「日历视图选中日」的 `pickedPlan`（那个 effect 在 `view !== 'calendar'` 时直接 return）。
       * 2026-10-05 实测缺陷：只 bump key 的话，在「今日」实例上清除计划后卡片与被排期的任务
       * 全都还在（容量账本与页签成员也都从 `todayPlan` 派生，一起不刷）。
       * 判据见 `test/dayPanelWiring.test.mjs`「清除某日计划只有一处实现」那条。
       */
      await refresh()
      setPlanRefreshKey((v) => v + 1)
      onNotice('该日计划已清除')
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 删除一份报告（原装配层内联的 `report.onDelete`）。 */
  const deleteReport = async (report: TaskReportView): Promise<void> => {
    try {
      await api(`/api/workbench/reports/${report.periodCode}/${report.periodStart}`, { method: 'DELETE' })
      setCurrentReport(null)
      setReportSession(null)
      await refresh()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  // 周/月日历
  const [cursor, setCursor] = useState<Date>(() => startOfWeek(now))
  const [calMode, setCalMode] = useState<'week' | 'month'>('week')
  const [dayTab, setDayTab] = useState<DayTab>('plan')
  /**
   * 报告锚点跟着**当前面板选中的那一天**走（批次2 D15）：
   * 今日视图看今天的报告，日历视图看选中那天的报告 —— 与树的锚点是同一个来源。
   */
  const reportAnchor = reportSubTab === 'week'
    ? localDateString(startOfWeek(view === 'today' ? now : picked))
    : localDateString(view === 'today' ? now : picked)
  const reportScope = reportSubTab === 'week' ? 'week_report' : 'day_report'
  const todayAnchor = localDateString(new Date())
  const thisWeekAnchor = localDateString(startOfWeek(new Date()))
  const reportIsFuture = reportSubTab === 'week' ? reportAnchor > thisWeekAnchor : reportAnchor > todayAnchor

  useEffect(() => {
    /**
     * 报告的加载跟着**面板选中的那一天**走（批次2 D15）：报告页签现在今日/日历都有，
     * 所以闸门从「必须是日历视图」改成「必须是报告页签」——仍然不许未来日期拉报告（只做复盘）。
     */
    if (view !== 'today' && view !== 'calendar') { setCurrentReport(null); setReportSession(null); return }
    if (dayTab !== 'report' || reportIsFuture) {
      setCurrentReport(null); setReportSession(null)
      return
    }
    void Promise.all([
      api<{ report: TaskReportView | null }>(`/api/workbench/reports/${reportSubTab}/${reportAnchor}`),
      api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=${reportScope}&anchor=${reportAnchor}`),
    ]).then(([rep, sess]) => { setCurrentReport(rep.report); setReportSession(sess.session) }).catch(() => { setCurrentReport(null); setReportSession(null) })
  }, [view, dayTab, reportSubTab, reportAnchor, reportIsFuture, reportRefreshKey])

  useEffect(() => {
    void api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=daily_plan&anchor=${todayAnchor}`)
      .then((r) => setTodayPlanSession(r.session))
      .catch(() => setTodayPlanSession(null))
  }, [todayAnchor, todayPlan])
  void todayPlanSession

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
  void pickedPlanSession

  const weekDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(cursor); d.setDate(d.getDate() + i); return d })
  const moveWeek = (delta: number): void => { const d = new Date(cursor); d.setDate(d.getDate() + delta * 7); setCursor(startOfWeek(d)) }
  const monthGrid = (() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const start = startOfWeek(first)
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d })
  })()
  const moveMonth = (delta: number): void => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1))

  /**
   * 日期面板的数据层（批次2 D15）：派生全部收在 `dayPanelModel.ts#useDayPanelModel` 里，
   * 这里只调一次 —— 树的口径（当日到期 ∪ 当日计划项 ∪ 进行中）与"逐条标来源"都在那边，
   * 本文件不再自己 filter 一遍。
   */
  const dayPanel = useDayPanelModel({
    isTodayView: view === 'today',
    tasks,
    todayPlan,
    pickedPlan,
    todayCandidateRows: todayPlanCandidateRows,
    pickedCandidateRows: pickedPlanCandidateRows,
    todayExpanded,
    calendarExpanded,
    todayToggleExpanded: toggleTodayExpanded,
    calendarToggleExpanded: toggleCalendarExpanded,
    todayPromptInfo,
    pickedPromptInfo,
    todayAnchor,
    pickedAnchor,
    pickedDate: picked,
    todayDate: now,
  })

  /**
   * 切到过去日期时把页签收回「计划」。
   *
   * 为什么必须有（不是"顺手兜底"）：上面两个 effect 的闸门按**当前页签**决定要不要加载
   * 该日计划；`dayPanel.extraTabsAvailable` 为假时组件已经兜底渲染「计划」，
   * 若 state 还停在「逾期」，就会出现"面板显示计划、列表却是空的"的**假空**。
   * 复位落点用共享的 `resolveDayPanelTab`（与组件兜底**同一份判定**）。
   */
  useEffect(() => {
    setDayTab((prev) => resolveDayPanelTab(prev, dayPanel.extraTabsAvailable))
  }, [dayPanel.extraTabsAvailable])

  const bumpPlanRefresh = useCallback(() => setPlanRefreshKey((v) => v + 1), [])
  const bumpReportRefresh = useCallback(() => setReportRefreshKey((v) => v + 1), [])
  /** 收起今日/日历两棵树（原 `collapseAll` 里属于本域的那两行）。 */
  const collapseExpanded = useCallback(() => { setTodayExpanded(new Set()); setCalendarExpanded(new Set()) }, [])

  return {
    capacity,
    capacityEdit,
    capacityExpanded,
    reportSubTab,
    currentReport,
    reportSession,
    reportAnchor,
    reportIsFuture,
    todayAnchor,
    pickedPlan,
    todayExpanded,
    calendarExpanded,
    picked,
    pickedAnchor,
    addingPlanTaskId,
    cursor,
    calMode,
    dayTab,
    weekDays,
    monthGrid,
    dayPanel,
    planPromptFor: planCandidateInfo.promptFor,
    actions: {
      addTaskToPlan,
      patchPlanItem,
      savePlan,
      clearPlan,
      deleteReport,
      toggleTodayExpanded,
      toggleCalendarExpanded,
      collapseExpanded,
      moveWeek,
      moveMonth,
      setCapacityEdit,
      setCapacityExpanded,
      setReportSubTab,
      setPicked,
      setCursor,
      setCalMode,
      setDayTab,
      bumpPlanRefresh,
      bumpReportRefresh,
    },
  }
}
