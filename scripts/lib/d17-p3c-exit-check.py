#!/usr/bin/env python3
"""D17 P3-3 出口核对（独立于 typecheck 的机械检查），与 d17-p1/p2/p3a/p3b-exit-check.py 同构。

本批把**两个任务表单弹窗**搬出入口：
- 新建任务弹窗（非受控表单，提交读 FormData）；
- 编辑任务弹窗（受控草稿，12 个字段逐个改）。

核对：
1. 入口里**不再自己 `useState`** 表单域的 4 项；入口只经 `forms.*` 取（不出现裸 setter 名）；
2. 表单域实现**恰好**落在 `hooks/useTaskForms.ts` + `views/TaskFormModal.tsx`；
   入口仍装配两处，且 `toggleCreate` / `closeCreate` 两个语义**分开**（模式 3：不许合并）；
3. 视图是纯展示：**不发 HTTP**（设计 §3 明令）、不持有 state/effect/派生、不 import 入口/域 hook 实现；
4. 两个弹窗组件**故意不合并**（模式 3），且 12 处逐字重复的 null-safe 展开收成 `patchDraft` 一处；
5. 两个请求本体（`createTask` / `saveEditDraft`）按模式 5 **留在装配层**，payload 与 `api(...)` 不在视图里；
6. 结构指纹：搬迁没有丢 DOM/退化成空壳。

只做文本核对，不是行为验证；行为/结构以 `pnpm typecheck` / `pnpm test` 为准。
"""
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def load(p):
    return open(p, encoding="utf-8", newline="").read().replace("\r\n", "\n")


def strip_comments(s):
    s = re.sub(r"/\*[\s\S]*?\*/", " ", s)
    return re.sub(r"^[ \t]*//.*$", "", s, flags=re.M)


INDEX = load("src/client/index.tsx")
HOOK = load("src/client/hooks/useTaskForms.ts")
TASK_DATA_HOOK = load("src/client/hooks/useTaskData.ts")
VIEW = load("src/client/views/TaskFormModal.tsx")
PANE = load("src/client/views/TaskDetailPane.tsx")

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


def bare(src, name):
    """不被 `forms.` / `forms.actions.` 前缀引用的裸出现次数。"""
    return len(re.findall(r"(?<![\w.])" + re.escape(name) + r"\b", strip_comments(src)))


STATES = ["showForm", "subtaskParent", "editDraft", "formWorkspace"]

print("1) 入口不再自己创建表单域状态；只经 forms 取用，且不出现裸 setter 名")
for st in STATES:
    hits = len(re.findall(r"const \[" + st + r",", INDEX))
    check(hits == 0, f"index.tsx 不再自己 useState {st}（命中 {hits}）")
# 这四个 setter 名在入口一次都不该裸出现（只能经 forms.actions.* 走）
for name in ["setShowForm", "setEditDraft", "setSubtaskParent", "setFormWorkspace", "patchDraft"]:
    hits = bare(INDEX, name)
    check(hits == 0, f"index.tsx 完全不裸用 {name}（命中 {hits}）")
check("const forms = useTaskForms()" in INDEX, "useTaskForms 顶层无条件调用（hook 次序不变）")
check(INDEX.count("const forms = useTaskForms()") == 1, "hook 调用只有一处")
check("const { editDraft, formWorkspace } = forms" in INDEX,
      "入口只取自己用到的读取值（P7-3 起只剩编辑草稿 / 表单工作区；subtaskParent 已无人读）")
check(INDEX.count("const { editDraft, formWorkspace } = forms") == 1,
      "读取值解构只有一处")
check("const { dismissOnTaskChange } = forms.actions" in INDEX,
      "入口只取自己用到的动作（换任务时收表单）")
# 依赖数组必须是稳定的动作本身，不能是每帧重建的 forms.actions 对象
check(re.search(r"\}, \[selected\?\.task\.id, dismissOnTaskChange\]\)", INDEX) is not None,
      "换任务 effect 的依赖是稳定的 dismissOnTaskChange，不是 forms.actions 对象")

