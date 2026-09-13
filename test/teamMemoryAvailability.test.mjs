/**
 * 回归：**团队记忆能力判定**（v1.14.58）。
 *
 * ## 背景（用户 2026-09-13 说明）
 *
 * 「复盘 → 团队记忆」是**部分受限**的功能：团队记忆是公司内部系统、不会开源，
 * GitHub 上的开源用户拿不到 `dsh-team-memory` 插件与内网记忆服务。
 * 所以它必须**拿得到能力才出现** —— 否则开源用户会在复盘弹框里看到一个
 * 「🧠 同步到团队记忆库」勾选框，而那是一个永远用不了的功能。
 *
 * ## 判据为什么是"记忆库根目录"
 *
 * 1. 客户端猜不了（没有 fs，也不该知道 `~/.dsh/memory` 这种内部约定）；
 * 2. **不能靠 `ctx.get('teamMemory')`** —— 那个服务目前并不存在
 *    （该插件只暴露 AI 工具），拿它当判据会在**内部机器上误判为不可用**、把真功能藏掉；
 * 3. `~/.dsh/memory` 就是这个插件自己的落盘根（`notes/` + `queue/`），
 *    内部机器上必然在（本机已实测），开源机器上不会有人手工建它。
 *
 * ⚠️ 本文件必须能**证伪"不可用"这一路**：`homedir()` 读的是 OS 真实主目录、
 * 不认传进来的 `env`，所以 `teamMemoryAvailable({ USERPROFILE: 'Z:\\nope' })`
 * 依然返回 true（实测）。因此代码里留了 `options.home` 注入点专门给测试用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryHome, teamMemoryAvailable } from '../lib/review-memory.js'

test('默认路径：本机装了内部记忆服务时判定为可用', () => {
  // 本机（开发机）确实有 ~/.dsh/memory，所以这里应当为 true。
  // 若哪天这条失败，说明"内部机器上被误判为不可用"——那会把真功能藏掉，是更糟的方向。
  assert.equal(teamMemoryAvailable(), true, '本机应判定为可用（存在 ~/.dsh/memory）')
  assert.match(memoryHome(), /[\\/]\.dsh[\\/]memory$/)
})

test('记忆库目录不存在 → 判定为不可用（开源用户的形态）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-nomemory-'))
  try {
    const missing = join(dir, 'no-such-memory-home')
    assert.equal(teamMemoryAvailable({}, { home: missing }), false,
      '目录不存在时必须判定为不可用 —— 否则界面会给开源用户摆一个用不了的勾选框')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('记忆库目录存在 → 判定为可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-yesmemory-'))
  try {
    const home = join(dir, 'memory')
    mkdirSync(home, { recursive: true })
    assert.equal(teamMemoryAvailable({}, { home }), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('环境变量显式声明 → 即便目录还没建也算可用（显式配置就是"我知道这个功能"）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-envmemory-'))
  try {
    const declared = join(dir, 'not-created-yet')
    assert.equal(teamMemoryAvailable({ DSH_MEMORY_HOME: declared }, { home: declared }), true)
    assert.equal(teamMemoryAvailable({ TEAM_MEMORY_HOME: declared }, { home: declared }), true)
    // 空串不算显式声明
    assert.equal(teamMemoryAvailable({ DSH_MEMORY_HOME: '   ' }, { home: declared }), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('memoryHome 尊重显式环境变量（与内部插件的 NoteStore 口径一致）', () => {
  assert.equal(memoryHome({ DSH_MEMORY_HOME: 'D:\\mem' }), 'D:\\mem')
  assert.equal(memoryHome({ TEAM_MEMORY_HOME: '/tmp/mem' }), '/tmp/mem')
  assert.equal(memoryHome({ DSH_MEMORY_HOME: '  ' }).endsWith(join('.dsh', 'memory')), true,
    '空白值应当被忽略、回落到默认目录')
})
