# 工作台插件优化：开发规格

任务：`36c8e8ef-1104-4e68-b55f-a2a6cc533ab9`。修订：2026-09-30。

本文件规定目标行为，不表示功能已经实现。2026-09-30 用户明确选择：**区分“今日投入结束”和“任务完成”并进入本轮**。其他新增细则为本次补齐的工程默认值；开发者按本文实施，不自行扩大功能。改变这些契约时先改文档并请求用户确认，不把开发时的新假设直接写成代码。

## 0. 开发入口与权威源

1. 先读根目录 `CONTEXT.md`，再读 ADR 0002–0007、本文、`plan.md`、`acceptance.md`。
2. ADR 记录产品取舍；本文记录字段、流程、边界；`plan.md` 记录顺序；`acceptance.md` 记录测试判据。任务描述只是入口，不复制全部字段细则。
3. 发现冲突时停止对应片段并报告具体冲突，不凭“最新行号”猜语义。此次补齐替代旧描述的“夹取与耗时同规格”“计划项完成=任务完成”“子任务全完成后再提示父任务”等口径。
4. 本轮仅编写文档；后续开发前读取 `.dsh/skills/dsh-plugin-change/SKILL.md` 及其 architecture/delivery 约束；装盘与重启前加载 `dsh-safe-plugin-ops`，公开发布前加载 `dsh-release`。
5. 先前规格补齐阶段只写文档；后续拆分提案已由用户确认创建六个execute子任务，执行分组与ID见[subtasks.md](subtasks.md)。父任务状态/AI策略/截止未改，尚未执行子任务或提交完成验收、安装插件/重启当前实例。

## 1. 范围

### 1.1 本轮交付

- 批次 1：S1–S13、P1-1；涵盖任务显式进度、每日计划投入/独立结束状态、候选池和容量、角色库与选择器。
- 批次 1.5：S15–S18、S17-N（新增功能回归）。必须支持确定性验收和安全隔离。
- 允许局部 UI：任务列表/详情、计划面板、容量账本、角色选择器；不做日期面板结构收敛，不做整个 `WorkbenchApp` 拆分。
- S5-E/S6-E 为用户此次确认增加的计划项结束状态及交互，是 S5/S6 的子片段，不另开独立产品。

### 1.2 不进本轮

S14 与原需求 #1/#2/#3/#4 的入口改造/版本复核/模型复测属于批次 2。任务拖拽、导入导出属于批次 3；定时自动化、多端同步另立项。父任务自动完成/级联/repair 的行为保持不变。

角色本轮只做三级本地来源、显式选择、收藏、内置六篇、工具与绑定。保留 provider 接口但不接 agency 的实际服务、不加第三方必需依赖、不做“复制为我的角色”按钮、不做会话中切换人格/自动匹配人格、不导入另一台机器资产。以上作为后续能力，不能让 S10–S13 偷偷扩成角色管理平台。

## 2. 数据与状态所有权

| 语义 | 唯一权威源 | 写入者 | 禁止联动 |
|---|---|---|---|
| 任务完成/取消 | `tasks.status_code` 与现有 `db/repo/status.ts` | 用户操作/验收确认/既有级联 | AI 进度不能直接写 done/cancelled |
| 任务进度 | `tasks.progress_percent` | 人或进度工具 | 子任务比例、投入分钟、计划项结束均不自动累加 |
| 某天计划投入 | `daily_plans.items_json[].minutes` | 确认草稿/用户编辑 | 不改任务预计耗时、截止时间 |
| 某天投入是否结束 | `daily_plans.items_json[].effortDone` | 用户独立结束/撤销动作 | 不完成任务、不涨进度、不推进截止时间 |
| 当日候选 | `src/shared/dailyPlanPolicy.ts` 的纯函数输出 | 无（派生） | 组件不得内联第二份过滤公式 |
| 已排容量 | 当天持久化计划项 minutes 之和 | 无（派生） | 不随任务关闭或 effortDone 自动减去 |
| 待验收 | 最新 completion 草稿的 pending/deferred 状态 | 现有验收路径 | 不新造任务 status code |
| 角色绑定 | `ai_session_registry`，`scope_code='persona'`、`anchor=sessionId` | 角色绑定路由 | 不放到任务描述、不混写 task_sessions.note |

### 2.1 迁移

当前源码 schema=18；新增一个前向迁移 19，不改旧迁移。若开工时已有其他迁移占用 19，顺延编号并同步所有文档/测试，不覆盖已有工作。

迁移 19：

- 加 `tasks.progress_percent INTEGER NOT NULL DEFAULT 0 CHECK(progress_percent BETWEEN 0 AND 99)`；旧任务（包括 done）一律置 0，不从状态/子任务反推。
- 加字典 `ai_session_scope/persona`，用于复用现有 `ai_session_registry` 的会话级绑定；**现有实际表名不是 ai_sessions**。不新增角色正文表。
- 对已有计划 JSON 做一次兼容回填：合法旧项缺 minutes 时，以迁移当时任务合法预计耗时或设置默认耗时填入；缺 effortDone 填 false。保留现有字段和原顺序；缺失任务用默认耗时，保留标题与 taskId。
- 已有合法 minutes/effortDone 不覆盖。坏 JSON/非数组/坏项不猜测、不删除，保留原串并输出带 planDate 的诊断；读取这些计划时返回明确“计划数据无法解析”诊断，容量显示不可计算而非伪装 0。
- 新字段 JSON 回填不需要新增计划表列；这是迁移 19 的数据兼容部分，不再另开一个 DDL 迁移。
- 二次 migrate 无数据变动；失败事务回滚。迁移测试只用内存库/数据库副本；不拿当前用户真库试迁移。

