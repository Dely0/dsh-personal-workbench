/**
 * AX-R07 / AX-R08（接线部分）：10 个 mode 的**同一角色选择路径**、默认提示词逐字不变、
 * 正文不内联、复用不吞选择（D13-B / requirements §6.3、§6.4）。
 *
 * ## 为什么这里既有"纯函数断言"又有"源码扫描"
 *
 * - "选择 → 沿用还是新建会话"是一张决策表（三态 × 有无绑定），它必须住在纯模块里才可测
 *   （`client/personaPicker.ts`）—— 所以这里逐条驱动它；
 * - 但"**接线有没有真的把它接上**"只能扫源码证明：`index.tsx` 5916 行、没有转译器，
 *   跑不动。扫描断言刻意**只按符号/片段**，不写行号（本项目明确禁止脆行号断言）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildPersonaPromptBlock, withPersonaPromptBlock } from '../lib/client/personaPrompt.js'
import {
  INHERIT_PERSONA, NO_PERSONA, decidePersonaReuse, groupPersonas, personaCommonSection, personaFlagPatch,
  personaIdToBind, personaMoreList, personaPickerList, personaSelectionFor, personaSelectionLabel, personaSourceLabel,
} from '../lib/client/personaPicker.js'
import { buildSkillPromptBlock, withSkillPromptBlock } from '../lib/client/skillPrompt.js'
import { personaGroupLabel } from '../lib/shared/persona.js'

/** ⚠️ 行尾归一化：Windows 检出是 CRLF，下面所有片段都按 `\n` 写。 */
const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const indexSource = read('src/client/index.tsx')
/**
 * D17/P6-3：AI 会话域（`startAISession` / `reuseAiSessionId` / 提示词拼装 / 角色与技能复位）
 * 已搬进这个 hook。**判据跟着 owner 走**：正向断言改扫新家，入口侧只留"装配点还在"。
 */
const aiHookSource = read('src/client/hooks/useWorkbenchAISessions.ts')
const stylesSource = read('src/client/styles.ts')
const pickerSource = read('src/client/personaPicker.ts')
const promptSource = read('src/client/personaPrompt.ts')
const librarySource = read('src/personas/library.ts')
const sharedPersonaSource = read('src/shared/persona.ts')
const componentSource = read('src/client/components/PersonaPicker.tsx')
/** D17/P7-2：四段 JSX 搬进 app/ —— 提示词弹窗在 overlays、快速录入弹窗在 dialogs。 */
const overlaysSource = read('src/client/app/WorkbenchOverlays.tsx')
const dialogsSource = read('src/client/app/WorkbenchDialogs.tsx')
const appUiSource = [overlaysSource, dialogsSource].join('\n')

/** 去掉注释：避免"注释里提到某个写法"被当成实现。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1')
}

// ---------------------------------------------------------------------------
// AX-R07：提示词块
// ---------------------------------------------------------------------------

test('AX-R07 未选角色时最终提示词**逐字不变**（角色块与技能块都为空）', () => {
  const original = '你是“个人工作台”的任务执行助手。\n请完成下面这个任务。'
  assert.equal(buildPersonaPromptBlock(''), '')
  assert.equal(buildPersonaPromptBlock('   '), '')
  assert.equal(withPersonaPromptBlock(original, ''), original)
  assert.equal(withPersonaPromptBlock(original, '   '), original)
  // 调用点的实际拼法（两层都为空时逐字等于原提示词）
  assert.equal(withPersonaPromptBlock(withSkillPromptBlock(original, []), ''), original)
})

test('AX-R07 角色块只放 ID + 加载指令：**不含正文**，且指向两个工具', () => {
  const block = buildPersonaPromptBlock('rf/rf-天线测量专家')
  assert.match(block, /rf\/rf-天线测量专家/)
  assert.match(block, /workbench_load_persona/)
  assert.match(block, /不要声称角色已经生效/)
  assert.match(block, /不能覆盖任务策略、安全规范或用户指令/)
  /** 长度上限：它是一行"告知 + 指令"，不是正文搬运。 */
  assert.ok(block.length < 400, `角色块必须很短，实际 ${block.length} 字符`)
  // 正文不可能出现在这里：函数只收一个 id，没有第二个入参
  assert.equal(buildPersonaPromptBlock.length, 1)
  assert.doesNotMatch(promptSource, /document\.body/, '提示词模块不得读角色正文')
})

