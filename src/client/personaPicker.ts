/**
 * 角色选择与**复用分流**的纯逻辑（D13-B / requirements §6.3 的"复用"段落）。
 *
 * ## 这里的判定为什么必须独立成纯模块
 *
 * AX-R08 的核心是一句话：**"不能在 reuseAiSessionId 提前返回时忽略用户选择"**。
 * 那是一个"三种选择 × 两种既有绑定"的决策表，散在 5916 行的组件里必然测不动，
 * 也必然在下一次改动时被漏掉。所以：
 *
 * | 用户选择 | 复用会话已有绑定 | 结果 |
 * |---|---|---|
 * | 未指定（默认） | 有 / 无 | **沿用**（任何情况都不打断既有复用） |
 * | 明确「无角色」 | 无 | 沿用（本来就没角色，没有变化） |
 * | 明确「无角色」 | 有角色 | **新建会话**（旧会话绑定保持不变） |
 * | 明确角色 X | 无 / 是别的角色 | **新建会话**（旧会话绑定保持不变） |
 * | 明确角色 X | 就是 X（同来源） | 沿用 |
 * | 明确角色 X | 同 id 但**来源不同** | **新建会话**（改外部根 = 换身份，见 §6.1） |
 *
 * ## "未指定"这一态为什么必须存在
 *
 * 复用型会话（计划/日报/点子）本来就是"点同一个入口继续编辑"。如果选择器默认值是
 * "无角色"，那么用户什么都不动地点一次"继续编辑今日计划"，就会被判成"明确无角色"、
 * 与既有绑定不同 → **每次都新建会话**，既有复用彻底失效。所以默认值是
 * `{ mode: 'inherit' }`（不指定、沿用该会话原有角色），而"无角色"是一次显式选择。
 */
import { dedupeByPersonaKey, defaultPersonaPlatform, personaCompareKey, type PersonaSummary } from '../shared/persona.js'

/** 入口处的角色选择（三态）。 */
export type PersonaSelection =
  /** 未指定：沿用该会话原有角色；新会话则等于无角色。**默认值**。 */
  | { mode: 'inherit' }
  /** 明确无角色。 */
  | { mode: 'none' }
  /** 明确某个角色（带来源标识：改外部根 = 换身份）。 */
  | { mode: 'persona'; personaId: string; sourceKey: string }

export const INHERIT_PERSONA: PersonaSelection = { mode: 'inherit' }
export const NO_PERSONA: PersonaSelection = { mode: 'none' }

export function personaSelectionFor(personaId: string, sourceKey: string): PersonaSelection {
  return { mode: 'persona', personaId, sourceKey }
}

/** HTTP 读回的既有绑定（`GET /personas/bind` 的 `binding` 字段）。 */
export interface PersonaBindingView {
  personaId: string
  sourceKey: string
  revision: string
}

export type PersonaReuseDecision =
  | { action: 'reuse'; reason: 'inherit' | 'same-role' }
  | { action: 'new-session'; reason: 'role-changed'; notice: string }

/**
 * 复用型会话**还能不能沿用**（唯一判据）。
 *
 * @param selection 用户在入口处的选择
 * @param current 该会话**已有的绑定**（没绑过传 `null`）
 */
export function decidePersonaReuse(
  selection: PersonaSelection,
  current: PersonaBindingView | null,
  platform: string = defaultPersonaPlatform(),
): PersonaReuseDecision {
  if (selection.mode === 'inherit') return { action: 'reuse', reason: 'inherit' }
  const requestedId = selection.mode === 'persona' ? selection.personaId.trim() : ''
  const currentId = current === null ? '' : current.personaId.trim()
  const sameId = personaCompareKey(requestedId, platform) === personaCompareKey(currentId, platform)
  const sameSource = selection.mode !== 'persona' || current === null || selection.sourceKey === current.sourceKey
  if (sameId && sameSource) return { action: 'reuse', reason: 'same-role' }

  const before = currentId === '' ? '未绑定角色' : `已绑定角色「${currentId}」`
  const after = selection.mode === 'persona' ? `选择了角色「${requestedId}」` : '选择了「无角色」'
  const why = sameId ? '（同一个 id，但来源已不同 —— 外部角色目录可能被改过）' : ''
  return {
    action: 'new-session',
    reason: 'role-changed',
    notice: `该会话原本${before}，本次${after}${why}：已**新建会话**承载新的角色选择，旧会话及其角色绑定保持不变。`,
  }
}

/** 新建会话时要**绑定**的角色 id；`''` = 不写绑定（未指定 / 无角色）。 */
export function personaIdToBind(selection: PersonaSelection): string {
  return selection.mode === 'persona' ? selection.personaId : ''
}

/** 选择器的可读标签（纯展示；找不到对应角色时退回 id 并说明"已不在角色库里"）。 */
export function personaSelectionLabel(selection: PersonaSelection, personas: readonly PersonaSummary[] = []): string {
  if (selection.mode === 'inherit') return '未指定（沿用该会话原有角色）'
  if (selection.mode === 'none') return '无角色'
  const found = personas.find((persona) => persona.id === selection.personaId && persona.sourceKey === selection.sourceKey)
    ?? personas.find((persona) => persona.id === selection.personaId)
  if (found === undefined) return `${selection.personaId}（已不在角色库里）`
  return `${found.emoji === '' ? '' : `${found.emoji} `}${found.name}`
}

