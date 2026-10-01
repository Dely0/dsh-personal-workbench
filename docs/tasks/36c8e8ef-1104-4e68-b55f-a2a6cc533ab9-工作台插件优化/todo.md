# 后续开发施工清单

任务 `36c8e8ef-1104-4e68-b55f-a2a6cc533ab9`。

> **状态更正（2026-10-01）**：本文件最初写作时「实现全部未开工」已不成立。
> 批次 1 / 1.5 的 D01–D13、V01–V05 **已实现并随 v1.16.0 发布**（工作台子任务 T1–T5 已验收，
> T6 进行中/99；逐项证据见各 `T*-handover.md` 与 `T6-evidence-matrix.md`）。
> 下面「进度与计划 / 角色 / 研发验收」三节的勾选框是**批次1 的历史计划态**，不再逐条维护 ——
> 要判批次1 是否完成，看交接文档与 `T6-evidence-matrix.md`，不要拿这里的 `[ ]` 当现状。
> **批次2 从本节末尾的「批次2」一节开始追踪**，规格见 [requirements.md](requirements.md) §8。

详细职责/依赖/命令见[plan.md](plan.md)，目标行为见[requirements.md](requirements.md)，机器判据见[acceptance.md](acceptance.md)。工作台子任务按[subtasks.md](subtasks.md)合并为六项，已由用户确认创建为execute；下面是子任务内部检查项，不再逐项创建工作台任务。

## 进度与计划

- [ ] D01 共享字段与纯校验（S1/S5/S7）
- [ ] D02 前向迁移、任务读写、旧计划兼容（S1）
- [ ] D03 进度工具、用户PATCH、共用验收服务（S2/S3）
- [ ] CP1 进度宿主路径完整回归
- [ ] D04 进度UI、草稿徽标、执行提示词（S4）
- [ ] D05 每日计划投入快照与结束状态仓储（S5/S5-E）
- [ ] D06 计划字段与项级API（S5/S5-E）
- [ ] D07 今日投入结束/继续/完成任务独立交互（S4/S6-E）
- [ ] CP2 长任务最小闭环
- [ ] D08 候选池与提示词纯函数（S7/S8/S9）
- [ ] D09 容量账本、未排入、一键排入与全部接线（S6/S7/S8/S9）

## 角色

- [ ] D10 公司内部角色库形态纯解析（S10）
- [ ] D11 三级来源、设置与资源读取边界（S10）
- [ ] D12 会话绑定、load/read工具与prompt前绑定（S11）
- [ ] D13-A 六篇内置资产与包files（S12）
- [ ] D13-B 各入口选择器与复用分流（S13）
- [ ] CP3 局部产品功能全测试/构建

## 研发验收

- [ ] V01 过时脚本分档和显式套件清单（P1-1）
- [ ] V02 可移植独立CDP浏览器（S15）
- [ ] V03 自锁、DB/profile/装盘目标隔离（S16前置）
- [ ] 由用户确认首次测试实例独立DB配置；未具备则不装盘/重启
- [ ] V04 单命令链、阶段故障与证据脱敏（S16）
- [ ] V04-B 包manifest/host health/client根构建标识一致
- [ ] V05-A 现役四套参数化回归（S17）
- [ ] V05-B 新功能浏览器与安全负向套件（S17-N）
- [ ] V05-C 既有项目skill与README使用说明（S18）
- [ ] CP4 AX矩阵全量通过、反向变异、独立实例证据
- [ ] 用户正式实例实测确认；完成验收申请（需用户启用execute）

## 批次2（2026-10-01 起，用户拍板范围）

口径与边界见 [requirements.md](requirements.md) §8、[ADR0001](../../adr/0001-today-is-the-day-panel.md) 的「口径冻结」。

- [x] A0 #1 版本声明常量：`NEWEST_HOST` → `0.2.0-rc.2`（AX-H01）
- [x] A1 `README.md:23`「任务名文件夹」→ 任务资料夹；CONTEXT.md 的 flagged ambiguity 同步撤下
- [x] A2 P3-3 脆断言改「≤1 处，且若存在必须在 `hostSelectedFromMirror` 内」（含 5 形态反向验证）
- [x] B1 规格补齐：requirements §8 / acceptance §7 / plan §4.5 / ADR0001 口径冻结
- [x] ENV-0 测试实例宿主对齐 `0.1.7-rc.2 → 0.2.0-rc.2`（AX-H03；三层验收全过，旧核心停放在 `dsh.old-rc2align-*`）
- [x] D14 日期来源判定与行标签的唯一实现（AX-T01/T02；`classifyTaskDay` + `dayPanelTreeSources`，2 处反向变异必红）
- [x] D15 `DayPanel` 收敛：今日 = 日历 today 实例；**`index.tsx` 5743 → 5697 行**（-46）；数据层抽成 `dayPanelModel.ts`
- [x] D16 受影响判据同步（`capacityWiring` 已按新结构改判）+ 新增 `suites/day-panel.mjs`（6/6）；`suites/daily-effort` 回归 13/13
- [ ] D17 WorkbenchApp 拆分（**先重写** `docs/design/2026-09-09-client-split-backlog.md`）
- [x] W01 工作区候选判定纯函数 + `components/WorkspacePicker.tsx`（AX-W01；`test/workspacePicker.test.mjs` 8 条）
- [x] W02 快速录入 / 新建 / 编辑三入口接线（AX-W02；**B 层已跑通** `suites/workspace-picker.mjs` 8/8）
- [x] W03 `LocalDocModal` 增加 `mode: 'dir'`，复用 `localDirRoute`（AX-W03；含"从对话框里打开会被盖住"的真实缺陷修复）
- [ ] H01 构建期类型源对齐（`devDependencies` → 声明覆盖的核心线，AX-H02）
- [ ] #3 模型选择失效：只留复现记录 + 上报决策，**不改** `profiles/node_modules`

## 批次3（未开工）

- [ ] 任务拖拽排序、数据导入导出（本轮不执行）

「批次3」与本节未勾选条目的 `[ ]` 只标示未实施，**不等于**后续开发要顺手完成它们。
