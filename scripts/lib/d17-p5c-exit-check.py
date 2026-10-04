#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""D17 / P5-3（草稿域 + 轮询装配）出口自检 —— 只做文本核对，行为以 typecheck / pnpm test 为准。

本批把下面这些从 `src/client/index.tsx` 的 `WorkbenchApp` 里搬进
**两个**新文件：

进 `src/client/hooks/useWorkbenchDrafts.ts`：

* 7 项 state：`pendingDraft`（原 L300）、`deferredDrafts`（L302）、`draftProblems`（L307）、
  `draftSwitchedFrom`（L340）、`allPendingDrafts`（L346）、`pendingOpen`（L372）、
  `duplicatePrompt`（L379-387，内联类型改成具名 `DraftDuplicatePrompt`）
* 3 个 ref：`dismissedDraftIdsRef`（L321）、`deferredWhenDismissedRef`（L328）、`bannerDraftRef`（L339）
* 6 个动作：`dismissDraft`（L1883）、`resumePendingDraft`（L1889）、`resumeDeferredDraft`（L1905）、
  `handleDraftConfirmed`（L1930）、`reuseExistingTask`（L1960），外加轮询用的
  `tickDrafts`（取代原 L576-626 那半段）

进 `src/client/hooks/useWorkbenchPolling.ts`：

* 那条**混合域轮询 effect**（原 L574-636）：5 秒 tick（草稿 → 提醒，串行）+ 15 秒 refresh、
  同一个 `try`、两个定时器、`alive` 清理、依赖数组 `[refresh, settings.desktopNotify]`。

**刻意留在装配层（本批不动，动它们属别的批次）**：

* `pendingDraft` → `PENDING_ATTR` 的 **DOM 投影 effect**（原 L641-645）—— 它写
  `document.documentElement`，是宿主 DOM 操作（设计 §4.1 末行）。
* `DraftBanner` 那一整块 JSX（原 L2102-2138）—— `onDone` 同时写点子域 / 知识域 / 日期域，
  是跨域组合（`d17-p2-exit-check.py:53` 的 `ideas.actions.refresh()` 唯一命中点就在 `onDone` 里）。
* 全部 JSX / props / className / portal 位置（本批靠"只换来源不改调用点文本"做到零改动）。

