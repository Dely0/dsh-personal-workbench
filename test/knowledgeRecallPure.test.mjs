/**
 * 回归：**知识库召回的相关度打分**（v1.15.3）。
 *
 * 这是"会话 AI 自动用起知识库"的判定核心：命中谁、给多少分、为什么给这个分。
 * 全部是纯函数，所以能在这里穷举 —— 而"命中几条/逐条依据"正是验收要看的东西，
 * 只靠跑一遍真机是锁不住的。
 *
 * 三条最容易被改坏的判据（每条都有对应断言）：
 * 1. **零命中必须与"检索了但被阈值挡下"区分开**（团队沉淀过这条教训：
 *    把这两件事混成一句"零命中（团队暂无相关记忆）"会把人带偏）；
 * 2. **标题 > 标签 > 正文** 的权重次序不能反（反了就是"正文里出现一个字就压过标题命中"）；
 * 3. **去重与条数上限** 必须各记各的账（否则"注入 2 条"与"命中 5 条"对不上）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractTerms,
  formatHintText,
  formatRelevance,
  formatRecallText,
  isTrivialQuery,
  normalizeText,
  mergeRecallOutcomes,
  recallKnowledge,
  recencyFactor,
  relevanceOf,
  RELEVANCE_CEILING,
  RECALL_DEFAULTS,
  scoreCandidate,
  scoreFromRelevance,
  taskIdFromWorkspacePath,
  willInject,
} from '../lib/shared/knowledgeRecall.js'

/**
 * ⚠️ 这里**不 import 类型**：`node --test` 直接跑 `.mjs`，`.d.ts` 只是类型、运行时并不存在，
 * `import { type RecallCandidate }` 会在加载期抛 `SyntaxError: Unexpected identifier 'RecallCandidate'`。
 * 本仓其余测试同理 —— 行为断言一律走运行时形态。
 */

