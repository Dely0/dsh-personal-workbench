import io
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

head = subprocess.run(["git", "show", "HEAD:src/client/index.tsx"], capture_output=True).stdout.decode("utf-8")
cur = open("src/client/index.tsx", "rb").read().decode("utf-8")
hl = head.replace("\r\n", "\n").replace("\r", "\n").split("\n")
cl = cur.replace("\r\n", "\n").replace("\r", "\n").split("\n")
print(f"HEAD {len(hl)} 行 → 现在 {len(cl)} 行")

import difflib

sm = difflib.SequenceMatcher(None, hl, cl, autojunk=False)
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == "equal":
        continue
    print(f"--- {tag} HEAD[{i1+1}:{i2}] -> NOW[{j1+1}:{j2}]  (删 {i2-i1} 行) ---")
    for k in range(i1, min(i2, i1 + 14)):
        print(f"  - {k+1:5} {hl[k][:140]}")
    if i2 - i1 > 14:
        print(f"  - ...（共 {i2-i1} 行）")
        for k in range(max(i1, i2 - 6), i2):
            print(f"  - {k+1:5} {hl[k][:140]}")
    for k in range(j1, min(j2, j1 + 8)):
        print(f"  + {k+1:5} {cl[k][:140]}")
    if j2 - j1 > 8:
        print(f"  + ...（共 {j2-j1} 行）")
