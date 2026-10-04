import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

raw = open("src/client/index.tsx", "rb").read().decode("utf-8")
print("CRLF count:", raw.count("\r\n"), "lone CR:", raw.count("\r") - raw.count("\r\n"))
lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
l = lines[3402]
print("repr:", repr(l[16:]))
print("backslash count:", l.count("\\"))
needle_plain = "setFolderForm({ mode: 'rename', id: selectedCluster.id, title: selectedCluster.title, summaryMd: selectedCluster.summaryMd })}"
needle_esc = "setFolderForm({ mode: \\'rename\\', id: selectedCluster.id, title: selectedCluster.title, summaryMd: selectedCluster.summaryMd })}"
print("plain in line:", needle_plain in l)
print("escaped in line:", needle_esc in l)
