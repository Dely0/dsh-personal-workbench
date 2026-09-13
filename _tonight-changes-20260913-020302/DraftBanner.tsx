/**
 * 待确认草稿的统一弹窗。
 *
 * 改造前：每个 kindCode 各写一个页面横幅，直接插在文档流里 → 出现即把任务列表挤下去，
 * 且 8 个分支各自重复"标题 + 内容 + 按钮行"的结构。
 * 改造后：每个分支只描述 `{title, body, footer}`，外层统一交给 Modal 渲染。
 *
 * v1.14.0 两处变化：
 * 1. **暂存推广到全部类型** —— 「⏸ 暂存」不再是验收类专属（见 describeDraft 的 canDefer）。
 * 2. **信息量补齐** —— 用户原话「AI 录入任务的弹框信息太简单了，我都不知道 AI 建立的任务
 *    描述是否正确」。task 草稿原先只显示"标题 · 类型 · 优先级"一行，现在展示描述正文、
 *    截止、预估、工作区、AI 策略、子任务清单，并给出「回到会话」入口。
 *    其余每个类型的呈现都过了一遍审计（见 docs/2026-09-12-draft-defer-and-banner-audit.md）。
 */
import { useState, type ReactNode } from 'react'
import { Modal } from './Modal.js'
import { MarkdownText } from './MarkdownText.js'
import { api } from '../api.js'
import { fmtTime } from '../format.js'
import type { DraftConfirmProblemView, DraftView } from '../../shared/contracts.js'

export interface DraftBannerRuntime {
  sessions: { open: (sessionId: string) => void }
}

export interface DraftBannerProps {
  draft: DraftView
  onDone: () => void
  runtime: DraftBannerRuntime
  closePanel: () => void
  kindName: (kind: string, code: string) => string
  /**
   * 右上角 X / Esc / 点遮罩：**收起这条横幅**，不代表放弃草稿。
   *
   * 与 `onDone` 分开是因为语义不同：`onDone` 表示"这条处理完了"（确认/放弃成功），
   * 而 `onClose` 只表示"先别挡着我"。两者都必须让外层**屏蔽这个 id**，
   * 否则 5 秒轮询会把同一份草稿重新推上来（2026-09-12 实测的"关闭后又弹出"）。
   */
  onClose?: () => void
  /**
   * 确认接口回传的「本该创建但没创建」条目（见 DraftItemProblem）。
   * 有值且非空时，由外层用 toast/横幅标黄展示 —— 绝不静默丢件。
   */
  onProblems?: (problems: DraftConfirmProblemView[]) => void
  /** 确认后的补充提示（例如"复盘已写入团队记忆 2 条"/"记忆库不可达，本地已留档待补传"）。 */
  onNotice?: (message: string, tone: 'success' | 'warning') => void
  /**
   * 这份草稿已经被"处理过"了（确认 / 放弃 / 存在性已被服务端终结）。
   *
   * 与 `onDone` 的区别：`onDone` 只表示"UI 可以收起来了"，而这个是告诉外层
   * **把这份草稿 id 屏蔽掉，别再显示**。5 秒轮询是独立的数据源，
   * 少了这一步就会出现"关掉 5 秒后又弹出来"（2026-09-12 实测 BUG）。
   */
  onDismissed?: () => void
  /**
   * 「暂存」成功（v1.14.5）。
   *
   * **必须与 `onDismissed` 分开**：暂存把草稿交给后端的 deferred 列表，
   * 前台还要继续在「待处理 → 已暂存」里展示它。如果沿用 `onDismissed`，
   * 外层会把这个 id 记进屏蔽集合（那是给确认/放弃用的），
   * 而屏蔽集合又会过滤轮询返回的 `deferredDrafts` ——
   * 结果就是**刚暂存完，列表里却看不到它**，必须切到别的会话再回来才出现
   * （2026-09-12 实测 BUG）。所以暂存走这条独立回调：隐藏待确认横幅，但不屏蔽 id。
   */
  onDeferred?: () => void
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
  /** 是否提供「暂存」操作。v1.14.0 起默认 true（所有草稿类型都可暂存）。 */
  canDefer?: boolean
  /** 「暂存」按钮文案；缺省按类型给。 */
  deferLabel?: string
  /** 暂存按钮的 title 提示。 */
  deferHint?: string
}

