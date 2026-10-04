#!/usr/bin/env python3
"""D17 P1：入口侧收尾替换（域模型接线 + 三处旧 setter 引用）。"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, encoding="utf-8", newline="").read()
orig = len(src)
log = []


def replace(label, old, new):
    global src
    n = src.count(old)
    if n != 1:
        raise SystemExit(f"ABORT {label}: 命中 {n} 次（要求 1 次）")
    src = src.replace(old, new, 1)
    log.append(f"REPL  {label}  {len(new) - len(old):+d}")


# 1) 域模型接线：插在 loadIdeas 之前（那里 dictOf / busy / view 都已声明）
replace(
    "hook: useKnowledge 接线",
    "  const loadIdeas = useCallback(async () => {\r\n",
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
    "  const loadIdeas = useCallback(async () => {\r\n",
)

# 2) 「待你处理」确认草稿后的跨域刷新
replace(
    "ref: setKnowledgeRefreshKey → knowledge.bumpRefreshKey()",
    "setReportRefreshKey((v) => v + 1); setKnowledgeRefreshKey((v) => v + 1); setIdeaRefreshKey((v) => v + 1)",
    "setReportRefreshKey((v) => v + 1); knowledge.bumpRefreshKey(); setIdeaRefreshKey((v) => v + 1)",
)

# 3) 复盘卡片：打开已沉淀的知识条目
replace(
    "ref: 打开已沉淀知识条目",
    "onClick={() => { setKnowledgeDraft(null); setKnowledgeEditId(null); setSelectedKnowledge(existingKnowledge); setView('knowledge') }}",
    "onClick={() => { knowledge.openEntryById(existingKnowledge.id); setView('knowledge') }}",
)

# 4) 复盘卡片：把复盘沉淀为新知识（预填内容不变）
replace(
    "ref: 沉淀为经验（预填草稿）",
    "onClick={() => { setKnowledgeEditId(null); setKnowledgeDraft({ title: `复盘：${selected.task.title}`, contentMd: String(rv.summary_md ?? ''), kindCode: 'lesson', tags: '复盘', sourceTaskId: selected.task.id, sourceReviewId: reviewId, fileLink: '' }); setSelectedKnowledge(null); setView('knowledge') }}",
    "onClick={() => { knowledge.startCreate({ title: `复盘：${selected.task.title}`, contentMd: String(rv.summary_md ?? ''), kindCode: 'lesson', tags: '复盘', sourceTaskId: selected.task.id, sourceReviewId: reviewId, fileLink: '' }); setView('knowledge') }}",
)

open(FILE, "w", encoding="utf-8", newline="").write(src)
print("\n".join(log))
print(f"len {orig} -> {len(src)}  ({len(src) - orig:+d})")
