# BUG：`workbench_submit_task` 的子任务 `type_code` 不在字典中时被静默丢弃（无任何报错）

| 项 | 内容 |
|---|---|
| **报告日期** | 2026-09-12 |
| **代码基线** | `d39cc3d`（v1.13.3，`main`） |
| **严重级别** | P1（数据丢失：用户/AI 提交的子任务被静默丢弃，且无任何提示；关键实施步骤可能整段消失） |
| **影响范围** | `workbench_submit_task` 的 `subtasks` 参数在**确认草稿**时创建子任务的路径（`confirmTaskDraft` → `walkChildren`） |
| **发现方式** | 提交「1 父任务 + 5 子任务」，用户在界面确认后回查 DB，发现只创建了 3 个子任务 |
| **是否静默** | 是——工具返回成功、草稿 payload 里 5 个子任务齐全、确认接口返回 200，只有最终任务表里少了 2 个 |

---

## 1. 现象

调用 `workbench_submit_task`，提交 1 个父任务 + 5 个子任务（P1–P5）。用户在界面确认后：

- **草稿 payload 里 5 个子任务全部存在**（`payload.subtasks` 长度 = 5）；
- **实际只创建了 3 个子任务**（P1 / P2 / P4）；
- 丢失的 P3 / P5 在 `tasks` 表里**完全不存在**，也没有任何告警、日志或界面提示；
- 父任务与其余 3 个子任务创建正常。

实测证据（本机 `~/.dsh/workbench/workbench.db`）：

```
草稿 30f45a8f-fec5-41df-89d6-15a13af1194c  status_code = confirmed
  payload.subtasks = 5 项
    [0] P1 服务端…        type_code = code_impl
    [1] P2 DSH 插件单机版… type_code = code_impl
    [2] P3 部署 VPS…      type_code = ops        ← 丢失
    [3] P4 内网 GPU…      type_code = code_impl
    [4] P5 团队接入…      type_code = ops        ← 丢失

tasks 表（parent_id = 2287f2e7-d9fb-488b-abd6-eb85472d778c）
  6f61b6ef  code_impl        P1 服务端…
  806e5e81  code_impl        P2 DSH 插件单机版…
  22e65b52  code_impl        P4 内网 GPU…
  → 共 3 个，P3/P5 不存在
```

**丢件的共同点**：`type_code = "ops"`。而 `ops` **不在工作台类型字典里**。

---

## 2. 复现步骤

1. 用 `workbench_submit_task` 提交一个父任务，`subtasks` 里包含一项
   `{"title": "部署到 VPS", "type_code": "ops", "priority_code": "p2"}`；
2. 在工作台界面确认该草稿；
3. 查询 DB：

```sql
select id, title, type_code from tasks where parent_id = '<父任务id>';
```

**期望**：子任务被创建（或至少报错/告警，指出 `ops` 不是合法类型）。
**实际**：该子任务不存在，无任何提示。

---

## 3. 根因

`lib/db/repo/drafts.js` → `confirmTaskDraft()` → `walkChildren()`（L113–L127）：

```js
const rawChildren = Array.isArray(payload.subtasks) ? payload.subtasks : [];
const walkChildren = (items, parentId) => {
    for (const item of items) {
        const normalized = toTaskInputFromDraftItem(item, { typeCode: task.typeCode, priorityCode: task.priorityCode, statusCode: 'todo', source: 'nl' });
        if (normalized === undefined)
            continue;
        const { input } = normalized;
        if (getDictionary(db, 'type', input.typeCode)?.active !== 1)
            continue;                                    // ← L120-121 静默丢弃
        if (getDictionary(db, 'priority', input.priorityCode)?.active !== 1)
            continue;                                    // ← L122-123 同样静默
        const child = createTask(db, { ...input, parentId }, actor, at);
        if (Array.isArray(item.children))
            walkChildren(item.children, child.id);
    }
};
```

三点加剧了这个 bug 的严重性：

1. **没有任何补偿路径**：没有告警、没有写入"被跳过的条目"记录、没有返回给调用方。
2. **`createTask` 本身不校验 `type_code`**（`lib/db/repo/tasks.js:11-18` 直接 `typeCode: input.typeCode` 入库），
   所以这个 `continue` **不是防崩溃**——去掉它并不会让确认流程报错，只是会把非法值原样写进库。
3. **递归无提示**：`walkChildren` 递归处理 `item.children`，若父层被跳过则**整棵子树一起消失**，
   而调用方看起来一切正常。

---

## 4. 触发条件（为什么容易踩到）

`workbench_submit_task` 的工具描述里 `type_code` 写的是：

> 任务类型 code，如 client_meeting / code_impl

**"如"看起来像举例（开放式），实际是封闭枚举**——合法值只有 9 个：

