/**
 * 提醒策略判定：分级 / 静默 / 节流 / 熔断。
 * 纯函数优先，便于单测；时间相关一律显式传入 now，不读全局时钟。
 * 设计见 docs/design/2026-09-09-reminder-policy-model.md
 */
import type { ReminderPolicy } from './config.js'

export interface ReminderCandidate {
  reminderId: string
  taskId: string
  rootTaskId: string
  title: string
  priorityCode: string
  dueAt: string
  /** 该提醒的触发时刻 = dueAt - offsetMinutes */
  fireAt: string
}

export type PolicyDecision =
  | { action: 'send'; reason: 'immediate' | 'quiet-bypass' }
  | { action: 'queue'; reason: 'quiet-hours' | 'digest' | 'throttled' | 'breaker' }
  | { action: 'skip'; reason: 'disabled' | 'too-old' | 'not-due' }

/** 把 HH:mm 解释成当天的分钟数。 */
function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((part) => Number(part))
  return h * 60 + m
}

/**
 * 是否处于静默时段。start > end 视为跨午夜；start === end 已在配置层归一为 null。
 */
export function isQuietTime(policy: ReminderPolicy, now: Date): boolean {
  if (policy.quietHours === null) return false
  const start = minutesOfDay(policy.quietHours.start)
  const end = minutesOfDay(policy.quietHours.end)
  const current = now.getHours() * 60 + now.getMinutes()
  if (start < end) return current >= start && current < end
  return current >= start || current < end
}

/** 是否已到每日汇总时刻（当天）。 */
export function isPastDigestTime(policy: ReminderPolicy, now: Date): boolean {
  return now.getHours() * 60 + now.getMinutes() >= minutesOfDay(policy.digestAt)
}

export interface ThrottleState {
  /** 最近一小时已发送/已尝试的条数 */
  sentLastHour: number
  /** 当日已发送/已尝试的条数 */
  sentToday: number
  /** 熔断开启中则 > now */
  circuitOpenUntil: number | null
}

export type ThrottleVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'hourly' | 'daily' | 'breaker'; retryAfterMs: number }

/**
 * 节流判定。熔断优先于预算——熔断期间连预算都不消耗。
 * `nowMs` 为毫秒时间戳。
 */
export function checkThrottle(policy: ReminderPolicy, state: ThrottleState, nowMs: number): ThrottleVerdict {
  if (state.circuitOpenUntil !== null && state.circuitOpenUntil > nowMs) {
    return { allowed: false, reason: 'breaker', retryAfterMs: state.circuitOpenUntil - nowMs }
  }
  if (state.sentToday >= policy.dailyLimit) {
    const nextDay = new Date(nowMs)
    nextDay.setHours(24, 0, 0, 0)
    return { allowed: false, reason: 'daily', retryAfterMs: Math.max(60_000, nextDay.getTime() - nowMs) }
  }
  if (state.sentLastHour >= policy.hourlyLimit) {
    return { allowed: false, reason: 'hourly', retryAfterMs: 60 * 60_000 }
  }
  return { allowed: true }
}

/**
 * 对一条到期提醒做完整判定。
 * 判定顺序见设计 §2：enabled → 静默（含 P0 穿透）→ 分级 → 节流。
 */
export function decideReminder(
  policy: ReminderPolicy,
  candidate: ReminderCandidate,
  state: ThrottleState,
  nowMs: number,
): PolicyDecision {
  if (!policy.enabled) return { action: 'skip', reason: 'disabled' }

  const priority = candidate.priorityCode.toLowerCase()
  const fireMs = Date.parse(candidate.fireAt)
  if (!Number.isFinite(fireMs) || fireMs > nowMs) return { action: 'skip', reason: 'not-due' }

  // 超过补发回溯窗口：不补发，由调用方记 reminder_skipped 事件
  const windowMs = policy.catchupWindowHours * 60 * 60_000
  if (nowMs - fireMs > windowMs) return { action: 'skip', reason: 'too-old' }

  const bypass = policy.quietHoursBypassPriorities.includes(priority)
  const now = new Date(nowMs)

  if (isQuietTime(policy, now) && !bypass) {
    return { action: 'queue', reason: 'quiet-hours' }
  }

  const immediate = policy.immediatePriorities.includes(priority)
  if (!immediate) {
    // 汇总分级：到了汇总时间才发，否则排队等汇总
    if (isPastDigestTime(policy, now)) {
      const verdict = checkThrottle(policy, state, nowMs)
      return verdict.allowed ? { action: 'send', reason: 'immediate' } : { action: 'queue', reason: 'throttled' }
    }
    return { action: 'queue', reason: 'digest' }
  }

  const verdict = checkThrottle(policy, state, nowMs)
  if (!verdict.allowed) return { action: 'queue', reason: verdict.reason === 'breaker' ? 'breaker' : 'throttled' }
  return { action: 'send', reason: isQuietTime(policy, now) ? 'quiet-bypass' : 'immediate' }
}

/** 合并摘要正文（补发/队列释放共用）。 */
export function formatDigest(entries: Array<{ title: string; dueAt: string | null }>, maxItems: number): string {
  const shown = entries.slice(0, maxItems)
  const lines = shown.map((entry, index) => {
    const when = entry.dueAt === null ? '' : `（${formatDue(entry.dueAt)}）`
    return `${index + 1}. ${entry.title}${when}`
  })
  if (entries.length > shown.length) lines.push(`…等 ${entries.length} 条`)
  return lines.join('\n')
}

function formatDue(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
