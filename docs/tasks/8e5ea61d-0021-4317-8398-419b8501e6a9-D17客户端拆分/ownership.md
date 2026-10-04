# D17 状态所有权台账（全量 114 项，与实测一一对应）

> 本表是**迁移检索台账**：左列变量名是拆分时的检索键，拆分后按域落在 `hooks/` 里。
> "状态"列含义：`待迁移`（还在入口）/ `已迁移`（已进 hook，旧实现已删）/ `入口保留`（设计明确不搬）。
> P1 只动知识域；其余行的"现状"按施工起点（`f99bf77`）标注，实施到对应批次时**必须回来更新本表**。

## 0. 与实际源码的核对（P0 出口"没有未知 owner"）

统计口径先说清楚，否则 114 / 116 这两个数字会被混用：

| 口径 | 数量 | 来源 |
|---|---|---|
| 主组件 `WorkbenchApp` 内**直接** `useState` 调用 | **114** | 实测（`f99bf77`） |
| 全文件里的 `useState` 调用 | **116** | 另 2 处属于**宿主组件**的 tick 状态（不在 `WorkbenchApp` 体内） |
| 设计文档 §4 表格逐项列出的状态 | **114** | 12 个 owner 分组求和：1+5+6+4+9+7+7+2+9+17+11+12+7+12+5 |

核对结论：**§4 与实测 114 项一一对应，没有未知 owner**。其中：

- `useWorkspaceDirectoryPicker(5)` 在设计文档里虽然写成"（5）"而不是"（+5）"，
  但 §4 的 114 已经包含它 —— 它不是 `WorkbenchApp` 体内声明的状态，而是**同一个组件文件里
  另一个 hook 的状态**。本表仍把它单列，因为它同样要走 `openDirectory/applyDirectory` 的搬迁。
- 另有 **4 项容易漏记的细节**（不是缺项，是 owner 归属需要在本表里说清）：

| 项 | 行 | 说明 |
|---|---|---|
| `notificationCtor` | 438 | **不是 state**，是 `readNotificationCtor(globalThis)` 的普通常量（无 setter）；随 `useReminders` 一起搬 |
| `useToasts()` 的 `toasts/pushToast/dismissToast` | 447 | 已在 hook 里（第三方 `useToasts`），归反馈域；`ToastHost` 仍在装配层渲染 |
| `quickPersona` | 546 | §4 把它归 `useAISessions`；本表改为 **`useQuickIntake`** —— 它是快速录入弹窗的角色选择，与 `promptPersona` 必须保持**两份**（§6.2 明令不许合并），归录入域更贴合边界 |
| `promptResolveRef` | 513 | §4.1 提到"promptResolveRef→AI 提示词子 hook"，但 §4 主表没列；本表补进 `useAISessions` |

> **未确认项（如实登记）**：`picked` / `cursor` / `calMode` / `dayTab` / `archivedTasks` / `archivedMode` /
> `taskFilter` / `taskSortKey` / `taskSortDir` / `openFilter` / `expanded` / `todayExpanded` / `calendarExpanded` /
> `addingPlanTaskId` 这些状态的声明点**不在 276–559 状态区**（散落在 1850–2412 之间），上表按域归位；
> 本表用 grep 逐名核对过它们在入口出现的位置，但**具体行号以实施到该批次时的实时 grep 为准**
> （行号只作检索提示，不作迁移锚点 —— 设计文档 §2.1 的明确要求）。

## 1. 逐域台账

### `useWorkbenchNavigation`（1）—— ✅ P6-1 已迁移（文件：`src/client/hooks/useWorkbenchNavigation.ts`）

| state | 行 | owner | 现状 |
|---|---|---|---|
| `view` | 277 | `hooks/useWorkbenchNavigation.ts` | **已迁移**（P6-1；入口只解构读值 + 用 `setView`；`test/taskDetailWiring.test.mjs` 的正向已改指该 hook，入口留负向） |

### `useWorkbenchBusy`（1）—— ✅ P6-1 新建（`src/client/hooks/useWorkbenchBusy.ts`，`busy` 是跨域界面瞬态，不属任何业务域）

| state | 行 | owner | 现状 |
|---|---|---|---|
| `busy` | 511 | `hooks/useWorkbenchBusy.ts` | **已迁移**（P6-1；原列在 `useAISessions` 名下，但它被知识域借用 —— `useKnowledge` 收 `busy` / `setBusy` —— 故单独成 hook：**跨域界面瞬态，不属任何业务域**） |

### `useTaskData`（5）—— ✅ P3-4 已迁移（行号为 P0 快照，迁移后入口无裸名）

| state | 行 | owner | 现状 |
|---|---|---|---|
| `bootstrap` | 278 | TaskData | ✅ 已迁 `src/client/hooks/useTaskData.ts` |
| `tasks` | 279 | TaskData | ✅ 已迁（入口仍解构出局部名 `tasks`，见下"为什么保留局部名"） |
| `pendingCompletions` | 284 | TaskData | ✅ 已迁（入口**不解构**：搬迁区间外 0 处引用） |
| `selected` | 285 | TaskData | ✅ 已迁（`selectedRef` 只镜像选中 ID，也一并迁入；入口**不解构** `selectedRef`，改用 `currentTaskId()`） |
| `taskKnowledge` | 494 | TaskData | ✅ 已迁（**不是知识域**：它是"某任务的关联知识"，读 `GET /knowledge?source_task_id=`） |

> 随这 5 项一起迁走的还有 4 个只读派生（`dicts` / `dictOf` / `pendingMap` / `childrenIndex` / `childrenOf`）
> 与 8 个域动作（`refresh` / `loadTaskKnowledge` / `loadTaskDetail` / `patchTask` / `completePlanTask` /
> `saveProgress` / `completeTaskFromProgress` / `deferPlanTask`），外加 3 个**装配层原语**
> （`setTasks` / `clearSelectedTask` / `currentTaskId`）—— 加起来 `hooks/useTaskData.ts` = 273 行。
>
> **为什么入口必须解构出局部名**（而不是写 `data.tasks`）：`test/capacityWiring.test.mjs` 断言入口含
> `tasks: [...tasks, ...taskList.archivedTasks]`，`scripts/lib/d17-p3a-exit-check.py` 断言入口含
> `const taskList = useTaskListModel({ tasks, dictOf })`，`scripts/repro/probe-capacity-mutations.mjs` 的
> I1/I5 两条锚点也锚在这些原文上 —— 换 owner 时**只换来源、不改调用点文本**，三条判据/探针就都不用重锚。
>
> **跨域注入**：`loadTaskDetail` 的 `setError(...)` 与两处 `setNotice(...)` 改成入口注入的
> `onError` / `onNotice`（设计 §5，与 P1/P2 的 `useKnowledge` / `useIdeas` 同一条路）。
> 因此本域 hook 在入口里的**落点不在原 state 声明处**，而在 `error`/`notice` 之后（L365-366）——
> 注入回调要引用它们，而 `const` 没有提升。
>
> **刻意没搬的两件事**：`openTask` / `openTaskById`（`openTaskById` 首句是 `setView('list')`，属 Navigation，
> 设计 §4.1 第 148 行定案归装配层）与 `restoreTask` / `createSubtask`（都跨两个以上域，同条定案）。
> 入口里那条"P3-4 时会把 `restoreTask`/`createSubtask` 搬进 `useTaskData`"的过期前向承诺注释已删除。
>
> **P7-1 归域更新（本表 §5）**：`restoreTask` / `createSubtask` 与 `linkSessionRequest` / `archiveSelectedTask`、
> `createTask` 已随入口最后 6 处 `api(` 一起搬进本 hook（现 **407 行**）；跨域那一步改走新增的三条注入回调
> （`onTaskRestored` / `onSubtaskParentCleared` / `onTaskCreated`），`openTask` / `openTaskById` 仍留装配层。
> 规则写进 hook 文件头：**请求形状与它的输入校验归域；把结果接到哪些域的状态归装配层**。

