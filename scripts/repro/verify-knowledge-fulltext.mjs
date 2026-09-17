/**
 * 第一方验证（v1.15.5）：对**真实库副本**跑一遍用户实际会看到的两个口子。
 *
 * 1. 关键词检索：展示的"相关度"是归一化 0~1 口径（不再是有界原始分 0.55 封顶）；
 * 2. 按 [id] 直读全文：注入文案承诺的那条路真的能拿到全文（镜像型条目还给 file_link）。
 *
 * 只读副本，不碰线上库。
 * 用法：node scripts/repro/verify-knowledge-fulltext.mjs
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../../lib/db/database.js'
import { KnowledgeRecallManager } from '../../lib/knowledge-recall.js'
import { searchKnowledgeTool } from '../../lib/knowledge-tools.js'
import { getKnowledge } from '../../lib/db/repo.js'

const SOURCE = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'workbench', 'workbench.db')
if (!existsSync(SOURCE)) { console.error('SKIP: 找不到线上工作台库'); process.exit(2) }
const dir = mkdtempSync(join(tmpdir(), 'wb-fulltext-'))
const copy = join(dir, 'workbench.db')
copyFileSync(SOURCE, copy)
for (const suffix of ['-wal', '-shm']) if (existsSync(`${SOURCE}${suffix}`)) copyFileSync(`${SOURCE}${suffix}`, `${copy}${suffix}`)

const db = openWorkbenchDb({ dbPath: copy })
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

try {
  const manager = new KnowledgeRecallManager(db, { log: () => {} })
  const tool = searchKnowledgeTool(manager)
  const exec = { agent: { session: { id: 'verify-fulltext' } } }

  const query = process.argv[2] ?? '计划任务 定时 同步'
  const search = await tool.execute({ query, limit: 3 }, exec)
  console.log(`\n===== 关键词检索「${query}」 =====\n${search}\n`)

  const scores = [...search.matchAll(/相关度 (\d\.\d\d)/g)].map((m) => Number(m[1]))
  check('展示的相关度落在归一化口径 (0, 1]', scores.length > 0 && scores.every((s) => s > 0 && s <= 1), scores.join(', ') || '无命中')
  check('相关度不再是"原始分"（列表里应有 > 0.55 的分数才说明归一化生效，或全为高分区）', scores.length === 0 || scores.every((s) => s > 0.6), scores.join(', ') || '无命中')

  const firstId = /^\s*- \[([0-9a-f-]{36})\]/m.exec(search)?.[1]
  check('检索结果带完整 uuid（注入/工具都靠它取全文）', firstId !== undefined, firstId ?? '无')

  if (firstId !== undefined) {
    const entry = getKnowledge(db, firstId)
    const full = await tool.execute({ query: `[${firstId}]` }, exec)
    const body = String(entry?.contentMd ?? '')
    console.log(`\n===== 按 id 直读「[${firstId}]」 =====\n${full.slice(0, 1200)}\n${full.length > 1200 ? '…（截断显示）' : ''}\n`)
    check('按 id 直读不再走零命中', !/零命中/.test(full))
    if (body.length > 160) {
      const tail = body.slice(-40).trim()
      check(`全文真的完整（正文 ${body.length} 字 > 160 摘要）`, full.includes(tail), `尾部标记：${tail}`)
    } else {
      check(`正文短于 160 字（无需展开）`, full.includes(body.trim()), `正文 ${body.length} 字`)
    }
    check('回显 file_link（镜像型条目的本地文档路径）', entry?.fileLink === null || entry?.fileLink === '' || full.includes(entry.fileLink), entry?.fileLink ?? '(无)')
  }

  const missing = await tool.execute({ query: '00000000-0000-0000-0000-000000000000' }, exec)
  check('未知 id 明确说"没有这条"，不伪装成零命中', /没有这条知识条目/.test(missing), missing.slice(0, 60))
} finally {
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
