/**
 * dsh-personal-workbench — host half.
 * V1/V1.5 能力已闭环；V2 起提供每日 AI 智能排序（daily_plans）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { makeRoutes } from './api/routes.js'
import { openWorkbenchDb, type WorkbenchDbConfig } from './db/database.js'
import { seedDictionaries } from './db/seed.js'
import { proposeDailyPlanTool, proposeIdeaClustersTool, proposeSubtasksTool, requestCompletionTool, submitIdeaTasksTool, submitKnowledgeTool, submitReportTool, submitReviewTool, submitTaskTool, updateTaskTool } from './tools.js'

export const name = 'personal-workbench'

export const inject = ['webServer', 'systemPrompt', 'tools']

const WORKBENCH_GUIDANCE = [
  '本机已安装 dsh-personal-workbench 插件（个人工作台）：侧边栏「工作台」入口；',
  'V1 能力：日历 + 任务列表、自然语言快速录入与 AI 澄清、子任务拆解（AI 提案 + 用户确认）、任务关联多个 Harness 会话。',
  'V1.5 已提供叶子任务“执行”：执行会话完成后应调用 workbench_request_completion 提交验收申请，由用户验收后完成；AI 不得直接把任务标记为完成/取消。',
  'V2 AI 智能排序：请调用 workbench_propose_daily_plan(plan_date, summary, items) 提交指定日期的执行顺序提案（只写草稿，用户确认后生效），不要修改任务字段；同一父子链不要同时入列。',
  'V2 日报/周报：请在报告会话中调用 workbench_submit_report(period_code, period_start, title, summary_md) 提交报告草稿，用户确认后才保存。',
  'V2 提醒：任务到期提醒由工作台自动弹出页面横幅与桌面通知；不要用其他方式重复提醒。',
  '知识库：值得沉淀的经验教训/决策/笔记请调用 workbench_submit_knowledge 提交知识草稿（kind_code/tags），用户确认后入库；复盘时优先考虑。',
  '点子/点子王：关联点子请调用 workbench_propose_idea_clusters；头脑风暴落地请调用 workbench_submit_idea_tasks。都只写草稿，用户确认后才生效。',
  '用户提到「工作台 / 任务 / 日历 / 提醒 / 子任务 / 计划 / 日报周报」时即指本插件，请据此协作。',
].join('')

const SECTION_ORDER = 150

export interface Config extends WorkbenchDbConfig {
  announceToAgent?: boolean
}

export function apply(ctx: Context, config: Config = {}): void {
  const db = openWorkbenchDb(config)
  seedDictionaries(db)
  const routes = makeRoutes(db)

  ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    },
    'dsh-personal-workbench: routes',
  )

  ctx.effect(
    () => {
      const disposers = [submitTaskTool(db), proposeSubtasksTool(db), proposeDailyPlanTool(db), submitReportTool(db), submitKnowledgeTool(db), proposeIdeaClustersTool(db), submitIdeaTasksTool(db), updateTaskTool(db), requestCompletionTool(db), submitReviewTool(db)].map((tool) => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    },
    'dsh-personal-workbench: tools',
  )

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
