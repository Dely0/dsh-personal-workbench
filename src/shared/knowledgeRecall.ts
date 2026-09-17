/**
 * 知识库自动召回 —— **纯判定模块**（唯一权威源）。
 *
 * ## 为什么必须有这个模块
 *
 * 知识库里存了内容，但**会话 AI 不会自动用起来**：它只是给人看的文档。
 * 这一块要做的事与团队记忆插件（`dsh-team-memory`）的"提示注入层"同构：
 * 回合结束前用**用户提问**去检索、算相关度、按阈值与条数上限收敛，
 * 下一回合把命中的条目带进上下文；命中与注入用**同一把尺子**，账才能对上。
 *
 * 本仓的硬约束（见 `.dsh/skills/dsh-plugin-change` 第 2 节）：
 * **不 import React、不碰 DOM、不读 document / node:sqlite**，
 * 所以它能被 `node --test` 直接驱动 —— "命中几条、逐条为什么命中"这类
 * 会被反复追问的判据，全都钉在这里，而不是散在钩子里。
 *
 * ## 与团队记忆的行为约定（刻意保持一致，别一件事两套规则）
 *
 * | 约定 | 团队记忆 | 这里 |
 * |---|---|---|
 * | 检索时机 | 回合收尾预取 → 下回合注入 | **不同**：装配期当轮检索（v1.15.7，见下） |
 * | 阈值 | `score >= minScore`（分越大越相关） | 同（但本实现是**严格大于**，理由见 `minScore`） |
 * | 条数上限 | `maxMemories`（缺省 5） | `maxEntries`（缺省 3） |
 * | 零命中 | **不插占位**（保住提示前缀缓存） | 同 |
 * | 琐碎消息 | 跳过检索但**留痕** | 同 |
 * | 可关闭 | `injectMemories=false` | 同（全局 + 单会话） |
 *
 * **检索时机为什么和团队记忆不同（v1.15.7）**：团队记忆之所以"回合收尾预取 → 下回合注入"，
 * 前提是**它的检索要出网**（云端优先 + 本地兜底、5s 超时、fire-and-forget），
 * 放进提示装配的关键路径不合适。本仓是本地 SQLite + 纯打分（毫秒级），
 * 照搬那个形状的代价实测有三条：①知识晚一轮到（问问题那一轮永远看不到）；
 * ②话题一换就错位（注入的是上一件事的知识）；③一轮多条用户消息时前一条被**静默丢掉**。
 * 所以本仓在**装配期**用"当前正在被回答的那条用户消息"检索，见 `assemblyInjection`。
 *
 * ## 打分口径（必须写清，否则"相关度 0.60"没人能解释）
 *
 * ```
 * idf(t)     = ln(1 + N/df(t)) / ln(1 + N)   ∈ (0, 1]   N=语料条数，df=含该词的条数（标题∪标签∪正文）
 * massHit_f  = Σ idf(t)，t ∈ 该字段命中的词
 * massQuery  = Σ idf(t)，t ∈ 语料里存在的查询词
 * strength_f = min(1, massHit_f / massSat)               ← v1.15.7 起（原 min(1, 命中词数/3)）
 * coverage_f = min(1, massHit_f / massQuery)             ← v1.15.7 起按信息量算（原 命中词数/总词数）
 * score_f    = weight_f * strength_f * (0.5 + 0.5 * coverage_f)
 * score      = max(标题档, 标签档, 正文档)   ← 三个字段**各自算分**，取最高（v1.15.4 修正）
 *   weight: 标题 0.55 / 标签 0.45 / 正文 0.25
 * 命中判定: score > 0.33（原始分口径；提示档 score > 0.20）
 * 展示相关度: relevance = score / 0.55 ∈ (0, 1]        ← 所有给人看的地方用这个
 * 排序: score 降序 → 本任务优先 → 更新时间降序 → id（结果稳定，日志才有可比性）
 * ```
 *
 * **v1.15.7（P1b）换掉的是长度因子的量纲**：从"命中几个词"改成"命中的**信息量总量**"。
 * 中文逐字抽词下 试/测/知/识/库/一 这类字与"盘符""时序"**等权**，长提问里一堆常用字
 * 把真实命中的质量摊薄了（实测：三条真实提问的 top-1 全是正确答案却卡在 0.327/0.309/0.324，
 * 而一句无关闲聊命中泛化标题里的「知识库」拿 0.338 —— 噪声比正确答案还高，降阈值等于放它进来）。
 * 阈值 `0.34` 也随之重新标定到 `0.33`（换尺子必须重新刻度），证据在 `minScore` 的注释里。
 *
 * **权重与覆盖率必须来自同一个字段**（v1.15.4 修）：早期写法是"权重取命中的最高一档、
 * 覆盖率取**三字段并集**"，于是"标题碰巧共享 1 个字 + 长篇正文命中一堆"能拿到 0.5 以上，
 * 同一篇泛化长文对任何提问都进 top-3（真实库实测 4 次提问进 3 次）。
 * 现在三个字段各自算分取最大；覆盖率的**分母**（本次提问的信息量总量）属于问题、
 * 不属于字段，所以三档共用 —— 分子仍各字段自算，那条修复没有被推翻。
 *
 * ## 为什么必须有 `relevance`（展示层归一化）—— 别再把"相关度 0.41"当成低分
 *
 * 原始分是**有界**的：上限正好是标题权重 0.55，所以一条完美命中也只能显示 0.55。
 * 而用户对"相关度"的心理刻度是 0~1（团队记忆插件那边就是 0.8~0.99）。
 * 两边一比，本仓的 0.41 看着像"勉强相关"，实际已经是上限的 75% —— 这是**刻度**问题，
 * 不是相关性质量问题（用户 2026-09-17 就是这么问的）。
 *
 * 团队记忆的口径是 `score = rawScore / (1 + rawScore)`（见其 `test_p2_units.mjs`）：
 * rawScore 无上界（标题+正文各中一次就是 4 分），于是任何命中都被挤到 0.8 以上。
 * 本仓选择**除以权重上限**这条线性归一化：
 * - 它是**单调**的，所以排序、阈值判定与归一化前完全一致（不改变任何行为）；
 * - 它是**可解释**的：`0.82` 就是"标签档满分"，`0.45` 就是"只有正文命中"，
 *   正好覆盖公司内部口径的分档含义；
 * - 它不引入 `1/(1+x)` 那种"分数越靠近 1 越挤"的饱和，1.00 是真满分而不是渐近线。
 *
 * **内部一切判定仍用原始分**（阈值、排序、上限），展示层只做这一处换算 ——
 * 一条判据一个值：`RecallHit.score` 是原始分、`RecallHit.relevance` 是展示分，
 * 两者由 `relevanceOf()` 单向导出，谁都不许自己再除一遍。
 *
 * **两个因子各治一种病**（都是实测踩出来的，改公式前先看完这段）：
 *
 * - **强度因子 `min(1, massHit/massSat)`**（v1.15.7 起是"信息量饱和"）：
 *   治"长正文靠体量堆命中"。第一版写的是 `权重 + 0.06*(命中词数-1)`，
 *   一篇 3000 字的文章只要正文里出现 8 个常见字就冲到 1.00 —— 实测 20 字长的提问
 *   命中 3 条、三条全是 1.00，**阈值与排序同时失效**。中间试过"命中数 ÷ 提问长度"，
 *   又矫枉过正：`'盘符 根目录 文件选择'` 查一条标题只有 6 个字的条目、命中 5 个，
 *   仍然只有 0.31 —— **真实提问全被挡在门外**。v1.15.3~v1.15.6 用"命中 3 个词即饱和"
 *   兜住它，但那把尺子**每个字等权**：真问题里的关键词与「一」「库」这种常用字同价，
 *   三条真实提问的正确答案因此全卡在 0.327/0.309/0.324（实测）。
 *   现在按**信息量总量**饱和：命中几个"有信息量的词"才加分，堆常用字不再白拿分。
 * - **覆盖率 `0.5 + 0.5*coverage`**：治"只共享一两个字也拿满分"。半量起步
 *   （命中即给该字段权重的 50%）保证短提问不被过度惩罚，同时把"提问里一大半
 *   信息量都没被覆盖"的条目压到阈值以下。v1.15.7 起覆盖率也按信息量算
 *   （`massHit/massQuery`），于是长提问里的常用字不再撑大分母。
 *
 * **"新旧"不进分数，只做排序**（这里与团队记忆的取舍不同，值得说清理由）：
 * 分数是给人看的"多相关"，混进时间会让权重档位被时间污染
 * （实测踩到：一条 1 小时前更新的条目因此拿到刚好过线的分数，注入了一条
 * 只靠正文里出现一个字的噪声）。时间的作用是**同分时的次序**，不是相关性本身。
 *
 * **为什么不用 BM25**：知识库是本地 SQLite、条数量级在几十到几百，
 * 上 FTS5/BM25 会引入"分词配置、rank 方向、负数归一"一串只在数据量大了才划算的坑
 * （团队记忆那条"分数方向反了会丢强留弱"的注释就是前车之鉴）。
 * 这里用可解释的加权：权重是常量、命中理由逐条可打印、单测能穷举。
 * 将来条数上万再换 BM25，届时**只换这个模块**（它是唯一实现）。
 */
