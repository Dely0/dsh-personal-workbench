/**
 * 模型**输入能力**查询（只做一件事：某个 (provider, model) 收不收图片）。
 *
 * ## 为什么必须有它（浏览器侧的目录查不到这件事）
 *
 * 宿主在多模态管线上按模型**显式声明**的输入能力判定：
 * `dsh-llm` 的 `projectImagesForTextModel` 只在
 * `inputModalities !== undefined && !inputModalities.includes('image')` 时，
 * 把图片换成 `[image omitted because this model accepts text only; attachment sha256:…]`。
 * 也就是说：**选了不收图的模型，用户加的图片会被静默换成一行文字**。
 *
 * 而浏览器侧 `modelDirectories` 的目录条目（`ModelCatalogModel`）**没有** `inputModalities`
 * 字段 —— 客户端根本无从判断。所以这一小块信息只能由宿主侧提供。
 *
 * ## 单一权威源
 *
 * 这里**不复制宿主目录**：不返回模型名、不返回分组、不返回顺序，
 * 只返回 `{provider, model} → inputModalities` 的**能力映射**。
 * 选哪个模型仍然只由 `ctx.modelDirectories`（宿主权威目录）决定，
 * 本路由只回答"它收不收图"。
 *
 * 事实来源是宿主 `llm` 服务（`ctx.llm.listProviders()` / `listModels(provider)`），
 * 对 deepseek 适配器是**离线读配置**（`Promise.resolve(...)`），不会打网络。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackRequest, writeJson } from '../http.js'

export const MODEL_MODALITIES_PREFIX = '/api/workbench/model-modalities'

/** 我们要用到的 `llm` 服务的最小形状（只声明形状，不 import 宿主类型）。 */
export interface LlmModalityProbe {
  readonly listProviders?: () => readonly unknown[]
  readonly listModels?: (provider: string) => Promise<readonly unknown[]>
}

/** 一条模型能力记录；`inputModalities` 为 null 表示"宿主没有声明"。 */
export interface ModelModalityRecord {
  readonly provider: string
  readonly model: string
  readonly inputModalities: readonly string[] | null
}

/** 从宿主返回值里安全地抽出我们要的两个字段（宿主字段名/形状漂移时不会炸）。 */
function toRecord(provider: string, entry: unknown): ModelModalityRecord | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const candidate = entry as { id?: unknown; inputModalities?: unknown }
  if (typeof candidate.id !== 'string' || candidate.id === '') return undefined
  const modalities = Array.isArray(candidate.inputModalities)
    ? candidate.inputModalities.filter((item): item is string => typeof item === 'string')
    : null
  return { provider, model: candidate.id, inputModalities: modalities }
}

/**
 * 汇总所有 provider 的模型能力。
 *
 * **单个 provider 失败不影响其余**（对照表是"尽力而为"的增强信息）：
 * 失败的 provider 名收进 `failures`，客户端把它显示成一条提示而不是静默忽略。
 */
export async function collectModelModalities(probe: LlmModalityProbe): Promise<{ models: ModelModalityRecord[]; failures: string[] }> {
  const models: ModelModalityRecord[] = []
  const failures: string[] = []
  const providers = typeof probe.listProviders === 'function' ? probe.listProviders() : []
  for (const entry of providers) {
    const id = typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined
    if (typeof id !== 'string' || id === '') continue
    if (typeof probe.listModels !== 'function') { failures.push(id); continue }
    try {
      const list = await probe.listModels(id)
      for (const item of list) {
        const record = toRecord(id, item)
        if (record !== undefined) models.push(record)
      }
    } catch { failures.push(id) }
  }
  return { models, failures }
}

/**
 * @param probe - 软探测宿主 `llm` 服务的回调；拿不到时返回 undefined。
 */
export function makeModelModalityRoutes(probe: () => LlmModalityProbe | undefined): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: MODEL_MODALITIES_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        const llm = probe()
        /**
         * 拿不到 `llm`（旧宿主 / 该服务被 isolate 藏了）时返回 `available: false`，
         * 而不是报错：这只是"能不能提前判断收不收图"的增强信息，
         * 缺了以后由宿主的原生兜底（把图片换成占位文字）继续生效。
         */
        if (llm === undefined) return writeJson(res, 200, { ok: true, available: false, models: [], failures: [] })
        try {
          const { models, failures } = await collectModelModalities(llm)
          return writeJson(res, 200, { ok: true, available: true, models, failures })
        } catch (error) {
          return writeJson(res, 200, { ok: true, available: false, models: [], failures: [], error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}
