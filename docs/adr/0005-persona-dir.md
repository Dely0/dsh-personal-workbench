# 角色 = LS-Skills 形态的 persona 文档，默认不依赖任何第三方插件

**Status:** accepted（2026-09-30；同日修订：形态与公司 `LS-Skills/personas/` 对齐）

## 背景

需求是「在进行 AI 对话（澄清 / 执行 / 协助 / 拆分）前选择专家人格」。调研得到三条事实：

1. 官方 `@deepseek-ai/dsh-persona` 是**组合级静态身份**（cordis 组合行，把 `prefix`/`suffix`
   注册成 prompt registry 的 `deployment:persona-prefix`/`-suffix` 段，**必须挂在 agent preset 的 scope 里**
   才生效，挂全局会与注册表自身注册冲突并报错）：**没有名册、没有会话中切换、没有客户端 UI**。
2. `@michengai/dsh-agency-agents` 是**另一个第三方插件**（本机只装在桌面 profile），
   且它的中文名册里有 **45/321 条正文被削成同一段通用模板**。
3. **公司已经有这套资产**：`D:\Code\Linksight\LS-Skills\personas\`（9 篇中文 persona 落成件，
   合计 58692 字符）+ `vendor/UPSTREAM.md`（上游 `K-Dense-AI/scientific-agents`，MIT / 503 人格，
   commit 与改写登记）+ `references/`（形态判据、agency 机制调研、交接件）。

## 决定

1. **一个角色 = 一份 `.md`**，形态与 `LS-Skills/personas/` **完全对齐**：
   `# 名称` 一级标题 + `> 元信息块`（分类 / 工作模式 / 建议 emoji / 建议简介）+ 正文。
   **frontmatter 是可选增强**（有则优先用它取名称 / 简介 / 分组）。
   想带附件就建**同名文件夹**（如 `rf-天线测量专家/`）作为资源。**现有 9 篇零改动即可读。**
2. **三级角色库**：内置（随包只读）+ 用户库（`~/.dsh/workbench/personas`）+
   **外部角色目录（可配、一等公民）** —— 把 `D:\Code\Linksight\LS-Skills\personas` 配进去即可。
   **同相对文档路径**（逻辑ID）时按用户库 > 外部目录 > 内置覆盖；同显示名称但不同路径是不同角色，界面标出来源。不自动复制内置到用户库。
   本轮不做“复制为我的角色”按钮，用户可自行放文档到用户目录；该管理动作留下一轮。
3. **正文不进提示词**（工作台提示词已经太长）：发起会话时只登记「本次角色 = `<id>`」到那次会话，
   提示词加一行；正文由工具按需取：
   - `workbench_load_persona()` —— 按**会话绑定**返回正文 + 资源清单；
   - `workbench_read_persona_resource(path)` —— 取单条资源（有上限）。

   **为什么不给文件路径让 AI 自己读**：会话沙箱在用户机器上不一定允许读工作区之外的路径。
4. **正文上限 20000 字符**（沿用 agency 的 `customExpertInputSchema.prompt` 契约，
   中文字符压缩比约 43%）—— 保住「角色还能同步回 agency」这条路；超限给**可读中文原因**。
5. **正文里直接写 skill 名**（如 `dotnet-ui`），由会话里的 `skill` 工具按需加载 ——
   这是 `LS-Skills` 的**既有决策**，也是工作台**已有的技能选择器**那条路，不引入新机制。
6. **资源边界**：`resources/` 只放**跨项目通用**的清单 / 模板 / 脚本；
   **项目知识一律留给 skill**（`LS-Skills` 的既定原则：同一内容只存一处，
   否则 skill 一更新，persona 里的副本就是错的）。
7. **默认不依赖第三方**：本轮只落本地三级来源与provider接口，不接实际agency服务。
   后续适配仅在检测到服务且用户显式打开时作为只读来源，并需另补契约/测试；不把可选增强写成必需inject。
8. **粒度分工**：内置库放「**工作方式型**」角色（实现者 / 审查者 / 反向验证者 / 调研者 / 方案设计者…，
   随包发布、人人可用）；公司「**领域 / 岗位型**」角色走**外部角色目录**，不在包里复制一份。
9. **选择器 UI**：默认只显示已启用 / 已收藏，更多进二级（分组 + 搜索）；**没有角色时行为与旧版完全一致**。

## Considered Options

- **正文直接注入提示词**：提示词变长（用户明确否掉），长度不可控。
- **注册成 DSH Skill 复用 `skill` 工具**：要么往 `~/.dsh/skills` 写（越界、污染用户技能目录），
  要么给宿主实现 skill provider（新服务，工作量与事故面都大）。
- **写进任务资料夹、提示词只给路径**：资料夹多杂物、每次会话要幂等重写、依赖沙箱可读。
- **复用知识库条目当角色**：知识 ≠ 角色，语义糊在一起，筛选 / 导出 / 权限以后都分不开。
- **坚持目录包形态（`<slug>/AGENT.md`）**：现有 9 篇要写转换脚本搬一遍，
  权威源与工作台副本必然漂移 —— 正是 `LS-Skills` 明确要避免的两个事实源。

## Consequences

- 公司现有 9 篇中文 persona **零改动**即可被工作台读取；**权威源仍在 `LS-Skills`**
  （agency settings 与工作台读到的都是**产物**）。工作台不复制、不派生。
- 素材与判据沿用团队既有结论：领域专家用 **MIT 人格骨架 + 自家 skill 填阈值**
  （`K-Dense-AI/scientific-agents`）；`LS-Skills/references/vendoring.md` 的形态判据
  （过程性知识 → skill；角色与判断力 → persona）就是我们的判据。
- 从开源 persona 搬角色时注意团队记忆 `01M3J4Z6MA822EZ66YVHKMP8TY` 的三条：
  格式可直搬、**简介普遍超长需改写**、上游多为**只读顾问**（所以默认库里审查者与实现者要各放几个）。
- `package.json` 的 `files` 要加内置角色库目录，否则发布出去的包里没有默认人格。
- 引用：[`personas/README.md`](../../../LS-Skills/personas/README.md)、
  [`vendor/UPSTREAM.md`](../../../LS-Skills/vendor/UPSTREAM.md)、
  [`references/vendoring.md`](../../../LS-Skills/references/vendoring.md)、
  [`references/handover-2026-09-28.md`](../../../LS-Skills/references/handover-2026-09-28.md)。
  （路径指向本机同级的 `LS-Skills` 仓库；换机器时请按实际克隆位置对齐。）

## 实施契约（2026-09-30 补齐）

本轮固定内置6篇；递归发现rf/dotnet子目录，稳定ID为相对文档路径。首次prompt前用ai_session_registry的persona scope绑定，工具只按真实exec.sessionId加载；文件revision变化明确拒绝旧绑定，换角色须新会话，不在复用提前返回时吞掉选择。资源仅限同名附件目录的文本相对路径，有大小/类型/realpath边界，禁止link/junction越界和执行脚本。

frontmatter限顶层标量增强；元信息解析、UTF16计数、发现上限、设置字段、各mode接线和provider后续边界以[开发规格](../tasks/36c8e8ef-1104-4e68-b55f-a2a6cc533ab9-工作台插件优化/requirements.md) R-R为准，测试见同目录acceptance.md。
