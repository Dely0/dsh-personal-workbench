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

export function Modal({ title, titleExtra, size = 'md', footer, onClose, closeOnBackdrop = true, children }: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  useScrollLock()

  useEffect(() => {
    // 记住打开前的焦点，关闭后还回去（键盘用户不会迷失位置）
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panel)?.focus()
    return () => { restoreFocusRef.current?.focus?.() }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
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
  }, [onClose])

  return createPortal(
    <div
      className="wb-overlay"
      onMouseDown={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose() }}
    >
      <div
        className={`wb-dialog wb-dialog-${size}`}
        role="dialog"
        aria-modal="true"
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
