# 实施计划：工作台插件优化

任务 `36c8e8ef-1104-4e68-b55f-a2a6cc533ab9`；2026-09-30。**本文件是后续开发计划，不是已完成清单。** 所有目标行为以 [requirements.md](requirements.md) 为准，测试实例与运行环境未知时先只读核对，不能照抄历史PID/脚本计数。

工作台执行按[subtasks.md](subtasks.md)合并为六个一层子任务；本文件D/V片段是各子任务内部步骤，不逐项建任务。拆分提案已由用户确认，六项均已创建为execute；实现验收尚未完成。

## 1. 先做什么

1. 读 CONTEXT、ADR0002–0007、requirements、acceptance、项目级 dsh-plugin-change。
2. `git status --short`；识别既有未提交变更，不覆盖、不自动提交用户内容。
3. 核对实际 schema、pnpm/Node、测试入口、目标实例配置。当前基线源码 package=1.15.8/schema=18，不代表安装运行态版本。
4. 建立当前源码基线：`pnpm typecheck`、`pnpm test`。若已有失败，记录原始输出与最小复现，区分基线失败与本轮回归，不删测试求绿。
5. 先冻结 DTO 与纯函数输入输出，再逐个垂直片段推进。本文预计文件名单不是批量重写授权。

## 2. 依赖与并行边界

```
D01 共享校验契约 -> D02 迁移/仓储 -> D03 进度接口 -> D04 进度UI
                    |-> D05 计划持久化 -> D06 计划API -> D07 投入UI
D01 -> D08 候选纯函数 -------------------------------> D09 容量/排序接线
D10 角色纯解析 -> D11 角色发现/资源 -> D12 绑定/工具 -> D13 选择器
D02(字典persona) -------------------------------------> D12
V01 测试脚本卫生 -> V02 CDP -> V03 安全预检 -> V04 验收链 -> V05 套件/说明
D04/D07/D09/D13 + V04 --------------------------------> V05 新功能回归
```

允许并行：D10纯解析、D08纯候选、V01只读盘点（契约已冻结后）。必须串行：schema迁移只有一个写入者；tools.ts/index.ts/shared/contracts.ts集中协调；D04/D07/D09/D13同时涉及客户端组装，串行接线，不能几位AI各改同一巨型文件。不得为局部接线提前做 S14/WorkbenchApp结构重构。

每个片段先写会失败的测试、实现、跑定向测试、恢复到可构建状态，再进入下片段。每2–3片段做一次完整检查点。组件新增入 components，业务逻辑入纯模块；新增测试所需client纯模块检查tsconfig.build白名单。

## 3. 可执行片段

每个片段约30–120分钟（复杂集成最多240分钟）；实际耗时只用于安排，不是承诺。原任务300分钟不够作为全部片段可靠工期；本轮不擅自改截止/估时，应在基线后向用户报告范围与可交付批次。

### D01 共享输入校验与DTO（S1/S5/S7契约）

- 输出：progressPercent、DailyPlanItem.minutes/effortDone、persona摘要/绑定 DTO；纯校验返回可判别错误，不依赖React/SQLite。
- 预计文件：src/shared/contracts.ts、src/shared/taskProgress.ts（新）、src/shared/dailyPlanPolicy.ts（新）、test/progress.test.mjs（新）、tsconfig.build.json。
- 验收：0/99合法、100有独立语义；非法输入不夹取；分钟1/1440合法；所有DTO只在共享层定义，client投影不另造冲突形状。
- 验证：`pnpm build` 后 `node --test test/progress.test.mjs`；AX-P02、AX-D01。
- 依赖：无。大小M。

### D02 迁移与任务仓储（S1，角色字典统一迁移）

