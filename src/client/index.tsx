/**
 * dsh-workbench client v0.2 — 方案 A 左右分栏：
 *  - 左侧导航区：今日 / 可导航日历(周/月) / 树状列表（默认折叠、记忆展开）
 *  - 右侧详情区：仅显示选中任务；未选中显示占位
 *  - AI 澄清/咨询/拆解统一跳官方会话区；工作台侧边栏显示待确认草稿红点
 */
import { createRoot, type Root } from 'react-dom/client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const PANEL_NAME = 'workbench'
const ACTIVE_ATTR = 'data-dsh-workbench-active'
const PENDING_ATTR = 'data-dsh-workbench-pending'
const VIEW_ATTR = 'data-dsh-workbench-view'
const ENTRY_ATTR = 'data-dsh-workbench-entry'
const SIBLING_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']
const ACTIVATE_EVENT = 'dsh-panel-activate'

const CSS = `
[data-pane='conversation'], [class*='centerCol'] { position: relative; }
[${VIEW_ATTR}] {
  position: absolute; inset: 0; display: none; z-index: 60;
  background: var(--dsw-alias-bg-base, #111); color: var(--dsw-alias-label-primary, #eee);
  font-family: var(--dsw-font-family, system-ui); overflow: hidden;
}
html[${ACTIVE_ATTR}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [${VIEW_ATTR}] { display: block; }
html[${ACTIVE_ATTR}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-pane='conversation'] > :not([${VIEW_ATTR}]),
html[${ACTIVE_ATTR}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [class*='centerCol'] > :not([${VIEW_ATTR}]) { display: none !important; }
[${ENTRY_ATTR}] { position:relative; display:flex; align-items:center; gap:8px; width:100%; height:32px; padding:0 12px; background:transparent; border:none; border-radius:8px; color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:13px; white-space:nowrap; text-align:left; }
[${ENTRY_ATTR}] svg { width:16px; height:16px; flex:none; }
[${ENTRY_ATTR}]:hover { background: var(--dsw-specific-sidebar-nav-item-hover); color: var(--dsw-alias-label-primary); }
[${ENTRY_ATTR}][data-active] { background: var(--dsw-specific-sidebar-nav-item-active); color: var(--dsw-alias-label-primary); font-weight:600; }
html[${PENDING_ATTR}] [${ENTRY_ATTR}]::after { content:''; position:absolute; top:6px; right:10px; width:7px; height:7px; border-radius:50%; background:#e74c3c; }
[data-dsh-frame][data-sidebar-collapsed] [${ENTRY_ATTR}] { justify-content:center; padding:0; width:100%; }
[data-dsh-frame][data-sidebar-collapsed] [${ENTRY_ATTR}] .wb-label { display:none; }
.wb-app { height:100%; display:flex; flex-direction:column; }
.wb-h { flex:none; display:flex; align-items:center; gap:12px; padding:14px 18px; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.02)); }
.wb-title { display:flex; align-items:center; gap:8px; font-size:16px; font-weight:700; letter-spacing:.02em; white-space:nowrap; }
.wb-title svg { width:19px; height:19px; color:var(--dsw-alias-state-business-primary, #8fa8c8); }
.wb-segmented { display:inline-flex; padding:3px; border-radius:10px; background:var(--dsw-alias-bg-base, #111); border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.20)); }
.wb-seg { display:inline-flex; align-items:center; gap:6px; border:none; background:transparent; color:var(--dsw-alias-label-secondary); padding:7px 16px; border-radius:8px; cursor:pointer; font:inherit; font-weight:600; font-size:13.5px; }
.wb-seg svg { width:15px; height:15px; }
.wb-seg.on { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent); color:var(--dsw-alias-label-primary); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 32%, transparent); }
.wb-sub-segmented { padding:2px; }
.wb-sub-segmented .wb-seg { padding:6px 14px; font-size:12.5px; }
.wb-sub-segmented .count { min-width:17px; height:17px; padding:0 5px; border-radius:9px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent); color: var(--dsw-alias-label-primary); font-size:11px; display:inline-flex; align-items:center; justify-content:center; }
.wb-btn { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.26)); background:var(--dsw-alias-bg-layer-1, transparent); color:var(--dsw-alias-label-secondary); border-radius:9px; padding:7px 11px; cursor:pointer; font:inherit; font-size:13px; }
.wb-btn svg { width:15px; height:15px; }
.wb-btn:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 6%, transparent); color:var(--dsw-alias-label-primary); }
.wb-btn.primary { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 16%, transparent); border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 38%, transparent); color:var(--dsw-alias-label-primary); }
.wb-body { flex:1; min-height:0; display:flex; }
.wb-nav { flex:0 0 56%; min-width:0; overflow:auto; padding:16px 18px; box-sizing:border-box; border-right:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }
.wb-detail { flex:1; min-width:0; overflow:auto; padding:16px 18px; box-sizing:border-box; }
.wb-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:12px; }
.wb-stat { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.20)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); border-radius:12px; padding:12px 14px; box-shadow:0 2px 8px rgba(0,0,0,.06); }
.wb-stat b { font-size:20px; }
.wb-stat span { display:block; color:var(--dsw-alias-label-secondary); font-size:12px; }
.wb-card { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.26)); background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); border-radius:14px; padding:16px; margin-bottom:14px; box-shadow:0 6px 18px rgba(0,0,0,.08); }
.wb-card h4 { margin:0 0 10px; padding-bottom:10px; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16)); display:flex; align-items:center; gap:8px; font-size:14px; font-weight:700; }
.wb-card h4 svg { width:16px; height:16px; color:var(--dsw-alias-state-business-primary, #8fa8c8); flex:none; }
.wb-plan { border-left:4px solid var(--dsw-alias-state-business-primary, #8fa8c8); background: linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 9%, transparent), color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 3%, transparent) 45%, var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)) 100%); }
.wb-plan-item { display:flex; align-items:center; margin:7px 0; font-size:13.5px; }
.wb-plan-num { display:inline-flex; width:20px; height:20px; border-radius:50%; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 16%, transparent); border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 40%, transparent); color:var(--dsw-alias-label-primary); font-size:11px; font-weight:700; align-items:center; justify-content:center; margin-right:8px; flex:none; }
.wb-plan-note { color:var(--dsw-alias-label-secondary); margin-left:8px; font-size:12.5px; }
.wb-list { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24)); border-radius:12px; overflow:hidden; background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); }
.wb-row { display:flex; align-items:center; gap:8px; padding:11px 12px; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12)); cursor:pointer; transition:background .12s ease; }
.wb-row:last-child { border-bottom:none; }
.wb-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 5%, transparent); }
.wb-row.selected { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 12%, transparent); box-shadow:inset 3px 0 0 var(--dsw-alias-state-business-primary, #8fa8c8); }
.wb-row-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wb-row-meta { flex:none; display:grid; grid-template-columns:68px 46px 56px 88px; align-items:center; gap:6px; }
.wb-row-meta .wb-chip { display:inline-flex; align-items:center; justify-content:center; width:100%; padding-left:0; padding-right:0; text-align:center; }
.wb-due { text-align:right; color:var(--dsw-alias-label-secondary); font-size:12px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.wb-chip { display:inline-flex; align-items:center; justify-content:center; border-radius:6px; padding:2px 7px; font-size:11px; white-space:nowrap; }
.wb-cal-nav { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.wb-week { display:grid; grid-template-columns:repeat(7,1fr); gap:6px; margin-bottom:10px; }
.wb-day { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); border-radius:12px; min-height:92px; padding:8px; cursor:pointer; transition:border-color .12s ease, background .12s ease; }
.wb-day.today { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 50%, transparent); }
.wb-day.selected { border-color:var(--dsw-alias-state-business-primary, #8fa8c8); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 10%, transparent); }
.wb-month { display:grid; grid-template-columns:repeat(7,1fr); gap:6px; margin-bottom:10px; }
.wb-mday { min-height:52px; border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); border-radius:10px; padding:5px; cursor:pointer; color:var(--dsw-alias-label-secondary); }
.wb-mday.other { opacity:.35; }
.wb-mday.today { border-color: var(--dsw-alias-state-business-primary, #4f8ef7); }
.wb-mday.selected { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 12%, transparent); }
.wb-form { display:grid; grid-template-columns:1fr 1fr; gap:10px; border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12)); border-radius:10px; padding:12px; }
.wb-form-panel { border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 45%, transparent) !important; border-left:4px solid var(--dsw-alias-state-business-primary, #8fa8c8) !important; border-radius:14px !important; padding:16px !important; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 8%, var(--dsw-alias-bg-base, #111)) !important; box-shadow:0 10px 28px rgba(0,0,0,.15); margin-bottom:12px; }
.wb-form-panel h4 { margin:0 0 10px; font-size:15px; color:var(--dsw-alias-label-primary); display:flex; align-items:center; gap:8px; }
.wb-form-panel h4 svg { width:16px; height:16px; color:var(--dsw-alias-state-business-primary, #8fa8c8); }
.wb-btn.lg { padding:8px 16px; font-size:14px; font-weight:600; }
.wb-form label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.wb-form input, .wb-form select, .wb-form textarea { background: var(--dsw-alias-bg-base,#17171a); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.15)); color:inherit; border-radius:8px; padding:7px 10px; font:inherit; }
.wb-form .full { grid-column:1 / -1; }
.wb-empty { padding:24px; text-align:center; color:var(--dsw-alias-label-secondary); }
.wb-banner { border:1px solid rgba(127,127,127,.35); border-left:6px solid #8fa8c8; border-radius:14px; padding:16px; margin:10px 14px 0; box-shadow:0 10px 28px rgba(0,0,0,.18); }
.wb-banner.draft { border-color:rgba(143,168,200,.45); border-left-color:#8fa8c8; background:color-mix(in srgb, #8fa8c8 10%, transparent); }
.wb-banner.review { border-color:rgba(143,168,200,.6); border-left-color:#8fa8c8; background:color-mix(in srgb, #8fa8c8 12%, transparent); }
.wb-banner.completion { border-color:rgba(245,184,61,.55); border-left-color:#f5b83d; background:color-mix(in srgb, #f5b83d 10%, transparent); }
.wb-banner.reminder { border-color:rgba(245,184,61,.5); border-left-color:#f5b83d; background:color-mix(in srgb, #f5b83d 9%, transparent); }
.wb-banner.error { border-color:rgba(231,76,60,.55); border-left-color:#e74c3c; background:color-mix(in srgb, #e74c3c 10%, transparent); }
.wb-banner.notice { border-color:rgba(143,168,200,.5); border-left-color:#8fa8c8; background:color-mix(in srgb, #8fa8c8 8%, transparent); }
.wb-banner h4 { margin:0 0 8px; font-size:15px; }

/* 边界增强：用主题文字色计算边框，亮/暗主题都保证对比；不改卡片底色 */
.wb-app { --wb-border: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 26%, transparent); --wb-border-soft: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 15%, transparent); }
.wb-card, .wb-list, .wb-stat { border-color: var(--wb-border) !important; }
.wb-card h4 { border-bottom-color: var(--wb-border-soft) !important; }
.wb-row { border-bottom-color: var(--wb-border-soft) !important; }
.wb-h { border-bottom-color: var(--wb-border) !important; }
.wb-nav { border-right-color: var(--wb-border-soft) !important; }
.wb-day, .wb-mday, .wb-form { border-color: var(--wb-border-soft) !important; }
`

