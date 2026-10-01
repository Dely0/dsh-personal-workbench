# T3 交接：三级角色库与安全资源读取（D10 / D11 / D13-A ｜ S10 / S12）

任务 `118d2883-c023-4bf9-ae07-ded2ba53fb7b`（父任务 `36c8e8ef-…`）。2026-10-01。

**本文件是 T3 的实现交接与证据记录，不是"本轮全部 AX 已通过"的声明。**
B 层（浏览器真实点击）与角色**绑定/工具/选择器**属 T4/T6；本文件标"未验证"的项不得当作已过。

基线：`main @ 69a310f`（工作树里带着 T1/T2 的未提交改动，同一执行链）。
**没有新增迁移**（T1 已用掉 19；本项三个设置键全部走 `meta`）。

---

## 1. 范围与不做什么

| 片段 | 内容 | 落点 |
|---|---|---|
| D10 / S10 | 角色文档**纯解析**（H1 + blockquote 元信息、可选标量 frontmatter、BOM/CRLF、20000 阈值、诊断） | `src/personas/parse.ts`、`src/shared/persona.ts` |
| D11-A | 三级来源发现、稳定逻辑 ID、覆盖顺序、诊断、revision | `src/personas/library.ts` |
| D11-B | 资源安全读取（形状/链接/realpath/类型/体积/编码边界 + 清单） | `src/personas/resources.ts` |
| D11-C | 三个设置键（同形状读写） | `src/db/repo/personas.ts`、`src/api/routes.ts`、`src/shared/contracts.ts` |
| D11-D | HTTP：摘要列表 + 资源只读读取 | `src/api/routes/personas.ts` |
| D13-A | 六篇自写通用内置角色 + `package.json` `files` + 打包校验 | `assets/personas/**`、`package.json`、`scripts/check-tgz.mjs`、`scripts/lib/tarReader.mjs` |

**明确不做**（边界）：
- **不接 agency 实际服务**、不引入任何第三方 persona 来源；
- **不复制公司岗位角色正文**（内置六篇全部自写通用内容；真实 9 篇只做本机只读兼容留证，见 §6）；
- 不做"复制为我的角色"、不做角色正文编辑；
- 不建全局 skill、不写用户的用户库/外部根目录（**工作台从不写任何角色来源**）；
- **`/personas/bind*`、`workbench_load_persona`、`workbench_read_persona_resource`、PersonaPicker、各 mode 接线全部留给 T4**（D12/D13-B）。
  本项**刻意没有预埋**绑定逻辑，避免与 T4 的会话/revision 判定形成第二份实现。

---

## 2. 接口（T4 直接用这些，不要自己拼路径）

### 2.1 共享契约 `src/shared/persona.ts`

常量（**唯一来源**，四处上限只许 import 这里）：`PERSONA_BODY_MAX_CHARS` 20000、
`PERSONA_DESCRIPTION_MAX_CHARS` 160、`PERSONA_NAME_MAX_CHARS` 40、`PERSONA_FILE_MAX_BYTES` 256KiB、
`PERSONA_RESOURCE_MAX_BYTES` 128KiB、`PERSONA_RESOURCE_MAX_CHARS` 20000、
`PERSONA_MAX_DEPTH` 4、`PERSONA_MAX_DOCUMENTS` 1000、`PERSONA_MAX_RESOURCES` 200、
`PERSONA_RESOURCE_EXTENSIONS`。

类型：`PersonaDiagnosticCode`（**封闭枚举**，测试按码断言不按中文）、`PersonaDiagnostic`
（`sourceKey` / `id` / `path` / `code` / `message`）、`PersonaDocument`、`PersonaParseResult`、
`PersonaSummary`（**不含正文、不含绝对路径**）、`PersonaListResponse`、`PersonaResourceResponse`。

### 2.2 纯解析 `src/personas/parse.ts`

```ts
normalizePersonaText(raw: string): string            // 去 BOM + CRLF/CR → LF（与 revision 口径一致）
parsePersonaDocument(raw: string): PersonaParseResult // ok / document / diagnostics
```

零 FS / 零 React / 零 DOM（由 `test/personaParse.test.mjs` 的源码扫描断言钉住）。

### 2.3 库 `src/personas/library.ts`