// ---------------------------------------------------------------------------
// 列表分组 / 搜索 / 收藏与启用（选择器 UI 的唯一实现）
// ---------------------------------------------------------------------------

/**
 * 选择器的**唯一**列表口径（2026-10-01 改）：搜索 + 「只看收藏」筛选。
 *
 * ## 为什么把「常用区 / 更多角色」两个列表合成一个
 *
 * 旧形态折叠态只显示"收藏或内置"的一小撮，点「更多角色」才展开搜索与全量。
 * 用户反馈（带截图）明确：**搜索框应该在原始页面里就有**，全量角色就铺在同一页靠滚动看；
 * 而"收藏 / 停用"那两个按钮本质是**配置**，应该搬到设置页去，不该出现在选择器里。
 *
 * 所以现在只有一份列表：`personaPickerList()`。
 * - 默认：全部角色，**启用在前、停用在后**（停用的仍列出但不可选 —— 否则"停用"没有出口）；
 * - `favoritesOnly`：只留已收藏（这是用户要的"角色很多时快速收敛"）；
 * - `query`：匹配 名称 / 逻辑 ID / 简介 / 分组 / 工作模式。
 */
export function personaPickerList(
  personas: readonly PersonaSummary[],
  query: string,
  options: { favoritesOnly?: boolean } = {},
): PersonaSummary[] {
  const base = personaMoreList(personas, '')
  const scoped = options.favoritesOnly === true ? base.filter((persona) => persona.favorite) : base
  const keyword = query.trim().toLowerCase()
  if (keyword === '') return scoped
  return scoped.filter((persona) =>
    persona.name.toLowerCase().includes(keyword)
    || persona.id.toLowerCase().includes(keyword)
    || persona.description.toLowerCase().includes(keyword)
    || persona.group.toLowerCase().includes(keyword)
    || persona.mode.toLowerCase().includes(keyword))
}

/** 常用区：启用且被收藏；**一个收藏都没有时**退回内置角色（需求 §6.3）。 */
export function personaCommonSection(personas: readonly PersonaSummary[]): { items: PersonaSummary[]; fallback: boolean } {
  const enabled = personas.filter((persona) => persona.enabled)
  const favorites = enabled.filter((persona) => persona.favorite)
  if (favorites.length > 0) return { items: favorites, fallback: false }
  return { items: enabled.filter((persona) => persona.source === 'builtin'), fallback: true }
}

/**
 * 「更多角色」列表：全量角色（启用在前、停用在后）。
 *
 * ⚠️ **停用的角色必须仍然列出来**，否则"停用"就是一个没有出口的动作
 * （用户再也找不到那个角色，也就无法重新启用）—— 这正是"给用户看一个永远用不了的入口"
 * 的反面。停用的角色在这份清单里**不可选中**，但可以点「启用」恢复。
 */
export function personaMoreList(personas: readonly PersonaSummary[], query: string): PersonaSummary[] {
  const ordered = [
    ...personas.filter((persona) => persona.enabled),
    ...personas.filter((persona) => persona.enabled === false),
  ]
  const keyword = query.trim().toLowerCase()
  if (keyword === '') return ordered
  return ordered.filter((persona) =>
    persona.name.toLowerCase().includes(keyword)
    || persona.id.toLowerCase().includes(keyword)
    || persona.description.toLowerCase().includes(keyword)
    || persona.group.toLowerCase().includes(keyword)
    || persona.mode.toLowerCase().includes(keyword))
}

/** 分组（按逻辑 ID 首层目录 / frontmatter group），保序。 */
export function groupPersonas(personas: readonly PersonaSummary[]): Array<{ group: string; items: PersonaSummary[] }> {
  const order: string[] = []
  const byGroup = new Map<string, PersonaSummary[]>()
  for (const persona of personas) {
    const group = persona.group === '' ? '其他' : persona.group
    if (byGroup.has(group) === false) {
      byGroup.set(group, [])
      order.push(group)
    }
    byGroup.get(group)!.push(persona)
  }
  return order.map((group) => ({ group, items: byGroup.get(group)! }))
}

/** 加入/移除一个 id（按平台口径去重、保序、保原值）。 */
export function togglePersonaIdList(list: readonly string[], id: string, platform: string = defaultPersonaPlatform()): string[] {
  const key = personaCompareKey(id, platform)
  const without = list.filter((item) => personaCompareKey(item, platform) !== key)
  if (without.length !== list.length) return without
  return dedupeByPersonaKey([...list, id], platform)
}

/** 设置项里两个 ID 数组的**写入口径**（只提交被改动的那一个数组，另一个保持服务端现值）。 */
export interface PersonaIdSettings { personaFavorites: readonly string[]; personaDisabledIds: readonly string[] }

export function personaFlagPatch(
  current: PersonaIdSettings,
  action: 'toggle-favorite' | 'toggle-disabled',
  id: string,
  platform: string = defaultPersonaPlatform(),
): { personaFavorites?: string[]; personaDisabledIds?: string[] } {
  if (action === 'toggle-favorite') return { personaFavorites: togglePersonaIdList(current.personaFavorites, id, platform) }
  return { personaDisabledIds: togglePersonaIdList(current.personaDisabledIds, id, platform) }
}

/** 来源标签（界面用来区分 内置/用户库/外部目录）。 */
export function personaSourceLabel(source: string): string {
  if (source === 'builtin') return '内置'
  if (source === 'user') return '用户库'
  if (source === 'external') return '外部目录'
  return source
}