8 条核对：① 入口不再自建 ② 唯一所有者 ③ 草稿域 HTTP 归属与纯度 ④ 跨域注入
⑤ 轮询装配器（从 P5-2 接管） ⑥ 刻意留在入口的东西还在 ⑦ 结构指纹与调用顺序
⑧ ADR-0008 结构硬门（本批解锁的一条）+ 度量快照。
"""

from __future__ import annotations

import glob
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
os.chdir(ROOT)

INDEX_PATH = os.path.join("src", "client", "index.tsx")
DRAFTS_HOOK_PATH = os.path.normpath(os.path.join("src", "client", "hooks", "useWorkbenchDrafts.ts"))
POLLING_HOOK_PATH = os.path.normpath(os.path.join("src", "client", "hooks", "useWorkbenchPolling.ts"))

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

failures: list[str] = []
checks = 0


def load(p: str) -> str:
    with open(p, encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


def strip_comments(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r"^[ \t]*//.*$", "", s, flags=re.M)
    return s


def check(ok: bool, message: str) -> None:
    global checks
    checks += 1
    if ok:
        print(f"  \u2714 {message}")
    else:
        print(f"  \u2716 {message}")
        failures.append(message)


def bare(src: str, name: str, origin: str) -> int:
    """裸名在（已剥注释的）src 里的命中数：不算 `a.name` 这类成员访问，也不算对象字面量的键。"""
    return len(re.findall(r"(?<![\w.])" + re.escape(name) + r"\b(?!\s*:)", src))


def defs_of(src: str, name: str) -> int:
    """`const name = …` / `function name(…)` 形式的**定义**处数（允许行首缩进）。"""
    return len(re.findall(r"^[ \t]*(?:const|function)\s+" + re.escape(name) + r"\b", src, re.M))


def body_of(src: str, start: str, end: str | None = None) -> str | None:
    i = src.find(start)
    if i < 0:
        return None
    if end is None:
        return src[i:]
    j = src.find(end, i)
    if j < 0:
        return None
    return src[i:j]


def before(needle: str, marker: str, body: str) -> bool:
    """`needle` 在 `body` 里出现、且早于 `marker`。任一缺失都返回 False。"""
    i = body.find(needle)
    j = body.find(marker)
    return i >= 0 and j >= 0 and i < j


def client_sources() -> list[str]:
    pats = ["src/client/**/*.ts", "src/client/**/*.tsx"]
    out: list[str] = []
    for pat in pats:
        out.extend(glob.glob(pat, recursive=True))
    return sorted({os.path.normpath(p) for p in out if os.path.isfile(p)})


SOURCES = {p: load(p) for p in client_sources()}
STRIPPED = {p: strip_comments(s) for p, s in SOURCES.items()}
INDEX = SOURCES[os.path.normpath(INDEX_PATH)]
INDEX_BARE = STRIPPED[os.path.normpath(INDEX_PATH)]
DRAFTS = SOURCES[DRAFTS_HOOK_PATH]
DRAFTS_BARE = STRIPPED[DRAFTS_HOOK_PATH]
POLLING = SOURCES[POLLING_HOOK_PATH]
POLLING_BARE = STRIPPED[POLLING_HOOK_PATH]


def owners_of(snippet: str) -> list[str]:
    """哪些客户端源文件里有这段原文（剥注释后）。"""
    return sorted(p for p, s in STRIPPED.items() if snippet in s)


def app_body() -> str | None:
    """按大括号配对找 `function WorkbenchApp(` 的函数体（含首尾行）。

    口径与 `scripts/lib/d17-measure3.py` 一致 —— 避免"两种量法各说一套"。
    """
    lines = INDEX.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    start = None
    for i, l in enumerate(lines):
        if re.match(r"^(export )?function WorkbenchApp\(", l):
            start = i
            break
    if start is None:
        return None
    depth = 0
    for j in range(start, len(lines)):
        depth += lines[j].count("{") - lines[j].count("}")
        if j > start and depth == 0:
            return "\n".join(lines[start:j + 1])
    return None


# ---------------------------------------------------------------- 搬走的原文（逐字）
DRAFT_STATES = {
    "pendingDraft": "const [pendingDraft, setPendingDraft] = useState<DraftView | null>(null)",
    "deferredDrafts": "const [deferredDrafts, setDeferredDrafts] = useState<DraftView[]>([])",
    "draftProblems": "const [draftProblems, setDraftProblems] = useState<Array<{ title: string; field: string; code: string; reason: string }>>([])",
    "draftSwitchedFrom": "const [draftSwitchedFrom, setDraftSwitchedFrom] = useState<{ kindCode: string; draftId: string } | null>(null)",
    "allPendingDrafts": "const [allPendingDrafts, setAllPendingDrafts] = useState<DraftView[]>([])",
    "pendingOpen": "const [pendingOpen, setPendingOpen] = useState(false)",
    # ⚠️ `duplicatePrompt` 的内联类型在本批改成了具名 `DraftDuplicatePrompt`，
    #    所以"入口没有"这条按**入口原来的内联写法**断言（下面单列）。
}
DRAFT_DUPLICATE_OLD = "const [duplicatePrompt, setDuplicatePrompt] = useState<{"

DRAFT_REFS = {
    "dismissedDraftIdsRef": "const dismissedDraftIdsRef = useRef<Set<string>>(new Set())",
    "deferredWhenDismissedRef": "const deferredWhenDismissedRef = useRef<Set<string>>(new Set())",
    "bannerDraftRef": "const bannerDraftRef = useRef<DraftView | null>(null)",
}

DRAFT_ACTIONS = {
    "dismissDraft": "const dismissDraft = (draft: DraftView): void => {",
    "resumePendingDraft": "const resumePendingDraft = async (draft: DraftView): Promise<void> => {",
    "resumeDeferredDraft": "const resumeDeferredDraft = async (draftId: string): Promise<void> => {",
    "handleDraftConfirmed": "const handleDraftConfirmed = (outcome: DraftConfirmOutcome, draft: DraftView): void => {",
    "reuseExistingTask": "const reuseExistingTask = async (prompt: DraftDuplicatePrompt): Promise<void> => {",
    "tickDrafts": "const tickDrafts = useCallback(async (isAlive: () => boolean): Promise<void> => {",
}

# 入口解构出来的名字（本批刻意解构，保持所有调用点文本不变）
DRAFTS_HOOK_CALL = "const draftsApi = useWorkbenchDrafts({ refresh, onError: setError, onNotice: setNotice })"
# P7-3 清理后入口只为 JSX 解构的名字已删，只剩入口真读的两项。
DESTRUCTURED_RESULT = (
    "const { pendingDraft, allPendingDrafts } = draftsApi"
)
# P7-3 起入口不再解构草稿域动作 —— 这条常量改成"不许出现"的负向靶点。
DESTRUCTURED_ACTIONS_BLOCK = "} = draftsApi.actions"
POLLING_HOOK_CALL = (
    "  useWorkbenchPolling({\n"
    "    tickDrafts: draftsApi.actions.tickDrafts,\n"
    "    tickReminders: remindersApi.actions.tickDue,\n"
    "    refresh,\n"
    "    desktopNotify: settings.desktopNotify,\n"
    "  })"
)

print("=" * 78)
print("D17 / P5-3 出口自检（草稿域 + 轮询装配）")
print("=" * 78)

# ---------------------------------------------------------------- §1 入口不再自建
print("\n§1 入口不再自建本域任何东西")

check(DRAFTS_HOOK_PATH in SOURCES, "useWorkbenchDrafts.ts 存在")
check(POLLING_HOOK_PATH in SOURCES, "useWorkbenchPolling.ts 存在")

for name, decl in {**DRAFT_STATES, **DRAFT_REFS}.items():
    check(decl not in INDEX_BARE, f"入口不再声明：{name}")
check(DRAFT_DUPLICATE_OLD not in INDEX_BARE, "入口不再内联声明 duplicatePrompt（类型已具名搬走）")

for name, decl in DRAFT_ACTIONS.items():
    check(decl not in INDEX_BARE, f"入口不再定义动作：{name}")

for name in list(DRAFT_STATES) + list(DRAFT_REFS) + list(DRAFT_ACTIONS):
    check(defs_of(INDEX_BARE, name) == 0, f"入口没有 {name} 的第二份定义（缩进口径）")

check(body_of(INDEX_BARE, "    let alive = true") is None,
      "入口不再有轮询 effect 的 `let alive = true`（整条已搬进装配器）")
check("}, [refresh, settings.desktopNotify])" not in INDEX_BARE,
      "入口不再有原轮询 effect 的依赖数组原文")
check("/api/workbench/drafts" not in INDEX_BARE,
      "入口不再直接请求草稿端点（两条请求都随动作搬走）")
check(body_of(INDEX_BARE, "const r = await api<{ draft: DraftView | null; deferredDrafts?: DraftView[] }>(") is None,
      "入口不再内联拉待确认草稿")

# ---------------------------------------------------------------- §2 唯一所有者
print("\n§2 唯一所有者（全客户端递归）")

for name, decl in {**DRAFT_STATES, **DRAFT_REFS, **DRAFT_ACTIONS}.items():
    owners = owners_of(decl)
    check(owners == [DRAFTS_HOOK_PATH],
          f"创建者唯一 = 草稿域 hook（{name}）实际：{owners}")

check(owners_of("export function useWorkbenchDrafts(") == [DRAFTS_HOOK_PATH],
      "useWorkbenchDrafts 只定义一次（且在草稿域 hook）")
check(owners_of("export function useWorkbenchPolling(") == [POLLING_HOOK_PATH],
      "useWorkbenchPolling 只定义一次（且在轮询装配器）")
check(len(re.findall(r"^[ \t]*const \[pendingDraft, setPendingDraft\] = useState", DRAFTS_BARE, re.M)) == 1,
      "草稿域 hook 里 pendingDraft 恰好声明一次")
check(bare(DRAFTS_BARE, "useWorkbenchDrafts", "HOOK") == 1
      and "export function useWorkbenchDrafts(input: UseWorkbenchDraftsInput)" in DRAFTS_BARE,
      "草稿域 hook 里 useWorkbenchDrafts 只出现在自己的导出声明上（不递归引用）")
check(bare(POLLING_BARE, "useWorkbenchPolling", "HOOK") == 1
      and "export function useWorkbenchPolling(input: UseWorkbenchPollingInput): void" in POLLING_BARE,
      "装配器里 useWorkbenchPolling 只出现在自己的导出声明上（不递归引用）")
check(DRAFTS_HOOK_PATH not in POLLING and "useWorkbenchDrafts" not in POLLING_BARE,
      "装配器不认识草稿域 hook（只收一个 tick 函数）")

# ---------------------------------------------------------------- §3 草稿域 HTTP 归属与纯度
print("\n§3 草稿域 HTTP 归属与纯度")

for route in ["/api/workbench/drafts",
              "/api/workbench/drafts/${draftId}/resume",
              "/api/workbench/drafts/${prompt.draftId}/confirm",
              "/api/workbench/tasks/${created}/archive"]:
    check(route in DRAFTS, f"草稿域 hook 里仍有路由：{route}")

for route in ["/api/workbench/reminders", "/api/workbench/settings",
              "/api/workbench/knowledge-recall", "/api/workbench/dictionaries",
              "/api/workbench/personas", "/api/workbench/tasks`"]:
    check(route not in DRAFTS, f"草稿域 hook 不碰别的域路由：{route}")

check("fetch(" not in DRAFTS_BARE, "草稿域 hook 不用原生 fetch（统一走 api）")
check(len(re.findall(r"\bapi[<(]", DRAFTS_BARE)) >= 4,
      f"草稿域 hook 至少 4 处 api 调用（实测 {len(re.findall(r'api[<(]', DRAFTS_BARE))}））")
check("setInterval(" not in DRAFTS_BARE and "setTimeout(" not in DRAFTS_BARE,
      "草稿域 hook 里没有任何定时器（轮询容器归装配器）")
check("alive" not in DRAFTS_BARE, "草稿域 hook 不持有 alive（以 isAlive 回调注入）")
check("isAlive()) {" in DRAFTS_BARE or "if (isAlive()) {" in DRAFTS_BARE,
      "tickDrafts 仍逐字保留 `if (isAlive()) {` 守卫位置")
tick_body = body_of(DRAFTS_BARE, "const tickDrafts = useCallback(")
check(tick_body is not None, "tickDrafts 体内可定位")
if tick_body is not None:
    check(before("if (isAlive()) {", "setPendingDraft(", tick_body),
          "守卫在 setPendingDraft 之前（卸载后回来的响应不改状态）")
    check(before("if (isAlive()) {", "bannerDraftRef.current =", tick_body),
          "守卫同样挡在写 bannerDraftRef 之前")
    check("'/api/workbench/drafts'" in tick_body, "tickDrafts 拉的仍是待确认草稿端点")

# ---------------------------------------------------------------- §4 跨域注入
print("\n§4 跨域注入（设计 §5）")

check("  const { refresh, onError: setError, onNotice: setNotice } = input" in DRAFTS_BARE,
      "注入回调在 hook 里改回域内原名（函数体才不用改）")
for decl in ["refresh: () => Promise<void>",
             "onError: (message: string | null) => void",
             "onNotice: (message: string | null) => void"]:
    check(decl in DRAFTS, f"入参类型声明了 {decl.split(':')[0]}")

for name in ["setView", "useTaskData", "useWorkbenchSettings", "useWorkbenchReminders",
             "useKnowledge", "useIdeas", "useDayWorkspace", "useTaskListModel",
             "selectedRef", "currentSessionIdOf", "pushToast", "remindersApi", "prefs",
             "withSettingsFallback"]:
    check(bare(DRAFTS_BARE, name, "HOOK") == 0, f"草稿域 hook 不引用别的域：{name}")
check(bare(DRAFTS_BARE, "settings", "HOOK") == 0,
      "草稿域 hook 不引用设置域对象 settings")
check("'../views/" not in DRAFTS and "'./index.js'" not in DRAFTS,
      "草稿域 hook 不 import 任何 view / 入口")

# 两个注入口的**用法**也要守住
check("    void refresh()\n" in DRAFTS_BARE,
      "reuseExistingTask 收口成功仍刷新 bootstrap（`void refresh()`）")
check("setNotice(" in DRAFTS_BARE and "setError(" in DRAFTS_BARE,
      "草稿域仍用注入的 setNotice / setError 说话")

# ---------------------------------------------------------------- §5 轮询装配器（接管 P5-2 的 5 条）
print("\n§5 轮询装配器（5 秒 tick / 15 秒 refresh 的容器）")

poll = body_of(POLLING_BARE, "  useEffect(() => {")
check(poll is not None, "装配器里可定位轮询 effect")
if poll is not None:
    check("    let alive = true\n" in poll, "装配器持有 `let alive = true`（卸载守卫）")
    check(before("await tickDrafts(() => alive)", "await tickReminders(() => alive)", poll),
          "两半段**串行**且顺序不变：草稿 → 提醒")
    check(poll.count("setInterval(") == 2,
          f"装配器仍恰好 2 个定时器（5s tick / 15s refresh），实测 {poll.count('setInterval(')}")
    check("setInterval(() => void tick(), 5000)" in poll, "5 秒 tick 周期未改")
    check("setInterval(() => { void refresh().catch(() => undefined) }, 15000)" in poll,
          "15 秒 refresh 周期与自带 catch 未改")
    check("void tick()\n" in poll, "挂定时器之前先立即跑一次 tick")
    check(poll.count("try {") == 1 and "} catch { /* 轮询失败下轮重试 */ }" in POLLING,
          "两半段共用同一个 `try` / `catch`（异常范围不变；catch 文本按原文比对，剥注释后会消失）")
    check("return () => { alive = false; clearInterval(timer); clearInterval(refreshTimer) }" in poll,
          "卸载时 alive=false + 清两个 interval（清理不变）")
check("  }, [refresh, desktopNotify, tickDrafts, tickReminders])" in POLLING_BARE,
      "依赖数组把两个 tick 函数显式列出（等价性可被静态检查看见）")
check("/api/workbench" not in POLLING_BARE,
      "装配器不认识任何端点（纯时段/顺序/异常范围）")
check("useState" not in POLLING_BARE and "useRef" not in POLLING_BARE,
      "装配器不持任何状态（无业务状态的 effect 装配器，设计 §5.3）")
check("tickDrafts: (isAlive: () => boolean) => Promise<void>" in POLLING
      and "tickReminders: (isAlive: () => boolean) => Promise<void>" in POLLING
      and "desktopNotify: boolean" in POLLING,
      "装配器入参：两个 tick + refresh + desktopNotify 值")

check(INDEX_BARE.count(POLLING_HOOK_CALL) == 1,
      "入口恰好一处 useWorkbenchPolling 调用点（4 个入参写全，原文整块比对）")
check(INDEX_BARE.count("useWorkbenchPolling(") == 1,
      "入口 useWorkbenchPolling 恰好 1 个调用点")
check(INDEX_BARE.count(DRAFTS_HOOK_CALL) == 1,
      "入口恰好一处 useWorkbenchDrafts 调用点（3 个入参写全）")
check(INDEX_BARE.count("useWorkbenchDrafts(") == 1, "入口 useWorkbenchDrafts 恰好 1 个调用点")
check(INDEX_BARE.count(DESTRUCTURED_RESULT) == 1,
      "入口解构了草稿域结果（P7-3 起只剩入口真读的 pendingDraft / allPendingDrafts）")
check(DESTRUCTURED_ACTIONS_BLOCK not in INDEX_BARE,
      "入口不再解构草稿域动作（P7-3 清理：动作调用点随 JSX 搬进 app/，域内自用不经入口）")

# ---------------------------------------------------------------- §6 刻意留在入口的
print("\n§6 刻意留在装配层的东西还在")

check("useEffect(() => { dismissOnTaskChange() }, [selected?.task.id, dismissOnTaskChange])" in INDEX_BARE,
      "表单域的 dismissOnTaskChange effect 原文未动")
check("if (pendingDraft !== null) document.documentElement.setAttribute(PENDING_ATTR, '')" in INDEX_BARE
      and "else document.documentElement.removeAttribute(PENDING_ATTR)" in INDEX_BARE
      and INDEX_BARE.count("document.documentElement.removeAttribute(PENDING_ATTR)") == 2,
      "PENDING_ATTR 的宿主 DOM 投影 effect 仍留在装配层（含清理里的 remove）")

jsx = ["{pendingDraft !== null && <DraftBanner",
       "onProblems={setDraftProblems}",
       "onConfirmed={(outcome) => handleDraftConfirmed(outcome, pendingDraft)}",
       "onDismissed={() => { dismissDraft(pendingDraft) }}",
       "onSettled={() => setPendingDraft(null)}",
       "onClose={() => { dismissDraft(pendingDraft); setPendingDraft(null) }}",
       "onClick={() => setPendingOpen(true)}",
       "onClick={() => void reuseExistingTask(duplicatePrompt)}",
       "onClick={() => setDraftProblems([])}",
       "onClick={() => setDuplicatePrompt(null)}",
       "const pendingCount = allPendingDrafts.length + reminders.length",
       "allPendingDrafts.filter((d) => d.deferredAt === null).map",
       "resumeDeferredDraft(draft.id)"]
for prop in jsx:
    check(prop in INDEX_BARE or prop in UI_ALL, f"调用点原文未动：{prop[:58]}（P7-2 起在 app/ 四段组件里）")

check("onDone={() => { setPendingDraft(null); bumpPlanRefresh(); bumpReportRefresh(); knowledge.bumpRefreshKey(); ideas.actions.refresh(); void refresh() }}" in UI_OVERLAYS,
      "DraftBanner 的跨域 onDone 仍在装配层（P7-2 起 owner = app/WorkbenchOverlays.tsx；点子/知识/日期三域一处写）")
# P6-3：那段计划复用判定（`hasPendingPlanDraft`）随 `reuseAiSessionId` 搬进 AI 会话域 hook。
# 本域要守的是"草稿域的 `pendingDraft` 仍被**唯一那个消费者**读"—— 所以判据跟着 owner 走：
# 正向指新家，入口改负向。这不是放宽（入口若还留一份实现，下面两条会同时红）。
AI_HOOK_PATH = os.path.normpath(os.path.join("src", "client", "hooks", "useWorkbenchAISessions.ts"))
AI_HOOK_BARE = strip_comments(load(AI_HOOK_PATH))
check("const hasPendingPlanDraft = pendingDraft !== null" in AI_HOOK_BARE,
      "计划复用判定读的是草稿域的 pendingDraft（P6-3 起 owner 是 AI 会话域 hook）")
check("const hasPendingPlanDraft = pendingDraft !== null" not in INDEX_BARE,
      "入口不再有第二份 hasPendingPlanDraft（判据跟着 owner 走）")

# ---------------------------------------------------------------- §7 结构指纹
print("\n§7 结构指纹与调用顺序")

check("import { useWorkbenchDrafts } from './hooks/useWorkbenchDrafts.js'" in INDEX,
      "入口 import 草稿域 hook（顶层，路径 .js）")
check("import { useWorkbenchPolling } from './hooks/useWorkbenchPolling.js'" in INDEX,
      "入口 import 轮询装配器（顶层，路径 .js）")

i_data = INDEX_BARE.find("  } = data.actions")
i_drafts = INDEX_BARE.find("const draftsApi = useWorkbenchDrafts({")
i_prefs = INDEX_BARE.find("const prefs = useWorkbenchSettings({")
i_rem = INDEX_BARE.find("const remindersApi = useWorkbenchReminders({")
i_poll = INDEX_BARE.find("  useWorkbenchPolling({")
check(min(i_data, i_drafts, i_prefs, i_rem, i_poll) > 0, "五个关键调用点都找得到（顺序断言的前提）")
check(0 < i_data < i_drafts, "调用顺序：任务数据域 `data.actions` → draftsApi（要注入 refresh）")
check(i_drafts < i_prefs < i_rem,
      "调用顺序：draftsApi → prefs（设置域）→ remindersApi（提醒域）")
check(i_rem < i_poll, "调用顺序：remindersApi → useWorkbenchPolling（要注入 tickDue）")

for comment, least in [("草稿域（D17/P5-3）", 5)]:
    check(INDEX.count(comment) >= least, f"入口保留了指针注释：{comment}（{INDEX.count(comment)} 处）")

# ---------------------------------------------------------------- §8 ADR-0008 结构硬门 + 度量
print("\n§8 ADR-0008 结构硬门（本批解锁的一条）与度量快照")

body = app_body()
check(body is not None, "WorkbenchApp 函数体可定位（大括号配对）")
if body is not None:
    body_lines = len(body.split("\n"))
    check(200 < body_lines < 3500, f"取到的是真正的函数体（{body_lines} 行）")
    check("const assembly: WorkbenchAssembly = {" in body, "函数体尾部锚点在位（装配束那行；P7-2 后 onDone 已随 JSX 搬进 app/）")
    check(body.count("setInterval(") == 0,
          f"WorkbenchApp 体内零 `setInterval(`（本批解锁，实测 {body.count('setInterval(')}）")
    check(body.count("setTimeout(") == 0,
          f"WorkbenchApp 体内零 `setTimeout(`（实测 {body.count('setTimeout(')}）")
    check(body.count("fetch(") == 0, "WorkbenchApp 体内零原生 `fetch(`")
    check("/api/workbench/drafts" not in body,
          "WorkbenchApp 体内零草稿端点字面量（本批清零）")
    print(f"     ℹ 度量：WorkbenchApp {body_lines} 行；"
          f"useState 声明 {len(re.findall(r'const \[[^]]+\] = useState[<(]', body))} 项；"
          f"api 调用 {body.count('api(') + body.count('api<')} 处；"
          f"useEffect {body.count('useEffect(')} 条；"
          f"其余域端点字面量 {body.count('/api/workbench')} 处（P6/P7 继续清零）")

check(INDEX.count("setInterval(") == 1 and "const titlebarTimer = setInterval(() => {" in INDEX,
      "入口整份文件只剩 1 个 setInterval（插件 setup 作用域里的 titlebarTimer，不属 WorkbenchApp）")
check(INDEX.count("setTimeout(") == 0, "入口整份文件零 setTimeout")

print("\n" + "=" * 78)
if failures:
    print(f"✖ {len(failures)} / {checks} 项未通过")
    for f in failures:
        print(f"   - {f}")
    sys.exit(1)
print(f"✔ 全部 {checks} 项通过")
sys.exit(0)
