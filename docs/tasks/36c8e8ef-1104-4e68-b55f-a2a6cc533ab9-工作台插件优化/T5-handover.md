# T5 交接：建立隔离的研发验收链（V01–V04 + V04-B / P1-1、S15、S16）

任务 `5f764142-9ed4-435a-9592-9052eced38eb`；2026-10-01。

- 权威规格：`requirements.md` §7（R-V）、`plan.md` V01–V04/V04-B、`acceptance.md` AX-V01–V09/AX-G03/AX-G04（吞错部分）、`legacy-regression.md`、`docs/adr/0006-dev-verify-chain.md`
- 前置：T1–T4 已交付（共享契约冻结）。本项**不依赖** T2–T4 的实现，但读它们的交接以确认不冲突。
- **没有新增迁移**（`SCHEMA_VERSION` 仍是 19，T1 用掉的），没有新表，没有改公开版本号，没有装盘、没有重启任何实例、没有动正式 DB、没有 `git commit`。

---

## 1. 一句话结论

研发验收链已经**落到仓库里、可单测、可 dry-run**，并且**在本机当前状态下被自己的预检正确地挡住了**——
因为 `web` profile 的实际配置里没有独立 `dbPath`/`dataDir`，它会用与桌面端**同一个物理库**，
而本次开发树的 schema 是 19、那个库里是 18（94 条真实任务）。真跑必须等用户确认隔离配置（见 §9）。

---

## 2. 交付物

| 文件 | 角色 |
|---|---|
| `scripts/check-verify-scripts.mjs`（新） | V01 脚本卫生 + 现役白名单校验。**不删脚本**、关键词只标嫌疑、统计动态生成、命中项可插幂等警告头 |
| `scripts/verify/suites.json`（新） | 白名单：8 套（4 套历史 LEG 回归 + 4 套 S17-N 新增）全部登记为 `pending-migration`，加 3 条 `deprecated`（T2 标过时的 repro 脚本，禁入链） |
| `scripts/verify/browser.mjs`（新） | V02 浏览器发现：`DSH_VERIFY_BROWSER` 优先（不可执行就报错，不静默换），否则按平台候选发现，找不到就把**探测过的路径全列出来** |
| `scripts/verify/cdp.mjs`（新） | V02 零依赖 CDP（从 `.pwtest/cdp.mjs` 搬进仓库）：**独立 `user-data-dir` + 独立 CDP 端口**、单次调用 **30s 超时**、`close()` 只关自己起的实例（browser 端点 `Browser.close` → `child.kill` → 删自己的临时目录） |
| `scripts/verify/safety.mjs`（新） | V03 **只读**自锁预检（源码里连子进程模块都不 import）+ `STAGE_PLAN` + 目标 patch 的实际配置读取 |
| `scripts/verify/evidence.mjs`（新） | V04 证据包：runId、`summary.json`/`summary.md`、**所有写盘路径强制 redact** |
| `scripts/verify/runtime.mjs`（新） | V04 真实副作用实现：命令执行/HTTP/日志按 offset 读/token 提取/**端口归属校验后只 kill 那一个 pid**/重启/读装盘产物/跑套件 |
| `scripts/dev-verify.mjs`（新） | V04 链编排（全部依赖注入，可故障注入）+ CLI + 退出码 |
| `scripts/build-info.mjs`（新） | V04-B 构建标识：`sha256(相对路径+内容哈希)` 前 16 位，写 `lib/build-info.json`（**不含时间戳**） |
| `tsdown.config.ts`（改） | 把 buildId 内联进 bundle 最外层：`globalThis.__WORKBENCH_BUILD_ID__ = "wb-…"` |
| `src/client/buildId.ts`（新） | 客户端只读那个内联值（纯函数 + `'unknown'` 兜底），**不从 health 抄** |
| `src/client/index.tsx`（改） | 自建根节点 `.wb-panel-host` 上渲染 `data-workbench-build-id` |
| `src/api/routes.ts`（改） | `GET /api/workbench/health` 增加 `buildId`（读随包 `lib/build-info.json`） |
| `src/shared/contracts.ts`（改） | 新增 `WorkbenchHealthResponse` 形状 |
| `scripts/dev-install.mjs`（改） | **目标 profile 解析 fail-closed** + `--profile-dir`/`--db-path`/`--print-target`；门禁核对的就是装盘目标 |
| `scripts/check-installed-version.mjs`（改） | `--profile-dir` 显式优先（原来只认环境变量）+ `--db-path`（原来永远核对默认共享库）+ 报告里写明核对的是谁 |
| `package.json`（改） | `build`/`check` 在 tsc/tsdown **之前**跑 `scripts/build-info.mjs` |
| `.gitignore`（改） | 加注释 + `!scripts/verify/`（显式声明"链要进仓库"，防止将来被宽规则静默吃掉） |
| `tsconfig.build.json`（改） | 把 `src/client/buildId.ts` 加进可被 `node --test` 直接引用的白名单 |
| `test/verifyManifest.test.mjs`（新，11 条） | AX-V01 |
| `test/verifyBrowser.test.mjs`（新，10 条） | AX-V02 |
| `test/verifySafety.test.mjs`（新，18 条） | AX-V03–V05 / AX-G03（含"杀进程前最后一关"的端口归属全表驱动判据） |
| `test/devVerify.test.mjs`（新，24 条） | AX-V06–V09 / AX-G04（吞错那半）+ V04-B 三方标识 |

