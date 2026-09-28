# Fork 调研与可执行结论（2026-09-15）

> **给任务执行 AI 的话**：这份文档是**调研结论 + 执行清单**，不是代码。请按第 5 节的顺序做，
> 第 6 节是**禁止照抄**的名单（照抄会把一个安全隐患引进来）。所有结论都标了出处：
> ✅ = 我逐行读过源码；⚠️ = 来自 fork 的实现细节，未在本仓复现。

---

## 0. TL;DR

1. 8 个 fork 里 **7 个是纯镜像**（只跟版不干活），真正有内容的只有 **`Guojing6/dsh-workbench`**（39 个独有提交）
   与 `zf321` 的一条多租户分支（**对本仓不适用**，见第 4 节）。
2. 没有任何 fork 提过 PR；他们只提 issue（`#1`/`#2` 已闭，**`#3` 至今 open**）。
3. Guojing6 的东西**整体值得吸收**，但**不能字面全抄**（他基于 1.10.1，我们已 1.15.0 且代码已拆分）；
   且他的附件解析里有一个**解压炸弹（OOM）隐患，必须重写护栏**（第 3.6 节）。
4. 他的改动**顺手修掉了我们至今仍存在的两个真 bug**（第 3.7 节）——这条比功能本身更值钱。

---

## 1. 调研方法（含一个必须避开的误判）

```powershell
gh api /repos/Dely0/dsh-personal-workbench/forks                     # 谁 fork 了
gh api /repos/Dely0/dsh-personal-workbench/compare/<我方main>...<owner>:<branch>
gh api /repos/<fork>/branches                                        # 活可能在非默认分支上
gh api /repos/Guojing6/dsh-workbench/commits/<sha>                    # 单个提交自己的 patch
```

⚠️ **`compare` 返回的 `files` 是「merge-base → 该 fork head」的 diff**，不是"对方相对我们的改动"。
因为 merge-base 很老，**我们自己 fork 点之后新增的文件也会被算成对方的"新增"**（实测：
`docs/issues/2026-09-09-subtask-plan-duplicate-tree-and-estimated-minutes.md` 我们本来就有）。
**判定"对方独有"只能按提交标题逐条比对我方 `git log`。**

对比结果（GitHub 报的 ahead → 真正独有）：

| fork | ahead | 其中是我方提交（rebase 带入） | 真正独有 |
|---|---|---|---|
| Guojing6/dsh-workbench | 46 | 7（作者 `DSH Agent`，SHA 不同标题相同） | **39** |
| zf321（`feat/erpm-multi-tenant`） | 8 | 0 | **8** |
| tujunwenjie（`fix/sidebar-entry-family`） | 3 | 0 | **3** |

复现脚本（`.pwtest/`，gitignored）：`survey-forks2.mjs`、`classify-fork-commits.mjs`、
`survey-fork-branches.mjs`、`fetch-guojing6-commits.mjs`、`show-commits.mjs`。
数据落盘：`forks-survey.json`、`guojing6-compare.json`、`fork-branches.json`、`guojing6-own-commits.json`。

---

## 2. 全量结论

| fork | 状态 | 独有提交 | 结论 |
|---|---|---|---|
| **Guojing6**（改名 `dsh-workbench`） | 基于 1.10.1 | 39 | 见第 3 节，**本次唯一要吸收的** |
| zf321（`feat/erpm-multi-tenant`） | 主线跟到 1.14.59 | 8 | 多租户 + 个人 MCP，**团队定制，本仓不适用**（第 4 节存档） |
| tujunwenjie（`fix/sidebar-entry-family`） | 基于 1.13.3 | 3 | 侧栏入口家族；**已被我们 v1.14.53 的官方槽位路线取代**，不可合并（`clientInvariants` I5 会拦） |
| abcde55555 / everclear077 / louishzwang / sharebio / keyzf / 上两行的 main | 纯镜像 ahead=0 | 0 | 只跟版 |

- **PR 数：0。** Issue：`#3`(open, tujunwenjie，我们 09-13 回复"无法修复"，实际已由路线变更解决)、`#2`(closed, Guojing6)、`#1`(closed, lhmhz)。
- 没有任何 fork 发布到 npm，也没有被 dsh-market 收录。

---

## 3. Guojing6 深挖（39 个独有提交）

### 3.1 任务资料夹规矩（本次最值得吸收的一条）

**我们现在的做法**（✅ 读的是本仓代码）：

