/**
 * 回归（源码级不变量）：**「回到…会话」必须同步收掉草稿横幅**。
 *
 * ## 为什么要用源码扫描而不是渲染测试
 *
 * 这条 bug 的本质是**调用时序**（"谁在同一个 tick 里被调用"），而客户端产物是打不开的
 * CommonJS 单文件、`.tsx` 在本机 Node 里也没有可用的转译器（`tsx` 没装、
 * `node:module.stripTypeScriptTypes` 只吃 `.ts` 不吃 `.tsx`）。
 * 与其为了测试去装一套 DOM 环境，不如把**不变的顺序**直接钉在源码上 ——
 * 这与设计文档第 7 节对 I4/I5/I6 的做法一致："把政策变成编译期就能失败的约束"。
 *
 * ## 钉住的三条
 *
 * 1. `sessions.open(...)` → `onDismissed?.()` → `onSettled?.()` **同步相邻**，
 *    中间不得插入 `setTimeout` / `await`（否则界面要等下一轮 5 秒轮询才消失）。
 * 2. `closePanel()` 必须在 `setTimeout` 里（2026-09-15 修好的顺序：
 *    同步收面板会打断宿主的会话切换，表现为"弹框没了但界面还停在工作台"）。
 * 3. 那条 `setTimeout` 回调里**只能**收面板，不能再收横幅（职责分离）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../src/client/components/DraftBanner.tsx', import.meta.url), 'utf8')

/** 用大括号配平截出某个函数的函数体（不用正则硬啃嵌套）。 */
function functionBody(source, declaration) {
  const start = source.indexOf(declaration)
  assert.notEqual(start, -1, `源码里必须能找到 ${declaration}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`${declaration} 的函数体没有配平`)
}

const body = functionBody(SOURCE, 'const openSession = (): void =>')

/** 去掉注释，避免文档里的示例文字被当成真实调用。 */
const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

test('「回到…会话」的收横幅动作必须同步执行（不得被 setTimeout / await 推迟）', () => {
  const openAt = code.indexOf('.open(')
  const dismissAt = code.indexOf('onDismissed?.()')
  const settledAt = code.indexOf('onSettled?.()')
  assert.notEqual(openAt, -1, '必须先发起会话切换（sessions.open）')
  assert.notEqual(dismissAt, -1, '必须登记屏蔽（onDismissed）')
  assert.notEqual(settledAt, -1, '必须同步收掉投影（onSettled → setPendingDraft(null)）')

  // 顺序：切会话 → 登记屏蔽 → 收投影
  assert.ok(openAt < dismissAt && dismissAt < settledAt, '顺序必须是 open → onDismissed → onSettled')

  /**
   * 关键判据：这三步之间**不能**出现 setTimeout / await。
   *
   * 旧实现把 `closePanel()` 包进 `setTimeout(0)`，收横幅也被一起推后；
   * 加上 `onDismissed` 只登记屏蔽、不改投影，界面就只能等下一轮 5 秒轮询
   * —— 用户实测的"过 5 秒弹框才消失"。
   */
  const between = code.slice(openAt, settledAt + 'onSettled?.()'.length)
  assert.equal(/setTimeout|await\s/.test(between), false,
    '切会话 → 收横幅 之间不得插入 setTimeout/await（会把"立刻消失"退化成"等轮询"）')
})

test('收面板必须延后到宏任务，且那条回调只能收面板', () => {
  const timerAt = code.indexOf('window.setTimeout(')
  assert.notEqual(timerAt, -1, 'closePanel 必须在 window.setTimeout 里延后（否则打断宿主的会话切换）')

  // 同步阶段不得出现 closePanel
  const syncPart = code.slice(0, timerAt)
  assert.equal(syncPart.includes('closePanel'), false, '同步阶段不能收面板')

  /**
   * 只截 `window.setTimeout(` 到它自己的 `}, 0)` —— 不能用 `body.indexOf('}, 0)')`，
   * 那会一路扫到函数末尾，把后面的同步代码也算进来（第一版就这样误报了自己）。
   * 这里用括号配平精确取出箭头函数的函数体。
   */
  const arrowOpen = code.indexOf('{', timerAt)
  let depth = 0
  let arrowClose = -1
  for (let i = arrowOpen; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) { arrowClose = i; break }
    }
  }
  assert.notEqual(arrowClose, -1, 'setTimeout 的箭头函数体没能配平')
  const timerBody = code.slice(arrowOpen + 1, arrowClose)

  assert.ok(timerBody.includes('closePanel()'), 'setTimeout 回调里要收面板')
  assert.equal(timerBody.includes('onDismissed'), false, 'setTimeout 回调里不应再收横幅（onDismissed）')
  assert.equal(timerBody.includes('onSettled'), false, 'setTimeout 回调里不应再收横幅（onSettled）')
})

test('onSettled 的语义必须与 onDone 分开（前者不触发数据刷新）', () => {
  const propsBlock = functionBody(SOURCE, 'const openSession')
  assert.equal(propsBlock.includes('onDone?.()'), false, '回到会话不该触发 onDone（那会顺带刷一轮数据）')
  assert.ok(SOURCE.includes('onSettled?: () => void'), '接口里必须有 onSettled（=纯投影更新）')

  // index.tsx 必须把它接到"清掉当前弹框"上，而不是接到带刷新的 onDone
  const indexSource = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.match(indexSource, /onSettled=\{\(\) => setPendingDraft\(null\)\}/,
    'index.tsx 必须把 onSettled 接到 setPendingDraft(null)')
})
