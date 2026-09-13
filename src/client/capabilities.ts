/**
 * 宿主能力门槛（设计文档 2026-09-13 第 5 节，原则 P5：失败可观测）。
 *
 * ## 这个文件解决什么问题
 *
 * 老版本 DSH 上工作台曾经"半死不活"：
 *
 * - `0.1.1-rc.x` 的 `layout` **没有** `selectPanel` → 官方路径无法成立；
 * - 但我们当时写的是"探测失败就换一条腿"——自建 DOM 腿会铺一层
 *   `position:fixed; inset:0` 的满屏层，收不起来就永久盖住会话区
 *   （用户原话"除左栏外什么都点不了"）。
 *
 * 现在的契约是**没有兼容层**：
 *
 * - `inject` 声明完整（`sessions` / `workspaces` / `connection` / `slots` / `layout`），
 *   缺任何一项 → cordis 让插件 pending，**不加载**；
 * - 万一进来了但槽位不全 → 本模块给出**可读原因**，`apply()` 直接 `return` 一个空清理函数，
 *   **不注册任何东西、不写任何 DOM**。
 *
 * 也就是说：老宿主上工作台**明确不启动**，而不是降级成半个能用的东西。
 *
 * ## 硬约束
 *
 * 与 `panelState.ts` 一样：**不 import React、不碰 DOM、不读 `document`**。
 * 唯一的外部输入是宿主注入的 services 与槽位名字，因此可被 `node --test` 直接测。
 */

/**
 * 设计文档第 5.1 节的**唯一 inject 判据**。
 *
 * `test/capabilities.test.mjs` 断言它精确等于这 5 项（I3）——
 * 少一项会让插件在半残状态下启动（就是上面说的"半死不活"），
 * 多一项则可能让老宿主直接 pending（例如 `uiWorkspace` 在 0.1.1-rc.1 上不存在）。
 */
export const inject = ['sessions', 'workspaces', 'connection', 'slots', 'layout'] as const

/** 我们依赖的三个官方槽位（名字来自 `entryContract.ts` 的常量，这里只做形状声明）。 */
export interface RequiredSlots {
  readonly panellist: string
  readonly main: string
  readonly overlay: string
}

/** 官方槽位名：入口行 / 中央占位 / 常驻内容。 */
export const REQUIRED_SLOTS: RequiredSlots = {
  panellist: 'sidebar.panellist',
  main: 'main',
  overlay: 'shell.overlay',
}

/** 宿主能力自检结果：`ok` 为假时 `reason` 必须是人能看懂的一句话。 */
export type CapabilityVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false
      /** 缺什么（给日志与 README 对照）。 */
      readonly missing: readonly string[]
      /** 中文可读原因，会原样进 `console.error`。 */
      readonly reason: string
    }

/** 宿主注入的 slots 服务里我们用到的那一小块（只声明形状，不 import 宿主类型）。 */
export interface SlotsProbe {
  readonly entriesOfSlot?: (name: string) => unknown
  readonly inject?: unknown
  readonly register?: unknown
}

/** 宿主注入的服务集合（`apply(ctx)` 的 ctx 简化形状）。 */
export interface HostServices {
  readonly slots?: SlotsProbe
  readonly layout?: unknown
}

/** 最低支持版本（写进 README 与日志；`layout.selectPanel` 从该版本起提供）。 */
export const MIN_HOST_VERSION = '0.1.5-rc.1'

/**
 * 廉价能力自检：**不猜、不分支、不降级**，只回答"能不能按官方路径启动"。
 *
 * 检查三件事（对应设计文档第 5.1 节）：
 *
 * 1. `slots` 服务在，且有 `entriesOfSlot` / `inject` / `register` 三件套；
 * 2. 三个槽位名字都能被 `entriesOfSlot` 查到（说明宿主声明了它们）；
 * 3. `layout.selectPanel` 是函数（它是"面板能被选中"的唯一开关）。
 *
 * 任何一条不满足 → 返回 `ok: false` + 可读原因，调用方**不注册任何东西**。
 */
export function checkHostCapabilities(services: HostServices): CapabilityVerdict {
  const missing: string[] = []
  const slots = services.slots
  if (slots === undefined || slots === null) {
    return {
      ok: false,
      missing: ['slots'],
      reason: `宿主没有提供 slots 服务：本插件只支持 DSH ${MIN_HOST_VERSION} 及以上的官方槽位机制，请升级 DSH`,
    }
  }
  if (typeof slots.entriesOfSlot !== 'function' || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    missing.push('slots.entriesOfSlot/inject/register')
  }
  for (const [key, name] of Object.entries(REQUIRED_SLOTS)) {
    if (missing.length > 0) break
    try {
      // 只要求"查得到、不抛错"；不解释返回值（不同宿主版本返回形状不同）
      slots.entriesOfSlot?.(name)
    } catch {
      missing.push(`${key}(${name})`)
    }
  }
  const layout = services.layout as { selectPanel?: unknown } | undefined
  if (typeof layout?.selectPanel !== 'function') missing.push('layout.selectPanel')

  if (missing.length === 0) return { ok: true }
  return {
    ok: false,
    missing,
    reason: `宿主缺少官方槽位能力（缺：${missing.join('、')}）。本插件只支持 DSH ${MIN_HOST_VERSION} 及以上；`
      + '旧宿主上工作台**不会启动**（这是刻意的：早先"探测失败就降级 DOM"的做法会铺满屏层、把会话区盖住）。',
  }
}

/**
 * `apply()` 里"明确不启动"的统一出口：打一条可读日志，并返回空清理函数。
 *
 * 为什么要有这个函数而不是各处自己 `console.error` + `return`：
 * 日志文案与"不注册任何东西"这两个约定必须**只有一份实现** ——
 * 否则又会出现"某条路径记得打日志、另一条忘了"的情况（这正是 P5 要防的）。
 */
export function refuseToStart(verdict: Extract<CapabilityVerdict, { ok: false }>, warn: (message: string) => void): () => void {
  warn(`[workbench] 未启动：${verdict.reason}`)
  return () => {}
}
