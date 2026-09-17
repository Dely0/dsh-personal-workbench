/**
 * 知识草稿**写入语义**的唯一权威源：新建 / 覆盖本会话已有草稿 / 显式更新。
 *
 * ## 为什么要有这个模块（真实缺陷，2026-09-17）
 *
 * `workbench_submit_knowledge` 是**按会话去重**的：不带 `draft_id` 的重复调用会
 * 找到本会话里那份 pending 知识草稿并**覆盖**它。这个去重是刻意的设计约束
 * （团队记忆 `01M2A09R4TWTG1D1S7FP0D1M3Y`：同一会话只允许存在 1 份待确认知识草稿），
 * 但它此前是**静默**的：
 *
 * - 两次调用都返回 `知识草稿已保存（id=…）`，读起来像"新建了一条"；
 * - 返回值里的 id 每次相同（后一次替换前一次）；
 * - 会话里看不到草稿 id，用户无从察觉第一次的内容已经没了。
 *
 * 最刺痛的场景：一个会话里分多次沉淀多条独立主题的知识 → 每次都"成功" →
 * 到界面**确认一次** → 入库存下的是**最后一次**，前面几次全部白干，而且**无法发现**。
 *
 * ## 修的是「静默」，不是去重
 *
 * 去重本身**不动**（那是有意保留的设计，批量提交有官方绕行方案）。
 * 本模块只做两件事：
 *
 * 1. `planKnowledgeDraftWrite` + `knowledgeDraftWriteMessage`：把"这次到底是新建还是覆盖"
 *    判出来，并给出**说人话、带 id、带被替换标题**的回执（工具返回值）；
 * 2. `readKnowledgeDraftHistory` + `knowledgeDraftOverwriteNotice`：把"这份草稿被覆盖过"
 *    变成**落库数据**（`payload.revision` / `payload.replacedTitles`），
 *    于是界面在**用户点确认之前**就能写明"这是替换，不是新增，确认入库的是当前这份"。
 *
 * 判定只在这里算一次：工具回执与界面提示读的是同一份口径，
 * 不允许在 `tools.ts` 或组件里再写第二遍（本项目最大的 bug 类别）。
 *
 * 客户端可用（不 import 任何 `node:` 模块，不碰 DOM/React）。
 */

/** 落进草稿 `payload` 的键名（改动它们等于让已存的草稿失去历史，务必慎改）。 */
export const KNOWLEDGE_DRAFT_REVISION_KEY = 'revision'
export const KNOWLEDGE_DRAFT_REPLACED_TITLES_KEY = 'replacedTitles'

/** 历史里最多记几条被替换的标题（够界面说清"前面几次都没了"，不无限长大）。 */
export const KNOWLEDGE_DRAFT_REPLACED_TITLES_LIMIT = 5

/**
 * 「一个会话只产生 1 条知识草稿」的约束说明 + 官方绕行方案。
 *
 * 工具说明、工具回执、界面提示**共用这一段**：这句话此前只在工具说明里说了半截
 * （"同一会话重复提交会更新同一草稿"），既没说清**因此一个会话只能产出 1 条**，
 * 也没说要产出多条该走哪条路。
 */
export const KNOWLEDGE_DRAFT_SESSION_CONSTRAINT =
  '本工具按会话去重：同一会话只保留 1 条待确认知识草稿，不带 draft_id 的重复提交是「覆盖」同一份草稿' +
  '（前一次的内容被替换，不会单独入库），因此一个会话最多产出 1 条知识。' +
  '要在同一个会话里沉淀多条独立主题的知识，请改走插件自身的 loopback 路由 ' +
  'POST /api/workbench/drafts（body: {"kindCode":"knowledge","payload":{...}}）：每次调用建一份独立的 pending 草稿，' +
  '仍然必须由用户逐条点「确认入库」。'

/** 这份草稿被写入过几次、以及被**静默覆盖**掉的标题（按时间先后）。 */
export interface KnowledgeDraftHistory {
  /** 累计写入次数：新建那一次算 1。 */
  revision: number
  /** 被本会话重复提交覆盖掉的历史标题（最多 `KNOWLEDGE_DRAFT_REPLACED_TITLES_LIMIT` 条）。 */
  replacedTitles: string[]
}

