# T4 交接：角色会话绑定与各入口选择（D12 / D13-B ｜ S11 / S13）

任务 `9a394d12-8a43-4be1-a072-542ec2518194`（父任务 `36c8e8ef-…`）。2026-10-01。
前置：T1（迁移 19 / 会话注册表）、T3（角色库与安全资源读取）已交付并经本项核对。

**本文件是 T4 的实现交接与证据记录，不是"本轮全部 AX 已通过"的声明。**
B 层（浏览器真实点击、真实模型调用 `workbench_load_persona`）属 T6；标"未验证"的项不得当作已过。
**7 条定向变异全部变红并已恢复**（§5.2）。

基线：`main @ 69a310f`（工作树里带着 T1/T2/T3 的未提交改动，同一执行链）。
**没有新增迁移**（`SCHEMA_VERSION` 仍是 19）；**没有新表**：绑定就写在 `ai_session_registry` 里。

---

## 1. 范围与不做什么

| 片段 | 内容 | 落点 |
|---|---|---|
| D12-A | `scope=persona` 的注册表**包装仓储**（复用 `ai_session_registry`，不加表不加列） | `src/db/repo/persona-bindings.ts`、`src/shared/persona.ts` |
| D12-B | 绑定/加载的**唯一语义**（解析校验、幂等、409、四态失败、来源身份复核） | `src/personas/binding.ts` |
| D12-C | HTTP：`GET/POST /api/workbench/personas/bind` | `src/api/routes/personas.ts` |
| D12-D | 工具 `workbench_load_persona` / `workbench_read_persona_resource`（**只认 `exec.sessionId`**） | `src/tools.ts`、`src/index.ts` |
| D13-B-1 | 纯提示块（角色块 → 技能块 → 正文；无角色逐字不变） | `src/client/personaPrompt.ts` |
| D13-B-2 | 选择/复用分流纯逻辑 + 独立 `PersonaPicker` | `src/client/personaPicker.ts`、`src/client/components/PersonaPicker.tsx` |
| D13-B-3 | 10 个 mode 接线 + 复用早退分支不吞选择 | `src/client/index.tsx`、`src/client/styles.ts`、`src/client/components/SettingsModal.tsx` |

**边界（明确不做）**：不改角色工具权限、不接任何第三方 persona 服务、**不做会话中切换角色**
（同一会话换角色 = 409，必须新建会话）、不做批次 2 的全入口模型选择、不写用户的角色来源目录。

**与 T3 的关系**：本项**只消费** T3 的服务（`resolvePersona` / `readPersonaResource` /
`listPersonaResources` / `discoverPersonas`），没有实现第二套解析或库发现。

---

## 2. 绑定（唯一实现）

### 2.1 落库形状

| scope_code | anchor | session_id | note |
|---|---|---|---|
| `persona` | 会话 id | 同一个会话 id | 版本化 JSON（下） |

```json
{ "version": 1, "personaId": "rf/rf-天线测量专家", "sourceKey": "external:ab12cd34ef56",
  "relativePath": "rf/rf-天线测量专家.md", "revision": "<sha256 hex 64>" }
```

- **不加表、不加列、不开迁移**：T1 的迁移 19 已把 `ai_session_scope = 'persona'` 字典项加好；
- 写入一律走 `registerAiSession`（注册表的唯一写入口），本模块不自己写 SQL ——
  否则"注册表怎么 upsert"就有了第二份实现；
- `anchor = sessionId` 让"按会话查绑定"是一次主键查询；**跨 scope 结构上不可能互相覆盖**
  （同一 scope+anchor 才只保留一条），`daily_plan` 登记不受影响（有断言）；
- 相对 T3 交接里的建议（`relativePath: id`）**这里存的是带 `.md` 的真实相对文件路径**：
  逻辑 ID 已经在 `personaId` 里，`relativePath` 存同一份信息没有意义，而诊断时"当时读的是哪个文件"更有用。

