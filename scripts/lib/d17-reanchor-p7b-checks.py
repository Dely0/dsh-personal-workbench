"""D17/P7-2 判据重锚：JSX 分四段搬进 src/client/app/ 后，出口自检里
「某组件/某 props 仍挂在装配层」的断言不能再锚 `index.tsx`。

口径（写进每个脚本的注释块）：
- 装配层 = 入口 `src/client/index.tsx` + `src/client/app/{WorkbenchHeader,WorkbenchOverlays,WorkbenchBody,WorkbenchDialogs}.tsx`；
- 域 hook **不在这份名单里** ⇒ 「接线跑进 hook」仍然红；
- 单独锚某一个组件文件的地方（计数类断言）用 UI_BODY / UI_DIALOGS / UI_OVERLAYS。

本脚本先**全部校验**（每个 old 片段必须在目标文件里恰好出现 1 次），有一条不成立就整体中止、
不写任何文件。写回一律 newline="\n"。
"""
import io
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

LIB = os.path.join("scripts", "lib")

APP_BLOCK = '''
# ---------------------------------------------------------------- D17/P7-2：JSX 已分四段搬进 app/
# 判据跟着 owner 走：凡「某组件 / 某 props 仍挂在装配层」的断言不再锚 `index.tsx`，
# 而是锚这四段组件 —— 它们才是装配层的 JSX owner。
# 注意：域 hook 不在这份名单里，所以「接线跑进 hook」仍然会红。
def _app_read(name):
    with open(os.path.join("src", "client", "app", name), encoding="utf-8", newline="") as fh:
        return fh.read().replace("\\r\\n", "\\n")


UI_HEADER = _app_read("WorkbenchHeader.tsx")
UI_OVERLAYS = _app_read("WorkbenchOverlays.tsx")
UI_BODY = _app_read("WorkbenchBody.tsx")
UI_DIALOGS = _app_read("WorkbenchDialogs.tsx")
UI_ALL = "\\n".join((UI_HEADER, UI_OVERLAYS, UI_BODY, UI_DIALOGS))
'''

