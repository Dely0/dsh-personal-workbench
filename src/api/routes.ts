/**
 * /api/workbench/* 路由入口。Loopback-only 保护（同 dsh-ssh 的信任围栏）。
 *
 * 领域路由已拆分到 routes/：tasks / reminders / drafts / ideas / idea-clusters /
 * knowledge / ai-sessions / reports / plans。本文件保留组合入口与跨领域基础端点
 * （workspaces/ensure、settings、bootstrap、maintenance、health）。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  ensureRecurringInstances, fireReminder, getDailyPlan, getTask, listDictionaries, listDueReminders, listTasks,
  localDateString, readMeta, repairParentCompletion, writeMeta,
} from '../db/repo.js'
import { makeAiSessionRoutes } from './routes/ai-sessions.js'
import { makeDraftRoutes } from './routes/drafts.js'
import { isLoopbackRequest, readJsonBody, todayRange, writeJson } from './routes/helpers.js'
import { makeIdeaClusterRoutes } from './routes/idea-clusters.js'
import { makeIdeaRoutes } from './routes/ideas.js'
import { makeKnowledgeRoutes } from './routes/knowledge.js'
import { makeKnowledgeRecallRoutes } from './knowledgeRecallRoute.js'
import type { KnowledgeRecallManager } from '../knowledge-recall.js'
import { makeModelModalityRoutes, type LlmModalityProbe } from './routes/model-modalities.js'
import { makePlanRoutes } from './routes/plans.js'
import { makePersonaRoutes, type PersonaRouteOptions } from './routes/personas.js'
import { makeQuickAttachmentRoutes } from './routes/quick-attachments.js'
import { makeReminderRoutes, type ReminderRouteDeps } from './routes/reminders.js'
import { makeReportRoutes } from './routes/reports.js'
import { makeTaskRoutes } from './routes/tasks.js'
import type { TeamMemoryService } from '../review-memory.js'
import { teamMemoryAvailable } from '../review-memory.js'
import { normalizeRecentWorkspaces } from '../shared/quickWorkspaceRecent.js'
import { classifyTaskDay } from '../shared/dailyPlanPolicy.js'
import { isOpenTask } from '../shared/taskProgress.js'
import type { WorkbenchSettings } from '../shared/contracts.js'
import { readPersonaSettings, writePersonaSettings } from '../db/repo/personas.js'

/**
 * 插件版本：直接读包内 package.json，避免再出现"代码已升级、health 还报旧版本"的漂移。
 * lib/api/routes.js 相对包根是 ../../package.json。
 */
const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch { return 'unknown' }
})()

/**
 * 构建标识（plan.md V04-B）：读**随包**的 `lib/build-info.json`。
 *
 * lib/api/routes.js 相对包根是 ../../lib/build-info.json —— 与 PACKAGE_VERSION 同一层目录。
 * 它由 scripts/build-info.mjs 在构建时生成，内容哈希来自构建输入（不含时间戳）。
 *
 * 为什么 health 必须报它：版本号在装盘迭代里**根本不变**（本地迭代刻意不改版本号），
 * 只比版本号会把"旧包还在跑"判成通过。验收链同时比对目标包 manifest / host health /
 * 浏览器根属性三者，缺一即失败。
 */
const PACKAGE_BUILD_ID: string = (() => {
  try {
    const info = JSON.parse(readFileSync(new URL('../../lib/build-info.json', import.meta.url), 'utf8')) as { buildId?: string }
    return typeof info.buildId === 'string' && info.buildId !== '' ? info.buildId : 'unknown'
  } catch { return 'unknown' }
})()

/** 每天可投入时长（分钟）：存 meta，缺省 390（6.5 小时），夹在 30–1440 之间。 */
export const DEFAULT_DAILY_CAPACITY_MINUTES = 390
export function readDailyCapacityMinutes(db: DatabaseSync): number {
  const raw = Number(readMeta(db, 'daily_capacity_minutes'))
  if (!Number.isFinite(raw) || raw < 30) return DEFAULT_DAILY_CAPACITY_MINUTES
  return Math.min(1440, Math.round(raw))
}

