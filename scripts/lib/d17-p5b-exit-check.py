#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""D17 / P5-2（提醒域）出口自检 —— 只做文本核对，行为以 typecheck / pnpm test 为准。

本批把下面这些从 `src/client/index.tsx` 的 `WorkbenchApp` 里搬进
`src/client/hooks/useWorkbenchReminders.ts`：

* 7 项 state：`reminders`（原 L346）、`reminderModalOpen`（L368）、`notifyPerm`（L395-397）、
  `reminderPolicy`（L410）、`reminderChannel`（L411）、`reminderOptions`（L412）、`reminderBusy`（L413）
* 普通常量 `notificationCtor`（原 L394）与去重设施 `notifiedRef` / `persistNotified`（原 L583-597）
* 8 个域动作：`ackReminder`（L721）、`resetReminderState`（L732）、`addTaskReminder`（L742）、
  `loadReminderChannel`（L1440）、`saveReminderTarget`（L1454）、`saveReminderPolicy`（L1472）、
  `sendReminderTest`（L1490），外加轮询用的 `tickDue`（取代原 L659-684 那半段）
* 2 条 effect：打开设置面板时拉策略/通道（原 L563-574）、有到期提醒时自动弹窗（原 L601-604）

**刻意留在装配层（本批不动，动它们属别的批次）**：

* 5 秒 tick / 15 秒 refresh 的**轮询容器**（原 L606-691）—— 设计 §7 P5 行口径"只留一个轮询"，
  P5-3 的 `useWorkbenchPolling` 接手；本批只把 tick 里提醒那半段换成 `await tickDue(() => alive)`，
  依赖数组 `[refresh, settings.desktopNotify]` 文本不变、定时器数量不变。
* `SettingsModal` 的 `onRequestNotifyPermission` / `onSendTestNotification` 两个内联回调 ——
  它们就地 `readNotificationCtor(globalThis)` 并读入口持有的 `pushToast`。
* 全部 JSX / props / className / portal 位置（本批靠"只换来源不改调用点文本"做到零改动）。

