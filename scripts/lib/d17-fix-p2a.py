import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")

edits = [
    # 1) 三个新模块的 import（P2 抽取出来的 owner）
    (
        "import { KnowledgeDetailPane } from './views/KnowledgeDetailPane.js'\n"
        "import { IdeaCardGrid, type IdeaCardItem } from './components/IdeaCardGrid.js'\n",
        "import { KnowledgeDetailPane } from './views/KnowledgeDetailPane.js'\n"
        "import { useIdeas } from './hooks/useIdeas.js'\n"
        "import { IdeasListView } from './views/IdeasListView.js'\n"
        "import { IdeasDetailPane } from './views/IdeasDetailPane.js'\n",
        "补 useIdeas / IdeasListView / IdeasDetailPane 的 import，并删掉已无使用者的 IdeaCardGrid/IdeaCardItem import",
    ),
    # 2) DraftBanner onDone：点子域的失效动作
    (
        "setIdeaRefreshKey((v) => v + 1); void refresh() }}",
        "ideas.refresh(); void refresh() }}",
        "DraftBanner.onDone 改用 ideas.refresh()（旧 setIdeaRefreshKey 已随 P2 删除）",
    ),
]

for old, new, tag in edits:
    if new in src and old not in src:
        print(f"  --  {tag}（已应用，跳过）")
        continue
    n = src.count(old)
    if n != 1:
        i = src.find(old[:60]) if n else -1
        raise SystemExit(f"ABORT [{tag}] 命中 {n} 次\n附近真实文本:\n{src[i-260:i+320]!r}")
    src = src.replace(old, new, 1)
    print(f"  ok  {tag}")

open(FILE, "w", encoding="utf-8", newline="\n").write(src)
print(f"lines -> {src.count(chr(10)) + 1}")
