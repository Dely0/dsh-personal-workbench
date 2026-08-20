/**
 * dsh-personal-workbench client v0.2 — 方案 A 左右分栏：
 *  - 左侧导航区：今日 / 可导航日历(周/月) / 树状列表（默认折叠、记忆展开）
 *  - 右侧详情区：仅显示选中任务；未选中显示占位
 *  - AI 澄清/咨询/拆解统一跳官方会话区；工作台侧边栏显示待确认草稿红点
 */
import { createRoot, type Root } from 'react-dom/client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildTaskTree,
  countTaskTreeBy,
  createTaskSorter,
  filterTaskTree,
  isTaskDueOnDay,
  isTaskFilterEmpty,
  matchesTaskFilter,
  type TaskFilterState,
  type TaskSortDir,
  type TaskSortKey,
  type TaskTreeNode,
} from './taskFilterSort.js'
import { isWslStylePath, joinPath, normalizeWindowsPathToWsl } from './workspacePath.js'

const PANEL_NAME = 'personal-workbench'
const ACTIVE_ATTR = 'data-dsh-personal-workbench-active'
const PENDING_ATTR = 'data-dsh-personal-workbench-pending'
const VIEW_ATTR = 'data-dsh-personal-workbench-view'
const ENTRY_ATTR = 'data-dsh-personal-workbench-entry'
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
.wb-nav { flex:0 0 56%; min-width:0; overflow:auto; padding:0 18px 16px; box-sizing:border-box; border-right:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }
.wb-nav > :first-child:not(.wb-stats-sticky) { margin-top:16px; }
.wb-detail { flex:1; min-width:0; overflow:auto; padding:16px 18px; box-sizing:border-box; }
.wb-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:12px; }
.wb-stat { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.20)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); border-radius:12px; padding:12px 14px; box-shadow:0 2px 8px rgba(0,0,0,.06); }
.wb-stat b { font-size:20px; }
.wb-stat span { display:block; color:var(--dsw-alias-label-secondary); font-size:12px; }
.wb-stats-sticky { position:sticky; top:0; z-index:12; margin:0 -18px 12px; padding:12px 18px 14px; background:var(--dsw-alias-bg-base,#111); box-shadow:none; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24)); }
.wb-card { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.26)); background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); border-radius:14px; padding:16px; margin-bottom:14px; box-shadow:0 6px 18px rgba(0,0,0,.08); }
.wb-card h4 { margin:0 0 10px; padding-bottom:10px; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16)); display:flex; align-items:center; gap:8px; font-size:14px; font-weight:700; }
.wb-card h4 svg { width:16px; height:16px; color:var(--dsw-alias-state-business-primary, #8fa8c8); flex:none; }
.wb-plan { border-left:4px solid var(--dsw-alias-state-business-primary, #8fa8c8); background: linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 9%, transparent), color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 3%, transparent) 45%, var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)) 100%); }
.wb-plan-item { display:flex; align-items:center; margin:7px 0; font-size:13.5px; }
.wb-plan-num { display:inline-flex; width:20px; height:20px; border-radius:50%; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 16%, transparent); border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 40%, transparent); color:var(--dsw-alias-label-primary); font-size:11px; font-weight:700; align-items:center; justify-content:center; margin-right:8px; flex:none; }
.wb-plan-note { color:var(--dsw-alias-label-secondary); margin-left:8px; font-size:12.5px; }
.wb-plan-scroll { max-height:min(27vh,280px); overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 38%, transparent) transparent; padding-right:4px; }
.wb-plan-scroll::-webkit-scrollbar { width:8px; }
.wb-plan-scroll::-webkit-scrollbar-track { background:transparent; }
.wb-plan-scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 38%, transparent); border-radius:4px; }
.wb-plan-expanded .wb-plan-scroll { max-height:min(70vh,720px); }
.wb-plan-footer { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:10px; padding-top:10px; border-top:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); font-size:12px; color:var(--dsw-alias-label-secondary); }
.wb-plan-item { min-width:0; gap:6px; }
.wb-plan-item b, .wb-plan-item .wb-plan-note { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wb-plan-item b { flex:0 1 auto; }
.wb-plan-item .wb-plan-note { flex:1 1 36%; }
.wb-plan-item-actions { display:inline-flex; gap:4px; flex:none; margin-left:auto; }
.wb-plan-act { display:inline-flex; align-items:center; border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); background:color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 3%, transparent); color:var(--dsw-alias-label-secondary); border-radius:6px; padding:2px 7px; font-size:11px; cursor:pointer; line-height:1.5; }
.wb-plan-act:hover { color:var(--dsw-alias-label-primary); border-color:color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 35%, transparent); }
.wb-plan-act:disabled { opacity:.45; cursor:default; }
.wb-plan-act.done { color:color-mix(in srgb, #2E9B7B 85%, #fff); border-color:color-mix(in srgb, #2E9B7B 45%, transparent); }
.wb-plan-act.defer { color:color-mix(in srgb, #d9a03f 85%, #fff); border-color:color-mix(in srgb, #d9a03f 45%, transparent); }
.wb-plan-item.closed { opacity:.55; }
.wb-plan-item.closed b { text-decoration:line-through; }
.wb-plan-edit-note { flex:1 1 36%; min-width:0; background:var(--dsw-alias-bg-base,#17171a); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18)); color:inherit; border-radius:6px; padding:3px 7px; font-size:12px; }
.wb-plan-edit-actions { display:inline-flex; gap:4px; flex:none; margin-left:auto; }
.wb-plan-edit-actions .wb-btn { padding:2px 7px; font-size:11px; }
.wb-plan-add { max-width:220px; background:var(--dsw-alias-bg-base,#17171a); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18)); color:inherit; border-radius:8px; padding:5px 8px; font-size:12px; }
.wb-modal-mask { position:fixed; inset:0; z-index:200; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; }
.wb-modal { width:min(520px, 92vw); background:var(--dsw-alias-bg-layer-2, #1c1c1f); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.25)); border-radius:14px; padding:18px; box-shadow:0 18px 50px rgba(0,0,0,.4); color:var(--dsw-alias-label-primary, #eee); font-family:var(--dsw-font-family, system-ui); }
.wb-modal h4 { margin:0 0 8px; }
.wb-modal p { margin:0 0 12px; font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.wb-modal textarea { width:100%; min-height:110px; box-sizing:border-box; background:var(--dsw-alias-bg-base,#17171a); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.2)); color:inherit; border-radius:10px; padding:10px; font:inherit; resize:vertical; }
.wb-modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }
.wb-list { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24)); border-radius:12px; overflow:hidden; background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); }
.wb-row { display:flex; align-items:center; gap:8px; padding:11px 12px; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12)); cursor:pointer; transition:background .12s ease; }
.wb-row:last-child { border-bottom:none; }
.wb-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 5%, transparent); }
.wb-row.selected { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #8fa8c8) 12%, transparent); box-shadow:inset 3px 0 0 var(--dsw-alias-state-business-primary, #8fa8c8); }
.wb-row-context { opacity:.55; }
.wb-row-context .wb-row-title { color: var(--dsw-alias-label-secondary); }
.wb-card { transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease; }
.wb-card.selected { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 65%, transparent) !important; box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 35%, transparent), 0 6px 18px rgba(0,0,0,.10); transform: translateY(-1px); }
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
/* 今日卡片高亮：周/月视图统一加亮边框 + 浅色背景 + 日期数字高亮 */
.wb-day.today { border-color: var(--dsw-alias-state-business-primary, #4f8ef7) !important; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 12%, transparent) !important; }
.wb-day.today .wb-day-date { color: var(--dsw-alias-state-business-primary, #4f8ef7); font-weight: 700; }
.wb-day.today.selected { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 70%, transparent); }
.wb-mday.today { border-color: var(--dsw-alias-state-business-primary, #4f8ef7) !important; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent) !important; color: var(--dsw-alias-label-primary); }
.wb-mday.today .wb-mday-date { color: var(--dsw-alias-state-business-primary, #4f8ef7); font-weight: 700; }
.wb-mday.today.selected { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 70%, transparent); }
.wb-mday.other.today { opacity: 1; }
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
  effectiveDueAt: string | null
  allDay: boolean
  estimatedMinutes: number | null
  source: string
  workspacePath: string | null
  archived: boolean
  extra: Record<string, unknown>
  recurrenceCode: string | null
  recurrenceRule: Record<string, unknown>
  recurrenceMasterId: string | null
  recurrenceLastGenerated: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  cancelledAt: string | null
}
interface DailyPlanItemView { taskId: string; order: number; title: string; note: string }
interface DailyPlanView { id: string; planDate: string; summary: string; items: DailyPlanItemView[]; sourceCode: string; sessionId: string | null; createdAt: string; updatedAt: string }
interface TaskReportView { id: string; periodCode: 'day' | 'week'; periodStart: string; title: string; summaryMd: string; stats: Record<string, unknown>; sessionId: string | null; createdAt: string; updatedAt: string }
interface KnowledgeEntry { id: string; kindCode: string; title: string; contentMd: string; tags: string[]; sourceTaskId: string | null; sourceSessionId: string | null; sourceReviewId: string | null; createdAt: string; updatedAt: string }
interface Idea { id: string; title: string; contentMd: string; kindCode: string; tags: string[]; sourceSessionId: string | null; createdAt: string; updatedAt: string }
interface IdeaClusterView { id: string; title: string; summaryMd: string; tags: string[]; ideas: Idea[]; createdAt: string; updatedAt: string }
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
    list: { getSnapshot(): { items: readonly { workspaceId: string; path?: string }[]; recentWorkspaceId?: string } }
    connectWorkspace(workspaceId: string): Promise<string>
    create?(input: { path: string }): Promise<{ workspaceId?: string }>
  }
  connection?: {
    hostDescription: {
      getSnapshot(): { cwd?: string } | undefined
    }
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
    case 'book': return <svg {...common}><path d="M3 2.5h6.5v11H3zM9.5 2.5H13v11H9.5z" /><path d="M3 2.5v11M13 2.5v11" /></svg>
    case 'idea': return <svg {...common}><path d="M8 2a4 4 0 0 0-1 7.8V12h2V9.8A4 4 0 0 0 8 2z" /><path d="M6.5 14h3" /></svg>
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

function countTaskTree(roots: TaskTreeNode<Task>[]): number {
  return roots.reduce((sum, node) => sum + 1 + countTaskTree(node.children), 0)
}

function TaskTreeRows({ roots, depth, expanded, toggle, dicts, onOpen, selectedId, contextIds }: {
  roots: TaskTreeNode<Task>[]; depth: number; expanded: Set<string>; toggle: (id: string) => void
  dicts: Dict[]; onOpen: (task: Task) => void; selectedId?: string; contextIds?: Set<string>
}): JSX.Element {
  return (
    <>
      {roots.map((node) => (
        <div key={node.task.id}>
          <div className={`wb-row ${selectedId === node.task.id ? 'selected' : ''} ${contextIds?.has(node.task.id) ? 'wb-row-context' : ''}`} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => onOpen(node.task)}>
            <button type="button" className="wb-btn" style={{ padding: '2px 6px', border: 'none', flex: 'none' }} onClick={(e) => { e.stopPropagation(); toggle(node.task.id) }}>
              {node.children.length > 0 ? (expanded.has(node.task.id) ? '▼' : '▶') : '·'}
            </button>
            <TaskRow task={node.task} dicts={dicts} onOpen={onOpen} bare />
          </div>
          {node.children.length > 0 && expanded.has(node.task.id) && (
            <TaskTreeRows roots={node.children} depth={depth + 1} expanded={expanded} toggle={toggle} dicts={dicts} onOpen={onOpen} selectedId={selectedId} contextIds={contextIds} />
          )}
        </div>
      ))}
    </>
  )
}

function TaskRow({ task, dicts, onOpen, selected, bare = false }: { task: Task; dicts: Dict[]; onOpen: (task: Task) => void; selected?: boolean; bare?: boolean }): JSX.Element {
  const due = task.effectiveDueAt === null ? null : new Date(task.effectiveDueAt)
  const now = new Date()
  const dueText = task.statusCode === 'done'
    ? task.effectiveDueAt !== null
      ? fmtTime(task.effectiveDueAt)
      : task.completedAt !== null ? fmtTime(task.completedAt) : ''
    : task.statusCode === 'cancelled'
      ? '已取消'
      : due === null
        ? '无截止'
        : Number.isNaN(due.getTime())
          ? fmtTime(task.effectiveDueAt!)
          : due.toDateString() === now.toDateString()
            ? `今天 ${fmtTime(task.effectiveDueAt!)}`
            : due.getTime() < now.getTime()
              ? `逾期 ${fmtTime(task.effectiveDueAt!)}`
              : fmtTime(task.effectiveDueAt!)
  const content = (
    <>
      <div className="wb-row-title" style={{ fontWeight: 600 }}>{task.title}</div>
      <div className="wb-row-meta">
        <Badge dict={dicts.filter((d) => d.kind === 'type')} code={task.typeCode} />
        <Badge dict={dicts.filter((d) => d.kind === 'priority')} code={task.priorityCode} />
        <Badge dict={dicts.filter((d) => d.kind === 'status')} code={task.statusCode} />
        <span className="wb-due">{dueText}</span>
      </div>
    </>
  )
  if (bare) return <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>{content}</div>
  return (
    <div className={`wb-row ${selected === true ? 'selected' : ''}`} style={{ flex: 1, minWidth: 0 }} onClick={() => onOpen(task)}>
      {content}
    </div>
  )
}

function MultiSelectDropdown({ label, options, selected, open, onToggle, onClose, onChange, alignRight = false }: {
  label: string
  options: Dict[]
  selected: string[]
  open: boolean
  onToggle: () => void
  onClose: () => void
  onChange: (codes: string[]) => void
  alignRight?: boolean
}): JSX.Element {
  const toggleCode = (code: string): void => {
    onChange(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code])
  }
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="wb-btn" onClick={onToggle} style={{ position: 'relative', zIndex: 25, flex: '0 0 auto', minWidth: 118, maxWidth: 180, overflow: 'hidden' }}>
        <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
        {selected.length === 0 ? (
          <span style={{ color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }}>全部</span>
        ) : (
          <span style={{ color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }}>已选 {selected.length} 项</span>
        )}
        <span style={{ flex: 'none' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={onClose} />
          <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: alignRight ? undefined : 0, right: alignRight ? 0 : undefined, zIndex: 30, minWidth: 240, maxHeight: 320, overflowY: 'auto', background: 'var(--dsw-alias-bg-layer-2, #1c1c1f)', border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.22))', borderRadius: 10, padding: 6, boxShadow: '0 12px 32px rgba(0,0,0,.45)' }}>
            {selected.length > 0 && (
              <div style={{ padding: '6px 8px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))', marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 }}>已选（{selected.length}）</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {selected.map((code) => <Badge key={code} dict={options} code={code} />)}
                </div>
              </div>
            )}
            {options.map((d) => {
              const color = String(d.config.color ?? '#8a9aa8')
              const checked = selected.includes(d.code)
              return (
                <label key={d.code} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${checked ? color : 'transparent'}`, background: checked ? `color-mix(in srgb, ${color} 12%, transparent)` : 'transparent' }}>
                  <input type="checkbox" checked={checked} onChange={() => toggleCode(d.code)} />
                  <span style={{ color, fontWeight: 600, fontSize: 12.5 }}>{d.name}</span>
                </label>
              )
            })}
            {options.length === 0 && <div style={{ padding: '6px 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>无选项</div>}
          </div>
        </>
      )}
    </div>
  )
}

function PlanPanel({ plan, tasks, title, onComplete, onDefer, onRefresh, onClear, onSave, canEdit = true }: {
  plan: DailyPlanView
  tasks: Task[]
  title?: string
  onComplete: (taskId: string) => Promise<void>
  onDefer: (taskId: string) => Promise<void>
  onRefresh?: () => void
  onClear?: () => void
  onSave?: (items: Array<{ taskId: string; note: string }>) => Promise<void>
  canEdit?: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [visibleCount, setVisibleCount] = useState(plan.items.length)
  const [editing, setEditing] = useState(false)
  const [editItems, setEditItems] = useState<Array<{ taskId: string; title: string; note: string }>>([])
  const [saving, setSaving] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const total = plan.items.length
  const taskById = (id: string): Task | undefined => tasks.find((t) => t.id === id)
  const runAction = async (taskId: string, action: () => Promise<void>): Promise<void> => {
    if (actingId !== null) return
    setActingId(taskId)
    try { await action() } finally { setActingId(null) }
  }
  const enterEdit = (): void => {
    setEditItems(plan.items.map((item) => ({ taskId: item.taskId, title: item.title, note: item.note ?? '' })))
    setEditing(true)
  }
  const moveItem = (index: number, delta: -1 | 1): void => {
    setEditItems((prev) => {
      const next = [...prev]
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }
  const updateNote = (index: number, note: string): void => {
    setEditItems((prev) => prev.map((item, i) => (i === index ? { ...item, note } : item)))
  }
  const removeItem = (index: number): void => {
    setEditItems((prev) => prev.filter((_, i) => i !== index))
  }
  const addTask = (taskId: string): void => {
    const task = taskById(taskId)
    if (task === undefined) return
    setEditItems((prev) => (prev.some((item) => item.taskId === taskId) ? prev : [...prev, { taskId, title: task.title, note: '' }]))
  }
  const planDay = new Date(`${plan.planDate}T00:00:00`)
  const isToday = plan.planDate === localDateString()
  const candidateTasks = tasks.filter((t) =>
    t.statusCode !== 'done' && t.statusCode !== 'cancelled' &&
    !editItems.some((item) => item.taskId === t.id) &&
    ((t.effectiveDueAt !== null && sameDay(new Date(t.effectiveDueAt), planDay)) || (isToday && t.effectiveDueAt === null))
  )
  const handleSave = async (): Promise<void> => {
    if (onSave === undefined) return
    if ((plan.sourceCode ?? '') !== 'manual' && !window.confirm('保存将覆盖当前 AI 生成计划并标记为手动编辑，确定继续？')) return
    setSaving(true)
    try {
      await onSave(editItems.map((item, index) => ({ taskId: item.taskId, note: item.note.trim() })))
      setEditing(false)
    } catch {
      // 父级 savePlan 已通过全局错误条展示原因；保持编辑模式让用户修正后重试。
    } finally { setSaving(false) }
  }
  const handleRefresh = (): void => {
    if ((plan.sourceCode ?? '') === 'manual' && !window.confirm('当前计划包含手动调整，重新生成会覆盖手动调整。确定继续？')) return
    onRefresh?.()
  }
  const measureOverflow = useCallback(() => {
    const el = scrollRef.current
    if (el === null || expanded) return
    const over = el.scrollHeight > el.clientHeight + 1
    setOverflowing(over)
    if (!over) {
      setVisibleCount(total)
      return
    }
    const containerRect = el.getBoundingClientRect()
    let count = 0
    for (const item of Array.from(el.querySelectorAll<HTMLElement>('.wb-plan-item'))) {
      const rect = item.getBoundingClientRect()
      if (rect.bottom <= containerRect.bottom + 1) count += 1
      else break
    }
    setVisibleCount(Math.min(Math.max(count, 1), total))
  }, [expanded, total])
  useEffect(() => {
    measureOverflow()
    const el = scrollRef.current
    if (el === null) return
    const ro = new ResizeObserver(() => measureOverflow())
    ro.observe(el)
    return () => ro.disconnect()
  }, [measureOverflow, plan.items, plan.summary])
  return (
    <div className={`wb-card wb-plan ${expanded ? 'wb-plan-expanded' : ''}`}>
      <h4>
        <Icon name="sparkles" />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title ?? `${plan.planDate} 计划`}</span>
        {editing && <span style={{ fontSize: 11, color: '#d9a03f', border: '1px solid rgba(217,160,63,.4)', borderRadius: 6, padding: '1px 6px' }}>编辑模式</span>}
        <span style={{ flex: 1 }} />
        {!editing && overflowing && (
          <button className="wb-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `展开全部（${total}）`}
          </button>
        )}
      </h4>
      {plan.summary !== '' && !editing && <div style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 6 }}>{plan.summary}</div>}
      <div ref={scrollRef} className="wb-plan-scroll">
        {editing ? (
          editItems.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '6px 2px' }}>暂无计划项，可从下方添加任务。</div>
          ) : (
            editItems.map((item, index) => {
              const task = taskById(item.taskId)
              const closed = task !== undefined && (task.statusCode === 'done' || task.statusCode === 'cancelled')
              return (
                <div key={item.taskId} className={`wb-plan-item ${closed ? 'closed' : ''}`}>
                  <span className="wb-plan-num">{index + 1}</span>
                  <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{item.title}</span>
                  <input className="wb-plan-edit-note" value={item.note} onChange={(e) => updateNote(index, e.target.value)} placeholder="备注（可选）" />
                  <span className="wb-plan-edit-actions">
                    <button className="wb-btn" disabled={index === 0} onClick={() => moveItem(index, -1)}>↑</button>
                    <button className="wb-btn" disabled={index === editItems.length - 1} onClick={() => moveItem(index, 1)}>↓</button>
                    <button className="wb-btn" onClick={() => removeItem(index)}>移除</button>
                  </span>
                </div>
              )
            })
          )
        ) : (
          plan.items.map((item, index) => {
            const task = taskById(item.taskId)
            const closed = task !== undefined && (task.statusCode === 'done' || task.statusCode === 'cancelled')
            return (
              <div key={item.taskId} className={`wb-plan-item ${closed ? 'closed' : ''}`}>
                <span className="wb-plan-num">{index + 1}</span>
                <b>{item.title}</b>
                {item.note !== '' && <span className="wb-plan-note">— {item.note}</span>}
                {task !== undefined && !closed && (
                  <span className="wb-plan-item-actions">
                    <button type="button" className="wb-plan-act done" disabled={actingId !== null} onClick={() => void runAction(item.taskId, () => onComplete(item.taskId))}>完成</button>
                    <button type="button" className="wb-plan-act defer" disabled={actingId !== null} onClick={() => void runAction(item.taskId, () => onDefer(item.taskId))}>明天</button>
                  </span>
                )}
              </div>
            )
          })
        )}
      </div>
      <div className="wb-plan-footer">
        {editing ? (
          <>
            <select className="wb-plan-add" defaultValue="" onChange={(e) => { const v = e.target.value; if (v !== '') { addTask(v); e.target.value = '' } }}>
              <option value="">+ 添加任务…</option>
              {candidateTasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <span style={{ flex: 1 }} />
            <button className="wb-btn" disabled={saving} onClick={() => setEditing(false)}>取消</button>
            <button className="wb-btn primary" disabled={saving || editItems.length === 0} onClick={() => void handleSave()}>保存</button>
          </>
        ) : (
          <>
            <span>{overflowing ? `共 ${total} 项 · 默认展示前 ${visibleCount} 项，滚动/展开可查看全部` : `共 ${total} 项 · 已全部展示`}</span>
            <span style={{ flex: 1 }} />
            {canEdit && onSave !== undefined && <button className="wb-btn" onClick={enterEdit}><Icon name="edit" />编辑</button>}
            {canEdit && onRefresh !== undefined && <button className="wb-btn" onClick={handleRefresh}><Icon name="refresh" />重新生成</button>}
            {canEdit && onClear !== undefined && <button className="wb-btn" onClick={() => { if (window.confirm('确定要清除该日计划吗？清除后不可恢复。')) onClear() }}><Icon name="trash" />清除</button>}
          </>
        )}
      </div>
    </div>
  )
}

function DraftBanner({ draft, onDone, runtime, closePanel, kindName }: { draft: DraftView; onDone: () => void; runtime: WorkbenchRuntime; closePanel: () => void; kindName: (kind: string, code: string) => string }): JSX.Element {
  const subtasks = Array.isArray(draft.payload.subtasks) ? draft.payload.subtasks as Array<{ title?: string }> : []
  const [busy, setBusy] = useState(false)
  const act = async (path: string): Promise<void> => {
    setBusy(true)
    try { await api(path, { method: 'POST' }); onDone() } finally { setBusy(false) }
  }
  if (draft.kindCode === 'idea_cluster') {
    const clusters = Array.isArray(draft.payload.clusters) ? draft.payload.clusters as Array<{ title?: string; summary?: string; idea_titles?: string[] }> : []
    const sessionId = typeof draft.sessionId === 'string' && draft.sessionId !== '' ? draft.sessionId : ''
    return (
      <div className="wb-banner review">
        <h4>🧠 点子王提案待确认（{clusters.length}）</h4>
        {clusters.map((cluster, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <b>{cluster.title ?? `点子王 ${i + 1}`}</b>
            {cluster.summary !== undefined && cluster.summary !== '' && <div style={{ fontSize: 12, color: '#999' }}>{cluster.summary}</div>}
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{(cluster.idea_titles ?? []).map((title) => `• ${title}`).join('  ')}</div>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="wb-btn primary" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/confirm`)}>确认生成点子王</button>
          <button className="wb-btn" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/abandon`)}>放弃</button>
          {sessionId !== '' && <button className="wb-btn" onClick={() => { closePanel(); runtime.sessions.open(sessionId) }}>回到关联会话</button>}
        </div>
      </div>
    )
  }
  if (draft.kindCode === 'idea_tasks') {
    const tasks = Array.isArray(draft.payload.tasks) ? draft.payload.tasks as Array<{ title?: string; description?: string }> : []
    const summary = String(draft.payload.summary ?? '')
    const sessionId = typeof draft.sessionId === 'string' && draft.sessionId !== '' ? draft.sessionId : ''
    return (
      <div className="wb-banner completion">
        <h4>🚀 点子落地任务提案（{tasks.length}）</h4>
        {summary !== '' && <div style={{ fontSize: 13, marginBottom: 6 }}>{summary}</div>}
        <ol style={{ margin: '4px 0 8px 20px', padding: 0, fontSize: 14, lineHeight: 1.7 }}>
          {tasks.map((task, i) => <li key={i} style={{ margin: '3px 0' }}><b>{task.title ?? '(未命名任务)'}</b>{task.description !== undefined && task.description !== '' ? <span style={{ color: '#999' }}> — {String(task.description).slice(0, 60)}</span> : null}</li>)}
        </ol>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wb-btn primary" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/confirm`)}>确认转为任务</button>
          <button className="wb-btn" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/abandon`)}>放弃</button>
          {sessionId !== '' && <button className="wb-btn" onClick={() => { closePanel(); runtime.sessions.open(sessionId) }}>回到头脑风暴会话</button>}
        </div>
      </div>
    )
  }
  if (draft.kindCode === 'knowledge') {
    const title = String(draft.payload.title ?? '')
    const contentMd = String(draft.payload.contentMd ?? '')
    const tags = Array.isArray(draft.payload.tags) ? draft.payload.tags as string[] : []
    const sessionId = typeof draft.sessionId === 'string' && draft.sessionId !== '' ? draft.sessionId : ''
    return (
      <div className="wb-banner review">
        <h4>💡 知识条目待确认（{kindName('knowledge_kind', String(draft.payload.kindCode ?? 'lesson'))}）</h4>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
        {tags.length > 0 && <div style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>{tags.map((tag) => `#${tag}`).join(' ')}</div>}
        <div style={{ maxHeight: 240, overflow: 'auto' }}><MarkdownText text={contentMd} /></div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="wb-btn primary" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/confirm`)}>确认入库</button>
          <button className="wb-btn" disabled={busy} onClick={() => void act(`/api/workbench/drafts/${draft.id}/abandon`)}>放弃</button>
          {sessionId !== '' && <button className="wb-btn" onClick={() => { closePanel(); runtime.sessions.open(sessionId) }}>回到会话</button>}
        </div>
      </div>
    )
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
          {sessionId !== '' && <button className="wb-btn" onClick={() => { closePanel(); runtime.sessions.open(sessionId) }}>回到报告会话</button>}
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
          {sessionId !== '' && <button className="wb-btn" onClick={() => { closePanel(); runtime.sessions.open(sessionId) }}>回到排序会话</button>}
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
          {sessionId !== '' && <button className="wb-btn" onClick={() => { closePanel(); runtime.sessions.open(sessionId) }}>回到复盘会话</button>}
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
          {sessionId !== '' && <button className="wb-btn" onClick={() => { closePanel(); runtime.sessions.open(sessionId) }}>回到执行会话</button>}
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

function WorkbenchApp({ runtime, closePanel }: { runtime: WorkbenchRuntime; closePanel: () => void }): JSX.Element {
  const [view, setView] = useState<'today' | 'calendar' | 'list' | 'knowledge' | 'ideas'>('today')
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState<TaskDetail | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [subtaskParent, setSubtaskParent] = useState<Task | null>(null)
  const [editDraft, setEditDraft] = useState<{ title: string; description: string; typeCode: string; priorityCode: string; statusCode: string; aiPolicyCode: string; dueLocal: string; workspacePath: string; recurrenceCode: string } | null>(null)
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
  const [knowledgeEntries, setKnowledgeEntries] = useState<KnowledgeEntry[]>([])
  const [knowledgeQuery, setKnowledgeQuery] = useState('')
  const [knowledgeKind, setKnowledgeKind] = useState<string>('')
  const [selectedKnowledge, setSelectedKnowledge] = useState<KnowledgeEntry | null>(null)
  const [knowledgeDraft, setKnowledgeDraft] = useState<{ title: string; contentMd: string; kindCode: string; tags: string; sourceTaskId: string; sourceReviewId: string } | null>(null)
  const [knowledgeEditId, setKnowledgeEditId] = useState<string | null>(null)
  const [knowledgeRefreshKey, setKnowledgeRefreshKey] = useState(0)
  const [taskKnowledge, setTaskKnowledge] = useState<KnowledgeEntry[]>([])
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [ideaClusters, setIdeaClusters] = useState<IdeaClusterView[]>([])
  const [ideaTab, setIdeaTab] = useState<'ideas' | 'clusters'>('ideas')
  const [ideaQuery, setIdeaQuery] = useState('')
  const [ideaKind, setIdeaKind] = useState('')
  const [selectedIdeaIds, setSelectedIdeaIds] = useState<Set<string>>(new Set())
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null)
  const [selectedCluster, setSelectedCluster] = useState<IdeaClusterView | null>(null)
  const [ideaForm, setIdeaForm] = useState<{ title: string; contentMd: string; kindCode: string; tags: string } | null>(null)
  const [ideaEditId, setIdeaEditId] = useState<string | null>(null)
  const [ideaRefreshKey, setIdeaRefreshKey] = useState(0)
  const [reportRefreshKey, setReportRefreshKey] = useState(0)
  const [todayPlanSession, setTodayPlanSession] = useState<{ sessionId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [promptModal, setPromptModal] = useState<{ title: string; value: string } | null>(null)
  const promptResolveRef = useRef<((value: string | null) => void) | null>(null)
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
          loadTaskKnowledge(selectedRef.current).catch(() => setTaskKnowledge([])),
        ])
        setSelected({ ...detail, events: ev.events, reviews: rv.reviews })
      } catch { setSelected(null); selectedRef.current = null }
    }
  }, [])

  const loadKnowledge = useCallback(async () => {
    const params = new URLSearchParams()
    if (knowledgeQuery.trim() !== '') params.set('q', knowledgeQuery.trim())
    if (knowledgeKind !== '') params.set('kind_code', knowledgeKind)
    const qs = params.toString()
    const res = await api<{ entries: KnowledgeEntry[] }>(`/api/workbench/knowledge${qs === '' ? '' : `?${qs}`}`)
    setKnowledgeEntries(res.entries)
  }, [knowledgeQuery, knowledgeKind])
  useEffect(() => {
    if (view === 'knowledge') void loadKnowledge().catch(() => undefined)
  }, [view, loadKnowledge, knowledgeRefreshKey])
  const loadIdeas = useCallback(async () => {
    const params = new URLSearchParams()
    if (ideaQuery.trim() !== '') params.set('q', ideaQuery.trim())
    if (ideaKind !== '') params.set('kind_code', ideaKind)
    const qs = params.toString()
    const [ideasRes, clustersRes] = await Promise.all([
      api<{ ideas: Idea[] }>(`/api/workbench/ideas${qs === '' ? '' : `?${qs}`}`),
      api<{ clusters: IdeaClusterView[] }>('/api/workbench/idea-clusters'),
    ])
    setIdeas(ideasRes.ideas); setIdeaClusters(clustersRes.clusters)
  }, [ideaQuery, ideaKind])
  useEffect(() => {
    if (view === 'ideas') void loadIdeas().catch(() => undefined)
  }, [view, loadIdeas, ideaRefreshKey])
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
                tag: `dsh-personal-workbench:${reminder.reminderId}`,
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

  const loadTaskKnowledge = async (taskId: string): Promise<void> => {
    const res = await api<{ entries: KnowledgeEntry[] }>(`/api/workbench/knowledge?source_task_id=${encodeURIComponent(taskId)}`)
    setTaskKnowledge(res.entries)
  }
  const openTask = (task: Task): void => {
    selectedRef.current = task.id
    void Promise.all([
      api<TaskDetail>(`/api/workbench/tasks/${task.id}`),
      api<{ events: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${task.id}/events`).catch(() => ({ events: [] })),
      api<{ reviews: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${task.id}/reviews`).catch(() => ({ reviews: [] })),
      loadTaskKnowledge(task.id).catch(() => setTaskKnowledge([])),
    ]).then(([detail, ev, rv]) => setSelected({ ...detail, events: ev.events, reviews: rv.reviews })).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const openTaskById = (taskId: string): void => {
    setView('list')
    selectedRef.current = taskId
    void Promise.all([
      api<TaskDetail>(`/api/workbench/tasks/${taskId}`),
      api<{ events: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${taskId}/events`).catch(() => ({ events: [] })),
      api<{ reviews: Array<Record<string, unknown>> }>(`/api/workbench/tasks/${taskId}/reviews`).catch(() => ({ reviews: [] })),
      loadTaskKnowledge(taskId).catch(() => setTaskKnowledge([])),
    ]).then(([detail, ev, rv]) => setSelected({ ...detail, events: ev.events, reviews: rv.reviews })).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const patchTask = async (id: string, patch: Record<string, unknown>): Promise<void> => {
    await api(`/api/workbench/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    await refresh()
  }
  const completePlanTask = async (taskId: string): Promise<void> => {
    await patchTask(taskId, { statusCode: 'done' })
  }
  const deferPlanTask = async (taskId: string): Promise<void> => {
    const task = tasks.find((t) => t.id === taskId)
    if (task === undefined) return
    const base = task.effectiveDueAt !== null ? new Date(task.effectiveDueAt) : new Date()
    const next = new Date(base)
    next.setDate(next.getDate() + 1)
    await patchTask(taskId, { dueAt: next.toISOString() })
    setNotice(`已推迟到 ${next.getMonth() + 1}/${next.getDate()}`)
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

  const askUserPrompt = (title: string): Promise<string | null> => new Promise((resolve) => {
    promptResolveRef.current = resolve
    setPromptModal({ title, value: '' })
  })
  const confirmPrompt = (): void => {
    const resolve = promptResolveRef.current
    promptResolveRef.current = null
    const value = promptModal?.value ?? ''
    setPromptModal(null)
    resolve?.(value)
  }
  const cancelPrompt = (): void => {
    const resolve = promptResolveRef.current
    promptResolveRef.current = null
    setPromptModal(null)
    resolve?.(null)
  }
  const AI_PROMPT_LABELS: Record<string, string> = {
    plan: 'AI 智能排序 / 今日计划',
    consult: 'AI 咨询',
    breakdown: 'AI 拆解',
    execute: 'AI 执行',
    review: 'AI 复盘',
    report: 'AI 日报 / 周报',
    idea_association: 'AI 点子关联',
    idea_brainstorm: 'AI 点子头脑风暴',
  }
  const startAISession = async (mode: 'clarify' | 'consult' | 'breakdown' | 'execute' | 'review' | 'plan' | 'report' | 'idea_association' | 'idea_brainstorm', task: Task | null, text: string, previousSessions: Array<Record<string, unknown>> = []): Promise<void> => {
    if (mode === 'clarify' && text.trim() === '') return
    const customPrompt = mode === 'clarify' ? '' : await askUserPrompt(AI_PROMPT_LABELS[mode] ?? 'AI 会话')
    if (customPrompt === null) return
    const planAnchor = mode === 'plan' ? (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : localDateString()) : ''
    setBusy(true); setError(null)
    try {
      // 复用型会话：计划/报告/点子关联/点子头脑风暴，每个 scope+anchor 只有一个会话。
      if (mode === 'plan' || mode === 'report' || mode === 'idea_association' || mode === 'idea_brainstorm') {
        const [scopeCode, anchor] = mode === 'plan'
          ? ['daily_plan', planAnchor]
          : mode === 'idea_association' ? ['idea_association', text]
          : mode === 'idea_brainstorm' ? ['idea_brainstorm', text]
          : text.startsWith('week:') ? ['week_report', text.slice(5)] : ['day_report', text.slice(4)]
        const existing = await api<{ session: { sessionId: string } | null }>(`/api/workbench/ai-sessions?scope_code=${scopeCode}&anchor=${anchor}`)
        if (existing.session !== null) {
          let shouldReuse = true
          if (mode === 'plan') {
            const hasPlan = planAnchor === localDateString()
              ? todayPlan !== null
              : pickedPlan !== null && pickedPlan.planDate === planAnchor
            const hasPendingPlanDraft = pendingDraft !== null && pendingDraft.kindCode === 'daily_plan' && String(pendingDraft.payload.planDate ?? '') === planAnchor
            shouldReuse = hasPlan || hasPendingPlanDraft
          }
          if (shouldReuse) {
            closePanel()
            runtime.sessions.open(existing.session.sessionId)
            return
          }
        }
        if (mode === 'report') {
          // 旧版本生成的报告可能还没有登记会话：直接复用报告里的 session_id。
          const periodCode = text.startsWith('week:') ? 'week' : 'day'
          const rep = await api<{ report: { sessionId?: string | null } | null }>(`/api/workbench/reports/${periodCode}/${anchor}`)
          if (typeof rep.report?.sessionId === 'string' && rep.report.sessionId !== '') {
            closePanel()
            runtime.sessions.open(rep.report.sessionId)
            return
          }
        }
      }
      const ws = runtime.workspaces.list.getSnapshot()
      let workspaceId = ws.recentWorkspaceId ?? ws.items[0]?.workspaceId
      const hostCwd = runtime.connection?.hostDescription.getSnapshot()?.cwd
      const isWsl = hostCwd !== undefined
        ? isWslStylePath(hostCwd)
        : ws.items.some((item) => typeof item.path === 'string' && isWslStylePath(item.path))
      const pathSep = isWsl ? '/' : '\\'
      let desired = ''
      if (task !== null) {
        desired = task.workspacePath ?? ''
        if (desired === '' && settings.defaultWorkspace !== '' && settings.autoCreateTypeFolders) {
          desired = joinPath(settings.defaultWorkspace, folderForText(task.title), pathSep)
        }
      } else if (mode === 'clarify' && settings.defaultWorkspace !== '' && settings.autoCreateTypeFolders) {
        desired = joinPath(settings.defaultWorkspace, folderForText(text || '需求澄清'), pathSep)
      }
      // WSL 下把 Windows 盘符路径（D:\Code）统一归一化为真实路径（/mnt/d/Code）。
      // 相对路径和已是 /mnt/... 的路径不会被转换；原生 Windows 上不做转换。
      const normalizedDesired = desired === '' ? '' : isWsl ? normalizeWindowsPathToWsl(desired) : desired
      if (normalizedDesired !== '') {
        try {
          await api('/api/workbench/workspaces/ensure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: normalizedDesired }) })
          const created = await runtime.workspaces.create?.({ path: normalizedDesired })
          if (typeof created?.workspaceId === 'string' && created.workspaceId !== '') workspaceId = created.workspaceId
          // 任务没有显式工作区时，把解析出的任务文件夹回写，保证后续会话都进同一文件夹
          if (task !== null && task.workspacePath === null && normalizedDesired !== '') {
            void api(`/api/workbench/tasks/${task.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspacePath: normalizedDesired }) }).catch(() => undefined)
          }
        } catch { /* 目录创建/注册失败则回退当前工作区 */ }
      }
      if (workspaceId === undefined) throw new Error('没有可用工作区，请先在 DSH 中打开一个工作区')
      const id = await runtime.workspaces.connectWorkspace(workspaceId)
      const binding = runtime.sessions.binding(id)
      if (binding === undefined) throw new Error('会话绑定未就绪，请稍后重试')
      await binding.session.rename(mode === 'idea_association' ? '点子关联' : mode === 'idea_brainstorm' ? '点子头脑风暴' : mode === 'report' ? `${text.startsWith('week:') ? '周报' : '日报'}：${text.split(':')[1] ?? ''}` : mode === 'plan' ? `AI 计划：${planAnchor.slice(5)}` : mode === 'clarify' ? `澄清：${text.slice(0, 24)}` : mode === 'consult' ? `协助：${task?.title.slice(0, 24)}` : mode === 'breakdown' ? `拆解：${task?.title.slice(0, 24)}` : mode === 'review' ? `复盘：${task?.title.slice(0, 24)}` : `执行：${task?.title.slice(0, 24)}`).catch(() => undefined)
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
        .filter((t) => t.recurrenceCode === null || t.recurrenceCode === 'none')
        .filter((t) => (t.effectiveDueAt !== null && Date.parse(t.effectiveDueAt) < planDayEnd.getTime()) || (planAnchor === localDateString() && t.effectiveDueAt === null))
        .slice(0, 30)
      const planTaskLines = planCandidates
        .map((t, i) => `${i + 1}. [${t.id}] ${t.title} | 优先级 ${t.priorityCode} | 状态 ${t.statusCode} | 截止 ${t.effectiveDueAt ?? '无'} | 预计耗时 ${t.estimatedMinutes ?? '未知'} 分钟 | 父任务 ${t.parentId ?? '无'}`)
        .join('\n')
      // 任务/子树共享记忆：父任务会话会加载整棵子树上下文，子任务会话也能看到同树记忆。
      let memoryContext = ''
      if (task !== null && (mode === 'execute' || mode === 'consult' || mode === 'breakdown' || mode === 'review')) {
        try {
          const memRes = await api<{ context: string }>(`/api/workbench/tasks/${task.id}/memory-context`)
          memoryContext = memRes.context
        } catch { memoryContext = '' }
      }
      let ideaPrompt = ''
      if (mode === 'idea_association') {
        const selected = ideas.filter((idea) => text.split(',').includes(idea.id))
        const lines = selected.map((idea, i) => `${i + 1}. [${idea.id}] ${idea.title} | 类型 ${idea.kindCode} | 标签 ${idea.tags.join(',') || '无'}\n   ${idea.contentMd || '（无内容）'}`).join('\n')
        ideaPrompt = `你是“个人工作台”的点子关联助手。请分析下面的点子，把它们按主题关联成若干个“点子王”（每组 2 个点子以上，点子尽量不重复跨组；若只能成一组也可以）。\n\n候选点子：\n${lines}\n\n请调用 workbench_propose_idea_clusters：\n- clusters: [{title, summary, idea_ids, notes?}]\n- title 简洁有主题感（例如“AI 语音方向”）；summary 1-2 句说明关联逻辑\n- 只提交提案草稿，不要创建或修改点子本身。`
      }
      if (mode === 'idea_brainstorm') {
        let sourceIdeas: Idea[] = []
        let sourceClusterId: string | null = null
        if (text.startsWith('cluster:')) {
          sourceClusterId = text.slice(8)
          const clusterRes = await api<{ cluster: IdeaClusterView | null }>(`/api/workbench/idea-clusters/${sourceClusterId}`)
          sourceIdeas = clusterRes.cluster?.ideas ?? []
        } else {
          sourceIdeas = ideas.filter((idea) => text.slice(5).split(',').includes(idea.id))
        }
        const lines = sourceIdeas.map((idea, i) => `${i + 1}. [${idea.id}] ${idea.title} | 类型 ${idea.kindCode} | 标签 ${idea.tags.join(',') || '无'}\n   ${idea.contentMd || '（无内容）'}`).join('\n')
        const typeOptions = dicts.filter((d) => d.kind === 'type').map((d) => `${d.code}=${d.name}`).join(', ')
        ideaPrompt = `你是“个人工作台”的点子落地顾问。请和用户一起把下面${sourceClusterId !== null ? '点子王' : '点子'}头脑风暴成可落地的行动方案。\n\n${sourceClusterId !== null ? `点子王 id：${sourceClusterId}\n` : ''}相关点子：\n${lines}\n\n流程：\n1. 先和用户讨论目标、可行性、第一步（一次问 1-2 个关键问题）\n2. 有结论后调用 workbench_submit_idea_tasks：\n   - source_idea_ids${sourceClusterId !== null ? ' 留空' : '= 讨论的点子 id 数组'}\n   - source_cluster_id${sourceClusterId !== null ? `="${sourceClusterId}"` : ' 留空'}\n   - tasks: 任务数组 {title, description, type_code, priority_code, due_at?, estimated_minutes?, children?}；type_code 必须使用以下字典值：${typeOptions}；priority_code 使用 p0/p1/p2/p3\n   - summary: 1-3 句头脑风暴小结\n3. 只提交提案草稿，不要直接创建任务。`
      }
      const planPrompt = `你是“个人工作台”的 AI 计划助手。请为 ${planAnchor}（${'日一二三四五六'[new Date(`${planAnchor}T00:00:00`).getDay()]}）安排执行顺序。\n\n今天：${localDateString()}；当前时间：${new Date().toISOString()}\n\n候选任务（该日期及之前到期、仍未完成的任务${planAnchor === localDateString() ? '；今天额外包含无截止时间的进行中任务' : ''}，最多 30 条）：\n${planTaskLines || '（无候选任务）'}\n\n请综合考虑：优先级（p0 紧急 > p1 高 > p2 普通 > p3 低）、是否已逾期、截止时间、状态（doing/blocked 优先推进）、预计耗时、父子关系与可能的依赖。如果信息不足，可以先问用户 1-2 个关键问题（例如：当天可投入多少小时、哪些必须当天完成）。\n\n然后调用 workbench_propose_daily_plan：\n- plan_date="${planAnchor}"\n- summary：1-3 句排序思路\n- items：扁平顺序数组（1 号最重要），每项 {task_id, order, note}；note 写清为什么排这里或建议时间块\n- 同一父子链上不要同时出现父任务和它下面的子任务；如需排子任务，只排可执行的叶子，并在 note 中说明属于哪个父任务\n- 只提交计划草稿，不要修改任何任务字段，不要执行任务。`
      const prompt = mode === 'idea_association' || mode === 'idea_brainstorm'
        ? ideaPrompt
        : mode === 'report'
        ? `你是“个人工作台”的日报/周报助手。请根据下面 JSON 数据生成一份 Markdown 报告，然后调用 workbench_submit_report。\n\n报告周期：${text.split(':')[0]}（period_start=${text.split(':')[1] ?? ''}）\n数据：\n${reportContextText}\n\n要求：\n- 结构：今日/本周概览 → 已完成 → 进行中/风险 → 明日/下周建议\n- 只依据给定数据，不要编造；数据不足时如实说明\n- title 简洁；summary_md 用 Markdown；stats 可附 {completed, created} 等数字\n- 只提交草稿，不要修改任务，不要执行任务。`
        : mode === 'plan'
        ? planPrompt
        : mode === 'clarify'
        ? `你是“个人工作台”的任务澄清助手。请按 workbench-intake 规范执行。\n\n用户想创建的任务是：\n「${text}」\n\n当前时间：${new Date().toISOString()}\n默认 AI 工作区：${settings.defaultWorkspace || '未设置'}\n\n请先澄清必要信息（一次一个主题，最多5轮）。如果用户对该任务的 AI 会话有指定工作区，请询问具体路径，并在调用 workbench_submit_task 时传入 workspace_path；否则留空使用默认工作区。信息足够后调用 workbench_submit_task 提交结构化任务草稿。不要执行任务本身。`
        : mode === 'consult'
          ? `你是“个人工作台”的任务协助助手。请针对下面这个任务提供咨询、拆解或复盘建议（咨询模式不执行）。\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode} 状态：${task?.statusCode}\n截止：${task?.effectiveDueAt ?? task?.dueAt ?? '无'}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树）：\n${memoryContext}` : ''}\n\n请先理解任务，再给出建议；如果信息不足，可以一次问一个问题。\n\n重要：如果用户要求把结论/补充信息保存回任务，请调用 workbench_update_task(task_id="${task?.id ?? ''}", description="...") 更新原任务；绝对不要调用 workbench_submit_task 新建任务。`
          : mode === 'breakdown'
            ? `你是“个人工作台”的任务拆解助手。请分析下面这个任务，并调用 workbench_propose_subtasks 提交子任务提案。\n\n父任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode} 截止：${task?.effectiveDueAt ?? task?.dueAt ?? '无'}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树）：\n${memoryContext}` : ''}\n\n粒度规则：每层 2-6 个、最大深度 3 层、叶子 15-240 分钟且有可验证完成标准；子任务的 type_code/priority_code 默认继承父任务；若任务太小，设置 no_breakdown_needed=true。只提交提案，不要执行。如果用户对提案提出修改意见，请带上上一次工具返回的 draft_id 再次调用 workbench_propose_subtasks 更新同一份提案。`
            : mode === 'review'
              ? `你是“个人工作台”的任务复盘助手。请对下面这个已完成任务做复盘：\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树）：\n${memoryContext}` : ''}\n\n请从“做得好 / 做得不好 / 下次改进”三个角度输出 Markdown，并调用 workbench_submit_review(task_id="${task?.id ?? ''}", summary_md="...", lessons=[{"title":"...","content":"..."}])。`
              : `你是“个人工作台”的任务执行助手。请直接完成下面这个任务，不要反复确认已知信息。\n\n任务 id：${task?.id}\n任务标题：${task?.title}\n任务描述：${task?.description || '（无）'}\n类型：${task?.typeCode} 优先级：${task?.priorityCode}\n截止：${task?.effectiveDueAt ?? task?.dueAt ?? '无'}\n${memoryContext !== '' ? `\n任务共享记忆（同一任务/子树，父任务会话会看到整棵子树上下文）：\n${memoryContext}` : ''}\n${previousSessions.length > 0 ? `\n该任务此前已有执行会话：${previousSessions.map((s) => String(s.session_id ?? '')).filter((x) => x !== '').join('、')}\n若这些会话有未完成上下文，请先向用户索取上一会话的总结/未完成事项再继续，不要重复已完成工作。` : ''}\n\n执行过程中请遵守：\n- 如果有关键上下文、阶段性结论、决策或未完成事项，请调用 workbench_save_task_memory(task_id="${task?.id ?? ''}", content="...", kind="note|decision|summary") 写入任务共享记忆，便于后续会话续作。\n- 若当前任务是父任务，且你直接完成父任务，验收通过后系统会级联完成所有未完成子任务。\n- 完成后调用 workbench_request_completion(task_id="${task?.id ?? ''}", summary="2-4句完成总结")，等待用户在个人工作台验收；在用户验收通过前，任务不算完成，不要声称已经完成。若任务无法完成，如实说明原因，不要提交验收。`
      if (mode === 'execute') {
        if (task === null) throw new Error('执行模式需要选择一个任务')
        if (task.statusCode === 'done' || task.statusCode === 'cancelled') throw new Error('该任务已完成或已取消，不能再次执行')
        if (task.aiPolicyCode !== 'execute') throw new Error('该任务未开启“可执行”，请先在任务详情中把 AI 策略改为“可执行”')
      }
      if (mode === 'clarify') setShowQuick(false)
      const finalPrompt = customPrompt.trim() === '' ? prompt : `${prompt}\n\n用户补充要求：\n${customPrompt.trim()}`
      const result = await binding.session.prompt([{ type: 'text', text: finalPrompt }], 'queue')
      if (result.ok === false) throw new Error(result.error !== undefined ? String(result.error) : '发送失败')
      if (mode === 'plan') {
        await api('/api/workbench/ai-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeCode: 'daily_plan', anchor: planAnchor, sessionId: id, workspace: workspaceId }) })
      }
      if (mode === 'report') {
        const [periodCode, periodStart] = text.split(':')
        await api('/api/workbench/ai-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeCode: periodCode === 'week' ? 'week_report' : 'day_report', anchor: periodStart, sessionId: id, workspace: workspaceId }) })
      }
      if (mode === 'idea_association' || mode === 'idea_brainstorm') {
        await api('/api/workbench/ai-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopeCode: mode, anchor: text, sessionId: id, workspace: workspaceId }) })
      }
      if (task !== null && mode !== 'clarify') {
        await api(`/api/workbench/tasks/${task.id}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, roleCode: mode }) }).catch(() => undefined)
      }
      closePanel()
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
    const dueAt = due === '' ? null : new Date(due).toISOString()
    const recurrenceCode = String(form.get('recurrence') ?? 'none')
    const recurrenceAnchor = dueAt !== null ? new Date(dueAt) : new Date()
    await api('/api/workbench/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, description: String(form.get('description') ?? ''), typeCode: String(form.get('type') ?? ''), priorityCode: String(form.get('priority') ?? ''), statusCode: String(form.get('status') ?? 'todo'), workspacePath: String(form.get('workspacePath') ?? '').trim() || null, dueAt, recurrenceCode: recurrenceCode === 'none' ? null : recurrenceCode, recurrenceRule: recurrenceCode === 'none' ? undefined : { interval: 1, startDate: localDateString(recurrenceAnchor), weekdays: [recurrenceAnchor.getDay()], monthDay: recurrenceAnchor.getDate() } }) })
    setShowForm(false); await refresh()
  }
  // 今日/日历/列表三棵树：默认全部收起
  const [todayExpanded, setTodayExpanded] = useState<Set<string>>(new Set())
  const [calendarExpanded, setCalendarExpanded] = useState<Set<string>>(new Set())

  // 树展开状态（列表树记住用户展开）
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([])
  const [archivedMode, setArchivedMode] = useState(false)
  const [taskFilter, setTaskFilter] = useState<TaskFilterState>({ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] })
  const [taskSortKey, setTaskSortKey] = useState<TaskSortKey>('dueAt')
  const [taskSortDir, setTaskSortDir] = useState<TaskSortDir>('asc')
  const [openFilter, setOpenFilter] = useState<'status' | 'priority' | 'type' | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('dsh.personal-workbench.treeExpanded') ?? '[]') as string[]) } catch { return new Set() }
  })
  useEffect(() => {
    try { localStorage.setItem('dsh.personal-workbench.treeExpanded', JSON.stringify([...expanded])) } catch { /* ignore */ }
  }, [expanded])
  const toggleExpanded = (id: string): void => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const toggleTodayExpanded = (id: string): void => setTodayExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const toggleCalendarExpanded = (id: string): void => setCalendarExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const collapseAll = (): void => { setExpanded(new Set()); setTodayExpanded(new Set()); setCalendarExpanded(new Set()) }

  const priorityWeights = useMemo(() => new Map(dictOf('priority').map((d) => [d.code, Number(d.config.weight ?? 99)])), [dicts])
  const taskSorter = useMemo(() => createTaskSorter(taskSortKey, taskSortDir, priorityWeights), [taskSortKey, taskSortDir, priorityWeights])
  const visibleTaskTree = useMemo(() => {
    const source = archivedMode ? archivedTasks : tasks
    return filterTaskTree(buildTaskTree(source, undefined, taskSorter), (t) => matchesTaskFilter(t, taskFilter))
  }, [archivedMode, archivedTasks, tasks, taskSorter, taskFilter])

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
  const savePlan = async (date: string, items: Array<{ taskId: string; note: string }>): Promise<void> => {
    try {
      await api(`/api/workbench/plans/${date}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: items.map((item, index) => ({ taskId: item.taskId, order: index + 1, note: item.note })) }) })
      await refresh()
      setPlanRefreshKey((v) => v + 1)
      setNotice('计划已保存（来源：手动编辑）')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    }
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
  const noDueOpen = tasks.filter((t) => t.effectiveDueAt === null && t.statusCode !== 'done' && t.statusCode !== 'cancelled')
  const planKeep = (t: Task): boolean => (t.effectiveDueAt !== null && sameDay(new Date(t.effectiveDueAt), picked) && t.statusCode !== 'cancelled') || (sameDay(picked, now) && noDueOpen.some((x) => x.id === t.id))
  const doneKeep = (t: Task): boolean => t.completedAt !== null && sameDay(new Date(t.completedAt), picked)
  const pickedPlanOrder = useMemo(() => {
    if (pickedPlan === null || pickedPlan.items.length === 0) return undefined
    return new Map(pickedPlan.items.map((item) => [item.taskId, item.order]))
  }, [pickedPlan])
  const pickedPlanTree = useMemo(() => filterTaskTree(buildTaskTree(tasks, pickedPlanOrder), planKeep), [tasks, picked, pickedPlanOrder]) // eslint 语义同 tasks
  const pickedDoneTree = useMemo(() => filterTaskTree(buildTaskTree(tasks), doneKeep), [tasks, picked])
  // 已完成面板中保留的父/祖父链只是上下文，不应计入统计，也以灰色弱化展示。
  const doneContextIds = (() => {
    const ids = new Set<string>()
    const walk = (nodes: TaskTreeNode<Task>[]): void => {
      for (const node of nodes) {
        if (!doneKeep(node.task)) ids.add(node.task.id)
        walk(node.children)
      }
    }
    walk(pickedDoneTree)
    return ids
  })()

  return (
    <div className="wb-app">
      <div className="wb-h">
        <div className="wb-title"><Icon name="calendar" size={19} />个人工作台</div>
        <div className="wb-segmented">
          <button className={`wb-seg ${view === 'today' ? 'on' : ''}`} onClick={() => setView('today')}><Icon name="today" />今日</button>
          <button className={`wb-seg ${view === 'calendar' ? 'on' : ''}`} onClick={() => setView('calendar')}><Icon name="calendar" />日历</button>
          <button className={`wb-seg ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')}><Icon name="list" />任务</button>
          <button className={`wb-seg ${view === 'knowledge' ? 'on' : ''}`} onClick={() => setView('knowledge')}><Icon name="book" />知识库</button>
          <button className={`wb-seg ${view === 'ideas' ? 'on' : ''}`} onClick={() => setView('ideas')}><Icon name="idea" />点子</button>
        </div>
        <div style={{ flex: 1 }} />
        <button className="wb-btn primary" onClick={() => setShowQuick((v) => !v)} disabled={busy}><Icon name="sparkles" />快速录入</button>
        <button className="wb-btn" onClick={() => setShowForm((v) => !v)}><Icon name="plus" />新建</button>
        <button className="wb-btn" onClick={() => setShowSettings((v) => !v)}><Icon name="settings" />设置</button>
        <button className="wb-btn" onClick={collapseAll}><Icon name="list" />收起全部</button>
        <button className="wb-btn" onClick={() => closePanel()}><Icon name="back" />返回对话</button>
      </div>

      {error !== null && <div className="wb-banner error"><h4><Icon name="bell" />出错了</h4>{error} <button className="wb-btn" onClick={() => setError(null)}>关闭</button></div>}
      {notice !== null && <div className="wb-banner notice"><h4><Icon name="bell" />提示</h4>{notice} <button className="wb-btn" onClick={() => setNotice(null)}>关闭</button></div>}
      {promptModal !== null && (
        <div className="wb-modal-mask" onClick={cancelPrompt}>
          <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
            <h4>补充 AI 提示词</h4>
            <p>{promptModal.title}：可留空，留空则继续使用原有默认提示词；填写后会在默认提示词末尾追加你的补充要求。</p>
            <textarea autoFocus value={promptModal.value} onChange={(e) => setPromptModal((prev) => prev === null ? prev : { ...prev, value: e.target.value })} placeholder="输入你想追加给 AI 的补充要求…" />
            <div className="wb-modal-actions">
              <button className="wb-btn" onClick={cancelPrompt}>取消</button>
              <button className="wb-btn primary" onClick={confirmPrompt}>开始</button>
            </div>
          </div>
        </div>
      )}
      {reminders.length > 0 && (
        <div className="wb-banner reminder">
          <h4><Icon name="bell" />到期提醒（{reminders.length}）</h4>
          {reminders.map((r) => <div key={r.reminderId} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}><span style={{ flex: 1 }}>{r.title} · {fmtTime(r.dueAt)}</span><button className="wb-btn" onClick={() => void fireReminder(r.reminderId)}>知道了</button></div>)}
        </div>
      )}
      {pendingDraft !== null && <DraftBanner draft={pendingDraft} runtime={runtime} closePanel={closePanel} kindName={(kind, code) => dicts.find((d) => d.kind === kind && d.code === code)?.name ?? code} onDone={() => { setPendingDraft(null); setPlanRefreshKey((v) => v + 1); setReportRefreshKey((v) => v + 1); setKnowledgeRefreshKey((v) => v + 1); setIdeaRefreshKey((v) => v + 1); void refresh() }} />}

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
                  try { new Notification('dsh-personal-workbench 通知测试', { body: '如果你看到这条系统通知，说明桌面提醒已正常工作。' }) } catch { /* ignore */ }
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
              <label>重复<select name="recurrence" defaultValue="none">{dictOf('recurrence').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
              <label>AI 会话工作区（可选，留空用默认）<input name="workspacePath" placeholder={settings.defaultWorkspace || '默认工作区未设置'} /></label>
              <label className="full">描述<textarea name="description" rows={2} placeholder="背景 / 目标 / 验收标准（Markdown）" /></label>
              <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary lg" type="submit"><Icon name="check" />保存任务</button><button className="wb-btn" type="button" onClick={() => setShowForm(false)}>取消</button></div>
            </form>
          )}

          {view === 'today' && (
            <>
              <div className="wb-stats wb-stats-sticky">
                <div className="wb-stat"><b>{bootstrap?.stats.overdue ?? 0}</b><span>逾期</span></div>
                <div className="wb-stat"><b>{bootstrap?.stats.todayDue ?? 0}</b><span>今天到期</span></div>
                <div className="wb-stat"><b>{bootstrap?.stats.doing ?? 0}</b><span>进行中</span></div>
                <div className="wb-stat"><b>{bootstrap?.stats.total ?? 0}</b><span>总数</span></div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button className="wb-btn primary" disabled={busy || openTasks.length === 0} onClick={() => void startAISession('plan', null, localDateString())}><Icon name="sparkles" />{todayPlan !== null || (pendingDraft?.kindCode === 'daily_plan' && String(pendingDraft.payload.planDate ?? '') === todayAnchor) ? '继续编辑今日计划' : 'AI 智能排序'}</button>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', alignSelf: 'center' }}>AI 会先提交顺序提案，确认后才生效</span>
              </div>
              {todayPlan !== null && (
                <PlanPanel
                  plan={todayPlan}
                  tasks={tasks}
                  title={`今日计划 · ${todayPlan.planDate}`}
                  onComplete={completePlanTask}
                  onDefer={deferPlanTask}
                  onRefresh={() => void startAISession('plan', null, localDateString())}
                  onClear={() => void clearTodayPlan()}
                  onSave={(items) => savePlan(localDateString(), items)}
                />
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
                    const n = tasks.filter((t) => isTaskDueOnDay(t, d)).length
                    return (
                      <div key={d.toISOString()} className={`wb-day ${sameDay(d, now) ? 'today' : ''} ${sameDay(d, picked) ? 'selected' : ''}`} onClick={() => setPicked(startOfDay(d))}>
                        <div className="wb-day-date" style={{ fontSize: 12, color: '#999' }}>{d.getMonth() + 1}/{d.getDate()}</div>
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
                      <div className="wb-mday-date" style={{ fontSize: 12 }}>{d.getDate()}</div>
                      {tasks.some((t) => isTaskDueOnDay(t, d)) && <div className="wb-chip" style={{ background: '#4f8ef7', marginTop: 2 }}>•</div>}
                    </div>
                  ))}
                </div>
              )}

              <div className="wb-segmented wb-sub-segmented">
                <button className={`wb-seg ${dayTab === 'plan' ? 'on' : ''}`} onClick={() => setDayTab('plan')}><Icon name="list" />计划 <span className="count">{countTaskTree(pickedPlanTree)}</span></button>
                <button className={`wb-seg ${dayTab === 'done' ? 'on' : ''}`} onClick={() => setDayTab('done')}><Icon name="check" />已完成 <span className="count">{countTaskTreeBy(pickedDoneTree, doneKeep)}</span></button>
                <button className={`wb-seg ${dayTab === 'report' ? 'on' : ''}`} onClick={() => setDayTab('report')}><Icon name="report" />报告</button>
              </div>
              {dayTab === 'plan' && (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                    {pickedAnchor < todayAnchor
                      ? <span style={{ fontSize: 12, color: '#999' }}>过去日期只读；如需为今天/未来排期，请选择今天或之后的日期。</span>
                      : <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('plan', null, pickedAnchor)}><Icon name="sparkles" />{pickedPlan !== null || (pendingDraft?.kindCode === 'daily_plan' && String(pendingDraft.payload.planDate ?? '') === pickedAnchor) ? '继续编辑该日计划' : `AI 智能排序（${pickedAnchor}）`}</button>}
                    <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>AI 会先提交顺序提案，确认后才生效</span>
                  </div>
                  {pickedPlan !== null && (
                    <PlanPanel
                      plan={pickedPlan}
                      tasks={tasks}
                      title={`${pickedPlan.planDate} 计划`}
                      canEdit={pickedAnchor >= todayAnchor}
                      onComplete={completePlanTask}
                      onDefer={deferPlanTask}
                      onRefresh={pickedAnchor >= todayAnchor ? () => void startAISession('plan', null, pickedAnchor) : undefined}
                      onClear={() => {
                        void api(`/api/workbench/plans/${pickedAnchor}`, { method: 'DELETE' }).then(() => { setPlanRefreshKey((v) => v + 1); setNotice('该日计划已清除') }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                      }}
                      onSave={(items) => savePlan(pickedAnchor, items)}
                    />
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
                  <TaskTreeRows roots={dayTab === 'plan' ? pickedPlanTree : pickedDoneTree} depth={0} expanded={calendarExpanded} toggle={toggleCalendarExpanded} dicts={dicts} onOpen={openTask} selectedId={selected?.task.id} contextIds={dayTab === 'done' ? doneContextIds : undefined} />
                  {(dayTab === 'plan' ? pickedPlanTree : pickedDoneTree).length === 0 && <div className="wb-empty">{picked.getMonth() + 1}/{picked.getDate()} 没有{dayTab === 'plan' ? '计划任务' : '完成记录'}</div>}
                </div>
              )}
            </>
          )}

          {view === 'knowledge' && (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <input style={{ flex: 1, minWidth: 140, background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }} placeholder="搜索标题 / 内容 / 标签" value={knowledgeQuery} onChange={(e) => setKnowledgeQuery(e.target.value)} />
                <select style={{ background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }} value={knowledgeKind} onChange={(e) => setKnowledgeKind(e.target.value)}>
                  <option value="">全部分类</option>
                  {dictOf('knowledge_kind').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                </select>
                <button className="wb-btn primary" onClick={() => { setKnowledgeEditId(null); setKnowledgeDraft({ title: '', contentMd: '', kindCode: 'note', tags: '', sourceTaskId: '', sourceReviewId: '' }) }}><Icon name="plus" />新建</button>
              </div>
              <div className="wb-list">
                {knowledgeEntries.map((entry) => (
                  <div key={entry.id} className={`wb-row ${selectedKnowledge?.id === entry.id ? 'selected' : ''}`} onClick={() => { setKnowledgeEditId(null); setKnowledgeDraft(null); setSelectedKnowledge(entry) }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{entry.title}</div>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginTop: 3 }}>
                        <Badge dict={dictOf('knowledge_kind')} code={entry.kindCode} />
                        {entry.tags.map((tag) => <span key={tag} style={{ fontSize: 11, color: '#999' }}>#{tag}</span>)}
                        <span style={{ fontSize: 11, color: '#999' }}>{new Date(entry.updatedAt).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {knowledgeEntries.length === 0 && <div className="wb-empty">还没有知识条目，点“新建”或让 AI 在复盘后提交</div>}
              </div>
            </>
          )}

          {view === 'ideas' && (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <button className={`wb-seg ${ideaTab === 'ideas' ? 'on' : ''}`} onClick={() => { setIdeaTab('ideas'); setSelectedCluster(null) }}>点子（{ideas.length}）</button>
                <button className={`wb-seg ${ideaTab === 'clusters' ? 'on' : ''}`} onClick={() => { setIdeaTab('clusters'); setSelectedIdea(null) }}>点子王（{ideaClusters.length}）</button>
                {ideaTab === 'ideas' && <button className="wb-btn primary" onClick={() => { setIdeaEditId(null); setIdeaForm({ title: '', contentMd: '', kindCode: 'spark', tags: '' }); setSelectedIdea(null) }}><Icon name="plus" />记个点子</button>}
              </div>
              {ideaTab === 'ideas' ? (
                <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                    <input style={{ flex: 1, minWidth: 120, background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }} placeholder="搜索点子" value={ideaQuery} onChange={(e) => setIdeaQuery(e.target.value)} />
                    <select style={{ background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }} value={ideaKind} onChange={(e) => setIdeaKind(e.target.value)}>
                      <option value="">全部类型</option>
                      {dictOf('idea_kind').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    {ideas.length >= 2 && <button className="wb-btn primary" disabled={busy} onClick={() => { const ids = selectedIdeaIds.size >= 2 ? [...selectedIdeaIds] : ideas.map((idea) => idea.id); void startAISession('idea_association', null, ids.sort().join(',')) }}>{selectedIdeaIds.size >= 2 ? `AI 找关联（已选 ${selectedIdeaIds.size}）` : `AI 自动找关联（全部 ${ideas.length}）`}</button>}
                    {selectedIdeaIds.size >= 1 && <button className="wb-btn" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `idea:${[...selectedIdeaIds].sort().join(',')}`)}>AI 头脑风暴（已选 {selectedIdeaIds.size}）</button>}
                    <span style={{ fontSize: 12, color: '#999' }}>已选 {selectedIdeaIds.size} 个点子；未选够 2 个时“找关联”会分析全部点子</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 8 }}>
                    {ideas.map((idea) => (
                      <div key={idea.id} className={`wb-card ${selectedIdea?.id === idea.id || selectedIdeaIds.has(idea.id) ? 'selected' : ''}`} style={{ marginBottom: 0, padding: 12, cursor: 'pointer' }} onClick={() => { setSelectedCluster(null); setSelectedIdea(idea) }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                          <input type="checkbox" checked={selectedIdeaIds.has(idea.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => setSelectedIdeaIds((prev) => { const next = new Set(prev); if (e.target.checked) next.add(idea.id); else next.delete(idea.id); return next })} style={{ width: 18, height: 18, flex: 'none', accentColor: 'var(--dsw-alias-state-business-primary, #4f8ef7)', cursor: 'pointer' }} />
                          <b style={{ flex: 1 }}>{idea.title}</b>
                        </div>
                        <div style={{ fontSize: 12, color: '#999', minHeight: 32 }}>{idea.contentMd.replace(/[#*`>]/g, '').slice(0, 60) || '（无内容）'}</div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                          <Badge dict={dictOf('idea_kind')} code={idea.kindCode} />
                          {idea.tags.slice(0, 4).map((tag) => <span key={tag} style={{ fontSize: 11, color: '#999' }}>#{tag}</span>)}
                        </div>
                      </div>
                    ))}
                    {ideas.length === 0 && <div className="wb-empty" style={{ gridColumn: '1 / -1' }}>还没有点子，点“记个点子”把灵感存下来</div>}
                  </div>
                </>
              ) : (
                <div className="wb-list">
                  {ideaClusters.map((cluster) => (
                    <div key={cluster.id} className={`wb-row ${selectedCluster?.id === cluster.id ? 'selected' : ''}`} onClick={() => { setSelectedIdea(null); setSelectedCluster(cluster) }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>👑 {cluster.title} <span style={{ fontSize: 12, color: '#999' }}>（{cluster.ideas.length} 个点子）</span></div>
                        <div style={{ fontSize: 12, color: '#999' }}>{cluster.summaryMd || cluster.ideas.map((idea) => idea.title).join(' / ')}</div>
                      </div>
                    </div>
                  ))}
                  {ideaClusters.length === 0 && <div className="wb-empty">还没有点子王。选中至少 2 个点子后点“AI 找关联”。</div>}
                </div>
              )}
            </>
          )}

          {view === 'list' && (
            <>
              <div style={{ position: 'relative', zIndex: 25, display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  style={{ position: 'relative', zIndex: 25, flex: 1, minWidth: 140, background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }}
                  placeholder="搜索标题 / 描述"
                  value={taskFilter.keyword}
                  onChange={(e) => setTaskFilter((prev) => ({ ...prev, keyword: e.target.value }))}
                />
                <MultiSelectDropdown
                  label="状态"
                  options={dictOf('status')}
                  selected={taskFilter.statusCodes}
                  open={openFilter === 'status'}
                  onToggle={() => setOpenFilter((prev) => prev === 'status' ? null : 'status')}
                  onClose={() => setOpenFilter(null)}
                  onChange={(codes) => setTaskFilter((prev) => ({ ...prev, statusCodes: codes }))}
                />
                <MultiSelectDropdown
                  label="优先级"
                  options={dictOf('priority')}
                  selected={taskFilter.priorityCodes}
                  open={openFilter === 'priority'}
                  onToggle={() => setOpenFilter((prev) => prev === 'priority' ? null : 'priority')}
                  onClose={() => setOpenFilter(null)}
                  onChange={(codes) => setTaskFilter((prev) => ({ ...prev, priorityCodes: codes }))}
                />
                <MultiSelectDropdown
                  label="类型"
                  options={dictOf('type')}
                  selected={taskFilter.typeCodes}
                  open={openFilter === 'type'}
                  onToggle={() => setOpenFilter((prev) => prev === 'type' ? null : 'type')}
                  onClose={() => setOpenFilter(null)}
                  onChange={(codes) => setTaskFilter((prev) => ({ ...prev, typeCodes: codes }))}
                  alignRight
                />
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>排序</span>
                <select
                  style={{ background: 'var(--dsw-alias-bg-base,#17171a)', border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.15))', color: 'inherit', borderRadius: 8, padding: '7px 10px' }}
                  value={taskSortKey}
                  onChange={(e) => setTaskSortKey(e.target.value as TaskSortKey)}
                >
                  <option value="dueAt">截止时间</option>
                  <option value="priority">优先级</option>
                  <option value="createdAt">创建时间</option>
                  <option value="title">标题</option>
                </select>
                <button className="wb-btn" onClick={() => setTaskSortDir((prev) => prev === 'asc' ? 'desc' : 'asc')} title={taskSortDir === 'asc' ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序'}>
                  {taskSortDir === 'asc' ? '↑ 升序' : '↓ 降序'}
                </button>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>共 {countTaskTree(visibleTaskTree)} 条</span>
                <div style={{ flex: 1 }} />
                <button className="wb-btn" disabled={isTaskFilterEmpty(taskFilter)} onClick={() => setTaskFilter({ keyword: '', statusCodes: [], priorityCodes: [], typeCodes: [] })}><Icon name="refresh" />清空</button>
                <button className="wb-btn" onClick={() => {
                  const next = !archivedMode
                  setArchivedMode(next)
                  if (next) { void api<{ tasks: Task[] }>('/api/workbench/tasks?archived=true').then((r) => setArchivedTasks(r.tasks)).catch(() => undefined) }
                }}>{archivedMode ? '返回任务' : '查看归档'}</button>
              </div>
              <div className="wb-list">
                <TaskTreeRows roots={visibleTaskTree} depth={0} expanded={expanded} toggle={toggleExpanded} dicts={dicts} onOpen={openTask} selectedId={selected?.task.id} />
                {archivedMode && archivedTasks.length === 0 && <div className="wb-empty">没有归档任务</div>}
                {!archivedMode && tasks.length === 0 && <div className="wb-empty">还没有任务，点“快速录入”或“新建”开始</div>}
                {!isTaskFilterEmpty(taskFilter) && visibleTaskTree.length === 0 && <div className="wb-empty">没有符合条件的任务，点“清空”恢复完整列表</div>}
              </div>
            </>
          )}
        </div>

        <div className="wb-detail">
          {view === 'ideas'
            ? ideaForm !== null
              ? (
                <form className="wb-form" onSubmit={(e) => {
                  e.preventDefault()
                  if (ideaForm.title.trim() === '') return
                  const tags = ideaForm.tags.split(/[,#，\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 20)
                  const isEdit = ideaEditId !== null
                  void api(isEdit ? `/api/workbench/ideas/${ideaEditId}` : '/api/workbench/ideas', { method: isEdit ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: ideaForm.title.trim(), contentMd: ideaForm.contentMd, kindCode: ideaForm.kindCode, tags }) })
                    .then(() => { setIdeaForm(null); setIdeaEditId(null); setIdeaRefreshKey((v) => v + 1); setNotice(isEdit ? '点子已更新' : '点子已保存') })
                    .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                }}>
                  <h4 className="full" style={{ margin: 0 }}>{ideaEditId === null ? '记个点子' : '编辑点子'}</h4>
                  <label className="full">标题<input value={ideaForm.title} onChange={(e) => setIdeaForm((prev) => prev === null ? prev : { ...prev, title: e.target.value })} placeholder="一句话说清这个点子" /></label>
                  <label>类型<select value={ideaForm.kindCode} onChange={(e) => setIdeaForm((prev) => prev === null ? prev : { ...prev, kindCode: e.target.value })}>{dictOf('idea_kind').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                  <label>标签<input value={ideaForm.tags} onChange={(e) => setIdeaForm((prev) => prev === null ? prev : { ...prev, tags: e.target.value })} placeholder="逗号/空格分隔，如 AI, 语音" /></label>
                  <label className="full">内容（可选，Markdown）<textarea rows={10} value={ideaForm.contentMd} onChange={(e) => setIdeaForm((prev) => prev === null ? prev : { ...prev, contentMd: e.target.value })} /></label>
                  <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit"><Icon name="check" />保存</button><button className="wb-btn" type="button" onClick={() => { setIdeaForm(null); setIdeaEditId(null) }}>取消</button></div>
                </form>
              )
              : selectedCluster !== null
                ? (
                  <div className="wb-card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <h4 style={{ flex: 1, margin: 0 }}>👑 {selectedCluster.title}</h4>
                      <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `cluster:${selectedCluster.id}`)}>AI 头脑风暴</button>
                      <button className="wb-btn" onClick={() => { if (window.confirm('删除这个点子王？（不会删除点子）')) { void api(`/api/workbench/idea-clusters/${selectedCluster.id}`, { method: 'DELETE' }).then(() => { setSelectedCluster(null); setIdeaRefreshKey((v) => v + 1); setNotice('点子王已删除') }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))) } }}><Icon name="trash" />删除</button>
                    </div>
                    <MarkdownText text={selectedCluster.summaryMd || '（暂无总结）'} />
                    <div style={{ marginTop: 10 }}>
                      <b>包含点子（{selectedCluster.ideas.length}）</b>
                      {selectedCluster.ideas.map((idea) => <div key={idea.id} className="wb-row" onClick={() => { setSelectedCluster(null); setSelectedIdea(idea) }} style={{ cursor: 'pointer', marginTop: 4 }}><span style={{ flex: 1 }}>{idea.title}</span><Badge dict={dictOf('idea_kind')} code={idea.kindCode} /></div>)}
                    </div>
                  </div>
                )
                : selectedIdea !== null
                  ? (
                    <div className="wb-card">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <h4 style={{ flex: 1, margin: 0 }}>{selectedIdea.title}</h4>
                        <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `idea:${selectedIdea.id}`)}>AI 头脑风暴</button>
                        <button className="wb-btn" onClick={() => { setIdeaEditId(selectedIdea.id); setIdeaForm({ title: selectedIdea.title, contentMd: selectedIdea.contentMd, kindCode: selectedIdea.kindCode, tags: selectedIdea.tags.join(', ') }) }}><Icon name="edit" />编辑</button>
                        <button className="wb-btn" onClick={() => { if (window.confirm('删除这个点子？')) { void api(`/api/workbench/ideas/${selectedIdea.id}`, { method: 'DELETE' }).then(() => { setSelectedIdea(null); setIdeaRefreshKey((v) => v + 1); setNotice('已删除') }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))) } }}><Icon name="trash" />删除</button>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
                        <Badge dict={dictOf('idea_kind')} code={selectedIdea.kindCode} />
                        {selectedIdea.tags.map((tag) => <span key={tag} style={{ fontSize: 12, color: '#999' }}>#{tag}</span>)}
                      </div>
                      <MarkdownText text={selectedIdea.contentMd || '（暂无内容）'} />
                    </div>
                  )
                  : <div className="wb-empty">← 从左侧选择一个点子/点子王，或点“记个点子”</div>
            : view === 'knowledge'
            ? knowledgeDraft !== null
              ? (
                <form className="wb-form" onSubmit={(e) => {
                  e.preventDefault()
                  if (knowledgeDraft.title.trim() === '') return
                  const tags = knowledgeDraft.tags.split(/[,#，\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 20)
                  const isEdit = knowledgeEditId !== null
                  const payload = { title: knowledgeDraft.title.trim(), contentMd: knowledgeDraft.contentMd, kindCode: knowledgeDraft.kindCode, tags, sourceTaskId: knowledgeDraft.sourceTaskId.trim() === '' ? null : knowledgeDraft.sourceTaskId.trim(), sourceReviewId: knowledgeDraft.sourceReviewId.trim() === '' ? null : knowledgeDraft.sourceReviewId.trim() }
                  void api(isEdit ? `/api/workbench/knowledge/${knowledgeEditId}` : '/api/workbench/knowledge', { method: isEdit ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
                    .then(() => { setKnowledgeDraft(null); setKnowledgeEditId(null); setKnowledgeRefreshKey((v) => v + 1); setNotice(isEdit ? '知识条目已更新' : '知识条目已创建') })
                    .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                }}>
                  <h4 className="full" style={{ margin: 0 }}>{knowledgeEditId === null ? '新建知识条目' : '编辑知识条目'}</h4>
                  <label className="full">标题<input value={knowledgeDraft.title} onChange={(e) => setKnowledgeDraft((prev) => prev === null ? prev : { ...prev, title: e.target.value })} placeholder="可检索的标题" /></label>
                  <label>分类<select value={knowledgeDraft.kindCode} onChange={(e) => setKnowledgeDraft((prev) => prev === null ? prev : { ...prev, kindCode: e.target.value })}>{dictOf('knowledge_kind').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                  <label>标签<input value={knowledgeDraft.tags} onChange={(e) => setKnowledgeDraft((prev) => prev === null ? prev : { ...prev, tags: e.target.value })} placeholder="用逗号/空格分隔，如 TTS, 踩坑" /></label>
                  <label className="full">关联任务 id（可选）<input value={knowledgeDraft.sourceTaskId} onChange={(e) => setKnowledgeDraft((prev) => prev === null ? prev : { ...prev, sourceTaskId: e.target.value })} placeholder="留空表示不关联" /></label>
                  <label className="full">正文（Markdown）<textarea rows={12} value={knowledgeDraft.contentMd} onChange={(e) => setKnowledgeDraft((prev) => prev === null ? prev : { ...prev, contentMd: e.target.value })} /></label>
                  <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit"><Icon name="check" />保存</button><button className="wb-btn" type="button" onClick={() => { setKnowledgeDraft(null); setKnowledgeEditId(null) }}>取消</button></div>
                </form>
              )
              : selectedKnowledge !== null
                ? (
                  <div className="wb-card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <h4 style={{ flex: 1, margin: 0 }}>{selectedKnowledge.title}</h4>
                      <button className="wb-btn" onClick={() => { setKnowledgeEditId(selectedKnowledge.id); setKnowledgeDraft({ title: selectedKnowledge.title, contentMd: selectedKnowledge.contentMd, kindCode: selectedKnowledge.kindCode, tags: selectedKnowledge.tags.join(', '), sourceTaskId: selectedKnowledge.sourceTaskId ?? '', sourceReviewId: selectedKnowledge.sourceReviewId ?? '' }) }}><Icon name="edit" />编辑</button>
                      <button className="wb-btn" onClick={() => { if (window.confirm('删除这条知识？')) { void api(`/api/workbench/knowledge/${selectedKnowledge.id}`, { method: 'DELETE' }).then(() => { setSelectedKnowledge(null); setKnowledgeRefreshKey((v) => v + 1); setNotice('已删除') }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))) } }}><Icon name="trash" />删除</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
                      <Badge dict={dictOf('knowledge_kind')} code={selectedKnowledge.kindCode} />
                      {selectedKnowledge.tags.map((tag) => <span key={tag} style={{ fontSize: 12, color: '#999' }}>#{tag}</span>)}
                    </div>
                    {selectedKnowledge.sourceTaskId !== null && (
                      <div style={{ margin: '8px 0', fontSize: 13 }}>
                        🔗 关联任务：
                        <button className="wb-btn" onClick={() => openTaskById(selectedKnowledge.sourceTaskId!)}>
                          {tasks.find((t) => t.id === selectedKnowledge.sourceTaskId)?.title ?? selectedKnowledge.sourceTaskId}
                        </button>
                      </div>
                    )}
                    <MarkdownText text={selectedKnowledge.contentMd} />
                  </div>
                )
                : <div className="wb-empty">← 从左侧选择或新建知识条目</div>
            : selected === null
            ? <div className="wb-empty">← 从左侧选择一个任务查看详情<br /><span style={{ fontSize: 12 }}>AI 澄清/咨询/拆解会跳转到官方会话区，完成后回这里确认草稿</span></div>
            : (
              <>
                <div className="wb-card">
                  {editDraft === null ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <h4 style={{ flex: 1, margin: 0 }}>{selected.task.title}</h4>
                        {!selected.task.archived && <button className="wb-btn" onClick={() => setEditDraft({ title: selected.task.title, description: selected.task.description, typeCode: selected.task.typeCode, priorityCode: selected.task.priorityCode, statusCode: selected.task.statusCode, aiPolicyCode: selected.task.aiPolicyCode, dueLocal: toLocalInput(selected.task.dueAt), workspacePath: selected.task.workspacePath ?? '', recurrenceCode: selected.task.recurrenceCode ?? 'none' })}><Icon name="edit" />编辑</button>}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
                        <Badge dict={dictOf('type')} code={selected.task.typeCode} />
                        <Badge dict={dictOf('priority')} code={selected.task.priorityCode} />
                        <Badge dict={dictOf('status')} code={selected.task.statusCode} />
                      </div>
                      {!selected.task.archived && (
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '8px 0 4px' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>状态
                            <select style={{ background: 'var(--dsw-alias-bg-base,#17171a)', color: 'inherit', fontWeight: 600, border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.2))', borderRadius: 8, padding: '6px 10px' }} value={selected.task.statusCode} onChange={(e) => void patchTask(selected.task.id, { statusCode: e.target.value })}>
                              {dictOf('status').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                            </select>
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>AI 策略
                            <select style={{ background: 'var(--dsw-alias-bg-base,#17171a)', color: 'inherit', fontWeight: 600, border: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.2))', borderRadius: 8, padding: '6px 10px' }} value={selected.task.aiPolicyCode} onChange={(e) => void patchTask(selected.task.id, { aiPolicyCode: e.target.value })}>
                              {dictOf('ai_policy').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
                            </select>
                          </label>
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>截止：{selected.task.effectiveDueAt === null ? '无' : fmtTime(selected.task.effectiveDueAt)}{selected.task.dueAt === null && selected.task.effectiveDueAt !== null ? '（继承父任务）' : ''}</div>
                      <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>AI 工作区：{selected.task.workspacePath ?? (settings.defaultWorkspace || '默认工作区未设置')}</div>
                      <div style={{ fontSize: 12, color: '#999', marginBottom: 10 }}>
                        重复：{dicts.find((d) => d.kind === 'recurrence' && d.code === (selected.task.recurrenceCode ?? 'none'))?.name ?? '不重复'}
                        {selected.task.recurrenceMasterId !== null ? '（自动生成的实例）' : selected.task.recurrenceCode !== null && selected.task.recurrenceCode !== 'none' ? `（模板，已生成到 ${selected.task.recurrenceLastGenerated ?? '—'}）` : ''}
                      </div>
                      <div style={{ borderTop: '1px solid var(--wb-border)', margin: '10px 0' }} />
                      <MarkdownText text={selected.task.description || '（无描述）'} />
                      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                        {selected.task.archived ? (
                          <button className="wb-btn primary" onClick={() => { void api(`/api/workbench/tasks/${selected.task.id}/restore`, { method: 'POST' }).then(() => { setNotice('任务已恢复'); setArchivedMode(false); void refresh() }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) }}>恢复任务</button>
                        ) : (
                          <>
                            {selected.task.recurrenceMasterId !== null
                              ? <span style={{ fontSize: 12, color: '#999', alignSelf: 'center' }}>这是重复任务自动生成的实例，可直接执行/验收。</span>
                              : selected.task.recurrenceCode !== null && selected.task.recurrenceCode !== 'none'
                                ? <span style={{ fontSize: 12, color: '#999', alignSelf: 'center' }}>重复任务模板：实例会自动生成到“子任务”中，归档模板即停止重复。</span>
                                : selected.task.statusCode === 'done' || selected.task.statusCode === 'cancelled'
                                ? <button className="wb-btn" disabled={busy} onClick={() => {
                                    const existing = selected.sessions.find((x) => x.role_code === 'review')
                                    if (existing !== undefined && typeof existing.session_id === 'string' && existing.session_id !== '') {
                                      closePanel()
                                      runtime.sessions.open(existing.session_id)
                                    } else {
                                      void startAISession('review', selected.task, selected.task.title)
                                    }
                                  }}>{selected.sessions.some((x) => x.role_code === 'review') ? '进入复盘会话' : 'AI 复盘'}</button>
                                : <button className="wb-btn primary" disabled={busy || selected.task.aiPolicyCode !== 'execute'} title={selected.task.aiPolicyCode !== 'execute' ? '请先开启“可执行”' : selected.children.length > 0 ? '执行父任务：验收通过后未完成子任务会级联完成' : selected.sessions.some((x) => x.role_code === 'execute') ? '新建执行会话并携带此前会话提示' : '开始执行'} onClick={() => void startAISession('execute', selected.task, selected.task.title, selected.sessions.filter((x) => x.role_code === 'execute'))}>AI 执行{selected.children.length > 0 ? '（父任务）' : ''}{selected.sessions.some((x) => x.role_code === 'execute') ? '（新会话续作）' : ''}{selected.task.aiPolicyCode !== 'execute' ? '（需可执行）' : ''}</button>}
                            <button className="wb-btn" disabled={busy} onClick={() => void startAISession('consult', selected.task, selected.task.title)}>AI 协助</button>
                            <button className="wb-btn" disabled={busy} onClick={() => void startAISession('breakdown', selected.task, selected.task.title)}>AI 拆解</button>
                            <button className="wb-btn" onClick={() => setSubtaskParent(selected.task)}>+ 子任务</button>
                            <button className="wb-btn" onClick={() => { if (window.confirm('归档后任务会从工作台列表隐藏；可在列表页“查看归档”中恢复。确认归档？')) { const id = selected.task.id; setTasks((list) => list.filter((t) => t.id !== id)); void api(`/api/workbench/tasks/${id}/archive`, { method: 'POST' }).then(() => { setSelected(null); selectedRef.current = null; setNotice('任务已归档，可在列表页“查看归档”恢复。'); void refresh() }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) } }}>归档</button>
                          </>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>
                        {selected.task.aiPolicyCode === 'execute' && selected.task.statusCode !== 'done' && selected.task.statusCode !== 'cancelled'
                          ? selected.children.length > 0
                            ? '执行父任务：验收通过后未完成子任务会级联完成；所有子节点完成后父节点也会自动完成。'
                            : '执行会话完成后，AI 会提交验收申请，由你验收后标记完成。'
                          : ''}
                      </div>
                    </>
                  ) : (
                    <form className="wb-form" onSubmit={(e) => {
                      e.preventDefault()
                      if (editDraft.title.trim() === '') return
                      const payload: Record<string, unknown> = {
                        title: editDraft.title.trim(),
                        description: editDraft.description,
                        typeCode: editDraft.typeCode,
                        priorityCode: editDraft.priorityCode,
                        statusCode: editDraft.statusCode,
                        aiPolicyCode: editDraft.aiPolicyCode,
                        dueAt: editDraft.dueLocal === '' ? null : new Date(editDraft.dueLocal).toISOString(),
                        workspacePath: editDraft.workspacePath.trim() === '' ? null : editDraft.workspacePath.trim(),
                      }
                      // 自动生成的实例不允许改重复规则，编辑保存时也不提交该字段，从源头避免 400。
                      if (selected.task.recurrenceMasterId === null) payload.recurrenceCode = editDraft.recurrenceCode
                      void patchTask(selected.task.id, payload).then(() => { setEditDraft(null); setNotice('任务已更新') }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                    }}>
                      <h4 className="full" style={{ margin: 0 }}><Icon name="edit" />编辑任务</h4>
                      <label className="full">标题<input value={editDraft.title} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, title: e.target.value })} /></label>
                      <label>类型<select value={editDraft.typeCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, typeCode: e.target.value })}>{dictOf('type').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                      <label>优先级<select value={editDraft.priorityCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, priorityCode: e.target.value })}>{dictOf('priority').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                      <label>状态<select value={editDraft.statusCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, statusCode: e.target.value })}>{dictOf('status').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                      <label>AI 策略<select value={editDraft.aiPolicyCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, aiPolicyCode: e.target.value })}>{dictOf('ai_policy').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                      {selected.task.recurrenceMasterId === null
                        ? <label>重复<select value={editDraft.recurrenceCode} onChange={(e) => setEditDraft((prev) => prev === null ? prev : { ...prev, recurrenceCode: e.target.value })}>{dictOf('recurrence').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
                        : <div style={{ fontSize: 12, color: '#999', alignSelf: 'center' }}>重复：由模板任务管理</div>}
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
                  <h4>子任务（{selected.children.length}）{selected.children.length > 0 ? ` · ${selected.children.filter((c) => c.statusCode === 'done').length}/${selected.children.length} 已完成` : ''}</h4>
                  {selected.children.map((c) => <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}><Badge dict={dictOf('status')} code={c.statusCode} /> <span onClick={() => openTask(c)} style={{ cursor: 'pointer' }}>{c.title}</span></div>)}
                  {selected.children.length === 0 && <div style={{ color: '#999', fontSize: 12 }}>无</div>}
                </div>
                <div className="wb-card">
                  <h4>提醒（{selected.reminders.length}）</h4>
                  {selected.reminders.map((r) => <div key={r.id} style={{ fontSize: 12, color: '#999', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}><Icon name="bell" size={13} />{r.offsetMinutes === 0 ? '准时（截止时间）' : `提前 ${r.offsetMinutes} 分钟`} · {r.methodCode === 'os' ? '系统通知' : '页面/桌面通知'} · {r.firedAt === null ? '未触发' : `已触发 ${fmtTime(r.firedAt)}`}</div>)}
                  {selected.task.effectiveDueAt === null
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
                    return <div key={String(s.session_id ?? s.role_code)} style={{ fontSize: 12, color: 'var(--dsw-alias-state-business-primary,#8fa8c8)', cursor: 'pointer', marginBottom: 4 }} onClick={() => { if (sid !== '') { closePanel(); runtime.sessions.open(sid) } }}>#{String(s.role_code ?? '')} · {sid}（点击打开）</div>
                  })}
                </div>
                <div className="wb-card">
                  <h4>复盘记录（{selected.reviews?.length ?? 0}）</h4>
                  {(selected.reviews ?? []).map((rv, i) => {
                    const reviewId = String(rv.id ?? '')
                    const existingKnowledge = taskKnowledge.find((entry) => entry.sourceReviewId === reviewId)
                    return (
                      <div key={String(rv.id ?? i)} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--wb-border-soft)' }}>
                        <MarkdownText text={String(rv.summary_md ?? '')} />
                        {existingKnowledge !== undefined
                          ? <button className="wb-btn" style={{ marginTop: 6 }} onClick={() => { setKnowledgeDraft(null); setKnowledgeEditId(null); setSelectedKnowledge(existingKnowledge); setView('knowledge') }}><Icon name="book" />✅ 已沉淀，打开知识条目</button>
                          : <button className="wb-btn" style={{ marginTop: 6 }} onClick={() => { setKnowledgeEditId(null); setKnowledgeDraft({ title: `复盘：${selected.task.title}`, contentMd: String(rv.summary_md ?? ''), kindCode: 'lesson', tags: '复盘', sourceTaskId: selected.task.id, sourceReviewId: reviewId }); setSelectedKnowledge(null); setView('knowledge') }}><Icon name="book" />💡 沉淀为经验</button>}
                      </div>
                    )
                  })}
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
  if (document.querySelector('style[data-dsh-personal-workbench-style]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshPersonalWorkbenchStyle = ''
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

export const name = 'personal-workbench-client'
export const inject = ['sessions', 'workspaces', 'connection']

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
  root.render(<WorkbenchApp runtime={runtime} closePanel={() => setOpen(false)} />)

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
