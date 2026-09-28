/**
 * 「这个模型收不收图片」的客户端判定（v1.15.1）。
 *
 * v1.15.7 起还负责**模型目录可用性的唯一判定**（见文件末 `resolveModelDirectoryOutcome`）——
 * 2026-09-28 的死锁事故就是因为"拿不到目录"被当成"整条快速录入失败"。
 *
 * ## 为什么客户端要自己判一次
 *
 * 宿主在多模态管线上的行为是：**当模型声明了 `inputModalities` 且其中没有 `image` 时**，
 * 把图片块替换成一行文字
 * `[image omitted because this model accepts text only; attachment sha256:…]`
 * （`dsh-llm` 的 `projectImagesForTextModel`）。
 *
 * 用户看到的是"我明明传了截图，AI 却说没看到" —— 这就是**静默丢弃**，
 * 本项目规范第 4/7 条明确禁止。所以选择"不收图的模型"时必须在**发送前**给出可读提示。
 *
 * 浏览器侧 `modelDirectories` 的目录条目**没有** `inputModalities` 字段，
 * 所以这份对照表由宿主侧路由 `/api/workbench/model-modalities` 提供
 * （见 `src/api/routes/model-modalities.ts`，那里只提供能力，不复制目录）。
 *
 * ## 判据必须与宿主逐条对齐（否则会出现"我们说不收、其实收了"）
 *
 * | 宿主 `inputModalities` | 宿主行为 | 本模块判定 |
 * |---|---|---|
 * | `undefined`（模型没声明） | **图片照常发**（只有"声明了且不含 image"才替换） | `unknown`（不拦） |
 * | `[]` / `['text']` | 图片被换成占位文字 | `rejected` |
 * | 含 `'image'` | 图片正常进请求 | `accepted` |
 *
 * 判不出来时一律 `unknown` —— **fail open**：误拦会挡住本来可用的图片功能，
 * 而宿主的原生兜底本来就会把图片换成占位文字（有损但不崩）。
 *
 * 纯逻辑，不 import React、不碰 DOM → 可被 `node --test` 直接测。
 */
import type { ModelDirectoryRuntime, QuickModelSelection } from './viewTypes.js'

/**
 * 选择器里"改回跟默认"那一项的字面文案（界面与提示词共用一处）。 */
export const CLEAR_SELECTION_LABEL = '跟随 DSH 默认模型'

/**
 * 快速录入自动降级时的提示前缀（**只讲发生了什么事**）。
 *
 * ⚠️ 具体**为什么**拿不到目录由 `modelDirectoryUnavailableReason()` 给（唯一实现），
 * 拼在它后面 —— 不许在这里再写死一句"当前拿不到模型选择接口"：
 * 本机 provider 是装着的，"接口没提供"这句话在"服务在场、只是会话没就绪"时是**误诊**
 * （2026-09-28 审查 F1 实测：同一个事实被翻译成互相矛盾的两句话）。
 *
 * 要求（验收标准 3）：**不静默**，且必须明确说"本次没有切换模型、用的是默认模型"。
 */
export const QUICK_MODEL_DEGRADE_PREFIX = '本次未切换模型，已按「' + CLEAR_SELECTION_LABEL + '」继续'

/** 宿主侧返回的一条能力记录（`inputModalities` 为 null = 宿主没声明）。 */
export interface ModelModalityRecord {
  readonly provider: string
  readonly model: string
  readonly inputModalities: readonly string[] | null
}

/** 判定结果：`rejected` 时 `reason` 是人能看懂、能照做的一句话。 */
export type ImageSupportVerdict =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string }

/** 对照表的键：`provider/model`。 */
export function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** 把路由返回的记录数组编成 `provider/model → inputModalities` 的查表结构。 */
export function indexModalities(records: readonly ModelModalityRecord[]): Map<string, readonly string[] | null> {
  const map = new Map<string, readonly string[] | null>()
  for (const record of records) {
    if (typeof record?.provider !== 'string' || typeof record?.model !== 'string') continue
    map.set(modelKey(record.provider, record.model), record.inputModalities ?? null)
  }
  return map
}

