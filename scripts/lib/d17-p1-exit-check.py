#!/usr/bin/env python3
"""D17 P1 出口核对（独立于 typecheck 的机械检查）。

核对三件事：
1. 入口里**不再出现**任何知识域的 state/setter/loader/派生名（"删旧实现"是可验证的）；
2. 知识域的实现**恰好**落在 `hooks/useKnowledge.ts` / `views/KnowledgeListView.tsx` /
   `views/KnowledgeDetailPane.tsx` 三处（"同一语义只有一个所有者"）；
3. 入口里知识视图与详情面板的接线是**单行装配**，而不是又长回去了。

注意：这里**只做文本核对**，不是行为验证；行为与结构正确性以 `pnpm typecheck` / `pnpm test` 为准。
"""
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = open("src/client/index.tsx", encoding="utf-8", newline="").read().replace("\r\n", "\n")
HOOK = open("src/client/hooks/useKnowledge.ts", encoding="utf-8", newline="").read().replace("\r\n", "\n")
LIST = open("src/client/views/KnowledgeListView.tsx", encoding="utf-8", newline="").read().replace("\r\n", "\n")
DETAIL = open("src/client/views/KnowledgeDetailPane.tsx", encoding="utf-8", newline="").read().replace("\r\n", "\n")

# ---------------------------------------------------------------- D17/P7-2：JSX 已分四段搬进 app/
# 判据跟着 owner 走：凡「某组件 / 某 props 仍挂在装配层」的断言不再锚 `index.tsx`，
# 而是锚这四段组件 —— 它们才是装配层的 JSX owner。
# 注意：域 hook 不在这份名单里，所以「接线跑进 hook」仍然会红。
def _app_read(name):
    with open(os.path.join("src", "client", "app", name), encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


UI_HEADER = _app_read("WorkbenchHeader.tsx")
UI_OVERLAYS = _app_read("WorkbenchOverlays.tsx")
UI_BODY = _app_read("WorkbenchBody.tsx")
UI_DIALOGS = _app_read("WorkbenchDialogs.tsx")
UI_ALL = "\n".join((UI_HEADER, UI_OVERLAYS, UI_BODY, UI_DIALOGS))

failures = []


def check(ok, message):
    print(("  ✔ " if ok else "  ✖ ") + message)
    if not ok:
        failures.append(message)


print("1) 入口里不得再有知识域的实现名")
for name in [
    "knowledgeEntries", "knowledgeFilters", "selectedKnowledge", "knowledgeDraft", "knowledgeEditId",
    "knowledgeRefreshKey", "localDocPath", "filePickerOpen", "filePickerListing", "filePickerLoading",
    "filePickerError", "summarizeLocalDoc", "loadKnowledge", "knowledgeDicts", "knowledgePage",
    "readKnowledgeFilters", "writeKnowledgeFilters", "KNOWLEDGE_FILTER_STORAGE_KEY",
    "KnowledgeToolbar", "KnowledgePager", "KnowledgeList ",
]:
    hits = len(re.findall(re.escape(name), INDEX))
    check(hits == 0, f"index.tsx 不含 {name}（命中 {hits}）")

print("2) 入口必须只有两处知识域装配")
check(len(re.findall(r"<KnowledgeListView", UI_BODY)) == 1, "KnowledgeListView 装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）")
check(len(re.findall(r"<KnowledgeDetailPane", UI_BODY)) == 1, "KnowledgeDetailPane 装配一处（同上）")
check("const knowledge = useKnowledge({" in INDEX, "useKnowledge 在入口顶层无条件调用")
check("startAISessionRef.current = startAISession" in INDEX, "startAISession 经 ref 惰性转发（避免 TDZ）")

print("3) 知识域实现只落在三处")
for label, src in [("useKnowledge.ts", HOOK), ("KnowledgeListView.tsx", LIST), ("KnowledgeDetailPane.tsx", DETAIL)]:
    # 视图里不许再"自己拉一份知识状态"：只允许出现 hook 的类型名/入参，不许出现 useState 形式的自建
    check(not re.search(r"const\s*\[\s*knowledge(Entries|Filters|Draft)", src), f"{label} 不自建第二份知识状态")
check(len(re.findall(r"^\s*function\s+readKnowledgeFilters", HOOK, re.M)) == 1, "readKnowledgeFilters 唯一实现")
check(len(re.findall(r"^\s*function\s+writeKnowledgeFilters", HOOK, re.M)) == 1, "writeKnowledgeFilters 唯一实现")
check(len(re.findall(r"const KNOWLEDGE_FILTER_STORAGE_KEY = ", HOOK)) == 1, "存储键只声明一次")
check(len(re.findall(r"dsh\.personal-workbench\.knowledgeList", HOOK + LIST + DETAIL + INDEX)) == 1,
      "存储键字面量全客户端只出现一次")

print(f"\n结果：{'全部通过' if not failures else str(len(failures)) + ' 项不通过'}")
sys.exit(1 if failures else 0)
