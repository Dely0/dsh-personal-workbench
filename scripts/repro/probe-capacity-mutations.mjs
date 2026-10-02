/**
 * 变异探针：把本次新增/固化的每条策略逐个"装回缺陷版"，确认测试**必须变红**。
 *
 * 为什么需要它：一条策略如果没有任何测试守得住，撤掉它测试还是全绿 —— 那"有测试"就是假象。
 * 本探针刻意包含三类**接线类**变异（I2–I5）：它们不改纯函数、纯函数测试照样全绿，
 * 但功能确实坏了（memo 每帧失效 / payload 丢字段 / 编辑框初值恒空 / 乐观更新被删）。
 * 只有源码级断言才守得住它们，所以这几条是"接线有没有被测试锁住"的证据。
 *
 * 做法：备份源码 → 改一处 → 重新构建 → 只跑相关测试文件 → 记录红/绿 → 还原。
 * 全程 try/finally 还原，失败也会把工作区恢复原状（不留半改状态）。
 *
 * 用法：node scripts/repro/probe-capacity-mutations.mjs
 * 退出码 0 = 所有变异都变红（防线有效）；非 0 = 有变异仍然全绿（防线有洞）。
 *
 * ## 2026-10-02 重锚（本次改动的由来）
 *
 * 原探针的 M1–M9 锚的是 `src/client/capacity.ts` 里的**旧客户端容量实现**（按到期任务求和、
 * `fallbackCount` / `dueTodayCount` / `overdueExcluded` / 全天 480 等口径）。容量计算在
 * **ADR0002（T2/D09）**就迁进了共享模块 `src/shared/dailyPlanPolicy.ts#computeCapacityLedger`,
 * 于是那 14 条锚点整段消失 → 探针把它报成"找不到替换片段"，而发布门禁
 *（`scripts/lib/releasePreflight.mjs#judgeProbes`）把"探针失效"判为**阻塞项**（不算欠账）。
 *
 * 重锚原则：**按当前策略重新表述变异**，而不是把旧字符串贴到新位置 ——
 * - 仍成立的口径（去重 / 缺 minutes 的默认展示 / free 的 max(0,·) / 分母 / 超支 / 可解析 /
 *   未排入是补集 / 优先级档位 / 已结束投入）逐条改锚到共享模块；
 * - 已随 ADR0002 消失的口径（客户端按到期求和那套）**直接作废**，不再保留同名变异；
 * - 接线类缺口（I2–I5 / P2 / P3）改为**补判据**（`capacityWiring.test.mjs` 的 4 条源码扫描 +
 *   `capacityPanel.test.mjs` 的勾选态判据），让它们从此真的能变红。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = process.cwd()
/** 容量计算的唯一实现（ADR0002 起搬到这里；`src/client/capacity.ts` 只剩薄接线）。 */
const SHARED = 'src/shared/dailyPlanPolicy.ts'
const INDEX = 'src/client/index.tsx'
const PANEL = 'src/client/components/CapacityRulePanel.tsx'

const CAPACITY_TESTS = ['test/capacity.test.mjs']
const WIRING_TESTS = ['test/capacityWiring.test.mjs']
const PANEL_TESTS = ['test/capacityPanel.test.mjs']

