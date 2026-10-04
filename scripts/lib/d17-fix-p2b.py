import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")

OLD = "knowledge.bumpRefreshKey(); ideas.refresh(); void refresh() }}"
NEW = "knowledge.bumpRefreshKey(); ideas.actions.refresh(); void refresh() }}"

if NEW in src and OLD not in src:
    print("  --  已应用，跳过")
elif src.count(OLD) == 1:
    src = src.replace(OLD, NEW, 1)
    open(FILE, "w", encoding="utf-8", newline="\n").write(src)
    print("  ok  ideas.actions.refresh()（refresh 在 actions 命名空间下）")
else:
    raise SystemExit(f"ABORT 命中 {src.count(OLD)} 次")
