#!/usr/bin/env python3
"""D17 P3-4 出口核对（独立于 typecheck 的机械检查），与 d17-p1/p2/p3a/p3b/p3c-exit-check.py 同构。

本批把**任务数据域**搬出入口：
- 5 项 state（`bootstrap` / `tasks` / `pendingCompletions` / `selected` / `taskKnowledge`）；
- 最新值镜像 `selectedRef`；
- 只读派生 `dicts` / `dictOf` / `pendingMap` / `childrenIndex` / `childrenOf`；
- 动作 `refresh` / `loadTaskKnowledge` / `loadTaskDetail` / `patchTask` / `completePlanTask` /
  `saveProgress` / `completeTaskFromProgress` / `deferPlanTask`；
- 跨域反馈改成注入回调 `onError` / `onNotice`（设计 §5）。

**刻意留在装配层**（设计 §4.1 第 148 行）：`openTask`（要 `resetDetailView()`）与
`openTaskById`（首句 `setView('list')`）；两个请求本体 `restoreTask` / `createSubtask` 也留在入口
（每个都跨两个以上的域）。

核对：
1. 入口里**不再自己 `useState` / `useRef` / `useMemo` / `useCallback` 创建**本域的任何东西；
   只经 `data` / `data.actions` 取（不出现裸 setter 名）；
2. 每个 state / 派生 / 动作的**创建者恰好**是 `hooks/useTaskData.ts`（全客户端唯一所有者）；
3. 设计 §4.1 的两条红线：`loadTaskDetail` 体内没有 `setView`；`openTaskById` **不在** hook 里，
   入口那份体内必须有 `setView('list')`；`saveProgress` / `completeTaskFromProgress` 只调
   `loadTaskDetail`，不许调 `openTaskById`；
4. `refresh` **整块**搬走且没有被拆成多次独立请求（第 149 行）——它体内恰好一次三端点 `Promise.all`；
5. 跨域靠注入（设计 §5）：hook 里没有裸 `setError` / `setNotice` / `setView` / `resetDetailView`；
6. 装配层原语 `setTasks` / `clearSelectedTask` / `currentTaskId` 的形状与调用点数量；
7. 结构指纹：搬迁没有丢 render（列表/详情的 props 与两条探针锚点原文都在）。

只做文本核对，不是行为验证；行为/结构以 `pnpm typecheck` / `pnpm test` 为准。
"""
import io
import os
import re
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def load(p):
    return open(p, encoding="utf-8", newline="").read().replace("\r\n", "\n")


def strip_comments(s):
    s = re.sub(r"/\*[\s\S]*?\*/", " ", s)
    return re.sub(r"^[ \t]*//.*$", "", s, flags=re.M)


INDEX = load("src/client/index.tsx")
HOOK = load("src/client/hooks/useTaskData.ts")
HOOK_BARE = strip_comments(HOOK)
INDEX_BARE = strip_comments(INDEX)

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


def bare(src, name, origin=INDEX_BARE):
    """不被 `data.` / `data.actions.` 前缀引用的裸出现次数。"""
    return len(re.findall(r"(?<![\w.])" + re.escape(name) + r"\b", origin))


def body_of(src, start, end=None):
    """从 start 切到 end（都必须在），用于只看函数体。end 省略时取到文件尾。"""
    i = src.find(start)
    if i < 0:
        return None
    rest = src[i:]
    if end is None:
        return rest
    j = rest.find(end, len(start))
    return None if j < 0 else rest[:j]


STATES = ["bootstrap", "tasks", "pendingCompletions", "selected", "taskKnowledge"]
DERIVED = ["dicts", "dictOf", "pendingMap", "childrenIndex", "childrenOf"]
ACTIONS = ["refresh", "loadTaskKnowledge", "loadTaskDetail", "patchTask", "completePlanTask",
           "saveProgress", "completeTaskFromProgress", "deferPlanTask"]

# 全客户端的创建点（用于"恰好一处所有者"）
CLIENT_CREATORS = subprocess.run(
    ["git", "ls-files", "-co", "--exclude-standard", "src/client"],
    capture_output=True, text=True, encoding="utf-8", check=True,
).stdout.split()
CLIENT_SOURCES = {p: strip_comments(load(p)) for p in CLIENT_CREATORS if p.endswith((".ts", ".tsx"))}
CLIENT_SOURCES["src/client/index.tsx"] = INDEX_BARE