```ts
dedupeByPersonaKey(values, platform)                  // 平台口径去重（设置层与库层共用一份）
personaCompareKey(value, platform)                    // NFC + `/` 统一 + （Windows）小写
personaIdFromRelativePath(relativePath)               // 稳定逻辑 ID
personaGroupForId(id, explicit?)                      // 首层目录 or 「其他」
sourceKeyForRoot(kind, root, platform)                // builtin | user:<hash> | external:<hash>
revisionOfText(normalizedText)                        // SHA-256（归一文本）
defaultUserPersonaRoot(home?) / defaultBuiltinPersonaRoot(moduleUrl?)

discoverPersonas(options): { sources, personas, diagnostics }
resolvePersona(id, options & { expectedRevision? }): PersonaResolveResult
readPersonaDocumentFile(path)                         // 读取前判大小 + 解析
```

`PersonaLibraryOptions`：`{ builtinDir?, userDir?, externalDir?, favorites?, disabledIds?, platform? }`。

### 2.4 资源 `src/personas/resources.ts`

```ts
checkPersonaResourcePathShape(relativePath): string | undefined   // 纯函数，表驱动可测
isInsidePersonaRoot(root, candidate, platform): boolean           // 纯函数
readPersonaResource(resourceRoot, relativePath, { platform }): PersonaResourceReadResult
listPersonaResources(resourceRoot): { resources, diagnostics }
```

**`resourceRoot` 必须由调用方用 `resolvePersona()` 返回的 `resourceDir` 传进来** ——
不要在调用点自己拼 `<doc 路径去 .md>`（那是"同一语义两处实现"）。

### 2.5 路由 `src/api/routes/personas.ts`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workbench/personas` | `{ ok, personas, diagnostics }`；**不回正文/绝对路径** |
| GET | `/api/workbench/personas/resources?persona_id=&path=` | 成功 200 带 `{ ok, personaId, path, text, bytes, characters, revision, resources, diagnostics }` |

失败码 → 状态码**只有一处**实现：`statusForResourceFailure()`（`resource-not-found` /
`resource-skipped-symlink` → 404，`resource-oversized` → 413，其余 → 400）。
测试注入根：`makeRoutes(db, { personas: { builtinDir, userDir, home, platform } })`（生产不传）。

### 2.6 设置 `src/db/repo/personas.ts`

`PERSONA_EXTERNAL_DIR_META_KEY='persona_external_dir'`、`PERSONA_FAVORITES_META_KEY='persona_favorites'`、
`PERSONA_DISABLED_IDS_META_KEY='persona_disabled_ids'`；`readPersonaSettings` / `writePersonaSettings`。
`WorkbenchSettings` 新增 `personaExternalDir: string`、`personaFavorites: string[]`、
`personaDisabledIds: string[]`（GET/POST 都由 `readWorkbenchSettings` 出一份 → **形状一致是结构保证**）。
数组语义 = **整表替换**（设置页必须能删掉一个收藏）。

---

## 3. `sourceKey` / `revision` 规则（T4 绑定必须照这个来）

### 3.1 `sourceKey`

| 来源 | 值 |
|---|---|
| 内置 | 常量 `builtin` |
| 用户库 | `user:<sha256(规范化根路径) 前 12 位>` |
| 外部根 | `external:<同上>` |

- **哈希取自规范化路径字符串**（`resolve` + NFC + `/` 统一 + Windows 小写），不是 `realpath`：
  根不存在时绑定仍要能解释"当时读的是哪个来源"；
- **改配置就是换身份**：把 `personaExternalDir` 从 A 改到 B → `sourceKey` 变 →
  旧绑定必须按"源丢失"报错，**不得**被当成"文件内容变了"（AX-R05）；
- 平台口径：Windows 上大小写不同的同一个根 → **同一个** `sourceKey`（已由 `personaLibrary.test.mjs` 断言）。

### 3.2 `revision`

`sha256(normalizePersonaText(raw))`，hex 64 位。

- 口径与解析器入参**逐条一致**：去 BOM + CRLF/CR 归一 LF；
- 因此**同内容必然同哈希**（CRLF 与 LF 同哈希 —— 否则一次 `git checkout` 就会让所有绑定失效）；
- **不是** mtime、不是文件字节哈希。

### 3.3 绑定/加载的实现建议（T4）

1. 首次发 prompt 前：`discoverPersonas(...)` 找到 summary → 记
   `{ version: 1, personaId: id, sourceKey, relativePath: id, revision }` 到
   `ai_session_registry`（`scope=persona, anchor=sessionId`）；
