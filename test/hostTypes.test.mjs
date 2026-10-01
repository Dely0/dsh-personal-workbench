/**
 * AX-H02（批次2 H01）：**构建期类型源必须与运行时同一线**。
 *
 * ## 为什么要有这条判据
 *
 * 插件的 `peerDependencies` 声明的是"我兼容哪些宿主"；`devDependencies` 里那三个
 * `@deepseek-ai/*` 才是**编译时看到的 API**。两者长期不一致时会出现最讨厌的一类问题：
 * 类型检查全绿、代码也能构建，但用的是**运行时不一定存在**的签名 ——
 * 而 `tsconfig` 对宿主类型是 `unknown`/`any` 的地方它根本看不见（项目规范第 11 节）。
 *
 * 真实背景（2026-10-01 实测）：宿主早已是 `0.2.0-rc.2`（桌面端 app.asar 内整套
 * `@deepseek-ai/dsh-*@0.2.0-rc.2`、cordis `4.0.4`），而本仓 `dsh-llm` 还停在
 * `^0.1.0-rc.6`、cordis 解析到 `4.0.1`。H01 就是把它们对齐到运行时那一线。
 *
 * ## 判据的两面（只对齐一面就会出事）
 *
 * 1. **构建期**：devDeps 必须落在运行时那一线（0.2.0-rc.x / cordis ≥4.0.4）；
 * 2. **声明面不许收窄**：peer 区间**仍然要含老线**（`0.1.5-rc.1` / `0.1.0-rc.6`）——
 *    对齐类型源不等于放弃老宿主；老宿主靠运行时的能力探测（`ctx.get` / 可选服务）活着，
 *    不是靠类型。把 peer 收成只认 0.2 会让所有 0.1.x 用户被 DSH 的兼容性预检**静默禁用**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const dev = pkg.devDependencies ?? {}
const peers = pkg.peerDependencies ?? {}

test('AX-H02: 构建期类型源落在运行时的 0.2.0-rc.x 线上', () => {
  const llm = String(dev['@deepseek-ai/dsh-llm'] ?? '')
  assert.match(llm, /^\^?0\.2\.0-rc\./, `devDependencies 的 dsh-llm 必须对齐到 0.2.0-rc 线，当前：${llm}`)
  assert.equal(/\^?0\.1\./.test(llm), false, `dsh-llm 不许还停在 0.1.x 线：${llm}`)
})

test('AX-H02: cordis 的开发期解析必须 ≥ 4.0.4（0.2.0-rc.2 的包要求 ~4.0.4）', () => {
  const cordis = String(dev['@deepseek-ai/cordis'] ?? '')
  assert.match(cordis, /^\^?4\.0\.\d+/, `devDependencies 必须显式钉住 cordis（否则 pnpm 会解析到 4.0.1，与运行时 4.0.4 不一致）：${cordis}`)
  const minor = Number(/^\^?4\.0\.(\d+)/.exec(cordis)?.[1] ?? '0')
  assert.ok(minor >= 4, `cordis 的开发期下界必须 ≥4.0.4，当前：${cordis}`)
})

test('AX-H02: 与宿主紧耦合的 timer 插件必须是精确版本（跟着宿主走，不许写成区间）', () => {
  const timer = String(dev['@deepseek-ai/cordis-plugin-timer'] ?? '')
  assert.match(timer, /^\d+\.\d+\.\d+$/, `timer 插件必须精确钉版本（它的 API 与宿主同批发布），当前：${timer}`)
})

test('AX-H02: 对齐类型源**不许**收窄 peer 区间（老宿主仍要声明兼容）', () => {
  /**
   * 这一条是反面：只有"devDeps 对齐"这一面的话，顺手把 peer 收成 `^0.2.0-rc.1`
   * 也能全绿 —— 而那正是 v1.15.8 修过的那个事故（老用户被静默禁用）。
   */
  for (const [name, rangeExpect] of [
    ['@deepseek-ai/dsh-commands', '0.1.5-rc.1'],
    ['@deepseek-ai/dsh-host-webserver', '0.1.0-rc.6'],
    ['@deepseek-ai/dsh-system-prompt', '0.1.0-rc.6'],
    ['@deepseek-ai/dsh-tools', '0.1.0-rc.6'],
  ]) {
    const range = String(peers[name] ?? '')
    assert.ok(range.includes(rangeExpect), `${name} 的 peer 区间必须仍含老线 ${rangeExpect}，当前：${range}`)
    assert.ok(range.includes('0.2.0-rc.1'), `${name} 的 peer 区间必须含新线 0.2.0-rc.1，当前：${range}`)
  }
})
