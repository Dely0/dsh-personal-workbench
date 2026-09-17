/**
 * dsh-personal-workbench — host half.
 * V1/V1.5 能力已闭环；V2 起提供每日 AI 智能排序（daily_plans）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { makeDictionaryRoute } from './api/dictionaryRoute.js'
import { makeLocalDirRoute } from './api/localDirRoute.js'
import { makeOpenFileRoute } from './api/openFileRoute.js'
import { makeRoutes } from './api/routes.js'
import type { LlmModalityProbe } from './api/routes/model-modalities.js'
import { normalizeHostPath } from './api/routes/helpers.js'
import { makeSkillRoutes } from './api/routes/skills.js'
import { probeSkills } from './api/skills.js'
import { openWorkbenchDb, SchemaTooNewError, type WorkbenchDbConfig } from './db/database.js'
import { seedDictionaries } from './db/seed.js'
import { countFiredRemindersSince, countQueue, enqueueReminder, listDueRemindersInWindow, listQueue, markQueueAttempt, readMeta, removeQueueEntry, skipStaleReminders } from './db/repo.js'
import { probeDshIm, WechatChannelAdapter } from './reminder/adapter.js'
import { readReminderPolicy, writeReminderPolicy } from './reminder/config.js'
import { ReminderScheduler } from './reminder/scheduler.js'
import { readWeixinInboundCount } from './reminder/weixin-status.js'
import type { TeamMemoryService } from './review-memory.js'
import { taskWorkspaceFolderName } from './client/taskFolder.js'
import { proposeDailyPlanTool, proposeIdeaClustersTool, proposeSubtasksTool, requestCompletionTool, saveTaskMemoryTool, submitIdeaTasksTool, submitKnowledgeTool, submitReportTool, submitReviewTool, submitTaskTool, updateTaskTool } from './tools.js'

export const name = 'personal-workbench'

/**
 * 插件依赖。
 *
 * `commands`（v1.15.1，`/workbench` 斜杠命令）是**必需前置**：
 * 命令注册没有它根本不成立；而 `@deepseek-ai/dsh-commands` 从 `0.1.5-rc.1`
 * （= 本仓 `MIN_HOST_VERSION`）起就有，所以放进 `inject` 不会把支持范围内的宿主挡在外面。
 *
 * ⚠️ 与它相对的是 `llm`（模型输入能力查询）：那是**可选增强**，
 * 一律 `ctx.get` 软探测，**绝不放进 inject**（缺了只是少一条"这个模型不收图"的提前提示）。
 */
export const inject = ['webServer', 'systemPrompt', 'tools', 'commands']

/**
 * 软探测一个可选服务。
 *
 * **可选服务一律 `ctx.get()` 软探测，绝不放进 `inject`、绝不直接 `ctx.x`** ——
 * 这条规则是被真实事故逼出来的：cordis 的 inject 语义是"缺一个就整个插件 pending"，
 * 把 0.1.5 才有的服务写进去，旧宿主上直接 `Failed to load plugins`
 * （已复发 3 次：v1.10.1 的 uiWorkspace、v1.13.0 的 runtime.slots、v1.13.3 根治）。
 */
function probeService<T>(ctx: unknown, name: string): T | undefined {
  const getter = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  if (typeof getter !== 'function') return undefined
  try { return getter.call(ctx, name) as T | undefined } catch { return undefined }
}

