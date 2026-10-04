import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 接线不变量（源码级扫描）。
 *
 * 组件本身由 `test/listViews.test.mjs` 渲染着测；这里只锁**接线**上那些"删掉也不会报错、
 * 但会让功能悄悄退化"的点 —— 本项目规范要求「政策要变成会失败的测试，不要写成注释」。
 */
import { read, assertClientCount, countInClient } from './_clientSources.mjs'

const indexSource = read('src/client/index.tsx')
/**
 * D17/P1：知识域的 owner 已经不是入口了。
 * - `knowledgeHookSource`：状态 / effect / 落盘 / 动作（`hooks/useKnowledge.ts`）
 * - `knowledgeViewSource`：工具栏 / 列表 / 分页的装配与 onChange 接线（`views/KnowledgeListView.tsx`）
 */
const knowledgeHookSource = read('src/client/hooks/useKnowledge.ts')
const knowledgeViewSource = read('src/client/views/KnowledgeListView.tsx')
/**
 * D17/P2：点子域的 owner 也不再是入口了。
 * - `ideasHookSource`：状态 / 拉取 / 派生（`hooks/useIdeas.ts`）
 * - `ideasViewSource`：卡片网格的装配（`views/IdeasListView.tsx`）
 */
const ideasHookSource = read('src/client/hooks/useIdeas.ts')
const ideasViewSource = read('src/client/views/IdeasListView.tsx')
// D17/P3-1：任务页左侧列表域搬到这两处（判据跟着实现走，见设计 §8.1）
const taskListHookSource = read('src/client/hooks/useTaskListModel.ts')
const taskListViewSource = read('src/client/views/TaskListView.tsx')
const knowledgeSource = read('src/client/components/KnowledgeList.tsx')
const ideaSource = readFileSync('src/client/components/IdeaCardGrid.tsx', 'utf8')
const tabBarSource = readFileSync('src/client/components/TabBar.tsx', 'utf8')
const taskListSource = readFileSync('src/client/components/TaskList.tsx', 'utf8')
const settingsSource = readFileSync('src/client/components/SettingsModal.tsx', 'utf8')