/** 造一条知识条目（只填判定会用到的字段；其余给稳定的假值）。 */
function entry(over = {}) {
  return {
    id: 'k-1',
    kindCode: 'lesson',
    title: '标题',
    contentMd: '',
    tags: [],
    sourceTaskId: null,
    sourceSessionId: null,
    sourceReviewId: null,
    fileLink: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

function candidate(over = {}, fromTask = false) {
  return { entry: entry(over), fromTask }
}

const NOW = new Date('2026-09-17T00:00:00.000Z')

test('抽词：汉字逐字、拉丁按词，停用词与纯数字被丢掉', () => {
  assert.deepEqual(extractTerms('盘符'), ['盘', '符'])
  assert.deepEqual(extractTerms('pointer-events 失效'), ['失', '效', 'pointer-events'], '拉丁串按一个词（允许 - _ . / ），汉字逐字')
  assert.ok(!extractTerms('的是了在').length, '全是停用词 → 空')
  assert.ok(!extractTerms('12345').length, '纯数字不进关键词')
  assert.equal(extractTerms('E_NOENT').includes('e_noent'), true, '带下划线的英文串要整体保留')
})

test('琐碎消息：寒暄与过短提问不检索（但调用方能区分"跳过"与"零命中"）', () => {
  for (const q of ['好的', '继续', 'ok', '嗯', '']) assert.equal(isTrivialQuery(q), true, `「${q}」应视为琐碎`)
  assert.equal(isTrivialQuery('为什么盘符根目录出不去'), false)
  /**
   * 单字中文必须判成琐碎（命中面太宽："盘"能捞出一半库）。
   * ⚠️ `'y'` 走的是**寒暄词表**那条分支，测不到"字数"这条判据；
   * `'x'` 才真正打在它上面（反向探针 M8 就是靠这条变红的）。
   */
  assert.equal(isTrivialQuery('x'), true, '单个拉丁字母：信息量不足')
  assert.equal(isTrivialQuery('阈'), true, '单个汉字：信息量不足')
  assert.equal(isTrivialQuery('ab'), false, '两个字符的英文词够了')
  assert.equal(isTrivialQuery('阈值'), false, '两个汉字够了')
})

test('标题命中 > 标签命中 > 正文命中（权重次序不可反）', () => {
  /**
   * 用**拉丁词 `ab`** 当查询：它被当成一个关键词（不像单字中文会被判琐碎），
   * 于是三个候选的"长度因子"与"覆盖率"完全一致，分数差异**只来自权重**
   * （0.55 / 0.45 / 0.25）——不会被其他因子干扰。
   *
   * ⚠️ 顺带钉住一条**刻意的口径**：关键词只有 1 个时，长度因子只有 1/3，
   * 于是**任何**字段的单命中都够不到阈值（标题 0.183 / 标签 0.15 / 正文 0.083）。
   * 也就是说"只给一个笼统的词就指望带出知识"是不成立的 ——
   * 提问要么落在标题/标签上，要么得给出几个具体词。这是噪声控制的代价，写在文档里而不是靠猜。
   *
   * 这条测试踩过两次坑，都留在注释里：
   * 1. 用「阈值」当查询时，只含"阈"的候选覆盖率只有 1/2，三档的次序读不出来；
   * 2. 占位标题曾用「无关标题」，它的「关」被查询词命中、白送覆盖率 —— 占位标题一律「无题」。
   */
  const q = 'ab'
  const scoreOf = (over) => scoreCandidate(candidate(over), { terms: extractTerms(q), now: NOW })
  const titleHit = scoreOf({ id: 'a', title: 'ab 的坑' })
  const tagHit = scoreOf({ id: 'b', title: '无题', tags: ['ab'] })
  const bodyHit = scoreOf({ id: 'c', title: '无题', contentMd: '这里提到 ab' })
  const expected = (weight) => weight * (1 / 3) * (0.5 + 0.5 * 1) // 命中 1 个词、覆盖率 1
  assert.equal(titleHit?.score, expected(0.55), '标题档 = 0.55 × 1/3 × 1')
  assert.equal(tagHit?.score, expected(0.45), '标签档 = 0.45 × 1/3 × 1')
  assert.equal(bodyHit?.score, expected(0.25), '正文档 = 0.25 × 1/3 × 1')
  assert.ok((titleHit?.score ?? 0) > (tagHit?.score ?? 0), '标题命中必须高于标签命中')
  assert.ok((tagHit?.score ?? 0) > (bodyHit?.score ?? 0), '标签命中必须高于正文命中')
  assert.ok(expected(0.55) < RECALL_DEFAULTS.minScore, '单关键词的标题命中仍不过阈值（刻意的：一个笼统词不足以带出知识）')
  /**
   * 经 `recallKnowledge` 走一遍，确认"过不了阈值的那些"被如实记成 `droppedByScore`
   * 而不是被悄悄丢掉 —— `matched` 与命中集必须能对上账。
   */
  const body = recallKnowledge({ query: q, candidates: [candidate({ id: 'c', title: '无题', contentMd: '这里提到 ab' })], now: NOW })
  assert.equal(body.hits.length, 0, '正文 1 个词 = 0.083，低于阈值，不注入')
  assert.equal(body.matched, 1, '但 matched 要记下"确实命中过"')
  assert.equal(body.droppedByScore, 1)
})

test('正文弱命中会被阈值挡下：与"零命中"分属两种结论', () => {
  /**
   * ⚠️ 关键词必须落在**正文里唯一命中**的位置（title 是"无题"，不共享任何查询词），
   * 否则覆盖率会变、分数会变，这条就测不到"被阈值挡下"这一档。
   * 正文权重 0.25 恒低于阈值 0.34，与时间无关（"新旧"根本不进分数）。
   */
  const weak = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'c', title: '无题', contentMd: '这里只提到盘' })], now: NOW })
  assert.equal(weak.hits.length, 0)
  assert.equal(weak.matched, 1, 'matched 要记下"确实命中过"')
  assert.equal(weak.droppedByScore, 1, '被阈值挡下的条数要单独记')
  assert.equal(weak.skippedReason, undefined, '这不是"跳过检索"')

  const none = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'd', title: '完全无关', contentMd: '别的内容' })], now: NOW })
  assert.equal(none.matched, 0)
  assert.equal(none.droppedByScore, 0)

  const skipped = recallKnowledge({ query: '好的', candidates: [candidate({ title: '盘符' })], now: NOW })
  assert.equal(skipped.skippedReason, '琐碎消息', '跳过检索要给出原因，否则日志里"没有检索行"无法归因')
})

