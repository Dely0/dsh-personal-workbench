#!/usr/bin/env python3
"""D17 P2：删掉入口里那段已经搬走的派生注释。

这段注释描述的是 `unfiledIdeas` / `ideasOfFolder` 的派生，两个量已经随 P2 搬进
`hooks/useIdeas.ts`（且 hook 里已经有各自的注释），留在入口只会指向不存在的代码。
**不是"为了降行数删注释"** —— 它描述的主语已经不在这里了。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")

OLD = (
    "\n"
    "  /**\n"
    "   * 点子页的文件夹派生数据：\n"
    "   * - unfiledIdeas：没有被任何文件夹引用的点子（「未归类」区）\n"
    "   * - ideasOfFolder：按文件夹聚合的成员（同一数据在卡片里只显示前 2 条缩略）\n"
    "   * 数据层无需变更：idea_clusters = 文件夹，idea_links 已支持多对多。\n"
    "   */\n"
)

if "ideasOfFolder" not in src and OLD not in src:
    print("  --  已应用，跳过")
    sys.exit(0)

n = src.count(OLD)
if n != 1:
    raise SystemExit(f"ABORT 命中 {n} 次")

src = src.replace(OLD, "", 1)
open(FILE, "w", encoding="utf-8", newline="\n").write(src)
print("  ok  删除已搬走的 unfiledIdeas/ideasOfFolder 派生注释（hook 内已有各自的注释）")
print(f"lines -> {src.count(chr(10)) + 1}")
