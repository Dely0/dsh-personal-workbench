/**
 * Agent 工具：澄清会话写入草稿 / AI 拆解提交提案。
 * 这两个工具只写 task_drafts(pending)，不直接创建正式任务。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { addTaskMemory, assertValidFileLink, createDraft, getDeferredDraftForTask, getDictionary, getDraft, getIdea, getIdeaCluster, getPendingDailyPlanDraft, getPendingDraftForSession, getPendingDraftForTask, getPendingKnowledgeDraft, getPendingReportDraft, getTask, listActiveDictionaryCodes, listTaskEvents, listTasks, localDateString, updateDraft, updateTask } from './db/repo.js'
import { checkWorkspacePath } from './workspace-check.js'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * 把「合法枚举」拼成给调用方看的一行说明。
 *
 * 为什么值得做：`workbench_submit_task` 的 subtasks 里写了一个字典外的 type_code
 * （真实案例用的 `ops`）时，旧实现是**静默丢弃**——AI 以为自己建了 5 个子任务，
 * 用户确认后只出现 3 个，双方都不知道。根因之一是 AI 只能靠猜 code。
 * 现在把枚举直接回给 AI（工具描述里也带一份），猜错就当场报错而不是丢件。
 */
function enumHint(db: DatabaseSync, kind: string): string {
  const codes = listActiveDictionaryCodes(db, kind)
  return codes.length === 0 ? '(字典为空)' : codes.join(' / ')
}

/**
 * 递归校验草稿里每个任务节点的 type_code / priority_code 是否在字典中。
 *
 * 返回 undefined 表示全部合法；否则返回**可直接回给 AI 的中文错误**（含合法枚举）。
 * 与 repo 层 `validateDraftTaskItem` 是同一套规则的两道防线：
 * 工具层拦住"写草稿时就写错"，repo 层拦住"确认时才发现错"。
 */