/** 通用的「暂存」默认文案（不再是验收类专属措辞）。 */
const DEFER_LABEL = '⏸ 暂存'
const DEFER_HINT = '先收起这份草稿去做别的事（例如去 DSH 里核对），之后再从「待处理 → 已暂存」唤回'

/** 键值行：弹框里展示"一个字段 = 一个值"的统一样式。 */
function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="wb-draft-field">
      <span className="wb-draft-field-k">{label}</span>
      <span className="wb-draft-field-v">{children}</span>
    </div>
  )
}

/** 时间展示：空值显示「（继承父任务）」，避免看起来像丢了数据。 */
function dueText(value: unknown): string {
  if (typeof value !== 'string' || value === '') return ''
  const formatted = fmtTime(value)
  return formatted === '' ? value : formatted
}

function minutesText(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (value < 60) return `${value} 分钟`
  const hours = Math.floor(value / 60)
  const rest = value % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
}

/** 子任务清单（可含一层 children），用于 task / subtask_plan 草稿。 */
function SubtaskList({ items, depth = 0 }: { items: Array<Record<string, unknown>>; depth?: number }): JSX.Element {
  return (
    <>
      {items.map((item, i) => (
        <div key={i} style={{ marginLeft: depth === 0 ? 0 : 14, margin: '3px 0' }}>
          <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{depth === 0 ? '•' : '◦'}</span>{' '}
          <b>{String(item.title ?? '(未命名)')}</b>
          {typeof item.estimated_minutes === 'number' && <span style={{ color: 'var(--dsw-alias-label-secondary)' }}> · {minutesText(item.estimated_minutes)}</span>}
          {typeof item.estimatedMinutes === 'number' && <span style={{ color: 'var(--dsw-alias-label-secondary)' }}> · {minutesText(item.estimatedMinutes)}</span>}
          {typeof item.type_code === 'string' && <span style={{ color: 'var(--dsw-alias-label-secondary)' }}> · {item.type_code}</span>}
          {typeof item.typeCode === 'string' && <span style={{ color: 'var(--dsw-alias-label-secondary)' }}> · {item.typeCode}</span>}
          {typeof item.description === 'string' && item.description !== '' && (
            <div style={{ marginLeft: 12, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap' }}>
              {item.description.length > 160 ? `${item.description.slice(0, 160)}…` : item.description}
            </div>
          )}
          {Array.isArray(item.children) && item.children.length > 0 && (
            <SubtaskList items={item.children as Array<Record<string, unknown>>} depth={depth + 1} />
          )}
        </div>
      ))}
    </>
  )
}

/** 复盘 → 团队记忆的可见性选择器（受控组件，状态留在 DraftBanner 里）。 */
function MemoryScopeField({ enabled, scope, onEnabledChange, onScopeChange, preview }: {
  enabled: boolean
  scope: 'private' | 'team'
  onEnabledChange: (value: boolean) => void
  onScopeChange: (value: 'private' | 'team') => void
  /** 将写入哪些条目的摘要 —— 让"会外发什么"在确认前就可见，不做静默外发。 */
  preview: string
}): JSX.Element {
  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))' }}>
      <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 }}>
        🧠 同步到团队记忆库（默认 private：复盘可能含客户信息，不确定就保持 private 或干脆不同步）
      </div>
      <label style={{ display: 'block', fontSize: 13, margin: '4px 0' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onEnabledChange(e.target.checked)} /> 确认时写入团队记忆库
      </label>
      <label style={{ display: 'block', fontSize: 13, margin: '4px 0', opacity: enabled ? 1 : 0.5 }}>
        可见性：
        <select
          value={scope}
          disabled={!enabled}
          onChange={(e) => onScopeChange(e.target.value === 'team' ? 'team' : 'private')}
          style={{ marginLeft: 6 }}
        >
          <option value="private">private（只有我自己能检索）</option>
          <option value="team">team（团队可见，确认不含客户信息再选）</option>
        </select>
      </label>
      <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 4, lineHeight: 1.7 }}>
        {enabled ? `将写入：${preview}` : '不会写入团队记忆库（只回写任务详情）。'}
      </div>
    </div>
  )
}

