/**
 * 客户端纯格式化/标签工具（从 index.tsx 抽出，行为不变）。
 * 无副作用、无状态：时间格式化、日期边界、草稿/角色/事件的中文标签。
 */
export const folderForText = (text: string): string => {
  const cleaned = text.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').slice(0, 24).trim()
  return cleaned === '' ? '未命名任务' : cleaned
}
export const clientFileLinkToPath = (link: string): string => {
  const trimmed = link.trim()
  if (!/^file:/i.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed)
    let pathname = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1)
    return pathname
  } catch {
    return trimmed
  }
}
export const localDateString = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const toLocalInput = (iso: string | null): string => {
  if (iso === null) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
export const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 草稿类型的中文短标签（待处理入口用）。 */
export const DRAFT_KIND_LABELS: Record<string, string> = {
  task: '任务草稿',
  subtask_plan: '子任务提案',
  daily_plan: '今日计划提案',
  report: '报告草稿',
  knowledge: '知识条目',
  idea_cluster: '点子王提案',
  idea_tasks: '点子落地提案',
  completion: '完成验收申请',
  review: '复盘草稿',
}
export const draftKindLabel = (kindCode: string): string => DRAFT_KIND_LABELS[kindCode] ?? '草稿'

export const ROLE_LABELS: Record<string, string> = {
  clarify: '澄清会话',
  consult: '协助会话',
  breakdown: '拆解会话',
  execute: '执行会话',
  review: '复盘会话',
  plan: 'AI 计划会话',
  report: '日报/周报会话',
  idea_association: '点子关联会话',
  idea_brainstorm: '点子头脑风暴',
  knowledge_doc: '知识总结会话',
}
export const roleLabel = (code: string): string => ROLE_LABELS[code] ?? code
export const EVENT_LABELS: Record<string, string> = {
  created: '创建任务',
  updated: '更新任务',
  status_changed: '更新状态',
  completed: '任务完成',
  accepted: '用户验收通过',
  rejected: '用户驳回',
  archived: '归档任务',
  restored: '恢复任务',
  cancelled: '取消任务',
  memory_added: '写入任务记忆',
  session_linked: '关联 AI 会话',
  session_created: '创建 AI 会话',
  plan_saved: '保存计划',
  report_saved: '保存报告',
  review_added: '新增复盘',
  subtask_added: '新增子任务',
  reminder_added: '添加提醒',
  reminder_fired: '触发提醒',
  knowledge_added: '新增知识',
  idea_added: '新增点子',
  idea_cluster_added: '新增点子王',
}
export const eventLabel = (code: string): string => EVENT_LABELS[code] ?? code
export const EVENT_ICONS: Record<string, string> = {
  created: '📝',
  updated: '🔄',
  status_changed: '🔀',
  completed: '✅',
  accepted: '✔️',
  rejected: '❌',
  archived: '📦',
  restored: '♻️',
  cancelled: '⛔',
  memory_added: '💾',
  session_linked: '🔗',
  session_created: '🔗',
  plan_saved: '📅',
  report_saved: '📊',
  review_added: '🧠',
  subtask_added: '🌱',
  reminder_added: '⏰',
  reminder_fired: '🔔',
  knowledge_added: '📚',
  idea_added: '💡',
  idea_cluster_added: '👑',
}
export const eventIcon = (code: string): string => EVENT_ICONS[code] ?? '•'
export const shortId = (id: string): string => id.length > 12 ? `${id.slice(0, 8)}…` : id
export const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
export const startOfDay = (d: Date): Date => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
export const startOfWeek = (d: Date): Date => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x }
