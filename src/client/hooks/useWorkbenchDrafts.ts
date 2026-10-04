/**
 * D17 / P5-3：**草稿域（Drafts）的唯一所有者**。
 *
 * 拆分前这些散在 `src/client/index.tsx` 的 `WorkbenchApp` 里（7 项 state 在 L300-387，
 * 3 个 ref 在 L321-339，动作在 L1882-1989，轮询里的草稿那半段在 L576-626）。
 * 本 hook 收口的是**待确认草稿的投影 + 暂存/唤回 + 重复建单收口**这一域：
 *
 * - 7 项 state：`pendingDraft` / `deferredDrafts` / `draftProblems` / `draftSwitchedFrom` /
 *   `allPendingDrafts` / `pendingOpen` / `duplicatePrompt`。
 * - 3 个 ref：`dismissedDraftIdsRef`（"看过就收起"的本地屏蔽集合，**不参与待处理计数**）、
 *   `deferredWhenDismissedRef`（屏蔽时它是否处于暂存态，只用于识别"暂存 → 唤回"）、
 *   `bannerDraftRef`（弹框当前显示哪一份，用于发现"被静默换人"）。
 * - 5 个域动作：`dismissDraft` / `resumePendingDraft` / `resumeDeferredDraft` /
 *   `handleDraftConfirmed` / `reuseExistingTask`，外加轮询用的 `tickDrafts`。
 *
 * ## 三条不许动的语义（都在原注释里写明白了，一并搬过来）
 * 1. **服务端清单与本地"要不要弹"分离**：`allPendingDrafts` 存服务端事实（计数与清单用它），
 *    `pendingDraft` 才是"要不要弹"。用 `dismissedDraftIdsRef` 过滤计数会让"点一次关闭，
 *    待处理就从 1 变 0"（2026-09-15 用户实测 BUG）。`pendingCount` 由装配层按
 *    `allPendingDrafts.length + reminders.length` 算，**不经本地屏蔽集合**。
 * 2. **只有"暂存 → 唤回"才解除屏蔽**：单纯点 X 收起时草稿从来不是暂存态，若因此清掉屏蔽，
 *    弹框 5 秒后又会自己冒出来（最早修过的 BUG）。
 * 3. **弹框被静默换人时必须说出来**：类型变化时设 `draftSwitchedFrom`，否则用户接着点主按钮
 *    确认的已经不是他以为的那一份（2026-09-13 重复建单事故）。
 *
 * ## 刻意**不**拥有的东西（跨域，按设计 §5 由装配层组合或注入）
 * - **任务数据域**：`reuseExistingTask` 收口成功后要 `void refresh()` 重新拉 bootstrap，
 *   以注入形式进来；本 hook 不 import `useTaskData`。
 * - **反馈**：`resumeDeferredDraft` / `handleDraftConfirmed` / `reuseExistingTask` 用
 *   `setError` / `setNotice` 说话 —— 两个写口注入。
 * - **`DraftBanner` 那一整块 JSX**：它的 `onDone` 同时写点子域（`ideas.actions.refresh()`）、
 *   知识域（`bumpRefreshKey()`）与日期域（`bumpPlanRefresh()` / `bumpReportRefresh()`），
 *   属装配层的跨域组合，必须留在 `index.tsx`；本 hook 只交出状态与动作。
 * - **`pendingDraft` → `PENDING_ATTR` 的那条 effect**：它写 `document.documentElement`，
 *   是**宿主 DOM 投影**（设计 §4.1 末行：DOM 白名单和清理不变），留在装配层。
 * - **轮询的时段与容器**：5 秒 tick / 15 秒 refresh 那条 effect 归
 *   `hooks/useWorkbenchPolling.ts`（P5-3 新文件），本 hook 只交出草稿那半段
 *   `tickDrafts`，**不另起定时器**（设计 §7 P5 行的出口口径：无双轮询）。
 *
 * ## 为什么 `tickDrafts` 接收 `isAlive` 且必须是稳定的 `useCallback`
 * 原实现在草稿 fetch 之后有一句 `if (alive) { ... }`，挡的是"组件已卸载才有响应回来"的那一次：
 * 那时既不该 `setPendingDraft`，也不该动 `bannerDraftRef`。`alive` 是装配层 effect 闭包里的
 * 局部量，所以以回调形式传进来，逐字保留这条守卫。
 * `useCallback(..., [])` 是**必须**的：本函数体内只用 ref 与稳定 setter，没有会变的闭包值，
 * 而 `useWorkbenchPolling` 把它放进 effect 依赖数组 —— 身份若每次渲染都变，5 秒定时器会被
 * 反复重建（每渲染都立即多跑一次 tick）。
 */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api } from '../api.js'
