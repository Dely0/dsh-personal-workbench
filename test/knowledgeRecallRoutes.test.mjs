/**
 * 回归：知识库自动召回的**端点层与工具层**（v1.15.3）。
 *
 * 这一层测的是"用户/AI 真正能碰到的那几个口子"，而不是内部判定：
 *
 * | 口子 | 为什么必须锁 |
 * |---|---|
 * | `GET /knowledge-recall/log` | 验收要求"日志里能看到检索了哪些关键词、命中哪几条、是否被引用"——这是**不装工具也能看**的那条路 |
 * | `POST /knowledge-recall/auto` | 全局开关（关掉后不再注入） |
 * | `POST /knowledge-recall/session` | 单会话开关（三种状态都要能表达，否则"全局关了但我就想这个会话开"没法说） |
 * | `workbench_search_knowledge` | 四个触发时机里"报错时/写码前"必须当回合可查 |
 * | `workbench_knowledge_recall_control` | 可关闭 + "是否被引用"的判定证据 |
 *
 * 另外锁两条**可达性**：端点必须跑在 loopback 围栏之后（与其余路由一致），
 * 且工具必须真的注册进 `ctx.tools`（只写实现不注册 = 用户永远用不到）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { createKnowledge, createTask } from '../lib/db/repo.js'
import { linkTaskSession } from '../lib/db/repo/task-sessions.js'
import { makeRoutes } from '../lib/api/routes.js'
import { KnowledgeRecallManager } from '../lib/knowledge-recall.js'
import { listRecallLog } from '../lib/knowledge-recall-log.js'
import { knowledgeRecallControlTool, searchKnowledgeTool } from '../lib/knowledge-tools.js'

/**
 * ⚠️ `withDb` 必须 **await**：里面的用例是 async（要打 HTTP），
 * 若同步返回就在 async 体还没跑完时关掉 db、删掉目录 ——
 * 表现为"断言全失败 + 进程挂住"（第一版就是这么写的，白查了一轮）。
 */
async function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-knowledge-routes-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  seedDictionaries(db)
  try { return await run(db) } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
}

function task(db, over = {}) {
  return createTask(db, { typeCode: 'code_impl', priorityCode: 'p2', ...over })
}

async function withServer(db, manager, fn) {
  const routes = makeRoutes(db, { knowledgeRecall: manager })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('测试服务器没有拿到端口')
  }
  const base = `http://127.0.0.1:${address.port}`
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() }
  }
  try { return await fn(call) } finally {
    /**
     * 关服务必须**无条件**执行且不吞异常：断言失败时也要走这里，
     * 否则监听中的 server 会让 `node --test` 永远不退出（表现为"跑完不出结果"）。
     */
    await new Promise((resolve) => server.close(resolve))
  }
}