const WORKBENCH_GUIDANCE = [
  '本机已安装 dsh-personal-workbench 插件（个人工作台）：侧边栏「工作台」入口；',
  'V1 能力：日历 + 任务列表、自然语言快速录入与 AI 澄清、子任务拆解（AI 提案 + 用户确认）、任务关联多个 Harness 会话。',
  'V1.5 已提供任务“执行”：任意节点（含父任务）均可执行，执行会话完成后应调用 workbench_request_completion 提交验收申请，由用户验收后完成；父任务验收通过时未完成子任务会级联完成。AI 不得直接把任务标记为完成/取消。',
  '任务共享记忆：执行/拆解/咨询过程中有关键上下文、阶段性结论或决策时，请调用 workbench_save_task_memory 保存到任务共享记忆；同一任务/子树下的后续会话会自动加载这些记忆。',
  'V2 AI 智能排序：请调用 workbench_propose_daily_plan(plan_date, summary, items) 提交指定日期的执行顺序提案（只写草稿，用户确认后生效），不要修改任务字段；同一父子链不要同时入列。',
  'V2 日报/周报：请在报告会话中调用 workbench_submit_report(period_code, period_start, title, summary_md) 提交报告草稿，用户确认后才保存。',
  'V2 提醒：任务到期提醒由工作台自动弹出页面横幅与桌面通知；不要用其他方式重复提醒。',
  '知识库：值得沉淀的经验教训/决策/笔记请调用 workbench_submit_knowledge 提交知识草稿（kind_code/tags）；如来自本地文档，应同时传入 file_link（file:// 或绝对路径）用于追溯；用户确认后入库；复盘时优先考虑。',
  '点子/点子王：关联点子请调用 workbench_propose_idea_clusters；头脑风暴落地请调用 workbench_submit_idea_tasks。都只写草稿，用户确认后才生效。',
  '/workbench 是个人工作台“快速录入新任务”的专用命令：当用户消息以 /workbench 开头时，只把后续文字理解为新任务线索，按 workbench-intake 规范澄清，并且只能调用 workbench_submit_task 写入 pending 任务草稿；不要执行、拆解、生成计划/报告/知识/点子/复盘，也不要处理微信提醒。',
  '任务资料夹：每个任务的文件请放在提示词里声明的“任务资料夹”（形如 <任务ID>-<标题片段>）里，不要在工作区根目录散放文件。',
  '用户提到「工作台 / 任务 / 日历 / 提醒 / 子任务 / 计划 / 日报周报」时即指本插件，请据此协作。',
].join('')

const SECTION_ORDER = 150

/**
 * `/workbench` 命令送给模型的澄清指令。
 *
 * 为什么在**服务端**也写一份提示词（客户端已经有一份）：斜杠命令是**宿主原生**入口 ——
 * 用户在官方输入框里打 `/workbench 周五接待客户`，命令处理器直接 steer 一条用户消息，
 * **完全不经过工作台面板**，所以拿不到客户端那份提示词。
 */
const WORKBENCH_INTAKE_COMMAND_PROMPT = [
  '你是“个人工作台”的任务澄清助手。请按 workbench-intake 规范执行。',
  '用户通过 /workbench 请求创建一个新的个人工作台任务。',
  '只处理新任务的澄清与提交：先一次询问一个主题、最多澄清 5 轮；信息足够后只能调用 workbench_submit_task 写入 pending 任务草稿。',
  '不要执行任务本身，不要拆解任务，不要生成计划、报告、知识、点子、复盘，也不要处理微信提醒。',
].join('\n')

/**
 * `ctx.commands` 的**最小本地形状**（只声明 `register`）。
 *
 * 与 `@deepseek-ai/dsh-commands` 的真实 d.ts 保持结构一致；用它而不是 `import type {} from`
 * 是因为那个包会牵出 `dsh-agent` / `dsh-brand` / `dsh-invariants` / `dsh-scope` / `dsh-session`
 * 一整串宿主包，而我们只用到一个 `register`。
 * 本仓对"只需要形状"的宿主能力一贯这么做（`capabilities.ts` 的 `SlotsProbe`）。
 *
 * 版本对齐由 `package.json` 的 peerDependencies 表达（`^0.1.5-rc.1`，= `MIN_HOST_VERSION`）。
 */
interface CommandsProbe {
  readonly register: (definition: CommandDefinitionProbe) => () => void
}

