/**
 * AI 模型选择器（原 `QuickModelPicker`，2026-10-01 抽成独立组件）。
 *
 * ## 为什么抽出来
 *
 * 用户反馈："除了快速录入外，其他调用 AI 的弹框中依旧无法选择 AI 模型。"
 * 它原来定义在 `index.tsx` 里、**只渲染在快速录入弹窗**一处。抽成组件之后：
 * 快速录入与共享提示词弹窗**挂同一个组件**，选择值经 `askUserPrompt()` 的返回值
 * 一路传到 `startAISession` —— 9 个走共享弹窗的 mode 因此也能选模型。
 *
 * ## 逻辑一行没改
 *
 * 组件体与它依赖的模块级辅助（模型目录解析、可读原因、localStorage 读写）
 * **按标记原样搬过来**，行为与搬迁前逐字一致。原文里那些"为什么这么写"的注释一并保留 ——
 * 它们记录的是真事故（浮层被滚动容器裁掉、可用性判定依赖自己要控制的状态）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { ModelDirectoryRuntime, ModelProviderGroup, WorkbenchRuntime } from '../viewTypes.js'
import type { ModelModalityRecord } from '../modelCapability.js'
import type { QuickImageDraft } from '../quickAttachments.js'
import { currentSessionIdOf, getPluginCtx, optionalService, safeService } from '../runtimeServices.js'
import {
  CLEAR_SELECTION_LABEL, clearQuickModelSelection, gateModelPicker, indexModalities, modelDirectoryUnavailableReason,
  modelMenuMode, resolveModelDirectoryOutcome, selectionToApply,
  type ModelDirectoryOutcome, type SelectionApplication,
} from '../modelCapability.js'
import { placePopover, samePlacement, stepIndex, type PopoverPlacement } from '../popoverPlacement.js'
import { api } from '../api.js'
import { Icon } from './Icon.js'
import type { ModelDirectoryState, PromptContentPart, QuickModelSelection } from '../viewTypes.js'

/** 快速录入模型选择的 localStorage 键（本仓自己的前缀，不与 fork 混用）。 */
const QUICK_MODEL_STORAGE_KEY = 'dsh-personal-workbench.quickModelSelection'

/**
 * 模型浮层的期望宽度 —— 与 `.wb-model-menu` 的 CSS 保持一致。
 *
 * 为什么是常量而不是量出来的：浮层宽度由我们定、内容自适应；拿 `offsetWidth` 当输入
 * 会读到"上一次摆放写进去的宽度"，那是把**投影当权威源**（本项目第 1 条规矩禁止）。
 * 视口比它还窄时由 `placePopover()` 收窄。
 */
const MODEL_MENU_WIDTH = 320

/** 浮层高度兜底（`placePopover()` 还没量出来时用），与 CSS 里的 `max-height` 同值。 */
const MODEL_MENU_FALLBACK_HEIGHT = 360

/** 目录还没加载出来时的空快照（`useSyncExternalStore` 的服务端/初始值）。 */
const EMPTY_MODEL_DIRECTORY_STATE: ModelDirectoryState = { current: null, groups: [], failures: [], status: 'idle', error: null }


/**
 * 取某个会话的模型目录 —— **判定全部委托给纯函数** `resolveModelDirectoryOutcome`。
 *
 * ⚠️ `modelDirectories` 走 **`ctx.get` 软探测**（见 `viewTypes.ts` 里那段决策说明），
 * 绝不写进 `inject`：它是另一个客户端插件提供的可选增强，缺了只是少一个下拉框，
 * 写进 `inject` 会让那种机器上**整个工作台面板 pending**。
 *
 * ⚠️ **不许退回 `try { … } catch { return undefined }`**（2026-09-28 死锁事故）：
 * 那样会把"服务不在场"与"这个会话取不到目录（宿主 `directoryFor` 抛 no binding）"
 * 压成同一个 `undefined`，于是界面上把后者说成"当前 DSH 未提供模型选择接口" ——
 * 而本机该 provider 明明是装着的，报错文案把排查方向整个带偏。
 * 本函数只做"读服务"这一件事，分类与措辞都在纯模块里，并由测试钉住。
 */
