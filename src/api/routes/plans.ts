/**
 * 每日计划域路由（读取 / 全量保存 / 原子追加 / 项级更新 / 删除）。
 *
 * ## 为什么 POST 与 PATCH 必须存在（requirements §4.2.4/§4.2.5）
 *
 * 旧的唯一写入路径是 `PUT /plans/:date`（全量替换）。用"客户端缓存的旧列表 + PUT"
 * 模拟"一键排入"会**覆盖别的窗口/并发追加刚加进去的成员**（真实并发丢件的成因），
 * 所以这里新增两条**服务端原子**入口：
 * - `POST /plans/:date/items` —— 一键排入的唯一入口，事务内读最新计划后按末尾 order 追加；
 * - `PATCH /plans/:date/items/:taskId` —— 项级更新，只动目标项，不写回整份计划。
 *
 * 所有写入都在仓储层（`db/repo/plans.ts`）做共同校验（任务存在/关闭/父子链），
 * 路由层只管 HTTP 语义：日期合法性、过去只读、未来不得结束投入、404 与 400 的区分。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import {
  addDailyPlanItem, deleteDailyPlan, getDailyPlan, updateDailyPlan, updateDailyPlanItem,
  type DailyPlanRow, type ManualPlanItemInput,
} from '../../db/repo.js'
import { isLoopbackRequest, pathSegments, PERIOD_DATE_RE, PLANS_PREFIX, readJsonBody, writeJson } from './helpers.js'

/** 服务器本地日的 YYYY-MM-DD（与仓储层 `localDateString` 同口径，这里不 import 客户端模块）。 */
function localDateString(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** 计划日 D 的本地日起止 epoch（容量/候选的日界判定用显式区间，便于午夜/DST 测试）。 */
export function localDayRange(date: string): { startMs: number; endMs: number } | undefined {
  if (!PERIOD_DATE_RE.test(date)) return undefined
  const [y, m, d] = date.split('-').map(Number)
  const start = new Date(y, m - 1, d, 0, 0, 0, 0)
  if (Number.isNaN(start.getTime())) return undefined
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

/**
 * 计划回执形状：`readable=false` 时界面显示"不可计算"，`taskStatusCode` 让行内能
 * 标注"任务不存在/已关闭"（计划行本身仍然保留，那是历史记录）。
 */
function planResponse(db: DatabaseSync, plan: DailyPlanRow | undefined): Record<string, unknown> {
  if (plan === undefined) return { ok: true, plan: null }
  const rows = db.prepare('SELECT id, status_code, archived FROM tasks').all() as unknown as Array<{ id: string; status_code: string; archived: number }>
  const statusOf = new Map(rows.map((row) => [row.id, row.archived === 1 ? 'archived' : row.status_code]))
  return {
    ok: true,
    plan: {
      ...plan,
      items: plan.items.map((item) => ({ ...item, taskStatusCode: statusOf.get(item.taskId) ?? 'missing' })),
    },
  }
}

function readItemsFromBody(body: Record<string, unknown>): ManualPlanItemInput[] | undefined {
  if (!Array.isArray(body.items)) return undefined
  return (body.items as unknown[]).map((entry) => {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const raw: ManualPlanItemInput = {
      taskId: typeof item.taskId === 'string' ? item.taskId : '',
      order: typeof item.order === 'number' ? item.order : undefined,
      note: typeof item.note === 'string' ? item.note : undefined,
    }
    // `minutes` 只接受显式数字；缺字段 = 省略（= 保留既有值），而不是当作 0。
    if (typeof item.minutes === 'number') raw.minutes = item.minutes
    return raw
  })
}

export function makePlanRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: PLANS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, PLANS_PREFIX)
        const method = req.method ?? 'GET'
        const today = localDateString()

        // GET /plans?date=YYYY-MM-DD
        if (segments.length === 0 && method === 'GET') {
          const planDate = url.searchParams.get('date') ?? today
          if (!PERIOD_DATE_RE.test(planDate)) return writeJson(res, 400, { error: 'date must be YYYY-MM-DD' })
          return writeJson(res, 200, planResponse(db, getDailyPlan(db, planDate)))
        }

        // PUT /plans/:date —— 全量编辑（旧客户端省略新字段时按 taskId 保留服务端最新值）
        if (segments.length === 1 && method === 'PUT') {
          if (!PERIOD_DATE_RE.test(segments[0])) return writeJson(res, 400, { error: 'invalid plan date' })
          if (segments[0] < today) return writeJson(res, 400, { error: 'past plan is read-only' })
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const items = readItemsFromBody(body)
          if (items === undefined || items.length === 0) return writeJson(res, 400, { error: 'items 不能为空（清空计划请用 DELETE）' })
          try {
            const plan = updateDailyPlan(db, segments[0], {
              summary: typeof body.summary === 'string' ? body.summary : undefined,
              items,
              sourceCode: 'manual',
              sessionId: null,
            })
            return writeJson(res, 200, planResponse(db, plan))
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }

        // DELETE /plans/:date
        if (segments.length === 1 && method === 'DELETE') {
          if (!PERIOD_DATE_RE.test(segments[0])) return writeJson(res, 400, { error: 'invalid plan date' })
          return writeJson(res, 200, { ok: true, deleted: deleteDailyPlan(db, segments[0]) })
        }

        // POST /plans/:date/items —— 一键排入的唯一入口（原子追加，幂等）
        if (segments.length === 2 && segments[1] === 'items' && method === 'POST') {
          const planDate = segments[0]
          if (!PERIOD_DATE_RE.test(planDate)) return writeJson(res, 400, { error: 'invalid plan date' })
          if (planDate < today) return writeJson(res, 400, { error: 'past plan is read-only' })
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const taskId = typeof body.taskId === 'string' ? body.taskId : ''
          if (taskId === '') return writeJson(res, 400, { error: 'taskId 必填' })
          if (body.minutes !== undefined && typeof body.minutes !== 'number') {
            return writeJson(res, 400, { error: 'minutes 必须是数字（省略该字段才走默认投入）' })
          }
          const result = addDailyPlanItem(db, planDate, {
            taskId,
            minutes: typeof body.minutes === 'number' ? body.minutes : undefined,
          })
          if (!result.ok) {
            // 任务不存在 → 404；关闭/归档/父子链冲突 → 400（"资源不存在"与"状态不对"是两件事）。
            const status = /不存在/.test(result.error) ? 404 : 400
            return writeJson(res, status, { error: result.error })
          }
          const payload = planResponse(db, result.plan) as { plan: unknown }
          return writeJson(res, 200, { ok: true, plan: payload.plan, added: result.added })
        }

        // PATCH /plans/:date/items/:taskId —— 项级更新
        if (segments.length === 3 && segments[1] === 'items' && method === 'PATCH') {
          const planDate = segments[0]
          const taskId = decodeURIComponent(segments[2])
          if (!PERIOD_DATE_RE.test(planDate)) return writeJson(res, 400, { error: 'invalid plan date' })
          if (planDate < today) return writeJson(res, 400, { error: 'past plan is read-only' })
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const hasMinutes = body.minutes !== undefined
          const hasEffort = body.effortDone !== undefined
          if (!hasMinutes && !hasEffort) return writeJson(res, 400, { error: '至少要给 minutes 或 effortDone 之一' })
          if (hasMinutes && typeof body.minutes !== 'number') return writeJson(res, 400, { error: 'minutes 必须是数字' })
          if (hasEffort && typeof body.effortDone !== 'boolean') return writeJson(res, 400, { error: 'effortDone 必须是布尔值' })
          // 结束投入只在**当天**可写：未来日期可以编辑分钟，但不允许把投入标成"已结束"。
          if (hasEffort && planDate > today) {
            return writeJson(res, 400, { error: 'effortDone 只在当天可写：未来的计划不能标记「今日投入结束」' })
          }
          const result = updateDailyPlanItem(db, planDate, taskId, {
            minutes: hasMinutes ? body.minutes as number : undefined,
            effortDone: hasEffort ? body.effortDone as boolean : undefined,
          })
          if (!result.ok) {
            const status = result.notFound === true ? 404 : 400
            return writeJson(res, status, { error: result.error })
          }
          return writeJson(res, 200, planResponse(db, result.plan))
        }

        return writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}