2. 工具/资源读取时：`resolvePersona(id, { expectedRevision })`
   → `ok:false` 时按 `reason` 给**不同的中文错误**：

   | `reason` | 含义 | 建议文案方向 |
   |---|---|---|
   | `not-found` | 库里没有这个 id | 角色不存在（可能被删除/改名/来源被禁用） |
   | `source-unavailable` | 该来源根已不可达 | 角色的来源（用户库/外部目录）已不可用，**不切到其他来源** |
   | `revision-changed` | 文件内容变了 | 已明确拒绝旧绑定，请新建会话重新选择角色；**不返回新正文** |
   | `invalid-document` | 文档现在解析不过 | 带上 `diagnostics[].message` 的格式原因 |

3. **正文上限 20000**：`resolvePersona` 已保证（解析器超限即 `oversized-body`）→
   T4 的加载工具不需要再判一次，直接复用它的失败即可。

### 3.4 诊断码（界面/测试按码断言）

来源级：`root-missing` / `root-unreadable` / `root-skipped-cycle` / `document-limit` / `depth-limit`；
文档级：`unsupported-frontmatter` / `unsupported-metadata` / `missing-title` / `invalid-title` /
`empty-body` / `oversized-body` / `oversized-file` / `not-utf8`；
信息级：`description-truncated` / `name-truncated` / `duplicate-id-overridden` /
`skipped-readme` / `skipped-hidden` / `skipped-symlink` / `skipped-non-markdown`；
资源级：`resource-not-found` / `resource-invalid-path` / `resource-unsupported-type` /
`resource-oversized` / `resource-binary` / `resource-limit` / `resource-skipped-symlink`。

> ⚠️ `PersonaDiagnostic.path` 是**服务端绝对路径**，只用于日志/排查。
> **HTTP 响应不得外发它**（已由 `personaLibrary.test.mjs` 按原始响应文本断言钉住）。

---

## 4. 实现时实测抓到并修掉的**三个真问题**（都不是我原来以为的）

### 4.1 元信息块"隔空行"那条规则，第一版实现是错的

需求 §6.2 明写"首个标题后连续元信息 blockquote **可以隔空行**"。第一版把
"空行后还有引用行"的判据写成 `quoteLines.length > 0 && 下一行是引用` ——
而**空行出现在第一行时 `quoteLines` 还是空的**，于是直接 `break`：
`# 甲` 后空一行再写 `>` 元信息，**整块元信息全被当成正文**（正文里带着 `>` 引用行）。
判据 `test/personaParse.test.mjs` 的"元信息块允许隔空行"当场变红。

### 4.2 "元信息块里字段的切分"踩了两个坑

- **不能按固定分隔符切**：既有 9 篇里字段之间是**全角空格**
  （`建议 emoji：\`📡\`　建议简介（…）：`），按 `·` 切会把 emoji 与简介挤在一段里，
  `emoji` 于是被取成 `（\`description\`，≤160 字符）：`；
- **不能按第一个冒号拆键值**：简介正文**自己带冒号**
  （`…判据与根因诊断：方向图、增益…`），那样拆会把简介切碎并误判成未知字段。

现在一律**按已知标签取、以"下一个标签"为界**，且"建议简介"优先于"emoji"。

### 4.3 `scripts/check-tgz.mjs` 读不了 PAX 扩展头 → **静默漏检**

**现象**：`pnpm pack` 出来的 tgz 里明明有 `assets/personas/**.md`，
`node scripts/check-tgz.mjs` 报"包里没有内置角色库"。

**根因**：`pnpm pack` 对**非 ASCII 文件名**（中文角色名、中文截图名）一律写
**PAX 扩展头**（`typeflag='x'`，真路径在数据里 `NN path=<真路径>\n`），
经典头里放的是**字面量 `PaxHeader`**（超 100 字节还会被截断）。
旧读取器不认 PAX，于是那些条目**既列不出来也匹配不到** ——
报的是"没有"，而不是"我没看懂"。

**顺带解释了一个长期疑点**：`screenshot/*.png`（中文名）**从来没进过包**，
而 README 一直把它写进 `files`。"检查通过"其实**根本没看**那些文件。

修法：读取器抽到 `scripts/lib/tarReader.mjs`（**可单测**），认 PAX（并跳过全局 PAX `g`），
判据 `test/tarReader.test.mjs`（6 条，手搓 PAX + 截断头，不依赖任何打包器行为）。

> ⚠️ 这条修复**给 T5/T6 的输入**：`scripts/check-tgz.mjs` 的"通过"以前可能是假的。
> 历史 tgz 若要复核，请用新读取器重跑一遍。