test('相关度 = 权重 × 命中覆盖率：命中越多词越高，但长提问必须成比例命中', () => {
  const one = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'a', title: '盘符' })], now: NOW })
  const two = recallKnowledge({ query: '盘符迁移', candidates: [candidate({ id: 'b', title: '盘符迁移' })], now: NOW })
  // 汉字**逐字**抽词：'盘符' → 2 个词、'盘符迁移' → 4 个词；两条候选各自**全覆盖**
  assert.equal(one.hits[0].score.toFixed(4), (0.55 * (2 / 3)).toFixed(4), '2 个词：0.55 × 2/3 × 1.0')
  assert.equal(two.hits[0].score, 0.55, '4 个词（≥3 饱和）：0.55 × 1 × 1.0 —— 分与提问长度无关')
  /**
   * 这条是本轮实测教训的**回归防线**：长提问里"只碰巧共享几个字"的条目必须掉到阈值以下。
   * 第一版打分（`0.55 + 0.06*(命中词数-1)`）在这里会给 1.00 —— 阈值与排序同时失效。
   * 所以断言的**判据是分数**（0.21 < 0.34），而不是"没命中"。
   */
  const partial = recallKnowledge({
    query: '盘符迁移调试排障日志记录异常堆栈跟踪调用链路依赖注入容器启动参数环境变量配置文件读取顺序优先级冲突解决',
    candidates: [candidate({ id: 'c', title: '盘符迁移磁盘目录选择文件' })],
    now: NOW,
  })
  assert.equal(partial.matched, 1, '确实共享了若干字，所以算命中过')
  /**
   * v1.15.6 起这里记成 `nearMisses`（提示档）而不是 `droppedByScore`：
   * 分数 0.21 落在 `[hintScore 0.20, minScore 0.34)` 里 → **不注入完整块**（意图不变），
   * 但会在会话里留一行"可能相关"。判据仍是"不进 hits"。
   */
  assert.equal(partial.hits.length, 0, '覆盖率太低 → 绝不注入完整块')
  assert.equal(partial.nearMisses.length, 1, '但落在了提示档里（0.21 ∈ [0.20, 0.34)）')
  assert.equal(partial.droppedByScore, 0, '提示档不算"被阈值挡下"（它确实留了痕迹）')
  /**
   * 反方向也要守：**提问与标题几乎同字时不该被过度惩罚**（这是真实性门槛）。
   * 早期"命中数÷提问长度"的写法会在这里给出 0.31，把真实提问全挡在门外。
   */
  const realistic = recallKnowledge({
    query: '盘符 根目录 文件选择',
    candidates: [candidate({ id: 'e', title: '盘符根目录的坑', contentMd: '盘符 parent null' })],
    now: NOW,
  })
  assert.equal(realistic.hits.length, 1, '真实提问（与标题共享 5 个字）必须过线')
  assert.ok(realistic.hits[0].score > RECALL_DEFAULTS.minScore, `实测 ${realistic.hits[0].score.toFixed(3)}`)
})
test('长度因子的边界：命中 3 个词即饱和（0.55 × 2/3 < 阈值 < 0.55 × 1）', () => {
  /**
   * 这条把公式里那两个因子的**边界**钉死，免得将来有人把 3 改成别的数而不自知。
   * 标题档、覆盖率固定为 1（提问就是这三个字），只让命中词数从 2 变 3：
   * 2 个词 = 0.55 × 2/3 = 0.367（过线）／3 个词 = 0.55 × 1 = 0.55。
   */
  const two = scoreCandidate(candidate({ id: 'a', title: '盘符' }), { terms: extractTerms('盘符'), now: NOW })
  const three = scoreCandidate(candidate({ id: 'b', title: '盘符根' }), { terms: extractTerms('盘符根'), now: NOW })
  assert.equal(two?.score, 0.55 * (2 / 3))
  assert.equal(three?.score, 0.55)
  assert.ok((two?.score ?? 0) > RECALL_DEFAULTS.minScore, '2 个词也已经过线（标题命中不该被过度惩罚）')
})

test('新旧不进分数，只做同分排序（这条差点变成噪声来源）', () => {
  assert.equal(recencyFactor('2026-09-17T00:00:00.000Z', NOW), 1)
  assert.equal(recencyFactor('2025-09-17T00:00:00.000Z', NOW), 0)
  assert.equal(recencyFactor('不是时间', NOW), 0)
  const fresh = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'a', title: '盘符', updatedAt: '2026-09-17T00:00:00.000Z' })], now: NOW })
  const stale = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'b', title: '盘符', updatedAt: '2025-09-17T00:00:00.000Z' })], now: NOW })
  assert.equal(fresh.hits[0].score, stale.hits[0].score, '同样命中 → 分数必须一样，时间不能改分数')
  const both = recallKnowledge({
    query: '盘符',
    candidates: [
      candidate({ id: 'stale', title: '盘符', updatedAt: '2025-09-17T00:00:00.000Z' }),
      candidate({ id: 'fresh', title: '盘符', updatedAt: '2026-09-17T00:00:00.000Z' }),
    ],
    now: NOW,
  })
  assert.equal(both.hits[0].id, 'fresh', '同分时更新的排前面（时间的唯一作用）')
})

