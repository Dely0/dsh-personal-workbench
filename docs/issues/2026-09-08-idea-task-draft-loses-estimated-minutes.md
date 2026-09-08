# BUG：`workbench_submit_idea_tasks` 确认后丢失 `estimated_minutes`（预计耗时）

| 项 | 内容 |
|---|---|
| **报告日期** | 2026-09-08 |
| **代码基线** | `d3906fd`（v1.10.1，`main`） |
| **严重级别** | P1（数据丢失：用户/AI 提交的估时被静默丢弃，且无任何报错） |
| **影响范围** | 仅 `workbench_submit_idea_tasks`（点子落地）路径；`workbench_submit_task` 与 `workbench_propose_subtasks` **正常** |
| **发现方式** | 头脑风暴会话中提交点子落地提案后，核对 DB 发现全部任务 `estimated_minutes` 为 NULL |
| **是否静默** | 是——工具返回成功、草稿 payload 里也有值，只有最终任务表里没有 |

---

## 1. 现象

调用 `workbench_submit_idea_tasks` 提交带 `estimated_minutes` 的任务树，用户在界面确认草稿后：

- **草稿 payload 里字段存在**（`tasks[].estimated_minutes` 有值）；
- **创建出的任务 `estimated_minutes` 全部为 `NULL`**；
- 工作台界面「预计耗时」显示为空，AI 智能排序/日报等依赖估时的功能拿不到数据；
- **没有任何警告或错误**。

实测证据（本机 `~/.dsh/workbench/workbench.db`）：

```
draft 68e9fcc1-da3d-4435-ba77-06cca5b161c3 (confirmed)
  → tasks[0].estimated_minutes = 1095     ← 草稿里有
  → children[0].estimated_minutes = 180   ← 草稿里有

tasks 表
  → 总数 21，其中 estimated_minutes 非 NULL 的数量 = 0   ← 任务表里全丢了
```

---

## 2. 复现步骤

### 2.1 最小复现

1. 确保工作台里至少有一个点子（拿它的 id，记为 `<IDEA_ID>`）。
2. 在任意会话调用工具：

```jsonc
workbench_submit_idea_tasks({
  "source_idea_ids": ["<IDEA_ID>"],
  "summary": "复现用",
  "tasks": [
    {
      "title": "复现任务",
      "type_code": "code_impl",
      "priority_code": "p1",
      "estimated_minutes": 90
    }
  ]
})
```

3. 工具返回：`点子落地任务提案已保存（id=...，1 个任务），等待用户确认后创建。`
4. 在工作台界面确认该草稿。
5. 查询任务：`estimated_minutes` 为 `NULL`。

### 2.2 直接查库验证（任选其一）

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.dsh/workbench/workbench.db',{readOnly:true});console.log(db.prepare('SELECT COUNT(*) total, COUNT(estimated_minutes) with_est FROM tasks').get())"
```

或查草稿 payload 与任务表对照：

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.dsh/workbench/workbench.db',{readOnly:true});const d=db.prepare(\"SELECT payload_json FROM task_drafts WHERE kind_code='idea_tasks' AND status_code='confirmed' LIMIT 1\").get();console.log(JSON.parse(d.payload_json).tasks[0].estimated_minutes)"
```

**预期**：两处一致。
**实际**：草稿有值、任务表为 NULL。

---

## 3. 根因

`confirmIdeaTaskDraft()` 在建任务时**只读 camelCase 的 `item.estimatedMinutes`**，而工具把用户传入的 **snake_case `estimated_minutes` 原样存进 payload**。

### 3.1 缺陷代码

`src/db/repo.ts:1937`（`confirmIdeaTaskDraft` → `walk()`）：

```ts
const task = createTask(db, {
  title,
  description: typeof item.description === 'string' ? item.description : undefined,
  typeCode,
  priorityCode,
  dueAt: typeof item.dueAt === 'string' ? item.dueAt : typeof item.due_at === 'string' ? item.due_at : null,
  estimatedMinutes: typeof item.estimatedMinutes === 'number' ? item.estimatedMinutes : null,   // ← 只认 camelCase
  aiPolicyCode: validCode('ai_policy', typeof item.aiPolicyCode === 'string' ? item.aiPolicyCode : undefined, 'consult'), // ← 同类问题，见 §5
  parentId,
  extra: { sourceIdeaIds, sourceClusterId, source: 'idea' },
}, actor, at)
```

注意**同一个对象字面量里**，`typeCode`/`priorityCode`/`dueAt` 都写了双形态兼容（`item.typeCode ?? item.type_code`、`item.dueAt` 或 `item.due_at`），**唯独 `estimatedMinutes` 漏了 `item.estimated_minutes`**。

### 3.2 为什么 payload 里是 snake_case

工具参数名与文档都是 snake_case（`src/tools.ts:249`）：

```ts
'任务数组，每项 {title, description?, type_code?, priority_code?, due_at?, estimated_minutes?, ai_policy_code?, children?}。'
```

而工具的 `normalize()` 只补 `title`/`children`，**其余键原样保留**（`src/tools.ts:270-279`）：

```ts
const normalize = (items: unknown[], depth = 1): unknown[] => {
  if (depth > 3) return []
  return items.slice(0, 20).map((rawItem) => {
    const item = (typeof rawItem === 'object' && rawItem !== null ? rawItem : {}) as Record<string, unknown>
    return {
      ...item,                                     // ← estimated_minutes 原样带过来
      title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title : '(未命名任务)',
      children: normalize(Array.isArray(item.children) ? item.children as unknown[] : [], depth + 1),
    }
  })
}
```

