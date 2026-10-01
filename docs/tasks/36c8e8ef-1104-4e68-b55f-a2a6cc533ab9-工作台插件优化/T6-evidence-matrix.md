# T6 证据矩阵：45 个 AX + 43 个 LEG

任务 `cd8aa5f0-3f7f-4be0-939b-b3f38a9387e2`（T6｜完成本轮集成回归与验收交接）；2026-10-01。

**这份矩阵只写实测结果，不写"应该通过"。** 每行给：判据 → 落在哪个测试/套件 → 实际命令 → 实测结果。
命令的完整输出与截图在 `test-results/workbench-verify/<runId>/`（gitignored）+ 各套件目录。

状态口径：
- **✅ 通过**：本轮有实际命令与退出码/断言计数。
- **⚠️ 未验证**：本轮**没有**证据（写清原因，不得当作通过）。
- **⛔ 阻塞**：缺前置（隔离环境/模型/授权），已如实报告。

---

## 0. 本轮整体命令（真实执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 退出码 0 |
| `pnpm build` | 退出码 0；`lib/build-info.json` 的 `buildId` = `wb-34aff1a8a9994230` |
| `pnpm test`（全套，含 build） | 见 §3（逐条列出失败项与归因） |
| `node scripts/check-verify-scripts.mjs` | 退出码 0；动态统计 现役 8 / 待迁移 0 / 作废 3 / 本地脚本 150 / 嫌疑 22 |
| `node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web --profile-dir <web> --db-path <verify-web.db>` | 见 §2（AX-V10 的真实链运行） |
| `node --test test/verifySafety.test.mjs test/devVerify.test.mjs test/verifyManifest.test.mjs test/verifyBrowser.test.mjs` | 退出码 0（自锁/白名单/脱敏/编排的唯一防线） |

---

## 1. 45 个 AX

### 1.1 任务进度（§2）

| ID | 层 | 判据落点 | 实测 | 备注 |
|---|---|---|---|---|
| AX-P01 | U | `test/db.test.mjs`（T1） | ✅ | 18→19 迁移、progress 全 0、重复 migrate 无变化、CHECK 拒 100 |
| AX-P02 | U/H | `test/progress.test.mjs`、`test/tools.test.mjs`（T1） | ✅ | 0/25/75/99 合法；非法值不夹取；同值不写事件 |
| AX-P03 | H | `test/tools.test.mjs`（T1） | ✅ | 100 只建/更新 completion 草稿；progress 保持 75、status 保持 doing |
| AX-P04 | H | `test/tools.test.mjs`（T1） | ✅ | 缺 summary / consult / 归档 / 已完成 / 已取消全部拒绝且无部分写入 |
| AX-P05 | H | `test/routes.test.mjs`、`test/progressWiring.test.mjs`（T1） | ✅ | 多字段 PATCH 原子拒绝；PATCH 100 拒绝；界面 100 走完成动作 |
| AX-P06 | H | `test/db.test.mjs`、`test/routes.test.mjs`（T1） | ✅ | 暂存/驳回不回退；通过后 done 且保留原 progress；级联不改显式值 |
| **AX-P07** | **B** | **`scripts/verify/suites/progress.mjs`（T6）** | **✅** | 真实鼠标点击 25% → 接口重读 25 + DOM 同步；刷新后仍一致；done 隐藏进度条；**逐态截图** |
| **AX-P08** | **U/B** | `test/progressWiring.test.mjs`（T1）+ **`suites/progress.mjs`（T6）** | **✅** | 子任务旁证「1/2 已完成（另 1 已取消）」且父进度仍是显式值；生成物里提示词含"主动报进度"与"100 不是直接完成"、硬拦仍在 |

### 1.2 每日计划与投入结束（§3）

