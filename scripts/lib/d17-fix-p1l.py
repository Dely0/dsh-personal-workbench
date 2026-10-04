#!/usr/bin/env python3
"""D17 P1：`useKnowledge` 的 `setError` / `setNotice` 入参放宽为 `string | null`。

入口的 `setError` 是 `useState<string | null>(...)` 的 setter，本域里有 4 处 `setError(null)` /
`setNotice(null)`（"清掉上一条提示"）。原来声明成 `(message: string) => void` 就报 TS2345。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/hooks/useKnowledge.ts"
_raw = open(FILE, encoding="utf-8", newline="").read()
src = _raw.replace("\r\n", "\n")

OLD = "  setError: (message: string) => void\n  setNotice: (message: string) => void"
NEW = (
    "  /** 入口的 `setError`：本域会写 `null` 来清掉上一条提示，所以必须收 `string | null`。 */\n"
    "  setError: (message: string | null) => void\n"
    "  /** 同上（`setNotice`）。 */\n"
    "  setNotice: (message: string | null) => void"
)
if src.count(OLD) != 1:
    raise SystemExit(f"ABORT 命中 {src.count(OLD)} 次")
src = src.replace(OLD, NEW, 1)

open(FILE, "w", encoding="utf-8", newline="").write(src.replace("\n", "\r\n"))
print("OK  setError/setNotice 放宽为 string | null")
