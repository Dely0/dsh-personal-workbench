#!/usr/bin/env python3
"""D17 P6-2 反向验证：给刚迁移的**快速录入域**（+ P6-1 的导航/忙碌域）注入缺陷，
确认判据会**真的变红**。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
缺陷分布在三个文件（入口 / 快速录入域 hook / 共用的纯模块），所以每条变异自带目标路径
（与 `d17-mutate-p4.py` / `p5a.py` / `p5b.py` / `p5c.py` 同构）。

判据面是同构的 `.py` 出口自检与 `.mjs` 单测，`run_checks` 两种都支持。

为什么这十三条：
- M-P6b-1/2/3 盯**同一状态只有一个 owner**：`quickWorkspace` 这种"只给一个弹窗用"的状态最容易
  被顺手留在入口；附件镜像 ref 与"唯一写入出口"是本域最要紧的一致性构造
  （修前 ref 与 state 分叉过一次，见 hook 文件头第 4 条）；
- M-P6b-4 盯**成组动作没有被拆回两处**：`{ clearQuickAttachments(); setShowQuick(false) }`
  这种两连写拆回内联，就是"同一个语义两处实现"的复发形态；
- M-P6b-5 盯**用户输入的唯一写点**：`overrideWorkspace` 被拆回内联，等于绕过"写明手动改过"的判定；
- M-P6b-6 盯设计 §5 的**跨域注入**：把反馈域的 `setError` 换成空实现，错误就再也弹不出来；
- M-P6b-7 盯**注入而非搬走**：`detectWslHost` 是入口尾部的模块级纯函数，搬进 hook 会成环；
- M-P6b-8 盯"判据跟着 owner 走"：提交闸门留在入口，`quickWorkspaceDefault.test.mjs` /
  `quickIntakeDefaultWiring.test.mjs` 必须仍然抓住它（这两条也是**行为级**判据，
  与形态扫描互补）；
- M-P6b-9 盯函数体第一行的**别名**（丢掉别名 = 搬来的函数体不再与拆分前逐字一致）；
- M-P6b-10/11/12 盯**域边界与纯度**：越界发别的域的路由 / 自己起定时器 / 直接读 `selected`
  （最后一条正是 v1.15.2 那次事故的机制本身）；
- M-P6b-13 盯**共用纯模块的纯度**：它被两个域共用，一旦碰 React 就不再是纯函数。

用法：python scripts/lib/d17-mutate-p6b.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = "src/client/index.tsx"
HOOK = "src/client/hooks/useWorkbenchQuickIntake.ts"
HELPERS = "src/client/intakeHelpers.ts"
# D17/P7-2：快速录入弹窗的 JSX 搬进 src/client/app/WorkbenchDialogs.tsx ⇒ 靶点跟着 owner 走。
UI_DIALOGS = os.path.join("src", "client", "app", "WorkbenchDialogs.tsx")
BACKUP = os.path.join(os.environ["TEMP"], "d17-p6b-mutate.bak")

EXIT_CHECK = "scripts/lib/d17-p6b-exit-check.py"
NODE_TESTS = ["test/quickWorkspaceDefault.test.mjs", "test/quickIntakeDefaultWiring.test.mjs"]

PREFS_END = "  const { setSettings, saveDailyCapacity: saveDailyCapacitySetting } = prefs.actions\n"
CANCEL_BUTTON = "onClick={cancelIntake}>取消</button>"
PICKER_ONCHANGE = "            onChange={overrideWorkspace}\n"
INJECT_ARGS = "detectWslHost, onError: setError })"
DETECT_WSL = "function detectWslHost(runtime: WorkbenchRuntime): boolean {"
GATE = "if (shouldRememberQuickWorkspace(quickWorkspaceTouched, chosen)) void rememberQuickWorkspace(chosen)"

ALIAS_BLOCK = "  const { runtime, settings, setSettings, detectWslHost, onError: setError } = input\n"
OPEN_INTAKE_HEAD = "  const openIntake = (): void => {\n"
APPLY_FIRST_LINE = "    setQuickWorkspace(decided.path)\n"
HELPERS_HEAD = "export function newTaskId(): string {\n"

MUTATIONS = [
    (
        "M-P6b-1 入口把 quickWorkspace 收回去自己 useState（同一状态两个 owner）",
        INDEX,
        PREFS_END,
        PREFS_END + "  const [quickWorkspace, setQuickWorkspace] = useState('')\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6b-2 入口复活一份附件镜像 ref（ref/state 一致性构造被打破）",
        INDEX,
        PREFS_END,
        PREFS_END + "  const quickAttachmentsRef = useRef<QuickAttachmentDraft[]>([])\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6b-3 入口重新内联写附件（出现第二个写入出口）",
        INDEX,
        PREFS_END,
        PREFS_END + "  const writeQuickAttachments = (next: QuickAttachmentDraft[]): void => { void next }\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6b-4 入口把「取消」拆回两连 setState（成组动作被拆回两处）",
        UI_DIALOGS,
        CANCEL_BUTTON,
        "onClick={() => { clearQuickAttachments(); setShowQuick(false) }}>取消</button>",
        [EXIT_CHECK],
    ),
    (
        "M-P6b-5 入口把工作区回调拆回内联两连写（绕过唯一写点 overrideWorkspace）",
        UI_DIALOGS,
        PICKER_ONCHANGE,
        "            onChange={(path) => { setQuickWorkspaceTouched(true); setQuickWorkspace(path) }}\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6b-6 入口把注入的 setError 换成空实现（反馈域注入被掐断，设计 §5）",
        INDEX,
        INJECT_ARGS,
        "detectWslHost, onError: () => undefined })",
        [EXIT_CHECK],
    ),
    (
        "M-P6b-7 入口把 detectWslHost 改名（注入契约被打破；真搬进 hook 会成环）",
        INDEX,
        DETECT_WSL,
        "function detectWslHostFromHost(runtime: WorkbenchRuntime): boolean {",
        [EXIT_CHECK],
    ),
    (
        "M-P6b-8 入口去掉 touched 闸门：自动预填的值也记进「最近手动选择」（.mjs 判据面）",
        UI_DIALOGS,
        GATE,
        "if (chosen !== '') void rememberQuickWorkspace(chosen)",
        NODE_TESTS,
    ),
    (
        "M-P6b-9 快速录入域 hook 丢掉注入别名、退化回裸 setError（设计 §5）",
        HOOK,
        ALIAS_BLOCK,
        "  const { runtime, settings, setSettings, detectWslHost } = input\n"
        "  const setError = (message: string): void => { void message }\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6b-10 快速录入域 hook 越界去发别的域路由（域边界被打破）",
        HOOK,
        OPEN_INTAKE_HEAD,
        "  void api('/api/workbench/skills')\n" + OPEN_INTAKE_HEAD,
        [EXIT_CHECK],
    ),
    (
        "M-P6b-11 快速录入域 hook 自己起一个定时器（本域不拥有定时器）",
        HOOK,
        OPEN_INTAKE_HEAD,
        "  setInterval(() => undefined, 1000)\n" + OPEN_INTAKE_HEAD,
        [EXIT_CHECK],
    ),
    (
        "M-P6b-12 快速录入域 hook 直接读 selected（v1.15.2 那次事故的机制本身）",
        HOOK,
        APPLY_FIRST_LINE,
        "    setQuickWorkspace(selected?.task.effectiveWorkspacePath ?? decided.path)\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6b-13 共用的纯模块反过来 import React（纯度被打破）",
        HELPERS,
        HELPERS_HEAD,
        "import { useState } from 'react'\n\n" + HELPERS_HEAD,
        [EXIT_CHECK],
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
codes, _ = run_checks([EXIT_CHECK] + NODE_TESTS)
print(f"\n还原后基线：exit={codes}（应全为 0）")
assert all(c == 0 for c in codes), "还原后基线不是绿的"

print(f"\n结果：{len(MUTATIONS) - green}/{len(MUTATIONS)} 条变异被断言发现")
sys.exit(1 if green else 0)
