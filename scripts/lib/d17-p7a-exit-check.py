"""D17 / P7-1（入口最后 6 处 `api(` 归域）出口自检 —— 只做文本核对，行为以 typecheck / pnpm test 为准。

本批把 WorkbenchApp 体内的**最后 6 处业务请求**按"请求形状与它的输入校验归域、
把结果接到哪些域的状态归装配层"分派出去：

* `/api/workbench/tasks/${id}/archive`（整条用例，含 `window.confirm` 与 not-found 自愈）
  → `src/client/hooks/useTaskData.ts#archiveSelectedTask`
* `POST /api/workbench/tasks` 两条（新建任务 / 新建子任务）→ `useTaskData#createTask` / `#createSubtask`
* `POST /api/workbench/tasks/${taskId}/restore` → `useTaskData#restoreTask`
* `POST /api/workbench/tasks/${taskId}/sessions` 的**请求原语** → `useTaskData#linkSessionRequest`
  （会话选择器那一半状态留在详情域，拼装在入口）
* `/api/workbench/settings` 两处（`saveIncludeOverdue` / `saveDailyCapacity`）→
  `src/client/hooks/useWorkbenchSettings.ts`

出口口径：WorkbenchApp 体内 **`api(` = 0**（ADR-0008 结构硬门最后一项清零）；
把结果接到别的域的状态一律以注入回调进域 hook（`onTaskCreated` / `onSubtaskParentCleared` /
`onTaskRestored`），"接哪几个域"留在装配层。

八节：① 入口不再有本批搬走的声明 ② 唯一所有者 ③ HTTP 归属与纯度 ④ 跨域注入
⑤ 落点顺序 ⑥ 刻意留在装配层的原文还在 ⑦ 结构指纹 ⑧ ADR-0008 硬门 + 度量与顶层块表。
"""

from __future__ import annotations

import glob
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
os.chdir(ROOT)

INDEX_PATH = os.path.join("src", "client", "index.tsx")
TASK_DATA_HOOK_PATH = os.path.normpath(os.path.join("src", "client", "hooks", "useTaskData.ts"))
SETTINGS_HOOK_PATH = os.path.normpath(os.path.join("src", "client", "hooks", "useWorkbenchSettings.ts"))

failures: list[str] = []
checks = 0