test('任务域优先：同分时本任务的条目排前面；分数不同则分数优先', () => {
  const outcome = recallKnowledge({
    query: '盘符',
    candidates: [
      // 高分那条：标题命中 5/5 个词（0.55）；低分那条：只在正文命中 1 个词（覆盖率感人，连阈值都不过）。
      // 时间刻意做成"低分那条更新"，否则会把时间的作用误当成分数的作用。
      candidate({ id: 'higherScore', title: '盘符的坑', updatedAt: '2025-01-01T00:00:00.000Z' }, false),
      candidate({ id: 'weakTask', title: '无题', contentMd: '这里只提到盘', updatedAt: '2026-09-17T00:00:00.000Z' }, true),
    ],
    now: NOW,
  })
  assert.deepEqual(outcome.hits.map((hit) => hit.id), ['higherScore'], '任务域优先不能让低分条目插队')
  assert.equal(outcome.droppedByScore, 1)

  const tie = recallKnowledge({
    query: '盘符',
    candidates: [
      candidate({ id: 'global2', title: '盘符', updatedAt: '2026-09-17T00:00:00.000Z' }, false),
      candidate({ id: 'task2', title: '盘符', updatedAt: '2026-09-17T00:00:00.000Z' }, true),
    ],
    now: NOW,
  })
  assert.equal(tie.hits[0].id, 'task2', '同分时本任务优先')
})

test('去重与条数上限各记各的账（注入条数能对上"命中 - 挡下 - 已见 - 超限"）', () => {
  const candidates = [
    candidate({ id: 'a', title: '盘符' }),
    candidate({ id: 'b', title: '盘符迁移' }),
    candidate({ id: 'c', title: '盘符磁盘' }),
    candidate({ id: 'd', title: '盘符目录' }),
  ]
  const outcome = recallKnowledge({ query: '盘符', candidates, excludeIds: ['a'], maxEntries: 2, now: NOW })
  assert.equal(outcome.hits.length, 2)
  assert.equal(outcome.hits.some((hit) => hit.id === 'a'), false, '已注入过的不再出现')
  assert.equal(outcome.matched, 4)
  assert.equal(outcome.droppedAsSeen, 1)
  assert.equal(outcome.droppedByLimit, 1)
  assert.equal(outcome.matched - outcome.droppedAsSeen - outcome.droppedByLimit, outcome.hits.length, '账必须能对上')

  const noDedupe = recallKnowledge({ query: '盘符', candidates, excludeIds: ['a'], dedupe: false, maxEntries: 4, now: NOW })
  assert.equal(noDedupe.hits.some((hit) => hit.id === 'a'), true, 'dedupe=false 时已注入过的仍可命中')
})

test('理由与片段：每条命中都要能解释"为什么是它"', () => {
  /**
   * ⚠️ 这条的 fixture 在 v1.15.4 被**换过**：原来是标题「选择文件出不了 C 盘」+
   * 长正文含"盘符根目录"，靠"标题命中 1 个字 + 正文命中 2 个字"凑过阈值 ——
   * 那正是被修掉的"权重来自一个字段、覆盖率来自另一个字段"。现在那种形态**不该命中**，
   * 所以换成真正相关的 fixture（标题里就有"盘符"）。
   */
  const outcome = recallKnowledge({
    query: '盘符',
    candidates: [candidate({ id: 'a', title: '盘符根目录的坑', contentMd: 'x'.repeat(300) + '盘符根目录的 parent 是 null' })],
    now: NOW,
  })
  const hit = outcome.hits[0]
  assert.match(hit.reason, /标题命中/, '理由要写出命中了哪个字段（得分最高的那一档）')
  assert.match(hit.reason, /盘/, '理由要写出命中了哪些词')
  assert.match(hit.reason, /该字段命中 \d+\/\d+ 个关键词/, '理由要给出该字段的命中比例（可解释）')
  assert.match(hit.snippet, /盘符/, '片段要落在命中词附近，而不是永远取开头')
  assert.equal(hit.id, 'a')
  // 旧 fixture 那种"跨字段凑分"的形态：不命中，且如实记成"命中过但被挡下"
  const mixed = recallKnowledge({
    query: '盘符',
    candidates: [candidate({ id: 'b', title: '选择文件出不了 C 盘', contentMd: 'x'.repeat(300) + '盘符根目录的 parent 是 null' })],
    now: NOW,
  })
  assert.equal(mixed.hits.length, 0, '标题 1 个字 + 正文 2 个字不足以过线')
  assert.equal(mixed.matched, 1, '但 matched 要记下"确实命中过"')
  assert.equal(mixed.droppedByScore, 1)
})

