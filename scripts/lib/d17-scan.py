#!/usr/bin/env python3
"""D17 批量定位：一次打印多个子串/正则在 src/client/index.tsx 里的所有命中行号（只给行号，不给块）。

用法：
  python scripts/lib/d17-scan.py "子串A" --regex "^\\s*const \\[" ... [--file <path>]

输出形如：
  子串A              12 处  L281, L286, L400 ...
行号口径与 d17-find.py 一致：原始字节 → 去 CRLF → split('\n')。
"""
import io
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

argv = sys.argv[1:]
FILE = "src/client/index.tsx"
if "--file" in argv:
    i = argv.index("--file")
    FILE = argv[i + 1]
    del argv[i : i + 2]

raw = open(FILE, "rb").read().decode("utf-8")
lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
print(f"{FILE}  {len(lines)} 行")

for needle in argv:
    rx = re.compile(needle)
    hits = [i + 1 for i, l in enumerate(lines) if rx.search(l)]
    head = needle if len(needle) <= 34 else needle[:31] + "..."
    if not hits:
        print(f"{head:<36} 0 处")
        continue
    shown = ", ".join(f"L{h}" for h in hits[:24])
    more = f" ...（共 {len(hits)}）" if len(hits) > 24 else ""
    print(f"{head:<36} {len(hits)} 处  {shown}{more}")
