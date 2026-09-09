/**
 * host 侧常驻提醒调度器：扫描到期提醒 → 策略判定 → 微信通道 / 前端降级。
 * 设计见 docs/design/2026-09-09-reminder-*.md
 *
 * 关键语义：
 * - 幂等：`fired_at` 在"已交付或已入队"后写；入队即视为已处理，投递责任转移给队列。
 * - 补发：进程启动后立即跑一次，只回溯 catchupWindowHours 内到期的提醒，合并成一条。
 * - 与前端互斥：host 写过 fired_at 的提醒，前端 `/reminders/due` 自然不再返回。
 * - 未安装/未配置通道：**不写 fired_at**，前端继续负责（静默降级）。
 */
import type { Context } from '@deepseek-ai/cordis'
// 只为类型增强 ctx.interval（随 fiber 自动销毁的定时器）；运行时不 import，避免硬依赖。
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { DatabaseSync } from 'node:sqlite'
import {
  countFiredRemindersSince,
  countQueue,
  enqueueReminder,
  fireReminder,
  getTaskRootIdOrSelf,
  listDueReminders,
  appendEvent,
} from '../db/repo.js'
import { readReminderPolicy, type ReminderPolicy } from './config.js'
import { countDraftNotifiesSince, flushDraftNotifications, scanDraftNotifications, type DraftNotifyDeps, type DraftNotifyResult } from './draft-notify.js'
import { decideReminder, formatDigest, type ReminderCandidate, type ThrottleState } from './policy.js'
import type { SendOutcome, WechatChannelAdapter } from './adapter.js'

export interface SchedulerDeps {
  db: DatabaseSync
  adapter: WechatChannelAdapter
  /** 读取用户在设置里选的投递目标是否已配置（用于"已装未配"降级口径） */
  isTargetConfigured: () => boolean
  /** 观察 dsh-im 入站消息计数（恢复信号）；不可用则返回 null */
  readInboundCount?: () => Promise<number | null>
  now?: () => Date
  log?: (message: string) => void
}

export interface ScanResult {
  scanned: number
  sent: number
  queued: number
  skipped: number
  skippedTooOld: number
  unavailable: number
}

const SCAN_INTERVAL_MS = 30_000
const QUEUE_FLUSH_INTERVAL_MS = 60_000

export class ReminderScheduler {
  private readonly deps: SchedulerDeps
  private scanning = false
  private scanningDrafts = false
  private catchupDone = false
  private disposed = false

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private policy(): ReminderPolicy {
    return readReminderPolicy(this.deps.db)
  }

  private throttleState(policy: ReminderPolicy, now: Date): ThrottleState {
    const hourAgo = new Date(now.getTime() - 60 * 60_000).toISOString()
    const dayStart = new Date(now)
    dayStart.setHours(0, 0, 0, 0)
    const verdict = this.deps.adapter.circuitVerdict()
    return {
      // 草稿通知与到期提醒共用小时/日预算，避免两类通知各自刷满限额。
      sentLastHour: countFiredRemindersSince(this.deps.db, hourAgo) + countDraftNotifiesSince(this.deps.db, hourAgo),
      sentToday: countFiredRemindersSince(this.deps.db, dayStart.toISOString()) + countDraftNotifiesSince(this.deps.db, dayStart.toISOString()),
      circuitOpenUntil: verdict.open ? now.getTime() + verdict.retryAfterMs : null,
    }
  }

  /** 草稿通知的依赖视图（与到期提醒共用适配层与节流口径）。 */
  private draftDeps(): DraftNotifyDeps {
    return {
      db: this.deps.db,
      adapter: this.deps.adapter,
      isTargetConfigured: this.deps.isTargetConfigured,
      throttleState: (policy, now) => this.throttleState(policy, now),
      now: this.deps.now,
    }
  }

  /** 扫描一次草稿通知（验收申请等）。与到期提醒同轮次执行，独立节流预算。 */
  async scanDrafts(): Promise<DraftNotifyResult> {
    const empty: DraftNotifyResult = { scanned: 0, sent: 0, queued: 0, skipped: 0, unavailable: 0 }
    if (this.disposed || this.scanningDrafts) return empty
    const policy = this.policy()
    if (!policy.enabled) return empty
    this.scanningDrafts = true
    try {
      return await scanDraftNotifications(this.draftDeps(), policy)
    } finally {
      this.scanningDrafts = false
    }
  }

