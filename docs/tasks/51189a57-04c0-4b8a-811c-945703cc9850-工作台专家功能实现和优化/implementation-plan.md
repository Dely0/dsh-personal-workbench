# 专家功能施工计划（供小模型逐批执行）

状态：待用户评审；以下全部为实施任务，当前不代表已完成。设计唯一入口是 [方案 v0.3](方案-v0.3.md)，断言见 [acceptance.md](acceptance.md)。

## 0. 使用方式与前置约束

- 一次只做一个 P 批次；不要一次性把整份计划交给小模型并要求全部改完。
- 每批先读指定规格章节和当前文件，再实现列出的导出；新功能入口在后面批次才接线。
- 各批的新增测试名为规划目标。测试文件不存在时应在本批创建，不把“找不到测试文件”算通过。
- 先执行 pnpm typecheck，再执行 pnpm build，最后运行本批 test 文件。build 用于生成 test 引用的 lib；不能对旧 lib 跑测试后声称新 src 通过。
- 依赖实际宿主的检查先用隔离实例；不要动当前聊天所在实例或用户已有专家/技能。
- 现有用户修改、未跟踪文档和 scripts/lib/_p2_left_body.txt 不属于施工成果，不能一起提交或清理。
- 运行前重新看 git status、ADR 编号及 src/shared/contracts.ts。若代码已变，以符号定位并记录差异，不恢复旧快照。
- 测试涉及 DB、人格根、技能根时每个测试用独立临时目录；finally 清理只限这些已核验目录。

## P0 — 固定宿主契约与施工基线

前置：无。读 v0.3 §1、§2、§8、§10，ADR 0005、0006、0008。

本批只记录事实，不实现产品。不重启/安装。

1. 记录当前 git HEAD、package 版本、SCHEMA_VERSION、host/client inject。
2. 核对 sessions.create({workspaceId}) 返回 SessionId；connectWorkspace 可能复用 blank，不能用于新生成入口。
3. 核对 subagents.list/getProvider/start；spawn 的 inheritsParentContext=false，persona/toolFilter/depthLimit=true，run 有 localAgent/result/dispose。
4. 核对 header.origin、parentSession、delegationDepth 和 options.subagentDepth。按 v0.3 §8.5 的确定算法写夹具。
5. 核对 skills.registerProvider 工厂、control.invalidate、list/get 的 scope/cwd、candidate.rank/resourceBase。
6. 核对 inputTriggers onPick 同步、codec.serialize 异步，ReferenceInsert source/ref/label/appearance/clipboardText。
7. 记录公开 scopeOf(ctx) helper 可取得真实 Agent scope。后续使用官方公共模块动态加载；不能猜内部 Symbol。
8. 把包版本、文件+导出、测试目标配置事实写到 verification.md；不要只贴 TEMP 绝对路径。
9. 若契约缺失：保留主功能的能力降级，不假装运行验证已通过；若缺失是实现方案不可适配的变化，记录准确差异后停止依赖该接口的批次。

完成条件：verification 中有可复核版本与契约清单；已有 API 和新增规划 API 明确分开。

## P1 — 类型、设置、字典种子与纯路径/来源校验

读：v0.3 §3、§10。先不接任何 UI。

新增：

- src/shared/expert.ts：规格的类型、错误码和限值。
- src/db/repo/experts.ts：readExpertSettings、writeExpertSettings、getExpertDraft、getPendingExpertDraftForSession、createExpertDraft、updateExpertDraftCas。
- src/experts/paths.ts：resolveExpertRoots、validateExpertRelativePath、assertNoLinksInsideRoot、atomicWriteText、withExpertInstallLock。
- src/experts/provenance.ts：parseExpertProvenance、validateExpertSourceFiles、stableJson、expertManifestHash。

修改：

- src/shared/contracts.ts：DraftKind 增 expert；WorkbenchSettings 加 autoSummonExperts:boolean。
- src/db/seed.ts：draft_kind/expert、ai_session_scope/expert_generation；沿用 INSERT OR IGNORE。
- src/db/repo.ts：只再导出新仓储所需符号，避免从 barrel 反向循环 import。
- src/client/settingsFallback.ts：缺字段补 false；已有 false 不覆盖。

精确仓储行为：

1. 设置只有 expert_auto_summon 键；缺失/脏值 false；写入只接受真正 boolean。
2. updateExpertDraftCas 必须检查 kind、status、contentVersion，SQL UPDATE WHERE 同版本；0 行返回 draft-version-conflict，不能覆盖另一轮输出。
3. 查询 expert 草稿过滤 kind，不覆盖同会话 task/knowledge 草稿。
4. 同 session 创建 pending expert 在短事务内去重；不同 request 返回冲突。
5. 开关和 seed 不改变 SCHEMA_VERSION，不自造 migration。

