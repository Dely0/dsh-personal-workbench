/**
 * 浮层摆放算法与键盘落点的单测（v1.15.2 修「快速录入 → 模型选择框被遮挡」）。
 *
 * 这个文件守的是**判定表**，不是"某个像素看起来对不对"：
 * 真事故的成因是"浮层只会朝上开、不看可用空间，多出来的部分被
 * `.wb-dialog-body` 的滚动容器裁掉"。所以每条断言都对应一句承诺：
 * 菜单要么完整可见，要么**收敛到可用高度**，永远不许越出可视区。
 *
 * 浏览器里的像素级对照不放这里（那是 `scripts/repro/repro-model-picker-occlusion.mjs`
 * 的活：真 CSS + 真浏览器量 getBoundingClientRect）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  POPOVER_GAP, POPOVER_MARGIN, placePopover, samePlacement, stepIndex,
} from '../lib/client/popoverPlacement.js'

const anchor = (top, left, width = 200) => ({ top, bottom: top + 35, left, right: left + width })
const rect = (placement) => ({
  left: placement.left,
  right: placement.left + placement.width,
  top: placement.top,
  bottom: placement.top + placement.height,
})

test('上下都放得下时保持原方向（朝上），且贴着触发元素左边界', () => {
  const p = placePopover({
    anchor: anchor(600, 300), menu: { width: 320, height: 262 }, viewport: { width: 1440, height: 900 },
  })
  assert.equal(p.side, 'top')
  assert.equal(p.height, 262, '空间足够就不许收敛高度')
  assert.equal(p.left, 300)
  assert.equal(p.top, 600 - POPOVER_GAP - 262)
})

test('【本次事故】真实几何：修前被滚动容器裁掉 48%，修后必须完整可见', () => {
  // repro 脚本在 1440x900 下量到的矩形：触发按钮在弹窗中下部（top≈438、bottom≈473、left≈626），
  // 修前浮层留在 `.wb-dialog-body` 里、只朝上开 → 只有 ~48% 可见，
  // 「跟随 DSH 默认模型」与前几个模型正好在被裁掉的那一段。
  // 修后浮层 portal 到 body，约束变成**视口**：上方有 ~430px，整块放得下。
  const p = placePopover({
    anchor: anchor(438, 626), menu: { width: 320, height: 262 }, viewport: { width: 1440, height: 900 },
  })
  assert.equal(p.height, 262, '菜单必须完整显示（修前这里只剩 ~126px 可见）')
  assert.equal(p.side, 'top', '视口上方空间够，保持原方向（朝上）')
  const box = rect(p)
  assert.ok(box.top >= POPOVER_MARGIN && box.bottom <= 900 - POPOVER_MARGIN, `整块落在视口内：${JSON.stringify(box)}`)
})

test('上方放不下时必须翻转到下方（这正是原实现完全缺的一步）', () => {
  // 触发按钮靠近视口顶部（矮窗口、或弹窗内部滚动过之后）
  const p = placePopover({
    anchor: anchor(200, 400), menu: { width: 320, height: 262 }, viewport: { width: 1440, height: 900 },
  })
  assert.equal(p.side, 'bottom', '上方只有 186px，放不下 262px 的菜单 → 必须翻到下方')
  assert.equal(p.top, 235 + POPOVER_GAP)
  assert.equal(p.height, 262, '翻到下方之后要完整显示')
})

test('上下都不够（小窗口 + 弹窗内滚动过）→ 选空间大的一侧并把高度收敛到可用值', () => {
  // 实测数据（1000x400，弹窗滚动 45px 后触发按钮被顶到 top=172）
  const p = placePopover({
    anchor: anchor(172, 190), menu: { width: 320, height: 262 }, viewport: { width: 1000, height: 400 },
  })
  assert.equal(p.side, 'bottom')
  assert.equal(p.height, 400 - 207 - POPOVER_GAP - POPOVER_MARGIN, '收敛到下方可用高度')
  assert.ok(p.height < 262, '确实被收敛了（否则一定越界）')
  const box = rect(p)
  assert.ok(box.top >= POPOVER_MARGIN && box.bottom <= 400 - POPOVER_MARGIN, `不许越出视口：${JSON.stringify(box)}`)
})

test('贴右边界时向左挪，贴左边界时向右挪（水平也要收敛）', () => {
  const nearRight = placePopover({
    anchor: anchor(300, 1200), menu: { width: 320, height: 200 }, viewport: { width: 1280, height: 900 },
  })
  assert.equal(nearRight.left, 1280 - POPOVER_MARGIN - 320)
  assert.ok(rect(nearRight).right <= 1280 - POPOVER_MARGIN)

  const nearLeft = placePopover({
    anchor: anchor(300, -40), menu: { width: 320, height: 200 }, viewport: { width: 1280, height: 900 },
  })
  assert.equal(nearLeft.left, POPOVER_MARGIN)
})

test('视口比菜单还窄时收窄宽度，绝不越出右边', () => {
  const p = placePopover({
    anchor: anchor(300, 10), menu: { width: 320, height: 200 }, viewport: { width: 300, height: 900 },
  })
  assert.equal(p.width, 300 - POPOVER_MARGIN * 2)
  assert.ok(rect(p).left >= POPOVER_MARGIN && rect(p).right <= 300 - POPOVER_MARGIN)
})

test('极端小视口：宁可变矮（甚至 0 高）也不画到可视区外', () => {
  const p = placePopover({
    anchor: anchor(60, 20), menu: { width: 320, height: 262 }, viewport: { width: 400, height: 120 },
  })
  assert.ok(p.height >= 0 && p.height <= 262)
  const box = rect(p)
  assert.ok(box.top >= POPOVER_MARGIN - 0.001, `top 不许为负：${box.top}`)
  assert.ok(box.bottom <= 120 - POPOVER_MARGIN + 0.001, `bottom 不许越界：${box.bottom}`)
})

test('遍历一批锚点/视口组合：菜单盒必须永远落在视口内（不变量）', () => {
  const viewports = [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1000, height: 520 }, { width: 800, height: 360 }]
  const violations = []
  for (const viewport of viewports) {
    for (let top = -20; top <= viewport.height + 20; top += 37) {
      for (const left of [-40, 8, 120, viewport.width - 400, viewport.width + 40]) {
        const p = placePopover({ anchor: anchor(top, left), menu: { width: 320, height: 262 }, viewport })
        const box = rect(p)
        if (box.top < POPOVER_MARGIN - 0.001 || box.bottom > viewport.height - POPOVER_MARGIN + 0.001) {
          violations.push(`viewport=${JSON.stringify(viewport)} anchor.top=${top} → ${JSON.stringify(box)}`)
        }
        if (box.left < POPOVER_MARGIN - 0.001 || box.right > viewport.width - POPOVER_MARGIN + 0.001) {
          violations.push(`viewport=${JSON.stringify(viewport)} anchor.left=${left} → ${JSON.stringify(box)}`)
        }
        if (p.height > 262.001) violations.push(`高度超过了菜单自然高：${p.height}`)
      }
    }
  }
  assert.deepEqual(violations, [], `这些组合越出了可视区：\n  - ${violations.slice(0, 8).join('\n  - ')}`)
})

/**
 * 回归 v1.15.2 复审：**菜单比视口还高**时，"盒子永远在视口内"曾经是假保证。
 *
 * 真实缺陷（审查探针 B，17694 组参数里 2323 组越界）：第一版只把高度收敛到
 * "锚点那一侧的空间"，而锚点自己可以在视口外 —— 实测几何是
 * `anchor.top = -94`、视口 1000x400、菜单自然高 450：`side=bottom` 那侧算出 445px 可用，
 * 比整个视口（去掉上下边距只剩 384px）还大，盒子下沿因此跑到视口外 53px；
 * 而打开「快速录入」时 `Modal` 把 `body` 锁成 `overflow: hidden`，这 53px 谁也没办法滚到。
 *
 * 上面那条不变量扫描当时用的是"菜单 262 < 所有视口高"，正好漏掉这一档 —— 所以这里单独钉死。
 */