所以 `item.estimatedMinutes === undefined` → `null`。

### 3.3 三条确认路径的写法不一致（这是 bug 的温床）

| 路径 | 位置 | 读取的键 | 上游传入的键 | 结果 |
|---|---|---|---|---|
| `workbench_submit_task` → `confirmTaskDraft` | `repo.ts:696` | `payload.estimatedMinutes` | 工具已归一为 camelCase（`tools.ts:96`） | ✅ 正常 |
| `workbench_propose_subtasks` → `confirmSubtaskPlanDraft` | `repo.ts:728` | `item.estimated_minutes` | snake_case（`tools.ts:420`） | ✅ 正常 |
| **`workbench_submit_idea_tasks` → `confirmIdeaTaskDraft`** | **`repo.ts:1937`** | **`item.estimatedMinutes`** | **snake_case** | ❌ **丢失** |

三条路径各写各的，第三种正好写反了。

---

## 4. 修复建议

### 方案 A（推荐，最小改动）：在 `confirmIdeaTaskDraft` 里补双形态兼容

`src/db/repo.ts:1937` 改为：

```ts
estimatedMinutes: typeof item.estimatedMinutes === 'number'
  ? item.estimatedMinutes
  : typeof item.estimated_minutes === 'number' ? item.estimated_minutes : null,
```

**理由**：与该函数内既有的 `typeCode/type_code`、`priorityCode/priority_code`、`dueAt/due_at` 写法完全一致；改动 1 行、零副作用；不触碰工具层与另外两条正常路径。

### 方案 B（可选加固）：三条路径统一走一个小工具函数

如果希望根治这类不一致，可加一个 `readMinutes(item)`（camel/snake 双读）并让三处都调用它：

```ts
const readMinutes = (item: Record<string, unknown>): number | null => {
  if (typeof item.estimatedMinutes === 'number') return item.estimatedMinutes
  if (typeof item.estimated_minutes === 'number') return item.estimated_minutes
  return null
}
```

> 注意：`confirmTaskDraft`（`repo.ts:696`）读的是**已归一化**的 payload，改成双读也无害。

### 不建议

- **不要**在工具层把 snake_case 改写成 camelCase：会同时打断 `confirmSubtaskPlanDraft`（它读 snake_case）。
- **不要**只改工具描述让调用方传 camelCase：工具对外契约已公开为 snake_case，且历史草稿里存的都是 snake_case。

---

## 5. 同一类问题的第二个字段：`ai_policy_code`

`repo.ts:1939` 同样只读 camelCase：

```ts
aiPolicyCode: validCode('ai_policy', typeof item.aiPolicyCode === 'string' ? item.aiPolicyCode : undefined, 'consult'),
```

而工具文档写的是 `ai_policy_code?`。因此传 `ai_policy_code: 'execute'` 会被**静默忽略**并回落为 `consult`。

- 影响比估时小（默认值就是 `consult`），但**同样静默**；
- **证据等级**：本报告未实测（本次会话没传该字段），结论来自代码路径推断；
- **建议**：与方案 A 一并修：

```ts
const rawAiPolicy = typeof item.aiPolicyCode === 'string'
  ? item.aiPolicyCode
  : typeof item.ai_policy_code === 'string' ? item.ai_policy_code : undefined
aiPolicyCode: validCode('ai_policy', rawAiPolicy, 'consult'),
```

---

## 6. 预期结果 / 验收标准

修复后应满足：

1. **复现步骤 2.1** 中，确认草稿后任务的 `estimated_minutes` 等于工具传入值（90），而不是 NULL；
2. **整棵树**（含 `children` 与更深层级）的估时都正确落库；
3. `ai_policy_code` 传入 `execute` 时，任务 `ai_policy_code` 为 `execute`（而非 `consult`）；
4. 工作台界面任务详情的「预计耗时」正常显示；
5. **不回归**：
   - `workbench_submit_task`（含 `subtasks`）的估时仍正常；
   - `workbench_propose_subtasks` 的估时仍正常；
   - `workbench_update_task` 通过 UI/接口改估时仍正常。

### 建议补充的自动化测试

在 `test/db.test.mjs` 或 `test/tools.test.mjs` 增加用例：

```js
// 用例：idea_tasks 草稿的 snake_case estimated_minutes 必须落库
const draft = createDraft(db, {
  kindCode: 'idea_tasks',
  payload: {
    sourceIdeaIds: ['<seed-idea-id>'],
    tasks: [
      { title: 'A', type_code: 'code_impl', priority_code: 'p1', estimated_minutes: 90,
        children: [{ title: 'A1', type_code: 'code_impl', priority_code: 'p2', estimated_minutes: 30 }] },
    ],
  },
})
const created = confirmIdeaTaskDraft(db, draft.id)
assert.equal(created[0].estimatedMinutes, 90)
assert.equal(created[1].estimatedMinutes, 30)   // 子任务同样要覆盖
```

---

## 7. 相关上下文（供修复者参考）

- 该 bug 是在「工作台任务提醒接入微信」的头脑风暴会话中发现的，完整方案见
  `docs/design/2026-09-08-wechat-task-reminder.md` §7.6。
- 同一会话还发现另外 3 个问题（**不属于本报告范围**，但建议一并排期）：
  1. **同一份 idea 草稿可被重复确认**，导致任务树重复创建（该会话实测产生 41 个任务，需人工清理 20 个）；
  2. **没有删除任务的路由**（只有 `archiveTask`），误建任务只能改 DB 或归档；
  3. **客户端不支持拖拽改父级**，任务结构建错只能重建。
- 清理方法（本会话已实际执行过一次，可复用）：见设计文档 §9。
