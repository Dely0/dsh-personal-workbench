#!/usr/bin/env python3
"""D17 通用打印工具：打印指定行区间（1-based，含端点）。"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = sys.argv[1] if len(sys.argv) > 1 else "src/client/index.tsx"
lo = int(sys.argv[2])
hi = int(sys.argv[3])
lines = open(FILE, "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").split("\n")
print(f"{FILE}  共 {len(lines)} 行  —— 打印 {lo}–{hi}")
for i in range(lo - 1, min(hi, len(lines))):
    print(f"{i + 1:5d} {lines[i]}")