- 输出：迁移19加进度、persona scope字典、旧计划JSON兼容回填；任务读写进度与同值幂等。
- 预计文件：src/db/schema.ts、src/db/repo/tasks.ts、src/db/repo/task-primitives.ts（按实际类型声明位置）、src/db/repo.ts、test/db.test.mjs。
- 验收：18→19保留旧字段；重复migrate无变化；坏JSON保留诊断、合法项回填快照；不从子任务派生进度。
- 验证：`pnpm build`、`node --test test/db.test.mjs`；AX-P01、AX-D02。仅内存库/副本。
- 依赖：D01。大小M；不得另一分支重复占用迁移19。

### D03 进度工具、路由与共用验收服务（S2/S3）

- 输出：workbench_update_progress及注册；用户PATCH进度；completion领域函数共用，保留旧工具；pending投影接口按现有草稿查询扩展。
- 预计文件：src/tools.ts、src/index.ts、src/api/routes/tasks.ts、src/db/repo/completion.ts（新）、test/tools.test.mjs。需要路由测试时单独接一个小片段修改test/routes.test.mjs，不连带重写路由组织。
- 验收：100只提交草稿，缺summary/非execute拒绝；0–99不改状态；非法进度的多字段PATCH原子拒绝；相同值无重复事件。
- 验证：`pnpm build`、`node --test test/tools.test.mjs test/routes.test.mjs`；AX-P02–P06、AX-G01。拆掉AI完成硬拦必须变红。
- 依赖：D02。大小M/L，若文件超过5个再分“工具”和“HTTP”两次接线。

### 检查点 CP1：进度宿主路径

`pnpm typecheck`、`pnpm test`；对内存库观察progress=0/75/100全路径，不靠源码扫描代替库状态断言。用户真库不迁移、不装盘。

### D04 进度展示与输入（S4）

- 输出：TaskProgress独立组件；任务列表、详情、计划行接线；待验收投影与执行提示词。
- 预计文件：src/client/components/TaskProgress.tsx（新）、TaskList.tsx、src/client/index.tsx、src/client/viewTypes.ts、test/progressWiring.test.mjs（新）。PlanPanel展示留D07同一接线。
- 验收：done/cancelled不画进度；待验收/暂存/驳回区分；子任务旁证不改父进度；无N+1草稿查询；100明确任务完成动作。
- 验证：`pnpm typecheck`、`pnpm build`、`node --test test/progressWiring.test.mjs`；后续V05浏览器AX-P07/P08。纯扫描通过不是UI验收完成。
- 依赖：D03。大小M。

### D05 每日计划仓储完整字段（S5/S5-E）

- 输出：工具草稿→确认→持久化全路径保留minutes；effortDone只能用户写；保留项合并服务器最新结束状态；共同链校验与重复确认幂等。
- 预计文件：src/db/repo/plans.ts、src/tools.ts（proposeDailyPlanTool）、src/shared/contracts.ts、src/db/repo.ts、test/db.test.mjs。新增工具测试接D03测试文件已有块，不乱改其他工具。
- 验收：快照不随估时变；手动/AI父子链同规则；旧客户端省略字段不抹值；AI传effortDone报错；非法一个项整份不生效。
- 验证：`pnpm build`、`node --test test/db.test.mjs test/tools.test.mjs`；AX-D01/D03/D04。
- 依赖：D02。大小M。

### D06 计划API与项级更新（S5/S5-E）

- 输出：GET/PUT新字段、新POST plans/date/items原子追加、新PATCH plans/date/items/taskId；修改分钟与投入结束来源标记分流；历史/未来结束权限。
- 预计文件：src/api/routes/plans.ts、src/db/repo/plans.ts、src/shared/contracts.ts、src/client/viewTypes.ts、test/routes.test.mjs。
- 验收：项级PATCH读最新库，不覆盖其他项；相同状态幂等；404与400区分；今天结束可撤销，未来不得结束；PUT省略新字段保留。
- 验证：`pnpm build`、`node --test test/routes.test.mjs test/db.test.mjs`；AX-D05/D06。
- 依赖：D05。大小M。

### D07 计划投入编辑与结束交互（S4/S6-E）

