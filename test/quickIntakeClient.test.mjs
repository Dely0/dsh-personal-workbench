/**
 * 快速录入客户端纯逻辑的单测（v1.15.1）：附件分类、澄清提示词、模型收图判定。
 *
 * 这三块都是"用户能立刻感觉到、但很容易静默写错"的地方：
 * - 不收的文件**必须带原因回显**（本项目规范第 7 条：静默丢件是禁区）；
 * - 提示词里**必须**带预分配任务 id 与任务资料夹（否则资料夹规矩只在客户端生效一半）；
 * - "这个模型收不收图"的判据**必须与宿主逐条对齐**（否则会出现"我们说不收、其实收了"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildQuickIntakePrompt, isQuickAttachmentFile, isQuickDocumentFile, isQuickImageFile,
  MAX_QUICK_DOCUMENTS, MAX_QUICK_IMAGES, partitionQuickFiles, quickAttachmentSummary,
  quickTaskPlaceholder,
} from '../lib/client/quickAttachments.js'
import {
  effectiveSelection, evaluateImageSupport, gateModelPicker, indexModalities, modelKey,
} from '../lib/client/modelCapability.js'

const imageDraft = (id) => ({ id, file: { type: 'image/png', name: `${id}.png` }, previewUrl: `blob:${id}` })
const docDraft = (id, truncated = false) => ({
  id, name: `${id}.pdf`, mediaType: 'application/pdf', size: 1024, content: `正文-${id}`, truncated,
})

// ---------------------------------------------------------------- 文件分类

test('quickAttachments: 四种图片 MIME + PDF/DOCX 才收，其余不收', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    assert.equal(isQuickImageFile({ type, name: `a.${type.slice(6)}` }), true, type)
  }
  assert.equal(isQuickImageFile({ type: 'image/bmp', name: 'a.bmp' }), false)
  assert.equal(isQuickImageFile({ type: 'image/svg+xml', name: 'a.svg' }), false, 'SVG 是脚本载体，绝不收')
  assert.equal(isQuickDocumentFile({ type: 'application/pdf', name: 'a.pdf' }), true)
  assert.equal(isQuickDocumentFile({ type: '', name: 'a.DOCX' }), true, '有些浏览器给不出 MIME，靠扩展名兜底')
  assert.equal(isQuickDocumentFile({ type: 'text/plain', name: 'a.txt' }), false)
  assert.equal(isQuickAttachmentFile({ type: 'text/plain', name: 'a.txt' }), false)
})

test('quickAttachments: 不收的文件带**可读原因**，绝不静默丢弃', () => {
  const partition = partitionQuickFiles([
    { type: 'image/png', name: 'ok.png' },
    { type: 'text/plain', name: 'readme.txt' },
    { type: 'application/x-msdownload', name: 'evil.exe' },
  ])
  assert.equal(partition.images.length, 1)
  assert.equal(partition.documents.length, 0)
  assert.equal(partition.rejected.length, 2, '两个不收的文件都要出现在 rejected 里')
  for (const item of partition.rejected) {
    assert.ok(item.name !== '', '原因里要点名是哪个文件')
    assert.match(item.reason, /只支持|超过|最多/, `原因必须说清为什么：${item.reason}`)
  }
})

test('quickAttachments: 图片/文档分别计数、分别限流（超限也给原因）', () => {
  const existing = [...Array.from({ length: MAX_QUICK_IMAGES }, (_, i) => imageDraft(`img${i}`)), docDraft('doc0')]
  const partition = partitionQuickFiles([
    { type: 'image/png', name: 'one-too-many.png' },
    { type: 'application/pdf', name: 'ok.pdf' },
  ], existing)
  assert.equal(partition.images.length, 0)
  assert.equal(partition.rejected[0].name, 'one-too-many.png')
  assert.match(partition.rejected[0].reason, new RegExp(`最多 ${MAX_QUICK_IMAGES} 张`))
  assert.equal(partition.documents.length, 1, `文档还没到 ${MAX_QUICK_DOCUMENTS} 份，应该收下`)

  const full = partitionQuickFiles([{ type: 'application/pdf', name: 'x.pdf' }],
    Array.from({ length: MAX_QUICK_DOCUMENTS }, (_, i) => docDraft(`d${i}`)))
  assert.equal(full.documents.length, 0)
  assert.match(full.rejected[0].reason, new RegExp(`最多 ${MAX_QUICK_DOCUMENTS} 份`))
})

test('quickAttachments: 客户端先按 5MB 拦一次超大文档（不让用户白等上传）', () => {
  const partition = partitionQuickFiles([{ type: 'application/pdf', name: 'huge.pdf', size: 6 * 1024 * 1024 }])
  assert.equal(partition.documents.length, 0)
  assert.match(partition.rejected[0].reason, /超过 5MB/)
})

// ---------------------------------------------------------------- 提示词

test('quickAttachments: 附件说明按类型计数，图片 + 文档都要说出来', () => {
  assert.equal(quickAttachmentSummary([]), '')
  assert.match(quickAttachmentSummary([imageDraft('a')]), /1 张图片/)
  assert.match(quickAttachmentSummary([docDraft('a')]), /1 份 PDF\/DOCX 文档/)
  const both = quickAttachmentSummary([imageDraft('a'), imageDraft('b'), docDraft('c')])
  assert.match(both, /2 张图片/)
  assert.match(both, /1 份 PDF\/DOCX 文档/)
  assert.match(both, /description/, '要引导 AI 把附件要点写进 description')
})

test('quickAttachments: 没有文字但有附件时不留空（否则 AI 会瞎猜）', () => {
  assert.equal(quickTaskPlaceholder('  接待客户  ', []), '接待客户')
  assert.equal(quickTaskPlaceholder('', [imageDraft('a')]), '（见附件图片）')
  assert.equal(quickTaskPlaceholder('', [docDraft('a')]), '（见附件文档）')
  assert.equal(quickTaskPlaceholder('', [imageDraft('a'), docDraft('b')]), '（见附件图片和文档）')
  assert.equal(quickTaskPlaceholder('', []), '（未提供内容）')
})

test('quickAttachments: 澄清提示词必须带上预分配任务 id、任务资料夹与模型', () => {
  const prompt = buildQuickIntakePrompt({
    taskText: '周五接待重要客户',
    attachments: [imageDraft('a'), docDraft('b')],
    documentTexts: [{ name: 'b.pdf', content: '文档正文', truncated: false }],
    nowIso: '2026-09-15T00:00:00.000Z',
    workspaceRootLabel: 'D:\\Code\\proj',
    reservedTaskId: 'reserved-1234',
    taskFolderPath: 'D:\\Code\\proj\\reserved-1234-周五接待重要客户',
    taskFolderRelative: './reserved-1234-周五接待重要客户/',
    modelLabel: 'DeepSeek-V41-Flash · high',
  })
  assert.match(prompt, /周五接待重要客户/)
  assert.match(prompt, /reserved-1234/, '必须告诉 AI 用哪个任务 id（资料夹名与任务 id 要对上）')
  assert.match(prompt, /task_id="reserved-1234"/)
  assert.match(prompt, /workspace_path="D:\\Code\\proj\\reserved-1234-周五接待重要客户"/)
  assert.match(prompt, /任务资料夹相对路径：\.\/reserved-1234-周五接待重要客户\//)
  assert.match(prompt, /不要在工作区根目录散放文件/)
  assert.match(prompt, /DeepSeek-V41-Flash · high/)
  assert.match(prompt, /文档正文/, 'PDF/DOCX 抽出的正文要进提示词')
  assert.match(prompt, /1 张图片/)
  assert.match(prompt, /1 份 PDF\/DOCX 文档/)
})

test('quickAttachments: 没有任务资料夹时提示词不编造路径，但仍约束"别散放文件"', () => {
  const prompt = buildQuickIntakePrompt({
    taskText: '随手记一笔',
    attachments: [],
    documentTexts: [],
    nowIso: '2026-09-15T00:00:00.000Z',
    workspaceRootLabel: '当前连接工作区',
    reservedTaskId: 'reserved-1',
    taskFolderPath: '',
    taskFolderRelative: '',
    modelLabel: '跟随 DSH 默认模型',
  })
  assert.equal(/workspace_path=/.test(prompt), false, '没有资料夹时不能传 workspace_path')
  assert.equal(/任务资料夹：/.test(prompt), false, '没有资料夹时不要在提示词里编一个')
  assert.match(prompt, /task_id="reserved-1"/)
  assert.match(prompt, /如需在澄清阶段创建文件，请放在当前工作区内并说明位置/)
})

// ---------------------------------------------------------------- 模型收图判定

test('modelCapability: 判定与宿主逐条对齐（只看 inputModalities 是否含 image）', () => {
  const table = indexModalities([
    { provider: 'deepseek-official', model: 'deepseek-flash', inputModalities: ['text', 'image'] },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', inputModalities: ['text'] },
    { provider: 'deepseek-official', model: 'undeclared', inputModalities: null },
  ])
  assert.equal(modelKey('p', 'm'), 'p/m')
  assert.deepEqual(evaluateImageSupport(table, 'deepseek-official', 'deepseek-flash'), { kind: 'accepted' })

  const rejected = evaluateImageSupport(table, 'deepseek-official', 'deepseek-v4-flash')
  assert.equal(rejected.kind, 'rejected')
  assert.match(rejected.reason, /只接受文本输入/)
  assert.match(rejected.reason, /deepseek-v4-flash/)
  assert.match(rejected.reason, /占位文字/, '要说清后果：图片会被换成占位文字，AI 看不到')
  assert.match(rejected.reason, /deepseek-flash/, '要给出可照做的建议')

  // 没声明（null）→ unknown：宿主此时**原样发送**图片，我们绝不能拦
  assert.equal(evaluateImageSupport(table, 'deepseek-official', 'undeclared').kind, 'unknown')
  // 表里没有 → unknown
  assert.equal(evaluateImageSupport(table, 'other', 'whatever').kind, 'unknown')
  // 没有明确模型信息 → unknown
  assert.equal(evaluateImageSupport(table, '', '').kind, 'unknown')
})

test('modelCapability: 空能力数组（[]）判为不收图（宿主会替换成占位）', () => {
  const table = indexModalities([{ provider: 'p', model: 'm', inputModalities: [] }])
  assert.equal(evaluateImageSupport(table, 'p', 'm').kind, 'rejected')
})

test('modelCapability: effectiveSelection 先用户所选，再会话当前投影', () => {
  const quick = { provider: 'p1', model: 'm1' }
  assert.deepEqual(effectiveSelection(quick, { provider: 'p2', model: 'm2' }), quick)
  assert.deepEqual(effectiveSelection(null, { provider: 'p2', model: 'm2' }), { provider: 'p2', model: 'm2' })
  assert.equal(effectiveSelection(null, null), undefined)
  assert.equal(effectiveSelection(null, undefined), undefined)
  assert.equal(effectiveSelection({ provider: '', model: '' }, null), undefined, '空串不算"选过"')
})

// ---------------------------------------------------------------------------
// v1.15.2 回归：模型选择器"自我实现的假失败"
//
// 真实事故（用户截图："当前 DSH 未提供模型选择接口（modelDirectories）"）：
// 第一版写的是 `const directory = useMemo(() => open ? resolveModelDirectory(...) : undefined, [open, …])`，
// 而 openPicker() 用 `directory === undefined` 判"宿主没提供这个服务"、**同时**负责把 open 置真
// —— 第一次点击时 open 必然还是 false，于是判定必然报"未提供"：宿主有没有这个服务都一样。
//
// 下面两条一起守：① 判定表的输入只有"目录拿没拿到 + 有没有会话"两个事实；
// ② 扫源码，禁止"把可用性判定挂在它自己要控制的状态上"这个形态复活。
// ---------------------------------------------------------------------------

test('modelCapability: gateModelPicker 只吃两个事实，且两种原因分开说', () => {
  assert.deepEqual(gateModelPicker({ hasDirectory: true, sessionId: 'sess-1' }), { ok: true })
  // 有会话、但真的拿不到目录 → 才可以说"宿主没提供这个接口"
  const noService = gateModelPicker({ hasDirectory: false, sessionId: 'sess-1' })
  assert.equal(noService.ok, false)
  assert.match(noService.reason, /未提供模型选择接口/)
  // 会话都还没就绪时**不许**说成"宿主没提供"（那会把排查方向带偏 —— 本次的教训）
  const noSession = gateModelPicker({ hasDirectory: false, sessionId: '' })
  assert.equal(noSession.ok, false)
  assert.match(noSession.reason, /还没有可用的会话/)
  assert.equal(/未提供模型选择接口/.test(noSession.reason), false)
})

test('回归 v1.15.2：可用性判定不得依赖它自己要控制的状态（扫源码）', () => {
  /**
   * ⚠️ 必须**先去掉注释**再扫：上面那段解释性注释里就逐字引用了错误写法
   * （`open ? resolveModelDirectory(...) : undefined`），
   * 不剥注释的扫描会把自己的"反面教材"当成违规 —— 这与扫斜杠菜单那次是同一个坑。
   */
  const raw = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // 具体形态：`open ? resolveModelDirectory(...) : undefined`
  assert.equal(
    /open\s*\?\s*resolveModelDirectory/.test(source),
    false,
    '解析模型目录不许再挂在 open 上 —— 那会让"是否可用"取决于"是否已经打开"，必然假失败',
  )
  // 目录必须**无条件**解析出来，再交给 gateModelPicker 判定
  assert.match(source, /const directory = useMemo\(\s*\(\) => resolveModelDirectory\(runtime, directorySessionId\)/)
  assert.match(source, /gateModelPicker\(\{ hasDirectory: directory !== undefined, sessionId: directorySessionId \}\)/)
  // 判定分支里不许再出现 `open`（判定与开关是两件事）
  const openPickerBody = /const openPicker = \(\): void => \{([\s\S]*?)\n  \}/.exec(source)
  assert.ok(openPickerBody !== null, '没找到 openPicker 实现（改名了就要同步这条断言）')
  const head = openPickerBody[1].slice(0, openPickerBody[1].indexOf('setOpen(true)'))
  assert.equal(
    /\bopen\b/.test(head.replace(/if \(open\) \{ setOpen\(false\); return \}/, '')),
    false,
    '可用性判定分支里不许读 open —— 那正是本次假失败的成因',
  )
})
