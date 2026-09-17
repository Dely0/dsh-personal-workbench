/**
 * 回归：**知识库自动召回的四条行为约定**（v1.15.3）。
 *
 * 这一层测的是"接线"而不是"打分"（打分在 `knowledgeRecallPure.test.mjs`）：
 *
 * | 约定 | 为什么必须锁 |
 * |---|---|
 * | 关掉之后**不再注入** | 需求原文"关闭后不再注入"。只测"开关写进了 meta"是不够的 —— 真正会犯的错是"开关关了、pendingText 还在注入" |
 * | 同一回合内文本稳定 | 每回合改写提示前缀 = DeepSeek 前缀缓存全废（团队记忆写进代码注释的硬约束） |
 * | 注入过的条目不再重复注入 | 噪声控制的唯一机制；没有它，同一个任务连开 10 个回合就会看到同一批条目 10 次 |
 * | 本任务/任务树优先于全库 | 需求原文"优先本任务 / 本任务树，再扩到全局" |
 *
 * 判据全部落在**可观测的结论**上（注入文本、召回日志行、开关状态），
 * 不靠"读代码看得出来"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { createKnowledge, createTask } from '../lib/db/repo.js'
import { linkTaskSession } from '../lib/db/repo/task-sessions.js'
import { KnowledgeRecallManager } from '../lib/knowledge-recall.js'
import { listRecallLog, readSessionOverrides } from '../lib/knowledge-recall-log.js'
import { extractTerms, scoreCandidate } from '../lib/shared/knowledgeRecall.js'

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-knowledge-recall-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  seedDictionaries(db)
  try { return run(db) } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
}

/** 建一条任务（测试只关心标题与父子关系，其余字段给字典里的合法值）。 */
function task(db, over = {}) {
  return createTask(db, { typeCode: 'code_impl', priorityCode: 'p2', ...over })
}

test('开工前召回：会话挂到任务上 → 用任务标题召回本任务的知识', () => {
  withDb((db) => {
    const t = task(db, { title: '修复选择文件出不了 C 盘', description: '报错在本地目录选择弹窗里；盘符 根目录 的 parent 是 null，上级按钮变灰。' })
    createKnowledge(db, { title: '盘符根目录 parent 为 null 的坑', contentMd: 'dirname("C:\\") === "C:\\"', tags: ['盘符'], sourceTaskId: t.id })
    createKnowledge(db, { title: '完全无关的条目', contentMd: '与选择文件没关系' })
    /**
     * 噪声控制的判据是**排序与额度**，不是"池子里只有一条"。
     * 这里给 `maxEntries: 1`，模拟"每回合只带一条"的紧额度：
     * 带出来的必须是本任务那条最相关的，而不是条数凑巧。
     */
    linkTaskSession(db, { taskId: t.id, sessionId: 'sess-1', roleCode: 'execute' })

    const manager = new KnowledgeRecallManager(db, { log: () => {}, maxEntries: 1 })
    const outcome = manager.prime('sess-1', undefined)
    assert.ok(outcome !== undefined, '关联到任务 + 有标题 → 必须发生一次开工前召回')
    assert.equal(outcome.hits.length, 1, '额度 1：只带最相关的一条')
    assert.equal(outcome.hits[0].title, '盘符根目录 parent 为 null 的坑')
    assert.equal(outcome.hits[0].fromTask, true, '本任务的条目必须标成本任务')
    assert.ok(outcome.hits[0].score > 0.34, `最相关那条要过阈值，实测 ${outcome.hits[0].score}`)

    const text = manager.injectionFor('sess-1', 1)
    assert.match(text, /【工作台知识库】/)
    assert.match(text, /盘符根目录/, '注入文本要能看到命中了哪条')
    assert.doesNotMatch(text, /完全无关的条目/, '被额度截掉的条目不能出现在注入文本里')
    assert.equal(manager.injectionFor('sess-1', 1), text, '同一回合内必须返回同一份文本（保前缀缓存）')
  })
})

