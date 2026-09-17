/**
 * 回归：**钩子接线层**（v1.15.4）—— 这一层是上一版的盲区。
 *
 * ## 为什么必须单开一个文件
 *
 * v1.15.3 上线时 `pnpm test` **407/407 全绿**、变异探针 13/13 全红，
 * 但每回合自动召回**在生产里一次都没发生过**：`agent/turn-stopping` 读的是
 * `event.data.message`（真实是 `data` 本身就是消息）、`currentTurnOf` 读顶层 `event.turn`
 * （真实在 `data.turn.turn`）→ query 恒为空 → 早返回且不留日志（静默失效）。
 *
 * 我的旧测试只调 `manager.prefetch()`（绕过了事件解析），所以整条链路**没人守**。
 * 这个文件专门用**真实 `SessionEvent` 形状**驱动钩子，把"接线"本身钉住。
 *
 * 真实形状的权威依据：`@deepseek-ai/dsh-session` 事件表（`'user/message': UserMessage`、
 * `'turn/start': { turn: number }`）、宿主 `dsh-agent-loop` 读 `event.data`、
 * 以及 `dsh-team-memory` 的实测注释（从顶层读恒为 undefined，且**不报错**）。
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
import { listRecallLog } from '../lib/knowledge-recall-log.js'
import { installKnowledgeRecall, currentTurnOf, latestUserMessage, isUserAuthored, turnNumberOf } from '../lib/knowledge-recall.js'

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-knowledge-wiring-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  seedDictionaries(db)
  try { return run(db) } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
}

function task(db, over = {}) {
  return createTask(db, { typeCode: 'code_impl', priorityCode: 'p2', ...over })
}

/** 假 ctx：捕获 systemPrompt.context 的取值函数与事件监听器（与真宿主接口同形）。 */
function fakeCtx() {
  const listeners = new Map()
  const logs = []
  let contextText = () => ''
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    systemPrompt: {
      section: () => () => {},
      context: (spec) => { contextText = spec.text; return () => {} },
    },
    on: (name, fn) => { listeners.set(name, fn); return () => {} },
    get: () => undefined,
  }
  return { ctx, listeners, logs, contextText: (agent) => contextText({ agent }) }
}

/** 真实形状的事件序列：`data` 就是载荷本体。 */
function realEvents({ turn = 5, question = '盘符根目录', injectedText = null } = {}) {
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: { turn } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: question }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, time: 3, data: {} },
  ]
  if (injectedText !== null) {
    events.push({
      type: 'user/message', seq: 4, time: 4,
      data: { content: [{ type: 'text', text: injectedText }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } },
    })
  }
  return events
}

test('事件解包：真实形状（data 信封）下回合号读得出来，顶层形状也不崩', () => {
  assert.equal(turnNumberOf({ type: 'turn/start', data: { turn: { turn: 5 } } }), 5, 'data.turn.turn')
  assert.equal(turnNumberOf({ type: 'turn/start', data: { turn: 7 } }), 7, 'data.turn 是数字')
  assert.equal(turnNumberOf({ type: 'turn/start', turn: 3 }), 3, '已解包的历史形状')
  assert.equal(turnNumberOf({ type: 'turn/start' }), 0, '什么都没有 → 0，不抛')

  const agent = { session: { snapshotEvents: () => realEvents({ turn: 12 }) } }
  assert.equal(currentTurnOf(agent), 12, 'currentTurnOf 必须读出真实回合号（v1.15.3 恒为 0）')
  assert.equal(currentTurnOf({ session: { snapshotEvents: () => [] } }), 0, '没有事件 → 0')
})

