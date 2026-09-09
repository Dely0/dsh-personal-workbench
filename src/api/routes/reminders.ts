/**
 * 提醒域路由：策略读写、通道状态与目标选择、测试发送。
 * 从 routes.ts 抽出（行为不变），依赖由入口注入。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { listQueue, writeMeta } from '../../db/repo.js'
import { isLoopbackRequest, pathSegments, readJsonBody, writeJson } from './helpers.js'

export interface ReminderRouteDeps {
  /** 通道状态与目标选择（由入口注入；缺省时提醒相关接口返回未安装） */
  channel?: {
    status(): unknown
    listOptions(): Promise<unknown>
    resolveTarget(): Promise<unknown>
  }
  /** 策略读写 */
  policy?: { read(): unknown; write(raw: unknown): unknown }
  /** 发送测试消息（设置页用） */
  test?: () => Promise<{ ok: boolean; reason?: string }>
  /** 到期提醒列表（prefix 路由用） */
  listDue?: () => unknown
  /** 标记提醒已触发（prefix 路由用） */
  fire?: (reminderId: string) => void
}

export function makeReminderRoutes(db: DatabaseSync, deps: ReminderRouteDeps = {}): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: '/api/workbench/reminders/policy',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if (deps.policy === undefined) return writeJson(res, 503, { error: 'reminder policy unavailable' })
        const method = req.method ?? 'GET'
        if (method === 'GET') return writeJson(res, 200, { ok: true, policy: deps.policy.read() })
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          return writeJson(res, 200, { ok: true, policy: deps.policy.write(body) })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/api/workbench/reminders/channel',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if (deps.channel === undefined) return writeJson(res, 503, { error: 'reminder channel unavailable' })
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          const options = await deps.channel.listOptions()
          return writeJson(res, 200, { ok: true, status: deps.channel.status(), options, queue: listQueue(db, 20) })
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          // 只保存投递目标选择；通道本身的扫码/凭证全归 dsh-im。
          if ('botId' in body) writeMeta(db, 'reminder_bot_id', typeof body.botId === 'string' ? body.botId : '')
          if ('targetId' in body) writeMeta(db, 'reminder_target_id', typeof body.targetId === 'string' ? body.targetId : '')
          await deps.channel.resolveTarget()
          return writeJson(res, 200, { ok: true, status: deps.channel.status() })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/api/workbench/reminders/test',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        if (deps.test === undefined) return writeJson(res, 503, { error: 'reminder channel unavailable' })
        const result = await deps.test()
        return writeJson(res, 200, result)
      },
    },
    {
      kind: 'prefix',
      path: '/api/workbench/reminders',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, '/api/workbench/reminders')
        const method = req.method ?? 'GET'
        if (segments.length === 1 && segments[0] === 'due' && method === 'GET') {
          return writeJson(res, 200, { ok: true, reminders: deps.listDue === undefined ? [] : deps.listDue() })
        }
        if (segments.length === 2 && segments[1] === 'fire' && method === 'POST') {
          if (deps.fire === undefined) return writeJson(res, 503, { error: 'reminders unavailable' })
          deps.fire(segments[0])
          return writeJson(res, 200, { ok: true })
        }
        return writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}
