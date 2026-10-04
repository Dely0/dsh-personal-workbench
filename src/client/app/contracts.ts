/**
 * D17 装配层类型契约（设计 §3 指定的落点）。
 *
 * 这里**只放跨域共享的类型**，并且只用类型：不许 import React、DOM 或任何域实现 ——
 * 否则 hook 与视图之间会绕出一个反向依赖环（设计 §3「类型契约不反向引用 hook 返回类型」）。
 *
 * 两个类型都是**从入口搬过来的、拆分前内联在 `useState` 里的**联合/对象类型：
 * 搬出来是为了让 hook、视图与入口共用同一份声明，而不是各写一份形状相同的匿名类型。
 */

/** 左侧主视图（拆分前是 `index.tsx` 里 `useState` 的内联联合类型，逐字保留）。 */
export type WorkbenchView = 'today' | 'calendar' | 'list' | 'knowledge' | 'ideas'

/**
 * 「编辑任务」表单草稿（拆分前是入口 `useState<{ … } | null>` 的内联对象类型，逐字保留）。
 *
 * 除 `allDay` 外**全是字符串**：表单字段原样收字符串、校验在提交时做（行为保持，不顺手改成数字）。
 */
export interface TaskEditDraft {
  title: string
  description: string
  typeCode: string
  priorityCode: string
  statusCode: string
  aiPolicyCode: string
  dueLocal: string
  workspacePath: string
  recurrenceCode: string
  parentId: string
  estimatedMinutes: string
  allDay: boolean
}
