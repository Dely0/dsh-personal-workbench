import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { proposeDailyPlanTool, proposeIdeaClustersTool, submitIdeaTasksTool, submitKnowledgeTool, submitReportTool, submitTaskTool, updateTaskTool, requestCompletionTool, saveTaskMemoryTool } from '../lib/tools.js'
import { createIdea, createTask, getTask, getTaskMemoryContext, getDraftBySession, getPendingDailyPlanDraft, getPendingDraftForSession, getPendingDraftForTask, getPendingReportDraft, linkTaskSession, updateTask } from '../lib/db/repo.js'

/**
 * 删临时目录，容忍 Windows 上刚 `close()` 时文件句柄尚未释放导致的 EPERM。
 *
 * 背景：`rmSync` 偶发 EPERM 会让一条**断言全过**的测试报失败，
 * 看起来像功能坏了，实际只是杀毒/索引还在占着 WAL 文件。
 * 这类"清理期的假失败"最耗排查时间，所以统一重试几次再放弃（放弃也不 fail）。
 */
function rmTempDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'ENOTEMPTY') throw error
      // 忙等一小会儿（同步 sleep）——测试进程里没有别的活可干，等一下最省事。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

test('agent tools write pending drafts and update tasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-tools-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    const submit = submitTaskTool(db)
    const out = await submit.execute(
      { title: 'clarified task', type_code: 'client_meeting', priority_code: 'p0' },
      { agent: { session: { id: 'sess-1' } } },
    )
    assert.match(out, /草稿已保存/)
    assert.ok(getDraftBySession(db, 'sess-1'))

    // type_code 是**封闭枚举**（v1.14.0 起）：合法值通过，字典外的值**当场拒绝**。
    //
    // 旧行为是"未知 code 静默回退成 personal 并返回草稿已保存"，用户实测反馈
    // 「非法 code 拦截失败」—— 静默改写比静默丢弃更难发现（以为建的是"培训学习"，
    // 实际是"个人生活"）。这条测试原来锁的正是那个旧行为，现已按新契约反转。
    const training = await submit.execute({ title: '学做东北菜', type_code: 'training', priority_code: 'p2' }, { agent: { session: { id: 'sess-training' } } })
    assert.match(training, /草稿已保存/)
    assert.equal(getDraftBySession(db, 'sess-training').payload.typeCode, 'training')

    const unknown = await submit.execute({ title: '未知类型任务', type_code: 'foobar', priority_code: 'p2' }, { agent: { session: { id: 'sess-unknown' } } })
    assert.match(unknown, /type_code 不是有效值/)
    assert.match(unknown, /合法值/)
    assert.equal(getDraftBySession(db, 'sess-unknown'), undefined, '非法 type_code 不应落成草稿')

    // 大小写/字形变体同样拒绝（CODE_IMPL 不是 code_impl）；空串才允许走默认值
    const upper = await submit.execute({ title: '大写变体', type_code: 'CODE_IMPL', priority_code: 'p2' }, { agent: { session: { id: 'sess-upper' } } })
    assert.match(upper, /type_code 不是有效值/)
    assert.equal(getDraftBySession(db, 'sess-upper'), undefined)

    // 回执必须回显**最终落库**的字段，避免"静默改写"再次发生
    assert.match(training, /本次落库的字段：type=training/)

    const update = updateTaskTool(db)
    const task = createTaskForTest(db)
    const upd = await update.execute({ task_id: task.id, description: '## 更新后描述' })
    assert.match(upd, /已更新任务/)
    assert.equal(getTask(db, task.id).description, '## 更新后描述')

    const completion = requestCompletionTool(db)
    const done = await completion.execute({ task_id: task.id, summary: '完成总结' }, { agent: { session: { id: 'sess-exec' } } })
    assert.match(done, /验收申请/)
    const pending = getPendingDraftForTask(db, 'completion', task.id)
    assert.ok(pending)
    assert.equal(getTask(db, task.id).statusCode, 'todo') // 验收前不完成
    // 幂等：同一任务再次申请完成，更新同一草稿
    await completion.execute({ task_id: task.id, summary: '完成总结 v2' }, { agent: { session: { id: 'sess-exec' } } })
    assert.equal(getPendingDraftForTask(db, 'completion', task.id).id, pending.id)
    // AI 不能直接关闭任务
    const deniedClose = await update.execute({ task_id: task.id, status_code: 'done' })
    assert.match(deniedClose, /不能直接/)

    // 验收历史：首次提交返回"第 1 次"，被驳回后再提交带上反馈并回报历史
    assert.match(done, /第 1 次验收提交/)
    const rejected = await completion.execute({ task_id: task.id, summary: '完成总结 v3', feedback: '已按反馈补齐回归测试' }, { agent: { session: { id: 'sess-exec' } } })
    assert.match(rejected, /已按反馈补齐回归测试|第 1 次|暂存/)
    assert.equal(getPendingDraftForTask(db, 'completion', task.id).payload.feedback, '已按反馈补齐回归测试')

    // 任意节点（含父任务）均可申请完成；父任务不再被“叶子”限制拒绝
    const parent = createTask(db, { title: 'parent exec', typeCode: 'code_impl', priorityCode: 'p1', aiPolicyCode: 'execute' })
    createTask(db, { title: 'child', typeCode: 'code_impl', priorityCode: 'p1', parentId: parent.id })
    const parentDone = await completion.execute({ task_id: parent.id, summary: '父任务完成' }, { agent: { session: { id: 'sess-parent' } } })
    assert.match(parentDone, /验收申请/)
    assert.ok(getPendingDraftForTask(db, 'completion', parent.id))

    // 任务共享记忆工具：保存后可被同树后续会话读取
    const saveMem = saveTaskMemoryTool(db)
    const memOut = await saveMem.execute({ task_id: task.id, content: '关键决策：使用方案A', kind: 'decision' }, { agent: { session: { id: 'sess-exec' } } })
    assert.match(memOut, /已保存任务共享记忆/)
    assert.match(getTaskMemoryContext(db, task.id), /关键决策：使用方案A/)

    const proposePlan = proposeDailyPlanTool(db)
    const t1 = createTaskForTest(db)
    const planOut = await proposePlan.execute(
      { summary: '先清逾期再推进方案', items: [{ task_id: t1.id, order: 1, note: '上午整块时间' }] },
      { agent: { session: { id: 'sess-plan' } } },
    )
    assert.match(planOut, /今日计划提案已保存/)
    const planDraft = getPendingDailyPlanDraft(db, 'sess-plan')
    assert.ok(planDraft)
    // 同一会话同日再次提交：更新同一草稿，不重复创建
    const planOut2 = await proposePlan.execute(
      { summary: '第二版排序', items: [{ task_id: t1.id, order: 1, note: '下午' }] },
      { agent: { session: { id: 'sess-plan' } } },
    )
    assert.match(planOut2, /今日计划提案已保存/)
    assert.equal(getPendingDailyPlanDraft(db, 'sess-plan').id, planDraft.id)
    // 已完成任务不能进入计划
    updateTask(db, t1.id, { statusCode: 'done' })
    assert.equal(getTask(db, t1.id).statusCode, 'done')
    const badPlan = await proposePlan.execute(
      { summary: '不应成功', items: [{ task_id: t1.id, order: 1, note: '' }] },
      { agent: { session: { id: 'sess-plan-bad' } } },
    )
    assert.match(badPlan, /已归档或已关闭/)

    const submitReport = submitReportTool(db)
    const reportOut = await submitReport.execute(
      { period_code: 'day', period_start: localDateStr(), title: '日报', summary_md: '# 今日' },
      { agent: { session: { id: 'sess-report' } } },
    )
    assert.match(reportOut, /报告草稿已保存/)
    const reportDraft = getPendingReportDraft(db, 'sess-report', 'day', localDateStr())
    assert.ok(reportDraft)
    const reportOut2 = await submitReport.execute(
      { period_code: 'day', period_start: localDateStr(), title: '日报 v2', summary_md: '# 今日 v2' },
      { agent: { session: { id: 'sess-report' } } },
    )
    assert.match(reportOut2, /报告草稿已保存/)
    assert.equal(getPendingReportDraft(db, 'sess-report', 'day', localDateStr()).id, reportDraft.id)

    const submitKnowledge = submitKnowledgeTool(db)
    const kOut = await submitKnowledge.execute(
      { title: '经验：先验证再开发', content_md: '# 结论', kind_code: 'lesson', tags: ['流程'], file_link: 'D:\\docs\\经验.md' },
      { agent: { session: { id: 'sess-know' } } },
    )
    assert.match(kOut, /知识草稿已保存/)
    assert.equal(getDraftBySession(db, 'sess-know').payload.fileLink, 'D:\\docs\\经验.md')
    assert.match(await submitKnowledge.execute(
      { title: '经验：先验证再开发 v2', content_md: '# 结论 v2', kind_code: 'lesson', tags: ['流程'] },
      { agent: { session: { id: 'sess-know' } } },
    ), /知识草稿已保存/)
    // 非法 file_link 会被工具拒绝，不写入草稿
    const badLink = await submitKnowledge.execute(
      { title: '坏链接', content_md: '# x', kind_code: 'note', file_link: 'relative/path.md' },
      { agent: { session: { id: 'sess-know-bad' } } },
    )
    assert.match(badLink, /fileLink must be a file:\/\/ URL or an absolute path/)

    const idea1 = createIdea(db, { title: '点子A', kindCode: 'spark', tags: ['x'] })
    const idea2 = createIdea(db, { title: '点子B', kindCode: 'plugin', tags: ['x'] })
    const clusterTool = proposeIdeaClustersTool(db)
    const cOut = await clusterTool.execute({ clusters: [{ title: 'X 方向', summary: '相关', idea_ids: [idea1.id, idea2.id] }] }, { agent: { session: { id: 'sess-cluster' } } })
    assert.match(cOut, /点子王提案已保存/)
    assert.ok(getPendingDraftForSession(db, 'sess-cluster', 'idea_cluster'))
    const taskTool = submitIdeaTasksTool(db)
    const tOut = await taskTool.execute({ source_idea_ids: [idea1.id], tasks: [{ title: '落地A', type_code: 'code_impl', priority_code: 'p1' }], summary: '结论' }, { agent: { session: { id: 'sess-idea-task' } } })
    assert.match(tOut, /点子落地任务提案已保存/)
    assert.ok(getPendingDraftForSession(db, 'sess-idea-task', 'idea_tasks'))
    db.close()
  } finally {
    rmTempDir(dir)
  }
})

