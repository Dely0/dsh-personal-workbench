/**
 * 待确认草稿的统一弹窗。
 *
 * 改造前：每个 kindCode 各写一个页面横幅，直接插在文档流里 → 出现即把任务列表挤下去，
 * 且 8 个分支各自重复"标题 + 内容 + 按钮行"的结构。
 * 改造后：每个分支只描述 `{title, body, footer}`，外层统一交给 Modal 渲染。
 */
import { useState, type ReactNode } from 'react'
import { Modal } from './Modal.js'
import { MarkdownText } from './MarkdownText.js'
import { api } from '../api.js'
import type { DraftView } from '../../shared/contracts.js'

export interface DraftBannerRuntime {
  sessions: { open: (sessionId: string) => void }
}

export interface DraftBannerProps {
  draft: DraftView
  onDone: () => void
  runtime: DraftBannerRuntime
  closePanel: () => void
  kindName: (kind: string, code: string) => string
}

interface DraftPresentation {
  title: ReactNode
  body: ReactNode
  /** 主操作（确认类），默认「确认」 */
  confirmLabel: string
  /** 次操作（放弃类），默认「放弃」 */
  abandonLabel: string
  /** 关联会话按钮文案，null 表示不显示 */
  sessionLabel: string | null
  sessionId: string
  /** 底部补充说明 */
  note?: ReactNode
  /** 是否提供「暂存」操作（验收类草稿：先去验证再决定） */
  canDefer?: boolean
}

export function DraftBanner({ draft, onDone, runtime, closePanel, kindName }: DraftBannerProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const act = async (path: string): Promise<void> => {
    setBusy(true)
    try { await api(path, { method: 'POST' }); onDone() } finally { setBusy(false) }
  }
  const presentation = describeDraft(draft, kindName)
  const openSession = (): void => { closePanel(); runtime.sessions.open(presentation.sessionId) }

  return (
    <Modal
      title={presentation.title}
      size="md"
      onClose={onDone}
      footer={(
        <>
          <button className="wb-btn primary" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/confirm`)}>
            {presentation.confirmLabel}
          </button>
          {presentation.canDefer === true && (
            <button className="wb-btn" disabled={busy} title="先去做回归测试，草稿保留待确认；之后从「待处理」里唤回" onClick={() => void act(`/api/workbench/drafts/${draft.id}/defer`)}>
              ⏸ 暂存（先验证）
            </button>
          )}
          <button className="wb-btn" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/abandon`)}>
            {presentation.abandonLabel}
          </button>
          {presentation.sessionLabel !== null && presentation.sessionId !== '' && (
            <button className="wb-btn" onClick={openSession}>{presentation.sessionLabel}</button>
          )}
        </>
      )}
    >
      <div className="wb-scroll-area">
        {presentation.body}
        {presentation.note !== undefined && (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 8 }}>{presentation.note}</div>
        )}
      </div>
    </Modal>
  )
}