---

## 3. 链的契约（T6 直接照这个用）

### 3.1 命令与退出码

```sh
# 只读预检 + 打印阶段计划（零写入：不建证据目录、不构建、不装盘、不重启、不开浏览器）
node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web \
  --profile-dir "C:\Users\<你>\.dsh\profiles\web" \
  --db-path "C:\Users\<你>\.dsh\workbench\verify-web.db" --dry-run

# 真跑（去掉 --dry-run）；可选 --force / --launcher <ps1> / --browser <exe> / --suites a,b / --json
```

| 退出码 | 含义 |
|---|---|
| 0 | 所有必需阶段/套件通过 |
| 1 | 构建/装盘/diff/断言失败；**health 有 200 但构建标识不匹配**（旧构建不算成功） |
| 2 | 自锁拒绝、环境缺失、**必需套件还没迁入**、白名单读不了、`--launcher` 不存在 |
| 3 | 等待超时：health ≤120s（每次请求 ≤5s）/ token ≤60s / 单套件 ≤180s |

阶段顺序（`safety.mjs#STAGE_PLAN`，任一步非 0 立刻停，不进入后续危险动作）：
预检 → 装前版本门禁 → 构建 → 打包装盘 → 零增量 diff → dump-config → 装后版本门禁 →
只重启目标 → health → token → 白名单套件 → 证据包 → 清理本次浏览器。

### 3.2 三方构建标识（AX-V07）

```
目标包 manifest  <profileDir>/node_modules/@dely0/dsh-personal-workbench/lib/build-info.json
host health      GET /api/workbench/health → buildId
client 内联值     globalThis.__WORKBENCH_BUILD_ID__ → .wb-panel-host[data-workbench-build-id]
```
三者必须**同源**：`pnpm build` 顺序是 `rm lib → scripts/build-info.mjs → tsc → tsdown`，
health 读的就是那份 `lib/build-info.json`，client 由 `tsdown.config.ts` 读**同一个文件**内联。
`src/client/buildId.ts` 只读内联值——**不许**去 health 抄（照抄就证明不了"浏览器真的加载了本次 bundle"）。
生产包同样带 `lib/build-info.json`（已实测 `pnpm pack` 内含且 `check-tgz.mjs` 通过）。

### 3.3 套件契约（T6 写 `scripts/verify/suites/*.mjs` 时照这个）

- argv：`--url <目标> --evidence-dir <本次证据目录> --user-data-root <临时浏览器目录根>`
- env：`DSH_VERIFY_TOKEN`（**故意不进 argv** —— argv 在进程列表里可见；token 只在内存/环境里传）
- stdout：最后一行是 JSON 汇总 `{"passed":n,"failed":n,"skipped":n,"total":n}`（也允许写
  `<evidence-dir>/suite-<id>.json`）