### 4.4 `.gitignore` 的 `lib/` 会连带忽略 `scripts/lib/`

新增 `scripts/lib/tarReader.mjs` 时实测发现：裸 `lib/` 会匹配**任意深度**的 `lib/`，
于是 `scripts/lib/*` **永远提交不进仓库**，而 `git status` 里也看不到它（**静默丢件**）。
已改为 `/lib/`（只锚定仓库根），并留注释说明原因。**这是本项唯一的 `.gitignore` 改动。**

---

## 5. 实际命令与结果（2026-10-01）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **通过**（`tsc --noEmit`，无输出） |
| `pnpm build` | **通过**（`lib/client.js` 486.64 kB，gzip 140.89 kB） |
| `node --test test/personaParse.test.mjs` | **tests 27 / pass 27 / fail 0** |
| `node --test test/personaLibrary.test.mjs` | **tests 46 / pass 46 / fail 0** |
| `node --test test/tarReader.test.mjs` | **tests 6 / pass 6 / fail 0** |
| `node --test test/packageManifest.test.mjs` | **tests 5 / pass 5 / fail 0** |
| `node --test test/routes.test.mjs` | **tests 38 / pass 38 / fail 0** |
| `pnpm test`（全套） | **tests 777 / pass 776 / fail 1**（唯一失败见 §5.1；T2 基线 692 → 新增 85） |
| `pnpm pack` + `node scripts/check-tgz.mjs …tgz 1.15.8` | **通过**，输出 `✅ 内置角色库：6 篇（assets/personas/**）` |

基线（改动前，同一工作树）：`pnpm typecheck` 通过；`pnpm test` 692 pass / 1 fail（EPERM）。

### 5.1 那 1 个失败与本次改动无关（沿用 T2 的结论并复核）

`test/db.test.mjs` 的 `db migrations, dictionaries and task tree`：失败的**不是断言**，
而是 `finally` 里 `removeTempDir()` 抛 `EPERM`（Windows 上 WAL 句柄释放慢）。
T2 已用 `git checkout` 回基线复现过同一现象；本项未删断言、未弱化判据。

### 5.2 定向变异与恢复（每个关键禁令拆掉必须变红；跑完即恢复，无 `.mutbak` 残留）

| 变异（在 `lib/` 产物上原地注入） | 结果 | 恢复 |
|---|---|---|
| 拆掉资源路径的**百分号编码**拒绝 | `personaLibrary` **fail 5** | pass 46 / fail 0 |
| 拆掉 frontmatter 的**不支持结构**拒绝 | `personaParse` **fail 1** | pass 27 / fail 0 |
| 拆掉正文 **20000** 上限 | `personaParse` **fail 1** | pass 27 / fail 0 |
| 反转三级来源顺序（内置 > 外部 > 用户） | `personaLibrary` **fail 1** | pass 46 / fail 0 |
| 拆掉**文档大小上限**（256KiB） | `personaLibrary` **fail 1** | pass 46 / fail 0 |
| 拆掉 tar 读取器的 **PAX** 支持 | `tarReader` **fail 4** | pass 6 / fail 0 |

恢复方式：`pnpm build` 从源码重建（权威产物），`Get-ChildItem -Recurse -Filter *.mutbak` → **0**。

---

## 6. 真实九篇 LS-Skills **只读**兼容留证（2026-10-01）

跑法：一次性只读探针，`externalDir = D:\Code\Linksight\LS-Skills\personas`，
`userDir=''`（隔离用户库干扰）。**不写、不复制、不派生该目录任何文件**；探针跑完即删。

**结果：9 篇全部 `ok`，正文长度全部落在 20000 以内，诊断只有一条信息级 `skipped-readme`。**