test('AX-R07 顺序：角色块在技能块**之前**（先说明身份，再要求加载技能）', () => {
  const prompt = '正文任务描述'
  /**
   * ⚠️ 两个函数都是"往前面拼"，所以嵌套与最终顺序**相反**：
   * 先 `withSkillPromptBlock`（贴到正文前），再 `withPersonaPromptBlock`（贴到最前面）。
   */
  const composed = withPersonaPromptBlock(withSkillPromptBlock(prompt, ['dsh-plugin-change']), 'x/y')
  const personaAt = composed.indexOf('本次会话已绑定角色')
  const skillAt = composed.indexOf(buildSkillPromptBlock(['dsh-plugin-change']))
  const bodyAt = composed.indexOf(prompt)
  assert.ok(personaAt === 0, '角色块必须在最前面')
  assert.ok(skillAt > personaAt, `技能块必须在角色块之后：persona@${personaAt} skill@${skillAt}`)
  assert.ok(bodyAt > skillAt, '正文最后')
  // 调用点也必须是这个嵌套（不是反过来）—— 调用点随 `startAISession` 进了 AI 会话域（P6-3）
  assert.match(stripComments(aiHookSource), /withPersonaPromptBlock\(withSkillPromptBlock\(/)
})

// ---------------------------------------------------------------------------
// AX-R07：10 个 mode 的同一选择路径
// ---------------------------------------------------------------------------

test('AX-R07 十个 mode 共用同一角色选择路径：9 个走提示词弹窗 + 澄清走快速录入', () => {
  /**
   * ⚠️ P6-3：`startAISession` / `reuseAiSessionId`（mode 联合与两个角色来源）已搬进 AI 会话域 hook。
   * 判据跟着 owner 走：这一段扫 hook；"两个弹窗各挂一个 `<PersonaPicker>`"仍是装配层的事，扫入口。
   */
  const code = stripComments(aiHookSource)
  const entry = stripComments(indexSource)
  // mode 联合类型仍是这 10 个（没有被改动）
  const union = /'clarify' \| 'consult' \| 'breakdown' \| 'execute' \| 'review' \| 'plan' \| 'report' \| 'idea_association' \| 'idea_brainstorm' \| 'knowledge_doc'/
  assert.match(code, union, 'startAISession 的 mode 联合必须仍是 10 个')
  assert.equal((code.match(new RegExp(union.source, 'g')) ?? []).length >= 2, true, 'reuseAiSessionId 与 startAISession 共用同一联合')
  // 角色来源只有两处（提示词弹窗 + 快速录入），不是十个 mode 各判一遍
  assert.match(code, /const personaChoice = promptInput\.persona \?\? INHERIT_PERSONA/)
  assert.match(code, /persona: clarifyOptions\.persona \?\? INHERIT_PERSONA/)
  assert.equal((code.match(/INHERIT_PERSONA/g) ?? []).length >= 3, true, '默认值必须是「未指定」而不是某个角色')
  // 两个入口都渲染同一个组件（装配层）
  assert.equal((appUiSource.match(/<PersonaPicker/g) ?? []).length, 2,
    '提示词弹窗 + 快速录入弹窗各一个（同一个组件；D17/P7-2 起在 app/WorkbenchOverlays.tsx 与 app/WorkbenchDialogs.tsx）')
  assert.equal((entry.match(/<PersonaPicker/g) ?? []).length, 0, '入口不再装配（P7-2 后 JSX 全在 app/）')
  /**
   * D17/P7-3：入口的 `import { PersonaPicker } …` 是死 import，已随死代码清理删掉；
   * 组件的两个来源改为两个装配层文件各一处（同一个组件、同一份实现）。
   */
  assert.equal((overlaysSource.match(/from '\.\.\/components\/PersonaPicker\.js'/g) ?? []).length, 1,
    '提示词弹窗的来源只有一个 import（app/WorkbenchOverlays.tsx）')
  assert.equal((dialogsSource.match(/from '\.\.\/components\/PersonaPicker\.js'/g) ?? []).length, 1,
    '快速录入弹窗的来源只有一个 import（app/WorkbenchDialogs.tsx）')
  assert.equal((entry.match(/from '\.\.\/components\/PersonaPicker\.js'/g) ?? []).length, 0,
    '入口不再 import 该组件（P7-3 清理死 import，不是放宽：两个来源由上面两句盯 owner）')
})

test('AX-R07 技能选择器与角色选择器**不遮挡**：角色块无绝对定位，且渲染在技能块之前', () => {
  // 组件与样式里不许出现绝对定位（那才会盖住下面的技能栏）
  const personaCss = stylesSource.split('\n').filter((line) => line.includes('.wb-persona-')).join('\n')
  assert.ok(personaCss.length > 0, '角色选择器的样式必须存在')
  assert.doesNotMatch(personaCss, /position:\s*(absolute|fixed)/, '角色选择器不得绝对定位（会遮挡技能栏）')
  assert.doesNotMatch(componentSource, /position:\s*(absolute|fixed)/)
  // 提示词弹窗里：PersonaPicker 在技能选择器之前（同一文档流，先角色后技能）
  // D17/P7-2：提示词弹窗的 JSX 在 app/WorkbenchOverlays.tsx ⇒ 顺序断言跟着 owner 走。
  const modalAt = overlaysSource.indexOf('{promptModal !== null && (')
  const personaAt = overlaysSource.indexOf('<PersonaPicker', modalAt)
  const skillAt = overlaysSource.indexOf('<SkillPicker', modalAt)
  assert.ok(modalAt > 0 && personaAt > modalAt, '提示词弹窗里必须有角色选择器')
  assert.ok(skillAt > personaAt, `角色选择器必须渲染在技能选择器之前：persona@${personaAt} skill@${skillAt}`)
  // 角色块与技能块都不内联正文（拼装点已进 AI 会话域）
  assert.doesNotMatch(stripComments(aiHookSource), /withPersonaPromptBlock\([^)]*body/)
})

test('AX-R07 每次打开快速录入都把角色复位成「未指定」（上一次的选择不会静默继承）', () => {
  const code = stripComments(indexSource)
  const openAt = code.indexOf('const openQuickEntry = ')
  /**
   * 函数体的结束标记**不锚任何会随批次搬走的语句**：拆分前这里锚的是 `setShowQuick(true)`，
   * 而 D17/P6-2 把「打开弹窗」那一半搬进了快速录入域 hook，那行字在入口就没了（本条判据由此变红）。
   * 改成"从函数起点起第一个行首两空格的收尾大括号"。
   */
  const openEnd = code.indexOf('\n  }\n', openAt)
  assert.ok(openAt > 0 && openEnd > openAt, '必须能找到 openQuickEntry 的函数体')
  const body = code.slice(openAt, openEnd)
  // 打开弹窗那一半交给快速录入域（P6-2）
  assert.match(body, /openIntake\(\)/, '打开弹窗必须走快速录入域的 openIntake')
  /**
   * 角色复位这一半 P6-3 已收进 AI 会话域（`resetClarifyPicker()`）：入口只剩调用，
   * 复位本体改扫那个 hook —— 这是"判据跟着 owner 走"，不是放宽。
   */
  assert.match(body, /resetClarifyPicker\(\)/, '打开弹窗时必须走 AI 会话域的角色复位动作')
  const aiCode = stripComments(aiHookSource)
  assert.match(aiCode, /setQuickPersona\(INHERIT_PERSONA\)/, '角色复位必须把选择置回「未指定」')
  // 提示词弹窗同理（askUserPrompt 里复位）—— 它也在同一个 hook 里
  const askAt = aiCode.indexOf('const askUserPrompt = ')
  const askEnd = aiCode.indexOf('const confirmPrompt = ', askAt)
  assert.ok(askAt > 0 && askEnd > askAt, '必须能找到 askUserPrompt 的函数体（结构变了就要同步这条断言）')
  assert.match(aiCode.slice(askAt, askEnd), /setPromptPersona\(INHERIT_PERSONA\)/)
})

// ---------------------------------------------------------------------------
// AX-R08：复用分流（决策表）
// ---------------------------------------------------------------------------

const binding = (personaId, sourceKey = 'external:aaaa') => ({ personaId, sourceKey, revision: 'r'.repeat(64) })

const REUSE_CASES = [
  { name: '未指定 + 已有绑定 → 沿用（默认动作，绝不能打断既有复用）', selection: INHERIT_PERSONA, current: binding('rf/甲'), want: 'reuse' },
  { name: '未指定 + 没有绑定 → 沿用（新会话等于无角色）', selection: INHERIT_PERSONA, current: null, want: 'reuse' },
  { name: '明确无角色 + 没有绑定 → 沿用（本来就没角色，没有变化）', selection: NO_PERSONA, current: null, want: 'reuse' },
  { name: '明确无角色 + 已有绑定 → 新建会话（角色被显式去掉）', selection: NO_PERSONA, current: binding('rf/甲'), want: 'new-session' },
  { name: '明确同一角色（同来源）→ 沿用', selection: personaSelectionFor('rf/甲', 'external:aaaa'), current: binding('rf/甲'), want: 'reuse' },
  { name: '明确同一角色但**来源已不同** → 新建会话（改外部根 = 换身份，§6.1）', selection: personaSelectionFor('rf/甲', 'external:bbbb'), current: binding('rf/甲'), want: 'new-session' },
  { name: '明确另一个角色 → 新建会话（旧绑定保持不变）', selection: personaSelectionFor('rf/乙', 'external:aaaa'), current: binding('rf/甲'), want: 'new-session' },
  { name: '明确角色 + 该会话原本没角色 → 新建会话（无 → 有也是换角色）', selection: personaSelectionFor('rf/甲', 'external:aaaa'), current: null, want: 'new-session' },
  { name: 'Windows 口径：大小写不同视为同一角色 → 沿用', selection: personaSelectionFor('RF/甲', 'external:aaaa'), current: binding('rf/甲'), want: 'reuse', platform: 'win32' },
  { name: 'POSIX 口径：大小写不同是不同角色 → 新建会话', selection: personaSelectionFor('RF/甲', 'external:aaaa'), current: binding('rf/甲'), want: 'new-session', platform: 'linux' },
]

for (const item of REUSE_CASES) {
  test(`AX-R08 ${item.name}`, () => {
    const decision = decidePersonaReuse(item.selection, item.current, item.platform ?? 'win32')
    assert.equal(decision.action, item.want, `实际：${JSON.stringify(decision)}`)
    if (item.want === 'new-session') {
      assert.match(decision.notice, /新建会话/, '新建会话必须**显式告知**')
      assert.match(decision.notice, /旧会话/, '必须说清旧会话与旧绑定不变')
    }
  })
}

test('AX-R08 未指定（默认）永不产生"新建会话"：这是复用不被吞掉的底线', () => {
  for (const current of [null, binding('rf/甲'), binding('其他')]) {
    const decision = decidePersonaReuse(INHERIT_PERSONA, current)
    assert.equal(decision.action, 'reuse', `未指定 + ${JSON.stringify(current)} 必须沿用`)
    assert.equal(decision.reason, 'inherit')
  }
})

test('AX-R08 新建会话时绑定的是"用户明确选的角色"；未指定/无角色不写绑定', () => {
  assert.equal(personaIdToBind(INHERIT_PERSONA), '')
  assert.equal(personaIdToBind(NO_PERSONA), '')
  assert.equal(personaIdToBind(personaSelectionFor('rf/甲', 'external:aaaa')), 'rf/甲')
})

test('AX-R08 接线：复用判定吃角色选择，且绑定写在 prompt **之前**', () => {
  /** P6-3：这一整段（`reuseAiSessionId` 的调用点与绑定顺序）随 `startAISession` 进了 AI 会话域 hook。 */
  const code = stripComments(aiHookSource)
  assert.match(code, /reuseAiSessionId\(mode, text, planAnchor, personaChoice\)/, '复用判定必须拿到用户选择')
  assert.match(code, /if \(reuse\.kind === 'reuse'\)/, '早退只发生在判据说"可以沿用"时')
  const reuseBlock = code.slice(code.indexOf('const reuse = await reuseAiSessionId'), code.indexOf('const ws = safeService'))
  assert.match(reuseBlock, /console\.warn\(`\[workbench\] \$\{reuse\.notice\}`\)/, '换角色新建会话必须留下可读告知')
  // 顺序：先 POST bind，再 session.prompt
  const bindAt = code.indexOf("'/api/workbench/personas/bind'")
  const promptAt = code.indexOf('sessionRef.session.prompt(')
  assert.ok(bindAt > 0 && promptAt > 0, '绑定与 prompt 调用都必须存在')
  assert.ok(bindAt < promptAt, '绑定必须发生在首次 prompt 之前（AX-R04）')
  // 绑定失败必须抛错（不能照常发 prompt）
  const bindBlock = code.slice(bindAt, promptAt)
  assert.match(bindBlock, /throw new Error\(`角色「\$\{personaId\}」绑定未生效/, '绑定没生效必须中断，不能假装有角色')
  // 装配层不许留第二份（判据跟着 owner 走）
  assert.doesNotMatch(stripComments(indexSource), /reuseAiSessionId\(/, '入口不再直接判复用')
})

// ---------------------------------------------------------------------------
// 选择器列表口径（收藏/启用/搜索）
// ---------------------------------------------------------------------------

const summary = (over) => ({
  id: 'x', name: 'X', description: '', descriptionTruncated: false, group: '其他', mode: '', emoji: '',
  source: 'builtin', sourceKey: 'builtin', enabled: true, favorite: false, revision: 'a'.repeat(64), ...over,
})

test('AX-R07 常用区：有收藏用收藏；一个收藏都没有时退回内置角色', () => {
  const personas = [
    summary({ id: 'builtin/实现者', source: 'builtin' }),
    summary({ id: 'ext/甲', source: 'external', favorite: true }),
  ]
  const withFavorite = personaCommonSection(personas)
  assert.deepEqual(withFavorite.items.map((item) => item.id), ['ext/甲'])
  assert.equal(withFavorite.fallback, false)
  const noFavorite = personaCommonSection(personas.map((item) => ({ ...item, favorite: false })))
  assert.deepEqual(noFavorite.items.map((item) => item.id), ['builtin/实现者'], '没有收藏时展示内置角色')
  assert.equal(noFavorite.fallback, true)
  // 停用的角色不进常用区（哪怕收藏了）
  const disabledFavorite = personaCommonSection([summary({ id: 'ext/乙', source: 'external', favorite: true, enabled: false })])
  assert.deepEqual(disabledFavorite.items, [])
})

test('AX-R07 更多角色：停用的角色**仍然列出来**（否则"启用"没有出口）', () => {
  const personas = [
    summary({ id: 'a/启用', enabled: true }),
    summary({ id: 'b/停用', enabled: false }),
    summary({ id: 'c/启用2', enabled: true }),
  ]
  const list = personaMoreList(personas, '')
  assert.equal(list.length, 3, '停用项也必须可检索到')
  assert.deepEqual(list.map((item) => item.id), ['a/启用', 'c/启用2', 'b/停用'], '启用在前、停用在后')
  assert.deepEqual(personaMoreList(personas, '停用').map((item) => item.id), ['b/停用'])
  assert.deepEqual(personaMoreList(personas, '不存在'), [])
  // 界面里禁用的项不可选中（源码级）
  assert.match(componentSource, /disabled=\{disabled \|\| persona\.enabled === false\}/)
})

test('AX-R07 收藏/启用的写入口径：只提交被改动的那一个数组', () => {
  const current = { personaFavorites: ['a'], personaDisabledIds: ['b'] }
  assert.deepEqual(personaFlagPatch(current, 'toggle-favorite', 'c'), { personaFavorites: ['a', 'c'] })
  assert.deepEqual(personaFlagPatch(current, 'toggle-favorite', 'a'), { personaFavorites: [] })
  assert.deepEqual(personaFlagPatch(current, 'toggle-disabled', 'b'), { personaDisabledIds: [] })
  assert.deepEqual(personaFlagPatch(current, 'toggle-disabled', 'd', 'win32'), { personaDisabledIds: ['b', 'd'] })
  // 大小写口径：Windows 上同一个 id 只留一份
  assert.deepEqual(personaFlagPatch(current, 'toggle-favorite', 'A', 'win32'), { personaFavorites: [] })
})

// ---------------------------------------------------------------------------
// 2026-10-01 按用户带截图的反馈重做选择器形态
// ---------------------------------------------------------------------------

test('选择器列表口径只有一处：搜索 + 「只看收藏」筛选（personaPickerList）', () => {
  const personas = [
    summary({ id: 'a/实现者', favorite: true, enabled: true }),
    summary({ id: 'b/审查者', favorite: false, enabled: true }),
    summary({ id: 'c/停用的', favorite: true, enabled: false }),
  ]
  assert.deepEqual(personaPickerList(personas, '').map((item) => item.id), ['a/实现者', 'b/审查者', 'c/停用的'], '默认=全部，启用在前')
  assert.deepEqual(personaPickerList(personas, '', { favoritesOnly: true }).map((item) => item.id), ['a/实现者', 'c/停用的'], '只看收藏（停用的也留着，否则启用没出口）')
  assert.deepEqual(personaPickerList(personas, '审查').map((item) => item.id), ['b/审查者'], '搜索命中名称')
  assert.deepEqual(personaPickerList(personas, '实现', { favoritesOnly: true }).map((item) => item.id), ['a/实现者'], '搜索与筛选叠加')
  assert.deepEqual(personaPickerList(personas, '不存在').map((item) => item.id), [])
})

test('选择器：搜索常驻、没有「更多角色」按钮、收藏/停用动作不在选择器里', () => {
  /**
   * ⚠️ 先剥注释：本组件的文档注释里**故意**写了"删掉「更多角色」按钮"这类句子，
   * 不剥就会把注释当代码扫出假红（本仓踩过两次，规矩是"扫描前剥注释"）。
   */
  const code = componentSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.doesNotMatch(code, /expanded/, '「更多角色」那套展开态必须删掉')
  assert.match(code, /wb-persona-toolbar/, '搜索框常驻在工具栏里')
  assert.match(code, /只看收藏/, '要有「只看收藏」筛选按钮')
  assert.match(code, /personaPickerList\(/, '列表口径走纯函数')
  assert.doesNotMatch(code, /personaFlagPatch|persona-flag/, '收藏/停用必须搬走，选择器里不许再有写入口')
  assert.doesNotMatch(code, /更多角色/, '「更多角色」按钮删掉')
})

test('设置页承接收藏/停用：唯一写入口径仍是 personaFlagPatch，且写前现读服务端现值', () => {
  const adminSource = read('src/client/components/PersonaAdmin.tsx')
  const settingsSource = read('src/client/components/SettingsModal.tsx')
  assert.match(settingsSource, /<PersonaAdmin/, '设置页必须挂上角色库管理')
  assert.match(adminSource, /personaFlagPatch\(/, '写入口径与选择器共用同一个纯函数')
  assert.match(adminSource, /\/api\/workbench\/settings/, '通过设置接口写')
  const beforePatch = adminSource.slice(0, adminSource.indexOf('personaFlagPatch('))
  assert.match(beforePatch, /api\/workbench\/settings'\)/, '改动前先读服务端现值（不许拿本地副本算 patch）')
})

test('分组 / 标签：分组按展示顺序排、显示名是中文、来源标签可读', () => {
  const personas = [summary({ id: 'rf/a', group: 'rf' }), summary({ id: 'rf/b', group: 'rf' }), summary({ id: 'dn/c', group: 'dotnet' })]
  const groups = groupPersonas(personas)
  assert.deepEqual(groups.map((group) => group.group), ['rf', 'dotnet'])
  assert.deepEqual(groups[0].items.map((item) => item.id), ['rf/a', 'rf/b'])
  assert.equal(personaSourceLabel('builtin'), '内置')
  assert.equal(personaSourceLabel('external'), '外部目录')
  assert.equal(personaSelectionLabel(INHERIT_PERSONA), '未指定（沿用该会话原有角色）')
  assert.equal(personaSelectionLabel(NO_PERSONA), '无角色')
  assert.equal(personaSelectionLabel(personaSelectionFor('rf/a', 'builtin'), [summary({ id: 'rf/a', name: '甲', emoji: '📡' })]), '📡 甲')
  assert.match(personaSelectionLabel(personaSelectionFor('gone/x', 'builtin'), []), /已不在角色库里/)
})

test('内置角色分两个来源区：显示名是中文（不泄漏目录名），顺序通用在前、领域在后', () => {
  /**
   * 2026-10-01：内置角色分 `generic/`（自写通用）与 `domain/`（领域岗位）两个来源区。
   * 目录名是**仓库内部的组织方式**，不该原样出现在中文界面上（用户看到"domain 9 个角色"
   * 既不像中文也不知道那是什么），而纯字典序又会把领域排在通用之前。
   *
   * 判据盯三件事：① 显示名是中文；② 通用在前；③ **原始分组键不许被改**
   * （它是收藏/停用/会话绑定记录里的持久键，为了好看改它会让既有记录全部失配）。
   */
  const personas = [
    summary({ id: 'domain/rf-天线测量专家', group: 'domain' }),
    summary({ id: 'generic/engineering/实现者', group: 'generic' }),
  ]
  const groups = groupPersonas(personas)
  assert.deepEqual(groups.map((g) => g.label), ['通用工作方式', '领域岗位'], '显示名必须是中文且通用在前')
  assert.deepEqual(groups.map((g) => g.group), ['generic', 'domain'], '原始分组键一个都不许改（持久键）')
  // 表外的分组名原样返回（用户自己的用户库/外部目录可以有任意分组名，不许被吞掉或改写成"其他"）
  assert.equal(personaGroupLabel('我的私有分组'), '我的私有分组')
  assert.equal(groupPersonas([summary({ id: 'x/y', group: '我的私有分组' })])[0].label, '我的私有分组')
  // 表外组名排在表内之后
  const mixed = groupPersonas([summary({ id: 'z/z', group: 'zzz' }), summary({ id: 'g/x', group: 'generic' })])
  assert.deepEqual(mixed.map((g) => g.group), ['generic', 'zzz'], '表外的组名排最后')
})

// ---------------------------------------------------------------------------
// 唯一实现（不许有第二份比较/去重）
// ---------------------------------------------------------------------------

test('平台比较/去重只有一份实现（shared/persona.ts），library.ts 只再导出', () => {
  assert.match(sharedPersonaSource, /export function personaCompareKey\(/)
  assert.match(sharedPersonaSource, /export function dedupeByPersonaKey\(/)
  assert.doesNotMatch(stripComments(librarySource), /function personaCompareKey\(/, 'library.ts 不得再实现一份')
  assert.doesNotMatch(stripComments(librarySource), /function dedupeByPersonaKey\(/, 'library.ts 不得再实现一份')
  assert.match(librarySource, /export \{ personaCompareKey, dedupeByPersonaKey \}/)
  // 客户端不许自己写一遍小写折叠
  assert.doesNotMatch(stripComments(pickerSource), /toLowerCase\(\)\s*$/, '比较必须走共享实现')
})

test('浏览器安全：客户端打包的模块里不得出现 `= process.platform`（浏览器没有 process）', () => {
  /**
   * 这个模块同时进服务端与**客户端 bundle**（同一把比较尺子）。默认参数写成
   * `platform = process.platform` 会让浏览器在**每次点开 AI 会话入口时**抛
   * `ReferenceError: process is not defined` —— 整块功能打不开。
   * 唯一允许出现 `process.platform` 的地方是带存在性判断的 `defaultPersonaPlatform()`。
   */
  const clientBundled = ['src/shared/persona.ts', 'src/client/personaPicker.ts', 'src/client/personaPrompt.ts']
  for (const file of clientBundled) {
    const source = stripComments(read(file))
    assert.doesNotMatch(source, /=\s*process\.platform/, `${file} 不得用 process.platform 当默认参数`)
  }
  assert.match(stripComments(sharedPersonaSource), /typeof process !== 'undefined'/, '必须显式判 process 是否存在')
  /** 允许出现 `process.platform` 的**唯一**位置就是那个带存在性判断的 helper。 */
  const source = stripComments(sharedPersonaSource)
  const helperAt = source.indexOf('export function defaultPersonaPlatform')
  const helperEnd = source.indexOf('export function personaCompareKey', helperAt)
  assert.ok(helperAt > 0 && helperEnd > helperAt, '必须能找到 defaultPersonaPlatform 的边界')
  const inHelper = (source.slice(helperAt, helperEnd).match(/process\.platform/g) ?? []).length
  assert.ok(inHelper > 0, 'helper 里必须有真实的平台读取')
  assert.equal((source.match(/process\.platform/g) ?? []).length, inHelper, 'process.platform 只允许出现在 defaultPersonaPlatform 里')
})

test('浏览器安全（运行时）：把 process 抹掉后，默认平台口径仍然工作', async () => {
  const shared = await import('../lib/shared/persona.js')
  const saved = globalThis.process
  try {
    // 模拟浏览器：`process` 不存在（typeof 判据必须能拦住，而不是抛异常）
    globalThis.process = undefined
    assert.equal(shared.personaCompareKey('A/B'), 'a/b', '拿不到平台时退回大小写不敏感')
    assert.equal(shared.dedupeByPersonaKey(['a', 'A']).length, 1)
    assert.equal(shared.samePersonaIdentity({ personaId: 'A', sourceKey: 'builtin' }, { personaId: 'a', sourceKey: 'builtin' }), true)
  } finally {
    globalThis.process = saved
  }
  assert.equal(shared.personaCompareKey('A/B', 'linux'), 'A/B', '服务端仍按真实平台走大小写敏感')
})

test('"选中的角色"判定只有一处：decidePersonaReuse 在纯模块里，组件不自己判', () => {
  assert.match(stripComments(pickerSource), /export function decidePersonaReuse\(/)
  assert.doesNotMatch(stripComments(componentSource), /decidePersonaReuse|reuseAiSessionId/, '选择器组件不判复用（它只回调选择）')
  // P6-3：唯一调用点随 `reuseAiSessionId` 搬进 AI 会话域 hook —— 仍然只允许一处
  const aiCode = stripComments(aiHookSource)
  assert.match(aiCode, /decidePersonaReuse\(persona, binding\)/)
  assert.equal((aiCode.match(/decidePersonaReuse\(/g) ?? []).length, 1, '调用点只允许一处')
  assert.equal((stripComments(indexSource).match(/decidePersonaReuse\(/g) ?? []).length, 0, '入口不许留第二处')
})