test('只认用户本人写的消息：插件注入的快照不得当成本回合提问', () => {
  assert.equal(isUserAuthored({ content: [], source: { kind: 'user' } }), true)
  assert.equal(isUserAuthored({ content: [] }), true, '真实用户消息没有 source 字段')
  assert.equal(isUserAuthored({ content: [], source: { kind: 'plugin', plugin: 'x' } }), false)
  assert.equal(isUserAuthored({ content: [], source: { kind: 'tool' } }), false)

  // 最后一条 user/message 是插件快照 → 必须回溯到真正的那句提问
  const events = realEvents({ question: '盘符根目录', injectedText: '【运行时上下文快照】与提问无关' })
  const picked = latestUserMessage(events)
  assert.deepEqual(picked.content.map((b) => b.text), ['盘符根目录'], '要跳过注入的快照')
  assert.equal(latestUserMessage(realEvents({ injectedText: '快照' })).content[0].text, '盘符根目录')
  assert.equal(latestUserMessage([]), undefined)
})

test('装配期：真实事件形状下必须真的发生一次召回，且查询是用户那句话', () => {
  withDb((db) => {
    const t = task(db, { title: '修复选择文件出不了 C 盘' })
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null', sourceTaskId: t.id })
    linkTaskSession(db, { taskId: t.id, sessionId: 'sess-turn', roleCode: 'execute' })
    const { ctx, listeners, contextText } = fakeCtx()
    installKnowledgeRecall(ctx, db, { log: () => {} })

    const agent = { session: { header: { id: 'sess-turn', cwd: 'E:\\Code\\x' }, snapshotEvents: () => realEvents({ question: '盘符根目录 出不去', injectedText: '【工作台知识库】上一回合注入的内容' }) } }
    // P1：检索发生在**装配期**（用户消息已经在会话事件里），不再延后到回合收尾
    const text = contextText(agent)
    assert.match(text, /【工作台知识库】/, 'v1.15.3 这里恒为空（静默失效）；P1 起装配期就能检索')
    assert.match(text, /盘符根目录的坑/)

    const rows = listRecallLog(db, { sessionId: 'sess-turn' })
    const turnRows = rows.filter((row) => row.trigger === 'turn')
    assert.equal(turnRows.length, 1, 'v1.15.3 这里恒为 0 行（静默失效）')
    assert.match(turnRows[0].query, /盘符根目录/, '查询必须是用户提问')
    assert.doesNotMatch(turnRows[0].query, /工作台知识库/, '不得把注入的快照当成提问（自激）')

    // 回合收尾：这一回合已经检索过了 → 不得再记一笔"未纳入检索"，也不得重复检索
    listeners.get('agent/turn-stopping')({ agent, turn: 1, signal: {} })
    const after = listRecallLog(db, { sessionId: 'sess-turn' }).filter((row) => row.trigger === 'turn')
    assert.equal(after.length, 1, '同一回合不得重复记账（一回合一句提问 = 一行账）')
  })
})

/**
 * ## P1 的真问题：**静默漏检索**（不是打分问题）
 *
 * 实测（turn 16）：那一轮里有**两条用户本人消息** —— 用户的实质提问，以及随后的「停」。
 * 回合收尾钩子只取**最后一条**（= 「停」），它被 `isTrivialQuery` 判为琐碎 →
 * 直接跳过检索，那句实质提问**从未被检索过**；而库里已有一条对它有 0.72 相关度的条目
 * （远高于 0.34 闸门，本应完整块注入）。落库只剩一行 `「停」`，账上看不出丢了什么。
 *
 * 两个修法都在这一条测试里钉住：
 * 1. **当轮检索**：装配期用**本回合的用户消息**检索（顺序是 `turn/start` → `user/message` → `request/header`，
 *    所以装配期消息已经在事件里）；
 * 2. **本回合每一条用户消息都要有交代**（不能只看最后一条）。
 */
