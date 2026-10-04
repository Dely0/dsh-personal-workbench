/**
 * 知识库**左侧视图**（D17 / P1）—— 从入口的 `view === 'knowledge'` 分支原样搬出。
 *
 * 只做装配：工具栏 / 列表 / 分页 三块；判定、分页、筛选全在
 * `listPresentation.ts` 与 `hooks/useKnowledge.ts` 的派生里，本文件不写判定。
 *
 * 拆分前它内联在 `index.tsx` 的 `wb-nav` 里（第 3385–3427 行，43 行）；
 * 现在由 `KnowledgeListView` 承担，`index.tsx` 只留 `{view === 'knowledge' && <KnowledgeListView … />}`。
 */
import { Icon } from '../components/Icon.js'
import {
  KnowledgeList, KnowledgePager, KnowledgeToolbar, kindTabs,
} from '../components/KnowledgeList.js'
import { LocalDocModal } from '../components/LocalDocModal.js'
import type { KnowledgeDictFn, UseKnowledgeResult } from '../hooks/useKnowledge.js'

export interface KnowledgeListViewProps {
  /** 知识域模型（`useKnowledge` 的唯一返回值）。 */
  model: UseKnowledgeResult
  /** 按 kind 取字典（工具栏的 Tab 文案用）。 */
  dictOf: KnowledgeDictFn
  /** 共享忙碌标志（AI 会话域）。 */
  busy: boolean
}

export function KnowledgeListView({ model, dictOf, busy }: KnowledgeListViewProps): JSX.Element {
  const { entries, filters, page, selected, filePicker, dicts } = model
  return (
    <>
      {/* 本地文档三件套已收进弹窗（LocalDocModal）；工具栏只留一个按钮，和「新建」「清空筛选」同一行右对齐 */}
      <KnowledgeToolbar
        filters={filters}
        tabs={kindTabs(dicts, page.tabCounts)}
        tagCounts={page.tagCounts}
        total={page.total}
        onChange={model.updateFilters}
        onClear={() => model.updateFilters({ keyword: '', kinds: ['all'], tags: [], page: 0 })}
        onCreate={() => model.startCreate()}
        onSummarizeDoc={filePicker.openPicker}
        busy={busy}
      />
      {entries.length === 0 ? (
        <div className="wb-empty" style={{ padding: '28px 18px' }}>
          <div style={{ marginBottom: 6, color: 'var(--dsw-alias-state-business-primary, #4f8ef7)' }}><Icon name="book" size={30} /></div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>还没有知识条目</div>
          <div style={{ fontSize: 12, opacity: .8, marginBottom: 12 }}>沉淀经验教训、决策和可复用片段；也可以在 AI 复盘后一键写入</div>
          <button className="wb-btn primary" onClick={() => model.startCreate()}>新建知识</button>
        </div>
      ) : (
        <>
          <KnowledgeList
            page={page}
            dicts={dicts}
            selectedId={selected?.id}
            // 拆前是 `entries.find(e => e.id === item.id)` 再 setSelectedKnowledge —— 同一个结果。
            onOpen={(item) => model.openEntryById(item.id)}
          />
          <KnowledgePager
            page={page}
            pageSize={filters.pageSize}
            onPage={(next) => model.updateFilters({ page: next })}
            onPageSize={(pageSize) => model.updateFilters({ pageSize, page: 0 })}
          />
        </>
      )}

      {/**
        * 本地文档弹窗（file 模式）。
        *
        * 拆分前它内联在入口的 `<div className="wb-h">` 里（第 3033 行），**不在**这个视图分支内 ——
        * 但它的全部状态与动作都属于知识域，跟着域走才不会再出现"两处装配"；
        * `LocalDocModal` 自己 `createPortal(..., document.body)`，渲染位置不影响 DOM 层级。
        */}
      <LocalDocModal
        open={filePicker.open}
        path={filePicker.path}
        listing={filePicker.listing}
        loading={filePicker.loading}
        error={filePicker.error}
        busy={busy}
        onPathChange={filePicker.setPath}
        onClose={filePicker.close}
        onNavigate={(target) => void filePicker.loadDir(target)}
        onPick={filePicker.pickFile}
        onPickAndSummarize={filePicker.pickAndSummarize}
        onSummarize={() => void filePicker.summarize()}
      />
    </>
  )
}
