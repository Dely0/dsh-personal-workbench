/**
 * D17 / P5-1：**反馈域（Feedback）的唯一所有者**。
 *
 * 拆分前这些散在 `src/client/index.tsx` 的 `WorkbenchApp` 顶部（原 L366-367 与 L418、L651-658）：
 * 两项 state（`error` / `notice`）、toast 队列的宿主（`useToasts()`）、以及把两者转成右上角
 * toast 的两条桥接 effect。
 *
 * ## 为什么这一域必须落在最早处（本批的硬约束）
 * `useTaskData`（`onError: setError, onNotice: setNotice`）、`useKnowledge`、`useIdeas`、
 * `useTaskListModel`、`useDayWorkspace` 以及本批的设置域**都靠注入回调拿反馈**，
 * 而 `const` 没有提升 —— 所以本 hook 的调用点必须在这批注入点之前，也就是原来
 * `error`/`notice` 声明的那一行，**不能**为了"离使用者近"而下移。
 *
 * ## 刻意不做的事
 * - **不做 `error`/`notice` 的渲染**：它们在入口里是"只写不读"的状态（唯一的读点就是下面两条
 *   桥接 effect），用户可见的反馈全部走 toast（原注释：不再作为文档流横幅把任务列表挤下去）。
 * - **不拥有 toast 队列的实现**：那是 `components/Toast.tsx` 的 `useToasts`（纯 state，无 effect）。
 *   本 hook 只把它的**宿主**提到反馈域，保证"往哪儿推提示"全客户端只有一处。
 * - **不碰业务**：没有请求、没有业务判定；`setError`/`setNotice` 的语义仍是"写一条待播报的文本"。
 *
 * ## 等价性说明（为什么这次搬迁不改变行为）
 * 桥接 effect 的依赖是 `[notice, pushToast]` / `[error, pushToast]`，而 `pushToast` 由
 * `useToasts` 每次渲染新建（未 memo）。搬迁前它们注册在 `WorkbenchApp` 的后半段、
 * 搬迁后注册在顶部：两者的先后只影响同一次提交内的**执行顺序**，而这些 effect 读的都是
 * 本次渲染闭包里的旧值（渲染期为 `null`），所以顺序不改变可观察行为。
 */
import { useEffect, useState } from 'react'
import { useToasts, type ToastItem, type ToastTone } from '../components/Toast.js'

export interface UseWorkbenchFeedbackActions {
  /** 写一条错误：会被下面的桥接 effect 转成右上角 toast 并立即清回 `null`。 */
  setError: (message: string | null) => void
  /** 写一条提示：同上（tone = success）。 */
  setNotice: (message: string | null) => void
  /** 直接推 toast（不需要经过 `error`/`notice` 中间态的即时反馈用它）。 */
  pushToast: (message: string, tone?: ToastTone) => void
  dismissToast: (id: number) => void
}

export interface UseWorkbenchFeedbackResult {
  /** 只写不读；保留在返回值里是为了让桥接逻辑自证"没有第二个读点"。 */
  error: string | null
  notice: string | null
  /** toast 队列本体，交给 `<ToastHost items={toasts} …/>`。 */
  toasts: ToastItem[]
  actions: UseWorkbenchFeedbackActions
}

export function useWorkbenchFeedback(): UseWorkbenchFeedbackResult {
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const { toasts, pushToast, dismissToast } = useToasts()

  // 提示 / 错误统一转成右上角 toast：不再作为文档流横幅把任务列表挤下去。
  // 保留既有 setNotice/setError 调用点不变，在这里做一次桥接。
  useEffect(() => {
    if (notice !== null) { pushToast(notice, 'success'); setNotice(null) }
  }, [notice, pushToast])
  useEffect(() => {
    if (error !== null) { pushToast(error, 'error'); setError(null) }
  }, [error, pushToast])

  return { error, notice, toasts, actions: { setError, setNotice, pushToast, dismissToast } }
}