/** 本次写入属于哪一种（决定回执与界面提示的措辞，不留"看起来像新建"的余地）。 */
export type KnowledgeDraftWriteMode =
  /** 本会话此前没有 pending 知识草稿 → 新建。 */
  | 'created'
  /** 没传 draft_id，但本会话已有一份 pending 知识草稿 → **静默覆盖**（本次要修的那一半）。 */
  | 'replaced-session-draft'
  /**
   * 没传 draft_id，但本会话已有草稿且**内容与本次逐字相同** → 重复提交、没有丢东西。
   *
   * 为什么要单独分一类：模型重试一次工具调用、或"存完再确认一遍"是很常见的动作，
   * 这时若报"前一次的内容已被本次替换"，会给出一个**假的丢件告警** ——
   * 模型可能因此以为数据被破坏了。内容没变就说内容没变。
   */
  | 'unchanged-session-draft'
  /** 传了 draft_id：调用方显式指定了要改哪一份 → 意图明确，不算静默。 */
  | 'updated-draft'

/** 本次要写入的**内容**（不含 revision / replacedTitles 这类历史字段）。 */
export interface KnowledgeDraftContent {
  title: string
  contentMd: string
  kindCode: string
  tags: string[]
  sourceTaskId: string | null
  sourceReviewId: string | null
  fileLink: string | null
}

export interface KnowledgeDraftWritePlan {
  mode: KnowledgeDraftWriteMode
  /** 被写入的那份草稿的 id；新建时为 `null`（id 在 createDraft 之后才知道）。 */
  existingDraftId: string | null
  /** 写入后的累计次数。 */
  revision: number
  /** 写入后的被替换标题列表。 */
  replacedTitles: string[]
  /** 本次刚被替换掉的那条标题（只有 `replaced-session-draft` 有值）。 */
  replacedTitle: string | null
}

/** 从任意 payload 里安全读出历史（旧草稿没有这两个键 → 视为第 1 次、无替换记录）。 */
export function readKnowledgeDraftHistory(payload: unknown): KnowledgeDraftHistory {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const rawRevision = record[KNOWLEDGE_DRAFT_REVISION_KEY]
  const revision = typeof rawRevision === 'number' && Number.isFinite(rawRevision) && rawRevision >= 1
    ? Math.floor(rawRevision)
    : 1
  const rawTitles = record[KNOWLEDGE_DRAFT_REPLACED_TITLES_KEY]
  const replacedTitles = (Array.isArray(rawTitles) ? rawTitles : [])
    .filter((title): title is string => typeof title === 'string')
    .map((title) => title.trim())
    .filter((title) => title !== '')
    .slice(-KNOWLEDGE_DRAFT_REPLACED_TITLES_LIMIT)
  return { revision, replacedTitles }
}

