#!/usr/bin/env python3
"""对比 HEAD 版与工作区版 index.tsx 的行，找出「工作区少掉的、且不在我预期删除范围内」的行。"""
import io
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

old = subprocess.run(
    ["git", "show", "HEAD:src/client/index.tsx"], capture_output=True
).stdout.decode("utf-8").replace("\r\n", "\n").split("\n")
new = open("src/client/index.tsx", encoding="utf-8", newline="").read().replace("\r\n", "\n").split("\n")

import difflib

# 只打印「删除」的块，并且只打印前 5 行 + 后 3 行（省输出）
sm = difflib.SequenceMatcher(a=old, b=new, autojunk=False)
removed_total = 0
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag in ("delete", "replace"):
        removed_total += i2 - i1
        print(f"--- {tag} old[{i1 + 1}:{i2}] new[{j1 + 1}:{j2}] 删 {i2 - i1} 行")
        shown = old[i1:i2]
        if len(shown) > 12:
            for k, s in enumerate(shown[:5]):
                print(f"    {i1 + 1 + k}: {s}")
            print("    ...")
            for k, s in enumerate(shown[-4:]):
                print(f"    {i2 - 3 + k}: {s}")
        else:
            for k, s in enumerate(shown):
                print(f"    {i1 + 1 + k}: {s}")
print(f"总删除行数 {removed_total}；old {len(old)} → new {len(new)}")