### `useTaskDetailModel`（6）—— ✅ P3-2 已迁移（行号为 P0 快照，迁移后入口无裸名）

| state | 行 | owner | 现状 |
|---|---|---|---|
| `detailTab` | 289 | TaskDetailModel | ✅ P3-2 已迁移到 `hooks/useTaskDetailModel.ts`（透出 `Dispatch<SetStateAction<TaskDetailTab>>`） |
| `sessionPickerOpen` | 290 | TaskDetailModel | ✅ P3-2 已迁移（跨域写入走 `detail.actions.openSessionPicker` / `closeSessionPicker`） |
| `sessionPickerRole` | 291 | TaskDetailModel | ✅ P3-2 已迁移（入口解构读取，供 `linkExistingSession` 的 `roleCode`） |
| `sessionPickerQuery` | 292 | TaskDetailModel | ✅ P3-2 已迁移（入口解构读取，派生 `sessionQuery` 仍在入口） |
| `sessionPickerBusy` | 293 | TaskDetailModel | ✅ P3-2 已迁移（入口解构 setter，供 `linkExistingSession`） |
| `eventsExpanded` | 294 | TaskDetailModel | ✅ P3-2 已迁移（面板内用更新函数形式 `setEventsExpanded((v) => !v)`，故透出的是 `Dispatch` 而非 `(v: boolean) => void`） |

> P3-2 同时把"同一语义的两连调用"收成动作：`resetDetailView()`（页签复位 + 收起历史，原 `openTask`/`openTaskById` 各一份）、
> `openSessionPicker()`、`closeSessionPicker()`（面板「取消」与 `linkExistingSession` 成功后各一份）。
> 视图 `views/TaskDetailPane.tsx` 不发 HTTP：恢复任务与新建子任务的请求本体搬回入口的两个注入回调
> （`restoreTask` / `createSubtask`），组件只交 `FormData` 与父任务。

### `useTaskForms`（4）—— ✅ P3-3 已迁移（行号为 P0 快照，迁移后入口无裸名）

| state | 行 | owner | 现状 |
|---|---|---|---|
| `showForm` | 286 | TaskForms | ✅ P3-3 已迁移到 `hooks/useTaskForms.ts`（入口只读 `forms.showForm` 传给 `open`；开关语义走 `toggleCreate`，关闭语义走 `closeCreate`，**刻意不合并**） |
| `subtaskParent` | 287 | TaskForms | ✅ P3-3 已迁移（入口解构给详情面板；详情面板持有的是**意图 prop** `onAddSubtask` / `onCancelSubtask`，不再拿 setter） |
| `editDraft` | 288 | TaskForms | ✅ P3-3 已迁移（类型 `TaskEditDraft` 来自 `app/contracts.ts`；12 处内联 null-safe 展开收成 `patchDraft(patch)` 一个动作） |
| `formWorkspace` | 493 | TaskForms | ✅ P3-3 已迁移（唯一受控字段：表单非受控，但"浏览…"写回必须经 state；表单清空 effect `if (showForm) setFormWorkspace('')` 同批搬进 hook） |

> P3-3 同时把"同一语义的多处写法"收成动作：`toggleCreate`（工具栏 + 空态两处「新建」，原 2 处 `setShowForm((v) => !v)`）、
> `closeCreate`（新建成功后关闭）、`openEdit(draft)` / `closeEdit()`（详情面板「编辑」按钮与保存成功后各一处）、
> `patchDraft(patch)`（编辑弹窗 12 处）、`setSubtaskParent(task)`（详情面板两个按钮 + `createSubtask` 成功后清空，共 3 处）、
> `dismissOnTaskChange()`（换任务 effect 的两连 setState）。
> ⚠️ 换任务 effect 的依赖必须写这个稳定的 `dismissOnTaskChange` 引用，写 `forms.actions` 会每帧触发、编辑弹窗一开就被关（有判据守着）。
> 视图 `views/TaskFormModal.tsx` 不发 HTTP：新建任务与保存编辑的请求本体留在入口（`createTask(form: FormData)` / `saveEditDraft()`），
> 组件通过 `onSubmit` / `onSave` 注入；两个弹窗**故意不合成一个组件**（新建＝非受控 + FormData → 一次 POST；编辑＝受控草稿 + 12 个小改动 + 保存按钮）。

### `useQuickIntake`（9）—— ✅ P6-2 已迁移（行号为 P0 快照，迁移后入口无裸名）

| state | 行 | owner | 现状 |
|---|---|---|---|
| `showQuick` | 295 | `hooks/useWorkbenchQuickIntake.ts` | ✅ P6-2 已迁移（入口解构读值；JSX 的 `onClose` 改走 `closeIntake`） |
| `quickText` | 296 | `hooks/useWorkbenchQuickIntake.ts` | ✅ P6-2 已迁移（入口用透出的 `setQuickText`） |
| `quickWorkspace` | 304 | `hooks/useWorkbenchQuickIntake.ts` | ✅ P6-2 已迁移（M-P6b-1 守着"不许收回入口"） |
| `quickWorkspaceTouched` | 305 | `hooks/useWorkbenchQuickIntake.ts` | ✅ P6-2 已迁移（**用户已动过**闸门；`M-P6b-5` 守着唯一写点 `overrideWorkspace`） |
| `quickWorkspaceSource` | 312 | `hooks/useWorkbenchQuickIntake.ts` | ✅ P6-2 已迁移（来源提示） |
| `quickFollowFolder` | 313 | `hooks/useWorkbenchQuickIntake.ts` | ✅ P6-2 已迁移（建资料夹默认勾选） |
| `quickAttachments` | 320 | `hooks/useWorkbenchQuickIntake.ts` | ✅ P6-2 已迁移（与 `quickAttachmentsRef` **同一出口同写**，两个内部写入点 `writeQuickAttachments` / `appendQuickAttachments` 一并进 hook；`M-P6b-2` / `M-P6b-3` 守着） |
| `quickAttachmentNotice` | 321 | `hooks/useWorkbenchQuickIntake.ts` | ✅ P6-2 已迁移（不收的附件要给中文原因） |
| `quickPersona` | 546 | `hooks/useWorkbenchAISessions.ts` | ✅ **P6-3** 已迁移（**不属录入域**：它是澄清入口的角色选择，随 AI 会话域进 `hooks/useWorkbenchAISessions.ts`；入口 `openQuickEntry` 里那次复位 `setQuickPersona(INHERIT_PERSONA)` 仍留装配层） |

