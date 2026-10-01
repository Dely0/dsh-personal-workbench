/**
 * 角色库设置（D11 / requirements §6.3）。
 *
 * 三个偏好都存 `meta`（**不开迁移** —— T1 的迁移 19 已是本轮唯一前向迁移，
 * 后续子任务不得再开；这三个字段是用户偏好而非业务数据，与 `quick_workspace_recent`
 * 同一类）。
 *
 * ## 为什么读写必须共用一处
 *
 * 需求的硬要求是 **GET/POST 形状一致**：设置页拿响应回填 state，所以
 * POST 的响应必须是"重新读一遍"的结果（而不是照抄请求体）。历史教训：
 * GET/POST 各写一份字面量时，加字段只加一处 → 表现为"保存后开关自己变回去了"。
 * 这里 `readPersonaSettings` / `writePersonaSettings` 是唯一实现，路由两边都调它。
 *
 * ## 脏值口径
 *
 * 手改过 meta / 旧版本写过别的形状时**不能让设置接口整个打挂**：
 * JSON 解析失败 → 空数组；非数组 → 空数组；元素非字符串/空串 → 丢掉；
 * **按平台口径去重**（Windows 上 ID 大小写不敏感，与库层同一把尺子）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { readMeta, writeMeta } from '../repo/meta.js'
import { dedupeByPersonaKey } from '../../personas/library.js'

export const PERSONA_EXTERNAL_DIR_META_KEY = 'persona_external_dir'
export const PERSONA_FAVORITES_META_KEY = 'persona_favorites'
export const PERSONA_DISABLED_IDS_META_KEY = 'persona_disabled_ids'

export interface PersonaSettings {
  /** 外部角色目录（可配置的一等来源）；空串 = 未配置。 */
  personaExternalDir: string
  /** 收藏的 ID（去重、保序）。 */
  personaFavorites: string[]
  /** 被禁用的 ID（去重、保序）。 */
  personaDisabledIds: string[]
}

/** 读一个 ID 列表型 meta：坏值一律退化成空数组（不让设置接口 500）。 */
export function readPersonaIdList(db: DatabaseSync, key: string, platform: string = process.platform): string[] {
  const raw = readMeta(db, key)
  if (raw === undefined || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) === false) return []
    return dedupeByPersonaKey(parsed as string[], platform)
  } catch {
    return []
  }
}

export function readPersonaSettings(db: DatabaseSync, platform: string = process.platform): PersonaSettings {
  return {
    personaExternalDir: (readMeta(db, PERSONA_EXTERNAL_DIR_META_KEY) ?? '').trim(),
    personaFavorites: readPersonaIdList(db, PERSONA_FAVORITES_META_KEY, platform),
    personaDisabledIds: readPersonaIdList(db, PERSONA_DISABLED_IDS_META_KEY, platform),
  }
}

export interface PersonaSettingsPatch {
  personaExternalDir?: unknown
  personaFavorites?: unknown
  personaDisabledIds?: unknown
}

/**
 * 写三个偏好（**只写传了的字段**，未传保持原值）。
 *
 * @returns 实际发生变化的字段名（供调用方/测试断言"不传就不动"）。
 */
export function writePersonaSettings(db: DatabaseSync, patch: PersonaSettingsPatch, platform: string = process.platform): string[] {
  const changed: string[] = []
  if (typeof patch.personaExternalDir === 'string') {
    writeMeta(db, PERSONA_EXTERNAL_DIR_META_KEY, patch.personaExternalDir.trim())
    changed.push('personaExternalDir')
  }
  if (Array.isArray(patch.personaFavorites)) {
    writeMeta(db, PERSONA_FAVORITES_META_KEY, JSON.stringify(dedupeByPersonaKey(patch.personaFavorites as string[], platform)))
    changed.push('personaFavorites')
  }
  if (Array.isArray(patch.personaDisabledIds)) {
    writeMeta(db, PERSONA_DISABLED_IDS_META_KEY, JSON.stringify(dedupeByPersonaKey(patch.personaDisabledIds as string[], platform)))
    changed.push('personaDisabledIds')
  }
  return changed
}