| code | 名称 | | code | 名称 |
|---|---|---|---|---|
| `client_meeting` | 客户交流 | | `team_mgmt` | 团队管理 |
| `code_impl` | 代码实现 | | `project_delivery` | 项目交付 |
| `feature_opt` | 功能优化 | | `personal` | 个人生活 |
| `solution_design` | 方案设计 | | `training` | 培训学习 |
| `boss_request` | 老板要求 | | | |

AI（或用户）很容易自造 `ops` / `devops` / `infra` / `doc` 这类"看起来合理"的词，然后**丢件且无从察觉**。

---

## 5. 修复建议

### 方案 A（推荐）：不丢弃，落到草稿并告警

把 `continue` 改为"保留该项 + 记录问题"，让用户在确认界面看到：

```js
const problems = [];
const walkChildren = (items, parentId) => {
    for (const item of items) {
        const normalized = toTaskInputFromDraftItem(item, { ... });
        if (normalized === undefined) { problems.push({ item, reason: '无法规范化' }); continue; }
        const { input } = normalized;
        const typeOk = getDictionary(db, 'type', input.typeCode)?.active === 1;
        const prioOk = getDictionary(db, 'priority', input.priorityCode)?.active === 1;
        if (!typeOk || !prioOk) {
            problems.push({ title: input.title, typeCode: input.typeCode, priorityCode: input.priorityCode,
                            reason: !typeOk ? `类型 ${input.typeCode} 不在字典中` : `优先级 ${input.priorityCode} 不在字典中` });
            continue;
        }
        ...
    }
};
```

并在确认接口的响应里返回 `problems`，界面标黄列出"以下 N 项未创建及原因"。
**这样即使仍然跳过，也绝不静默。**

### 方案 B（更简单）：非法值回退到父任务类型

`input.typeCode` 不在字典时回退为 `task.typeCode`（父任务类型），优先级回退 `p2`，
并在任务 `extra` 里标记 `typeCodeFellBackFrom: 'ops'`。
优点：不丢件。缺点：语义被"猜"了，用户可能不知道类型不对。

### 方案 C（最小改动）：去掉校验，让非法值入库

由于 `createTask` 不校验，去掉 L120-123 即可让子任务全部创建，
但库里会出现字典外的 `type_code`，界面上可能出现空白标签——**不推荐**，只是把静默丢件换成了静默脏数据。

### 补充建议（与本 bug 独立，但能根治同类问题）

- **工具描述明确枚举**：把 `如 client_meeting / code_impl` 改为"**必须为下列之一**：…"，
  并在描述里说明"非法值会被拒绝"；
- **暴露字典查询能力**：给 AI 一个只读工具（或让 `workbench_submit_task` 的返回里附带合法枚举），
  使调用方不必靠猜——**"把合法取值下发给调用方"是这类问题的通用解法**；
- **确认后自查**：`confirmTaskDraft` 返回实际创建的子任务数量，与 `payload.subtasks` 长度不一致时告警。

---

## 6. 影响评估

- **数据丢失且不可恢复**：被丢弃的子任务在草稿里虽有记录，但用户确认后不会重放；
- **静默性最危险**：AI 调用方拿到"成功"响应，用户界面也无异常，
  双方都可能**在数天甚至数周后**才发现在某个实施步骤根本不存在；
- **本次实际后果**：差点漏掉「部署到 VPS」与「团队接入」两个阶段任务——
  它们是整个项目能否上线的关键环节；
- **同类风险**：`workbench_submit_idea_tasks` 与 `workbench_propose_subtasks` 若也有类似过滤逻辑，
  建议一并排查（本次未验证这两个路径）。

---

## 7. 环境

| 项 | 值 |
|---|---|
| 工作台版本 | v1.13.3（`d39cc3d`） |
| DSH | 0.1.5-rc.1 |
| 平台 | Windows 11 / Node v24.19.0 |
| 数据库 | 嵌入式 SQLite（`~/.dsh/workbench/workbench.db`） |
| 相关表 | `task_drafts`、`tasks`、`dictionaries` |

---

## 8. 附：验证用的只读查询

```powershell
# 查看合法类型码
python -c "import sqlite3;c=sqlite3.connect(r'file:C:\Users\<user>\.dsh\workbench\workbench.db?mode=ro',uri=True);print([r[0] for r in c.execute(\"select code from dictionaries where kind='type' and active=1\")])"

# 核对父任务下实际创建了几个子任务
python -c "import sqlite3;c=sqlite3.connect(r'file:C:\Users\<user>\.dsh\workbench\workbench.db?mode=ro',uri=True);print(list(c.execute(\"select id,title,type_code from tasks where parent_id='<父任务id>'\")))"
```
