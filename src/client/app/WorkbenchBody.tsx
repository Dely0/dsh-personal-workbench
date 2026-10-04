/**
 * D17 / P7-2：`WorkbenchApp` 的**主体** JSX（搬迁前 index.tsx 的第 1003–1182 行）。
 *
 * 逐字搬出 —— 内层行的缩进一个字没改，只把外层标签挪进本文件的 `return`，
 * 所以拼装出来的 DOM 与拆分前逐层一致（弹窗刻意留在原来的位置上，不改层叠顺序）。
 *
 * 依赖以 `WorkbenchAssembly` 整体注入，这里只**解构自己真正用到的那几个** ——
 * 解构名与入口里的局部名逐个一致（不把 `selected` 改写成 `data.selected`，
 * 既有判据锚的就是这些原文）。
 */
import type { WorkbenchAssembly } from './assembly.js'
import { SettingsModal } from '../components/SettingsModal.js'
import { startOfWeek } from '../format.js'
import { readNotificationCtor, requestNotificationPermission, sendSystemNotification } from '../notificationCapability.js'
import { CalendarView } from '../views/CalendarView.js'
import { IdeasDetailPane } from '../views/IdeasDetailPane.js'
import { IdeasListView } from '../views/IdeasListView.js'
import { KnowledgeDetailPane } from '../views/KnowledgeDetailPane.js'
import { KnowledgeListView } from '../views/KnowledgeListView.js'
import { TaskDetailPane } from '../views/TaskDetailPane.js'
import { TaskListView } from '../views/TaskListView.js'
import { TodayPane } from '../views/TodayPane.js'