import type { KnowledgeRow } from '../db/repo/knowledge.js'

/** 一次召回的候选（任务域在前、全局在后，见 `recallScopeRank`）。 */
export interface RecallCandidate {
  entry: KnowledgeRow
  /** 来自本任务/本任务树（true）还是全库（false）。 */
  fromTask: boolean
}

/** 单条命中：给注入文本、给日志、给 UI 用的是**同一份**判定结果。 */
export interface RecallHit {
  id: string
  title: string
  kindCode: string
  /** **内部原始分**（权重 × 长度因子 × 覆盖率，上限 0.55）：只用于阈值与排序。 */
  score: number
  /**
   * **展示相关度**（`score / 0.55`，落在 (0, 1]）：注入文本、工具输出、日志、界面
   * 一律用它，不要再用原始分（理由见文件头"为什么必须有 relevance"）。
   */
  relevance: number
  /** 命中的词（按重要性降序）。 */
  terms: string[]
  /** 为什么算命中（一句话，含"哪个字段命中了哪些词"）。 */
  reason: string
  /** 正文里第一个命中词附近的片段（给模型看的实证）。 */
  snippet: string
  tags: string[]
  fromTask: boolean
  updatedAt: string
  fileLink: string | null
  sourceTaskId: string | null
  /**
   * 这条命中是**哪一句 query** 带出来的（v1.15.3 多 query 合并后才有）。
   *
   * 为什么必须记：开工前那次召回会同时用「任务标题」与「任务描述」两句去查，
   * 日志里若只写一句，用户会以为"描述根本没查"——而实际命中很可能就来自描述。
   * 单 query 时它与 `RecallOutcome.query` 相同。
   */
  query?: string
}

/** 检索输入（全部显式传入，便于单测穷举）。 */
export interface RecallInput {
  /** 用户这一回合的提问（或"开工前"用的任务标题）。 */
  query: string
  candidates: RecallCandidate[]
  /** 阈值：`score > minScore` 才算命中。默认来自 `RECALL_DEFAULTS`。 */
  minScore?: number
  /** 提示档阈值（`score > hintScore` 才值得提一行）。默认来自 `RECALL_DEFAULTS`。 */
  hintScore?: number
  /** 条数上限。 */
  maxEntries?: number
  /** 单会话去重：这些 id 已经在之前的回合注入过，不再重复占额度。 */
  excludeIds?: readonly string[]
  /** 注入过是否就不再召回（默认 true）。关掉后已注入的条目仍可再次命中。 */
  dedupe?: boolean
  /**
   * 语料词统计（`termStatsOf(candidates)`）。不传就按 `candidates` 现算。
   *
   * 管理器会把它与候选集一起缓存（同一个候选集只统计一次）—— 5000 条时
   * 每次召回都重扫一遍正文是没必要的开销。
   */
  stats?: TermStats
  /** 信息量饱和阈值覆盖（标定脚本用；正常路径走 `RECALL_DEFAULTS.massSat`）。 */
  massSat?: number
  /** "现在"，用于最近度；注入以便单测固定。 */
  now?: Date
}

/** 检索结论（含"为什么零命中"的判别信息 —— 零命中与没检索必须能分开）。 */
export interface RecallOutcome {
  query: string
  /** 真正会注入的条目（已按 score 降序）。 */
  hits: RecallHit[]
  /**
   * **差一点点的条目**（`hintScore <= score < minScore`，v1.15.6 的 P1）。
   *
   * 为什么要这一档：实测（2026-09-17，本机 60 条真实库 + 本会话 11 条真实提问）
   * 真实提问的正确答案**普遍卡在阈值下面一点点** —— genui 渲染失败 0.327 /
   * 紧缩场时序控制器 0.309 / Windows计划任务 0.324，而阈值是 0.34，**top-1 排序全是对的**。
   * 只把阈值降下来是不行的：同一批数据里那条泛化标题（「…01 天线测试业务知识库」）
   * 对一句与天线无关的闲聊也能拿 0.338 —— **噪声比正确答案分还高**，降闸门等于放它进来。
   *
   * 所以：**闸门不降，但差一点点的给一行"可能相关"提示**（只给 id + 标题 + 相关度，
   * 不给摘要、不占 3 条注入额度）。模型看到就知道"库里有东西、可以去查"，
   * 而上下文成本只有一行（约 70 字符，vs 完整块约 1000 字符）。
   */
  nearMisses: RecallHit[]
  /** 命中过（含被阈值/条数上限挡下的）总条数 —— 用于区分"库里没有"与"被闸门挡下"。 */
  matched: number
  /** 被阈值挡下**且连提示档也没够到**的条数。 */
  droppedByScore: number
  /** 被条数上限截掉的条数。 */
  droppedByLimit: number
  /** 被会话去重跳过的条数。 */
  droppedAsSeen: number
  /**
   * 被**压制**（已被取代 / 已过期）而根本没参与打分的条数（P2）。
   *
   * 为什么不并进 `droppedByScore`：那两件事的原因完全不同 ——
   * 一个是"分数不够"，一个是"这条已经不作数了"。混在一起，日志就答不了
   * "为什么我刚写的那条新知识没被召回"（答：旧的那条还在库里且没标取代关系 / 或者标反了）。
   */
  droppedAsSuperseded: number
  /** 关键词（用于日志：检索了哪些关键词是可观测要求之一）。 */
  terms: string[]
  /** 跳过检索的原因（非空即"没检索"，与"检索了零命中"区分开）。 */
  skippedReason?: string
}

/**
 * 缺省参数 —— **阈值与上限的唯一来源**。
 *
 * 为什么集中在这里：团队记忆踩过"日志与实际注入各写一套判断 → 日志说命中 3 条、
 * 实际注入 0 条"的坑。本仓同理，"什么算命中"只能有一处实现。
 */
