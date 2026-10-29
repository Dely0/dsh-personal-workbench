/**
 * 设置弹窗：左分区导航 + 右内容，替代原来塞在左栏里、把任务列表挤下去的内联长条。
 *
 * 分区：通用（工作区）· 通知（桌面通知）· 微信提醒（通道 + 策略）· 字典（类型/状态/优先级/点子类型）
 * 改动状态用 changed 标记在导航项旁显示小圆点，避免"改了没保存却看不出来"。
 */
import { useMemo, useState, type ReactNode } from 'react'
import type {
  ReminderBotOption, ReminderChannelStatus, ReminderOptionsView, ReminderPolicyView, WorkbenchSettings,
} from '../../shared/contracts.js'
import type { DraftView } from '../../shared/contracts.js'
import { Modal } from './Modal.js'
import { PersonaAdmin } from './PersonaAdmin.js'
import { ExpertCreateModal } from './ExpertCreateModal.js'
import { useI18n } from '../i18n.js'
import type { UseWorkbenchExpertsResult } from '../hooks/useWorkbenchExperts.js'
import { notificationStateText, type NotificationState } from '../notificationCapability.js'

export interface DictionaryLike {
  kind: string
  code: string
  name: string
  config: Record<string, unknown>
  builtin?: number
  active?: number
  sortOrder?: number
}

type Section = 'general' | 'persona' | 'notify' | 'recall' | 'wechat' | 'dict'
/**
 * 可管理的字典种类。
 *
 * ⚠️ `knowledge_kind` 原先漏了 —— 知识库类型的出厂 `config` 是空的（没有颜色），
 * 而这里又没有入口，用户连手工补色的地方都没有（现象：知识库 Tab/徽标全灰，且无法自救）。
 * 字典表里本来就有这 4 条，缺的只是入口。
 */
export type DictKind = 'type' | 'status' | 'priority' | 'knowledge_kind' | 'idea_kind'

/** 草稿通知类型选项（与后端 policy.draftNotifyKinds 的取值对齐）。 */
const DRAFT_NOTIFY_OPTIONS: Array<{ code: string; label: string }> = [
  { code: 'completion', label: '完成验收申请' },
  { code: 'review', label: '复盘草稿' },
  { code: 'report', label: '日报/周报草稿' },
  { code: 'knowledge', label: '知识条目草稿' },
  { code: 'idea_cluster', label: '点子王提案' },
  { code: 'idea_tasks', label: '点子落地提案' },
]

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'general', label: '通用' },
  /**
   * ⚠️ 「角色库」是**独立页签**（2026-10-01 用户要求）。
   *
   * 原先它挤在「通用」里，位置在"AI 会话工作区"和"今日容量"之间 —— 三件事概念上无关，
   * 却共享一列 500px 宽的窄栏：角色列表（每组标题 + 每行名称/描述/来源 + 两个按钮）
   * 在那样的宽度里必然"全挤在一起"。用户原话："设置页面的角色库是否应该是单独的一个页面，
   * 而不是挤在通用页面里面"。
   *
   * 拆成独立页签的收益不只是宽度：**这一页的写入口径与其它页不同** ——
   * 收藏/停用是**立即生效、立即重读服务端**的（见 PersonaAdmin 文件头），
   * 而其它字段是"改了要按保存设置"。分开之后这个差别可以就地讲清，不再和草稿字段混在一页。
   */
  { key: 'persona', label: '角色库' },
  { key: 'notify', label: '通知' },
  { key: 'recall', label: '知识库召回' },
  { key: 'wechat', label: '微信提醒' },
  { key: 'dict', label: '字典管理' },
]

const DICT_KINDS: Array<{ key: DictKind; label: string }> = [
  { key: 'type', label: '任务类型' },
  { key: 'status', label: '状态' },
  { key: 'priority', label: '优先级' },
  { key: 'knowledge_kind', label: '知识库类型' },
  { key: 'idea_kind', label: '点子类型' },
]

export interface SettingsModalProps {
  settings: WorkbenchSettings
  onSettingsChange: (next: WorkbenchSettings) => void
  onSaveSettings: () => Promise<void>
  saving: boolean

