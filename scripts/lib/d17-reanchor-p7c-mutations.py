"""D17/P7-3 变异脚本重锚：入口解构块被清理后，6 个「入口把 X 收回去自己 useState」类变异的
锚点（旧的 `} = X.actions` 收尾行）不再存在 —— 改成当前真实存在的收尾行。

不改变异语义（仍然是"入口重新持有本域状态"，仍然必须被对应出口自检抓到），
只把锚点指到清理后真实存在的行；每个文件的补丁累积到同一份内存文本再写一次。
"""
import io
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

LIB = os.path.join("scripts", "lib")
P3C = "d17-mutate-p3c.py"
P3D = "d17-mutate-p3d.py"
P4 = "d17-mutate-p4.py"
P5A = "d17-mutate-p5a.py"
P5B = "d17-mutate-p5b.py"
P5C = "d17-mutate-p5c.py"
P6B = "d17-mutate-p6b.py"
P6C = "d17-mutate-p6c.py"

DAY_ACTIONS_LINE = "  const { addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, setDayTab, setReportSubTab } = day.actions\\n"

PATCHES = [
    # ---------------------------------------------------------- p3c：M-P3C-4
    (P3C,
     '"const { editDraft, subtaskParent, formWorkspace } = forms"',
     '"const { editDraft, formWorkspace } = forms"'),
    (P3C,
     '"const { editDraft, subtaskParent } = forms\\n  const [formWorkspace, setFormWorkspace] = useState(\'\')"',
     '"const { editDraft } = forms\\n  const [formWorkspace, setFormWorkspace] = useState(\'\')"'),
    # ---------------------------------------------------------- p3d：M-P3D-3
    (P3D,
     '"  const { bootstrap, tasks, selected, taskKnowledge, dicts, dictOf, pendingMap, childrenOf } = data"',
     '"  const { bootstrap, tasks, selected, dicts, dictOf, pendingMap, childrenOf } = data"'),
    (P3D,
     '"  const { bootstrap, tasks, taskKnowledge, dicts, dictOf, pendingMap, childrenOf } = data\\n'
     '  const [selected, setSelected] = useState<TaskDetail | null>(null)"',
     '"  const { bootstrap, tasks, dicts, dictOf, pendingMap, childrenOf } = data\\n'
     '  const [selected, setSelected] = useState<TaskDetail | null>(null)"'),
    # ---------------------------------------------------------- p4：M-P4-1 / M-P4-10 锚点
    # M-P4-1 与 M-P4-10 的**锚点**是同一行（`} = day.actions`），所以这条要求命中 2 次。
    (P4,
     '        "  } = day.actions\\n",',
     f'        "{DAY_ACTIONS_LINE}",',
     2),
    (P4,
     '        "  } = day.actions\\n  const [dayTab, setDayTab] = useState<DayTab>(\'plan\')\\n",',
     f'        "{DAY_ACTIONS_LINE}  const [dayTab, setDayTab] = useState<DayTab>(\'plan\')\\n",'),
    (P4,
     '        "  } = day.actions\\n  const addTaskToPlan = async (taskId: string): Promise<void> => { void taskId }\\n",',
     f'        "{DAY_ACTIONS_LINE}  const addTaskToPlan = async (taskId: string): Promise<void> => {{ void taskId }}\\n",'.replace("{{", "{").replace("}}", "}")),
    # ---------------------------------------------------------- p5a：ACTIONS_END
    (P5A,
     'ACTIONS_END = "  } = prefs.actions\\n"',
     'ACTIONS_END = "  const { setSettings, saveDailyCapacity: saveDailyCapacitySetting } = prefs.actions\\n"'),
    # ---------------------------------------------------------- p5b：ACTIONS_END
    (P5B,
     'ACTIONS_END = "  } = remindersApi.actions\\n"',
     'ACTIONS_END = "  const { reminders } = remindersApi\\n"'),
    # ---------------------------------------------------------- p5c：ACTIONS_END
    (P5C,
     'ACTIONS_END = "  } = draftsApi.actions\\n"',
     'ACTIONS_END = "  const { pendingDraft, allPendingDrafts } = draftsApi\\n"'),
    # ---------------------------------------------------------- p6b：PREFS_END
    (P6B,
     'PREFS_END = "  } = prefs.actions\\n"',
     'PREFS_END = "  const { setSettings, saveDailyCapacity: saveDailyCapacitySetting } = prefs.actions\\n"'),
    # ---------------------------------------------------------- p6c：AI_ACTIONS_END
    (P6C,
     'AI_ACTIONS_END = "  } = ai.actions\\n"',
     'AI_ACTIONS_END = "  const { startAISession, resetClarifyPicker } = ai.actions\\n"'),
]

by_file: dict[str, list[tuple[str, str, int]]] = {}
for entry in PATCHES:
    path, old, new = entry[0], entry[1], entry[2]
    want = entry[3] if len(entry) > 3 else 1
    by_file.setdefault(path, []).append((old, new, want))

written = 0
for path, pairs in by_file.items():
    full = os.path.join(LIB, path)
    if not os.path.exists(full):
        print(f"ABORT：找不到 {full}")
        sys.exit(1)
    src = open(full, encoding="utf-8", newline="").read().replace("\r\n", "\n")
    original = src
    applied = 0
    for old, new, want in pairs:
        n_old = src.count(old)
        n_new = src.count(new)
        if n_new == want and n_old == 0:
            continue
        if n_old != want:
            print(f"ABORT：{path} 的片段命中 {n_old} 次（要求 {want} 次）\n  >>> {old[:110]!r}")
            sys.exit(1)
        src = src.replace(old, new, want)
        applied += 1
    if src != original:
        open(full, "w", encoding="utf-8", newline="\n").write(src)
        print(f"✔ {path}（{applied} 处）")
        written += applied
    else:
        print(f"· 跳过（已生效）：{path}")

print(f"✔ 变异锚点重锚 {written} 处" if written else "✔ 全部已生效")
