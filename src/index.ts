/**
 * dsh-workbench — host half.
 * V1 里程碑：DB 层已接（schema/migrate/seed），health 返回数据库状态。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { makeRoutes } from './api/routes.js'
import { openWorkbenchDb, type WorkbenchDbConfig } from './db/database.js'
import { seedDictionaries } from './db/seed.js'
import { proposeSubtasksTool, requestCompletionTool, submitReviewTool, submitTaskTool, updateTaskTool } from './tools.js'

export const name = 'workbench'

export const inject = ['webServer', 'systemPrompt', 'tools']

const WORKBENCH_GUIDANCE = [
  '本机已安装 dsh-workbench 插件（个人工作台）：侧边栏「工作台」入口；',
  'V1 能力：日历 + 任务列表、自然语言快速录入与 AI 澄清、子任务拆解（AI 提案 + 用户确认）、任务关联多个 Harness 会话。',
  'V1.5 已提供叶子任务“执行”：执行会话完成后应调用 workbench_request_completion 提交验收申请，由用户验收后完成。',
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
      const disposers = [submitTaskTool(db), proposeSubtasksTool(db), updateTaskTool(db), requestCompletionTool(db), submitReviewTool(db)].map((tool) => ctx.tools.register(tool))
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
