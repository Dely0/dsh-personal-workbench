#!/usr/bin/env python3
"""从 HEAD 的 index.tsx 里抽出点子域原始实现，供 P2 逐条核对语义。

用法：python scripts/lib/d17-head-ideas.py
"""
import io
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

src = subprocess.run(
    ["git", "show", "HEAD:src/client/index.tsx"], capture_output=True,
).stdout.decode("utf-8").replace("\r\n", "\n")
lines = src.split("\n")
print(f"HEAD index.tsx 共 {len(lines)} 行")

marks = [
    "const [ideas, setIdeas]",
    "const [ideaForm",
    "const [folderForm",
    "const loadIdeas = useCallback",
    "const ideaCardItems",
    "const unfiledIdeas",
    "const refreshIdeas",
    "const saveFolder",
    "const deleteFolder",
    "const fileIdeaInto",
    "const unfileIdeaFrom",
    "const mergeFolderInto",
]

for m in marks:
    idx = [i for i, l in enumerate(lines) if m in l]
    for i in idx:
        print(f"\n---- {m}  @HEAD L{i+1} ----")
        for k in range(i, min(i + 34, len(lines))):
            print(f"{k+1:5} {lines[k]}")
