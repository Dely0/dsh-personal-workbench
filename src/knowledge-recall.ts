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
import { getKnowledge, getTask, listKnowledge } from './db/repo.js'
import type { KnowledgeRow } from './db/repo/knowledge.js'
import { findTaskIdBySession } from './db/repo/task-sessions.js'
import { readMeta } from './db/repo/meta.js'
import { appendRecallLog, citeRecallLog, readSessionOverrides, writeSessionOverride } from './knowledge-recall-log.js'
import {
  citationMatch,
  formatHintText,
  formatRecallText,
  formatRelevance,
  looksLikeErrorReport,
  mergeRecallOutcomes,
  recallKnowledge,
  RECALL_DEFAULTS,
  taskIdFromWorkspacePath,
  termStatsOf,
  willInject,
  type RecallCandidate,
  type RecallOutcome,
  type TermStats,
} from './shared/knowledgeRecall.js'

/** 完整知识条目 id（uuid v4 形态）。工具按 id 直读时只认这个，不做前缀模糊匹配。 */
const ENTRY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 空结论：构造"没有可检索内容"的结论时只有一处实现（少写一遍就少一处漏字段）。 */
const EMPTY_OUTCOME: RecallOutcome = {
  query: '', hits: [], nearMisses: [], matched: 0, droppedByScore: 0, droppedByLimit: 0, droppedAsSeen: 0, droppedAsSuperseded: 0, terms: [],
}

/**
 * 装配键：`回合号 + 本回合用户消息原文`。
 *
 * 一个语义一个实现 —— "同一回合内文本是否稳定"与"本回合消息是否被检索过"
 * 这两件事都读它，各写一遍迟早会出现"缓存说是同一回合、观测说没检索"的自相矛盾。
 */
function assemblyKeyOf(turn: number, queries: readonly string[]): string {
  return `${turn}\u0000${queries.join('\u0001')}`
}

/**
 * 剥掉注入文本里的包裹符号（`[id]` / `【id】` / `entry_id:id`）后取 id。
 *
 * 为什么必须容忍这些写法：注入文本与工具输出里 id 都是 `[xxxx]` 形态，
 * 模型会**原样**把它当成 query 传回来 —— 只认裸 uuid 的话这条路又会断在最后一步。
 * 不是 uuid 就返回 `undefined`（调用方据此走关键词检索那条老路，不做别的猜测）。
 */
export function unwrapEntryId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
    .replace(/^\[|\]$/g, '')
    .replace(/^【|】$/g, '')
    .replace(/^(?:entry[_-]?id|id)\s*[:=]\s*/i, '')
    .trim()
  return ENTRY_ID_RE.test(trimmed) ? trimmed.toLowerCase() : undefined
}

/** 这个 query 是不是"按 id 直读"（工具与日志共用同一份判定，不许各判一次）。 */
export function isEntryIdQuery(raw: unknown): boolean {
  return unwrapEntryId(raw) !== undefined
}

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
  /** 「开工前」这一时机是否已经成功做过（没成功就允许在关联到手后补一次）。 */
  primed: boolean
  /**
   * 「开工前」算出来、**还没随装配送达**的那一份（v1.15.7 起）。
   *
   * 为什么挂在这里而不是直接写 `pendingText`：实测（turn 15）当轮算出的结果
   * 被随后一次 `session_start` 的 `prime` **覆盖** → 从未送达（"算了却没送到"）。
   * 两份各存各的、装配期**合并**，覆盖在结构上就不可能发生。
   */
  primeOutcome?: RecallOutcome
  /** 已算好、等装配期取走的文本。 */
  pendingText: string
  /** 已注入文本（同一回合内保持稳定 —— 保前缀缓存）。 */
  cachedText: string
  /**
   * 本回合装配的键（`turn` + 本回合用户消息原文）。
   *
   * 作用有二：① 同一回合内多次装配返回同一份文本（保提示前缀缓存）；
   * ② 回合收尾据此判断"这一回合的用户消息**是否被纳入过检索**" ——
   * 键不同就说明没检索，必须留一行痕迹（静默丢件是本仓禁区）。
   */
  assemblyKey: string
  injectedTurn: number
  lastQuery: string
  /** 已经注入过的条目 id：默认不再重复占额度（噪声控制的关键一条）。 */
  seenIds: Set<string>
  /**
   * 已经**提示过**（差一点点那一档）的条目 id。
   *
   * 为什么要单独一个集合：提示行是"可能相关、仅供参考"，它比完整注入轻得多，
   * 但**同一条在同一会话里反复提示**正是验收第 5 条要拦的"反复注入不相关条目"。
   * 所以提示也去重，而且与 `seenIds` 分开 —— 提示过的条目将来真命中了，
   * 仍然应该被完整注入（不该因为"提示过"就被永久压制）。
   */
  hintedIds: Set<string>
  /** 最近一次召回的结论（供日志页/工具回显）。 */
  lastOutcome?: RecallOutcome
  /**
   * **本回合真的注入给模型的条目**（id → 标题）。P4 的引用自动判定用它：
   * 只判"刚注入过、且回答里出现其标题/id"的那些，不给历史注入翻旧账。
   */
  delivered: Map<string, string>
  /** `delivered` 属于哪个回合（引用判定只在**同一回合**内成立）。 */
  deliveredTurn: number
  /** 已算好、等装配期真正取走的那一批条目（`injectionFor` 落成 `delivered`）。 */
  pendingHits: Array<{ id: string; title: string }>
  /** 这一回合模型是否调用过检索工具（P5 的 suggested_miss 判据之一）。 */
  toolUsedThisTurn: boolean
}

/** 知识候选快照的缓存时长：题目是"每个回合算一次"，但同一回合内可能装配多次。 */
const CANDIDATE_TTL_MS = 15_000

