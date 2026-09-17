# 交接说明：知识草稿覆盖可见性（会话 B）

> **对端文档**：会话 A（容量规则透明化）已写了一份**联合**交接说明
> `docs/design/2026-09-17-parallel-session-handover.md`（在它的 worktree 里、未提交）。
> **本文档只做两件事**：① 补上它写完之后我这边的**实际改动面**（它当时把我标成"未改"的两个文件，
> 我后来改了）；② 给出精确的合并顺序与验收命令。**不重复它已经写好的内容。**

- 任务：`f4a3430f-3f81-42e8-b4e5-2bf3e67be3e1`（知识草稿静默覆盖：提示 + 文字说明）
- 分支：`fix/knowledge-draft-overwrite-visibility`
- 工作目录：`E:\Code\dsh-personal-workbench\dsh-personal-workbench`（**主工作区**）
- 基线：`main` @ `03fcdb5`（与会话 A 同一个起点）
- 提交：见本文档末尾「提交清单」

---

## 一、物理隔离（已生效）

```powershell
git worktree list
# E:/Code/dsh-personal-workbench/dsh-personal-workbench  5xxxxxx [fix/knowledge-draft-overwrite-visibility]   ← 本会话（B）
# E:/Code/dsh-personal-workbench/capacity-wt             03fcdb5 [feat/capacity-rules-transparency]           ← 会话 A
```

两边是**两份独立检出**，各自 `pnpm build` 不会互删对方的 `lib/`
（`pnpm build` 第一步是 `rmSync('lib')` —— 这就是当初必须用 worktree 而不能用 `git switch -c` 的原因）。

---

## 二、会话 B（本文档）**实际**改动的文件

### 新建（A 完全不会碰）

| 文件 | 作用 |
|---|---|
| `src/shared/knowledgeDraftOverwrite.ts` | 判定/回执/界面提示的**唯一权威源**（纯函数，不含 node: 依赖） |
| `src/client/components/KnowledgeDraftBody.tsx` | 知识草稿弹窗正文（含覆盖提示），可测组件 |
| `test/knowledgeDraftOverwrite.test.mjs` | 判定表 + 回执措辞 + 界面提示 + 接线扫描（15 条） |
| `scripts/repro/repro-knowledge-draft-overwrite.mjs` | 真机实测 23 项（真实库只读副本 + 真组件真样式 headless Edge） |
| `scripts/repro/probe-knowledge-draft-overwrite-mutations.mjs` | 变异探针 19 条，要求全红 |
| `docs/issues/2026-09-17-knowledge-draft-silent-overwrite.md` | 事故/修复记录 |

### 修改（**逐行归属**）

| 文件 | 本会话改了哪里 | 与会话 A 的关系 |
|---|---|---|
| `src/tools.ts` | 只在 `submitKnowledgeTool`：description 补约束段；`execute` 里加 `previousTitle` / `planKnowledgeDraftWrite` / `withKnowledgeDraftHistory` / `knowledgeDraftWriteMessage`；顶部多一行 import | A 声明未改 → **无重叠** |
| `src/index.ts` | 只改 `WORKBENCH_GUIDANCE` 里「知识库：…」那一行（**单行**，追加一段说明） | A 声明未改 → **无重叠** |
| `src/client/components/DraftBanner.tsx` | 只改 `describeDraft` 的 `if (draft.kindCode === 'knowledge')` 分支：body 换成 `<KnowledgeDraftBody …/>`；顶部多一行 import | A 声明未改 `DraftBanner.tsx` → **无重叠** |
| `test/tools.test.mjs` | 只改既有用例 `agent tools write pending drafts and update tasks` 里知识草稿那一段 | A 声明 `test/routes.test.mjs` 才是它要追加的 → **无重叠** |
| **`tsconfig.build.json`** | `include` 里**加一行** `"src/client/components/KnowledgeDraftBody.tsx"` | ⚠️ **A 也改这个文件**（加 `src/client/capacity.ts` 等） |

### ⚠️ 唯一的重叠点：`tsconfig.build.json`