interface CommandDefinitionProbe {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly attachments?: boolean }
  readonly handler: (invocation: { readonly agent?: AgentProbe; readonly rawInput?: string }) => { readonly kind: 'success' | 'error'; readonly text: string }
}

/** `dsh-agent` 的 Agent 上我们只用到 `steer`（把一条用户消息送进当前会话）。 */
interface AgentProbe {
  readonly steer?: (message: unknown) => void
}

/**
 * 注册 `/workbench` 斜杠命令（v1.15.1）。
 *
 * ## 关键取舍
 *
 * - **用宿主 `ctx.commands.register`，不自建 DOM 补全浮层**：宿主注册的命令**本来就会进原生 `/` 菜单**
 *   （`dsh-client-ui-commands`），fork 那份 `installWorkbenchSlashMenu()` 在 `document` 上捕获一堆事件、
 *   手动定位 `textarea[data-phase]` 再预填 —— 是重复实现，而且定位/主题都易碎。
 * - 命令**不把输入当普通消息执行**：handler 里显式 steer 一条带澄清指令的用户消息，
 *   并回一条 success 文案让用户知道"已经进入澄清流程"。
 * - **先建任务资料夹再交给 AI**（与客户端同一套规矩）：资料夹名 = `<任务ID>-<标题片段>`，
 *   任务 ID 也一并写进提示词，AI 提交草稿时必须带上同一个 `task_id`。
 *   默认根目录没配置时**不编一个**（fork 写死 `~/Documents/aitasks`，本仓不抄），只是不声明资料夹。
 */
function registerWorkbenchCommand(ctx: Context, db: DatabaseSync): void {
  const commands = probeService<CommandsProbe>(ctx, 'commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    // inject 保证了它存在；真拿不到也**不静默**：打一条可读日志，命令只是不可用。
    const notice = '[dsh-personal-workbench] 未注册 /workbench 命令：宿主没有提供 commands 服务。'
    ctx.logger?.warn?.(notice)
    console.warn(notice)
    return
  }
  ctx.effect(() => commands.register(workbenchCommandDefinition(db)), 'dsh-personal-workbench: command')
}

/**
 * `/workbench` 的**命令定义本体**。
 *
 * 单独导出是为了能被单测**直接驱动** —— 注册外壳需要 cordis 上下文，
 * 而 handler 才是真正有语义、也真正该被钉住的部分
 * （见 `test/pluginEntry.test.mjs`；本仓对"能测的语义"一贯不留"只靠读代码"的角落）。
 *
 * 行为约定：
 * - 空输入 → `kind: 'error'` + 可读提示（**不** steer 一条空消息）；
 * - 有输入 → 先建任务资料夹（默认根目录没配置就跳过，**不编一条路径**），
 *   再 `agent.steer` 一条带 `task_id` / `workspace_path` 的用户消息；
 * - `agent.steer` 不可用 → 返回 error 而不是抛异常（宿主 UI 会把 error 当结果渲染）。
 */
