#!/usr/bin/env python3
"""D17 P2：把点子域从 `src/client/index.tsx` 搬走。

一次性做完：插入 `useIdeas` 接线 → 左侧视图换成 `<IdeasListView>` → 右侧详情换成
`<IdeasDetailPane>` → 删掉旧状态 / 派生 / 动作 / 文件夹弹窗。

区间删除用「首行子串 + 末行子串」双向校验（行区间最容易差 1 行），命中不对就整体中止不写文件。
删除动作按行号**从后往前**做，避免前面的删除影响后面的行号。
"""
import io
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, "rb").read().decode("utf-8")
src = src.replace("\r\n", "\n").replace("\r", "\n")


def sub1(old, new, tag):
    global src
    if new in src and old not in src:
        print(f"  --  {tag}（已应用，跳过）")
        return
    n = src.count(old)
    if n != 1:
        i = src.find(old) if n else -1
        ctx = src[max(0, i - 200):i + 200] if i >= 0 else ""
        raise SystemExit(f"ABORT [{tag}] 命中 {n} 次\n  ctx={ctx!r}")
    src = src.replace(old, new, 1)
    print(f"  ok  {tag}")


def subn(pattern, new, tag, flags=0):
    global src
    out, n = re.subn(pattern, new, src, flags=flags)
    if n == 0:
        raise SystemExit(f"ABORT [{tag}] 无命中")
    src = out
    print(f"  ok  {tag} ×{n}")


# ============================================================ 0. 接线：useIdeas
ANCHOR_UK = """    startAISession: startAISessionRef,
    setError: (message) => setError(message),
    setNotice: (message) => setNotice(message),
  })
"""
if "const ideas = useIdeas({" in src:
    print("  --  useIdeas 接线（已存在）")
else:
    sub1(ANCHOR_UK, ANCHOR_UK + """
  /**
   * D17 / P2：点子域的全部 state / 派生 / 动作已经收进 `hooks/useIdeas.ts`。
   *
   * 与知识域同样常驻在顶层、不放进条件视图：切视图不会重置点子域状态（设计 §4.2）。
   * `startAISession` 在下面才声明（`const` 没有提升），所以这里用同一个惰性转发 ref；
   * `ideasAll` 是 `ideas` 的只读快照，供上面 `startAISession` 里拼 `idea_association` /
   * `idea_brainstorm` 提示词用 —— 可写状态仍然只有 `useIdeas` 一份。
   */
  const ideas = useIdeas({
    activeView: view,
    setError: (message) => setError(message),
    setNotice: (message) => setNotice(message),
  })
  const ideasAll = ideas.allIdeas
""", "useIdeas 接线")

# ============================================================ 1. 左侧视图
LEFT_OLD_START = "          {view === 'ideas' && (\n            <>\n"
LEFT_OLD_END = "            </>\n          )}\n"
i0 = src.find(LEFT_OLD_START)
if i0 < 0:
    raise SystemExit("ABORT 找不到点子左侧视图起点")
i1 = src.find(LEFT_OLD_END, i0)
if i1 < 0:
    raise SystemExit("ABORT 找不到点子左侧视图终点")
left_block = src[i0:i1 + len(LEFT_OLD_END)]
if "IdeaCardGrid" not in left_block or "新建空文件夹" not in left_block:
    raise SystemExit("ABORT 左侧视图区间不对")
src = src[:i0] + "          {view === 'ideas' && <IdeasListView model={ideas} dictOf={dictOf} busy={busy} startAISession={startAISession} />}\n" + src[i1 + len(LEFT_OLD_END):]
print(f"  ok  左侧视图 {left_block.count(chr(10))} 行 → 1 行")

# ============================================================ 2. 右侧详情（三处三元 + 空态）
DETAIL_START = "          {view === 'ideas'\n            ? ideaForm !== null\n"
DETAIL_END = "                  : <div className=\"wb-empty\">← 从左侧选择一个点子/点子王，或点“记个点子”</div>\n"
j0 = src.find(DETAIL_START)
if j0 < 0:
    raise SystemExit("ABORT 找不到点子详情起点")
j1 = src.find(DETAIL_END, j0)
if j1 < 0:
    raise SystemExit("ABORT 找不到点子详情终点")
detail_block = src[j0:j1 + len(DETAIL_END)]
if "selectedCluster.ideas.map" not in detail_block or "删除这个点子？" not in detail_block:
    raise SystemExit("ABORT 详情区间不对")
src = src[:j0] + "          {view === 'ideas'\n            ? <IdeasDetailPane model={ideas} dictOf={dictOf} busy={busy} startAISession={startAISession} />\n" + src[j1 + len(DETAIL_END):]
print(f"  ok  右侧详情 {detail_block.count(chr(10))} 行 → 1 行")

# ============================================================ 3. 文件夹弹窗
FOLDER_START = "      {folderForm !== null && (\n"
FOLDER_END = "      )}\n"
k0 = src.find(FOLDER_START)
if k0 < 0:
    raise SystemExit("ABORT 找不到文件夹弹窗起点")