/**
 * 复盘草稿将要写入团队记忆的**标题列表**（预览用）。
 *
 * 必须与后端 `src/review-memory.ts` 的 `notesFromReview` 保持同一套拆分口径：
 * 有结构化 lessons → 每条一条；没有 → 整篇复盘一条。
 * 这里只做"给用户看"的近似（不拼回链、不落盘），所以允许独立实现；
 * 但**条数**必须一致，否则确认前提示的条数会对不上实际写入数。
 */
export function reviewMemoryNotes(payload: Record<string, unknown>): string[] {
  const lessons = Array.isArray(payload.lessons)
    ? payload.lessons.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    : []
  if (lessons.length === 0) {
    const summary = String(payload.summaryMd ?? '').trim()
    return summary === '' ? [] : ['复盘正文（1 条）']
  }
  return lessons.map((lesson, index) => (
    typeof lesson.title === 'string' && lesson.title.trim() !== '' ? lesson.title.trim() : `复盘教训 ${index + 1}`
  ))
}

export function DraftBanner({ draft, onDone, runtime, closePanel, kindName, onProblems, onNotice, onDismissed, onDeferred, onClose }: DraftBannerProps): ReactNode {
  const [busy, setBusy] = useState(false)
  /**
   * 复盘的团队记忆可见性（v1.14.0：复盘确认时自动写入团队记忆库）。
   * 默认 private —— 复盘里可能混有客户信息，宁可漏共享不可误共享。
   */
  const [memoryScope, setMemoryScope] = useState<'private' | 'team'>('private')
  const [memoryEnabled, setMemoryEnabled] = useState(true)
  /**
   * 复盘的记忆写入预览：与后端 `notesFromReview` 同一套拆分口径
   * （有结构化教训 → 每条一条；没有 → 整篇复盘一条）。
   * 它同时用于确认前的"将写入什么"提示，和确认后的条数校验。
   */
  const memoryNotes = draft.kindCode === 'review' ? reviewMemoryNotes(draft.payload) : []
  const memoryPreview = memoryNotes.length === 0
    ? '（复盘正文为空，不会写入任何条目）'
    : `${memoryNotes.length} 条` + `（${memoryNotes.slice(0, 3).map((title) => `「${title}」`).join('、')}${memoryNotes.length > 3 ? ` 等 ${memoryNotes.length} 条` : ''}）`
  const act = async (path: string, body?: Record<string, unknown>, action?: 'defer'): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api<{ problems?: DraftConfirmProblemView[]; memory?: { written?: number; skipped?: number; degradedReason?: string; enabled?: boolean } }>(path, {
        method: 'POST',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      // 「本该创建但没创建」的条目必须让用户看见（2026-09-12 静默丢件事故的界面侧防线）。
      if (Array.isArray(res?.problems) && res.problems.length > 0) onProblems?.(res.problems)
      // 团队记忆写入结果也要可见：否则用户不知道"到底共享出去没有"。
      const memory = res?.memory
      if (memory !== undefined && memory.enabled !== false) {
        const written = memory.written ?? 0
        const skipped = memory.skipped ?? 0
        if (typeof memory.degradedReason === 'string' && memory.degradedReason !== '') {
          onNotice?.(`复盘已写回任务；团队记忆降级写入（${memory.degradedReason}）`, 'warning')
        } else if (written > 0) {
          onNotice?.(`复盘已写回任务，并写入团队记忆 ${written} 条（private/team 见复盘设置）`, 'success')
        } else if (skipped > 0) {
          onNotice?.(`复盘已写回任务；这 ${skipped} 条此前已写入过团队记忆，未重复写入`, 'success')
        }
      }
      // 暂存走独立收尾（见 onDeferred 的说明）：不屏蔽 id，草稿要继续出现在「已暂存」里。
      if (action === 'defer') { onDeferred?.(); onDone() }
      else { onDismissed?.(); onDone() }
    } catch (error) {
      /**
       * 失败路径也必须把弹框**收掉**（2026-09-12 实测 BUG 的直接修复）。
       *
       * 旧实现只在成功时 `onDone()`，失败时抛出的 promise 连 catch 都没有
       * （控制台里一条条 `Uncaught (in promise) Error: draft is already abandoned`），
       * 弹框留在原地 → 5 秒轮询又把同一份草稿送回来 → 用户看到"关掉 5 秒后又弹出"。
       *
       * 另外，并发点击会打出多个请求：第一个成功后草稿已不是 pending，
       * 后续请求全部 400。所以"草稿已不是 pending"这类不能再当作错误 ——
       * 服务端状态正是用户想要的结果，收掉弹框并让外层按 id 屏蔽即可。
       */
      const message = error instanceof Error ? error.message : String(error)
      const alreadySettled = /already (abandoned|confirmed)|is not pending|not found/i.test(message)
      if (!alreadySettled) onNotice?.(`操作失败：${message}`, 'warning')
      // 与成功路径同理：暂存失败也要走独立收尾，别把 id 记进屏蔽集合。
      if (action === 'defer') { onDeferred?.(); onDone() }
      else { onDismissed?.(); onDone() }
    } finally { setBusy(false) }
  }
  const presentation = describeDraft(draft, kindName)
  /**
   * 「回到…会话」：切到那个会话，并把这条横幅收起来。
   *
   * 三个必须按顺序做对的地方（2026-09-12 实测"点了没反应"）：
   * 1. **先开会话、再关面板** —— 关面板会卸载本面板所在的 React 树，
   *    顺序反了后面的调用就落在已拆掉的组件上；
   * 2. **每一步都独立 try/catch** —— 宿主会话接口在其它插件下面可能抛错，
   *    不能因为第一步失败就完全没反应；收横幅这件事无论如何都要完成；
   * 3. **收横幅时必须登记 id** —— 否则 5 秒轮询立刻把它推回来，
   *    看起来就像"什么都没发生"。
   */
  const openSession = (): void => {
    if (presentation.sessionId === '') {
      onNotice?.('这份草稿没有关联会话（可能是手动创建的），无法跳回。', 'warning')
      return
    }
    let failure = ''
    try {
      runtime.sessions.open(presentation.sessionId)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    // 无论跳转成功与否都要收掉横幅（并登记 id），否则用户会以为点击无效。
    onDismissed?.()
    onClose?.()
    if (failure !== '') onNotice?.(`切换会话失败：${failure}`, 'warning')
  }
  const canDefer = presentation.canDefer !== false
  const deferBody = draft.kindCode === 'review'
    ? { note: `memoryScope=${memoryScope}, memoryEnabled=${memoryEnabled}` }
    : undefined

  return (
    <Modal
      title={presentation.title}
      size="md"
      onClose={() => { onDismissed?.(); (onClose ?? onDone)() }}
      footer={(
        <>
          <button
            className="wb-btn primary"
            disabled={busy}
            onClick={() => void act(
              `/api/workbench/drafts/${draft.id}/confirm`,
              draft.kindCode === 'review' ? { memoryScope, memoryEnabled } : undefined,
            )}
          >
            {presentation.confirmLabel}
          </button>
          {canDefer && (
            <button className="wb-btn" disabled={busy} title={presentation.deferHint ?? DEFER_HINT} onClick={() => void act(`/api/workbench/drafts/${draft.id}/defer`, deferBody, 'defer')}>
              {presentation.deferLabel ?? DEFER_LABEL}
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
        {/* 复盘：团队记忆可见性选择器（受控，状态在本组件） */}
        {draft.kindCode === 'review' && (
          <MemoryScopeField
            enabled={memoryEnabled}
            scope={memoryScope}
            onEnabledChange={setMemoryEnabled}
            onScopeChange={setMemoryScope}
            preview={memoryPreview}
          />
        )}
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
          {clusters.length === 0 && <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>（该提案没有任何点子，确认后不会创建点子王）</div>}
        </>
      ),
      confirmLabel: '确认生成点子王',
      abandonLabel: '放弃',
      sessionLabel: '回到关联会话',
      sessionId: sessionOf(),
      deferLabel: DEFER_LABEL,
    }
  }

  if (draft.kindCode === 'idea_tasks') {
    const tasks = Array.isArray(payload.tasks) ? payload.tasks as Array<{ title?: string; description?: string }> : []
    const summary = String(payload.summary ?? '')
    const sourceClusterId = typeof payload.sourceClusterId === 'string' ? payload.sourceClusterId : ''
    const sourceIdeaIds = Array.isArray(payload.sourceIdeaIds) ? payload.sourceIdeaIds as string[] : []
    return {
      title: <>🚀 点子落地任务提案（{tasks.length}）</>,
      body: (
        <>
          {summary !== '' && <div style={{ fontSize: 13, marginBottom: 6 }}>{summary}</div>}
          {(sourceClusterId !== '' || sourceIdeaIds.length > 0) && (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 }}>
              来源：{sourceClusterId !== '' ? `点子王 ${sourceClusterId.slice(0, 8)}` : ''}
              {sourceIdeaIds.length > 0 ? ` · ${sourceIdeaIds.length} 个点子` : ''}
            </div>
          )}
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
          {tasks.length === 0 && <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>（没有任何任务，确认后不会创建）</div>}
        </>
      ),
      confirmLabel: '确认转为任务',
      abandonLabel: '放弃',
      sessionLabel: '回到头脑风暴会话',
      sessionId: sessionOf(),
      deferLabel: DEFER_LABEL,
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
          {typeof payload.sourceTaskId === 'string' && payload.sourceTaskId !== '' && (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 }}>关联任务：{payload.sourceTaskId.slice(0, 8)}</div>
          )}
          <MarkdownText text={contentMd} />
        </>
      ),
      confirmLabel: '确认入库',
      abandonLabel: '放弃',
      sessionLabel: '回到会话',
      sessionId: sessionOf(),
      deferLabel: DEFER_LABEL,
    }
  }

  if (draft.kindCode === 'report') {
    const period = payload.periodCode === 'week' ? '周报' : '日报'
    const stats = typeof payload.stats === 'object' && payload.stats !== null ? payload.stats as Record<string, unknown> : undefined
    return {
      title: <>📄 报告草稿待确认（{period} {String(payload.periodStart ?? '')}）</>,
      body: (
        <>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{String(payload.title ?? '')}</div>
          {stats !== undefined && (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 }}>
              统计：{Object.entries(stats).filter(([, v]) => typeof v === 'number' || typeof v === 'string').map(([k, v]) => `${k}=${String(v)}`).join(' · ') || '（无）'}
            </div>
          )}
          <MarkdownText text={String(payload.summaryMd ?? '')} />
        </>
      ),
      confirmLabel: '确认保存报告',
      abandonLabel: '放弃',
      sessionLabel: '回到报告会话',
      sessionId: sessionOf(),
      deferLabel: DEFER_LABEL,
    }
  }

  if (draft.kindCode === 'daily_plan') {
    const items = Array.isArray(payload.items) ? payload.items as Array<{ title?: string; note?: string; order?: number }> : []
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
          {items.length === 0 && <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>（当天没有可排的任务，确认后不改变现有计划）</div>}
        </>
      ),
      confirmLabel: '确认应用排序',
      abandonLabel: '放弃',
      sessionLabel: '回到排序会话',
      sessionId: sessionOf(),
      deferLabel: DEFER_LABEL,
    }
  }

  if (draft.kindCode === 'review') {
    const lessons = Array.isArray(payload.lessons) ? payload.lessons as Array<{ title?: string; content?: string }> : []
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
    return {
      title: <>📄 复盘草稿待确认{lessons.length > 0 ? `（${lessons.length} 条教训）` : ''}</>,
      body: (
        <>
          {taskId !== '' && <Field label="任务">{taskId.slice(0, 8)}</Field>}
          {lessons.length > 0 && (
            <div style={{ margin: '6px 0 10px' }}>
              <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 }}>结构化教训（每条会单独写入团队记忆）：</div>
              {lessons.map((lesson, i) => (
                <div key={i} style={{ fontSize: 13, margin: '3px 0' }}>
                  <b>{lesson.title ?? `教训 ${i + 1}`}</b>
                  {lesson.content !== undefined && lesson.content !== '' && (
                    <span style={{ color: 'var(--dsw-alias-label-secondary)' }}> — {String(lesson.content).slice(0, 120)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          <MarkdownText text={String(payload.summaryMd ?? '')} />
        </>
      ),
      confirmLabel: '确认写回任务',
      abandonLabel: '放弃',
      sessionLabel: '回到复盘会话',
      sessionId: sessionOf(),
      canDefer: true,
      deferLabel: '⏸ 暂存（先回看）',
      deferHint: '先把复盘收起来（例如先去回顾任务过程），之后从「待处理 → 已暂存」唤回',
    }
  }

  if (draft.kindCode === 'completion') {
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
    const taskTitle = typeof payload.taskTitle === 'string' ? payload.taskTitle : ''
    return {
      title: <>✅ 执行完成，待你验收</>,
      body: (
        <>
          <Field label="任务">{taskTitle !== '' ? taskTitle : taskId.slice(0, 8)}</Field>
          {taskTitle !== '' && taskId !== '' && <Field label="任务 id">{taskId.slice(0, 8)}</Field>}
          <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap' }}>{String(payload.summary ?? '')}</div>
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
      deferLabel: '⏸ 暂存（先验证）',
      deferHint: '先去做回归测试，草稿保留待确认；之后从「待处理 → 已暂存」唤回',
    }
  }

  // 兜底：task / subtask_plan
  const subtasks = Array.isArray(payload.subtasks) ? payload.subtasks as Array<Record<string, unknown>> : []
  if (draft.kindCode === 'subtask_plan') {
    const parentTaskId = typeof payload.parentTaskId === 'string' ? payload.parentTaskId : ''
    const rationale = String(payload.rationale ?? '')
    return {
      title: <>待确认：子任务提案（{subtasks.length}）</>,
      body: (
        <>
          {parentTaskId !== '' && <Field label="父任务">{parentTaskId.slice(0, 8)}</Field>}
          {rationale !== '' && <div style={{ fontSize: 13, margin: '6px 0', lineHeight: 1.7 }}>拆分思路：{rationale}</div>}
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <SubtaskList items={subtasks} />
          </div>
          {subtasks.length === 0 && <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>（提案为空，确认后不会创建任何子任务）</div>}
        </>
      ),
      confirmLabel: '确认入册',
      abandonLabel: '放弃',
      sessionLabel: '回到拆解会话',
      sessionId: sessionOf(),
      deferLabel: DEFER_LABEL,
    }
  }

  // task 草稿：原先是"标题 · 类型 · 优先级"一行，信息量不足以判断 AI 建得对不对。
  const description = String(payload.description ?? '')
  const due = dueText(payload.dueAt)
  const estimate = minutesText(payload.estimatedMinutes)
  const workspace = typeof payload.workspacePath === 'string' ? payload.workspacePath : ''
  const aiPolicy = String(payload.aiPolicyCode ?? '')
  const allDay = payload.allDay === true
  return {
    title: <>待确认：任务草稿</>,
    body: (
      <>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{String(payload.title ?? '')}</div>
        <Field label="类型 / 优先级">
          {String(payload.typeCode ?? '')} · {String(payload.priorityCode ?? '')}
          {aiPolicy !== '' ? ` · AI 策略 ${aiPolicy}` : ''}
        </Field>
        <Field label="截止">{due === '' ? '（未设置）' : `${due}${allDay ? '（全天）' : ''}`}</Field>
        <Field label="预计耗时">{estimate === '' ? '（未设置）' : estimate}</Field>
        <Field label="工作区">{workspace === '' ? '（跟随父任务/默认工作区）' : workspace}</Field>
        <div style={{ marginTop: 10, fontSize: 13 }}>
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 }}>描述：</div>
          {description.trim() === ''
            ? <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>（无描述）</div>
            : <MarkdownText text={description.length > 2000 ? `${description.slice(0, 2000)}\n\n…（已截断，完整内容以确认后任务详情为准）` : description} />}
        </div>
        {subtasks.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 }}>将同时创建 {subtasks.length} 个子任务：</div>
            <SubtaskList items={subtasks} />
          </div>
        )}
      </>
    ),
    confirmLabel: '确认入册',
    abandonLabel: '放弃',
    sessionLabel: '回到录入会话',
    sessionId: sessionOf(),
    deferLabel: DEFER_LABEL,
  }
}