export function workbenchCommandDefinition(db: DatabaseSync): CommandDefinitionProbe {
  return {
    name: 'workbench',
    description: '快速录入个人工作台新任务',
    input: { hint: '<任务文字>' },
    handler: ({ agent, rawInput }) => {
      const taskText = (rawInput ?? '').trim()
      if (taskText === '') return { kind: 'error', text: '请在 /workbench 后输入任务文字，例如：/workbench 周五 10:30 接待重要客户' }
      const taskId = randomUUID()
      const folderName = taskWorkspaceFolderName(taskId, taskText)
      const root = (readMeta(db, 'ai_default_workspace') ?? '').trim()
      let folderPath = ''
      if (root !== '') {
        /**
         * ⚠️ 必须过 `normalizeHostPath`（fresh-eyes 审查 F5）。
         *
         * 客户端那条链路会做 WSL 归一化（`normalizeWindowsPathToWsl`），
         * 而 `node:path.join` 只会把 `D:\DSHWorkspace` 与资料夹名拼起来 ——
         * 在一台"宿主跑在 WSL、设置里填的是 Windows 路径"的机器上，
         * `mkdirSync('D:\DSHWorkspace\x')` 会在当前目录建出一个名叫 `D:\DSHWorkspace` 的
         * **单层目录**，任务执行会话随后拿到一个不存在的 `workspace_path`。
         * 这里复用 `helpers.toNativePath`（既有的唯一实现），不再另写一套平台判断。
         */
        folderPath = normalizeHostPath(join(root, folderName))
        try {
          mkdirSync(folderPath, { recursive: true })
        } catch (error) {
          return { kind: 'error', text: `无法创建任务资料夹 ${folderPath}：${error instanceof Error ? error.message : String(error)}。请检查「工作台 → 设置」里的默认 AI 工作区是否可写。` }
        }
      }
      const context = [
        `当前时间：${new Date().toISOString()}`,
        `本次预分配任务 id：${taskId}`,
        folderPath === '' ? '任务资料夹：未配置默认 AI 工作区，本次不指定资料夹。' : `任务资料夹：${folderPath}`,
        folderPath === '' ? '' : `任务资料夹相对路径：./${folderName}/`,
        '',
        `提交草稿时必须传入 task_id="${taskId}"${folderPath === '' ? '' : `、workspace_path="${folderPath}"`}。`,
        folderPath === '' ? '' : '如需创建或修改本任务相关文件，请放在上述任务资料夹里，不要在工作区根目录散放文件。',
        '',
      ].filter((line) => line !== '').join('\n')
      if (typeof agent?.steer !== 'function') {
        return { kind: 'error', text: '当前会话不能接收命令转发（agent.steer 不可用），请改用工作台面板的「快速录入」。' }
      }
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: `${WORKBENCH_INTAKE_COMMAND_PROMPT}\n${context}${taskText}` }],
        source: { kind: 'user' },
      }))
      return {
        kind: 'success',
        text: folderPath === ''
          ? '已将任务线索送入当前会话，开始按 workbench-intake 规范澄清。'
          : `已将任务线索送入当前会话，任务资料夹：${folderPath}`,
      }
    },
  }
}

export interface Config extends WorkbenchDbConfig {
  announceToAgent?: boolean
  /** 提醒调度器扫描间隔（毫秒），缺省 30s；测试可调小 */
  reminderScanIntervalMs?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  let db: DatabaseSync
  try {
    db = openWorkbenchDb(config)
    seedDictionaries(db)
  } catch (error) {
    applyDegraded(ctx, error, config)
    return
  }
  applyReady(ctx, db, config)
}

/**
 * 数据库打不开时的降级路径：**保证 DSH 仍然能起来**。
 *
 * 为什么必须有这条路：`apply` 抛错会让 cordis 把整个 patch 行事务组回滚，
 * 宿主直接拒绝启动、GUI 都进不去（2026-09-12 的真实事故：工作台被 pnpm 回退到
 * 1.12.1，读不了已迁到 schema 15 的库，整个 DSH 起不来）。
 * 数据库比插件新属于运维常态，不该等于宿主不可用。
 *
 * 降级语义：不注册任何路由/工具/提醒调度（数据不可信，宁可什么都不做），
 * 但**照常注册 systemPrompt 告警**——这样 AI 会话里能直接看到"工作台已停用 + 怎么修"，
 * 用户不必去翻日志。
 */
