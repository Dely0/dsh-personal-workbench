/**
 * `TaskProgress` —— 任务进度的**独立展示/输入组件**（列表、详情、计划行共用同一份）。
 *
 * ## 为什么是独立组件而不是散在三个地方的 JSX
 *
 * requirements §3.2 要求"列表/详情/计划可共用的进度组件"。散着写的结果是
 * 三份"done/cancelled 要不要画"的判定 —— 而本项目已经为"同一语义多处实现"付过
 * 15 小时排查的代价。所以判定全部来自 `taskProgressView()`（纯模块，有单测），
 * 本组件**只渲染**它给出的结果。
 *
 * ## 详情形态是**一行**（2026-10-01 用户报"进度页面太高、把整个详情页撑丑了"）
 *
 * 旧形态把六块竖着堆：标题 / 进度条 / 旁证 / 提示 / 五档按钮 / 输入框，于是详情页里
 * 一个进度卡就占掉大半屏。现在压成一行：
 *
 * ```
 * 进度 [▶───] 75%  子任务 1/2 已完成   [0%][25%][50%][75%][完成任务] [__][保存]
 * ```
 *
 * 两条纪律：
 * - **旁证/黄色提示不再各占一行**，改用 `title`（鼠标悬停可见）—— 信息不丢，高度不涨；
 *   用户明确要求删掉的"100% 不是普通保存值"那段长 tip 直接删除（按钮文案「完成任务」已自解释）。
 * - 列表行仍走 `compact`（本来就是一行，不动）。
 *
 * ## 100 不是普通保存值
 *
 * 五档里的 `100` 标注「完成任务」，点击后走**现有完成任务动作**（`onComplete`），
 * 由调用方展示与当前完成操作同等的级联确认；**不写库内 100**（库里只存 0–99）。
 * 输入框里的整数上限是 99，越界值当场拒绝并给中文原因，不夹取。
 */
import { useState } from 'react'
import { MAX_PROGRESS_PERCENT, checkProgressInput } from '../../shared/taskProgress.js'
import { Icon } from './Icon.js'
import type { TaskProgressView } from '../taskProgressView.js'

/** 五档：0/25/50/75 是显式进度，100 是「完成任务」。 */
export const PROGRESS_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0%' },
  { value: 25, label: '25%' },
  { value: 50, label: '50%' },
  { value: 75, label: '75%' },
  { value: 100, label: '完成任务' },
]

export interface TaskProgressProps {
  view: TaskProgressView
  /** 保存显式进度（0–99）。失败时**必须**把中文原因抛回来，组件负责显示。 */
  onSave?: (percent: number) => Promise<void>
  /** 点「完成任务」：走现有完成任务动作（含级联确认），**不**是写 100。 */
  onComplete?: () => Promise<void>
  /** `compact` = 列表行内的一行小进度；默认是详情页的完整形态（含五档与输入框）。 */
  compact?: boolean
}

export function ProgressBar({ percent }: { percent: number }): JSX.Element {
  return (
    <div className="wb-progress" role="progressbar" aria-valuemin={0} aria-valuemax={MAX_PROGRESS_PERCENT} aria-valuenow={percent}>
      <div className="wb-progress-fill" style={{ width: `${percent}%` }} />
    </div>
  )
}

/** 徽标：待验收 / 待验收（暂存）/ 已完成 / 已取消 / 已归档。 */
export function TaskProgressBadge({ view }: { view: TaskProgressView }): JSX.Element | null {
  if (view.badge === null || view.badgeKind === null) return null
  return <span className={`wb-chip wb-progress-badge ${view.badgeKind}`}>{view.badge}</span>
}

export function TaskProgress({ view, onSave, onComplete, compact = false }: TaskProgressProps): JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canEdit = onSave !== undefined && view.badgeKind === null

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      setDraft('')
    } catch (e) {
      // 失败**保留旧显示**并给中文原因（requirements §4.3：失败保持显示与中文错误）。
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (compact) {
    return (
      <span className="wb-progress-compact" title={view.childLabel ?? undefined}>
        {view.showBar && <ProgressBar percent={view.percent} />}
        {view.showBar && <span className="wb-progress-num">{view.percent}%</span>}
        <TaskProgressBadge view={view} />
      </span>
    )
  }

  /**
   * 停手态（待验收 / 已结束）：不需要输入控件，一行文字说明就够 —— 也别再撑高度。
   */
  const terminalNote = view.badgeKind === 'pending' || view.badgeKind === 'deferred'
    ? '已提交完成验收申请，等待你在工作台验收；通过后才会标记为已完成。'
    : '该任务已结束，不再显示进度。'

  return (
    <div className="wb-card wb-progress-card">
      <div className="wb-progress-row">
        <h4 className="wb-progress-title">进度</h4>
        {view.showBar && (
          <span className="wb-progress-bar-slot">
            <ProgressBar percent={view.percent} />
          </span>
        )}
        {view.showBar && <span className="wb-progress-num">{view.percent}%</span>}
        <TaskProgressBadge view={view} />
        {/* 旁证（子任务 x/y）改悬停可见：信息不丢，高度不涨 */}
        {view.childLabel !== null && (
          <span className="wb-progress-child" title={view.childLabel} aria-label={view.childLabel}>
            <Icon name="subtask" size={12} />
          </span>
        )}
        {view.hint !== null && (
          <span className="wb-progress-hint" title={view.hint} aria-label={view.hint}>
            <Icon name="bell" size={12} />
          </span>
        )}
        {!view.showBar && <span className="wb-progress-note">{terminalNote}</span>}
        {canEdit && (
          <>
            <span className="wb-progress-presets">
              {PROGRESS_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={`wb-btn ${preset.value === 100 ? 'primary' : ''}`}
                  disabled={busy || (preset.value === 100 ? onComplete === undefined : false)}
                  /**
                   * ⚠️ 「100 不是普通保存值」这句话**必须留着**（requirements §3.1 明确要求）。
                   * 用户要求删掉卡片里那段长 tip，但语义不能跟着删 —— 所以搬到按钮的 title：
                   * 不占高度（一行布局保住了），悬停时仍然说清"这一步是完成任务、会提示级联"。
                   */
                  title={preset.value === 100
                    ? '100% 请点这里：这是任务的完成动作（会提示级联完成未完成子任务），不是把 100 存进进度'
                    : `把进度设为 ${preset.value}%`}
                  onClick={() => {
                    if (preset.value === 100) {
                      if (onComplete !== undefined) void run(onComplete)
                      return
                    }
                    void run(() => onSave!(preset.value))
                  }}
                >{preset.label}</button>
              ))}
            </span>
            <form
              className="wb-progress-input"
              onSubmit={(e) => {
                e.preventDefault()
                const check = checkProgressInput(draft.trim() === '' ? Number.NaN : Number(draft))
                if (!check.ok) {
                  // 越界/小数/空值：当场拒绝并回显原因，**不夹取**（夹取是静默改写）。
                  setError(check.reason)
                  return
                }
                void run(() => onSave!(check.value))
              }}
            >
              <input
                inputMode="numeric"
                placeholder={`0–${MAX_PROGRESS_PERCENT}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="进度百分比（0–99）"
              />
              <button className="wb-btn" type="submit" disabled={busy}>保存进度</button>
            </form>
          </>
        )}
      </div>
      {error !== null && <div className="wb-progress-error">{error}</div>}
    </div>
  )
}
