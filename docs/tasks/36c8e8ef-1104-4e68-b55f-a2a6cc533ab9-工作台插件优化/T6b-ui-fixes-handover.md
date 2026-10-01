# 本轮 UI/交互修复交接（用户 6 条反馈）

任务 `cd8aa5f0-3f7f-4be0-939b-b3f38a9387e2`；2026-10-01。**这是 T6 之后、按用户当面反馈做的第二轮改动**，
不属于 T6 的原始验收范围。

用户原话六条 → 定案 → 实测，逐条如下。

---

## 0. 真实结果

```text
pnpm typecheck   → 退出码 0
pnpm build       → 退出码 0（buildId wb-d6492ae1d2d01c5f）
pnpm test        → tests 884 / pass 883 / fail 1
                    唯一失败 = test/db.test.mjs 清理期 rmSync EPERM（T1 起就在，与本轮无关，未删断言）
node scripts/dev-verify.mjs（真跑）→ runId 20261001-013852-ebffce
  8 套套件：verify-safety 20/20、legacy-acceptance 18/18、legacy-final-2 9/9、
            legacy-sidebar-collapse 6/6、legacy-duplicate-task 11/11、
            progress 13/13、daily-effort 13/13、persona 12/13（1 条模型层 skip）
  合计 102 passed / 0 failed / 1 skipped；39 张截图；三方构建标识一致（clientMatched true）
  链退出码 1 = persona 的模型层按规格记 skip（required + skipped = 不通过），**不是没跑通**
守护：正式库仍 schema 18 / 94 条任务；桌面端 19387 未重启（pid 17564，CreationDate 未变）
```

真浏览器冒烟（隔离实例 3080，真实鼠标 + DOM 重读 + 截图）：

| 验证点 | 实测 |
|---|---|
| 进度卡是否一行 | `.wb-progress-row` 下 **8 个控件**（标题/条/百分比/旁证图标/提示图标/五档/输入表单） |
| 长 tip | `tipPresent: false`（已删） |
| 旁证与提示 | 改成 `title` 悬停（实测 `title="子任务 1/1 已完成"`） |
| 快速录入 | SkillPicker ✅（6 个技能项）、PersonaPicker ✅（8 项 + 只看收藏按钮）、ModelPicker ✅ |
| 角色选择器 | 搜索常驻 ✅、「更多角色」按钮 **0 个** ✅、每行收藏/停用按钮 **0 个** ✅、老提示段 **0 个** ✅ |
| 「只看收藏」 | 点得到；无收藏时给可照做的提示（去设置里收藏） |
| 共享提示词弹窗 | **三个选择器齐全**：modelPickers 1 / skillPickers 1 / personaPickers 1，顺序 角色→技能→模型；技能 6 项、角色 8 项都有真实内容 |
| 模型目录（本机隔离实例） | 真的解出来了：两组（DeepSeek / DeepSeek Account）× 2 个模型，`errors: []` |

---

## 1. 六条的处理

| # | 用户反馈 | 定案 | 实现位置 |
|---|---|---|---|
| ① | 进度页面太高，把详情页撑丑 | 压成**一行**；长 tip 删除；旁证/黄色提示改 `title`；「完成任务」保留 primary 与级联确认 | `components/TaskProgress.tsx`、`styles.ts` |
| ② | 除快速录入外其他 AI 弹框无法选模型 | `QuickModelPicker` 抽成 `components/ModelPicker.tsx`，两个弹窗各挂一次；**并拆掉 `mode === 'clarify'` 门禁**（否则选了被静默忽略） | `components/ModelPicker.tsx`（新）、`index.tsx` |
| ③ | 快速录入无法选择 Skill | 技能块抽成 `components/SkillPicker.tsx`，两个弹窗各挂一次；**并修掉 `skills: []` 硬编码**（否则选了不进提示词） | `components/SkillPicker.tsx`（新）、`index.tsx` |
| ④ | 角色页要像「加载 Skill」那样；配置项搬设置页 | 搜索常驻 + 全部角色同页滚动；删「更多角色」与老提示段；新增「只看收藏」**筛选**；收藏/停用搬到「设置 → 角色库」 | `components/PersonaPicker.tsx`、`components/PersonaAdmin.tsx`（新）、`SettingsModal.tsx` |
| ⑤ | 任何页面改进度都会被弹回任务页（BUG） | 刷新详情不再带导航副作用：新增 `loadTaskDetail()`，`saveProgress` / `completeTaskFromProgress` 改走它 | `index.tsx` |
| ⑥ | 快速录用选模型报 `cannot get property "remote.session" without inject` | 见 §3：**宿主侧缺陷**，但**本机隔离实例上它是好的** | 独立记录，见 §3 |