  /** 扫描一次。可重入保护：上一次未结束时直接跳过。 */
  async scan(options: { catchup?: boolean } = {}): Promise<ScanResult> {
    const result: ScanResult = { scanned: 0, sent: 0, queued: 0, skipped: 0, skippedTooOld: 0, unavailable: 0 }
    if (this.disposed || this.scanning) return result
    this.scanning = true
    try {
      const policy = this.policy()
      if (!policy.enabled) return result
      const now = this.now()
      const nowMs = now.getTime()
      // 不在这里按窗口过滤：窗口判定交给 decideReminder，这样"过期跳过"能记事件。
      const due = listDueReminders(this.deps.db, now)
      result.scanned = due.length
      if (due.length === 0) return result

      const state = this.throttleState(policy, now)
      const channelReady = this.deps.adapter.available() && this.deps.isTargetConfigured()

      // 未安装 / 未配置：不写 fired_at，让前端继续负责；只记一次事件（防刷）
      if (!channelReady) {
        for (const reminder of due) {
          result.unavailable += 1
          this.appendEventOnce(reminder.taskId, 'reminder_channel_unavailable', {
            reminderId: reminder.reminderId,
            reason: this.deps.adapter.available() ? 'not-configured' : 'not-installed',
          }, now)
        }
        return result
      }

      // 补发模式：把窗口内到期的合并成一条，不逐条发；窗口外的只记跳过事件。
      if (options.catchup === true) {
        const windowMs = policy.catchupWindowHours * 60 * 60_000
        const fresh = due.filter((reminder) => {
          const fireMs = Date.parse(reminder.dueAt) - reminder.offsetMinutes * 60_000
          return Number.isFinite(fireMs) && nowMs - fireMs <= windowMs
        })
        for (const reminder of due) {
          if (fresh.includes(reminder)) continue
          result.skipped += 1
          result.skippedTooOld += 1
          this.appendEventOnce(reminder.taskId, 'reminder_skipped', { reminderId: reminder.reminderId, reason: 'too-old' }, now)
        }
        if (fresh.length === 0) return result
        const entries = fresh.map((reminder) => ({ reminder, candidate: this.toCandidate(reminder) }))
        const body = formatDigest(entries.map((entry) => ({ title: entry.candidate.title, dueAt: entry.candidate.dueAt })), policy.catchupMaxItems)
        const outcome = await this.deps.adapter.send({ title: '工作台 · 错过的工作台提醒', body, priorityCode: 'p1' })
        for (const entry of entries) {
          if (outcome.ok) {
            fireReminder(this.deps.db, entry.reminder.reminderId, now.toISOString())
            result.sent += 1
            this.appendEventOnce(entry.reminder.taskId, 'reminder_fired', { reminderId: entry.reminder.reminderId, channel: 'wechat', mode: 'catchup' }, now)
          } else {
            this.enqueue(entry.reminder, entry.candidate, outcome, policy, now)
            result.queued += 1
          }
        }
        return result
      }

      for (const reminder of due) {
        const candidate = this.toCandidate(reminder)
        const decision = decideReminder(policy, candidate, state, nowMs)
        if (decision.action === 'skip') {
          result.skipped += 1
          if (decision.reason === 'too-old') {
            result.skippedTooOld += 1
            this.appendEventOnce(reminder.taskId, 'reminder_skipped', { reminderId: reminder.reminderId, reason: 'too-old' }, now)
          }
          continue
        }
        if (decision.action === 'queue') {
          this.enqueue(reminder, candidate, { ok: false, reason: decision.reason === 'breaker' ? 'throttled' : 'throttled', detail: decision.reason }, policy, now)
          result.queued += 1
          continue
        }
        const outcome = await this.deps.adapter.send({ title: `任务提醒：${candidate.title}`, body: `到期时间：${candidate.dueAt}`, priorityCode: candidate.priorityCode })
        if (outcome.ok) {
          fireReminder(this.deps.db, reminder.reminderId, now.toISOString())
          result.sent += 1
          this.appendEventOnce(reminder.taskId, 'reminder_fired', { reminderId: reminder.reminderId, channel: 'wechat', mode: decision.reason }, now)
        } else {
          this.enqueue(reminder, candidate, outcome, policy, now)
          result.queued += 1
        }
      }
      return result
    } finally {
      this.scanning = false
    }
  }

  /** 释放队列（合并成一条）。 */
  async flushQueue(): Promise<{ sent: number; merged: number; failed: number; reason?: string }> {
    if (this.disposed) return { sent: 0, merged: 0, failed: 0 }
    const policy = this.policy()
    if (!policy.enabled) return { sent: 0, merged: 0, failed: 0 }
    const reminderOutcome = await this.deps.adapter.flushQueue()
    // 草稿通知队列独立释放（同一轮次），失败不影响到期提醒的结果。
    try {
      const draftOutcome = await flushDraftNotifications(this.draftDeps(), policy)
      return {
        sent: reminderOutcome.sent + draftOutcome.sent,
        merged: reminderOutcome.merged + draftOutcome.merged,
        failed: reminderOutcome.failed + draftOutcome.failed,
        reason: reminderOutcome.reason,
      }
    } catch (error) {
      this.log(`draft flush failed: ${String(error)}`)
      return reminderOutcome
    }
  }