/**
 * 候选集上限（v1.15.4 从写死的 500 提上来）。
 *
 * 500 是本机仓库层对 `listKnowledge` 的默认夹取上限，而召回需要**全量**候选 ——
 * 一个 60 条的库看不出差别，涨到 523 条就会静默丢掉 23 条（自查 F3 实测）。
 * 5000 对"逐字打分 + 本地 SQLite"仍是毫秒级（1000 条实测 P95 < 2ms）。
 */
export const RECALL_MAX_CANDIDATES = 5000

export interface KnowledgeRecallOptions {
  /** 全局缺省是否开自动召回（配置项；`false` 时仍可用工具手动查）。 */
  enabled?: boolean
  /** 阈值 / 条数上限覆盖（测试与用户偏好用；缺省取 `RECALL_DEFAULTS`）。 */
  minScore?: number
  maxEntries?: number
  /** 信息量饱和阈值覆盖（IDF 标定脚本用；正常路径走 `RECALL_DEFAULTS.massSat`）。 */
  massSat?: number
  /** 日志回调（宿主 logger 或 console）。 */
  log?: (message: string) => void
  /** 是否注册自动注入（`false` 只注册工具与开关）。 */
  autoInject?: boolean
}

export class KnowledgeRecallManager {
  private readonly db: DatabaseSync
  private readonly sessions = new Map<string, SessionState>()
  private readonly options: KnowledgeRecallOptions
  private candidateCache: { at: number; rows: KnowledgeRow[]; stats: TermStats } | undefined
  /** 最近日志行（上限 500，见 `drainLogs`）。 */
  private readonly recentLogs: string[] = []

  constructor(db: DatabaseSync, options: KnowledgeRecallOptions = {}) {
    this.db = db
    this.options = options
  }

