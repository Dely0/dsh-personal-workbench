# T2 交接：跨日计划投入与容量闭环（D05–D09 / S5–S9 含 S5-E、S6-E）

任务 `42393199-c4b8-446c-9339-43b52d287cff`（父任务 `36c8e8ef-…`）。2026-09-30。

**本文件是 T2 的实现交接与证据记录，不是"本轮全部 AX 已通过"的声明。**
B 层（浏览器真实点击）验收归 T6；本文件中标"未验证"的项不得当作已过。

基线：`main @ 69a310f`（与 `origin/main` 一致），`SCHEMA_VERSION` 仍是 **19**（T1 已用掉，
**T2 未新增任何迁移**，也未新增计划表列）。工作树里带着 T1 的未提交改动（同一执行链）。

---

## 1. 范围与不做什么

| 片段 | 内容 | 落点 |
|---|---|---|
| D05 | 计划仓储完整字段：minutes 快照、effortDone 只由用户写、共同链校验、重复确认幂等 | `src/db/repo/plans.ts`、`src/tools.ts`、`src/shared/dailyPlanPolicy.ts` |
| D06 | GET/PUT 新字段、**POST 原子追加**、**PATCH 项级更新** | `src/api/routes/plans.ts`、`src/api/routes.ts`（bootstrap 计划视图） |
| D07 | 计划投入显示/编辑、「今日投入结束/继续投入」、完成任务分开、显式 25/50/75 建议、原「明天」改名 | `src/client/components/PlanPanel.tsx`、`src/client/index.tsx`、`src/client/styles.ts` |
| D08 | 统一候选纯函数 + 提示词构造（30 条上限的唯一实现） | `src/shared/dailyPlanPolicy.ts`、`src/client/dailyPlanPrompt.ts` |
| D09 | 容量改由计划快照派生、未排入区与一键排入、全调用点接线 | `src/client/capacity.ts`、`components/CapacityRulePanel.tsx`、`index.tsx` |

**明确不做**（任务边界）：S14 页面结构收敛、`WorkbenchApp` 拆分、提醒/到期/父任务级联规则、
把投入当实际工时、自动累计进度；无迁移、无公开版本号变更、无装盘/重启/公开发布。

## 2. 数据与契约

### 2.1 计划项形状（`daily_plans.items_json[]`）

```
{ taskId, order, title, note, minutes: 1–1440 整数（快照）, effortDone: boolean }
```

- **快照**：新项在**提案创建那一刻**取 `estimatedMinutes`（合法 1–1440）否则
  `settings.defaultEstimateMinutes`（缺省 30），此后改任务估时**不回头改写**。
- **`effortDone` 只能由用户写**：AI 工具传它**当场报错**；草稿确认一律取服务端最新值。
- 读取端（`parsePlanItems`）：坏 JSON / 非数组 → `readable:false`（容量显示"不可计算"，
  **不是 0**）；坏项被跳过但**留下可读诊断**（"第 N 项不是对象"），原串一个字节不动。

### 2.2 共同校验（唯一实现 `shared/dailyPlanPolicy.ts#checkPlanTaskSet`）

1. 同 taskId 不得重复；
2. 新增项任务必须存在，且未归档 / 未 done / 未 cancelled；
3. 同一父子链不能同时入计划（兄弟叶子允许）；
4. **既有项豁免**：事务里读到既有计划中的缺失/关闭项允许原样保留、也不因一次无关写入被拒
   （历史脏数据的父子链不替用户改决定）。

> ⚠️ **实现时实测抓到并修掉的一个真 bug**：`archived` 在仓储行是 `0|1` 数字、在客户端
> `Task` 是布尔，早期写成 `archived === true ? 1 : 0` → 仓储行的 `1` 被当成"未归档"，
> **"新增已归档任务"被静默放行**。现在统一走 `archivedFlag()`，两种类型都认，
> 并由 `test/dailyEffort.test.mjs` 的 AX-D04 那条断言钉住。

