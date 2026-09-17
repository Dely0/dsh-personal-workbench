/**
 * 变异探针：把本次新增的每条策略逐个"装回缺陷版"，确认 `pnpm test` **必须变红**。
 *
 * 为什么需要它：一条策略如果没有任何测试守得住，撤掉它测试还是全绿 —— 那"有测试"就是假象。
 * 做法：备份源码 → 改一处 → 重新构建 → 只跑相关测试文件 → 记录红/绿 → 还原。
 * 全程 try/finally 还原，失败也会把工作区恢复原状（不留半改状态）。
 *
 * 用法：node scripts/repro/probe-listview-mutations.mjs
 * 退出码 0 = 所有变异都变红（防线有效）；非 0 = 有变异仍然全绿（防线有洞）。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'

const ROOT = process.cwd()
const PRESENTATION = 'src/client/listPresentation.ts'
const KNOWLEDGE_LIST = 'src/client/components/KnowledgeList.tsx'
const IDEA_GRID = 'src/client/components/IdeaCardGrid.tsx'
const INDEX = 'src/client/index.tsx'
const STYLES = 'src/client/styles.ts'

/** 每个变异：改哪个文件、怎么改、应该让哪些测试文件变红。 */
const MUTATIONS = [
  {
    name: '升序排序被忽视（档位与合并方向都按降序走）',
    file: PRESENTATION,
    from: ": groupByTier(chunk, now, minGroup, options.descending !== false)",
    to: ': groupByTier(chunk, now, minGroup, true)',
    tests: ['test/listPresentation.test.mjs'],
  },
  {
    name: '"按创建时间排序"读成同一个对象的字段（退化成按 id 排）',
    file: PRESENTATION,
    // 去掉括号就复现了 `??` 绑到整个三元式上的老写法
    from: "    const at = readTime((key === 'updatedAt' ? a.updatedAt : a.createdAt) ?? '')\n    const bt = readTime((key === 'updatedAt' ? b.updatedAt : b.createdAt) ?? '')",
    to: "    const at = readTime(key === 'updatedAt' ? a.updatedAt : a.createdAt ?? '')\n    const bt = readTime(key === 'updatedAt' ? a.updatedAt : b.createdAt ?? '')",
    tests: ['test/listPresentation.test.mjs'],
  },
  {
    name: '非时间排序键仍然做时间分组（排序键被组序打乱）',
    file: PRESENTATION,
    from: '  const grouped = sortKey === \'updatedAt\'',
    to: '  const grouped = true',
    tests: ['test/listPresentation.test.mjs', 'test/listViews.test.mjs'],
  },
  {
    name: 'Tab 高亮写死 all（切 Tab 看不到高亮变化）',
    file: KNOWLEDGE_LIST,
    from: 'current={selectedKind(filters)}',
    to: "current={'all'}",
    tests: ['test/listViewWiring.test.mjs'],
  },
  {
    name: '标签两侧归一化不一致（chip 点下去 0 条）',
    file: PRESENTATION,
    from: '  const owned = item.tags.map(normalizeTag)\n  return selected.some((tag) => owned.includes(normalizeTag(tag)))',
    to: '  return selected.some((tag) => item.tags.includes(tag))',
    tests: ['test/listPresentation.test.mjs'],
  },
  {
    name: '存下来的分类不与字典对账（删过分类的用户看到空列表且无高亮）',
    file: KNOWLEDGE_LIST,
    from: '  if (knownCodes.includes(current)) return null\n  return { ...filters, kinds: [\'all\'], page: 0 }',
    to: '  void knownCodes\n  return null',
    tests: ['test/listViews.test.mjs'],
  },
  {
    name: '菜单不再夹回视口（滚动后飘到面板外）',
    file: IDEA_GRID,
    from: "  return placePopover({ anchor, viewport, menu, prefer: 'bottom' })",
    to: "  return { side: 'bottom', left: anchor.left, top: anchor.bottom, width: menu.width, maxHeight: menu.height, height: menu.height }",
    tests: ['test/listViews.test.mjs'],
  },
  {
    name: '搜索不再命中正文（只搜标题）',
    file: PRESENTATION,
    from: 'return `${item.title}\\n${item.body}\\n${item.tags.join(\' \')}`.toLowerCase().includes(q)',
    to: 'return `${item.title}`.toLowerCase().includes(q)',
    tests: ['test/listPresentation.test.mjs', 'test/listViews.test.mjs'],
  },
  {
    name: '标签筛选退化成"恒真"（勾了不生效）',
    file: PRESENTATION,
    from: '  const owned = item.tags.map(normalizeTag)\n  return selected.some((tag) => owned.includes(normalizeTag(tag)))',
    to: '  const owned = item.tags.map(normalizeTag)\n  void owned\n  return true',
    tests: ['test/listPresentation.test.mjs', 'test/listViews.test.mjs'],
  },
  {
    name: '稀疏组不再合并（数据少时一堆"今天 1 / 本周 1"空壳组头）',
    file: PRESENTATION,
    from: '    if (neighbor !== undefined && list.length < minGroup) {',
    to: '    if (neighbor !== undefined && false) {',
    tests: ['test/listPresentation.test.mjs'],
  },
  {
    name: '越界页码不再夹回（渲染空页）',
    file: PRESENTATION,
    from: '  const safePage = Math.min(normalizePage(page), pageTotal - 1)',
    to: '  const safePage = normalizePage(page)',
    tests: ['test/listPresentation.test.mjs'],
  },
  {
    name: '「清空筛选」按钮的可用性判据改成恒假（永远点不动）',
    file: KNOWLEDGE_LIST,
    from: "  return f.keyword.trim() !== '' || f.tags.length > 0 || selectedKind(f) !== 'all'",
    to: '  return false',
    tests: ['test/listViews.test.mjs'],
  },
  {
    name: '知识库行丢掉正文摘要（只剩标题）',
    file: KNOWLEDGE_LIST,
    from: '<div className="wb-kb-sum">{entry.body.split(\'\\n\')[0]}</div>',
    to: '<div className="wb-kb-sum"></div>',
    tests: ['test/listViews.test.mjs'],
  },
  {
    name: '点子卡片丢掉多选 ☑（AI 关联选不了）',
    file: IDEA_GRID,
    from: '                data-idea-pick={idea.id}',
    to: '                data-idea-pick-removed={idea.id}',
    tests: ['test/listViews.test.mjs', 'test/listViewWiring.test.mjs'],
  },
  {
    name: '菜单位置不再夹回视口（长列表/贴边时飘到面板外）',
    file: IDEA_GRID,
    from: "  return placePopover({ anchor, viewport, menu, prefer: 'bottom' })",
    to: "  return { side: 'bottom', left: anchor.left, top: anchor.bottom, width: menu.width, maxHeight: menu.height, height: menu.height }",
    tests: ['test/listViews.test.mjs'],
  },
  {
    name: 'portal 菜单丢掉 pointer-events 两段式（看得见、点不动）',
    file: STYLES,
    from: '  pointer-events:none; overflow-y:auto; }\n.wb-idea-foldmenu > * { pointer-events:auto; }',
    to: '  pointer-events:none; overflow-y:auto; }',
    tests: ['test/listViewWiring.test.mjs'],
  },  {
    name: 'portal 菜单 z-index 低于面板宿主（被卡片盖住，点到的还是卡片）',
    file: STYLES,
    from: '.wb-idea-foldmenu { position:fixed; z-index:60;',
    to: '.wb-idea-foldmenu { position:fixed; z-index:40;',
    tests: ['test/listViewWiring.test.mjs'],
  },
]