test('未关联任务时不编 query：不检索，交给引导层让模型主动查', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符的坑', contentMd: '盘符' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    assert.equal(manager.prime('sess-unknown', undefined), undefined)
    assert.equal(manager.injectionFor('sess-unknown', 1), '', '没有 query 就不该凭空注入')
    assert.equal(listRecallLog(db).length, 0, '连日志都不该写：这不是一次检索')
  })
})

test('关联到任务但一句 query 都没有时，同样不检索（"空提问"不能被写成"查过了"）', () => {
  withDb((db) => {
    // 任务只有描述、没有标题 → queries 为空 → 不检索
    const t = task(db, { title: '   ', description: '   ' })
    linkTaskSession(db, { taskId: t.id, sessionId: 'sess-empty', roleCode: 'execute' })
    createKnowledge(db, { title: '盘符的坑', contentMd: '盘符' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    assert.equal(manager.prime('sess-empty', undefined), undefined, '没有可检索的句子 → 不检索')
    assert.equal(listRecallLog(db).length, 0, '"没检索"绝不能留成一条"零命中"的日志')
  })
})

test('回合预取 → 下一回合注入；注入过的条目不再重复注入（噪声控制）', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const sid = 'sess-2'

    const first = manager.prefetch(sid, undefined, '盘符 根目录 文件选择')
    assert.equal(first.hits.length, 1)
    const text = manager.injectionFor(sid, 1)
    assert.match(text, /盘符根目录的坑/)

    // 同一个提问再来一回合：条目已在 seenIds 里 → 不再注入
    const second = manager.prefetch(sid, undefined, '盘符 根目录 文件选择')
    assert.equal(second.hits.length, 0)
    assert.equal(second.droppedAsSeen, 1, '被去重跳过的条数要能看出来')
    assert.equal(manager.injectionFor(sid, 2), '', '重复条目不该再占注入额度')
  })
})

test('关掉之后不再注入（含"已经算好但还没注入"的那一份）', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const sid = 'sess-3'
    manager.prefetch(sid, undefined, '盘符 根目录 文件选择')
    assert.equal(manager.setSessionEnabled(sid, 'off'), false)
    assert.equal(manager.injectionFor(sid, 1), '', '关掉后连算好的 pending 也不能注入')
    assert.equal(manager.prefetch(sid, undefined, '盘符 根目录 文件选择'), undefined, '关掉后不再检索')
    assert.deepEqual(readSessionOverrides(db)[sid], 'off', '单会话开关要持久化（重启后仍生效）')

    assert.equal(manager.setSessionEnabled(sid, 'on'), true)
    const back = manager.prefetch(sid, undefined, '盘符 根目录 文件选择')
    assert.equal(back.hits.length, 1, '重新打开后恢复自动召回')
  })
})

test('全局开关：关掉后所有会话都不自动召回；工具路径不受影响（仍可手动查）', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    manager.setAutoEnabled(false)
    assert.equal(manager.autoEnabled(), false)
    assert.equal(manager.prefetch('sess-4', undefined, '盘符'), undefined)
    assert.equal(manager.sessionEnabled('sess-4'), false)

    // 工具路径不经过 sessionEnabled：显式查必须永远可用（这是"关掉自动"与"不能查"的分界）
    const hits = manager.candidates(null).length
    assert.equal(hits, 1, '候选集不受开关影响 —— 显式检索照常工作')
    manager.setAutoEnabled(true)
    assert.equal(manager.sessionEnabled('sess-4'), true)
  })
})

test('单会话覆盖优先于全局：全局关 + 本会话显式开 → 本会话生效', () => {
  withDb((db) => {
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    manager.setAutoEnabled(false)
    manager.setSessionEnabled('sess-5', 'on')
    assert.equal(manager.sessionEnabled('sess-5'), true)
    assert.equal(manager.sessionEnabled('sess-6'), false, '其他会话仍跟随全局')
    manager.setSessionEnabled('sess-5', 'clear')
    assert.equal(manager.sessionEnabled('sess-5'), false, 'clear 回到跟随全局')
  })
})