## 3. R-P：任务进度

### 3.1 字段与校验

API/共享 DTO 字段名 `progressPercent: number`。创建默认 0，读取包含该字段，遗漏字段的旧客户端仍可操作。只接受有限整数 0–99；不接受字符串、null、布尔、小数、负数、NaN/Infinity，也不把超界值静默夹成 99。数据库 CHECK 是最后一道防线，路由/工具提前返回中文错误。

这与 estimatedMinutes 的校验只是“有限整数”思路相同，**不是同一函数/范围/回退行为**。不采用旧描述的“与 clampEstimatedMinutes 同规格”。

新增工具 `workbench_update_progress(task_id, progress, note?, summary?, feedback?)`：

| 条件 | 行为 |
|---|---|
| 任务不存在 | 中文错误，无写入 |
| 已归档/done/cancelled | 拒绝更新，不重开任务、不提交草稿 |
| progress 为 0–99 | 更新显式值，追加现有 updated 事件（before/after、actor=ai、可选 note）；状态不变；回执包含最终值 |
| 同值重复提交 | 成功返回当前值；不重复写 updated 事件、不刷新 updatedAt |
| progress=100 | **先分流、后校验存储**：调用同一 completion 领域函数；不写 progressPercent（连 99 都不代写） |
| progress=100 且 aiPolicyCode 非 execute | 按现有验收策略拒绝；不自动改策略 |
| progress=100 无非空 summary | 中文错误，要求 2–4 句完成总结；feedback 的要求/历史提示复用现有路径 |
| 其他值 | 中文错误，列出可写 0–99 与 100 的特殊语义；无部分写入 |

原 `workbench_request_completion` 保持兼容：新工具与它共享一处“提交/更新 completion 草稿、历史提示、暂存处理”的领域函数，不让 tools 调 tools，也不新增第二套验收实现。旧工具 summary 可选行为不扩大变更；新工具的 100 分支要求 summary。

用户 HTTP：`PATCH /api/workbench/tasks/:id` 新增 progressPercent（0–99），采用同一校验。100 在普通 PATCH 中拒绝；界面选择 100 时显式调用现有完成任务动作，展示与当前完成操作同等的级联确认提示。不写库内 100。多个字段 PATCH 在校验完成后原子应用；非法进度时其他字段也不得生效。

### 3.2 UI 与提示词

- 输入：五档 0/25/50/75/100 + 整数输入 0–99；100 标注“完成任务”，非一个普通保存值。
- 列表/详情/计划行：仅未归档且非 done/cancelled 的任务显示进度；done 显示已完成，cancelled 显示已取消。子任务旁证 `x/y` 以**直接子任务**为口径，x 只数 done，y 包含 cancelled 并额外显示取消数；不把 cancelled 当作“工作已完成”。不调整既有状态聚合的 closed 口径。
- 待验收来源：completion 草稿 status=pending；deferredAt 非空仍显示待验收（暂存）；驳回后不显示待验收。通过验收后 task=done，完成显示优先。
- 不能对每个任务逐行发请求查草稿。列表刷新共用一次 pending completion 查询/聚合；将读数投影到任务视图；不在 GET tasks 内修改任务。
- 驳回/暂存不自动回退进度，重新打开 done 任务保持原显式值。缺少待验收投影的旧服务端不推测草稿、不假显示徽标。
- 执行提示词新增“阶段性推进后主动调用 workbench_update_progress；工作完成后提交验收；100 不是直接完成”。咨询/拆解/排序模式不得被该提示诱导执行任务。
- **父任务例外**：用户完成/验收子任务后，现有状态聚合可能完成父任务；保持此行为，不新增“全部完成后再询问父任务”的不可达提示。进度仍不联动，done 父任务不画进度条。祖先/后代的级联完成也不改它们的进度。

## 4. R-D：每日计划的完整生命周期

### 4.1 形状

持久化项保留 `taskId/order/title/note`，增加 `minutes: number`、`effortDone: boolean`。没有实际工时、没有自动进度分摊，也不引入计时器。

- minutes 是 1–1440 的有限整数；显式无效输入整份提案/编辑拒绝，报告 items[index] 与字段；不静默过滤/夹取。
- 新项省略 minutes：取任务合法 estimatedMinutes（按现有 1–1440 规则）否则 settings.defaultEstimateMinutes（默认30）；**提案创建时就保存快照**，确认时不随预计耗时变化。
- 对既有计划同 taskId：生成新草稿/手动编辑省略 minutes 时保留既有值；显式 minutes 才更改。结束状态始终以服务端最新计划项为准，AI 输入 effortDone 无效并报错，不能结束用户当天工作。
- 新项 effortDone=false；旧项在重新排序/备注修改/重复确认中保留已结束状态。删除项后重新添加视为新项，结束状态重置 false。
- 同一日期 taskId 唯一；同一父子链不能同时入计划（允许不同兄弟叶子）。工具、手动 API、草稿确认、仓储写入都调用共同校验。**未知任务只拒绝新增**；事务读到既有计划中的关闭/归档/缺失项允许原样保留，不准为了过滤而默默移除。缺失项只保留title/minutes/effortDone，不能操作任务/结束投入；删除后再添加算新增，按未知任务拒绝。
- 草稿只写 pending。确认时再次校验存在性、关闭状态与父子链；如新增任务已经关闭，整份拒绝并保留草稿供用户调整，不部分生效。

