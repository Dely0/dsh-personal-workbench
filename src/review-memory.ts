/**
 * 复盘 → 团队记忆库（v1.14.0）。
 *
 * ## 背景
 *
 * 工作台已有完整的复盘闭环（`workbench_submit_review` → `task_reviews` → 界面回看），
 * 但复盘结论只留在**本机**库里：同事检索不到、后续会话也看不见，沉淀的价值被锁在单机。
 *
 * ## 通道选择（执行前必须先定的设计问题，逐条给结论）
 *
 * 1. **写入时机** → 复盘草稿**确认时**（与其它草稿的确认语义一致）。
 *    没确认就写会把"用户还在犹豫的内容"污染进团队库。
 * 2. **写入形态** → **按 lesson 拆分**，每条教训一条记忆（可检索性优先）；
 *    `lessons` 为空时退化为「一条复盘正文」。
 * 3. **可见性** → **默认 `private`**，用户可在确认弹窗改成 `team`。
 *    复盘里可能混有客户信息，宁可漏共享不可误共享。
 * 4. **幂等** → 以 `(复盘 id, 第几条 lesson)` 为去重键，记在 meta（`review_memory_written`）。
 *    重复确认同一条复盘 → 全部命中已写记录 → `written: 0`，不产生重复条目。
 * 5. **回链** → 每条的正文里带「来源任务」与「复盘 id」，可从记忆库回溯到任务。
 * 6. **通道** → 复用 `dsh-team-memory` 插件自己用的那套落盘 + 入队机制
 *    （`~/.dsh/memory/notes/*.md` + `~/.dsh/memory/queue/*.json`），
 *    **不自己发 HTTP**：上传、退避重试、离线补传、`local_only` 语义都交给它，
 *    我们只做"把它该写的东西写好"。
 *
 *    为什么不是调用它的服务：`dsh-team-memory` 目前**只暴露 AI 工具**
 *    （`ls_team_memory_record` 等），没有 `ctx.provide` 任何服务，所以没有服务可调。
 *    这里仍然先软探测一遍 `teamMemory` 服务 —— 将来它若有服务，优先走服务。
 *
 * ## 降级（硬性要求）
 *
 * 记忆库不可达 / 插件未安装 / 目录不可写，**都不能让复盘确认失败**：
 * 全部路径都 try/catch，失败只回一条 `degradedReason`，由界面显示
 * "本地已留档，待补传"。绝不因为可选依赖拖死宿主（插件既有原则）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { readMeta, writeMeta } from './db/repo/meta.js'

/** 一条待写入的记忆（落盘 + 入队用）。 */
export interface MemoryNote {
  title: string
  contentMd: string
  tags: string[]
  kind: string
  scope: 'private' | 'team'
  workspace: string
  /** 幂等键：同一条复盘的第几条 lesson（0 表示"整篇复盘"）。 */
  slot: number
}

/** 写入结果（回传给界面；字段与 shared/contracts.ts 的 ReviewMemoryResultView 对齐）。 */
export interface ReviewMemoryResult {
  /** 用户是否选择了写入（未选则不写，且不是错误）。 */
  enabled: boolean
  /** 生效的可见性。 */
  scope: 'private' | 'team'
  /** 真正新写入的条数（幂等：重复确认时为 0）。 */
  written: number
  /** 因幂等被跳过的条数。 */
  skipped: number
  /** 降级原因；非空表示"只落了本地/入队待补传"。 */
  degradedReason?: string
  /** 落地的本地 Markdown 文件名。 */
  files?: string[]
}

/** meta 键：已写入团队记忆的复盘条目（`{ [reviewId]: number[] }`，元素是 slot）。 */
const WRITTEN_META_KEY = 'review_memory_written'

/** 记忆库根目录（与 dsh-team-memory 的 NoteStore 一致）。 */
export function memoryHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_MEMORY_HOME ?? env.TEAM_MEMORY_HOME
  return explicit !== undefined && explicit.trim() !== '' ? explicit : join(homedir(), '.dsh', 'memory')
}

