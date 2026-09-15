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
 * 3. **peer 版本对齐 `0.1.5-rc.1`**（= `MIN_HOST_VERSION`），不是 fork 写的 `^0.0.1-rc.1`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../lib/index.js'
import { MIN_HOST_VERSION, inject as clientInject } from '../lib/client/capabilities.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

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

test('pluginEntry: package.json 的 peer 版本与 MIN_HOST_VERSION 对齐', () => {
  const peers = pkg.peerDependencies
  assert.equal(peers['@deepseek-ai/dsh-commands'], `^${MIN_HOST_VERSION}`,
    'fork 写的是 ^0.0.1-rc.1；必须对齐本仓的最低宿主版本')
  assert.equal(peers['@deepseek-ai/dsh-commands'].startsWith('^0.0.'), false)
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools']) {
    assert.ok(typeof peers[name] === 'string' && peers[name] !== '', `peer 缺少 ${name}`)
  }
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
