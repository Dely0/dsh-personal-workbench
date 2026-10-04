#!/usr/bin/env python3
"""D17 P5-3 反向验证：给刚迁移的草稿域 / 轮询装配器注入缺陷，确认判据会**真的变红**。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
缺陷分布在三个文件（入口 / 草稿域 hook / 轮询装配器），所以每条变异自带目标路径
（与 `d17-mutate-p4.py` / `d17-mutate-p5a.py` / `d17-mutate-p5b.py` 同构）。

判据面是 python 出口自检，`run_checks` 仍同构支持 `.py` 与 `.mjs`。

为什么这十二条：
- M-P5c-1 盯"7 项 state 只有一个 owner"（`pendingOpen` 这种"只给弹窗用"的开关最容易
  被顺手留在入口，变成两个 owner —— 右上角计数与弹窗列表读的会不是同一份）；
- M-P5c-2 盯设计 §5 的跨域注入：hook 里丢掉别名、退化回裸 `setError` 就不再是"装配层注入反馈"；
- M-P5c-3 盯**屏蔽集合只有一份**（第二份 `dismissedDraftIdsRef` = "点一次关闭，5 秒后又弹回来"
  这个最早修过的 BUG 的机制本身）；
- M-P5c-4 盯"HTTP 归属"：入口再内联一次拉草稿，就是第二个发 `/api/workbench/drafts` 的地方
  （也正是本批搬走的那次请求）；
- M-P5c-5 盯 `tickDrafts` 的**要害守卫**（去掉 `if (isAlive()) {`，卸载后才回来的响应会
  setState 并写 `bannerDraftRef` —— 就是原先写这条守卫要防的事）；
- M-P5c-6 盯**域边界**（草稿域 hook 越界去发提醒域路由）；
- M-P5c-7 盯**轮询唯一归属**（草稿域 hook 自己起定时器 = 5 秒 tick 之外再多一个轮询，设计 §7 口径）；
- M-P5c-8 盯装配器的**串行顺序**（把草稿/提醒对调 = 请求顺序变了，异常范围跟着变）；
- M-P5c-9 盯装配器的**频率**（5 秒改成 0.5 秒）；
- M-P5c-10 盯装配器**不吞掉清理**（删掉 15 秒 refresh 定时器 = 另一条既有时段没了）；
- M-P5c-11 盯宿主 DOM 投影**没被本批顺手删掉**（`PENDING_ATTR` 写/清是插件与宿主的契约）；
- M-P5c-12 盯**判据跟着 owner 走**：入口轮询改成内联拉提醒。本批把 5 条轮询断言从
  `d17-p5b-exit-check.py` §5 移交给了本脚本，所以这条变异**特意把 p5b 也列进判据面**：
  p5b 保持绿正是"移交完成"的证据，红的那一票必须来自 p5c。

用法：python scripts/lib/d17-mutate-p5c.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = "src/client/index.tsx"
DRAFTS_HOOK = "src/client/hooks/useWorkbenchDrafts.ts"
POLLING_HOOK = "src/client/hooks/useWorkbenchPolling.ts"
BACKUP = os.path.join(os.environ["TEMP"], "d17-p5c-mutate.bak")

EXIT_CHECK = "scripts/lib/d17-p5c-exit-check.py"
P5B_EXIT_CHECK = "scripts/lib/d17-p5b-exit-check.py"

ACTIONS_END = "  const { pendingDraft, allPendingDrafts } = draftsApi\n"
STATES_END = "  } = data.actions\n"
ALIAS_BLOCK = "  const { refresh, onError: setError, onNotice: setNotice } = input\n"
GUARD = "    if (isAlive()) {\n"
TICK_HEAD = "  const tickDrafts = useCallback(async (isAlive: () => boolean): Promise<void> => {"
TICK_ORDER = "        await tickDrafts(() => alive)\n        await tickReminders(() => alive)\n"
REFRESH_TIMER = "    const refreshTimer = setInterval(() => { void refresh().catch(() => undefined) }, 15000)\n"
TICK_TIMER = "setInterval(() => void tick(), 5000)"
PENDING_ATTR_SET = "    if (pendingDraft !== null) document.documentElement.setAttribute(PENDING_ATTR, '')\n"
POLL_TICK_REMINDERS = "    tickReminders: remindersApi.actions.tickDue,\n"
REMINDERS_DUE_INLINE = ("    tickReminders: (isAlive) => api<{ reminders: Array<{ reminderId: string }> }>"
                        "('/api/workbench/reminders/due').then(() => { void isAlive }),\n")

MUTATIONS = [
    (
        "M-P5c-1 入口把 pendingOpen 收回去自己 useState（同一状态两个 owner）",
        INDEX,
        ACTIONS_END,
        ACTIONS_END + "  const [pendingOpen, setPendingOpen] = useState(false)\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5c-2 草稿域 hook 丢掉注入别名、退化回裸 setError（设计 §5）",
        DRAFTS_HOOK,
        ALIAS_BLOCK,
        "  const { refresh, onNotice: setNotice } = input\n"
        "  const setError = (m: string | null): void => { void m }\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5c-3 入口复活一份 dismissedDraftIdsRef（屏蔽集合两份，关掉 5 秒后又弹）",
        INDEX,
        STATES_END,
        STATES_END + "  const dismissedDraftIdsRef = useRef<Set<string>>(new Set())\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5c-4 入口重新内联拉待确认草稿（第二处发 /api/workbench/drafts）",
        INDEX,
        STATES_END,
        STATES_END + ("  useEffect(() => {\n"
                      "    void api<{ draft: DraftView | null }>('/api/workbench/drafts').catch(() => undefined)\n"
                      "  }, [])\n"),
        [EXIT_CHECK],
    ),
    (
        "M-P5c-5 tickDrafts 去掉 isAlive 守卫（卸载后回来的响应会 setState / 写 bannerDraftRef）",
        DRAFTS_HOOK,
        GUARD,
        "      void isAlive\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5c-6 草稿域 hook 越界去发提醒域路由（域边界被打破）",
        DRAFTS_HOOK,
        TICK_HEAD,
        TICK_HEAD + "\n    await api('/api/workbench/reminders/policy')",
        [EXIT_CHECK],
    ),
    (
        "M-P5c-7 草稿域 hook 自己起一个定时器（轮询归属被打破，双轮询）",
        DRAFTS_HOOK,
        TICK_HEAD,
        "  setInterval(() => undefined, 1000)\n" + TICK_HEAD,
        [EXIT_CHECK],
    ),
    (
        "M-P5c-8 装配器把草稿/提醒对调（请求顺序与异常范围都变了）",
        POLLING_HOOK,
        TICK_ORDER,
        "      await tickReminders(() => alive)\n      await tickDrafts(() => alive)\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5c-9 装配器把 tick 频率改成 0.5 秒（时段被改）",
        POLLING_HOOK,
        TICK_TIMER,
        "setInterval(() => void tick(), 500)",
        [EXIT_CHECK],
    ),
    (
        "M-P5c-10 装配器删掉 15 秒 refresh 定时器（另一条既有时段没了）",
        POLLING_HOOK,
        REFRESH_TIMER,
        "",
        [EXIT_CHECK],
    ),
    (
        "M-P5c-11 入口把 PENDING_ATTR 投影改成空操作（宿主契约被顺手删掉）",
        INDEX,
        PENDING_ATTR_SET,
        "    void pendingDraft\n",
        [EXIT_CHECK],
    ),
    (
        "M-P5c-12 入口把提醒 tick 改回内联拉取（p5b §5 移交出去的判据，须由 p5c 抓住）",
        INDEX,
        POLL_TICK_REMINDERS,
        REMINDERS_DUE_INLINE,
        [EXIT_CHECK, P5B_EXIT_CHECK],
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
codes, _ = run_checks([EXIT_CHECK, P5B_EXIT_CHECK])
print(f"\n还原后基线：exit={codes}（应全为 0）")
assert all(c == 0 for c in codes), "还原后基线不是绿的"

print(f"\n结果：{len(MUTATIONS) - green}/{len(MUTATIONS)} 条变异被断言发现")
sys.exit(1 if green else 0)
