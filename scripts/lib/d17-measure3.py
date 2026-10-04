#!/usr/bin/env python3
"""D17 行数度量：入口总行数与 `WorkbenchApp` 本体行数（设计文档 §2.1 的两条硬出口）。

口径（与 baseline.md 一致，避免"两种量法各说一套"）：
- 入口总行数 = `src/client/index.tsx` 的 `split('\\n')` 长度减 1（结尾换行不算一行）—— 与 `(Get-Content f).Count` 同值；
- `WorkbenchApp` 本体 = 从 `function WorkbenchApp(` 那一行到**配对的收尾大括号**行（含两端）。
"""
import io
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PATH = "src/client/index.tsx"
src = open(PATH, encoding="utf-8", newline="").read().replace("\r\n", "\n")
lines = src.split("\n")
if lines and lines[-1] == "":
    lines.pop()

start = None
for i, l in enumerate(lines):
    if re.match(r"^(export )?function WorkbenchApp\(", l):
        start = i
        break
if start is None:
    # 主组件可能已被 P7 移进 app/WorkbenchApp.tsx
    print("index.tsx 里没有 `function WorkbenchApp(`")
    sys.exit(0)

depth = 0
end = None
for j in range(start, len(lines)):
    depth += lines[j].count("{") - lines[j].count("}")
    if j > start and depth == 0:
        end = j
        break

print(f"入口 {PATH}：{len(lines)} 行")
print(f"WorkbenchApp：第 {start + 1}–{end + 1} 行，共 {end - start + 1} 行")
print(f"WorkbenchApp 之外的入口代码：{len(lines) - (end - start + 1)} 行")
for name in ["const WorkbenchApp", "WorkbenchApp = "]:
    print(f"  另有 {name!r} 命中 {src.count(name)} 次")
