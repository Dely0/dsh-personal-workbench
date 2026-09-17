/**
 * 复核独立审查报告里的可证伪断言（只读）。
 * 对应 docs/design/2026-09-25-capacity-rules-plan.md 审查回合。
 * 用法：node scripts/repro/verify-capacity-review-claims.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const db = new DatabaseSync(join(homedir(), '.dsh', 'workbench', 'workbench.db'), { readOnly: true })
const rows = db.prepare('SELECT id, parent_id, title, status_code, priority_code, due_at, all_day, estimated_minutes, archived FROM tasks').all()
db.close()

const byId = new Map(rows.map((r) => [r.id, r]))
const isOpenish = (r) => r.archived === 0 && !['done', 'cancelled'].includes(r.status_code)
const active = rows.filter(isOpenish)
const missing = active.filter((r) => r.estimated_minutes === null)

// 复刻 effectiveDueAt（自身 due 优先，否则沿父链向上找最近有 due 的祖先，带防环）
const effDue = (r) => {
  let cur = r, d = 0
  const seen = new Set([r.id])
  while (cur !== undefined && d < 20) {
    if (cur.due_at !== null) return cur.due_at
    const next = cur.parent_id === null ? undefined : byId.get(cur.parent_id)
    if (next === undefined || seen.has(next.id)) return null
    seen.add(next.id)
    cur = next; d += 1
  }
  return null
}

const now = new Date()
const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
const end = start + 86400000
const sameLocalDay = (iso) => {
  const t = Date.parse(iso)
  return t >= start && t < end
}

// 真算法（本方案 §3.1）下的 included 集合
const included = []
const overdueExcluded = []
for (const r of active) {
  const due = effDue(r)
  if (due !== null && sameLocalDay(due)) { included.push(r); continue }
  const isDoing = r.status_code === 'doing' || r.status_code === 'blocked'
  if (due === null && isDoing) { included.push(r); continue }
  if (due !== null && Date.parse(due) < start) { overdueExcluded.push(r); continue }
}

console.log('断言 A｜全天任务 all_day=1 总数（全表）:', rows.filter((r) => r.all_day === 1).length,
  '| 其中未归档未完成:', active.filter((r) => r.all_day === 1).length)
console.log('断言 B｜活跃(未归档未完成):', active.length, '| 没填 estimatedMinutes:', missing.length,
  '| 没填且 p2:', missing.filter((r) => r.priority_code === 'p2').length)
console.log('断言 C｜今天按真算法计入:', included.length, '| 其中没填耗时(会走兜底):', included.filter((r) => r.estimated_minutes === null).length)
console.log('断言 D｜今天被排除的逾期:', overdueExcluded.length,
  '| 合计分钟:', overdueExcluded.reduce((s, r) => s + (r.estimated_minutes ?? 30), 0))
const inherited = active.filter((r) => r.due_at === null && effDue(r) !== null)
console.log('断言 E｜自身无 due 但继承到祖先 due 的活跃任务:', inherited.length,
  '| 其中继承值已过期:', inherited.filter((r) => Date.parse(effDue(r)) < start).length)
// 探针（读原始 due_at、不继承）与真算法的差异面
let divergence = 0
for (const r of active) {
  const probeIncluded = r.due_at === null ? (r.status_code === 'doing' || r.status_code === 'blocked') : sameLocalDay(r.due_at)
  const realIncluded = included.includes(r)
  if (probeIncluded !== realIncluded) divergence += 1
}
console.log('断言 F｜基线探针（读 due_at）与真算法（effectiveDueAt）判定不一致的条数:', divergence)
console.log('断言 G｜父子同时未完成的对数:', active.filter((r) => {
  if (r.parent_id === null) return false
  const p = byId.get(r.parent_id)
  return p !== undefined && isOpenish(p)
}).length)
console.log('基准时点 now =', now.toISOString(), '本地日 =', new Date(start).toDateString())
