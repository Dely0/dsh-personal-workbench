/**
 * 反向验证：把知识库自动召回的**关键设计**逐条装回缺陷，断言必须变红。
 *
 * 为什么必须有它：这一版的核心是"**接线 + 口径**"，纯函数单测全绿也可能在真实数据上
 * 变成噪声或沉默（本轮实测就吃过两次：逐字加分让所有命中都 1.00；
 * 覆盖率归一化又让真实提问全被挡在门外）。每条变异都对应一个**实测踩过的坑**，
 * 撤掉它 → 必须有断言变红。
 *
 * 每条变异跑完立刻从内存还原原文件（`finally`），工作区不留改动。
 * 任何一条"照样全绿"就以非零码退出。
 *
 * 用法：node scripts/repro/probe-knowledge-recall-mutations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CORE = join(ROOT, 'lib', 'shared', 'knowledgeRecall.js')
const MANAGER = join(ROOT, 'lib', 'knowledge-recall.js')
const TEST_FILES = [
  'test/knowledgeRecallPure.test.mjs',
  'test/knowledgeRecallManager.test.mjs',
  'test/knowledgeRecallRoutes.test.mjs',
]

const MUTATIONS = [
  {
    name: 'M1 打分退回第一版"逐字加分"（0.55 + 0.06×命中词数）→ 长正文堆字就能到 1.00',
    file: CORE,
    from: /const score = clamp01\(weight \* lengthFactor \* \(0\.5 \+ 0\.5 \* coverage\)\)/,
    to: 'const score = clamp01(weight + 0.06 * (hitTermCount - 1))',
    expect: '分数 = 权重 × 长度因子 × 覆盖率',
  },
  {
    name: 'M2 长度因子不封顶（长正文靠体量白拿分）',
    file: CORE,
    from: /const LENGTH_SATURATION = 3/,
    to: 'const LENGTH_SATURATION = 1000',
    expect: '命中 3 个词即饱和',
  },
  {
    name: 'M3 去掉覆盖率因子（只共享一个字也拿满分权重）',
    file: CORE,
    from: /weight \* lengthFactor \* \(0\.5 \+ 0\.5 \* coverage\)/,
    to: 'weight * lengthFactor',
    expect: '命中覆盖率必须参与打分',
  },
  {
    name: 'M4 阈值降到"正文命中即过"（等于把噪声放进来）',
    file: CORE,
    from: /minScore: 0\.34,/,
    to: 'minScore: 0.2,',
    expect: '正文单命中（0.083~0.25）必须被挡下',
  },
  {
    name: 'M5 阈值比较从"严格大于"改成"大于等于"（边界条目混进来）',
    file: CORE,
    from: /const aboveScore = scored\.filter\(\(hit\) => hit\.score > minScore\)/,
    to: 'const aboveScore = scored.filter((hit) => hit.score >= minScore)',
    expect: '阈值是硬边界，不能靠等号放行',
  },
  {
    name: 'M6 时间重新进分数（"新旧"污染相关性档位 —— 实测踩过的原形态）',
    file: CORE,
    from: /const score = clamp01\(weight \* lengthFactor \* \(0\.5 \+ 0\.5 \* coverage\)\)/,
    to: 'const score = clamp01(weight * lengthFactor * (0.5 + 0.5 * coverage) + 0.04 * recencyFactor(entry.updatedAt, context.now))',
    expect: '新旧只做同分排序，不进分数',
  },
  {
    name: 'M7 琐碎消息也去检索（"好的"这种消息也会带出知识）',
    file: CORE,
    from: /if \(isTrivialQuery\(query\)\)\s*\n\s*return \{ \.\.\.base, skippedReason: '琐碎消息' \};/,
    to: 'if (false) return { ...base, skippedReason: \'琐碎消息\' };',
    expect: '琐碎消息必须跳过（且留痕）',
  },
  {
    name: 'M8 单字中文查询不再被判琐碎（命中面过宽）',
    file: CORE,
    from: /return terms\.length < 2;/,
    to: 'return false;',
    expect: '纯汉字查询至少要两个字才算有信息量',
  },
  /**
   * ⚠️ 两条**刻意不收录**的变异，记在这里免得下次重复试：
   * 1. 「关掉开关时不清 pendingText」（加注释但不清也一样全绿）——
   *    `injectionFor` 的闸门会把那一份兜住，所以是**等价变异**；
   * 2. 「删掉 injectionFor 里的开关闸门」—— 也全绿，因为 `setSessionEnabled`
   *    在写开关时已经清空了 pendingText（两道防线互为兜底）。
   * 两条都是等价变异，不是"没有断言守"。真正守这个行为的是下面 M10 那条
   * （清空 + 闸门同时撤掉 → 复现"关了还在带出"）。
   */
  {
    name: 'M9 重新打开时不去重（清掉的 seenIds 不还原成空集 → 打开了也不带出东西）',
    file: MANAGER,
    from: /state\.seenIds\.clear\(\);/,
    to: 'void state.seenIds;',
    expect: '重新打开必须重置去重集合',
  },
  {
    name: 'M10 零命中时插一条占位（"零命中不插占位"这条约定失守）',
    file: CORE,
    from: /if \(outcome\.hits\.length === 0\)\r?\n\s*return '';/,
    to: "if (outcome.hits.length === 0)\n        return '【工作台知识库】本次没有找到相关条目。';",
    expect: '零命中必须产出空串（不插占位，保前缀缓存）',
  },
  {
    name: 'M11 开工前把标题与描述拼成一句（覆盖率分母翻倍 → 真实提问被稀释）',
    file: MANAGER,
    from: /const queries = \[task\?\.title \?\? '', task\?\.description \?\? ''\]/,
    to: "const queries = [[task?.title ?? '', task?.description ?? ''].filter((part) => part.trim() !== '').join(' ')]",
  },
  {
    name: 'M12 合并时不再按 id 取最高分（同一篇被两句话各算一次）',
    file: CORE,
    from: /if \(hit\.score > seen\.score\)/,
    to: 'if (false)',
    expect: '按 id 去重并保留分数更高的那次',
  },
  {
    name: 'M13 引用回报不比对 hits（把引用写到"什么都没带出来"的日志行上）',
    file: join(ROOT, 'lib', 'knowledge-recall-log.js'),
    from: /const mine = ids\.filter\(\(id\) => delivered\.includes\(id\)\);/,
    to: 'const mine = ids;',
    expect: '只有真的把该条目带给过模型的那一行才配记引用',
  },
]

