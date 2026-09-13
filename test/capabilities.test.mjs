/**
 * 表驱动单测：**宿主能力门槛与 inject 声明**（设计文档 I3 / P5）。
 *
 * 钉住三件事：
 *
 * 1. `inject` **精确等于** 5 项数组（I3）—— 少一项会让插件半残启动，
 *    多一项可能让老宿主直接 pending；
 * 2. 缺能力时判定为"不启动"，且**原因可读**（含缺什么 + 要求什么版本）；
 * 3. `refuseToStart()` 只打日志、返回空清理函数，**不注册任何东西**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_HOST_VERSION, REQUIRED_SLOTS, checkHostCapabilities, inject, refuseToStart } from '../lib/client/capabilities.js'

/** 一个"能力齐备"的假宿主。 */
const capableHost = () => ({
  slots: {
    entriesOfSlot: () => [],
    inject: () => () => {},
    register: () => () => {},
  },
  layout: { selectPanel: () => {} },
})

test('I3：inject 精确等于 5 项，顺序也锁住', () => {
  assert.deepEqual(inject, ['sessions', 'workspaces', 'connection', 'slots', 'layout'],
    'inject 是设计文档第 5.1 节的唯一判据，改动必须同步改测试与 README')
  assert.equal(inject.length, 5)
})

test('能力齐备 → ok:true', () => {
  assert.deepEqual(checkHostCapabilities(capableHost()), { ok: true })
})

test('缺 slots 服务 → 不启动，原因里点名要升级 DSH', () => {
  const verdict = checkHostCapabilities({ layout: { selectPanel: () => {} } })
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.missing, ['slots'])
  assert.match(verdict.reason, /slots 服务/)
  assert.ok(verdict.reason.includes(MIN_HOST_VERSION), '原因里要写清最低支持版本')
})

test('slots 三件套不全 → 不启动', () => {
  for (const broken of [
    { entriesOfSlot: undefined, inject: () => () => {}, register: () => () => {} },
    { entriesOfSlot: () => [], inject: undefined, register: () => () => {} },
    { entriesOfSlot: () => [], inject: () => () => {}, register: undefined },
  ]) {
    const verdict = checkHostCapabilities({ slots: broken, layout: { selectPanel: () => {} } })
    assert.equal(verdict.ok, false, `三件套缺一项时必须拒绝启动：${JSON.stringify(Object.keys(broken))}`)
    assert.ok(verdict.missing.includes('slots.entriesOfSlot/inject/register'))
  }
})

test('某个官方槽位查不到（entriesOfSlot 抛错）→ 不启动，并点名是哪个槽位', () => {
  const host = capableHost()
  host.slots.entriesOfSlot = (name) => {
    if (name === REQUIRED_SLOTS.overlay) throw new Error('no such slot')
    return []
  }
  const verdict = checkHostCapabilities(host)
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.missing, [`overlay(${REQUIRED_SLOTS.overlay})`],
    '必须能说出缺的是 overlay（shell.overlay），否则排查时只能靠猜')
})

test('layout.selectPanel 不是函数 → 不启动（0.1.1-rc.x 就是这个形态）', () => {
  const verdict = checkHostCapabilities({ ...capableHost(), layout: {} })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.missing.includes('layout.selectPanel'))
  assert.match(verdict.reason, /官方槽位能力/)
})

test('refuseToStart：只打一条可读日志，返回空清理函数，不注册任何东西', () => {
  const lines = []
  const dispose = refuseToStart(
    { ok: false, missing: ['layout.selectPanel'], reason: '宿主缺少官方槽位能力（缺：layout.selectPanel）' },
    (message) => lines.push(message),
  )
  assert.equal(lines.length, 1, '只允许一条日志（多了会刷屏）')
  assert.match(lines[0], /^\[workbench\] 未启动：/)
  assert.match(lines[0], /layout\.selectPanel/)
  assert.equal(typeof dispose, 'function')
  assert.equal(dispose(), undefined, '清理函数必须是空操作')
})
