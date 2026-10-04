# P6 新会话开工提示词（复制下面全部内容到新会话第一条消息）

---

接着做 D17「WorkbenchApp 拆分」的 **P6**。工作区 `<仓库根>`（本机绝对路径已脱敏），任务 id `8e5ea61d-0021-4317-8398-419b8501e6a9`（个人工作台任务「D17 客户端 WorkbenchApp 拆分」）。

## 0. 先读这四份，再动手（不要跳过）

1. `docs/tasks/8e5ea61d-0021-4317-8398-419b8501e6a9-D17客户端拆分/handover.md` —— **最重要的入口**。§1 一句状态、§2 模块树与依赖方向、§4 可复跑的出口自检与探针清单、**§5 剩余问题与硬约束（P6 之前必须逐条读完）**、**§6 下一步（P6 的四个域与落点表）**。
2. `docs/design/2026-09-09-client-split-backlog.md` —— §4 状态所有权清单（114 项完整映射）、§5 跨域刷新/轮询/持久化约束、§7 批次表（P6 行是出口口径）、§2.1 判据。
3. `docs/tasks/8e5ea61d-…/ownership.md` / `migration-matrix.md` / `verification.md` —— 已迁模块的唯一所有者表、批次 before→after、每批的命令证据与"后续批次预计会假红"登记表。
4. `docs/adr/0008-workbenchapp-exit-criteria.md` —— 验收口径（**2026-10-04 起**）。

## 1. 现状（P1–P5 已完成，数字都是实测）

- 入口 `src/client/index.tsx` = **3724 行**（施工起点 5725）；`WorkbenchApp` = 第 **205–2471** 行、**2267 行**（起点 4197）。
- **已达成三条硬门**：`WorkbenchApp` 体内 `setInterval` / `setTimeout` / `fetch` 均为 **0**。**不要回退**：P6 若需要轮询，复用 `hooks/useWorkbenchPolling.ts` 或另写同款"无业务状态的 effect 装配器"，绝不把定时器写回入口。
- 未清零：直接 `useState(` **27** 项、`api(` **27** 处、`useEffect(` **4** 条、单个顶层块 **≤80 行**（最长块 `startAISession` **500 行** —— 属 P6-3）。
- 十个出口自检脚本 + 十个反向变异脚本全绿：`scripts/lib/d17-p{1,2,3a,3b,3c,3d,4,5a,5b,5c}-exit-check.py`（32/49/47/56/67/103/161/137/152/151 项）与 `d17-mutate-*.py`。
- 六探针：20/20、17/17、19/19、46/46、**13/15**、**7/10**（后两个的失效锚点是**既有欠账**，登记在 `scripts/release-preflight.mjs:60` 的 `KNOWN_PROBE_DEBT`，**P6 正好顺手修**）。
- `pnpm test` = 992 / 991 / 1（唯一失败是既有 `db migrations…` 的 Windows `rmSync` EPERM）。
- **全部未 git commit**（P1–P5 都是 working tree 改动），版本号仍 1.16.2。

## 2. P6 的范围（四个域、27 项直接 state）

| 子批 | 域 | 落点与注意 |
|---|---|---|
| P6-1 | **导航域 Navigation（1 项）** | `view` / `setView` 一族；动手前先实测入口有多少处以 `setView` / `view ===` 出现再定边界。`openTaskById` 走**导航线**，不要与**表单线**合并 |
| P6-2 | **快速录入域 QuickIntake（9 项）** | `quickWorkspaceRecent` / `quickWorkspace` / `quickWorkspaceSource` / `quickWorkspaceTouched` 等；**必须同批处理跨域写点**：`rememberQuickWorkspace` / `forgetQuickWorkspace` 里的 `setSettings(withSettingsFallback(res.settings))`（handover §5 第 5 条 ④），改成"设置域交出 setter、快速录入域注入消费"；`test/quickWorkspaceDefault.test.mjs` 的 `saveSettings` 断言与探针 M6/M14 就在这条接线上 |
| P6-3 | **AI 会话域 AISessions（12+1 项）** | 12 个 state + `modelModalityTable`；**`startAISession`（500 行，最长顶层块）必须随本域搬走**（ADR-0008「不承载长 handler」）；`aiSessionUsable` 保持**注入回调**，不要搬进 hook |
| P6-4 | **目录选择域 DirectoryPicker（5 项）** | 目录选择相关 state 与动作；探针 B7/B8/B10（`probe-model-picker-notify-mutations.mjs`）的失效锚点在这条接线的 `quickModelSelection` → `modelSelection` 改名漂移上 |

## 3. 每批（每个子域）的固定动作 —— 一步都不能省