export function resolveModelDirectoryOutcomeFor(runtime: WorkbenchRuntime, sessionId: string): ModelDirectoryOutcome {
  return resolveModelDirectoryOutcome(
    () => optionalService<{ directoryFor?: (id: string) => ModelDirectoryRuntime }>(getPluginCtx(), 'modelDirectories')
      ?? (() => { try { return runtime.modelDirectories } catch { return undefined } })(),
    sessionId,
  )
}

/**
 * 目录拿不到时的可读原因 **+ 控制台留痕**（"失败必须可观测"，本项目规范第 4 条）。
 *
 * 为什么两处（界面 + 控制台）都要：用户截图看不到 console，而排查时
 * `[workbench] …` 这一行能直接定位到是服务缺失还是会话没 retain。
 */
export function reportModelDirectoryUnavailable(outcome: ModelDirectoryOutcome): string {
  const reason = modelDirectoryUnavailableReason(outcome)
  if (outcome.ok === false) console.warn(`[workbench] 模型目录不可用（${outcome.code}）：${outcome.detail}`)
  return reason
}

/**
 * 快速录入 / 共享提示词弹窗共用的模型选择器（v1.15.1；v1.15.2 修「浮层被遮挡」）。
 *
 * ## 设计要点
 *
 * 1. **列表与选中来自同一个 authority**：列表读 `modelDirectories.directoryFor(会话)` 的
 *    快照，选中也走**同一个** directory 的 `select()`；
 * 2. 选中值存 localStorage 时带 **reasoning effort**（取 `model.reasoning.defaultEffort`）；
 * 3. 目录里**没有** `inputModalities`，所以"这个模型收不收图"由 `modalityTable`
 *    （宿主 `/model-modalities`）标注出来 —— 用户的痛点正是"选到不收图的模型，图片白传"；
 * 4. **浮层 portal 到 `document.body` + `fixed` + `placePopover()` 摆放**（v1.15.2）：
 *    原来那份是 `position: absolute; bottom: calc(100% + 4px)`，挂在触发按钮的
 *    `position: relative` 包装盒里，而包装盒在 `.wb-dialog-body { overflow: auto }`
 *    **里面** —— 于是浮层只会朝上开、不看还有多少可用空间，多出来的部分被滚动容器裁掉
 *    （2026-09-15 用户截图；实测常见窗口下只有 48% 可见，
 *    「跟随 DSH 默认模型」与前几个模型正好在被裁掉的那一段，窗口小一点时甚至画到视口外）。
 *    z-index/层叠上下文**不是**成因，光调 `bottom`/`max-height` 也治不了根：
 *    只要还挂在滚动容器里，容器就会继续裁它、滚动时浮层还会跟内容错位。
 *    事故说明与判定表见 `popoverPlacement.ts` 顶部，回归见 `test/popoverPlacement.test.mjs`。
 *
 * ⚠️ 目录服务缺失时**不静默降级**：按钮照常显示，点击给出可读原因
 * （"当前 DSH 未提供模型选择接口"），而不是变成一个点了没反应的控件。
 */