> **刻意留装配层**：`openQuickEntry`（跨域组合：录入域 `openIntake()` + AI 会话域的 `resetClarifyPicker()`）、
> 提交闸门 `shouldRememberQuickWorkspace(quickWorkspaceTouched, chosen)`、`detectWslHost` 的**注入**（搬进 hook 会成环）。
> 共用纯模块 `src/client/intakeHelpers.ts`（`newTaskId` / `fileToBase64` / `quickImageToPromptPart`）被录入域与 AI 会话域共用。

### `useDrafts`（7 + 3 ref）—— ✅ P5-3 已迁移（行号为 P0 快照，迁移后入口无裸名）

| state | 行 | owner | 现状 |
|---|---|---|---|
| `pendingDraft` | 359 | `hooks/useWorkbenchDrafts.ts` | **已迁移**（= "要不要弹"，**已被本地屏蔽集合过滤**；入口只解构读值：`DraftBanner` 条件、`hasPendingPlanDraft`、`PENDING_ATTR` 投影） |
| `deferredDrafts` | 361 | `hooks/useWorkbenchDrafts.ts` | **已迁移**（暂存清单，只出现在待处理弹窗） |
| `draftProblems` | 366 | `hooks/useWorkbenchDrafts.ts` | **已迁移**（"本该创建但没创建"的常驻告警，**不用 toast**） |
| `draftSwitchedFrom` | 399 | `hooks/useWorkbenchDrafts.ts` | **已迁移**（弹框"被静默换人"时的告知来源） |
| `allPendingDrafts` | 405 | `hooks/useWorkbenchDrafts.ts` | **已迁移**（服务端事实；`pendingCount` 用它，**绝不用本地过滤后的 `pendingDraft`**） |
| `pendingOpen` | 410 | `hooks/useWorkbenchDrafts.ts` | **已迁移**（待处理弹窗开关；入口只解构读值 —— M-P5c-1 守着"不许收回入口"） |
| `duplicatePrompt` | 417 | `hooks/useWorkbenchDrafts.ts` | **已迁移**（内联类型提成具名 `DraftDuplicatePrompt`；服务端**只告警、不静默合并**） |
| `dismissedDraftIdsRef` | 380 | `hooks/useWorkbenchDrafts.ts` | **已迁移**（**收起不改计数**；只过滤"要不要弹"，不参与计数） |
| `deferredWhenDismissedRef` | 387 | `hooks/useWorkbenchDrafts.ts` | **已迁移** |
| `bannerDraftRef` | 398 | `hooks/useWorkbenchDrafts.ts` | **已迁移**（仅"真实暂存 → 唤回"解除屏蔽；M-P5c-3 守着"屏蔽集合只有一份"） |

域动作 6 个同批搬走：`dismissDraft` / `resumePendingDraft` / `resumeDeferredDraft` / `handleDraftConfirmed` /
`reuseExistingTask`，外加轮询用的 `tickDrafts(isAlive)`（`useCallback(…, [])`，身份恒定）。
**刻意留装配层**：`pendingDraft` → `PENDING_ATTR` 的宿主 DOM 投影 effect（设计 §4.1 末行，写 `document.documentElement`）；
`DraftBanner` 那一整块 JSX（`onDone` 同时写点子/知识/日期三域）。

### `useWorkbenchPolling`（1 条 effect）—— ✅ P5-3 新建

| 项 | 归属 | 现状 |
|---|---|---|
| 混合域轮询 effect（原入口 L574–636） | `hooks/useWorkbenchPolling.ts` | **已迁移**：5 秒 tick（草稿 → 提醒，**串行**，共用同一个 `try`/`catch`）+ 15 秒 refresh、`alive` 卸载守卫、两个定时器、清理。依赖数组 `[refresh, desktopNotify, tickDrafts, tickReminders]`（重建时机与原 `[refresh, settings.desktopNotify]` 逐字等价，见该文件头论证）。**本批解锁 ADR-0008 硬门的一条：`WorkbenchApp` 体内零 `setInterval`/`setTimeout`。** |

### `useWorkbenchReminders`（7 + 3 ref/常量）—— ✅ P5-2 已迁移（行号为 P0 快照，迁移后入口无裸名）

| state | 行 | owner | 现状 |
|---|---|---|---|
| `reminders` | 406 | `hooks/useWorkbenchReminders.ts` | **已迁移**（入口只解构读值；弹窗、待处理计数、待处理弹窗三处读它） |
| `reminderModalOpen` | 409 | `hooks/useWorkbenchReminders.ts` | **已迁移**（自动弹 + 手动关共用一个开关；入口只解构读值、不再自建 state —— M-P5b-1 守着） |
| `notifyPerm` | 439 | `hooks/useWorkbenchReminders.ts` | **已迁移**（三态由 `notificationCapability.ts` 收口） |
| `reminderPolicy` | 449 | `hooks/useWorkbenchReminders.ts` | **已迁移**（打开设置面板时装载，依赖 `[showSettings]`） |
| `reminderChannel` | 450 | `hooks/useWorkbenchReminders.ts` | **已迁移**（入口 `onSelectTarget` 用**函数式更新**写它 ⇒ hook 的 setter 必须是原生 `Dispatch<SetStateAction<…>>`） |
| `reminderOptions` | 451 | `hooks/useWorkbenchReminders.ts` | **已迁移** |
| `reminderBusy` | 452 | `hooks/useWorkbenchReminders.ts` | **已迁移** |
| `notifiedRef` / `persistNotified` | — | `hooks/useWorkbenchReminders.ts` | **已迁移**（**原存储键 `dsh-workbench:desktop-notified` 不变**；>500 保留后 250） |
| `notificationCtor` | 438 | `hooks/useWorkbenchReminders.ts` | **已迁移**（普通常量，非 state）；⚠️ 入口在**两个内联回调**里仍就地 `readNotificationCtor(globalThis)`（授权 / 测试通知），按设计刻意留装配层 |
| `tickDue(isAlive)` | — | `hooks/useWorkbenchReminders.ts` | **已迁移**（本批唯一"半个 effect"：只搬 `tick` 里提醒那一半。**P5-3 已接手**：5 秒/15 秒两个定时器与整片轮询 effect 现归 `hooks/useWorkbenchPolling.ts`，入口零定时器；`tickDue` 在 P5-3 包了一层 `useCallback(…, [desktopNotify])` 让身份只在设置变化时改变 —— 签名与体内行为未改） |