test('渲染：命中才产出文本；文本自带"检索词 + 逐条依据 + 下一步动作"', () => {
  const outcome = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'abcdefgh-1111', title: '盘符的坑', contentMd: '盘符根目录 parent=null' })], now: NOW })
  const text = formatRecallText(outcome)
  assert.match(text, /【工作台知识库】/)
  assert.match(text, /盘符/)
  assert.match(text, /相关度 0\.\d\d/)
  assert.match(text, /workbench_search_knowledge/)
  assert.match(text, /report_usage/)
  assert.equal(formatRecallText({ ...outcome, hits: [] }), '', '零命中必须产出空串（不插占位，保前缀缓存）')
})

test('工作目录兜底：能认出 <任务id>-<标题> 命名，认不出就不猜', () => {
  const id = '4be909c2-926d-4f5f-a48d-cd22cd5ec78a'
  assert.equal(taskIdFromWorkspacePath(`E:\\WS\\${id}-知识库自动调用`), id)
  assert.equal(taskIdFromWorkspacePath(`E:\\WS\\${id}`), id)
  assert.equal(taskIdFromWorkspacePath('E:\\WS\\普通目录-知识库'), undefined)
  assert.equal(taskIdFromWorkspacePath(''), undefined)
})

test('归一化：大小写与空白折叠对检索与打分是同一份（否则"看着像命中"其实是没命中）', () => {
  assert.equal(normalizeText('  Pointer   EVENTS '), 'pointer events')
  const outcome = recallKnowledge({ query: 'Pointer Events', candidates: [candidate({ title: 'pointer-events 不生效' })], now: NOW })
  assert.equal(outcome.matched, 1, '大小写不敏感命中')
})

test('合并后必须**重新施加**单回合条数上限（v1.15.4 修的 F5）', () => {
  /**
   * 两句 query 各自命中 3 条且**互不重叠** → 合并后不能变成 6 条。
   * 线上同形实测过：`knowledge_recall_log` 里一行写着「注入 5 条」，而上限是 3。
   */
  const a = ['a1', 'a2', 'a3'].map((id) => candidate({ id, title: '知识库分页' }))
  const b = ['b1', 'b2', 'b3'].map((id) => candidate({ id, title: '标签筛选' }))
  const o1 = recallKnowledge({ query: '知识库分页', candidates: a, now: NOW })
  const o2 = recallKnowledge({ query: '标签筛选', candidates: b, now: NOW })
  const merged = mergeRecallOutcomes([{ query: '知识库分页', outcome: o1 }, { query: '标签筛选', outcome: o2 }])
  assert.equal(merged.hits.length, RECALL_DEFAULTS.maxEntries, '合并后必须仍在上限内')
  assert.equal(merged.droppedByLimit, 3, '被上限截掉的条数要如实记账')
  assert.equal(merged.matched, 6, '命中过 6 条这件事仍要看得见')
  const capped = mergeRecallOutcomes([{ query: 'x', outcome: o1 }, { query: 'y', outcome: o2 }], { maxEntries: 1 })
  assert.equal(capped.hits.length, 1, '上限可被显式调小')
})

test('权重与覆盖率必须来自**同一个字段**（v1.15.4 修的噪声根因）', () => {
  /**
   * 真实库上发作过：一篇 3000+ 字的泛化长文，与提问只共享**标题里的 1 个字**，
   * 却靠正文命中 8 个字把覆盖率抬到 0.9 → `0.55 × 1 × 0.95 ≈ 0.52`，
   * 在四时机的 4 次不同提问里有 3 次都进 top-3（审查者 F3 / 我的 F6）。
   *
   * 修法：三个字段各自算分取最大。这里复刻那个形态：标题里只共享"工"，正文命中的是一大堆。
   */
  const body = `工程 ${'用法 同步 校验 计划 任务 变异 证据 链路 规则 坑 '.repeat(30)}`
  const dangerous = candidate({ id: 'x', title: '代码审查 Agent 的 8 条工程经验', contentMd: body })
  const query = '知识库 自动调用 会话 注入 计划 任务 变异 证据'
  const outcome = recallKnowledge({ query, candidates: [dangerous], now: NOW })
  assert.equal(outcome.matched, 1, '确实共享了若干字，所以算命中过')
  assert.equal(outcome.hits.length, 0, '但"标题里 1 个字 + 正文一大堆"必须挡下')
  const hit = scoreCandidate(dangerous, { terms: extractTerms(query), now: NOW })
  assert.ok((hit?.score ?? 1) < 0.2, `实测 ${hit?.score?.toFixed(3)}（旧写法约 0.5）`)
  // 反方向：同一篇长文，若提问**在标题上命中得多**，仍应正常召回（不能矫枉过正）
  const good = recallKnowledge({ query: '代码审查 工程经验', candidates: [dangerous], now: NOW })
  assert.equal(good.hits.length, 1, '标题真正相关时照样命中')
})

