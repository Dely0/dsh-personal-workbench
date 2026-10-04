/**
 * ADR0010 端到端实测（跑在 3080 隔离测试实例上；**只碰它自己的测试库**）。
 *
 * 覆盖用户 2026-10-05 报的两个现象 + 本次新增的分组行/补齐语义：
 * 1. 在**父任务**上点「排入今日」（= `POST /plans/:date/items`）→ 它下面所有未完成叶子都进计划，
 *    回执 `addedTaskIds` 如实给出，父任务自己**不**进计划（它不是可执行叶子）；
 * 2. 再给父任务补一个子任务、再点一次 → **只补齐缺口**（不重复排已排的），第三次点 → 幂等；
 * 3. `PUT /plans/:date`（全量保存）带非叶子新增项 → 400 且原因可读（不展开）。
 *
 * 纪律：
 * - 合成任务标题带 `runId`；清理只认本次登记的 id（先恢复计划快照，再归档合成任务）；
 * - **token 只从日志读进内存**，不打印、不落盘；
 * - stdout 最后一行是 `{"passed":n,"failed":n,"total":n}`，同时写一份 JSON 证据。
 *
 * 用法：node scripts/repro/verify-adr0010-leaves.mjs [--url http://127.0.0.1:3080]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argUrl = process.argv.indexOf('--url')
const BASE = (argUrl >= 0 ? process.argv[argUrl + 1] : 'http://127.0.0.1:3080').replace(/\/$/, '')
const PORT = new URL(BASE).port || '80'
const LOG = join(tmpdir(), `dsh-server-${PORT}.log`)
const runId = `adr0010-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: ok === true, detail })
  console.log(`${ok === true ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function tokenFromLog() {
  const text = readFileSync(LOG, 'utf8')
  const matches = [...text.matchAll(/[?&]token=([A-Za-z0-9._-]+)/g)]
  if (matches.length === 0) throw new Error(`日志里没有 token：${LOG}`)
  return matches[matches.length - 1][1]
}

const token = tokenFromLog()
let authRejected = false

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (response.status === 401 || response.status === 403) authRejected = true
  let json
  try { json = await response.json() } catch { json = undefined }
  return { status: response.status, body: json }
}

const localDate = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

const createdTaskIds = []
let planSnapshot = null
let createdPlan = false
const today = localDate()

try {
  // ---- 环境自证：health 的 buildId 要能读到（证明这是本次装盘后的实例） ----
  const health = await api('GET', '/api/workbench/health')
  check('health 200 且带 buildId', health.status === 200 && typeof health.body?.buildId === 'string',
    `status=${health.status} buildId=${health.body?.buildId ?? '(缺失)'}`)

  // ---- 计划快照（清理时原样恢复） ----
  const before = await api('GET', `/api/workbench/plans?date=${today}`)
  planSnapshot = before.body?.plan ?? null
  check('读得到当日计划快照', before.status === 200, `原始项数=${planSnapshot?.items?.length ?? '(无计划)'}`)

  const newTask = async (title, parentId) => {
    const res = await api('POST', '/api/workbench/tasks', { title: `[${runId}] ${title}`, typeCode: 'code_impl', priorityCode: 'p2', ...(parentId === undefined ? {} : { parentId }) })
    const id = res.body?.task?.id
    if (typeof id !== 'string') throw new Error(`建任务失败：${JSON.stringify(res.body)}`)
    createdTaskIds.push(id)
    return id
  }

  const parent = await newTask('项目')
  const leafA = await newTask('叶子A', parent)
  const leafB = await newTask('叶子B', parent)

  // ---- 现象 1：在父任务上「排入今日」→ 展开到叶子 ----
  const expanded = await api('POST', `/api/workbench/plans/${today}/items`, { taskId: parent })
  check('父任务排入 → 200 + added', expanded.status === 200 && expanded.body?.added === true,
    `status=${expanded.status} added=${expanded.body?.added}`)
  check('回执 addedTaskIds = 两条叶子（按树序）',
    JSON.stringify(expanded.body?.addedTaskIds ?? []) === JSON.stringify([leafA, leafB]),
    JSON.stringify(expanded.body?.addedTaskIds ?? []))

  const afterExpand = await api('GET', `/api/workbench/plans?date=${today}`)
  const itemIds = (afterExpand.body?.plan?.items ?? []).map((item) => item.taskId)
  check('计划里两条叶子都在', itemIds.includes(leafA) && itemIds.includes(leafB))
  check('父任务自己不是计划项', itemIds.includes(parent) === false)
  const leafRow = (afterExpand.body?.plan?.items ?? []).find((item) => item.taskId === leafA)
  check('叶子各自带投入分钟', typeof leafRow?.minutes === 'number' && leafRow.minutes > 0, `minutes=${leafRow?.minutes}`)

  // ---- 现象 2：事后补一个子任务，再点一次 → 只补缺口；第三次 → 幂等 ----
  const leafC = await newTask('叶子C（后加）', parent)
  const refill = await api('POST', `/api/workbench/plans/${today}/items`, { taskId: parent })
  check('补子任务后再点父任务 → 只补缺口', refill.status === 200 && refill.body?.added === true
    && JSON.stringify(refill.body?.addedTaskIds ?? []) === JSON.stringify([leafC]),
    `added=${refill.body?.added} ids=${JSON.stringify(refill.body?.addedTaskIds ?? [])}`)

  const again = await api('POST', `/api/workbench/plans/${today}/items`, { taskId: parent })
  check('第三次点 → 幂等（added=false 且不新增）',
    again.status === 200 && again.body?.added === false && (again.body?.addedTaskIds ?? []).length === 0,
    `added=${again.body?.added} ids=${JSON.stringify(again.body?.addedTaskIds ?? [])}`)

  const afterRefill = await api('GET', `/api/workbench/plans?date=${today}`)
  const refillIds = (afterRefill.body?.plan?.items ?? []).map((item) => item.taskId)
  check('三条叶子都在计划里', [leafA, leafB, leafC].every((id) => refillIds.includes(id)))

  // ---- 现象 3：PUT 全量保存带非叶子新增项 → 400 可读原因（不展开） ----
  const putReject = await api('PUT', `/api/workbench/plans/${today}`, {
    items: [{ taskId: parent, order: 1 }, { taskId: leafA, order: 2 }],
  })
  check('PUT 带非叶子新增项 → 400 且原因可读',
    putReject.status === 400 && /不是可执行的叶子/.test(String(putReject.body?.error ?? '')),
    `status=${putReject.status} error=${String(putReject.body?.error ?? '').slice(0, 60)}`)

  const afterPut = await api('GET', `/api/workbench/plans?date=${today}`)
  check('被拒的 PUT 没有部分生效',
    JSON.stringify((afterPut.body?.plan?.items ?? []).map((i) => i.taskId)) === JSON.stringify(refillIds),
    `items=${JSON.stringify((afterPut.body?.plan?.items ?? []).map((i) => i.taskId))}`)

  check('全程没有 401/403（token 有效）', authRejected === false)
} catch (error) {
  check('探针执行完成（无异常中断）', false, error instanceof Error ? error.message : String(error))
} finally {
  // ---- 清理：只动本次造的东西 ----
  try {
    if (planSnapshot === null) {
      await api('DELETE', `/api/workbench/plans/${today}`)
      createdPlan = true
    } else {
      await api('PUT', `/api/workbench/plans/${today}`, {
        items: planSnapshot.items.map((item, index) => ({ taskId: item.taskId, order: typeof item.order === 'number' ? item.order : index + 1 })),
      })
    }
    for (const id of createdTaskIds) await api('PATCH', `/api/workbench/tasks/${id}`, { archived: true })
    const after = await api('GET', `/api/workbench/plans?date=${today}`)
    const cleaned = JSON.stringify((after.body?.plan?.items ?? []).map((i) => i.taskId))
    const expected = planSnapshot === null ? '[]' : JSON.stringify(planSnapshot.items.map((i) => i.taskId))
    check('清理后计划回到原始快照', cleaned === expected, `now=${cleaned} expected=${expected}`)
    console.log(`（本次合成任务 ${createdTaskIds.length} 条已归档；runId=${runId}）`)
  } catch (error) {
    check('清理阶段执行完成', false, error instanceof Error ? error.message : String(error))
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  const summary = { passed, failed, total: results.length }
  const evidenceDir = join(root, 'test-results', 'adr0010-leaves')
  try {
    if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, `${runId}.json`), JSON.stringify({ runId, url: BASE, today, results, summary, token: '[redacted]' }, null, 2))
  } catch { /* 证据写不出不影响判据 */ }
  console.log(JSON.stringify(summary))
  if (failed > 0) process.exitCode = 1
}