### 2.3 HTTP

| 方法 | 路径 | 语义要点 |
|---|---|---|
| GET | `/plans?date=` | 返回 `{plan, readable, diagnostics}`；`plan=null` = 没有计划；缺失任务项**照常返回**（`taskStatusCode:'missing'`） |
| PUT | `/plans/:date` | 全量编辑；项可含 `minutes`；**省略即按 taskId 保留服务端最新值**（含 effortDone）；`items=[]` 400（清空用 DELETE） |
| POST | `/plans/:date/items` | **一键排入的唯一入口**：`BEGIN IMMEDIATE` 内读最新计划 → 末尾追加；已存在同 taskId → `added:false` 且**不改**已有值；不存在任务 404、关闭/归档/父子链冲突 400；`{ok,plan,added}` |
| PATCH | `/plans/:date/items/:taskId` | 只动目标项；`minutes`/`effortDone` 至少一个；**未来不得 `effortDone=true`**；过去整体只读；计划/项不存在 404、非法值 400；只改 effortDone 保留 `sourceCode`，改 minutes 转 `manual` |

**幂等与并发**：相同值重复提交不刷 `updatedAt`；`POST` 用 `BEGIN IMMEDIATE`（写事务一开始就
拿写锁），并发两条追加最终都在（`test/dailyEffort.test.mjs` 的 AX-C05 用 `Promise.all` 真跑）。
**没有**用"客户端旧列表 + PUT"模拟追加（那是被明令禁止的做法）。

## 3. 唯一口径（防止"同一语义两处算"）

| 语义 | 唯一权威源 | 禁止的第二份 | 怎么钉住的 |
|---|---|---|---|
| 当日候选 | `shared/dailyPlanPolicy.ts#planCandidates` | `index.tsx` 旧内联 filter | 源码扫描（`capacityWiring.test.mjs`）+ 表驱动（`dailyPlanPolicy.test.mjs`） |
| 30 条上限 | `selectPromptCandidates` | 调用点 `.slice(0, 30)` | 扫描：全仓不许再出现 `.slice(0, 30)` |
| 已排容量 | `computeCapacityLedger`（计划 minutes 求和） | 按到期任务求和 | `capacity.test.mjs` 明确断言"新版 ≠ 旧口径 240" |
| 分钟校验 | `checkPlanMinutes` | 各处现搓范围判断 | 工具/路由/仓储/组件全部 import 它 |
| 计划写入 | `db/repo/plans.ts` 四个入口 | 路由里拼 JSON | 路由只做 HTTP 语义与日期权限 |

## 4. 实际命令与结果（2026-09-30）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **通过**（`tsc --noEmit`，无输出） |
| `pnpm build` | **通过**（`lib/client.js` 486.57 kB，gzip 140.86 kB；T1 时 468.02 kB） |
| `node --test test/db.test.mjs test/tools.test.mjs test/routes.test.mjs test/capacity.test.mjs test/capacityPanel.test.mjs test/capacityWiring.test.mjs test/dailyPlanPolicy.test.mjs test/dailyEffort.test.mjs test/progress*.test.mjs` | **tests 191 / pass 190 / fail 1**（唯一失败见 §5.1；断言全部跑过） |
| `node --test test/*.test.mjs`（全套） | **tests 692 / pass 691 / fail 1**（同上；T1 基线 648 → 新增 44） |

### 4.1 基线核对（**重要：那 1 个失败与本次改动无关**）

`test/db.test.mjs` 的 `db migrations, dictionaries and task tree` 在本机**改动前就已失败**：

- 失败的**不是断言**，而是 `finally` 里的 `rmSync(dir, {recursive:true, force:true})`
  抛 `EPERM: Permission denied`（Windows 上 WAL 库句柄释放慢）。
