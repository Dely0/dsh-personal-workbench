/**
 * 会话 ↔ 角色 绑定的**仓储包装**（D12 / requirements §6.4）。
 *
 * ## 为什么是"包装"而不是新表
 *
 * 需求明写：**复用 `ai_session_registry`**（T1 的迁移 19 已经为该表加好了
 * `ai_session_scope = 'persona'` 字典项）。所以绑定就是这张表里的一行：
 *
 * | scope_code | anchor | session_id | note |
 * |---|---|---|---|
 * | `persona` | 会话 id | 同一个会话 id | 版本化 JSON（见 `shared/persona.ts`） |
 *
 * - `anchor = sessionId` 让"按会话查绑定"就是一次主键查询；
 * - scope 不同 → **结构上不可能覆盖** `daily_plan` / `day_report` 的登记
 *   （同一 scope+anchor 只保留一条，跨 scope 是两行）；
 * - 写入一律走 `registerAiSession`（注册表的唯一写入口），本模块不自己写 SQL ——
 *   否则"注册表怎么 upsert"就有了第二份实现。
 *
 * ## 为什么把"损坏"与"没绑定"分开
 *
 * `note` 是自由文本列。行在、内容解析不出来（手改过 / 未来版本写的 / 别的 scope 复用过）
 * 时，报"绑定记录损坏"远比报"未绑定"诚实：后者会把用户引向"重新选一次角色"，
 * 而真实原因是数据坏了（需求 §6.4 的失败四态之外，这一条属于"可观测优先"）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { getAiSession, registerAiSession } from '../repo.js'
import {
  parsePersonaBinding,
  serializePersonaBinding,
  type PersonaBindingRecord,
} from '../../shared/persona.js'

/** 绑定行的 scope 字典码（迁移 19 已加：`ai_session_scope = 'persona'`）。 */
export const PERSONA_BINDING_SCOPE = 'persona'

/** 绑定查询结果：`binding` 与 `corrupt` 互斥地表达三种状态。 */
export interface PersonaBindingLookup {
  /** 该会话**没有**绑定行。 */
  missing: boolean
  /** 有行但 note 解析不出来（版本不符 / 不是 JSON / 缺字段）。 */
  corrupt: boolean
  binding?: PersonaBindingRecord
  /** 行里记的 session_id（诊断用；正常时等于 anchor）。 */
  sessionId?: string
}

/** 按会话读绑定（`anchor = sessionId`）。 */
export function readPersonaBinding(db: DatabaseSync, sessionId: string): PersonaBindingLookup {
  if (sessionId.trim() === '') return { missing: true, corrupt: false }
  const row = getAiSession(db, PERSONA_BINDING_SCOPE, sessionId)
  if (row === undefined) return { missing: true, corrupt: false }
  const binding = parsePersonaBinding(row.note)
  if (binding === undefined) return { missing: false, corrupt: true, sessionId: row.sessionId }
  return { missing: false, corrupt: false, binding, sessionId: row.sessionId }
}

/** 写绑定（幂等 upsert；`created_at` 由注册表保持首次值）。 */
export function writePersonaBinding(db: DatabaseSync, sessionId: string, record: PersonaBindingRecord): PersonaBindingRecord {
  if (sessionId.trim() === '') throw new Error('writePersonaBinding: sessionId 不能为空')
  registerAiSession(db, {
    scopeCode: PERSONA_BINDING_SCOPE,
    anchor: sessionId,
    sessionId,
    note: serializePersonaBinding(record),
  })
  return record
}