| ID | 层 | 判据落点 | 实测 | 备注 |
|---|---|---|---|---|
| AX-D01 | U/H | `test/db.test.mjs`、`test/tools.test.mjs`（T2） | ✅ | minutes 1/90/1440 合法；0/1441/小数/字符串整份拒绝；省略取估时/设置默认 |
| AX-D02 | U | `test/db.test.mjs`、`test/capacity.test.mjs`（T2） | ✅ | 旧 JSON 回填快照；未知 taskId 保留；坏 JSON 原串保留 + 诊断 + 容量"不可计算" |
| AX-D03 | H | `test/tools.test.mjs`、`test/routes.test.mjs`（T2） | ✅ | 草稿取 90 后改估时 600 仍 90；省略 minutes 保留；备注不丢字段 |
| AX-D04 | H | `test/db.test.mjs`、`test/tools.test.mjs`、`test/routes.test.mjs`（T2） | ✅ | 重复 taskId/父子同链/关闭归档/未知任务拒绝；兄弟叶子允许；AI 传 effortDone 报错 |
| AX-D05 | H | `test/routes.test.mjs`（T2） | ✅ | 只改目标项；同值幂等；结束不改 sourceCode，分钟修改为 manual |
| AX-D06 | H | `test/routes.test.mjs`（T2） | ✅ | 404/400 区分；过去只读、未来不得结束；PUT 省略保留；DELETE 清空 |
| **AX-D07** | **B** | **`scripts/verify/suites/daily-effort.mjs`（T6）** | **✅** | future-due doing 长任务今天排 90 → 真实点「今日投入结束」→ 显示已结束 → 刷新仍 true；接口重读 task 仍 doing、进度/截止/估时未变 |
| **AX-D08** | **B** | **`suites/daily-effort.mjs`（T6）** | **✅** | 只出现显式 25/50/75 建议、未点不变；点 50% 只写 progress 不动状态；「推迟截止一天」只改 dueAt（+1 天）不转移计划项 |
| **AX-D09** | **H/B** | `test/db.test.mjs`（T2）+ **`suites/daily-effort.mjs`（T6）** | **✅** | 刷新后仍"今日投入已结束"；点「继续投入」接口与 DOM 一起回到 false |

### 1.3 候选池与容量（§4）

| ID | 层 | 判据落点 | 实测 | 备注 |
|---|---|---|---|---|
| AX-C01 | U | `test/dailyPlanPolicy.test.mjs`（T2） | ✅ | 表驱动：due 当日/继承/未来 doing/blocked 无截止/已有计划/逾期开关/归档/坏 due/DST |
| **AX-C02** | **U/B** | `test/dailyPlanPrompt.test.mjs`（T2）+ **`suites/daily-effort.mjs`（T6）** | **✅** | 31 条截断提示含"另有 N 条"；**B 层：容量条读数 == 同一时刻服务端计划项合计** |
| AX-C03 | U | `test/capacity.test.mjs`（T2） | ✅ | 无计划 0 但未排 10；90+60=150；结束/done 不自动减 |
| AX-C04 | U | `test/capacity.test.mjs`（T2） | ✅ | 未来截止/归档/取消/删除仍以持久 minutes 计；坏 JSON 不可计算 |
| **AX-C05** | **H/B** | `test/routes.test.mjs`（T2）+ **`suites/daily-effort.mjs`（T6）** | **✅** | 一键排入走 POST 原子追加并即时重读；重复 taskId added=false；并发追加两项都在 |
| **AX-C06** | **W/B** | `test/capacityWiring.test.mjs`、`test/capacityPanel.test.mjs`（T2）+ **`suites/daily-effort.mjs`（T6）** | **✅** | 三处共用 `dailyPlanPolicy`；**B 层容量与页脚文案跟服务端合计一致**；`includeOverdue` 只影响候选 |

### 1.4 角色库与会话（§5）

| ID | 层 | 判据落点 | 实测 | 备注 |
|---|---|---|---|---|
| AX-R01 | U | `test/personaParse.test.mjs`（T3） | ✅ | H1/引用块/跨行简介/frontmatter 标量/UTF8·BOM·CRLF/160·20k 边界；parser 零 FS/React/DOM |
| AX-R02 | U/H | `test/personaLibrary.test.mjs`（T3） | ✅ | 三级来源优先级、同名不同 ID 并存、README/隐藏/链接/附件排除、超限诊断 |
| AX-R03 | H | `test/routes.test.mjs`、`test/personaLibrary.test.mjs`（T3） | ✅ | 外部根无权限只禁用该来源；settings GET/POST 同形状；摘要不含正文/绝对路径 |
| AX-R04 | H | `test/personaBinding.test.mjs`、`test/personaWiring.test.mjs`（T4） | ✅ | 绑定先于 prompt；scope=persona 不覆盖 daily_plan；幂等/409；工具只按 exec.sessionId |
| AX-R05 | H | `test/personaBinding.test.mjs`（T4） | ✅ | 正文改动后 hash 不符拒绝旧绑定；源丢失明确报错**不切其他来源**；资源工具先验 revision |
| AX-R06 | U/H | `test/personaLibrary.test.mjs`（T3） | ✅ | `../`/绝对/UNC/盘符/大小写/编码/NUL/link/junction/二进制/坏 UTF8/超限全拒 |
| **AX-R07** | **W/B** | `test/personaWiring.test.mjs`（T4）+ **`suites/persona.mjs`（T6，B 层）** + **⚠️ 模型层** | **⚠️ 部分** | W 层：10 个 mode 同一选择路径、未选角色提示逐字不变 ✅（T4）。B 层：**真实鼠标打开「快速录入」→ 选择器三态渲染 → 点具体角色 → 选中态与"当前"标签同步** ✅（T6，有截图）。**M 层（模型真的调用 `workbench_load_persona` 并用到正文）本轮未验证** —— 见 §4。 |
| **AX-R08** | **H/B** | `test/aiSessionReuse.test.mjs`、`test/packageManifest.test.mjs`（T4）+ **`suites/persona.mjs`（T6，H 层）** | **✅** | 同 role 沿用/换 role 新建、归档会话新建（T4 单测）；**T6 真实 HTTP：包内 6 篇可发现、首次绑定 201、重复幂等 200 created=false、换角色 409、读回 revision、不存在的角色明确拒绝、资源越界 400** |