| id | 名称 | 分组 | 工作模式 | emoji | 简介 | 正文 |
|---|---|---|---|---|---|---|
| `dotnet/dotnet-代码审查官` | .NET 代码审查官 | dotnet | 只读（不改代码、不跑构建与测试） | 🔍 | 72 | 5121 |
| `dotnet/dotnet-性能并发诊断师` | .NET 性能与并发诊断师 | dotnet | 只读诊断（不改代码，给最小补丁建议） | 📈 | 74 | 5971 |
| `dotnet/高级-dotnet-blazor-工程师` | 高级 .NET / Blazor 工程师 | dotnet | 可动手改代码 | ⚙️ | 71 | 6184 |
| `rf/rf-仪表回路与测量链` | 仪表回路与测量链专家 | rf | 只读诊断 | 🎛️ | 71 | 8145 |
| `rf/rf-天线测量专家` | 天线测量专家 | rf | 只读诊断（读资料、判数据、给结论与验证方法） | 📡 | 64 | 6259 |
| `rf/rf-微波电路与vna测量` | 微波电路与 VNA 测量专家 | rf | 只读诊断 | 🔌 | 78 | 6881 |
| `rf/rf-测量不确定度预算` | 测量不确定度预算专家 | rf | 只读诊断 | 📐 | 86 | 4999 |
| `rf/rf-电磁仿真与暗室测量` | 电磁仿真与暗室测量专家 | rf | 只读诊断 | 🧲 | 87 | 6775 |
| `rf/rf-计量溯源与校准` | 计量溯源与校准专家 | rf | 只读诊断 | 🔗 | 81 | 6613 |

- 简介字符数与 `LS-Skills/personas/README.md` 的清单表**逐个吻合**（64/71/72/74/78/81/86/87）；
- 9 篇都没有同名附件目录 → 资源清单为空（**不是错误**）；
- `revision` 一致性：`resolvePersona(id, { expectedRevision })` 9 篇全部 `ok`；
- 资源边界：读真实角色下不存在的资源 → `resource-not-found` + 中文原因；
- **测试 fixture 里没有任何公司正文**（`personaLibrary.test.mjs` 的内容全部自造；
  `packageManifest.test.mjs` 只做"不许出现公司岗位关键词"的黑名单扫描）。

> 这些数字是**本机一次性只读运行的结果**（探针不随仓库提交）。
> 换机器/换克隆位置时请重跑；**不得**把这张表当成"每次 CI 都会验"的判据。

---

## 7. AX 覆盖情况（T3 归属部分）

| AX | 覆盖位置 | 状态 |
|---|---|---|
| AX-R01 合成 H1/blockquote/跨行简介/frontmatter 标量、UTF8/BOM/CRLF、160 摘要/20k 正文、无 H1/无正文/坏 frontmatter 边界；parser 无 React/DOM/FS | `test/personaParse.test.mjs`（27 条，含源码扫描与"纯函数"两条） | ✅ 实测通过 |
| AX-R02 临时 rf/dotnet 子目录发现；同逻辑路径 用户>外部>内置；同显示名不同 ID 并存；README/隐藏/link/资源附件排除；数量/深度超限有诊断 | `test/personaLibrary.test.mjs`（发现 6 条）、`test/personaParse.test.mjs`（无） | ✅ 实测通过（**文档数量 1000 上限未构造真实 1000 篇**，见 §8） |
| AX-R03 外部根无权限/不存在只禁用该来源；settings GET/POST 同形状、收藏/禁用去重；摘要不含正文/绝对路径 | `test/personaLibrary.test.mjs`（设置 3 条 + 摘要 1 条）、`test/routes.test.mjs`（角色设置 3 条） | ✅ 实测通过 |
| AX-R06 资源合法相对路径成功；`../`/绝对/UNC/盘符/大小写绕过/编码绕过/NUL/link/junction/二进制/坏 UTF8/超 128KiB 或 20k 拒绝；不读根外文件、不执行脚本 | `test/personaLibrary.test.mjs`（形状表 17 拒绝 + 5 接受、扩展名白名单、二进制/超限、realpath、符号链接/junction、HTTP 8 拒绝 + 1 成功 + 4 边界） | ✅ 实测通过（**"大小写绕过"只覆盖了 sourceKey 与 ID 口径**，见 §8） |
| AX-R08（**包资产部分**）| `test/packageManifest.test.mjs`（files 含 `assets/personas`、恰为六篇且可解析、无公司素材关键词）、`test/tarReader.test.mjs`、`pnpm pack` + `check-tgz` 实跑 | ✅ 实测通过；**"同 role 沿用旧会话"那半属 T4** |

**不属于 T3**：AX-R04 / R05 / R07、AX-R08 的会话部分、AX-G04 → T4；B 层浏览器判据 → T6。

---

## 8. 明确**未验证** / 未做（不得当已过）

1. **浏览器 B 层完全未做**：本会话没装盘、没重启 19387、没开浏览器。所有界面呈现
   （选择器、角色卡、资源预览）都还不存在（属 T4/T6）。
