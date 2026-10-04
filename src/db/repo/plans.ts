/**
 * 每日计划域（V2 每日 AI 智能排序 + 每日投入）。
 *
 * ## 这个模块的职责边界（T2/D05–D06）
 *
 * 它是**计划写入的唯一权威源**：草稿确认、用户全量编辑、一键追加、项级 PATCH 全部
 * 收敛到这里，共同校验（任务存在/关闭/父子链）、minutes 快照保留与 `effortDone`
 * 只由用户写这三件事**只有一份实现**（`shared/dailyPlanPolicy.ts`）。
 *
 * 三条不许违反的规则（需求 §4.1/§4.2）：
 * 1. **minutes 是快照**：新项在提案创建那一刻算出来就冻结；同 taskId 的既有项在
 *    重新排序/改备注/重复确认中保留原值，只有显式给 minutes 才更改。
 * 2. **`effortDone` 只能由用户写**：AI 工具传它直接报错（见 tools.ts），确认路径
 *    一律取服务端最新值，绝不用过时草稿覆盖用户当天的结束状态。
 * 3. **未知任务只拒绝新增**：事务里读到既有计划中的缺失/关闭项允许原样保留
 *    （不准为了"过滤"而默默移除，那是静默丢件）。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, getDraft, withDraftConfirm, getTask, type DraftRow } from '../repo.js'
import {
  DEFAULT_PLAN_MINUTES,
  checkPlanMinutes,
  checkPlanTaskSet,
  expandPlanLeaves,
  mergePlanItems,
  parsePlanItems,
  type PlanItemShape,
  type PlanTaskRef,
} from '../../shared/dailyPlanPolicy.js'
import { parseDraft, type RawDraftRow } from './shared.js'

export type DailyPlanItem = PlanItemShape

export interface DailyPlanInput {
  planDate: string
  summary?: string
  items: DailyPlanItem[]
  sourceCode?: string
  sessionId?: string | null
}

export interface DailyPlanRow {
  id: string
  planDate: string
  summary: string
  items: DailyPlanItem[]
  sourceCode: string
  sessionId: string | null
  createdAt: string
  updatedAt: string
  /**
   * 读取时的诊断（坏项/非法 minutes）。**不落库** —— 数据可能被手工修好，
   * 存一份快照会变成假的告警。`items_json` 整体不可解析时这里给"无法解析"。
   */
  diagnostics: string[]
  /** `items_json` 整体不可解析（容量必须显示"不可计算"而不是 0）。 */
  readable: boolean
}

export interface ManualPlanItemInput {
  taskId: string
  order?: number
  note?: string
  minutes?: number
  title?: string
}

interface RawDailyPlanRow {
  id: string
  plan_date: string
  summary: string
  items_json: string
  source_code: string
  session_id: string | null
  created_at: string
  updated_at: string
}

/** 计划任务的校验视图（一次查全量，避免逐项 getTask 的 N+1）。 */
export interface PlanTaskView extends PlanTaskRef {
  estimatedMinutes: number | null
  priorityCode: string
  effectiveDueAt: string | null
  createdAt: string
}

function toPlanTaskRef(task: PlanTaskView): PlanTaskRef {
  return { id: task.id, parentId: task.parentId, title: task.title, statusCode: task.statusCode, archived: task.archived }
}

/** 读取全量任务的计划校验视图（按 id 索引）。 */
function loadPlanTasks(db: DatabaseSync): Map<string, PlanTaskView> {
  const rows = db.prepare(
    'SELECT id, parent_id, title, status_code, archived, estimated_minutes, priority_code, due_at, created_at FROM tasks',
  ).all() as unknown as Array<{
    id: string
    parent_id: string | null
    title: string
    status_code: string
    archived: number
    estimated_minutes: number | null
    priority_code: string
    due_at: string | null
    created_at: string
  }>
  const map = new Map<string, PlanTaskView>()
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      parentId: row.parent_id,
      title: row.title,
      statusCode: row.status_code,
      archived: row.archived,
      estimatedMinutes: row.estimated_minutes,
      priorityCode: row.priority_code,
      // 这里只需要"有没有截止"用于展示；不做父链继承（候选判定在 shared/dailyPlanPolicy
      // 里用客户端/仓储已算好的 effectiveDueAt）。
      effectiveDueAt: row.due_at,
      createdAt: row.created_at,
    })
  }
  return map
}