### 4.2 工具、路由与幂等

1. `workbench_propose_daily_plan.items` 增可选 minutes；兼容 task_id/taskId 的既有输入。回执和草稿预览展示每项投入及合计；描述明确 minutes 不是任务总耗时。
2. GET `/api/workbench/plans?date=YYYY-MM-DD` 返回新项形状与可选 diagnostics；新计划可无诊断。现有无计划仍 plan=null。
3. PUT `/api/workbench/plans/:date` 保留全量编辑接口，项可含 minutes；遗漏新字段的旧客户端按 taskId 合并服务端最新值，不能在保存备注时抹掉 minutes/effortDone。用户全量编辑仍需当前“覆盖 AI 计划”确认。items=[] 继续拒绝；清空使用已有 DELETE。
4. 新增 POST `/api/workbench/plans/:date/items`，body `{taskId,minutes?}`，作为一键排入唯一入口：事务读取最新计划，无计划时按manual创建；按最新末尾order追加，不覆盖任何已有成员、顺序、备注、minutes或effortDone。新增项取请求分钟或当前估时/默认并冻结，effortDone=false，sourceCode=manual。已存在同taskId则幂等返回当前计划，不修改已有分钟/结束状态（要修改用PATCH）；不存在任务404，关闭/归档/父子链冲突400，失败无部分写入。过去只读。成功 `{ok:true,plan,added:boolean}`。浏览器并发新增B/C最终均保留；不能以客户端旧列表PUT模拟追加。
5. 新增 PATCH `/api/workbench/plans/:date/items/:taskId`，body 可含 minutes 和/或 effortDone；至少一个字段，effortDone 必须布尔。只更新当前库里的目标项，不写回浏览器缓存的整个计划。不存在的计划/项=404，无效输入/历史日期=400；成功 `{ok:true,plan}`。保留 sourceCode 原值，结束不把 AI 计划改成 manual；修改分钟则 sourceCode=manual。
6. PATCH 今天/未来可写，过去只读；结束状态按钮只在今天显示，未来可编辑分钟但不允许 effortDone=true。历史只读不仅靠 UI 拦，服务端也拦。目标任务缺失/归档/关闭时PATCH拒绝并给中文原因；既有项只允许全量编辑时保留或显式移除，不再结束/调分钟。
7. PUT、PATCH、POST追加、确认均在仓储事务内读最新值、校验后写入；相同结束状态/分钟重复提交不写事件/updatedAt。异步完成后才更新界面；失败保留旧显示并给中文错误。
8. 重新生成/确认是全量替换成员的用户决策；预览必须展示移除项，尤其已结束项，确认后才移除。保留项的 effortDone 在确认事务中读最新值，不用过时草稿覆盖。草稿确认继续走 withDraftConfirm，重复确认不重复应用旧计划。
9. **跨日**：计划项结束只影响那一天；同任务明天再次排入，新项=false，minutes 按明天的建议/默认。本轮不增加“把计划项搬到明天”的功能；原“明天”动作明确改名“推迟截止一天”，保持它改 dueAt 的既有语义、不转移计划项。

### 4.3 UI 状态机（用户此次确认）

- 任务未关闭、今日项 effortDone=false：主动作“今日投入结束”；次动作“完成任务”（明确整个任务）和“推迟截止一天”。
- 点“今日投入结束”只 PATCH effortDone=true；显示“今日投入已结束”，主动作变“继续投入”（PATCH false）。task.statusCode、progressPercent、dueAt、estimatedMinutes 均不变。
- 结束后且进度=0，显示非自动的提示“顺便更新任务进度？”及 25/50/75 三个显式选择；不给按分钟比例算的 X，也不默认勾选。选择后独立 PATCH 进度；进度写失败不撤销此前已成功结束的项。
- task=done/cancelled/archived/已删除：保留计划行与 minutes 快照，显示对应状态；不提供完成/进度/投入操作。重新打开 task 不自动重置该日 effortDone。
- 今日计划卡 footer 同时展示已排投入、已结束投入、未结束投入；后两项按 effortDone 分组，不声称是实际工时。task关闭但 effortDone=false 的投入仍是计划记录，另标任务状态，不替用户结束该项。

## 5. R-C：候选池与容量

### 5.1 共用候选函数

新增纯模块 `src/shared/dailyPlanPolicy.ts`（零 React/DOM/Node I/O）。输入为全量 tasks、完整 plan、目标本地日 D、includeOverdue；日期范围显式传入本地日起止 epoch，便于午夜/DST测试；服务端和客户端均调用同一模块。

候选 = open 且满足任一条件：

- effectiveDueAt 落在 D 的本地日；
- statusCode 为 doing/blocked（包括截止在未来的长任务）；
- 已在 D 计划中；
- effectiveDueAt 早于 D 且 includeOverdue=true。

