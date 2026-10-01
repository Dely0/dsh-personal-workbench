/**
 * 进度域：显式进度的唯一写入口 + 完成验收的共用领域函数。
 *
 * ## 为什么这两件事在同一个文件里
 *
 * ADR 0003 把 `0–99` 与 `100` 定义成**两个值空间**：写 0–99 是"改进度"，
 * 写 100 是"提交完成验收申请"。也就是说**进度入口本身就包含验收入口** ——
 * `workbench_update_progress(100)` 必须与 `workbench_request_completion` 走
 * **同一份**"提交/更新 completion 草稿、历史提示、暂存处理"的实现。
 *
 * 分开写两个文件必然导致两套验收实现（本项目最大的 bug 类别），所以这里刻意合在一处：
 * - `setTaskProgress` —— 0–99 的**唯一**写入口（同值不写事件、不改 updatedAt）；
 * - `submitCompletionDraft` —— 验收草稿的**唯一**提交实现（新旧两个工具共用）；
 * - `listPendingCompletions` —— 列表要的待验收投影（一次查询，不做 N+1）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { checkProgressInput } from '../../shared/taskProgress.js'
import type { PendingCompletionView } from '../../shared/contracts.js'
import { appendEvent } from './task-primitives.js'
import { getTask } from './tasks.js'
import { createDraft, getDeferredDraftForTask, getPendingDraftForTask, updateDraft } from './drafts.js'
import { getDraft, nowIso, parseDraft, type DraftRow, type RawDraftRow } from './shared.js'
import { listTaskEvents } from './status.js'
import type { TaskRow } from '../repo.js'

export type { PendingCompletionView }

export type SetProgressResult =
  | { ok: true; task: TaskRow; changed: boolean; alreadyAt: number }
  | { ok: false; error: string }

/**
 * 设置任务显式进度（`0–99`）。
 *
 * ## 行为契约（requirements §3.1 逐条）
 *
 * | 输入 | 行为 |
 * |---|---|
 * | 任务不存在 | 中文错误，无写入 |
 * | 已归档 / done / cancelled | 拒绝更新；**不重开任务** |
 * | 0–99 且与当前值不同 | 写新值 + 一条 `updated` 事件（before/after、actor） |
 * | 0–99 且与当前值**相同** | 成功返回当前值；**不写事件、不刷新 updatedAt** |
 * | 100 | 拒绝并指路验收路径（调用方负责分流到 `submitCompletionDraft`） |
 * | 其他（字符串/小数/null/越界…） | 中文错误，**无部分写入** |
 *
 * 同值不写事件不是抠门：`updatedAt` 是列表排序与"有没有人动过"的可见信号，
 * 一次无意义的刷新会让用户以为任务被改过（本项目对"同值不写"的既有要求）。
 */
export function setTaskProgress(
  db: DatabaseSync,
  taskId: string,
  rawProgress: unknown,
  actor = 'user',
  at = nowIso(),
  note?: string,
): SetProgressResult {
  const task = getTask(db, taskId)
  if (task === undefined) return { ok: false, error: `错误：任务 ${taskId} 不存在` }
  if (task.archived === 1) return { ok: false, error: `错误：任务「${task.title}」已归档，不能更新进度` }
  if (task.statusCode === 'done' || task.statusCode === 'cancelled') {
    return { ok: false, error: `错误：任务「${task.title}」已是${task.statusCode === 'done' ? '已完成' : '已取消'}状态，不能更新进度（重新打开任务后才能改）` }
  }

  const check = checkProgressInput(rawProgress)
  if (!check.ok) return { ok: false, error: `错误：${check.reason}` }

  if (check.value === task.progressPercent) {
    // 幂等：不写事件、不动 updatedAt，但**回执要给出最终值**（调用方据此回显）。
    return { ok: true, task, changed: false, alreadyAt: check.value }
  }

  db.prepare('UPDATE tasks SET progress_percent = ?, updated_at = ? WHERE id = ?').run(check.value, at, taskId)
  appendEvent(db, taskId, 'updated', {
    before: { progressPercent: task.progressPercent },
    after: { progressPercent: check.value },
    actor,
    at,
    note: note !== undefined && note.trim() !== '' ? note.trim() : `进度 ${task.progressPercent}% → ${check.value}%`,
  })
  return { ok: true, task: getTask(db, taskId) ?? task, changed: true, alreadyAt: check.value }
}

export interface SubmitCompletionResult {
  draftId: string
  /** 这次是**更新**已有 pending 草稿，还是新建（回执文案要用不同的字眼）。 */
  updated: boolean
  /** 提交历史提示（第几次提交、此前被驳回/暂存几次）；AI 不必等用户口头转述。 */
  history: string
  /** 该任务是否已有一份暂存中的验收申请（非空时要提醒 AI 别重复催促）。 */
  deferredAt: string | null
}

export type SubmitCompletionOutcome = { ok: true; result: SubmitCompletionResult } | { ok: false; error: string }

