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
- [x] W01 工作区候选判定纯函数 + `components/WorkspacePicker.tsx`（AX-W01；`test/workspacePicker.test.mjs` 8 条）
- [x] W02 快速录入 / 新建 / 编辑三入口接线（AX-W02；**B 层已跑通** `suites/workspace-picker.mjs` 8/8）
- [x] W03 `LocalDocModal` 增加 `mode: 'dir'`，复用 `localDirRoute`（AX-W03；含"从对话框里打开会被盖住"的真实缺陷修复）
- [x] H01 构建期类型源对齐（`devDependencies` 整族 → `0.2.0-rc.2` / cordis `^4.0.4` / timer `1.1.6`；peer 不动，AX-H02 四条判据）
- [x] 发布收口：**v1.16.1 已发布**（`package.json` / tag / npm `latest` / GitHub Release 四者一致，包哈希 `46d61b7b…`）
- [x] 发布门禁一键化：`scripts/release-preflight.mjs`（typecheck→单测→全探针→PII 两面→版本文档；`--phase post` 做 tarball/sha1 对账）
- [x] `dsh-release` skill **落盘为项目级** `.dsh/skills/dsh-release/SKILL.md`（V1.3.0）
- [x] **#3 模型选择失效**：**已复测未复现**（2026-10-02，四条判据全绿，脚本 `scripts/repro/repro-model-picker-lock.mjs`）—— 留档 [`docs/issues/2026-10-02-model-picker-retest-record.md`](../../issues/2026-10-02-model-picker-retest-record.md)，**不改** `profiles/node_modules`
- [x] **dev-verify 验收链重跑（批次2 之后）→ 全绿**：`20261002-022125-e7ec68`，
      **10 套件 / 119 条断言（118 通过 / 0 失败 / 1 条已登记跳过）**，构建标识三方一致（`wb-35f69ad83939f2a7`），退出码 0。
      过程中修掉 4 个测试基建缺陷（点击事件可能"根本没到达页面"→ 验证 + DOM 兜底；等入口渲染再点；
      不许吞超时；套件收尾还原侧栏）+ 必需套件跳过改显式名单（persona 的模型链路跳过不再让链永远红）
- [ ] **变异探针欠账**（本轮自留，不在原范围）：capacity 5 条真盲点（M11–M14、M19）+ 19 条探针重锚 ——
      清单与复现在 [`docs/issues/2026-10-01-mutation-probe-maintenance.md`](../../issues/2026-10-01-mutation-probe-maintenance.md)；
      `KNOWN_PROBE_DEBT` 未清空前 `release-preflight` 的探针门禁会一直红（这是刻意的）
