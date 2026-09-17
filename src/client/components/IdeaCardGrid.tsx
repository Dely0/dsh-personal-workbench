/**
 * 点子卡片网格（打样 1 号：卡片瀑布 / Bento 画廊）。
 *
 * ## 与旧实现的差异（都是刻意的）
 *
 * - 卡片**整块可点**（打开详情），「归入文件夹」与 ☑ 各自 `stopPropagation`；
 * - ☑ 静息态不可见、hover / **键盘聚焦**才显形，已选常显（见 `styles.ts` 的 `:focus-visible`）；
 * - 文件夹菜单 **portal 到 `document.body`**，位置由 `placePopover()` 算（视口坐标 + 高度收敛）。
 *
 * ## 为什么菜单必须 portal（v1.15.2 复审 F4）
 *
 * 第一版让菜单留在网格里、用 `position:fixed` 并按"面板滚动区"夹位置，前提是**错的**：
 * `overflow` **不是** `position:fixed` 的包含块（只有 `transform` / `filter` / `backdrop-filter`
 * 等才会创建包含块）。实测：`overflow:auto` 的祖先里的 fixed 浮层仍然按**视口**定位。
 * 于是那份"按包含块夹取"的实现语义自相矛盾，能跑对纯属巧合 —— 一旦宿主（或未来某次改动）
 * 给某个祖先加上 `transform`，同一份坐标就会整体偏移（最坏偏移量 = 面板左边界宽度）。
 *
 * 同一个仓库里已经有权威实现与权威教训：模型选择器正是因为 `.wb-overlay` 的
 * `backdrop-filter` 会当包含块，才走 **portal + fixed + `placePopover()`**
 * （`popoverPlacement.ts` 开头写着这件事）。这里复用同一套，不再自造第二份。
 *
 * ## 状态归属
 *
 * 「哪个菜单开着」与摆放结果都是**纯 UI 选择**，留在组件内。
 * 上一版把 rect 提到页面 state 里，于是每个滚动帧都要写一次页面级状态，
 * 整个 5000 行的 `WorkbenchApp` 跟着重渲染（复审 F5）。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ContentItem } from '../listPresentation.js'
import { placePopover, type PopoverPlacement } from '../popoverPlacement.js'
import { fmtTime } from '../format.js'
import type { Dict } from '../viewTypes.js'

export interface IdeaCardItem extends ContentItem {
  /** 该点子所属的文件夹 id（一个点子可属于多个）；空数组 = 未归类。 */
  clusterIds: readonly string[]
}

export interface ClusterOption { id: string; title: string }

/** 菜单的期望尺寸。高度给"内容自然高度"的兜底，实际情况由 `placePopover` 按量到的值收敛。 */
export const FOLDER_MENU_SIZE = Object.freeze({ width: 210, height: 220 })

/**
 * 算「归入文件夹」菜单该放在哪儿（**视口坐标**，因为菜单 portal 到 body）。
 *
 * 直接复用 `placePopover()`：它已经带上有限值兜底、视口高度收敛、贴边水平挪位。
 * `prefer: 'bottom'` 是因为**下拉菜单的直觉是从按钮往下弹**；下方放不开才翻到上方。
 */
export function placeFolderMenu(
  anchor: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
  menu: { width: number; height: number } = FOLDER_MENU_SIZE,
): PopoverPlacement {
  return placePopover({ anchor, viewport, menu, prefer: 'bottom' })
}

/**
 * 从触发按钮的矩形 + 窗口尺寸算出 `placeFolderMenu` 的入参。
 *
 * 抽成纯函数是为了能直接单测"锚点/视口怎么来的"，而不是只能靠浏览器实测。
 * 缺字段（老浏览器没有 `innerWidth`）一律落 0，由 `placePopover` 的有限值兜底接住。
 */
export function folderMenuAnchor(
  rect: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
): { anchor: { top: number; bottom: number; left: number; right: number }; viewport: { width: number; height: number } } {
  return { anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }, viewport }
}