open = 未归档且状态非 done/cancelled。截止脏值给诊断；若因 doing/blocked/已排而入候选仍保留并标记异常，不能当作“无截止”。父链已取消但子任务仍 open：保留子任务并标记继承来源，不擅改继承规则。

现有 dailyCapacityIncludeOverdue 存储键保留，UI 文案改为“显示逾期待办候选”：只扩充逾期且不在推进/不在计划中的候选，**不改变已排容量**。doing/blocked 与显式计划项不被开关隐藏。默认 false，GET/POST settings 同步说明。

AI排序、手动“添加任务”、容量未排入区都消费这个函数返回的同一全集，不各自重复 filter。未进入候选的未来 todo 不自动加入；用户先将任务显式设为 doing 或在其他既有有效入口排入计划，不由 AI 改状态。

候选排序稳定：p0/p1/p2/p3（未知按p3）→有效截止时间升序（无/坏值最后）→createdAt升序→id词典序。已排/未排标识、每条进度及直接子任务旁证一并提供。

AI提示词最多列30条（完整候选先排序后截取）；总数31时同时在提示词和发起窗口显示“另有1条未列出，当前仅为已列候选排序”。UI手动候选与账本不截断。不给用户“全量排序”假印象，不把未列条目说成无任务。

### 5.2 容量账本

- 已排 = **该日所有有效计划项 minutes 快照之和**，包括 effortDone、done/cancelled/archived/缺失任务的历史投入；非计划项永不自动计入。用户移除该日项/删除计划才改变这部分总额。
- 无计划：已排=0，未排入候选可见；不回退到到期任务求和。
- 未排入 = 候选集合减去计划taskId；每项用于展示的建议投入来自当前估时/默认，不与已排混算，明确标注“建议投入”而非已有投入。计数及合计必须对应完整可见集合。
- 可投入=现有设置，余=max(0,可投入−已排)，超支=已排>可投入。优先级分组只用于展示；合计严格等于账本项和，不重复算父子。
- “一键排入”：每条未排入行先显示可改的计划投入，确认后由计划API追加；保留已有顺序/备注/结束状态；若父/子冲突明确报错，不替换已有项。添加后立即重读计划和账本。
- 计划 JSON 无法解析时：容量显示“不可计算”及原因；不把错误当无计划，不覆盖原数据，用户可备份后修复或显式清空。未知taskId保留title/minutes并标“任务不存在”。
- 提醒、逾期判定、日历到期展示不改；S14 的日期树合并留批次2，本轮不让容量改造悄悄改树口径。

## 6. R-R：角色库、选择与加载

### 6.1 来源、ID与发现

内置 `assets/personas/`；用户库 `~/.dsh/workbench/personas/`；一个可配置外部根目录（默认空），如 公司内部角色库/personas。本轮无agency来源。

ID为角色文件相对于所属根的路径（去 `.md`、分隔符统一 `/`、Unicode NFC、不强制改大小写）。同逻辑路径覆盖顺序 **用户 > 外部 > 内置**。同显示名称但不同相对路径是不同角色，UI列分组/来源，不凭显示名称合并。sourceKey取 `builtin`、`user:<规范根realpath哈希>`、`external:<规范根realpath哈希>`；Windows根规范比较大小写不敏感。绑定记sourceKey，外部根配置改变或同名覆盖不自动换掉旧会话角色；旧源不可达按源丢失报错。

递归最多4层目录（根=0），排除README.md（大小写不敏感）、隐藏目录、资源同名目录中的附件及所有符号链接/junction；最多1000个角色文档，超限报告诊断，不声称读完。根目录不存在/无权限只禁用该来源，保留其他来源；不自动创建外部目录。不更改 公司内部角色库 文件。

公司内部角色库实际文件在 rf/ 与 dotnet/ 子目录，不能只扫根目录；现有9篇应原样可读，测试数据需去私人内容、使用合成fixture，真实9篇兼容性验证只在本机只读运行并单独留证。

### 6.2 文档解析

UTF-8，去BOM，CRLF归一LF；读取前上限256KiB。必须有 `# 名称` 一级标题，空名称/无正文禁用并诊断。首个标题后连续元信息 blockquote 可以隔空行，支持既有“分类 `engineering`”“工作模式：**只读**”“建议 emoji”“建议简介”及下一行简介；正文为元信息及可选分隔线之后的内容。

可选 frontmatter 只支持顶层标量 name/description/group/mode/emoji（字符串），以这些字段优先；不声称支持完整YAML语法，不解析嵌套/执行标签/链接对象。出现不支持结构时禁用该文档并给格式原因，不猜测。简介最长160（超长只在摘要明确省略并标 truncated，不截正文）；分组缺省取目录一级或“其他”。正文 `.length`（JS UTF-16 code units、归一换行后）1–20000，超限禁用，不静默裁正文。

本轮精确定义6篇内置工作方式型：实现者、只读审查者、反向验证者、调研者、方案设计者、测试工程师。自行撰写通用内容，不复制公司领域专家或不明许可上游。角色文本不能覆盖任务策略、安全规范或用户指令。

### 6.3 设置与UI/HTTP

settings 新增 personaExternalDir（字符串默认空）、personaFavorites（ID数组默认[]，去重）、personaDisabledIds（ID数组默认[]）；读写共用一处，GET/POST形状一致。内置/用户/外部合法角色默认启用，常用区取启用且收藏的；尚无收藏时展示6篇内置；“更多角色”提供全量启用角色分组搜索，并允许收藏/取消与启用/禁用。不做角色正文编辑。

