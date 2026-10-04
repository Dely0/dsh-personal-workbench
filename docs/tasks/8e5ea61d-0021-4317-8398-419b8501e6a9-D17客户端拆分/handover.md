# D17 交接（**浏览器验收链已在 3080 跑绿 + 已装盘**；剩余＝`git commit`）

## 0. P7 收尾版：现在在哪（**先读这一节**）

**代码侧 D17 已完成**：`src/client/index.tsx` **5725 → 1972 行**（累计 **-3753**），
`WorkbenchApp` **4197 → 631 行（入口第 92–722 行）**（累计 **-3566**）；

[ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md) 的**结构硬门全部达成**（`WorkbenchApp` 体内直接）：
`useState(` **0**、`api(` **0**、`fetch(` **0**、`setInterval(`/`setTimeout(` **0**、`useEffect(` **3**（刻意留装配层的投影/桥接），
单个顶层块 **41 个、超过 80 行的 0 个**（最大 66 行 `saveEditDraft`）；
行数护栏原 ≤900，按 ADR「P6 收尾后按实测校准一次」**校准为 ≤650**（写进 `scripts/lib/d17-p7b-exit-check.py`）；
设计 §2.1 的 **≤600 是努力目标、不是门**，实测 631（差 31 行，构成见 `verification.md` 的 P7 节）。

**P7 三批**：P7-1 入口最后 6 处业务请求归域（`2750 / 1325`）→ P7-2 四段 JSX 搬进 `src/client/app/`（`2102 / 673`）→
P7-3 清死 import 与死解构（`1972 / 631`）。

**门禁（全部真实执行过）**：`npx tsc --noEmit` **0**；`pnpm build` **0**（`lib/client.js` 549.00 kB / gzip 162.69 kB）；
`pnpm test` **993 / 992 通过 / 1 失败**（唯一失败＝既有 Windows `rmSync` EPERM，**0 回归**）；
**15 个出口自检 exit 0**（P5a 138 / P5b 152 / P5c 152 / P6b 155 / P6c 198 / P6d 96 / **P7a 72** / **P7b 220**，
P1–P4 只打印「结果：全部通过」）；**15 个变异脚本真跑 N/N 且还原后逐字节一致**；
**六个探针 0 存活**（model-picker 已从 7/10 修到 **10/10**）；
`node scripts/release-preflight.mjs --phase pre` **退出 0**（`KNOWN_PROBE_DEBT` 已清空）。

**浏览器链与装盘（2026-10-04 完成；完整证据见 `verification.md` 的「浏览器验收链与装盘」节）**：
走本仓库自己的研发验收链
`node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web --profile-dir "…\profiles\web" --db-path "…\verify-web.db"`，
**退出码 0** —— 装盘（**只有本插件那一行变**）→ 只重启目标实例（按端口归属 kill 旧 PID）→
health `version 1.16.2 / buildId wb-27d63c3bb09513e1 / schema 19`（**包 · host · client 三者一致**）→
**10 套白名单套件全绿**：verify-safety 20 / legacy-acceptance 18 / legacy-final-2 9 / legacy-sidebar-collapse 6 /
legacy-duplicate-task 11 / progress 13 / daily-effort 13 / **day-panel 11** / workspace-picker 8 / persona 12（+1 已登记 skip）。
证据包 `test-results/workbench-verify/20261004-113439-551e0e/`（含每套件截图）。
装盘后复检：`check-installed-fingerprint.mjs`（**`DSH_PROFILE_DIR` 必须显式指 web**，否则会去核对 desktop 的副本）**240/240 逐文件一致**、
`check-installed-version.mjs` ✅、`dsh --profile web --dump-config` exit 0。
**首轮曾红一条**：`day-panel` 的 AX-T03 主判据 **10/11** —— 实测是**套件自身的假红**
（进日历前页签停在「未排期」，而 `dayTab` 是今日/日历共用的一份 state；`src/client/hooks/useDayWorkspace.ts:390`），
**不是 D17 回归**（三条证据：套件相对 HEAD 无改动 + `git show HEAD:` 的 `dayTab` 处理逐条相同 + 受控顺序实测两侧行逐字相同）；
已按"**只归一前置状态、不改断言**"修好（进日历前补 `await clickTab('计划')`）。

**还没有做（不要当作已完成）**：
① **没有 `git commit`**（P1–P7 全部改动 + 本次套件修复都在工作树；`git show HEAD:src/client/index.tsx` 仍是 5725 行的 D17 之前版本）；
② **19387 / desktop 侧没有换版**：本次只装到 `web`(3080)，desktop 侧仍是 2026-10-02 的 dev 构建
（`wb-a4ca2b1f98cf3ea1` / pre-D17）——也就是说**本会话界面上看到的不是 D17 构建**；
③ 知识库 / 点子两条线仍**没有**白名单套件（只有一次性诊断截图 `test-results/workbench-verify/diag-views/`）；
④ 正式库未迁移、版本号仍 **1.16.2**。

**P7 新增/改动的文件**：
新增 `src/client/app/assembly.ts`、`src/client/app/WorkbenchHeader.tsx`(44) / `WorkbenchOverlays.tsx`(195) /
`WorkbenchBody.tsx`(224) / `WorkbenchDialogs.tsx`(358)、
`scripts/lib/{d17-p7a-exit-check.py, d17-mutate-p7a.py, d17-p7b-exit-check.py, d17-mutate-p7b.py, d17-cut-p7b.py}`、
一次性脚本 `d17-reanchor-p7b-{checks,tests,mutations}.py`、`d17-clean-unused.py`、`d17-tidy-p7b.py`、
`d17-reanchor-p7c-{checks,mutations}.py`；
改 `src/client/index.tsx`、`src/client/hooks/{useTaskData,useWorkbenchSettings}.ts`、
13 个旧出口自检、8 个旧变异脚本、9 个 `test/*.mjs`、
`scripts/repro/probe-quick-workspace-mutations.mjs`、`scripts/repro/probe-model-picker-notify-mutations.mjs`、
`scripts/release-preflight.mjs`（`KNOWN_PROBE_DEBT` 清空）、本目录四份证据文档。

**P7 的四条专属教训（后续谁再搬家都用得上）**：
① **搬 JSX 前先把"这段 JSX 依赖哪些绑定"算出来**：`d17-cut-p7b.py` 的做法是钉死边界行 → 扫 JSX 之外的绑定
（props / 解构 / 缩进 0–2 格声明 / import）→ 按来源分组生成 `const { … } = props.xxx`；
⚠️ 扫描**必须先剥注释与单双引号字符串（不动模板串）**，否则 `<Icon name="list" />`、`view === 'list'`、
注释里的 `openWorkspacePaths` 都会被算成依赖（剩下两个漏网之鱼进显式 denylist `ATTR_DENY`）。
② **搬完 JSX 入口会冒出上百个死解构**，清它是**独立的第三步**，而且顺序很重要：
先清死代码 → 再收排版 → **最后才重锚判据**（否则同一批要改两遍）。
③ **"冻结源码原文"的判据在搬家时一定打红**：正向断言指向真实 owner（`src/client/app/*.tsx` 或域 hook）
+ 入口侧补负向断言；所有权没有被放宽（唯一所有者仍由 `owners_of(...) == [owner]` 单独守）。
④ **重锚脚本本身有个坑**：同一文件里有多条补丁时，必须**累积到一份内存文本再写一次**；
逐条"读盘 → 替换 → 写盘"会让先写的被后读的原始内容覆盖（症状：脚本报成功、判据没变）。

## 1. 一句状态（**历史：P5-3 时的快照**，当前状态见 §0）

