/**
 * 微信提醒通道适配层：软探测 dsh-im、解析投递目标、错误归一化、熔断与队列。
 * 设计见 docs/design/2026-09-09-reminder-channel-adapter.md
 *
 * 硬约束：本层永不抛错，所有失败都变成 SendOutcome。
 * 绝不静态 inject dshIm —— 未安装时必须静默降级（ctx.get 软探测返回 undefined）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import { breakerCooldownMs, readReminderPolicy, type ReminderPolicy } from './config.js'
import { formatDigest } from './policy.js'

/** dsh-im 暴露的服务形状（结构化类型，便于测试注入假实现）。 */
export interface DshImService {
  send(botId: string, targetId: string, text: string, opts?: { signal?: AbortSignal }): Promise<unknown>
  listTargets(botId: string): Promise<Array<{ targetId: string; name?: string; kind?: string; route?: Record<string, unknown> }>>
  listBots(): Promise<Array<{ botId: string; name?: string; channel?: string; state?: string; connected?: boolean }>> | Array<{ botId: string; name?: string; channel?: string; state?: string; connected?: boolean }>
}

export type SendOutcome =
  | { ok: true; delivered: true }
  | { ok: false; reason: 'not-installed' | 'not-configured' | 'channel-offline' | 'throttled' | 'failed'; detail?: string; retryAfterMs?: number }

export interface ChannelStatus {
  installed: boolean
  configured: boolean
  botId: string | null
  targetId: string | null
  botLabel: string | null
  circuitOpen: boolean
  circuitUntil: string | null
  queued: number
}

export interface ResolvedTarget {
  botId: string
  targetId: string
  botLabel: string | null
}

export interface AdapterDeps {
  db: DatabaseSync
  /** 读取 dsh-im 服务；返回 undefined 表示未安装 */
  probe: () => DshImService | undefined
  /** 读取用户在设置里选的投递目标（botId/targetId） */
  readConfiguredTarget: () => { botId: string | null; targetId: string | null }
  /** 队列操作 */
  queue: {
    enqueue(entry: { reminderId: string | null; rootTaskId: string; taskId: string; title: string; body: string; priorityCode: string; dueAt: string | null }, nextAttemptAt: string): void
    listDue(nowIso: string): Array<{ id: string; reminderId: string | null; rootTaskId: string; taskId: string; title: string; body: string; priorityCode: string; dueAt: string | null; attempts: number }>
    remove(id: string): void
    markAttempt(id: string, error: string, nextAttemptAt: string): void
    count(): number
    statsSince(iso: string): number
  }
  now?: () => Date
}

interface CircuitState {
  failures: number
  openUntil: number | null
  halfOpen: boolean
}

const WEIXIN_CHANNEL = 'weixin'

export class WechatChannelAdapter {
  readonly id = 'wechat' as const
  private readonly deps: AdapterDeps
  private circuit: CircuitState = { failures: 0, openUntil: null, halfOpen: false }
  private cachedTarget: ResolvedTarget | null = null
  private lastSeenInboundCount = -1

