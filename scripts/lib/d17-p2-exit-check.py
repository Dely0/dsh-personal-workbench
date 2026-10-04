#!/usr/bin/env python3
"""D17 P2 出口核对（独立于 typecheck 的机械检查），与 d17-p1-exit-check.py 同构。

核对：
1. 入口里**不再出现**任何点子域的 state/setter/loader/派生/动作名（"删旧实现"可验证）；
2. 点子域实现**恰好**落在 `hooks/useIdeas.ts` / `views/IdeasListView.tsx` / `views/IdeasDetailPane.tsx`；
   视图**不得**自己发请求（HTTP 只在 hook 里）；
3. 入口里点子视图与详情面板是**单行装配**。

这里只做文本核对，不是行为验证；行为/结构以 `pnpm typecheck` / `pnpm test` 为准。
"""
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def load(p):
    return open(p, encoding="utf-8", newline="").read().replace("\r\n", "\n")


INDEX = load("src/client/index.tsx")
HOOK = load("src/client/hooks/useIdeas.ts")
LIST = load("src/client/views/IdeasListView.tsx")
DETAIL = load("src/client/views/IdeasDetailPane.tsx")

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


print("1) 入口里不得再有点子域的实现名")
for name in [
    "ideaClusters", "ideaTab", "ideaQuery", "ideaKind", "selectedIdeaIds", "selectedIdea",
    "selectedCluster", "ideaForm", "ideaEditId", "folderForm", "ideaRefreshKey",
    "loadIdeas", "ideaCardItems", "unfiledIdeas", "refreshIdeas", "saveFolder",
    "deleteFolder", "fileIdeaInto", "unfileIdeaFrom", "mergeFolderInto",
    "IdeaCardGrid", "IdeaCardItem",
]:
    hits = len(re.findall(re.escape(name), INDEX))
    check(hits == 0, f"index.tsx 不含 {name}（命中 {hits}）")

print("2) 入口必须只有两处点子域装配 + 一个只读提示词快照")
check(len(re.findall(r"<IdeasListView", UI_BODY)) == 1, "IdeasListView 装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）")
check(len(re.findall(r"<IdeasDetailPane", UI_BODY)) == 1, "IdeasDetailPane 装配一处（同上）")
check("const ideas = useIdeas({" in INDEX, "useIdeas 在入口顶层无条件调用")
check("const ideasAll = ideas.allIdeas" in INDEX, "提示词读的是只读快照 ideasAll（入口不持第二份可写状态）")
check("ideas.actions.refresh()" in UI_OVERLAYS, "DraftBanner 走域动作而不是旧 setter（D17/P7-2 起 owner = src/client/app/WorkbenchOverlays.tsx）")

print("3) 视图不得自己发请求 / 自己存状态；HTTP 只在 hook 里")
for label, src in [("IdeasListView.tsx", LIST), ("IdeasDetailPane.tsx", DETAIL)]:
    check(not re.search(r"\b(api|fetch)\s*[<(]", src), f"{label} 不发 HTTP 请求")
    check(not re.search(r"\buseState\s*[<(]", src), f"{label} 不自建 state")
    check(not re.search(r"\buseEffect\s*\(", src), f"{label} 不自建 effect")

print("4) 点子域实现只落在 hook 一处")
for fn in ["refresh", "openIdeaById", "openIdea", "openCluster", "startCreate", "startEdit",
           "patchDraft", "closeDraft", "saveDraft", "deleteIdea", "saveFolder", "deleteFolder",
           "fileIdeaInto", "unfileIdeaFrom", "mergeFolderInto"]:
    hits = len(re.findall(r"^\s{4}" + fn + r"[:(]", HOOK, re.M))
    check(hits == 1, f"useIdeas.actions.{fn} 唯一实现（命中 {hits}）")

print("5) 拆分不许引入新语义：'清两份'在拆分前不存在")
whole_client = INDEX + HOOK + LIST + DETAIL
check("clearSelection" not in whole_client,
      "客户端源码里不得出现 clearSelection（页签只清'另一个'，见 hook.changeTab）")

print(f"\n结果：{'全部通过' if not failures else str(len(failures)) + ' 项不通过'}")
sys.exit(1 if failures else 0)