const run = () => spawnSync(process.execPath, ['--test', ...TEST_FILES], { cwd: ROOT, encoding: 'utf8' })

const baseline = run()
if (baseline.status !== 0) {
  console.error('基线就没过 —— 先修好单测再跑反向验证：')
  console.error(baseline.stdout)
  process.exit(2)
}
console.log(`基线：${TEST_FILES.join(' + ')} 全绿\n`)

let failures = 0
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8')
  if (!mutation.from.test(original)) {
    console.error(`✖ ${mutation.name}\n    变异点没匹配上（源码结构变了，需要同步本探针）`)
    failures += 1
    continue
  }
  try {
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to))
    const result = run()
    const firstFail = (result.stdout.match(/✖ ([^\n]*)/g) ?? [])[0]?.trim() ?? '(无失败行)'
    if (result.status === 0) {
      console.error(`✖ ${mutation.name}\n    装回缺陷后**仍然全绿** → 这条设计没有任何断言在守`)
      failures += 1
    } else {
      console.log(`✔ ${mutation.name}\n    变红：${firstFail}`)
    }
  } finally {
    writeFileSync(mutation.file, original)
  }
}

const restored = run()
if (restored.status !== 0) {
  console.error('还原后单测反而红了 —— 探针没把文件还原干净')
  process.exit(2)
}

const total = MUTATIONS.length
if (failures > 0) {
  console.error(`\n❌ ${failures}/${total} 条变异没有被断言发现`)
  process.exit(1)
}
console.log(`\n✅ ${total}/${total} 条变异都被断言抓到（还原后仍全绿）`)
