/**
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
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <div className="wb-segmented wb-sub-segmented">
                <button className={`wb-seg ${model.tab === 'ideas' ? 'on' : ''}`} onClick={() => model.setTab('ideas')}>全部（{model.ideas.length}）</button>
                <button className={`wb-seg ${model.tab === 'unfiled' ? 'on' : ''}`} onClick={() => model.setTab('unfiled')}>未归类（{model.unfiledIdeas.length}）</button>
                <button className={`wb-seg ${model.tab === 'clusters' ? 'on' : ''}`} onClick={() => model.setTab('clusters')}>文件夹（{model.clusters.length}）</button>
              </div>
              <input style={{ flex: 1, minWidth: 120, background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--wb-line, rgba(127,127,127,.26))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }} placeholder="搜索点子或文件夹" value={model.query} onChange={(e) => model.setQuery(e.target.value)} />
              {model.ideas.length >= 2 && <button className="wb-btn primary" disabled={busy} onClick={() => { const ids = model.pickedIds.size >= 2 ? [...model.pickedIds] : model.ideas.map((idea) => idea.id); void startAISession('idea_association', null, ids.sort().join(',')) }}><Icon name="sparkles" />{model.pickedIds.size >= 2 ? `AI 关联（已选 ${model.pickedIds.size}）` : 'AI 自动关联'}</button>}
              <button className="wb-btn" onClick={() => model.setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}><Icon name="folder" />新建文件夹</button>
              <button className="wb-btn" onClick={() => { model.actions.startCreate() }}><Icon name="plus" />记个点子</button>
            </div>
            {model.tab === 'ideas' || model.tab === 'clusters' ? (
              <>
                {model.clusters.length > 0 && (
                  <>
                    <div className="wb-idea-crumb">
                      <b>文件夹</b> · {model.clusters.length} 个
                      <span style={{ flex: 1 }} />
                      <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }}>点开看成员；hover 可改名 / 删除</span>
                    </div>
                    <div className="wb-folder-grid">
                      {model.clusters.map((cluster) => (
                        <div key={cluster.id} className={`wb-folder ${model.selectedCluster?.id === cluster.id ? 'selected' : ''}`} onClick={() => model.actions.openCluster(cluster)}>
                          <div className="wb-folder-acts" onClick={(e) => e.stopPropagation()}>
                            <button className="wb-icon-btn" title="重命名" onClick={() => model.setFolderForm({ mode: 'rename', id: cluster.id, title: cluster.title, summaryMd: cluster.summaryMd })}><Icon name="edit" size={13} /></button>
                            <button className="wb-icon-btn" title="删除文件夹（点子保留）" onClick={() => model.actions.deleteFolder(cluster.id)}><Icon name="trash" size={13} /></button>
                          </div>
                          <div className="wb-folder-head">
                            <span className="wb-folder-ic"><Icon name="folder" size={13} /></span>
                            <h4>{cluster.title}</h4>
                            <span className="wb-folder-cnt">{cluster.ideas.length}</span>
                          </div>
                          <div className="wb-folder-mini">
                            {cluster.ideas.slice(0, 2).map((idea) => <span key={idea.id}>{idea.title}</span>)}
                            {cluster.ideas.length > 2 && <span className="more">还有 {cluster.ideas.length - 2} 个…</span>}
                            {cluster.ideas.length === 0 && <span className="more">空文件夹 · 可从下方点子归入</span>}
                          </div>
                        </div>
                      ))}
                      <div className="wb-folder new" onClick={() => model.setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}>+ 新建空文件夹<br /><span style={{ fontSize: 11.5 }}>也可以让 AI 自动关联</span></div>
                    </div>
                  </>
                )}
                <div className="wb-idea-crumb">
                  <b>未归类</b> · {model.unfiledIdeas.length} 个
                  <span style={{ flex: 1 }} />
                  {model.pickedIds.size > 0 && <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }}>已选 {model.pickedIds.size} 个</span>}
                </div>
              </>
            ) : (
              <div className="wb-idea-crumb"><b>未归类</b> · {model.unfiledIdeas.length} 个<span style={{ flex: 1 }} /></div>
            )}
            {model.tab !== 'clusters' && (
              <>
                {model.unfiledIdeas.length === 0 ? (
                  <div className="wb-empty" style={{ padding: '26px 18px' }}>
                    <div className="wb-empty-ic"><Icon name="idea" size={17} /></div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{model.ideas.length === 0 ? '还没有点子' : '所有点子都已归类'}</div>
                    <div style={{ fontSize: 12, opacity: .8, marginBottom: 12 }}>{model.ideas.length === 0 ? '把一闪而过的灵感先记下来，之后可以 AI 找关联、头脑风暴' : '新记的点子会先出现在这里'}</div>
                    <button className="wb-btn primary" onClick={() => { model.actions.startCreate() }}>记个点子</button>
                  </div>
                ) : (
                  <IdeaCardGrid
                    ideas={model.cardItems}
                    dicts={dictOf('idea_kind')}
                    selectedId={model.selectedIdea?.id}
                    pickedIds={model.pickedIds}
                    clusters={model.clusters.map((c) => ({ id: c.id, title: c.title }))}
                    onOpen={(item) => model.actions.openIdeaById(item.id)}
                    onTogglePick={(id) => model.togglePick(id)}
                    onFileInto={(ideaId, clusterId) => model.actions.fileIdeaInto(ideaId, clusterId)}
                    onCreateFolder={() => model.setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}
                  />
                )}
              </>
            )}
            {model.tab === 'clusters' && model.clusters.length === 0 && (
              <div className="wb-empty" style={{ padding: '26px 18px' }}>
                <div className="wb-empty-ic"><Icon name="folder" size={17} /></div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>还没有文件夹</div>
                <div style={{ fontSize: 12, opacity: .8, marginBottom: 12 }}>先手动建一个，或者选中 2 个以上点子点「AI 关联」自动生成</div>
                <button className="wb-btn primary" onClick={() => model.setFolderForm({ mode: 'create', id: null, title: '', summaryMd: '' })}>新建文件夹</button>
              </div>
            )}
    </>
  )
}
