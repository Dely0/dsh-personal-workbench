#!/usr/bin/env python3
"""D17 P2：从 index.tsx 重抽左侧视图片段 → 语义替换 → 落成 views/IdeasListView.tsx。

可重复执行（每次都从 index.tsx 重新抽取，不在半成品上二次加工）。
"""
import io
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SRC = "src/client/index.tsx"
lines = open(SRC, "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").split("\n")

START, END = 3207, 3302
assert lines[START - 1].strip() == "{view === 'ideas' && (", f"首行不符：{lines[START - 1]!r}"
assert lines[END - 1].strip() == ")}", f"末行不符：{lines[END - 1]!r}"
body = "\n".join(lines[START:END - 1])
body = "\n".join(l[2:] if l.startswith("  ") else l for l in body.split("\n"))

REPL = [
    ("setIdeaTab('ideas'); setSelectedCluster(null)", "model.setTab('ideas'); model.actions.clearSelection()"),
    ("setIdeaTab('unfiled'); setSelectedCluster(null)", "model.setTab('unfiled'); model.actions.clearSelection()"),
    ("setIdeaTab('clusters'); setSelectedIdea(null)", "model.setTab('clusters'); model.actions.clearSelection()"),
    ("onChange={(e) => setIdeaQuery(e.target.value)}", "onChange={(e) => model.setQuery(e.target.value)}"),
    ("setIdeaEditId(null); setIdeaForm({ title: '', contentMd: '', kindCode: 'spark', tags: '' }); setSelectedIdea(null)",
     "model.actions.startCreate()"),
    ("onClick={() => { setSelectedIdea(null); setSelectedCluster(cluster) }}",
     "onClick={() => model.actions.openCluster(cluster)}"),
    ("onClick={() => setFolderForm({ mode: 'rename', id: cluster.id, title: cluster.title, summaryMd: cluster.summaryMd })}",
     "onClick={() => model.setFolderForm({ mode: 'rename', id: cluster.id, title: cluster.title, summaryMd: cluster.summaryMd })}"),
    ("onClick={() => setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}",
     "onClick={() => model.setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}"),
    ("onCreateFolder={() => setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}",
     "onCreateFolder={() => model.setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}"),
    ("onClick={() => void deleteFolder(cluster.id)}", "onClick={() => model.actions.deleteFolder(cluster.id)}"),
    ("onFileInto={(ideaId, clusterId) => { void fileIdeaInto(ideaId, clusterId) }}",
     "onFileInto={(ideaId, clusterId) => model.actions.fileIdeaInto(ideaId, clusterId)}"),
    ("""onOpen={(item) => {
                      const idea = ideas.find((x) => x.id === item.id)
                      if (idea === undefined) return
                      setSelectedCluster(null); setSelectedIdea(idea)
                    }}""",
     "onOpen={(item) => model.actions.openIdea(item.id)}"),
    ("""onTogglePick={(id) => setSelectedIdeaIds((prev) => {
                      const next = new Set(prev)
                      if (next.has(id)) next.delete(id); else next.add(id)
                      return next
                    })}""",
     "onTogglePick={(id) => model.togglePick(id)}"),
]
for old, new in REPL:
    n = body.count(old)
    if n == 0:
        raise SystemExit(f"ABORT 找不到片段（{old[:60]!r}）")
    body = body.replace(old, new)

# 数据源与计数：按"只在这个词是独立标识符时"替换，避免误伤 `clusters={...}` 这类已有 model 前缀的地方。
TOKENS = [
    ("ideaCardItems", "model.cardItems"),
    ("ideaClusters", "model.clusters"),
    ("unfiledIdeas", "model.unfiledIdeas"),
    ("selectedIdeaIds", "model.pickedIds"),
    ("selectedIdea?.id", "model.selectedIdea?.id"),
    ("selectedCluster?.id", "model.selectedCluster?.id"),
    ("ideas.length", "model.ideas.length"),
    ("value={ideaQuery}", "value={model.query}"),
    ("ideaTab === ", "model.tab === "),
    ("ideaTab !== ", "model.tab !== "),
]
for old, new in TOKENS:
    n = body.count(old)
    if n == 0:
        raise SystemExit(f"ABORT 找不到标识符：{old!r}")
    body = body.replace(old, new)
    print(f"  ok  ×{n}  {old} → {new}")

left = re.findall(r"(?<![\w.$])(ideaClusters|selectedIdeaIds|unfiledIdeas|ideaTab|selectedIdea|selectedCluster|setFolderForm|setSelectedIdea|setSelectedCluster|deleteFolder|fileIdeaInto|ideaQuery)(?![\w])", body)
if left:
    raise SystemExit(f"ABORT 仍有未替换的点子域标识符：{sorted(set(left))}")

FINAL = """/**
 * D17 / P2：点子页左侧视图（页签 / 搜索 / AI 关联与新建按钮 / 文件夹网格 / 点子卡片网格 / 两种空态）。
 *
 * 本文件**不持有状态**：`model` 是 `hooks/useIdeas.ts` 的返回值。
 * 唯一例外是 `busy` 与 `startAISession` —— 它们属于 AI 会话域，拆前就直通入口，
 * 这里仍然只是**转发**（设计文档 §5：展示组件不拿跨域 setter、不自行调 HTTP）。
 */
import { Icon } from '../components/Icon.js'
import { IdeaCardGrid } from '../components/IdeaCardGrid.js'
import type { KnowledgeDictFn, StartAISessionFn } from '../hooks/useKnowledge.js'
import type { UseIdeasResult } from '../hooks/useIdeas.js'

export type IdeasListViewProps = {
  model: UseIdeasResult
  dictOf: KnowledgeDictFn
  busy: boolean
  startAISession: StartAISessionFn
}

export function IdeasListView({ model, dictOf, busy, startAISession }: IdeasListViewProps): JSX.Element {
  return (
    <>
%s
    </>
  )
}
""" % body

open("src/client/views/IdeasListView.tsx", "w", encoding="utf-8", newline="\n").write(FINAL)
print(f"WROTE src/client/views/IdeasListView.tsx  {len(FINAL.split(chr(10)))} 行")
