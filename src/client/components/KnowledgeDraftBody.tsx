/**
 * 知识草稿弹窗的正文（从 `DraftBanner.tsx` 的 `kindCode === 'knowledge'` 分支抽出）。
 *
 * ## 为什么单独抽成一个组件
 *
 * 1. **覆盖必须对用户可见**（2026-09-17 缺陷）：`workbench_submit_knowledge` 按会话去重，
 *    不带 `draft_id` 的重复提交会**覆盖**同一份草稿。以前弹窗长得和"新建"一模一样，
 *    用户点「确认入库」时根本不知道前面几次的内容已经没了。现在这里会把
 *    「本会话第 N 次提交 / 被替换的标题 / 草稿 id」显式渲染在正文上方 ——
 *    "确认入库的是当前这份"在**点按钮之前**就写在脸上。
 * 2. **可渲染、可验证**：`DraftBanner.tsx` 里带 `createPortal`/`useState`，在 `node --test`
 *    与 headless 浏览器里都渲染不了；这一层是纯展示（只依赖 React + MarkdownText），
 *    于是能进 `tsconfig.build.json` 白名单，被真组件渲染与真样式浏览器 harness 断言到
 *    （同 `KnowledgeList.tsx` / `IdeaCardGrid.tsx` 的做法）。
 *
 * 提示文案**不在**这里拼：它来自 `shared/knowledgeDraftOverwrite.ts`，
 * 与工具回执共用同一份口径（"同一语义只算一次"）。
 */
import { MarkdownText } from './MarkdownText.js'
import { knowledgeDraftOverwriteNotice } from '../../shared/knowledgeDraftOverwrite.js'

export interface KnowledgeDraftBodyProps {
  /** 草稿 id：提示里要带上它，用户才能在会话与界面之间对上同一份草稿。 */
  draftId: string
  payload: Record<string, unknown>
}

export function KnowledgeDraftBody({ draftId, payload }: KnowledgeDraftBodyProps): JSX.Element {
  const tags = Array.isArray(payload.tags) ? payload.tags as string[] : []
  const contentMd = String(payload.contentMd ?? '')
  const notice = knowledgeDraftOverwriteNotice(payload, draftId)
  return (
    <>
      {notice !== null && (
        <div
          className="wb-draft-overwrite-notice"
          style={{
            fontSize: 12,
            lineHeight: 1.6,
            marginBottom: 8,
            padding: '6px 8px',
            borderRadius: 6,
            // 配色沿用既有警示横幅口径（`.wb-banner.completion` 用的 #f5b83d）。
            // 文字用 inherit：弹窗自身已有主题化的正文色，写死颜色会在另一套主题下失去对比度。
            color: 'inherit',
            background: 'color-mix(in srgb, #f5b83d 14%, transparent)',
            borderLeft: '3px solid #f5b83d',
          }}
        >
          {notice}
        </div>
      )}
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{String(payload.title ?? '')}</div>
      {tags.length > 0 && <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 }}>{tags.map((tag) => `#${tag}`).join(' ')}</div>}
      {typeof payload.fileLink === 'string' && payload.fileLink !== '' && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6, wordBreak: 'break-all' }}>📎 {payload.fileLink}</div>
      )}
      {typeof payload.sourceTaskId === 'string' && payload.sourceTaskId !== '' && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 }}>关联任务：{payload.sourceTaskId.slice(0, 8)}</div>
      )}
      <MarkdownText text={contentMd} />
    </>
  )
}