- **拿不到汇总 / `total<=0` / 必需套件 `skipped>0` / 退出码非 0 → 一律判失败**（空计数绝不等于通过）
- `suites.json` 里把该套件从 `pending-migration` 翻成 `active` 之后，链才会真的跑它；
  只要还有 `required && status!=='active'`，链在 `suites` 阶段**直接退出码 2**。

---

## 4. AX 覆盖（本项归属部分）

| AX | 覆盖位置 | 状态 |
|---|---|---|
| AX-V01 脚本卫生/白名单缺文件失败/无 `.pwtest` 也能用/不固定 150·22 | `test/verifyManifest.test.mjs` 11 条 + `node scripts/check-verify-scripts.mjs` 实跑（动态统计：150 份 `.mjs` / 22 份嫌疑 / 8 套待迁 / 3 条作废） | ✅ 实测通过 |
| AX-V02 独立 user-data-dir+CDP 端口 / 覆盖路径不可执行报错 / 30s 超时真 reject / 只关己方浏览器 | `test/verifyBrowser.test.mjs` 10 条（假 WS/假 spawn，无浏览器机器也能跑） | ✅ 实测通过（真实浏览器 B 层点击归 T6） |
| AX-V03 同端口 `--force` 仍拒绝 / 缺或非法 `DSH_WEB_URL` 拒绝 / 非 3080-web 拒绝 / 安装·kill·DB 写 0 次 / **端口归属必须匹配目标 dsh 实例（不按 PID 杀）** | `test/verifySafety.test.mjs`（注入的 spawn/kill/writeDb/writeFile 探针断言 0 + 源码级"无子进程能力"断言；`isTargetDshProcess` 全表驱动覆盖：非 node / node 但非 dsh / 非 web 子命令 / 端口不符 / 显式指定了别的 profile） | ✅ 实测通过 |
| AX-V04 同 realpath profile/DB 拒绝 / 继承 desktop `DSH_PROFILE_DIR` 不许传给 web 安装 / `WORKBENCH_PROFILE_DIR` 一致 | `test/verifySafety.test.mjs`（含**真子进程**跑 `dev-install.mjs --print-target` 验证继承被拒） | ✅ 实测通过 |
| AX-V05 未显式独立 DB 配置/与当前同库/实际配置不可知 → 拒绝；仅 `--db-path` 不冒充隔离；dry-run 零写入 | `test/verifySafety.test.mjs` + `test/devVerify.test.mjs`（dry-run 不建证据、不跑命令、不清理） | ✅ 实测通过 |
| AX-V06 逐阶段注入构建/装盘/diff/dump-config 失败 → 后阶段不跑；装前后版本门禁都 0 | `test/devVerify.test.mjs` 4 条阶段失败 + 版本门禁前后两条 | ✅ 实测通过（注入的是假阶段；真实装盘实跑归 T6） |
| AX-V07 health200 旧构建拒绝 / health·token 超时非 0 带阶段名 / 认证失败·空套件·缺套件·required skipped 都不通过 | `test/devVerify.test.mjs` 6 条 | ✅ 实测通过 |
| AX-V08 token 在所有持久证据里脱敏、原串全树查不到、不记录完整配置秘密 | `test/devVerify.test.mjs`（**用真证据包 + 假 token 走一遍失败流程**）+ `redact()` 形态单测 | ✅ 实测通过 |
| AX-V09 套件 180s 超时退出 3 / 断言失败退出 1 / 自锁退出 2 / finally 不覆盖失败为 0 / 清理只处理自己的目录 | `test/devVerify.test.mjs` 3 条 | ✅ 实测通过 |
| AX-G03 同端口·目录·DB 自锁 fail-closed（拆掉任一相等检查必红） | 变异表 §6 第 1–5 行 | ✅ 实测通过（不杀真进程） |
| AX-G04 的"套件不能吞错误报绿"一半 | `test/devVerify.test.mjs`（0 用例/无汇总/required skipped/断言失败/超时/链内异常六种都不绿）+ evidence 的 `finally` 只清理不改退出码 | ✅ 实测通过（资源跨绑定根那半属 T3/T4） |
| AX-V10 独立测试实例实跑旧四套+新套件 | **未做**（属 T6）：本机隔离配置未确认 + 套件还没迁入 | ⚠️ 未验证 |

