/**
 * 任务资料夹规矩（v1.15.1，吸收 fork `Guojing6/dsh-workbench` 的 3.1 节）。
 *
 * ## 解决什么（三条都是本仓实测存在的毛病）
 *
 * 旧口径是"按**任务标题**在默认工作区下建一层文件夹"（`format.ts` 的 `folderForText`）：
 *
 * 1. **改标题 → 文件夹成孤儿**：路径里写死了当时的标题，之后改标题不会跟着变；
 * 2. **同名任务挤同一文件夹**：两个"周会"任务共用一个目录；
 * 3. **标题里的中文/特殊字符直接变成目录名**，Windows 上还会因为 `：` 之类的字符踩坑。
 *
 * 新口径：文件夹名 = **`<任务ID>` 或改良版 `<任务ID>-<标题片段>`**，
 * 判定只看 **ID 前缀**（`classifyTaskWorkspacePath` 是唯一权威判定）。
 *
 * ## ⚠️ 必须带老路径兼容判据（照抄 fork 会踩的坑）
 *
 * fork 的 `isAutoTaskWorkspacePath(path, taskId)` 只认"末段 == 该任务 ID"。
 * 本机真实库里有 3 条**标题型**自动路径（`D:\DSHWorkspace\工作台任务提醒接入微信（可选增量能力）` 等），
 * 在新口径下不以 ID 结尾 → 会被判成"用户手填" → **永远不会随默认根目录迁移**。
 * 所以这里多认一类：末段 == `folderForText(当前标题)`（旧口径的逐字产物）。
 * 老路径的**唯一定义来源**就是 `format.ts` 的 `folderForText` —— 在这里重写一遍清洗规则
 * 就是"同一个语义两处实现"，改一处就会漏判。
 *
 * ## 硬约束
 *
 * 与 `panelState.ts` / `workspacePath.ts` 一样：**不 import React、不碰 DOM**，
 * 因此可被 `node --test` 直接测（`test/taskFolder.test.mjs`）。
 */
import { folderForText } from './format.js'
import { pathIsUnderRoot } from './workspacePath.js'

/** 目录名里允许保留的字符（其余一律丢弃）。 */
const ILLEGAL_FOLDER_CHARS = /[^A-Za-z0-9_-]+/g

/** 目录名结尾的空白/点：Windows 会静默吃掉，导致"写进去的路径"和"读出来的"不一致。 */
const TRAILING_DOTS_SPACES = /[. ]+$/

/** 标题片段的最大长度（与旧口径 `folderForText` 的 24 字对齐，便于互通与阅读）。 */
export const TASK_FOLDER_TITLE_LIMIT = 24

/** ID 与标题片段之间的分隔符。 */
export const TASK_FOLDER_SEPARATOR = '-'

/** ID 清洗后为空时的兜底名（避免建出 `.` / 空目录名）。 */
export const TASK_FOLDER_FALLBACK = 'task'

/**
 * `<ID>-` 前缀匹配要求 ID 至少这么长。
 *
 * ## 为什么必须加这条门槛（2026-09-16 fresh-eyes 审查 F2）
 *
 * 判据原本是"末段以 `<清洗后的 ID>-`（或 `_`）开头"，于是**任何**短 id 都会误伤真实目录：
 * `sanitizeTaskId` 会把非 `[A-Za-z0-9_-]` 的 id 清洗成 `task`，
 * 而"手填项目名 `task-old`"与"id=task 的自动资料夹"在字符串上无法区分
 * （实测样本里 10/15 个手填目录被误判成自动）。
 * 我们生成的 id 是 UUID（36 字符），所以对**前缀**形态要求 ≥ 8 字符；
 * 短 id 只能靠**完全相等**命中，不再吃前缀。
 */
export const MIN_TASK_ID_PREFIX_LENGTH = 8

/**
 * 把任务 ID 清洗成可安全做目录名的片段：只留 `A-Za-z0-9_-`，空则 `task`。
 * （纯函数，可直接抄 fork 的语义，但多了"结尾点/空白"这一层 Windows 防护。）
 */
export function sanitizeTaskId(taskId: string): string {
  const cleaned = String(taskId ?? '').replace(ILLEGAL_FOLDER_CHARS, '').replace(TRAILING_DOTS_SPACES, '')
  return cleaned === '' ? TASK_FOLDER_FALLBACK : cleaned
}

/**
 * 任务资料夹名：`<任务ID>-<标题片段>`。
 *
 * 改良点（相对 fork 的纯 UUID）：纯 UUID 人不好认，加上标题片段后"稳定 + 可读"兼顾；
 * **判定只看 ID 前缀**，所以标题片段之后改了也不影响"这是自动路径"这个结论。
 *
 * @param taskId - 任务 ID（缺失/非法字符会被清洗）。
 * @param title - 任务标题；为空则退化成纯 ID。
 * @returns 版本：`<ID>` 或 `<ID>-<标题片段>`。
 */
