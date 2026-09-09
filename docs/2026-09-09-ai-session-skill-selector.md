# AI 会话前的 Skill 选择器（v1.11.0）

- 日期：2026-09-09
- 任务：个人工作台「Skill 选择器：AI 会话前可选 Skill 列表」
- 状态：已实现并本机实测通过

## 1. 需求

发起 AI 执行/协助/拆解/复盘等会话时，提示词输入框旁提供**可多选、可搜索**的 Skill 列表，
列表来源为**本机 DSH 已安装 Skill**；选中项注入会话提示词，AI 据此加载技能。

## 2. 现状盘点（改造前）

| 环节 | 现状 |
|---|---|
| 提示词拼装 | 在客户端本地完成：`src/client/index.tsx` 的 `startAISession()` 按 mode 选择模板字符串，末尾追加「用户补充要求」 |
| 提示词弹窗 | `askUserPrompt()` 返回 `string`（仅补充文本），`promptModal` 只管一个 textarea |
| 技能目录 | 工作台完全没有技能相关代码（全仓 grep `skill` 只命中字典里的“技能点子”） |
| 技能加载 | 由模型侧 `skill` 工具完成（注入 `<skill_content>`），宿主 `@deepseek-ai/dsh-skill` 的 `SkillRegistry`（服务名 `skills`）提供 `list()` / `get(name)` |

结论：**不需要改提示词模板本身**，只要在拼装前拿到用户选择、把指令前置即可；
技能目录需要新增一条 host → client 的只读通道。

## 3. 方案

### 3.1 数据通道（host）

```
GET /api/workbench/skills
  → { ok: true, available: true, skills: SkillSummary[] }
  → { ok: true, available: false, skills: [], error?: string }   // 宿主无 skills 服务 / 发现失败
```

- 新增 `src/api/skills.ts`：`probeSkills(ctx)` 软探测（`ctx.get('skills')`，要求存在 `list`），
  `normalizeSkillEntries()` 归一化 + `selectUserInvocable()` 过滤。
- 新增 `src/api/routes/skills.ts`：loopback 围栏 + 只允许 GET；`?raw=1` 返回注册表原始摘要（排障用）。
- `src/index.ts` 把它并入 `routes.unshift(...)`，与 dictionary/localDir/openFile 三个独立路由同构，
  保证热重载时随入口模块一起重载。

**关键取舍**

1. **绝不静态 `inject: ['skills']`**：宿主未装 `@deepseek-ai/dsh-skill` 时必须静默降级，
   工作台本体照常加载 —— 与 `reminder/adapter.ts` 探测 `dshIm` 同一条底线。
   （已实测：`ctx.get('skills')` 对未注册服务返回 `undefined`，不抛错。）
2. **只读摘要，不读正文**：`list()` 返回 `{name, description, whenToUse, invocation, source, provider}`，
   正文要 `get(name)`；本功能不调用，避免 host 侧拉全量正文。
3. **不假设文件目录**：本机不存在 `~/.dsh/skills`，技能由 skillport / skills-manager / 插件 provider 提供，
   一切以注册表为准。
4. **provider 脏数据不 500**：逐字段兜底，坏条目丢弃；发现抛错时返回空列表 + `error` 文案。

### 3.2 注入策略（client）

新增 `src/client/skillPrompt.ts`（纯函数，可单测）：

```ts
buildSkillPromptBlock(names)   // 空数组 → ''（零变化）
withSkillPromptBlock(prompt, names)  // 有选择 → 指令块前置到提示词最前面
```

注入文本形如：

```
本次会话需要先加载以下 Skill，并严格按它们的指引执行：
- vision-skills
- brainstorming
请先调用 skill 工具逐个加载（skill(name="<技能名>")），再开始下面的工作；若某个技能加载失败，请在回复里如实说明并继续。

<原有默认提示词 + 用户补充要求>
```

**为什么不内联技能正文**：一次会话可能选多个技能，正文体量与 token 成本不可控，且会污染上下文；
指令式注入让模型按需 `get` 正文，行为与 DSH 原生技能机制一致。

### 3.3 交互（client）

- `askUserPrompt()` 返回值由 `string` 改为 `{ text, skills }`，弹窗内新增技能选择器：
  搜索框（名称/描述/`whenToUse` 过滤）+ 已选标签（点击移除）+ 勾选列表（名称 + 描述 + provider）。
- 打开弹窗时按需拉取一次目录（`loadSkills()`），失败降级为空目录 → `skillsAvailable=false` → **选择器整块不渲染**。
- `clarify`（快速录入澄清）不弹提示词弹窗，因此不参与技能选择，保持原流程。
- 未选技能时 `finalPrompt` 与旧版**逐字一致**（单测断言）。

## 4. 验证

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 通过 |
| 单测 `test/skills.test.mjs` | 13/13 通过（归一化、过滤、路由围栏/降级/405、注入零变化与前置） |
| 全量单测 | 63/63 通过 |
| 本机实测 `GET /api/workbench/skills` | 200，`available:true`，9 个用户可调用技能（brainstorming / browser-use / frontend-design / genui / grill-me / image-vision / self-improvement / ui-bug-detection / vision-skills），provider 覆盖 dsh-skills-manager-external / dsh-genui / skillport / runtime |
| `?raw=1` 对照 | 原始 9 条与过滤后一致（本机全部 `userInvocable:true`） |
| 宿主无服务降级 | 单测覆盖（`available:false` + 空列表） |

## 5. 影响面与兼容性

- 新增文件：`src/api/skills.ts`、`src/api/routes/skills.ts`、`src/client/skillPrompt.ts`、`test/skills.test.mjs`。
- 改动文件：`src/index.ts`（注册路由）、`src/shared/contracts.ts`（`SkillSummary`/`SkillsResponse`）、
  `src/client/index.tsx`（弹窗 + 注入）、`src/client/components/Icon.tsx`（skill 图标）、
  `src/client/styles.ts`（选择器样式）、`tsconfig.build.json`（把 skillPrompt 纳入可测产物）、`package.json`（版本 + test 脚本）。
- 无数据库迁移、无 API 破坏性变更（纯新增端点）。
- 顺手修复：`test/reminder.test.mjs` 的 `withDb` 在清理临时目录前未关库，Windows 下必 EPERM（12 项提醒测试全挂），
  与本功能无关但会让本机 `pnpm test` 恒失败。

## 6. 后续（未做）

- 把「上次为某任务选过的技能」持久化到任务（当前为一次性选择）。
- 按任务类型/描述推荐技能（AI 预勾选）。
- 技能目录缓存与 `skills/change` 事件联动刷新（当前每次打开弹窗拉取一次）。
