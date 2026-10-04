#!/usr/bin/env python3
"""D17 P6-4 反向验证：给刚迁移的 **目录选择域** 注入缺陷，确认判据会真的变红。

规范 §8.5：未变异基线必须绿 → 恢复相同缺陷必红 → 还原再绿。
缺陷分布在两个文件（入口 / 目录选择域 hook），所以每条变异自带目标路径
（与 `d17-mutate-p4.py` / `p5a.py` / `p5b.py` / `p5c.py` / `p6b.py` / `p6c.py` 同构）。

为什么这十三条：
- M-P6d-1/2/3 盯**同一状态只有一个 owner**：`dirPickerTarget` / `dirPickerListing` /
  `loadDirPickerDir` 都是"顺手留一份在入口"最常见的形态；
- M-P6d-4/5 盯**成组动作与唯一分派点**：`openFor` 被拆回三连内联、`applyWorkspaceDir`
  的分派被改成只写一个域（后者正是批次2 #2 修过的"三入口各写一份"复发形态）；
- M-P6d-6/7 盯**装配层的两件跨域事仍在**：起始目录不再从三个入口当前值算（写死空串）；
- M-P6d-8/9/10 盯**域边界与纯度**：越界写别的域 / 自己起定时器 / 改回裸 fetch；
- M-P6d-11 盯**请求形状的唯一来源**：hook 自己拼路由字面量（哨兵 / 编码口径会分叉）；
- M-P6d-12 盯**状态数目**：多塞一项 state 就是"借搬家顺手加东西"；
- M-P6d-13 盯 openFor 的三件事一件都不能少（记来源 / 记起始目录 / 立刻列一次）。

用法：python scripts/lib/d17-mutate-p6d.py
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = "src/client/index.tsx"
HOOK = "src/client/hooks/useWorkbenchDirectoryPicker.ts"
BACKUP = os.path.join(os.environ["TEMP"], "d17-p6d-mutate.bak")

EXIT_CHECK = "scripts/lib/d17-p6d-exit-check.py"
NODE_TESTS = ["test/workspacePickerWiring.test.mjs", "test/workspacePicker.test.mjs"]

HOOK_CALL = "  const dir = useWorkbenchDirectoryPicker()\n"
OPEN_FOR_CALL = "    openFor(target, start)\n"
START_LINE = "    const start = target === 'quick' ? quickWorkspace : target === 'form' ? formWorkspace : (editDraft?.workspacePath ?? '')\n"
DISPATCH_FORM = "    if (target === 'form') { forms.actions.setFormWorkspace(picked); return }\n"

LOAD_DECL = "  const loadDirPickerDir = async (path?: string | null): Promise<void> => {\n"
LOAD_REQUEST = "      const res = await api<LocalDirListing>(localDirRequestUrl(path))\n"
OPEN_FOR_DECL = "  const openFor = (target: DirectoryPickerTarget, start: string): void => {\n"
OPEN_FOR_TARGET = "    setDirPickerTarget(target)\n"
OPEN_FOR_PATH = "    setDirPickerPath(start)\n"

MUTATIONS = [
    (
        "M-P6d-1 入口把 dirPickerTarget 收回去自己 useState（同一状态两个 owner）",
        INDEX,
        HOOK_CALL,
        HOOK_CALL + "  const [dirPickerTarget, setDirPickerTarget] = useState<DirectoryPickerTarget | null>(null)\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6d-2 入口复活一份 dirPickerListing（两个列表来源）",
        INDEX,
        HOOK_CALL,
        HOOK_CALL + "  const [dirPickerListing, setDirPickerListing] = useState<LocalDirListing | null>(null)\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6d-3 入口再定义一份 loadDirPickerDir（列目录两个实现）",
        INDEX,
        HOOK_CALL,
        HOOK_CALL + "  const loadDirPickerDir = async (): Promise<void> => {}\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6d-4 入口把 openFor 拆回三连内联（成组动作被拆回两处）",
        INDEX,
        OPEN_FOR_CALL,
        "    setDirPickerTarget(target)\n    setDirPickerPath(start)\n    void loadDirPickerDir(start)\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6d-5 唯一分派点退化：form 分支被改成写快速录入域（三入口各写一份的复发形态）",
        INDEX,
        DISPATCH_FORM,
        "    if (target === 'form') { overrideWorkspace(picked); return }\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6d-6 起始目录不再从三个入口的当前值算（写死空串）",
        INDEX,
        START_LINE,
        "    const start = ''\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6d-7 入口的 applyWorkspaceDir 被改名（唯一分派点的判据面）",
        INDEX,
        "  const applyWorkspaceDir = (dirPath: string): void => {\n",
        "  const applyWorkspaceDirRaw = (dirPath: string): void => {\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6d-8 目录选择域 hook 越界去写快速录入域（域边界被打破）",
        HOOK,
        LOAD_DECL,
        "  void overrideWorkspace\n" + LOAD_DECL,
        [EXIT_CHECK],
    ),
    (
        "M-P6d-9 目录选择域 hook 自己起一个定时器（本域不拥有定时器）",
        HOOK,
        LOAD_DECL,
        "  setInterval(() => undefined, 1000)\n" + LOAD_DECL,
        [EXIT_CHECK],
    ),
    (
        "M-P6d-10 目录选择域 hook 改回裸 fetch（不走 api 客户端）",
        HOOK,
        LOAD_REQUEST,
        "      const res = await fetch(localDirRequestUrl(path)).then((r) => r.json()) as LocalDirListing\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6d-11 hook 自己拼路由字面量（请求形状不再只有一处来源）",
        HOOK,
        LOAD_REQUEST,
        "      const res = await api<LocalDirListing>('/api/workbench/knowledge/list-local-dir?path=' + encodeURIComponent(path ?? ''))\n",
        [EXIT_CHECK],
    ),
    (
        "M-P6d-12 hook 多塞一项 state（借搬家顺手加东西）",
        HOOK,
        OPEN_FOR_DECL,
        "  const [dirPickerExtra, setDirPickerExtra] = useState(false)\n" + OPEN_FOR_DECL,
        [EXIT_CHECK],
    ),
    (
        "M-P6d-13 openFor 丢掉「起始目录立刻落到地址栏」这一半",
        HOOK,
        OPEN_FOR_PATH,
        "",
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