export function WorkbenchBody(props: WorkbenchAssembly): JSX.Element {
  const { openSessionInPanel, startAISession } = props.ai.actions
  const { busy } = props.busyApi
  const { bootstrap, childrenOf, dictOf, dicts, pendingMap, selected, taskKnowledge, tasks } = props.data
  const { archiveSelectedTask, completeTaskFromProgress, createSubtask, patchTask, restoreTask, saveProgress } = props.data.actions
  const { addingPlanTaskId, calMode, capacity, capacityEdit, capacityExpanded, cursor, dayPanel, monthGrid, picked, weekDays } = props.day
  const { addTaskToPlan, moveMonth, moveWeek, setCalMode, setCapacityEdit, setCapacityExpanded, setCursor, setPicked } = props.day.actions
  const { draftProblems } = props.draftsApi
  const { setDraftProblems } = props.draftsApi.actions
  const { pushToast, setError, setNotice } = props.feedback.actions
  const { editDraft, subtaskParent } = props.forms
  const { view } = props.nav
  const { setView } = props.nav.actions
  const { dictEditCode, dictError, dictForm, dictKind, recallLog, recallSessionOff, settings, settingsSaving, showSettings } = props.prefs
  const { deleteDictionaryEntry, loadRecallLog, recallSessionRestore, saveDictionaryEntry, saveIncludeOverdue, saveSettings, setDictEditCode, setDictError, setDictForm, setDictKind, setSettings, setShowSettings, toggleDictionaryEntry } = props.prefs.actions
  const { notifyPerm, reminderBusy, reminderChannel, reminderOptions, reminderPolicy } = props.remindersApi
  const { addTaskReminder, loadReminderChannel, resetReminderState, saveReminderPolicy, saveReminderTarget, sendReminderTest, setNotifyPerm, setReminderChannel, setReminderPolicy } = props.remindersApi.actions
  const { aiSessionUsable, dayPanelProps, detail, forms, ideas, knowledge, linkExistingSession, linkedSessionIds, now, openQuickEntry, openTask, openTaskById, runtime, saveDailyCapacity, sessionCandidates, sessionListSnapshot, taskList } = props
  return (
    <div className="wb-body">
        {draftProblems.length > 0 && (
          <div className="wb-draft-problems" role="alert">
            <h5>⚠️ 有 {draftProblems.length} 项没能创建（其余已正常入册）</h5>
            {draftProblems.map((p, i) => (
              <div key={i}>
                <b>{p.title === '' ? '(无标题)' : p.title}</b>：{p.reason}
                <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>（{p.field} = {p.code}）</span>
              </div>
            ))}
            <div style={{ marginTop: 6, color: 'var(--dsw-alias-label-secondary)' }}>
              这些条目<b>没有被创建</b>。请让 AI 用合法 code 重新提交，或在界面上手动补建。
            </div>
            <button className="wb-btn" style={{ marginTop: 6 }} onClick={() => setDraftProblems([])}>知道了，关闭提示</button>
          </div>
        )}
        <div className="wb-nav">
      {showSettings && (
        <SettingsModal
          settings={settings}
          onSettingsChange={setSettings}
          onSaveSettings={saveSettings}
          saving={settingsSaving}
          notifyPermission={notifyPerm}
          /**
           * 请求授权（v1.15.7）：**先判支不支持**再请求。
           *
           * 旧写法直接 `Notification.requestPermission()`，rc.2 上不支持的客户端会抛
           * `TypeError`，而 `.then()` 后面没有 `.catch()` ⇒ 用户点完什么也看不到。
           * 现在失败一定变成一条可读提示（控制台也留痕），不再有"点了没反应的按钮"。
           */
          onRequestNotifyPermission={() => {
            void requestNotificationPermission(readNotificationCtor(globalThis)).then((result) => {
              setNotifyPerm(result.permission)
              if (result.ok) pushToast('桌面通知已开启', 'success')
              else pushToast(`通知授权未成功：${result.reason}`, 'error')
            })
          }}
          /**
           * 发送测试通知（v1.15.7）：失败**必须可观测**。
           *
           * 旧写法 `try { new Notification(…) } catch { ignore }` 把失败吞得干干净净，
           * 用户看到的就是"显示已开启但毫无反应"（本次 P0 的原始描述）。
           * 现在：成功给一条成功提示，失败把**宿主原话**带出来。
           * ⚠️ 成功的措辞只说"已交给浏览器"——系统级是否真的显示，网页侧读不到。
           */
          onSendTestNotification={() => {
            const sent = sendSystemNotification({
              NotificationCtor: readNotificationCtor(globalThis),
              title: 'dsh-personal-workbench 通知测试',
              body: '如果你看到这条系统通知，说明桌面提醒已正常工作。',
            })
            if (sent.ok) {
              pushToast('测试通知已交给浏览器；若没看到，请检查系统的通知/专注助手设置', 'success')
            } else {
              pushToast(`测试通知发送失败：${sent.reason}`, 'error')
            }
          }}
          reminderPolicy={reminderPolicy}
          onReminderPolicyChange={setReminderPolicy}
          onSaveReminderPolicy={saveReminderPolicy}
          reminderChannel={reminderChannel}
          reminderOptions={reminderOptions}
          reminderBusy={reminderBusy}
          onSelectTarget={(botId, targetId) => setReminderChannel((prev) => prev === null ? prev : { ...prev, botId, targetId })}
          onSaveTarget={saveReminderTarget}
          onRefreshChannel={loadReminderChannel}
          onSendTestMessage={sendReminderTest}
          dicts={dicts}
          dictKind={dictKind}
          onDictKindChange={setDictKind}
          dictForm={dictForm}
          onDictFormChange={setDictForm}
          dictEditCode={dictEditCode}
          onDictEditCodeChange={setDictEditCode}
          dictError={dictError}
          onDictErrorChange={setDictError}
          onSaveDictionary={saveDictionaryEntry}
          onToggleDictionary={toggleDictionaryEntry}
          onDeleteDictionary={deleteDictionaryEntry}
          recallLog={recallLog}
          onRefreshRecallLog={() => void loadRecallLog()}
          recallSessionOff={recallSessionOff}
          onRecallSessionOffChange={(sessionId, mode) => void recallSessionRestore(sessionId, mode)}
          onClose={() => setShowSettings(false)}
        />
      )}
          {view === 'today' && (
            <TodayPane
              stats={bootstrap?.stats}
              capacity={capacity}
              capacityEdit={capacityEdit}
              dailyCapacityMinutes={settings.dailyCapacityMinutes}
              defaultEstimateMinutes={settings.defaultEstimateMinutes}
              includeOverdue={settings.dailyCapacityIncludeOverdue}
              capacityExpanded={capacityExpanded}
              onCapacityEditStart={() => setCapacityEdit(String(settings.dailyCapacityMinutes))}
              onCapacityEditChange={setCapacityEdit}
              onCapacityEditCommit={() => void saveDailyCapacity()}
              onCapacityEditCancel={() => setCapacityEdit(null)}
              onIncludeOverdueChange={(next) => void saveIncludeOverdue(next)}
              onCapacityExpandedChange={setCapacityExpanded}
              onAddToPlan={addTaskToPlan}
              addingTaskId={addingPlanTaskId}
              dayPanelProps={dayPanelProps}
              onQuickEntry={openQuickEntry}
              onNewTask={() => forms.actions.toggleCreate()}
            />
          )}
          {view === 'calendar' && (
            <CalendarView
              calMode={calMode}
              cursor={cursor}
              now={now}
              picked={picked}
              weekDays={weekDays}
              monthGrid={monthGrid}
              tasks={tasks}
              dayPanelProps={dayPanelProps}
              onMoveWeek={moveWeek}
              onMoveMonth={moveMonth}
              onToday={() => (calMode === 'week' ? setCursor(startOfWeek(now)) : setCursor(new Date(now.getFullYear(), now.getMonth(), 1)))}
              onPick={setPicked}
              onCalModeChange={setCalMode}
              onStartPlanAISession={(d) => void startAISession('plan', null, d)}
              readOnly={dayPanel.readOnly}
              day={dayPanel.day}
            />
          )}

          {view === 'knowledge' && <KnowledgeListView model={knowledge} dictOf={dictOf} busy={busy} />}

          {view === 'ideas' && <IdeasListView model={ideas} dictOf={dictOf} busy={busy} startAISession={startAISession} />}

          {view === 'list' && <TaskListView model={taskList} dictOf={dictOf} dicts={dicts} selectedId={selected?.task.id} pending={pendingMap} childrenOf={childrenOf} onOpen={openTask} />}
        </div>

        <div className="wb-detail">
          {view === 'ideas'
            ? <IdeasDetailPane model={ideas} dictOf={dictOf} busy={busy} startAISession={startAISession} />
            : view === 'knowledge'
            ? <KnowledgeDetailPane model={knowledge} tasks={tasks} dictOf={dictOf} setError={setError} setNotice={setNotice} openTaskById={openTaskById} />
            : (
              <TaskDetailPane
                selected={selected}
                detail={detail}
                dicts={dicts}
                dictOf={dictOf}
                pendingMap={pendingMap}
                settings={settings}
                taskKnowledge={taskKnowledge}
                knowledge={knowledge}
                busy={busy}
                editing={editDraft !== null}
                onOpenEdit={forms.actions.openEdit}
                subtaskParent={subtaskParent}
                onAddSubtask={forms.actions.setSubtaskParent}
                onCancelSubtask={() => forms.actions.setSubtaskParent(null)}
                startAISession={startAISession}
                setNotice={setNotice}
                patchTask={patchTask}
                saveProgress={saveProgress}
                completeTaskFromProgress={completeTaskFromProgress}
                archiveSelectedTask={archiveSelectedTask}
                openTask={openTask}
                onRestoreTask={restoreTask}
                onCreateSubtask={createSubtask}
                setView={setView}
                isSessionUsable={(sessionId) => aiSessionUsable(runtime, sessionId)}
                sessionCandidates={sessionCandidates}
                sessionListSnapshot={sessionListSnapshot}
                linkedSessionIds={linkedSessionIds}
                linkExistingSession={linkExistingSession}
                openSessionInPanel={openSessionInPanel}
                addTaskReminder={addTaskReminder}
                resetReminderState={resetReminderState}
              />
            )}
        </div>
    </div>
  )
}
