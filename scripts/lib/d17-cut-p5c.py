# -*- coding: utf-8 -*-
"""D17 / P5-3 一次性搬迁：把**草稿域**（7 项 state + 3 个 ref + 5 个域动作 + 轮询的草稿半段）
从 src/client/index.tsx 切进 hooks/useWorkbenchDrafts.ts，并把**混合域轮询 effect**
（5 秒 tick + 15 秒 refresh）整片换成 hooks/useWorkbenchPolling.ts 的调用点。

与 P4/P5-1/P5-2 一致的两条纪律：
  ① **只换来源、不改调用点文本** —— 入口从 `draftsApi` / `draftsApi.actions` 解构出与原来
     同名的值，所以 `onProblems={setDraftProblems}`、`onSettled={() => setPendingDraft(null)}`
     （`test/draftBannerSessionJump.test.mjs:115` 有正则断言）、
     `onClose={() => { dismissDraft(pendingDraft); setPendingDraft(null) }}`、
     `onConfirmed={(outcome) => handleDraftConfirmed(outcome, pendingDraft)}`、
     `onClick={() => setPendingOpen(true)}`、`duplicatePrompt` 那一整块 JSX …**一个字都不用动**，
     探针与既有测试因此不需要重锚。
  ② **轮询搬家但语义不动** —— 5 秒 tick（草稿 → 提醒，串行）/ 15 秒 refresh、同一个 try、
     两个 interval、`alive` 清理与依赖重建时机全部逐字保留（等价性论证写在
     hooks/useWorkbenchPolling.ts 文件头）。

房屋风格同 d17-cut-p4.py / p5a.py / p5b.py：所有断言先跑完，problems 为空才落盘。
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

# 控制台是 GBK 时打印 ✅ 会 UnicodeEncodeError（p5b 第一次跑就撞上过：写盘已完成、只是收尾打印炸了）。
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
    """删除 [start .. end]（含两端标记）用 new 替代。两端标记都必须恰好 1 次。"""
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
text = src

# ---------------------------------------------------------------- ① import 两个新 hook
text = replace_once(
    text,
    "import { useWorkbenchReminders } from './hooks/useWorkbenchReminders.js'\n",
    "import { useWorkbenchReminders } from './hooks/useWorkbenchReminders.js'\n"
    "import { useWorkbenchDrafts } from './hooks/useWorkbenchDrafts.js'\n"
    "import { useWorkbenchPolling } from './hooks/useWorkbenchPolling.js'\n",
    "import 草稿域 hook 与轮询装配",
)

# ---------------------------------------------------------------- ② L300-346 草稿域 state 与 ref（连续 47 行）
text = cut_between(
    text,
    "  const [pendingDraft, setPendingDraft] = useState<DraftView | null>(null)\n",
    "  const [allPendingDrafts, setAllPendingDrafts] = useState<DraftView[]>([])\n",
    "  // 草稿域（D17/P5-3）：7 项 state（`pendingDraft` / `deferredDrafts` / `draftProblems` /\n"
    "  // `draftSwitchedFrom` / `allPendingDrafts` / `pendingOpen` / `duplicatePrompt`）与 3 个 ref\n"
    "  // （`dismissedDraftIdsRef` / `deferredWhenDismissedRef` / `bannerDraftRef`）已收进\n"
    "  // hooks/useWorkbenchDrafts.ts。三条不许动的语义（计数不经本地屏蔽集合 / 只有「暂存→唤回」\n"
    "  // 才解除屏蔽 / 弹框被「静默换人」必须说出来）随原注释一起搬进了 hook 文件头。\n",
    "草稿域 state 与 ref",
)

# ---------------------------------------------------------------- ③ L372 pendingOpen
text = replace_once(
    text,
    "  const [pendingOpen, setPendingOpen] = useState(false)\n",
    "  // 草稿域（D17/P5-3）：`pendingOpen`（待处理弹窗开关）已收进 hooks/useWorkbenchDrafts.ts。\n",
    "pendingOpen",
)

# ---------------------------------------------------------------- ④ L373-387 duplicatePrompt
text = cut_between(
    text,
    "  /**\n   * 「库里已有同名任务」的待决提示（2026-09-13 重复建单事故的界面侧收口）。\n",
    "    newTaskId: string\n  } | null>(null)\n",
    "  // 草稿域（D17/P5-3）：`duplicatePrompt`（「库里已有同名任务」的待决提示）已收进\n"
    "  // hooks/useWorkbenchDrafts.ts（`DraftDuplicatePrompt` 类型一并搬走）。\n",
    "duplicatePrompt",
)

# ---------------------------------------------------------------- ⑤ 草稿域 hook 调用点（紧跟任务数据域解构之后）
text = replace_once(
    text,
    "  } = data.actions\n",
    "  } = data.actions\n"
    "  // 草稿域（D17/P5-3）：调用点必须在 `refresh`（任务数据域）与 `setError` / `setNotice`\n"
    "  // （反馈域）之后 —— 三个都是以注入形式进来的（`const` 没有提升）。\n"
    "  const draftsApi = useWorkbenchDrafts({ refresh, onError: setError, onNotice: setNotice })\n"
    "  const { pendingDraft, deferredDrafts, draftProblems, draftSwitchedFrom, allPendingDrafts, pendingOpen, duplicatePrompt } = draftsApi\n"
    "  const {\n"
    "    setPendingDraft, setDraftProblems, setDuplicatePrompt, setPendingOpen,\n"
    "    dismissDraft, resumePendingDraft, resumeDeferredDraft, handleDraftConfirmed, reuseExistingTask,\n"
    "  } = draftsApi.actions\n",
    "草稿域 hook 调用点",
)

# ---------------------------------------------------------------- ⑥ 混合域轮询 effect → useWorkbenchPolling
text = cut_between(
    text,
    "  useEffect(() => {\n    let alive = true\n",
    "  }, [refresh, settings.desktopNotify])\n",
    "  // 轮询装配（D17/P5-3）：5 秒 tick（草稿 → 提醒，**串行**）+ 15 秒 refresh 已收进\n"
    "  // hooks/useWorkbenchPolling.ts。原来那个 `try` 一并搬走 —— 草稿那半段抛错时提醒那半段\n"
    "  // 当轮不执行，异常范围不变。原依赖数组 `[refresh, settings.desktopNotify]` 的等价性由\n"
    "  // 该文件头论证：两个 tick 函数都是稳定 `useCallback`（提醒那个只随 `desktopNotify`\n"
    "  // 换身份），所以重建时机与原实现逐字相同。\n"
    "  useWorkbenchPolling({\n"
    "    tickDrafts: draftsApi.actions.tickDrafts,\n"
    "    tickReminders: remindersApi.actions.tickDue,\n"
    "    refresh,\n"
    "    desktopNotify: settings.desktopNotify,\n"
    "  })\n",
    "混合域轮询 effect → useWorkbenchPolling",
)

# ---------------------------------------------------------------- ⑦ L1882-1989 草稿域五个动作
text = cut_between(
    text,
    "  /** 收起一条草稿横幅：记屏蔽，并**记下它当时是不是暂存态**（供\"暂存→唤回\"识别）。 */\n",
    "    void refresh()\n  }\n",
    "  // 草稿域（D17/P5-3）：`dismissDraft` / `resumePendingDraft` / `resumeDeferredDraft` /\n"
    "  // `handleDraftConfirmed` / `reuseExistingTask` 五个动作已收进 hooks/useWorkbenchDrafts.ts\n"
    "  // （连同它们的原注释：屏蔽集合、唤回要撤销屏蔽、三种确认回执、收口后归档多建的那条）。\n",
    "草稿域五个动作",
)

# ---------------------------------------------------------------- 落盘
if problems:
    print("✖ 裁切未执行，存在以下问题：")
    for p in problems:
        print(f"   - {p}")
    raise SystemExit(1)

after_lines = text.count("\n") + 1
# ⚠️ 必须显式 newline="\n"：Path.write_text 默认会把 \n 翻成 os.linesep（Windows 上是 \r\n）。
# p5b 第一次跑时漏了这个参数，整份 index.tsx 被写成 CRLF（3926 个 CRLF / 0 个裸 LF）。
INDEX.write_text(text, encoding="utf-8", newline="\n")
print(f"\u2705 index.tsx: {before_lines} -> {after_lines} 行")
