# 验收矩阵：工作台插件优化

任务 `36c8e8ef-1104-4e68-b55f-a2a6cc533ab9`；2026-09-30。**以下全部是目标判据，当前状态均为未实施/未运行，不是实测报告。** 目标语义见[requirements.md](requirements.md)，实施顺序见[plan.md](plan.md)。

## 1. 测试层与通过规则

- U：纯函数/内存数据库断言；H：真实仓储+HTTP/工具契约；W：源码/生成物接线扫描；B：独立实例真实浏览器点击+接口重读+截图；N：安全负向spy/mock故障注入。
- S17旧回归的逐项输入为[legacy-regression.md](legacy-regression.md)的43个LEG编号；只读提取的源码断言不是运行通过证据。缺可读判据输入时阻塞该套迁移，不按计数发明测试。
- 每个编号为mandatory；表中的文件是后续落点（“新”表示当前尚不存在）。无法运行B不能标通过，应明确“未验证”；静态W不得替代B。
- 每个编号的证据至少记录：测试位置、执行命令、实测输出、退出码；浏览器另记截图与执行后字段。证据放gitignored test-results/workbench-verify/runId。
- 完整验证：`pnpm typecheck`；`pnpm test`（内含build）；定向 `node --test ...` 需先build。不得靠本机旧lib得到假绿。CLI安全纯mjs测试不需build。
- 源码扫描用符号/调用点，不锁死旧行号或脚本计数；只有扫描+行为测试一起才能证明共用口径。

## 2. 任务进度

| ID | 层 | 场景与具体期望 | 目标测试 |
|---|---|---|---|
| AX-P01 | U | 内存18库有todo/doing/done任务，migrate到19全部progress=0；原字段不变；再次migrate无变化；非法库内100受CHECK拒绝 | db.test.mjs |
| AX-P02 | U/H | 0/25/75/99存储成功；-1/101/小数/字符串/null/布尔/NaN/Infinity拒绝；同值不写事件/updatedAt | progress.test.mjs（新）、tools.test.mjs |
| AX-P03 | H | execute任务原progress=75，工具progress=100+summary只创建/更新completion草稿；progress仍75、status仍doing；重复提交无第二份pending | tools.test.mjs |
| AX-P04 | H | 100缺summary/consult任务/归档/已完成/已取消拒绝；无草稿、无状态/进度部分写入 | tools.test.mjs |
| AX-P05 | H | 用户多字段PATCH含非法进度全部不生效；PATCH进度100拒绝；界面100走任务完成路径、不入库100 | routes.test.mjs、progressWiring.test.mjs（新） |
| AX-P06 | H | completion暂存/驳回进度不回退；通过验收后done、原progress保留；重开后显示原progress；级联不改祖先/后代显式值 | db.test.mjs、routes.test.mjs |
| AX-P07 | B | 列表/详情/计划行显示未完成进度，done/cancelled隐藏；pending显示待验收、deferred显示暂存、rejected无徽标；刷新后仍一致 | suites/progress.mjs（新） |
| AX-P08 | U/B | 直接子任务done/cancelled分别展示；不从子任务派生进度；执行提示词有主动报告阶段进度、AI不能直接done | progressWiring.test.mjs（新）、suites/progress.mjs（新） |

## 3. 每日计划与投入结束