### 1.5 验收链与安全（§6）

| ID | 层 | 判据落点 | 实测 | 备注 |
|---|---|---|---|---|
| **AX-V01** | **U/N** | `test/verifyManifest.test.mjs`、`test/verifySafety.test.mjs` + **`suites/verify-safety.mjs`（T6）** | **✅** | checker 真跑退出码 0、动态统计（150/22/8/3）；白名单 8 套 active 文件全在；未声明脚本硬失败；不删脚本 |
| **AX-V02** | **U/N/B** | `test/verifyBrowser.test.mjs` + **`suites/verify-safety.mjs`（T6）** | **✅** | **真实起两个独立调试实例**：CDP 端口不同、user-data-dir 不同、页面求值可用、close 清掉自己目录；30s 调用超时；覆盖路径不可执行报错 |
| **AX-V03** | **N** | `test/verifySafety.test.mjs` + **`suites/verify-safety.mjs`（T6）** | **✅** | 同端口 `--force` 仍拒；缺/非法 `DSH_WEB_URL` 拒；非 3080-web 拒；零副作用；**真实端口归属校验认得出 3080 就是 dsh web 的 node 进程** |
| **AX-V04** | **N** | `test/verifySafety.test.mjs`（含真子进程）+ **`suites/verify-safety.mjs`（T6）** | **✅** | 同 realpath profile/DB 拒；继承 desktop `DSH_PROFILE_DIR` 不许传给 web 安装；`WORKBENCH_PROFILE_DIR` 一致 |
| **AX-V05** | **N** | `test/verifySafety.test.mjs`、`test/devVerify.test.mjs` + **`suites/verify-safety.mjs`（T6）** | **✅** | 未显式独立 DB 配置/与当前同库/配置不可知全拒；仅 `--db-path` 不冒充隔离；**dry-run 零写入（证据目录数不变）**；目标库 schema=19 而正式库仍 18 |
| **AX-V06** | **N** | `test/devVerify.test.mjs` + **`suites/verify-safety.mjs`（T6）** | **✅** | 逐阶段注入失败后阶段不跑；装前后版本门禁；**真实 dry-run 退出码 0** |
| **AX-V07** | **N/B** | `test/devVerify.test.mjs` + **`suites/verify-safety.mjs`（T6）** | **✅** | health200 旧构建拒；超时非 0 带阶段名；缺套件/空计数/required skipped 不通过；**真实 health.buildId == 本地 `lib/build-info.json`** |
| **AX-V08** | **N** | `test/devVerify.test.mjs` + **`suites/verify-safety.mjs`（T6）** | **✅** | token 形状（URL 参数/`token=`/Bearer）全脱敏；**真实证据目录全树扫不到本次 token 原串** |
| **AX-V09** | **N** | `test/devVerify.test.mjs`（+ T6 修 `finally`/`catch` 语义） | **✅** | 套件 180s 超时退出 3；断言失败退出 1；自锁退出 2；`finally` 不覆盖失败为 0；只清本次临时目录 |
| **AX-V10** | **B** | **`node scripts/dev-verify.mjs …`（T6 真实运行）** | 见 §2 | 独立测试实例实跑旧四套+新增套件；各套非零计数；截图/接口重读与 summary 一致；当前 19387 未重启、正式库未改 |

