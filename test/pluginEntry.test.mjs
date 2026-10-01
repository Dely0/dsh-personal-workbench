/**
 * 插件装配契约的单测（v1.15.1）：inject 策略、`/workbench` 命令、模型能力路由。
 *
 * ## 这份测试锁的是什么
 *
 * 1. **`inject` 的两级分类**（本项目规范第 8 节）：
 *    - **前置条件**（缺了整个功能不成立）→ 进 inject，缺了插件 pending 是对的；
 *    - **可选增强**（有它更好）→ `ctx.get` 软探测，**绝不进 inject**（否则旧宿主上整个插件 pending，
 *      这条在本仓已复发 3 次：v1.10.1 的 uiWorkspace、v1.13.0 的 runtime.slots、v1.13.3 根治）。
 *
 *    本次新增的两个依赖正好各占一边，所以这里把它们**同时钉住**：
 *    `commands`（`/workbench` 的必需前置）进 inject；`llm`（模型收不收图的增强）不进。
 *
 * 2. **`/workbench` 命令真的注册进去了**，且 handler 的行为符合约定
 *    （空输入报错；有输入 steer 一条带 task_id 与资料夹的用户消息）。
 *
 * 3. **peer 区间覆盖"能力门槛"与当前最新核心，且下界不被抬高**：
 *    `dsh-commands` 的区间就是 `MIN_HOST_VERSION` 所在的那条 —— 必须同时含
 *    `0.1.5-rc.1`（= `MIN_HOST_VERSION`）与 `0.2.0-rc.2`，且**不含** `0.1.0-rc.5`。
 *
 *    ⚠️ 这里刻意**不写 `assert.equal(peers[...], '^' + MIN_HOST_VERSION)`**（曾经就是这么写的，
 *    0.2.0-rc.1 一到就变成假红）：**"最低能力门槛"与"声明兼容范围"是两件事** ——
 *    门槛（`layout.selectPanel` 从 0.1.5-rc.1 起才有）没变，但声明范围必须同时认下界与新核心。
 *    真实事故：DSH 0.2.0-rc.1 新增插件兼容性预检，只认 `peerDependencies` 里的 semver 区间，
 *    判定不过就把插件整行 `disabled = true`（**静默禁用**，不报错、服务照常、页面照常），
 *    于是工作台在桌面端"整体消失"。而把区间直接换成 `^0.2.0-rc.1` 会反过来禁用所有 0.1.x 用户 ——
 *    所以正确写法是**并列区间**，下界不动。
 *
 *    下一条断言同时钉住"写法不能退化成 `*` / `>=0`"：那等于对所有核心都声明兼容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../lib/index.js'
import { inject as clientInject } from '../lib/client/capabilities.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * peer 区间的**基准**：必须同时覆盖这个能力门槛与下面那个当前核心。
 * 刻意不从 `capabilities.ts` import `MIN_HOST_VERSION` —— 本条测试要守的正是
 * "这个字面量不许被顺手抬高"（`capabilities.test.mjs` 另外钉住 `capabilities.ts` 自身）。
 */
const HOST_HEAD = '0.1.5-rc.1'

/** 当前必须被覆盖的最新核心（DSH 每升一个大版本，把它往前推一格）。 */
const NEWEST_HOST = '0.2.0-rc.2'

test('pluginEntry: 宿主 inject 包含 commands（前置），且绝不包含 llm（可选增强）', () => {
  assert.ok(plugin.inject.includes('commands'), '/workbench 命令需要 commands 服务，缺了就不该启动')
  assert.equal(plugin.inject.includes('llm'), false,
    'llm 只是"模型收不收图"的提前提示，进 inject 会让没它的宿主上整个插件 pending')
  for (const name of ['webServer', 'systemPrompt', 'tools']) {
    assert.ok(plugin.inject.includes(name), `原有前置 ${name} 不能丢`)
  }
})

test('pluginEntry: 客户端 inject 不含 modelDirectories（软探测，不 pending）', () => {
  assert.equal(clientInject.includes('modelDirectories'), false,
    'modelDirectories 由另一个客户端插件提供，写进 inject 会让没装它的机器上整个面板 pending')
  assert.equal(clientInject.includes('remote'), false, 'fork 加的 remote/remote.session 是它自己的接线，本仓不需要')
})