function validateTaskItems(
  db: DatabaseSync,
  items: unknown[],
  opts: { required: boolean; depth?: number },
): string | undefined {
  const depth = opts.depth ?? 1
  if (items.length === 0) return opts.required ? '错误：任务数组不能为空' : undefined
  if (depth > 3) return undefined
  for (const raw of items) {
    const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const title = typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : '(未命名)'
    const typeCode = item.type_code ?? item.typeCode
    if (typeCode !== undefined && typeCode !== null && typeCode !== '') {
      if (typeof typeCode !== 'string' || getDictionary(db, 'type', typeCode)?.active !== 1) {
        return `错误：子项「${title}」的 type_code 不是有效值：${String(typeCode)}。`
          + `合法值：${enumHint(db, 'type')}。请改正后**重新提交整份提案**（草稿仍为 pending，可直接覆盖）。`
      }
    }
    const priorityCode = item.priority_code ?? item.priorityCode
    if (priorityCode !== undefined && priorityCode !== null && priorityCode !== '') {
      if (typeof priorityCode !== 'string' || getDictionary(db, 'priority', priorityCode)?.active !== 1) {
        return `错误：子项「${title}」的 priority_code 不是有效值：${String(priorityCode)}。`
          + `合法值：${enumHint(db, 'priority')}。请改正后重新提交整份提案。`
      }
    }
    if (Array.isArray(item.children)) {
      const nested = validateTaskItems(db, item.children as unknown[], { required: false, depth: depth + 1 })
      if (nested !== undefined) return nested
    }
  }
  return undefined
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

function normalizeCode(
  db: DatabaseSync,
  kind: string,
  code: unknown,
  fallback: string,
  aliases: Record<string, string> = {},
): string {
  const raw = typeof code === 'string' ? code.trim() : ''
  if (raw === '') return fallback
  if (getDictionary(db, kind, raw)?.active === 1) return raw
  const candidate = aliases[raw] ?? fallback
  return getDictionary(db, kind, candidate)?.active === 1 ? candidate : fallback
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 常见同义写法 → 合法 code（只在**显式给值**且该值不合法时尝试，失败就报错）。 */
const TYPE_ALIASES: Record<string, string> = {
  training: 'training', learning: 'training', learn: 'training', study: 'training',
  work: 'project_delivery', code: 'code_impl', life: 'personal', living: 'personal', home: 'personal',
}

/**
 * `type_code` 的**封闭枚举**校验（v1.14.0 修正）。
 *
 * 原来这里用的是 `normalizeCode(..., 'personal', ...)`：字典里查不到就**静默回退成
 * `personal`**，工具却照样返回"草稿已保存"。用户实测发现"非法 code 拦截失败"正是这个 ——
 * 传 `not_a_type` / `999` / `CODE_IMPL` 都能落成草稿，类型被悄悄改成 `personal`。
 *
 * 这与工具描述里"封闭枚举，不要自造"以及子任务那条"写错会被当场拒绝"自相矛盾，
 * 而且**静默改写比静默丢弃更难发现**（用户以为建的是"培训学习"，实际是"个人生活"）。
 *
 * 现在的规则：
 * - 参数缺失/空串 → 用 `fallback`（顶层任务确实需要一个默认类型）；
 * - 显式给值 → 必须命中字典中的启用项，或命中别名表；
 * - 否则**当场报错**，并把合法枚举列出来让调用方改正。
 *
 * `priority_code` / `ai_policy_code` 保持原有的宽松回退：它们有天然默认值，
 * 且写错的语义损失远小于任务类型（但同样会把最终值写回执里，便于自查）。
 */
function strictTypeCode(db: DatabaseSync, code: unknown, fallback: string): string {
  const raw = typeof code === 'string' ? code.trim() : ''
  if (raw === '') return fallback
  if (getDictionary(db, 'type', raw)?.active === 1) return raw
  const alias = TYPE_ALIASES[raw] ?? TYPE_ALIASES[raw.toLowerCase()]
  if (alias !== undefined && getDictionary(db, 'type', alias)?.active === 1) return alias
  throw new Error(
    `type_code 不是有效值：${raw}。合法值（封闭枚举）：${enumHint(db, 'type')}。`
    + `若该类型确实需要新增，请让用户在「工作台 → 设置 → 字典管理」里添加后再用。`,
  )
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
      type_code: { type: 'string', required: true, description: `任务类型 code（封闭枚举，不要自造）：${enumHint(db, 'type')}` },
      priority_code: { type: 'string', required: true, description: `优先级 code（封闭枚举）：${enumHint(db, 'priority')}；含义 p0=今天必须处理 p1=本周内完成 p2=按计划推进 p3=有空再做` },
      status_code: { type: 'string', description: '状态 code，默认 todo' },
      due_at: { type: 'string', description: '截止时间 ISO8601 带时区；全天任务用当天 00:00' },
      all_day: { type: 'boolean', description: '是否全天任务，默认 false' },
      estimated_minutes: { type: 'number', description: '预计耗时（分钟）' },
      ai_policy_code: { type: 'string', description: 'AI 策略 code；V1 只允许 none / consult，默认 consult' },
      reminder_offset_minutes: { type: 'number', description: '截止前多少分钟提醒；缺省按任务类型默认' },
      parent_id: { type: 'string', description: '父任务 id（子任务场景）' },
      workspace_path: { type: 'string', description: '任务 AI 会话使用的具体工作区路径；用户在澄清会话中指定，或留空使用默认工作区' },
      subtasks: { type: 'json', description: '可选：用户明确要求拆解时的简版子任务数组；每项 type_code/priority_code 缺省继承父任务。**type_code 必须是封闭枚举里的值**，写错会被当场拒绝（不再静默丢件）' },
      extra: { type: 'json', description: '附加信息：原始输入、澄清问答摘要等' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { session?: { id?: string; header?: { cwd?: string } } } }) {
      const title = str(args.title)
      if (title === undefined) return '错误：title 必填'
      /**
       * `type_code` 走**封闭枚举**并在失败时返回可读错误（而不是抛异常）。
       *
       * 抛异常会让工具以"异常"形式结束，调用方看到的是堆栈而不是"该怎么改"；
       * 本工具其余校验一律用 `return '错误：…'`，这里保持一致。
       */
      let typeCode: string
      try {
        typeCode = strictTypeCode(db, args.type_code, 'personal')
      } catch (error) {
        return `错误：${error instanceof Error ? error.message : String(error)}`
      }
      const priorityCode = normalizeCode(db, 'priority', args.priority_code ?? 'p2', 'p2')
      const statusCode = normalizeCode(db, 'status', args.status_code ?? 'todo', 'todo')
      if (statusCode === 'done' || statusCode === 'cancelled') return '错误：澄清草稿不能直接创建为已完成/已取消任务，请使用待办类状态，完成请走执行验收流程。'
      const aiPolicyCode = normalizeCode(db, 'ai_policy', args.ai_policy_code ?? 'consult', 'consult')
      // V1.5：execute 已开放；澄清会话默认仍建议 consult，除非用户明确要求可执行。
      const dueAt = str(args.due_at) ?? null
      const typeEntry = getDictionary(db, 'type', typeCode)
      const priorityEntry = getDictionary(db, 'priority', priorityCode)
      const typeDefault = typeof typeEntry?.config.defaultReminderMinutes === 'number' ? typeEntry.config.defaultReminderMinutes as number : undefined
      const priorityDefault = typeof priorityEntry?.config.defaultReminderMinutes === 'number' ? priorityEntry.config.defaultReminderMinutes as number : undefined
      const reminderOffset = typeof args.reminder_offset_minutes === 'number'
        ? args.reminder_offset_minutes
        : typeDefault ?? priorityDefault
      const subtasks = Array.isArray(args.subtasks) ? args.subtasks as unknown[] : []
      // 子任务 code 当场校验：写错就报错改正，绝不落进"确认时静默丢件"的老路。
      if (subtasks.length > 0) {
        const invalid = validateTaskItems(db, subtasks, { required: false })
        if (invalid !== undefined) return invalid
      }
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
        /**
         * 工作区路径：显式传入时**先校验**（v1.14.25）。
         *
         * 原始验收标准要求"不存在/不可写的工作区给出明确提示，而不是静默回落默认值"。
         * 这里直接回错误字符串让 AI 当场改正；确认草稿时还有一道同样的校验兜底
         * （用户可能在界面上手改路径）。
         */
        workspacePath: (() => {
          const explicit = str(args.workspace_path)
          if (explicit === undefined) return exec.agent?.session?.header?.cwd ?? null
          const verdict = checkWorkspacePath(explicit)
          if (!verdict.ok) throw new Error(String(verdict.reason))
          return verdict.normalized
        })(),
        subtasks,
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
      /**
       * 回执里要写**最终落库的值**（而不是调用方传进来的值）。
       *
       * 原先只报"草稿已保存"，于是 `type_code` 被静默回退成 `personal` 时调用方毫不知情
       * （2026-09-12 用户实测"非法 code 拦截失败"）。现在 type_code 走严格枚举、
       * priority / ai_policy 仍可能被归一化，所以把最终值显式回显 ——
       * 调用方一眼能看出自己给的值有没有被改动，这类"静默改写"是用户最难发现的偏差。
       */
      const echo = [
        `type=${typeCode}`,
        `priority=${priorityCode}`,
        `status=${statusCode}`,
        `ai_policy=${aiPolicyCode}`,
      ].join(' · ')
      return `草稿已保存（id=${draft?.id}），等待用户在界面确认。请用一句话告知用户可以检查草稿；不要声称任务已创建。`
        + `\n（本次落库的字段：${echo}）`
        + `\n（合法枚举备查：type = ${enumHint(db, 'type')}；priority = ${enumHint(db, 'priority')}）`
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
        const isAncestor = (ancestorId: string, descendantId: string): boolean => {
          let cursor = getTask(db, descendantId)
          let guard = 0
          while (cursor !== undefined && guard < 32) {
            if (cursor.parentId === ancestorId) return true
            cursor = cursor.parentId === null ? undefined : getTask(db, cursor.parentId)
            guard += 1
          }
          return false
        }
        for (const existingId of seen) {
          if (isAncestor(taskId, existingId) || isAncestor(existingId, taskId)) {
            return `错误：任务「${task.title}」与「${getTask(db, existingId)?.title ?? existingId}」在同一父子链上，不能同时列入计划`
          }
        }
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

export function proposeIdeaClustersTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_propose_idea_clusters',
    description:
      '个人工作台点子关联工具：把若干点子按主题关联成“点子王”（点子集）提案。只写 pending 草稿，由用户确认后创建点子王。' +
      'clusters 数组每项 {title, summary, idea_ids, notes?}；idea_ids 必须是真实点子 id。同一会话重复提交更新同一草稿。',
    parameters: {
      draft_id: { type: 'string', description: '已有提案草稿 id；修改后再次提交时传' },
      clusters: { type: 'json', required: true, description: '点子王提案数组，每项 {title, summary, idea_ids, notes?}' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { session?: { id?: string } } }) {
      const raw = Array.isArray(args.clusters) ? args.clusters as unknown[] : []
      if (raw.length === 0) return '错误：clusters 不能为空'
      const seenIdea = new Set<string>()
      const clusters: Array<{ title: string; summary: string; idea_ids: string[]; idea_titles: string[]; notes?: Record<string, string> }> = []
      for (let i = 0; i < raw.length; i += 1) {
        const item = (typeof raw[i] === 'object' && raw[i] !== null ? raw[i] : {}) as Record<string, unknown>
        const title = typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : `点子王 ${i + 1}`
        const ideaIds = Array.isArray(item.idea_ids) ? item.idea_ids.filter((id): id is string => typeof id === 'string') : []
        if (ideaIds.length === 0) return `错误：clusters[${i}] 没有 idea_ids`
        for (const id of ideaIds) {
          if (getIdea(db, id) === undefined) return `错误：点子 ${id} 不存在`
          if (seenIdea.has(id)) return `错误：点子「${getIdea(db, id)?.title ?? id}」重复出现在多个点子王中`
          seenIdea.add(id)
        }
        const ideaTitles = ideaIds.map((ideaId) => getIdea(db, ideaId)?.title ?? ideaId)
        clusters.push({ title, summary: typeof item.summary === 'string' ? item.summary : '', idea_ids: ideaIds, idea_titles: ideaTitles, notes: typeof item.notes === 'object' && item.notes !== null ? item.notes as Record<string, string> : undefined })
      }
      const sessionId = exec.agent?.session?.id ?? null
      const draftId = str(args.draft_id)
      const existing = draftId === undefined ? getPendingDraftForSession(db, sessionId, 'idea_cluster') : getDraft(db, draftId)
      if (draftId !== undefined && existing === undefined) return `错误：草稿 ${draftId} 不存在`
      if (existing !== undefined && existing.statusCode !== 'pending') return `错误：草稿 ${draftId ?? existing.id} 状态为 ${existing.statusCode}，不能更新`
      const draft = existing !== undefined
        ? updateDraft(db, existing.id, { clusters, sessionId })
        : createDraft(db, { kindCode: 'idea_cluster', sessionId, payload: { clusters } })
      return `点子王提案已保存（id=${draft?.id}），等待用户在工作台确认。请用一句话告知用户可以检查提案。`
    },
  })
}

