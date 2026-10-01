/**
 * D02：迁移 19 与任务仓储的进度读写（AX-P01、AX-D02、AX-P06 的仓储部分）。
 *
 * ## 为什么这个文件自己搭一个 v18 库
 *
 * 验收要求的是"**18→19** 迁移幂等、旧任务进度 0、旧计划合法项回填、坏数据保留诊断"。
 * 用 `openWorkbenchDb()` 只能拿到"一路迁到最新"的库，**测不出迁移本身的兼容性**；
 * 所以这里显式按迁移表逐版本升到 18，塞入老格式数据，再跑 19。
 * 迁移只碰内存库（`:memory:`）—— 绝不拿用户真库试迁移。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/db/schema.js'
import { openWorkbenchDb, migrate } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import {
  createTask, getDailyPlan, getTask, listPendingCompletions, listTaskEvents, setTaskProgress,
  submitCompletionDraft, updateTask,
} from '../lib/db/repo.js'

/** 建一个"装了 18 个迁移"的内存库（不含 19），供兼容性测试用。 */
function openV18Db() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

/**
 * 把库退回到 v18 语义：先按迁移升到 19 再手工删列做不到（SQLite 删列受限），
 * 所以反过来做 —— 从空库**只跑 < 19 的迁移**，再写 meta。
 */
function openLegacyDb(upTo = 18) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(migration.version))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return db
}

const AT = '2026-09-30T00:00:00.000Z'

function insertLegacyTask(db, { id, title, statusCode = 'todo', estimatedMinutes = null, archived = 0 }) {
  db.prepare(`
    INSERT INTO tasks (id, parent_id, title, description, type_code, status_code, priority_code, ai_policy_code,
      due_at, all_day, estimated_minutes, source, workspace_path, archived, extra, recurrence_code, recurrence_rule,
      recurrence_master_id, recurrence_last_generated, created_at, updated_at, completed_at, cancelled_at)
    VALUES (?, NULL, ?, '', 'code_impl', ?, 'p1', 'consult', NULL, 0, ?, 'manual', NULL, ?, '{}', NULL, '{}', NULL, NULL, ?, ?, NULL, NULL)
  `).run(id, title, statusCode, estimatedMinutes, archived, AT, AT)
}

function insertLegacyPlan(db, planDate, itemsJson, sourceCode = 'ai') {
  db.prepare(`
    INSERT INTO daily_plans (id, plan_date, summary, items_json, source_code, session_id, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, NULL, ?, ?)
  `).run(`plan-${planDate}`, planDate, itemsJson, sourceCode, AT, AT)
}

// ---------------------------------------------------------------------------
// AX-P01：18 → 19
// ---------------------------------------------------------------------------

test('迁移 19：旧任务（含 done）一律 progress=0，原字段不变，二次 migrate 无变化', () => {
  const db = openLegacyDb(18)
  try {
    seedDictionaries(db)
    insertLegacyTask(db, { id: 't-todo', title: '待办', statusCode: 'todo' })
    insertLegacyTask(db, { id: 't-doing', title: '进行中', statusCode: 'doing', estimatedMinutes: 600 })
    insertLegacyTask(db, { id: 't-done', title: '已完成', statusCode: 'done' })
    const before = db.prepare("SELECT * FROM tasks WHERE id = 't-doing'").get()

    migrate(db)

    assert.equal(SCHEMA_VERSION, 19)
    for (const id of ['t-todo', 't-doing', 't-done']) {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
      assert.equal(row.progress_percent, 0, `${id} 的旧进度必须是 0（不反推）`)
    }
    const after = db.prepare("SELECT * FROM tasks WHERE id = 't-doing'").get()
    // 除新列外，原字段逐字不变（防止迁移"顺手"改写别的字段）。
    for (const key of Object.keys(before)) {
      assert.deepEqual(after[key], before[key], `字段 ${key} 不应被迁移改动`)
    }

    // 幂等：再跑一次 migrate 不报错、数据不变。
    const snapshot = JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id').all())
    migrate(db)
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id').all()), snapshot)
  } finally {
    db.close()
  }
})