test('回归 v1.15.2 复审：菜单比视口还高时，高度必须再受视口约束', () => {
  const cases = [
    { label: '文档场景 A：1000x400、锚点在视口上方 + 长列表 450px', anchor: anchor(-94, 190), menu: { width: 320, height: 450 }, viewport: { width: 1000, height: 400 } },
    { label: '文档场景 B：同上 + 更长的列表 700px', anchor: anchor(-94, 190), menu: { width: 320, height: 700 }, viewport: { width: 1000, height: 400 } },
    { label: '锚点贴视口下沿：anchor.top=399 + 450px', anchor: anchor(399, 190), menu: { width: 320, height: 450 }, viewport: { width: 1000, height: 400 } },
    { label: '极矮视口：262px 视口 + 360px 菜单', anchor: anchor(120, 20), menu: { width: 320, height: 360 }, viewport: { width: 420, height: 262 } },
  ]
  for (const item of cases) {
    const p = placePopover({ anchor: item.anchor, menu: item.menu, viewport: item.viewport })
    const box = rect(p)
    assert.ok(p.height <= item.viewport.height - POPOVER_MARGIN * 2 + 0.001,
      `${item.label}：高度没有被视口约束（height=${p.height} > ${item.viewport.height - POPOVER_MARGIN * 2}）`)
    assert.ok(box.bottom <= item.viewport.height - POPOVER_MARGIN + 0.001,
      `${item.label}：盒子下沿越出视口（bottom=${box.bottom} > ${item.viewport.height - POPOVER_MARGIN}）`)
    assert.ok(box.top >= POPOVER_MARGIN - 0.001, `${item.label}：top=${box.top} < margin`)
  }
})