export function ModelPicker({ runtime, value, onChange, modalityTable, disabled, onError, onLoaded }: {
  runtime: WorkbenchRuntime
  value: QuickModelSelection | null
  onChange: (selection: QuickModelSelection | null) => void
  modalityTable: ReadonlyMap<string, readonly string[] | null>
  disabled?: boolean
  onError: (message: string) => void
  onLoaded: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  /**
   * 浮层摆放结果。`null` = 还没量到（首帧先 `visibility: hidden` 渲染，量完再显示，
   * 免得先画在视口左上角再跳过去）。
   */
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  /** 用方向键打开时，等选项挂上 DOM 之后要把焦点交给第一项 / 最后一项。 */
  const pendingFocusRef = useRef<'first' | 'last' | null>(null)
  const sessionsState = safeService<WorkbenchRuntime['sessions']>(runtime, 'sessions')?.list?.getSnapshot?.()
  /**
   * 「当前会话」按唯一入口读（`currentSession.ts`）—— 0.1.7-rc.2 起列表快照里没有 `current`。
   * 读不到时才退到 `ids[0]`：那只是"模型目录得有个会话可问"的兜底，
   * 绝不能拿它去推断工作区（那是猜，会把文件建进别人的项目目录）。
   */
  const currentSessionId = currentSessionIdOf(runtime)
  const directorySessionId = currentSessionId !== '' ? currentSessionId : (sessionsState?.ids?.[0] ?? '')
  /**
   * 这次解析的结果（拿到目录 / 为什么没拿到）—— 门禁、菜单、提示**共用这一份**。
   *
   * ⚠️ **必须只有一处判定**：如果门禁自己再判一遍，就会出现"说的是 A、拦的是 B"
   * （本项目最大的 bug 类别：同一个语义被独立计算多次）。
   *
   * ⚠️ 关于 `useMemo([runtime, directorySessionId])`：这条依赖里**没有**服务的就绪状态，
   * 所以如果宿主的 `modelDirectories` 注册晚于本组件首次渲染，这里会一直缓存住那次失败
   * （2026-09-28 提出的第 ② 条假设：**时机问题**）。
   * 无法确认时机，就不敢只靠依赖变化 —— 所以这里补一条**显式重试入口**
   * （`recomputeDirectory`，挂在用户点击上）：会话/服务就绪后点一下即可重新解析，
   * 失败也不再是永久性的。原来的"不可用就永久不可用"因此消失。
   */
  const [directoryOutcome, setDirectoryOutcome] = useState<ModelDirectoryOutcome>(
    () => resolveModelDirectoryOutcomeFor(runtime, directorySessionId),
  )
  const recomputeDirectory = useCallback((): ModelDirectoryOutcome => {
    const next = resolveModelDirectoryOutcomeFor(runtime, directorySessionId)
    setDirectoryOutcome(next)
    return next
  }, [runtime, directorySessionId])
  useEffect(() => {
    // 会话换人（或面板重挂）时重新解析一次 —— 依赖变化就是"该重算了"的信号。
    setDirectoryOutcome(resolveModelDirectoryOutcomeFor(runtime, directorySessionId))
  }, [runtime, directorySessionId])
  const directory = directoryOutcome.ok ? directoryOutcome.directory : undefined
  /**
   * 目录拿不到时的可读**成因**（唯一来源：`modelDirectoryUnavailableReason`）。
   * 门禁、菜单、提交路径都读它，禁止任何一处自己再拼一句（2026-09-28 审查 F1）。
   */
  const unavailableReason = directoryOutcome.ok
    ? ''
    : reportModelDirectoryUnavailable(directoryOutcome)
  /**
   * ⚠️ **不许用 `open ? resolveModelDirectory(...) : undefined` 做惰性解析**（v1.15.2 修的真 bug）。
   *
   * `openPicker()` 用 `directory === undefined` 判定"宿主没提供这个服务"，
   * 而它**同时**负责把 `open` 置真 —— 于是第一次点击时 `open` 还是 `false`、
   * `directory` 必然是 `undefined`，**必然**走进"未提供模型选择接口"分支：
   * 一个自我实现的假失败，宿主有没有这个服务都一样。
   *
   * 教训（写进规矩）：**可用性判定不许依赖它自己要控制的状态**。
   * 这里也**不需要**惰性：`directoryFor()` 只是宿主内部 Map 的一次查询，
   * 且本组件只存在于「快速录入」弹窗里（弹窗关闭时根本不渲染）。
   */
  /**
   * 菜单要列什么：整份目录，还是"只留一个清空出口"。
   *
   * 有残留选择时**菜单必须开得起来**（`clear-only`）——
   * 事故里用户就是被"菜单打不开"锁死的：唯一的写入口只在菜单里。
   *
   * ⚠️ 这也是"清空出口可达性"的**唯一判据**：门禁不再自己看 `hasSelection`，
   * 而是接收这里算好的 `recoverable`（2026-09-28 审查 F2：同一语义不许两处实现）。
   */
  const menuDecision = modelMenuMode({
    directory,
    hasSelection: value !== null,
    unavailableReason,
  })
  const subscribe = useCallback(
    (listener: () => void) => (directory === undefined ? () => undefined : directory.store.subscribe(listener)),
    [directory],
  )
  const getSnapshot = useCallback(
    () => (directory === undefined ? EMPTY_MODEL_DIRECTORY_STATE : directory.store.getSnapshot()),
    [directory],
  )
  const state = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_MODEL_DIRECTORY_STATE)
  const selectedLabel = useMemo(() => {
    if (value === null) return CLEAR_SELECTION_LABEL
    for (const group of state.groups) {
      if (group.id !== value.provider) continue
      const model = group.models.find((item) => item.id === value.model)
      if (model !== undefined) {
        const effort = model.reasoning?.efforts.find((item) => item.id === value.reasoningEffort)
        return effort === undefined ? model.name : `${model.name} · ${effort.name}`
      }
    }
    return value.effortLabel === undefined ? value.label : `${value.label} · ${value.effortLabel}`
  }, [state.groups, value])
  /**
   * 关掉浮层，并把焦点还给触发按钮。
   *
   * 验收标准里的「关闭后焦点归还到触发元素」就落在这一处 ——
   * 选完一项、点浮层外面、按 Esc、按 Tab 都走它（键盘用户不会迷失位置）。
   */
  const closePicker = useCallback((refocus = true): void => {
    setOpen(false)
    setPlacement(null)
    if (refocus) triggerRef.current?.focus()
  }, [])

  const openPicker = (): void => {
    /**
     * 每次点击**重新解析一次**目录：宿主服务/会话可能是在本组件挂载之后才就绪的，
     * 而 `directoryOutcome` 的依赖里没有"服务已注册"这件事（见上面的注释）。
     * 重新解析是幂等的（`directoryFor()` 只是宿主内部 Map 的一次查询），
     * 于是"点一下就能恢复"取代了原来的"一次失败即永久不可用"。
     */
    const outcome = recomputeDirectory()
    /**
     * 门禁的成因与出口可达性都**从上面算好的那一份**读，绝不在这里再判一次：
     * 旧写法（`gateModelPicker({ hasDirectory })`）只能拿一句写死的"未提供接口"，
     * 于是"服务在场、只是这个会话取不到目录"被说成"接口没提供"（审查 F1）。
     *
     * ⚠️ 用**本次刚解析的** `outcome` 而不是渲染期那份 state：点击的那一刻状态可能还没落地。
     * 纯运算、无副作用（重算出的字符串与 `unavailableReason` 同源同值），幂等。
     */
    const reason = outcome.ok ? '' : modelDirectoryUnavailableReason(outcome)
    const gate = gateModelPicker({
      hasDirectory: outcome.ok,
      sessionId: directorySessionId,
      unavailableReason: reason,
      recoverable: modelMenuMode({
        directory: outcome.ok ? outcome.directory : undefined,
        hasSelection: value !== null,
        unavailableReason: reason,
      }).mode === 'clear-only',
    })
    if (!gate.ok) {
      const message = `${gate.reason}；本次会话将跟随 DSH 默认模型。`
      // 控制台也留一条（用户截图看不到 console，但排查时这一步能直接定位）
      console.warn(`[workbench] 模型选择器不可用：${message}`)
      onError(message)
      // 方向键路径会先记下"打开后焦点给谁"；这里没打开，就得把意图清掉，
      // 否则下一次（比如鼠标）打开时焦点会莫名跳到第一项
      pendingFocusRef.current = null
      return
    }
    /**
     * ⚠️ **拿不到目录但有残留选择**时：不是关掉控件，而是开一份"只给清空出口"的菜单。
     *
     * 事故形态：唯一的写入口在菜单里，而菜单被门禁挡死 ⇒ 用户被永久锁在
     * 那条改不掉的 localStorage 选择上（只能手改浏览器存储）。
     * 出口必须**不依赖任何模型目录**：清空只是 `onChange(null)` + `removeItem`。
     *
     * 注意这里**不往 state 里塞原因** —— 菜单里显示的原因是渲染期由
     * `modelMenuMode()` 算出来的 `menuDecision.reason`，那才是有读者的那一份。
     * （2026-09-28 审查 F2：曾经多存了一个只写不读的 state，现在删掉了。）
     */
    if (outcome.ok === false) {
      pendingFocusRef.current = null
      setOpen(true)
      return
    }
    setOpen(true)
    setLoading(true)
    void outcome.directory.load()
      .then(() => { onLoaded() })
      .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }

  /** 触发按钮是**开关**：开着再点是关（关闭路径统一走 closePicker，焦点才会还回去）。 */
  const togglePicker = (): void => {
    if (open) { closePicker(); return }
    openPicker()
  }

  /** 方向键在选项间移动焦点（选项本身就是 button，Enter/Space 原生可用）。 */
  const focusOption = useCallback((delta: number): void => {
    const menu = menuRef.current
    if (menu === null) return
    const options = Array.from(menu.querySelectorAll<HTMLElement>('[role="option"]'))
    const target = options[stepIndex(options.indexOf(document.activeElement as HTMLElement), delta, options.length)]
    target?.focus()
  }, [])

  /**
   * 摆放浮层：portal 到 body 之后，位置只能**量**（触发按钮 vs 视口），
   * 所以放在 layout effect 里，并在滚动 / 改尺寸时重算。
   *
   * ⚠️ `scroll` 事件不冒泡，但**捕获阶段**会经过 window —— 必须传 `true` 才收得到
   * `.wb-dialog-body` 的滚动。这一条正对应验收标准里的「弹窗滚动时不遮挡」：
   * 弹窗内部一滚，触发按钮就动了，浮层必须跟着走，不能停在原地。
   * ⚠️ `setPlacement` 里做相等判断：否则"量 → 写状态 → 再渲染 → 再量"会自激
   * （本项目第 6 条规矩：写入相同值也会让回路不收敛）。
   */
  useLayoutEffect(() => {
    if (!open) return
    const update = (): void => {
      const trigger = triggerRef.current
      const menu = menuRef.current
      if (trigger === null || menu === null) return
      const anchor = trigger.getBoundingClientRect()
      /**
       * 自然高度 = `scrollHeight`（内容 + padding）**加回边框**：
       * `placePopover()` 返回的 `max-height` 是"整块菜单的高度"，
       * 而 `.wb-model-menu` 是 `box-sizing: border-box` —— 漏掉这 2px 边框
       * 就会让菜单比可用空间高出 2px，在矮窗口里正好表现为"又被裁了一点"。
       */
      const border = window.getComputedStyle(menu)
      const borderY = (Number.parseFloat(border.borderTopWidth) || 0) + (Number.parseFloat(border.borderBottomWidth) || 0)
      const next = placePopover({
        anchor: { top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right },
        menu: { width: MODEL_MENU_WIDTH, height: menu.scrollHeight + borderY },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
      setPlacement((previous) => (previous !== null && samePlacement(previous, next) ? previous : next))
    }
    update()
    /**
     * 菜单内容会**自己长高**（目录是异步 `load()` 的：先渲染"正在读取模型列表…"，
     * 模型表到了以后可能多出若干行 + "不支持图片输入"标注）。只在打开那一帧量一次，
     * 浮层就会停在旧高度上（表现为"多出滚动条、最后几项被裁"）—— 这里补一个观察器，
     * 内容一变就重算。
     *
     * ⚠️ 之所以敢观察"自己即将改尺寸的元素"：`update()` 里做了相等判断，
     * 尺寸没实质变化就不写状态，所以"改尺寸 → 观察器回调 → 再改尺寸"不会自激。
     */
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (observer !== null && menuRef.current !== null) observer.observe(menuRef.current)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open, focusOption])

  /**
   * 落实"用方向键打开浮层时，把焦点交给第一项 / 最后一项"。
   *
   * ⚠️ 必须等 `placement` 生效之后再点，**不能**顺手写在"量并写 placement"的那一次里：
   * 首帧菜单是 `visibility: hidden`（免得先画在视口左上角再跳过去），而**隐藏元素不可聚焦** ——
   * `.focus()` 既不报错也不生效，于是"按 ↓ 打开后焦点在第一项"变成静默失效
   * （用户得再按一次 ↓）。这一条由 `test/quickIntakeClient.test.mjs` 的源码扫描守着。
   */
  useEffect(() => {
    if (!open || placement === null) return
    const pending = pendingFocusRef.current
    if (pending === null) return
    pendingFocusRef.current = null
    focusOption(pending === 'first' ? 1 : -1)
  }, [open, placement, focusOption])

  /**
   * Esc **只关浮层**，不关整个「快速录入」弹窗。
   *
   * 为什么挂在 `window` 的**捕获**阶段：`Modal` 也监听 Esc（挂在 `document` 捕获上），
   * 同一目标、同一阶段按**注册顺序**执行 —— 后注册的我们永远抢不到，于是按 Esc
   * 会把整个弹窗连同已输入的内容一起关掉。window 在捕获路径上早于 document，
   * 在这里 `stopPropagation()` 就能把这次 Esc 收在自己手里。
   */
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      closePicker()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, closePicker])

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!open) {
      // 选项要等这一帧渲染完才存在，所以只记意图，由上面的 layout effect 落实焦点
      pendingFocusRef.current = event.key === 'ArrowDown' ? 'first' : 'last'
      openPicker()
      return
    }
    focusOption(event.key === 'ArrowDown' ? 1 : -1)
  }

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault(); focusOption(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault(); focusOption(-1)
    } else if (event.key === 'Tab') {
      // Tab 不该被困在浮层里：先把焦点还给触发按钮，再让浏览器从它继续往后走
      closePicker()
    }
  }
  const choose = (group: ModelProviderGroup, model: ModelProviderGroup['models'][number]): void => {
    const effortId = model.reasoning?.defaultEffort
    const effort = model.reasoning?.efforts.find((item) => item.id === effortId)
    onChange({
      provider: group.id,
      model: model.id,
      label: model.name,
      ...(effortId === undefined || effortId === '' ? {} : { reasoningEffort: effortId }),
      ...(effort === undefined ? {} : { effortLabel: effort.name }),
    })
    closePicker()
  }
  /** 该模型是否收图（`undefined` = 对照表里没有，不做判断）。 */
  const imageSupport = (provider: string, model: string): boolean | undefined => {
    const key = `${provider}/${model}`
    if (!modalityTable.has(key)) return undefined
    const modalities = modalityTable.get(key) ?? null
    return modalities === null ? undefined : modalities.includes('image')
  }
  return (
    <div style={{ display: 'flex' }}>
      <button
        ref={triggerRef}
        type="button"
        className="wb-btn wb-model-picker"
        disabled={disabled === true}
        onClick={togglePicker}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="选择本次 AI 会话使用的模型（快速录入与共享提示词弹窗共用同一份选择）"
      >
        <Icon name="model" />{selectedLabel}<span style={{ flex: 'none' }}>{open ? '▲' : '▼'}</span>
      </button>
      {/*
        浮层 **portal 到 document.body**（不是就地渲染）：
        `.wb-dialog` 有 `overflow: hidden`、`.wb-dialog-body` 有 `overflow: auto`、
        `.wb-overlay` 有 `backdrop-filter`（会变成 fixed 后代的包含块）——
        留在原地就一定被裁。它与触发按钮的祖先关系因此断开了，
        所以"跟着按钮走"必须靠 `placePopover()` 在滚动/改尺寸时重算。
      */}
      {open && createPortal(
        <>
          <div className="wb-model-scrim" onClick={() => closePicker()} />
          <div
            ref={menuRef}
            className="wb-model-menu"
            role="listbox"
            aria-label="选择模型"
            style={{
              left: placement === null ? 0 : placement.left,
              top: placement === null ? 0 : placement.top,
              width: placement === null ? MODEL_MENU_WIDTH : placement.width,
              maxHeight: placement === null ? MODEL_MENU_FALLBACK_HEIGHT : placement.maxHeight,
              // 还没量出来就别给人看见（否则会先闪一下左上角）
              visibility: placement === null ? 'hidden' : 'visible',
            }}
            onKeyDown={onMenuKeyDown}
          >
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              className={`wb-model-option${value === null ? ' selected' : ''}`}
              onClick={() => { onChange(clearQuickModelSelection(value)); closePicker() }}
            >
              <span className="wb-model-option-main">{CLEAR_SELECTION_LABEL}</span>
              {value === null && <Icon name="check" size={14} />}
            </button>
            {/*
              降级态（拿不到目录但有残留选择）：只给上面这一个出口 + 一条可读原因。
              不渲染模型行 —— 没有目录就没有可信的模型列表，绝不摆一份假的给人点。
              原因行就摆在出口**下面**，用户点进来第一眼就能看到为什么。
            */}
            {menuDecision.mode === 'clear-only' && (
              <div className="wb-model-menu-error">{menuDecision.reason}</div>
            )}
            {menuDecision.mode === 'full' && (loading || state.status === 'loading') && <div className="wb-model-menu-empty">正在读取模型列表…</div>}
            {menuDecision.mode === 'full' && state.error !== null && <div className="wb-model-menu-error">{state.error}</div>}
            {menuDecision.mode === 'full' && state.groups.map((group) => (
              <div key={group.id}>
                <div className="wb-model-group-title">{group.name}</div>
                {group.models.map((model) => {
                  const isSelected = value?.provider === group.id && value.model === model.id
                  const effort = model.reasoning?.efforts.find((item) => item.id === model.reasoning?.defaultEffort)
                  const supportsImage = imageSupport(group.id, model.id)
                  return (
                    <button key={model.id} type="button" role="option" aria-selected={isSelected} className={`wb-model-option${isSelected ? ' selected' : ''}`} onClick={() => choose(group, model)}>
                      <span className="wb-model-option-main">
                        <span className="wb-model-option-name">{model.name}</span>
                        {(effort !== undefined || supportsImage === false) && (
                          <span className={`wb-model-option-note${supportsImage === false ? ' warn' : ''}`}>
                            {effort === undefined ? '' : effort.name}
                            {supportsImage === false ? `${effort === undefined ? '' : ' · '}不支持图片输入` : ''}
                          </span>
                        )}
                      </span>
                      {isSelected && <Icon name="check" size={14} />}
                    </button>
                  )
                })}
              </div>
            ))}
            {menuDecision.mode === 'full' && state.groups.length === 0 && !loading && state.status !== 'loading' && state.error === null && (
              <div className="wb-model-menu-empty">暂无可用模型</div>
            )}
            {menuDecision.mode === 'full' && state.failures.length > 0 && (
              <div className="wb-model-menu-empty">{state.failures.length} 个模型来源读取失败（其余仍可选）</div>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}




/** 读回上次选的模型（脏值一律当"没选过"，不让一个坏字符串把快速录入打挂）。 */
export function readQuickModelSelection(): QuickModelSelection | null {
  try {
    const raw = localStorage.getItem(QUICK_MODEL_STORAGE_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw) as Partial<QuickModelSelection>
    if (typeof value.provider !== 'string' || value.provider === '') return null
    if (typeof value.model !== 'string' || value.model === '') return null
    return {
      provider: value.provider,
      model: value.model,
      label: typeof value.label === 'string' && value.label !== '' ? value.label : `${value.provider}/${value.model}`,
      ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort !== '' ? { reasoningEffort: value.reasoningEffort } : {}),
      ...(typeof value.effortLabel === 'string' && value.effortLabel !== '' ? { effortLabel: value.effortLabel } : {}),
    }
  } catch { return null }
}

/** 写回选中的模型（`null` = 跟随 DSH 默认模型，此时**删掉**残留选择）。 */
export function writeQuickModelSelection(selection: QuickModelSelection | null): void {
  try {
    if (selection === null) localStorage.removeItem(QUICK_MODEL_STORAGE_KEY)
    else localStorage.setItem(QUICK_MODEL_STORAGE_KEY, JSON.stringify(selection))
  } catch { /* localStorage 不可用（隐私模式）时静默降级：选择只在本次会话内有效 */ }
}