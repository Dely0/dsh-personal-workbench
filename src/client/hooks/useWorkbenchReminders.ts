/**
 * D17 / P5-2：**提醒域（Reminders）的唯一所有者**。
 *
 * 拆分前这些散在 `src/client/index.tsx` 的 `WorkbenchApp` 里（state 在 L346 / L368 / L394-397 /
 * L410-413，去重集合与 effect 在 L563-574 / L578-604，动作在 L721-752 / L1440-1501，
 * 轮询里的提醒那半段在 L659-684）。本 hook 收口的是**待办提醒 + 桌面通知 + 微信提醒设置**这一域：
 *
 * - 7 项 state：`reminders` / `reminderModalOpen` / `notifyPerm` / `reminderPolicy` /
 *   `reminderChannel` / `reminderOptions` / `reminderBusy`。
 * - 2 个去重设施：`notifiedRef`（**原存储键 `dsh-workbench:desktop-notified` 不变**，
 *   超 500 条时只保留最后 250 条的规则也不变）+ `persistNotified`。
 * - 1 个普通常量：`notificationCtor`（`readNotificationCtor(globalThis)`，不是 state）。
 * - 8 个域动作：`ackReminder` / `resetReminderState` / `addTaskReminder` /
 *   `loadReminderChannel` / `saveReminderTarget` / `saveReminderPolicy` / `sendReminderTest`，
 *   外加轮询用的 `tickDue`。
 * - 2 条 effect：打开设置面板时拉一次策略与通道（`GET /api/workbench/reminders/{policy,channel}`）；
 *   有到期提醒时自动弹出提醒弹窗。
 *
 * ## 刻意**不**拥有的东西（跨域，按设计 §5 由装配层组合或注入）
 * - **任务数据域**：`ackReminder` 结束后要 `if (currentTaskId() !== null) await refresh()`，
 *   `addTaskReminder` 也要先 `currentTaskId()` —— 两个都走注入，本 hook 不 import `useTaskData`。
 * - **反馈**：本域的操作结果以 toast 呈现（原注释：`loadReminderChannel` / `saveReminderTarget` /
 *   `saveReminderPolicy` / `sendReminderTest` 四条都是 `pushToast`），所以 `setError` / `setNotice` /
 *   `pushToast` 三个写口全部注入。
 * - **设置域**：`showSettings`（决定要不要拉策略/通道）与 `settings.desktopNotify`（决定要不要发
 *   系统通知）都是设置域的读口，以注入形式进来；本 hook 不 import `useWorkbenchSettings`。
 * - **`useRemindersResult` 之外的通知授权与测试通知两个内联回调**：它们由 `SettingsModal` 的
 *   `onRequestNotifyPermission` / `onSendTestNotification` 传入，读的是 `readNotificationCtor`
 *   与 `pushToast`（入口持有），所以**留在装配层**；本 hook 只交出 `setNotifyPerm` 给它们回写。
 * - **轮询的时段与容器**：5 秒 tick / 15 秒 refresh 的那条 effect 属装配层（P5-3 的
 *   `useWorkbenchPolling` 会接手），本 hook 只交出"拉一次到期提醒并按需发系统通知"的 `tickDue`，
 *   **不在本 hook 里另起定时器**（设计 §7 P5 行的出口口径：无双轮询）。
 *
 * ## 为什么 `tickDue` 要接收 `isAlive`
 * 原实现在 `await api('/api/workbench/reminders/due')` 之后有一句 `if (!alive) return`，
 * 目的正是挡住"组件已卸载才有响应回来"的那一次：此时既不该 `setReminders`，
 * **也不该发系统通知 / 写 localStorage 去重集合**。`alive` 是装配层 effect 闭包里的局部量，
 * 所以把它以回调形式传进来，逐字保留这条守卫。
 *
 * ## 为什么注入回调要在这里改回原名
 * `const { …, onError: setError, onNotice: setNotice, onToast: pushToast } = input` —— 这样下面
 * 从入口搬过来的函数体**逐字未改**，既有判据/探针里那些以源码文本为锚的断言不用重锚
 * （P4 起沿用的「只换来源、不改调用点文本」纪律）。
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api } from '../api.js'
import { fmtTime } from '../format.js'
import {
  classifyNotificationPermission, readNotificationCtor, sendSystemNotification,
  type NotificationState,
} from '../notificationCapability.js'
import type { ToastTone } from '../components/Toast.js'
import type {
  ReminderChannelStatus as ReminderChannelView,
  ReminderOptionsView,
  ReminderPolicyView,
} from '../../shared/contracts.js'

export interface UseWorkbenchRemindersInput {
  /** 任务数据域：`ackReminder` / `addTaskReminder` 都要知道"当前打开的是哪个任务"。 */
  currentTaskId: () => string | null
  /** 任务数据域：提醒状态变化后要重新拉 bootstrap 才算生效。 */
  refresh: () => Promise<void>
  /** 设置域：打开设置面板时才拉微信提醒策略与通道。 */
  showSettings: boolean
  /** 设置域：启用桌面提醒且浏览器已授权时，对每条到期提醒发一次系统通知。 */
  desktopNotify: boolean
  onError: (message: string | null) => void
  onNotice: (message: string | null) => void
  /** 反馈域的 toast 推送口：四条微信提醒动作的结果都以 toast 呈现。 */
  onToast: (message: string, tone?: ToastTone) => void
}