/**
 * 极简 caret 区间判定（只认测试真正要用的形状：`^x.y.z[-pre]`，多段用 ` || ` 并列）。
 *
 * 为什么不引 `semver`：它是**被测包的运行依赖面**，而本仓 `dependencies` 只有 `react`。
 * 为一条单测给一个公开发布的插件加依赖不划算，所以这里只实现判据需要的那一小块。
 * 注意 prerelease 语义：`^0.1.5-rc.1` **包含** `0.1.5-rc.1` 本身（同 base、同 pre），
 * 但不包含更低的 `0.1.5-alpha.1` —— 这条正好用来验证"下界没被抬高"。
 */
const CLAUSE = /^\^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text)
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null }
}

function compareIds(a, b) {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) return Number(a) - Number(b)
  if (an !== bn) return an ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** 版本比较；`a` 低于 `b` 返回负数。只保证单测用到的有序性。 */
function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre === null && b.pre === null) return 0
  if (a.pre === null) return 1 // 正式版高于同号 prerelease
  if (b.pre === null) return -1
  const ai = a.pre.split('.')
  const bi = b.pre.split('.')
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    if (ai[i] === undefined) return -1
    if (bi[i] === undefined) return 1
    const c = compareIds(ai[i], bi[i])
    if (c !== 0) return c
  }
  return 0
}

/** `^x.y.z` 的上界：`x > 0` 时是 `(x+1).0.0`，`x === 0` 时是 `0.(y+1).0`。 */
function caretUpperBound(clause) {
  const major = Number(clause[1])
  const minor = Number(clause[2])
  return major > 0
    ? { major: major + 1, minor: 0, patch: 0, pre: null }
    : { major: 0, minor: minor + 1, patch: 0, pre: null }
}

/** `version` 是否落在 `range` 内。未知形状直接抛错，好过静默放行。 */
function satisfies(version, range) {
  const parsed = parseVersion(version)
  if (parsed === null) throw new Error(`不是可解析的版本：${version}`)
  let matchedSomeClause = false
  for (const raw of range.split(' || ')) {
    const clause = CLAUSE.exec(raw.trim())
    if (clause === null) throw new Error(`不支持的区间形状（本测试只认 ^x.y.z 并列）：${raw}`)
    matchedSomeClause = true
    const base = { major: Number(clause[1]), minor: Number(clause[2]), patch: Number(clause[3]), pre: clause[4] ?? null }
    if (compareVersions(parsed, base) < 0) continue
    if (compareVersions(parsed, caretUpperBound(clause)) >= 0) continue
    // 下界带 prerelease 时（`includePrerelease` 语义，逐例用真 semver 校准过）：
    // prerelease 版本只在"与比较符同一个 major.minor"时被放行 —— 所以
    // `0.1.6-rc.1` / `0.1.7-rc.2` 算命中，`0.1.5-alpha.1` 被挡（低于下界），
    // `0.2.0-rc.1` 也被挡（minor 不同）。这正是本次事故的机理。
    if (base.pre !== null && parsed.pre !== null) {
      const sameMinor = parsed.major === base.major && parsed.minor === base.minor
      if (!sameMinor) continue
    }
    return true
  }
  if (!matchedSomeClause) throw new Error(`空区间：${range}`)
  return false
}