---

## 5. 真实命令与结果（本轮实测）

```text
pnpm typecheck                 → 退出码 0
pnpm build                     → 通过；lib/client.js 501.52 kB / gzip 145.11 kB；lib/build-info.json buildId=wb-34aff1a8a9994230（130 个输入文件）
node scripts/build-info.mjs    → 同值（确定性）；改一个源文件即变；改 test/ 不变
pnpm pack + check-tgz.mjs      → lib/build-info.json 在包内且版本一致；"✅ 存档包完好"
node scripts/check-verify-scripts.mjs --json
                               → exitCode 0，counts { active:0, pending:8, requiredPending:8, deprecated:3, localScripts:150, suspects:22 }
node --test test/verifyManifest.test.mjs test/verifyBrowser.test.mjs test/verifySafety.test.mjs test/devVerify.test.mjs
                               → tests 63 / pass 63 / fail 0
pnpm test（全套，含 build）      → tests 876 / pass 875 / fail 1
```

那 1 条失败是**预先存在**的 `test/db.test.mjs` 清理期 `rmSync` EPERM（T1 起每轮都在，已用
`git checkout` 回基线复现过，与本轮无关；未删断言）。基线对照：T4 结束时 813 条 → 本轮 +63 条（我新增的四个文件），0 回归。

真实状态核对（只读）：

```text
3080  → pid 19056（dsh web --port 3080 --no-open，profile web）—— **未重启、未 kill**
19387 → pid 17564（桌面端，本会话所在）                        —— **未被触碰**
正式库 C:\Users\<user>\.dsh\workbench\workbench.db schema_version = 18 / tasks = 94 —— **未被迁移**
test-results/ 只有既有的 .last-run.json（dry-run 与测试都没往里写）
```

---

## 6. 定向变异（18/18 全部变红，跑完按 sha256 校验恢复、无 `.mutbak` 残留）

| 拆掉的防护 | 变红的判据 |
|---|---|
| 同 profile 物理目录拒绝 | `verifySafety` AX-V04 链接指过去 |
| `--force` 绕过同端口拒绝 | `verifySafety` AX-V03 同端口 |
| `DB_NOT_DECLARED` 从 error 降成 warning | `verifySafety` AX-V05 无独立 DB 配置 |
| `--db-path` 与实际配置不一致的拒绝 | `verifySafety` AX-V05 仅参数不冒充隔离 |
| 继承 desktop `DSH_PROFILE_DIR` 的拒绝 | `verifySafety` AX-V04 子进程环境重设 |
| （反向）恢复 dev-install 无条件继承 | `verifySafety` 真子进程 `--print-target` |
| 端口归属"命令行必须含 dsh" | `verifySafety` AX-V03 归属判据 |
| 端口归属"端口必须与命令行一致" | `verifySafety` AX-V03 归属判据 |
| 端口归属"不许是别的 profile" | `verifySafety` AX-V03 归属判据 |
| "现役套件缺文件"降成提示 | `verifyManifest` AX-V01 |
| "未声明套件"降成提示 | `verifyManifest` AX-V01 静默丢件 |
| 独立 `user-data-dir` 参数 | `verifyBrowser` AX-V02 启动参数 |
| CDP 30s 超时改成 0 | `verifyBrowser` AX-V02 超时 |
| `finally` 把失败覆盖成 0 | `devVerify` AX-V09 链内异常 |
| 必需套件未迁入当可以继续 | `devVerify` AX-V07 缺套件 |
| health 只要求 200（不比 buildId） | `devVerify` AX-V07 旧构建 |
| 写盘前的 `redact()` | `devVerify` AX-V08 token 不进证据 |
| buildId 掺随机数 | `devVerify` V04-B 确定性 |

---

