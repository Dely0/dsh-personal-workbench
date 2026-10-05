/**
 * dsh-personal-workbench client v0.2 — 方案 A 左右分栏：
 *  - 左侧导航区：今日 / 可导航日历(周/月) / 树状列表（默认折叠、记忆展开）
 *  - 右侧详情区：仅显示选中任务；未选中显示占位
 *  - AI 澄清/咨询/拆解统一跳官方会话区；工作台侧边栏显示待确认草稿红点
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { isWslStylePath } from './workspacePath.js'
import { DEFAULT_ESTIMATE_MINUTES, MAX_ESTIMATE_MINUTES } from './capacity.js'
import { WORKBENCH_CSS } from './styles.js'
import { ACTIVE_ATTR, OFFICIAL_ATTR, PANEL_NAME, PENDING_ATTR, VIEW_ATTR } from './constants.js'
import { HOST_SIDEBAR_COLLAPSED_ATTR, HOST_SIDEBAR_WIDTH_VAR, HOST_TITLEBAR_HEIGHT_VAR, HOST_WINDOWS_TITLEBAR_ATTR } from './hostShellMarkers.js'
import { panelDataOpen, shouldShowPanel } from './panelState.js'
import { WORKBENCH_BUILD_ID } from './buildId.js'
import { isAiSessionReusable } from './aiSessionReuse.js'
import { checkHostCapabilities, refuseToStart, type SlotsProbe } from './capabilities.js'
import {
  ENTRY_TITLE, OFFICIAL_MAIN_SLOT, OFFICIAL_OVERLAY_SLOT, OFFICIAL_PANEL_LIST_SLOT,
} from './entryContract.js'
import { ToastHost } from './components/Toast.js'
import { api } from './api.js'
// 快速录入域（D17/P6-2）：三个浏览器侧小工具搬进纯模块 —— 快速录入域与 AI 会话域共用。
import { Icon } from './components/Icon.js'
import { workspaceCandidates } from './workspacePicker.js'
import { useKnowledge, type StartAISessionFn } from './hooks/useKnowledge.js'
import { useIdeas } from './hooks/useIdeas.js'
import { useTaskListModel } from './hooks/useTaskListModel.js'
import { useTaskDetailModel } from './hooks/useTaskDetailModel.js'
import { useTaskForms } from './hooks/useTaskForms.js'
import { useTaskData } from './hooks/useTaskData.js'
import { useDayWorkspace } from './hooks/useDayWorkspace.js'
import { useWorkbenchFeedback } from './hooks/useWorkbenchFeedback.js'
import { useWorkbenchSettings } from './hooks/useWorkbenchSettings.js'
import { useWorkbenchReminders } from './hooks/useWorkbenchReminders.js'
import { useWorkbenchDrafts } from './hooks/useWorkbenchDrafts.js'
import { useWorkbenchPolling } from './hooks/useWorkbenchPolling.js'
import { useWorkbenchNavigation } from './hooks/useWorkbenchNavigation.js'
import { useWorkbenchBusy } from './hooks/useWorkbenchBusy.js'
import type { WorkbenchAssembly } from './app/assembly.js'
import { WorkbenchHeader } from './app/WorkbenchHeader.js'
import { WorkbenchOverlays } from './app/WorkbenchOverlays.js'
import { WorkbenchBody } from './app/WorkbenchBody.js'
import { WorkbenchDialogs } from './app/WorkbenchDialogs.js'
import { useWorkbenchQuickIntake } from './hooks/useWorkbenchQuickIntake.js'
import { useWorkbenchAISessions } from './hooks/useWorkbenchAISessions.js'
import { useWorkbenchDirectoryPicker } from './hooks/useWorkbenchDirectoryPicker.js'
import { startOfDay
} from './format.js'
import type { DshSessionSummary, Task, WorkbenchRuntime
} from './viewTypes.js'
import { currentSessionIdOf, getPluginCtx, optionalService, safeService, setPluginCtx } from './runtimeServices.js'
import { decideSidebarWidth, decideTopInset, pickFrameCandidate } from './panelGeometry.js'
import { indexModalities, type ModelModalityRecord
} from './modelCapability.js'

const CSS = WORKBENCH_CSS

/**
 * 「预计耗时」非法时的**行内红字**（文案定稿，见设计文档 §12.4）。
 *
 * 为什么做成函数而不是字面量：默认耗时是**用户可改的偏好**，
 * 用户把默认改成 60 之后，提示里还写"默认 30 分钟"就是在说谎。
 * 这个文案同时被编辑弹窗与新建表单复用（同一字段两个入口，两套说法迟早打架）。
 */
function estimateRangeMessage(defaultMinutes: number): string {
  return `耗时必须是 1–1440 之间的整数（留空表示用默认 ${defaultMinutes} 分钟）`
}

// 设置域（D17/P5-1）：`SETTINGS_FALLBACK` / `withSettingsFallback` 已搬到纯模块 settingsFallback.ts
// （设置域 hook 与仍留在入口的 quick-intake 两个写入点共用它）。






/** 拉一次"模型 → 输入能力"对照表；失败返回空表（不拦，交给宿主原生兜底）。 */
async function loadModelModalityTable(): Promise<ReadonlyMap<string, readonly string[] | null>> {
  try {
    const res = await api<{ ok: boolean; models?: ModelModalityRecord[] }>('/api/workbench/model-modalities')
    return indexModalities(res.models ?? [])
  } catch { return new Map() }
}

/**
 * 工作台主组件（面板里的全部 UI）。
 *
 * 这一行原本被一次误删切掉了（2026-10-01 抽 `ModelPicker` 时按"出现两次的标记"切片切错了位置），
 * 表现为函数体变成裸语句 + `pnpm typecheck` 报 "Declaration or statement expected"。
 * 教训与规矩见本仓 skill §14：**切片/替换必须用唯一标记**，别用在文件里出现两次的字符串。
 */