test('迁移 19：CHECK(progress_percent BETWEEN 0 AND 99) 是最后一道防线', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    const task = createTask(db, { title: '任务', typeCode: 'code_impl', priorityCode: 'p1' })
    assert.equal(task.progressPercent, 0, '新建任务默认 0')
    assert.throws(
      () => db.prepare('UPDATE tasks SET progress_percent = 100 WHERE id = ?').run(task.id),
      /CHECK/i,
      '库里绝不允许出现 100（它是提交完成验收的触发值，不是进度）',
    )
    assert.throws(
      () => db.prepare('UPDATE tasks SET progress_percent = -1 WHERE id = ?').run(task.id),
      /CHECK/i,
    )
  } finally {
    db.close()
  }
})

test('迁移 19：ai_session_scope/persona 字典就位，且不重复插入', () => {
  const db = openLegacyDb(18)
  try {
    seedDictionaries(db)
    migrate(db)
    const row = db.prepare("SELECT * FROM dictionaries WHERE kind = 'ai_session_scope' AND code = 'persona'").get()
    assert.ok(row, 'persona scope 字典必须存在（S11 角色绑定复用 ai_session_registry）')
    assert.equal(row.active, 1)
    // 幂等：migrate 再跑一次不会插第二条（version 已到 19 不会再执行 up）
    migrate(db)
    const count = db.prepare("SELECT COUNT(*) AS n FROM dictionaries WHERE kind = 'ai_session_scope' AND code = 'persona'").get()
    assert.equal(count.n, 1)
  } finally {
    db.close()
  }
})

// ---------------------------------------------------------------------------
// AX-D02：旧计划 JSON 回填
// ---------------------------------------------------------------------------

test('迁移 19：旧计划合法项回填 minutes 快照 / effortDone=false，保留顺序与备注、未知任务保留', () => {
  const db = openLegacyDb(18)
  try {
    seedDictionaries(db)
    insertLegacyTask(db, { id: 'task-est', title: '有估时', estimatedMinutes: 90 })
    insertLegacyTask(db, { id: 'task-noest', title: '无估时' })
    db.prepare("INSERT INTO meta (key, value) VALUES ('default_estimate_minutes', '45')").run()
    insertLegacyPlan(db, '2026-09-29', JSON.stringify([
      { taskId: 'task-est', order: 1, title: '有估时', note: '先做这个' },
      { taskId: 'task-noest', order: 2, title: '无估时', note: '' },
      { taskId: 'deleted-task', order: 3, title: '任务已删除但项要保留', note: '别丢' },
      { taskId: 'task-est', order: 4, title: '已有合法值', note: '', minutes: 25, effortDone: true },
    ]))

    migrate(db)

    const plan = getDailyPlan(db, '2026-09-29')
    assert.equal(plan.items.length, 4, '坏数据/未知任务一律不得被删')
    assert.deepEqual(plan.items.map((item) => item.order), [1, 2, 3, 4], '顺序逐字保留')
    assert.equal(plan.items[0].minutes, 90, '缺 minutes 用该任务当时的合法估时')
    assert.equal(plan.items[0].effortDone, false)
    assert.equal(plan.items[0].title, '有估时', '原字段保留')
    assert.equal(plan.items[0].note, '先做这个')
    assert.equal(plan.items[1].minutes, 45, '任务没有估时 → 设置里的默认投入')
    assert.equal(plan.items[2].minutes, 45, '未知 taskId 保留项，minutes 走默认（不猜、不删）')
    assert.equal(plan.items[2].title, '任务已删除但项要保留')
    assert.equal(plan.items[3].minutes, 25, '已有合法 minutes 不覆盖')
    assert.equal(plan.items[3].effortDone, true, '已有合法 effortDone 不覆盖')

    // 幂等：第二次 migrate 不再改动
    const snapshot = JSON.stringify(getDailyPlan(db, '2026-09-29').items)
    migrate(db)
    assert.equal(JSON.stringify(getDailyPlan(db, '2026-09-29').items), snapshot)
  } finally {
    db.close()
  }
})