export function IdeaCardGrid({ ideas, dicts, selectedId, pickedIds, clusters, onOpen, onTogglePick, onFileInto, onCreateFolder }: {
  ideas: readonly IdeaCardItem[]
  dicts: readonly Dict[]
  selectedId: string | undefined
  pickedIds: ReadonlySet<string>
  clusters: readonly ClusterOption[]
  onOpen: (idea: IdeaCardItem) => void
  onTogglePick: (id: string) => void
  onFileInto: (ideaId: string, clusterId: string) => void
  onCreateFolder: () => void
}): JSX.Element {
  const [menuIdeaId, setMenuIdeaId] = useState<string | null>(null)
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (menuIdeaId === null) { setPlacement(null); return undefined }
    const reposition = (): void => {
      const anchorEl = document.querySelector(`[data-idea-fold="${menuIdeaId}"]`)
      // 触发按钮已经不在了（该条被归入文件夹 / 被筛掉）→ 关掉菜单，别留一个孤儿浮层
      if (!(anchorEl instanceof HTMLElement)) { setMenuIdeaId(null); return }
      const box = anchorEl.getBoundingClientRect()
      /**
       * 高度用**量出来的**自然高度（量不到才回退常量）。
       * 上一版按 `44 + n*33` 估算，遇到"该点子已在 N 个文件夹里"那一行会低估 28px，
       * 正好让"下方放得开"判错（复审 F7）。
       */
      const natural = menuRef.current?.scrollHeight ?? FOLDER_MENU_SIZE.height
      const { anchor, viewport } = folderMenuAnchor(box, { width: window.innerWidth, height: window.innerHeight })
      const next = placeFolderMenu(anchor, viewport, { width: FOLDER_MENU_SIZE.width, height: natural })
      // 同值不写：这是"量 → 写状态 → 再渲染"的回路，没有相等判断会在滚动时自激
      setPlacement((prev) => (prev !== null && prev.side === next.side && prev.left === next.left
        && prev.top === next.top && prev.maxHeight === next.maxHeight ? prev : next))
    }
    reposition()
    window.addEventListener('resize', reposition)
    document.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      document.removeEventListener('scroll', reposition, true)
    }
  }, [menuIdeaId, ideas])

  if (ideas.length === 0) return <></>

  const menuIdea = menuIdeaId === null ? undefined : ideas.find((idea) => idea.id === menuIdeaId)

  const menu = placement === null || menuIdea === undefined ? null : (
    <div
      ref={menuRef}
      className="wb-idea-foldmenu"
      data-idea-foldmenu
      style={{ top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight, overflowY: 'auto' }}
    >
      {clusters.map((cluster) => (
        <button key={cluster.id} type="button" data-idea-file={cluster.id} onClick={() => { setMenuIdeaId(null); onFileInto(menuIdea.id, cluster.id) }}>
          <span className="wb-idea-foldic">🗂</span>{cluster.title}
        </button>
      ))}
      {menuIdea.clusterIds.length > 0 && <div className="wb-idea-foldnote">已在 {menuIdea.clusterIds.length} 个文件夹里</div>}
      <button type="button" data-idea-newfolder onClick={() => { setMenuIdeaId(null); onCreateFolder() }}>
        <span className="wb-idea-foldic">＋</span>新建文件夹…
      </button>
    </div>
  )

  return (
    <>
      <div className="wb-idea-cards" data-idea-cards>
        {ideas.map((idea) => {
          const dict = dicts.find((d) => d.code === idea.kindCode)
          const color = String(dict?.config.color ?? '#8a9aa8')
          const picked = pickedIds.has(idea.id)
          const classes = ['wb-idea-card2']
          if (selectedId === idea.id) classes.push('sel')
          if (picked) classes.push('picked')
          return (
            <div
              key={idea.id}
              className={classes.join(' ')}
              data-idea-card={idea.id}
              style={{ ['--wb-idea-color' as string]: color }}
              onClick={() => onOpen(idea)}
            >
              <button
                type="button"
                className="wb-idea-pick"
                data-idea-pick={idea.id}
                title={picked ? '取消选择' : '选中（用于 AI 关联）'}
                aria-pressed={picked}
                onClick={(e) => { e.stopPropagation(); onTogglePick(idea.id) }}
              >
                ✓
              </button>
              <div className="wb-idea-title">{idea.title}</div>
              <div className="wb-idea-sum2">{idea.body.replace(/\n/g, ' ')}</div>
              <div className="wb-idea-foot2">
                <span className="wb-kb-chip" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 45%, transparent)` }}>{dict?.name ?? idea.kindCode}</span>
                {idea.tags.slice(0, 3).map((tag) => <span key={tag} className="wb-kb-tg">#{tag}</span>)}
                <span className="wb-idea-stamp">{fmtTime(idea.updatedAt)}</span>
                <button
                  type="button"
                  className="wb-idea-foldbtn"
                  data-idea-fold={idea.id}
                  disabled={clusters.length === 0}
                  title={clusters.length === 0 ? '先在右上角新建一个文件夹' : '归入文件夹（一个点子可属于多个）'}
                  onClick={(e) => {
                    e.stopPropagation()
                    setPlacement(null)
                    setMenuIdeaId((prev) => (prev === idea.id ? null : idea.id))
                  }}
                >
                  归入文件夹 ▾
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {/* portal 到 body：网格/卡片/面板的 overflow 与层叠都管不到它。
          SSR（`renderToStaticMarkup`）里没有 document，退回原位渲染即可。 */}
      {menu !== null && (typeof document === 'undefined' ? menu : createPortal(menu, document.body))}
    </>
  )
}