/**
 * 判定某个模型能否接收图片。
 *
 * @param table - `indexModalities()` 的结果。
 * @param provider - 选中的 provider。
 * @param model - 选中的模型 id。
 * @returns `accepted` / `rejected`（带可读原因）/ `unknown`（不拦）。
 */
export function evaluateImageSupport(table: ReadonlyMap<string, readonly string[] | null>, provider: string, model: string): ImageSupportVerdict {
  if (provider === '' || model === '') {
    return { kind: 'unknown', reason: '当前会话没有明确的模型信息，交给宿主按模型能力自行处理' }
  }
  if (!table.has(modelKey(provider, model))) {
    return { kind: 'unknown', reason: `模型能力对照表里没有 ${modelKey(provider, model)}，无法提前判断` }
  }
  const modalities = table.get(modelKey(provider, model)) ?? null
  if (modalities === null) {
    return { kind: 'unknown', reason: `模型 ${model} 没有声明输入能力，宿主会按原样发送图片` }
  }
  if (modalities.includes('image')) return { kind: 'accepted' }
  return {
    kind: 'rejected',
    reason: `当前模型「${model}」只接受文本输入（声明能力：${modalities.join('、') || '无'}），`
      + '图片会被宿主替换成一行占位文字，AI 看不到图。'
      + '请改选支持图片的模型（例如 deepseek-flash），或先移除已添加的图片再发送。',
  }
}

/**
 * 决定"本次发送用哪个模型"。
 *
 * - 用户在工作台里显式选过 → 用他选的（`select()` 会把 `current` 更新成它）；
 * - 没选过 → 用会话目录里的 `current`（宿主的持久投影）；
 * - 都拿不到 → `undefined`，此时不做提前判定（交给宿主）。
 */
export function effectiveSelection(
  quick: { provider: string; model: string } | null,
  directoryCurrent: { provider: string; model: string } | null | undefined,
): { provider: string; model: string } | undefined {
  if (quick !== null && quick.provider !== '' && quick.model !== '') return quick
  if (directoryCurrent !== null && directoryCurrent !== undefined && directoryCurrent.provider !== '' && directoryCurrent.model !== '') {
    return { provider: directoryCurrent.provider, model: directoryCurrent.model }
  }
  return undefined
}

/**
 * 打开模型选择器前的可用性判定。
 *
 * ⚠️ 判定只吃**两个事实**：目录拿没拿到、有没有会话。**成因**（服务不在场 / 会话没就绪）
 * 由调用方通过 `unavailableReason` 传进来 —— 那是 `modelDirectoryUnavailableReason()`
 * 的产物，也就是**唯一**的成因实现。这样"同一个事实被两处翻译"在结构上不可能：
 * 2026-09-28 审查 F1 抓到的正是旧写法（门禁自己拼一句"未提供接口"、提示另拼一句）。
 */