### ④ 的最终形态

```
角色（专家人格）                          未指定（沿用该会话原有角色）
[🔍 搜索角色名 / 简介 / 分组 / 工作模式（共 N 个）]   [☆ 只看收藏]
────────────────────────────────────────────────
 未指定（沿用该会话原有角色）
 无角色
 engineering
   🧪 反向验证者 ★   …                        内置｜engineering｜只读诊断
   🔍 只读审查者     …                        内置｜engineering｜只读
 …（全部角色，启用在前、停用仍列出但不可选）
────────────────────────────────────────────────
共 N 个角色（当前显示 M 个；启用 x / 停用 y）· 收藏与停用在「设置 → 角色库」里改
```

---

## 2. 顺带修掉的工具链缺陷（都是"看起来是产品问题、其实是脚手架"）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 套件报"点了角色但没生效" | `clickByText` 用 `getBoundingClientRect()`（视口坐标）直接点，元素在**滚动区外**时 rect 落在视口外，鼠标事件被丢给别的东西。角色列表变长后必现 | `cdp.mjs#clickByText` 先 `scrollIntoView({block:'center'})`，**重新量一次**再点；套件里的 evaluate+clickAt 辅助也补上 |
| 2 | `progress` 套件的两条断言红 | ① 旁证从文本行改成悬停图标；② 长 tip 删了，而它承载着规格要求的"100 不是普通保存值" | ① 套件改读 `title`（意图不变）；② 把那句话搬到「完成任务」的 **title** —— 不占高度、语义不丢 |
| 3 | 源码级判据大面积假红（搬家导致） | 被断言的实现被抽到新文件（`ModelPicker.tsx` / `SkillPicker.tsx` / `runtimeServices.ts`） | 逐条判断后**让判据跟实现走**，并在测试里写清"这不是放宽、是因为实现搬家"；跨文件的不变量（如"三处读当前会话"）改成扫全部客户端源码 |
| 4 | 抽组件时把 `index.tsx` 切坏（`Document or statement expected`） | PowerShell 切片用了**在文件里出现两次的标记**，切错位置；另有一次把注释的 `/**` 开头切掉 | 一次性的迁移工具必须用**唯一标记**；修完再 `tsc --noEmit` 确认（本仓 skill §14 已记这条） |

**新增/改的判据**（防回归）：

- `test/quickIntakeClient.test.mjs`：+2 条 —— 快速录入的 `skills` 不许再是 `[]`；三个选择器必须在**两个**弹窗里各出现一次 + 弹窗内顺序 角色→技能。
- `test/progressWiring.test.mjs`：+1 条 ⑤ 的判据（`saveProgress`/`completeTaskFromProgress` 走 `loadTaskDetail`，且 `loadTaskDetail` 里没有 `setView`）；改 1 条（"100 不是普通保存值"改判 title 位置）。
- `test/personaWiring.test.mjs`：+3 条 —— `personaPickerList` 的搜索/筛选口径；选择器不许再有 `expanded`/收藏停用写入口/老提示段；设置页承接收藏停用且**写前现读服务端现值**。
- `test/clientInvariants.test.mjs`：改为扫全部客户端源码，"至少三处走 `currentSessionIdOf`"不变。

---

## 3. ⑥ 的结论（要区分"哪台机器"）

**用户现象**：快速录入里选模型报
`本次未切换模型…原因：模型选择接口在场，但这次取不到该会话的模型目录：宿主为会话 session-… 解析模型目录时抛错：cannot get property "remote.session" without inject`。
用户在**桌面端**也复现同样报错。