### 1.6 不变量与反向变异（§7）

| ID | 断言 | 反向变异实测 | 状态 |
|---|---|---|---|
| AX-G01 | AI 工具不能直接 done/cancelled，100 只走 completion | T1 三条变异（拆 done 硬拦/去掉 100 拒绝/去掉路由校验）全红并恢复 | ✅ |
| AX-G02 | 三处候选共用唯一纯函数 | T2 变异（手动池改回旧过滤）变红并恢复 | ✅ |
| AX-G03 | 同端口/目录/DB 自锁 fail-closed | T5 五条变异 + **T6 新增一条（`ConvertTo-Json -Compress` 输出非法 JSON → 归属校验说不出话）** | ✅ |
| AX-G04 | persona 资源不能跨绑定根读；套件不能吞错报绿 | T3/T4 资源边界变异；T5 六种"不绿"注入；**T6 实测 6 个假红全部定位到判据/环境而不是放宽**（见 §5） | ✅ |

---

## 2. AX-V10：真实链运行

| 项 | 实测 |
|---|---|
| 命令 | `node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web --profile-dir "C:\Users\Administrator\.dsh\profiles\web" --db-path "C:\Users\Administrator\.dsh\workbench\verify-web.db"` |
| **runId（正式证据）** | `20261001-003218-0a5956` |
| 退出码 | **1** —— 因为 `persona` 的必需套件有 1 项 skipped（模型层未验证），这是**设计好的行为**：链宁可不绿，也不许把"没验到的那一层"写成通过 |
| 证据 | `test-results/workbench-verify/20261001-003218-0a5956/`：`summary.json`、`summary.md`、`suite-*.json`、8 个 `suite-*/` 目录、**39 张截图** |
| 目标库 | `verify-web.db`，`schema_version = 19`、`taskCount` 为本次 runId 合成数据（不是正式库的 94 条） |
| 正式库 | `~/.dsh/workbench/workbench.db` **仍 schema 18 / 94 条任务**（运行前后各测一次） |
| 当前 GUI（19387，pid 17564） | **未重启、未 kill、未改**（CreationDate 仍是 2026-09-30 22:25:24） |
| 三方构建标识 | 包 `wb-34aff1a8a9994230` == host `health.buildId` == 浏览器 `.wb-panel-host[data-workbench-build-id]`（`clientMatched: true`） |
| 脱敏 | `secretsRegistered: 1`；全树 61+ 个证据文件扫不到 token 原串 |
| 各套件断言 | 见下一表 |

| 套件 | passed | failed | skipped | total | 退出码 |
|---|---|---|---|---|---|
| verify-safety | 20 | 0 | 0 | 20 | 0 |
| legacy-acceptance | 18 | 0 | 0 | 18 | 0 |
| legacy-final-2 | 9 | 0 | 0 | 9 | 0 |
| legacy-sidebar-collapse | 6 | 0 | 0 | 6 | 0 |
| legacy-duplicate-task | 11 | 0 | 0 | 11 | 0 |
| progress | 13 | 0 | 0 | 13 | 0 |
| daily-effort | 13 | 0 | 0 | 13 | 0 |
| persona | 12 | 0 | 1 | 13 | 0 |
| **合计** | **102** | **0** | **1** | **103** | — |

> **persona 的 1 条 skipped 是模型层（AX-R07 的 M 层）**。
> `legacy-acceptance` 是 17 个 LEG + 1 条额外判据（三方构建标识的浏览器那一脚，AX-V07），所以是 18。
> 43 个 LEG 全部有实际断言：17 + 9 + 6 + 11 = 43。

---

## 3. `pnpm test` 全套

| 项 | 值 |
|---|---|
| 命令 | `pnpm test`（内含 build） |
| 结果 | 见运行记录（tests / pass / fail 计数） |
| 失败项 | `test/db.test.mjs` 清理期 `rmSync` EPERM（Windows 上 SQLite 句柄尚未释放）—— **T1 起每轮都在**，已用 `git checkout` 回基线复现，与本轮改动无关；**未删断言、未跳过** |

---

## 4. 未验证 / 阻塞（不得当作通过）

