"""D17 / P7-2 切块：把 `WorkbenchApp` 的 JSX 按**四段位置**搬进 `src/client/app/*.tsx`。

为什么按位置而不是按类别分段：弹窗原本夹在顶栏与主体之间、以及主体之后，
   全都挪到一起会改动 DOM 顺序（遮罩层叠与焦点顺序都可能变）。四段因此各自待在
   原来的位置上，拼装出来的 DOM 与搬迁前逐层一致：

   第  823– 843 行  顶栏 `wb-h`                                  → app/WorkbenchHeader.tsx
   第  845–1001 行  提示层（补充提示词 / 到期提醒 / 草稿条 / 重复任务）→ app/WorkbenchOverlays.tsx
   第 1003–1182 行  主体 `wb-body`（导航 + 右栏详情 + 设置弹窗）    → app/WorkbenchBody.tsx
   第 1183–1493 行  弹窗（快速录入 / 新建 / 编辑 / 目录选择）        → app/WorkbenchDialogs.tsx

每段的依赖集**不是手抄的**：脚本读入口里 JSX 之外的**全部绑定**（解构 / const / function /
WorkbenchApp 的 props / import），把该段用到的名字按**来源**分组（`data` / `data.actions` /
`prefs.actions` / 装配层本地值），再据此生成 `const { … } = props.xxx` —— 与入口现在的
解构同源，所以生成的解构名和迁移前的局部名逐个一致（不把 `selected` 改写成 `data.selected`）。

写回源码一律 `newline="\n"`；中文注释里不要出现 ASCII 双引号（用 「」）。
"""

from __future__ import annotations

import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
os.chdir(ROOT)

INDEX = os.path.join("src", "client", "index.tsx")
APP_DIR = os.path.join("src", "client", "app")

HOOKS = {
    "nav", "data", "forms", "detail", "taskList", "day", "quick", "ai", "prefs", "dir",
    "busyApi", "remindersApi", "draftsApi", "knowledge", "ideas", "feedback",
}

# 1-based 行号 → 期望原文（含缩进）。对不上就整体中止，一个字都不写。
GUARDS = {
    821: "  return (",
    822: '    <div className="wb-app">',
    823: '      <div className="wb-h">',
    843: "      </div>",
    844: "",
    845: "      {promptModal !== null && (",
    1001: "      )}",
    1002: "",
    1003: '      <div className="wb-body">',
    1182: "      </div>",
    1183: "      {showQuick && (",
    1493: "      />",
    1494: "      <ToastHost items={toasts} onDismiss={dismissToast} />",
    1495: '    </div>',
    1496: "  )",
    1497: "}",
}

# 组件名 → (标签, 起, 止, 外壳)
COMPONENTS = [
    ("WorkbenchHeader", "顶栏", 823, 843, "div"),
    ("WorkbenchOverlays", "提示层", 845, 1001, "frag"),
    ("WorkbenchBody", "主体", 1003, 1182, "div"),
    ("WorkbenchDialogs", "弹窗", 1183, 1493, "frag"),
]