function applyDegraded(ctx: Context, error: unknown, config: Config): void {
  const detail = error instanceof SchemaTooNewError
    ? `数据库 schema 版本 ${error.dbVersion} 比当前插件支持的 ${error.supportedVersion} 新`
    : `无法打开数据库：${String(error)}`
  const notice = `[dsh-personal-workbench] 已降级为空转：${detail}。`
    + '插件本体已加载但未注册路由/工具/提醒，工作台功能不可用。'
    + '修复：把 @dely0/dsh-personal-workbench 升级到与数据库 schema 匹配的版本'
    + '（如 `dsh plugin --profile web add @dely0/dsh-personal-workbench@latest`），然后重启 dsh web。'
    + '请勿降级数据库 schema——那会丢数据语义。'
  ctx.logger?.error?.(notice)
  // 控制台兜底：logger 未必被宿主接管，而这条信息决定用户能不能自救。
  console.error(notice)
  if ((config.announceToAgent ?? true) === false) return
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:workbench',
    order: SECTION_ORDER,
    text: `本机 dsh-personal-workbench 插件当前处于**降级空转**状态，工作台功能全部不可用。`
      + `原因：${detail}。`
      + '请告知用户：升级该插件到与数据库 schema 匹配的版本后重启 dsh web 即可恢复；'
      + '不要试图降级数据库，也不要调用任何 workbench_* 工具（它们未注册）。',
  }), 'dsh-personal-workbench: degraded-prompt')
}

