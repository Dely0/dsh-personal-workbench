/**
 * 「AI 总结本地文档」弹窗：路径输入 + 选择文件 + 开始总结。
 *
 * ## 为什么收进弹窗（用户反馈）
 *
 * 原先这三件东西（路径输入框 / 选择文件 / AI 总结）以裸控件的形式横在知识库工具栏里，
 * 占了整整一行，把列表往下挤。现在工具栏只留**一个按钮**，点开这里做同样的事。
 *
 * ## 「盘符」那一层为什么存在
 *
 * 原先没有它：后端在盘符根把 `parent` 记成 `null`（`dirname('C:\\') === 'C:\\'`），
 * 于是「上级」在 `C:\` 变灰、**再也出不去 C 盘** —— 用户看到的就是"只能选 C 盘的文件"。
 * 现在盘符根给出 `ROOTS_PARENT` 哨兵 → 「上级」进「此电脑」视图 → 可以切到 `E:\`。
 */
import { createPortal } from 'react-dom'
import { Icon } from './Icon.js'
import { ROOTS_PARENT } from '../localDirBrowser.js'

/**
 * 与后端 `localDirRoute.ROOTS_PARENT` 同值的哨兵（客户端可读文本）。
 *
 * ⚠️ 2026-10-01：定义搬到了 `../localDirBrowser.ts`（工作区「浏览…」弹窗也要用它，
 * 两处各写一份哨兵就会出现"一个弹窗能上到盘符列表、另一个卡在 C 盘"）。这里只**再导出**，
 * 不打断既有引用与测试。
 */
export { ROOTS_PARENT }

/**
 * 弹窗的两种用途（同一份实现，只差"能选什么"）：
 *
 * - `file`：「AI 总结本地文档」——选一个**文件**；
 * - `dir` ：工作区的「浏览…」——选一个**文件夹**（批次2 #2/W03）。
 *
 * 为什么不做成两个组件：目录浏览的骨架（上级 / 此电脑 / 主目录 / 列表 / 错误 / 加载）
 * 一模一样，复制一份就是"同一语义两处实现"，日后的修复只会落到其中一份上。
 */
export type LocalDocModalMode = 'file' | 'dir'

export interface LocalDirEntry { name: string; path: string; isDirectory: boolean; isFile: boolean; hidden: boolean }
export interface LocalRoot { path: string; name: string }
export interface LocalDirListing {
  path: string
  parent: string | null
  home: string
  roots: LocalRoot[]
  entries: LocalDirEntry[]
}

/** 空列表的提示文案：根视图与普通目录的说法不一样。 */
export function emptyListingHint(listing: LocalDirListing): string {
  if (listing.path === ROOTS_PARENT) return '没有找到可浏览的磁盘'
  return '此目录没有可选择的文件'
}

/** 目录模式的空列表提示（这里是"选文件夹"，不是"选文件"）。 */
export function emptyDirListingHint(listing: LocalDirListing): string {
  if (listing.path === ROOTS_PARENT) return '没有找到可浏览的磁盘'
  return '此目录下没有子文件夹'
}

