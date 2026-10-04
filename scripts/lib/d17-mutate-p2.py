#!/usr/bin/env python3
"""D17 P2 反向验证：给新落地的点子域实现注入缺陷，确认判据会**真的变红**。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
与 `d17-mutate-p1.py` 的区别：本批的缺陷分布在两个文件（hook + 视图），所以每条变异自带文件路径。

为什么这三条：P2 第一版就把①页签"只清另一个"、②两个"点开"动作的差异写错了（合并成一个），
是**与 HEAD 逐条语义对照**才发现的 —— 本脚本保证"再写错一次立刻红"。

用法：python scripts/lib/d17-mutate-p2.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HOOK = "src/client/hooks/useIdeas.ts"
VIEW = "src/client/views/IdeasListView.tsx"
BACKUP = os.path.join(os.environ["TEMP"], "d17-p2-mutate.bak")

MUTATIONS = [
    (
        "M-P2-1 页签切换改成「两份都清」（拆分前是「只清另一个」）",
        HOOK,
        "    if (next === 'clusters') setSelectedIdea(null)\n"
        "    else setSelectedCluster(null)\n"
        "    setTabState(next)",
        "    setSelectedIdea(null); setSelectedCluster(null)\n"
        "    setTabState(next)",
        ["test/listViewWiring.test.mjs"],
    ),
    (
        "M-P2-2 两个「点开点子」动作合并回一个（先清点子王再 find ?? prev）",
        HOOK,
        "  const openIdeaById = useCallback((id: string): void => {\n"
        "    const idea = ideas.find((item) => item.id === id)\n"
        "    if (idea === undefined) return\n"
        "    setSelectedCluster(null); setSelectedIdea(idea)\n"
        "  }, [ideas])",
        "  const openIdeaById = useCallback((id: string): void => {\n"
        "    setSelectedCluster(null)\n"
        "    setSelectedIdea((prev) => ideas.find((item) => item.id === id) ?? prev)\n"
        "  }, [ideas])",
        ["test/listViewWiring.test.mjs"],
    ),
    (
        "M-P2-3 视图自己再清一次选择（重新引入拆分前不存在的「清两份」）",
        VIEW,
        "onClick={() => model.setTab('ideas')}",
        "onClick={() => { model.setTab('ideas'); model.actions.clearSelection() }}",
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


targets = sorted({f for _, f, _, _, _ in MUTATIONS})
before = {p: sha(p) for p in targets}
for p, h in before.items():
    shutil.copyfile(p, BACKUP + "." + os.path.basename(p))
    print(f"基线 {p} sha256 {h}")

green = 0
try:
    for name, target, old, new, files in MUTATIONS:
        src = open(target, encoding="utf-8", newline="").read().replace("\r\n", "\n")
        if src.count(old) != 1:
            raise SystemExit(f"ABORT [{name}] 锚点命中 {src.count(old)} 次")
        open(target, "w", encoding="utf-8", newline="").write(src.replace(old, new, 1).replace("\n", "\r\n"))
        code, total, fails = run_tests(files)
        print(f"\n== {name} ==")
        print(f"   exit={code} tests={total}")
        for f in fails[:4]:
            print(f"   红: {f[:110]}")
        if code == 0:
            green += 1
            print("   ❌ 变异后仍然是绿的 —— 这就是判据盲点")
        shutil.copyfile(BACKUP + "." + os.path.basename(target), target)
finally:
    for p in targets:
        shutil.copyfile(BACKUP + "." + os.path.basename(p), p)

after = {p: sha(p) for p in targets}
print()
for p in targets:
    print(f"还原后 {p} sha256 {after[p]}  一致={after[p] == before[p]}")
assert all(after[p] == before[p] for p in targets), "还原失败，必须手工恢复"
print(f"\n结果：{len(MUTATIONS) - green}/{len(MUTATIONS)} 条变异被断言发现")
sys.exit(1 if green else 0)