test('workbench_update_task 改父任务：parent_id / parent_title 解析、顶层与防环', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-tools-reparent-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    const update = updateTaskTool(db)
    const target = createTask(db, { title: '目标父任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const other = createTask(db, { title: '另一个任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const moving = createTask(db, { title: '被移动任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const child = createTask(db, { title: '子任务', typeCode: 'code_impl', priorityCode: 'p1', parentId: moving.id })

    // 用 id 指定父任务
    const byId = await update.execute({ task_id: moving.id, parent_id: target.id })
    assert.match(byId, /已更新任务/)
    assert.match(byId, /父任务改为「目标父任务」/)
    assert.equal(getTask(db, moving.id).parentId, target.id)

    // 用户只给了标题：用 parent_title 解析
    const byTitle = await update.execute({ task_id: moving.id, parent_title: '另一个任务' })
    assert.match(byTitle, /父任务改为「另一个任务」/)
    assert.equal(getTask(db, moving.id).parentId, other.id)

    // 移到顶层
    const toTop = await update.execute({ task_id: moving.id, parent_id: 'none' })
    assert.match(toTop, /父任务改为「顶层」/)
    assert.equal(getTask(db, moving.id).parentId, null)

    // 防环：目标是自己的子任务 → 返回中文错误文本（而不是抛异常），且不改库
    const cyclic = await update.execute({ task_id: moving.id, parent_id: child.id })
    assert.match(cyclic, /^错误：/)
    assert.match(cyclic, /形成环/)
    assert.equal(getTask(db, moving.id).parentId, null)

    // 标题找不到 → 列出候选让 AI 回去问用户；重名 → 不替用户挑；两个参数同时给 → 明确报错
    const missing = await update.execute({ task_id: moving.id, parent_title: '不存在的标题' })
    assert.match(missing, /没有找到/)
    assert.match(missing, /目标父任务/)
    assert.equal(getTask(db, moving.id).parentId, null)

    createTask(db, { title: '重名任务', typeCode: 'code_impl', priorityCode: 'p1' })
    createTask(db, { title: '重名任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const ambiguous = await update.execute({ task_id: moving.id, parent_title: '重名任务' })
    assert.match(ambiguous, /匹配到 2 个/)
    assert.match(ambiguous, /parent_id/)
    assert.equal(getTask(db, moving.id).parentId, null)

    const both = await update.execute({ task_id: moving.id, parent_id: target.id, parent_title: '目标父任务' })
    assert.match(both, /只能给一个/)
    assert.equal(getTask(db, moving.id).parentId, null)

    // 父任务 id 不存在：中文原因
    const badId = await update.execute({ task_id: moving.id, parent_id: 'no-such-parent' })
    assert.match(badId, /父任务 no-such-parent 不存在/)
    assert.equal(getTask(db, moving.id).parentId, null)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createTaskForTest(db) {
  return createTask(db, { title: 'execution target', typeCode: 'code_impl', priorityCode: 'p1', aiPolicyCode: 'execute' })
}

function localDateStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 回归（工具侧，2026-09-13 真实事故）：
 * 任务**执行会话**里再次 `workbench_submit_task` 同名任务时，回执必须提醒"这条任务已存在"。
 *
 * 事故形态：任务 A 的执行会话（session-5cf75152）又录了一份同名草稿，
 * 用户在「待处理」里把它确认掉 → 库里多出一条同名任务。
 * 工具不能拒绝（同名任务可能是正当需求），但必须让 AI 有据可依地提醒用户。
 */
test('workbench_submit_task 在同名任务已存在时给出提醒（尤其是当前会话就是它的关联会话）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-personal-workbench-tools-dup-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    const submit = submitTaskTool(db)

    // ① 全新标题：不该有任何提醒
    const clean = await submit.execute(
      { title: '第一次录入的任务', type_code: 'personal', priority_code: 'p3' },
      { agent: { session: { id: 'sess-clarify' } } },
    )
    assert.doesNotMatch(clean, /已经存在|已经有/)

    // ② 任务已存在，但当前会话与它无关 → 提示但不阻断
    const task = createTask(db, { title: '已存在的任务', typeCode: 'personal', priorityCode: 'p3' })
    const unrelated = await submit.execute(
      { title: '已存在的任务', type_code: 'personal', priority_code: 'p3' },
      { agent: { session: { id: 'sess-other' } } },
    )
    assert.match(unrelated, /草稿已保存/, '提醒不能变成拒绝')
    assert.match(unrelated, /已经有 1 条同名任务/)

    // ③ 当前会话正是那条任务的关联会话（= 执行会话重复录入）→ 明确指出"这几乎肯定是重复录入"
    linkTaskSession(db, { taskId: task.id, sessionId: 'sess-execute', roleCode: 'execute' })
    const repeat = await submit.execute(
      { title: '已存在的任务', type_code: 'personal', priority_code: 'p3' },
      { agent: { session: { id: 'sess-execute' } } },
    )
    assert.match(repeat, /草稿已保存/)
    assert.match(repeat, /已经存在/)
    assert.match(repeat, /几乎肯定是重复录入/)
    assert.match(repeat, new RegExp(task.id.slice(0, 8)))
  } finally {
    rmTempDir(dir)
  }
})