新增loopback-only路由：

- GET `/api/workbench/personas` → `{ok:true,personas:[{id,name,description,group,mode,emoji,source,enabled,favorite,revision}],diagnostics:[]}`；不回正文/绝对路径。
- GET `/api/workbench/personas/bind?session_id=...` → `{ok:true,binding:null|{personaId,sourceKey,revision}}`。
- POST `/api/workbench/personas/bind` body `{sessionId,personaId}`，**在首次发prompt前**解析校验后绑定；未选角色不写绑定。无角色/非法文档400，已有同绑定幂等，已有不同绑定409（新建会话才能换）。路由不接受用户随意传绝对资源路径。

现有mode全部覆盖：clarify/consult/breakdown/execute/review/plan/report/idea_association/idea_brainstorm/knowledge_doc。选择器使用独立 PersonaPicker 组件；快速录入和共享提示词弹窗同一选择逻辑，与技能选择器并列。默认“无角色”，不能默认启用某个专家影响旧行为。

复用：打开已有会话沿用原角色。发起新生成时如果用户选择不同角色，创建新会话并显式告知，不改旧会话；将新会话按原scope+anchor注册替换入口指针。未显式选角色时沿用复用会话原绑定；明确“无角色”与原角色不同也须新会话。不能在 reuseAiSessionId 提前返回时忽略用户选择。宿主已归档/删除会话保持原 aiSessionUsable 回退逻辑。

### 6.4 绑定、工具与资源

复用ai_session_registry：scope=persona、anchor=sessionId、session_id=sessionId；note保存版本化JSON `{version:1,personaId,sourceKey,relativePath,revision}`（内容哈希 SHA-256），不保存正文/资源、不会随同名优先级变化自动改源。S1统一预留字典迁移后，S11无需第二次迁移。

工具 `workbench_load_persona()` 无session_id/任意角色入参；只从执行上下文真实sessionId查绑定，返回角色名称、正文、revision、资源相对清单和限制。缺session/未绑定/源不可用/正文超限/文件revision不符给不同中文错误。绑定时不自动复制正文；加载时文件变更则明确拒绝旧版本，提示用户新建会话重新选择，不悄悄读新文件。重复读取同一revision幂等。

前置提示块仅包含已选角色ID和“在处理本任务前先调用 workbench_load_persona；按正文引用的skill用skill工具加载；加载失败先报告原因，不声称角色已生效”。放在技能加载指令之前，不内联正文。无角色时最终提示词逐字等于原流程。只能保证明确加载指令和工具可用，不能声称模型一定服从；浏览器判据要观察实际工具调用和角色内容，而非只看到下拉选中。

资源位于与文档同目录的同名文件夹，例如 rf/rf-天线测量专家.md → rf/rf-天线测量专家/。`workbench_read_persona_resource(path)` 只接受该根内相对路径，路径命名相对于同名文件夹；resources/用于跨项目模板。不执行附件脚本。

- 允许 UTF-8 `.md/.txt/.json/.yaml/.yml/.csv/.ts/.js/.mjs/.py/.ps1` 文本，单件<=128KiB且解码后<=20000字符；二进制、NUL/非法UTF-8、超限明确拒绝。
- 最多递归4层、200个资源；超限清单诊断，不静默漏项。
- 拒绝绝对/盘符/UNC、`..`、NUL、编码绕过、符号链接/junction；resolve+realpath 后校验仍位于资源根内。即使是在根内的链接也拒绝；测试覆盖Windows大小写/盘符与POSIX路径。
- 每次读工具先校验当前会话绑定及角色revision；资源不存在404语义的中文错误，不能回退到用户机器其他路径。工具输出不给当前根外文件。会话ID由exec获取，AI不能加载另一个会话角色。

## 7. R-V：研发验收链

### 7.1 环境与授权

默认目标 `http://127.0.0.1:3080`、profile=web；当前会话19387/desktop永不重启。本文是后续实现的规格，**不是本轮实际重启授权**；若当前运维规范要求人工确认，以规范为准。

必须先预检再构建/装盘：

- 当前 DSH_WEB_URL/DSH_PROFILE/DSH_PROFILE_DIR 存在且合法；DSH_WEB_URL只解析HTTP(S)本机地址。同端口、同profile物理目录（包括链接指向）、同数据库物理文件均直接拒绝，--force不可绕过。
- 名称相同但目录/实例/数据库确实不同，仍要求--force且输出原因；原ADR中的同profile确认不等于允许写当前profile。
- **默认DB跨profile共用**：`src/db/database.ts` 默认 `~/.dsh/workbench/workbench.db`。目标测试profile必须显式配置独立 dbPath/dataDir；不能仅改端口。读取目标实际配置与当前实际配置，无法证明独立就拒绝；--db-path用于声明并校验，不能仅凭参数当证据。正常dev-verify不自动改Cordis配置；首次隔离配置走人工确认的safe-plugin-ops。
- 目标profile目录必须显式、规范化、可核对；子进程清理/重设 DSH_PROFILE、DSH_PROFILE_DIR、WORKBENCH_PROFILE_DIR、数据库相关配置，防止 dev-install.mjs 优先继承当前desktop路径。check-installed-version的WORKBENCH_PROFILE_DIR与装盘目标必须一致。
- 非3080/web目标不在既有测试实例授权范围；本轮默认拒绝，不能--force扩权。仅访问loopback，禁止远程URL。

