# -*- coding: utf-8 -*-
"""D17 / P5-2 一次性搬迁：把**提醒域**（7 项 state + 桌面通知去重集合 + 通知可用性常量 +
8 个域动作 + 2 条 effect + 设置面板用的策略/通道加载 effect）从 src/client/index.tsx
切进 hooks/useWorkbenchReminders.ts。

与 P4/P5-1 一致的两条纪律：
  ① **只换来源、不改调用点文本** —— 入口从 `remindersApi` / `remindersApi.actions` 解构出
     与原来同名的值，所以 JSX props（`notifyPermission={notifyPerm}`、
     `onSaveReminderPolicy={saveReminderPolicy}`、`onSelectTarget={(botId, targetId) => setReminderChannel((prev) => …)}`、
     `addTaskReminder={addTaskReminder}`、`ackReminder` 的两处 onClick…）**一个字都不用动**，
     探针与既有测试因此不需要重锚。
  ② **轮询不搬家** —— 5 秒 tick / 15 秒 refresh 那条 effect 属装配层（P5-3 的
     `useWorkbenchPolling` 接手），本批只把 tick 里的"提醒那一半"换成一句
     `await tickDue(() => alive)`，**不新增任何定时器**。

房屋风格同 d17-cut-p3c.py / p3d.py / p4.py / p5a.py：所有断言先跑完，problems 为空才落盘。
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

# 控制台是 GBK 时打印 ✅ 会 UnicodeEncodeError（本脚本第一次跑就撞上了，写盘已完成、只是收尾打印炸了）。
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "src" / "client" / "index.tsx"

problems: list[str] = []


def replace_once(text: str, old: str, new: str, label: str) -> str:
    n = text.count(old)
    if n != 1:
        problems.append(f"{label}: 期望恰好 1 处，实际 {n} 处")
        return text
    return text.replace(old, new, 1)


def cut_between(text: str, start: str, end: str, new: str, label: str) -> str:
    """删除 [start .. end]（含两端标记）用 new 替代。两端标记都必须恰好 1 次。"""
    a = text.count(start)
    b = text.count(end)
    if a != 1:
        problems.append(f"{label}: 起始标记出现 {a} 次（期望 1）")
        return text
    if b != 1:
        problems.append(f"{label}: 结束标记出现 {b} 次（期望 1）")
        return text
    i = text.find(start)
    j = text.find(end)
    if j < i:
        problems.append(f"{label}: 结束标记在起始标记之前")
        return text
    return text[:i] + new + text[j + len(end):]


def cut_up_to(text: str, start: str, nxt: str, new: str, label: str) -> str:
    """删除从 start 起、到 nxt **之前**（不含 nxt）的整段，用 new 替代。两端标记都必须恰好 1 次。"""
    a = text.count(start)
    b = text.count(nxt)
    if a != 1:
        problems.append(f"{label}: 起始标记出现 {a} 次（期望 1）")
        return text
    if b != 1:
        problems.append(f"{label}: 下一段标记出现 {b} 次（期望 1）")
        return text
    i = text.find(start)
    j = text.find(nxt)
    if j < i:
        problems.append(f"{label}: 下一段标记在起始标记之前")
        return text
    return text[:i] + new + text[j:]


text = INDEX.read_text(encoding="utf-8")
before_lines = text.count("\n") + 1

# ---------------------------------------------------------------- ① 入口 import 新 hook
text = replace_once(
    text,
    "import { useWorkbenchSettings } from './hooks/useWorkbenchSettings.js'\n",
    "import { useWorkbenchSettings } from './hooks/useWorkbenchSettings.js'\n"
    "import { useWorkbenchReminders } from './hooks/useWorkbenchReminders.js'\n",
    "import 提醒域 hook",
)

# ---------------------------------------------------------------- ② L346 `reminders` state → 指针
text = replace_once(
    text,
    "  const [reminders, setReminders] = useState<Array<{ reminderId: string; taskId: string; title: string; dueAt: string; methodCode: string }>>([])\n",
    "  // 提醒域（D17/P5-2）：7 项 state 已收进 hooks/useWorkbenchReminders.ts。\n"
    "  // ⚠️ 它的调用点在下方**设置域 `prefs` 之后** —— `showSettings` 与 `settings.desktopNotify`\n"
    "  // 都要以注入形式拿到（`const` 没有提升），所以 `reminders` 的声明也一并挪到了那里。\n",
    "reminders state → 指针",
)

# ---------------------------------------------------------------- ③ L368 `reminderModalOpen` state → 指针
text = replace_once(
    text,
    "  const [reminderModalOpen, setReminderModalOpen] = useState(false)\n",
    "  // 提醒域（D17/P5-2）：`reminderModalOpen` 已收进 hooks/useWorkbenchReminders.ts（见下方解构）。\n",
    "reminderModalOpen state → 指针",
)

# ---------------------------------------------------------------- ④ 设置域注释里的落点描述改口径
# P5-1 写的是"调用点在下方 `notifyPerm` 之后"，而 `notifyPerm` 本批搬走了 —— 改成"提醒域之前"。
text = replace_once(
    text,
    "（调用点在下方 `notifyPerm` 之后）。",
    "（调用点在下方提醒域之前）。",
    "设置域落点注释改口径",
)

# ---------------------------------------------------------------- ⑤ L387-397 notificationCtor + notifyPerm → 指针
text = cut_between(
    text,
    "  /**\n   * 系统通知的可用性三态（v1.15.7）。",
    "    () => classifyNotificationPermission(notificationCtor),\n  )\n",
    "  // 提醒域（D17/P5-2）：`notificationCtor` 与 `notifyPerm` 已收进 hooks/useWorkbenchReminders.ts。\n"
    "  // 注：入口仍在 `SettingsModal` 的两个内联回调里就地 `readNotificationCtor(globalThis)`\n"
    "  //（授权与「发送测试通知」各一次）—— 它们读的是入口持有的 `pushToast`，属装配层。\n",
    "notificationCtor / notifyPerm → 指针",
)

# ---------------------------------------------------------------- ⑥ L409-413 四项 state → 新 hook 调用点
text = cut_between(
    text,
    "  // 微信提醒：策略 + 通道状态（通道可用性由 dsh-im 决定，未安装时静默降级）",
    "  const [reminderBusy, setReminderBusy] = useState(false)\n",
    "  // 提醒域（D17/P5-2）：7 项 state（含上面的 `reminders` / `reminderModalOpen` / `notifyPerm`）、\n"
    "  // 桌面通知去重集合与全部提醒动作已收进 hooks/useWorkbenchReminders.ts。\n"
    "  // 落点必须在 `prefs`（设置域）之后 —— `showSettings` 与 `settings.desktopNotify` 都是以注入形式进来的。\n"
    "  const remindersApi = useWorkbenchReminders({ currentTaskId, refresh, showSettings, desktopNotify: settings.desktopNotify, onError: setError, onNotice: setNotice, onToast: pushToast })\n"
    "  const { reminders, reminderModalOpen, notifyPerm, reminderPolicy, reminderChannel, reminderOptions, reminderBusy } = remindersApi\n"
    "  const {\n"
    "    setReminderModalOpen, setNotifyPerm, setReminderPolicy, setReminderChannel,\n"
    "    loadReminderChannel, saveReminderTarget, saveReminderPolicy, sendReminderTest,\n"
    "    ackReminder, resetReminderState, addTaskReminder, tickDue,\n"
    "  } = remindersApi.actions\n",
    "四项提醒 state → hook 调用点",
)

# ---------------------------------------------------------------- ⑦ L563-574 策略/通道加载 effect
text = cut_up_to(
    text,
    "  // 打开设置面板时加载微信提醒策略与通道状态（含自动发现的可选投递目标）",
    "  // 设置域（D17/P5-1）：召回日志 effect 已收进 hooks/useWorkbenchSettings.ts。",
    "  // 提醒域（D17/P5-2）：打开设置面板时拉策略/通道的那条 effect 已收进 hooks/useWorkbenchReminders.ts。\n"
    "\n",
    "策略/通道加载 effect",
)

# ---------------------------------------------------------------- ⑧ L578-597 notifiedRef / persistNotified
text = cut_between(
    text,
    "  /**\n   * 桌面通知去重集合：持久化到 localStorage。",
    "    } catch { /* localStorage 不可用时退化为内存去重 */ }\n  }\n",
    "  // 提醒域（D17/P5-2）：桌面通知去重集合 `notifiedRef` / `persistNotified` 已收进\n"
    "  // hooks/useWorkbenchReminders.ts（原存储键与「超 500 留后 250」的规则都不变）。\n",
    "notifiedRef / persistNotified",
)

# ---------------------------------------------------------------- ⑨ L601-604 有到期提醒自动弹窗
text = replace_once(
    text,
    "  // 有到期提醒时自动弹出提醒弹窗（关掉后本次不再自动弹；新提醒到达会再弹一次）。\n"
    "  useEffect(() => {\n"
    "    if (reminders.length > 0) setReminderModalOpen(true)\n"
    "  }, [reminders.length])\n",
    "  // 提醒域（D17/P5-2）：「有到期提醒时自动弹窗」那条 effect 已收进 hooks/useWorkbenchReminders.ts。\n",
    "自动弹窗 effect",
)

# ---------------------------------------------------------------- ⑩ 轮询 tick 的提醒那半段 → tickDue
text = cut_between(
    text,
    "        const r = await api<{ reminders: Array<{ reminderId: string; taskId: string; title: string; dueAt: string; methodCode: string }> }>('/api/workbench/reminders/due')\n",
    "          if (notifiedAny) persistNotified()\n        }\n",
    "        // 提醒域（D17/P5-2）：拉到期提醒 + 按需发系统通知已收进 useWorkbenchReminders 的 `tickDue`。\n"
    "        // 把装配层的 `alive` 传进去：原实现正是在这里用 `if (!alive) return` 挡住「卸载后才回来的响应」。\n"
    "        await tickDue(() => alive)\n",
    "轮询 tick 的提醒半段 → tickDue",
)

# ---------------------------------------------------------------- ⑪ L721-752 ack / reset / addTaskReminder
text = cut_up_to(
    text,
    "  /** 用户点「知道了」：写 acknowledged_at（终态），并把这条从待处理列表移除。 */",
    "  const linkExistingSession = async (sessionId: string): Promise<void> => {",
    "  // 提醒域（D17/P5-2）：`ackReminder` / `resetReminderState` / `addTaskReminder`\n"
    "  // 已收进 hooks/useWorkbenchReminders.ts（它们的 `setNotice` / `setError` 改成注入回调）。\n"
    "\n",
    "ackReminder / resetReminderState / addTaskReminder",
)

# ---------------------------------------------------------------- ⑫ L1440-1501 四条微信提醒动作
text = cut_up_to(
    text,
    "  const loadReminderChannel = async (): Promise<void> => {",
    "  /**\n   * 归档当前选中的任务（2026-10-01 从详情页动作行的内联箭头函数提出来）。",
    "  // 提醒域（D17/P5-2）：`loadReminderChannel` / `saveReminderTarget` / `saveReminderPolicy` /\n"
    "  // `sendReminderTest` 四条微信提醒动作已收进 hooks/useWorkbenchReminders.ts。\n"
    "\n",
    "四条微信提醒动作",
)

# ---------------------------------------------------------------- 落盘
if problems:
    print("✖ 裁切未执行，存在以下问题：")
    for p in problems:
        print(f"   - {p}")
    raise SystemExit(1)

after_lines = text.count("\n") + 1
# ⚠️ 必须显式 newline="\n"：Path.write_text 默认会把 \n 翻成 os.linesep（Windows 上是 \r\n），
# 第一次跑时漏了这个参数，整份 index.tsx 被写成 CRLF（3926 个 CRLF / 0 个裸 LF），
# 已用 bytes 级替换还原。此后所有 cut 脚本都强制 LF。
INDEX.write_text(text, encoding="utf-8", newline="\n")
print(f"\u2705 index.tsx: {before_lines} -> {after_lines} 行")
