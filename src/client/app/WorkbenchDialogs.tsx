/**
 * D17 / P7-2：`WorkbenchApp` 的**弹窗** JSX（搬迁前 index.tsx 的第 1183–1493 行）。
 *
 * 逐字搬出 —— 内层行的缩进一个字没改，只把外层标签挪进本文件的 `return`，
 * 所以拼装出来的 DOM 与拆分前逐层一致（弹窗刻意留在原来的位置上，不改层叠顺序）。
 *
 * 依赖以 `WorkbenchAssembly` 整体注入，这里只**解构自己真正用到的那几个** ——
 * 解构名与入口里的局部名逐个一致（不把 `selected` 改写成 `data.selected`，
 * 既有判据锚的就是这些原文）。
 */
import type { WorkbenchAssembly } from './assembly.js'
import { Icon } from '../components/Icon.js'
import { LocalDocModal } from '../components/LocalDocModal.js'
import { Modal } from '../components/Modal.js'
import { ModelPicker } from '../components/ModelPicker.js'
import { PersonaPicker } from '../components/PersonaPicker.js'
import { SkillPicker } from '../components/SkillPicker.js'
import { WorkspacePicker } from '../components/WorkspacePicker.js'
import { draftKindLabel, fmtTime } from '../format.js'
import { MAX_QUICK_DOCUMENTS, MAX_QUICK_IMAGES, isQuickImageDraft } from '../quickAttachments.js'
import { quickWorkspaceSourceLabel, shouldRememberQuickWorkspace } from '../quickWorkspaceDefault.js'
import { TaskCreateModal, TaskEditModal } from '../views/TaskFormModal.js'

