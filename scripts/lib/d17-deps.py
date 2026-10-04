#!/usr/bin/env python3
"""D17 依赖扫描（补 `d17-scope.py` 的漏检）：把 WorkbenchApp 里的**解构声明**也算进局部名集合。

为什么需要它：`d17-scope.py` 只认 `const X =` / `const [X` / `function X(`，于是
`const { settings, showSettings } = prefs` 这种解构出来的名字**一个都收不到** ——
而它们恰恰是"搬迁时必须以注入形式带进去"的那批（P6-2 实测：scope 漏了 settings/setSettings）。

用法：
  python scripts/lib/d17-deps.py <lo> <hi> [--file path]

输出三段：
  A. 区间用到、且**声明在区间之外**的局部名（= 必须注入的那批）
  B. 区间内自己声明的名字（= 搬过去时自带，不需要注入）
  C. 区间用到、但整个 WorkbenchApp 都没声明的名字（= 模块级 / import / 全局，需人工看一眼）
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

start = next(i for i, l in enumerate(lines) if l.startswith("function WorkbenchApp("))
end = next(i for i in range(start + 1, len(lines)) if lines[i] == "}")


def declared_names(lo_i, hi_i):
    """收出 [lo_i, hi_i) 区间里声明出来的局部名（含解构）。"""
    out = set()
    for i in range(lo_i, hi_i):
        line = lines[i]
        if not re.match(r"^  [^ ]", line):  # 只认 2 空格缩进的声明
            continue
        for m in re.finditer(r"\b(?:const|let)\s+([A-Za-z_$][\w$]*)", line):
            out.add(m.group(1))
        m = re.match(r"^  (?:const|let)\s*\[([^\]]*)\]", line)
        if m:
            for piece in m.group(1).split(","):
                name = piece.split("=")[0].strip()
                if re.match(r"^[A-Za-z_$][\w$]*$", name):
                    out.add(name)
            # 配对 setter：`const [a, setA] = ...`
            for piece in m.group(1).split(","):
                name = piece.split("=")[0].strip()
                if re.match(r"^set[A-Z][\w$]*$", name):
                    out.add(name)
        m = re.match(r"^  (?:const|let)\s*\{([^}]*)\}", line)
        if m:
            for piece in m.group(1).split(","):
                piece = piece.strip()
                if piece == "":
                    continue
                if ":" in piece:
                    piece = piece.split(":")[-1].strip()
                piece = piece.split("=")[0].strip()
                if re.match(r"^[A-Za-z_$][\w$]*$", piece):
                    out.add(piece)
        m = re.match(r"^  (?:async\s+)?function\s+([A-Za-z_$][\w$]*)", line)
        if m:
            out.add(m.group(1))
    return out


app_names = declared_names(start + 1, end)
range_names = declared_names(lo - 1, hi)

used = set()
for i in range(lo - 1, hi):
    for name in re.findall(r"[A-Za-z_$][\w$]*", lines[i]):
        used.add(name)

outside = sorted(n for n in used if n in app_names and n not in range_names)
inside = sorted(n for n in used if n in range_names)
unknown = sorted(n for n in used if n not in app_names)

print(f"{FILE}  WorkbenchApp L{start + 1}–L{end + 1}；区间 L{lo}–L{hi}")
print(f"\nA. 必须注入的（区间用到、声明在区间之外）—— {len(outside)} 个：")
print("   " + ", ".join(outside))
print(f"\nB. 区间内自带声明（搬过去时一并带走）—— {len(inside)} 个：")
print("   " + ", ".join(inside))
print(f"\nC. 整个 WorkbenchApp 都没声明（模块级 / import / 全局）—— {len(unknown)} 个：")
print("   " + ", ".join(unknown))
