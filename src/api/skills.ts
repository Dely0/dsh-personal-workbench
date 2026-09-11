/**
 * DSH 技能目录：host 侧软探测适配层。
 *
 * 数据源是宿主已注册的 skill 注册表服务（`@deepseek-ai/dsh-skill` 的 SkillRegistry，
 * 服务名 `skills`），提供 `list()` 返回排序后的技能摘要、`get(name)` 按需取正文。
 *
 * 设计约束（与 reminder/adapter.ts 的 dshIm 探测同一条底线）：
 * - **绝不静态 inject `skills`** —— 宿主未装该服务时必须静默降级，工作台本体照常加载；
 * - 只消费摘要字段，**不读正文**（正文由模型侧 `skill` 工具按需加载，避免提示词膨胀）；
 * - 本机可能不存在 `~/.dsh/skills` 目录（技能由 skillport / skills-manager 等 provider 提供），
 *   因此**禁止假设文件目录结构**，一切以注册表为准。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 技能摘要（来自注册表 toSummary：不含正文）。 */
export interface SkillCatalogEntry {
  /** kebab-case 技能名，也是注入指令里使用的标识 */
  name: string
  description: string
  whenToUse?: string
  /** 提供者名（如 file-system / runtime / 某插件的 provider 名） */
  provider: string
  /** 来源（文件路径或 provider 自定义标识） */
  source: string
  /** 用户可直接调用（本功能只展示这一类） */
  userInvocable: boolean
  /** 模型可调用 */
  modelInvocable: boolean
}

/** 只依赖我们用到的两个方法，便于单测替身。 */
export interface SkillsService {
  list(options?: Record<string, unknown>): Promise<unknown>
}

/** 从 DSH 上下文软探测技能注册表服务（唯一允许的探测方式）。 */
export function probeSkills(ctx: Context): SkillsService | undefined {
  const service = ctx.get('skills') as Partial<SkillsService> | undefined
  if (service === undefined) return undefined
  if (typeof service.list !== 'function') return undefined
  return service as SkillsService
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 把注册表返回的原始摘要归一化为前端可用的形状。
 *
 * 防御性设计：provider 是第三方代码，字段可能缺失或类型不符；这里逐字段兜底，
 * 坏条目直接丢弃而不是让整个列表 500。调用方若要保真，用 `raw: true` 走原生字段。
 */
export function normalizeSkillEntries(raw: unknown): SkillCatalogEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: SkillCatalogEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const name = readString(record.name)
    if (name === undefined) continue
    const invocation = typeof record.invocation === 'object' && record.invocation !== null
      ? record.invocation as Record<string, unknown>
      : {}
    entries.push({
      name,
      description: readString(record.description) ?? '',
      ...(readString(record.whenToUse) !== undefined ? { whenToUse: readString(record.whenToUse) as string } : {}),
      provider: readString(record.provider) ?? 'unknown',
      source: readString(record.source) ?? '',
      userInvocable: invocation.userInvocable !== false,
      modelInvocable: invocation.modelInvocable !== false,
    })
  }
  return entries
}

/** 只保留用户可直接调用的技能（模型专用技能不在提示词输入区暴露）。 */
export function selectUserInvocable(entries: SkillCatalogEntry[]): SkillCatalogEntry[] {
  return entries.filter((entry) => entry.userInvocable)
}
