#!/usr/bin/env python3
"""D17 P1：清掉两处删除留下的尾巴（openKnowledgeFile 的 catch/finally 残骸）。"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/index.tsx"
src = open(FILE, encoding="utf-8", newline="").read()
orig = len(src)

LEFTOVER = (
    "    } catch (e) {\r\n"
    "      setError(e instanceof Error ? e.message : String(e))\r\n"
    "    }\r\n"
    "  }\r\n"
    "\r\n"
    "  const saveDictionaryEntry = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {\r\n"
)
FIXED = "  const saveDictionaryEntry = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {\r\n"

n = src.count(LEFTOVER)
if n != 1:
    raise SystemExit(f"ABORT 残骸: 命中 {n} 次")
src = src.replace(LEFTOVER, FIXED, 1)

open(FILE, "w", encoding="utf-8", newline="").write(src)
print(f"CUT   残骸  -{len(LEFTOVER) - len(FIXED)}")
print(f"len {orig} -> {len(src)}")
