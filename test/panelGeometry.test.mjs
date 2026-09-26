/**
 * 「面板该往哪儿铺」的几何判据单测（v1.15.5）。
 *
 * ## 这两条判据各防哪个真 bug（DSH 0.1.7-rc.2 桌面端，2026-09-26）
 *
 * 1. `decideSidebarWidth` —— 用户："收起侧边栏后无法撑满屏幕"。
 *    旧口径 `width<=0 → 不更新`，而 rc2 收起侧栏后栏目宽度**就是 0**，
 *    于是 `--wb-sidebar-w` 永远停在收起前的 280px，面板左边空一条、铺不满。
 * 2. `decideTopInset` —— 用户："顶部占用了桌面端的 Title，无法正常点击"。
 *    rc2 桌面壳给 frame 加了 `padding-top: var(--dsh-windows-titlebar-height)`，
 *    面板 `position:fixed; top:0` 不跟 → 压在标题栏上。
 *
 * 断言按"变量最终会被写成多少"写，不按实现细节：
 * 这两条都是**会写进 CSS、直接决定面板盖住谁**的值，所以每条分支都要有断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideSidebarWidth, decideTopInset, pickFrameCandidate } from '../lib/client/panelGeometry.js'

const VIEWPORT = { viewportWidth: 1764 }

// ── 侧栏宽度 ───────────────────────────────────────────────────────────

test('侧栏宽度：收起状态（栏目宽度 0）必须写出 0px —— 这正是"铺不满"的根因', () => {
  const verdict = decideSidebarWidth({ exists: true, width: 0, declaredWidth: null, ...VIEWPORT })
  assert.equal(verdict.width, 0, '0 是合法值（收起），不能再当成"量取失败"而保留旧值')
  assert.match(verdict.because, /收起/)
})

test('侧栏宽度：量到复数宽度（量取异常）也归一成 0，不写负数', () => {
  const verdict = decideSidebarWidth({ exists: true, width: -3, declaredWidth: null, ...VIEWPORT })
  assert.equal(verdict.width, 0)
})

test('侧栏宽度：宿主公布的宽度优先于几何（rc2 把权威值写在 frame 上）', () => {
  // 过渡动画途中几何还是旧值（280），宿主已经说了收起（0）→ 以宿主为准
  const verdict = decideSidebarWidth({ exists: true, width: 280, declaredWidth: 0, ...VIEWPORT })
  assert.equal(verdict.width, 0)
  assert.match(verdict.because, /宿主公布/)
})

test('侧栏宽度：正常展开时用几何值', () => {
  const verdict = decideSidebarWidth({ exists: true, width: 280.4, declaredWidth: null, ...VIEWPORT })
  assert.equal(verdict.width, 280)
})

test('侧栏宽度：超过视口 40% 判为选错元素 → 不更新（保留上一次的值）', () => {
  const verdict = decideSidebarWidth({ exists: true, width: 1200, declaredWidth: null, ...VIEWPORT })
  assert.equal(verdict.width, null, '宁可不更新（偏 280px），也不能写入接近视口的宽度（会盖住侧栏）')
  assert.match(verdict.because, /40%/)
})

test('侧栏宽度：元素找不到 → 不更新（兜底 280px 远比 0px 安全）', () => {
  const verdict = decideSidebarWidth({ exists: false, width: 0, declaredWidth: null, ...VIEWPORT })
  assert.equal(verdict.width, null)
})

test('侧栏宽度：宽度不是有限数 → 不更新', () => {
  const verdict = decideSidebarWidth({ exists: true, width: Number.NaN, declaredWidth: null, ...VIEWPORT })
  assert.equal(verdict.width, null)
})

// ── 桌面壳标题栏让位 ──────────────────────────────────────────────────

test('顶部让位：非桌面壳（无 data-windows-titlebar）一律 0 —— 网页版/macOS 零影响', () => {
  const verdict = decideTopInset({ attributePresent: false, framePaddingTop: 0, declaredHeight: null })
  assert.equal(verdict.inset, 0)
})

test('顶部让位：桌面壳取 frame 的计算 padding-top（最贴事实）', () => {
  const verdict = decideTopInset({ attributePresent: true, framePaddingTop: 36, declaredHeight: 36 })
  assert.equal(verdict.inset, 36)
  assert.match(verdict.because, /padding-top/)
})

test('顶部让位：padding 量不到时采信宿主变量值', () => {
  const verdict = decideTopInset({ attributePresent: true, framePaddingTop: 0, declaredHeight: 32 })
  assert.equal(verdict.inset, 32)
  assert.match(verdict.because, /--dsh-windows-titlebar-height/)
})

test('顶部让位：桌面壳但两处都量不到 → 兜底 32px（与 dsh-better-sidebar 口径一致）', () => {
  const verdict = decideTopInset({ attributePresent: true, framePaddingTop: 0, declaredHeight: null })
  assert.equal(verdict.inset, 32, '宁可多让 32px 出一条空带，也不能把标题栏压住导致点不动')
})

// ── 挑出真正的 frame ─────────────────────────────────────────────────

test('frame 候选：取"真的让出了顶部空间"的那个（别的元素也可能带 frame 子串）', () => {
  // 例：先命中一个 CSS module 里同样含 "frame" 的小元素（padding 0），真 frame 在后面
  assert.equal(pickFrameCandidate([0, 36, 0]), 1)
  assert.equal(pickFrameCandidate([0, 0, 0]), 0, '全为 0（网页版）时取第一个，取谁都一样')
  assert.equal(pickFrameCandidate([36]), 0)
})

test('frame 候选：量到 NaN 的候选不参与比较（不让 NaN 抢到"最大"）', () => {
  assert.equal(pickFrameCandidate([Number.NaN, 32]), 1)
  assert.equal(pickFrameCandidate([Number.NaN, Number.NaN]), 0)
})

test('frame 候选：一个候选都没有 → -1（调用方据此知道"还没渲染"）', () => {
  assert.equal(pickFrameCandidate([]), -1)
})