interface Dict { kind: string; code: string; name: string; config: Record<string, unknown> }
interface Task {
  id: string
  parentId: string | null
  title: string
  description: string
  typeCode: string
  statusCode: string
  priorityCode: string
  aiPolicyCode: string
  dueAt: string | null
  allDay: boolean
  estimatedMinutes: number | null
  source: string
  workspacePath: string | null
  archived: boolean
  extra: Record<string, unknown>
  createdAt: string
  updatedAt: string
  completedAt: string | null
  cancelledAt: string | null
}
interface DailyPlanItemView { taskId: string; order: number; title: string; note: string }
interface DailyPlanView { id: string; planDate: string; summary: string; items: DailyPlanItemView[]; sourceCode: string; sessionId: string | null; createdAt: string; updatedAt: string }
interface TaskReportView { id: string; periodCode: 'day' | 'week'; periodStart: string; title: string; summaryMd: string; stats: Record<string, unknown>; sessionId: string | null; createdAt: string; updatedAt: string }
interface Bootstrap { dictionaries: Dict[]; stats: { overdue: number; todayDue: number; doing: number; total: number }; todayPlan?: DailyPlanView | null }
interface TaskDetail { task: Task; children: Task[]; sessions: Array<Record<string, unknown>>; reminders: Array<{ id: string; taskId: string; offsetMinutes: number; methodCode: string; firedAt: string | null }>; events: Array<Record<string, unknown>>; reviews: Array<Record<string, unknown>> }
interface DraftView { id: string; kindCode: string; statusCode: string; sessionId: string | null; payload: Record<string, unknown> }

interface SessionDriver {
  sessionId: string
  prompt(content: Array<{ type: 'text'; text: string }>, mode: 'queue'): Promise<{ ok?: boolean; error?: unknown }>
  rename(title: string): Promise<unknown>
}
interface WorkbenchRuntime {
  sessions: {
    binding(id: string): { session: SessionDriver } | undefined
    open(id: string): void
  }
  workspaces: {
    list: { getSnapshot(): { items: readonly { workspaceId: string }[]; recentWorkspaceId?: string } }
    connectWorkspace(workspaceId: string): Promise<string>
    create?(input: { path: string }): Promise<{ workspaceId?: string }>
  }
}

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

const folderForText = (text: string): string => {
  const cleaned = text.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').slice(0, 24).trim()
  return cleaned === '' ? '未命名任务' : cleaned
}
const localDateString = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const toLocalInput = (iso: string | null): string => {
  if (iso === null) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
const startOfDay = (d: Date): Date => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const startOfWeek = (d: Date): Date => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x }

function Icon({ name, size = 16 }: { name: string; size?: number }): JSX.Element {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true }
  switch (name) {
    case 'today': return <svg {...common}><circle cx="8" cy="8" r="5.5" /><path d="M8 5.5V8l1.8 1.8" /></svg>
    case 'calendar': return <svg {...common}><rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 6.5h12M5.5 2v3M10.5 2v3" /></svg>
    case 'list': return <svg {...common}><path d="M3 4h10M3 8h10M3 12h7" /></svg>
    case 'sparkles': return <svg {...common}><path d="M8 2l1.4 2.8L12 6 9.8 7.4 8 10 6.2 7.4 4 6l2.6-1.2L8 2zM4 12l.8 1.6L6.5 14l-1.7.4L4 16l-.4-1.6L2 14l1.7-.4L4 12zM12 10l.8 1.6 1.7.4-1.7.4L12 14l-.4-1.6L9.9 12l1.7-.4L12 10z" /></svg>
    case 'plus': return <svg {...common}><path d="M8 2v12M2 8h12" /></svg>
    case 'settings': return <svg {...common}><circle cx="8" cy="8" r="2.5" /><path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.2 4.2l1.4 1.4M10.4 10.4l1.4 1.4M11.8 4.2l-1.4 1.4M5.6 10.4l-1.4 1.4" /></svg>
    case 'back': return <svg {...common}><path d="M10 2L4 8l6 6" /></svg>
    case 'edit': return <svg {...common}><path d="M9.5 2.5L3 9l-.5 4.5L7 13l6.5-6.5-4-4z" /><path d="M8 7l2 2" /></svg>
    case 'report': return <svg {...common}><path d="M3 13V3h8l2 2v8H3z" /><path d="M5 7h4M5 9.5h4" /></svg>
    case 'bell': return <svg {...common}><path d="M8 2a4 4 0 0 0-4 4v3l-1.5 2.5h11L12 9V6a4 4 0 0 0-4-4z" /><path d="M6.5 14a1.8 1.8 0 0 0 3 0" /></svg>
    case 'check': return <svg {...common}><circle cx="8" cy="8" r="6" /><path d="M5.5 8.5l1.8 1.8 3.4-4" /></svg>
    case 'refresh': return <svg {...common}><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5" /></svg>
    case 'trash': return <svg {...common}><path d="M3 4h10M6.5 4V2.5h3V4M5 4l.5 10h5L11 4" /></svg>
    case 'ai': return <svg {...common}><path d="M8 2l1.4 2.8L12 6 9.8 7.4 8 10 6.2 7.4 4 6l2.6-1.2L8 2z" /></svg>
    case 'breakdown': return <svg {...common}><path d="M3 4h4M3 8h4M3 12h4M9.5 4h3.5M9.5 8h3.5M9.5 12h3.5" /></svg>
    case 'subtask': return <svg {...common}><path d="M8 2v12M2 8h12" /></svg>
    case 'archive': return <svg {...common}><rect x="2.5" y="3" width="11" height="3.5" rx="1" /><path d="M4 6.5h8v6H4v-6zM6.5 9h3" /></svg>
    case 'chevron': return <svg {...common}><path d="M6 3l5 5-5 5" /></svg>
    default: return <svg {...common}><circle cx="8" cy="8" r="5" /></svg>
  }
}

function Badge({ dict, code }: { dict: Dict[]; code: string }): JSX.Element {
  const entry = dict.find((d) => d.code === code)
  const color = String(entry?.config.color ?? '#8a9aa8')
  return <span className="wb-chip" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, fontWeight: 600 }}>{entry?.name ?? code}</span>
}

function renderInline(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = []
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]*\))/g
  let last = 0
  for (const match of text.matchAll(regex)) {
    const idx = match.index
    if (idx > last) parts.push(text.slice(last, idx))
    const token = match[0]
    if (token.startsWith('**')) parts.push(<strong key={idx}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) parts.push(<code key={idx} style={{ background: 'rgba(127,127,127,.14)', padding: '0 4px', borderRadius: 4 }}>{token.slice(1, -1)}</code>)
    else {
      const m = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(token)
      if (m !== null) parts.push(<a key={idx} href={m[2]} style={{ color: 'var(--dsw-alias-state-business-primary,#8fa8c8)' }}>{m[1]}</a>)
      else parts.push(token)
    }
    last = idx + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function MarkdownText({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n')
  const blocks: JSX.Element[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let code: string[] = []
  let table: string[] = []
  let key = 0
  const renderListItem = (item: string): JSX.Element => {
    const checkbox = /^\[( |x|X)\]\s+(.*)$/.exec(item)
    if (checkbox !== null) {
      return <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, margin: '2px 0' }}><input type="checkbox" readOnly checked={checkbox[1].toLowerCase() === 'x'} style={{ marginTop: 4 }} />{renderInline(checkbox[2])}</label>
    }
    return <span style={{ margin: '2px 0' }}>{renderInline(item)}</span>
  }
  const flushList = () => {
    if (list === null || list.items.length === 0) { list = null; return }
    if (list.ordered) {
      blocks.push(<ol key={key++} style={{ margin: '4px 0 4px 18px', padding: 0 }}>{list.items.map((item, i) => <li key={i}>{renderListItem(item)}</li>)}</ol>)
    } else {
      blocks.push(<ul key={key++} style={{ margin: '4px 0 4px 18px', padding: 0 }}>{list.items.map((item, i) => <li key={i} style={{ listStyleType: /^\[( |x|X)\]\s/.test(item) ? 'none' : undefined }}>{renderListItem(item)}</li>)}</ul>)
    }
    list = null
  }
  const flushCode = () => {
    if (code.length === 0) return
    blocks.push(<pre key={key++} style={{ background: 'rgba(127,127,127,.10)', padding: 8, borderRadius: 8, overflow: 'auto', fontSize: 12 }}>{code.join('\n')}</pre>)
    code = []
  }
  const flushTable = () => {
    if (table.length === 0) return
    const rows = table
      .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
      .filter((cells) => cells.length > 0 && cells.some((cell) => cell !== ''))
    const isSeparator = (cells: string[]): boolean => cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
    if (rows.length >= 2 && isSeparator(rows[1])) {
      const header = rows[0] ?? []
      const body = rows.slice(2)
      const border = '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))'
      blocks.push(
        <table key={key++} style={{ borderCollapse: 'collapse', width: '100%', margin: '8px 0', fontSize: 13 }}>
          <thead><tr>{header.map((cell, i) => <th key={i} style={{ border, padding: '4px 8px', textAlign: 'left', background: 'rgba(127,127,127,.10)' }}>{renderInline(cell)}</th>)}</tr></thead>
          <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} style={{ border, padding: '4px 8px' }}>{renderInline(cell)}</td>)}</tr>)}</tbody>
        </table>,
      )
    } else {
      blocks.push(<p key={key++} style={{ margin: '4px 0' }}>{renderInline(table.join('<br/>'))}</p>)
    }
    table = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('```')) { flushList(); flushTable(); if (code.length > 0) flushCode(); else code = []; continue }
    if (code.length > 0) { code.push(line); continue }
    if (line.trim().startsWith('|')) { flushList(); table.push(line.trim()); continue }
    if (/^###\s/.test(line)) { flushList(); flushTable(); blocks.push(<h5 key={key++} style={{ margin: '8px 0 4px' }}>{renderInline(line.replace(/^###\s*/, ''))}</h5>); continue }
    if (/^##\s/.test(line)) { flushList(); flushTable(); blocks.push(<h4 key={key++} style={{ margin: '10px 0 4px' }}>{renderInline(line.replace(/^##\s*/, ''))}</h4>); continue }
    if (/^#\s/.test(line)) { flushList(); flushTable(); blocks.push(<h3 key={key++} style={{ margin: '12px 0 4px' }}>{renderInline(line.replace(/^#\s*/, ''))}</h3>); continue }
    const orderedMatch = /^(\d+)[.)]\s+(.*)$/.exec(line)
    const unorderedMatch = /^[-*]\s+(.*)$/.exec(line)
    if (orderedMatch !== null || unorderedMatch !== null) {
      flushTable(); flushCode()
      const ordered = orderedMatch !== null
      const item = ordered ? orderedMatch[2] : unorderedMatch![1]
      if (list === null || list.ordered !== ordered) flushList()
      if (list === null) list = { ordered, items: [] }
      list.items.push(item)
      continue
    }
    if (line.trim() === '') {
      const next = lines.slice(index + 1).find((l) => l.trim() !== '')
      if (table.length > 0 && next !== undefined && next.trim().startsWith('|')) continue
      flushList(); flushTable(); flushCode(); continue
    }
    flushList(); flushTable(); flushCode()
    blocks.push(<p key={key++} style={{ margin: '4px 0' }}>{renderInline(line)}</p>)
  }
  flushList(); flushTable(); flushCode()
  return <div style={{ lineHeight: 1.7, fontSize: 13 }}>{blocks}</div>
}

