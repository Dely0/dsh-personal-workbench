#!/usr/bin/env python3
"""D17 一次性切片脚本（P1 知识域）。

规矩（本仓 skill §14）：**切片必须用唯一标记**，命中 0 次或 >1 次一律报错不写。
本脚本只做「精确插入 / 精确删除」，不做正则替换；每步都打印命中次数。
"""
import sys

FILE = "src/client/index.tsx"
src = open(FILE, encoding="utf-8", newline="").read()
orig_len = len(src)
results = []


def cut(label, snippet):
    global src
    n = src.count(snippet)
    if n != 1:
        raise SystemExit(f"ABORT {label}: 命中 {n} 次（要求恰好 1 次）")
    src = src.replace(snippet, "", 1)
    results.append(f"CUT   {label}  -{len(snippet)}")


def replace(label, old, new):
    global src
    n = src.count(old)
    if n != 1:
        raise SystemExit(f"ABORT {label}: 命中 {n} 次（要求恰好 1 次）")
    src = src.replace(old, new, 1)
    results.append(f"REPL  {label}  +{len(new) - len(old)}")


replace(
    "imports: hook + views",
    "import { KnowledgeList, KnowledgePager, KnowledgeToolbar, EMPTY_KNOWLEDGE_FILTERS, kindTabs, reconcileKnowledgeKinds, selectedKind, type KnowledgeFilters } from './components/KnowledgeList.js'\r\n",
    "import { KnowledgeList, KnowledgePager, KnowledgeToolbar, EMPTY_KNOWLEDGE_FILTERS, kindTabs, reconcileKnowledgeKinds, selectedKind, type KnowledgeFilters } from './components/KnowledgeList.js'\r\n"
    "import { useKnowledge } from './hooks/useKnowledge.js'\r\n"
    "import { KnowledgeListView } from './views/KnowledgeListView.js'\r\n"
    "import { KnowledgeDetailPane } from './views/KnowledgeDetailPane.js'\r\n",
)

cut(
    "key: KNOWLEDGE_FILTER_STORAGE_KEY",
    "\r\n/** 知识库列表状态的本地存储键（Tab 与排序要在刷新后保持，见验收项）。 */\r\n"
    "const KNOWLEDGE_FILTER_STORAGE_KEY = 'dsh.personal-workbench.knowledgeList'\r\n",
)

cut(
    "readKnowledgeFilters + writeKnowledgeFilters",
    "/**\r\n"
    " * 读回知识库列表状态。\r\n"
    " *\r\n"
    " * 存储里的值**一律不可信**（分类可能被删、排序键可能改过、JSON 可能被手改）。\r\n"
    " * ⚠️ 分类的合法性**必须拿到字典后才能判**（字典是异步来的），所以这里只做\"形状\"归一化，\r\n"
    " * 真正\"这个分类还在不在\"由 `useEffect` 里的 `reconcileKnowledgeKinds` 收口 —— 否则删过分类的用户\r\n"
    " * 下次打开会看到**空列表且没有任何 Tab 高亮**（v1.15.2 复审 F3）。\r\n"
    " * localStorage 不可用（隐私模式）时静默降级为默认值。\r\n"
    " */\r\n"
    "function readKnowledgeFilters(): KnowledgeFilters {\r\n"
    "  try {\r\n"
    "    const raw = localStorage.getItem(KNOWLEDGE_FILTER_STORAGE_KEY)\r\n"
    "    if (raw === null) return EMPTY_KNOWLEDGE_FILTERS\r\n"
    "    const saved = JSON.parse(raw) as Record<string, unknown>\r\n"
    "    const kinds = Array.isArray(saved.kinds) && saved.kinds.every((k) => typeof k === 'string') && saved.kinds.length > 0\r\n"
    "      ? saved.kinds as string[]\r\n"
    "      : ['all']\r\n"
    "    const tags = Array.isArray(saved.tags) ? saved.tags.filter((t): t is string => typeof t === 'string') : []\r\n"
    "    const sortKey = normalizeSortKey(saved.sortKey)\r\n"
    "    return {\r\n"
    "      keyword: '',\r\n"
    "      kinds,\r\n"
    "      tags,\r\n"
    "      sortKey,\r\n"
    "      sortDir: saved.sortDir === undefined ? DEFAULT_SORT_DIR : normalizeSortDir(saved.sortDir),\r\n"
    "      page: 0,\r\n"
    "      pageSize: normalizePageSize(saved.pageSize),\r\n"
    "    }\r\n"
    "  } catch {\r\n"
    "    return EMPTY_KNOWLEDGE_FILTERS\r\n"
    "  }\r\n"
    "}\r\n"
    "\r\n"
    "/**\r\n"
    " * 分类合法性的唯一收口在 `KnowledgeList.tsx` 的 `reconcileKnowledgeKinds()` 里\r\n"
    " * （可被 `node --test` 直接测；`index.tsx` 会碰 `window`，导入不了所以判定不放这儿）。\r\n"
    " * 这里只负责在**拿到字典之后**调它。\r\n"
    " */\r\n"
    "\r\n"
    "/** 只写\"要在刷新后保持\"的字段：关键词与页码是瞬时意图，不落盘。 */\r\n"
    "function writeKnowledgeFilters(filters: KnowledgeFilters): void {\r\n"
    "  try {\r\n"
    "    localStorage.setItem(KNOWLEDGE_FILTER_STORAGE_KEY, JSON.stringify({\r\n"
    "      kinds: filters.kinds,\r\n"
    "      tags: filters.tags,\r\n"
    "      sortKey: filters.sortKey,\r\n"
    "      sortDir: filters.sortDir,\r\n"
    "      pageSize: filters.pageSize,\r\n"
    "    }))\r\n"
    "  } catch { /* localStorage 不可用时静默降级：状态只在本次会话内有效 */ }\r\n"
    "}\r\n",
)

open(FILE, "w", encoding="utf-8", newline="").write(src)
print("\n".join(results))
print(f"len {orig_len} -> {len(src)}  (-{orig_len - len(src)})")
