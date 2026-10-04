/**
 * D17 / P6-1：**导航域（Navigation）的唯一所有者**。
 *
 * 拆分前它是 `WorkbenchApp` 体内的第一个 state（原 `src/client/index.tsx:206`
 * `const [view, setView] = useState<WorkbenchView>('today')`）。
 *
 * ## 为什么只有一项 state 也要单独成域
 * `view` 是本组件里**唯一**决定"左栏渲染哪张视图"的开关（`today`/`calendar`/`list`/
 * `knowledge`/`ideas` 五路分支都以它为条件），被 JSX 读 ~40 次、被 `openTaskById()`
 * （跨域组合：导航 + 加载详情）写 1 次，还被三个域 hook 以 `activeView` 读走
 * （`useKnowledge` / `useIdeas` / `useTaskListModel`）。按设计 §4「同一语义只有一个所有者」，
 * 它必须有明确归属，不能因为"只有一项"就留在装配层 —— ADR-0008 的结构硬门把
 * "`WorkbenchApp` 体内直接 `useState(` = 0"写成了会失败的断言。
 *
 * ## 刻意不做的事
 * - **不做导航历史 / 不做深链**：`setView` 只有"切到哪张视图"一种语义，没有第二套。
 * - **不合并 `openTaskById`**：设计 §4.1 第 148 行明确"会导航 + 会加载详情"是**跨域组合**，
 *   归装配层 —— 本 hook 只交出 `setView`，由入口把它与任务数据域的 `loadTaskDetail` 拼起来。
 * - **不碰 `selected`**：切视图不重置任何选中项（D15 起今日与日历共用同一份日期面板状态）。
 * - **不做函数式更新**：入口 6 个调用点全是直接赋值（`setView('list')` /
 *   `setView('today')` …），所以这里的签名就是"赋值"，不照抄 `Dispatch<SetStateAction<…>>`
 *   （否则接口宣称了一种不存在的能力）。
 */
import { useState } from 'react'
import type { WorkbenchView } from '../app/contracts.js'

export interface UseWorkbenchNavigationActions {
  /** 切到某张视图（入口唯一的 6 个调用点全部是直接赋值）。 */
  setView: (next: WorkbenchView) => void
}

export interface UseWorkbenchNavigationResult {
  /** 当前视图：左栏分支条件 + 三个域 hook 的 `activeView`。 */
  view: WorkbenchView
  actions: UseWorkbenchNavigationActions
}

export function useWorkbenchNavigation(): UseWorkbenchNavigationResult {
  // 初值逐字保留（`'today'`）：`test/taskDetailWiring.test.mjs` 与
  // `scripts/lib/d17-p3b-exit-check.py` 的正向断言锚的就是这一行原文，只是 owner 换成了本文件。
  const [view, setView] = useState<WorkbenchView>('today')
  return { view, actions: { setView } }
}
