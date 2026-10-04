"""D17/P7-1 反向验证：把「最后 6 处 `api(` 归域」这件事**装回缺陷**，p7a 出口自检必须变红。

每批都要有自己的反向验证（设计 §2.1 / prompt-p6 §4）：只跑绿不算证据，
"注入缺陷必红、还原必绿"才算。本批六条：

- M-P7a-1 入口重新出现业务请求（`api(` 回到 WorkbenchApp 体内）—— §8 结构硬门
- M-P7a-2 入口把 `archiveSelectedTask` 收回来自己定义（同一语义两个 owner）—— §1/§2
- M-P7a-3 任务数据域的归档路由被改掉（请求形状与它的所有者脱钩）—— §2 路由字面量
- M-P7a-4 入口把 `createTask` 收回来自己定义（请求本体回流装配层）—— §1/§2
- M-P7a-5 三个跨域注入回调少一个（`onTaskCreated` 被写成裸 setState 调用）—— §4 接线
- M-P7a-6 设置域的 `saveDailyCapacity` 签名退化（装配层原语被收窄成零参）—— §2 完整声明原文

用法：python scripts/lib/d17-mutate-p7a.py
"""
import hashlib
import io
import os
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
INDEX = os.path.join("src", "client", "index.tsx")
TASK_DATA = os.path.join("src", "client", "hooks", "useTaskData.ts")
SETTINGS = os.path.join("src", "client", "hooks", "useWorkbenchSettings.ts")
EXIT_CHECK = os.path.join("scripts", "lib", "d17-p7a-exit-check.py")

# 注入点：WorkbenchApp 体内、域名装配之前（确保它确实落在函数体内，被 §8 的"体内"口径看到）
BODY_MARK = "  const data = useTaskData({"
MUTATIONS = [
    (
        "M-P7a-1 入口重新内联业务请求（体内出现 `api(`）",
        INDEX,
        BODY_MARK,
        "  void api('/api/workbench/bootstrap')\n" + BODY_MARK,
        [EXIT_CHECK],
    ),
    (
        "M-P7a-2 入口把 archiveSelectedTask 收回来自己定义（两个 owner）",
        INDEX,
        BODY_MARK,
        "  const archiveSelectedTask = (): void => {}\n" + BODY_MARK,
        [EXIT_CHECK],
    ),
    (
        "M-P7a-3 任务数据域的归档路由被改掉（请求形状脱离所有者）",
        TASK_DATA,
        "`/api/workbench/tasks/${id}/archive`",
        "`/api/workbench/tasks/${id}/archived`",
        [EXIT_CHECK],
    ),
    (
        "M-P7a-4 入口把 createTask 收回来自己定义（请求本体回流装配层）",
        INDEX,
        BODY_MARK,
        "  const createTask = async (form: FormData): Promise<void> => { void form }\n" + BODY_MARK,
        [EXIT_CHECK],
    ),
    (
        "M-P7a-5 跨域注入回调被写成别的东西（onTaskCreated 不再关闭新建弹窗）",
        INDEX,
        "    onTaskCreated: () => forms.actions.closeCreate(),\n",
        "    onTaskCreated: () => undefined,\n",
        [EXIT_CHECK],
    ),
    (
        "M-P7a-6 设置域 saveDailyCapacity 签名退化（装配层原语被收窄）",
        SETTINGS,
        "const saveDailyCapacity = async (rawEdit: string): Promise<void> => {",
        "const saveDailyCapacity = async (): Promise<void> => {",
        [EXIT_CHECK],
    ),
]


def sha(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def read(path: str) -> str:
    with open(path, encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


def write(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def run(paths) -> list[int]:
    codes = []
    for p in paths:
        cmd = [sys.executable, p] if p.endswith(".py") else ["node", "--test", p]
        codes.append(subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                                    encoding="utf-8", errors="replace").returncode)
    return codes


TARGETS = sorted({t for _, _, _, _, ts in MUTATIONS for t in ts})
baseline_sha = {p: sha(os.path.join(ROOT, p)) for p in {m[1] for m in MUTATIONS}}
for p, h in sorted(baseline_sha.items()):
    print(f"基线 {p} sha256 {h}")

failures = 0
for name, path, old, new, targets in MUTATIONS:
    full = os.path.join(ROOT, path)
    src = read(full)
    print(f"\n== {name} ==")
    if src.count(old) != 1:
        print(f"  ✖ ABORT：锚点命中 {src.count(old)} 次（要求 1 次）—— 源码结构变了，需要同步本脚本")
        failures += 1
        continue
    try:
        write(full, src.replace(old, new, 1))
        codes = run(targets)
        if all(c != 0 for c in codes):
            print(f"  变红：exit={codes} 目标={targets}")
        else:
            print(f"  ✖ 装回缺陷后**仍然全绿** → 这条修复没有任何断言在守（exit={codes}）")
            failures += 1
    finally:
        write(full, src)

# 还原自检：逐文件 sha256 必须与基线一致，且基线必须全绿
restored_ok = True
for p, h in sorted(baseline_sha.items()):
    now = sha(os.path.join(ROOT, p))
    same = now == h
    restored_ok = restored_ok and same
    print(f"\n还原后 {p} sha256 {now}  一致={same}")

base_codes = run(TARGETS)
print(f"\n还原后基线：exit={base_codes}（应全为 0）")
assert restored_ok, "还原后文件与基线不一致"
assert all(c == 0 for c in base_codes), "还原后基线不是绿的"

if failures:
    print(f"\n✖ 结果：{len(MUTATIONS) - failures}/{len(MUTATIONS)} 条变异被断言发现（{failures} 条逃逸）")
    sys.exit(1)
print(f"\n结果：{len(MUTATIONS)}/{len(MUTATIONS)} 条变异被断言发现")
