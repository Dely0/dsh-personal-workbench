/**
 * 桌面（系统）通知的客户端判定（v1.15.7）。
 *
 * ## 为什么必须抽出这个模块（2026-09-28 用户实测的 P0）
 *
 * 现象：设置里通知「授权显示已开启」，点「发送测试通知」**看不到任何系统通知**，
 * 而且**没有任何可观测的信号**。旧实现有三处结构性问题：
 *
 * | 位置（改前） | 问题 |
 * |---|---|
 * | `index.tsx` 的发送测试通知 | `new Notification(...)` 外面包了一个空 `catch`（注释写着 ignore）—— 失败被完全吞掉 |
 * | `index.tsx` 的请求授权 | 直接调 `Notification.requestPermission()`，**没先判 `typeof Notification === 'undefined'`**（初始化时判了、请求路径漏了）⇒ 在不支持的客户端上抛 `TypeError`，用户看到的是"点了没反应" |
 * | 设置面板 | 只有 `granted` 才渲染「发送测试通知」，也没交代"已授权 ≠ 一定能弹出来" |
 *
 * 本模块把三态与发送结果**收敛成一处纯判定**（本项目规范：纯逻辑必须与 DOM/React 解耦），
 * 于是"失败必须可观测"这条政策能变成**会失败的测试**（`test/modelPickerDegrade.test.mjs`）。
 *
 * ## 三态（而不是二态）
 *
 * | state | 判据 | 界面该给什么 |
 * |---|---|---|
 * | `unsupported` | 拿不到 `Notification` 构造函数 | 说清"不支持"，**不要**再给授权按钮 |
 * | `default`（可请求） | `permission === 'default'` | 给「授权浏览器通知」按钮 |
 * | `granted` | `permission === 'granted'` | 给「发送测试通知」，并交代系统级前提 |
 * | `denied` | `permission === 'denied'` | 说清"已被拒绝、需去浏览器站点设置里改"，给不了按钮 |
 *
 * ## 诚实边界（别把"已授权"说成"一定能弹出来"）
 *
 * `Notification.permission === 'granted'` 只说明**浏览器站点权限**这一层。
 * 系统通知仍可能被**操作系统**静默丢弃（Windows 的"通知与操作"总开关、
 * 专注助手 / 勿扰、按应用单关、通知横幅被关），这一层网页**读不到也管不了**。
 * 所以 `granted` 的文案必须把这件事说出来，否则用户会一直看到
 * "显示已开启但毫无反应"（本次事故的原始描述）。真实的发送结果由
 * `sendSystemNotification()` 返回并在控制台留痕 —— 那是这一层唯一可观测的东西。
 *
 * 纯逻辑：不 import React、不碰 DOM、不读 `document`/`window` —— 拿不到
 * `Notification` 时由调用方传 `undefined` 进来，因此可被 `node --test` 直接测。
 */

/** 构造函数的**结构类型**：只用到我们需要的那两个成员（便于测试注入替身）。 */
export interface NotificationLike {
  readonly permission?: string
  new (title: string, options?: { body?: string; tag?: string }): unknown
}

/** 通知可用性的三态（加 `denied` 是为了给出"去站点设置里改"这种能照做的指引）。 */
export type NotificationState = 'unsupported' | 'default' | 'denied' | 'granted'

/** 拿不到构造函数时给用户看的原因（要能说明"为什么没反应"）。 */
export const NOTIFICATION_UNSUPPORTED_REASON =
  '当前客户端不支持系统通知（拿不到 Notification 构造函数），'
  + '本次不会弹出系统通知；任务到期仍会在工作台内以横幅提示。'

/** 从任意"全局对象形状"里读构造函数（`undefined` = 这个环境没有系统通知）。 */
export function readNotificationCtor(source: unknown): NotificationLike | undefined {
  const candidate = (source as { Notification?: unknown } | null | undefined)?.Notification
  return typeof candidate === 'function' ? candidate as NotificationLike : undefined
}

/**
 * 判定当前处于哪一态。
 *
 * ⚠️ 传入 `undefined` 一律判 `unsupported` —— **绝不**回落到 `globalThis`：
 * 回落会让"宿主把构造函数藏起来了"这种情形被误判成"权限是 default，去请求吧"，
 * 而那次请求在不支持的环境里会直接抛（正是本次事故的形态）。
 */
export function classifyNotificationPermission(ctor: NotificationLike | undefined): NotificationState {
  if (ctor === undefined) return 'unsupported'
  const permission = ctor.permission
  if (permission === 'granted') return 'granted'
  if (permission === 'denied') return 'denied'
  return 'default'
}

