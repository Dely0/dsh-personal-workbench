/* 知识库样式选型共用底座：主题令牌 + 假数据 + 修前/修后切换。
   4 个打样页共同引用；每个页面只写自己的布局差异。 */
(function () {
  const THEME = document.createElement('style');
  THEME.textContent = `
  /* 面板是固定高度的容器，所以打样页也要把自己锁在视口里 ——
     否则 .kbd-scroll 不生效，分页条会被挤到视口下面看不见。 */
  html, body { height:100%; margin:0; padding:0; overflow:hidden; background:#101013; }
  .kbd { --bg:#101013; --sunken:#141418; --card:#1a1a1f; --card-hi:#202027;
    --line:rgba(255,255,255,.13); --line-soft:rgba(255,255,255,.07);
    --fg:#eceef1; --fg-2:#a7b0ba; --fg-3:#7b848e; --accent:#4f8ef7; --accent-2:#8fb6ff; }
  .kbd * { box-sizing:border-box; }
  .kbd { display:flex; height:100%; min-height:0; background:var(--bg); color:var(--fg);
    font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; overflow:hidden; }
  .kbd-list { display:flex; flex-direction:column; min-width:0; min-height:0; flex:1;
    border-right:1px solid var(--line-soft); }
  .kbd-detail { flex:0 0 42%; min-width:0; overflow:auto; padding:18px 20px; }
  .kbd ::-webkit-scrollbar { width:9px; height:9px; }
  .kbd ::-webkit-scrollbar-thumb { background:rgba(255,255,255,.15); border-radius:5px; }
  .kbd-scroll { flex:1; min-height:0; overflow-y:auto; }

  /* ---- 通用小件 ---- */
  .kbd .inp { width:100%; background:var(--sunken); border:1px solid var(--line); color:var(--fg);
    border-radius:9px; padding:7px 10px 7px 30px; font:inherit; font-size:12.5px; }
  .kbd .inpwrap { position:relative; flex:1; min-width:110px; }
  .kbd .inpwrap .ic { position:absolute; left:9px; top:50%; transform:translateY(-50%);
    color:var(--fg-3); font-size:12px; }
  .kbd select.sel { background:var(--sunken); border:1px solid var(--line); color:var(--fg);
    border-radius:9px; padding:7px 9px; font:inherit; font-size:12.5px; }
  .kbd .btn { border:1px solid var(--line); background:transparent; color:var(--fg); border-radius:9px;
    padding:6px 11px; font:inherit; font-size:12.5px; cursor:pointer; white-space:nowrap; }
  .kbd .btn:hover { background:rgba(255,255,255,.06); }
  .kbd .btn.on { border-color:color-mix(in srgb,var(--accent) 55%,transparent);
    background:color-mix(in srgb,var(--accent) 16%,transparent); font-weight:600; }
  .kbd .chip { display:inline-flex; align-items:center; gap:4px; border-radius:999px;
    padding:1px 7px; font-size:10.5px; white-space:nowrap; border:1px solid transparent; }
  .kbd .tg { color:var(--fg-3); font-size:11px; }
  .kbd .stamp { color:var(--fg-3); font-size:11px; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .kbd .ell { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* ---- 分类入口的两种形态 ---- */
  .kbd .legacy { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--line-soft); }
  .kbd .legacy .cap { color:var(--fg-3); font-size:12px; }
  .kbd .legacy select { flex:1; }
  .kbd .legacy .hint { color:var(--fg-3); font-size:11px; white-space:nowrap; }

  /* ---- 分页（修后才有） ---- */
  .kbd .pager { display:flex; align-items:center; gap:9px; padding:9px 12px; border-top:1px solid var(--line-soft);
    background:var(--card); font-size:11.5px; color:var(--fg-3); flex:none; flex-wrap:wrap; }
  .kbd .pager .pages { display:flex; gap:3px; }
  .kbd .pnum { border:1px solid var(--line); background:transparent; color:var(--fg-2); border-radius:7px;
    min-width:27px; padding:3px 6px; font:inherit; font-size:11.5px; cursor:pointer; }
  .kbd .pnum.on { border-color:color-mix(in srgb,var(--accent) 60%,transparent); color:#fff;
    background:color-mix(in srgb,var(--accent) 20%,transparent); font-weight:600; }
  .kbd .pnum:disabled { opacity:.35; }
  .kbd .pager .grow { flex:1; }

  /* ---- 空态 / 详情 ---- */
  .kbd .empty { padding:30px 20px; text-align:center; color:var(--fg-3); font-size:12.5px; }
  .kbd .dt-h { font-size:17px; font-weight:600; margin:0 0 8px; line-height:1.35; }
  .kbd .dt-meta { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
  .kbd .dt-body { color:#cdd3da; font-size:12.5px; line-height:1.85; white-space:pre-wrap; }
  .kbd .dt-sec { margin-top:18px; padding-top:13px; border-top:1px solid var(--line-soft); }
  .kbd .dt-sec h4 { margin:0 0 8px; font-size:12px; color:var(--fg-3); font-weight:600; }
  .kbd .filechip { display:inline-flex; align-items:center; gap:6px; background:var(--sunken);
    border:1px solid var(--line); border-radius:8px; padding:5px 9px; font-size:11.5px; color:var(--fg-2); }

  /* 修前才显示的「无分页」提示 */
  .kbd .noPager { padding:9px 12px; border-top:1px solid var(--line-soft); background:var(--card);
    font-size:11.5px; color:var(--fg-3); flex:none; }
  `;
  document.head.appendChild(THEME);

  /* -------------------- 假数据 -------------------- */
  const KINDS = [
    { code: 'note', name: '笔记', color: '#4F86F7' },
    { code: 'lesson', name: '经验教训', color: '#E7634C' },
    { code: 'decision', name: '决策记录', color: '#8B7BE8' },
    { code: 'snippet', name: '片段/模板', color: '#2E9B7B' },
  ];
  const TAGS = ['踩坑', 'TTS', 'DSH', '工作台', 'SQLite', 'React', '性能', '发布', '内网', '端口'];
  const HEADS = [
    'cloudflared 连 3081 被 WSL2 劫持，改用 3082',
    '插件装盘后必须重启才生效，客户端 bundle 只是热更新',
    'SQLite STRICT 表加列：只追加迁移，别改旧迁移',
    'pnpm test 并发起端口会偶发 ECONNRESET',
    '清单长度要对齐实际列数，否则「看起来对齐」的统计是假的',
    '知识库条目多了以后，下拉分类不适合扫',
    '列表分页与虚拟滚动怎么选：看「行高是否稳定」',
    '搜索必须覆盖正文，不然用户以为搜不到就没这条',
    '任务树筛选要保留父链，否则会出现无父的孤儿行',
    '把「判定」抽成纯函数，组件只渲染 —— 否则不可测',
  ];
  const BODIES = [
    '现象：改完后看起来正常，重启才发现旧 bundle 还在服务。\n原因：宿主页面加载时固化 __DSH_BOOT__。\n解法：装盘后重启 DSH + Ctrl+F5 硬刷新。',
    '背景：知识库条目变多以后下拉列表难扫。\n结论：分类改成可点入口，搜索/筛选/排序/分页一并补齐。\n可复用做法：判定抽成纯函数模块，组件只渲染。',
    '现象：并发跑多个 node --test 文件时偶发 bad port。\n原因：多文件同时起 HTTP 服务。\n解法：对网络层错误重试一次，并把「第几次」写进上下文。',
    '结论：分页适合行高不稳定的树形列表；虚拟滚动适合行高固定的平铺列表。\n取舍：先做分页（实现简单、可复现），虚拟滚动作为同一份数据的另一种窗口。',
  ];

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
  const rnd = mulberry32(20260925);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const NOW = Date.parse('2026-09-25T15:00:00+08:00');

  const ENTRIES = [];
  for (let i = 0; i < 1000; i++) {
    const kind = pick(KINDS);
    const tags = [];
    const n = 1 + Math.floor(rnd() * 3);
    while (tags.length < n) { const t = pick(TAGS); if (!tags.includes(t)) tags.push(t) }
    // 时间按条目序号**确定性**分配，让"前几页"能看到 4 个时间层次：
    // 8 条今天 / 20 条本周（1–5 天）/ 20 条本月（6–14 天）/ 其余更早。
    // 随机分配会让"前几页"全挤在同一天，时间分组的层次就看不出来了。
    let ts;
    if (i < 8) ts = NOW - Math.round(i * 1.1 * 3600000)
    else if (i < 28) ts = NOW - (1 + Math.floor(rnd() * 5)) * 86400000 - Math.floor(rnd() * 43200000)
    else if (i < 48) ts = NOW - (6 + Math.floor(rnd() * 9)) * 86400000 - Math.floor(rnd() * 43200000)
    else if (i < 100) ts = NOW - (15 + Math.floor(rnd() * 30)) * 86400000 - Math.floor(rnd() * 43200000)
    else if (i < 300) ts = NOW - (45 + Math.floor(rnd() * 300)) * 86400000 - Math.floor(rnd() * 43200000)
    else ts = NOW - (345 + Math.floor(rnd() * 500)) * 86400000 - Math.floor(rnd() * 43200000);
    ENTRIES.push({
      id: 'k' + i,
      kindCode: kind.code,
      title: pick(HEADS) + (i > 9 ? '（' + (i + 1) + '）' : ''),
      contentMd: pick(BODIES),
      tags,
      fileLink: rnd() < .3 ? 'D:\\docs\\note-' + (i + 1) + '.md' : null,
      sourceTaskId: rnd() < .38 ? 'task-' + Math.floor(rnd() * 40) : null,
      createdAt: new Date(ts - Math.floor(rnd() * 40) * 86400000).toISOString(),
      updatedAt: new Date(ts).toISOString(),
    });
  }
  ENTRIES.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  /* -------------------- 判定（打样版：与真实实现同一套语义） -------------------- */
  const kindOf = (code) => KINDS.find((k) => k.code === code) ?? KINDS[0];
  const fmtDate = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日` };
  const fmtShort = (iso) => { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` };
  function groupOf(iso) {
    const days = (NOW - Date.parse(iso)) / 86400000;
    if (days < 1) return '今天';
    if (days < 7) return '本周';
    if (days < 31) return '本月';
    if (days < 90) return '近三个月';
    if (days < 365) return '一年内';
    return '更早';
  }
  const GROUP_ORDER = ['今天', '本周', '本月', '近三个月', '一年内', '更早'];

  /**
   * 自适应分组：条目少的组不单独占一行组头（否则 59 条数据会出现"今天 1 / 本周 0"这种稀疏组头），
   * 并回下一个组。返回 [{ name, items }]，保证每个出现的组至少有 MIN_GROUP 条。
   */
  function groupEntries(items) {
    const buckets = new Map(GROUP_ORDER.map((g) => [g, []]));
    for (const e of items) buckets.get(groupOf(e.updatedAt)).push(e);
    const out = [];
    for (const name of GROUP_ORDER) {
      const list = buckets.get(name);
      if (list.length === 0) continue;
      const last = out[out.length - 1];
      if (list.length < 6 && last !== undefined) last.items.push(...list);
      else out.push({ name, items: list.slice() });
    }
    return out;
  }
  function filterEntries(keyword, kind, tag) {
    const q = keyword.trim().toLowerCase();
    return ENTRIES.filter((e) =>
      (kind === 'all' || e.kindCode === kind) &&
      (tag === '' || e.tags.includes(tag)) &&
      (q === '' || (e.title + '\n' + e.contentMd + '\n' + e.tags.join(' ')).toLowerCase().includes(q)));
  }
  const PAGE_SIZE = 50;

  /* -------------------- 状态 + 修前/修后 -------------------- */
  const state = { mode: 'before', keyword: '', kind: 'all', tag: '', page: 1 };

  function pagerHtml(total) {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const p = Math.min(state.page, pages);
    const start = (p - 1) * PAGE_SIZE;
    const around = [];
    for (let i = Math.max(1, p - 1); i <= Math.min(pages, p + 1); i++) around.push(i);
    return `<div class="pager">
      <span>第 ${total === 0 ? 0 : start + 1}–${Math.min(start + PAGE_SIZE, total)} 条 / 共 <b style="color:var(--fg)">${total.toLocaleString('zh-CN')}</b> 条</span>
      <span class="grow"></span>
      <span class="pages">
        <button class="pnum" data-page="1" ${p === 1 ? 'disabled' : ''}>«</button>
        <button class="pnum" data-page="${p - 1}" ${p === 1 ? 'disabled' : ''}>‹</button>
        ${around.map((i) => `<button class="pnum ${i === p ? 'on' : ''}" data-page="${i}">${i}</button>`).join('')}
        <button class="pnum" data-page="${p + 1}" ${p === pages ? 'disabled' : ''}>›</button>
        <button class="pnum" data-page="${pages}" ${p === pages ? 'disabled' : ''}>»</button>
      </span>
      <select class="sel" data-role="pagesize" style="padding:3px 6px;font-size:11.5px"><option>50 / 页</option></select>
    </div>`;
  }
  const noPagerHtml = (total) => `<div class="noPager">只显示前 200 条（共 ${total.toLocaleString('zh-CN')} 条）· 没有分页 / 不能跳页</div>`;
  const afterPager = (total) => pagerHtml(total);
  const beforePager = (total) => noPagerHtml(total);

  /** 供 4 个打样页调用的公共装配。 */
  window.KB = {
    KINDS, TAGS, ENTRIES,
    kindOf, fmtDate, fmtShort, groupOf, groupEntries, filterEntries, PAGE_SIZE,
    state,
    /** 关键词/分类/标签工具条（修前 = 下拉分类，修后 = Tab 分类） */
    toolbar({ tabs = true, tagFilter = true } = {}) {
      const after = state.mode === 'after';
      const counts = { all: ENTRIES.length };
      for (const k of KINDS) counts[k.code] = 0;
      for (const e of ENTRIES) counts[e.kindCode]++;
      const kindEntry = after && tabs
        ? `<div class="tabs">${[{ code: 'all', name: '全部' }, ...KINDS].map((k) => `
            <button class="tab ${state.kind === k.code ? 'on' : ''}" data-kind="${k.code}">
              ${k.code !== 'all' ? `<i style="background:${k.color ?? ''}"></i>` : ''}${k.name}
              <span class="cnt">${counts[k.code].toLocaleString('zh-CN')}</span>
            </button>`).join('')}</div>`
        : after ? '' : `<div class="legacy">
            <span class="cap">分类</span>
            <select class="sel" data-role="kind">
              ${[{ code: 'all', name: '全部' }, ...KINDS].map((k) => `<option value="${k.code}" ${state.kind === k.code ? 'selected' : ''}>${k.name}（${counts[k.code]}）</option>`).join('')}
            </select>
            <span class="hint">← 现状：下拉，要展开才知道有哪些分类</span>
          </div>`;
      const tagChips = after && tagFilter
        ? `<div class="tags">${[''].concat(TAGS.slice(0, 6)).map((t) => `
            <button class="tchip ${state.tag === t ? 'on' : ''}" data-tag="${t}">${t === '' ? '全部标签' : '#' + t}</button>`).join('')}</div>`
        : '';
      return `<div class="kbar">
          <div class="inpwrap"><span class="ic">⌕</span><input class="inp" data-role="kw" placeholder="搜索标题 / 正文 / 标签" value="${state.keyword.replace(/"/g, '&quot;')}"></div>
          ${after ? `<button class="btn" data-role="sort">更新时间 ↓</button>` : `<span class="hint" style="color:var(--fg-3);font-size:11.5px">无排序切换</span>`}
          <button class="btn on" data-role="new">+ 新建</button>
        </div>
        ${kindEntry}
        ${tagChips}`;
    },
    pager: () => (state.mode === 'after' ? afterPager : beforePager),
    detail(entry) {
      if (entry === null || entry === undefined) {
        return `<div class="empty">左侧选一条知识，这里显示正文<br><span style="font-size:11.5px">（详情区沿用现在的样子，本次不改）</span></div>`;
      }
      const k = kindOf(entry.kindCode);
      return `
        <h3 class="dt-h">${entry.title}</h3>
        <div class="dt-meta">
          <span class="chip" style="background:${k.color}22;color:${k.color};border-color:${k.color}66">${k.name}</span>
          ${entry.tags.map((t) => `<span class="tg">#${t}</span>`).join('')}
          <span class="stamp">更新于 ${fmtShort(entry.updatedAt)}</span>
        </div>
        <div class="dt-body">${entry.contentMd}</div>
        ${entry.fileLink ? `<div class="dt-sec"><h4>本地文件</h4><span class="filechip">📄 <code style="color:var(--fg-2)">${entry.fileLink}</code></span></div>` : ''}
        ${entry.sourceTaskId ? `<div class="dt-sec"><h4>关联任务</h4><span class="filechip">🔗 ${entry.sourceTaskId}</span></div>` : ''}`;
    },
    /** 挂载：render(shownEntries) 必须由打样页提供，返回列表行的 HTML。 */
    mount(render) {
      const root = document.querySelector('.kbd');
      const barBox = root.querySelector('[data-bar]');
      const listBox = root.querySelector('[data-list]');
      const pagerBox = root.querySelector('[data-pager]');
      const detailBox = root.querySelector('[data-detail]');

      function draw() {
        const filtered = filterEntries(state.keyword, state.kind, state.tag);
        const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        const page = Math.min(Math.max(1, state.page), pages);
        state.page = page;
        // 修前：没有分页，最多渲染 200 条（现状行为）
        const shown = state.mode === 'after'
          ? filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
          : filtered.slice(0, 200);
        const selected = filtered.find((e) => e.id === state.selectedId) ?? null;

        barBox.innerHTML = window.KB.toolbar();
        listBox.innerHTML = shown.length === 0
          ? '<div class="empty">没有符合条件的知识条目<br><span style="font-size:11.5px">换个关键词，或点「全部」看看</span></div>'
          : render(shown, filtered.length);
        pagerBox.innerHTML = (state.mode === 'after' ? afterPager : beforePager)(filtered.length);
        detailBox.innerHTML = window.KB.detail(selected);
      }
      window.KB.draw = draw;

      root.addEventListener('input', (ev) => {
        if (ev.target.dataset.role === 'kw') { state.keyword = ev.target.value; state.page = 1; draw() }
      });
      root.addEventListener('change', (ev) => {
        if (ev.target.dataset.role === 'kind') { state.kind = ev.target.value; state.page = 1; draw() }
      });
      root.addEventListener('click', (ev) => {
        const t = ev.target;
        const kind = t.closest('[data-kind]');
        if (kind) { state.kind = kind.dataset.kind; state.page = 1; draw(); return }
        const tag = t.closest('[data-tag]');
        if (tag) { state.tag = tag.dataset.tag; state.page = 1; draw(); return }
        const page = t.closest('[data-page]');
        if (page && !page.disabled) { state.page = Number(page.dataset.page); draw(); return }
        const row = t.closest('[data-open]');
        if (row) { state.selectedId = row.dataset.open; draw(); return }
      });

      window.addEventListener('message', (ev) => {
        if (ev.data && ev.data.type === 'kb-demo-mode') {
          state.mode = ev.data.mode;
          state.page = 1;
          document.documentElement.dataset.mode = state.mode;
          draw();
        }
      });
      document.documentElement.dataset.mode = state.mode;
      draw();
      // file:// 下父页面读不到 iframe 的 DOM（跨源），所以靠一条 ready 消息自报"我画好了"
      try { window.parent.postMessage({ type: 'kb-demo-ready', rows: document.querySelectorAll('[data-list] [data-open]').length }, '*') } catch (e) { /* ignore */ }
    },
  };
})();
