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

test('回合收尾：真实事件形状下必须真的发生一次召回，且查询是用户那句话', () => {
  withDb((db) => {
    const t = task(db, { title: '修复选择文件出不了 C 盘' })
    createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null', sourceTaskId: t.id })
    linkTaskSession(db, { taskId: t.id, sessionId: 'sess-turn', roleCode: 'execute' })
    const { ctx, listeners, contextText } = fakeCtx()
    installKnowledgeRecall(ctx, db, { log: () => {} })

    const agent = { session: { header: { id: 'sess-turn', cwd: 'E:\\Code\\x' }, snapshotEvents: () => realEvents({ question: '盘符根目录 出不去', injectedText: '【工作台知识库】上一回合注入的内容' }) } }
    listeners.get('agent/turn-stopping')({ agent, turn: 1, signal: {} })

    const rows = listRecallLog(db, { sessionId: 'sess-turn' })
    const turnRows = rows.filter((row) => row.trigger === 'turn')
    assert.equal(turnRows.length, 1, 'v1.15.3 这里恒为 0 行（静默失效）')
    assert.match(turnRows[0].query, /盘符根目录/, '查询必须是用户提问')
    assert.doesNotMatch(turnRows[0].query, /工作台知识库/, '不得把注入的快照当成提问（自激）')
    assert.match(contextText(agent), /【工作台知识库】/, '下一次装配能拿到注入文本')
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
    assert.equal(contextText(agent), '', '这一刻还不知道是哪个任务 → 不注入')
    assert.ok(logs.some((line) => line.includes('未关联到任务')), '必须留一行"这次没检索"的日志（不静默）')
    assert.equal(listRecallLog(db, { sessionId: 'sess-late' }).length, 0, '这不是一次检索，不该写召回日志')

    // 关联到手 → 下一次回合收尾补做
    linkTaskSession(db, { taskId: t.id, sessionId: 'sess-late', roleCode: 'execute' })
    listeners.get('agent/turn-stopping')({ agent, turn: 1, signal: {} })
    const triggers = listRecallLog(db, { sessionId: 'sess-late' }).map((row) => row.trigger)
    assert.deepEqual(triggers.sort(), ['session_start', 'turn'], '补做的开工前与本次回合各记一行')
    assert.match(contextText(agent), /【工作台知识库】/, '补做之后开工前的知识要真的注入')
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

/** 只借一个管理器实例（不注册钩子），避免每个断言都装一遍钩子。 */
function installKnowledgeRecallGuard(db, options) {
  const { ctx } = fakeCtx()
  return installKnowledgeRecall(ctx, db, options)
}
