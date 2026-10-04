"""D17/P7-3 一次性清理：删掉入口 `src/client/index.tsx` 里已经不用的 import 指定符与解构名。

来源是 P7-2 的必然结果：JSX 搬进 `src/client/app/` 之后，入口原先为那段 JSX 解构出来的
几十个字段与 import 就没人读了。权威判据是 `tsc --noUnusedLocals`，不是正则猜的。

安全设计：
1. 先备份 index.tsx（`%TEMP%\\d17-p7b-index-preclean.bak`）；
2. 每轮跑 `tsc --noUnusedLocals` 收 TS6133/6192/6196/6198（只针对 index.tsx），
   按「语句」粒度删指定符，多行排版原样保留（每个指定符自带它前面的换行与缩进）；
3. 每轮改完立刻跑一遍全项目 `tsc --noEmit`：只要还有**任何**输出就整体还原并中止；
4. 最多 4 轮（删掉一个名字可能让更外层的解构也变成没人读）；
5. 结束打印 before/after sha256、行数差与剩余未处理项（复杂的单行 const 声明留给人工）。

写回一律 `newline="\\n"`。
"""
from __future__ import annotations

import hashlib
import io
import os
import re
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INDEX = os.environ.get("D17_CLEAN_TARGET", os.path.join("src", "client", "index.tsx"))
DRY = INDEX != os.path.join("src", "client", "index.tsx")
BACKUP = os.path.join(os.environ["TEMP"], "d17-p7b-index-preclean.bak")
KILL = {"TS6133", "TS6192", "TS6196", "TS6198"}


def sha(p: str) -> str:
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def read(p: str) -> str:
    return open(p, encoding="utf-8", newline="").read()


def write(p: str, text: str) -> None:
    open(p, "w", encoding="utf-8", newline="").write(text)