export function submitIdeaTasksTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_submit_idea_tasks',
    description:
      '个人工作台点子落地工具：把头脑风暴结论转成任务提案（pending 草稿），用户确认后创建任务并保留来源点子/点子王。' +
      'tasks 为任务数组，每项 {title, description?, type_code?, priority_code?, due_at?, estimated_minutes?, ai_policy_code?, children?}。' +
      'source_idea_ids 与 source_cluster_id 至少传一个。同一会话重复提交更新同一草稿。',
    parameters: {
      draft_id: { type: 'string', description: '已有提案草稿 id；修改后再次提交时传' },
      source_idea_ids: { type: 'json', description: '来源点子 id 数组' },
      source_cluster_id: { type: 'string', description: '来源点子王 id' },
      tasks: { type: 'json', required: true, description: '落地任务数组（可含 children 子任务树）' },
      summary: { type: 'string', description: '头脑风暴小结（1-3 句）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { session?: { id?: string } } }) {
      const raw = Array.isArray(args.tasks) ? args.tasks as unknown[] : []
      if (raw.length === 0) return '错误：tasks 不能为空'
      const sourceIdeaIds = Array.isArray(args.source_idea_ids) ? args.source_idea_ids.filter((id): id is string => typeof id === 'string') : []
      const sourceClusterId = str(args.source_cluster_id)
      if (sourceIdeaIds.length === 0 && sourceClusterId === undefined) return '错误：source_idea_ids 与 source_cluster_id 至少传一个'
      for (const id of sourceIdeaIds) if (getIdea(db, id) === undefined) return `错误：点子 ${id} 不存在`
      if (sourceClusterId !== undefined && getIdeaCluster(db, sourceClusterId) === undefined) return `错误：点子王 ${sourceClusterId} 不存在`
      // 基本校验任务数组
      const normalize = (items: unknown[], depth = 1): unknown[] => {
        if (depth > 3) return []
        return items.slice(0, 20).map((rawItem) => {
          const item = (typeof rawItem === 'object' && rawItem !== null ? rawItem : {}) as Record<string, unknown>
          return {
            ...item,
            title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title : '(未命名任务)',
            children: normalize(Array.isArray(item.children) ? item.children as unknown[] : [], depth + 1),
          }
        })
      }
      const tasks = normalize(raw)
      // 点子落地同样校验：`confirmIdeaTaskDraft` 对未知 code 是**回退**（不是丢弃），
      // 但"静默改类型"同样是用户看不到的偏差，所以在入口处就报错让 AI 改正。
      const invalidIdeaTasks = validateTaskItems(db, tasks, { required: false })
      if (invalidIdeaTasks !== undefined) return invalidIdeaTasks
      const sessionId = exec.agent?.session?.id ?? null
      const payload = { sourceIdeaIds, sourceClusterId: sourceClusterId ?? null, tasks, summary: str(args.summary) ?? '' }
      const draftId = str(args.draft_id)
      const existing = draftId === undefined ? getPendingDraftForSession(db, sessionId, 'idea_tasks') : getDraft(db, draftId)
      if (draftId !== undefined && existing === undefined) return `错误：草稿 ${draftId} 不存在`
      if (existing !== undefined && existing.statusCode !== 'pending') return `错误：草稿 ${draftId ?? existing.id} 状态为 ${existing.statusCode}，不能更新`
      const draft = existing !== undefined
        ? updateDraft(db, existing.id, payload)
        : createDraft(db, { kindCode: 'idea_tasks', sessionId, payload })
      return `点子落地任务提案已保存（id=${draft?.id}，${tasks.length} 个任务），等待用户确认后创建。请勿声称任务已创建。`
    },
  })
}

