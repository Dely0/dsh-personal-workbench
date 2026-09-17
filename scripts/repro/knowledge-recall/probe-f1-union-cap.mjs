/**
 * 反向前置 #1：多句 query 合并后必须仍然受单回合上限约束。
 * 有缺陷时退出码非零（合并后 6 条 > 上限 3 条）。
 */
import { mergeRecallOutcomes, recallKnowledge, RECALL_DEFAULTS } from '../../../lib/shared/knowledgeRecall.js'

const NOW = new Date('2026-09-17T00:00:00.000Z')
const entry = (id, title) => ({
  id, kindCode: 'lesson', title, contentMd: '', tags: [],
  sourceTaskId: null, sourceSessionId: null, sourceReviewId: null, fileLink: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
})
const o1 = recallKnowledge({ query: '知识库分页', candidates: [entry('a1', '知识库分页'), entry('a2', '知识库分页卡顿'), entry('a3', '知识库分页卡顿排查')].map((e) => ({ entry: e, fromTask: false })), now: NOW })
const o2 = recallKnowledge({ query: '标签筛选', candidates: [entry('b1', '标签筛选'), entry('b2', '标签筛选截断'), entry('b3', '标签筛选静默截断')].map((e) => ({ entry: e, fromTask: false })), now: NOW })
const merged = mergeRecallOutcomes([{ query: '知识库分页', outcome: o1 }, { query: '标签筛选', outcome: o2 }])
console.log(`单句命中 ${o1.hits.length}/${o2.hits.length}，单回合上限 ${RECALL_DEFAULTS.maxEntries}，合并后 ${merged.hits.length} 条`)
if (merged.hits.length > RECALL_DEFAULTS.maxEntries) {
  console.log(`FAIL: 合并后超过单回合上限（${merged.hits.length} > ${RECALL_DEFAULTS.maxEntries}）`)
  process.exit(1)
}
console.log(`ok: 合并后仍在上限内（${merged.hits.length} ≤ ${RECALL_DEFAULTS.maxEntries}）`)
