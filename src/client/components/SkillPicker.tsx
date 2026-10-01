/**
 * 技能（Skill）选择器 —— 从 `index.tsx` 的内联 JSX 抽出来（2026-10-01）。
 *
 * ## 为什么必须抽出来
 *
 * 用户反馈："快速录入弹框页面无法选择 Skill。" 而修这个缺陷绕不开一件事：
 * 技能块原来是 `index.tsx` 里**唯一渲染位置**的一大段内联 JSX（提示词弹窗里），
 * 快速录入弹窗（`mode === 'clarify'`）压根没有它。
 *
 * 抽成组件之后，**两个弹窗挂同一个组件**，选择逻辑只有一份 ——
 * 这正是本仓"同一语义不许两处实现"的规矩在 UI 上的落地。
 *
 * ## 三态（v1.15.6 的教训，别退回去）
 *
 * 旧写法是 `skillsAvailable && (…)`：只要那一次拿到空目录就**整块消失**，
 * 用户看到的是"Skill 选择功能没了"，也没有重试入口（宿主某次技能来源发现失败会
 * 静默返回空目录，下一次又自己好了）。所以分成三态：
 * **读取中 / 可选 / 拿不到（原因 + 重试）**。
 *
 * ## 搜索与"拿不到的目录"都是内部 state
 *
 * `query` 是纯展示态，跟选择结果无关，所以留在组件内部；
 * 但 `selected` **由父级持有** —— 它是会话创建时要用的业务状态
 * （`withSkillPromptBlock` 按它拼提示词），不能藏在组件里。
 */
import { useMemo, useState } from 'react'
import type { SkillSummary } from '../../shared/contracts.js'
import { Icon } from './Icon.js'

export interface SkillPickerProps {
  catalog: readonly SkillSummary[]
  /** 读取中 / 已就绪 / 拿不到（原因在 `problem` 里）。 */
  loading: boolean
  available: boolean
  problem: string
  selected: readonly string[]
  onToggle: (name: string) => void
  onRetry: () => void
  disabled?: boolean
}

export function SkillPicker({
  catalog, loading, available, problem, selected, onToggle, onRetry, disabled = false,
}: SkillPickerProps): React.ReactNode {
  const [query, setQuery] = useState('')
  /** 过滤口径：名称 / 描述 / 适用场景，大小写不敏感。 */
  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (keyword === '') return catalog
    return catalog.filter((skill) =>
      skill.name.toLowerCase().includes(keyword)
      || skill.description.toLowerCase().includes(keyword)
      || (skill.whenToUse ?? '').toLowerCase().includes(keyword))
  }, [catalog, query])

  return (
    <div className="wb-skill-picker">
      <div className="wb-skill-picker-head">
        <span><Icon name="skill" size={13} /> 加载 Skill</span>
        <span className="wb-skill-count">
          {loading
            ? '正在读取…'
            : !available
              ? '暂不可用'
              : selected.length > 0 ? `已选 ${selected.length}` : '可选'}
        </span>
      </div>

      {!available && (
        <div className="wb-skill-problem" role="status">
          <span>{loading ? '正在读取技能目录…' : `暂不可用 —— ${problem}`}</span>
          {!loading && (
            <button type="button" className="wb-btn" disabled={disabled} onClick={onRetry}>
              <Icon name="refresh" size={12} />重试
            </button>
          )}
        </div>
      )}

      {available && (
        <>
          <input
            className="wb-skill-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`搜索技能名或描述（共 ${catalog.length} 个）`}
          />
          {selected.length > 0 && (
            <div className="wb-skill-selected">
              {selected.map((name) => (
                <button key={name} type="button" className="wb-skill-tag" disabled={disabled} onClick={() => onToggle(name)} title="点击移除">
                  {name}<span aria-hidden="true">×</span>
                </button>
              ))}
            </div>
          )}
          <div className="wb-skill-list">
            {loading && <div className="wb-skill-hint">加载技能目录…</div>}
            {!loading && visible.length === 0 && (
              <div className="wb-skill-hint">{catalog.length === 0 ? '本机暂无可选技能' : '没有匹配的技能'}</div>
            )}
            {!loading && visible.map((skill) => {
              const checked = selected.includes(skill.name)
              return (
                <label key={skill.name} className={`wb-skill-item${checked ? ' on' : ''}`} title={skill.whenToUse ?? skill.description}>
                  <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(skill.name)} />
                  <span className="wb-skill-body">
                    <span className="wb-skill-name">{skill.name}</span>
                    <span className="wb-skill-desc">{skill.description || '（无描述）'}</span>
                  </span>
                  <span className="wb-skill-provider">{skill.provider}</span>
                </label>
              )
            })}
          </div>
          <div className="wb-skill-foot">选中后会在提示词开头注入"请加载这些技能"的指令，技能正文由 AI 按需加载。</div>
        </>
      )}
    </div>
  )
}