### `useWorkbenchFeedback`（2）—— ✅ P5-1 已迁移

| state | 行 | owner | 现状 |
|---|---|---|---|
| `error` | 407 | `hooks/useWorkbenchFeedback.ts` | **已迁移** |
| `notice` | 408 | `hooks/useWorkbenchFeedback.ts` | **已迁移**（配 `useToasts()`；`toasts/pushToast/dismissToast` 一并归该 hook，入口只解构） |

### `useWorkbenchSettings`（9）—— ✅ P5-1 已迁移

| state | 行 | owner | 现状 |
|---|---|---|---|
| `settings` | 426 | `hooks/useWorkbenchSettings.ts` | **已迁移**（**注意**：入口 L1897 `rememberQuickWorkspace` / L1918 `forgetQuickWorkspace` 仍写 `setSettings(withSettingsFallback(res.settings))` —— 这是 P6 的跨域写点，按设计留在装配层） |
| `showSettings` | 442 | `hooks/useWorkbenchSettings.ts` | **已迁移**（**也参与视图门控**，装配层解构 `showSettings` 读它） |
| `settingsSaving` | 443 | `hooks/useWorkbenchSettings.ts` | **已迁移** |
| `recallLog` | 445 | `hooks/useWorkbenchSettings.ts` | **已迁移** |
| `recallSessionOff` | 446 | `hooks/useWorkbenchSettings.ts` | **已迁移** |
| `dictKind` | 453 | `hooks/useWorkbenchSettings.ts` | **已迁移** |
| `dictForm` | 454 | `hooks/useWorkbenchSettings.ts` | **已迁移** |
| `dictEditCode` | 455 | `hooks/useWorkbenchSettings.ts` | **已迁移** |
| `dictError` | 456 | `hooks/useWorkbenchSettings.ts` | **已迁移** |

> **P7-1 归域更新（本表 §5）**：`saveIncludeOverdue` / `saveDailyCapacity(rawEdit: string)` 已从装配层收进本 hook
> （P5-1 时按 P4 决策留装配层，P7-1 才归域）；两者都用 `setSettings` 的**函数式更新**，输入校验
> （`<30` → 390、上限 1440）随请求一起进域，`saveDailyCapacity` 收的是**日期域交出的行内编辑态原文**（跨域只传值）。
> 装配层仍保留一个零入参 `saveDailyCapacity()` 包壳（读日期域的 `capacityEdit` 原文再递给本域动作）。
> 规则同 P7-1：**请求形状与它的输入校验归域；把结果接到哪些域的状态归装配层**。hook 现 **311 行**。

### `useDayWorkspace`（17）—— ✅ P4 已迁移（行号为 P0 快照，迁移后入口无裸名）

| state | 行 | owner | 现状 |
|---|---|---|---|
| `capacityEdit` | 428 | `hooks/useDayWorkspace.ts` | **已迁移**（入口只读 `day.capacityEdit`；写入仍归设置域的 `saveDailyCapacity` —— P5-1 **没有**搬它，按 P4 决策留在装配层，P6 处理） |
| `capacityExpanded` | 430 | `hooks/useDayWorkspace.ts` | **已迁移**（`setCapacityExpanded` 经解构注入 `CapacityRulePanel`） |
| `reportSubTab` | 457 | `hooks/useDayWorkspace.ts` | **已迁移**（**声明原文是 `useState<ReportSubTab>('day')`**，用的是 hook 导出的类型别名而非字面量联合） |
| `currentReport` | 458 | `hooks/useDayWorkspace.ts` | **已迁移** |
| `reportSession` | 459 | `hooks/useDayWorkspace.ts` | **已迁移** |
| `pickedPlan` | 460 | `hooks/useDayWorkspace.ts` | **已迁移**（跨域读点：入口 `startAISession` 里的 `hasPlan` 判定也要用它） |
| `pickedPlanSession` | 461 | `hooks/useDayWorkspace.ts` | **已迁移**（入口 0 处引用，靠 `void pickedPlanSession` 保留） |
| `planRefreshKey` | 462 | `hooks/useDayWorkspace.ts` | **已迁移**（**key 归域，装配层只调 `bumpPlanRefresh()`** —— 草稿域 `onDone` 也是调它） |
| `reportRefreshKey` | 509 | `hooks/useDayWorkspace.ts` | **已迁移**（对外 `bumpReportRefresh()`；P3-4 的 `useTaskData.refresh` 不碰它） |
| `todayPlanSession` | 510 | `hooks/useDayWorkspace.ts` | **已迁移**（入口 0 处引用，靠 `void todayPlanSession` 保留） |
| `todayExpanded` | 1973 | `hooks/useDayWorkspace.ts` | **已迁移**（`toggleTodayExpanded` 动作；`collapseAll` 的另一半） |
| `calendarExpanded` | 1974 | `hooks/useDayWorkspace.ts` | **已迁移**（`toggleCalendarExpanded` 动作） |
| `picked` | 2074 | `hooks/useDayWorkspace.ts` | **已迁移**（惰性初值 `useState<Date>(() => startOfDay(now))`，避免 `now` 进依赖数组） |
| `addingPlanTaskId` | 2288 | `hooks/useDayWorkspace.ts` | **已迁移**（`addTaskToPlan` 的装载标记） |
| `cursor` | 2411 附近 | `hooks/useDayWorkspace.ts` | **已迁移**（惰性初值 `useState<Date>(() => startOfWeek(now))`） |
| `calMode` | 2411 | `hooks/useDayWorkspace.ts` | **已迁移** |
| `dayTab` | 2412 | `hooks/useDayWorkspace.ts` | **已迁移**（**今日/日历共用**，过去日期收敛走 `resolveDayPanelTab`；入口装配仍写 `tab: dayTab`） |

配套派生/动作（全在 hook 内）：`pickedAnchor`、`planCandidateInfo`（含导出给入口的 `planPromptFor`）、
`todayPromptInfo` / `todayPlanCandidateRows` / `pickedPromptInfo` / `pickedPlanCandidateRows`、`capacity`（探针 I1 新锚点）、
`reportAnchor` / `reportScope` / `todayAnchor` / `thisWeekAnchor` / `reportIsFuture`、`weekDays` / `monthGrid`、
`useDayPanelModel(...)` 调用、四个 effect（报告加载 / 今日计划会话 / 选中日计划 / `dayTab` 复位）、
17 个动作（`addTaskToPlan` / `patchPlanItem` / `savePlan` / `clearPlan` / `deleteReport` /
`toggleTodayExpanded` / `toggleCalendarExpanded` / `collapseExpanded` / `moveWeek` / `moveMonth` /
`setCapacityEdit` / `setCapacityExpanded` / `setReportSubTab` / `setPicked` / `setCursor` / `setCalMode` / `setDayTab`）。
**刻意留在 hook 外的三件事**：`saveIncludeOverdue` / `saveDailyCapacity`（写 `settings`，属设置域）、
`collapseAll`（跨域组合：列表域 + 日期域各一半）、`dayPanelProps`（装配层，含跨域注入）。
**刻意留在 hook 内的死代码**：`clearTodayPlan`（搬迁前即 0 处引用，与 `clearPlan(date)` 语义重叠；只换 owner 不改行为，P7 评估删除）。