| ID | 层 | 场景与具体期望 | 目标测试 |
|---|---|---|---|
| AX-D01 | U/H | 显式minutes=1/90/1440合法，0/1441/小数/字符串拒绝整份；task estimated=600省略取600，无估时取设置30；回执列最终分钟 | db.test.mjs、tools.test.mjs |
| AX-D02 | U | 旧JSON缺字段迁移回填分钟快照/effortDone=false，保留排序/备注；未知taskId保留；坏JSON保留原串、读回诊断/容量不可计算 | db.test.mjs、capacity.test.mjs |
| AX-D03 | H | 创建草稿取minutes=90，之后改task estimate=600再确认仍90；同task既有项省略minutes保留；API保存备注不丢minutes/effortDone | tools.test.mjs、routes.test.mjs |
| AX-D04 | H | 重复taskId/父子同链/新增关闭或归档项/新增未知任务拒绝，不部分创建；兄弟叶子允许；已有缺失项原样保留，不妨碍追加合法项；草稿确认再次校验；AI传effortDone报错 | db.test.mjs、tools.test.mjs、routes.test.mjs |
| AX-D05 | H | PATCH今天项effortDone=true/false只改该日目标项；相同值幂等，任务状态/进度/due/estimate与其他项不变；结束不改sourceCode，分钟修改为manual | routes.test.mjs |
| AX-D06 | H | 不存在日期/项404；缺字段或非法值400；过去修改400、未来结束true拒绝；PUT省略字段保留；items空拒绝，DELETE可清空 | routes.test.mjs |
| AX-D07 | B | future-due doing长任务今天排90→真实点“今日投入结束”→显示已结束→刷新仍true、task仍doing/progress原值→点继续投入为false | suites/daily-effort.mjs（新） |
| AX-D08 | B | 投入结束只出现显式25/50/75进度建议，未点不变；点50只写progress；“完成任务”明确走旧完成与级联；“推迟截止一天”只改due不转移项 | suites/daily-effort.mjs（新） |
| AX-D09 | H/B | 结束后重排/改备注/确认旧草稿保留最新结束状态；删除再添加为false；明天同任务新项false；关闭/缺失任务留行、无操作按钮 | db.test.mjs、suites/daily-effort.mjs（新） |

## 4. 候选池与容量

| ID | 层 | 场景与具体期望 | 目标测试 |
|---|---|---|---|
| AX-C01 | U | 表驱动：due当日/继承due/doing未来截止/blocked无截止/已有计划/逾期todo开关/归档donecancelled/坏due/DST边界，逐条输出原因与诊断 | dailyPlanPolicy.test.mjs（新） |
| AX-C02 | U/B | 31个候选稳定排序后列30，提示词与UI均写另有1条；账本/手动池全量31；进度/子任务旁证与列表同源 | dailyPlanPrompt.test.mjs（新）、suites/daily-effort.mjs（新） |
| AX-C03 | U | 无计划但10个候选→已排0/未排10；90+60=150，账本总额150，已结束/任务done不自动减已排；删60后90 | capacity.test.mjs |
| AX-C04 | U | 已排task未来截止/归档/取消/删除均以持久minutes计容量并标状态；坏JSON显示不可计算；默认估时修改不改已有minutes快照 | capacity.test.mjs |
| AX-C05 | H/B | 一键排入调用POST原子追加并即时重读；保留原排序/备注/结束状态与已有缺失项；父子冲突明确提示、无部分生效；无计划可创建；重复taskId added=false不改已有值；并发追加B/C最终两项均存在 | routes.test.mjs、suites/daily-effort.mjs（新） |
| AX-C06 | W/B | AI排序、PlanPanel手动添加、未排入区共用dailyPlanPolicy；includeOverdue仅候选，容量数不变；规则文案吻合，提醒/日历未被改语义 | capacityWiring.test.mjs、capacityPanel.test.mjs、suites/daily-effort.mjs（新） |

## 5. 角色库与会话

| ID | 层 | 场景与具体期望 | 目标测试 |
|---|---|---|---|
| AX-R01 | U | 合成H1/blockquote/跨行简介/frontmatter标量、UTF8/BOM/CRLF、160摘要/20k正文、无H1/无正文/坏frontmatter边界；parser无React/DOM/FS | personaParse.test.mjs（新） |
| AX-R02 | U/H | 临时rf/dotnet子目录发现；同逻辑路径用户>外部>内置；同显示名不同ID并存；README/隐藏/link/资源附件排除；数量/深度超限有诊断 | personaLibrary.test.mjs（新） |
| AX-R03 | H | 外部根无权限/不存在只禁用该来源；settings GET/POST同形状、收藏/禁用去重；摘要不含正文/绝对路径 | routes.test.mjs、personaLibrary.test.mjs（新） |
| AX-R04 | H | 绑定在prompt前；scope=persona不覆盖daily_plan登记；同绑定重复幂等、不同绑定409；AI工具仅exec.sessionId、无session/未绑定可读错误 | personaBinding.test.mjs（新）、personaWiring.test.mjs（新） |
| AX-R05 | H | 正文修改后hash不符拒绝旧绑定；源丢失明确报错不切其他源；资源工具先验绑定revision；重复load同revision一致 | personaBinding.test.mjs（新） |
| AX-R06 | U/H | 资源合法相对路径成功；../绝对/UNC/盘符/大小写绕过/编码绕过/NUL/link/junction/二进制/坏UTF8/超128KiB或20k拒绝；不读根外文件、不执行脚本 | personaLibrary.test.mjs（新） |
| AX-R07 | W/B | 10个mode均有同一角色选择路径，未选角色最终提示逐字不变；与技能栏不遮挡；正文不内联；实际load_persona工具被调用并返回所选内容 | personaWiring.test.mjs（新）、suites/persona.mjs（新） |
| AX-R08 | H/B | 同role沿用旧会话；显式不同role/无role创建新会话并告知，旧binding不变；归档会话新建；包内六篇可发现，公司内部角色库九篇本机只读兼容（无资产时明确未验证） | aiSessionReuse.test.mjs、packageManifest.test.mjs、suites/persona.mjs（新） |

