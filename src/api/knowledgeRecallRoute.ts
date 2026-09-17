/**
 * 知识库自动召回的**可观测端点**（v1.15.3）。
 *
 * ## 为什么这几个端点本身就是交付物
 *
 * 验收标准第 1 条要求「会话/日志里能看到**检索了哪些关键词、命中哪几条、是否被引用**」。
 * 会话里的那份证据来自 `systemPrompt.context` 注入（用户能在对话里看到）；
 * 而"**每一次**检索的账"必须有个不依赖会话历史的地方可查 —— 就是这里：
 *
 * - `GET  /api/workbench/knowledge-recall/log?session_id=&limit=` → 最近 N 次召回（含关键词/命中/分数/是否注入/跳过原因/被引用）
 * - `GET  /api/workbench/knowledge-recall/status?session_id=`     → 当前开关 + 本会话最近命中
 * - `POST /api/workbench/knowledge-recall/auto`                    → 全局开关（{enabled:boolean}）
 * - `POST /api/workbench/knowledge-recall/session`                 → 单会话开关（{sessionId, mode:'off'|'on'|'clear'}）
 *
 * 所有端点都走既有请求围栏（loopback-only + 统一 JSON 写出），与其余路由一致。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import type { KnowledgeRecallManager } from '../knowledge-recall.js'
import { listRecallLog, readSessionOff, type RecallLogEntry } from '../knowledge-recall-log.js'
import { isLoopbackRequest, KNOWLEDGE_RECALL_PREFIX, readJsonBody, writeJson } from './routes/helpers.js'

/** 一行人类可读的摘要（界面与 curl 都用它，避免两处各拼一遍）。 */
export function formatRecallLogLine(entry: RecallLogEntry): string {
  const when = entry.createdAt.replace('T', ' ').slice(0, 19)
  const skip = entry.skippedReason !== null && entry.skippedReason !== '' ? `跳过（${entry.skippedReason}）` : ''
  /**
   * 账要分开说：**"分数不够"与"已注入过去重跳过"是两件不同的事**。
   * 混成一句"全部低于阈值"会把"这条其实命中过、只是上一回合已经给过了"读成"不相关"。
   */
  const tail = entry.hits.length > 0
    ? `命中 ${entry.hits.length} 条` + (entry.droppedByScore > 0 ? `（另有 ${entry.droppedByScore} 条低于阈值）` : '')
    : entry.droppedAsSeen > 0
      ? `命中 ${entry.matched} 条，但全部已注入过（会话去重跳过 ${entry.droppedAsSeen} 条）`
      : entry.matched > 0
        ? `命中 ${entry.matched} 条但全部低于阈值`
        : entry.skippedReason !== null ? '' : '零命中'
  const cited = entry.citedIds.length > 0 ? `｜被引用 ${entry.citedIds.length} 条` : ''
  return `${when} [${entry.trigger}] ${skip}「${entry.query}」关键词=[${entry.terms.join(' ')}] → ${tail}${cited}`
}

export function makeKnowledgeRecallRoutes(db: DatabaseSync, manager: KnowledgeRecallManager): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: `${KNOWLEDGE_RECALL_PREFIX}/log`,
      handler(req, res) {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('session_id') ?? undefined
        const rawLimit = Number(url.searchParams.get('limit') ?? '50')
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.trunc(rawLimit), 500)) : 50
        const entries = listRecallLog(db, { sessionId, limit })
        return writeJson(res, 200, {
          ok: true,
          count: entries.length,
          /** 人类可读摘要：用户不装工具也能看懂"查了什么、命中了什么"。 */
          lines: entries.map(formatRecallLogLine),
          entries,
        })
      },
    },
    {
      kind: 'exact',
      path: `${KNOWLEDGE_RECALL_PREFIX}/status`,
      handler(req, res) {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('session_id') ?? ''
        return writeJson(res, 200, {
          ok: true,
          autoEnabled: manager.autoEnabled(),
          sessionOff: readSessionOff(db),
          session: sessionId === '' ? null : manager.sessionState(sessionId),
        })
      },
    },
    {
      kind: 'exact',
      path: `${KNOWLEDGE_RECALL_PREFIX}/auto`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
        if (typeof body.enabled !== 'boolean') return writeJson(res, 400, { error: 'enabled (boolean) is required' })
        manager.setAutoEnabled(body.enabled)
        return writeJson(res, 200, { ok: true, autoEnabled: manager.autoEnabled() })
      },
    },
    {
      kind: 'exact',
      path: `${KNOWLEDGE_RECALL_PREFIX}/session`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sessionId === '') return writeJson(res, 400, { error: 'sessionId is required' })
        const mode = body.mode
        if (mode !== 'off' && mode !== 'on' && mode !== 'clear') return writeJson(res, 400, { error: "mode must be 'off' | 'on' | 'clear'" })
        const effective = manager.setSessionEnabled(sessionId, mode)
        return writeJson(res, 200, { ok: true, sessionId, mode, enabled: effective, sessionOff: readSessionOff(db) })
      },
    },
  ]
}
