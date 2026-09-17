/**
 * 「知识草稿静默覆盖」回归（v1.15.x，任务 f4a3430f）。
 *
 * ## 真实缺陷（2026-09-17 实测复现）
 *
 * `workbench_submit_knowledge` **按会话去重**：不带 `draft_id` 的重复调用会命中
 * 本会话那份 pending 知识草稿并**覆盖**它。去重是刻意的设计约束
 * （团队记忆 `01M2A09R4TWTG1D1S7FP0D1M3Y`），**要修的是「静默」这一半**：
 *
 * - 两次都返回成功、返回同一个 id、措辞一样（`知识草稿已保存（id=…）`），
 *   读起来像"新建了一条"；
 * - 会话里看不到草稿 id，界面也长得跟新建一样；
 * - 于是"一个会话里分多次沉淀多条独立知识 → 到界面确认一次 → 只入库了最后一次"
 *   这件事**无法察觉**。
 *
 * ## 本文件守四件事
 *
 * 1. **判定表**（`planKnowledgeDraftWrite`）：新建 / 覆盖本会话已有草稿 / 显式更新
 *    三种模式，以及历史（`revision` / `replacedTitles`）怎么累加；
 * 2. **回执措辞**（`knowledgeDraftWriteMessage`）：覆盖那一条必须写明
 *    「已更新本会话已有草稿（id: …）」「不是新建」+ 被替换的标题；
 * 3. **界面提示**（`knowledgeDraftOverwriteNotice`）：用户点确认前就看得见"这是替换"，
 *    且带草稿 id —— 这条来自**落库的 payload**，不是只改了一句文案；
 * 4. **接线**（源码级）：`tools.ts` / `DraftBanner.tsx` / `KnowledgeDraftBody.tsx`
 *    必须走上面这些唯一实现，且旧措辞（`知识草稿已保存`）不得回来。
 *
 * `planKnowledgeDraftWrite` 的输入是显式快照（不读 DOM、不读库），
 * 所以这里既能测判定表，也能在变异探针里被整段替换。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  KNOWLEDGE_DRAFT_REPLACED_TITLES_LIMIT, KNOWLEDGE_DRAFT_SESSION_CONSTRAINT,
  knowledgeDraftOverwriteNotice, knowledgeDraftWriteMessage, planKnowledgeDraftWrite,
  readKnowledgeDraftHistory, withKnowledgeDraftHistory,
} from '../lib/shared/knowledgeDraftOverwrite.js'

const toolsSource = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const bannerSource = readFileSync(new URL('../src/client/components/DraftBanner.tsx', import.meta.url), 'utf8')
const bodySource = readFileSync(new URL('../src/client/components/KnowledgeDraftBody.tsx', import.meta.url), 'utf8')

// ---------------------------------------------------------------- 判定表

test('planKnowledgeDraftWrite: 本会话没有草稿 → created（第 1 次，无替换记录）', () => {
  assert.deepEqual(
    planKnowledgeDraftWrite({ draftIdProvided: undefined, existing: undefined }),
    { mode: 'created', existingDraftId: null, revision: 1, replacedTitles: [], replacedTitle: null },
  )
})

test('planKnowledgeDraftWrite: 没传 draft_id 但本会话已有草稿 → replaced-session-draft（这就是静默覆盖）', () => {
  const plan = planKnowledgeDraftWrite({
    draftIdProvided: undefined,
    existing: { id: 'd1', payload: { title: '第一条', revision: 1, replacedTitles: [] } },
    replacedTitle: '第一条',
  })
  assert.equal(plan.mode, 'replaced-session-draft')
  assert.equal(plan.existingDraftId, 'd1')
  assert.equal(plan.revision, 2)
  assert.deepEqual(plan.replacedTitles, ['第一条'])
  assert.equal(plan.replacedTitle, '第一条')
})

test('planKnowledgeDraftWrite: 连续覆盖会累计历史（revision 递增、标题按时间先后入列）', () => {
  const first = planKnowledgeDraftWrite({ draftIdProvided: undefined, existing: undefined })
  const p1 = withKnowledgeDraftHistory({ title: 'A' }, first)
  const second = planKnowledgeDraftWrite({ draftIdProvided: undefined, existing: { id: 'd1', payload: p1 }, replacedTitle: 'A' })
  const p2 = withKnowledgeDraftHistory({ title: 'B' }, second)
  const third = planKnowledgeDraftWrite({ draftIdProvided: undefined, existing: { id: 'd1', payload: p2 }, replacedTitle: 'B' })
  assert.equal(third.revision, 3)
  assert.deepEqual(third.replacedTitles, ['A', 'B'])
  // 界面提示要能一眼看出"前两次都没了"
  const notice = knowledgeDraftOverwriteNotice(p2, 'd1')
  assert.match(notice, /本会话已提交 2 次/)
  assert.match(notice, /被替换的标题：「A」/)
})

test('planKnowledgeDraftWrite: 传了 draft_id 是显式修订（updated-draft），不算静默覆盖', () => {
  const plan = planKnowledgeDraftWrite({
    draftIdProvided: 'd1',
    existing: { id: 'd1', payload: { title: '第一条', revision: 1, replacedTitles: [] } },
    replacedTitle: '第一条',
  })
  assert.equal(plan.mode, 'updated-draft')
  assert.equal(plan.revision, 2)
  assert.deepEqual(plan.replacedTitles, [], '显式修订不往"被覆盖"历史里记')
  assert.equal(plan.replacedTitle, null)
})

test('readKnowledgeDraftHistory: 脏 payload / 旧草稿都不炸（旧草稿 = 第 1 次、无替换记录）', () => {
  assert.deepEqual(readKnowledgeDraftHistory(undefined), { revision: 1, replacedTitles: [] })
  assert.deepEqual(readKnowledgeDraftHistory({}), { revision: 1, replacedTitles: [] })
  assert.deepEqual(readKnowledgeDraftHistory({ revision: 'x', replacedTitles: 'nope' }), { revision: 1, replacedTitles: [] })
  assert.deepEqual(readKnowledgeDraftHistory({ revision: 0 }), { revision: 1, replacedTitles: [] })
  assert.deepEqual(readKnowledgeDraftHistory({ revision: 2.7, replacedTitles: ['a', 3, '  ', 'b'] }), { revision: 2, replacedTitles: ['a', 'b'] })
})

test('readKnowledgeDraftHistory: 被替换标题最多记 N 条（不无限长大）', () => {
  const many = Array.from({ length: KNOWLEDGE_DRAFT_REPLACED_TITLES_LIMIT + 4 }, (_, i) => `t${i}`)
  const history = readKnowledgeDraftHistory({ revision: 9, replacedTitles: many })
  assert.equal(history.replacedTitles.length, KNOWLEDGE_DRAFT_REPLACED_TITLES_LIMIT)
  assert.equal(history.replacedTitles.at(-1), `t${many.length - 1}`, '保留的是最近的那几条')
})

// ---------------------------------------------------------------- 回执措辞

test('回执：三种模式措辞必须不同，覆盖那条要说清"不是新建 + 带 id + 被替换的标题"', () => {
  const created = knowledgeDraftWriteMessage(planKnowledgeDraftWrite({ draftIdProvided: undefined, existing: undefined }), 'd9')
  assert.match(created, /知识草稿已新建（id=d9）/)

  const replaced = knowledgeDraftWriteMessage(planKnowledgeDraftWrite({
    draftIdProvided: undefined,
    existing: { id: 'd1', payload: { title: '旧标题' } },
    replacedTitle: '旧标题',
  }), 'd1')
  assert.match(replaced, /已更新本会话已有草稿（id=d1）/)
  assert.match(replaced, /不是新建/)
  assert.match(replaced, /旧标题/)

  const updated = knowledgeDraftWriteMessage(planKnowledgeDraftWrite({
    draftIdProvided: 'd1',
    existing: { id: 'd1', payload: { title: '旧标题' } },
  }), 'd1')
  assert.match(updated, /知识草稿已更新（id=d1/)
  assert.notEqual(created, replaced)
  assert.notEqual(replaced, updated)
})

test('回执：新建那条也要写明"一个会话只产生 1 条"与绕行路由（提示第一条就可能被覆盖）', () => {
  const created = knowledgeDraftWriteMessage(planKnowledgeDraftWrite({ draftIdProvided: undefined, existing: undefined }), 'd1')
  assert.match(created, /一个会话最多产出 1 条知识/)
  assert.match(created, /POST \/api\/workbench\/drafts/)
  assert.match(KNOWLEDGE_DRAFT_SESSION_CONSTRAINT, /一个会话最多产出 1 条知识/)
  assert.match(KNOWLEDGE_DRAFT_SESSION_CONSTRAINT, /POST \/api\/workbench\/drafts/)
})

// ---------------------------------------------------------------- 界面提示

test('界面提示：第 1 次提交不提示（没被覆盖就没什么要说的），覆盖后才出现', () => {
  assert.equal(knowledgeDraftOverwriteNotice({ title: 'A' }, 'd1'), null)
  assert.equal(knowledgeDraftOverwriteNotice({ title: 'A', revision: 1, replacedTitles: [] }, 'd1'), null)

  const notice = knowledgeDraftOverwriteNotice({ title: 'B', revision: 2, replacedTitles: ['A'] }, 'd1')
  assert.match(notice, /本会话已提交 2 次/)
  assert.match(notice, /前 1 次的内容已被覆盖/)
  assert.match(notice, /被替换的标题：「A」/)
  assert.match(notice, /草稿 id d1/, '界面提示必须带草稿 id，用户/模型才能对上同一份')
  assert.match(notice, /确认入库」入库的是当前这份/)
  assert.match(notice, /POST \/api\/workbench\/drafts/)
})

test('界面提示：只有显式修订（没有 replacedTitles）时不冒充"被覆盖"，但要说清改过几次', () => {
  const notice = knowledgeDraftOverwriteNotice({ title: 'B', revision: 3, replacedTitles: [] }, 'd1')
  assert.match(notice, /已被更新 2 次/)
  assert.equal(/已被覆盖/.test(notice), false)
})

// ---------------------------------------------------------------- 接线（源码级）

test('接线：工具必须用唯一实现，且旧措辞「知识草稿已保存」不得回来', () => {
  assert.match(toolsSource, /planKnowledgeDraftWrite\(\{ draftIdProvided: draftId, existing/)
  assert.match(toolsSource, /withKnowledgeDraftHistory\(payload, plan\)/)
  assert.match(toolsSource, /knowledgeDraftWriteMessage\(plan, draftIdOut\)/)
  assert.equal(/知识草稿已保存/.test(toolsSource), false, '旧措辞会把"覆盖"读成"新建"，必须删掉')
  /**
   * 被替换的标题必须在 `updateDraft` **之前**、且必须从**旧草稿**读出来。
   *
   * 这里比对的是**整条表达式**，不是"出现过 `const previousTitle =`"——
   * 后者对 `const previousTitle = null` 或"读更新后的草稿"照样满意
   * （形态扫描满意、行为照旧，正是本项目最贵的返工来源）。
   */
  const previousTitleRe = /const previousTitle = existing === undefined \? null : str\(\(existing\.payload as Record<string, unknown>\)\.title\) \?\? null/
  const titleMatch = previousTitleRe.exec(toolsSource)
  assert.notEqual(titleMatch, null, '被替换的标题必须从**旧草稿**的 payload 读出来')
  const updateAt = toolsSource.indexOf('updateDraft(db, existing.id, withKnowledgeDraftHistory(payload, plan))')
  assert.notEqual(updateAt, -1, '更新草稿必须带上历史')
  assert.ok(titleMatch.index < updateAt, '读旧标题必须在写之前')
})

