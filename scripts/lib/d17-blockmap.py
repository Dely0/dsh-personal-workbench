#!/usr/bin/env python3
"""定位未闭合的 `{`：打印每个顶层语句块的累计括号深度（粗扫，跳过字符串/注释）。"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

src = open("src/client/index.tsx", encoding="utf-8", newline="").read()
pairs = {")": "(", "]": "[", "}": "{"}
depth = {"(": 0, "[": 0, "{": 0}
i, n = 0, len(src)
line = 1
mode = None
marks = []
while i < n:
    c = src[i]
    if c == "\n":
        line += 1
        # 行首：记录深度与行首文本
        j = i + 1
        k = j
        while k < n and src[k] not in "\r\n":
            k += 1
        text = src[j:k]
        marks.append((line + 1, dict(depth), text[:60]))
    if mode == "line":
        if c == "\n":
            mode = None
        i += 1
        continue
    if mode == "block":
        if c == "*" and i + 1 < n and src[i + 1] == "/":
            mode = None
            i += 2
            continue
        i += 1
        continue
    if mode in ("sq", "dq", "tpl"):
        if c == "\\":
            i += 2
            continue
        if (mode == "sq" and c == "'") or (mode == "dq" and c == '"') or (mode == "tpl" and c == "`"):
            mode = None
        i += 1
        continue
    if c == "/" and i + 1 < n and src[i + 1] == "/":
        mode = "line"
        i += 2
        continue
    if c == "/" and i + 1 < n and src[i + 1] == "*":
        mode = "block"
        i += 2
        continue
    if c == "'":
        mode = "sq"
        i += 1
        continue
    if c == '"':
        mode = "dq"
        i += 1
        continue
    if c == "`":
        mode = "tpl"
        i += 1
        continue
    if c in depth:
        depth[c] += 1
    if c in pairs:
        depth[pairs[c]] -= 1
    i += 1

# 打印深度 { 的转换点：找 0→1 的行（顶层块的开始）与最终未闭合
prev = None
opens = []
for ln, d, text in marks:
    if prev is not None and prev["{"] == 0 and d["{"] >= 1:
        opens.append(ln)
    prev = d
print("顶层 `{` 起点行（节选）：", opens)
print("最终深度：", depth)
# 打印每个顶层块的名称（取起点行文本）
for ln in opens:
    print(f"  L{ln}: {dict((l, t) for l, _, t in marks if l == ln)}")
