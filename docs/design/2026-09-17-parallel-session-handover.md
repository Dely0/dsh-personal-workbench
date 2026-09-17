# 并行开发交接说明：容量规则透明化 × 知识草稿覆盖可见性

任务：`7d9bb4ec-6400-44df-b14d-6e445f0203b8`（feature_opt / p2）
写完时间：2026-09-17（基线 `main` @ `03fcdb5`）

> **为什么有这份文档**：本机**同时有两个会话在改同一个本地仓库**。
> 同一份文件被两边各改一遍、再靠"手动合并"补救，是本项目最容易出事的地方
> （`.dsh/skills/dsh-plugin-change` 第 0 节：同一个语义被独立计算多次 / 删改混在一起无法归因）。
> 所以这里把**物理隔离方式**与**文件级归属**先写死，再谈怎么合。

---

## 一、当前物理隔离（已经生效，不是计划）

| | 会话 A（本会话：容量） | 会话 B（另一个会话：知识草稿） |
|---|---|---|
| 分支 | `feat/capacity-rules-transparency` | `fix/knowledge-draft-overwrite-visibility` |
| 工作目录 | `E:\Code\dsh-personal-workbench\capacity-wt`（**独立 git worktree**） | `E:\Code\dsh-personal-workbench\dsh-personal-workbench`（主工作区） |
| 起点 | `main` @ `03fcdb5` | 同 |
| 未提交改动 | 在 worktree 里，主工作区看不到 | 在主工作区里，worktree 看不到 |

验证隔离：

```powershell
git worktree list
# E:/Code/dsh-personal-workbench/dsh-personal-workbench  03fcdb5 [fix/knowledge-draft-overwrite-visibility]
# E:/Code/dsh-personal-workbench/capacity-wt             03fcdb5 [feat/capacity-rules-transparency]
```

**为什么必须用 worktree 而不是 `git switch -c`**：`git switch -c` 会把当前工作区**未提交的改动一起带走**
（两边会互相污染，且 A 分支上会混进 B 的脏文件）。worktree 是**另一份检出**，
两边各自 `build` / `test` 也不打架 —— 这很关键，因为 `pnpm build` 会先 `rmSync('lib')`，
两个会话在同一个目录里同时跑测试会互相把对方的 `lib/` 删掉。

**合并/收尾方式**（谁先完谁先合，另一边 rebase）：

```powershell
# 在主工作区执行（⚠️ 先确认自己的工作区干净，或先 commit）
git switch main && git merge --ff-only feat/capacity-rules-transparency
# 完成后可移除 worktree（它的分支内容已合并，不会丢）
git worktree remove E:\Code\dsh-personal-workbench\capacity-wt
```

若 `--ff-only` 失败（两边都从 `03fcdb5` 出发、谁也没先合），就先合一方，另一方
`git rebase main`。**冲突面极小**，因为下面的文件归属基本不重叠。

---

## 二、文件级归属

### 会话 A 独占（新建，B 完全不会碰）

- `src/client/capacity.ts` —— 容量算法唯一权威源（纯函数）
- `src/client/components/CapacityRulePanel.tsx` —— 规则 / 账本 / 开关面板
- `test/capacity.test.mjs`、`test/capacityWiring.test.mjs`
- `test/fixtures/capacityFixture.mjs`
- `scripts/repro/probe-capacity-mutations.mjs`、`verify-capacity-fixed-dataset.mjs`、
  `measure-capacity-baseline.mjs`、`verify-capacity-review-claims.mjs`、`repro-task-estimate.mjs`
- `docs/design/2026-09-25-capacity-rules.md`（交付文档；`-plan.md` 是咨询会话留下的方案，两边都别改）

### 会话 B 独占（本会话一行不改）

- `src/shared/knowledgeDraftOverwrite.ts`
- `test/knowledgeDraftOverwrite.test.mjs`
- `src/tools.ts` 里 `submitKnowledgeTool` 那一段
- `test/tools.test.mjs`

### ⚠️ 共享文件（唯一有冲突风险的地方，逐个写清归属行）

