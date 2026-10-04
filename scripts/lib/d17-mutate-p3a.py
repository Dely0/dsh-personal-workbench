#!/usr/bin/env python3
"""D17 P3-1 反向验证：给新落地的列表域实现注入缺陷，确认判据会**真的变红**。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
缺陷分布在 hook 与视图两个文件，所以每条变异自带文件路径（与 `d17-mutate-p2.py` 同构）。

为什么是这四条：P3-1 把「归档副作用写在更新函数里就会重复发请求」「视图只许展示」这两条
原本靠约定维持的规矩变成了会失败的断言 —— 本脚本保证"再写错一次立刻红"。

用法：python scripts/lib/d17-mutate-p3a.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HOOK = "src/client/hooks/useTaskListModel.ts"
VIEW = "src/client/views/TaskListView.tsx"
BACKUP = os.path.join(os.environ["TEMP"], "d17-p3a-mutate.bak")

MUTATIONS = [
    (
        "M-P3A-1 清空筛选改回内联字面量（放弃共享的 EMPTY_TASK_FILTER）",
        HOOK,
        "const clearFilter = useCallback((): void => { setFilter(EMPTY_TASK_FILTER) }, [])",
        "const clearFilter = useCallback((): void => { setFilter({ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] }) }, [])",
        ["test/listViewWiring.test.mjs"],
    ),
    (
        "M-P3A-2 归档切换把 api 调用塞进 setState 更新函数（重调更新函数就重复发请求）",
        HOOK,
        "    const next = !archivedMode\n"
        "    setArchivedMode(next)\n"
        "    if (next) {\n"
        "      void api<{ tasks: Task[] }>('/api/workbench/tasks?archived=true')\n"
        "        .then((r) => setArchivedTasks(r.tasks))\n"
        "        .catch(() => undefined)\n"
        "    }\n"
        "  }, [archivedMode])",
        "    setArchivedMode((prev) => {\n"
        "      const next = !prev\n"
        "      if (next) {\n"
        "        void api<{ tasks: Task[] }>('/api/workbench/tasks?archived=true')\n"
        "          .then((r) => setArchivedTasks(r.tasks))\n"
        "          .catch(() => undefined)\n"
        "      }\n"
        "      return next\n"
        "    })\n"
        "  }, [])",
        ["test/listViewWiring.test.mjs"],
    ),
    (
        "M-P3A-3 视图自己存一份 state（展示组件不再是无状态）",
        VIEW,
        "}: TaskListViewProps): JSX.Element {\n  return (",
        "}: TaskListViewProps): JSX.Element {\n  const [openFilter, setOpenFilter] = useState<string | null>(null)\n  return (",
        ["test/listViewWiring.test.mjs"],
    ),
    (
        "M-P3A-4 视图自己发请求（HTTP 不再只落在 hook 里）",
        VIEW,
        "onClick={() => model.actions.toggleArchived()}",
        "onClick={() => { void api('/api/workbench/tasks?archived=true'); model.actions.toggleArchived() }}",
        ["test/listViewWiring.test.mjs"],
    ),
]


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def read(path):
    return open(path, encoding="utf-8", newline="").read()


def write(path, text):
    # 保留原文件的换行风格（本仓库源码是 LF；写成 CRLF 会让 diff 与 sha256 都对不上）
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
