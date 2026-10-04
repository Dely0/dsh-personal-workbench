"""D17/P7-3 只读工具：列出入口 `src/client/index.tsx` 里「import 了但文件里没用」的名字。

判定：把 import 区（文件开头连续以 `import` 开头的语句块，含多行 `{ ... }` 形式）里绑定的
每个名字，在整个文件**除 import 区之外**的文本里做裸名匹配（不算 `a.name` 与对象键）。
只报告，不改文件。
"""
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join("src", "client", "index.tsx")
src = open(PATH, encoding="utf-8", newline="").read().replace("\r\n", "\n")
lines = src.split("\n")

# -------- 找 import 区的边界
start = None
end = 0
for i, ln in enumerate(lines):
    if ln.startswith("import "):
        start = i if start is None else start
        end = i
    elif start is not None and ln.strip() == "":
        continue
    elif start is not None:
        break
if start is None:
    print("没有 import 区")
    sys.exit(0)

block = "\n".join(lines[start:end + 1])
rest = "\n".join(lines[:start] + lines[end + 1:])

# -------- 抽取绑定名
names = []
for m in re.finditer(r"import\s+(?:type\s+)?\{([^}]*)\}", block, re.S):
    for part in m.group(1).split(","):
        part = part.strip()
        if not part or part.startswith("type "):
            part = part[5:].strip() if part.startswith("type ") else part
        if not part:
            continue
        name = part.split(" as ")[-1].strip() if " as " in part else part
        names.append(name)
# 默认导入 / 命名空间导入
for m in re.finditer(r"^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)", block, re.M):
    names.append(m.group(1))

unused = []
for name in sorted(set(names)):
    hits = len(re.findall(r"(?<![\w.$])" + re.escape(name) + r"\b(?!\s*:)", rest))
    if hits == 0:
        unused.append(name)

print(f"import 区 {start + 1}-{end + 1} 行，绑定名 {len(set(names))} 个")
print(f"未使用（{len(unused)} 个）：")
for name in unused:
    decl = next((l.strip() for l in block.split("\n") if re.search(r"(?<![\w$])" + re.escape(name) + r"\b", l)), "")
    print(f"  - {name}\n      {decl[:130]}")
