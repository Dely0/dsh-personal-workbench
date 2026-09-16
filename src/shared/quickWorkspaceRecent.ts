/**
 * 「快速录入 → 最近手动选择的工作区」（`settings.quickWorkspaceRecent`）的**共享口径**。
 *
 * ## 为什么单独放 `shared/`
 *
 * 这个列表从 v1.15.2 起是**快速录入默认工作区的唯一来源**（`decideQuickWorkspaceDefault`），
 * 所以"列表里有什么、什么顺序"必须只有一处实现：
 *
 * - 客户端要**合并**（用户刚用过某个目录 → 置顶去重）与**删除**（"不再记住这个目录"）；
 * - 服务端要**归一化**存储（不能相信客户端提交的任意数组：手改 meta、旧版本客户端都可能塞脏值）。
 *
 * 两处各写一套去重/截断逻辑就是本项目最大的 bug 类别（"同一个语义被独立计算多次"），
 * 所以判定放 `shared/`、前后端共用（同 `shared/quickAttachments.ts` 的做法）。
 *
 * ## 语义（2026-09-16 变更，务必读完）
 *
 * `POST /api/workbench/settings { quickWorkspaceRecent }` 从**合并**改为**整表替换**
 * （服务端只做归一化）。理由：这个列表一旦成为默认值来源，就必须能**删**——
 * 合并语义下删除是不可能的（`[...incoming, ...current]` 会把删掉的又并回来），
 * 于是用户改了「默认工作区」也永远回不去（fresh-eyes 审查 F1）。
 *
 * 客户端可用（不 import 任何 node: 模块）。
 */

/** 「最近手动选择」的条数上限（前后端同一个数字）。 */
export const QUICK_WORKSPACE_RECENT_LIMIT = 5

/**
 * 一个路径用于**比较**的键：去首尾空白、去掉结尾分隔符、统一分隔符、小写。
 *
 * 只看大小写/分隔符差异的两条路径算同一个（Windows 上 `D:\Code` 与 `d:/code/` 是一回事）。
 */
export function recentWorkspaceKey(value: string): string {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 归一化：去掉空白项、按比较键去重（保留最靠前的那条原文）、截断到上限。
 *
 * 服务端在写库前必须调用它（不信任提交内容）；客户端用它保证"提交的整表"形状干净。
 */
export function normalizeRecentWorkspaces(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of input) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    const key = recentWorkspaceKey(trimmed)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= QUICK_WORKSPACE_RECENT_LIMIT) break
  }
  return out
}

/**
 * 把一个刚用过的工作区并进列表：最新的排最前、去重、截断。
 *
 * ⚠️ 这是"置顶"语义：同一个目录**再次被选中时要挪到第一位**（否则它当不上默认值，
 * 用户会看到"我明明刚选过这个却没被预填"）。修前实现在"已存在"时直接 return，
 * 是本次修复把它从"候选列表排序不精确"升级成了"默认值不对"（审查 F5）。
 */
export function mergeRecentWorkspaces(current: unknown, used: string): string[] {
  const trimmed = String(used ?? '').trim()
  if (trimmed === '') return normalizeRecentWorkspaces(current)
  return normalizeRecentWorkspaces([trimmed, ...(Array.isArray(current) ? current : [])])
}

/** 把某个路径从列表里去掉（"不再记住这个目录"）——删空后默认值就回到系统默认工作区。 */
export function forgetRecentWorkspace(current: unknown, path: string): string[] {
  const target = recentWorkspaceKey(String(path ?? ''))
  const items = Array.isArray(current) ? current : []
  return normalizeRecentWorkspaces(items.filter((item) => recentWorkspaceKey(String(item)) !== target))
}

/** 两个列表是否**逐项等价**（按比较键、顺序敏感）——决定要不要真的发那次写请求。 */
export function sameRecentWorkspaces(left: unknown, right: unknown): boolean {
  const a = (Array.isArray(left) ? left : []).map((item) => recentWorkspaceKey(String(item)))
  const b = (Array.isArray(right) ? right : []).map((item) => recentWorkspaceKey(String(item)))
  return a.length === b.length && a.every((key, index) => key === b[index])
}
