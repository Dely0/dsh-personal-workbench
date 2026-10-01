/**
 * 源码级不变量（设计文档 I1，阶段 1 出口判据）：
 * **"面板该不该显示"只能由 `panelState.ts` 回答，不许再散落在 index.tsx 里。**
 *
 * ## 为什么要用源码扫描
 *
 * 这条不变量本质是"不存在第二处实现"，而"不存在"没法用运行时断言证明 ——
 * 只能扫源码。这与设计文档第 7 节对 I4/I5/I6 的做法一致（把政策变成能失败的约束）。
 *
 * ## 历史背景（不这么做会怎样）
 *
 * 改动前同一个语义写了三遍，读的输入还不同：
 *
 * | 位置 | 表达式 |
 * |---|---|
 * | `WorkbenchPanelContent` 渲染条件 | `hostReadable ? hostSelected : (!forcedClosed && localOpen)` |
 * | `isDisplayed()` | `panelInfoHookSeen ? hostPanelId === PANEL_NAME : (!forcedClosed && open)` |
 * | `WorkbenchHeaderEntry` | `hostPanelId !== undefined ? hostPanelId === PANEL_NAME : (isHostSelected?.() ?? isOpen())` |
 *
 * bug 2（官方行点了不开）、bug 6（被挤掉后再也打不开）、bug 9（低版本永不显示）
 * 都是这三处互相矛盾造成的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const INDEX = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const PANEL_STATE = readFileSync(new URL('../src/client/panelState.ts', import.meta.url), 'utf8')

/** 去掉注释，避免文档与说明文字被当成真实代码。 */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

test('index.tsx 里不得再出现"自己算该不该显示"的表达式', () => {
  const code = stripComments(INDEX)

  // 逐字比对：老的三个内联表达式一个都不能复活
  assert.equal(code.includes("hostReadable ? hostSelected :"), false,
    '渲染条件不得再内联判定 —— 必须走 shouldShowPanel/panelDataOpen')
  assert.equal(/panelInfoHookSeen\s*\n?\s*\?\s*hostPanelId\s*===\s*PANEL_NAME\s*\n?\s*:\s*\(!forcedClosed/.test(code), false,
    'isDisplayed() 不得再内联判定（含本地回落的那个三元）')

  /**
   * "宿主选中了我们吗"这个比较**至多允许一处**：`hostSelectedFromMirror()`
   * （它给槽位句柄用的三态值：true / false / undefined=未知）。
   *
   * 任何**新的**内联比较都意味着判定又开始散落 —— 这正是 bug 2/6/9 的成因，
   * 所以这里用"允许清单 + 位置"把它按住：出现第 2 处就失败。
   *
   * ⚠️ 2026-10-01 由"恰好 1 处"放宽为"至多 1 处"（遗留清单 P3-3）：
   * 唯一那处比较的消费者是 `slotApi.isHostSelected`，一旦它被去掉，计数就变成 0 ——
   * 那是**假失败**，而真正要防的是"判定散落"（≥2 处）。放宽不等于放弃约束：
   * 下面继续钉住"若存在，必须在 `hostSelectedFromMirror` 的函数体内"。
   */
  const COMPARISON = /activePanelId\s*===\s*PANEL_NAME|hostPanelId\s*===\s*PANEL_NAME/
  const comparisons = code.match(new RegExp(COMPARISON.source, 'g')) ?? []
  assert.ok(comparisons.length <= 1,
    `index.tsx 里"宿主选中我们"的比较至多 1 处（hostSelectedFromMirror），实际 ${comparisons.length} 处`)
  assert.ok(code.includes('const hostSelectedFromMirror = ()'), '唯一允许的比较必须写在 hostSelectedFromMirror 里')
  if (comparisons.length === 1) {
    const start = code.indexOf('const hostSelectedFromMirror = (')
    const nextDecl = code.indexOf('\n  const ', start)
    const body = code.slice(start, nextDecl === -1 ? code.length : nextDecl)
    assert.match(body, COMPARISON, '唯一那处比较必须在 hostSelectedFromMirror 函数体内，不许散落到别处')
  }

  // 取值可以，判定不行：index.tsx 必须真的调这两个出口
  assert.ok(code.includes('shouldShowPanel('), 'index.tsx 必须调用 shouldShowPanel')
  assert.ok(code.includes('panelDataOpen('), 'data-open 投影必须调用 panelDataOpen（I2：与决策同源）')
})

test('三个判定点都改成了调用同一个纯函数（不再各读各的输入）', () => {
  const code = stripComments(INDEX)
  const calls = code.match(/shouldShowPanel\(/g) ?? []
  assert.ok(calls.length >= 2, `至少两处（面板容器 + isDisplayed）要走 shouldShowPanel，实际 ${calls.length} 处`)

  // 三处的 `stateReadable` 来源允许不同（那是取值差异，不是判据差异），
  // 但**判定**必须只有一份实现 —— 见下一条。
  assert.ok(code.includes('panelDataOpen('), 'data-open 也要走同一模块')
})

test('panelState.ts 是纯的：不 import React、不碰 DOM', () => {
  const code = stripComments(PANEL_STATE)
  assert.equal(/from\s+'react/.test(code), false, 'panelState.ts 不得 import React')
  for (const forbidden of ['document.', 'window.', 'getComputedStyle', 'setAttribute', 'querySelector']) {
    assert.equal(code.includes(forbidden), false, `panelState.ts 不得出现 ${forbidden}（要保持可被 node --test 直接测）`)
  }
  // 它只允许依赖常量（PANEL_NAME 的唯一定义处）
  assert.equal(code.includes("from './constants.js'"), true, 'PANEL_NAME 必须复用 constants.ts 的定义，不许再定义一份')
  assert.equal(/export const PANEL_NAME = /.test(code), false, 'panelState.ts 不得重新定义 PANEL_NAME')
})
