/**
 * 知识库回流的两个 Agent 工具（v1.15.3）。
 *
 * ## 为什么必须有两个工具（而不是"注入就够了"）
 *
 * 自动召回只在**回合边界**拿到用户提问，所以它天然是"上一回合的提问 → 这一回合带出来"。
 * 而验收要求的四个时机里有两个**发生在同一回合内**：
 * ①「报错时」—— 报错原文是模型自己跑命令才看到的，不是用户提问；
 * ②「写码前」—— 要查的约定通常是在读代码过程中才确定的关键词。
 * 这两个时机靠自动层赶不上，必须给模型一个**当回合就能查**的入口。
 *
 * ## 为什么还要 `recall_control`
 *
 * 1. **可关闭**：用户嫌吵时，模型能当场把本会话的自动召回关掉（`turn_off`），
 *    不用去翻设置页；也能重新打开（`turn_on`）或回到跟随全局（`clear`）。
 * 2. **可判定"是否被引用"**：`report_usage` 把"用到了哪几条"写进召回日志，
 *    于是"注入过但没人引用"这种噪声有了直接证据，而不是靠猜。
 *
 * ## 与 `workbench_submit_knowledge` 的分工
 *
 * 那个是**写入**（沉淀新知识、要用户确认）；这两个是**读与开关**，不写任何业务数据。
 * 工具描述里把这件事讲清楚，否则模型会在"记下来"和"查一下"之间混淆。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isEntryIdQuery, unwrapEntryId, type KnowledgeRecallManager } from './knowledge-recall.js'
import { extractTerms, formatRelevance, RECALL_DEFAULTS, recallKnowledge, relevanceOf, scoreFromRelevance } from './shared/knowledgeRecall.js'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

interface ToolExec {
  agent?: { session?: { id?: string; header?: { cwd?: string } } }
}

/**
 * `workbench_search_knowledge`：模型主动查知识库。
 *
 * 输出必须**自带检索证据**（关键词、命中条数、逐条相关度与命中原因），
 * 这样用户在会话里看到的不是"AI 说它查了"，而是"查了什么、命中了什么"。
 * 这也是验收标准第 1 条要的那份可演示证据。
 */
