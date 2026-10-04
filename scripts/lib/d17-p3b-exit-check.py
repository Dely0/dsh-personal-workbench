#!/usr/bin/env python3
"""D17 P3-2 出口核对（独立于 typecheck 的机械检查），与 d17-p1/p2/p3a-exit-check.py 同构。

核对：
1. 入口里**不再自己 `useState`** 详情域的 6 项；入口不直接摸状态名，只经 `detail.*` 取（少数动作除外）；
2. 详情域实现**恰好**落在 `hooks/useTaskDetailModel.ts` + `views/TaskDetailPane.tsx`；
   三路分派仍在入口，且入口**不再**自己判 `selected === null` 的空态；
3. 视图是纯展示：**不发 HTTP**（设计 §3 明令）、不持有 state/effect/派生、不 import 入口/域 hook 实现；
4. 唯一口径：三个语义动作只有一份实现，入口/视图里不再出现那三处"两连调用"；
5. 类型契约：入口不再内联两份匿名类型。

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
HOOK = load("src/client/hooks/useTaskDetailModel.ts")
VIEW = load("src/client/views/TaskDetailPane.tsx")
CONTRACTS = load("src/client/app/contracts.ts")
# D17/P3-3：编辑草稿这一格（连同它的契约类型）随任务表单域搬进了这个 hook。
FORMS_HOOK = load("src/client/hooks/useTaskForms.ts")

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
    """不被 `detail.` / `detail.actions.` 前缀引用的裸出现次数。"""
    return len(re.findall(r"(?<![\w.])" + re.escape(name) + r"\b", strip_comments(src)))


STATES = ["detailTab", "sessionPickerOpen", "sessionPickerRole",
          "sessionPickerQuery", "sessionPickerBusy", "eventsExpanded"]

print("1) 入口不再自己创建详情域状态；只经 detail 取用")
for st in STATES:
    hits = len(re.findall(r"const \[" + st + r",", INDEX))
    check(hits == 0, f"index.tsx 不再自己 useState {st}（命中 {hits}）")
# 这几个名字在入口一次都不该出现：它们完全是 TaskDetailPane 内部的事
for name in ["detailTab", "sessionPickerOpen", "eventsExpanded", "sessionPickerBusy",
             "setDetailTab", "setSessionPickerOpen", "setSessionPickerRole", "setSessionPickerQuery",
             "setEventsExpanded", "openSessionPicker"]:
    hits = bare(INDEX, name)
    check(hits == 0, f"index.tsx 完全不出现 {name}（命中 {hits}）")
check("const { sessionPickerRole, sessionPickerQuery } = detail" in INDEX,
      "入口只取自己用到的读取值（sessionPickerRole / sessionPickerQuery）")
check(INDEX.count("const { sessionPickerRole, sessionPickerQuery } = detail") == 1,
      "读取值解构只有一处")
check("const { setSessionPickerBusy, resetDetailView, closeSessionPicker } = detail.actions" in INDEX,
      "入口只取自己用到的动作（置忙 / 复位详情 / 收起选择器）")
check(INDEX.count("const { setSessionPickerBusy, resetDetailView, closeSessionPicker } = detail.actions") == 1,
      "动作解构只有一处")

print("2) 详情域状态在全客户端只被创建一次（唯一所有者）")
client = []
for root, _dirs, files in os.walk("src/client"):
    for f in files:
        if f.endswith((".ts", ".tsx")):
            client.append((os.path.join(root, f).replace("\\", "/"), strip_comments(load(os.path.join(root, f)))))
joined_ts = "\n".join(t for _p, t in client)
for st in STATES:
    owners = [p for p, t in client if re.search(r"const \[" + st + r",", t)]
    check(owners == ["src/client/hooks/useTaskDetailModel.ts"],
          f"{st} 的 useState 只在 useTaskDetailModel 里（实际：{owners or '无'}）")

print("3) 入口：唯一 hook 调用 + 三路分派 + 不再自己判空态")
check("const detail = useTaskDetailModel()" in INDEX, "useTaskDetailModel 顶层无条件调用（hook 次序不变）")
check(len(re.findall(r"<TaskDetailPane", UI_BODY)) == 1, "TaskDetailPane 装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）")
check(len(re.findall(r"<IdeasDetailPane", UI_BODY)) == 1 and len(re.findall(r"<KnowledgeDetailPane", UI_BODY)) == 1,
      "三路分派仍在装配层（ideas / knowledge / task 各一处；D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）")
check(": selected === null" not in INDEX, "空态判定已归 TaskDetailPane（入口不再判 selected === null）")
check("AI 澄清/咨询/拆解会跳转到官方会话区" not in INDEX, "空态文案已随组件搬走（入口无副本）")

print("4) 视图必须是纯展示：不发 HTTP、不持有 state/effect/派生、不 import 入口/域 hook 实现")
view_code = strip_comments(VIEW)
check(not re.search(r"\b(api|fetch)\s*[<(]", view_code), "TaskDetailPane.tsx 不发 HTTP 请求（设计 §3）")
check(not re.search(r"\buseState\s*[<(]", view_code), "不自建 state")
check(not re.search(r"\buseEffect\s*\(", view_code), "不自建 effect")
check(not re.search(r"\buseMemo\s*\(", view_code), "不自建派生")
check("from '../index" not in VIEW and "from './index" not in VIEW, "不 import 入口")
check(not re.search(r"^import \{[^}]*\} from '\.\./hooks/use", VIEW, re.M),
      "只 type-import 域 hook（不 import 实现）")

print("5) 结构指纹：搬迁没有丢 DOM/退化成空壳")
for marker, n in [('wb-detail-tabs', 1), ('wb-detail-tab ${', 4), ('wb-detail-actions', 1),
                  ('wb-session-list', 1), ('wb-session-picker"', 1), ('wb-form-panel', 1),
                  ('wb-event-title', 1), ('wb-card', 7), ('wb-empty', 3)]:
    hits = len(re.findall(re.escape(marker), view_code))
    check(hits == n, f'{marker} 出现 {n} 次（命中 {hits}）')

print("6) 唯一口径：三个语义动作只有一份实现，调用点不再写两连 setState")
reset_body = HOOK[HOOK.index("const resetDetailView"):HOOK.index("const openSessionPicker")]
open_body = HOOK[HOOK.index("const openSessionPicker"):HOOK.index("const closeSessionPicker")]
close_body = HOOK[HOOK.index("const closeSessionPicker"):HOOK.index("return {")]
check("setDetailTab('desc')\n    setEventsExpanded(false)" in reset_body,
      "resetDetailView 里是那两行（顺序与拆分前一致）")
check("setSessionPickerQuery('')\n    setSessionPickerOpen(true)" in open_body,
      "openSessionPicker 里是那两行（顺序与拆分前一致）")
check("setSessionPickerOpen(false)\n    setSessionPickerQuery('')" in close_body,
      "closeSessionPicker 里是那两行（顺序与拆分前一致）")
check("setDetailTab('desc')\n    setEventsExpanded(false)" not in joined_ts.replace(reset_body, ""),
      "全客户端只有 resetDetailView 里有这份两连调用")
check("setSessionPickerQuery(''); setSessionPickerOpen(true)" not in INDEX + VIEW,
      "入口与视图都不再写「清空 + 展开」两连调用")
check("setSessionPickerOpen(false); setSessionPickerQuery('')" not in INDEX + VIEW,
      "入口与视图都不再写「收起 + 清空」两连调用")

print("7) 类型契约：入口不再内联两份匿名类型")
# D17/P6-1 后：视图联合类型的 useState 随**导航域**搬进 useWorkbenchNavigation.ts。
# 按「判据跟着 owner 走」——正向改指新 owner，入口改成负向（不是放宽）。
NAV_HOOK = load("src/client/hooks/useWorkbenchNavigation.ts")
check("const [view, setView] = useState<WorkbenchView>('today')" in NAV_HOOK,
      "视图联合类型（app/contracts.ts 的 WorkbenchView）由导航域持有")
check("useState<WorkbenchView>" not in INDEX,
      "入口不再持有视图联合类型的 useState（owner 已移交 useWorkbenchNavigation）")
check("useState<TaskEditDraft | null>(null)" in FORMS_HOOK, "编辑草稿类型改用 app/contracts.ts 的 TaskEditDraft")
check("export type WorkbenchView = 'today' | 'calendar' | 'list' | 'knowledge' | 'ideas'" in CONTRACTS,
      "WorkbenchView 定义在契约文件里、与拆分前逐字一致")
check("import" not in strip_comments(CONTRACTS).replace("import type", ""),
      "契约文件只用类型、不 import 任何实现")

print(f"\n结果：{'全部通过' if not failures else str(len(failures)) + ' 项不通过'}")
sys.exit(1 if failures else 0)
