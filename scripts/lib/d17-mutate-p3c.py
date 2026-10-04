#!/usr/bin/env python3
"""D17 P3-3 反向验证：给刚落地/刚迁移的任务表单域实现注入缺陷，确认判据会**真的变红**。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
缺陷分布在三个文件（入口 / 视图 / hook），所以每条变异自带文件路径（与 `d17-mutate-p3b.py` 同构）。

本批的判据面比前几批**多一半在 python 出口自检里**（视图纯度、开关语义分开、唯一所有者），
所以 `run_checks` 同时支持 `node --test <file>.mjs` 与 `python <file>.py` 两类目标。

为什么这七条：
- M-P3C-1/2 盯设计 §3 的硬规矩"`views/` 不发 HTTP、不持有 state"（本批刚把两个弹窗的 JSX 搬进视图）；
- M-P3C-3 盯模式 3（`setShowForm` 的**开关**与**关闭**两个语义收成两个动作后不许再合并）；
- M-P3C-4 盯"表单域状态只有一个 owner"（`formWorkspace` 原先在入口中部，最容易漏搬一半）；
- M-P3C-5 盯本批**最危险的坑**：跨域 effect 的依赖必须是稳定的 `dismissOnTaskChange`，
  写成 `forms.actions`（每帧新对象）会让编辑弹窗刚打开就被关掉 —— 这是**运行时** bug，typecheck 看不见；
- M-P3C-6/7 反向验证本批**改指新 owner** 的两条既有判据（`workspacePickerWiring` 的 FormData 字段名、
  `taskDetailWiring` 的编辑草稿契约类型）—— 这两条如果还只查入口，搬家后会空洞通过。

用法：python scripts/lib/d17-mutate-p3c.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = "src/client/index.tsx"
VIEW = "src/client/views/TaskFormModal.tsx"
HOOK = "src/client/hooks/useTaskForms.ts"
BACKUP = os.path.join(os.environ["TEMP"], "d17-p3c-mutate.bak")

EXIT_CHECK = "scripts/lib/d17-p3c-exit-check.py"
PICKER_TEST = "test/workspacePickerWiring.test.mjs"
DETAIL_TEST = "test/taskDetailWiring.test.mjs"

MUTATIONS = [
    (
        "M-P3C-1 视图重新内联 api 请求（设计 §3：views/ 不许发 HTTP）",
        VIEW,
        "onClick={onSave}",
        "onClick={() => { void api('/api/workbench/tasks/x', { method: 'PATCH' }); onSave() }}",
        [EXIT_CHECK],
    ),
    (
        "M-P3C-2 视图自己存一份 state（展示组件不再无状态）",
        VIEW,
        "}: TaskEditModalProps): JSX.Element {\n  return (",
        "}: TaskEditModalProps): JSX.Element {\n  const [hover, setHover] = useState(false)\n  return (",
        [EXIT_CHECK],
    ),
    (
        "M-P3C-3 closeCreate 写成开关（模式 3：同名不同语义被合并）",
        HOOK,
        "const closeCreate = useCallback((): void => { setShowForm(false) }, [])",
        "const closeCreate = useCallback((): void => { setShowForm((v) => !v) }, [])",
        [EXIT_CHECK],
    ),
    (
        "M-P3C-4 入口把 formWorkspace 收回去自己 useState（同一状态两个 owner）",
        INDEX,
        "const { editDraft, formWorkspace } = forms",
        "const { editDraft } = forms\n  const [formWorkspace, setFormWorkspace] = useState('')",
        [EXIT_CHECK, PICKER_TEST],
    ),
    (
        "M-P3C-5 跨域 effect 依赖写成 forms.actions（每帧新对象 → 编辑弹窗一开就被关）",
        INDEX,
        "useEffect(() => { dismissOnTaskChange() }, [selected?.task.id, dismissOnTaskChange])",
        "useEffect(() => { dismissOnTaskChange() }, [selected?.task.id, forms.actions])",
        [EXIT_CHECK],
    ),
    (
        "M-P3C-6 表单字段改名 workspacePath → workspace（既有判据改指新 owner 的反向验证）",
        VIEW,
        '<input type="hidden" name="workspacePath" value={formWorkspace} />',
        '<input type="hidden" name="workspace" value={formWorkspace} />',
        [PICKER_TEST],
    ),
    (
        "M-P3C-7 编辑草稿丢掉契约类型（既有判据改指新 owner 的反向验证）",
        HOOK,
        "const [editDraft, setEditDraft] = useState<TaskEditDraft | null>(null)",
        "const [editDraft, setEditDraft] = useState<any>(null)",
        [DETAIL_TEST],
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
    """跑一批判据目标；`.mjs` 走 node --test，`.py` 走 python。返回 (全绿?, 清单)。"""
    codes = []
    fails = []
    for f in files:
        if f.endswith(".py"):
            proc = subprocess.run([sys.executable, f], capture_output=True, text=True,
                                  encoding="utf-8", errors="replace")
            codes.append(proc.returncode)
            out = (proc.stdout or "") + (proc.stderr or "")
            fails += [l.strip() for l in out.splitlines() if l.strip().startswith("✖")]
        else:
            proc = subprocess.run(["node", "--test", f], capture_output=True, text=True,
                                  encoding="utf-8", errors="replace")
            codes.append(proc.returncode)
            out = (proc.stdout or "") + (proc.stderr or "")
            fails += [l.strip() for l in out.splitlines() if l.strip().startswith("✖")]
    return codes, fails


targets = sorted({f for _, f, _, _, _ in MUTATIONS})
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
codes, _ = run_checks([EXIT_CHECK, PICKER_TEST, DETAIL_TEST])
print(f"\n还原后基线：exit={codes}（应全为 0）")
assert all(c == 0 for c in codes), "还原后基线不是绿的"

print(f"\n结果：{len(MUTATIONS) - green}/{len(MUTATIONS)} 条变异被断言发现")
sys.exit(1 if green else 0)