export const RECALL_DEFAULTS = {
  /**
   * 阈值 `0.33` 是**在新量纲下重新量出来的**（v1.15.7 的 P1b）。
   *
   * 三条约束同时压在这个数字上：
   * 1. **正文命中一律不过线**（`正文权重 0.25 < 0.33`，即使全覆盖）——
   *    "正文里出现关键词"不足以把一条知识推给模型，这是噪声控制的核心口径。这条
   *    与量纲无关：只要阈值 > 0.25，结论就成立；
   * 2. **碰巧共享几个字的长提问也捞不到东西**：标题档是
   *    `0.55 × 强度 × (0.5 + 0.5×覆盖率)`，命中信息量低/覆盖率低就掉到阈值以下；
   * 3. **真实的短提问要能命中**：标题/标签档是 0.55 / 0.45。
   *
   * ## 为什么从 0.34 挪到 0.33（不是"降闸门"，是换了尺子重新刻度）
   *
   * `0.34` 是**旧公式**（`min(1, 命中词数/3)` 长度因子）下算出来的；P1b 把长度因子
   * 换成"命中的信息量总量"（`Σ idf`）之后，同一个数字不再表示同一件事 ——
   * 必须重新标定，否则就是拿旧尺子的读数去套新尺子。
   *
   * 标定证据（`scripts/repro/calibrate-idf.mjs`，本机真实库 61 条 + 12 条真实提问）：
   *
   * | 配置 | 真实完整注入 | 有可见内容 | 关键词对照 | A/B/C 诱饵 |
   * |---|---|---|---|---|
   * | 旧公式 + 0.34（基线） | 3/12 | 11/12 | 4/4 | 全过 |
   * | IDF + 0.34 | 3/12 | 12/12 | 4/4 | 全过 |
   * | **IDF + 0.33** | **5/12** | 12/12 | **4/4** | **全过** |
   * | IDF + 0.32 | 7/12 | 12/12 | 4/4 | 全过（但**历史那条噪声哨兵 0.322 会进来**）|
   * | IDF + 0.30 | 11/12 | 12/12 | 4/4 | 全过（同上，且含"库里确实没有"的长 paste）|
   *
   * 多出来的两条是**正确答案**（genui 渲染失败 0.339 →「【修正】dsh-ui 围栏整块降级」；
   * 相关度疑问 0.334 →「复盘：团队记忆系统落地搭建」），
   * 而 P1 用来守住闸门的那条"闲聊"（0.322）**仍然被挡在门外** ——
   * 这正是"闸门不降、但新尺子上要重新刻度"的含义。
   *
   * 口径提醒：这是**原始分**阈值，换算成给人看的归一化相关度是
   * `0.33 / 0.55 = 0.60` —— 也就是说"过线的命中在界面上显示 0.60 以上"，
   * 别把 0.60 看成低分（对照团队记忆的 0.8~0.99，那是另一套分母，
   * 见文件头"为什么必须有 relevance"）。
   */
  minScore: 0.33,
  /**
   * **提示档阈值**（v1.15.6 的 P1）：分数落在 `[hintScore, minScore)` 的条目
   * 不注入完整块，但会在注入位置留**一行**"可能相关"提示（id + 标题 + 相关度）。
   *
   * `0.20` 是 v1.15.6 量出来的（当时阈值 0.34）：11 条真实提问里正确答案的最低分
   * 0.275，而唯一一条"库里真的没有对应条目"的提问只有 0.052，0.20 落在空档里。
   * P1b 换了量纲后这条空档仍在（最低的正确答案升到 0.334，'库里没有'那条仍是 0.05 量级），
   * 所以 **0.20 不动** —— 提示档是"闸门不降"的安全网，它不跟着阈值一起漂。
   *
   * 换算成给模型看的相关度是 `0.20 / 0.55 ≈ 0.36`。
   */
  hintScore: 0.20,
  /**
   * **信息量饱和阈值**（v1.15.7 的 P1b）：`strength = min(1, massHit / massSat)`。
   *
   * 它替代原来的 `min(1, hits/3)`（"命中 3 个词就满分"）。量纲换成了
   * `Σ ln(1+N/df)/ln(1+N)`，所以数值必须重新标定 —— 已用本机真实库 + 本会话 12 条
   * 真实提问跑过 `scripts/repro/calibrate-idf.mjs`（0.6 ~ 4.5 共 9 档）：
   * 只有 `0.6` 同时满足「关键词式对照 4/4」「B 库外字零命中」「C 无跨提问重复」
   * 「A 诱饵 ≤ 真实」，且**完整注入率最高**（3/12 → 有可见内容 11/12 → 12/12）。
   * 再大就只剩 1/12，对照也掉到 1/4 —— 那是"打分被压得太狠"，不是噪声控制。
   */
  massSat: 0.6,
  /** 单回合最多注入 3 条：知识条目带正文片段，比团队记忆的摘要更长，额度要更紧。 */
  maxEntries: 3,
  /** 单回合最多提示几条（提示行很短，但同样要防刷屏）。 */
  maxHints: 2,
  /** 注入正文片段长度（字符）。 */
  snippetLength: 160,
  /**
   * **top-1 的片段长度**（v1.15.7，P3「减少两步消费」）。
   *
   * 实测：98% 的条目正文 > 160 字（平均 1637 字），而注入只给 160 字摘要 + id ——
   * 于是"检索得回来、消费不下去"，模型还得再调一次工具取全文（两步）。
   * top-1 通常就是这一回合最该看的那条，给它 ~400 字（典型条目能覆盖到"背景 + 结论"），
   * 其余条目仍 160 字：额度花在最相关的那一条上，噪声成本不变。
   */
  topSnippetLength: 400,
  /**
   * 注入表头**回显 query** 的字符上限（v1.15.7 的零风险收尾①）。
   *
   * 开工前那一次的 query = 任务标题 + 整段描述（实测 483 字），每回合搬进对话
   * 白花约 500 字符。表头只需让人认出"这是哪次提问"，60 字 + 关键词足够；
   * **库里仍存全文**（`appendRecallLog` 用的是 `outcome.query`，不经过这里的截断）。
   */
  queryEchoLength: 60,
  /** 表头回显关键词的个数上限。 */
  queryEchoTerms: 12,
} as const

/** 表头回显用的 query（超长截断 + 省略号）。**唯一实现**，日志/文本/工具都走它。 */
export function echoQuery(query: string, limit: number = RECALL_DEFAULTS.queryEchoLength): string {
  const flat = String(query ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** 中文常见虚词 —— 命中它们说明不了任何相关性，必须当停用词去掉。 */
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '与', '我', '你', '他', '它', '们', '这', '那', '有', '没',
  '不', '也', '就', '都', '很', '把', '被', '让', '给', '从', '到', '对', '为', '以', '及',
  '要', '会', '能', '还', '再', '又', '只', '但', '如', '果', '因', '所', '而', '并', '或',
  '等', '着', '过', '吗', '呢', '吧', '啊', '上', '下', '中', '里', '个', '之', '于', '来',
  '请', '帮', '一个', '一下', '怎么', '什么', '为什么', '可以', '需要', '问题', '看看',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'for', 'and', 'or', 'in', 'on',
  'at', 'it', 'this', 'that', 'with', 'how', 'what', 'why', 'can', 'should', 'please', 'help',
])