2. **`workbench_read_persona_resource` 工具本身没实现** —— 本项只落了
   `readPersonaResource()` 纯函数 + `/personas/resources` 只读端点（两者共用同一实现）。
   工具外壳 + 会话绑定 + revision 校验属 **T4**（见 §3.3）。
3. **`/personas/bind*` 没实现**（属 T4）。本项没有预埋任何绑定状态。
4. **"文档数 1000 上限"没有构造真实 1000 篇来测**：`document-limit` 分支存在且有诊断文案，
   但没有真实触发过（造 1000 个文件在 Windows 上很慢）。**归 T6 或按需补**。
5. **"大小写绕过"只覆盖了口径层**：`sourceKey`/ID 的 Windows 大小写不敏感有断言，
   但"用不同大小写拼一个根外路径去读"这种**文件系统层**的绕过没有单独用例
   （Windows 文件系统本身大小写不敏感，没有可构造的绕过面）。**POSIX 上的大小写绕过未验证。**
6. **junction 用例在拿不到创建权限时会 `t.diagnostic` 跳过**（本机实测**创建成功**，
   断言真的跑过；但换到不允许建 junction 的机器上会变成跳过 —— 跳过**不算通过**）。
7. **没有新增/变更迁移**（`SCHEMA_VERSION` 仍是 19）；三个设置键走 `meta`。
8. **未改公开版本号、未 `git commit`、未公开发布、未装盘、未动正式 DB。**
9. `PersonaSummary` 里**没有"分类"字段**（`分类 \`engineering\`` 被解析出来但不进摘要）：
   需求 §6.3 的摘要形状里没有它，界面分组用的是**路径首层目录**（`group`）。
   若 T4 需要按 agency 分类筛选，**先与父任务确认**再扩形状。

---

## 9. 给 T4 的输入（按优先级）

1. **用 `resolvePersona()` 而不是自己 walk**：它把"三级来源 + 平台大小写 + 同名目录排除 +
   revision 比对"收在一处；`reason` 四种失败各有不同中文错误（§3.3）。
2. **`sourceKey` 必须存**（`builtin` / `user:<hash>` / `external:<hash>`）：改外部根配置时
   才能区分"源换了"与"文件改了"。
3. **`revision` 必须存**，且**加载时不带 `expectedRevision` 就是"接受任意版本"** ——
   绑定路径一定要带上它，否则 AX-R05 不成立。
4. **资源根只能用 `resolvePersona().resourceDir`**；`readPersonaResource` 的
   `relativePath` 来自 AI，**任何 `%` 都会被拒**（这是刻意的：编码绕过没法穷尽）。
5. **选择器复用 `client/taskProgressView.ts`**（T2 已说明）：不要在组件里内联状态判断。
6. **提示词**：无角色时最终提示词**逐字等于原流程**（AX-R07）；前置提示块只放角色 ID +
   "先调用 `workbench_load_persona`"指令，**不内联正文**。
7. **「分类」不在摘要里**（§8.9）：要按它筛选先问父任务。

## 10. 改动文件清单（`git status --short` 实测）

**修改**：`.gitignore`（`lib/` → `/lib/`）、`package.json`（`files` 加 `assets/personas`）、
`scripts/check-tgz.mjs`（改用可单测的 tar 读取器 + 内置资产校验）、
`src/api/routes.ts`（注册 personas 路由 + 设置读写 + `WorkbenchRouteDeps.personas`）、
`src/shared/contracts.ts`（`WorkbenchSettings` 三个字段）、`src/client/index.tsx`（设置初始值补三个字段）、
`tsconfig.build.json`（新增 `src/shared/persona.ts`、`src/personas/*.ts`）、
`test/routes.test.mjs`（角色设置/脏值/默认六篇 3 条）、`test/packageManifest.test.mjs`（包资产断言）。

**新增**：`src/shared/persona.ts`、`src/personas/parse.ts`、`src/personas/library.ts`、
`src/personas/resources.ts`、`src/db/repo/personas.ts`、`src/api/routes/personas.ts`、
`scripts/lib/tarReader.mjs`、`assets/personas/engineering/{实现者,只读审查者,反向验证者,调研者,方案设计者}.md`、
`assets/personas/quality/测试工程师.md`、`test/personaParse.test.mjs`、`test/personaLibrary.test.mjs`、
`test/tarReader.test.mjs`、本文件。

**未提交**（按共同执行契约：用户未要求提交代码）。`docs/release-checklist.md` 的用户改动原样保留。