  /**
   * 全局开关：**meta 是唯一权威源**，`Config.knowledgeRecallEnabled` 只在 meta 还没被
   * 写过时当缺省值。
   *
   * 修的是什么（v1.15.4，独立审查者 F2）：原来是 `config 优先`，
   * 于是部署方一旦写了 `enabled`，用户在设置页勾选/取消就**完全不起作用** ——
   * 界面显示的状态与真实行为相反，是个假控件（本项目已经罚过一次"排序方向按钮是假控件"）。
   * 现在的优先级：用户显式动作（meta）> 部署缺省（config）> 出厂值（开）。
   */
  autoEnabled(): boolean {
    const stored = readMeta(this.db, AUTO_RECALL_KEY)
    if (stored !== undefined) return stored !== '0'
    return this.options.enabled ?? true
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
      state.primeOutcome = undefined
      state.cachedText = ''
      state.injectedTurn = -1
      state.assemblyKey = ''
    } else {
      /**
       * 重新打开时**清掉去重集合**：用户关掉再打开，语义是"重新开始"，而不是
       * "接着上次的已注入集合继续跳过"。留着它会表现为"打开了却再也不带出任何东西" ——
       * 那正是"开关看起来是开的、实际没生效"这一类最难归因的缺陷。
       * 提示去重集合同理一起清（否则重开后连提示都没有，同样像"没生效"）。
       */
      state.seenIds.clear()
      state.hintedIds.clear()
    }
    this.log(`会话 ${sessionId} 自动召回 → ${mode}（当前${effective ? '开' : '关'}）`)
    return effective
  }

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = { primed: false, pendingText: '', cachedText: '', injectedTurn: -1, lastQuery: '', assemblyKey: '', seenIds: new Set(), hintedIds: new Set(), delivered: new Map(), deliveredTurn: -1, pendingHits: [], toolUsedThisTurn: false }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * 把一次召回的结论落成"下一回合要注入的文本"（v1.15.6：两档闸门）。
   *
   * 规则只有三条，且**顺序即优先级**：
   * 1. 有完整命中 → 注入完整块（`formatRecallText`），提示不参与（有了确切的还要"可能"干嘛）；
   * 2. 没有完整命中、但有**没见过**的提示候选 → 注入提示行，并把这些 id 记进 `hintedIds`
   *    （同一会话不重复提示同一条）；
   * 3. 都没有 → 空串（**不插占位**，保前缀缓存）。
   *
   * 抽成一个私有方法是因为 `prime` 与 `prefetch` **两处**都要用它 ——
   * 写两遍就会出现"开工前会提示、回合预取不提示"这种一处生效一处的偏差。
   */
  private buildPending(state: SessionState, outcome: RecallOutcome): void {
    if (outcome.hits.length > 0) {
      state.pendingText = formatRecallText(outcome)
      // P4：记下"这一批准备送出去的条目"；真正**送达**由 `injectionFor` 落账
      state.pendingHits = outcome.hits.map((hit) => ({ id: hit.id, title: hit.title }))
      state.injectedTurn = -1
      return
    }
    const fresh = (outcome.nearMisses ?? []).filter((hit) => !state.hintedIds.has(hit.id))
    if (fresh.length === 0) {
      state.pendingText = ''
      state.pendingHits = []
      state.injectedTurn = -1
      return
    }
    for (const hit of fresh) state.hintedIds.add(hit.id)
    state.pendingText = formatHintText(outcome, fresh)
    /**
     * P4：**提示行不参与引用自动判定**。提示的语义是"未必相关、仅供参考"，
     * 模型顺着它去查是正常动作，把"我怀疑过这条"记成"我引用了这条"会让证据失真。
     * 所以这里清空待送达集合，只有完整注入才有资格被自动标记引用。
     */
    state.pendingHits = []
    this.log(`提示 ${fresh.length} 条"可能相关"（未达注入闸门，仅一行提示）：${fresh.map((hit) => `${hit.id.slice(0, 8)}(${formatRelevance(hit.score)})`).join(' ')}`)
    state.injectedTurn = -1
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
      rows = listKnowledge(this.db, { limit: RECALL_MAX_CANDIDATES })
      /**
       * 候选集被上限截断时**必须留痕**（v1.15.4，自查 F3）。
       *
       * 原先写死 `limit: 500` 而 `listKnowledge` 又把上限夹在 500：
       * 知识库涨到 523 条时，第 501 条起**永远召不回来**，而且一个字都不说 ——
       * 静默截断是本仓明令禁止的一类（"标签超过 12 个点不到"就是被当 bug 修掉的）。
       * 现在上限提到 5000，真撞上也只是"日志里说清楚"，不假装没事。
       */
      if (rows.length >= RECALL_MAX_CANDIDATES) {
        this.log(`知识库条目数达到候选集上限 ${RECALL_MAX_CANDIDATES}，超出部分本次不参与召回（请上调 RECALL_MAX_CANDIDATES）`)
      }
    } catch (error) {
      // 读失败**不静默**：那一回合就是"没检索"，日志里要能看出来。
      this.log(`读取知识库失败（本回合不召回）：${error instanceof Error ? error.message : String(error)}`)
      rows = []
    }
    this.candidateCache = { at: now, rows, stats: termStatsOf(rows.map((entry) => ({ entry, fromTask: false }))) }
    return rows
  }

  /**
   * 语料的词信息量统计（与候选集**同一次**缓存）。
   *
   * 为什么和候选集一起缓存：`termStatsOf` 要扫全库正文（本机 60 条毫秒级，
   * 涨到几千条就不该每个回合重扫）。缓存键与候选集完全一致 ——
   * 分开缓存迟早会出现"候选换了、统计还是旧的"这种静默偏差。
   */
  corpusStats(): TermStats {
    this.allEntries()
    return this.candidateCache?.stats ?? { size: 0, df: new Map() }
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
      stats: this.corpusStats(),
      minScore: this.options.minScore ?? RECALL_DEFAULTS.minScore,
      maxEntries: this.options.maxEntries ?? RECALL_DEFAULTS.maxEntries,
      massSat: this.options.massSat,
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
    const hints = outcome.nearMisses ?? []
    // P2：被压制（已取代/已过期）的条数必须单独报出来，否则"为什么新写的那条没被召回"没法归因
    const suppressed = (outcome.droppedAsSuperseded ?? 0) > 0 ? `，另有 ${outcome.droppedAsSuperseded} 条已被取代/已过期（压制）` : ''
    const tail = outcome.hits.length > 0
      ? `命中 ${outcome.hits.length} 条${outcome.droppedByScore > 0 ? `（另有 ${outcome.droppedByScore} 条低于阈值）` : ''}`
      : hints.length > 0
        // 有提示没命中：日志要写成"提示 N 条"，不能写成"零命中"—— 会话里确实留了一行
        ? `未达注入闸门，但提示 ${hints.length} 条"可能相关"`
        : outcome.matched > 0
          ? `命中 ${outcome.matched} 条但全部被阈值 ${this.options.minScore ?? RECALL_DEFAULTS.minScore} 挡下`
          : '零命中（知识库里没有相关条目）'
    const detail = outcome.hits.length > 0
      ? outcome.hits.map((hit) => `${hit.id.slice(0, 8)}(${formatRelevance(hit.score)})`).join(' ')
      : hints.map((hit) => `${hit.id.slice(0, 8)}(${formatRelevance(hit.score)})`).join(' ')
    this.log(`[${input.trigger}]${skip} 检索「${input.query.slice(0, 60)}」关键词=[${outcome.terms.join(' ')}] → ${tail}${suppressed}`
      + (detail === '' ? '' : `：${detail}`)
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
  /**
   * 「开工前」那几句 query（任务标题 + 任务描述）+ 解析到的任务。
   *
   * 抽出来是因为它有两个调用点：会话开始（正常路径）与**回合收尾的补做**
   * （关联晚到时，见 `prefetch`）。判据只能有一处实现。
   */
  private primeQueries(sessionId: string, cwd?: string): { taskId: string | null; queries: string[] } {
    const taskId = this.resolveTaskId(sessionId, cwd)
    const task = taskId === null ? undefined : getTask(this.db, taskId)
    const queries = [task?.title ?? '', task?.description ?? ''].map((part) => part.trim()).filter((part) => part !== '')
    return { taskId, queries }
  }

  prime(sessionId: string, cwd?: string): RecallOutcome | undefined {
    if (!this.sessionEnabled(sessionId)) {
      this.log(`会话 ${sessionId} 自动召回已关闭 → 跳过开工前检索`)
      return undefined
    }
    const { taskId, queries } = this.primeQueries(sessionId, cwd)
    if (queries.length === 0) {
      /**
       * 没有任务/标题就没有 query —— 不编一个。
       *
       * 但**不把 `primed` 置真**：会话开始时 `task_sessions` 往往还没建立
       * （客户端是先 `sessions.prompt()`、随后才 POST 关联），所以这里要留着
       * 让 `prefetch` 在**关联到手之后补做一次**。这一行日志就是"这次没检索"的凭据。
       */
      this.log(`会话 ${sessionId} 未关联到任务（或任务无标题）→ 开工前不自动检索，改由模型按引导层主动查（关联到手后会补一次）`)
      return undefined
    }
    const state = this.state(sessionId)
    const outcome = mergeRecallOutcomes(queries.map((query) => ({
      query,
      outcome: this.recallWith({ sessionId, taskId, query, candidates: this.candidates(taskId), trigger: 'session_start', seen: state.seenIds }),
    })), { maxEntries: this.maxEntries() })
    this.logOutcome({ trigger: 'session_start', query: outcome.query, outcome, injected: willInject(outcome), sessionId, taskId })
    state.primed = true
    state.lastOutcome = outcome
    state.lastQuery = outcome.query
    /**
     * 只**挂起**，不直接写 `pendingText`（v1.15.7）。
     *
     * 实测事故：turn 15 当轮算出的结果（`#27 … matched=61`）被 10:04:33 一次晚到的
     * `session_start` prime（`#29`）**覆盖** → 从未送达。两份各存各的、装配期合并，
     * 覆盖在结构上就不可能发生。
     */
    state.primeOutcome = willInject(outcome) ? outcome : undefined
    for (const hit of outcome.hits) state.seenIds.add(hit.id)
    return outcome
  }

  /** 单回合条数上限（config > 缺省）。 */
  private maxEntries(): number {
    return Math.max(1, this.options.maxEntries ?? RECALL_DEFAULTS.maxEntries)
  }

  /**
   * 「开工前」还没成功过就补做一次（返回是否补做了）。
   *
   * 判据只有一处：`state.primed`。会话开始时 `task_sessions` 往往还没建立
   * （客户端先 `sessions.prompt()`、随后才 POST 关联），所以不能把
   * "那一刻查不到任务"当成"这个会话永远不做开工前召回"。
   */
  primeIfNeeded(sessionId: string, cwd?: string): RecallOutcome | undefined {
    if (this.state(sessionId).primed) return undefined
    return this.prime(sessionId, cwd)
  }

  /**
   * **本回合的检索（唯一实现）**：开工前挂起的那一份 + 本回合**每一句**用户消息，
   * 合并后写成"待装配取走"的文本。
   *
   * 为什么必须是"每一句"而不是"最后一句"：实测 turn 16 那一轮里有两条用户本人消息 ——
   * 实质提问 + 随后的「停」。旧实现只取最后一条（「停」）、被 `isTrivialQuery` 判为琐碎 →
   * **那句实质提问从未被检索过**，而库里明明有一条 0.72 相关度的条目。
   * 这是"静默丢件"（账上看不出来的丢），所以取词范围与记账口径都在这一处。
   */
  private recallForTurn(sessionId: string, cwd: string | undefined, queries: string[]): RecallOutcome {
    const state = this.state(sessionId)
    // 「开工前」还没成功过就补做一次（v1.15.4 修的 F4：会话开始时通常还没有 task_sessions 关联）
    this.primeIfNeeded(sessionId, cwd)

    const parts: Array<{ query: string; outcome: RecallOutcome }> = []
    if (state.primeOutcome !== undefined) {
      parts.push({ query: state.primeOutcome.query, outcome: state.primeOutcome })
      state.primeOutcome = undefined
    }
    const { taskId } = this.primeQueries(sessionId, cwd)
    for (const query of queries) {
      const turn = this.recallWith({
        sessionId,
        taskId,
        query,
        candidates: this.candidates(taskId),
        trigger: 'turn',
        seen: state.seenIds,
      })
      this.logOutcome({ trigger: 'turn', query, outcome: turn, injected: willInject(turn), sessionId, taskId })
      parts.push({ query, outcome: turn })
    }

    const outcome = parts.length === 0
      ? { ...EMPTY_OUTCOME, query: '', skippedReason: '本回合没有可检索的用户消息' }
      : parts.length === 1
        ? parts[0].outcome
        : mergeRecallOutcomes(parts, { maxEntries: this.maxEntries() })
    state.lastOutcome = outcome
    state.lastQuery = outcome.query
    this.buildPending(state, outcome)
    for (const hit of outcome.hits) state.seenIds.add(hit.id)
    return outcome
  }

  /**
   * 回合收尾预取（**保留的底层入口**：测试与诊断脚本直接驱动它）。
   *
   * v1.15.7 起自动路径不再走这里 —— 检索移到**装配期**（`assemblyInjection`），
   * 因为本仓检索是本地 SQLite 毫秒级，"回合收尾预取 → 下回合注入"那个形状
   * 是从团队记忆照搬的，而团队记忆延后的前提是**它的检索要出网**（5s 超时、云端优先）。
   * 抄一个带网络前提的设计，代价是：知识晚一轮到、话题一换就错位、
   * 一轮多条用户消息时前一条被静默丢掉（实测事故）。
   */
  prefetch(sessionId: string, cwd: string | undefined, query: string): RecallOutcome | undefined {
    if (!this.sessionEnabled(sessionId)) return undefined
    return this.recallForTurn(sessionId, cwd, [query])
  }

  /**
   * **装配期取本回合要注入的内容**（自动召回的唯一权威入口，v1.15.7）。
   *
   * 用**当前正在被回答的那条用户消息**检索：会话日志事件顺序是
   * `turn/start` → `user/message` → `request/header`，所以装配期消息已经在事件里
   * （`test/knowledgeRecallWiring.test.mjs` 用真实 `SessionEvent` 形状钉住了这一点）。
   *
   * 三条纪律：
   * 1. **同一回合内文本稳定**：键（turn + 本回合用户消息）没变就直接复用缓存 ——
   *    保提示前缀缓存，也保证"装配多次只算一次检索"（账不被装配次数放大）；
   * 2. **不插占位**：没有内容返回空串；
   * 3. **不静默**：读取失败、没有消息、跳过检索都留一行可读日志或一条召回日志。
   */
  assemblyInjection(sessionId: string, cwd: string | undefined, agent: unknown): string {
    if (!this.sessionEnabled(sessionId)) return ''
    const state = this.state(sessionId)
    const turn = currentTurnOf(agent)
    const queries = currentTurnQueries(agent)
    const key = assemblyKeyOf(turn, queries)
    if (state.assemblyKey === key) return state.cachedText
    state.assemblyKey = key

    if (queries.length > 0) {
      this.recallForTurn(sessionId, cwd, queries)
      const text = this.injectionFor(sessionId, turn)
      state.cachedText = text
      return text
    }
    /**
     * 本回合还没有用户消息（罕见：装配早于 `user/message` 落进事件）。
     * **不写 assemblyKey 的终态** —— 否则那条消息到达后这一回合就再也不会被检索，
     * 正好复现我们要修的那个 bug。所以这里把键还原成"未装配过"。
     */
    const text = this.injectionFor(sessionId, turn)
    state.cachedText = text
    state.assemblyKey = ''
    return text
  }

  /**
   * 回合收尾的**观测**：本回合有用户消息、但装配期一次检索都没发生 → 留一行痕迹。
   *
   * 为什么必须有：本仓最忌讳"该做的事没做、账上看不出来"。turn 16 那次事故在账上
   * 只剩一行「停」，实质提问**一个字都没提** —— 有了这条，同样的丢失会立刻现形。
   * 只观测、不强制检索（不改变行为，也就不引入新的行为风险）。
   */
  noteUnretrieved(sessionId: string, cwd: string | undefined, agent: unknown): void {
    if (!this.sessionEnabled(sessionId)) return
    const queries = currentTurnQueries(agent)
    if (queries.length === 0) return
    const turn = currentTurnOf(agent)
    if (this.state(sessionId).assemblyKey === assemblyKeyOf(turn, queries)) return
    const query = queries.join(' ／ ')
    this.logLine(`[turn] ${turn} 回合有用户消息但**未纳入检索**（装配期没发生）：「${query.slice(0, 120)}」`)
    const outcome: RecallOutcome = {
      ...EMPTY_OUTCOME,
      query,
      skippedReason: '未纳入检索（本回合装配期没有发生检索）',
    }
    try {
      appendRecallLog(this.db, { sessionId, taskId: this.resolveTaskId(sessionId, cwd), trigger: 'turn', outcome, injected: false })
    } catch (error) {
      this.log(`写"未纳入检索"日志失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 装配期取本回合要注入的内容（**不检索、不写库**）。
   *
   * 同一回合内返回同一份文本（保前缀缓存）；没有就绪内容返回空串（**不插占位**）。
   *
   * ⚠️ v1.15.7 起自动路径的入口是 `assemblyInjection`（它在调用本方法**之前**做当轮检索）。
   * 本方法保留为底层入口：测试与 `prime` 单独驱动时（只挂起开工前那一份）也能取到文本。
   */
  injectionFor(sessionId: string, turn: number): string {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return ''
    if (!this.sessionEnabled(sessionId)) return ''
    if (state.injectedTurn === turn) return state.cachedText
    // 开工前那份如果还挂着（本回合没有当轮检索），在这里落成待注入文本。
    if (state.pendingText === '' && state.primeOutcome !== undefined) {
      const prime = state.primeOutcome
      state.primeOutcome = undefined
      this.buildPending(state, prime)
    }
    if (state.pendingText !== '') {
      state.cachedText = state.pendingText
      state.injectedTurn = turn
      state.pendingText = ''
      // P4：这一刻才算"送达"—— 引用自动判定只认真正进过会话的条目
      state.delivered = new Map(state.pendingHits.map((hit) => [hit.id, hit.title]))
      state.deliveredTurn = turn
      state.pendingHits = []
      /**
       * 日志要如实区分**注入了完整块**还是**只给了一行提示** ——
       * 两者在会话里的分量完全不同，混成一句"注入知识 N 条"会让日志失去判据价值
       * （提示行的条目数在这里恒为 0，因为提示行不是 `- [id]` 那种条目行）。
       */
      const entryLines = state.cachedText.split('\n').filter((line) => line.startsWith('- [')).length
      const isHint = entryLines === 0
      this.log(isHint
        ? `提示 1 行"可能相关"（未达注入闸门；session=${sessionId} turn=${turn}）`
        : `注入知识 ${entryLines} 条（session=${sessionId} turn=${turn}）`)
      return state.cachedText
    }
    return ''
  }

  /**
   * 回合收尾的最后一步：把"本回合用过检索工具"的标记复位（P5 的判据要按回合算）。
   *
   * 为什么不放在回合开始时清：`agent/turn-stopping` 是每个回合的确定终点，
   * 而"回合开始"没有等价的可靠钩子（装配期会被调用多次）。在终点复位，
   * 语义就是"下一次收尾之前有没有用过工具"，简单且可判定。
   */
  noteTurnStopped(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state !== undefined) state.toolUsedThisTurn = false
  }

  /** 模型回报"用到了哪几条"（写进召回日志，作为"是否被引用"的证据）。 */
  reportUsage(sessionId: string, entryIds: string[]): { updated: number; unknown: string[] } {
    const known = new Set(this.allEntries().map((entry) => entry.id))
    const unknown = entryIds.filter((id) => !known.has(id))
    const updated = citeRecallLog(this.db, { sessionId, ids: entryIds.filter((id) => known.has(id)) })
    return { updated, unknown }
  }

  /**
   * **回合收尾的引用自动判定**（P4）—— 替代/补足"靠模型自觉调 report_usage"。
   *
   * 判据只有一条（`citationMatch`）：这一回合**刚注入过**的条目，其 id 或标题前缀
   * 出现在模型这一回合的回答里。不提就不标（**不许瞎标**：标错会让"注入过但没人引用"
   * 这条证据失真，而失真的证据会让人删掉有用的知识）。
   *
   * 三个刻意的边界：
   * 1. 只判**本回合注入**的条目（`deliveredTurn === 当前回合`）—— 不翻旧账；
   * 2. **提示行注入的不算**（`buildPending` 里已清空 delivered）—— 那是"仅供参考"；
   * 3. 每次自动标记都留一行日志（含命中了几条、落到几行日志），可回看可申诉。
   */
  autoCite(sessionId: string, agent: unknown): number {
    const state = this.sessions.get(sessionId)
    if (state === undefined || state.delivered.size === 0) return 0
    if (state.deliveredTurn !== currentTurnOf(agent)) return 0
    const answer = assistantTextOf(agent)
    if (answer === '') return 0
    const items = [...state.delivered].map(([id, title]) => ({ id, title }))
    const ids = citationMatch(answer, items)
    if (ids.length === 0) return 0
    for (const id of ids) state.delivered.delete(id)
    const updated = citeRecallLog(this.db, { sessionId, ids })
    this.log(`[cite] 回答里出现本回合注入条目的标题/id → 自动标记引用 ${ids.length} 条（落到 ${updated} 行召回日志）：${ids.map((id) => id.slice(0, 8)).join(' ')}`)
    return updated
  }

  /**
   * **「该查未查」观测**（P5）：用户这句话像在报错，而这一回合模型一次检索工具都没调过
   * → 落一行 `suggested_miss`。
   *
   * 只观测、不强制（不替模型做决定，也不改变任何既有行为）。为什么还是必须落库：
   * 本仓的插件可读日志（`manager.logLine`）在本机**没落盘**（`dsh-web.log` 是 0 字节），
   * 只打一行控制台等于没有证据 —— 那正是"静默丢件"的另一种形态。
   */
  noteSuggestedMiss(sessionId: string, cwd: string | undefined, agent: unknown): void {
    if (!this.sessionEnabled(sessionId)) return
    if (this.sessions.get(sessionId)?.toolUsedThisTurn === true) return
    const queries = currentTurnQueries(agent)
    if (queries.length === 0) return
    const text = queries.join(' ')
    if (!looksLikeErrorReport(text)) return
    this.logLine(`[suggested_miss] 本轮像在报错但没调用检索工具：「${text.slice(0, 80)}」（只观测，不强制）`)
    try {
      appendRecallLog(this.db, {
        sessionId,
        taskId: this.resolveTaskId(sessionId, cwd),
        trigger: 'suggested_miss',
        outcome: { ...EMPTY_OUTCOME, query: text, skippedReason: 'suggested_miss：本轮疑似报错但没有调用检索工具（只观测）' },
        injected: false,
      })
    } catch (error) {
      this.log(`写 suggested_miss 日志失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 给界面/端点：本会话最近的召回记录（含"是否被引用"）。 */
  sessionState(sessionId: string): { enabled: boolean; lastQuery: string; lastHits: Array<{ id: string; title: string; relevance: number; reason: string }> } {
    const state = this.sessions.get(sessionId)
    return {
      enabled: this.sessionEnabled(sessionId),
      lastQuery: state?.lastQuery ?? '',
      // 回显用**展示相关度**（与注入文本同一口径），不把内部原始分递出去
      lastHits: state?.lastOutcome?.hits.map((hit) => ({ id: hit.id, title: hit.title, relevance: hit.relevance, reason: hit.reason })) ?? [],
    }
  }

  /** 任务是否存在（工具校验显式传入的 task_id：不存在就报错，绝不静默退回全库）。 */
  taskExists(taskId: string): boolean {
    return getTask(this.db, taskId) !== undefined
  }

  /**
   * 按 id 取**单条**（工具路径的"展开全文"，v1.15.5）。
   *
   * ## 为什么必须有这条路
   *
   * 在此之前，`workbench_search_knowledge` 只会把 query 当**关键词**抽词打分，
   * 而注入文本却写着"需要展开某条时用返回里的 id 再查一次" —— 传 uuid 进去
   * **必然零命中**（实测 2026-09-17）。于是 52 条带 `file_link` 的镜像型条目
   * 在正常会话里只剩 160 字摘要可用：知识库只兑现了"检索"，没兑现"消费"。
   *
   * ## 为什么只认**完整 uuid**、不做前缀模糊匹配
   *
   * 前缀匹配会引入"两三条都匹配 → 挑哪条"的选择题，而静默挑一条正是本仓
   * 明令禁止的（挑错等于把另一条知识当成事实塞进上下文）。完整 uuid 没有歧义：
   * 命中就返回，没命中就明说没有。要短写法可以自己截，但工具不替用户猜。
   *
   * 直接 `getKnowledge` 读库（不走候选缓存）：这是一次**指定 id 的直读**，
   * 不该受"15 秒候选缓存"影响 —— 刚从待确认里确认的条目也必须能立刻读到。
   */
  findEntryById(rawId: string): KnowledgeRow | undefined {
    const id = unwrapEntryId(rawId)
    if (id === undefined) return undefined
    try {
      return getKnowledge(this.db, id)
    } catch (error) {
      this.log(`按 id 读取知识条目失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
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
      stats: this.corpusStats(),
      minScore: this.options.minScore ?? RECALL_DEFAULTS.minScore,
      maxEntries: this.options.maxEntries ?? RECALL_DEFAULTS.maxEntries,
      massSat: this.options.massSat,
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
    /** `relevance` 是**展示相关度**（0~1）；`reason` 缺省"模型主动检索"，按 id 直读时另写。 */
    hits: Array<{ id: string; title: string; relevance: number; reason?: string }>
    matched?: number
    droppedByScore?: number
  }): number | undefined {
    // P5：本回合调用过检索工具 → 不再记 suggested_miss（"该查未查"的"查"就是它）
    const state = this.sessions.get(input.sessionId)
    if (state !== undefined) state.toolUsedThisTurn = true
    try {
      return appendRecallLog(this.db, {
        sessionId: input.sessionId === '' ? null : input.sessionId,
        taskId: input.taskId,
        trigger: 'tool',
        outcome: {
          query: input.query,
          terms: input.terms,
          hits: input.hits.map((hit) => ({
            id: hit.id, title: hit.title, score: hit.relevance, relevance: hit.relevance,
            reason: hit.reason ?? '模型主动检索',
            snippet: '', terms: [], tags: [], fromTask: false, updatedAt: '', fileLink: null, sourceTaskId: null, kindCode: '',
          })),
          matched: input.matched ?? input.hits.length,
          droppedByScore: input.droppedByScore ?? 0,
          droppedByLimit: 0,
          droppedAsSeen: 0,
          droppedAsSuperseded: 0,
          nearMisses: [],
        },
        injected: false,
      })
    } catch (error) {
      this.log(`写工具检索日志失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}

/**
 * 会话事件解包（**权威依据**见下），三个助手一起用，缺一不可。
 *
 * ## 为什么必须解包 `data` 信封
 *
 * 宿主交给监听器的不是解包后的载荷，而是**带 `data` 信封的完整事件**：
 * `{ type: 'user/message', seq, time, data: <UserMessage> }`。
 * 权威依据三处：
 * 1. `@deepseek-ai/dsh-session` 的事件映射表写的是 `'user/message': UserMessage`、
 *    `'turn/start': { turn: number }` —— 即 **`data` 是载荷本体**；
 * 2. 宿主实现 `dsh-agent-loop` 读的是 `event.data` / `textOf(event.data)`；
 * 3. `dsh-team-memory` 的实测注释（本机已装）：从顶层读 `event.turn` **恒为 undefined**
 *    → 记录器永远是空的 → 自动捕获一直报"跳过"，**而且不报错**。
 *
 * v1.15.3 首次上线时我正是踩了这个坑：`latestUserMessage` 读 `event.data.message`
 * 而真实是 `event.data` 本身 → query 恒为空 → 每回合召回**从未发生且不留日志**；
 * `currentTurnOf` 读顶层 `event.turn` → 恒 0。两个独立审查者都复现了它。
 */
function bodyOf(event: unknown): Record<string, unknown> {
  const shaped = event as { data?: unknown } | undefined
  return shaped?.data !== null && typeof shaped?.data === 'object' && !Array.isArray(shaped?.data)
    ? shaped.data as Record<string, unknown>
    : (event as Record<string, unknown> ?? {})
}

/** 取回合号：兼容 `{turn:3}`、`{turn:{turn:3}}`、`event.data.turn.turn`。 */
export function turnNumberOf(event: unknown): number {
  const body = bodyOf(event)
  const value = (body.turn ?? (event as { turn?: unknown } | undefined)?.turn)
  if (value !== null && typeof value === 'object') return Number((value as { turn?: unknown }).turn ?? 0) || 0
  return Number(value ?? 0) || 0
}

/** 取消息体：`data` 本身就是消息（当前宿主），或 `data.message`（历史形态）。 */
export function messageOf(event: unknown): unknown {
  const body = bodyOf(event)
  const value = body.message ?? (event as { message?: unknown } | undefined)?.message
  if (value !== null && typeof value === 'object' && (value as { message?: unknown }).message !== null
    && typeof (value as { message?: unknown }).message === 'object') {
    return (value as { message?: unknown }).message
  }
  return value ?? body
}

/**
 * 这条消息是不是**用户本人**写的。
 *
 * 为什么必须有它：真实事件序列里最后一条 `user/message` **往往是插件注入的快照**
 * （运行时上下文、团队记忆召回、**本插件自己的知识块**都是这个形态，
 * `source.kind === 'plugin'`）。不筛掉它，修好信封之后就会把注入内容当成提问去检索 ——
 * 自激：越注入越像，下一回合再拿它当查询。团队记忆用同一条判据（`isUserAuthored`），
 * 这里保持一致（"一件事不能两套规则"）。
 */
export function isUserAuthored(message: unknown): boolean {
  const kind = (message as { source?: { kind?: unknown } } | undefined)?.source?.kind
  if (kind === undefined || kind === null) return true   // 真实用户消息：没有 source 字段
  if (kind === 'plugin') return false                    // 插件注入（记忆 / 计划 / 本插件的知识块）
  if (kind === 'tool') return false                      // 工具结果
  return kind === 'user'
}

/**
 * 本回合的 turn 号（与团队记忆同一套取法：最后一个 `turn/start` 或 `turn/end`）。
 *
 * 注意它**只是同回合内保持文本稳定的依据**；拿不到就退回 0，注入仍会发生
 * （`prefetch` 每次把 `injectedTurn` 重置为 -1，所以恒 0 也不会卡住旧内容）。
 */
export function currentTurnOf(agent: unknown): number {
  try {
    const session = (agent as { session?: { snapshotEvents?: () => unknown[]; events?: unknown[] } } | undefined)?.session
    const events = typeof session?.snapshotEvents === 'function'
      ? session.snapshotEvents() ?? []
      : session?.events ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { type?: string } | undefined
      if (event?.type === 'turn/start' || event?.type === 'turn/end') return turnNumberOf(event)
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
        const agent = (assembly as { agent?: { session?: { header?: { id?: string; origin?: string; cwd?: string } } } } | undefined)?.agent
        const sessionId = agent?.session?.header?.id
        if (sessionId === undefined || sessionId === '') return ''
        // 子会话是"为某个具体委托而开"的短命上下文：把父会话的知识再带一遍是纯噪声。
        if (agent?.session?.header?.origin === 'subagent') return ''
        /**
         * P1（v1.15.7）：检索就发生在**这一刻**，用**当前正在被回答的那条用户消息**。
         *
         * 授权依据（不是推理）：会话日志的事件顺序是 `turn/start` → `user/message`
         * → `request/header`，即装配期用户消息已经在会话事件里；`currentTurnOf` 拿到的
         * 也是当前回合号。由 `test/knowledgeRecallWiring.test.mjs` 用真实 `SessionEvent`
         * 形状钉住（先红后绿）。
         *
         * 成本：一次本地 SQLite 查询 + 纯打分（毫秒级）。本仓检索不出网 ——
         * 团队记忆那套"回合收尾预取 → 下回合注入"之所以成立，前提是它的检索要出网，
         * 照搬过来只会让知识晚一轮到、话题一换就错位、一轮多条消息时丢掉前一条。
         */
        return manager.assemblyInjection(sessionId, agent?.session?.header?.cwd, agent)
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
   * 回合收尾：**不再做回合检索**（那已经移到装配期），只剩两件事。
   *
   * 1. **补做「开工前」**：会话开始那一刻通常还没有 `task_sessions` 关联，
   *    `prime()` 只能空手而归（v1.15.4 修的 F4）。关联到手后在这里补一次。
   * 2. **观测**：本回合若有用户消息没被纳入检索，落一行痕迹（绝不静默丢件）。
   *
   * 团队记忆记过一条硬约束：`agent/turn-stopping` 是串行 await 的收尾钩子，
   * 在这里做重活会让"上传慢 → 对话看起来失效"。这里是本地 SQLite 读 + 纯打分，
   * 毫秒级，但**仍然全部包在 try/catch 内**：宁可这一回合不记，也不能影响对话。
   */
  events.on('agent/turn-stopping', ((payload: { agent?: { session?: { header?: { id?: string; cwd?: string; origin?: string } } }; turn?: number }) => {
    try {
      const header = payload?.agent?.session?.header
      const sessionId = header?.id
      if (sessionId === undefined || sessionId === '') return
      if (header?.origin === 'subagent') return
      if (!manager.sessionEnabled(sessionId)) return
      // ① 补做开工前（迟到的关联）
      manager.primeIfNeeded(sessionId, header?.cwd)
      // ② 观测：这一回合的用户消息到底有没有被检索过
      manager.noteUnretrieved(sessionId, header?.cwd, payload?.agent)
      // ③ P4：引用自动判定（回答里出现了刚注入条目的标题/id → 自动标 cited）
      manager.autoCite(sessionId, payload?.agent)
      // ④ P5："该查未查"只观测（像报错却没调用检索工具 → 落一行 suggested_miss）
      manager.noteSuggestedMiss(sessionId, header?.cwd, payload?.agent)
      // ⑤ 本回合的"用过工具"标记复位（下一回合重新计）
      manager.noteTurnStopped(sessionId)
    } catch (error) {
      manager.logLine(`回合收尾处理失败（已忽略，不影响对话）：${error instanceof Error ? error.message : String(error)}`)
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

/**
 * 最后一条**用户本人写的** `user/message`（本回合的提问）。
 *
 * ⚠️ 必须过 `isUserAuthored`：真实序列里最后一条 user 角色消息常常是插件注入的快照
 * （含本插件自己上一回合注入的知识块），拿它当提问会自激。见 `bodyOf` 的注释。
 */
export function latestUserMessage(events: unknown[]): unknown {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string } | undefined
    if (event?.type !== 'user/message') continue
    const message = messageOf(event)
    if (isUserAuthored(message)) return message
  }
  return undefined
}

/**
 * **本回合**所有用户本人写的 `user/message`（v1.15.7，P1 的核心修法）。
 *
 * 为什么不是"最后一条"：实测 turn 16 那一轮里有两条用户本人消息 ——
 * 实质提问（10:05:40）+「停」（10:06:37）。只取最后一条 = 「停」→ 判为琐碎 → 跳过检索，
 * **那句实质提问从未被检索过**。而库里已有一条 0.72 相关度的条目，本应完整块注入。
 * 失败发生在打分**之前**，所以调阈值/提示档都救不了它。
 *
 * 取词范围 = 最后一个 `turn/start`（回合号与 `currentTurnOf` 一致）之后的全部用户消息；
 * 找不到 `turn/start`（事件形状异常）时退回 `latestUserMessage` —— 少召回也不能拿错消息
 * （把上一回合的提问当成这一回合的，会把不相关的知识注进来）。
 */
export function currentTurnUserMessages(agent: unknown): unknown[] {
  const session = (agent as { session?: unknown } | undefined)?.session
  const events = snapshotEvents(session)
  const turn = currentTurnOf(agent)
  let start = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string } | undefined
    if (event?.type === 'turn/start' && turnNumberOf(event) === turn) { start = index; break }
  }
  if (start < 0) {
    const fallback = latestUserMessage(events)
    return fallback === undefined ? [] : [fallback]
  }
  const messages: unknown[] = []
  for (let index = start; index < events.length; index += 1) {
    const event = events[index] as { type?: string } | undefined
    if (event?.type !== 'user/message') continue
    const message = messageOf(event)
    if (isUserAuthored(message)) messages.push(message)
  }
  return messages
}

/** 本回合的用户消息**文本**（去空、保序、去重）。检索与记账都用这一份。 */
export function currentTurnQueries(agent: unknown): string[] {
  const queries: string[] = []
  for (const message of currentTurnUserMessages(agent)) {
    const text = textOfUserMessage(message)
    if (text === '' || queries.includes(text)) continue
    queries.push(text)
  }
  return queries
}

/**
 * 本回合**模型自己说的**内容（P4 的引用判定要读它）。
 *
 * 只看 `assistant/message`，且必须排除插件注入的 `user/message` 快照
 * （那里面就会抄着知识块的标题 —— 拿它当"模型引用了"会把自动判定变成自激：
 * 注入什么就自动标成引用了什么，证据全部失真）。这里只读 assistant 角色的事件，
 * 所以天然不含注入快照。
 */
export function assistantTextOf(agent: unknown): string {
  const session = (agent as { session?: unknown } | undefined)?.session
  const events = snapshotEvents(session)
  const turn = currentTurnOf(agent)
  let start = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string } | undefined
    if (event?.type === 'turn/start' && turnNumberOf(event) === turn) { start = index; break }
  }
  const scoped = start >= 0 ? events.slice(start) : events
  const parts: string[] = []
  for (const item of scoped) {
    const event = item as { type?: string } | undefined
    if (event?.type !== 'assistant/message') continue
    const text = textOfUserMessage(messageOf(event))
    if (text !== '') parts.push(text)
  }
  return parts.join('\n')
}