function planTaskTitle(tasks: ReadonlyMap<string, PlanTaskView>, taskId: string): string {
  return tasks.get(taskId)?.title ?? ''
}

function defaultEstimateMinutes(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'default_estimate_minutes'").get() as { value: string } | undefined
  const parsed = row === undefined ? Number.NaN : Number(row.value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1440 ? parsed : DEFAULT_PLAN_MINUTES
}

function parseDailyPlan(row: RawDailyPlanRow | undefined): DailyPlanRow | undefined {
  if (row === undefined) return undefined
  const parsed = parsePlanItems(row.items_json)
  const base = {
    id: row.id,
    planDate: row.plan_date,
    summary: row.summary,
    sourceCode: row.source_code,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (!parsed.readable) {
    // 坏数据**原样保留**（一个字节都不动）：这里只是把它读成"不可解析"，
    // 让 GET / 容量显示"不可计算 + 原因"，而不是假装没有计划或自作主张清空。
    return { ...base, items: [], diagnostics: [`计划 ${row.plan_date} 的 ${parsed.reason}，无法解析（原数据未改动）`], readable: false }
  }
  return { ...base, items: parsed.items, diagnostics: parsed.diagnostics.map((text) => `计划 ${row.plan_date}：${text}`), readable: true }
}

export function getDailyPlan(db: DatabaseSync, planDate: string): DailyPlanRow | undefined {
  return parseDailyPlan(db.prepare('SELECT * FROM daily_plans WHERE plan_date = ?').get(planDate) as RawDailyPlanRow | undefined)
}

function insertDailyPlan(db: DatabaseSync, input: { planDate: string; summary: string; items: DailyPlanItem[]; sourceCode: string; sessionId: string | null }, at: string, id: string = randomUUID()): void {
  db.prepare(`
    INSERT INTO daily_plans (id, plan_date, summary, items_json, source_code, session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_date) DO UPDATE SET
      summary = excluded.summary,
      items_json = excluded.items_json,
      source_code = excluded.source_code,
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
  `).run(id, input.planDate, input.summary, JSON.stringify(input.items), input.sourceCode, input.sessionId, at, at)
}

/**
 * 底层写入原语：**不做任何校验**，写什么就是什么（供既有测试与内部已校验路径使用）。
 *
 * 新增代码请走 `updateDailyPlan` / `addDailyPlanItem` / `updateDailyPlanItem`：
 * 它们才带共同校验与"保留既有 minutes/effortDone"的语义。
 */
export function saveDailyPlan(db: DatabaseSync, input: DailyPlanInput, at = nowIso()): DailyPlanRow {
  const items: DailyPlanItem[] = input.items
    .map((item, index) => ({
      taskId: item.taskId,
      order: Number.isFinite(item.order) ? item.order : index + 1,
      title: item.title ?? '',
      note: item.note ?? '',
      minutes: checkPlanMinutes(item.minutes).ok ? item.minutes : DEFAULT_PLAN_MINUTES,
      effortDone: item.effortDone === true,
    }))
    .sort((a, b) => a.order - b.order)
  insertDailyPlan(db, {
    planDate: input.planDate,
    summary: input.summary ?? '',
    items,
    sourceCode: input.sourceCode ?? 'ai',
    sessionId: input.sessionId ?? null,
  }, at)
  return getDailyPlan(db, input.planDate)!
}

/** 把「本次提交的项」与「库里的最新计划」合并，并做共同校验。 */
function mergeAndCheck(
  db: DatabaseSync,
  planDate: string,
  incoming: ReadonlyArray<ManualPlanItemInput>,
  previous: DailyPlanRow | undefined,
  defaultMinutes: number,
  tasks: Map<string, PlanTaskView>,
): DailyPlanItem[] {
  const previousItems = previous?.readable === true ? previous.items : []
  // 显式给了 minutes 就校验（非法 → 整份拒绝，且要报出是第几项）。
  incoming.forEach((item, index) => {
    if (item.minutes === undefined) return
    const check = checkPlanMinutes(item.minutes)
    if (!check.ok) throw new Error(`items[${index}] 的 minutes 非法：${check.reason}`)
  })
  const withMinutes = incoming.map((item) => {
    const previousItem = previousItems.find((entry) => entry.taskId === item.taskId)
    const minutes = item.minutes !== undefined
      ? item.minutes
      : previousItem?.minutes ?? resolveTaskMinutes(tasks.get(item.taskId)?.estimatedMinutes, defaultMinutes)
    return { taskId: item.taskId, order: item.order, note: item.note, minutes }
  })
  const merged = mergePlanItems(withMinutes, previousItems, (taskId) => planTaskTitle(tasks, taskId))
  const check = checkPlanTaskSet(merged, new Map([...tasks].map(([id, task]) => [id, toPlanTaskRef(task)])), new Set(previousItems.map((item) => item.taskId)))
  if (!check.ok) throw new Error(check.reason)
  return merged
}

function resolveTaskMinutes(estimated: number | null | undefined, fallback: number): number {
  if (typeof estimated === 'number' && Number.isInteger(estimated) && estimated >= 1 && estimated <= 1440) return estimated
  return fallback
}

/**
 * 用户全量编辑计划（顺序/备注/成员；可带 minutes）。
 *
 * 与旧实现的行为差别（都是 T2 明确要求）：
 * - 省略 `minutes` 的项**保留库里最新值**（旧客户端保存备注时不再抹掉 minutes/effortDone）；
 * - `effortDone` **一律取库里最新值**（本接口不接受它，重排/改备注不丢结束状态）；
 * - 新增项若任务缺失/已关闭/与既有项同父子链 → **整份拒绝**（不部分生效）；
 *   既有项即使任务已关闭/缺失也原样保留。
 */
export function updateDailyPlan(
  db: DatabaseSync,
  planDate: string,
  input: { summary?: string; items: ManualPlanItemInput[]; sourceCode?: string; sessionId?: string | null },
  at = nowIso(),
): DailyPlanRow {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) throw new Error('planDate must be YYYY-MM-DD')
  if (input.items.length === 0) throw new Error('daily_plan requires at least one item')
  const existing = getDailyPlan(db, planDate)
  const tasks = loadPlanTasks(db)
  const items = mergeAndCheck(db, planDate, input.items, existing, defaultEstimateMinutes(db), tasks)
  if (existing === undefined || !existing.readable) {
    insertDailyPlan(db, {
      planDate,
      summary: input.summary ?? existing?.summary ?? '',
      items,
      sourceCode: input.sourceCode ?? 'manual',
      sessionId: input.sessionId ?? null,
    }, at, existing?.id ?? randomUUID())
    return getDailyPlan(db, planDate)!
  }
  db.prepare(`
    UPDATE daily_plans
    SET summary = ?, items_json = ?, source_code = ?, session_id = ?, updated_at = ?
    WHERE plan_date = ?
  `).run(
    input.summary ?? existing.summary,
    JSON.stringify(items),
    input.sourceCode ?? 'manual',
    input.sessionId ?? null,
    at,
    planDate,
  )
  return getDailyPlan(db, planDate)!
}

export function deleteDailyPlan(db: DatabaseSync, planDate: string): boolean {
  return db.prepare('DELETE FROM daily_plans WHERE plan_date = ?').run(planDate).changes > 0
}

export type AddPlanItemResult =
  | { ok: true; plan: DailyPlanRow; added: boolean; addedTaskIds: string[] }
  | { ok: false; error: string }

/**
 * **一键排入的唯一入口**（POST `/plans/:date/items`）：原子追加一条，不覆盖已有成员。
 *
 * 幂等与并发（需求 §4.2.4、AX-C05）：
 * - 已在计划里同 taskId → 返回 `added:false`，**不改**已有 minutes/结束状态；
 * - 事务内重新读取最新计划，按最新末尾 order 追加 → 并发两次追加最终两项都在；
 * - 失败无部分写入（不是靠调用方的客户端旧列表 PUT 模拟，那是被明令禁止的做法）。
 */
export function addDailyPlanItem(
  db: DatabaseSync,
  planDate: string,
  input: { taskId: string; minutes?: number; title?: string },
  at = nowIso(),
): AddPlanItemResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) return { ok: false, error: '计划日期必须是 YYYY-MM-DD' }
  if (typeof input.taskId !== 'string' || input.taskId === '') return { ok: false, error: '缺少 taskId' }
  if (input.minutes !== undefined) {
    const check = checkPlanMinutes(input.minutes)
    if (!check.ok) return { ok: false, error: check.reason }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = getDailyPlan(db, planDate)
    const previousItems = existing?.readable === true ? existing.items : []
    /*
     * 顺序很重要：**先看它是不是已经在计划里**。
     *
     * "未知任务只拒绝新增"意味着"已在计划里的缺失/关闭项不得因为一次追加请求就被处理掉" ——
     * 如果先查任务，一条已经躺在那天计划里、任务已被删除的项会被报成 404，而调用方
     * （一键排入按钮）只想得到一个"它已经在了"的幂等回执。所以幂等判定先于任务存在性判定。
     */
    const already = previousItems.find((item) => item.taskId === input.taskId)
    if (already !== undefined && existing !== undefined) {
      db.exec('ROLLBACK')
      return { ok: true, plan: existing, added: false, addedTaskIds: [] }
    }
    if (existing !== undefined && !existing.readable) {
      db.exec('ROLLBACK')
      return { ok: false, error: `计划 ${planDate} 的数据无法解析，不能追加（原数据未改动，请先备份后修复或清空）` }
    }
    const tasks = loadPlanTasks(db)
    const task = tasks.get(input.taskId)
    if (task === undefined) {
      db.exec('ROLLBACK')
      return { ok: false, error: `计划里的任务不存在：${input.taskId}` }
    }

    /**
     * **展开到可执行叶子**（ADR0010）：在非叶子任务上点「排入今日」= 把它下面所有未完成
     * 叶子补齐；在叶子上 = 就排它自己。
     *
     * `expandPlanLeaves` 对"自己不是 open / 成环"返回空数组 —— 那**不是成功**：
     * 退回按"就排它自己"交给 `checkPlanTaskSet` 给出可读原因，绝不静默什么都不加。
     */
    const expanded = expandPlanLeaves([...tasks.values()], input.taskId)
    const targets = expanded.length > 0 ? expanded : [input.taskId]
    if (input.minutes !== undefined && targets.length > 1) {
      db.exec('ROLLBACK')
      return {
        ok: false,
        error: `这条任务会展开成 ${targets.length} 条子任务，不能给它们指定同一个投入分钟：请分别调整各自的计划投入`,
      }
    }

    const preexistingIds = new Set(previousItems.map((item) => item.taskId))
    const defaultMinutes = defaultEstimateMinutes(db)
    let nextOrder = previousItems.reduce((max, item) => Math.max(max, item.order), 0)
    const additions: DailyPlanItem[] = []
    for (const targetId of targets) {
      // 已在计划里的叶子**原样保留**（minutes/effortDone 都不动）：重复点父任务只补齐缺口。
      if (preexistingIds.has(targetId)) continue
      const leaf = tasks.get(targetId)
      if (leaf === undefined) continue
      nextOrder += 1
      additions.push({
        taskId: targetId,
        order: nextOrder,
        title: leaf.title,
        note: '',
        minutes: input.minutes !== undefined ? input.minutes : resolveTaskMinutes(leaf.estimatedMinutes, defaultMinutes),
        effortDone: false,
      })
    }
    if (additions.length === 0) {
      // 展开出来的叶子**全都在计划里**了（例如父任务第二次被点）→ 幂等回执，不写库。
      db.exec('ROLLBACK')
      return { ok: true, plan: existing!, added: false, addedTaskIds: [] }
    }

    const appended: DailyPlanItem[] = [...previousItems, ...additions]
    const check = checkPlanTaskSet(appended, new Map([...tasks].map(([id, item]) => [id, toPlanTaskRef(item)])), preexistingIds)
    if (!check.ok) {
      db.exec('ROLLBACK')
      return { ok: false, error: check.reason }
    }

    if (existing === undefined) {
      insertDailyPlan(db, { planDate, summary: '', items: appended, sourceCode: 'manual', sessionId: null }, at)
    } else {
      db.prepare('UPDATE daily_plans SET items_json = ?, source_code = ?, updated_at = ? WHERE plan_date = ?')
        .run(JSON.stringify(appended), 'manual', at, planDate)
    }
    db.exec('COMMIT')
    return { ok: true, plan: getDailyPlan(db, planDate)!, added: true, addedTaskIds: additions.map((item) => item.taskId) }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已经回滚过就不能再回滚 */ }
    throw error
  }
}