print("2) 表单域状态在全客户端只被创建一次（唯一所有者）")
client = []
for root, _dirs, files in os.walk("src/client"):
    for f in files:
        if f.endswith((".ts", ".tsx")):
            client.append((os.path.join(root, f).replace("\\", "/"), strip_comments(load(os.path.join(root, f)))))
for st in STATES:
    owners = [p for p, t in client if re.search(r"const \[" + st + r",", t)]
    check(owners == ["src/client/hooks/useTaskForms.ts"],
          f"{st} 的 useState 只在 useTaskForms 里（实际：{owners or '无'}）")

print("3) 入口：两个弹窗各装配一处，打开与否的守卫仍在调用点")
check(len(re.findall(r"<TaskCreateModal", UI_DIALOGS)) == 1, "新建弹窗装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchDialogs.tsx）")
check(len(re.findall(r"<TaskEditModal", UI_DIALOGS)) == 1, "编辑弹窗装配一处（同上）")
check("open={forms.showForm}" in UI_DIALOGS, "新建弹窗的打开与否读 hook（等价于拆分前的 {showForm && …}；P7-2 起在 app/WorkbenchDialogs.tsx）")
check("{editDraft !== null && selected !== null && (" in UI_DIALOGS,
      "编辑弹窗的守卫仍在调用点（草稿与选中任务都齐了才挂；P7-2 起在 app/WorkbenchDialogs.tsx）")
check("wb-new-task-form" not in INDEX and 'name="workspacePath"' not in INDEX,
      "新建表单 JSX 已整体搬走（入口无副本）")
check("'\\u00a0'.repeat" not in INDEX, "父任务缩进逻辑已随编辑弹窗搬走（入口无副本）")
check("重复：由模板任务管理" not in INDEX, "条件渲染的重复文案已随编辑弹窗搬走（入口无副本）")

print("4) 视图必须是纯展示：不发 HTTP、不持有 state/effect/派生、不 import 入口/域 hook 实现")
view_code = strip_comments(VIEW)
check(not re.search(r"\b(api|fetch)\s*[<(]", view_code), "TaskFormModal.tsx 不发 HTTP 请求（设计 §3）")
check(not re.search(r"\buseState\s*[<(]", view_code), "不自建 state")
check(not re.search(r"\buseEffect\s*\(", view_code), "不自建 effect")
check(not re.search(r"\buseMemo\s*\(", view_code), "不自建派生")
check("from '../index" not in VIEW and "from './index" not in VIEW, "不 import 入口")
check(not re.search(r"^import \{[^}]*\} from '\.\./hooks/use", VIEW, re.M),
      "不 import 域 hook 实现（只允许 type-import）")
check("openDirPicker" not in view_code, "目录浏览分流仍在装配层（视图只喊 onBrowseWorkspace）")

print("5) 两个弹窗故意不合并（模式 3），且 12 处重复展开收成一处")
check(len(re.findall(r"export function TaskCreateModal\(", VIEW)) == 1, "TaskCreateModal 单独导出")
check(len(re.findall(r"export function TaskEditModal\(", VIEW)) == 1, "TaskEditModal 单独导出")
check(len(re.findall(r"export function \w*Modal", strip_comments(VIEW))) == 2,
      "恰好两个弹窗组件（合成就只剩一个）")
