/**
 * Agent 工具：澄清会话写入草稿 / AI 拆解提交提案。
 * 这两个工具只写 task_drafts(pending)，不直接创建正式任务。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { appendEvent, createDraft, getDictionary, getDraft, getPendingDailyPlanDraft, getPendingDraftForTask, getPendingReportDraft, getTask, localDateString, updateDraft, updateTask } from './db/repo.js'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function requireCode(db: DatabaseSync, kind: string, code: unknown, field: string): string {
  if (typeof code !== 'string' || code.trim() === '') throw new Error(`${field} 必填`)
  const entry = getDictionary(db, kind, code)
  if (entry === undefined || entry.active === 0) throw new Error(`${field} 不是有效的 ${kind} code: ${code}`)
  return code
}

function optionalCode(db: DatabaseSync, kind: string, code: unknown, field: string): string | undefined {
  if (code === undefined || code === null || code === '') return undefined
  return requireCode(db, kind, code, field)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export function submitTaskTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_submit_task',
    description:
      '个人工作台澄清工具：把澄清后的任务草稿写入 workbench（task_drafts，状态 pending，等待用户在界面确认）。' +
      '适用于自然语言快速录入和详细表单“启动AI澄清”两个场景。同一会话重复调用且带 draft_id 时更新同一草稿，不重复创建。',
    parameters: {
      draft_id: { type: 'string', description: '已有草稿 id；更新草稿时必传，首次提交不传' },
      title: { type: 'string', required: true, description: '任务标题，简洁、动词开头更好' },
      description: { type: 'string', description: 'Markdown 描述：背景/目标/验收标准/注意事项' },
      type_code: { type: 'string', required: true, description: '任务类型 code，如 client_meeting / code_impl' },
      priority_code: { type: 'string', required: true, description: '优先级 code: p0/p1/p2/p3' },
      status_code: { type: 'string', description: '状态 code，默认 todo' },
      due_at: { type: 'string', description: '截止时间 ISO8601 带时区；全天任务用当天 00:00' },
      all_day: { type: 'boolean', description: '是否全天任务，默认 false' },
      estimated_minutes: { type: 'number', description: '预计耗时（分钟）' },
      ai_policy_code: { type: 'string', description: 'AI 策略 code；V1 只允许 none / consult，默认 consult' },
      reminder_offset_minutes: { type: 'number', description: '截止前多少分钟提醒；缺省按任务类型默认' },
      parent_id: { type: 'string', description: '父任务 id（子任务场景）' },
      workspace_path: { type: 'string', description: '任务 AI 会话使用的具体工作区路径；用户在澄清会话中指定，或留空使用默认工作区' },
      subtasks: { type: 'json', description: '可选：用户明确要求拆解时的简版子任务数组' },
      extra: { type: 'json', description: '附加信息：原始输入、澄清问答摘要等' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { session?: { id?: string; header?: { cwd?: string } } } }) {
      const title = str(args.title)
      if (title === undefined) return '错误：title 必填'
      const typeCode = requireCode(db, 'type', args.type_code, 'type_code')
      const priorityCode = requireCode(db, 'priority', args.priority_code ?? 'p2', 'priority_code')
      const statusCode = optionalCode(db, 'status', args.status_code ?? 'todo', 'status_code') ?? 'todo'
      const aiPolicyCode = optionalCode(db, 'ai_policy', args.ai_policy_code ?? 'consult', 'ai_policy_code') ?? 'consult'
      // V1.5：execute 已开放；澄清会话默认仍建议 consult，除非用户明确要求可执行。
      const dueAt = str(args.due_at) ?? null
      const typeEntry = getDictionary(db, 'type', typeCode)
      const priorityEntry = getDictionary(db, 'priority', priorityCode)
      const typeDefault = typeof typeEntry?.config.defaultReminderMinutes === 'number' ? typeEntry.config.defaultReminderMinutes as number : undefined
      const priorityDefault = typeof priorityEntry?.config.defaultReminderMinutes === 'number' ? priorityEntry.config.defaultReminderMinutes as number : undefined
      const reminderOffset = typeof args.reminder_offset_minutes === 'number'
        ? args.reminder_offset_minutes
        : typeDefault ?? priorityDefault
      const payload: Record<string, unknown> = {
        title,
        description: str(args.description) ?? '',
        typeCode,
        priorityCode,
        statusCode,
        dueAt,
        allDay: args.all_day === true,
        estimatedMinutes: typeof args.estimated_minutes === 'number' ? args.estimated_minutes : null,
        aiPolicyCode,
        reminderOffsetMinutes: reminderOffset ?? null,
        parentId: str(args.parent_id) ?? null,
        workspacePath: str(args.workspace_path) ?? exec.agent?.session?.header?.cwd ?? null,
        subtasks: args.subtasks ?? [],
        extra: args.extra ?? {},
        source: 'nl',
      }

      const draftId = str(args.draft_id)
      const existing = draftId === undefined ? undefined : getDraft(db, draftId)
      if (draftId !== undefined && existing === undefined) return `错误：草稿 ${draftId} 不存在`
      if (existing !== undefined && existing.statusCode !== 'pending') return `错误：草稿 ${draftId} 状态为 ${existing.statusCode}，不能更新`

      const sessionId = exec.agent?.session?.id ?? null
      const draft = draftId !== undefined && existing !== undefined
        ? updateDraft(db, draftId, payload)
        : createDraft(db, { kindCode: 'task', sessionId, payload })
      return `草稿已保存（id=${draft?.id}），等待用户在界面确认。请用一句话告知用户可以检查草稿；不要声称任务已创建。`
    },
  })
}

const PLAN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function proposeDailyPlanTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_propose_daily_plan',
    description:
      '个人工作台每日 AI 智能排序工具：为指定日期生成“今日执行顺序”提案，只写 pending 草稿，由用户在工作台确认后才应用。' +
      'items 为扁平顺序数组（1 号最重要），每项 {task_id, order, note}；note 解释排位理由或建议时间块。' +
      '同一父子链上不要同时列入父任务与其子任务；不要修改任何任务字段，不要执行任务。',
    parameters: {
      draft_id: { type: 'string', description: '已有计划草稿 id；用户提出修改意见后再次提交时传，更新同一份草稿' },
      plan_date: { type: 'string', description: '计划日期 YYYY-MM-DD，默认今天（服务器本地日期）' },
      summary: { type: 'string', required: true, description: '排序思路总结，1-3 句，如“先清逾期，再用上午整块时间做方案”' },
      items: { type: 'json', required: true, description: '排序结果数组，每项 {task_id, order, note}' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { session?: { id?: string } } }) {
      const planDate = str(args.plan_date) ?? localDateString()
      if (!PLAN_DATE_RE.test(planDate)) return '错误：plan_date 必须是 YYYY-MM-DD 格式'
      const summary = str(args.summary)
      if (summary === undefined) return '错误：summary 必填'
      const rawItems = Array.isArray(args.items) ? args.items as unknown[] : []
      if (rawItems.length === 0) return '错误：items 不能为空（若今天没有需要处理的任务，请直接告知用户）'

      const seen = new Set<string>()
      const items: Array<{ taskId: string; order: number; title: string; note: string }> = []
      for (let index = 0; index < rawItems.length; index += 1) {
        const raw = (typeof rawItems[index] === 'object' && rawItems[index] !== null ? rawItems[index] : {}) as Record<string, unknown>
        const taskId = typeof raw.task_id === 'string' ? raw.task_id : typeof raw.taskId === 'string' ? raw.taskId : ''
        const task = getTask(db, taskId)
        if (task === undefined) return `错误：items[${index}] 的 task_id 不存在：${taskId || '(空)'}`
        if (task.archived === 1 || task.statusCode === 'done' || task.statusCode === 'cancelled') {
          return `错误：任务「${task.title}」已归档或已关闭，不能进入今日计划`
        }
        if (seen.has(taskId)) return `错误：任务「${task.title}」在 items 中重复`
        seen.add(taskId)
        items.push({
          taskId,
          order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : index + 1,
          title: task.title,
          note: typeof raw.note === 'string' ? raw.note : '',
        })
      }
      items.sort((a, b) => a.order - b.order)

      const sessionId = exec.agent?.session?.id ?? null
      const draftId = str(args.draft_id)
      const existing = draftId === undefined ? getPendingDailyPlanDraft(db, sessionId, planDate) : getDraft(db, draftId)
      if (draftId !== undefined && existing === undefined) return `错误：草稿 ${draftId} 不存在`
      if (existing !== undefined && existing.statusCode !== 'pending') return `错误：草稿 ${draftId ?? existing.id} 状态为 ${existing.statusCode}，不能更新`

      const payload = { planDate, summary, items, sessionId }
      const draft = existing !== undefined
        ? updateDraft(db, existing.id, payload)
        : createDraft(db, { kindCode: 'daily_plan', sessionId, payload })
      const preview = items.map((item, i) => `${i + 1}. ${item.title}${item.note !== '' ? `（${item.note}）` : ''}`).join('\n')
      return `今日计划提案已保存（id=${draft?.id}），等待用户在工作台确认。\n\n${preview}\n\n请用一句话告知用户可以检查计划草稿；不要声称排序已生效。`
    },
  })
}

export function submitReportTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_submit_report',
    description:
      '个人工作台日报/周报工具：提交 AI 生成的日报或周报草稿，只写 pending 草稿，由用户在工作台确认后才保存。' +
      'period_code 为 day 或 week；period_start 为周期第一天（YYYY-MM-DD）；summary_md 为 Markdown 正文；stats 可选统计数字。' +
      '同一会话重复提交同一周期会更新同一草稿。',
    parameters: {
      draft_id: { type: 'string', description: '已有报告草稿 id；修改后再次提交时传' },
      period_code: { type: 'string', required: true, description: 'day=日报，week=周报' },
      period_start: { type: 'string', required: true, description: '周期开始日期 YYYY-MM-DD（日报=当天，周报=周一）' },
      title: { type: 'string', required: true, description: '报告标题' },
      summary_md: { type: 'string', required: true, description: 'Markdown 报告正文' },
      stats: { type: 'json', description: '可选统计：{completed, created, focus...}' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { session?: { id?: string } } }) {
      const periodCode = str(args.period_code)
      if (periodCode !== 'day' && periodCode !== 'week') return '错误：period_code 必须是 day 或 week'
      const periodStart = str(args.period_start)
      if (periodStart === undefined || !PLAN_DATE_RE.test(periodStart)) return '错误：period_start 必须是 YYYY-MM-DD 格式'
      const title = str(args.title)
      if (title === undefined) return '错误：title 必填'
      const summaryMd = str(args.summary_md)
      if (summaryMd === undefined) return '错误：summary_md 必填'

      const sessionId = exec.agent?.session?.id ?? null
      const draftId = str(args.draft_id)
      const existing = draftId === undefined ? getPendingReportDraft(db, sessionId, periodCode, periodStart) : getDraft(db, draftId)
      if (draftId !== undefined && existing === undefined) return `错误：草稿 ${draftId} 不存在`
      if (existing !== undefined && existing.statusCode !== 'pending') return `错误：草稿 ${draftId ?? existing.id} 状态为 ${existing.statusCode}，不能更新`

      const payload = {
        periodCode,
        periodStart,
        title,
        summaryMd,
        stats: typeof args.stats === 'object' && args.stats !== null ? args.stats : {},
        sessionId,
      }
      const draft = existing !== undefined
        ? updateDraft(db, existing.id, payload)
        : createDraft(db, { kindCode: 'report', sessionId, payload })
      return `报告草稿已保存（id=${draft?.id}，${periodCode === 'day' ? '日报' : '周报'} ${periodStart}），等待用户在工作台确认后才会保存。请勿声称报告已生成。`
    },
  })
}

export function proposeSubtasksTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_propose_subtasks',
    description:
      '个人工作台 AI 拆解工具：针对一个任务/子任务提交“子任务提案树”，只写 pending 草稿，由用户在界面勾选确认后才批量创建。' +
      '粒度规则：每层 2-6 个、最大深度 3 层、叶子 15-240 分钟且有可验证完成标准；若任务太小，返回无需拆解。',
    parameters: {
      parent_task_id: { type: 'string', required: true, description: '被拆解的任务/子任务 id' },
      draft_id: { type: 'string', description: '已有提案草稿 id；用户提出修改意见后再次提交时必传，用于更新同一提案' },
      subtasks: { type: 'json', required: true, description: '提案树数组；每项含 title/description/type_code/priority_code/due_at/estimated_minutes/children' },
      rationale: { type: 'string', description: '拆分思路（一句话）' },
      no_breakdown_needed: { type: 'boolean', description: 'true 表示建议不拆，并给出原因' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { session?: { id?: string } } }) {
      const parentTaskId = str(args.parent_task_id)
      if (parentTaskId === undefined) return '错误：parent_task_id 必填'
      const parent = getTask(db, parentTaskId)
      if (parent === undefined) return `错误：任务 ${parentTaskId} 不存在`
      const sessionId = exec.agent?.session?.id ?? null

      // 子任务缺省字段继承父任务（尤其是 type_code / priority_code），
      // 避免“代码开发”任务拆出“个人生活”子任务。
      const normalize = (items: unknown, depth = 1): unknown[] => {
        if (!Array.isArray(items)) return []
        if (depth > 3) return []
        return items.slice(0, 6).map((raw) => {
          const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
          return {
            ...item,
            title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title : '(未命名子任务)',
            type_code: typeof item.type_code === 'string' && item.type_code !== '' ? item.type_code : parent.typeCode,
            priority_code: typeof item.priority_code === 'string' && item.priority_code !== '' ? item.priority_code : parent.priorityCode,
            status_code: 'todo',
            children: normalize(item.children, depth + 1),
          }
        })
      }

      const draftId = str(args.draft_id)
      const existing = draftId === undefined ? undefined : getDraft(db, draftId)
      if (draftId !== undefined && existing === undefined) return `错误：提案草稿 ${draftId} 不存在`
      if (existing !== undefined && existing.statusCode !== 'pending') return `错误：提案草稿 ${draftId} 状态为 ${existing.statusCode}，不能更新`

      const payload: Record<string, unknown> = args.no_breakdown_needed === true
        ? { parentTaskId, subtasks: [], noBreakdownNeeded: true, rationale: str(args.rationale) ?? '' }
        : { parentTaskId, subtasks: normalize(args.subtasks), rationale: str(args.rationale) ?? '' }

      const draft = draftId !== undefined && existing !== undefined
        ? updateDraft(db, draftId, payload)
        : createDraft(db, { kindCode: 'subtask_plan', sessionId, payload })
      if (payload.subtasks !== undefined && (payload.subtasks as unknown[]).length === 0 && args.no_breakdown_needed !== true) {
        return '错误：subtasks 不能为空；若建议不拆，请设置 no_breakdown_needed=true'
      }
      return `提案已保存（id=${draft?.id}），等待用户在界面确认或继续提出修改意见。请勿声称子任务已创建。`
    },
  })
}

export function updateTaskTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_update_task',
    description:
      '个人工作台任务编辑工具：更新一个已有任务（例如把咨询/澄清的结论回写到任务描述）。只更新传入的字段；task_id 必填。不要把咨询结论提交成新任务。',
    parameters: {
      task_id: { type: 'string', required: true, description: '要更新的任务 id' },
      title: { type: 'string', description: '新标题' },
      description: { type: 'string', description: 'Markdown 描述（会整体替换）' },
      type_code: { type: 'string', description: '类型 code' },
      priority_code: { type: 'string', description: '优先级 code: p0/p1/p2/p3' },
      status_code: { type: 'string', description: '状态 code' },
      due_at: { type: 'string', description: 'ISO8601 截止时间' },
      ai_policy_code: { type: 'string', description: 'AI 策略 code' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>) {
      const taskId = str(args.task_id)
      if (taskId === undefined) return '错误：task_id 必填'
      const task = getTask(db, taskId)
      if (task === undefined) return `错误：任务 ${taskId} 不存在`
      const patch: Record<string, unknown> = {}
      const t = str(args.title)
      if (t !== undefined) patch.title = t
      const d = str(args.description)
      if (d !== undefined) patch.description = d
      const typeCode = optionalCode(db, 'type', args.type_code, 'type_code')
      if (typeCode !== undefined) patch.typeCode = typeCode
      const priorityCode = optionalCode(db, 'priority', args.priority_code, 'priority_code')
      if (priorityCode !== undefined) patch.priorityCode = priorityCode
      const statusCode = optionalCode(db, 'status', args.status_code, 'status_code')
      if (statusCode !== undefined) patch.statusCode = statusCode
      if (str(args.due_at) !== undefined) patch.dueAt = str(args.due_at)
      const aiPolicy = optionalCode(db, 'ai_policy', args.ai_policy_code, 'ai_policy_code')
      if (aiPolicy !== undefined) patch.aiPolicyCode = aiPolicy
      if (Object.keys(patch).length === 0) return '错误：至少提供一个要更新的字段'
      updateTask(db, taskId, patch, 'ai', new Date().toISOString())
      return `已更新任务「${task.title}」：${Object.keys(patch).join('、')}`
    },
  })
}

export function submitReviewTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_submit_review',
    description:
      '个人工作台复盘工具：对已完成任务进行回顾，输出复盘结论。summary_md 为 Markdown 复盘正文（做得好/做得不好/改进项）；lessons 为 JSON 数组，每项 {title, content}。复盘结果会写回任务详情。',
    parameters: {
      task_id: { type: 'string', required: true, description: '要复盘的任务 id' },
      summary_md: { type: 'string', required: true, description: 'Markdown 复盘正文' },
      lessons: { type: 'json', description: '结构化教训数组，例如 [{"title":"提前对齐需求","content":"..."}]' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { session?: { id?: string } } }) {
      const taskId = str(args.task_id)
      if (taskId === undefined) return '错误：task_id 必填'
      const task = getTask(db, taskId)
      if (task === undefined) return `错误：任务 ${taskId} 不存在`
      const summaryMd = str(args.summary_md)
      if (summaryMd === undefined || summaryMd.trim() === '') return '错误：summary_md 必填'
      const sessionId = exec?.agent?.session?.id ?? null
      // 幂等：同一任务已有待确认复盘草稿时更新，不重复新建。
      const existing = getPendingDraftForTask(db, 'review', taskId)
      const payload = { taskId, summaryMd, lessons: args.lessons ?? [], sessionId }
      const draft = existing !== undefined
        ? updateDraft(db, existing.id, payload)
        : createDraft(db, { kindCode: 'review', sessionId, payload })
      return `复盘草稿已提交${existing !== undefined ? '（更新）' : ''}（id=${draft?.id}），等待用户在个人工作台确认后才会写回任务。请勿声称复盘已保存。`
    },
  })
}

export function requestCompletionTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_request_completion',
    description:
      '个人工作台执行验收工具：执行会话完成工作后调用，提交“完成验收申请”。用户验收通过后任务才会置为已完成；本工具不会自行完成任务。task_id 必填，summary 为完成总结（2-4 句）。',
    parameters: {
      task_id: { type: 'string', required: true, description: '要申请完成的任务 id' },
      summary: { type: 'string', description: '完成总结（2-4 句）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { session?: { id?: string } } }) {
      const taskId = str(args.task_id)
      if (taskId === undefined) return '错误：task_id 必填'
      const task = getTask(db, taskId)
      if (task === undefined) return `错误：任务 ${taskId} 不存在`
      if (task.statusCode === 'done') return `任务「${task.title}」已经是已完成状态`
      if (task.archived === 1) return `错误：任务「${task.title}」已归档`
      const summary = typeof args.summary === 'string' && args.summary.trim() !== '' ? args.summary.trim() : ''
      const sessionId = exec?.agent?.session?.id ?? null
      const draft = createDraft(db, {
        kindCode: 'completion',
        sessionId,
        payload: { taskId, summary, sessionId },
      })
      return `完成验收申请已提交（草稿 id=${draft.id}），等待用户在个人工作台验收。请勿声称任务已经完成。`
    },
  })
}
