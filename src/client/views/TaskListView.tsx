/**
 * D17 / P3-1：任务页左侧列表视图（搜索 / 状态与优先级下拉 / 类型页签 / 排序与清空 / 归档切换 / 任务树 / 三种空态）。
 *
 * 本文件**不持有状态**：`model` 是 `hooks/useTaskListModel.ts` 的返回值，
 * 其余 props 都是入口已算好的只读快照或跨域回调（设计 §5：展示组件不拿跨域 setter、不自行调 HTTP）。
 */
import { ALL, TabBar } from '../components/TabBar.js'
import { MultiSelectDropdown, TaskTreeRows, countTaskTree, type PendingMap } from '../components/TaskList.js'
import { Icon } from '../components/Icon.js'
import { isTaskFilterEmpty, type TaskSortKey } from '../taskFilterSort.js'
import type { UseTaskListModelResult } from '../hooks/useTaskListModel.js'
import type { Dict, Task } from '../viewTypes.js'

export type TaskListViewProps = {
  model: UseTaskListModelResult
  dictOf: (kind: string) => Dict[]
  dicts: Dict[]
  selectedId?: string
  pending?: PendingMap
  childrenOf?: (taskId: string) => readonly Task[] | undefined
  onOpen: (task: Task) => void
}

export function TaskListView({ model, dictOf, dicts, selectedId, pending, childrenOf, onOpen }: TaskListViewProps): JSX.Element {
  return (
    <>
              <div style={{ position: 'relative', zIndex: 25, display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  style={{ position: 'relative', zIndex: 25, flex: 1, minWidth: 140, background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }}
                  placeholder="搜索标题 / 描述"
                  value={model.filter.keyword}
                  onChange={(e) => model.actions.patchFilter({ keyword: e.target.value })}
                />
                <MultiSelectDropdown
                  label="状态"
                  options={dictOf('status')}
                  selected={model.filter.statusCodes}
                  open={model.openFilter === 'status'}
                  onToggle={() => model.actions.toggleOpenFilter('status')}
                  onClose={() => model.actions.setOpenFilter(null)}
                  onChange={(codes) => model.actions.patchFilter({ statusCodes: codes })}
                />
                <MultiSelectDropdown
                  label="优先级"
                  options={dictOf('priority')}
                  selected={model.filter.priorityCodes}
                  open={model.openFilter === 'priority'}
                  onToggle={() => model.actions.toggleOpenFilter('priority')}
                  onClose={() => model.actions.setOpenFilter(null)}
                  onChange={(codes) => model.actions.patchFilter({ priorityCodes: codes })}
                />
              </div>
              {/* 类型从「多选下拉」升为 Tab（与知识库一致）；点=单选，Ctrl/Cmd+点=多选。
                  状态与优先级仍保留下拉（同维度多选在那里更合适）。 */}
              <TabBar
                tabs={model.typeTabs}
                selected={model.filter.typeCodes.length === 0 ? [ALL] : model.filter.typeCodes}
                onSelect={(code, multi) => model.actions.selectType(code, multi)}
                ariaLabel="任务类型"
              />
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>排序</span>
                <select
                  style={{ background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }}
                  value={model.sortKey}
                  onChange={(e) => model.actions.setSortKey(e.target.value as TaskSortKey)}
                >
                  <option value="dueAt">截止时间</option>
                  <option value="priority">优先级</option>
                  <option value="createdAt">创建时间</option>
                  <option value="title">标题</option>
                </select>
                <button className="wb-btn" onClick={() => model.actions.toggleSortDir()} title={model.sortDir === 'asc' ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序'}>
                  {model.sortDir === 'asc' ? '↑ 升序' : '↓ 降序'}
                </button>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>共 {countTaskTree(model.visibleTree)} 条</span>
                <div style={{ flex: 1 }} />
                <button className="wb-btn" disabled={isTaskFilterEmpty(model.filter)} onClick={() => model.actions.clearFilter()}><Icon name="refresh" />清空</button>
                <button className="wb-btn" onClick={() => model.actions.toggleArchived()}>{model.archivedMode ? '返回任务' : '查看归档'}</button>
              </div>
              <div className="wb-list">
                <TaskTreeRows roots={model.visibleTree} depth={0} expanded={model.expanded} toggle={model.actions.toggleExpanded} dicts={dicts} onOpen={onOpen} selectedId={selectedId} pending={pending} childrenOf={childrenOf} />
                {model.archivedMode && model.sourceEmpty && <div className="wb-empty">没有归档任务</div>}
                {!model.archivedMode && model.sourceEmpty && <div className="wb-empty">还没有任务，点“快速录入”或“新建”开始</div>}
                {!isTaskFilterEmpty(model.filter) && model.visibleTree.length === 0 && <div className="wb-empty">没有符合条件的任务，点“清空”恢复完整列表</div>}
              </div>
    </>
  )
}