### 7.2 链、阶段与失败

目标命令（S16实现后才存在）：`node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web --profile-dir <测试profile绝对目录> --db-path <独立测试DB绝对路径>`。

默认阶段：预检→基线/版本检查→构建→打包装盘→零增量diff与dump-config→只重启目标→HTTP health检查→获取测试登录token→运行白名单套件→证据包→清理浏览器。`--dry-run`只做只读预检并打印阶段计划，不构建/装盘/启动浏览器/重启/写DB。

- 使用现有dev-install备份、包检查、冻结tgz与profile diff；装前/后版本检查必须为0。不顺手更新其他依赖，不改公开版本号。
- 端口进程归属与命令行必须匹配目标dsh实例；不杀整组node，不按旧PID杀，不启动替代GUI。launcher路径需要发现或`--launcher`显式覆盖；缺失则失败，不在其他profile重试。
- 构建标识契约：一次构建生成同一 `buildId`（源码/构建内容hash，不用公开版本号充当构建戳），写入随包的 `lib/build-info.json` 并在client编译时内联。GET health返回buildId，工作台**自建根节点**渲染 `data-workbench-build-id`（读取已加载client内联值，不照抄health值）。验收前同时比对目标包manifest、host health与浏览器根属性三者，缺失/不一致失败；不写宿主html未知属性。生产包同样需buildId，可只作为诊断、不加可见文案。
- 等待health最大120s、每次HTTP最大5s；健康需ok且版本/schema/buildId与本次包匹配。只200但旧构建不是成功；client根标识亦须与包构建一致。
- token只从此次启动的目标日志获取（默认TEMP/dsh-server-3080.log），读取范围从此次启动位置开始；60s未得到则失败。只在内存使用/子进程传递，日志/stdout/URL/截图/summary中脱敏；不要求用户贴token。
- Node >=24（fetch/WebSocket）；浏览器路径DSH_VERIFY_BROWSER优先，不可执行则报错，不静默忽略；其次发现Edge/Chrome平台标准路径。无浏览器失败并列已探测路径。
- 独立user-data-dir、独立CDP端口；单次CDP30s，单套件180s；finally只关闭本次浏览器/本次临时目录，不关闭用户浏览器，不在finally写exit0吞掉异常。
- 退出码0=所有必需阶段/套件通过；1=构建/装盘/health/测试断言失败；2=配置/自锁拒绝/前置资源缺失；3=等待超时。summary标明实际阶段、缺失/失败原因及副作用是否发生。不能因缺套件、认证失败、空测试计数而绿。
- 失败停止后续危险步骤，保存已脱敏证据；不自动降级数据库、回滚schema或重启当前实例。若测试实例已重启，报告保留状态与人工处理建议，不偷偷复原未知旧包。

### 7.3 现役与新增判据

P1-1生成显式现役套件清单与失效清单（按判据语义核实，不凭22关键词命中直接作废）；保留旧脚本、不删，将弃用警告头或_deprecated归档与排除执行关联起来。

S17迁移4套历史套件：acceptance/final-2/sidebar-collapse/duplicate-task；17/9/6/11是历史计数，不是此次实测。逐项判据已只读提取为[legacy-regression.md](legacy-regression.md)的43个LEG编号。优先读取本机原脚本迁移；缺原脚本时只能明确标为“依据版本化判据重建”，不能声称逐字迁移，不能只凭名称/计数发明断言；缺任何判据输入时阻塞对应套件并请用户补资料，不能跳过报绿。

S17-N必须新增progress/daily-effort/persona/verify-safety套件，覆盖本文新行为；原套件仅作为回归。所有写入场景使用可销毁测试DB和带runId的合成任务，禁止对正式任务进行测试。每套件有非零用例计数和明确失败退出。

证据放gitignored `test-results/workbench-verify/<runId>/`，summary.json+summary.md+截图+脱敏stdout/stderr。JSON至少记录runId、构建标识、目标profile/端口、DB独立检查结论、阶段耗时/exitCode、套件passed/failed/skipped（必需skipped意味着不通过）和证据相对路径；不放完整秘密配置/未脱敏运行日志。真实浏览器点击+重读DOM/接口/截图，不能只el.click或只截图。

## 8. 批次2 规格（2026-10-01 用户拍板）

> §1–§7 是批次 1/1.5 的规格（**已实现并随 v1.16.0 发布**，实证见 `T6b-ui-fixes-handover.md`）。
> 本节是批次 2 的规格，由用户 2026-10-01 的三条拍板驱动：
> ① 范围＝**先零风险小项 → 补规格 → 再做 #2 与 S14**；② S14 树口径＝
> **「当日到期 ∪ 当日计划项 ∪ 进行中」并逐条标来源**；③ **先把测试实例宿主对齐到 DSH 0.2.0-rc.2**。
> 新增判据沿用 acceptance.md 的编号风格，本批次用 `AX-T`（日期面板）/`AX-W`（工作区）/`AX-H`（宿主声明）前缀。

### 8.1 范围与顺序

