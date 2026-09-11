/**
 * dsh-workbench — host half.
 * V1/V1.5 能力已闭环；V2 起提供每日 AI 智能排序（daily_plans）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { makeDictionaryRoute } from './api/dictionaryRoute.js'
import { makeLocalDirRoute } from './api/localDirRoute.js'
import { makeOpenFileRoute } from './api/openFileRoute.js'
import { makeRoutes } from './api/routes.js'
import { makeSkillRoutes } from './api/routes/skills.js'
import { probeSkills } from './api/skills.js'
import { openWorkbenchDb, type WorkbenchDbConfig } from './db/database.js'
import { seedDictionaries } from './db/seed.js'
import { countFiredRemindersSince, countQueue, enqueueReminder, listDueRemindersInWindow, listQueue, markQueueAttempt, readMeta, removeQueueEntry, skipStaleReminders } from './db/repo.js'
import { probeDshIm, WechatChannelAdapter } from './reminder/adapter.js'
import { readReminderPolicy, writeReminderPolicy } from './reminder/config.js'
import { ReminderScheduler } from './reminder/scheduler.js'
import { readWeixinInboundCount } from './reminder/weixin-status.js'
import { proposeDailyPlanTool, proposeIdeaClustersTool, proposeSubtasksTool, requestCompletionTool, saveTaskMemoryTool, submitIdeaTasksTool, submitKnowledgeTool, submitReportTool, submitReviewTool, submitTaskTool, updateTaskTool } from './tools.js'
import { defaultTasksWorkspace } from './workbenchPaths.js'

export const name = 'dsh-workbench'

export const inject = ['webServer', 'systemPrompt', 'tools', 'commands']

const WORKBENCH_GUIDANCE = [
  '本机已安装 dsh-workbench 插件（个人工作台）：侧边栏「工作台」入口；',
  'V1 能力：日历 + 任务列表、自然语言快速录入与 AI 澄清、子任务拆解（AI 提案 + 用户确认）、任务关联多个 Harness 会话。',
  'V1.5 已提供任务“执行”：任意节点（含父任务）均可执行，执行会话完成后应调用 workbench_request_completion 提交验收申请，由用户验收后完成；父任务验收通过时未完成子任务会级联完成。AI 不得直接把任务标记为完成/取消。',
  '任务共享记忆：执行/拆解/咨询过程中有关键上下文、阶段性结论或决策时，请调用 workbench_save_task_memory 保存到任务共享记忆；同一任务/子树下的后续会话会自动加载这些记忆。',
  'V2 AI 智能排序：请调用 workbench_propose_daily_plan(plan_date, summary, items) 提交指定日期的执行顺序提案（只写草稿，用户确认后生效），不要修改任务字段；同一父子链不要同时入列。',
  'V2 日报/周报：请在报告会话中调用 workbench_submit_report(period_code, period_start, title, summary_md) 提交报告草稿，用户确认后才保存。',
  'V2 提醒：任务到期提醒由工作台自动弹出页面横幅与桌面通知；不要用其他方式重复提醒。',
  '知识库：值得沉淀的经验教训/决策/笔记请调用 workbench_submit_knowledge 提交知识草稿（kind_code/tags）；如来自本地文档，应同时传入 file_link（file:// 或绝对路径）用于追溯；用户确认后入库；复盘时优先考虑。',
  '点子/点子王：关联点子请调用 workbench_propose_idea_clusters；头脑风暴落地请调用 workbench_submit_idea_tasks。都只写草稿，用户确认后才生效。',
  'AI 会话前用户可能通过工作台选择 DSH Skill；若提示词要求加载技能，请先调用 skill 工具逐个加载，加载失败要如实说明后继续。',
  '/workbench 是个人工作台“快速录入新任务”的专用命令：当用户消息以 /workbench 开头时，只把后续文字和用户提供的图片/PDF/DOCX理解为新任务线索，按 workbench-intake 规范澄清，并且只能调用 workbench_submit_task 写入 pending 任务草稿；不要执行、拆解、生成计划/报告/知识/点子/复盘，也不要处理微信提醒。',
  '用户提到「工作台 / 任务 / 日历 / 提醒 / 子任务 / 计划 / 日报周报」时即指本插件，请据此协作。',
].join('')

const WORKBENCH_INTAKE_COMMAND_PROMPT = [
  '你是“个人工作台”的任务澄清助手。请按 workbench-intake 规范执行。',
  '用户通过 /workbench 请求创建一个新的个人工作台任务。',
  '只处理新任务的澄清与提交：先一次询问一个主题、最多澄清 5 轮；信息足够后只能调用 workbench_submit_task 写入 pending 任务草稿。',
  '不要执行任务本身，不要拆解任务，不要生成计划、报告、知识、点子、复盘，也不要处理微信提醒。',
  '以下是用户通过 /workbench 提供的任务线索：',
].join('\n')

const SECTION_ORDER = 150

export interface Config extends WorkbenchDbConfig {
  announceToAgent?: boolean
  /** 提醒调度器扫描间隔（毫秒），缺省 30s；测试可调小 */
  reminderScanIntervalMs?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  const db = openWorkbenchDb(config)
  seedDictionaries(db)

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
    isTargetConfigured: () => adapter.status().configured,
    readInboundCount: () => readWeixinInboundCount(ctx),
    log: (message) => { ctx.logger?.info?.(message) },
  })

  const routes = makeRoutes(db, {
    channel: {
      status: () => adapter.status(),
      listOptions: () => adapter.listOptions(),
      resolveTarget: () => adapter.resolveTarget(),
    },
    policy: { read: () => readReminderPolicy(db), write: (raw) => writeReminderPolicy(db, raw) },
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
  routes.unshift(makeDictionaryRoute(db), makeLocalDirRoute(), makeOpenFileRoute(), ...makeSkillRoutes({ probe: () => probeSkills(ctx) }))

  ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    },
    'dsh-workbench: routes',
  )

  ctx.effect(
    () => {
      const disposers = [submitTaskTool(db), proposeSubtasksTool(db), proposeDailyPlanTool(db), submitReportTool(db), submitKnowledgeTool(db), proposeIdeaClustersTool(db), submitIdeaTasksTool(db), updateTaskTool(db), requestCompletionTool(db), submitReviewTool(db), saveTaskMemoryTool(db)].map((tool) => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    },
    'dsh-workbench: tools',
  )

  // 注册到 Harness 的斜杠命令发现面，使 /workbench 能在对话框补全菜单中出现。
  // 命令本身只负责进入快速录入语义，不把输入当作普通模型消息执行。
  ctx.effect(
    () => ctx.commands.register({
      name: 'workbench',
      description: '快速录入个人工作台新任务',
      input: { hint: '<任务文字>' },
      handler: ({ agent, rawInput }) => {
        const taskText = rawInput.trim()
        if (!taskText) {
          return { kind: 'error', text: '请在 /workbench 后输入任务文字。' }
        }
        const taskId = randomUUID()
        const taskFolderPath = join(defaultTasksWorkspace(), taskId)
        try {
          mkdirSync(taskFolderPath, { recursive: true })
        } catch (error) {
          return { kind: 'error', text: `无法创建任务资料夹：${error instanceof Error ? error.message : String(error)}` }
        }
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `${WORKBENCH_INTAKE_COMMAND_PROMPT}\n\n当前时间：${new Date().toISOString()}\n本次预分配任务 id：${taskId}\n任务资料夹：${taskFolderPath}\n任务资料夹相对路径：./${taskId}/\n\n请将本次任务相关文件放入该资料夹。提交草稿时必须传入 task_id="${taskId}"、workspace_path="${taskFolderPath}"。\n\n${taskText}` }],
          source: { kind: 'user' },
        }))
        return { kind: 'success', text: '已将任务线索送入当前工作区，开始按 workbench-intake 规范澄清。' }
      },
    }),
    'dsh-workbench: command',
  )

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
  }, 'dsh-workbench: prompt')

  ctx.effect(() => () => { db.close() }, 'dsh-workbench: db')
}
