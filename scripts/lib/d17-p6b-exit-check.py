# -*- coding: utf-8 -*-
"""D17 / P6-2 出口自检：快速录入域（QuickIntake）是否真的收进了唯一所有者。

本批把 `src/client/index.tsx` 里这 8 项 state / 2 个 ref / 两个内部写入点 / 7 个动作 /
一条卸载 effect，搬进 `src/client/hooks/useWorkbenchQuickIntake.ts`；三个浏览器侧小工具
（`newTaskId` / `fileToBase64` / `quickImageToPromptPart`）搬进纯模块 `src/client/intakeHelpers.ts`
（快速录入域与 AI 会话域共用，而 hook 不能 import 入口 —— 会成环）。

判据口径（设计文档 §8，与 P1–P5 一致）：
  * 正向断言指向**真实 owner**（搬到哪就指哪）；
  * 负向唯一性断言**递归覆盖整个 src/client**（只查旧入口会空洞通过）；
  * 单一所有者的比对用**完整声明原文**（松正则会撞上别的域的同名声明）。

用法：python scripts/lib/d17-p6b-exit-check.py
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
HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchQuickIntake.ts")
HELPERS_PATH = os.path.join("src", "client", "intakeHelpers.ts")
AI_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchAISessions.ts")
AI_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchAISessions.ts")
NAV_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchNavigation.ts")
BUSY_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchBusy.ts")
SETTINGS_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchSettings.ts")

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
HELPERS = SOURCES.get(HELPERS_PATH, "")


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
print("D17 / P6-2 出口自检：快速录入域（QuickIntake）")
print("=" * 78)

# ---------------------------------------------------------------- §1 入口不再自建本域任何东西
print("\n§1 入口不再自建快速录入域任何东西")
check(os.path.isfile(HOOK_PATH), f"{HOOK_PATH} 存在")
check(os.path.isfile(HELPERS_PATH), f"{HELPERS_PATH} 存在（共用的三个浏览器侧小工具）")

DOMAIN_DECLARATIONS = [
    "const [showQuick, setShowQuick] = useState(false)",
    "const [quickText, setQuickText] = useState('')",
    "const [quickWorkspace, setQuickWorkspace] = useState('')",
    "const [quickWorkspaceTouched, setQuickWorkspaceTouched] = useState(false)",
    "const [quickWorkspaceSource, setQuickWorkspaceSource] = useState<QuickWorkspaceDefaultSource>('unset')",
    "const [quickFollowFolder, setQuickFollowFolder] = useState(false)",
    "const [quickAttachments, setQuickAttachments] = useState<QuickAttachmentDraft[]>([])",
    "const [quickAttachmentNotice, setQuickAttachmentNotice] = useState<string | null>(null)",
    "const quickImageInputRef = useRef<HTMLInputElement>(null)",
    "const quickAttachmentsRef = useRef<QuickAttachmentDraft[]>([])",
    "const writeQuickAttachments = (next: QuickAttachmentDraft[]): void => {",
    "const appendQuickAttachments = (drafts: QuickAttachmentDraft[]): void => {",
    "const applyQuickWorkspaceDecision = (decided: QuickWorkspaceDefaultDecision, autoCreateTypeFolders: boolean): void => {",
    "const rememberQuickWorkspace = async (path: string): Promise<void> => {",
    "const forgetQuickWorkspace = async (path: string): Promise<void> => {",
    "const addQuickAttachments = (files: readonly File[]): void => {",
    "const removeQuickAttachment = (id: string): void => {",
    "const clearQuickAttachments = (): void => {",
    "function newTaskId(): string {",
    "function fileToBase64(file: File): Promise<string> {",
    "async function quickImageToPromptPart(image: QuickImageDraft): Promise<PromptContentPart> {",
]
for declaration in DOMAIN_DECLARATIONS:
    if declaration == "const applyQuickWorkspaceDecision = (decided: QuickWorkspaceDefaultDecision, autoCreateTypeFolders: boolean): void => {":
        # 唯一一个**改了名字**的搬迁点：hook 里叫 `applyDecision`（§2 有它自己的唯一性断言）。
        check(declaration not in INDEX_BARE, "入口不再有声明：applyQuickWorkspaceDecision…")
        check("const applyDecision = (decided: QuickWorkspaceDefaultDecision" in HOOK_BARE,
              "该声明在新 owner 里（已改名为 applyDecision）：applyQuickWorkspaceDecision…")
        continue
    check(declaration not in INDEX_BARE, f"入口不再有声明：{declaration[:58]}…")
    check(declaration in HOOK_BARE or declaration in HELPERS,
          f"该声明在新 owner 里找得到：{declaration[:58]}…")

for name in [
    "showQuick", "quickText", "quickWorkspace", "quickWorkspaceTouched", "quickWorkspaceSource",
    "quickFollowFolder", "quickAttachments", "quickAttachmentNotice", "quickImageInputRef",
    "quickAttachmentsRef", "writeQuickAttachments", "appendQuickAttachments",
    "applyQuickWorkspaceDecision", "newTaskId", "fileToBase64", "quickImageToPromptPart",
]:
    check(defs_of(INDEX_BARE, name) == 0, f"入口没有第二份定义：{name}")

check("const [showQuick" not in INDEX_BARE, "入口连 useState 的形态都没有了（showQuick）")
check("useRef<QuickAttachmentDraft[]>" not in INDEX_BARE, "附件镜像 ref 完全离开入口")
check(bare(INDEX_BARE, "quickAttachmentsRef") == 0, "入口不再直接摸 ref.current")
check(bare(INDEX_BARE, "writeQuickAttachments") == 0, "入口不再直接写附件（唯一出口在 hook 里）")
check(bare(INDEX_BARE, "appendQuickAttachments") == 0, "入口不再直接追加附件")

# ---------------------------------------------------------------- §2 唯一所有者（全客户端递归）
print("\n§2 唯一所有者（递归覆盖整个 src/client）")
UNIQUE = [
    ("const [quickWorkspace, setQuickWorkspace] = useState('')", HOOK_PATH, "quickWorkspace 这个 state"),
    ("const quickAttachmentsRef = useRef<QuickAttachmentDraft[]>([])", HOOK_PATH, "附件镜像 ref"),
    ("const writeQuickAttachments = (next: QuickAttachmentDraft[]): void => {", HOOK_PATH, "附件唯一写入出口"),
    ("const appendQuickAttachments = (drafts: QuickAttachmentDraft[]): void => {", HOOK_PATH, "附件追加"),
    ("const applyDecision = (decided: QuickWorkspaceDefaultDecision, autoCreateTypeFolders: boolean): void => {", HOOK_PATH, "判定结果投影"),
    ("const overrideWorkspace = (path: string): void => {", HOOK_PATH, "用户输入的唯一写点"),
    ("export function useWorkbenchQuickIntake(", HOOK_PATH, "快速录入域 hook 本身"),
    ("export function newTaskId(): string {", HELPERS_PATH, "任务 id 生成"),
    ("export function fileToBase64(file: File): Promise<string> {", HELPERS_PATH, "文件 → base64"),
    ("export async function quickImageToPromptPart(", HELPERS_PATH, "图片 → PromptContentPart"),
]
for snippet, owner, label in UNIQUE:
    owners = owners_of(snippet)
    check(owners == [os.path.normpath(owner)], f"{label} 只有一份（实际落在：{owners}）")

check(owners_of("const [view, setView] = useState<WorkbenchView>('today')") == [os.path.normpath(NAV_HOOK_PATH)],
      "P6-1 的导航域仍是唯一所有者（本批没有回退）")
check(owners_of("const [busy, setBusy] = useState(initial)") == [os.path.normpath(BUSY_HOOK_PATH)],
      "P6-1 的忙碌标志仍是唯一所有者")
check("export function useWorkbenchSettings(" in SOURCES.get(SETTINGS_HOOK_PATH, ""),
      "设置域 hook 仍在（本域以注入方式消费它的 setSettings）")

# ---------------------------------------------------------------- §3 本域职责与纯度
print("\n§3 本域的 HTTP 归属与纯度")
check("'/api/workbench/settings'" in HOOK, "本域只碰设置接口（remember / forget 两个写入点）")
for route in [
    "'/api/workbench/tasks", "'/api/workbench/knowledge", "'/api/workbench/ideas",
    "'/api/workbench/skills", "'/api/workbench/model-modalities", "'/api/workbench/ai-sessions",
    "'/api/workbench/workspaces",
]:
    check(route not in HOOK, f"别的域的路由不在本 hook 里：{route}")
check("setInterval(" not in HOOK_BARE, "本域不拥有任何定时器（setInterval）")
check("setTimeout(" not in HOOK_BARE, "本域不拥有任何定时器（setTimeout）")
check("fetch(" not in HOOK_BARE, "本域不发裸 fetch（统一走 api 客户端）")
check("const saveSettings" not in HOOK_BARE, "设置域的 saveSettings 仍归设置域（本域只注入 setSettings）")
check("'./index.js'" not in HOOK and "index.js'" not in HOOK, "hook 不 import 入口（不成环）")
check("from './hooks/" not in HOOK, "域 hook 之间不互相 import")
check(HELPERS.count("export ") == 3, "共用的纯模块只导出三个小工具（不多塞东西）")
check("useState" not in strip_comments(HELPERS) and "useEffect" not in strip_comments(HELPERS),
      "共用的纯模块不碰 React 状态（纯函数，可被域与视图共用）")
check("from 'react'" not in HELPERS, "共用的纯模块不 import 任何 React 东西")

# ---------------------------------------------------------------- §4 跨域注入（设计 §5）
print("\n§4 跨域依赖以注入形式进来（设计 §5）")
check("const { runtime, settings, setSettings, detectWslHost, onError: setError } = input" in HOOK,
      "函数体第一行把注入依赖改回原名（搬来的函数体因此逐字未改）")
check("onError: setError }" in INDEX_BARE, "入口把反馈域的 setError 注进去")
check("interface UseWorkbenchQuickIntakeInput {" in HOOK, "入参有显式类型声明")
for piece in ["runtime: WorkbenchRuntime", "settings: WorkbenchSettings",
              "setSettings: Dispatch<SetStateAction<WorkbenchSettings>>",
              "detectWslHost: (runtime: WorkbenchRuntime) => boolean",
              "onError: (message: string) => void"]:
    check(piece in HOOK, f"入参声明：{piece}")

for foreign in [
    "selected", "effectiveWorkspacePath", "ideasAll", "todayPlan", "pickedPlan", "taskList",
    "workspaceCandidates", "openDirPicker", "dirPicker", "setView", "dicts", "bootstrap",
]:
    check(bare(HOOK_BARE, foreign) == 0, f"本域不认识别的域的名字：{foreign}")

# ---------------------------------------------------------------- §5 上游接管与调用顺序
print("\n§5 上游接管与调用顺序（`const` 无提升）")
i_prefs = INDEX_BARE.find("} = prefs.actions")
i_hook = INDEX_BARE.find("const quick = useWorkbenchQuickIntake({")
i_open = INDEX_BARE.find("const openQuickEntry = (): void => {")
check(i_prefs > 0 and i_hook > i_prefs, "hook 调用落在设置域之后（要用 settings / setSettings / setError）")
check(i_hook > 0 and i_open > i_hook, "hook 调用落在 openQuickEntry 之前（后者要调 openIntake）")
check(len(re.findall(r"useWorkbenchQuickIntake\(", INDEX_BARE)) == 1,
      "hook 在入口只被调用一次（无条件、顶层）")
check("useWorkbenchQuickIntake({ runtime, settings, setSettings, detectWslHost, onError: setError })" in INDEX_BARE,
      "注入的实参逐条对得上")
check("function detectWslHost(runtime: WorkbenchRuntime): boolean {" in INDEX_BARE,
      "detectWslHost 仍是入口尾部的模块级纯函数（注入而非搬走）")
check("const { runtime, settings, setSettings, detectWslHost, onError: setError } = input" in HOOK,
      "两边的注入名一一对应")

# ---------------------------------------------------------------- §6 刻意留在装配层的还在
print("\n§6 刻意留在装配层的还在（只换来源、不改调用点文本）")
INDEX_KEEP = [
    "const openQuickEntry = (): void => {",
    "onClose={closeIntake}",
    "onClick={cancelIntake}",
    "onChange={overrideWorkspace}",
    "showForget={quickWorkspaceSource === 'last-manual' && !quickWorkspaceTouched}",
    "onForget={() => void forgetQuickWorkspace(quickWorkspace)}",
    "shouldRememberQuickWorkspace(quickWorkspaceTouched, chosen)",
    "void rememberQuickWorkspace(chosen)",
    "addQuickAttachments(files)",
    "removeQuickAttachment(item.id)",
    "ref={quickImageInputRef}",
    "quickImageInputRef.current?.click()",
    "sourceLabel={quickWorkspaceSourceLabel(quickWorkspaceSource)}",
    "const workspaceChoices = workspaceCandidates({",
    "recent: settings.quickWorkspaceRecent,",
    "setQuickText(e.target.value)",
    "setQuickFollowFolder(e.target.checked)",
]
for snippet in INDEX_KEEP:
    check(snippet in INDEX_BARE or snippet in UI_ALL, f"仍在装配层：{snippet[:64]}")
# P6-3 起「澄清后清附件」的调用点随 `startAISession` 搬进 AI 会话域 hook ⇒ 本批只断言
# **写口仍然只此一个**（入口把快速录入域的动作以注入形式交给 AI 会话域）：
# 成对的正向断言（hook 里那句 `if (mode === 'clarify') clearQuickAttachments()`）归
# d17-p6c-exit-check.py。判据跟着 owner 走，不是放宽。
check("    clearQuickAttachments, closeIntake," in INDEX_BARE,
      "入口把本域的 clearQuickAttachments 以注入形式交给 AI 会话域（P6-3）")
check("clearQuickAttachments()" not in INDEX_BARE,
      "入口自己不再直接调 clearQuickAttachments()（已随 startAISession 搬走）")

# ---------------------------------------------------------------- §7 结构指纹与顺序
print("\n§7 结构指纹与顺序")
check("import { useWorkbenchQuickIntake } from './hooks/useWorkbenchQuickIntake.js'" in INDEX,
      "入口 import 新 hook（原文）")
check("import { newTaskId, quickImageToPromptPart } from './intakeHelpers.js'" not in INDEX,
      "入口不再 import 共用纯模块（P7-3 清理：入口已无调用点，导入权归使用它的两个域）")
check("import { fileToBase64, newTaskId } from '../intakeHelpers.js'" in HOOK,
      "快速录入域 import 共用纯模块（附件草稿 + 任务 id）")
check("import { newTaskId, quickImageToPromptPart } from '../intakeHelpers.js'"
      in SOURCES.get(AI_HOOK_PATH, ""), "AI 会话域 import 共用纯模块（预留任务 id + 图片 prompt part）")
check("from '../settingsFallback.js'" in HOOK, "hook import 设置域的兜底纯函数（写 settings 用）")
check("from '../intakeHelpers.js'" in HOOK, "hook import 共用的浏览器侧小工具")
check("const quick = useWorkbenchQuickIntake({" in INDEX_BARE and "} = quick.actions" in INDEX_BARE,
      "入口两段解构：读取值 + 动作")
check(INDEX.count("// 快速录入域（D17/P6-2）") >= 2, "入口留了指针注释（至少两处）")

# ---------------------------------------------------------------- §8 ADR-0008 结构硬门 + 度量
print("\n§8 ADR-0008 结构硬门与度量")
body = app_body()
body_lines = len(body.split("\n"))
direct_state = len(re.findall(r"useState[<(]", body))
print(f"     ℹ 入口：{len(INDEX.split(chr(10))) - 1} 行；WorkbenchApp 函数体：{body_lines} 行")
print(f"     ℹ 体内直接 useState：{direct_state} 项（基线 27；P6-1 搬走 view + busy 两项、"
      f"P6-2 搬走 8 项、P6-3 搬走 12 项 ⇒ 余 5 项全属 P6-4）；"
      f"api(: {body.count('api(')} 处；useEffect(: {body.count('useEffect(')} 处")
print(f"     ℹ hook 文件：{len(HOOK.split(chr(10))) - 1} 行；纯模块：{len(HELPERS.split(chr(10))) - 1} 行")

# 函数体解析守卫：低界放宽到 200 行（P6-3 之后函数体已 1406 行；P7 收口后还会更小），
# 高界仍是"没有把整个文件当函数体"。**这是解析器守卫，不是出口判据** ——
# 本批搬走的 8 项 state 由 §1 的"入口不再有本域声明"逐条守住，精确计数归 d17-p6c-exit-check.py。
check(200 < body_lines < 3500, f"取到的是真正的函数体（{body_lines} 行）")
check(direct_state <= 17, f"体内的直接 useState 不高于 P6-2 收尾时的 17 项（实测 {direct_state}）")
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
