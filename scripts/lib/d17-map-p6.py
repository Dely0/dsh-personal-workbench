#!/usr/bin/env python3
"""P6 测绘：列出 WorkbenchApp 体内所有"顶层语句"（行首 2 空格缩进）的起止行与长度。"""
import io
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PATH = sys.argv[1] if len(sys.argv) > 1 else "src/client/index.tsx"
src = open(PATH, encoding="utf-8", newline="").read().replace("\r\n", "\n").replace("\r", "\n")
lines = src.split("\n")
start = next(i for i, l in enumerate(lines) if l.startswith("function WorkbenchApp("))
# 顶层结束：行首单个 '}'
end = next(i for i in range(start + 1, len(lines)) if lines[i] == "}")

# 顶层语句起点：行首恰好 2 空格且不是空行/注释
starts = []
i = start + 1
while i < end:
    l = lines[i]
    if re.match(r"^  \S", l):
        starts.append(i)
    i += 1
# 合并连续行（同一语句的续行），按"括号深度回到 0"归并
blocks = []
for si, s in enumerate(starts):
    e = starts[si + 1] - 1 if si + 1 < len(starts) else end - 1
    blocks.append((s + 1, e + 1, e - s + 1, lines[s].strip()[:90]))

print(f"{PATH}: WorkbenchApp L{start+1}-L{end+1} ({end-start+1} 行)，顶层语句 {len(blocks)} 个\n")
for s, e, n, text in blocks:
    if n >= 20 or re.match(r"^  (const|function|async)", lines[s - 1]):
        print(f"L{s:>5}-{e:<5} {n:>5} 行  {text}")