- 任务没填工作区时，按**任务标题**建文件夹：`<默认工作区>/<标题前 24 字>`（`src/client/format.ts` 的 `folderForText`）。
- 澄清阶段（任务还没建出来）按**用户打的那句话**建文件夹（`index.tsx` 里 `folderForText(text || '需求澄清')`）。
- 每开一次 AI 会话都会：调 `/api/workbench/workspaces/ensure` → `runtime.workspaces.create()` 注册一个工作区 → 绑给会话 → 回写任务。

**本机真实数据（证据，用 `node:sqlite` 只读查的）**：74 个任务（归档 26），29 个带 `workspace_path`，其中
**3 个是标题型自动路径**（`<任务根目录>\<任务标题>` 形态，由插件自动建）、
**26 个是用户手填的真实项目目录**（形如 `<代码根>\<某仓库>`）；设置里
`ai_default_workspace = <任务根目录>`、`auto_create_type_folders = 1`。

**他改成四条**（✅ 读过每个提交的 patch）：

1. **文件夹名 = 任务 ID**。两个纯函数，可直接抄（含测试）：
   ```ts
   taskWorkspaceFolderName(taskId)      // 只留 A-Za-z0-9_-；空则 'task'
   isAutoTaskWorkspacePath(path, taskId) // 路径是否以"该任务的 ID 文件夹"结尾
   ```
   解决的三个真实毛病：改标题文件夹成孤儿；同名任务挤同一文件夹；标题里的中文/特殊字符直接变成目录名。
2. **不再为每个任务注册 AI 工作区**。删掉 `workspaces.create` + `/workspaces/ensure` 那一整段，
   会话**直接用当前工作区**，改为在提示词里声明：
   > 工作区根目录：X；任务资料夹：X/&lt;任务ID&gt;；相对路径 ./&lt;任务ID&gt;/；
   > 如需创建或修改本任务相关文件，请放在这个资料夹里，不要在工作区根目录散放文件。
   动机：任务一多，宿主的**工作区列表会被任务撑爆**。
3. **自动 vs 手填要能区分**：只有 `isAutoTaskWorkspacePath` 为真的路径，才允许在默认根目录变更时**迁移/改写**；
   用户手填的永不触碰（对应本机那 26 个真实项目目录）。
4. **任务 ID 提前预留**：澄清阶段客户端先 `crypto.randomUUID()` 生成 ID 带进提示词，草稿确认时复用
   （`createTask` 支持 `input.id`；`confirmTaskDraft` 读 `payload.id ?? payload.taskId`），因此删掉了
   "澄清资料夹"特殊分支。斜杠命令侧同法（服务端先建目录再交给 AI）。

配套细节：默认根目录服务端兜底 `~/Documents/aitasks` 并自动创建；设置保存时先 `mkdir`，失败返回 400；
客户端每次开 AI 会话前**重拉一次 settings**（我们现在只在面板挂载时拉一次，改了默认目录不即时生效）。

**⚠️ 抄之前必须补的一条**：本机那 3 个标题型路径在 `isAutoTaskWorkspacePath` 口径下**不以任务 ID 结尾**
→ 会被判成"用户手填"→ 永不迁移。所以要么加一条兼容判据（"以 `folderForText(标题)` 结尾"也算自动生成），
要么写一次性迁移脚本（改名/搬迁可选，至少判据要兼容）。

**建议的改良**：纯 UUID 文件夹人不好认。可折中为 `<任务ID>-<标题片段>`，判定只看 ID 前缀——
稳定 + 可读兼顾。这是我们在他方案上的改良，不是照抄。

### 3.2 快录附件

**(a) 图片**（✅ 读过 fork 的 patch；✅ 在宿主代码里核过判定口径）

- 客户端构造宿主公开类型的内容片段：`{ type:'image', mediaType:'image/png|jpeg|webp|gif', data: base64, name? }`，
  然后 `binding.session.prompt([...imageParts, {type:'text',text}], 'queue')`。
- 走**宿主原生多模态管线**，**不依赖任何视觉插件**。
- 客户端的护栏：只收 4 种 MIME、最多 10 张、移除时 `revokeObjectURL`（无泄漏）。
- **重要事实（本次先搞错过，已核实纠正）**：宿主按模型**显式声明**的输入能力判定 ——
  `inputModalities === undefined || !includes('image')` 就拒收/替换成
  `[image omitted because this model accepts text only; attachment sha256:…]`。
  本机模型目录（`dsh-llm-deepseek`）里：
  - `deepseek-flash`（DeepSeek-**V41**-Flash）：`inputModalities: ["text","image"]` → **图片可用** ✅（本机默认就是它）
  - `deepseek-v4-flash` / `deepseek-v4-pro`：**没有声明** → 会被拒/替换
  → **所以图片功能对我们是真实可用的**；而模型选择器的价值之一就是"别选到不收图的模型"。

