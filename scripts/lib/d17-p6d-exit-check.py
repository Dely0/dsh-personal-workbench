# -*- coding: utf-8 -*-
"""D17 / P6-4 出口自检：目录选择域（DirectoryPicker）——**P6 最后一批**。

本批把 `src/client/index.tsx` 里 5 项弹窗 state 与 `loadDirPickerDir` 搬进
`src/client/hooks/useWorkbenchDirectoryPicker.ts`，并加一个 `openFor(target, start)`
动作（= 原来的 setTarget + setPath + 立刻列一次）。

**刻意留在装配层的两件事**（都是"跨域"，搬进去会造成反向依赖）：
  * `openDirPicker(target)`：起始目录来自三个入口的当前值（快速录入域 / 任务表单域 / 编辑草稿）；
  * `applyWorkspaceDir(dirPath)`：唯一分派点，按 `dirPickerTarget` 写回 quick / form / edit 三个域。

判据口径（设计文档 §8，与 P1–P5 一致）：
  * 正向断言指向**真实 owner**（搬到哪就指哪）；
  * 负向唯一性断言**递归覆盖整个 src/client**（只查旧入口会空洞通过）；
  * 单一所有者的比对用**完整声明原文**（松正则会撞上别的域的同名声明）。

用法：python scripts/lib/d17-p6d-exit-check.py
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
HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchDirectoryPicker.ts")
AI_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchAISessions.ts")
QUICK_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchQuickIntake.ts")
NAV_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchNavigation.ts")
BUSY_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchBusy.ts")
LOCAL_DIR_MODULE = os.path.join("src", "client", "localDirBrowser.ts")

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

failures: list[str] = []
checks = 0


def load(path: str) -> str:
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read().replace("\r\n", "\n")


def strip_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    source = re.sub(r"^[ \t]*//.*$", "", source, flags=re.M)
    return source


def check(ok: bool, message: str) -> None:
    global checks
    checks += 1
    if ok:
        print(f"  \u2714 {message}")
    else:
        print(f"  \u2716 {message}")
        failures.append(message)


def bare(source: str, name: str) -> int:
    """某个名字在源码里出现几次（不算对象字面量的键、不算属性访问）。"""
    return len(re.findall(r"(?<![\w.])" + re.escape(name) + r"\b(?!\s*:)", source))


def defs_of(source: str, name: str) -> int:
    """顶层/带缩进的 `const name` / `function name` 声明数（行首空白也算）。"""
    return len(re.findall(r"^[ \t]*(?:const|function)\s+" + re.escape(name) + r"\b", source, re.M))


def client_sources() -> list[str]:
    found = glob.glob("src/client/**/*.ts", recursive=True) + glob.glob("src/client/**/*.tsx", recursive=True)
    return sorted({os.path.normpath(p) for p in found if os.path.isfile(p)})


SOURCES = {p: load(p) for p in client_sources()}
STRIPPED = {p: strip_comments(s) for p, s in SOURCES.items()}
INDEX = SOURCES.get(INDEX_PATH, "")
INDEX_BARE = STRIPPED.get(INDEX_PATH, "")
HOOK = SOURCES.get(HOOK_PATH, "")
HOOK_BARE = STRIPPED.get(HOOK_PATH, "")


def owners_of(snippet: str) -> list[str]:
    """哪些客户端源码（剥注释后）含这段原文 —— 唯一所有者断言就靠它。"""
    return sorted(p for p, s in STRIPPED.items() if snippet in s)


def app_body() -> str:
    lines = INDEX.split("\n")
    start = None
    for i, line in enumerate(lines):
        if re.match(r"^function WorkbenchApp\(", line):
            start = i
            break
    if start is None:
        return ""
    depth = 0
    out: list[str] = []
    for line in lines[start:]:
        out.append(line)
        depth += line.count("{") - line.count("}")
        if depth == 0 and len(out) > 1:
            break
    return "\n".join(out)


print("=" * 78)
print("D17 / P6-4 出口自检：目录选择域（DirectoryPicker）")
print("=" * 78)

# ---------------------------------------------------------------- §1 入口不再自建本域任何东西
print("\n§1 入口不再自建目录选择域任何东西")
check(os.path.isfile(HOOK_PATH), f"{HOOK_PATH} 存在")

STATE_DECLARATIONS = [
    "const [dirPickerTarget, setDirPickerTarget] = useState<DirectoryPickerTarget | null>(null)",
    "const [dirPickerPath, setDirPickerPath] = useState('')",
    "const [dirPickerListing, setDirPickerListing] = useState<LocalDirListing | null>(null)",
    "const [dirPickerLoading, setDirPickerLoading] = useState(false)",
    "const [dirPickerError, setDirPickerError] = useState<string | null>(null)",
]
for declaration in STATE_DECLARATIONS:
    # 入口搬迁前的原文用 `useState<null | 'quick' | 'form' | 'edit'>`，hook 里换成了命名类型
    check(declaration not in INDEX_BARE, f"入口不再有该 state 声明：{declaration[:56]}…")
    check(declaration in HOOK_BARE, f"该 state 在新 owner 里：{declaration[:56]}…")

for old_form in [
    "const [dirPickerTarget, setDirPickerTarget] = useState<null | 'quick' | 'form' | 'edit'>(null)",
    "const loadDirPickerDir = async (path?: string | null): Promise<void> => {",
    "await api<LocalDirListing>(localDirRequestUrl(path))",
    "setDirPickerListing(res)",
]:
    check(old_form not in INDEX_BARE, f"入口连旧形态都没有了：{old_form[:56]}…")
check("const loadDirPickerDir = async (path?: string | null): Promise<void> => {" in HOOK_BARE,
      "列目录的本体在新 owner 里")
check("const res = await api<LocalDirListing>(localDirRequestUrl(path))" in HOOK_BARE,
      "请求那一行逐字搬走（请求形状仍来自纯模块）")

for name in ["dirPickerTarget", "dirPickerPath", "dirPickerListing", "dirPickerLoading", "dirPickerError", "loadDirPickerDir"]:
    check(defs_of(INDEX_BARE, name) == 0, f"入口没有第二份定义：{name}")

# ---------------------------------------------------------------- §2 唯一所有者（全客户端递归）
print("\n§2 唯一所有者（递归覆盖整个 src/client）")
UNIQUE = [
    ("const [dirPickerTarget, setDirPickerTarget] = useState<DirectoryPickerTarget | null>(null)", HOOK_PATH, "弹窗来源"),
    ("const [dirPickerPath, setDirPickerPath] = useState('')", HOOK_PATH, "当前路径"),
    ("const [dirPickerListing, setDirPickerListing] = useState<LocalDirListing | null>(null)", HOOK_PATH, "当前列目录结果"),
    ("const [dirPickerLoading, setDirPickerLoading] = useState(false)", HOOK_PATH, "加载标志"),
    ("const [dirPickerError, setDirPickerError] = useState<string | null>(null)", HOOK_PATH, "就地错误"),
    ("const loadDirPickerDir = async (path?: string | null): Promise<void> => {", HOOK_PATH, "列目录"),
    ("export type DirectoryPickerTarget = 'quick' | 'form' | 'edit'", HOOK_PATH, "来源字面量"),
    ("export function useWorkbenchDirectoryPicker(", HOOK_PATH, "目录选择域 hook 本身"),
]
for snippet, owner, label in UNIQUE:
    owners = owners_of(snippet)
    check(owners == [os.path.normpath(owner)], f"{label} 只有一份（实际落在：{owners}）")

check(owners_of("const [view, setView] = useState<WorkbenchView>('today')") == [os.path.normpath(NAV_HOOK_PATH)],
      "P6-1 的导航域仍是唯一所有者（本批没有回退）")
check(owners_of("const [busy, setBusy] = useState(initial)") == [os.path.normpath(BUSY_HOOK_PATH)],
      "P6-1 的忙碌标志仍是唯一所有者")
check(owners_of("const [quickWorkspace, setQuickWorkspace] = useState('')") == [os.path.normpath(QUICK_HOOK_PATH)],
      "P6-2 的快速录入域仍是唯一所有者")
check(owners_of("const [promptModal, setPromptModal] = useState<{ title: string; value: string } | null>(null)") == [os.path.normpath(AI_HOOK_PATH)],
      "P6-3 的 AI 会话域仍是唯一所有者")

# ---------------------------------------------------------------- §3 本域职责与纯度
print("\n§3 本域的职责与纯度")
check("export function useWorkbenchDirectoryPicker(): UseWorkbenchDirectoryPickerResult {" in HOOK,
      "本域零入参（不读任何别的域）")
check("localDirRequestUrl(path)" in HOOK, "请求形状走纯模块（与知识库那个弹窗同一实现）")
check(len(re.findall(r"api<", HOOK)) == 1, "本域只发一条请求（列目录）")
check("'/api/workbench/knowledge/list-local-dir'" not in HOOK and "/knowledge/list-local-dir" not in HOOK,
      "路由字面量仍只在 localDirBrowser.ts 里（两处各拼一份，哨兵/编码口径迟早分叉）")
check("/knowledge/list-local-dir" in SOURCES.get(LOCAL_DIR_MODULE, ""), "纯模块仍是那个字面量的唯一来源")
check("setInterval(" not in HOOK_BARE, "本域不拥有任何定时器（setInterval）")
check("setTimeout(" not in HOOK_BARE, "本域不拥有任何定时器（setTimeout）")
check("fetch(" not in HOOK_BARE, "本域不发裸 fetch（统一走 api 客户端）")
check("useEffect" not in HOOK_BARE, "本域无副作用（没有 effect：列目录由动作显式触发）")
check(len(re.findall(r"useState[<(]", HOOK_BARE)) == 5, "本域恰好 5 项 state（不多塞）")
# openFor 的三件事：记来源 / 记起始目录 / 立刻列一次 —— 少任何一件都是行为回归
check("  const openFor = (target: DirectoryPickerTarget, start: string): void => {" in HOOK,
      "openFor 是唯一入口动作")
check("    setDirPickerTarget(target)" in HOOK, "openFor：记来源（否则弹窗打不开）")
check("    setDirPickerPath(start)" in HOOK, "openFor：起始目录立刻落到地址栏（否则用户看到上一次的路径）")
check("    void loadDirPickerDir(start)" in HOOK, "openFor：立刻列一次（否则弹窗空着）")
check("from './hooks/" not in HOOK, "域 hook 之间不互相 import")
check("index.js'" not in HOOK, "hook 不 import 入口（不成环）")

# ---------------------------------------------------------------- §4 跨域：装配层的两件事仍在
print("\n§4 跨域：装配层只留「算起始目录」与「选完写到哪」")
check("const openDirPicker = (target: 'quick' | 'form' | 'edit'): void => {" in INDEX_BARE,
      "openDirPicker 仍是装配层的包装（读三个入口的当前值）")
check("const applyWorkspaceDir = (dirPath: string): void => {" in INDEX_BARE,
      "applyWorkspaceDir 仍是唯一分派点")
for dispatch in [
    "if (target === 'quick') { overrideWorkspace(picked); return }",
    "if (target === 'form') { forms.actions.setFormWorkspace(picked); return }",
    "if (target === 'edit') { forms.actions.patchDraft({ workspacePath: picked }) }",
]:
    check(dispatch in INDEX_BARE, f"分派仍在入口：{dispatch[:56]}…")
check("const start = target === 'quick' ? quickWorkspace : target === 'form' ? formWorkspace : (editDraft?.workspacePath ?? '')" in INDEX_BARE,
      "起始目录仍是装配层算（三个入口的当前值分属三个域）")
check("    openFor(target, start)" in INDEX_BARE, "算完起始目录后交给本域的 openFor")
for foreign in ["overrideWorkspace", "forms.", "editDraft", "quickWorkspace", "formWorkspace", "applyWorkspaceDir", "openDirPicker"]:
    check(bare(HOOK_BARE, foreign) == 0, f"本域不写别的域：{foreign}")

# ---------------------------------------------------------------- §5 落点与调用顺序
print("\n§5 落点与调用顺序（`const` 无提升）")
i_hook = INDEX_BARE.find("const dir = useWorkbenchDirectoryPicker()")
i_open = INDEX_BARE.find("const openDirPicker = (target: 'quick' | 'form' | 'edit'): void => {")
i_apply = INDEX_BARE.find("const applyWorkspaceDir = (dirPath: string): void => {")
check(i_hook > 0 and i_open > i_hook, "hook 调用落在 openDirPicker 之前（后者要调 openFor）")
check(i_apply > i_hook, "applyWorkspaceDir 在 hook 调用之后")
check(len(re.findall(r"useWorkbenchDirectoryPicker\(", INDEX_BARE)) == 1,
      "hook 在入口只被调用一次（无条件、顶层）")
check("const { dirPickerTarget } = dir" in INDEX_BARE,
      "读取值解构（P7-3 起只剩入口真读的 dirPickerTarget；名字与搬迁前一致，调用点文本因此不用改）")
check("const { openFor, setDirPickerTarget } = dir.actions" in INDEX_BARE,
      "动作解构（P7-3 起只剩入口真用的两个）")
check("import { useWorkbenchDirectoryPicker } from './hooks/useWorkbenchDirectoryPicker.js'" in INDEX,
      "入口 import 新 hook（原文）")
check(INDEX.count("// 目录选择域（D17/P6-4）") >= 1, "入口留了指针注释")

# ---------------------------------------------------------------- §6 刻意留在装配层的 JSX 还在
print("\n§6 刻意留在装配层的 JSX 还在（只换来源、不改调用点文本）")
INDEX_KEEP = [
    "<LocalDocModal",
    "open={dirPickerTarget !== null}",
    "mode=\"dir\"",
    "path={dirPickerPath}",
    "listing={dirPickerListing}",
    "loading={dirPickerLoading}",
    "error={dirPickerError}",
    "onPathChange={setDirPickerPath}",
    "onClose={() => setDirPickerTarget(null)}",
    "onNavigate={(target) => void loadDirPickerDir(target)}",
    "onPickDir={(entry) => applyWorkspaceDir(entry.path)}",
    "onBrowse={() => openDirPicker('quick')}",
    "onBrowseWorkspace={() => openDirPicker('form')}",
    "onBrowseWorkspace={() => openDirPicker('edit')}",
]
for snippet in INDEX_KEEP:
    check(snippet in INDEX_BARE or snippet in UI_ALL, f"仍在装配层：{snippet[:62]}")

# ---------------------------------------------------------------- §7 结构指纹与 P7 欠账
print("\n§7 结构指纹与交给 P7 的欠账")
# 本批把这两个符号的唯一使用点搬走了 —— 入口的 import 成了死 import。
# 与 P4 的决定一致（noUnusedLocals 未开、无 lint），**留给 P7 一次性清**，这里只如实登记。
# 判据：该名字在入口**只剩 import 那一行**（不是"完全不出现"，那样连 import 都看不出来）。
dead = []
for name in ["localDirRequestUrl", "LocalDirListing"]:
    hits = [line for line in INDEX_BARE.split("\n")
            if re.search(r"(?<![\w.])" + re.escape(name) + r"\b", line)]
    if len(hits) == 1 and hits[0].lstrip().startswith("import"):
        dead.append(name)
print(f"     ℹ 入口的死 import（本批产生，P7 一次清）：{dead}")
check(dead == [],
      "入口死 import 已归零（P7-3 清理：原先那两处 localDirRequestUrl / LocalDirListing 已删）")
check("import { localDirRequestUrl } from '../localDirBrowser.js'" in SOURCES.get(HOOK_PATH, ""),
      "目录选择域仍 import localDirRequestUrl（所有者不变）")
check("import type { LocalDirListing } from '../components/LocalDocModal.js'" in SOURCES.get(HOOK_PATH, ""),
      "目录选择域仍 import LocalDirListing（类型所有者不变）")

# ---------------------------------------------------------------- §8 ADR-0008 结构硬门 + 度量
print("\n§8 ADR-0008 结构硬门与度量")
body = app_body()
body_lines = len(body.split("\n"))
direct_state = len(re.findall(r"useState[<(]", body))
print(f"     ℹ 入口：{len(INDEX.split(chr(10))) - 1} 行；WorkbenchApp 函数体：{body_lines} 行")
print(f"     ℹ 体内直接 useState：{direct_state} 项（基线 27：P6-1 搬 2、P6-2 搬 8、P6-3 搬 12、P6-4 搬 5）")
print(f"     ℹ hook 文件：{len(HOOK.split(chr(10))) - 1} 行")
print(f"     ℹ 体内 api( 的 {body.count('api(')} 处（**P7 欠账**，ADR-0008 要求最终为 0）：")
for line in body.split("\n"):
    if "api(" in line:
        print(f"        · {line.strip()[:96]}")
print(f"     ℹ 体内 useEffect( 的 {body.count('useEffect(')} 处（P7 评估）")

# 函数体解析守卫：低界 200 行（P7 收口后还会更小），高界仍是"没有把整个文件当函数体"。
# **这是解析器守卫，不是出口判据**。
check(200 < body_lines < 3500, f"取到的是真正的函数体（{body_lines} 行）")
check(direct_state == 0, f"ADR-0008 硬门：体内直接 useState 为 0（实测 {direct_state}）")
check(body.count("setInterval(") == 0, "体内没有 setInterval")
check(body.count("setTimeout(") == 0, "体内没有 setTimeout")
check(body.count("fetch(") == 0, "体内没有裸 fetch")
check(INDEX.count("setInterval(") == 1 and "const titlebarTimer = setInterval(() => {" in INDEX,
      "整份入口只剩插件 setup 的那一个 setInterval（titlebarTimer，不属本组件）")
check(INDEX.count("setTimeout(") == 0, "整份入口没有 setTimeout")

print("\n" + "=" * 78)
if failures:
    print(f"✖ {len(failures)} / {checks} 项未通过：")
    for item in failures:
        print(f"   - {item}")
    sys.exit(1)
print(f"✔ 全部 {checks} 项通过")
sys.exit(0)