| 项 | 状态 | 原因与解除条件 |
|---|---|---|
| AX-R07 的 **M 层**：真实模型调用 `workbench_load_persona` 并返回角色正文 | ⚠️ **未验证** | 验收链的目标实例是测试实例，套件进程**没有**向 DSH 宿主投递用户消息的能力（宿主没有对外的"新建会话并发送消息"HTTP 端点；会话记录是 zstd 压缩，无法按文本扫描）。绑定/加载语义已用真实 HTTP 证明。解除条件：用户在自己的正式实例上开一次带角色的 AI 会话，观察工具调用。 |
| LS-Skills 九篇在公司外部根下、经 `personaExternalDir` 的**浏览器**可发现性 | ⚠️ **未验证** | 本轮没有改用户的设置（改设置属于运行环境变更，需用户确认）。T3 已用只读探针证明九篇可解析（4999–8145 字），但"配进设置后浏览器能选到"没跑。 |
| 桌面端（19387）装本轮构建后的实际体验 | ⛔ **不在本轮范围** | T6 只在**测试实例 3080** 上验收，正式实例的实测是用户的上线判定，本项不负责公开发布、不改公开版本号。 |
| `pd`/POSIX 上的自锁与端口归属 | ⚠️ **未验证** | `findPortOwner` 非 Windows 一律拒绝（宁可拒绝不猜着杀进程）；本轮只在 Windows 上跑过。 |

---

## 5. 本轮真实抓到的缺陷（都是"假绿/假红"级别的）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 链的 `restart` 阶段报 ok，但 health 永远等不到 | `spawn(..., { detached: false })` + `unref()` 在 Windows 上不会让被拉起的实例活下来（编排退出时一起消失） | `detached: true` + `windowsHide: true` + `unref()` |
| 2 | token 阶段必然 60s 超时 | 拉实例走 `dsh.cmd`（多一层 cmd.exe），**stdout 落不进日志文件**；且 `dsh` 会回退到 PATH 上的那个 | 改成直接 `node <dsh>/lib/bin.js web --port …`；`resolveDshCommand` 找不到就**明确失败** |
| 3 | 端口归属校验"说不出话"，进程却照样被拉起 | PowerShell `ConvertTo-Json -Compress` 输出 `{none:true}`——**不是合法 JSON**；解析失败后错误路径继续往下启动 | 脚本落成 `.ps1` 文件跑（不做内联转义）+ 整体解析 JSON + 不用 `-Compress`；新增测试钉住 |
| 4 | 套件在桌面端会话里跑链时，目标被推成 `desktop`，预检报 `TARGET_OUT_OF_SCOPE` | 套件从环境变量推"目标 profile"，而环境变量描述的是**当前会话** | `runSuiteProcess` 显式传 `target: { profile, profileDir, dbPath }`；套件里"当前"与"目标"变量分开 |
| 5 | `mkdtempSync` ENOENT：浏览器起不来 | `mkdtemp` 要求父目录已存在，而链传的 `--user-data-root` 是本次 runId 下的新目录 | 起浏览器前 `mkdirSync(tmpRoot, { recursive: true })` |
| 6 | `check-verify-scripts.mjs --json` 的输出解析失败 | 那是**多行**美化 JSON，套件按"取最后一行"解析，拿到 `}` | 从第一个 `{` 起整体解析 |
| 7 | `harness.mjs` 被 checker 判成"未声明的套件脚本" | 共享脚手架与套件同目录 | 按 checker 既有约定改名为 `_harness.mjs`（下划线 = 共享件） |
| 8 | 三条判据假红：容量绝对值、中心观测点 `^wb-`、done 任务的进度徽标 | 判据写得比语义更死：容量数会被库里其他任务影响；面板 DOM 现在多一层（中心叶子是**无 class** 的布局 DIV） | 容量改成"DOM 读数 == 同一时刻服务端合计"；中心观测点沿父链找最近带 class 的祖先；done 判"隐藏进度条"而保留终态徽标 |
| 9 | **链自己读到了 token、health 也过，浏览器却停在"authentication required"** | **链按"启动前日志长度"往后读 token，而 `dsh web` 起来会截断日志** → offset 失效、读到的是**上一次启动**的 token。欺骗性极强：health 用 `Bearer` 打 API 照样 200（loopback 本来就通），只有浏览器判据红，而红的是"侧栏没有工作台入口" | 改成取**整份日志里最后一个** token（`extractLatestToken`），并且拿到后**真的用它认证一次**（`verifyTokenWorks`）；两条都有单测钉住 |
| 10 | 三方构建标识的 `client` 永远是 `null` | 链在 health 阶段就读套件产物，而 `suite-legacy-acceptance.json` 要到**套件跑完**才有 | 改成在 `suites` 阶段之后、**写证据包之前**补读；且成功路径与 `finally` 落盘路径都要补（本轮真跑的失败正好走后者） |
| 11 | 一样代码两次真跑，一次 17/17、一次 16/17 | 等页面就绪的条件太松（只等 `.wb-panel-host` 出现，而它早于宿主侧栏渲染） | 四个套件统一改成"等**可见入口**出现"（45s 上限 + 超时后打印快照），失败原因不再指向错误的地方 |
| 12 | `test/devVerify.test.mjs` 把**机器状态**当判据（"本机 web profile 没有独立 DB 配置"） | 那是在断言"这台机器此刻的配置"，不是代码行为；T6 配好隔离库后它必然假红 | 改成"预检结论必须与**读到的实际配置**一致"：声明了隔离就放行、没声明就拒绝（两侧都真实读配置） |

