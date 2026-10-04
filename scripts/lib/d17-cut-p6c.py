#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""D17 / P6-3 搬迁：把 AI 会话域从 src/client/index.tsx 切进 hooks/useWorkbenchAISessions.ts。

口径：
  1. 读 index.tsx（归一到 LF），按**行号切片**搬（不做括号配平 —— startAISession 有 468 行，
     切片比配平稳）。每个切片起点/终点都有守卫断言，任一条不成立就整体中止、不写文件。
  2. 抽出来的原文**逐字**填进 hook 文件的 `//@@EXTRACT:xxx@@` 标记处（两侧都是 2 空格缩进，
     所以不需要重新缩进）。唯一的两处文本改动：
       - 抽出来的文本里 `instanceAlive` 三处读数改成注入的 `isAlive()`（实时读数语义不变）；
       - 入口那行惰性转发 ref 的赋值 `= startAISession` → `= ai.actions.startAISession`。
  3. 写回源码必须 newline="\n"（P5-2 踩过：漏了会把整份 index.tsx 写成 CRLF）。
"""
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
os.chdir(ROOT)

INDEX_PATH = os.path.join("src", "client", "index.tsx")
HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchAISessions.ts")


def load(path):
    with open(path, encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


def save(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


raw = load(INDEX_PATH)
lines = raw.split("\n")
hook = load(HOOK_PATH)

problems = []


def guard(idx, fragment):
    """1-based 行号处必须含 fragment。"""
    if lines[idx - 1].find(fragment) < 0:
        problems.append(f"L{idx} 守卫不成立：期望含 {fragment!r}，实际 {lines[idx - 1][:110]!r}")


def guard_exact(idx, text):
    """1-based 行号处必须**整行等于** text（边界行用，比 guard 严）。"""
    if lines[idx - 1] != text:
        problems.append(f"L{idx} 整行守卫不成立：期望 {text!r}，实际 {lines[idx - 1][:110]!r}")


def slice_lines(lo, hi):
    """1-based 闭区间。"""
    return "\n".join(lines[lo - 1 : hi])


# ---------- 守卫：所有切片边界 ----------
guard(81, "import { useWorkbenchQuickIntake } from './hooks/useWorkbenchQuickIntake.js'")
guard_exact(214, "  /**")
guard(215, "快速录入澄清会话使用的模型")
guard(232, "const [modelModalityTable, setModelModalityTable] = useState<ReadonlyMap<")
guard_exact(233, "  // 草稿域（D17/P5-3）：7 项 state（`pendingDraft` / `deferredDrafts` / `draftProblems` /")
guard_exact(335, "  const [promptModal, setPromptModal] = useState<{ title: string; value: string } | null>(null)")
guard_exact(381, "  }")
guard(382, "// 任务数据域（D17/P3-4）：`selectedRef`、四个只读派生")
guard_exact(389, "  /**")
guard(390, "技能目录：打开提示词弹窗时按需拉取一次")
guard_exact(417, "  }, [])")
guard_exact(419, "  /**")
guard(420, "D17 / P1：知识域")
guard_exact(535, "  /**")
guard(536, "共享提示词弹窗（9 个 mode 的**同一入口**）")
guard(609, "const startAISession = async (mode:")
guard_exact(1079, "  }")
guard_exact(1080, "  /**")
guard(1081, "D17：把 `startAISession` 交给知识域 hook")
guard_exact(1084, "  startAISessionRef.current = startAISession")
guard_exact(1086, "  /**")
guard(1087, "复用型会话：计划/报告/点子关联/点子头脑风暴")
guard_exact(1156, "  }")
guard_exact(1393, "  } = day.actions")
guard_exact(1550, "    openIntake()")
guard_exact(1551, "    /**")
guard(1552, "每次打开都把角色复位成「未指定」")
guard_exact(1566, "    void loadSkills()")
guard_exact(1567, "  }")

if problems:
    print("✖ 守卫失败，未写任何文件：")
    for p in problems:
        print("  " + p)
    sys.exit(1)

# ---------- 抽取 ----------
state_a = slice_lines(214, 232)
state_b = slice_lines(335, 381)
load_skills = slice_lines(389, 417)
d1 = slice_lines(535, 1079)
d2 = slice_lines(1086, 1156)

# `instanceAlive` → 注入的 `isAlive()`（三处 await 之后的实时读数）
before = d1
d1 = d1.replace("if (!instanceAlive) return", "if (!isAlive()) return")
d1 = d1.replace("if (instanceAlive) setError(", "if (isAlive()) setError(")
d1 = d1.replace("if (instanceAlive) setBusy(false)", "if (isAlive()) setBusy(false)")
if d1 == before:
    problems.append("d1 里没有出现 instanceAlive 的可替换读数（预期三处）")
if d1.count("isAlive()") != 3:
    problems.append(f"d1 里 isAlive() 出现 {d1.count('isAlive()')} 次（预期 3 次）")
if "instanceAlive" in d1:
    problems.append("d1 里仍有未替换的 instanceAlive")

if problems:
    print("✖ 抽取阶段失败，未写任何文件：")
    for p in problems:
        print("  " + p)
    sys.exit(1)

# ---------- 入口里的指针注释 ----------
pointer_a = "\n".join([
    "  // AI 会话域（D17/P6-3）：`quickModelSelection`（含写 localStorage 的包装 setter）与",
    "  // `modelModalityTable` 已收进 hooks/useWorkbenchAISessions.ts（连同「模型是这次会话怎么跑、",
    "  // 不是任务属性」与「能力表拉不到就 fail open」两条原注释）。",
])

pointer_b = "\n".join([
    "  // AI 会话域（D17/P6-3）：`promptModal` / `promptResolveRef` / `skillCatalog` / `skillsAvailable` /",
    "  // `skillsLoading` / `skillProblem` / `skillQuery` / `selectedSkills` / `promptPersona` /",
    "  // `quickPersona` / `promptModelSelection`（含包装 setter）10 项 state + 1 个 ref 已收进",
    "  // hooks/useWorkbenchAISessions.ts。四条不许动的语义随原注释一起搬走（空目录必须报可恢复故障 /",
    "  // 三个角色状态位语义不同不许合并 / 两个弹窗共用同一份模型持久化）。",
])

pointer_c = "\n".join([
    "  // AI 会话域（D17/P6-3）：技能目录装载（`loadSkills`，`useCallback(…, [])`）已收进",
    "  // hooks/useWorkbenchAISessions.ts，连同原注释 —— 空目录必须报成可恢复故障、不许整块隐藏。",
])

pointer_d = "\n".join([
    "  // AI 会话域（D17/P6-3）：共享提示词弹窗（`askUserPrompt` / `confirmPrompt` / `cancelPrompt` /",
    "  // `toggleSkill` / `AI_PROMPT_LABELS`）、会话面板切换（`openSessionInPanel`）、",
    "  // **468 行的 `startAISession`** 与复用判定 `reuseAiSessionId` 已收进",
    "  // hooks/useWorkbenchAISessions.ts（连同全部原注释：复用三判据 / `workspaceOverride` 语义 /",
    "  // `clarifyOptions`）。那个 hook 的调用点在 `day`（日期域）之后、`dayPanelProps` 之前。",
    "  // ⚠️ 原来紧跟 `startAISession` 的那行 `startAISessionRef.current = startAISession`",
    "  //（惰性转发 ref 的赋值）**必须留在装配层**，且只能排在 hook 调用之后 ——",
    "  // 因为 `ai.actions.startAISession` 在那里才存在（`const` 没有提升）。见下方 hook 调用块。",
])

hook_call = "\n".join([
    "  // AI 会话域（D17/P6-3）：12 项 state + 1 个 ref（`promptResolveRef`）+ 9 个动作已收进",
    "  // hooks/useWorkbenchAISessions.ts。",
    "  // ⚠️ 落点必须在 `day`（日期域的 `planPromptFor` / `todayPlan` / `pickedPlan`）之后、",
    "  // `dayPanelProps` 与 `openQuickEntry` 之前 —— 两边都以注入形式用它（`const` 没有提升）。",
    "  // `useKnowledge` 仍走上面那个惰性转发 ref，所以它的入参一个字都不用改。",
    "  const ai = useWorkbenchAISessions({",
    "    runtime, closePanel, settings, dicts, ideasAll,",
    "    planPromptFor, todayPlan, pickedPlan, pendingDraft,",
    "    clearQuickAttachments, closeIntake,",
    "    isAlive: () => instanceAlive,",
    "    setError, setBusy,",
    "    loadModelModalityTable, aiSessionUsable, connectWorkspace,",
    "  })",
    "  const {",
    "    quickModelSelection, modelModalityTable, promptModal, skillCatalog, skillsAvailable, skillsLoading,",
    "    skillProblem, selectedSkills, promptPersona, quickPersona, promptModelSelection,",
    "  } = ai",
    "  const {",
    "    setQuickModelSelection, setModelModalityTable, setPromptModal, setPromptPersona, setQuickPersona,",
    "    setPromptModelSelection, loadSkills, confirmPrompt, cancelPrompt, toggleSkill,",
    "    openSessionInPanel, startAISession, resetClarifyPicker,",
    "  } = ai.actions",
    "  /**",
    "   * D17：把 `startAISession` 交给知识域 hook（`useKnowledge` 在组件上部调用，那时它还没声明）。",
    "   * 这里是**普通赋值**，不是 hook 调用 —— 不改变 hook 顺序，也不额外触发渲染。",
    "   */",
    "  startAISessionRef.current = ai.actions.startAISession",
])

open_quick = "\n".join([
    "    // AI 会话域（D17/P6-3）：角色复位（AX-R07 的前提：默认必须是「未指定」）+ 技能复位 +",
    "    // 重拉技能目录 —— 三件事已收进 hooks/useWorkbenchAISessions.ts 的 `resetClarifyPicker()`",
    "    // （原注释随它搬走：为什么每次打开都要拉一次技能目录）。",
    "    resetClarifyPicker()",
])

import_line = "import { useWorkbenchAISessions } from './hooks/useWorkbenchAISessions.js'"

# ---------- 拼装新 index.tsx ----------
parts = [
    slice_lines(1, 81),
    import_line,
    slice_lines(82, 213),
    pointer_a,
    slice_lines(233, 334),
    pointer_b,
    slice_lines(382, 388),
    pointer_c,
    slice_lines(418, 534),
    pointer_d,
    slice_lines(1157, 1393),
    hook_call,
    slice_lines(1394, 1550),
    open_quick,
    slice_lines(1567, len(lines)),
]
new_index = "\n".join(parts)

# ---------- 填 hook 文件的标记 ----------
for name, body in [("stateA", state_a), ("stateB", state_b), ("loadSkills", load_skills), ("d1", d1), ("d2", d2)]:
    marker = "  //@@EXTRACT:%s@@" % name
    if marker not in hook:
        problems.append(f"hook 文件里找不到标记 {marker!r}")
        continue
    hook = hook.replace(marker, body)

if problems:
    print("✖ 拼装阶段失败，未写任何文件：")
    for p in problems:
        print("  " + p)
    sys.exit(1)

# ---------- 收尾自检 ----------
for banned in [
    "const startAISession = async",
    "const reuseAiSessionId = async",
    "const loadSkills = useCallback",
    "const askUserPrompt = ",
    "const confirmPrompt = ",
    "const cancelPrompt = ",
    "const toggleSkill = ",
    "const AI_PROMPT_LABELS",
    "const openSessionInPanel = ",
    "const [promptModal, setPromptModal]",
    "const [skillCatalog, setSkillCatalog]",
    "const [skillsAvailable, setSkillsAvailable]",
    "const [skillsLoading, setSkillsLoading]",
    "const [skillProblem, setSkillProblem]",
    "const [skillQuery, setSkillQuery]",
    "const [selectedSkills, setSelectedSkills]",
    "const [promptPersona, setPromptPersona]",
    "const [quickPersona, setQuickPersona]",
    "const [quickModelSelection, setQuickModelSelectionState]",
    "const [promptModelSelection, setPromptModelSelectionState]",
    "const [modelModalityTable, setModelModalityTable]",
    "const promptResolveRef = useRef",
    "setSelectedSkills([])",
    "setSkillQuery('')",
]:
    if banned in new_index:
        problems.append(f"入口里仍有本域声明/调用：{banned!r}")

for needed in [
    "const ai = useWorkbenchAISessions({",
    "startAISessionRef.current = ai.actions.startAISession",
    "    resetClarifyPicker()",
    import_line,
]:
    if needed not in new_index:
        problems.append(f"入口里缺少预期接线：{needed!r}")

for needed in [
    "export function useWorkbenchAISessions(",
    "const startAISession = async (mode:",
    "const reuseAiSessionId = async (",
    "const loadSkills = useCallback(async (): Promise<void> => {",
    "const askUserPrompt = ",
    "const AI_PROMPT_LABELS: Record<string, string> = {",
    "const resetClarifyPicker = (): void => {",
    "if (!isAlive()) return",
]:
    if needed not in hook:
        problems.append(f"hook 文件里缺少预期内容：{needed!r}")

if "//@@EXTRACT:" in hook:
    problems.append("hook 文件里还有未替换的标记")

if problems:
    print("✖ 收尾自检失败，未写任何文件：")
    for p in problems:
        print("  " + p)
    sys.exit(1)

save(INDEX_PATH, new_index)
save(HOOK_PATH, hook)

print("✔ P6-3 搬迁完成")
print(f"  index.tsx：{len(lines)} 行 → {len(new_index.split(chr(10)))} 行")
print(f"  hook 文件：{len(hook.split(chr(10)))} 行")
print(f"  抽取：stateA {len(state_a.split(chr(10)))} 行 / stateB {len(state_b.split(chr(10)))} 行 / "
      f"loadSkills {len(load_skills.split(chr(10)))} 行 / d1 {len(d1.split(chr(10)))} 行 / d2 {len(d2.split(chr(10)))} 行")