test('P1 本回合两条用户消息：实质提问必须被检索（只取最后一条 = 静默丢件）', () => {
  withDb((db) => {
    const t = task(db, { title: '修复选择文件出不了 C 盘' })
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null', sourceTaskId: t.id })
    linkTaskSession(db, { taskId: t.id, sessionId: 'sess-two', roleCode: 'execute' })
    const { ctx, listeners, contextText } = fakeCtx()
    installKnowledgeRecall(ctx, db, { log: () => {} })

    const events = [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: { turn: 16 } } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '盘符根目录 出不去怎么办' }], source: { kind: 'user' } } },
      // 真实实测里的第二条：一句被 `isTrivialQuery` 判为琐碎的插话
      { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '停' }], source: { kind: 'user' } } },
      { type: 'request/header', seq: 4, time: 4, data: {} },
    ]
    const agent = { session: { header: { id: 'sess-two', cwd: 'E:\\Code\\x' }, snapshotEvents: () => events } }

    const text = contextText(agent)
    assert.match(text, /【工作台知识库】/, '装配期看不到本回合的提问 → 那句实质提问永远没被检索')
    assert.match(text, /盘符根目录的坑/, '实质提问必须真的召回条目')

    const turnRows = listRecallLog(db, { sessionId: 'sess-two' }).filter((row) => row.trigger === 'turn')
    const queries = turnRows.map((row) => row.query)
    assert.ok(queries.some((q) => /盘符根目录/.test(q)), `日志必须有实质提问那一行：${queries.join(' | ')}`)
    assert.ok(queries.some((q) => /停/.test(q)), `琐碎消息也要有交代（跳过也要留痕）：${queries.join(' | ')}`)
    assert.equal(turnRows.length, 2, '两条用户消息 = 两行账（一条也不能静默消失）')

    // 回合收尾：本回合的用户消息都已经纳入检索 → 不得再补一笔"未纳入检索"
    listeners.get('agent/turn-stopping')({ agent, turn: 16, signal: {} })
    assert.equal(listRecallLog(db, { sessionId: 'sess-two' }).filter((row) => row.trigger === 'turn').length, 2)
  })
})

test('P1 同一回合内文本稳定（保前缀缓存），且不重复记账', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const { ctx, contextText } = fakeCtx()
    installKnowledgeRecall(ctx, db, { log: () => {} })
    const agent = { session: { header: { id: 'sess-stable', cwd: 'E:\\Code\\x' }, snapshotEvents: () => realEvents({ turn: 3, question: '盘符根目录 出不去' }) } }
    const first = contextText(agent)
    assert.match(first, /【工作台知识库】/)
    assert.equal(contextText(agent), first, '同一回合内必须返回同一份文本（前缀缓存）')
    assert.equal(contextText(agent), first, '再装配几次也一样')
    assert.equal(listRecallLog(db, { sessionId: 'sess-stable' }).length, 1, '装配多次只算一次检索（账不能被装配次数放大）')
  })
})

/**
 * 第二个同类发现（算了但没送达）：`state.pendingText` 会被后来的 `prime` / `prefetch`
 * **直接覆盖**。实测 turn 15（`#27 10:02:41 [turn] injected=1 matched=61`）算出的结果
 * 被 10:04:33 的 `session_start` prime（`#29`）覆盖 → **从未送达**。
 * 修法：开工前那份**挂起**（`primeOutcome`），装配期与当轮结果**合并**（不是覆盖）。
 */
test('P1 后到的开工前检索不得覆盖已算好的当轮结果（算了就要送达）', () => {
  withDb((db) => {
    // 任务标题与知识库毫无关系 → 开工前那次零命中（覆盖成空串时最刺眼）
    const t = task(db, { title: '这个标题与知识库毫无关系' })
    linkTaskSession(db, { taskId: t.id, sessionId: 'sess-merge', roleCode: 'execute' })
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null', sourceTaskId: t.id })
    const { ctx } = fakeCtx()
    const manager = installKnowledgeRecall(ctx, db, { log: () => {} })

    // 当轮检索先算出了「盘符根目录的坑」
    manager.prefetch('sess-merge', undefined, '盘符根目录 出不去')
    // 随后（晚到的）开工前检索零命中 —— 老实现会在这里把算好的那一份覆盖成空串
    manager.prime('sess-merge', undefined)
    const text = manager.injectionFor('sess-merge', 1)
    assert.match(text, /盘符根目录的坑/, '算了却没送达 = 静默丢件（实测 turn 15 就是这样丢的）')
  })
})

