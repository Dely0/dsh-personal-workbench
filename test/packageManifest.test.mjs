/**
 * 回归：**npm 包必须能指回本仓库**（2026-09-15 定位的真实事故）。
 *
 * 为什么这不是"格式洁癖"——dsh-market 的插件目录来自 awesome-dsh-plugin 的
 * `scripts/probe-npm.mjs`，它的判定是：
 *
 *   1. 读仓库 HEAD 的 `package.json` 拿 `name`；
 *   2. 查 npm registry 上该包的 `repository`；
 *   3. **只有 `repository` 指回同一个 GitHub 仓库才认这个 npm 包**（防抢注 / 串包）。
 *
 * 1.14.59 之前我们从没写过 `repository`，于是那条映射恒为 null，后果有两个：
 *
 * - **装不上**：市场给出的安装目标退化成 `dsh plugin --profile web add github:Dely0/...`，
 *   而 pnpm 把 `github:` 解析成 `git+ssh://git@github.com/...` —— 没有配 GitHub SSH
 *   的用户直接吃 `Host key verification failed`（实测复现；对照组
 *   `github:sindresorhus/is-odd` 同样报错，所以不是我们仓库的问题）；
 *   即便 SSH 通了，还要整仓下载 + 本地构建，本机实测在 codeload 上超时。
 * - **没统计**：`scripts/probe-downloads.mjs` 只统计**已映射到 npm** 的条目，
 *   所以 `downloads` 同样是 null —— npm 上一个月实打实 1601 次下载，市场里一个数都不显示。
 *
 * 断言故意写得跟上游判定逐字一致（大小写不敏感的子串匹配）：上游换判据时这里会红，
 * 而不是悄悄退回源码安装。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const REPO = 'Dely0/dsh-personal-workbench'

test('package.json 必须声明指回本仓库的 repository（市场映射的唯一依据）', () => {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  assert.equal(typeof url, 'string', '缺少 repository：dsh-market 会退回 github: 源码安装，且不统计下载量')
  assert.equal(
    url.toLowerCase().includes(REPO.toLowerCase()),
    true,
    `repository 必须指回 ${REPO}（上游按大小写不敏感子串匹配），当前是 ${url}`,
  )
})

test('npm 包名必须是市场能直接安装的合法名字', () => {
  // 与 dsh-market src/sources.ts 的 NPM_NAME_RE 一致：不合法就只能走 github: 回退。
  assert.match(pkg.name, /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/)
  assert.equal(pkg.private, false, 'private 包不能发布，市场也就拿不到 npm 安装路径')
})

// ---------------------------------------------------------------------------
// AX-R08（包资产部分）：内置角色库必须随包发布
// ---------------------------------------------------------------------------

/**
 * 为什么这条断言必须在**包清单**这一层：
 *
 * `package.json` 的 `files` 少写一行时，本机开发全绿、测试也全绿 ——
 * 因为测试读的是**仓库里的** `assets/`，而用户装到的是**包里的**。
 * 这就是 2026-09-15 `repository` 那次事故的同构版本：
 * **只有包本身才能证伪"发布出去有没有默认人格"**（ADR 0005 的 Consequences 明写）。
 */
test('package.json 的 files 必须包含内置角色库目录（否则发布出去的包没有默认人格）', () => {
  const files = Array.isArray(pkg.files) ? pkg.files : []
  const covered = files.some((entry) => {
    const normalized = String(entry).replace(/\\/g, '/').replace(/\/$/, '')
    return normalized === 'assets/personas'
  })
  assert.equal(covered, true, `files 里必须有 assets/personas，当前：${JSON.stringify(files)}`)
})

/**
 * 内置角色分**两个来源区**，这个划分本身就是判据（2026-10-01）：
 *
 * | 区 | 内容 | 规则 |
 * |---|---|---|
 * | `generic/` | 本项目自写的**通用工作方式型**角色（6 篇） | 不许出现任何公司领域岗位名或上游素材关键词 |
 * | `domain/` | 经 LS-Skills 转手的**公司领域岗位**角色（9 篇，上游 novotnyllc/dotnet-artisan + K-Dense-AI/scientific-agents，均 MIT） | 必须逐条登记在 `THIRD_PARTY_NOTICES.md` 里（署名义务） |
 *
 * ⚠️ 原先这两块是**禁止关系**：老判据写死"内置角色恰为六篇，且不含 `天线测量`/`VNA`/`K-Dense` 等词"，
 * 用来保证"内置库只放通用内容"。2026-10-01 用户要求把 LS-Skills 的 9 篇领域角色也内置，
 * 于是那条判据不能原样留着（它会和事实打架），也**不能直接删掉**（删掉就丢了"通用库不许被
 * 公司素材污染"这条真实约束）。
 *
 * 改法是把它**一分为二**：按目录分区，各自施加对应的规则。
 * `generic/` 的黑名单一字未动 —— 那仍然是"有没有混进公司素材"的证据。
 */
const GENERIC_EXPECTED = [
  ['generic/engineering/实现者', '实现者'],
  ['generic/engineering/只读审查者', '只读审查者'],
  ['generic/engineering/反向验证者', '反向验证者'],
  ['generic/engineering/调研者', '调研者'],
  ['generic/engineering/方案设计者', '方案设计者'],
  ['generic/quality/测试工程师', '测试工程师'],
]

