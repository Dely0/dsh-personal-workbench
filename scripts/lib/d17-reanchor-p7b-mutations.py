"""D17/P7-2 变异脚本重锚：M-P5a-11 / M-P6b-4 / M-P6b-5 / M-P6b-8 的靶点（JSX 已搬进 app/）。

先全部校验（每个 old 片段恰好命中 1 次），不成立就整体中止、不写文件。
"""
import io
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

LIB = os.path.join("scripts", "lib")

PATCHES = [
    # ------------------------------------------------ p5a
    (os.path.join(LIB, "d17-mutate-p5a.py"),
     'INDEX = "src/client/index.tsx"\n',
     'INDEX = "src/client/index.tsx"\n'
     '# D17/P7-2：四段 JSX 搬进 src/client/app/ —— 提示层的变异靶点跟着 owner 走。\n'
     'UI_OVERLAYS = os.path.join("src", "client", "app", "WorkbenchOverlays.tsx")\n'),
    (os.path.join(LIB, "d17-mutate-p5a.py"),
     '        "M-P5a-11 DraftBanner 的 onSettled 不再清投影（声称无需重锚的既有判据）",\n        INDEX,\n',
     '        "M-P5a-11 DraftBanner 的 onSettled 不再清投影（声称无需重锚的既有判据）",\n'
     '        UI_OVERLAYS,\n'),
    # ------------------------------------------------ p6b
    (os.path.join(LIB, "d17-mutate-p6b.py"),
     'HELPERS = "src/client/intakeHelpers.ts"\n',
     'HELPERS = "src/client/intakeHelpers.ts"\n'
     '# D17/P7-2：快速录入弹窗的 JSX 搬进 src/client/app/WorkbenchDialogs.tsx ⇒ 靶点跟着 owner 走。\n'
     'UI_DIALOGS = os.path.join("src", "client", "app", "WorkbenchDialogs.tsx")\n'),
    (os.path.join(LIB, "d17-mutate-p6b.py"),
     '        "M-P6b-4 入口把「取消」拆回两连 setState（成组动作被拆回两处）",\n        INDEX,\n',
     '        "M-P6b-4 入口把「取消」拆回两连 setState（成组动作被拆回两处）",\n        UI_DIALOGS,\n'),
    (os.path.join(LIB, "d17-mutate-p6b.py"),
     '        "M-P6b-5 入口把工作区回调拆回内联两连写（绕过唯一写点 overrideWorkspace）",\n        INDEX,\n',
     '        "M-P6b-5 入口把工作区回调拆回内联两连写（绕过唯一写点 overrideWorkspace）",\n        UI_DIALOGS,\n'),
    (os.path.join(LIB, "d17-mutate-p6b.py"),
     '        "M-P6b-8 入口去掉 touched 闸门：自动预填的值也记进「最近手动选择」（.mjs 判据面）",\n        INDEX,\n',
     '        "M-P6b-8 入口去掉 touched 闸门：自动预填的值也记进「最近手动选择」（.mjs 判据面）",\n'
     '        UI_DIALOGS,\n'),
]

plans = {}
for path, old, new in PATCHES:
    src = open(path, encoding="utf-8", newline="").read().replace("\r\n", "\n")
    n = src.count(old)
    if n == 0 and src.count(new) == 1:
        continue
    if n != 1:
        print(f"ABORT：{path} 里 old 片段命中 {n} 次（要求恰好 1 次）\n  >>> {old[:140]}")
        sys.exit(1)
    plans.setdefault(path, []).append((old, new))

for path, items in plans.items():
    src = open(path, encoding="utf-8", newline="").read().replace("\r\n", "\n")
    for old, new in items:
        assert src.count(old) == 1, path
        src = src.replace(old, new, 1)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(src)
    print(f"✔ 已重锚 {path}（{len(items)} 处）")

print("\n结果：全部重锚完成")
