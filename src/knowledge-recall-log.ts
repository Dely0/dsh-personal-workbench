/**
 * 知识库召回的**落库日志**（可见性的事实源）。
 *
 * ## 为什么必须落库而不是只打 console
 *
 * 验收标准里写着「会话/日志里能看到**检索了哪些关键词、命中哪几条、是否被引用**」。
 * 控制台日志在 GUI 用户面前等于不存在（要翻进程 stdout），而"AI 到底查了什么"
 * 恰恰是用户最需要当场看到的东西。所以：
 *
 * - 每次召回写一行结构化记录（含 `terms` / `hits` / `injected` / 跳过原因）；
 * - 暴露成 HTTP 端点和界面面板，用户不装任何工具就能查；
 * - `cited_ids` 由模型在用到条目时回填（`report_usage`），于是"是否被引用"可判定。
 *
 * 与团队记忆的 `memory.log`、召回事件表是同一套思路（"零命中与没检索必须能分开"）：
 * `injected = 0` 配 `skipped_reason` 与配 `matched > 0（被阈值挡下）` 是**三件不同的事**。
 *
 * 保留策略：只留最近 `KEEP_ROWS` 行。这张表会被每个会话每回合写一行，
 * 无上限增长会在几个月后变成"性能问题 + 用户看不懂的巨表"。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { RecallOutcome } from './shared/knowledgeRecall.js'

/** 日志表保留的最大行数（超出按时间丢弃最旧的）。 */
export const KEEP_ROWS = 2000

export interface RecallLogEntry {
  id: number
  sessionId: string | null
  taskId: string | null
  /** 触发时机：session_start（开工前）/ turn（回合预取）/ tool（模型主动查）。 */
  trigger: string
  query: string
  terms: string[]
  /** 命中并注入的条目（含分数与理由）。 */
  hits: Array<{ id: string; title: string; score: number; reason: string }>
  matched: number
  droppedByScore: number
  droppedByLimit: number
  droppedAsSeen: number
  injected: boolean
  skippedReason: string | null
  /** 模型回报"用到了哪几条"（空数组表示还没回报或没用）。 */
  citedIds: string[]
  createdAt: string
}

interface RawRow {
  id: number
  session_id: string | null
  task_id: string | null
  trigger_code: string
  query: string
  terms_json: string
  hits_json: string
  matched: number
  dropped_by_score: number
  dropped_by_limit: number
  dropped_as_seen: number
  injected: number
  skipped_reason: string | null
  cited_ids_json: string
  created_at: string
}

function parseArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function parseRow(row: RawRow): RecallLogEntry {
  const hits = parseArray(row.hits_json)
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? ''),
      score: typeof item.score === 'number' ? item.score : 0,
      reason: String(item.reason ?? ''),
    }))
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    trigger: row.trigger_code,
    query: row.query,
    terms: parseArray(row.terms_json).filter((item): item is string => typeof item === 'string'),
    hits,
    matched: row.matched,
    droppedByScore: row.dropped_by_score,
    droppedByLimit: row.dropped_by_limit,
    droppedAsSeen: row.dropped_as_seen,
    injected: row.injected === 1,
    skippedReason: row.skipped_reason,
    citedIds: parseArray(row.cited_ids_json).filter((item): item is string => typeof item === 'string'),
    createdAt: row.created_at,
  }
}

/** 一次召回写入一行日志；返回行 id（供 report_usage 回填）。 */
export function appendRecallLog(
  db: DatabaseSync,
  input: {
    sessionId: string | null
    taskId: string | null
    trigger: string
    outcome: RecallOutcome
    injected: boolean
    at?: string
  },
): number {
  const at = input.at ?? new Date().toISOString()
  const info = db.prepare(`
    INSERT INTO knowledge_recall_log
      (session_id, task_id, trigger_code, query, terms_json, hits_json, matched,
       dropped_by_score, dropped_by_limit, dropped_as_seen, injected, skipped_reason, cited_ids_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)
  `).run(
    input.sessionId,
    input.taskId,
    input.trigger,
    input.outcome.query,
    JSON.stringify(input.outcome.terms),
    JSON.stringify(input.outcome.hits.map((hit) => ({ id: hit.id, title: hit.title, score: hit.score, reason: hit.reason }))),
    input.outcome.matched,
    input.outcome.droppedByScore,
    input.outcome.droppedByLimit,
    input.outcome.droppedAsSeen,
    input.injected ? 1 : 0,
    input.outcome.skippedReason ?? null,
    at,
  )
  const id = Number(info.lastInsertRowid)
  // 裁剪：保留最新 KEEP_ROWS 行。失败不影响写入结果（日志不是关键路径）。
  try {
    db.prepare('DELETE FROM knowledge_recall_log WHERE id <= (SELECT MAX(id) FROM knowledge_recall_log) - ?').run(KEEP_ROWS)
  } catch { /* 裁剪失败只意味着表更大，不该让召回失败 */ }
  return id
}