**(b) PDF / DOCX**（✅ 读过 fork 的实现）

- 路由 `POST /api/workbench/quick-attachments/extract-text`，请求 `{name,mediaType,data(base64)}`
  → 响应 `{ok,name,mediaType,content,truncated,size}`。
- DOCX：从尾部回扫 EOCD → 遍历中央目录 `0x02014b50` 按名精确取 `word/document.xml` → method 0 直取 / method 8 `inflateRawSync`。
- PDF：整份 `toString('latin1')`，正则扫 `<<…>>stream…endstream`，`/FlateDecode` 走 `inflateSync`，
  `DCT/JPX/CCITTFax` 跳过，抽 `(…)Tj` 与 `[…]TJ`，`decodePdfLiteral` 解 `\n`/`\ooo`。
- 客户端把结果拼成 `附件：名（内容已截断）\n"""正文"""` 塞进澄清提示词。
- 现有护栏：loopback-only、请求体 ≤5MiB×4/3+64KiB、解码后 ≤5MiB、文件名/扩展名白名单、
  正文截 24000 字符并回 `truncated`、失败返回 400 中文原因。
- ⚠️ **但这套护栏不够，见 3.6。**

### 3.3 模型选择器

- 列表来自客户端注入的 `modelDirectories.directoryFor(sessionId)`（`load()` 拉目录、`select()` 落选）；
  选中值存 localStorage `dsh-workbench.quickModelSelection`（**本仓应换成自己的前缀**，如
  `dsh-personal-workbench.quickModelSelection`），**含 reasoning effort**（取 `model.reasoning.defaultEffort`），
  在 clarify 会话建好后、`prompt` 之前调用 `directory.select({provider,model,reasoningEffort})`。
- 降级：服务缺失或 `directoryFor` 抛错 → 上报不崩；空列表提示「暂无可用模型」；`null` = 跟随 DSH 默认。
- ⚠️ **抄之前必须先定策略**：`modelDirectories` 是**宿主较新的服务**，写进 `inject` 会让旧宿主上插件整体 pending；
  而本项目规范是"前置条件进 inject、可选增强软探测"，同时**未声明 inject 的服务软探测恒为 undefined**。
  两条规则在这里冲突，必须先做决策（候选：加进 inject 并同步提升 `MIN_HOST_VERSION`；或按版本分支降级）。
- 他的实现还有两个小瑕疵可以顺手改好：列表取的是**当前会话**的 directory 而选中应用到**新建**会话（语义错位）；
  只能取 `defaultEffort`，选不了其它档。

### 3.4 `/workbench` 斜杠命令

- 注册侧（✅）：host `inject` 加 `commands`、peer 加 `@deepseek-ai/dsh-commands`，
  然后 `ctx.effect(() => ctx.commands.register({ name:'workbench', description, input:{hint:'<任务文字>'}, handler }))`。
- handler（✅）：`({agent,rawInput})`；空输入返回 `{kind:'error'}`；否则
  `agent.steer(createUserMessage({ content:[{type:'text',text:`${PROMPT}\n${text}`}], source:{kind:'user'} }))`，
  `PROMPT` 约束澄清轮数与"只能 `workbench_submit_task`"。
- ⚠️ **别照抄他自己写的 `/` 补全浮层**（`installWorkbenchSlashMenu()`：document 捕获一堆事件 + 定位
  `textarea[data-phase]` + 手动预填）。宿主已有 `ctx.commandUi`（`dsh-client-ui-commands`：`register`/`decorate`），
  host 注册的命令**本来就会进原生 `/` 菜单** —— 自建浮层是重复实现，定位/主题都易碎。
- ⚠️ peer 版本别写他那个 `^0.0.1-rc.1`，对齐我们现装的 `0.1.5-rc.1`（本仓 `MIN_HOST_VERSION` 已是该值）。
- 他的命令 `input` 没声明 `attachments:true`，所以命令侧带图会被宿主拒 —— 图片只能走快速录入。

### 3.5 其它可抄的小项

- **4 份请求围栏合并成 1 份**（`isLoopbackRequest` / `writeJson` / `readJsonBody`）。本仓现状（✅ 逐字比对过）：
  `src/api/dictionaryRoute.ts`、`localDirRoute.ts`、`openFileRoute.ts`、`src/api/routes/helpers.ts`
  各一份，**目前 4 份完全相同、尚未漂移** —— 所以这是"防未来漂移"的卫生改进，不是正在发作的 bug。
  他顺手给 `writeJson` 加了 `cache-control: no-store` 与 `x-content-type-options: nosniff`。