export interface UseWorkbenchRemindersActions {
  /**
   * 语义化 setter：装配层直接透给 `SettingsModal` / 提醒弹窗。
   * **四个都必须是原生 `Dispatch`**：入口的 `onSelectTarget` 用**函数式更新**写
   * `reminderChannel`（`(prev) => prev === null ? prev : { ...prev, botId, targetId }`），
   * 只接受值的签名编译不过。
   */
  setReminderModalOpen: Dispatch<SetStateAction<boolean>>
  setNotifyPerm: Dispatch<SetStateAction<NotificationState>>
  setReminderPolicy: Dispatch<SetStateAction<ReminderPolicyView | null>>
  setReminderChannel: Dispatch<SetStateAction<ReminderChannelView | null>>
  /** 用户点「知道了」：写 acknowledged_at（终态），并把这条从待处理列表移除。 */
  ackReminder: (reminderId: string) => Promise<void>
  /** 重新武装：清掉 fired/skipped/acknowledged，提醒回到「未处理」。 */
  resetReminderState: (reminderId: string) => Promise<void>
  /** 给当前任务加一条提醒（入口的 `TaskDetailPane` 用它）。 */
  addTaskReminder: (offsetMinutes: number) => Promise<void>
  loadReminderChannel: () => Promise<void>
  saveReminderTarget: () => Promise<void>
  saveReminderPolicy: () => Promise<void>
  sendReminderTest: () => Promise<void>
  /**
   * 轮询的一次"提醒那一半"：拉到期提醒 → 更新列表 → 对新增的每条发系统通知。
   * `isAlive` 由装配层注入（见文件头的说明）；失败时**向外抛**，由装配层那条
   * `catch` 与草稿那半段共用同一个异常范围。
   */
  tickDue: (isAlive: () => boolean) => Promise<void>
}

export interface UseWorkbenchRemindersResult {
  /** 待办提醒列表（弹窗、待处理计数、待处理弹窗三处读它）。 */
  reminders: Array<{ reminderId: string; taskId: string; title: string; dueAt: string; methodCode: string }>
  /** 提醒弹窗是否打开（自动弹 + 手动关共用一个开关）。 */
  reminderModalOpen: boolean
  /** 系统通知可用性三态（v1.15.7）。 */
  notifyPerm: NotificationState
  /** 微信提醒：策略 + 通道状态（通道可用性由 dsh-im 决定，未安装时静默降级）。 */
  reminderPolicy: ReminderPolicyView | null
  reminderChannel: ReminderChannelView | null
  reminderOptions: ReminderOptionsView | null
  reminderBusy: boolean
  actions: UseWorkbenchRemindersActions
}