print("1) 入口不再自己创建任务数据域的状态 / 派生 / 动作；只经 data 取用")
for st in STATES:
    hits = len(re.findall(r"const \[" + st + r",", INDEX))
    check(hits == 0, f"index.tsx 不再自己 useState {st}（命中 {hits}）")
check("const selectedRef = useRef" not in INDEX,
      "index.tsx 不再自己 useRef selectedRef")
for name in DERIVED + ACTIONS:
    hits = len(re.findall(r"const " + name + r" = (?:useMemo|useCallback|async|\()", INDEX))
    check(hits == 0, f"index.tsx 不再自己声明 {name}（命中 {hits}）")
for setter in ["setBootstrap", "setPendingCompletions", "setSelected", "setTaskKnowledge",
               "pendingCompletionMap"]:
    hits = bare(INDEX, setter)
    check(hits == 0, f"index.tsx 不出现裸 {setter}（命中 {hits}）")
check(len(re.findall(r"const data = useTaskData\(\{", INDEX)) == 1,
      "入口恰好一处 `const data = useTaskData({`（P7-1 起入参多了三个跨域注入回调，仍是唯一调用点）")
check("const { bootstrap, tasks, selected, dicts, dictOf, pendingMap, childrenOf } = data"
      in INDEX, "入口解构出本域读取值（P7-3 起只留入口真读的 7 项；仍用局部名，故既有判据/探针原文不受影响）")
# P7-3 后入口只为 JSX 解构的名字已删 —— 逐名断言按"入口真读的 9 个动作"重锚。
DATA_ACTIONS_IN_ENTRY = ["refresh", "loadTaskDetail", "patchTask", "completePlanTask", "saveProgress",
                         "deferPlanTask", "setTasks", "currentTaskId", "linkSessionRequest"]
for name in DATA_ACTIONS_IN_ENTRY:
    check(re.search(r"\n    " + name + r",\n", INDEX) is not None,
          f"入口从 data.actions 解构出 {name}")
for name in ["completeTaskFromProgress", "clearSelectedTask"]:
    check(re.search(r"\n    " + name + r",\n", INDEX) is None,
          f"入口不再解构 {name}（P7-3 清理：调用点已随 JSX 搬进 app/）")
check(bare(INDEX, "loadTaskKnowledge") == 0,
      "入口不解构 loadTaskKnowledge（它只在 hook 内部被 refresh / loadTaskDetail 用到）")

print("2) 每个 state / 派生 / 动作的创建者恰好是 hooks/useTaskData.ts")
# 有歧义的名字（别的域也有同名的 `selected` / `dicts` / `dictOf` / `refresh`）用**完整声明原文**定位。
DECLS = {
    "bootstrap": "const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)",
    "tasks": "const [tasks, setTasks] = useState<Task[]>([])",
    "pendingCompletions": "const [pendingCompletions, setPendingCompletions] = useState<PendingCompletionView | null>(null)",
    "selected": "const [selected, setSelected] = useState<TaskDetail | null>(null)",
    "taskKnowledge": "const [taskKnowledge, setTaskKnowledge] = useState<KnowledgeEntry[]>([])",
    "dicts": "const dicts = useMemo(() => bootstrap?.dictionaries ?? [], [bootstrap])",
    "dictOf": "const dictOf = useCallback((kind: string) => dicts.filter((d) => d.kind === kind), [dicts])",
    "refresh": "const refresh = useCallback(async () => {",
}
for st in STATES:
    owners = sorted(p for p, s in CLIENT_SOURCES.items() if DECLS[st] in s)
    check(owners == ["src/client/hooks/useTaskData.ts"],
          f"{st} 的创建点唯一在 useTaskData.ts（实际 {owners}）")
for name in DERIVED + ACTIONS:
    if name in DECLS:
        owners = sorted(p for p, s in CLIENT_SOURCES.items() if DECLS[name] in s)
    else:
        owners = sorted(p for p, s in CLIENT_SOURCES.items()
                        if re.search(r"const " + name + r" = (?:useMemo|useCallback|async|\()", s))
    check(owners == ["src/client/hooks/useTaskData.ts"],
          f"{name} 的创建点唯一在 useTaskData.ts（实际 {owners}）")
check(sum(re.search(r"const selectedRef = useRef", s) is not None for s in CLIENT_SOURCES.values()) == 1,
      "`selectedRef` 全客户端只有一份声明")