- `health` 报真实版本 —— **我们早已有**（`ff6e82e`），不必抄。
- 工具参数兼容"模型把 json 参数传成字符串" —— 我们也已修过同类。

### 3.6 ⚠️ 安全发现（必须重写护栏，不可照抄）

fork 的解压实现（✅ 逐行读过）：

```ts
// DOCX
if (method === 8) return inflateRawSync(data, { finishFlush: 2 }).subarray(0, uncompressedSize)
// PDF
try { data = inflateSync(data) } catch { continue }
```

三个错叠加成**解压炸弹（OOM/DoS）**：

1. 两处 inflate **都没传 `maxOutputLength`**；
2. `uncompressedSize` 是**从 zip 中央目录读出的、攻击者可控**的字段；
3. `.subarray(0, uncompressedSize)` 发生在**解压之后** —— 内存里已经躺着整份膨胀结果。

请求体上限 5 MiB、deflate 最大压缩比约 1032:1 ⇒ **一个 5 MB 的恶意 .docx 足以打爆主进程内存**。
端点是 loopback-only，但攻击路径很现实：**别人发你一个文档，你拖进快速录入**。

**正确写法**：
```ts
const MAX_UNCOMPRESSED = 32 * 1024 * 1024
if (uncompressedSize > MAX_UNCOMPRESSED) throw new Error('文档解压后过大')
const out = inflateRawSync(data, { maxOutputLength: MAX_UNCOMPRESSED })
if (out.length > MAX_UNCOMPRESSED) throw new Error('文档解压后过大')
```
另两条同源问题：`Buffer.from(data,'base64')` 是**宽松**的（非法字符静默丢弃、长度不校验），
应像宿主 `admitEncodedImages` 那样先校 canonical；PDF 解析里对每个匹配都
`source.lastIndexOf('<<', match.index)` 回扫是 **O(n²)**，在 5MB 字符串上同样是 DoS 面。

### 3.7 我们至今仍存在的两个真 bug（他的提交顺手修了）

1. `src/client/index.tsx` 里 `let workspaceId = ws.items[0]?.workspaceId` —— **"随手取第一个工作区"**：
   当任务没路径、默认工作区也为空时，会话会挂到列表里第一个工作区上，可能与用户当前连接的完全无关。
   他改成用"当前会话的 cwd / 当前工作区"（提交 `f68366b`、`69b97a3`）。
2. 同一文件里**澄清阶段按用户原话建文件夹**（`folderForText(text || '需求澄清')`）——
   等于拿一句自然语言当目录名；他改成"提前预留任务 ID，用 ID 建资料夹"。

### 3.8 不该抄的（个人定制 / 他自己回退过）

- 品牌三连：包名 `@guojing6/dsh-workbench`、`cordis.patch.yml`、README。
- 默认目录写死 `~/Documents/aitasks`（并与 `~/.dsh/workbench` 分成两套位置）；Windows 查注册表取 Documents 的做法。
- 中途试了又回退的：`ai-workbench` ↔ `dsh-workbench` 命名来回改 3 次；一版 "apple-inspired layout" 全量回退；
  快速录入控件 8 连 polish。
- 他有个提交（`70183ae`）**夹带了与标题无关的改动**（桌面通知后立刻调服务端标记提醒）——
  说明"整体信任他的提交"不成立，必须逐条核（这也是本节的由来）。

---

## 4. zf321（存档，本仓不适用）

`feat/erpm-multi-tenant` 分支，8 个提交（作者 `ZIY00131365`）：多租户（宿主 token 委托验签 + 每用户一个
`workbench.db` + `AsyncLocalStorage` 承载"当前库" + 工作区边界 fail-closed）+ 个人 MCP 服务
（配置存用户库、保存即探测、每次现连现断、agent 侧两个工具）+ 若干客户端修复。
**判定：这是给某个团队做的定制（ERPM 多租户），与本仓"单库唯一权威"的架构冲突，不吸收。**
唯一值得记的两点经验：① 委托宿主验签而不是自建账号；② 它占用的 schema v15 与我们的
`reminder-status-semantics` **撞车**（真要吸收 MCP 必须改 v16）。

---

## 5. 执行清单（建议按序，含验收标准）

