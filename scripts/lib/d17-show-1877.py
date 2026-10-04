import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

lines = open("src/client/index.tsx", "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").split("\n")
for i in range(1866, 1892):
    print(f"{i+1:5} {lines[i]!r}")