export function WorkbenchDialogs(props: WorkbenchAssembly): JSX.Element {
  const { modelModalityTable, quickModelSelection, quickPersona, selectedSkills, skillCatalog, skillProblem, skillsAvailable, skillsLoading } = props.ai
  const { loadSkills, setModelModalityTable, setQuickModelSelection, setQuickPersona, startAISession, toggleSkill } = props.ai.actions
  const { busy } = props.busyApi
  const { dictOf, selected } = props.data
  const { createTask } = props.data.actions
  const { cursor } = props.day
  const { dirPickerError, dirPickerListing, dirPickerLoading, dirPickerPath, dirPickerTarget } = props.dir
  const { loadDirPickerDir, setDirPickerPath, setDirPickerTarget } = props.dir.actions
  const { allPendingDrafts, deferredDrafts, pendingDraft, pendingOpen } = props.draftsApi
  const { resumeDeferredDraft, resumePendingDraft, setPendingOpen } = props.draftsApi.actions
  const { pushToast, setError } = props.feedback.actions
  const { editDraft, formWorkspace } = props.forms
  const { settings } = props.prefs
  const { quickAttachmentNotice, quickAttachments, quickFollowFolder, quickImageInputRef, quickText, quickWorkspace, quickWorkspaceSource, quickWorkspaceTouched, showQuick } = props.quick
  const { addQuickAttachments, cancelIntake, closeIntake, forgetQuickWorkspace, overrideWorkspace, rememberQuickWorkspace, removeQuickAttachment, setQuickFollowFolder, setQuickText } = props.quick.actions
  const { reminders } = props.remindersApi
  const { ackReminder } = props.remindersApi.actions
  const { applyWorkspaceDir, forms, loadModelModalityTable, openDirPicker, pendingCount, reparentCandidates, runtime, saveEditDraft, workspaceChoices } = props
  return (
    <>
      {showQuick && (
        <Modal
          title={<><Icon name="sparkles" />快速录入</>}
          size="md"
          onClose={closeIntake}
          footer={(
            <>
              <span className="wb-foot-note">会跳转到官方会话区，由 AI 澄清后生成任务草稿</span>
              <button className="wb-btn" onClick={cancelIntake}>取消</button>
              <button
                className="wb-btn primary"
                disabled={busy || (quickText.trim() === '' && quickAttachments.length === 0)}
                onClick={() => {
                  /**
                   * 工作区选择随会话一起带下去。
                   *
                   * ⚠️ v1.15.1 起**不再在这里拼文件夹名**：资料夹名是
                   * `<任务ID>-<标题片段>`，而任务 ID 由 `startAISession` 在澄清前预留
                   * （这里拿不到）。所以只传"用户选的目录"与"要不要在里面建任务资料夹"。
                   *
                   * ⚠️ v1.15.2：「最近手动选择」的清单只管**用户真的动过这个输入框**的选择
                   * （`shouldRememberQuickWorkspace`）。自动预填进来的值一旦被记进去，
                   * 下一次它就变成"上次手动选择"—— 默认值自己污染自己。
                   */
                  const chosen = quickWorkspace.trim()
                  if (shouldRememberQuickWorkspace(quickWorkspaceTouched, chosen)) void rememberQuickWorkspace(chosen)
                  void startAISession('clarify', null, quickText, [], undefined, chosen, {
                    attachments: quickAttachments,
                    followFolder: quickFollowFolder,
                    /** 角色选择随会话一起带下去（澄清 mode 的角色入口就在这里）。 */
                    persona: quickPersona,
                  })
                }}
              >
                创建澄清会话
              </button>
            </>
          )}
        >
          <label className="wb-field">
            <span>一句话描述任务</span>
            <textarea
              autoFocus
              rows={3}
              value={quickText}
              onChange={(e) => setQuickText(e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files)
                if (files.length > 0) {
                  e.preventDefault()
                  addQuickAttachments(files)
                }
              }}
              placeholder="一句话描述任务，例如：周五 10:30 接待重要客户；也可以粘贴或拖入图片、PDF、DOCX"
            />
          </label>

          {/* ---------------- 附件（v1.15.1） ----------------
              拖入/粘贴/选择三种入口都走 addQuickAttachments；
              不收的文件会在下面用 `wb-quick-attach-note` 给出**逐条中文原因**（不静默丢弃）。 */}
          <div
            className="wb-field"
            onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault() }}
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer.files)
              if (files.length === 0) return
              e.preventDefault()
              addQuickAttachments(files)
            }}
          >
            <span>
              附件
              <span className="wb-field-note">
                图片最多 {MAX_QUICK_IMAGES} 张 · PDF/DOCX 最多 {MAX_QUICK_DOCUMENTS} 份 · 单份 ≤ 5MB
              </span>
            </span>
            {quickAttachments.length > 0 && (
              <div className="wb-quick-attach-rail" aria-label="快速录入附件">
                {quickAttachments.map((item) => (
                  <div className="wb-quick-attach-item" key={item.id} title={isQuickImageDraft(item) ? (item.file.name || '图片') : item.name}>
                    {isQuickImageDraft(item)
                      ? <img src={item.previewUrl} alt={item.file.name || '图片'} />
                      : <Icon name="file" size={18} />}
                    <span className="wb-quick-attach-name">
                      {isQuickImageDraft(item) ? (item.file.name || '图片') : `${item.name}${item.truncated ? '（已截断）' : ''}`}
                    </span>
                    <button type="button" className="wb-quick-attach-remove" onClick={() => removeQuickAttachment(item.id)} aria-label="移除附件">×</button>
                  </div>
                ))}
              </div>
            )}
            {quickAttachmentNotice !== null && <div className="wb-quick-attach-note">{quickAttachmentNotice}</div>}
            <div className="wb-quick-actions">
              <input
                ref={quickImageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.docx"
                multiple
                hidden
                onChange={(e) => {
                  if (e.currentTarget.files !== null) addQuickAttachments(Array.from(e.currentTarget.files))
                  e.currentTarget.value = ''
                }}
              />
              <button type="button" className="wb-btn" disabled={busy} onClick={() => quickImageInputRef.current?.click()}>
                <Icon name="image" />添加附件
              </button>
              <ModelPicker
                runtime={runtime}
                value={quickModelSelection}
                onChange={setQuickModelSelection}
                modalityTable={modelModalityTable}
                disabled={busy}
                onError={setError}
                onLoaded={() => { void loadModelModalityTable().then(setModelModalityTable) }}
              />
            </div>
          </div>

          {/* ---------------- 工作区选择（v1.14.0；2026-10-01 上移到技能/角色之前） ----------------
              说明文字一律用 <div className="wb-hint"> 而不是 <p>/<label>：
              `.wb-hint` 自带 margin，而 `.wb-field` 的标签是 display:block、
              里面的 <input> 是行内元素 —— 把提示塞进 <label> 会被输入框的基线顶开重叠
              （2026-09-12 用户实测："提示文字被上方输入框遮挡"）。

              用户要求（2026-10-01 第二张截图）：把这一组**移到技能/角色选择之上**，
              并压缩高度。原来的顺序是「技能 → 角色 → 工作区」，
              现在改成「工作区 → 技能 → 角色」。
              注意：三项都只是**本次会话的输入**，彼此没有依赖关系，
              所以移动顺序不改变任何判定（判定仍全在纯模块里）。 */}
          {/**
            * 「AI 会话工作区」——批次2 #2：三个入口共用 `WorkspacePicker`。
            *
            * 两种选法（用户原始诉求）：**已有工作区下拉** + **「浏览…」文件夹弹框**；
            * 手打路径照旧。候选集只剩一处实现（`workspaceCandidates`），
            * 原先现场拼的那行 `new Set([...recent, ...openWorkspacePaths, default])` 已删 ——
            * 它的去重口径与全项目的 `recentWorkspaceKey` 不一致。
            *
            * 「不再记住」保留原条件（只有默认值来自"上次手动选择"且用户没动过时才显示）：
            * 它是**唯一**的"清掉上次手动选择"出口，删了会让"设置里的默认工作区"永远不生效
            * （v1.15.2 修过的缺陷）。
            */}
          <WorkspacePicker
            value={quickWorkspace}
            touched={quickWorkspaceTouched}
            sourceLabel={quickWorkspaceSourceLabel(quickWorkspaceSource)}
            candidates={workspaceChoices}
            disabled={busy}
            placeholder={settings.defaultWorkspace || '例如 D:\\Code\\my-repo 或 /mnt/d/code/my-project'}
            onChange={overrideWorkspace}
            onBrowse={() => openDirPicker('quick')}
            showForget={quickWorkspaceSource === 'last-manual' && !quickWorkspaceTouched}
            onForget={() => void forgetQuickWorkspace(quickWorkspace)}
          />
          {quickWorkspace.trim() !== '' && (
            <label className="wb-inline-check">
              <input
                type="checkbox"
                checked={quickFollowFolder}
                onChange={(e) => setQuickFollowFolder(e.target.checked)}
              />
              <span>在该工作区下建任务资料夹（`&lt;任务ID&gt;-&lt;标题片段&gt;`；不勾 = 直接用它本身）</span>
            </label>
          )}
          {/**
            * ⚠️ 这里原本还有两行长提示（"默认值取「上次手动选择的目录」…路径不存在时会明确报错" /
            * "AI 会先澄清必要信息（一次一个主题，最多 5 轮）…"）。用户要求删除：它们各占一行，
            * 而两条语义都已有去处 ——
            *   · 默认值来源：就在上面的字段名后面（`wb-field-note` 的"上次手动选择 / 系统默认"，由判定给出）；
            *   · 路径报错：真出错时以红色错误行就地显示（不静默换目录，这一点没变）；
            *   · 澄清轮数：弹窗按钮文案与澄清流程本身已经说明，不必事前占高度。
            */}

          {/* ---------------- 技能选择（2026-10-01 补上） ----------------
              用户反馈："快速录入弹框页面无法选择 SKill。"
              与共享提示词弹窗**同一个组件、同一份 selectedSkills**，所以这里选的技能
              会真的进提示词（`startAISession` 的 clarify 分支读的就是 selectedSkills）。 */}
          <SkillPicker
            catalog={skillCatalog}
            loading={skillsLoading}
            available={skillsAvailable}
            problem={skillProblem}
            selected={selectedSkills}
            onToggle={toggleSkill}
            onRetry={() => void loadSkills()}
            disabled={busy}
          />

          {/* ---------------- 角色选择（D13-B） ----------------
              与共享提示词弹窗**同一个组件、同一套选择逻辑**（需求 §6.3）。
              这样 10 个 mode 都有角色入口：9 个走提示词弹窗，澄清走这里（快速录入）。 */}
          <PersonaPicker
            value={quickPersona}
            onChange={setQuickPersona}
            disabled={busy}
            onError={setError}
            onNotice={(message) => pushToast(message, 'success')}
          />

          {/* ---------------- 工作区选择已上移到技能选择之前（2026-10-01） ----------------
              用户要求把「AI 会话工作区」这一组挪到技能/角色上面，所以这里不再重复渲染。
              整组（字段 + 不再记住 + 任务资料夹勾选）只有一处实现，避免两处装配打架。*/}
        </Modal>
      )}

      <TaskCreateModal
        open={forms.showForm}
        onClose={forms.actions.closeCreate}
        onSubmit={createTask}
        dictOf={dictOf}
        defaultEstimateMinutes={settings.defaultEstimateMinutes}
        defaultWorkspace={settings.defaultWorkspace}
        workspaceChoices={workspaceChoices}
        formWorkspace={formWorkspace}
        onFormWorkspaceChange={forms.actions.setFormWorkspace}
        onBrowseWorkspace={() => openDirPicker('form')}
        busy={busy}
      />

      {editDraft !== null && selected !== null && (
        <TaskEditModal
          draft={editDraft}
          recurrenceMasterId={selected.task.recurrenceMasterId}
          onClose={forms.actions.closeEdit}
          onSave={() => void saveEditDraft()}
          onPatchDraft={forms.actions.patchDraft}
          dictOf={dictOf}
          defaultEstimateMinutes={settings.defaultEstimateMinutes}
          defaultWorkspace={settings.defaultWorkspace}
          workspaceChoices={workspaceChoices}
          onBrowseWorkspace={() => openDirPicker('edit')}
          busy={busy}
          reparentCandidates={reparentCandidates}
        />
      )}
      {pendingOpen && (
        <Modal
          title={<>待你处理（{pendingCount}）</>}
          size="sm"
          onClose={() => setPendingOpen(false)}
          footer={<button className="wb-btn" onClick={() => setPendingOpen(false)}>关闭</button>}
        >
          <div className="wb-scroll-area">
            {/**
              * 待确认草稿一律**按服务端清单**列出（含"关掉横幅先收起"的）：
              * 用户收起横幅只是"别挡着我"，不代表决定过了 —— 必须还能从这里找到。
              */}
            {allPendingDrafts.filter((d) => d.deferredAt === null).map((draft) => (
              <div key={draft.id} className="wb-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <span style={{ flex: 1 }}>
                  <b>待确认的{draftKindLabel(draft.kindCode)}</b>
                  <span className="wb-switch-desc">AI 已提交，确认后才会写入工作台。</span>
                </span>
                <button className="wb-btn" onClick={() => void resumePendingDraft(draft)}>打开弹框</button>
              </div>
            ))}
            {deferredDrafts.length > 0 && (
              <div style={{ marginTop: pendingDraft === null ? 0 : 10 }}>
                <div className="wb-hint" style={{ marginBottom: 4 }}>已暂存（{deferredDrafts.length}）· 做完手上的事再从这里唤回</div>
                {deferredDrafts.map((draft) => (
                  <div key={draft.id} className="wb-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                    <span style={{ flex: 1 }}>
                      <b>{draftKindLabel(draft.kindCode)}</b>
                      <span className="wb-switch-desc">
                        暂存于 {fmtTime(draft.deferredAt ?? draft.updatedAt)}
                        {draft.deferCount > 1 ? ` · 第 ${draft.deferCount} 次` : ''}
                      </span>
                    </span>
                    <button className="wb-btn primary" onClick={() => void resumeDeferredDraft(draft.id)}>唤回处理</button>
                  </div>
                ))}
              </div>
            )}
            {reminders.map((r) => (
              <div key={r.reminderId} className="wb-row" style={{ cursor: 'default' }}>
                <span style={{ flex: 1 }}>{r.title} · {fmtTime(r.dueAt)}</span>
                <button className="wb-btn" onClick={() => void ackReminder(r.reminderId)}>知道了</button>
              </div>
            ))}
            {pendingCount === 0 && <p className="wb-hint">暂无待处理事项。</p>}
          </div>
        </Modal>
      )}
      {/**
        * 工作区的「浏览…」弹窗（批次2 #2/W03）：**同一个 `LocalDocModal`**，只是 `mode="dir"`。
        * 复制第二份弹窗会让"上级 / 此电脑 / 主目录 / 错误 / 加载"这些骨架日后再分叉。
        *
        * ⚠️ 它**必须能盖住打开它的那个对话框**：这个弹窗会被三个入口调用，其中两个本身是对话框
        *（快速录入 / 新建任务）。第一版有两个错：① 内联在面板里（对话框 portal 到 body，层级上排不上）；
        * ② `.wb-modal-mask` 的 z-index 是 200，低于对话框的 `.wb-overlay`(300)。
        * 结果是真实鼠标点在「选择此文件夹」的坐标上命中的是对话框里的元素 ——
        * "点了没反应、值也没落进去"。修法是两处一起改：弹窗 portal 到 body（`LocalDocModal` 内），
        * 遮罩抬到 320（夹在 overlay 300 与对话框内浮层 329/330 之间）。
        * 这个 bug 是 `scripts/verify/suites/workspace-picker.mjs` 抓出来的（诊断里带 elementFromPoint 证据）。
        */}
      <LocalDocModal
        open={dirPickerTarget !== null}
        mode="dir"
        path={dirPickerPath}
        listing={dirPickerListing}
        loading={dirPickerLoading}
        error={dirPickerError}
        busy={busy}
        onPathChange={setDirPickerPath}
        onClose={() => setDirPickerTarget(null)}
        onNavigate={(target) => void loadDirPickerDir(target)}
        onPick={() => undefined}
        onPickAndSummarize={() => undefined}
        onSummarize={() => undefined}
        onPickDir={(entry) => applyWorkspaceDir(entry.path)}
      />
    </>
  )
}