角色正文是提示材料，不应修改宿主工具权限；readonly角色不是数据库ACL。B层必须观察真实工具调用；模型/服务无法运行时标未验证，不能只测选中后声称人格已生效。

## 6. 验收链与安全

| ID | 层 | 场景与具体期望 | 目标测试 |
|---|---|---|---|
| AX-V01 | U/N | script hygiene不删除脚本，嫌疑/弃用/现役分档；白名单缺文件失败；新机器无.pwtest仍能使用仓库套件；不固定150/22 | verifyManifest.test.mjs（新） |
| AX-V02 | U/N/B | 独立浏览器user-data-dir+CDP端口；覆盖路径不可执行报错；30s超时确实reject；关闭只针对己方浏览器 | verifyBrowser.test.mjs（新） |
| AX-V03 | N | 当前端口等于目标，带--force仍拒绝；缺/非法DSH_WEB_URL拒绝；非loopback/非3080-web拒绝；spy显示安装/kill/DB写次数0 | verifySafety.test.mjs（新） |
| AX-V04 | N | 不同端口但相同realpath profile或DB仍拒绝；继承desktop DSH_PROFILE_DIR不能传给web安装；验证WORKBENCH_PROFILE_DIR一致 | verifySafety.test.mjs（新） |
| AX-V05 | N | 目标profile未显式独立DB配置/目标DB与当前相同/实际配置不可知均拒绝；仅--db-path声明不能冒充隔离；dry-run零写入 | verifySafety.test.mjs（新） |
| AX-V06 | N | 逐阶段注入构建/装盘/diff/dump-config失败，后阶段不运行；版本门禁装前后0才继续；不更新额外依赖 | devVerify.test.mjs（新） |
| AX-V07 | N/B | health200但旧构建拒绝；health120s/token60s超时非0且有阶段名；认证失败/空套件/缺套件/required skipped不能通过 | devVerify.test.mjs（新） |
| AX-V08 | N | token包含于假日志/错误stdout/测试URL时所有持久证据均已脱敏，原token字符串全树查不到；不记录完整配置秘密 | devVerify.test.mjs（新） |
| AX-V09 | N | 套件180s超时退出3；断言失败退出1；自锁退出2；finally不覆盖失败为0；清理只处理自己的临时目录/浏览器 | devVerify.test.mjs（新） |
| AX-V10 | B | 独立测试实例实跑旧四套+新增套件；各套非零断言、截图/接口重读与summary一致，runId合成数据；当前19387未重启且正式DB未改 | suites清单+dev-verify证据 |

## 7. 批次2：日期面板 / 工作区 / 宿主声明（2026-10-01 新增）

> 与 §2–§6 一样，**以下全部是目标判据，当前状态未实施/未运行**。目标语义见
> [requirements.md](requirements.md) §8，口径见 [ADR0001](../../adr/0001-today-is-the-day-panel.md)。

