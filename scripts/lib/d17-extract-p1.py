#!/usr/bin/env python3
"""D17 P1：把知识域的 JSX 原样切出来，供 views/ 使用（不自动删，先人工核对）。

用法：python scripts/lib/d17-extract-p1.py
输出：%TEMP%/d17-p1-nav.txt、d17-p1-detail.txt（带行号的原文片段）
"""
import os
import tempfile

FILE = "src/client/index.tsx"
lines = open(FILE, encoding="utf-8", newline="").read().split("\r\n")


def dump(name, start, end):
    body = "\r\n".join(lines[start - 1:end])
    path = os.path.join(tempfile.gettempdir(), name)
    open(path, "w", encoding="utf-8", newline="").write(body)
    return body


def find(pred, start=0):
    for i in range(start, len(lines)):
        if pred(lines[i]):
            return i + 1
    return -1


nav_start = find(lambda l: l.strip() == "{view === 'knowledge' && (")
nav_end = find(lambda l: l.strip() == "{view === 'ideas' && (", nav_start) - 1
detail_start = find(lambda l: l.strip() == "? knowledgeDraft !== null")
detail_end = find(lambda l: l.strip().startswith(": selected === null"), detail_start)
# 详情分支的结尾是列表那一行的 `: <div className="wb-empty">← 从左侧选择或新建知识条目</div>` 之前
detail_last = find(lambda l: "← 从左侧选择或新建知识条目" in l, detail_start)
print("nav   :", nav_start, "-", nav_end)
print("detail:", detail_start, "-", detail_last)
print(dump("d17-p1-nav.txt", nav_start, nav_end))
print("==========")
print(dump("d17-p1-detail.txt", detail_start, detail_last))