- 复现方式：把 T2 的 5 个源文件 `git checkout` 回基线（`src/db/repo/plans.ts`、
  `src/db/repo.ts`、`src/tools.ts`、`src/api/routes/plans.ts` 用备份还原；
  `dailyPlanPolicy.ts` 当时已是 T1 版本），再跑 `node --test test/db.test.mjs`
  → **同样 EPERM**。证据：同一台机、同一目录、同一行号。
- 已加 `removeTempDir()`（重试 10 次 × 50ms）以降低复现率；本机仍复现，说明句柄在整个
  进程存活期都没释放（进程退出后目录可正常删除，已实测）。**不得**通过删除断言求绿。

### 4.2 定向变异（拆掉防护必须变红；跑完即恢复，无 `.mutbak` 残留）

| 变异（在 `lib/` 产物上原地注入） | 结果 | 恢复 |
|---|---|---|
| 拆掉 `checkPlanTaskSet` 的"新增项必须 open"校验 | `dailyEffort` **fail 1**（AX-D04 那条） | pass 17 / fail 0 |
| 让 `planCandidates` 不再因 "在推进" 入候选（回到旧口径） | `dailyPlanPolicy` **fail 10**、`capacity` **fail 6** | 两个文件各自全绿 |
| 拆掉 POST 追加的幂等（已存在也追加） | `dailyEffort` **fail 2** | pass 17 / fail 0 |
| 拆掉"未来不得结束投入"的路由校验 | `dailyEffort` **fail 2** | pass 17 / fail 0 |
| 让 `planned` 改读任务估时（容量回到"按到期求和"的口径） | `capacity` **fail 6** | pass 19 / fail 0 |

`Get-ChildItem -Recurse -Filter *.mutbak` → 空。

## 5. AX 覆盖情况（T2 归属部分）