测试：test/expertContracts.test.mjs、test/expertPaths.test.mjs、test/expertProvenance.test.mjs。覆盖 AX-E01–E06。

检查：

~~~powershell
pnpm typecheck
pnpm build
node --test test/expertContracts.test.mjs test/expertPaths.test.mjs test/expertProvenance.test.mjs
~~~

交接：导出签名、路径负例清单、设置 GET/POST 尚未接线的事实。

## P2 — 草稿提交、分文件暂存和整包校验

前置：P1 通过。读 v0.3 §3–§5、§6.1、§7.2。

新增：

- src/experts/skill-package.ts：parseWorkbenchSkill、validateWorkbenchSkillPackage、hashSkillPackage。
- src/experts/drafts.ts：assertExpertDraftOwner、submitExpertDraft、stageExpertFile、removeExpertStagedFile、validateExpertDraft、readExpertStagedFile。
- test/expertDrafts.test.mjs、test/expertSkillPackage.test.mjs。

修改 package.json / pnpm-lock.yaml：增加普通库 yaml 2.9.1；不添加第三方 DSH 插件。

实施步骤：

1. 用真实 parser 校验规格模板，确保元信息可以解析；不得通过扩白名单解决模板问题。
2. submit 先完整校验输入再改 DB；非法 JSON、人格式样或名称/正文超限不得损坏之前的有效版本。
3. stage 每次只写一个 UTF-8 文件，校验 area/path/配额/owner；不能通过 JSON 传任意绝对路径。
4. 同 draft mutex 下执行文件写入 + DB CAS。已有文件保留本次临时备份；CAS 失败且目标仍为本次新 hash 时恢复旧文件，不覆盖第三方变化。
5. 进程在文件替换与 DB 更新之间中断：下一次读/validate 必须检测 indexed hash 与磁盘不一致，返回 staged-file-changed；不准自动确认。owner 可以按当前 DB version 重新 stage 该文件恢复一致。
6. 删除只能删索引中属于本草稿的文件；不存在则 changed:false，不能 rm 一个计算错误的目录。
7. 完整校验调用同一 validate 包函数；成功保存 checked version/hash；变更后清 validation。
8. 所有许可全文保留；skill frontmatter 保留 metadata，正确解析 false 字符串；不允许空 SKILL.md；packageFiles 与该 skill 暂存路径集合完全一致。
9. skill requirements 的 required 缺项是 error，可选缺项是 warning；warnings 不自动消失。

覆盖 AX-E07–E14。每个测试注入 fake session 和独立真实 FS/DB，不只断言“调用了某函数”。

检查：

~~~powershell
pnpm typecheck
pnpm build
node --test test/expertDrafts.test.mjs test/expertSkillPackage.test.mjs test/personaParse.test.mjs
~~~

交接：一个可重复校验的 original 草稿和一个包含 MIT 来源/skill 的测试夹具；正式目录仍为空。

## P3 — 安装、发现门、跨目录中断恢复

前置：P2 通过。读 v0.3 §6 全部。本批是安装主链，不能缩成若干 writeFileSync。

新增：

- src/personas/managed.ts：isManagedPersonaId、readManagedPersonaPublication。
- src/experts/install.ts：confirmExpertDraft、recoverExpertInstallations、recoverExpertInstallation、rollbackUncommittedInstallation。
- test/expertInstall.test.mjs、test/expertRecovery.test.mjs。

修改 src/personas/library.ts、src/shared/persona.ts：在 discovery/resolve 共用的来源遍历/解析链上加受管发布门与 installation-incomplete 诊断；普通三来源行为不变。

实施步骤：

1. 按 §6.4 建完整 journal；测试中传 failpoint，生产入口没有 failpoint 参数。
2. 构建目录从原暂存区复制，不能把唯一 source rename 走。
3. 每次 rename 前二次核对目标不存在；同名 skill 冲突先拒绝。
4. files-published 时即使人格 .md 已在，discover 和 resolve 都读不到它。
5. DB confirmed 与 confirmResult 同一短事务提交；只有后续 publication.ready 才打开发现门。
6. 所有 createdPaths 记录内容 hash；rollback 不碰 reusedPaths 或第三方修改。
7. repeated confirm 先恢复发布，不重新生成 UUID。
8. 从 prepared、files-published、db-committed、ready 各阶段模拟重启构造新 service，验证恢复方向。
9. journal 主文件坏而 previous 完整时恢复；两个都坏时 repair-required，插件不崩。
10. 锁 owner 仍活着拒绝；死进程锁可回收；无法判断时不强行删。
11. 两个独立 DB 共享根时，B 恢复不得操作 A 的 journal；A 已 ready 的文件可供 B 发现；缺 ownerDbKey 的日志不得当未提交删除。

