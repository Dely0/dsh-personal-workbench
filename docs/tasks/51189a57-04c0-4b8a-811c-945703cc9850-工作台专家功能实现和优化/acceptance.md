# 专家功能验收清单

状态：规格定义，**以下全部尚未做产品运行验收**。本文件的“通过条件”不是通过记录。记录真实结果请用 verification.md。

依据：[方案 v0.3](方案-v0.3.md)、[施工计划](implementation-plan.md)。

## 1. 断言与责任批次

| ID | 批次/层级 | 输入或触发 | 必须观察的结果 |
|---|---|---|---|
| AX-E01 | P1 / DB | 新库、已有 schema 19 的库执行 seed | 补入 expert 两个字典种子；schema 不变；重复 seed 不覆盖用户配置 |
| AX-E02 | P1 / DB | 设置不存在/坏值/false/true | 缺失与脏值 false；POST 真 boolean 后 GET 一致；其他字段不变 |
| AX-E03 | P1 / DB | 两个请求同 session 建 expert 草稿 | 一个 pending expert；不同用户 request 冲突；不影响 knowledge/task |
| AX-E04 | P1 / DB | 相同旧版本并发更新 | 只有一个成功，另一个版本冲突；不丢新内容 |
| AX-E05 | P1 / FS | ../、UNC、C:/、反斜杠、百分号、NUL、保留名、NFC/大小写碰撞 | 全部拒绝；两个工作台根之外无写入 |
| AX-E06 | P1 / FS | 根/父目录/目标文件为 link 或 junction | 拒绝即使链接目标仍在根内；外部哨兵文件逐字不变 |
| AX-E07 | P2 / parser | 正文 20000/20001 UTF-16 单元；CRLF/BOM/emoji | 20000 通过，20001 明确 oversized-body；计数与现有 parser 一致 |
| AX-E08 | P2 / parser | 白名单外 frontmatter、空正文、超长名称 | 提交失败、旧草稿不损坏；不会放宽 parser |
| AX-E09 | P2 / provenance | translated 无 sources、merged 单来源、MIT 无版权/全文 | 校验失败；null commit 为警告；不得伪造 MIT 核实 |
| AX-E10 | P2 / FS | 许可文本含 CRLF 与原版权 | 保存字节与输入一致；不会翻译/压缩许可 |
| AX-E11 | P2 / tools | 他会话草稿、无真实 session、伪造参数 session | 拒绝；不能改另一份草稿 |
| AX-E12 | P2 / FS | 单件/总量/数量/skill 数越界 | 对应错误；不留下超限正式或暂存有效索引 |
| AX-E13 | P2 / FS | validate 后 stage 改一件文件 | version 增、validation 清空；旧 hash 无法确认 |
| AX-E14 | P2 / skill | invalid YAML、缺 name/description、目录名不符、legacy invocation key | 坏包不可安装；字符串 false 不变成 true；metadata 保留 |
| AX-E15 | P3 / install | 原创无技能草稿确认 | 一个 generated UUID 人格及附件；DB confirmed；ready；catalog 可用 |
| AX-E16 | P3 / install | MIT + 两个 install skill 确认 | 全部许可完整；provider 与人格只在 ready 后可发现 |
| AX-E17 | P3 / install | 同一 confirm 并发/重试 | 同 expertId/confirmResult；不多写专家或技能 |
| AX-E18 | P3 / install | 不同 hash 同名 skill 已存在 | 冲突、旧 skill 字节不变；不能静默覆盖 |
| AX-E19 | P3 / install | 同完整 hash 的 ready skill 已存在 | 明确复用；补偿不删除共享 skill |
| AX-E20 | P3 / recovery | 任一 FS 发布点失败，DB 未 confirmed | 没有可发现入口；仅补偿本次拥有的路径；原暂存仍可重试 |
| AX-E21 | P3 / recovery | DB COMMIT 后 publication 前中断 | 新实例恢复 ready；重复确认幂等；不能回滚已确认数据 |
| AX-E22 | P3 / recovery | 外部修改已发布文件、两个 journal 都坏、其他 DB 的 journal | repair-required 或跳过他 DB 日志；不覆盖/删除用户变化或他 profile 文件；其余工作台正常 |
| AX-E23 | P3 / lock | 活 owner、死 owner、owner 状态不明 | 活锁拒绝、死锁可回收、不明不强删；不释放别人的锁 |
| AX-E24 | P4 / provider | 未 ready 的技能包、隐藏目录、坏包 | 不进入 list/get；诊断可读；其余包仍可见 |
| AX-E25 | P4 / SDK | 用户 rank 400 与工作台同名 600 | 用户胜出，实际 provider/source 可见；无 runtime register 下载技能 |
| AX-E26 | P4 / SDK | scoped 与 global 同名技能 | 最近 scope 层按 SDK 获胜；真实调用传 scopeOf(parent.ctx)/cwd |
| AX-E27 | P4 / provider | list 后内容变化，再 get 旧 candidate | undefined + invalidate；不偷换内容；刷新得到新候选 |
| AX-E28 | P4 / provider | 安装完成但注册表先有缓存 | invalidate 后立即发现新技能，重启不是必要条件 |
| AX-E29 | P4 / catalog | 格式坏/停用/required 缺失/旧来源未登记 | 管理页都有行与准确状态；不可用不进入 personas；旧未登记仍可用 |
| AX-E30 | P4 / catalog | skills 服务缺失、可选技能缺失 | 必需依赖不可用；可选缺失 warning；核心工作台/无依赖人格仍可用 |
| AX-E31 | P5 / HTTP | 非回环、跨站、坏 JSON、超 body | 使用既有围栏拒绝；无绝对路径泄露或第二套 HTTP 围栏 |
| AX-E32 | P5 / HTTP | 旧 version/hash confirm | 409；刷新前不安装用户尚未看过的新内容 |
| AX-E33 | P5 / HTTP | expert confirm 后再次 confirm | 回放 expert 字段；旧任务 kind 返回保持原契约 |
| AX-E34 | P5 / tools | 生成工具接口只到 validate | pending 草稿；没有提供给模型的确认工具；正式根未发布 |
| AX-E35 | P5 / abandon | pending 放弃、installing 放弃 | 前者 abandoned + 只清自己的暂存；后者 409；其他草稿不受影响 |
| AX-E36 | P6 / invocation | auto=false 的有效 manual request | 能启动独立专家子代理；不是改父绑定 |
| AX-E37 | P6 / invocation | request 超时/跨 session/同 request 不同 task | 明确拒绝；同 request 同 task 只 start 一次 |
| AX-E38 | P6 / lifecycle | fake start 返回前执行 child loader | loader 正确 claim；returned run.id 一致；无需“返回后再绑” |
| AX-E39 | P6 / authority | 父/普通会话/其他父 child/第二个 child 用 ticket | 全部拒绝；合法 child 可读；结束后 ticket 失效 |
| AX-E40 | P6 / revision | 运行中角色改文或切外部来源 | load/read 拒绝新 revision/source；父绑定记录完全不变 |
| AX-E41 | P6 / lifecycle | error/canceled/timeout/start reject/result reject | 真实 stop reason、清理完成；无运行/ticket/并发位残留 |
| AX-E42 | P6 / output | output 空、未加载人格、文本 >12000 | 不算成功；超限显式 truncated；有真实 childSessionId |
| AX-E43 | P6 / policy | 专家 child 再召唤或写专家草稿 | deny + 服务守卫拒绝；不向不存在的工具名应用 deny |
| AX-E44 | P6 / concurrency | 父已有一个/实例已有两个活跃调用 | expert-busy；完成后位释放；不隐式排队或重复扣费 |
| AX-E45 | P7 / input | @ 文件与 @ 专家并存 | 两个独立 source；选专家同步生成 insert；codec 异步成功序列化 |
| AX-E46 | P7 / input | source 缺失、身份变动、跨会话复制、HTTP 失败 | 无隐藏成功；serialize 失败保留输入/阻止发送；/expert 降级可用 |
| AX-E47 | P7 / command | 无参、缺分隔符、缺任务、显示名而非 ID、合法命令 | 返回明确帮助/错误；合法只 steer 同一 request 路径；/workbench 不变 |
| AX-E48 | P6 / auto | 设置 off → on → off | summon_expert schema/自主 prompt 按开关出现/消失；关闭后新启动拒绝 |
| AX-E49 | P6 / SDK | 缺 spawn、fork/remote-only、scope helper 缺失 | 不猜 API；中途召唤或 required scope 预检明确不可用；面板不 pending |
| AX-E50 | P5 / wiring | 装配与设置 GET/POST、普通 load preflight | 一份 service/state；生产注入依赖 preflight；顶层 inject 完全不变 |
| AX-E51 | P7 / lifecycle | 热重载/卸载 3 轮 | source/command 只有一份；无 inactive context 写入；disposer 完整 |
| AX-E52 | P8 / client | 新建专家点击、连点、已存在 blank 会话 | sessions.create 新身份；不调用 connectWorkspace 或复用当前/blank |
| AX-E53 | P8 / client | create/acquire/generation-start/prompt/open 任一失败 | 可读错误；release；已有会话不被误删除；草稿可继续 |
| AX-E54 | P8 / browser | editing、validated、installing、install-failed 草稿 | 正确按钮/内容；确认发送所见 version/hash；无“创建任务”假文案 |
| AX-E55 | P8 / browser | 看预览后 AI 又改版本 | 旧确认 409、刷新；不替用户自动确认新内容 |
| AX-E56 | P8 / browser | 安装成功、刷新、required 缺失、坏文件 | 列表重读真实状态、技能实际 provider；不可用原因可见 |
| AX-E57 | P8 / browser | 开关保存失败、外部目录改动、收藏/停用 | 开关回滚并显示错；外部目录保存规则和 flag 立即保存保留 |
| AX-E58 | P8 / regression | task/knowledge/report/review 草稿与普通 persona | 旧确认、提醒、选择、绑定不回归；WorkbenchApp 不接业务 state/请求 |
| AX-E59 | P9 / package | 新 tarball 解包检查 | 有方法论/新 lib/旧 personas/license；无 .pending、用户数据、TEMP |
| AX-E60 | P9 / real LLM | 独立会话原创专家生成 | 实际生成工具提交、校验；用户确认前正式库为空 |
| AX-E61 | P9 / real LLM | 父绑定 A，用户 @ B 且 auto=false | 实际 run request → B child loader → B 结果；父仍 A |
| AX-E62 | P9 / real LLM | auto=true 自主调用后关闭再发一轮 | 实际自主工具调用、真实结果；下一轮关闭后无 schema/prompt |