test('接线：界面必须渲染覆盖提示（走 KnowledgeDraftBody），且带上草稿 id', () => {
  assert.match(bannerSource, /body: <KnowledgeDraftBody draftId=\{draft\.id\} payload=\{payload\} \/>/)
  assert.match(bodySource, /knowledgeDraftOverwriteNotice\(payload, draftId\)/)
  assert.match(bodySource, /className="wb-draft-overwrite-notice"/, '提示要在真样式下有独立落点，浏览器 harness 才能断言可见')
  // 草稿弹窗里不得再出现第二处"知识正文"实现（同一语义只算一次）
  assert.equal(/MarkdownText text=\{contentMd\}/.test(bannerSource), false, '知识正文已搬到 KnowledgeDraftBody，banner 里不该再有第二份')
})

test('帮助文案：工具说明与常驻引导都要能查到"一个会话只产生 1 条"与绕行路由', () => {
  assert.match(toolsSource, /同一会话重复提交（不带 draft_id）不是新建、是「覆盖」同一份草稿/)
  assert.match(toolsSource, /\$\{KNOWLEDGE_DRAFT_SESSION_CONSTRAINT\}/, '工具说明必须复用那份唯一口径，不许手写一遍')
  assert.match(indexSource, /一个会话只产生 1 条知识草稿/)
  assert.match(indexSource, /POST \/api\/workbench\/drafts/)
})
