#!/usr/bin/env python3
"""D17 / P6-4 搬迁：工作区「浏览…」目录选择域（DirectoryPicker）。

把 `src/client/index.tsx` 里 5 项 state 与 `loadDirPickerDir` 搬进
`src/client/hooks/useWorkbenchDirectoryPicker.ts`，并加一个 `openFor(target, start)` 动作
（= 原来的 setTarget + setPath + 立刻列一次）。

**刻意留在装配层的**：`openDirPicker(target)`（读三个入口的当前值算出起始目录）、
`applyWorkspaceDir(dirPath)`（唯一分派点，写回 quick / form / edit 三个域）与弹窗 JSX。

手法沿用前几批：按锚点原文替换、命中数不为 1 就整体中止不写文件、
写回源码显式 `newline="\n"`（否则 Windows 上会把整份 index.tsx 写成 CRLF，
这个坑 P5-2 踩过一次），中文注释里不出现 ASCII 双引号。

用法：python scripts/lib/d17-cut-p6d.py
"""
import io
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
os.chdir(ROOT)

INDEX = os.path.join("src", "client", "index.tsx")

IMPORT_ANCHOR = "import { useWorkbenchAISessions } from './hooks/useWorkbenchAISessions.js'\n"
IMPORT_NEW = "import { useWorkbenchDirectoryPicker } from './hooks/useWorkbenchDirectoryPicker.js'\n"

STATE_BLOCK = (
    "  const [dirPickerTarget, setDirPickerTarget] = useState<null | 'quick' | 'form' | 'edit'>(null)\n"
    "  const [dirPickerPath, setDirPickerPath] = useState('')\n"
    "  const [dirPickerListing, setDirPickerListing] = useState<LocalDirListing | null>(null)\n"
    "  const [dirPickerLoading, setDirPickerLoading] = useState(false)\n"
    "  const [dirPickerError, setDirPickerError] = useState<string | null>(null)\n"
)
STATE_NEW = (
    "  // 目录选择域（D17/P6-4）：5 项弹窗状态与 `loadDirPickerDir` 已收进\n"
    "  // hooks/useWorkbenchDirectoryPicker.ts。装配层只留「算起始目录」与「选完写到哪」两件跨域的事。\n"
    "  const dir = useWorkbenchDirectoryPicker()\n"
    "  const { dirPickerTarget, dirPickerPath, dirPickerListing, dirPickerLoading, dirPickerError } = dir\n"
    "  const { openFor, loadDirPickerDir, setDirPickerTarget, setDirPickerPath } = dir.actions\n"
)

LOAD_BLOCK = (
    "  /**\n"
    "   * 列目录（工作区「浏览…」弹窗）——请求形状与知识库那个弹窗**同一实现**\n"
    "   * （`localDirBrowser.ts#localDirRequestUrl`），这里只管自己的状态。\n"
    "   */\n"
    "  const loadDirPickerDir = async (path?: string | null): Promise<void> => {\n"
    "    setDirPickerLoading(true); setDirPickerError(null)\n"
    "    try {\n"
    "      const res = await api<LocalDirListing>(localDirRequestUrl(path))\n"
    "      setDirPickerListing(res)\n"
    "      setDirPickerPath(res.path)\n"
    "    } catch (e) {\n"
    "      setDirPickerError(e instanceof Error ? e.message : String(e))\n"
    "    } finally {\n"
    "      setDirPickerLoading(false)\n"
    "    }\n"
    "  }\n"
)
LOAD_NEW = (
    "  // 列目录（D17/P6-4）：请求与状态都收进 hooks/useWorkbenchDirectoryPicker.ts。\n"
)