const results = []
/**
 * 跑一条命令并回传成败。
 *
 * 注意两件事（都踩过）：
 * - Windows 上 `pnpm` 是 .cmd，必须 `shell: true`；
 * - `stdio: 'pipe'` 下拿不到输出就会让"构建失败"变成一句空话 —— 失败时把输出带回去，别静默。
 */
function run(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', shell: true })
    return { ok: true, out: '' }
  } catch (error) {
    return { ok: false, out: `${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}\n${error.message}` }
  }
}

/** 构建：直接跑三步，别经过 pnpm（少一层 shell 就少一类偶发）。 */
function build() {
  const rm = run('node', ['-e', "require('node:fs').rmSync('lib',{recursive:true,force:true})"])
  if (!rm.ok) return rm
  const tsc = run('npx', ['tsc', '-p', 'tsconfig.build.json'])
  if (!tsc.ok) return tsc
  return run('npx', ['tsdown'])
}

console.log('基线：先构建，再确认未变异时相关测试是绿的')
const baselineBuild = build()
if (!baselineBuild.ok) {
  console.error(`FAIL: 基线构建失败，先修构建。输出（尾部）：\n${baselineBuild.out.slice(-3000) || '(空输出)'}`)
  process.exit(1)
}
const baseline = run('node', ['--test', 'test/listPresentation.test.mjs', 'test/listViews.test.mjs', 'test/listViewWiring.test.mjs'])
if (!baseline.ok) {
  console.error('FAIL: 未变异时测试就是红的，探针无意义。先修好测试再跑探针。')
  console.error(baseline.out.slice(-2000))
  process.exit(1)
}
console.log('基线 ok（全绿）\n')