export function taskWorkspaceFolderName(taskId: string, title?: string | null): string {
  const id = sanitizeTaskId(taskId)
  const slug = title === undefined || title === null ? '' : folderForText(title).slice(0, TASK_FOLDER_TITLE_LIMIT).replace(TRAILING_DOTS_SPACES, '')
  // `folderForText('')` 会返回 '未命名任务'，那不是"没有标题"的意思 —— 空标题就该只用 ID。
  if (slug === '' || slug === '未命名任务') return id
  return `${id}${TASK_FOLDER_SEPARATOR}${slug}`
}

/**
 * 旧口径（v1.15.0 及以前）按标题生成的文件夹名 —— **兼容判定的候选集**。
 *
 * 返回值里包含 `folderForText` 的逐字产物，也就是当年真的被写成目录名的那一串。
 * 之所以是数组：将来若要再加"标题已改"的兜底形态，只需要在这里加一项，
 * 判定点不用动（判定与"旧名怎么算"是两件事，后者只有这一处实现）。
 */
export function legacyTitleFolderNames(title?: string | null): string[] {
  if (title === undefined || title === null || title.trim() === '') return []
  return [folderForText(title)]
}

/** 取路径最后一段（同时兼容 `/` 与 `\`，并忽略结尾分隔符）。 */
export function lastPathSegment(path: string): string {
  const trimmed = String(path ?? '').trim().replace(/[\\/]+$/, '')
  if (trimmed === '') return ''
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** 三个判定类别：ID 型（新口径自动）/ 标题型（老口径自动）/ 手填型。 */
export type TaskWorkspacePathKind = 'id' | 'legacy-title' | 'manual'

/** 判定的旁证输入。 */
export interface TaskWorkspacePathContext {
  /**
   * 设置里的**默认任务根目录**（`ai_default_workspace`）。
   *
   * ⚠️ 它是"标题型"判据的**必要旁证**（fresh-eyes 审查 F2）：
   * `folderForText` 对中文/短标题逐字保留，所以"用户手填了一个叫 `<任务标题>` 的项目目录"
   * 与"旧的自动资料夹"在**字符串上根本无法区分**。唯一可用的旁证是位置 ——
   * 旧口径的资料夹**只可能在默认根目录下面**（`joinPath(defaultWorkspace, folderForText(title))`）。
   * 不提供根目录时一律不判 `legacy-title`（fail-safe：**不迁移**永远优于**误迁移**）。
   */
  readonly tasksRoot?: string | null
}

/**
 * **唯一权威判定**：这条 `workspace_path` 到底是"系统自动生成的"还是"用户手填的"。
 *
 * 只有前两类允许在默认根目录变更时被迁移/改写；`manual` **永不触碰**
 * （本机有 26+ 条用户手填的真实项目目录，例如 `D:\Code\Linksight\dsh-workbench`）。
 *
 * ## 两类自动路径的判据（都被 fresh-eyes 审查收紧过，别放宽）
 *
 * | 类别 | 判据 | 为什么这么定 |
 * |---|---|---|
 * | `id` | 末段 `=== id`，或（`id` ≥ 8 字符且）末段以 `<id>-` 开头 | 前缀吃短 id 会误伤 `task-old` 这类真实目录 |
 * | `legacy-title` | 末段 == `folderForText(title)`，**且**该路径在 `tasksRoot` 之下 | 单看字符串无法与手填目录区分，必须加位置旁证 |
 *
 * @param path - 任务的 `workspace_path`。
 * @param taskId - 该任务的 ID。
 * @param title - 该任务的当前标题（用于老路径兼容判定）。
 * @param context - 判定所需的旁证（默认根目录）。
 * @returns `'id'` | `'legacy-title'` | `'manual'`。
 */
export function classifyTaskWorkspacePath(
  path: string,
  taskId: string,
  title?: string | null,
  context: TaskWorkspacePathContext = {},
): TaskWorkspacePathKind {
  const segment = lastPathSegment(path)
  if (segment === '') return 'manual'
  const id = sanitizeTaskId(taskId)
  // ID 型：末段就是该任务 ID；改良版带标题片段时要求 ID 足够长（见 MIN_TASK_ID_PREFIX_LENGTH）。
  if (segment === id) return 'id'
  if (id.length >= MIN_TASK_ID_PREFIX_LENGTH && segment.startsWith(`${id}${TASK_FOLDER_SEPARATOR}`)) return 'id'
  // 标题型：**必须**同时满足"末段逐字等于旧口径产物"与"位于默认根目录之下"。
  const tasksRoot = String(context.tasksRoot ?? '').trim()
  if (tasksRoot === '' || !pathIsUnderRoot(path, tasksRoot)) return 'manual'
  const legacy = legacyTitleFolderNames(title)
  if (legacy.some((name) => name !== '' && segment.toLowerCase() === name.toLowerCase())) return 'legacy-title'
  return 'manual'
}

/**
 * **派生**：这条路径是否为自动生成（可迁移）。
 *
 * ⚠️ 不要在任何地方另算一遍 —— 投影与判定必须走同一个 `classifyTaskWorkspacePath`
 * （本项目最大的 bug 类别就是"同一个语义被独立计算多次"）。
 */
export function isAutoTaskWorkspacePath(
  path: string,
  taskId: string,
  title?: string | null,
  context: TaskWorkspacePathContext = {},
): boolean {
  return classifyTaskWorkspacePath(path, taskId, title, context) !== 'manual'
}