import type { DraftView } from '../../shared/contracts.js'
import type { DraftConfirmOutcome } from '../components/DraftBanner.js'

/** 「库里已有同名任务」的待决提示（`reuseExistingTask` 的入参形状）。 */
export interface DraftDuplicatePrompt {
  draftId: string
  existingTaskId: string
  existingTitle: string
  sameDescription: boolean
  sameWorkspace: boolean
  /** 本次已经建出来的那条（"就删掉这条新建的"用得上）。 */
  newTaskId: string
}

export interface UseWorkbenchDraftsInput {
  /** 任务数据域：草稿确认/收口之后要重新拉 bootstrap（`void refresh()`）。 */
  refresh: () => Promise<void>
  onError: (message: string | null) => void
  onNotice: (message: string | null) => void
}

export interface UseWorkbenchDraftsActions {
  /** 语义化 setter：装配层直接透给 `DraftBanner` / 各弹窗。**都是原生 `Dispatch`**。 */
  setPendingDraft: Dispatch<SetStateAction<DraftView | null>>
  setDraftProblems: Dispatch<SetStateAction<Array<{ title: string; field: string; code: string; reason: string }>>>
  setDuplicatePrompt: Dispatch<SetStateAction<DraftDuplicatePrompt | null>>
  setPendingOpen: Dispatch<SetStateAction<boolean>>
  /** 收起一条草稿横幅：记屏蔽，并记下它当时是不是暂存态。 */
  dismissDraft: (draft: DraftView) => void
  /** 从「待处理」里重新打开某份草稿的弹框（撤销本地屏蔽，不触发请求）。 */
  resumePendingDraft: (draft: DraftView) => Promise<void>
  /** 唤回一份暂存草稿：清掉暂存标记，它会立刻重新弹出待确认弹窗。 */
  resumeDeferredDraft: (draftId: string) => Promise<void>
  /** 确认接口的业务回执处理（`duplicateOf` / `replayed` / `reused` 三种）。 */
  handleDraftConfirmed: (outcome: DraftConfirmOutcome, draft: DraftView) => void
  /** 「就用已有那条」：把草稿收口到已有任务，并归档本次多建出来的那条。 */
  reuseExistingTask: (prompt: DraftDuplicatePrompt) => Promise<void>
  /**
   * 轮询的一次"草稿那一半"：拉待确认草稿 → 过滤本地屏蔽 → 更新投影。
   * `isAlive` 由装配层注入（见文件头）；失败时**向外抛**，由 `useWorkbenchPolling`
   * 那条 `catch` 与提醒那半段共用同一个异常范围。
   */
  tickDrafts: (isAlive: () => boolean) => Promise<void>
}

export interface UseWorkbenchDraftsResult {
  /** 当前要弹出的草稿（`null` = 不弹）。它**已被本地屏蔽集合过滤**。 */
  pendingDraft: DraftView | null
  /** 已暂存的待确认草稿：不自动弹窗，只在「待处理」弹窗里等你唤回。 */
  deferredDrafts: DraftView[]
  draftProblems: Array<{ title: string; field: string; code: string; reason: string }>
  draftSwitchedFrom: { kindCode: string; draftId: string } | null
  /** 服务端当前**全部** pending 草稿（含"看过就收起"的）。待处理计数用它。 */
  allPendingDrafts: DraftView[]
  pendingOpen: boolean
  duplicatePrompt: DraftDuplicatePrompt | null
  actions: UseWorkbenchDraftsActions
}