/**
 * **团队记忆能力是否可用**（v1.14.58）—— 决定界面上要不要出现「同步到团队记忆库」。
 *
 * ## 为什么需要它（用户 2026-09-13 说明）
 *
 * 团队记忆是**公司内部系统**，不会开源；GitHub 上的开源用户拿不到
 * `dsh-team-memory` 插件与内网记忆服务。而复盘草稿的确认弹框**无条件**渲染了
 * 「🧠 同步到团队记忆库」勾选框与"结构化教训（每条会单独写入团队记忆）"这类引导语 ——
 * 对开源用户来说那是一个**永远用不了的功能**，纯噪音。
 *
 * 所以这里给界面一个可靠的"有没有"信号，拿不到就**整块不渲染**（不是置灰：
 * 置灰仍会把内部系统的名词摆到开源用户面前）。
 *
 * ## 判据为什么选"记忆库根目录"
 *
 * 1. **不能在客户端猜**：客户端既没有 fs，也不该知道 `~/.dsh/memory` 这种内部约定；
 * 2. **不能靠 `ctx.get('teamMemory')`**：那个服务目前**并不存在**
 *    （`dsh-team-memory` 只暴露 AI 工具 `ls_team_memory_*`，没有 `ctx.provide`），
 *    拿它当判据会在**内部机器上误判为"不可用"**、把真功能藏掉；
 * 3. `~/.dsh/memory` 目录就是这个插件自己的落盘根（`notes/` + `queue/`），
 *    内部机器上必然在（已实测）；开源机器上不会有人手工建它。
 *    另外允许用 `DSH_MEMORY_HOME` / `TEAM_MEMORY_HOME` **显式声明** ——
 *    显式配置本身就是"我知道这个功能"的证据，此时即便目录尚未创建也算可用。
 */
export function teamMemoryAvailable(env: NodeJS.ProcessEnv = process.env, options: { home?: string } = {}): boolean {
  const explicit = env.DSH_MEMORY_HOME ?? env.TEAM_MEMORY_HOME
  if (explicit !== undefined && explicit.trim() !== '') return true
  /**
   * `options.home`：**只给测试用**的注入点。
   *
   * 为什么必须留它：`homedir()` 读的是 **OS 的真实用户主目录**，不认传进来的 `env`
   * （实测过：`teamMemoryAvailable({ USERPROFILE: 'Z:\\nope' })` 依然返回 true）——
   * 也就是说"不可用"这一路**根本无法用 env 证伪**。没有这个注入点，
   * 这条判定就没人能测，而它决定的是"内部功能要不要出现在开源用户面前"，必须可测。
   */
  try {
    return existsSync(options.home ?? memoryHome(env))
  } catch {
    /** 探测失败一律当"不可用"：宁可少显示一个内部功能，也不要给开源用户摆个假的。 */
    return false
  }
}

/**
 * `dsh-team-memory` 的团队记忆服务（**目前并不存在**）。
 *
 * 保留这个接口是为了将来：如果那个插件开始 `ctx.provide('teamMemory', ...)`，
 * 走它的服务比我们复刻它的落盘格式更稳。软探测，拿不到就自己写。
 */
export interface TeamMemoryService {
  record?: (note: { title: string; contentMd: string; tags: string[]; kind: string; scope: string; workspace?: string }) => Promise<unknown> | unknown
}

/** 读取已写入记录（解析失败返回空表：脏 meta 不能让复盘确认失败）。 */export function readWrittenMap(db: DatabaseSync): Record<string, number[]> {
  const raw = readMeta(db, WRITTEN_META_KEY)
  if (raw === undefined || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, number[]> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) out[key] = value.filter((item): item is number => typeof item === 'number')
    }
    return out
  } catch { return {} }
}

/** 与 dsh-team-memory 的 `contentHash` 同构：规范化空白后 sha256，避免同内容不同空格重复入库。 */
export function memoryContentHash(kind: string, payload: unknown): string {
  const normalize = (value: unknown): string => String(value ?? '').trim().replace(/\s+/g, ' ')
  return createHash('sha256').update([normalize(kind), normalize(JSON.stringify(payload))].join('\n\u001f'), 'utf8').digest('hex')
}

