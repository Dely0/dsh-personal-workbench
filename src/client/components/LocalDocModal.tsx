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
import { Icon } from './Icon.js'

/** 与后端 `localDirRoute.ROOTS_PARENT` 同值的哨兵（这里是客户端可读文本）。 */
export const ROOTS_PARENT = '\u0000roots'

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

export function LocalDocModal({ open, path, listing, loading, error, busy, onPathChange, onClose, onNavigate, onPick, onPickAndSummarize, onSummarize }: {
  open: boolean
  path: string
  listing: LocalDirListing | null
  loading: boolean
  error: string | null
  busy: boolean
  onPathChange: (path: string) => void
  onClose: () => void
  onNavigate: (path: string | null) => void
  onPick: (entry: LocalDirEntry) => void
  onPickAndSummarize: (entry: LocalDirEntry) => void
  onSummarize: () => void
}): JSX.Element | null {
  if (!open) return null
  const atRoots = listing === null || listing.path === ROOTS_PARENT
  return (
    <div className="wb-modal-mask" onClick={onClose}>
      <div className="wb-modal wb-doc-modal" data-doc-modal onClick={(e) => e.stopPropagation()}>
        <h4><Icon name="file" />AI 总结本地文档</h4>
        <p>选一个本地文件（Markdown / 文本 / 代码），让 AI 提炼成知识条目草稿。也可以用下面的路径框直接粘贴 <code>file://</code> 或绝对路径。</p>

        <div className="wb-doc-path">
          <input
            data-doc-path
            value={path}
            placeholder={'本地文档路径或 file://，如 E:\\docs\\方案.md、/mnt/e/docs/方案.md'}
            onChange={(e) => onPathChange(e.target.value)}
          />
          <button type="button" className="wb-btn primary" data-doc-run disabled={busy} onClick={onSummarize}>
            <Icon name="sparkles" />开始总结
          </button>
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
            {listing !== null && listing.entries.length === 0 && <div className="wb-doc-empty">{emptyListingHint(listing)}</div>}
            {(listing?.entries ?? []).map((entry) => (
              <div key={entry.path} className="wb-doc-row" data-doc-entry={entry.path} onClick={() => entry.isDirectory ? onNavigate(entry.path) : undefined}>
                <span className="wb-doc-name">
                  <Icon name={entry.isDirectory ? 'folder' : 'file'} size={13} /> {entry.name}
                </span>
                {entry.isDirectory ? (
                  <button type="button" className="wb-btn" onClick={(e) => { e.stopPropagation(); onNavigate(entry.path) }}>进入</button>
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
    </div>
  )
}