export function useWorkbenchReminders(input: UseWorkbenchRemindersInput): UseWorkbenchRemindersResult {
  const {
    currentTaskId, refresh, showSettings, desktopNotify,
    onError: setError, onNotice: setNotice, onToast: pushToast,
  } = input
  const [reminders, setReminders] = useState<Array<{ reminderId: string; taskId: string; title: string; dueAt: string; methodCode: string }>>([])
  const [reminderModalOpen, setReminderModalOpen] = useState(false)
  /**
   * 系统通知的可用性三态（v1.15.7）。
   *
   * 旧实现在**初始化时**判了 `typeof Notification === 'undefined'`，但**请求授权**那条
   * 路径没判：rc.2 客户端上点「授权浏览器通知」会直接抛 `TypeError`，用户看到的是
   * "点了没反应"。这里把构造函数与判定都收在一处（`notificationCapability.ts`）。
   */
  const notificationCtor = readNotificationCtor(globalThis)
  const [notifyPerm, setNotifyPerm] = useState<NotificationState>(
    () => classifyNotificationPermission(notificationCtor),
  )
  // 微信提醒：策略 + 通道状态（通道可用性由 dsh-im 决定，未安装时静默降级）
  const [reminderPolicy, setReminderPolicy] = useState<ReminderPolicyView | null>(null)
  const [reminderChannel, setReminderChannel] = useState<ReminderChannelView | null>(null)
  const [reminderOptions, setReminderOptions] = useState<ReminderOptionsView | null>(null)
  const [reminderBusy, setReminderBusy] = useState(false)

  /**
   * 桌面通知去重集合：持久化到 localStorage。
   * 原先是纯内存 Set，刷新页面就会对同一条提醒重发一次系统通知。现在跨会话记住，
   * 并在条目数超过上限时淘汰最旧的一半（避免无限增长）。
   */
  const notifiedRef = useRef<Set<string>>((() => {
    try {
      const raw = window.localStorage.getItem('dsh-workbench:desktop-notified')
      const parsed: unknown = raw === null ? [] : JSON.parse(raw)
      return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === 'string')) : new Set<string>()
    } catch { return new Set<string>() }
  })())
  const persistNotified = (): void => {
    try {
      const ids = [...notifiedRef.current]
      const trimmed = ids.length > 500 ? ids.slice(-250) : ids
      notifiedRef.current = new Set(trimmed)
      window.localStorage.setItem('dsh-workbench:desktop-notified', JSON.stringify(trimmed))
    } catch { /* localStorage 不可用时退化为内存去重 */ }
  }

  // 打开设置面板时加载微信提醒策略与通道状态（含自动发现的可选投递目标）
  useEffect(() => {
    if (!showSettings) return
    void Promise.all([
      api<{ policy: ReminderPolicyView }>('/api/workbench/reminders/policy'),
      api<{ status: ReminderChannelView; options: ReminderOptionsView }>('/api/workbench/reminders/channel'),
    ]).then(([policyResult, channelResult]) => {
      setReminderPolicy(policyResult.policy)
      setReminderChannel(channelResult.status)
      setReminderOptions(channelResult.options)
    }).catch(() => undefined)
  }, [showSettings])

  // 有到期提醒时自动弹出提醒弹窗（关掉后本次不再自动弹；新提醒到达会再弹一次）。
  useEffect(() => {
    if (reminders.length > 0) setReminderModalOpen(true)
  }, [reminders.length])

  /** 用户点「知道了」：写 acknowledged_at（终态），并把这条从待处理列表移除。 */
  const ackReminder = async (reminderId: string): Promise<void> => {
    try {
      await api(`/api/workbench/reminders/${reminderId}/ack`, { method: 'POST' })
    } catch {
      // 老版本宿主没有 ack 端点时优雅退回 fire（写 fired_at）
      await api(`/api/workbench/reminders/${reminderId}/fire`, { method: 'POST' }).catch(() => undefined)
    }
    setReminders((list) => list.filter((r) => r.reminderId !== reminderId))
    if (currentTaskId() !== null) await refresh()
  }
  /** 重新武装：清掉 fired/skipped/acknowledged，提醒回到「未处理」。 */
  const resetReminderState = async (reminderId: string): Promise<void> => {
    try {
      await api(`/api/workbench/reminders/${reminderId}/reset`, { method: 'POST' })
      setNotice('提醒已重新武装，到点会再次提醒')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const addTaskReminder = async (offsetMinutes: number): Promise<void> => {
    const taskId = currentTaskId()
    if (taskId === null) return
    try {
      await api(`/api/workbench/tasks/${taskId}/reminders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offsetMinutes, methodCode: 'browser' }) })
      setNotice(offsetMinutes === 0 ? '已添加“准时”提醒' : `已添加“提前 ${offsetMinutes} 分钟”提醒`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const loadReminderChannel = async (): Promise<void> => {
    setReminderBusy(true)
    try {
      const result = await api<{ status: ReminderChannelView; options: ReminderOptionsView }>('/api/workbench/reminders/channel')
      setReminderChannel(result.status)
      setReminderOptions(result.options)
      pushToast('已刷新通道状态', 'info')
    } catch (e) {
      pushToast(`刷新失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setReminderBusy(false)
    }
  }

  const saveReminderTarget = async (): Promise<void> => {
    if (reminderChannel === null) return
    setReminderBusy(true)
    try {
      const result = await api<{ status: ReminderChannelView }>('/api/workbench/reminders/channel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId: reminderChannel.botId, targetId: reminderChannel.targetId }),
      })
      setReminderChannel(result.status)
      pushToast('投递目标已保存', 'success')
    } catch (e) {
      pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setReminderBusy(false)
    }
  }

  const saveReminderPolicy = async (): Promise<void> => {
    if (reminderPolicy === null) return
    setReminderBusy(true)
    try {
      const result = await api<{ policy: ReminderPolicyView }>('/api/workbench/reminders/policy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reminderPolicy),
      })
      setReminderPolicy(result.policy)
      pushToast('微信提醒策略已保存', 'success')
    } catch (e) {
      pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setReminderBusy(false)
    }
  }

  const sendReminderTest = async (): Promise<void> => {
    setReminderBusy(true)
    try {
      const result = await api<{ ok: boolean; reason?: string }>('/api/workbench/reminders/test', { method: 'POST' })
      if (result.ok) pushToast('测试消息已发送，请查看手机微信', 'success')
      else pushToast(`发送失败：${result.reason ?? 'unknown'}`, 'error')
    } catch (e) {
      pushToast(`发送失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setReminderBusy(false)
    }
  }

  /**
   * `useCallback` 的依赖只有 `desktopNotify` —— **必须**如此（P5-3）。
   *
   * `useWorkbenchPolling` 把它放进 effect 依赖数组，靠身份变化判断"要不要重建那个 5 秒
   * 定时器"。身份若每次渲染都变，定时器会被反复重建（每渲染都立即多跑一次 tick）。
   * 体里除此之外只有 ref、稳定 setter 与模块导入，所以 `[desktopNotify]` 恰好就是
   * 原入口 effect 依赖数组里 `settings.desktopNotify` 那一项的等价物。
   */
  const tickDue = useCallback(async (isAlive: () => boolean): Promise<void> => {
    const r = await api<{ reminders: Array<{ reminderId: string; taskId: string; title: string; dueAt: string; methodCode: string }> }>('/api/workbench/reminders/due')
    if (!isAlive()) return
    setReminders(r.reminders)
    // 系统级桌面提醒：启用且浏览器已授权时，对每个到期提醒发一次系统通知。
    if (desktopNotify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      let notifiedAny = false
      for (const reminder of r.reminders) {
        if (notifiedRef.current.has(reminder.reminderId)) continue
        notifiedRef.current.add(reminder.reminderId)
        notifiedAny = true
        /**
         * ⚠️ 失败**必须可观测**（v1.15.7）：旧写法的空 catch 把失败吞得干干净净，
         * 让"通知发不出去"在界面上和控制台上都不存在 —— 用户只能看到"到点了没提醒"。
         * 这里改用统一的 `sendSystemNotification()`：失败返回原因并落一条控制台日志。
         * 不去打扰用户（到期提醒是后台流程，弹一条错误会让"提醒失败"变成"弹窗骚扰"）。
         */
        const sent = sendSystemNotification({
          NotificationCtor: readNotificationCtor(globalThis),
          title: `任务提醒：${reminder.title}`,
          body: `截止时间：${fmtTime(reminder.dueAt)}`,
          tag: `dsh-personal-workbench:${reminder.reminderId}`,
        })
        if (!sent.ok) console.warn(`[workbench] 到期提醒未能发出系统通知：${sent.reason}`)
      }
      if (notifiedAny) persistNotified()
    }
  }, [desktopNotify])

  return {
    reminders,
    reminderModalOpen,
    notifyPerm,
    reminderPolicy,
    reminderChannel,
    reminderOptions,
    reminderBusy,
    actions: {
      setReminderModalOpen, setNotifyPerm, setReminderPolicy, setReminderChannel,
      ackReminder, resetReminderState, addTaskReminder,
      loadReminderChannel, saveReminderTarget, saveReminderPolicy, sendReminderTest,
      tickDue,
    },
  }
}
