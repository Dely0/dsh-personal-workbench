"""D17/P7-2 测试判据重锚：JSX 分四段搬进 src/client/app/ 后，
凡「读 index.tsx 找 JSX / props」的断言都要跟着 owner 走。

口径：正向指新 owner（app/WorkbenchBody.tsx / WorkbenchDialogs.tsx / WorkbenchOverlays.tsx），
入口一侧补负向（`assert.doesNotMatch`，用剥注释文本），这样搬走之后不会空洞通过。

先全部校验（每个 old 片段恰好命中 1 次），有一条不成立就整体中止、不写文件。
"""
import io
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PATCHES = [
    # ============================================================ workspacePickerWiring
    ("test/workspacePickerWiring.test.mjs",
     r"""const TASK_FORMS_HOOK = read('src/client/hooks/useTaskForms.ts')""",
     r"""const TASK_FORMS_HOOK = read('src/client/hooks/useTaskForms.ts')
/** D17/P7-2：四段 JSX 已搬进 src/client/app/ —— 装配层的 JSX owner 在那里。 */
const APP_DIALOGS = read('src/client/app/WorkbenchDialogs.tsx')"""),
    ("test/workspacePickerWiring.test.mjs",
     r"""  // 三个入口的 onBrowse 必须各自指出"选完写回哪" —— 否则浏览完不知道落到谁身上
  for (const target of ["openDirPicker('quick')", "openDirPicker('form')", "openDirPicker('edit')"]) {
    assert.ok(INDEX.includes(target), `缺少 ${target}：浏览弹窗需要知道自己是从哪个入口打开的`)
  }""",
     r"""  // 三个入口的 onBrowse 必须各自指出"选完写回哪" —— 否则浏览完不知道落到谁身上。
  // D17/P7-2：三处调用点都在 app/WorkbenchDialogs.tsx（快速录入弹窗 + 两个任务表单弹窗）。
  for (const target of ["openDirPicker('quick')", "openDirPicker('form')", "openDirPicker('edit')"]) {
    assert.ok(APP_DIALOGS.includes(target),
      `缺少 ${target}：浏览弹窗需要知道自己是从哪个入口打开的（D17/P7-2 起 owner = src/client/app/WorkbenchDialogs.tsx）`)
  }"""),
    ("test/workspacePickerWiring.test.mjs",
     r"""  // 两处用法：知识库(file，默认，已随知识域搬进 views/) + 工作区(dir，仍在入口的快速录入弹窗里)""",
     r"""  // 两处用法：知识库(file，默认，已随知识域搬进 views/) + 工作区(dir，D17/P7-2 起在
  // src/client/app/WorkbenchDialogs.tsx 的快速录入弹窗里)"""),
    ("test/workspacePickerWiring.test.mjs",
     r"""  assert.match(INDEX, /<LocalDocModal/, '工作区那份仍在入口里')
  assert.match(INDEX, /mode="dir"/, '工作区那一处必须显式 dir 模式')""",
     r"""  assert.match(APP_DIALOGS, /<LocalDocModal/,
    '工作区那份仍在装配层（D17/P7-2 起 owner = src/client/app/WorkbenchDialogs.tsx）')
  assert.match(APP_DIALOGS, /mode="dir"/, '工作区那一处必须显式 dir 模式')
  assert.doesNotMatch(INDEX, /<LocalDocModal/, '入口不再有第二处装配（P7-2 后 JSX 全在 app/）')"""),
    # ============================================================ taskDetailWiring
    ("test/taskDetailWiring.test.mjs",
     r"""const contractsSource = read('src/client/app/contracts.ts')""",
     r"""const contractsSource = read('src/client/app/contracts.ts')
/** D17/P7-2：四段 JSX 搬进 app/ —— 详情面板与三路分派的装配点在 WorkbenchBody。 */
const appBodySource = read('src/client/app/WorkbenchBody.tsx')"""),
    ("test/taskDetailWiring.test.mjs",
     r"""  assert.match(indexSource, /onRestoreTask=\{restoreTask\}/, '入口仍把它交给详情面板')""",
     r"""  assert.match(appBodySource, /onRestoreTask=\{restoreTask\}/,
    '仍把它交给详情面板（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）')
  assert.doesNotMatch(stripComments(indexSource), /onRestoreTask=\{restoreTask\}/,
    '入口不留副本（注释不算）')"""),
    ("test/taskDetailWiring.test.mjs",
     r"""  assert.equal((indexSource.match(/<TaskDetailPane/g) ?? []).length, 1, '详情面板装配一处')
  assert.match(indexSource, /: view === 'knowledge'\n\s+\? <KnowledgeDetailPane/,
    '三路分派顺序不变（ideas → knowledge → task）')""",
     r"""  assert.equal((appBodySource.match(/<TaskDetailPane/g) ?? []).length, 1,
    '详情面板装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）')
  assert.doesNotMatch(stripComments(indexSource), /<TaskDetailPane/, '入口不再有第二处装配')
  assert.match(appBodySource, /: view === 'knowledge'\n\s+\? <KnowledgeDetailPane/,
    '三路分派顺序不变（ideas → knowledge → task）')"""),
    # ============================================================ quickIntakeDefaultWiring
    ("test/quickIntakeDefaultWiring.test.mjs",
     r"""const SOURCE = read('src/client/index.tsx')""",
     r"""const SOURCE = read('src/client/index.tsx')
/** D17/P7-2：提交闸门那行随快速录入弹窗搬进 app/WorkbenchDialogs.tsx。 */
const DIALOGS_SOURCE = read('src/client/app/WorkbenchDialogs.tsx')"""),
    ("test/quickIntakeDefaultWiring.test.mjs",
     r"""  const index = SOURCE.indexOf(marker)
  if (index === -1) return null
  const head = SOURCE.slice(0, index)""",
     r"""  const index = DIALOGS_SOURCE.indexOf(marker)
  if (index === -1) return null
  const head = DIALOGS_SOURCE.slice(0, index)"""),
    # ============================================================ quickWorkspaceDefault
    ("test/quickWorkspaceDefault.test.mjs",
     r"""  // 界面上的来源文案只允许来自 quickWorkspaceSourceLabel，不许再内联判断（这条仍读入口）
  const { stripped: indexSource } = readSource('../src/client/index.tsx')
  assert.match(indexSource, /quickWorkspaceSourceLabel\(quickWorkspaceSource\)/)
  assert.equal(/继承自父任务/.test(indexSource), false, '「继承自父任务」这句界面文案已随判定一起删掉')
  // 同义的另一句（审查 F4）：快速录入里 task 恒为 null，clarify 分支明确排除父任务 —— 这句是假的
  assert.equal(/跟随父任务/.test(indexSource), false, '「跟随父任务」在快速录入里永远不成立，不许再写进提示')""",
     r"""  // 界面上的来源文案只允许来自 quickWorkspaceSourceLabel，不许再内联判断。
  // D17/P7-2：快速录入弹窗的 JSX 搬进 app/WorkbenchDialogs.tsx ⇒ 判据跟着 owner 走
  //（正向指新家；入口与组件两边都查负向，搬走之后不会空洞通过）。
  const { stripped: indexSource } = readSource('../src/client/index.tsx')
  const { stripped: dialogsSource } = readSource('../src/client/app/WorkbenchDialogs.tsx')
  assert.match(dialogsSource, /quickWorkspaceSourceLabel\(quickWorkspaceSource\)/,
    '来源提示必须由 quickWorkspaceSourceLabel 给出（D17/P7-2 起 owner = app/WorkbenchDialogs.tsx）')
  for (const [label, src] of [['入口', indexSource], ['app/WorkbenchDialogs.tsx', dialogsSource]]) {
    assert.equal(/继承自父任务/.test(src), false, `${label}：「继承自父任务」这句界面文案已随判定一起删掉`)
    // 同义的另一句（审查 F4）：快速录入里 task 恒为 null，clarify 分支明确排除父任务 —— 这句是假的
    assert.equal(/跟随父任务/.test(src), false, `${label}：「跟随父任务」在快速录入里永远不成立，不许再写进提示`)
  }"""),
    ("test/quickWorkspaceDefault.test.mjs",
     r"""  const { stripped } = readSource('../src/client/index.tsx')
  assert.match(stripped, /shouldRememberQuickWorkspace\(quickWorkspaceTouched, chosen\)/,
    'rememberQuickWorkspace 的调用必须先问 shouldRememberQuickWorkspace')
  assert.equal(/if \(chosen !== ''\) void rememberQuickWorkspace/.test(stripped), false,
    '不许退回"只要非空就记"：自动预填的值会被记成"上次手动选择"，下一轮就是默认值')""",
     r"""  const { stripped } = readSource('../src/client/index.tsx')
  // D17/P7-2：这一行随快速录入弹窗搬进 app/WorkbenchDialogs.tsx ⇒ 正向指新家；
  // 入口与组件两边都查负向，这样"搬走之后空洞通过"也不会发生。
  const { stripped: gateSource } = readSource('../src/client/app/WorkbenchDialogs.tsx')
  assert.match(gateSource, /shouldRememberQuickWorkspace\(quickWorkspaceTouched, chosen\)/,
    'rememberQuickWorkspace 的调用必须先问 shouldRememberQuickWorkspace（D17/P7-2 起 owner = app/WorkbenchDialogs.tsx）')
  for (const [label, src] of [['入口', stripped], ['app/WorkbenchDialogs.tsx', gateSource]]) {
    assert.equal(/if \(chosen !== ''\) void rememberQuickWorkspace/.test(src), false,
      `${label}：不许退回"只要非空就记"：自动预填的值会被记成"上次手动选择"，下一轮就是默认值`)
  }"""),
    ("test/quickWorkspaceDefault.test.mjs",
     r"""  assert.match(stripped,
    /showForget=\{quickWorkspaceSource === 'last-manual' && !quickWorkspaceTouched\}/,
    '「不再记住」的显示条件必须仍由判定给出（判定说"上次手动选择"且用户没动过）')
  assert.match(stripped, /onForget=\{\(\) => void forgetQuickWorkspace\(quickWorkspace\)\}/,
    '按钮必须真的调用 forgetQuickWorkspace')""",
     r"""  assert.match(gateSource,
    /showForget=\{quickWorkspaceSource === 'last-manual' && !quickWorkspaceTouched\}/,
    '「不再记住」的显示条件必须仍由判定给出（D17/P7-2 起 owner = app/WorkbenchDialogs.tsx）')
  assert.match(gateSource, /onForget=\{\(\) => void forgetQuickWorkspace\(quickWorkspace\)\}/,
    '按钮必须真的调用 forgetQuickWorkspace')
  assert.doesNotMatch(stripped, /showForget=\{quickWorkspaceSource === 'last-manual' && !quickWorkspaceTouched\}/,
    '入口不再有第二处装配（P7-2 后 JSX 全在 app/）')
  assert.doesNotMatch(stripped, /onForget=\{\(\) => void forgetQuickWorkspace\(quickWorkspace\)\}/,
    '入口不再有第二处装配（P7-2 后 JSX 全在 app/）')"""),
    # ============================================================ personaWiring
    ("test/personaWiring.test.mjs",
     r"""const componentSource = read('src/client/components/PersonaPicker.tsx')""",
     r"""const componentSource = read('src/client/components/PersonaPicker.tsx')
/** D17/P7-2：四段 JSX 搬进 app/ —— 提示词弹窗在 overlays、快速录入弹窗在 dialogs。 */
const overlaysSource = read('src/client/app/WorkbenchOverlays.tsx')
const dialogsSource = read('src/client/app/WorkbenchDialogs.tsx')
const appUiSource = [overlaysSource, dialogsSource].join('\n')"""),
    ("test/personaWiring.test.mjs",
     r"""  assert.equal((entry.match(/<PersonaPicker/g) ?? []).length, 2, '提示词弹窗 + 快速录入弹窗各一个（同一个组件）')""",
     r"""  assert.equal((appUiSource.match(/<PersonaPicker/g) ?? []).length, 2,
    '提示词弹窗 + 快速录入弹窗各一个（同一个组件；D17/P7-2 起在 app/WorkbenchOverlays.tsx 与 app/WorkbenchDialogs.tsx）')
  assert.equal((entry.match(/<PersonaPicker/g) ?? []).length, 0, '入口不再装配（P7-2 后 JSX 全在 app/）')"""),
    ("test/personaWiring.test.mjs",
     r"""  const modalAt = indexSource.indexOf('{promptModal !== null && (')
  const personaAt = indexSource.indexOf('<PersonaPicker', modalAt)
  const skillAt = indexSource.indexOf('<SkillPicker', modalAt)""",
     r"""  // D17/P7-2：提示词弹窗的 JSX 在 app/WorkbenchOverlays.tsx ⇒ 顺序断言跟着 owner 走。
  const modalAt = overlaysSource.indexOf('{promptModal !== null && (')
  const personaAt = overlaysSource.indexOf('<PersonaPicker', modalAt)
  const skillAt = overlaysSource.indexOf('<SkillPicker', modalAt)"""),
    # ============================================================ quickIntakeClient
    ("test/quickIntakeClient.test.mjs",
     r"""  const index = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const code = index.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')""",
     r"""  // D17/P7-2：两个弹窗的 JSX 分别搬进 app/WorkbenchOverlays.tsx（共享提示词）与
  // app/WorkbenchDialogs.tsx（快速录入）⇒ 计数扫两份，顺序断言只扫提示词弹窗那一份。
  const overlays = readFileSync(new URL('../src/client/app/WorkbenchOverlays.tsx', import.meta.url), 'utf8')
  const dialogs = readFileSync(new URL('../src/client/app/WorkbenchDialogs.tsx', import.meta.url), 'utf8')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const code = strip(overlays) + '\n' + strip(dialogs)
  const promptModalCode = strip(overlays)"""),
    ("test/quickIntakeClient.test.mjs",
     r"""  const promptModal = code.slice(code.indexOf('{promptModal !== null && ('), code.indexOf('wb-modal-actions', code.indexOf('{promptModal !== null && (')))""",
     r"""  const promptModal = promptModalCode.slice(promptModalCode.indexOf('{promptModal !== null && ('),
    promptModalCode.indexOf('wb-modal-actions', promptModalCode.indexOf('{promptModal !== null && (')))"""),
    # ============================================================ knowledgeRecallRoutes
    ("test/knowledgeRecallRoutes.test.mjs",
     r"""  assert.match(index, /recallLog=\{recallLog\}/, '状态要传进设置弹窗（否则开关点了没用）')""",
     r"""  // D17/P7-2：SettingsModal 的这处装配随主体 JSX 搬进 app/WorkbenchBody.tsx ⇒ 判据跟着 owner 走。
  const appBody = readFileSync('src/client/app/WorkbenchBody.tsx', 'utf8').replace(/\r\n/g, '\n')
  assert.match(appBody, /recallLog=\{recallLog\}/,
    '状态要传进设置弹窗（否则开关点了没用；D17/P7-2 起 owner = app/WorkbenchBody.tsx）')
  assert.doesNotMatch(index, /recallLog=\{recallLog\}/, '入口不再有第二处装配')"""),
    # ============================================================ progressWiring
    ("test/progressWiring.test.mjs",
     r"""  assert.match(clientIndex, /pending=\{pendingMap\}/, '列表树必须接到这份投影')""",
     r"""  // D17/P7-2：列表/详情的装配随主体 JSX 搬进 app/WorkbenchBody.tsx ⇒ 判据跟着 owner 走。
  assert.match(read('src/client/app/WorkbenchBody.tsx'), /pending=\{pendingMap\}/,
    '列表树必须接到这份投影（D17/P7-2 起 owner = app/WorkbenchBody.tsx）')
  assert.doesNotMatch(stripComments(clientIndex), /pending=\{pendingMap\}/, '入口不再有第二处装配')"""),
    # ============================================================ draftBannerSessionJump
    ("test/draftBannerSessionJump.test.mjs",
     r"""  // index.tsx 必须把它接到"清掉当前弹框"上，而不是接到带刷新的 onDone
  const indexSource = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.match(indexSource, /onSettled=\{\(\) => setPendingDraft\(null\)\}/,
    'index.tsx 必须把 onSettled 接到 setPendingDraft(null)')""",
     r"""  // D17/P7-2：DraftBanner 的这处装配随提示层 JSX 搬进 app/WorkbenchOverlays.tsx ⇒ 判据跟着 owner 走。
  const overlaysSource = readFileSync(new URL('../src/client/app/WorkbenchOverlays.tsx', import.meta.url), 'utf8')
  assert.match(overlaysSource, /onSettled=\{\(\) => setPendingDraft\(null\)\}/,
    'app/WorkbenchOverlays.tsx 必须把 onSettled 接到 setPendingDraft(null)')
  const indexSource = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.equal(indexSource.includes('onSettled={() => setPendingDraft(null)}'), false,
    '入口不再有第二处装配（P7-2 后 JSX 全在 app/）')"""),
]

plans = {}
for path, old, new in PATCHES:
    src = open(path, encoding="utf-8", newline="").read().replace("\r\n", "\n")
    n = src.count(old)
    if n == 0 and src.count(new) == 1:
        continue
    if n != 1:
        print(f"ABORT：{path} 里 old 片段命中 {n} 次（要求恰好 1 次）\n  >>> {old[:140]}")
        sys.exit(1)
    plans.setdefault(path, []).append((old, new))

for path, items in plans.items():
    src = open(path, encoding="utf-8", newline="").read().replace("\r\n", "\n")
    for old, new in items:
        assert src.count(old) == 1, path
        src = src.replace(old, new, 1)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(src)
    print(f"✔ 已重锚 {path}（{len(items)} 处）")

print("\n结果：全部重锚完成")