故障点至少包含：附件发布前/后、每个 skill 发布后、人格发布后、SQLite COMMIT 前/后、publication 前/后、provider invalidation。

覆盖 AX-E15–E23，回归 personaLibrary/personaBinding。

~~~powershell
pnpm typecheck
pnpm build
node --test test/expertInstall.test.mjs test/expertRecovery.test.mjs test/personaLibrary.test.mjs test/personaBinding.test.mjs
~~~

交接：故障点 → DB/FS/发现结果的实际矩阵。这里不允许记“先做 happy path，恢复以后补”。

## P4 — provider、catalog 和运行前依赖预检

前置：P3 通过。读 v0.3 §7、§9.1–§9.2、§10。

新增：

- src/experts/skill-provider.ts：createWorkbenchSkillProvider、invalidateWorkbenchSkills。
- src/experts/catalog.ts：listExpertCatalog、preflightExpert、buildAutoExpertPrompt。
- src/experts/host-adapter.ts 的 skills/scope 部分。
- test/expertProvider.test.mjs、test/expertCatalog.test.mjs。

注册 SDK scopeOf 公共模块的类型开发依赖：@deepseek-ai/dsh-scope 0.2.0-rc.2；optional peer ^0.1.0-rc.1 || ^0.2.0-rc.1 并 peerDependenciesMeta.optional=true。生产 host-adapter 只在需要真实 scope 时动态 import；失败时 skill-scope-unavailable，不导致整个插件加载失败。范围是安装候选，P0/P9 仍须核对实际 API，不声称旧宿主都支持该功能。禁止静态引入另一份完整 subagent runtime。

实施步骤：

1. provider candidate 全部 rank 600，resourceBase 真实包根，source='bundled'。
2. 受管技能依赖 publication.ready；坏包有 diagnostics。
3. get 在 list 后再次核 hash；变动 invalidate，不偷换正文。
4. root 服务的 skills.list 不会自动按调用 Agent scope 筛选。必须用公开 scopeOf(exec.agent.ctx)，并传 scope/cwd/signal；cwd 取 exec.agent.session.header.cwd。HTTP 无 live Agent 标 preliminary。
5. 安装后 invalidate，新 catalog 立即包含新技能。
6. catalog 从合法摘要和不合法诊断构建完整行；保留收藏/停用；generated 必需技能不可用时不进入 personas 可选数组。
7. 未登记来源的旧手工专家仍可用；generated 的来源损坏明确报错。
8. 自主提示清单每次 assemble 同步读取有效人格摘要，按收藏优先/ID 排序取前 30 条，description ≤80；总文本 ≤6000。明确说明仅列出前 N/共 M 条，更多可由用户 @ 指定。真正执行仍做完整异步 preflight；该摘要不是权限或技能可用性的最终证明。
9. 提示区块 interpolate:false；来自专家名称/简介的花括号或标签不能变成 prompt 模板变量。

覆盖 AX-E24–E30、AX-E48–E49 的 scope 前置断言。

~~~powershell
pnpm typecheck
pnpm build
node --test test/expertProvider.test.mjs test/expertCatalog.test.mjs test/skills.test.mjs
~~~

交接：rank 400 胜出、不同 scope 胜出、服务缺失降级、安装后缓存失效证据。

## P5 — 服务端工具、路由、设置和主链装配

前置：P4 通过。读 v0.3 §4–§5、§9.4。

新增：

- src/experts/service.ts：createExpertService，组合所有 manager，dispose。
- src/experts/tools.ts：5 个生成工具，execute 只调服务。
- src/api/routes/experts.ts：capabilities/catalog/methodology/generation-start/draft/validate/file/preflight。
- assets/expert-generation/methodology.md：按 §5.2–§5.3 完整编写。
- test/expertRoutes.test.mjs、test/expertTools.test.mjs、test/expertWiring.test.mjs。

修改：

- src/index.ts：服务装配、启动恢复、生成工具、可选 skills 子 fiber、关闭清理。
- src/api/routes.ts：WorkbenchRouteDeps.experts、设置唯一读写接线。
- src/api/routes/drafts.ts：expert confirm/abandon/defer 分支；异步确认不得被外层旧 pending 判断提前拒绝幂等重放。
- src/tools.ts：loadPersonaTool 可选 preflight 回调；既有绑定加载成功后再检查 required 依赖。
- package.json.files：增加 assets/expert-generation。