## 7. 本轮抓到的真问题（都不是"原本以为"的）

1. **`dev-install.mjs` 原来无条件继承 `DSH_PROFILE_DIR`**（`process.env.DSH_PROFILE_DIR ?? ~/.dsh/profiles/web`）。
   在桌面端会话里跑 `--profile web` 时，桌面端注入的 `DSH_PROFILE_DIR` 指向 `profiles\desktop` ——
   "装 web"会装到 desktop 目录、门禁去核对另一个 profile。已改成 fail-closed（显式 `--profile-dir` 优先；
   继承只在 profile 同名时允许，否则**拒绝**并给出修法）。`check-installed-version.mjs` 同样只认环境变量、
   默认 `profiles/web`，现在 `--profile-dir` 显式优先。
2. **`check-installed-version.mjs` 的 DB 检查永远读默认共享库**。隔离 profile 上它核对的其实是**另一个库**。
   已加 `--db-path`，并把"目标 profile / 核对的数据库"打进报告。
3. **`safety.mjs` 第一版 `findPluginEntries` 漏掉了 `- id:` 这一行**（块内循环从第二行开始），
   于是"只有 id 没有 name"的条目（正是 profile patch 的写法）读不出来 → 目标配置被误判成"没配置"。
   测试当场变红（`unknownKeys` 读不到），已修。
4. **`.pwtest` 里 4 套被点名的脚本本身就是"嫌疑"**（`verify-acceptance.mjs`、`verify-stable.mjs` 等
   命中已删除行为的关键词）。它们是**要迁移的现役套件**，不是要作废的垃圾 —— 所以白名单把它们登记成
   `pending-migration` 而**不是** `deprecated`；嫌疑清单只出报告，不作废。

---

## 8. 本机真实状态（本项**故意**停在这里）

```text
预检结论：refused（退出码 2），理由 DB_NOT_DECLARED
  目标 profile 的实际配置里没有 dbPath/dataDir
  → 它会用 C:\Users\<user>\.dsh\workbench\workbench.db（与桌面端**同一个文件**）
```

这不是脚本没写好，而是**规格要求的 fail-closed**：默认 DB 跨 profile 共用（`src/db/database.ts`），
而本次开发树 `SCHEMA_VERSION = 19`、那个库里是 **18**、里面有 **94 条真实任务**。
一旦不隔离就重启测试实例，插件会把这个**正式库**迁到 19，桌面端（跑着公开发布的 1.15.8，只支持 18）
下次读库就会走 `SchemaTooNewError` 降级路径。所以：

- **首次隔离配置必须由用户确认并走 `dsh-safe-plugin-ops`**（本项没有、也不该自动改 Cordis/profile）；
- 在配置到位之前，本项只交付 **dry-run + 负向测试**，并如实报告阻塞。

需要用户做的（一行级）：在 `~/.dsh/profiles/web/cordis.patch.yml` 里给 `personal-workbench` 条目加

```yaml
- id: personal-workbench
  config:
    dbPath: "C:/Users/<user>/.dsh/workbench/verify-web.db"
```

（按 `dsh-safe-plugin-ops` 的门禁：先备份 `cordis.patch.yml` → 改 → 重启**测试实例** 3080 →
`GET /api/workbench/health` 确认 `db.schemaVersion` 变成 19 且任务数不是 94。）
本项**没有**替用户做这一步。

---

## 9. 明确未验证 / 未做（不得当已过）

1. **链的真实运行（AX-V10）完全未做**：没有构建→装盘→重启→抓 token→跑套件的实跑。
   原因见 §8（隔离未确认）。`--dry-run` 实跑过（退出码 2，零写入）。
2. **真实浏览器 B 层点击未做**：`cdp.mjs` 的假 WS/假 spawn 单测覆盖了参数与超时，
   但"真的起一个 Edge、打开 3080、点工作台入口"归 T6。
3. **8 套白名单套件一份都没迁入**（`scripts/verify/suites/*.mjs` 全不存在）——
   这是 T6（V05/S17/S17-N）的工作；链现在会因为"必需套件未迁入"退出码 2。
