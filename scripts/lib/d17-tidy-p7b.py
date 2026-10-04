"""D17/P7-3 顺手整理：把 d17-clean-unused.py 删名字之后留下的排版碎渣理顺。

只改**排版**（多余空格、短解构并回一行、多行解构补回统一缩进），不改语义。
先全部校验（每处 old 恰好 1 次），不成立就整体中止、不写文件。
"""
import io
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PATH = os.path.join("src", "client", "index.tsx")

PAIRS = [
    # 两个多余空格
    ("  const { editDraft, formWorkspace  } = forms\n",
     "  const { editDraft, formWorkspace } = forms\n"),
    ("  const { bootstrap, tasks, selected, dicts, dictOf, pendingMap, childrenOf  } = data\n",
     "  const { bootstrap, tasks, selected, dicts, dictOf, pendingMap, childrenOf } = data\n"),
    # 短解构并回一行
    ("  const {\n    setSettings, saveDailyCapacity: saveDailyCapacitySetting\n  } = prefs.actions\n",
     "  const { setSettings, saveDailyCapacity: saveDailyCapacitySetting } = prefs.actions\n"),
    ("  const { quickWorkspace\n  } = quick\n",
     "  const { quickWorkspace } = quick\n"),
    ("  const { openIntake, closeIntake, overrideWorkspace, clearQuickAttachments\n  } = quick.actions\n",
     "  const { openIntake, closeIntake, overrideWorkspace, clearQuickAttachments } = quick.actions\n"),
    ("  const { startAISession, resetClarifyPicker\n  } = ai.actions\n",
     "  const { startAISession, resetClarifyPicker } = ai.actions\n"),
    ("  const {\n    addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, setDayTab, setReportSubTab\n  } = day.actions\n",
     "  const { addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, setDayTab, setReportSubTab } = day.actions\n"),
    # 多行解构补回统一缩进与尾逗号
    ("  const { reportSubTab, currentReport, reportSession, reportAnchor,\n    reportIsFuture, pickedPlan, addingPlanTaskId, dayTab,\n    dayPanel, planPromptFor\n  } = day\n",
     "  const {\n    reportSubTab, currentReport, reportSession, reportAnchor, reportIsFuture,\n"
     "    pickedPlan, addingPlanTaskId, dayTab, dayPanel, planPromptFor,\n"
     "  } = day\n"),
    ("  const {\n    refresh,\n    loadTaskDetail,\n    patchTask,\n    completePlanTask,\n    saveProgress,\n"
     "    deferPlanTask,\n    setTasks,\n    currentTaskId,\n    linkSessionRequest\n  } = data.actions\n",
     "  const {\n    refresh,\n    loadTaskDetail,\n    patchTask,\n    completePlanTask,\n    saveProgress,\n"
     "    deferPlanTask,\n    setTasks,\n    currentTaskId,\n    linkSessionRequest,\n  } = data.actions\n"),
]

src = open(PATH, encoding="utf-8", newline="").read().replace("\r\n", "\n")
for old, new in PAIRS:
    n = src.count(old)
    if n != 1:
        print(f"ABORT：old 片段命中 {n} 次（要求 1 次）\n  >>> {old[:120]!r}")
        sys.exit(1)
src = src.replace("\r\n", "\n")
for old, new in PAIRS:
    src = src.replace(old, new, 1)
open(PATH, "w", encoding="utf-8", newline="\n").write(src)
print(f"✔ 已整理 {len(PAIRS)} 处排版（{PATH}）")