/** 数据库正常可用时的完整装配（原 apply 主体）。 */
function applyReady(ctx: Context, db: DatabaseSync, config: Config): void {
  // 微信提醒通道适配层：ctx.get('dshIm') 软探测，未安装时静默降级。
  const adapter = new WechatChannelAdapter({
    db,
    probe: () => probeDshIm(ctx),
    readConfiguredTarget: () => ({
      botId: readMeta(db, 'reminder_bot_id') ?? null,
      targetId: readMeta(db, 'reminder_target_id') ?? null,
    }),
    queue: {
      enqueue: (entry, nextAttemptAt) => { enqueueReminder(db, { ...entry, nextAttemptAt }) },
      listDue: (nowIso) => listQueue(db).filter((entry) => entry.nextAttemptAt <= nowIso),
      remove: (id) => { removeQueueEntry(db, id) },
      markAttempt: (id, error, nextAttemptAt) => { markQueueAttempt(db, id, error, nextAttemptAt) },
      count: () => countQueue(db),
      statsSince: (iso) => countFiredRemindersSince(db, iso),
    },
  })

  const scheduler = new ReminderScheduler({
    db,
    adapter,
    /**
     * 通道是否就绪。
     *
     * 不能直接读 `adapter.status().configured` —— 它读的是适配层内存缓存 `cachedTarget`，
     * 而该缓存只在 `resolveTarget()` 里填充。进程刚启动（或插件热重载）时缓存为空，
     * 调度器会在 `channelReady` 处早退，把包括启动补发在内的\**所有任务提醒静默跳过**，
     * 直到有人手动保存一次提醒设置页。
     * （草稿通知侧早已绕开这一点，见 reminder/draft-notify.ts 的注释；任务提醒侧漏修。）
     *
     * 改为「缓存 → 数据库显式绑定 → 乐观放行并异步补解析」三级判定；
     * 真解析不到目标时 `send()` 会失败并照常入队退避，不会丢提醒。
     */
    isTargetConfigured: () => {
      if (adapter.status().configured) return true
      const botId = readMeta(db, 'reminder_bot_id')
      const targetId = readMeta(db, 'reminder_target_id')
      if (typeof botId === 'string' && botId.trim() !== '' && typeof targetId === 'string' && targetId.trim() !== '') return true
      void adapter.resolveTarget().catch(() => { })
      return adapter.available()
    },
    readInboundCount: () => readWeixinInboundCount(ctx),
    log: (message) => { ctx.logger?.info?.(message) },
  })

  const routes = makeRoutes(db, {
    /**
     * 团队记忆服务：**软探测**（`dsh-team-memory` 目前只注册 AI 工具、没有 provide 服务，
     * 所以这里通常拿不到 → 走"本地 Markdown + 队列补传"的等价通道）。
     * 绝不能把可选依赖写进 inject：那会让没装它的机器上整个插件 pending。
     */
    teamMemory: probeService<TeamMemoryService>(ctx, 'teamMemory') ?? probeService<TeamMemoryService>(ctx, 'dshTeamMemory'),
    /**
     * 宿主 `llm` 服务：只用来回答"某个模型收不收图片"（`/api/workbench/model-modalities`）。
     *
     * **软探测**，绝不进 `inject` —— 缺了只是少一条提前提示，
     * 而宿主的原生兜底（把图片换成占位文字）照常生效。
     */
    llmModalities: () => probeService<LlmModalityProbe>(ctx, 'llm'),
    channel: {
      status: () => adapter.status(),
      listOptions: () => adapter.listOptions(),
      resolveTarget: () => adapter.resolveTarget(),
    },
    policy: { read: () => readReminderPolicy(db), write: (raw) => writeReminderPolicy(db, raw) },
    /**
     * 页内提醒（前端轮询）的两条语义修正：
     * 1. **策略关闭时不返回任何提醒** —— 用户关掉提醒就该真的不弹（原先前端照旧弹）。
     * 2. **只返回窗口内的提醒** —— 超过 catchupWindowHours 的先落成终态（skipped_at），
     *    不再永久挂在「待处理」计数里；窗口内正常返回。
     */
    listDue: () => {
      const policy = readReminderPolicy(db)
      if (!policy.enabled) return []
      skipStaleReminders(db, policy.catchupWindowHours)
      return listDueRemindersInWindow(db, policy.catchupWindowHours)
    },
    test: async () => {
      const outcome = await adapter.send({ title: '工作台 · 微信提醒测试', body: `如果你在手机上看到这条消息，说明微信提醒已打通。\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}` })
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason }
    },
  })
  // 独立路由文件：保证热重载时新增/修复的“选择文件”“打开文件”“字典管理”“技能目录”接口能随入口模块一起重新加载。
  // 技能目录每次请求实时探测宿主 skills 注册表（未安装时返回空列表，前端隐藏选择器）。
  routes.unshift(makeDictionaryRoute(db), makeLocalDirRoute(), makeOpenFileRoute(), ...makeSkillRoutes({ probe: () => probeSkills(ctx) }))

  ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    },
    'dsh-personal-workbench: routes',
  )

  ctx.effect(
    () => {
      const disposers = [submitTaskTool(db), proposeSubtasksTool(db), proposeDailyPlanTool(db), submitReportTool(db), submitKnowledgeTool(db), proposeIdeaClustersTool(db), submitIdeaTasksTool(db), updateTaskTool(db), requestCompletionTool(db), submitReviewTool(db), saveTaskMemoryTool(db)].map((tool) => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    },
    'dsh-personal-workbench: tools',
  )

  // `/workbench` 斜杠命令：走宿主原生命令注册（→ 原生 `/` 菜单），不自建 DOM 补全浮层。
  registerWorkbenchCommand(ctx, db)

  // 提醒调度：用 ctx.interval（随 fiber 自动销毁）。
  // 注意：ctx.interval 由 @deepseek-ai/cordis-plugin-timer 提供，且**必须声明 inject** 才能访问
  // （cordis Proxy 未声明时直接抛 cannot get property "timer" without inject）。
  // 这里用 ctx.inject([...]) 把依赖限定在子 fiber：timer 不在时只有提醒调度不启动，
  // 工作台本体照常加载——保持"可选增量"这条底线。
  ctx.inject(['timer'], (timerCtx) => {
    const dispose = scheduler.start(timerCtx)
    void scheduler.catchup().catch((error) => { timerCtx.logger?.warn?.(`[workbench-reminder] catchup failed: ${String(error)}`) })
    return dispose
  })

  ctx.effect(() => {
    if ((config.announceToAgent ?? true) === false) return () => {}
    return ctx.systemPrompt.section({
      name: 'plugin:workbench',
      order: SECTION_ORDER,
      text: WORKBENCH_GUIDANCE,
    })
  }, 'dsh-personal-workbench: prompt')

  ctx.effect(() => () => { db.close() }, 'dsh-personal-workbench: db')
}