export function submitKnowledgeTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_submit_knowledge',
    description:
      '个人工作台知识库工具：把值得沉淀的经验教训、决策、笔记或可复用片段提交为知识条目草稿（pending），由用户在工作台确认后才入库。' +
      'kind_code 可选 note/lesson/decision/snippet；tags 为字符串数组；source_task_id 可选，用于关联任务；file_link 可选，用于绑定本地文档（file:// 或绝对路径）。同一会话重复提交会更新同一草稿。',
    parameters: {
      draft_id: { type: 'string', description: '已有知识草稿 id；修改后再次提交时传' },
      title: { type: 'string', required: true, description: '知识标题，简洁可检索' },
      content_md: { type: 'string', required: true, description: 'Markdown 正文：背景/结论/可复用做法' },
      kind_code: { type: 'string', description: 'note=笔记，lesson=经验教训，decision=决策记录，snippet=片段/模板；默认 lesson' },
      tags: { type: 'json', description: '标签数组，如 ["TTS","踩坑"]' },
      source_task_id: { type: 'string', description: '关联任务 id（可选）' },
      source_review_id: { type: 'string', description: '来源复盘记录 id（可选；同一复盘只允许沉淀一次）' },
      file_link: { type: 'string', description: '本地文件链接（可选）：file:// URL 或绝对路径，如 file:///D:/docs/a.md、D:\\docs\\a.md、/mnt/d/docs/a.md' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: { agent?: { session?: { id?: string } } }) {
      const title = str(args.title)
      if (title === undefined) return '错误：title 必填'
      const contentMd = str(args.content_md)
      if (contentMd === undefined) return '错误：content_md 必填'
      const kindCode = str(args.kind_code) ?? 'lesson'
      if (getDictionary(db, 'knowledge_kind', kindCode) === undefined) return `错误：kind_code 不是有效的 knowledge_kind: ${kindCode}`
      if (typeof args.source_task_id === 'string' && args.source_task_id !== '' && getTask(db, args.source_task_id) === undefined) {
        return `错误：source_task_id 任务不存在：${args.source_task_id}`
      }
      const tags = Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20) : []
      let fileLink: string | null = null
      if (args.file_link !== undefined && args.file_link !== null && args.file_link !== '') {
        try {
          fileLink = assertValidFileLink(String(args.file_link))
        } catch (error) {
          return `错误：${error instanceof Error ? error.message : String(error)}`
        }
      }

      const sessionId = exec.agent?.session?.id ?? null
      const draftId = str(args.draft_id)
      const existing = draftId === undefined ? getPendingKnowledgeDraft(db, sessionId) : getDraft(db, draftId)
      if (draftId !== undefined && existing === undefined) return `错误：草稿 ${draftId} 不存在`
      if (existing !== undefined && existing.statusCode !== 'pending') return `错误：草稿 ${draftId ?? existing.id} 状态为 ${existing.statusCode}，不能更新`

      const payload = {
        title,
        contentMd,
        kindCode,
        tags,
        sourceTaskId: str(args.source_task_id) ?? null,
        sourceReviewId: str(args.source_review_id) ?? null,
        fileLink,
      }
      const draft = existing !== undefined
        ? updateDraft(db, existing.id, payload)
        : createDraft(db, { kindCode: 'knowledge', sessionId, payload })
      return `知识草稿已保存（id=${draft?.id}），等待用户在工作台确认后入库。请勿声称已存入知识库。`
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
      subtasks: { type: 'json', required: true, description: `提案树数组；每项含 title/description/type_code/priority_code/due_at/estimated_minutes/children。type_code 缺省继承父任务；**若显式给出必须是封闭枚举**：${enumHint(db, 'type')}` },
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
      if (parent.archived === 1 || parent.statusCode === 'done' || parent.statusCode === 'cancelled') {
        return `错误：任务「${parent.title}」已归档或已关闭，不能拆解`
      }
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

      const normalizedSubtasks = args.no_breakdown_needed === true ? [] : normalize(args.subtasks)

      // 与 workbench_submit_task 同一道防线：显式给出的 type/priority code 必须合法，
      // 否则确认时会被静默过滤（真实事故见 docs/issues/2026-09-12-subtask-type-code-silently-dropped.md）。
      if (args.no_breakdown_needed !== true) {
        const invalid = validateTaskItems(db, normalizedSubtasks, { required: false })
        if (invalid !== undefined) return invalid
      }

      const payload: Record<string, unknown> = args.no_breakdown_needed === true
        ? { parentTaskId, subtasks: [], noBreakdownNeeded: true, rationale: str(args.rationale) ?? '' }
        : { parentTaskId, subtasks: normalizedSubtasks, rationale: str(args.rationale) ?? '' }

      const draft = draftId !== undefined && existing !== undefined
        ? updateDraft(db, draftId, payload)
        : createDraft(db, { kindCode: 'subtask_plan', sessionId, payload })
      if (payload.subtasks !== undefined && (payload.subtasks as unknown[]).length === 0 && args.no_breakdown_needed !== true) {
        return '错误：subtasks 不能为空；若建议不拆，请设置 no_breakdown_needed=true'
      }
      return `提案已保存（id=${draft?.id}，${(normalizedSubtasks).length} 个顶层节点，其中合法 code 已校验），`
        + '等待用户在界面确认或继续提出修改意见。请勿声称子任务已创建。'
    },
  })
}

