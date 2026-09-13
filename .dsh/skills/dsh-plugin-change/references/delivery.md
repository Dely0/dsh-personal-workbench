# 交付与验证流程（装盘 / 重启 / 验收 / 发布）

> 编码规范见 [SKILL.md](../SKILL.md)。这里只讲"把代码变成用户机器上生效的东西"这条链。
> 权威清单是仓库里的 `docs/release-checklist.md`；本文是高频项与实证教训。
>
> **与全局 `~/.dsh/AGENTS.md` 第 2 节的关系**：那一节是"**任何** DSH 插件装/升级/卸载前"都必须走的门禁
> （版本一致性检查 + 备份 + diff + dump-config + 重启须用户同意），**始终生效**；
> 本文是它在工作台这条链上的展开与补充（多出客户端重启、验收判据、发布/回滚）。
> 两边**不要各写一份**：改门禁要求时改 AGENTS.md，改工作台特有流程时改这里。

## 1. 三件反直觉但决定一切的事

| 事实 | 为什么反直觉 | 守不住的后果 |
|---|---|---|
| **`dsh plugin add` 不是"只装这一个包"** | 它是 pnpm 的转发器，会按 `pnpm-lock.yaml` **重新对齐整个 profile** | 装一个无关插件会把你另一个插件**静默回退**；DSH loader 把 patch 行当**事务组**，任一行启动失败 → **整个 `dsh web` 拒绝启动、GUI 进不去、无法从界面自救**（2026-09-12 P0） |
| **客户端改动不是"刷新页面就生效"** | `dsh-client-modules` 的 `bundleResource()` 只查**宿主启动时**建好的内存 Map（页面上的 `rev` 都对不上） | 你以为在验新代码，其实跑的是旧的（白验两轮） |
| **"装好了但没重启"是静默的** | 装盘改的是磁盘，宿主进程里的模块树不变 | 报"还是老行为"，然后开始怀疑代码，而真正原因是没重启 |

## 2. 改 profile 的标准顺序（不可调换）

```bash
# ① 备份（命名惯例：package.json.bak-<用途>-<yyyyMMdd-HHmmss>）
cp <profile>/package.json   <profile>/package.json.bak-<用途>-<stamp>
cp <profile>/pnpm-lock.yaml <profile>/pnpm-lock.yaml.bak-<用途>-<stamp>

# ② 装
dsh plugin add <绝对路径>/<pkg>-<新版本>.tgz --profile web

# ③ 立刻核对：只有目标插件一处变化
diff <profile>/package.json.bak-… <profile>/package.json
diff <profile>/pnpm-lock.yaml.bak-… <profile>/pnpm-lock.yaml | grep -v <目标包名>   # 应为空

# ④ 门禁（必须在重启之前跑！）
node scripts/check-installed-version.mjs      # 装盘/profile 声明/锁文件/DB schema 一致 → 0
node scripts/check-installed-fingerprint.mjs  # 装盘产物 vs 开发树 lib/ 逐文件一致 → 0
dsh --profile web --dump-config >/dev/null    # 插件树能组装（0、无 pending）

# ⑤ 请用户重启（见第 4 节）
```

**`check-installed-version.mjs` 必须在重启前跑** —— 它是唯一能在"GUI 已经起不来"之前抓住回退的东西；
一旦重启失败，你没有界面可以自救。

**同版本号 tgz 会被 pnpm 缓存复用**：pnpm store 按「包名 + 版本号」内容寻址，
同名同版本的 tarball 即使内容变了也复用旧副本（`--force` 无效；Windows 解包保留 mtime，
看时间戳判断不出来）→ **换了构建产物必须换版本号**。
判断"装的到底是不是新代码"只认 `check-installed-fingerprint.mjs`。

**schema 只单向前进**：插件读不了更新的库时 **升级插件，绝不降级数据库**。

## 3. 客户端改动的迭代循环

```bash
pnpm typecheck && pnpm test   # 单测（不需要宿主）
pnpm build && pnpm pack       # 产出 lib/client.js（单文件 bundle）+ lib/*.js（宿主半边）
# → 装盘 → 指纹核对 → 重启 → 硬刷新 → 验收
```

## 4. 重启宿主：这是用户的操作

`dsh web` 同时是 **agent 宿主** —— 重启会掐断用户正在用的 GUI 会话**和你自己所在的会话**。

- **绝不自行重启**：把命令给用户，或明确征得同意。
- **攒够了再重启一次**（多个阶段合并到同一次重启里验证），不要每个小改动重启一次。
- 重启后先看 `/api/workbench/health`（版本号）与宿主日志里的 `[workbench]` 告警
  （`未启动：…` 说明能力门槛没过，要看它缺什么）。

