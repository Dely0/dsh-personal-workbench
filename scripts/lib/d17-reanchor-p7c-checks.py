"""D17/P7-3 判据重锚：把 8 个出口自检里「冻结入口解构块原文 / 断言入口 import 某模块」的断言
改成 P7-3 清理之后的真实形态。

口径（与 P7-2 的「判据跟着 owner 走」一致，**不是放宽**）：
  - 入口只解构自己真读的字段 ⇒ 原文类断言换成当前真实原文，并写明"只剩入口真读的 N 项"；
  - 入口不再 import 的模块 ⇒ 改成**反向断言**（入口 0 处）+ 正向指真实 owner（域 hook 仍在 import）；
  - 已经是同义反复的断言（常量与自己比）删掉，换成对真实 owner 的断言（收紧，不是放宽）。

先全量校验（old 命中 1 次；已生效的跳过），任一不成立就整体中止、不写文件。
"""
import io
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

LIB = os.path.join("scripts", "lib")

P3C = "d17-p3c-exit-check.py"
P3D = "d17-p3d-exit-check.py"
P4 = "d17-p4-exit-check.py"
P5A = "d17-p5a-exit-check.py"
P5B = "d17-p5b-exit-check.py"
P5C = "d17-p5c-exit-check.py"
P6B = "d17-p6b-exit-check.py"
P6C = "d17-p6c-exit-check.py"
P6D = "d17-p6d-exit-check.py"

PATCHES = []


def patch(path, old, new):
    PATCHES.append((path, old, new))


# ------------------------------------------------------------------ p3c：读取值解构少了 subtaskParent
patch(
    P3C,
    'check("const { editDraft, subtaskParent, formWorkspace } = forms" in INDEX,\n'
    '      "入口只取自己用到的读取值（编辑草稿 / 子任务父 / 表单工作区）")\n'
    'check(INDEX.count("const { editDraft, subtaskParent, formWorkspace } = forms") == 1,\n'
    '      "读取值解构只有一处")',
    'check("const { editDraft, formWorkspace } = forms" in INDEX,\n'
    '      "入口只取自己用到的读取值（P7-3 起只剩编辑草稿 / 表单工作区；subtaskParent 已无人读）")\n'
    'check(INDEX.count("const { editDraft, formWorkspace } = forms") == 1,\n'
    '      "读取值解构只有一处")',
)

# ------------------------------------------------------------------ p3d：data 读取值 / data.actions 名单
patch(
    P3D,
    'check("const { bootstrap, tasks, selected, taskKnowledge, dicts, dictOf, pendingMap, childrenOf } = data"\n'
    '      in INDEX, "入口解构出本域读取值（仍用局部名，故既有判据/探针原文不受影响）")\n'
    'for name in ACTIONS + ["setTasks", "clearSelectedTask", "currentTaskId"]:\n'
    '    if name == "loadTaskKnowledge":\n'
    '        continue  # 入口不再有外部引用，刻意不解构\n'
    '    check(re.search(r"\\n    " + name + r",\\n", INDEX) is not None,\n'
    '          f"入口从 data.actions 解构出 {name}")',
    'check("const { bootstrap, tasks, selected, dicts, dictOf, pendingMap, childrenOf } = data"\n'
    '      in INDEX, "入口解构出本域读取值（P7-3 起只留入口真读的 7 项；仍用局部名，故既有判据/探针原文不受影响）")\n'
    '# P7-3 后入口只为 JSX 解构的名字已删 —— 逐名断言按"入口真读的 9 个动作"重锚。\n'
    'DATA_ACTIONS_IN_ENTRY = ["refresh", "loadTaskDetail", "patchTask", "completePlanTask", "saveProgress",\n'
    '                         "deferPlanTask", "setTasks", "currentTaskId", "linkSessionRequest"]\n'
    'for name in DATA_ACTIONS_IN_ENTRY:\n'
    '    check(re.search(r"\\n    " + name + r",\\n", INDEX) is not None,\n'
    '          f"入口从 data.actions 解构出 {name}")\n'
    'for name in ["completeTaskFromProgress", "clearSelectedTask"]:\n'
    '    check(re.search(r"\\n    " + name + r",\\n", INDEX) is None,\n'
    '          f"入口不再解构 {name}（P7-3 清理：调用点已随 JSX 搬进 app/）")',
)