### `useKnowledge`（11）—— ✅ P1 已迁移

| state | 原行 | 新 owner | 现状 |
|---|---|---|---|
| `knowledgeEntries` | 463 | `hooks/useKnowledge.ts` | **已迁移** |
| `knowledgeFilters` | 470 | `hooks/useKnowledge.ts` | **已迁移**（`KNOWLEDGE_FILTER_STORAGE_KEY = 'dsh.personal-workbench.knowledgeList'` 原键不变） |
| `selectedKnowledge` | 471 | `hooks/useKnowledge.ts` | **已迁移** |
| `knowledgeDraft` | 472 | `hooks/useKnowledge.ts` | **已迁移** |
| `knowledgeEditId` | 473 | `hooks/useKnowledge.ts` | **已迁移** |
| `knowledgeRefreshKey` | 474 | `hooks/useKnowledge.ts` | **已迁移**（对外暴露 `bumpRefreshKey()`） |
| `localDocPath` | 475 | `hooks/useKnowledge.ts` | **已迁移**（文件选择弹窗状态） |
| `filePickerOpen` | 476 | `hooks/useKnowledge.ts` | **已迁移** |
| `filePickerListing` | 477 | `hooks/useKnowledge.ts` | **已迁移** |
| `filePickerLoading` | 478 | `hooks/useKnowledge.ts` | **已迁移** |
| `filePickerError` | 479 | `hooks/useKnowledge.ts` | **已迁移** |

配套派生：`knowledgeDicts`（`dictOf('knowledge_kind')`）、`knowledgePage`（`buildListPage<ContentItem>`）、
`updateKnowledgeFilters`、两条 effect（落盘 / `reconcileKnowledgeKinds` 对账）→ **全部在 hook 内**。
顶层纯函数 `readKnowledgeFilters` / `writeKnowledgeFilters` 与常量 `KNOWLEDGE_FILTER_STORAGE_KEY` → **搬进 hook**。

### `useIdeas`（12）—— ✅ P2 已迁移

| state | 行 | owner | 现状 |
|---|---|---|---|
| `ideas` | 495 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |
| `ideaClusters` | 496 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |
| `ideaTab` | 497 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |
| `ideaQuery` | 498 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |
| `ideaKind` | 499 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |
| `selectedIdeaIds` | 500 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |
| `selectedIdea` | 501 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |
| `selectedCluster` | 502 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |
| `ideaForm` | 503 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |
| `ideaEditId` | 504 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |
| `folderForm` | 507 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |
| `ideaRefreshKey` | 508 | Ideas | ✅ P2 已迁移到 `hooks/useIdeas.ts` |

### `useTaskListModel`（7）—— ✅ P3-1 已迁移（行号为 P0 快照，迁移后入口无裸名）

| state | 行（P0 快照） | owner | 现状 |
|---|---|---|---|
| `archivedTasks` | 1977 | TaskListModel | ✅ P3-1 已迁移到 `hooks/useTaskListModel.ts`（入口只读快照 `taskList.archivedTasks`） |
| `archivedMode` | 1978 | TaskListModel | ✅ P3-1 已迁移（跨域写入走 `taskList.actions.setArchivedMode`） |
| `taskFilter` | 1979 | TaskListModel | ✅ P3-1 已迁移（hook 内名 `filter`，初值共享 `EMPTY_TASK_FILTER`） |
| `taskSortKey` | 1980 | TaskListModel | ✅ P3-1 已迁移（hook 内名 `sortKey`） |
| `taskSortDir` | 1981 | TaskListModel | ✅ P3-1 已迁移（hook 内名 `sortDir`） |
| `openFilter` | 1982 | TaskListModel | ✅ P3-1 已迁移 |
| `expanded` | 1850 附近 | TaskListModel | ✅ P3-1 已迁移（展开集合，落 `TREE_EXPANDED_STORAGE_KEY = 'dsh.personal-workbench.treeExpanded'`） |

### `useAISessions`（12 + 1 ref）—— ✅ P6-3 已迁移（文件：`src/client/hooks/useWorkbenchAISessions.ts`）

> 口径修正：本表这 12 项里 `busy` 已于 **P6-1** 单独成 `hooks/useWorkbenchBusy.ts`（跨域界面瞬态）；
> 而 `quickPersona`（列在 `useQuickIntake` 表末行）实际落在本 hook 里 —— 两者对调后仍是 12 项。
> hook 实收 12 项 state：`promptModal` / `skillCatalog` / `skillsAvailable` / `skillsLoading` / `skillProblem` /
> `skillQuery` / `selectedSkills` / `promptPersona` / `promptModelSelection` / `quickModelSelection` /
> `modelModalityTable` / `quickPersona`。

| state | 行 | owner | 现状 |
|---|---|---|---|
| `busy` | 511 | `hooks/useWorkbenchBusy.ts` | ✅ **P6-1** 已迁移（**被知识域借用**：`useKnowledge` 收 `busy/setBusy`；因跨域而单独成 hook） |
| `promptModal` | 512 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移（提示词子 hook 的开关） |
| `skillCatalog` | 515 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移（选项子 hook） |
| `skillsAvailable` | 516 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移 |
| `skillsLoading` | 517 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移 |
| `skillProblem` | 535 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移 |
| `skillQuery` | 536 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移 |
| `selectedSkills` | 537 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移（`toggleSkill` 同批） |
| `promptPersona` | 545 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移（与 `quickPersona` **两份，不许合并**） |
| `promptModelSelection` | 554 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移（与 `quickModelSelection` 同键、两份入口编辑态，**不新增实时同步 effect**） |
| `quickModelSelection` | 346 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移（同上；写 localStorage 的包装 setter 同批） |
| `modelModalityTable` | 358 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移 |
| `promptResolveRef` | 513 | `hooks/useWorkbenchAISessions.ts` | ✅ P6-3 已迁移（提示词子 hook 的 resolve 通道） |

> 同批搬走的动作（9 个）：`loadSkills`（`useCallback(…, [])`，身份恒定）/ `askUserPrompt` / `confirmPrompt` /
> `cancelPrompt` / `toggleSkill` / `AI_PROMPT_LABELS` / `openSessionInPanel` / `startAISession`（**468 行**）/ `reuseAiSessionId`，
> 外加本批**新增** `resetClarifyPicker()`（角色复位 + 技能复位 + 重拉技能目录；供入口 `openQuickEntry` 组装用）。
> **刻意留装配层**：`openQuickEntry` 的两半段组合、AI 会话相关 JSX 与全部调用点文本。