/**
 * 没填「预计耗时」时的默认分钟数：存 meta，缺省 30，夹在 5–1440 之间。
 *
 * ⚠️ 这两个常量（`DEFAULT_ESTIMATE_MINUTES` / `MIN_ESTIMATE_MINUTES`）与客户端
 * `src/client/capacity.ts` 里**必须同值**：一处是"读书时兜底"，一处是"落库时夹取"，
 * 不同值就会出现"库里存 3 分钟、界面按 5 分钟算"的双口径。
 * 测试 `test/routes.test.mjs` 直接 import 客户端那份做交叉断言，不靠人记。
 */
export const DEFAULT_SETTINGS_ESTIMATE_MINUTES = 30
export const MIN_SETTINGS_ESTIMATE_MINUTES = 5
export const MAX_SETTINGS_ESTIMATE_MINUTES = 1440
export function readDefaultEstimateMinutes(db: DatabaseSync): number {
  const raw = Number(readMeta(db, 'default_estimated_minutes'))
  if (!Number.isFinite(raw) || raw < MIN_SETTINGS_ESTIMATE_MINUTES) return DEFAULT_SETTINGS_ESTIMATE_MINUTES
  return Math.min(MAX_SETTINGS_ESTIMATE_MINUTES, Math.round(raw))
}

/**
 * 读取「最近用过的工作区」列表。
 *
 * 存 meta 的 JSON 字符串（单键，不动 schema）：这是**用户偏好**而非业务数据，
 * 且必须容忍脏值（手改过 meta、旧版本写过别的形状）——解析失败就返回空数组，
 * 绝不让一个坏字符串把设置接口整个打挂。脏值也在这里归一化（去重/截断）。
 */
export function readRecentWorkspaces(db: DatabaseSync): string[] {
  const raw = readMeta(db, 'quick_workspace_recent')
  if (raw === undefined || raw === '') return []
  try { return normalizeRecentWorkspaces(JSON.parse(raw)) } catch { return [] }
}


export interface WorkbenchRouteDeps extends ReminderRouteDeps {
  /**
   * 团队记忆服务（`dsh-team-memory` 目前**并未** provide 任何服务，所以通常是 undefined）。
   * 软探测拿到时才注入；拿不到就走"本地 Markdown + 队列补传"的等价通道。
   */
  teamMemory?: TeamMemoryService
  /**
   * 宿主 `llm` 服务的**软探测**（v1.15.1）。
   *
   * 只用来回答"某个模型收不收图片"（见 `routes/model-modalities.ts`）。
   * **绝不能写进 `inject`**：它是可选增强，缺了只是少一条提前提示，
   * 写进去会让旧宿主上整个插件 pending（该模式在本仓已复发 3 次）。
   */
  llmModalities?: () => LlmModalityProbe | undefined
  /**
   * 知识库自动召回管理器（v1.15.3）。
   *
   * 由入口（`index.ts`）创建并注入 —— **不是**这里 new 一个：
   * 它同时被 Agent 工具与提示注入钩子使用，单会话开关/已注入集合必须只有一份状态。
   * 未注入（测试里的朴素用法）时这几个端点不注册，其余路由照常。
   */
  knowledgeRecall?: KnowledgeRecallManager
  /**
   * 角色库路由的可注入选项（D11）。
   *
   * **只给测试用**：生产三个根由 `resolvePersonaRoots` 从设置项 + 包内资产 + `homedir()`
   * 算出来。留这个口是因为 `homedir()` 不认环境变量 —— 没有它，"用户库覆盖内置"
   * 这条覆盖顺序只能用假的对象测，而不是真实文件。
   */
  personas?: PersonaRouteOptions
}

/**
 * 读一份完整的设置视图（GET 与 POST 的响应**共用这一个实现**）。
 *
 * 为什么必须抽出来：原先 GET/POST 各写一份字面量，加字段时极易只加一处 ——
 * 表现为"保存后返回的设置少了一个字段"，而前端是拿响应回填 state 的，
 * 于是那个开关看起来"保存后自己变回去了"（本轮加 `autoKnowledgeRecall` 时正好撞上这个风险）。
 */
