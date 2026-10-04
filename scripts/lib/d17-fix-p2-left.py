import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/views/IdeasListView.tsx"
src = open(FILE, encoding="utf-8", newline="").read()
src = src.replace("\r\n", "\n").replace("\r", "\n")


def sub1(old, new, tag):
    global src
    if new in src and old not in src:
        print(f"  --  {tag}（已应用，跳过）")
        return
    n = src.count(old)
    if n != 1:
        raise SystemExit(f"ABORT [{tag}] 命中 {n} 次")
    src = src.replace(old, new, 1)
    print(f"  ok  {tag}")


# ① 抽取时多留了一层 Fragment：原文左视图外层已经有 <>…</>，抽取区间把它也带进来了
sub1("""  return (
    <>
          <>
""", """  return (
    <>
""", "l1-去重 Fragment（头）")
sub1("""          </>
    </>
  )
}""", """    </>
  )
}""", "l2-去重 Fragment（尾）")

# ② `cluster.ideas` 被单词级替换误伤成 `cluster.model.ideas`
n = src.count("cluster.model.ideas")
if n == 0:
    print("  --  cluster.model.ideas（已清）")
else:
    src = src.replace("cluster.model.ideas", "cluster.ideas")
    print(f"  ok  cluster.model.ideas ×{n}")

# ③ `ideas.map` 漏了（原文这里是裸 `ideas`，抽样替换清单里只写了 `ideas.length`）
sub1(": ideas.map((idea) => idea.id)", ": model.ideas.map((idea) => idea.id)", "l3")

if "model.model" in src or "cluster.model" in src:
    raise SystemExit("ABORT 仍有 model.model / cluster.model")
if "\n    <>\n" not in src:
    raise SystemExit("ABORT Fragment 结构不对")

open(FILE, "w", encoding="utf-8", newline="\n").write(src)
print(f"lines -> {src.count(chr(10)) + 1}")
