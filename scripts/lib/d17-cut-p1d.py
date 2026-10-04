#!/usr/bin/env python3
"""D17 P1：按**行区间**删除入口里的知识域痕迹（区间来自人工核对过的行内容）。

为什么按行：中文注释里带全角标点与引号，写进另一份带转义的脚本容易字面不符（第一次就踩了）。
安全措施：每个区间都声明「首行/末行必须各自包含的子串」，不满足就整体中止、不写文件；
区间之间必须不重叠、并且由小到大。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
lines = open(FILE, encoding="utf-8", newline="").read().split("\r\n")
orig = len(lines)

# (label, start, end, 首行子串, 末行子串)  —— 行号 1-based，闭区间
RANGES = [
    ("state: knowledgeEntries … filePickerError", 412, 428,
     "const [knowledgeEntries", "const [filePickerError"),
    ("loader: loadKnowledge + effect", 593, 600,
     "知识库：一次取回后", "}, [view, loadKnowledge, knowledgeRefreshKey])"),
    ("handlers: summarizeLocalDoc … pickAndSummarizeLocalFile", 1567, 1620,
     "const summarizeLocalDoc", "void summarizeLocalDoc(entry.path)"),
    ("handler: openKnowledgeFile", 1665, 1678,
     "const openKnowledgeFile", "已调用系统打开文件"),
    ("derived: knowledgeDicts … reconcile effect", 1962, 2004,
     "知识库：把「条目 + 筛选状态」", "}, [knowledgeFilters, knowledgeDicts])"),
]

for label, s, e, head_token, tail_token in RANGES:
    first = lines[s - 1]
    last = lines[e - 1]
    if head_token not in first:
        raise SystemExit(f"ABORT {label}: 首行不含 {head_token!r} → {first!r}")
    if tail_token not in last:
        raise SystemExit(f"ABORT {label}: 末行不含 {tail_token!r} → {last!r}")
    print(f"CHECK {label}: {s}-{e}")
    print(f"      first: {first.strip()[:90]}")
    print(f"      last : {last.strip()[:90]}")

# 从后往前删，行号不受影响
for label, s, e, _h, _t in sorted(RANGES, key=lambda r: r[1], reverse=True):
    del lines[s - 1:e]
    print(f"CUT   {label}: -{e - s + 1} 行")

open(FILE, "w", encoding="utf-8", newline="").write("\r\n".join(lines))
print(f"lines {orig} -> {len(lines)}")