const backups = new Map()
/** 归一化成 \n 的源码（变异片段按 \n 写）+ 该文件原本是否 CRLF（还原用）。 */
const normalized = new Map()
const wroteCrlf = new Map()
try {
  for (const m of MUTATIONS) {
    if (!backups.has(m.file)) {
      const original = readFileSync(m.file, 'utf8')
      backups.set(m.file, original)
      // 变异片段是用 \n 写的，而 Windows 检出可能是 CRLF —— 统一成 \n 再比对，
      // 还原时按原样写回（backups 存的是原始字节内容）。
      normalized.set(m.file, original.replace(/\r\n/g, '\n'))
      wroteCrlf.set(m.file, original.includes('\r\n'))
    }
    const original = backups.get(m.file)
    const normalizedSource = normalized.get(m.file)
    if (!normalizedSource.includes(m.from)) {
      results.push({ name: m.name, ok: false, detail: `源码里找不到要替换的片段（策略可能已改名）：${m.from.slice(0, 60)}…` })
      console.log(`FAIL  ${m.name}\n      找不到替换片段（探针失效，需更新）`)
      continue
    }
    const mutated = normalizedSource.replace(m.from, m.to)
    // 该文件原本是 CRLF 就写回 CRLF，避免为了跑探针把整个文件的行尾改掉
    writeFileSync(m.file, wroteCrlf.get(m.file) === true ? mutated.replace(/\n/g, '\r\n') : mutated)
    // 判定模块要重新构建（测试跑的是 lib/），组件是 .tsx，由 tsx 构建进 lib
    const built = build()
    if (!built.ok) {
      results.push({ name: m.name, ok: false, detail: '变异后构建失败（说明变异本身不合法）' })
      console.log(`FAIL  ${m.name}\n      变异后构建失败`)
      continue
    }
    const red = run('node', ['--test', ...m.tests])
    const guardWorks = red.ok === false
    results.push({ name: m.name, ok: guardWorks, detail: guardWorks ? '变红 ✓' : '仍然全绿 ✗（这条策略没有测试守得住）' })
    console.log(`${guardWorks ? 'ok  ' : 'FAIL'}  ${m.name} — ${guardWorks ? '变红 ✓' : '仍然全绿 ✗'}`)
    // 立刻还原，避免下一个变异的基线是脏的
    writeFileSync(m.file, original)
    build()
  }
} finally {
  for (const [file, content] of backups) writeFileSync(file, content)
  build()
  console.log('\n已还原全部源码并重建。')
}

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`变异探针：${results.length - failed.length}/${results.length} 条变异都变红`)
if (failed.length > 0) {
  console.log('防线有洞：')
  for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail)
  process.exit(1)
}
