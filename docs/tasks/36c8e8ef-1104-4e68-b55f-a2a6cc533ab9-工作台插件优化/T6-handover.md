# T6 交接：完成本轮集成回归与验收交接（V05 / CP4）

任务 `cd8aa5f0-3f7f-4be0-939b-b3f38a9387e2`；2026-10-01。

- 权威规格：`requirements.md` §7（R-V）、`plan.md` V05 / CP4、`acceptance.md`（45 个 AX）、
  `legacy-regression.md`（43 个 LEG）、`subtasks.md`、`docs/adr/0006-dev-verify-chain.md`
- 前置：T1–T5 已交付。本项**逐个核对了它们的实现产物与交接**，不只看任务状态。
- **没有新增迁移**（`SCHEMA_VERSION` 仍是 19），**没有改公开版本号**（仍是 1.15.8），**没有 `git commit`**。

---

## 1. 一句话结论

T5 留下的那条验收链**已经真跑通了**：构建 → 装盘 → 零增量 diff → dump-config → 装后门禁 →
**按端口归属 kill 掉 3080 的归属进程并重启** → health → **抓 token 并真的认证通过** →
在隔离测试库上跑完 **8 套套件、102 条断言全绿**，证据包（含 39 张截图）落在
`test-results/workbench-verify/20261001-003218-0a5956/`。

链的最终退出码是 **1**，原因只有一个：`persona` 套件里"真实模型调用 `workbench_load_persona`"
那一层**本机拿不到**，按规格记 `skip` —— required 套件有跳过就不通过。这是**设计好的诚实**，
不是链没跑通。

---

## 2. 交付物

| 文件 | 角色 |
|---|---|
| `scripts/verify/suites/_harness.mjs`（新） | 8 套共享脚手架：结果收集、API 客户端、runId 合成资产、浏览器启动、证据写盘、退出码 |
| `scripts/verify/suites/legacy-acceptance.mjs`（新） | 旧回归 1/4：LEG-A01–A17（+ 1 条三方构建标识的浏览器判据） |
| `scripts/verify/suites/legacy-final-2.mjs`（新） | 旧回归 2/4：LEG-F01–F09 |
| `scripts/verify/suites/legacy-sidebar-collapse.mjs`（新） | 旧回归 3/4：LEG-S01–S06（心跳判据） |
| `scripts/verify/suites/legacy-duplicate-task.mjs`（新） | 旧回归 4/4：LEG-D01–D11（会写库，只对隔离库跑） |
| `scripts/verify/suites/progress.mjs`（新） | AX-P07/P08 的 B 层 |
| `scripts/verify/suites/daily-effort.mjs`（新） | AX-D07/D08/D09/C02/C05/C06 的 B 层 |
| `scripts/verify/suites/persona.mjs`（新） | AX-R07/R08：H 层真实 HTTP + B 层真实选择器 + M 层模型（拿不到就 skip） |
| `scripts/verify/suites/verify-safety.mjs`（新） | AX-V01–V09 在真实隔离实例上的复核 |
| `scripts/verify/suites.json`（改） | 8 套全部 active；顺序 verify-safety 提前（persona 会让链停） |
| `scripts/verify/runtime.mjs`（改） | 端口归属 `.ps1` 文件版、`detached` 重启、直接 `node bin.js`、token 取最后一个 + 真实认证、套件目标显式传参 |
| `scripts/verify/cdp.mjs`（改） | `mkdtemp` 前建父目录（否则浏览器起不来） |
| `scripts/dev-verify.mjs`（改） | token 阶段改口径；三方标识补读（成功路径 + `finally` 两处） |
| `test/verifySafety.test.mjs`、`test/devVerify.test.mjs`（改） | 判据随实现同步（**不是放宽**，每条都在本文件 §5 有实证） |
| `.dsh/skills/dsh-plugin-change/SKILL.md`（改） | 新增 §14「研发版本验收链」：怎么跑、加套件要动哪几处、写套件的硬纪律 |
| `README.md`（改） | 新增「研发版本验收链」入口 |
| `docs/tasks/36c8e8ef-…/T6-evidence-matrix.md`（新） | 45 个 AX + 43 个 LEG 的逐条证据矩阵 |

---

## 3. 真实命令与结果