/** 各草稿类型的展示描述（纯函数，便于单测）。 */
function describeDraft(draft: DraftView, kindName: (kind: string, code: string) => string): DraftPresentation {
  const payload = draft.payload
  const sessionOf = (fallbackKey = 'sessionId'): string => (
    typeof draft.sessionId === 'string' && draft.sessionId !== ''
      ? draft.sessionId
      : typeof payload[fallbackKey] === 'string' ? payload[fallbackKey] as string : ''
  )

  if (draft.kindCode === 'idea_cluster') {
    const clusters = Array.isArray(payload.clusters) ? payload.clusters as Array<{ title?: string; summary?: string; idea_titles?: string[] }> : []
    return {
      title: <>🧠 点子王提案待确认（{clusters.length}）</>,
      body: (
        <>
          {clusters.map((cluster, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <b>{cluster.title ?? `点子王 ${i + 1}`}</b>
              {cluster.summary !== undefined && cluster.summary !== '' && (
                <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{cluster.summary}</div>
              )}
              <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
                {(cluster.idea_titles ?? []).map((title) => `• ${title}`).join('  ')}
              </div>
            </div>
          ))}
        </>
      ),
      confirmLabel: '确认生成点子王',
      abandonLabel: '放弃',
      sessionLabel: '回到关联会话',
      sessionId: sessionOf(),
    }
  }

  if (draft.kindCode === 'idea_tasks') {
    const tasks = Array.isArray(payload.tasks) ? payload.tasks as Array<{ title?: string; description?: string }> : []
    const summary = String(payload.summary ?? '')
    return {
      title: <>🚀 点子落地任务提案（{tasks.length}）</>,
      body: (
        <>
          {summary !== '' && <div style={{ fontSize: 13, marginBottom: 6 }}>{summary}</div>}
          <ol style={{ margin: '4px 0 8px 20px', padding: 0, fontSize: 14, lineHeight: 1.7 }}>
            {tasks.map((task, i) => (
              <li key={i} style={{ margin: '3px 0' }}>
                <b>{task.title ?? '(未命名任务)'}</b>
                {task.description !== undefined && task.description !== '' && (
                  <span style={{ color: 'var(--dsw-alias-label-secondary)' }}> — {String(task.description).slice(0, 60)}</span>
                )}
              </li>
            ))}
          </ol>
        </>
      ),
      confirmLabel: '确认转为任务',
      abandonLabel: '放弃',
      sessionLabel: '回到头脑风暴会话',
      sessionId: sessionOf(),
    }
  }

  if (draft.kindCode === 'knowledge') {
    const tags = Array.isArray(payload.tags) ? payload.tags as string[] : []
    const contentMd = String(payload.contentMd ?? '')
    return {
      title: <>💡 知识条目待确认（{kindName('knowledge_kind', String(payload.kindCode ?? 'lesson'))}）</>,
      body: (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{String(payload.title ?? '')}</div>
          {tags.length > 0 && <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 }}>{tags.map((tag) => `#${tag}`).join(' ')}</div>}
          {typeof payload.fileLink === 'string' && payload.fileLink !== '' && (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6, wordBreak: 'break-all' }}>📎 {payload.fileLink}</div>
          )}
          <MarkdownText text={contentMd} />
        </>
      ),
      confirmLabel: '确认入库',
      abandonLabel: '放弃',
      sessionLabel: '回到会话',
      sessionId: sessionOf(),
    }
  }

  if (draft.kindCode === 'report') {
    const period = payload.periodCode === 'week' ? '周报' : '日报'
    return {
      title: <>📄 报告草稿待确认（{period} {String(payload.periodStart ?? '')}）</>,
      body: (
        <>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{String(payload.title ?? '')}</div>
          <MarkdownText text={String(payload.summaryMd ?? '')} />
        </>
      ),
      confirmLabel: '确认保存报告',
      abandonLabel: '放弃',
      sessionLabel: '回到报告会话',
      sessionId: sessionOf(),
    }
  }

  if (draft.kindCode === 'daily_plan') {
    const items = Array.isArray(payload.items) ? payload.items as Array<{ title?: string; note?: string }> : []
    const summary = String(payload.summary ?? '')
    return {
      title: <>✨ 今日计划提案待确认（{String(payload.planDate ?? '')}）</>,
      body: (
        <>
          {summary !== '' && <div style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 6 }}>{summary}</div>}
          <ol style={{ margin: '4px 0 8px 20px', padding: 0, fontSize: 14, lineHeight: 1.7 }}>
            {items.map((item, i) => (
              <li key={i} style={{ margin: '3px 0' }}>
                <b>{item.title ?? '(未命名任务)'}</b>
                {item.note !== undefined && item.note !== '' && (
                  <span style={{ color: 'var(--dsw-alias-label-secondary)' }}> — {item.note}</span>
                )}
              </li>
            ))}
          </ol>
        </>
      ),
      confirmLabel: '确认应用排序',
      abandonLabel: '放弃',
      sessionLabel: '回到排序会话',
      sessionId: sessionOf(),
    }
  }

  if (draft.kindCode === 'review') {
    return {
      title: <>📄 复盘草稿待确认</>,
      body: <MarkdownText text={String(payload.summaryMd ?? '')} />,
      confirmLabel: '确认写回任务',
      abandonLabel: '放弃',
      sessionLabel: '回到复盘会话',
      sessionId: sessionOf(),
      canDefer: true,
    }
  }

  if (draft.kindCode === 'completion') {
    return {
      title: <>✅ 执行完成，待你验收</>,
      body: (
        <>
          <div style={{ fontSize: 13 }}><b>{String(payload.taskId ?? '')}</b></div>
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap' }}>{String(payload.summary ?? '')}</div>
          {typeof payload.feedback === 'string' && payload.feedback !== '' && (
            <div style={{ fontSize: 12, marginTop: 6, color: 'var(--dsw-alias-label-secondary)' }}>上次反馈处理：{String(payload.feedback)}</div>
          )}
        </>
      ),
      confirmLabel: '验收通过（标记完成）',
      abandonLabel: '驳回',
      sessionLabel: '回到执行会话',
      sessionId: sessionOf(),
      note: '驳回后请回到执行会话继续修改，AI 可再次提交验收申请；若你还需要跑回归测试，用「暂存」把这份申请先收起来。',
      canDefer: true,
    }
  }

  // 兜底：task / subtask_plan
  const subtasks = Array.isArray(payload.subtasks) ? payload.subtasks as Array<{ title?: string }> : []
  return {
    title: draft.kindCode === 'subtask_plan' ? <>待确认：子任务提案（{subtasks.length}）</> : <>待确认：任务草稿</>,
    body: draft.kindCode === 'task'
      ? <div style={{ fontSize: 13 }}><b>{String(payload.title ?? '')}</b> · {String(payload.typeCode ?? '')} · {String(payload.priorityCode ?? '')}</div>
      : (
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            {subtasks.slice(0, 12).map((t, i) => <div key={i}>• {t.title ?? '(未命名)'}</div>)}
            {subtasks.length > 12 && <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>…等 {subtasks.length} 条</div>}
          </div>
        ),
    confirmLabel: '确认入册',
    abandonLabel: '放弃',
    sessionLabel: null,
    sessionId: '',
  }
}
