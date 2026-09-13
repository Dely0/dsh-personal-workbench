/**
 * 弹窗基座：统一 ESC 关闭、遮罩点击关闭、焦点陷阱、打开时锁定页面滚动。
 *
 * 为什么用 portal：插件渲染在 DSH 面板容器里，祖先可能带 overflow/transform，
 * 直接 fixed 定位会被裁剪或错位；挂到 document.body 才能稳定覆盖整个视口。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

export interface ModalProps {
  title: ReactNode
  /** 标题栏右侧的自定义内容（如状态徽标） */
  titleExtra?: ReactNode
  size?: ModalSize
  /** 底部操作区；不传则不渲染底栏 */
  footer?: ReactNode
  onClose: () => void
  /** 阻止 ESC / 遮罩关闭（用于有未保存改动时二次确认） */
  closeOnBackdrop?: boolean
  children: ReactNode
  /**
   * **非模态**（v1.14.16）：不铺全屏遮罩、不锁页面滚动、不抢焦点。
   *
   * 为什么需要它：草稿弹框原先带全屏遮罩（`position:fixed; inset:0`，点击即关闭），
   * 于是只要它一出现，用户点任何地方都会先打在遮罩上 ——
   * 点侧栏「工作台」只会把弹框关掉、面板根本不开（2026-09-15 实测：
   * 点击后 `panelOpen` 仍为 null，我们的开关日志里连一次调用都没有）。
   * 这正是用户抱怨的"弹框出现后什么都干不了"。
   *
   * 非模态形态：浮在右下角的卡片，**不拦截点击**，用户可以随时去做别的事，
   * 不必先"暂存"再操作 DSH。
   */
  nonModal?: boolean
}

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** 打开弹窗期间锁定页面滚动，并补偿滚动条宽度避免布局抖动。 */
function useScrollLock(): void {
  useEffect(() => {
    const body = document.body
    const previousOverflow = body.style.overflow
    const previousPadding = body.style.paddingRight
    const gap = window.innerWidth - document.documentElement.clientWidth
    body.style.overflow = 'hidden'
    if (gap > 0) body.style.paddingRight = `${gap}px`
    return () => {
      body.style.overflow = previousOverflow
      body.style.paddingRight = previousPadding
    }
  }, [])
}

export function Modal({ title, titleExtra, size = 'md', footer, onClose, closeOnBackdrop = true, children, nonModal = false }: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  /**
   * 非模态浮卡**不锁滚动、不抢焦点、不铺遮罩** —— 这样才能"弹框在旁边，
   * 我照样能点别处"。滚动锁与焦点陷阱只在模态弹窗下启用。
   */
  if (!nonModal) useScrollLock()

  useEffect(() => {
    if (nonModal) return
    // 记住打开前的焦点，关闭后还回去（键盘用户不会迷失位置）
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panel)?.focus()
    return () => { restoreFocusRef.current?.focus?.() }
  }, [nonModal])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (nonModal || event.key !== 'Tab') return
      const panel = panelRef.current
      if (panel === null) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [onClose, nonModal])

  return createPortal(
    <div
      className={nonModal ? 'wb-dock' : 'wb-overlay'}
      onMouseDown={nonModal ? undefined : (event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose() }}
    >
      <div
        className={`wb-dialog wb-dialog-${size}`}
        role="dialog"
        {...(nonModal ? {} : { 'aria-modal': 'true' })}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="wb-dialog-head">
          <h3>{title}</h3>
          <div className="wb-dialog-head-extra">{titleExtra}</div>
          <button className="wb-dialog-close" onClick={onClose} aria-label="关闭" title="关闭（Esc）">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="wb-dialog-body">{children}</div>
        {footer !== undefined && <footer className="wb-dialog-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