/** 「移到顶层」的等价写法：parent_id / parent_title 只接受字符串，用它表达「没有父任务」。 */
const TOP_LEVEL_PARENT_ALIASES = new Set(['none', 'null', 'top', 'root', '顶层', '顶级', '无'])

/**
 * 解析改父任务的入参：parent_id / parent_title 二选一。
 *
 * 标题只在**活跃任务**（未归档、祖先也未归档）里匹配，先全等、再包含；
 * 命中多个或一个都没命中时明确报错并列出候选，让 AI 回去问用户——
 * 绝不替用户在重名/相似的标题里挑一个（改错父任务的代价比多问一句大得多）。
 */
function resolveParentRef(db: DatabaseSync, args: Record<string, unknown>): { parentId: string | null } | { error: string } {
  const rawId = str(args.parent_id)
  const rawTitle = str(args.parent_title)
  if (rawId !== undefined && rawTitle !== undefined) return { error: '错误：parent_id 与 parent_title 只能给一个' }
  if (rawId === undefined && rawTitle === undefined) {
    return { error: '错误：parent_id 与 parent_title 至少给一个（移到顶层用 parent_id="none"）' }
  }
  if (rawId !== undefined) {
    const value = rawId.trim()
    if (TOP_LEVEL_PARENT_ALIASES.has(value.toLowerCase())) return { parentId: null }
    const parent = getTask(db, value)
    if (parent === undefined) return { error: `错误：父任务 ${value} 不存在` }
    if (parent.archived === 1) return { error: `错误：父任务「${parent.title}」已归档，不能挂到它下面` }
    return { parentId: parent.id }
  }
  const wanted = (rawTitle ?? '').trim().toLowerCase()
  const active = listTasks(db)
  const exact = active.filter((item) => item.title.trim().toLowerCase() === wanted)
  const matches = exact.length > 0 ? exact : active.filter((item) => item.title.toLowerCase().includes(wanted))
  if (matches.length === 0) {
    const candidates = active.slice(0, 10).map((item) => `${item.title}（${item.id}）`).join('、')
    return { error: `错误：没有找到标题匹配「${rawTitle}」的活跃任务：无法确定父任务。当前活跃任务：${candidates === '' ? '（无）' : candidates}。请让用户确认，或改用 parent_id。` }
  }
  if (matches.length > 1) {
    const candidates = matches.map((item) => `${item.title}（${item.id}）`).join('、')
    return { error: `错误：标题「${rawTitle}」匹配到 ${matches.length} 个活跃任务，不能替你选：${candidates}。请让用户确认后用 parent_id 指定。` }
  }
  return { parentId: matches[0].id }
}

