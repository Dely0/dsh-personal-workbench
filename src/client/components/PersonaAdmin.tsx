/**
 * 角色库管理（收藏 / 停用）—— **从角色选择器搬过来的**（2026-10-01 用户要求）。
 *
 * ## 为什么搬到这里
 *
 * 用户原话："点击『更多角色』后出现的页面我理解更多的是配置功能（收藏、停用等），
 * 所以这个页面可以移动到设置页面去。"
 *
 * 这个判断是对的：选择器回答的是"这次会话用哪个角色"，而"哪些角色值得收藏 / 要不要停用"
 * 是**对角色库的配置**，两件事混在一个下拉里，结果是选择器越长越像设置页。
 *
 * ## 状态所有权（不许第二份）
 *
 * - 列表：`GET /api/workbench/personas`（服务端是唯一权威源）；
 * - 收藏/停用：`POST /api/workbench/settings`。
 *
 * ⚠️ **不许把 `personaFavorites` / `personaDisabledIds` 当本地草稿改**：
 * 那两个字段在设置页是"跟着整份 settings 一起保存"的，而这里要**立刻生效且立刻重读** ——
 * 若走本地草稿，用户点完☆看到的是本地状态，一旦没点"保存设置"就全是假的。
 * 所以这里每次改动都**先读一次服务端现值**，用它算 patch（`personaFlagPatch`，
 * 与选择器同一处口径），POST 回去，再**重读列表**把服务端的事实显示出来。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WorkbenchSettings } from '../../shared/contracts.js'
import { api } from '../api.js'
import { personaFlagPatch, personaPickerList, personaSourceLabel, groupPersonas } from '../personaPicker.js'
import type { PersonaSummary } from '../../shared/persona.js'
import { Icon } from './Icon.js'

interface PersonaListPayload {
  ok: boolean
  personas: PersonaSummary[]
}

export function PersonaAdmin({ saving }: { saving: boolean }): JSX.Element {
  const [personas, setPersonas] = useState<PersonaSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState('')
  const [query, setQuery] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await api<PersonaListPayload>('/api/workbench/personas')
      setPersonas(res.personas ?? [])
      setProblem('')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const favoriteCount = useMemo(() => personas.filter((persona) => persona.favorite).length, [personas])
  const disabledCount = useMemo(() => personas.filter((persona) => persona.enabled === false).length, [personas])
  const groups = useMemo(() => groupPersonas(personaPickerList(personas, query)), [personas, query])

  const toggleFlag = async (action: 'toggle-favorite' | 'toggle-disabled', persona: PersonaSummary): Promise<void> => {
    if (busyId !== '' || saving) return
    setBusyId(persona.id)
    setNotice('')
    try {
      /** 现值一律**现读服务端**（不拿本地副本算 patch —— 见文件头那段）。 */
      const current = await api<{ ok: boolean; settings: WorkbenchSettings }>('/api/workbench/settings')
      const patch = personaFlagPatch({
        personaFavorites: current.settings.personaFavorites ?? [],
        personaDisabledIds: current.settings.personaDisabledIds ?? [],
      }, action, persona.id)
      const res = await api<{ ok: boolean; settings: WorkbenchSettings }>('/api/workbench/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      /** 用服务端**回写后**的值做提示（不是本地推断）。 */
      const nowFavorite = (res.settings.personaFavorites ?? []).includes(persona.id)
      const nowDisabled = (res.settings.personaDisabledIds ?? []).includes(persona.id)
      setNotice(action === 'toggle-favorite'
        ? `${nowFavorite ? '已收藏' : '已取消收藏'}「${persona.name}」`
        : `${nowDisabled ? '已停用' : '已启用'}「${persona.name}」`)
      await load()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="wb-persona-admin">
      <div className="wb-persona-toolbar">
        <input
          className="wb-skill-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`搜索角色名 / 简介 / 分组（共 ${personas.length} 个）`}
        />
        <span className="wb-persona-source">★ 已收藏 {favoriteCount}｜停用 {disabledCount}</span>
      </div>

      {problem !== '' && (
        <div className="wb-skill-problem" role="status">
          <span>角色库暂不可用 —— {problem}</span>
          <button type="button" className="wb-btn" onClick={() => void load()}><Icon name="refresh" size={12} />重试</button>
        </div>
      )}
      {notice !== '' && <div className="wb-hint">{notice}</div>}

      <div className="wb-persona-admin-list">
        {loading && <div className="wb-persona-note">读取角色库…</div>}
        {!loading && groups.length === 0 && (
          <div className="wb-persona-note">{personas.length === 0 ? '角色库为空（内置库没打包进来？）' : '没有匹配的角色'}</div>
        )}
        {/**
          * 分组渲染：**把分组标题做成章节级**（2026-10-01 用户报"各种层级分布都不太明显，全挤在一起"）。
          *
          * 用户那句话是**可量化的**：改之前 分组名 11px/400/灰、角色名 12.5px/400/主色、
          * 描述 11px/400/灰、来源 10.5px/400/灰 —— 三类信息**同一个灰、同一个字重**，
          * 只有 0.5px 的字号差，视觉上必然糊成一片。
          *
          * 现在分三层：
          *   ① 分组标题 14px/600 主色 + 上分割线 + 计数（章节）
          *   ② 角色名 12.5px/600 主色（一行）→ 描述 11.5px/次色（另起一行）
          *   ③ 来源｜分组 10.5px/最淡色（第三行）
          * 名称与描述**不再挤在同一行** —— 那是"扫读时没有落点"的直接原因。
          */}
        {!loading && groups.map((group) => (
          <div className="wb-persona-group" key={group.group}>
            <div className="wb-persona-group-name">
              {group.group}
              <span className="wb-persona-group-count">{group.items.length} 个角色</span>
            </div>
            {group.items.map((persona) => (
              <div className={`wb-persona-row${persona.enabled ? '' : ' off'}`} key={`${persona.sourceKey}:${persona.id}`}>
                <div className="wb-persona-info">
                  <div className="wb-persona-name" title={persona.id}>
                    {persona.emoji === '' ? '' : `${persona.emoji} `}{persona.name}
                    {persona.favorite && <span className="wb-persona-star" title="已收藏">★</span>}
                    {!persona.enabled && <span className="wb-persona-off-tag">已停用</span>}
                  </div>
                  <div className="wb-persona-desc">{persona.description === '' ? '（无简介）' : persona.description}</div>
                  {/**
                    * 来源标签**只留来源**，不再重复分组名：
                    * 分组名已经在上面那个章节标题里了，行内再写一遍是同一事实的第二处展示
                    * （与容量区那段被删掉的"已排…"提示是同一个道理）。
                    */}
                  <div className="wb-persona-source">{personaSourceLabel(persona.source)}</div>
                </div>
                <div className="wb-persona-actions">
                  <button
                    type="button"
                    className={`wb-persona-flag${persona.favorite ? ' on' : ''}`}
                    disabled={busyId !== '' || saving}
                    onClick={() => void toggleFlag('toggle-favorite', persona)}
                    title={persona.favorite ? '取消收藏' : '收藏（选择器里可用「只看收藏」筛出来）'}
                  >
                    {persona.favorite ? '★ 已收藏' : '☆ 收藏'}
                  </button>
                  <button
                    type="button"
                    className="wb-persona-flag"
                    disabled={busyId !== '' || saving}
                    onClick={() => void toggleFlag('toggle-disabled', persona)}
                    title={persona.enabled ? '停用：不再出现在可选列表里（这里仍列出来，可随时启用回来）' : '重新启用'}
                  >
                    {persona.enabled ? '停用' : '启用'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {/**
        * 第三段长解释也收进折叠块（用户要求"各种解释性段落到处都是"）。
        * 要点不丢：停用为什么还列出来 + 正文按需读取（不进提示词）。
        */}
      <details className="wb-notes">
        <summary>说明（停用为何仍列出 / 正文何时加载）</summary>
        <div className="wb-notes-body">
          <p><b>停用的角色仍会列在这里</b>（否则就启用不回来了），只是不能在选择器中选中。</p>
          <p>角色正文与资源由 <code>workbench_load_persona</code> / <code>workbench_read_persona_resource</code> 按需读取，<b>不预先塞进提示词</b>。</p>
        </div>
      </details>
    </div>
  )
}