### 2.2 失败与幂等口径（路由与工具**共用同一段判定与文案**）

| 场景 | HTTP | 工具输出 | 说明 |
|---|---|---|---|
| `sessionId` 缺 | 400 `missing-session` | `no-session` | 工具侧=exec 上下文拿不到会话 id |
| `personaId` 缺（未选角色） | 400 `missing-persona` | — | **不写绑定行**（"未选角色不写绑定"） |
| 库里没有该 id | 400 `not-found` | `not-found` | 可能被删除/改名/来源被禁用 |
| 来源根不可达 | 400 `source-unavailable` | `source-unavailable` | **明确报错，不切其他来源** |
| 文档解析不过 | 400 `invalid-document` | `invalid-document` | 带解析器的中文格式原因 |
| 已有**同一角色身份**重复绑定 | **200**（`created:false`） | — | 幂等；**不覆盖 revision**；内容变过时回 `revisionChanged:true` |
| 已有**不同角色** | **409** `binding-conflict` | — | 换角色必须新建会话；旧绑定原样保留 |
| 绑定行存在但 note 坏 | **409** `binding-corrupt` | `binding-corrupt` | **"损坏" ≠ "没绑定"**，不静默覆盖 |
| 正文与绑定 revision 不符 | — | `revision-changed` | **不返回新正文** |

"同一角色身份" = 逻辑 ID（平台口径）+ `sourceKey`。**改外部角色目录 = 换身份**：
`sourceKey` 变 → 判定为不同角色 / 加载报 `source-unavailable`，绝不当成"文件内容变了"。

### 2.3 加载时的两道复核（AX-R05 的关键）

`loadSessionPersona()` 的判定顺序：

1. 会话绑定（缺 / 坏分开报）；
2. `resolvePersona(id, { expectedRevision })` —— 版本不符即拒绝，**不返回新正文**；
3. **来源身份复核**（`summary.sourceKey === binding.sourceKey`）——
   只比 revision 是不够的：外部根改配置、或同名角色被挪进内置库时，"同一个逻辑 ID"会解析到
   另一个来源；**若那份内容恰好逐字相同，revision 也会相同**，只比 revision 就会静默切源。
   所以来源不一致时按 `source-unavailable` 报错（错误文案明说"不会把其他来源的同名角色当成同一个角色"）。
4. 版本不符时再确认一次来源，把原因报准（`source-unavailable` 优先于 `revision-changed`）。

### 2.4 工具（越权面在结构上不存在）

| 工具 | 入参 | 说明 |
|---|---|---|
| `workbench_load_persona` | **无** | 只按 `exec.agent.session.id` 查绑定，返回角色名/正文/revision/资源相对清单/上限 |
| `workbench_read_persona_resource(path)` | 只 `path` | **先验绑定与 revision**，再用 `resolvePersona().resourceDir` + T3 的安全 reader |

- **没有也不接受 `session_id` / `persona_id`**：多传也不起作用（未声明的参数被忽略），
  有断言把"塞入别人的 session_id 仍读不到"钉住；
- 工具输出**只出相对路径**（来源绝对路径绝不进模型上下文，有断言）；
- 资源边界与拒绝理由**全部复用 T3 的 `readPersonaResource`**，本项没有第二份路径校验。

---

## 3. 客户端接线（10 个 mode + 复用分流）

### 3.1 选择三态（为什么不能只有"无角色"）

```ts
{ mode: 'inherit' }                        // 默认：沿用该会话原有角色；新会话 = 无角色
{ mode: 'none' }                           // 明确无角色（与原角色不同 → 新建会话）
{ mode: 'persona', personaId, sourceKey }  // 明确某个角色
```

默认值必须是 `inherit`：复用型会话（计划/日报/点子）本来就是"点同一个入口继续编辑"，
如果默认是"无角色"，用户什么都不动地点一次"继续编辑今日计划"就会被判成"明确无角色"、
与既有绑定不同 → **每次都新建会话**，既有复用彻底失效。