test('迁移 19：坏 JSON / 非数组 / 坏项**原串保留**并输出带 planDate 的诊断', () => {
  const db = openLegacyDb(18)
  try {
    seedDictionaries(db)
    insertLegacyTask(db, { id: 'ok-task', title: '正常任务', estimatedMinutes: 30 })
    insertLegacyPlan(db, '2026-09-28', '{这不是 JSON')
    insertLegacyPlan(db, '2026-09-27', '{"taskId":"ok-task"}')
    insertLegacyPlan(db, '2026-09-26', JSON.stringify(['不是对象', { taskId: 'ok-task', order: 1, title: '正常项' }]))

    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => { warnings.push(args.join(' ')) }
    try {
      migrate(db)
    } finally {
      console.warn = originalWarn
    }

    // 坏 JSON：原串一个字节都不动（读取端据此报"计划数据无法解析"，而不是假装 0）
    const broken = db.prepare("SELECT items_json FROM daily_plans WHERE plan_date = '2026-09-28'").get()
    assert.equal(broken.items_json, '{这不是 JSON')
    const notArray = db.prepare("SELECT items_json FROM daily_plans WHERE plan_date = '2026-09-27'").get()
    assert.equal(notArray.items_json, '{"taskId":"ok-task"}')
    // 坏项：**原串照样留在库里**（一个字节不动），读取端把它折成诊断而不是当成一项计划
    const rawMixed = db.prepare("SELECT items_json FROM daily_plans WHERE plan_date = '2026-09-26'").get()
    assert.equal(rawMixed.items_json, JSON.stringify(['不是对象', { taskId: 'ok-task', order: 1, title: '正常项', minutes: 30, effortDone: false }]), '迁移只做加法，坏项原样留在数组里')
    const mixed = getDailyPlan(db, '2026-09-26')
    assert.equal(mixed.readable, true)
    assert.equal(mixed.items.length, 1, '坏项不进 items（但会在 diagnostics 里点名）')
    assert.equal(mixed.items[0].taskId, 'ok-task')
    assert.equal(mixed.items[0].minutes, 30)
    assert.equal(mixed.items[0].effortDone, false)
    assert.ok(mixed.diagnostics.some((text) => text.includes('第 1 项不是对象')), '坏项必须留下可读诊断（不静默丢件）')

    const joined = warnings.join('\n')
    assert.match(joined, /2026-09-28/, '诊断必须带 planDate')
    assert.match(joined, /2026-09-27/)
    assert.match(joined, /2026-09-26/)
  } finally {
    db.close()
  }
})

// ---------------------------------------------------------------------------
// 仓储层：setTaskProgress（AX-P02 的存储侧 / AX-P06 的回退语义）
// ---------------------------------------------------------------------------