export function readWorkbenchSettings(db: DatabaseSync): WorkbenchSettings {
  return {
    defaultWorkspace: readMeta(db, 'ai_default_workspace') ?? '',
    autoCreateTypeFolders: (readMeta(db, 'auto_create_type_folders') ?? '1') === '1',
    desktopNotify: (readMeta(db, 'desktop_notify') ?? '1') === '1',
    dailyCapacityMinutes: readDailyCapacityMinutes(db),
    quickWorkspaceRecent: readRecentWorkspaces(db),
    /** 缺省**开**：功能不默认关闭，否则用户永远发现不了它（关掉是显式动作）。 */
    autoKnowledgeRecall: (readMeta(db, 'knowledge_recall_auto') ?? '1') !== '0',
    defaultEstimateMinutes: readDefaultEstimateMinutes(db),
    /** 缺省**关**：逾期是历史欠账，默认不混进"今天要做的事"（见 contracts 里的说明）。 */
    dailyCapacityIncludeOverdue: (readMeta(db, 'daily_capacity_include_overdue') ?? '0') === '1',
    /** 角色库三个偏好：**唯一读入口**在 `db/repo/personas.ts`（与写入端共用一处形状）。 */
    ...readPersonaSettings(db),
  }
}

export function makeRoutes(db: DatabaseSync, deps: WorkbenchRouteDeps = {}): WebRoute[] {
  return [
    // ------------------------------------------------------------------ quick attachments
    // PDF/DOCX 正文抽取（护栏见 routes/quick-attachments.ts 的文件头注释）。
    ...makeQuickAttachmentRoutes(),
    // 模型输入能力对照表（客户端用它判断"选了不收图的模型还加了图"）。
    ...makeModelModalityRoutes(() => deps.llmModalities?.()),
    /**
     * 知识库自动召回的可观测端点（日志 / 状态 / 开关，v1.15.3）。
     *
     * 与其余路由一样 loopback-only；`knowledgeRecall` 由入口注入（与 Agent 工具、
     * 提示注入钩子共享同一个管理器实例 → 单会话开关只有一份状态）。
     */
    ...(deps.knowledgeRecall === undefined ? [] : makeKnowledgeRecallRoutes(db, deps.knowledgeRecall)),
    ...makeReminderRoutes(db, {
      channel: deps.channel,
      policy: deps.policy,
      test: deps.test,
      // 优先用调用方注入的实现（入口会带上"策略开关 + 补发窗口"语义）；
      // 未注入时退回朴素版本，供测试等场景直接使用。**不要在这里硬编码覆盖**——
      // 曾经因为硬编码 listDueReminders(db) 把入口注入的策略/窗口语义悄悄吃掉。
      listDue: deps.listDue ?? (() => listDueReminders(db)),
      fire: deps.fire ?? ((id: string) => fireReminder(db, id)),
    }),
    // ------------------------------------------------------------------ personas
    /**
     * 角色库（D11）：摘要列表 + 资源只读读取。
     *
     * 三级来源的**根解析只有一处**（`resolvePersonaRoots`）：外部根读设置项，
     * 用户库在 `~/.dsh/workbench/personas`，内置库在包内 `assets/personas`。
     * `deps.personas` 只用于**测试注入根**（生产不传）。
     */
    ...makePersonaRoutes(db, deps.personas ?? {}),
    // ------------------------------------------------------------------ workspace ensure
    {
      kind: 'exact',
      path: '/api/workbench/workspaces/ensure',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const path = typeof body?.path === 'string' && body.path.trim() !== '' ? body.path.trim() : undefined
        if (path === undefined) return writeJson(res, 400, { error: 'path is required' })
        try {
          mkdirSync(path, { recursive: true })
          return writeJson(res, 200, { ok: true, path })
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------------ settings
    {
      kind: 'exact',
      path: '/api/workbench/settings',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const method = req.method ?? 'GET'
        if (method === 'GET') return writeJson(res, 200, { ok: true, settings: readWorkbenchSettings(db) })
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          if (typeof body.defaultWorkspace === 'string') writeMeta(db, 'ai_default_workspace', body.defaultWorkspace)
          if (body.autoCreateTypeFolders === true || body.autoCreateTypeFolders === false) writeMeta(db, 'auto_create_type_folders', body.autoCreateTypeFolders ? '1' : '0')
          if (body.desktopNotify === true || body.desktopNotify === false) writeMeta(db, 'desktop_notify', body.desktopNotify ? '1' : '0')
          /**
           * 知识库自动召回开关（v1.15.3）：写的是**同一个 meta 键**
           * （`knowledge_recall_auto`），与 `/api/workbench/knowledge-recall/auto` 共享 ——
           * 两个入口写两个键就一定会出现"设置页显示开、实际按关跑"的矛盾。
           */
          if (body.autoKnowledgeRecall === true || body.autoKnowledgeRecall === false) {
            writeMeta(db, 'knowledge_recall_auto', body.autoKnowledgeRecall ? '1' : '0')
            deps.knowledgeRecall?.setAutoEnabled(body.autoKnowledgeRecall)
          }
          if (typeof body.dailyCapacityMinutes === 'number' && Number.isFinite(body.dailyCapacityMinutes)) {
            const minutes = Math.min(1440, Math.max(30, Math.round(body.dailyCapacityMinutes)))
            writeMeta(db, 'daily_capacity_minutes', String(minutes))
          }
          /**
           * 默认耗时（v1.15.1）：没填「预计耗时」的任务按它计入今日容量。
           * 夹 5–1440，缺省 30；越界按边界落库而不是静默丢弃（静默丢件是禁区）。
           */
          if (typeof body.defaultEstimateMinutes === 'number' && Number.isFinite(body.defaultEstimateMinutes)) {
            const minutes = Math.min(MAX_SETTINGS_ESTIMATE_MINUTES, Math.max(MIN_SETTINGS_ESTIMATE_MINUTES, Math.round(body.defaultEstimateMinutes)))
            writeMeta(db, 'default_estimated_minutes', String(minutes))
          }
          /** 逾期是否计入今日容量：写单个 meta 键，客户端读同一键（不另开字段）。 */
          if (body.dailyCapacityIncludeOverdue === true || body.dailyCapacityIncludeOverdue === false) {
            writeMeta(db, 'daily_capacity_include_overdue', body.dailyCapacityIncludeOverdue ? '1' : '0')
          }
          /**
           * 角色库三个偏好（§6.3）：路径 + 两个 ID 数组。
           *
           * 写入实现**只有一处**（`db/repo/personas.ts`）：GET 与 POST 的响应都走
           * `readWorkbenchSettings`，所以"形状一致"是结构上保证的，不靠人记得同步两处。
           * 数组语义是**整表替换**（与 `quickWorkspaceRecent` 同口径）：设置页必须能
           * 删掉一个收藏 —— 合并语义下删掉的门会被并回来。
           */
          writePersonaSettings(db, {
            personaExternalDir: body.personaExternalDir,
            personaFavorites: body.personaFavorites,
            personaDisabledIds: body.personaDisabledIds,
          })
          if (Array.isArray(body.quickWorkspaceRecent)) {
            /**
             * ⚠️ 语义是**整表替换**（2026-09-16 从"合并"改过来）：
             * 这个列表现在是"快速录入默认工作区"的唯一来源，客户端必须能**删**它
             * （"不再记住这个目录"）——合并语义下 `[...incoming, ...current]` 会把删掉的门又并回来，
             * 用户改回系统默认工作区就成了不可能（fresh-eyes 审查 F1）。
             * 合并/删除的唯一实现在客户端 `shared/quickWorkspaceRecent.ts`，这里只负责归一化后落库。
             */
            writeMeta(db, 'quick_workspace_recent', JSON.stringify(normalizeRecentWorkspaces(body.quickWorkspaceRecent)))
          }
          return writeJson(res, 200, { ok: true, settings: readWorkbenchSettings(db) })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      },
    },
    // ------------------------------------------------------------------ bootstrap
    {
      kind: 'exact',
      path: '/api/workbench/bootstrap',
      handler(req, res) {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const now = new Date()
        const { start, end } = todayRange(now)
        ensureRecurringInstances(db, localDateString(now))
        const tasks = listTasks(db)
        const plan = getDailyPlan(db, localDateString(now))
        /**
         * 统计卡用**与日期面板同一把尺子**（`classifyTaskDay`，日界 = 本地日 00:00）。
         *
         * 旧实现是两把尺子：逾期用 `now`（"今天 09:00 截止、现在 20:00" 算逾期），
         * 今天到期用日界（同一条又算"今天到期"）—— 同一个任务在两张卡上同时计数。
         * 2026-10-02 用户拍板统一（见 ADR0001 口径补充），判定只在共享纯函数里。
         */
        const dayStartMs = Date.parse(start)
        const dayEndMs = Date.parse(end)
        const planTaskIds = new Set((plan?.items ?? []).map((item) => item.taskId))
        const openFacts = tasks
          .filter((task) => isOpenTask({ statusCode: task.statusCode, archived: task.archived }))
          .map((task) => classifyTaskDay({
            effectiveDueAt: task.effectiveDueAt,
            statusCode: task.statusCode,
            planned: planTaskIds.has(task.id),
            dayStartMs,
            dayEndMs,
          }))
        /**
         * 计划视图（T2/D06）：**原样保留**每一项的 `minutes`/`effortDone`/`taskStatusCode`。
         *
         * 旧实现按 `getTask` 过滤掉了"任务已删除"的项 —— 那是静默丢件：用户看到的是
         * "计划里少了一条，又没人说"。现在缺失任务照样返回（`taskStatusCode: 'missing'`），
         * 由界面标注，容量也照它的快照计入已排（requirements §4.2、AX-C04）。
         */
        const planTaskStatus = new Map(listTasks(db, { includeArchived: true }).map((task) => [task.id, task.archived === 1 ? 'archived' : task.statusCode]))
        const planView = plan === undefined ? null : {
          ...plan,
          items: plan.items.map((item) => ({
            taskId: item.taskId,
            order: item.order,
            title: item.title,
            note: item.note,
            minutes: item.minutes,
            effortDone: item.effortDone,
            taskStatusCode: planTaskStatus.get(item.taskId) ?? 'missing',
          })),
        }
        writeJson(res, 200, {
          ok: true,
          dictionaries: listDictionaries(db),
          stats: {
            overdue: openFacts.filter((facts) => facts.overdue).length,
            todayDue: openFacts.filter((facts) => facts.dueToday).length,
            doing: openFacts.filter((facts) => facts.inProgress).length,
            total: tasks.length,
          },
          todayPlan: planView,
          now: now.toISOString(),
          /**
           * 团队记忆是否可用（v1.14.58）。
           *
           * 它是**内部系统**、不会开源，所以界面必须能知道"这台机器上有没有"：
           * 拿不到就整块不渲染「同步到团队记忆库」，否则开源用户会看到一个永远用不了的勾选框。
           * 判据在 `teamMemoryAvailable()`（看 `~/.dsh/memory` 是否存在，或环境变量显式声明）。
           */
          memoryAvailable: teamMemoryAvailable(),
        })
      },
    },
    ...makeTaskRoutes(db),
    // ------------------------------------------------------------------ maintenance
    {
      kind: 'exact',
      path: '/api/workbench/maintenance/repair-parents',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          const changed = repairParentCompletion(db)
          return writeJson(res, 200, { ok: true, changed })
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    ...makeDraftRoutes(db, { teamMemory: deps.teamMemory }),
    ...makeIdeaRoutes(db),
    ...makeIdeaClusterRoutes(db),
    ...makeKnowledgeRoutes(db),
    ...makeAiSessionRoutes(db),
    ...makeReportRoutes(db),
    ...makePlanRoutes(db),
    // ------------------------------------------------------------------ health
    {
      kind: 'exact',
      path: '/api/workbench/health',
      handler(_req, res) {
        if (!isLoopbackRequest(_req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
        writeJson(res, 200, {
          ok: true,
          name: '@dely0/dsh-personal-workbench',
          version: PACKAGE_VERSION,
          buildId: PACKAGE_BUILD_ID,
          db: {
            schemaVersion: versionRow?.value ?? 'unknown',
            taskCount: listTasks(db, { includeArchived: true }).length,
            dictionaryCount: listDictionaries(db).length,
          },
        })
      },
    },
  ]
}
