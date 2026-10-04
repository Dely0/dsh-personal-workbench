"""D17 / P7-2 反向变异：把「四段 JSX 搬进 app/」这条结论逐条装上 bug，看出口自检是否真的会红。

判据面只有 `scripts/lib/d17-p7b-exit-check.py`（纯文本扫描）。每条的期望都是**变红**，
且跑完必须逐文件 sha256 还原一致、还原后再跑一次基线确认全绿
（否则「全红」可能只是判据自己坏了）。

判据自己也会写错 —— 这里 13 条覆盖八节：①/⑤ 装配与顺序、② 唯一所有者、③ 组件纯度、
④ 依赖方向（用 ⑨ 反向 import 覆盖）、⑥ 留在装配层的原文、⑧ ADR-0008 硬门。
"""
from __future__ import annotations

import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = os.path.join("src", "client", "index.tsx")
ASSEMBLY = os.path.join("src", "client", "app", "assembly.ts")
UI_HEADER = os.path.join("src", "client", "app", "WorkbenchHeader.tsx")
UI_OVERLAYS = os.path.join("src", "client", "app", "WorkbenchOverlays.tsx")
UI_BODY = os.path.join("src", "client", "app", "WorkbenchBody.tsx")
UI_DIALOGS = os.path.join("src", "client", "app", "WorkbenchDialogs.tsx")
BACKUP = os.path.join(os.environ["TEMP"], "d17-p7b-mutate.bak")

EXIT_CHECK = "scripts/lib/d17-p7b-exit-check.py"

ASSEMBLY_HEAD = "  const assembly: WorkbenchAssembly = {\n"
FOUR_LINES = (
    "      <WorkbenchHeader {...assembly} />\n"
    "      <WorkbenchOverlays {...assembly} />\n"
    "      <WorkbenchBody {...assembly} />\n"
    "      <WorkbenchDialogs {...assembly} />\n"
)
OVERLAYS_DECL = "export function WorkbenchOverlays(props: WorkbenchAssembly): JSX.Element {\n"
BODY_DECL = "export function WorkbenchBody(props: WorkbenchAssembly): JSX.Element {\n"
DIALOGS_DECL = "export function WorkbenchDialogs(props: WorkbenchAssembly): JSX.Element {\n"
BODY_ASSEMBLY_IMPORT = "import type { WorkbenchAssembly } from './assembly.js'\n"
COLLAPSE_ALL = "  const collapseAll = (): void => { taskList.actions.clearExpanded(); day.actions.collapseExpanded() }\n"
BIG_BLOCK = "  const bigInlineBlock = ((): void => {\n" + "    void 0\n" * 85 + "  })\n"

MUTATIONS = [
    (
        "M-P7b-1 入口把主体那一整段 JSX 拿回来（JSX 回流入口）",
        INDEX,
        "      <WorkbenchBody {...assembly} />\n",
        "      <div className=\"wb-body\">{/* 回流 */}</div>\n",
        [EXIT_CHECK],
    ),
    (
        "M-P7b-2 入口漏掉弹窗那一段（四段少一段）",
        INDEX,
        "      <WorkbenchDialogs {...assembly} />\n",
        "      {/* 弹窗整段丢失 */}\n",
        [EXIT_CHECK],
    ),
    (
        "M-P7b-3 四段顺序被改（弹窗提到提示层之前，DOM 层叠顺序变了）",
        INDEX,
        FOUR_LINES,
        "      <WorkbenchHeader {...assembly} />\n"
        "      <WorkbenchDialogs {...assembly} />\n"
        "      <WorkbenchOverlays {...assembly} />\n"
        "      <WorkbenchBody {...assembly} />\n",
        [EXIT_CHECK],
    ),
    (
        "M-P7b-4 四段不再整束注入（改成逐个手工 props）",
        INDEX,
        "      <WorkbenchHeader {...assembly} />\n",
        "      <WorkbenchHeader view={view} />\n",
        [EXIT_CHECK],
    ),
    (
        "M-P7b-5 入口又出现一处 `api(`（ADR-0008 结构硬门回退）",
        INDEX,
        ASSEMBLY_HEAD,
        "  void api('/api/workbench/bootstrap')\n" + ASSEMBLY_HEAD,
        [EXIT_CHECK],
    ),
    (
        "M-P7b-6 入口长回一个 87 行的顶层块（单块 ≤80 行被打破）",
        INDEX,
        ASSEMBLY_HEAD,
        BIG_BLOCK + ASSEMBLY_HEAD,
        [EXIT_CHECK],
    ),
    (
        "M-P7b-7 入口又定义一份 WorkbenchHeader（第二个 owner）",
        INDEX,
        "function WorkbenchApp({ runtime, closePanel }",
        "export function WorkbenchHeader(props: WorkbenchAssembly): JSX.Element {\n"
        "  return <div />\n"
        "}\n\n"
        "function WorkbenchApp({ runtime, closePanel }",
        [EXIT_CHECK],
    ),
    (
        "M-P7b-8 装配层的 collapseAll 被搬走（跨域组合丢了）",
        INDEX,
        COLLAPSE_ALL,
        "",
        [EXIT_CHECK],
    ),
    (
        "M-P7b-9 装配束类型改名（app/assembly.ts 不再是那个 owner）",
        ASSEMBLY,
        "export interface WorkbenchAssembly {",
        "interface WorkbenchAssemblyThing {",
        [EXIT_CHECK],
    ),
    (
        "M-P7b-10 WorkbenchOverlays 开始自己发请求（组件不再纯展示）",
        UI_OVERLAYS,
        OVERLAYS_DECL,
        OVERLAYS_DECL + "  void api('/api/workbench/bootstrap')\n",
        [EXIT_CHECK],
    ),
    (
        "M-P7b-11 WorkbenchBody 开始自持状态（装配层组件长出 state）",
        UI_BODY,
        BODY_DECL,
        BODY_DECL + "  const [x, setX] = useState(false)\n  void x\n  void setX\n",
        [EXIT_CHECK],
    ),
    (
        "M-P7b-12 WorkbenchBody 直接 import 域 hook（绕过装配束）",
        UI_BODY,
        BODY_ASSEMBLY_IMPORT,
        BODY_ASSEMBLY_IMPORT + "import { useIdeas } from '../hooks/useIdeas.js'\n",
        [EXIT_CHECK],
    ),
    (
        "M-P7b-13 WorkbenchDialogs 里出现 props.actions（直接拿域 hook 的动作）",
        UI_DIALOGS,
        DIALOGS_DECL,
        DIALOGS_DECL + "  void props.actions\n",
        [EXIT_CHECK],
    ),
]


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def read(path):
    return open(path, encoding="utf-8", newline="").read()


def write(path, text):
    style = "\r\n" if "\r\n" in read(path) else "\n"
    if style == "\r\n":
        text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    open(path, "w", encoding="utf-8", newline="").write(text)


def run_checks(files):
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
            print(f"   红: {f[:112]}")
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

codes, _ = run_checks([EXIT_CHECK])
print(f"\n还原后基线：exit={codes}（应全为 0）")
assert all(c == 0 for c in codes), "还原后基线不是绿的"

print(f"\n结果：{len(MUTATIONS) - green}/{len(MUTATIONS)} 条变异被断言发现")
sys.exit(1 if green else 0)
