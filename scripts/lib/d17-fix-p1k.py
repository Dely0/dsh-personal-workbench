#!/usr/bin/env python3
"""D17 P1：把 `useKnowledge` 的 `startAISession` 入参从「直接传函数」改成「传 ref」。

原因：`useKnowledge(...)` 的调用点在组件上部，而 `startAISession` 是组件中部的 `const`
（没有提升）—— 直接传它在 TS 层是 TS2448/TS2454，在运行层就是 ReferenceError。
改成 ref 惰性转发后：hook 位置不变（调用顺序不变），函数在定义之后一行内被写入。
"""
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

FILE = "src/client/hooks/useKnowledge.ts"
src = open(FILE, encoding="utf-8", newline="").read()

OLD_SIG = """export interface UseKnowledgeInput {"""
NEW_SIG = """/**
 * 发起 AI 会话的签名（本域只用 `knowledge_doc` 一个 mode）。
 *
 * ⚠️ 单独抽出来是为了给下面的 ref 型入参用：`startAISession` 在入口里是组件中部的 `const`，
 * 没有提升，所以入口传的是 `useRef` 出来的**惰性转发 ref**（在函数定义之后才写入 `current`）。
 */
export type StartAISessionFn = (
  mode: 'knowledge_doc',
  task: Task | null,
  text: string,
  previousSessions?: Array<Record<string, unknown>>,
  docContext?: { fileLink: string; content: string; name?: string; truncated?: boolean },
  workspaceOverride?: string,
  clarifyOptions?: { attachments?: readonly QuickAttachmentDraft[]; followFolder?: boolean; persona?: PersonaSelection },
) => Promise<void>

export interface UseKnowledgeInput {"""
assert src.count(OLD_SIG) == 1, "ABORT 找不到 UseKnowledgeInput"
src = src.replace(OLD_SIG, NEW_SIG, 1)

OLD_FIELD = """  /** 发起 AI 会话（本域只用 `knowledge_doc` 一个 mode）。 */
  startAISession: (
    mode: 'knowledge_doc',
    task: Task | null,
    text: string,
    previousSessions?: Array<Record<string, unknown>>,
    docContext?: { fileLink: string; content: string; name?: string; truncated?: boolean },
    workspaceOverride?: string,
    clarifyOptions?: { attachments?: readonly QuickAttachmentDraft[]; followFolder?: boolean; persona?: PersonaSelection },
  ) => Promise<void>"""
NEW_FIELD = """  /**
   * 发起 AI 会话的**惰性转发 ref**（不是函数本身）。
   *
   * 入口在 `startAISession` 定义之后写下 `ref.current = startAISession`；本 hook 只在真实发会话时解引用。
   */
  startAISession: { current: StartAISessionFn | null }"""
assert src.count(OLD_FIELD) == 1, "ABORT 找不到 startAISession 字段"
src = src.replace(OLD_FIELD, NEW_FIELD, 1)

OLD_CALL = "      await startAISession('knowledge_doc', null, res.fileLink, [], { fileLink: res.fileLink, content: res.content, name: res.name, truncated: res.truncated })"
NEW_CALL = """      const start = startAISession.current
      if (start === null) throw new Error('AI 会话入口尚未就绪')
      await start('knowledge_doc', null, res.fileLink, [], { fileLink: res.fileLink, content: res.content, name: res.name, truncated: res.truncated })"""
assert src.count(OLD_CALL) == 1, "ABORT 找不到 startAISession 调用点"
src = src.replace(OLD_CALL, NEW_CALL, 1)

# 剩余对 startAISession(...) 的直接调用（若有）也要过 ref
import re
leftover = re.findall(r"(?<![\w.])startAISession\(", src)
if leftover:
    raise SystemExit(f"ABORT 还有 {len(leftover)} 处直接调用 startAISession(")

# 修 TS2345：localDirRequestUrl 收 string | null（null = 盘符列表）
OLD_URL = "import { localDirRequestUrl } from '../localDirBrowser.js'"
if src.count(OLD_URL) == 1:
    pass  # 签名在 localDirBrowser.ts，下面单独处理

open(FILE, "w", encoding="utf-8", newline="").write(src)
print("OK  useKnowledge.ts：startAISession 改为 ref 入参")