/** 三态的界面文案（**唯一实现**：设置面板与提示都读它，不许在别处再写一遍）。 */
export function notificationStateText(state: NotificationState): string {
  switch (state) {
    case 'unsupported':
      return '当前客户端不支持系统通知，将使用页内提示'
    case 'default':
      return '尚未授权浏览器通知，点右侧按钮授权后才会有系统通知'
    case 'denied':
      return '浏览器通知已被拒绝（站点设置里被关掉了）。请到浏览器的网站权限里改回“允许”，本页无法再弹授权框'
    case 'granted':
      return '浏览器通知已授权。注意：系统通知还可能被操作系统拦下'
        + '（Windows「通知和操作」总开关、专注助手/勿扰、按应用单关、横幅被关），'
        + '这一层网页读不到 —— 若点「发送测试通知」没弹出，请先查这几处'
  }
}

/** 请求授权的返回（**不抛错**：调用方拿它直接渲染提示即可）。 */
export interface NotificationPermissionResult {
  readonly ok: boolean
  readonly permission: NotificationState
  /** 失败时的可读原因（`ok: true` 时为空串）。 */
  readonly reason: string
}

/**
 * 请求浏览器授权：**不支持时当场失败并说清原因**，绝不静默 no-op。
 *
 * @param ctor - `readNotificationCtor()` 的结果。
 * @param log - 失败留痕（默认 `console.warn`）；测试可注入收集器。
 */
export async function requestNotificationPermission(
  ctor: NotificationLike | undefined,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<NotificationPermissionResult> {
  if (ctor === undefined) {
    log(`[workbench] 请求通知授权失败：${NOTIFICATION_UNSUPPORTED_REASON}`)
    return { ok: false, permission: 'unsupported', reason: NOTIFICATION_UNSUPPORTED_REASON }
  }
  try {
    // 静态 `requestPermission` 在不支持的实现上可能缺席 —— 缺席也算失败，而不是静默通过。
    const request = (ctor as unknown as { requestPermission?: () => Promise<string> }).requestPermission
    if (typeof request !== 'function') {
      const reason = '当前客户端的 Notification 没有 requestPermission 方法，无法请求授权'
      log(`[workbench] 请求通知授权失败：${reason}`)
      return { ok: false, permission: classifyNotificationPermission(ctor), reason }
    }
    const permission = await request.call(ctor)
    const state: NotificationState = permission === 'granted' || permission === 'denied' ? permission : 'default'
    return {
      ok: state === 'granted',
      permission: state,
      reason: state === 'granted' ? '' : '浏览器没有授予通知权限（用户拒绝或已忽略）',
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log(`[workbench] 请求通知授权抛错：${reason}`)
    return { ok: false, permission: classifyNotificationPermission(ctor), reason }
  }
}

/** 发送系统通知的结果（**可观测**：失败一定带原因）。 */
export interface NotificationSendResult {
  readonly ok: boolean
  /** 失败原因（`ok: true` 时为空串）。 */
  readonly reason: string
}

/**
 * 发一条系统通知 —— **失败必须被报出来**（本次事故的第二处修复）。
 *
 * 旧写法是"`new Notification(…)` 外面包一个空 catch"：
 * 失败在界面上与控制台上都**不存在**，用户只能看到"点了没反应"。
 * 这里把失败变成返回值 + 一条控制台日志，由调用方决定展示成什么。
 *
 * @param input.NotificationCtor - 构造函数（`undefined` = 环境不支持）。
 * @param input.title - 通知标题。
 * @param input.body - 通知正文。
 * @param input.tag - 去重标签（同一 tag 会被系统合并）。
 * @param input.permission - 当前权限（省略时读构造函数上的 `permission`）。
 * @param input.log - 失败留痕（默认 `console.warn`）。
 */
export function sendSystemNotification(input: {
  readonly NotificationCtor: NotificationLike | undefined
  readonly title: string
  readonly body?: string
  readonly tag?: string
  readonly permission?: string
  readonly log?: (message: string) => void
}): NotificationSendResult {
  const log = input.log ?? ((message: string) => console.warn(message))
  const ctor = input.NotificationCtor
  const fail = (reason: string): NotificationSendResult => {
    log(`[workbench] 系统通知发送失败：${reason}`)
    return { ok: false, reason }
  }
  if (ctor === undefined) return fail(NOTIFICATION_UNSUPPORTED_REASON)
  const permission = input.permission ?? ctor.permission
  if (permission !== 'granted') {
    const state: NotificationState = permission === 'denied' ? 'denied' : 'default'
    return fail(`${notificationStateText(state)}（当前 permission = ${String(permission)}）`)
  }
  try {
    // ⚠️ 构造成功**只说明浏览器收下了**；系统级是否真的显示，网页侧读不到。
    // 这一步的返回值就是"我们能做到的可观测"的边界，别在文案上吹成"已显示"。
    new ctor(input.title, {
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.tag === undefined ? {} : { tag: input.tag }),
    })
    return { ok: true, reason: '' }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