  /** 启动补发：进程启动后立即跑一次，只跑一次。 */
  async catchup(): Promise<ScanResult | null> {
    if (this.catchupDone) return null
    this.catchupDone = true
    const policy = this.policy()
    if (!policy.enabled) return null
    return this.scan({ catchup: true })
  }

  /**
   * 注册定时任务。用 ctx.interval（随 fiber 自动销毁），不用裸 setInterval。
   * 调用方必须已经声明 timer 依赖（见 index.ts 的 ctx.inject(['timer'], ...)）。
   * 返回 dispose 函数，供测试与手动关闭使用。
   */
  start(ctx: Context): () => void {
    const scanDispose = ctx.interval(() => {
      void this.scan().catch((error) => this.log(`scan failed: ${String(error)}`))
      void this.scanDrafts().catch((error) => this.log(`draft scan failed: ${String(error)}`))
    }, SCAN_INTERVAL_MS)
    const flushDispose = ctx.interval(() => {
      void (async () => {
        if (this.deps.readInboundCount !== undefined) {
          try {
            const count = await this.deps.readInboundCount()
            if (count !== null) {
              const recovered = this.deps.adapter.noteInboundCount(count)
              if (recovered) this.log('微信发送能力恢复信号已探测到，熔断转入半开')
            }
          } catch { /* 恢复信号是增强，不是必需 */ }
        }
        await this.flushQueue().catch((error) => this.log(`flush failed: ${String(error)}`))
      })()
    }, QUEUE_FLUSH_INTERVAL_MS)
    return () => { scanDispose(); flushDispose(); this.disposed = true }
  }

  private toCandidate(reminder: { reminderId: string; taskId: string; title: string; dueAt: string; offsetMinutes: number }): ReminderCandidate {
    const dueMs = Date.parse(reminder.dueAt)
    const fireAt = Number.isFinite(dueMs) ? new Date(dueMs - reminder.offsetMinutes * 60_000).toISOString() : reminder.dueAt
    const task = this.deps.db.prepare('SELECT priority_code FROM tasks WHERE id = ?').get(reminder.taskId) as { priority_code: string } | undefined
    return {
      reminderId: reminder.reminderId,
      taskId: reminder.taskId,
      rootTaskId: getTaskRootIdOrSelf(this.deps.db, reminder.taskId),
      title: reminder.title,
      priorityCode: task?.priority_code ?? 'p2',
      dueAt: reminder.dueAt,
      fireAt,
    }
  }

  private enqueue(
    reminder: { reminderId: string; taskId: string },
    candidate: ReminderCandidate,
    outcome: Extract<SendOutcome, { ok: false }>,
    policy: ReminderPolicy,
    now: Date,
  ): void {
    const nextAttempt = new Date(now.getTime() + (outcome.retryAfterMs ?? policy.breakerCooldownMinutes * 60_000)).toISOString()
    enqueueReminder(this.deps.db, {
      reminderId: reminder.reminderId,
      rootTaskId: candidate.rootTaskId,
      taskId: reminder.taskId,
      title: candidate.title,
      body: `到期时间：${candidate.dueAt}`,
      priorityCode: candidate.priorityCode,
      dueAt: candidate.dueAt,
      nextAttemptAt: nextAttempt,
    }, now.toISOString())
    // 入队即视为已处理：防止实时扫描反复取到同一条并反复撞限流
    fireReminder(this.deps.db, reminder.reminderId, now.toISOString())
    this.appendEventOnce(reminder.taskId, 'reminder_queued', { reminderId: reminder.reminderId, reason: outcome.reason, detail: outcome.detail ?? null }, now)
  }

  /** 同一任务同一事件类型只记一次，避免 30 秒一轮刷屏。 */
  private appendEventOnce(taskId: string, eventCode: string, payload: Record<string, unknown>, now: Date): void {
    const existing = this.deps.db.prepare(
      "SELECT COUNT(*) AS c FROM task_events WHERE task_id = ? AND event_code = ? AND note LIKE ?",
    ).get(taskId, eventCode, `%${String(payload.reminderId ?? '')}%`) as { c: number }
    if (existing.c > 0) return
    appendEvent(this.deps.db, taskId, eventCode, { actor: 'system', note: String(payload.reminderId ?? ''), at: now.toISOString(), after: payload })
  }

  private log(message: string): void {
    this.deps.log?.(`[workbench-reminder] ${message}`)
  }

  /** 队列长度（供状态接口）。 */
  queued(): number {
    return countQueue(this.deps.db)
  }
}
