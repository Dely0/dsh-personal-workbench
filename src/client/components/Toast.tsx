/**
 * 轻量 toast：承接"转瞬即逝"的反馈（保存成功、操作失败）。
 *
 * 为什么不用页面横幅：横幅在文档流里，出现即把任务列表挤下去。
 * toast 浮在右上角，不参与布局，自动消失。
 *
 * 需要用户决策的内容（草稿待确认、验收申请、到期提醒）**不放这里** ——
 * 那些走弹窗，避免自动消失把待办冲掉。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export interface ToastItem {
  id: number
  tone: ToastTone
  message: string
}

const TONE_ICON: Record<ToastTone, string> = {
  info: 'i',
  success: '✓',
  warning: '!',
  error: '×',
}

const DEFAULT_TTL_MS = 4200

export interface ToastHostProps {
  items: ToastItem[]
  onDismiss: (id: number) => void
}

export function ToastHost({ items, onDismiss }: ToastHostProps): ReactNode {
  return createPortal(
    <div className="wb-toasts" role="status" aria-live="polite">
      {items.map((item) => <ToastCard key={item.id} item={item} onDismiss={onDismiss} />)}
    </div>,
    document.body,
  )
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }): ReactNode {
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setLeaving(true), DEFAULT_TTL_MS)
    const remove = window.setTimeout(() => onDismiss(item.id), DEFAULT_TTL_MS + 180)
    return () => { window.clearTimeout(timer); window.clearTimeout(remove) }
  }, [item.id, onDismiss])
  return (
    <div className={`wb-toast wb-toast-${item.tone}${leaving ? ' leaving' : ''}`}>
      <span className="wb-toast-icon" aria-hidden="true">{TONE_ICON[item.tone]}</span>
      <span className="wb-toast-msg">{item.message}</span>
      <button className="wb-toast-close" onClick={() => onDismiss(item.id)} aria-label="关闭提示">✕</button>
    </div>
  )
}

/** 管理 toast 队列的 hook：push 一条、手动 dismiss。 */
export function useToasts(): { toasts: ToastItem[]; pushToast: (message: string, tone?: ToastTone) => void; dismissToast: (id: number) => void } {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const pushToast = (message: string, tone: ToastTone = 'info'): void => {
    setToasts((prev) => [...prev.slice(-3), { id: Date.now() + Math.random(), tone, message }])
  }
  const dismissToast = (id: number): void => setToasts((prev) => prev.filter((item) => item.id !== id))
  return { toasts, pushToast, dismissToast }
}