test('回归 v1.15.2 复审：非有限输入不许传染成 NaN 定位（量不到时给确定值）', () => {
  const nan = placePopover({
    anchor: { top: Number.NaN, bottom: Number.NaN, left: Number.NaN, right: Number.NaN },
    menu: { width: Number.NaN, height: Number.NaN },
    viewport: { width: 1440, height: 900 },
  })
  for (const [key, value] of Object.entries(nan)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} 不是有限数：${value}`)
  }
  assert.ok(nan.left >= POPOVER_MARGIN && nan.top >= POPOVER_MARGIN, '退化后仍要落在视口内')

  const badMenuHeight = placePopover({
    anchor: anchor(300, 300), menu: { width: 320, height: Number.POSITIVE_INFINITY }, viewport: { width: 1440, height: 900 },
  })
  assert.ok(Number.isFinite(badMenuHeight.height) && badMenuHeight.height <= 900 - POPOVER_MARGIN * 2)
})

test('samePlacement 只在真的变了的时候返回 false（避免同值重写自激）', () => {
  const base = placePopover({ anchor: anchor(600, 300), menu: { width: 320, height: 262 }, viewport: { width: 1440, height: 900 } })
  assert.equal(samePlacement(base, { ...base }), true)
  for (const key of ['side', 'left', 'top', 'width', 'maxHeight']) {
    assert.equal(samePlacement(base, { ...base, [key]: key === 'side' ? 'bottom' : base[key] + 1 }), false, key)
  }
})

test('stepIndex：从触发按钮出发、到边界停住、空列表返回 -1', () => {
  assert.equal(stepIndex(-1, 1, 4), 0, '焦点还在按钮上时按 ↓ → 第一项')
  assert.equal(stepIndex(-1, -1, 4), 3, '焦点还在按钮上时按 ↑ → 最后一项')
  assert.equal(stepIndex(0, 1, 4), 1)
  assert.equal(stepIndex(3, 1, 4), 3, '到底了停住（不环绕）')
  assert.equal(stepIndex(0, -1, 4), 0, '到顶了停住')
  assert.equal(stepIndex(-1, 1, 0), -1, '没有选项')
  assert.equal(stepIndex(-1, 1, 1), 0)
})
