/**
 * 客户端内联的构建标识（plan.md V04-B / AX-V07）。
 *
 * ## 为什么是 `globalThis` 而不是 health 接口
 *
 * 验收要回答的问题是"**浏览器里跑的到底是不是本次装盘的那个 bundle**"。
 * 如果这个值是从 `GET /api/workbench/health` 读来的，它只能证明"host 是新的"，
 * 证明不了"浏览器加载的 client bundle 是新的"（客户端 bundle 在宿主启动时进内存 Map，
 * 不刷新页面就还是旧代码 —— 团队记忆 01M2A05QDRNWQ8J7YEFVJY8T78）。
 *
 * 所以 `tsdown.config.ts` 在 bundle **最外层**写一句
 * `globalThis.__WORKBENCH_BUILD_ID__ = "<本次构建的 buildId>"`，这里只负责把它读出来。
 * 根节点上的 `data-workbench-build-id` 用这个值，验收链再和包 manifest / host health 三方比对。
 *
 * 读不到时返回 `'unknown'` —— 链会因为三方不匹配而明确失败，比编一个假值安全。
 */

export const BUILD_ID_GLOBAL_KEY = '__WORKBENCH_BUILD_ID__'

/** 纯函数：从任意作用域对象读内联标识（测试可以塞假作用域）。 */
export function readInlineBuildId(scope: unknown = globalThis): string {
  if (scope === null || scope === undefined) return 'unknown'
  const value = (scope as Record<string, unknown>)[BUILD_ID_GLOBAL_KEY]
  return typeof value === 'string' && value !== '' ? value : 'unknown'
}

/** 本次 bundle 的构建标识（模块加载时读一次）。 */
export const WORKBENCH_BUILD_ID: string = readInlineBuildId()
