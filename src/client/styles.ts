/**
 * 工作台全部样式（从 index.tsx 抽出，便于维护）。
 * 颜色一律走 DSH 宿主令牌 --dsw-alias-*，不引入自有配色，保证与外壳一致。
 * 结构：宿主注入钩子 → 布局 → 组件 → 弹窗/toast → 响应式。
 */
import { ACTIVE_ATTR, ENTRY_ATTR, PENDING_ATTR, VIEW_ATTR } from './constants.js'

export const WORKBENCH_CSS = `[data-pane='conversation'], [class*='centerCol'] { position: relative; }
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
.wb-nav { flex:0 0 min(56%, 880px); min-width:420px; overflow:auto; padding:0 18px 16px; box-sizing:border-box; border-right:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }
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

/* ---- UI 美化：统一卡片/列表/表单视觉，强化 hover/selected/focus 态 ---- */
.wb-card { transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease; }
.wb-card:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 42%, transparent); box-shadow: 0 10px 26px rgba(0,0,0,.12); }
.wb-card.selected { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 70%, transparent) !important; box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 35%, transparent), 0 10px 26px rgba(0,0,0,.14); transform: translateY(-1px); }
.wb-stat { transition: border-color .16s ease, box-shadow .16s ease; }
.wb-stat:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 42%, transparent); box-shadow: 0 4px 14px rgba(0,0,0,.10); }
.wb-row { transition: background .14s ease, box-shadow .14s ease; }
.wb-row.done { opacity: .58; }
.wb-row.done .wb-row-title { text-decoration: line-through; }
.wb-row.selected { box-shadow: inset 3px 0 0 var(--dsw-alias-state-business-primary, #4f8ef7); }
.wb-form input:focus, .wb-form select:focus, .wb-form textarea:focus { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 65%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 16%, transparent); outline: none; }
.wb-idea-card { display: flex; flex-direction: column; margin-bottom: 0; padding: 12px; cursor: pointer; }
.wb-idea-card .wb-idea-summary { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; min-height: 36px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wb-idea-card .wb-idea-foot { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
.wb-file-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--wb-border, rgba(127,127,127,.22)); background: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 5%, transparent); border-radius: 99px; padding: 3px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wb-file-chip code { background: transparent; border: none; padding: 0; }
.wb-cluster-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.wb-empty { border: 1px dashed var(--wb-border-soft, rgba(127,127,127,.16)); border-radius: 12px; margin: 4px; }
/* ---- P0: 任务详情摘要 + Tabs + 吸顶操作条 ---- */
.wb-detail-actions { position: sticky; top: 0; z-index: 16; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; padding: 9px 12px; border: 1px solid var(--wb-border-soft, rgba(127,127,127,.18)); border-radius: 12px; background: color-mix(in srgb, var(--dsw-alias-bg-base, #111) 88%, transparent); backdrop-filter: blur(8px); box-shadow: 0 6px 18px rgba(0,0,0,.08); }
.wb-detail-tabs { display: flex; gap: 4px; margin: 4px 0 12px; border-bottom: 1px solid var(--wb-border-soft, rgba(127,127,127,.16)); }
.wb-detail-tab { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; font-weight: 600; padding: 7px 13px; border-radius: 8px 8px 0 0; cursor: pointer; white-space: nowrap; }
.wb-detail-tab:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 6%, transparent); }
.wb-detail-tab.on { color: var(--dsw-alias-label-primary); box-shadow: inset 0 -2px 0 var(--dsw-alias-state-business-primary, #4f8ef7); }
.wb-detail-tab .count { margin-left: 4px; font-size: 11px; opacity: .8; }
/* ---- P1: 会话 Chip + 事件时间线 ---- */
.wb-session-chip { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--wb-border-soft, rgba(127,127,127,.18)); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 6%, transparent); border-radius: 99px; padding: 5px 11px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; margin: 0 6px 6px 0; transition: border-color .12s ease, background .12s ease; }
.wb-session-chip:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 55%, transparent); color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 12%, transparent); }
.wb-session-role { font-weight: 600; color: var(--dsw-alias-state-business-primary, #4f8ef7); }
.wb-session-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; opacity: .75; }
.wb-session-open { opacity: .6; }
.wb-session-list { display: flex; flex-direction: column; gap: 6px; }
.wb-session-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; border: 1px solid var(--wb-border-soft, rgba(127,127,127,.16)); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 5%, transparent); border-radius: 10px; text-align: left; cursor: pointer; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); transition: border-color .12s ease, background .12s ease; }
.wb-session-row:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 55%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 10%, transparent); }
.wb-session-role { flex: none; font-size: 12px; font-weight: 600; color: var(--dsw-alias-state-business-primary, #4f8ef7); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 10%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 30%, transparent); border-radius: 6px; padding: 2px 7px; white-space: nowrap; }
.wb-session-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-session-open { flex: none; font-size: 12px; opacity: .65; }
.wb-session-picker { margin-top: 10px; border: 1px solid var(--wb-border, rgba(127,127,127,.18)); border-radius: 12px; padding: 10px; background: color-mix(in srgb, var(--dsw-alias-bg-base, #111) 90%, transparent); }
.wb-session-picker-bar { display: flex; gap: 8px; margin-bottom: 8px; }
.wb-session-search { flex: 1; min-width: 0; background: var(--dsw-alias-bg-base,#17171a); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.16)); color: inherit; border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; }
.wb-session-search:focus { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 65%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent); outline: none; }
.wb-session-role-select { background: var(--dsw-alias-bg-base,#17171a); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.16)); color: inherit; border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; }
.wb-session-picker-list { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.wb-session-option { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 1px solid transparent; background: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 4%, transparent); border-radius: 8px; text-align: left; cursor: pointer; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); transition: border-color .12s ease, background .12s ease; }
.wb-session-option:hover:not(:disabled) { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 9%, transparent); }
.wb-session-option:disabled { opacity: .5; cursor: default; }
.wb-session-cwd { flex: none; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: .8; }
.wb-session-add { flex: none; font-size: 12px; font-weight: 600; color: var(--dsw-alias-state-business-primary, #4f8ef7); }
.wb-session-option:disabled .wb-session-add { color: var(--dsw-alias-label-secondary); }
.wb-event-group-date { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; font-size: 12px; font-weight: 700; color: var(--dsw-alias-label-secondary); }
.wb-event-group-date::after { content: ''; flex: 1; height: 1px; background: var(--wb-border-soft, rgba(127,127,127,.16)); }
.wb-event-row { display: flex; align-items: flex-start; gap: 8px; padding: 5px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wb-event-icon { flex: none; width: 18px; text-align: center; line-height: 1.4; }
.wb-event-main { flex: 1; min-width: 0; }
.wb-event-title { color: var(--dsw-alias-label-primary); font-weight: 600; }
.wb-event-meta { opacity: .8; margin-top: 1px; word-break: break-all; }
/* ---- P2: 顶栏窄屏自适应 ---- */
@media (max-width: 1100px) {
  .wb-h { gap: 8px; padding: 10px 12px; }
  .wb-h .wb-label { display: none; }
  .wb-h > .wb-btn { width: 34px; height: 34px; padding: 0; justify-content: center; }
  .wb-h .wb-segmented { flex-wrap: wrap; }
  .wb-h .wb-seg { padding: 6px 9px; font-size: 12.5px; }
  .wb-h .wb-title { font-size: 14px; letter-spacing: 0; }
}
/* ---- P2: Markdown 代码块复制 ---- */
.wb-code-block { position: relative; margin: 8px 0; }
.wb-code-block pre { background: rgba(127,127,127,.10); padding: 10px 12px; border-radius: 8px; overflow: auto; font-size: 12px; margin: 0; }
.wb-code-copy { position: absolute; top: 6px; right: 6px; border-radius: 6px; padding: 2px 7px; font-size: 11px; opacity: .75; }
.wb-blockquote { border-left: 3px solid var(--dsw-alias-state-business-primary, #4f8ef7); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 7%, transparent); border-radius: 0 8px 8px 0; padding: 6px 12px; margin: 8px 0; }

/* ==========================================================================
   弹窗（Modal）：替代"内联面板挤压任务列表"的旧形态。
   签名元素 = 两栏悬浮工作台面板：左分区导航 / 右独立滚动 / 粘性底栏。
   ========================================================================== */
.wb-overlay {
  position: fixed; inset: 0; z-index: 300;
  display: flex; align-items: center; justify-content: center; padding: 24px;
  background: rgba(0,0,0,.52);
  backdrop-filter: blur(2px);
  animation: wb-overlay-in .16s ease-out;
}
@keyframes wb-overlay-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes wb-dialog-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }

.wb-dialog {
  display: flex; flex-direction: column;
  max-height: min(88vh, 900px); width: 100%;
  background: var(--dsw-alias-bg-layer-2, #1c1c1f);
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.22));
  border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0,0,0,.45);
  color: var(--dsw-alias-label-primary, #eee);
  font-family: var(--dsw-font-family, system-ui);
  overflow: hidden;
  animation: wb-dialog-in .18s cubic-bezier(.2,.9,.3,1);
}
.wb-dialog:focus { outline: none; }
.wb-dialog-sm { max-width: 460px; }
.wb-dialog-md { max-width: 620px; }
.wb-dialog-lg { max-width: 860px; }
.wb-dialog-xl { max-width: min(1080px, 94vw); }

.wb-dialog-head {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18));
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.02));
}
.wb-dialog-head h3 { margin: 0; font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.wb-dialog-head h3 svg { width: 16px; height: 16px; color: var(--dsw-alias-state-business-primary, #8fa8c8); }
.wb-dialog-head-extra { flex: 1; display: flex; align-items: center; justify-content: flex-end; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wb-dialog-close {
  flex: none; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.wb-dialog-close:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 8%, transparent); color: var(--dsw-alias-label-primary); }
.wb-dialog-body { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
.wb-dialog-foot {
  flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18));
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.02));
}
.wb-dialog-foot .wb-foot-note { margin-right: auto; font-size: 12px; color: var(--dsw-alias-label-secondary); }

/* 设置面板：左分区导航 + 右内容 */
.wb-settings { display: grid; grid-template-columns: 168px 1fr; gap: 16px; min-height: 340px; }
.wb-settings-nav { display: flex; flex-direction: column; gap: 2px; align-content: start; }
.wb-settings-nav button {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  border: none; background: transparent; color: var(--dsw-alias-label-secondary);
  padding: 8px 10px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 13px;
}
.wb-settings-nav button:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 6%, transparent); color: var(--dsw-alias-label-primary); }
.wb-settings-nav button.on {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent);
  color: var(--dsw-alias-label-primary); font-weight: 600;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 30%, transparent);
}
.wb-settings-nav button .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-business-primary, #4f8ef7); margin-left: auto; flex: none; }
.wb-settings-pane { min-width: 0; }
.wb-settings-pane > section + section { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }
.wb-settings-pane h5 { margin: 0 0 10px; font-size: 13px; font-weight: 700; color: var(--dsw-alias-label-primary); }
.wb-settings-pane .wb-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 6px 0 0; line-height: 1.6; }
.wb-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.wb-field { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.wb-field > span { font-size: 12px; }
.wb-field input, .wb-field select, .wb-field textarea {
  background: var(--dsw-alias-bg-base, #17171a); color: inherit; font: inherit; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18)); border-radius: 9px; padding: 7px 10px; width: 100%; box-sizing: border-box;
}
.wb-field input:focus, .wb-field select:focus, .wb-field textarea:focus {
  outline: none; border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 60%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 16%, transparent);
}
.wb-switch-row { display: flex; align-items: flex-start; gap: 9px; padding: 8px 0; font-size: 13px; }
.wb-switch-row input { margin-top: 2px; flex: none; }
.wb-switch-row .wb-switch-desc { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; line-height: 1.5; }

/* ==========================================================================
   Toast：浮在右上角，不参与布局
   ========================================================================== */
.wb-toasts { position: fixed; top: 16px; right: 16px; z-index: 320; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.wb-toast {
  pointer-events: auto; display: flex; align-items: flex-start; gap: 9px;
  min-width: 220px; max-width: min(380px, 82vw);
  padding: 10px 12px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, #1c1c1f);
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.2));
  box-shadow: 0 10px 30px rgba(0,0,0,.35);
  color: var(--dsw-alias-label-primary, #eee); font-size: 13px; line-height: 1.5;
  animation: wb-toast-in .18s cubic-bezier(.2,.9,.3,1);
}
.wb-toast.leaving { animation: wb-toast-out .18s ease-in forwards; }
@keyframes wb-toast-in { from { opacity: 0; transform: translateX(10px) } to { opacity: 1; transform: none } }
@keyframes wb-toast-out { to { opacity: 0; transform: translateX(10px) } }
.wb-toast-icon { flex: none; width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }
.wb-toast-msg { flex: 1; min-width: 0; word-break: break-word; }
.wb-toast-close { flex: none; border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 6px; }
.wb-toast-close:hover { color: var(--dsw-alias-label-primary); }
.wb-toast-info { border-left: 3px solid #8fa8c8; }
.wb-toast-info .wb-toast-icon { background: color-mix(in srgb, #8fa8c8 22%, transparent); color: #8fa8c8; }
.wb-toast-success { border-left: 3px solid #2E9B7B; }
.wb-toast-success .wb-toast-icon { background: color-mix(in srgb, #2E9B7B 22%, transparent); color: #2E9B7B; }
.wb-toast-warning { border-left: 3px solid #f5b83d; }
.wb-toast-warning .wb-toast-icon { background: color-mix(in srgb, #f5b83d 22%, transparent); color: #f5b83d; }
.wb-toast-error { border-left: 3px solid #e74c3c; }
.wb-toast-error .wb-toast-icon { background: color-mix(in srgb, #e74c3c 22%, transparent); color: #e74c3c; }

/* 待处理入口（替代常驻横幅）：标题栏右上角的小药丸 */
.wb-pending-pill {
  display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 4px 10px;
  border: 1px solid color-mix(in srgb, #f5b83d 45%, transparent);
  background: color-mix(in srgb, #f5b83d 12%, transparent);
  color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer;
}
.wb-pending-pill:hover { background: color-mix(in srgb, #f5b83d 20%, transparent); }
.wb-pending-pill .count { font-weight: 700; }

/* 弹窗内滚动区域（草稿确认等长内容） */
.wb-scroll-area { max-height: min(46vh, 420px); overflow: auto; padding-right: 4px; }

@media (max-width: 900px) {
  .wb-overlay { padding: 12px; }
  .wb-dialog { max-height: 92vh; }
  .wb-settings { grid-template-columns: 1fr; gap: 12px; }
  .wb-settings-nav { flex-direction: row; flex-wrap: wrap; }
  .wb-settings-nav button { width: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .wb-overlay, .wb-dialog, .wb-toast, .wb-toast.leaving { animation: none; }
}
`;