- 输出：分钟显示/编辑、今日投入结束/继续投入、完成任务分开、显式25/50/75进度建议、原明天动作改名。
- 预计文件：src/client/components/PlanPanel.tsx、TaskProgress.tsx、src/client/index.tsx、src/client/viewTypes.ts、test/dailyEffortWiring.test.mjs（新）。
- 验收：投入结束后任务仍doing、进度/截止不变；保存/刷新/重新排序不丢字段；失败保持显示与中文错误；关闭/缺失任务保留记录但禁止动作。
- 验证：`pnpm typecheck`、`pnpm build`、`node --test test/dailyEffortWiring.test.mjs`；V05 AX-D07/D08，真实鼠标点击再重读API。
- 依赖：D04/D06。大小M。

### 检查点 CP2：长任务最小闭环

合成doing任务估时600、截止未来5天，今天排90并结束投入；刷新后task仍doing、progress原值、minutes90、effortDone=true、明天新项=false。该演示仅在内存/独立测试库；未具备隔离链时先用仓储与HTTP测试代替浏览器，不写真实任务。

### D08 统一候选纯函数（S7/S8/S9）

- 输出：dailyPlanPolicy候选/排序/诊断/未排入输出；提示词构造抽纯模块，30条限制有显式告知。
- 预计文件：src/shared/dailyPlanPolicy.ts、src/client/dailyPlanPrompt.ts（新）、test/dailyPlanPolicy.test.mjs（新）、test/dailyPlanPrompt.test.mjs（新）、tsconfig.build.json。
- 验收：未来doing入候选、未来todo不自动入；due继承/脏值/午夜、逾期开关、已有计划均可复现；31条提示完整总数且未称全量。
- 验证：`pnpm build`、`node --test test/dailyPlanPolicy.test.mjs test/dailyPlanPrompt.test.mjs`；AX-C01/C02。
- 依赖：D01。大小M，可与D10并行。

### D09 容量与候选全调用点接线（S6/S7/S8/S9）

- 输出：容量从计划快照求和；完整未排入区与一键排入；AI/PlanPanel手动池/账本共用函数；规则文案与逾期开关同步。
- 预计文件：src/client/capacity.ts、components/CapacityRulePanel.tsx、components/PlanPanel.tsx、src/client/index.tsx、test/capacity.test.mjs。接线扫描另小片段test/capacityWiring.test.mjs与test/capacityPanel.test.mjs，禁止脆行号断言。
- 验收：无计划0但未排入可见；全部有效快照合计一致；结束/关闭项不减已排；一键追加不改原项；不可解析计划不能假0。
- 验证：`pnpm build`、`node --test test/capacity*.test.mjs test/dailyPlanPolicy.test.mjs`；AX-C03–C06、AX-G02。
- 依赖：D06/D08。大小L，分“容量纯函数”与“UI接线”两次提交/验证；不做S14。

### D10 角色文档纯解析（S10）

- 输出：persona文档解析器、摘要与错误类型；以合成fixture覆盖真实形态。
- 预计文件：src/personas/parse.ts（新）、test/personaParse.test.mjs（新）。
- 验收：H1+blockquote、两行简介、rf/dotnet形态、BOM/CRLF、可选标量frontmatter、20k阈值/坏文档；禁止依赖DOM/React或读FS。
- 验证：`pnpm build`、`node --test test/personaParse.test.mjs`；AX-R01。真实9篇只读另验证，不把私人资产塞fixture。
- 依赖：规格已冻结。大小S。

### D11 角色发现、配置与资源安全（S10）

- 输出：三级来源发现、稳定ID/优先级、diagnostics、settings、资源安全读取；新增persona目录服务。
- 预计文件：src/personas/library.ts（新）、src/personas/resources.ts（新）、src/api/routes/personas.ts（新）、src/api/routes.ts、test/personaLibrary.test.mjs（新）。settings读写与tests单独小片段，统一contracts字段。
- 验收：用户>外部>内置；同名不同路径并存；根失效可观察；越界/link/binary/超限拒绝；不复制外部文件。
- 验证：`pnpm build`、`node --test test/personaLibrary.test.mjs test/routes.test.mjs`；AX-R02/R03/R06。
- 依赖：D10。大小L，拆“库发现”和“资源/HTTP”两片，不同组件重复读库禁用。

