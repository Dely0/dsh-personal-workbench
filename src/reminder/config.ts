/**
 * 提醒策略配置：默认值 + 解析 + 校验。
 * 存放于 meta 表（JSON），与 ai_default_workspace 等设置同机制，不新建表。
 * 设计见 docs/design/2026-09-09-reminder-policy-model.md
 */
import type { DatabaseSync } from 'node:sqlite'

export const REMINDER_POLICY_META_KEY = 'reminder_policy'

export interface ReminderPolicy {
  /** 总开关：false 时 host 完全不动作，前端行为与改造前一致 */
  enabled: boolean
  /** 到期立即推送的优先级 */
  immediatePriorities: string[]
  /** 并入每日汇总的优先级 */
  digestPriorities: string[]
  /** 每日汇总时间 HH:mm */
  digestAt: string
  /** 静默时段，null 表示不启用 */
  quietHours: { start: string; end: string } | null
  /** 静默期内仍允许即时推送的优先级（默认 P0 穿透） */
  quietHoursBypassPriorities: string[]
  hourlyLimit: number
  dailyLimit: number
  /** 启动补发回溯窗口（小时）；超过窗口的逾期提醒只记事件不补发 */
  catchupWindowHours: number
  /** 合并摘要最多列出的条目数 */
  catchupMaxItems: number
  /** 熔断基础冷却（分钟），失败后翻倍，上限 4 小时 */
  breakerCooldownMinutes: number
  /** 通道选择：auto = 装了 dsh-im 就走微信，否则前端 */
  channel: 'auto' | 'wechat' | 'browser'
}

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  enabled: false,
  immediatePriorities: ['p0', 'p1'],
  digestPriorities: ['p2', 'p3'],
  digestAt: '09:00',
  quietHours: { start: '22:00', end: '08:00' },
  quietHoursBypassPriorities: ['p0'],
  hourlyLimit: 6,
  dailyLimit: 50,
  catchupWindowHours: 24,
  catchupMaxItems: 10,
  breakerCooldownMinutes: 30,
  channel: 'auto',
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const MAX_BREAKER_COOLDOWN_MS = 4 * 60 * 60 * 1000

function strList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const list = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim().toLowerCase())
  return list.length > 0 ? [...new Set(list)] : fallback
}

function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function hhmm(value: unknown, fallback: string): string {
  return typeof value === 'string' && HHMM_RE.test(value.trim()) ? value.trim() : fallback
}

/** 把任意（含损坏的）输入规整成完整策略；未知字段丢弃，越界值夹紧。 */
export function normalizeReminderPolicy(raw: unknown): ReminderPolicy {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const quiet = input.quietHours
  let quietHours: ReminderPolicy['quietHours'] = DEFAULT_REMINDER_POLICY.quietHours
  if (quiet === null) {
    quietHours = null
  } else if (typeof quiet === 'object' && quiet !== null) {
    const q = quiet as Record<string, unknown>
    const start = hhmm(q.start, DEFAULT_REMINDER_POLICY.quietHours!.start)
    const end = hhmm(q.end, DEFAULT_REMINDER_POLICY.quietHours!.end)
    // start === end 视为不启用（否则是"全天静默"，几乎肯定是误配）
    quietHours = start === end ? null : { start, end }
  }
  const channel = input.channel === 'wechat' || input.channel === 'browser' ? input.channel : 'auto'
  return {
    enabled: input.enabled === true,
    immediatePriorities: strList(input.immediatePriorities, DEFAULT_REMINDER_POLICY.immediatePriorities),
    digestPriorities: strList(input.digestPriorities, DEFAULT_REMINDER_POLICY.digestPriorities),
    digestAt: hhmm(input.digestAt, DEFAULT_REMINDER_POLICY.digestAt),
    quietHours,
    quietHoursBypassPriorities: strList(input.quietHoursBypassPriorities, DEFAULT_REMINDER_POLICY.quietHoursBypassPriorities),
    hourlyLimit: intInRange(input.hourlyLimit, DEFAULT_REMINDER_POLICY.hourlyLimit, 1, 60),
    dailyLimit: intInRange(input.dailyLimit, DEFAULT_REMINDER_POLICY.dailyLimit, 1, 500),
    catchupWindowHours: intInRange(input.catchupWindowHours, DEFAULT_REMINDER_POLICY.catchupWindowHours, 1, 168),
    catchupMaxItems: intInRange(input.catchupMaxItems, DEFAULT_REMINDER_POLICY.catchupMaxItems, 1, 50),
    breakerCooldownMinutes: intInRange(input.breakerCooldownMinutes, DEFAULT_REMINDER_POLICY.breakerCooldownMinutes, 1, 240),
    channel,
  }
}

export function readReminderPolicy(db: DatabaseSync): ReminderPolicy {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(REMINDER_POLICY_META_KEY) as { value: string } | undefined
  if (row === undefined) return { ...DEFAULT_REMINDER_POLICY }
  try {
    return normalizeReminderPolicy(JSON.parse(row.value))
  } catch {
    return { ...DEFAULT_REMINDER_POLICY }
  }
}

export function writeReminderPolicy(db: DatabaseSync, raw: unknown): ReminderPolicy {
  const policy = normalizeReminderPolicy(raw)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(REMINDER_POLICY_META_KEY, JSON.stringify(policy))
  return policy
}

/** 熔断冷却时长：基础值按失败次数翻倍，上限 4 小时。 */
export function breakerCooldownMs(policy: ReminderPolicy, failureCount: number): number {
  const base = policy.breakerCooldownMinutes * 60_000
  const doubled = base * Math.pow(2, Math.max(0, failureCount - 1))
  return Math.min(doubled, MAX_BREAKER_COOLDOWN_MS)
}