test('接线：知识库列表由 listPresentation 判定，组件不再自己过滤/排序', () => {
  assert.match(knowledgeHookSource, /buildListPage<ContentItem>\(\{/, '必须走唯一判定入口')
  assert.match(knowledgeHookSource, /items: entries\.map\(toContentItem\)/, '条目经统一适配')
})

test('接线：知识库只拉一次全量，搜索/分页不在服务端做（否则每敲一个字打一次库）', () => {
  const loader = knowledgeHookSource.match(/const reload = useCallback\(async \(\): Promise<void> => \{([\s\S]*?)\}, \[\]\)/)
  assert.ok(loader !== null, 'reload 应还是 useCallback（唯一拉取入口）')
  assert.match(loader[1], /api<\{ entries: KnowledgeEntry\[\] \}>\('\/api\/workbench\/knowledge'\)/, '只请求一次全量')
  assert.doesNotMatch(loader[1], /searchParams|kind_code|\bq=/, '不许再拼搜索/分类参数')
})

test('接线：知识库状态只有一个入口，落盘在 effect 里而不是 setState 更新函数里', () => {
  assert.match(knowledgeHookSource, /const updateFilters = useCallback/, '唯一入口')
  assert.match(knowledgeHookSource, /setFilters\(\(prev\) => \(\{ \.\.\.prev, \.\.\.patch \}\)\)/, '入口只改状态')
  /**
   * 允许**两处** setFilters：唯一入口 + 下面那条"分类与字典对账"的 effect
   * （字典异步来，只能在对账后才能发现分类被删）。除这两处以外的任何出现都是"第二处实现"。
   */
  // D17/P1：改成全客户端目录范围（§8.2 要求递归覆盖）—— 搬家后只扫 index 会空洞通过
  assertClientCount(assert, /setFilters\(/g, 2,
    'setFilters 在引用实现里恰好两处：唯一入口的更新函数 + 分类对账 effect')
  assert.match(knowledgeHookSource, /if \(fixed !== null\) setFilters\(fixed\)/, '第二处必须是对账 effect')
  // 落盘必须在 effect 里：setState 的更新函数是渲染期计算，React 会重复调用它
  const updater = knowledgeHookSource.match(/const updateFilters = useCallback\([\s\S]*?\}, \[\]\)/)
  assert.ok(updater !== null, '入口存在')
  assert.doesNotMatch(updater[0], /writeKnowledgeFilters/, '更新函数里不许写存储（会被重复执行）')
  assert.match(knowledgeHookSource, /useEffect\(\(\) => \{\s*\n\s*writeKnowledgeFilters\(filters\)/, '落盘写成 effect')
})

test('接线：存下来的分类要与字典对账（删过的分类不能变成"空列表 + 无 Tab 高亮"）', () => {
  // 对账判定放在组件模块（可被 node --test 直接测）；index.tsx 只负责在拿到字典后调它
  assert.match(knowledgeSource, /export function reconcileKnowledgeKinds/, '对账函数在可测模块里')
  assert.match(knowledgeHookSource, /reconcileKnowledgeKinds\(filters, dicts\.map/, '在字典可用后调用')
})

/** 去掉行注释与块注释，避免"注释里提到某个写法"被当成代码里的第二处实现。 */
function stripComments(source) {
  // 块注释换成空格：直接删掉会让 `<div>` 和注释后的内容黏在一起，截取函数体时正则就乱了
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1')
}

test('接线：分类语义只派生一处（不许再写 kinds[0] ?? all）', () => {
  assert.match(knowledgeSource, /export function selectedKind/, '派生点在组件模块里')
  assert.match(knowledgeHookSource, /tab: selectedKind\(filters\)/, '页面走 selectedKind')
  assert.match(knowledgeSource, /const current = selectedKind\(filters\)/, '对账函数也走 selectedKind')
  // 工具条已改用共用 TabBar（选中态由 `TabBar.isTabActive` 判），所以不再是 `current=` 那种写法
  assert.match(knowledgeSource, /<TabBar tabs=\{tabs\} selected=\{filters\.kinds\}/, '工具条把选中集合交给 TabBar')
  // 允许 1 处：`selectedKind` 自己的实现。其余出现都是"同一语义第二处实现"。
  const rawDerivations = (stripComments(indexSource).match(/kinds\[0\]/g) ?? []).length
    + (stripComments(knowledgeHookSource).match(/kinds\[0\]/g) ?? []).length
    + (stripComments(knowledgeViewSource).match(/kinds\[0\]/g) ?? []).length
    + (stripComments(knowledgeSource).match(/kinds\[0\]/g) ?? []).length
    + (stripComments(tabBarSource).match(/kinds\[0\]/g) ?? []).length
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
  const toolbar = knowledgeViewSource.match(/<KnowledgeToolbar[\s\S]*?\/>/)
  assert.ok(toolbar !== null, 'KnowledgeToolbar 已接线')
  assert.match(toolbar[0], /onChange=\{model\.updateFilters\}/, 'onChange 直连唯一入口')
  assert.doesNotMatch(toolbar[0], /setFilters/, 'JSX 里不许再直接改状态')
  // 工具条**恰好装配一处**：知识域被装配两份就会出现两个工具条（§8.2 的递归唯一性）
  assertClientCount(assert, /<KnowledgeToolbar/g, 1, 'KnowledgeToolbar 只许装配一处')
})

test('接线：Tab / 排序 / 每页条数在刷新后保持（验收项）', () => {
  const writer = knowledgeHookSource.match(/function writeKnowledgeFilters[\s\S]*?\n\}/)
  assert.ok(writer !== null, 'writeKnowledgeFilters 存在')
  for (const key of ['kinds', 'tags', 'sortKey', 'sortDir', 'pageSize']) {
    assert.match(writer[0], new RegExp(`${key}:`), `持久化字段缺 ${key}`)
  }
  assert.doesNotMatch(writer[0], /keyword:/, '关键词是瞬时意图，不该落盘')
})

test('接线：点子卡片网格给了"属于哪些文件夹"，组件不自己翻 ideaClusters', () => {
  assert.match(ideasHookSource, /const cardItems = useMemo<IdeaCardItem\[\]>/, '派生集中在点子域 hook')
  assert.match(ideasHookSource, /clusterIds: clusters\.filter\(/, '附上文件夹归属')
  assert.match(ideasViewSource, /<IdeaCardGrid/, '点子区换成了卡片网格')
  assert.doesNotMatch(indexSource, /<IdeaCardGrid/, '入口不得再直接装配卡片网格（D17/P2 后归 IdeasListView）')
})

test('接线：点子页签只清"另一个"选择，两种"点开"各有自己的语义（D17/P2 不许改行为）', () => {
  /**
   * 拆分前（HEAD `src/client/index.tsx:3433-3435`）三个页签按钮的清选择范围**不对称**：
   * 全部/未归类 → 只清点子王；文件夹 → 只清点子。P2 第一版写成"两份都清"，已修回。
   * 这个语义现在只有一个所有者：hook 的 `changeTab`。
   */
  const change = ideasHookSource.match(/const changeTab = useCallback\(\(next: IdeasTab\): void => \{[\s\S]*?\n {2}\}, \[\]\)/)
  assert.ok(change !== null, 'changeTab 是页签切换的唯一所有者')
  assert.match(change[0], /if \(next === 'clusters'\) setSelectedIdea\(null\)\n\s*else setSelectedCluster\(null\)/, '只清"另一个"')
  assert.match(change[0], /setTabState\(next\)/, '最后才改页签本身')
  assert.match(ideasViewSource, /onClick=\{\(\) => model\.setTab\('ideas'\)\}/, '视图只调 setTab，不自己清')
  // "两份都清"这个语义拆分前不存在 —— 不许在拆分中被引入
  assertClientCount(assert, /clearSelection/g, 0, '拆分前没有"清两份"这个动作，不许引入')
  /**
   * 两个"点开点子"的调用点语义不同（HEAD `:3499-3503` 与 `:3645`）：
   * 卡片网格先 `find` 再"找不到就早退"（连 selectedCluster 都不清）；文件夹成员行直接用手上的对象
   * （成员可能不在当前筛选出的 `ideas` 里）。合并成一个动作会在两种边界下各自不忠实。
   */
  const byId = ideasHookSource.match(/const openIdeaById = useCallback\(\(id: string\): void => \{[\s\S]*?\n {2}\}, \[ideas\]\)/)
  assert.ok(byId !== null, 'openIdeaById 存在（卡片网格用）')
  assert.match(byId[0], /const idea = ideas\.find\([\s\S]*if \(idea === undefined\) return[\s\S]*setSelectedCluster\(null\); setSelectedIdea\(idea\)/, '先 find、找不到就什么都不做')
  const direct = ideasHookSource.match(/const openIdea = useCallback\(\(idea: Idea\): void => \{[\s\S]*?\n {2}\}, \[\]\)/)
  assert.ok(direct !== null, 'openIdea 存在（成员行用，直接收对象、不做查找）')
  assert.match(ideasViewSource, /onOpen=\{\(item\) => model\.actions\.openIdeaById\(item\.id\)\}/, '卡片网格走 openIdeaById')
  assert.match(read('src/client/views/IdeasDetailPane.tsx'), /onClick=\{\(\) => model\.actions\.openIdea\(idea\)\}/, '成员行走 openIdea(idea)')
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

test('样式：新 UI 的类名都真的定义了（否则渲染出来是裸元素）', () => {
  const css = readFileSync('src/client/styles.ts', 'utf8')
  for (const cls of ['.wb-kb-list', '.wb-kb-row', '.wb-kb-ghead', '.wb-kb-pager', '.wb-kb-pnum',
    '.wb-idea-cards', '.wb-idea-card2', '.wb-idea-pick', '.wb-idea-foldbtn', '.wb-idea-foldmenu',
    // 第二轮：通用 Tab（知识库 + 任务页共用）、标签「更多」浮层
    '.wb-tabs', '.wb-tab', '.wb-tab-dot', '.wb-tab-cnt',
    '.wb-kb-tags', '.wb-kb-tag', '.wb-tagmenu', '.wb-tagmenu-item', '.wb-tagmenu-search']) {
    assert.ok(css.includes(cls + ' ') || css.includes(cls + '{') || css.includes(cls + ','), `styles.ts 缺 ${cls}`)
  }
})

test('知识库与任务页共用同一个 Tab 组件（同一语义不写两遍）', () => {
  assert.match(knowledgeSource, /import \{ ALL, buildTabs, TabBar, toggleTab, type TabItem \} from '\.\/TabBar\.js'/, '知识库用共用组件')
  // D17/P3-1：任务页的类型 Tab 搬到 `views/TaskListView.tsx`（装配）+ `hooks/useTaskListModel.ts`（选中与计数）
  assert.match(taskListViewSource, /import \{ ALL, TabBar \} from '\.\.\/components\/TabBar\.js'/, '任务页视图用共用组件')
  assert.match(taskListHookSource, /import \{ ALL, buildTabs, toggleTab, type TabItem \} from '\.\.\/components\/TabBar\.js'/, '选中/计数走同一个纯函数模块')
  // 两处都必须是 TabBar，不许谁偷偷再写一份自己的 Tab
  assert.equal((knowledgeSource.match(/<TabBar/g) ?? []).length, 1)
  assert.equal((taskListViewSource.match(/<TabBar/g) ?? []).length, 1)
  assert.equal((indexSource.match(/<TabBar/g) ?? []).length, 0, '入口不再直接装配 TabBar（D17/P3-1 后归 TaskListView）')
  assert.doesNotMatch(knowledgeSource, /data-kind-tab/, '旧的自建 Tab 类名应已消失')
})

test('任务页：类型从多选下拉升为 Tab，且**其他下拉保留**', () => {
  const listSection = taskListViewSource
  assert.match(listSection, /<TabBar/, '列表页有类型 Tab')
  assert.doesNotMatch(listSection, /label="类型"/, '原来的「类型」多选下拉必须去掉')
  assert.match(listSection, /label="状态"/, '状态下拉保留')
  assert.match(listSection, /label="优先级"/, '优先级下拉保留')
  // Tab 是单选 + Ctrl/Cmd 多选：走 toggleTab，不自己写选中逻辑（D17/P3-1 后这份逻辑在 hook 里）
  assert.match(taskListHookSource, /toggleTab\(/, '选中逻辑走共用纯函数')
  assert.doesNotMatch(listSection, /toggleTab\(/, '视图不自己算页签选中')
})

test('任务页：类型 Tab 的条数由 countTasksByType 给出（排除类型维度自身）', () => {
  assert.match(taskListHookSource, /countTasksByType\(buildTaskTree\(/, '条数走纯函数')
  assert.match(taskListHookSource, /buildTabs\(typeDicts, \{ \.\.\.byType, all \}/, '拼装走共用 buildTabs')
  assert.doesNotMatch(indexSource, /countTasksByType/, '入口不再自己算类型条数（D17/P3-1）')
})

test('D17/P3-1：归档切换的副作用不许写进 setState 更新函数（重调更新函数会重复发请求）', () => {
  const start = taskListHookSource.indexOf('const toggleArchived')
  const end = taskListHookSource.indexOf('const toggleExpanded', start)
  assert.ok(start > 0 && end > start, 'toggleArchived 实现存在')
  const body = taskListHookSource.slice(start, end)
  assert.match(body, /const next = !archivedMode/, '先算 next（与拆分前逐字一致）')
  assert.match(body, /setArchivedMode\(next\)/, '用算好的值 setState')
  assert.match(body, /void api<\{ tasks: Task\[\] \}>\('\/api\/workbench\/tasks\?archived=true'\)/, '归档集合仍由本域拉取')
  assert.doesNotMatch(body, /setArchivedMode\(\(prev\)/, '不许把 api 调用塞进更新函数')
})

test('D17/P3-1：列表视图是纯展示，状态只在 hook 里；唯一口径的键与常量不许复制', () => {
  assert.doesNotMatch(taskListViewSource, /\buseState\s*[<(]/, '视图不自建 state')
  assert.doesNotMatch(taskListViewSource, /\buseEffect\s*\(/, '视图不自建 effect')
  assert.doesNotMatch(taskListViewSource, /\buseMemo\s*\(/, '视图不自建派生')
  assert.doesNotMatch(taskListViewSource, /\b(api|fetch)\s*[<(]/, '视图不发请求')
  assert.match(taskListHookSource, /EMPTY_TASK_FILTER/, '空筛选复用共享常量')
  // 唯一口径：空筛选字面量**只剩** `taskFilterSort.ts` 里的那一份定义，入口/视图/hook 都不许再内联
  const inlineFilters = countInClient(/\{ keyword: '', statusCodes: \[\], priorityCodes: \[\], typeCodes: \[\] \}/)
  assert.deepEqual(inlineFilters.hits, ['src/client/taskFilterSort.ts×1'],
    `空筛选字面量必须只剩 taskFilterSort.ts 里的定义（实际：${inlineFilters.hits.join('、') || '无'}）`)
  assert.equal(countInClient(/dsh\.personal-workbench\.treeExpanded/).total, 1,
    '树展开集合的存储键只许在 useTaskListModel 里出现一次')
})

test('任务行：类型徽标已去掉（Tab 已表达类型），优先级/状态徽标仍在', () => {
  const content = taskListSource.match(/const content = \([\s\S]*?\n  \)/)
  assert.ok(content !== null, 'TaskRow 的 content 存在')
  assert.doesNotMatch(content[0], /kind === 'type'/, '不该再渲染类型徽标')
  assert.match(content[0], /kind === 'priority'/, '优先级仍在')
  assert.match(content[0], /kind === 'status'/, '状态仍在')
  // 4 列的默认栅格是按带类型徽标写的，去掉一列必须显式改列数，否则右侧会错位
  assert.match(content[0], /gridTemplateColumns:/, '去掉一列后要显式改列宽')
})

test('设置页：字典管理里有「知识库类型」（原先漏了这个入口）', () => {
  assert.match(settingsSource, /type DictKind = [^\n]*'knowledge_kind'/, 'DictKind 含 knowledge_kind')
  assert.match(settingsSource, /\{ key: 'knowledge_kind', label: '知识库类型' \}/, '字典分区里有这个 Tab')
  for (const key of ['type', 'status', 'priority', 'idea_kind']) {
    assert.match(settingsSource, new RegExp(`\\{ key: '${key}'`), `原有分区不能丢：${key}`)
  }
})

test('字典：知识库/点子类型的**出厂 config 必须带颜色**（否则 Tab 圆点与徽标全落灰色兜底）', () => {
  const seed = readFileSync('src/db/seed.ts', 'utf8')
  const knowledgeSeeds = seed.match(/\{ kind: 'knowledge_kind'[^\n]*/g) ?? []
  const ideaSeeds = seed.match(/\{ kind: 'idea_kind'[^\n]*/g) ?? []
  assert.equal(knowledgeSeeds.length, 4, 'knowledge_kind 种子 4 条')
  assert.equal(ideaSeeds.length, 5, 'idea_kind 种子 5 条')
  for (const line of [...knowledgeSeeds, ...ideaSeeds]) {
    assert.match(line, /config: \{ color: '#[0-9A-Fa-f]{6}' \}/, `种子缺颜色：${line.slice(0, 60)}`)
  }
})

test('迁移 16：给已存在的库回填这两类字典的颜色，且**不覆盖已有颜色**', () => {
  // 归一化行尾：Windows 检出是 CRLF，正则里的 `\n` 会匹配不到
  const schema = readFileSync('src/db/schema.ts', 'utf8').replace(/\r\n/g, '\n')
  // 版本号必须**等于最大迁移号**（v1.15.3 起为 17：知识库召回日志表）。
  // 这条断言的意义是"加迁移时别忘了同步 SCHEMA_VERSION"，所以不锁死具体数字 ——
  // 锁死会让每次加迁移都来改一次这条与颜色无关的测试（本轮就撞到了）。
  const declared = Number(/export const SCHEMA_VERSION = (\d+)/.exec(schema)?.[1] ?? 0)
  const versions = [...schema.matchAll(/^\s{4}version: (\d+),/gm)].map((m) => Number(m[1]))
  assert.ok(declared >= 16, `SCHEMA_VERSION 至少 16，实测 ${declared}`)
  assert.equal(declared, Math.max(...versions), 'SCHEMA_VERSION 必须等于最大迁移号（否则迁移形同虚设）')
  const start = schema.indexOf('version: 16,')
  assert.ok(start > 0, '有 version 16 的迁移')
  const migration = schema.slice(start, schema.indexOf('\n]', start))
  assert.match(migration, /knowledge_kind:/, '覆盖知识库类型')
  assert.match(migration, /idea_kind:/, '覆盖点子类型')
  // 已有颜色必须跳过 —— 否则用户自己配的色会被出厂值覆盖
  assert.match(migration, /if \(typeof config\.color === 'string' && config\.color\.trim\(\) !== ''\) continue/, '已有颜色跳过')
  assert.match(migration, /SELECT config FROM dictionaries WHERE kind = \? AND code = \?/, '先读后写')
})

test('分页档位：默认 10，可选 10/20/50/100', () => {
  const presentation = readFileSync('src/client/listPresentation.ts', 'utf8')
  assert.match(presentation, /PAGE_SIZES: readonly number\[\] = Object\.freeze\(\[10, 20, 50, 100\]\)/, '档位')
  assert.match(presentation, /DEFAULT_PAGE_SIZE = 10/, '默认 10')
})

test('标签区：单行 + 「更多」浮层，且**不再只渲染前 12 个**（静默截断是禁区）', () => {
  const tagFilter = readFileSync('src/client/components/TagFilter.tsx', 'utf8')
  assert.match(tagFilter, /data-tagmore/, '有「更多」入口')
  assert.match(tagFilter, /data-tagmenu/, '有浮层')
  assert.doesNotMatch(knowledgeSource, /tagCounts\.slice\(0, 12\)/, '旧的"只显示前 12 个"必须消失')
  // 浮层的定位前提与点子菜单一致：portal + fixed + 高于面板宿主
  assert.match(tagFilter, /createPortal\(menu, document\.body\)/, '浮层 portal 到 body')
  const css = readFileSync('src/client/styles.ts', 'utf8')
  const rule = css.match(/\.wb-tagmenu \{[^}]*\}/)
  assert.ok(rule !== null, 'styles.ts 有 .wb-tagmenu 规则')
  assert.match(rule[0], /position:fixed/, 'fixed')
  const menuZ = Number((rule[0].match(/z-index:(\d+)/) ?? [, '0'])[1])
  const hostZ = Number((css.match(/\.wb-panel-host \{[^}]*z-index:\s*(\d+)/) ?? [, '0'])[1])
  assert.ok(menuZ > hostZ, `标签浮层 z-index(${menuZ}) 必须高于面板宿主(${hostZ})`)
  assert.match(css, /\.wb-kb-tags \{[^}]*flex-wrap:nowrap/, '标签区必须单行（不再 wrap 占多行）')
})