export function searchKnowledgeTool(manager: KnowledgeRecallManager) {
  return defineTool({
    name: 'workbench_search_knowledge',
    description:
      '在个人工作台知识库里检索历史经验/决策/笔记（只读，不写任何数据）。'
      + '什么时候查（四个时机）：①开工前先查任务相关条目；②遇到报错/异常时用**报错原文关键词**查；'
      + '③写/改代码前查相关约定与踩坑记录；④提交验收/复盘前查相关历史经验。'
      + '自动召回每回合也会带出条目，但报错原文、代码里的关键词常常只有你当场才看得到，所以这四个时机请主动查一次。'
      + '两种用法：①关键词检索（默认）——现象词/报错原文/模块名当 query，返回摘要（每条截 160 字符）；②按 id 读全文——把召回或上次检索结果里的 [id]（完整 uuid，可直接带方括号）当 query，返回该条的**完整正文**（带 file_link 的条目会一并给出本地文档路径）。相关度是归一化的 0~1（标题档满分 1.00 / 标签档 0.82 / 正文档 0.45），过线约等于 >= ${formatRelevance(RECALL_DEFAULTS.minScore)}。'
      + '排序规则：本任务/本任务树优先，其次全库。'
      + '结果里的 [id] 可用于 report_usage 回报引用。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词（现象词/报错原文片段/模块名/函数名都行；中文逐字匹配），或某条知识条目的完整 id（取全文）' },
      task_id: { type: 'string', description: '限定"本任务"的范围（可选；不传则按当前会话关联的任务推断）' },
      limit: { type: 'number', description: '返回条数，默认 8，最大 30' },
      min_score: { type: 'number', description: `最低相关度（0~1 归一化口径，与输出里的"相关度"同一把尺子），默认 ${formatRelevance(RECALL_DEFAULTS.minScore)}（低于它的不返回）` },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: ToolExec) {
      const query = str(args.query)
      if (query === undefined) return '错误：query 必填（写现象词或报错原文片段，别写整段话）'
      const sessionId = exec.agent?.session?.id ?? ''

      /**
       * 路径①：**按 id 直读全文**（v1.15.5）。
       *
       * 判定与解包都走 `knowledge-recall` 里的同一份实现（`isEntryIdQuery` / `unwrapEntryId`）——
       * 工具里再写一遍 uuid 正则就是"同一个语义两处实现"。
       *
       * 为什么放在 task_id 校验**之前**：id 是全局唯一的，取一条知识跟"哪个任务"无关；
       * 若先校验 task_id，会把"按 id 取全文"这条路无谓地绑死在任务范围上。
       * 这里的 task_id 会被忽略（不是静默改写检索范围 —— 按 id 取全文本来就没有"范围"）。
       */
      if (isEntryIdQuery(query)) {
        const entryId = unwrapEntryId(query) as string
        const entry = manager.findEntryById(entryId)
        if (entry === undefined) {
          manager.logSearch({ sessionId, taskId: null, query, terms: [], hits: [], matched: 0 })
          return `没有这条知识条目：${entryId}。`
            + '（id 必须是完整 uuid，直接照抄检索结果里的 [id]；不确定就先按关键词检索一次。）'
        }
        manager.logSearch({
          sessionId,
          taskId: null,
          query,
          terms: [],
          hits: [{ id: entry.id, title: entry.title, relevance: 1, reason: '按 id 直读全文' }],
          matched: 1,
        })
        const body = String(entry.contentMd ?? '').trim()
        const lines = [
          `知识条目 [${entry.id}] ${entry.title}（${entry.kindCode} · 全文）`,
          `标签：${entry.tags.length > 0 ? entry.tags.join('、') : '（无）'}`,
          `更新：${entry.updatedAt}`,
          entry.fileLink !== null && entry.fileLink !== '' ? `文档：${entry.fileLink}` : '',
          entry.sourceTaskId !== null ? `来源任务：${entry.sourceTaskId}` : '',
          '',
          body === '' ? '（这条没有正文）' : body,
        ].filter((line) => line !== '')
        lines.push('', '用到这条请调用 workbench_knowledge_recall_control(action="report_usage", entry_ids=["' + entry.id + '"]) 回报引用。')
        return lines.join('\n')
      }

      const explicitTask = str(args.task_id)
      // 显式给了 task_id 但库里没有这个任务 → **当场报错**而不是悄悄退回全库
      // （静默改写是用户最难发现的偏差，本仓明令禁止）。
      if (explicitTask !== undefined && !manager.taskExists(explicitTask)) {
        return `错误：task_id 不存在：${explicitTask}。可省略该参数，让系统按当前会话关联的任务推断范围。`
      }
      const resolvedTask = explicitTask
        ?? (sessionId === '' ? null : manager.resolveTaskId(sessionId, exec.agent?.session?.header?.cwd))
      const terms = extractTerms(query)
      const outcome = recallKnowledge({
        query,
        candidates: manager.candidates(resolvedTask),
        /**
         * `min_score` 是**归一化相关度**（0~1），与输出里显示的数字同一把尺子；
         * 内部判定仍用原始分，所以这里换算一次 —— 换算是单向的、只有一个入口。
         */
        minScore: typeof args.min_score === 'number' ? scoreFromRelevance(args.min_score) : RECALL_DEFAULTS.minScore,
        maxEntries: 30,
      })
      if (outcome.skippedReason !== undefined) {
        return `未检索：${outcome.skippedReason}。请给出更有信息量的关键词（现象词/报错原文/模块名）。`
      }
      const limited = outcome.hits.slice(0, Math.max(1, Math.min(typeof args.limit === 'number' ? args.limit : 8, 30)))
      // 显式检索也落库（trigger=tool）：这样"模型主动查了什么"和自动层一样可回看。
      manager.logSearch({
        sessionId,
        taskId: resolvedTask,
        query,
        terms,
        hits: limited.map((hit) => ({ id: hit.id, title: hit.title, relevance: hit.relevance })),
        matched: outcome.matched,
        droppedByScore: outcome.droppedByScore,
      })
      if (limited.length === 0) {
        return `检索「${query}」零命中（关键词：${terms.join('、') || '无'}；候选池 ${outcome.matched} 条，无一条过阈值 ${formatRelevance(RECALL_DEFAULTS.minScore)}）。`
          + '这不代表库里没有 —— 换更具体的现象词/报错原文再试一次；确实没有就直接继续。'
      }
      const scope = resolvedTask === null ? '全库' : `任务 ${resolvedTask.slice(0, 8)} 及全库`
      const lines = [
        `知识库检索「${query}」命中 ${limited.length} 条（范围：${scope}；关键词：${terms.join('、')}）：`,
      ]
      for (const hit of limited) {
        lines.push(`- [${hit.id}] ${hit.title}（${hit.kindCode} · 相关度 ${formatRelevance(hit.score)}）`)
        lines.push(`  依据：${hit.reason}`)
        if (hit.tags.length > 0) lines.push(`  标签：${hit.tags.join('、')}`)
        if (hit.snippet !== '') lines.push(`  摘要：${hit.snippet}`)
        if (hit.fileLink !== null && hit.fileLink !== '') lines.push(`  文档：${hit.fileLink}`)
      }
      lines.push('要某条的**全文**：把它的 [id]（完整 uuid）当 query 再调一次本工具（摘要只截 160 字符，长条目必须走这条路）。')
      lines.push('用到哪几条请调用 workbench_knowledge_recall_control(action="report_usage", entry_ids=[...]) 回报，便于用户核对是否被引用。')
      return lines.join('\n')
    },
  })
}