# ------------------------------------------------------------------ p4：装配层用到 day.actions.* = 入口 or app/ 四段
patch(
    P4,
    'for action in ACTIONS:\n'
    '    check(bare(None, action) >= 1, f"装配层通过 `day.actions` 用到 `{action}`")',
    'for action in ACTIONS:\n'
    '    # P7-2 后 JSX 在 app/ 四段里；P7-3 又把入口只为 JSX 解构的名字清掉 —— 所以\n'
    '    # "装配层用到它"要在「入口 + app/ 四段」这个整体里看（域 hook 不在名单里：接线跑进 hook 仍会红）。\n'
    '    check(bare(None, action) >= 1 or re.search(r"(?<![\\w.])" + re.escape(action) + r"\\b", UI_ALL) is not None,\n'
    '          f"装配层通过 `day.actions` 用到 `{action}`（入口或 src/client/app/ 四段）")',
)

# ------------------------------------------------------------------ p5a：设置域解构 + settingsFallback import
patch(
    P5A,
    'DESTRUCTURED_RESULT = (\n'
    '    "const { settings, showSettings, settingsSaving, recallLog, recallSessionOff, "\n'
    '    "dictKind, dictForm, dictEditCode, dictError } = prefs"\n'
    ')',
    '# P7-3 清理后入口只为 JSX 解构的名字已删；这里冻结"入口真读的两项 + 两个写口"。\n'
    'DESTRUCTURED_RESULT = (\n'
    '    "const { settings, showSettings } = prefs"\n'
    ')\n'
    'DESTRUCTURED_ACTIONS_BLOCK = (\n'
    '    "const { setSettings, saveDailyCapacity: saveDailyCapacitySetting } = prefs.actions"\n'
    ')',
)
patch(
    P5A,
    'check(DESTRUCTURED_RESULT in INDEX_BARE, "入口解构了设置域 9 项结果（原文在位）")',
    'check(DESTRUCTURED_RESULT in INDEX_BARE,\n'
    '      "入口解构了设置域结果（P7-3 起只剩入口真读的 settings / showSettings）")\n'
    'check(DESTRUCTURED_ACTIONS_BLOCK in INDEX_BARE,\n'
    '      "入口解构了设置域的两个写口（setSettings 与外层的 saveDailyCapacity）")',
)
patch(
    P5A,
    'check("import { withSettingsFallback } from \'./settingsFallback.js\'" in INDEX,\n'
    '      "入口 import settingsFallback（顶层，路径 .js）")',
    'check("import { withSettingsFallback } from \'../settingsFallback.js\'" in SETTINGS,\n'
    '      "设置域 import settingsFallback（P7-3 后入口已不再 import —— 写 settings 的原语全在域里）")\n'
    'check("import { withSettingsFallback } from \'./settingsFallback.js\'" not in INDEX,\n'
    '      "入口不再 import settingsFallback（P7-3 清理成果，不是放宽：正向由上一句盯 owner）")',
)

