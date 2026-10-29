/**
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
import { useI18n } from '../i18n.js'

export type IdeasDetailPaneProps = {
  model: UseIdeasResult
  dictOf: KnowledgeDictFn
  busy: boolean
  startAISession: StartAISessionFn
}

export function IdeasDetailPane({ model, dictOf, busy, startAISession }: IdeasDetailPaneProps): JSX.Element {
  const { t } = useI18n()
  const { selectedIdea, selectedCluster, draft: ideaDraft } = model

  if (ideaDraft !== null) {
    return (
  <form className="wb-form" onSubmit={(e) => {
    e.preventDefault()
    const title = ideaDraft.title.trim()
    if (title === '') return
    const tags = ideaDraft.tags.split(/[,#，\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 20)
    // 标题非空与标签切分留在视图里判定（与拆分前的写法逐字一致）；请求本体在 hook 里。
    model.actions.saveDraft({ title, contentMd: ideaDraft.contentMd, kindCode: ideaDraft.kindCode, tags })
  }}>
    <h4 className="full" style={{ margin: 0 }}>{model.editId === null ? t('记个点子') : t('编辑点子')}</h4>
    <label className="full">{t('标题')}<input value={ideaDraft.title} onChange={(e) => model.actions.patchDraft({ title: e.target.value })} placeholder={t('一句话说清这个点子')} /></label>
    <label>{t('类型')}<select value={ideaDraft.kindCode} onChange={(e) => model.actions.patchDraft({ kindCode: e.target.value })}>{dictOf('idea_kind').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
    <label>{t('标签')}<input value={ideaDraft.tags} onChange={(e) => model.actions.patchDraft({ tags: e.target.value })} placeholder={t('逗号/空格分隔，如 AI, 语音')} /></label>
    <label className="full">{t('内容（可选，Markdown）')}<textarea rows={10} value={ideaDraft.contentMd} onChange={(e) => model.actions.patchDraft({ contentMd: e.target.value })} /></label>
    <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit"><Icon name="check" />{t('保存')}</button><button className="wb-btn" type="button" onClick={() => model.actions.closeDraft()}>{t('取消')}</button></div>
  </form>
    )
  }

  if (selectedCluster !== null) {
    return (
  <div className="wb-card">
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <h4 style={{ flex: 1, margin: 0, minWidth: 120 }}><Icon name="folder" />{selectedCluster.title}</h4>
      <button className="wb-btn" onClick={() => model.setFolderForm({ mode: 'rename', id: selectedCluster.id, title: selectedCluster.title, summaryMd: selectedCluster.summaryMd })}><Icon name="edit" />{t('重命名')}</button>
      {model.clusters.length > 1 && (
        <select
          className="wb-plan-add"
          value=""
          title={t('合并到…（把本文件夹的成员挂到目标文件夹，然后删除本文件夹）')}
          onChange={(e) => { const target = e.target.value; if (target !== '') model.actions.mergeFolderInto(selectedCluster.id, target) }}
        >
          <option value="">{t('合并到…')}</option>
          {model.clusters.filter((cluster) => cluster.id !== selectedCluster.id).map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.title}</option>)}
        </select>
      )}
      <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `cluster:${selectedCluster.id}`)}>{t('AI 头脑风暴')}</button>
      <button className="wb-btn" onClick={() => model.actions.deleteFolder(selectedCluster.id)}><Icon name="trash" />{t('删除')}</button>
    </div>
    <MarkdownText text={selectedCluster.summaryMd || t('（暂无总结，可在重命名里补充）')} />
    <div style={{ marginTop: 10 }}>
      <b>{t('包含点子（{n}）', { n: selectedCluster.ideas.length })}</b>
      {selectedCluster.ideas.map((idea) => (
        <div key={idea.id} className="wb-member">
          <span className="t" onClick={() => model.actions.openIdea(idea)} style={{ cursor: 'pointer' }}>{idea.title}</span>
          <Badge dict={dictOf('idea_kind')} code={idea.kindCode} />
          <button className="wb-icon-btn" title={t('移出文件夹')} onClick={() => model.actions.unfileIdeaFrom(idea.id, selectedCluster.id)}><Icon name="back" size={12} /></button>
        </div>
      ))}
      {selectedCluster.ideas.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '8px 2px' }}>{t('空文件夹。可以从下方「未归类」的点子上点「归入文件夹」。')}</div>
      )}
    </div>
    <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
      <button className="wb-btn" disabled={busy} onClick={() => void startAISession('idea_association', null, selectedCluster.ideas.map((idea) => idea.id).sort().join(','))}>{t('AI 继续补充关联')}</button>
      <button className="wb-btn" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `cluster:${selectedCluster.id}`)}>{t('整体转成任务树')}</button>
    </div>
  </div>
    )
  }

  if (selectedIdea !== null) {
    return (
  <div className="wb-card">
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <h4 style={{ flex: 1, margin: 0 }}>{selectedIdea.title}</h4>
      <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `idea:${selectedIdea.id}`)}>{t('AI 头脑风暴')}</button>
      <button className="wb-btn" onClick={() => model.actions.startEdit(selectedIdea)}><Icon name="edit" />{t('编辑')}</button>
      <button className="wb-btn" onClick={() => { if (window.confirm(t('删除这个点子？'))) model.actions.deleteIdea(selectedIdea.id) }}><Icon name="trash" />{t('删除')}</button>
    </div>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
      <Badge dict={dictOf('idea_kind')} code={selectedIdea.kindCode} />
      {selectedIdea.tags.map((tag) => <span key={tag} style={{ fontSize: 12, color: '#999' }}>#{tag}</span>)}
    </div>
    <MarkdownText text={selectedIdea.contentMd || t('（暂无内容）')} />
  </div>
    )
  }

  return <div className="wb-empty">{t('← 从左侧选择一个点子/点子王，或点“记个点子”')}</div>
}