`docs/design/2026-09-09-client-split-backlog.md` 的 P0/P1/P2/P3-1/P3-2/P3-3/P3-4/P4/P5-1/P5-2/**P5-3** **代码已完成并自带证据**：
`index.tsx` **5725 → 3724**、`WorkbenchApp` **4197 → 2267**（距 ≤900 护栏还差 1367 行 —— 原「≤600」自 2026-10-04 起只是历史记录，验收口径已改为「结构硬门 + ≤900 护栏」，见 [ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md) 与本文 §6）；
`pnpm typecheck` / `pnpm build`（buildId `wb-3dae8edbe5fc55f1`）/ `pnpm test`（992/991/1，唯一失败是既有 db EPERM）均绿；
各批的出口自检脚本（32 / 49 / 47 / 56 / 67 / 103 / 161 / **137** / **152** / **151** 项）与反向变异脚本（2/2、3/3、4/4、6/6、7/7、8/8、11/11、11/11、12/12、**12/12**）都可复跑且全过；
容量探针 I1（P3-1，**P4 二次重锚到 `hooks/useDayWorkspace.ts`**）、I3（P3-2）已重锚，重锚后 **20/20 全红**；
**P5-1 把快速录入探针的 M12/M13 重锚到 `hooks/useWorkbenchSettings.ts`**（新增常量 `SETTINGS_HOOK`），
重锚后仍是 **13/15**（未发现的 M6/M14 与搬迁前同数，属 P6 既有欠账）；其余五个探针复跑无变化；
**P3-3 / P3-4 / P4 / P5-1 / P5-2 / P5-3 都不需要重锚除上述之外的锚点**（已逐条实测确认；P5-2 与 P5-3 六个探针零重锚）。
**⚠️ P5-2 起一条新的收尾纪律**：跑 `pnpm test` 之前若 `lib/build-info.json` 缺失（`lib/` 是 gitignored 构建产物），
`test/devVerify.test.mjs:204` 的 `V04-B/AX-V07：三方构建标识同源` 会 `ENOENT` 假红 —— 先 `pnpm build` 再跑全量即可（不是回归）。
**尚未 git commit、未装盘、未跑浏览器链、未跑 `release-preflight`。**

> ⚠️ **P4 已收尾，五个视图全部成组件**（判据 3 达成）。P3-1/P3-2/P3-4/P4 共用同一份 `probe-capacity-mutations.mjs`，
> 四次实测都是 20/20 —— 关键做法是**换 owner 时只换来源、不改调用点文本**（入口仍解构出 `tasks` / `dictOf` / `dayTab` 局部名，
> `setTasks((prev) => prev.map(...))` 与 `tasks: [...tasks, ...taskList.archivedTasks]` 两段原文一字未动），
> 所以 I1/I5 这类锚在源码文本上的探针不用重锚（P4 只重锚了 I1 的**文件归属**，`from`/`to` 是随搬随改的文本）。
> **P5-1 又一次验证了这条**：入口从 hook 解构出同名 setter/动作 ⇒ `test/draftBannerSessionJump.test.mjs` 一行未改即通过。**后续每批都该照这个思路做。**
> **P5-2 第三次验证，而且是"零判据重锚"的最干净一次**：入口从 `remindersApi` / `remindersApi.actions` 解构出同名值，
> 于是 7 项 state 的解构、`SettingsModal` 15 条提醒 props、2 处 `onClick={() => void ackReminder(...)}` 一个字未动，
> `test/*.mjs` **全部未改**、六个探针**全部未改**。
> **P5-3 第四次验证（草稿域 + 轮询装配）**：入口从 `draftsApi` / `draftsApi.actions` 解构出同名值，
> `test/draftBannerSessionJump.test.mjs:115` 那条 `onSettled={() => setPendingDraft(null)}` 正则断言一行未改，
> `test/*.mjs` 与六个探针**全部未改**。

> ⚠️ **P5-3 新增的两条硬约束（P6 一定会撞上）**：
> ① **本地 hook 的动作若要被装配层放进 `useEffect` 依赖数组，必须自证身份稳定**（`useCallback`）。
> P5-3 为了让 `tickDrafts` / `tickDue` 能安全进 `useWorkbenchPolling` 的依赖数组，给两个函数都包了 `useCallback`
> （`tickDrafts` 依赖 `[]`、`tickDue` 依赖 `[desktopNotify]`）—— **否则每次渲染都会重建 5 秒定时器、每渲染多跑一次 tick**。
> 把两个函数**列进依赖数组**（而不是靠注释声明等价）是为了让这条等价性**可被静态检查看见**：谁哪天给它们塞进
> 一个会变的闭包值，`d17-p5c-exit-check.py` §5 立刻变红。
> ② **判据跟着 owner 走，有两种情形，P5-2 只遇到第一种**：owner **变了**（断言换脚本守）；
> owner **没变但它的声明文本变了**（P5-3 把 `tickDue` 包成 `useCallback` ⇒ p5b 的 `body_of` 起点与定义原文两处锚点必须同批跟改，
> 否则下一批开工即红）。**改任何已迁移文件的声明文本时，先 grep 一遍 `scripts/lib/*.py` 有没有逐字锚在它上面。**
> ③ 复踩一次的坑：**cut 脚本的中文注释里不要用 `"`**（P5-3 的 `d17-cut-p5c.py` 又踩了一次 `SyntaxError`，第二次了）。

> ⚠️ **P5-1 新增的一条硬教训（P1–P4 需回头复核）**：`d17-p5a-exit-check.py` §1 那条"入口不再有 X 的第二份定义"
> 最初写成 `re.search(r"^(const|function)\s+X\b", src, re.M)` —— 而 `WorkbenchApp` 体内的定义**缩进 2 格**，
> `^const` 永远匹配不到，这条断言**永远为真（空洞通过）**。是变异 M-P5a-7（入口复制一份 `recallSessionRestore`）
> **第一次跑没被抓住**才暴露它；改成 `^[ \t]*(const|function)\s+X\b` 后立刻变红。修口径前 141 项同样"全过"。
> ⇒ **凡"某名字不该再有第二份定义"的文本判据，正则必须允许行首空白，且必须用一条真造得出第二份定义的变异反证它。**
> **P5-2 已把这条落到工具层**：`d17-p5b-exit-check.py` 的 `defs_of()` 助手本身就写成 `^[ \t]*(?:const|function)\s+`，
> 并由 M-P5b-12（入口复制一份 `ackReminder`）反证 —— 实测 **p5b 红、p5a 绿**，即判据确实随 owner 移交了。

## 2. 最终模块职责与调用方向（P1–P5-3 新增）

```
src/client/index.tsx                       入口：只剩装配（P7-3 后 1972 行，WorkbenchApp 631 行）
  ├─ app/assembly.ts                      装配束契约（P7-2）：WorkbenchAssembly = 16 个域 hook 结果
  │                                        （`ReturnType<typeof useXxx>`）+ runtime/closePanel/loadModelModalityTable/
  │                                          aiSessionUsable + 17 个装配层本地值
  ├─ app/WorkbenchHeader.tsx              顶栏（P7-2，44 行）
  ├─ app/WorkbenchOverlays.tsx            提示层 / 弹窗层之一（P7-2，195 行；含 DraftBanner / Modal / 三个选择器）
  ├─ app/WorkbenchBody.tsx                主体九视图（P7-2，224 行；按 view 分派 TodayPane/CalendarView/…）
  ├─ app/WorkbenchDialogs.tsx             快速录入 / 表单 / 工作区选择等弹窗（P7-2，358 行）
  │                                        ⇒ 四段**不持有 state、不发请求、不 import 域 hook**（判据守着）
  ├─ app/contracts.ts                     跨域类型契约（P3-2）：WorkbenchView / TaskEditDraft
  ├─ settingsFallback.ts                  设置默认值兜底纯模块（P5-1，36 行，0 React / 0 DOM / 0 请求）
  ├─ hooks/useKnowledge.ts                 知识域唯一 owner（P1）
  ├─ views/KnowledgeListView.tsx           左侧知识视图（P1）
  ├─ views/KnowledgeDetailPane.tsx         右侧知识详情（P1）
  ├─ hooks/useIdeas.ts                     点子域唯一 owner（P2）
  ├─ views/IdeasListView.tsx               左侧点子视图（P2）
  ├─ views/IdeasDetailPane.tsx             右侧点子详情（P2）
  ├─ hooks/useTaskListModel.ts             任务列表域唯一 owner（P3-1）
  ├─ views/TaskListView.tsx                左侧任务列表视图（P3-1）
  ├─ hooks/useTaskDetailModel.ts           详情域唯一 owner（P3-2）：6 个 state + 3 个语义动作
  ├─ views/TaskDetailPane.tsx              右侧任务详情（P3-2，436 行；含 selected===null 空态）
  ├─ hooks/useTaskForms.ts                 表单域唯一 owner（P3-3，101 行）：4 个 state + 表单清空 effect + 8 个语义动作
  ├─ views/TaskFormModal.tsx               两个表单弹窗（P3-3，215 行）：TaskCreateModal（非受控）+ TaskEditModal（受控）
  ├─ hooks/useTaskData.ts                  任务数据域唯一 owner（P3-4，273 行）：5 个 state + selectedRef + 5 个只读派生
  │                                        + 8 个域动作 + 3 个装配层原语（setTasks / clearSelectedTask / currentTaskId）
  ├─ hooks/useDayWorkspace.ts              日期域唯一 owner（P4，533 行）：17 个 state + pickedAnchor + 4 个 memo
  │                                        + 4 个 effect + 17 个动作（含 bumpPlanRefresh / bumpReportRefresh）
  ├─ views/TodayPane.tsx                   今日视图（P4，153 行）：统计卡 + 容量条 + CapacityRulePanel + DayPanel
  ├─ views/CalendarView.tsx                日历视图（P4，106 行）：周/月导航 + wb-week / wb-month + DayPanel
  ├─ hooks/useWorkbenchFeedback.ts         反馈域唯一 owner（P5-1，64 行）：2 个 state + toast 宿主 + 2 条桥接 effect
  │                                        （0 请求；是 4 个已搬 hook 与设置域共同的注入源，所以入口落点 L350 必须最先）
  └─ hooks/useWorkbenchSettings.ts         设置域唯一 owner（P5-1，252 行）：9 个 state + 12 个动作 + 2 条 effect
  │                                        （6 条路由：/settings、/dictionaries ×3、/knowledge-recall/{log,session}；
  │                                          不含提醒域与草稿域路由）
  └─ hooks/useWorkbenchReminders.ts        提醒域唯一 owner（P5-2，321 行）：7 个 state + notificationCtor /
                                           notifiedRef / persistNotified + 8 个动作 + **tickDue(isAlive)** + 2 条 effect
                                           （8 条路由：reminders/{policy,channel,target,test,due} + notify 相关；
                                            **0 定时器** —— 5 秒/15 秒那条混合域轮询已随 P5-3 搬进 useWorkbenchPolling。
                                            **P5-3 改动**：`tickDue` 包成 `useCallback(…, [desktopNotify])` —— 让身份可进依赖数组）
  └─ hooks/useWorkbenchDrafts.ts           草稿域唯一 owner（P5-3，348 行）：7 个 state + 3 个 ref
                                           （dismissedDraftIdsRef / deferredWhenDismissedRef / bannerDraftRef）
                                           + 10 个动作（含 `tickDrafts(isAlive)` = useCallback(…, [])）
                                           （4 条路由：drafts ×3 + duplicate 处理；原注释块全部逐字搬入）
  └─ hooks/useWorkbenchPolling.ts          轮询装配器（P5-3，61 行）：**无业务状态**，只接管 1 条 effect
                                           （5 秒 tickDrafts→tickReminders + 15 秒 refresh；
                                            依赖 `[refresh, desktopNotify, tickDrafts, tickReminders]` 与原
                                            `[refresh, settings.desktopNotify]` 重建时机逐字等价 —— 见 §1 硬约束 ①）
  ├─ hooks/useWorkbenchNavigation.ts       导航域唯一 owner（P6-1）：`view` / `setView`
  ├─ hooks/useWorkbenchBusy.ts             界面忙碌标志（P6-1）：`busy` / `setBusy`
  │                                        （AI 会话域与知识域**共写**，故单独立域 —— 塞进任一域都会造成跨域倒挂）
  ├─ hooks/useWorkbenchQuickIntake.ts      快速录入域唯一 owner（P6-2，8 state + 2 ref + 13 个动作）
  ├─ hooks/useWorkbenchAISessions.ts       AI 会话域唯一 owner（P6-3，913 行；含 **468 行的 `startAISession`**）
  └─ hooks/useWorkbenchDirectoryPicker.ts  目录选择域唯一 owner（P6-4，81 行，5 state + loadDir/openFor/close）
```
（`src/client/intakeHelpers.ts`（P6-2）是纯模块：`newTaskId` / `fileToBase64` / `quickImageToPromptPart`，
被快速录入域与 AI 会话域共用 —— 放进任一个 hook 里都会让另一个 hook 反向依赖它。）

**P5-3 解锁的硬门**：入口整份文件只剩插件 setup 作用域的 `titlebarTimer` 一个 `setInterval`，`WorkbenchApp` 体内
`setInterval` / `setTimeout` 均为 **0**（ADR-0008 第 2 条结构硬门达成）。
**刻意留在装配层**：`PENDING_ATTR` 的宿主 DOM 投影 effect（入口 L545-547，写 `document.documentElement`，属"宿主适配"）
与 `DraftBanner` 整块 JSX（`onDone` 同时写点子域 / 知识域 / 日期域，是跨域组合）。

依赖方向：`views/*` → 只接收 `model`（hook 返回值）+ 少量纯函数/注入回调；`hooks/*` → 不 import `views`、不 import 入口；
`app/contracts.ts` → **只导出 type，不 import 任何实现**；`index.tsx` → 组装。
**没有引入 Context、没有引入全局 store、没有新增依赖。**

### 入口侧的接线（P4 是"状态 + 派生 + 动作 + 视图"四合一批：`const day = useDayWorkspace({...})` 落 L1781）

```tsx
// 落点在原 `picked` 声明处（L1783）——因为入参 now(L1772) / todayPlan(L1777) / taskList.archivedTasks(L1745) 都已可用，
// 且 hook 内部的 hook 调用次序与原 useState(picked) 起的那一整段一致，不改变入口的 hook 调用顺序语义。
const day = useDayWorkspace({
  view, now, tasks,
  archivedTasks: taskList.archivedTasks,        // ⚠️ 透传一行，探针 I1 与 p3a/p3d 结构指纹锚它
  todayPlan, dailyCapacityMinutes: settings.dailyCapacityMinutes,
  defaultEstimateMinutes: settings.defaultEstimateMinutes,
  dailyCapacityIncludeOverdue: settings.dailyCapacityIncludeOverdue,
  refresh, onError: setError, onNotice: setNotice,
})
const { capacity, capacityEdit, capacityExpanded, reportSubTab, currentReport, reportSession, reportAnchor,
        reportIsFuture, pickedPlan, picked, addingPlanTaskId, cursor, calMode, dayTab, weekDays, monthGrid,
        dayPanel, planPromptFor } = day
const { addTaskToPlan, patchPlanItem, savePlan, clearPlan, deleteReport, moveWeek, moveMonth, setPicked,
        setCalMode, setCursor, setDayTab, setReportSubTab, setCapacityEdit, setCapacityExpanded,
        bumpPlanRefresh, bumpReportRefresh } = day.actions

// 留在装配层的两处（跨域）：草稿域 onDone 换成两个 bump 动作；collapseAll 拆成两域各一半：
const collapseAll = (): void => { taskList.actions.clearExpanded(); day.actions.collapseExpanded() }
// dayPanelProps = { ...dayPanel, tab: dayTab, onTabChange: setDayTab, schedulingTaskId: addingPlanTaskId,
//   onScheduleToday: dayPanel.isToday ? (taskId) => void addTaskToPlan(taskId) : undefined, … }   ← 装配，留入口
// 视图分派：{view === 'today' && (<TodayPane … />)} / {view === 'calendar' && (<CalendarView … />)}
```

⚠️ **P4 把两个内联 `api(...)` 提成了 hook 动作**（模式 5）：`onClearPlan: () => void clearPlan(dayPanel.day)`、
`onDelete: () => { if (currentReport !== null) void deleteReport(currentReport) }` —— 装配层不再直接发包。
**`saveIncludeOverdue` / `saveDailyCapacity` 仍留入口**（它们写 `settings`，属设置域，P6 才搬；hook 只交出 `capacityEdit` + `setCapacityEdit`）。

⚠️ **"状态搬走"不等于"视图搬走"能一起做**：P3-1 两者一起做是因为列表域 JSX（96 行）只依赖自己那 7 个 state；
P3-2 的 JSX 依赖 30 个跨域局部名、P3-3 的表单 JSX 依赖 15 个跨域局部名，所以视图/弹窗**必须走显式 props**。
P3-4 是纯数据层（视图 props 一行没改）。**P4 又一次证明这套顺序对**：先定 hook 闭包 → 提两个纯注入 props 视图 → 最后收状态。

⚠️ **P4 的三条专属教训**：
① **`cut_between` 的结束标记必须避开"夹在中间的外域代码"**：`reparentCandidates`（L2074-2102）夹在
   报告 effect（止于 L2072）与 `weekDays`（L2103）之间，**绝不能被当作日期域一起删掉** ——
   切割必须拆成两段，且结束标记选它自己的注释行。
② **`bare()` 类判据要把"对象字面量的键"排除**：P4 后入口以 `archivedTasks: taskList.archivedTasks,` 这种**透传**形态出现，
   键名是标签不是变量引用；旧版 `bare()` 会把它算作"入口还持有本域符号"。改成先剥注释 + `(?<![\w.])name\b(?!\s*:)`。
③ **`indexOf` 切片的判据必须加"锚点存在"守卫**：`indexOf` 找不到返回 `-1`，`slice(-1)` 只取最后一个字符，
   于是所有 `doesNotMatch` **空洞通过**（比扫红更危险）。凡是 `sliceFrom(...)`，第一句都要 `assert.ok(start > 0)`。

⚠️ **P3-4 的三条专属教训**：
① 域 hook 的**落点可能不由原声明位置决定**：`useTaskData` 必须落在 `error`/`notice` 之后（注入回调 + `const` 无提升）。
    落点前要实测"这段区间里有没有代码引用本域符号"（P3-4 实测 L229–L360 之间 0 处，故无 TDZ）。
② **换 owner 时只换来源、不改调用点文本**：入口仍解构出局部名（不写 `data.tasks`），
    于是 `capacityWiring` 的 `tasks: [...tasks, ...taskList.archivedTasks]`、`d17-p3a-exit-check.py` 的
    `useTaskListModel({ tasks, dictOf })`、探针 I1/I5 三条锚点全都不用动。
③ **新建动作名要先与既有的全局反向判据对一遍**：新动作原名 `clearSelection`，撞上 `d17-p2-exit-check.py` §5 的
    `check("clearSelection" not in whole_client, …)`（P2 已冻结、扫全客户端），导致 p2 自检 `exit=1 ✔=48`。
    改名 `clearSelectedTask`（与同域 `currentTaskId` 对称）而不是去改旧判据。

⚠️ **P3-3 的两条专属教训（仍然有效）**：
① `views/*` 不许发 HTTP（模式 5）—— 两个表单提交的请求本体（`createTask(form: FormData)` / `saveEditDraft()`）**逐字留入口**，
   弹窗只通过 `onSubmit(form)` / `onSave()` 注入；`createTask` 的签名因此由 `(event: React.FormEvent<HTMLFormElement>)`
   改成 `(form: FormData)`（把 `preventDefault` + `new FormData(currentTarget)` 挪到组件里，与既有子任务表单 L255–258 同款）。
② **两个弹窗不许合成一个组件**（模式 3）：新建＝非受控 + FormData → 一次 POST；编辑＝受控草稿 + 12 个小改动 + 保存按钮。

### 入口侧的接线（P5-1 是"纯模块 + 两个 hook"批：`feedback` 落 **L350**、`prefs` 落 **L400**）

```tsx
// ① 反馈域必须最先：它是 4 个已搬 hook 与设置域共同的注入源，而 `const` 没有提升。
//    落点就是原 `error` / `notice` 两条 useState 声明处。
const feedback = useWorkbenchFeedback()            // L350
const { toasts } = feedback
const { setError, setNotice, pushToast, dismissToast } = feedback.actions
const data = useTaskData({ onError: setError, onNotice: setNotice })   // L354 —— 依赖反馈域，必须在它之后

// ② 设置域要同时拿任务数据域的 dictOf（L1621 之后的派生）与反馈域三个写口，所以落点被推到 notifyPerm 之后。

const prefs = useWorkbenchSettings({ dictOf, refresh, onError: setError, onNotice: setNotice, onToast: pushToast })  // L400
const { settings, showSettings, settingsSaving, recallLog, recallSessionOff,
        dictKind, dictForm, dictEditCode, dictError } = prefs            // L401
const { setSettings, setShowSettings, setDictKind, setDictForm, setDictEditCode, setDictError,
        saveSettings, saveDictionaryEntry, toggleDictionaryEntry, deleteDictionaryEntry,
        loadRecallLog, recallSessionRestore } = prefs.actions            // L402-406

// 留在入口的 settings 写点（P4 决策，P6 才搬）：
//   L1897 rememberQuickWorkspace / L1918 forgetQuickWorkspace → setSettings(withSettingsFallback(res.settings))
//   L1698 saveIncludeOverdue / L1715 saveDailyCapacity
// 搬到纯模块的：SETTINGS_FALLBACK + withSettingsFallback → src/client/settingsFallback.ts
//   （设置域 hook 与上面两个仍留入口的函数都要用它，放哪一方都不对）
```

⚠️ **P5-1 的三条专属教训**：
① **"空洞通过"的文本判据**（见 §1 顶部那条）：`^(const|function)\s+X\b` 对缩进 2 格的函数体永远为真。
   本批是靠 M-P5a-7 没被抓住才发现的。**新写的"防双实现"断言必须配一条能造出第二份定义的变异来反证**。
② **"只换来源、不改调用点文本"在 P5-1 又一次省掉了整条判据的重锚**：入口从 hook 解构出同名 setter/动作，
   于是 `test/draftBannerSessionJump.test.mjs`（登记表里标 P5 的那条）**一行未改即通过**；
   M-P5a-11 反过来证明这条既有判据确实还在守着 `onSettled` 的语义差异。
③ **hook 结果变量命名要避开状态值同名**：设置域 hook 的返回值命名为 `prefs`（不叫 `settings`），
   否则 `const { settings } = settings` 无法自洽。同理反馈域用 `feedback` 而非 `toasts`。

### 入口侧的接线（P5-2 是"提醒域 hook + 只搬半个 effect"批：`remindersApi` 落 **L407**）

```tsx
// 提醒域要同时拿任务数据域的 currentTaskId / refresh（ackReminder 的闸门、addTaskReminder 的取 id）
// 与设置域的 showSettings / settings.desktopNotify（策略装载 effect 的开关、通知半段的重建条件），
// 所以落点被推到 `const prefs = useWorkbenchSettings(…)`（L395）之后。

const remindersApi = useWorkbenchReminders({ currentTaskId, refresh, showSettings,
  desktopNotify: settings.desktopNotify, onError: setError, onNotice: setNotice, onToast: pushToast })  // L407
const { reminders, reminderModalOpen, notifyPerm, reminderPolicy, reminderChannel,
        reminderOptions, reminderBusy } = remindersApi                                    // L408
const { setReminderModalOpen, setNotifyPerm, setReminderPolicy, setReminderChannel,
        loadReminderChannel, saveReminderTarget, saveReminderPolicy, sendReminderTest,
        ackReminder, resetReminderState, addTaskReminder, tickDue } = remindersApi.actions // L409-413
```

⚠️ **P5-2 的三条专属教训**：
① **"只搬半个 effect"的手法是本批最有复用价值的**：5 秒 `tick` + 15 秒 `refresh` 那条混合域轮询里，
   提醒半段要搬、草稿半段归 P5-3 —— 整片搬进任一个 hook 都会错（要么提前搬草稿域，要么两个 hook 各起一个定时器）。
   做法：hook 导出 **`tickDue(isAlive: () => boolean)`**，把存活守卫**以回调透传**（不是传 `ref`、不是传 `alive` 布尔值），
   入口那一句变成 `await tickDue(() => alive)` —— 于是"卸载后才回来的响应既不该 setState、也不该发通知/写 localStorage"
   这条守卫逐字保留，且**依赖数组 `}, [refresh, settings.desktopNotify])` 文本不动**、入口 `catch` 仍与草稿半段共用同一个异常范围。
   `tickDue` 里的失败**向外抛（不吞）**，正是为了让入口那条 `catch` 继续生效。**P5-3 搬草稿域时照这个手法办。**
② **函数式更新决定 setter 的签名**：入口 `onSelectTarget` 写的是
   `setReminderChannel((prev) => prev === null ? prev : { ...prev, botId, targetId })`，
   所以 hook 里 `setReminderChannel`（与另三个 setter）**必须是原生 `Dispatch<SetStateAction<…>>`**，
   不能"顺手"收窄成 `(value: T) => void` —— 那样入口这一行编译不过。**搬之前先把入口的函数式更新点全 grep 一遍。**
③ **入口的两个内联回调仍就地读 `NotificationState`**：`onRequestNotifyPermission` 里
   `const result = await requestNotificationPermission(readNotificationCtor(globalThis))` 与
   `onSendTestNotification` 里同类调用**刻意留装配层**（它们是浏览器权限面，不是域状态），
   所以 `readNotificationCtor(globalThis)` 在入口剥注释后仍有 **2 处** —— p5b §6 把这两处写成正向断言，
   防后人"顺手清理"。

### 入口侧的接线（P5-1 是"纯模块 + 两个 hook"批：`feedback` 落 **L350**、`prefs` 落 **L400**）


### ⚠️ 五条必须复用的模式

1. **`startAISession` 用 ref 惰性转发**：入口里 `startAISession` 是组件中部的 `const`（无提升），
   域 hook 若直接收它会 `TS2448/TS2454` 甚至运行时 ReferenceError。
   约定：`const startAISessionRef = useRef<StartAISessionFn | null>(null)`，
   在 `startAISession` 定义体结束后写一行**普通赋值** `startAISessionRef.current = startAISession`（不是 hook 调用，hook 顺序不变）。
2. **域 hook 一律在 `WorkbenchApp` 顶层无条件调用**（设计 §4.2），视图才条件挂载 —— 否则切视图会重置该域状态。
3. **同一个名字在不同调用点语义不同时，不许合并成一个动作**：P2 的 `openIdeaById(id)`（卡片网格，`find` + 找不到早退）
   与 `openIdea(idea)`（文件夹成员行，直接用对象）就是被合并错过一次。**搬 JSX 之前先做"与 HEAD 逐条语义对照"**，
   对照工具 `scripts/lib/d17-head-ideas.py` / `d17-show.py`（模板见 §3）。
4. **副作用不许写进 `useState` 更新函数**：React 会重调更新函数（StrictMode / 并发），把 `void api(...)` 放进去就会重复发请求。
   P3-1 的归档切换写成 `const next = !archivedMode; setArchivedMode(next); if (next) void api(...)`，并加了一条会失败的判据。
5. **视图里出现 `api(...)` 就提成装配层注入的回调**（设计 §3：`views/` 不许发 HTTP）：
   P3-2 把详情面板里两处内联请求提成 `onRestoreTask(taskId)` / `onCreateSubtask(form, parent)`，
   请求本体（URL、method、payload 字段与顺序）**逐字搬到入口**，组件只交 `FormData` 与父任务。
   好处不只是合规：组件因此**不再需要** `taskList` / `refresh` / `setError` / `runtime` 四个 props。
   **两个"同一事件两连 setState"也要提成动作**（`resetDetailView` / `openSessionPicker` / `closeSessionPicker`）——
   否则同一个语义在入口和视图各写一份，迟早只改一处。

## 3. 工具与踩坑（后续每批都会用到）

| 工具/规矩 | 说明 |
|---|---|
| Python 读改写 + `sub1` | `edit` 工具在这个 4700+ 行文件上不可用（`file changed since it was read`）。脚本放 `scripts/lib/d17-*.py`；**先归一换行**（`replace('\r\n','\n')`）再匹配；`sub1` 命中数 != 1 就整体中止**不写文件** |
| **一次脚本内完成整块搬迁** | 不要在半成品上二次加工：第一版 ABORT 后"前半段已替换、后半段没替换"，第二次脚本按已替换的文本写锚点 → 全不匹配。**每次从 `index.tsx` 重新抽取** |
| 替换清单 | ① 先换**多行整块**，再做单词级替换；② 按**裸子串**写（`ideaTab === ` / `value={ideaQuery}`），写成 `{ideaTab` 会漏掉模板字面量里的 `${ideaTab === …}`；③ 守卫计数要用**带前缀边界**的写法，裸子串会命中 `model.actions.mergeFolderInto`；④ 反向要小心 `ideas→model.ideas` 把 `cluster.ideas` 误伤成 `cluster.model.ideas` |
| 行数口径 | `scripts/lib/d17-measure3.py`：入口总行数 + `WorkbenchApp` 起止行与行数（按配对大括号）。**别用 PowerShell `Measure-Object -Line`**（只数换行符） |
| 结构定位 | `scripts/lib/d17-diff-p2.py`（HEAD vs 工作区逐 hunk 打印）、`d17-diff-balance.py`（括号净变化）、`d17-comment-scan.py`（注释配平）、`d17-find.py` / `d17-show.py`（找子串 / 按行区间打印）、`d17-scope.py <lo> <hi>`（区间用到哪些 `WorkbenchApp` 局部名 + 次数 → 直接算出 props 清单） |
| **成片 `Cannot find name` 先查注释配平** | `d17-comment-scan.py`。P2 撞到一个真 bug：`/**` 未闭合把 40 行代码整段吞掉，报错指向的是被吞掉的变量名 |
| 判据底座 | `test/_clientSources.mjs`：`read` / `stripComments` / `readClientSources()` / `countInClient(pattern)` / `assertClientCount(assert, pattern, n, msg)`。**正向断言指向真实 owner，负向唯一性递归全客户端目录（剥注释）** |
| **扫描判据自己也会写错** | P3-2 首次出口自检 9 项不通过，全是判据写错：① 入口**解构**出来的本地名（`sessionPickerRole` 等）被当成"入口还持有状态"；② 结构指纹把**注释里**的 `<div className="wb-card">` 也算进去了（先 `strip_comments`）；③ 唯一口径比较把 hook 自己漏在比较集合外。**判据红了先怀疑判据，再怀疑实现** |
| **变异脚本必须重定向 stdout 为 utf-8** | 否则打印 `✖` 时 `UnicodeEncodeError: 'gbk' codec can't encode character '\u2716'`。所有 `d17-mutate-*.py` 开头都要有 `sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")`（脚本 `finally` 仍会还原，但过程输出丢了） |
| **变异脚本要同时支持 `.mjs` 与 `.py` 目标** | P3-3 起判据一半在 python 出口自检里（`d17-p3c-exit-check.py`）：`run_checks(files)` 必须按后缀分别走 `node --test` 与 `sys.executable`，只跑 node 会漏掉一半发现路径。脚本末尾还要「还原后再跑一次基线」并断言退出码全 0 |
| **null-safe 展开的替换尾部是 `})}` 不是 `})`** | P3-3 的 12 处 `onChange={(e) => setEditDraft(…)}` 外面还有 JSX 的 `}`，正则写成 `… \}\)` 才对；其中括号版 `(prev === null ? prev : {…})` **必须先替换**，否则会多吃一个 `)` |
| **同一字面量在搬走的块里可能出现多次** | P3-3 的 `settings.defaultEstimateMinutes` 在编辑弹窗里出现 **2 次**（输入框 placeholder + 提示行文案），按 1 次断言会 ABORT。搬块前先数一遍目标串的出现次数（`d17-find.py`） |
| 结构对错不看自制扫描器 | 以 `pnpm typecheck` 为准（自制括号扫描器会把正则字面量当代码而假报） |
| **探针与测试/构建都不许并行** | 探针会临时变异源码再还原；并行跑测试会读到变异体，得到假红（P2 撞到一次：`styles.ts` 的 z-index）。P3-4 又撞一次更隐蔽的：与 `pnpm test`（内含 `pnpm build`）并发跑探针 → 构建标识在"算输入哈希"与"打包"之间源文件被改 → `V04-B/AX-V07：三方构建标识同源` 假红（串行重跑即恢复 992/991/1）。**凡是会改源文件的验证脚本，必须与任何含构建的命令串行** |
| **唯一所有者断言要用完整声明原文** | 「某 state 的创建点全客户端唯一」如果用 `const [X,` 这类松正则，会撞上别的域的同名声明而假红：P3-4 的 `selected` / `dicts`（`useKnowledge.ts` 也有）、`dictOf`（`SettingsModal.tsx` 也有）、`refresh`（`useIdeas.ts` 也有）。改用完整声明原文（`const [selected, setSelected] = useState<TaskDetail \| null>(null)`）才唯一 |
| **跨域注入会决定 hook 落点** | 用注入回调（`onError`/`onNotice`）的域 hook **不能**摆在原 state 声明处，必须落在被注入的 state 之后（`const` 没有提升）。落点前先实测"目标区间里有没有引用本域符号"（P3-4 实测 L229–L360 之间 0 处 → 无 TDZ）。P4 起若有别的域也要注入反馈，照此办理 |
| **出口自检的 `body_of` 的 end 必须可选** | 切片到"文件尾"的场景（入口 `openTaskById` 之后紧跟的不是 `const`）很常见；`body_of(src, start, end)` 强制要 end 会 `TypeError`。P3-4 写成 `end=None` → 切到文件尾 |
| **出口自检项数一律按实际 ✔ 行数点** | P3-3 第一版把 67 项写成 64（沿用旧修订的数字），四处文档全错。**每次改完判据都要重跑并把 ✔ 计数抄成实测值** |
| PowerShell 里 Python | `python -c "..."` 内嵌正则/引号极易被吞 → **一律写成 `.py` 文件执行**（P2 又踩一次） |

## 4. 出口自检（可复跑）

| 命令 | 结果（项数按 ✔ 行实测） |
|---|---|
| `python scripts/lib/d17-p1-exit-check.py` | **32 项、退出 0**（入口 21 个知识域名 0 命中；存储键全客户端 1 处） |
| `python scripts/lib/d17-p2-exit-check.py` | **49 项、退出 0**（入口 22 个点子域名 0 命中；两视图不发 HTTP/不建 state；hook 15 个动作唯一；`clearSelection` 全客户端 0 处） |
| `python scripts/lib/d17-p3a-exit-check.py` | **47 项、退出 0**（入口 20 个列表域名 0 命中；视图无 state/HTTP；hook 7 state + 8 动作唯一；存储键与空筛选字面量各只剩 1 份） |
| `python scripts/lib/d17-p3b-exit-check.py` | **56 项、退出 0**（入口不再建 6 项详情 state、10 个名字 0 命中；6 项 state 全客户端只在 hook 创建；视图纯度；**结构指纹** 9 个类名计数；三个动作的两行顺序；契约不内联） |
| `python scripts/lib/d17-p3c-exit-check.py` | **67 项、退出 0**（入口不再建 4 项表单 state、不裸用 5 个 setter；4 项 state 全客户端只在 hook 创建；弹窗各 1 处装配 + 守卫在位；视图纯度；两弹窗不合并 + `onPatchDraft({` 恰好 12；模式 5 请求本体全在入口；结构指纹） |
| `python scripts/lib/d17-p3d-exit-check.py` | **103 项、退出 0**（入口不再建 5 项数据 state / `selectedRef` / 5 个派生 / 8 个动作；创建者唯一性用**完整声明原文**；设计 §4.1 红线四条（`loadTaskDetail` 不导航 / `openTaskById` 不在 hook / 入口 `openTaskById` 里有 `setView('list')` / 保存进度线不调 `openTaskById`）；`refresh` 整块未拆（体内恰好 2 处 `Promise.all(`）；跨域注入 `onError`/`onNotice` 无裸 setter；3 个装配层原语；结构指纹含探针 I1/I5 两条锚点原文。**P4 打回 1 条（`tasks: [...tasks, …]`）已重锚**，102 → 103） |
| `python scripts/lib/d17-p4-exit-check.py` | **161 项、退出 0**（入口不再建 17 项日期 state / 16 条派生动作；创建者唯一性递归 `src/client/**` 含未追踪文件；四个 effect 依赖数组；**容量 memo 三条接线细节**（探针 I1 新锚点）；跨域注入无裸 setter；两个视图无 `useState[<(]` / `fetch(` / `api[<(]`；结构指纹含 `collapseAll` 一行与两条注入动作） |
| `python scripts/lib/d17-p5a-exit-check.py` | **137 项、退出 0**（7 节：§1 入口不再自建 38 / §2 唯一所有者 22 / §3 设置域 effect 与 HTTP 归属 14 / §4 跨域注入 16 / §5 反馈域纯度 14 / §6 留在装配层 24 / §7 结构指纹 9。**⚠️ §1 那条"防双实现"正则最初写成 `^(const|function)` → 空洞通过，已改成 `^[ \t]*(const|function)\s+`**。**P5-2 把 §6 里四条提醒域动作删掉（判据随 owner 移交 p5b），141 → 137**） |
| `python scripts/lib/d17-p5b-exit-check.py` | **152 项、退出 0**（7 节：§1 入口不再自建 55 / §2 唯一所有者 21 / §3 effect 与 HTTP 归属 19 / §4 跨域注入 24 / §5 `tickDue` 纯度 13 / §6 留在装配层 19 / §7 结构指纹 5。**P5-3 三处跟着 owner 改**（`tickDue` 的定义原文与 `body_of` 起点各一处；§5 原五条轮询断言整片移交 p5c 并加注释说明），156 → 152） |
| `python scripts/lib/d17-p5c-exit-check.py` | **151 项、退出 0**（8 节：§1 入口不再自建本域任何东西 37 / §2 唯一所有者 21 / §3 草稿域 HTTP 归属与纯度 19 / §4 跨域注入 22 / §5 轮询装配器 19 / §6 留在装配层 17 / §7 结构指纹与调用顺序 7 / §8 ADR-0008 结构硬门与度量 9。§8 会打印 `WorkbenchApp 2267 行；useState 27；api 27；useEffect 4`，并带两条"防空洞通过"护栏：`body_lines > 2000` 与 `"ideas.actions.refresh()" in body`） |
| `python scripts/lib/d17-mutate-p1.py` | 2/2 变异被断言发现，还原 sha256 一致 |
| `python scripts/lib/d17-mutate-p2.py` | **3/3 变异被断言发现**，还原 sha256 一致 |
| `python scripts/lib/d17-mutate-p3a.py` | **4/4 变异被断言发现**，还原 sha256 一致 |
| `python scripts/lib/d17-mutate-p3b.py` | **6/6 变异被断言发现**，还原 sha256 一致 |
| `python scripts/lib/d17-mutate-p3c.py` | **7/7 变异被断言发现**，还原 sha256 一致、还原后基线退出码全 0 |
| `python scripts/lib/d17-mutate-p3d.py` | **8/8 变异被断言发现**，还原 sha256 一致、还原后基线退出码全 0 |
| `python scripts/lib/d17-mutate-p4.py` | **11/11 变异被断言发现**，还原 sha256 一致（四文件）、还原后基线退出码全 0 |
| `python scripts/lib/d17-mutate-p5a.py` | **11/11 变异被断言发现**，还原 sha256 一致（三文件）、还原后基线退出码全 0（**M-P5a-7 首跑为盲点，修 §1 正则口径后才变红**） |
| `python scripts/lib/d17-mutate-p5b.py` | **12/12 变异被断言发现**，还原 sha256 一致（四文件）、还原后基线退出码全 0。**M-P5b-12（入口复制一份 `ackReminder`）实测 `files=[p5b, p5a] → exit=[1, 0]`**：红票来自 p5b、p5a 保持绿 = 判据移交完成的证据 |
| `python scripts/lib/d17-mutate-p5c.py` | **12/12 变异被断言发现**、退出 0；还原后三文件 sha256 逐字节一致、还原后基线 `exit=[0,0]`。含三条最有价值的变异：**对调草稿/提醒 tick 顺序**、**删 15 秒 refresh 定时器**、**入口把 tick 改回内联拉提醒（p5c 红而 p5b 绿 = 判据移交完成的证据）** |
| `node scripts/repro/probe-capacity-mutations.mjs` | **20/20 全红、退出 0**（I1 在 P3-1 重锚、**P4 二次重锚到 `src/client/hooks/useDayWorkspace.ts`**，新增常量 `DAY_WORKSPACE`；I3 在 P3-2 重锚到 `views/TaskDetailPane.tsx`；P3-3 / P3-4 / **P5-1 / P5-2 实测都不需再重锚**） |
| `node scripts/repro/probe-listview-mutations.mjs` | **17/17 全红、退出 0**（P5-1 / P5-2 复跑仍 17/17） |
| `node scripts/repro/probe-knowledge-draft-overwrite-mutations.mjs` / `probe-knowledge-recall-mutations.mjs` | **19/19** / **46/46**（P5-1 / P5-2 复跑同数） |
| `node scripts/repro/probe-quick-workspace-mutations.mjs` / `probe-model-picker-notify-mutations.mjs` | **13/15** / **7/10**（**P5-3 时的历史值**）—— 失效锚点在 HEAD 版即存在，**P6 修 quick-workspace（M6/M14 重锚到 `app/WorkbenchDialogs.tsx`）⇒ 16/16**、**P7 修 model-picker（B7 锚到 `hooks/useWorkbenchAISessions.ts`、B8 常量化到 `components/ModelPicker.tsx`、B10 锚 AI hook）⇒ 10/10**；六个探针现全部 **0 存活** |

**P7 收尾时的 15 个出口自检项数（上表里 P3b/P3d/P4/P5a/P5b/P5c 的旧数字是历史值）**：
P1 32 / P2 49 / P3a 47 / **P3b 57** / P3c 67 / **P3d 103**（`✔` 行 105）/ **P4 161**（`✔` 行 175）/ **P5a 138** / P5b 152 / **P5c 152** /
**P6b 155** / P6c 198 / **P6d 96** / **P7a 72** / **P7b 220**，全部 exit 0；
P1–P4 四个脚本的汇总行只打印「结果：全部通过」不打印计数。
**15 个变异脚本**（新增 `d17-mutate-p7a.py` 6/6、`d17-mutate-p7b.py` 13/13）全部真跑 N/N 且还原后逐字节一致。

⚠️ 跑上表任何一项时，**不要同时跑 `pnpm test` / `pnpm build` / `dev-verify`**（探针会临时改源码 → 构建标识假红）。
**P5-2 又实测到这一条的第二个面**：`pnpm test` 内含 `pnpm build`，而 `lib/` 是 gitignored 构建产物、`"build"` 第一件事就是 `rmSync('lib')`
—— `lib/build-info.json` 缺失时 `test/devVerify.test.mjs:204` 会 `ENOENT` 假红。**跑全量前先确认 `lib/build-info.json` 在（或直接 `pnpm build`）。**

## 5. 剩余问题 / 未验证（**P7 收尾后**）

**P7 结束时仍欠的（最新，优先看这三条）**：
1. ~~**浏览器行为级验证仍然没做**~~ **✅ 2026-10-04 已做**：`dev-verify` 在 3080 隔离实例上跑完 10 套现役判据**全绿**
   （装盘 → 只重启目标 → health 三者同源 → 套件；证据包 `test-results/workbench-verify/20261004-113439-551e0e/`），
   顺手抓到并修掉一条**套件自身的假红**（`day-panel` 的 AX-T03；断言一字未改，只归一前置状态）。
   完整数字见 §0 与 `verification.md` 的「浏览器验收链与装盘」节。
2. **没有 `git commit`**（**仍欠，现在是最该做的一件**）：`git show HEAD:src/client/index.tsx` 仍是 **5725 行**（D17 之前），
   而工作区是 **1972 行**；`hooks/` / `views/` / `app/` 三个目录整目录 untracked，`git status` 100+ 条。
   提交信息里要写起点→终点行数（验收口径要求），并**把 P1–P7 拆成多次提交**（每个提交都保持可跑）。
3. ~~未装盘、3080 / 19387 未动~~ **✅ 已装到 `web`(3080)**（正式库未迁移 —— 目标实例用的是 `verify-web.db`；版本号仍 **1.16.2** 未升）；
   **19387 / desktop 侧仍然没换**，跑的是 2026-10-02 的 dev 构建（pre-D17）。

以下为 P6 交接时登记的历史条目（**除已注明者外仍然有效**）：

1. **P1–P5-1 八个域都没有浏览器套件**：`scripts/verify/suites.json` 现役 10 套里没有
   `knowledge` / `ideas` / 任务列表 / 任务详情 / 任务表单 / 任务数据（刷新）/ **今日·日历日期域** / **设置弹窗与 toast 宿主**场景，`dev-verify` 全链也未重跑 → 这些域的
   CRUD/筛选/关联/表单/进度/会话选择/刷新与导航/容量行内编辑/日历周月切换/**设置三分区保存与字典增删改** **未做行为级验证**（设计 §9 的 B01/B02/B03 仍欠）。
   P2 修回的两处语义偏差**是靠文本对照发现的**，说明这个缺口是真的，不宜再往后拖。
   **P4 的容量行内编辑四个回调、日历周/月切换与选中日、"今日与日历共用一份 DayPanel 装配"这三条同样只有文本级 + 变异级证据；
   P5-1 的设置弹窗（常规/字典/召回日志）、微信提醒策略与通道、右上角 toast 宿主与两条提示桥接也同样。**
   P5-2 的到期提醒弹窗（ack 后本地移除 + 若在任务详情则 `refresh()`）、桌面通知去重与 `persistNotified`、
   通知授权与测试通知两个内联回调、提醒策略/通道保存 —— 同样只有文本级 + 变异级证据（`tickDue` 的存活守卫有 4 条 `before()` 顺序断言守着）。
   **P5-3 的草稿横幅（四种 outcomes）、重复任务弹窗的"保留两条"/"合并"、待处理弹窗的两段列表与唤回、屏蔽集合的三条不变量
   （收起不改计数 / 只认"暂存→唤回" / 不同类型递补告知）** —— 同样只有文本级 + 变异级证据
   （`d17-p5c-exit-check.py` §5 用 8 节 19 项守着轮询顺序、周期与守卫；`d17-mutate-p5c.py` 12 条反证）。
   **⇒ P6 之前若要做行为级验证，草稿域与轮询是关键候选。**
2. ~~`node scripts/release-preflight.mjs --phase pre` **不会退出 0**（`KNOWN_PROBE_DEBT` 的 model B7/B8/B10、
   quick-workspace M6/M14 失效锚点，`judgeProbes` 硬红）~~ **✅ P6 修掉 quick-workspace 两条（M6/M14 重锚，探针 16/16）、
   P7 修掉 model-picker 三条（B7/B8/B10 —— 它们是"探针失效"而非真盲点：锚点还停在 `index.tsx`，
   而提交路径随 P6-3 搬进 `useWorkbenchAISessions.ts`、门禁成因的调用点在 `src/client/components/ModelPicker.tsx`、
   变量名从 `quickModelSelection` 漂到 `modelSelection`；修好后 10/10）**。
   `scripts/release-preflight.mjs:60` 的 `KNOWN_PROBE_DEBT` 名单**已清空**，`--phase pre` **退出 0**。
   （历史：P3-3 用 `git show HEAD:src/client/index.tsx` 逐条确认这 5 条锚点**在 HEAD 版就已失效**，不是 D17 打坏的。）
3. **`test/devInstall*` 有一条与运行口径有关的既有脆弱点**：单跑该文件时红
   （`DSH_PROFILE_DIR` 属 desktop 而本次要装 web），全量 `pnpm test` 下同一用例绿；不属 D17 引入，未处理。
   另：`test/personaLibrary.test.mjs:585`（`AX-R06 HTTP 资源拒绝`，`[TypeError: fetch failed] [cause]: Error: bad port`）
   在 P5-1 两次首跑里各偶发一次，串行重跑即消失 —— 同样不属 D17 引入，但**这套测试对并发敏感**。
4. **容量探针已经重锚过三次**：I1 在 P3-1（`taskList.archivedTasks`）→ **I1 在 P4 再锚到 `hooks/useDayWorkspace.ts`（新增常量 `DAY_WORKSPACE`）**、
   I3 在 P3-2（`views/TaskDetailPane.tsx`，常量 `TASK_DETAIL_PANE`）。**P3-3 / P3-4 / P5-1 / P5-2 / P5-3 实测都不需要重锚**。
   P5-1 另把 **quick-workspace 的 M12/M13 锚到 `hooks/useWorkbenchSettings.ts`**（常量 `SETTINGS_HOOK`）。
   **P5-3 是第二个"零重锚"样本**（草稿域与轮询装配同样没有任何探针锚点；唯一要改的是 p5b 自己那五条轮询断言，走的是"判据跟着 owner 走"而非探针重锚）。
   **P6 起若动到 capacity / day-panel / progress / persona / model-picker / 草稿接线 / 提醒接线 / 快速录入接线 / AI 会话接线，必须同批重锚对应探针**
   （登记表在 `migration-matrix.md` 的"后续批次预计会假红"一节）。
   经验结论：**只换 owner、不改调用点文本 ⇒ 多数探针不用重锚**；换文件归属时改 `file` + 随搬改 `from`/`to` 即可（I1 两次、M12/M13 一次都是这么做的）；
   **P5-2 是"零重锚"的最干净样本**（提醒接线没有任何一条探针锚点，六条探针逐条复跑、条数全同）。
5. **P6 起要复核的等价写法**：① `aiSessionUsable` 现在是注入回调
   `isSessionUsable={(sid) => aiSessionUsable(runtime, sid)}`（复用入口既有写法），依赖模块级 `aiSessionUsable`
   与 `runtime` —— **不要顺手把它搬进任何域 hook**；② `createTask` 已改成收 `FormData`（不再是 `event`）、
   `saveEditDraft` 仍是零参动作 —— 走的是**表单线**，不要与**导航线**（`openTaskById`）合并（模式 3）；
   ③ 入口解构出的局部名（`tasks` / `selected` / `dictOf` / `dayTab` / `capacity` / `settings` / `reminders` / `reminderPolicy`
   / **P5-3 新增的 `pendingDraft` / `deferredDrafts` / `draftProblems` / `draftSwitchedFrom` / `allPendingDrafts` / `pendingOpen` / `duplicatePrompt`**）**不许改成 `data.xxx` / `day.xxx` / `prefs.xxx` / `remindersApi.xxx` / `draftsApi.xxx` 形式** ——
   探针 I1/I5、`d17-p3a/p3d/p4/p5a/p5b/p5c-exit-check.py` 的结构指纹都锚在这些原文上；
   ④ **设置域已经搬完，但两个写入仍在入口**：`saveIncludeOverdue` / `saveDailyCapacity`（L1698 / L1715）
   与 `rememberQuickWorkspace` / `forgetQuickWorkspace` 里的 `setSettings(withSettingsFallback(res.settings))`（L1897 / L1918）
   是 P4 决策留下的**跨域写点**，P6 搬快速录入时要用 props 注入改成"设置域交出 setter、快速录入域注入消费"，
   别再让两域共享一个 state 名字；⑤ 三个已搬 hook 的**落点被"上游符号先可用"逐个往后推**：设置域被 `dictOf` 推到 **L350**、
   提醒域被 `showSettings` / `settings.desktopNotify` 推到 **L362**、草稿域被 `setError` / `setNotice` / `refresh` 推到 **L331**（在两者之前）——
   P6 搬快速录入 / AI 会话 / 导航域时照此办理（**先实测目标区间有没有引用本域符号，`const` 无提升**），
   更省事的办法是让上游 hook 的调用点尽量早（P5-1 把 `feedback` 放在 L350 最前面就是为这个）。
6. **P4 遗留的两条明确决策（不是欠账）**：① 入口 10 个死 import **有意不清理**（`noUnusedLocals` 未开、仓库无 lint、
   `PlanPanel` 早有同类死 import），留给 P7 组合层收尾统一清；② `useDayWorkspace.ts` 里的 `clearTodayPlan` 是**搬迁前就存在的死代码**
   （入口 0 处引用，靠 `void clearTodayPlan` 消 lint），与 `clearPlan(date)` 语义重叠，本批只换 owner 不改行为，留给 P7 评估删除。
   **P5-1 同款决策**：不清理任何因搬迁变成未使用的 import（唯一例外是 `useToasts` —— 它随 `ToastHost` 同文件，
   入口改成 `import { ToastHost } from './components/Toast.js'`）。**P5-2 同款**：`classifyNotificationPermission`
   与 `NotificationState` 等 import 有变成只被 hook 使用的，一律**不清理**，留 P7 统一收尾。
7. 未 commit（P1–**P5-3** 全部未提交，`hooks/`、`views/`、`app/` 三目录 + `src/client/settingsFallback.ts` 整批 untracked；
   P5-2 新增 `hooks/useWorkbenchReminders.ts` + `scripts/lib/{d17-cut-p5b.py,d17-p5b-exit-check.py,d17-mutate-p5b.py}`；
   P5-3 新增 `hooks/useWorkbenchDrafts.ts`、`hooks/useWorkbenchPolling.ts` + `scripts/lib/{d17-cut-p5c.py,d17-p5c-exit-check.py,d17-mutate-p5c.py}`）/
   未装盘 / 3080 与 19387 未动 / 正式库未迁 / 版本号仍 1.16.2。

> ⚠️ **`DraftBanner` 整块 JSX 必须留在装配层**（P5-3 后入口 L1927 附近）：`onDone` 同时含
> `knowledge.bumpRefreshKey()`、`ideas.actions.refresh()`、`bumpPlanRefresh()`、`bumpReportRefresh()` ——
> 而 `scripts/lib/d17-p2-exit-check.py:53` 的 `"ideas.actions.refresh()" in INDEX` **唯一命中点就在这一行**，
> 搬走它会让 p2 立刻变红。同一道理，`PENDING_ATTR` 宿主 DOM 投影 effect 与 `titlebarTimer` 也不要挪。

## 6. 下一步（**浏览器链已跑绿、已装盘；只剩 `git commit`**）

**代码侧与行为级验收都没有下一批了**：P6（快速录入 + AI 会话 + 导航 + 目录选择四域）与 P7（请求归域 + JSX 四段搬迁 + 死代码清理）
都已落地并通过全部静态 / 单元 / 变异门禁，ADR-0008 的结构硬门全部为 0；**2026-10-04 又在 3080 隔离实例上装盘并跑完 10 套浏览器判据（全绿）**。
接下来只剩一件事：

1. **`git commit`（最高优先，也是唯一剩下的一件）**：工作树里是 P1–P7 九批、`index.tsx` 5725 → 1972 行的全部改动，
   三个目录整目录 untracked，**一份提交都不存在**。建议按批次分多次提交，每次提交信息里写明该批的起点→终点行数
   （验收口径要求：`src/client/index.tsx` 总行数必须下降，起点 5725 要写进提交信息）。
   每个提交都要保持"能跑"（`npx tsc --noEmit` + `pnpm build` + `pnpm test`）。
   本轮额外改动 `scripts/verify/suites/day-panel.mjs`（假红修复），一并提交。
2. ~~**浏览器行为级验证**~~ **✅ 已完成**：`dev-verify` 在 3080 上装盘 + 只重启目标 + 10 套判据全绿
   （`test-results/workbench-verify/20261004-113439-551e0e/`）。commit `6ff84b0` 引入的那条 `day-panel` 假红（进日历前页签停在「未排期」）
   也在本轮修掉 —— 修法是**只归一前置状态、断言一字未改**。
3. ~~**装盘 / 重启 / 版本号**~~ **✅ 已装到 `web`(3080) 并重启生效**（buildId `wb-27d63c3bb09513e1`，包·host·client 三者同源；
   正式库未迁移 —— 目标实例用的是 `verify-web.db`；版本号仍 **1.16.2**）。
   若要把 D17 也搬到 19387 / desktop：那需要重启**本会话所在的桌面端实例**，按 `dsh-safe-plugin-ops` 硬规则只能由用户手动重开。
4. 留在后续批次评估的既有欠账：`src/client/hooks/useDayWorkspace.ts#clearTodayPlan`（**搬迁前就存在**的死代码）。

**P7 的三条硬约束（若还要动装配层）**：
① 四段组件（`src/client/app/Workbench*.tsx`）**不许持有 state、不许发请求、不许 import 域 hook** ——
`d17-p7b-exit-check.py` §3/§4 各有一条断言守着，还有对应变异（body 自持 state / overlays 发请求 / body import 域 hook）；
② 装配束 `WorkbenchAssembly` 是 16 个域 + 4 个宿主/助手 + 17 个装配层本地值，
改字段要同步 `src/client/app/assembly.ts` 与入口那 21 行装配对象（少了字段 `tsc` 会 `TS2740` 直接报出来）；
③ **入口 JSX 的渲染顺序 = 搬迁前 DOM 顺序**（Header → Overlays → Body → Dialogs → ToastHost），改顺序会动层叠/焦点，
`d17-mutate-p7b.py` 有一条变异专门打这个。

以下为 P6 开工前的计划（**历史，已完成**）：

P3（任务域）、**P4（日期域）**、**P5-1（反馈域 + 设置域）**、**P5-2（提醒域）** 与 **P5-3（草稿域 + 轮询装配）全部完成**，
设计 §2.1 判据 3 已在 P4 达成；**P5 整批判据 3（"域内状态与动作不再散落在入口"）已闭合**。
按 `docs/design/2026-09-09-client-split-backlog.md` §7，**P6 = 第 6 段**：
**快速录入域（QuickIntake）+ AI 会话域（AISessions）+ 导航域（Navigation）+ 目录选择域（DirectoryPicker）**，
`ownership.md` §4 实测剩余 **27 项直接 `useState`** 分属这四域（Navigation 1 / QuickIntake 9 / AISessions 12+1 / DirectoryPicker 5）。
出口口径沿用设计 §7 P6 行 + ADR-0008 的结构硬门（见下）。
**P5-3 已达成的一条硬门不要回退**：`WorkbenchApp` 体内 `setInterval` / `setTimeout` 现在**都是 0**，
P6 若给新 hook 加轮询，**必须复用 `useWorkbenchPolling` 或新写一个同样无业务状态的装配器**，不许把定时器写回入口。

> **⚠️ 判据 1 验收口径变更（2026-10-04，[ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md)）**：原「`WorkbenchApp` ≤600 行」拆成两半——
> **硬门**（源码扫描，`WorkbenchApp` 函数体内各为 **0**）：直接 `useState(` / `api(` / `fetch(` / `setInterval(` / `setTimeout(`，且单个顶层块 **≤80 行**；
> **护栏**：行数 **≤900 且每批单调下降**（P6 收尾后按实测校准一次）；**≤600 降为努力目标，不再是验收门**。
> 因此本文档与设计文档里所有「距 `WorkbenchApp` ≤600 还差 N」一律按**历史记录**读。
> **P5-3 后的实测进度**：`WorkbenchApp` **2267 行**，体内硬门 —— `setInterval` **0** / `setTimeout` **0** / `fetch` **0** ✅，
> 尚未清零的是直接 `useState(` **27**、`api(` **27**、`useEffect(` **4**，以及单个顶层块 ≤80 行这条（最长块仍是 `startAISession` **500 行**）。
> P7 的施工内容据此明确为**纯 JSX 与装配收口**：P5-2 快照里 `WorkbenchApp` 2471 行 = JSX 676 行 + 装配 1794 行，
> 27 项直接 state 逐项属于 P6 的四个域，**P7 清单里没有任何 state**。
> 另记一条与行数之争无关的真缺陷：`startAISession`（P5-2 快照 L759–1258，**500 行**，最长顶层块）违反判据 1 后半句「不承载长 handler」，**必须随 P6 的 AI 会话域搬走**。

| 要做 | 落点（P5-3 后入口 3724 行，**动手前必须重新实测**） |
|---|---|
| **P6-1 导航域 owner（Navigation，1 项）** | `view` / `setView` 一族的收口 —— 先实测入口有多少处以 `setView` / `view ===` 形态出现再定边界；`openTaskById` 走的是**导航线**，不要与表单线合并 |
| **P6-2 快速录入域 owner（QuickIntake，9 项）** | `quickWorkspaceRecent` / `quickWorkspace` / `quickWorkspaceSource` / `quickWorkspaceTouched` / 快速录入草稿相关 state；**必须同批处理 `rememberQuickWorkspace` / `forgetQuickWorkspace` 里的 `setSettings(...)` 跨域写点**（见 §5 第 5 条 ④，改成"设置域交出 setter、快速录入域注入消费"）；两个探针失效锚点 M6/M14（`probe-quick-workspace-mutations.mjs`）就是这条接线上的既有欠账 |
| **P6-3 AI 会话域 owner（AISessions，12+1 项）** | 12 个 state + `modelModalityTable`（入口 L299 附近）；**`startAISession`（500 行，最长顶层块）必须随本域搬走**（ADR-0008 的"不承载长 handler"）；`aiSessionUsable` 保持注入回调、不要搬进 hook |
| **P6-4 目录选择域 owner（DirectoryPicker，5 项）** | 目录选择相关 state 与动作；`probe-model-picker-notify-mutations.mjs` 的 B7/B8/B10 三条失效锚点在这条接线上（属既有欠账，P6 正好顺手修） |
| 保留在入口 | 视图装配、跨域组合、宿主相关（`PENDING_ATTR` 投影 effect / `DraftBanner` 整块 / `titlebarTimer`）、两个内联 `readNotificationCtor(globalThis)` 回调 |

**必须复用的五条模式（§2.3）照旧全适用**，另加 P3–P5 累计的硬约束：
**先搬 JSX 再搬状态**（视图 props 定了才收状态，避免二次返工）、**只换来源不改调用点文本**（探针才不用重锚）、
**新动作名先与既有全局反向判据对一遍**（P2 的 `clearSelection` 撞名教训）、**域 hook 落点由注入回调决定**
（要在 `error`/`notice`/`prefs` 之后；先实测目标区间有无本域符号引用）、
**切大块时结束标记要避开夹在中间的外域代码**（P4 的 `reparentCandidates` 教训）、
**`indexOf` 切片的判据第一句就要 `assert.ok(start > 0)`**（否则锚点消失时空洞通过）、
**"防双实现"判据的正则必须允许行首空白，且要用变异反证它真能红**（P5-1 的 `^(const|function)` 空洞通过教训；`defs_of()` 助手已固化）、
**混合域 effect 用回调把存活守卫透传出去**（P5-2 的 `tickDue(isAlive)` / P5-3 的 `tickDrafts(isAlive)` 手法；P6 若遇混合域照办）、
**本地 hook 的动作要进 `useEffect` 依赖数组，必须先自证身份稳定（`useCallback`）**（P5-3 教训，详见 §1 硬约束 ①）、
**改任何已迁移文件的声明文本时，先 grep `scripts/lib/*.py` 有没有逐字锚在它上面**（P5-3 教训，详见 §1 硬约束 ②）、
**写回源码的脚本必须显式 `newline="\n"` 并复测换行风格**（P5-2 把整份 `index.tsx` 写成 CRLF 的事故）、
**cut 脚本的中文注释里不要用 `"`**（P5-2 与 P5-3 各踩一次 `SyntaxError`）。

**每批收尾的固定动作（P5-3 已跑通最新一遍）**：
① 新出口自检 → ② 新反向变异（必须真跑出 12/12，不能只看"写完了"）→ ③ **十个出口自检全跑一遍**（跨批 `bare()` 口径会互相假红；P5-2 靠这一步抓出 p5a §6 与 p3d §198 两处，P5-3 靠这一步把 p5b §5 的五条轮询断言按"判据跟着 owner 走"移交）
→ ④ 六个探针全跑一遍（记录哪些条数变化、哪些是既有欠账）→ ⑤ `npx tsc --noEmit` + `pnpm test`（串行！**先确认 `lib/build-info.json` 在**）
→ ⑥ 回填五份证据文档（`baseline.md` 只记施工起点与一条"最新度量"引注）+ 设计文档状态行/§7 表 + 父任务 `docs/tasks/36c8e8ef-1104-4e68-b55f-a2a6cc533ab9-工作台插件优化/todo.md` 的度量表
→ ⑦ `workbench_update_progress` + `workbench_save_task_memory`（P5-3 每完成一批各报一次，AI 不得自行置为已完成）。

预计同批假红的既有判据（登记表 `migration-matrix.md` 的"后续批次预计会假红"一节）：
`test/draftWiring*` / 提醒与面板开关相关判据、`test/clientInvariants.test.mjs`、
`test/panelStateSource.test.mjs` / `panelCss.test.mjs`（P3-3/P3-4/P4/**P5-1/P5-2/P5-3** 实测**没**假红，P6 要重新验证 —— P6 动导航域，这两个文件是最可能被撞上的）、
P5-1 新登记的 `test/quickWorkspaceDefault.test.mjs` 的 `saveSettings` 那条（**P6-2 一定会撞上**）、
P5-3 新登记的 `test/draftBannerSessionJump.test.mjs:115` 那条 `setPendingDraft` 断言（**P6 若不碰草稿域就不会红**）、
以及 `d17-p5b-exit-check.py` §6 与 `d17-p5c-exit-check.py` §6 那两批 JSX props 断言（若 P6 顺手把提醒弹窗/SettingsModal/待处理弹窗提纯成视图）。
**改造方式：正向断言指向真实 owner，负向唯一性升级为全客户端递归（`countInClient` 命中分布断言，
断言唯一时用完整声明原文，别用松正则）。**