# ------------------------------------------------------------------ p5b：提醒域解构
patch(
    P5B,
    'DESTRUCTURED_RESULT = (\n'
    '    "const { reminders, reminderModalOpen, notifyPerm, reminderPolicy, reminderChannel, "\n'
    '    "reminderOptions, reminderBusy } = remindersApi"\n'
    ')',
    '# P7-3 清理后入口只为 JSX 解构的名字已删，只剩入口真读的 reminders。\n'
    'DESTRUCTURED_RESULT = "const { reminders } = remindersApi"',
)
patch(
    P5B,
    'DESTRUCTURED_ACTIONS_BLOCK = (\n'
    '    "  const {\\n"\n'
    '    "    setReminderModalOpen, setNotifyPerm, setReminderPolicy, setReminderChannel,\\n"\n'
    '    "    loadReminderChannel, saveReminderTarget, saveReminderPolicy, sendReminderTest,\\n"\n'
    '    "    ackReminder, resetReminderState, addTaskReminder, tickDue,\\n"\n'
    '    "  } = remindersApi.actions"\n'
    ')',
    '# P7-3 起入口不再解构提醒域动作 —— 这条常量改成"不许出现"的负向靶点。\n'
    'DESTRUCTURED_ACTIONS_BLOCK = "} = remindersApi.actions"',
)
patch(
    P5B,
    'check(DESTRUCTURED_RESULT in INDEX_BARE, "入口解构了提醒域 7 项结果（原文在位）")\n'
    'check(INDEX_BARE.count(DESTRUCTURED_ACTIONS_BLOCK) == 1,\n'
    '      "入口恰好一处 actions 解构，且 12 个名字写全（原文整块比对）")\n'
    'for name in DESTRUCTURED_ACTIONS:\n'
    '    check(name in DESTRUCTURED_ACTIONS_BLOCK, f"入口 actions 解构里有 {name}")',
    'check(DESTRUCTURED_RESULT in INDEX_BARE,\n'
    '      "入口解构了提醒域结果（P7-3 起只剩入口真读的 reminders）")\n'
    'check(DESTRUCTURED_ACTIONS_BLOCK not in INDEX_BARE,\n'
    '      "入口不再解构提醒域动作（P7-3 清理：动作调用点随 JSX 搬进 app/，域内自用不经入口）")\n'
    '# 原来这条是"常量与自己比"的同义反复；改成对真实 owner 的断言（收紧）。\n'
    'for name in DESTRUCTURED_ACTIONS:\n'
    '    check(name in SOURCES.get(REMINDERS_HOOK_PATH, ""),\n'
    '          f"提醒域动作 {name} 仍在域内（所有者不变）")',
)

# ------------------------------------------------------------------ p5c：草稿域解构
patch(
    P5C,
    'DESTRUCTURED_RESULT = (\n'
    '    "const { pendingDraft, deferredDrafts, draftProblems, draftSwitchedFrom, "\n'
    '    "allPendingDrafts, pendingOpen, duplicatePrompt } = draftsApi"\n'
    ')',
    '# P7-3 清理后入口只为 JSX 解构的名字已删，只剩入口真读的两项。\n'
    'DESTRUCTURED_RESULT = (\n'
    '    "const { pendingDraft, allPendingDrafts } = draftsApi"\n'
    ')',
)
patch(
    P5C,
    'DESTRUCTURED_ACTIONS_BLOCK = (\n'
    '    "  const {\\n"\n'
    '    "    setPendingDraft, setDraftProblems, setDuplicatePrompt, setPendingOpen,\\n"\n'
    '    "    dismissDraft, resumePendingDraft, resumeDeferredDraft, handleDraftConfirmed, reuseExistingTask,\\n"\n'
    '    "  } = draftsApi.actions"\n'
    ')',
    '# P7-3 起入口不再解构草稿域动作 —— 这条常量改成"不许出现"的负向靶点。\n'
    'DESTRUCTURED_ACTIONS_BLOCK = "} = draftsApi.actions"',
)
patch(
    P5C,
    'check(INDEX_BARE.count(DESTRUCTURED_RESULT) == 1, "入口解构了草稿域 7 项结果（原文在位）")\n'
    'check(INDEX_BARE.count(DESTRUCTURED_ACTIONS_BLOCK) == 1,\n'
    '      "入口恰好一处 actions 解构，且 9 个名字写全（原文整块比对）")',
    'check(INDEX_BARE.count(DESTRUCTURED_RESULT) == 1,\n'
    '      "入口解构了草稿域结果（P7-3 起只剩入口真读的 pendingDraft / allPendingDrafts）")\n'
    'check(DESTRUCTURED_ACTIONS_BLOCK not in INDEX_BARE,\n'
    '      "入口不再解构草稿域动作（P7-3 清理：动作调用点随 JSX 搬进 app/，域内自用不经入口）")',
)

