#!/usr/bin/env python3
"""D17 P1 反向验证：给新落地的知识域实现注入缺陷，确认判据会**真的变红**。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
本脚本只做"注入 + 跑测试 + 还原"，不删任何断言。

用法：python scripts/lib/d17-mutate-p1.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HOOK = "src/client/hooks/useKnowledge.ts"
BACKUP = os.path.join(os.environ["TEMP"], "useKnowledge.p1.bak")

MUTATIONS = [
    (
        "M-P1-1 知识列表不再经 listPresentation 的统一适配（组件自己过滤/排序）",
        "items: entries.map(toContentItem),",
        "items: entries,",
        ["test/listViewWiring.test.mjs"],
    ),
    (
        "M-P1-2 分类对账不经判空直接落盘（对账函数返回 null 时把筛选冲掉）",
        "    const fixed = reconcileKnowledgeKinds(filters, dicts.map((d) => d.code))\n"
        "    if (fixed !== null) setFilters(fixed)",
        "    const fixed = reconcileKnowledgeKinds(filters, dicts.map((d) => d.code))\n"
        "    if (fixed !== null) setFilters(fixed)\n"
        "    setFilters({ ...(fixed ?? filters), page: 0 })",
        ["test/listViewWiring.test.mjs"],
    ),
]


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def run_tests(files):
    proc = subprocess.run(["node", "--test", *files], capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (proc.stdout or "") + (proc.stderr or "")
    fails = [l.strip() for l in out.splitlines() if l.strip().startswith("✖")]
    total = None
    for line in out.splitlines():
        if line.startswith("ℹ tests "):
            total = line.split()[-1]
    return proc.returncode, total, fails


shutil.copyfile(HOOK, BACKUP)
before = sha(HOOK)
print(f"基线 sha256 {before}")

try:
    for name, old, new, files in MUTATIONS:
        src = open(HOOK, encoding="utf-8", newline="").read().replace("\r\n", "\n")
        if src.count(old) != 1:
            raise SystemExit(f"ABORT [{name}] 锚点命中 {src.count(old)} 次")
        open(HOOK, "w", encoding="utf-8", newline="").write(src.replace(old, new, 1).replace("\n", "\r\n"))
        code, total, fails = run_tests(files)
        print(f"\n== {name} ==")
        print(f"   exit={code} tests={total}")
        for f in fails[:4]:
            print(f"   红: {f[:100]}")
        if code == 0:
            print("   ❌ 变异后仍然是绿的 —— 这就是判据盲点")
        shutil.copyfile(BACKUP, HOOK)
finally:
    shutil.copyfile(BACKUP, HOOK)

after = sha(HOOK)
print(f"\n还原后 sha256 {after}  一致={after == before}")
assert after == before, "还原失败，必须手工恢复"