export function LocalDocModal({ open, path, listing, loading, error, busy, mode = 'file', onPathChange, onClose, onNavigate, onPick, onPickAndSummarize, onSummarize, onPickDir }: {
  open: boolean
  path: string
  listing: LocalDirListing | null
  loading: boolean
  error: string | null
  busy: boolean
  /** 默认 `file`（保持既有行为逐字不变）；`dir` 用于挑工作区目录。 */
  mode?: LocalDocModalMode
  onPathChange: (path: string) => void
  onClose: () => void
  onNavigate: (path: string | null) => void
  onPick: (entry: LocalDirEntry) => void
  onPickAndSummarize: (entry: LocalDirEntry) => void
  onSummarize: () => void
  /** `dir` 模式下的「选择此文件夹」；缺省时目录行不渲染该按钮。 */
  onPickDir?: (entry: LocalDirEntry) => void
}): JSX.Element | null {
  if (!open) return null
  const atRoots = listing === null || listing.path === ROOTS_PARENT
  const isDir = mode === 'dir'
  return createPortal(
    <div className="wb-modal-mask" onClick={onClose}>
      <div className="wb-modal wb-doc-modal" data-doc-modal data-doc-mode={mode} onClick={(e) => e.stopPropagation()}>
        <h4><Icon name={isDir ? 'folder' : 'file'} />{isDir ? '选择工作区文件夹' : 'AI 总结本地文档'}</h4>
        <p>{isDir
          ? '选一个本地文件夹作为这次 AI 会话的工作区。也可以用下面的路径框直接粘贴绝对路径。'
          : '选一个本地文件（Markdown / 文本 / 代码），让 AI 提炼成知识条目草稿。也可以用下面的路径框直接粘贴 file:// 或绝对路径。'}</p>

        <div className="wb-doc-path">
          <input
            data-doc-path
            value={path}
            placeholder={isDir
              ? '工作区路径，如 D:\\Code\\my-repo、/mnt/d/code/my-repo'
              : '本地文档路径或 file://，如 E:\\docs\\方案.md、/mnt/e/docs/方案.md'}
            onChange={(e) => onPathChange(e.target.value)}
            onKeyDown={isDir
              // 目录模式下回车 = 跳到这个路径（手打了别的目录时不用先去点「上级」）
              ? (e) => { if (e.key === 'Enter') { e.preventDefault(); onNavigate(path) } }
              : undefined}
          />
          {isDir ? (
            <button
              type="button"
              className="wb-btn primary"
              data-doc-pick-current
              disabled={busy || listing === null || atRoots}
              onClick={() => { if (listing !== null && !atRoots && onPickDir !== undefined) onPickDir({ name: listing.path, path: listing.path, isDirectory: true, isFile: false, hidden: false }) }}
            >
              <Icon name="check" />选定当前文件夹
            </button>
          ) : (
            <button type="button" className="wb-btn primary" data-doc-run disabled={busy} onClick={onSummarize}>
              <Icon name="sparkles" />开始总结
            </button>
          )}
        </div>

        <div className="wb-doc-nav">
          <button
            type="button"
            className="wb-btn"
            data-doc-up
            disabled={listing === null || loading || atRoots}
            onClick={() => onNavigate(listing === null ? null : listing.parent)}
          >
            上级
          </button>
          <code className="wb-doc-crumb" data-doc-crumb>{listing === null ? '加载中…' : atRoots ? '此电脑' : listing.path}</code>
          <button type="button" className="wb-btn" data-doc-roots disabled={loading} onClick={() => onNavigate(ROOTS_PARENT)}>此电脑</button>
          <button type="button" className="wb-btn" data-doc-home disabled={loading || listing === null} onClick={() => listing !== null && onNavigate(listing.home)}>主目录</button>
        </div>

        {error !== null && <div className="wb-doc-error" data-doc-error>{error}</div>}

        {loading ? (
          <div className="wb-doc-loading">加载中…</div>
        ) : (
          <div className="wb-doc-list" data-doc-list>
            {listing !== null && listing.entries.length === 0 && (
              <div className="wb-doc-empty">{isDir ? emptyDirListingHint(listing) : emptyListingHint(listing)}</div>
            )}
            {(listing?.entries ?? []).map((entry) => (
              <div key={entry.path} className="wb-doc-row" data-doc-entry={entry.path} onClick={() => entry.isDirectory ? onNavigate(entry.path) : undefined}>
                <span className="wb-doc-name">
                  <Icon name={entry.isDirectory ? 'folder' : 'file'} size={13} /> {entry.name}
                </span>
                {entry.isDirectory ? (
                  <span className="wb-doc-acts">
                    <button type="button" className="wb-btn" onClick={(e) => { e.stopPropagation(); onNavigate(entry.path) }}>进入</button>
                    {isDir && onPickDir !== undefined && (
                      <button type="button" className="wb-btn primary" data-doc-pick-dir={entry.path} disabled={busy} onClick={(e) => { e.stopPropagation(); onPickDir(entry) }}>选择此文件夹</button>
                    )}
                  </span>
                ) : isDir ? (
                  // 目录模式下文件不可选：给一句说明，而不是渲染一个点了没反应的按钮
                  <span className="wb-doc-acts" style={{ opacity: .6 }}>（这里只选文件夹）</span>
                ) : (
                  <span className="wb-doc-acts">
                    <button type="button" className="wb-btn" onClick={(e) => { e.stopPropagation(); onPick(entry) }}>选择</button>
                    <button type="button" className="wb-btn primary" disabled={busy} onClick={(e) => { e.stopPropagation(); onPickAndSummarize(entry) }}>选择并总结</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="wb-modal-actions">
          <button type="button" className="wb-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    /**
     * ⚠️ **必须 portal 到 `document.body`**（与 `components/Modal.tsx` 同一理由，且更强）：
     * 1. 插件渲染在 DSH 面板容器里，祖先可能带 `overflow` / `transform` —— 内联的 `position:fixed`
     *    会被裁剪或错位；
     * 2. 这个弹窗会被**从另一个弹窗里**打开（批次2 #2 的工作区「浏览…」来自快速录入 / 新建任务），
     *    那些对话框本身就 portal 到 body。内联在面板里的这一份 DOM 更靠内，连层级都排不上，
     *    于是被整块盖住 —— 表现为"点在按钮坐标上、命中的是对话框里的元素"。
     */
    document.body,
  )
}
