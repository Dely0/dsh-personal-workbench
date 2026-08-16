/**
 * dsh-workbench — host half.
 * V1/V1.5 能力已闭环；V2 起提供每日 AI 智能排序（daily_plans）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { makeRoutes } from './api/routes.js'
import { openWorkbenchDb, type WorkbenchDbConfig } from './db/database.js'
import { seedDictionaries } from './db/seed.js'
import { proposeDailyPlanTool, proposeSubtasksTool, requestCompletionTool, submitReportTool, submitReviewTool, submitTaskTool, updateTaskTool } from './tools.js'

export const name = 'workbench'

export const inject = ['webServer', 'systemPrompt', 'tools']

const WORKBENCH_GUIDANCE = [
  '本机已安装 dsh-workbench 插件（个人工作台）：侧边栏「工作台」入口；',
  'V1 能力：日历 + 任务列表、自然语言快速录入与 AI 澄清、子任务拆解（AI 提案 + 用户确认）、任务关联多个 Harness 会话。',
  'V1.5 已提供叶子任务“执行”：执行会话完成后应调用 workbench_request_completion 提交验收申请，由用户验收后完成。',
  'V2 今日视图支持“AI 智能排序”：请调用 workbench_propose_daily_plan 提交当日执行顺序提案（只写草稿，用户确认后生效），不要修改任务字段。',
  'V2 支持日报/周报：请在报告会话中调用 workbench_submit_report(period_code, period_start, title, summary_md) 提交报告草稿，用户确认后才保存。',
  '用户提到「工作台 / 任务 / 日历 / 提醒 / 子任务」时即指本插件，请据此协作。',
].join('')

const SECTION_ORDER = 150

export interface Config extends WorkbenchDbConfig {
  announceToAgent?: boolean
}

export function apply(ctx: Context, config: Config = {}): void {
  const db = openWorkbenchDb(config)
  seedDictionaries(db)
  const routes = makeRoutes(db)

  const disposeRoute = ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    },
    'dsh-workbench: routes',
  )

  const disposeTools = ctx.effect(
    () => {
      const disposers = [submitTaskTool(db), proposeSubtasksTool(db), proposeDailyPlanTool(db), submitReportTool(db), updateTaskTool(db), requestCompletionTool(db), submitReviewTool(db)].map((tool) => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    },
    'dsh-workbench: tools',
  )

  const disposeSection = ctx.effect(() => {
    if ((config.announceToAgent ?? true) === false) return () => {}
    return ctx.systemPrompt.section({
      name: 'plugin:workbench',
      order: SECTION_ORDER,
      text: WORKBENCH_GUIDANCE,
    })
  }, 'dsh-workbench: prompt')

  ctx.effect(() => () => { db.close() }, 'dsh-workbench: db')
}