test('阈值是**严格大于**：分数正好等于 minScore 不算命中', () => {
  /**
   * 边界必须有断言守着，否则"改成 `>=`"这种一行改动没人拦得住
   * （反向探针实测过：改完三个测试文件全绿）。
   * 把 `minScore` 显式设成那个分数本身，两边各偏一点点 → 只有严格大的进来。
   */
  const at = 0.55 * (2 / 3) // '盘符' 查标题 '盘符'：0.55 × 2/3 × 1
  const exact = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'a', title: '盘符' })], minScore: at, now: NOW })
  assert.equal(exact.matched, 1)
  assert.equal(exact.hits.length, 0, '正好等于阈值 → 不算命中')
  // 提示档的判据同样是**严格大于下界**：分数 0.367 > hintScore 0.20 → 值得提一行
  assert.equal(exact.nearMisses.length, 1, '没到注入闸门，但够得上提示档')
  assert.equal(exact.droppedByScore, 0, '提示档不再计入"被阈值挡下"')

  // 把提示档也关掉（hintScore = minScore）→ 才真正落到 droppedByScore
  const noHint = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'a', title: '盘符' })], minScore: at, hintScore: at, now: NOW })
  assert.equal(noHint.nearMisses.length, 0, 'hintScore == minScore 时提示档为空')
  assert.equal(noHint.droppedByScore, 1, '这时才算被挡下')

  const above = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'a', title: '盘符' })], minScore: at - 0.001, now: NOW })
  assert.equal(above.hits.length, 1, '略高于阈值 → 命中')
})

test('多句 query 合并：**分句检索**才算得准，拼成一句会把最相关的条目淹掉', () => {  /**
   * 这是 `prime`（开工前用「任务标题 + 任务描述」两次检索）的**纯函数防线**，
   * 也是实测踩过的坑：拼成一句时覆盖率的分母翻倍，最相关那条从 0.55 掉到 0.33。
   *
   * ⚠️ 构造要**刻意**：必须让"某一句话单独命中标题"，拼起来才看得出差异
   * （第一版用的两句都命中不深，拆/合都过阈值，于是断言恒真、探针 M13 全绿）。
   */
  const entry = { id: 'k', kindCode: 'lesson', title: '盘符根目录的坑', contentMd: '', tags: [], sourceTaskId: null, sourceSessionId: null, sourceReviewId: null, fileLink: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }
  const title = '修复选择文件出不了 C 盘'
  const description = '盘符 根目录'

  const split = mergeRecallOutcomes([
    { query: title, outcome: recallKnowledge({ query: title, candidates: [{ entry, fromTask: true }], now: NOW }) },
    { query: description, outcome: recallKnowledge({ query: description, candidates: [{ entry, fromTask: true }], now: NOW }) },
  ])
  const joined = recallKnowledge({ query: `${title} ${description}`, candidates: [{ entry, fromTask: true }], now: NOW })

  assert.equal(split.hits.length, 1, '分句检索能带出最相关的那条')
  assert.ok(split.hits[0].score > RECALL_DEFAULTS.minScore, `分句：实测 ${split.hits[0].score.toFixed(3)}`)
  assert.equal(split.hits[0].query, description, '要如实标出是哪句话带出来的')
  assert.ok(joined.hits.length === 0 || joined.hits[0].score < split.hits[0].score, '拼成一句更差（分母被稀释）')
})

test('合并按 id 去重并保留更高的分（同一篇被两句各算一次会让账虚高一倍）', () => {
  const entry = { id: 'k', kindCode: 'lesson', title: '盘符根目录的坑', contentMd: '', tags: [], sourceTaskId: null, sourceSessionId: null, sourceReviewId: null, fileLink: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }
  const weak = recallKnowledge({ query: '盘符', candidates: [{ entry, fromTask: false }], now: NOW })
  const strong = recallKnowledge({ query: '盘符根目录的坑', candidates: [{ entry, fromTask: false }], now: NOW })
  assert.ok(strong.hits[0].score > weak.hits[0].score, '前置：后者分更高')
  const merged = mergeRecallOutcomes([{ query: '盘符', outcome: weak }, { query: '盘符根目录的坑', outcome: strong }])
  assert.equal(merged.hits.length, 1, '同一条只出现一次')
  assert.equal(merged.hits[0].score, strong.hits[0].score, '保留更高的那份')
  assert.equal(merged.hits[0].query, '盘符根目录的坑')
  assert.equal(merged.matched, 1, 'matched 不能同一篇算两次')
})

