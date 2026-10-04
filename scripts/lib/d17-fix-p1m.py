#!/usr/bin/env python3
"""D17 P1：修 `useKnowledge.ts` 的两处类型。

- `buildListPage<ContentItem>` 需要 `ContentItem` 类型入 import（上一版的条件判断写错，没补上）；
- `UseKnowledgeResult.page` 原写 `ReturnType<typeof buildListPage>`，会退化成 `ListPage<PresentableItem>`，
  与 `KnowledgeList` 需要的 `ListPage<ContentItem>` 不兼容 —— 直接写 `ListPage<ContentItem>`。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/hooks/useKnowledge.ts"
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
    "import { buildListPage, DEFAULT_SORT_DIR, normalizePageSize, normalizeSortDir, normalizeSortKey, toContentItem } from '../listPresentation.js'",
    "import {\n  buildListPage, DEFAULT_SORT_DIR, normalizePageSize, normalizeSortDir, normalizeSortKey, toContentItem,\n  type ContentItem, type ListPage,\n} from '../listPresentation.js'",
    "import ContentItem / ListPage",
)
sub1(
    "  page: ReturnType<typeof buildListPage>",
    "  page: ListPage<ContentItem>",
    "UseKnowledgeResult.page 明确类型",
)

open(FILE, "w", encoding="utf-8", newline="").write(src.replace("\n", "\r\n"))
print("OK  useKnowledge.ts 已写回")
