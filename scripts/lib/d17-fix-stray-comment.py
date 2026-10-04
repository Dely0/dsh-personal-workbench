import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, "rb").read().decode("utf-8")
src = src.replace("\r\n", "\n").replace("\r", "\n")

OLD = "  /**\n\n\n  const now = new Date()\n"
if OLD not in src:
    n = src.count("  /**\n\n\n")
    raise SystemExit(f"ABORT 锚点未命中（'  /**\\n\\n\\n' 出现 {n} 次）")

src = src.replace(OLD, "  const now = new Date()\n", 1)
open(FILE, "w", encoding="utf-8", newline="\n").write(src)
print("  ok  删掉孤立的未闭合 /** （它会注释掉后面 40 行）")
print(f"lines -> {src.count(chr(10)) + 1}")
