# -*- coding: utf-8 -*-
"""
D17 / P7-1 收尾：修 1 个被打红的 test + 3 个变异脚本的失效/重锚点。

1) `test/taskDetailWiring.test.mjs`：`restoreTask` / `createSubtask` 的请求本体已归任务数据域
   ⇒ 正向断言改指 `src/client/hooks/useTaskData.ts`，入口侧改成负向（不许留第二份）。
2) `scripts/lib/d17-mutate-p3b.py` M-P3B-4：P6-1 把靶点改成 NAV_HOOK 时锚点不再唯一
   （文件头注释里也引用了同一行原文）⇒ 锚点加上前导空格与声明前缀，只命中真声明那一行。
   —— 这条是 P6-1 留下的真实欠账：变异脚本当时**没有被重跑**，所以一直没暴露。
3) `scripts/lib/d17-mutate-p3d.py` M-P3D-4：锚点 `.catch((e: unknown) => onError(...))`
   在 P7-1 之后于 hook 里出现 3 次（loadTaskDetail / restoreTask / createSubtask）
   ⇒ 锚点换成 loadTaskDetail 那一句的完整尾巴（唯一）。
4) `scripts/lib/d17-mutate-p5b.py` M-P5b-7：`TICK_HEAD` 仍是 P5-2 的写法，
   而 P5-3 把 `tickDue` 改成了 `useCallback(async (isAlive: () => boolean) => {`
   ⇒ 锚点跟着实现改（同样是"当时没重跑所以要现在补"的欠账）。

⚠️ 每个替换要求恰好命中 1 次；任一不成立整体中止、不写任何文件。
"""
import io
import pathlib
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[2]
ERRORS = []


def sub1(rel, old, new, label):
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    n = text.count(old)
    if n != 1:
        ERRORS.append("[%s] 命中 %d 次（要求恰好 1 次）" % (label, n))
        return
    path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")


# 1) test/taskDetailWiring.test.mjs
sub1(
    "test/taskDetailWiring.test.mjs",
    "const navHookSource = read('src/client/hooks/useWorkbenchNavigation.ts')\n",
    "const navHookSource = read('src/client/hooks/useWorkbenchNavigation.ts')\n"
    "/**\n"
    " * D17/P7-1：`restoreTask` / `createSubtask` 的请求本体随**任务数据域**归域（`WorkbenchApp`\n"
    " * 体内不许再有 `api(` / `fetch(` —— ADR-0008 的结构硬门）。\n"
    " */\n"
    "const taskDataHookSource = read('src/client/hooks/useTaskData.ts')\n",
    "taskDetailWiring 常量",
)
sub1(
    "test/taskDetailWiring.test.mjs",
    "  // 两处 HTTP 改成注入回调后，请求本体必须在装配层（唯一一份）\n"
    "  assert.match(indexSource, /const restoreTask = \\(taskId: string\\): void => \\{\\n\\s+void api\\(`\\/api\\/workbench\\/tasks\\/\\$\\{taskId\\}\\/restore`, \\{ method: 'POST' \\}\\)/,\n"
    "    '恢复任务的请求本体在装配层')\n"
    "  assert.match(indexSource, /const createSubtask = \\(form: FormData, parent: Task\\): void => \\{/,\n"
    "    '新建子任务的请求本体在装配层')\n",
    "  // 两处 HTTP 改成注入回调后，请求本体必须在**任务数据域**（唯一一份；D17/P7-1 归域）\n"
    "  assert.match(taskDataHookSource, /const restoreTask = \\(taskId: string\\): void => \\{\\n\\s+void api\\(`\\/api\\/workbench\\/tasks\\/\\$\\{taskId\\}\\/restore`, \\{ method: 'POST' \\}\\)/,\n"
    "    '恢复任务的请求本体在 useTaskData.ts')\n"
    "  assert.match(taskDataHookSource, /const createSubtask = \\(form: FormData, parent: Task\\): void => \\{/,\n"
    "    '新建子任务的请求本体在 useTaskData.ts')\n"
    "  assert.doesNotMatch(indexSource, /const restoreTask = |const createSubtask = /,\n"
    "    '入口不再各留一份（D17/P7-1：只从 hook 解构使用）')\n"
    "  assert.match(indexSource, /onRestoreTask=\\{restoreTask\\}/, '入口仍把它交给详情面板')\n",
    "taskDetailWiring 断言",
)

# 2) M-P3B-4
sub1(
    "scripts/lib/d17-mutate-p3b.py",
    '        "useState<WorkbenchView>\'today\')",\n',
    '        "  const [view, setView] = useState<WorkbenchView>(\'today\')",\n',
    "mutate-p3b M-P3B-4 锚点",
)

# 3) M-P3D-4
sub1(
    "scripts/lib/d17-mutate-p3d.py",
    '        ".catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))",\n',
    '        "]).then(([detail, ev, rv]) => setSelected({ ...detail, events: ev.events, reviews: rv.reviews })).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))",\n',
    "mutate-p3d M-P3D-4 锚点",
)

# 4) M-P5b-7
sub1(
    "scripts/lib/d17-mutate-p5b.py",
    'TICK_HEAD = "  const tickDue = async (isAlive: () => boolean): Promise<void> => {"\n',
    'TICK_HEAD = "  const tickDue = useCallback(async (isAlive: () => boolean): Promise<void> => {"\n',
    "mutate-p5b TICK_HEAD",
)

if ERRORS:
    print("✖ 中止，未写任何文件：")
    for line in ERRORS:
        print("   - " + line)
    sys.exit(1)

print("✔ 已修 taskDetailWiring.test.mjs + mutate-p3b/p3d/p5b 的锚点")
