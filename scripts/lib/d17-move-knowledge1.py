#!/usr/bin/env python3
"""D17 P1：把 `useKnowledge(...)` 接线块挪到 `startAISession` 之后。

为什么：hook 的入参里 `startAISession` 是在组件中部才声明的 `const`（没有提升），
放在前面 typecheck 直接报 TS2448/TS2454 —— 这不是风格问题，是真的会 ReferenceError。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, encoding="utf-8", newline="").read()
orig = len(src)

BLOCK = (
    "  /**\r\n"
    "   * D17 / P1：知识域的全部 state / effect / 动作已经收进 `hooks/useKnowledge.ts`。\r\n"
    "   *\r\n"
    "   * ⚠️ 为什么调用点在这里、而不是原来的 state 声明区：本 hook 的入参里有 `dictOf` / `busy` / `view`，\r\n"
    "   * 它们在本组件里**先声明后使用**（`const` 没有提升）—— 放到前面会直接 ReferenceError。\r\n"
    "   * 这个位置与拆分前那批 state/effect 的先后次序一致，hook 调用次序不变；\r\n"
    "   * 域 hook 常驻在顶层、不放进条件视图，所以切视图不会重置知识域状态（设计 §4.2）。\r\n"
    "   */\r\n"
    "  const knowledge = useKnowledge({\r\n"
    "    activeView: view,\r\n"
    "    dictOf,\r\n"
    "    busy,\r\n"
    "    setBusy,\r\n"
    "    runtime,\r\n"
    "    isAlive: () => instanceAlive,\r\n"
    "    startAISession,\r\n"
    "    setError: (message) => setError(message),\r\n"
    "    setNotice: (message) => setNotice(message),\r\n"
    "  })\r\n"
)

if src.count(BLOCK) != 1:
    raise SystemExit(f"ABORT 找不到接线块（命中 {src.count(BLOCK)} 次）")
src = src.replace(BLOCK, "", 1)

# 找一个稳定的落点：`loadIdeas` 的 effect 之后、`refresh` effect 之前不好定位，
# 改为插在 `const loadSkills` 之后的第一处 `const loadIdeas = useCallback` 已经用过；
# 这里改插到「`const instanceAlive` 声明」之后的注释块前 —— 用 startAISession 结尾做锚。
ANCHOR = "  }\r\n\r\n  /**\r\n   * 「快速录入」的附件"
if src.count(ANCHOR) != 1:
    raise SystemExit(f"ABORT 落点锚命中 {src.count(ANCHOR)} 次")

open(FILE, "w", encoding="utf-8", newline="").write(src)
print(f"MOVED  out  -{len(BLOCK)}（下一步再由 d17-move-knowledge2.py 插入）")
print(f"len {orig} -> {len(src)}")
