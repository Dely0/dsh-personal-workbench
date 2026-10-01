# 研发版本验收链：一条命令跑到浏览器判据，且目标实例不能是当前实例

**Status:** accepted（2026-09-30）

需求是「让 AI 用浏览器自己做工作台插件研发版本的验证测试」。现场勘查结论：
**零件基本都在位，缺的是一条链和两条边界。**

## 2026-09-30 的历史现场快照（开发前重新核对，PID/用例数不是运行配置）

| 零件 | 现状 |
|---|---|
| 独立测试实例 | 在跑：PID 13176 = `dsh web --port 3080`（npm 全局 CLI，workDir 就是本仓库），profile = `web` |
| 本会话所在实例 | 桌面端 PID 13616，profile = `desktop`，`DSH_WEB_URL=http://127.0.0.1:19387` —— **与测试实例是两个进程两个 profile** |
| 装盘 | `scripts/dev-install.mjs`（默认 `--profile web`，装到带构建戳的新路径 + 三道门禁 + 备份 + diff） |
| 重启与就绪探测 | `~/.dsh/launchers/open-dsh.ps1`：按**端口归属**校验后只杀该端口的 node 进程、用真实 HTTP 探 `/api/workbench/health`、日志 `%TEMP%\dsh-server-3080.log` |
| 浏览器驱动 | `.pwtest/cdp.mjs`：**零依赖** CDP（Node 24 自带 WebSocket + fetch）、**独立 `user-data-dir` + 独立端口**、每次调用 **30s 超时** |
| 判据套件 | 现役 4 套：`verify-acceptance` 17/17、`verify-final-2` 9/9、`verify-sidebar-collapse` 6/6、`verify-duplicate-task` 11/11 |

## 决定

1. **落点 = 研发侧一条链，进仓库**。不做成插件功能：正式用户不需要"测自己"的入口，
   而插件自己重启宿主的风险与定位都不合适。
2. **链的形状**：`scripts/dev-verify.mjs` 一条命令跑完
   「构建 → `dev-install --apply --profile web` → 重启 3080 → 等就绪（HTTP 探 `/api/workbench/health`）
   → 从 `%TEMP%\dsh-server-3080.log` 抓 token → 跑判据套件 → 出证据包」，带退出码与判定摘要。
3. **自锁判据（硬规则）**：**目标实例绝不能是当前会话所在的实例**。
   用宿主给的环境事实实现：把目标 `http://127.0.0.1:<port>` 与 `DSH_WEB_URL` 比对 ——
   **端口相同 → 直接拒绝运行**；`DSH_PROFILE` 与目标 profile 相同 → 警告并要求显式 `--force`。
   （2026-09-30 实测本会话可读到：`DSH_HOME` / `DSH_PROFILE=desktop` / `DSH_PROFILE_DIR` /
   `DSH_SESSION_ID` / `DSH_WEB_URL=http://127.0.0.1:19387` / `DSH_SHELL`。）
4. **浏览器驱动搬运 + 可移植**：`cdp.mjs` 从 **gitignored** 的 `.pwtest/` 挪进 `scripts/verify/`，
   把硬编码的 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`
   改成「候选发现 + 环境变量覆盖（`DSH_VERIFY_BROWSER`）」。两条命门必须保留：
   **独立 `user-data-dir`**（否则命令行被转发给已有浏览器实例 —— 什么都不发生、还 exit 0）
   与**每次 CDP 调用 30s 超时**（把"永久挂住"变成可读报错）。
5. **判据套件也进仓库**：上面 4 套现役套件参数化 URL + token 后移到 `scripts/verify/suites/`。
6. **前置依赖 = P1-1**：`.pwtest` 150 个脚本里 22 份测的是已删除行为；
   不治就跑出成片假失败，这条链的价值会被噪声吃掉。
7. **教 AI 用**：**扩既有项目级 skill `.dsh/skills/dsh-plugin-change/SKILL.md`**（新增一节
   "研发版本验收链"），**不新建 skill** —— 它的 §14 已经在问"验收脚本的过时判据同步了吗"，
   同一内容只存一处。

## Considered Options

- **只在本地做、不进仓库**：快，但换机器即失能，且别的会话不知道有它。
- **做成插件里的"研发验证"面板**：正式用户多一个没人用的入口；插件要自己重启宿主，风险大；
  与"个人工作台"的定位不符。
- **只接浏览器 MCP**：`cdp.mjs` 的注释已记下这个选型的理由（MCP 路线需要 pip 安装 +
  给**正在使用的**浏览器开远程调试并人工点允许）；团队另有实证「测试层选错会掩盖缺陷」
  （探针不重读目标元素 → 假绿）。**MCP 适合探索期临时扒新缺陷，确定性判据才是回归底座。**

## Consequences

- 这条链让「AI 自己验收研发版」成立，但它**不能替代人**：
  判据是确定性检查，**上线判定仍由用户做**（本仓库既有规矩：用户实测确认后才发布）。
- 仓库从此含浏览器测试代码：`.gitignore` 要放行 `scripts/verify/`，
  而 `.pwtest/`（机-local 探针，167 个文件）**继续 ignore** —— 这条边界要写进 README。
- **重启授权范围**：预授权仅限「测试实例（3080 / `web` profile）」；
  当前会话所在实例（`desktop` / 19387）**永不重启**（`dsh-safe-plugin-ops` 的硬规则照旧）。
- 证据目录（截图 + `summary.md`）保持 gitignored —— 它是派生物，重跑即生。
- 验收链安装冻结包后重启**目标测试实例**，验证新的host/client构建标识；不把它推广成“所有客户端开发方式都必须重启”，HMR的前提仍需按宿主规则核实。

## 实施契约（2026-09-30 补齐）

1. 同端口拒绝之外，**同profile物理目录/同DB物理文件也必须拒绝**，--force不能绕过；环境事实缺失/无法证明独立时fail-closed。
2. 不同profile不等于不同数据库：当前默认DB是`~/.dsh/workbench/workbench.db`，不随profile区分。测试实例必须在实际配置中显式指向独立dbPath/dataDir；只传参数或换端口不能当作隔离证据。
3. 子进程必须显式固定目标DSH_PROFILE/DSH_PROFILE_DIR/WORKBENCH_PROFILE_DIR，避免dev-install继承当前desktop路径。装前后版本一致性、零增量diff、dump-config三道门禁保留。
4. 正常验收链不自动改Cordis运行配置；首次数据隔离配置需用户确认并走safe-plugin-ops。预授权范围仍只限3080/web，不能用--force扩权；本轮文档补齐未执行重启。
5. 预检在所有构建/安装/重启之前；dry-run零副作用；health旧构建不算通过。阶段错误/超时/空套件/required跳过都不能绿。
6. token仅内存使用，证据必须脱敏；30s CDP、120s health、60s token、180s单套件时间预算及己方浏览器清理必须有负向测试。
7. 旧四套参数化只算回归；增加S17-N对进度/每日投入/角色/自锁的新判据，写入只对合成独立DB；历史17/9/6/11不是本轮实测结果。

CLI、退出码、构建标识、证据schema和AX判据见[开发规格](../tasks/36c8e8ef-1104-4e68-b55f-a2a6cc533ab9-工作台插件优化/requirements.md) R-V与同目录acceptance.md。
