#!/usr/bin/env python3
"""D17 P4 反向验证：给刚迁移的日期域实现注入缺陷，确认判据会**真的变红**。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
缺陷分布在四个文件（入口 / 日期域 hook / 两个视图），所以每条变异自带目标路径
（与 `d17-mutate-p3c.py` / `d17-mutate-p3d.py` 同构）。

判据面同时落在 node 测试与 python 出口自检里，所以 `run_checks` 同时支持
`node --test <file>.mjs` 与 `python <file>.py` 两类目标。

为什么这十一条：
- M-P4-1 盯"17 项 state 只有一个 owner"（`dayTab` 收回去自己 useState 是最容易漏搬的一半，
  而且它会悄悄让入口的页签与 `dayPanel` 的页签脱钩）；
- M-P4-2 盯**探针 I1 的新锚点**（容量 memo 必须是日键 `capacityTodayKey(now)`，塞 `now` 对象
  等于每帧失效 —— 探针与 `test/capacityWiring.test.mjs` 两条判据都锚这一行）；
- M-P4-3 盯本批**唯一一处依赖改名**（今日计划会话 effect 从 `bootstrap` 改成 `todayPlan`：
  退回 `bootstrap` 会让任意 bootstrap 变化都重拉一次会话，是真实的性能退化）；
- M-P4-4 盯**跨域组合动作不许进 hook**（`collapseAll` 要同时收列表域与日期域两棵树，
  拆掉一半就是"点了收起、树还在"）；
- M-P4-5 / M-P4-6 盯模式 5：视图**只注入 props**（自己发包 → 写路径多一条；自持 state → 视图不再是纯视图）；
- M-P4-7 盯设计 §5 的跨域注入：hook 里退化回裸 `setError` 就不再是"装配层注入反馈"；
- M-P4-8 盯"装配层里出现的 `api(...)` 必须提成 hook 动作"（本批新立的模式 5 第 5 条）；
- M-P4-9 盯设置域与日期域的**读取边界**（`saveDailyCapacity` 写的是 settings，但读的是日期域的
  行内编辑态 —— 退回本地名就是两处各持一份"正在编辑的值"）；
- M-P4-10 盯"唯一写入口"（入口重新定义 `addTaskToPlan` 会让同一动作有两份实现）；
- M-P4-11 盯**空洞通过**（子代理 §7 指出的机制：负向断言在搬家后天然为真；
  真正守住的是跟着 owner 走的正向断言 —— 这条变异专门打入口侧的反向判据）。

用法：python scripts/lib/d17-mutate-p4.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = "src/client/index.tsx"
HOOK = "src/client/hooks/useDayWorkspace.ts"
TODAY_PANE = "src/client/views/TodayPane.tsx"
CALENDAR_VIEW = "src/client/views/CalendarView.tsx"
BACKUP = os.path.join(os.environ["TEMP"], "d17-p4-mutate.bak")

EXIT_CHECK = "scripts/lib/d17-p4-exit-check.py"
DAY_PANEL_TEST = "test/dayPanelWiring.test.mjs"
CAPACITY_TEST = "test/capacityWiring.test.mjs"

MUTATIONS = [
    (
        "M-P4-1 入口把 dayTab 收回去自己 useState（同一状态两个 owner）",
        INDEX,
        "  const { addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, setDayTab, setReportSubTab } = day.actions\n",
        "  const { addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, setDayTab, setReportSubTab } = day.actions\n  const [dayTab, setDayTab] = useState<DayTab>('plan')\n",
        [EXIT_CHECK],
    ),
    (
        "M-P4-2 容量 memo 依赖塞回 now 对象（探针 I1 / AX-C06 新锚点）",
        HOOK,
        "    [tasks, archivedTasks, todayPlan, dailyCapacityMinutes, defaultEstimateMinutes, "
        "dailyCapacityIncludeOverdue, capacityTodayKey(now)],",
        "    [tasks, archivedTasks, todayPlan, dailyCapacityMinutes, defaultEstimateMinutes, "
        "dailyCapacityIncludeOverdue, now],",
        [EXIT_CHECK, CAPACITY_TEST],
    ),
    (
        "M-P4-3 今日计划会话 effect 依赖退回 bootstrap（本批唯一依赖改名）",
        HOOK,
        "  }, [todayAnchor, todayPlan])",
        "  }, [todayAnchor, bootstrap])",
        [EXIT_CHECK],
    ),
    (
        "M-P4-4 collapseAll 丢掉列表域那一半（跨域组合动作被拆散）",
        INDEX,
        "const collapseAll = (): void => { taskList.actions.clearExpanded(); day.actions.collapseExpanded() }",
        "const collapseAll = (): void => { day.actions.collapseExpanded() }",
        [EXIT_CHECK],
    ),
    (
        "M-P4-5 TodayPane 自己发包（模式 5：视图只注入回调）",
        TODAY_PANE,
        "export function TodayPane(props: TodayPaneProps): JSX.Element {\n  const {",
        "export function TodayPane(props: TodayPaneProps): JSX.Element {\n"
        "  void api(`/api/workbench/plans/x/items`, { method: 'POST' })\n  const {",
        [EXIT_CHECK],
    ),
    (
        "M-P4-6 CalendarView 自持 state（视图必须是纯 props）",
        CALENDAR_VIEW,
        "export function CalendarView(props: CalendarViewProps): JSX.Element {",
        "export function CalendarView(props: CalendarViewProps): JSX.Element {\n"
        "  const [hover, setHover] = useState<string | null>(null)",
        [EXIT_CHECK],
    ),
    (
        "M-P4-7 hook 丢掉注入回调、退化回裸 setError（设计 §5：跨域靠注入）",
        HOOK,
        "      onError(e instanceof Error ? e.message : String(e))\n    } finally {\n      setAddingPlanTaskId(null)",
        "      setError(e instanceof Error ? e.message : String(e))\n    } finally {\n      setAddingPlanTaskId(null)",
        [EXIT_CHECK],
    ),
    (
        "M-P4-8 dayPanelProps 的 onClearPlan 退回内联 api（内联请求没提成动作）",
        INDEX,
        "    onClearPlan: () => void clearPlan(dayPanel.day),",
        "    onClearPlan: () => { void api(`/api/workbench/plans/${dayPanel.day}`, { method: 'DELETE' }) },",
        [EXIT_CHECK],
    ),
    (
        "M-P4-9 saveDailyCapacity 不再读日期域的行内编辑态（跨域读回本地名）",
        INDEX,
        "const raw = day.capacityEdit === null ? '' : day.capacityEdit.trim()",
        "const raw = capacityEdit === null ? '' : capacityEdit.trim()",
        [EXIT_CHECK],
    ),
    (
        "M-P4-10 入口重新自己定义 addTaskToPlan（唯一写入口被复制一份）",
        INDEX,
        "  const { addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, setDayTab, setReportSubTab } = day.actions\n",
        "  const { addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, setDayTab, setReportSubTab } = day.actions\n  const addTaskToPlan = async (taskId: string): Promise<void> => { void taskId }\n",
        [EXIT_CHECK, DAY_PANEL_TEST],
    ),
    (
        "M-P4-11 入口重新自己算候选（AX-G02：候选只在日期域算）",
        INDEX,
        "  const day = useDayWorkspace({\n",
        "  const dup = todayPlanCandidates({ tasks: [] } as never)\n  const day = useDayWorkspace({\n",
        [EXIT_CHECK, CAPACITY_TEST],
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
codes, _ = run_checks([EXIT_CHECK, DAY_PANEL_TEST, CAPACITY_TEST])
print(f"\n还原后基线：exit={codes}（应全为 0）")
assert all(c == 0 for c in codes), "还原后基线不是绿的"

print(f"\n结果：{len(MUTATIONS) - green}/{len(MUTATIONS)} 条变异被断言发现")
sys.exit(1 if green else 0)
