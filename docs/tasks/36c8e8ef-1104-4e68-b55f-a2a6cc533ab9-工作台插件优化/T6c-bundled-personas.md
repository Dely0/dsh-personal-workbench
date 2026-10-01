# 内置角色扩到 15 篇（把 LS-Skills 的 9 篇领域角色并进插件）

日期：2026-10-01。范围：随包内置角色库从 **6 篇**扩到 **15 篇**。

## 用户要求

> 你把 LS-Skills 里面的几个角色 persona 也加载到工作台插件中去

已确认：**9 篇全搬**，且**按 MIT 要求把署名链一起带过去**（不发布、不打包，只落盘到本地 profile 供验收）。

## 做了什么

### 1. 新增 9 篇领域角色（正文**零改动**）

从 `D:\Code\Linksight\LS-Skills\personas\` 复制（逐文件 SHA-256 校验一致）：

| 落位 | 篇数 | 来源 |
|---|---|---|
| `assets/personas/domain/engineering/` | 7 | dotnet 3 篇（高级 .NET/Blazor 工程师、.NET 代码审查官、.NET 性能与并发诊断师）+ rf 4 篇（天线测量、电磁仿真与暗室测量、微波电路与 VNA、仪表回路与测量链） |
| `assets/personas/domain/testing/` | 2 | rf 2 篇（测量不确定度预算、计量溯源与校准） |

**格式原生兼容**：`src/personas/parse.ts` 的文件头写着"与公司 `LS-Skills/personas/` 完全对齐，零改动可读"，
所以正文一个字没改。分区从 LS-Skills 的 `dotnet/` + `rf/` 调整为 `engineering/` + `testing/`
（对齐每篇元信息块里声明的 `分类`）。

### 2. 内置库分成两个来源区

```
assets/personas/
  generic/   6 篇  本项目自写的通用工作方式型角色（原样搬入，正文未改）
  domain/    9 篇  公司领域岗位角色（新）
```

**为什么必须分区**：`test/packageManifest.test.mjs` 里有一条判据写死
"内置角色是自写通用内容，**不含** `LS-Skills`/`天线测量`/`VNA`/`K-Dense` 等领域岗位关键词"，
用来证明"内置库没有被公司素材污染"。用户这次要的正是把这些搬进来，所以那条判据：

- **不能原样留着**（会和事实打架）；
- **也不能直接删**（删掉就丢了"通用库不许被公司素材污染"这条真实约束）。

改法是**一分为二**，按目录分区各自施加对应规则：

| 判据 | 盯什么 |
|---|---|
| 通用区黑名单（**一字未改**） | `generic/` 里不许出现任何公司领域岗位名或上游关键词 |
| 领域区署名（**新增**） | `domain/` 每篇必须逐条登记在 `THIRD_PARTY_NOTICES.md`；两个上游名必须出现；两份 MIT 全文必须在 `package.json` 的 `files` 里 |

### 3. MIT 署名链（法律义务，不是可选项）

两个上游都是 MIT，允许再分发与修改，条件是**在副本中保留版权声明与许可全文**。
插件是公开 npm 包，随包分发正好落在这个条件下。履行方式：

- 新增 `LICENSE-novotnyllc-dotnet-artisan`（`Copyright (c) 2026 Claire Novotny LLC`）
- 新增 `LICENSE-K-Dense-scientific-agents`（`Copyright (c) 2026 K-Dense, Inc.`）
- `package.json` 的 `files` 加入这两个文件（**否则发布了也等于没带**）
- `THIRD_PARTY_NOTICES.md` 新增 §Bundled expert personas：逐篇登记路径、上游仓库、commit、
  版权人、以及"我们改了什么"（dotnet 3 篇=合并改写；rf 6 篇=中文重写并拆分 `metrology-scientist`）

### 4. 顺带修掉两个真实问题

| 问题 | 现象 | 修法 |
|---|---|---|
| 分组名泄漏内部术语 | 界面显示 `domain 9 个角色` / `generic 6 个` | `shared/persona.ts` 加 `personaGroupLabel()`（→ `领域岗位` / `通用工作方式`）与 `personaGroupRank()`（通用在前）；`groupPersonas()` 输出 `label`。**只改显示**：目录名、角色 id、`group` 键一律不动（它们是收藏/停用/会话绑定记录里的持久键） |
| 验收链假红（第二次） | `progress` 套件整链跑时 8 条红，单独跑 13/13 全过 | 面板入口是**开关**，多个套件写成"点一下 → 断言已打开"，前一套件把面板留在开态时这一下反而关掉。新增幂等辅助 `ensureWorkbenchPanel()`（先读状态、必要时才点、点完等它真开），接线到 4 个套件 |

## 验证

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | 0 |
| `pnpm test` | **900 条 / 899 通过**（唯一失败 = `test/db.test.mjs` 清理期 EPERM，Windows 预存问题） |
| 验收链（实跑） | **102 passed / 0 failed / 1 skipped**（persona 模型层按规格记未验证）；`clientMatched true` |
| 真机实测（隔离实例 3080） | 接口返回内置角色 **15 篇**；设置页分组 `通用工作方式 6 个角色` → `领域岗位 9 个角色`；选择器同上；`rowCount=15` |
| 逐文件哈希 | 9 篇复制件与 LS-Skills 源文件 SHA-256 完全一致（正文未改） |

## 未做

不加版本号、不打包、不发 npm、不打 tag、不推远端；未装到桌面端 19387（仍跑公开发布版）。
