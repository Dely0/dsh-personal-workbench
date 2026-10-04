#!/usr/bin/env python3
"""D17 P1：清理入口里已经不再使用的 import（逐条按"名字在文件里出现次数"判定，不做猜测）。"""
import io
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, encoding="utf-8", newline="").read()
orig = len(src)
log = []

# 整行删除的 import（这些名字只保留在 import 行里 —— 已用 grep 逐个核对）
DROP_LINES = [
    "import { KnowledgeList, KnowledgePager, KnowledgeToolbar, EMPTY_KNOWLEDGE_FILTERS, kindTabs, reconcileKnowledgeKinds, selectedKind, type KnowledgeFilters } from './components/KnowledgeList.js'\r\n",
]
for line in DROP_LINES:
    n = src.count(line)
    if n != 1:
        raise SystemExit(f"ABORT 删除 import 行: 命中 {n} 次 → {line!r}")
    src = src.replace(line, "", 1)
    log.append(f"DROP  {line.strip()[:70]}")

# 部分删除：从 listPresentation / format / viewTypes 的 import 里摘掉搬走的符号
PARTIAL = [
    ("listPresentation",
     "  DEFAULT_SORT_DIR, buildListPage, normalizePageSize, normalizeSortDir, normalizeSortKey, toContentItem,\r\n",
     "  DEFAULT_SORT_DIR, buildListPage, toContentItem,\r\n"),
    ("viewTypes: KnowledgeEntry",
     "  KnowledgeEntry, ModelDirectoryRuntime,",
     "  ModelDirectoryRuntime,"),
]
for label, old, new in PARTIAL:
    n = src.count(old)
    if n != 1:
        raise SystemExit(f"ABORT {label}: 命中 {n} 次")
    src = src.replace(old, new, 1)
    log.append(f"EDIT  {label}")

open(FILE, "w", encoding="utf-8", newline="").write(src)
print("\n".join(log))
print(f"len {orig} -> {len(src)}  ({len(src) - orig:+d})")