export function updateTaskTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_update_task',
    description:
      '个人工作台任务编辑工具：更新一个已有任务（例如把咨询/澄清的结论回写到任务描述）。只更新传入的字段；task_id 必填。不要把咨询结论提交成新任务。' +
      '也可以改父任务（把任务挪到别的父任务下，或移到顶层）：用 parent_id 指定父任务 id（移到顶层传 "none"），' +
      '用户只给了父任务标题时用 parent_title。改父任务会做存在性、归档与防环校验，失败会返回中文原因。',
    parameters: {
      task_id: { type: 'string', required: true, description: '要更新的任务 id' },
      title: { type: 'string', description: '新标题' },
      description: { type: 'string', description: 'Markdown 描述（会整体替换）' },
      type_code: { type: 'string', description: '类型 code' },
      priority_code: { type: 'string', description: '优先级 code: p0/p1/p2/p3' },
      status_code: { type: 'string', description: '状态 code' },
      due_at: { type: 'string', description: 'ISO8601 截止时间' },
      ai_policy_code: { type: 'string', description: 'AI 策略 code' },
      parent_id: { type: 'string', description: '改父任务：新父任务 id；移到顶层传 "none"（顶层）。与 parent_title 二选一' },
      parent_title: { type: 'string', description: '改父任务：用父任务标题指定（仅在活跃任务里精确匹配，重名会让用户确认）；与 parent_id 二选一' },
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
      if (statusCode === 'done' || statusCode === 'cancelled') return '错误：AI 不能直接把任务标记为已完成/已取消；完成请由执行会话调用 workbench_request_completion，取消请在界面操作。'
      if (statusCode !== undefined) patch.statusCode = statusCode
      if (str(args.due_at) !== undefined) patch.dueAt = str(args.due_at)
      const aiPolicy = optionalCode(db, 'ai_policy', args.ai_policy_code, 'ai_policy_code')
      if (aiPolicy !== undefined) patch.aiPolicyCode = aiPolicy
      // 改父任务：先解析（id / 标题），存在性、归档与防环校验由仓储层统一兜底。
      let reparentNote = ''
      if (args.parent_id !== undefined || args.parent_title !== undefined) {
        const resolved = resolveParentRef(db, args)
        if ('error' in resolved) return resolved.error
        patch.parentId = resolved.parentId
        reparentNote = `，父任务改为「${resolved.parentId === null ? '顶层' : getTask(db, resolved.parentId)?.title ?? resolved.parentId}」`
      }
      if (Object.keys(patch).length === 0) return '错误：至少提供一个要更新的字段'
      try {
        updateTask(db, taskId, patch, 'ai', new Date().toISOString())
      } catch (error) {
        // 守卫抛的是给用户看的中文原因（挂到自己身上 / 会形成环 / 父任务不存在…），原样回给 AI。
        return `错误：${error instanceof Error ? error.message : String(error)}`
      }
      return `已更新任务「${task.title}」：${Object.keys(patch).join('、')}${reparentNote}`
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
      if (task.statusCode !== 'done') return `错误：任务「${task.title}」尚未完成，不能复盘`
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
      '个人工作台执行验收工具：任意节点（含父任务）完成工作后调用，提交“完成验收申请”。用户验收通过后任务才会置为已完成；父任务验收通过时未完成子任务会级联完成。本工具不会自行完成任务。task_id 必填，summary 为完成总结（2-4 句）。若此前被驳回/暂存，务必带上 feedback 说明本次改了什么。返回里会附带该任务的提交历史。',
    parameters: {
      task_id: { type: 'string', required: true, description: '要申请完成的任务 id（任意节点，父任务也可）' },
      summary: { type: 'string', description: '完成总结（2-4 句）' },
      feedback: { type: 'string', description: '可选：若上次验收被驳回/暂存，说明本次针对反馈做了哪些修改（1-2 句）' },
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
      if (task.aiPolicyCode !== 'execute') return `错误：任务「${task.title}」的 AI 策略不是“可执行”，不能申请完成`
      const summary = typeof args.summary === 'string' && args.summary.trim() !== '' ? args.summary.trim() : ''
      const feedback = typeof args.feedback === 'string' && args.feedback.trim() !== '' ? args.feedback.trim() : ''
      const sessionId = exec?.agent?.session?.id ?? null
      const existing = getPendingDraftForTask(db, 'completion', taskId)
      const payload = { taskId, summary, sessionId, ...(feedback === '' ? {} : { feedback }) }
      const draft = existing !== undefined
        ? updateDraft(db, existing.id, payload)
        : createDraft(db, { kindCode: 'completion', sessionId, payload })

      // 提交历史：驳回/暂存次数与最近一次原因，让 AI 不必等用户口头转述就知道自己处于第几次提交。
      const events = listTaskEvents(db, taskId).filter((event) => event.event_code === 'completion_rejected' || event.event_code === 'completion_deferred')
      const rejected = events.filter((event) => event.event_code === 'completion_rejected').length
      const deferred = events.filter((event) => event.event_code === 'completion_deferred').length
      const history = events.length === 0
        ? '本次是该任务的第 1 次验收提交。'
        : `本次是第 ${events.length + 1} 次验收提交（此前被驳回 ${rejected} 次、暂存 ${deferred} 次）。最近一次：${String(events[0]?.note ?? '')}`
      const deferredNow = getDeferredDraftForTask(db, 'completion', taskId)
      const deferHint = deferredNow === undefined
        ? ''
        : `\n注意：该任务已有一份**暂存中**的验收申请（暂存于 ${deferredNow.deferredAt ?? '未知时间'}），用户正在验证；本次提交已更新该草稿内容，请勿重复催促。`
      return `完成验收申请已提交${existing !== undefined ? '（更新）' : ''}（草稿 id=${draft?.id}），等待用户在个人工作台验收。${deferHint}\n${history}\n请勿声称任务已经完成；若用户驳回并给出反馈，请按反馈修改后再提交。`
    },
  })
}