test('合并保留**逐句**的 query 归属：拼成一句会让"是哪句话带出来的"失真', () => {
  const entry = { id: 'k', kindCode: 'lesson', title: '盘符根目录的坑', contentMd: '', tags: [], sourceTaskId: null, sourceSessionId: null, sourceReviewId: null, fileLink: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }
  const merged = mergeRecallOutcomes([
    { query: '任务标题甲', outcome: recallKnowledge({ query: '任务标题甲', candidates: [{ entry, fromTask: false }], now: NOW }) },
    { query: '盘符根目录', outcome: recallKnowledge({ query: '盘符根目录', candidates: [{ entry, fromTask: false }], now: NOW }) },
  ])
  assert.equal(merged.hits.length, 1)
  assert.equal(merged.hits[0].query, '盘符根目录', '要标出真正带出它的那一句，而不是第 1 句')
  assert.match(merged.query, /任务标题甲 ／ 盘符根目录/, '整体 query 仍要把所有句子列全，便于回看')
})

test('缺省阈值与上限是唯一来源（改这里必须连带改测试，防止悄悄放宽）', () => {
  assert.equal(RECALL_DEFAULTS.minScore, 0.34)
  assert.equal(RECALL_DEFAULTS.maxEntries, 3)
})

/**
 * v1.15.5：展示相关度归一化（用户 2026-09-17 的疑问 —— "团队记忆那边 0.8~0.99，
 * 这边怎么这么低"）。原因是两边**分母不同**：团队记忆显示 `raw/(1+raw)`（raw 无上界），
 * 本仓显示有界原始分（上限 = 标题权重 0.55）。现在展示层统一除以 0.55。
 */
test('相关度归一化：原始分上限 0.55 → 展示 1.00，两个口径可互相换算', () => {
  assert.equal(RELEVANCE_CEILING, 0.55, '上限必须是标题权重（权重表变了这里要跟着变）')
  assert.equal(relevanceOf(0.55), 1, '标题档满分 → 相关度 1.00（不再是 0.55 的天花板）')
  assert.equal(relevanceOf(0.45), 0.45 / 0.55, '标签档满分 → 0.82')
  assert.equal(relevanceOf(0.25), 0.25 / 0.55, '正文档满分 → 0.45')
  assert.equal(relevanceOf(0), 0)
  assert.equal(relevanceOf(2), 1, '越界要夹到 1（不能出现 1.00 以上的"相关度"）')
  assert.ok(relevanceOf(0.52) > relevanceOf(0.4), '单调：分高的相关度不会更低')
  // 阈值在两种口径下必须指向同一件事（换算可逆）
  assert.ok(Math.abs(scoreFromRelevance(relevanceOf(RECALL_DEFAULTS.minScore)) - RECALL_DEFAULTS.minScore) < 1e-12)
  assert.equal(formatRelevance(RECALL_DEFAULTS.minScore), '0.62', '阈值换算成展示口径是 0.62，不是 0.34')
})

test('命中同时带原始分与展示相关度，注入文案只露归一化那个', () => {
  const outcome = recallKnowledge({ query: '盘符根', candidates: [candidate({ id: 'k-1', title: '盘符根' })], now: NOW })
  const hit = outcome.hits[0]
  assert.ok(hit !== undefined)
  assert.equal(hit.score, 0.55, '内部原始分不动（阈值与排序靠它）')
  assert.equal(hit.relevance, 1, '标题档满分 → 展示 1.00')
  const text = formatRecallText(outcome)
  assert.match(text, /相关度 1\.00/, '注入文本用归一化口径')
  assert.doesNotMatch(text, /相关度 0\.55/, '展示层不许把内部原始分露出去（会再被当成"低分"）')
  assert.match(text, /完整 uuid/, '要写清"按 id 取全文"用的是完整 uuid')
  assert.match(text, /workbench_search_knowledge/, '并给出取全文的工具名')
})

/**
 * v1.15.6 的 P1：**两档闸门**（提示档）。
 *
 * 背景是量出来的，不是想出来的：真实会话的 11 条提问里，正确答案普遍卡在阈值下面 0.01~0.03
 * （genui 渲染失败 0.327 / 紧缩场时序控制器 0.309 / Windows计划任务 0.324，阈值 0.34），
 * 而 top-1 排序**全是对的**。直接降阈值不行 —— 同批数据里那条泛化标题对一句闲聊也有 0.338。
 *
 * 所以闸门不降，差一点点的改成**一行提示**（约 90 字符 vs 完整块约 1000 字符），
 * 并且提示必须**看起来就不像已确认的知识**：不给摘要、不给分类、明说"未达注入闸门"。
 */