def load(p: str) -> str:
    with open(p, encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


def strip_comments(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r"^[ \t]*//.*$", "", s, flags=re.M)
    return s


def check(ok: bool, message: str) -> None:
    global checks
    checks += 1
    if ok:
        print(f"  \u2714 {message}")
    else:
        print(f"  \u2716 {message}")
        failures.append(message)


def bare(src: str, name: str, origin: str) -> int:
    """裸名在（已剥注释的）src 里的命中数：不算 `a.name` 这类成员访问，也不算对象字面量的键。"""
    return len(re.findall(r"(?<![\w.])" + re.escape(name) + r"\b(?!\s*:)", src))


def defs_of(src: str, name: str) -> int:
    """`const name = …` / `function name(…)` 形式的**定义**处数（允许行首缩进）。"""
    return len(re.findall(r"^[ \t]*(?:const|function)\s+" + re.escape(name) + r"\b", src, re.M))


def client_sources() -> list[str]:
    pats = ["src/client/**/*.ts", "src/client/**/*.tsx"]
    out: list[str] = []
    for pat in pats:
        out.extend(glob.glob(pat, recursive=True))
    return sorted({os.path.normpath(p) for p in out if os.path.isfile(p)})


SOURCES = {p: load(p) for p in client_sources()}
STRIPPED = {p: strip_comments(s) for p, s in SOURCES.items()}
INDEX = SOURCES[os.path.normpath(INDEX_PATH)]
INDEX_BARE = STRIPPED[os.path.normpath(INDEX_PATH)]
TASK_DATA = SOURCES[TASK_DATA_HOOK_PATH]
TASK_DATA_BARE = STRIPPED[TASK_DATA_HOOK_PATH]
SETTINGS = SOURCES[SETTINGS_HOOK_PATH]
SETTINGS_BARE = STRIPPED[SETTINGS_HOOK_PATH]
# D17/P7-2 起 JSX 分四段搬进 src/client/app/ —— 视图装配层的调用点原文都在那里。
UI_PATHS = [
    os.path.normpath(os.path.join("src", "client", "app", n))
    for n in ("WorkbenchHeader.tsx", "WorkbenchOverlays.tsx", "WorkbenchBody.tsx", "WorkbenchDialogs.tsx")
]
UI = {p: STRIPPED[p] for p in UI_PATHS if p in STRIPPED}


def in_ui(snippet: str) -> bool:
    return any(snippet in s for s in UI.values())


def owners_of(snippet: str) -> list[str]:
    """哪些客户端源文件里有这段原文（剥注释后）。"""
    return sorted(p for p, s in STRIPPED.items() if snippet in s)


def app_body() -> str | None:
    """按大括号配对找 `function WorkbenchApp(` 的函数体（含首尾行）。"""
    lines = INDEX.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    start = None
    for i, l in enumerate(lines):
        if re.match(r"^(export )?function WorkbenchApp\(", l):
            start = i
            break
    if start is None:
        return None
    depth = 0
    for j in range(start, len(lines)):
        depth += lines[j].count("{") - lines[j].count("}")
        if j > start and depth == 0:
            return "\n".join(lines[start:j + 1])
    return None


# ---------------------------------------------------------------- §1 入口不再有本批搬走的声明
print("=" * 78)
print("D17 / P7-1 出口自检（入口最后 6 处 api 归域）")
print("=" * 78)

print("\n§1 入口不再有本批搬走的声明（含行首缩进，函数体内的缩进定义也要算上）")

MOVED = {
    "archiveSelectedTask": "任务归档（整条用例）",
    "createTask": "新建任务（POST /api/workbench/tasks）",
    "createSubtask": "新建子任务（POST /api/workbench/tasks）",
    "restoreTask": "恢复任务（POST /tasks/:id/restore）",
    "saveIncludeOverdue": "容量口径开关（POST /settings）",
}
for name, what in MOVED.items():
    check(defs_of(INDEX_BARE, name) == 0, f"入口不再定义 {name}（{what}）")

check(defs_of(INDEX_BARE, "linkExistingSession") == 1,
      "`linkExistingSession` 仍在入口（它只是把请求委托出去，会话选择器状态属详情域）")
check(defs_of(INDEX_BARE, "saveDailyCapacity") == 1,
      "`saveDailyCapacity` 仍在入口 —— 只留「读容量编辑态 + 清编辑态」那半边，请求本体归设置域")

# ---------------------------------------------------------------- §2 唯一所有者
print("\n§2 唯一所有者（完整原文 / 路由字面量，owners_of 必须恰好一处）")

OWNED = {
    "const linkSessionRequest = async (taskId: string, sessionId: string, roleCode: string): Promise<void> => {": TASK_DATA_HOOK_PATH,
    "const archiveSelectedTask = (): void => {": TASK_DATA_HOOK_PATH,
    "const restoreTask = (taskId: string): void => {": TASK_DATA_HOOK_PATH,
    "const createTask = async (form: FormData): Promise<void> => {": TASK_DATA_HOOK_PATH,
    "const createSubtask = (form: FormData, parent: Task): void => {": TASK_DATA_HOOK_PATH,
    "const saveIncludeOverdue = async (next: boolean): Promise<void> => {": SETTINGS_HOOK_PATH,
    "const saveDailyCapacity = async (rawEdit: string): Promise<void> => {": SETTINGS_HOOK_PATH,
}
for snippet, home in OWNED.items():
    owners = owners_of(snippet)
    check(owners == [home], f"唯一所有者：{snippet[:52]} → {home}（实测 {owners}）")

# 路由字面量：这几条只该出现在本批的域 hook 里
ROUTES = {
    "`/api/workbench/tasks/${id}/archive`": TASK_DATA_HOOK_PATH,
    "`/api/workbench/tasks/${taskId}/restore`": TASK_DATA_HOOK_PATH,
    "`/api/workbench/tasks/${taskId}/sessions`": TASK_DATA_HOOK_PATH,
    "'/api/workbench/tasks'": TASK_DATA_HOOK_PATH,
}
for snippet, home in ROUTES.items():
    owners = owners_of(snippet)
    check(owners == [home], f"路由只在域 hook 里：{snippet[:46]}（实测 {owners}）")

# `/api/workbench/settings` 本来就有三个合法 owner（设置域 + 快速录入域的记住工作区 + 角色后台），
# 所以这里不宣"唯一"，只守本批的边界：入口 0 处、设置域 ≥3 处（GET 一次 + POST 三处）。
check(SETTINGS.count("'/api/workbench/settings'") >= 3
      and "'/api/workbench/settings'" not in INDEX_BARE,
      f"settings 端点的 owner 是设置域（实测 hook {SETTINGS.count(chr(39) + '/api/workbench/settings' + chr(39))} 处 / 入口 0 处）")

check("linkSessionRequest" in TASK_DATA_BARE, "请求原语 `linkSessionRequest` 在任务数据域")
check("linkSessionRequest(" in INDEX_BARE, "入口把 linkSessionRequest 接到会话选择器上")
for name in ("createTask", "createSubtask", "restoreTask", "archiveSelectedTask"):
    check(bare(TASK_DATA_BARE, name, "HOOK") >= 1, f"任务数据域 hook 里有 {name}")
    check(bare(TASK_DATA_BARE, name, "HOOK") <= 3, f"任务数据域 hook 里 {name} 只出现在声明/导出/注入处")

check("saveIncludeOverdue" in SETTINGS_BARE and "saveDailyCapacity" in SETTINGS_BARE,
      "设置域 hook 有 saveIncludeOverdue / saveDailyCapacity 两个动作")

# ---------------------------------------------------------------- §3 HTTP 归属与纯度
print("\n§3 HTTP 归属与纯度")

check("fetch(" not in TASK_DATA_BARE, "任务数据域 hook 不用原生 fetch（统一走 api）")
check("fetch(" not in SETTINGS_BARE, "设置域 hook 不用原生 fetch（统一走 api）")
check("setInterval(" not in TASK_DATA_BARE and "setTimeout(" not in TASK_DATA_BARE,
      "任务数据域 hook 里没有定时器")
check("setInterval(" not in SETTINGS_BARE and "setTimeout(" not in SETTINGS_BARE,
      "设置域 hook 里没有定时器")
check("window.confirm(" in TASK_DATA_BARE,
      "归档确认的 `window.confirm` 随整条用例进域（本 hook 早有 completeTaskFromProgress 的同类口径）")
check("not found" in TASK_DATA_BARE, "归档的 not-found 自愈分支仍在（搬的是整条用例，不是只搬请求）")

for route in ["/api/workbench/tasks/${id}/archive", "/api/workbench/tasks/${taskId}/restore",
              "/api/workbench/tasks/${taskId}/sessions", "/api/workbench/settings"]:
    check(route not in INDEX_BARE, f"入口不再出现请求路径字面量：{route}")

# ---------------------------------------------------------------- §4 跨域注入
print("\n§4 跨域注入（「接哪几个域」留在装配层，域 hook 只收回调）")

INJECTED = {
    "onTaskCreated: () => forms.actions.closeCreate()": "新建成功后关表单",
    "onSubtaskParentCleared: () => forms.actions.setSubtaskParent(null)": "建完子任务清父任务指针",
    "onTaskRestored: () => taskList.actions.setArchivedMode(false)": "恢复后自动退出归档视图",
}
for snippet, what in INJECTED.items():
    check(INDEX_BARE.count(snippet) == 1, f"注入回调（{what}）：{snippet}")
    check(snippet not in TASK_DATA_BARE, f"域 hook 不自己写这个跨域动作：{snippet[:44]}")

check("export type UseTaskDataInput = {" in TASK_DATA_BARE
      and "onTaskCreated" in TASK_DATA_BARE
      and "onTaskRestored" in TASK_DATA_BARE,
      "useTaskData 的入参类型声明了三个新回调")
check("saveDailyCapacity: saveDailyCapacitySetting" in INDEX_BARE,
      "入口把设置域动作改名解构（避免与装配层那半边同名）")

# ---------------------------------------------------------------- §5 落点顺序
print("\n§5 落点顺序")

i_data = INDEX_BARE.find("const data = useTaskData({")
i_link = INDEX_BARE.find("await linkSessionRequest(")
i_assembly = INDEX_BARE.find("const assembly: WorkbenchAssembly = {")
check(i_data > 0 and i_link > 0 and i_assembly > 0,
      "三个关键调用点都找得到（顺序断言的前提）")
check(0 < i_data < i_link, "调用顺序：`data = useTaskData` → `linkSessionRequest`（后者来自前者）")
check(i_data < i_assembly, "调用顺序：`data = useTaskData` → 装配束 `assembly`（域结果先就位再捆）")

# ---------------------------------------------------------------- §6 留在装配层的原文还在
print("\n§6 刻意留在装配层的原文（逐条原文核对）")

KEPT_INDEX = [
    "await linkSessionRequest(taskId, sessionId, sessionPickerRole)",
]
for snippet in KEPT_INDEX:
    check(snippet in INDEX_BARE, f"入口原文未动：{snippet}")

# P7-2 把四段 JSX 搬进 src/client/app/ —— 这几条调用点跟着 owner 走（正向指新家）。
KEPT_UI = {
    "onSubmit={createTask}": "新建任务弹窗的提交口",
    "onRestoreTask={restoreTask}": "归档列表的「恢复」口",
    "onCreateSubtask={createSubtask}": "详情页的「加子任务」口",
    "archiveSelectedTask={archiveSelectedTask}": "详情页的「归档」口",
}
for snippet, what in KEPT_UI.items():
    check(in_ui(snippet), f"视图装配层仍有 {what}：{snippet}")

check("const raw = day.capacityEdit === null ? '' : day.capacityEdit.trim()" in INDEX_BARE,
      "容量保存那半边仍在装配层（读的是日期域的编辑态）")
check("day.actions.setCapacityEdit(null)" in INDEX_BARE,
      "容量保存后清编辑态仍在装配层")
check("await saveDailyCapacitySetting(raw)" in INDEX_BARE,
      "容量保存的请求本体以设置域动作注入")

# ---------------------------------------------------------------- §7 结构指纹
print("\n§7 结构指纹")

check("import { useTaskData } from './hooks/useTaskData.js'" in INDEX,
      "入口 import 任务数据域 hook（顶层，路径 .js）")
check("import { useWorkbenchSettings } from './hooks/useWorkbenchSettings.js'" in INDEX,
      "入口 import 设置域 hook（顶层，路径 .js）")
for comment, least in [("P7-1", 3)]:
    check(INDEX.count(comment) >= least,
          f"入口保留了指针注释：{comment}（{INDEX.count(comment)} 处）")

# ---------------------------------------------------------------- §8 ADR-0008 硬门 + 度量
print("\n§8 ADR-0008 结构硬门（本批解锁：体内 api = 0）与度量快照")

body = app_body()
check(body is not None, "WorkbenchApp 函数体可定位（大括号配对）")
if body is not None:
    body_lines = len(body.split("\n"))
    body_bare = strip_comments(body)
    check(200 < body_lines < 3500, f"取到的是真正的函数体（{body_lines} 行）")
    api_hits = len(re.findall(r"\bapi[<(]", body_bare))
    state_hits = len(re.findall(r"useState[<(]", body_bare))
    check(api_hits == 0, f"WorkbenchApp 体内零 `api(`（本批清零，实测 {api_hits}）")
    check(state_hits == 0, f"WorkbenchApp 体内零 `useState(`（P6 已清零，实测 {state_hits}）")
    check("/api/workbench" not in body_bare,
          f"WorkbenchApp 体内零 `/api/workbench` 字面量（剥注释后实测 {body_bare.count('/api/workbench')}）")
    check(body_bare.count("setInterval(") == 0 and body_bare.count("setTimeout(") == 0,
          "WorkbenchApp 体内零定时器")
    check(body_bare.count("fetch(") == 0, "WorkbenchApp 体内零原生 `fetch(`")
    check(body_bare.count("useEffect(") == 3,
          f"WorkbenchApp 体内 useEffect 仍是 3 条（实测 {body_bare.count('useEffect(')}）")

    print(f"     ℹ 度量：WorkbenchApp {body_lines} 行；useState 声明 "
          f"{len(re.findall(r'const \[[^]]+\] = useState[<(]', body_bare))} 项；"
          f"api 调用 {api_hits} 处；useEffect {body_bare.count('useEffect(')} 条")

    # 顶层块表（ADR-0008 的"单个顶层块 ≤80 行"是 P7 收尾口的判据；
    # 本批只报告，供 P7-2 的 JSX 收口定范围 —— 报告口径按"下一个顶层声明的行号差"。
    starts = [(m.start(), m.group(1).strip()) for m in
              re.finditer(r"^  (const [A-Za-z_$][\w$]*|function [A-Za-z_$][\w$]*|return \()", body, re.M)]
    if starts:
        line_of = lambda pos: body.count("\n", 0, pos) + 1
        table = []
        for idx, (pos, name) in enumerate(starts):
            end = line_of(starts[idx + 1][0]) if idx + 1 < len(starts) else body_lines
            table.append((line_of(pos), end - line_of(pos), name))
        over = [t for t in table if t[1] > 80]
        print(f"     ℹ 顶层块 {len(table)} 个，其中 >80 行的 {len(over)} 个：")
        for ln, size, name in sorted(over, key=lambda t: -t[1])[:12]:
            print(f"        L{ln:>5}  {size:>4} 行  {name[:46]}")

check(INDEX.count("setInterval(") == 1 and "const titlebarTimer = setInterval(() => {" in INDEX,
      "入口整份文件只剩 1 个 setInterval（插件 setup 作用域里的 titlebarTimer，不属 WorkbenchApp）")
check(INDEX.count("setTimeout(") == 0, "入口整份文件零 setTimeout")

print("\n" + "=" * 78)
if failures:
    print(f"✖ {len(failures)} / {checks} 项未通过")
    for f in failures:
        print(f"   - {f}")
    sys.exit(1)
print(f"✔ 全部 {checks} 项通过")
sys.exit(0)
