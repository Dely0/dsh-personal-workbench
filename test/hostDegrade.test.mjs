/**
 * 宿主加固回归（issue：#3 调研期间的真实事故，2026-09-12）。
 *
 * 事故链：`dsh plugin add` 是 pnpm 转发器，会按 pnpm-lock.yaml 对齐整个 profile
 * → 工作台被从 1.13.3 回退成 1.12.1（只支持 schema 14）
 * → 库已被 1.13.3 迁到 schema 15 → `migrate()` 抛错
 * → `apply()` 抛错 → cordis 把整个 patch 行事务组回滚 → **DSH 拒绝启动，GUI 都进不去**。
 *
 * 因此这里断言的不变量是：**数据库比插件新时，插件降级为空转，但宿主必须还能起来。**
 * 这条测试不看"功能正常"，只盯"不要拖死宿主"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../lib/index.js'
import { migrate, openWorkbenchDb, SchemaTooNewError } from '../lib/db/database.js'
import { SCHEMA_VERSION } from '../lib/db/schema.js'

/** 造一个比当前插件新的库（手工把 schema_version 写大）。 */
function makeNewerDb(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`)
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY) STRICT`)
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION + 1))
  db.close()
}

/** 最小的 cordis Context 替身：记录注册了什么，并记住 effect 回调。 */
function fakeContext() {
  const effects = []
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    registered: { routes: [], tools: [], promptSections: 0, intervals: 0 },
    webServer: { register: (route) => { ctx.registered.routes.push(route); return () => {} } },
    tools: { register: (tool) => { ctx.registered.tools.push(tool); return () => {} } },
    systemPrompt: { section: () => { ctx.registered.promptSections += 1; return () => {} } },
    inject: () => { ctx.registered.intervals += 1 },
    effect: (callback) => { effects.push(callback); return () => {} },
    _effects: effects,
    /** 执行所有 effect 回调（等于插件真正装配），并收好它们的 disposer。 */
    _run() {
      for (const callback of effects) {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      }
    },
    /** 模拟插件卸载：跑 disposer（正常路径下这里会 db.close()）。 */
    _dispose() {
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose() } catch { /* 卸载期错误不影响断言 */ }
      }
    },
  }
  return ctx
}

test('SchemaTooNewError 带出双方版本号，便于告警写明怎么修', () => {
  const error = new SchemaTooNewError(15, 14)
  assert.equal(error.name, 'SchemaTooNewError')
  assert.equal(error.dbVersion, 15)
  assert.equal(error.supportedVersion, 14)
  assert.match(error.message, /15/)
  assert.match(error.message, /14/)
  assert.ok(error instanceof Error)
})

test('migrate 仍然会拒绝更新的库（不能悄悄降级读脏数据）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-schema-'))
  try {
    const dbPath = join(dir, 'workbench.db')
    makeNewerDb(dbPath)
    const db = new DatabaseSync(dbPath)
    assert.throws(() => migrate(db), (error) => error instanceof SchemaTooNewError)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('库比插件新时 apply 不抛错、不注册任何路由/工具/提醒（降级空转）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-degraded-'))
  let ctx
  const errors = []
  const originalError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    const dbPath = join(dir, 'workbench.db')
    makeNewerDb(dbPath)

    ctx = fakeContext()
    // 事故现场：这一行以前会把整个宿主拖死。
    assert.doesNotThrow(() => apply(ctx, { dbPath, announceToAgent: true }))
    ctx._run()

    assert.deepEqual(ctx.registered.routes, [], '降级时不应注册任何路由')
    assert.deepEqual(ctx.registered.tools, [], '降级时不应注册任何工具')
    assert.equal(ctx.registered.intervals, 0, '降级时不应启动提醒调度')
    // 告警必须落地：用户不去翻日志也能知道发生了什么。
    assert.equal(ctx.registered.promptSections, 1, '降级时应注册 systemPrompt 告警')
    assert.equal(errors.length, 1, '降级时应向控制台输出一条显眼错误')
    const notice = errors[0]
    assert.match(notice, /降级/)
    assert.match(notice, /dsh-personal-workbench/)
    assert.match(notice, new RegExp(String(SCHEMA_VERSION + 1)), '告警要写明数据库版本')
    assert.match(notice, new RegExp(String(SCHEMA_VERSION)), '告警要写明插件支持版本')
    assert.match(notice, /dsh plugin/, '告警要给出可执行的修复命令')
  } finally {
    console.error = originalError
    ctx?._dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('降级告警用「插件支持版本」措辞，不诱导用户降级数据库', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-degraded-msg-'))
  let ctx
  const errors = []
  const originalError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    const dbPath = join(dir, 'workbench.db')
    makeNewerDb(dbPath)
    ctx = fakeContext()
    apply(ctx, { dbPath, announceToAgent: false })
    assert.equal(ctx.registered.promptSections, 0, 'announceToAgent=false 时不注册告警段')
    assert.equal(errors.length, 1)
    assert.match(errors[0], /请勿降级数据库/)
  } finally {
    console.error = originalError
    ctx?._dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('库正常时走完整装配（降级路径不能误伤正常启动）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ready-'))
  let ctx
  try {
    const dbPath = join(dir, 'workbench.db')
    // 先用正常路径建库（与生产一致：openWorkbenchDb 会跑迁移并播种）。
    openWorkbenchDb({ dbPath }).close()

    ctx = fakeContext()
    assert.doesNotThrow(() => apply(ctx, { dbPath }))
    ctx._run()

    assert.ok(ctx.registered.routes.length > 0, '正常启动必须注册路由')
    assert.ok(ctx.registered.tools.length > 0, '正常启动必须注册工具')
    assert.equal(ctx.registered.promptSections, 1, '正常启动注册的是工作台指引段')
  } finally {
    // 必须先关库再删目录：Windows 上 WAL 句柄没释放会 EPERM。
    ctx?._dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('迁移失败不泄漏数据库句柄（Windows 上句柄不放会锁住文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-handle-'))
  try {
    const dbPath = join(dir, 'workbench.db')
    makeNewerDb(dbPath)
    assert.throws(() => openWorkbenchDb({ dbPath }), (error) => error instanceof SchemaTooNewError)
    // 句柄若泄漏，这里会在 Windows 上抛 EPERM。
    assert.doesNotThrow(() => rmSync(dir, { recursive: true, force: true }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