精确接线顺序：DB/seed → expert service → 恢复日志 → routes/生成 tools → skills 子 fiber → 普通加载工具注入 preflight。服务 dispose 取消自己拥有的运行并释放 effect，不关闭别人的 service。

设置 POST 只接受 boolean；存储后调用 service.setAutoEnabled；响应仍 readWorkbenchSettings，不能请求体原样回传。

专家 confirmResult 返回在 expert 字段；旧任务 confirm 返回结构不改。abandon 在安装中拒绝；清理暂存失败返回警告，不回滚已经 abandoned 的 DB 状态。

覆盖 AX-E31–E35、AX-E50。

~~~powershell
pnpm typecheck
pnpm build
node --test test/expertRoutes.test.mjs test/expertTools.test.mjs test/expertWiring.test.mjs test/httpFence.test.mjs
~~~

交接：无 UI 的完整真实 HTTP“创建 → 暂存 → 校验 → 确认 → catalog”夹具。

## P6 — 请求、子代理按需人格、回传与释放

前置：P5 通过。读 v0.3 §8 全部。P0 SDK 核对必须完成。

新增 src/experts/invocation.ts、test/expertInvocation.test.mjs。补 host-adapter 的 subagents 部分、tools 的 4 个调用工具。

实施顺序：

1. request 表按 session 归属、身份、TTL 存内存；上限 256。
2. 首次 runManual 把 task hash 固定到 request；同 request 同 task 返回同 Promise，不同 task 返回 manual-request-task-changed。
3. auto 以真实 sessionId + exec.callId 为本次身份；同工具执行重复分派不重复启动，另一个 callId 是新的请求。
4. 真实父 Agent 校验、依赖 preflight、并发位占用、ticket 创建必须在 start 之前。
5. persona 参数只有短静态模板和 hex ticket；不放人格正文或用户名。
6. fake provider 在 start 返回前主动执行 loadForChild，验证首次 prompt 的时序。
7. 核对 child claim 与 run.localAgent/run.id；origin/parentSession/ticket 不匹配全部拒绝。
8. 每次 load/read 校验 sourceKey/revision，父普通 persona binding 行前后逐字相同。
9. known deny tool names 从当前 registry 可见表构建，不能将不存在的 summon_expert 写进 deny。
10. completed、error、canceled、timeout、empty output、未加载人格全部映射真实结果。
11. 同结果只靠工具返回，不重复 steer；超限标截断。
12. finally dispose、撤销 ticket、释放并发位；子 run.result 拒绝也走相同清理。
13. 开关开启才注册 summon_expert 和 prompt section；关闭 disposer + execute 再读设置守卫。

覆盖 AX-E36–E44、AX-E48–E49。fake provider 是生命周期测试替身，不能用它代替最终真实 SDK/LLM 验收。

~~~powershell
pnpm typecheck
pnpm build
node --test test/expertInvocation.test.mjs test/expertWiring.test.mjs test/personaBinding.test.mjs
~~~

交接：前后绑定记录、加载 ticket 时序、每个失败下 dispose 次数和残留运行计数。

## P7 — @、/expert 与用户手动请求

前置：P6 通过。读 v0.3 §8.3–§8.4。

新增：

- src/experts/command.ts。
- src/client/expertPrompt.ts、src/client/expertInputSource.ts。
- test/expertInputSource.test.mjs、test/expertCommand.test.mjs。

修改 host/client index：只注册/释放；manual-requests HTTP 接口接相同 invocation service。

步骤：

1. 先测纯 ref 编解码和 /expert 第一个分隔符解析；不要用正则模糊匹配显示名。
2. onPick 同步返回 ReferenceInsert，codec 异步创建 request；不得直接启动子代理。
3. serialize 使用 ref 中的 sessionId，不读全局当前会话替换它。
4. HTTP 创建 request 时 sourceKey/revision 变化拒绝，用户重选。
5. /expert handler 取 invocation.agent，steer 含 requestId 和 task；执行仍是 runManual。
6. 注册独立 @ source，不加 matchSpace/Enter、不影响文件引用、不改 /workbench。
7. inputTriggers 缺失时源不注册；/expert 可继续；subagents 缺失时两者真实报能力不足。
8. 热重载注册数始终一份，卸载无异步回调写入失效上下文。

覆盖 AX-E45–E47、AX-E51。

~~~powershell
pnpm typecheck
pnpm build
node --test test/expertInputSource.test.mjs test/expertCommand.test.mjs test/capabilities.test.mjs
~~~