### 3.2 复用分流（`client/personaPicker.ts#decidePersonaReuse`，表驱动单测）

| 用户选择 | 复用会话已有绑定 | 结果 |
|---|---|---|
| 未指定 | 有 / 无 | **沿用**（任何情况都不打断既有复用） |
| 明确「无角色」 | 无 | 沿用 |
| 明确「无角色」 | 有角色 | **新建会话**（旧绑定保持不变） |
| 明确角色 X | 无 / 是别的角色 | **新建会话**（旧绑定保持不变） |
| 明确角色 X | 就是 X（同来源） | 沿用 |
| 明确角色 X | 同 id 但来源不同 | **新建会话**（改外部根 = 换身份） |

`reuseAiSessionId()` 的返回值从 `'' | sessionId` 改成 `{kind:'reuse',sessionId} | {kind:'new',notice}`：
**"命中就早退"现在必须先问判据**（旧实现无条件早退，正是 AX-R08 点名的"吞掉用户选择"）。

### 3.3 告知方式（一个刻意的取舍，必须知道）

"选了不同角色 → 已新建会话、旧会话绑定不变"这条告知**不走 toast**：这条路径结尾会
`openSessionInPanel()` 收掉面板，而 `ToastHost` 在面板内部 —— toast 会跟着面板一起不可见。
所以告知走三个用户真的看得到的地方：

1. **新会话标题**：`AI 计划：10-01 · 角色 rf/rf-天线测量专家`
   （标题里写**逻辑 ID** 而不是显示名：这条路径拿不到角色库列表，
   而 `personaSelectionLabel` 在没列表时会给出"（已不在角色库里）"这种**会误导人的**文案 ——
   宁可用 id，也不要一句假话）；
2. **提示词首段**：新会话里用户消息第一行就是「本次会话已绑定角色（专家人格）：…」（可见）；
3. 控制台一条 `console.warn`（排查用）。

### 3.4 提示词顺序与"逐字不变"

```
[角色块]            ← 只在选了角色时存在；只放 ID + "先调用 workbench_load_persona"，不内联正文
[技能块]            ← 原有逻辑，未选技能时为空
[原提示词 + 用户补充]
```

两个函数都是"往前面拼"，所以嵌套顺序与最终顺序**相反**：
`withPersonaPromptBlock(withSkillPromptBlock(basePrompt, skillNames), personaId)`。
角色块为空时**逐字等于改动前的提示词**（AX-R07，有断言）。

### 3.5 绑定时机

`startAISession` 在**新建会话之后、`session.prompt()` 之前** `POST /personas/bind`；
服务端返回的角色不是所选角色就**抛错并中止本次发送**（不假装有角色）。
未指定 / 无角色时**不写绑定、不改提示词**。

### 3.6 选择器（一个组件、两个入口）

`PersonaPicker` 同时挂在「共享提示词弹窗」（9 个 mode）与「快速录入弹窗」（clarify）——
10 个 mode 因此都有同一套角色入口（AX-R07）。
常用区 = 启用且收藏；**一个收藏都没有时展示内置六篇**；
「更多角色」= 分组 + 搜索 + 收藏/停用（**停用的角色仍然列出来**，否则"启用"没有出口）。
整块是普通文档流（无绝对定位/无遮罩），与技能栏不遮挡（有断言）。
收藏/停用的写入口径只有一处（`personaFlagPatch`），每次**只提交被改动的那一个数组**，写完**重读**服务端。

### 3.7 设置页

「设置 → 通用」新增**外部角色目录**输入框（§6.3 的 `personaExternalDir`）——
没有它，"外部角色目录可配"就只能靠手改数据库 meta。收藏/停用**不在这里改**
（在角色选择器里就地改，避免两处口径不同），这里只显示数量。

---

## 4. 实现过程中抓到的一个真问题（我自己的代码，不是 T3 的）

**`process.platform` 被打进了客户端 bundle。**

