/**
 * 三级角色库的**根解析**（D11/D12）。
 *
 * 从 `api/routes/personas.ts` 挪到角色域：`/personas/bind` 路由、`workbench_load_persona` /
 * `workbench_read_persona_resource` 工具都要用同一套根（设置项 + 包内资产 + 用户主目录），
 * 而"服务层 import 路由层"是反向依赖。挪过来之后**路由只做 HTTP**，根与解析归属角色域。
 *
 * 生产调用点不传覆盖项：三级根由 `personaExternalDir` 设置 + `assets/personas` +
 * `homedir()` 算出来。覆盖项**只给测试**（`homedir()` 不认环境变量，没有它，
 * "用户库覆盖内置"这条覆盖顺序就只能用替身测，而不是真实文件）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { readPersonaSettings } from '../db/repo/personas.js'
import { defaultBuiltinPersonaRoot, defaultUserPersonaRoot, type PersonaLibraryOptions, type PersonaRootOverrides } from './library.js'

export interface PersonaRootOptions extends PersonaRootOverrides {
  /** 判"大小写不敏感"的平台（测试可传 `win32`）；缺省 `process.platform`。 */
  platform?: string
  /** 用户主目录（**只给测试用**的注入点）。 */
  home?: string
}

/** 三级根的解析（**唯一一处**）：显式覆盖 > 用户主目录 > 包内资产；外部根读设置项。 */
export function resolvePersonaRoots(
  db: DatabaseSync,
  options: PersonaRootOptions = {},
): { builtinDir: string; userDir: string; externalDir: string } {
  return {
    builtinDir: options.builtinDir ?? defaultBuiltinPersonaRoot(),
    userDir: options.userDir ?? defaultUserPersonaRoot(options.home ?? homedir()),
    externalDir: readPersonaSettings(db, options.platform).personaExternalDir,
  }
}

/** 供路由与工具**共用**：把 `resolvePersona`/`discoverPersonas` 的入参拼一处，避免两处各拼一遍。 */
export function personaLookupOptions(db: DatabaseSync, options: PersonaRootOptions = {}): PersonaLibraryOptions {
  const settings = readPersonaSettings(db, options.platform)
  return {
    ...resolvePersonaRoots(db, options),
    favorites: settings.personaFavorites,
    disabledIds: settings.personaDisabledIds,
    platform: options.platform,
  }
}