> 约束：本仓 `src/api/routes.ts` 已拆成 `src/api/routes/*`、`src/db/repo.ts` 已拆成 `src/db/repo/*`、
> 客户端已拆出 `src/client/components/*`。**fork 的补丁落不下来，要按功能在本仓重做。**

| # | 工作项 | 要点 | 验收标准 |
|---|---|---|---|
| 1 | **修两个真 bug** | `ws.items[0]` 改为"当前会话 cwd / 当前工作区"；澄清阶段不再按原话建夹 | 新增/修改测试覆盖"无路径任务不会落到无关工作区"；`pnpm test` 全绿 |
| 2 | **任务资料夹规矩** | 抄两个纯函数（含单测）；文件夹名用 `<任务ID>`（建议 `<任务ID>-<标题片段>`）；**加老路径兼容判据**（本机有 3 个标题型路径）；默认根目录变更时只迁移自动路径 | `workspacePath.test.mjs` 覆盖 ID 型/标题型/手填型三种；本机 3 个老路径被正确识别为"自动" |
| 3 | **快录附件：PDF/Word** | 落到新文件 `src/api/routes/quick-attachments.ts` 并挂进组合入口；**必须带 3.6 的护栏**（`maxOutputLength` + 解压前声明值校验 + 解压后复核 + canonical base64） | 新增测试：正常 DOCX/PDF 能抽文本；**解压炸弹样本被拒且不 OOM**；超限返回 413/400 中文原因 |
| 4 | **快录附件：图片** | 复用宿主 `PromptContentPart` 构造；4 种 MIME、张数上限与提示；`revokeObjectURL` | 选中 `deepseek-flash`（V41-Flash）时图片能进会话；选中未声明 image 的模型时给出可读提示而不是静默丢弃 |
| 5 | **模型选择器** | **先定 `modelDirectories` 的注入策略**（见 3.3）；选中值前缀用本仓命名；含 reasoning effort | 旧宿主上插件仍能加载（不 pending）；模型切换对下一次澄清生效 |
| 6 | **`/workbench` 斜杠命令** | 用 `ctx.commands.register` + `agent.steer(createUserMessage(...))`；**用宿主 `commandUi`，不自建 DOM 浮层**；peer 版本对齐 `0.1.5-rc.1` | `/` 菜单里出现 workbench；执行后当前会话进入澄清流程 |
| 7 | 4 份围栏合并成 1 份 | 抽 `src/api/http.ts`（含两个安全头） | 4 处改为导入；`pnpm test` 全绿 |

**流程要求**（本仓既有规矩，别绕过）：`pnpm typecheck` + `pnpm test` 全绿；改客户端后要重启宿主 + 硬刷新；
装盘走 `node scripts/dev-install.mjs`（**不要再改版本号**，身份由构建戳路径承载）；
改完按 `docs/release-checklist.md` 走。

---

## 6. 禁止照抄清单

| 项 | 原因 |
|---|---|
| fork 的 `inflateRawSync/inflateSync` 调用方式 | 解压炸弹（3.6） |
| fork 的宽松 base64 解码、PDF O(n²) 扫描 | 同上 |
| fork 自建的 DOM `/` 补全浮层 | 宿主已有 `commandUi`，重复实现且易碎 |
| 品牌替换 / `~/Documents/aitasks` 默认目录 / apple 风格 | 个人定制，他本人也回退了 |
| fork 的 peer 版本号 `^0.0.1-rc.1` | 本仓 `MIN_HOST_VERSION` 是 `0.1.5-rc.1` |
| 直接 apply 他的 patch | 基线差 67 个提交 + 双方都做过大重构 |

---

## 7. 附：原始数据与复现

| 文件 | 内容 |
|---|---|
| `.pwtest/survey-forks2.mjs` | 列 fork + 逐个 compare（带网络重试、增量落盘） |
| `.pwtest/classify-fork-commits.mjs` | 按提交标题区分"我方已有"与"fork 独有" |
| `.pwtest/survey-fork-branches.mjs` | 挖非默认分支（zf321/tujunwenjie 的活都在这） |
| `.pwtest/fetch-guojing6-commits.mjs` | 拉 39 个独有提交的**逐提交** patch |
| `.pwtest/show-commits.mjs` | 按 sha/文件名筛读 patch |
| `.pwtest/verify-zip-safety.mjs` | 核对解压实现（3.6 的证据） |
| `.pwtest/db-workspace-audit.mjs` / `db-settings-audit.mjs` | 本机库的工作区路径形态与设置（只读） |
| `.pwtest/guojing6-own-commits.json` 等 | 上述脚本的落盘结果 |