OPEN_BLOCK = (
    "  /**\n"
    "   * 打开工作区的「浏览…」弹窗。\n"
    "   * 起始目录＝该入口当前的值（留空则后端默认落在主目录）。\n"
    "   */\n"
    "  const openDirPicker = (target: 'quick' | 'form' | 'edit'): void => {\n"
    "    setDirPickerTarget(target)\n"
    "    const start = target === 'quick' ? quickWorkspace : target === 'form' ? formWorkspace : (editDraft?.workspacePath ?? '')\n"
    "    setDirPickerPath(start)\n"
    "    void loadDirPickerDir(start)\n"
    "  }\n"
)
OPEN_NEW = (
    "  /**\n"
    "   * 打开工作区的「浏览…」弹窗（装配层：起始目录来自三个入口的当前值）。\n"
    "   * 起始目录＝该入口当前的值（留空则后端默认落在主目录）。\n"
    "   */\n"
    "  const openDirPicker = (target: 'quick' | 'form' | 'edit'): void => {\n"
    "    const start = target === 'quick' ? quickWorkspace : target === 'form' ? formWorkspace : (editDraft?.workspacePath ?? '')\n"
    "    openFor(target, start)\n"
    "  }\n"
)

STEPS = [
    ("import 新 hook", IMPORT_ANCHOR, IMPORT_ANCHOR + IMPORT_NEW),
    ("state 块换成 hook 调用 + 两段解构", STATE_BLOCK, STATE_NEW),
    ("删 loadDirPickerDir 本体（带原 doc 注释）", LOAD_BLOCK, LOAD_NEW),
    ("openDirPicker 改成装配层组合（调 openFor）", OPEN_BLOCK, OPEN_NEW),
]


def read(path):
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read().replace("\r\n", "\n")


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def sub1(src, old, new, label):
    count = src.count(old)
    if count != 1:
        raise SystemExit(f"ABORT [{label}] 锚点命中 {count} 次（应为 1），未写任何文件")
    return src.replace(old, new, 1)


src = read(INDEX)
original = src
for label, old, new in STEPS:
    src = sub1(src, old, new, label)

# ---------------- 收尾自检（任一不成立就整体中止，不写文件）
problems = []


def must_not_appear(text, label):
    if text in src:
        problems.append(f"入口仍然出现：{label}")


def must_appear(text, label):
    if text not in src:
        problems.append(f"入口缺少：{label}")


for gone in [
    "const [dirPickerTarget, setDirPickerTarget] = useState<null | 'quick' | 'form' | 'edit'>(null)",
    "const [dirPickerPath, setDirPickerPath] = useState('')",
    "const [dirPickerListing, setDirPickerListing] = useState<LocalDirListing | null>(null)",
    "const [dirPickerLoading, setDirPickerLoading] = useState(false)",
    "const [dirPickerError, setDirPickerError] = useState<string | null>(null)",
    "const loadDirPickerDir = async (path?: string | null): Promise<void> => {",
    "await api<LocalDirListing>(localDirRequestUrl(path))",
]:
    must_not_appear(gone, gone[:64])

for here in [
    "import { useWorkbenchDirectoryPicker } from './hooks/useWorkbenchDirectoryPicker.js'",
    "const dir = useWorkbenchDirectoryPicker()",
    "const { dirPickerTarget, dirPickerPath, dirPickerListing, dirPickerLoading, dirPickerError } = dir",
    "const { openFor, loadDirPickerDir, setDirPickerTarget, setDirPickerPath } = dir.actions",
    "    openFor(target, start)",
    "  const applyWorkspaceDir = (dirPath: string): void => {",
    "onNavigate={(target) => void loadDirPickerDir(target)}",
    "onPathChange={setDirPickerPath}",
    "onClose={() => setDirPickerTarget(null)}",
    "onPickDir={(entry) => applyWorkspaceDir(entry.path)}",
]:
    must_appear(here, here[:64])

if problems:
    print("ABORT：收尾自检未通过，未写任何文件")
    for item in problems:
        print(f"   - {item}")
    sys.exit(1)

if src == original:
    print("无改动（脚本已跑过？）")
    sys.exit(0)

write(INDEX, src)
print("已写回 src/client/index.tsx")
print(f"行数 {len(original.split(chr(10))) - 1} → {len(src.split(chr(10))) - 1}")
