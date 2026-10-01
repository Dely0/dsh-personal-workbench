/**
 * 批次2 #2（AX-W01/W03）：工作区候选与「浏览本地目录」请求形状的纯函数测试。
 *
 * 这两块都是"同一个语义只允许一处实现"的落点，所以断言重点是**口径**而不是实现细节：
 * 去重必须走全项目的 `recentWorkspaceKey`、顺序必须固定、哨兵必须只有一种拼法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WORKSPACE_CANDIDATE_LIMIT, candidatePlaceholder, selectedCandidatePath, workspaceCandidateLabel, workspaceCandidates,
} from '../lib/client/workspacePicker.js'
import { LOCAL_DIR_ROUTE, ROOTS_PARENT, localDirRequestUrl } from '../lib/client/localDirBrowser.js'

test('workspaceCandidates: 顺序固定为 已打开 → 最近 → 默认', () => {
  const out = workspaceCandidates({
    open: ['D:\\Code\\A'],
    recent: ['D:\\Code\\B'],
    defaultWorkspace: 'D:\\Code\\C',
  })
  assert.deepEqual(out, [
    { path: 'D:\\Code\\A', source: 'open' },
    { path: 'D:\\Code\\B', source: 'recent' },
    { path: 'D:\\Code\\C', source: 'default' },
  ])
})

test('workspaceCandidates: 去重走 recentWorkspaceKey（大小写 / 分隔符 / 尾斜杠算同一个）', () => {
  const out = workspaceCandidates({
    // 三种写法在 Windows 上指同一个目录；保留**最靠前**那条的原文（已打开优先）
    open: ['D:\\Code\\X'],
    recent: ['d:/code/x/', 'D:\\Code\\Y'],
    defaultWorkspace: 'D:\\CODE\\X',
  })
  assert.deepEqual(out, [
    { path: 'D:\\Code\\X', source: 'open' },
    { path: 'D:\\Code\\Y', source: 'recent' },
  ], '同键的候选只留最靠前那条原文；默认值若是重复项不该再出现')
})

test('workspaceCandidates: 空值、非字符串、空白项都被丢掉（不静默留一个空选项）', () => {
  const out = workspaceCandidates({
    open: ['', '   ', null, undefined, 42],
    recent: ['D:\\Code\\A'],
    defaultWorkspace: '',
  })
  assert.deepEqual(out, [{ path: 'D:\\Code\\A', source: 'recent' }])
})

test('workspaceCandidates: 截断到上限，且是"保留靠前的"而不是随机丢', () => {
  const many = Array.from({ length: 20 }, (_, i) => `D:\\Code\\P${i}`)
  const out = workspaceCandidates({ open: many })
  assert.equal(out.length, WORKSPACE_CANDIDATE_LIMIT)
  assert.equal(out[0].path, 'D:\\Code\\P0')
  assert.equal(out[out.length - 1].path, `D:\\Code\\P${WORKSPACE_CANDIDATE_LIMIT - 1}`)
})

test('workspaceCandidateLabel / candidatePlaceholder: 文案是给用户看的中文，空列表要说清原因', () => {
  assert.equal(workspaceCandidateLabel('open'), '已打开')
  assert.equal(workspaceCandidateLabel('recent'), '最近')
  assert.equal(workspaceCandidateLabel('default'), '默认')
  assert.match(candidatePlaceholder([]), /没有已打开的工作区/, '没候选时必须说原因，不能给一个空下拉')
  assert.match(candidatePlaceholder([{ path: 'D:\\x', source: 'open' }]), /选择已有工作区/)
})

test('selectedCandidatePath: 同键才算选中；手打的自定义路径落回空（不改写用户输入）', () => {
  const candidates = workspaceCandidates({ open: ['D:\\Code\\A'] })
  assert.equal(selectedCandidatePath('D:\\Code\\A', candidates), 'D:\\Code\\A')
  assert.equal(selectedCandidatePath('d:/code/a/', candidates), 'D:\\Code\\A', '同键必须认出来，否则下拉显示成"未选择"')
  assert.equal(selectedCandidatePath('D:\\Code\\Other', candidates), '', '不同目录 → 空（界面不猜）')
  assert.equal(selectedCandidatePath('', candidates), '')
})

test('localDirRequestUrl: 不传 path = 主目录；传哨兵 = 盘符列表；其余要编码', () => {
  assert.equal(localDirRequestUrl(undefined), LOCAL_DIR_ROUTE, '不传 path 时后端默认主目录（保留原行为）')
  assert.equal(localDirRequestUrl(''), LOCAL_DIR_ROUTE)
  assert.equal(localDirRequestUrl(null), LOCAL_DIR_ROUTE)
  assert.equal(localDirRequestUrl(ROOTS_PARENT), `${LOCAL_DIR_ROUTE}?path=${encodeURIComponent(ROOTS_PARENT)}`,
    '哨兵必须显式传过去，否则「此电脑」那一层进不去（历史上就是这样卡在 C 盘）')
  assert.equal(localDirRequestUrl('D:\\Code\\我的项目'), `${LOCAL_DIR_ROUTE}?path=${encodeURIComponent('D:\\Code\\我的项目')}`,
    '非 ASCII 路径必须编码')
})

test('ROOTS_PARENT 仍是后端那个哨兵值（改了会让"此电脑"整层失效）', () => {
  assert.equal(ROOTS_PARENT, '\u0000roots')
})
