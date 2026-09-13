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

/**
 * 任务草稿确认后，服务端回传的「库里另有一条同名任务」告警。
 *
 * 为什么要有它（2026-09-13 真实事故）：快速录入的草稿建出任务 A 之后，
 * AI 执行会话又提交了一份同内容草稿并同样被确认 → 「待处理」里冒出一条同名任务。
 * 服务端现在**只告警、不静默合并**（同名任务可能是正当需求），界面负责把这条告警
 * 摆到用户面前，并给一个「就用已有那条」的出口。
 */
export interface DuplicateTaskWarning {
  /** 库里已经存在的那条任务的 id。 */
  id: string
  title: string
  statusCode: string
  createdAt: string
  /** 描述是否与本次草稿逐字相同（相同 ≈ 重复提交，不同 ≈ 两次独立录入）。 */
  sameDescription: boolean
  sameWorkspace: boolean
}

export interface DraftConfirmOutcome {
  duplicateOf?: DuplicateTaskWarning
  /** 本次确认**没有建新东西**，返回的是先前那次确认的产出。 */
  replayed?: boolean
  /** 本次确认复用了已存在的同名任务（用户在告警里选了"就用已有那条"）。 */
  reused?: boolean
  /** 本次确认对应的任务 id（用于「就用已有那条」时重新绑定的收口）。 */
  taskId?: string
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
   * 确认接口的业务回执（同名任务告警 / 回放 / 复用）。
   *
   * 与 `onNotice`（纯文案 toast）分开：这条要带**动作**（"就用已有那条"），
   * 外层需要 structured 数据来决定弹什么。
   */
  onConfirmed?: (outcome: DraftConfirmOutcome) => void
  /**
   * 「就用已有那条」：带着 dedupe 意图重新确认同一条草稿。
   *
   * 服务端会把库里那条同名任务当作本次产出（草稿照样收口），**不再新建**。
   */
  onReuseExisting?: (draft: DraftView, taskId: string) => void
  /**
   * **把这份草稿从当前投影里立刻拿掉**（只改本地状态，不触发任何网络刷新）。
   *
   * 与 `onDone` 的分工（2026-09-13 实测 BUG 的修法）：
   *
   * - `onSettled` = 纯投影更新：用户做了个动作，横幅必须**同一帧**消失。
   *   否则"关闭"要等到下一轮 5 秒轮询才被覆盖 —— 用户看到的是"点了没反应，
   *   过一会儿才消失"，读不出自己这一下生效没有。
   * - `onDone` = 投影更新 **+ 数据刷新**：确认/放弃/暂存改动了服务端数据，
   *   需要顺带刷新计划、报告、知识库、点子等工作台数据。
   *
   * 需要"立刻收掉但不必刷新数据"的路径（点「回到…会话」）只调 `onSettled`。
   */
  onSettled?: () => void
  /**
   * 这份弹框是**递补上来**的：上一份草稿被收起后，服务端把另一种类型的草稿推了上来。
   *
   * 必须显式告诉用户（2026-09-13 重复建单事故）：弹框长得一模一样，用户以为还在处理
   * 刚才那份，其实已经是另一份了 —— 接着点主按钮就会确认错东西。
   */
  switchedFrom?: { kindCode: string }
  /**
   * **团队记忆能力**（v1.14.58）：只有 `true` 才渲染「🧠 同步到团队记忆库」整块。
   *
   * 团队记忆是**公司内部系统**、不会开源 —— 开源用户没有 `dsh-team-memory` 插件与内网服务。
   * 拿不到能力时**整块不渲染**（不是置灰：置灰仍会把内部系统的名词摆给开源用户，
   * 而那是一个永远用不了的勾选框，纯噪音）。
   *
   * 缺省按 `false` 处理：宁可不显示，也不要显示一个点了没用的东西。
   * 值来自 `GET /api/workbench/bootstrap` 的 `memoryAvailable`（判据在服务端：
   * `~/.dsh/memory` 是否存在，或 `DSH_MEMORY_HOME` / `TEAM_MEMORY_HOME` 显式声明）。
   */
  memoryAvailable?: boolean
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

export function DraftBanner({ draft, onDone, runtime, closePanel, kindName, onProblems, onNotice, onDismissed, onClose, onConfirmed, onSettled, switchedFrom, memoryAvailable = false }: DraftBannerProps): ReactNode {
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
  const act = async (path: string, body?: Record<string, unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api<{
        problems?: DraftConfirmProblemView[]
        memory?: { written?: number; skipped?: number; degradedReason?: string; enabled?: boolean }
        task?: { id?: string }
        duplicateOf?: DuplicateTaskWarning
        replayed?: boolean
        reused?: boolean
      }>(path, {
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
      /**
       * 业务回执交给外层（同名任务告警 / 回放 / 复用）。
       *
       * 三种回执都要说清楚，否则用户会遇到"点了确认，但界面什么也没说"：
       * - `duplicateOf`：库里另有一条同名任务 → 外层弹选择（保留两条 / 就用已有那条）；
       * - `replayed`：这条草稿之前已经确认过 → 说明"没有重复建单"；
       * - `reused`：用户选了复用 → 说明"已按已有那条收口，没有新建"。
       */
      if (res !== null && typeof res === 'object') {
        onConfirmed?.({
          ...(res.duplicateOf === undefined ? {} : { duplicateOf: res.duplicateOf }),
          ...(res.replayed === true ? { replayed: true } : {}),
          ...(res.reused === true ? { reused: true } : {}),
          ...(typeof res.task?.id === 'string' ? { taskId: res.task.id } : {}),
        })
      }
      onDismissed?.()
      onDone()

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
      onDismissed?.()
      onDone()

    } finally { setBusy(false) }
  }
  const presentation = describeDraft(draft, kindName)
  /**
   * 「回到…会话」：切到那个会话，并把这条横幅收起来。
   *
   * 顺序与时机都很关键（2026-09-15 用户实测"只会让弹框消失，不会真的回到会话"）：
   *
   * 1. **先在当前事件里发起会话切换**（`sessions.open`）；
   * 2. **面板收起放到下一个宏任务**（`setTimeout(0)`）—— 收起面板会触发
   *    `layout.selectPanel(null)`，宿主随即卸载/重排视图；如果在同一个事件里
   *    既切会话又切面板，宿主的会话切换会被紧随其后的面板切换打断
   *    （表现：弹框没了，但界面还停在工作台）；
   * 3. **收横幅（登记 id）放在最后**，且失败也要做 —— 否则 5 秒轮询又推回来，
   *    用户会以为"什么都没发生"。
   */
  /**
   * 「回到…会话」：切到那个会话，并**立刻**把这条横幅收起来。
   *
   * ## 顺序很关键（2026-09-15 用户实测"只会让弹框消失，不会真的回到会话"）
   *
   * 1. **先在当前事件里发起会话切换**（`sessions.open`）；
   * 2. **收横幅放在最后**，且失败也要做 —— 否则轮询又把它推回来，
   *    用户会以为"什么都没发生"。
   *
   * ## 为什么不能再"延迟收起"（2026-09-13 用户实测 BUG）
   *
   * 旧实现把 `closePanel()` 放进 `setTimeout(0)` —— 本意是"别打断宿主的会话切换"，
   * 但副作用是**收横幅也跟着被推迟**：用户看到的是"点了回到会话，过了好一会儿
   * 弹框才消失"（实测是 5 秒，正好等于 `setPendingDraft` 被下一轮 5 秒轮询覆盖的时刻）。
   *
   * 更根本的问题是**两件事被绑在了一起**：
   *
   * - **收横幅**（`onDismissed` / `onDone`）：纯本地状态，必须**同一帧**生效，
   *   否则用户读不出"我这一下到底生效没有"；
   * - **收面板**（`closePanel()`）：要避让宿主的视图切换，需要延后。
   *
   * 现在把它们拆开：横幅立刻收（本函数内同步完成），面板仍在下一个宏任务里收。
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
    // ① 横幅：立刻消失（登记屏蔽 + 清投影；不触发任何网络刷新）
    onDismissed?.()
    onSettled?.()
    // ② 面板：让宿主的会话切换先落地，再收面板（顺序反了会把切换打断）
    window.setTimeout(() => {
      try { closePanel() } catch { /* 面板收起失败不影响跳转 */ }
    }, 0)
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
      /**
       * **非模态**（v1.14.16）：待确认草稿是"待办通知"，不是"必须立刻回答的问题"。
       *
       * 用全屏遮罩时用户被钉死：点任何地方都先打在遮罩上 —— 点侧栏「工作台」
       * 只会把弹框关掉、面板根本不开（2026-09-15 实测）。改成右下角浮卡后，
       * 一边挂着草稿一边正常操作 DSH，不必先"暂存"。
       */
      nonModal
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
            <button className="wb-btn" disabled={busy} title={presentation.deferHint ?? DEFER_HINT} onClick={() => void act(`/api/workbench/drafts/${draft.id}/defer`, deferBody)}>
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
        {/**
          * 「这份弹框是刚递补上来的」提示（2026-09-13 重复建单事故）。
          *
          * 事故形态：用户点「暂存」收起验收申请后，服务端按"最新活动草稿"把**一份 task 草稿**
          * 递补到同一个弹框里；用户接着点主按钮，确认的已经不是他以为的那一份 ——
          * 结果库里多出一条同名任务。这里不改递补行为（那是 `getLatestActiveDraft` 的语义），
          * 只保证"换人了"这件事一定看得见。
          */}
        {switchedFrom !== undefined && (
          <div
            role="status"
            style={{
              margin: '0 0 10px', padding: '8px 10px', borderRadius: 6,
              background: 'rgba(214,158,46,.12)', border: '1px solid rgba(214,158,46,.45)',
              fontSize: 12.5, lineHeight: 1.6,
            }}
          >
            ⚠️ 这不是刚才那一份：上一份（<b>{switchedFrom.kindCode}</b>）收起后，
            系统把下面这一份递补上来了。请确认内容无误再操作，避免误确认。
          </div>
        )}
        {presentation.body}
        {/* 复盘：团队记忆可见性选择器（受控，状态在本组件）。
            ⚠️ 仅当 `memoryAvailable` 为真才渲染 —— 团队记忆是内部系统（v1.14.58），
            开源用户拿不到服务，渲染它等于摆一个永远用不了的勾选框。 */}
        {draft.kindCode === 'review' && memoryAvailable && (
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
              {/* 这里**不能**提"团队记忆"：这句是无条件渲染的，而团队记忆是内部系统
                  （v1.14.58）—— 开源用户看不到那个功能，看到这个词只会困惑。
                  教训本身会随复盘写进任务的复盘记录，措辞照这个事实写。 */}
              <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 }}>结构化教训（每条会单独记入本次复盘）：</div>
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