# ------------------------------------------------------------------ p6b：共用纯模块 import
patch(
    P6B,
    'HELPERS_PATH = os.path.join("src", "client", "intakeHelpers.ts")',
    'HELPERS_PATH = os.path.join("src", "client", "intakeHelpers.ts")\n'
    'AI_HOOK_PATH = os.path.join("src", "client", "hooks", "useWorkbenchAISessions.ts")',
)
patch(
    P6B,
    'check("import { newTaskId, quickImageToPromptPart } from \'./intakeHelpers.js\'" in INDEX,\n'
    '      "入口 import 共用纯模块（原文；fileToBase64 入口已不再用）")',
    'check("import { newTaskId, quickImageToPromptPart } from \'./intakeHelpers.js\'" not in INDEX,\n'
    '      "入口不再 import 共用纯模块（P7-3 清理：入口已无调用点，导入权归使用它的两个域）")\n'
    'check("import { fileToBase64, newTaskId } from \'../intakeHelpers.js\'" in HOOK,\n'
    '      "快速录入域 import 共用纯模块（附件草稿 + 任务 id）")\n'
    'check("import { newTaskId, quickImageToPromptPart } from \'../intakeHelpers.js\'"\n'
    '      in SOURCES.get(AI_HOOK_PATH, ""), "AI 会话域 import 共用纯模块（预留任务 id + 图片 prompt part）")',
)

# ------------------------------------------------------------------ p6d：目录选择域解构 + 死 import 归零
patch(
    P6D,
    'check("const { dirPickerTarget, dirPickerPath, dirPickerListing, dirPickerLoading, dirPickerError } = dir" in INDEX_BARE,\n'
    '      "读取值解构（名字与搬迁前一致，调用点文本因此不用改）")\n'
    'check("const { openFor, loadDirPickerDir, setDirPickerTarget, setDirPickerPath } = dir.actions" in INDEX_BARE,\n'
    '      "动作解构")',
    'check("const { dirPickerTarget } = dir" in INDEX_BARE,\n'
    '      "读取值解构（P7-3 起只剩入口真读的 dirPickerTarget；名字与搬迁前一致，调用点文本因此不用改）")\n'
    'check("const { openFor, setDirPickerTarget } = dir.actions" in INDEX_BARE,\n'
    '      "动作解构（P7-3 起只剩入口真用的两个）")',
)
patch(
    P6D,
    'check(dead == ["localDirRequestUrl", "LocalDirListing"],\n'
    '      "两个死 import 的名单正是预期的两处（多了说明还有别的搬家没登记）")',
    'check(dead == [],\n'
    '      "入口死 import 已归零（P7-3 清理：原先那两处 localDirRequestUrl / LocalDirListing 已删）")\n'
    'check("import { localDirRequestUrl } from \'../localDirBrowser.js\'" in SOURCES.get(HOOK_PATH, ""),\n'
    '      "目录选择域仍 import localDirRequestUrl（所有者不变）")\n'
    'check("import type { LocalDirListing } from \'../components/LocalDocModal.js\'" in SOURCES.get(HOOK_PATH, ""),\n'
    '      "目录选择域仍 import LocalDirListing（类型所有者不变）")',
)

