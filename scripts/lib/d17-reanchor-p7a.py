# -*- coding: utf-8 -*-
"""
D17 / P7-1 判据重锚（判据跟着 owner 走）。

P7-1 把装配层体内最后 6 处 `api(...)` 归域（ADR-0008 结构硬门「体内 0 业务请求」）：
- `createTask` 的 payload + POST → `src/client/hooks/useTaskData.ts`
- `archiveSelectedTask` 整条用例（含两处 `clearSelectedTask()` 与
  `setTasks((list) => list.filter(...))` 原文）→ 同域
- `restoreTask` / `createSubtask` 请求本体 → 同域
- `linkSessionRequest` 请求原语 → 同域
- `saveIncludeOverdue` 整条 + `saveDailyCapacity` 请求本体 → `src/client/hooks/useWorkbenchSettings.ts`

因此四个旧判据的正向断言改指新 owner、入口侧改成负向（证明没留第二份）：
`d17-p3c-exit-check.py`（1 条拆成 3 条）、`d17-p3d-exit-check.py`（6 条重写，103 → 104 项）、
`d17-p4-exit-check.py`（1 条）、`d17-p5a-exit-check.py`（1 条拆成 2 条）。

⚠️ 所有替换要求恰好命中 1 次，任一不成立就整体中止、不写任何文件；写回 `newline="\\n"`。
"""
import io
import pathlib
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[2]
ERRORS = []


def sub1(path, old, new, label):
    text = path.read_text(encoding="utf-8")
    n = text.count(old)
    if n != 1:
        ERRORS.append("[%s] 命中 %d 次（要求恰好 1 次）" % (label, n))
        return
    path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")


P3C = ROOT / "scripts/lib/d17-p3c-exit-check.py"
P3D = ROOT / "scripts/lib/d17-p3d-exit-check.py"
P4 = ROOT / "scripts/lib/d17-p4-exit-check.py"
P5A = ROOT / "scripts/lib/d17-p5a-exit-check.py"

# ───────────────────────── p3c ─────────────────────────
sub1(
    P3C,
    'INDEX = load("src/client/index.tsx")\nHOOK = load("src/client/hooks/useTaskForms.ts")\n',
    'INDEX = load("src/client/index.tsx")\nHOOK = load("src/client/hooks/useTaskForms.ts")\n'
    'TASK_DATA_HOOK = load("src/client/hooks/useTaskData.ts")\n',
    "p3c 常量",
)
sub1(
    P3C,
    'print("6) 两个请求本体按模式 5 留在装配层")\n'
    'check("const createTask = async (form: FormData): Promise<void> =>" in INDEX,\n'
    '      "createTask 收 FormData（视图只 preventDefault + 收 FormData）")\n'
    'check("const saveEditDraft = async (): Promise<void> =>" in INDEX, "saveEditDraft 仍在装配层")\n'
    'check("\'/api/workbench/tasks\'" in INDEX, "POST /api/workbench/tasks 仍在入口")\n',
    'print("6) 两个请求本体的 owner（P7-1 起：请求形状归域，装配层留用例入口）")\n'
    '# ⚠️ 判据跟着 owner 走（D17/P7-1 口径修正）：`createTask` 的 payload 拼接与 POST 已从入口收进\n'
    '# src/client/hooks/useTaskData.ts —— ADR-0008 结构硬门要求 `WorkbenchApp` 体内 0 业务请求。\n'
    '# 入口仍保留同名动作（从 hook 解构）：视图侧 `onSubmit={createTask}` 与「只收 FormData」都没变。\n'
    'check("const createTask = async (form: FormData): Promise<void> =>" in TASK_DATA_HOOK\n'
    '      and "const createTask = async (form: FormData): Promise<void> =>" not in INDEX,\n'
    '      "createTask 收 FormData 的请求本体在 useTaskData.ts，入口不再有第二份")\n'
    'check("onSubmit={createTask}" in INDEX, "入口仍把 createTask 交给新建弹窗（onSubmit 原文未变）")\n'
    'check("const saveEditDraft = async (): Promise<void> =>" in INDEX, "saveEditDraft 仍在装配层")\n'
    'check("\'/api/workbench/tasks\'" in TASK_DATA_HOOK and "\'/api/workbench/tasks\'" not in INDEX,\n'
    '      "POST /api/workbench/tasks 的 owner 是 useTaskData.ts（P7-1 归域），入口体内已无 api(")\n',
    "p3c §6",
)