interface TaskTreeNode { task: Task; children: TaskTreeNode[] }

function filterTaskTree(roots: TaskTreeNode[], keep: (task: Task) => boolean): TaskTreeNode[] {
  const walk = (nodes: TaskTreeNode[]): TaskTreeNode[] => {
    const out: TaskTreeNode[] = []
    for (const node of nodes) {
      const children = walk(node.children)
      if (keep(node.task) || children.length > 0) out.push({ task: node.task, children })
    }
    return out
  }
  return walk(roots)
}

function countTaskTree(roots: TaskTreeNode[]): number {
  return roots.reduce((sum, node) => sum + 1 + countTaskTree(node.children), 0)
}
function buildTaskTree(tasks: Task[], orderOf?: Map<string, number>): TaskTreeNode[] {
  const byParent = new Map<string | null, Task[]>()
  for (const task of tasks) {
    const list = byParent.get(task.parentId) ?? []
    list.push(task)
    byParent.set(task.parentId, list)
  }
  const unlisted = Number.MAX_SAFE_INTEGER
  const walk = (id: string | null): TaskTreeNode[] => (byParent.get(id) ?? [])
    .sort((a, b) => (orderOf?.get(a.id) ?? unlisted) - (orderOf?.get(b.id) ?? unlisted) || a.createdAt.localeCompare(b.createdAt))
    .map((task) => ({ task, children: walk(task.id) }))
  return walk(null)
}

