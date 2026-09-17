# 今日容量算法规格与交付说明

任务：`7d9bb4ec-6400-44df-b14d-6e445f0203b8`（feature_opt / p2）
分支：`feat/capacity-rules-transparency`｜基线 `main` @ `03fcdb5`
方案（咨询会话产出，未改）：[`2026-09-25-capacity-rules-plan.md`](./2026-09-25-capacity-rules-plan.md)
并行会话交接：[`2026-09-17-parallel-session-handover.md`](./2026-09-17-parallel-session-handover.md)

本文件是**交付说明**：算法规格、手算基准、刻意差异、已知边界、验证矩阵与门禁结果。
方案文档写的是"打算怎么做"，本文件写的是"实际做成了什么、哪一层验过了"。

---

## 一、权威源与分层

| 关注点 | 唯一权威源 | 说明 |
|---|---|---|
| 容量怎么算 | **`src/client/capacity.ts`**（纯函数 `computeTodayCapacity`） | 不 import React、不碰 DOM、`now` 显式入参；**不上移服务端**（容量是派生视图量，上移会引入两处实现） |
| 界面怎么画 | `src/client/components/CapacityRulePanel.tsx` | **只吃 props**，不自己求和、不自己判"今天到期"（有源码级断言守） |
| 口径偏好 | `settings`（服务端 meta） | `defaultEstimateMinutes` / `dailyCapacityIncludeOverdue`；面板与设置页写**同一个键**，界面不存第二份副本 |
| 耗时怎么落库 | 服务端 `routes/helpers.ts#clampEstimateForStorage` | 与客户端 `clampEstimatedMinutes` **同构的两份实现**（客户端与宿主是两个编译容器），由跨模块等价性断言钉住不许漂移 |

**调用点注意**：`computeTodayCapacity` 接收**全量任务列表**（含 archived / done / cancelled），
**过滤在函数内做**。调用点先滤一遍就是"同一语义两处算"——本项目最大的 bug 类别。

---

## 二、算法规格（改完之后，界面上一字不差地这么写）

设 `open` = `!archived && status ∉ {done, cancelled}`，`effectiveDueAt` = 自身 `due_at` 优先、
否则沿父链向上取最近祖先的 `due_at`（仓储层已算好，容量函数不重算继承）：

1. `effectiveDueAt` 落在**今天本地日** → 计入，理由 `due-today`（**继承来的同样参与**）；
2. 自身与继承**都为 null**且 `status ∈ {doing, blocked}` → 计入，理由 `no-due-doing`；
3. `effectiveDueAt < 今天 00:00` → **逾期**：默认**不计入**，开关打开才计入（与第 1 条互斥，不会算两遍）；
4. 其余 → 不进任何账本。

时长取值：

- `estimatedMinutes` 是**有限整数且 ≥1** → 用它（`>1440` 夹到 1440）；
- `null` / `0` / 负数 / 非有限 / 小数 / 非数字 → 视为**没填** → 用 `defaultEstimateMinutes`（缺省 30，夹 5–1440）。

汇总：

```
planned = Σ 计入任务的分钟
free    = max(0, 可投入 − planned)
over    = planned > 可投入
total   = max(可投入, planned, 1)      // 第三项只为避免除零，正常路径不可达
byPriority: p0/p1/p2/p3（未知优先级归 p3）
```

**账本两半**（界面显示的每个数字都要在里面找到出处）：

- `included[]`：`{id, title, minutes, band, estimated, usedFallback, allDay, overdueIncluded, inheritedDue, ghostFromCancelledAncestor, dueUnparseable, source, chainId}`
- `overdueExcluded[]`：同一形状；表尾 `合计 = planned`
- 三个计数：`dueTodayCount` / `noDueDoingCount` / （开关打开时的逾期计入条数）→ `aria-label` 直接用它们

**全天任务**：与普通任务**同算法**（`allDay` 只影响展示与重复锚点）。容量问的是"投入多少时间"，
全天只说明"什么时候"，所以 3 小时的全天任务 = 180 min，不吃"整天 480"。

---

