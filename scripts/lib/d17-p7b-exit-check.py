"""D17 / P7-2（四段 JSX 搬进 src/client/app/）出口自检 —— 只做文本核对，行为以 typecheck / pnpm test 为准。

本批把入口 `WorkbenchApp` 里那一整块 676 行的 `return (...)` 按**渲染位置**切成四段，
逐字搬进 `src/client/app/`：

* 顶栏 `WorkbenchHeader.tsx`（五视图页签 / 收起全部 / 设置 / 关面板）
* 提示层 `WorkbenchOverlays.tsx`（共享提示词弹窗 / 到期提醒 / DraftBanner / 重复任务提示）
* 主体 `WorkbenchBody.tsx`（左导航五视图分派 + 右详情三分派 + SettingsModal）
* 弹窗 `WorkbenchDialogs.tsx`（快速录入 / 新建 / 编辑 / 工作区目录浏览）

四段共用同一束 `WorkbenchAssembly`（`app/assembly.ts`）：域的**结果**整束注入，
每个组件只解构自己用到的字段 —— 组件文件头那段 `const { … } = props.xxx` 就是它的依赖声明。
刻意没有 Context / 全局 store / 把 setter 传下去（设计 §4/§5）。

出口口径（ADR-0008）：`WorkbenchApp` 结构硬门 5 项全 0（体内 `useState(` / `api(` / 原生 `fetch(` /
`/api/workbench` 字面量 / 定时器）＋ **单个顶层块 ≤80 行**（本批解锁：原唯一违例 `return (` 676 行消失）
＋ 行数护栏 ≤900。

八节：① 入口 JSX 收口 ② 四段组件与装配束的唯一所有者 ③ 组件纯度 ④ 依赖方向
⑤ 四段顺序 = 搬迁前 DOM 顺序 ⑥ 留在装配层的原文还在 ⑦ 结构指纹 ⑧ ADR-0008 硬门 + 度量与顶层块表。
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
APP = os.path.join("src", "client", "app")
ASSEMBLY_PATH = os.path.normpath(os.path.join(APP, "assembly.ts"))
UI_FILES = {
    "header": os.path.normpath(os.path.join(APP, "WorkbenchHeader.tsx")),
    "overlays": os.path.normpath(os.path.join(APP, "WorkbenchOverlays.tsx")),
    "body": os.path.normpath(os.path.join(APP, "WorkbenchBody.tsx")),
    "dialogs": os.path.normpath(os.path.join(APP, "WorkbenchDialogs.tsx")),
}

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
ASSEMBLY = SOURCES[ASSEMBLY_PATH]
UI = {k: SOURCES[p] for k, p in UI_FILES.items()}
UI_BARE = {k: STRIPPED[p] for k, p in UI_FILES.items()}
UI_ALL = "\n".join(UI_BARE.values())


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


print("=" * 78)
print("D17 / P7-2 出口自检（四段 JSX 搬进 src/client/app/）")
print("=" * 78)

# ---------------------------------------------------------------- §1 入口 JSX 收口
print("\n§1 入口 JSX 收口（676 行的 return 只留 5 行装配）")

check("const assembly: WorkbenchAssembly = {" in INDEX_BARE,
      "入口把域结果捆成一束 WorkbenchAssembly（装配层只剩这一件事）")
for key, tag in [("header", "WorkbenchHeader"), ("overlays", "WorkbenchOverlays"),
                 ("body", "WorkbenchBody"), ("dialogs", "WorkbenchDialogs")]:
    check(f"<{tag} {{...assembly}} />" in INDEX_BARE,
          f"入口按渲染位置装配 <{tag} {{...assembly}} />")

body = app_body()
check(body is not None, "WorkbenchApp 函数体可定位（大括号配对）")

# 体内 JSX 标签只剩 5 个（四段 + ToastHost）。只看 `return (` 之后那一段 ——
# 函数体前半是 TypeScript，`useRef<StartAISessionFn | null>` 这类泛型会被当成标签误计。
body_tags: list[str] = []
if body is not None:
    tail = body[body.rfind("  return ("):]
    body_tags = re.findall(r"<[A-Z][A-Za-z0-9]*[\s/>]", strip_comments(tail))
    body_tags = [t[:-1] for t in body_tags]
    check(len(body_tags) == 5 and sorted(body_tags) == sorted(
        ["<WorkbenchHeader", "<WorkbenchOverlays", "<WorkbenchBody", "<WorkbenchDialogs", "<ToastHost"]),
        f"return 块里只剩 5 个组件标签（四段 + ToastHost），实测 {sorted(body_tags)}")

# 本批搬走的 JSX 锚点，入口剥注释后必须一处都不剩。
MOVED_JSX = ["<TodayPane", "<CalendarView", "<TaskListView", "<TaskDetailPane", "<IdeasListView",
             "<IdeasDetailPane", "<KnowledgeListView", "<KnowledgeDetailPane", "<SettingsModal",
             "<TaskCreateModal", "<TaskEditModal", "<LocalDocModal", "<WorkspacePicker",
             "<PersonaPicker", "<SkillPicker", "<ModelPicker", "<DraftBanner", "<Modal",
             "{promptModal !== null && (", "{showSettings && (", "{showQuick && ("]
for snippet in MOVED_JSX:
    hits = INDEX_BARE.count(snippet)
    check(hits == 0, f"入口剥注释后不再有 {snippet}（实测 {hits}）")

# 搬走的是 JSX，不是语义：四段仍在装配层（正向，防止"删掉了事"）。
KEPT_IN_UI = [
    ("body", "<TodayPane"),
    ("body", "<TaskDetailPane"),
    ("dialogs", "<TaskCreateModal"),
    ("dialogs", "<TaskEditModal"),
    ("dialogs", "<LocalDocModal"),
    ("overlays", "<DraftBanner"),
    ("overlays", "{promptModal !== null && ("),
]
for key, snippet in KEPT_IN_UI:
    check(snippet in UI_BARE[key], f"搬走的 JSX 真的落在 app/{os.path.basename(UI_FILES[key])}：{snippet}")

# ---------------------------------------------------------------- §2 唯一所有者
print("\n§2 四段组件与装配束的唯一所有者")

DECLS = {
    "header": "export function WorkbenchHeader(props: WorkbenchAssembly): JSX.Element {",
    "overlays": "export function WorkbenchOverlays(props: WorkbenchAssembly): JSX.Element {",
    "body": "export function WorkbenchBody(props: WorkbenchAssembly): JSX.Element {",
    "dialogs": "export function WorkbenchDialogs(props: WorkbenchAssembly): JSX.Element {",
}
for key, decl in DECLS.items():
    check(decl in UI_BARE[key], f"app/{os.path.basename(UI_FILES[key])} 导出 {decl.split('(')[0].split()[-1]}")
    check(owners_of(decl) == [UI_FILES[key]],
          f"{decl.split('(')[0].split()[-1]} 只有一个 owner（实际：{owners_of(decl)}）")
    check(decl not in INDEX_BARE, "入口不再有第二份定义")

check("export interface WorkbenchAssembly {" in ASSEMBLY, "装配束类型在 app/assembly.ts")
check(owners_of("export interface WorkbenchAssembly {") == [ASSEMBLY_PATH],
      f"装配束类型只有一个 owner（实际：{owners_of('export interface WorkbenchAssembly {')}）")
check(INDEX.count("import type { WorkbenchAssembly } from './app/assembly.js'") == 1,
      "入口只以 type import 引装配束（类型不进运行时）")
for key in UI_FILES:
    check("import type { WorkbenchAssembly } from './assembly.js'" in UI[key],
          f"app/{os.path.basename(UI_FILES[key])} 从 ./assembly.js 取类型")

# ---------------------------------------------------------------- §3 组件纯度
print("\n§3 四段组件是纯展示：不自持状态、不发请求、不 import 入口/域 hook")

for key, path in UI_FILES.items():
    src = UI_BARE[key]
    name = os.path.basename(path)
    check(not re.search(r"\buseState[<(]", src), f"{name} 里无 useState")
    check(not re.search(r"\buseEffect\s*\(", src), f"{name} 里无 useEffect")
    check(not re.search(r"\bapi\s*<|\bapi\(", src), f"{name} 里无 api 请求")
    check("fetch(" not in src, f"{name} 里无原生 fetch(")
    check("setInterval(" not in src and "setTimeout(" not in src, f"{name} 里无定时器")
    check(not re.search(r"from '(\.\./)+index", src), f"{name} 不 import 入口")
    check("from '../hooks/" not in src, f"{name} 不 import 域 hook（域只经装配束进来）")
    check("props.actions" not in src, f"{name} 不直接拿域 hook 的 actions（只解构注入的动作）")

# ---------------------------------------------------------------- §4 依赖方向
print("\n§4 依赖方向（设计 §4：views/ 在下游，app/ 在上游）")

for path, src in STRIPPED.items():
    if os.sep + "views" + os.sep in path or os.sep + "hooks" + os.sep in path:
        # 只有**类型模块**可以反向 import：`app/contracts.ts` 是纯类型（P3-2 起就是这条约定）。
        # 组件与装配束（app/Workbench*.tsx、app/assembly.ts）不许被下游 import。
        for bad in ("from '../app/Workbench", "from '../app/assembly",
                    "from './app/Workbench", "from './app/assembly"):
            check(bad not in src, f"{os.path.basename(path)} 不反向 import app/ 的运行时模块（{bad}）")

# ---------------------------------------------------------------- §5 四段顺序
print("\n§5 四段顺序 = 搬迁前 DOM 顺序（弹窗两段刻意留在原地，不改层叠/焦点顺序）")

if body is not None:
    order = [body.find("<WorkbenchHeader"), body.find("<WorkbenchOverlays"),
             body.find("<WorkbenchBody"), body.find("<WorkbenchDialogs"), body.find("<ToastHost")]
    check(all(i > 0 for i in order) and order == sorted(order),
          f"渲染顺序 Header → Overlays → Body → Dialogs → ToastHost（实测 {order}）")

# ---------------------------------------------------------------- §6 留在装配层的原文
print("\n§6 刻意留在装配层的原文还在（本批只搬 JSX）")

KEPT = [
    "const collapseAll = (): void => {",
    "const openQuickEntry = (): void => {",
    "const openDirPicker = (target: 'quick' | 'form' | 'edit'): void => {",
    "const applyWorkspaceDir = (dirPath: string): void => {",
    "const saveEditDraft = async (): Promise<void> => {",
    "const saveDailyCapacity = async (): Promise<void> => {",
    "const linkExistingSession = async (sessionId: string): Promise<void> => {",
    "const dayPanelProps = {",
]
for snippet in KEPT:
    check(snippet in INDEX_BARE, f"仍在装配层：{snippet}")

# ---------------------------------------------------------------- §7 结构指纹
print("\n§7 结构指纹")

check("import { WorkbenchHeader } from './app/WorkbenchHeader.js'" in INDEX,
      "入口 import 四段组件（顶层，路径 .js）")
for tag in ["WorkbenchOverlays", "WorkbenchBody", "WorkbenchDialogs"]:
    check(f"import {{ {tag} }} from './app/{tag}.js'" in INDEX, f"入口 import {tag}")
check(INDEX.count("P7-2") >= 1, f"入口保留了指针注释：P7-2（{INDEX.count('P7-2')} 处）")
for key, path in UI_FILES.items():
    n = len(UI[key].split("\n"))
    check(0 < n < 500, f"app/{os.path.basename(path)} 行数合理（{n} 行）{'' if n < 500 else '（超过 500，说明又长回去了）'}")

# ---------------------------------------------------------------- §8 ADR-0008 硬门 + 度量
print("\n§8 ADR-0008 结构硬门（本批解锁：单个顶层块 ≤80 行）与度量快照")

if body is not None:
    body_lines = len(body.split("\n"))
    body_bare = strip_comments(body)
    check(200 < body_lines < 3500, f"取到的是真正的函数体（{body_lines} 行）")
    check(len(re.findall(r"\bapi[<(]", body_bare)) == 0,
          f"体内零 `api(`（实测 {len(re.findall(r'\\bapi[<(]', body_bare))}）")
    check(len(re.findall(r"useState[<(]", body_bare)) == 0,
          f"体内零 `useState(`（实测 {len(re.findall(r'useState[<(]', body_bare))}）")
    check("/api/workbench" not in body_bare, "体内零 `/api/workbench` 字面量")
    check(body_bare.count("setInterval(") == 0 and body_bare.count("setTimeout(") == 0,
          "体内零定时器")
    check(body_bare.count("fetch(") == 0, "体内零原生 `fetch(`")
    check(body_bare.count("useEffect(") == 3,
          f"体内 useEffect 仍是 3 条（实测 {body_bare.count('useEffect(')}）")
    # ADR-0008 护栏：原值 ≤900，且「护栏值在 P6 收尾后按实测校准一次」。
    # D17/P7 收尾实测 **631** 行 ⇒ **校准为 ≤650**：既把这一批的收益锁住
    #（P7-2 起点 1325 → 搬完 JSX 673 → P7-3 清死解构 631），又留 19 行余量给后续批次。
    # ≤600 仍是 ADR 里的**努力目标**（不是门）：631 的构成分解见 docs/tasks/…-D17客户端拆分/verification.md 的 P7 节。
    check(body_lines <= 650,
          f"行数护栏（ADR-0008 校准后）：WorkbenchApp ≤650（实测 {body_lines}；ADR 原值 ≤900）")
    check(body_lines <= 900, f"行数护栏：WorkbenchApp ≤900（ADR 原值，实测 {body_lines}）")
    print(f"     ℹ 努力目标 ≤600：{'达成' if body_lines <= 600 else f'未达成（还差 {body_lines - 600} 行）'}")

    # 顶层块表（ADR-0008「单个顶层块 ≤80 行」）—— 报告口径按"下一个顶层声明的行号差"。
    starts = [(m.start(), m.group(1).strip()) for m in
              re.finditer(r"^  (const [A-Za-z_$][\w$]*|function [A-Za-z_$][\w$]*|return \()", body, re.M)]
    if starts:
        line_of = lambda pos: body.count("\n", 0, pos) + 1
        table = []
        for idx, (pos, name) in enumerate(starts):
            end = line_of(starts[idx + 1][0]) if idx + 1 < len(starts) else body_lines
            table.append((line_of(pos), end - line_of(pos), name))
        over = [t for t in table if t[1] > 80]
        check(len(over) == 0, f"单个顶层块 ≤80 行：{len(table)} 个块，超限 {len(over)} 个")
        if over:
            for ln, size, name in sorted(over, key=lambda t: -t[1])[:12]:
                print(f"        L{ln:>5}  {size:>4} 行  {name[:46]}")
        biggest = sorted(table, key=lambda t: -t[1])[:5]
        print(f"     ℹ 最大的 5 个顶层块：" + "；".join(f"{size} 行 {name[:26]}" for _, size, name in biggest))

check(INDEX.count("setInterval(") == 1 and "const titlebarTimer = setInterval(() => {" in INDEX,
      "入口整份文件只剩 1 个 setInterval（插件 setup 作用域里的 titlebarTimer）")
check(INDEX.count("setTimeout(") == 0, "入口整份文件零 setTimeout")

def _nlines(text: str) -> int:
    """行数口径与 `(Get-Content f).Count` 一致：结尾换行不算一行。"""
    parts = text.split("\n")
    if parts and parts[-1] == "":
        parts.pop()
    return len(parts)


ws_lines = _nlines(INDEX)
print(f"     ℹ 度量：src/client/index.tsx {ws_lines} 行；WorkbenchApp "
      f"{_nlines(body) if body is not None else -1} 行；四段组件 "
      + "、".join(f"{os.path.basename(p)} {_nlines(UI[k])}" for k, p in UI_FILES.items()))

# ---------------------------------------------------------------- 汇总
print("\n" + "=" * 78)
if failures:
    print(f"✖ {len(failures)} / {checks} 项未通过")
    for f in failures:
        print(f"   - {f}")
    sys.exit(1)
print(f"✔ 全部 {checks} 项通过")