## 2. 最低夹具

1. original 无技能人格：用于隔离安装流程，不依赖公网或真实模型。
2. MIT 单源改写人格 + 完整版权/许可原文 + 一个 scripts/reference 文本包。
3. 多源人格：两个来源、两个许可；一份来源许可缺失的负例。
4. 三层同 ID：用户/外部/内置；另有无效用户文档与同名显示名不同 ID。
5. 同名 rank 400 用户技能、rank 600 工作台技能、不同 scope 的 winner。
6. 多故障点的 install journal、两个不同 hash 的同名技能、复用技能。
7. 普通 parent 与已存在 subagent parent，含有效/非法 delegationDepth/subagentDepth。
8. 同步抢先执行 loader 的 fake provider、取消/拒绝/空输出/超限输出 provider。

所有 copyright/license 夹具来自已确认许可原文；不在 fixture 中伪造上游 commit 为事实。UUID/SHA 测试占位值明确是合成测试数据。

## 3. 出口与失败记录

- 每行记录 pass / fail / unverified / blocked、命令、退出码和证据路径，不以“文件写好了”代替 pass。
- 单元通过只能覆盖其层级。真实 SDK 和真实模型断言必须分别有证据。
- 正式功能验收不允许把 AX-E60–E62 的未运行当作通过；环境缺失时可以交付实现供审阅，但说明未完成模型链路验证。
- 测试故障恢复不可只检查错误字符串，还要重读 DB、FS、discovery 和 provider。
- 浏览器验收不可只看 toast，必须 GET 重读真实状态并核对安装文件。
- 发布前按项目现有用户验收规则执行，不新增“自动发布成功”的出口。
