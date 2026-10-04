#!/usr/bin/env python3
"""D17：核对各提交点 `src/client/index.tsx` 的真实行数（施工起点溯源的证据）。"""
import io
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

REVS = [
    "f99bf77", "53cd8b5", "00662f3", "d2f9937", "8b2900b", "6ff84b0",
    "a1e94c2", "e995fad", "d996222", "0d95769", "f3f2c7c",
]

for rev in REVS:
    proc = subprocess.run(["git", "show", f"{rev}:src/client/index.tsx"], capture_output=True)
    text = proc.stdout.decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]
    print(f"{rev}  {len(lines):5d} 行  {len(proc.stdout):8d} 字节")