### D12 会话绑定与角色工具（S11）

- 输出：scope=persona包装仓储、绑定先于prompt、load/read资源工具及注册；会话绑定不可被AI任意ID越权。
- 预计文件：src/db/repo/ai-sessions.ts、src/tools.ts、src/index.ts、src/api/routes/personas.ts、test/personaBinding.test.mjs（新）。
- 验收：绑定重复同值幂等、不同绑定409；真实session上下文读取；角色改变hash明确拒绝；与日报/计划原scope登记不冲突。
- 验证：`pnpm build`、`node --test test/personaBinding.test.mjs test/aiSessionReuse.test.mjs test/tools.test.mjs`；AX-R04/R05。
- 依赖：D02/D11。大小M。

### D13 内置资产与角色选择UI（S12/S13）

- 输出：6篇自写内置角色、package.files包含assets/personas；独立PersonaPicker/纯提示块、各mode接线；同role复用/换role新会话。
- 预计文件分两片：A assets/personas六篇+package.json+test/packageManifest.test.mjs；B components/PersonaPicker.tsx、client/personaPrompt.ts（新）、client/index.tsx、test/personaWiring.test.mjs（新）、tsconfig.build.json。
- 验收：npm包内可读默认库；默认无角色提示词逐字不变；绑定在prompt前；10种mode一致；复用提前返回不能吞角色选择。
- 验证：`pnpm build`、`node --test test/packageManifest.test.mjs test/personaWiring.test.mjs test/aiSessionReuse.test.mjs`；打包用scripts/check-tgz.mjs，公开版本不改；V05 AX-R07/R08。
- 依赖：D12。大小L，必须拆上述A/B；内容可并行撰写，最终接线单写入者。

### 检查点 CP3：产品局部交付

`pnpm typecheck`、`pnpm test`；核对scope无批次2侵入、全调用点唯一口径、生成物资源完备；此时不宣布浏览器新功能通过，等待V05。角色属于提示材料，不提升工具权限。

### V01 过时验收脚本治理（P1-1）

- 输出：scripts/check-verify-scripts.mjs与scripts/verify/suites.json清单；明确现役/弃用/待核实原因。无.pwtest环境也应通过仓库清单工作，缺旧资料可读报缺失。
- 预计文件：scripts/check-verify-scripts.mjs（新）、scripts/verify/suites.json（新）、.pwtest命中项（仅本机警告/归档，不进仓库）、test/verifyManifest.test.mjs（新）。
- 验收：不删脚本；关键词只标嫌疑；弃用项不进入链，现役缺文件失败；统计动态生成，不固定150/22。
- 验证：`node scripts/check-verify-scripts.mjs`、`node --test test/verifyManifest.test.mjs`；AX-V01。
- 依赖：无，可与解析器并行；无装盘/重启动作。大小M。

### V02 CDP可移植驱动（S15）

- 输出：scripts/verify/cdp.mjs及browser discovery，保留独立profile/CDP超时。
- 预计文件：scripts/verify/cdp.mjs、scripts/verify/browser.mjs（新）、test/verifyBrowser.test.mjs（新）。
- 验收：环境覆盖与候选发现、缺浏览器可读；mock timeout拒绝；只关闭己方浏览器。
- 验证：`node --test test/verifyBrowser.test.mjs`，真实浏览器在隔离具备后做一次fixture页点击/重读/截图；AX-V02。
- 依赖：V01。大小M。

### V03 自锁与安装目标校验（S16安全前置）

