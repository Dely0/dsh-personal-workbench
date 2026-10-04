#!/usr/bin/env python3
"""D17 P1 收尾（换行无关 + 幂等 + 打印真因）。

本版修三个东西：
1) `index.tsx`：`useKnowledge` 的 `startAISession` 入参改成 ref 惰性转发（并补回被误删的
   `KnowledgeEntry` 类型 import）；残留的 file 模式 `<LocalDocModal>` 一并删除。
2) `hooks/useKnowledge.ts`：`buildListPage` 显式给 `ContentItem` 泛型实参 —— 否则推断成
   `ListPage<PresentableItem>`，赋给 `KnowledgeList` 的 `ListPage<ContentItem>` 当场报 TS2322。
3) 失败时**打印锚点附近的真实文本**，不再只报「命中 0 次」。
"""
import io
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def load(path):
    raw = open(path, encoding="utf-8", newline="").read()
    return raw.replace("\r\n", "\n").replace("\r", "\n")


def save(path, text):
    open(path, "w", encoding="utf-8", newline="").write(text.replace("\n", "\r\n"))


def sub1(src, old, new, tag, show_after=None):
    n = src.count(old)
    if n != 1:
        hint = ""
        if show_after is not None:
            i = src.find(show_after)
            hint = "\n  真实文本：\n" + repr(src[max(0, i - 260):i + 320]) if i >= 0 else "\n  （连定位串都没找到）"
        raise SystemExit(f"ABORT [{tag}] 命中 {n} 次（要求恰好 1）{hint}")
    print(f"  ok  {tag}")
    return src.replace(old, new, 1)


# ======================= index.tsx =======================
FILE = "src/client/index.tsx"
src = load(FILE)
changed = False

if "  KnowledgeEntry, SessionDriver," not in src:
    src = sub1(
        src,
        "  SessionDriver, Task, TaskDetail, TaskReportView, WorkbenchRuntime,\n} from './viewTypes.js'",
        "  KnowledgeEntry, SessionDriver, Task, TaskDetail, TaskReportView, WorkbenchRuntime,\n} from './viewTypes.js'",
        "补回 KnowledgeEntry import",
    )
    changed = True

if "const startAISessionRef = useRef" not in src:
    src = sub1(
        src,
        "   * 域 hook 常驻在顶层、不放进条件视图，所以切视图不会重置知识域状态（设计 §4.2）。\n"
        "   */\n"
        "  const knowledge = useKnowledge({",
        "   * 域 hook 常驻在顶层、不放进条件视图，所以切视图不会重置知识域状态（设计 §4.2）。\n"
        "   *\n"
        "   * ⚠️ `startAISession` 是**本组件中部**才声明的 `const`（没有提升），所以这里传的是\n"
        "   * 一个**惰性转发 ref**（`startAISessionRef`），在它定义之后一行内写入 `current`；\n"
        "   * 否则 `useKnowledge` 的入参求值当场 ReferenceError。\n"
        "   */\n"
        "  const startAISessionRef = useRef<StartAISessionFn | null>(null)\n"
        "  const knowledge = useKnowledge({",
        "声明 startAISessionRef",
        show_after="域 hook 常驻在顶层",
    )
    changed = True

if "    startAISession: startAISessionRef," not in src:
    src = sub1(
        src,
        "    isAlive: () => instanceAlive,\n    startAISession,\n",
        "    isAlive: () => instanceAlive,\n    startAISession: startAISessionRef,\n",
        "useKnowledge 入参改成 ref",
        show_after="isAlive: () => instanceAlive",
    )
    changed = True

if "import { useKnowledge } from './hooks/useKnowledge.js'" in src:
    src = sub1(
        src,
        "import { useKnowledge } from './hooks/useKnowledge.js'",
        "import { useKnowledge, type StartAISessionFn } from './hooks/useKnowledge.js'",
        "useKnowledge import 带类型",
    )
    changed = True

if "  startAISessionRef.current = startAISession\n" not in src:
    src = sub1(
        src,
        "  }\n\n  /**\n   * 复用型会话：计划/报告/点子关联/点子头脑风暴",
        "  }\n"
        "  /**\n"
        "   * D17：把 `startAISession` 交给知识域 hook（`useKnowledge` 在组件上部调用，那时它还没声明）。\n"
        "   * 这里是**普通赋值**，不是 hook 调用 —— 不改变 hook 顺序，也不额外触发渲染。\n"
        "   */\n"
        "  startAISessionRef.current = startAISession\n"
        "\n"
        "  /**\n"
        "   * 复用型会话：计划/报告/点子关联/点子头脑风暴",
        "写入 startAISessionRef.current",
        show_after="复用型会话：计划/报告/点子关联",
    )
    changed = True

STALE_RE = re.compile(
    r"^      <LocalDocModal\n"
    r"        open=\{filePickerOpen\}\n"
    r"        path=\{localDocPath\}\n"
    r"        listing=\{filePickerListing\}\n"
    r"        loading=\{filePickerLoading\}\n"
    r"        error=\{filePickerError\}\n"
    r"        busy=\{busy\}\n"
    r"        onPathChange=\{setLocalDocPath\}\n"
    r"        onClose=\{\(\) => setFilePickerOpen\(false\)\}\n"
    r"        onNavigate=\{\(target\) => void loadFilePickerDir\(target\)\}\n"
    r"        onPick=\{pickLocalFile\}\n"
    r"        onPickAndSummarize=\{pickAndSummarizeLocalFile\}\n"
    r"        onSummarize=\{\(\) => void summarizeLocalDoc\(\)\}\n"
    r"      />\n",
    re.M,
)
hits = STALE_RE.findall(src)
if len(hits) == 1:
    src = STALE_RE.sub("", src, count=1)
    print("  ok  删掉残留的 file 模式 LocalDocModal")
    changed = True
elif len(hits) == 0:
    if "filePickerOpen" in src:
        raise SystemExit("ABORT 残留 modal 匹配不到但 filePickerOpen 仍在 —— 人工看一眼")
    print("  --  残留 modal 已不存在")
else:
    raise SystemExit(f"ABORT 残留 modal 命中 {len(hits)} 次")

if changed:
    save(FILE, src)
print(f"index.tsx: {'已写回' if changed else '无改动（幂等）'}，{len(src.splitlines())} 行")

# ======================= hooks/useKnowledge.ts =======================
H = "src/client/hooks/useKnowledge.ts"
hsrc = load(H)
hchanged = False

if "buildListPage<ContentItem>" not in hsrc:
    hsrc = sub1(
        hsrc,
        "  const page = useMemo(() => buildListPage({",
        "  const page = useMemo(() => buildListPage<ContentItem>({",
        "buildListPage 显式泛型 <ContentItem>",
        show_after="const page = useMemo(() => buildListPage(",
    )
    hchanged = True

if "  type KnowledgeFilters,\n} from '../components/KnowledgeList.js'" in hsrc and "ContentItem" not in hsrc.split("\n")[19]:
    hsrc = sub1(
        hsrc,
        "import { buildListPage, DEFAULT_SORT_DIR, normalizePageSize, normalizeSortDir, normalizeSortKey, toContentItem } from '../listPresentation.js'",
        "import { buildListPage, DEFAULT_SORT_DIR, normalizePageSize, normalizeSortDir, normalizeSortKey, toContentItem, type ContentItem } from '../listPresentation.js'",
        "import ContentItem 类型",
    )
    hchanged = True

if hchanged:
    save(H, hsrc)
print(f"useKnowledge.ts: {'已写回' if hchanged else '无改动（幂等）'}")