export type UpdatePlanItemResult =
  | { ok: true; plan: DailyPlanRow; changed: boolean }
  | { ok: false; error: string; notFound?: boolean }

/**
 * 项级更新（PATCH `/plans/:date/items/:taskId`）：只动目标项，不写回调用方缓存的整份计划。
 *
 * - `minutes` 与 `effortDone` 至少给一个；
 * - **结束投入只影响那一天**：改 minutes 不改 effortDone，反之亦然；
 * - 相同值重复提交幂等（不刷 `updatedAt`）；
 * - 目标任务缺失/归档/关闭 → 拒绝并给中文原因（既有项只允许"保留或显式移除"）；
 * - 改 minutes 时 `sourceCode` 变 `manual`（用户显式编辑）；只改 effortDone 时
 *   **保留原 sourceCode**（结束投入不把 AI 计划变成手动计划）。
 */
export function updateDailyPlanItem(
  db: DatabaseSync,
  planDate: string,
  taskId: string,
  patch: { minutes?: number; effortDone?: boolean },
  at = nowIso(),
): UpdatePlanItemResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) return { ok: false, error: '计划日期必须是 YYYY-MM-DD' }
  if (patch.minutes === undefined && patch.effortDone === undefined) return { ok: false, error: '至少要给 minutes 或 effortDone 之一' }
  if (patch.minutes !== undefined) {
    const check = checkPlanMinutes(patch.minutes)
    if (!check.ok) return { ok: false, error: check.reason }
  }
  if (patch.effortDone !== undefined && typeof patch.effortDone !== 'boolean') {
    return { ok: false, error: 'effortDone 必须是布尔值（true=今日投入结束，false=继续投入）' }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = getDailyPlan(db, planDate)
    if (existing === undefined) {
      db.exec('ROLLBACK')
      return { ok: false, error: `计划 ${planDate} 不存在`, notFound: true }
    }
    if (!existing.readable) {
      db.exec('ROLLBACK')
      return { ok: false, error: `计划 ${planDate} 的数据无法解析，不能修改（原数据未改动）` }
    }
    const index = existing.items.findIndex((item) => item.taskId === taskId)
    if (index < 0) {
      db.exec('ROLLBACK')
      return { ok: false, error: `计划 ${planDate} 里没有任务 ${taskId}`, notFound: true }
    }

    const task = getTask(db, taskId)
    const current = existing.items[index]
    // 目标任务缺失/归档/关闭：这一项只能作为历史记录保留，不再允许结束/调分钟。
    if (task === undefined || task.archived === 1 || task.statusCode === 'done' || task.statusCode === 'cancelled') {
      db.exec('ROLLBACK')
      const why = task === undefined ? '任务已不存在' : task.archived === 1 ? '任务已归档' : task.statusCode === 'done' ? '任务已完成' : '任务已取消'
      return { ok: false, error: `${why}：计划项只能保留为历史记录，不能再结束今日投入或调分钟（如需移除请用全量编辑）` }
    }

    const nextMinutes = patch.minutes ?? current.minutes
    const nextEffortDone = patch.effortDone ?? current.effortDone
    if (nextMinutes === current.minutes && nextEffortDone === current.effortDone) {
      db.exec('ROLLBACK')
      // 幂等：不写事件、不刷 updatedAt，但回执给出当前值。
      return { ok: true, plan: existing, changed: false }
    }

    const items = existing.items.map((item, i) => (i === index
      ? { ...item, minutes: nextMinutes, effortDone: nextEffortDone, title: task.title }
      : item))
    // 只改 effortDone 时保留原 sourceCode（结束投入不是"手动改写计划"）。
    const sourceCode = patch.minutes !== undefined ? 'manual' : existing.sourceCode
    db.prepare('UPDATE daily_plans SET items_json = ?, source_code = ?, updated_at = ? WHERE plan_date = ?')
      .run(JSON.stringify(items), sourceCode, at, planDate)
    db.exec('COMMIT')
    return { ok: true, plan: getDailyPlan(db, planDate)!, changed: true }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw error
  }
}