function TaskTreeRows({ roots, depth, expanded, toggle, dicts, onOpen, selectedId }: {
  roots: TaskTreeNode[]; depth: number; expanded: Set<string>; toggle: (id: string) => void
  dicts: Dict[]; onOpen: (task: Task) => void; selectedId?: string
}): JSX.Element {
  return (
    <>
      {roots.map((node) => (
        <div key={node.task.id}>
          <div className={`wb-row ${selectedId === node.task.id ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}>
            <button type="button" className="wb-btn" style={{ padding: '2px 6px', border: 'none' }} onClick={(e) => { e.stopPropagation(); toggle(node.task.id) }}>
              {node.children.length > 0 ? (expanded.has(node.task.id) ? '▼' : '▶') : '·'}
            </button>
            <TaskRow task={node.task} dicts={dicts} onOpen={onOpen} />
          </div>
          {node.children.length > 0 && expanded.has(node.task.id) && (
            <TaskTreeRows roots={node.children} depth={depth + 1} expanded={expanded} toggle={toggle} dicts={dicts} onOpen={onOpen} selectedId={selectedId} />
          )}
        </div>
      ))}
    </>
  )
}

function TaskRow({ task, dicts, onOpen, selected }: { task: Task; dicts: Dict[]; onOpen: (task: Task) => void; selected?: boolean }): JSX.Element {
  const due = task.dueAt === null ? null : new Date(task.dueAt)
  const now = new Date()
  const dueText = task.statusCode === 'done'
    ? (task.dueAt !== null ? `${fmtTime(task.dueAt)}（已完成）` : '已完成')
    : task.statusCode === 'cancelled'
      ? '已取消'
      : due === null
        ? '无截止'
        : Number.isNaN(due.getTime())
          ? fmtTime(task.dueAt!)
          : due.toDateString() === now.toDateString()
            ? `今天 ${fmtTime(task.dueAt!)}`
            : due.getTime() < now.getTime()
              ? `逾期 ${fmtTime(task.dueAt!)}`
              : fmtTime(task.dueAt!)
  return (
    <div className={`wb-row ${selected === true ? 'selected' : ''}`} style={{ flex: 1, minWidth: 0 }} onClick={() => onOpen(task)}>
      <div className="wb-row-title" style={{ fontWeight: 600 }}>{task.title}</div>
      <div className="wb-row-meta">
        <Badge dict={dicts.filter((d) => d.kind === 'type')} code={task.typeCode} />
        <Badge dict={dicts.filter((d) => d.kind === 'priority')} code={task.priorityCode} />
        <Badge dict={dicts.filter((d) => d.kind === 'status')} code={task.statusCode} />
        <span className="wb-due">{dueText}</span>
      </div>
    </div>
  )
}

function DraftBanner({ draft, onDone, runtime }: { draft: DraftView; onDone: () => void; runtime: WorkbenchRuntime }): JSX.Element {
  const subtasks = Array.isArray(draft.payload.subtasks) ? draft.payload.subtasks as Array<{ title?: string }> : []
  const [busy, setBusy] = useState(false)
  const act = async (path: string): Promise<void> => {
    setBusy(true)
    try { await api(path, { method: 'POST' }); onDone() } finally { setBusy(false) }
  }
  if (draft.kindCode === 'report') {
    const summaryMd = String(draft.payload.summaryMd ?? '')
    const title = String(draft.payload.title ?? '')
    const sessionId = typeof draft.sessionId === 'string' && draft.sessionId !== '' ? draft.sessionId : typeof draft.payload.sessionId === 'string' ? draft.payload.sessionId : ''
    return (
      <div className="wb-banner review">
        <h4><Icon name="report" />报告草稿待确认（{String(draft.payload.periodCode === 'week' ? '周报' : '日报')} {String(draft.payload.periodStart ?? '')}）</h4>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
        <div style={{ maxHeight: 260, overflow: 'auto' }}><MarkdownText text={summaryMd} /></div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="wb-btn primary" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/confirm`)}>确认保存报告</button>
          <button className="wb-btn" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/abandon`)}>放弃</button>
          {sessionId !== '' && <button className="wb-btn" onClick={() => { document.documentElement.removeAttribute(ACTIVE_ATTR); runtime.sessions.open(sessionId) }}>回到报告会话</button>}
        </div>
      </div>
    )
  }
  if (draft.kindCode === 'daily_plan') {
    const items = Array.isArray(draft.payload.items) ? draft.payload.items as Array<{ taskId?: string; order?: number; title?: string; note?: string }> : []
    const summary = String(draft.payload.summary ?? '')
    const sessionId = typeof draft.sessionId === 'string' && draft.sessionId !== '' ? draft.sessionId : typeof draft.payload.sessionId === 'string' ? draft.payload.sessionId : ''
    return (
      <div className="wb-banner draft">
        <h4><Icon name="sparkles" />今日计划提案待确认（{String(draft.payload.planDate ?? '')}）</h4>
        {summary !== '' && <div style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 6 }}>{summary}</div>}
        <ol style={{ margin: '4px 0 8px 20px', padding: 0, fontSize: 14, lineHeight: 1.7 }}>
          {items.map((item, i) => <li key={i} style={{ margin: '3px 0' }}><b>{item.title ?? '(未命名任务)'}</b>{item.note !== undefined && item.note !== '' ? <span style={{ color: 'var(--dsw-alias-label-secondary)' }}> — {item.note}</span> : null}</li>)}
        </ol>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wb-btn primary" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/confirm`)}>确认应用排序</button>
          <button className="wb-btn" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/abandon`)}>放弃</button>
          {sessionId !== '' && <button className="wb-btn" onClick={() => { document.documentElement.removeAttribute(ACTIVE_ATTR); runtime.sessions.open(sessionId) }}>回到排序会话</button>}
        </div>
      </div>
    )
  }
  if (draft.kindCode === 'review') {
    const summary = String(draft.payload.summaryMd ?? '')
    const sessionId = typeof draft.payload.sessionId === 'string' ? draft.payload.sessionId : ''
    return (
      <div className="wb-banner review">
        <h4><Icon name="report" />复盘草稿待确认</h4>
        <div style={{ maxHeight: 220, overflow: 'auto' }}><MarkdownText text={summary} /></div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="wb-btn primary" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/confirm`)}>确认写回任务</button>
          <button className="wb-btn" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/abandon`)}>放弃</button>
          {sessionId !== '' && <button className="wb-btn" onClick={() => { document.documentElement.removeAttribute(ACTIVE_ATTR); runtime.sessions.open(sessionId) }}>回到复盘会话</button>}
        </div>
      </div>
    )
  }
  if (draft.kindCode === 'completion') {
    const summary = String(draft.payload.summary ?? '')
    const sessionId = typeof draft.payload.sessionId === 'string' ? draft.payload.sessionId : ''
    return (
      <div className="wb-banner completion">
        <h4><Icon name="check" />执行完成，待你验收</h4>
        <div style={{ fontSize: 13 }}><b>{String(draft.payload.taskId ?? '')}</b></div>
        <div style={{ fontSize: 12, color: '#999', whiteSpace: 'pre-wrap' }}>{summary}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="wb-btn primary" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/confirm`)}>验收通过（标记完成）</button>
          <button className="wb-btn" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/abandon`)}>驳回</button>
          {sessionId !== '' && <button className="wb-btn" onClick={() => { document.documentElement.removeAttribute(ACTIVE_ATTR); runtime.sessions.open(sessionId) }}>回到执行会话</button>}
        </div>
        <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>驳回后请回到执行会话继续修改，AI 可再次提交验收申请。</div>
      </div>
    )
  }
  return (
    <div className="wb-banner draft">
      <h4>{draft.kindCode === 'subtask_plan' ? `待确认：子任务提案（${subtasks.length}）` : '待确认：任务草稿'}</h4>
      {draft.kindCode === 'task'
        ? <div style={{ fontSize: 13 }}><b>{String(draft.payload.title ?? '')}</b> · {String(draft.payload.typeCode ?? '')} · {String(draft.payload.priorityCode ?? '')}</div>
        : <div style={{ fontSize: 12, color: '#999' }}>{subtasks.slice(0, 8).map((t, i) => <div key={i}>• {t.title ?? '(未命名)'}</div>)}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="wb-btn primary" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/confirm`)}>确认入册</button>
        <button className="wb-btn" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/abandon`)}>放弃</button>
      </div>
    </div>
  )
}

function WorkbenchApp({ runtime }: { runtime: WorkbenchRuntime }): JSX.Element {
  const [view, setView] = useState<'today' | 'calendar' | 'list'>('today')
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState<TaskDetail | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [subtaskParent, setSubtaskParent] = useState<Task | null>(null)
  const [editDraft, setEditDraft] = useState<{ title: string; description: string; typeCode: string; priorityCode: string; statusCode: string; aiPolicyCode: string; dueLocal: string; workspacePath: string } | null>(null)
  const [showQuick, setShowQuick] = useState(false)
  const [quickText, setQuickText] = useState('')
  const [pendingDraft, setPendingDraft] = useState<DraftView | null>(null)
  const [reminders, setReminders] = useState<Array<{ reminderId: string; taskId: string; title: string; dueAt: string; methodCode: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [settings, setSettings] = useState<{ defaultWorkspace: string; autoCreateTypeFolders: boolean; desktopNotify: boolean }>({ defaultWorkspace: '', autoCreateTypeFolders: true, desktopNotify: true })
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermission | 'unsupported'>(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  const [showSettings, setShowSettings] = useState(false)
  const [reportSubTab, setReportSubTab] = useState<'day' | 'week'>('day')
  const [currentReport, setCurrentReport] = useState<TaskReportView | null>(null)
  const [reportSession, setReportSession] = useState<{ sessionId: string } | null>(null)
  const [pickedPlan, setPickedPlan] = useState<DailyPlanView | null>(null)
  const [pickedPlanSession, setPickedPlanSession] = useState<{ sessionId: string } | null>(null)
  const [planRefreshKey, setPlanRefreshKey] = useState(0)
  const [reportRefreshKey, setReportRefreshKey] = useState(0)
  const [todayPlanSession, setTodayPlanSession] = useState<{ sessionId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const selectedRef = useRef<string | null>(null)

  const dicts = useMemo(() => bootstrap?.dictionaries ?? [], [bootstrap])
  const dictOf = useCallback((kind: string) => dicts.filter((d) => d.kind === kind), [dicts])

  const refresh = useCallback(async () => {
    const [boot, list] = await Promise.all([api<Bootstrap>('/api/workbench/bootstrap'), api<{ tasks: Task[] }>('/api/workbench/tasks')])
    setBootstrap(boot); setTasks(list.tasks)
    if (selectedRef.current !== null) {
      try {
        const [detail, ev, rv] = await Promise.all([
          api<TaskDetail>(`/api/workbench/tasks/${selectedRef.current}`),
          api<{ events: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${selectedRef.current}/events`).catch(() => ({ events: [] })),
          api<{ reviews: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${selectedRef.current}/reviews`).catch(() => ({ reviews: [] })),
        ])
        setSelected({ ...detail, events: ev.events, reviews: rv.reviews })
      } catch { setSelected(null); selectedRef.current = null }
    }
  }, [])

  useEffect(() => { void refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) }, [refresh])
  useEffect(() => { void api<{ settings: { defaultWorkspace: string; autoCreateTypeFolders: boolean; desktopNotify: boolean } }>('/api/workbench/settings').then((r) => setSettings(r.settings)).catch(() => undefined) }, [])

  const notifiedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const res = await api<{ draft: DraftView | null }>('/api/workbench/drafts')
        if (alive) setPendingDraft(res.draft)
        const r = await api<{ reminders: Array<{ reminderId: string; taskId: string; title: string; dueAt: string; methodCode: string }> }>('/api/workbench/reminders/due')
        if (!alive) return
        setReminders(r.reminders)
        // 系统级桌面提醒：启用且浏览器已授权时，对每个到期提醒发一次系统通知。
        if (settings.desktopNotify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          for (const reminder of r.reminders) {
            if (notifiedRef.current.has(reminder.reminderId)) continue
            notifiedRef.current.add(reminder.reminderId)
            try {
              new Notification(`任务提醒：${reminder.title}`, {
                body: `截止时间：${fmtTime(reminder.dueAt)}`,
                tag: `dsh-workbench:${reminder.reminderId}`,
              })
            } catch { /* 部分浏览器限制通知构造，忽略降级为页内横幅 */ }
          }
        }
      } catch { /* 轮询失败下轮重试 */ }
    }
    void tick()
    const timer = setInterval(() => void tick(), 5000)
    const refreshTimer = setInterval(() => { void refresh().catch(() => undefined) }, 15000)
    return () => { alive = false; clearInterval(timer); clearInterval(refreshTimer) }
  }, [refresh, settings.desktopNotify])

  useEffect(() => { setEditDraft(null); setSubtaskParent(null) }, [selected?.task.id])

  useEffect(() => {
    if (pendingDraft !== null) document.documentElement.setAttribute(PENDING_ATTR, '')
    else document.documentElement.removeAttribute(PENDING_ATTR)
    return () => document.documentElement.removeAttribute(PENDING_ATTR)
  }, [pendingDraft])

  const openTask = (task: Task): void => {
    selectedRef.current = task.id
    void Promise.all([
      api<TaskDetail>(`/api/workbench/tasks/${task.id}`),
      api<{ events: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${task.id}/events`).catch(() => ({ events: [] })),
      api<{ reviews: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${task.id}/reviews`).catch(() => ({ reviews: [] })),
    ]).then(([detail, ev, rv]) => setSelected({ ...detail, events: ev.events, reviews: rv.reviews })).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const patchTask = async (id: string, patch: Record<string, unknown>): Promise<void> => {
    await api(`/api/workbench/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    await refresh()
  }
  const fireReminder = async (reminderId: string): Promise<void> => {
    await api(`/api/workbench/reminders/${reminderId}/fire`, { method: 'POST' })
    setReminders((list) => list.filter((r) => r.reminderId !== reminderId))
  }
  const addTaskReminder = async (offsetMinutes: number): Promise<void> => {
    const taskId = selectedRef.current
    if (taskId === null) return
    try {
      await api(`/api/workbench/tasks/${taskId}/reminders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offsetMinutes, methodCode: 'browser' }) })
      setNotice(offsetMinutes === 0 ? '已添加“准时”提醒' : `已添加“提前 ${offsetMinutes} 分钟”提醒`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const startAISession = async (mode: 'clarify' | 'consult' | 'breakdown' | 'execute' | 'review' | 'plan' | 'report', task: Task | null, text: string, previousSessions: Array<Record<string, unknown>> = []): Promise<void> => {
    if (mode === 'clarify' && text.trim() === '') return
    const planAnchor = mode === 'plan' ? (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : localDateString()) : ''
    setBusy(true); setError(null)
    try {
      // 复用型会话：每日计划 / 日报 / 周报，每个 scope+anchor 只有一个会话。
      if (mode === 'plan' || mode === 'report') {
        const [scopeCode, anchor] = mode === 'plan'
          ? ['daily_plan', planAnchor]
          : text.startsWith('week:') ? ['week_report', text.slice(5)] : ['day_report', text.slice(4)]
        const existing = await api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=${scopeCode}&anchor=${anchor}`)
        if (existing.session !== null) {
          document.documentElement.removeAttribute(ACTIVE_ATTR)
          runtime.sessions.open(existing.session.sessionId)
          return
        }
        if (mode === 'report') {
          // 旧版本生成的报告可能还没有登记会话：直接复用报告里的 session_id。
          const periodCode = text.startsWith('week:') ? 'week' : 'day'
          const rep = await api<{ report: { sessionId?: string | null } | null }>(`/api/workbench/reports/${periodCode}/${anchor}`)
          if (typeof rep.report?.sessionId === 'string' && rep.report.sessionId !== '') {
            document.documentElement.removeAttribute(ACTIVE_ATTR)
            runtime.sessions.open(rep.report.sessionId)
            return
          }
        }
      }
      const ws = runtime.workspaces.list.getSnapshot()
      let workspaceId = ws.recentWorkspaceId ?? ws.items[0]?.workspaceId
      const joinPath = (base: string, folder: string): string => `${base.replace(/[\\/]+$/, '')}\\${folder}`
      let desired = ''
      if (task !== null) {
        desired = task.workspacePath ?? ''
        if (desired === '' && settings.defaultWorkspace !== '' && settings.autoCreateTypeFolders) {
          desired = joinPath(settings.defaultWorkspace, folderForText(task.title))
        }
      } else if (mode === 'clarify' && settings.defaultWorkspace !== '' && settings.autoCreateTypeFolders) {
        desired = joinPath(settings.defaultWorkspace, folderForText(text || '需求澄清'))
      }
      if (desired !== '') {
        try {
          await api('/api/workbench/workspaces/ensure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: desired }) })
          const created = await runtime.workspaces.create?.({ path: desired })
          if (typeof created?.workspaceId === 'string' && created.workspaceId !== '') workspaceId = created.workspaceId
          // 任务没有显式工作区时，把解析出的任务文件夹回写，保证后续会话都进同一文件夹
          if (task !== null && task.workspacePath === null && desired !== '') {
            void api(`/api/workbench/tasks/${task.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspacePath: desired }) }).catch(() => undefined)
          }
        } catch { /* 目录创建/注册失败则回退当前工作区 */ }
      }
      if (workspaceId === undefined) throw new Error('没有可用工作区，请先在 DSH 中打开一个工作区')
      const id = await runtime.workspaces.connectWorkspace(workspaceId)
      const binding = runtime.sessions.binding(id)
      if (binding === undefined) throw new Error('会话绑定未就绪，请稍后重试')
      await binding.session.rename(mode === 'report' ? `${text.startsWith('week:') ? '周报' : '日报'}：${text.split(':')[1] ?? ''}` : mode === 'plan' ? `AI 计划：${planAnchor.slice(5)}` : mode === 'clarify' ? `澄清：${text.slice(0, 24)}` : mode === 'consult' ? `协助：${task?.title.slice(0, 24)}` : mode === 'breakdown' ? `拆解：${task?.title.slice(0, 24)}` : mode === 'review' ? `复盘：${task?.title.slice(0, 24)}` : `执行：${task?.title.slice(0, 24)}`).catch(() => undefined)
      let reportContextText = ''
      if (mode === 'report') {
        const [periodCode, periodStart] = text.split(':')
        const contextRes = await api<{ context: Record<string, unknown> }>(`/api/workbench/reports/context?period_code=${encodeURIComponent(periodCode)}&period_start=${encodeURIComponent(periodStart)}`)
        reportContextText = JSON.stringify(contextRes.context, null, 2)
      }
      const planDayStart = new Date(`${planAnchor}T00:00:00`)
      const planDayEnd = new Date(planDayStart)
      planDayEnd.setDate(planDayEnd.getDate() + 1)
      const planCandidates = tasks
        .filter((t) => t.statusCode !== 'done' && t.statusCode !== 'cancelled')
        .filter((t) => (t.dueAt !== null && Date.parse(t.dueAt) < planDayEnd.getTime()) || (planAnchor === localDateString() && t.dueAt === null))
        .slice(0, 30)
      const planTaskLines = planCandidates
        .map((t, i) => `${i + 1}. [${t.id}] ${t.title} | 优先级 ${t.priorityCode} | 状态 ${t.statusCode} | 截止 ${t.dueAt ?? '无'} | 预计耗时 ${t.estimatedMinutes ?? '未知'} 分钟 | 父任务 ${t.parentId ?? '无'}`)
        .join('\n')
      const planPrompt = `你是“个人工作台”的 AI 计划助手。请为 ${planAnchor}（${'日一二三四五六'[new Date(`${planAnchor}T00:00:00`).getDay()]}）安排执行顺序。\n\n今天：${localDateString()}；当前时间：${new Date().toISOString()}\n\n候选任务（该日期及之前到期、仍未完成的任务${planAnchor === localDateString() ? '；今天额外包含无截止时间的进行中任务' : ''}，最多 30 条）：\n${planTaskLines || '（无候选任务）'}\n\n请综合考虑：优先级（p0 紧急 > p1 高 > p2 普通 > p3 低）、是否已逾期、截止时间、状态（doing/blocked 优先推进）、预计耗时、父子关系与可能的依赖。如果信息不足，可以先问用户 1-2 个关键问题（例如：当天可投入多少小时、哪些必须当天完成）。\n\n然后调用 workbench_propose_daily_plan：\n- plan_date="${planAnchor}"\n- summary：1-3 句排序思路\n- items：扁平顺序数组（1 号最重要），每项 {task_id, order, note}；note 写清为什么排这里或建议时间块\n- 同一父子链上不要同时出现父任务和它下面的子任务；如需排子任务，只排可执行的叶子，并在 note 中说明属于哪个父任务\n- 只提交计划草稿，不要修改任何任务字段，不要执行任务。`
      const prompt = mode === 'report'
        ? `你是“个人工作台”的日报/周报助手。请根据下面 JSON 数据生成一份 Markdown 报告，然后调用 workbench_submit_report。\n\n报告周期：${text.split(':')[0]}（period_start=${text.split(':')[1] ?? ''}）\n数据：\n${reportContextText}\n\n要求：\n- 结构：今日/本周概览 → 已完成 → 进行中/风险 → 明日/下周建议\n- 只依据给定数据，不要编造；数据不足时如实说明\n- title 简洁；summary_md 用 Markdown；stats 可附 {completed, created} 等数字\n- 只提交草稿，不要修改任务，不要执行任务。`
        : mode === 'plan'
        ? planPrompt
        : mode === 'clarify'
        ? `你是“个人工作台”的任务澄清助手。请按 workbench-intake 规范执行。\n\n用户想创建的任务是：\n「${text}」\n\n当前时间：${new Date().toISOString()}\n默认 AI 工作区：${settings.defaultWorkspace || '未设置'}\n\n请先澄清必要信息（一次一个主题，最多5轮）。如果用户对该任务的 AI 会话有指定工作区，请询问具体路径，并在调用 workbench_submit_task 时传入 workspace_path；否则留空使用默认工作区。信息足够后调用 workbench_submit_task 提交结构化任务草稿。不要执行任务本身。`
        : mode === 'consult'
          ? `你是“个人工作台”的任务协助助手。请针对下面这个任务提供咨询、拆解或复盘建议（咨询模式不执行）。\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode} 状态：${task?.statusCode}\n截止：${task?.dueAt ?? '无'}\n\n请先理解任务，再给出建议；如果信息不足，可以一次问一个问题。\n\n重要：如果用户要求把结论/补充信息保存回任务，请调用 workbench_update_task(task_id="${task?.id ?? ''}", description="...") 更新原任务；绝对不要调用 workbench_submit_task 新建任务。`
          : mode === 'breakdown'
            ? `你是“个人工作台”的任务拆解助手。请分析下面这个任务，并调用 workbench_propose_subtasks 提交子任务提案。\n\n父任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode} 截止：${task?.dueAt ?? '无'}\n\n粒度规则：每层 2-6 个、最大深度 3 层、叶子 15-240 分钟且有可验证完成标准；子任务的 type_code/priority_code 默认继承父任务；若任务太小，设置 no_breakdown_needed=true。只提交提案，不要执行。如果用户对提案提出修改意见，请带上上一次工具返回的 draft_id 再次调用 workbench_propose_subtasks 更新同一份提案。`
            : mode === 'review'
              ? `你是“个人工作台”的任务复盘助手。请对下面这个已完成任务做复盘：\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode}\n\n请从“做得好 / 做得不好 / 下次改进”三个角度输出 Markdown，并调用 workbench_submit_review(task_id="${task?.id ?? ''}", summary_md="...", lessons=[{"title":"...","content":"..."}])。`
              : `你是“个人工作台”的任务执行助手。请直接完成下面这个任务，不要反复确认已知信息。\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode}\n截止：${task?.dueAt ?? '无'}\n${previousSessions.length > 0 ? `\n该任务此前已有执行会话：${previousSessions.map((s) => String(s.session_id ?? '')).filter((x) => x !== '').join('、')}\n若这些会话有未完成上下文，请先向用户索取上一会话的总结/未完成事项再继续，不要重复已完成工作。` : ''}\n\n完成后调用 workbench_request_completion(task_id="${task?.id ?? ''}", summary="2-4句完成总结")，等待用户在个人工作台验收；在用户验收通过前，任务不算完成，不要声称已经完成。若任务无法完成，如实说明原因，不要提交验收。`
      if (mode === 'execute') {
        if (task === null) throw new Error('执行模式需要选择一个任务')
        if (task.statusCode === 'done' || task.statusCode === 'cancelled') throw new Error('该任务已完成或已取消，不能再次执行')
        if (task.aiPolicyCode !== 'execute') throw new Error('该任务未开启“可执行”，请先在任务详情中把 AI 策略改为“可执行”')
      }
      if (mode === 'clarify') setShowQuick(false)
      const result = await binding.session.prompt([{ type: 'text', text: prompt }], 'queue')
      if (result.ok === false) throw new Error(result.error !== undefined ? String(result.error) : '发送失败')
      if (mode === 'plan') {
        await api('/api/workbench/ai-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeCode: 'daily_plan', anchor: planAnchor, sessionId: id, workspace: workspaceId }) })
      }
      if (mode === 'report') {
        const [periodCode, periodStart] = text.split(':')
        await api('/api/workbench/ai-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeCode: periodCode === 'week' ? 'week_report' : 'day_report', anchor: periodStart, sessionId: id, workspace: workspaceId }) })
      }
      if (task !== null && mode !== 'clarify') {
        await api(`/api/workbench/tasks/${task.id}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, roleCode: mode }) }).catch(() => undefined)
      }
      document.documentElement.removeAttribute(ACTIVE_ATTR)
      runtime.sessions.open(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const createTask = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const title = String(form.get('title') ?? '').trim()
    if (title === '') return
    const due = String(form.get('due') ?? '')
    await api('/api/workbench/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, description: String(form.get('description') ?? ''), typeCode: String(form.get('type') ?? ''), priorityCode: String(form.get('priority') ?? ''), statusCode: String(form.get('status') ?? 'todo'), workspacePath: String(form.get('workspacePath') ?? '').trim() || null, dueAt: due === '' ? null : new Date(due).toISOString() }) })
    setShowForm(false); await refresh()
  }
  // 今日/日历/列表三棵树：默认全部收起
  const [todayExpanded, setTodayExpanded] = useState<Set<string>>(new Set())
  const [calendarExpanded, setCalendarExpanded] = useState<Set<string>>(new Set())

  // 树展开状态（列表树记住用户展开）
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([])
  const [archivedMode, setArchivedMode] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('dsh.workbench.treeExpanded') ?? '[]') as string[]) } catch { return new Set() }
  })
  useEffect(() => {
    try { localStorage.setItem('dsh.workbench.treeExpanded', JSON.stringify([...expanded])) } catch { /* ignore */ }
  }, [expanded])
  const toggleExpanded = (id: string): void => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const toggleTodayExpanded = (id: string): void => setTodayExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const toggleCalendarExpanded = (id: string): void => setCalendarExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const collapseAll = (): void => { setExpanded(new Set()); setTodayExpanded(new Set()); setCalendarExpanded(new Set()) }

  const now = new Date()
  const todayStart = startOfDay(now)
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1)
  const openTasks = tasks.filter((t) => !['done', 'cancelled'].includes(t.statusCode))
  const openTree = useMemo(() => buildTaskTree(openTasks), [tasks])
  const todayPlan = bootstrap?.todayPlan ?? null
  const todayTree = useMemo(() => {
    if (todayPlan === null || todayPlan.items.length === 0) return openTree
    const order = new Map(todayPlan.items.map((item) => [item.taskId, item.order]))
    return buildTaskTree(openTasks, order)
  }, [tasks, todayPlan])
  const clearTodayPlan = async (): Promise<void> => {
    await api(`/api/workbench/plans/${localDateString()}`, { method: 'DELETE' })
    await refresh()
  }

  // 周/月日历
  const [cursor, setCursor] = useState<Date>(startOfWeek(now))
  const [calMode, setCalMode] = useState<'week' | 'month'>('week')
  const [picked, setPicked] = useState<Date>(todayStart)
  const [dayTab, setDayTab] = useState<'plan' | 'done' | 'report'>('plan')
  const reportAnchor = reportSubTab === 'week' ? localDateString(startOfWeek(picked)) : localDateString(picked)
  const reportScope = reportSubTab === 'week' ? 'week_report' : 'day_report'
  const todayAnchor = localDateString(new Date())
  const thisWeekAnchor = localDateString(startOfWeek(new Date()))
  const reportIsFuture = reportSubTab === 'week' ? reportAnchor > thisWeekAnchor : reportAnchor > todayAnchor

  useEffect(() => {
    if (view !== 'calendar' || dayTab !== 'report' || reportIsFuture) {
      setCurrentReport(null); setReportSession(null)
      return
    }
    void Promise.all([
      api<{ report: TaskReportView | null }>(`/api/workbench/reports/${reportSubTab}/${reportAnchor}`),
      api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=${reportScope}&anchor=${reportAnchor}`),
    ]).then(([rep, sess]) => { setCurrentReport(rep.report); setReportSession(sess.session) }).catch(() => { setCurrentReport(null); setReportSession(null) })
  }, [view, dayTab, reportSubTab, picked, reportIsFuture, reportRefreshKey])

  useEffect(() => {
    void api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=daily_plan&anchor=${todayAnchor}`)
      .then((r) => setTodayPlanSession(r.session))
      .catch(() => setTodayPlanSession(null))
  }, [todayAnchor, bootstrap])

  const pickedAnchor = localDateString(picked)
  useEffect(() => {
    if (view !== 'calendar' || dayTab !== 'plan') {
      setPickedPlan(null); setPickedPlanSession(null)
      return
    }
    void Promise.all([
      api<{ plan: DailyPlanView | null }>(`/api/workbench/plans?date=${pickedAnchor}`),
      api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=daily_plan&anchor=${pickedAnchor}`),
    ]).then(([planRes, sessionRes]) => { setPickedPlan(planRes.plan); setPickedPlanSession(sessionRes.session) }).catch(() => { setPickedPlan(null); setPickedPlanSession(null) })
  }, [view, dayTab, pickedAnchor, planRefreshKey])
  const weekDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(cursor); d.setDate(d.getDate() + i); return d })
  const moveWeek = (delta: number): void => { const d = new Date(cursor); d.setDate(d.getDate() + delta * 7); setCursor(startOfWeek(d)) }
  const monthGrid = (() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const start = startOfWeek(first)
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d })
  })()
  const moveMonth = (delta: number): void => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1))
  const noDueOpen = tasks.filter((t) => t.dueAt === null && t.statusCode !== 'done' && t.statusCode !== 'cancelled')
  const planKeep = (t: Task): boolean => (t.dueAt !== null && sameDay(new Date(t.dueAt), picked) && t.statusCode !== 'cancelled') || (sameDay(picked, now) && noDueOpen.some((x) => x.id === t.id))
  const doneKeep = (t: Task): boolean => t.completedAt !== null && sameDay(new Date(t.completedAt), picked)
  const pickedPlanOrder = useMemo(() => {
    if (pickedPlan === null || pickedPlan.items.length === 0) return undefined
    return new Map(pickedPlan.items.map((item) => [item.taskId, item.order]))
  }, [pickedPlan])
  const pickedPlanTree = useMemo(() => filterTaskTree(buildTaskTree(tasks, pickedPlanOrder), planKeep), [tasks, picked, pickedPlanOrder]) // eslint 语义同 tasks
  const pickedDoneTree = useMemo(() => filterTaskTree(buildTaskTree(tasks), doneKeep), [tasks, picked])

  return (
    <div className="wb-app">
      <div className="wb-h">
        <div className="wb-title"><Icon name="calendar" size={19} />个人工作台</div>
        <div className="wb-segmented">
          <button className={`wb-seg ${view === 'today' ? 'on' : ''}`} onClick={() => setView('today')}><Icon name="today" />今日</button>
          <button className={`wb-seg ${view === 'calendar' ? 'on' : ''}`} onClick={() => setView('calendar')}><Icon name="calendar" />日历</button>
          <button className={`wb-seg ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')}><Icon name="list" />任务</button>
        </div>
        <div style={{ flex: 1 }} />
        <button className="wb-btn primary" onClick={() => setShowQuick((v) => !v)} disabled={busy}><Icon name="sparkles" />快速录入</button>
        <button className="wb-btn" onClick={() => setShowForm((v) => !v)}><Icon name="plus" />新建</button>
        <button className="wb-btn" onClick={() => setShowSettings((v) => !v)}><Icon name="settings" />设置</button>
        <button className="wb-btn" onClick={collapseAll}><Icon name="list" />收起全部</button>
        <button className="wb-btn" onClick={() => document.documentElement.removeAttribute(ACTIVE_ATTR)}><Icon name="back" />返回对话</button>
      </div>

      {error !== null && <div className="wb-banner error"><h4><Icon name="bell" />出错了</h4>{error} <button className="wb-btn" onClick={() => setError(null)}>关闭</button></div>}
      {notice !== null && <div className="wb-banner notice"><h4><Icon name="bell" />提示</h4>{notice} <button className="wb-btn" onClick={() => setNotice(null)}>关闭</button></div>}
      {reminders.length > 0 && (
        <div className="wb-banner reminder">
          <h4><Icon name="bell" />到期提醒（{reminders.length}）</h4>
          {reminders.map((r) => <div key={r.reminderId} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}><span style={{ flex: 1 }}>{r.title} · {fmtTime(r.dueAt)}</span><button className="wb-btn" onClick={() => void fireReminder(r.reminderId)}>知道了</button></div>)}
        </div>
      )}
      {pendingDraft !== null && <DraftBanner draft={pendingDraft} runtime={runtime} onDone={() => { setPendingDraft(null); setReportRefreshKey((v) => v + 1); void refresh() }} />}

      <div className="wb-body">
        <div className="wb-nav">
          {showSettings && (
            <div className="wb-form-panel">
              <h4><Icon name="settings" />工作台设置</h4>
              <label className="full">默认 AI 会话工作区（任务未指定时使用）
                <input value={settings.defaultWorkspace} onChange={(e) => setSettings((prev) => ({ ...prev, defaultWorkspace: e.target.value }))} placeholder="例如 D:\Code\AI-Workspace" />
              </label>
              <label className="full" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={settings.autoCreateTypeFolders} onChange={(e) => setSettings((prev) => ({ ...prev, autoCreateTypeFolders: e.target.checked }))} />
                自动为每个任务创建独立文件夹（用任务名命名）
              </label>
              <label className="full" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={settings.desktopNotify} onChange={(e) => setSettings((prev) => ({ ...prev, desktopNotify: e.target.checked }))} />
                启用桌面通知（任务到期时弹系统通知）
              </label>
              <div className="full" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {notifyPerm === 'unsupported'
                  ? <span style={{ fontSize: 12, color: '#999' }}>当前浏览器不支持系统通知，将使用页内横幅提醒</span>
                  : notifyPerm === 'granted'
                    ? <span style={{ fontSize: 12, color: '#2E9B7B' }}>浏览器通知已授权</span>
                    : <button className="wb-btn" onClick={() => {
                        void Notification.requestPermission().then((perm) => {
                          setNotifyPerm(perm)
                          if (perm === 'granted') setNotice('桌面通知已开启')
                        })
                      }}>授权浏览器通知</button>}
                {notifyPerm === 'granted' && <button className="wb-btn" onClick={() => {
                  try { new Notification('dsh-workbench 通知测试', { body: '如果你看到这条系统通知，说明桌面提醒已正常工作。' }) } catch { /* ignore */ }
                }}>发送测试通知</button>}
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>DSH 页面保持打开（可最小化）即可收到</span>
              </div>
              <div className="full" style={{ display: 'flex', gap: 8 }}>
                <button className="wb-btn primary lg" onClick={() => void api('/api/workbench/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) }).then(() => { setNotice('设置已保存'); setShowSettings(false) }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}><Icon name="check" />保存设置</button>
                <button className="wb-btn" onClick={() => setShowSettings(false)}>取消</button>
              </div>
            </div>
          )}

          {showQuick && (
            <div className="wb-form-panel">
              <h4><Icon name="sparkles" />快速录入 <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>（将跳转官方会话区进行需求澄清）</span></h4>
              <textarea rows={3} style={{ width: '100%', minHeight: 76, background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.18))', color: 'inherit', borderRadius: 10, padding: 10, boxSizing: 'border-box', fontSize: 14 }} value={quickText} onChange={(e) => setQuickText(e.target.value)} placeholder="一句话描述任务，例如：周五10:30接待重要客户" />
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="wb-btn primary lg" disabled={busy || quickText.trim() === ''} onClick={() => void startAISession('clarify', null, quickText)}>🚀 创建澄清会话</button>
                <button className="wb-btn" onClick={() => setShowQuick(false)}>取消</button>
              </div>
            </div>
          )}

          {showForm && (
            <form className="wb-form wb-form-panel" onSubmit={(e) => void createTask(e)}>
              <h4 className="full" style={{ margin: 0 }}><Icon name="plus" />新建任务</h4>
              <label className="full">标题<input name="title" required placeholder="要做什么？" /></label>
              <label>类型<select name="type" defaultValue="client_meeting">{dictOf('type').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
              <label>优先级<select name="priority" defaultValue="p2">{dictOf('priority').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
              <label>状态<select name="status" defaultValue="todo">{dictOf('status').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
              <label>截止时间<input name="due" type="datetime-local" /></label>
              <label>AI 会话工作区（可选，留空用默认）<input name="workspacePath" placeholder={settings.defaultWorkspace || '默认工作区未设置'} /></label>
              <label className="full">描述<textarea name="description" rows={2} placeholder="背景 / 目标 / 验收标准（Markdown）" /></label>
              <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary lg" type="submit"><Icon name="check" />保存任务</button><button className="wb-btn" type="button" onClick={() => setShowForm(false)}>取消</button></div>
            </form>
          )}

          {view === 'today' && (
            <>
              <div className="wb-stats">
                <div className="wb-stat"><b>{bootstrap?.stats.overdue ?? 0}</b><span>逾期</span></div>
                <div className="wb-stat"><b>{bootstrap?.stats.todayDue ?? 0}</b><span>今天到期</span></div>
                <div className="wb-stat"><b>{bootstrap?.stats.doing ?? 0}</b><span>进行中</span></div>
                <div className="wb-stat"><b>{bootstrap?.stats.total ?? 0}</b><span>总数</span></div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button className="wb-btn primary" disabled={busy || openTasks.length === 0} onClick={() => void startAISession('plan', null, localDateString())}><Icon name="sparkles" />{todayPlanSession !== null ? '继续编辑今日计划' : 'AI 智能排序'}</button>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', alignSelf: 'center' }}>AI 会先提交顺序提案，确认后才生效</span>
              </div>
              {todayPlan !== null && (
                <div className="wb-card wb-plan">
                  <h4><Icon name="sparkles" />今日计划 · {todayPlan.planDate}</h4>
                  {todayPlan.summary !== '' && <div style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 6 }}>{todayPlan.summary}</div>}
                  <div>
                    {todayPlan.items.map((item, index) => <div key={item.taskId} className="wb-plan-item"><span className="wb-plan-num">{index + 1}</span><b>{item.title}</b>{item.note !== '' && <span className="wb-plan-note">— {item.note}</span>}</div>)}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="wb-btn" onClick={() => void startAISession('plan', null, localDateString())}><Icon name="refresh" />重新生成</button>
                    <button className="wb-btn" onClick={() => void clearTodayPlan()}><Icon name="trash" />清除</button>
                  </div>
                </div>
              )}
              <div className="wb-list">
                <TaskTreeRows roots={todayTree} depth={0} expanded={todayExpanded} toggle={toggleTodayExpanded} dicts={dicts} onOpen={openTask} selectedId={selected?.task.id} />
                {openTasks.length === 0 && <div className="wb-empty">今天没有需要关注的任务</div>}
              </div>
            </>
          )}

          {view === 'calendar' && (
            <>
              <div className="wb-cal-nav">
                <button className="wb-btn" onClick={() => (calMode === 'week' ? moveWeek(-1) : moveMonth(-1))}>◀</button>
                <button className="wb-btn" onClick={() => (calMode === 'week' ? setCursor(startOfWeek(now)) : setCursor(new Date(now.getFullYear(), now.getMonth(), 1)))}>今天</button>
                <button className="wb-btn" onClick={() => (calMode === 'week' ? moveWeek(1) : moveMonth(1))}>▶</button>
                <div style={{ flex: 1, textAlign: 'center', fontWeight: 600 }}>
                  {calMode === 'week' ? `${cursor.getFullYear()}/${cursor.getMonth() + 1}/${cursor.getDate()} 周` : `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`}
                </div>
                <div className="wb-segmented wb-sub-segmented">
                  <button className={`wb-seg ${calMode === 'week' ? 'on' : ''}`} onClick={() => setCalMode('week')}>周</button>
                  <button className={`wb-seg ${calMode === 'month' ? 'on' : ''}`} onClick={() => setCalMode('month')}>月</button>
                </div>
              </div>

              {calMode === 'week' && (
                <div className="wb-week">
                  {weekDays.map((d) => {
                    const n = tasks.filter((t) => t.dueAt !== null && sameDay(new Date(t.dueAt), d) && t.statusCode !== 'cancelled').length
                    return (
                      <div key={d.toISOString()} className={`wb-day ${sameDay(d, now) ? 'today' : ''} ${sameDay(d, picked) ? 'selected' : ''}`} onClick={() => setPicked(startOfDay(d))}>
                        <div style={{ fontSize: 12, color: '#999' }}>{d.getMonth() + 1}/{d.getDate()}</div>
                        {n > 0 && <div className="wb-chip" style={{ background: '#4f8ef7', marginTop: 4 }}>{n} 个任务</div>}
                      </div>
                    )
                  })}
                </div>
              )}
              {calMode === 'month' && (
                <div className="wb-month">
                  {monthGrid.map((d) => (
                    <div key={d.toISOString()} className={`wb-mday ${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${sameDay(d, now) ? 'today' : ''} ${sameDay(d, picked) ? 'selected' : ''}`} onClick={() => setPicked(startOfDay(d))}>
                      <div style={{ fontSize: 12 }}>{d.getDate()}</div>
                      {tasks.some((t) => t.dueAt !== null && sameDay(new Date(t.dueAt), d)) && <div className="wb-chip" style={{ background: '#4f8ef7', marginTop: 2 }}>•</div>}
                    </div>
                  ))}
                </div>
              )}

              <div className="wb-segmented wb-sub-segmented">
                <button className={`wb-seg ${dayTab === 'plan' ? 'on' : ''}`} onClick={() => setDayTab('plan')}><Icon name="list" />计划 <span className="count">{countTaskTree(pickedPlanTree)}</span></button>
                <button className={`wb-seg ${dayTab === 'done' ? 'on' : ''}`} onClick={() => setDayTab('done')}><Icon name="check" />已完成 <span className="count">{countTaskTree(pickedDoneTree)}</span></button>
                <button className={`wb-seg ${dayTab === 'report' ? 'on' : ''}`} onClick={() => setDayTab('report')}><Icon name="report" />报告</button>
              </div>
              {dayTab === 'plan' && (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                    {pickedAnchor < todayAnchor
                      ? <span style={{ fontSize: 12, color: '#999' }}>过去日期只读；如需为今天/未来排期，请选择今天或之后的日期。</span>
                      : <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('plan', null, pickedAnchor)}><Icon name="sparkles" />{pickedPlanSession !== null ? '继续编辑该日计划' : `AI 智能排序（${pickedAnchor}）`}</button>}
                    <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>AI 会先提交顺序提案，确认后才生效</span>
                  </div>
                  {pickedPlan !== null && (
                    <div className="wb-card wb-plan" style={{ marginTop: 10 }}>
                      <h4><Icon name="sparkles" />{pickedPlan.planDate} 计划</h4>
                      {pickedPlan.summary !== '' && <div style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 6 }}>{pickedPlan.summary}</div>}
                      <div>
                        {pickedPlan.items.map((item, index) => <div key={item.taskId} className="wb-plan-item"><span className="wb-plan-num">{index + 1}</span><b>{item.title}</b>{item.note !== '' && <span className="wb-plan-note">— {item.note}</span>}</div>)}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        {pickedAnchor >= todayAnchor && <button className="wb-btn" onClick={() => void startAISession('plan', null, pickedAnchor)}><Icon name="refresh" />重新生成</button>}
                        <button className="wb-btn" onClick={() => {
                          void api(`/api/workbench/plans/${pickedAnchor}`, { method: 'DELETE' }).then(() => { setPlanRefreshKey((v) => v + 1); setNotice('该日计划已清除') }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                        }}><Icon name="trash" />清除</button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {dayTab === 'plan' && sameDay(picked, now) && noDueOpen.length > 0 && (
                <div style={{ fontSize: 12, color: '#999', padding: '4px 2px' }}>另有 {noDueOpen.length} 个进行中任务未设置截止时间，暂列今天；点击父任务 ▶ 展开子任务</div>
              )}
              {dayTab === 'report' ? (
                <div className="wb-card">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div className="wb-segmented wb-sub-segmented">
                      <button className={`wb-seg ${reportSubTab === 'day' ? 'on' : ''}`} onClick={() => setReportSubTab('day')}>日报（{localDateString(picked)}）</button>
                      <button className={`wb-seg ${reportSubTab === 'week' ? 'on' : ''}`} onClick={() => setReportSubTab('week')}>周报（{localDateString(startOfWeek(picked))} 起）</button>
                    </div>
                    <div style={{ flex: 1 }} />
                  </div>
                  {reportIsFuture ? (
                    <div className="wb-empty">
                      未来日期属于工作安排，报告只做复盘。<br />如需安排未来工作，请在「计划」页签给任务设置截止时间；AI 未来排期将在下版支持。
                    </div>
                  ) : currentReport !== null ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                        <h4 style={{ flex: 1, margin: 0 }}>{currentReport.title}</h4>
                        <button className="wb-btn" onClick={() => {
                          void api(`/api/workbench/reports/${currentReport.periodCode}/${currentReport.periodStart}`, { method: 'DELETE' }).then(() => { setCurrentReport(null); setReportSession(null); void refresh() }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                        }}>删除</button>
                      </div>
                      <div style={{ marginTop: 6 }}><MarkdownText text={currentReport.summaryMd} /></div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('report', null, `${reportSubTab}:${reportAnchor}`)}>
                          {reportSession !== null || currentReport.sessionId !== null ? '继续编辑报告' : 'AI 生成报告'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="wb-empty" style={{ marginTop: 8 }}>
                      {reportSubTab === 'week' ? '本周' : '当天'}还没有报告。
                      <div style={{ marginTop: 10 }}>
                        <button className="wb-btn primary lg" disabled={busy} onClick={() => void startAISession('report', null, `${reportSubTab}:${reportAnchor}`)}>
                          {reportSession !== null ? '继续编辑报告' : `AI 生成${reportSubTab === 'week' ? '周报' : '日报'}（${reportAnchor}）`}
                        </button>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 8 }}>同一周期只有一个报告会话，重复点击会回到原会话继续修改。</div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="wb-list">
                  <TaskTreeRows roots={dayTab === 'plan' ? pickedPlanTree : pickedDoneTree} depth={0} expanded={calendarExpanded} toggle={toggleCalendarExpanded} dicts={dicts} onOpen={openTask} selectedId={selected?.task.id} />
                  {(dayTab === 'plan' ? pickedPlanTree : pickedDoneTree).length === 0 && <div className="wb-empty">{picked.getMonth() + 1}/{picked.getDate()} 没有{dayTab === 'plan' ? '计划任务' : '完成记录'}</div>}
                </div>
              )}
            </>
          )}

          {view === 'list' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <button className="wb-btn" onClick={() => {
                  const next = !archivedMode
                  setArchivedMode(next)
                  if (next) { void api<{ tasks: Task[] }>('/api/workbench/tasks?archived=true').then((r) => setArchivedTasks(r.tasks)).catch(() => undefined) }
                }}>{archivedMode ? '返回任务' : '查看归档'}</button>
              </div>
              <div className="wb-list">
                {archivedMode
                  ? archivedTasks.map((t) => <TaskRow key={t.id} task={t} dicts={dicts} onOpen={openTask} selected={selected?.task.id === t.id} />)
                  : <TaskTreeRows roots={buildTaskTree(tasks)} depth={0} expanded={expanded} toggle={toggleExpanded} dicts={dicts} onOpen={openTask} selectedId={selected?.task.id} />}
                {archivedMode && archivedTasks.length === 0 && <div className="wb-empty">没有归档任务</div>}
                {!archivedMode && tasks.length === 0 && <div className="wb-empty">还没有任务，点“快速录入”或“新建”开始</div>}
              </div>
            </>
          )}
        </div>

        <div className="wb-detail">
          {selected === null
            ? <div className="wb-empty">← 从左侧选择一个任务查看详情<br /><span style={{ fontSize: 12 }}>AI 澄清/咨询/拆解会跳转到官方会话区，完成后回这里确认草稿</span></div>
            : (
              <>
                <div className="wb-card">
                  {editDraft === null ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <h4 style={{ flex: 1, margin: 0 }}>{selected.task.title}</h4>
                        {!selected.task.archived && <button className="wb-btn" onClick={() => setEditDraft({ title: selected.task.title, description: selected.task.description, typeCode: selected.task.typeCode, priorityCode: selected.task.priorityCode, statusCode: selected.task.statusCode, aiPolicyCode: selected.task.aiPolicyCode, dueLocal: toLocalInput(selected.task.dueAt), workspacePath: selected.task.workspacePath ?? '' })}><Icon name="edit" />编辑</button>}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
                        <Badge dict={dictOf('type')} code={selected.task.typeCode} />
                        <Badge dict={dictOf('priority')} code={selected.task.priorityCode} />
                        <Badge dict={dictOf('status')} code={selected.task.statusCode} />
                      </div>
                      <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>截止：{selected.task.dueAt === null ? '无' : fmtTime(selected.task.dueAt)}</div>
                      <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>AI 工作区：{selected.task.workspacePath ?? (settings.defaultWorkspace || '默认工作区未设置')}</div>
                      <MarkdownText text={selected.task.description || '（无描述）'} />
                      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                        {selected.task.archived ? (
                          <button className="wb-btn primary" onClick={() => { void api(`/api/workbench/tasks/${selected.task.id}/restore`, { method: 'POST' }).then(() => { setNotice('任务已恢复'); setArchivedMode(false); void refresh() }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) }}>恢复任务</button>
                        ) : (
                          <>
                            {selected.children.length === 0
                              ? selected.task.statusCode === 'done' || selected.task.statusCode === 'cancelled'
                                ? <button className="wb-btn" disabled={busy} onClick={() => {
                                    const existing = selected.sessions.find((x) => x.role_code === 'review')
                                    if (existing !== undefined && typeof existing.session_id === 'string' && existing.session_id !== '') {
                                      document.documentElement.removeAttribute(ACTIVE_ATTR)
                                      runtime.sessions.open(existing.session_id)
                                    } else {
                                      void startAISession('review', selected.task, selected.task.title)
                                    }
                                  }}>{selected.sessions.some((x) => x.role_code === 'review') ? '进入复盘会话' : 'AI 复盘'}</button>
                                : <button className="wb-btn primary" disabled={busy || selected.task.aiPolicyCode !== 'execute'} title={selected.task.aiPolicyCode !== 'execute' ? '请先开启“可执行”' : selected.sessions.some((x) => x.role_code === 'execute') ? '新建执行会话并携带此前会话提示' : '开始执行'} onClick={() => void startAISession('execute', selected.task, selected.task.title, selected.sessions.filter((x) => x.role_code === 'execute'))}>AI 执行{selected.sessions.some((x) => x.role_code === 'execute') ? '（新会话续作）' : ''}{selected.task.aiPolicyCode !== 'execute' ? '（需可执行）' : ''}</button>
                              : <span style={{ fontSize: 12, color: '#999', alignSelf: 'center' }}>该任务有子任务，请展开子任务执行叶子任务</span>}
                            <button className="wb-btn" disabled={busy} onClick={() => void startAISession('consult', selected.task, selected.task.title)}>AI 协助</button>
                            <button className="wb-btn" disabled={busy} onClick={() => void startAISession('breakdown', selected.task, selected.task.title)}>AI 拆解</button>
                            <button className="wb-btn" onClick={() => setSubtaskParent(selected.task)}>+ 子任务</button>
                            <button className="wb-btn" onClick={() => { if (window.confirm('归档后任务会从工作台列表隐藏；可在列表页“查看归档”中恢复。确认归档？')) { const id = selected.task.id; setTasks((list) => list.filter((t) => t.id !== id)); void api(`/api/workbench/tasks/${id}/archive`, { method: 'POST' }).then(() => { setSelected(null); selectedRef.current = null; setNotice('任务已归档，可在列表页“查看归档”恢复。'); void refresh() }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) } }}>归档</button>
                          </>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>
                        {selected.children.length === 0 && selected.task.aiPolicyCode === 'execute' && selected.task.statusCode !== 'done' && selected.task.statusCode !== 'cancelled' ? '执行会话完成后，AI 会提交验收申请，由你验收后标记完成。' : ''}
                      </div>
                    </>
                  ) : (
                    <form className="wb-form" onSubmit={(e) => {
                      e.preventDefault()
                      if (editDraft.title.trim() === '') return
                      void patchTask(selected.task.id, {
                        title: editDraft.title.trim(),
                        description: editDraft.description,
                        typeCode: editDraft.typeCode,
                        priorityCode: editDraft.priorityCode,
                        statusCode: editDraft.statusCode,
                        aiPolicyCode: editDraft.aiPolicyCode,
                        dueAt: editDraft.dueLocal === '' ? null : new Date(editDraft.dueLocal).toISOString(),
                        workspacePath: editDraft.workspacePath.trim() === '' ? null : editDraft.workspacePath.trim(),
                      }).then(() => { setEditDraft(null); setNotice('任务已更新') }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                    }}>
                      <h4 className="full" style={{ margin: 0 }}><Icon name="edit" />编辑任务</h4>
                      <label className="full">标题<input value={editDraft.title} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, title: e.target.value })} /></label>
                      <label>类型<select value={editDraft.typeCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, typeCode: e.target.value })}>{dictOf('type').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                      <label>优先级<select value={editDraft.priorityCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, priorityCode: e.target.value })}>{dictOf('priority').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                      <label>状态<select value={editDraft.statusCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, statusCode: e.target.value })}>{dictOf('status').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                      <label>AI 策略<select value={editDraft.aiPolicyCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, aiPolicyCode: e.target.value })}>{dictOf('ai_policy').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                      <label>截止时间<input type="datetime-local" value={editDraft.dueLocal} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, dueLocal: e.target.value })} /></label>
                      <label className="full">AI 会话工作区（留空使用默认）<input value={editDraft.workspacePath} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, workspacePath: e.target.value })} placeholder={settings.defaultWorkspace || '默认工作区未设置'} /></label>
                      <label className="full">描述（Markdown）<textarea rows={6} value={editDraft.description} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, description: e.target.value })} /></label>
                      <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit"><Icon name="check" />保存</button><button className="wb-btn" type="button" onClick={() => setEditDraft(null)}>取消</button></div>
                    </form>
                  )}
                </div>
                {subtaskParent !== null && subtaskParent.id === selected.task.id && (
                  <form className="wb-form wb-form-panel" onSubmit={(e) => {
                    e.preventDefault()
                    const form = new FormData(e.currentTarget)
                    const title = String(form.get('title') ?? '').trim()
                    if (title === '') return
                    const due = String(form.get('due') ?? '')
                    void api('/api/workbench/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, typeCode: String(form.get('type') ?? subtaskParent.typeCode), priorityCode: String(form.get('priority') ?? subtaskParent.priorityCode), statusCode: 'todo', parentId: subtaskParent.id, dueAt: due === '' ? null : new Date(due).toISOString() }) }).then(() => { setSubtaskParent(null); setNotice('子任务已创建'); void refresh() }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                  }}>
                    <h4 className="full" style={{ margin: 0 }}><Icon name="subtask" />新建子任务（父任务：{subtaskParent.title}）</h4>
                    <label className="full">标题<input name="title" required placeholder="子任务标题" /></label>
                    <label>类型<select name="type" defaultValue={subtaskParent.typeCode}>{dictOf('type').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                    <label>优先级<select name="priority" defaultValue={subtaskParent.priorityCode}>{dictOf('priority').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                    <label>截止时间<input name="due" type="datetime-local" /></label>
                    <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit">保存子任务</button><button className="wb-btn" type="button" onClick={() => setSubtaskParent(null)}>取消</button></div>
                  </form>
                )}
                <div className="wb-card">
                  <h4>子任务（{selected.children.length}）</h4>
                  {selected.children.map((c) => <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}><Badge dict={dictOf('status')} code={c.statusCode} /> <span onClick={() => openTask(c)} style={{ cursor: 'pointer' }}>{c.title}</span></div>)}
                  {selected.children.length === 0 && <div style={{ color: '#999', fontSize: 12 }}>无</div>}
                </div>
                <div className="wb-card">
                  <h4>提醒（{selected.reminders.length}）</h4>
                  {selected.reminders.map((r) => <div key={r.id} style={{ fontSize: 12, color: '#999', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}><Icon name="bell" size={13} />{r.offsetMinutes === 0 ? '准时（截止时间）' : `提前 ${r.offsetMinutes} 分钟`} · {r.methodCode === 'os' ? '系统通知' : '页面/桌面通知'} · {r.firedAt === null ? '未触发' : `已触发 ${fmtTime(r.firedAt)}`}</div>)}
                  {selected.task.dueAt === null
                    ? <div style={{ fontSize: 12, color: '#999' }}>任务还没有截止时间，请先在详情里设置截止时间，再添加提醒。</div>
                    : selected.task.statusCode === 'done' || selected.task.statusCode === 'cancelled'
                      ? <div style={{ fontSize: 12, color: '#999' }}>已完成/已取消的任务不再提醒。</div>
                      : (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                          {[{ offset: 0, label: '准时' }, { offset: 15, label: '提前15分' }, { offset: 30, label: '提前30分' }, { offset: 60, label: '提前1小时' }, { offset: 1440, label: '提前1天' }].map((item) => (
                            <button key={item.offset} className="wb-btn" disabled={busy} onClick={() => void addTaskReminder(item.offset)}>{item.label}</button>
                          ))}
                        </div>
                      )}
                  <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>到提醒时间后：页内横幅 + 桌面通知（设置中授权）；点“知道了”后标记已触发。</div>
                </div>
                <div className="wb-card">
                  <h4>关联会话（{selected.sessions.length}）</h4>
                  {selected.sessions.map((s) => {
                    const sid = typeof s.session_id === 'string' ? s.session_id : ''
                    return <div key={String(s.session_id ?? s.role_code)} style={{ fontSize: 12, color: 'var(--dsw-alias-state-business-primary,#8fa8c8)', cursor: 'pointer', marginBottom: 4 }} onClick={() => { if (sid !== '') { document.documentElement.removeAttribute(ACTIVE_ATTR); runtime.sessions.open(sid) } }}>#{String(s.role_code ?? '')} · {sid}（点击打开）</div>
                  })}
                </div>
                <div className="wb-card">
                  <h4>复盘记录（{selected.reviews?.length ?? 0}）</h4>
                  {(selected.reviews ?? []).map((rv, i) => <div key={String(rv.id ?? i)} style={{ marginBottom: 8 }}><MarkdownText text={String(rv.summary_md ?? '')} /></div>)}
                  {(selected.reviews?.length ?? 0) === 0 && <div style={{ fontSize: 12, color: '#999' }}>暂无复盘；已完成任务可用“AI 复盘”。</div>}
                </div>
                <div className="wb-card">
                  <h4>变更历史（{selected.events?.length ?? 0}）</h4>
                  {(selected.events ?? []).slice(0, 12).map((ev, i) => (
                    <div key={String(ev.id ?? i)} style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>
                      {String(ev.at ?? '').slice(0, 16).replace('T', ' ')} · {String(ev.event_code ?? '')} · {String(ev.actor ?? '')}{typeof ev.note === 'string' && ev.note !== '' ? ` · ${ev.note}` : ''}
                    </div>
                  ))}
                </div>
              </>
            )}
        </div>
      </div>
    </div>
  )
}

function ensureStyle(): void {
  if (document.querySelector('style[data-dsh-workbench-style]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshWorkbenchStyle = ''
  style.textContent = CSS
  document.head.appendChild(style)
}
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  return column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement ?? (column.firstElementChild as HTMLElement | undefined)
}
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  return Array.from(root.children).find((child): child is HTMLButtonElement => child.tagName === 'BUTTON')
}
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>('[data-pane="conversation"], [class*="centerCol"]') ?? undefined
}