- [ ] **D17 WorkbenchApp 拆分**：**评估 12–20 小时，建议新会话做**；**先重写** `docs/design/2026-09-09-client-split-backlog.md`（度量见本节末尾）
  - ⏳ **进度（2026-10-04）**：**P1–P5 全部完成**（P1 知识域 / P2 点子域 / P3-1…P3-4 任务域四批 / P4 日期域 / P5-1 反馈+设置域 / P5-2 提醒域 / P5-3 草稿域+轮询装配）；
    入口 5725 → **3724** 行、`WorkbenchApp` 4197 → **2267** 行；三个结构硬门（`setInterval` / `setTimeout` / `fetch`）已为 0；
    十个出口自检脚本（32/49/47/56/67/103/161/137/152/**151** 项）与十个反向变异脚本（2/2…**12/12**）全绿；
    六探针复跑（20/20、17/17、19/19、46/46、13/15、7/10，后两个是 P6 既有欠账）；`pnpm test` 992/991/1（0 回归）。
    **下一步 P6**（快速录入 + AI 会话 + 导航 + 目录选择四域，余 27 项直接 state），入口见
    `docs/tasks/8e5ea61d-0021-4317-8398-419b8501e6a9-D17客户端拆分/handover.md` §6。

### D17 的度量（2026-10-01 实测，供新会话开工；**最新值见下方 2026-10-04 行**）

| 指标 | 数值 |
|---|---|
| `src/client/index.tsx` | **5697 行**（D15 后已降 46 行）—— **2026-10-04 / P5-3 后：3724 行；P6-4 后：2814 行**；**P7 后：1972 行**（P7-1 -64 / P7-2 -648 / P7-3 -130） |
| `WorkbenchApp` 本体 | **约 4170 行**（276 → 4445），目标 ≤600 → **2026-10-04 起改为「结构硬门（0 直接 state / 0 业务请求 / 0 定时器、顶层块 ≤80 行）+ 行数 ≤900 护栏」，≤600 降为努力目标，见 [ADR-0008](../../adr/0008-workbenchapp-exit-criteria.md)** —— **P5-3 后：2267 行（源码 205–2471）；P6-4 后：1389 行（源码 173–1561），距 ≤900 护栏还差 489** —— **P7 后：631 行（源码第 92 至 722 行），P7 合计 -758；护栏按 ADR 校准为 ≤650（实测达标），≤600 努力目标未达成（差 31 行）** |
| `useState` | **117 处** —— **P5-3 后 `WorkbenchApp` 体内直接声明 27 项；P6-4 后：0 项**（P6 四批把最后 27 项 state 全部归域）；**体内 `api(` 27 → 6（余下 6 处归 P7 欠账）**；**P7 后：体内直接声明仍 0 项、体内 `api(` 6 → 0** |
| `useEffect` / `useMemo` / `useCallback` | 24 / 19 / 9 —— **P5-3 后 `WorkbenchApp` 体内 `useEffect(` 4 条；P6-4 后：3 条**；**P7 后：仍 3 条**（刻意留装配层：启动 `refresh` 装配 / `dismissOnTaskChange` / `PENDING_ATTR` DOM 投影） |
| 进度 | **P6 四批（P6-1 导航+忙碌标志 / P6-2 快速录入域 / P6-3 AI 会话域 / P6-4 目录选择域）已于 2026-10-04 全部完成并验证**（入口 3724 → 2814、`WorkbenchApp` 2267 → 1389、体内直接 state 27 → 0；出口自检 153/198/94 项、反向变异 13/13 × 3、`pnpm test` 993/992/1 即 0 回归）；**P7（P7-1 请求归域 / P7-2 四段 JSX 进 `src/client/app/` + 装配束 `assembly.ts` / P7-3 死 import 与死解构清零）已于 2026-10-04 完成并验证**（入口 2814 → 1972、`WorkbenchApp` 1389 → 631；出口自检 P7a 72 / P7b 220 项、反向变异 P7a 6/6 与 P7b 13/13、六个探针 0 存活、`pnpm test` 993/992/1 即 0 回归） |
| 五个视图块 | today 3205（97 行）、calendar 3302（55）、knowledge 3357（44）、ideas 3401（97）、list 3498 —— **P7 后：视图区整体搬入 `src/client/app/WorkbenchBody.tsx`（原入口 1003 至 1182 行，逐字搬出）** |
| 最大单块 | **右侧任务详情区**（详情/编辑表单/子任务/会话/记忆/复盘/关联知识） —— **P7 后：入口最大顶层块 66 行（`saveEditDraft`），>80 行的 0 个（共 41 个顶层块）** |

**风险**：不在搬 JSX，而在 117 个 state 的依赖关系（`selected` / `refresh` / 各 `*RefreshKey` 被大量共享）。
历史先例：本项目有过一次**未完成的拆分**，文件从 1958 行涨到 2491 行后被取消（规范 §12 有记录）。
**开工前必须先重写 `docs/design/2026-09-09-client-split-backlog.md`**（现状 5697 行、Windows 原生构建、
`DayPanel` 已是新边界；照旧行号地图拆等于拆两遍）。

## 批次3（未开工）

- [ ] 任务拖拽排序、数据导入导出（本轮不执行）

「批次3」与本节未勾选条目的 `[ ]` 只标示未实施，**不等于**后续开发要顺手完成它们。