test('P1 两档闸门：差一点点的进 nearMisses（不注入完整块），更低的才算被挡下', () => {
  const cand = candidate({ id: 'mid', title: '盘符' })
  // '盘符' 查标题 '盘符' = 0.55 × 2/3 × 1 = 0.3667
  const mid = recallKnowledge({ query: '盘符', candidates: [cand], now: NOW })
  assert.equal(mid.hits.length, 1, '0.367 > 0.34 → 完整命中')

  // 把注入闸门抬到 0.40：同一个分数落进 [0.20, 0.40) → 提示档
  const hinted = recallKnowledge({ query: '盘符', candidates: [cand], minScore: 0.4, now: NOW })
  assert.equal(hinted.hits.length, 0, '没过注入闸门 → 不进 hits')
  assert.equal(hinted.nearMisses.length, 1, '但落在提示档里 → 值得提一行')
  assert.equal(hinted.nearMisses[0].id, 'mid')
  assert.equal(hinted.droppedByScore, 0, '提示档不算被挡下（它确实留了一行痕迹）')

  // 抬到 0.50：分数 0.367 < hintScore? 不 —— hintScore 仍是 0.20，所以**还是提示档**。
  // 真正该被完全丢掉的是"连提示档都没够到"的（这里用 hintScore 显式抬高来构造）
  const dropped = recallKnowledge({ query: '盘符', candidates: [cand], minScore: 0.4, hintScore: 0.4, now: NOW })
  assert.equal(dropped.nearMisses.length, 0)
  assert.equal(dropped.droppedByScore, 1, '连提示档都没够到 → 才算被挡下')
})

test('P1 提示行：只给 id + 标题 + 相关度，明确"未达闸门"，且绝不给摘要', () => {
  const long = '这是一段很长的正文'.repeat(20)
  const out = recallKnowledge({
    query: '盘符',
    candidates: [candidate({ id: 'k-1', title: '盘符根目录的坑', contentMd: long })],
    minScore: 0.4,
    now: NOW,
  })
  assert.equal(out.nearMisses.length, 1)
  const text = formatHintText(out)
  assert.match(text, /\[k-1\]/, '给 id（模型据此取全文）')
  assert.match(text, /盘符根目录的坑/, '给标题')
  assert.match(text, /未达注入闸门/, '必须自报"没到闸门"，否则模型会把提示当事实用')
  assert.match(text, /可能/, '语气的落点在"可能相关"上')
  assert.doesNotMatch(text, /摘要：/, '提示行绝不带摘要（那是完整块的待遇）')
  assert.ok(text.length < 200, `提示行必须短（实测 ${text.length} 字符，完整块约 1000）`)
  // 没有提示 → 空串（**不插占位**这条纪律对提示档同样成立）
  assert.equal(formatHintText({ ...out, nearMisses: [] }), '')
})

test('P1 提示档也守条数上限与会话去重（不重复提示同一条）', () => {
  const many = Array.from({ length: 6 }, (_, i) => candidate({ id: `m${i}`, title: '盘符' }))
  const out = recallKnowledge({ query: '盘符', candidates: many, minScore: 0.4, now: NOW })
  assert.equal(out.nearMisses.length, RECALL_DEFAULTS.maxHints, `提示最多 ${RECALL_DEFAULTS.maxHints} 条`)
  const excluded = recallKnowledge({ query: '盘符', candidates: many, minScore: 0.4, excludeIds: ['m0'], now: NOW })
  assert.ok(!excluded.nearMisses.some((hit) => hit.id === 'm0'), '已注入过的条目不再当"差一点点"')
})

test('P1 合并多句 query 时提示档也要按 id 去重、取高分、守上限', () => {
  const a = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'x', title: '盘符' })], minScore: 0.4, now: NOW })
  const b = recallKnowledge({ query: '盘符迁移', candidates: [candidate({ id: 'x', title: '盘符迁移' })], minScore: 0.9, now: NOW })
  const merged = mergeRecallOutcomes([{ query: '盘符', outcome: a }, { query: '盘符迁移', outcome: b }])
  assert.equal(merged.nearMisses.length, 1, '同一条只出现一次')
  assert.equal(merged.nearMisses[0].score, Math.max(a.nearMisses[0].score, b.nearMisses[0].score), '取更高的那份')
})

test('P1 willInject：有提示也算"会在会话里留下东西"（否则日志与事实对不上）', () => {
  const hit = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'a', title: '盘符' })], now: NOW })
  const hint = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'a', title: '盘符' })], minScore: 0.4, now: NOW })
  const none = recallKnowledge({ query: '盘符', candidates: [candidate({ id: 'a', title: '盘符' })], minScore: 0.4, hintScore: 0.4, now: NOW })
  assert.equal(willInject(hit), true)
  assert.equal(willInject(hint), true, '只有提示也必须算"会留下东西"')
  assert.equal(willInject(none), false, '两级都没够到 → 真的什么都不插（不占位）')
})