交接：默认 auto=false 仍可手动调用的完整链。

## P8 — 生成、管理、草稿 UI 接线

前置：P7 通过。读 v0.3 §5.4、§9。

新增：useWorkbenchExperts、ExpertCreateModal、ExpertDraftBody；新增 test/expertClientFlow.test.mjs（纯流程依赖注入测试）。

修改：

- WorkbenchRuntime.sessions 增 create 的已核验可选方法形状；没有方法时明确缺能力。
- WorkbenchApp 只装配 hook/modal props；零新业务 state/网络/轮询。
- SettingsModal / PersonaAdmin：列表由 useWorkbenchExperts 拥有；旧 flag patch 的保存语义保留；外部目录仍随“保存设置”保存。
- PersonaPicker 改读 /experts/catalog.personas。
- useWorkbenchAISessions 在 bind 前调同一 preflight，仅增加入口守卫。
- useWorkbenchDrafts / DraftBanner：expert 呈现、version/hash 确认、安装成功刷新回调。

步骤：

1. 生成入口用 sessions.create，不使用旧 connectWorkspace；先取方法论再建会话。
2. 一律 acquireSession/finally release，await 后查 isAlive。
3. 生成 prompt 发失败留草稿/会话，提供打开/继续，不自动归档或新建第二份。
4. 预览修改清 validation，看到的版本不匹配时不自动确认。
5. required 依赖不可用行管理页可见、选择器不可选；原手工角色来源未登记仍可选。
6. toggle auto 保存到服务端真实值；失败回滚界面、显示错误；关掉仍保留手动入口。
7. 更新“工作台从不写角色文件”的旧帮助文字，移除同步类按钮/状态措辞。
8. 与 D17 装配约束和现有 task/knowledge/review 草稿一起回归。

覆盖 AX-E52–E58。

~~~powershell
pnpm typecheck
pnpm build
node --test test/expertClientFlow.test.mjs test/clientInvariants.test.mjs test/capabilities.test.mjs test/draftBannerSessionJump.test.mjs
~~~

交接：具体 UI DOM 入口、错误提示、创建/确认 payload，不能只给截图而缺 HTTP 重读。

## P9 — 完整验证、打包与真实模型链路

前置：P8 通过。本期出口批次。

1. pnpm test 完整回归；新增失败不能通过删老测试消除。
2. tarball 核验 methodology、新 lib、原 persona 和许可都在；不包含 .pending、测试数据、TEMP 证据。
3. 新建 scripts/verify/suites/expert.mjs；用既有 _harness.mjs，登记 suites.json 为 active/required。真实模型独立证据，不新增隐式 skip 白名单。
4. 先 dry-run 隔离研发验收链，核对不是当前实例；再在已有授权的测试范围执行。未知 profile/db 不从猜测值启动。
5. 实际浏览器完成 AX-E52–E58；取 DOM + HTTP + FS/DB 结果。
6. 在隔离实例做一次 original 生成，再做一次能取得 MIT 原件的生成；网络失败记录真实失败，不能将 original 兜底冒充 MIT 取件成功。
7. 同父会话先绑专家 A，再 @ 专家 B：观察 B 子代理调用专用 loader、输出、父绑定保持 A。
8. auto=false 下手动通过；auto=true 下模型自主调用；关闭后 schema/prompt 下一轮消失。
9. 按 verification 的层级记录；没跑真实 LLM 就声明实现检查通过但模型链路未验证。
10. 人工复核后才把 ADR 状态从 proposed 改 accepted；发布另按项目既有授权。

命令：

~~~powershell
pnpm test
node scripts/check-verify-scripts.mjs
# 验收链命令需要实际的独立 profile 目录和 DB，见 verification.md
~~~

覆盖 AX-E59–E62。交接必须包含实际构建 ID、包清单、断言计数、独立实例证据和剩余未验证项。

## 给下一次执行模型的单批提示词

~~~text
请只执行专家功能施工计划的 P<编号>。
先读 docs/tasks/51189a57-04c0-4b8a-811c-945703cc9850-工作台专家功能实现和优化/review-entry.md，
再读 implementation-plan.md 的这一批，以及它指定的方案-v0.3.md 章节。
核对前置批次的真实交接记录，不以文件存在代替检查通过。
按照固定接口和错误行为实现，保留用户已有修改；不要扩大范围或调整方案默认值。
完成本批规定的检查，报告实际退出码、通过的 AX-E 编号和未验证项。
本批结束后停在交接，不自行发布、不重启当前会话实例，也不抢跑下一批。
~~~
