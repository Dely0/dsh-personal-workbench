# -*- coding: utf-8 -*-
"""D17 / P6-3 出口自检：AI 会话域（AISessions）是否真的收进了唯一所有者。

本批把 `src/client/index.tsx` 里这 12 项 state / 1 个 ref / 9 个函数搬进
`src/client/hooks/useWorkbenchAISessions.ts`：
  * state：quickModelSelection（含写 localStorage 的包装 setter）/ modelModalityTable /
    promptModal / skillCatalog / skillsAvailable / skillsLoading / skillProblem / skillQuery /
    selectedSkills / promptPersona / quickPersona / promptModelSelection（含包装 setter）；
  * ref：promptResolveRef；
  * 函数：loadSkills / askUserPrompt / confirmPrompt / cancelPrompt / toggleSkill /
    AI_PROMPT_LABELS / openSessionInPanel / `startAISession`（468 行，ADR-0008「单个顶层块 ≤80 行」
    的最大违例）/ reuseAiSessionId；外加新增动作 `resetClarifyPicker()`。
**刻意留在装配层**的：`startAISessionRef`（惰性转发给 `useKnowledge`）、两个弹窗的 JSX、
`loadModelModalityTable` / `aiSessionUsable` / `connectWorkspace` 三个宿主助手（注入形式，
避免 hook ↔ 入口成环）。

判据口径（设计文档 §8，与 P1–P5 一致）：
  * 正向断言指向**真实 owner**（搬到哪就指哪）；
  * 负向唯一性断言**递归覆盖整个 src/client**（只查旧入口会空洞通过）；
  * 单一所有者的比对用**完整声明原文**（松正则会撞上别的域的同名声明）。

用法：python scripts/lib/d17-p6c-exit-check.py
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
HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchAISessions.ts")
QUICK_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchQuickIntake.ts")
NAV_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchNavigation.ts")
BUSY_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchBusy.ts")
KNOWLEDGE_HOOK_PATH = os.path.join("src", "client", "hooks", "useKnowledge.ts")

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
print("D17 / P6-3 出口自检：AI 会话域（AISessions）")
print("=" * 78)

# ---------------------------------------------------------------- §1 入口不再自建本域任何东西
print("\n§1 入口不再自建 AI 会话域任何东西")
check(os.path.isfile(HOOK_PATH), f"{HOOK_PATH} 存在")

DOMAIN_DECLARATIONS = [
    "const [quickModelSelection, setQuickModelSelectionState] = useState<QuickModelSelection | null>(() => readQuickModelSelection())",
    "const setQuickModelSelection = (selection: QuickModelSelection | null): void => {",
    "const [modelModalityTable, setModelModalityTable] = useState<ReadonlyMap<string, readonly string[] | null>>(() => new Map())",
    "const [promptModal, setPromptModal] = useState<{ title: string; value: string } | null>(null)",
    "const promptResolveRef = useRef<((value: { text: string; skills: string[]; persona: PersonaSelection } | null) => void) | null>(null)",
    "const [skillCatalog, setSkillCatalog] = useState<SkillSummary[]>([])",
    "const [skillsAvailable, setSkillsAvailable] = useState(false)",
    "const [skillsLoading, setSkillsLoading] = useState(false)",
    "const [skillProblem, setSkillProblem] = useState('')",
    "const [skillQuery, setSkillQuery] = useState('')",
    "const [selectedSkills, setSelectedSkills] = useState<string[]>([])",
    "const [promptPersona, setPromptPersona] = useState<PersonaSelection>(INHERIT_PERSONA)",
    "const [quickPersona, setQuickPersona] = useState<PersonaSelection>(INHERIT_PERSONA)",
    "const [promptModelSelection, setPromptModelSelectionState] = useState<QuickModelSelection | null>(() => readQuickModelSelection())",
    "const setPromptModelSelection = (selection: QuickModelSelection | null): void => {",
    "const loadSkills = useCallback(async (): Promise<void> => {",
    "const askUserPrompt = (title: string): Promise<{ text: string; skills: string[]; persona: PersonaSelection } | null> => new Promise((resolve) => {",
    "const confirmPrompt = (): void => {",
    "const cancelPrompt = (): void => {",
    "const toggleSkill = (name: string): void => {",
    "const AI_PROMPT_LABELS: Record<string, string> = {",
    "const openSessionInPanel = (sessionId: string): void => {",
    "const startAISession = async (mode: 'clarify' | 'consult' | 'breakdown' | 'execute' | 'review' | 'plan' | 'report' | 'idea_association' | 'idea_brainstorm' | 'knowledge_doc', task: Task | null, text: string, previousSessions: Array<Record<string, unknown>> = [], docContext?: { fileLink: string; content: string; name?: string; truncated?: boolean }, workspaceOverride?: string, clarifyOptions: { attachments?: readonly QuickAttachmentDraft[]; followFolder?: boolean; persona?: PersonaSelection } = {}): Promise<void> => {",
    "const reuseAiSessionId = async (",
    "const resetClarifyPicker = (): void => {",
]
for declaration in DOMAIN_DECLARATIONS:
    check(declaration not in INDEX_BARE, f"入口不再有声明：{declaration[:62]}…")
    check(declaration in HOOK_BARE, f"该声明在新 owner 里找得到：{declaration[:62]}…")

for name in [
    "quickModelSelection", "setQuickModelSelectionState", "setQuickModelSelection", "modelModalityTable",
    "setModelModalityTable", "promptModal", "setPromptModal", "promptResolveRef", "skillCatalog",
    "skillsAvailable", "skillsLoading", "skillProblem", "skillQuery", "selectedSkills", "promptPersona",
    "quickPersona", "promptModelSelection", "setPromptModelSelectionState", "setPromptModelSelection",
    "loadSkills", "askUserPrompt", "confirmPrompt", "cancelPrompt", "toggleSkill", "AI_PROMPT_LABELS",
    "openSessionInPanel", "startAISession", "reuseAiSessionId", "resetClarifyPicker",
]:
    check(defs_of(INDEX_BARE, name) == 0, f"入口没有第二份定义：{name}")

check("useState<QuickModelSelection" not in INDEX_BARE, "入口连模型选择的 useState 形态都没有了")
check("useRef<((value: { text: string; skills: string[]" not in INDEX_BARE, "提示词弹窗的 resolve ref 完全离开入口")
check("const [skillCatalog" not in INDEX_BARE, "技能目录的 state 离开入口（三个 state 一起走）")

# ---------------------------------------------------------------- §2 唯一所有者（全客户端递归）
print("\n§2 唯一所有者（递归覆盖整个 src/client）")
UNIQUE = [
    ("const [quickModelSelection, setQuickModelSelectionState] = useState<QuickModelSelection | null>(() => readQuickModelSelection())",
     HOOK_PATH, "快速录入的模型选择（+ 包装 setter 的 state 位）"),
    ("const [modelModalityTable, setModelModalityTable] = useState<ReadonlyMap<string, readonly string[] | null>>(() => new Map())",
     HOOK_PATH, "模型 → 输入能力对照表"),
    ("const promptResolveRef = useRef<((value: { text: string; skills: string[]; persona: PersonaSelection } | null) => void) | null>(null)",
     HOOK_PATH, "提示词弹窗的 resolve ref"),
    ("const [selectedSkills, setSelectedSkills] = useState<string[]>([])", HOOK_PATH, "已选技能"),
    ("const [promptPersona, setPromptPersona] = useState<PersonaSelection>(INHERIT_PERSONA)", HOOK_PATH, "提示词弹窗的角色选择"),
    ("const [quickPersona, setQuickPersona] = useState<PersonaSelection>(INHERIT_PERSONA)", HOOK_PATH, "快速录入的角色选择"),
    ("const loadSkills = useCallback(async (): Promise<void> => {", HOOK_PATH, "技能目录装载"),
    ("const askUserPrompt = (title: string): Promise<{ text: string; skills: string[]; persona: PersonaSelection } | null> => new Promise((resolve) => {",
     HOOK_PATH, "共享提示词弹窗的入口"),
    ("const openSessionInPanel = (sessionId: string): void => {", HOOK_PATH, "把会话开到主视图"),
    ("const reuseAiSessionId = async (", HOOK_PATH, "复用还是新建会话"),
    ("const resetClarifyPicker = (): void => {", HOOK_PATH, "澄清入口的角色 + 技能复位（P6-3 新增）"),
    ("export function useWorkbenchAISessions(", HOOK_PATH, "AI 会话域 hook 本身"),
    ("export type StartAISessionAction = (", HOOK_PATH, "对外暴露的动作类型（与 useKnowledge 的结构化赋值对接）"),
]
for snippet, owner, label in UNIQUE:
    owners = owners_of(snippet)
    check(owners == [os.path.normpath(owner)], f"{label} 只有一份（实际落在：{owners}）")

# `startAISession` 的签名太长，单独用前缀做唯一性比对（仍然指真实 owner）。
owners = owners_of("const startAISession = async (mode: 'clarify' | 'consult' | 'breakdown' | 'execute' | 'review' | 'plan' | 'report' | 'idea_association' | 'idea_brainstorm' | 'knowledge_doc',")
check(owners == [os.path.normpath(HOOK_PATH)], f"startAISession（468 行那条）只有一份（实际落在：{owners}）")

check(owners_of("const [view, setView] = useState<WorkbenchView>('today')") == [os.path.normpath(NAV_HOOK_PATH)],
      "P6-1 的导航域仍是唯一所有者（本批没有回退）")
check(owners_of("const [busy, setBusy] = useState(initial)") == [os.path.normpath(BUSY_HOOK_PATH)],
      "P6-1 的忙碌标志仍是唯一所有者")
check(owners_of("const [quickWorkspace, setQuickWorkspace] = useState('')") == [os.path.normpath(QUICK_HOOK_PATH)],
      "P6-2 的快速录入域仍是唯一所有者")
check("export function useKnowledge(" in SOURCES.get(KNOWLEDGE_HOOK_PATH, ""),
      "知识域 hook 仍在（它仍以惰性转发 ref 拿 startAISession）")

check("from './hooks/" not in HOOK, "域 hook 之间不互相 import")
check("index.js'" not in HOOK, "hook 不 import 入口（不成环）")

# ---------------------------------------------------------------- §3 本域职责与纯度
print("\n§3 本域的 HTTP 归属与纯度")
for route in ["/api/workbench/skills", "/api/workbench/personas/bind", "/api/workbench/workspaces/ensure"]:
    check(route in HOOK, f"本域自己发这条请求：{route}")
check(len(re.findall(r"/api/workbench/ai-sessions", HOOK)) >= 4,
      "会话的建/查路由都在本域（POST ×3 + GET ×1）")
check(len(re.findall(r"/api/workbench/workspaces/ensure", HOOK)) == 2,
      "工作区 ensure 的两个形态（自动任务资料夹 / 显式目录）都在本域")
# 别的域的**独占**路由不许出现在本 hook 里（tasks / reports / idea-clusters 是本域读上下文要用的，不算）
for foreign_route in [
    "'/api/workbench/settings'", "'/api/workbench/knowledge", "'/api/workbench/ideas",
    "'/api/workbench/drafts", "'/api/workbench/daily-plan",
]:
    check(foreign_route not in HOOK, f"别的域的独占路由不在本 hook 里：{foreign_route}")
check("setInterval(" not in HOOK_BARE, "本域不拥有任何定时器（setInterval）")
check("setTimeout(" not in HOOK_BARE, "本域不拥有任何定时器（setTimeout）")
check("fetch(" not in HOOK_BARE, "本域不发裸 fetch（统一走 api 客户端）")
check("instanceAlive" not in HOOK_BARE, "本域不持有卸载标志，只看注入的判活回调")
check(len(re.findall(r"isAlive\(\)", HOOK_BARE)) == 3,
      "await 之后恰好 3 处判活（早退 / 报错 / 收尾各一处）")
check("const isAlive = " not in HOOK_BARE, "isAlive 是注入的，不在本域重新定义")

# ---------------------------------------------------------------- §4 跨域注入（设计 §5）
print("\n§4 跨域依赖以注入形式进来（设计 §5）")
ALIAS = (
    "  const {\n"
    "    runtime, closePanel, settings, dicts, ideasAll,\n"
    "    planPromptFor, todayPlan, pickedPlan, pendingDraft,\n"
    "    clearQuickAttachments, closeIntake, isAlive, setError, setBusy,\n"
    "    loadModelModalityTable, aiSessionUsable, connectWorkspace,\n"
    "  } = input"
)
check(ALIAS in HOOK, "函数体第一行把注入依赖改回原名（搬来的函数体因此逐字未改）")
check("interface UseWorkbenchAISessionsInput {" in HOOK, "入参有显式类型声明")
for piece in [
    "runtime: WorkbenchRuntime", "closePanel: () => void", "settings: WorkbenchSettings",
    "dicts: Dict[]", "ideasAll: Idea[]",
    "planPromptFor: (planDate: string) => PlanPromptPayload",
    "todayPlan: DailyPlanView | null", "pickedPlan: DailyPlanView | null",
    "pendingDraft: DraftView | null",
    "clearQuickAttachments: () => void", "closeIntake: () => void",
    "isAlive: () => boolean", "setError: (message: string | null) => void",
    "setBusy: (value: boolean) => void",
    "loadModelModalityTable: () => Promise<ReadonlyMap<string, readonly string[] | null>>",
    "aiSessionUsable: (runtime: WorkbenchRuntime, sessionId: string) => boolean",
    "connectWorkspace: (workspaceId: string) => Promise<string>",
]:
    check(piece in HOOK, f"入参声明：{piece}")

for passed in [
    "    clearQuickAttachments, closeIntake,", "    setError, setBusy,",
    "    loadModelModalityTable, aiSessionUsable, connectWorkspace,",
]:
    check(passed in INDEX_BARE, f"入口按名注入：{passed.strip()}")
# ⚠️ 判活这一条**必须带上前一行的上下文**：`    isAlive: () => instanceAlive,` 在入口出现两次
# （知识域那次在 P1 就有了），只做 `in` 判断时把本域这次换成 `() => true` 仍然会通过
# —— 实测 M-P6c-5 第一次跑没被抓住，正是这个空洞。所以这里用两行原文 + 一条负向。
check("    clearQuickAttachments, closeIntake,\n    isAlive: () => instanceAlive," in INDEX_BARE,
      "入口把判活以 `() => instanceAlive` 注入给 AI 会话域（不是写死 true）")
check("isAlive: () => true," not in INDEX_BARE, "判活回调不许写死（写死会在卸载后继续写 state）")

for helper in [
    "function loadModelModalityTable(): Promise<ReadonlyMap<string, readonly string[] | null>> {",
    "function aiSessionUsable(runtime: WorkbenchRuntime, sessionId: string): boolean {",
    "async function connectWorkspace(workspaceId: string): Promise<string> {",
]:
    check(helper in INDEX_BARE, f"宿主助手仍留在入口模块作用域（注入而非搬走）：{helper[:52]}…")

# 本域不认识别的域的**状态名**（`selected` 在本域是 idea 分支里的局部名，所以只盯任务域的用法）
for foreign in [
    "taskList", "dayPanelProps", "openDirPicker", "dirPicker", "setView", "refresh", "bootstrap",
    "workspaceCandidates", "dictOf", "openQuickEntry", "setShowQuick", "effectiveWorkspacePath",
    "archivedTasks", "openTaskById", "saveEditDraft", "createTask",
]:
    check(bare(HOOK_BARE, foreign) == 0, f"本域不认识别的域的名字：{foreign}")
check("selected?.task" not in HOOK_BARE, "本域不读任务域的 selected（idea 分支里的局部 selected 不算）")

# ---------------------------------------------------------------- §5 落点与调用顺序
print("\n§5 落点与调用顺序（`const` 无提升）")
i_day = INDEX_BARE.find("} = day.actions")
i_hook = INDEX_BARE.find("const ai = useWorkbenchAISessions({")
i_quick = INDEX_BARE.find("const openQuickEntry = (): void => {")
i_panel = INDEX_BARE.find("const dayPanelProps = {")
i_assign = INDEX_BARE.find("startAISessionRef.current = ai.actions.startAISession")
check(i_day > 0 and i_hook > i_day, "hook 调用落在日期域之后（要用 planPromptFor / todayPlan / pickedPlan）")
check(i_hook > 0 and i_quick > i_hook, "hook 调用落在 openQuickEntry 之前（后者要调 resetClarifyPicker）")
check(i_hook > 0 and i_panel > i_hook, "hook 调用落在 dayPanelProps 之前（面板要 startAISession('plan', …)）")
check(i_assign > i_hook, "惰性转发 ref 的赋值在 hook 调用之后（否则 `ai` 是 TDZ）")
check(len(re.findall(r"useWorkbenchAISessions\(", INDEX_BARE)) == 1,
      "hook 在入口只被调用一次（无条件、顶层）")
check("const startAISessionRef = useRef<StartAISessionFn | null>(null)" in INDEX_BARE,
      "惰性转发 ref 刻意留在装配层")
check("startAISession: startAISessionRef," in INDEX_BARE, "知识域仍以 ref 形式拿这个动作（调用点文本未改）")

# ---------------------------------------------------------------- §6 刻意留在装配层的还在
print("\n§6 刻意留在装配层的还在（只换来源、不改调用点文本）")
INDEX_KEEP = [
    "const openQuickEntry = (): void => {",
    "resetClarifyPicker()",
    "{promptModal !== null && (",
    "onLoaded={() => { void loadModelModalityTable().then(setModelModalityTable) }}",
    "isSessionUsable={(sessionId) => aiSessionUsable(runtime, sessionId)}",
    "openSessionInPanel={openSessionInPanel}",
    "startAISession={startAISession}",
    "onSort: () => void startAISession('plan', null, dayPanel.day),",
    "onRetry={() => void loadSkills()}",
]
for snippet in INDEX_KEEP:
    check(snippet in INDEX_BARE or snippet in UI_ALL, f"仍在装配层：{snippet[:66]}")
check(len(re.findall(r"<PersonaPicker", UI_ALL)) == 2, "角色选择器仍挂在两个弹窗里各一次（P7-2 起在 app/WorkbenchOverlays.tsx 与 app/WorkbenchDialogs.tsx）")
check(len(re.findall(r"<SkillPicker", UI_ALL)) == 2, "技能选择器仍挂在两个弹窗里各一次（同上）")
check(len(re.findall(r"<ModelPicker", UI_ALL)) == 2, "模型选择器仍挂在两个弹窗里各一次（同上）")
check("if (mode === 'clarify') clearQuickAttachments()" in HOOK_BARE,
      "澄清后清附件那句随 startAISession 进了本域（P6-2 的交接口）")
check("clearQuickAttachments()" not in INDEX_BARE, "入口自己不再直接调 clearQuickAttachments()")

# ---------------------------------------------------------------- §7 结构指纹与顺序
print("\n§7 结构指纹与顺序")
check("import { useWorkbenchAISessions } from './hooks/useWorkbenchAISessions.js'" in INDEX,
      "入口 import 新 hook（原文）")
check("const ai = useWorkbenchAISessions({" in INDEX_BARE and "} = ai.actions" in INDEX_BARE,
      "入口两段解构：读取值 + 动作")
check("const { startAISession, resetClarifyPicker } = ai.actions" in INDEX_BARE,
      "动作解构（P7-3 起只剩入口真用的 startAISession / resetClarifyPicker；多行收尾已并回一行）")
check("isAlive: () => instanceAlive," in INDEX_BARE, "判活以回调透传（不把模块级 let 搬进 hook）")
check(INDEX.count("// AI 会话域（D17/P6-3）") >= 3, "入口留了指针注释（至少三处）")
check("from '../components/ModelPicker.js'" in HOOK, "hook 复用组件模块里的持久化/降级纯函数")
check("from '../runtimeServices.js'" in HOOK and "safeService" in HOOK, "宿主服务仍走 safeService")

# ---------------------------------------------------------------- §8 ADR-0008 结构硬门 + 度量
print("\n§8 ADR-0008 结构硬门与度量")
body = app_body()
body_lines = len(body.split("\n"))
direct_state = len(re.findall(r"useState[<(]", body))
print(f"     ℹ 入口：{len(INDEX.split(chr(10))) - 1} 行；WorkbenchApp 函数体：{body_lines} 行")
print(f"     ℹ 体内直接 useState：{direct_state} 项（基线 27；P6-1 搬走 2 项、P6-2 搬走 8 项、"
      f"P6-3 搬走 12 项 ⇒ 余 5 项全属 P6-4）")
print(f"     ℹ hook 文件：{len(HOOK.split(chr(10))) - 1} 行")
print(f"     ℹ 体内 api( 的 {body.count('api(')} 处（P7 硬门欠账，逐处要归域）：")
for line in body.split("\n"):
    if "api(" in line:
        print(f"        · {line.strip()[:96]}")

# 函数体解析守卫：低界 200 行（P7 收口后还会更小），高界仍是"没有把整个文件当函数体"。
# **这是解析器守卫，不是出口判据**。
check(200 < body_lines < 3500, f"取到的是真正的函数体（{body_lines} 行）")
# P6-4 收尾后体内直接 useState 应为 0（`dirPicker*` 那 5 项已归 d17-p6d-exit-check.py 守着）。
check(direct_state == 0, f"体内直接 useState 为 0（P6-4 把最后 5 项 dirPicker* 也搬走了），实测 {direct_state}")
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
