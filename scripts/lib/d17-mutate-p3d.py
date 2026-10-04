#!/usr/bin/env python3
"""D17 P3-4 反向验证：给刚迁移的任务数据域实现注入缺陷，确认判据会**真的变红**。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
缺陷分布在两个文件（入口 / 新 hook），所以每条变异自带目标路径（与 `d17-mutate-p3c.py` 同构）。

本批的判据面同时落在 node 测试与 python 出口自检里，所以 `run_checks` 同时支持
`node --test <file>.mjs` 与 `python <file>.py` 两类目标。

为什么这八条：
- M-P3D-1 盯**本批最贵的红线**：`loadTaskDetail` 只加载、不许导航（2026-10-01 那个"改进度被
  弹回任务列表"的 BUG 就是它带上了 `setView('list')`）；
- M-P3D-2 盯设计 §4.1 第 149 行"`refresh` 不能拆成多个独立重复请求"（拆掉待验收那一段）；
- M-P3D-3 盯"5 项 state 只有一个 owner"（`selected` 收回去自己 useState 是最容易漏搬的一半）；
- M-P3D-4 盯设计 §5 的跨域注入：hook 里退化回裸 `setError` 就不再是"装配层注入反馈"；
- M-P3D-5 盯装配层原语 **不许收窄**（`Dispatch<SetStateAction<Task[]>>` → `(tasks: Task[]) => void`
  会丢并发更新，是**运行时**退化，typecheck 只报调用点、不报语义）；
- M-P3D-6 反向验证本批**新加的反向判据**（入口 `openTaskById` 必须有 `setView('list')`）；
- M-P3D-7 盯"两连写"（`selected` 与它的镜像 `selectedRef` 必须一起清，漏一半会让下次 refresh
  去拉一条已不存在的详情）；
- M-P3D-8 盯设计 §4.2 第 166/167 行的反例：完成任务后刷新详情**不许**走会导航的 `openTaskById`。

用法：python scripts/lib/d17-mutate-p3d.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = "src/client/index.tsx"
HOOK = "src/client/hooks/useTaskData.ts"
BACKUP = os.path.join(os.environ["TEMP"], "d17-p3d-mutate.bak")

EXIT_CHECK = "scripts/lib/d17-p3d-exit-check.py"
PROGRESS_TEST = "test/progressWiring.test.mjs"

MUTATIONS = [
    (
        "M-P3D-1 loadTaskDetail 带上导航（红线：加载不许 setView）",
        HOOK,
        "  const loadTaskDetail = (taskId: string): void => {\n    selectedRef.current = taskId",
        "  const loadTaskDetail = (taskId: string): void => {\n    setView('list')\n    selectedRef.current = taskId",
        [EXIT_CHECK],
    ),
    (
        "M-P3D-2 refresh 少拉一端点（设计 §4.1 第 149 行：不能拆散）",
        HOOK,
        "      api<PendingCompletionsResponse>('/api/workbench/tasks/pending-completions').then((res) => res.pending).catch(() => null),",
        "      api<{ pending: null }>('/api/workbench/tasks').then((res) => res.pending).catch(() => null),",
        [EXIT_CHECK, PROGRESS_TEST],
    ),
    (
        "M-P3D-3 入口把 selected 收回去自己 useState（同一状态两个 owner）",
        INDEX,
        "  const { bootstrap, tasks, selected, dicts, dictOf, pendingMap, childrenOf } = data",
        "  const { bootstrap, tasks, dicts, dictOf, pendingMap, childrenOf } = data\n  const [selected, setSelected] = useState<TaskDetail | null>(null)",
        [EXIT_CHECK],
    ),
    (
        "M-P3D-4 hook 丢掉注入回调、退化回裸 setError（设计 §5：跨域靠注入）",
        HOOK,
        "]).then(([detail, ev, rv]) => setSelected({ ...detail, events: ev.events, reviews: rv.reviews })).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))",
        ".catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))",
        [EXIT_CHECK],
    ),
    (
        "M-P3D-5 装配层原语收窄 setTasks（丢并发更新）",
        HOOK,
        "    setTasks: Dispatch<SetStateAction<Task[]>>",
        "    setTasks: (tasks: Task[]) => void",
        [EXIT_CHECK],
    ),
    (
        "M-P3D-6 入口 openTaskById 不再切 list（导航留在装配层的反向验证）",
        INDEX,
        "  const openTaskById = (taskId: string): void => {\n    setView('list')\n    resetDetailView()",
        "  const openTaskById = (taskId: string): void => {\n    resetDetailView()",
        [EXIT_CHECK, PROGRESS_TEST],
    ),
    (
        "M-P3D-7 clearSelectedTask 只清 state 不清镜像 ref（两连写漏一半）",
        HOOK,
        "  const clearSelectedTask = useCallback((): void => {\n    setSelected(null)\n    selectedRef.current = null\n  }, [])",
        "  const clearSelectedTask = useCallback((): void => {\n    setSelected(null)\n  }, [])",
        [EXIT_CHECK],
    ),
    (
        "M-P3D-8 完成任务后走会导航的 openTaskById（设计 §4.2 第 166/167 行反例）",
        HOOK,
        "    /** 同上：完成任务后只刷新详情，不把用户从当前页面弹走。 */\n    if (selectedRef.current === taskId) loadTaskDetail(taskId)",
        "    /** 同上：完成任务后只刷新详情，不把用户从当前页面弹走。 */\n    if (selectedRef.current === taskId) openTaskById(taskId)",
        [EXIT_CHECK, PROGRESS_TEST],
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


def run_checks(files):
    """跑一批判据目标；`.mjs` 走 node --test，`.py` 走 python。返回 (退出码, 红行清单)。"""
    codes = []
    fails = []
    for f in files:
        if f.endswith(".py"):
            proc = subprocess.run([sys.executable, f], capture_output=True, text=True,
                                  encoding="utf-8", errors="replace")
        else:
            proc = subprocess.run(["node", "--test", f], capture_output=True, text=True,
                                  encoding="utf-8", errors="replace")
        codes.append(proc.returncode)
        out = (proc.stdout or "") + (proc.stderr or "")
        fails += [l.strip() for l in out.splitlines() if l.strip().startswith("✖")]
    return codes, fails


targets = sorted({t for _, t, _, _, _ in MUTATIONS})
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
        codes, fails = run_checks(files)
        print(f"\n== {name} ==")
        print(f"   exit={codes} 目标={files}")
        for f in fails[:4]:
            print(f"   红: {f[:110]}")
        if all(c == 0 for c in codes):
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

# 还原后再跑一次基线，确认是全绿的（否则"全红"可能是判据自己坏了）
codes, _ = run_checks([EXIT_CHECK, PROGRESS_TEST])
print(f"\n还原后基线：exit={codes}（应全为 0）")
assert all(c == 0 for c in codes), "还原后基线不是绿的"

print(f"\n结果：{len(MUTATIONS) - green}/{len(MUTATIONS)} 条变异被断言发现")
sys.exit(1 if green else 0)