### `useWorkspaceDirectoryPicker`（5）—— ✅ P6-4 已迁移（文件：`src/client/hooks/useWorkbenchDirectoryPicker.ts`）

| state | 行 | owner | 现状 |
|---|---|---|---|
| `dirPickerTarget` | 487 | `hooks/useWorkbenchDirectoryPicker.ts` | ✅ P6-4 已迁移（**零入参** hook；`setDirPickerTarget` 透出） |
| `dirPickerPath` | 488 | `hooks/useWorkbenchDirectoryPicker.ts` | ✅ P6-4 已迁移（`setDirPickerPath` 透出） |
| `dirPickerListing` | 489 | `hooks/useWorkbenchDirectoryPicker.ts` | ✅ P6-4 已迁移（`loadDirPickerDir` 同批） |
| `dirPickerLoading` | 490 | `hooks/useWorkbenchDirectoryPicker.ts` | ✅ P6-4 已迁移 |
| `dirPickerError` | 491 | `hooks/useWorkbenchDirectoryPicker.ts` | ✅ P6-4 已迁移 |

> **刻意留装配层的两件事**：`openDirPicker(target)`（起始目录来自**快速录入 / 表单 / 编辑草稿三个域的当前值**，
> 没有单一业务 owner）与 `applyWorkspaceDir(dirPath)`（**唯一分派点**，按 `dirPickerTarget` 写回那三个域）。
> 本批另产生两个死 import（`localDirRequestUrl` / `LocalDirListing`），按 P4 的决定**留给 P7 一次性清**。

## 2. 关联 ref / effect / 派生（§4.1 全量）

| 项 | 归属 | 现状 |
|---|---|---|
| `selectedRef` | TaskData（**只镜像选中 ID**） | ✅ 已迁 P3-4（入口改用 `currentTaskId()` 读，剥注释后入口 0 处裸名） |
| `quickAttachmentsRef` / `quickImageInputRef` / `writeQuickAttachments` | QuickIntake（同一出口同写 state+ref） | ✅ 已迁 P6-2（`hooks/useWorkbenchQuickIntake.ts`；内部写入点 `writeQuickAttachments` / `appendQuickAttachments` 同批） |
| `dismissedDraftIdsRef` / `deferredWhenDismissedRef` / `bannerDraftRef` | Drafts | ✅ 已迁 P5-3（三个 ref 与 7 项 state 同批进 `hooks/useWorkbenchDrafts.ts`） |
| `notifiedRef` / `persistNotified` | Reminders | ✅ 已迁 P5-2（`hooks/useWorkbenchReminders.ts`） |
| `promptResolveRef` | AISessions 提示词子 hook | ✅ 已迁 P6-3（`hooks/useWorkbenchAISessions.ts`） |
| `pendingMap` / `childrenIndex` / `dicts` / `dictOf` | TaskData 只读派生（**pending 不可用 = null 与空 Map 是两件事**） | ✅ 已迁 P3-4（`childrenIndex` 入口不解构；`childrenOf` 解构后传给视图） |
| today / picked 候选 + `capacity` | DayWorkspace | ✅ 已迁 P4（`planCandidateInfo` / `todayPromptInfo` / `pickedPromptInfo` / 两份 `*CandidateRows` / `capacity` 全在 `hooks/useDayWorkspace.ts`；入口只读解构名） |
| `dayPanelProps` | DayWorkspace **但归装配层** | 入口保留（跨域：`tab` / `onTabChange` / `selectedId` / `pending` / `childrenOf` / `onOpen` / `onProgressChange` 等都是外域注入；两段内联 `api(...)` 已提成 hook 动作 `clearPlan` / `deleteReport`） |
| `knowledgePage` / `ideaCardItems` / `unfiledIdeas` | Knowledge / Ideas 只读派生 | 三者**均已迁移**（P1 `knowledgePage`、P2 `ideaCardItems`+`unfiledIdeas`）；P3-1 另有 TaskListModel 的 `visibleTree`/`typeTabs`/`sourceEmpty` |
| 宿主 selected 镜像 / 面板显示 / 几何与槽位 effect | 现有宿主适配（`decidePanel`/`panelDataOpen` 保持唯一） | 入口保留（§6.3：D17 优先不搬宿主 apply 主体） |

## 3. 入口保留（设计明确不搬）

- `WorkbenchApp` 自身签名与 `runtime` / `closePanel` 参数。
- 宿主相关：官方槽位、面板可见性、buildId 投影、`hostSelectedFromMirror`、侧栏量宽重试、
  TopInset 清理、DOM 白名单（**禁止改 inject/profile/启动方式或在宿主侧栏插节点**）。
- `useToast()` 的 `toasts/pushToast/dismissToast` 归反馈域，但 `ToastHost` 仍在装配层渲染。
- **轮询容器**：5 秒 `tick` + 15 秒 `refresh` 那条混合域 effect **已在 P5-3 搬进**
  `hooks/useWorkbenchPolling.ts`（设计 §7 第 184 行："无业务状态的 effect 装配器"），
  它本身不留任何业务 state —— 入口现在**零定时器**，`WorkbenchApp` 体内 `setInterval`/`setTimeout` 均为 0
  （入口整份文件只剩插件 setup 作用域的 `titlebarTimer`）。
- **`pendingDraft` → `PENDING_ATTR` 的宿主 DOM 投影 effect**（写/清 `document.documentElement`）**刻意留装配层**：
  它是宿主契约（插件据此隐藏自己的浮层），不是草稿域的业务状态 —— 见设计 §4.1 末行"DOM 白名单和清理不变"。
- 入口两个内联回调里的 `readNotificationCtor(globalThis)`（授权 / 测试通知）属宿主能力探测，留装配层。

## 4. 未迁移项（截至 P6-4，**显式列出，防止被当成已完成**）

已完成：P1 知识域 11 项、P2 点子域 12 项、P3-1 任务列表域 7 项、P3-2 任务详情域 6 项、P3-3 任务表单域 4 项、
P3-4 任务数据域 5 项、P4 日期域 17 项、P5-1 反馈域 2 项 + 设置域 9 项、
P5-2 提醒域 7 项 state + 3 条设施（`notificationCtor` / `notifiedRef` / `persistNotified`）+ 8 个动作 + `tickDue`、
P5-3 草稿域 7 项 state + 3 个 ref + 6 个动作 + 整片轮询 effect（新 hook `useWorkbenchPolling`）、
**P6-1 导航域 1 项（`view`）+ 忙碌标志 1 项（`busy`，新 hook `useWorkbenchBusy`）**、
**P6-2 快速录入域 8 项 state + 2 个 ref + 两个内部写入点 + 7 个动作 + 1 条卸载 effect（新 hook `useWorkbenchQuickIntake` + 纯模块 `src/client/intakeHelpers.ts`）**、
**P6-3 AI 会话域 12 项 state + 1 个 ref（`promptResolveRef`）+ 9 个动作 + 新增 `resetClarifyPicker()`（新 hook `useWorkbenchAISessions`，914 行）**、
**P6-4 目录选择域 5 项 state（新 hook `useWorkbenchDirectoryPicker`，81 行，零入参）**
（各含其派生/动作/存储键）。

