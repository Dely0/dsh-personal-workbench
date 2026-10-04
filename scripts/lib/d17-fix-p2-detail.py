import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/views/IdeasDetailPane.tsx"
src = open(FILE, encoding="utf-8", newline="").read()
src = src.replace("\r\n", "\n").replace("\r", "\n")

n = src.count("ideaClusters")
if n == 0:
    print("  --  ideaClusters（已清）")
else:
    src = src.replace("ideaClusters", "model.clusters")
    print(f"  ok  ideaClusters → model.clusters ×{n}")

if "ideaClusters" in src:
    raise SystemExit("ABORT 仍有 ideaClusters")

open(FILE, "w", encoding="utf-8", newline="\n").write(src)
print(f"lines -> {src.count(chr(10)) + 1}")
