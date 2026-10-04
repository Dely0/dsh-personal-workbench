"""D17/P7-2 判据重锚助手：把出口自检的 ✖ 消息映射回产生它的源代码行。

用法：python -X utf8 scripts/lib/d17-find-failing-asserts.py
只读，不写任何文件。
"""
import io
import os
import re
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

NAMES = ["p1", "p2", "p3a", "p3b", "p3c", "p3d", "p4", "p5a", "p5b", "p5c", "p6b", "p6c", "p6d", "p7a"]

for n in NAMES:
    path = os.path.join("scripts", "lib", f"d17-{n}-exit-check.py")
    out = subprocess.run([sys.executable, "-X", "utf8", path], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if out.returncode == 0:
        print(f"### {n}: 全绿")
        continue
    fails = [m.group(1).strip() for m in re.finditer(r"^\s*✖\s*(.*)$", out.stdout, re.M)]
    # 去掉尾部的“N / M 项未通过”汇总行
    fails = [f for f in fails if not re.match(r"^\d+ / \d+ 项未通过", f)]
    src = open(path, encoding="utf-8").read()
    lines = src.split("\n")
    print(f"### {n}: {len(fails)} 项红")
    seen = set()
    for msg in fails:
        # 用消息里最长的一段（去掉变体）去源码里找
        key = re.split(r"[：（(]", msg)[0]
        hits = [i + 1 for i, ln in enumerate(lines) if key and key in ln]
        # 优先取含 check( 的行
        cand = [i for i in hits if "check(" in lines[i - 1]]
        pick = cand if cand else hits
        if not pick:
            print(f"    ?? {msg}")
            continue
        for i in pick:
            if (path, i) in seen:
                continue
            seen.add((path, i))
            print(f"    L{i}: {lines[i-1].strip()[:150]}")
    print()