test('pluginEntry: 上面那个区间判定器本身是可信的（否则断言会静默放行）', () => {
  // 用 semver 的公开语义固定住判定器：如果哪天有人"顺手简化" satisfies，这里先红。
  // 每一条的期望值都用真 `semver.satisfies(v, r, { includePrerelease: true })` 逐例校准过。
  const CASES = [
    // [版本, 区间, 期望]
    ['0.1.5-rc.1', '^0.1.5-rc.1', true],   // 下界自身
    ['0.1.6-rc.1', '^0.1.5-rc.1', true],   // 同 major.minor 的更高补丁 prerelease：semver 放行
    ['0.1.7-rc.2', '^0.1.5-rc.1', true],   // 旧核心线内的更高补丁
    ['0.1.5-alpha.1', '^0.1.5-rc.1', false], // 低于下界的 prerelease 不许放行
    ['0.1.0-rc.5', '^0.1.5-rc.1', false],
    ['0.2.0-rc.1', '^0.1.5-rc.1', false],  // 单区间覆盖不到新核心 —— 这正是本次事故
    ['0.1.0-rc.5', '^0.1.0-rc.6', false],  // 另一条下界（host-webserver 那条）也守
    ['0.1.5-alpha.1', '^0.1.0-rc.6', true],
    ['0.2.0-rc.1', '^0.1.0-rc.6', false],
    ['0.1.5-rc.1', '^0.1.5-rc.1 || ^0.2.0-rc.1', true],  // 并列区间：两个端点都认
    ['0.1.7-rc.2', '^0.1.5-rc.1 || ^0.2.0-rc.1', true],
    ['0.2.0-rc.1', '^0.1.5-rc.1 || ^0.2.0-rc.1', true],
    ['0.2.0-rc.2', '^0.1.5-rc.1 || ^0.2.0-rc.1', true],  // 新核心线的后续 prerelease
    ['0.2.1', '^0.2.0-rc.1', true],        // caret 覆盖同线后续正式版
    ['0.2.9', '^0.1.5-rc.1 || ^0.2.0-rc.1', true],
    ['0.3.0-rc.1', '^0.1.5-rc.1 || ^0.2.0-rc.1', false], // 下次核心升大版本时会再红一次（刻意）
    ['0.3.0', '^0.1.5-rc.1 || ^0.2.0-rc.1', false],
  ]
  for (const [version, range, expected] of CASES) {
    assert.equal(satisfies(version, range), expected, `satisfies(${version}, ${range}) 应为 ${expected}`)
  }
  assert.throws(() => satisfies('0.1.5', '~0.1.5'), /不支持的区间形状/, '不认识的区间必须抛错，不能静默放行')
})

test('pluginEntry: dsh-* peer 区间同时覆盖能力门槛与最新核心，且不退化', () => {
  /** 4 个 `@deepseek-ai/dsh-*` 依赖的区间形状必须是"并列的 caret"，不能是一把梭。 */
  const DSH_PEERS = ['@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools']

  const commands = pkg.peerDependencies['@deepseek-ai/dsh-commands']
  assert.equal(
    typeof commands === 'string' && commands.trim() !== '',
    true,
    'peer 缺少 @deepseek-ai/dsh-commands：工作台的 /workbench 命令依赖它',
  )

  // 1) 覆盖下界（能力门槛）与当前最新核心 —— 少任何一个都会被 DSH 兼容性预检整行 disabled
  assert.equal(satisfies(HOST_HEAD, commands), true, `peer 区间必须含能力门槛 ${HOST_HEAD}（抬高下界会禁用老用户）：${commands}`)
  assert.equal(satisfies(NEWEST_HOST, commands), true, `peer 区间必须含当前最新核心 ${NEWEST_HOST}（否则工作台在桌面端被静默禁用）：${commands}`)

  // 2) 下界没被"顺手放宽"：门槛之前的版本不许被声明为兼容
  assert.equal(satisfies('0.1.5-alpha.1', commands), false, `低于能力门槛的版本不该被声明兼容：${commands}`)
  assert.equal(satisfies('0.1.0-rc.5', commands), false, `低于能力门槛的版本不该被声明兼容：${commands}`)

  // 3) 不能退化成"对所有核心都兼容"（那等于放弃兼容性声明）
  assert.equal(/\*/.test(commands), false, `peer 区间不许出现 *：${commands}`)
  assert.equal(/>=\s*0/.test(commands), false, `peer 区间不许退化成 >=0：${commands}`)

  // 4) 另外三个 dsh-* peer 同样要同时覆盖两个版本
  for (const name of DSH_PEERS) {
    const range = pkg.peerDependencies[name]
    assert.equal(typeof range === 'string' && range.trim() !== '', true, `peer 缺少 ${name}`)
    for (const version of [HOST_HEAD, NEWEST_HOST]) {
      assert.equal(satisfies(version, range), true, `${name} 的区间漏了 ${version}：${range}`)
    }
  }

  // 5) 跟随口径：`cordis` 是独立包（版本线不跟 core），只要求写着一个区间
  assert.match(pkg.peerDependencies['@deepseek-ai/cordis'], /^\^\d+\.\d+\.\d+/, 'cordis 要写一个明确的 caret 区间')
})