check("if (!open) return null" in view_code, "新建弹窗的开关收进组件内部（if (!open) return null）")
patches = len(re.findall(r"onPatchDraft\(\{", view_code))
check(patches == 12, f"编辑弹窗 12 个字段都走 onPatchDraft（命中 {patches}）")
# 模式 3：`setShowForm` 原先有两个语义不同的调用点，收成两个动作后不许再合并
toggle_body = HOOK[HOOK.index("const toggleCreate"):HOOK.index("const closeCreate")]
close_body = HOOK[HOOK.index("const closeCreate"):HOOK.index("const openEdit")]
check("setShowForm((v) => !v)" in toggle_body, "toggleCreate 是开关语义（逐字与拆分前一致）")
check("setShowForm(false)" in close_body, "closeCreate 是关闭语义")
check("(v) => !v" not in close_body, "closeCreate 不许写成开关（模式 3：同名不同语义不许合并）")
check(len(re.findall(r"prev === null \? prev : \{ \.\.\.prev,", strip_comments(HOOK))) == 1,
      "null-safe 展开在 hook 里恰好一处（patchDraft）")
# 入口 + 两个视图里都不该再有逐字段的裸展开
for label, src in [("index.tsx", INDEX), ("TaskFormModal.tsx", VIEW), ("TaskDetailPane.tsx", PANE)]:
    hits = len(re.findall(r"setEditDraft\(\(prev\) =>", strip_comments(src)))
    check(hits == 0, f"{label} 不再写逐字段的 setEditDraft 展开（命中 {hits}）")

print("6) 两个请求本体的 owner（P7-1 起：请求形状归域，装配层留用例入口）")
# ⚠️ 判据跟着 owner 走（D17/P7-1 口径修正）：`createTask` 的 payload 拼接与 POST 已从入口收进
# src/client/hooks/useTaskData.ts —— ADR-0008 结构硬门要求 `WorkbenchApp` 体内 0 业务请求。
# 入口仍保留同名动作（从 hook 解构）：视图侧 `onSubmit={createTask}` 与「只收 FormData」都没变。
check("const createTask = async (form: FormData): Promise<void> =>" in TASK_DATA_HOOK
      and "const createTask = async (form: FormData): Promise<void> =>" not in INDEX,
      "createTask 收 FormData 的请求本体在 useTaskData.ts，入口不再有第二份")
check("onSubmit={createTask}" in UI_DIALOGS, "仍把 createTask 交给新建弹窗（onSubmit 原文未变；P7-2 起在 app/WorkbenchDialogs.tsx）")
check("const saveEditDraft = async (): Promise<void> =>" in INDEX, "saveEditDraft 仍在装配层")
check("'/api/workbench/tasks'" in TASK_DATA_HOOK and "'/api/workbench/tasks'" not in INDEX,
      "POST /api/workbench/tasks 的 owner 是 useTaskData.ts（P7-1 归域），入口体内已无 api(")
check(view_code.count("/api/workbench") == 0, "视图里不出现任何接口路由字面量")
check("estimateRangeMessage(DEFAULT_ESTIMATE_MINUTES)" in INDEX,
      "耗时客户端校验仍在装配层（错误提示不下沉到视图）")
check("{ ...task, estimatedMinutes, allDay: editDraft.allDay }" in INDEX,
      "乐观更新仍在装配层")

print("7) 结构指纹：搬迁没有丢 DOM/退化成空壳")
for marker, n in [('id="wb-new-task-form"', 1), ('name="workspacePath"', 1), ('wb-form"', 2),
                  ("（顶层）", 1), ("父任务", 3), ("\\u00a0", 1), ("AI 策略", 1),
                  ("重复：由模板任务管理", 1), ("wb-form-panel", 0)]:
    hits = len(re.findall(re.escape(marker), view_code))
    check(hits == n, f'{marker} 出现 {n} 次（命中 {hits}）')
for marker, n in [("<WorkspacePicker", 2), ('defaultValue="client_meeting"', 1),
                  ('defaultValue="p2"', 1), ('defaultValue="todo"', 1),
                  ('defaultValue="none"', 1), ("rows={2}", 1), ("rows={6}", 1)]:
    hits = len(re.findall(re.escape(marker), view_code))
    check(hits == n, f'{marker} 出现 {n} 次（命中 {hits}）')

print(f"\n结果：{'全部通过' if not failures else str(len(failures)) + ' 项不通过'}")
sys.exit(1 if failures else 0)