| 阶段 | 内容 | 状态 |
|---|---|---|
| A 零风险小项 | #1 版本声明常量、README 术语、P3-3 脆断言 | ✅ 已完成（2026-10-01） |
| 0 环境 | 测试实例宿主对齐到 0.2.0-rc.2 | ✅ 已完成（2026-10-01，三层验收全过，见 8.6） |
| B 规格 | 本节 + ADR0001 口径冻结 + acceptance 新判据 + plan 片段 | 本节 |
| C 实施 | #2 工作区双模式 → S14 日期面板收敛 → WorkbenchApp 拆分 | 未开始 |
| D 不修 | #3 模型选择失效（宿主侧缺陷）→ 复现记录 + 上报决策 | 见 8.5 |

### 8.2 S14 日期面板收敛（ADR0001）

**目标行为**（权威源＝ADR0001 的「口径冻结」一节）：
- 任务树 = **当日到期 ∪ 当日计划项 ∪ 进行中**；行上标出**全部**命中来源；只收 open 任务；
  `cancelled` 不进树、`done` 走「已完成」页签。
- 「今日」= 该面板的 **today 实例** + 统计卡 + 容量条；「日历」= 周/月容器，选中某天进**同一个**面板，
  页签仍是 计划 / 已完成 / 报告（原需求 #5「今日要不要一个已完成页签」由此自动获得）。
- 今日页**不再列出全部未完成任务** —— 可见集合变窄，是刻意变更，要写进发布说明。

**唯一实现**：三个来源的判定收进 `src/shared/dailyPlanPolicy.ts` 的**同一个纯函数**，
候选池 `planCandidates()` 与面板树**都从它派生**；组件里禁止再 filter 一遍（判据 AX-T02）。

**不改**：容量口径（ADR0002）、进度口径（ADR0003/0004）、计划项结束状态（ADR0007）、
提醒与日历到期展示的既有语义、父任务自动完成/级联/repair。

**组件边界**（先立边界再搬代码）：
- 新增 `src/client/components/DayPanel.tsx`：承载三页签 + 计划面板 + 任务树 + 报告，props 显式；
- 来源判定与行标签是**纯函数**（进 `src/shared/`，可被 `node --test` 直接测）；
- `src/client/index.tsx` 只保留"选中的是哪一天 + 这一天显示什么"的装配，两个入口都指向它。
- **出口判据**：`index.tsx` 行数必须比改动前**变小**（数值写进提交信息，**不写死进文档**）。

**WorkbenchApp 拆分必须排在 S14 之后**（ADR0001 Consequences）。施工图
`docs/design/2026-09-09-client-split-backlog.md` **已过时**（写 1958 行 + 行号地图、WSL 构建、
已不存在的 `D:\DSHWorkspace\_probe\route-regress.mjs`；现状 5631 行、Windows 原生构建），
实施前必须先按现状重写该文件，不许照抄行号地图。

**未决**：逾期任务是否作为第 4 个来源（见 ADR0001 的 ⚠️ 条）——不在本片段内顺手做。

### 8.3 #2 工作区双模式

**目标行为**：新建任务页与快速录入页的「AI 会话工作区」都支持两种模式 ——
① **已有工作区下拉**（真下拉，不是 datalist 提示）② **文件夹弹框浏览选择**。

- 已有工作区的数据源＝`workspaces.list.getSnapshot().items`（`{ workspaceId, path }`）——
  现有读取处是 `src/client/index.tsx#openWorkspacePaths`；下拉**不得**再算一份候选。
- 浏览的数据源＝复用 `GET /api/workbench/knowledge/list-local-dir`
  （`src/api/localDirRoute.ts`：loopback-only、目录+文件、盘符哨兵 `ROOTS_PARENT`、单目录 500 条上限）
  与 `src/client/components/LocalDocModal.tsx`。
- **复用要求**：`LocalDocModal` 目前只对**文件**给「选择」，目录只能「进入」——
  必须加"选择此文件夹"模式（`mode: 'file' | 'dir'`），**不是**复制第二份弹窗。
- 三个入口（快速录入 / 新建任务 / 编辑任务）共用同一份选择控件与判定；
  `quickWorkspaceDefault` 的默认值口径与「不再记住」出口行为**不变**。
- 值仍落到任务字段 `workspacePath`（空 = 走既有继承逻辑）；**不新增字段、不改接口契约**。

**失败路径**（不许静默吞）：目录不存在/不可读/不是目录 → 弹框内可读中文错误；
宿主 `workspaces` 服务缺失 → 下拉退化为空并说明原因，不抛异常。

### 8.4 #1 版本声明（阶段 A 已完成，类型源待办）

- **已完成**：`test/pluginEntry.test.mjs#NEWEST_HOST` 推到 `0.2.0-rc.2`（peer 区间
  `^0.1.5-rc.1 || ^0.2.0-rc.1` 已语义覆盖 rc.2，下界不动）。
- **待办（不是零风险，需独立验证）**：构建期类型源仍在 0.1.x 线
  （`devDependencies` 里 `@deepseek-ai/dsh-llm ^0.1.0-rc.6`、`@deepseek-ai/cordis ^4.0.1`），
  而运行宿主是 0.2.0-rc.2。对齐要付一次依赖升级 + 完整 typecheck/build/测试（判据 AX-H02）。