  constructor(deps: AdapterDeps) {
    this.deps = deps
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private policy(): ReminderPolicy {
    return readReminderPolicy(this.deps.db)
  }

  available(): boolean {
    return this.deps.probe() !== undefined
  }

  /** 解析投递目标：设置里选的 → 自动发现（只取 weixin 渠道）。 */
  async resolveTarget(): Promise<ResolvedTarget | null> {
    const im = this.deps.probe()
    if (im === undefined) {
      this.cachedTarget = null
      return null
    }
    const configured = this.deps.readConfiguredTarget()
    let bots: Array<{ botId: string; name?: string; channel?: string }>
    try {
      const listed = await im.listBots()
      bots = Array.isArray(listed) ? listed : []
    } catch {
      return this.cachedTarget
    }
    const weixinBots = bots.filter((bot) => bot.channel === undefined || bot.channel === WEIXIN_CHANNEL)
    if (weixinBots.length === 0) {
      this.cachedTarget = null
      return null
    }
    const bot = (configured.botId !== null ? weixinBots.find((candidate) => candidate.botId === configured.botId) : undefined)
      ?? (weixinBots.length === 1 ? weixinBots[0] : undefined)
    if (bot === undefined) {
      this.cachedTarget = null
      return null
    }
    let targets: Array<{ targetId: string; kind?: string }>
    try {
      targets = await im.listTargets(bot.botId)
    } catch {
      return this.cachedTarget
    }
    const target = (configured.targetId !== null ? targets.find((candidate) => candidate.targetId === configured.targetId) : undefined)
      ?? targets.find((candidate) => candidate.kind === 'user')
      ?? (targets.length === 1 ? targets[0] : undefined)
    if (target === undefined) {
      this.cachedTarget = null
      return null
    }
    this.cachedTarget = { botId: bot.botId, targetId: target.targetId, botLabel: bot.name ?? null }
    return this.cachedTarget
  }

  /** 供设置页：列出可选机器人/目标（不返回任何凭据）。 */
  async listOptions(): Promise<{ installed: boolean; bots: Array<{ botId: string; label: string; targets: Array<{ targetId: string; label: string; kind: string }> }> }> {
    const im = this.deps.probe()
    if (im === undefined) return { installed: false, bots: [] }
    let bots: Array<{ botId: string; name?: string; channel?: string }>
    try {
      const listed = await im.listBots()
      bots = Array.isArray(listed) ? listed : []
    } catch {
      return { installed: true, bots: [] }
    }
    const result: Array<{ botId: string; label: string; targets: Array<{ targetId: string; label: string; kind: string }> }> = []
    for (const bot of bots.filter((candidate) => candidate.channel === undefined || candidate.channel === WEIXIN_CHANNEL)) {
      let targets: Array<{ targetId: string; name?: string; kind?: string }> = []
      try {
        targets = await im.listTargets(bot.botId)
      } catch { /* 单个 bot 失败不影响其他 */ }
      result.push({
        botId: bot.botId,
        label: bot.name ?? bot.botId,
        targets: targets.map((target) => ({ targetId: target.targetId, label: target.name ?? target.targetId, kind: target.kind ?? 'user' })),
      })
    }
    return { installed: true, bots: result }
  }

  status(): ChannelStatus {
    const target = this.cachedTarget
    const policy = this.policy()
    const nowMs = this.now().getTime()
    const open = this.circuit.openUntil !== null && this.circuit.openUntil > nowMs
    return {
      installed: this.available(),
      configured: target !== null,
      botId: target?.botId ?? null,
      targetId: target?.targetId ?? null,
      botLabel: target?.botLabel ?? null,
      circuitOpen: open,
      circuitUntil: open ? new Date(this.circuit.openUntil as number).toISOString() : null,
      queued: this.deps.queue.count(),
    }
  }

  /** 熔断判定：供策略层在发送前短路（避免无谓网络请求）。 */
  circuitVerdict(): { open: boolean; retryAfterMs: number } {
    const nowMs = this.now().getTime()
    if (this.circuit.openUntil !== null && this.circuit.openUntil > nowMs) {
      return { open: true, retryAfterMs: this.circuit.openUntil - nowMs }
    }
    return { open: false, retryAfterMs: 0 }
  }

  private openCircuit(policy: ReminderPolicy): void {
    this.circuit.failures += 1
    this.circuit.openUntil = this.now().getTime() + breakerCooldownMs(policy, this.circuit.failures)
    this.circuit.halfOpen = false
  }

  private closeCircuit(): void {
    this.circuit = { failures: 0, openUntil: null, halfOpen: false }
  }

  /**
   * 观察 dsh-im 的入站消息计数：增长说明账号恢复了发送能力（实测的官方恢复路径）。
   * 返回 true 表示刚刚探测到恢复，熔断转入 HALF_OPEN 立刻试探。
   */
  noteInboundCount(count: number): boolean {
    const grew = this.lastSeenInboundCount >= 0 && count > this.lastSeenInboundCount
    this.lastSeenInboundCount = count
    if (grew && this.circuit.openUntil !== null) {
      // 收到用户消息 = 发送能力恢复信号，转入 HALF_OPEN 立刻试探
      this.circuit.openUntil = null
      this.circuit.halfOpen = true
      return true
    }
    return false
  }

  /** 发送一条文本。永不 reject。 */
  async send(message: { title: string; body: string; priorityCode?: string }): Promise<SendOutcome> {
    const policy = this.policy()
    const im = this.deps.probe()
    if (im === undefined) return { ok: false, reason: 'not-installed' }

    const verdict = this.circuitVerdict()
    if (verdict.open) return { ok: false, reason: 'throttled', detail: 'circuit-open', retryAfterMs: verdict.retryAfterMs }

    const target = await this.resolveTarget()
    if (target === null) return { ok: false, reason: 'not-configured' }

    const text = message.title.trim() === '' ? message.body : `${message.title}\n${message.body}`
    try {
      await im.send(target.botId, target.targetId, text)
      this.closeCircuit()
      return { ok: true, delivered: true }
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code
      const reason = normalizeErrorCode(code)
      if (reason === 'failed') this.openCircuit(policy)
      return { ok: false, reason, detail: typeof code === 'string' ? code : undefined }
    }
  }

  /**
   * 释放队列：把待发条目**合并成一条**再发（不逐条放，避免集中撞限流）。
   * 返回本次处理结果，供调度器回写事件。
   */
  async flushQueue(): Promise<{ sent: number; merged: number; failed: number; reason?: string }> {
    const policy = this.policy()
    if (!policy.enabled) return { sent: 0, merged: 0, failed: 0 }
    const now = this.now()
    const entries = this.deps.queue.listDue(now.toISOString())
    if (entries.length === 0) return { sent: 0, merged: 0, failed: 0 }
    const verdict = this.circuitVerdict()
    if (verdict.open) return { sent: 0, merged: 0, failed: 0 }

    const body = formatDigest(entries.map((entry) => ({ title: entry.title, dueAt: entry.dueAt })), policy.catchupMaxItems)
    const outcome = await this.send({ title: '工作台 · 待办提醒', body, priorityCode: entries[0]?.priorityCode })
    if (outcome.ok) {
      for (const entry of entries) this.deps.queue.remove(entry.id)
      return { sent: entries.length, merged: 1, failed: 0 }
    }
    const retryAt = new Date(now.getTime() + (outcome.retryAfterMs ?? 15 * 60_000)).toISOString()
    for (const entry of entries) this.deps.queue.markAttempt(entry.id, outcome.reason, retryAt)
    return { sent: 0, merged: 0, failed: entries.length, reason: outcome.reason }
  }
}

/** dsh-im 错误码 → 归一化原因。见设计 §5 映射表。 */
export function normalizeErrorCode(code: string | undefined): Extract<SendOutcome, { ok: false }>['reason'] {
  switch (code) {
    case 'bot-not-connected':
      return 'channel-offline'
    case 'unknown-bot':
    case 'unknown-target':
      return 'not-configured'
    case 'cancelled':
      return 'channel-offline'
    case 'delivery-failed':
    case 'target-rejected':
    case 'bad-request':
      return 'failed'
    default:
      return 'failed'
  }
}

/** 从 DSH 上下文软探测 dsh-im 服务（唯一允许的探测方式）。 */
export function probeDshIm(ctx: Context): DshImService | undefined {
  const service = ctx.get('dshIm') as Partial<DshImService> | undefined
  if (service === undefined) return undefined
  if (typeof service.send !== 'function' || typeof service.listTargets !== 'function' || typeof service.listBots !== 'function') return undefined
  return service as DshImService
}
