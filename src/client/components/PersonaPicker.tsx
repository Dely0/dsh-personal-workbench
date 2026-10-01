/**
 * 角色选择器（D13-B / requirements §6.3、AX-R07）。
 *
 * ## 一个组件、两个入口
 *
 * "快速录入"弹窗与"共享提示词"弹窗**用同一个组件、同一套选择逻辑**
 * （需求 §6.3）。所以本组件只吃 props、把选择回调出去，自己**不判**"要不要新建会话" ——
 * 那是纯函数 `personaPicker.ts#decidePersonaReuse` 的事。
 *
 * ## 形态对齐「加载 Skill」（2026-10-01 按用户带截图的反馈重做）
 *
 * 用户原话："把这个角色页面功能做的和它下面的加载 Skill 页面一样就行。" 具体三件事：
 *
 * 1. **搜索框常驻**（旧形态是点「更多角色」才出现，用户截图证明了这一点）；
 * 2. **全部角色就铺在同一页**靠滚动看，**删掉「更多角色」按钮**与那段长提示；
 * 3. **收藏 / 停用这两个动作搬去设置页** —— 它们是配置，不是选择。
 *    选择器里只留一个「只看收藏」**筛选**按钮（用户要求：角色多的时候快速收敛）。
 *
 * ## 状态所有权
 *
 * 角色列表的**唯一权威源是服务端**（`/personas` 摘要）。本组件不缓存第二份，
 * 也不写设置 —— 收藏/停用由「设置 → 角色库（专家人格）」写，写完重读。
 *
 * ## 不遮挡技能栏
 *
 * 整块是普通文档流里的一个 `<div>`（不用绝对定位、不加遮罩），滚动区是自己的
 * `max-height + overflow:auto`，所以它下面那块技能选择器仍在文档流里正常展开。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PersonaDiagnostic, PersonaSummary } from '../../shared/persona.js'
import { api } from '../api.js'
import {
  INHERIT_PERSONA, NO_PERSONA, groupPersonas, personaPickerList,
  personaSelectionFor, personaSelectionLabel, personaSourceLabel,
  type PersonaSelection,
} from '../personaPicker.js'
import { Icon } from './Icon.js'

export interface PersonaPickerProps {
  value: PersonaSelection
  onChange: (next: PersonaSelection) => void
  disabled?: boolean
  /** 读列表失败时的可读中文原因（父级负责显示，不静默）。 */
  onError?: (message: string) => void
  onNotice?: (message: string) => void
}

interface PersonaListPayload {
  ok: boolean
  personas: PersonaSummary[]
  diagnostics: PersonaDiagnostic[]
}