| AX | 覆盖位置 | 状态 |
|---|---|---|
| AX-D01 显式 minutes 1/90/1440 合法；0/1441/小数/字符串整份拒绝；估时 600 省略取 600；无估时取默认；回执列最终分钟 | `dailyPlanPolicy.test.mjs`（校验）、`dailyEffort.test.mjs`（快照）、`tools.test.mjs`（回执含"计划投入 30 min"） | ✅ 实测通过 |
| AX-D02 旧 JSON 回填/保留排序/未知 taskId/坏 JSON 原串+诊断；容量不可计算 | `progressDb.test.mjs`（T1 侧）+ `dailyEffort.test.mjs`（"坏串 → readable=false 且不给假 0"） | ✅ 实测通过（迁移侧 T1 证据；界面呈现归 T6） |
| AX-D03 创建草稿取 minutes=90、改估时后确认仍 90；同 task 既有项省略保留；API 改备注不丢 minutes/effortDone | `dailyEffort.test.mjs`（3 条）、`dailyPlanPolicy.test.mjs`（保留规则的纯函数侧） | ✅ 实测通过 |
| AX-D04 重复 taskId / 父子同链 / 新增关闭或归档 / 新增未知任务拒绝且不部分创建；兄弟叶子允许；既有缺失项保留且不妨碍追加；草稿确认再校验；AI 传 effortDone 报错 | `dailyEffort.test.mjs`（2 条）、`db.test.mjs`、`routes.test.mjs`、`tools.test.mjs` | ✅ 实测通过 |
| AX-D05 PATCH 今天项只改该日目标项；相同值幂等；任务状态/进度/due/estimate 与其他项不变；结束不改 sourceCode、改分钟转 manual | `dailyEffort.test.mjs`（2 条） | ✅ 实测通过（**比较的是 tasks 行逐字段快照**，不靠源码扫描） |
| AX-D06 日期/项不存在 404；缺字段或非法值 400；过去 400、未来结束 true 拒绝；PUT 省略字段保留；items 空拒绝 | `dailyEffort.test.mjs`、`routes.test.mjs` | ✅ 实测通过 |
| AX-D07 浏览器：真实点"今日投入结束"→刷新仍 true、task 仍 doing | — | ⚠️ **未验证（T6 的 `suites/daily-effort.mjs`）**；HTTP/仓储侧的行为已由 `dailyEffort.test.mjs` 覆盖 |
| AX-D08 浏览器：投入结束只出现显式 25/50/75；点 50 只写 progress；"完成任务"/"推迟截止一天"各走各的 | `PlanPanel` 接线（代码层）+ `dailyEffort.test.mjs`（两个动作分别只改 effortDone / dueAt 的语义） | ⚠️ **未验证（T6）**；组件层已按需求实现，未经人眼 |
| AX-D09 结束后重排/改备注/确认旧草稿保留最新结束状态；删除再添加为 false；明天同任务新项 false；关闭/缺失留行无操作按钮 | `dailyEffort.test.mjs`（4 条：重开不重置、删除再添加、跨日、关闭/缺失）+ `db.test.mjs` | ✅ 仓储/HTTP 通过；**行内 UI 留行与按钮禁用属 B 层（T6）** |
| AX-C01 候选表驱动（due 当日 / 继承 due / doing 未来截止 / blocked 无截止 / 已有计划 / 逾期开关 / 归档 done cancelled / 坏 due / 午夜与 DST 边界），逐条给原因与诊断 | `dailyPlanPolicy.test.mjs`（17 条表驱动 + 排序 + 建议投入 + 日界）、`capacity.test.mjs` | ✅ 实测通过 |
| AX-C02 31 条稳定排序后列 30，提示词与 UI 均写"另有 1 条"；账本/手动池不截断 | `dailyPlanPolicy.test.mjs`（3 条）、`capacityWiring.test.mjs`（扫描：截断只有一处、两处 UI 都用 `truncated`） | ✅ 纯函数与接线通过；**UI 文案的真实渲染归 T6** |
| AX-C03 无计划 0 但未排入可见；90+60=150 一致；已结束/任务 done 不自动减；删 60 后剩 90 | `capacity.test.mjs`（6 条） | ✅ 实测通过 |
| AX-C04 未来截止/归档/取消/删除均以持久 minutes 计容量并标状态；坏 JSON 不可计算；改默认估时不改已有快照 | `capacity.test.mjs`（6 条） | ✅ 实测通过 |
| AX-C05 一键排入走 POST 原子追加并即时重读；保留原排序/备注/结束状态与已有缺失项；父子冲突明确提示、无部分生效；无计划可创建；重复 taskId added=false；**并发两项均存在** | `dailyEffort.test.mjs`（4 条含 `Promise.all` 并发）、`routes.test.mjs` | ✅ 实测通过（B 层点击归 T6） |
| AX-C06 AI 排序 / PlanPanel 手动池 / 未排入区共用 `dailyPlanPolicy`；includeOverdue 只影响候选、容量数不变；规则文案吻合 | `capacityWiring.test.mjs`（11 条扫描 + 行为）、`capacityPanel.test.mjs`、`dailyEffort.test.mjs`（"开关不许改变已排"） | ✅ 实测通过（真实渲染的文案由 `capacityPanel.test.mjs` 用 `react-dom/server` 断言） |
| AX-G02 三处候选共用唯一纯函数，不重新内联旧 filter | `capacityWiring.test.mjs` + 上面第 4.2 节的变异 | ✅ 实测通过（变异变红已演示） |

## 6. 明确**未验证** / 未做（不得当已过）

1. **浏览器 B 层全部未做**：本会话没装盘、没重启 19387、没开浏览器。因此
   AX-D07 / AX-D08 的**真实点击**、计划行"今日投入结束"按钮的**视觉布局**、
   `wb-plan-minutes` / `wb-effort-done` / `wb-plan-progress-hint` 的实际观感
   **都没有人眼确认**（样式只做了兜底：`flex:none` + 固定宽度，避免把标题挤没）。
