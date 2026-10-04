#!/usr/bin/env python3
"""D17 P2：从 index.tsx 抽右侧点子详情（表单 / 点子王卡片 / 点子卡片）→ views/IdeasDetailPane.tsx。

三个分支在原文里是嵌套三元，缩进各不相同（表单 14 空格、点子王 16 空格起、点子 18 空格起）。
统一去缩进到函数体内的层级，其余一律逐字保留。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SRC = "src/client/index.tsx"
lines = open(SRC, "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").split("\n")


def grab(lo, hi, cut):
    """取 [lo, hi]（1-based 含端点），去掉前 cut 个空格缩进。"""
    out = []
    for l in lines[lo - 1:hi]:
        if l.strip() == "":
            out.append("")
            continue
        if l.startswith(" " * cut):
            out.append(l[cut:])
        else:
            raise SystemExit(f"ABORT L{lo} 起缩进不足 {cut}：{l!r}")
    return "\n".join(out)


def sub(text, old, new, tag):
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"ABORT [{tag}] 命中 {n} 次")
    return text.replace(old, new, 1)


# —— ① 点子编辑表单（原文 3381–3396，缩进 14）——
form = grab(3381, 3396, 14)

# —— ② 点子王（文件夹）详情卡（原文 3400–3436，缩进 16）——
cluster = grab(3400, 3436, 16)

# —— ③ 点子详情卡（原文 3440–3452，缩进 18）——
idea = grab(3440, 3452, 18)

# ============ ① 表单 ============
form = sub(form, """onSubmit={(e) => {
    e.preventDefault()
    if (ideaForm.title.trim() === '') return
    const tags = ideaForm.tags.split(/[,#，\\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 20)
    const isEdit = ideaEditId !== null
    void api(isEdit ? `/api/workbench/ideas/${ideaEditId}` : '/api/workbench/ideas', { method: isEdit ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: ideaForm.title.trim(), contentMd: ideaForm.contentMd, kindCode: ideaForm.kindCode, tags }) })
      .then(() => { setIdeaForm(null); setIdeaEditId(null); setIdeaRefreshKey((v) => v + 1); setNotice(isEdit ? '点子已更新' : '点子已保存') })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }}>""", """onSubmit={(e) => {
    e.preventDefault()
    const title = ideaDraft.title.trim()
    if (title === '') return
    const tags = ideaDraft.tags.split(/[,#，\\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 20)
    // 标题非空与标签切分留在视图里判定（与拆分前的写法逐字一致）；请求本体在 hook 里。
    model.actions.saveDraft({ title, contentMd: ideaDraft.contentMd, kindCode: ideaDraft.kindCode, tags })
  }}>""", "form-onSubmit")
form = form.replace("{ideaEditId === null ? '记个点子' : '编辑点子'}", "{model.editId === null ? '记个点子' : '编辑点子'}")
form = form.replace("value={ideaForm.", "value={ideaDraft.")
form = form.replace("setIdeaForm((prev) => prev === null ? prev : { ...prev, title: e.target.value })", "model.actions.patchDraft({ title: e.target.value })")
form = form.replace("setIdeaForm((prev) => prev === null ? prev : { ...prev, kindCode: e.target.value })", "model.actions.patchDraft({ kindCode: e.target.value })")
form = form.replace("setIdeaForm((prev) => prev === null ? prev : { ...prev, tags: e.target.value })", "model.actions.patchDraft({ tags: e.target.value })")
form = form.replace("setIdeaForm((prev) => prev === null ? prev : { ...prev, contentMd: e.target.value })", "model.actions.patchDraft({ contentMd: e.target.value })")
form = form.replace("onClick={() => { setIdeaForm(null); setIdeaEditId(null) }}", "onClick={() => model.actions.closeDraft()}")

# ============ ② 点子王 ============
cluster = sub(cluster, "onClick={() => setFolderForm({ mode: 'rename', id: selectedCluster.id, title: selectedCluster.title, summaryMd: selectedCluster.summaryMd })}",
              "onClick={() => model.setFolderForm({ mode: 'rename', id: selectedCluster.id, title: selectedCluster.title, summaryMd: selectedCluster.summaryMd })}", "cluster-rename")
cluster = sub(cluster, "onChange={(e) => { const target = e.target.value; if (target !== '') void mergeFolderInto(selectedCluster.id, target) }}",
              "onChange={(e) => { const target = e.target.value; if (target !== '') model.actions.mergeFolderInto(selectedCluster.id, target) }}", "cluster-merge")
cluster = sub(cluster, "onClick={() => void deleteFolder(selectedCluster.id)}", "onClick={() => model.actions.deleteFolder(selectedCluster.id)}", "cluster-delete")
cluster = sub(cluster, "onClick={() => { setSelectedCluster(null); setSelectedIdea(idea) }} style={{ cursor: 'pointer' }}",
              "onClick={() => model.actions.openIdea(idea.id)} style={{ cursor: 'pointer' }}", "cluster-member-open")
cluster = sub(cluster, "onClick={() => void unfileIdeaFrom(idea.id, selectedCluster.id)}", "onClick={() => model.actions.unfileIdeaFrom(idea.id, selectedCluster.id)}", "cluster-unfile")

# ============ ③ 点子 ============
idea = sub(idea, "onClick={() => { setIdeaEditId(selectedIdea.id); setIdeaForm({ title: selectedIdea.title, contentMd: selectedIdea.contentMd, kindCode: selectedIdea.kindCode, tags: selectedIdea.tags.join(', ') }) }}",
           "onClick={() => model.actions.startEdit(selectedIdea)}", "idea-edit")
idea = sub(idea, "onClick={() => { if (window.confirm('删除这个点子？')) { void api(`/api/workbench/ideas/${selectedIdea.id}`, { method: 'DELETE' }).then(() => { setSelectedIdea(null); setIdeaRefreshKey((v) => v + 1); setNotice('已删除') }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))) } }}",
           "onClick={() => { if (window.confirm('删除这个点子？')) model.actions.deleteIdea(selectedIdea.id) }}", "idea-delete")

for name, text in (("form", form), ("cluster", cluster), ("idea", idea)):
    for token in ("setIdeaForm", "setIdeaEditId", "setSelectedIdea", "setSelectedCluster",
                  "setIdeaRefreshKey", "setNotice(", "setError(", "ideaForm", "ideaEditId",
                  "void mergeFolderInto", "void deleteFolder", "void unfileIdeaFrom", "void fileIdeaInto",
                  "void saveFolder"):
        if token in text:
            i = text.index(token)
            raise SystemExit(f"ABORT [{name}] 仍有未替换标识符：{token}\n  ctx={text[max(0,i-160):i+160]!r}")

FINAL = """/**
 * D17 / P2：点子页右侧详情区 —— 点子编辑表单 / 点子王（文件夹）详情 / 点子详情 / 空态。
 *
 * 三种形态的判定与数据全部来自 `hooks/useIdeas.ts`；本文件不持有状态、不发请求。
 * `startAISession` 与 `busy` 属 AI 会话域，按设计 §5 由入口转发进来（这里只调用）。
 * 删除点子那句 `window.confirm('删除这个点子？')` 的文案与位置逐字保留（行为修复不混进重构）。
 */
import { Badge } from '../components/TaskList.js'
import { MarkdownText } from '../components/MarkdownText.js'
import { Icon } from '../components/Icon.js'
import type { KnowledgeDictFn, StartAISessionFn } from '../hooks/useKnowledge.js'
import type { UseIdeasResult } from '../hooks/useIdeas.js'

export type IdeasDetailPaneProps = {
  model: UseIdeasResult
  dictOf: KnowledgeDictFn
  busy: boolean
  startAISession: StartAISessionFn
}

export function IdeasDetailPane({ model, dictOf, busy, startAISession }: IdeasDetailPaneProps): JSX.Element {
  const { selectedIdea, selectedCluster, draft: ideaDraft } = model

  if (ideaDraft !== null) {
    return (
%s
    )
  }

  if (selectedCluster !== null) {
    return (
%s
    )
  }

  if (selectedIdea !== null) {
    return (
%s
    )
  }

  return <div className="wb-empty">← 从左侧选择一个点子/点子王，或点“记个点子”</div>
}
""" % (form, cluster, idea)

open("src/client/views/IdeasDetailPane.tsx", "w", encoding="utf-8", newline="\n").write(FINAL)
print(f"WROTE src/client/views/IdeasDetailPane.tsx  {len(FINAL.split(chr(10)))} 行")