| 文件 | 会话 A 改了哪里 | 会话 B 改了哪里 | 冲突评估 |
|---|---|---|---|
| `src/client/index.tsx` | ① 顶部 import 加一行 `./capacity.js`<br>② `estimateRangeMessage()` 模块级函数（约 124 行处）<br>③ `settings` 初值（约 745 行）加两个键<br>④ `saveEditDraft`（约 1742 行）整体改写<br>⑤ 约 1990 行：旧内联容量块 → `useMemo(computeTodayCapacity)`<br>⑥ 详情页加「预计耗时」行（约 3320 行）<br>⑦ 编辑弹窗加耗时/全天两字段（约 3776 行）<br>⑧ 新建表单加同两字段（约 3741 行）<br>⑨ `createTask` 的 payload 加两字段 | 本会话未改 `index.tsx`（截至写此文档） | **无重叠**。若 B 之后要改同一个函数（如 `saveEditDraft`），请先看本分支版本 |
| `src/shared/contracts.ts` | `WorkbenchSettings` 末尾追加两个字段<br>`defaultEstimateMinutes` / `dailyCapacityIncludeOverdue` | 未改 | 追加式，不会冲突 |
| `src/api/routes.ts` | ① 加 `DEFAULT_SETTINGS_ESTIMATE_MINUTES` 等常量 + `readDefaultEstimateMinutes()`（约 45 行）<br>② `readWorkbenchSettings()` 返回值末尾追加两键<br>③ `POST /settings` 末尾追加两段写 meta | 未改 | 追加式 |
| `src/api/routes/tasks.ts` | 约 95 行 `estimatedMinutes` 改为 `clampEstimateForStorage(...)` | 未改 | 单行 |
| `src/api/routes/helpers.ts` | 加常量 + `clampEstimateForStorage()`；`taskInputFromBody` 里 `estimatedMinutes` 改走它 | 未改 | 单块 |
| `tsconfig.build.json` | `include` 里加 `src/client/capacity.ts`（+ 之后的 `CapacityRulePanel.tsx`） | 未改 | 单行追加 |
| `src/index.ts` | 未改 | **已改** | 只有 B 改，安全 |
| `src/tools.ts` | 未改 | **已改** | 只有 B 改，安全 |
| `test/routes.test.mjs` | 会追加 `estimatedMinutes` 夹取 + 两个设置键的用例 | 未改 | 追加式 |
| `test/fixtures/`（目录） | 新建 `capacityFixture.mjs` | 未涉及 | 目录级新建 |

**结论**：两边**没有一行是同一个位置**。真正需要小心的只有两件：

1. **`test/routes.test.mjs` 这类"已经很大的共享测试文件"**：两边都往里追加时代码不会冲突（各在文件末尾），
   但**名字可能撞车**（都叫 `xxx 夹取`）。约定：会话 A 的用例名统一带 `[容量]` 前缀，便于区分。
2. **谁先合谁的重建**：`tsconfig.build.json` 的 `include` 是白名单，合完各自跑一次
   `pnpm typecheck && pnpm test` —— 白名单缺文件会让 `test/` 直接 `ERR_MODULE_NOT_FOUND`。

---

## 三、本会话（A）的进度台账

见 `docs/design/2026-09-25-capacity-rules.md` 的「实施进度」一节（每个阶段完成即更新），
以及任务共享记忆里的 `[summary]` 记录。**提交策略**：每阶段一个提交，提交信息写清阶段号与验收命令。

| 阶段 | 状态 |
|---|---|
| P1 纯函数 + 基准/等价性测试 + 变异探针 | 进行中 |
| P2 规则面板（规则/账本/开关）+ 接线测试 + harness **容量批** | 待办 |
| P3 编辑弹窗耗时/全天 + 校验 + 乐观更新 + 详情行 + 新建表单 + 服务端夹取 | 待办 |
| P4 设置页两偏好（默认耗时 / 逾期口径） | 待办 |
| P5 修前修后对照 + 交付文档 + 门禁 | 待办 |

> `scripts/repro/harness-real-browser.mjs` 是**两边都可能想改**的文件（B 的知识库列表也用它）：
> 本会话只做**参数化（加 `--case`）+ 新增容量批**，不改既有用例；B 若要加自己的批，
> 各加一个 `--case`，不要动对方的批。

---

## 四、给另一个会话的三条请求

1. **请在主工作区继续**（`E:\Code\dsh-personal-workbench\dsh-personal-workbench`），
   不要进 `capacity-wt` 改东西 —— 那是另一份检出，改了不会被你的 `git status` 看到。
2. **不要动**上面「A 独占」清单里的文件。若确实需要（例如想复用 `clampEstimatedMinutes`），
   直接说，由本会话把它挪到共享位置（两侧各留一份同构实现 + 跨模块等价性断言，
   是"客户端与宿主是两个编译容器"下的既定做法，见 `src/api/routes/helpers.ts` 的注释）。
3. **不要跑 `scripts/dev-install.mjs --apply`**。装盘会把 `profiles/web/package.json`
   指到某一个会话的 tgz 上 —— 两个会话各装一次会互相覆盖，且**回滚点会被冲掉**。
   装盘需要用户显式授权，届时由用户决定装哪一个。