## 三、手算基准（`test/fixtures/capacityFixture.mjs`，测试与 harness 共用同一份）

`now = 2026-09-16 15:00` 本地（`new Date(2026, 8, 16, 15, 0, 0)`，**本地组件构造**，不用带时区的 ISO 串），
可投入 300，默认耗时 30。

| id | status | 优先级 | due | minutes | allDay | 判定 | 计入 |
|---|---|---|---|---|---|---|---|
| T1 | todo | p0 | 09-16 18:00 | 60 | 否 | 今天到期 | 60 |
| T2 | todo | p1 | 09-16 18:00 | null | 否 | 今天到期 + 默认 30 | 30 |
| T3 | doing | p2 | null | 120 | 否 | 无截止在推进 | 120 |
| T4 | todo | p2 | null | null | 否 | 不满足 | 0 |
| T5 | todo | p1 | 09-14 18:00 | 480 | 否 | 逾期（默认排除） | 0 |
| T6 | todo | p0 | 09-15 18:00 | 480 | 否 | 逾期（默认排除） | 0 |
| T7 | todo | p2 | 09-16 00:00 | 180 | **是** | 今天到期（与普通同算法） | 180 |
| T8 | done | p0 | 09-16 18:00 | 999 | 否 | 不在 open | 0 |
| T9 | cancelled | p0 | 09-16 18:00 | 999 | 否 | 不在 open | 0 |
| T10 | todo | p0 | 09-16 18:00 | 999 | 否 | archived | 0 |
| T11 | todo | p3 | null（继承 T1） | null | 否 | 今天到期 + 默认 30 | 30 |

| 场景 | planned | byPriority | free | over | total | counted | dueTodayCount | noDueDoingCount | fallbackCount |
|---|---|---|---|---|---|---|---|---|---|
| 默认 | **420** | `{p0:60, p1:30, p2:300, p3:30}` | 0 | true | 420 | 5 | **4** | 1 | **2** |
| 开关开 | **1380** | `{p0:540, p1:510, p2:300, p3:30}` | 0 | true | 1380 | 7 | 4 | 1 | 2 |
| 默认耗时 60 | **480** | — | — | — | — | 5 | — | — | 2 |

**记账自洽断言**（防"账本好看但对不上"）：

```
sum(included[].minutes)        === planned
sum(overdueExcluded[].minutes) === overdueMinutes
counted                        === included.length
dueTodayCount + noDueDoingCount + (逾期计入条数) === counted
byPriority 四档之和            === planned
```

### 这些数字被两套实现复核过（重要）

夹具的期望值是**手算**的，而"错的期望值"配"照抄期望值的实现"会全绿。所以
`scripts/repro/verify-capacity-fixed-dataset.mjs` 用**另一套写法**（时间戳比较、显式循环、
不共享任何工具函数）再算一遍。它当场抓出 2 个手算错误：

- `dueTodayCount` 3 → **4**（T11 继承父任务 T1 的截止，也算"今天到期"）；
- `includeOverdue` 下的 `p1` 30 → **510**（漏了 T5 的 480）。

**执行本任务的第一步就是跑它**（输出"完全一致 0 处不符"才继续）。

---

## 四、三处刻意差异（改回去会变红）

| # | 差异 | 为什么 | 谁守着 |
|---|---|---|---|
| 1 | `estimatedMinutes: 0` 旧代码算 0 分钟，新代码按"没填"走默认 | 旧口径会让容量条**静默少算**一件任务的成本（"0 分钟的任务"其实不存在） | `test/capacity.test.mjs`「刻意差异（防改回）」 |
| 2 | **脏 due 串**（`Date.parse` → NaN）进账本但**不算逾期** | 它既不是今天也不是逾期；静默丢掉 = 用户看到"少了一条又没人说"。它进 `overdueExcluded` 并标 `dueUnparseable`，但**不计入** `overdueMinutes`（否则"逾期 10 条 / 750 min"这类读数会虚高），也**不受开关影响** | `test/capacity.test.mjs` 非法 due 用例 + `test/capacityPanel.test.mjs` 独立成区用例 |
| 3 | 逾期**默认不计入**（方案 C：默认不算 + 界面写清 + 默认关的开关） | 逾期是历史欠账，混进"今天要做的事"会让读数失去意义 | 基准 1（420）与基准 2（1380）两条断言 |

