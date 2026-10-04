#!/usr/bin/env python3
"""D17 P2：从 index.tsx 的 JSX 区域里提取左侧点子视图，按语义替换成 model 调用，写出 view 文件。

做法：**从原文按行区间抽取 + 整段做 setter→model 替换**，而不是手工重打一遍。
手工重打 100 行 JSX 必然悄悄改掉某处 DOM/文案，而设计文档 §2.1-⑤ 要求 DOM 层级、类名、
data 属性、文案**逐字保持**。抽取法能保证"除了这些点名的替换，其余一字不改"。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SRC = "src/client/index.tsx"
raw = open(SRC, "rb").read().decode("utf-8")
lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")

START, END = 3207, 3302
assert lines[START - 1].strip() == "{view === 'ideas' && (", f"首行不符：{lines[START - 1]!r}"
assert lines[END - 1].strip() == ")}", f"末行不符：{lines[END - 1]!r}"

body = "\n".join(lines[START:END - 1])          # 去掉首行 `{view === 'ideas' && (` 与末行 `)}`
body = "\n".join(l[2:] if l.startswith("  ") else l for l in body.split("\n"))   # 去 2 空格缩进

REPL = [
    # —— 工具条 ——
    ("setIdeaTab('ideas'); setSelectedCluster(null)", "model.setTab('ideas'); model.actions.clearSelection()"),
    ("setIdeaTab('unfiled'); setSelectedCluster(null)", "model.setTab('unfiled'); model.actions.clearSelection()"),
    ("setIdeaTab('clusters'); setSelectedIdea(null)", "model.setTab('clusters'); model.actions.clearSelection()"),
    ("onChange={(e) => setIdeaQuery(e.target.value)}", "onChange={(e) => model.setQuery(e.target.value)}"),
    ("<button className=\"wb-btn\" onClick={() => setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}><Icon name=\"folder\" />新建文件夹</button>",
     "<button className=\"wb-btn\" onClick={() => model.setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}><Icon name=\"folder\" />新建文件夹</button>"),
    ("setIdeaEditId(null); setIdeaForm({ title: '', contentMd: '', kindCode: 'spark', tags: '' }); setSelectedIdea(null)",
     "model.actions.startCreate()"),
    # —— 文件夹卡片 ——
    ("onClick={() => { setSelectedIdea(null); setSelectedCluster(cluster) }}",
     "onClick={() => model.actions.openCluster(cluster)}"),
    ("onClick={() => setFolderForm({ mode: 'rename', id: cluster.id, title: cluster.title, summaryMd: cluster.summaryMd })}",
     "onClick={() => model.setFolderForm({ mode: 'rename', id: cluster.id, title: cluster.title, summaryMd: cluster.summaryMd })}"),
    ("onClick={() => void deleteFolder(cluster.id)}", "onClick={() => model.actions.deleteFolder(cluster.id)}"),
    ("onClick={() => setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}",
     "onClick={() => model.setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}"),
    # —— 卡片网格 ——
    ("ideas={ideaCardItems}", "ideas={model.cardItems}"),
    ("selectedId={selectedIdea?.id}", "selectedId={model.selectedIdea?.id}"),
    ("pickedIds={selectedIdeaIds}", "pickedIds={model.pickedIds}"),
    ("clusters={ideaClusters.map((c) => ({ id: c.id, title: c.title }))}",
     "clusters={model.clusters.map((c) => ({ id: c.id, title: c.title }))}"),
    ("pickedIds={selectedIdeaIds}", "pickedIds={model.pickedIds}"),
    ("onFileInto={(ideaId, clusterId) => { void fileIdeaInto(ideaId, clusterId) }}",
     "onFileInto={(ideaId, clusterId) => model.actions.fileIdeaInto(ideaId, clusterId)}"),
    # —— 计数与选中数 ——
    ("{ideas.length}", "{model.ideas.length}"),
    ("{unfiledIdeas.length}", "{model.unfiledIdeas.length}"),
    ("{ideaClusters.length}", "{model.clusters.length}"),
    ("{ideaTab ===", "{model.tab ==="),
    ("{selectedIdeaIds.size}", "{model.pickedIds.size}"),
    ("[...selectedIdeaIds]", "[...model.pickedIds]"),
]

for old, new in REPL:
    n = body.count(old)
    if n == 0:
        continue
    body = body.replace(old, new)
    print(f"  ok  ×{n}  {old[:72]}")

LEFT = ('{model.ideas.length}', '{model.unfiledIdeas.length}', '{model.clusters.length}')
for token in ['ideaCardItems', 'ideaClusters', 'selectedIdeaIds', 'unfiledIdeas', 'ideaTab', 'selectedIdea',
              'selectedCluster', 'setIdeaTab', 'setIdeaQuery', 'setFolderForm', 'setIdeaForm', 'setIdeaEditId',
              'setSelectedIdea', 'setSelectedCluster', 'deleteFolder(', 'fileIdeaInto(', 'ideas.length',
              'ideaQuery', 'busy', 'startAISession']:
    if token in body:
        print(f"  ⚠ 残留：{token}")

open("scripts/lib/_p2_left_body.txt", "w", encoding="utf-8", newline="\n").write(body)
print(f"已抽出左侧视图：{len(body.split(chr(10)))} 行 → scripts/lib/_p2_left_body.txt")