print("3) 设计 §4.1 的红线：刷新详情不导航，导航只留装配层")
detail = body_of(HOOK_BARE, "const loadTaskDetail = (taskId: string): void =>", "const patchTask = ")
check(detail is not None and "setView(" not in detail,
      "hook 的 loadTaskDetail 只刷新数据，不含 setView")
check("openTaskById" not in HOOK_BARE, "hook 里没有 openTaskById（导航组合归装配层）")
open_by_id = body_of(INDEX_BARE, "const openTaskById = (taskId: string): void =>")
check(open_by_id is not None and "setView('list')" in open_by_id,
      "入口的 openTaskById 体内有 setView('list')（唯一会切 list 的那个）")
open_task = body_of(INDEX_BARE, "const openTask = (task: Task): void =>", "const openTaskById = ")
check(open_task is not None and "resetDetailView()" in open_task and "setView(" not in open_task,
      "入口的 openTask 只重置详情页签、不切视图")
for fn, nxt in [("const saveProgress = async", "const completeTaskFromProgress = async"),
                ("const completeTaskFromProgress = async", "const deferPlanTask = async")]:
    seg = body_of(HOOK_BARE, fn, nxt)
    label = fn.split("const ")[1].split(" =")[0]
    check(seg is not None and "loadTaskDetail(taskId)" in seg and "openTaskById(" not in seg,
          f"hook 的 {label} 用 loadTaskDetail 刷新、不调 openTaskById")

print("4) refresh 整块搬走，且没被拆成多次独立请求（设计 §4.1 第 149 行）")
refresh = body_of(HOOK_BARE, "const refresh = useCallback(async () => {", "\n  }, [])")
check(refresh is not None, "hook 里有 refresh")
if refresh is not None:
    check(len(re.findall(r"Promise\.all\(", refresh)) == 2,
          "refresh 体内恰好两处 Promise.all（先三端点快照，再按选中 id 补详情）")
    for route in ["'/api/workbench/bootstrap'", "'/api/workbench/tasks'",
                  "'/api/workbench/tasks/pending-completions'", "/events`", "/reviews`"]:
        check(route in refresh, f"refresh 体内含 {route}")
check(len(re.findall(r"pending-completions", HOOK_BARE)) == 1,
      "待验收端点全客户端（hook 内）只出现一次（不做 N+1）")
check("setBootstrap(boot); setTasks(list.tasks); setPendingCompletions(pending)" in HOOK_BARE,
      "refresh 里三份快照仍是同一批写入")

print("5) 跨域靠注入（设计 §5），hook 不直接碰反馈域 / 导航域")
for leaked in ["setError", "setNotice", "setView", "resetDetailView", "setDetailTab"]:
    hits = len(re.findall(r"(?<![\w.])" + leaked + r"\b", HOOK_BARE))
    check(hits == 0, f"hook 里不出现裸 {leaked}（命中 {hits}）")
check("onError: (message: string) => void" in HOOK and "onNotice: (message: string) => void" in HOOK,
      "入参类型声明了 onError / onNotice")
check("onError(e instanceof Error ? e.message : String(e))" in HOOK_BARE,
      "loadTaskDetail 的 catch 走注入的 onError")
check(len(re.findall(r"onNotice\(", HOOK_BARE)) == 6,
      "六处反馈走注入的 onNotice（完成任务 / 推迟 / 归档成功 / 归档 not found 自愈 / 恢复 / 子任务创建）")

print("6) 装配层原语：setTasks / clearSelectedTask / currentTaskId")
check("setTasks: Dispatch<SetStateAction<Task[]>>" in HOOK,
      "setTasks 保留 Dispatch<SetStateAction<Task[]>> 原形（不收窄成快照，否则丢掉并发更新）")
check("setTasks((list) => list.filter((t) => t.id !== id))" in HOOK_BARE
      and "setTasks((list) => list.filter((t) => t.id !== id))" not in INDEX_BARE,
      "归档成功前的本地移除已归任务域（D17/P7-1 整条用例搬走；探针 I5 的同类锚点跟着 owner 走）")
check(len(re.findall(r"setTasks\(\(prev\) => prev\.map\(", INDEX_BARE)) == 1,
      "编辑保存的乐观更新仍在入口（逐字原文，探针 I5 锚点）")
check(len(re.findall(r"clearSelectedTask\(\)", INDEX_BARE)) == 0
      and len(re.findall(r"clearSelectedTask\(\)", HOOK_BARE)) == 2,
      "两处 clearSelectedTask()（成功分支 + not found 自愈分支）随归档用例进 hook（D17/P7-1）")
