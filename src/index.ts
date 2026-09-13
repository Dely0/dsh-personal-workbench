/**
 * dsh-personal-workbench — host half.
 * V1/V1.5 能力已闭环；V2 起提供每日 AI 智能排序（daily_plans）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { makeDictionaryRoute } from './api/dictionaryRoute.js'
import { makeLocalDirRoute } from './api/localDirRoute.js'
import { makeOpenFileRoute } from './api/openFileRoute.js'
import { makeRoutes } from './api/routes.js'
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
import { proposeDailyPlanTool, proposeIdeaClustersTool, proposeSubtasksTool, requestCompletionTool, saveTaskMemoryTool, submitIdeaTasksTool, submitKnowledgeTool, submitReportTool, submitReviewTool, submitTaskTool, updateTaskTool } from './tools.js'

export const name = 'personal-workbench'

export const inject = ['webServer', 'systemPrompt', 'tools']

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
  '用户提到「工作台 / 任务 / 日历 / 提醒 / 子任务 / 计划 / 日报周报」时即指本插件，请据此协作。',
].join('')

const SECTION_ORDER = 150

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
    isTargetConfigured: () => adapter.status().configured,
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