```text
pnpm typecheck            → 退出码 0
pnpm build                → 退出码 0；buildId = wb-34aff1a8a9994230
pnpm test（全套）          → tests 878 / pass 877 / fail 1
                            唯一失败 = test/db.test.mjs 清理期 rmSync EPERM（T1 起就在，已回基线复现，未删断言）
node scripts/check-verify-scripts.mjs
                          → 退出码 0；现役 8 / 待迁移 0 / 作废 3 / 本地脚本 150 / 嫌疑 22（动态统计）
node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web \
  --profile-dir "C:\Users\<user>\.dsh\profiles\web" \
  --db-path "C:\Users\<user>\.dsh\workbench\verify-web.db"
                          → runId 20261001-003218-0a5956
                            阶段：preflight ✅ / version-before ✅ / build ✅ / install ✅ / profile-diff ✅ /
                                  dump-config ✅ / version-after ✅ / restart ✅ / health ✅ / token ✅ /
                                  suites ✖（persona 的 1 项 skip）/ cleanup-browser ✅
                            套件：verify-safety 20/20、legacy-acceptance 18/18、legacy-final-2 9/9、
                                  legacy-sidebar-collapse 6/6、legacy-duplicate-task 11/11、
                                  progress 13/13、daily-effort 13/13、persona 12/13（skip 1）
                            合计：102 passed / 0 failed / 1 skipped
```

证据核对（同一轮的 `summary.json`）：

```text
buildIdentity: 包 wb-34aff1a8a9994230 == health wb-34aff1a8a9994230 == 浏览器根属性 wb-34aff1a8a9994230
               clientMatched = true
dbIsolation:   independent = true
               target  = C:\Users\<user>\.dsh\workbench\verify-web.db
               current = C:\Users\<user>\.dsh\workbench\workbench.db
redaction:     secretsRegistered = 1；证据全树扫不到 token 原串
sideEffects:   installed = true；restarted = true；dbWrites = 0；browsersOpened = 0；tempDirsRemoved = 1
```

守护条件（运行前后各测一次）：

```text
正式库 ~/.dsh/workbench/workbench.db   → schema 18 / 94 条任务（未迁移）
测试库 ~/.dsh/workbench/verify-web.db  → schema 19 / 68 条合成任务（可弃）
19387（桌面端，pid 17564）              → 未重启、未 kill（CreationDate 仍是 2026-09-30 22:25:24）
3080（web 测试实例）                    → 由链按端口归属 kill 后重新拉起（pid 每轮变）
```

---

## 4. 本轮真实抓到的 12 个缺陷

逐条见 `T6-evidence-matrix.md` §5。其中**四个**是链自身的真 bug，且都在"第一次真跑"才暴露：

1. `detached: false` + `unref()` → 重启报 ok、health 永远等不到。
2. 走 `dsh.cmd`（多一层 cmd.exe）→ **stdout 落不进日志**，token 阶段必然 60s 超时。
3. `ConvertTo-Json -Compress` 输出 `{none:true}`（**非法 JSON**）→ 端口归属校验"说不出话"，
   而它的失败路径紧接着就是拉起实例。
4. **按 offset 读 token**：`dsh web` 起来会**截断**日志，于是读到**上一次启动**的 token ——
   欺骗性最强的一条：health 用 `Bearer` 打 API 照样 200，只有浏览器判据红，
   而红的是"侧栏没有工作台入口"（其实是认证页）。

另有两条"把环境当 fixture"的假红：容量绝对值断言、以及 `devVerify.test.mjs` 里
"本机 web profile 没有独立 DB 配置"这条**断言机器状态**的判据 —— 都已改成与真实配置/真实服务端读数比较。

---

## 5. 明确未验证（不得当作通过）

1. **AX-R07 的 M 层**：真实模型调用 `workbench_load_persona` 并返回角色正文。套件进程没有向
   DSH 宿主投递用户消息的能力（宿主没有对外的"新建会话并发送消息"HTTP 端点；会话记录是 zstd），
   所以只能记 `skip`。**解除条件**：用户在自己的正式实例上开一次带角色的 AI 会话，观察工具调用。
2. **公司内部角色库 九篇经 `personaExternalDir` 的浏览器可发现性**：本轮没有改用户设置（属运行环境变更）。
   T3 已用只读探针证明九篇可解析。
3. **桌面端（19387）装本轮构建后的体验**：不在本轮范围，是用户的上线判定。
4. **POSIX 上的自锁与端口归属**：`findPortOwner` 在非 Windows 上一律拒绝，本轮只在 Windows 跑过。

---

## 6. 给用户的上线判定清单

1. 桌面端（19387）**仍跑公开发布版**：本轮没有装盘到 desktop profile、没有重启 GUI。
   要在正式实例上用本轮的改动，需要走 `dsh-safe-plugin-ops` 把 dev 包装进 desktop 并重启应用。
2. 届时要人眼看的三件事（本轮已在测试实例上用真实鼠标+截图验过，但正式实例的观感只能由你看）：
   - 任务列表/详情/计划行的**进度条与「待验收」徽标**；
   - 计划项的**「今日投入结束 / 继续投入 / 完成任务 / 推迟截止一天」**四个动作；
   - 「快速录入」与共享提示词弹窗里的**角色选择器三态**（未指定 / 无角色 / 具体角色）。
3. 正式库 schema 仍是 18；插件支持 19。**装盘新构建后第一次启动会把正式库迁到 19**（单向，不可回退），
   这一步要在你确认后做。
4. 公开版本号、Release、npm 发布：本轮**没有动**，仍走 `dsh-release`。