/** 领域角色：9 篇，逐条对齐 `THIRD_PARTY_NOTICES.md` §Bundled expert personas 的两张表。 */
const DOMAIN_EXPECTED = [
  ['domain/engineering/高级-dotnet-blazor-工程师', '高级 .NET / Blazor 工程师'],
  ['domain/engineering/dotnet-代码审查官', '.NET 代码审查官'],
  ['domain/engineering/dotnet-性能并发诊断师', '.NET 性能与并发诊断师'],
  ['domain/engineering/rf-天线测量专家', '天线测量专家'],
  ['domain/engineering/rf-电磁仿真与暗室测量', '电磁仿真与暗室测量专家'],
  ['domain/engineering/rf-微波电路与vna测量', '微波电路与 VNA 测量专家'],
  ['domain/engineering/rf-仪表回路与测量链', '仪表回路与测量链专家'],
  ['domain/testing/rf-测量不确定度预算', '测量不确定度预算专家'],
  ['domain/testing/rf-计量溯源与校准', '计量溯源与校准专家'],
]

const BUILTIN_EXPECTED = [...GENERIC_EXPECTED, ...DOMAIN_EXPECTED]

test('AX-R08 内置角色库清单精确（6 通用 + 9 领域），且随包可解析（H1 + 元信息块 + 1–20000 字符正文）', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { parsePersonaDocument } = await import('../lib/personas/parse.js')
  const { PERSONA_BODY_MAX_CHARS } = await import('../lib/shared/persona.js')
  const root = new URL('../assets/personas/', import.meta.url)
  const files = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full, `${prefix}${entry.name}/`); continue }
      if (entry.name.toLowerCase().endsWith('.md') === false) continue
      if (entry.name.toLowerCase() === 'readme.md') continue
      files.push(`${prefix}${entry.name.slice(0, -3)}`)
    }
  }
  walk(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '')
  assert.deepEqual(files.sort(), BUILTIN_EXPECTED.map(([id]) => id).sort(), `内置角色清单不符：${files.join(', ')}`)

  for (const [id, name] of BUILTIN_EXPECTED) {
    const raw = readFileSync(new URL(`../assets/personas/${id}.md`, import.meta.url), 'utf8')
    const parsed = parsePersonaDocument(raw)
    assert.equal(parsed.ok, true, `${id} 解析失败：${JSON.stringify(parsed.diagnostics)}`)
    assert.equal(parsed.document.name, name, `${id} 的 H1 必须是「${name}」`)
    assert.equal(parsed.document.description.length > 0, true, `${id} 必须有简介（界面靠它区分角色）`)
    assert.equal(parsed.document.description.length <= 160, true, `${id} 的简介超过 160 字符`)
    assert.equal(parsed.document.body.length > 0 && parsed.document.body.length <= PERSONA_BODY_MAX_CHARS, true, `${id} 正文长度越界`)
    assert.equal(parsed.document.mode.length > 0, true, `${id} 元信息块里必须有「工作模式」`)
    assert.equal(parsed.document.emoji.length > 0, true, `${id} 元信息块里必须有「建议 emoji」`)
    assert.equal(statSync(new URL(`../assets/personas/${id}.md`, import.meta.url)).size <= 256 * 1024, true, `${id} 文件超过 256KiB`)
  }
})

test('AX-R08 通用角色区（generic/）不许混入公司领域岗位名或上游素材', async () => {
  const { readFileSync } = await import('node:fs')
  /** 只做"不许出现"的黑名单扫描（不复制任何公司正文进 fixture，任务边界明写）。 */
  const forbidden = ['LS-Skills', '天线测量', '计量溯源', '不确定度预算', 'VNA', 'Blazor', 'K-Dense', 'scientific-agents']
  /**
   * ⚠️ 这个黑名单**只对 generic/ 生效**，不是对整棵 assets/personas 生效。
   * 2026-10-01 起 domain/ 下就**应该**出现这些词（那正是领域角色的本体）；
   * 把黑名单放在 generic/ 上，检查的是同一件事、而且是更精确的那件事：
   * "我们自写的通用角色有没有被公司素材污染"。
   */
  for (const [id] of GENERIC_EXPECTED) {
    const raw = readFileSync(new URL(`../assets/personas/${id}.md`, import.meta.url), 'utf8')
    for (const word of forbidden) {
      assert.equal(raw.includes(word), false, `${id} 里出现了公司领域岗位/上游素材关键词「${word}」——generic/ 只放通用工作方式型角色`)
    }
  }
})

test('AX-R08 领域角色区（domain/）必须逐条登记在 THIRD_PARTY_NOTICES.md（MIT 署名义务）', async () => {
  const { readFileSync } = await import('node:fs')
  /**
   * MIT 允许再分发与修改，条件是**在副本中保留版权声明与许可全文**。
   * 插件会把 assets/personas 与两个 LICENSE-* 一起发到 npm，所以判据要能失败：
   * 少一条登记、或少了许可全文，就是署名义务破了 —— 那必须是一条红灯，不是口头约定。
   */
  const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')
  for (const [id] of DOMAIN_EXPECTED) {
    const rel = id.slice('domain/'.length)
    assert.equal(notices.includes(`assets/personas/${rel}.md`), true,
      `THIRD_PARTY_NOTICES.md 里没有登记 ${rel}.md —— 加了角色就要同步登记（MIT 署名义务）`)
  }
  for (const upstream of ['novotnyllc/dotnet-artisan', 'K-Dense-AI/scientific-agents']) {
    assert.equal(notices.includes(upstream), true, `THIRD_PARTY_NOTICES.md 缺少上游 ${upstream}`)
  }
  // 许可全文必须随包（files 里要有），否则 MIT 的第二个条件不成立
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const license of ['LICENSE-novotnyllc-dotnet-artisan', 'LICENSE-K-Dense-scientific-agents']) {
    assert.equal(pkg.files.includes(license), true, `package.json 的 files 里必须有 ${license}（MIT 要求副本保留许可全文）`)
  }
})
