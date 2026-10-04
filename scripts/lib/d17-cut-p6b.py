# -*- coding: utf-8 -*-
"""D17 / P6-2 一次性搬迁：把**快速录入域**（8 项 state + 2 个 ref + 7 个动作 + 那条卸载清理 effect）
从 src/client/index.tsx 切进 hooks/useWorkbenchQuickIntake.ts。

纪律同 P4/P5-x：
  ① **只换来源、不改调用点文本** —— 入口从 `quick` / `quick.actions` 解构出与原来同名的值，
     所以 JSX 里 `value={quickText}`、`onChange={(e) => setQuickText(e.target.value)}`、
     `onClick={() => void forgetQuickWorkspace(quickWorkspace)}`、
     `shouldRememberQuickWorkspace(quickWorkspaceTouched, chosen)`、
     `void rememberQuickWorkspace(chosen)`、`addQuickAttachments(files)`、
     `removeQuickAttachment(item.id)`、`clearQuickAttachments()`、`quickImageInputRef` … 一个字都不用动。
  ② 只有 4 处刻意改成**语义化入口**（它们都是"两连 setState"或"关弹窗+清附件"的成组动作）：
     `setShowQuick(false)` → `closeIntake()` / `{ clearQuickAttachments(); setShowQuick(false) }` → `cancelIntake()` /
     `{ setQuickWorkspaceTouched(true); setQuickWorkspace(path) }` → `overrideWorkspace(path)`（与装配层
     `applyWorkspaceDir` 里那一对**合并成同一个动作**，消掉一处"同一语义两遍写"）。
  ③ 模块级小工具（`newTaskId` / `fileToBase64` / `quickImageToPromptPart`）搬到新的纯模块
     `src/client/intakeHelpers.ts` —— 它们被快速录入域与（P6-3 的）AI 会话域**共同**使用，
     而 hook 不能 import 入口（会成环）。`detectWslHost` 仍留入口尾部，以**注入**形式进 hook。

房屋风格同 d17-cut-p4.py / p5a.py / p5b.py / p5c.py / p6a.py：所有断言先跑完，problems 为空才落盘。
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "src" / "client" / "index.tsx"

problems: list[str] = []


def replace_once(text: str, old: str, new: str, label: str) -> str:
    n = text.count(old)
    if n != 1:
        problems.append(f"{label}: 期望恰好 1 处，实际 {n} 处")
        return text
    return text.replace(old, new, 1)


def cut_between(text: str, start: str, end: str, new: str, label: str) -> str:
    a = text.count(start)
    b = text.count(end)
    if a != 1:
        problems.append(f"{label}: 起始标记出现 {a} 次（期望 1）")
        return text
    if b != 1:
        problems.append(f"{label}: 结束标记出现 {b} 次（期望 1）")
        return text
    i = text.find(start)
    j = text.find(end)
    if j < i:
        problems.append(f"{label}: 结束标记在起始标记之前")
        return text
    return text[:i] + new + text[j + len(end):]


src = INDEX.read_text(encoding="utf-8")
before_lines = src.count("\n") + 1
text = src.replace("\r\n", "\n")

# ---------------------------------------------------------------- ① import 新 hook 与新纯模块
text = replace_once(
    text,
    "import { useWorkbenchBusy } from './hooks/useWorkbenchBusy.js'\n",
    "import { useWorkbenchBusy } from './hooks/useWorkbenchBusy.js'\n"
    "import { useWorkbenchQuickIntake } from './hooks/useWorkbenchQuickIntake.js'\n",
    "import 快速录入域 hook",
)
text = replace_once(
    text,
    "import { withSettingsFallback } from './settingsFallback.js'\n",
    "import { withSettingsFallback } from './settingsFallback.js'\n"
    "// 快速录入域（D17/P6-2）：三个浏览器侧小工具搬进纯模块 —— 快速录入域与 AI 会话域共用。\n"
    "import { newTaskId, quickImageToPromptPart } from './intakeHelpers.js'\n",
    "import intakeHelpers",
)

# ---------------------------------------------------------------- ② 搬走 newTaskId（模块级）
text = cut_between(
    text,
    "/**\n * 生成一个任务 id。\n",
    "  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`\n}\n\n",
    "",
    "搬走 newTaskId",
)

# ---------------------------------------------------------------- ③ 搬走 fileToBase64 与 quickImageToPromptPart
text = cut_between(
    text,
    "/** 图片文件 → 宿主 `PromptContentPart`（base64 不带 data URL 前缀）。 */\n",
    "    ...(image.file.name === '' ? {} : { name: image.file.name }),\n  }\n}\n",
    "",
    "搬走 fileToBase64 / quickImageToPromptPart",
)

# ---------------------------------------------------------------- ④ 搬走 8 项 state + 2 个 ref + 两个内部写入点
text = cut_between(
    text,
    "  const [showQuick, setShowQuick] = useState(false)\n",
    "  const appendQuickAttachments = (drafts: QuickAttachmentDraft[]): void => {\n"
    "    writeQuickAttachments([...quickAttachmentsRef.current, ...drafts])\n  }\n",
    "  // 快速录入域（D17/P6-2）：8 项 state（`showQuick` / `quickText` / `quickWorkspace` /\n"
    "  // `quickWorkspaceTouched` / `quickWorkspaceSource` / `quickFollowFolder` / `quickAttachments` /\n"
    "  // `quickAttachmentNotice`）、两个 ref（`quickImageInputRef` 与附件镜像 ref）、\n"
    "  // 两个内部写入点与 7 个动作已收进 hooks/useWorkbenchQuickIntake.ts。\n"
    "  // 四条不许动的语义（预填值只由偏好+系统配置决定 / 只有用户动过才记进最近 / 不收的附件要说原因 /\n"
    "  // ref 与 state 的一致性靠构造保证）随原注释一起搬进了 hook 文件头。\n",
    "搬走快速录入 state 与 ref",
)

# ---------------------------------------------------------------- ⑤ hook 调用点（紧跟设置域解构之后）
text = replace_once(
    text,
    "  } = prefs.actions\n",
    "  } = prefs.actions\n"
    "  // 快速录入域（D17/P6-2）：调用点必须在 `prefs`（设置域）之后 —— `settings` / `setSettings`\n"
    "  // 与 `setError` 都是以注入形式进来的。`detectWslHost` 是入口尾部那个模块级纯函数，\n"
    "  // 以注入形式交给 hook（hook import 入口会成环），所以 hook 里的实参文本与拆分前逐字一致。\n"
    "  const quick = useWorkbenchQuickIntake({ runtime, settings, setSettings, detectWslHost, onError: setError })\n"
    "  const {\n"
    "    showQuick, quickText, quickWorkspace, quickWorkspaceTouched, quickWorkspaceSource,\n"
    "    quickFollowFolder, quickAttachments, quickAttachmentNotice, quickImageInputRef,\n"
    "  } = quick\n"
    "  const {\n"
    "    setQuickText, setQuickFollowFolder, openIntake, closeIntake, cancelIntake, overrideWorkspace,\n"
    "    rememberQuickWorkspace, forgetQuickWorkspace,\n"
    "    addQuickAttachments, removeQuickAttachment, clearQuickAttachments,\n"
    "  } = quick.actions\n",
    "快速录入域 hook 调用点",
)

# ---------------------------------------------------------------- ⑥ 目录选择 sink 里那一对写入合成同一个动作
text = replace_once(
    text,
    "    if (target === 'quick') { setQuickWorkspace(picked); setQuickWorkspaceTouched(true); return }\n",
    "    if (target === 'quick') { overrideWorkspace(picked); return }\n",
    "applyWorkspaceDir 的 quick 分支改用 overrideWorkspace",
)

# ---------------------------------------------------------------- ⑦ 搬走投影函数（先摘它那段悬空注释，再摘函数本体）
# ⚠️ 那段注释与 `workspaceChoices` 的注释是**相邻两个** doc block，不能连着一刀切 ——
#    中间夹着 `workspaceChoices` 的注释与实现（它留在入口）。
text = cut_between(
    text,
    "  /**\n   * 把一份判定结果投影到工作区那几个状态上（预填路径 / 来源提示 / 是否手动改过 / 建资料夹默认勾选）。\n",
    "   * 建资料夹的判据走 `quickFollowFolderDefault()`，与判定模块同一处口径。\n   */\n",
    "",
    "摘掉投影函数那段悬空注释",
)
text = cut_between(
    text,
    "  const applyQuickWorkspaceDecision = (decided: QuickWorkspaceDefaultDecision, autoCreateTypeFolders: boolean): void => {\n",
    "    setQuickFollowFolder(quickFollowFolderDefault(decided.path, autoCreateTypeFolders))\n  }\n",
    "  // 快速录入域（D17/P6-2）：投影函数（预填路径 / 来源提示 / 是否手动改过 / 建资料夹默认勾选）\n"
    "  // 已收进 hooks/useWorkbenchQuickIntake.ts 的 `applyDecision` ——\n"
    "  // 它与「打开弹窗」「不再记住这个目录」两处共用同一份投影，仍是唯一实现。\n",
    "搬走 applyQuickWorkspaceDecision",
)

# ---------------------------------------------------------------- ⑧ openQuickEntry：拆成装配层组合
text = cut_between(
    text,
    "  /**\n   * 打开「快速录入」并把工作区选择**重置成稳定默认值**。\n",
    "    void loadSkills()\n    setShowQuick(true)\n  }\n",
    "  /**\n"
    "   * 打开「快速录入」：**跨域组合，归装配层**。\n"
    "   *\n"
    "   * 拆分前这是入口里的单个函数（工作区预填 + 清空输入 + 角色复位 + 技能复位 + 打开弹窗）。\n"
    "   * 两半分给两个域之后，这里只按原顺序拼起来：① 快速录入域的 `openIntake()`（预填判定 + 清空输入\n"
    "   * + 打开弹窗）；② AI 会话域的复位（角色 + 技能 + 重拉技能目录，见下方 `resetClarifyPicker`，P6-3）。\n"
    "   */\n"
    "  const openQuickEntry = (): void => {\n"
    "    openIntake()\n"
    "    /**\n"
    "     * 每次打开都把角色复位成「未指定」：上一次误点过的角色不该**静默**成为这一次的选择\n"
    "     * （默认值必须是\"无角色 / 不改变原有行为\"，这是 AX-R07 的前提）。\n"
    "     */\n"
    "    setQuickPersona(INHERIT_PERSONA)\n"
    "    /**\n"
    "     * 技能同理（2026-10-01）：每次打开都复位选择并**拉一次技能目录**。\n"
    "     *\n"
    "     * 为什么必须在这里拉：`loadSkills()` 原来只在 `askUserPrompt`（共享提示词弹窗）里调，\n"
    "     * 而快速录入从不走那个入口 —— 于是快速录入里的技能块永远是\"暂不可用\"或空的\n"
    "     * （用户反馈的\"快速录入无法选择 SKill\"有一半是这个）。与角色一样，\n"
    "     * 上一次的选择不该静默成为这一次的（默认=不注入技能）。\n"
    "     */\n"
    "    setSelectedSkills([])\n"
    "    setSkillQuery('')\n"
    "    void loadSkills()\n"
    "  }\n",
    "openQuickEntry 拆成跨域组合",
)

# ---------------------------------------------------------------- ⑨ 搬走 remember / forget / 附件三函数 + 卸载 effect
text = cut_between(
    text,
    "  /**\n   * 记住这次用过的工作区（写进设置，最新的排最前）。\n",
    "    quickAttachmentsRef.current = []\n  }, [])\n",
    "  // 快速录入域（D17/P6-2）：`rememberQuickWorkspace` / `forgetQuickWorkspace`（两个写设置的点，\n"
    "  // 走注入的 `setSettings`，设计 §5）与 `addQuickAttachments` / `removeQuickAttachment` /\n"
    "  // `clearQuickAttachments` 及那条卸载时释放图片 object URL 的 effect，已收进\n"
    "  // hooks/useWorkbenchQuickIntake.ts（连同它们的原注释：置顶去重、基准取服务端现值、\n"
    "  // 不收的附件要给中文原因、图片三处都要 revokeObjectURL）。\n",
    "搬走 remember/forget/附件三函数与卸载 effect",
)

# ---------------------------------------------------------------- ⑩ JSX 三处成组动作
text = replace_once(
    text,
    "          onClose={() => setShowQuick(false)}\n",
    "          onClose={closeIntake}\n",
    "JSX：Modal.onClose 改用 closeIntake",
)
text = replace_once(
    text,
    "              <button className=\"wb-btn\" onClick={() => { clearQuickAttachments(); setShowQuick(false) }}>取消</button>\n",
    "              <button className=\"wb-btn\" onClick={cancelIntake}>取消</button>\n",
    "JSX：取消按钮改用 cancelIntake",
)
text = replace_once(
    text,
    "            onChange={(path) => { setQuickWorkspaceTouched(true); setQuickWorkspace(path) }}\n",
    "            onChange={overrideWorkspace}\n",
    "JSX：WorkspacePicker.onChange 改用 overrideWorkspace",
)

# ---------------------------------------------------------------- 收尾自检（搬家后入口不该再有的东西）
if not problems:
    for needle in (
        "setQuickWorkspace(", "setQuickWorkspaceTouched(", "setQuickWorkspaceSource(",
        "setQuickAttachmentNotice(", "writeQuickAttachments",
        "quickAttachmentsRef", "appendQuickAttachments", "applyQuickWorkspaceDecision",
        "const [showQuick", "const addQuickAttachments", "const removeQuickAttachment",
        "const clearQuickAttachments", "const rememberQuickWorkspace", "const forgetQuickWorkspace",
        "function newTaskId", "function fileToBase64", "function quickImageToPromptPart",
    ):
        n = text.count(needle)
        if n != 0:
            problems.append(f"搬家后入口仍有 {needle!r}：{n} 处")
    for needle in (
        "const quick = useWorkbenchQuickIntake({",
        "setQuickText, setQuickFollowFolder, openIntake, closeIntake, cancelIntake, overrideWorkspace,",
        "const openQuickEntry = (): void => {",
        "onClose={closeIntake}",
        "onClick={cancelIntake}",
        "onChange={overrideWorkspace}",
    ):
        if needle not in text:
            problems.append(f"搬家后入口缺少 {needle!r}")

if problems:
    print("✖ 裁切未执行，存在以下问题：")
    for p in problems:
        print(f"   - {p}")
    raise SystemExit(1)

after_lines = text.count("\n") + 1
if src.count("\r\n") != 0:
    print("✖ 源文件不是纯 LF，停止（避免把换行风格写坏）")
    raise SystemExit(1)
INDEX.write_text(text, encoding="utf-8", newline="\n")
print(f"\u2705 index.tsx: {before_lines} -> {after_lines} 行")
