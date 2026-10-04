#!/usr/bin/env python3
"""D17 P5-2 反向验证：给刚迁移的提醒域实现注入缺陷，确认判据会**真的变红**。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
缺陷分布在两个文件（入口 / 提醒域 hook），所以每条变异自带目标路径
（与 `d17-mutate-p3c.py` / `d17-mutate-p3d.py` / `d17-mutate-p4.py` / `d17-mutate-p5a.py` 同构）。

判据面是 python 出口自检，`run_checks` 仍同构支持 `.py` 与 `.mjs`。

为什么这十二条：
- M-P5b-1 盯"7 项 state 只有一个 owner"（`reminderModalOpen` 这种"只给弹窗用"的开关最容易
  被顺手留在入口，变成两个 owner —— 自动弹窗与手动关闭会读写不同的那一份）；
- M-P5b-2 盯设计 §5 的跨域注入：hook 里丢掉别名、退化回裸 `setError` 就不再是"装配层注入反馈"；
- M-P5b-3 盯"桌面通知去重集合只有一份"（第二份 `notifiedRef` = 同一批提醒被通知两遍）；
- M-P5b-4 盯"HTTP 归属"：入口再内联一次策略/通道装载 effect，就是第二个发 `/reminders/policy`
  的地方（也正是本批搬走的那条 effect）；
- M-P5b-5 盯 `tickDue` 的**要害守卫**（去掉 `if (!isAlive()) return`，卸载后才回来的响应
  会 setState、发系统通知、写去重集合 —— 这就是原先写这条守卫要防的事）；
- M-P5b-6 盯**域边界**（提醒域 hook 越界去发草稿域路由 —— P5-3 的域不许提前混进来）；
- M-P5b-7 盯**轮询唯一归属**（hook 自己起定时器 = 5 秒 tick 之外再多一个轮询，设计 §7 口径）；
- M-P5b-8 盯 `ackReminder` 的**注入口用法**（丢一句 `currentTaskId() !== null` 闸门就变成
  "确认了但不刷新"，这是本批新加在 hook 侧的两条用法断言之一）；
- M-P5b-9 盯"轮询装配仍留在入口"（把提醒半段改回内联 `api('/reminders/due')`，本批
  `await tickDue(() => alive)` 那一行就白换了）；
- M-P5b-10 盯"只换来源不改调用点文本"的注入面（`desktopNotify: settings.desktopNotify`
  换成常量 `true`，设置域的读口就断了，依赖数组文本却还假装按设置重建）；
- M-P5b-11 盯通知**持久化**（tickDue 不再 `persistNotified()`，刷新页面会对同一条提醒重发）；
- M-P5b-12 盯**判据跟着 owner 走**：入口复制一份 `ackReminder`。本批把这条断言从
  `d17-p5a-exit-check.py` §6（「刻意留在装配层的东西还在」）删掉了，改由 p5b 以
  「入口不存在 + hook 恰好一份」守。所以这条变异**特意把 p5a 也列进判据面**：
  p5a 保持绿正是"移交完成"的证据，红的那一票必须来自 p5b。

用法：python scripts/lib/d17-mutate-p5b.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = "src/client/index.tsx"
REMINDERS_HOOK = "src/client/hooks/useWorkbenchReminders.ts"
BACKUP = os.path.join(os.environ["TEMP"], "d17-p5b-mutate.bak")

EXIT_CHECK = "scripts/lib/d17-p5b-exit-check.py"
P5A_EXIT_CHECK = "scripts/lib/d17-p5a-exit-check.py"
# D17/P5-3 后：混合域轮询 effect 整条搬进这个 hook，"入口轮询改回内联"那条变异的
# 靶点与判据面都跟着 owner 走（p5c §5 的 `"/api/workbench" not in POLLING_BARE` 就是它的守门人）。
P5C_EXIT_CHECK = "scripts/lib/d17-p5c-exit-check.py"
POLLING_HOOK = "src/client/hooks/useWorkbenchPolling.ts"

ACTIONS_END = "  const { reminders } = remindersApi\n"
ALIAS_BLOCK = (
    "  const {\n"
    "    currentTaskId, refresh, showSettings, desktopNotify,\n"
    "    onError: setError, onNotice: setNotice, onToast: pushToast,\n"
    "  } = input\n"
)
GUARD = "    if (!isAlive()) return\n"
TICK_HEAD = "  const tickDue = useCallback(async (isAlive: () => boolean): Promise<void> => {"
PERSIST_LINE = "      if (notifiedAny) persistNotified()\n"
ACK_GATE = "    if (currentTaskId() !== null) await refresh()\n"
TEST_EP = ("      const result = await api<{ ok: boolean; reason?: string }>"
           "('/api/workbench/reminders/test', { method: 'POST' })")
# D17/P5-3 起入口有**两处** `desktopNotify: settings.desktopNotify`（提醒域 + 轮询装配器），
# 所以锚点必须带上提醒域那一行唯一的尾巴（`showSettings, … onToast: pushToast })`），
# 与 p5b 出口自检的 HOOK_CALL 原文同一段 —— 否则锚点命中 2 次、脚本直接 ABORT。
DESKTOP_ARG = ("showSettings, desktopNotify: settings.desktopNotify, "
               "onError: setError, onNotice: setNotice, onToast: pushToast })")
DESKTOP_ARG_MUT = ("showSettings, desktopNotify: true, "
                   "onError: setError, onNotice: setNotice, onToast: pushToast })")
DUE_INLINE = ("        const r = await api<{ reminders: Array<{ reminderId: string; taskId: string; "
              "title: string; dueAt: string; methodCode: string }> }>('/api/workbench/reminders/due')\n"
              "        void r\n")

MUTATIONS = [
    (
        "M-P5b-1 入口把 reminderModalOpen 收回去自己 useState（同一状态两个 owner）",
        INDEX,
        ACTIONS_END,
        ACTIONS_END + "  const [reminderModalOpen, setReminderModalOpen] = useState(false)\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5b-2 提醒域 hook 丢掉注入别名、退化回裸 setError（设计 §5）",
        REMINDERS_HOOK,
        ALIAS_BLOCK,
        "  const { currentTaskId, refresh, showSettings, desktopNotify } = input\n"
        "  const setError = (m: string | null): void => { void m }\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5b-3 入口复活一份 notifiedRef（桌面通知去重集合两份）",
        INDEX,
        ACTIONS_END,
        ACTIONS_END + "  const notifiedRef = useRef<Set<string>>(new Set())\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5b-4 入口重新内联\"设置面板拉策略/通道\" effect（第二处发 /reminders/policy）",
        INDEX,
        ACTIONS_END,
        ACTIONS_END + ("  useEffect(() => {\n    if (!showSettings) return\n    void Promise.all([\n"
                       "      api('/api/workbench/reminders/policy'),\n"
                       "    ]).catch(() => undefined)\n  }, [showSettings])\n"),
        [EXIT_CHECK],
    ),
    (
        "M-P5b-5 tickDue 去掉 isAlive 守卫（卸载后回来的响应会 setState / 发通知 / 写盘）",
        REMINDERS_HOOK,
        GUARD,
        "    void isAlive\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5b-6 提醒域 hook 越界去发草稿域路由（域边界被打破）",
        REMINDERS_HOOK,
        TEST_EP,
        TEST_EP + "\n      await api('/api/workbench/drafts')",
        [EXIT_CHECK],
    ),
    (
        "M-P5b-7 提醒域 hook 自己起一个定时器（轮询归属被打破，双轮询）",
        REMINDERS_HOOK,
        TICK_HEAD,
        "  setInterval(() => undefined, 1000)\n" + TICK_HEAD,
        [EXIT_CHECK],
    ),
    (
        "M-P5b-8 ackReminder 不再按 currentTaskId 闸门刷新（确认了但列表不同步）",
        REMINDERS_HOOK,
        ACK_GATE,
        "    void currentTaskId\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5b-9 轮询装配器改回内联拉到期提醒（提醒域没搬干净；D17/P5-3 后靶点在装配器）",
        POLLING_HOOK,
        "        await tickReminders(() => alive)\n",
        DUE_INLINE,
        [P5C_EXIT_CHECK],
    ),
    (
        "M-P5b-10 入口把 desktopNotify 注入换成常量 true（设置域读口断开）",
        INDEX,
        DESKTOP_ARG,
        DESKTOP_ARG_MUT,
        [EXIT_CHECK],
    ),
    (
        "M-P5b-11 tickDue 不再 persistNotified（刷新页面重发同一条通知）",
        REMINDERS_HOOK,
        PERSIST_LINE,
        "",
        [EXIT_CHECK],
    ),
    (
        "M-P5b-12 入口复制一份 ackReminder（p5a §6 移交出去的判据，须由 p5b 抓住）",
        INDEX,
        ACTIONS_END,
        ACTIONS_END + ("  const ackReminder = async (reminderId: string): Promise<void> => "
                       "{ void reminderId }\n"),
        [EXIT_CHECK, P5A_EXIT_CHECK],
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
        elif len(files) > 1 and codes[0] != 0 and codes[1] == 0:
            print(f"   ✅ 红票来自 {files[0]}；{files[1]} 保持绿 = 判据移交完成")
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
codes, _ = run_checks([EXIT_CHECK, P5A_EXIT_CHECK, P5C_EXIT_CHECK])
print(f"\n还原后基线：exit={codes}（应全为 0）")
assert all(c == 0 for c in codes), "还原后基线不是绿的"

print(f"\n结果：{len(MUTATIONS) - green}/{len(MUTATIONS)} 条变异被断言发现")
sys.exit(1 if green else 0)
