#!/usr/bin/env python3
"""D17 P1：修 KnowledgeListView 的两处。

1) `onOpen` 的形参必须是 `ContentItem`（`KnowledgeList` 的口径），不是 `KnowledgeEntry`；
   拆前入口是在这里 `entries.find(...)` 查出整条再 `setSelectedKnowledge(entry)`，
   现在域模型提供 `openEntryById(id)` —— **同语义、不再多做一次线性查找**。
2) `dicts` 在入口里是 `dictOf('knowledge_kind')` 的 `useMemo`，现在 `model.dicts` 就是它，
   视图里再调一次 `dictOf(...)` 等于重建第二份（且 dictOf 在渲染里调用会新建数组）。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/views/KnowledgeListView.tsx"
raw = open(FILE, encoding="utf-8", newline="").read()
src = raw.replace("\r\n", "\n").replace("\r", "\n")


def sub1(old, new, tag):
    global src
    n = src.count(old)
    if n != 1:
        raise SystemExit(f"ABORT [{tag}] 命中 {n} 次")
    src = src.replace(old, new, 1)
    print(f"  ok  {tag}")


sub1(
    "  const { entries, filters, page, selected, filePicker } = model\n  const dicts = dictOf('knowledge_kind')\n",
    "  const { entries, filters, page, selected, filePicker, dicts } = model\n",
    "dicts 直接取 model.dicts（不再二次重建）",
)
sub1(
    "            onOpen={model.openEntry}",
    "            // 拆前是 `entries.find(e => e.id === item.id)` 再 setSelectedKnowledge —— 同一个结果。\n"
    "            onOpen={(item) => model.openEntryById(item.id)}",
    "onOpen 形参改 ContentItem",
)

open(FILE, "w", encoding="utf-8", newline="").write(src.replace("\n", "\r\n"))
print("OK  KnowledgeListView.tsx 已写回")