# ───────────────────────── p3d ─────────────────────────
sub1(
    P3D,
    'check(len(re.findall(r"const data = useTaskData\\(\\{ onError: setError, onNotice: setNotice \\}\\)", INDEX)) == 1,\n'
    '      "入口恰好一处 `const data = useTaskData({ onError: setError, onNotice: setNotice })`")\n',
    'check(len(re.findall(r"const data = useTaskData\\(\\{", INDEX)) == 1,\n'
    '      "入口恰好一处 `const data = useTaskData({`（P7-1 起入参多了三个跨域注入回调，仍是唯一调用点）")\n',
    "p3d data 调用",
)
sub1(
    P3D,
    'check(len(re.findall(r"onNotice\\(", HOOK_BARE)) == 2,\n'
    '      "两处反馈（完成任务 / 推迟）走注入的 onNotice")\n',
    'check(len(re.findall(r"onNotice\\(", HOOK_BARE)) == 6,\n'
    '      "六处反馈走注入的 onNotice（完成任务 / 推迟 / 归档成功 / 归档 not found 自愈 / 恢复 / 子任务创建）")\n',
    "p3d onNotice 计数",
)
sub1(
    P3D,
    'check("setTasks((list) => list.filter((t) => t.id !== id))" in INDEX_BARE,\n'
    '      "归档成功前的本地移除仍在入口（逐字原文，探针 I5 的同类锚点）")\n',
    'check("setTasks((list) => list.filter((t) => t.id !== id))" in HOOK_BARE\n'
    '      and "setTasks((list) => list.filter((t) => t.id !== id))" not in INDEX_BARE,\n'
    '      "归档成功前的本地移除已归任务域（D17/P7-1 整条用例搬走；探针 I5 的同类锚点跟着 owner 走）")\n',
    "p3d setTasks filter",
)
sub1(
    P3D,
    'check(len(re.findall(r"clearSelectedTask\\(\\)", INDEX_BARE)) == 2,\n'
    '      "入口两处只调 clearSelectedTask()（成功分支 + not found 自愈分支），不再各写两连 setter")\n',
    'check(len(re.findall(r"clearSelectedTask\\(\\)", INDEX_BARE)) == 0\n'
    '      and len(re.findall(r"clearSelectedTask\\(\\)", HOOK_BARE)) == 2,\n'
    '      "两处 clearSelectedTask()（成功分支 + not found 自愈分支）随归档用例进 hook（D17/P7-1）")\n',
    "p3d clearSelectedTask",
)
sub1(
    P3D,
    'check("const restoreTask = (taskId: string): void => {" in INDEX_BARE\n'
    '      and "const createSubtask = (form: FormData, parent: Task): void => {" in INDEX_BARE,\n'
    '      "restoreTask / createSubtask 两个跨域请求本体留在入口（P3-2 判据不变）")\n'
    'for route in ["/restore", "/subtasks"]:\n'
    '    check(route not in HOOK_BARE, f"hook 里没有别域的 {route} 请求")\n',
    'check("const restoreTask = (taskId: string): void => {" in HOOK_BARE\n'
    '      and "const createSubtask = (form: FormData, parent: Task): void => {" in HOOK_BARE\n'
    '      and "const restoreTask = " not in INDEX_BARE and "const createSubtask = " not in INDEX_BARE,\n'
    '      "restoreTask / createSubtask 的请求本体已归任务域（D17/P7-1），入口只留下传")\n'
    'check("onRestoreTask={restoreTask}" in INDEX_BARE and "onCreateSubtask={createSubtask}" in INDEX_BARE,\n'
    '      "入口仍把这两个动作交给详情面板（props 原文未变）")\n'
    'check("/restore" in HOOK_BARE and "/restore" not in INDEX_BARE,\n'
    '      "POST /restore 的 owner 是 useTaskData.ts（P7-1 归域），入口体内已无 api(")\n'
    'check("/subtasks" not in HOOK_BARE and "/subtasks" not in INDEX_BARE,\n'
    '      "`/subtasks` 这个旧路由两边都没有（子任务走 POST /tasks + parentId）")\n',
    "p3d restore/createSubtask",
)

