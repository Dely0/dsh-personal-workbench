#!/usr/bin/env python3
"""D17 P5-1 反向验证：给刚迁移的反馈域 / 设置域实现注入缺陷，确认判据会**真的变红**。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
缺陷分布在三个文件（入口 / 反馈域 hook / 设置域 hook），所以每条变异自带目标路径
（与 `d17-mutate-p3c.py` / `d17-mutate-p3d.py` / `d17-mutate-p4.py` 同构）。

判据面同时落在 node 测试与 python 出口自检里，所以 `run_checks` 同时支持
`node --test <file>.mjs` 与 `python <file>.py` 两类目标。

为什么这十一条：
- M-P5a-1 盯"9 项 state 只有一个 owner"（`showSettings` 这类"只给弹窗用"的状态最容易被
  顺手留在入口，变成两个 owner —— 弹窗开关会与 hook 里的那一份脱钩）；
- M-P5a-2 盯设计 §5 的跨域注入：hook 里丢掉别名、退化回裸 `setError` 就不再是"装配层注入反馈"；
- M-P5a-3 盯纯模块的边界（`SETTINGS_FALLBACK` 复活在入口 = 设置默认值有两份真相）；
- M-P5a-4 盯"HTTP 归属"：入口再内联一次设置装载 effect，就是第二个发 `/settings` 的地方；
- M-P5a-5 盯反馈桥接的**语义**（不清回 `null` 会让同一条提示每帧重推一次 toast）；
- M-P5a-6 盯"toast 宿主全客户端只有一处"（第二个 `useToasts()` = 两条队列，用户看到提示丢一半）；
- M-P5a-7 盯"唯一动作 owner"（`recallSessionRestore` 复制回入口，两份实现会各自维护 sessionOff）；
- M-P5a-8 盯**域边界**（设置域 hook 越界去发提醒域路由 —— P5-2/P5-3 的域不许提前混进来）；
- M-P5a-9 盯 `saveSettings` 的**最要害语义**（不再摘 `quickWorkspaceRecent` = 整表覆盖会把
  快速录入刚记下的工作区顶掉，是 2026-09 那次事故的同一类缺陷）；
- M-P5a-10 盯**判据跟着 owner 走的新锚点**（本批把召回路由的两条断言从入口改指设置域 hook；
  这条变异专打新锚点，防止"改完断言就没人守了"）；
- M-P5a-11 盯本批声称**不需要重锚**的那条既有判据（`test/draftBannerSessionJump.test.mjs`
  锚的是入口 JSX 原文；只要"只换来源、不改调用点文本"，它就该继续守得住）。

用法：python scripts/lib/d17-mutate-p5a.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = "src/client/index.tsx"
# D17/P7-2：四段 JSX 搬进 src/client/app/ —— 提示层的变异靶点跟着 owner 走。
UI_OVERLAYS = os.path.join("src", "client", "app", "WorkbenchOverlays.tsx")
FEEDBACK_HOOK = "src/client/hooks/useWorkbenchFeedback.ts"
SETTINGS_HOOK = "src/client/hooks/useWorkbenchSettings.ts"
BACKUP = os.path.join(os.environ["TEMP"], "d17-p5a-mutate.bak")

EXIT_CHECK = "scripts/lib/d17-p5a-exit-check.py"
QUICK_WORKSPACE_TEST = "test/quickWorkspaceDefault.test.mjs"
KNOWLEDGE_RECALL_TEST = "test/knowledgeRecallRoutes.test.mjs"
DRAFT_BANNER_TEST = "test/draftBannerSessionJump.test.mjs"

PREFS_CALL = ("  const prefs = useWorkbenchSettings({ dictOf, refresh, onError: setError, "
              "onNotice: setNotice, onToast: pushToast })\n")
ACTIONS_END = "  const { setSettings, saveDailyCapacity: saveDailyCapacitySetting } = prefs.actions\n"
INJECT_LINE = ("  const { dictOf, refresh, onError: setError, onNotice: setNotice, "
               "onToast: pushToast } = input\n")

MUTATIONS = [
    (
        "M-P5a-1 入口把 showSettings 收回去自己 useState（同一状态两个 owner）",
        INDEX,
        ACTIONS_END,
        ACTIONS_END + "  const [showSettings, setShowSettings] = useState(false)\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5a-2 设置域 hook 丢掉注入别名、退化回裸 setError（设计 §5）",
        SETTINGS_HOOK,
        INJECT_LINE,
        "  const { dictOf, refresh } = input\n"
        "  const setError = (m: string | null): void => { void m }\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5a-3 入口复活一份 SETTINGS_FALLBACK（纯模块边界被打破）",
        INDEX,
        PREFS_CALL,
        PREFS_CALL + ("  const SETTINGS_FALLBACK = { defaultEstimateMinutes: 30, "
                      "dailyCapacityIncludeOverdue: false } as const\n"),
        [EXIT_CHECK],
    ),
    (
        "M-P5a-4 入口重新内联设置装载 effect（第二处发 /settings）",
        INDEX,
        PREFS_CALL,
        PREFS_CALL + ("  useEffect(() => { void api<{ settings: WorkbenchSettings }>('/api/workbench/settings')"
                      ".then((r) => setSettings(withSettingsFallback(r.settings))).catch(() => undefined) }, [])\n"),
        [EXIT_CHECK],
    ),
    (
        "M-P5a-5 反馈域桥接不再清回 null（同一条提示会重复推 toast）",
        FEEDBACK_HOOK,
        "    if (notice !== null) { pushToast(notice, 'success'); setNotice(null) }",
        "    if (notice !== null) { pushToast(notice, 'success') }",
        [EXIT_CHECK],
    ),
    (
        "M-P5a-6 入口重新自己起 useToasts()（第二个 toast 宿主）",
        INDEX,
        "  const { setError, setNotice, pushToast, dismissToast } = feedback.actions\n",
        "  const { setError, setNotice, pushToast, dismissToast } = feedback.actions\n"
        "  const dupToasts = useToasts()\n  void dupToasts\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5a-7 入口复制一份 recallSessionRestore（唯一动作 owner 被打破）",
        INDEX,
        ACTIONS_END,
        ACTIONS_END + ("  const recallSessionRestore = async (sessionId: string, mode: 'on' | 'clear'): "
                       "Promise<void> => { void sessionId; void mode }\n"),
        [EXIT_CHECK],
    ),
    (
        "M-P5a-8 设置域 hook 越界去发提醒域路由（域边界被打破）",
        SETTINGS_HOOK,
        "      await api('/api/workbench/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(editable) })",
        "      await api('/api/workbench/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(editable) })\n"
        "      await api('/api/workbench/reminders/policy', { method: 'POST', body: '{}' })",
        [EXIT_CHECK],
    ),
    (
        "M-P5a-9 saveSettings 不再摘掉 quickWorkspaceRecent（改回整表覆盖）",
        SETTINGS_HOOK,
        "      const { quickWorkspaceRecent: _ignored, ...editable } = settings\n",
        "      const editable = settings\n",
        [EXIT_CHECK, QUICK_WORKSPACE_TEST],
    ),
    (
        "M-P5a-10 召回日志路由改名（判据跟着 owner 走的新锚点）",
        SETTINGS_HOOK,
        "'/api/workbench/knowledge-recall/log?limit=30'",
        "'/api/workbench/knowledge-recall/log?limit=31'",
        [EXIT_CHECK, KNOWLEDGE_RECALL_TEST],
    ),
    (
        "M-P5a-11 DraftBanner 的 onSettled 不再清投影（声称无需重锚的既有判据）",
        UI_OVERLAYS,
        "        onSettled={() => setPendingDraft(null)}",
        "        onSettled={() => undefined}",
        [DRAFT_BANNER_TEST],
    ),
]


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def read(path):
    return open(path, encoding="utf-8", newline="").read()


def write(path, text):
    # 保留原文件换行风格（本仓库源码是 LF；写成 CRLF 会让 sha256 对不上）
    style = "\r\n" if "\r\n" in read(path) else "\n"
    if style == "\r\n":
        text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    open(path, "w", encoding="utf-8", newline="").write(text)


def run_checks(files):
    """跑一批判据目标；`.mjs` 走 node --test，`.py` 走 python。返回 (退出码, 红行清单)。"""
    codes = []
    fails = []
    for f in files:
        if f.endswith(".py"):
            proc = subprocess.run([sys.executable, f], capture_output=True, text=True,
                                  encoding="utf-8", errors="replace")
        else:
            proc = subprocess.run(["node", "--test", f], capture_output=True, text=True,
                                  encoding="utf-8", errors="replace")
        codes.append(proc.returncode)
        out = (proc.stdout or "") + (proc.stderr or "")
        fails += [l.strip() for l in out.splitlines() if l.strip().startswith("✖")]
    return codes, fails


targets = sorted({t for _, t, _, _, _ in MUTATIONS})
before = {p: sha(p) for p in targets}
for p, h in before.items():
    shutil.copyfile(p, BACKUP + "." + os.path.basename(p))
    print(f"基线 {p} sha256 {h}")

green = 0
try:
    for name, target, old, new, files in MUTATIONS:
        src = read(target).replace("\r\n", "\n")
        if src.count(old) != 1:
            raise SystemExit(f"ABORT [{name}] 锚点命中 {src.count(old)} 次")
        write(target, src.replace(old, new, 1))
        codes, fails = run_checks(files)
        print(f"\n== {name} ==")
        print(f"   exit={codes} 目标={files}")
        for f in fails[:4]:
            print(f"   红: {f[:110]}")
        if all(c == 0 for c in codes):
            green += 1
            print("   ❌ 变异后仍然是绿的 —— 这就是判据盲点")
        shutil.copyfile(BACKUP + "." + os.path.basename(target), target)
finally:
    for p in targets:
        shutil.copyfile(BACKUP + "." + os.path.basename(p), p)

after = {p: sha(p) for p in targets}
print()
for p in targets:
    print(f"还原后 {p} sha256 {after[p]}  一致={after[p] == before[p]}")
assert all(after[p] == before[p] for p in targets), "还原失败，必须手工恢复"

# 还原后再跑一次基线，确认是全绿的（否则"全红"可能是判据自己坏了）
codes, _ = run_checks([EXIT_CHECK, QUICK_WORKSPACE_TEST, KNOWLEDGE_RECALL_TEST, DRAFT_BANNER_TEST])
print(f"\n还原后基线：exit={codes}（应全为 0）")
assert all(c == 0 for c in codes), "还原后基线不是绿的"

print(f"\n结果：{len(MUTATIONS) - green}/{len(MUTATIONS)} 条变异被断言发现")
sys.exit(1 if green else 0)