/**
 * `workbench_knowledge_recall_control`：开关 + 引用回报。
 *
 * 五种动作各管一件事，**不合并**（合并会让"关掉"和"回报"互相干扰，
 * 且一次调用做两件事时，任何一半失败都说不清落地了没有）。
 */
export function knowledgeRecallControlTool(manager: KnowledgeRecallManager) {
  return defineTool({
    name: 'workbench_knowledge_recall_control',
    description:
      '控制「工作台知识库自动召回」并回报引用情况。action 取值：'
      + 'turn_off=本会话关掉自动检索（用户嫌吵/要省 token 时用）、turn_on=本会话重新打开、'
      + 'clear=回到跟随全局设置、status=查看本会话当前开关与上一次命中的条目、'
      + 'report_usage=回报"我实际用到了哪几条"，需带 entry_ids（写进召回日志，是"是否被引用"的证据，不是打卡）。'
      + '只影响本会话的检索行为，不改知识库内容、不改任务。',
    parameters: {
      action: { type: 'string', required: true, description: 'turn_off | turn_on | clear | status | report_usage' },
      entry_ids: { type: 'json', description: 'report_usage 时必填：实际用到的知识条目 id 数组（来自检索结果里的 [id]）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => text(value),
    },
    async execute(args: Record<string, unknown>, exec: ToolExec) {
      const action = str(args.action)
      const sessionId = exec.agent?.session?.id ?? ''
      if (action === undefined) return '错误：action 必填（turn_off | turn_on | clear | status | report_usage）'
      if (sessionId === '') return '错误：当前会话没有可识别的 session id，无法设置会话级开关（可让用户在设置页改全局开关）。'

      if (action === 'status') {
        const state = manager.sessionState(sessionId)
        const mode = state.enabled ? '开' : '关'
        const hits = state.lastHits.length === 0
          ? '（本会话还没有命中记录）'
          : state.lastHits.map((hit) => `\n- [${hit.id}] ${hit.title}（相关度 ${hit.relevance.toFixed(2)} · ${hit.reason}）`).join('')
        return `本会话自动召回：${mode}；全局开关：${manager.autoEnabled() ? '开' : '关'}；最近一次检索词：「${state.lastQuery || '(无)'}」${hits}`
      }

      if (action === 'turn_off' || action === 'turn_on' || action === 'clear') {
        const mode = action === 'turn_off' ? 'off' : action === 'turn_on' ? 'on' : 'clear'
        const effective = manager.setSessionEnabled(sessionId, mode)
        const label = mode === 'off' ? '已关闭本会话的自动检索' : mode === 'on' ? '已打开本会话的自动检索' : '已回到跟随全局设置'
        return `${label}（当前${effective ? '开' : '关'}）。${effective ? '下一回合起相关条目会重新自动带出。' : '本会话不再自动检索；需要时我仍可主动调用 workbench_search_knowledge 查。'}`
      }

      if (action === 'report_usage') {
        const raw = Array.isArray(args.entry_ids) ? args.entry_ids : []
        const ids = raw.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
        if (ids.length === 0) return '错误：report_usage 需要 entry_ids（实际用到的知识条目 id 数组）；若一条都没用上就不要调用。'
        const result = manager.reportUsage(sessionId, ids)
        const unknownNote = result.unknown.length === 0 ? '' : `；另有 ${result.unknown.length} 个 id 不在知识库中，已忽略：${result.unknown.join('、')}`
        if (result.updated === 0) {
          return `没有匹配到本会话的召回记录（可能这几条是主动检索到的，或本会话还没发生过召回），已记录 ${ids.length} 条引用${unknownNote}。`
        }
        return `已回报引用 ${ids.length} 条，落到 ${result.updated} 条召回记录上${unknownNote}。`
      }

      return `错误：未知 action「${action}」。合法值：turn_off | turn_on | clear | status | report_usage。`
    },
  })
}
