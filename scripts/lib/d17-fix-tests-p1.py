#!/usr/bin/env python3
"""D17 P1：把 `listViewWiring.test.mjs` 的知识域接线判据指到真实 owner。

拆分后知识域的 owner 是 `hooks/useKnowledge.ts`（状态/effect/落盘）与
`views/KnowledgeListView.tsx`（工具栏/列表/分页）。判据**逐条搬家、语义不变**，
只有两类真的变强：
- `setKnowledgeFilters` 的"恰好 2 处"从 index.tsx 改成**全客户端目录**；
- 工具条必须**恰好出现一次**（全客户端），防止知识域两处装配。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "test/listViewWiring.test.mjs"
raw = open(FILE, encoding="utf-8", newline="").read()
src = raw.replace("\r\n", "\n").replace("\r", "\n")


def sub1(old, new, tag):
    global src
    if new in src and old not in src:
        print(f"  --  {tag}（已应用，跳过）")
        return
    n = src.count(old)
    if n != 1:
        raise SystemExit(f"ABORT [{tag}] 命中 {n} 次")
    src = src.replace(old, new, 1)
    print(f"  ok  {tag}")


sub1(
    "const indexSource = readFileSync('src/client/index.tsx', 'utf8')\n"
    "const knowledgeSource = readFileSync('src/client/components/KnowledgeList.tsx', 'utf8')",
    "import { read, assertClientCount } from './_clientSources.mjs'\n"
    "\n"
    "const indexSource = read('src/client/index.tsx')\n"
    "/**\n"
    " * D17/P1：知识域的 owner 已经不是入口了。\n"
    " * - `knowledgeHookSource`：状态 / effect / 落盘 / 动作（`hooks/useKnowledge.ts`）\n"
    " * - `knowledgeViewSource`：工具栏 / 列表 / 分页的装配与 onChange 接线（`views/KnowledgeListView.tsx`）\n"
    " */\n"
    "const knowledgeHookSource = read('src/client/hooks/useKnowledge.ts')\n"
    "const knowledgeViewSource = read('src/client/views/KnowledgeListView.tsx')\n"
    "const knowledgeSource = read('src/client/components/KnowledgeList.tsx')",
    "引入 owner 源码",
)

# 1) 唯一判定入口
sub1(
    "  assert.match(indexSource, /buildListPage\\(\\{/, '必须走唯一判定入口')\n"
    "  assert.match(indexSource, /items: knowledgeEntries\\.map\\(toContentItem\\)/, '条目经统一适配')",
    "  assert.match(knowledgeHookSource, /buildListPage<ContentItem>\\(\\{/, '必须走唯一判定入口')\n"
    "  assert.match(knowledgeHookSource, /items: entries\\.map\\(toContentItem\\)/, '条目经统一适配')",
    "1) buildListPage 判据",
)

# 2) 只拉一次全量
sub1(
    "  const loader = indexSource.match(/const loadKnowledge = useCallback\\(async \\(\\) => \\{([\\s\\S]*?)\\}, \\[\\]\\)/)",
    "  const loader = knowledgeHookSource.match(/const reload = useCallback\\(async \\(\\): Promise<void> => \\{([\\s\\S]*?)\\}, \\[\\]\\)/)",
    "2) loader 定位",
)
sub1(
    "  assert.ok(loader !== null, 'loadKnowledge 应还是 useCallback')",
    "  assert.ok(loader !== null, 'reload 应还是 useCallback（唯一拉取入口）')",
    "2) loader 描述",
)

# 3) 唯一入口 + 落盘在 effect
sub1(
    "  assert.match(indexSource, /const updateKnowledgeFilters = useCallback/, '唯一入口')\n"
    "  assert.match(indexSource, /setKnowledgeFilters\\(\\(prev\\) => \\(\\{ \\.\\.\\.prev, \\.\\.\\.patch \\}\\)\\)/, '入口只改状态')",
    "  assert.match(knowledgeHookSource, /const updateFilters = useCallback/, '唯一入口')\n"
    "  assert.match(knowledgeHookSource, /setFilters\\(\\(prev\\) => \\(\\{ \\.\\.\\.prev, \\.\\.\\.patch \\}\\)\\)/, '入口只改状态')",
    "3) 唯一入口",
)
sub1(
    "  const calls = indexSource.match(/setKnowledgeFilters\\(/g) ?? []\n"
    "  assert.equal(calls.length, 2, `setKnowledgeFilters 只该出现在「唯一入口」与「对账 effect」里，实际 ${calls.length} 处`)\n"
    "  assert.match(indexSource, /if \\(fixed !== null\\) setKnowledgeFilters\\(fixed\\)/, '第二处必须是对账 effect')",
    "  // D17/P1：改成全客户端目录范围（§8.2 要求递归覆盖）—— 搬家后只扫 index 会空洞通过\n"
    "  assertClientCount(assert, /setFilters\\(/g, 2,\n"
    "    'setFilters 在引用实现里恰好两处：唯一入口的更新函数 + 分类对账 effect')\n"
    "  assert.match(knowledgeHookSource, /if \\(fixed !== null\\) setFilters\\(fixed\\)/, '第二处必须是对账 effect')",
    "3) setKnowledgeFilters 唯一性",
)
sub1(
    "  const updater = indexSource.match(/const updateKnowledgeFilters = useCallback\\([\\s\\S]*?\\}, \\[\\]\\)/)",
    "  const updater = knowledgeHookSource.match(/const updateFilters = useCallback\\([\\s\\S]*?\\}, \\[\\]\\)/)",
    "3) updater 定位",
)
sub1(
    "  assert.match(indexSource, /useEffect\\(\\(\\) => \\{\\s*\\n\\s*writeKnowledgeFilters\\(knowledgeFilters\\)/, '落盘写成 effect')",
    "  assert.match(knowledgeHookSource, /useEffect\\(\\(\\) => \\{\\s*\\n\\s*writeKnowledgeFilters\\(filters\\)/, '落盘写成 effect')",
    "3) 落盘 effect",
)

# 4) 分类与字典对账
sub1(
    "  assert.match(indexSource, /reconcileKnowledgeKinds\\(knowledgeFilters, knowledgeDicts\\.map/, '在字典可用后调用')",
    "  assert.match(knowledgeHookSource, /reconcileKnowledgeKinds\\(filters, dicts\\.map/, '在字典可用后调用')",
    "4) 对账调用点",
)

# 5) 分类语义只派生一处
sub1(
    "  assert.match(indexSource, /tab: selectedKind\\(knowledgeFilters\\)/, '页面走 selectedKind')",
    "  assert.match(knowledgeHookSource, /tab: selectedKind\\(filters\\)/, '页面走 selectedKind')",
    "5) selectedKind 调用点",
)
sub1(
    "  const rawDerivations = (stripComments(indexSource).match(/kinds\\[0\\]/g) ?? []).length\n"
    "    + (stripComments(knowledgeSource).match(/kinds\\[0\\]/g) ?? []).length\n"
    "    + (stripComments(tabBarSource).match(/kinds\\[0\\]/g) ?? []).length",
    "  const rawDerivations = (stripComments(indexSource).match(/kinds\\[0\\]/g) ?? []).length\n"
    "    + (stripComments(knowledgeHookSource).match(/kinds\\[0\\]/g) ?? []).length\n"
    "    + (stripComments(knowledgeViewSource).match(/kinds\\[0\\]/g) ?? []).length\n"
    "    + (stripComments(knowledgeSource).match(/kinds\\[0\\]/g) ?? []).length\n"
    "    + (stripComments(tabBarSource).match(/kinds\\[0\\]/g) ?? []).length",
    "5) kinds[0] 全范围统计",
)

# 9) 改筛选只能走 onChange
sub1(
    "  const toolbar = indexSource.match(/<KnowledgeToolbar[\\s\\S]*?\\/>/)\n"
    "  assert.ok(toolbar !== null, 'KnowledgeToolbar 已接线')\n"
    "  assert.match(toolbar[0], /onChange=\\{updateKnowledgeFilters\\}/, 'onChange 直连唯一入口')\n"
    "  assert.doesNotMatch(toolbar[0], /setKnowledgeFilters/, 'JSX 里不许再直接改状态')",
    "  const toolbar = knowledgeViewSource.match(/<KnowledgeToolbar[\\s\\S]*?\\/>/)\n"
    "  assert.ok(toolbar !== null, 'KnowledgeToolbar 已接线')\n"
    "  assert.match(toolbar[0], /onChange=\\{model\\.updateFilters\\}/, 'onChange 直连唯一入口')\n"
    "  assert.doesNotMatch(toolbar[0], /setFilters/, 'JSX 里不许再直接改状态')\n"
    "  // 工具条**恰好装配一处**：知识域被装配两份就会出现两个工具条（§8.2 的递归唯一性）\n"
    "  assertClientCount(assert, /<KnowledgeToolbar/g, 1, 'KnowledgeToolbar 只许装配一处')",
    "9) onChange 接线",
)

# 11) 落盘字段
sub1(
    "  const writer = indexSource.match(/function writeKnowledgeFilters[\\s\\S]*?\\n\\}/)",
    "  const writer = knowledgeHookSource.match(/function writeKnowledgeFilters[\\s\\S]*?\\n\\}/)",
    "11) writeKnowledgeFilters 定位",
)

open(FILE, "w", encoding="utf-8", newline="").write(src.replace("\n", "\r\n"))
print("OK  listViewWiring.test.mjs 已写回")