- 现象：`shared/persona.ts` 同时被服务端与客户端引用（客户端要复用同一把 id 比较尺子），
  而其中的默认参数写的是 `platform = process.platform`。构建产物 `lib/client.js` 里**真的有**
  `process.platform`（实测 `Select-String` 命中），浏览器里没有 `process` →
  **每次点开 AI 会话入口**（`decidePersonaReuse` 省略平台参数）都会
  `ReferenceError: process is not defined`，10 个 mode 一起打不开。
- 修法：`shared/persona.ts` 新增 `defaultPersonaPlatform()`，**显式判 `typeof process !== 'undefined'`**，
  浏览器退回 `'win32'`（大小写不敏感）。折叠方向不会误判：客户端比较的两个 id 都来自服务端。
  默认参数一律改用它；`client/personaPicker.ts` 里不再出现 `process`。
- 该问题现有**两条会失败的判据**：源码级（客户端打包模块里不得出现 `= process.platform`，
  且 `process.platform` 只允许出现在那个 helper 里）+ 运行时（把 `globalThis.process` 抹掉后
  `personaCompareKey` / `dedupeByPersonaKey` / `samePersonaIdentity` 仍必须工作）。

顺带修掉的既有测试脚手架问题：`test/quickIntakeDefaultWiring.test.mjs` 用一个只提供外部依赖的
桩函数去跑**源码里真实的** `openQuickEntry`，而本项在 `openQuickEntry` 里加了一行
`setQuickPersona(INHERIT_PERSONA)`（打开弹窗复位角色）→ 该桩缺这个符号，测试报
`ReferenceError: setQuickPersona is not defined`。已给桩补上同形符号（并保持它只测工作区预填），
角色的复位语义改由 `test/personaWiring.test.mjs` 钉住。

---

## 5. 实际命令与结果（2026-10-01）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **通过**（`tsc --noEmit`，无输出） |
| `pnpm build` | **通过**（`lib/client.js` 501.31 kB，gzip 144.98 kB） |
| `node --test test/personaBinding.test.mjs` | **tests 9 / pass 9 / fail 0** |
| `node --test test/personaWiring.test.mjs` | **tests 27 / pass 27 / fail 0** |
| 定向合并（personaBinding + personaWiring + aiSessionReuse + tools + routes） | **tests 87 / pass 87 / fail 0** |
| 定向合并（+personaLibrary/personaParse/packageManifest） | **tests 162 / pass 162 / fail 0** |
| `pnpm test`（全套） | **tests 813 / pass 812 / fail 1**（唯一失败见 §5.1；T3 基线 777 → 新增 36） |

### 5.1 那 1 个失败与本次改动无关（沿用 T2/T3 的结论并再次实测）

`test/db.test.mjs` 的 `db migrations, dictionaries and task tree`：失败的**不是断言**，
而是 `finally` 里 `removeTempDir()` 抛 `EPERM`（Windows 上 WAL 句柄释放慢）。
T2 已用 `git checkout` 回基线复现过同一现象；本项未删断言、未弱化判据。

### 5.2 定向变异与恢复（每个关键禁令拆掉必须变红；跑完即恢复，无 `.mutbak` 残留）

| 变异（在 `lib/` 产物上原地注入） | 结果 | 恢复 |
|---|---|---|
| 去掉 `expectedRevision` 校验（接受任意版本）—— 同时覆盖"资源工具先验 revision" | `personaBinding` **fail 2** | pass 9 / fail 0 |
| 去掉**来源身份复核**（允许静默切源） | `personaBinding` **fail 1** | pass 9 / fail 0 |
| 不同绑定不再 409（静默接受换角色） | `personaBinding` **fail 1** | pass 9 / fail 0 |
| 拆掉"未绑定"硬拦（资源工具不再先验会话绑定） | `personaBinding` **fail 2** | pass 9 / fail 0 |
| 复用判定忽略**来源**（只看 id） | `personaWiring` **fail 1** | pass 27 / fail 0 |
| 空角色 id 也拼角色块（默认提示词不再逐字不变） | `personaWiring` **fail 1** | pass 27 / fail 0 |
| 去掉 `defaultPersonaPlatform` 的存在性判断（浏览器直读 `process`） | `personaWiring` **fail 1** | pass 27 / fail 0 |