---

## 五、决策锁定（D1–D8）与落地位置

| # | 决策 | 落地 |
|---|---|---|
| D1 | 逾期默认不计入 + 默认关的开关（存服务端 meta） | `settings.dailyCapacityIncludeOverdue`（meta `daily_capacity_include_overdue`，缺省 `'0'`）；面板开关 + 设置页开关写同一个键 |
| D2 | `estimatedMinutes` 区间 1–1440；`0`/负/非有限/小数 → `null`；`>1440` → 1440 | `capacity.ts#clampEstimatedMinutes`（客户端）+ `routes/helpers.ts#clampEstimateForStorage`（服务端），跨模块等价性断言 |
| D3 | 默认耗时 30，设置页可改（5–1440），存 meta | `settings.defaultEstimateMinutes`（meta `default_estimated_minutes`）；设置页「今日容量」区 |
| D4 | 全天任务不改变容量计算 | `allDay` 在 `computeTodayCapacity` 里**只被读进账本**，不参与判定（同 minutes 的普通任务结果逐值相同，有断言） |
| D5 | 幽灵逾期本次不修语义，账本标注来源 | `ghostFromCancelledAncestor`（沿父链找 cancelled 祖先），界面标记「继承自已取消父任务」 |
| D6 | 父子不去重，账本给同链标记 | `chainId`（最近祖先 id，顶层取自身 id）；父子都计入有断言 |
| D7 | 权威源是客户端纯函数 `src/client/capacity.ts` | 未上移服务端 |
| D8 | 不 bump 版本（仍 1.15.1）；装盘需用户显式授权；绝不自行重启 | 本会话**未装盘、未重启** |

---

## 六、验证矩阵（验收标准 → 怎么证 → 实测）

| 验收标准 | 怎么证 | 实测 |
|---|---|---|
| 界面上能查到完整规则：已排怎么算、全天怎么算、逾期怎么计 | `test/capacityPanel.test.mjs` 真渲染断言七条规则逐字 + `harness --case capacity` 像素级 | 20/20 通过 |
| 任务设置页可改耗时，改完立即影响今日容量，刷新后保持 | `test/capacityWiring.test.mjs`（源码抽取 `saveEditDraft` + 注入桩，断言 payload 与乐观更新）+ 真机脚本 `repro-task-estimate.mjs` | 单测通过；**真机待装盘后跑**（见 §7） |
| 固定数据可手工复算，界面「已排」与手算一致 | 11 行基准表 → 单测断言 `planned=420`；harness 断言**页面上就显示 420**；`verify-capacity-fixed-dataset.mjs` 打印同组数字 | 三处同源，全绿 |
| 给出修前/修后对照说明 | `_local-archive/capacity/before-after.md`（用 `compare-capacity-before-after.mjs` 的实测输出） | 口径一致性 "全部一致 ✓" |

**反向验证（真做了）**：`scripts/repro/probe-capacity-mutations.mjs` **19/19 全红**：

| 变异 | 期望变红的地方 |
|---|---|
| M1 `?? 30` → 写死 0 | 基准 1（planned / fallbackCount） |
| M2 去掉 done/cancelled 过滤 | 基准 1（T8/T9 被计入） |
| M3 去掉 archived 过滤 | 基准 1（T10 被计入） |
| M4 逾期改默认计入 | 基准 1（planned 变 1380） |
| M5 全天改按 480 计 | 全天与普通同结果用例 |
| M6 `free` 去掉 `max(0,·)` | 超支用例（free 变负） |
| M7 未知优先级归 p0 | 未知优先级用例 |
| M8 `fallbackCount` 漏算继承那条 | 基准 1（变 1） |
| M9 默认耗时写死 30 | 基准 3（改 60 后 planned 不变） |
| **M10** memo 依赖塞回 `now` | 接线测试（依赖数组断言） |
| **M11** payload 删 `estimatedMinutes` | 接线测试（桩收到的实参） |
| **M12** `editDraft` 初值改常量 | 接线测试（源码抽取初值表达式） |
| **M13** 删掉客户端校验 | 接线测试（非法值必须不发请求） |
| **M14** 删掉乐观更新 | 接线测试（`setTasks` 被调 + 幂等） |
| **M15** 面板开关取值换成常量 | 面板渲染测试（勾选态） |
| **M16** 面板自己求和 | 接线测试（组件体不许有 `.reduce(`） |
| **M17** 逾期读数含脏 due 串 | 面板渲染测试（读数与 aria-label） |
| **M18** 全天口径写成 480 | 面板渲染测试（规则文案） |
| **M19** 开关勾选态写死 false | 面板渲染测试（真控件） |

