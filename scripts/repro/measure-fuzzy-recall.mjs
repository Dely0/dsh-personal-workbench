/**
 * 模糊检索有效性实测：**用"人话"问，看落到哪一档**。
 *
 * 背景：用户验收时提的是「模糊问法能不能召回」，而不是"照抄知识标题去查"。
 * 本脚本在**真库副本**上跑一批**自造的模糊问法**（刻意不照抄任何标题），
 * 逐条打印：top-1、原始分、展示相关度、落档（完整块 >0.33 / 提示 0.20~0.33 / 静默 ≤0.20），
 * 并给出同一意图的"关键词式"对照 —— 两者的差就是"模糊"的代价。
 *
 * ⚠️ 只读副本，不碰线上库（`openWorkbenchDb` 打开即迁移，不能拿它读线上库）。
 *
 * 用法：node scripts/repro/measure-fuzzy-recall.mjs
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { KnowledgeRecallManager } from '../../lib/knowledge-recall.js'
import { formatRelevance, RECALL_DEFAULTS } from '../../lib/shared/knowledgeRecall.js'

const SOURCE = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(SOURCE)) { console.error(`找不到工作台库 ${SOURCE}`); process.exit(2) }
const dir = mkdtempSync(join(tmpdir(), 'wb-fuzzy-recall-'))
const copy = join(dir, 'workbench.db')
copyFileSync(SOURCE, copy)
for (const suffix of ['-wal', '-shm']) if (existsSync(`${SOURCE}${suffix}`)) copyFileSync(`${SOURCE}${suffix}`, `${copy}${suffix}`)
const db = openWorkbenchDb({ dbPath: copy })
const manager = new KnowledgeRecallManager(db, { log: () => {} })

/** [意图标签, 模糊问法（人话）, 关键词式对照] */
const CASES = [
  ['交付延期根因', '我们公司的项目交付总是会延期，这个具体是什么原因呢？', '合同 约定交期 首付款 到账 延期 根因'],
  ['波控插件规范', '天线波控插件应该遵守什么规范进行开发呢？', '波控 映射表 插件 开发 规范'],
  ['映射表坐标/校验', '通道校准结果整体旋转偏了，我应该先查什么地方？', '映射表 坐标 单位 校验 旋转'],
  ['阵元对选择', '做安装误差补偿时，选哪两个阵元做基准比较合适？', '阵元对 选择 对角线 过中心 间距'],
  ['组帧字节序', '波控下发的指令天线不认，字节顺序是不是有问题？', '波控 组帧 字节序 大端 交换'],
  ['知识库召回开关', '知识库老是自动往对话里塞东西，怎么让它安静点？', '知识库 召回 自动 关闭 开关'],
  ['两档闸门', '自动召回有时候只给一行提示，那是为什么？', '召回 提示档 闸门 阈值'],
  ['装盘 ENOENT', '装盘的时候报错说找不到文件，是什么原因？', '装盘 plugin add ENOENT 报错'],
]

console.log(`阈值：完整块 raw > ${RECALL_DEFAULTS.minScore}（展示 ${formatRelevance(RECALL_DEFAULTS.minScore)}）｜`
  + `提示 ${RECALL_DEFAULTS.hintScore}~${RECALL_DEFAULTS.minScore}（展示 ${formatRelevance(RECALL_DEFAULTS.hintScore)}~${formatRelevance(RECALL_DEFAULTS.minScore)}）｜`
  + `静默 ≤ ${RECALL_DEFAULTS.hintScore}\n`)

const tier = (out) => (out.hits.length > 0 ? '✅完整块' : out.nearMisses.length > 0 ? '🔸提示' : '❌静默')
let full = 0
let hint = 0
let silent = 0
for (const [label, vague, keywords] of CASES) {
  const a = manager.recallToText({ taskId: null, query: vague })
  const b = manager.recallToText({ taskId: null, query: keywords })
  const aTop = a.hits[0] ?? a.nearMisses[0]
  const bTop = b.hits[0] ?? b.nearMisses[0]
  if (a.hits.length > 0) full += 1
  else if (a.nearMisses.length > 0) hint += 1
  else silent += 1
  console.log(`【${label}】模糊：「${vague}」`)
  console.log(`  ${tier(a)}  raw=${aTop === undefined ? '  -  ' : aTop.score.toFixed(3)}  展示=${aTop === undefined ? '  -  ' : formatRelevance(aTop.score)}  `
    + `top-1=${aTop === undefined ? '(一条都没碰到关键词)' : aTop.title.slice(0, 34)}  matched=${a.matched}`)
  console.log(`  对照（关键词式）${tier(b)}  raw=${bTop === undefined ? '  -  ' : bTop.score.toFixed(3)}  `
    + `top-1=${bTop === undefined ? '(无)' : bTop.title.slice(0, 34)}`)
  console.log('')
}
console.log(`模糊问法落档分布：完整块 ${full}/${CASES.length}｜提示 ${hint}/${CASES.length}｜静默 ${silent}/${CASES.length}`)
db.close()
rmSync(dir, { recursive: true, force: true })