export type ModelPickerGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * 能否打开模型选择器 —— **与"选择器当前是否已经打开"无关**。
 *
 * ## 为什么专门把这件事抽成一个函数（v1.15.2 的真实 bug）
 *
 * 第一版把它写在组件里，且把"解析目录"做成了惰性的：
 * `const directory = useMemo(() => open ? resolveModelDirectory(...) : undefined, [open, …])`，
 * 而 `openPicker()` 又用 `directory === undefined` 判定"宿主没提供这个服务"、
 * **同时**负责把 `open` 置真 —— 于是第一次点击时 `open` 必然还是 `false`，
 * 判定**必然**走进"未提供模型选择接口"分支：一个自我实现的假失败，
 * 宿主到底有没有这个服务都一样。用户看到的就是"点了模型按钮弹红字"。
 *
 * 规矩：**可用性判定不许依赖它自己要控制的状态。** 抽成纯函数后，
 * 这条判定的输入只有"目录拿没拿到"与"有没有会话"两个事实，与 UI 开关无关；
 * 回归断言见 `test/quickIntakeClient.test.mjs`（既测这张表，也扫源码禁止那个形态复活）。
 *
 * ## 为什么这里不再自己拼"服务没提供"（2026-09-28 审查 F1）
 *
 * 曾经它接收 `hasDirectory: boolean`，于是只能拿一句写死的话解释失败 ——
 * 而 `false` 这个布尔值同时代表"服务不在场"与"服务在场、只是这个会话取不到目录"。
 * 后者在本机是真实发生的（宿主 `directoryFor` 抛 `resolved no binding`），
 * 却被说成"当前 DSH 未提供模型选择接口"：**把排查方向整个带偏**。
 * 现在成因只由 `modelDirectoryUnavailableReason(outcome)` 产出、原样传进来。
 *
 * ## 出口是否可达：由调用方用**菜单判定**决定，不在这里再算一遍
 *
 * "有残留选择时菜单要开得起来（只给清空出口）"这件事的唯一判据是
 * `modelMenuMode({ hasSelection }).mode === 'clear-only'`。调用方把它算好传进
 * `recoverable` —— 门禁**不再**自己看 `hasSelection`，否则同一个语义就有两处实现
 * （本条同样是 2026-09-28 审查 F2 的结论）。
 *
 * @param input.hasDirectory - 是否真的拿到了会话模型目录。
 * @param input.sessionId - 用来解析目录的会话 id（空 = 会话还没就绪）。
 * @param input.unavailableReason - `hasDirectory === false` 时给用户看的成因。
 * @param input.recoverable - 菜单里是否还留得下"清掉残留选择"这个出口。
 */
export function gateModelPicker(input: {
  readonly hasDirectory: boolean
  readonly sessionId: string
  readonly unavailableReason: string
  readonly recoverable: boolean
}): ModelPickerGate {
  if (input.hasDirectory) return { ok: true }
  const reason = input.sessionId === ''
    ? '当前还没有可用的会话，无法读取模型列表'
    : input.unavailableReason
  return {
    ok: false,
    reason: reason === ''
      ? '当前拿不到模型列表'
      : input.recoverable ? reason : `${reason}；当前也没有已保存的模型选择可以清掉，所以这个菜单暂时没有可用操作。`,
  }
}

// ---------------------------------------------------------------- 目录解析的单一判定

/** 解析会话模型目录失败时的两种**成因**（必须分开说，见 `gateModelPicker` 的注释）。 */
export type ModelDirectoryUnavailableCode = 'service' | 'session'

/** 解析结果：要么拿到目录，要么给出**可读的成因**（绝不返回裸 `undefined`）。 */
export type ModelDirectoryOutcome =
  | { readonly ok: true; readonly directory: ModelDirectoryRuntime }
  | { readonly ok: false; readonly code: ModelDirectoryUnavailableCode; readonly detail: string }

/**
 * 把"读宿主服务 + 取会话目录"收敛成**一处判定**，并保住失败原因。
 *
 * ## 为什么不能用 `try { … } catch { return undefined }`（2026-09-28 死锁事故）
 *
 * 旧写法把两件**完全不同**的事实压成同一个 `undefined`：
 *
 * 1. 服务根本不在场（`ctx.get('modelDirectories')` 拿不到，或没有 `directoryFor`）；
 * 2. 服务在场，但**这个会话**取不到目录 —— 宿主的 `directoryFor(sessionId)` 会
 *    在 `sessions.scope(id)` / `sessions.binding(id)` 为空时**直接抛错**
 *    （`ui-model-selection: session "…" resolved no binding`，与 `sessionRef.ts`
 *    记的那次 rc2 契约漂移同源）。
 *
 * 两种情况在界面上被说成同一句"当前 DSH 未提供模型选择接口（modelDirectories）"，
 * 而本机该 provider **确实已安装**（`dsh-client-ui-model-selection@0.1.7-rc.2`
 * 经 `dsh-web-app` 进入 web profile）—— 报错文案因此把排查方向整个带偏。
 *
 * ⚠️ 这里**不** import React、不碰 DOM，也不自己取 `ctx`：宿主上下文由调用方
 * 作为 `readService` 注入，所以本判定可被 `node --test` 直接跑（`test/modelPickerDegrade.test.mjs`）。
 *
 * @param readService - 读宿主服务的函数（调用方传 `ctx.get` 的封装）。
 * @param sessionId - 要解析目录的会话 id（空 = 会话还没就绪）。
 */