k1 = src.find(FOLDER_END, k0)
if k1 < 0:
    raise SystemExit("ABORT 找不到文件夹弹窗终点")
folder_block = src[k0:k1 + len(FOLDER_END)]
if "重命名文件夹" not in folder_block or "saveFolder" not in folder_block:
    raise SystemExit("ABORT 文件夹弹窗区间不对")
src = src[:k0] + src[k1 + len(FOLDER_END):]
print(f"  ok  文件夹弹窗 -{folder_block.count(chr(10))} 行")

# ============================================================ 4. 状态声明块（13 项 → 一行注释）
STATE_START = "  const [ideas, setIdeas] = useState<Idea[]>([])\n"
STATE_END = "  const [ideaRefreshKey, setIdeaRefreshKey] = useState(0)\n"
s0 = src.find(STATE_START)
if s0 < 0:
    raise SystemExit("ABORT 找不到点子 state 起点")
s1 = src.find(STATE_END, s0)
if s1 < 0:
    raise SystemExit("ABORT 找不到点子 state 终点")
state_block = src[s0:s1 + len(STATE_END)]
if "const [folderForm" not in state_block or "const [ideaForm" not in state_block:
    raise SystemExit("ABORT state 区间不对")
src = src[:s0] + "  // 点子域（D17 / P2）的 12 项状态与 13 项派生/动作已收进 hooks/useIdeas.ts\n" + src[s1 + len(STATE_END):]
print(f"  ok  点子 state {state_block.count(chr(10))} 行 → 1 行注释")

# ============================================================ 5. loadIdeas + effect
LOAD_START = "  const loadIdeas = useCallback(async () => {\n"
LOAD_END = "  }, [view, loadIdeas, ideaRefreshKey])\n"
l0 = src.find(LOAD_START)
if l0 < 0:
    raise SystemExit("ABORT 找不到 loadIdeas 起点")
l1 = src.find(LOAD_END, l0)
if l1 < 0:
    raise SystemExit("ABORT 找不到 loadIdeas 终点")
load_block = src[l0:l1 + len(LOAD_END)]
if "idea-clusters" not in load_block or "setIdeas(" not in load_block:
    raise SystemExit("ABORT loadIdeas 区间不对")
src = src[:l0] + src[l1 + len(LOAD_END):]
print(f"  ok  loadIdeas + effect -{load_block.count(chr(10))} 行")

# ============================================================ 6. ideaCardItems
CARD_START = "  /** 点子卡片网格的入参：附上\"属于哪些文件夹\"，组件不自己去翻 ideaClusters。 */\n"
CARD_END = "  })), [ideas, ideaClusters])\n"
c0 = src.find(CARD_START)
if c0 < 0:
    raise SystemExit("ABORT 找不到 ideaCardItems 起点")
c1 = src.find(CARD_END, c0)
if c1 < 0:
    raise SystemExit("ABORT 找不到 ideaCardItems 终点")
card_block = src[c0:c1 + len(CARD_END)]
src = src[:c0] + src[c1 + len(CARD_END):]
print(f"  ok  ideaCardItems -{card_block.count(chr(10))} 行")

# ============================================================ 7. unfiledIdeas + 六个动作
ACT_START = "  const unfiledIdeas = useMemo(() => {\n"
ACT_END = "    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }\n  }\n"
a0 = src.find(ACT_START)
if a0 < 0:
    raise SystemExit("ABORT 找不到 unfiledIdeas 起点")
# 最后一个动作是 mergeFolderInto，它的结束就是 ACT_END 的最后一次出现（在本块内）
a1 = src.find(ACT_END, a0)
if a1 < 0:
    raise SystemExit("ABORT 找不到动作块终点")
# 往后找到 mergeFolderInto 的结束（连续 3 次 catch 之后）
for _ in range(3):
    nxt = src.find(ACT_END, a1 + 1)
    if nxt < 0:
        break
    a1 = nxt
act_block = src[a0:a1 + len(ACT_END)]
for must in ("const unfiledIdeas", "const refreshIdeas", "const saveFolder", "const deleteFolder",
             "const fileIdeaInto", "const unfileIdeaFrom", "const mergeFolderInto"):
    if must not in act_block:
        raise SystemExit(f"ABORT 动作块缺 {must}")
src = src[:a0] + src[a1 + len(ACT_END):]
print(f"  ok  unfiledIdeas + 6 个动作 -{act_block.count(chr(10))} 行")

# ============================================================ 8. startAISession 里两处读 ideas
sub1("const selected = ideas.filter((idea) => text.split(',').includes(idea.id))",
     "const selected = ideasAll.filter((idea) => text.split(',').includes(idea.id))", "assoc 读 ideasAll")
sub1("sourceIdeas = ideas.filter((idea) => text.slice(5).split(',').includes(idea.id))",
     "sourceIdeas = ideasAll.filter((idea) => text.slice(5).split(',').includes(idea.id))", "brainstorm 读 ideasAll")

open(FILE, "w", encoding="utf-8", newline="\n").write(src)
print(f"lines -> {src.count(chr(10)) + 1}")
