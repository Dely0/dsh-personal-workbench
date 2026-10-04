#!/usr/bin/env python3
"""D17 通用定位工具：按源码里的唯一子串打印它所在的"块"（默认前后各 N 行）。

用法：
  python scripts/lib/d17-find.py "<子串>" [前后行数]
  python scripts/lib/d17-find.py --regex "<正则>" [前后行数]

行号口径与 d17-measure2.py 一致：原始字节 → 去 CRLF → split('\n')。
"""
import io
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

argv = sys.argv[1:]
mode = "literal"
if argv and argv[0] == "--regex":
    mode = "regex"
    argv = argv[1:]
if not argv:
    raise SystemExit(__doc__)
needle = argv[0]
window = int(argv[1]) if len(argv) > 1 else 12

FILE = "src/client/index.tsx"
raw = open(FILE, "rb").read().decode("utf-8")
lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
print(f"{FILE}  {len(lines)} 行")

hits = [i for i, l in enumerate(lines) if (needle in l if mode == "literal" else re.search(needle, l))]
if not hits:
    print(f"  0 命中：{needle!r}")
for h in hits:
    lo = max(0, h - window)
    hi = min(len(lines), h + window + 1)
    print(f"--- 命中 L{h + 1}（打印 {lo + 1}–{hi}）---")
    for i in range(lo, hi):
        print(f"{i + 1:5d} {lines[i]}")