/** 读最近的召回日志（新的在前）。 */
export function listRecallLog(db: DatabaseSync, options: { sessionId?: string; limit?: number } = {}): RecallLogEntry[] {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500))
  const rows = options.sessionId === undefined || options.sessionId === ''
    ? db.prepare('SELECT * FROM knowledge_recall_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as RawRow[]
    : db.prepare('SELECT * FROM knowledge_recall_log WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(options.sessionId, limit) as unknown as RawRow[]
  return rows.map(parseRow)
}

/**
 * 模型回报"用到了哪几条"。
 *
 * 只回填**属于该会话**的行（`session_id` 匹配）：否则一个会话可以改到另一个会话的记录，
 * 而"是否被引用"是给人看的证据，串了会话就毫无价值。
 *
 * 返回值是 **"这些 id 最终落在几条召回记录上"**（不是"改了几行"）——
 * 因为同一批引用会被 `report_usage` 汇报多次（模型在多个回合里提到同一条），
 * 若按"改了几行"计数，第二次就会返回 0，调用方会误以为"没落地"而重试或报错。
 * 幂等在这里是**正常情况**，不是异常。
 */
export function citeRecallLog(db: DatabaseSync, input: { sessionId: string; ids: string[]; at?: string }): number {
  const ids = [...new Set(input.ids.filter((id) => typeof id === 'string' && id.trim() !== ''))]
  if (ids.length === 0) return 0
  /**
   * **按 id 反查行**，不做"最近 N 行"的截断（v1.15.4 修的自查 F5）。
   *
   * 原实现是 `ORDER BY id DESC LIMIT 200`：一个长会话（每回合 1 行 + 每次工具检索 1 行）
   * 很容易超过 200 行，此时模型回报的引用会落到"记忆里带过、但日志里查不到"的旧行上，
   * 调用方拿到的 `updated = 0` 还会被工具话术说成"没有匹配到本会话的召回记录" ——
   * 把"日志没扫到"说成"你没查过"。实测：251 行时最旧那行的引用被静默丢弃。
   *
   * 现在按每个 id 精确反查（`hits_json LIKE '%id%'`；id 是 uuid，不会误命中），
   * 那个 1000 只是"异常多行"时的性能兜底，不再偷偷决定"谁可以被标记"。
   */
  const select = db.prepare(
    'SELECT id, hits_json, cited_ids_json FROM knowledge_recall_log WHERE session_id = ? AND hits_json LIKE ? ORDER BY id DESC LIMIT 1000',
  )
  const rows = new Map<number, { id: number; hits_json: string; cited_ids_json: string }>()
  for (const id of ids) {
    for (const row of select.all(input.sessionId, `%${id}%`) as unknown as Array<{ id: number; hits_json: string; cited_ids_json: string }>) {
      rows.set(row.id, row)
    }
  }
  const update = db.prepare('UPDATE knowledge_recall_log SET cited_ids_json = ? WHERE id = ?')
  let affected = 0
  for (const row of rows.values()) {
    /**
     * 只认**这一行真的把该条目带给过模型**的那些 id。
     *
     * 为什么必须比对 `hits_json`：一个会话里有"命中了 N 条"的行，也有
     * "跳过检索（琐碎消息）"或"零命中"的行。只按会话回填会把引用写到
     * "什么都没带出来"的那些行上 —— 那会让"是否被引用"这条证据直接失真，
     * 而失真的证据比没有证据更糟（会让人得出错误结论）。
     */
    const delivered = parseArray(row.hits_json)
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => String(item.id ?? ''))
    const mine = ids.filter((id) => delivered.includes(id))
    if (mine.length === 0) continue
    const current = parseArray(row.cited_ids_json).filter((item): item is string => typeof item === 'string')
    const next = [...new Set([...current, ...mine])]
    if (next.length !== current.length) update.run(JSON.stringify(next), row.id)
    // 幂等：重复回报同一批引用是**正常情况**（模型在多个回合里提到同一条），
    // 因此计数按"这批 id 最终落在几条记录上"来算，而不是"这次改了几行"——
    // 后者第二次会返回 0，调用方会误以为"没落地"。
    affected += 1
  }
  return affected
}

/** 会话级开关（`meta.knowledge_recall_session_overrides`）的唯一读写实现。 */
const SESSION_OVERRIDE_KEY = 'knowledge_recall_session_overrides'

/** 读全部会话级覆盖：`{ sessionId: 'off' | 'on' }`。脏值当空表（不猜用户意图）。 */
export function readSessionOverrides(db: DatabaseSync): Record<string, 'off' | 'on'> {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SESSION_OVERRIDE_KEY) as { value: string } | undefined
  if (row === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, 'off' | 'on'> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === 'off' || value === 'on') out[key] = value
    }
    return out
  } catch { return {} }
}

/** 显式关掉自动召回的会话（给设置页/日志页展示用）。 */
export function readSessionOff(db: DatabaseSync): string[] {
  return Object.entries(readSessionOverrides(db)).filter(([, value]) => value === 'off').map(([key]) => key).sort()
}

/**
 * 覆盖某个会话的开关。
 *
 * `off` 与 `on` 语义分别是"显式关"与"显式开（覆盖全局关闭）"，
 * `clear` 表示回到跟随全局 —— 三种状态都要有，否则"全局关了但我就想这个会话开"
 * 无法表达，用户只能去改全局开关、再回来改一次。
 */
export function writeSessionOverride(db: DatabaseSync, sessionId: string, mode: 'off' | 'on' | 'clear'): string[] {
  const overrides = readSessionOverrides(db)
  if (mode === 'clear') delete overrides[sessionId]
  else overrides[sessionId] = mode
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SESSION_OVERRIDE_KEY, JSON.stringify(overrides))
  return Object.entries(overrides).filter(([, value]) => value === 'off').map(([key]) => key).sort()
}