**P6 四批全部完成**（P6-1 导航 + 忙碌标志 / P6-2 快速录入域 / P6-3 AI 会话域 / P6-4 目录选择域）——
**入口 `WorkbenchApp` 体内直接 `useState(` 已为 0**（D17 起点 114 项、P6 开工时 27 项；P6-1 搬 2 / P6-2 搬 8 / P6-3 搬 12 / P6-4 搬 5），
入口 **2814 行**、`WorkbenchApp` **1389 行**（L173–1561）。

**其余只剩 P7 的遗留**（**不再是"某个域还没搬"**）：
`views/*` 的 JSX 收口、工具栏 / 弹窗装配提取、入口 **12 个死 import**
（P4 的 10 个 + P6-4 新增的 `localDirRequestUrl` / `LocalDirListing`）、
`hooks/useDayWorkspace.ts` 的 `clearTodayPlan` 死代码、体内 **6 处 `api(`**（ADR-0008 的业务请求硬门尚未达成）与体内 **3 条 `useEffect(`**。

**P3（任务域）、P4（日期域）、P5（反馈域 + 设置域 + 提醒域 + 草稿域 + 轮询装配）与 P6（导航 + 忙碌标志 / 快速录入域 / AI 会话域 / 目录选择域）已全部完成** ——
P3-1/P3-2/P3-3/P3-4 四个子批、P4、P5-1、P5-2、P5-3 与 P6-1～P6-4 各自的 state/派生/动作都已有唯一 owner，
入口不再自持任务域、日期域、反馈域、设置域、提醒域、草稿域、导航域、快速录入域、AI 会话域、目录选择域任何 state，
也不再持有任何定时器与任何直接 `useState`。
P3 各子批把三块 JSX 搬成
`views/TaskListView.tsx` / `views/TaskDetailPane.tsx` / `views/TaskFormModal.tsx`（表单项本身不是 state，
不出现在本台账的 114 项里）；**P4 把今日/日历两块 JSX 搬成 `views/TodayPane.tsx` / `views/CalendarView.tsx` ——
至此设计 §2.1 判据 3「today/calendar/list/knowledge/ideas 五个视图及任务详情各自成组件」全部达成。**
P5-1 把 `SETTINGS_FALLBACK` + `withSettingsFallback` 从入口搬到纯模块 `src/client/settingsFallback.ts`
（设置域 hook 与仍留在入口的 `rememberQuickWorkspace`/`forgetQuickWorkspace` 都要用它，放哪一方都不对）。
**入口保留的 settings 写点**：`saveIncludeOverdue` / `saveDailyCapacity`（P4 决策留在装配层）；
`rememberQuickWorkspace` / `forgetQuickWorkspace` 已在 **P6-2** 随快速录入域进 `hooks/useWorkbenchQuickIntake.ts`
（走注入的 `setSettings`，设计 §5），**入口不再保留这两个写入点**。
P5-2 把提醒域整域搬进 `src/client/hooks/useWorkbenchReminders.ts`；**P5-3 接着把 `tick` 里草稿那一半与整片轮询容器
拆开成 `useWorkbenchDrafts` + `useWorkbenchPolling`**（本批解锁 ADR-0008 硬门的一条：`WorkbenchApp` 体内零定时器）。
**P6-1～P6-4 接着把最后四个域（导航 + 忙碌标志 / 快速录入 / AI 会话 / 目录选择）全部搬走，并把入口体内的直接 `useState` 清零。**
入口在**两个内联回调**里仍有 `readNotificationCtor(globalThis)`（授权 / 测试通知），按设计刻意留装配层。
下一批是 **P7 主组件落位（`app/WorkbenchApp.tsx`）+ 工具栏/弹窗装配提取 + 入口 12 个死 import 与 `clearTodayPlan` 死代码清理
+ 体内 6 处 `api(` 归域 + 总回归**；P7 尚未开工。

## 5. P7 入口收口（已跑绿：入口 2814 → 1972、`WorkbenchApp` 1389 → 631）

> 本节记录 P7 三批的**实际落点**，并作废 §4 末尾"P7 尚未开工"的前向预告：
> P7 **没有**把 `WorkbenchApp` 移进 `app/WorkbenchApp.tsx` —— 主组件仍在 `src/client/index.tsx`（第 92–722 行），
> 搬出去的是**四段 JSX**（进 `src/client/app/`）与新增的装配束 `app/assembly.ts`；
> `useDayWorkspace.ts#clearTodayPlan` 的既有死代码**评估后保留**（搬迁前就存在，不是 D17 引入的欠账）。

### 5.1 三批规模（实测）

| 子批 | 入口 `src/client/index.tsx` | `WorkbenchApp` | 内容 |
|---|---|---|---|
| P7-1 | 2814 → 2750 | 1389 → 1325 | 入口最后 6 处业务请求（`api(`）归域 |
| P7-2 | 2750 → 2102 | 1325 → 673 | 四段 JSX 搬进 `src/client/app/` + 新增装配束 |
| P7-3 | 2102 → 1972 | 673 → 631 | 清死 import / 死解构 + 收排版 |
| **P7 合计** | **2814 → 1972（-842）** | **1389 → 631（-758）** | |
| **D17 累计**（起点 5725 / 4197） | **5725 → 1972（-3753）** | **4197 → 631（-3566）** | |

### 5.2 P7-1：最后 6 处请求归域（owner）

| 请求函数 | 新 owner | 备注 |
|---|---|---|
| `linkSessionRequest` | `hooks/useTaskData.ts` | 只交**请求原语**；调用点（`linkExistingSession`）仍留装配层 |
| `archiveSelectedTask` | `hooks/useTaskData.ts` | 失败分支的"not found 自愈"（清选中 + 清 ref）仍在 hook 内 |
| `restoreTask` | `hooks/useTaskData.ts` | 成功后的"退出归档态"改走注入 `onTaskRestored` |
| `createTask` | `hooks/useTaskData.ts` | 成功后的"收起新建弹窗"改走注入 `onTaskCreated` |
| `createSubtask` | `hooks/useTaskData.ts` | 成功后的"收起子任务表单"改走注入 `onSubtaskParentCleared` |
| `saveIncludeOverdue` | `hooks/useWorkbenchSettings.ts` | 失败**回滚** `settings`，不静默失败 |
| `saveDailyCapacity(rawEdit: string)` | `hooks/useWorkbenchSettings.ts` | 入参是**日期域交出的行内编辑态原文**；输入校验随请求一起进域 |

