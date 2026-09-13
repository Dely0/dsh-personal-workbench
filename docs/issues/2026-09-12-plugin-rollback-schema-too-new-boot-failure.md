# INCIDENT：`dsh plugin add` 回退插件版本 → 数据库 schema 超前 → DSH 拒绝启动

| 项 | 内容 |
|---|---|
| **发生时间** | 2026-09-12 21:15（安装）→ 21:21（重启失败）→ 21:27（修复完成） |
| **严重级别** | P0（**整机不可用**：DSH Web 拒绝启动，GUI 进不去） |
| **触发动作** | `dsh plugin --profile web add @linxin666/dsh-session-archive@0.3.20` |
| **影响范围** | Windows 侧 DSH（web profile）；数据库文件**零改动**（78 任务 / 41 草稿 / 5 提醒完好） |
| **定位与恢复** | WSL 侧会话（通过 interop 在 Windows 上执行 dsh/node） |

---

## 1. 事故链

```
21:15:38  dsh plugin add @linxin666/dsh-session-archive@0.3.20
            └─ dsh plugin 只是 pnpm 的转发器；pnpm 按 pnpm-lock.yaml 对齐【整个 profile】
            └─ 锁文件里 @dely0/dsh-personal-workbench 是 1.12.1
            └─ 于是已装盘的 1.13.3 被【回退】成 1.12.1（只支持 schema 14）

21:21     dsh web 重启
            └─ 1.12.1 的 migrate() 读到库里的 schema_version = 15
            └─ throw: db schema version 15 is newer than supported 14
            └─ apply() 抛错 → cordis 把整个 patch 行【事务组】回滚
            └─ DSH 拒绝启动：Failed to load plugins
            └─ ⚠ 此时 GUI 起不来 → 进不了插件管理页 → 无法从界面自救
```

**核心机制（这是最反直觉的一点）**：`dsh plugin add` **不是**"只装这一个包"，而是让 pnpm 按锁文件**重新对齐整个 profile**。所以"装一个无关插件"可以顺手把另一个插件降级。任何"手工绕过包管理器直接塞进 node_modules 的版本"都会在下一次装插件时被抹掉。

**为什么它会拖死整个宿主**：DSH loader 把 `cordis.patch.yml` 里的全部 patch 行当成一个事务组挂载——**任何一行 import 或启动失败，整组回滚并中止 `dsh web`**。不是"这个插件没加载"，是"整个 web 进程不起"。

---

## 2. 处置（WSL 侧执行）

选**升级插件**而不是降级数据库：

```sh
cd C:\Users\Administrator\.dsh\profiles\web
dsh plugin --profile web add @dely0/dsh-personal-workbench@1.13.3
```

**为什么不降库**：schema 15 正是 1.13.x 的 reminder-status-semantics 迁移（拆开 `fired_at` 的三种语义）。降到 14 会复活「提醒永久停在待处理」这个已修的历史事故。

**验证**：装盘 1.13.3 / `SCHEMA_VERSION = 15`；对数据库副本跑 `migrate()` 通过；`dsh --profile web --dump-config` 退出码 0；lockfile 与备份逐行 diff **只有工作台一处变化**（其余 17 个插件未动）；真实数据库未改动。

**备份**：`workbench.db.bak-preschema15-issue-20260912-2127`、`package.json.bak-schema15fix-20260912-2127`、`pnpm-lock.yaml.bak-schema15fix-20260912-2127`。

---

## 3. 插件侧加固（本次改动）

事故的**放大器**是插件的失败模式：数据库比插件新属于运维常态（版本回退、多机共用 `DSH_HOME`、profile 换了插件集），不该等于"宿主不可用"。一个可选功能插件没有资格让整个 DSH 起不来。

| 文件 | 改动 |
|---|---|
| `src/db/database.ts` | 新增可判别错误类型 `SchemaTooNewError`（带 `dbVersion` / `supportedVersion`）；`openWorkbenchDb` 在迁移失败时**补上 `db.close()`**（原先会泄漏连接，Windows 上锁住库文件，用户连备份/删库都做不了） |
| `src/index.ts` | `apply()` 拆成 wrapper + `applyReady()`：捕获数据库错误后走 `applyDegraded()`——**不注册任何路由/工具/提醒调度**（数据不可信），但照常注册 `systemPrompt` 告警，让 AI 会话里直接能看到"工作台已停用 + 怎么修" |
| `test/hostDegrade.test.mjs`（新） | 6 项回归：库比插件新时 `apply` 不抛错且零注册、告警落地且写明双向版本与修复命令、`announceToAgent=false` 时不注册告警段、正常库仍走完整装配、迁移失败不泄漏句柄 |
| `scripts/check-installed-version.mjs`（新） | 自查门禁：比对**装盘版本 / profile 声明 / 锁文件解析值 / 数据库 schema / 插件支持 schema**，在重启前抓住回退 |
| `package.json` | 新增 `test:local`（只跑两项本地契约/加固测试，免重建） |

**降级后的行为**：插件本体加载、路由与工具为零、提醒不启动、AI 会被告知工作台不可用及修复方法；`ctx.logger.error` + `console.error` 双通道告警。

**注意**：`migrate()` **仍然拒绝**更新的库（不能悄悄读脏数据），只是失败被 `apply()` 接住了。

---

## 4. 防复发

**① 装插件前先跑门禁**（关键：pnpm 回退是静默的，装完不报错，直到重启才炸）

```sh
node D:/Code/Linksight/dsh-workbench/scripts/check-installed-version.mjs
# 退出码 0 = 一致，可安全重启；1 = 有回退或 schema 风险
```

**② 想让 Windows 跟着开发树走**：像 WSL 侧那样改成本地 tgz 依赖，避免 npm 版本被锁文件拉走：

```
file:D:/Code/Linksight/dsh-workbench/delyo-dsh-personal-workbench-<version>.tgz
```

**③ 发布纪律**：本插件 1.13.3（npm 版）**不含**本次加固，也不含 2026-09-12 的侧栏入口家族契约修复——两者都还在本地源码树。要让它们生效必须重新构建并发布/安装。