/**
 * 确认每日计划草稿（AI 提案 → 落库）。
 *
 * 与旧实现的差别：`minutes` 与 `effortDone` 全路径保留 —— 保留项的 `effortDone`
 * **在确认事务中读最新值**（不用过时草稿覆盖），`minutes` 优先用草稿里的快照
 * （提案创建时算好的），库里已有同 taskId 而草稿省略时才用库里值。
 * 确认时再次做共同校验（存在性/关闭/父子链），失败整份拒绝并保留草稿。
 */
export function confirmDailyPlanDraft(db: DatabaseSync, draftId: string, at = nowIso()): DailyPlanRow | undefined {
  const draft = getDraft(db, draftId)
  if (draft === undefined || draft.kindCode !== 'daily_plan') return undefined
  const payload = draft.payload as { planDate?: string; summary?: string; items?: Array<Record<string, unknown>> }
  const planDate = typeof payload.planDate === 'string' ? payload.planDate : undefined
  if (planDate === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(planDate)) throw new Error('daily_plan requires a valid planDate (YYYY-MM-DD)')
  const rawItems = Array.isArray(payload.items) ? payload.items : []
  if (rawItems.length === 0) throw new Error('daily_plan requires at least one item')
  const incoming: ManualPlanItemInput[] = rawItems.map((raw, index) => {
    const minutes = raw.minutes
    if (minutes !== undefined) {
      const check = checkPlanMinutes(minutes)
      if (!check.ok) throw new Error(`items[${index}] 的 minutes 非法：${check.reason}`)
    }
    return {
      taskId: typeof raw.taskId === 'string' ? raw.taskId : '',
      order: typeof raw.order === 'number' ? raw.order : index + 1,
      note: typeof raw.note === 'string' ? raw.note : '',
      minutes: typeof minutes === 'number' ? minutes : undefined,
    }
  })
  return withDraftConfirm(db, draftId, 'daily_plan', () => {
    const existing = getDailyPlan(db, planDate)
    const tasks = loadPlanTasks(db)
    const items = mergeAndCheck(db, planDate, incoming, existing, defaultEstimateMinutes(db), tasks)
    return saveDailyPlan(db, { planDate, summary: payload.summary ?? '', items, sourceCode: 'ai', sessionId: draft.sessionId }, at)
  }, { at })
}

export function getPendingDailyPlanDraft(db: DatabaseSync, sessionId: string | null, planDate?: string): DraftRow | undefined {
  if (sessionId === null || sessionId === undefined) return undefined
  const rows = db.prepare("SELECT * FROM task_drafts WHERE status_code = 'pending' AND kind_code = 'daily_plan' ORDER BY created_at DESC").all() as unknown as Array<{
    id: string
    kind_code: string
    session_id: string | null
    payload_json: string
    status_code: string
    created_at: string
    updated_at: string
  }>
  for (const row of rows) {
    if (row.session_id !== sessionId) continue
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    if (planDate !== undefined && payload.planDate !== planDate) continue
    return parseDraft(row as unknown as RawDraftRow)
  }
  return undefined
}