2. `POST /plans/:date/items` 与 `PATCH /plans/:date/items/:taskId` 是**新端点**：
   真机上要等插件升级 + 重启才存在；旧服务端下界面走旧的 PUT 路径（代码仍保留）。
3. `scripts/repro/` 下 3 个容量脚本（`compare-capacity-before-after.mjs`、
   `harness-real-browser.mjs`、`verify-capacity-fixed-dataset.mjs`）针对**旧口径**，
   已在文件头标注 **⚠️ 已过时**（保留文件、不删，但不得当现役证据）。
4. `test/db.test.mjs` 的 1 个清理期失败（§4.1）——**与本次改动无关，改动前就有**。
5. 未装盘、未重启 19387、未动正式 DB（迁移与计划读写只在 `:memory:` 库与 HTTP 测试里验证）。
6. 未改公开版本号、未 `git commit`、未公开发布。

## 7. 改动文件清单（`git status --short` 实测）

**修改**：`src/api/routes.ts`、`src/api/routes/plans.ts`、`src/client/capacity.ts`、
`src/client/components/CapacityRulePanel.tsx`、`src/client/components/PlanPanel.tsx`、
`src/client/index.tsx`、`src/client/styles.ts`、`src/client/viewTypes.ts`、
`src/db/repo.ts`、`src/db/repo/plans.ts`、`src/shared/dailyPlanPolicy.ts`、`src/tools.ts`、
`tsconfig.build.json`、`test/capacity.test.mjs`、`test/capacityPanel.test.mjs`、
`test/capacityWiring.test.mjs`、`test/db.test.mjs`、`test/fixtures/capacityFixture.mjs`、
`test/progressDb.test.mjs`、`test/routes.test.mjs`、`test/tools.test.mjs`，
以及 `scripts/repro/` 3 个过时脚本的**文件头标注**。

**新增**：`src/client/dailyPlanPrompt.ts`、`test/dailyPlanPolicy.test.mjs`、
`test/dailyEffort.test.mjs`、本文件。

**未提交**（按共同执行契约：用户未要求提交代码）。

## 8. 给 T3–T6 的输入

- **迁移号已用掉 19，T2 没再开迁移**；后续子任务同样不得再开（需要改计划表结构先问父任务）。
- 计划项的**唯一读写入口**是 `db/repo/plans.ts` 的 `updateDailyPlan` / `addDailyPlanItem` /
  `updateDailyPlanItem` / `confirmDailyPlanDraft`。**不要**在路由或工具里直接拼 `items_json`。
- 候选/容量/上限的**唯一实现**在 `shared/dailyPlanPolicy.ts`：`planCandidates`、
  `computeCapacityLedger`、`selectPromptCandidates`、`checkPlanMinutes`、
  `parsePlanItems`、`checkPlanTaskSet`。要加"另一处候选"的冲动，先读 `capacityWiring.test.mjs`。
- 客户端容量入口 `client/capacity.ts` 是**薄接线**（只折形状 + 算本地日界），
  真正的算法在共享模块；`computeTodayCapacity` 的入参多了 `plan`，测试夹具换成了
  计划驱动版本（`test/fixtures/capacityFixture.mjs`）。
- `MIN_ESTIMATE_MINUTES` 已由 5 改回 **1**（与服务端 `clampEstimateForStorage` 对齐，
  由 `routes.test.mjs` 的跨模块等价性断言守护）。
- **T4** 的角色选择器若要显示"要不要画进度"，继续复用 `client/taskProgressView.ts`；
  **不要**在组件里内联 `statusCode === 'done'`。
- **T6** 的浏览器套件需要覆盖：计划行"今日投入结束/继续投入"、投入分钟就地编辑、
  "完成任务"与"推迟截止一天"文案、未排入区"排入今日"按钮、容量"不可计算"提示与
  31 条截断提示。判据里请用**真实鼠标事件 + 接口重读**，不要 `el.click()`。
