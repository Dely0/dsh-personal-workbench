# -*- coding: utf-8 -*-
"""D17 / P6-1 一次性搬迁：把**导航域**（`view` / `setView`，1 项 state）与
**界面忙碌标志**（`busy` / `setBusy`，1 项 state）从 src/client/index.tsx 切进
hooks/useWorkbenchNavigation.ts 与 hooks/useWorkbenchBusy.ts。

纪律同 P4/P5-x：
  ① **只换来源、不改调用点文本** —— 入口仍从两个 hook 解构出同名 `view` / `setView` /
     `busy` / `setBusy`，所以 6 个 `setView('…')`、~40 处 `view === '…'`、
     `useKnowledge({ busy, setBusy, activeView: view, … })` 与全部 JSX 一个字都不用动。
  ② 声明顺序不变：导航域留在原 `view` 声明处（最早），忙碌标志留在原 `busy` 声明处
     （`useKnowledge` 之前）—— 两者都被后续 hook 以注入/读取形式消费，`const` 没有提升。

顺带**同批改**（owner 变了，判据跟着 owner 走）：`src/client/index.tsx:95` 的
`WorkbenchView` 类型 import 在搬迁后成了死 import，本批从该行移除（`TaskEditDraft`
仍是既有死 import，按 P4 决策留给 P7 统一清）。

房屋风格同 d17-cut-p4.py / p5a.py / p5b.py / p5c.py：所有断言先跑完，problems 为空才落盘。
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

# 控制台是 GBK 时打印 emoji 会 UnicodeEncodeError（p5b 踩过：写盘已完成、只是收尾打印炸了）。
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


src = INDEX.read_text(encoding="utf-8")
before_lines = src.count("\n") + 1
text = src.replace("\r\n", "\n")

# ---------------------------------------------------------------- ① import 两个新 hook
text = replace_once(
    text,
    "import { useWorkbenchPolling } from './hooks/useWorkbenchPolling.js'\n",
    "import { useWorkbenchPolling } from './hooks/useWorkbenchPolling.js'\n"
    "import { useWorkbenchNavigation } from './hooks/useWorkbenchNavigation.js'\n"
    "import { useWorkbenchBusy } from './hooks/useWorkbenchBusy.js'\n",
    "import 导航域与忙碌标志 hook",
)

# ---------------------------------------------------------------- ② 契约类型：入口不再需要 WorkbenchView
text = replace_once(
    text,
    "import type { TaskEditDraft, WorkbenchView } from './app/contracts.js'\n",
    "import type { TaskEditDraft } from './app/contracts.js'\n",
    "契约类型 import 收窄（WorkbenchView 的读点随搬迁离开入口）",
)

# ---------------------------------------------------------------- ③ 导航域（原 L206）
text = replace_once(
    text,
    "  const [view, setView] = useState<WorkbenchView>('today')\n",
    "  // 导航域（D17/P6-1）：`view` / `setView` 已收进 hooks/useWorkbenchNavigation.ts。\n"
    "  // 落点必须最早：`useKnowledge` / `useIdeas` / `useTaskListModel` 都以 `activeView` 读它，\n"
    "  // 而 `const` 没有提升（声明在前才拿得到）。\n"
    "  const nav = useWorkbenchNavigation()\n"
    "  const { view } = nav\n"
    "  const { setView } = nav.actions\n",
    "导航域 state",
)

# ---------------------------------------------------------------- ④ 忙碌标志（原 L387）
text = replace_once(
    text,
    "  const [busy, setBusy] = useState(false)\n",
    "  // 界面忙碌标志（D17/P6-1）：`busy` / `setBusy` 已收进 hooks/useWorkbenchBusy.ts。\n"
    "  // 它不属于任何一个业务域（AI 会话域与知识域都只是写它），单独立最小 owner 的理由见该文件头。\n"
    "  const busyApi = useWorkbenchBusy()\n"
    "  const { busy } = busyApi\n"
    "  const { setBusy } = busyApi.actions\n",
    "忙碌标志 state",
)

# ---------------------------------------------------------------- 落盘
if problems:
    print("✖ 裁切未执行，存在以下问题：")
    for p in problems:
        print(f"   - {p}")
    raise SystemExit(1)

after_lines = text.replace("\r\n", "\n").count("\n") + 1
# ⚠️ 必须显式 newline="\n"：Path.write_text 默认会把 \n 翻成 os.linesep（Windows 上是 \r\n）。
if src.count("\r\n") != 0:
    print("✖ 源文件不是纯 LF，停止（避免把换行风格写坏）")
    raise SystemExit(1)
INDEX.write_text(text, encoding="utf-8", newline="\n")
print(f"\u2705 index.tsx: {before_lines} -> {after_lines} 行")