export function PersonaPicker({ value, onChange, disabled = false, onError }: PersonaPickerProps): React.ReactNode {
  const [personas, setPersonas] = useState<PersonaSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState('')
  const [query, setQuery] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await api<PersonaListPayload>('/api/workbench/personas')
      setPersonas(res.personas ?? [])
      setProblem('')
    } catch (error) {
      /** 拿不到角色库必须**可见**（一个空下拉框会让用户以为"本机没有角色"）。 */
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const favoriteCount = useMemo(() => personas.filter((persona) => persona.favorite).length, [personas])
  const enabledCount = useMemo(() => personas.filter((persona) => persona.enabled).length, [personas])
  const disabledCount = personas.length - enabledCount
  /**
   * 列表口径**只有一处**：`personaPickerList()`（纯函数，有单测）。
   * 组件不自己写第二份 filter —— 本项目为"同一语义多处实现"付过 15 小时的代价。
   */
  const visible = useMemo(() => personaPickerList(personas, query, { favoritesOnly }), [personas, query, favoritesOnly])
  const groups = useMemo(() => groupPersonas(visible), [visible])
  /** 当前选中的角色：即使被筛掉也要让头部说得出选了谁（头部本来就读 value）。 */
  const selectedMissing = value.mode === 'persona'
    && visible.some((persona) => persona.id === value.personaId) === false

  const pickClass = (on: boolean, extra = ''): string => `wb-persona-item${on ? ' on' : ''}${extra === '' ? '' : ` ${extra}`}`

  return (
    <div className="wb-persona-picker">
      <div className="wb-persona-head">
        <span><Icon name="ai" size={13} /> 角色（专家人格）</span>
        <span className="wb-persona-current">{personaSelectionLabel(value, personas)}</span>
      </div>

      {problem !== '' && (
        <div className="wb-skill-problem" role="status">
          <span><Icon name="ai" size={13} /> 角色库暂不可用 —— {problem}</span>
          <button type="button" className="wb-btn" onClick={() => void load()}><Icon name="refresh" size={12} />重试</button>
        </div>
      )}

      {/* 搜索常驻（与「加载 Skill」同形）：过滤全部角色，不做分页/截断 */}
      <div className="wb-persona-toolbar">
        <input
          className="wb-skill-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`搜索角色名 / 简介 / 分组 / 工作模式（共 ${personas.length} 个）`}
        />
        <button
          type="button"
          className={`wb-btn${favoritesOnly ? ' primary' : ''}`}
          onClick={() => setFavoritesOnly((prev) => !prev)}
          title={favoriteCount === 0
            ? '还没有收藏角色 —— 可以在「设置 → 角色库」里收藏'
            : '只看已收藏的角色'}
        >
          {favoritesOnly ? '★ 只看收藏' : '☆ 只看收藏'}
        </button>
      </div>

      <div className="wb-persona-list">
        <button
          type="button"
          className={pickClass(value.mode === 'inherit')}
          disabled={disabled}
          onClick={() => onChange(INHERIT_PERSONA)}
        >
          <span className="wb-persona-name">未指定（沿用该会话原有角色）</span>
          <span className="wb-persona-desc">复用型会话继续用原来的角色；新会话等于无角色</span>
        </button>
        <button
          type="button"
          className={pickClass(value.mode === 'none')}
          disabled={disabled}
          onClick={() => onChange(NO_PERSONA)}
        >
          <span className="wb-persona-name">无角色</span>
          <span className="wb-persona-desc">明确不带人格（与"复用会话原有角色"不同：那会新建会话）</span>
        </button>

        {loading && <div className="wb-skill-hint">读取角色库…</div>}
        {!loading && groups.length === 0 && (
          <div className="wb-skill-hint">
            {personas.length === 0
              ? '角色库为空（内置库没打包进来？）。不影响本会话继续使用。'
              : favoritesOnly && favoriteCount === 0
                ? '还没有收藏角色 —— 在「设置 → 角色库（专家人格）」里点☆收藏，收藏后这里就能筛出来。'
                : '没有匹配的角色'}
          </div>
        )}
        {!loading && selectedMissing && (
          <div className="wb-skill-hint">当前选中的角色不在筛选结果里（改一下搜索或关掉「只看收藏」就能看到它）。</div>
        )}
        {!loading && groups.map((group) => (
          <div className="wb-persona-group" key={group.group}>
            <div className="wb-persona-group-name">
              {group.group}
              <span className="wb-persona-group-count">{group.items.length} 个</span>
            </div>
            {group.items.map((persona) => (
              <button
                type="button"
                key={`${persona.sourceKey}:${persona.id}`}
                className={pickClass(value.mode === 'persona' && value.personaId === persona.id && value.sourceKey === persona.sourceKey, persona.enabled ? '' : 'off')}
                disabled={disabled || persona.enabled === false}
                onClick={() => onChange(personaSelectionFor(persona.id, persona.sourceKey))}
                title={persona.enabled
                  ? `${persona.id}｜${personaSourceLabel(persona.source)}${persona.favorite ? '｜已收藏' : ''}`
                  : `${persona.id}（已停用，需先在设置里启用）`}
              >
                <span className="wb-persona-name">{persona.emoji === '' ? '' : `${persona.emoji} `}{persona.name}{persona.favorite ? ' ★' : ''}{persona.enabled ? '' : '（已停用）'}</span>
                <span className="wb-persona-desc">{persona.description === '' ? '（无简介）' : persona.description}</span>
                {/**
                  * 行内来源**不再重复分组名**（2026-10-01）：分组名已经在上面那个章节标题里了，
                  * 同一屏里写两遍是冗余，而且会让行内文字更容易挤成一团（用户抱怨的正是"挤"）。
                  */}
                <span className="wb-persona-source">{personaSourceLabel(persona.source)}{persona.mode === '' ? '' : `｜${persona.mode}`}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="wb-persona-foot">
        共 {personas.length} 个角色（当前显示 {visible.length} 个；启用 {enabledCount}{disabledCount > 0 ? ` / 停用 ${disabledCount}` : ''}）
        · 收藏与停用在「设置 → 角色库」里改 · 角色正文由 AI 按需加载，不写进提示词
      </div>
    </div>
  )
}
