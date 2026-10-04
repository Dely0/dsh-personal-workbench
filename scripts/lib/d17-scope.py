#!/usr/bin/env python3
"""D17 作用域依赖扫描：给一个行区间，列出区间内用到了 WorkbenchApp 里的哪些局部名（及次数）。

用途：抽组件前，一次性算出"这个 JSX 块需要哪些 props"，避免逐个手翻 300 行。

用法：
  python scripts/lib/d17-scope.py <lo> <hi> [--file path]

做法：
  1. 在 WorkbenchApp（`function WorkbenchApp(` 到它结束的顶层 `}`）里，用 2 空格缩进的
     `const X =` / `let X =` / `function X(` / `const [a, setA] =` 收出局部名集合；
  2. 在给定行区间里对每个名字做**单词边界**匹配，统计出现次数；
  3. 打印 "名字 次数 首现行号"，按次数降序。
"""
import io
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

argv = sys.argv[1:]
FILE = "src/client/index.tsx"
if "--file" in argv:
    i = argv.index("--file")
    FILE = argv[i + 1]
    del argv[i : i + 2]
lo, hi = int(argv[0]), int(argv[1])

raw = open(FILE, "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
lines = raw.split("\n")

# 找 WorkbenchApp 的起止（顶层 `}` = 行首 `}`）
start = next(i for i, l in enumerate(lines) if l.startswith("function WorkbenchApp("))
end = next(i for i in range(start + 1, len(lines)) if lines[i] == "}")

names = set()
for i in range(start + 1, end):
    l = lines[i]
    if not l.startswith("  ") or l.startswith("   "):
        continue
    m = re.match(r"  (?:const|let)\s+([A-Za-z_$][\w$]*)\s*[:=]", l)
    if m:
        names.add(m.group(1))
        continue
    m = re.match(r"  (?:const|let)\s*\[\s*([A-Za-z_$][\w$]*)", l)
    if m:
        names.add(m.group(1))
    for d in re.findall(r"\bset[A-Z][\w$]*", l):
        names.add(d)
    m = re.match(r"  (?:async\s+)?function\s+([A-Za-z_$][\w$]*)", l)
    if m:
        names.add(m.group(1))

body = "\n".join(lines[lo - 1 : hi])
rows = []
for n in sorted(names):
    hits = [i + 1 for i, l in enumerate(lines[lo - 1 : hi], lo - 1) if re.search(r"(?<![\w$.])" + re.escape(n) + r"(?![\w$])", l)]
    if hits:
        rows.append((len(hits), n, hits[0], hits[:8]))
rows.sort(key=lambda r: (-r[0], r[1]))
print(f"{FILE}  WorkbenchApp L{start + 1}–L{end + 1}；局部名 {len(names)} 个；区间 L{lo}–L{hi} 用到 {len(rows)} 个：")
for cnt, n, first, sample in rows:
    more = "" if cnt == len(sample) else f" …"
    print(f"  {n:<28} {cnt:>3} 次  首行 L{first}  {sample}{more}")
print()
print("区间内自有的声明（新组件内部要重建的）：")
for i in range(lo - 1, hi):
    l = lines[i]
    if re.match(r"\s*(?:const|let)\s+[A-Za-z_$]", l) or re.match(r"\s*function\s+[A-Za-z_$]", l):
        print(f"  L{i + 1}: {l.strip()[:100]}")
