/**
 * D17 / P5-3：**轮询装配器（无业务状态）**。
 *
 * 取代 `src/client/index.tsx` 里那条混合域 effect（P5-2 后仍是 L574-636 的一整片）：
 * 它一个 `try` 里先拉待确认草稿、再拉到期提醒，同时挂 5 秒 tick 与 15 秒 refresh
 * 两个定时器，依赖数组 `[refresh, settings.desktopNotify]`，卸载时 `alive = false`
 * 并清两个 interval。
 *
 * 本文件**不持任何 state、不发任何请求、不认识任何域的数据形状** —— 它只负责
 * 时段（5s / 15s）、顺序、异常范围、卸载清理与依赖重建，把两次拉取从外面注入。
 * 这样 "草稿域 + 提醒域顺序执行、失败一起吞掉下一轮重试" 这条既有行为在
 * 拆分之后仍然是**同一个 effect 的同一个 try**，不会变成两个互不知情的定时器。
 *
 * ## 逐字保持的四件事（设计 §5.3）
 * 1. **顺序**：草稿 → 提醒，**串行**。草稿那半段抛错时提醒那半段当轮不执行 ——
 *    原实现里两半段在同一个 `try` 内，异常范围就是这个顺序的直接后果。
 * 2. **频率**：5 秒 tick（立即先跑一次）+ 15 秒 refresh。
 * 3. **异常范围**：tick 里所有异常都进同一个 `catch { /* 轮询失败下轮重试 *\/ }`；
 *    15 秒 refresh 自带 `.catch(() => undefined)`，与原文本一致。
 * 4. **清理**：卸载时 `alive = false` + `clearInterval` 两个定时器；
 *    `alive` 以回调 `() => alive` 交给各域，用于挡住"卸载后才回来的响应"。
 *
 * ## 为什么依赖数组能写成 `[refresh, desktopNotify, tickDrafts, tickReminders]`
 * 原文本是 `[refresh, settings.desktopNotify]`，因为提醒那半段就地读了 `settings.desktopNotify`。
 * 现在它跑在 `useWorkbenchReminders` 里，`tickDue` 以 `useCallback(..., [desktopNotify])` 暴露
 * （只在 `desktopNotify` 变化时换身份，与原依赖**同一时机**）；
 * `tickDrafts` 是 `useCallback(..., [])`（体内只有 ref 与稳定 setter，没有会变的闭包值），
 * 身份恒定。⇒ 本条 effect 的重建时机与原实现**逐字等价**：仍是"`refresh` 或
 * `desktopNotify` 变化时重建"。把两个 tick 函数列进依赖只是让这条等价性可被静态检查看见，
 * 而不是靠注释声明 —— 谁哪天给 `tickDrafts` 塞进一个会变的闭包值，这里就会立刻多重建、
 * 且 `d17-p5c-exit-check.py` 会红。
 */
import { useEffect } from 'react'

export interface UseWorkbenchPollingInput {
  /** 草稿域的一次拉取（5 秒 tick 的前半段）；失败向外抛，由本 hook 的 catch 吞掉。 */
  tickDrafts: (isAlive: () => boolean) => Promise<void>
  /** 提醒域的一次拉取（5 秒 tick 的后半段）；失败向外抛，由本 hook 的 catch 吞掉。 */
  tickReminders: (isAlive: () => boolean) => Promise<void>
  /** 任务数据域的 15 秒刷新（自带 catch，与原文本一致）。 */
  refresh: () => Promise<void>
  /** 依赖重建键：设置域 `settings.desktopNotify`（原 effect 依赖数组里的那一项）。 */
  desktopNotify: boolean
}

export function useWorkbenchPolling(input: UseWorkbenchPollingInput): void {
  const { tickDrafts, tickReminders, refresh, desktopNotify } = input
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        await tickDrafts(() => alive)
        await tickReminders(() => alive)
      } catch { /* 轮询失败下轮重试 */ }
    }
    void tick()
    const timer = setInterval(() => void tick(), 5000)
    const refreshTimer = setInterval(() => { void refresh().catch(() => undefined) }, 15000)
    return () => { alive = false; clearInterval(timer); clearInterval(refreshTimer) }
  }, [refresh, desktopNotify, tickDrafts, tickReminders])
}
