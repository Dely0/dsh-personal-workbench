/**
 * D17 / P6-1：**界面忙碌标志（Busy）的唯一所有者**。
 *
 * 拆分前它是 `WorkbenchApp` 体内的 `const [busy, setBusy] = useState(false)`
 * （原 `src/client/index.tsx:387`）。
 *
 * ## 为什么它需要自己的 owner（而不是塞进某个业务域）
 * `busy` 是**跨域共享的一个界面瞬态**：
 * - 写它的是两个域 —— AI 会话域（`startAISession` 起止各一次）与知识域（摘要 / 加载期间）；
 * - 读它的是三个视图（知识列表 / 点子列表 / 任务详情）与若干按钮的禁用态。
 *
 * 把它塞进 AI 会话域会造成**跨域倒挂**：AI 会话域的 hook 必须落在 `useDayWorkspace`
 * 之后（它要用 `planPromptFor` / `todayPlan` 等），而知识域在它之前就要 `setBusy`
 * —— 那正是本次拆分反复出现的"为少留一项 state 而制造反向依赖"。
 * 所以按 ADR-0008 的口径单独立一个最小 owner：**一个布尔、一个写口、零依赖、零副作用**。
 *
 * ## 刻意不做的事（都是"改了行为"的诱惑）
 * - **不做"忙因"栈**（不加计数、不记来源集合）：搬迁前两个域都是直接赋值 `true` / `false`，
 *   谁后写谁生效。改成计数会改变可观察行为（知识域先结束会把 AI 会话的"忙"提前清掉），
 *   那是功能改动，不属拆分。
 * - **不接 `instanceAlive` 判活**：入口那句 `if (instanceAlive) setBusy(false)` 原样留在调用点。
 * - **不接管 toast / 不接管禁用逻辑**：只是状态的宿主。
 */
import { useState } from 'react'

export interface UseWorkbenchBusyActions {
  /** 置忙 / 解除忙。入口的 4 个写点全部是直接赋值（无函数式更新）。 */
  setBusy: (value: boolean) => void
}

export interface UseWorkbenchBusyResult {
  busy: boolean
  actions: UseWorkbenchBusyActions
}

export function useWorkbenchBusy(initial = false): UseWorkbenchBusyResult {
  const [busy, setBusy] = useState(initial)
  return { busy, actions: { setBusy } }
}
