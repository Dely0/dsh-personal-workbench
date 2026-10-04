#!/usr/bin/env python3
"""D17 P1：`workspacePickerWiring.test.mjs` 里"入口两处 LocalDocModal"的判据跟实现走。

知识库那份 **file 模式** 弹窗已经跟知识域一起搬进 `views/KnowledgeListView.tsx`（它自己
`createPortal(..., document.body)`，渲染位置不影响 DOM 层级）。所以"两处用法"的事实没有变，
变的是它们不再同处一个文件 —— 按 §8.2 改成**全客户端目录里恰好两处**（比只扫 index 更强）。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "test/workspacePickerWiring.test.mjs"
raw = open(FILE, encoding="utf-8", newline="").read()
src = raw.replace("\r\n", "\n").replace("\r", "\n")


def sub1(old, new, tag):
    global src
    n = src.count(old)
    if n != 1:
        raise SystemExit(f"ABORT [{tag}] 命中 {n} 次")
    src = src.replace(old, new, 1)
    print(f"  ok  {tag}")


sub1(
    "const root = join(dirname(fileURLToPath(import.meta.url)), '..')\n"
    "const INDEX = readFileSync(join(root, 'src/client/index.tsx'), 'utf8')\n"
    "const MODAL = readFileSync(join(root, 'src/client/components/LocalDocModal.tsx'), 'utf8')\n"
    "const PICKER = readFileSync(join(root, 'src/client/components/WorkspacePicker.tsx'), 'utf8')",
    "import { read, assertClientCount } from './_clientSources.mjs'\n"
    "\n"
    "const root = join(dirname(fileURLToPath(import.meta.url)), '..')\n"
    "const INDEX = read('src/client/index.tsx')\n"
    "/** D17/P1：知识库那份 file 模式弹窗已随知识域搬进 `views/KnowledgeListView.tsx`。 */\n"
    "const KNOWLEDGE_VIEW = read('src/client/views/KnowledgeListView.tsx')\n"
    "const MODAL = read('src/client/components/LocalDocModal.tsx')\n"
    "const PICKER = read('src/client/components/WorkspacePicker.tsx')",
    "引入 owner 源码",
)

sub1(
    "  // index.tsx 里两处用法：知识库(file，默认) + 工作区(dir)\n"
    "  assert.equal(count(INDEX, /<LocalDocModal/g), 2, '两个弹窗用法：知识库文件的 + 工作区的')\n"
    "  assert.match(INDEX, /mode=\"dir\"/, '工作区那一处必须显式 dir 模式')",
    "  // 两处用法：知识库(file，默认，已随知识域搬进 views/) + 工作区(dir，仍在入口的快速录入弹窗里)\n"
    "  assertClientCount(assert, /<LocalDocModal/g, 2, '两个弹窗用法：知识库文件的 + 工作区的')\n"
    "  assert.match(KNOWLEDGE_VIEW, /<LocalDocModal/, '知识库那份仍在知识视图里')\n"
    "  assert.match(INDEX, /<LocalDocModal/, '工作区那份仍在入口里')\n"
    "  assert.match(INDEX, /mode=\"dir\"/, '工作区那一处必须显式 dir 模式')",
    "W03 两处用法",
)

open(FILE, "w", encoding="utf-8", newline="").write(src.replace("\n", "\r\n"))
print("OK  workspacePickerWiring.test.mjs 已写回")
