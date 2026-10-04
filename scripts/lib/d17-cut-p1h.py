#!/usr/bin/env python3
"""D17 P1：删掉 `openKnowledgeFile` 删除后留下的那个多余 `}`（唯一一处孤立的两空格闭包行）。"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, encoding="utf-8", newline="").read()
orig = len(src)

OLD = (
    "    return { kind: 'new', notice: decision.notice }\r\n"
    "  }\r\n"
    "\r\n"
    "  }\r\n"
    "\r\n"
    "  /**\r\n"
    "   * 列目录（工作区「浏览…」弹窗）"
)
NEW = (
    "    return { kind: 'new', notice: decision.notice }\r\n"
    "  }\r\n"
    "\r\n"
    "  /**\r\n"
    "   * 列目录（工作区「浏览…」弹窗）"
)

n = src.count(OLD)
if n != 1:
    raise SystemExit(f"ABORT 多余闭包: 命中 {n} 次")
src = src.replace(OLD, NEW, 1)
open(FILE, "w", encoding="utf-8", newline="").write(src)
print(f"CUT   多余 `}}`  -{len(OLD) - len(NEW)}")
print(f"len {orig} -> {len(src)}")
