# 知识草稿静默覆盖：同一会话重复提交会覆盖前一条且不可察觉

- **日期**：2026-09-17
- **任务**：`f4a3430f-3f81-42e8-b4e5-2bf3e67be3e1`（工具交互 / 文档类修复）
- **分支**：`fix/knowledge-draft-overwrite-visibility`
- **性质**：**不是功能性 bug**。按会话去重是刻意的设计约束，本版只修「静默」这一半。

## 现象（修前）

在同一个会话里连续两次调用 `workbench_submit_knowledge`：

- 两次都**返回成功**，不报错、不警告；
- 返回值里的草稿 id **每次相同**（后一次替换前一次）；
- 返回的措辞也一样（`知识草稿已保存（id=…）`），读起来像"新建了一条"；
- **会话里看不到草稿 id**，界面也长得和新建一模一样。

最刺痛的场景：一个会话里分多次沉淀多条独立主题的知识 → 每次都"成功" →
到界面**确认一次** → 入库存下的是**最后一次**，前面几次全部白干，而且**无法发现**。

## 根因

`src/tools.ts#submitKnowledgeTool` 在没传 `draft_id` 时走
`getPendingKnowledgeDraft(db, sessionId)`（`src/db/repo/knowledge.ts`），
命中本会话那份 pending 知识草稿就 `updateDraft` —— 这正是团队记忆
`01M2A09R4TWTG1D1S7FP0D1M3Y` 记录的「按会话去重」机制。缺陷不在去重，而在于：

1. 回执**不区分**「新建」与「覆盖」，只有一句话；
2. 「这份草稿被覆盖过」这件事**没有落进任何数据**，所以界面无从显示、
   用户点确认前也没有任何提示。

## 修法（唯一权威源 + 落库 + 两处可见）

1. **新纯模块** `src/shared/knowledgeDraftOverwrite.ts`：
   - `planKnowledgeDraftWrite` 判定 `created` / `replaced-session-draft` / `updated-draft`；
   - `knowledgeDraftWriteMessage` 按模式生成回执；
   - `readKnowledgeDraftHistory` / `knowledgeDraftOverwriteNotice` 由落库 payload 生成界面提示；
   - `KNOWLEDGE_DRAFT_SESSION_CONSTRAINT` 是「一个会话只产生 1 条 + 多条走
     `POST /api/workbench/drafts`」的唯一文案源，工具说明、工具回执、界面提示共用。
2. **回执**：第二次不带 `draft_id` 的提交返回
   `⚠️ 已更新本会话已有草稿（id=…）——不是新建：…前一次的内容（标题「…」）已被本次替换…`
   并把被替换的标题**在 `updateDraft` 之前**从旧草稿读出来。
3. **落库**：payload 增加 `revision`（累计写入次数）与 `replacedTitles`（被覆盖掉的标题，
   最多 5 条）。`confirmKnowledgeDraft` 忽略这两个键，入库内容不受影响。
4. **界面**：把知识草稿正文抽成可测组件 `src/client/components/KnowledgeDraftBody.tsx`
   （同 `KnowledgeList.tsx` 的做法，进 `tsconfig.build.json` 白名单），
   在正文上方渲染警示块：本会话第 N 次提交 / 被覆盖的标题 / **草稿 id** /
   "点「确认入库」入库的是当前这份" / 绕行路由。

## 明确不做（本版范围）

- **不改**按会话去重的架构（有意设计，且有官方绕行方案）；
- **不做**「一次提交多个条目」（草稿内列表化）——成本更高，等这条落地后按需再评估；
- 知悉但未改的**同构兄弟**：`workbench_submit_report` 在同一会话 + 同一周期下也是
  "同样措辞的覆盖"。本轮范围只有知识草稿；要一并处理请另开一条。

## 验收证据

```powershell
pnpm build
node scripts/repro/repro-knowledge-draft-overwrite.mjs      # 20/20
node scripts/repro/probe-knowledge-draft-overwrite-mutations.mjs  # 16/16 全红
pnpm test                                                   # 全绿
```

- `repro-knowledge-draft-overwrite.mjs`：在**真实库的只读副本**（`VACUUM INTO`）上，
  用真实工具连续提交两次 → 打印两次原始回执 → 用**真实组件 + 真样式 + headless Edge**
  断言提示块真的画出来了（尺寸/可见性/警示边框/文本/带草稿 id/排在标题之上），
  并与"摘掉历史的 payload"并排截图对照（`_local-archive/knowledge-draft-overwrite/`）
  → 调真实 `confirmKnowledgeDraft` 完成"用户点确认入库" → 回读知识库：
  **只入库 1 条，内容是第二次的，第一次的内容整库搜不到**。
- 变异探针 16/16：每一条断言都被证明真的在守东西，包括"把回执改回 `知识草稿已保存`"
  与"界面提示恒为 null"都会让它变红。
