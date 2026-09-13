/**
 * 复盘 → 团队记忆库（v1.14.0）单测。
 *
 * 盯的都是验收标准里的硬约束：
 * 1. 确认时写入，**按 lesson 拆条**，每条带回链；
 * 2. **幂等**：重复确认同一条复盘不产生重复记忆；
 * 3. `scope` 默认保守（private），可被显式改成 team；
 * 4. 记忆库**不可达时也不失败** —— 只回 degradedReason，不抛；
 * 5. `enabled: false`（用户取消勾选）时一个字节都不写；
 * 6. 落盘格式与 `dsh-team-memory` 的 NoteStore 同构（它的检索要能直接读到）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { createTask, createTaskReview } from '../lib/db/repo.js'
import {
  memoryContentHash, notesFromReview, readWrittenMap, saveMemoryNote, slugify, writeReviewToTeamMemory,
} from '../lib/review-memory.js'

async function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-review-memory-'))
  const home = join(dir, 'memory')
  let db
  try {
    db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    return await fn(db, home, dir)
  } finally {
    // 必须先关连接：WAL 句柄不释放，Windows 上 rmSync 会 EPERM。
    try { db?.close() } catch { /* 已关闭 */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

function seedReview(db, { lessons = [], summaryMd = '## 做得好\n\n- 提前对齐了需求' } = {}) {
  const task = createTask(db, { title: '交付 V1.14.0', typeCode: 'code_impl', priorityCode: 'p1' })
  const reviewId = createTaskReview(db, { taskId: task.id, sessionId: 's-review', summaryMd, lessonsJson: lessons })
  return { task, reviewId }
}

test('复盘写入团队记忆：按 lesson 拆条 + 回链 + 落盘格式与 NoteStore 同构', async () => {
  await withDb(async (db, home) => {
    const { task, reviewId } = seedReview(db, {
      lessons: [
        { title: '防环校验要放 repo 层', content: '放在路由层会漏掉别的调用方。' },
        { title: '事件码要和前端标签同步', content: '否则「记录」页签显示原始 token。' },
      ],
    })
    const result = await writeReviewToTeamMemory(db, reviewId, { home, enabled: true, scope: 'team' })
    assert.equal(result.enabled, true)
    assert.equal(result.scope, 'team')
    assert.equal(result.written, 2)
    assert.equal(result.skipped, 0)
    assert.equal(result.degradedReason, undefined)
    assert.equal(result.files.length, 2)

    const notesDir = join(home, 'notes')
    const files = readdirSync(notesDir).filter((name) => name.endsWith('.md'))
    assert.equal(files.length, 2)
    const first = readFileSync(join(notesDir, files.find((name) => name.includes('防环校验'))), 'utf8')
    // front matter 字段与 dsh-team-memory 的 note-store 一致，它的 index()/searchLocal 才能读到
    assert.ok(first.startsWith('---\n'))
    assert.match(first, /title: "防环校验要放 repo 层（交付 V1\.14\.0）"/)
    assert.match(first, /kind: "lesson"/)
    assert.match(first, /scope: "team"/)
    assert.match(first, /tags: \["复盘", "工作台"\]/)
    // 回链：能从记忆库回溯到任务与复盘
    assert.match(first, new RegExp(task.id))
    assert.match(first, new RegExp(reviewId))
    assert.match(first, /来源：个人工作台任务「交付 V1\.14\.0」/)

    // 入队：交给 dsh-team-memory 的定时器补传
    const queued = readdirSync(join(home, 'queue')).filter((name) => name.endsWith('.json'))
    assert.equal(queued.length, 2)
    const entry = JSON.parse(readFileSync(join(home, 'queue', queued[0]), 'utf8'))
    assert.equal(entry.kind, 'note')
    assert.equal(entry.state, 'pending')
    assert.equal(entry.payload.scope, 'team')
    assert.ok(entry.payload.content_md.length > 0)
    assert.equal(entry.payload.content_hash, undefined, 'content_hash 由 flush 时按 Queue 语义补上')
  })
})

test('复盘写入团队记忆：幂等 —— 重复确认不产生重复条目', async () => {
  await withDb(async (db, home) => {
    const { reviewId } = seedReview(db, { lessons: [{ title: 'A', content: 'a' }, { title: 'B', content: 'b' }] })
    const first = await writeReviewToTeamMemory(db, reviewId, { home, enabled: true })
    assert.equal(first.written, 2)
    const second = await writeReviewToTeamMemory(db, reviewId, { home, enabled: true })
    assert.equal(second.written, 0)
    assert.equal(second.skipped, 2)
    assert.equal(readdirSync(join(home, 'notes')).filter((n) => n.endsWith('.md')).length, 2)
    assert.equal(readdirSync(join(home, 'queue')).filter((n) => n.endsWith('.json')).length, 2)
    // 幂等记录按复盘 id 记在 meta
    assert.deepEqual(readWrittenMap(db)[reviewId], [0, 1])
    // 第三次仍然不重复
    assert.equal((await writeReviewToTeamMemory(db, reviewId, { home, enabled: true })).written, 0)
    assert.equal(readdirSync(join(home, 'notes')).filter((n) => n.endsWith('.md')).length, 2)
  })
})

test('复盘写入团队记忆：scope 默认保守（private），显式 team 才共享', async () => {
  await withDb(async (db, home) => {
    const a = seedReview(db, { lessons: [{ title: '默认可见性', content: 'x' }] })
    const byDefault = await writeReviewToTeamMemory(db, a.reviewId, { home, enabled: true })
    assert.equal(byDefault.scope, 'private', '不传 scope 必须是 private —— 复盘可能含客户信息')

    const b = seedReview(db, { summaryMd: '只有正文，没有结构化教训' })
    const fallback = await writeReviewToTeamMemory(db, b.reviewId, { home, enabled: true, scope: 'private' })
    assert.equal(fallback.written, 1, 'lessons 为空时退化为「一条复盘正文」')
    const text = readFileSync(fallback.files[0], 'utf8')
    assert.match(text, /scope: "private"/)
    assert.match(text, /复盘：交付 V1\.14\.0/)
  })
})

