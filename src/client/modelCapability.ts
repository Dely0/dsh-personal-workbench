/**
 * 「这个模型收不收图片」的客户端判定（v1.15.1）。
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

/** 打开模型选择器前的可用性判定。 */
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
 * 两种原因必须分开说：**"还没开会话"与"宿主没这个服务"是两码事** ——
 * 本次就是因为混在一起、且措辞笃定，把真正的成因盖掉了。
 *
 * @param input.hasDirectory - 是否真的拿到了会话模型目录。
 * @param input.sessionId - 用来解析目录的会话 id（空 = 会话还没就绪）。
 */
export function gateModelPicker(input: { readonly hasDirectory: boolean; readonly sessionId: string }): ModelPickerGate {
  if (input.hasDirectory) return { ok: true }
  return {
    ok: false,
    reason: input.sessionId === ''
      ? '当前还没有可用的会话，无法读取模型列表'
      : '当前 DSH 未提供模型选择接口（modelDirectories），无法读取模型列表',
  }
}