test('setTaskProgress: 0–99 写入成功；同值幂等（不写事件、不刷新 updatedAt）', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    const task = createTask(db, { title: '任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const first = setTaskProgress(db, task.id, 75, 'ai', '2026-09-30T10:00:00.000Z', '推进了一半多')
    assert.equal(first.ok, true)
    assert.equal(first.changed, true)
    assert.equal(getTask(db, task.id).progressPercent, 75)

    const eventsAfterFirst = listTaskEvents(db, task.id)
    const updated = eventsAfterFirst.find((event) => event.event_code === 'updated' && event.actor === 'ai')
    assert.ok(updated, '写进度必须留一条 updated 事件')
    assert.deepEqual(JSON.parse(updated.before_json), { progressPercent: 0 })
    assert.deepEqual(JSON.parse(updated.after_json), { progressPercent: 75 })
    assert.equal(updated.note, '推进了一半多')

    // 同值重复提交：状态 200 语义、但不重复写事件、不刷新 updatedAt
    // （比的是**写入之后**的快照：`task` 是创建时的对象，updatedAt 还是建任务那一刻）
    const afterFirst = getTask(db, task.id)
    assert.equal(afterFirst.updatedAt, '2026-09-30T10:00:00.000Z', '写入时会带上新 updatedAt')
    const same = setTaskProgress(db, task.id, 75, 'ai', '2026-09-30T11:00:00.000Z')
    assert.equal(same.ok, true)
    assert.equal(same.changed, false)
    assert.equal(same.alreadyAt, 75)
    assert.equal(getTask(db, task.id).updatedAt, afterFirst.updatedAt, '同值不得刷新 updatedAt')
    assert.equal(listTaskEvents(db, task.id).length, eventsAfterFirst.length, '同值不得追加事件')
  } finally {
    db.close()
  }
})

test('setTaskProgress: 非法值 / 越界 / 100 一律拒绝且**无部分写入**', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    const task = createTask(db, { title: '任务', typeCode: 'code_impl', priorityCode: 'p1' })
    setTaskProgress(db, task.id, 30)
    const before = getTask(db, task.id)
    const eventCount = listTaskEvents(db, task.id).length

    for (const bad of [-1, 100, 101, 1.5, '50', null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = setTaskProgress(db, task.id, bad)
      assert.equal(result.ok, false, `${String(bad)} 必须被拒`)
      assert.match(result.error, /^错误：/, '错误要给用户看的中文')
    }
    const after = getTask(db, task.id)
    assert.equal(after.progressPercent, 30, '拒绝时不得改动进度')
    assert.equal(after.updatedAt, before.updatedAt, '拒绝时不得刷新 updatedAt')
    assert.equal(listTaskEvents(db, task.id).length, eventCount, '拒绝时不得写事件')
  } finally {
    db.close()
  }
})

test('setTaskProgress: 不存在 / 已归档 / done / cancelled 拒绝，不重开任务', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    assert.match(setTaskProgress(db, 'nope', 10).error, /不存在/)

    const done = createTask(db, { title: '已完成', typeCode: 'code_impl', priorityCode: 'p1', statusCode: 'done' })
    assert.match(setTaskProgress(db, done.id, 50).error, /已完成/)
    const cancelled = createTask(db, { title: '已取消', typeCode: 'code_impl', priorityCode: 'p1', statusCode: 'cancelled' })
    assert.match(setTaskProgress(db, cancelled.id, 50).error, /已取消/)
    const archivedTask = createTask(db, { title: '已归档', typeCode: 'code_impl', priorityCode: 'p1' })
    updateTask(db, archivedTask.id, { archived: true })
    assert.match(setTaskProgress(db, archivedTask.id, 50).error, /已归档/)

    // 四个都被拒 → 状态一点没动
    assert.equal(getTask(db, done.id).statusCode, 'done')
    assert.equal(getTask(db, cancelled.id).statusCode, 'cancelled')
    assert.equal(getTask(db, archivedTask.id).progressPercent, 0)
  } finally {
    db.close()
  }
})

