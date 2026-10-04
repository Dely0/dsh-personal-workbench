#!/usr/bin/env python3
"""给 index.tsx 打分号并跑括号平衡，定位「未闭合的 { 是在哪一个改动片段之后变成 -1 的」。

做法：把 diff 的每个删除/替换块在**新文件**里的对应位置标出来，逐块（从后往前）
把这些行从新文件里、连同 HEAD 对应行一起拉出来，人工看结构。
本脚本只负责打印每个 diff 块的「HEAD 行」与「新行」，供人眼定位。
"""
import difflib
import io
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

old = subprocess.run(["git", "show", "HEAD:src/client/index.tsx"], capture_output=True).stdout.decode("utf-8").replace("\r\n", "\n").split("\n")
new = open("src/client/index.tsx", encoding="utf-8", newline="").read().replace("\r\n", "\n").split("\n")

BAL = {")": "(", "]": "[", "}": "{"}


def delta(lines):
    """该行块的 ( [ { 净变化（粗略：不区分字符串 —— 只用来找"变化量对不上的块"）。"""
    d = 0
    for s in lines:
        for ch in s:
            if ch in "([{":
                d += 1
            elif ch in ")]}":
                d -= 1
    return d


sm = difflib.SequenceMatcher(a=old, b=new, autojunk=False)
print(f"{'op':<9}{'old':<18}{'new':<18}{'HEADΔ':>7}{'NEWΔ':>7}{'差':>6}")
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == "equal":
        continue
    do = delta(old[i1:i2])
    dn = delta(new[j1:j2])
    mark = "  <<<< 不平衡" if do != dn else ""
    print(f"{tag:<9}old[{i1 + 1}:{i2}]{'':<4}new[{j1 + 1}:{j2}]{'':<4}{do:>7}{dn:>7}{dn - do:>6}{mark}")
