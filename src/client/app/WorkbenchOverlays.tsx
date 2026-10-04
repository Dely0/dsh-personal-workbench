/**
 * D17 / P7-2：`WorkbenchApp` 的**提示层** JSX（搬迁前 index.tsx 的第 845–1001 行）。
 *
 * 逐字搬出 —— 内层行的缩进一个字没改，只把外层标签挪进本文件的 `return`，
 * 所以拼装出来的 DOM 与拆分前逐层一致（弹窗刻意留在原来的位置上，不改层叠顺序）。
 *
 * 依赖以 `WorkbenchAssembly` 整体注入，这里只**解构自己真正用到的那几个** ——
 * 解构名与入口里的局部名逐个一致（不把 `selected` 改写成 `data.selected`，
 * 既有判据锚的就是这些原文）。
 */
import type { WorkbenchAssembly } from './assembly.js'
import { DraftBanner } from '../components/DraftBanner.js'
import { Icon } from '../components/Icon.js'
import { Modal } from '../components/Modal.js'
import { ModelPicker } from '../components/ModelPicker.js'
import { PersonaPicker } from '../components/PersonaPicker.js'
import { SkillPicker } from '../components/SkillPicker.js'
import { fmtTime } from '../format.js'

export function WorkbenchOverlays(props: WorkbenchAssembly): JSX.Element {
  const { modelModalityTable, promptModal, promptModelSelection, promptPersona, selectedSkills, skillCatalog, skillProblem, skillsAvailable, skillsLoading } = props.ai
  const { cancelPrompt, confirmPrompt, loadSkills, setModelModalityTable, setPromptModal, setPromptModelSelection, setPromptPersona, toggleSkill } = props.ai.actions
  const { busy } = props.busyApi
  const { bootstrap, dicts, selected } = props.data
  const { refresh } = props.data.actions
  const { cursor } = props.day
  const { bumpPlanRefresh, bumpReportRefresh } = props.day.actions
  const { draftSwitchedFrom, duplicatePrompt, pendingDraft } = props.draftsApi
  const { dismissDraft, handleDraftConfirmed, reuseExistingTask, setDraftProblems, setDuplicatePrompt, setPendingDraft } = props.draftsApi.actions
  const { pushToast, setError } = props.feedback.actions
  const { reminderModalOpen, reminders } = props.remindersApi
  const { ackReminder, setReminderModalOpen } = props.remindersApi.actions
  const { aiSessionUsable, closePanel, ideas, knowledge, loadModelModalityTable, runtime } = props
  return (
    <>
      {promptModal !== null && (
        <div className="wb-modal-mask" onClick={cancelPrompt}>
          <div className="wb-modal" style={{ width: 'min(620px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <h4>补充 AI 提示词</h4>
            <p>{promptModal.title}：可留空，留空则继续使用原有默认提示词；填写后会在默认提示词末尾追加你的补充要求。</p>
            <textarea autoFocus value={promptModal.value} onChange={(e) => setPromptModal((prev) => prev === null ? prev : { ...prev, value: e.target.value })} placeholder="输入你想追加给 AI 的补充要求…" />
            {/**
              * 角色选择器（D13-B）：与技能选择器**并列**，且都走普通文档流（不遮挡，AX-R07）。
              * 9 个走共享提示词弹窗的 mode 全部经由这里选择角色。
              *
              * 顺序：**角色在前、技能在后**（AX-R07 的判据，也是原实现的顺序）——
              两个都是普通文档流里的块，谁在前谁在上；角色是"这次以谁的身份"，先定身份再挑工具。
              */}
            <PersonaPicker
              value={promptPersona}
              onChange={setPromptPersona}
              disabled={busy}
              onError={setError}
              onNotice={(message) => pushToast(message, 'success')}
            />
            {/**
              * 技能选择器：与角色选择器并列（都走普通文档流）。
              *
              * 抽成 `SkillPicker` 组件之后，**快速录入弹窗挂的是同一个组件** ——
              * 用户反馈的"快速录入不能选 Skill"就是在这里补上的（2026-10-01）。
              */}
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
            {/**
              * 模型选择器（2026-10-01 补上）：与快速录入**同一个组件**。
              *
              * 用户反馈："除了快速录入外，其他调用 AI 的弹框中依旧无法选择 AI 模型。"
              * 原来它只渲染在快速录入里；现在两个弹窗共用一份实现，
              * 选择值经 `askUserPrompt()` 的返回值传到 `startAISession`（并在那里对**所有 mode**生效）。
              */}
            <ModelPicker
              runtime={runtime}
              value={promptModelSelection}
              onChange={setPromptModelSelection}
              modalityTable={modelModalityTable}
              disabled={busy}
              onError={setError}
              onLoaded={() => { void loadModelModalityTable().then(setModelModalityTable) }}
            />
            <div className="wb-modal-actions">
              <button className="wb-btn" onClick={cancelPrompt}>取消</button>
              <button className="wb-btn primary" onClick={confirmPrompt}>开始</button>
            </div>
          </div>
        </div>
      )}
      {reminders.length > 0 && reminderModalOpen && (
        <Modal
          title={<><Icon name="bell" />到期提醒（{reminders.length}）</>}
          size="sm"
          onClose={() => setReminderModalOpen(false)}
          footer={(
            <>
              <span className="wb-foot-note">点「知道了」后不再提示；host 侧已推送的不会重复出现</span>
              <button className="wb-btn" onClick={() => setReminderModalOpen(false)}>稍后处理</button>
            </>
          )}
        >
          <div className="wb-scroll-area">
            {reminders.map((r) => (
              <div key={r.reminderId} className="wb-row" style={{ cursor: 'default' }}>
                <span style={{ flex: 1 }}>{r.title} · {fmtTime(r.dueAt)}</span>
                <button className="wb-btn" onClick={() => void ackReminder(r.reminderId)}>知道了</button>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {pendingDraft !== null && <DraftBanner
        draft={pendingDraft}
        runtime={runtime}
        closePanel={closePanel}
        kindName={(kind, code) => dicts.find((d) => d.kind === kind && d.code === code)?.name ?? code}
        onProblems={setDraftProblems}
        onNotice={(message, tone) => pushToast(message, tone)}
        isSessionUsable={(sessionId) => aiSessionUsable(runtime, sessionId)}
        onConfirmed={(outcome) => handleDraftConfirmed(outcome, pendingDraft)}
        switchedFrom={draftSwitchedFrom === null ? undefined : { kindCode: dicts.find((d) => d.kind === 'draft_kind' && d.code === draftSwitchedFrom.kindCode)?.name ?? draftSwitchedFrom.kindCode }}
        /**
         * 团队记忆能力：来自 `GET /api/workbench/bootstrap` 的 `memoryAvailable`。
         *
         * 团队记忆是**公司内部系统**、不会开源，开源用户拿不到服务 —— 所以
         * `bootstrap` 还没回来 / 旧服务端不给这个字段时**按不可用处理**，
         * 复盘弹框里的「🧠 同步到团队记忆库」整块不渲染。
         */
        memoryAvailable={bootstrap?.memoryAvailable === true}
        onDismissed={() => { dismissDraft(pendingDraft) }}
        /**
         * 「回到…会话」用：**只把横幅从投影里拿掉**，不触发任何网络刷新。
         *
         * 修的是 2026-09-13 用户实测的"点回到会话后过 5 秒弹框才消失"：
         * 旧路径只登记屏蔽集合、不动 `pendingDraft`，于是界面要等下一轮 5 秒轮询
         * 才被覆盖。这里同步清掉，同一帧就消失。
         */
        onSettled={() => setPendingDraft(null)}
        onDone={() => { setPendingDraft(null); bumpPlanRefresh(); bumpReportRefresh(); knowledge.bumpRefreshKey(); ideas.actions.refresh(); void refresh() }}
        /**
         * 右上角 X / Esc / 点遮罩 = **收起这条横幅**（不是放弃草稿）。
         *
         * 必须把 id 记进 dismissed 集合，否则 5 秒轮询立刻又把它推上来 ——
         * 用户看到的就是"关闭按钮没有任何逻辑，关掉 5 秒后又弹出"
         * （2026-09-12 实测 BUG）。草稿本身仍是 pending，会留在「待处理」里等你决定。
         */
        onClose={() => { dismissDraft(pendingDraft); setPendingDraft(null) }}
      />}

      {/**
        * 「库里已有同名任务」选择框（2026-09-13 重复建单事故）。
        *
        * 服务端**只告警、不静默合并**：同名任务可能是正当需求（每周例会），
        * 所以这里必须由用户明确选一次 —— 要么保留两条，要么把这次的产出收口到已有那条上。
        */}
      {duplicatePrompt !== null && (
        <Modal
          title={<>⚠️ 库里已经有一条同名任务</>}
          size="sm"
          onClose={() => setDuplicatePrompt(null)}
          footer={(
            <>
              <button className="wb-btn" onClick={() => setDuplicatePrompt(null)}>保留两条，我自己处理</button>
              <button className="wb-btn primary" onClick={() => void reuseExistingTask(duplicatePrompt)}>
                就用已有那条（归档本次新建的那条）
              </button>
            </>
          )}
        >
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div style={{ marginBottom: 6 }}>标题：<b>{duplicatePrompt.existingTitle}</b></div>
            <div style={{ marginBottom: 6, color: 'var(--dsw-alias-label-secondary)' }}>
              本次草稿确认后，库里现在有两条同名任务。已有那条 id：{duplicatePrompt.existingTaskId.slice(0, 8)}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' }}>
              {duplicatePrompt.sameDescription
                ? '两条的**描述逐字相同** —— 很可能是同一件事被提交了两次（例如执行会话又交了一份草稿）。'
                : '两条的描述**不同** —— 可能是两次独立录入，也可能是执行会话重复提交，请自行判断。'}
              {duplicatePrompt.sameWorkspace ? ' 工作区相同。' : ' 工作区不同。'}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
              「就用已有那条」会把这条草稿收口到已有任务上，并归档本次新建的那条
              （可在任务列表页「查看归档」恢复，不会丢数据）。
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
