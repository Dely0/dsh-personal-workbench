#!/usr/bin/env python3
"""D17 P3-1 收尾：把入口里两处**跨域**使用列表域 state 的地方改走 hook 的快照/动作。"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")


def sub1(old, new, tag):
    global src
    n = src.count(old)
    if n != 1:
        raise SystemExit(f"ABORT [{tag}] hits={n}")
    src = src.replace(old, new, 1)
    print(f"  ok  {tag}")


sub1("...archivedTasks],", "...taskList.archivedTasks],", "capacity reads archived snapshot")
sub1("[tasks, archivedTasks, todayPlan,", "[tasks, taskList.archivedTasks, todayPlan,", "capacity deps")
sub1("`archivedTasks` 只有打开", "`taskList.archivedTasks` 只有打开", "capacity comment")
sub1("setArchivedMode(false)", "taskList.actions.setArchivedMode(false)", "restore task exits archive mode")

open(FILE, "w", encoding="utf-8", newline="\n").write(src)
print(f"lines -> {src.count(chr(10)) + 1}")
