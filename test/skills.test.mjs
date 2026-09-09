/**
 * Skill 选择器：host 侧目录归一化 + /api/workbench/skills 路由 + 客户端提示词注入。
 *
 * 覆盖三条底线：
 * 1. 宿主未注册 skills 服务 → available:false + 空列表（前端隐藏选择器，行为零变化）；
 * 2. provider 字段脏数据 → 坏条目丢弃，不 500；
 * 3. 未选技能 → 提示词逐字不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSkillEntries, probeSkills, selectUserInvocable } from '../lib/api/skills.js'
import { makeSkillRoutes, SKILLS_PATH } from '../lib/api/routes/skills.js'
import { buildSkillPromptBlock, withSkillPromptBlock } from '../lib/client/skillPrompt.js'

// ---------------------------------------------------------------------------
// host：目录归一化
// ---------------------------------------------------------------------------

const RAW = [
  {
    name: 'vision-skills',
    description: '把截图还原为 UI',
    whenToUse: '需要看图时',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'file-system',
    source: 'C:/skills/vision-skills/SKILL.md',
  },
  { name: 'internal-only', description: '模型专用', invocation: { modelInvocable: true, userInvocable: false }, provider: 'runtime', source: 'x' },
  { description: '缺少 name，应被丢弃' },
  null,
  'not-an-object',
]

test('normalizeSkillEntries 保留合法条目并补默认值', () => {
  const entries = normalizeSkillEntries(RAW)
  assert.equal(entries.length, 2)
  const vision = entries[0]
  assert.equal(vision.name, 'vision-skills')
  assert.equal(vision.description, '把截图还原为 UI')
  assert.equal(vision.whenToUse, '需要看图时')
  assert.equal(vision.provider, 'file-system')
  assert.equal(vision.userInvocable, true)
  assert.equal(vision.modelInvocable, true)
})

test('normalizeSkillEntries 对缺失字段兜底而非抛错', () => {
  const [entry] = normalizeSkillEntries([{ name: 'bare' }])
  assert.deepEqual(entry, { name: 'bare', description: '', provider: 'unknown', source: '', userInvocable: true, modelInvocable: true })
})

test('normalizeSkillEntries 非数组输入返回空数组', () => {
  assert.deepEqual(normalizeSkillEntries(undefined), [])
  assert.deepEqual(normalizeSkillEntries({ skills: [] }), [])
})

test('selectUserInvocable 过滤模型专用技能', () => {
  const names = selectUserInvocable(normalizeSkillEntries(RAW)).map((entry) => entry.name)
  assert.deepEqual(names, ['vision-skills'])
})

// ---------------------------------------------------------------------------
// host：路由
// ---------------------------------------------------------------------------

/** 最小 IncomingMessage / ServerResponse 替身，只覆盖路由用到的字段。 */
function fakeExchange({ method = 'GET', url = SKILLS_PATH, remoteAddress = '127.0.0.1', host = '127.0.0.1:3080' } = {}) {
  const req = { method, url, socket: { remoteAddress }, headers: { host } }
  const captured = { status: 0, body: undefined }
  const res = {
    writeHead(status) { captured.status = status },
    end(payload) { captured.body = payload === undefined ? undefined : JSON.parse(payload) },
  }
  return { req, res, captured }
}

async function callRoute(route, exchange) {
  await route.handler(exchange.req, exchange.res)
  return exchange.captured
}

test('skills 路由：非回环请求拒绝', async () => {
  const [route] = makeSkillRoutes({ probe: () => ({ list: async () => [] }) })
  const captured = await callRoute(route, fakeExchange({ remoteAddress: '10.0.0.5' }))
  assert.equal(captured.status, 403)
})

test('skills 路由：宿主未注册服务时 available=false 且列表为空', async () => {
  const [route] = makeSkillRoutes({ probe: () => undefined })
  const captured = await callRoute(route, fakeExchange())
  assert.equal(captured.status, 200)
  assert.deepEqual(captured.body, { ok: true, available: false, skills: [] })
})

test('skills 路由：正常返回用户可调用技能', async () => {
  const [route] = makeSkillRoutes({ probe: () => ({ list: async () => RAW }) })
  const captured = await callRoute(route, fakeExchange())
  assert.equal(captured.status, 200)
  assert.equal(captured.body.available, true)
  assert.deepEqual(captured.body.skills.map((s) => s.name), ['vision-skills'])
})

test('skills 路由：技能发现抛错时降级为空列表并标注原因', async () => {
  const [route] = makeSkillRoutes({ probe: () => ({ list: async () => { throw new Error('provider boom') } }) })
  const captured = await callRoute(route, fakeExchange())
  assert.equal(captured.status, 200)
  assert.equal(captured.body.available, false)
  assert.deepEqual(captured.body.skills, [])
  assert.equal(captured.body.error, 'provider boom')
})

test('skills 路由：只接受 GET', async () => {
  const [route] = makeSkillRoutes({ probe: () => ({ list: async () => [] }) })
  const captured = await callRoute(route, fakeExchange({ method: 'POST' }))
  assert.equal(captured.status, 405)
})

test('probeSkills 只接受带 list() 的服务', () => {
  assert.equal(probeSkills({ get: () => undefined }), undefined)
  assert.equal(probeSkills({ get: () => ({ list: () => [] }) }) !== undefined, true)
})

// ---------------------------------------------------------------------------
// client：提示词注入
// ---------------------------------------------------------------------------

test('未选技能时提示词逐字不变（零变化底线）', () => {
  const prompt = '你是“个人工作台”的任务执行助手。'
  assert.equal(withSkillPromptBlock(prompt, []), prompt)
  assert.equal(withSkillPromptBlock(prompt, ['  ', '']), prompt)
  assert.equal(buildSkillPromptBlock([]), '')
})

test('选中的技能以加载指令前置注入，且不内联技能正文', () => {
  const prompt = '默认提示词正文'
  const merged = withSkillPromptBlock(prompt, ['vision-skills', 'brainstorming'])
  assert.equal(merged.endsWith(prompt), true)
  assert.equal(merged.includes('- vision-skills'), true)
  assert.equal(merged.includes('- brainstorming'), true)
  assert.equal(merged.includes('skill 工具'), true)
  // 不内联正文：不应出现技能文件路径或正文标记
  assert.equal(merged.includes('<skill_content'), false)
})

test('技能名去空并保持用户选择顺序', () => {
  const block = buildSkillPromptBlock(['b', ' a ', ''])
  assert.equal(block.includes('- b\n- a'), true)
})

test('注入文案逐字固定（前端与用户预期契约）', () => {
  assert.equal(
    buildSkillPromptBlock(['vision-skills', 'brainstorming']),
    [
      '本次会话需要先加载以下 Skill，并严格按它们的指引执行：',
      '- vision-skills',
      '- brainstorming',
      '请先调用 skill 工具逐个加载（skill(name="<技能名>")），再开始下面的工作；若某个技能加载失败，请在回复里如实说明并继续。',
    ].join('\n'),
  )
})

test('指令块前置到提示词最前面，原有正文原样保留', () => {
  const prompt = '你是“个人工作台”的任务执行助手。\n\n任务 id：t1'
  const merged = withSkillPromptBlock(prompt, ['genui'])
  assert.equal(merged, `${buildSkillPromptBlock(['genui'])}\n\n${prompt}`)
  assert.equal(merged.endsWith(prompt), true)
})
