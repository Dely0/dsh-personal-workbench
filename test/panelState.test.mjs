/**
 * 表驱动单测：**面板可见性的唯一权威源**（设计文档 I1 / I2，阶段 1 出口判据之一）。
 *
 * 覆盖 `panelState.ts` 决策表的**全部 5 行**，并钉住三条不变量：
 *
 * 1. `show === true` ⟺ 面板容器 `data-open="1"`（I2：决策与投影一致）；
 * 2. 宿主状态可读时**本地意图不参与判断**（否则回到"两套判据互相否决"的老 bug）；
 * 3. 判定结果是**纯函数**：同样输入永远同样输出、不改输入、返回的 `because` 能解释原因。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PANEL_NAME, decidePanel, panelDataOpen, shouldShowPanel } from '../lib/client/panelState.js'

const snapshot = (overrides = {}) => ({
  stateReadable: true,
  hostPanelId: null,
  intentOpen: false,
  ...overrides,
})

test('决策表逐行：宿主状态可读时只信宿主 activePanelId', () => {
  // 第 1 行：宿主选中我们 → 显示（本地意图无论真假都不参与）
  assert.deepEqual(decidePanel(snapshot({ hostPanelId: PANEL_NAME, intentOpen: false })), { show: true },
    '宿主选中我们时必须显示 —— 即使本地 intentOpen 为假（用户点的是宿主官方行，我们的 setOpen 从没被调用过）')
  assert.deepEqual(decidePanel(snapshot({ hostPanelId: PANEL_NAME, intentOpen: true })), { show: true })

  // 第 2 行：宿主明确"没选中任何面板" → 不显示，原因是 not-selected
  assert.deepEqual(decidePanel(snapshot({ hostPanelId: null, intentOpen: true })), { show: false, because: 'not-selected' },
    '宿主说没选中时不能显示 —— 即使本地 intentOpen 为真（否则会出现"关掉后再点官方行打不开/两套判据打架"）')
  assert.deepEqual(decidePanel(snapshot({ hostPanelId: null, intentOpen: false })), { show: false, because: 'not-selected' })

  // 第 3 行：宿主选中了别的面板 → 不显示，原因是 host-selected-other（可区分于上一行，便于排障）
  assert.deepEqual(decidePanel(snapshot({ hostPanelId: 'some-other-panel', intentOpen: true })), { show: false, because: 'host-selected-other' })
  assert.deepEqual(decidePanel(snapshot({ hostPanelId: 'some-other-panel', intentOpen: false })), { show: false, because: 'host-selected-other' })
})

test('决策表逐行：宿主状态不可读时退回本地意图', () => {
  // 第 4 行：不可读 + 用户开着 → 显示
  assert.deepEqual(decidePanel(snapshot({ stateReadable: false, intentOpen: true })), { show: true })
  // 第 5 行：不可读 + 用户关着 → 不显示，原因是 intent-closed
  assert.deepEqual(decidePanel(snapshot({ stateReadable: false, intentOpen: false })), { show: false, because: 'intent-closed' })
})

test('不可读时**完全不读** hostPanelId（第 4/5 行与它的值无关）', () => {
  const values = [PANEL_NAME, null, 'other', '']
  for (const hostPanelId of values) {
    assert.deepEqual(decidePanel({ stateReadable: false, hostPanelId, intentOpen: true }), { show: true },
      `不可读 + intentOpen=true 时，hostPanelId=${JSON.stringify(hostPanelId)} 不该影响结果`)
    assert.deepEqual(decidePanel({ stateReadable: false, hostPanelId, intentOpen: false }), { show: false, because: 'intent-closed' })
  }
})

test('I2：决策结果与渲染投影 data-open 必须一致', () => {
  const cases = [
    { snapshot: snapshot({ hostPanelId: PANEL_NAME }), expected: '1' },
    { snapshot: snapshot({ hostPanelId: null }), expected: undefined },
    { snapshot: snapshot({ hostPanelId: 'other' }), expected: undefined },
    { snapshot: snapshot({ stateReadable: false, intentOpen: true }), expected: '1' },
    { snapshot: snapshot({ stateReadable: false, intentOpen: false }), expected: undefined },
  ]
  for (const { snapshot: snap, expected } of cases) {
    assert.equal(panelDataOpen(snap), expected, `投影与决策不一致：${JSON.stringify(snap)}`)
    // show 与 data-open 必须同真同假（同一份判定的两种出口）
    assert.equal(shouldShowPanel(snap), expected === '1')
  }
})

test('纯函数性：不改输入、同输入同输出', () => {
  const input = { stateReadable: true, hostPanelId: PANEL_NAME, intentOpen: false }
  const frozen = Object.freeze({ ...input })
  const first = decidePanel(frozen)
  const second = decidePanel(frozen)
  assert.deepEqual(first, second, '同样输入必须永远同样输出')
  assert.deepEqual(frozen, input, '判定不得修改输入快照')

  // 结果对象是"描述"而不是"引用"：调用方无法通过返回值反改内部状态
  assert.equal(typeof first.show, 'boolean')
})

test('PANEL_NAME 是唯一的宿主面板标识（换值必须同步改宿主注册处）', () => {
  assert.equal(PANEL_NAME, 'personal-workbench')
  // 判定里硬编码的是这个常量本身，所以只要它和槽位注册一致就不会错位
  assert.deepEqual(decidePanel({ stateReadable: true, hostPanelId: 'personal-workbench', intentOpen: false }), { show: true })
})
