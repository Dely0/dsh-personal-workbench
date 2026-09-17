import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  EMPTY_KNOWLEDGE_FILTERS,
  KnowledgeList,
  KnowledgePager,
  KnowledgeToolbar,
  kindTabs,
  knowledgeFilterActive,
  reconcileKnowledgeKinds,
} from '../lib/client/components/KnowledgeList.js'
import { IdeaCardGrid, folderMenuAnchor, placeFolderMenu } from '../lib/client/components/IdeaCardGrid.js'
import { placePopover } from '../lib/client/popoverPlacement.js'
import { buildListPage, toContentItem } from '../lib/client/listPresentation.js'

/**
 * 组件层测试：用 `react-dom/server` 把组件**真的渲染成 HTML** 再断言。
 * 比源码扫描强 —— 断言的是"渲染出来是什么"，删掉结构就会红。
 * 组件本身不 import React 运行时状态，所以不需要 DOM。
 */

const NOW = Date.parse('2026-09-25T12:00:00Z')
const DAY = 86400000
const HOUR = 3600000
const at = (msAgo) => new Date(NOW - msAgo).toISOString()

const KINDS = [
  { kind: 'knowledge_kind', code: 'note', name: '笔记', config: { color: '#4F86F7' } },
  { kind: 'knowledge_kind', code: 'lesson', name: '经验教训', config: { color: '#E7634C' } },
  { kind: 'knowledge_kind', code: 'decision', name: '决策记录', config: { color: '#8B7BE8' } },
  { kind: 'knowledge_kind', code: 'snippet', name: '片段/模板', config: { color: '#2E9B7B' } },
]
const IDEA_KINDS = [{ kind: 'idea_kind', code: 'project', name: '项目点子', config: { color: '#4F86F7' } }]

const entry = (id, overrides = {}) => ({
  id,
  title: '知识 ' + id,
  body: '正文内容 ' + id,
  tags: [],
  kindCode: 'note',
  createdAt: at(30 * DAY),
  updatedAt: at(HOUR),
  ...overrides,
})

function pageOf(items, query = {}) {
  return buildListPage({
    items,
    query: { tab: 'all', keyword: '', tags: [], sortKey: 'updatedAt', sortDir: 'desc', page: 0, pageSize: 50, ...query },
    now: NOW,
    tabOf: (e) => e.kindCode,
    tabCodes: KINDS.map((k) => k.code),
  })
}

/* ------------------------------ 知识库列表 ------------------------------ */

