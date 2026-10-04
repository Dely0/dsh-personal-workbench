import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

lines = open("src/client/index.tsx", "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").split("\n")

depth = 0
opens = []
for i, l in enumerate(lines[:1960], start=1):
    j = 0
    while j < len(l):
        if l.startswith("/*", j):
            opens.append(i)
            depth += 1
            j += 2
            continue
        if l.startswith("*/", j):
            if depth > 0:
                opens.pop()
            depth -= 1
            j += 2
            continue
        if depth == 0 and l.startswith("//", j):
            break
        j += 1
print("1960 行以内结束时的注释深度:", depth, "未闭合的 /*: ", opens[-5:])

raw = open("src/client/index.tsx", "rb").read().decode("utf-8")
print("全文件 /* 数:", raw.count("/*"), " */ 数:", raw.count("*/"))