test('pluginEntry: 版本号只由发布节奏决定，本地迭代不消耗它', () => {
  /**
   * ⚠️ 这条断言**刻意不写死具体版本号**（最初写成 `=== '1.15.0'`，一到发布就变成假红）。
   * 它要守的规矩是"本地迭代靠构建戳路径承载身份，不许顺手改版本号" ——
   * 于是判据应该是**形状**（干净三段式、无本地迭代后缀）+ 本地迭代那条路确实存在。
   */
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `发布版本号必须是干净的三段式，当前：${pkg.version}`)
  assert.equal(
    /[-+](dev|local|dirty|test)/i.test(pkg.version),
    false,
    '版本号里不许出现本地迭代标记（本地身份由 _local-build 的构建戳路径承载）',
  )
  assert.match(pkg.scripts['dev:install'], /dev-install\.mjs/, '本地迭代必须走 dev-install.mjs')
})

/** 造一个内存库（命令定义要读 meta 里的默认工作区）。 */
async function makeDb({ defaultWorkspace = '' } = {}) {
  const { openWorkbenchDb } = await import('../lib/db/database.js')
  const { seedDictionaries } = await import('../lib/db/seed.js')
  const { writeMeta } = await import('../lib/db/repo.js')
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  if (defaultWorkspace !== '') writeMeta(db, 'ai_default_workspace', defaultWorkspace)
  return db
}