clear = body_of(HOOK_BARE, "const clearSelectedTask = useCallback", "const currentTaskId = useCallback")
check(clear is not None and "setSelected(null)" in clear and "selectedRef.current = null" in clear,
      "clearSelectedTask 体内 `selected` 与 `selectedRef` 一起清")
# ⚠️ 判据跟着 owner 走（P5-2 口径修正）：原本这里断言入口有**三处** `currentTaskId()`
#（提醒 ack / 添加提醒 / 关联会话）。D17/P5-2 把提醒域整域搬进
# src/client/hooks/useWorkbenchReminders.ts 之后，`ackReminder` / `addTaskReminder`
# 两处随实现一起走了，入口只剩"关联会话"这一处。
# 入口侧的不变量（读当前选中 id 走 currentTaskId()、不直接碰 selectedRef）保持不变；
# 提醒 hook 里那两处由 scripts/lib/d17-p5b-exit-check.py 负责。
check(len(re.findall(r"currentTaskId\(\)", INDEX_BARE)) == 1,
      "入口仅剩一处读当前选中 id（关联会话）走 currentTaskId()；提醒域两处已随实现搬走")
check(len(re.findall(r"selectedRef", INDEX_BARE)) == 0, "入口里没有 selectedRef 代码")

print("7) 结构指纹：搬迁没有丢 render、也没有把别域请求卷进来")
for prop in ["pending={pendingMap}", "dicts={dicts}", "childrenOf={childrenOf}",
             "patchTask={patchTask}", "saveProgress={saveProgress}",
             "completeTaskFromProgress={completeTaskFromProgress}", "openTask={openTask}"]:
    check(prop in UI_BODY, f"装配层仍装配 {prop}（D17/P7-2 起在 app/WorkbenchBody.tsx）")
check("const taskList = useTaskListModel({ tasks, dictOf })" in INDEX_BARE,
      "入口仍用局部名 tasks / dictOf 调用 useTaskListModel（P3a 判据不变）")
check("archivedTasks: taskList.archivedTasks," in INDEX_BARE,
      "入口把归档集合的只读快照透传给日期域 hook（P4 起 memo 本体不在这里，透传形态仍在）")
check("tasks: [...tasks, ...archivedTasks]" in load("src/client/hooks/useDayWorkspace.ts"),
      "容量 memo 的入参原文搬到 hooks/useDayWorkspace.ts（既有判据 + 探针 I1 锚点，P4 已重锚）")
check("{ ...task, estimatedMinutes, allDay: editDraft.allDay }" in INDEX_BARE,
      "编辑乐观更新的原文仍在（既有判据 + 探针 I5 锚点）")
check("const restoreTask = (taskId: string): void => {" in HOOK_BARE
      and "const createSubtask = (form: FormData, parent: Task): void => {" in HOOK_BARE
      and "const restoreTask = " not in INDEX_BARE and "const createSubtask = " not in INDEX_BARE,
      "restoreTask / createSubtask 的请求本体已归任务域（D17/P7-1），入口只留下传")
check("onRestoreTask={restoreTask}" in UI_BODY and "onCreateSubtask={createSubtask}" in UI_BODY,
      "仍把这两个动作交给视图（props 原文未变；P7-2 起在 app/WorkbenchBody.tsx）")
check("/restore" in HOOK_BARE and "/restore" not in INDEX_BARE,
      "POST /restore 的 owner 是 useTaskData.ts（P7-1 归域），入口体内已无 api(")
check("/subtasks" not in HOOK_BARE and "/subtasks" not in INDEX_BARE,
      "`/subtasks` 这个旧路由两边都没有（子任务走 POST /tasks + parentId）")
check("为什么必须与" in HOOK and "2026-10-01" in HOOK,
      "2026-10-01 的 BUG 约定注释随 loadTaskDetail 逐字搬进了 hook")
check("ADR 0004" in HOOK, "直接子任务索引的 ADR 0004 注释随 childrenIndex 搬进 hook")
check('"一次查询 → 一份 Map → 全列表共用"' in HOOK or "一次查询 → 一份 Map → 全列表共用" in HOOK,
      "pendingMap 的「null 与空 Map 是两件事」注释搬进 hook")

print(f"\n结果：{'全部通过' if not failures else str(len(failures)) + ' 项不通过'}")
sys.exit(1 if failures else 0)
