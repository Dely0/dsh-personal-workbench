import io
import re
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

head = subprocess.run(["git", "show", "HEAD:src/client/index.tsx"], capture_output=True).stdout.decode("utf-8")
cur = open("src/client/index.tsx", "rb").read().decode("utf-8")

for name, text in (("HEAD", head), ("NOW", cur)):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    print(f"===== {name}（{len(lines)} 行）=====")
    for pat in (r"const now\b", r"const todayPlan\b", r"const todayStart\b", r"const \[picked", r"todayAnchor"):
        hits = [(i + 1, l.strip()[:110]) for i, l in enumerate(lines) if re.search(pat, l)]
        print(f"  {pat:24} {hits[:6]}")