export function resolveModelDirectoryOutcome(
  readService: () => unknown,
  sessionId: string,
): ModelDirectoryOutcome {
  /**
   * ⚠️ **读服务本身也要包起来**：cordis 的代理在 fiber 已销毁时会抛
   * `cannot get required service … in inactive context`（本仓 `safeService()` 的由来）。
   * 这里吞掉这个异常**不代表**静默降级 —— 它会变成一条 `code: 'service'` 的可读原因，
   * 由调用方展示并打日志。
   */
  let raw: unknown
  try {
    raw = readService()
  } catch (error) {
    return {
      ok: false,
      code: 'service',
      detail: `读取宿主服务时抛错：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const service = raw as { directoryFor?: (id: string) => ModelDirectoryRuntime } | null | undefined
  if (service === null || service === undefined || typeof service.directoryFor !== 'function') {
    return {
      ok: false,
      code: 'service',
      detail: '宿主没有提供 modelDirectories 服务（它不是前置依赖，缺了只是少一个下拉框）',
    }
  }
  if (sessionId === '') {
    return { ok: false, code: 'session', detail: '还没有可用的会话，模型目录得先有个会话可问' }
  }
  try {
    const directory = service.directoryFor(sessionId)
    if (directory === null || directory === undefined) {
      return { ok: false, code: 'session', detail: `宿主为会话 ${sessionId} 返回了空的模型目录` }
    }
    return { ok: true, directory }
  } catch (error) {
    return {
      ok: false,
      code: 'session',
      detail: `宿主为会话 ${sessionId} 解析模型目录时抛错：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** 关闭菜单时宿主失败原因的机器判据（宿主原文里点名了这两件事，就别硬翻成"不支持"）。 */
const HOST_DIRECTORY_FAILURE_PATTERN = /no scope|no binding|inactive context|inactive/i

/** 菜单要列什么：整份目录列表，还是"只给一个清空出口"（附带原因）。 */
export interface ModelMenuDecision {
  readonly mode: 'full' | 'clear-only'
  /** `clear-only` 时给用户看的原因（空串 = 不显示原因行）。 */
  readonly reason: string
}

/**
 * 菜单是否还能列出模型 —— 决定"整份目录列表"与"只给一个清空出口"。
 *
 * `directory === undefined` 时不是关掉整个控件，而是**退化成一份只有
 * 「跟随 DSH 默认模型」的菜单**（附原因），否则用户就被锁死在残留选择上
 * （2026-09-28 死锁事故：菜单被门禁挡死 ⇒ 唯一的写入口也没了）。
 *
 * @param input.directory - 解析到的会话模型目录（`undefined` = 没拿到）。
 * @param input.hasSelection - 用户手里是否还有一条已持久化的模型选择。
 * @param input.unavailableReason - 目录拿不到的可读原因（来自 `modelDirectoryUnavailableReason`）。
 */
export function modelMenuMode(input: {
  readonly directory: ModelDirectoryRuntime | undefined
  readonly hasSelection: boolean
  readonly unavailableReason: string
}): ModelMenuDecision {
  if (input.directory !== undefined) return { mode: 'full', reason: '' }
  if (!input.hasSelection) return { mode: 'full', reason: '' }
  return {
    mode: 'clear-only',
    reason: `${input.unavailableReason}。你仍可以在这里改回「${CLEAR_SELECTION_LABEL}」，清掉这条残留选择。`,
  }
}

/**
 * 清空选择 —— **不依赖任何模型目录**，这正是"保留出口"（验收标准 2）能成立的原因。
 *
 * 返回 `null` 是"跟随 DSH 默认模型"的既有表示（`writeQuickModelSelection(null)`
 * 会 `removeItem` 掉 localStorage 里那条残留选择）。
 */
export function clearQuickModelSelection(_current: QuickModelSelection | null): null {
  return null
}

/** 本次发送"到底用不用用户选的那个模型"的判定结果。 */
export type SelectionApplication =
  | { readonly kind: 'apply'; readonly selection: { provider: string; model: string; reasoningEffort?: string } }
  | { readonly kind: 'follow-default'; readonly notice: string }

/**
 * 快速录入提交时：**这次到底换不换模型**（2026-09-28 死锁事故的核心判据）。
 *
 * 旧实现（`src/client/index.tsx` 的 1508-1512 行）在"有选择 + 拿到目录"之外
 * **直接 `throw`**，于是整条快速录入被一条可选增强拖死 —— 用户看到的就是
 * "选过模型之后，快速录入整个不可用"。
 *
 * 新口径（用户已确认 A + B 都要）：
 *
 * - 拿到目录 → 照旧应用用户选的模型（**既有设计意图不许删**：换模型失败仍要可读报错，
 *   错误由 `directory.select()` 抛出并原样上抛，这里不吞）；
 * - 拿不到目录 → **降级跟随默认模型**，提示里带上**真实成因**
 *   （`modelDirectoryUnavailableReason()`，唯一实现）+ 出口是否可达。
 *
 * ⚠️ 提示里那句"可以在这里改回默认模型"**只在出口真的可达时**才给：
 * 菜单被门禁挡住时让用户去点菜单，是让人照做无路可走（2026-09-28 审查 F1）。
 *
 * @param selection - 已持久化的用户选择（`null` = 本来就跟着默认）。
 * @param outcome - `resolveModelDirectoryOutcome()` 的结果。
 * @param input.clearExitReachable - "清空出口"此刻是否在界面上可达（`menuDecision.mode === 'clear-only'`）。
 */
export function selectionToApply(
  selection: QuickModelSelection | null,
  outcome: ModelDirectoryOutcome,
  input: { readonly clearExitReachable: boolean } = { clearExitReachable: false },
): SelectionApplication {
  if (selection === null) return { kind: 'follow-default', notice: '' }
  if (outcome.ok) {
    return {
      kind: 'apply',
      selection: {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      },
    }
  }
  const reason = modelDirectoryUnavailableReason(outcome)
  return {
    kind: 'follow-default',
    notice: `${QUICK_MODEL_DEGRADE_PREFIX}。原因：${reason}`
      + (input.clearExitReachable
        ? `你可以在快速录入选模型的地方改回「${CLEAR_SELECTION_LABEL}」，清掉这条残留选择。`
        : ''),
  }
}

/**
 * 提交路径上给用户看的模型标签（提示词里的"本次会话模型"那一行）。
 *
 * 为什么单独抽出来：降级发生时，本地还留着用户上次选的那个模型名，
 * 如果照旧把**它**写进提示词，AI 会被告知一个本次根本没生效的模型 —— 又一处静默撒谎。
 */
export function effectiveModelLabel(application: SelectionApplication, stored: QuickModelSelection | null): string {
  if (application.kind === 'follow-default') return CLEAR_SELECTION_LABEL
  if (stored === null) return CLEAR_SELECTION_LABEL
  return stored.effortLabel === undefined ? stored.label : `${stored.label} · ${stored.effortLabel}`
}

/** 目录解析失败时，给用户看的原因（把成因翻译成"能照做"的一句话）。 */
export function modelDirectoryUnavailableReason(outcome: ModelDirectoryOutcome): string {
  if (outcome.ok) return ''
  if (outcome.code === 'service') {
    return '当前 DSH 未提供模型选择接口（modelDirectories），无法读取模型列表'
  }
  // ⚠️ 这里**不许**照抄上面那句：本机 provider 是装着的（dsh-client-ui-model-selection
  // 经 dsh-web-app 进入 web profile），把"会话没就绪 / 宿主抛错"说成"未提供接口"
  // 正是 2026-09-28 那次把排查方向带偏的原因。
  const hint = HOST_DIRECTORY_FAILURE_PATTERN.test(outcome.detail)
    ? '（宿主要求先把该会话 retain 起来才能取它的模型目录）'
    : ''
  return `模型选择接口在场，但这次取不到该会话的模型目录${hint}：${outcome.detail}`
}