PATCHES = [
    # ---------------- p1
    ("p1", r'''check(len(re.findall(r"<KnowledgeListView", INDEX)) == 1, "KnowledgeListView 装配一处")''',
     r'''check(len(re.findall(r"<KnowledgeListView", UI_BODY)) == 1, "KnowledgeListView 装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）")'''),
    ("p1", r'''check(len(re.findall(r"<KnowledgeDetailPane", INDEX)) == 1, "KnowledgeDetailPane 装配一处")''',
     r'''check(len(re.findall(r"<KnowledgeDetailPane", UI_BODY)) == 1, "KnowledgeDetailPane 装配一处（同上）")'''),
    # ---------------- p2
    ("p2", r'''check(len(re.findall(r"<IdeasListView", INDEX)) == 1, "IdeasListView 装配一处")''',
     r'''check(len(re.findall(r"<IdeasListView", UI_BODY)) == 1, "IdeasListView 装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）")'''),
    ("p2", r'''check(len(re.findall(r"<IdeasDetailPane", INDEX)) == 1, "IdeasDetailPane 装配一处")''',
     r'''check(len(re.findall(r"<IdeasDetailPane", UI_BODY)) == 1, "IdeasDetailPane 装配一处（同上）")'''),
    ("p2", r'''check("ideas.actions.refresh()" in INDEX, "DraftBanner 走域动作而不是旧 setter")''',
     r'''check("ideas.actions.refresh()" in UI_OVERLAYS, "DraftBanner 走域动作而不是旧 setter（D17/P7-2 起 owner = src/client/app/WorkbenchOverlays.tsx）")'''),
    # ---------------- p3a
    ("p3a", r'''check(len(re.findall(r"<TaskListView", INDEX)) == 1, "TaskListView 装配一处")''',
     r'''check(len(re.findall(r"<TaskListView", UI_BODY)) == 1, "TaskListView 装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）")'''),
    # ---------------- p3b
    ("p3b", r'''check(len(re.findall(r"<TaskDetailPane", INDEX)) == 1, "TaskDetailPane 装配一处")''',
     r'''check(len(re.findall(r"<TaskDetailPane", UI_BODY)) == 1, "TaskDetailPane 装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）")'''),
    ("p3b", r'''check(len(re.findall(r"<IdeasDetailPane", INDEX)) == 1 and len(re.findall(r"<KnowledgeDetailPane", INDEX)) == 1,
      "三路分派仍在入口（ideas / knowledge / task 各一处）")''',
     r'''check(len(re.findall(r"<IdeasDetailPane", UI_BODY)) == 1 and len(re.findall(r"<KnowledgeDetailPane", UI_BODY)) == 1,
      "三路分派仍在装配层（ideas / knowledge / task 各一处；D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）")'''),
    # ---------------- p3c
    ("p3c", r'''check(len(re.findall(r"<TaskCreateModal", strip_comments(INDEX))) == 1, "新建弹窗装配一处")''',
     r'''check(len(re.findall(r"<TaskCreateModal", UI_DIALOGS)) == 1, "新建弹窗装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchDialogs.tsx）")'''),
    ("p3c", r'''check(len(re.findall(r"<TaskEditModal", strip_comments(INDEX))) == 1, "编辑弹窗装配一处")''',
     r'''check(len(re.findall(r"<TaskEditModal", UI_DIALOGS)) == 1, "编辑弹窗装配一处（同上）")'''),
    ("p3c", r'''check("open={forms.showForm}" in INDEX, "新建弹窗的打开与否读 hook（等价于拆分前的 {showForm && …}）")''',
     r'''check("open={forms.showForm}" in UI_DIALOGS, "新建弹窗的打开与否读 hook（等价于拆分前的 {showForm && …}；P7-2 起在 app/WorkbenchDialogs.tsx）")'''),
    ("p3c", r'''check("{editDraft !== null && selected !== null && (" in INDEX,
      "编辑弹窗的守卫仍在调用点（草稿与选中任务都齐了才挂）")''',
     r'''check("{editDraft !== null && selected !== null && (" in UI_DIALOGS,
      "编辑弹窗的守卫仍在调用点（草稿与选中任务都齐了才挂；P7-2 起在 app/WorkbenchDialogs.tsx）")'''),
    ("p3c", r'''check("onSubmit={createTask}" in INDEX, "入口仍把 createTask 交给新建弹窗（onSubmit 原文未变）")''',
     r'''check("onSubmit={createTask}" in UI_DIALOGS, "仍把 createTask 交给新建弹窗（onSubmit 原文未变；P7-2 起在 app/WorkbenchDialogs.tsx）")'''),
    # ---------------- p3d
    ("p3d", r'''    check(prop in INDEX_BARE, f"入口仍装配 {prop}")''',
     r'''    check(prop in UI_BODY, f"装配层仍装配 {prop}（D17/P7-2 起在 app/WorkbenchBody.tsx）")'''),
    ("p3d", r'''check("onRestoreTask={restoreTask}" in INDEX_BARE and "onCreateSubtask={createSubtask}" in INDEX_BARE,
      "入口仍把这两个动作交给详情面板（props 原文未变）")''',
     r'''check("onRestoreTask={restoreTask}" in UI_BODY and "onCreateSubtask={createSubtask}" in UI_BODY,
      "仍把这两个动作交给视图（props 原文未变；P7-2 起在 app/WorkbenchBody.tsx）")'''),
    # ---------------- p4
    ("p4", r'''check("view === 'today' && (\n            <TodayPane" in INDEX, "入口按 view 分派到 TodayPane")''',
     r'''check("view === 'today' && (\n            <TodayPane" in UI_BODY, "按 view 分派到 TodayPane（D17/P7-2 起在 app/WorkbenchBody.tsx）")'''),
    ("p4", r'''check("view === 'calendar' && (\n            <CalendarView" in INDEX, "入口按 view 分派到 CalendarView")''',
     r'''check("view === 'calendar' && (\n            <CalendarView" in UI_BODY, "按 view 分派到 CalendarView（同上）")'''),
    ("p4", r'''check("setPendingDraft(null); bumpPlanRefresh(); bumpReportRefresh();" in INDEX,
      "草稿域 onDone 的跨域刷新走两个 bump 动作（不再直接写 refreshKey）")''',
     r'''check("setPendingDraft(null); bumpPlanRefresh(); bumpReportRefresh();" in UI_OVERLAYS,
      "草稿域 onDone 的跨域刷新走两个 bump 动作（不再直接写 refreshKey；P7-2 起在 app/WorkbenchOverlays.tsx）")'''),
    # ---------------- p5a
    ("p5a", r'''    check(jsx in INDEX_BARE, f"JSX props 原文未动：{jsx}")''',
     r'''    check(jsx in UI_BODY, f"JSX props 原文未动：{jsx}（D17/P7-2 起在 app/WorkbenchBody.tsx）")'''),
    ("p5a", r'''check("{showSettings && (" in INDEX_BARE, "SettingsModal 的条件渲染原文")''',
     r'''check("{showSettings && (" in UI_BODY, "SettingsModal 的条件渲染原文（P7-2 起在 app/WorkbenchBody.tsx）")'''),
    # ---------------- p5b
    ("p5b", r'''check(INDEX_BARE.count("readNotificationCtor(globalThis)") == 2,''',
     r'''check(UI_BODY.count("readNotificationCtor(globalThis)") == 2,'''),
    ("p5b", r'''      "入口两个内联回调仍就地 readNotificationCtor(globalThis)（授权 + 发送测试通知）")''',
     r'''      "装配层两个内联回调仍就地 readNotificationCtor(globalThis)（授权 + 发送测试通知；P7-2 起在 app/WorkbenchBody.tsx）")'''),
    ("p5b", r'''check("onRequestNotifyPermission={() => {" in INDEX_BARE and "onSendTestNotification={() => {" in INDEX_BARE,''',
     r'''check("onRequestNotifyPermission={() => {" in UI_BODY and "onSendTestNotification={() => {" in UI_BODY,'''),
    ("p5b", r'''      "SettingsModal 的两个通知内联回调仍在入口")''',
     r'''      "SettingsModal 的两个通知内联回调仍在装配层（P7-2 起在 app/WorkbenchBody.tsx）")'''),
    ("p5b", r'''for prop in jsx:
    check(prop in INDEX_BARE, f"JSX props 原文未动：{prop[:56]}")''',
     r'''for prop in jsx:
    check(prop in INDEX_BARE or prop in UI_ALL, f"JSX props 原文未动：{prop[:56]}（P7-2 起在 app/ 四段组件里）")'''),
    ("p5b", r'''check(INDEX_BARE.count("onClick={() => void ackReminder(r.reminderId)}") == 2,''',
     r'''check(UI_ALL.count("onClick={() => void ackReminder(r.reminderId)}") == 2,'''),
    ("p5b", r'''      "提醒弹窗与待处理弹窗两处 ackReminder 调用点原文未动")''',
     r'''      "提醒弹窗与待处理弹窗两处 ackReminder 调用点原文未动（P7-2 起在 app/WorkbenchOverlays.tsx 与 app/WorkbenchDialogs.tsx）")'''),
    ("p5b", r'''check(INDEX_BARE.count("reminders.length") >= 2, "reminders 仍是入口的读口（计数 + 弹窗条件）")''',
     r'''check(UI_ALL.count("reminders.length") >= 2, "reminders 仍是装配层的读口（入口计数 + 弹窗条件）")'''),
    # ---------------- p5c
    ("p5c", r'''for prop in jsx:
    check(prop in INDEX_BARE, f"调用点原文未动：{prop[:58]}")''',
     r'''for prop in jsx:
    check(prop in INDEX_BARE or prop in UI_ALL, f"调用点原文未动：{prop[:58]}（P7-2 起在 app/ 四段组件里）")'''),
    ("p5c", r'''check("onDone={() => { setPendingDraft(null); bumpPlanRefresh(); bumpReportRefresh(); knowledge.bumpRefreshKey(); ideas.actions.refresh(); void refresh() }}" in INDEX_BARE,''',
     r'''check("onDone={() => { setPendingDraft(null); bumpPlanRefresh(); bumpReportRefresh(); knowledge.bumpRefreshKey(); ideas.actions.refresh(); void refresh() }}" in UI_OVERLAYS,'''),
    ("p5c", r'''      "DraftBanner 的跨域 onDone 仍在装配层（点子/知识/日期三域一处写）")''',
     r'''      "DraftBanner 的跨域 onDone 仍在装配层（P7-2 起 owner = app/WorkbenchOverlays.tsx；点子/知识/日期三域一处写）")'''),
    ("p5c", r'''    check("ideas.actions.refresh()" in body, "函数体尾部锚点在位（onDone 那行）")''',
     r'''    check("const assembly: WorkbenchAssembly = {" in body, "函数体尾部锚点在位（装配束那行；P7-2 后 onDone 已随 JSX 搬进 app/）")'''),
    # ---------------- p6b
    ("p6b", r'''for snippet in INDEX_KEEP:
    check(snippet in INDEX_BARE, f"仍在入口：{snippet[:64]}")''',
     r'''for snippet in INDEX_KEEP:
    check(snippet in INDEX_BARE or snippet in UI_ALL, f"仍在装配层：{snippet[:64]}")'''),
    # ---------------- p6c
    ("p6c", r'''for snippet in INDEX_KEEP:
    check(snippet in INDEX_BARE, f"仍在入口：{snippet[:66]}")''',
     r'''for snippet in INDEX_KEEP:
    check(snippet in INDEX_BARE or snippet in UI_ALL, f"仍在装配层：{snippet[:66]}")'''),
    ("p6c", r'''check(len(re.findall(r"<PersonaPicker", INDEX_BARE)) == 2, "角色选择器仍挂在两个弹窗里各一次")''',
     r'''check(len(re.findall(r"<PersonaPicker", UI_ALL)) == 2, "角色选择器仍挂在两个弹窗里各一次（P7-2 起在 app/WorkbenchOverlays.tsx 与 app/WorkbenchDialogs.tsx）")'''),
    ("p6c", r'''check(len(re.findall(r"<SkillPicker", INDEX_BARE)) == 2, "技能选择器仍挂在两个弹窗里各一次")''',
     r'''check(len(re.findall(r"<SkillPicker", UI_ALL)) == 2, "技能选择器仍挂在两个弹窗里各一次（同上）")'''),
    ("p6c", r'''check(len(re.findall(r"<ModelPicker", INDEX_BARE)) == 2, "模型选择器仍挂在两个弹窗里各一次")''',
     r'''check(len(re.findall(r"<ModelPicker", UI_ALL)) == 2, "模型选择器仍挂在两个弹窗里各一次（同上）")'''),
    # ---------------- p6d
    ("p6d", r'''for snippet in INDEX_KEEP:
    check(snippet in INDEX_BARE, f"仍在入口：{snippet[:62]}")''',
     r'''for snippet in INDEX_KEEP:
    check(snippet in INDEX_BARE or snippet in UI_ALL, f"仍在装配层：{snippet[:62]}")'''),
]