---

## 6. 改动清单与运行环境变更

### 6.1 与 T5 交接的差异

| T5 交接写的 | T6 实测 |
|---|---|
| `restartTarget` 的 kill→重启通路"没跑过" | 跑了；**发现 4 个真缺陷**（§5 的 1、2、3、9）。T5 明确要求 T6 把这里当"首次验证"，这一步的价值就在这里 |
| 8 套套件"一份都没迁入" | 8 套全部迁入并 active；一轮真跑 **102 条断言通过**（43 LEG 全绿 + 59 条新功能/安全断言） |
| dry-run 在本机退出码 2"是正确行为" | 给 web profile 配了独立 `dbPath` 后 dry-run 退出码 0，真实链一路跑到 `suites` 阶段 |
| `--launcher` 默认不走 launcher | 维持（仍是"显式给才用，否则内置 node 拉起"） |
| persona 套件"必须观察到真实工具调用" | 实现成 M 层；本机拿不到就 `skip`，链因此**故意退出码 1** |

### 6.2 文件清单

| 改动 | 文件 |
|---|---|
| 套件共享脚手架（结果收集/API/合成资产/浏览器/证据） | `scripts/verify/suites/_harness.mjs`（新） |
| 旧四套迁移 | `scripts/verify/suites/legacy-{acceptance,final-2,sidebar-collapse,duplicate-task}.mjs`（新） |
| 新四套 | `scripts/verify/suites/{progress,daily-effort,persona,verify-safety}.mjs`（新） |
| 白名单激活 8 套 + 顺序 | `scripts/verify/suites.json` |
| 端口归属探测（`.ps1` 文件版，去 `-Compress`） | `scripts/verify/runtime.mjs` |
| 重启用 `detached: true`；直接 `node bin.js` 而非 `dsh.cmd` | `scripts/verify/runtime.mjs` |
| token 取最后一个 + 真实认证校验 | `scripts/verify/runtime.mjs`、`scripts/dev-verify.mjs` |
| 套件目标显式传参（`target`），不再从环境变量推 | `scripts/verify/runtime.mjs`、`scripts/dev-verify.mjs` |
| 三方标识的浏览器那一脚（补读 + 两处落盘路径） | `scripts/dev-verify.mjs` |
| `mkdtemp` 前建父目录 | `scripts/verify/cdp.mjs` |
| 项目级 skill 新增 §14「研发版本验收链」 | `.dsh/skills/dsh-plugin-change/SKILL.md` |
| README 新增「研发版本验收链」入口 | `README.md` |
| 判据随实现同步（不是放宽，见 §5） | `test/verifySafety.test.mjs`、`test/devVerify.test.mjs` |
| 本矩阵 | `docs/tasks/36c8e8ef-…/T6-evidence-matrix.md`（新） |

### 6.3 运行环境变更（经用户明确授权，只动测试实例）

`~/.dsh/profiles/web/cordis.patch.yml` 给 `personal-workbench` 加
`config.dbPath = C:/Users/Administrator/.dsh/workbench/verify-web.db`。
备份：`cordis.patch.yml.bak-verifyiso-20260930-234851`（同一时间戳另备份了 `package.json` / `pnpm-lock.yaml`）。

**桌面端 profile 与正式库一个字节都没动；19387 未重启（pid 17564，CreationDate 未变）。**
回滚方式：删掉那条 patch 条目 → 恢复 `.bak-verifyiso-*` → 重启 3080（走 `dsh-safe-plugin-ops` 门禁）。