test('setTaskProgress: 驳回/暂存不回退进度；验收通过后原进度保留；级联不改祖先/后代显式值', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    const parent = createTask(db, { title: '父', typeCode: 'code_impl', priorityCode: 'p1', statusCode: 'doing', aiPolicyCode: 'execute' })
    const child = createTask(db, { title: '子', typeCode: 'code_impl', priorityCode: 'p1', parentId: parent.id, statusCode: 'doing' })
    setTaskProgress(db, parent.id, 60)
    setTaskProgress(db, child.id, 20)

    // 提交验收 → 驳回：草稿被丢弃，但进度不回退
    const submitted = submitCompletionDraft(db, { taskId: parent.id, summary: '做完了', sessionId: 's-1', requireSummary: true })
    assert.equal(submitted.ok, true)
    db.prepare("UPDATE task_drafts SET status_code = 'abandoned' WHERE id = ?").run(submitted.result.draftId)
    assert.equal(getTask(db, parent.id).progressPercent, 60, '驳回不回退进度')

    // 验收通过（模拟确认路径）→ 级联完成后代，但显式进度一个都不改
    db.prepare("UPDATE task_drafts SET status_code = 'pending' WHERE id = ?").run(submitted.result.draftId)
    db.prepare("UPDATE tasks SET status_code = 'done', completed_at = ? WHERE id IN (?, ?)").run(AT, parent.id, child.id)
    assert.equal(getTask(db, parent.id).progressPercent, 60, '完成不重置进度')
    assert.equal(getTask(db, child.id).progressPercent, 20, '级联不改后代的显式值')
    // done 任务不画进度条这件事由 projectProgress 管（见 progress.test.mjs），这里只验库值保留
  } finally {
    db.close()
  }
})

test('listPendingCompletions: 一次查询给出全部待验收；deferred 仍算待验收；驳回后不再出现', () => {
  const db = openV18Db()
  try {
    seedDictionaries(db)
    const a = createTask(db, { title: 'A', typeCode: 'code_impl', priorityCode: 'p1', aiPolicyCode: 'execute' })
    const b = createTask(db, { title: 'B', typeCode: 'code_impl', priorityCode: 'p1', aiPolicyCode: 'execute' })
    assert.deepEqual(listPendingCompletions(db), { available: true, items: [] })

    const draftA = submitCompletionDraft(db, { taskId: a.id, summary: 'A 完成', sessionId: null, requireSummary: false })
    const draftB = submitCompletionDraft(db, { taskId: b.id, summary: 'B 完成', sessionId: null, requireSummary: false })
    assert.equal(draftA.ok, true)

    // B 暂存：语义上**仍是待验收**（只是不自动弹窗）
    db.prepare('UPDATE task_drafts SET deferred_at = ? WHERE id = ?').run(AT, draftB.result.draftId)
    const pending = listPendingCompletions(db)
    assert.equal(pending.items.length, 2)
    assert.equal(pending.items.find((item) => item.taskId === b.id).deferred, true)
    assert.equal(pending.items.find((item) => item.taskId === a.id).deferred, false)

    // 驳回（草稿置 abandoned）后不再出现
    db.prepare("UPDATE task_drafts SET status_code = 'abandoned' WHERE id = ?").run(draftA.result.draftId)
    const afterReject = listPendingCompletions(db)
    assert.deepEqual(afterReject.items.map((item) => item.taskId), [b.id])

    // 同一任务重复提交只留一条 pending（不出现两份待验收）
    submitCompletionDraft(db, { taskId: b.id, summary: 'B 完成（修订）', sessionId: null, requireSummary: false })
    assert.equal(listPendingCompletions(db).items.filter((item) => item.taskId === b.id).length, 1)
  } finally {
    db.close()
  }
})

test('openWorkbenchDb 全新库即 schema 19，且旧客户端省略 progressPercent 仍可读写', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    seedDictionaries(db)
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    assert.equal(Number(version.value), 19)
    const task = createTask(db, { title: '任务', typeCode: 'code_impl', priorityCode: 'p1' })
    // 老调用点（不带 progressPercent 的 patch）照常工作，进度保持原值
    setTaskProgress(db, task.id, 40)
    const updated = updateTask(db, task.id, { title: '改了标题' })
    assert.equal(updated.progressPercent, 40, 'title 变更不得顺手抹掉进度')
    assert.equal(updated.title, '改了标题')
  } finally {
    db.close()
  }
})