test('复盘写入团队记忆：记忆库不可写时**不失败**，只报降级原因', async () => {
  await withDb(async (db, home) => {
    const { reviewId } = seedReview(db, { lessons: [{ title: 'X', content: 'x' }] })
    // 把一个**普通文件**当成记忆库根目录 → mkdir/写文件必然失败
    // （模拟目录不可写 / 路径被占用这类真实故障）
    mkdirSync(home, { recursive: true })
    const blocked = join(home, 'blocked-by-file')
    writeFileSync(blocked, 'x')
    const res = await writeReviewToTeamMemory(db, reviewId, { home: blocked, enabled: true })
    // 回退本地：notes 目录由调用创建、但写文件本身失败（home 是个普通文件）→ 计入降级原因
    assert.equal(res.written, 0, '写不进去就不能声称写了')
    assert.match(String(res.degradedReason), /本地落盘失败/)
    // 关键：**不抛** —— 复盘已进本地库，团队沉淀失败不能反过来让确认失败
    assert.deepEqual(readWrittenMap(db), {}, '失败不能记成"已写入"（否则永远补不回来）')
  })
})

test('复盘写入团队记忆：服务通道优先，服务抛错时回退本地落盘', async () => {
  await withDb(async (db, home) => {
    const { reviewId } = seedReview(db, { lessons: [{ title: '走服务', content: 'x' }] })
    const seen = []
    const ok = await writeReviewToTeamMemory(db, reviewId, {
      home, enabled: true,
      service: { record: (note) => { seen.push(note); return {} } },
    })
    assert.equal(ok.written, 1)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].title, '走服务（交付 V1.14.0）')
    assert.equal(readdirSync(join(home, 'notes')).length, 0, '服务成功时不再重复落本地')

    const b = seedReview(db, { lessons: [{ title: '服务挂了', content: 'x' }] })
    const degraded = await writeReviewToTeamMemory(db, b.reviewId, {
      home, enabled: true,
      service: { record: () => { throw new Error('connection refused') } },
    })
    assert.equal(degraded.written, 1, '回退本地也算写成功')
    assert.match(String(degraded.degradedReason), /服务写入失败/)
    assert.equal(readdirSync(join(home, 'notes')).length, 1)
  })
})

test('复盘写入团队记忆：用户取消勾选时一个字节都不写', async () => {
  await withDb(async (db, home) => {
    const { reviewId } = seedReview(db, { lessons: [{ title: '不该写', content: 'x' }] })
    const res = await writeReviewToTeamMemory(db, reviewId, { home, enabled: false })
    assert.equal(res.enabled, false)
    assert.equal(res.written, 0)
    assert.equal(res.degradedReason, undefined)
    assert.equal(existsSync(join(home, 'notes')), false)
    assert.deepEqual(readWrittenMap(db), {})
  })
})

test('复盘写入团队记忆：复盘不存在时给出明确原因而不是抛错', async () => {
  await withDb(async (db, home) => {
    const res = await writeReviewToTeamMemory(db, 'no-such-review', { home, enabled: true })
    assert.equal(res.written, 0)
    assert.match(String(res.degradedReason), /复盘不存在/)
  })
})

test('notesFromReview：lesson 标题带任务名、缺 title 时有序号兜底', () => {
  const notes = notesFromReview({
    reviewId: 'r1', taskId: 't1', taskTitle: '任务甲', summaryMd: '正文',
    lessons: [{ title: '有标题', content: 'c1' }, { content: 'c2' }, {}],
    scope: 'private',
  })
  assert.equal(notes.length, 3)
  assert.equal(notes[0].title, '有标题（任务甲）')
  assert.equal(notes[1].title, '复盘教训 2（任务甲）')
  assert.equal(notes[2].title, '复盘教训 3（任务甲）')
  // content 为空时回退到复盘正文，避免写出一条空记忆
  assert.match(notes[2].contentMd, /正文/)
  assert.deepEqual(notes.map((n) => n.slot), [0, 1, 2])
})

test('saveMemoryNote：重名不覆盖已有笔记（自动加后缀）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-note-'))
  try {
    const note = { title: '同名教训', contentMd: 'x', tags: [], kind: 'lesson', scope: 'private', workspace: '', slot: 0 }
    const first = saveMemoryNote(dir, note)
    const second = saveMemoryNote(dir, note)
    assert.notEqual(first.file, second.file)
    assert.ok(existsSync(first.file))
    assert.ok(existsSync(second.file))
    assert.equal(readFileSync(first.file, 'utf8').includes('同名教训'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('slugify / memoryContentHash：与 dsh-team-memory 的语义一致', () => {
  // slugify 保留汉字、把其它字符折叠成单个 -
  assert.equal(slugify('防环校验要放 repo 层!'), '防环校验要放-repo-层')
  assert.equal(slugify(''), 'note')
  // contentHash 折叠空白：同内容不同空格必须得到同一个 hash（否则服务端去重失效）
  const a = memoryContentHash('note', JSON.stringify({ title: 'a  b' }))
  const b = memoryContentHash('note', JSON.stringify({ title: 'a b' }))
  assert.equal(a, b)
  assert.notEqual(a, memoryContentHash('note', JSON.stringify({ title: 'a c' })))
})
