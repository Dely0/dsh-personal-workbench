import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 提醒接线的**源码级不变量**。
 *
 * 为什么需要这一层（2026-09-17，来自上游 PR #6 的合入审查）：
 * 上游给的修法是「缓存未命中 → 数据库有显式绑定 → **乐观放行并异步补解析**」，
 * 末行写的是 `return adapter.available()`。那会让**从未绑定过投递目标**的用户
 * （只装了 dsh-im）每条到期提醒都去尝试投递 → 失败（`reason: 'not-configured'`）
 * → 入队退避，并反复写 `reminder_channel_unavailable` 事件 ——
 * 把"安静地不做事"变成"安静地反复失败"。
 *
 * 本轮合入时把末行收紧为 `return false`（**显式绑过才放行**）。
 * `test/reminder.test.mjs:271` 那条用例覆盖的是"`isTargetConfigured` 为假时的调度器行为"
 * （注入的是 `() => false` 的桩），**它管不住 `src/index.ts` 里那个闭包到底怎么算的** ——
 * 所以这里必须用源码扫描把它钉住，否则把 `available()` 加回去不会有任何测试变红。
 */
const indexSource = readFileSync('src/index.ts', 'utf8').replace(/\r\n/g, '\n')

/** 去掉注释：`isTargetConfigured` 的文档注释里就提到了 `adapter.available()`（作为反例），不剥会误判。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1')
}

/** 切出 `isTargetConfigured: () => { … }` 那段闭包体。 */
function targetConfiguredBody() {
  const code = stripComments(indexSource)
  const start = code.indexOf('isTargetConfigured: () => {')
  assert.ok(start > 0, 'src/index.ts 里应存在 isTargetConfigured 闭包（抽不到即接线改名，需同步本测试）')
  const end = code.indexOf('\n    },', start)
  assert.ok(end > start, '闭包体的结束位置应能定位')
  return code.slice(start, end)
}

test('接线：isTargetConfigured 不能用 adapter.available() 兜底（否则没绑目标的用户会被反复投递失败）', () => {
  const body = targetConfiguredBody()
  assert.doesNotMatch(body, /available\(\)/, '禁止用 available()（"装了 dsh-im"）兜底放行')
  assert.match(body, /return false/, '没绑过目标时必须返回 false（维持"不尝试投递"的既有语义）')
})

test('接线：isTargetConfigured 先看缓存、再看数据库显式绑定（修掉"重启后缓存为空 → 全部静默跳过"）', () => {
  const body = targetConfiguredBody()
  // 第一级：适配层缓存命中——这是重启后唯一还能救回提醒的来源
  assert.match(body, /adapter\.status\(\)\.configured/, '必须保留缓存命中这一级')
  // 第二级：数据库里的显式绑定（进程刚起来、缓存还没填时的兜底）
  assert.match(body, /readMeta\(db, 'reminder_bot_id'\)/, '必须读数据库里的机器人绑定')
  assert.match(body, /readMeta\(db, 'reminder_target_id'\)/, '必须读数据库里的目标绑定')
  // 两个 key 都要非空才算"绑过"：只写了一个不算
  assert.match(body, /botId\.trim\(\) !== '' && typeof targetId === 'string' && targetId\.trim\(\) !== ''/, '两个绑定都要非空')
  // 顺手补一次解析可以，但**不能**用它的结果影响本次返回（异步）
  assert.match(body, /void adapter\.resolveTarget\(\)\.catch\(/, '允许 void 调一次补缓存')
  const resolveLine = body.slice(body.indexOf('void adapter.resolveTarget'))
  assert.doesNotMatch(resolveLine.split('\n')[0], /return\s+adapter\.resolveTarget/, '不许 await/return 它（那会变成同步阻塞）')
})

test('对照：草稿通知侧仍然只按"通道装没装"放行（两处语义刻意不同，别互相抄）', () => {
  const draftNotify = stripComments(readFileSync('src/reminder/draft-notify.ts', 'utf8').replace(/\r\n/g, '\n'))
  // 草稿通知侧**特意**不看 isTargetConfigured：它由 send() 按需解析目标，发不出去就入队退避。
  // 任务提醒侧则相反（不看会静默跳过）。这两条取舍各自都有原因，改动时不要"顺手统一"。
  assert.match(draftNotify, /if \(!deps\.adapter\.available\(\)\)/, '草稿通知的前置门仍是 available()')
  assert.doesNotMatch(draftNotify, /deps\.isTargetConfigured\(\)/, '草稿通知不许改用 isTargetConfigured()')
})