会话 A 的交接文档里把这一行标成「B 未改、单行追加、无重叠」——**那是我改之前的快照**。
实际两边都在 `include` 数组里各加自己的文件。**冲突面仍然极小**（同一数组、不同元素），
但**不要**用"整份文件取一边"的合并法（会丢掉另一个会话的白名单 → `test/` 直接
`ERR_MODULE_NOT_FOUND`）。正确做法见下。

---

## 三、合并建议（谁先完谁先合）

```powershell
# 1) 各自先在自己工作区把改动提交干净（两边都别留未提交改动再切分支）
# 2) 后完成的一方，先 rebase 到先合并后的 main：
git -C E:\Code\dsh-personal-workbench\dsh-personal-workbench switch main
git -C E:\Code\dsh-personal-workbench\dsh-personal-workbench merge --ff-only <先完成的分支>

git -C E:\Code\dsh-personal-workbench\capacity-wt fetch            # 共享同一 .git，fetch 可省
git -C E:\Code\dsh-personal-workbench\capacity-wt rebase main      # 或反向
```

`tsconfig.build.json` 若报冲突：**保留两边的新增行**（合并结果里应同时含
`src/client/components/KnowledgeDraftBody.tsx` 与 `src/client/capacity.ts`），然后：

```powershell
pnpm typecheck          # 白名单缺文件只有真正 build 时才炸
pnpm build
node --test test/*.test.mjs
```

## 四、复核本会话做了什么的验收命令

```powershell
pnpm build
node --test test/knowledgeDraftOverwrite.test.mjs test/tools.test.mjs   # 15 + 3 条
node scripts/repro/probe-knowledge-draft-overwrite-mutations.mjs        # 期望 19/19 全红
node scripts/repro/repro-knowledge-draft-overwrite.mjs                  # 期望 23/23
```

> `repro-…mjs` 会在 `_local-archive/knowledge-draft-overwrite/` 下留一份**真实库的只读副本**
> 与截图；它**不碰**真实库、也不碰用户任何草稿（会话 id 用一次性的 `repro-overwrite-…`，
> 跑完删净）。别把它当成"清库脚本"。

## 五、给会话 A 的两条请求（重复它文档里的第 1、3 条，因为都踩得到）

1. **别进主工作区改东西**，也别在主工作区 `git switch` —— 主工作区当前 HEAD 是本分支，
   切换会把本分支的未提交状态搅乱（反之亦然）。
2. **别跑 `scripts/dev-install.mjs --apply`**：装盘会改 `profiles/web/package.json`
   并指向某一个会话的 tgz，两个会话各装一次会互相覆盖且冲掉回滚点。需要装盘时由用户显式授权。

## 六、本会话的未完成 / 边界（如实记录）

- **未装盘、未推送远端、未 bump 版本号**（仍 1.15.1）。
- **未重启 DSH**：本改动含服务端部分（工具说明与回执）与客户端部分（弹窗提示），
  跑中的宿主仍服务旧 bundle —— 界面上的新提示要**装盘 + 重启 + Ctrl+F5** 才看得见。
  本次交付的"界面可见"证据来自真组件 + 真样式 + headless Edge（不是跑中的宿主）。
- 主工作区里还留着**上一轮会话**的未跟踪文件（`docs/design/2026-09-25-capacity-rules-plan.md`、
  `scripts/repro/measure-capacity-*.mjs`、`verify-capacity-*.mjs`、`test/fixtures/`）——
  **不是本会话产物，本会话一个字节都没动它们**，也没有 `git add` 过。
  `test/fixtures/` 与会话 A 的 `capacityFixture.mjs` 同名目录，A 合入时以它的版本为准。

## 七、提交清单

| 提交 | 内容 |
|---|---|
| `53e78fe` | 主体：唯一权威源 + 回执区分三态 + 历史落库 + 弹窗提示 + 说明文案 + 测试/探针/实测脚本/事故文档 |
| `53e78fe` 之后的**分支头**（含本文档的那次提交） | 补「重复提交相同内容 → unchanged」这一态（避免假的丢件告警）+ 逐字段差异测试 + 探针 M16–M18 + 本文档 |

> 分支头会随提交推移，故这里不写死哈希：用 `git log --oneline fix/knowledge-draft-overwrite-visibility` 看。
> 上一行 `53e78fe` 是主体提交，内容不会再变。