export const name = 'workbench-client'
export const inject = ['sessions', 'workspaces']

export function apply(ctx: unknown): () => void {
  const runtime = ctx as WorkbenchRuntime
  let open = false
  ensureStyle()
  const setOpen = (value: boolean): void => {
    open = value
    if (open) {
      for (const attr of SIBLING_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else document.documentElement.removeAttribute(ACTIVE_ATTR)
  }
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(ENTRY_ATTR, '')
  entry.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 2v3M10.5 2v3"/><path d="M5 9.5l1.5 1.5L9.5 8"/></svg><span class="wb-label">工作台</span>'
  entry.addEventListener('click', () => { setOpen(!open) })
  const syncEntry = (): void => { if (open) entry.dataset.active = 'true'; else delete entry.dataset.active }
  const entryObserver = new MutationObserver(syncEntry)
  entryObserver.observe(document.documentElement, { attributes: true, attributeFilter: [ACTIVE_ATTR] })
  syncEntry()

  const view = document.createElement('div')
  view.setAttribute(VIEW_ATTR, '')
  const root: Root = createRoot(view)
  root.render(<WorkbenchApp runtime={runtime} />)

  let rootEl: HTMLElement | undefined
  let placed = false
  let column: HTMLElement | undefined
  const placeEntry = (): void => {
    if (rootEl !== undefined && !rootEl.isConnected) { rootEl = undefined; placed = false }
    if (placed) { if (document.body.contains(entry)) return; placed = false }
    rootEl ??= sidebarRoot()
    if (rootEl === undefined) return
    const button = newSessionButton(rootEl)
    if (button === undefined) return
    if (entry.parentElement !== rootEl) {
      const row = button.closest('[class*="logoRow"]')
      const base = row !== null && row.parentElement === rootEl ? row : button
      const family = Array.from(rootEl.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry]'))
      const anchor = family.length > 0 ? family[0] : base.nextElementSibling
      rootEl.insertBefore(entry, anchor)
    }
    placed = true
  }
  const placeView = (): void => { column ??= conversationColumn(); if (column !== undefined && !column.contains(view)) column.appendChild(view) }
  const watcher = new MutationObserver(() => { placeEntry(); placeView() })
  watcher.observe(document.body, { childList: true, subtree: true })
  placeEntry(); placeView()

  const onOtherActivate = (event: Event): void => { if ((event as CustomEvent).detail !== PANEL_NAME && open) setOpen(false) }
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!open) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest('[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]') !== null) setOpen(false)
  }
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  document.addEventListener('click', onClickSidebarRow, true)

  return () => {
    watcher.disconnect(); entryObserver.disconnect()
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    document.removeEventListener('click', onClickSidebarRow, true)
    entry.remove(); root.unmount(); view.remove()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
  }
}