/** 每个变异：改哪个文件、怎么改、应该让哪些测试文件变红。 */
const MUTATIONS = [
  // ── 共享模块：容量账本的口径（S = shared）────────────────────────────────
  {
    name: 'S1 已排重复累加（`planned += minutes` 变成 ×2）',
    file: SHARED,
    from: '      forCandidates.push({ taskId: item.taskId, order: item.order, minutes })\n      planned += minutes',
    to: '      forCandidates.push({ taskId: item.taskId, order: item.order, minutes })\n      planned += minutes * 2',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'S2 计划里同一 taskId 重复出现时不再去重（静默多算）',
    file: SHARED,
    from: '      if (seen.has(item.taskId)) {',
    to: '      if (false) {',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'S3 计划项缺合法 minutes（旧数据）时按 0 计，不再给默认值展示',
    file: SHARED,
    from: '      const minutes = check.ok ? check.value : DEFAULT_PLAN_MINUTES',
    to: '      const minutes = check.ok ? check.value : 0',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'S4 已结束投入不再累计（`doneMinutes` 丢）',
    file: SHARED,
    from: '      if (row.effortDone) doneMinutes += minutes',
    to: '      // 变异：不统计已结束投入',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'S5 关闭任务不再标记（taskClosed 恒 false，账本看不出已完成/已归档）',
    file: SHARED,
    from: '        taskClosed: task !== undefined && !isOpenTask({ statusCode: task.statusCode, archived: archivedFlag(task.archived) }),',
    to: '        taskClosed: false,',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'S6 free 去掉 max(0, ·)（超支时「余」变成负数）',
    file: SHARED,
    from: '  const free = Math.max(0, capacityMinutes - planned)',
    to: '  const free = capacityMinutes - planned',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'S7 条形分母不看已排（`total` 只取可投入）',
    file: SHARED,
    from: '    total: Math.max(capacityMinutes, planned, 1),',
    to: '    total: capacityMinutes,',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'S8 超支不再告警（`over` 恒 false）',
    file: SHARED,
    from: '    over: planned > capacityMinutes,',
    to: '    over: false,',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'S9 计划不可解析时仍报 readable=true（界面会假装 0，而不是"不可计算"）',
    file: SHARED,
    from: '    readable: input.planReadable,',
    to: '    readable: true,',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'S10 未排入不再是补集（已排入的项也进未排入区）',
    file: SHARED,
    from: '  const unscheduled: CapacityUnscheduledRow[] = candidateResult.unscheduled.map((candidate) => ({',
    to: '  const unscheduled: CapacityUnscheduledRow[] = candidateResult.candidates.map((candidate) => ({',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'S11 计划行的优先级档位写死 p0（不再按任务真实优先级）',
    file: SHARED,
    from: "        band: candidateBand(task?.priorityCode ?? 'p3'),",
    to: "        band: 'p0',",
    tests: CAPACITY_TESTS,
  },
  {
    name: 'S12 未排入的「建议投入合计」恒 0（读数少一块）',
    file: SHARED,
    from: '  const unscheduledSuggestedMinutes = unscheduled.reduce((sum, row) => sum + row.suggestedMinutes, 0)',
    to: '  const unscheduledSuggestedMinutes = 0',
    tests: CAPACITY_TESTS,
  },

  // ── 接线：memo 依赖（I1）与编辑耗时四个接线点（I2–I5）─────────────────────
  {
    name: 'I1 容量 memo 依赖数组塞回 now 对象（每帧失效，memo 形同虚设）',
    file: INDEX,
    from: '    [tasks, archivedTasks, todayPlan, settings.dailyCapacityMinutes, settings.defaultEstimateMinutes, settings.dailyCapacityIncludeOverdue, capacityTodayKey(now)],',
    to: '    [tasks, archivedTasks, todayPlan, settings.dailyCapacityMinutes, settings.defaultEstimateMinutes, settings.dailyCapacityIncludeOverdue, now],',
    tests: WIRING_TESTS,
  },
  {
    name: 'I2 保存 payload 删掉 estimatedMinutes（编辑耗时保存不进去）',
    file: INDEX,
    from: '        estimatedMinutes,\n        allDay: editDraft.allDay,',
    to: '        allDay: editDraft.allDay,',
    tests: WIRING_TESTS,
  },
  {
    name: 'I3 editDraft 初值改回常量（打开编辑框永远显示空，看不见库里真实值）',
    file: INDEX,
    from: "estimatedMinutes: selected.task.estimatedMinutes === null ? '' : String(selected.task.estimatedMinutes)",
    to: "estimatedMinutes: ''",
    tests: WIRING_TESTS,
  },
  {
    name: 'I4 客户端不再就地校验（非法耗时直接发请求，靠服务端 400 猜）',
    file: INDEX,
    from: '    if (estimated !== null && (!Number.isFinite(estimated) || estimated < 1 || estimated > MAX_ESTIMATE_MINUTES)) {\n      pushToast(estimateRangeMessage(DEFAULT_ESTIMATE_MINUTES), \'error\')\n      return\n    }',
    to: '    // 变异：客户端校验被删掉',
    tests: WIRING_TESTS,
  },
  {
    name: 'I5 乐观更新被删（改完必须刷新页面才看到「已排」变）',
    file: INDEX,
    from: '      setTasks((prev) => prev.map((task) => (\n        task.id === selected.task.id ? { ...task, estimatedMinutes, allDay: editDraft.allDay } : task\n      )))',
    to: '      // 变异：乐观更新被删掉',
    tests: WIRING_TESTS,
  },

  // ── 面板：只吃 props（P1–P3）──────────────────────────────────────────────
  {
    name: 'P1 面板自己 reduce 求和「已排」（第二份实现，与纯函数迟早不一致）',
    file: PANEL,
    from: '          已排 <b>{capacity.planned}</b> min（{capacity.plannedCount} 条，已结束 {capacity.doneMinutes} min） ·',
    to: '          已排 <b>{capacity.plannedItems.reduce((sum, row) => sum + row.minutes, 0)}</b> min（{capacity.plannedCount} 条，已结束 {capacity.doneMinutes} min） ·',
    tests: WIRING_TESTS,
  },
  {
    name: 'P2 面板把逾期开关的取值换成常量（与 props 脱钩 —— 第二权威源的典型形态）',
    file: PANEL,
    from: '  const { capacity, dailyCapacityMinutes, defaultEstimateMinutes, includeOverdue, onIncludeOverdueChange, expanded, onExpandedChange, onAddToPlan, addingTaskId, inlineToggle = false } = props',
    to: '  const { capacity, dailyCapacityMinutes, defaultEstimateMinutes, onIncludeOverdueChange, expanded, onExpandedChange, onAddToPlan, addingTaskId, inlineToggle = false } = props\n  const includeOverdue = false',
    tests: PANEL_TESTS,
  },
  {
    name: 'P3 面板把逾期开关的勾选态写死 false（开关变成假控件：点了不勾）',
    file: PANEL,
    from: '              checked={includeOverdue}',
    to: '              checked={false}',
    tests: PANEL_TESTS,
  },
]