export function saveTaskMemoryTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_save_task_memory',
    description:
      '个人工作台任务共享记忆工具：把当前会话的重要上下文、阶段性结论或决策保存到任务级共享记忆。' +
      '同一任务/子树下的后续会话（尤其是父任务会话）会自动加载这些记忆，避免跨会话失忆。' +
      'task_id 必填，content 为要记住的内容；kind 可选 note/decision/summary/context，默认 note。',
    parameters: {
      task_id: { type: 'string', required: true, description: '要写入共享记忆的任务 id（任意节点）' },
      content: { type: 'string', required: true, description: '要共享的上下文/结论，建议简洁、可独立理解' },
      kind: { type: 'string', description: '记忆类型：note/decision/summary/context，默认 note' },
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
      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (content === '') return '错误：content 必填'
      const kind = typeof args.kind === 'string' && args.kind.trim() !== '' ? args.kind.trim() : 'note'
      const memory = addTaskMemory(db, {
        taskId,
        kind,
        content,
        sourceSessionId: exec?.agent?.session?.id ?? null,
      })
      if (memory === undefined) return '错误：保存共享记忆失败'
      return `已保存任务共享记忆（id=${memory.id}，kind=${memory.kind}）。后续同一任务/子树的会话会自动带上这条上下文。`
    },
  })
}