/** 归一化：小写 + 折叠空白。检索与打分必须用同一份归一化，否则"看着像命中其实没命中"。 */
export function normalizeText(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * 抽词：汉字按 **1 字**计（中文关键词最短就是一个字，如"盘""环"）、
 * ASCII 按 ≥2 字符的单词计；过滤停用词与纯数字噪音。
 *
 * 为什么汉字按 1 字而不是 2 字：知识库条目少（本机 59 条），
 * 单字命中的误报由**权重 + 正文命中只给 0.30 + 阈值 0.34** 兜住；
 * 而 2 字切分会让"盘符""迁移"这类词在正文里被截成"盘符/符迁/迁移"，
 * 反而把真正的命中稀释掉。
 */
export function extractTerms(query: string): string[] {
  const text = normalizeText(query)
  if (text === '') return []
  const terms: string[] = []
  /**
   * ⚠️ 去重必须用 `Set` 而不是 `terms.includes()`：P1b 起 `extractTerms` 会被用来
   * **统计全库每个条目的词集**（`termStatsOf` 扫正文），而正文动辄 1600+ 字、几百个不同词 ——
   * `includes` 是 O(n)、整条就是 O(n²)。实测把真库首次召回的 62ms 压到 ~20ms（同样结果）。
   * 顺序语义不变（保留首次出现的次序，`termsIn` 与日志都依赖它）。
   */
  const seen = new Set<string>()
  const push = (raw: string): void => {
    const term = raw.trim()
    if (term === '' || STOP_WORDS.has(term)) return
    if (/^[0-9]+$/.test(term)) return
    if (seen.has(term)) return
    seen.add(term)
    terms.push(term)
  }
  // 汉字：逐字
  for (const ch of text.match(/[\u4e00-\u9fff]/g) ?? []) push(ch)
  // 拉丁/数字单词：≥2 字符
  for (const word of text.match(/[a-z0-9][a-z0-9_.\-/\\:]{1,}/g) ?? []) push(word)
  return terms
}

/** 文本里第 1 个命中词的位置与长度（用于取正文片段）。 */
function firstHit(text: string, terms: readonly string[]): { index: number; length: number } | undefined {
  let best: { index: number; length: number } | undefined
  for (const term of terms) {
    const index = text.indexOf(term)
    if (index < 0) continue
    if (best === undefined || index < best.index) best = { index, length: term.length }
  }
  return best
}

/** 命中某个字段的词（保持 terms 的顺序）。 */
function termsIn(text: string, terms: readonly string[]): string[] {
  return terms.filter((term) => text.includes(term))
}

/**
 * 这条知识现在还作数吗（P2）。
 *
 * 两种"不作数"：
 * 1. **已被取代**（`supersededById` 非空）—— 修正条入库后，旧条必须让位；
 * 2. **已过期**（`validUntil` 早于现在）—— 时效性知识（版本相关的配置、临时方案）。
 *
 * 为什么是**压制**而不是降权：一条被明确标注"已被 X 取代"的知识，
 * 只要它还能进上下文，模型就有机会把作废的结论当成事实用。分数高低不改变这一点。
 * 需要它时仍有一条路：按 id 直读（`findEntryById`）能取到全文，并在回执里标注"已被 X 取代"。
 */
export function isSuperseded(entry: { supersededById?: string | null; validUntil?: string | null }, now: Date): boolean {
  if (entry.supersededById !== null && entry.supersededById !== undefined && entry.supersededById !== '') return true
  const until = entry.validUntil
  if (until === null || until === undefined || until === '') return false
  const at = Date.parse(until)
  // 时间串坏掉时**不压制**（不猜）：宁可多召回一条，也不要因为格式问题把有效知识永久藏起来。
  if (!Number.isFinite(at)) return false
  return at <= now.getTime()
}

/**
 * 引用自动判定的**最小标题前缀长度**（P4）。
 *
 * 判据只能是"模型的回答里出现了这条知识的 id 或标题" —— 不提就不标（不许瞎标）。
 * 完整 uuid 极罕见（模型通常不抄），所以主要靠标题；而模型会改写标题的后半段
 * （常常写成《复盘：团队记忆系统落地搭建…》），所以取**前缀**匹配。
 * 12 个字符是保守值：本机真实库的标题前缀在这个长度上已经足够独特
 * （"复盘：团队记忆系统落" / "工作台子任务重复新建的成"），
 * 再短就会开始误伤（比如两条都以"工作台"开头）。
 */
export const CITE_TITLE_PREFIX = 12

/**
 * 从"这一回合注入给模型的条目"与"模型这一回合的回答"里，判定**明确被引用**的那些。
 *
 * 纯函数、可穷举；判定规则只有一条实现在这里（接线层不许再写一遍）。
 * 保守优先：**宁可漏标，不可瞎标** —— 标错会让"注入过但没人引用"这条证据失真，
 * 而失真的证据比没有证据更糟（会让人据此删掉有用的知识）。
 */
export function citationMatch(answer: string, delivered: Array<{ id: string; title: string }>): string[] {
  const text = normalizeText(answer)
  if (text === '') return []
  const out: string[] = []
  for (const item of delivered) {
    const id = normalizeText(item.id)
    if (id !== '' && text.includes(id)) { out.push(item.id); continue }
    const title = normalizeText(item.title)
    if (title.length >= CITE_TITLE_PREFIX && text.includes(title.slice(0, CITE_TITLE_PREFIX))) out.push(item.id)
  }
  return out
}

/**
 * 报错特征词（P5：只观测"该查未查"）。
 *
 * 判据故意做得**宽**：这里只写一行日志，不强制检索，多报一行的成本接近零；
 * 而漏报的代价是"用户拿着报错来问、自动层什么都没做、账上也没有" —— 那正是本仓最忌讳的。
 */
const ERROR_HINT_WORDS = [
  '报错', '错误', '失败', '异常', '超时', '崩溃', '卡死', '挂了', '起不来', '没生效', '不生效', '不工作',
  'error', 'fail', 'failed', 'exception', 'timeout', 'traceback', 'stack', 'undefined', 'nan',
  'enoent', 'eacces', 'eperm', 'eaddrinuse', 'econnrefused', 'cannot read', 'is not a function',
]

/** 这句话像不像"在报一件事坏了/报错了"（P5 的 suggested_miss 判据）。 */
export function looksLikeErrorReport(text: string): boolean {
  const flat = normalizeText(text)
  if (flat === '') return false
  return ERROR_HINT_WORDS.some((word) => flat.includes(word))
}

/**
 * 词的信息量统计（**IDF 的唯一来源**）：`df` = 包含该词的条目数（标题 ∪ 标签 ∪ 正文），
 * `size` = 语料条目数。
 *
 * ## 为什么 df 要按**整个条目**统计，而不是按字段
 *
 * 只看标题会让「一」这种"标题里稀有、正文里遍地"的字看起来很有信息量
 * （实测：标题 df=1 → idf 灌满 → 假信号，把不相关的条目顶到 top-1）。
 *
 * ## 为什么要它（P1b 的动机，都是实测）
 *
 * v1.15.6 的"两档闸门"证明**排序是对的**：三条真实提问的 top-1 全是正确答案，
 * 只差 0.01~0.03 卡在阈值下；而同一批数据里一句与主题无关的闲聊拿 0.338，
 * **比两个正确答案还高**（它命中了泛化标题里的「知识库」）。所以不能降阈值。
 *
 * 差在哪："命中几个词"不是信息量 —— 长提问里 试/测/知/识/库/一 这类字
 * 确实"存在于某条标题或标签里"，但携带的信息接近 0，却把命中质量摊薄了。
 * 两个"改分母"的变体都被实测否掉（标签字段分母太小 → 巧合命中抢走 top-1；
 * 三字段共用分母 → 仍被常用字撑大、命中率掉回 4/11）。
 * 真解是给词按信息量加权：命中的**信息量总量**替代"命中词数"。
 */
export interface TermStats {
  size: number
  df: Map<string, number>
}

/**
 * 统计语料里每个词出现在多少条条目里。
 *
 * 逐条只对**该条目出现过的不同词**计数（`Set` 去重）：同一条里出现十次也只算 1 条，
 * 否则 df 会变成"频次"而不是"文档频率"，长文里的常见字反而被当成稀有。
 *
 * ## 代价（实测，`scripts/repro/bench-idf-stats.mjs`）
 *
 * 它要扫全库正文，是本版**唯一新增的开销**：真库 61 条（约 11 万字）首次召回 41ms、
 * 之后 15s 内缓存命中约 5ms；压测到 500 / 2000 / 5000 条分别是 213 / 761 / 1921ms。
 * 所以它与**候选集共用同一份缓存**（`corpusStats()`），不让每个回合都重扫。
 * 顺带把 `extractTerms` 的去重从 `Array.includes`（O(n²)）改成 `Set`：
 * 真库首次召回的 62ms 里有一多半花在那上面，改完 41ms。
 */
export function termStatsOf(candidates: readonly RecallCandidate[]): TermStats {
  const df = new Map<string, number>()
  for (const candidate of candidates) {
    const entry = candidate.entry
    const haystack = `${normalizeText(entry.title)} ${entry.tags.map((tag) => normalizeText(tag)).join(' ')} ${normalizeText(entry.contentMd)}`
    for (const term of new Set(extractTerms(haystack))) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }
  return { size: candidates.length, df }
}

/**
 * 词的信息量：`idf = ln(1 + N/df) / ln(1 + N)`，落在 `(0, 1]`。
 *
 * 语料里没有的词给 0（**不猜**）：它既不可能是命中，也不该进覆盖率的分母 ——
 * 分母只由"语料里存在的查询词"组成（v1.15.6 变体 B 的教训：让不存在于任何条目的
 * 常用字进分母，等于用噪声稀释真实命中）。
 *
 * **为什么要除以 `ln(1+N)`**（这一步是我加的，理由写清楚）：裸的 `ln(1+N/df)`
 * 量纲随库大小漂移 —— 3 条的小库上任何词都只有 `ln4 ≈ 1.39`，60 条的真实库上
 * 稀有词能到 `ln61 ≈ 4.11`。而 `massSat`（信息量饱和阈值）是**一个常量**：
 * 不归一化的话，同一份代码在小库上"什么都不注入"、在大库上"什么都注入"，
 * 而知识库恰恰是从 0 条长起来的。归一化之后 `1.0` 恒定表示
 * "命中了只出现在 1 条条目里的词"，与库大小无关。
 */
export function idfOf(stats: TermStats, term: string): number {
  const df = stats.df.get(term) ?? 0
  if (df <= 0 || stats.size <= 0) return 0
  return Math.log(1 + stats.size / df) / Math.log(1 + stats.size)
}

/** 质量权重：标题 > 标签 > 正文。理由要能对用户解释，所以是常量而不是魔法数。 */
const WEIGHT = { title: 0.55, tag: 0.45, body: 0.25 } as const
const YEAR_MS = 365 * 24 * 60 * 60 * 1000

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/**
 * 展示相关度的上限 = 标题权重（原始分的理论上限）。
 *
 * 常量而不是字面量 0.55：权重表一改，归一化自动跟着走 ——
 * 分开写就会出现"权重调了、归一化没调"的静默偏差。
 */
export const RELEVANCE_CEILING = WEIGHT.title

/** 原始分 → 展示相关度（0~1）。**唯一的换算入口**，别在别处再除一遍。 */
export function relevanceOf(score: number): number {
  return clamp01(clamp01(score) / RELEVANCE_CEILING)
}

/** 展示相关度 → 原始分（给"按相关度传阈值"的入口用：工具参数、配置）。 */
export function scoreFromRelevance(relevance: number): number {
  return clamp01(relevance) * RELEVANCE_CEILING
}

/**
 * 人类可读的相关度（两位小数）。展示层统一走它，免得三处各写一次 `toFixed(2)`。
 */
export function formatRelevance(score: number): string {
  return relevanceOf(score).toFixed(2)
}

/**
 * 最近度：一年内线性衰减到 0。时间串坏掉时给 0（**不猜**）。
 *
 * ⚠️ 它**不进分数**，只做同分时的排序（理由见文件头"新旧不进分数"那段）。
 * 保留成导出函数是为了让排序与测试共用同一份实现 ——
 * 排序里再写一遍"怎么算新"就是"同一个语义两处实现"。
 */
export function recencyFactor(updatedAt: string, now: Date): number {
  const at = Date.parse(updatedAt)
  if (!Number.isFinite(at)) return 0
  const age = now.getTime() - at
  if (!Number.isFinite(age) || age <= 0) return 1
  return clamp01(1 - age / YEAR_MS)
}

/**
 * 打分一条候选。返回 `undefined` 表示**没有任何字段命中** ——
 * 调用方据此区分"库里根本没有"与"有但分数低"。
 */
export interface ScoreContext {
  terms: readonly string[]
  now: Date
  /**
   * 语料的词信息量统计（**必填**）。
   *
   * 为什么必填而不是内部兜底算一遍：df 属于**语料**、不属于单条候选。
   * 让它可选就会有人传一个"没有统计"的上下文，于是同一个公式出现第二种行为
   * （本仓第一大 bug 类别）。调用方要么给 `termStatsOf(candidates)` 的结果，
   * 要么用 `recallKnowledge`（它自己会算）。
   */
  stats: TermStats
  /** 长度因子（信息量）饱和阈值；缺省取 `RECALL_DEFAULTS.massSat`（标定脚本会覆盖它）。 */
  massSat?: number
}

/**
 * **单字段**打分（v1.15.4 分字段算分；v1.15.7 换成功率 = 信息量总量）。
 *
 * 修之前（v1.15.4）的写法是"权重取命中的最高一档，覆盖率取**所有字段的并集**"，
 * 于是在真实库上出现了这样一条：某篇泛化长文（正文 3000+ 字）与提问只共享
 * **标题里的 1 个字**，却因为正文命中了 8 个字，覆盖率被抬到 0.9，
 * 最终拿到 `0.55 × 1 × 0.95 ≈ 0.52` —— 在「四时机」的 4 次不同提问里有 3 次都挤进 top-3。
 * 现在：**一个字段自成一个分数**，强度与覆盖率都只在该字段内部计算，最后取三者最大。
 *
 * v1.15.7（P1b）再把"命中几个词"换成"命中的**信息量总量**"：
 *
 * ```
 * massHit_f   = Σ idf(t)，t ∈ 该字段命中的词
 * massQuery   = Σ idf(t)，t ∈ 语料里存在的查询词
 * strength_f  = min(1, massHit_f / massSat)          ← 原长度因子 min(1, hits/3)
 * coverage_f  = min(1, massHit_f / massQuery)        ← 原覆盖率 min(1, hits/总词数)
 * score_f     = weight_f × strength_f × (0.5 + 0.5 × coverage_f)
 * ```
 *
 * 为什么必须换：中文逐字抽词下，"命中几个词"里**每个字的权重都一样**，
 * 于是 试/测/知/识/库/一 这类几乎无信息量的字与"盘符""时序"这类关键词等价。
 * 换成信息量总量后，一次"命中 3 个常用字"的巧合只有很小的 massHit → 分数自然低。
 */
function fieldScore(weight: number, hitTerms: readonly string[], massQuery: number, context: ScoreContext): { score: number; massHit: number } {
  if (hitTerms.length === 0) return { score: 0, massHit: 0 }
  const massHit = hitTerms.reduce((sum, term) => sum + idfOf(context.stats, term), 0)
  const massSat = context.massSat ?? RECALL_DEFAULTS.massSat
  const strength = massSat <= 0 ? 1 : Math.min(1, massHit / massSat)
  const coverage = massQuery === 0 ? 0 : Math.min(1, massHit / massQuery)
  return { score: weight * strength * (0.5 + 0.5 * coverage), massHit }
}

/**
 * 生成正文片段：优先以**第一个命中词**为中心，正文没命中就取开头。
 *
 * 抽成导出函数是为了让"注入时的片段"与"top-1 放宽后的片段"共用同一份实现 ——
 * 两处各写一遍截断逻辑，迟早会出现"放宽了长度但取的位置不一样"这种
 * 读代码看不出来的偏差（本仓第一大 bug 类别）。
 */
export function buildSnippet(entry: KnowledgeRow, terms: readonly string[], length: number): string {
  const raw = String(entry.contentMd ?? '').replace(/\s+/g, ' ').trim()
  if (raw === '') return ''
  const found = firstHit(raw.toLowerCase(), terms)
  const center = found?.index ?? 0
  const start = Math.max(0, center - Math.floor(length / 3))
  let snippet = raw.slice(start, start + length)
  if (start > 0) snippet = `…${snippet}`
  if (start + length < raw.length) snippet = `${snippet}…`
  return snippet
}

export function scoreCandidate(candidate: RecallCandidate, context: ScoreContext): RecallHit | undefined {
  const entry = candidate.entry
  const title = normalizeText(entry.title)
  const body = normalizeText(entry.contentMd)
  const tags = entry.tags.map((tag) => normalizeText(tag))

  const titleTerms = termsIn(title, context.terms)
  const tagTerms = context.terms.filter((term) => tags.some((tag) => tag.includes(term)))
  const bodyTerms = termsIn(body, context.terms)
  if (titleTerms.length + tagTerms.length + bodyTerms.length === 0) return undefined

  const totalTerms = context.terms.length
  /**
   * 覆盖率的**分母**（本次提问落在语料里的信息量总量）只算一次、三个字段共用 ——
   * 它属于"问题"，不属于字段（v1.15.6 变体 B 的结论）。分子 massHit 仍**各字段自算**，
   * 所以"权重与覆盖率必须来自同一个字段"这条 v1.15.4 的修复没有被推翻。
   */
  const massQuery = context.terms.reduce((sum, term) => sum + idfOf(context.stats, term), 0)
  const titleField = fieldScore(WEIGHT.title, titleTerms, massQuery, context)
  const tagField = fieldScore(WEIGHT.tag, tagTerms, massQuery, context)
  const bodyField = fieldScore(WEIGHT.body, bodyTerms, massQuery, context)
  const titleScore = titleField.score
  const tagScore = tagField.score
  const bodyScore = bodyField.score
  const score = clamp01(Math.max(titleScore, tagScore, bodyScore))

  /**
   * 命中的字段（用于理由与展示）：取**得分最高**的那一档。
   * 三个字段的并集仍作为 `terms` 返回（便于人看"到底碰了哪些字"），
   * 但**分数只由胜出的那个字段决定** —— 这是 F5 的修复点。
   */
  const winner = score === titleScore && titleScore > 0
    ? { label: '标题', terms: titleTerms, massHit: titleField.massHit }
    : score === tagScore && tagScore > 0
      ? { label: '标签', terms: tagTerms, massHit: tagField.massHit }
      : { label: '正文', terms: bodyTerms, massHit: bodyField.massHit }
  const terms = [...new Set([...titleTerms, ...tagTerms, ...bodyTerms])]
  const reason = `${candidate.fromTask ? '本任务' : '全库'} · ${winner.label}命中「${winner.terms.join('、')}」`
    + `（该字段信息量 ${winner.massHit.toFixed(2)}/${massQuery.toFixed(2)}，命中 ${winner.terms.length}/${totalTerms} 个关键词）`
    + ` → 相关度 ${formatRelevance(score)}`

  const snippet = buildSnippet(entry, context.terms, RECALL_DEFAULTS.snippetLength)

  return {
    id: entry.id,
    title: entry.title,
    kindCode: entry.kindCode,
    score,
    relevance: relevanceOf(score),
    terms,
    reason,
    snippet,
    tags: entry.tags,
    fromTask: candidate.fromTask,
    updatedAt: entry.updatedAt,
    fileLink: entry.fileLink,
    sourceTaskId: entry.sourceTaskId,
  }
}

/**
 * 一次完整召回（纯函数）。
 *
 * 顺序即优先级：**过滤器 → 打分 → 阈值 → 去重 → 条数上限**。
 * 每一步都单独计数，这样日志里的"命中 N / 挡下 M / 上限截 K"
 * 与真正注入的条目能逐条对上账（团队记忆那条事故的教训）。
 */
export function recallKnowledge(input: RecallInput): RecallOutcome {
  const query = String(input.query ?? '').trim()
  const minScore = input.minScore ?? RECALL_DEFAULTS.minScore
  const maxEntries = Math.max(1, input.maxEntries ?? RECALL_DEFAULTS.maxEntries)
  const now = input.now ?? new Date()
  const exclude = new Set(input.excludeIds ?? [])
  const dedupe = input.dedupe !== false
  const base = { query, hits: [] as RecallHit[], nearMisses: [] as RecallHit[], matched: 0, droppedByScore: 0, droppedByLimit: 0, droppedAsSeen: 0, droppedAsSuperseded: 0, terms: [] as string[] }

  if (query === '') return { ...base, skippedReason: '空提问' }
  if (isTrivialQuery(query)) return { ...base, skippedReason: '琐碎消息' }

  const terms = extractTerms(query)
  if (terms.length === 0) return { ...base, skippedReason: '关键词为空（全是停用词）' }

  const stats = input.stats ?? termStatsOf(input.candidates)
  const context: ScoreContext = { terms, now, stats, massSat: input.massSat }
  const scored: RecallHit[] = []
  let anyTermHit = 0
  let droppedAsSuperseded = 0
  for (const candidate of input.candidates) {
    // P2：已被取代 / 已过期的条目根本不参与打分（压制，不是降权）
    if (isSuperseded(candidate.entry, now)) { droppedAsSuperseded += 1; continue }
    const hit = scoreCandidate(candidate, context)
    if (hit === undefined) continue
    anyTermHit += 1
    scored.push(hit)
  }
  // 排序：分数降序 → 任务域优先 → 更新时间降序（最近度只在这里起作用）→ id
  // （最后一项保证**结果稳定**：同分同时间的条目顺序不能每次跑都不一样，否则日志无法对比）
  scored.sort((a, b) =>
    b.score - a.score
    || Number(b.fromTask) - Number(a.fromTask)
    || recencyFactor(b.updatedAt, now) - recencyFactor(a.updatedAt, now)
    || a.id.localeCompare(b.id))

  const matched = scored.length
  // 严格大于：正文单命中（上限正好 0.34）必须被挡下 —— 见 `RECALL_DEFAULTS.minScore`。
  const aboveScore = scored.filter((hit) => hit.score > minScore)
  /**
   * 提示档：`[hintScore, minScore]` —— 差一点点的那些（见 `RecallOutcome.nearMisses`）。
   * 只在**没有完整命中**时才对外有意义（有完整命中时，提示是多余的噪声）；
   * `injectionFor` 那条路会照这个前提决定要不要拼提示行。
   * 阈值同上取**闭区间上界**：`score >= hintScore && score <= minScore`。
   */
  const hintScore = input.hintScore ?? RECALL_DEFAULTS.hintScore
  const nearMisses = scored.filter((hit) => hit.score > hintScore && hit.score <= minScore)
  const droppedByScore = matched - aboveScore.length - nearMisses.length

  let droppedAsSeen = 0
  const fresh = aboveScore.filter((hit) => {
    if (dedupe && exclude.has(hit.id)) { droppedAsSeen += 1; return false }
    return true
  })
  const hits = fresh.slice(0, maxEntries)
  const droppedByLimit = fresh.length - hits.length
  /**
   * P3：**top-1 放宽到 `topSnippetLength`**（其余仍是 `snippetLength`）。
   *
   * 只加长不换位置，而且走同一个 `buildSnippet` —— 片段的取法只有一处实现。
   * 顺序放在"截断到上限"之后：额度花在**真正会注入**的那一条上，
   * 被上限截掉的条目不浪费片段长度。
   */
  if (hits.length > 0) {
    const topEntry = input.candidates.find((candidate) => candidate.entry.id === hits[0].id)?.entry
    if (topEntry !== undefined) {
      const longer = buildSnippet(topEntry, terms, RECALL_DEFAULTS.topSnippetLength)
      if (longer.length > hits[0].snippet.length) hits[0] = { ...hits[0], snippet: longer }
    }
  }
  // 提示也守会话去重：已经作为完整命中注入过的条目不再当"差一点点"。
  const freshNear = nearMisses
    .filter((hit) => !exclude.has(hit.id))
    .slice(0, RECALL_DEFAULTS.maxHints)

  return { query, hits, nearMisses: freshNear, matched, droppedByScore, droppedByLimit, droppedAsSeen, droppedAsSuperseded, terms }
}

/**
 * 多句 query 合并（开工前那次召回用：任务标题 + 任务描述）。
 *
 * ## 为什么必须"分句算完再按 id 取最高分"，而不是把两句拼成一句
 *
 * 拼成一句会把**覆盖率的分母翻倍**：标题+描述各 10 个字，拼起来 20 个关键词，
 * 而一条知识通常只命中其中 5 个 → 覆盖率 0.25 → 谁都过不了阈值。
 * 实测就是被这个坑拦住的：任务「修复选择文件出不了 C 盘」+
 * 描述「盘符 根目录 parent 为 null」拼起来后，最相关的那条只有 0.18。
 * 分开算则描述那次的覆盖率是 5/12 → 0.23，仍然偏低，但至少**不会互相稀释**；
 * 而命中一旦落在标题上（覆盖率 1）就稳稳过线。
 *
 * 合并规则（纯函数、可穷举）：
 * - 按 id 去重，保留**分数更高**的那次（同分保留先出现的，于是结果稳定）；
 * - `matched` / `droppedByScore` 也按 id 去重后计数 —— 否则同一篇条目会在两句话里
 *   各算一次"命中过"，日志里的账会虚高一倍；
 * - 每条命中带上 `query`（哪句话带出来的），日志才能如实回显；
 * - **合并后必须重新施加单回合上限**（`maxEntries`）并把截掉的条数记进 `droppedByLimit`。
 *   不这么做的话，两句 query 各自命中 3 条、去重后互不重叠 → 一次注入 6 条，
 *   上限被绕过（线上实测出现过「注入 5 条」，见 `.review-evidence/live-log-hits.txt`）；
 *   而 `droppedByLimit` 还是 0，日志的账也对不上。
 */
export function mergeRecallOutcomes(
  inputs: Array<{ query: string; outcome: RecallOutcome }>,
  options: { maxEntries?: number } = {},
): RecallOutcome {
  const maxEntries = Math.max(1, options.maxEntries ?? RECALL_DEFAULTS.maxEntries)
  const skippedReasons = inputs.map((item) => item.outcome.skippedReason).filter((reason): reason is string => reason !== undefined)
  const base: RecallOutcome = {
    query: inputs.map((item) => item.query).join(' ／ '),
    hits: [],
    nearMisses: [],
    matched: 0,
    droppedByScore: 0,
    droppedByLimit: 0,
    droppedAsSeen: 0,
    droppedAsSuperseded: 0,
    terms: [...new Set(inputs.flatMap((item) => item.outcome.terms))],
  }
  // 全部句子都被跳过（空提问 / 琐碎）→ 整次召回就是"跳过"，不能装作查过了。
  if (inputs.every((item) => item.outcome.skippedReason !== undefined)) {
    return { ...base, skippedReason: skippedReasons[0] ?? '无可检索的句子' }
  }

  const best = new Map<string, RecallHit>()
  const order: string[] = []
  /** 差一点点的那些（提示档）：只在**没有任何完整命中**时才有意义，所以也按 id 去重、取高分。 */
  const nearBest = new Map<string, RecallHit>()
  const nearOrder: string[] = []
  let matched = 0
  let droppedByScore = 0
  let droppedAsSeen = 0
  let droppedAsSuperseded = 0
  for (const { query, outcome } of inputs) {
    matched += outcome.matched - outcome.hits.length
    droppedByScore += outcome.droppedByScore
    droppedAsSeen += outcome.droppedAsSeen
    droppedAsSuperseded += outcome.droppedAsSuperseded ?? 0
    for (const hit of outcome.hits) {
      const seen = best.get(hit.id)
      if (seen === undefined) {
        order.push(hit.id)
        best.set(hit.id, { ...hit, query })
        matched += 1
        continue
      }
      if (hit.score > seen.score) best.set(hit.id, { ...hit, query })
    }
    for (const near of outcome.nearMisses ?? []) {
      if (best.has(near.id)) continue // 已经是完整命中了，不必再当"差一点点"
      const seen = nearBest.get(near.id)
      if (seen === undefined) {
        nearOrder.push(near.id)
        nearBest.set(near.id, { ...near, query })
        continue
      }
      if (near.score > seen.score) nearBest.set(near.id, { ...near, query })
    }
  }
  const ranked = order
    .map((id) => best.get(id)!)
    .sort((a, b) => b.score - a.score || Number(b.fromTask) - Number(a.fromTask) || a.id.localeCompare(b.id))
  const hits = ranked.slice(0, maxEntries)
  const nearMisses = nearOrder
    .map((id) => nearBest.get(id)!)
    .sort((a, b) => b.score - a.score || Number(b.fromTask) - Number(a.fromTask) || a.id.localeCompare(b.id))
    .slice(0, RECALL_DEFAULTS.maxHints)
  return { ...base, hits, nearMisses, matched, droppedByScore, droppedByLimit: ranked.length - hits.length, droppedAsSeen, droppedAsSuperseded }
}

/**
 * 琐碎消息判定。
 *
 * 与团队记忆的 `isTrivial` 同一套语义（"好的"/"继续"这类不检索但要留痕），
 * 但**不复用它的实现**（那是另一个仓的私有函数）。判据保持"长度 + 纯寒暄词"两条，
 * 故意不做成"像不像问题"的模糊判断 —— 模糊判断会让"这一回合到底检索没检索"不可预期。
 */
const TRIVIAL_WORDS = new Set([
  '好的', '好', '嗯', '哦', 'ok', 'okay', '继续', '是的', '对的', '行', '可以', '收到',
  '谢谢', '谢谢了', '明白', '知道了', 'y', 'yes', 'no', 'no ', 'go', 'next', '接着',
])

export function isTrivialQuery(query: string): boolean {
  const text = normalizeText(query)
  if (text === '') return true
  if (TRIVIAL_WORDS.has(text)) return true
  const terms = extractTerms(text)
  if (terms.length === 0) return true
  /**
   * 判据分两档，**中文不能照抄英文那条 `length < 4`** —— 这是被真实数据逼出来的：
   * 本仓知识条目的中文关键词最短就是两个字（"盘符"、"迁移"、"分页"），
   * 按英文口径 "盘符" 会被当寒暄语跳过，而它恰恰是「选择文件出不了 C 盘」
   * 那条知识最自然的检索词（差点进生产）。
   *
   * 1. **含有拉丁/数字词**（长度 ≥ 2 的整词）：够用，不跳过（`e_noent`、`ab` 都算）。
   * 2. **纯汉字**：逐字抽词每个都只有 1 个字，按"词长"判就永远判成琐碎 ——
   *    所以改用**字数**：1 个汉字（"阈"、"盘"）命中面太宽必须跳过（否则一个"盘"字
   *    能把库里条目全捞出来），≥2 个汉字才算有信息量。
   */
  if (terms.some((term) => /^[a-z0-9]/.test(term))) return false
  return terms.length < 2
}

/**
 * 中和 `{{` —— 一段**宿主层面的硬约束**，不是我们自己的洁癖（v1.15.7 补）。
 *
 * `@deepseek-ai/dsh-system-prompt` 会把 `systemPrompt.context` 的文本当**模板**插值：
 * `lib/index.js:151 interpolate()` 扫 `{{name}}`，变量没注册就
 * `throw new Error('unknown prompt variable "{{…}}"')`（`lib/index.js:167`），
 * 而且这个异常发生在 `renderContextSections()`（同一文件 144 行）里 ——
 * **在我们的 text 回调之外**，我们的 try/catch 拦不住 → 会打断整个提示装配。
 *
 * 知识条目的正文/摘要来自用户内容，完全可能带 `{{`（模板语法、Vue/Angular 片段、
 * 别人写的 prompt 示例），所以注入前一律把它拆开。只动这一个字符组合，
 * 不改变可读性，也不碰其它任何内容。
 */
export function neutralizeTemplateBraces(text: string): string {
  return text.replace(/\{\{/g, '{ {')
}

/** 渲染注入文本。
 *
 * 三条纪律（都与团队记忆一致）：
 * 1. **零命中返回空串** —— 不产生任何消息，保住提示前缀缓存；
 * 2. 头部**恒定格式**，让"这一回合注入过什么"在会话里可读、可对账；
 * 3. 结尾给出下一步动作（要全文用工具读），避免模型对着片段猜。
 */
export function formatRecallText(outcome: RecallOutcome): string {
  if (outcome.hits.length === 0) return ''
  /**
   * 表头**不回显整段 query**（v1.15.7 的零风险收尾①）。
   *
   * 开工前那次的 query = 任务标题 + 整段描述（实测 483 字），每回合搬进对话
   * 白花约 500 字符。改成"前 60 字 + 前 12 个关键词"：表头只承担
   * "这是哪次提问、检索了什么"这一件事，**全文照旧进召回日志**（落库用 `outcome.query`）。
   */
  const terms = outcome.terms.slice(0, RECALL_DEFAULTS.queryEchoTerms)
  const lines = [
    `【工作台知识库】按本回合提问「${echoQuery(outcome.query)}」自动检索到 ${outcome.hits.length} 条相关知识`
    + (terms.length === 0 ? '：' : `（关键词：${terms.join('、')}）：`),
  ]
  for (const hit of outcome.hits) {
    const source = hit.fromTask ? '本任务' : '全库'
    const from = hit.query !== undefined && hit.query !== outcome.query ? ` · 来自「${hit.query.slice(0, 24)}」` : ''
    lines.push(`- [${hit.id}] ${hit.title}（${hit.kindCode} · ${source} · 相关度 ${formatRelevance(hit.score)} · 更新 ${hit.updatedAt.slice(0, 10)}${from}）`)
    if (hit.snippet !== '') lines.push(`  摘要：${hit.snippet}`)
    if (hit.fileLink !== null && hit.fileLink !== '') lines.push(`  文档：${hit.fileLink}`)
  }
  /**
   * 结尾两句话都必须**兑现得了**（v1.15.5 修）。
   *
   * 原先这里写着"需要展开某条时用返回里的 id 再查一次" —— 而 `workbench_search_knowledge`
   * 当时只会把 query 当**关键词**抽词打分，传 uuid 进去必然零命中：
   * 文档在许一个工具做不到的承诺。实测（2026-09-17，本机）就是这么被用户抓到的：
   * `query="7532f45e-cb93-…"` → 零命中。现在工具支持按 id 直读全文，这句话才成立。
   */
  lines.push('需要全文时：把上面某条的 [id]（完整 uuid）作为 query 传给 workbench_search_knowledge，会返回全文而不是 160 字摘要。')
  lines.push('用到哪几条请调用 workbench_knowledge_recall_control(action=report_usage, entry_ids=[...]) 回报引用。')
  // 宿主会把这整段当模板插值，`{{` 必须中和（见 `neutralizeTemplateBraces` 的注释）
  return neutralizeTemplateBraces(lines.join('\n'))
}

/**
 * 这次召回**会不会在会话里留下东西**（完整块或提示行）。
 *
 * 单独一个函数是因为它被用在三个地方（`prime` 的日志、`prefetch` 的日志、
 * `prefetch` 里"迟到的开工前结果要不要并进来"），三处各写一遍
 * `hits.length > 0 || nearMisses.length > 0` 迟早会漏掉一处 —— 而漏掉的表现是
 * "日志说没注入、会话里却有提示行"，正是本仓最忌讳的账对不上。
 */
export function willInject(outcome: RecallOutcome): boolean {
  return outcome.hits.length > 0 || (outcome.nearMisses?.length ?? 0) > 0
}

/**
 * 渲染**提示行**（v1.15.6 的 P1，两档闸门的第二档）。
 *
 * ## 为什么是"一行"而不是"一个小块"
 *
 * 提示档的语义是"**未必相关，但值得你看一眼**" —— 所以它必须**看起来就不像已确认的知识**：
 * 不给摘要、不给分类、不给更新时间，只给 id + 标题 + 相关度，并明说"未达注入闸门"。
 * 这样模型不会把它当事实用，而是当成一个"要不要去查"的线索。
 *
 * 成本对比（实测同一条条目）：完整块 ≈ 1000 字符（表头 483 字 + 条目行 + 160 字摘要 + 文档路径 + 两行纪律），
 * 提示行 ≈ 90 字符 —— 差一个数量级。而这正是"真实提问普遍卡在阈值下 0.01~0.03"这个实测现状的补偿手段：
 * **闸门不降（噪声进不来），但差一点点的不再被完全丢掉**。
 *
 * 纪律与 `formatRecallText` 一致：没有提示就返回空串（**不插占位**）。
 */
export function formatHintText(outcome: RecallOutcome, hints: RecallHit[] = outcome.nearMisses): string {
  if (hints.length === 0) return ''
  const items = hints
    .map((hit) => `[${hit.id}] ${hit.title.slice(0, 28)}（${formatRelevance(hit.score)}）`)
    .join('；')
  return neutralizeTemplateBraces(`【工作台知识库】本回合提到的事，库里有 ${hints.length} 条**可能**相关但未达注入闸门（仅供参考，未核实）：`
    + `${items}。需要的话用 workbench_search_knowledge 按 [id] 取全文。`)
}

/**
 * 从会话工作目录猜任务 id（`<任务ID>-<标题片段>` 命名，见 `taskWorkspaceFolderName`）。
 *
 * 只作为**兜底**：权威来源是 `task_sessions` 反查（链路见 `sessionTaskId`）。
 * 猜不到就返回 undefined —— 不猜半个 id（猜错会把别的任务的知识带进来，
 * 比不召回更糟：那正是"静默把错的东西写进上下文"）。
 */
export function taskIdFromWorkspacePath(cwd: string | undefined | null): string | undefined {
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  const normalized = cwd.replace(/[\\/]+$/, '')
  const segments = normalized.split(/[\\/]/)
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-|$)/i.exec(segments[index])
    if (match !== null) return match[1]
  }
  return undefined
}