function normalizedTagKey(tags: unknown): string {
  return (Array.isArray(tags) ? tags : [])
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
    .sort()
    .join('\u0000')
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 本会话已有草稿的内容与本次要写的**是不是同一份**。
 *
 * 只比内容字段（标题/正文/类型/标签/关联/文件链接），**不比历史字段** ——
 * 否则第一次覆盖写进去的 `revision` 会让第二次比较永远判定为"变了"。
 * 标签按集合比（顺序不算差异）。
 */
export function sameKnowledgeDraftContent(payload: unknown, next: KnowledgeDraftContent): boolean {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  return String(record.title ?? '').trim() === next.title.trim()
    && String(record.contentMd ?? '') === next.contentMd
    && String(record.kindCode ?? 'note') === next.kindCode
    && normalizedTagKey(record.tags) === normalizedTagKey(next.tags)
    && nullableText(record.sourceTaskId) === (next.sourceTaskId ?? null)
    && nullableText(record.sourceReviewId) === (next.sourceReviewId ?? null)
    && nullableText(record.fileLink) === (next.fileLink ?? null)
}

/**
 * 判定这次写入是哪一种，并算出写进 payload 的历史。
 *
 * @param input.draftIdProvided 调用方传的 `draft_id`（未传为 `undefined`）
 * @param input.existing 命中的那份草稿（`{ id, payload }`）；未命中为 `undefined`
 * @param input.nextContent 本次要写入的内容（用于识别"重复提交、内容没变"）
 * @param input.replacedTitle 被覆盖掉的那条标题（`replaced-session-draft` 时用）
 */
export function planKnowledgeDraftWrite(input: {
  draftIdProvided: string | undefined
  existing: { id: string; payload: unknown } | undefined
  nextContent: KnowledgeDraftContent
  replacedTitle?: string | null
}): KnowledgeDraftWritePlan {
  const history = readKnowledgeDraftHistory(input.existing?.payload)
  if (input.existing === undefined) {
    return { mode: 'created', existingDraftId: null, revision: 1, replacedTitles: [], replacedTitle: null }
  }
  if (input.draftIdProvided === undefined && sameKnowledgeDraftContent(input.existing.payload, input.nextContent)) {
    // 重复提交相同内容：没有覆盖掉任何东西，历史原样不动（也不要虚报一次"覆盖"）。
    return {
      mode: 'unchanged-session-draft',
      existingDraftId: input.existing.id,
      revision: history.revision,
      replacedTitles: history.replacedTitles,
      replacedTitle: null,
    }
  }
  const revision = history.revision + 1
  if (input.draftIdProvided !== undefined) {
    // 显式修订：不是静默覆盖，历史原样保留（revision 照加，界面仍能看出改过几次）。
    return {
      mode: 'updated-draft',
      existingDraftId: input.existing.id,
      revision,
      replacedTitles: history.replacedTitles,
      replacedTitle: null,
    }
  }
  const replacedTitle = typeof input.replacedTitle === 'string' && input.replacedTitle.trim() !== ''
    ? input.replacedTitle.trim()
    : null
  return {
    mode: 'replaced-session-draft',
    existingDraftId: input.existing.id,
    revision,
    replacedTitles: [...history.replacedTitles, ...(replacedTitle === null ? [] : [replacedTitle])]
      .slice(-KNOWLEDGE_DRAFT_REPLACED_TITLES_LIMIT),
    replacedTitle,
  }
}

/** 把本次写入的历史并进 payload（唯一实现：工具不许自己手拼这两个字段）。 */
export function withKnowledgeDraftHistory<T extends Record<string, unknown>>(
  payload: T,
  plan: KnowledgeDraftWritePlan,
): T & Record<string, unknown> {
  return {
    ...payload,
    [KNOWLEDGE_DRAFT_REVISION_KEY]: plan.revision,
    [KNOWLEDGE_DRAFT_REPLACED_TITLES_KEY]: plan.replacedTitles,
  }
}

/**
 * 工具返回值（`workbench_submit_knowledge` 的回执）。
 *
 * 三种模式**措辞必须不同**：此前三种都是"知识草稿已保存（id=…）"，
 * 于是"覆盖了前一条"和"新建了一条"在会话里读起来一模一样 —— 这正是缺陷本身。
 */
export function knowledgeDraftWriteMessage(plan: KnowledgeDraftWritePlan, draftId: string): string {
  if (plan.mode === 'created') {
    return `知识草稿已新建（id=${draftId}），等待用户在工作台确认后入库。请勿声称已存入知识库。\n` +
      `注意：${KNOWLEDGE_DRAFT_SESSION_CONSTRAINT}`
  }
  if (plan.mode === 'replaced-session-draft') {
    const previous = plan.replacedTitle === null ? '' : `，前一次的内容（标题「${plan.replacedTitle}」）已被本次替换`
    return `⚠️ 已更新本会话已有草稿（id=${draftId}）——不是新建：没传 draft_id，所以命中了本会话那份 pending 知识草稿并覆盖了它${previous}，` +
      `被替换的内容用户已经看不到了（本会话第 ${plan.revision} 次提交）。\n` +
      `${KNOWLEDGE_DRAFT_SESSION_CONSTRAINT}\n` +
      '等待用户在工作台确认后入库（入库的将是当前这份）。请勿声称已存入知识库。'
  }
  if (plan.mode === 'unchanged-session-draft') {
    return `本会话已有草稿的内容与本次完全一致（重复提交，没有覆盖任何内容）：id=${draftId}，草稿仍是这一份。\n` +
      `${KNOWLEDGE_DRAFT_SESSION_CONSTRAINT}\n` +
      '等待用户在工作台确认后入库。请勿声称已存入知识库。'
  }
  return `知识草稿已更新（id=${draftId}，第 ${plan.revision} 次写入，调用方显式指定了 draft_id），等待用户在工作台确认后入库。请勿声称已存入知识库。`
}

/**
 * 界面提示：**用户点「确认入库」之前**就能看到"这是替换，不是新增"。
 *
 * 返回 `null` 表示这份草稿没有被覆盖过（第 1 次提交，没什么要额外说的）。
 * 非 `null` 时由草稿弹窗在正文上方显著位置渲染（见 `components/KnowledgeDraftBody.tsx`）。
 */
export function knowledgeDraftOverwriteNotice(payload: unknown, draftId: string): string | null {
  const history = readKnowledgeDraftHistory(payload)
  if (history.replacedTitles.length === 0 && history.revision <= 1) return null
  const quoted = history.replacedTitles.map((title) => `「${title}」`).join('、')
  const head = history.replacedTitles.length === 0
    ? `✏️ 这份知识草稿已被更新 ${history.revision - 1} 次（内容为当前版本）。`
    : `⚠️ 本会话已提交 ${history.revision} 次，前 ${history.revision - 1} 次的内容已被覆盖` +
      (quoted === '' ? '。' : `（被替换的标题：${quoted}）。`)
  return `${head}本会话只保留 1 条知识草稿，点「确认入库」入库的是当前这份（草稿 id ${draftId}）。` +
    '要在一个会话里产出多条知识，请走 POST /api/workbench/drafts。'
}
