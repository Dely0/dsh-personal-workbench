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
import { Modal } from './Modal.js'

export interface DictionaryLike {
  kind: string
  code: string
  name: string
  config: Record<string, unknown>
  builtin?: number
  active?: number
  sortOrder?: number
}

type Section = 'general' | 'notify' | 'wechat' | 'dict'
type DictKind = 'type' | 'status' | 'priority' | 'idea_kind'

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
  { key: 'notify', label: '通知' },
  { key: 'wechat', label: '微信提醒' },
  { key: 'dict', label: '字典管理' },
]

const DICT_KINDS: Array<{ key: DictKind; label: string }> = [
  { key: 'type', label: '任务类型' },
  { key: 'status', label: '状态' },
  { key: 'priority', label: '优先级' },
  { key: 'idea_kind', label: '点子类型' },
]

export interface SettingsModalProps {
  settings: WorkbenchSettings
  onSettingsChange: (next: WorkbenchSettings) => void
  onSaveSettings: () => Promise<void>
  saving: boolean

  notifyPermission: NotificationPermission | 'unsupported'
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
    onClose,
  } = props

  const dictOf = (kind: string): DictionaryLike[] => dicts.filter((entry) => entry.kind === kind)
  const targets: ReminderBotOption['targets'] = useMemo(
    () => reminderOptions?.bots.find((bot) => bot.botId === reminderChannel?.botId)?.targets ?? [],
    [reminderOptions, reminderChannel?.botId],
  )

  return (
    <Modal
      title="工作台设置"
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <span className="wb-foot-note">设置保存在本机工作台数据库，不影响 DSH 其他配置</span>
          <button className="wb-btn" onClick={onClose}>取消</button>
          <button className="wb-btn primary" disabled={saving} onClick={() => void onSaveSettings()}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </>
      )}
    >
      <div className="wb-settings">
        <nav className="wb-settings-nav" aria-label="设置分区">
          {SECTIONS.map((item) => (
            <button key={item.key} className={section === item.key ? 'on' : ''} onClick={() => setSection(item.key)}>
              {item.label}
              {item.key === 'wechat' && reminderChannel?.queued !== undefined && reminderChannel.queued > 0 && (
                <span className="dot" title={`队列中 ${reminderChannel.queued} 条待发`} />
              )}
            </button>
          ))}
        </nav>

        <div className="wb-settings-pane">
          {section === 'general' && (
            <section>
              <h5>AI 会话工作区</h5>
              <div className="wb-field">
                <span>默认工作区（任务未指定时使用）</span>
                <input
                  value={settings.defaultWorkspace}
                  onChange={(e) => onSettingsChange({ ...settings, defaultWorkspace: e.target.value })}
                  placeholder="例如 D:\Code\AI-Workspace"
                />
              </div>
              <label className="wb-switch-row">
                <input
                  type="checkbox"
                  checked={settings.autoCreateTypeFolders}
                  onChange={(e) => onSettingsChange({ ...settings, autoCreateTypeFolders: e.target.checked })}
                />
                <span>
                  自动为每个任务创建独立文件夹
                  <span className="wb-switch-desc">关闭后所有任务共用默认工作区；父任务设了工作区时，未单独设置子任务会跟随父任务。</span>
                </span>
              </label>
            </section>
          )}

          {section === 'notify' && (
            <section>
              <h5>桌面通知</h5>
              <label className="wb-switch-row">
                <input
                  type="checkbox"
                  checked={settings.desktopNotify}
                  onChange={(e) => onSettingsChange({ ...settings, desktopNotify: e.target.checked })}
                />
                <span>
                  任务到期时弹系统通知
                  <span className="wb-switch-desc">需要浏览器授权；DSH 页面保持打开（可最小化）即可收到。</span>
                </span>
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                {notifyPermission === 'unsupported' && <span className="wb-hint">当前浏览器不支持系统通知，将使用页内提示</span>}
                {notifyPermission === 'granted' && <span style={{ fontSize: 12, color: '#2E9B7B' }}>浏览器通知已授权</span>}
                {notifyPermission !== 'granted' && notifyPermission !== 'unsupported' && (
                  <button className="wb-btn" onClick={onRequestNotifyPermission}>授权浏览器通知</button>
                )}
                {notifyPermission === 'granted' && <button className="wb-btn" onClick={onSendTestNotification}>发送测试通知</button>}
              </div>
            </section>
          )}

          {section === 'wechat' && (
            <section>
              <h5>微信提醒</h5>
              {reminderChannel === null || reminderPolicy === null ? (
                <p className="wb-hint">正在读取通道状态…</p>
              ) : (
                <>
                  <label className="wb-switch-row">
                    <input
                      type="checkbox"
                      checked={reminderPolicy.enabled}
                      onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, enabled: e.target.checked })}
                    />
                    <span>
                      启用微信提醒
                      <span className="wb-switch-desc">关闭时行为与原来完全一致（仅页面横幅 + 桌面通知）。</span>
                    </span>
                  </label>

                  {!reminderChannel.installed && (
                    <div className="wb-banner reminder" style={{ margin: '10px 0' }}>
                      <h4>未检测到 dsh-im</h4>
                      <div style={{ fontSize: 12.5 }}>
                        微信推送不可用，提醒会回落到页面横幅与桌面通知。安装命令：
                        <code style={{ display: 'inline-block', marginTop: 4 }}>pnpm add -g @xmanrui/dsh-im</code>
                      </div>
                    </div>
                  )}
                  {reminderChannel.installed && !reminderChannel.configured && (
                    <div className="wb-banner completion" style={{ margin: '10px 0' }}>
                      <h4>还没有可用的投递目标</h4>
                      <div style={{ fontSize: 12.5 }}>请先在微信里给机器人发一条消息（建立 context_token），再点「刷新目标」。</div>
                    </div>
                  )}
                  {reminderChannel.circuitOpen && (
                    <div className="wb-banner error" style={{ margin: '10px 0' }}>
                      <h4>微信通道被 iLink 限流</h4>
                      <div style={{ fontSize: 12.5 }}>
                        {reminderChannel.circuitUntil === null ? '' : `${new Date(reminderChannel.circuitUntil).toLocaleTimeString('zh-CN', { hour12: false })} 前不发送。`}
                        让手机微信给机器人发一条消息即可立即恢复。
                      </div>
                    </div>
                  )}

                  {reminderChannel.installed && (
                    <div className="wb-field-grid" style={{ marginTop: 10 }}>
                      <label className="wb-field">
                        <span>机器人</span>
                        <select
                          value={reminderChannel.botId ?? ''}
                          onChange={(e) => {
                            const botId = e.target.value === '' ? null : e.target.value
                            const first = reminderOptions?.bots.find((bot) => bot.botId === botId)?.targets[0]?.targetId ?? null
                            onSelectTarget(botId, first)
                          }}
                        >
                          <option value="">选择机器人…</option>
                          {(reminderOptions?.bots ?? []).map((bot) => <option key={bot.botId} value={bot.botId}>{bot.label}</option>)}
                        </select>
                      </label>
                      <label className="wb-field">
                        <span>投递目标</span>
                        <select
                          value={reminderChannel.targetId ?? ''}
                          onChange={(e) => onSelectTarget(reminderChannel.botId, e.target.value === '' ? null : e.target.value)}
                        >
                          <option value="">选择投递目标…</option>
                          {targets.map((target) => <option key={target.targetId} value={target.targetId}>{target.label}</option>)}
                        </select>
                      </label>
                      <div className="wb-field">
                        <span>&nbsp;</span>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button className="wb-btn primary" disabled={reminderBusy} onClick={() => void onSaveTarget()}>保存目标</button>
                          <button className="wb-btn" disabled={reminderBusy} onClick={() => void onRefreshChannel()}>刷新目标</button>
                          <button className="wb-btn" disabled={reminderBusy || !reminderChannel.configured} onClick={() => void onSendTestMessage()}>发送测试消息</button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="wb-field-grid" style={{ marginTop: 14 }}>
                    <label className="wb-field full">
                      <span>草稿通知类型（推送到微信）</span>
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
                              {option.label}
                            </label>
                          )
                        })}
                      </div>
                    </label>
                    <label className="wb-field">
                      <span>即时推送分级</span>
                      <input
                        value={reminderPolicy.immediatePriorities.join(',')}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, immediatePriorities: splitCodes(e.target.value) })}
                        placeholder="p0,p1"
                      />
                    </label>
                    <label className="wb-field">
                      <span>汇总分级</span>
                      <input
                        value={reminderPolicy.digestPriorities.join(',')}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, digestPriorities: splitCodes(e.target.value) })}
                        placeholder="p2,p3"
                      />
                    </label>
                    <label className="wb-field">
                      <span>每日汇总时间</span>
                      <input value={reminderPolicy.digestAt} onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, digestAt: e.target.value })} placeholder="09:00" />
                    </label>
                    <label className="wb-field">
                      <span>静默时段开始</span>
                      <input
                        value={reminderPolicy.quietHours?.start ?? ''}
                        onChange={(e) => onReminderPolicyChange({
                          ...reminderPolicy,
                          quietHours: e.target.value === '' ? null : { start: e.target.value, end: reminderPolicy.quietHours?.end ?? '08:00' },
                        })}
                        placeholder="22:00（留空=不静默）"
                      />
                    </label>
                    <label className="wb-field">
                      <span>静默时段结束</span>
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
                      <span>穿透静默的优先级</span>
                      <input
                        value={reminderPolicy.quietHoursBypassPriorities.join(',')}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, quietHoursBypassPriorities: splitCodes(e.target.value) })}
                        placeholder="p0"
                      />
                    </label>
                    <label className="wb-field">
                      <span>每小时上限</span>
                      <input type="number" min={1} max={60} value={reminderPolicy.hourlyLimit}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, hourlyLimit: Number(e.target.value) })} />
                    </label>
                    <label className="wb-field">
                      <span>每日上限</span>
                      <input type="number" min={1} max={500} value={reminderPolicy.dailyLimit}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, dailyLimit: Number(e.target.value) })} />
                    </label>
                    <label className="wb-field">
                      <span>补发回溯（小时）</span>
                      <input type="number" min={1} max={168} value={reminderPolicy.catchupWindowHours}
                        onChange={(e) => onReminderPolicyChange({ ...reminderPolicy, catchupWindowHours: Number(e.target.value) })} />
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
                    <button className="wb-btn primary" disabled={reminderBusy} onClick={() => void onSaveReminderPolicy()}>保存提醒策略</button>
                    <span className="wb-hint" style={{ margin: 0 }}>关掉浏览器后仍会推送；未安装 dsh-im 时自动回落</span>
                  </div>
                </>
              )}
            </section>
          )}

          {section === 'dict' && (
            <section>
              <h5>字典管理</h5>
              <div className="wb-segmented wb-sub-segmented" style={{ marginBottom: 10 }}>
                {DICT_KINDS.map((item) => (
                  <button
                    key={item.key}
                    className={`wb-seg ${dictKind === item.key ? 'on' : ''}`}
                    onClick={() => { onDictKindChange(item.key); onDictFormChange(null); onDictEditCodeChange(null); onDictErrorChange(null) }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
                <span className="wb-hint" style={{ margin: 0 }}>默认项受保护，不可删除；可编辑名称/颜色/排序/停用</span>
                <button
                  className="wb-btn primary"
                  onClick={() => { onDictEditCodeChange(null); onDictFormChange({ name: '', code: '', color: '#4F86F7', sortOrder: 50 }); onDictErrorChange(null) }}
                >
                  新增
                </button>
              </div>
              {dictForm !== null && (
                <form className="wb-form" style={{ marginBottom: 10 }} onSubmit={(e) => void onSaveDictionary(e)}>
                  <label>名称<input value={dictForm.name} onChange={(e) => onDictFormChange({ ...dictForm, name: e.target.value })} placeholder="例如：客户沟通" /></label>
                  <label>
                    code{dictEditCode !== null ? <span style={{ fontWeight: 400, fontSize: 11 }}>（不可修改）</span> : null}
                    <input value={dictEditCode ?? dictForm.code} disabled={dictEditCode !== null}
                      onChange={(e) => onDictFormChange({ ...dictForm, code: e.target.value })} placeholder="client_comm（小写英文/下划线/数字）" />
                  </label>
                  <label>颜色<input type="color" value={dictForm.color} onChange={(e) => onDictFormChange({ ...dictForm, color: e.target.value })} /></label>
                  <label>排序<input type="number" value={dictForm.sortOrder} onChange={(e) => onDictFormChange({ ...dictForm, sortOrder: Number(e.target.value) })} /></label>
                  <div className="full" style={{ display: 'flex', gap: 8 }}>
                    <button className="wb-btn primary" type="submit">保存</button>
                    <button className="wb-btn" type="button" onClick={() => { onDictFormChange(null); onDictEditCodeChange(null); onDictErrorChange(null) }}>取消</button>
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
                      {entry.builtin === 1 && <span className="wb-chip" style={{ background: 'color-mix(in srgb, #888 12%, transparent)', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))' }}>内置</span>}
                      <span style={{ flex: 1 }} />
                      <button className="wb-btn" onClick={() => { onDictEditCodeChange(entry.code); onDictFormChange({ name: entry.name, code: entry.code, color, sortOrder: entry.sortOrder ?? 50 }); onDictErrorChange(null) }}>编辑</button>
                      <button className="wb-btn" onClick={() => void onToggleDictionary(entry)}>{entry.active === 1 ? '停用' : '启用'}</button>
                      {entry.builtin !== 1 && (
                        <button className="wb-btn" style={{ color: '#E74C3C', borderColor: 'color-mix(in srgb, #E74C3C 45%, transparent)' }} onClick={() => void onDeleteDictionary(entry)}>删除</button>
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
