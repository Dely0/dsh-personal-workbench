/**
 * 知识库自动召回 —— **接线与状态**（host 侧）。
 *
 * ## 它解决什么问题
 *
 * 知识库存了内容，但会话 AI **不会自动用起来**。这个模块把"知识库"接进会话：
 *
 * 1. **常驻引导层**（`systemPrompt.section`，固定文本）：告诉模型四个触发时机
 *    （开工前 / 报错时 / 写码前 / 验收前）该主动查一次。它是**常量**，
 *    所以对提示前缀是一次性成本（DeepSeek 前缀缓存照常命中）。
 * 2. **自动检索层**（`systemPrompt.context` + `agent/turn-stopping` 预取）：
 *    回合收尾用**用户提问**算一次相关度，**下一回合**注入。
 *    与团队记忆同一套行为约定（预取→注入、零命中不插占位、阈值与条数上限唯一来源）。
 * 3. **可观测**：每次召回写一行 `knowledge_recall_log`（关键词 / 命中 / 是否注入 / 跳过原因），
 *    模型用到条目时用 `report_usage` 回填"是否被引用"。
 * 4. **可关闭**：全局开关 + 单会话覆盖（`off` / `on` / `clear`），关掉后**不再检索也不再注入**。
 *
 * ## 为什么注入走 `systemPrompt.context` 而不是自己往会话里塞消息
 *
 * `context` 的语义是"**动态运行时上下文的持久用户角色快照**"（见
 * `@deepseek-ai/dsh-system-prompt` 的类型注释），也就是它会**进会话记录**，
 * 用户能看到"这一回合带进了哪几条知识" —— 正是验收要求的"结果必须在会话里可见"。
 * 自己往会话塞消息会绕过宿主的投影/替换语义（同一个语义两处实现 = 本仓第一大 bug 类别）。
 *
 * ## 刻意不做的事
 *
 * - **不在渲染期做副作用**：`injectionFor()` 是纯读（读会话态与已算好的结果），
 *   检索发生在 `agent/turn-stopping` 钩子里（回合收尾），不在 prompt 装配里写库/写文件。
 * - **不静默降级**：拿不到会话 id、库读失败、开关状态读不出来，都会留一行可读日志，
 *   而不是"看起来在跑其实什么都没做"。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import { getTask, listKnowledge } from './db/repo.js'
import type { KnowledgeRow } from './db/repo/knowledge.js'
import { findTaskIdBySession } from './db/repo/task-sessions.js'
import { readMeta } from './db/repo/meta.js'
import { appendRecallLog, citeRecallLog, readSessionOverrides, writeSessionOverride } from './knowledge-recall-log.js'
import {
  formatRecallText,
  mergeRecallOutcomes,
  recallKnowledge,
  RECALL_DEFAULTS,
  taskIdFromWorkspacePath,
  type RecallCandidate,
  type RecallOutcome,
} from './shared/knowledgeRecall.js'

/** 全局开关的 meta 键（缺省 **开**：功能不默认关闭，否则用户永远发现不了它）。 */
const AUTO_RECALL_KEY = 'knowledge_recall_auto'

/**
 * 常驻引导层文本。
 *
 * 三条与团队记忆**逐字对齐**的约定（见 `knowledgeRecall.ts` 顶部那张表）：
 * 自动层会带出内容、零命中不等于没有、所以主动查的判据是**可判定的触发条件**。
 *
 * ⚠️ 它必须是**常量**：任何随回合变化的内容（计数、时间、命中条目）都会
 * 每回合改写提示前缀 → 前缀缓存全废。动态内容一律走 `context` 层。
 */