恢复方式：`pnpm build` 从源码重建（权威产物），`Get-ChildItem -Recurse -Filter *.mutbak` → **0**。
（T3 那 6 条针对解析/路径边界的变异见 `T3-handover.md` §5.2；本项的越界拒绝**直接复用 T3 的实现**，未另写一套。）

---

## 6. AX 覆盖情况（T4 归属部分）

| AX | 覆盖位置 | 状态 |
|---|---|---|
| AX-R04 绑定在 prompt 前；scope=persona 不覆盖 daily_plan；同绑定幂等、不同绑定 409；工具仅 exec.sessionId、无 session/未绑定可读错误 | `test/personaBinding.test.mjs`（HTTP 真请求 + 真工具对象 + 真注册表行）、`test/personaWiring.test.mjs`（绑定写在 prompt 之前的源码级顺序断言） | ✅ 实测通过 |
| AX-R05 正文改动后 hash 不符拒绝旧绑定；源丢失明确报错不切其他源；资源工具先验绑定 revision；重复 load 同 revision 一致 | `test/personaBinding.test.mjs`（含 CRLF/LF 同哈希、同名角色逐字相同但换来源、绑定记录损坏） | ✅ 实测通过 |
| AX-R07 10 个 mode 同一选择路径；未选角色提示词逐字不变；与技能栏不遮挡；正文不内联 | `test/personaWiring.test.mjs`（纯函数 + 源码级接线断言）；**"实际 load_persona 被调用并返回所选内容"属 T6（真实模型调用）** | ⚠️ 除真实模型调用外均已实测 |
| AX-R08 同 role 沿用旧会话；显式不同 role/无 role 新建会话并告知，旧 binding 不变 | `test/personaWiring.test.mjs`（决策表 10 条 + "未指定永不新建"底线）、`test/aiSessionReuse.test.mjs`（既有可用性判据未回归） | ✅ 实测通过（**"归档会话新建"沿用既有 `aiSessionUsable` 判据，本项未改**） |
| AX-R08（包资产/公司内部角色库 九篇） | T3 归属，本项未改 | — |
| AX-G04 资源无法跨绑定根读取 | T3 的 `readPersonaResource` 边界 + 本项的"先验绑定再读"（越界/编码/盘符定向拒绝有断言；变异见 §5.2 第 1、4 行） | ✅ 实测通过（**"suite 不吞错误"属 T5/T6**） |

**不属于 T4**：真实模型调用 `workbench_load_persona` 与 B 层浏览器判据 → T6。

---

## 7. 明确**未验证** / 未做（不得当已过）

1. **浏览器 B 层完全未做**：本会话没装盘、没重启 19387、没开浏览器。
   选择器的真实点击（选角色 → 开始 → 聊天里出现"已绑定角色"行）、
   会话标题里的角色后缀、停用/收藏按钮的真实视觉与布局**全部未经人眼确认**。
2. **没有真实模型调用 `workbench_load_persona`**：工具外壳、错误分支、输出形状都有单测，
   但"模型在真实会话里确实调用了它、并把角色正文用上了"属于 T6（需要真模型 + 隔离环境）。
3. **`/personas/bind` 的真实宿主会话 id**：单测用的是合成 id；
   "exec.sessionId 与宿主会话 id 完全一致"这条依赖宿主行为，本项未在真机会话里验证。
4. **10 个 mode 的端到端**：源码级断言证明"都经过同一入口"，但没有逐个 mode 真机跑一遍
   （`knowledge_doc` / `report` / `plan` 走的是同一条 `startAISession` 路径）。
