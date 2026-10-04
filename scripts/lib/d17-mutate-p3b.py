#!/usr/bin/env python3
"""D17 P3-2 反向验证：给刚落地/刚迁移的详情域实现注入缺陷，确认判据会**真的变红**。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
缺陷分布在三个文件（入口 / 视图 / hook），所以每条变异自带文件路径（与 `d17-mutate-p2.py` 同构）。

为什么这六条：
- M-P3B-1/2 盯设计 §3 的硬规矩"`views/` 不发 HTTP、不持有 state"（P3-2 刚从面板里提出两处 `void api(...)`）；
- M-P3B-3 盯 §0 去重（三个语义动作只有一份实现）；
- M-P3B-4 盯"两份匿名类型收进 contracts";
- M-P3B-5/6 反向验证本批**改指新 owner** 的两条既有判据（`progressWiring` 的详情装配、`capacityWiring` 的编辑框初值）
  —— 这两条如果只在入口查，搬家后会空洞通过。

用法：python scripts/lib/d17-mutate-p3b.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = "src/client/index.tsx"
PANE = "src/client/views/TaskDetailPane.tsx"
HOOK = "src/client/hooks/useTaskDetailModel.ts"
# D17/P6-1 后，视图联合类型的 useState 归**导航域**（M-P3B-4 的变异靶点跟着搬）。
NAV_HOOK = "src/client/hooks/useWorkbenchNavigation.ts"
BACKUP = os.path.join(os.environ["TEMP"], "d17-p3b-mutate.bak")

DETAIL_TESTS = ["test/taskDetailWiring.test.mjs"]

MUTATIONS = [
    (
        "M-P3B-1 视图重新内联 api 请求（设计 §3：views/ 不许发 HTTP）",
        PANE,
        "onClick={() => onRestoreTask(selected.task.id)}",
        "onClick={() => { void api('/api/workbench/tasks/x/restore', { method: 'POST' }); onRestoreTask(selected.task.id) }}",
        DETAIL_TESTS,
    ),
    (
        "M-P3B-2 视图自己存一份 state（展示组件不再无状态）",
        PANE,
        "}: TaskDetailPaneProps): JSX.Element {\n  const {",
        "}: TaskDetailPaneProps): JSX.Element {\n  const [hover, setHover] = useState(false)\n  const {",
        DETAIL_TESTS,
    ),
    (
        "M-P3B-3 resetDetailView 的两行合成一行（顺序与写法不再逐字一致）",
        HOOK,
        "    setDetailTab('desc')\n    setEventsExpanded(false)\n  }, [])",
        "    setDetailTab('desc'); setEventsExpanded(false)\n  }, [])",
        DETAIL_TESTS,
    ),
    (
        "M-P3B-4 导航域把视图联合类型改回内联（两份类型定义，D17/P6-1 后靶点在 hook）",
        NAV_HOOK,
        "  const [view, setView] = useState<WorkbenchView>('today')",
        "useState<'today' | 'calendar' | 'list' | 'knowledge' | 'ideas'>('today')",
        DETAIL_TESTS,
    ),
    (
        "M-P3B-5 详情卡不再装配共用的 TaskProgress（既有判据改指新 owner 的反向验证）",
        PANE,
        "  <TaskProgress\n    view={taskProgressView({",
        "  <div className=\"wb-x\"\n    data-view={taskProgressView({",
        ["test/progressWiring.test.mjs"],
    ),
    (
        "M-P3B-6 编辑框初值写死空串（打开编辑框看不见库里真实耗时）",
        PANE,
        "estimatedMinutes: selected.task.estimatedMinutes === null ? '' : String(selected.task.estimatedMinutes)",
        "estimatedMinutes: ''",
        ["test/capacityWiring.test.mjs"],
    ),
]


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def read(path):
    return open(path, encoding="utf-8", newline="").read()


def write(path, text):
    # 保留原文件换行风格（本仓库源码是 LF；写成 CRLF 会让 sha256 对不上）
    style = "\r\n" if "\r\n" in read(path) else "\n"
    if style == "\r\n":
        text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    open(path, "w", encoding="utf-8", newline="").write(text)


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
        src = read(target).replace("\r\n", "\n")
        if src.count(old) != 1:
            raise SystemExit(f"ABORT [{name}] 锚点命中 {src.count(old)} 次")
        write(target, src.replace(old, new, 1))
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