4. **`restartTarget` 的真实 kill → 重启整段从未在本机执行**（这是有意的：T5 不做真实重启）。
   它内部"该不该 kill 这个 pid"的判据（`isTargetDshProcess`）已经有全表驱动单测（9 个用例）
   与 3 条定向变异，但 `findPortOwner` 的 PowerShell 查询、`Stop-Process`、`spawn dsh web --no-open`、
   日志 offset 抓 token 这条**真实通路**没有跑过。T6 第一次真跑时请把它当作"首次验证"的点：
   先确认 kill 的是 3080 的归属进程、日志里出现的是**本次**启动的 token。
5. `--launcher` 路径：实现为"显式指定则必须存在，否则退出码 2；不给就用内置 Node 重启（可移植、不开浏览器窗口）"。
   规格里"launcher 需要发现或 `--launcher` 覆盖"的本意（不许回退到别的 profile 的启动器）已满足，
   但**默认不走 launcher** —— 因为那是台机器本地的 PS1 文件，链要在别的机器也能跑。若 T6 要求默认走 launcher，
   那是行为变更，须先改规格。
6. **`evidence` 阶段会写两次 `summary.json`**（第一次在 `evidence` 阶段，清理后再写一次把
   `tempDirsRemoved` 补进去）。这是为了让声明的阶段顺序（证据包 → 清理浏览器）与"摘要包含清理结果"同时成立，
   不是重复实现。
7. 未做 `git commit`、未装盘、未改公开版本号、未公开发布、未动正式 DB、未重启任何实例。

---

## 10. 给 T6 的输入

1. **先做隔离配置**（§8），再跑真实链；第一次真跑请盯三件事：① `restart` 阶段真的只 kill 了 3080 的归属进程；
   ② health/token 时间预算够不够（默认 120s/60s）；③ `profile-diff` 阶段有没有假红。
2. **迁 4 套历史回归**：判据输入是 `legacy-regression.md` 的 43 个 LEG 编号（17/9/6/11 **不是**本轮实测）。
   迁完把 `suites.json` 里对应条目翻成 `active`。注意 `duplicate-task` 会写库 —— 只允许对隔离测试库跑。
3. **新增 4 套**：`progress` / `daily-effort` / `persona` / `verify-safety`（AX 编号已写进 `suites.json` 的 `axIds`）。
   `persona` 套件必须观察到**真实的 `workbench_load_persona` 工具调用与角色正文**；模型不可用时报未验证，不许只测下拉选中。
4. 链的**默认拒绝**不是 bug：在当前状态下 `--dry-run` 退出码 2 是**正确行为**，别为了让它绿而放宽预检
   （变异表里每条放宽都有对应的红）。
5. 若要改 `safety.mjs` / `dev-verify.mjs` 的判据，先跑 `node --test test/verifySafety.test.mjs test/devVerify.test.mjs`；
   这两组是白名单/自锁/脱敏的唯一防线。

---

## 11. 改动文件清单（`git status --short` 实测，仅本项）

**新增**：`scripts/check-verify-scripts.mjs`、`scripts/build-info.mjs`、`scripts/dev-verify.mjs`、
`scripts/verify/{suites.json,browser.mjs,cdp.mjs,safety.mjs,evidence.mjs,runtime.mjs}`、
`src/client/buildId.ts`、`test/verifyManifest.test.mjs`、`test/verifyBrowser.test.mjs`、
`test/verifySafety.test.mjs`、`test/devVerify.test.mjs`、本文件。

**修改**：`scripts/dev-install.mjs`（目标解析 fail-closed + 三个新参数）、
`scripts/check-installed-version.mjs`（`--profile-dir`/`--db-path` + 报告写明核对目标）、
`package.json`（build/check 前置 build-info）、`tsdown.config.ts`（内联 buildId）、
`src/api/routes.ts`（health.buildId）、`src/shared/contracts.ts`（health 形状）、
`src/client/index.tsx`（根节点属性）、`tsconfig.build.json`（buildId 模块）、`.gitignore`（放行注释）。

**未提交**（按共同执行契约：用户未要求提交代码）。
