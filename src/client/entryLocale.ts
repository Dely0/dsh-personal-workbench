/**
 * 入口文案的语言（issue #12 的入口侧延伸）。
 *
 * ## 为什么入口要单独有一份解析入口，而不是直接用 `useI18n()`
 *
 * 侧栏面板行与会话标题栏的「工作台」按钮都由**宿主槽位**渲染，它们在
 * `I18nProvider` 之外（`useI18n()` 在这里只会拿到 zh-CN 回落）；而侧栏那一行的
 * `label` 是**注册时**交给宿主的字符串，宿主不会因为我们改了设置而重渲染它。
 *
 * 所以入口需要一份「上次已知的语言」：
 * - **权威源仍是服务端的 `settings.uiLocale`**（db meta）。本模块不拥有它，
 *   只镜像一份给入口用；
 * - `auto` 一律走 `resolveLocale()` —— 与面板内部**同一个函数**，不另造判据；
 * - localStorage 只是缓存（与知识库筛选缓存同一类）：让**下次装载**时入口文案
 *   在注册那一刻就是对的。读不到（隐私模式）退回 `auto` + 浏览器语言。
 *
 * ## 已声明的边界（口径，不是缺陷）
 * 面板**内部**文案切语言是即时的（React 重渲染）；入口文案在**下次装载**时跟上
 * —— 侧栏那一行的 `label` 只在注册时给一次。
 *
 * ## 可测性
 * 真正的判定在 `entryTextFor(uiLocale, navigatorLanguage, key, params)` —— 纯函数、
 * 不碰 `localStorage` / `navigator`，`node --test` 直接可测（见 test/entryLocale.test.mjs）。
 * 浏览器侧的读取只是给它喂参数的薄壳。
 */
import {
  normalizeUiLocale, resolveLocale, translate, type ResolvedLocale, type UiLocale,
} from '../shared/i18n.js'

/** 入口语言缓存的 localStorage 键（读不到就退回默认，不抛错、不降级成另一套 UI）。 */
export const ENTRY_LOCALE_STORAGE_KEY = 'dsh-personal-workbench.entry-ui-locale'

/**
 * 入口文案的**唯一判定**：给定设置值与浏览器语言，返回该语言下的入口文案。
 *
 * 与面板内部共用 `resolveLocale` / `translate`：`auto` 的解析方向、未翻译回中文
 * 这两条口径不许在入口这一侧再实现一遍。
 */
export function entryTextFor(
  uiLocale: UiLocale | undefined,
  navigatorLanguage: string,
  key: string,
  params?: Record<string, string | number>,
): string {
  return translate(resolveLocale(uiLocale, navigatorLanguage), key, params)
}

/** 入口当前应使用的语言（同样只经 `resolveLocale`，不另造判据）。 */
export function entryLocaleFor(uiLocale: UiLocale | undefined, navigatorLanguage: string): ResolvedLocale {
  return resolveLocale(uiLocale, navigatorLanguage)
}

function entryStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/** 浏览器语言；拿不到就当空串 → `resolveLocale` 回中文，与旧行为一致。 */
function entryNavigatorLanguage(): string {
  try { return typeof navigator === 'undefined' ? '' : String(navigator.language ?? '') } catch { return '' }
}

/** 缓存里存过的设置值（脏值按 `auto` 处理：入口不许按一个不存在的语言渲染）。 */
function cachedEntryUiLocale(): UiLocale {
  const store = entryStorage()
  if (store === null) return 'auto'
  try { return normalizeUiLocale(store.getItem(ENTRY_LOCALE_STORAGE_KEY)) } catch { return 'auto' }
}

/** 入口文案（浏览器侧便捷入口 = `entryTextFor` + 缓存值 + 浏览器语言）。 */
export function entryText(key: string, params?: Record<string, string | number>): string {
  return entryTextFor(cachedEntryUiLocale(), entryNavigatorLanguage(), key, params)
}

/**
 * 把权威值镜像给入口。
 *
 * 调用点只有两处，都在设置域（`useWorkbenchSettings`）：装载设置后、保存设置后。
 * 先归一再落缓存 —— 脏值不落，否则入口会按一个不存在的语言渲染。
 */
export function cacheEntryUiLocale(uiLocale: UiLocale | undefined): void {
  const store = entryStorage()
  if (store === null) return
  try { store.setItem(ENTRY_LOCALE_STORAGE_KEY, normalizeUiLocale(uiLocale)) } catch { /* 隐私模式：本次装载退回 auto */ }
}