test('本任务树优先：父任务会话能看到子任务沉淀的知识', () => {
  withDb((db) => {
    const parent = task(db, { title: '工作台 v1.15.3' })
    const child = task(db, { title: '知识库自动调用', parentId: parent.id })
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null', sourceTaskId: child.id })
    linkTaskSession(db, { taskId: parent.id, sessionId: 'sess-parent', roleCode: 'execute' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    // 父会话的 query 用任务标题（开工前），这里直接问盘符验证"树内可见"
    const outcome = manager.prefetch('sess-parent', undefined, '盘符根目录')
    assert.equal(outcome.hits.length, 1)
    assert.equal(outcome.hits[0].fromTask, true, '子任务的知识对父会话算"本任务"')
  })
})

test('开工前必须**分句**检索：标题与描述拼成一句会把最相关的条目稀释掉', () => {
  withDb((db) => {
    /**
     * 这是"分句 vs 拼句"的**行为级**防线（纯函数那版只验了合并函数本身）。
     * 构造刻意让「任务标题」与知识标题几乎不共享字，而「任务描述」高度重合 ——
     * 拼成一句时覆盖率的分母翻倍，分数会掉到阈值以下。
     */
    const t = task(db, { title: '修复选择文件出不了 C 盘', description: '盘符 根目录' })
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: 'x', sourceTaskId: t.id })
    linkTaskSession(db, { taskId: t.id, sessionId: 'sess-split', roleCode: 'execute' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const outcome = manager.prime('sess-split', undefined)
    assert.equal(outcome?.hits.length, 1, '分句检索能带出最相关的那条')
    assert.ok((outcome?.hits[0].score ?? 0) > 0.34, `实测 ${outcome?.hits[0].score}`)
    assert.equal(outcome?.hits[0].query, '盘符 根目录', '要标出真正带出它的那一句（描述）')
    // 对照：把两句拼成一句会差多少（同一份数据，同一个打分函数）
    const joined = scoreCandidate(
      { entry: { id: 'k', kindCode: 'lesson', title: '盘符根目录的坑', contentMd: 'x', tags: [], sourceTaskId: t.id, sourceSessionId: null, sourceReviewId: null, fileLink: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }, fromTask: true },
      { terms: extractTerms('修复选择文件出不了 C 盘 盘符 根目录'), now: new Date('2026-09-17T00:00:00.000Z') },
    )
    assert.ok((joined?.score ?? 1) < (outcome?.hits[0].score ?? 0), `拼成一句必须更差：${joined?.score} vs ${outcome?.hits[0].score}`)
  })
})

test('关掉开关后清空"已算好但还没注入"的那一份（PendingInjection 必须一起丢）', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const sid = 'sess-off-pending'
    /**
     * ⚠️ 必须用**新的管理器实例**：`injectionFor` 会把 pending 消费掉，
     * 消费过之后再关开关，就分不清"没注入"是因为开关还是因为没内容了
     * （反向探针实测过：在同一个实例上接着测，把开关判据整个删掉也全绿）。
     */
    /** 同一个实例：`prefetch` 装满 pending → 关掉开关 → 注入必须为空。 */
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    manager.prefetch(sid, undefined, '盘符 根目录')
    manager.setSessionEnabled(sid, 'off')
    assert.equal(manager.injectionFor(sid, 0), '', '关掉时那一份 pending 不得注入')
    manager.setSessionEnabled(sid, 'on')
    assert.equal(manager.injectionFor(sid, 1), '', '重新打开也不会凭空注入旧内容（要等下一次检索）')
  })
})

