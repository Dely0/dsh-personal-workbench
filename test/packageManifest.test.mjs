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