# ───────────────────────── p4 ─────────────────────────
sub1(
    P4,
    'TODAY_PANE = load("src/client/views/TodayPane.tsx")\n',
    'TODAY_PANE = load("src/client/views/TodayPane.tsx")\n'
    'SETTINGS_HOOK = load("src/client/hooks/useWorkbenchSettings.ts")\n',
    "p4 常量",
)
sub1(
    P4,
    'check("const saveDailyCapacity = async (): Promise<void> =>" in INDEX and\n'
    '      "const saveIncludeOverdue = async (next: boolean): Promise<void> =>" in INDEX,\n'
    '      "两个 settings 写入留在装配层（P6 才搬）")\n',
    '# ⚠️ 判据跟着 owner 走（D17/P7-1 口径修正）：两个 settings 写入的**请求本体**已归设置域\n'
    '#（src/client/hooks/useWorkbenchSettings.ts）—— 装配层体内不许再有 api(。入口只留\n'
    '# `saveDailyCapacity` 的装配层半边（读日期域的行内编辑态、把原文递进设置域）。\n'
    'check("const saveDailyCapacity = async (): Promise<void> =>" in INDEX\n'
    '      and "const saveDailyCapacity = async (rawEdit: string): Promise<void> =>" in SETTINGS_HOOK\n'
    '      and "const saveIncludeOverdue = async (next: boolean): Promise<void> =>" not in INDEX\n'
    '      and "const saveIncludeOverdue = async (next: boolean): Promise<void> =>" in SETTINGS_HOOK,\n'
    '      "两个 settings 写入：请求本体归设置域（D17/P7-1），入口只留 saveDailyCapacity 的装配层半边")\n',
    "p4 settings 写入",
)

# ───────────────────────── p5a ─────────────────────────
sub1(
    P5A,
    'for decl in ["const saveIncludeOverdue = async (next: boolean): Promise<void> => {",\n'
    '             "const saveDailyCapacity = async (): Promise<void> => {"]:\n'
    '    check(decl in INDEX_BARE, f"仍在入口：{decl[6:40]}…")\n',
    '# ⚠️ 判据跟着 owner 走（D17/P7-1 口径修正）：`saveIncludeOverdue` 的整条用例与\n'
    '# `saveDailyCapacity` 的**请求本体**也搬走了（src/client/hooks/useWorkbenchSettings.ts）。\n'
    '# 入口只留 `saveDailyCapacity` 的装配层半边（读日期域的编辑态 + 把原文递进去），\n'
    '# 成对断言（入口不存在 + 新 owner 里恰好一份）写在这里而不是删除。\n'
    'check("const saveDailyCapacity = async (): Promise<void> => {" in INDEX_BARE,\n'
    '      "仍在入口：saveDailyCapacity 的装配层半边（读日期域的 capacityEdit）")\n'
    'check("const saveIncludeOverdue" not in INDEX_BARE,\n'
    '      "saveIncludeOverdue 已不在入口（D17/P7-1 整条搬进设置域）")\n'
    'check(SETTINGS.count("const saveIncludeOverdue = async (next: boolean): Promise<void> => {") == 1\n'
    '      and SETTINGS.count("const saveDailyCapacity = async (rawEdit: string): Promise<void> => {") == 1,\n'
    '      "两个 settings 写入的请求本体在设置域各恰好一份（D17/P7-1 归域）")\n',
    "p5a 两个 save*",
)

if ERRORS:
    print("✖ 中止，未写任何文件：")
    for line in ERRORS:
        print("   - " + line)
    sys.exit(1)

print("✔ 已重锚 4 个出口自检：p3c / p3d / p4 / p5a")
