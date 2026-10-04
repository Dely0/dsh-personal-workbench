#!/usr/bin/env python3
"""D17 度量（唯一可信版本）：同一份文件用「字节 / 字符 / 三种行数口径」全部量一遍。

起因：之前 `scripts/lib/d17-measure.py` 与 `scripts/lib/d17-revlines.py` 对**同一份 HEAD 内容**
报出 5161 与 5725 两个行数，必须先用原始字节把口径钉死，之后再谈出口判据。
"""
import io
import os
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def report(label, raw):
    text_lf = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n").decode("utf-8", "replace")
    lf = len(text_lf.split("\n"))
    if text_lf.endswith("\n"):
        lf -= 1
    print(
        f"{label:34s} bytes={len(raw):7d}  chars(utf8)={len(raw.decode('utf-8','replace')):7d}  "
        f"CRLF={raw.count(bytes([13,10])):6d}  bareCR={raw.count(bytes([13])) - raw.count(bytes([13,10])):5d}  "
        f"LF={raw.count(bytes([10])):6d}  lines={lf}"
    )
    return lf


worktree = open("src/client/index.tsx", "rb").read()
head = subprocess.run(["git", "show", "HEAD:src/client/index.tsx"], capture_output=True).stdout
print("== 入口 ==")
wt = report("worktree src/client/index.tsx", worktree)
hd = report("HEAD src/client/index.tsx", head)

print("== 新建文件 ==")
for rel in ["src/client/hooks/useKnowledge.ts", "src/client/views/KnowledgeListView.tsx", "src/client/views/KnowledgeDetailPane.tsx"]:
    report(rel, open(rel, "rb").read())

print(f"\n入口净变化：HEAD {hd} → 工作区 {wt}（Δ {wt - hd}）")


def workbench_app(raw):
    """按大括号配对找 `function WorkbenchApp(` 的函数体范围（先归一 CRLF）。"""
    lines = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n").decode("utf-8", "replace").split("\n")
    start = None
    depth = 0
    started = False
    for i, line in enumerate(lines):
        if line.startswith("function WorkbenchApp("):
            start = i
        if start is not None:
            for ch in line:
                if ch == "{":
                    depth += 1
                    started = True
                elif ch == "}":
                    depth -= 1
            if started and depth == 0 and i >= start:
                return start + 1, i + 1, i - start + 1
    return None


print("\n== WorkbenchApp 本体 ==")
print("HEAD     ", workbench_app(head))
print("WORKTREE ", workbench_app(worktree))
print("\nTEMP 副本：", os.path.getsize(os.path.join(os.environ["TEMP"], "head-index.tsx")))