const results = []
/**
 * 跑一条命令并回传成败。
 *
 * 注意两件事（都踩过）：
 * - Windows 上 `pnpm` 是 .cmd，必须 `shell: true`；
 * - `stdio: 'pipe'` 下拿不到输出就会让"构建失败"变成一句空话 —— 失败时把输出带回去，别静默。
 */
function run(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', shell: true })
    return { ok: true, out: '' }
  } catch (error) {
    return { ok: false, out: `${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}\n${error.message}` }
  }
}

/** 构建：直接跑三步，别经过 pnpm（少一层 shell 就少一类偶发）。 */
function build() {
  const rm = run('node', ['-e', "require('node:fs').rmSync('lib',{recursive:true,force:true})"])
  if (!rm.ok) return rm
  const tsc = run('npx', ['tsc', '-p', 'tsconfig.build.json'])
  if (!tsc.ok) return tsc
  return run('npx', ['tsdown'])
}

console.log('基线：先构建，再确认未变异时相关测试是绿的')
const baselineBuild = build()
if (!baselineBuild.ok) {
  console.error(`FAIL: 基线构建失败，先修构建。输出（尾部）：\n${baselineBuild.out.slice(-3000) || '(空输出)'}`)
  process.exit(1)
}
const baseline = run('node', ['--test', ...CAPACITY_TESTS, ...WIRING_TESTS, ...PANEL_TESTS])
if (!baseline.ok) {
  console.error('FAIL: 未变异时测试就是红的，探针无意义。先修好测试再跑探针。')
  console.error(baseline.out.slice(-2000))
  process.exit(1)
}
console.log('基线 ok（全绿）\n')

const backups = new Map()
/** 归一化成 \n 的源码（变异片段按 \n 写）+ 该文件原本是否 CRLF（还原用）。 */
const normalized = new Map()
const wroteCrlf = new Map()
try {
  for (const m of MUTATIONS) {
    if (!backups.has(m.file)) {
      const original = readFileSync(m.file, 'utf8')
      backups.set(m.file, original)
      // 变异片段是用 \n 写的，而 Windows 检出可能是 CRLF —— 统一成 \n 再比对，
      // 还原时按原样写回（backups 存的是原始字节内容）。
      normalized.set(m.file, original.replace(/\r\n/g, '\n'))
      wroteCrlf.set(m.file, original.includes('\r\n'))
    }
    const original = backups.get(m.file)
    const normalizedSource = normalized.get(m.file)
    if (!normalizedSource.includes(m.from)) {
      results.push({ name: m.name, ok: false, detail: `源码里找不到要替换的片段（策略可能已改名）：${m.from.slice(0, 60)}…` })
      console.log(`FAIL  ${m.name}\n      找不到替换片段（探针失效，需更新）`)
      continue
    }
    const mutated = normalizedSource.replace(m.from, m.to)
    // 该文件原本是 CRLF 就写回 CRLF，避免为了跑探针把整个文件的行尾改掉
    writeFileSync(m.file, wroteCrlf.get(m.file) === true ? mutated.replace(/\n/g, '\r\n') : mutated)
    // 判定模块要重新构建（测试跑的是 lib/）
    const built = build()
    if (!built.ok) {
      results.push({ name: m.name, ok: false, detail: '变异后构建失败（说明变异本身不合法）' })
      console.log(`FAIL  ${m.name}\n      变异后构建失败`)
      continue
    }
    const red = run('node', ['--test', ...m.tests])
    const guardWorks = red.ok === false
    results.push({ name: m.name, ok: guardWorks, detail: guardWorks ? '变红 ✓' : '仍然全绿 ✗（这条策略没有测试守得住）' })
    console.log(`${guardWorks ? 'ok  ' : 'FAIL'}  ${m.name} — ${guardWorks ? '变红 ✓' : '仍然全绿 ✗'}`)
    // 立刻还原，避免下一个变异的基线是脏的
    writeFileSync(m.file, original)
    build()
  }
} finally {
  for (const [file, content] of backups) writeFileSync(file, content)
  build()
  console.log('\n已还原全部源码并重建。')
}

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`变异探针：${results.length - failed.length}/${results.length} 条变异都变红`)
if (failed.length > 0) {
  console.log('防线有洞：')
  for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail)
  process.exit(1)
}
