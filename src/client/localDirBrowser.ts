/**
 * 「浏览本地目录」的**共享接线件**（2026-10-01，批次2 #2/W03）。
 *
 * 知识库的「AI 总结本地文档」弹窗与工作区的「浏览…」弹窗用的是**同一个**
 * 后端路由 `GET /api/workbench/knowledge/list-local-dir`，也共用同一个组件
 * `components/LocalDocModal.tsx`（只是 `mode` 不同）。这个文件把两处**请求形状**收成一处：
 * 路由路径、`?path=` 的编码、以及「此电脑」（盘符列表）哨兵的处理。
 *
 * 为什么必须收：哨兵值一旦两处各写一份，就出现"弹窗 A 能上到盘符列表、弹窗 B 卡在 C 盘"
 * （历史上正是这个 bug：盘符根把 `parent` 记成 `null`，于是「上级」在 `C:\` 变灰、再也出不去）。
 *
 * 不 import React、不碰 DOM —— 可被 `node --test` 直接测（URL 拼接是纯字符串运算）。
 */

/**
 * 「根」视图的哨兵：客户端拿到它就知道"往上走 = 回到盘符/根列表"，而不是某个真实目录。
 * **与后端 `src/api/localDirRoute.ts#ROOTS_PARENT` 必须同值**（那边是权威定义，这里是可读文本）。
 */
export const ROOTS_PARENT = '\u0000roots'

/** 该路由的固定前缀（唯一实现，别在调用点再拼字符串）。 */
export const LOCAL_DIR_ROUTE = '/api/workbench/knowledge/list-local-dir'

/**
 * 拼出「列目录」请求的 URL。
 *
 * - `undefined` / `''` → **不带 `path`**（后端默认落在用户主目录，保留原行为）；
 * - `ROOTS_PARENT` → 显式传哨兵（看盘符列表）；
 * - 其余 → `?path=<encodeURIComponent>`。
 */
export function localDirRequestUrl(path?: string | null): string {
  if (path === undefined || path === null || path === '') return LOCAL_DIR_ROUTE
  return `${LOCAL_DIR_ROUTE}?path=${encodeURIComponent(path)}`
}