def load(p: str) -> str:
    with open(p, encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


def save(p: str, text: str) -> None:
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def abort(msg: str) -> None:
    print(f"ABORT：{msg}")
    sys.exit(1)


def strip_comments(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", " ", s, flags=re.S)
    s = re.sub(r"^[ \t]*//.*$", "", s, flags=re.M)
    return s


def split_entries(raw: str, keep_type: bool = False) -> list[str]:
    """把 `a, b: c, d = e` 拆成 ['a', 'c', 'd']（取别名后的名字）。"""
    out: list[str] = []
    raw = re.sub(r"/\*.*?\*/", " ", raw, flags=re.S)
    raw = re.sub(r"//[^\n]*", " ", raw)
    for part in raw.split(","):
        p = part.strip()
        if p == "":
            continue
        if keep_type and p.startswith("type "):
            p = p[5:].strip()
        if ":" in p:
            p = p.split(":", 1)[1].strip()
        if "=" in p:
            p = p.split("=", 1)[0].strip()
        p = p.strip()
        if re.fullmatch(r"[A-Za-z_$][\w$]*", p):
            out.append(p)
    return out


def parse_bindings(text: str) -> dict[str, str | None]:
    bind: dict[str, str | None] = {}

    def add(name: str, src: str | None) -> None:
        if name and name not in bind:
            bind[name] = src

    for m in re.finditer(r"function WorkbenchApp\(\{([^}]*)\}", text):
        for n in split_entries(m.group(1)):
            add(n, None)
    for m in re.finditer(
        r"(?:const|let)\s*\{([^{}]*)\}\s*(?::[^=\n]*)?=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)",
        text,
    ):
        for n in split_entries(m.group(1)):
            add(n, m.group(2))
    # 顶层只有两种缩进：模块级 0 格、WorkbenchApp 体内 2 格。
    # 只吃这两档，才不会把 handler 体内的局部 const 当成"装配层可注入的值"。
    for m in re.finditer(
        r"^(?:  |)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", text, re.M
    ):
        add(m.group(1), None)
    for m in re.finditer(r"^(?:  |)(?:export\s+)?const\s+([A-Za-z_$][\w$]*)", text, re.M):
        add(m.group(1), None)
    for m in re.finditer(r"^(?:  |)let\s+([A-Za-z_$][\w$]*)", text, re.M):
        add(m.group(1), None)
    return bind


def parse_imports(text: str) -> dict[str, tuple[str, bool]]:
    out: dict[str, tuple[str, bool]] = {}
    for m in re.finditer(
        r"import\s+(type\s+)?(\{[^}]*\}|[A-Za-z_$][\w$]*)(?:\s*,\s*(\{[^}]*\}))?\s*from\s*'([^']+)'",
        text,
        re.S,
    ):
        stmt_type = m.group(1) is not None
        body = m.group(2)
        extra = m.group(3)
        module = m.group(4)
        parts: list[tuple[str, bool]] = []
        if body.startswith("{"):
            for p in body[1:-1].split(","):
                p = p.strip()
                if p == "":
                    continue
                t = p.startswith("type ")
                if t:
                    p = p[5:].strip()
                name = p.split(" as ")[-1].strip()
                parts.append((name, t or stmt_type))
        elif body:
            parts.append((body.strip(), stmt_type))
        if extra:
            for p in extra[1:-1].split(","):
                p = p.strip()
                if p == "":
                    continue
                t = p.startswith("type ")
                if t:
                    p = p[5:].strip()
                parts.append((p.split(" as ")[-1].strip(), t or stmt_type))
        for name, t in parts:
            if name and name not in out:
                out[name] = (module, t)
    return out


def identifiers(text: str) -> set[str]:
    return set(re.findall(r"[A-Za-z_$][\w$]*", text))


def inner_bound(text: str) -> set[str]:
    """区间内**自己绑定**的名字（箭头函数参数等）—— 它们不是依赖。"""
    out: set[str] = set()
    for m in re.finditer(r"\(([^()]*)\)\s*=>", text):
        for p in m.group(1).split(","):
            p = p.split(":")[0].split("=")[0].strip().rstrip("?")
            if re.fullmatch(r"[A-Za-z_$][\w$]*", p):
                out.add(p)
    for m in re.finditer(r"(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>", text):
        out.add(m.group(1))
    for m in re.finditer(r"\bas\s+([A-Za-z_$][\w$]*)", text):
        out.add(m.group(1))
    return out


def strip_strings(s: str) -> str:
    """去掉单/双引号字符串（**不动模板串** —— 模板串里的 `${…}` 是真实依赖）。

    JSX 属性值（`name="list"`）与比较字面量（`view === 'list'`）都长这样，
    不清掉就会把 `list` 这种词当成依赖。
    """
    s = re.sub(r'"(?:[^"\\\n]|\\.)*"', " ", s)
    s = re.sub(r"'(?:[^'\\\n]|\\.)*'", " ", s)
    return s


def inside_attr_only(name: str, region_bare: str) -> bool:
    """该名字在区间里**只出现在 JSX 属性名位置**（`size=…` / `open=…`）→ 不是依赖。"""
    hits = list(re.finditer(r"(?<![\w$.])" + re.escape(name) + r"\b", region_bare))
    if not hits:
        return True
    for m in hits:
        if not re.match(r"\s*=", region_bare[m.end():m.end() + 2]):
            return False
    return True


LINES = load(INDEX).split("\n")
if LINES and LINES[-1] == "":
    LINES.pop()
for n, expect in GUARDS.items():
    if n > len(LINES):
        abort(f"第 {n} 行不存在（文件只有 {len(LINES)} 行）")
    got = LINES[n - 1]
    if got != expect:
        abort(f"第 {n} 行与期望不符\n  期望：{expect!r}\n  实际：{got!r}")

# JSX 之外的全部入口文本（前后两段拼起来）
rest = "\n".join(LINES[:820] + LINES[1497:])
BIND = parse_bindings(rest)
IMPORTS = parse_imports(load(INDEX))

print(f"入口共 {len(LINES)} 行；解析到绑定 {len(BIND)} 个、import {len(IMPORTS)} 个")

regions: dict[str, str] = {}
for name, label, lo, hi, shell in COMPONENTS:
    regions[name] = "\n".join(LINES[lo - 1:hi])

# 扫描前先剥注释与字符串字面量（`<Icon name="bell" />` 里的 name、`view === 'list'` 里的 list
# 都不是依赖），剩下的少量漏网之鱼显式排除：`name` 是插件入口的导出名、
# `host` 是 JSX 文本里的裸英文词（「host 侧已推送的…」）。
ATTR_DENY = {"name", "host"}

# ---------------------------------------------------------------- 每段的依赖集
report: dict[str, dict] = {}
for name, label, lo, hi, shell in COMPONENTS:
    text = regions[name]
    region_bare = strip_strings(strip_comments(text))
    ids = identifiers(region_bare) - inner_bound(region_bare) - ATTR_DENY
    hooks: dict[str, list[str]] = {}
    flat: list[str] = []
    imps: dict[str, list[tuple[str, bool]]] = {}
    for i in sorted(ids):
        if i in IMPORTS:
            module, t = IMPORTS[i]
            imps.setdefault(module, []).append((i, t))
        elif i in BIND:
            src = BIND[i]
            if src is None:
                if not inside_attr_only(i, region_bare):
                    flat.append(i)
            else:
                head = src.split(".")[0]
                if head in HOOKS:
                    hooks.setdefault(src, []).append(i)
                else:
                    flat.append(i)
    report[name] = {"label": label, "lo": lo, "hi": hi, "shell": shell,
                    "hooks": hooks, "flat": flat, "imports": imps}

flat_union: set[str] = set()
for name, r in report.items():
    print(f"\n--- {name}（{r['label']}，L{r['lo']}–L{r['hi']}）")
    for src in sorted(r["hooks"]):
        print(f"    props.{src}: {' '.join(sorted(r['hooks'][src]))}")
    print(f"    装配层本地值（{len(r['flat'])}）：{' '.join(sorted(r['flat']))}")
    for module in sorted(r["imports"]):
        names = " ".join(n + ("(type)" if t else "") for n, t in sorted(r["imports"][module]))
        print(f"    import {module}: {names}")
    flat_union |= set(r["flat"])

print(f"\n四段装配层本地值并集（{len(flat_union)}）：{' '.join(sorted(flat_union))}")


# ---------------------------------------------------------------- 生成四个组件文件
def rel_module(module: str) -> str:
    if module.startswith("./"):
        return "../" + module[2:]
    return module


def import_lines(imps: dict[str, list[tuple[str, bool]]]) -> list[str]:
    out: list[str] = []
    for module in sorted(imps):
        named = sorted(imps[module])
        parts = ", ".join(("type " if t else "") + n for n, t in named)
        out.append(f"import {{ {parts} }} from '{rel_module(module)}'")
    return out


def component_text(name: str, r: dict) -> str:
    head = [
        "/**",
        f" * D17 / P7-2：`WorkbenchApp` 的**{r['label']}** JSX（搬迁前 index.tsx 的第 {r['lo']}–{r['hi']} 行）。",
        " *",
        " * 逐字搬出 —— 内层行的缩进一个字没改，只把外层标签挪进本文件的 `return`，",
        " * 所以拼装出来的 DOM 与拆分前逐层一致（弹窗刻意留在原来的位置上，不改层叠顺序）。",
        " *",
        " * 依赖以 `WorkbenchAssembly` 整体注入，这里只**解构自己真正用到的那几个** ——",
        " * 解构名与入口里的局部名逐个一致（不把 `selected` 改写成 `data.selected`，",
        " * 既有判据锚的就是这些原文）。",
        " */",
        "import type { WorkbenchAssembly } from './assembly.js'",
    ]
    head += import_lines(r["imports"])
    body: list[str] = [
        "",
        f"export function {name}(props: WorkbenchAssembly): JSX.Element {{",
    ]
    for src in sorted(r["hooks"]):
        body.append(f"  const {{ {', '.join(sorted(r['hooks'][src]))} }} = props.{src}")
    if r["flat"]:
        body.append(f"  const {{ {', '.join(sorted(r['flat']))} }} = props")
    body.append("  return (")
    lines = regions[name].split("\n")
    if r["shell"] == "div":
        body.append("    " + lines[0].strip())
        body.extend(lines[1:-1])
        body.append("    " + lines[-1].strip())
    else:
        body.append("    <>")
        body.extend(lines)
        body.append("    </>")
    body.append("  )")
    body.append("}")
    return "\n".join(head + body) + "\n"


for name, label, lo, hi, shell in COMPONENTS:
    text = component_text(name, report[name])
    save(os.path.join(APP_DIR, name + ".tsx"), text)
    print(f"已写：{os.path.join(APP_DIR, name + '.tsx')}（{len(text.splitlines())} 行）")

# ---------------------------------------------------------------- 改入口
ASSEMBLY_FIELDS = [
    "nav", "data", "forms", "detail", "taskList", "day", "quick", "ai", "prefs", "dir",
    "busyApi", "remindersApi", "draftsApi", "knowledge", "ideas", "feedback",
    "runtime", "closePanel", "loadModelModalityTable", "aiSessionUsable",
]
head_entry = LINES[:820]
new_tail = [
    "  /**",
    "   * D17 / P7-2：整个 JSX 已按「顶栏 / 提示层 / 主体 / 弹窗」四段搬进 `src/client/app/`。",
    "   * 四段在下面的顺序 = 搬迁前它们在 DOM 里的顺序（弹窗那两段刻意留在原地）。",
    "   * 装配层只剩「把域的结果捆成一束」这一件事 —— 每个组件只解构自己用到的字段。",
    "   */",
    "  const assembly: WorkbenchAssembly = {",
]
for i in range(0, len(ASSEMBLY_FIELDS), 8):
    new_tail.append("    " + ", ".join(ASSEMBLY_FIELDS[i:i + 8]) + ",")
new_tail += [
    "  }",
    "",
    "  return (",
    '    <div className="wb-app">',
    "      <WorkbenchHeader {...assembly} />",
    "      <WorkbenchOverlays {...assembly} />",
    "      <WorkbenchBody {...assembly} />",
    "      <WorkbenchDialogs {...assembly} />",
    "      <ToastHost items={toasts} onDismiss={dismissToast} />",
    "    </div>",
    "  )",
    "}",
]
tail_entry = LINES[1497:]
NEW_IMPORTS = [
    "import type { WorkbenchAssembly } from './app/assembly.js'",
    "import { WorkbenchHeader } from './app/WorkbenchHeader.js'",
    "import { WorkbenchOverlays } from './app/WorkbenchOverlays.js'",
    "import { WorkbenchBody } from './app/WorkbenchBody.js'",
    "import { WorkbenchDialogs } from './app/WorkbenchDialogs.js'",
]
anchor = "import { useWorkbenchBusy } from './hooks/useWorkbenchBusy.js'"
head_text = "\n".join(head_entry)
if head_text.count(anchor) != 1:
    abort(f"import 锚点命中 {head_text.count(anchor)} 次（应为 1）")
head_text = head_text.replace(anchor, anchor + "\n" + "\n".join(NEW_IMPORTS))
out = head_text + "\n" + "\n".join(new_tail) + "\n" + "\n".join(tail_entry)

# 收尾自检（写盘前）
for needle in ['const assembly: WorkbenchAssembly = {', "      <WorkbenchDialogs {...assembly} />"]:
    if needle not in out:
        abort(f"入口缺锚点：{needle}")
for gone in ['      {showQuick && (', '      <div className="wb-body">', "      {promptModal !== null && ("]:
    if gone in out:
        abort(f"入口仍留 JSX 片段：{gone}")
save(INDEX, out)
print(f"已写：{INDEX}（{len(out.splitlines())} 行，原 {len(LINES)} 行）")
print("下一步：手写 src/client/app/assembly.ts（四段的 props 类型），再跑 npx tsc --noEmit")