export function useWorkbenchDrafts(input: UseWorkbenchDraftsInput): UseWorkbenchDraftsResult {
  const { refresh, onError: setError, onNotice: setNotice } = input
  const [pendingDraft, setPendingDraft] = useState<DraftView | null>(null)
  // 已暂存的待确认草稿：不自动弹窗，只在「待处理」弹窗里等你唤回
  const [deferredDrafts, setDeferredDrafts] = useState<DraftView[]>([])
  /**
   * 确认草稿时「本该创建但没创建」的条目（v1.14.0 静默丢件修复的界面侧）。
   * 用常驻横幅而不是 toast：这是"你的东西少了一部分"的告警，不能 4 秒后自己消失。
   */
  const [draftProblems, setDraftProblems] = useState<Array<{ title: string; field: string; code: string; reason: string }>>([])
  /**
   * 已被用户处理过的草稿 id（v1.14.2）。
   *
   * 为什么必须记：待确认草稿有**两个数据源** —— 5 秒轮询的 `/api/workbench/drafts`
   * 与弹框自身的操作结果。用户点了"放弃/确认"之后，如果那个请求失败了
   * （例如并发点击导致"already abandoned"），轮询仍会返回这份草稿，
   * 于是弹框被重新推上来 —— 用户看到的就是"关掉 5 秒后又弹出来"。
   *
   * ⚠️ 语义边界（2026-09-15 修正）：这个集合只管**"要不要自动弹窗"**，
   * **不参与「待处理」计数**。之前用它同时过滤计数，导致"点一次关闭，
   * 右上角待处理就从 1 变 0"（用户实测）—— 而草稿在服务端仍然是 pending，
   * 计数撒谎比不弹窗更糟。计数一律以服务端数据为准。
   */
  const dismissedDraftIdsRef = useRef<Set<string>>(new Set())
  /**
   * 「屏蔽这份草稿时，它处于暂存态」的 id 集合。
   *
   * 只用于识别"暂存 → 唤回"这一次状态转换：唤回后应当解除屏蔽、重新弹框；
   * 而用户单纯点 X 收起（草稿从来不是暂存态）时**不能**因此解除，否则弹框会自己回来。
   */
  const deferredWhenDismissedRef = useRef<Set<string>>(new Set())
  /**
   * 弹框当前显示的是哪一份草稿，以及"这次是被递补上来的"这件事。
   *
   * `draftSwitchedFrom` 非空 = 上一份草稿被收起后，服务端递补了**另一种类型**的草稿上来。
   * 只在类型变化时提示：同类型的下一份（例如两条 task 草稿）不值得打断用户。
   *
   * 为什么需要它（2026-09-13 重复建单事故）：弹框长得一模一样，用户点「暂存」收起
   * 验收申请之后，递补上来的是一份 task 草稿 —— 用户接着点主按钮，确认的已经不是
   * 他以为的那一份，于是库里多出一条同名任务。
   */
  const bannerDraftRef = useRef<DraftView | null>(null)
  const [draftSwitchedFrom, setDraftSwitchedFrom] = useState<{ kindCode: string; draftId: string } | null>(null)
  /**
   * 服务端当前**全部** pending 草稿（含"看过就收起"的）。
   * 「待处理」计数用它，绝不用本地过滤后的 `pendingDraft` —— 否则点一次关闭
   * 计数就掉 0，而草稿其实还在等用户处理（2026-09-15 用户实测的 BUG）。
   */
  const [allPendingDrafts, setAllPendingDrafts] = useState<DraftView[]>([])
  const [pendingOpen, setPendingOpen] = useState(false)
  /**
   * 「库里已有同名任务」的待决提示（2026-09-13 重复建单事故的界面侧收口）。
   *
   * 服务端**只告警、不静默合并**（同名任务可能是正当需求，例如每周例会），
   * 所以这里给用户两件明确的事：保留两条，或者把这条草稿收口到已有那条上（不再新建）。
   */
  const [duplicatePrompt, setDuplicatePrompt] = useState<DraftDuplicatePrompt | null>(null)

  /** 收起一条草稿横幅：记屏蔽，并**记下它当时是不是暂存态**（供"暂存→唤回"识别）。 */
  const dismissDraft = (draft: DraftView): void => {
    dismissedDraftIdsRef.current.add(draft.id)
    if (draft.deferredAt !== null) deferredWhenDismissedRef.current.add(draft.id)
    else deferredWhenDismissedRef.current.delete(draft.id)
  }
  /** 从「待处理」里重新打开某份草稿的弹框（撤销"看过就收起"的本地屏蔽）。 */
  const resumePendingDraft = async (draft: DraftView): Promise<void> => {
    dismissedDraftIdsRef.current.delete(draft.id)
    deferredWhenDismissedRef.current.delete(draft.id)
    setPendingOpen(false)
    setPendingDraft(draft)
  }
  /**
   * 唤回一份暂存草稿：清掉暂存标记，它会立刻重新弹出待确认弹窗。
   *
   * ⚠️ **必须同时撤销本地屏蔽**（2026-09-15 用户实测 BUG：唤回后弹框只闪一下就永久消失）。
   *
   * 原因：点「暂存」时我们会把 draft id 记进 `dismissedDraftIdsRef`（"看过就别再自动弹"）。
   * 唤回时若不清掉这条记录，下一轮 5 秒轮询仍会把它过滤掉 —— 于是
   * `setPendingDraft` 造成"短暂出现"，随后被轮询覆盖成"永不出现"，
   * 而服务端明明是 pending（用户会以为草稿丢了）。旁边的「已唤回」toast 只是同时发生。
   */
  const resumeDeferredDraft = async (draftId: string): Promise<void> => {
    try {
      await api(`/api/workbench/drafts/${draftId}/resume`, { method: 'POST' })
      setPendingOpen(false)
      // 用户主动唤回 = 明确要处理它，撤销所有本地屏蔽。
      dismissedDraftIdsRef.current.delete(draftId)
      deferredWhenDismissedRef.current.delete(draftId)
      const res = await api<{ draft: DraftView | null; deferredDrafts?: DraftView[] }>('/api/workbench/drafts')
      setPendingDraft(res.draft)
      setDeferredDrafts(res.deferredDrafts ?? [])
      if (res.draft !== null) setAllPendingDrafts([res.draft, ...(res.deferredDrafts ?? [])])
      setNotice('已唤回，待你决定')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  /**
   * 确认接口的业务回执处理（2026-09-13 重复建单事故的界面侧收口）。
   *
   * 三种回执（都来自服务端的结构化字段，不是文案匹配）：
   *
   * 1. `duplicateOf` —— 库里**另有一条**同名任务。服务端只告警不合并（同名可能是正当需求，
   *    例如每周例会），这里弹一个小选择框：保留两条，或者收口到已有那条上。
   * 2. `replayed` —— 这条草稿此前已经确认过，本次**没有新建任何东西**。
   *    必须说出来：否则用户会以为又建了一条（这正是事故的心理来源）。
   * 3. `reused` —— 用户选了"就用已有那条"，同样没有新建。
   */
  const handleDraftConfirmed = (outcome: DraftConfirmOutcome, draft: DraftView): void => {
    if (outcome.duplicateOf !== undefined) {
      setDuplicatePrompt({
        draftId: draft.id,
        existingTaskId: outcome.duplicateOf.id,
        existingTitle: outcome.duplicateOf.title,
        sameDescription: outcome.duplicateOf.sameDescription,
        sameWorkspace: outcome.duplicateOf.sameWorkspace,
        newTaskId: outcome.taskId ?? '',
      })
      return
    }
    if (outcome.replayed === true) {
      setNotice('这条草稿此前已经确认过了，本次没有重复建单（库里仍是原来那一条）。')
      return
    }
    if (outcome.reused === true) {
      setNotice('已按你选的「就用已有那条」收口，没有新建任务。')
    }
  }
  /**
   * 「就用已有那条」：把这条草稿收口到已有任务上，并清掉本次多建出来的那条。
   *
   * 两步都必须做才算数：
   * 1. 带 `intent=dedupe` 重新确认 → 服务端不新建、草稿收口；
   * 2. 归档本次已经多建出来的那条 —— 否则"没有重复建单"只是句空话。
   *
   * 第 2 步失败不回滚第 1 步（草稿状态已经是对的），但**必须把真实结果说出来**，
   * 不能让用户以为已经干净了。
   */
  const reuseExistingTask = async (prompt: DraftDuplicatePrompt): Promise<void> => {
    try {
      await api(`/api/workbench/drafts/${prompt.draftId}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent: 'dedupe' }),
      })
    } catch (e) {
      // 草稿已不是 pending（并发确认）时服务端会 400 —— 说明它已经收口了，不算失败。
      const message = e instanceof Error ? e.message : String(e)
      if (!/already (confirmed|abandoned)/i.test(message)) {
        setError(`收口失败：${message}`)
        return
      }
    }
    dismissedDraftIdsRef.current.add(prompt.draftId)
    setDuplicatePrompt(null)
    const created = prompt.newTaskId
    if (created !== '') {
      try {
        await api(`/api/workbench/tasks/${created}/archive`, { method: 'POST' })
        setNotice('已收口到已有任务，本次多建的那条已归档（可在列表页「查看归档」恢复）。')
      } catch (e) {
        setNotice(`已收口到已有任务；本次多建的那条自动归档失败（${e instanceof Error ? e.message : String(e)}），请在任务列表里手动归档。`)
      }
    } else {
      setNotice('已收口到已有任务，没有新建。')
    }
    void refresh()
  }
  const tickDrafts = useCallback(async (isAlive: () => boolean): Promise<void> => {
    const res = await api<{ draft: DraftView | null; deferredDrafts?: DraftView[] }>('/api/workbench/drafts')
    /**
     * 已"看过就收起"的草稿不再自动弹窗，但**照样计入「待处理」**：
     * `allPendingDrafts` 存服务端事实（用于计数与清单），
     * `pendingDraft` 才是"要不要弹"。两者分开，计数才不会被本地操作污染。
     */
    const dismissed = dismissedDraftIdsRef.current
    const serverDrafts = [res.draft, ...(res.deferredDrafts ?? [])].filter((d): d is DraftView => d !== null && d !== undefined)
    /**
     * 兜底（v1.14.23）：**屏蔽时它是"已暂存"，现在服务端说它"待确认"→ 解除屏蔽。**
     *
     * 这条只针对"暂存 → 唤回"这一种状态转换：用户（或别的会话）明确把一份
     * 被暂存的草稿叫回来了，就该弹。
     *
     * ⚠️ 不能用"只要 deferredAt 为空就解除"来判断 —— 用户点 X 收起弹框时，
     * 草稿本来就不是暂存状态，那样会在下一轮轮询把屏蔽清掉，**弹框 5 秒后又冒出来**
     * （这正是最早修过的 BUG）。所以必须记住"屏蔽它的时候，它是否处于暂存态"。
     */
    if (res.draft !== null && res.draft.deferredAt === null
      && deferredWhenDismissedRef.current.has(res.draft.id) && dismissed.has(res.draft.id)) {
      dismissed.delete(res.draft.id)
      deferredWhenDismissedRef.current.delete(res.draft.id)
    }
    const nextDraft = res.draft !== null && dismissed.has(res.draft.id) ? null : res.draft
    if (isAlive()) {
      /**
       * ⚠️ **弹框被"静默换人"时必须说出来**（2026-09-13 重复建单事故的界面侧防线）。
       *
       * 事故形态：用户暂存了最新那份草稿（例如验收申请），服务端按"最新活动草稿"
       * 递补下一份 —— 而递补上来的可能是**另一种类型**的草稿（例如一份任务草稿）。
       * 弹框长得一模一样，用户接着点主按钮时，确认的已经不是他以为的那一份了。
       *
       * 实测证据（`node scripts/repro/repro-banner.mjs`）：暂存验收草稿之后，
       * 弹框内容确实会从 `completion` 换成 `task`。
       *
       * 这里不改变递补行为（`getLatestActiveDraft` 的语义没动），只保证
       * **换人这件事一定可见**：类型/来源不同时，弹框里挂一条醒目提示。
       */
      const previous = bannerDraftRef.current
      if (previous !== null && nextDraft !== null && previous.id !== nextDraft.id && previous.kindCode !== nextDraft.kindCode) {
        setDraftSwitchedFrom({ kindCode: previous.kindCode, draftId: previous.id })
      } else if (nextDraft !== null && (previous === null || previous.id !== nextDraft.id)) {
        setDraftSwitchedFrom(null)
      }
      bannerDraftRef.current = nextDraft
      setPendingDraft(nextDraft)
      setAllPendingDrafts(serverDrafts)
      setDeferredDrafts(res.deferredDrafts ?? [])
    }
  }, [])

  return {
    pendingDraft,
    deferredDrafts,
    draftProblems,
    draftSwitchedFrom,
    allPendingDrafts,
    pendingOpen,
    duplicatePrompt,
    actions: {
      setPendingDraft,
      setDraftProblems,
      setDuplicatePrompt,
      setPendingOpen,
      dismissDraft,
      resumePendingDraft,
      resumeDeferredDraft,
      handleDraftConfirmed,
      reuseExistingTask,
      tickDrafts,
    },
  }
}
