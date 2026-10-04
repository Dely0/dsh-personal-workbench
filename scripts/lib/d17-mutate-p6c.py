#!/usr/bin/env python3
"""D17 P6-3 反向验证：给刚迁移的 **AI 会话域** 注入缺陷，确认判据会真的变红。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
缺陷分布在两个文件（入口 / AI 会话域 hook），所以每条变异自带目标路径
（与 `d17-mutate-p4.py` / `p5a.py` / `p5b.py` / `p5c.py` / `p6b.py` 同构）。

判据面是同构的 `.py` 出口自检与 `.mjs` 单测，`run_checks` 两种都支持。

为什么这十三条：
- M-P6c-1/2/3/4 盯**同一状态/ref/动作只有一个 owner**：模型选择、提示词弹窗的 resolve ref、
  技能装载、以及那条 468 行的 `startAISession`，都是"顺手留一份在入口"最容易复发的形态
  （`startAISession` 留在入口正是 ADR-0008「单个顶层块 ≤80 行」的原始违例）；
- M-P6c-5 盯**判活以回调透传**：写死 `() => true` 之后，卸载后仍会写 state（死上下文刷屏）；
- M-P6c-6/9 盯函数体第一行的**别名**与"不持有宿主模块级 let"（拆开看是两件事，都靠注入）；
- M-P6c-7/8/10 盯**域边界与纯度**：越界发别的域独占路由 / 自己起定时器 / 直接读任务域 `selected`；
- M-P6c-11/12 是**行为级**判据（`.mjs`）：角色复位被删、clarify 的 skills 被硬编码成空数组
  —— 后者正是 2026-10-01 用户报的那个"能选但不生效"的假功能。形态扫描抓不到语义，
  所以这两条必须落在真读源码的 `.mjs` 判据面上；
- M-P6c-13 盯**惰性转发链**：`startAISessionRef.current = ai.actions.startAISession` 没了，
  `useKnowledge` 拿到的就是空 ref（AI 会话再也起不来）。

用法：python scripts/lib/d17-mutate-p6c.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = "src/client/index.tsx"
HOOK = "src/client/hooks/useWorkbenchAISessions.ts"
BACKUP = os.path.join(os.environ["TEMP"], "d17-p6c-mutate.bak")

EXIT_CHECK = "scripts/lib/d17-p6c-exit-check.py"
NODE_TESTS = [
    "test/personaWiring.test.mjs",
    "test/quickIntakeClient.test.mjs",
    "test/progressWiring.test.mjs",
    "test/modelPickerDegrade.test.mjs",
]

AI_ACTIONS_END = "  const { startAISession, resetClarifyPicker } = ai.actions\n"
ISALIVE_ARG = "    clearQuickAttachments, closeIntake,\n    isAlive: () => instanceAlive,\n"
REF_ASSIGN = "  startAISessionRef.current = ai.actions.startAISession\n"
HOOK_DECL_ANCHOR = "  const loadSkills = useCallback(async (): Promise<void> => {\n"
ALIVE_GUARD = "if (!isAlive()) return\n"
QUICK_PERSONA_RESET = "    setQuickPersona(INHERIT_PERSONA)\n"
CLARIFY_SKILLS = "skills: [...selectedSkills]"

ALIAS_BLOCK = (
    "  const {\n"
    "    runtime, closePanel, settings, dicts, ideasAll,\n"
    "    planPromptFor, todayPlan, pickedPlan, pendingDraft,\n"
    "    clearQuickAttachments, closeIntake, isAlive, setError, setBusy,\n"
    "    loadModelModalityTable, aiSessionUsable, connectWorkspace,\n"
    "  } = input\n"
)
ALIAS_FLAT = (
    "  const {\n"
    "    runtime, closePanel, settings, dicts, ideasAll,\n"
    "    planPromptFor, pickedPlan, pendingDraft,\n"
    "    clearQuickAttachments, closeIntake, isAlive, setError, setBusy,\n"
    "    loadModelModalityTable, aiSessionUsable, connectWorkspace,\n"
    "  } = input\n"
)
START_LINE = (
    "  const startAISession = async (mode: 'clarify' | 'consult' | 'breakdown' | 'execute' | 'review' | 'plan' | 'report' | 'idea_association' | 'idea_brainstorm' | 'knowledge_doc', task: Task | null, text: string, previousSessions: Array<Record<string, unknown>> = [], docContext?: { fileLink: string; content: string; name?: string; truncated?: boolean }, workspaceOverride?: string, clarifyOptions: { attachments?: readonly QuickAttachmentDraft[]; followFolder?: boolean; persona?: PersonaSelection } = {}): Promise<void> => {\n"
)

MUTATIONS = [
    (
        "M-P6c-1 入口把 quickModelSelection 收回去自己 useState（同一状态两个 owner）",
        INDEX,
        AI_ACTIONS_END,
        AI_ACTIONS_END + "  const [quickModelSelection, setQuickModelSelectionState] = useState<QuickModelSelection | null>(() => readQuickModelSelection())\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6c-2 入口复活一份提示词弹窗的 resolve ref（弹窗回调会指到孤儿 ref）",
        INDEX,
        AI_ACTIONS_END,
        AI_ACTIONS_END + "  const promptResolveRef = useRef<((value: { text: string; skills: string[]; persona: PersonaSelection } | null) => void) | null>(null)\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6c-3 入口再定义一份 loadSkills（技能目录两个来源）",
        INDEX,
        AI_ACTIONS_END,
        AI_ACTIONS_END + "  const loadSkills = useCallback(async (): Promise<void> => {}, [])\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6c-4 入口再定义一份 startAISession（那条 468 行的动作回到装配层 = ADR-0008 原始违例）",
        INDEX,
        AI_ACTIONS_END,
        AI_ACTIONS_END + START_LINE + "    void mode\n  }\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6c-5 入口把判活回调写死成 () => true（卸载后仍会写 state）",
        INDEX,
        ISALIVE_ARG,
        "    clearQuickAttachments, closeIntake,\n    isAlive: () => true,\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6c-6 AI 会话域 hook 丢掉注入别名中的 todayPlan（搬来的函数体不再逐字一致）",
        HOOK,
        ALIAS_BLOCK,
        ALIAS_FLAT,
        [EXIT_CHECK],
    ),
    (
        "M-P6c-7 AI 会话域 hook 越界去发别的域的独占路由（域边界被打破）",
        HOOK,
        HOOK_DECL_ANCHOR,
        "  void api('/api/workbench/settings')\n" + HOOK_DECL_ANCHOR,
        [EXIT_CHECK],
    ),
    (
        "M-P6c-8 AI 会话域 hook 自己起一个定时器（本域不拥有定时器）",
        HOOK,
        HOOK_DECL_ANCHOR,
        "  setInterval(() => undefined, 1000)\n" + HOOK_DECL_ANCHOR,
        [EXIT_CHECK],
    ),
    (
        "M-P6c-9 AI 会话域 hook 直接读宿主模块级的 instanceAlive（绕过注入的判活）",
        HOOK,
        ALIVE_GUARD,
        "if (!instanceAlive) return\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6c-10 AI 会话域 hook 直接读任务域的 selected（域边界被打破）",
        HOOK,
        HOOK_DECL_ANCHOR,
        "  void selected?.task.id\n" + HOOK_DECL_ANCHOR,
        [EXIT_CHECK],
    ),
    (
        "M-P6c-11 hook 删掉「打开澄清入口就把角色复位」这一半（.mjs 行为级判据）",
        HOOK,
        QUICK_PERSONA_RESET,
        "    void 0\n",
        NODE_TESTS,
    ),
    (
        "M-P6c-12 hook 把 clarify 的 skills 硬编码成空数组（用户报过的「能选但不生效」，.mjs 判据）",
        HOOK,
        CLARIFY_SKILLS,
        "skills: []",
        NODE_TESTS,
    ),
    (
        "M-P6c-13 入口删掉惰性转发赋值（useKnowledge 拿到空 ref，AI 会话起不来）",
        INDEX,
        REF_ASSIGN,
        "",
        [EXIT_CHECK],
    ),
]


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def read(path):
    return open(path, encoding="utf-8", newline="").read()


def write(path, text):
    # 保留原文件换行风格（本仓库源码是 LF；写成 CRLF 会让 sha256 对不上）
    style = "\r\n" if "\r\n" in read(path) else "\n"
    if style == "\r\n":
        text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    open(path, "w", encoding="utf-8", newline="").write(text)


def run_checks(files):
    """跑一批判据目标；`.mjs` 走 node --test，`.py` 走 python。返回 (退出码, 红行清单)。"""
    codes = []
    fails = []
    for f in files:
        if f.endswith(".py"):
            proc = subprocess.run([sys.executable, f], capture_output=True, text=True,
                                  encoding="utf-8", errors="replace")
        else:
            proc = subprocess.run(["node", "--test", f], capture_output=True, text=True,
                                  encoding="utf-8", errors="replace")
        codes.append(proc.returncode)
        out = (proc.stdout or "") + (proc.stderr or "")
        fails += [l.strip() for l in out.splitlines() if l.strip().startswith("✖")]
    return codes, fails


# 锚点自检：START_LINE 必须真的来自 hook（否则 M-P6c-4 变异的是别的东西）
assert read(HOOK).replace("\r\n", "\n").count(START_LINE) == 1, "START_LINE 与 hook 里的真签名对不上"

targets = sorted({t for _, t, _, _, _ in MUTATIONS})
before = {p: sha(p) for p in targets}
for p, h in before.items():
    shutil.copyfile(p, BACKUP + "." + os.path.basename(p))
    print(f"基线 {p} sha256 {h}")

green = 0
try:
    for name, target, old, new, files in MUTATIONS:
        src = read(target).replace("\r\n", "\n")
        if src.count(old) != 1:
            raise SystemExit(f"ABORT [{name}] 锚点命中 {src.count(old)} 次")
        write(target, src.replace(old, new, 1))
        codes, fails = run_checks(files)
        print(f"\n== {name} ==")
        print(f"   exit={codes} 目标={files}")
        for f in fails[:4]:
            print(f"   红: {f[:110]}")
        if all(c == 0 for c in codes):
            green += 1
            print("   ❌ 变异后仍然是绿的 —— 这就是判据盲点")
        shutil.copyfile(BACKUP + "." + os.path.basename(target), target)
finally:
    for p in targets:
        shutil.copyfile(BACKUP + "." + os.path.basename(p), p)

after = {p: sha(p) for p in targets}
print()
for p in targets:
    print(f"还原后 {p} sha256 {after[p]}  一致={after[p] == before[p]}")
assert all(after[p] == before[p] for p in targets), "还原失败，必须手工恢复"

# 还原后再跑一次基线，确认是全绿的（否则"全红"可能是判据自己坏了）
codes, _ = run_checks([EXIT_CHECK] + NODE_TESTS)
print(f"\n还原后基线：exit={codes}（应全为 0）")
assert all(c == 0 for c in codes), "还原后基线不是绿的"

print(f"\n结果：{len(MUTATIONS) - green}/{len(MUTATIONS)} 条变异被断言发现")
sys.exit(1 if green else 0)