M10–M19 是**接线类**变异：它们不改纯函数，纯函数测试照样全绿，但功能确实坏了。
这是"接线本身有没有被测试锁住"的证据（只测纯函数是不够的）。

---

## 七、门禁结果与交付状态

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm test` | **505/505**（基线 448 → **+57**） |
| 变异探针 | **19/19 全红** |
| `harness-real-browser.mjs --case capacity` | **20/20**；`--case listview` **32/32**（未退化）；`--case all` **51/51** |
| 固定数据集 | `verify-capacity-fixed-dataset.mjs` → 完全一致（0 处不符） |
| 真库口径（两份独立实现） | `已排 0 / 逾期 10 条 / 750 min` 一致 |
| 版本号 | **未 bump**（仍 1.15.1，按 D8） |
| 装盘 | **未做**（需用户显式授权） |
| 重启 | **未做**（绝不自行重启） |

### ⚠️ 未完成的一项（如实标注）

**真机端到端**（`scripts/repro/repro-task-estimate.mjs`）**未跑通完整断言**：
跑中的 3080 实例仍是旧 bundle（本会话未装盘），脚本开头的接线门禁如实拒绝并非零退出。
脚本自身已验证可用的部分：**建临时任务 → 门禁拒绝 → `finally` 清理成功并回读确认**。

用户授权装盘并重启后，跑一次即可收尾：

```powershell
node scripts/repro/repro-task-estimate.mjs --token <新 token>
# token 从 ~/.dsh/logs/dsh-web.log 的 "dsh web: http://127.0.0.1:3080/?token=..." 取
```

它会在**临时任务**上验证：不刷新「已排」正好 +123、`F5` 后仍 123、重开弹窗回显 123、
库里 `estimatedMinutes=123`、非法值 99999 被就地阻止（弹窗不关、有红字、库里值不变），
结束时取消并归档该临时任务（**工作台没有 DELETE 端点**，只有取消与归档）。

---

## 八、并行会话隔离（两个会话改同一个本地仓库）

详见 [`2026-09-17-parallel-session-handover.md`](./2026-09-17-parallel-session-handover.md)。要点：

- 本会话全程在**独立 git worktree** `E:\Code\dsh-personal-workbench\capacity-wt`，
  分支 `feat/capacity-rules-transparency` —— 主工作区（另一个会话的知识草稿改动）**一行未碰**；
- 文件级归属与共享文件的行级分工写在交接文档里；本会话新增的用例名统一带 `[容量]` 前缀便于区分；
- 两边都从 `03fcdb5` 出发，`git merge --ff-only` 或 rebase 即可，冲突面极小。

---

## 九、提交序列

| 提交 | 内容 |
|---|---|
| `4803417` | `refactor(capacity)` 抽出纯函数 + 基准夹具 + 等价性对拍 + 服务端夹取 + 两个新设置键 |
| `5825037` | `feat(capacity)` 规则与账本可见（含逾期口径开关）+ harness 参数化与容量批 |
| `8c15179` | `feat(tasks)` 真机复现脚本（临时任务 + 清理断言） |

（P3 的界面部分——编辑弹窗耗时/全天、行内校验、乐观更新、详情行、新建表单——与 P4 的设置页控件
已分别并入前两个提交，因为它们与"能编译、能测"是同一步。提交信息里逐条写明了改动与验证。）