test('候选集要覆盖全库：超过 500 条时不得静默少召回（v1.15.4 修的自查 F3）', () => {
  withDb((db) => {
    /**
     * 原先写死 `limit: 500` 而仓储层把上限也夹在 500 → 第 501 条起永远召不回来，
     * 且**一个字都不说**（静默截断是本仓明令禁止的一类）。
     */
    const TOTAL = 523
    for (let i = 0; i < TOTAL; i += 1) createKnowledge(db, { title: `批量条目 ${i} 探针主题`, contentMd: `探针主题 内容 ${i}` })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    assert.equal(manager.candidates(null).length, TOTAL, '候选集必须是全量，不是 500')
    const deep = manager.recallToText({ taskId: null, query: '批量条目 探针主题' })
    assert.ok(deep.hits.length > 0, '批量条目必须可召回')
  })
})

test('引用回报要能回填**最旧**那一行（v1.15.4 修的自查 F5：长会话 >200 行）', () => {
  withDb((db) => {
    /**
     * 原实现只扫"最近 200 行"：一个长会话很容易超过 200 行，旧行上的引用被静默丢弃，
     * 工具还会回一句"没有匹配到本会话的召回记录" —— 把"日志没扫到"说成"你没查过"。
     * 断言必须落在**最旧那一行**上，否则会被"新行也有这个 id"糊弄过去。
     */
    const entry = createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const sid = 'sess-deep'
    manager.prefetch(sid, undefined, '盘符根目录')
    for (let i = 0; i < 250; i += 1) {
      manager.logSearch({ sessionId: sid, taskId: null, query: `无关噪声 ${i}`, terms: ['噪'], hits: [] })
    }
    const rows = listRecallLog(db, { sessionId: sid, limit: 500 })
    assert.ok(rows.length > 200, `前置：行数要超过 200，实测 ${rows.length}`)
    assert.equal(rows[rows.length - 1].hits[0].id, entry.id, '前置：最旧那行确实带出过该条目')

    const reported = manager.reportUsage(sid, [entry.id])
    assert.ok(reported.updated > 0, '回报必须落地')
    const refreshed = listRecallLog(db, { sessionId: sid, limit: 500 })
    assert.deepEqual(refreshed[refreshed.length - 1].citedIds, [entry.id], '最旧那行的引用也要回填')
  })
})

test('召回日志：关键词 / 命中 / 是否注入 / 跳过原因 / 引用回报全部落库', () => {
  withDb((db) => {
    const entry = createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    manager.prefetch('sess-7', undefined, '盘符 根目录 文件选择')
    manager.prefetch('sess-7', undefined, '好的') // 琐碎 → 跳过但留痕

    const log = listRecallLog(db, { sessionId: 'sess-7' })
    assert.equal(log.length, 2, '跳过也要留一行（"没检索"与"检索了零命中"必须分开）')
    const skipped = log.find((row) => row.skippedReason !== null)
    assert.equal(skipped?.skippedReason, '琐碎消息')
    assert.equal(skipped?.injected, false)
    const hitRow = log.find((row) => row.skippedReason === null)
    assert.equal(hitRow?.injected, true)
    assert.deepEqual(hitRow?.terms, ['盘', '符', '根', '目', '录', '文', '件', '选', '择'])
    assert.equal(hitRow?.hits[0].id, entry.id)

    const reported = manager.reportUsage('sess-7', [entry.id])
    // 命中那一行必须记上引用；跳过那一行（没注入任何条目）不该被算成"引用过"
    assert.equal(reported.updated, 1, '引用要落在真正注入过的那条召回记录上')
    const refreshed = listRecallLog(db, { sessionId: 'sess-7' })
    assert.deepEqual(refreshed.find((row) => row.injected)?.citedIds, [entry.id])
    assert.deepEqual(refreshed.find((row) => row.skippedReason !== null)?.citedIds, [], '跳过的那行不该被标记引用')
    assert.deepEqual(reported.unknown, [])
    // 幂等：再回报一次仍然是 1（不会因为"改了几行 = 0"而谎报失败）
    assert.equal(manager.reportUsage('sess-7', [entry.id]).updated, 1, '重复回报是正常情况，不是失败')
  })
})

test('引用回报：不存在的 id 要如实报告（不静默吞掉）', () => {
  withDb((db) => {
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const result = manager.reportUsage('sess-8', ['nope-1', 'nope-2'])
    assert.deepEqual(result.unknown, ['nope-1', 'nope-2'])
    assert.equal(result.updated, 0)
  })
})