export const KNOWLEDGE_GUIDE = [
  '【工作台知识库 · 使用说明】',
  '本机「个人工作台」有知识库（经验教训/决策/笔记/片段）。相关条目会**自动带出来**：',
  '每回合开始前系统已按你的提问检索过一次，命中的条目会以「【工作台知识库】…」的消息形式出现。',
  '**没有带出来 ≠ 知识库里没有**（零命中时不插占位）。所以下面四个时机请主动查一次：',
  '',
  '1. **开工前**：动手前一上来先查一次 —— `workbench_search_knowledge(query="任务关键词")`；',
  '2. **遇到报错/异常时**：拿**报错原文的关键词**查（错误码、异常名、现象词），很可能是踩过的坑；',
  '3. **写/改代码前**：查相关约定与踩坑记录（模块名、函数名、"约定"、"不要"）；',
  '4. **提交验收 / 复盘前**：查相关历史经验与决策，避免重犯。',
  '',
  '查到条目后**要用起来**：相关就在回答/改动里引用它（说明依据），并在本回合结束时调用',
  '`workbench_knowledge_recall_control(action="report_usage", entry_ids=[...])` 回报用到了哪几条；',
  '确实没用上的不要回报（回报是"是否被引用"的证据，不是打卡）。**零命中也是有效信息**，据此继续即可，不必反复换词重试。',
  '本会话不想被自动检索打扰时，调用 `workbench_knowledge_recall_control(action="turn_off")`。',
].join('\n')

/** 单会话状态。 */
interface SessionState {
  /** 显式开关（`undefined` = 跟随全局）。 */
  override?: 'off' | 'on'
  /** 已算好、等下一回合注入的文本。 */
  pendingText: string
  /** 已注入文本（同一回合内保持稳定 —— 保前缀缓存）。 */
  cachedText: string
  injectedTurn: number
  lastQuery: string
  /** 已经注入过的条目 id：默认不再重复占额度（噪声控制的关键一条）。 */
  seenIds: Set<string>
  /** 最近一次召回的结论（供日志页/工具回显）。 */
  lastOutcome?: RecallOutcome
}

/** 知识候选快照的缓存时长：题目是"每个回合算一次"，但同一回合内可能装配多次。 */
const CANDIDATE_TTL_MS = 15_000

export interface KnowledgeRecallOptions {
  /** 全局缺省是否开自动召回（配置项；`false` 时仍可用工具手动查）。 */
  enabled?: boolean
  /** 阈值 / 条数上限覆盖（测试与用户偏好用；缺省取 `RECALL_DEFAULTS`）。 */
  minScore?: number
  maxEntries?: number
  /** 日志回调（宿主 logger 或 console）。 */
  log?: (message: string) => void
  /** 是否注册自动注入（`false` 只注册工具与开关）。 */
  autoInject?: boolean
}

export class KnowledgeRecallManager {
  private readonly db: DatabaseSync
  private readonly sessions = new Map<string, SessionState>()
  private readonly options: KnowledgeRecallOptions
  private candidateCache: { at: number; rows: KnowledgeRow[] } | undefined
  /** 最近日志行（上限 500，见 `drainLogs`）。 */
  private readonly recentLogs: string[] = []

  constructor(db: DatabaseSync, options: KnowledgeRecallOptions = {}) {
    this.db = db
    this.options = options
  }

  /** 全局开关：配置项显式给了就听它，否则读 meta（缺省开）。 */
  autoEnabled(): boolean {
    if (this.options.enabled === false) return false
    if (this.options.enabled === true) return true
    return (readMeta(this.db, AUTO_RECALL_KEY) ?? '1') !== '0'
  }