test('P1 开工前那份与当轮结果要合并送达（不是二选一）', () => {
  withDb((db) => {
    const t = task(db, { title: '盘符根目录的坑' })
    linkTaskSession(db, { taskId: t.id, sessionId: 'sess-both', roleCode: 'execute' })
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null', sourceTaskId: t.id })
    createKnowledge(db, { title: '时序控制器操作 SOP', contentMd: '时序控制器 操作流程' })
    const { ctx, contextText } = fakeCtx()
    installKnowledgeRecall(ctx, db, { log: () => {} })
    // 开工前（标题）命中第一条；当轮提问命中第二条 → 两条都要在
    const agent = { session: { header: { id: 'sess-both', cwd: 'E:\\Code\\x' }, snapshotEvents: () => realEvents({ turn: 4, question: '时序控制器 操作流程 是什么' }) } }
    const text = contextText(agent)
    assert.match(text, /盘符根目录的坑/, '开工前那份不能被当轮结果覆盖')
    assert.match(text, /时序控制器操作 SOP/, '当轮检索到的也要在')
  })
})

/**
 * 「静默丢件」是本仓明令禁止的一类：**该做的事没做，账上看不出来**。
 * 所以任何"有用户消息但没被纳入检索"的情形都必须留下可查的一行。
 */
test('P1 未纳入检索要留痕：装配期没检索过 → 回合收尾必须补一行（不静默）', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const { ctx, listeners } = fakeCtx()
    installKnowledgeRecall(ctx, db, { log: () => {} })
    const agent = { session: { header: { id: 'sess-miss', cwd: 'E:\\Code\\x' }, snapshotEvents: () => realEvents({ turn: 9, question: '盘符根目录 出不去' }) } }
    // 刻意**不调用**装配期回调（模拟装配没发生 / 被中断）
    listeners.get('agent/turn-stopping')({ agent, turn: 9, signal: {} })
    const rows = listRecallLog(db, { sessionId: 'sess-miss' }).filter((row) => row.trigger === 'turn')
    assert.equal(rows.length, 1, '"有用户消息但没检索"必须变成账上的一行')
    assert.match(rows[0].query, /盘符根目录/)
    assert.ok(rows[0].skippedReason !== null, '要写成"没检索"（skipped_reason），不能写成"检索了零命中"')
    assert.match(rows[0].skippedReason, /未纳入检索/)
  })
})

test('开工前：会话开始时还没建立 task_sessions 关联 → 留一行日志，并在关联到手后补做一次', () => {
  withDb((db) => {
    const t = task(db, { title: '修复选择文件出不了 C 盘', description: '盘符 根目录 parent 为 null' })
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null', sourceTaskId: t.id })
    const { ctx, listeners, logs, contextText } = fakeCtx()
    installKnowledgeRecall(ctx, db, { log: (m) => logs.push(m) })

    // 真实时序：客户端先 prompt()、随后才 POST 关联；cwd 也不含任务 UUID
    const agent = { session: { header: { id: 'sess-late', cwd: 'E:\\Code\\dsh-personal-workbench' }, snapshotEvents: () => realEvents({ question: '这个报错怎么查' }) } }
    listeners.get('agent/session-start')({ agent, source: 'startup' })
    // 此刻还没有任务 → 开工前拿不到 query；装配期只能用当轮提问检索（这条提问库里没有）
    assert.equal(contextText(agent), '', '还没有可用的开工前 query → 不注入')
    assert.ok(logs.some((line) => line.includes('未关联到任务')), '必须留一行"这次没检索"的日志（不静默）')
    assert.equal(
      listRecallLog(db, { sessionId: 'sess-late' }).filter((row) => row.trigger === 'session_start').length, 0,
      '开工前那一次不是检索，不该写 session_start 召回日志',
    )

    // 关联到手 → 下一次回合收尾补做开工前（P1 起检索已移到装配期，收尾只负责"补做"）
    linkTaskSession(db, { taskId: t.id, sessionId: 'sess-late', roleCode: 'execute' })
    listeners.get('agent/turn-stopping')({ agent, turn: 1, signal: {} })
    const triggers = listRecallLog(db, { sessionId: 'sess-late' }).map((row) => row.trigger)
      // P5 的 `suggested_miss` 是**独立的观测行**（这条提问里带"报错"两字），不属于本测试的账
      .filter((trigger) => trigger !== 'suggested_miss')
    assert.deepEqual(triggers.sort(), ['session_start', 'turn'], '补做的开工前与本次回合各记一行')

    // 补做出的那一份在下一次装配时送达（同一回合内文本必须稳定，所以不回头改本回合）
    const next = { session: { header: { id: 'sess-late', cwd: 'E:\\Code\\dsh-personal-workbench' }, snapshotEvents: () => realEvents({ turn: 6, question: '继续' }) } }
    assert.match(contextText(next), /【工作台知识库】/, '补做之后开工前的知识要真的注入')
  })
})