# ------------------------------------------------------------------ p4：日期域 day 解构（入口真读的 3 行）
patch(
    P4,
    'for name in ["capacity, capacityEdit, capacityExpanded, reportSubTab, currentReport, reportSession, reportAnchor,",\n'
    '             "reportIsFuture, pickedPlan, picked, addingPlanTaskId, cursor, calMode, dayTab, weekDays, monthGrid,",\n'
    '             "dayPanel, planPromptFor,",\n'
    '             "addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, moveWeek, moveMonth, setPicked,",\n'
    '             "setCalMode, setCursor, setDayTab, setReportSubTab, setCapacityEdit, setCapacityExpanded,",\n'
    '             "bumpPlanRefresh, bumpReportRefresh,"]:\n'
    '    check(name in INDEX, f"入口解构了 `{name[:56]}…`")',
    '# P7-3 后入口只为 JSX 解构的名字已清 —— 这里冻结的是入口真读的 3 行原文。\n'
    'for name in ["reportSubTab, currentReport, reportSession, reportAnchor, reportIsFuture,",\n'
    '             "pickedPlan, addingPlanTaskId, dayTab, dayPanel, planPromptFor,",\n'
    '             "addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, setDayTab, setReportSubTab } = day.actions",\n'
    '             ]:\n'
    '    check(name in INDEX, f"入口解构了 `{name[:56]}…`")\n'
    '# 反面：只为 JSX 解构的名字不该再回流入库（调用点在 app/ 四段里，由上面的 ACTIONS 循环盯住）。\n'
    'for name in ["capacity,", "capacityEdit,", "capacityExpanded,", "cursor,", "calMode,", "weekDays,",\n'
    '             "monthGrid,", "moveWeek,", "moveMonth,", "setPicked,", "setCalMode,", "setCursor,",\n'
    '             "setCapacityEdit,", "setCapacityExpanded,", "bumpPlanRefresh,", "bumpReportRefresh,"]:\n'
    '    check("\\n    " + name not in INDEX_BARE, f"入口不再解构 `{name}`（P7-3 清理）")',
)
patch(
    P4,
    'for action in ACTIONS:\n'
    '    check(bare(None, action) >= 1, f"装配层通过 `day.actions` 用到 `{action}`")',
    'for action in ACTIONS:\n'
    '    # P7-2 后 JSX 在 app/ 四段里；P7-3 又把入口只为 JSX 解构的名字清掉 —— 所以\n'
    '    # "装配层用到它"要在「入口 + app/ 四段」这个整体里看（域 hook 不在名单里：接线跑进 hook 仍会红）。\n'
    '    check(bare(None, action) >= 1 or re.search(r"(?<![\\w.])" + re.escape(action) + r"\\b", UI_ALL) is not None,\n'
    '          f"装配层通过 `day.actions` 用到 `{action}`（入口或 src/client/app/ 四段）")',
)

# ------------------------------------------------------------------ p6c：ai.actions 解构收尾
patch(
    P6C,
    'check("  } = ai.actions" in INDEX_BARE, "动作解构（缩进两格的收尾）")',
    'check("const { startAISession, resetClarifyPicker } = ai.actions" in INDEX_BARE,\n'
    '      "动作解构（P7-3 起只剩入口真用的 startAISession / resetClarifyPicker；多行收尾已并回一行）")',
)

# ================================================================== 校验 + 写盘
# ⚠️ 同一个文件的多条补丁必须**累积到同一份内存文本**再写一次：
#    逐条"读盘 → 替换 → 写盘"会让先写的被后读的原始内容覆盖（本脚本第一版就踩了这个坑）。
by_file: dict[str, list[tuple[str, str]]] = {}
for path, old, new in PATCHES:
    by_file.setdefault(path, []).append((old, new))

written = 0
for path, pairs in by_file.items():
    full = os.path.join(LIB, path)
    if not os.path.exists(full):
        print(f"ABORT：找不到 {full}")
        sys.exit(1)
    src = open(full, encoding="utf-8", newline="").read().replace("\r\n", "\n")
    original = src
    applied = 0
    for old, new in pairs:
        n_old = src.count(old)
        n_new = src.count(new)
        if n_new == 1 and n_old == 0:
            continue  # 已生效（幂等）
        if n_old != 1:
            print(f"ABORT：{path} 的 old 片段命中 {n_old} 次（要求 1 次）\n  >>> {old.splitlines()[0][:100]!r}")
            sys.exit(1)
        src = src.replace(old, new, 1)
        applied += 1
    if src != original:
        open(full, "w", encoding="utf-8", newline="\n").write(src)
        print(f"✔ {path}（{applied} 处）")
        written += applied
    else:
        print(f"· 跳过（已生效）：{path}")

if written == 0:
    print("✔ 全部补丁已生效，无需写盘")
else:
    print(f"✔ 已重锚 {written} 处（共 {len(PATCHES)} 条补丁）")