def tsc(*flags: str) -> str:
    proc = subprocess.run(["npx", "tsc", "--noEmit", *flags], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", shell=True)
    return (proc.stdout or "") + (proc.stderr or "")


def index_errors(*flags: str):
    out = tsc(*flags)
    hits = []
    for ln in out.splitlines():
        m = re.match(r"^src[\\/]client[\\/]index\.tsx\((\d+),(\d+)\): error (TS\d+): (.*)$", ln.strip())
        if m:
            hits.append((int(m.group(1)), int(m.group(2)), m.group(3), m.group(4)))
    return hits, out


def bound_name(spec: str) -> str:
    """指定符真正绑定的名字：`a as b` / `a: b` / `a = d` / `type X` → 绑定的那个。"""
    s = spec.strip()
    if s.startswith("type "):
        s = s[5:].strip()
    if "=" in s:
        s = s.split("=")[0].strip()
    if " as " in s:
        return s.split(" as ")[-1].strip()
    if ":" in s:
        return s.split(":")[-1].strip()
    return s


def statements(lines):
    """可安全处理的语句：import（单/多行）与解构 `const { … } = …`（单/多行）。"""
    out = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if re.match(r"^import\b", line) or re.match(r"^import type\b", line):
            j = i
            while j < n and "from '" not in lines[j] and 'from "' not in lines[j]:
                j += 1
            out.append((i, min(j, n - 1)))
            i = j + 1
            continue
        if re.match(r"^  const \{\s*$", line):
            j = i
            while j < n and "} = " not in lines[j]:
                j += 1
            out.append((i, min(j, n - 1)))
            i = j + 1
            continue
        if re.match(r"^  const \{[^}]*\} = ", line):
            out.append((i, i))
        i += 1
    return out


def region_of(lines, s: int, e: int):
    """语句里 `{` … `}` 之间的文本（跨行拼接），以及重建时该替换掉的行区间。"""
    open_line = lines[s]
    open_col = open_line.index("{")
    if e == s:
        close_col = open_line.rindex("}")
        return open_line[open_col + 1:close_col], s, e, open_col, close_col
    # 多行：`}` 在最后一行
    close_col = -1
    for i in range(e, s - 1, -1):
        if "}" in lines[i]:
            close_col = lines[i].rindex("}")
            break
    if close_col < 0:
        return None, s, e, open_col, -1
    head = lines[s][open_col + 1:]
    mid = lines[s + 1:e]
    tail = lines[e][:close_col]
    return "\n".join([head, *mid, tail]), s, e, open_col, close_col


def rebuild_region(region: str, unused: set[str]) -> str:
    """删掉未使用指定符；每个指定符自带它前面的换行与缩进，所以多行排版原样保留。"""
    tokens = re.split(r"(,)", region)
    segs = [tokens[i] for i in range(0, len(tokens), 2)]
    tail = segs[-1] if segs and segs[-1].strip() == "" else ""
    body = segs[:len(segs) - 1] if tail else segs
    kept = [seg for seg in body if bound_name(seg) not in unused]
    out = ",".join(kept) + tail
    if tail == "" and out.strip():
        out += " "  # 被删掉的是最后一项时，`}` 前那个空格也跟着没了 —— 补回来
    return out


def main() -> None:
    if "\r\n" in read(INDEX):
        sys.exit("ABORT：index.tsx 是 CRLF，本脚本只处理 LF（避免把整份文件改脏）")
    if not os.path.exists(BACKUP):
        shutil.copyfile(INDEX, BACKUP)
    before_hash = sha(INDEX)
    before_lines = len(read(INDEX).split("\n"))
    print(f"备份 {BACKUP}\n清理前 {INDEX} sha256 {before_hash}  {before_lines} 行")

    for round_no in range(1, 5):
        errs, _ = index_errors("--noUnusedLocals")
        unused = [x for x in errs if x[2] in KILL]
        if not unused:
            print(f"\n第 {round_no} 轮：入口没有未使用项了")
            break

        by_line: dict[int, set[str]] = {}
        whole_lines: set[int] = set()
        for l, _c, code, msg in unused:
            m = re.search(r"'([^']+)' is declared but", msg)
            if code in ("TS6192", "TS6198") or m is None:
                whole_lines.add(l)
                continue
            by_line.setdefault(l, set()).add(m.group(1))

        lines = read(INDEX).split("\n")
        # 先在**原始行号**上把所有改动算出来（不能边遍历边删行，行号会失效），再倒序套用。
        edits = []
        for s0, e0 in statements(lines):
            names: set[str] = set()
            for l in range(s0 + 1, e0 + 2):
                names |= by_line.get(l, set())
            whole = (s0 + 1) in whole_lines or (e0 + 1) in whole_lines
            region, s, e, open_col, close_col = region_of(lines, s0, e0)
            if region is None:
                continue
            # TS6192/TS6198 = 整条都没人用（这时 tsc 不会逐个报名字）⇒ 整条删掉。
            if whole:
                edits.append(("delete", s, e, None, None, None))
                continue
            if not names:
                continue
            new_region = rebuild_region(region, names)
            if new_region.strip() == "":
                edits.append(("delete", s, e, None, None, None))
            else:
                edits.append(("replace", s, e, new_region, open_col, close_col))

        for kind, s, e, new_region, open_col, close_col in sorted(edits, key=lambda t: -t[1]):
            if kind == "delete":
                del lines[s:e + 1]
            elif e == s:
                lines[s] = lines[s][:open_col + 1] + new_region + lines[s][close_col:]
            else:
                # 多行：`}` 之后还有 ` from '…'`（或 ` = day.actions`），必须原样保留。
                head = lines[s][:open_col + 1] + new_region + lines[e][close_col:]
                lines[s:e + 1] = head.split("\n")
        changed = len(edits)

        if changed == 0:
            print(f"\n第 {round_no} 轮：有未使用项但不在可自动改写的语句里，交人工：")
            for l, _c, code, msg in unused:
                print(f"   L{l} {code} {msg[:100]}")
            break

        write(INDEX, "\n".join(lines))
        out = tsc()
        if out.strip():
            write(INDEX, read(BACKUP))
            print("\n❌ 清理引入了编译错误，已整体还原。tsc 输出：")
            print("\n".join(out.splitlines()[:6]))
            sys.exit(1)
        print(f"第 {round_no} 轮：处理 {len(unused)} 处未使用项")

    errs, _ = index_errors("--noUnusedLocals")
    left = [x for x in errs if x[2] in KILL]
    after_lines = len(read(INDEX).split("\n"))
    print(f"\n清理后 {INDEX} sha256 {sha(INDEX)}  {after_lines} 行（-{before_lines - after_lines}）")
    print(f"剩余未处理 {len(left)} 项")
    for l, _c, code, msg in left[:10]:
        print(f"   L{l} {code} {msg[:100]}")

    out = tsc()
    if out.strip():
        print("⚠️ `tsc --noEmit` 仍有输出，需人工：")
        print("\n".join(out.splitlines()[:6]))
        sys.exit(1)
    print("✅ `tsc --noEmit` 全项目 0 错")


main()