## 5. 验收：别相信"跑过了"

判据本身会骗你，四种实证形态：

| 形态 | 实例 | 怎么防 |
|---|---|---|
| **恒过** | `check()` 形参写成 `(id, name, ok, detail)`，9 个调用点都按 `(id, 条件, 说明)` 传 → `ok` 收到说明字符串（永远真值）→ 9/9 "通过" | 改判据脚本时**先故意制造一次失败**看它会不会红 |
| **假阴性（架构变更后）** | 家族互斥删了，脚本仍断言"兄弟标记出现就让位" → 必然失败，看起来像回归 | 架构一变就扫一遍验收脚本；反转判据并写清为什么反转 |
| **找错地方** | 用面板容器找弹框按钮 —— 弹框是 `createPortal` 到 `document.body` 的 | 用**结构**定位（`[role="dialog"]` + `<h3>` 标题），不要靠"某段文本出现过" |
| **截图看着是白板** | 面板本来就是白底；空白页与有内容页都可能只有 60–130 KB | 用像素直方图：**非白像素色数** + 局部裁剪（标题栏裁 60px 能看到按钮色） |

其它硬要求：

- **真实鼠标事件**（CDP `Input.dispatchMouseEvent`），并配截图；`el.click()` 测不出 React 合成事件。
- **多轮脚本每轮先归零**：侧栏入口是**开关**，上一轮留着开、下一轮再点就变成关。
- **在真实库上跑之前先 grep 脚本有没有写操作**（`POST`/`PATCH`/`DELETE`/`/confirm`/`/defer`）。
  只读的（`verify-final-2.mjs` / `verify-sidebar-collapse.mjs`）可以直接跑；
  会造数据的先备份库，或造隔离实例（独立 `DSH_HOME` + 独立库 + 独立端口）。
- **在真实库上删数据**：备份 → 把待删行导出成回滚 JSON → dry-run 打印将删什么 → 再 `--apply`。

## 6. 本机环境

| 环境 | 要点 |
|---|---|
| Windows | `~/.dsh/profiles/web`；宿主常见端口 3080 |
| WSL（Ubuntu） | **可能同时存在两套 dsh**：`~/.local/lib/node_modules/@deepseek-ai/dsh`（旧）与 `/usr/local/lib/node_modules/…`（npm 全局）。PATH 里 `~/.local/bin` 在前 → `dsh --version` 报的是**旧那套**。用 `which -a dsh` + 逐个读 `package.json` 的 version 确认 |
| WSL 服务 | `systemctl status dsh-web.service`；`journalctl -u dsh-web.service`；**token 每次启动都换**：`journalctl -u dsh-web.service --no-pager -n 200 \| grep -o 'http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*' \| tail -1` |
| 代理 | git **不读** Windows 系统代理：直连 github 会 `Connection was reset`。需要时临时给 git 加 `HTTPS_PROXY=http://127.0.0.1:5782`（FaceTheWorld SSR），**不要改全局 git 配置** |
| 两边的库 | **WSL 与 Windows 是两个库**（各自 `~/.dsh/workbench/workbench.db`）。跑验收前先确认打的是哪个 |

## 7. 发布

- `pnpm typecheck` + `pnpm test` 全绿，且**用例数不少于上一版**（少了说明有用例被删/跳过）。
- **先本机验证，再发布**：v1.13.0 因"发布早于验证"翻过车（npm 已是最新、本机没验，
  用户升级后前端直接 `Failed to load plugins`）。
- **必须在两台宿主上验过**（至少一台是用户环境），并留证据（脚本输出 + 截图）。
- **npm 不允许篡改已发布版本**；而 **npm 页面渲染的是包内 `README.md`** ——
  文档要改就得换版本号重发（`unpublish` 与同版本覆盖重发都会被 403 拒：
  前者因 granular token 绕过 2FA 被禁，后者报 `cannot publish over previously published versions`）。
- 凭据：npm **只认 `.npmrc` 的 `//registry/:_authToken`**（`NPM_TOKEN` 环境变量无效）。
  用凭据时写到**仓库外**的临时文件、用完即删、**绝不 echo**；token 不落盘到仓库。
- **不要 push / publish 除非用户明确要求**。

## 8. 回滚

- 插件：用 `_local-archive/` 下的 tgz（**当前装盘 pin 的那个留在仓库根**，
  profile 用绝对路径指着它，挪走会让装盘/回退都找不到包）。
- 源码：`git checkout v<版本>-stable` + `pnpm build && pnpm pack`（构建确定性，可逐字节重建）。
- **回退后同样必须重启**，然后再跑一次 `check-installed-version.mjs`。
