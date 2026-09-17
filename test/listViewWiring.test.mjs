import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 接线不变量（源码级扫描）。
 *
 * 组件本身由 `test/listViews.test.mjs` 渲染着测；这里只锁**接线**上那些"删掉也不会报错、
 * 但会让功能悄悄退化"的点 —— 本项目规范要求「政策要变成会失败的测试，不要写成注释」。
 */
const indexSource = readFileSync('src/client/index.tsx', 'utf8')
const knowledgeSource = readFileSync('src/client/components/KnowledgeList.tsx', 'utf8')
const ideaSource = readFileSync('src/client/components/IdeaCardGrid.tsx', 'utf8')

test('接线：知识库列表由 listPresentation 判定，组件不再自己过滤/排序', () => {
  assert.match(indexSource, /buildListPage\(\{/, '必须走唯一判定入口')
  assert.match(indexSource, /items: knowledgeEntries\.map\(toContentItem\)/, '条目经统一适配')
})

test('接线：知识库只拉一次全量，搜索/分页不在服务端做（否则每敲一个字打一次库）', () => {
  const loader = indexSource.match(/const loadKnowledge = useCallback\(async \(\) => \{([\s\S]*?)\}, \[\]\)/)
  assert.ok(loader !== null, 'loadKnowledge 应还是 useCallback')
  assert.match(loader[1], /api<\{ entries: KnowledgeEntry\[\] \}>\('\/api\/workbench\/knowledge'\)/, '只请求一次全量')
  assert.doesNotMatch(loader[1], /searchParams|kind_code|\bq=/, '不许再拼搜索/分类参数')
})

test('接线：知识库状态只有一个入口，落盘在 effect 里而不是 setState 更新函数里', () => {
  assert.match(indexSource, /const updateKnowledgeFilters = useCallback/, '唯一入口')
  assert.match(indexSource, /setKnowledgeFilters\(\(prev\) => \(\{ \.\.\.prev, \.\.\.patch \}\)\)/, '入口只改状态')
  /**
   * 允许两处 setKnowledgeFilters：唯一入口 + 下面那条"分类与字典对账"的 effect
   * （字典异步来，只能在对账后才能发现分类被删）。除这两处以外的任何出现都是"第二处实现"。
   */
  const calls = indexSource.match(/setKnowledgeFilters\(/g) ?? []
  assert.equal(calls.length, 2, `setKnowledgeFilters 只该出现在「唯一入口」与「对账 effect」里，实际 ${calls.length} 处`)
  assert.match(indexSource, /if \(fixed !== null\) setKnowledgeFilters\(fixed\)/, '第二处必须是对账 effect')
  // 落盘必须在 effect 里：setState 的更新函数是渲染期计算，React 会重复调用它
  const updater = indexSource.match(/const updateKnowledgeFilters = useCallback\([\s\S]*?\}, \[\]\)/)
  assert.ok(updater !== null, '入口存在')
  assert.doesNotMatch(updater[0], /writeKnowledgeFilters/, '更新函数里不许写存储（会被重复执行）')
  assert.match(indexSource, /useEffect\(\(\) => \{\s*\n\s*writeKnowledgeFilters\(knowledgeFilters\)/, '落盘写成 effect')
})

test('接线：存下来的分类要与字典对账（删过的分类不能变成"空列表 + 无 Tab 高亮"）', () => {
  // 对账判定放在组件模块（可被 node --test 直接测）；index.tsx 只负责在拿到字典后调它
  assert.match(knowledgeSource, /export function reconcileKnowledgeKinds/, '对账函数在可测模块里')
  assert.match(indexSource, /reconcileKnowledgeKinds\(knowledgeFilters, knowledgeDicts\.map/, '在字典可用后调用')
})

/** 去掉行注释与块注释，避免"注释里提到某个写法"被当成代码里的第二处实现。 */
function stripComments(source) {
  // 块注释换成空格：直接删掉会让 `<div>` 和注释后的内容黏在一起，截取函数体时正则就乱了
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1')
}

test('接线：分类语义只派生一处（不许再写 kinds[0] ?? all）', () => {
  assert.match(knowledgeSource, /export function selectedKind/, '派生点在组件模块里')
  assert.match(indexSource, /tab: selectedKind\(knowledgeFilters\)/, '页面走 selectedKind')
  assert.match(knowledgeSource, /current=\{selectedKind\(filters\)\}/, '工具条也走 selectedKind')
  assert.match(knowledgeSource, /const current = selectedKind\(filters\)/, '对账函数也走 selectedKind')
  // 允许 1 处：`selectedKind` 自己的实现。其余出现都是"同一语义第二处实现"。
  const rawDerivations = (stripComments(indexSource).match(/kinds\[0\]/g) ?? []).length
    + (stripComments(knowledgeSource).match(/kinds\[0\]/g) ?? []).length
  assert.equal(rawDerivations, 1, `kinds[0] 只该出现在 selectedKind 里，实际 ${rawDerivations} 处`)
})

test('接线：点子菜单位置复用 placePopover，不再自造第二份摆放实现', () => {
  assert.match(ideaSource, /import \{ placePopover, type PopoverPlacement \} from '\.\.\/popoverPlacement\.js'/, '复用权威实现')
  assert.match(ideaSource, /export function placeFolderMenu/, '包装函数还在（便于单测与语义表达）')
  assert.match(ideaSource, /prefer: 'bottom'/, '菜单默认往下弹')
  // 错误前提的"按包含块夹取"必须彻底删掉（overflow 不是 fixed 的包含块）
  assert.doesNotMatch(indexSource, /fixedContainingBlock/, '包含块探测已删除')
  assert.doesNotMatch(indexSource, /setFolderMenuRect|folderMenuPos/, '菜单位置不再写到页面状态里')
  const placements = (stripComments(ideaSource).match(/placePopover\(/g) ?? []).length
    + (stripComments(indexSource).match(/placePopover\(/g) ?? []).length
  assert.ok(placements >= 1, '至少有一处真的调用了权威摆放函数')
  assert.doesNotMatch(stripComments(ideaSource), /getBoundingClientRect\(\)[\s\S]{0,400}?Math\.(min|max)\(/, '组件里不该再手写夹取算术')
})

test('接线：菜单 portal 到 body（网格/面板的 overflow 与层叠都管不到它）', () => {
  assert.match(ideaSource, /createPortal\(menu, document\.body\)/, 'portal 到 body')
  assert.match(ideaSource, /typeof document === 'undefined' \? menu : createPortal/, 'SSR 下退回原位渲染（否则测试与首屏会炸）')
})

test('接线：菜单位置同值不写（量 → 写状态 → 再渲染的回路不能自激）', () => {
  const reposition = ideaSource.match(/const reposition = \(\): void => \{[\s\S]*?\n    \}/)
  assert.ok(reposition !== null, 'reposition 存在')
  assert.match(reposition[0], /setPlacement\(\(prev\) =>/, '用更新函数比较')
  assert.match(reposition[0], /prev\.top === next\.top/, '比位置')
  assert.match(reposition[0], /prev\.maxHeight === next\.maxHeight/, '比高度')
  assert.match(reposition[0], /scrollHeight/, '高度用真实量值，不用估算常量')
})

test('接线：改筛选只能走 onChange，不许在 JSX 里直接改状态', () => {
  const toolbar = indexSource.match(/<KnowledgeToolbar[\s\S]*?\/>/)
  assert.ok(toolbar !== null, 'KnowledgeToolbar 已接线')
  assert.match(toolbar[0], /onChange=\{updateKnowledgeFilters\}/, 'onChange 直连唯一入口')
  assert.doesNotMatch(toolbar[0], /setKnowledgeFilters/, 'JSX 里不许再直接改状态')
})

test('接线：Tab / 排序 / 每页条数在刷新后保持（验收项）', () => {
  const writer = indexSource.match(/function writeKnowledgeFilters[\s\S]*?\n\}/)
  assert.ok(writer !== null, 'writeKnowledgeFilters 存在')
  for (const key of ['kinds', 'tags', 'sortKey', 'sortDir', 'pageSize']) {
    assert.match(writer[0], new RegExp(`${key}:`), `持久化字段缺 ${key}`)
  }
  assert.doesNotMatch(writer[0], /keyword:/, '关键词是瞬时意图，不该落盘')
})

test('接线：点子卡片网格给了"属于哪些文件夹"，组件不自己翻 ideaClusters', () => {
  assert.match(indexSource, /const ideaCardItems = useMemo<IdeaCardItem\[\]>/, '派生集中在页面')
  assert.match(indexSource, /clusterIds: ideaClusters\.filter/, '附上文件夹归属')
  assert.match(indexSource, /<IdeaCardGrid/, '点子区换成了卡片网格')
})

test('接线：菜单位置在滚动时重算（fixed 浮层不随滚动移动，而按钮会动）', () => {
  assert.match(ideaSource, /placeFolderMenu\(/, '位置由纯函数算')
  assert.match(ideaSource, /document\.addEventListener\('scroll', reposition, true\)/, '捕获阶段监听滚动（面板内滚动也要重算）')
  assert.match(ideaSource, /window\.addEventListener\('resize', reposition\)/, '改窗口尺寸也要重算')
  assert.match(ideaSource, /removeEventListener\('scroll', reposition, true\)/, '监听器要成对清理（否则卸载后仍在跑）')
})

test('组件：多选与归入文件夹都在卡片上，且都不冒泡到整卡点击', () => {
  // 两个按钮都是「先 stopPropagation，再干自己的事」，中间可以换行
  const pick = ideaSource.match(/data-idea-pick=\{idea\.id\}[\s\S]{0,400}?onClick=\{\(e\) => \{ e\.stopPropagation\(\);/)
  assert.ok(pick !== null, '☑ 必须 stopPropagation，否则点它会顺手打开详情')
  const fold = ideaSource.match(/data-idea-fold=\{idea\.id\}[\s\S]{0,600}?e\.stopPropagation\(\)/)
  assert.ok(fold !== null, '归入文件夹按钮必须 stopPropagation')
})

test('组件：菜单与网格是两个并列的东西，且用 fixed 定位（配合 portal）', () => {
  // 菜单必须是**独立元素**：JSX 里它的渲染位置在网格容器闭合之后，而不是嵌在某张卡片里
  const gridOpen = ideaSource.indexOf('data-idea-cards>')
  assert.ok(gridOpen >= 0, '网格容器存在')
  const gridClose = ideaSource.indexOf('</div>', gridOpen)
  const menuRenderAt = ideaSource.indexOf('{menu !== null &&', gridOpen)
  assert.ok(menuRenderAt > gridClose, `菜单的渲染位置必须在网格闭合之后（网格闭合 ${gridClose} / 菜单渲染 ${menuRenderAt}）`)
  const css = readFileSync('src/client/styles.ts', 'utf8')
  const rule = css.match(/\.wb-idea-foldmenu \{[^}]*\}/)
  assert.ok(rule !== null, 'styles.ts 有 .wb-idea-foldmenu 规则')
  assert.match(rule[0], /position:fixed/, '菜单必须 fixed（配合 portal，网格/面板的 overflow 才裁不到）')
  /**
   * portal 到 body 的浮层会**继承** `.wb-panel-host` 的 `pointer-events:none`
   * （面板铺开时左侧导航栏仍要可点，所以宿主是 none）——也就是说菜单会看得见、点不动。
   * 必须按「容器 none + 本体 auto」两段写，与 `.wb-toasts` / `.wb-toast` 同一套办法。
   */
  assert.match(rule[0], /pointer-events:none/, '浮层容器要 pointer-events:none（与 toast 一致）')
  assert.match(css, /\.wb-idea-foldmenu > \* \{ pointer-events:auto; \}/, '浮层本体要 pointer-events:auto，否则点不动')
  /**
   * z-index 必须**高于面板宿主**（`.wb-panel-host` 是 55）：portal 到 body 的菜单
   * 与面板是同层兄弟，z-index 低于 55 就会被面板里的卡片盖住 —— 看得见、点到的却是卡片。
   * 实测 z-index:40 时 `elementFromPoint` 命中的是 `.wb-idea-card2`。
   */
  const menuZ = Number((rule[0].match(/z-index:(\d+)/) ?? [, '0'])[1])
  const hostZ = Number((css.match(/\.wb-panel-host \{[^}]*z-index:\s*(\d+)/) ?? [, '0'])[1])
  assert.ok(menuZ > hostZ, `菜单 z-index(${menuZ}) 必须高于面板宿主(${hostZ})，否则会被面板内容盖住`)
})

test('样式：多选 ☑ 对键盘用户可见（只靠 hover 显形 = 焦点落在隐形控件上）', () => {
  const css = readFileSync('src/client/styles.ts', 'utf8')
  assert.match(css, /\.wb-idea-pick:focus-visible/, '☑ 要有 focus-visible 规则')
  const focusRule = css.match(/\.wb-idea-pick:focus-visible[\s\S]{0,200}?\{[^}]*\}/)
  assert.ok(focusRule !== null && /opacity:1/.test(focusRule[0]), '聚焦时必须显形')
})

test('样式：两处新 UI 的类名都真的定义了（否则渲染出来是裸元素）', () => {
  const css = readFileSync('src/client/styles.ts', 'utf8')
  for (const cls of ['.wb-kb-tabs', '.wb-kb-tab', '.wb-kb-list', '.wb-kb-row', '.wb-kb-ghead', '.wb-kb-pager', '.wb-kb-pnum',
    '.wb-idea-cards', '.wb-idea-card2', '.wb-idea-pick', '.wb-idea-foldbtn', '.wb-idea-foldmenu']) {
    assert.ok(css.includes(cls + ' ') || css.includes(cls + '{') || css.includes(cls + ','), `styles.ts 缺 ${cls}`)
  }
})

test('知识库组件：分类入口是 Tab 而不是下拉（这是本次改动的起点）', () => {
  assert.match(knowledgeSource, /data-kind-tab=/)
  assert.doesNotMatch(knowledgeSource, /<select[^>]*data-kind/, '分类不许再做成下拉')
})