5. **设置页新输入框的视觉**：`personaExternalDir` 输入框与说明文字未做视觉确认；
   "保存后仍显示"由既有的 GET/POST 同形状保证（T3 已有断言），但没在浏览器里点过。
6. **未装盘、未重启 19387、未动正式 DB、未改公开版本号、未 `git commit`、未公开发布。**
7. **没有新增迁移**（`SCHEMA_VERSION` 仍是 19）；**没有新表**；绑定复用 `ai_session_registry` 的 persona scope。
8. `PersonaSummary` 里仍**没有"分类"字段**（T3 §8.9）：本项按 `group`（路径首层目录）分组，
   没有按 agency 分类筛选 —— 要扩形状须先与父任务确认。
9. **已知边界（不是 bug，但要知道）**：绑定发生在**会话创建之后**（绑定行以会话 id 为 key，
   没有会话就没有 key）。所以"角色在这一瞬间被删掉"的极端情况下，会先建出一个空会话、
   再抛出可读的中文错误（不会发出 prompt、不会假称有角色）。这个窗口是秒级、
   且选择器里的角色刚由服务端列表给出；要彻底消除需要"先占位再建会话"的新机制，本项不做。

---

## 8. 给 T5 / T6 的输入

1. **T6 要验的 B 层清单**（本项已就位、但没点过）：
   - 提示词弹窗里选一个外部角色 → 开始 → 会话标题带「· 角色 …」、
     用户消息第一段是「本次会话已绑定角色…」；
   - 不选角色 → 提示词与改动前**逐字一致**（对比同一入口的旧版本提示词文本）；
   - 同一个"继续编辑今日计划"点两次：角色不变时**沿用**同一个会话（不新建）；
     改成另一个角色 → **新建**会话且旧会话标题/绑定不变；
   - 资源工具：在没有同名附件目录的角色上读资源 → 中文 404 语义错误（不是崩）。
2. **T5 的验收链**要在隔离 profile/DB 上跑；本项**没有**装盘，`.pwtest`/`scripts/verify` 未涉及。
3. `test/personaBinding.test.mjs` 用**真实临时目录 + 真实 HTTP + 真实注册表**，
   可直接并入 T6 的套件；它对公司资产零依赖（fixture 全自造）。
4. **不要**在 T6 里"顺手"改本项的绑定语义（幂等/409/四态是路由与工具共用的一处实现）；
   若需要会话中切换角色，那是新需求，必须先改规格。

## 9. 改动文件清单（`git status --short` 实测）

**本项新增**：`src/db/repo/persona-bindings.ts`、`src/personas/binding.ts`、`src/personas/roots.ts`、
`src/client/personaPrompt.ts`、`src/client/personaPicker.ts`、
`src/client/components/PersonaPicker.tsx`、`test/personaBinding.test.mjs`、
`test/personaWiring.test.mjs`、本文件。

**本项修改**：`src/shared/persona.ts`（平台比较挪进来 + 绑定记录/视图 + `defaultPersonaPlatform`）、
`src/personas/library.ts`（比较/去重改为再导出，删掉第二份实现）、
`src/personas/resources.ts`（导出 `PersonaResourceFailure` 供服务层复用类型）、
`src/api/routes/personas.ts`（bind 两个端点 + 根解析挪到 `personas/roots.ts` 后改为引用）、
`src/tools.ts`（两个角色工具）、`src/index.ts`（注册两个工具）、
`src/client/index.tsx`（三态选择 + 复用分流 + 绑定时机 + 提示词顺序 + 两个入口接线）、
`src/client/styles.ts`（角色选择器样式）、`src/client/components/SettingsModal.tsx`（外部角色目录）、
`tsconfig.build.json`（新增可被 `node --test` 直接引用的模块）、
`test/quickIntakeDefaultWiring.test.mjs`（桩函数补一个同形符号，语义不变）。

**未提交**（按共同执行契约：用户未要求提交代码）。`.gitignore` 的 `lib/` → `/lib/` 是 T3 的改动，
本项未再改。