  /**
   * 系统通知的可用性**三态**（v1.15.7）。
   *
   * 旧类型是 `NotificationPermission | 'unsupported'`，把"已被拒绝"与"还没授权"
   * 混成同一个 `default`，于是面板只能给出"授权按钮"这一种操作 ——
   * 而 `denied` 时再点授权是**不会有任何反应**的（浏览器不再弹框），
   * 用户看到的就是"点了没反应"。四态各有各的文案与操作，判定在
   * `src/client/notificationCapability.ts`（唯一实现，可被 node --test 直接测）。
   */
  notifyPermission: NotificationState
  onRequestNotifyPermission: () => void
  onSendTestNotification: () => void

  reminderPolicy: ReminderPolicyView | null
  onReminderPolicyChange: (next: ReminderPolicyView) => void
  onSaveReminderPolicy: () => Promise<void>
  reminderChannel: ReminderChannelStatus | null
  reminderOptions: ReminderOptionsView | null
  reminderBusy: boolean
  onSelectTarget: (botId: string | null, targetId: string | null) => void
  onSaveTarget: () => Promise<void>
  onRefreshChannel: () => Promise<void>
  onSendTestMessage: () => Promise<void>

  dicts: DictionaryLike[]
  dictKind: DictKind
  onDictKindChange: (kind: DictKind) => void
  dictForm: { name: string; code: string; color: string; sortOrder: number } | null
  onDictFormChange: (next: { name: string; code: string; color: string; sortOrder: number } | null) => void
  dictEditCode: string | null
  onDictEditCodeChange: (code: string | null) => void
  dictError: string | null
  onDictErrorChange: (message: string | null) => void
  onSaveDictionary: (event: React.FormEvent<HTMLFormElement>) => Promise<void>
  onToggleDictionary: (entry: DictionaryLike) => Promise<void>
  onDeleteDictionary: (entry: DictionaryLike) => Promise<void>

  /**
   * 知识库自动召回的**可观测回执**（v1.15.3）。
   *
   * 验收标准里"会话/日志里能看到检索了哪些关键词、命中哪几条、是否被引用"这一条，
   * 在界面上的落点就是这里：用户不用翻日志文件、不用调接口，打开设置就能看见
   * AI 到底查过什么、命中了什么、有没有真的被引用。
   */
  recallLog: { lines: string[]; loading: boolean; error: string | null }
  onRefreshRecallLog: () => void
  /** 会话级"关掉"的会话列表（可在这里解除）。 */
  recallSessionOff: string[]
  onRecallSessionOffChange: (sessionId: string, mode: 'on' | 'clear') => void

  /**
   * **专家域（P8）**：角色库这一页的数据与动作全部来自 `useWorkbenchExperts`
   * （方案 §12.3：`PersonaAdmin` 不得再维护第二份 catalog）。
   * 组装层只把 hook 的结果与 actions 透传进来，不在这里包一层。
   */
  experts: UseWorkbenchExpertsResult
  /** 待确认的专家草稿（`allPendingDrafts` 里 `kindCode === 'expert'` 的那些）。 */
  pendingExpertDrafts: readonly DraftView[]
  /** 「查看草稿」：把它推到草稿横幅那条路（复用草稿域的投影，不新建第二份）。 */
  onOpenExpertDraft: (draft: DraftView) => void
  /** 「继续修改」：打开它的生成会话。 */
  onEditExpertDraft: (draft: DraftView) => void

  onClose: () => void
}