**新增的三条跨域注入回调**（留装配层，只把"结果接到别的域"那一半留在入口）：
`onTaskCreated: () => forms.actions.closeCreate()`、
`onSubtaskParentCleared: () => forms.actions.setSubtaskParent(null)`、
`onTaskRestored: () => taskList.actions.setArchivedMode(false)`。

**规则**（写进两个 hook 的文件头）：**请求形状与它的输入校验归域；把结果接到哪些域的状态归装配层**。

### 5.3 P7-2：`src/client/app/` 四段装配 + 装配束

| 新文件 | 行数 | 内容 |
|---|---|---|
| `app/assembly.ts` | 91 | `export interface WorkbenchAssembly` = 16 个域 hook 结果（类型一律 `ReturnType<typeof useXxx>`）+ `runtime` / `closePanel` / `loadModelModalityTable` / `aiSessionUsable` + 17 个装配层本地值 |
| `app/WorkbenchHeader.tsx` | 44 | 顶栏 |
| `app/WorkbenchOverlays.tsx` | 195 | 提示层（用 `<>…</>` 包住） |
| `app/WorkbenchBody.tsx` | 224 | 主体 |
| `app/WorkbenchDialogs.tsx` | 358 | 弹窗层（用 `<>…</>` 包住） |

17 个装配层本地值：`collapseAll` / `dayPanelProps` / `now` / `pendingCount` / `linkedSessionIds` / `sessionCandidates` /
`sessionListSnapshot` / `reparentCandidates` / `workspaceChoices` / `openTask` / `openTaskById` / `linkExistingSession` /
`saveDailyCapacity` / `saveEditDraft` / `openQuickEntry` / `openDirPicker` / `applyWorkspaceDir`。

- 入口渲染顺序 = 搬迁前 DOM 顺序：`WorkbenchHeader` → `WorkbenchOverlays` → `WorkbenchBody` → `WorkbenchDialogs` → `ToastHost`（入口第 715–719 行）。
- 四段是**逐字搬出**（内层缩进一字未改）；四段组件**不持有 state、不发请求、不 import 域 hook**。
- 生成器 `scripts/lib/d17-cut-p7b.py`（一次性）：guard 钉死 17 个边界行 → 读 JSX 之外的绑定 → 生成每段 `const { … } = props.xxx`。

### 5.4 P7-3：死代码清理

- 入口死 import **12 个全部清零**（P4 起登记的 10 个 + P6-4 的 `localDirRequestUrl` / `LocalDirListing`）。
- `npx tsc --noEmit --noUnusedLocals` 第一次跑出 **184 处**未使用（P7-2 搬走 JSX 后，入口为那段 JSX 解构出来的 130+ 个字段全成了死名字）。
- 一次性脚本 `scripts/lib/d17-clean-unused.py`（每轮改完立刻跑全项目 `tsc --noEmit`，只要有任何输出就整体还原并 exit 1）
  + 手工删 3 处单行死声明（`openTree` / `openTasks` / 模块级 `let activeHost`）+ `scripts/lib/d17-tidy-p7b.py`（9 处排版）。
- 收尾：入口 **0 项未使用**、全项目 `tsc --noEmit` **0**。
- **刻意保留的既有欠账**：`hooks/useDayWorkspace.ts#clearTodayPlan`（搬迁前即 0 处引用，与 `clearPlan(date)` 语义重叠；P7 评估后不改行为、不删）。

### 5.5 ADR-0008 硬门（本批实测）

| 判据 | 实测 |
|---|---|
| 体内直接 `useState(` | **0** |
| 体内 `api(` / `fetch(` | **0** / **0** |
| 体内 `setInterval(` / `setTimeout(` | **0** / **0** |
| 体内 `useEffect(` | **3**（刻意留装配层：L283 启动 `refresh` 装配、L314 `dismissOnTaskChange`、L316 `PENDING_ATTR` DOM 投影；error→toast 桥接已在 P5-1 随反馈域进 `hooks/useWorkbenchFeedback.ts`，不在体内） |
| 单个顶层块 | **41 个**，超过 80 行的 **0 个**（最大 66 行 `saveEditDraft`；P7-2 之前唯一违例是 676 行的 `return (` 块） |
| 行数护栏 | ADR 原值 **≤900**（实测 631 达标）；按 ADR「P6 收尾后按实测校准一次」**校准为 ≤650**（写进 `scripts/lib/d17-p7b-exit-check.py`） |
| 努力目标 ≤600 | **未达成**：实测 **631，差 31 行**（设计 §2.1 的 ≤600 是努力目标、不是门。构成：`dayPanelProps` 41 行、`saveEditDraft` 66 行、`linkExistingSession` 31 行、装配层动作约 120 行、17 项 hook 调用与解构约 90 行、装配束 21 行、3 条刻意留装配层的 `useEffect` 约 40 行、模块级纯助手约 150 行） |

### 5.6 判据、反向变异与探针（P7 实测，明细见 migration-matrix.md）

- 新出口自检：`scripts/lib/d17-p7a-exit-check.py` 8 节 **72 项**、`scripts/lib/d17-p7b-exit-check.py` 8 节 **220 项**，均退出 0。
- 新反向变异：`scripts/lib/d17-mutate-p7a.py` **6/6 全红**、`scripts/lib/d17-mutate-p7b.py` **13/13 全红**。
- 15 个出口自检全部退出 0（P5a 138 / P5b 152 / P5c 152 / P6b 155 / P6c 198 / P6d 96 / P7a 72 / P7b 220；P1–P4 只打印「结果：全部通过」）；
  15 个变异脚本全部真跑 N/N、还原后逐字节一致。
- 六个探针 **0 存活**：capacity 20/20、listview 17/17、knowledge-draft-overwrite 19/19、knowledge-recall 46/46、quick-workspace 16/16、model-picker 10/10
  （model-picker 的 B7/B8/B10 是探针失效，已修；`scripts/release-preflight.mjs:60` 的 `KNOWN_PROBE_DEBT` 名单**已清空**）。
- `node scripts/release-preflight.mjs --phase pre` 退出 0；`npx tsc --noEmit` 0；`pnpm build` 0（`lib/client.js` **549.00 kB** / gzip **162.69 kB**）；`pnpm test` **993 / 992 通过 / 1 失败**（唯一失败＝既有 Windows `rmSync` EPERM）。

### 5.7 未做（如实登记，不得当成已完成）

- **没有开浏览器**跑那 10 套浏览器判据；**没有 `git commit`**（P1–P7 全在工作树）；**没有装盘**；3080 / 19387 端口未动；正式库未迁移；版本号仍 **1.16.2**。
- 环境事实：入口 **1972 行**、`WorkbenchApp` **631 行（第 92–722 行）**、`git show HEAD:src/client/index.tsx` 仍是 5725 行（D17 之前的版本）、`git status` 约 100+ 条改动。