test('开关权威源：meta（用户显式动作）优先于官方 config', () => {
  withDb((db) => {
    // ① config 关闭 + meta 未写 → 生效（部署方一键默认关闭）
    const off = installKnowledgeRecallGuard(db, { enabled: false })
    assert.equal(off.autoEnabled(), false)
    // ② 用户在设置页把它打开（写 meta）→ 必须真的打开（v1.15.3 这里仍是 false = 假控件）
    off.setAutoEnabled(true)
    assert.equal(off.autoEnabled(), true, '设置页开关不得被 config 静默架空')
    // ③ 用户在设置页关掉 → 即使 config 为真也必须停
    const on = installKnowledgeRecallGuard(db, { enabled: true })
    on.setAutoEnabled(false)
    assert.equal(on.autoEnabled(), false)
  })
})

/**
 * 装配期**失败不得留下假状态**（这把 v1.15.7 自己引入的风险钉住）。
 *
 * `assemblyInjection` 用"键"记住"这一回合装配过了"。如果**先写键、后计算**，
 * 那么计算抛异常时这一回合就被永久标记成"装配过"，而缓存里还留着**上一回合**的文本 ——
 * 后续装配会拿着上一回合的知识当本回合的（串味），或者永远拿到空串（静默不召回）。
 * 两种都比"这一次没注入"糟得多：前者把错的知识塞进上下文，后者回到本版要修的静默状态。
 */
test('P1 装配失败不留假状态：抛异常后同回合重试必须重算（不能拿上一回合的文本）', () => {
  withDb((db) => {
    createKnowledge(db, { title: 'AAA 甲甲甲 专属主题', contentMd: 'AAA 的做法' })
    createKnowledge(db, { title: 'BBB 乙乙乙 专属主题', contentMd: 'BBB 的做法' })
    const { ctx, contextText, logs } = fakeCtx()
    const manager = installKnowledgeRecall(ctx, db, { log: (m) => logs.push(m) })
    const agentFor = (turn, question) => ({
      session: {
        header: { id: 'sess-throw', cwd: 'E:\\Code\\x' },
        snapshotEvents: () => [
          { type: 'turn/start', seq: 1, time: 1, data: { turn: { turn } } },
          { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: question }], source: { kind: 'user' } } },
        ],
      },
    })

    // ① 第 3 回合正常装配一次（留下真实缓存：AAA）。两句提问刻意不交叉命中 ——
    //    否则第 4 回合会被**会话去重**挡下，那测到的就是另一件事了。
    const third = agentFor(3, 'AAA 甲甲甲')
    assert.match(contextText(third), /AAA 甲甲甲 专属主题/)

    // ② 第 4 回合装配期**抛异常**（故障注入：候选集读取抛错，模拟库挂了/被关了）
    const fourth = agentFor(4, 'BBB 乙乙乙')
    const original = manager.candidates
    manager.candidates = () => { throw new Error('boom: candidates 读取失败') }
    assert.equal(contextText(fourth), '', '失败时这一次不注入（且必须留痕）')
    assert.ok(logs.some((line) => line.includes('注入失败')), '失败要留下可读日志，不能静默')

    // ③ 恢复后**同一回合重试**：必须重算（拿到 BBB），而不是上一回合的 AAA / 也不是空占位
    manager.candidates = original
    const retry = contextText(fourth)
    assert.match(retry, /BBB 乙乙乙 专属主题/, '同回合重试必须重算 —— 键没被失败那次占住')
    assert.doesNotMatch(retry, /AAA 甲甲甲/, '绝不能把上一回合的文本当本回合的（串味）')
  })
})