plans = {}
skipped = 0
for name, old, new in PATCHES:
    path = os.path.join(LIB, f"d17-{name}-exit-check.py")
    src = open(path, encoding="utf-8", newline="").read().replace("\r\n", "\n")
    n = src.count(old)
    if n == 0 and src.count(new) == 1:
        skipped += 1
        continue
    if n != 1:
        print(f"ABORT：{path} 里 old 片段命中 {n} 次（要求恰好 1 次）\n  >>> {old[:120]}")
        sys.exit(1)
    plans.setdefault(path, []).append((old, new))

print(f"（{skipped} 处已在前一次运行里生效，跳过）")
for path, items in plans.items():
    src = open(path, encoding="utf-8", newline="").read().replace("\r\n", "\n")
    if "UI_BODY = _app_read(" not in src:
        if "import os" not in src:
            src = src.replace("import io\n", "import io\nimport os\n", 1)
            if "import os" not in src:
                print(f"ABORT：{path} 里找不到可插入 `import os` 的位置")
                sys.exit(1)
        anchor = next((a for a in ("failures: list[str] = []", "failures = []") if a in src), None)
        if anchor is None:
            print(f"ABORT：{path} 里找不到 failures 列表的插入点")
            sys.exit(1)
        src = src.replace(anchor, APP_BLOCK.strip("\n") + "\n\n" + anchor, 1)
    for old, new in items:
        assert src.count(old) == 1
        src = src.replace(old, new, 1)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(src)
    print(f"✔ 已重锚 {path}（{len(items)} 处）")

print("\n结果：全部重锚完成")
