/**
 * 变异探针：把本次新增/固化的每条策略逐个"装回缺陷版"，确认测试**必须变红**。
 *
 * 为什么需要它：一条策略如果没有任何测试守得住，撤掉它测试还是全绿 —— 那"有测试"就是假象。
 * 本探针刻意包含三类**接线类**变异（M10–M12）：它们不改纯函数、纯函数测试照样全绿，
 * 但功能确实坏了（memo 每帧失效 / payload 丢字段 / 编辑框初值恒空）。
 * 只有源码级断言才守得住它们，所以这三条是"接线有没有被测试锁住"的证据。
 *
 * 做法：备份源码 → 改一处 → 重新构建 → 只跑相关测试文件 → 记录红/绿 → 还原。
 * 全程 try/finally 还原，失败也会把工作区恢复原状（不留半改状态）。
 *
 * 用法：node scripts/repro/probe-capacity-mutations.mjs
 * 退出码 0 = 所有变异都变红（防线有效）；非 0 = 有变异仍然全绿（防线有洞）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = process.cwd()
const CAPACITY = 'src/client/capacity.ts'
const INDEX = 'src/client/index.tsx'

const CAPACITY_TESTS = ['test/capacity.test.mjs']
const WIRING_TESTS = ['test/capacityWiring.test.mjs']

/** 每个变异：改哪个文件、怎么改、应该让哪些测试文件变红。 */
const MUTATIONS = [
  {
    name: 'M1 兜底默认从「传入的默认耗时」改成写死 0（没填耗时的任务不再占时间）',
    file: CAPACITY,
    from: 'if (normalized === null) return { minutes: defaultMinutes, usedFallback: true }',
    to: 'if (normalized === null) return { minutes: 0, usedFallback: true }',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'M2 去掉 done/cancelled 过滤（完成/取消的任务也进「已排」）',
    file: CAPACITY,
    from: "    if (task.statusCode === 'done' || task.statusCode === 'cancelled') continue",
    to: '    // 变异：过滤被删掉',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'M3 去掉 archived 过滤（归档任务也算进今日容量）',
    file: CAPACITY,
    from: '    if (task.archived === true) continue',
    to: '    // 变异：归档过滤被删掉',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'M4 逾期改成默认计入（历史欠账混进"今天要做的事"）',
    file: CAPACITY,
    from: '    if (isOverdue) {\n      // 逾期与"今天到期"互斥（上面已经 continue 掉了），不会算两遍。\n      if (includeOverdue) {',
    to: '    if (isOverdue) {\n      // 逾期与"今天到期"互斥（上面已经 continue 掉了），不会算两遍。\n      if (true) {',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'M5 全天任务改按固定 480 分钟计（"全天"被误当成容量口径）',
    file: CAPACITY,
    from: '  const normalized = clampEstimatedMinutes(task.estimatedMinutes)',
    to: '  const normalized = task.allDay === true ? 480 : clampEstimatedMinutes(task.estimatedMinutes)',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'M6 free 去掉 max(0, ·)（超支时「余」变成负数）',
    file: CAPACITY,
    from: '  const free = Math.max(0, capacityMinutes - planned)',
    to: '  const free = capacityMinutes - planned',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'M7 未知优先级归 p0 而不是 p3（把"没识别"当成"最紧急"）',
    file: CAPACITY,
    from: "  return priorityCode === 'p0' || priorityCode === 'p1' || priorityCode === 'p2' ? priorityCode : 'p3'",
    to: "  return priorityCode === 'p1' || priorityCode === 'p2' || priorityCode === 'p3' ? priorityCode : 'p0'",
    tests: CAPACITY_TESTS,
  },
  {
    name: 'M8 fallbackCount 漏算"继承截止且没填耗时"的那条',
    file: CAPACITY,
    from: '      dueTodayCount += 1\n      if (usedFallback) fallbackCount += 1',
    to: '      dueTodayCount += 1\n      if (usedFallback && !inheritedDue) fallbackCount += 1',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'M9 默认耗时写死 30，不用传入值（设置页改了默认耗时也不生效）',
    file: CAPACITY,
    from: '    const { minutes, usedFallback } = minutesOf(task, defaultMinutes)',
    to: '    const { minutes, usedFallback } = minutesOf(task, 30)',
    tests: CAPACITY_TESTS,
  },
  {
    name: 'M10 memo 依赖数组塞回 now（每帧失效，memo 形同虚设）',
    file: INDEX,
    from: '    [tasks, archivedTasks, settings.dailyCapacityMinutes, settings.defaultEstimateMinutes, settings.dailyCapacityIncludeOverdue, capacityTodayKey(now)],',
    to: '    [tasks, archivedTasks, settings.dailyCapacityMinutes, settings.defaultEstimateMinutes, settings.dailyCapacityIncludeOverdue, now],',
    tests: WIRING_TESTS,
  },
  {
    name: 'M11 saveEditDraft 的 payload 删掉 estimatedMinutes（编辑耗时保存不进去）',
    file: INDEX,
    from: '        estimatedMinutes,\n        allDay: editDraft.allDay,',
    to: '        allDay: editDraft.allDay,',
    tests: WIRING_TESTS,
  },
  {
    name: 'M12 editDraft 初值改回常量（打开编辑框永远显示空/30，看不见库里真实值）',
    file: INDEX,
    from: "estimatedMinutes: selected.task.estimatedMinutes === null ? '' : String(selected.task.estimatedMinutes)",
    to: "estimatedMinutes: ''",
    tests: WIRING_TESTS,
  },
  {
    name: 'M13 客户端不再就地校验（非法耗时直接发请求，靠服务端 400 猜）',
    file: INDEX,
    from: '    if (estimated !== null && (!Number.isFinite(estimated) || estimated < 1 || estimated > MAX_ESTIMATE_MINUTES)) {\n      pushToast(estimateRangeMessage(DEFAULT_ESTIMATE_MINUTES), \'error\')\n      return\n    }',
    to: '    // 变异：客户端校验被删掉',
    tests: WIRING_TESTS,
  },
  {
    name: 'M14 乐观更新被删（改完必须刷新页面才看到「已排」变）',
    file: INDEX,
    from: '      setTasks((prev) => prev.map((task) => (\n        task.id === selected.task.id ? { ...task, estimatedMinutes, allDay: editDraft.allDay } : task\n      )))',
    to: '      // 变异：乐观更新被删掉',
    tests: WIRING_TESTS,
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
const baseline = run('node', ['--test', ...CAPACITY_TESTS, ...WIRING_TESTS])
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