/**
 * 「账要对得上」的一条：**命中过但都已在之前的回合注入过** ≠ **分数不够**。
 *
 * 实测踩到：`logOutcome` 的兜底分支只写了"全部被阈值挡下"，于是同一句提问问第二次
 * （两条都命中、但都被会话去重跳过）会被记成"分数不够" —— 排查时把人带向打分，
 * 而真正发生的是去重。两件事必须分别写。
 */
test('P1 日志要分开说"分数不够"与"已注入过去重"（账指错方向最贵）', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const { ctx, contextText, logs } = fakeCtx()
    installKnowledgeRecall(ctx, db, { log: (m) => logs.push(m) })
    const agentFor = (turn) => ({
      session: {
        header: { id: 'sess-account', cwd: 'E:\\Code\\x' },
        snapshotEvents: () => [
          { type: 'turn/start', seq: 1, time: 1, data: { turn: { turn } } },
          { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '盘符根目录 出不去' }], source: { kind: 'user' } } },
        ],
      },
    })
    assert.match(contextText(agentFor(1)), /盘符根目录的坑/)
    logs.length = 0
    assert.equal(contextText(agentFor(2)), '', '第二次同一句提问：已在 seenIds 里 → 不再注入')
    const line = logs.find((item) => item.includes('[turn]')) ?? ''
    assert.match(line, /已注入过/, `日志要说明是去重，而不是"分数不够"：${line}`)
    assert.doesNotMatch(line, /全部被阈值/, '不能把去重说成阈值')
  })
})

/** 只借一个管理器实例（不注册钩子），避免每个断言都装一遍钩子。 */
function installKnowledgeRecallGuard(db, options) {
  const { ctx } = fakeCtx()
  return installKnowledgeRecall(ctx, db, options)
}

/**
 * ## P4：引用回报自动化
 *
 * `cited_ids` 原先**只靠模型自觉**调 `report_usage`（实测经常会忘）。
 * 现在的判据是"模型这一回合的回答里出现了刚注入条目的 id 或标题前缀" ——
 * 但必须**坚决不乱标**：标错会让"注入过但没人引用"这条证据失真，
 * 而失真的证据比没有证据更糟（会让人据此删掉有用的知识）。
 */
test('P4 引用自动化：回答里出现刚注入条目的标题 → 自动标 cited；不提则不标', () => {
  withDb((db) => {
    createKnowledge(db, { title: '复盘：团队记忆系统落地搭建：试点接入', contentMd: '盘符 parent null' })
    const { ctx, listeners, contextText } = fakeCtx()
    installKnowledgeRecall(ctx, db, { log: () => {} })
    const eventsFor = (answer) => [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: { turn: 21 } } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '复盘：团队记忆系统落地搭建' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: answer }] } },
    ]

    const answered = { session: { header: { id: 'sess-cite', cwd: 'E:\\Code\\x' }, snapshotEvents: () => eventsFor('参考《复盘：团队记忆系统落地搭建：试点接入》，要点是…') } }
    assert.match(contextText(answered), /【工作台知识库】/, '前置：这一回合确实注入了知识块')
    listeners.get('agent/turn-stopping')({ agent: answered, turn: 21, signal: {} })
    const cited = listRecallLog(db, { sessionId: 'sess-cite' }).filter((row) => row.citedIds.length > 0)
    assert.equal(cited.length, 1, '回答提到了标题 → 自动标引用（不必等模型自己回报）')

    // 反面：回答根本没提 → **不许瞎标**
    const silent = { session: { header: { id: 'sess-cite-2', cwd: 'E:\\Code\\x' }, snapshotEvents: () => eventsFor('我看到有三点可以改进。') } }
    assert.match(contextText(silent), /【工作台知识库】/)
    listeners.get('agent/turn-stopping')({ agent: silent, turn: 21, signal: {} })
    const none = listRecallLog(db, { sessionId: 'sess-cite-2' }).filter((row) => row.citedIds.length > 0)
    assert.equal(none.length, 0, '不提就不标（瞎标比不标更糟）')

    /**
     * 反面 ②：**插件注入的快照里就有标题** —— 拿它当"模型引用了"会把自动判定变成自激
     * （注入什么就自动标成引用了什么）。所以判定只读 `assistant/message`。
     */
    const echoOnly = {
      session: {
        header: { id: 'sess-cite-3', cwd: 'E:\\Code\\x' },
        snapshotEvents: () => [
          { type: 'turn/start', seq: 1, time: 1, data: { turn: { turn: 22 } } },
          { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '复盘：团队记忆系统落地搭建' }], source: { kind: 'user' } } },
          { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '【工作台知识库】- [x] 复盘：团队记忆系统落地搭建：试点接入' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } } },
          { type: 'assistant/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: '好的，我看看。' }] } },
        ],
      },
    }
    assert.match(contextText(echoOnly), /【工作台知识库】/)
    listeners.get('agent/turn-stopping')({ agent: echoOnly, turn: 22, signal: {} })
    assert.equal(listRecallLog(db, { sessionId: 'sess-cite-3' }).filter((row) => row.citedIds.length > 0).length, 0, '注入的快照不算"模型引用"')
  })
})