export function SettingsModal(props: SettingsModalProps): ReactNode {
  const [section, setSection] = useState<Section>('general')
  const {
    settings, onSettingsChange, onSaveSettings, saving,
    notifyPermission, onRequestNotifyPermission, onSendTestNotification,
    reminderPolicy, onReminderPolicyChange, onSaveReminderPolicy,
    reminderChannel, reminderOptions, reminderBusy,
    onSelectTarget, onSaveTarget, onRefreshChannel, onSendTestMessage,
    dicts, dictKind, onDictKindChange,
    dictForm, onDictFormChange, dictEditCode, onDictEditCodeChange, dictError, onDictErrorChange,
    onSaveDictionary, onToggleDictionary, onDeleteDictionary,
    recallLog, onRefreshRecallLog, recallSessionOff, onRecallSessionOffChange,
    experts, pendingExpertDrafts, onOpenExpertDraft, onEditExpertDraft,
    onClose,
  } = props

  const { t } = useI18n()
  const dictOf = (kind: string): DictionaryLike[] => dicts.filter((entry) => entry.kind === kind)
  const targets: ReminderBotOption['targets'] = useMemo(
    () => reminderOptions?.bots.find((bot) => bot.botId === reminderChannel?.botId)?.targets ?? [],
    [reminderOptions, reminderChannel?.botId],
  )

  return (
    <Modal
      title={t('工作台设置')}
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <span className="wb-foot-note">{t('设置保存在本机工作台数据库，不影响 DSH 其他配置')}</span>
          <button className="wb-btn" onClick={onClose}>{t('取消')}</button>
          <button className="wb-btn primary" disabled={saving} onClick={() => void onSaveSettings()}>
            {saving ? t('保存中…') : t('保存设置')}
          </button>
        </>
      )}
    >
      <div className="wb-settings">
        <nav className="wb-settings-nav" aria-label={t('设置')}>
          {SECTIONS.map((item) => (
            <button key={item.key} className={section === item.key ? 'on' : ''} onClick={() => setSection(item.key)}>
              {t(item.label)}
              {item.key === 'wechat' && reminderChannel?.queued !== undefined && reminderChannel.queued > 0 && (
                <span className="dot" title={t('队列中 {n} 条待发', { n: reminderChannel.queued })} />
              )}
            </button>
          ))}
        </nav>

        <div className="wb-settings-pane">
          {section === 'general' && (
            <section>
              {/**
                * 界面语言（issue #12）：`auto` 跟随浏览器，其余是显式选择。
                * 文案本身走 t()：英文用户打开设置时至少这一项立刻是英文。
                */}
              <h5>{t('语言')}</h5>
              <div className="wb-field">
                <span>{t('界面语言')}</span>
                <select
                  value={settings.uiLocale}
                  onChange={(e) => onSettingsChange({ ...settings, uiLocale: e.target.value as WorkbenchSettings['uiLocale'] })}
                >
                  <option value="auto">{t('自动（跟随浏览器）')}</option>
                  <option value="zh-CN">中文</option>
                  <option value="en-US">English</option>
                </select>
                <div className="wb-hint">{t('选择工作台界面语言；自动 = 跟随浏览器语言')}</div>
              </div>
              <h5>{t('AI 会话工作区')}</h5>
              <div className="wb-field">
                <span>{t('默认工作区（任务未指定时使用）')}</span>
                <input
                  value={settings.defaultWorkspace}
                  onChange={(e) => onSettingsChange({ ...settings, defaultWorkspace: e.target.value })}
                  placeholder={t('例如 D:\\Code\\AI-Workspace')}
                />
              </div>
              <label className="wb-switch-row">
                <input
                  type="checkbox"
                  checked={settings.autoCreateTypeFolders}
                  onChange={(e) => onSettingsChange({ ...settings, autoCreateTypeFolders: e.target.checked })}
                />
                <span>
                  {t('自动为每个任务创建独立文件夹')}
                  <span className="wb-switch-desc">{t('关闭后所有任务共用默认工作区；父任务设了工作区时，未单独设置子任务会跟随父任务。')}</span>
                </span>
              </label>
            </section>
          )}

          {/**
            * 角色库（D13-B / §6.3）—— 2026-10-01 从「通用」拆成独立页签。
            *
            * 外部角色目录是"一等来源"，必须能配；**收藏 / 停用也是这里的配置**
            * （2026-10-01 上一轮从角色选择器搬过来）：它们是对角色库的**配置**，
            * 混在"这次会话用哪个角色"的选择器里会让选择器越长越像设置页。
            * 写入口径与选择器共用 `personaFlagPatch`（唯一实现）。
            *
            * 解释性段落按用户要求**收进一个默认折叠的「使用说明」**：
            * 页面默认只留可操作的控件，要看"角色是什么、来源优先级、停用会怎样"再点开。
            */}
          {section === 'persona' && (
            <section>
              <h5>{t('外部角色目录')}</h5>
              <div className="wb-field">
                <span>{t('可留空；例如 （外部角色目录）')}</span>
                <input
                  value={settings.personaExternalDir}
                  onChange={(e) => onSettingsChange({ ...settings, personaExternalDir: e.target.value })}
                  placeholder={t('留空 = 只用内置角色库与用户库')}
                />
              </div>

              <details className="wb-notes">
                <summary>{t('使用说明（角色是什么 / 来源优先级 / 停用会怎样）')}</summary>
                <div className="wb-notes-body">
                  <p><b>{t('角色 = 一份 .md')}</b>（<code># 名称</code> + {t('引用块元信息 + 正文），工具按名称逐字使用。')}</p>
                  <p><b>{t('三级来源，前者优先：')}</b>{t('用户库（~/.dsh/workbench/personas）> 外部角色目录 > 内置 15 篇（6 篇通用工作方式 + 9 篇领域岗位）。列表里每行右侧标出它来自哪一级。')}</p>
                  <p><b>{t('内置 / 外部角色只读')}</b>：{t('工作台不复制、不修改、不覆盖它们。')}<b>{t('新建专家只在用户确认后写入用户库')}</b>{t('（AI 只先暂存成草稿，确认前不落盘）。')}</p>
                  <p><b>{t('停用')}</b>{t('的角色仍会列在下表里（否则启用不回来），只是不能在选择器中选中。')}</p>
                  <p><b>{t('收藏')}</b>{t('只影响选择器里的「只看收藏」筛选，不改变角色本身的可用性。')}</p>
                  <p>{t('角色正文与资源由')} <code>workbench_load_persona</code> / <code>workbench_read_persona_resource</code> {t('按需读取，不预先塞进提示词。')}</p>
                  <p className="wb-notes-warn">{t('本页的收藏 / 停用与「允许 AI 自主召唤专家」是点一下立刻生效（不等「保存设置」）；上面的外部目录属于设置草稿，要按「保存设置」才生效。')}</p>
                </div>
              </details>

              <PersonaAdmin
                saving={saving}
                catalog={experts.catalog}
                loading={experts.catalogLoading}
                error={experts.catalogError}
                autoSummon={experts.autoSummon}
                personaFlags={experts.personaFlags}
                pendingExpertDrafts={pendingExpertDrafts}
                onRefresh={experts.actions.refreshCatalog}
                onSetAuto={experts.actions.setAutoEnabled}
                onToggleFavorite={experts.actions.toggleFavorite}
                onToggleDisabled={experts.actions.toggleDisabled}
                onCreate={experts.actions.openCreate}
                onOpenDraft={onOpenExpertDraft}
                onEditDraft={onEditExpertDraft}
              />

              {/**
                * 新建专家弹窗（P8 §5.4）：挂在这里而不是组装层，是因为它由上面工具栏的
                * 「新建专家」按钮打开，状态归 `useWorkbenchExperts.create` 所有；
                * `Modal` 走 portal，视觉上不受设置弹窗层级影响。
                */}
              <ExpertCreateModal
                open={experts.create.open}
                request={experts.create.request}
                workspaceId={experts.create.workspaceId}
                workspaceChoices={experts.create.workspaceChoices}
                busy={experts.create.busy}
                error={experts.create.error}
                createAvailable={experts.create.available}
                generationSessionId={experts.create.generationSessionId}
                generationDraftId={experts.create.generationDraftId}
                onChangeRequest={experts.actions.setCreateRequest}
                onChangeWorkspace={experts.actions.setCreateWorkspace}
                onStart={() => void experts.actions.startGeneration()}
                onClose={experts.actions.closeCreate}
                onOpenSession={experts.actions.openCreateGenerationSession}
              />
            </section>
          )}

          {section === 'general' && (
            <section>
              {/*
                「今日容量」的口径偏好（v1.15.1）。
                这两个值直接决定任务页顶部那个数字（已排 / 余），所以必须**可见可改** ——
                写死在代码里就变成了又一个用户无法解释、也无法纠正的数字。
                规则全文在任务页的「规则」面板里（CapacityRulePanel），这里只放两个开关，
                并各写一句"它会怎样影响读数"。
              */}
              <h5 style={{ marginTop: 18 }}>{t('今日容量')}</h5>
              <div className="wb-field">
                <span>{t('默认耗时（任务没填「预计耗时」时按它计入，分钟）')}</span>
                <input
                  type="number"
                  min={5}
                  max={1440}
                  step={5}
                  value={settings.defaultEstimateMinutes}
                  onChange={(e) => {
                    // 空串/非数字时不写 NaN 进 settings：先落到缺省 30，用户继续输入会被后续 onChange 覆盖
                    const parsed = Number(e.target.value)
                    const next = Number.isFinite(parsed) && parsed >= 5 ? Math.min(1440, Math.round(parsed)) : 30
                    onSettingsChange({ ...settings, defaultEstimateMinutes: next })
                  }}
                />
                <span className="wb-hint">{t('可设 5–1440；任务自己的耗时优先于它。')}</span>
              </div>
              <label className="wb-switch-row">
                <input
                  type="checkbox"
                  checked={settings.dailyCapacityIncludeOverdue}
                  onChange={(e) => onSettingsChange({ ...settings, dailyCapacityIncludeOverdue: e.target.checked })}
                />
                <span>
                  {t('把逾期任务计入今日容量')}
                  <span className="wb-switch-desc">
                    {t('默认关闭：逾期是历史欠账，混进"今天要做的事"会让「已排」失去意义。打开后，未完成且截止时间早于今天 0 点的任务也会计入（读数会明显变大）。任务页的「今日容量 → 规则」面板里有同样的开关，两处写同一个设置。')}
                  </span>
                </span>
              </label>
            </section>
          )}

          {section === 'notify' && (
            <section>
              <h5>{t('桌面通知')}</h5>
              <label className="wb-switch-row">
                <input
                  type="checkbox"
                  checked={settings.desktopNotify}
                  onChange={(e) => onSettingsChange({ ...settings, desktopNotify: e.target.checked })}
                />
                <span>
                  {t('任务到期时弹系统通知')}
                  <span className="wb-switch-desc">{t('需要浏览器授权；DSH 页面保持打开（可最小化）即可收到。')}</span>
                </span>
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                {/*
                  三态文案与操作**由一处判定给出**（`notificationStateText`）：面板只负责渲染，
                  不在组件里再判一遍状态（本项目最大的 bug 类别：同一个语义被独立计算多次）。
                  `granted` 仍给「发送测试通知」，但文案要说清"已授权 ≠ 一定弹得出来"
                  （系统级总开关/专注助手/按应用单关，网页读不到也管不了）。
                */}
                <span className="wb-hint">{notificationStateText(notifyPermission)}</span>
                {notifyPermission === 'default' && (
                  <button className="wb-btn" onClick={onRequestNotifyPermission}>{t('授权浏览器通知')}</button>
                )}
                {notifyPermission === 'granted' && <button className="wb-btn" onClick={onSendTestNotification}>{t('发送测试通知')}</button>}
                {notifyPermission === 'granted' && <span style={{ fontSize: 12, color: '#2E9B7B' }}>{t('浏览器通知已授权')}</span>}
              </div>
            </section>
          )}

          {section === 'recall' && (
            <section>
              <h5>{t('知识库自动召回')}</h5>
              <label className="wb-switch-row">
                <input
                  type="checkbox"
                  checked={settings.autoKnowledgeRecall}
                  onChange={(e) => onSettingsChange({ ...settings, autoKnowledgeRecall: e.target.checked })}
                />
                <span>
                  {t('会话里自动检索并带上相关知识')}
                  <span className="wb-switch-desc">
                    {t('开启后，动作前 / 报错时 / 写码前 / 验收前会按你的提问自动检索知识库， 命中的条目会以「【工作台知识库】…」出现在会话里（看得见命中了哪几条）。 关闭后不再自动检索与注入，但你仍可以让 AI 用 workbench_search_knowledge 主动查。 单个会话里想临时关掉，直接让 AI 执行 turn_off 即可。')}
                  </span>
                </span>
              </label>

              <div className="wb-recall-log">
                <div className="wb-recall-log-head">
                  <b>{t('最近的召回记录')}</b>
                  <span>{t('检索了哪些关键词、命中哪几条、是否被引用')}</span>
                  <button className="wb-btn" onClick={onRefreshRecallLog} disabled={recallLog.loading}>
                    {recallLog.loading ? t('读取中…') : t('刷新')}
                  </button>
                </div>
                {recallLog.error !== null && <p className="wb-hint">{t('读取失败：{message}', { message: recallLog.error })}</p>}
                {recallLog.error === null && recallLog.lines.length === 0 && (
                  <p className="wb-hint">{t('还没有召回记录。开启后来一次会话，这里就会出现每次检索的账。')}</p>
                )}
                {recallLog.lines.length > 0 && (
                  <ul className="wb-recall-log-lines">
                    {recallLog.lines.map((line, index) => <li key={`${index}-${line.slice(0, 24)}`}>{line}</li>)}
                  </ul>
                )}
              </div>

              {recallSessionOff.length > 0 && (
                <div className="wb-recall-sessions">
                  <b>{t('已单独关闭自动召回的会话')}</b>
                  <ul>
                    {recallSessionOff.map((sessionId) => (
                      <li key={sessionId}>
                        <code>{sessionId}</code>
                        <button className="wb-btn" onClick={() => onRecallSessionOffChange(sessionId, 'clear')}>{t('恢复跟随全局')}</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {section === 'wechat' && (
            <section>
              <h5>{t('微信提醒')}</h5>
              {reminderChannel === null || reminderPolicy === null ? (
                <p className="wb-hint">{t('正在读取通道状态…')}</p>
              ) : (
                <>
                  <label className="wb-switch-row">
                    <input
                      type="checkbox"
                      checked={reminderPolicy.enabled}
                      onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, enabled: e.target.checked })}
                    />
                    <span>
                      {t('启用微信提醒')}
                      <span className="wb-switch-desc">{t('关闭时行为与原来完全一致（仅页面横幅 + 桌面通知）。')}</span>
                    </span>
                  </label>

                  {!reminderChannel.installed && (
                    <div className="wb-banner reminder" style={{ margin: '10px 0' }}>
                      <h4>{t('未检测到 dsh-im')}</h4>
                      <div style={{ fontSize: 12.5 }}>
                        {t('微信推送不可用，提醒会回落到页面横幅与桌面通知。安装命令：')}
                        <code style={{ display: 'inline-block', marginTop: 4 }}>pnpm add -g @xmanrui/dsh-im</code>
                      </div>
                    </div>
                  )}
                  {reminderChannel.installed && !reminderChannel.configured && (
                    <div className="wb-banner completion" style={{ margin: '10px 0' }}>
                      <h4>{t('还没有可用的投递目标')}</h4>
                      <div style={{ fontSize: 12.5 }}>{t('请先在微信里给机器人发一条消息（建立 context_token），再点「刷新目标」。')}</div>
                    </div>
                  )}
                  {reminderChannel.circuitOpen && (
                    <div className="wb-banner error" style={{ margin: '10px 0' }}>
                      <h4>{t('微信通道被 iLink 限流')}</h4>
                      <div style={{ fontSize: 12.5 }}>
                        {reminderChannel.circuitUntil === null ? '' : t('{time} 前不发送。', { time: new Date(reminderChannel.circuitUntil).toLocaleTimeString(undefined, { hour12: false }) })}
                        {t('让手机微信给机器人发一条消息即可立即恢复。')}
                      </div>
                    </div>
                  )}

                  {reminderChannel.installed && (
                    <div className="wb-field-grid" style={{ marginTop: 10 }}>
                      <label className="wb-field">
                        <span>{t('机器人')}</span>
                        <select
                          value={reminderChannel.botId ?? ''}
                          onChange={(e) => {
                            const botId = e.target.value === '' ? null : e.target.value
                            const first = reminderOptions?.bots.find((bot) => bot.botId === botId)?.targets[0]?.targetId ?? null
                            onSelectTarget(botId, first)
                          }}
                        >
                          <option value="">{t('选择机器人…')}</option>
                          {(reminderOptions?.bots ?? []).map((bot) => <option key={bot.botId} value={bot.botId}>{bot.label}</option>)}
                        </select>
                      </label>
                      <label className="wb-field">
                        <span>{t('投递目标')}</span>
                        <select
                          value={reminderChannel.targetId ?? ''}
                          onChange={(e) => onSelectTarget(reminderChannel.botId, e.target.value === '' ? null : e.target.value)}
                        >
                          <option value="">{t('选择投递目标…')}</option>
                          {targets.map((target) => <option key={target.targetId} value={target.targetId}>{target.label}</option>)}
                        </select>
                      </label>
                      <div className="wb-field">
                        <span>&nbsp;</span>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button className="wb-btn primary" disabled={reminderBusy} onClick={() => void onSaveTarget()}>{t('保存目标')}</button>
                          <button className="wb-btn" disabled={reminderBusy} onClick={() => void onRefreshChannel()}>{t('刷新目标')}</button>
                          <button className="wb-btn" disabled={reminderBusy || !reminderChannel.configured} onClick={() => void onSendTestMessage()}>{t('发送测试消息')}</button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="wb-field-grid" style={{ marginTop: 14 }}>
                    <label className="wb-field full">
                      <span>{t('草稿通知类型（推送到微信）')}</span>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, paddingTop: 4 }}>
                        {DRAFT_NOTIFY_OPTIONS.map((option) => {
                          const checked = (reminderPolicy.draftNotifyKinds ?? []).includes(option.code)
                          return (
                            <label key={option.code} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' }}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  const current = reminderPolicy.draftNotifyKinds ?? []
                                  const next = e.target.checked ? [...current, option.code] : current.filter((code) => code !== option.code)
                                  onReminderPolicyChange({ ...reminderPolicy, draftNotifyKinds: next })
                                }}
                              />
                              {t(option.label)}
                            </label>
                          )
                        })}
                      </div>
                    </label>
                    <label className="wb-field">
                      <span>{t('即时推送分级')}</span>
                      <input
                        value={reminderPolicy.immediatePriorities.join(',')}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, immediatePriorities: splitCodes(e.target.value) })}
                        placeholder="p0,p1"
                      />
                    </label>
                    <label className="wb-field">
                      <span>{t('汇总分级')}</span>
                      <input
                        value={reminderPolicy.digestPriorities.join(',')}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, digestPriorities: splitCodes(e.target.value) })}
                        placeholder="p2,p3"
                      />
                    </label>
                    <label className="wb-field">
                      <span>{t('每日汇总时间')}</span>
                      <input value={reminderPolicy.digestAt} onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, digestAt: e.target.value })} placeholder="09:00" />
                    </label>
                    <label className="wb-field">
                      <span>{t('静默时段开始')}</span>
                      <input
                        value={reminderPolicy.quietHours?.start ?? ''}
                        onChange={(e) => onReminderPolicyChange({
                          ...reminderPolicy,
                          quietHours: e.target.value === '' ? null : { start: e.target.value, end: reminderPolicy.quietHours?.end ?? '08:00' },
                        })}
                        placeholder={t('22:00（留空=不静默）')}
                      />
                    </label>
                    <label className="wb-field">
                      <span>{t('静默时段结束')}</span>
                      <input
                        value={reminderPolicy.quietHours?.end ?? ''}
                        onChange={(e) => onReminderPolicyChange({
                          ...reminderPolicy,
                          quietHours: e.target.value === '' ? null : { start: reminderPolicy.quietHours?.start ?? '22:00', end: e.target.value },
                        })}
                        placeholder="08:00"
                      />
                    </label>
                    <label className="wb-field">
                      <span>{t('穿透静默的优先级')}</span>
                      <input
                        value={reminderPolicy.quietHoursBypassPriorities.join(',')}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, quietHoursBypassPriorities: splitCodes(e.target.value) })}
                        placeholder="p0"
                      />
                    </label>
                    <label className="wb-field">
                      <span>{t('每小时上限')}</span>
                      <input type="number" min={1} max={60} value={reminderPolicy.hourlyLimit}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, hourlyLimit: Number(e.target.value) })} />
                    </label>
                    <label className="wb-field">
                      <span>{t('每日上限')}</span>
                      <input type="number" min={1} max={500} value={reminderPolicy.dailyLimit}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, dailyLimit: Number(e.target.value) })} />
                    </label>
                    <label className="wb-field">
                      <span>{t('补发回溯（小时）')}</span>
                      <input type="number" min={1} max={168} value={reminderPolicy.catchupWindowHours}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, catchupWindowHours: Number(e.target.value) })} />
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
                    <button className="wb-btn primary" disabled={reminderBusy} onClick={() => void onSaveReminderPolicy()}>{t('保存提醒策略')}</button>
                    <span className="wb-hint" style={{ margin: 0 }}>{t('关掉浏览器后仍会推送；未安装 dsh-im 时自动回落')}</span>
                  </div>
                </>
              )}
            </section>
          )}

          {section === 'dict' && (
            <section>
              <h5>{t('字典管理')}</h5>
              <div className="wb-segmented wb-sub-segmented" style={{ marginBottom: 10 }}>
                {DICT_KINDS.map((item) => (
                  <button
                    key={item.key}
                    className={`wb-seg ${dictKind === item.key ? 'on' : ''}`}
                    onClick={() => { onDictKindChange(item.key); onDictFormChange(null); onDictEditCodeChange(null); onDictErrorChange(null) }}
                  >
                    {t(item.label)}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
                <span className="wb-hint" style={{ margin: 0 }}>{t('默认项受保护，不可删除；可编辑名称/颜色/排序/停用')}</span>
                <button
                  className="wb-btn primary"
                  onClick={() => { onDictEditCodeChange(null); onDictFormChange({ name: '', code: '', color: '#4F86F7', sortOrder: 50 }); onDictErrorChange(null) }}
                >
                  {t('新增')}
                </button>
              </div>
              {dictForm !== null && (
                <form className="wb-form" style={{ marginBottom: 10 }} onSubmit={(e) => void onSaveDictionary(e)}>
                  <label>{t('名称')}<input value={dictForm.name} onChange={(e) => onDictFormChange({ ...dictForm, name: e.target.value })} placeholder={t('例如：客户沟通')} /></label>
                  <label>
                    code{dictEditCode !== null ? <span style={{ fontWeight: 400, fontSize: 11 }}>{t('（不可修改）')}</span> : null}
                    <input value={dictEditCode ?? dictForm.code} disabled={dictEditCode !== null}
                      onChange={(e) => onDictFormChange({ ...dictForm, code: e.target.value })} placeholder={t('client_comm（小写英文/下划线/数字）')} />
                  </label>
                  <label>{t('颜色')}<input type="color" value={dictForm.color} onChange={(e) => onDictFormChange({ ...dictForm, color: e.target.value })} /></label>
                  <label>{t('排序')}<input type="number" value={dictForm.sortOrder} onChange={(e) => onDictFormChange({ ...dictForm, sortOrder: Number(e.target.value) })} /></label>
                  <div className="full" style={{ display: 'flex', gap: 8 }}>
                    <button className="wb-btn primary" type="submit">{t('保存')}</button>
                    <button className="wb-btn" type="button" onClick={() => { onDictFormChange(null); onDictEditCodeChange(null); onDictErrorChange(null) }}>{t('取消')}</button>
                  </div>
                </form>
              )}
              {dictError !== null && <div style={{ color: '#E74C3C', fontSize: 12, margin: '6px 0' }}>{dictError}</div>}
              <div className="wb-list wb-scroll-area">
                {dictOf(dictKind).map((entry) => {
                  const color = String(entry.config.color ?? '#8a9aa8')
                  return (
                    <div key={entry.code} className="wb-row" style={{ cursor: 'default', opacity: entry.active === 0 ? 0.55 : undefined, flexWrap: 'wrap' }}>
                      <span className="wb-chip" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, fontWeight: 600 }}>{entry.name}</span>
                      <code style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>{entry.code}</code>
                      {entry.builtin === 1 && <span className="wb-chip" style={{ background: 'color-mix(in srgb, #888 12%, transparent)', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))' }}>{t('内置')}</span>}
                      <span style={{ flex: 1 }} />
                      <button className="wb-btn" onClick={() => { onDictEditCodeChange(entry.code); onDictFormChange({ name: entry.name, code: entry.code, color, sortOrder: entry.sortOrder ?? 50 }); onDictErrorChange(null) }}>{t('编辑')}</button>
                      <button className="wb-btn" onClick={() => void onToggleDictionary(entry)}>{entry.active === 1 ? t('停用') : t('启用')}</button>
                      {entry.builtin !== 1 && (
                        <button className="wb-btn" style={{ color: '#E74C3C', borderColor: 'color-mix(in srgb, #E74C3C 45%, transparent)' }} onClick={() => void onDeleteDictionary(entry)}>{t('删除')}</button>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </Modal>
  )
}

function splitCodes(value: string): string[] {
  return value.split(',').map((part) => part.trim().toLowerCase()).filter((part) => part !== '')
}
