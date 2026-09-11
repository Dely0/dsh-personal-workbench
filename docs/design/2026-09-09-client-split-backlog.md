# 客户端拆分收尾：WorkbenchApp 拆分方案（待办）

> 状态：**未开始**。本文件是 `src/client/index.tsx` 继续拆分的施工图，配套工作台任务「工作台客户端拆分收尾」。
> 前置成果见 `docs/design/2026-09-09-architecture-refactor.md`（repo/routes/client 第一轮拆分）。

## 1. 现状

`src/client/index.tsx` 已从 2906 行降到 1958 行：类型进 `viewTypes.ts`、纯函数进 `format.ts`、展示组件进 `components/{Icon,TaskList,PlanPanel}.tsx`。

**剩下的 1958 行里，`WorkbenchApp` 一个函数占了 52–1863 行（约 1812 行）**，内部没有任何子组件，所有状态和 JSX 都平铺在同一个函数体里。行号地图（以当前文件为准）：

| 区间 | 内容 | 备注 |
| --- | --- | --- |
| 52–887 | state 声明 + effects + 业务 handler | 约 40 个 `useState`、20+ `useEffect`、几十个回调 |
| 888–1030 | 顶部工具栏 + 整体布局骨架 | 视图切换、设置入口、待处理计数 |
| 1031–1071 | 今日视图 | |
| 1072–1199 | 日历视图（含 计划/已完成/报告 三个 dayTab） | 最大的一块视图逻辑 |
| 1200–1240 | 知识库视图 | |
| 1241–1316 | 点子视图（点子 / 点子王 两个 tab） | |
| 1317–1389 | 任务列表视图 | 含筛选、排序、归档查看 |
| 1390–1803 | 右侧任务详情区 | **最大单块（约 414 行）**：详情、编辑表单、子任务、会话、记忆、复盘、关联知识 |
| 1804–1863 | 提醒弹窗等收尾 | |

## 2. 目标

- `WorkbenchApp` ≤ 600 行，只负责"布局 + 组合"。
- 每个视图区一个组件文件，props 显式、无隐式全局状态。
- 状态按领域收口到自定义 hook，组件只消费 hook 返回值。
- **对外行为与 DOM 结构不变**（CSS 全靠类名，类名一律不动）。

## 3. 施工顺序（低风险 → 高风险）

### 步骤 1：抽 `components/TaskDetailPanel.tsx`（收益最大）

右侧详情区 414 行，输入输出边界最清晰：

```ts
interface TaskDetailPanelProps {
  detail: TaskDetail
  dicts: Dict[]
  knowledge: KnowledgeEntry[]
  onRefresh: () => void
  onEdit: () => void
  onArchive: () => void
  onRestore: () => void
  onAddSubtask: () => void
  onLinkSession: () => void
  onOpenSession: (sessionId: string) => void
  onStartSession: (role: SessionRole) => void
  onFireReminder: (reminderId: string) => void
  // …按实际用到的回调补齐，宁多勿少
}
```

验收：详情页所有按钮逐个点一遍（编辑、完成、归档、恢复、加子任务、关联会话、开 AI 会话、写记忆、复盘、关联知识）。

### 步骤 2：抽 5 个视图组件

`TodayView` / `CalendarView` / `KnowledgeView` / `IdeasView` / `TaskListView`，每个文件只做"数据 → JSX"。共同依赖（dicts、taskTree、展开集合、排序/筛选状态）通过 props 传入。

### 步骤 3：状态收口到 hook

- `useWorkbenchData()`：tasks/dicts/selected/detail/refresh 与轮询。
- `usePlanAndReports()`：计划与日报周报的加载、AI 会话启动、保存/清除。
- `useIdeas()` / `useKnowledge()`：各自列表 + 增删改 + 关联会话。
- `useSettingsAndReminders()`：设置、提醒策略/通道、测试发送。

`WorkbenchApp` 变成：调用 hook → 把返回值分发给视图组件。

### 步骤 4（可选）：`WorkbenchContext`

如果 props 透传超过 ~40 个，改用 context + 按域拆分（task/plan/idea/knowledge/settings），避免"万能 props 包"。

## 4. 每步的验收清单

1. `node node_modules/typescript/bin/tsc --noEmit` → 0 error。
2. `wsl bash -lc "cd /mnt/d/Code/Linksight/dsh-workbench && pnpm build && node --test test/*.test.mjs"` → 50/50（构建必须在 WSL）。
3. `node D:\DSHWorkspace\_probe\route-regress.mjs` → 29/29（真实 HTTP）。
4. 同步 live profile + `dev_reload_package('dsh-personal-workbench')` → fiber `[active]`。
5. **人工刷新 GUI 目视**：五个页签 + 详情区 + 计划面板 + 各弹窗。

## 5. 风险与对策

- **没有 UI 自动化测试**：纯重构也可能手滑（比如回调漏传导致按钮无反应）。对策：一次只抽一块、抽完立刻目视该块；或先把 `_probe/ui-harness`（用真实 client bundle + 假后端 fixture 在 headless 浏览器里渲染）修好，做成截图回归。
  - 已知障碍：harness 的 CJS 垫片在浏览器里加载 React vendor 文件时抛 `SyntaxError`（Node 下同样代码正常），需要先定位（怀疑是 `new Function` 参数名/编码或 fetch 拿到非源码内容）。
- **状态耦合**：`selected`、`refresh`、各 `*RefreshKey` 被很多视图共享，抽 hook 时容易漏依赖。对策：先抽纯展示组件（步骤 1–2，零状态迁移），最后再动状态（步骤 3）。
- **不要顺手改行为**：拆分期间不修 bug、不调样式、不改文案；发现的问题另开任务。

## 6. 明确不做

- 不改 `/api/workbench/*` 与 `ctx.provide('workbench')` 的对外形状。
- 不改 CSS 类名与 `styles.ts`（视图组件复用同一批类名）。
- 不引入新依赖（除非为 UI 测试，且需单独确认）。
