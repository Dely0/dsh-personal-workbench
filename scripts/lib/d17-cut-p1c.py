#!/usr/bin/env python3
"""D17 P1 右侧详情：把 `wb-detail` 里那个 knowledge 嵌套三元整体换成 <KnowledgeDetailPane>。

做法（skill §14）：先用行内容找候选，再在**候选附近限定的窗口**里匹配结尾标记，
每个标记都必须恰好命中一次；任何一步不满足就抛错不写。
"""
FILE = "src/client/index.tsx"
src = open(FILE, encoding="utf-8", newline="").read()
orig_len = len(src)

START = "            ? knowledgeDraft !== null\r\n"
END = "                : <div className=\"wb-empty\">← 从左侧选择或新建知识条目</div>\r\n"
REPLACEMENT = (
    "            ? <KnowledgeDetailPane model={knowledge} tasks={tasks} dictOf={dictOf} setError={setError} setNotice={setNotice} openTaskById={openTaskById} />\r\n"
)

i = src.find(START)
if i < 0:
    raise SystemExit("ABORT: 找不到 knowledge 详情分支起点")
j = src.find(END, i)
if j < 0:
    raise SystemExit("ABORT: 找不到 knowledge 详情分支终点")
# 终点必须唯一（整文件里只应出现一次这段空态文案）
if src.count(END) != 1:
    raise SystemExit(f"ABORT: 终点标记命中 {src.count(END)} 次（要求 1 次）")
src = src[:i] + REPLACEMENT + src[j + len(END):]

open(FILE, "w", encoding="utf-8", newline="").write(src)
print(f"REPL  jsx: detail ternary → <KnowledgeDetailPane>  removed={j + len(END) - i}")
print(f"len {orig_len} -> {len(src)}  ({len(src) - orig_len:+d})")