7 条核对：① 入口不再自建 ② 唯一所有者 ③ 提醒域 effect 与路由归属 ④ 跨域注入
⑤ `tickDue` 纯度（轮询归属已随 `useWorkbenchPolling` 移交 P5-3） ⑥ 刻意留在入口的东西还在 ⑦ 结构指纹与调用顺序。
"""

from __future__ import annotations

import glob
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
os.chdir(ROOT)

INDEX_PATH = os.path.join("src", "client", "index.tsx")
REMINDERS_HOOK_PATH = os.path.normpath(os.path.join("src", "client", "hooks", "useWorkbenchReminders.ts"))

# ---------------------------------------------------------------- D17/P7-2：JSX 已分四段搬进 app/
# 判据跟着 owner 走：凡「某组件 / 某 props 仍挂在装配层」的断言不再锚 `index.tsx`，
# 而是锚这四段组件 —— 它们才是装配层的 JSX owner。
# 注意：域 hook 不在这份名单里，所以「接线跑进 hook」仍然会红。
def _app_read(name):
    with open(os.path.join("src", "client", "app", name), encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


UI_HEADER = _app_read("WorkbenchHeader.tsx")
UI_OVERLAYS = _app_read("WorkbenchOverlays.tsx")
UI_BODY = _app_read("WorkbenchBody.tsx")
UI_DIALOGS = _app_read("WorkbenchDialogs.tsx")
UI_ALL = "\n".join((UI_HEADER, UI_OVERLAYS, UI_BODY, UI_DIALOGS))

failures: list[str] = []
checks = 0


def load(p: str) -> str:
    with open(p, encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


def strip_comments(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r"^[ \t]*//.*$", "", s, flags=re.M)
    return s


def check(ok: bool, message: str) -> None:
    global checks
    checks += 1
    if ok:
        print(f"  \u2714 {message}")
    else:
        print(f"  \u2716 {message}")
        failures.append(message)


def bare(src: str, name: str, origin: str) -> int:
    """裸名在（已剥注释的）src 里的命中数：不算 `a.name` 这类成员访问，也不算对象字面量的键。"""
    return len(re.findall(r"(?<![\w.])" + re.escape(name) + r"\b(?!\s*:)", src))


def defs_of(src: str, name: str) -> int:
    """`const name = …` / `function name(…)` 形式的**定义**处数。

    ⚠️ 必须允许行首缩进：`WorkbenchApp` 体内的定义都缩进 2 格。P5-1 的出口自检曾把这条写成
    `^(const|function)\\s+X`（不带缩进），于是"入口不许有第二份定义"这条**永远成立**、
    空洞通过 —— 是反向变异 M-P5a-7 没被抓住才暴露的。本脚本沿用修好后的口径。
    """
    return len(re.findall(r"^[ \t]*(?:const|function)\s+" + re.escape(name) + r"\b", src, re.M))


def body_of(src: str, start: str, end: str | None = None) -> str | None:
    i = src.find(start)
    if i < 0:
        return None
    if end is None:
        return src[i:]
    j = src.find(end, i)
    if j < 0:
        return None
    return src[i:j]


def before(needle: str, marker: str, body: str) -> bool:
    """`needle` 在 `body` 里出现、且早于 `marker`。任一缺失都返回 False（不让 .index() 抛异常）。"""
    i = body.find(needle)
    j = body.find(marker)
    return i >= 0 and j >= 0 and i < j


def client_sources() -> list[str]:
    pats = ["src/client/**/*.ts", "src/client/**/*.tsx"]
    out: list[str] = []
    for pat in pats:
        out.extend(glob.glob(pat, recursive=True))
    return sorted({os.path.normpath(p) for p in out if os.path.isfile(p)})


SOURCES = {p: load(p) for p in client_sources()}
STRIPPED = {p: strip_comments(s) for p, s in SOURCES.items()}
INDEX = SOURCES[os.path.normpath(INDEX_PATH)]
INDEX_BARE = STRIPPED[os.path.normpath(INDEX_PATH)]
REMINDERS = SOURCES[REMINDERS_HOOK_PATH]
REMINDERS_BARE = STRIPPED[REMINDERS_HOOK_PATH]


def owners_of(snippet: str) -> list[str]:
    """哪些客户端源文件里有这段原文（剥注释后）。"""
    return sorted(p for p, s in STRIPPED.items() if snippet in s)


# 从入口搬走的 7 项 state 声明原文（搬进 hook 后逐字未改）
REMINDER_STATES = {
    "reminders": "const [reminders, setReminders] = useState<Array<{ reminderId: string; taskId: string; title: string; dueAt: string; methodCode: string }>>([])",
    "reminderModalOpen": "const [reminderModalOpen, setReminderModalOpen] = useState(false)",
    "notifyPerm": "const [notifyPerm, setNotifyPerm] = useState<NotificationState>(",
    "reminderPolicy": "const [reminderPolicy, setReminderPolicy] = useState<ReminderPolicyView | null>(null)",
    "reminderChannel": "const [reminderChannel, setReminderChannel] = useState<ReminderChannelView | null>(null)",
    "reminderOptions": "const [reminderOptions, setReminderOptions] = useState<ReminderOptionsView | null>(null)",
    "reminderBusy": "const [reminderBusy, setReminderBusy] = useState(false)",
}

# 非 state 的两件设施 + 一个普通常量
REMINDER_SUPPORT = {
    "notificationCtor": "const notificationCtor = readNotificationCtor(globalThis)",
    "notifiedRef": "const notifiedRef = useRef<Set<string>>((() => {",
    "persistNotified": "const persistNotified = (): void => {",
}

# 8 个域动作的定义原文
REMINDER_ACTIONS = {
    "ackReminder": "const ackReminder = async (reminderId: string): Promise<void> => {",
    "resetReminderState": "const resetReminderState = async (reminderId: string): Promise<void> => {",
    "addTaskReminder": "const addTaskReminder = async (offsetMinutes: number): Promise<void> => {",
    "loadReminderChannel": "const loadReminderChannel = async (): Promise<void> => {",
    "saveReminderTarget": "const saveReminderTarget = async (): Promise<void> => {",
    "saveReminderPolicy": "const saveReminderPolicy = async (): Promise<void> => {",
    "sendReminderTest": "const sendReminderTest = async (): Promise<void> => {",
    # P5-3 为了让 `tickDue` 能安全地进 `useWorkbenchPolling` 的依赖数组，外面包了一层
    # `useCallback(..., [desktopNotify])`：签名与体内行为一个字没改，只锁住身份
    # （否则装配层那条 5 秒 effect 会每次渲染都重建 → 每渲染多跑一次 tick）。
    "tickDue": "const tickDue = useCallback(async (isAlive: () => boolean): Promise<void> => {",
}

# 入口解构出来的名字（本批刻意解构，保持所有调用点文本不变）
# P7-3 清理后入口只为 JSX 解构的名字已删，只剩入口真读的 reminders。
DESTRUCTURED_RESULT = "const { reminders } = remindersApi"
DESTRUCTURED_ACTIONS = [
    "setReminderModalOpen", "setNotifyPerm", "setReminderPolicy", "setReminderChannel",
    "loadReminderChannel", "saveReminderTarget", "saveReminderPolicy", "sendReminderTest",
    "ackReminder", "resetReminderState", "addTaskReminder", "tickDue",
]
# actions 是**多行**解构，逐名断言要拿整块原文来对（留一处空白/换行差异就会假红）
# P7-3 起入口不再解构提醒域动作 —— 这条常量改成"不许出现"的负向靶点。
DESTRUCTURED_ACTIONS_BLOCK = "} = remindersApi.actions"

HOOK_CALL = (
    "const remindersApi = useWorkbenchReminders({ currentTaskId, refresh, showSettings, "
    "desktopNotify: settings.desktopNotify, onError: setError, onNotice: setNotice, onToast: pushToast })"
)

print("=" * 78)
print("D17 / P5-2 出口自检（提醒域）")
print("=" * 78)

# ---------------------------------------------------------------- §1 入口不再自建
print("\n§1 入口不再自建本域任何东西")

check(REMINDERS_HOOK_PATH in SOURCES, "useWorkbenchReminders.ts 存在")

for name, decl in {**REMINDER_STATES, **REMINDER_SUPPORT}.items():
    check(decl not in INDEX_BARE, f"入口不再声明：{name}（{decl[:52]}…）")

for name, decl in REMINDER_ACTIONS.items():
    check(decl not in INDEX_BARE, f"入口不再定义动作：{name}")

for name, decl in {**REMINDER_STATES, **REMINDER_SUPPORT, **REMINDER_ACTIONS}.items():
    check(defs_of(INDEX_BARE, name) == 0, f"入口没有 {name} 的第二份定义（缩进口径）")

# 搬走的 2 条 effect 的原文，入口不能再出现
check("    if (!showSettings) return\n    void Promise.all([" not in INDEX_BARE,
      "入口不再有\"打开设置面板拉策略/通道\"的 effect 体")
check("    if (reminders.length > 0) setReminderModalOpen(true)\n  }, [reminders.length])" not in INDEX_BARE,
      "入口不再有\"有到期提醒时自动弹窗\"的 effect 原文")

check(INDEX_BARE.count(HOOK_CALL) == 1,
      "入口恰好一处 useWorkbenchReminders 调用点，且 7 个入参写全")
check(DESTRUCTURED_RESULT in INDEX_BARE,
      "入口解构了提醒域结果（P7-3 起只剩入口真读的 reminders）")
check(DESTRUCTURED_ACTIONS_BLOCK not in INDEX_BARE,
      "入口不再解构提醒域动作（P7-3 清理：动作调用点随 JSX 搬进 app/，域内自用不经入口）")
# 原来这条是"常量与自己比"的同义反复；改成对真实 owner 的断言（收紧）。
for name in DESTRUCTURED_ACTIONS:
    check(name in SOURCES.get(REMINDERS_HOOK_PATH, ""),
          f"提醒域动作 {name} 仍在域内（所有者不变）")
# `useWorkbenchReminders` 在入口出现 3 次：import 的具名 + 模块路径字符串 + 调用点
check(INDEX_BARE.count("useWorkbenchReminders(") == 1
      and INDEX_BARE.count("import { useWorkbenchReminders } from './hooks/useWorkbenchReminders.js'") == 1,
      "入口 useWorkbenchReminders 恰好 1 个调用点 + 1 条 import（原文）")

# ---------------------------------------------------------------- §2 唯一所有者
print("\n§2 唯一所有者（全客户端递归）")

for name, decl in {**REMINDER_STATES, **REMINDER_SUPPORT, **REMINDER_ACTIONS}.items():
    owners = owners_of(decl)
    check(owners == [REMINDERS_HOOK_PATH],
          f"创建者唯一 = 提醒域 hook（{name}）实际：{owners}")

check(len(owners_of("export function useWorkbenchReminders(")) == 1
      and owners_of("export function useWorkbenchReminders(") == [REMINDERS_HOOK_PATH],
      "useWorkbenchReminders 只定义一次（且在提醒域 hook）")
check(len(re.findall(r"^[ \t]*const \[notifyPerm, setNotifyPerm\] = useState", REMINDERS_BARE, re.M)) == 1,
      "提醒域 hook 里 notifyPerm 恰好声明一次")
check(bare(REMINDERS_BARE, "useWorkbenchReminders", "HOOK") == 1
      and "export function useWorkbenchReminders(input: UseWorkbenchRemindersInput)" in REMINDERS_BARE,
      "提醒域 hook 里 useWorkbenchReminders 只出现在自己的导出声明上（不递归引用）")

# ---------------------------------------------------------------- §3 effect 与 HTTP 归属
print("\n§3 提醒域 effect 与 HTTP 归属")

check("  // 打开设置面板时加载微信提醒策略与通道状态（含自动发现的可选投递目标）" in REMINDERS,
      "策略/通道装载 effect 的注释与代码进了提醒域 hook")
check("  }, [showSettings])" in REMINDERS, "策略/通道 effect 的依赖数组原文（[showSettings]）")
check("  // 有到期提醒时自动弹出提醒弹窗（关掉后本次不再自动弹；新提醒到达会再弹一次）。" in REMINDERS
      and "  }, [reminders.length])" in REMINDERS,
      "自动弹窗 effect 的注释/依赖数组原文进了提醒域 hook")

for route in ["/api/workbench/reminders/policy",
              "/api/workbench/reminders/channel",
              "/api/workbench/reminders/test",
              "/api/workbench/reminders/${reminderId}/ack",
              "/api/workbench/reminders/${reminderId}/fire",
              "/api/workbench/reminders/${reminderId}/reset",
              "/api/workbench/tasks/${taskId}/reminders",
              "/api/workbench/reminders/due"]:
    check(route in REMINDERS, f"提醒域 hook 里仍有路由：{route}")

for route in ["/api/workbench/drafts", "/api/workbench/settings",
              "/api/workbench/knowledge-recall", "/api/workbench/dictionaries",
              "/api/workbench/personas"]:
    check(route not in REMINDERS, f"提醒域 hook 不碰别的域路由：{route}")

check("fetch(" not in REMINDERS_BARE, "提醒域 hook 不用原生 fetch（统一走 api）")
check(len(re.findall(r"\bapi[<(]", REMINDERS_BARE)) >= 9,
      f"提醒域 hook 至少 9 处 api 调用（实测 {len(re.findall(r'\bapi[<(]', REMINDERS_BARE))}）")
check("console.warn(`[workbench] 到期提醒未能发出系统通知：" in REMINDERS,
      "发通知失败仍有可观测日志（v1.15.7 的口径）")

# ---------------------------------------------------------------- §4 跨域注入
print("\n§4 跨域注入（设计 §5）")

check("    onError: setError, onNotice: setNotice, onToast: pushToast," in REMINDERS_BARE,
      "注入回调在 hook 里改回域内原名（函数体才不用改）")
for decl in ["currentTaskId: () => string | null",
             "refresh: () => Promise<void>",
             "showSettings: boolean",
             "desktopNotify: boolean",
             "onError: (message: string | null) => void",
             "onNotice: (message: string | null) => void",
             "onToast: (message: string, tone?: ToastTone) => void"]:
    check(decl in REMINDERS, f"入参类型声明了 {decl.split(':')[0]}")

for name in ["setView", "useTaskData", "useWorkbenchSettings", "useKnowledge", "useIdeas",
             "useDayWorkspace", "useTaskListModel", "selectedRef", "currentSessionIdOf",
             "dismissDraft", "setTasks", "withSettingsFallback"]:
    check(bare(REMINDERS_BARE, name, "HOOK") == 0, f"提醒域 hook 不引用别的域：{name}")
check(bare(REMINDERS_BARE, "settings", "HOOK") == 0,
      "提醒域 hook 只收 desktopNotify 值，不引用设置域对象 settings")
check("'../views/" not in REMINDERS and "'./index.js'" not in REMINDERS,
      "提醒域 hook 不 import 任何 view / 入口")

# 两个注入口的**用法**也要守住：丢一句闸门就变成"改完不刷新"
check("    if (currentTaskId() !== null) await refresh()\n" in REMINDERS_BARE,
      "ackReminder 末尾仍按 `currentTaskId() !== null` 闸门刷新 bootstrap")
check("    const taskId = currentTaskId()\n    if (taskId === null) return\n" in REMINDERS_BARE,
      "addTaskReminder 仍先取 currentTaskId 并在没有选中任务时直接返回")

# ---------------------------------------------------------------- §5 tickDue 纯度与轮询归属
print("\n§5 `tickDue` 纯度与轮询归属")

tick_body = body_of(REMINDERS_BARE, "const tickDue = useCallback(async (isAlive: () => boolean)", "  return {")
check(tick_body is not None, "tickDue 体内可定位")
if tick_body is not None:
    check("if (!isAlive()) return" in tick_body, "tickDue 逐字保留 `if (!isAlive()) return` 守卫")
    check(before("if (!isAlive()) return", "setReminders(r.reminders)", tick_body),
          "守卫在 setReminders 之前（卸载后回来的响应不改状态）")
    check(before("if (!isAlive()) return", "sendSystemNotification(", tick_body),
          "守卫同样挡在发系统通知之前")
    check(before("if (!isAlive()) return", "notifiedRef.current.add(", tick_body),
          "守卫同样挡在写去重集合之前")
    check("'/api/workbench/reminders/due'" in tick_body, "tickDue 拉的仍是到期提醒端点")
    check("      if (notifiedAny) persistNotified()\n" in tick_body,
          "tickDue 发过通知就落实持久化（刷新页面不再重发同一条）")

# ⚠️ 判据跟着 owner 走（P5-3）：入口那条**混合域轮询 effect** 已在 P5-3 整片搬进
# `hooks/useWorkbenchPolling.ts`（草稿域 + 提醒域 tick 的装配器）。原来在这里的 5 条断言
# （`await tickDue(() => alive)` 在入口轮询里 / 入口轮询不再内联拉提醒 / 入口轮询恰好 2 个
# 定时器 / 依赖数组 `[refresh, settings.desktopNotify]` 文本不变）跟着 owner 移交
# `d17-p5c-exit-check.py`：那边改以「入口零定时器 + 装配器持有时段、串行顺序与依赖数组」断言。
check("setInterval(" not in REMINDERS_BARE and "setTimeout(" not in REMINDERS_BARE,
      "提醒域 hook 里没有任何定时器（轮询容器留装配层）")
check("alive" not in REMINDERS_BARE, "提醒域 hook 不持有 alive（以 isAlive 回调注入）")

# ---------------------------------------------------------------- §6 刻意留在入口的
print("\n§6 刻意留在装配层的东西还在")

check(UI_BODY.count("readNotificationCtor(globalThis)") == 2,
      "装配层两个内联回调仍就地 readNotificationCtor(globalThis)（授权 + 发送测试通知；P7-2 起在 app/WorkbenchBody.tsx）")
check("onRequestNotifyPermission={() => {" in UI_BODY and "onSendTestNotification={() => {" in UI_BODY,
      "SettingsModal 的两个通知内联回调仍在装配层（P7-2 起在 app/WorkbenchBody.tsx）")

jsx = ["{reminders.length > 0 && reminderModalOpen && (",
       "notifyPermission={notifyPerm}",
       "reminderPolicy={reminderPolicy}",
       "onReminderPolicyChange={setReminderPolicy}",
       "onSaveReminderPolicy={saveReminderPolicy}",
       "reminderChannel={reminderChannel}",
       "reminderOptions={reminderOptions}",
       "reminderBusy={reminderBusy}",
       "onSelectTarget={(botId, targetId) => setReminderChannel((prev) => prev === null ? prev : { ...prev, botId, targetId })}",
       "onSaveTarget={saveReminderTarget}",
       "onRefreshChannel={loadReminderChannel}",
       "onSendTestMessage={sendReminderTest}",
       "addTaskReminder={addTaskReminder}",
       "resetReminderState={resetReminderState}"]
for prop in jsx:
    check(prop in INDEX_BARE or prop in UI_ALL, f"JSX props 原文未动：{prop[:56]}（P7-2 起在 app/ 四段组件里）")

check(UI_ALL.count("onClick={() => void ackReminder(r.reminderId)}") == 2,
      "提醒弹窗与待处理弹窗两处 ackReminder 调用点原文未动（P7-2 起在 app/WorkbenchOverlays.tsx 与 app/WorkbenchDialogs.tsx）")
check("const pendingCount = allPendingDrafts.length + reminders.length" in INDEX_BARE,
      "待处理计数仍 = 草稿 + 提醒（原文未动）")
check(UI_ALL.count("reminders.length") >= 2, "reminders 仍是装配层的读口（入口计数 + 弹窗条件）")

# ---------------------------------------------------------------- §7 结构指纹
print("\n§7 结构指纹与调用顺序")

check("import { useWorkbenchReminders } from './hooks/useWorkbenchReminders.js'" in INDEX,
      "入口 import 提醒域 hook（顶层，路径 .js）")

i_prefs = INDEX_BARE.find("const prefs = useWorkbenchSettings({")
i_rem = INDEX_BARE.find("const remindersApi = useWorkbenchReminders({")
i_knowledge = INDEX_BARE.find("const knowledge = useKnowledge(")
i_ideas = INDEX_BARE.find("const ideas = useIdeas(")
check(i_prefs > 0 and i_rem > 0 and i_knowledge > 0 and i_ideas > 0,
      "四个关键调用点都找得到（顺序断言的前提）")
check(0 < i_prefs < i_rem,
      "调用顺序：prefs（设置域）→ remindersApi（提醒域都要注入它的读口）")
check(i_rem < i_knowledge and i_rem < i_ideas,
      "调用顺序：remindersApi 仍在 useKnowledge / useIdeas 之前")

for comment, least in [("提醒域（D17/P5-2）", 8)]:
    check(INDEX.count(comment) >= least, f"入口保留了指针注释：{comment}（{INDEX.count(comment)} 处）")

print("\n" + "=" * 78)
if failures:
    print(f"✖ {len(failures)} / {checks} 项未通过")
    for f in failures:
        print(f"   - {f}")
    sys.exit(1)
print(f"✔ 全部 {checks} 项通过")
sys.exit(0)