test('端点：召回日志可查，且带"人类可读摘要"（不装工具也能看懂）', async () => {
  await withDb(async (db) => {
    const entry = createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    manager.prefetch('sess-log', undefined, '盘符根目录出不去怎么办')
    manager.reportUsage('sess-log', [entry.id])

    await withServer(db, manager, async (call) => {
      const { status, json } = await call('GET', '/api/workbench/knowledge-recall/log?session_id=sess-log')
      assert.equal(status, 200)
      assert.equal(json.count, 1)
      assert.match(json.lines[0], /\[turn\]/, '摘要在：[触发时机]')
      assert.match(json.lines[0], /关键词=\[/, '摘要里有检索关键词')
      assert.match(json.lines[0], /命中 1 条/, '摘要里有命中条数')
      assert.match(json.lines[0], /被引用 1 条/, '摘要里有"是否被引用"')
      assert.equal(json.entries[0].hits[0].id, entry.id)
      assert.deepEqual(json.entries[0].citedIds, [entry.id])

      // 不传 session_id → 全量最近日志（用户想复查"AI 到底查过什么"时用）
      const all = await call('GET', '/api/workbench/knowledge-recall/log?limit=5')
      assert.equal(all.json.count, 1)
    })
  })
})

test('端点：全局开关关掉后，自动召回立刻停（并且状态可查）', async () => {
  await withDb(async (db) => {
    createKnowledge(db, { title: '盘符的坑', contentMd: '盘符' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    await withServer(db, manager, async (call) => {
      const before = await call('GET', '/api/workbench/knowledge-recall/status')
      assert.equal(before.json.autoEnabled, true, '缺省是开（功能不默认关闭，否则用户发现不了它）')

      const off = await call('POST', '/api/workbench/knowledge-recall/auto', { enabled: false })
      assert.equal(off.status, 200)
      assert.equal(off.json.autoEnabled, false)
      assert.equal(manager.prefetch('s1', undefined, '盘符根目录'), undefined, '关掉后不再检索（自然也不再注入）')

      const on = await call('POST', '/api/workbench/knowledge-recall/auto', { enabled: true })
      assert.equal(on.json.autoEnabled, true)

      // 参数校验：不是布尔值就 400（不静默当作 false）
      const bad = await call('POST', '/api/workbench/knowledge-recall/auto', { enabled: 'no' })
      assert.equal(bad.status, 400)
    })
  })
})

test('端点：单会话开关三态（off / on / clear），且持久化', async () => {
  await withDb(async (db) => {
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    await withServer(db, manager, async (call) => {
      const off = await call('POST', '/api/workbench/knowledge-recall/session', { sessionId: 's-x', mode: 'off' })
      assert.equal(off.json.enabled, false)
      assert.deepEqual(off.json.sessionOff, ['s-x'])

      const on = await call('POST', '/api/workbench/knowledge-recall/session', { sessionId: 's-x', mode: 'on' })
      assert.equal(on.json.enabled, true)
      assert.deepEqual(on.json.sessionOff, [])

      // 全局关 + 本会话 on → 本会话仍开（"我就想这个会话开"必须能表达）
      await call('POST', '/api/workbench/knowledge-recall/auto', { enabled: false })
      await call('POST', '/api/workbench/knowledge-recall/session', { sessionId: 's-x', mode: 'on' })
      assert.equal(manager.sessionEnabled('s-x'), true)
      assert.equal(manager.sessionEnabled('s-y'), false)

      const clear = await call('POST', '/api/workbench/knowledge-recall/session', { sessionId: 's-x', mode: 'clear' })
      assert.equal(clear.json.enabled, false, 'clear 后跟随全局（全局此时是关的）')

      const missing = await call('POST', '/api/workbench/knowledge-recall/session', { sessionId: '', mode: 'off' })
      assert.equal(missing.status, 400)
      const badMode = await call('POST', '/api/workbench/knowledge-recall/session', { sessionId: 's-x', mode: 'maybe' })
      assert.equal(badMode.status, 400)
    })
  })
})

test('工具：workbench_search_knowledge 输出自带检索证据（关键词/条数/逐条相关度与依据）', async () => {
  await withDb(async (db) => {
    const t = task(db, { title: '修复选择文件出不了 C 盘' })
    createKnowledge(db, { title: '盘符根目录 parent 为 null', contentMd: 'dirname("C:\\") === "C:\\"', tags: ['盘符', '踩坑'], sourceTaskId: t.id })
    linkTaskSession(db, { taskId: t.id, sessionId: 'sess-tool', roleCode: 'execute' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const tool = searchKnowledgeTool(manager)
    const output = await tool.execute({ query: '盘符根目录出不去' }, { agent: { session: { id: 'sess-tool' } } })

    assert.match(output, /关键词：/, '要写出检索了哪些关键词')
    assert.match(output, /命中 \d+ 条/, '要写出命中几条')
    assert.match(output, /相关度 \d\.\d\d/, '逐条给相关度')
    assert.match(output, /依据：/, '逐条给命中依据')
    assert.match(output, /全库|任务/, '要说明检索范围（本任务优先/全库）')
    assert.match(output, /report_usage/, '要告诉模型怎么回报引用')

    // 显式检索也落日志（trigger=tool）：模型主动查了什么同样可回看
    const log = listRecallLog(db, { sessionId: 'sess-tool' })
    assert.equal(log.length, 1)
    assert.equal(log[0].trigger, 'tool')
    assert.equal(log[0].injected, false, '工具检索≠系统注入，两者不能混为一谈')
  })
})

test('工具：零命中也要说清是"零命中"而不是"没有检索"', async () => {
  await withDb(async (db) => {
    createKnowledge(db, { title: '团建活动报名', contentMd: '周五下午羽毛球' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const tool = searchKnowledgeTool(manager)
    const output = await tool.execute({ query: '盘符根目录出不去' }, { agent: { session: { id: 'sess-none' } } })
    assert.match(output, /零命中/)
    assert.match(output, /换更具体的现象词/, '零命中要给出下一步（不要空手让模型重试）')
  })
})

test('工具：task_id 不存在时当场报错，不静默退回全库', async () => {
  await withDb(async (db) => {
    createKnowledge(db, { title: '盘符的坑', contentMd: '盘符' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const output = await searchKnowledgeTool(manager).execute(
      { query: '盘符', task_id: 'no-such-task' },
      { agent: { session: { id: 'sess-bad' } } },
    )
    assert.match(output, /错误：task_id 不存在/)
    assert.equal(listRecallLog(db).length, 0, '校验失败不该留下"查过"的日志')
  })
})

test('工具：recall_control 五种动作各管一件事，且能关掉/打开/回报引用', async () => {
  await withDb(async (db) => {
    const entry = createKnowledge(db, { title: '盘符根目录的坑', contentMd: '盘符 parent null' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const tool = knowledgeRecallControlTool(manager)
    const exec = { agent: { session: { id: 'sess-ctl' } } }

    manager.prefetch('sess-ctl', undefined, '盘符根目录')
    const status = await tool.execute({ action: 'status' }, exec)
    assert.match(status, /本会话自动召回：开/)
    assert.match(status, /盘符根目录的坑/, 'status 要回显上一次命中的条目')

    const off = await tool.execute({ action: 'turn_off' }, exec)
    assert.match(off, /已关闭本会话的自动检索/)
    assert.equal(manager.injectionFor('sess-ctl', 99), '', '关掉后不再注入')

    const on = await tool.execute({ action: 'turn_on' }, exec)
    assert.match(on, /已打开/)

    const usage = await tool.execute({ action: 'report_usage', entry_ids: [entry.id] }, exec)
    assert.match(usage, /已回报引用 1 条/)
    assert.deepEqual(listRecallLog(db, { sessionId: 'sess-ctl' }).find((row) => row.injected)?.citedIds, [entry.id])

    const empty = await tool.execute({ action: 'report_usage', entry_ids: [] }, exec)
    assert.match(empty, /需要 entry_ids/, '一条都没用上时不该当成"回报成功"')
    const unknown = await tool.execute({ action: 'nonsense' }, exec)
    assert.match(unknown, /未知 action/)
  })
})

test('接线：两个工具真的注册进 ctx.tools（只写实现不注册 = 用户永远用不到）', () => {
  const index = readFileSync('src/index.ts', 'utf8').replace(/\r\n/g, '\n')
  assert.match(index, /searchKnowledgeTool\(knowledgeRecall\)/, '搜索工具要注册')
  assert.match(index, /knowledgeRecallControlTool\(knowledgeRecall\)/, '开关/引用工具要注册')
  assert.match(index, /installKnowledgeRecall\(ctx, db, \{/, '召回管理器由入口创建')
  assert.match(index, /const knowledgeRecall = installKnowledgeRecall/, '创建结果必须被复用（工具/路由/钩子同一实例）')
  assert.match(index, /knowledgeRecall,\n/m, '管理器要注入 makeRoutes（路由与工具共享同一份状态）')
})

test('客户端接线：设置页有「知识库召回」分区与开关，且日志面板接在真端点上', () => {
  const settings = readFileSync('src/client/components/SettingsModal.tsx', 'utf8').replace(/\r\n/g, '\n')
  assert.match(settings, /key: 'recall'/, '设置分区里有「知识库召回」')
  assert.match(settings, /autoKnowledgeRecall/, '开关绑定到设置的 autoKnowledgeRecall')
  assert.match(settings, /wb-recall-log/, '有召回回执面板')
  assert.match(settings, /recallSessionOff\.map/, '能列出并解除"单会话关闭"')

  const index = readFileSync('src/client/index.tsx', 'utf8').replace(/\r\n/g, '\n')
  assert.match(index, /\/api\/workbench\/knowledge-recall\/log\?limit=30/, '面板拉的是真实召回日志端点')
  assert.match(index, /\/api\/workbench\/knowledge-recall\/session/, '解除用的是真实会话开关端点')
  assert.match(index, /recallLog=\{recallLog\}/, '状态要传进设置弹窗（否则开关点了没用）')

  // 契约：设置接口必须带上这个字段（漏了会表现为"保存后开关自己变回去"）
  const contracts = readFileSync('src/shared/contracts.ts', 'utf8').replace(/\r\n/g, '\n')
  assert.match(contracts, /autoKnowledgeRecall: boolean/, 'WorkbenchSettings 里有这个字段')
  const routes = readFileSync('src/api/routes.ts', 'utf8').replace(/\r\n/g, '\n')
  assert.match(routes, /autoKnowledgeRecall: \(readMeta\(db, 'knowledge_recall_auto'\)/, 'GET 会回这个字段')
  assert.match(routes, /body\.autoKnowledgeRecall === true \|\| body\.autoKnowledgeRecall === false/, 'POST 能写这个字段（且只认布尔）')
})

test('端点围栏：非 loopback 请求被拒（与其余路由同一条规矩）', async () => {
  await withDb(async (db) => {
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const routes = makeRoutes(db, { knowledgeRecall: manager })
    const route = routes.find((item) => item.path === '/api/workbench/knowledge-recall/log')
    assert.ok(route !== undefined, '端点必须注册')
    // 直接调 handler，伪造一个非 loopback 的来源（remoteAddress 不是 127.0.0.1）
    const res = {
      statusCode: undefined,
      body: undefined,
      writeHead(code) { this.statusCode = code },
      end(chunk) { this.body = chunk },
    }
    await route.handler({ method: 'GET', url: '/api/workbench/knowledge-recall/log', socket: { remoteAddress: '10.1.2.3' }, headers: {} }, res)
    assert.equal(res.statusCode, 403, '非 loopback 必须 403')
  })
})

/**
 * v1.15.5 修的两条"承诺与能力不一致"（用户 2026-09-17 实测抓到的）：
 *
 * 1. 注入文本写着"需要展开某条时用返回里的 id 再查一次"，而工具**只会按关键词抽词**，
 *    传 uuid 进去必然零命中 —— 于是 52 条带 `file_link` 的镜像型条目在会话里
 *    只剩 160 字摘要可用，知识库"检索得回来、消费不下去"。
 * 2. 展示的"相关度"是**有界原始分**（上限 0.55），看着永远比团队记忆的 0.8~0.99 低，
 *    用户合理地质疑"是不是打分有问题"。现在展示层归一化到 0~1，工具阈值同口径。
 */
test('工具：把 [id] 当 query 直读全文（注入文案承诺的那条路必须真的能用）', async () => {
  await withDb(async (db) => {
    const long = '正文前缀'.repeat(60) // 远超 160 字摘要长度
    const entry = createKnowledge(db, {
      title: '带镜像文档的条目',
      contentMd: `${long}  尾部唯一标记 TAIL-MARK`,
      tags: ['镜像'],
      fileLink: 'file:///D:/docs/mirror.md',
    })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const tool = searchKnowledgeTool(manager)
    const exec = { agent: { session: { id: 'sess-byid' } } }

    // 注入文案里的形态就是 [uuid]
    const output = await tool.execute({ query: `[${entry.id}]` }, exec)
    assert.match(output, /TAIL-MARK/, '按 id 要能拿到 160 字摘要之外的真实全文')
    assert.match(output, new RegExp(entry.id), '回显条目 id（便于 report_usage）')
    assert.match(output, /file:\/\/\/D:\/docs\/mirror\.md/, '镜像文档路径要一并给出')
    assert.doesNotMatch(output, /零命中/, '不能把"按 id 读"走进关键词检索的零命中分支')

    // 裸 uuid 与 entry_id: 前缀都认（模型抄 id 时形态会变）
    const bare = await tool.execute({ query: entry.id }, exec)
    assert.match(bare, /TAIL-MARK/, '裸 uuid 也要认')
    assert.match(await tool.execute({ query: `entry_id:${entry.id}` }, exec), /TAIL-MARK/, 'entry_id: 前缀也要认')

    // 落库的日志要区分"按 id 直读"与关键词检索（否则噪声账对不上）
    const log = listRecallLog(db, { sessionId: 'sess-byid' })
    assert.equal(log.length, 3)
    assert.equal(log[0].trigger, 'tool')
    assert.equal(log[0].hits[0].id, entry.id)
    assert.match(log[0].hits[0].reason, /按 id 直读全文/)
  })
})

test('工具：未知 id 当场说"没有这条"，不伪装成零命中', async () => {
  await withDb(async (db) => {
    createKnowledge(db, { title: '盘符的坑', contentMd: '盘符' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const output = await searchKnowledgeTool(manager).execute(
      { query: '00000000-0000-0000-0000-000000000000' },
      { agent: { session: { id: 'sess-noid' } } },
    )
    assert.match(output, /没有这条知识条目/, '要明确说这条 id 不存在')
    assert.match(output, /完整 uuid/, '要给出下一步（拿完整 id 再试）')
    assert.doesNotMatch(output, /候选池/, '不能退化成关键词零命中那句话')
  })
})

test('工具：min_score 用归一化相关度（与输出里的"相关度"同一把尺子）', async () => {
  await withDb(async (db) => {
    // query 4 个关键词、标题命中 3 个 → 原始分 0.55×1×(0.5+0.5×0.75)=0.48125 → 相关度 0.875
    // （原始分口径下它 0.48 也算"过线"，但按 0.8 当原始分传就会被全挡下 —— 这正是修复点）
    createKnowledge(db, { title: '盘符根目录', contentMd: '无关正文' })
    const manager = new KnowledgeRecallManager(db, { log: () => {} })
    const tool = searchKnowledgeTool(manager)
    const exec = { agent: { session: { id: 'sess-score' } } }

    const pass = await tool.execute({ query: '盘符根本', min_score: 0.8 }, exec)
    assert.match(pass, /命中 1 条/, '相关度 0.875 要过 0.8 这条线')
    assert.match(pass, /相关度 0\.8\d/, '展示的必须是归一化相关度')

    const blocked = await tool.execute({ query: '盘符根本', min_score: 0.9 }, exec)
    assert.match(blocked, /零命中/, '相关度 0.875 < 0.9 → 要被挡下')
  })
})