function WorkbenchApp({ runtime, closePanel }: { runtime: WorkbenchRuntime; closePanel: () => void }): JSX.Element {
  // 导航域（D17/P6-1）：`view` / `setView` 已收进 hooks/useWorkbenchNavigation.ts（落点必须最早：
  // `useKnowledge` / `useIdeas` / `useTaskListModel` 都以 `activeView` 读它，`const` 没有提升）。
  const nav = useWorkbenchNavigation()
  const { view } = nav
  const { setView } = nav.actions
  /**
   * 任务数据域（D17/P3-4）：原来摊在这里的 4 个 state（`bootstrap`/`tasks`/`pendingCompletions`/
   * `selected`）与文件中部第 430 行的 `taskKnowledge`、第 482 行的 `selectedRef`、
   * 四个只读派生（`dicts`/`dictOf`/`pendingMap`/`childrenIndex`/`childrenOf`）以及
   * `refresh`/`loadTaskDetail`/`patchTask`/`completePlanTask`/`saveProgress`/
   * `completeTaskFromProgress`/`deferPlanTask` 全部收进了 `hooks/useTaskData.ts`。
   *
   * ⚠️ 那个 hook 是在**反馈域的 `error`/`notice` 之后**才调用的 —— 它按设计 §5 用注入回调
   * 拿反馈（`onError`/`onNotice`），而 `const` 没有提升，声明在前才拿得到。见下面
   * `const data = useTaskData(...)`。
   */
  /**
   * 任务表单域（D17/P3-3）：原来摊在这里的 3 个 state（`showForm`/`subtaskParent`/`editDraft`）
   * 与文件中部那个 `formWorkspace` 一起收进了 `hooks/useTaskForms.ts`。
   *
   * 入口自己只需要三样**读取值**（编辑草稿、子任务父任务、表单工作区）与动作 —— 动作全部经
   * `forms.actions` 取，不再持有可写副本（设计 §5：视图拿意图，不拿 setter）。
   */
  const forms = useTaskForms()
  const { editDraft, formWorkspace } = forms
  const { dismissOnTaskChange } = forms.actions
  /**
   * 任务详情域（D17/P3-2）：原来摊在这里的 6 个 state 收进了 `hooks/useTaskDetailModel.ts`。
   *
   * 入口自己只需要四样：关联会话时要开关选择器 + 连接期间置忙，打开任务时要复位详情视图。
   * 其余读取值（页签、折叠态、选择器是否展开、搜索词…）由 `TaskDetailPane` 直接从 `detail` 取，
   * 不再经过本文件 —— 所以这里**只解构入口真正用到的那几个**。
   */
  const detail = useTaskDetailModel()
  const { sessionPickerRole, sessionPickerQuery } = detail
  const { setSessionPickerBusy, resetDetailView, closeSessionPicker } = detail.actions
  // 快速录入域（D17/P6-2）：8 项 state（`showQuick` / `quickText` / `quickWorkspace` /
  // `quickWorkspaceTouched` / `quickWorkspaceSource` / `quickFollowFolder` / `quickAttachments` /
  // `quickAttachmentNotice`）、两个 ref（`quickImageInputRef` 与附件镜像 ref）、
  // 两个内部写入点与 7 个动作已收进 hooks/useWorkbenchQuickIntake.ts。
  // 四条不许动的语义（预填值只由偏好+系统配置决定 / 只有用户动过才记进最近 / 不收的附件要说原因 /
  // ref 与 state 的一致性靠构造保证）随原注释一起搬进了 hook 文件头。
  // AI 会话域（D17/P6-3）：`quickModelSelection`（含写 localStorage 的包装 setter）与
  // `modelModalityTable` 已收进 hooks/useWorkbenchAISessions.ts（连同「模型是这次会话怎么跑、
  // 不是任务属性」与「能力表拉不到就 fail open」两条原注释）。
  // 草稿域（D17/P5-3）：7 项 state（`pendingDraft` / `deferredDrafts` / `draftProblems` /
  // `draftSwitchedFrom` / `allPendingDrafts` / `pendingOpen` / `duplicatePrompt`）与 3 个 ref
  // （`dismissedDraftIdsRef` / `deferredWhenDismissedRef` / `bannerDraftRef`）已收进
  // hooks/useWorkbenchDrafts.ts。三条不许动的语义（计数不经本地屏蔽集合 / 只有「暂存→唤回」
  // 才解除屏蔽 / 弹框被「静默换人」必须说出来）随原注释一起搬进了 hook 文件头。
  // 提醒域（D17/P5-2）：7 项 state 已收进 hooks/useWorkbenchReminders.ts。
  // ⚠️ 它的调用点在下方**设置域 `prefs` 之后** —— `showSettings` 与 `settings.desktopNotify`
  // 都要以注入形式拿到（`const` 没有提升），所以 `reminders` 的声明也一并挪到了那里。
  // 反馈域（D17/P5-1）：`error` / `notice` 与 toast 宿主已收进 hooks/useWorkbenchFeedback.ts。
  // ⚠️ 它必须落在**最早处**：下面的 useTaskData / useKnowledge / useIdeas / 设置域全都注入它的
  // 写口（`const` 没有提升，声明在前才拿得到），所以不能为了"离使用者近"而下移。
  const feedback = useWorkbenchFeedback()
  const { toasts } = feedback
  const { setError, setNotice, pushToast, dismissToast } = feedback.actions
  // 任务数据域（D17/P3-4）：必须排在 `error`/`notice` 之后（注入回调要用到它们，`const` 没有提升）。
  /**
   * D17/P7-1：三个**跨域注入回调** —— 域拥有用例，跨域那一步以类型化回调交回装配层
   *（与 P6-3 把 `closeIntake()` / `clearQuickAttachments()` 注入 AI 会话域同一手法）。
   * `taskList`（列表域）声明在本行之后：闭包在用户交互时才求值，没有 TDZ 问题。
   */
  const data = useTaskData({
    onError: setError, onNotice: setNotice,
    onTaskCreated: () => forms.actions.closeCreate(),
    onSubtaskParentCleared: () => forms.actions.setSubtaskParent(null),
    onTaskRestored: () => taskList.actions.setArchivedMode(false),
  })
  const { bootstrap, tasks, selected, dicts, dictOf, pendingMap, childrenOf } = data
  const {
    refresh,
    loadTaskDetail,
    patchTask,
    completePlanTask,
    saveProgress,
    deferPlanTask,
    setTasks,
    currentTaskId,
    linkSessionRequest,
  } = data.actions
  // 草稿域（D17/P5-3）：调用点必须在 `refresh`（任务数据域）与 `setError` / `setNotice`
  // （反馈域）之后 —— 三个都是以注入形式进来的（`const` 没有提升）。
  const draftsApi = useWorkbenchDrafts({ refresh, onError: setError, onNotice: setNotice })
  const { pendingDraft, allPendingDrafts } = draftsApi
  // 提醒域（D17/P5-2）：`reminderModalOpen` 已收进 hooks/useWorkbenchReminders.ts（见下方解构）。
  // 草稿域（D17/P5-3）：`pendingOpen`（待处理弹窗开关）已收进 hooks/useWorkbenchDrafts.ts。
  // 草稿域（D17/P5-3）：`duplicatePrompt`（「库里已有同名任务」的待决提示）已收进
  // hooks/useWorkbenchDrafts.ts（`DraftDuplicatePrompt` 类型一并搬走）。
  // 设置域（D17/P5-1）：`settings` 已收进 hooks/useWorkbenchSettings.ts（调用点在下方提醒域之前）。
  // 日期域（D17/P4）：`capacityEdit` / `capacityExpanded` 已收进 hooks/useDayWorkspace.ts
  // 提醒域（D17/P5-2）：`notificationCtor` 与 `notifyPerm` 已收进 hooks/useWorkbenchReminders.ts。
  // 注：入口仍在 `SettingsModal` 的两个内联回调里就地 `readNotificationCtor(globalThis)`
  //（授权与「发送测试通知」各一次）—— 它们读的是入口持有的 `pushToast`，属装配层。
  // 设置域（D17/P5-1）：9 项 state + 设置/字典/召回动作已收进 hooks/useWorkbenchSettings.ts。
  // 落点必须在 `dictOf` / `refresh`（任务数据域）与反馈域三个写口之后 —— 它们都是以注入形式进来的。
  const prefs = useWorkbenchSettings({ dictOf, refresh, onError: setError, onNotice: setNotice, onToast: pushToast })
  const { settings, showSettings } = prefs
  const { setSettings, saveDailyCapacity: saveDailyCapacitySetting } = prefs.actions
  // 快速录入域（D17/P6-2）：调用点必须在 `prefs`（设置域）之后 —— `settings` / `setSettings`
  // 与 `setError` 都是以注入形式进来的。`detectWslHost` 是入口尾部那个模块级纯函数，
  // 以注入形式交给 hook（hook import 入口会成环），所以 hook 里的实参文本与拆分前逐字一致。
  const quick = useWorkbenchQuickIntake({ runtime, settings, setSettings, detectWslHost, onError: setError })
  const { quickWorkspace } = quick
  const { openIntake, closeIntake, overrideWorkspace, clearQuickAttachments } = quick.actions
  // 反馈域（D17/P5-1）：`useToasts()` 的宿主已随 `error`/`notice` 一起进 hooks/useWorkbenchFeedback.ts
  // （`toasts` / `pushToast` / `dismissToast` 见上面第 3 步的解构）。
  // 提醒域（D17/P5-2）：7 项 state（含上面的 `reminders` / `reminderModalOpen` / `notifyPerm`）、
  // 桌面通知去重集合与全部提醒动作已收进 hooks/useWorkbenchReminders.ts。
  // 落点必须在 `prefs`（设置域）之后 —— `showSettings` 与 `settings.desktopNotify` 都是以注入形式进来的。
  const remindersApi = useWorkbenchReminders({ currentTaskId, refresh, showSettings, desktopNotify: settings.desktopNotify, onError: setError, onNotice: setNotice, onToast: pushToast })
  const { reminders } = remindersApi
  // 设置域（D17/P5-1）：字典表单的 4 项 state 已收进 hooks/useWorkbenchSettings.ts（见上面的解构）。
  // 日期域（D17/P4）：报告 / 选中日计划的 6 项状态已收进 hooks/useDayWorkspace.ts
  /**
   * 工作区的「浏览…」弹窗（批次2 #2/W03）。
   *
   * 与知识库那个弹窗**共用同一个组件**（`LocalDocModal` 的 `dir` 模式），只是状态与
   * "选中后写到哪"不同 —— 所以这里用 `dirPickerTarget` 记"是哪个入口打开的"，
   * 一个 sink 分派，而不是为三个入口各写一份弹窗状态。
   */
  // 目录选择域（D17/P6-4）：5 项弹窗状态与 `loadDirPickerDir` 已收进
  // hooks/useWorkbenchDirectoryPicker.ts。装配层只留「算起始目录」与「选完写到哪」两件跨域的事。
  const dir = useWorkbenchDirectoryPicker()
  const { dirPickerTarget } = dir
  const { openFor, setDirPickerTarget } = dir.actions
  // 任务表单域（D17/P3-3）：`formWorkspace` 已随 4 项状态收进 hooks/useTaskForms.ts
  // 任务数据域（D17/P3-4）：`taskKnowledge` 已随 5 项状态收进 hooks/useTaskData.ts
  // 点子域（D17 / P2）的 12 项状态与 13 项派生/动作已收进 hooks/useIdeas.ts
  // 日期域（D17/P4）：`reportRefreshKey` / `todayPlanSession` 已收进 hooks/useDayWorkspace.ts
  // 界面忙碌标志（D17/P6-1）：`busy` / `setBusy` 已收进 hooks/useWorkbenchBusy.ts（它不属于任何业务域）。
  const busyApi = useWorkbenchBusy()
  const { busy } = busyApi
  const { setBusy } = busyApi.actions
  // AI 会话域（D17/P6-3）：`promptModal` / `promptResolveRef` / `skillCatalog` / `skillsAvailable` /
  // `skillsLoading` / `skillProblem` / `skillQuery` / `selectedSkills` / `promptPersona` /
  // `quickPersona` / `promptModelSelection`（含包装 setter）10 项 state + 1 个 ref 已收进
  // hooks/useWorkbenchAISessions.ts。四条不许动的语义随原注释一起搬走（空目录必须报可恢复故障 /
  // 三个角色状态位语义不同不许合并 / 两个弹窗共用同一份模型持久化）。
  // 任务数据域（D17/P3-4）：`selectedRef`、四个只读派生（`dicts`/`dictOf`/`pendingMap`/
  // `childrenIndex`/`childrenOf`）与 `refresh` 全部收进了 hooks/useTaskData.ts。
  //
  // `refresh` 是**整块**搬走的：它一次 `Promise.all` 取 bootstrap + 任务列表 + 待验收投影，
  // 再按最新选中 id 补详情/事件/复盘/关联知识。按设计 §4.1 第 149 行，这几件事
  // *不能*拆成多个各自发请求的动作（那就是 requirements §3.2 明令禁止的 N+1）。

  // AI 会话域（D17/P6-3）：技能目录装载（`loadSkills`，`useCallback(…, [])`）已收进
  // hooks/useWorkbenchAISessions.ts，连同原注释 —— 空目录必须报成可恢复故障、不许整块隐藏。

  /**
   * D17 / P1：知识域的全部 state / effect / 动作已经收进 `hooks/useKnowledge.ts`。
   *
   * ⚠️ 为什么调用点在这里、而不是原来的 state 声明区：本 hook 的入参里有 `dictOf` / `busy` / `view`，
   * 它们在本组件里**先声明后使用**（`const` 没有提升）—— 放到前面会直接 ReferenceError。
   * 这个位置与拆分前那批 state/effect 的先后次序一致，hook 调用次序不变；
   * 域 hook 常驻在顶层、不放进条件视图，所以切视图不会重置知识域状态（设计 §4.2）。
   *
   * ⚠️ `startAISession` 是**本组件中部**才声明的 `const`（没有提升），所以这里传的是
   * 一个**惰性转发 ref**（`startAISessionRef`），在它定义之后一行内写入 `current`；
   * 否则 `useKnowledge` 的入参求值当场 ReferenceError。
   */
  const startAISessionRef = useRef<StartAISessionFn | null>(null)
  const knowledge = useKnowledge({
    activeView: view,
    dictOf,
    busy,
    setBusy,
    runtime,
    isAlive: () => instanceAlive,
    startAISession: startAISessionRef,
    setError: (message) => setError(message),
    setNotice: (message) => setNotice(message),
  })

  /**
   * D17 / P2：点子域的全部 state / 派生 / 动作已经收进 `hooks/useIdeas.ts`。
   *
   * 与知识域同样常驻在顶层、不放进条件视图：切视图不会重置点子域状态（设计 §4.2）。
   * `startAISession` 在下面才声明（`const` 没有提升），所以这里用同一个惰性转发 ref；
   * `ideasAll` 是 `ideas` 的只读快照，供上面 `startAISession` 里拼 `idea_association` /
   * `idea_brainstorm` 提示词用 —— 可写状态仍然只有 `useIdeas` 一份。
   */
  const ideas = useIdeas({
    activeView: view,
    setError: (message) => setError(message),
    setNotice: (message) => setNotice(message),
  })
  const ideasAll = ideas.allIdeas
  useEffect(() => { void refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) }, [refresh])
  // 设置域（D17/P5-1）：设置装载 effect 已收进 hooks/useWorkbenchSettings.ts。

  // 设置域（D17/P5-1）：`loadRecallLog` 已收进 hooks/useWorkbenchSettings.ts。

  // 设置域（D17/P5-1）：`recallSessionRestore` 已收进 hooks/useWorkbenchSettings.ts。

  // 提醒域（D17/P5-2）：打开设置面板时拉策略/通道的那条 effect 已收进 hooks/useWorkbenchReminders.ts。

  // 设置域（D17/P5-1）：召回日志 effect 已收进 hooks/useWorkbenchSettings.ts。

  // 提醒域（D17/P5-2）：桌面通知去重集合 `notifiedRef` / `persistNotified` 已收进
  // hooks/useWorkbenchReminders.ts（原存储键与「超 500 留后 250」的规则都不变）。

  // 反馈域（D17/P5-1）：`notice`/`error` → toast 的两条桥接 effect 已收进 hooks/useWorkbenchFeedback.ts。

  // 提醒域（D17/P5-2）：「有到期提醒时自动弹窗」那条 effect 已收进 hooks/useWorkbenchReminders.ts。

  // 轮询装配（D17/P5-3）：5 秒 tick（草稿 → 提醒，**串行**）+ 15 秒 refresh 已收进
  // hooks/useWorkbenchPolling.ts。原来那个 `try` 一并搬走 —— 草稿那半段抛错时提醒那半段
  // 当轮不执行，异常范围不变。原依赖数组 `[refresh, settings.desktopNotify]` 的等价性由
  // 该文件头论证：两个 tick 函数都是稳定 `useCallback`（提醒那个只随 `desktopNotify`
  // 换身份），所以重建时机与原实现逐字相同。
  useWorkbenchPolling({
    tickDrafts: draftsApi.actions.tickDrafts,
    tickReminders: remindersApi.actions.tickDue,
    refresh,
    desktopNotify: settings.desktopNotify,
  })

  /** 换任务时把两个瞬态表单收掉（表单域的动作；触发条件来自任务数据域）。 */
  useEffect(() => { dismissOnTaskChange() }, [selected?.task.id, dismissOnTaskChange])

  useEffect(() => {
    if (pendingDraft !== null) document.documentElement.setAttribute(PENDING_ATTR, '')
    else document.documentElement.removeAttribute(PENDING_ATTR)
    return () => document.documentElement.removeAttribute(PENDING_ATTR)
  }, [pendingDraft])

  // 任务数据域（D17/P3-4）：`loadTaskKnowledge` 与 `loadTaskDetail` 已收进 hooks/useTaskData.ts
  // （连同上面那段 2026-10-01 的 BUG 约定注释 —— 那条约定的正文原样搬进了 hook，别在这里重写一份）。
  //
  // 下面两个**留在入口**：它们是"加载 + 导航"的组合，按设计 §4.1 第 148 行
  // `openTaskById` 归装配层，由入口把 TaskData 的动作和 Navigation 的 `setView` 拼起来。
  /** 打开任务（**会导航**）：重置详情页签与事件折叠，并刷新数据。 */
  const openTask = (task: Task): void => {
    resetDetailView()
    loadTaskDetail(task.id)
  }
  /** 按 id 打开任务（**会导航到任务页**）：只给"从别处跳到这个任务"的入口用。 */
  const openTaskById = (taskId: string): void => {
    setView('list')
    resetDetailView()
    loadTaskDetail(taskId)
  }
  // 任务数据域（D17/P3-4）：`patchTask` / `completePlanTask` / `saveProgress` /
  // `completeTaskFromProgress` / `deferPlanTask` 已收进 hooks/useTaskData.ts。
  // 其中两处反馈（`setNotice`）改成 hook 的注入回调 `onNotice`（设计 §5）。
  // 提醒域（D17/P5-2）：`ackReminder` / `resetReminderState` / `addTaskReminder`
  // 已收进 hooks/useWorkbenchReminders.ts（它们的 `setNotice` / `setError` 改成注入回调）。

  const linkExistingSession = async (sessionId: string): Promise<void> => {
    const taskId = currentTaskId()
    if (taskId === null) return
    setSessionPickerBusy(true)
    try {
      await linkSessionRequest(taskId, sessionId, sessionPickerRole)
      setNotice('已关联到任务')
      closeSessionPicker()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSessionPickerBusy(false)
    }
  }

  // AI 会话域（D17/P6-3）：共享提示词弹窗（`askUserPrompt` / `confirmPrompt` / `cancelPrompt` /
  // `toggleSkill` / `AI_PROMPT_LABELS`）、会话面板切换（`openSessionInPanel`）、
  // **468 行的 `startAISession`** 与复用判定 `reuseAiSessionId` 已收进
  // hooks/useWorkbenchAISessions.ts（连同全部原注释：复用三判据 / `workspaceOverride` 语义 /
  // `clarifyOptions`）。那个 hook 的调用点在 `day`（日期域）之后、`dayPanelProps` 之前。
  // ⚠️ 原来紧跟 `startAISession` 的那行 `startAISessionRef.current = startAISession`
  //（惰性转发 ref 的赋值）**必须留在装配层**，且只能排在 hook 调用之后 ——
  // 因为 `ai.actions.startAISession` 在那里才存在（`const` 没有提升）。见下方 hook 调用块。

  // 列目录（D17/P6-4）：请求与状态都收进 hooks/useWorkbenchDirectoryPicker.ts。

  /**
   * 打开工作区的「浏览…」弹窗（装配层：起始目录来自三个入口的当前值）。
   * 起始目录＝该入口当前的值（留空则后端默认落在主目录）。
   */
  const openDirPicker = (target: 'quick' | 'form' | 'edit'): void => {
    const start = target === 'quick' ? quickWorkspace : target === 'form' ? formWorkspace : (editDraft?.workspacePath ?? '')
    openFor(target, start)
  }

  /**
   * 把选中的目录写回**打开弹窗的那个入口** —— 唯一分派点。
   * 三个入口共用一份弹窗状态，所以这里必须按 `dirPickerTarget` 分流，不能各写一份。
   */
  const applyWorkspaceDir = (dirPath: string): void => {
    const target = dirPickerTarget
    setDirPickerTarget(null)
    if (typeof dirPath !== 'string' || dirPath.trim() === '') return
    const picked = dirPath.trim()
    if (target === 'quick') { overrideWorkspace(picked); return }
    if (target === 'form') { forms.actions.setFormWorkspace(picked); return }
    if (target === 'edit') { forms.actions.patchDraft({ workspacePath: picked }) }
  }

  // 设置域（D17/P5-1）：字典 CRUD（`saveDictionaryEntry` / `toggleDictionaryEntry` /
  // `deleteDictionaryEntry`）已收进 hooks/useWorkbenchSettings.ts。

  // ---- 设置弹窗：保存与微信提醒操作（把结果收敛到 toast，不再挤压任务列表）----

  // 设置域（D17/P5-1）：`saveSettings` 已收进 hooks/useWorkbenchSettings.ts。

  // 提醒域（D17/P5-2）：`loadReminderChannel` / `saveReminderTarget` / `saveReminderPolicy` /
  // `sendReminderTest` 四条微信提醒动作已收进 hooks/useWorkbenchReminders.ts。

  // 归档当前选中任务（D17/P7-1）：整条用例（含 window.confirm 与 not found 自愈分支）已收进
  // hooks/useTaskData.ts —— 它只用到任务数据域自己的状态 + 注入反馈，没有第三个域参与。
  // 详情面板的 `archiveSelectedTask={archiveSelectedTask}` 仍从这里解构出的动作传下去。

  /** 保存任务编辑（详情页编辑弹窗）。 */
  const saveEditDraft = async (): Promise<void> => {
    if (editDraft === null || selected === null) return
    if (editDraft.title.trim() === '') return
    /**
     * 耗时在**客户端先校验**，合法才发请求：非法输入靠服务端 400 去猜，
     * 用户看到的只有一句英文错误，也不知道合法的区间是多少（本项目"非法输入要当场拒绝"）。
     * 留空 = null = 没填 → 走默认耗时，是合法状态，不是错误。
     */
    const estimatedRaw = editDraft.estimatedMinutes.trim()
    const estimated = estimatedRaw === '' ? null : Number(estimatedRaw)
    if (estimated !== null && (!Number.isFinite(estimated) || estimated < 1 || estimated > MAX_ESTIMATE_MINUTES)) {
      pushToast(estimateRangeMessage(DEFAULT_ESTIMATE_MINUTES), 'error')
      return
    }
    // 小数按四舍五入（服务的夹取规则是"非整数 → null"，直接在客户端算清更不容易踩坑）
    const estimatedMinutes = estimated === null ? null : Math.round(estimated)
    try {
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
        // 「预计耗时」与「全天任务」（v1.15.1）：前者直接决定今日容量的「已排」，
        // 后者只影响展示与重复锚点（不改变容量计算）。
        estimatedMinutes,
        allDay: editDraft.allDay,
      }
      // 自动生成的实例不允许改重复规则，编辑保存时也不提交该字段，从源头避免 400。
      if (selected.task.recurrenceMasterId === null) payload.recurrenceCode = editDraft.recurrenceCode
      await patchTask(selected.task.id, payload)
      /**
       * 乐观更新：`patchTask` 成功后**立刻**把这一条在本地 tasks 里改掉，
       * 不刷新页面就能看到「已排」跟着变（用户验收标准第 2 条：
       * "改完立即影响今日容量" = 乐观更新 + 立即重算，不是"刷新后生效"）。
       * 幂等：同 id 字段合并，重复保存结果一致；`patchTask` 内部随后 refresh 对账，
       * 服务端值与乐观值一致时不会产生可见跳动。
       */
      setTasks((prev) => prev.map((task) => (
        task.id === selected.task.id ? { ...task, estimatedMinutes, allDay: editDraft.allDay } : task
      )))
      forms.actions.closeEdit()
      pushToast('任务已更新', 'success')
    } catch (e) {
      pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  // 新建任务（D17/P7-1）：payload 拼接 + POST + `refresh` 已收进 hooks/useTaskData.ts
  //（`onTaskCreated` 注入回表单域收弹窗）。视图仍然只 `preventDefault` + 收 `FormData`：
  // 设计 §3 —— `views/` 不许发 HTTP，请求形状归域。
  // 日期域（D17/P4）：今日/日历两棵树的展开集合已收进 hooks/useDayWorkspace.ts

  /**
   * D17 / P3-1：任务列表域（state / 落盘 / 派生 / 动作）已经收进 `hooks/useTaskListModel.ts`。
   *
   * ⚠️ 调用点仍在原来那批 state 的声明处（`const` 没有提升）：入参 `tasks` / `dictOf` 到这里都已声明，
   * hook 内部的调用次序也与拆分前那批 `useState` / `useMemo` 一致。常驻在顶层、不放进条件视图，
   * 所以切视图不会重置列表的筛选与展开集合（设计 §4.2）。
   */
  const taskList = useTaskListModel({ tasks, dictOf })
  /**
   * 「恢复任务」与「新建子任务」的请求本体（D17/P3-2 从详情面板搬上来的）。
   *
   * 为什么搬上来：设计 §3 明令 `views/` 不做 api 请求。搬的只有"谁发请求"——
   * 请求形状、payload 字段与顺序、成功后的提示/刷新/退出归档态**逐字未改**。
   * D17/P3-4 复核后**留在装配层**（没有跟着任务数据域一起进 `useTaskData`）：这两个动作都不是
   * 纯任务数据操作，每个都跨两个以上的域 —— `restoreTask` 写任务域（POST restore）＋列表域
   * （`taskList.actions.setArchivedMode(false)`）＋反馈域；`createSubtask` 写任务域（POST 子任务）
   * ＋表单域（`forms.actions.setSubtaskParent(null)`）＋反馈域。按设计 §4.1 第 148 行的定案
   * （跨域组合归装配层），"谁发请求"留在入口。
   */
  // 「恢复任务」与「新建子任务」（D17/P7-1）：请求本体已收进 hooks/useTaskData.ts ——
  // 跨域那一步（退出列表域的「查看归档」/ 收起表单域的子任务表单）以注入回调交回装配层。
  // 详情面板的 `onRestoreTask={restoreTask}` 与 `onCreateSubtask={createSubtask}` 仍从这里传下去。
  /**
   * 收起全部（跨域组合，按设计 §4.1 第 148 行留在装配层）：
   * 列表域那棵交给它自己的 `clearExpanded()`，今日/日历两棵交给日期域。
   */
  const collapseAll = (): void => { taskList.actions.clearExpanded(); day.actions.collapseExpanded() }

  // 技能过滤已收进 `SkillPicker` 组件内部（两个弹窗共用同一份，不再各写一份）

  const now = new Date()
  const todayStart = startOfDay(now)
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1)
  const todayPlan = bootstrap?.todayPlan ?? null
  /**
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
    reportSubTab, currentReport, reportSession, reportAnchor, reportIsFuture,
    pickedPlan, addingPlanTaskId, dayTab, dayPanel, planPromptFor,
  } = day
  const { addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, setDayTab, setReportSubTab } = day.actions
  // AI 会话域（D17/P6-3）：12 项 state + 1 个 ref（`promptResolveRef`）+ 9 个动作已收进
  // hooks/useWorkbenchAISessions.ts。
  // ⚠️ 落点必须在 `day`（日期域的 `planPromptFor` / `todayPlan` / `pickedPlan`）之后、
  // `dayPanelProps` 与 `openQuickEntry` 之前 —— 两边都以注入形式用它（`const` 没有提升）。
  // `useKnowledge` 仍走上面那个惰性转发 ref，所以它的入参一个字都不用改。
  const ai = useWorkbenchAISessions({
    runtime, closePanel, settings, dicts, ideasAll,
    planPromptFor, todayPlan, pickedPlan, pendingDraft,
    clearQuickAttachments, closeIntake,
    isAlive: () => instanceAlive,
    setError, setBusy,
    loadModelModalityTable, aiSessionUsable, connectWorkspace,
  })
  const { startAISession, resetClarifyPicker } = ai.actions
  /**
   * D17：把 `startAISession` 交给知识域 hook（`useKnowledge` 在组件上部调用，那时它还没声明）。
   * 这里是**普通赋值**，不是 hook 调用 —— 不改变 hook 顺序，也不额外触发渲染。
   */
  startAISessionRef.current = ai.actions.startAISession
  // 日期域（D17/P4）：候选快照 / 容量账本 / `addTaskToPlan` / `patchPlanItem` 等派生与动作
  // 已收进 hooks/useDayWorkspace.ts。
  // 设置域（D17/P7-1）：`saveIncludeOverdue` / `saveDailyCapacity` 两个写 settings 的**请求本体**
  // 已收进 hooks/useWorkbenchSettings.ts；入口只留 `saveDailyCapacity` 的装配层半边
  //（读日期域的行内编辑态并把原文递进去）。
  // 逾期口径开关（D17/P7-1）：整条用例（乐观写 + 失败回滚 + 那句「面板与设置页同一权威源」的
  // 注释）已收进 hooks/useWorkbenchSettings.ts，入口从那里解构同名动作使用。

  /**
   * 保存「每天可投入时长」（分钟）的**装配层半边**：读日期域的行内编辑态、立刻置空，
   * 再把原文交给设置域（D17/P7-1：请求本体与 `390 / 30 分钟` 口径已进 hooks/useWorkbenchSettings.ts）。
   * 跨域只传值 —— 设置域不拥有也不读日期域的编辑态。
   */
  const saveDailyCapacity = async (): Promise<void> => {
    const raw = day.capacityEdit === null ? '' : day.capacityEdit.trim()
    day.actions.setCapacityEdit(null)
    await saveDailyCapacitySetting(raw)
  }

  // 日期域（D17/P4）：`savePlan` / 周月日历状态 / 报告锚点与 `reportIsFuture` / 三个加载 effect
  // 都已收进 hooks/useDayWorkspace.ts。
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
  // 日期域（D17/P4）：`weekDays` / `moveWeek` / `monthGrid` / `moveMonth` / `useDayPanelModel`
  // 调用 / dayTab 复位 effect 都已收进 hooks/useDayWorkspace.ts。
  /**
   * 两个入口**共用的一份面板 props**（今日与日历只差"哪一天"，而那已由 `dayPanel` 给出）。
   *
   * 共用是刻意的：ADR0001 要消灭的正是"同一天两处装配"——两份 props 清单迟早会漂移
   *（一处加了新回调、另一处忘了），那就是下一个"同一语义两处实现"。
   */
  const dayPanelProps = {
    ...dayPanel,
    tab: dayTab,
    onTabChange: setDayTab,
    tasks,
    dicts,
    selectedId: selected?.task.id,
    pending: pendingMap,
    childrenOf,
    busy,
    onOpen: openTask,
    /**
     * 行内「排入今日」（2026-10-02）：**复用同一个写入口** `addTaskToPlan`
     *（唯一入口 = `POST /plans/:date/items`，原子追加，绝不本地拼整份计划再 PUT）。
     *
     * 省略 `minutes` → 服务端按"任务预计耗时 / 设置默认投入"取快照，再由回执把落库值说出来。
     * 只在今天这一实例传；未来日期不传（现版本没有"未来排期"的入口，见 ADR0001 口径补充）。
     */
    onScheduleToday: dayPanel.isToday ? (taskId: string) => void addTaskToPlan(taskId) : undefined,
    scheduledIds: dayPanel.plannedIds,
    schedulingTaskId: addingPlanTaskId,
    onSort: () => void startAISession('plan', null, dayPanel.day),
    onComplete: completePlanTask,
    onDefer: deferPlanTask,
    onEffortChange: (taskId: string, next: boolean) => patchPlanItem(dayPanel.day, taskId, { effortDone: next }),
    onMinutesChange: (taskId: string, minutes: number) => patchPlanItem(dayPanel.day, taskId, { minutes }),
    onProgressChange: saveProgress,
    onClearPlan: () => void clearPlan(dayPanel.day),
    onSavePlan: (items: Array<{ taskId: string; note: string; minutes?: number }>) => savePlan(dayPanel.day, items),
    report: {
      subTab: reportSubTab,
      onSubTabChange: setReportSubTab,
      isFuture: reportIsFuture,
      current: currentReport,
      sessionActive: reportSession !== null,
      onGenerate: () => void startAISession('report', null, `${reportSubTab}:${reportAnchor}`),
      onDelete: () => { if (currentReport !== null) void deleteReport(currentReport) },
    },
  }

  /** 同上：`?.list.getSnapshot()` 只保护外层，低版本宿主缺 `list` 时会抛 —— 一并加固。 */
  const sessionListSnapshot = safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')?.list?.getSnapshot?.() ?? { ids: [], byId: {}, current: undefined }
  /** 待你处理的事项数：待确认草稿 + 已暂存草稿 + 到期提醒。 */
  /** 待你处理的事项数：服务端的待确认草稿 + 到期提醒（草稿数不参与本地过滤）。 */
  const pendingCount = allPendingDrafts.length + reminders.length
  /**
   * 工作区候选项（**三个入口共用一份**）：宿主已打开的工作区 ∪ 最近手动选择 ∪ 默认工作区。
   *
   * 判定在 `workspacePicker.ts#workspaceCandidates`（唯一实现，去重用全项目的
   * `recentWorkspaceKey`）。这里刻意**不做 memo**：它读的是宿主快照（不是 React state），
   * 缓存反而会让"用户刚在 DSH 里打开了新工作区"在面板里看不见。
   */
  const workspaceChoices = workspaceCandidates({
    open: openWorkspacePaths(runtime),
    recent: settings.quickWorkspaceRecent,
    defaultWorkspace: settings.defaultWorkspace,
  })

  // 新建任务表单"每次打开都清空工作区"的 effect 已随 4 项状态收进 hooks/useTaskForms.ts（P3-3）

  // 快速录入域（D17/P6-2）：投影函数（预填路径 / 来源提示 / 是否手动改过 / 建资料夹默认勾选）
  // 已收进 hooks/useWorkbenchQuickIntake.ts 的 `applyDecision` ——
  // 它与「打开弹窗」「不再记住这个目录」两处共用同一份投影，仍是唯一实现。
  /**
   * 打开「快速录入」：**跨域组合，归装配层**。
   *
   * 拆分前这是入口里的单个函数（工作区预填 + 清空输入 + 角色复位 + 技能复位 + 打开弹窗）。
   * 两半分给两个域之后，这里只按原顺序拼起来：① 快速录入域的 `openIntake()`（预填判定 + 清空输入
   * + 打开弹窗）；② AI 会话域的复位（角色 + 技能 + 重拉技能目录，见下方 `resetClarifyPicker`，P6-3）。
   */
  const openQuickEntry = (): void => {
    openIntake()
    // AI 会话域（D17/P6-3）：角色复位（AX-R07 的前提：默认必须是「未指定」）+ 技能复位 +
    // 重拉技能目录 —— 三件事已收进 hooks/useWorkbenchAISessions.ts 的 `resetClarifyPicker()`
    // （原注释随它搬走：为什么每次打开都要拉一次技能目录）。
    resetClarifyPicker()
  }
  // 快速录入域（D17/P6-2）：`rememberQuickWorkspace` / `forgetQuickWorkspace`（两个写设置的点，
  // 走注入的 `setSettings`，设计 §5）与 `addQuickAttachments` / `removeQuickAttachment` /
  // `clearQuickAttachments` 及那条卸载时释放图片 object URL 的 effect，已收进
  // hooks/useWorkbenchQuickIntake.ts（连同它们的原注释：置顶去重、基准取服务端现值、
  // 不收的附件要给中文原因、图片三处都要 revokeObjectURL）。

  // 草稿域（D17/P5-3）：`dismissDraft` / `resumePendingDraft` / `resumeDeferredDraft` /
  // `handleDraftConfirmed` / `reuseExistingTask` 五个动作已收进 hooks/useWorkbenchDrafts.ts
  // （连同它们的原注释：屏蔽集合、唤回要撤销屏蔽、三种确认回执、收口后归档多建的那条）。
  const linkedSessionIds = new Set((selected?.sessions ?? []).map((s) => typeof s.session_id === 'string' ? s.session_id : '').filter((id) => id !== ''))
  const sessionQuery = sessionPickerQuery.trim().toLowerCase()
  const sessionCandidates = sessionListSnapshot.ids
    .map((id) => sessionListSnapshot.byId[id])
    .filter((s): s is DshSessionSummary => s !== undefined)
    .filter((s) => sessionQuery === '' || s.displayTitle.toLowerCase().includes(sessionQuery) || (s.cwd ?? '').toLowerCase().includes(sessionQuery))

  /**
   * D17 / P7-2：整个 JSX 已按「顶栏 / 提示层 / 主体 / 弹窗」四段搬进 `src/client/app/`。
   * 四段在下面的顺序 = 搬迁前它们在 DOM 里的顺序（弹窗那两段刻意留在原地）。
   * 装配层只剩「把域的结果捆成一束」这一件事 —— 每个组件只解构自己用到的字段。
   */
  const assembly: WorkbenchAssembly = {
    nav, data, forms, detail, taskList, day, quick, ai,
    prefs, dir, busyApi, remindersApi, draftsApi, knowledge, ideas, feedback,
    runtime, closePanel, loadModelModalityTable, aiSessionUsable,
    collapseAll, dayPanelProps, now, pendingCount, linkedSessionIds, sessionCandidates,
    sessionListSnapshot, reparentCandidates, workspaceChoices, openTask, openTaskById,
    linkExistingSession, saveDailyCapacity, saveEditDraft, openQuickEntry, openDirPicker,
    applyWorkspaceDir,
  }

  return (
    <div className="wb-app">
      <WorkbenchHeader {...assembly} />
      <WorkbenchOverlays {...assembly} />
      <WorkbenchBody {...assembly} />
      <WorkbenchDialogs {...assembly} />
      <ToastHost items={toasts} onDismiss={dismissToast} />
    </div>
  )
}