/** 极简 YAML front matter（与 dsh-team-memory 的 note-store 同格式，让它的检索能直接读到）。 */
function frontMatter(data: Record<string, unknown>): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) lines.push(`${key}: [${value.map((item) => JSON.stringify(String(item))).join(', ')}]`)
    else if (typeof value === 'boolean' || typeof value === 'number') lines.push(`${key}: ${value}`)
    else lines.push(`${key}: ${JSON.stringify(String(value))}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

/** 文件名 slug（与 dsh-team-memory 的 slugify 同构：保留汉字、其余折叠成 `-`）。 */
export function slugify(title: string, maxLen = 40): string {
  const cleaned = String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
  return (cleaned || 'note').slice(0, maxLen).replace(/-$/, '')
}

function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 原子写：先写 `.part` 再 rename，断电不会留下半截文件把队列卡住。 */
function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.part`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 落一条本地 Markdown 记忆（重名自动加后缀，绝不覆盖用户已有笔记）。 */
export function saveMemoryNote(home: string, note: MemoryNote, now = new Date()): { file: string; id: string } {
  const notesDir = join(home, 'notes')
  mkdirSync(notesDir, { recursive: true })
  const id = `review-${localDate(now)}-${memoryContentHash(note.kind, note.title).slice(0, 10)}-${note.slot}`
  const base = `${localDate(now)}-${slugify(note.title)}`
  let file = join(notesDir, `${base}.md`)
  let suffix = 2
  while (true) {
    try { readFileSync(file); file = join(notesDir, `${base}-${suffix}.md`); suffix += 1 } catch { break }
  }
  atomicWrite(file, frontMatter({
    id,
    title: note.title,
    tags: note.tags,
    kind: note.kind,
    scope: note.scope,
    project: '',
    capabilities: [],
    workspace: note.workspace,
    author: '',
    created_at: now.toISOString(),
    local_only: false,
    supersedes: '',
    source: 'dsh-personal-workbench/review',
  }) + `${note.contentMd.trimEnd()}\n`)
  return { file, id }
}

/**
 * 把一条记忆入队（交给 dsh-team-memory 的定时器上传）。
 *
 * 队列格式必须与它的 `Queue.enqueue` 完全一致 —— 否则它的 `flush` 读不出来，
 * 会出现"看着写进去了其实永远传不上去"。任何异常都只记降级原因，不抛。
 */
export function enqueueMemoryNote(home: string, note: MemoryNote, now = new Date()): { queued: boolean; reason?: string } {
  try {
    const queueDir = join(home, 'queue')
    mkdirSync(queueDir, { recursive: true })
    const payload = {
      title: note.title,
      content_md: note.contentMd,
      tags: note.tags,
      kind: note.kind,
      scope: note.scope,
      project: null,
      capabilities: [] as string[],
      workspace: note.workspace === '' ? null : note.workspace,
      supersedes: null,
      created_at: now.toISOString(),
    }
    const hash = memoryContentHash('note', JSON.stringify(payload))
    const existing = readdirSafe(queueDir).filter((name) => name.endsWith('.json')).map((name) => {
      try { return JSON.parse(readFileSync(join(queueDir, name), 'utf8')) as { hash?: string; kind?: string } } catch { return {} }
    })
    if (existing.some((entry) => entry.hash === hash && entry.kind === 'note')) return { queued: true }
    const at = now.getTime()
    const record = {
      id: `${at.toString(36)}-${hash.slice(0, 10)}`,
      kind: 'note',
      hash,
      payload,
      meta: { file: 'workbench-review' },
      createdAt: now.toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      state: 'pending',
    }
    atomicWrite(join(queueDir, `${record.id}.json`), JSON.stringify(record))
    return { queued: true }
  } catch (error) {
    return { queued: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

/** 把一条复盘草稿拆成待写入的记忆列表（纯函数，便于单测）。 */
export function notesFromReview(input: {
  reviewId: string
  taskId: string
  taskTitle: string
  summaryMd: string
  lessons: unknown
  scope: 'private' | 'team'
  workspace?: string
}, now = new Date()): MemoryNote[] {
  const lessons = Array.isArray(input.lessons)
    ? input.lessons.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    : []
  const workspace = input.workspace ?? ''
  const backlink = `\n\n---\n来源：个人工作台任务「${input.taskTitle}」（任务 ${input.taskId}，复盘 ${input.reviewId}），${now.toISOString()}`
  if (lessons.length === 0) {
    return [{
      title: `复盘：${input.taskTitle}`.slice(0, 120),
      contentMd: `${input.summaryMd.trim()}${backlink}`,
      tags: ['复盘', '工作台'],
      kind: 'lesson',
      scope: input.scope,
      workspace,
      slot: 0,
    }]
  }
  return lessons.map((lesson, index) => {
    const title = typeof lesson.title === 'string' && lesson.title.trim() !== '' ? lesson.title.trim() : `复盘教训 ${index + 1}`
    const content = typeof lesson.content === 'string' ? lesson.content.trim() : ''
    return {
      // 标题带任务名，检索命中时能看出是哪件事的教训。
      title: `${title}（${input.taskTitle}）`.slice(0, 160),
      contentMd: `${content === '' ? input.summaryMd.trim() : content}${backlink}`,
      tags: ['复盘', '工作台'],
      kind: 'lesson',
      scope: input.scope,
      workspace,
      slot: index,
    }
  })
}

/**
 * 把一条已确认的复盘写进团队记忆库（幂等 + 降级）。
 *
 * @param db - 工作台库（用于读复盘 + 记录已写条目）。
 * @param reviewId - `task_reviews` 的主键。
 * @param options.enabled - 用户是否勾了「写入团队记忆库」；false 时直接返回。
 * @param options.scope - `private`（默认，保守）或 `team`。
 * @param options.service - 软探测到的团队记忆服务；存在时优先走它。
 * @param options.home - 记忆库根目录覆盖（测试用）。
 */
export async function writeReviewToTeamMemory(
  db: DatabaseSync,
  reviewId: string,
  options: { enabled?: boolean; scope?: 'private' | 'team'; service?: TeamMemoryService; home?: string; now?: Date } = {},
): Promise<ReviewMemoryResult> {
  const enabled = options.enabled !== false
  const scope: 'private' | 'team' = options.scope === 'team' ? 'team' : 'private'
  if (!enabled) return { enabled: false, scope, written: 0, skipped: 0 }

  const row = db.prepare('SELECT * FROM task_reviews WHERE id = ?').get(reviewId) as
    | { id: string; task_id: string; summary_md: string; lessons_json: string }
    | undefined
  if (row === undefined) return { enabled, scope, written: 0, skipped: 0, degradedReason: '复盘不存在，未写入记忆' }

  const taskTitle = (db.prepare('SELECT title FROM tasks WHERE id = ?').get(row.task_id) as { title?: string } | undefined)?.title ?? '(任务已删除)'
  let lessons: unknown = []
  try { lessons = JSON.parse(row.lessons_json) } catch { lessons = [] }
  const now = options.now ?? new Date()
  const notes = notesFromReview({
    reviewId: row.id, taskId: row.task_id, taskTitle, summaryMd: row.summary_md, lessons, scope,
  }, now)

  const written = readWrittenMap(db)
  const already = new Set(written[row.id] ?? [])
  const pending = notes.filter((note) => !already.has(note.slot))
  const skipped = notes.length - pending.length
  if (pending.length === 0) return { enabled, scope, written: 0, skipped }

  const home = options.home ?? memoryHome()
  const files: string[] = []
  const degradeReasons: string[] = []
  let writtenCount = 0

  /**
   * 先确保记忆库目录存在。
   *
   * 这一步本身也可能失败（目录不可写 / 路径被文件占住），但**不能因此中断**：
   * 失败时下面每条的落盘会各自再失败一次并记录原因，最后回一条 degradedReason。
   * 之所以不等落盘时再建：走服务通道时不需要写本地文件，但目录仍然应该存在
   * （后续 `ls_team_memory_search` 的本地索引、缓存都要用它）。
   */
  try {
    mkdirSync(join(home, 'notes'), { recursive: true })
  } catch (error) {
    degradeReasons.push(`记忆库目录不可用：${error instanceof Error ? error.message : String(error)}`)
  }

  for (const note of pending) {
    // ① 优先走服务（如果记忆插件将来提供了）
    if (typeof options.service?.record === 'function') {
      try {
        await options.service.record({ title: note.title, contentMd: note.contentMd, tags: note.tags, kind: note.kind, scope: note.scope, workspace: note.workspace })
        writtenCount += 1
        continue
      } catch (error) {
        degradeReasons.push(`服务写入失败（${error instanceof Error ? error.message : String(error)}），已回退本地落盘`)
      }
    }
    // ② 本地 Markdown（事实源）+ 入队（交给团队记忆插件补传）
    try {
      const saved = saveMemoryNote(home, note, now)
      files.push(saved.file)
      writtenCount += 1
      const queued = enqueueMemoryNote(home, note, now)
      if (!queued.queued) degradeReasons.push(`已落本地但入队失败：${queued.reason ?? 'unknown'}`)
    } catch (error) {
      degradeReasons.push(`本地落盘失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 幂等留痕：只记真正写成功的 slot。
  if (writtenCount > 0) {
    try {
      written[row.id] = [...(written[row.id] ?? []), ...pending.slice(0, writtenCount).map((note) => note.slot)].sort((a, b) => a - b)
      writeMeta(db, WRITTEN_META_KEY, JSON.stringify(written))
    } catch { degradeReasons.push('已写入但幂等记录失败，重复确认可能产生重复条目') }
  }

  return {
    enabled,
    scope,
    written: writtenCount,
    skipped,
    ...(degradeReasons.length > 0 ? { degradedReason: degradeReasons.join('；') } : {}),
    ...(files.length > 0 ? { files } : {}),
  }
}