**本机实测（隔离测试实例 3080，与本轮同一份构建）**：

```
模型菜单打开后：groups = ["DeepSeek", "DeepSeek Account"]
options = [跟随 DSH 默认模型, DeepSeek-V41-Flash, DeepSeek-V4-Pro, …]
errors = []
```

**也就是说：这个宿主接口在 web profile 上是好的，模型选择在快速录入里真的可用。**

链路（供上报时用）：

```
工作台/宿主 UI → ctx.get('modelDirectories').directoryFor(sessionId)
  └─ @deepseek-ai/dsh-client-ui-model-selection@0.1.7-rc.2  lib/client.js:381
       class ModelDirectoryResolver  static inject = ["sessions","remote","remote.session"]   client.js:344-348
       第一句取 this.ctx.remote.session                                                        client.js:381-398
         └─ cordis 代理抛 cannot get property "remote.session" without inject
              （profiles/node_modules/@deepseek-ai/cordis/lib/index.js:676）
提供 `remote.session` 的是 @deepseek-ai/dsh-api-session-controller@0.1.7-rc.2，而它的
dsh.client.inject 里**没有任何地方 provide 这个名字**；相关包版本全部对齐（0.1.7-rc.2），
所以不是"装了个旧包"。
```

**判断**：跨客户端复现 ⇒ 宿主侧问题；但**它取决于客户端组合**（web profile 正常、桌面端应用内组合异常）。
所以能做的两件事：

1. **工作台侧**（本轮已做）：不再因为没有模型目录而**反复弹红字**；「跟随 DSH 默认模型」在任何情况下都点得到、点了真清残留。降级兜底（`modelCapability.ts:341-365`）保持不动。
2. **上报 DSH 团队**（待用户决定）：给上面那段链路 + 桌面端复现步骤。**本轮不改** `profiles/node_modules` 里的任何东西。

**未验证**：桌面端那个组合下的修复效果 —— 工作台改不了宿主组合，所以只能等宿主侧修或换组合后再验。

---

## 4. 改动文件

**新增**：`src/client/components/ModelPicker.tsx`（从 index.tsx 抽出，原 `QuickModelPicker`）、
`src/client/components/SkillPicker.tsx`、`src/client/components/PersonaAdmin.tsx`、
`src/client/runtimeServices.ts`（`pluginCtx`/`optionalService`/`safeService`/`currentSessionIdOf` 抽成共享模块，顺带把可变全局收进 setter）。

**修改**：`src/client/index.tsx`（少了约 550 行；⑤ 的修复、②③ 的弹窗接线、④ 的入口、拆 clarify 门禁）、
`src/client/components/TaskProgress.tsx`、`src/client/components/PersonaPicker.tsx`、
`src/client/components/SettingsModal.tsx`、`src/client/personaPicker.ts`、`src/client/styles.ts`、
`scripts/verify/cdp.mjs`（点击前滚进视口）、`scripts/verify/suites/progress.mjs`、
`test/{quickIntakeClient,progressWiring,personaWiring,clientInvariants,quickIntakeDefaultWiring,modelPickerDegrade}.test.mjs`。

**未做**：未装盘到 desktop、未重启 19387、未迁移正式库、未改公开版本号、未 git commit、未改宿主包。

---

## 5. 用户待验收（正式实例）

桌面端 19387 仍跑公开发布版。要在这台机器上看到本轮的改动，需要走 `dsh-safe-plugin-ops` 把 dev 包装进 desktop profile 并重启应用。届时请重点看：

1. 任务详情页的进度卡是不是**一行**（提示与旁证改成鼠标悬停可见）；
2. 「快速录入」与「AI 协助/咨询/拆解/排序」等任意 AI 弹窗里，**模型 / 技能 / 角色**三个选择器都在；
3. 「快速录入」里选的**技能**（保存后开一次会话，看提示词是否注入了"请加载这些技能"）；
4. 角色选择器：搜索在首屏、能滚、能「只看收藏」；收藏/停用已移到「设置 → 角色库」；
5. 在**日历/今日页**改任务进度，看是否**不再被弹回任务页**；
6. 快速录入选模型的报错是否仍在（桌面端组合问题，见 §3）。
