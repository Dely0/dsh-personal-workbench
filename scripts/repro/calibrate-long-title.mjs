/**
 * 「泛化长标题抢 top-1」的**标定探针**（只测量、不改生产代码）。
 *
 * ## 要回答的问题
 *
 * 现象（真库实测）：模糊问法的 top-1 常被泛化的长标题抢走，例如
 * 「安装误差补偿调试经验与算法原理（LS_LSJSX / Ant_XYXH）（01 天线测试业务知识库）」
 * 靠标题尾巴里的「知识库」三个字，对「知识库老是往对话里塞东西」拿到 0.305。
 * 机制：`strength = min(1, massHit/0.6)` **在 massHit=0.6 就饱和**，
 * 于是"多中几个中等信息量的词"压过"少中几个稀有词"；标题越长，撞字机会越多。
 *
 * ## 为什么只测量
 *
 * 改打分是**口径变更**（会动到已标定的闸门与一批精确值断言），必须先用数据说话。
 * 本探针把生产实现当"分数提供者"（`minScore: 0, maxEntries: 8` 拿全量排序），
 * 再在**探针内部**对"胜出字段是标题且标题很长"的候选施加假设折扣并重排 ——
 * 折扣只影响本探针的排序，**不写库、不改 lib**。
 *
 * 判据（缺一不可）：
 * 1. 模糊问法里"正确条目当上 top-1"的条数要变多；
 * 2. **不能伤真答案**：关键词式对照 4/4、真实提问的完整/可见率不许掉；
 * 3. A/B/C 三类诱饵不变量不许退化。
 *
 * 用法：node scripts/repro/calibrate-long-title.mjs
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { KnowledgeRecallManager } from '../../lib/knowledge-recall.js'
import { RECALL_DEFAULTS } from '../../lib/shared/knowledgeRecall.js'
import { listKnowledge } from '../../lib/db/repo.js'

const SOURCE = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(SOURCE)) { console.error(`找不到工作台库 ${SOURCE}`); process.exit(2) }
const dir = mkdtempSync(join(tmpdir(), 'wb-cal-longtitle-'))
const copy = join(dir, 'workbench.db')
copyFileSync(SOURCE, copy)
for (const s of ['-wal', '-shm']) if (existsSync(`${SOURCE}${s}`)) copyFileSync(`${SOURCE}${s}`, `${copy}${s}`)
const db = openWorkbenchDb({ dbPath: copy })

/** 拿全量排序的管理器（阈值 0、上限 8），只用于测量。 */
const ranking = new KnowledgeRecallManager(db, { minScore: 0, maxEntries: 8, log: () => {} })
const strict = new KnowledgeRecallManager(db, { log: () => {} })

/** 模糊问法：`expect` 是"库里确实存在的正确答案"的标题子串；空数组 = 库里没有对应条目，不判对错。 */
const FUZZY = [
  ['交付延期根因', '我们公司的项目交付总是会延期，这个具体是什么原因呢？', ['交付延期根因分析']],
  ['波控插件规范', '天线波控插件应该遵守什么规范进行开发呢？', ['波控映射表规范']],
  ['映射表坐标/校验', '通道校准结果整体旋转偏了，我应该先查什么地方？', ['波控映射表规范', '波控映射表单位与阵元对选择']],
  ['阵元对选择', '做安装误差补偿时，选哪两个阵元做基准比较合适？', ['波控映射表单位与阵元对选择']],
  ['组帧字节序', '波控下发的指令天线不认，字节顺序是不是有问题？', []],
  ['召回开关', '知识库老是自动往对话里塞东西，怎么让它安静点？', []],
  ['两档闸门', '自动召回有时候只给一行提示，那是为什么？', []],
  ['装盘 ENOENT', '装盘的时候报错说找不到文件，是什么原因？', ['dsh-plugin-automations']],
]
const CONTROLS = ['知识库 自动调用 会话 注入', '方向图 内存溢出 卡死', '证据链 反向验证 变异测试', '复盘 根因分析 多轮返工']
const REPEAT = CONTROLS
const SHARING = [
  ['方向图 内存溢出 卡死', '方问图 内存益出 卡死'],
  ['复盘 根因分析 多轮返工', '复盆 根音分析 多轮返工'],
  ['证据链 反向验证 变异测试', '证据连 反向验证 变导测试'],
  ['转台操作 SOP', '转抬操作 SOP'],
]
const corpus = listKnowledge(db, { limit: 5000 })
const corpusText = corpus.map((e) => `${e.title}${e.contentMd}${e.tags.join('')}`.toLowerCase()).join('')
const RARE = ['龘', '靐', '齉', '爨', '麤', '黌', '鸝', '蠡', '彧', '翀', '燚', '鑫', '淼', '焱', '垚', '犇', '猋', '驫']
const OUTSIDE = RARE.filter((c) => !corpusText.includes(c))

const realRows = db.prepare(`SELECT query FROM knowledge_recall_log WHERE trigger_code = 'turn' AND length(query) > 6 ORDER BY id DESC LIMIT 12`).all()
const REAL = []
for (const row of realRows) {
  const q = String(row.query).trim()
  if (q !== '' && !REAL.includes(q)) REAL.push(q)
}

/** 一条命中是不是"标题档胜出"（理由串里有字段名，取它是为了不重复实现打分）。 */
const titleWinner = (hit) => /(标题)命中/.test(hit.reason)

/**
 * 假设折扣（**仅本探针**）：胜出字段是标题、且标题超过阈值时打折。
 * 语义：标题越长，"命中它"越是撞字运气的成分 → 证据强度应当折减。
 */