/**
 * 提交/更新完成验收草稿 —— **唯一**的验收提交实现。
 *
 * `workbench_request_completion`（旧工具，summary 可选）与
 * `workbench_update_progress(progress=100)`（新工具，summary 必填）
 * 都调用它；两者只在**入参校验**上不同（是否要求 summary），
 * 草稿写入、历史提示、暂存识别完全共用一处。
 *
 * @param requireSummary - 新工具的 100 分支要求非空 summary；旧工具保持 summary 可选的既有行为。
 */
export function submitCompletionDraft(
  db: DatabaseSync,
  input: { taskId: string; summary: string; feedback?: string; sessionId: string | null; requireSummary: boolean },
  at = nowIso(),
): SubmitCompletionOutcome {
  const task = getTask(db, input.taskId)
  if (task === undefined) return { ok: false, error: `错误：任务 ${input.taskId} 不存在` }
  if (task.archived === 1) return { ok: false, error: `错误：任务「${task.title}」已归档` }
  if (task.statusCode === 'done') return { ok: false, error: `任务「${task.title}」已经是已完成状态` }
  if (task.statusCode === 'cancelled') return { ok: false, error: `错误：任务「${task.title}」已取消，不能提交完成验收` }
  if (task.aiPolicyCode !== 'execute') return { ok: false, error: `错误：任务「${task.title}」的 AI 策略不是“可执行”，不能申请完成` }

  const summary = input.summary.trim()
  if (input.requireSummary && summary === '') {
    return { ok: false, error: '错误：progress=100 表示提交完成验收，必须同时提供 summary（2–4 句完成总结），不会把 100 写进进度' }
  }
  const feedback = (input.feedback ?? '').trim()

  const existing = getPendingDraftForTask(db, 'completion', input.taskId)
  const payload = { taskId: input.taskId, summary, sessionId: input.sessionId, ...(feedback === '' ? {} : { feedback }) }
  const draft = existing !== undefined
    ? updateDraft(db, existing.id, payload, at)
    : createDraft(db, { kindCode: 'completion', sessionId: input.sessionId, payload }, at)
  if (draft === undefined) return { ok: false, error: '错误：提交完成验收草稿失败' }

  // 提交历史：驳回/暂存次数与最近一次原因，让 AI 不必等用户口头转述就知道自己处于第几次提交。
  const events = listTaskEvents(db, input.taskId).filter((event) => event.event_code === 'completion_rejected' || event.event_code === 'completion_deferred')
  const rejected = events.filter((event) => event.event_code === 'completion_rejected').length
  const deferred = events.filter((event) => event.event_code === 'completion_deferred').length
  const history = events.length === 0
    ? '本次是该任务的第 1 次验收提交。'
    : `本次是第 ${events.length + 1} 次验收提交（此前被驳回 ${rejected} 次、暂存 ${deferred} 次）。最近一次：${String(events[0]?.note ?? '')}`
  const deferredNow = getDeferredDraftForTask(db, 'completion', input.taskId)
  return {
    ok: true,
    result: {
      draftId: draft.id,
      updated: existing !== undefined,
      history,
      deferredAt: deferredNow?.deferredAt ?? null,
    },
  }
}

/**
 * 「待验收」投影：**一次**查询出所有 pending completion 草稿。
 *
 * requirements §3.2 明令"不能对每个任务逐行发请求查草稿"。
 * 暂存态（`deferredAt` 非空）**仍然算待验收** —— 它只是不自动弹窗，语义没变；
 * 被驳回的草稿状态是 `abandoned`，不在 pending 集合里，自然没有徽标。
 */
export function listPendingCompletions(db: DatabaseSync): PendingCompletionView {
  const rows = db.prepare(
    "SELECT * FROM task_drafts WHERE kind_code = 'completion' AND status_code = 'pending' ORDER BY updated_at DESC",
  ).all() as unknown as RawDraftRow[]
  const items: PendingCompletionView['items'] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const draft: DraftRow | undefined = parseDraft(row)
    if (draft === undefined) continue
    const taskId = typeof draft.payload.taskId === 'string' ? draft.payload.taskId : ''
    if (taskId === '' || seen.has(taskId)) continue
    seen.add(taskId)
    items.push({
      taskId,
      draftId: draft.id,
      deferred: draft.deferredAt !== null,
      summary: typeof draft.payload.summary === 'string' ? draft.payload.summary : '',
      updatedAt: draft.updatedAt,
    })
  }
  return { available: true, items }
}

/** 单任务的待验收状态（详情页用；`available` 与列表投影同义）。 */
export function getTaskPendingCompletion(db: DatabaseSync, taskId: string): { deferred: boolean } | undefined {
  const draft = getPendingDraftForTask(db, 'completion', taskId)
  if (draft === undefined) return undefined
  return { deferred: draft.deferredAt !== null }
}

/** 详情页/测试用：读一份草稿（避免调用方各自 import draft 原语）。 */
export function readDraft(db: DatabaseSync, draftId: string): DraftRow | undefined {
  return getDraft(db, draftId)
}
