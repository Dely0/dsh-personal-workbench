#!/usr/bin/env python3
"""D17 P3-1 出口核对（独立于 typecheck 的机械检查），与 d17-p1/p2-exit-check.py 同构。

核对：
1. 入口里**不再有**任务列表域的 state/setter/派生/动作（"删旧实现"可验证；
   跨域只读快照与动作必须带 `taskList.` / `taskList.actions.` 前缀）；
2. 列表域实现**恰好**落在 `hooks/useTaskListModel.ts` + `views/TaskListView.tsx`；
   视图**不得**自己发请求、自己存状态；
3. 唯一口径：本地存储键、空筛选字面量在整个客户端只出现一次/零次。

这里只做文本核对，不是行为验证；行为/结构以 `pnpm typecheck` / `pnpm test` 为准。
"""
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def load(p):
    return open(p, encoding="utf-8", newline="").read().replace("\r\n", "\n")


INDEX = load("src/client/index.tsx")
HOOK = load("src/client/hooks/useTaskListModel.ts")
VIEW = load("src/client/views/TaskListView.tsx")

# ---------------------------------------------------------------- D17/P7-2：JSX 已分四段搬进 app/
# 判据跟着 owner 走：凡「某组件 / 某 props 仍挂在装配层」的断言不再锚 `index.tsx`，
# 而是锚这四段组件 —— 它们才是装配层的 JSX owner。
# 注意：域 hook 不在这份名单里，所以「接线跑进 hook」仍然会红。
def _app_read(name):
    with open(os.path.join("src", "client", "app", name), encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


UI_HEADER = _app_read("WorkbenchHeader.tsx")
UI_OVERLAYS = _app_read("WorkbenchOverlays.tsx")
UI_BODY = _app_read("WorkbenchBody.tsx")
UI_DIALOGS = _app_read("WorkbenchDialogs.tsx")
UI_ALL = "\n".join((UI_HEADER, UI_OVERLAYS, UI_BODY, UI_DIALOGS))

failures = []


def check(ok, message):
    print(("  ✔ " if ok else "  ✖ ") + message)
    if not ok:
        failures.append(message)


def strip_comments(s):
    s = re.sub(r"/\*[\s\S]*?\*/", " ", s)
    return re.sub(r"^[ \t]*//.*$", "", s, flags=re.M)


def bare(src, name):
    """不被 `taskList.` / `taskList.actions.` 之类前缀引用的裸出现次数。

    D17/P4 起（日期域也成了本域的跨域消费方）两条收紧：
    - **先剥注释**：指针注释会成段提到搬走的动作名（`clearExpanded()` 之类），那是散文不是引用；
    - **不算对象字面量的键**（`(?!\\s*:)`）：`archivedTasks: taskList.archivedTasks,` 里的第一个
      `archivedTasks` 是**标签**不是变量 —— 入口把归档只读快照**透传**给日期域 hook 正是这个形态。
      真正的泄漏（`const [archivedTasks, …] = useState(…)` / `archivedTasks.filter(…)`）仍照抓。
    """
    return len(re.findall(r"(?<![\w.])" + re.escape(name) + r"\b(?!\s*:)", strip_comments(src)))


print("1) 入口里不得再有列表域的实现名（裸名，不许带 taskList 前缀）")
for name in [
    "archivedTasks", "archivedMode", "taskFilter", "taskSortKey", "taskSortDir", "openFilter",
    "toggleArchived", "setArchivedMode", "toggleExpanded", "clearExpanded",
    "priorityWeights", "taskSorter", "visibleTaskTree", "taskTypeDicts", "taskTypeTabs",
    "patchFilter", "clearFilter", "selectType", "toggleSortDir", "toggleOpenFilter",
]:
    hits = bare(INDEX, name)
    check(hits == 0, f"index.tsx 无裸 {name}（命中 {hits}）")

print("2) 入口必须只有一处列表视图装配 + 一处 hook 调用")
check(len(re.findall(r"<TaskListView", UI_BODY)) == 1, "TaskListView 装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）")
check("const taskList = useTaskListModel({ tasks, dictOf })" in INDEX, "useTaskListModel 顶层无条件调用（入参 tasks/dictOf）")
check("taskList.actions.clearExpanded()" in INDEX, "工具栏「全部收起」走本域动作（跨域装配仍在入口）")
check("taskList.actions.setArchivedMode(false)" in INDEX, "「恢复任务」退出归档模式走本域动作")
check("...taskList.archivedTasks]" in INDEX or "archivedTasks: taskList.archivedTasks," in INDEX,
      "容量计算读归档集合的只读快照（P4 起改为把快照作日期域入参透传，memo 本体在 hooks/useDayWorkspace.ts）")

print("3) 视图不得自己发请求 / 自己存状态；HTTP 与状态只在 hook 里")
check(not re.search(r"\b(api|fetch)\s*[<(]", VIEW), "TaskListView.tsx 不发 HTTP 请求")
check(not re.search(r"\buseState\s*[<(]", VIEW), "TaskListView.tsx 不自建 state")
check(not re.search(r"\buseEffect\s*\(", VIEW), "TaskListView.tsx 不自建 effect")
check(not re.search(r"\buseMemo\s*\(", VIEW), "TaskListView.tsx 不自建派生")

print("4) 列表域实现只落在 hook 一处")
for fn in ["patchFilter", "clearFilter", "selectType", "toggleSortDir", "toggleOpenFilter",
           "toggleArchived", "toggleExpanded", "clearExpanded"]:
    hits = len(re.findall(r"^  const " + fn + r" = useCallback", HOOK, re.M))
    check(hits == 1, f"useTaskListModel.actions.{fn} 唯一实现（命中 {hits}）")
for st in ["archivedTasks", "archivedMode", "filter", "sortKey", "sortDir", "openFilter", "expanded"]:
    hits = len(re.findall(r"^  const \[" + st + r", ", HOOK, re.M))
    check(hits == 1, f"useTaskListModel 持有 {st}（命中 {hits}）")

print("5) 唯一口径：存储键与空筛选")
client = []
for root, _dirs, files in os.walk("src/client"):
    for f in files:
        if f.endswith((".ts", ".tsx")):
            client.append((os.path.join(root, f), load(os.path.join(root, f))))


stripped = [(p, strip_comments(t)) for p, t in client]
joined = "\n".join(t for _p, t in stripped)
key_hits = len(re.findall(r"dsh\.personal-workbench\.treeExpanded", joined))
check(key_hits == 1, f"树展开集合的存储键全客户端只出现 1 次（命中 {key_hits}，在 hook 里）")
lit = re.escape("{ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] }")
owners = [p.replace("\\", "/") for p, t in stripped if re.search(lit, t)]
check(owners == ["src/client/taskFilterSort.ts"],
      f"空筛选字面量只剩 taskFilterSort.ts 的定义（实际：{owners or '无'}）")
check("EMPTY_TASK_FILTER" in HOOK, "hook 复用共享的 EMPTY_TASK_FILTER")

print(f"\n结果：{'全部通过' if not failures else str(len(failures)) + ' 项不通过'}")
sys.exit(1 if failures else 0)