1. **只读测绘**：实测入口全部落点行号（state / ref / effect / 动作 / JSX 读点），并 grep 出**所有锚在这些符号上的既有判据与探针**（`test/*.mjs`、`scripts/lib/*.py`、`scripts/repro/*.mjs`）。先确认"只换 owner、不改调用点文本"能不能做到零重锚。
2. **写 hook**（把状态与动作搬走，注释块一并逐字搬）→ **写 cut 脚本** `scripts/lib/d17-cut-p6X.py` → 运行。
3. `npx tsc --noEmit`；复测换行风格（`CRLF: 0`）；用 `scripts/lib/d17-measure3.py` 口径复测 `WorkbenchApp` 行数与硬门。
4. **新建**该批出口自检 `d17-p6X-exit-check.py`（七/八节：入口不再自建 / 唯一所有者 / HTTP 归属与纯度 / 跨域注入 / 存活守卫与顺序 / 刻意留在装配层 / 结构指纹 / ADR-0008 硬门与度量）+ **反向变异** `d17-mutate-p6X.py`（**必须真跑出 N/N，不能只看"写完了"**）。
5. **十个（P6 后为十一个）出口自检全跑一遍** + **六个探针全跑一遍** + `pnpm test`（串行；跑前确认 `lib/build-info.json` 在，否则 `test/devVerify.test.mjs:204` 会 ENOENT 假红；探针运行期间不要同时跑 build/test）。
6. **回填证据**：`verification.md`（新批节 + 环境事实）、`ownership.md`（唯一所有者 + 已完成清单）、`migration-matrix.md`（批次总览 + 明细 + 后续预计假红）、`baseline.md`（只记施工起点与"最新度量"引注）、`handover.md`（§1/§2 树/§4 表/§5/§6）、设计文档状态行与 §7 表、父任务 `docs/tasks/36c8e8ef-1104-4e68-b55f-a2a6cc533ab9-工作台插件优化/todo.md` 的 D17 度量表。
7. `workbench_update_progress`（阶段性必报，**不要自行置为已完成**）+ `workbench_save_task_memory`（阶段结论/决策）。

## 4. 十二个已踩过的坑（照抄即可避）

1. **只换来源、不改调用点文本** —— 入口从 `const xxxApi = useWorkbenchXxx({...})` 解构出**同名**值，这样 JSX props、探针锚点、既有 `test/*.mjs` 断言都不用改（P2–P5 每批都是零改动）。
2. **hook 函数体第一行做别名**：`const { a, b, onError: setError, onNotice: setNotice, onToast: pushToast } = input` —— 这样搬过来的函数体逐字不改。
3. **"防双实现"判据的正则必须允许行首空白**：`^[ \t]*(?:const|function)\s+`（`^const` 会空洞通过，P5-1 踩过）；且必须有用例反证它真能红。
4. **`indexOf` 切片的判据第一句就 `assert.ok(start > 0)`**，否则锚点消失时空洞通过。
5. **本地 hook 的动作要进 `useEffect` 依赖数组，必须先 `useCallback` 自证身份稳定**（P5-3 踩过：否则每渲染重建 5 秒定时器）；把函数列进依赖数组（别只写注释声明等价），这样等价性可被静态检查看见。
6. **改任何已迁移文件的声明文本前，先 grep `scripts/lib/*.py` 有没有逐字锚在它上面**（P5-3 撞了 p5b 的两处 `tickDue` 锚点）。
7. **cut 脚本写回源码必须显式 `newline="\n"`**，落盘后复测 `CRLF: 0`（P5-2 把整份 `index.tsx` 写成 CRLF 的事故）。
8. **cut 脚本里的中文注释不要用直角引号 `"…"`** —— 与 Python 字符串引号冲突，`SyntaxError`（P5-2、P5-3 各踩一次）；用「」。
9. **cut 脚本末尾要设 `sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")`**，否则 GBK 控制台下 `print("✅ …")` 抛 `UnicodeEncodeError`（**注意落盘发生在 print 之前，文件其实已写好**）。
10. **跨批 `bare()` 口径会互相假红**：每批收尾必跑全部出口自检；判据要"跟着 owner 走"（owner 变了就改由新脚本守，并在旧脚本留下注释说明移交）。
11. **hook 调用点的落点由"上游符号先可用"决定，`const` 无提升**：先实测目标区间有没有引用本域符号。当前次序：`feedback` → `data`(actions) → `draftsApi`(L331) → `prefs`(L350) → `remindersApi`(L362) → …。更省事的做法是让上游 hook 尽量早。
12. **刻意留在装配层的不要挪**：`PENDING_ATTR` 宿主 DOM 投影 effect、`DraftBanner` 整块 JSX（`onDone` 同时写 knowledge/ideas/day 四域，且 `d17-p2-exit-check.py:53` 的 `"ideas.actions.refresh()" in INDEX` **唯一命中点就在这一行**，搬走 p2 立刻红）、`titlebarTimer`（插件 setup 作用域，不属 `WorkbenchApp`）。

## 5. 两个可以直接顺手清掉的欠账

- `probe-quick-workspace-mutations.mjs` 的 **M6 / M14** 两条失效锚点（`setQuickWorkspace(e.target.value)` 与 `showForget={...}` 的原文漂移）→ 随 P6-2 重锚。
- `probe-model-picker-notify-mutations.mjs` 的 **B7 / B8 / B10**（`quickModelSelection` → `modelSelection` 改名漂移）→ 随 P6-3/P6-4 重锚。
  两者清掉后 `node scripts/release-preflight.mjs --phase pre` 才可能退出 0（`KNOWN_PROBE_DEBT` 在 `scripts/release-preflight.mjs:60`）。
- 但**不要**在 P6 顺手做 P7 的事：10 个死 import 的清理、`views/*` 的 JSX 收口、`WorkbenchDialogs`/`WorkbenchToolbar` 的组件化，都留给 P7。

## 6. 交付口径

P6 完成的定义：四个域的状态/请求/effect/动作都有唯一所有者；入口不再自建本域任何东西；`WorkbenchApp` 体内 `useState` / `api` / `fetch` / 定时器继续单调下降；**每批**都有可复跑的出口自检 + 真跑出 N/N 的反向变异；十个（+新）出口自检与六探针全绿；`pnpm test` 无新增失败；五份证据文档与设计文档、父任务 todo 表已回填；进度与任务记忆已报。**`WorkbenchApp` ≤900 行护栏在 P6 收尾后按实测校准一次。**