test('会话遗忘：销毁后状态清掉（长跑进程不能只涨不减）', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符的坑', contentMd: '盘符' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    // query 要与标题高度重合才过阈值（见 knowledgeRecallPure 的"相关性公式"那组测试）
    manager.prefetch('sess-9', undefined, '盘符的坑')
    assert.match(manager.injectionFor('sess-9', 1), /盘符的坑/)
    manager.forget('sess-9')
    assert.equal(manager.injectionFor('sess-9', 1), '', '销毁后不再注入')
  })
})

/**
 * v1.15.6 的 P1（两档闸门）在**接线层**的三条约定。
 *
 * 纯函数那层只能证明"分数落进提示档会进 nearMisses"；真正会犯的错在接线：
 * ① 提示算不算"注入过"（算错的后果是注入日志与实际不符）；
 * ② 提示会不会每回合重复刷（验收第 5 条要拦的"反复注入不相关条目"）；
 * ③ 提示过的条目将来真命中了，还能不能被完整注入（**不能被永久压制**）。
 */
test('P1 提示档：未达注入闸门时只留一行提示，且日志如实区分"提示"与"注入"', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    // 把注入闸门抬到 0.4，让 0.367 落进提示档（真实场景里阈值没动，这里是构造边界）
    const hinted = new KnowledgeRecallManager(db, { minScore: 0.4, log: () => {} })
    hinted.prefetch('sess-h1', undefined, '盘符')
    const text = hinted.injectionFor('sess-h1', 1)
    assert.match(text, /未达注入闸门/, '会话里要有那行提示')
    assert.match(text, /\[.{8}/, '提示里带 id，模型才能取全文')
    assert.doesNotMatch(text, /摘要：/, '提示行不给摘要（那是完整块的待遇）')

    // 注入日志必须区分两种情形：否则"注入知识 0 条"会让人以为什么都没发生
    const logs = hinted.drainLogs()
    assert.ok(logs.some((line) => /提示 1 行/.test(line)), `日志里要有"提示 1 行"：${logs.join(' | ')}`)
    assert.ok(!logs.some((line) => /注入知识 0 条/.test(line)), '不该出现"注入知识 0 条"这种自相矛盾的行')
    assert.ok(manager !== undefined)
  })
})

test('P1 提示档：同一条不会在同一会话里反复提示', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const manager = new KnowledgeRecallManager(db, { minScore: 0.4, log: () => {} })
    manager.prefetch('sess-h2', undefined, '盘符')
    assert.match(manager.injectionFor('sess-h2', 1), /未达注入闸门/, '第一回合给提示')
    // 第二回合再问同样的事：提示过的不再提示（噪声控制）
    manager.prefetch('sess-h2', undefined, '盘符')
    assert.equal(manager.injectionFor('sess-h2', 2), '', '同一会话里不重复提示同一条')
  })
})

test('P1 提示档：提示过的条目**将来真命中了仍然会被完整注入**（提示不等于已注入）', () => {
  withDb((db) => {
    const entry = createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    // 低闸门下先给一次提示
    const strict = new KnowledgeRecallManager(db, { minScore: 0.9, log: () => {} })
    strict.prefetch('sess-h3', undefined, '盘符')
    assert.match(strict.injectionFor('sess-h3', 1), /未达注入闸门/, '先只有提示')

    // 换成正常闸门、再问一次更精确的话 → 它应该作为**完整命中**注入
    const normal = new KnowledgeRecallManager(db, { log: () => {} })
    normal.prefetch('sess-h3', undefined, '盘符根目录的坑')
    const injected = normal.injectionFor('sess-h3', 1)
    assert.match(injected, new RegExp(entry.id.slice(0, 8)), '提示过的条目仍能被完整注入（不被永久压制）')
    assert.match(injected, /摘要：/, '这次是完整块（带摘要）')
  })
})