let styleHealArmed = false

function ensureStyle(): void {
  if (!styleHealArmed) {
    styleHealArmed = true
    new MutationObserver(() => ensureStyle()).observe(document.head, { childList: true })
  }
  if (document.querySelector('style[data-dsh-personal-workbench-style]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshPersonalWorkbenchStyle = ''
  style.textContent = CSS
  document.head.appendChild(style)
}
/**
 * v1.14.53：原先这里还有 `sidebarRoot()` / `newSessionButton()` / `conversationColumn()`
 * 三个"找宿主 DOM 挂点"的辅助函数（给 DOM 降级腿用）。DOM 腿已删除，
 * 侧栏入口与面板容器**全部交给官方槽位**渲染，因此不再需要任何宿主 class 名选择器
 * —— 这也正是"DSH 升级就可能失效"的那一类脆弱依赖。
 */


export const name = 'personal-workbench-client'
/**
 * 声明的服务。
 *
 * ⚠️ **`slots` / `layout` 必须在这里声明**（v1.14.39 定案，2026-09-13）。
 *
 * 踩了很久的坑：原先只声明 `sessions` / `workspaces` / `connection`，
 * 然后想用 `ctx.get('slots')` / `ctx.get('layout')` **软探测**这两个服务。
 * 结果 **`ctx.get('layout')` 永远返回 undefined** —— cordis 不允许访问未声明 inject
 * 的服务（这正是团队记忆里那条"完全不声明 inject 直接调 ctx.interval 会抛
 * cannot get property ... without inject"的同一机制）。
 *
 * 连锁后果（每一条都实测过）：
 *   - 探不到 `layout` → 判定"宿主不支持官方槽位" → 静默降级到自建 DOM 腿；
 *   - 降级后的那条腿会铺一张 `position:fixed; inset:0; z-index:55` 的**满屏层**，
 *     一旦收不起来就永久盖住会话区（用户："除左栏外什么都点不了"）；
 *   - 同时宿主渲染我们的槽位条目时崩
 *     `TypeError: Cannot read properties of undefined (reading 'subscribe')`
 *     （`slot entry crashed in 'conversation.session.header.actions'` / `'shell.overlay'`）。
 *
 * **对照证据**：同机的 `dsh-pocket` 用的是
 * `var inject = ["slots", "connection", "layout", "locale", "sessionLogDownload"]` ——
 * 它**把这两个服务声明进了 inject**，所以能直接 `ctx.slots.inject(...)` /
 * `ctx.layout.toggleSidebar()`，从未出现上述问题。
 * （`dsh-client-ui-task-board` 则完全不碰官方槽位，改用"DOM 接管 centerCol +
 * `<html>` 上的 data 属性切换"，其源码注释明确写着 external plugins cannot declare slots。）
 *
 * 兼容性：这两个服务是 DSH 0.1.5-rc.1 起才有的。若需要支持更老的宿主，
 * 正确做法是 **`ctx.inject(['slots', 'layout'], cb)` 把依赖限定在子 fiber**
 * （缺一个只让这块不启动、插件主体照常加载），而不是"不声明 + 软探测"。
 * 本项目 reminder 调度对 `timer` 就是这么做的（见 src/index.ts 的 `ctx.inject(['timer'], …)`）。
 *
 * ⚠️ **唯一实现在 `capabilities.ts`**（v1.14.52，设计文档 I3）：这里只转出去，
 * 供 `test/capabilities.test.mjs` 断言"精确等于 5 项"。原地再写一份字面量
 * 就是"同一个语义两处实现"——一旦有人只改一边，插件会在半残状态下启动。
 */
export { inject } from './capabilities.js'

/**
 * 上一轮 `apply()` 的清理函数（单实例守卫用）。
 *
 * 为什么必须是模块级的：cordis 重载插件时会重新执行 `apply()`，而 `apply()` 内部的
 * 局部变量拿不到上一轮的引用。把清理函数存在模块作用域，新的 `apply()` 才能
 * 主动拆掉上一轮 —— 否则旧实例会继续轮询、继续弹 Modal，用户看到的就是
 * "背景一次比一次黑 + 按钮点不动"（2026-09-12 事故）。
 */
let activeDisposer: (() => void) | undefined

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
/**
 * 复用前的**会话可用性判据**：读宿主两份快照（归档集 + 会话列表），委托给纯判据。
 *
 * 判据不成立 = 这条登记 / 引用已经不能用了（会话被归档、或已被物理删除），调用方
 * **必须**落回新建或给出明确提示 —— 不能再拿着旧 id 去切会话：归档会话切过去会
 * "看似成功"然后被宿主清掉选中（表现是"点了没反应"），已删除会话切过去会直接抛
 * `sessions.select: unknown session`。
 *
 * 2026-09-17 真实故障：判据原先只加在"登记表复用"一处，报告行的 `sessionId`、
 * 任务详情会话页签、草稿横幅三处仍在裸切 —— 用户点了只看到"什么都没发生"。
 */
function aiSessionUsable(runtime: WorkbenchRuntime, sessionId: string): boolean {
  const list = safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')?.list?.getSnapshot?.()
  /**
   * 0.1.7-rc.2 的列表快照不再带 `current`，所以把"当前会话"的判定结果**补进**探针
   * （判据唯一实现在 `currentSession.ts`）。补不进去就保持 `undefined` —— 旧行为。
   */
  const current = currentSessionIdOf(runtime)
  return isAiSessionReusable({
    sessionId,
    archivedSessionIds: safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.list?.getSnapshot?.()?.archivedSessionIds,
    list: list === undefined ? undefined : { ...list, ...(current === '' ? {} : { current }) },
  })
}

/**
 * 当前是否还有**活着的**插件实例。
 *
 * `apply()` 里置真、清理函数里置假。所有异步回调（轮询 tick、await 之后）
 * 都要先看它一眼：卸载之后继续跑副作用会把已卸载的 React root 又更新一遍，
 * 出现"关掉又回来 / 多层遮罩"这类幽灵行为。
 */
let instanceAlive = false

/**
 * 宿主面板选中态的**模块级镜像**（v1.14.45）。
 *
 * 为什么必须有它：宿主把 panelInfo store 挂在 **root 槽位的全局 hook props**
 * （`usePanelInfo`）上，`ctx.layout` 自己没有订阅接口 —— 也就是说只有当某个槽位
 * 组件渲染时，我们才可能读到 `activePanelId`。`WorkbenchPanelContent` 每次渲染都会
 * 把读数写进这两个变量，于是标题栏按钮（同样注册在槽位上）+ CSS 标记 + 互斥判定
 * 全都共享同一个事实，不会出现"三套判据各说各话"。
 *
 * `undefined` 有明确含义：**宿主从未给过这个 hook**（旧宿主）→ 退回本地标志。
 */
let hostPanelId: string | null | undefined
/** 宿主是否提供了 `usePanelInfo`（只要给过就置真，之后不再回退）。 */
let panelInfoHookSeen = false

/**
 * 从运行时快照判断 DSH 跑在 WSL 还是原生 Windows（用于路径形态选择）。
 *
 * ## ⚠️ 这里曾经让低版本宿主上的「快速录入」整个失效（v1.14.50 修复）
 *
 * 原写法是 `safeService(…, 'connection')?.generation.getSnapshot()?.host.home`。
 * `?.` 只保护了**外层调用**，`generation` 本身仍是直接属性访问 ——
 * 而低版本 DSH（0.1.1-rc.1）的 `connection` 服务**没有 `generation`**，
 * 于是抛 `TypeError: Cannot read properties of undefined (reading 'getSnapshot')`。
 *
 * 后果链（实测）：`openQuickEntry` 第一行就调本函数 → 抛错 →
 * `setShowQuick(true)` 永远执行不到 → **点「快速录入」没有任何反应**（弹窗不出现）。
 * 用户现象就是"WSL 上快速录入用不了"。
 *
 * 修法：**每一层都用 `?.`**（`generation?.getSnapshot?.()`），并且整体包 try/catch ——
 * 这只是一个"猜宿主平台"的启发式判断，**任何情况下都不该把调用方炸掉**。
 *
 * 同类隐患的通用规矩：链式可选访问只有**每个可能为空的环节都加 `?.`** 才安全；
 * `a?.b.c` 在 `a.b === undefined` 时照样抛错。
 */
function detectWslHost(runtime: WorkbenchRuntime): boolean {
  try {
    const connection = safeService<WorkbenchRuntime['connection']>(runtime, 'connection')
    /** 低版本没有 `generation`；旧版本的快照接口 `getSnapshot` 也可能缺 —— 两层都防。 */
    const hostHome = connection?.generation?.getSnapshot?.()?.host?.home
    if (typeof hostHome === 'string' && hostHome !== '') return isWslStylePath(hostHome)
    const items = safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.list?.getSnapshot?.()?.items ?? []
    return items.some((item) => typeof item.path === 'string' && isWslStylePath(item.path))
  } catch {
    /** 探测失败就当"不是 WSL"（最保守：路径按原样处理，不会因此崩掉交互）。 */
    return false
  }
}

/** 已打开的工作区路径列表（快速录入的工作区候选之一，去重由调用方做）。 */
function openWorkspacePaths(runtime: WorkbenchRuntime): string[] {
  /** 与 `detectWslHost` 同一处加固：每一层都要 `?.`，否则低版本缺 `list` 时会抛。 */
  return (safeService<WorkbenchRuntime['workspaces']>(runtime, 'workspaces')?.list?.getSnapshot?.()?.items ?? [])
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
  const ctx = getPluginCtx() as { get?: (key: string) => unknown } | undefined
  const uiWorkspace = optionalService<{ connectWorkspace?: (id: string) => Promise<string> }>(ctx, 'uiWorkspace')
  if (typeof uiWorkspace?.connectWorkspace === 'function') return await uiWorkspace.connectWorkspace(workspaceId)
  const runtime = getPluginCtx() as WorkbenchRuntime
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
  /**
   * 等某个槽位出现后再注册。回调是**普通函数**，其返回值即 disposer ——
   * 见下方注册处的实测说明（generator 形态在本宿主未生效）。
   */
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
   *
   * ⚠️ **这是本宿主上唯一能真正读到宿主面板选中态的通道**（2026-09-13 读宿主源码核实）：
   * 宿主的 `ctx.layout` 是 `LayoutController`（只有 `selectPanel` / `toggleSidebar` /
   * `openRightbar` / `closeRightbar` / `beginNavigation` / `dispose`），
   * **没有 `subscribe` / `getSnapshot` / `panelInfo`** —— 那个 store 被挂成
   * *root 槽位 hook*（`ui-layout` 的 `ctx.slots.provideRoot({ hooks: { panelInfo } })`），
   * 只能由槽位组件通过这份全局 props 读到。
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
  /**
   * 本地回落：宿主没给全局 props 时，先问通用订阅句柄，再退到本地开关。
   *
   * 这一段是**取值**（把三条可能的来源收敛成一个布尔），判定本身交给 `decidePanel` ——
   * 与面板容器、`isDisplayed()` 共用同一份判据（设计文档 P1）。
   */
  const localSelected = (hostPanelId === undefined ? workbench.isHostSelected?.() : undefined) ?? workbench.isOpen()
  const active = shouldShowPanel({
    stateReadable: hostPanelId !== undefined,
    hostPanelId: hostPanelId ?? null,
    intentOpen: localSelected,
  })
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
 * 注册给宿主 `sidebar.panellist` 的**稳定组件**（v1.14.5）。
 *
 * 与 `WorkbenchPanelContent` 同样的道理：函数身份一变，宿主重渲染时 React
 * 会卸载重挂整个面板行图标（表现为侧栏那一行闪烁）。
 * 本组件无状态、只读 owner props，所以放在模块作用域零成本。
 */
function WorkbenchPanelEntry(props: Record<string, unknown>): JSX.Element {
  const size = typeof props.size === 'number' ? props.size : 18
  return <WorkbenchPanelIcon size={size} />
}

/**
 * 官方侧栏面板行里的图标（`sidebar.panellist`，kind=list、scope=root）。
 *
 * 行按钮、Tooltip、`aria-label`、`aria-current="page"`、行高与折叠态圆形
 * **全部由宿主 `PanelRow` 渲染** —— 本组件只负责图标本身，这正是不再需要
 * 自己往侧栏 DOM 里注入 `<button>` + 硬编码尺寸的原因。
 */
function WorkbenchPanelIcon({ size }: PanelIconProps): JSX.Element {
  return <Icon name="today" size={size ?? 18} />
}

/**
 * 注册给宿主 `shell.overlay` 的**稳定组件**（v1.14.11 关键修正）。
 *
 * ## 为什么从 `main` 搬到 `shell.overlay`
 *
 * `main` 是**键槽**：`activePanelId` 一变，宿主就卸载旧键的子树、挂载新键的子树。
 * 我们把这个 App（里面除了面板还装着**待确认草稿弹框**）放进 `main` 的后果：
 * 关掉面板 = 整个 App 卸载 = 弹框消失（用户实测"只能回到工作台页面才看得到弹框"），
 * 而且每次开合都重建整棵树，依赖 `useEffect` 拉数据的「今日容量」会在重建窗口里
 * 渲染成空壳。
 *
 * `shell.overlay` 是框架级浮层（list/root，**始终挂载**，契约明说 entries 可自行
 * opt back into pointer events），正好是这种"跨页面常驻"内容的归属地。
 *
 * 面板的显隐不再依赖"宿主渲染哪个键"，而由**是否被选中**（`layout.selectPanel`）决定 ——
 * 见 `WorkbenchPanelContent` 的实现与 CSS 的 `[data-dsh-...-view]` 门控。
 */
let workbenchHost: {
  runtime: WorkbenchRuntime
  isOpen: () => boolean
  closePanel: () => void
  subscribe: (listener: () => void) => () => void
  /**
   * 只在"宿主面板状态不可读"时调用一次：把 App 改挂到自建常驻容器，
   * 使官方满屏层**不承载内容**（否则它会永久盖住界面，2026-09-13 事故）。
   */
  onUnreadableHostState?: () => void
  /**
   * 把「本组件当前观察到的宿主面板选中态」写回模块级状态。
   *
   * 这是**唯一真正可用的宿主状态通道**：宿主的 panelInfo store 挂在 root 槽位的
   * 全局 hook props 上（`usePanelInfo`），`ctx.layout` 自己没有订阅接口。
   * 因此由槽位组件在渲染期间把读到的值回写，供 `slotApi` / 标题栏按钮 / CSS 同步使用。
   * 回写是幂等的纯函数式赋值（同值不触发任何动作），不会引起渲染循环。
   */
  reportHostPanelId?: (panelId: string | null | undefined) => void
  /** 宿主是否给了 `usePanelInfo`（= 宿主面板状态**可读**）。 */
  hasPanelInfoHook?: () => boolean
  /** 宿主面板状态可读时的选中态（不可读返回 undefined）。 */
  hostSelected?: () => boolean | undefined
  /** 兄弟插件是否正开着面板（DOM 契约层判定，官方路径下也要问）。 */
  siblingPanelActive?: () => boolean
  /**
   * 收起兄弟插件的面板标记并广播家族激活事件。
   *
   * 由 `WorkbenchPanelContent` 在「宿主选中了我们」时调用 —— 用于清掉**残留**的
   * 兄弟标记（真实 task-board 只在关闭时才摘自己的标记，所以"被挤掉又点回来"时
   * 它会残留）。做法与 task-board 打开时对 ssh 做的完全一致，属家族既定约定。
   */
  takeOverFamilyPanel?: () => void
  /** 同步 `<html>` 上的激活标记（宿主状态变化后调用，供 CSS 与标题栏按钮读）。 */
  syncActiveAttribute?: (active: boolean) => void
  /** 本地开关的权威状态（不依赖宿主订阅链）。 */
  isLocalOpen?: () => boolean
  /** 本地开关是否处于"被用户强制收起"状态。 */
  isForcedClosed?: () => boolean
  /** 宿主面板状态能否被安全读取（= layout 服务可用）。 */
  stateReadable?: () => boolean
} | undefined

/**
 * 注册给宿主 `shell.overlay` 的面板内容（v1.14.41 恢复官方路径）。
 *
 * ## 关键设计：**开合以宿主 `activePanelId` 为准**（v1.14.45 定案）
 *
 * 上一版按**本地** `open` / `forcedClosed` 两个变量决定显隐，于是宿主自己的入口行
 * 点下去之后：宿主 `activePanelId` 变成 `personal-workbench`（侧栏那一行高亮、
 * 会话内容让位），而我们的 `.wb-panel-host` 拿不到任何通知 → `data-open` 仍是
 * `undefined` → **中央一片空白**（用户截图实测："点了没用"，其实是"没人通知我们"）。
 *
 * 三套判据各说各话的教训（交接文档第 5 节）在这里收敛成一条：
 *
 * ```text
 * 显示 = 没被别人挤掉 && (宿主选中了我们 ?? 本地标志)
 * ```
 *
 * - **宿主状态可读**（拿到了 `usePanelInfo`）→ 唯一事实来源，本地标志不参与判断。
 *   这样"宿主行点开"和"我们自己的行点开"走的是同一条判据，不可能分叉。
 * - **宿主状态不可读**（旧宿主 / 没有该 hook）→ 退回本地标志（迁移前的老行为）。
 *
 * `isForcedClosed` 只在"宿主 state 不可读"时参与 —— 一旦可读，用户的"关"通过
 * `layout.selectPanel(null)` 就能送达宿主，宿主的 `activePanelId` 自己会变成 null，
 * 不需要本地再压一层（压了就会出现"关掉后再点官方行打不开"的另一个 bug）。
 */
function WorkbenchPanelContent(props: Record<string, unknown>): JSX.Element | null {
  const host = workbenchHost
  /**
   * 宿主注入的全局 props。**必须在组件顶层无条件调用**（Hooks 规则）——
   * 这里不是条件调用：`?.()` 只在宿主根本没给这个 props 时跳过，而那种宿主
   * 每个实例渲染期间都恒定不给，同一实例内 hooks 数量不变。
   *
   * 为什么不能省：这是本宿主上**唯一**能拿到 `activePanelId` 的通道
   * （`ctx.layout` 上没有订阅接口，见 `WorkbenchSlotApi.usePanelInfo` 的说明）。
   * 标题栏按钮（`WorkbenchHeaderEntry`）一直是这么读的，本组件只是补上同一条通道。
   */
  const usePanelInfo = props.usePanelInfo as ((selector: (info: { activePanelId: string | null }) => unknown) => unknown) | undefined
  const hostPanelId = usePanelInfo?.((info) => info.activePanelId) as string | null | undefined

  const [, setTick] = useState(0)
  useEffect(() => {
    if (host === undefined) return
    return host.subscribe(() => setTick((value) => value + 1))
  }, [host])
  /**
   * 三个输入都是**取值**（把宿主能力与本地标志读成布尔），判定交给下面的纯函数。
   *
   * - `hostReadable`：宿主是否提供了 `usePanelInfo`（= 面板状态可读，走官方路径）；
   * - `localOpen` / `forcedClosed`：本地开关及其"被用户强制收起"标记，仅作回落。
   */
  const hostReadable = host?.hasPanelInfoHook?.() === true
  const localOpen = host?.isLocalOpen?.() ?? host?.isOpen() ?? false
  const forcedClosed = host?.isForcedClosed?.() ?? false
  const snapshot = { stateReadable: hostReadable, hostPanelId: hostPanelId ?? null, intentOpen: !forcedClosed && localOpen }
  /**
   * 显示与否与 `data-open` 投影都走**同一个** `decidePanel()`（设计文档 P1 + I2）。
   *
   * 改动前这里是内联表达式 `hostReadable ? hostSelected : (!forcedClosed && localOpen)`，
   * 而**同一个语义**在 `isDisplayed()` 里又写了一遍、在 `WorkbenchHeaderEntry` 里写了第三遍 ——
   * 三处读的输入集合不同，bug 2/6/9 都出在这里。
   *
   * `stateReadable` 对应"官方路径是否驱动着显隐"：
   * - 可读 → 只信宿主 `activePanelId`，本地标志**不参与**（否则会出现"关掉后再点官方行打不开"）；
   * - 不可读 → 退回本地意图 `localOpen && !forcedClosed`（与迁移前一致）。
   */
  const open = shouldShowPanel(snapshot)
  const dataOpen = panelDataOpen(snapshot)

  /**
   * ⚠️ **所有 DOM 写入都必须放在 effect 里，绝不能留在渲染期**（v1.14.47 修复）。
   *
   * ## 这里踩了什么
   *
   * 上一版把这两件事直接写在组件体的渲染逻辑里：
   *
   * ```tsx
   * host?.reportHostPanelId?.(hostPanelId)   // 改模块级变量
   * host.syncActiveAttribute?.(open)         // 写 document.documentElement 属性
   * ```
   *
   * 渲染期改 DOM / 改外部可变状态是 React 明令禁止的：它在 concurrent 渲染下可能被
   * **重复执行或丢弃**，而"写属性 → 触发观察器 → 再触发渲染"这种回路会让浏览器
   * 主线程被占满 —— 用户现象就是**点开工作台后整个页面卡死**（WSL 侧）
   * 以及**点「收起侧边栏」后 Edge 卡死**（Windows 侧；两条路径都会经过本组件渲染）。
   *
   * 本文件里我自己在别处写下的规矩就是"副作用一律走 useEffect"
   *（见下方 `takeOverFamilyPanel` 的注释），这两行是执行时的疏漏。
   *
   * ## 现在怎么保证收敛
   *
   * 两个 effect 都是**幂等**的：
   * - `reportHostPanelId` 同值时直接 return（见其实现）；
   * - `syncActiveAttribute` 只在值真的变化时才写属性（见其实现）。
   *
   * 所以"effect 写 → 观察器 → 再渲染 → effect 再跑"这条链会在**第二圈收敛**，
   * 不会无限循环。
   */
  useEffect(() => {
    host?.reportHostPanelId?.(hostPanelId)
    host?.syncActiveAttribute?.(open)
  }, [host, hostPanelId, open])
  /**
   * 宿主已经把我们选为当前面板、但页面上还留着兄弟插件的激活标记时，**由我们把它收起来**。
   *
   * ## 为什么必须有这一步（2026-09-13，本轮最后一个真 bug）
   *
   * 上一版把"兄弟面板开着"同时用在了**两个地方**：① 观察器里"兄弟开了就关掉自己"；
   * ② 显示条件里"兄弟开着就不显示"。第 ② 条制造了一个**死锁**：
   *
   * ```text
   * 面板被兄弟挤掉（我们把自己关了，宿主 activePanelId 仍是我们）
   *   → 兄弟标记如果残留（真实 task-board 就会留着，它只在关闭时摘）
   *   → 显示条件恒假
   *   → 用户再点入口：宿主的 selectPanel(同一个值) 被 React 判定为"无变化"，
   *     连重渲染都不会发生
   *   → 面板**永远打不开**
   * ```
   *
   * 正确做法是把"让位"只保留在 ①（观察器主动关掉自己，宿主状态随之为 null），
   * 而显示与否**只信宿主**；一旦宿主选中我们，我们就把残留的兄弟标记收掉 ——
   * 这正是 task-board 自己打开时对 ssh 做的事（`applyActive()` 里摘兄弟属性 + 广播），
   * 属于家族既定约定，不是新发明。
   */
  useEffect(() => {
    /**
     * 宿主选中我们时收掉残留的兄弟标记。
     *
     * 判据用 `snapshot.hostPanelId`（宿主选中的是不是我们）—— 这与"面板该不该显示"
     * **不是同一个问题**：这里问的是"宿主当前选中项是不是本插件"，所以直接把该值
     * 与 `PANEL_NAME` 比即可，无需再走 `decidePanel()`（那会把本地回落也算进来）。
     */
    if (snapshot.hostPanelId !== PANEL_NAME) return
    host?.takeOverFamilyPanel?.()
  }, [snapshot.hostPanelId, host])
  if (host === undefined) return null
  return (
    /**
     * `data-workbench-build-id`：本插件**自建根节点**上的构建标识（plan.md V04-B）。
     *
     * 它读的是 bundle 内联值（`WORKBENCH_BUILD_ID`），**不是** health 接口 —— 验收链拿它
     * 与目标包 manifest、host health 三方比对，才能证明"浏览器真的加载了本次构建"。
     * 不写宿主 html 的任何未知属性（那是别人的 DOM）。
     */
    <div className="wb-panel-host" data-open={dataOpen} data-workbench-build-id={WORKBENCH_BUILD_ID}>
      <div className="wb-app-scope" {...{ [VIEW_ATTR]: '' }}>
        <WorkbenchApp runtime={host.runtime} closePanel={host.closePanel} />
      </div>
    </div>
  )
}

export function apply(ctx: unknown): () => void {
  const runtime = ctx as WorkbenchRuntime
  setPluginCtx(ctx)
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
  disposePreviousInstance()
  instanceAlive = true

  let open = false
  /**
   * 「用户在本插件里显式关掉了面板」的本地权威标志（v1.14.30）。
   *
   * 为什么必须有它：当 `layout.selectPanel` 拿不到时，我们**无法通知宿主取消选中**，
   * 宿主的 `activePanelId` 会一直停在 `personal-workbench`。此时若显隐只信宿主状态，
   * 那张 `fixed; inset:0; z-index:55` 的满屏层就**再也关不掉**，永久盖住会话区
   * （2026-09-13 实测：点「返回对话」后 `data-open` 仍为 "1"）。
   *
   * 语义：用户在本插件内的"关"是**权威**的，直到他再次显式打开。
   */
  let forcedClosed = false
  /**
   * 本地开关变化的**权威通知通道**：不依赖宿主订阅链（那条链在 layout 缺失时是死的），
   * 保证 `WorkbenchPanelContent` 每次开合都能重渲染。
   */
  const openListeners = new Set<() => void>()
  const notifyOpenChange = (): void => { for (const listener of openListeners) { try { listener() } catch { /* 单个订阅者出错不影响其它 */ } } }
  ensureStyle()

  /** 清理幂等标记：`disposePreviousInstance()` 与 cordis 都可能调用清理。 */
  let disposed = false
  const officialDisposers: Array<() => void> = []


  /**
   * 挂载官方 `main` 面板的内容（由注册给宿主的组件 ref 回调调用）。
   *
   * 用 ref 回调而非 hooks：让注册给宿主的组件保持**无 hooks 的稳定函数**，
   * 否则每次 apply 生成新组件类型，宿主重渲染时会整块卸载重挂。
   *
   * 这里再确认一次 `officialConfirmed`：自愈可能已把路径切成 DOM 腿，
   * 那种情况下官方容器必须留空（内容在覆盖层），否则就是两份 App 互相打架。
   */
  /**
   * 把运行时依赖交给常驻组件（真正的赋值在下方 `subscribePanelInfo` 定义之后，
   * 因为 `subscribe` 要用到它）。这里只做占位，保证组件拿到句柄前不会渲染成 null。
   */
  workbenchHost = { runtime, isOpen: () => open, closePanel: () => setOpen(false), subscribe: () => () => {} }
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
  /**
   * ## 宿主能力自检：不满足就**明确不启动**（设计文档 P5，v1.14.52）
   *
   * 这是与"软探测 + 静默降级"**根本不同**的一条路：
   *
   * - 旧做法：探不到 `layout`/`slots` → 判定"宿主不支持官方槽位" → 换 DOM 腿 →
   *   那条腿铺满屏层盖住会话区（用户"除左栏外什么都点不了"），而且**一声不响**；
   * - 新做法：`inject` 声明完整（缺服务 cordis 直接让插件 pending），
   *   万一进来了但槽位不全 → 打一条**可读**日志（含缺什么 + 要求什么版本），
   *   然后**返回空清理函数，不注册任何东西、不写任何 DOM**。
   *
   * 老宿主上工作台不启动是**可接受且刻意**的：与其半死不活地降级，不如明确不启动。
   */
  const capability = checkHostCapabilities({ slots: slots as SlotsProbe | undefined, layout })
  if (!capability.ok) return refuseToStart(capability, (message) => console.error(message))
  /**
   * `layout.selectPanel` 的可用性**决定了走哪条腿**（v1.14.48 修正语义）。
   *
   * ## 判据的语义要分清（这是本项最容易搞错的地方）
   *
   * | 情形 | 含义 | 该怎么做 |
   * |---|---|---|
   * | `layout` 取不到（undefined） | **信息不足**（可能被 isolate/intercept 藏了） | 照走官方路径 |
   * | `layout` 在、但**没有** `selectPanel` | **确凿的无能力** | 必须回退 DOM 腿 |
   *
   * 2026-09-13 在**真实低版本宿主**（DSH 0.1.1-rc.1）上实测到第二种：
   * `protoKeys=[constructor, attachPanels, toggleSidebar, openDetails, closeDetails]`
   * —— 槽位 `sidebar.panellist` 存在，所以旧代码判定"走官方"；
   * 可宿主的侧栏**没有选中面板的机制**，`activePanelId` 永远是 null，
   * 面板永远不显示，而我们的自建入口又被藏起来 → 用户现象"低版本上工作台打不开"。
   *
   * 所以这里把"确凿无能力"作为**回退依据**交给 `officialSlotDecision`，
   * 而"取不到 layout"仍然照走官方（避免重犯 v1.14.27 那次误判）。
   */
  if (typeof selectPanel !== 'function') {
    let shape = `layout=${String(layout)}`
    if (layout !== undefined && layout !== null) {
      try {
        const own = Object.keys(layout as object).slice(0, 20)
        const proto = Object.getPrototypeOf(layout as object)
        const protoKeys = proto === null || proto === undefined ? [] : Object.getOwnPropertyNames(proto).slice(0, 20)
        shape = `typeof=${typeof layout} selectPanelType=${typeof (layout as { selectPanel?: unknown }).selectPanel} ownKeys=[${own.join(',')}] protoKeys=[${protoKeys.join(',')}]`
      } catch (error) {
        shape = `读 layout 形状时抛错：${String(error)}`
      }
    }
    console.warn(`[workbench] 未取到 layout.selectPanel：${shape}`)
  }
  /**
   * `OFFICIAL_ATTR` 是**给 CSS 看的**：它决定"面板内容显示在官方容器里"。
   *
   * ⚠️ 自 v1.14.52 起它**无条件**存在 —— 走不到官方路径时 `apply()` 已在能力自检处
   * 直接返回（见 `capabilities.ts`），所以这里不再有"两条腿二选一"的状态变化。
   * 历史坑：删自愈逻辑时曾把它一起删掉，结果官方面板容器存在但 CSS 不放行
   * → 面板打开后一片空白。
   */
  document.documentElement.setAttribute(OFFICIAL_ATTR, '')
  console.info('[workbench] 已启用官方侧栏槽位 sidebar.panellist + main')

  /**
   * 同步 `<html>` 上的本插件激活标记。
   *
   * 调用点：`setOpen()` 与 `WorkbenchPanelContent` 的 effect（v1.14.47 起副作用只在 effect 里）。
   * **必须幂等**：调用方可能在"属性变化 → 观察器 → 再渲染"的回路里重复调用它，
   * 无脑写属性会让回路停不下来。所以这里只在**值真的变了**时才碰 DOM。
   */
  const syncActiveAttribute = (active: boolean): void => {
    const root = document.documentElement
    const has = root.hasAttribute(ACTIVE_ATTR)
    if (active === has) return
    if (active) root.setAttribute(ACTIVE_ATTR, '')
    else root.removeAttribute(ACTIVE_ATTR)
  }

  /**
   * ⚠️ **已废弃的"自愈复核"——不要恢复它**（v1.14.7 移除，2026-09-15 实测教训）。
   *
   * 曾经的设想：注册表 + DOM 两侧都有证据才算走官方路径，否则撤销注册、回退 DOM 腿，
   * 以此避免"面板打不开但会话列已让位"的空白屏。
   *
   * 实际后果（真实事故）：判定依赖 `Array.isArray(slots.entries(name))`，
   * 而宿主返回的**不是数组** → 判定恒为假 → 我们在**官方注册其实成功**的情况下
   * 主动 `dispose()` 掉注册 → 侧栏同时出现「官方入口行 + 自建 DOM 入口行」两行，
   * 比不做自愈更糟，而且用户没法自己恢复。
   *
   * **结论：不要在不确定的检测结果上做破坏性动作。**
   * v1.14.53 起更进一步：能力不满足就**明确不启动**（`capabilities.ts`），
   * 所以连"降级到另一条腿"这个分支本身都不存在了。
   */

  /**
   * 面板"健康自查" —— **已彻底移除**（v1.14.21）。
   *
   * 曾经的设想：面板处于激活态时若容器测不到尺寸，就自动切到自建常驻容器，
   * 避免用户被卡在"打开没反应"。
   *
   * **实际代价远大于收益**（2026-09-15 用户实测）：
   * - 宿主重排期间完全可能出现**短暂的** 0 尺寸 → 被判为故障；
   * - 一旦判定成立，面板改用自建容器（**界面退化成改造前那套**）；
   * - 而这条判定每 500ms 跑一次，用户**无法自己恢复**（刷新也会在几秒后再次触发）。
   *
   * 判据本身（读自己的几何尺寸）是确定的，但"**在不确定的时机做破坏性动作**"
   * 这个错误和之前那版"自愈复核"是同一个：一次误判就永久降级，而且降级后的形态更糟。
   *
   * v1.14.53：连"切到自建容器"这条退路也随 DOM 腿一起删掉了。
   * 能力不满足时 `apply()` 直接不启动（有可读日志），不存在运行时降级。
   */

  const setOpen = (value: boolean): void => {
    /**
     * 诊断句柄（只为排查用，代价极低）：把"谁在什么时机开关面板"暴露到 window 上。
     * 排查这类"点了没反应"的问题时，光看 DOM 分不清是"没调用"还是"调用了又被重置"。
     */
    try {
      const log = (window as unknown as { __wbDebugLog?: Array<Record<string, unknown>> }).__wbDebugLog
      log?.push({ at: Date.now(), value, caller: new Error().stack?.split('\n')[2]?.trim().slice(0, 90) ?? '' })
      if (log !== undefined && log.length > 50) log.shift()
    } catch { /* ignore */ }
    /**
     * 官方路径：**唯一的开关是 `layout.selectPanel`**（宿主单值状态）。
     *
     * `selectPanel` 抛错是**确定失败信号**（宿主明确说"这个面板没注册"）。
     * v1.14.53 起没有"换覆盖层显示"这条退路了（DOM 腿已删）：只把失败记进日志与
     * `window.__wbDebugLog`，界面保持在宿主选中态 —— 面板打不开时是**可见的空态**，
     * 而不是悄悄换一套容器（那会带来两套门控、双 App 实例与"再也打不开"的连环坑）。
     */
    try {
      selectPanel?.(value ? PANEL_NAME : null)
    } catch (error) {
      console.error('[workbench] layout.selectPanel 调用失败（面板可能未注册）：', String(error))
      return
    }
    open = value
    /**
     * v1.14.45：**不再**用本地 `forcedClosed` 压着显隐。
     *
     * 原因是它会造成一个对称的 bug：关掉面板后 `forcedClosed` 一直为真，
     * 于是用户再点**宿主的**侧栏行（宿主把 `activePanelId` 设回我们）时，
     * 显示条件里的 `!forcedClosed` 仍然为假 → 面板打不开（实测复现）。
     *
     * 现在显隐由 `WorkbenchPanelContent` 按「宿主状态优先」统一判定：
     * `selectPanel(null)` 一成功，宿主的 `activePanelId` 就变成 null，
     * 关这件事已经由**宿主**确认过了，不需要本地再压一层。
     */
    notifyOpenChange()
    syncActiveAttribute(value)
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
        /**
         * 宿主通知"当前选中项变了" → 判定改走同一个纯函数（P1）。
         *
         * 注意语义：这里 `intentOpen: false` —— 宿主可读时它根本不参与判断；
         * 只有宿主给了 store 却不给 activePanelId（既不是我们也不是 null）时，
         * 才会得到"不显示"，与原实现 `info.activePanelId === PANEL_NAME` 等价。
         */
        const next = shouldShowPanel({
          stateReadable: true,
          hostPanelId: typeof info?.activePanelId === 'string' ? info.activePanelId : null,
          intentOpen: false,
        })
        try {
          const log = (window as unknown as { __wbDebugLog?: Array<Record<string, unknown>> }).__wbDebugLog
          log?.push({ at: Date.now(), from: 'layout.subscribe', activePanelId: String(info?.activePanelId), value: next })
          if (log !== undefined && log.length > 50) log.shift()
        } catch { /* ignore */ }
        open = next
        listener()
      })
      return typeof dispose === 'function' ? dispose : () => {}
    } catch { return () => {} }
  }
  /**
   * 宿主镜像给出的选中态：`undefined` = 宿主从未提供过状态通道（**不是** "没选中"）。
   *
   * 与 `hostSelected()` 的分工：本函数只回答"宿主说选中的是不是我们"，
   * 不掺任何本地回落 —— 槽位句柄的 `isHostSelected` 需要的正是这个"未知"语义
   * （调用方据此决定是否退回 `subscribe`）。
   */
  const hostSelectedFromMirror = (): boolean | undefined => (
    panelInfoHookSeen ? hostPanelId === PANEL_NAME : undefined
  )
  const hostSelected = (): boolean => {
    /**
     * v1.14.45：优先用**槽位组件回写的模块级镜像**。
     *
     * 原因：`ctx.layout` 是宿主的 `LayoutController`，接口里**只有** `selectPanel` /
     * `toggleSidebar` / `openRightbar` / `closeRightbar` / `beginNavigation` / `dispose`，
     * 既没有 `subscribe` 也没有 `getSnapshot`（读宿主 `ui-layout` 源码核实）。
     * panelInfo store 挂在 root 槽位的全局 hook props 上，只有槽位组件读得到。
     * 下面那段 `getSnapshot` 试探因此在本宿主上永远拿不到值，只能作历史兼容保留。
     *
     * ## 为什么这里也走 `decidePanel()`
     *
     * 本函数被两个地方消费：槽位句柄的 `isHostSelected`（标题栏按钮的回落），
     * 以及"本插件面板是否真的显示着"（家族互斥让位）。**两处问的都是显示态**，
     * 所以判据必须与面板容器同源；改动前三处各写一遍，正是 bug 2/6/9 的根因。
     */
    const mirrored = hostSelectedFromMirror()
    if (mirrored !== undefined) return mirrored
    /**
     * 历史兼容的第二条通道：`layout.getSnapshot()`。
     *
     * 本宿主没有这个接口（恒为 `undefined`），所以走到这里的结果要么是某个旧宿主
     * 给的宿主状态，要么退回本地 `open`。
     */
    let fromLayout: string | null | undefined
    try {
      const candidate = layout as unknown as { getSnapshot?: () => { activePanelId?: unknown } }
      const snapshot = candidate.getSnapshot?.()
      if (snapshot !== undefined && 'activePanelId' in snapshot) {
        fromLayout = typeof snapshot.activePanelId === 'string' ? snapshot.activePanelId : null
      }
    } catch { /* 读不到就退回本地标志 */ }
    return shouldShowPanel({ stateReadable: fromLayout !== undefined, hostPanelId: fromLayout ?? null, intentOpen: open })
  }
  /**
   * 本插件的面板**当前是不是真的显示着**。
   *
   * ## 为什么历史上必须有这个函数（值得留着，别再犯）
   *
   * ⚠️ **不能用 `open` 这个本地标志**（2026-09-13 实测踩到）：
   * 用户点的是**宿主**的侧栏行，宿主直接调 `layout.selectPanel(id)` 把
   * `activePanelId` 设成我们 —— 我们自己的 `setOpen` 根本没被调用，本地 `open`
   * 依然是 `false`。此时面板是**显示着的**（`WorkbenchPanelContent` 按宿主状态渲染），
   * 但任何 `if (open)` 的判断都会说"没开"。
   *
   * v1.14.53：它原先的**唯一消费者**是家族互斥（兄弟插件 `*-active` 出现时让位），
   * 那条逻辑已删除，所以函数本体也删了。判据本身没有丢 ——
   * 面板"该不该显示"仍然只有一个答案：`shouldShowPanel()`（`panelState.ts`）。
   */

  const slotApi: WorkbenchSlotApi = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
    subscribe: subscribePanelInfo,
    isHostSelected: hostSelected,
  }
  /**
   * 把运行时依赖交给常驻组件；`subscribe` 用真正的选中态订阅，
   * 这样"关掉面板"时组件只是重新渲染成隐藏态，**不会被卸载**。
   */
  workbenchHost = {
    runtime,
    isOpen: () => open,
    closePanel: () => setOpen(false),
    subscribe: (listener) => {
      /**
       * 两条来源都要订：① 本地开关变化（权威、不依赖宿主）；
       * ② 宿主状态变化（宿主自己切换面板时跟随）。任一分支失效都不会让组件失联。
       */
      openListeners.add(listener)
      const disposeHost = subscribePanelInfo(listener)
      return () => { openListeners.delete(listener); disposeHost() }
    },
    isLocalOpen: () => open,
    isForcedClosed: () => forcedClosed,
    stateReadable: () => selectPanel !== undefined,
    /**
     * 宿主面板选中态的**唯一可用通道**回写口。
     *
     * `WorkbenchPanelContent` 每次渲染都会把 `usePanelInfo` 读到的值送到这里，
     * 所以本插件的其它两处（标题栏按钮的 `isHostSelected`、CSS 的 ACTIVE_ATTR）
     * 都拿到同一个事实。幂等：同值时只更新变量，不做任何 DOM 写或通知。
     */
    reportHostPanelId: (panelId) => {
      /**
       * 先记"宿主给过 hook"这个事实，再归一化值。
       *
       * `undefined` 单独有意义（= 宿主不给 hook，读不到宿主状态），所以这里**不能**
       * 把 undefined 也当成 null 写进 `hostPanelId` —— 那会让"不可读"伪装成"读到了 null"，
       * 于是"宿主没选中我们"被当成事实，本地兜底路径就永远走不到了。
       */
      panelInfoHookSeen = true
      const normalized = panelId === undefined || panelId === null ? null : String(panelId)
      if (normalized === hostPanelId) return
      hostPanelId = normalized
    },
    hasPanelInfoHook: () => panelInfoHookSeen,
    hostSelected: hostSelectedFromMirror,
    /**
     * 兄弟插件是否正开着面板。
     *
     * ⚠️ **只看 `<html>` 上的 `*-active` 属性，绝不看"视图容器在不在 DOM 里"**
     * （v1.14.45 实测，差点写错）：task-board 的视图容器
     *（`[data-dsh-taskboard-view]`）是**常驻**的 —— 它的 `panel-mount-core` 把容器
     * 永久挂在会话列里，靠 CSS 按 `data-dsh-taskboard-active` 门控显隐。
     * 所以"容器存在"永远为真，拿它做判据会让本插件**永远打不开**。
     *
     * 唯一可信的信号就是那个属性：task-board 打开时写、关闭时摘
     *（`panel-mount-core.applyActive()`），官方路径与 DOM 腿都读它，语义一致。
     */
    syncActiveAttribute,
    /**
     * 宿主面板状态不可读时的安全兜底（2026-09-13 遮挡事故修复）。
     *
     * 官方满屏层（`.wb-panel-host`：`fixed; inset:0; z-index:55`）一旦承载内容
     * 又收不起来，就会永久盖住会话区与其它插件。读不到宿主状态时，官方容器里**不渲染内容**
     * （见 `WorkbenchPanelContent`）。
     *
     * v1.14.53：原实现还会把 App 改挂到**自建常驻容器**；那条路随 DOM 腿一起删除了。
     * 现在的依赖关系是：能力齐备 → 宿主状态必然可读（`usePanelInfo` 存在），
     * 因此这条兜底在受支持宿主上不会被触发；真触发了也只剩"不渲染 + 日志"，
     * 不会再悄悄换一套容器（那正是双 App 实例与"弹框概率性消失"的来源）。
     */
    onUnreadableHostState: () => {
      console.warn('[workbench] 宿主面板状态不可读：官方面板层不承载内容（不会再切自建容器，见 v1.14.53 说明）')
    },
  }
  /**
   * 诊断日志：记录每一次"开关面板"的调用与来源 —— 排查"点了入口面板不开"时，
   * 光看 DOM 分不清是"没调用"还是"调用了又被重置"。读法：`window.__wbDebugLog`。
   */
  ;(window as unknown as { __wbDebugLog?: unknown[] }).__wbDebugLog = []
  if (slots !== undefined) {
    /**
     * 关于 `inject` 的回调形态（**2026-09-15 实测结论，别再改**）：
     *
     * 官方参照实现用的是 generator（`dsh-client-ui-conversation`：
     * `slots.inject("main", function* () { yield slots.register(...) })`），
     * 于是我曾跟着改成 `function*` + `yield`。结果是**注册没有生效**：
     * 侧栏里只剩自建 DOM 入口行，官方面板行虽被登记但我们的判定拿不到证据，
     * 最终表现为「两行入口」。
     *
     * 本宿主的 cordis 版本里 `ctx.slots.inject(name, cb)` 的 `cb` 走的是
     * "普通函数、返回值当 disposer"这一路（前端 bundle 里连
     * `isGeneratorFunction` 都不存在）。**所以这里必须用普通箭头函数**，
     * 并且把 disposer 记进自己的数组以便主动回退。
     *
     * 教训：官方参照写法未必对本宿主的 cordis 版本有效 —— 改了要**实测**再留。
     */
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
     * 侧栏入口：官方 `sidebar.panellist`（宿主渲染行按钮 + 高亮 + aria）。
     *
     * **面板内容不再注册到 `main`**：`main` 是键槽，`activePanelId` 一变宿主就卸载
     * 整棵子树 —— 而我们这棵树里装着常驻的草稿弹框（关面板就会连弹框一起消失，
     * 用户实测"只能回到工作台页面才看得到弹框"）。改挂**始终存在**的
     * `shell.overlay`（框架级浮层），面板显隐由"是否被选中"决定。
     *
     * 注册进 `main` 的那份只留一个**空占位**：`layout.selectPanel(id)` 会校验
     * "这个 id 有没有对应的 main 条目"，没有就会抛错。给个返回 null 的组件既满足校验，
     * 又不渲染任何东西（真正的内容在 overlay 里）。
     */
    try {
      const disposeList = slots.inject(OFFICIAL_PANEL_LIST_SLOT, () => slots.register(
        { name: OFFICIAL_PANEL_LIST_SLOT, id: PANEL_NAME, order: -4, label: ENTRY_TITLE },
        // 模块级稳定组件（理由见 WorkbenchPanelEntry）
        WorkbenchPanelEntry as unknown as (props: Record<string, unknown>) => JSX.Element | null,
      ))
      if (typeof disposeList === 'function') officialDisposers.push(disposeList)
      // main 只放空占位（让 selectPanel 校验通过）；真内容在 overlay。
      const disposeMain = slots.inject(OFFICIAL_MAIN_SLOT, () => slots.register(
        { name: OFFICIAL_MAIN_SLOT, id: PANEL_NAME, key: PANEL_NAME, order: -4 },
        (() => null) as unknown as (props: Record<string, unknown>) => JSX.Element | null,
      ))
      if (typeof disposeMain === 'function') officialDisposers.push(disposeMain)

      /**
       * 面板内容：**注册到官方 `shell.overlay`**。
       *
       * 为什么不是不 `main`：`main` 是键槽，`activePanelId` 一变宿主就卸载整棵子树 ——
       * 而我们这棵树里装着常驻的草稿弹框（关面板就会连弹框一起消失，用户实测
       * "只能回到工作台页面才看得到弹框"）。`shell.overlay` 是**始终存在**的框架级浮层，
       * 面板显隐由 `decidePanel()`（是否被宿主选中）决定。
       *
       * 历史：2026-09-13 曾因 `slot entry crashed in 'shell.overlay': TypeError: … reading
       * 'subscribe'` 而放弃这个槽位。**那个崩溃的真正根因是 inject 少声明了 `slots` /
       * `layout`**（cordis 没等依赖就绪就调我们的 apply），已由 `inject` 声明修掉，
       * 且现在有 `test/capabilities.test.mjs` 把 inject 精确锁成 5 项。
       */
      const disposeOverlay = slots.inject(OFFICIAL_OVERLAY_SLOT, () => slots.register(
        { name: OFFICIAL_OVERLAY_SLOT, id: PANEL_NAME, order: -4 },
        WorkbenchPanelContent as unknown as (props: Record<string, unknown>) => JSX.Element | null,
      ))
      if (typeof disposeOverlay === 'function') officialDisposers.push(disposeOverlay)
    } catch (error) {
      /**
       * 注册失败**不再降级**（v1.14.53）：DOM 腿已删除，没有第二条路可走。
       * 这里只把失败说清楚 —— 用户看到的是"侧栏没有工作台入口"，
       * 而 console 里能查到确切原因，不会像以前那样悄悄换一套界面。
       */
      console.error('[workbench] 官方槽位注册失败：侧栏不会出现工作台入口。原因：', String(error))
    }
  }

  /**
   * 侧栏宽度 → `--wb-sidebar-w`（面板左边界）。
   *
   * 量出侧栏宽度写进 CSS 变量：面板从侧栏右侧开始铺，
   * **绝不遮住 DSH 左侧导航**（用户实测反馈：改造后面板盖住了整个左侧栏）。
   *
   * ## v1.15.5 改了取值口径（DSH 0.1.7-rc.2「收起侧栏后铺不满」的真实原因）
   *
   * 旧口径（v1.14.21）："只接受 `>0 且 < 视口 40%` 的宽度，其余一律不更新"。
   * 在 rc2 上，收起侧栏后**栏目宽度就是 0** —— 旧口径把这当成"量取失败"，
   * 于是 `--wb-sidebar-w` 永远停在收起前的旧值（280px），面板左边一直空出一条。
   *
   * 现在的判据在纯函数 `decideSidebarWidth()` 里（`panelGeometry.ts`，有单测）：
   * 找不到元素 → 不更新；宿主公布了宽度 → 采信它；几何 ≤0 → **采信 0**；
   * 超过视口 40% → 判定为量错元素、不更新。
   *
   * v1.14.47 的**幂等保护**保留：本函数由观察器回调调用，而它自己会改 `<html>`
   * 上的内联样式 —— 无脑写 CSS 变量可能让布局再变一次、再次触发回调
   * （用户现象："点「收起侧边栏」后 Edge 卡死"）。同值不写，"测量 → 写值 → 再测量"
   * 这条链最多跑两圈就收敛。
   */
  /**
   * 找"真正的宿主 frame"。
   *
   * 布局类名带构建期 hash，只能按子串 `[class*="frame"]` 找，而**别的元素也可能带这个
   * 子串**（同一份 CSS module 的其它类、或第三方壳）。所以按 `pickFrameCandidate`
   * 的判据挑：谁真的让出了顶部空间（`padding-top` 最大）谁就是 frame；
   * 全为 0 时取第一个（网页版本来就该是 0，取谁都一样）。
   */
  const findFrameInset = (): { element: HTMLElement | null; paddingTop: number } => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('[class*="frame"]'))
    if (candidates.length === 0) return { element: null, paddingTop: 0 }
    const paddings = candidates.map((element) => Number.parseFloat(window.getComputedStyle(element).paddingTop))
    const index = pickFrameCandidate(paddings)
    if (index < 0) return { element: null, paddingTop: 0 }
    return { element: candidates[index], paddingTop: paddings[index] }
  }

  const syncSidebarWidth = (): void => {
    /**
     * 选择器口径：DSH 自己的布局类名带了构建期 hash（`ZTP-Xa_sidebarCol`），
     * 所以只认 `[class*="sidebarCol"]` 这个**子串**。`[data-pane="sidebar"]`
     * 优先（第三方壳也可能加），但它可能命中别的列，故不单独使用。
     */
    const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
    if (column === null) return
    const frame = findFrameInset().element
    /**
     * 宿主自己公布的侧栏宽度（rc2 在 `[data-windows-titlebar]` 时写在 frame 的内联样式上）。
     * 它是"栏目宽度"的权威值：收起时就是 0，所以量宽失败时靠它判"收起"。
     */
    const declaredRaw = frame?.style.getPropertyValue(HOST_SIDEBAR_WIDTH_VAR).trim() ?? ''
    const declared = declaredRaw === '' ? null : Number.parseFloat(declaredRaw)
    const decision = decideSidebarWidth({
      exists: true,
      width: column.getBoundingClientRect().width,
      declaredWidth: declared !== null && Number.isFinite(declared) ? declared : null,
      viewportWidth: window.innerWidth,
    })
    if (decision.width === null) return
    const next = `${decision.width}px`
    if (document.documentElement.style.getPropertyValue('--wb-sidebar-w').trim() === next) return
    document.documentElement.style.setProperty('--wb-sidebar-w', next)
  }
  const sidebarResizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => syncSidebarWidth())
  /**
   * 收起/展开是**属性**变化（frame 上的 `data-sidebar-collapsed`），不是我们观察的那个
   * 栏目元素被替换；两者时序也不保证（先变属性、再走 300ms 过渡）。所以再挂一个属性观察器：
   * 属性一变就立刻按"宿主公布值"同步一次，不等几何（同值不写，不会自激）。
   */
  const sidebarCollapseObserver = typeof MutationObserver === 'undefined'
    ? undefined
    : new MutationObserver(() => syncSidebarWidth())

  /**
   * 桌面壳标题栏高度 → `--wb-top-inset`（面板上边界）。
   *
   * ## 为什么要这个变量（2026-09-26 用户反馈："顶部占用了桌面端的 Title，无法正常点击"）
   *
   * DSH 0.1.7-rc.2 桌面壳在 `<html>` 上加 `data-windows-titlebar`，并给 frame
   * 加 `padding-top: var(--dsh-windows-titlebar-height)` + 一条 `-webkit-app-region: drag`
   * 的标题栏（窗口按钮也在那条带子里）。工作台面板挂在 `shell.overlay` 下、自己
   * `position:fixed; top:0`，**不跟着 frame 的 padding 走** → 面板内容正好盖在标题栏上。
   *
   * 判据在纯函数 `decideTopInset()` 里：没有该属性 → 0（网页版 / macOS / 老宿主零影响）；
   * 有属性 → 取 frame 的计算 `padding-top`（最贴事实），再退到宿主的变量值，最后兜底 32px。
   */
  const readTitlebarInset = (): number => {
    const html = document.documentElement
    const attributePresent = html.hasAttribute(HOST_WINDOWS_TITLEBAR_ATTR)
    const { element: frame, paddingTop } = findFrameInset()
    const declaredRaw = attributePresent && frame !== null
      ? window.getComputedStyle(frame).getPropertyValue(HOST_TITLEBAR_HEIGHT_VAR).trim()
      : ''
    const declared = declaredRaw === '' ? Number.NaN : Number.parseFloat(declaredRaw)
    return decideTopInset({
      attributePresent,
      framePaddingTop: frame === null ? Number.NaN : paddingTop,
      declaredHeight: Number.isFinite(declared) ? declared : null,
    }).inset
  }
  const syncTopInset = (): void => {
    const next = `${readTitlebarInset()}px`
    if (document.documentElement.style.getPropertyValue('--wb-top-inset').trim() === next) return
    document.documentElement.style.setProperty('--wb-top-inset', next)
  }
  /**
   * 标题栏高度是"随窗口/壳状态而变"的运行时量取值，而 frame 可能比插件后渲染。
   * 所以按"重试到量到为止"的口径：先试几次，量到 >0 就停；量不到就短轮询十几秒
   * （窗口最大化/还原、壳模式切换都会让几何变化，浏览器事件与定时器一起兜住）。
   */
  const titlebarAttributeObserver = typeof MutationObserver === 'undefined'
    ? undefined
    : new MutationObserver(() => syncTopInset())
  titlebarAttributeObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [HOST_WINDOWS_TITLEBAR_ATTR],
  })
  syncTopInset()
  let titlebarRetries = 0
  const titlebarTimer = setInterval(() => {
    titlebarRetries += 1
    if (readTitlebarInset() > 0 || titlebarRetries > 15) { clearInterval(titlebarTimer); return }
    syncTopInset()
  }, 1000)
  window.addEventListener('resize', syncTopInset)
  /**
   * 找到侧栏并量宽；找不到返回 false，由下面的轮询继续重试。
   *
   * ## ⚠️ 为什么必须"重试到量到为止"（v1.14.54 真实事故）
   *
   * 本函数原先只在 `apply()` 里被调用**一次**，而 `apply()` 发生在插件加载那一刻 ——
   * 那时 DSH 界面**还没渲染**，`sidebarCol` 不存在 → 直接 return，
   * `--wb-sidebar-w` 从未被写上。
   *
   * 后果：`.wb-panel-host` 的 `left: var(--wb-sidebar-w, 0px)` 拿到兜底 **0px**，
   * 面板从视口最左边开始铺 → **整个 DSH 页面（含侧栏）被工作台盖住**
   * （用户原话："工作台页面会完全覆盖整个DSH页面，侧边栏都没有了"）。
   *
   * 阶段 2 删 DOM 降级腿时，我把原先那个 `MutationObserver`（`watcher`）一并删了 ——
   * 它虽然主要服务于"往侧栏插入口行"，但也是**唯一**会让本函数被反复调用的东西。
   * 现在补一个职责单一的观察器：只负责"等侧栏出现并量宽"，量到就断开。
   */
  const observeSidebar = (): boolean => {
    const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
    if (column === null) return false
    sidebarResizeObserver?.disconnect()
    sidebarResizeObserver?.observe(column)
    syncSidebarWidth()
    /**
     * 顺带盯 frame 的收起标记：`data-sidebar-collapsed` 一变就再同步一次。
     * frame 找到才算观察成功（找不到就交给下面的重试轮询）。
     */
    const frame = document.querySelector<HTMLElement>('[class*="frame"]')
    if (frame === null) return false
    sidebarCollapseObserver?.disconnect()
    sidebarCollapseObserver?.observe(frame, { attributes: true, attributeFilter: [HOST_SIDEBAR_COLLAPSED_ATTR] })
    return true
  }
  let sidebarObserver: MutationObserver | undefined
  if (!observeSidebar()) {
    sidebarObserver = new MutationObserver(() => {
      if (!observeSidebar()) return
      sidebarObserver?.disconnect()
      sidebarObserver = undefined
    })
    sidebarObserver.observe(document.body, { childList: true, subtree: true })
  }

  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    instanceAlive = false
    sidebarResizeObserver?.disconnect()
    sidebarCollapseObserver?.disconnect()
    sidebarObserver?.disconnect()
    titlebarAttributeObserver?.disconnect()
    clearInterval(titlebarTimer)
    window.removeEventListener('resize', syncTopInset)
    for (const dispose of officialDisposers.splice(0)) {
      try { dispose() } catch { /* 卸载阶段不再纠缠 */ }
    }
    const html = document.documentElement
    /**
     * 只摘自己写过的两个属性（设计文档 I4 白名单）：ACTIVE_ATTR 与 OFFICIAL_ATTR。
     * `--wb-sidebar-w` 是内联样式变量，留着无害（下一次 apply 会按真实宽度覆盖）。
     */
    html.removeAttribute(ACTIVE_ATTR); html.removeAttribute(OFFICIAL_ATTR)
    if (getPluginCtx() === ctx) setPluginCtx(undefined)
    if (workbenchHost?.closePanel === undefined ? false : workbenchHost.runtime === runtime) workbenchHost = undefined
    if (activeDisposer === cleanup) activeDisposer = undefined
  }
  // 注册给模块级守卫：下一次 apply() 会先调用它拆掉本轮，避免残留实例。
  activeDisposer = cleanup
  return cleanup
}
