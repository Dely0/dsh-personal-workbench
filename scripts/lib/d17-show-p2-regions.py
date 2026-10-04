import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

raw = open("src/client/index.tsx", "rb").read().decode("utf-8")
lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
print("total lines:", len(lines))

REGIONS = [
    ("ideas state 426..439", 426, 439),
    ("loadIdeas 599..612", 599, 612),
    ("cardItems 1889..1895", 1889, 1895),
    ("unfiled..merge 2000..2090", 2000, 2090),
    ("folderForm modal 2776..2810", 2776, 2810),
    ("left view 3207..3302", 3207, 3302),
    ("detail 3378..3456", 3378, 3456),
    ("useKnowledge 588..597", 588, 597),
    ("startAISessionRef 1494..1498", 1494, 1498),
]
for name, lo, hi in REGIONS:
    print(f"--- {name} ---")
    for i in range(lo - 1, min(hi, len(lines))):
        print(f"{i+1:5} {lines[i]}")
