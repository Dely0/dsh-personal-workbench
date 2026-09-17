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
const LOG = join(ROOT, 'lib', 'knowledge-recall-log.js')
const REPO_KNOWLEDGE = join(ROOT, 'lib', 'db', 'repo', 'knowledge.js')
const TOOLS = join(ROOT, 'lib', 'knowledge-tools.js')
const TEST_FILES = [
  'test/knowledgeRecallPure.test.mjs',
  'test/knowledgeRecallManager.test.mjs',
  'test/knowledgeRecallRoutes.test.mjs',
  'test/knowledgeRecallWiring.test.mjs',
]

const MUTATIONS = [
  {
    name: 'M1 打分退回"字段混用"：权重取最高档、覆盖率取三字段并集（v1.15.3 的噪声根因）',
    file: CORE,
    from: /const score = clamp01\(Math\.max\(titleScore, tagScore, bodyScore\)\);/,
    to: [
      'const allTerms = [...new Set([...titleTerms, ...tagTerms, ...bodyTerms])];',
      '    const massAll = allTerms.reduce((sum, term) => sum + idfOf(context.stats, term), 0);',
      '    const weight = Math.max(titleTerms.length > 0 ? WEIGHT.title : 0, tagTerms.length > 0 ? WEIGHT.tag : 0, bodyTerms.length > 0 ? WEIGHT.body : 0);',
      '    const score = clamp01(weight * Math.min(1, massAll / (context.massSat ?? RECALL_DEFAULTS.massSat)) * (0.5 + 0.5 * Math.min(1, massAll / massQuery)));',
    ].join('\n    '),
    expect: '权重与覆盖率必须来自同一个字段',
  },
  {
    name: 'M2 信息量因子不封顶（massSat 调到天上 → 打分整体塌掉）',
    file: CORE,
    from: /massSat: 0\.6,/,
    to: 'massSat: 1000,',
    expect: 'massSat 是量出来的标定值，不能随手改',
  },
  {
    name: 'M3 去掉覆盖率因子（只共享一个字也拿满分权重）',
    file: CORE,
    from: /return \{ score: weight \* strength \* \(0\.5 \+ 0\.5 \* coverage\), massHit \};/,
    to: 'return { score: weight * strength, massHit };',
    expect: '命中覆盖率必须参与打分',
  },
  {
    name: 'M4 阈值降到"正文命中即过"（等于把噪声放进来）',
    file: CORE,
    from: /minScore: 0\.33,/,
    to: 'minScore: 0.2,',
    expect: '正文单命中（≤0.25）必须被挡下',
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
    from: /return \{ score: weight \* strength \* \(0\.5 \+ 0\.5 \* coverage\), massHit \};/,
    to: 'return { score: weight * strength * (0.5 + 0.5 * coverage) + 0.04, massHit };',
    expect: '新旧只做同分排序，不进分数',
  },
  {
    name: 'M32 IDF 拉平（每个词等权 → 常用字把真实命中摊薄，P1b 的全部收益消失）',
    file: CORE,
    from: /return Math\.log\(1 \+ stats\.size \/ df\) \/ Math\.log\(1 \+ stats\.size\);/,
    to: 'return 1;',
    expect: '按信息量加权是 P1b 的唯一机制（拉平后真实提问的完整注入率必须掉回去）',
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
  {
    name: 'M14 合并后不重新施加单回合上限（两句 query → 最多 6 条）',
    file: CORE,
    from: /const hits = ranked\.slice\(0, maxEntries\);/,
    to: 'const hits = ranked;',
    expect: '合并后必须仍受单回合上限约束',
  },
  {
    name: 'M15 事件解包退回顶层字段（真实事件在 data 信封里 → 每回合召回静默失效）',
    file: MANAGER,
    from: /return shaped\?\.data !== null && typeof shaped\?\.data === 'object' && !Array\.isArray\(shaped\?\.data\)/,
    to: 'return false && shaped?.data !== null && typeof shaped?.data === \'object\' && !Array.isArray(shaped?.data)',
    expect: '必须解包 data 信封（团队记忆实测过的坑）',
  },
  {
    name: 'M16 不过滤插件注入的消息（把运行时快照当成用户提问 → 自激）',
    file: MANAGER,
    from: /if \(kind === 'plugin'\)\r?\n\s*return false;/,
    to: "if (kind === 'plugin') return true;",
    expect: '只认用户本人写的消息',
  },
  {
    name: 'M17 开关退回"config 优先"（设置页开关被静默架空 = 假控件）',
    file: MANAGER,
    from: /const stored = readMeta\(this\.db, AUTO_RECALL_KEY\);\r?\n\s*if \(stored !== undefined\)\r?\n\s*return stored !== '0';\r?\n\s*return this\.options\.enabled \?\? true;/,
    to: "if (this.options.enabled !== undefined)\n            return this.options.enabled;\n        return (readMeta(this.db, AUTO_RECALL_KEY) ?? '1') !== '0';",
    expect: 'meta（用户显式动作）是唯一权威源',
  },
  {
    name: 'M18 候选集退回 500（全库超 500 条时静默少召回）',
    file: MANAGER,
    from: /listKnowledge\(this\.db, \{ limit: RECALL_MAX_CANDIDATES \}\)/,
    to: 'listKnowledge(this.db, { limit: 500 })',
    expect: '候选集必须是全量',
  },
  {
    name: 'M19 引用回报退回"只扫最近 200 行"（长会话旧行的引用被静默丢弃）',
    file: LOG,
    from: /const rows = new Map\(\);\r?\n\s*for \(const id of ids\) \{\r?\n\s*for \(const row of select\.all\(input\.sessionId, `%\$\{id\}%`\)\) \{\r?\n\s*rows\.set\(row\.id, row\);\r?\n\s*\}\r?\n\s*\}/,
    to: "const rows = new Map();\n    const legacy = db.prepare('SELECT id, hits_json, cited_ids_json FROM knowledge_recall_log WHERE session_id = ? ORDER BY id DESC LIMIT 200').all(input.sessionId);\n    for (const row of legacy) rows.set(row.id, row);",
    expect: '引用要能回填到会话里最旧的那一行',
  },
  {
    name: 'M20 关联晚到时不再补做「开工前」（新会话的开工前召回静默消失）',
    file: MANAGER,
    from: /primeIfNeeded\(sessionId, cwd\) \{\r?\n\s*if \(this\.state\(sessionId\)\.primed\)\r?\n\s*return undefined;\r?\n\s*return this\.prime\(sessionId, cwd\);/,
    to: 'primeIfNeeded(sessionId, cwd) {\n        return undefined;\n        // eslint-disable-next-line no-unreachable\n        if (this.state(sessionId).primed) return undefined;\n        return this.prime(sessionId, cwd);',
    expect: '关联到手后要补一次开工前召回',
  },
  /**
   * ⚠️ 两条**刻意不收录**的变异，记在这里免得下次重复试：
   * 1. 「关掉开关时不清 pendingText」（加注释但不清也一样全绿）——
   *    `injectionFor` 的闸门会把那一份兜住，所以是**等价变异**；
   * 2. 「删掉 injectionFor 里的开关闸门」—— 也全绿，因为 `setSessionEnabled`
   *    在写开关时已经清空了 pendingText（两道防线互为兜底）。
   * 两条都是等价变异，不是"没有断言守"。
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
    expect: '多句 query 必须分句检索后合并',
  },
  {
    name: 'M12 合并时不再按 id 取最高分（同一篇被两句话各算一次）',
    file: CORE,
    from: /if \(hit\.score > seen\.score\)/,
    to: 'if (false)',
    expect: '按 id 去重并保留分数更高的那次',
  },
  {
    name: 'M13 引用回报的两道防线一起撤掉（把引用写到"什么都没带出来"的日志行上）',
    /**
     * ⚠️ 必须**同时**撤掉两道才可观测：单独把 `mine = ids.filter(delivered)` 换成 `mine = ids`
     * 是**等价变异** —— SQL 已经用 `hits_json LIKE %id%` 把"没带出过该条目"的行筛掉了。
     * 所以这里用 `edits`（多处编辑）：既去掉 LIKE 预筛，又去掉 delivered 判定。
     */
    file: LOG,
    edits: [
      {
        from: /WHERE session_id = \? AND hits_json LIKE \? ORDER BY id DESC LIMIT 1000/,
        to: 'WHERE session_id = ? ORDER BY id DESC LIMIT 1000',
      },
      {
        from: /for \(const id of ids\) \{\r?\n\s*for \(const row of select\.all\(input\.sessionId, `%\$\{id\}%`\)\) \{/,
        to: 'for (const id of ids) {\n        for (const row of select.all(input.sessionId, `%${id}%`)) {',
      },
      {
        from: /const mine = ids\.filter\(\(id\) => delivered\.includes\(id\)\);/,
        to: 'const mine = ids;',
      },
    ],
    expect: '只有真的把该条目带给过模型的那一行才配记引用',
  },
  /**
   * v1.15.5 的三条（用户 2026-09-17 实测抓到的"承诺与能力不一致"）：
   * 注入文案承诺"按 id 再查一次就能展开"，而工具只会关键词检索；展示相关度是有界分，
   * 看着永远比团队记忆低。这三条各自必须被断言守住。
   */
  {
    name: 'M21 按 id 直读那条路失效（工具退回"只会关键词检索"→ 注入文案的承诺再次变成假话）',
    file: TOOLS,
    from: /if \(isEntryIdQuery\(query\)\) \{/,
    to: 'if (false) {',
    expect: '把 [id] 当 query 必须能取到全文',
  },
  {
    name: 'M22 id 解包不再剥方括号（注入文案里就是 [uuid] 形态 → 模型照抄必失败）',
    file: MANAGER,
    from: /\.replace\(\/\^\\\[\|\\\]\$\/g, ''\)/,
    to: ".replace(/$^/g, '')",
    expect: '[id] 与 【id】 两种包裹都要能剥掉',
  },
  {
    name: 'M23 展示层退回内部原始分（相关度又变成"永远 0.55 封顶"，用户会再次认为打分偏低）',
    file: CORE,
    from: /相关度 \$\{formatRelevance\(hit\.score\)\}/,
    to: '相关度 ${hit.score.toFixed(2)}',
    expect: '展示层必须是归一化相关度（0~1）',
  },
  {
    name: 'M24 min_score 不做口径换算（按界面上的数字传阈值 → 命中被静默挡下）',
    file: TOOLS,
    from: /scoreFromRelevance\(args\.min_score\)/,
    to: 'args.min_score',
    expect: '工具阈值与输出里的相关度必须是同一把尺子',
  },
  {
    name: 'M25 砍掉提示档（真实提问普遍卡在阈值下 0.01~0.03，砍掉就又是"自动层什么都不给"）',
    file: CORE,
    from: /const nearMisses = scored\.filter\(\(hit\) => hit\.score > hintScore && hit\.score <= minScore\);/,
    to: 'const nearMisses = [];',
    expect: '差一点点的要进提示档，而不是被彻底丢掉',
  },
  {
    name: 'M26 提示不去重（同一条在同一会话里每回合都提示 = 反复注入噪声）',
    file: MANAGER,
    from: /const fresh = \(outcome\.nearMisses \?\? \[\]\)\.filter\(\(hit\) => !state\.hintedIds\.has\(hit\.id\)\);/,
    to: 'const fresh = (outcome.nearMisses ?? []);',
    expect: '同一会话不重复提示同一条',
  },
  {
    name: 'M27 willInject 只看 hits（日志说"没注入"、会话里却留了一行提示 —— 账对不上）',
    file: CORE,
    from: /return outcome\.hits\.length > 0 \|\| \(outcome\.nearMisses\?\.length \?\? 0\) > 0;/,
    to: 'return outcome.hits.length > 0;',
    expect: '有提示也算"会留下东西"',
  },
  /**
   * v1.15.7（P1 检索时机重构）的四条 —— 治的是**静默漏检索**：
   * 实测 turn 16 那一轮有两条用户本人消息（实质提问 + 「停」），旧实现只取最后一条
   * → 那句实质提问**从未被检索过**（失败发生在打分之前），而库里有一条 0.72 相关度的条目。
   */
  {
    name: 'M28 取词范围退回"只取最后一条用户消息"（一轮两条消息时前一条被静默丢掉）',
    file: MANAGER,
    from: /export function currentTurnUserMessages\(agent\) \{[\s\S]*?\n\}\n/,
    to: 'export function currentTurnUserMessages(agent) {\n'
      + '    const session = agent?.session;\n'
      + '    const events = snapshotEvents(session);\n'
      + '    const fallback = latestUserMessage(events);\n'
      + '    return fallback === undefined ? [] : [fallback];\n'
      + '}\n',
    expect: '本回合每一条用户消息都要被检索（只取最后一条 = 静默丢件）',
  },
  {
    name: 'M29 检索退回"回合收尾预取"（装配期看不到当轮提问 → 问题那一轮永远没有知识）',
    file: MANAGER,
    from: /return manager\.assemblyInjection\(sessionId, agent\?\.session\?\.header\?\.cwd, agent\);/,
    to: 'return manager.injectionFor(sessionId, currentTurnOf(agent));',
    expect: '检索必须发生在装配期（用当前这条用户消息）',
  },
  {
    name: 'M30 开工前那份直接覆盖 pendingText（算了却送不达：实测 turn 15 被 prime 覆盖）',
    file: MANAGER,
    from: /state\.primeOutcome = willInject\(outcome\) \? outcome : undefined;/,
    to: 'this.buildPending(state, outcome);',
    expect: '开工前那份要挂起并与当轮结果合并，不能覆盖',
  },
  {
    name: 'M31 未纳入检索不留痕（有用户消息却没检索，账上看不出来 = 静默丢件）',
    file: MANAGER,
    from: /appendRecallLog\(this\.db, \{ sessionId, taskId: this\.resolveTaskId\(sessionId, cwd\), trigger: 'turn', outcome, injected: false \}\);/,
    to: 'void outcome;',
    expect: '任何"有用户消息但没纳入检索"的情形都要在账上留一行',
  },
  /**
   * v1.15.7 的 P2 / P4 / P5 三条。
   */
  {
    name: 'M33 不过滤"已被取代/已过期"（作废的结论照样进上下文）',
    file: CORE,
    from: /if \(isSuperseded\(candidate\.entry, now\)\) \{\r?\n\s*droppedAsSuperseded \+= 1;\r?\n\s*continue;\r?\n\s*\}/,
    to: 'if (false) {\n            droppedAsSuperseded += 1;\n            continue;\n        }',
    expect: '被取代/已过期的条目必须被压制（不是降权）',
  },
  {
    name: 'M34 引用判定放宽成"瞎标"（注入过的全标成被引用 → 证据失真）',
    file: CORE,
    from: /if \(title\.length >= CITE_TITLE_PREFIX && text\.includes\(title\.slice\(0, CITE_TITLE_PREFIX\)\)\)\r?\n\s*out\.push\(item\.id\);/,
    to: 'out.push(item.id);',
    expect: '只有回答里真的出现标题/id 才算引用（宁可漏标，不可瞎标）',
  },
  {
    name: 'M35 suggested_miss 不再看"像不像报错"（每回合都记一行 = 噪声淹没观测）',
    file: MANAGER,
    from: /if \(!looksLikeErrorReport\(text\)\)\r?\n\s*return;/,
    to: 'if (false)\n            return;',
    expect: '只对"像报错"的提问记 suggested_miss',
  },
  {
    name: 'M36 注入文本里不中和 `{{`（宿主当模板插值 → 抛异常打断整个提示装配）',
    file: CORE,
    from: /return text\.replace\(\/\\\{\\\{\/g, '\{ \{'\);/,
    to: 'return text;',
    expect: '宿主会对注入文本做模板插值，`{{` 必须先拆开',
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
  // 支持 `edits: [{from,to}, …]`（有些缺陷必须同时撤掉两道防线才可观测）
  const edits = mutation.edits ?? [{ from: mutation.from, to: mutation.to }]
  const unmatched = edits.filter((edit) => !edit.from.test(original))
  if (unmatched.length > 0) {
    console.error(`✖ ${mutation.name}\n    变异点没匹配上（源码结构变了，需要同步本探针）`)
    failures += 1
    continue
  }
  try {
    let mutated = original
    for (const edit of edits) mutated = mutated.replace(edit.from, edit.to)
    writeFileSync(mutation.file, mutated)
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
