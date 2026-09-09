/**
 * /api/workbench/skills —— DSH 技能目录（只读）。
 *
 * 供工作台前端在 AI 执行/协助/拆解/复盘等会话前的提示词输入区渲染可多选、可搜索的
 * Skill 列表。列表来自宿主 skills 注册表（软探测），**未安装时返回空列表 + available:false**，
 * 前端据此隐藏选择器 —— 保证"未选技能时行为与既有版本完全一致"这条底线。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackRequest, writeJson } from './helpers.js'
import { normalizeSkillEntries, selectUserInvocable, type SkillsService } from '../skills.js'

export const SKILLS_PATH = '/api/workbench/skills'

export interface SkillRouteDeps {
  /** 每次请求实时探测，避免缓存"宿主稍后才注册服务"的早期快照 */
  probe: () => SkillsService | undefined
  /** 直通模式：返回注册表原始摘要（含 invocation 等字段），供排障用 */
}

export function makeSkillRoutes(deps: SkillRouteDeps): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: SKILLS_PATH,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url ?? SKILLS_PATH, 'http://localhost')
        const service = deps.probe()
        if (service === undefined) return writeJson(res, 200, { ok: true, available: false, skills: [] })
        try {
          const raw = await service.list()
          if (url.searchParams.get('raw') === '1') return writeJson(res, 200, { ok: true, available: true, skills: raw })
          return writeJson(res, 200, { ok: true, available: true, skills: selectUserInvocable(normalizeSkillEntries(raw)) })
        } catch (error) {
          // 技能发现失败不阻断工作台：返回空列表并如实标注原因
          return writeJson(res, 200, {
            ok: true,
            available: false,
            skills: [],
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    },
  ]
}