- 输出：src无变更；scripts/verify/safety.mjs纯预检与只读环境采集；修dev-install显式目标传递（不改用户运行profile）。
- 预计文件：scripts/verify/safety.mjs（新）、scripts/dev-install.mjs、scripts/check-installed-version.mjs（仅目标参数必要改动）、test/verifySafety.test.mjs（新）。
- 验收：同端口/目录/DB、环境缺失、非3080/web、继承desktop路径全部拒绝；--force不能绕过；拒绝时spawn/安装/kill/DB写次数全0。
- 验证：`node --test test/verifySafety.test.mjs`；AX-V03–V05/G03，用spy/mock验证零副作用，禁止“为了测拒绝”杀真实进程。
- 依赖：V01，先于V04任何装盘；数据隔离首次配置必须用户确认。大小M。

### V04 研发验收链阶段编排（S16）

- 输出：scripts/dev-verify.mjs、结构化summary、时间预算与失败归因；dry-run只读。
- 预计文件：scripts/dev-verify.mjs、scripts/verify/evidence.mjs（新）、test/devVerify.test.mjs（新）、.gitignore（如确需补派生物）。另拆V04-B构建标识小片段：package.json/tsdown.config.ts、scripts/build-info.mjs（新）、src/api/routes.ts、src/client/index.tsx；更新shared/contracts.ts的health/诊断类型。先读构建配置再改，不和链编排一口气重写。
- 验收：每阶段检查退出码并停止；新构建health+客户端标识匹配；日志token脱敏；失败/超时/套件缺失不绿；只清本次进程与临时目录。
- 验证：`node --test test/devVerify.test.mjs test/verifySafety.test.mjs`；AX-V06–V09。先mock阶段故障注入，后独立测试实例实跑。
- 依赖：V02/V03。大小M；操作时必须加载safe-plugin-ops。

### V05 白名单套件与使用说明（S17/S17-N/S18）

- 输出：4套现役参数化迁移（逐项输入见[legacy-regression.md](legacy-regression.md)的43个LEG编号）；新增progress/daily-effort/persona/verify-safety浏览器或安全判据；更新既有项目级skill“研发版本验收链”一节、README入口。原脚本不可获得时按版本化判据重建并标清来源；判据输入也缺失则阻塞该套，不发明断言。
- 预计文件按套件单独小片段：scripts/verify/suites/*.mjs、suites.json、.dsh/skills/dsh-plugin-change/SKILL.md、README.md。不新建skill，不同步用户级副本除非用户要求。
- 验收：AX矩阵所有mandatory项有实际测试位置与证据；历史count不当现场证据；写入只对合成独立DB；角色实际工具加载可观察，缺模型能力明确不通过不能跳过报绿。
- 验证：`node scripts/dev-verify.mjs ...`（参数见requirements），`pnpm test`、`pnpm typecheck`；AX-V10/G04与各UI场景。
- 依赖：V04与对应D04/D07/D09/D13；测试脚本可先写，执行必等依赖完成。大小L，按每套件拆开。

## 4. 最终检查点 CP4 与交接

- 需求全部映射到acceptance表：用例文件、断言位置、实测结果、证据路径。
- 硬拦/候选唯一实现/路径边界/自锁的反向变异已演示；记录恢复后的完整绿。
- typecheck/build/完整测试/旧浏览器回归/新浏览器功能全过。无运行环境时如实记“未验证”，不能以静态检查替代。
- git diff核对只改相关文件；无私人fixture、token、临时运行DB/浏览器profile、自动复制的公司角色正文。
- 写任务共享记忆：已实现片段、未完成片段、验证命令/结果、用户待验收点。代码完成后申请工作台验收，不直接done；当前consult策略需用户先切execute才能走工具验收。
- 未经用户真机确认不公开发布、不改公开版本号、不重启19387当前实例。

## 5. 保留与风险说明

原10项、遗留清单、批次2/3路线图见工作台任务描述，不用这次新增规格覆盖历史范围。不改docs/release-checklist.md里用户已有修改。`.pwtest`和关联ADR当前可能未跟踪，但不要自动git add/commit全仓；用户未要求提交代码。

本计划不假设未来工具/脚本已存在；带“新”的模块由后续开发创建。本轮仅核对已有入口并写规格，不调用dev-install/dev-verify。
