/**
 * 「AI 会话工作区」选择器（2026-10-01，批次2 #2/W01-W02）。
 *
 * 一个组件供**三个入口**共用：快速录入、新建任务、编辑任务。
 * 两种选法并列，正对用户原始诉求（"支持文件夹弹框选择和已有工作区下拉选择两种模式"）：
 *
 * 1. **已有工作区下拉**（真 `<select>`，不是 `<datalist>` 输入提示）——
 *    候选来自 `workspaceCandidates()`（唯一实现），标注「已打开 / 最近 / 默认」；
 * 2. **「浏览…」按钮** → 打开 `LocalDocModal` 的 `dir` 模式（复用同一个弹窗，不复制第二份）；
 * 3. 输入框保留（可以手打任意路径，行为与改动前一致）。
 *
 * 组件**不做判定**：候选集、来源标签、当前选中项都由传入的 props / 纯函数给出
 * （"判定不进组件"是本项目规范第 2 条）。
 */
import type { ReactNode } from 'react'
import {
  candidatePlaceholder, selectedCandidatePath, workspaceCandidateLabel,
  type WorkspaceCandidate,
} from '../workspacePicker.js'

export interface WorkspacePickerProps {
  /** 当前值（路径；空串 = 不指定，走既有继承逻辑）。 */
  value: string
  /** 用户是否动过它 —— 决定来源提示显示"手动指定"还是判定给出的来源。 */
  touched: boolean
  /** 由判定给出的来源说明（`quickWorkspaceSourceLabel`）。 */
  sourceLabel: string
  candidates: readonly WorkspaceCandidate[]
  disabled?: boolean
  /** 浏览弹窗不可用时的原因（宿主/路由缺失）；给了就禁用按钮并显示原因。 */
  browseProblem?: string | null
  placeholder?: string
  /** 用户改路径：下拉选中或手打**都**走这里（两者都是"用户动过"）。 */
  onChange: (path: string) => void
  onBrowse: () => void
  /** 「不再记住上次手动选择」出口；不给就不渲染（新建/编辑入口没有"上次"要忘）。 */
  onForget?: () => void
  showForget?: boolean
}

export function WorkspacePicker({
  value, touched, sourceLabel, candidates, disabled = false, browseProblem = null,
  placeholder = '', onChange, onBrowse, onForget, showForget = false,
}: WorkspacePickerProps): ReactNode {
  const selected = selectedCandidatePath(value, candidates)
  const browseDisabled = disabled || browseProblem !== null
  return (
    <div className="wb-field" data-workspace-picker>
      <span>
        AI 会话工作区
        <span className="wb-field-note">{touched ? '手动指定' : sourceLabel}</span>
      </span>
      <div className="wb-field-row">
        <select
          data-workspace-select
          value={selected}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          title="从已打开的工作区 / 最近手动选择 / 默认工作区里选一个；也可以直接在右边输入任意路径"
        >
          <option value="">{candidatePlaceholder(candidates)}</option>
          {candidates.map((candidate) => (
            <option key={candidate.path} value={candidate.path}>
              {workspaceCandidateLabel(candidate.source)} · {candidate.path}
            </option>
          ))}
        </select>
        <input
          data-workspace-input
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="wb-btn"
          data-workspace-browse
          disabled={browseDisabled}
          title={browseProblem ?? '打开文件夹浏览器，选一个本地目录'}
          onClick={onBrowse}
        >
          浏览…
        </button>
        {showForget && onForget !== undefined && (
          <button
            type="button"
            className="wb-btn"
            data-workspace-forget
            disabled={disabled || String(value ?? '').trim() === ''}
            title={`不再把 ${value} 当作默认工作区（下次打开改用设置里的默认值）`}
            onClick={onForget}
          >
            不再记住
          </button>
        )}
      </div>
      {browseProblem !== null && <span className="wb-hint" role="status">{browseProblem}</span>}
    </div>
  )
}
