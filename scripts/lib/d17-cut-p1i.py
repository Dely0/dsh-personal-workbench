#!/usr/bin/env python3
"""D17 P1：把入口里剩下的 `view === 'knowledge'` 左侧分支换成 <KnowledgeListView>。

（上一轮这份替换因为老字符串里少了一个空格的行导致 `count != 1` 静默跳过；
现在改成按行区间切，带首尾行内容校验，不会再"悄悄没换"。）
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
lines = open(FILE, encoding="utf-8", newline="").read().split("\r\n")

START, END = 3209, 3251
first, last = lines[START - 1], lines[END - 1]
assert first.strip() == "{view === 'knowledge' && (", f"首行不符: {first!r}"
assert last.strip() == ")}", f"末行不符: {last!r}"

NEW = "          {view === 'knowledge' && <KnowledgeListView model={knowledge} dictOf={dictOf} busy={busy} />}"
del lines[START - 1:END]
lines.insert(START - 1, NEW)

open(FILE, "w", encoding="utf-8", newline="").write("\r\n".join(lines))
print(f"REPL  knowledge 左侧视图  {END - START + 1} 行 → 1 行")
print(f"lines -> {len(lines)}")
