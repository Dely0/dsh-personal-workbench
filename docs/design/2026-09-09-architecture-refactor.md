# 架构重构记录（2026-09-09）

## 背景：三个"上帝文件"

工作台插件功能增长很快，到本次重构前，逻辑集中在三个超大文件里：

| 文件 | 重构前 | 重构后 | 问题 |
| --- | --- | --- | --- |
| `src/db/repo.ts` | 2248 行 | 202 行 | 任务/草稿/提醒/计划/报告/知识/点子全塞在一个文件，改一处要读 2000 行 |
| `src/api/routes.ts` | 975 行 | 168 行 | 9 个领域路由 + 路由辅助函数 + 常量混在一起 |
| `src/client/index.tsx` | 2906 行 | 1958 行 | 类型、格式化工具、展示组件、`WorkbenchApp`（1800 行）全在一起 |

对外行为必须不变：`ctx.provide('workbench', …)` 暴露的工具、`/api/workbench/*` 路由、客户端渲染结果都保持原样。

## 重构原则

1. **逐字搬迁（verbatim move）**：抽文件时只允许"剪切 + 加 import/export"，不允许顺手改逻辑。每批搬迁后用 `tsc --noEmit` + 50 个 node 测试 + 29 条路由回归兜底。
2. **门面不变**：`src/db/repo.ts` 仍然是唯一对外入口（`import { … } from '../db/repo.js'` 全部照旧），只是内部改成 re-export；`makeRoutes(db, deps)` 签名不变。
3. **契约单一来源**：前后端共享的 HTTP 形状放 `src/shared/contracts.ts`，客户端不再各自重复定义。

## 新结构

```
src/
├─ shared/contracts.ts        前后端共享的 HTTP 契约（任务/提醒/草稿视图）
├─ db/
│  ├─ repo.ts                门面：类型声明 + re-export（202 行）
│  └─ repo/                  17 个领域模块（2319 行）
│     shared.ts              草稿骨架 withDraftConfirm / getDraft / setDraftStatus
│     task-primitives.ts     任务行解析、effectiveDueAt/WorkspacePath、事件写入
│     tasks.ts status.ts     任务增改与状态机（完成级联、归档恢复）
│     drafts.ts              confirm*Draft 家族
│     plans.ts reports.ts knowledge.ts ideas.ts …（按领域一一对应）
├─ api/
│  ├─ routes.ts              组合入口 + 跨领域端点（158 行）
│  └─ routes/
│     helpers.ts             loopback 围栏、writeJson、readJsonBody、pathSegments、字典校验、期间计算
│     tasks.ts reminders.ts drafts.ts ideas.ts idea-clusters.ts knowledge.ts
│     ai-sessions.ts reports.ts plans.ts   ← 每个文件导出 make<Domain>Routes(db)
└─ client/
   ├─ index.tsx              WorkbenchApp 主体（1958 行）
   ├─ viewTypes.ts           客户端视图模型类型
   ├─ format.ts              纯格式化/中文标签（无状态、无副作用）
   ├─ api.ts styles.ts constants.ts taskFilterSort.ts workspacePath.ts
   └─ components/            Modal Toast SettingsModal DraftBanner MarkdownText
                             Icon TaskList PlanPanel（展示型组件）
```

## 消除的重复

- **草稿确认骨架**：9 处 `confirm*Draft` 各自重复"取草稿 → 校验 kind → BEGIN → 业务 → 标记 confirmed → COMMIT/ROLLBACK"，现在统一走 `withDraftConfirm(db, draftId, kind, build, opts)`（`src/db/repo/shared.ts`），各函数只描述"确认时具体建什么"。
- **路由辅助函数**：`isLoopbackRequest` / `writeJson` / `readJsonBody` / `pathSegments` / `requireCode` / `periodRange` / `reportContext` / `publicTask` / `taskInputFromBody` 等只保留在 `api/routes/helpers.ts` 一份，各领域路由 import 使用。
- **前端类型**：提醒相关类型改为从 `shared/contracts.ts` 引入，不再本地复制。

## 顺手修掉的真实缺陷

- `/api/workbench/health` 曾把版本号硬编码为 `1.8.0`（包已经到 1.10.1）。现在运行时读包内 `package.json`，并让 `test/routes.test.mjs` 断言"health 版本 === package.json 版本"，防止再次漂移。

## 验证

| 项目 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 error |
| `node --test test/*.test.mjs` | 50 / 50 pass |
| 构建 | `pnpm build`（WSL）→ lib + client.js 303.95 kB（gzip 85.51 kB） |
| 路由回归（真实 HTTP，loopback） | 29 / 29 pass：health、bootstrap、settings、tasks(+archived/详情/events/memories/reviews)、drafts、ideas、idea-clusters、knowledge、ai-sessions、reports(+context)、plans、reminders(+due/policy/channel)、workspaces/ensure、maintenance/repair-parents，以及写路径 create → PATCH → archive → restore → archive → 清理校验 |
| 热重载 | `dev_reload_package` 清 42 模块重建 fiber，状态 `[active]` |
| 回归脚本 | `D:\DSHWorkspace\_probe\route-regress.mjs`（可重复执行，自带临时任务清理） |

## 遗留 / 下一步

- **UI 视觉验证需人工确认**：客户端 bundle 结构变了，需在 GUI 里刷新页面后人工确认工作台面板正常（本次环境无法带 token 起无头浏览器，`dsh web` 的鉴权 URL 只在用户浏览器里有效）。
- **`index.tsx` 仍有 1958 行**：`WorkbenchApp` 内部的视图区（今日/日历/知识库/点子/任务）尚未拆分，它们共享大量 state，拆分需要先抽 props 契约或改用 context，属于下一轮。
- **既有未修问题**：提醒策略关闭时，未 dismiss 的逾期提醒会被前端每 5 秒重新横幅（`listDueReminders` 无下界，`fired_at` 只在 dismiss 时写入）。