  setAutoEnabled(enabled: boolean): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(AUTO_RECALL_KEY, enabled ? '1' : '0')
    this.log(`自动召回全局开关 → ${enabled ? '开' : '关'}`)
  }

  /** 单会话是否生效（显式覆盖 > 全局）。 */
  sessionEnabled(sessionId: string): boolean {
    const override = this.sessions.get(sessionId)?.override ?? readSessionOverrides(this.db)[sessionId]
    if (override === 'off') return false
    if (override === 'on') return true
    return this.autoEnabled()
  }

  /** 显式开关某会话：`off` / `on` / `clear`（回到跟随全局）。返回当前是否生效。 */
  setSessionEnabled(sessionId: string, mode: 'off' | 'on' | 'clear'): boolean {
    const state = this.state(sessionId)
    if (mode === 'clear') {
      delete state.override
      // meta 里也清掉，否则重启后"显式关"会复活（单会话偏好是持久化的）
      writeSessionOverride(this.db, sessionId, 'clear')
    } else {
      state.override = mode
      writeSessionOverride(this.db, sessionId, mode)
    }
    const effective = this.sessionEnabled(sessionId)
    if (!effective) {
      // 关掉时把待注入内容一并清空：否则"关了还是注入了上一次算好的内容"。
      state.pendingText = ''
      state.cachedText = ''
      state.injectedTurn = -1
    } else {
      /**
       * 重新打开时**清掉去重集合**：用户关掉再打开，语义是"重新开始"，而不是
       * "接着上次的已注入集合继续跳过"。留着它会表现为"打开了却再也不带出任何东西" ——
       * 那正是"开关看起来是开的、实际没生效"这一类最难归因的缺陷。
       */
      state.seenIds.clear()
    }
    this.log(`会话 ${sessionId} 自动召回 → ${mode}（当前${effective ? '开' : '关'}）`)
    return effective
  }

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = { pendingText: '', cachedText: '', injectedTurn: -1, lastQuery: '', seenIds: new Set() }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private log(message: string): void {
    this.logLine(message)
  }

  /** 对外可用的日志出口（钩子里出现异常时要留痕，不能静默）。 */
  logLine(message: string): void {
    const line = `[workbench-knowledge] ${message}`
    this.recentLogs.push(line)
    if (this.recentLogs.length > 500) this.recentLogs.splice(0, this.recentLogs.length - 500)
    this.options.log?.(line)
  }

  /**
   * 取走最近的日志行（诊断/演示脚本用）。
   *
   * 为什么管理器要自己留一份：宿主 logger 走的是宿主日志文件，
   * 而"这一回合到底检索了什么"是验收要看的证据 ——
   * 演示脚本与排查都需要**不依赖宿主日志配置**就能拿到它。
   */
  drainLogs(): string[] {
    return this.recentLogs.splice(0, this.recentLogs.length)
  }

  /** 会话销毁时清掉状态（否则长跑进程里 Map 只会涨）。 */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  // ------------------------------------------------------------------ 候选集

  /**
   * 读取全部知识条目（带 TTL 缓存）。
   *
   * ## 为什么用 TTL 而不是"写入点主动失效"
   *
   * 知识库的写入点有四处（HTTP POST/PATCH/DELETE、`workbench_submit_knowledge` 草稿确认、
   * 界面批量操作、迁移回填）。要在每处挂失效回调，就是"同一个语义在 N 处各实现一遍" ——
   * 本项目第一大 bug 类别的标准配方（漏一处就变成"新知识永远查不到"，且很难归因）。
   *
   * 而这里可以完全绕开这个问题：**每个回合本来就会重算一次候选集**，
   * TTL 只影响"同一回合内多次装配"的重读次数。15s 的上限意味着
   * 一次会话里最坏情况是"刚写进去的知识要等 15 秒才可能被召回"，
   * 这个延迟在"回合边界"的时间尺度上不可观测 —— 用一点新鲜度换掉一整类 bug，划算。
   */
  private allEntries(): KnowledgeRow[] {
    const now = Date.now()
    if (this.candidateCache !== undefined && now - this.candidateCache.at < CANDIDATE_TTL_MS) return this.candidateCache.rows
    let rows: KnowledgeRow[] = []
    try {
      rows = listKnowledge(this.db, { limit: 500 })
    } catch (error) {
      // 读失败**不静默**：那一回合就是"没检索"，日志里要能看出来。
      this.log(`读取知识库失败（本回合不召回）：${error instanceof Error ? error.message : String(error)}`)
      rows = []
    }
    this.candidateCache = { at: now, rows }
    return rows
  }

  /**
   * 主动让候选缓存失效。
   *
   * 目前**没有调用点**（见 `allEntries()` 的注释：靠回合重算 + TTL，而不是在 N 个写入点挂回调）。
   * 保留它是为了将来真需要"写完立刻可召回"时有个唯一入口，并且测试可以直接驱动它。
   */
  invalidate(): void {
    this.candidateCache = undefined
  }

  /** 本任务链条的 id 集合（自身 + 祖先 + 后代）。 */
  private taskChain(taskId: string): Set<string> {
    const ids = new Set<string>([taskId])
    let cursor = getTask(this.db, taskId)
    let guard = 0
    while (cursor !== undefined && cursor.parentId !== null && guard < 32) {
      ids.add(cursor.parentId)
      cursor = getTask(this.db, cursor.parentId)
      guard += 1
    }
    const stack = [taskId]
    guard = 0
    while (stack.length > 0 && guard < 2000) {
      const current = stack.pop()!
      for (const child of this.childrenOf(current)) {
        if (ids.has(child)) continue
        ids.add(child)
        stack.push(child)
      }
      guard += 1
    }
    return ids
  }

  private childrenOf(parentId: string): string[] {
    const rows = this.db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(parentId) as unknown as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  /**
   * 候选集：**本任务/本任务树在前，全局在后**（验收要求"优先本任务…再扩到全局"）。
   *
   * 同一条不会出现两次（按 id 去重，保留任务域那份）。
   */
  candidates(taskId: string | null): RecallCandidate[] {
    const rows = this.allEntries()
    if (taskId === null) return rows.map((entry) => ({ entry, fromTask: false }))
    const chain = this.taskChain(taskId)
    const inTask: RecallCandidate[] = []
    const global: RecallCandidate[] = []
    for (const entry of rows) {
      const linked = entry.sourceTaskId !== null && chain.has(entry.sourceTaskId)
      if (linked) inTask.push({ entry, fromTask: true })
      else global.push({ entry, fromTask: false })
    }
    return [...inTask, ...global]
  }

  /** 会话 → 任务 id：先查 `task_sessions`（权威），再退到工作目录命名（兜底）。 */
  resolveTaskId(sessionId: string, cwd?: string): string | null {
    try {
      const linked = findTaskIdBySession(this.db, sessionId)
      if (linked !== undefined && getTask(this.db, linked) !== undefined) return linked
    } catch (error) {
      this.log(`会话→任务反查失败（退到工作目录命名）：${error instanceof Error ? error.message : String(error)}`)
    }
    const guessed = taskIdFromWorkspacePath(cwd)
    if (guessed !== undefined && getTask(this.db, guessed) !== undefined) return guessed
    return null
  }

  // ------------------------------------------------------------------ 检索

  /**
   * 检索并落日志。**所有入口（会话开始 / 回合收尾 / 工具）都走这一个函数**，
   * 于是"命中几条、注入没注入"永远只有一处实现（本仓第一大 bug 类别）。
   */
  recall(input: {
    sessionId: string | null
    taskId: string | null
    query: string
    trigger: 'session_start' | 'turn' | 'tool'
    /** 工具路径：不去重、不受开关限制（用户/模型显式要查就查）。 */
    explicit?: boolean
  }): RecallOutcome {
    const sessionId = input.sessionId ?? ''
    const state = sessionId === '' ? undefined : this.state(sessionId)
    const outcome = this.recallWith({
      sessionId,
      taskId: input.taskId,
      query: input.query,
      trigger: input.trigger,
      candidates: this.candidates(input.taskId),
      seen: state?.seenIds,
      explicit: input.explicit,
    })
    this.logOutcome({ trigger: input.trigger, query: input.query, outcome, injected: input.explicit !== true && outcome.hits.length > 0, sessionId, taskId: input.taskId })
    return outcome
  }

  /**
   * 纯检索（不落日志）—— 多句 query 合并（`prime`）要逐句调用它，
   * 最后只写**一行**合并后的日志：写多行会让"这一回合检索了几次"这个账变糊。
   */
  private recallWith(input: {
    sessionId: string
    taskId: string | null
    query: string
    trigger: 'session_start' | 'turn' | 'tool'
    candidates: RecallCandidate[]
    /** 会话已注入集合；不给（工具路径）就不去重。 */
    seen?: ReadonlySet<string>
    explicit?: boolean
  }): RecallOutcome {
    return recallKnowledge({
      query: input.query,
      candidates: input.candidates,
      minScore: this.options.minScore ?? RECALL_DEFAULTS.minScore,
      maxEntries: this.options.maxEntries ?? RECALL_DEFAULTS.maxEntries,
      excludeIds: input.explicit === true || input.seen === undefined ? [] : [...input.seen],
    })
  }

  /** 落一行召回日志（含"检索了哪些关键词、命中哪几条、是否注入"）+ 一行可读日志。 */
  private logOutcome(input: {
    trigger: string
    query: string
    outcome: RecallOutcome
    injected: boolean
    sessionId: string
    taskId: string | null
  }): void {
    const outcome = input.outcome
    let logId: number | undefined
    try {
      logId = appendRecallLog(this.db, {
        sessionId: input.sessionId === '' ? null : input.sessionId,
        taskId: input.taskId,
        trigger: input.trigger,
        outcome,
        injected: input.injected,
      })
    } catch (error) {
      this.log(`写召回日志失败（检索本身已完成）：${error instanceof Error ? error.message : String(error)}`)
    }
    const skip = outcome.skippedReason !== undefined ? `跳过（${outcome.skippedReason}）` : ''
    const tail = outcome.hits.length > 0
      ? `命中 ${outcome.hits.length} 条${outcome.droppedByScore > 0 ? `（另有 ${outcome.droppedByScore} 条低于阈值）` : ''}`
      : outcome.matched > 0
        ? `命中 ${outcome.matched} 条但全部被阈值 ${this.options.minScore ?? RECALL_DEFAULTS.minScore} 挡下`
        : '零命中（知识库里没有相关条目）'
    this.log(`[${input.trigger}]${skip} 检索「${input.query.slice(0, 60)}」关键词=[${outcome.terms.join(' ')}] → ${tail}`
      + (outcome.hits.length > 0 ? `：${outcome.hits.map((hit) => `${hit.id.slice(0, 8)}(${hit.score.toFixed(2)})`).join(' ')}` : '')
      + (logId === undefined ? '（日志未落库）' : `（日志 #${logId}）`))
  }

  /**
   * 会话开始时的"开工前"召回。
   *
   * ## 为什么用**两句 query**：任务标题 + 任务描述，分句检索后合并
   *
   * 只用标题在真实数据上命中率很低（实测：任务「修复选择文件出不了 C 盘」与
   * 知识「盘符根目录 parent 为 null 的坑」只共享一个"出"字 → 覆盖率 1/11 → 分数 0.05）。
   * 而任务**描述**里通常写着执行者会遇到的模块名、报错、约定 —— 那才是可检索的词。
   *
   * ⚠️ 但**绝不能把两句拼成一句**：拼起来覆盖率的分母翻倍，最相关的那条会从
   * 0.18 一路掉到阈值以下（实测踩到过）。`mergeRecallOutcomes` 的注释里有完整推导。
   */
  prime(sessionId: string, cwd?: string): RecallOutcome | undefined {
    if (!this.sessionEnabled(sessionId)) {
      this.log(`会话 ${sessionId} 自动召回已关闭 → 跳过开工前检索`)
      return undefined
    }
    const taskId = this.resolveTaskId(sessionId, cwd)
    const task = taskId === null ? undefined : getTask(this.db, taskId)
    const queries = [task?.title ?? '', task?.description ?? ''].map((part) => part.trim()).filter((part) => part !== '')
    if (queries.length === 0) {
      // 没有任务/标题就没有 query —— 不编一个。"开工前"这一时机交给引导层让模型主动查。
      this.log(`会话 ${sessionId} 未关联到任务（或任务无标题）→ 开工前不自动检索，改由模型按引导层主动查`)
      return undefined
    }
    const state = this.state(sessionId)
    const candidates = this.candidates(taskId)
    const outcome = mergeRecallOutcomes(queries.map((query) => ({
      query,
      outcome: this.recallWith({ sessionId, taskId, query, candidates, trigger: 'session_start', seen: state.seenIds }),
    })))
    this.logOutcome({ trigger: 'session_start', query: outcome.query, outcome, injected: outcome.hits.length > 0, sessionId, taskId })
    state.lastOutcome = outcome
    state.lastQuery = outcome.query
    state.pendingText = formatRecallText(outcome)
    state.injectedTurn = -1
    for (const hit of outcome.hits) state.seenIds.add(hit.id)
    return outcome
  }

  /**
   * 回合收尾预取：拿这一回合的用户提问检索，结果**下一回合**注入。
   *
   * 为什么不在装配时算：装配在模型步之前的关键路径上，任何查询/打分都在"用户等待"里；
   * 而且团队记忆踩过更狠的一条 —— 在装配期做重活会破坏提示前缀缓存。预取与之同构。
   */
  prefetch(sessionId: string, cwd: string | undefined, query: string): RecallOutcome | undefined {
    if (!this.sessionEnabled(sessionId)) return undefined
    const taskId = this.resolveTaskId(sessionId, cwd)
    const outcome = this.recall({ sessionId, taskId, query, trigger: 'turn' })
    const state = this.state(sessionId)
    state.lastOutcome = outcome
    state.lastQuery = query
    state.pendingText = formatRecallText(outcome)
    state.injectedTurn = -1
    for (const hit of outcome.hits) state.seenIds.add(hit.id)
    return outcome
  }

  /**
   * 装配期取本回合要注入的内容（**纯读**，不检索、不写库）。
   *
   * 同一回合内返回同一份文本（保前缀缓存）；没有就绪内容返回空串（**不插占位**）。
   */
  injectionFor(sessionId: string, turn: number): string {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return ''
    if (!this.sessionEnabled(sessionId)) return ''
    if (state.injectedTurn === turn) return state.cachedText
    if (state.pendingText !== '') {
      state.cachedText = state.pendingText
      state.injectedTurn = turn
      state.pendingText = ''
      this.log(`注入知识 ${state.cachedText.split('\n').filter((line) => line.startsWith('- [')).length} 条（session=${sessionId} turn=${turn}）`)
      return state.cachedText
    }
    return ''
  }

  /** 模型回报"用到了哪几条"（写进召回日志，作为"是否被引用"的证据）。 */
  reportUsage(sessionId: string, entryIds: string[]): { updated: number; unknown: string[] } {
    const known = new Set(this.allEntries().map((entry) => entry.id))
    const unknown = entryIds.filter((id) => !known.has(id))
    const updated = citeRecallLog(this.db, { sessionId, ids: entryIds.filter((id) => known.has(id)) })
    return { updated, unknown }
  }

  /** 给界面/端点：本会话最近的召回记录（含"是否被引用"）。 */
  sessionState(sessionId: string): { enabled: boolean; lastQuery: string; lastHits: Array<{ id: string; title: string; score: number; reason: string }> } {
    const state = this.sessions.get(sessionId)
    return {
      enabled: this.sessionEnabled(sessionId),
      lastQuery: state?.lastQuery ?? '',
      lastHits: state?.lastOutcome?.hits.map((hit) => ({ id: hit.id, title: hit.title, score: hit.score, reason: hit.reason })) ?? [],
    }
  }

  /** 任务是否存在（工具校验显式传入的 task_id：不存在就报错，绝不静默退回全库）。 */
  taskExists(taskId: string): boolean {
    return getTask(this.db, taskId) !== undefined
  }

  /**
   * 无副作用召回（**不写日志、不改会话态**）：给噪声实测与诊断脚本用。
   *
   * 为什么单开一个入口而不是让脚本自己拼 `recallKnowledge(...)`：
   * 那样脚本就得自己拿候选集、自己定阈值 —— 三处各算一遍，测出来的数字与线上行为无关。
   * 这里复用**同一个** `candidates()` 与同一份 `RECALL_DEFAULTS`。
   */
  recallToText(input: { sessionId?: string; taskId: string | null; query: string }): RecallOutcome {
    return recallKnowledge({
      query: input.query,
      candidates: this.candidates(input.taskId),
      minScore: this.options.minScore ?? RECALL_DEFAULTS.minScore,
      maxEntries: this.options.maxEntries ?? RECALL_DEFAULTS.maxEntries,
    })
  }

  /**
   * 工具路径（模型主动查）的日志。
   *
   * 与自动层的区别只有一条：**不写成 `injected`**（工具结果是给模型的对话内容，
   * 不是系统注入），其余字段完全一致 —— 于是"自动带出来的"与"模型主动查的"
   * 落在同一张表、同一套字段，可以直接对比噪声（这是验收第 3 条要的实测记录）。
   */
  logSearch(input: {
    sessionId: string
    taskId: string | null
    query: string
    terms: string[]
    hits: Array<{ id: string; title: string; score: number }>
    matched?: number
    droppedByScore?: number
  }): number | undefined {
    try {
      return appendRecallLog(this.db, {
        sessionId: input.sessionId === '' ? null : input.sessionId,
        taskId: input.taskId,
        trigger: 'tool',
        outcome: {
          query: input.query,
          terms: input.terms,
          hits: input.hits.map((hit) => ({
            id: hit.id, title: hit.title, score: hit.score, reason: '模型主动检索',
            snippet: '', terms: [], tags: [], fromTask: false, updatedAt: '', fileLink: null, sourceTaskId: null, kindCode: '',
          })),
          matched: input.matched ?? input.hits.length,
          droppedByScore: input.droppedByScore ?? 0,
          droppedByLimit: 0,
          droppedAsSeen: 0,
        },
        injected: false,
      })
    } catch (error) {
      this.log(`写工具检索日志失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}

/** 本回合的 turn 号（与团队记忆同一套取法：最后一个 turn/start 或 turn/end）。 */
export function currentTurnOf(agent: unknown): number {
  try {
    const session = (agent as { session?: { snapshotEvents?: () => unknown[]; events?: unknown[] } } | undefined)?.session
    const events = typeof session?.snapshotEvents === 'function'
      ? session.snapshotEvents() ?? []
      : session?.events ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { type?: string; turn?: unknown } | undefined
      if (event?.type === 'turn/start') {
        const raw = event.turn as { turn?: unknown } | undefined
        return Number(raw?.turn ?? event.turn ?? 0) || 0
      }
      if (event?.type === 'turn/end') return Number(event.turn ?? 0) || 0
    }
  } catch { /* 拿不到 turn 号不是致命问题：退回 0，注入仍会发生 */ }
  return 0
}

/** 从用户消息里取纯文本（可能有多段）。 */
export function textOfUserMessage(message: unknown): string {
  try {
    const content = (message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return ''
    return content
      .map((block) => (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : ''))
      .join('\n')
      .trim()
  } catch { return '' }
}

/**
 * 注册整套接线（引导层 + 自动注入 + 两个钩子）。
 *
 * 返回值里带 `manager`，供工具与路由共享**同一个**管理器实例 ——
 * 单会话开关、已注入集合这些状态必须只有一份（"同一个语义被独立计算多次"是本项目第一大 bug 类别）。
 */
export function installKnowledgeRecall(
  ctx: Context,
  db: DatabaseSync,
  options: KnowledgeRecallOptions = {},
): KnowledgeRecallManager {
  const manager = new KnowledgeRecallManager(db, {
    ...options,
    log: options.log ?? ((message) => { ctx.logger?.info?.(message) }),
  })
  const autoInject = options.autoInject !== false

  /**
   * `agent/session-start` 与 `agent/turn-stopping` 是**宿主（`@deepseek-ai/dsh-agent`）
   * 声明的事件**，本仓没有 import 那个包的 `Events` 增强 —— 所以这里用最小结构形状
   * （与本仓 `CommandsProbe` / `SlotsProbe` 一贯做法一致），并且在注册处做一次
   * `as never` 的显式转换：**要么宿主有这两个事件，要么我们根本不该编译通过**，
   * 而不是靠 `any` 把类型问题吞掉。
   */
  const events = ctx as unknown as {
    on: (name: string, listener: (payload: never) => void) => () => void
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:workbench-knowledge-guide',
    order: 260,
    text: KNOWLEDGE_GUIDE,
  }), 'dsh-personal-workbench: knowledge-guide')

  if (!autoInject) {
    ctx.logger?.info?.('[workbench-knowledge] 自动注入已按配置关闭（工具与开关仍然可用）')
    return manager
  }

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'workbench:knowledge-recall',
    order: 300,
    text: (assembly) => {
      try {
        const agent = (assembly as { agent?: { session?: { header?: { id?: string; origin?: string } } } } | undefined)?.agent
        const sessionId = agent?.session?.header?.id
        if (sessionId === undefined || sessionId === '') return ''
        // 子会话是"为某个具体委托而开"的短命上下文：把父会话的知识再带一遍是纯噪声。
        if (agent?.session?.header?.origin === 'subagent') return ''
        return manager.injectionFor(sessionId, currentTurnOf(agent))
      } catch (error) {
        // 绝不因为注入失败影响会话：留一行可读日志，然后什么都不注入。
        manager.logLine(`注入失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
        return ''
      }
    },
  }), 'dsh-personal-workbench: knowledge-recall')

  // 会话开始：登记"开工前"召回（能关联到任务才有 query）。
  events.on('agent/session-start', ((payload: { agent?: { session?: { header?: { id?: string; cwd?: string; origin?: string } } } }) => {
    try {
      const header = payload?.agent?.session?.header
      const sessionId = header?.id
      if (sessionId === undefined || sessionId === '') return
      if (header?.origin === 'subagent') return
      manager.prime(sessionId, header?.cwd)
    } catch (error) {
      manager.logLine(`会话开始处理失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)

  /**
   * 回合收尾预取：**同步返回、绝不做 I/O 之外的重活**。
   *
   * 团队记忆记过一条硬约束：`agent/turn-stopping` 是串行 await 的收尾钩子，
   * 在这里 await 网络会让"上传慢 → 对话看起来失效"。这里是本地 SQLite 读 + 纯打分，
   * 毫秒级，但仍然**全部包在 try/catch 内**：宁可这一回合不召回，也不能影响对话。
   */
  events.on('agent/turn-stopping', ((payload: { agent?: { session?: { header?: { id?: string; cwd?: string; origin?: string } } }; turn?: number }) => {
    try {
      const header = payload?.agent?.session?.header
      const sessionId = header?.id
      if (sessionId === undefined || sessionId === '') return
      if (header?.origin === 'subagent') return
      const snapshot = snapshotEvents(payload?.agent?.session)
      const query = textOfUserMessage(latestUserMessage(snapshot))
      if (query === '') return
      manager.prefetch(sessionId, header?.cwd, query)
    } catch (error) {
      manager.logLine(`回合预取失败（已忽略，不影响对话）：${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)

  events.on('agent/disposed', ((payload: { agent?: { session?: { header?: { id?: string } } } }) => {
    const sessionId = payload?.agent?.session?.header?.id
    if (sessionId !== undefined) manager.forget(sessionId)
  }) as never)

  ctx.logger?.info?.(`[workbench-knowledge] 已注册：引导层 + 自动召回（阈值 ${options.minScore ?? RECALL_DEFAULTS.minScore}、上限 ${options.maxEntries ?? RECALL_DEFAULTS.maxEntries} 条）`)
  return manager
}

/** 会话事件快照（宿主版本之间字段名有差异，两种都认）。 */
function snapshotEvents(session: unknown): unknown[] {
  try {
    const shaped = session as { snapshotEvents?: () => unknown[]; events?: unknown[] } | undefined
    if (typeof shaped?.snapshotEvents === 'function') return shaped.snapshotEvents() ?? []
    return shaped?.events ?? []
  } catch { return [] }
}

/** 最后一条 user/message（本回合的提问）。 */
function latestUserMessage(events: unknown[]): unknown {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string; data?: { message?: unknown } } | undefined
    if (event?.type === 'user/message') return event.data?.message
  }
  return undefined
}