/**
 * ## P5：「该查未查」先只观测
 *
 * 用户话里带着报错特征词，而这一回合模型一次检索工具都没调 → 落一行 `suggested_miss`。
 * **只观测、不强制**：不替模型做决定，也就不会引入新的行为风险；
 * 但没有这一行，这种"该做没做"在账上完全看不出来（静默丢件）。
 */
test('P5 该查未查只观测：像报错却没调用检索工具 → 落一行 suggested_miss；调用过就不记', () => {
  withDb((db) => {
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const { ctx, listeners, contextText } = fakeCtx()
    const manager = installKnowledgeRecall(ctx, db, { log: () => {} })
    const agentFor = (sessionId, turn, question) => ({
      session: {
        header: { id: sessionId, cwd: 'E:\\Code\\x' },
        snapshotEvents: () => [
          { type: 'turn/start', seq: 1, time: 1, data: { turn: { turn } } },
          { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: question }], source: { kind: 'user' } } },
        ],
      },
    })

    const first = agentFor('sess-miss-obs', 5, '装盘后启动就报错了 ENOENT，怎么查')
    contextText(first)
    listeners.get('agent/turn-stopping')({ agent: first, turn: 5, signal: {} })
    const rows = listRecallLog(db, { sessionId: 'sess-miss-obs' }).filter((row) => row.trigger === 'suggested_miss')
    assert.equal(rows.length, 1, '像报错但没查过 → 观测记一行')
    assert.match(rows[0].skippedReason, /suggested_miss/)

    // 同一会话下一回合：这次先调了检索工具 → 不记
    const second = agentFor('sess-miss-obs', 6, '又报错了，还是不行')
    contextText(second)
    manager.logSearch({ sessionId: 'sess-miss-obs', taskId: null, query: 'ENOENT 报错', terms: ['报'], hits: [] })
    listeners.get('agent/turn-stopping')({ agent: second, turn: 6, signal: {} })
    assert.equal(
      listRecallLog(db, { sessionId: 'sess-miss-obs' }).filter((row) => row.trigger === 'suggested_miss').length, 1,
      '本回合调用过检索工具就不再记（判据是"该查未查"，不是"有没有报错词"）',
    )

    // 不报错的普通提问也不记
    const third = agentFor('sess-chat', 7, '我们继续讨论下一步的计划吧')
    contextText(third)
    listeners.get('agent/turn-stopping')({ agent: third, turn: 7, signal: {} })
    assert.equal(listRecallLog(db, { sessionId: 'sess-chat' }).filter((row) => row.trigger === 'suggested_miss').length, 0)
  })
})