| ID | 层 | 场景与具体期望 | 目标测试 |
|---|---|---|---|
| AX-T01 | U | 树来源纯函数表驱动：**当日到期 / 当日计划项 / 进行中** 各自单独命中、两两命中、三者全中；并集去重；命中多来源时**全部**标出且顺序固定（到期→计划→进行中）；`done`/`cancelled` 不进树；计划项指向的已删任务不进树 | dayPanelTree.test.mjs（新） |
| AX-T02 | W | 来源判定**只有一份实现**：`planCandidates` 与面板树共用同一纯函数；组件里不出现第二份 filter/来源公式（扫符号与调用点，**不锁行号**） | dayPanelWiring.test.mjs（新） |
| AX-T03 | B/W | 从「今日」进入与从「日历选中今天」进入得到**同一个**面板：同一行集合、同一页签集合（计划 / 已完成 / 报告）、同一统计卡与容量条 | suites/day-panel.mjs（新） |
| AX-T04 | U/B | 父/祖父仅作上下文时灰化且**不计入统计**（与「已完成」页签同口径）；今日实例不再有"另有 N 个进行中任务暂列今天"的特例文案（该来源已进口径） | dayPanelTree.test.mjs、suites/day-panel.mjs（新） |
| AX-T05 | B | **口径变更生效且不丢件**：截止在几天后、未排入今天、状态 `todo` 的任务不再出现在今日树；同一条任务在「任务」页仍可见、可打开 | suites/day-panel.mjs（新） |
| AX-W01 | U | 工作区候选判定唯一实现：已有工作区 ∪ 最近手动 ∪ 默认值，去重、空值过滤；下拉**不得**再造一份候选 | intakeWorkspace.test.mjs（既有，追加） |
| AX-W02 | B | 三个入口（快速录入 / 新建任务 / 编辑任务）都能 ① 从**已有工作区下拉**选中 ② 打开**文件夹弹框**浏览并「选择此文件夹」；选中值落到该入口的 `workspacePath`；空值仍走既有继承 | suites/workspace-picker.mjs（新） |
| AX-W03 | N/B | 弹框失败路径：不存在 / 不可读 / 不是目录 → 可读中文错误；非 loopback 拒绝；`LocalDocModal` 的 **file 模式行为逐字不变**（同一组件两模式，**不是**第二份弹窗）；宿主 `workspaces` 服务缺失时下拉退化为空并说明原因、不抛异常 | suites/workspace-picker.mjs、routes 既有拒绝用例 |
| AX-H01 | U | `peerDependencies` 同时含能力门槛 `0.1.5-rc.1` 与最新核心 `0.2.0-rc.2`；不含更低版本；不退化成 `*` / `>=0` | pluginEntry.test.mjs（**已实现**，阶段 A） |
| AX-H02 | U/W | 构建期类型源与声明兼容线一致（`devDependencies` 的 `@deepseek-ai/dsh-*` 对齐到声明所覆盖的核心线）；对齐后 `pnpm typecheck` / `build` / 完整测试全绿 | hostTypes.test.mjs（新） |
| AX-H03 | N/B | 测试实例宿主版本＝用户宿主版本（`0.2.0-rc.2`）：CLI 包 manifest、`/api/workbench/health`、客户端 buildId 三方一致；自锁未被绕过、19387 未重启、正式 DB 未迁移 | dev-verify 证据 + suites/verify-safety.mjs |

## 8. 不变量、变异与收口

| ID | 断言 | 反向验证 |
|---|---|---|
| AX-G01 | AI工具不能直接done/cancelled，100只走completion | 临时副本移除tools硬拦/改100直接done，应让tools测试失败；恢复后绿 |
| AX-G02 | 三处候选共用唯一纯函数，不重新内联旧filter | 在临时副本将手动池改回旧过滤，应让接线扫描及候选场景失败；恢复后绿 |
| AX-G03 | 同端口/目录/DB自锁fail-closed | 在临时副本移除任一相等检查，应让对应spy负向断言失败；恢复后绿；不真的杀进程 |
| AX-G04 | persona资源无法跨绑定根读取；套件不能吞错误报绿 | 临时副本去掉资源边界/把suite失败改exit0，资源/编排测试分别失败；恢复后绿 |
| AX-G05 | 日期面板树的来源判定只有一份实现（批次2） | 在临时副本把来源公式复制进 `DayPanel.tsx`，应让 AX-T02 的扫描变红；恢复后绿 |
| AX-G06 | 工作区弹框必过 loopback 与路径归一化（批次2） | 在临时副本去掉 loopback 校验或路径归一化，应让对应拒绝用例失败；恢复后绿 |

## 9. 交付记录模板

后续开发为每个AX编号补：`状态（通过/失败/未验证）｜测试文件与符号｜实际命令｜退出码｜证据路径｜未验证原因`。不得只写“测试全绿”或引用历史17/17。

最终完成条件是所有mandatory编号都有通过证据，用户在自己的正式实例上确认可用。证据缺失时任务仍待验收，不公开发布、不自动done、不降低数据库schema。
