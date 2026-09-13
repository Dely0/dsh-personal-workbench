/**
 * repo 层共享原语：时间、草稿行类型与读取、草稿确认骨架。
 *
 * 从 repo.ts 原样抽出（行为不变）。各领域模块依赖本文件；repo.ts 再导出以保持对外 API。
 * 本文件不依赖任何其他 repo 模块，避免循环依赖。
 */
import type { DatabaseSync } from 'node:sqlite'

export const nowIso = (): string => new Date().toISOString()

export interface DraftRow {
  id: string
  kindCode: string
  sessionId: string | null
  payload: Record<string, unknown>
  statusCode: string
  /** 非空表示该草稿已「暂存」：仍是 pending，但不再自动弹窗 */
  deferredAt: string | null
  /** 累计暂存次数（用于展示"第 N 次"） */
  deferCount: number
  createdAt: string
  updatedAt: string
}

export interface RawDraftRow {
  id: string
  kind_code: string
  session_id: string | null
  payload_json: string
  status_code: string
  deferred_at?: string | null
  defer_count?: number | null
  created_at: string
  updated_at: string
}

export function parseDraft(row: RawDraftRow | undefined): DraftRow | undefined {
  if (row === undefined) return undefined
  return {
    id: row.id,
    kindCode: row.kind_code,
    sessionId: row.session_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    statusCode: row.status_code,
    deferredAt: row.deferred_at ?? null,
    deferCount: row.defer_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getDraft(db: DatabaseSync, id: string): DraftRow | undefined {
  return parseDraft(db.prepare('SELECT * FROM task_drafts WHERE id = ?').get(id) as RawDraftRow | undefined)
}

export function setDraftStatus(db: DatabaseSync, id: string, statusCode: string, at = nowIso()): void {
  db.prepare('UPDATE task_drafts SET status_code = ?, updated_at = ? WHERE id = ?').run(statusCode, at, id)
}

/**
 * 确认过的草稿里记住"这次确认到底建了什么"，供**重复确认**原样回放。
 *
 * ## 为什么必须有它（2026-09-13 真实事故）
 *
 * 用户报「快速录入 → AI 执行 → 验收后，待处理里多出一条同名任务」。实测根因：
 * `POST /api/workbench/drafts/:id/confirm` **不检查草稿是否已经是 confirmed**，
 * 而 `withDraftConfirm` 也没有这道守卫 ——
 * 同一条 task 草稿被确认两次就**建出两条任务**（复现见
 * `node scripts/repro/repro-routes.mjs`：第一次 200 建任务，第二次 200 又建一条）。
 *
 * 草稿确认是**幂等语义**：一条草稿 = 一次决定 = 一个产出。
 * 第二次确认不该再建，也不该 400 报错（前端并发点击、网络重试都会走到这里），
 * 而应当**回放第一次的结果**。
 *
 * ## 为什么写在 payload 里
 *
 * 与复盘草稿的 `reviewId` 回写同一个套路（见 `drafts.ts` 的 review 分支）：
 * 加字段要动 schema，而 schema **只单向前进**，不能为了一件"幂等"去冒迁移风险。
 */
export function getDraftConfirmResult<T = unknown>(draft: DraftRow): T | undefined {
  return draft.payload.confirmResult as T | undefined
}


/**
 * 草稿确认的公共骨架：取草稿 → 校验 kind / 状态 → 开事务 → 执行业务 → 标记 confirmed → 提交/回滚。
 *
 * 抽出来的原因：7 个 confirm*Draft 曾各自重复这 6 步（连 ROLLBACK 分支都一字不差），
 * 任何一步改动都要改 7 处。现在各函数只负责"确认时具体建什么"。
 *
 * ## 幂等（2026-09-13 补，针对"确认两次建两条任务"的真实事故）
 *
 * 确认成功时把产出回写进 payload（`confirmResult`）；**同一份产出落两次地**这件事
 * 从此结构上不可能：第二次确认走 `options.replay`，原样回放第一次的结果。
 *
 * 两道判断缺一不可：
 *
 * 1. 草稿已是 `confirmed` **且** payload 里有 `confirmResult` → 回放（这条是老草稿恢复路径）；
 * 2. 草稿仍是 `pending` 但 payload 里已有 `confirmResult` → 同样回放，**且把状态补成
 *    confirmed**（守卫上线前"建了东西却没标状态"的半截数据，靠这一步自愈）。
 *
 * 状态不是 `pending` 且没有可回放的产出时，**绝不执行 build** —— 直接返回 `emptyValue`。
 *
 * 为什么不是"返回 400 让调用方自己处理"：前端并发点击、网络级重试都会命中，
 * 用户想要的结果（东西建好了、弹框收起来）其实已经达成，报错只会让人以为失败了。
 *
 * @param kindCode 期望的草稿类型；不匹配返回 undefined（保持既有语义）
 * @param emptyValue kind 匹配但业务产出为空时的返回值（部分函数历史上返回 [] 而非 undefined）
 */
export function withDraftConfirm<T>(
  db: DatabaseSync,
  draftId: string,
  kindCode: string,
  build: (draft: DraftRow) => T,
  options: { at?: string; emptyValue: T; replay?: (cached: unknown, draft: DraftRow) => T },
): T
export function withDraftConfirm<T>(
  db: DatabaseSync,
  draftId: string,
  kindCode: string,
  build: (draft: DraftRow) => T,
  options?: { at?: string; replay?: (cached: unknown, draft: DraftRow) => T },
): T | undefined
export function withDraftConfirm<T>(
  db: DatabaseSync,
  draftId: string,
  kindCode: string,
  build: (draft: DraftRow) => T,
  options: { at?: string; emptyValue?: T; replay?: (cached: unknown, draft: DraftRow) => T } = {},
): T | undefined {
  const at = options.at ?? nowIso()
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== kindCode) return options.emptyValue
  const cached = getDraftConfirmResult(draft)
  if (cached !== undefined && options.replay !== undefined) {
    const replayed = options.replay(cached, draft)
    if (draft.statusCode === 'pending') setDraftStatus(db, draftId, 'confirmed', at)
    return replayed
  }
  /**
   * 状态守卫：不是 pending 就不再执行业务。
   *
   * 走到这里说明草稿没有可回放的产出（老数据：守卫上线前确认过、payload 里没有
   * `confirmResult`）—— 返回 `emptyValue`，由调用方给出可读结果，而不是"再建一条"。
   */
  if (draft.statusCode !== 'pending') return options.emptyValue
  db.exec('BEGIN')
  try {
    const result = build(draft)
    // 先回写产出、再标记 confirmed：反过来 `updateDraft` 会因为状态不是 pending 而拒绝。
    const withResult = { ...draft.payload, confirmResult: result }
    db.prepare('UPDATE task_drafts SET payload_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(withResult), at, draftId)
    setDraftStatus(db, draftId, 'confirmed', at)
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