test('pluginEntry: /workbench 空输入 → error（不 steer 一条空消息）', async () => {
  const db = await makeDb()
  const steered = []
  const result = plugin.workbenchCommandDefinition(db).handler({ agent: { steer: (m) => steered.push(m) }, rawInput: '   ' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /请在 \/workbench 后输入任务文字/)
  assert.equal(steered.length, 0, '空输入绝不能 steer')
  db.close()
})

test('pluginEntry: /workbench 有输入 → 建资料夹 + steer 一条带 task_id / workspace_path 的用户消息', async () => {
  const { mkdtempSync, rmSync, existsSync, readdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'wb-command-'))
  const db = await makeDb({ defaultWorkspace: root })
  const steered = []
  const result = plugin.workbenchCommandDefinition(db).handler({ agent: { steer: (m) => steered.push(m) }, rawInput: '  周五 10:30 接待重要客户  ' })
  assert.equal(result.kind, 'success')
  assert.equal(steered.length, 1)
  assert.equal(steered[0].role, 'user')
  const text = steered[0].content.map((block) => block.text).join('')
  assert.match(text, /周五 10:30 接待重要客户/)
  assert.match(text, /只处理新任务的澄清与提交/)
  const idMatch = /本次预分配任务 id：([0-9a-f-]{36})/.exec(text)
  assert.ok(idMatch !== null, 'steer 的提示词里必须给出预分配任务 id')
  assert.match(text, new RegExp(`task_id="${idMatch[1]}"`))
  assert.match(text, new RegExp(`workspace_path="${root.replace(/\\/g, '\\\\')}`))
  // 资料夹真的建出来了，且名字是 <任务ID>-<标题片段>
  const entries = readdirSync(root)
  assert.equal(entries.length, 1)
  // 半角冒号在 Windows 上非法，会被清洗掉（与旧口径 folderForText 同一套清洗规则）
  assert.equal(entries[0], `${idMatch[1]}-周五 1030 接待重要客户`)
  assert.equal(existsSync(join(root, entries[0])), true)
  assert.match(result.text, /任务资料夹/)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('pluginEntry: /workbench 未配置默认工作区时不编路径（fork 写死 ~/Documents/aitasks，不抄）', async () => {
  const db = await makeDb()
  const steered = []
  const result = plugin.workbenchCommandDefinition(db).handler({ agent: { steer: (m) => steered.push(m) }, rawInput: '随手记一笔' })
  assert.equal(result.kind, 'success')
  const text = steered[0].content.map((block) => block.text).join('')
  assert.equal(/workspace_path=/.test(text), false, '没有根目录就不许传 workspace_path')
  assert.match(text, /未配置默认 AI 工作区/)
  assert.equal(/ai-?workbench|ai-?tasks|Documents/.test(text), false, '不许写死某个默认目录')
  db.close()
})

test('pluginEntry: agent.steer 不可用时返回可读 error，而不是抛异常', async () => {
  const db = await makeDb()
  const result = plugin.workbenchCommandDefinition(db).handler({ agent: {}, rawInput: '随手记一笔' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /agent\.steer 不可用/)
  assert.match(result.text, /快速录入/, '要告诉用户改走哪条路')
  db.close()
})

test('pluginEntry: 模型能力路由在拿不到 llm 时返回 available:false（不报错、不拦）', async () => {
  const { collectModelModalities } = await import('../lib/api/routes/model-modalities.js')
  const empty = await collectModelModalities({})
  assert.deepEqual(empty, { models: [], failures: [] })

  const probe = {
    listProviders: () => [{ id: 'deepseek-official' }, { id: 'broken' }],
    listModels: async (provider) => {
      if (provider === 'broken') throw new Error('provider down')
      return [
        { id: 'deepseek-flash', inputModalities: ['text', 'image'] },
        { id: 'deepseek-v4-flash', inputModalities: ['text'] },
        { id: 'no-modalities' },
        { notAModel: true },
      ]
    },
  }
  const result = await collectModelModalities(probe)
  assert.deepEqual(result.failures, ['broken'], '单个 provider 失败要如实上报，不能静默吞掉')
  assert.deepEqual(result.models, [
    { provider: 'deepseek-official', model: 'deepseek-flash', inputModalities: ['text', 'image'] },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', inputModalities: ['text'] },
    { provider: 'deepseek-official', model: 'no-modalities', inputModalities: null },
  ], '形状不对的条目直接跳过；inputModalities 缺省记成 null（= 宿主没声明）')
})

test('回归 F5：/workbench 的任务资料夹必须过平台归一化（与客户端算出同一形态）', async () => {
  /**
   * fresh-eyes 审查 F5：命令侧原本直接用 `node:path.join(root, folderName)`，
   * 而客户端那条链路会做 WSL 归一化。在一台"宿主跑在 WSL、设置里填的是 `D:\...`"的机器上，
   * `mkdirSync('D:\DSHWorkspace\x')` 会在当前目录建出一个名叫 `D:\DSHWorkspace` 的**单层目录**。
   */
  const { normalizeHostPath } = await import('../lib/api/routes/helpers.js')
  assert.equal(normalizeHostPath('D:\\DSHWorkspace\\abc-标题', 'linux'), '/mnt/d/DSHWorkspace/abc-标题')
  assert.equal(normalizeHostPath('D:/DSHWorkspace/abc-标题', 'linux'), '/mnt/d/DSHWorkspace/abc-标题')
  assert.equal(normalizeHostPath('D:\\DSHWorkspace\\abc-标题', 'win32'), 'D:\\DSHWorkspace\\abc-标题', 'Windows 上必须原样')
  assert.equal(normalizeHostPath('/mnt/d/DSHWorkspace/abc', 'linux'), '/mnt/d/DSHWorkspace/abc', '已是 WSL 形态不再转换')
  // 源码级：命令侧必须把 join 的结果过一次归一化（不许裸 join）
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /folderPath = normalizeHostPath\(join\(root, folderName\)\)/,
    '命令侧的资料夹路径必须过 normalizeHostPath —— 裸 join 会在 WSL 宿主上建出错误形态的目录',
  )
})

test('pluginEntry: 服务端不许自建 / 补全浮层（宿主原生 / 菜单本来就会列出注册的命令）', () => {
  /** 注释里会出现这些名字（说明"为什么不做"），所以只扫**去掉注释**后的代码。 */
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const path of ['../src/index.ts', '../src/client/index.tsx', '../src/client/styles.ts']) {
    const code = stripComments(readFileSync(new URL(path, import.meta.url), 'utf8'))
    assert.equal(/data-dsh-workbench-slash-menu/.test(code), false, `${path} 里出现了自建斜杠菜单标记`)
    assert.equal(/installWorkbenchSlashMenu/.test(code), false, `${path} 里出现了自建斜杠菜单函数`)
    assert.equal(/textarea\[data-phase\]/.test(code), false, `${path} 里出现了"手动定位官方输入框"的写法`)
  }
})