- **事实记录**：桌面端 19387 的宿主核心是 **0.2.0-rc.2**（app.asar 内
  `@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.2`，整套 `@deepseek-ai/dsh-*` 同版本）；
  全局 CLI 与测试实例仍是 **0.1.7-rc.2**（见 8.6）。
  ⚠️ 不要把 `upgrade-verify-rc2-canary-20260927` 当成 0.2.0 的证据：那个 "rc2" 指的是 **0.1.7-rc.2**
  （`cutover-0.1.7-rc.2-*.ps1` 里写死校验 `version -ne '0.1.7-rc.2'` 就抛错）。

### 8.5 #3 模型选择失效：不是本仓库的修复项

T6b 已判定为**宿主侧缺陷**（`dsh-client-ui-model-selection` 的 `static inject` 声明了
`remote.session`，而 `dsh-api-session-controller` 的 `dsh.client.inject` 没有任何地方 provide 它；
web profile 正常、桌面端应用内组合异常）。本批次只做三件事：
① 工作台侧不再反复弹红字、「跟随 DSH 默认模型」任何情况可点且真清残留（T6b 已做）；
② 在 `docs/issues/` 留一份带链路的复现记录供上报；③ 是否上报由用户决定。
**不改 `profiles/node_modules` 里的任何东西。**

### 8.6 测试实例宿主对齐（阶段 0）——✅ 已完成 2026-10-01

测试实例（`web` profile / 3080）原本由全局 CLI `@deepseek-ai/dsh@0.1.7-rc.2` 启动，
而用户实际宿主是 0.2.0-rc.2。**2026-10-01 已完成对齐**，实证：

- 全局 CLI 核心：`0.1.7-rc.2 → 0.2.0-rc.2`；旧核心停放在
  `%APPDATA%\npm\node_modules\@deepseek-ai\dsh.old-rc2align-20261001-2245`（回滚＝改回来 + 重启 3080）。
- 3080 实例：`dsh --profile web --port 3080`，health 200，插件 1.15.8 dev 构建 / verify-web.db schema 19 / 197 条。
- 三层验收：服务层 PASS / 接口层 PASS（带 token 首页 303 + health 200）/ **交互层 PASS（真实浏览器新建会话 → 真实发消息 → 模型回复命中）**，页面无 console error。
- 期间**未**动 19387（pid 37472 未变）、**未**迁移正式库（仍 schema 19 / 94 条）。

**为什么这次能过、第一次不能**：0.2.0-rc.2 的启动预检会 skip 声明只到 0.1.x 的插件
（当时是 `@michengai/dsh-skills-manager@1.1.4`、`@changfenhuang/dsh-genui@0.11.2`、`dshmarket@1.66.2`）。
用户把插件升到 `skills-manager@1.1.8` / `genui@0.11.3`，剩下的 `dshmarket@1.66.2` 由本次补到 **1.66.6**
（走门禁 A：备份 + 零增量 diff，只有 `dshmarket` 那一行变化）后，dump 门禁即通过。

**两个曾把失败误判成"宿主坏了"的假故障**（已在团队记忆沉淀）：
① 验收脚本默认读 `%TEMP%\dsh-server-<port>.log` 拿到**上一次启动的旧 token** → 第 2 层 401，
且失败后的清理会撞 libuv 断言崩成 `0xC0000409`；必须用 `--token-log <本次启动的 stdout 日志>`。
② 0.2.0-rc.2 首启会弹「预览版说明」，挡住自动化交互（表现为第 3 层干净退出 4、但页面无 console error）；
先点掉「继续」即恢复正常。

**共享面（仍然成立）**：`~/.dsh/profiles/node_modules/@deepseek-ai/*` 是指向全局 CLI 包树的符号链接农场，
切换后实测已自动指向 0.2.0-rc.2（`dsh` / `dsh-host-webserver` 均为 rc.2）；
桌面端自身核心在 asar 内不受影响，但其插件解析核心包会跟着走到 rc.2。
`cordis.patch.yml` 里 `patch: entry "dsh-pocket" not found` 是**切换前就存在**的噪音（web profile 未装 dsh-pocket），不阻断启动。


### 8.7 状态所有权（批次2 增补）

| 语义 | 唯一权威源 | 写入者 | 禁止联动 |
|---|---|---|---|
| 日期面板的任务树 | `src/shared/dailyPlanPolicy.ts` 的来源判定纯函数输出 | 无（派生） | 组件不得内联第二份过滤/来源公式 |
| 某日「当日计划项」 | 该日 `daily_plans.items` | 计划草稿确认 / 用户编辑 | 不因子任务或进度变化重算 |
| AI 会话工作区选择 | 任务字段 `workspacePath`（空＝继承） | 用户在三个入口选择 | 不新增字段、不写进计划/角色/进度 |
| 宿主兼容声明 | `package.json#peerDependencies` | 人工（发布节奏） | 不得因本地迭代抬高下界或写成 `*` |

## 9. 开发完成定义

具体判据见acceptance.md；至少 typecheck/build/完整node测试/安全预检负向测试/新增浏览器套件与旧回归均通过。每个关键禁止策略都做定向变异：暂时拆掉防护应变红，再恢复变绿；在临时副本操作，不损坏用户未提交文件。

用户确认本次文档不等于确认实现、验收通过或公开发布。开发完成后提交工作台完成验收申请，由用户实测确认；任务当前AI策略consult不由开发AI自行改成execute。若需在工作台执行路径提交验收，由用户先启用可执行；咨询会话不得假报工具成功。