const RULES = [
  ['R0 现状（无折扣）', () => 1],
  ['R1 标题>30字 ×0.90', (hit) => (titleWinner(hit) && hit.title.length > 30 ? 0.9 : 1)],
  ['R2 标题>30字 ×0.85，>45字 ×0.80', (hit) => (titleWinner(hit) ? (hit.title.length > 45 ? 0.8 : hit.title.length > 30 ? 0.85 : 1) : 1)],
  ['R3 平滑密度（20字起线性降到 0.75）', (hit) => (titleWinner(hit) ? 1 - 0.25 * Math.min(1, Math.max(0, (hit.title.length - 20) / 40)) : 1)],
]

/** 按折扣重排并分档（闸门仍是生产值，折扣只是把分数拉低 → 原本"擦边过闸"的可能掉档）。 */
function tiered(rule, query) {
  const out = ranking.recallToText({ taskId: null, query })
  const ranked = out.hits
    .map((hit) => ({ hit, score: hit.score * rule(hit) }))
    .sort((a, b) => b.score - a.score || a.hit.id.localeCompare(b.hit.id))
  const full = ranked.filter((item) => item.score > RECALL_DEFAULTS.minScore).slice(0, 3)
  const hints = ranked.filter((item) => item.score > RECALL_DEFAULTS.hintScore && item.score <= RECALL_DEFAULTS.minScore).slice(0, 2)
  return { ranked, full, hints, tier: full.length > 0 ? '完整块' : hints.length > 0 ? '提示' : '静默' }
}

console.log(`语料 ${corpus.length} 条｜阈值 完整>${RECALL_DEFAULTS.minScore} 提示>${RECALL_DEFAULTS.hintScore}\n`)
const summary = []
for (const [label, rule] of RULES) {
  let fuzzyFull = 0
  let fuzzyHint = 0
  let fuzzySilent = 0
  let correctTop1 = 0
  let judgeable = 0
  let hogTop1 = 0
  const details = []
  for (const [name, query, expect] of FUZZY) {
    const result = tiered(rule, query)
    if (result.tier === '完整块') fuzzyFull += 1
    else if (result.tier === '提示') fuzzyHint += 1
    else fuzzySilent += 1
    const top = result.ranked[0]
    const topTitle = top?.hit.title ?? '(无)'
    if (topTitle.includes('安装误差补偿') || topTitle.includes('团队记忆系统落地搭建')) hogTop1 += 1
    if (expect.length > 0) {
      judgeable += 1
      if (expect.some((needle) => topTitle.includes(needle))) correctTop1 += 1
    }
    details.push(`${name}:${result.tier}${expect.length > 0 ? (expect.some((n) => topTitle.includes(n)) ? '✔' : '✘') : '·'}(${top === undefined ? '-' : top.score.toFixed(3)})`)
  }
  const controlFull = CONTROLS.filter((q) => tiered(rule, q).tier === '完整块').length
  const realFull = REAL.filter((q) => tiered(rule, q).tier === '完整块').length
  const realVisible = REAL.filter((q) => tiered(rule, q).tier !== '静默').length
  let sharingReal = 0
  let sharingDecoy = 0
  for (const [real, decoy] of SHARING) {
    sharingReal += tiered(rule, real).full.length
    sharingDecoy += tiered(rule, decoy).full.length
  }
  let outsideHits = 0
  for (let i = 0; i + 2 < OUTSIDE.length && i < 8; i += 3) outsideHits += tiered(rule, `${OUTSIDE[i]}${OUTSIDE[i + 1]}${OUTSIDE[i + 2]}`).full.length
  const counts = new Map()
  for (const q of REPEAT) for (const item of tiered(rule, q).full) counts.set(item.hit.id, (counts.get(item.hit.id) ?? 0) + 1)
  const repeated = [...counts.values()].filter((n) => n >= 3).length
  const ok = controlFull === CONTROLS.length && outsideHits === 0 && repeated === 0 && sharingDecoy <= sharingReal && realVisible >= 11
  summary.push({ label, fuzzyFull, fuzzyHint, fuzzySilent, correctTop1, judgeable, hogTop1, controlFull, realFull, realVisible, outsideHits, repeated, ok, details })
}

console.log('规则'.padEnd(34) + '模糊落档(块/提/静)  正确top1  泛化抢top1  对照  真实(块/可见)  A诱饵  B零命中  C重复  判定')
console.log('─'.repeat(140))
for (const s of summary) {
  console.log(
    s.label.padEnd(32) + String(`${s.fuzzyFull}/${s.fuzzyHint}/${s.fuzzySilent}`).padStart(12)
    + String(`${s.correctTop1}/${s.judgeable}`).padStart(9) + String(s.hogTop1).padStart(12)
    + String(`${s.controlFull}/4`).padStart(6) + String(`${s.realFull}/${s.realVisible}`).padStart(14)
    + String(s.hogTop1 >= 0 ? '' : '').padStart(0)
    + (s.outsideHits === 0 ? '  ✔' : `  ✘${s.outsideHits}`) + (s.repeated === 0 ? '  ✔' : `  ✘${s.repeated}`)
    + (s.ok ? '  可接受' : '  ⚠不变量破了'),
  )
}
console.log('')
for (const s of summary) console.log(`${s.label}\n   ${s.details.join('  ')}`)
console.log('\n注：A 诱饵列（诱/真）与"真实提问完整率"请配合 `measure-recall-rate.mjs` / `demo-knowledge-recall.mjs` 复核。')
db.close()
rmSync(dir, { recursive: true, force: true })
void strict