test('KnowledgeList: 渲染出时间分组头与条数', () => {
  const items = []
  for (let i = 0; i < 6; i++) items.push(entry('t' + i, { updatedAt: at(i * HOUR + HOUR) }))
  items.push(entry('old', { updatedAt: at(20 * DAY) }))
  const html = renderToStaticMarkup(KnowledgeList({ page: pageOf(items), dicts: KINDS, selectedId: undefined, onOpen: () => {} }))
  assert.match(html, /data-kb-list/)
  assert.match(html, /data-kb-group="今天"/)
  assert.match(html, /data-kb-group="本月"/)
  assert.match(html, /wb-kb-gcnt">6</, '组头带条数')
})

test('KnowledgeList: 每行渲染标题 / 摘要 / 类型徽标 / 标签 / 时间', () => {
  const items = [entry('a', { title: '云开发连 3081 被劫持', body: '第一行摘要\n第二行不该出现', tags: ['踩坑', 'DSH'], kindCode: 'lesson' })]
  const html = renderToStaticMarkup(KnowledgeList({ page: pageOf(items), dicts: KINDS, selectedId: 'a', onOpen: () => {} }))
  assert.match(html, /data-kb-row="a"/)
  assert.match(html, /云开发连 3081 被劫持/)
  assert.match(html, /第一行摘要/)
  assert.doesNotMatch(html, /第二行不该出现/, '摘要只取第一行')
  assert.match(html, /经验教训/, '类型徽标用字典名')
  assert.match(html, /#踩坑/)
  assert.match(html, /#DSH/)
  assert.match(html, /sel/, '选中态')
})

test('KnowledgeList: 命中为空时给空态而不是空白', () => {
  const html = renderToStaticMarkup(KnowledgeList({ page: pageOf([]), dicts: KINDS, selectedId: undefined, onOpen: () => {} }))
  assert.match(html, /data-kb-empty/)
  assert.match(html, /没有符合条件的知识条目/)
})

/* ------------------------------ 工具条 ------------------------------ */

test('KnowledgeToolbar: Tab 是 Tab 页而不是下拉（长列表不再需要滚动着找）', () => {
  const page = pageOf([entry('a'), entry('b', { kindCode: 'lesson' })])
  const html = renderToStaticMarkup(KnowledgeToolbar({
    filters: EMPTY_KNOWLEDGE_FILTERS,
    tabs: kindTabs(KINDS, page.tabCounts),
    tagCounts: page.tagCounts,
    total: page.total,
    onChange: () => {},
    onClear: () => {},
  }))
  assert.match(html, /data-kind-tab="all"/)
  assert.match(html, /data-kind-tab="note"/)
  assert.match(html, /data-kind-tab="lesson"/)
  assert.doesNotMatch(html, /<select[^>]*data-kind/, '分类不许再是下拉')
  assert.match(html, /全部/, '有「全部」入口')
  assert.match(html, /data-kb-search/, '有搜索框')
})

test('KnowledgeToolbar: 标签 chip 显示各自条数，选中项高亮', () => {
  const page = pageOf([entry('a', { tags: ['踩坑'] }), entry('b', { tags: ['踩坑', 'DSH'] })])
  const html = renderToStaticMarkup(KnowledgeToolbar({
    filters: { ...EMPTY_KNOWLEDGE_FILTERS, tags: ['踩坑'] },
    tabs: kindTabs(KINDS, page.tabCounts),
    tagCounts: page.tagCounts,
    total: page.total,
    onChange: () => {},
    onClear: () => {},
  }))
  assert.match(html, /data-kb-tag="踩坑"/)
  assert.match(html, /data-kb-tag="DSH"/)
  assert.match(html, /wb-kb-tag on"[^>]*data-kb-tag="踩坑"|data-kb-tag="踩坑"[^>]*class="[^"]*on/)
})

test('KnowledgeToolbar: 没筛选时「清空筛选」是禁用的（不做无用按钮）', () => {
  const clean = renderToStaticMarkup(KnowledgeToolbar({
    filters: EMPTY_KNOWLEDGE_FILTERS, tabs: [], tagCounts: [], total: 0, onChange: () => {}, onClear: () => {},
  }))
  // 注意属性顺序：React 把 disabled 放在 data-* 之前
  const cleanBtn = clean.match(/<button[^>]*data-kb-clear[^>]*>/)?.[0] ?? ''
  assert.match(cleanBtn, /disabled/, '无筛选时应禁用：' + cleanBtn)
  const dirty = renderToStaticMarkup(KnowledgeToolbar({
    filters: { ...EMPTY_KNOWLEDGE_FILTERS, keyword: 'x' }, tabs: [], tagCounts: [], total: 0, onChange: () => {}, onClear: () => {},
  }))
  const dirtyBtn = dirty.match(/<button[^>]*data-kb-clear[^>]*>/)?.[0] ?? ''
  assert.doesNotMatch(dirtyBtn, /disabled/, '有筛选时应可点：' + dirtyBtn)
  assert.equal(knowledgeFilterActive(EMPTY_KNOWLEDGE_FILTERS), false)
  assert.equal(knowledgeFilterActive({ ...EMPTY_KNOWLEDGE_FILTERS, tags: ['a'] }), true)
  assert.equal(knowledgeFilterActive({ ...EMPTY_KNOWLEDGE_FILTERS, kinds: ['lesson'] }), true)
})

/* ------------------------------ 分页 ------------------------------ */

test('KnowledgePager: 显示区间与总数，页码按钮指向 0 起下标', () => {
  const items = Array.from({ length: 130 }, (_, i) => entry('i' + i, { updatedAt: at(i * HOUR) }))
  const page = pageOf(items, { page: 1 })
  const html = renderToStaticMarkup(KnowledgePager({
    page, pageSize: 50, onPage: () => {}, onPageSize: () => {},
  }))
  assert.match(html, /第 51–100 条/)
  assert.match(html, /130/, '总数')
  assert.match(html, /data-kb-page="0"/, '« 回到第 1 页')
  assert.match(html, /data-kb-page="2"/)
  assert.match(html, /data-kb-pagesize/, '每页条数可切')
  assert.match(html, /50 \/ 页/)
})

test('KnowledgePager: 首页时向前按钮禁用、末页时向后按钮禁用', () => {
  const items = Array.from({ length: 60 }, (_, i) => entry('i' + i, { updatedAt: at(i * HOUR) }))
  const first = renderToStaticMarkup(KnowledgePager({ page: pageOf(items, { page: 0 }), pageSize: 50, onPage: () => {}, onPageSize: () => {} }))
  const last = renderToStaticMarkup(KnowledgePager({ page: pageOf(items, { page: 1 }), pageSize: 50, onPage: () => {}, onPageSize: () => {} }))
  assert.match(first, /data-kb-page="0"[^>]*disabled/)
  assert.match(last, /data-kb-page="1"[^>]*disabled/)
})

test('KnowledgeList: 翻到第 2 页只渲染第 2 页的行（不是把整库铺出来）', () => {
  const items = Array.from({ length: 130 }, (_, i) => entry('i' + i, { updatedAt: at(i * HOUR) }))
  const page1 = pageOf(items, { page: 0 })
  const page2 = pageOf(items, { page: 1 })
  const html1 = renderToStaticMarkup(KnowledgeList({ page: page1, dicts: KINDS, selectedId: undefined, onOpen: () => {} }))
  const html2 = renderToStaticMarkup(KnowledgeList({ page: page2, dicts: KINDS, selectedId: undefined, onOpen: () => {} }))
  const ids = (html) => (html.match(/data-kb-row="([^"]+)"/g) ?? []).map((m) => m.slice(14, -1))
  assert.equal(ids(html1).length, 50)
  assert.equal(ids(html2).length, 50)
  // 两页没有交集，且合起来是前 100 条
  assert.deepEqual(ids(html1).filter((id) => ids(html2).includes(id)), [], '两页不该有重复行')
  assert.equal(new Set([...ids(html1), ...ids(html2)]).size, 100)
})

test('KnowledgeList: 第 3 页渲染剩下的 30 条（末页不是固定 50）', () => {
  const items = Array.from({ length: 130 }, (_, i) => entry('i' + i, { updatedAt: at(i * HOUR) }))
  const html = renderToStaticMarkup(KnowledgeList({ page: pageOf(items, { page: 2 }), dicts: KINDS, selectedId: undefined, onOpen: () => {} }))
  assert.equal((html.match(/data-kb-row=/g) ?? []).length, 30)
})

/* ------------------------------ 点子卡片网格 ------------------------------ */

const idea = (id, overrides = {}) => ({
  id,
  title: '点子 ' + id,
  body: '点子内容 ' + id,
  tags: ['AI'],
  kindCode: 'project',
  createdAt: at(30 * DAY),
  updatedAt: at(DAY),
  clusterIds: [],
  ...overrides,
})

const gridProps = (overrides = {}) => ({
  ideas: [idea('a'), idea('b')],
  dicts: IDEA_KINDS,
  selectedId: undefined,
  pickedIds: new Set(),
  clusters: [{ id: 'f1', title: '天线测试方向' }],
  onOpen: () => {},
  onTogglePick: () => {},
  onFileInto: () => {},
  onCreateFolder: () => {},
  ...overrides,
})

test('IdeaCardGrid: 渲染成卡片网格（不是行列表）', () => {
  const html = renderToStaticMarkup(createElement(IdeaCardGrid, gridProps()))
  assert.match(html, /data-idea-cards/)
  assert.match(html, /data-idea-card="a"/)
  assert.match(html, /data-idea-card="b"/)
  assert.match(html, /项目点子/, '类型徽标')
  assert.match(html, /#AI/)
  assert.match(html, /--wb-idea-color:#4F86F7/, '类型色条')
})

test('IdeaCardGrid: 每张卡片都有多选 ☑ 与「归入文件夹」入口', () => {
  const html = renderToStaticMarkup(createElement(IdeaCardGrid, gridProps()))
  assert.equal((html.match(/data-idea-pick=/g) ?? []).length, 2, '两张卡各一个 ☑')
  assert.equal((html.match(/data-idea-fold=/g) ?? []).length, 2, '两张卡各一个归入入口')
  const noClusters = renderToStaticMarkup(createElement(IdeaCardGrid, gridProps({ clusters: [] })))
  assert.match(noClusters, /disabled="" data-idea-fold="a"|data-idea-fold="a" disabled/, '没有文件夹时入口禁用（不是点了没反应）')
})

test('IdeaCardGrid: 已选卡片带 picked 且 ☑ 是按下态（否则会忘了选过什么）', () => {
  const html = renderToStaticMarkup(createElement(IdeaCardGrid, gridProps({ pickedIds: new Set(['a']) })))
  assert.match(html, /wb-idea-card2 picked/, '已选样式')
  assert.match(html, /aria-pressed="true"/)
  assert.match(html, /aria-pressed="false"/, '未选的是 false，不是缺失')
})

test('IdeaCardGrid: 静息时渲染 HTML 里没有菜单（菜单由交互打开，且 portal 走 document.body）', () => {
  const html = renderToStaticMarkup(createElement(IdeaCardGrid, gridProps()))
  assert.doesNotMatch(html, /data-idea-foldmenu/, '没点开时不该渲染菜单')
  // 菜单是 portal 到 body 的（组件源码里必须用 createPortal），见 listViewWiring.test.mjs 的扫描断言
})

test('IdeaCardGrid: 空集合什么都不渲染（空态由页面负责，不留两份实现）', () => {
  const html = renderToStaticMarkup(createElement(IdeaCardGrid, gridProps({ ideas: [] })))
  assert.equal(html, '', '空集合渲染出空字符串')
})

/* ------------------------------ 分类与字典对账（复审 F3） ------------------------------ */

test('reconcileKnowledgeKinds: 字典里没有的分类回「全部」，合法分类与 all 不动', () => {
  const base = { ...EMPTY_KNOWLEDGE_FILTERS, keyword: '关键词' }
  const known = ['note', 'lesson', 'decision', 'snippet']

  // 删过的分类 → 回全部，并且翻页也归零
  const fixed = reconcileKnowledgeKinds({ ...base, kinds: ['已经被删掉的分类'], page: 3 }, known)
  assert.notEqual(fixed, null, '未知分类必须被改掉')
  assert.deepEqual(fixed.kinds, ['all'], '未知分类回全部')
  assert.equal(fixed.page, 0, '页码归零')
  assert.equal(fixed.keyword, '关键词', '其他条件不丢')

  // 合法分类 / all / 其他 → 不动（返回 null 避免无谓重渲染）
  assert.equal(reconcileKnowledgeKinds({ ...base, kinds: ['lesson'] }, known), null)
  assert.equal(reconcileKnowledgeKinds({ ...base, kinds: ['all'] }, known), null)
  assert.equal(reconcileKnowledgeKinds({ ...base, kinds: ['other'] }, known), null, '「其他」是合法的伪分类')
  // 字典还没到（空列表）时不能把用户的分类清掉 —— 只对"确定的未知"动手
  assert.equal(reconcileKnowledgeKinds({ ...base, kinds: ['lesson'] }, []), null)
})
test('reconcileKnowledgeKinds: 未知分类被校正后不再出现"空列表 + 无 Tab 高亮"', () => {
  const known = ['note', 'lesson', 'decision', 'snippet']
  const items = [{ ...entry('a'), kindCode: 'note' }]
  const broken = { ...EMPTY_KNOWLEDGE_FILTERS, kinds: ['已经被删掉的分类'] }
  // 修前：命中 0 条、没有任何 Tab 高亮
  const before = pageOf(items, { tab: '已经被删掉的分类' })
  assert.equal(before.total, 0)
  // 对账后：回「全部」，条目看得见、Tab 也高亮得上
  const fixed = reconcileKnowledgeKinds(broken, known)
  const after = pageOf(items, { tab: fixed.kinds[0] })
  assert.equal(after.total, 1, '校正后不该是空列表')
  const tabs = kindTabs(KINDS, after.tabCounts)
  assert.ok(tabs.some((t) => t.code === fixed.kinds[0]), '校正后的分类必然是合法 Tab（能高亮）')
})

/* ------------------------------ 菜单摆放（纯函数） ------------------------------ */

test('placeFolderMenu: 下方放得开就往下放（下拉直觉）', () => {
  const pos = placeFolderMenu({ left: 100, top: 100, bottom: 130, right: 200 }, { width: 600, height: 500 }, { width: 200, height: 100 })
  assert.equal(pos.side, 'bottom')
  assert.equal(pos.top, 136, 'top = bottom + gap')
  assert.equal(pos.left, 100)
})

test('placeFolderMenu: 下方放不开就翻到上方', () => {
  const pos = placeFolderMenu({ left: 100, top: 400, bottom: 430, right: 200 }, { width: 600, height: 500 }, { width: 200, height: 100 })
  assert.equal(pos.side, 'top')
  assert.ok(pos.top + 100 <= 400, '菜单下沿不该压到按钮')
})

test('placeFolderMenu: 高度收敛 —— 上下都放不开时菜单变矮而不是画到视口外', () => {
  const viewport = { width: 600, height: 300 }
  const pos = placeFolderMenu({ left: 60, top: 140, bottom: 170, right: 160 }, viewport, { width: 200, height: 400 })
  assert.ok(pos.height <= pos.maxHeight, 'height 不能超过 maxHeight')
  assert.ok(pos.top >= 8, `顶部越出：${pos.top}`)
  assert.ok(pos.top + pos.height <= viewport.height - 8, `下沿越出：${pos.top + pos.height} > ${viewport.height - 8}`)
})

test('placeFolderMenu: 右边界溢出时向左挪，不越出视口', () => {
  const viewport = { width: 300, height: 500 }
  const pos = placeFolderMenu({ left: 280, top: 10, bottom: 40, right: 300 }, viewport, { width: 200, height: 100 })
  assert.ok(pos.left + pos.width <= viewport.width - 8, `菜单右边界越出：${pos.left}+${pos.width}`)
  assert.ok(pos.left >= 8)
})

test('placeFolderMenu: 非有限输入不会把菜单送到 NaN（走 placePopover 的兜底）', () => {
  const pos = placeFolderMenu({ left: Number.NaN, top: Number.NaN, bottom: Number.NaN, right: Number.NaN }, { width: 800, height: 600 })
  for (const value of [pos.left, pos.top, pos.width, pos.maxHeight, pos.height]) {
    assert.ok(Number.isFinite(value), `出现非有限值：${JSON.stringify(pos)}`)
  }
})

test('folderMenuAnchor: 锚点与视口是**视口坐标**（菜单 portal 到 body，不再按"包含块"换算）', () => {
  const { anchor, viewport } = folderMenuAnchor({ top: 100, bottom: 130, left: 280, right: 380 }, { width: 1200, height: 800 })
  assert.deepEqual(anchor, { top: 100, bottom: 130, left: 280, right: 380 })
  assert.deepEqual(viewport, { width: 1200, height: 800 })
  // 同一份输入喂给 placePopover（权威实现）必须得到同一个结果 —— 证明没有第二份摆放逻辑
  const viaHelper = placeFolderMenu(anchor, viewport, { width: 200, height: 100 })
  const viaAuthority = placePopover({ anchor, viewport, menu: { width: 200, height: 100 }, prefer: 'bottom' })
  assert.deepEqual(viaHelper, viaAuthority)
})

test('placePopover 的 prefer：菜单要往下弹，选择器要往上弹（同一个算法两种场景）', () => {
  const anchor = { top: 200, bottom: 230, left: 100, right: 200 }
  const both = { width: 600, height: 600 }
  const menu = { width: 200, height: 100 }
  assert.equal(placePopover({ anchor, viewport: both, menu }).side, 'top', '缺省仍是往上（模型选择器的老行为）')
  assert.equal(placePopover({ anchor, viewport: both, menu, prefer: 'bottom' }).side, 'bottom', 'prefer=bottom 时往下')
  assert.equal(placePopover({ anchor, viewport: both, menu, prefer: 'bottom' }).top, 236)
})
